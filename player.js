"use strict";

const byId = (id) => document.getElementById(id);
const audio = byId("audio");
const playlist = byId("playlist");
const seek = byId("seek");
const menu = byId("track-menu");
const stateKey = "continuum-web-playlist-v1";
let tracks = [];
let removedTracks = [];
let savedPlaylists = [];
let playlistName = "Playlist";
let shuffleOnLoop = false;
let libraryView = "active";
let libraryBusy = false;
let searchText = "";
let drag = null;
const newId = () => crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36).slice(2);
const library = () => [...tracks, ...removedTracks];
let database, sourceUrl, currentId, menuId, resumeId;
let resumeTime = 0;
let orderBeforeShuffle = null;
let repeatPlaylist = false;
let pendingSeek = null;
let following = false;
let lastSaved = 0;
let seekPointer = null;
let trackTags = {};
let artworkUrl;
let metadataRequest = 0;

function status(message) { byId("status").textContent = message; }
function time(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const whole = Math.floor(seconds);
  return Math.floor(whole / 60) + ":" + String(whole % 60).padStart(2, "0");
}

function openLibrary() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("ContinuumWeb", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("tracks", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Library is open in another tab"));
  });
}

function listFiles() {
  return new Promise((resolve, reject) => {
    const request = database.transaction("tracks").objectStore("tracks").getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function changeFiles(change) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("tracks", "readwrite");
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
    change(transaction.objectStore("tracks"));
  });
}

function save() {
  try {
    localStorage.setItem(stateKey, JSON.stringify({
      order: tracks.map((track) => track.id), resumeId, resumeTime, orderBeforeShuffle, repeatPlaylist, shuffleOnLoop, savedPlaylists, playlistName
    }));
  } catch {
    status("Continuum could not save the playlist position.");
  }
}

function renderTime() {
  if (seekPointer !== null) return;
  const ready = Number.isFinite(audio.duration) && audio.duration > 0;
  seek.disabled = !ready;
  seek.max = ready ? audio.duration : 1;
  seek.value = ready ? audio.currentTime : 0;
  byId("elapsed").textContent = time(audio.currentTime);
  byId("duration").textContent = time(audio.duration);
}

function renderPlay() {
  const playing = !audio.paused && !audio.ended;
  byId("play").textContent = playing ? "❚❚" : "▶";
  byId("play").setAttribute("aria-label", playing ? "Pause" : "Play");
}

function render() {
  const active = library().find((track) => track.id === currentId);
  byId("title").textContent = active ? trackTags.title || active.title : "No track selected";
  byId("subtitle").textContent = active ? trackTags.artist || active.artist || "From Files" : "Choose music from Files to begin";
  byId("playlist-name").textContent = playlistName;
  byId("count").textContent = tracks.length + (tracks.length === 1 ? " track" : " tracks");
  byId("active-tab").setAttribute("aria-pressed", String(libraryView === "active"));
  byId("removed-tab").setAttribute("aria-pressed", String(libraryView === "removed"));
  byId("removed-tab").textContent = "Removed (" + removedTracks.length + ")";
  renderPlaylistOptions();
  for (const id of ["prev", "next"]) byId(id).disabled = !tracks.length;
  byId("play").disabled = !active && !tracks.length;
  byId("bookmark").disabled = !tracks.some(t => t.id === currentId);
  byId("resume").hidden = !resumeId;
  const fragment = document.createDocumentFragment();
  const source = libraryView === "active" ? tracks : removedTracks;
  const query = searchText.trim().toLocaleLowerCase();
  source.forEach((track, index) => {
    if (query && ![track.title, track.artist, track.album, track.file.name].filter(Boolean).join(" ").toLocaleLowerCase().includes(query)) return;
    const row = document.createElement("div");
    row.className = "cp-row";
    row.dataset.trackId = track.id;
    if (libraryView === "active" && track.id === resumeId) {
      const marker = document.createElement("div");
      marker.className = "cp-marker"; marker.textContent = "RESUME HERE"; row.append(marker);
    }
    const handle = document.createElement("button");
    handle.type = "button"; handle.className = "cp-drag"; handle.textContent = "⠿";
    handle.setAttribute("aria-label", "Drag to reorder " + track.title);
    handle.disabled = libraryView !== "active" || Boolean(query) || libraryBusy;
    handle.onpointerdown = event => startDrag(event, track.id, handle);
    const button = document.createElement("button");
    button.type = "button"; button.className = "cp-song";
    button.setAttribute("aria-pressed", String(track.id === currentId));
    const number = document.createElement("span"); number.className = "cp-index"; number.textContent = String(index + 1).padStart(2, "0");
    const details = document.createElement("span"); details.className = "cp-track";
    const title = document.createElement("span"); title.textContent = track.title; details.append(title);
    const subtitle = document.createElement("small"); subtitle.textContent = [track.artist, track.album].filter(Boolean).join(" · ") || track.file.name || "Audio file"; details.append(subtitle);
    button.append(number, details);
    button.onclick = () => { if (!libraryBusy && libraryView === "active") select(track.id, {play:true}); };
    button.disabled = libraryView === "removed";
    const options = document.createElement("button"); options.type = "button"; options.className = "cp-menu";
    options.textContent = libraryView === "active" ? "⋯" : "＋";
    options.setAttribute("aria-label", (libraryView === "active" ? "Options for " : "Restore ") + track.title);
    options.onclick = () => {
      if (libraryBusy) return;
      if (libraryView === "removed") { restoreTrack(track.id); return; }
      menuId = track.id; byId("menu-title").textContent = track.title;
      byId("move-up").disabled = index === 0; byId("move-down").disabled = index === tracks.length - 1; menu.showModal();
    };
    row.append(handle, button, options); fragment.append(row);
  });
  if (!fragment.childNodes.length) {
    const empty = document.createElement("p"); empty.className = "cp-small";
    empty.textContent = query ? "No matching songs." : libraryView === "removed" ? "Removed songs will appear here. Tap ＋ to restore one." : "Import music to start your playlist.";
    fragment.append(empty);
  }
  playlist.replaceChildren(fragment); renderTime(); renderPlay();
}

