"""Bileşik çok zamanlı skor testi: seçilen göstergelerin sıralama ortalaması, dilim (decile) ve en iyi %10/%20 grubunun isabeti.
Seçim, mtf_research.py'nin çıktısına (tutarlı + anlamlı) dayanır; burada bileşiğin ve zaman dilimlerinin birleşiminin değeri ölçülür.
Sonuç mtf_composite.json'a yazılır (arayüzdeki skor kartlarında beklenen fazla getiri/isabet olarak gösterilir)."""
import json
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

from mtf_research import HOR, build, frames, pickle

HERE = Path(__file__).parent

# her zaman dilimi için seçilen göstergeler (araştırmada anlamlı + iki yarıda aynı yönde)
PICK = {
    "gunluk": ["cmf20", "rsi14", "dmi14", "sma20_uzak", "obv20"],
    "haftalik": ["w_trend", "w_dist26", "w_sma30_uzak", "w_dmi", "w_rsi14", "w_obv10", "w_ret26"],
    "aylik": ["d_trend_200", "d_dist52", "d_obv120", "d_mom6_1"],
}


def comp(feats, tf):
    ranks = [feats[tf][k].rank(axis=1, pct=True) for k in PICK[tf]]
    return sum(ranks) / len(ranks)


def test(score, fwd_h, h, regime, label):
    ex = fwd_h.sub(fwd_h.mean(axis=1), axis=0)
    step = min(h, 20)
    rows = {"dec": [[] for _ in range(10)], "top10": [], "top20": [], "bot20": [], "top10_hit": [], "dates": []}
    for i in range(260, len(score), step):
        a, b = score.iloc[i], ex.iloc[i]
        m = a.notna() & b.notna()
        if m.sum() < 40:
            continue
        r = a[m].rank(pct=True)
        q = np.minimum((r * 10).astype(int), 9)
        for d in range(10):
            v = b[m][q == d]
            if len(v):
                rows["dec"][d].append(v.mean())
        t10, t20, b20 = b[m][r > 0.9], b[m][r > 0.8], b[m][r <= 0.2]
        rows["top10"].append(t10.mean()); rows["top20"].append(t20.mean()); rows["bot20"].append(b20.mean())
        rows["top10_hit"].append((t10 > 0).mean()); rows["dates"].append(score.index[i])
    n = len(rows["top10"])
    if n < 10:
        return None
    t10, hit = np.array(rows["top10"]), np.array(rows["top10_hit"])
    mid = n // 2
    rg = regime.reindex(rows["dates"]).to_numpy() if regime is not None else None
    out = {"label": label, "n": n, "top10": round(float(t10.mean() * 100), 2), "top20": round(float(np.mean(rows["top20"]) * 100), 2),
           "bot20": round(float(np.mean(rows["bot20"]) * 100), 2), "hit": round(float(hit.mean() * 100), 1),
           "h1": round(float(t10[:mid].mean() * 100), 2), "h2": round(float(t10[mid:].mean() * 100), 2),
           "t": round(float(t10.mean() / (t10.std() / np.sqrt(n * step / h))), 2) if t10.std() > 0 else 0,
           "dec": [round(float(np.mean(v) * 100), 2) if v else None for v in rows["dec"]]}
    if rg is not None:
        for k in ("bull", "bear"):
            s = rg == k
            out[k] = round(float(t10[s].mean() * 100), 2) if s.sum() >= 5 else None
    return out


