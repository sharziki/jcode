/*
 * Service worker for the jcode web client.
 *
 * Scope is deliberately narrow: precache the app shell so the PWA opens
 * instantly and survives a brief network drop. It never caches API traffic
 * (`/pair`, `/sessions`, `/ws`) because stale session data would be worse
 * than an honest error.
 */
"use strict";

// Bump on every shell change. The old cache is deleted on activate, so a stale
// version would otherwise keep serving the previous app.js and hide the fix.
const VERSION = "jcode-shell-v6-conn";
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

  // Stale-while-revalidate for the app shell: serve the cached copy instantly
  // and refresh it in the background. Network-first meant every launch, even a
  // warm one on a fast network, paid a full round trip before painting. The
  // shell is static and versioned, so a one-load-stale copy is harmless, and
  // live state arrives over /sessions and /ws anyway, which are never cached.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => hit || (request.mode === "navigate" ? caches.match("/") : undefined));
      return hit || network;
    }),
  );
});