function play() {
  audio.play().catch((error) => {
    if (error.name === "AbortError") return;
    status(error.name === "NotAllowedError" ? "Tap Play to continue." : "This file could not play. Try an MP3, AAC/M4A, or WAV file.");
  });
}

function showView(lyrics) {
  byId("cover").setAttribute("aria-hidden", String(lyrics));
  byId("lyrics-panel").hidden = !lyrics;
  byId("lyrics-icon").toggleAttribute("hidden", lyrics);
  byId("art-icon").toggleAttribute("hidden", !lyrics);
  const action = lyrics ? "Show album artwork" : "Show lyrics";
  byId("media-toggle").setAttribute("aria-label", action);
  byId("media-toggle").title = action;
}

function showTags(tags, message) {
  trackTags = tags;
  if (artworkUrl) URL.revokeObjectURL(artworkUrl);
  artworkUrl = tags.art ? URL.createObjectURL(tags.art) : undefined;
  const cover = byId("cover-image");
  cover.src = artworkUrl || "./icon-192.png";
  cover.alt = artworkUrl ? "Album cover" : "";
  byId("cover").classList.toggle("has-art", Boolean(artworkUrl));
  byId("cover-note").textContent = message || (currentId ? "No embedded artwork" : "No track selected");
  const lyrics = byId("lyrics");
  lyrics.textContent = tags.lyrics || message ||
    (currentId ? "No embedded lyrics in this track." : "Choose a track to see its lyrics.");
  lyrics.scrollTop = 0;
}

async function loadTags(file) {
  const request = ++metadataRequest;
  showTags({}, file ? "Reading track details…" : "");
  if (!file) return;
  let tags = {};
  try { tags = await ContinuumTags.parse(file); } catch {}
  if (request !== metadataRequest) return;
  showTags(tags);
  const track = library().find(t => t.id === currentId);
  if (track) { applyDetails(track, tags); persistDetails(track).catch(() => {}); if (!drag) render(); }
  byId("title").textContent = tags.title || tracks.find((track) => track.id === currentId)?.title || "";
  byId("subtitle").textContent = tags.artist || "From Files";
}

byId("media-toggle").onclick = () => showView(byId("lyrics-panel").hidden);
byId("cover-image").onerror = () => {
  if (!artworkUrl) return;
  URL.revokeObjectURL(artworkUrl);
  artworkUrl = undefined;
  byId("cover").classList.remove("has-art");
  byId("cover-image").src = "./icon-192.png";
  byId("cover-image").alt = "";
  byId("cover-note").textContent = "Could not open embedded artwork";
};

function select(id, options = {}) {
  savePosition(true);
  const track = library().find((item) => item.id === id);
  if (!track) return;
  const oldUrl = sourceUrl;
  following = Boolean(options.follow);
  currentId = id;
  pendingSeek = options.at || null;
  sourceUrl = URL.createObjectURL(track.file);
  audio.src = sourceUrl;
  if (oldUrl) URL.revokeObjectURL(oldUrl);
  if (following) {
    resumeId = id;
    resumeTime = options.at || 0;
    save();
  }
  status("");
  loadTags(track.file);
  render();
  if (options.play) play();
}

