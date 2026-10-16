"""Kara kuğu / stres testi için hisse duyarlılıkları (stress.json).
Her hisse için günlük getiri, BIST 100 getirisi (r_m), USDTRY getirisi (f) ve TR 10 yıllık faiz değişimi (y, puan) üzerine en küçük kareler regresyonu:
    r_i = a + b_m·r_m + b_f·f + b_y·y
Ayrıca düşüş betası (yalnızca r_m < 0 günlerinde b_md): çöküşlerde hisselerin piyasadan daha sert düştüğünü yakalar. Bedelsiz/bölünme sıçramaları (|getiri| > %11) dışlanır.
Doğrulama: BIST 100'ün ≤ −%2 düştüğü günlerde modelin öngördüğü ve gerçekleşen ortalama hisse getirisi karşılaştırılır (meta.calibration).
UYARI: ~3 yıl, tek rejim (yüksek enflasyonlu TL); duyarlılıklar geçmişte gözlenen ilişkidir, gelecekteki şokun şiddetini garanti etmez.
Veri: ohlcv.json (hisse/endeks kapanışları), tvdatafeed (USDTRY, TR10Y). Çıktı: stress.json."""
import json
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
MAX_DAILY = 0.11


def pull_macro(n_bars: int = 800) -> pd.DataFrame:
    from tvDatafeed import Interval, TvDatafeed
    tv = TvDatafeed()
    out = {}
    for key, sym, ex in (("usdtry", "USDTRY", "FX_IDC"), ("tr10y", "TR10Y", "TVC")):
        df = None
        for _ in range(3):
            try:
                df = tv.get_hist(sym, ex, interval=Interval.in_daily, n_bars=n_bars)
                if df is not None and len(df) > 300:
                    break
            except Exception:
                pass
            time.sleep(1)
        if df is None:
            raise SystemExit(f"{sym} verisi alınamadı")
        s = df["close"].astype(float); s.index = pd.to_datetime(s.index).normalize()
        out[key] = s[~s.index.duplicated(keep="last")]
        time.sleep(0.4)
    return pd.DataFrame(out).sort_index()


def ols(y: np.ndarray, X: np.ndarray):
    A = np.column_stack([np.ones(len(y)), X]); beta, *_ = np.linalg.lstsq(A, y, rcond=None)
    pred = A @ beta; ss_res = float(((y - pred) ** 2).sum()); ss_tot = float(((y - y.mean()) ** 2).sum())
    return beta, (1 - ss_res / ss_tot if ss_tot > 0 else 0.0)


def main() -> None:
    oh = json.loads((HERE / "ohlcv.json").read_text(encoding="utf-8"))
    dates = pd.to_datetime(oh["dates"]); idx = pd.Series(oh["index"], index=dates, dtype=float)
    mac = pull_macro().reindex(dates).ffill().bfill()
    rm = idx.pct_change().to_numpy(); f = mac["usdtry"].pct_change().to_numpy(); y = mac["tr10y"].diff().to_numpy()
    base = np.isfinite(rm) & np.isfinite(f) & np.isfinite(y)
    res, calib_pred, calib_real = {}, [], []
    crash = base & (rm <= -0.02)
    for nm, d in oh["stocks"].items():
        c = pd.Series([np.nan if v is None else v for v in d["c"]], index=dates, dtype=float)
        r = c.pct_change(fill_method=None).to_numpy()
        ok = base & np.isfinite(r) & (np.abs(r) <= MAX_DAILY)
        if ok.sum() < 250:
            continue
        Y = r[ok] * 100; Xm = rm[ok] * 100; Xf = f[ok] * 100; Xy = y[ok]
        bt, r2 = ols(Y, np.column_stack([Xm, Xf, Xy]))
        dn = Xm < 0
        bmd = float(np.cov(Y[dn], Xm[dn])[0, 1] / np.var(Xm[dn], ddof=1)) if dn.sum() > 60 else float(bt[1])
        bm1 = float(np.cov(Y, Xm)[0, 1] / np.var(Xm, ddof=1))
        w = c.pct_change(5, fill_method=None).dropna().to_numpy() * 100
        res[nm] = {"bm": round(bm1, 3), "bm2": round(float(bt[1]), 3), "bmd": round(bmd, 3), "bf": round(float(bt[2]), 3), "by": round(float(bt[3]), 3), "r2": round(r2, 3), "n": int(ok.sum()),
                   "worst1": round(float(np.nanmin(Y)), 2), "worst5": round(float(np.nanmin(w)), 2) if len(w) else None}
        cm = ok & crash
        if cm.sum() >= 5:
            calib_real.append(float(np.mean(r[cm] * 100))); calib_pred.append(float(np.mean(bmd * rm[cm] * 100)))
    # makro tepki katsayıları: piyasanın kur/faiz şoklarına ortalama tepkisi (stres senaryosunda piyasa bacağı için)
    ok = base & (np.abs(rm) < 0.11)
    km = float(np.cov(rm[ok] * 100, f[ok] * 100)[0, 1] / np.var(f[ok] * 100, ddof=1)); ky = float(np.cov(rm[ok] * 100, y[ok])[0, 1] / np.var(y[ok], ddof=1))
    meta = {"generated": datetime.now().strftime("%Y-%m-%d %H:%M"), "from": str(dates[0].date()), "to": str(dates[-1].date()), "stocks": len(res), "crash_days": int(crash.sum()),
            "km": round(km, 3), "ky": round(ky, 3),
            "calibration": {"pred": round(float(np.mean(calib_pred)), 2) if calib_pred else None, "real": round(float(np.mean(calib_real)), 2) if calib_real else None},
            "usdtry_vol": round(float(np.nanstd(f[base]) * 100), 2), "tr10y_vol": round(float(np.nanstd(y[base])), 3),
            "usdtry_max": round(float(np.nanmax(f[base]) * 100), 2), "tr10y_max": round(float(np.nanmax(y[base])), 2), "xu_min": round(float(np.nanmin(rm[base]) * 100), 2)}
    (HERE / "stress.json").write_text(json.dumps({"meta": meta, "stocks": res}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    bmds = np.array([v["bmd"] for v in res.values()])
    print(f"stress.json: {len(res)} hisse; düşüş betası medyan {np.median(bmds):.2f}, %90 {np.percentile(bmds, 90):.2f}; kalibrasyon (çöküş günleri) öngörülen {meta['calibration']['pred']}% gerçekleşen {meta['calibration']['real']}%; "
          f"piyasa kur tepkisi km={km:.3f}, faiz tepkisi ky={ky:.3f}")


if __name__ == "__main__":
    main()
