"""Gün içi araştırma verisi: en likit hisselerin 15 dakikalık çubukları (≈ 5000 çubuk ≈ 5-6 ay) → cache/intraday15.pkl.
Kullanım: python intraday_pull.py [--cap 100]"""
import pickle
import sys
import time
from pathlib import Path

import pandas as pd

import fetcher

HERE = Path(__file__).parent
OUT = HERE / "cache" / "intraday15.pkl"
cap = int(sys.argv[sys.argv.index("--cap") + 1]) if "--cap" in sys.argv else 100
names = fetcher.liquid_names(fetcher.fetch_snapshot()["stocks"], min_tl=20, cap=cap)
print(len(names), "hisse çekiliyor...", flush=True)
from tvDatafeed import Interval, TvDatafeed
tv = TvDatafeed()
data, t0 = {}, time.time()
for k, n in enumerate(names, 1):
    df = None
    for _ in range(3):
        try:
            df = tv.get_hist(n, "BIST", interval=Interval.in_15_minute, n_bars=5000)
            if df is not None and len(df) > 500:
                break
        except Exception:
            pass
        time.sleep(1)
    if df is not None and len(df) > 500:
        df.index = pd.to_datetime(df.index)
        data[n] = df[["open", "high", "low", "close", "volume"]].astype(float)
    if k % 10 == 0:
        tv = TvDatafeed()
        print(f"[{k}/{len(names)}] {time.time() - t0:.0f}s", flush=True)
OUT.parent.mkdir(exist_ok=True)
OUT.write_bytes(pickle.dumps(data))
print("tamam:", len(data), "seri", f"{time.time() - t0:.0f}s")
