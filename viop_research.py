"""VİOP vadeli işlem verisi (TradingView 'HİSSE1!' = en yakın vade sürekli sözleşmesi): vadeli primi/iskontosu bir pozisyonlanma (akıllı para) vekili mi?
Vadeli prim = F/S − 1; kaldıraç/faiz maliyeti beklenen primi belirler (taşıma maliyeti ≈ TL faizi × vadeye kalan gün/365). Fazla prim = prim − taşıma maliyeti:
pozitif → vadelide alıcı iştahı (uzun pozisyon), negatif → vadelide satış/korunma. Test: hisse sıralaması ile sonraki 5/10/20 gün fazla getiri (IC, dilim farkı, yarılar).
Veri: cache/viop.pkl (günlük, ≈800 gün). Çıktı: viop_research.json. UYARI: sürekli sözleşme birleştirmesi, hayatta kalma yanlılığı, tek rejim; ipucu."""
import json
import pickle
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from research import HORIZONS, evaluate_factor, frames

HERE = Path(__file__).parent
CACHE = HERE / "cache" / "viop.pkl"


def expiry_after(d: date) -> date:
    """VİOP hisse vadelileri çift aylarda (2,4,6,8,10,12) ayın son iş günü vadelenir: d'den sonraki ilk vade."""
    y, m = d.year, d.month
    while True:
        if m % 2 == 0:
            nm = date(y + (m // 12), m % 12 + 1, 1)
            last = nm - timedelta(days=1)
            while last.weekday() >= 5:
                last -= timedelta(days=1)
            if last >= d:
                return last
        m += 1
        if m > 12:
            m, y = 1, y + 1


def pull(names, log=print):
    from tvDatafeed import Interval, TvDatafeed
    tv = TvDatafeed()
    out = {}
    for k, n in enumerate(names, 1):
        df = None
        for _ in range(2):
            try:
                df = tv.get_hist(f"{n}1!", "BIST", interval=Interval.in_daily, n_bars=800)
                if df is not None and len(df) > 200:
                    break
            except Exception:
                pass
            time.sleep(0.5)
        if df is not None and len(df) > 200:
            df.index = pd.to_datetime(df.index).normalize()
            out[n] = df[["close", "volume"]].astype(float)
        if k % 20 == 0:
            log(f"[{k}/{len(names)}] vadeli var: {len(out)}")
            tv = TvDatafeed()
    return out


def excess_basis(spot: pd.DataFrame, fut: dict, rate: pd.Series) -> pd.DataFrame:
    cols = {}
    exp = {d: expiry_after(d.date()) for d in spot.index}
    days = pd.Series({d: (exp[d] - d.date()).days for d in spot.index}, dtype=float)
    carry = rate.reindex(spot.index).ffill() / 100 * days / 365
    for n, df in fut.items():
        if n not in spot:
            continue
        f = df["close"].reindex(spot.index)
        b = f / spot[n] - 1
        b = b.where(b.abs() < 0.25)  # veri hatası/sözleşme geçişi
        cols[n] = b - carry
    return pd.DataFrame(cols)


def main(force=False):
    data = pickle.loads((HERE / "cache" / "ohlcv_wide.pkl").read_bytes())
    f, index = frames(data)
    spot = f["close"]
    if force or not CACHE.exists() or time.time() - CACHE.stat().st_mtime > 6 * 86400:
        names = list(spot.columns)
        fut = pull(names)
        CACHE.write_bytes(pickle.dumps(fut))
    fut = pickle.loads(CACHE.read_bytes())
    # TL faizi (TR02Y) günlük serisi
    from tvDatafeed import Interval, TvDatafeed
    tv = TvDatafeed()
    r = tv.get_hist("TR02Y", "TVC", interval=Interval.in_daily, n_bars=800)
    rate = r["close"].astype(float); rate.index = pd.to_datetime(rate.index).normalize()
    eb = excess_basis(spot, fut, rate)
    fwd = {h: spot.shift(-h) / f["open"].shift(-1) - 1 for h in HORIZONS}
    res = {"generated": datetime.now().strftime("%Y-%m-%d %H:%M"), "futures": int(eb.shape[1]), "names": sorted(map(str, eb.columns)), "stocks": int(spot.shape[1]), "factors": {}, "stats": {}}
    arr = eb.stack().dropna()
    res["stats"] = {"median_pct": round(float(arr.median() * 100), 2), "p10": round(float(arr.quantile(.1) * 100), 2), "p90": round(float(arr.quantile(.9) * 100), 2), "n": int(len(arr))}
    cut = spot.index[-1] - pd.Timedelta(days=365)
    mid = eb.index[len(eb) // 2]
    print(f"vadeli olan hisse: {eb.shape[1]}; fazla prim medyan %{res['stats']['median_pct']} (p10 %{res['stats']['p10']}, p90 %{res['stats']['p90']})")
    # faktörler: fazla prim (yüksek = uzun iştah), 5 günlük prim değişimi
    facs = {"fazla_prim": eb, "prim_degisim5": eb - eb.shift(5), "prim_sapma20": eb - eb.rolling(20).mean()}
    for k, fac in facs.items():
        row = {}
        for h in HORIZONS:
            e = evaluate_factor(fac.reindex(columns=eb.columns), {hh: fwd[hh][eb.columns] for hh in HORIZONS}, h)
            row[f"h{h}"] = e
        e10 = row.get("h10")
        row["verdict"] = "yetersiz" if not e10 else "kanıt var" if e10["t"] >= 2 and e10["spread"] > 0 else "ters kanıt" if e10["t"] <= -2 and e10["spread"] < 0 else "belirsiz"
        res["factors"][k] = row
        print(k, {h: row[f"h{h}"] for h in HORIZONS}, row["verdict"])
    txt = json.dumps(res, ensure_ascii=False, separators=(",", ":")); assert "NaN" not in txt
    (HERE / "viop_research.json").write_text(txt, encoding="utf-8")


if __name__ == "__main__":
    import sys
    main("--force" in sys.argv)
