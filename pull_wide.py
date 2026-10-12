"""Geniş evren (≈400 hisse, düşük hacimli olanlar dahil) günlük OHLCV önbelleği: cache/ohlcv_wide.pkl.
Amaç: araştırmanın yalnızca en likit 125 hisseye (büyük şirket yanlılığı) bağlı kalmadığını sınamak. Haftada bir çalışır."""
import os
import pickle
import sys
import time
from pathlib import Path

import fetcher
import research

HERE = Path(__file__).parent
OUT = HERE / "cache" / "ohlcv_wide.pkl"
if "--if-stale" in sys.argv and OUT.exists() and time.time() - OUT.stat().st_mtime < 6 * 86400:
    print("geniş önbellek güncel, atlandı.")
    raise SystemExit(0)
names = fetcher.liquid_names(fetcher.fetch_snapshot()["stocks"], min_tl=5, cap=int(os.environ.get("WIDE_CAP", "400")))
print(len(names), "hisse çekiliyor...", flush=True)
t0 = time.time()
data = research.pull(names, log=lambda m: print(m, f"{time.time() - t0:.0f}s", flush=True))
OUT.parent.mkdir(exist_ok=True)
OUT.write_bytes(pickle.dumps(data))
print("tamam:", len(data), "seri", f"{time.time() - t0:.0f}s")