def main():
    data = pickle.loads((HERE / "cache" / "ohlcv.pkl").read_bytes())
    f, index = frames(data)
    C, O = f["close"], f["open"]
    fwd = {h: C.shift(-h) / O.shift(-1) - 1 for h in set(HOR.values())}
    m50, m200 = index.rolling(50).mean(), index.rolling(200).mean()
    regime = pd.Series(np.where((index > m50) & (m50 > m200), "bull", np.where((index < m50) & (index < m200), "bear", "mixed")), index=index.index)
    feats = build(f)
    sc = {tf: comp(feats, tf) for tf in PICK}
    # birleşik: haftalık ağırlıklı (kanıt en güçlü orada), günlük ve aylık destek
    sc["birlesik"] = 0.25 * sc["gunluk"] + 0.5 * sc["haftalik"] + 0.25 * sc["aylik"]
    # uyum: üç zaman diliminin hepsi ilk %40'ta
    sc["uyum"] = ((sc["gunluk"] >= 0.6) & (sc["haftalik"] >= 0.6) & (sc["aylik"] >= 0.6)).astype(float)
    # baz çizgisi: mevcut RS bileşimi
    rk = lambda df: df.rank(axis=1, pct=True)
    sc["rs_baz"] = (rk(C / C.rolling(252).max()) + rk(C.shift(21) / C.shift(126)) + rk(C / C.shift(21))) / 3
    for hh in (5, 10, 20):
        fwd.setdefault(hh, C.shift(-hh) / O.shift(-1) - 1)
    res = {"generated": datetime.now().strftime("%Y-%m-%d %H:%M"), "stocks": int(C.shape[1]), "from": str(C.index[0].date()), "to": str(C.index[-1].date()), "pick": PICK, "tests": {}}
    print(f"{'skor':10}{'ufuk':>5}{'n':>4}{'top10%':>8}{'top20%':>8}{'bot20%':>8}{'isabet%':>8}{'t':>6}{'yarı1':>7}{'yarı2':>7}{'boğa':>7}{'ayı':>7}")
    for name in ("gunluk", "haftalik", "aylik", "birlesik", "rs_baz"):
        res["tests"][name] = {}
        for h in (5, 10, 20, 60):
            if h not in fwd:
                fwd[h] = C.shift(-h) / O.shift(-1) - 1
            e = test(sc[name], fwd[h], h, regime, name)
            res["tests"][name][str(h)] = e
            if e:
                print(f"{name:10}{h:>5}{e['n']:>4}{e['top10']:>8}{e['top20']:>8}{e['bot20']:>8}{e['hit']:>8}{e['t']:>6}{e['h1']:>7}{e['h2']:>7}{str(e.get('bull')):>7}{str(e.get('bear')):>7}")
    # uyum filtresi: üç zaman dilimi uyumlu hisselerin fazla getirisi
    print("\nUyum (üç zaman dilimi birlikte güçlü) vs diğerleri, ortalama fazla getiri %:")
    res["uyum"] = {}
    for h in (5, 10, 20, 60):
        ex = fwd[h].sub(fwd[h].mean(axis=1), axis=0)
        a = ex.where(sc["uyum"] == 1).stack().dropna(); b = ex.where(sc["uyum"] == 0).stack().dropna()
        d = a.index.get_level_values(0)
        half = d <= d[len(d) // 2]
        res["uyum"][str(h)] = {"n_gun_hisse": int(len(a)), "uyumlu": round(float(a.mean() * 100), 2), "diger": round(float(b.mean() * 100), 2), "hit": round(float((a > 0).mean() * 100), 1),
                               "h1": round(float(a[half].mean() * 100), 2), "h2": round(float(a[~half].mean() * 100), 2)}
        print(h, res["uyum"][str(h)])
    # olay testleri: kurulum günleri (hisse-gün) ve sonraki fazla getiri; research.evaluate_signal ile aynı yöntem (seyreltilmiş, t, yarılar, rejim)
    from research import evaluate_signal
    d, w, m = sc["gunluk"], sc["haftalik"], sc["aylik"]
    cmf = feats["gunluk"]["cmf20"]
    events = {
        "toparlanan": (d >= 0.75) & (w >= 0.5) & (w < 0.8) & (cmf > 0),
        "toparlanan_siki": (d >= 0.85) & (w >= 0.5) & (w < 0.8) & (cmf > 0.05) & (m >= 0.4),
        "haftalik_lider": w >= 0.8,
        "uyumlu": (d >= 0.6) & (w >= 0.7) & (m >= 0.6),
        "uyumlu_cmf": (d >= 0.6) & (w >= 0.7) & (m >= 0.6) & (cmf > 0),
        "zayif": w <= 0.3,
    }
    res["events"] = {}
    print("\nOlay testleri (fazla getiri %, t, ilk/ikinci yarı, boğa/ayı):")
    for k, sig in events.items():
        res["events"][k] = {}
        for h in (5, 10, 20):
            e = evaluate_signal(sig.fillna(False), fwd, regime, h) if h in fwd else None
            res["events"][k][str(h)] = e
            if e:
                print(f"{k:18}{h:>4}g n={e['n']:>5} fazla={e['excess']:>6} isabet={e['win']:>5} t={e['t']:>5} y1={e['h1']} y2={e['h2']} boga={e.get('bull')} ayi={e.get('bear')}")
    from mtf_research import json as _j
    txt = json.dumps(res, ensure_ascii=False, separators=(",", ":"))
    assert "NaN" not in txt, "NaN"
    (HERE / "mtf_composite.json").write_text(txt, encoding="utf-8")


if __name__ == "__main__":
    main()
