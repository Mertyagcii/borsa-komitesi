"""Bebek hisse (yeni halka arz) araştırması: halka arzdan sonra fiyat yolu ve koşullu ileri getiri.
Veri: cache/ohlcv_wide.pkl (≈360 hisse, 800 gün). Penceredeki halka arzlar = serisi pencere başlangıcından sonra başlayan hisseler.
Çıktı: ipo_research.json (arayüzdeki Bebek Hisseler taraması hangi koşulun kanıtlı/kanıtsız olduğunu buradan okur). UYARI: örnek küçüktür (onlarca hisse)."""
import json
import pickle
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

from research import frames

HERE = Path(__file__).parent
COST = 0.5


def main():
    data = pickle.loads((HERE / "cache" / "ohlcv_wide.pkl").read_bytes())
    ip = HERE / "cache" / "ohlcv_ipo.pkl"
    if ip.exists():  # geçmişi kısa (son ~2 yıl) halka arzlar da dahil edilir
        data.update(pickle.loads(ip.read_bytes()))
    f, index = frames(data)
    C, O, H, V = f["close"], f["open"], f["high"], f["volume"]
    start = C.index[0]
    ipos = [n for n in C.columns if C[n].first_valid_index() is not None and C[n].first_valid_index() > start + pd.Timedelta(days=15)]
    res = {"generated": datetime.now().strftime("%Y-%m-%d %H:%M"), "n_ipo": len(ipos), "profile": {}, "cond": {}}
    # 1) halka arz sonrası fiyat yolu: ilk kapanışa göre (gün 1 = ilk işlem günü kapanışı)
    paths = {}
    for n in ipos:
        s = C[n].dropna()
        if len(s) < 6:
            continue
        paths[n] = (s / s.iloc[0]).reset_index(drop=True)
    P = pd.DataFrame(paths)
    for d in (2, 5, 10, 20, 40, 60, 120, 180):
        row = P.iloc[d - 1].dropna() if len(P) >= d else pd.Series(dtype=float)
        if len(row) >= 8:
            res["profile"][str(d)] = {"n": int(len(row)), "median": round(float((row.median() - 1) * 100), 1), "mean": round(float((row.mean() - 1) * 100), 1), "above": round(float((row > 1).mean() * 100), 0)}
    # tavan serisi: ilk günlerde art arda tavan
    tav = []
    for n in ipos:
        s = C[n].dropna(); r = s.pct_change().dropna()
        k = 0
        for v in r.iloc[:15]:
            if v >= 0.095:
                k += 1
            else:
                break
        tav.append(k)
    res["tavan_serisi"] = {"ortalama_gun": round(float(np.mean(tav)), 1), "en_az_1": int(sum(1 for k in tav if k >= 1)), "en_az_3": int(sum(1 for k in tav if k >= 3)), "n": len(tav)}
    # 2) koşullu ileri getiri (20 gün, ertesi açılıştan giriş, evrene göre fazla getiri), yaş dilimleri ve koşullar
    fwd = C.shift(-20) / O.shift(-1) - 1
    ex = fwd.sub(fwd.mean(axis=1), axis=0)
    rows = []
    for n in ipos:
        s = C[n]; fv = s.first_valid_index(); i0 = C.index.get_loc(fv)
        hi = s.expanding().max(); rs = (s / s.shift(21) - 1)
        for k in range(20, len(C) - 21):
            i = i0 + k
            if i >= len(C) - 21 or np.isnan(s.iloc[i]) or np.isnan(ex[n].iloc[i]):
                continue
            rows.append({"n": n, "d": C.index[i], "age": k, "dd": s.iloc[i] / hi.iloc[i] - 1, "mom": rs.iloc[i], "above_first": s.iloc[i] / s.iloc[i0] - 1, "ex": ex[n].iloc[i],
                         "tl": (s.iloc[i] * V[n].iloc[i]) / 1e6})
    df = pd.DataFrame(rows)
    def stat(sub, label):
        if len(sub) < 40:
            return {"label": label, "n": int(len(sub))}
        dd = sub.groupby("d").ex.mean()
        return {"label": label, "n": int(len(sub)), "hisse": int(sub.n.nunique()), "excess": round(float(sub.ex.mean() * 100), 2), "net": round(float(sub.ex.mean() * 100 - COST), 2),
                "hit": round(float((sub.ex > 0).mean() * 100), 1), "t": round(float(dd.mean() / (dd.std() / np.sqrt(len(dd)))), 2) if len(dd) > 5 and dd.std() > 0 else 0}
    if len(df):
        G = {"Tüm bebek hisse-günleri (20-250 gün yaşında)": df, "Yaş 20-60 gün": df[df.age < 60], "Yaş 60-120 gün": df[(df.age >= 60) & (df.age < 120)], "Yaş 120-250 gün": df[df.age >= 120],
             "İlk fiyatın altında": df[df.above_first < 0], "İlk fiyatın üstünde": df[df.above_first >= 0], "Zirveden ≥ %40 düşmüş": df[df.dd <= -0.4], "Zirveden < %20 düşmüş": df[df.dd > -0.2],
             "Aylık momentum > 0": df[df.mom > 0], "Aylık momentum < 0": df[df.mom < 0], "Momentum > 0 ve zirveye yakın (<%20)": df[(df.mom > 0) & (df.dd > -0.2)]}
        for k, v in G.items():
            res["cond"][k] = stat(v, k)
    # hisse bazlı liste: ilk işlem günü, ilk kapanış, tavan serisi, ilk kapanışa göre 5/20/60. gün ve bugün
    stocks = {}
    for n in ipos:
        s = C[n].dropna()
        if len(s) < 3:
            continue
        r = s.pct_change().dropna(); k = 0
        for v in r.iloc[:20]:
            if v >= 0.095:
                k += 1
            else:
                break
        at = lambda d: round(float((s.iloc[d - 1] / s.iloc[0] - 1) * 100), 1) if len(s) >= d else None
        stocks[n] = {"d": str(s.index[0].date()), "c0": round(float(s.iloc[0]), 4), "tavan": k, "r5": at(5), "r20": at(20), "r60": at(60), "now": round(float((s.iloc[-1] / s.iloc[0] - 1) * 100), 1), "n": int(len(s))}
    res["stocks"] = stocks
    txt = json.dumps(res, ensure_ascii=False, separators=(",", ":")); assert "NaN" not in txt
    (HERE / "ipo_research.json").write_text(txt, encoding="utf-8")
    print(f"{len(ipos)} halka arz; tavan serisi: {res['tavan_serisi']}")
    print("Fiyat yolu (ilk kapanışa göre):")
    for d, v in res["profile"].items():
        print(f"  gün {d:>3}: n={v['n']} medyan {v['median']}% ortalama {v['mean']}% üstünde kalan %{v['above']}")
    print("Koşullu 20g fazla getiri:")
    for k, v in res["cond"].items():
        if "excess" in v:
            print(f"  {k[:50]:52} n={v['n']:>5} hisse={v['hisse']:>3} fazla={v['excess']:>6} net={v['net']:>6} isabet={v['hit']:>5} t={v['t']:>5}")
        else:
            print(f"  {k[:50]:52} n={v['n']} (yetersiz)")


if __name__ == "__main__":
    main()
