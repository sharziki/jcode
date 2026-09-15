/*
 * Service worker for the jcode web client.
 *
 * Scope is deliberately narrow: precache the app shell so the PWA opens
 * instantly and survives a brief network drop. It never caches API traffic
 * (`/pair`, `/sessions`, `/ws`) because stale session data would be worse
 * than an honest error.
 */
"use strict";

const VERSION = "jcode-shell-v1";
const PRECACHE = [
  "/",
  "/index.html",
  "/app.js",
  "/app.css",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never serve live server state from cache.
  if (url.pathname === "/sessions" || url.pathname === "/ws" || url.pathname === "/health") {
    return;
  }

  // Network-first so a running server always wins, with the cached shell as
  // the offline fallback. A navigation that misses falls back to the shell so
  // deep links (#session-id) still open the app.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches
          .match(request)
          .then((hit) => hit || (request.mode === "navigate" ? caches.match("/") : undefined)),
      ),
  );
});
