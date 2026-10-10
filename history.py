"""TradingView'den günlük fiyat geçmişi çeker (tvdatafeed) ve gerçek geri test istatistikleri üretir.

Sinyaller (Bollinger 20,2 alt bandı):
  A = kapanış alt banda değdi/altına indi
  B = A ve kapanış SMA50 altında   (Livermore'un "düşen bıçağı")
  C = A ve kapanış SMA50 üstünde
Her sinyalden sonra 5/10/20 işlem günü getirisi ölçülür; art arda gelen sinyaller 5 gün seyreltilir.
Notlar: işlem maliyeti yok, hayatta kalan (bugün listede olan) hisseler üzerinden, geçmiş geleceği garanti etmez.
"""
import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

from fetcher import TZ, liquid_names

HERE = Path(__file__).parent
OUT = HERE / "history.json"
HORIZONS = (5, 10, 20)
N_BARS = 800
KEEP_CLOSES = 170


def get_hist(tv, name: str, retries: int = 3):
    from tvDatafeed import Interval
    for _ in range(retries):
        try:
            df = tv.get_hist(name, "BIST", interval=Interval.in_daily, n_bars=N_BARS)
            if df is not None:
                return df if len(df) > 80 else None  # yeni halka arz: yetersiz geçmiş, tekrar denemeye değmez
        except Exception:
            pass
        time.sleep(1.0)
    return None


def signals(close: pd.Series) -> dict[str, list[int]]:
    ma = close.rolling(20).mean()
    sd = close.rolling(20).std(ddof=0)
    lower = ma - 2 * sd
    sma50 = close.rolling(50).mean()
    raw = (close <= lower) & sma50.notna()
    idx, last = [], -99
    for i in np.flatnonzero(raw.to_numpy()):
        if i - last > 5:  # art arda sinyalleri seyrelt
            idx.append(int(i))
            last = i
    below = [i for i in idx if close.iloc[i] < sma50.iloc[i]]
    above = [i for i in idx if close.iloc[i] >= sma50.iloc[i]]
    return {"A": idx, "B": below, "C": above}


def forward_returns(close: pd.Series, idx: list[int]) -> dict[int, list[float]]:
    arr = close.to_numpy()
    return {h: [arr[i + h] / arr[i] - 1 for i in idx if i + h < len(arr)] for h in HORIZONS}


def summarize(rets: dict[int, list[float]], n_signals: int) -> dict:
    out = {"n": n_signals}
    for h, r in rets.items():
        if r:
            a = np.array(r) * 100
            w, l = a[a > 0], a[a <= 0]
            out[f"h{h}"] = {"win": round(float((a > 0).mean() * 100), 1), "mean": round(float(a.mean()), 2),
                            "med": round(float(np.median(a)), 2), "p10": round(float(np.percentile(a, 10)), 2), "n": len(a),
                            "aw": round(float(w.mean()), 2) if len(w) else 0.0, "al": round(float(l.mean()), 2) if len(l) else 0.0}
    return out


def build(names: list[str], log=print) -> dict:
    from tvDatafeed import TvDatafeed
    tv = TvDatafeed()
    stocks, pool = {}, {"A": {h: [] for h in HORIZONS}, "B": {h: [] for h in HORIZONS}, "C": {h: [] for h in HORIZONS}}
    pool_n = {"A": 0, "B": 0, "C": 0}
    base = {h: [] for h in HORIZONS}
    for k, name in enumerate(names, 1):
        df = get_hist(tv, name)
        if df is None:
            log(f"[{k}/{len(names)}] {name}: veri yok/yetersiz geçmiş")
            if k % 10 == 0:
                tv = TvDatafeed()  # bağlantı koptuysa yeniden bağlan
            continue
        close = df["close"].astype(float).reset_index(drop=True)
        lr = np.log(close).diff().dropna()
        sig = signals(close)
        rets_a = forward_returns(close, sig["A"])
        stocks[name] = {
            "sigma60": round(float(lr.tail(60).std()), 5),
            "sigma250": round(float(lr.tail(250).std()), 5),
            "ac1": round(float(lr.tail(250).autocorr(lag=1)), 3),
            "dd250": round(float((close.tail(250) / close.tail(250).cummax() - 1).min() * 100), 1),
            "last": str(df.index[-1])[:10],
            "closes": [round(float(x), 3) for x in close.tail(KEEP_CLOSES)],
            "bt": summarize(rets_a, len(sig["A"])),
        }
        arr = close.to_numpy()
        for h in HORIZONS:  # koşulsuz taban: her gün alınsaydı (enflasyonlu nominal yükselişi ayıklamak için)
            base[h].append(arr[h:] / arr[:-h] - 1)
        for key in "ABC":
            pool_n[key] += len(sig[key])
            for h, r in forward_returns(close, sig[key]).items():
                pool[key][h] += r
        if k % 25 == 0:
            log(f"[{k}/{len(names)}] ...")
    now = datetime.now(TZ)
    pooled = {key: summarize(pool[key], pool_n[key]) for key in "ABC"}
    pooled["base"] = summarize({h: np.concatenate(v).tolist() if v else [] for h, v in base.items()}, 0)
    return {
        "ts": int(time.time()), "generated": now.strftime("%Y-%m-%d %H:%M"),
        "bars": N_BARS, "pooled": pooled,
        "stocks": stocks,
    }


def is_stale() -> bool:
    """Günde bir kez, piyasa kapandıktan sonra (18:45 TR) yenile."""
    if not OUT.exists():
        return True
    try:
        age_h = (time.time() - json.loads(OUT.read_text(encoding="utf-8"))["ts"]) / 3600
    except Exception:
        return True
    now = datetime.now(TZ)
    after_close = now.hour * 60 + now.minute >= 18 * 60 + 45
    return age_h > 72 or (age_h > 23 and after_close and now.weekday() < 5)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--if-stale", action="store_true", help="Sadece eskiyse yenile")
    p.add_argument("--limit", type=int, default=None, help="Test için hisse sayısı")
    args = p.parse_args()
    if args.if_stale and not is_stale():
        print("history.json güncel, atlandı.")
        return
    from fetcher import fetch_snapshot
    names = liquid_names(fetch_snapshot()["stocks"])[: args.limit]
    print(f"{len(names)} hisse için geçmiş çekiliyor...")
    data = build(names, log=lambda m: print(m, flush=True))
    if len(data["stocks"]) < max(1, len(names) // 2):
        sys.exit("Çok az hisse için veri alınabildi; history.json güncellenmedi.")
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"history.json yazıldı: {len(data['stocks'])} hisse")


if __name__ == "__main__":
    main()
