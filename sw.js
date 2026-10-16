/* Borsa Komitesi servis çalışanı. Sayfa, kod ve canlı veri: ağ öncelikli (çevrimdışıyken son kopya). Ağır ve yavaş değişen araştırma dosyaları:
   önce önbellekten göster, arkadan yenile (tekrar ziyaretler çok hızlı açılır). */
const CACHE = "borsa-komitesi-v2";
const SWR = /\/(research|mtf_composite|mtf_research|mtf_walkforward|daytrade_research|overnight_research|limit_research|ipo_research|kurul2_research|macro_research|viop_research|fields|ohlcv|candles|screener)\.json$/;
self.addEventListener("install", e => { self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url); if (url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  const key = new Request(url.origin + url.pathname); // sorgu parametresi (önbellek kırıcı) yok sayılır
  if (SWR.test(url.pathname)) {
    e.respondWith(caches.open(CACHE).then(c => c.match(key).then(hit => {
      const net = fetch(req).then(res => { if (res && res.ok) c.put(key, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    })));
    return;
  }
  e.respondWith(fetch(req).then(res => { if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); } return res; })
    .catch(() => caches.match(key).then(r => r || (req.mode === "navigate" ? caches.match(url.origin + url.pathname.replace(/[^/]*$/, "")) : undefined))));
});
