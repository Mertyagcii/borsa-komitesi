/* Borsa Komitesi servis çalışanı: ağ öncelikli, çevrimdışıyken son kopyayı gösterir. */
const CACHE = "borsa-komitesi-v1";
self.addEventListener("install", e => { self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url); if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  const key = new Request(url.origin + url.pathname); // sorgu parametresi (önbellek kırıcı) yok sayılır
  e.respondWith(fetch(req).then(res => { if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); } return res; })
    .catch(() => caches.match(key).then(r => r || (req.mode === "navigate" ? caches.match(url.origin + url.pathname.replace(/[^/]*$/, "")) : undefined))));
});