function setMarker(id) {
  resumeId = id;
  resumeTime = 0;
  following = id === currentId;
  if (following) resumeTime = pendingSeek ?? audio.currentTime;
  save();
  render();
}

function resume() {
  if (resumeId) select(resumeId, { play: true, follow: true, at: resumeTime });
}

function advance() {
  if (!following && resumeId) { resume(); return; }
  const index = tracks.findIndex((track) => track.id === currentId);
  const next = tracks[index + 1];
  if (next) select(next.id, { play: true, follow: true });
  else if (tracks.length) {
    if (repeatPlaylist && shuffleOnLoop) shufflePlaylist();
    select(tracks[0].id, { follow: true, play: repeatPlaylist });
    if (!repeatPlaylist) status("End of playlist");
  }
}

function savePosition(force = false) {
  if (!following || currentId !== resumeId || pendingSeek !== null || !Number.isFinite(audio.duration)) return;
  const now = Date.now();
  if (!force && now - lastSaved < 1000) return;
  lastSaved = now;
  resumeTime = audio.currentTime;
  save();
}

byId("import").onclick = () => byId("files").click();
async function fingerprint(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

byId("files").onchange = async (event) => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  if (!files.length || libraryBusy) return;
  libraryBusy = true;
  const button = byId("import");
  button.disabled = true;
  status("Saving music to this device…");
  const candidates = files.filter((file) => file.size && (file.type.startsWith("audio/") || /\.(mp3|m4a|aac|wav|flac|aiff?|ogg|opus|caf)$/i.test(file.name))).map((file) => ({
    id: crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36).slice(2),
    title: file.name.replace(/\.[^.]+$/, "") || file.name,
    file
  }));
  try {
    if (!candidates.length) { status("Choose an audio file such as an MP3 or M4A."); return; }
    const added = [];
    const restored = [];
    let duplicates = 0;
    for (const candidate of candidates) {
      candidate.fingerprint = await fingerprint(candidate.file);
      let duplicate = false;
      for (const existing of [...library(), ...added]) {
        if (existing.file.size !== candidate.file.size) continue;
        existing.fingerprint ||= await fingerprint(existing.file);
        if (existing.fingerprint === candidate.fingerprint) {
          duplicate = true;
          if (existing.removed && !restored.includes(existing)) restored.push(existing);
          break;
        }
      }
      if (duplicate) duplicates++;
      else added.push(candidate);
    }
    if (!added.length && !restored.length) { status("Already in your playlist. Duplicate songs were skipped."); return; }
    await changeFiles((store) => { added.forEach(track => store.add(track)); restored.forEach(track => store.put({...track, removed:false})); });
    for (const track of restored) track.removed = false;
    removedTracks = removedTracks.filter(track => !restored.includes(track));
    tracks.push(...added, ...restored);
    if (!resumeId) resumeId = tracks[0].id;
    save();
    if (!currentId) select(resumeId, { follow: true, at: resumeTime });
    render();
    indexDetails(added);
    status((restored.length ? "Restored " + restored.length + " removed track(s). " : "") + "Added " + added.length + (added.length === 1 ? " track." : " tracks.") + (duplicates ? " Skipped " + duplicates + " duplicate(s)." : "") + (candidates.length < files.length ? " Other files were skipped." : ""));
  } catch {
    status("Could not save these files. Check available space and try a smaller batch.");
  } finally { libraryBusy = false; button.disabled = false; render(); }
};

byId("play").onclick = () => {
  if (!currentId) resume();
  else if (audio.paused) play();
  else audio.pause();
};
byId("resume").onclick = resume;
byId("next").onclick = () => skipTrack(1);
function skipTrack(direction) {
  const playing = !audio.paused && !audio.ended;
  const index = tracks.findIndex((track) => track.id === currentId);
  const nextIndex = direction > 0 ? (index + 1) % tracks.length : Math.max(0, index - 1);
  const track = tracks[nextIndex];
  if (track) select(track.id, { play: playing, follow: following });
}
byId("prev").onclick = () => {
  skipTrack(-1);
};
byId("bookmark").onclick = () => { if (currentId) setMarker(currentId); };

