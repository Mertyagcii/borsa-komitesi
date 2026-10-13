"""Yayın klasörü (site/) üretir: index.html + data.json + news.json (+ history.json varsa).
GitHub Actions bunu 15 dakikada bir çalıştırır."""
import json
import shutil
import time
from pathlib import Path

from fetcher import fetch_snapshot, liquid_names
from news import fetch_news

HERE = Path(__file__).parent
SITE = HERE / "site"

SITE.mkdir(exist_ok=True)
shutil.copy(HERE / "template.html", SITE / "index.html")
for extra in ("core.js", "picks.json", "research.json", "mtf_research.json", "mtf_composite.json", "mtf_walkforward.json", "mtf_log.json", "daytrade_research.json", "overnight_research.json", "limit_research.json", "ipo_research.json", "scan_log.json", "kurul2_research.json", "macro_research.json", "portfolios.json", "snapshots.json", "news_log.json", "research_history.json", "ohlcv.json", "manifest.webmanifest", "sw.js", "icon.svg", "icon-192.png", "icon-512.png"):
    if (HERE / extra).exists():
        shutil.copy(HERE / extra, SITE / extra)
snap = fetch_snapshot()
(SITE / "data.json").write_text(json.dumps(snap, ensure_ascii=False), encoding="utf-8")

news = {"ts": int(time.time()), "news": fetch_news(liquid_names(snap["stocks"]), time.time())}
(SITE / "news.json").write_text(json.dumps(news, ensure_ascii=False), encoding="utf-8")

try:  # Tarayıcı sayfası için geniş tablo (tüm göstergeler); hata verirse site yine yayınlanır
    from fetcher import fetch_wide
    wide = fetch_wide()
    (SITE / "screener.json").write_text(json.dumps(wide, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"screener.json: {len(wide['names'])} hisse, {len(wide['f'])} alan")
except Exception as e:
    print("screener.json üretilemedi:", e)
shutil.copy(HERE / "fields.json", SITE / "fields.json")

hist = HERE / "history.json"
if hist.exists():
    shutil.copy(hist, SITE / "history.json")
print(f"{len(snap['stocks'])} hisse, {len(news['news'])} hissenin haberi, geçmiş: {hist.exists()}")
