"""Çok zamanlı (günlük / haftalık / aylık) gösterge araştırması.

Soru: TradingView'deki hangi göstergeler, hangi zaman diliminde, BIST'te bir sonraki dönemde piyasa ortalamasından fazla getiri öngörüyor?
Her gösterge hisseler arası sıralanır (cross-section) ve ufka göre ölçülür: günlük → 5 gün, haftalık → 20 gün, aylık → 60 gün.
Ölçüt: Spearman IC (sıralama korelasyonu), en iyi %20 − en kötü %20 farkı, yarı-yarıya tutarlılık, boğa/ayı kırılımı.
Veri: cache/ohlcv.pkl (research.py ile aynı; ertesi gün açılıştan giriş). Uyarı: hayatta kalma yanlılığı, tek rejim; sonuçlar ipucudur.
Çıktı: mtf_research.json (skor ağırlıkları bunlara göre seçilir).
"""
import json
import pickle
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

from research import frames, rsi

HERE = Path(__file__).parent
OUT = HERE / "mtf_research.json"
HOR = {"gunluk": 5, "haftalik": 20, "aylik": 60}


def ema(x, n):
    return x.ewm(span=n, adjust=False).mean()


def macd_hist(c, a=12, b=26, s=9):
    m = ema(c, a) - ema(c, b)
    return m - ema(m, s)


def cmf(H, L, C, V, n=20):
    mfm = ((C - L) - (H - C)) / (H - L).replace(0, np.nan)
    return (mfm * V).rolling(n).sum() / V.rolling(n).sum()


def mfi(H, L, C, V, n=14):
    tp = (H + L + C) / 3
    mf = tp * V
    pos = mf.where(tp > tp.shift(), 0).rolling(n).sum()
    neg = mf.where(tp < tp.shift(), 0).rolling(n).sum()
    return 100 - 100 / (1 + pos / neg.replace(0, np.nan))


def adx_di(H, L, C, n=14):
    up, dn = H.diff(), -L.diff()
    pdm, mdm = up.where((up > dn) & (up > 0), 0), dn.where((dn > up) & (dn > 0), 0)
    tr = np.maximum(H - L, np.maximum((H - C.shift()).abs(), (L - C.shift()).abs()))
    atr = tr.ewm(alpha=1 / n, adjust=False).mean()
    pdi, mdi = 100 * pdm.ewm(alpha=1 / n, adjust=False).mean() / atr, 100 * mdm.ewm(alpha=1 / n, adjust=False).mean() / atr
    dx = 100 * (pdi - mdi).abs() / (pdi + mdi).replace(0, np.nan)
    return dx.ewm(alpha=1 / n, adjust=False).mean(), pdi - mdi


def obv_slope(C, V, n=20):
    obv = (np.sign(C.diff()).fillna(0) * V).cumsum()
    return (obv - obv.shift(n)) / V.rolling(n).sum().replace(0, np.nan)


def stoch(H, L, C, n=14):
    return (C - L.rolling(n).min()) / (H.rolling(n).max() - L.rolling(n).min()).replace(0, np.nan)


def weekly_to_daily(df_w, idx):
    """Haftalık göstergeleri günlüğe taşı: yalnızca tamamlanmış haftalar kullanılır (ileri bakış yok)."""
    return df_w.shift(1).reindex(idx, method="ffill")


def build(f):
    O, H, L, C, V = f["open"], f["high"], f["low"], f["close"], f["volume"]
    idx = C.index
    feats = {"gunluk": {}, "haftalik": {}, "aylik": {}}
    g = feats["gunluk"]
    g["rsi14_ters"] = -rsi(C)  # aşırı satım yüksek skor
    g["rsi14"] = rsi(C)
    g["macd_hist"] = macd_hist(C) / C
    g["stoch14"] = stoch(H, L, C)
    g["cmf20"] = cmf(H, L, C, V, 20)
    g["mfi14"] = mfi(H, L, C, V, 14)
    g["obv20"] = obv_slope(C, V, 20)
    g["rvol"] = V / V.rolling(20).mean().shift(1)
    g["dmi14"] = adx_di(H, L, C)[1]
    g["ret5"] = C / C.shift(5) - 1
    g["ret5_ters"] = -(C / C.shift(5) - 1)
    g["gun_close_pos"] = (C - L) / (H - L).replace(0, np.nan)
    g["sma20_uzak"] = C / C.rolling(20).mean() - 1
    g["bb_pos"] = (C - C.rolling(20).mean()) / (2 * C.rolling(20).std(ddof=0))
    # haftalık
    W = {k: v.resample("W-FRI").agg(a).dropna(how="all") for k, v, a in
         [("o", O, "first"), ("h", H, "max"), ("l", L, "min"), ("c", C, "last"), ("v", V, "sum")]}
    wc, wh, wl, wv = W["c"], W["h"], W["l"], W["v"]
    w = {}
    w["w_rsi14"] = rsi(wc)
    w["w_macd_hist"] = macd_hist(wc) / wc
    w["w_sma10_uzak"] = wc / wc.rolling(10).mean() - 1
    w["w_sma30_uzak"] = wc / wc.rolling(30).mean() - 1
    w["w_trend"] = ((wc > wc.rolling(10).mean()) & (wc.rolling(10).mean() > wc.rolling(30).mean())).astype(float).where(wc.rolling(30).mean().notna())
    w["w_cmf10"] = cmf(wh, wl, wc, wv, 10)
    w["w_mfi14"] = mfi(wh, wl, wc, wv, 14)
    w["w_obv10"] = obv_slope(wc, wv, 10)
    w["w_adx"], w["w_dmi"] = adx_di(wh, wl, wc)
    w["w_ret13"] = wc / wc.shift(13) - 1
    w["w_ret26"] = wc / wc.shift(26) - 1
    w["w_dist26"] = wc / wc.rolling(26).max() - 1
    w["w_vol_trend"] = wv.rolling(4).mean() / wv.rolling(26).mean()
    w["w_stoch"] = stoch(wh, wl, wc, 14)
    w["w_rsi_ters"] = -rsi(wc)
    for k, v in w.items():
        feats["haftalik"][k] = weekly_to_daily(v, idx)
    # aylık (≈21 işlem günü): ay sonu çubukları
    M = {k: v.resample("ME").agg(a).dropna(how="all") for k, v, a in
         [("h", H, "max"), ("l", L, "min"), ("c", C, "last"), ("v", V, "sum")]}
    mc, mh, ml, mv = M["c"], M["h"], M["l"], M["v"]
    m = {}
    m["m_rsi14"] = rsi(mc)
    m["m_macd_hist"] = macd_hist(mc) / mc
    m["m_mom12_1"] = mc.shift(1) / mc.shift(12) - 1
    m["m_mom6"] = mc / mc.shift(6) - 1
    m["m_sma10_uzak"] = mc / mc.rolling(10).mean() - 1
    m["m_cmf6"] = cmf(mh, ml, mc, mv, 6)
    m["m_obv6"] = obv_slope(mc, mv, 6)
    m["m_adx"], m["m_dmi"] = adx_di(mh, ml, mc)
    m["m_dist12"] = mc / mc.rolling(12).max() - 1
    m["m_lowvol"] = -mc.pct_change().rolling(12).std()
    for k, v in m.items():
        feats["aylik"][k] = weekly_to_daily(v, idx)
    # uzun günlük karşılıkları (aylık ufuk için)
    a = feats["aylik"]
    a["d_dist52"] = C / C.rolling(252).max() - 1
    a["d_trend_200"] = ((C > C.rolling(50).mean()) & (C.rolling(50).mean() > C.rolling(200).mean())).astype(float).where(C.rolling(200).mean().notna())
    a["d_cmf120"] = cmf(H, L, C, V, 120)
    a["d_obv120"] = obv_slope(C, V, 120)
    a["d_mom6_1"] = C.shift(21) / C.shift(126) - 1
    return feats