function renderPlaylistOptions() {
  byId("shuffle-now").disabled = tracks.length < 2;
  byId("restore-order").disabled = !orderBeforeShuffle || tracks.length < 2;
  const repeat = byId("repeat-playlist");
  repeat.setAttribute("aria-pressed", String(repeatPlaylist));
  repeat.textContent = "Repeat playlist: " + (repeatPlaylist ? "On" : "Off");
  byId("shuffle-loop").setAttribute("aria-pressed", String(shuffleOnLoop));
  byId("shuffle-loop").textContent = "Shuffle on loop: " + (shuffleOnLoop ? "On" : "Off");
  byId("sort-az").disabled = tracks.length < 2;
}

function shufflePlaylist() {
  if (tracks.length < 2) return;
  const previous = tracks.map((track) => track.id);
  orderBeforeShuffle ||= previous;
  for (let i = tracks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
  }
  if (tracks.every((track, index) => track.id === previous[index])) tracks.push(tracks.shift());
  save();
  render();
  status("Playlist shuffled.");
}

function restorePlaylistOrder() {
  if (libraryBusy || !orderBeforeShuffle) return;
  sortByOrder(orderBeforeShuffle);
  orderBeforeShuffle = null;
  save();
  render();
  status("Previous playlist order restored.");
}

function sortByOrder(order) {
  const ranks = new Map(order.map((id, index) => [id, index]));
  tracks.sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity));
}

const playlistMenu = byId("playlist-menu");
byId("playlist-options").onclick = () => { renderPlaylistOptions(); playlistMenu.showModal(); };
byId("shuffle-now").onclick = () => { if (libraryBusy) return; shufflePlaylist(); playlistMenu.close(); };
byId("restore-order").onclick = () => { restorePlaylistOrder(); playlistMenu.close(); };
byId("repeat-playlist").onclick = () => {
  repeatPlaylist = !repeatPlaylist;
  save();
  renderPlaylistOptions();
};
seek.addEventListener("pointerdown", (event) => {
  if (!seek.disabled && event.isPrimary) seekPointer = event.pointerId;
});
window.addEventListener("pointerup", (event) => {
  if (event.pointerId === seekPointer) seekPointer = null;
});
window.addEventListener("pointercancel", (event) => {
  if (event.pointerId !== seekPointer) return;
  seekPointer = null;
  renderTime();
});
window.addEventListener("blur", () => {
  seekPointer = null;
  renderTime();
});
seek.oninput = () => { byId("elapsed").textContent = time(Number(seek.value)); };
seek.onchange = () => {
  if (!Number.isFinite(audio.duration)) return;
  audio.currentTime = Number(seek.value);
  savePosition(true);
};
audio.addEventListener("loadedmetadata", () => {
  if (pendingSeek !== null) audio.currentTime = Math.min(pendingSeek, Math.max(0, audio.duration - 0.1));
  pendingSeek = null;
  renderTime();
});
audio.addEventListener("timeupdate", () => { renderTime(); savePosition(); });
audio.addEventListener("pause", () => { renderPlay(); savePosition(true); });
audio.addEventListener("playing", renderPlay);
audio.addEventListener("ended", advance);
audio.addEventListener("error", () => {
  if (currentId) status("This device could not open the selected audio file.");
});
window.addEventListener("pagehide", () => savePosition(true));
document.addEventListener("visibilitychange", () => { if (document.hidden) savePosition(true); });

function move(delta) {
  if (libraryBusy) return;
  const index = tracks.findIndex((track) => track.id === menuId);
  if (index < 0 || !tracks[index + delta]) return;
  [tracks[index], tracks[index + delta]] = [tracks[index + delta], tracks[index]];
  save();
  menu.close();
  render();
}
byId("move-up").onclick = () => move(-1);
byId("move-down").onclick = () => move(1);
byId("mark-track").onclick = () => { setMarker(menuId); menu.close(); };
byId("remove-track").onclick = async () => {
  if (libraryBusy) return;
  const track = tracks.find(t => t.id === menuId);
  menu.close(); if (!track) return;
  libraryBusy = true;
  try {
    await changeFiles(store => store.put({...track, removed:true}));
    track.removed = true; tracks = tracks.filter(t => t !== track); removedTracks.push(track);
    if (resumeId === track.id) { resumeId = tracks[0]?.id; resumeTime = 0; following = false; }
    save(); render(); status("Moved to Removed. You can restore it without importing again.");
  } catch { status("Could not remove the track. Try again."); }
  finally { libraryBusy = false; }
};

