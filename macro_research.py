"""Makro kalkan araştırması: kur, VIX, petrol, dolar endeksi, altın, faiz ve getiri eğrisi koşulları, BIST 100'ün sonraki 5/20 günlük getirisini öngörüyor mu?
Her koşul için: koşul doğruyken ve yanlışken sonraki getiri, fark, t, yarılar. Birleşik "risk-off sayısı" ile sonraki 20 günlük getiri.
Veri: tvdatafeed günlük (≈800 gün). Çıktı: macro_research.json (arayüzdeki Makro Kalkan kanıt durumunu buradan okur).
UYARI: ~3 yıl, tek rejim (yüksek enflasyonlu TL); kanıt değil ipucu."""
import json
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
SYMS = {"usdtry": ("USDTRY", "FX_IDC"), "brent": ("UKOIL", "TVC"), "vix": ("VIX", "TVC"), "dxy": ("DXY", "TVC"), "gold": ("GOLD", "TVC"), "us10y": ("US10Y", "TVC"),
        "tr10y": ("TR10Y", "TVC"), "tr2y": ("TR02Y", "TVC"), "xu100": ("XU100", "BIST")}


def pull():
    from tvDatafeed import Interval, TvDatafeed
    tv = TvDatafeed()
    out = {}
    for k, (sym, ex) in SYMS.items():
        df = None
        for _ in range(3):
            try:
                df = tv.get_hist(sym, ex, interval=Interval.in_daily, n_bars=800)
                if df is not None and len(df) > 300:
                    break
            except Exception:
                pass
            time.sleep(1)
        if df is not None:
            df.index = pd.to_datetime(df.index).normalize()
            out[k] = df["close"].astype(float)
        time.sleep(0.4)
    return pd.DataFrame(out).sort_index().ffill()


def conditions(d):
    c = {}
    c["usdtry_5g_artis_3"] = d.usdtry.pct_change(5) > 0.03
    c["usdtry_20g_artis_8"] = d.usdtry.pct_change(20) > 0.08
    c["vix_20_ustu"] = d.vix > 20
    c["vix_25_ustu"] = d.vix > 25
    c["vix_5g_yuzde30_artis"] = d.vix.pct_change(5) > 0.30
    c["brent_20g_artis_15"] = d.brent.pct_change(20) > 0.15
    c["brent_20g_dusus_15"] = d.brent.pct_change(20) < -0.15
    c["dxy_20g_artis_2"] = d.dxy.pct_change(20) > 0.02
    c["altin_20g_artis_6"] = d.gold.pct_change(20) > 0.06
    c["tr10y_20g_artis_1.5pp"] = (d.tr10y - d.tr10y.shift(20)) > 1.5
    c["tr10y_20g_dusus_1.5pp"] = (d.tr10y - d.tr10y.shift(20)) < -1.5
    c["egri_ters (2y > 10y)"] = d.tr2y > d.tr10y
    c["abd10y_20g_artis_0.3pp"] = (d.us10y - d.us10y.shift(20)) > 0.3
    return c


def main():
    d = pull()
    d = d.dropna(subset=["xu100"])
    fwd = {h: d.xu100.shift(-h) / d.xu100 - 1 for h in (5, 20)}
    res = {"generated": datetime.now().strftime("%Y-%m-%d %H:%M"), "from": str(d.index[0].date()), "to": str(d.index[-1].date()), "n": int(len(d)), "conds": {}, "last": {}}
    conds = conditions(d)
    mid = d.index[len(d) // 2]
    print(f"{'koşul':28}{'n':>5}{'5g var':>8}{'5g yok':>8}{'20g var':>9}{'20g yok':>9}{'fark20':>8}{'t20':>6}{'y1':>7}{'y2':>7}")
    for k, m in conds.items():
        m = m.fillna(False)
        row = {"n": int(m.sum())}
        if m.sum() < 15:
            res["conds"][k] = row; continue
        for h in (5, 20):
            a, b = fwd[h][m].dropna(), fwd[h][~m].dropna()
            row[f"on{h}"] = round(float(a.mean() * 100), 2); row[f"off{h}"] = round(float(b.mean() * 100), 2)
        a20 = fwd[20][m].dropna(); b20 = fwd[20][~m].dropna()
        # örtüşen gözlem: etkin örnek ≈ n/20
        se = np.sqrt(a20.var() / max(len(a20) / 20, 1) + b20.var() / max(len(b20) / 20, 1))
        row["diff20"] = round(float((a20.mean() - b20.mean()) * 100), 2); row["t20"] = round(float((a20.mean() - b20.mean()) / se), 2) if se > 0 else 0
        h1 = fwd[20][m & (d.index <= mid)].dropna(); h2 = fwd[20][m & (d.index > mid)].dropna()
        row["y1"] = round(float(h1.mean() * 100), 2) if len(h1) > 5 else None; row["y2"] = round(float(h2.mean() * 100), 2) if len(h2) > 5 else None
        res["conds"][k] = row
        print(f"{k:28}{row['n']:>5}{row['on5']:>8}{row['off5']:>8}{row['on20']:>9}{row['off20']:>9}{row['diff20']:>8}{row['t20']:>6}{str(row['y1']):>7}{str(row['y2']):>7}")
    # birleşik risk-off sayısı (kur, vix, brent artış, dxy, altın, faiz artışı, abd faiz artışı): sonraki 20g
    flags = pd.concat([conds[k].fillna(False).astype(int) for k in ("usdtry_5g_artis_3", "vix_25_ustu", "brent_20g_artis_15", "dxy_20g_artis_2", "altin_20g_artis_6", "tr10y_20g_artis_1.5pp", "abd10y_20g_artis_0.3pp")], axis=1).sum(axis=1)
    res["count"] = {}
    for n in range(0, 5):
        m = (flags == n) if n < 4 else (flags >= 4)
        a = fwd[20][m].dropna()
        if len(a) >= 15:
            res["count"][str(n)] = {"n": int(m.sum()), "ret20": round(float(a.mean() * 100), 2), "hit": round(float((a > 0).mean() * 100), 0)}
    print("Risk-off bayrak sayısı → sonraki 20g XU100:", res["count"])
    for k in d.columns:
        res["last"][k] = round(float(d[k].iloc[-1]), 3)
    txt = json.dumps(res, ensure_ascii=False, separators=(",", ":")); assert "NaN" not in txt
    (HERE / "macro_research.json").write_text(txt, encoding="utf-8")


if __name__ == "__main__":
    main()
