"use strict";

const byId = (id) => document.getElementById(id);
const audio = byId("audio");
const playlist = byId("playlist");
const seek = byId("seek");
const menu = byId("track-menu");
const stateKey = "continuum-web-playlist-v1";
let tracks = [];
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
      order: tracks.map((track) => track.id), resumeId, resumeTime, orderBeforeShuffle, repeatPlaylist
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
  const active = tracks.find((track) => track.id === currentId);
  byId("title").textContent = active ? trackTags.title || active.title : "No track selected";
  byId("subtitle").textContent = active ? trackTags.artist || "From Files" : "Choose music from Files to begin";
  byId("count").textContent = tracks.length + (tracks.length === 1 ? " track" : " tracks");
  renderPlaylistOptions();
  for (const id of ["play", "prev", "next", "bookmark"]) byId(id).disabled = !tracks.length;
  byId("resume").hidden = !resumeId;
  const fragment = document.createDocumentFragment();
  tracks.forEach((track, index) => {
    const row = document.createElement("div");
    row.className = "cp-row";
    if (track.id === resumeId) {
      const marker = document.createElement("div");
      marker.className = "cp-marker";
      marker.textContent = "RESUME HERE";
      row.append(marker);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-pressed", String(track.id === currentId));
    const number = document.createElement("span");
    number.className = "cp-index";
    number.textContent = String(index + 1).padStart(2, "0");
    const title = document.createElement("span");
    title.className = "cp-track";
    title.textContent = track.title;
    button.append(number, title);
    button.onclick = () => select(track.id, { play: true });
    const options = document.createElement("button");
    options.type = "button";
    options.className = "cp-menu";
    options.textContent = "⋯";
    options.setAttribute("aria-label", "Options for " + track.title);
    options.onclick = () => {
      menuId = track.id;
      byId("menu-title").textContent = track.title;
      byId("move-up").disabled = index === 0;
      byId("move-down").disabled = index === tracks.length - 1;
      menu.showModal();
    };
    row.append(button, options);
    fragment.append(row);
  });
  playlist.replaceChildren(fragment);
  renderTime();
  renderPlay();
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
  const track = tracks.find((item) => item.id === id);
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
  if (!files.length) return;
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
    let duplicates = 0;
    for (const candidate of candidates) {
      candidate.fingerprint = await fingerprint(candidate.file);
      let duplicate = false;
      for (const existing of [...tracks, ...added]) {
        if (existing.file.size !== candidate.file.size) continue;
        existing.fingerprint ||= await fingerprint(existing.file);
        if (existing.fingerprint === candidate.fingerprint) { duplicate = true; break; }
      }
      if (duplicate) duplicates++;
      else added.push(candidate);
    }
    if (!added.length) { status("Already in your playlist. Duplicate songs were skipped."); return; }
    await changeFiles((store) => added.forEach((track) => store.add(track)));
    tracks.push(...added);
    if (!resumeId) resumeId = tracks[0].id;
    save();
    if (!currentId) select(resumeId, { follow: true, at: resumeTime });
    render();
    status("Added " + added.length + (added.length === 1 ? " track." : " tracks.") + (duplicates ? " Skipped " + duplicates + " duplicate(s)." : "") + (candidates.length < files.length ? " Other files were skipped." : ""));
  } catch {
    status("Could not save these files. Check available space and try a smaller batch.");
  } finally { button.disabled = false; }
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
  if (!orderBeforeShuffle) return;
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
byId("shuffle-now").onclick = () => { shufflePlaylist(); playlistMenu.close(); };
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
  const id = menuId;
  menu.close();
  try {
    await changeFiles((store) => store.delete(id));
    tracks = tracks.filter((track) => track.id !== id);
    if (resumeId === id) { resumeId = tracks[0]?.id; resumeTime = 0; }
    if (currentId === id) {
      following = false;
      currentId = undefined;
      loadTags();
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
      sourceUrl = undefined;
      if (resumeId) select(resumeId, { follow: true, at: resumeTime });
    }
    save();
    render();
    status("Removed from Continuum.");
  } catch { status("Could not remove the track. Try again."); }
};

async function initialize() {
  try {
    database = await openLibrary();
    tracks = await listFiles();
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(stateKey)) || {}; } catch {}
    sortByOrder(Array.isArray(saved.order) ? saved.order : []);
    orderBeforeShuffle = Array.isArray(saved.orderBeforeShuffle) && saved.orderBeforeShuffle.length ? saved.orderBeforeShuffle : null;
    repeatPlaylist = saved.repeatPlaylist === true;
    if (tracks.length) {
      resumeId = tracks.some((track) => track.id === saved.resumeId) ? saved.resumeId : tracks[0].id;
      resumeTime = resumeId === saved.resumeId && Number.isFinite(saved.resumeTime) ? Math.max(0, saved.resumeTime) : 0;
      select(resumeId, { follow: true, at: resumeTime });
    } else status("No music yet. Tap Import to add your first tracks.");
    byId("import").disabled = false;
    render();
  } catch { status("Continuum could not open device storage. Try Safari outside Private Browsing."); }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
}
initialize();