async function initialize() {
  try {
    database = await openLibrary();
    const stored = await listFiles();
    tracks = stored.filter(t => !t.removed);
    removedTracks = stored.filter(t => t.removed);
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(stateKey)) || {}; } catch {}
    sortByOrder(Array.isArray(saved.order) ? saved.order : []);
    orderBeforeShuffle = Array.isArray(saved.orderBeforeShuffle) && saved.orderBeforeShuffle.length ? saved.orderBeforeShuffle : null;
    repeatPlaylist = saved.repeatPlaylist === true;
    shuffleOnLoop = saved.shuffleOnLoop === true;
    savedPlaylists = Array.isArray(saved.savedPlaylists) ? saved.savedPlaylists.filter(validPlaylist) : [];
    playlistName = typeof saved.playlistName === "string" ? saved.playlistName : "Playlist";
    if (tracks.length) {
      resumeId = tracks.some((track) => track.id === saved.resumeId) ? saved.resumeId : tracks[0].id;
      resumeTime = resumeId === saved.resumeId && Number.isFinite(saved.resumeTime) ? Math.max(0, saved.resumeTime) : 0;
      select(resumeId, { follow: true, at: resumeTime });
    } else status("No music yet. Tap Import to add your first tracks.");
    byId("import").disabled = false;
    render();
    indexDetails(library());
  } catch { status("Continuum could not open device storage. Try Safari outside Private Browsing."); }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
}


// Library metadata is scanned one file at a time to keep artwork memory bounded.
function persistDetails(track) {
  return changeFiles(store => {
    const request = store.get(track.id);
    request.onsuccess = () => {
      if (request.result) store.put({...request.result,title:track.title,artist:track.artist,album:track.album,detailsRead:true});
    };
  });
}
function applyDetails(track, tags) {
  if (tags.title) track.title = tags.title;
  track.artist = tags.artist || "";
  track.album = tags.album || "";
  track.detailsRead = true;
}
let detailQueue = Promise.resolve();
function indexDetails(items) {
  detailQueue = detailQueue.then(async () => {
    let scanned = 0;
    for (const track of items) {
      if (track.detailsRead) continue;
      try {
        applyDetails(track, await ContinuumTags.parse(track.file));
        await persistDetails(track);
      } catch { continue; }
      if (!drag && ++scanned % 8 === 0) render();
    }
    if (!drag) render();
  }).catch(() => {});
  return detailQueue;
}
byId("search").oninput = event => { searchText = event.target.value; render(); };
byId("active-tab").onclick = () => { libraryView = "active"; render(); };
byId("removed-tab").onclick = () => { libraryView = "removed"; render(); };
byId("sort-az").onclick = () => {
  if (libraryBusy) return;
  orderBeforeShuffle ||= tracks.map(t => t.id);
  tracks.sort((a,b) => a.title.localeCompare(b.title, undefined, {numeric:true,sensitivity:"base"}));
  save(); render(); playlistMenu.close(); status("Playlist sorted A–Z. Restore previous order will undo the sort.");
};
byId("shuffle-loop").onclick = () => {
  shuffleOnLoop = !shuffleOnLoop;
  if (shuffleOnLoop) repeatPlaylist = true;
  save(); renderPlaylistOptions();
};
async function restoreTrack(id) {
  if (libraryBusy) return;
  const track = removedTracks.find(t => t.id === id); if (!track) return;
  libraryBusy = true;
  try {
    await changeFiles(store => store.put({...track, removed:false}));
    track.removed = false; removedTracks = removedTracks.filter(t => t !== track); tracks.push(track);
    if (!resumeId) { resumeId = track.id; resumeTime = 0; }
    save(); render(); status("Song restored to the end of your playlist.");
  } catch { status("Could not restore this song. Try again."); }
  finally { libraryBusy = false; render(); }
}

