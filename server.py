"""TradingOfis yerel sunucusu: http://localhost:8765
- Arayüzü (template.html) sunar.
- TradingView'den BIST verisini çeker; her 15 dakikada bir arka planda yeniler.
- /api/data (önbellekteki veri), /api/refresh (POST, hemen yeniler).
Sadece 127.0.0.1'e bağlanır; dışarıdan erişilemez."""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from fetcher import fetch_snapshot, liquid_names
from news import fetch_news

HERE = Path(__file__).parent
CACHE = HERE / "data.json"
NEWS = HERE / "news.json"
LIVE = HERE / "cache" / "live"  # yerel sunucunun yenilediği izlenen dosyalar (git'e girmez): history/ohlcv/screener burada tutulur.
# Neden: bu dosyaları depodaki kopyanın üstüne yazmak CI'ın commit'leriyle çakışıyordu (tek satırlık JSON satır bazında birleşmez).
PORT = 8765
HISTORY = LIVE / "history.json"


def live(name: str) -> Path:
    """Yerel yenilenmiş kopya varsa o, yoksa depodaki kopya."""
    p = LIVE / name
    return p if p.exists() else HERE / name
REFRESH_SECONDS = 15 * 60

state = {"ts": 0, "generated": "–", "stocks": [], "error": None}
lock = threading.Lock()
fetch_lock = threading.Lock()


def fetch() -> None:
    """TradingView'den veriyi çeker. Hata olursa eski veriyi korur, hatayı state'e yazar."""
    with fetch_lock:
        try:
            new = fetch_snapshot()
            with lock:
                state.update(new)
            CACHE.write_text(json.dumps(new, ensure_ascii=False), encoding="utf-8")
        except Exception as e:  # ağ/kütüphane hatası: eski veriyle devam
            with lock:
                state["error"] = f"{type(e).__name__}: {e}"[:200]
            return
        try:  # Tarayıcı sayfası için geniş tablo (tüm göstergeler)
            from fetcher import fetch_wide
            LIVE.mkdir(parents=True, exist_ok=True)
            (LIVE / "screener.json").write_text(json.dumps(fetch_wide(), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        except Exception:
            pass
        try:  # haber akışı hisse verisinden bağımsız; hata verirse eski haber kalır
            news = {"ts": int(time.time()), "news": fetch_news(liquid_names(new["stocks"]), time.time())}
            NEWS.write_text(json.dumps(news, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass


def history_loop() -> None:
    """Günde bir kez (piyasa kapanışından sonra) fiyat geçmişini ve geri test istatistiklerini yeniler."""
    import history
    while True:
        try:
            if history.is_stale(live("history.json")):
                names = liquid_names(state["stocks"]) if state["stocks"] else []
                if names:
                    data = history.build(names, log=lambda m: None)
                    ohlcv = data.pop("_ohlcv", None)
                    history.write_ohlcv(ohlcv, LIVE)
                    if len(data["stocks"]) >= len(names) // 2:
                        LIVE.mkdir(parents=True, exist_ok=True)
                        HISTORY.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        except Exception:
            pass
        time.sleep(30 * 60)


def snapshot() -> bytes:
    with lock:
        return json.dumps(state, ensure_ascii=False).encode("utf-8")


def background_refresh() -> None:
    while True:
        time.sleep(REFRESH_SECONDS)
        fetch()


class Handler(BaseHTTPRequestHandler):
    def _send(self, body: bytes, ctype: str, code: int = 200) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path in ("/", "/index.html"):
            self._send((HERE / "template.html").read_bytes(), "text/html; charset=utf-8")
        elif self.path == "/api/data":
            self._send(snapshot(), "application/json; charset=utf-8")
        elif self.path.split("?")[0] in ("/news.json", "/history.json", "/picks.json", "/core.js", "/research.json", "/mtf_research.json", "/mtf_composite.json", "/mtf_walkforward.json", "/mtf_log.json", "/daytrade_research.json", "/overnight_research.json", "/limit_research.json", "/ipo_research.json", "/scan_log.json", "/kurul2_research.json", "/alarm_log.json", "/candles.json", "/stress.json", "/viop.json", "/viop_research.json", "/newsmood.json", "/geo.json", "/macro_research.json", "/portfolios.json", "/snapshots.json", "/news_log.json", "/research_history.json", "/screener.json", "/fields.json", "/ohlcv.json", "/manifest.webmanifest", "/sw.js", "/icon.svg", "/icon-192.png", "/icon-512.png"):
            f = live(self.path.split("?")[0].lstrip("/"))
            if f.exists():
                ct = {".js": "application/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json"}.get(f.suffix, "application/json; charset=utf-8")
                self._send(f.read_bytes(), ct)
            else:
                self._send(b"{}", "application/json; charset=utf-8", 404)
        else:
            self._send(b"Not found", "text/plain", 404)

    def do_POST(self) -> None:
        if self.path == "/api/refresh":
            fetch()
            self._send(snapshot(), "application/json; charset=utf-8")
        else:
            self._send(b"Not found", "text/plain", 404)

    def log_message(self, *args) -> None:
        pass


def main() -> None:
    if CACHE.exists():
        try:
            state.update(json.loads(CACHE.read_text(encoding="utf-8")))
        except Exception:
            pass
    # İlk veri: önbellek yoksa ya da 15 dk'dan eskiyse arka planda çek (sayfa hemen açılsın)
    if time.time() - state["ts"] > REFRESH_SECONDS or not NEWS.exists():
        threading.Thread(target=fetch, daemon=True).start()
    threading.Thread(target=background_refresh, daemon=True).start()
    threading.Thread(target=history_loop, daemon=True).start()
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:
        raise SystemExit(f"{PORT} portu kullanımda; sunucu zaten çalışıyor olabilir.")
    print(f"TradingOfis çalışıyor: http://localhost:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
