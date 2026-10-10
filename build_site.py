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
snap = fetch_snapshot()
(SITE / "data.json").write_text(json.dumps(snap, ensure_ascii=False), encoding="utf-8")

news = {"ts": int(time.time()), "news": fetch_news(liquid_names(snap["stocks"]), time.time())}
(SITE / "news.json").write_text(json.dumps(news, ensure_ascii=False), encoding="utf-8")

hist = HERE / "history.json"
if hist.exists():
    shutil.copy(hist, SITE / "history.json")
print(f"{len(snap['stocks'])} hisse, {len(news['news'])} hissenin haberi, geçmiş: {hist.exists()}")
