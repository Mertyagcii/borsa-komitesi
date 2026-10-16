"""Mum grafiği verisi (candles.json) tek başına üretir: history.py her gün zaten üretir; bu betik ilk kurulum / elle yenileme içindir.
Kullanım: python candles.py [--limit N]"""
import argparse
import sys

from fetcher import fetch_snapshot, liquid_names
from history import CANDLE_BARS, get_hist, make_candles, write_candles


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    a = ap.parse_args()
    from tvDatafeed import TvDatafeed
    names = liquid_names(fetch_snapshot()["stocks"])[: a.limit]
    tv = TvDatafeed()
    frames, axis = {}, None
    for k, n in enumerate(["XU100"] + names):
        df = get_hist(tv, n)
        if df is None:
            continue
        if n == "XU100":
            axis = df.index
        else:
            frames[n] = df.tail(CANDLE_BARS + 5)
        if k % 25 == 0:
            print(f"[{k}/{len(names)}] ...", flush=True)
            tv = TvDatafeed()
    if axis is None:
        sys.exit("Endeks verisi alınamadı.")
    c = make_candles(frames, axis)
    write_candles(c)
    print(f"candles.json: {len(c['stocks'])} hisse, {len(c['dates'])} gün")


if __name__ == "__main__":
    main()
