const CACHE = "berespro-v38";
const ASSETS = ["./","index.html","manifest.webmanifest",
  "fonts/Unbounded-700.ttf","fonts/Unbounded-800.ttf",
  "fonts/HankenGrotesk-400.ttf","fonts/HankenGrotesk-500.ttf","fonts/HankenGrotesk-600.ttf",
  "fonts/HankenGrotesk-700.ttf","fonts/HankenGrotesk-800.ttf",
  "icons/icon-192.png","icons/icon-512.png","icons/icon-maskable-512.png",
  "icons/apple-touch-180.png"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  // Never touch cross-origin requests. The old SW cached EVERY GET that wasn't
  // in the API path list — including Clerk's SDK script and its FAPI calls to
  // *.clerk.accounts.dev. Serving those from cache replays stale auth/client
  // state and is a direct cause of flaky sign-in. Same-origin only, full stop.
  if (url.origin !== self.location.origin) return;

  // Network-first for the app shell so every deploy is picked up immediately;
  // cache is only a fallback for offline.
  if (e.request.mode === "navigate" || url.pathname === "/" || url.pathname.endsWith("/index.html")) {
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put("index.html", copy));
        return res;
      }).catch(() => caches.match("index.html"))
    );
    return;
  }

  // Cache-first for static assets (fonts, icons, manifest).
  e.respondWith(caches.match(e.request).then(hit => hit ||
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    })
  ));
});