// Pointer capture is confined to the handle; the rest of each row scrolls normally.
function startDrag(event, id, handle) {
  if (libraryBusy || searchText.trim() || libraryView !== "active" || event.isPrimary === false || event.button > 0) return;
  event.preventDefault();
  const row = handle.closest(".cp-row");
  drag = {id, target:id, x:event.clientX, y:event.clientY, handle, row, before:false, frame:0};
  handle.setPointerCapture(event.pointerId);
  row.classList.add("cp-dragging");
  handle.onpointermove = e => { if (drag) { drag.x = e.clientX; drag.y = e.clientY; updateDrop(e.clientX, e.clientY); } };
  handle.onpointerup = () => endDrag(true);
  handle.onpointercancel = () => endDrag(false);
  handle.onlostpointercapture = () => endDrag(false);
  function scroll() {
    if (!drag) return;
    const edge = 75, height = window.innerHeight;
    const delta = drag.y < edge ? -Math.ceil((edge-drag.y)/6) : drag.y > height-edge ? Math.ceil((drag.y-height+edge)/6) : 0;
    if (delta) { window.scrollBy(0, delta); updateDrop(drag.x, drag.y); }
    drag.frame = requestAnimationFrame(scroll);
  }
  drag.frame = requestAnimationFrame(scroll);
}
function updateDrop(x,y) {
  if (!drag) return;
  document.querySelectorAll(".cp-drop-target").forEach(row => row.classList.remove("cp-drop-target"));
  const target = document.elementFromPoint(x,y)?.closest(".cp-row");
  if (!target || !target.dataset.trackId) return;
  drag.target = target.dataset.trackId;
  const bounds = target.getBoundingClientRect(); drag.before = y < bounds.top + bounds.height / 2;
  if (drag.target !== drag.id) target.classList.add("cp-drop-target");
}
function reorderTrack(id, targetId, before) {
  const from = tracks.findIndex(t => t.id === id);
  if (from < 0 || targetId === id || !tracks.some(t => t.id === targetId)) return false;
  const [track] = tracks.splice(from,1);
  const to = tracks.findIndex(t => t.id === targetId);
  tracks.splice(to + (before ? 0 : 1),0,track);
  save(); return true;
}
function endDrag(commit) {
  if (!drag) return;
  const finished = drag; drag = null; cancelAnimationFrame(finished.frame);
  if (commit && reorderTrack(finished.id, finished.target, finished.before)) status("Playlist order updated.");
  render();
}
window.addEventListener("blur", () => endDrag(false));

