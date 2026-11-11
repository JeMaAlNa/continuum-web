"use strict";
const cacheName = "continuum-web-v7";
const assets = ["./", "./index.html", "./player.css?v=7", "./tags.js?v=7", "./player.js?v=7", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(assets)));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((name) => name.startsWith("continuum-web-") && name !== cacheName).map((name) => caches.delete(name)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === "navigate" && new URL(request.url).pathname === new URL("./", self.location.href).pathname) {
    event.respondWith(fetch(request).catch(() => caches.match("./index.html")));
    return;
  }
  const urls = assets.map((path) => new URL(path, self.location.href).href);
  if (urls.includes(request.url)) event.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
});