def evaluate(fac, fwd_h, h, regime, cut=None):
    ex = fwd_h.sub(fwd_h.mean(axis=1), axis=0)
    rows, ics, spreads, dates = [], [], [], []
    step = min(h, 20)
    for i in range(260, len(fac), step):
        a, b = fac.iloc[i], ex.iloc[i]
        mk = a.notna() & b.notna()
        if mk.sum() < 30:
            continue
        r = a[mk].rank(pct=True)
        ics.append(a[mk].rank().corr(b[mk].rank()))
        spreads.append(b[mk][r >= 0.8].mean() - b[mk][r <= 0.2].mean())
        dates.append(fac.index[i])
    if len(ics) < 10:
        return None
    ics, spreads = np.array(ics), np.array(spreads)
    mid = len(ics) // 2
    t = ics.mean() / (ics.std() / np.sqrt(len(ics) * step / h)) if ics.std() > 0 else 0  # örtüşen gözlem: etkin örnek küçültülür
    out = {"n": len(ics), "ic": round(float(ics.mean()), 3), "t": round(float(t), 2), "spread": round(float(spreads.mean() * 100), 2),
           "pos": round(float((ics > 0).mean() * 100), 0), "ic1": round(float(ics[:mid].mean()), 3), "ic2": round(float(ics[mid:].mean()), 3)}
    if regime is not None:
        rg = regime.reindex(dates).to_numpy()
        for k in ("bull", "bear"):
            sel = rg == k
            out["ic_" + k] = round(float(ics[sel].mean()), 3) if sel.sum() >= 5 else None
    return out


def main():
    data = pickle.loads((HERE / "cache" / "ohlcv.pkl").read_bytes())
    f, index = frames(data)
    C, O = f["close"], f["open"]
    entry = O.shift(-1)
    fwd = {h: C.shift(-h) / entry - 1 for h in set(HOR.values())}
    regime = None
    if index is not None:
        m50, m200 = index.rolling(50).mean(), index.rolling(200).mean()
        regime = pd.Series(np.where((index > m50) & (m50 > m200), "bull", np.where((index < m50) & (index < m200), "bear", "mixed")), index=index.index)
    feats = build(f)
    res = {"generated": datetime.now().strftime("%Y-%m-%d %H:%M"), "stocks": int(C.shape[1]), "from": str(C.index[0].date()), "to": str(C.index[-1].date()), "horizons": HOR, "tests": {}}
    for tf, fs in feats.items():
        h = HOR[tf]
        res["tests"][tf] = {}
        print(f"\n=== {tf.upper()} (ufuk {h} gün) ===")
        print(f"{'gösterge':18}{'n':>5}{'IC':>8}{'t':>7}{'spread%':>9}{'pozitif%':>9}{'IC yarı1':>9}{'IC yarı2':>9}{'IC boğa':>9}{'IC ayı':>8}")
        for k, v in fs.items():
            e = evaluate(v, fwd[h], h, regime)
            res["tests"][tf][k] = e
            if e:
                print(f"{k:18}{e['n']:>5}{e['ic']:>8}{e['t']:>7}{e['spread']:>9}{e['pos']:>9}{e['ic1']:>9}{e['ic2']:>9}{str(e.get('ic_bull')):>9}{str(e.get('ic_bear')):>8}")
    OUT.write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return res, feats, fwd, regime


if __name__ == "__main__":
    main()
