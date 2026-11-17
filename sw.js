"use strict";
importScripts("./storage.js?v=9");
const cacheName = "continuum-web-v9";
const assets = ["./", "./index.html", "./player.css?v=9", "./storage.js?v=9", "./tags.js?v=9", "./player.js?v=9", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(assets)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  // Previous caches are small and retained so an already-open older player keeps its assets.
  event.waitUntil(self.clients.claim());
});
self.addEventListener("message", event => {
  if (event.data?.type === "CONTINUUM_MEDIA") event.ports[0]?.postMessage({version:9});
});
function parseRange(header,size) {
  if (!header) return {start:0,end:size,status:200};
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start, end;
  if (!match[1]) { const count = Number(match[2]); if (!Number.isSafeInteger(count) || count <= 0) return null; start = Math.max(0,size-count); end = size; }
  else { start = Number(match[1]); end = match[2] ? Math.min(size,Number(match[2])+1) : size; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end <= start) return null;
  return {start,end,status:206};
}
async function localAudio(request,url) {
  try {
    const id = decodeURIComponent(url.pathname.slice(new URL("./__audio/",self.location.href).pathname.length));
    const track = await ContinuumStorage.get("tracks",id);
    if (!track) return new Response("Saved song was not found.",{status:404});
    const size = track.audio?.size || track.file?.size || 0;
    const range = parseRange(request.headers.get("Range"),size);
    if (!range) return new Response(null,{status:416,headers:{"Content-Range":"bytes */"+size}});
    const type = track.audio?.type || ContinuumStorage.contentType(track.file?.name,track.file?.type);
    const headers = {"Content-Type":type,"Accept-Ranges":"bytes","Content-Length":String(range.end-range.start),"Cache-Control":"no-store"};
    if (range.status === 206) headers["Content-Range"] = "bytes "+range.start+"-"+(range.end-1)+"/"+size;
    if (request.method === "HEAD") return new Response(null,{status:range.status,headers});
    let position = range.start;
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          if (position >= range.end) { controller.close(); return; }
          const end = Math.min(range.end,position+ContinuumStorage.chunkSize);
          const bytes = track.audio ? await ContinuumStorage.readRange(track.audio,position,end) : await track.file.slice(position,end).arrayBuffer();
          if (bytes.byteLength !== end-position) throw new Error("Incomplete audio");
          position = end; controller.enqueue(new Uint8Array(bytes));
        } catch (failure) { controller.error(failure); }
      }
    });
    return new Response(stream,{status:range.status,headers});
  } catch { return new Response("Saved audio is temporarily unavailable. Use Recover playback.",{status:503}); }
}
self.addEventListener("fetch", event => {
  const request = event.request, url = new URL(request.url);
  if (!["GET","HEAD"].includes(request.method) || url.origin !== self.location.origin) return;
  const root = new URL("./",self.location.href);
  if (url.pathname.startsWith(new URL("./__audio/",root).pathname)) {
    event.respondWith(localAudio(request,url)); return;
  }
  if (request.method !== "GET") return;
  if (request.mode === "navigate" && [root.pathname,new URL("./index.html",root).pathname].includes(url.pathname)) {
    // The complete installed shell works immediately offline and always uses matching assets.
    event.respondWith(caches.open(cacheName).then(async cache => (await cache.match("./index.html")) || fetch(request)));
    return;
  }
  if (assets.map(path => new URL(path,root).href).includes(url.href)) {
    event.respondWith(caches.open(cacheName).then(async cache => (await cache.match(request)) || fetch(request)));
  }
});