function validPlaylist(item) {
  return item && typeof item.id === "string" && typeof item.name === "string" && Array.isArray(item.order) && item.order.every(id => typeof id === "string");
}
function snapshot(name = playlistName) {
  savePosition(true);
  return {id:newId(), name, order:tracks.map(t => t.id), resumeId, resumeTime};
}
function renderSaved(selected) {
  const list = byId("saved-select"); list.replaceChildren();
  for (const item of savedPlaylists) {
    const option = document.createElement("option"); option.value = item.id; option.textContent = item.name; list.append(option);
  }
  if (selected) list.value = selected;
  if (!list.value && savedPlaylists.length) list.value = savedPlaylists[0].id;
  for (const id of ["saved-load","saved-update","saved-rename","saved-delete"]) byId(id).disabled = !savedPlaylists.length || libraryBusy;
}
byId("saved-open").onclick = () => { playlistMenu.close(); renderSaved(); byId("saved-menu").showModal(); };
let renameId;
function openName(id) {
  renameId = id;
  byId("name-title").textContent = id ? "Rename playlist" : "Save current playlist";
  byId("playlist-input").value = id ? savedPlaylists.find(p => p.id === id)?.name || "" : playlistName === "Playlist" ? "" : playlistName;
  byId("name-error").textContent = "";
  byId("name-menu").showModal(); byId("playlist-input").focus();
}
byId("saved-new").onclick = () => openName();
byId("saved-rename").onclick = () => openName(byId("saved-select").value);
byId("name-cancel").onclick = () => byId("name-menu").close();
byId("name-form").onsubmit = event => {
  event.preventDefault();
  const name = byId("playlist-input").value.trim().slice(0,80);
  if (!name || savedPlaylists.some(p => p.id !== renameId && p.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    byId("name-error").textContent = name ? "That name is already used. Choose another name." : "Enter a playlist name."; return;
  }
  let id = renameId;
  if (id) { const item = savedPlaylists.find(p => p.id === id); if (playlistName === item.name) playlistName = name; item.name = name; }
  else { const item = snapshot(name); savedPlaylists.push(item); id = item.id; playlistName = name; }
  save(); renderSaved(id); render(); byId("name-menu").close(); status("Playlist saved.");
};
byId("saved-update").onclick = () => {
  if (libraryBusy) return;
  const item = savedPlaylists.find(p => p.id === byId("saved-select").value); if (!item) return;
  if (!window.confirm('Update "' + item.name + '" with the current order and resume position?')) return;
  Object.assign(item, {...snapshot(item.name), id:item.id});
  save(); renderSaved(item.id); status("Saved playlist updated.");
};
byId("saved-delete").onclick = () => {
  const id = byId("saved-select").value;
  const item = savedPlaylists.find(p => p.id === id); if (!item) return;
  if (!window.confirm('Delete saved playlist "' + item.name + '"? Your songs will be kept.')) return;
  savedPlaylists = savedPlaylists.filter(p => p.id !== id); save(); renderSaved(); status("Saved playlist deleted. Songs were kept.");
};
async function loadArrangement(item) {
  const all = library(), lookup = new Map(all.map(t => [t.id,t]));
  const order = [...new Set(item.order)].filter(id => lookup.has(id));
  const wanted = new Set(order);
  await changeFiles(store => all.forEach(t => store.put({...t,removed:!wanted.has(t.id)})));
  all.forEach(t => { t.removed = !wanted.has(t.id); });
  tracks = order.map(id => lookup.get(id)); removedTracks = all.filter(t => t.removed);
  following = false;
  resumeId = wanted.has(item.resumeId) ? item.resumeId : tracks[0]?.id;
  resumeTime = resumeId === item.resumeId && Number.isFinite(item.resumeTime) ? Math.max(0,item.resumeTime) : 0;
  playlistName = item.name || "Playlist"; orderBeforeShuffle = null; libraryView = "active";
  if (!currentId && resumeId) select(resumeId, {follow:true, at:resumeTime});
  save(); render();
  return item.order.length-order.length;
}
byId("saved-load").onclick = async () => {
  if (libraryBusy) return;
  const item = savedPlaylists.find(p => p.id === byId("saved-select").value); if (!item) return;
  libraryBusy = true;
  try {
    const missing = await loadArrangement(item); byId("saved-menu").close();
    status("Loaded " + item.name + "." + (missing ? " " + missing + " unavailable song(s) skipped." : ""));
  } catch { status("Could not load this playlist. Try again."); }
  finally { libraryBusy = false; render(); }
};

const backupMagic = "CONTINUUM-WEB-1\n";
byId("backup-open").onclick = () => { playlistMenu.close(); byId("backup-menu").showModal(); };
let downloadUrl;
function download(blob, name) {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = downloadUrl; link.download = name;
  document.body.append(link); link.click(); link.remove();
}
async function exportBackup(full) {
  if (libraryBusy) return;
  libraryBusy = true; status("Preparing your backup…");
  for (const id of ["backup-small","backup-full","backup-restore"]) byId(id).disabled = true;
  try {
    await detailQueue;
    const all = library();
    for (const t of all) t.fingerprint ||= await fingerprint(t.file);
    const data = {format:"ContinuumWeb",version:1,full,created:new Date().toISOString(),current:snapshot(),savedPlaylists,
      repeatPlaylist,shuffleOnLoop,tracks:all.map(t => ({id:t.id,title:t.title,artist:t.artist,album:t.album,removed:Boolean(t.removed),
        fingerprint:t.fingerprint,name:t.file.name || t.title + ".audio",type:t.file.type,size:t.file.size}))};
    const header = new TextEncoder().encode(JSON.stringify(data));
    if (header.length > 16*1024*1024) throw new Error("Backup index too large");
    const blob = full ? new Blob([backupMagic, String(header.length)+"\n",header,...all.map(t => t.file)],{type:"application/octet-stream"})
      : new Blob([header],{type:"application/json"});
    download(blob, "Continuum-" + (full ? "music" : "playlists") + "-" + new Date().toISOString().slice(0,10) + (full ? ".continuum" : ".json"));
    status("Backup prepared. Save the download in Files.");
  } catch { status("Could not create the backup. Try a playlist-only backup or free some space."); }
  finally { libraryBusy = false; for (const id of ["backup-small","backup-full","backup-restore"]) byId(id).disabled = false; render(); }
}
byId("backup-small").onclick = () => exportBackup(false);
byId("backup-full").onclick = () => exportBackup(true);
byId("backup-restore").onclick = () => { if (!libraryBusy) byId("backup-file").click(); };
async function readBackup(file) {
  const prefix = await file.slice(0,80).text();
  let data, offset = 0;
  if (prefix.startsWith(backupMagic)) {
    const end = prefix.indexOf("\n",backupMagic.length);
    if (end < 0) throw new Error("Invalid header");
    const digits = prefix.slice(backupMagic.length,end);
    if (!/^\d+$/.test(digits)) throw new Error("Invalid length");
    const length = Number(digits); offset = end+1;
    if (length > 16*1024*1024 || offset+length > file.size) throw new Error("Invalid length");
    data = JSON.parse(await file.slice(offset,offset+length).text()); offset += length;
    if (data.full !== true) throw new Error("Invalid full backup");
  } else {
    if (file.size > 16*1024*1024) throw new Error("Backup too large");
    data = JSON.parse(await file.text());
    if (data.full !== false) throw new Error("Missing audio data");
  }
  if (!data || data.format !== "ContinuumWeb" || data.version !== 1 || !Array.isArray(data.tracks) || data.tracks.length > 50000 ||
    !validPlaylist(data.current) || !Array.isArray(data.savedPlaylists) || data.savedPlaylists.length > 10000 || !data.savedPlaylists.every(validPlaylist)) throw new Error("Invalid backup");
  const ids = new Set();
  for (const t of data.tracks) {
    if (!t || typeof t.id !== "string" || ids.has(t.id) || typeof t.title !== "string" ||
      typeof t.name !== "string" || typeof t.type !== "string" || !/^[a-f0-9]{64}$/.test(t.fingerprint) || !Number.isSafeInteger(t.size) || t.size <= 0) throw new Error("Invalid song");
    ids.add(t.id);
    if (data.full) { if (t.size > file.size-offset) throw new Error("Truncated music"); t.file = file.slice(offset,offset+t.size,t.type); offset += t.size; }
  }
  if (data.full && offset !== file.size) throw new Error("Unexpected data");
  return data;
}
function uniquePlaylistName(name, used) {
  const base = String(name || "Restored playlist").slice(0,70); let result = base, n=2;
  while (used.has(result.toLocaleLowerCase())) result = base + " (" + n++ + ")";
  used.add(result.toLocaleLowerCase()); return result;
}
async function restoreBackup(file) {
  const data = await readBackup(file);
  const all = library(), byHash = new Map(), mapping = new Map(), added = [];
  for (const t of all) { t.fingerprint ||= await fingerprint(t.file); byHash.set(t.fingerprint,t); }
  for (const entry of data.tracks) {
    let match = byHash.get(entry.fingerprint);
    if (!match && data.full) {
      if (await fingerprint(entry.file) !== entry.fingerprint) throw new Error("Damaged music data");
      match = {id:newId(),title:entry.title,artist:typeof entry.artist === "string" ? entry.artist : "",album:typeof entry.album === "string" ? entry.album : "",
        fingerprint:entry.fingerprint,removed:true,file:new File([entry.file],entry.name,{type:entry.type})};
      added.push(match); byHash.set(match.fingerprint,match);
    }
    if (match) mapping.set(entry.id,match.id);
  }
  const remap = item => ({id:newId(),name:item.name,order:[...new Set(item.order.map(id => mapping.get(id)).filter(Boolean))],resumeId:mapping.get(item.resumeId),resumeTime:Number.isFinite(item.resumeTime) ? Math.max(0,item.resumeTime) : 0});
  const current = remap(data.current);
  const used = new Set(savedPlaylists.map(p => p.name.toLocaleLowerCase()));
  const restored = data.savedPlaylists.map(item => ({...remap(item),name:uniquePlaylistName(item.name,used)}));
  // One transaction adds songs and applies membership. Existing audio is never deleted.
  const combined = [...all,...added], wanted = new Set(current.order);
  await changeFiles(store => combined.forEach(t => store.put({...t,removed:!wanted.has(t.id)})));
  combined.forEach(t => { t.removed = !wanted.has(t.id); });
  const lookup = new Map(combined.map(t => [t.id,t]));
  tracks = current.order.map(id => lookup.get(id)); removedTracks = combined.filter(t => t.removed);
  savedPlaylists.push(...restored); following = false; resumeId = wanted.has(current.resumeId) ? current.resumeId : tracks[0]?.id;
  resumeTime = resumeId === current.resumeId ? current.resumeTime : 0; playlistName = current.name; orderBeforeShuffle = null;
  repeatPlaylist = data.repeatPlaylist === true; shuffleOnLoop = data.shuffleOnLoop === true;
  libraryView = "active"; searchText = ""; byId("search").value = "";
  if (!currentId && resumeId) select(resumeId,{follow:true,at:resumeTime});
  save(); render(); indexDetails(added);
  return data.tracks.length-mapping.size;
}
byId("backup-file").onchange = async event => {
  const file = event.target.files[0]; event.target.value = "";
  if (!file || libraryBusy) return;
  libraryBusy = true; byId("import").disabled = true;
  status("Checking and restoring your backup…");
  try {
    const missing = await restoreBackup(file);
    byId("backup-menu").close();
    status("Backup restored." + (missing ? " " + missing + " song(s) missing. Import those songs, then restore this playlist backup again." : ""));
  } catch { status("Could not restore this backup. It may be incomplete, invalid, or larger than the available storage. Your existing music was kept."); }
  finally { libraryBusy = false; byId("import").disabled = false; render(); }
};
initialize();
