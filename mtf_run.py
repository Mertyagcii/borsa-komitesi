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
try:  # gün içi / gece taşıma araştırması: 15 dk veri haftada bir yenilenir
    ip = HERE / "cache" / "intraday15.pkl"
    if not ip.exists() or time.time() - ip.stat().st_mtime > 6 * 86400:
        subprocess.run([sys.executable, str(HERE / "intraday_pull.py"), "--cap", "100"], check=False, timeout=1200)
    if ip.exists():
        import daytrade_research
        import overnight_research
        daytrade_research.main()
        overnight_research.main()
except Exception as e:
    print("gün içi araştırma başarısız:", e)
try:
    import limit_research
    limit_research.main()
    subprocess.run([sys.executable, str(HERE / "pull_ipo.py"), "--if-stale"], check=False, timeout=900)
    import ipo_research
    ipo_research.main()
except Exception as e:
    print("tavan/taban ya da halka arz araştırması başarısız:", e)
import mtf_composite
import mtf_research
import mtf_walkforward
mtf_research.main()
mtf_composite.main()
mtf_walkforward.main()
