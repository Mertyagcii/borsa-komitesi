"""Yayın klasörü (site/) üretir: index.html + data.json. GitHub Actions bunu 15 dakikada bir çalıştırır."""
import json
import shutil
from pathlib import Path

from fetcher import fetch_snapshot

HERE = Path(__file__).parent
SITE = HERE / "site"

SITE.mkdir(exist_ok=True)
shutil.copy(HERE / "template.html", SITE / "index.html")
snap = fetch_snapshot()
(SITE / "data.json").write_text(json.dumps(snap, ensure_ascii=False), encoding="utf-8")
print(f"{len(snap['stocks'])} hisse, {snap['generated']}")
