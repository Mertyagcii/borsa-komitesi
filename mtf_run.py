"""Çok zamanlı araştırmayı (mtf_research + mtf_composite) haftada bir çalıştırır. research.py'nin önbelleği (cache/ohlcv.pkl) gerekir."""
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
import mtf_composite
import mtf_research
mtf_research.main()
mtf_composite.main()
