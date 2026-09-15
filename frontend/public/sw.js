// Minimal service worker: makes the app installable and keeps the app shell
// (this HTML/JS/CSS) available on a flaky connection. It deliberately does
// NOT cache /api/* or session iframe traffic — sessions are live VNC/
// websocket streams, there is no meaningful "offline" for them. Losing
// connectivity mid-session is handled in-app by the reconnect overlay
// (Window.tsx LostOverlay) and the network-status banner, not by this worker.
const CACHE = "nextdesk-shell-v1";
const SHELL_URLS = ["/", "/manifest.json", "/favicon-32.png", "/favicon-180.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL_URLS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // Network-first for the shell so a redeploy is picked up immediately;
  // fall back to cache only when the network is unreachable.
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(request, res.clone()));
        return res;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match("/")))
  );
});
