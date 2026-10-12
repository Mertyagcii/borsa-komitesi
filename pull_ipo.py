"""Yeni halka arzların (son ~2 yıl, geçmişi kısa olanlar dahil) günlük OHLCV verisi → cache/ohlcv_ipo.pkl.
research.pull() 300 günden kısa geçmişi atar; en yeni halka arzlar bu yüzden araştırmaya girmiyordu. ipo_research.py bu önbelleği geniş önbelleğe ekler.
Kullanım: python pull_ipo.py [--if-stale]"""
import pickle
import sys
import time
from pathlib import Path

import pandas as pd

import fetcher

HERE = Path(__file__).parent
OUT = HERE / "cache" / "ohlcv_ipo.pkl"
if "--if-stale" in sys.argv and OUT.exists() and time.time() - OUT.stat().st_mtime < 6 * 86400:
    print("halka arz önbelleği güncel, atlandı.")
    raise SystemExit(0)
now = time.time()
names = [s["name"] for s in fetcher.fetch_snapshot()["stocks"] if s.get("fbt") and (now - s["fbt"]) / 86400 <= 760 and s.get("volume")]
print(len(names), "yeni halka arz çekiliyor...", flush=True)
from tvDatafeed import Interval, TvDatafeed
tv = TvDatafeed()
data = {}
for k, n in enumerate(names, 1):
    df = None
    for _ in range(3):
        try:
            df = tv.get_hist(n, "BIST", interval=Interval.in_daily, n_bars=800)
            if df is not None and len(df) >= 3:
                break
        except Exception:
            pass
        time.sleep(1)
    if df is not None and len(df) >= 3:
        df.index = pd.to_datetime(df.index).normalize()
        data[n] = df[["open", "high", "low", "close", "volume"]].astype(float)
    if k % 10 == 0:
        tv = TvDatafeed()
OUT.parent.mkdir(exist_ok=True)
OUT.write_bytes(pickle.dumps(data))
print("tamam:", len(data), "seri")
