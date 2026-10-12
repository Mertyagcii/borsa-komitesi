"""Çok zamanlı araştırmayı haftada bir çalıştırır: geniş evren önbelleği, mtf_research, mtf_composite, mtf_walkforward.
research.py'nin önbelleği (cache/ohlcv.pkl) gerekir."""
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "mtf_composite.json"
if "--if-stale" in sys.argv and OUT.exists() and time.time() - OUT.stat().st_mtime < 6 * 86400:
    print("mtf araştırması güncel, atlandı.")
    raise SystemExit(0)
if not (HERE / "cache" / "ohlcv.pkl").exists():
    print("cache/ohlcv.pkl yok (research.py önce çalışmalı); atlandı.")
    raise SystemExit(0)
try:  # geniş evren başarısız olursa çekirdek analiz yine çalışır
    subprocess.run([sys.executable, str(HERE / "pull_wide.py"), "--if-stale"], check=False, timeout=1500)
except Exception as e:
    print("geniş evren çekilemedi:", e)
import mtf_composite
import mtf_research
import mtf_walkforward
mtf_research.main()
mtf_composite.main()
mtf_walkforward.main()
