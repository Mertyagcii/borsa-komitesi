"""Tavan/taban davranışı (günlük veri, geniş evren): tavan kapatan hissenin ertesi gün ne yaptığı, seri uzunluğuna göre.
ALINABİLİRLİK: tavan kapanışında hisse alınamaz (kuyruk). Gerçekçi soru: "ertesi açılışta tavan kilidi YOKSA (açılış tavanın altında) alırsam ne olur?" — bu da ayrıca ölçülür.
Tanım: günlük getiri ≥ %9,5 ve kapanış günün en yükseğine ≤ %0,1 yakın = tavan; ≤ −%9,5 ve kapanış en düşüğe yakın = taban.
Çıktı: limit_research.json"""
import json
import pickle
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
COST = 0.5


def load():
    for name in ("ohlcv_wide.pkl", "ohlcv.pkl"):
        p = HERE / "cache" / name
        if p.exists():
            return {k: v for k, v in pickle.loads(p.read_bytes()).items() if not k.startswith("XU")}
    raise SystemExit("cache yok")


def events(data, up=True):
    rows = []
    for name, df in data.items():
        df = df.sort_index()
        c, o, h, l = df.close, df.open, df.high, df.low
        ret = c / c.shift() - 1
        lim = (ret >= 0.095) & (c >= h * 0.999) if up else (ret <= -0.095) & (c <= l * 1.001)
        arr = lim.to_numpy(); streak = np.zeros(len(arr), int)
        for i in range(len(arr)):
            streak[i] = (streak[i - 1] + 1 if i and arr[i - 1] else 1) if arr[i] else 0
        idx = np.flatnonzero(arr)
        for i in idx:
            if i + 6 >= len(df):
                continue
            c0, o1, c1 = c.iloc[i], o.iloc[i + 1], c.iloc[i + 1]
            nxt = bool(arr[i + 1])
            locked = (o1 >= c0 * 1.09) if up else (o1 <= c0 * 0.91)  # açılışta kilit: alınamaz/satılamaz
            rows.append({"d": df.index[i], "n": name, "k": int(min(streak[i], 4)), "next_lim": nxt, "gap": o1 / c0 - 1, "c1": c1 / c0 - 1, "c5": c.iloc[i + 5] / c0 - 1,
                         "locked": bool(locked), "oc": c1 / o1 - 1, "o5": c.iloc[i + 5] / o1 - 1})
    return pd.DataFrame(rows)


def agg(df, label):
    if len(df) < 20:
        return {"label": label, "n": int(len(df))}
    ds = sorted(df.d.unique()); mid = ds[len(ds) // 2]
    return {"label": label, "n": int(len(df)), "next_lim": round(float(df.next_lim.mean() * 100), 1), "gap": round(float(df.gap.mean() * 100), 2), "c1": round(float(df.c1.mean() * 100), 2),
            "c5": round(float(df.c5.mean() * 100), 2), "hit1": round(float((df.c1 > 0).mean() * 100), 1), "locked": round(float(df.locked.mean() * 100), 1),
            "h1": round(float(df[df.d <= mid].c1.mean() * 100), 2), "h2": round(float(df[df.d > mid].c1.mean() * 100), 2)}


def tradable(df, label, col):
    """Ertesi açılışta kilit yoksa açılıştan al: açılış→ertesi kapanış ya da 5 gün sonrası; maliyet düşülür."""
    s = df[~df.locked]
    if len(s) < 20:
        return {"label": label, "n": int(len(s))}
    out = {"label": label, "n": int(len(s))}
    for k in ("oc", "o5"):
        net = s[k] - COST / 100
        dd = s.assign(net=net).groupby("d").net.mean()
        out[k + "_gross"] = round(float(s[k].mean() * 100), 2); out[k + "_net"] = round(float(net.mean() * 100), 2)
        out[k + "_hit"] = round(float((net > 0).mean() * 100), 1); out[k + "_t"] = round(float(dd.mean() / (dd.std() / np.sqrt(len(dd)))), 2) if len(dd) > 5 and dd.std() > 0 else 0
    return out


def main():
    data = load()
    res = {"generated": datetime.now().strftime("%Y-%m-%d %H:%M"), "stocks": len(data), "cost": COST, "tavan": {}, "taban": {}}
    for side, up in (("tavan", True), ("taban", False)):
        df = events(data, up)
        res[side]["total"] = int(len(df))
        res[side]["by_streak"] = {str(k): agg(df[df.k == k], f"{k}{'+' if k == 4 else ''}. gün") for k in (1, 2, 3, 4)}
        res[side]["all"] = agg(df, "Tümü")
        res[side]["tradable"] = tradable(df, "Ertesi açılışta kilit yoksa açılıştan al", "oc")
        res[side]["tradable_k1"] = tradable(df[df.k == 1], "İlk gün tavan/taban (seri başı), kilit yoksa", "oc")
        print(f"\n{side.upper()} olayı: {len(df)}")
        for k, v in res[side]["by_streak"].items():
            if v.get("next_lim") is not None:
                print(f"  seri {k}: n={v['n']} ertesi de={v['next_lim']}% açılış boşluğu={v['gap']}% ertesi kapanış={v['c1']}% 5g={v['c5']}% kilitli açılış={v['locked']}% y1/y2={v['h1']}/{v['h2']}")
        for key in ("tradable", "tradable_k1"):
            t = res[side][key]
            if "oc_net" in t:
                print(f"  {t['label']}: n={t['n']} açılış→kapanış brüt={t['oc_gross']} net={t['oc_net']} t={t['oc_t']} | açılış→5g brüt={t['o5_gross']} net={t['o5_net']} t={t['o5_t']}")
    txt = json.dumps(res, ensure_ascii=False, separators=(",", ":")); assert "NaN" not in txt
    (HERE / "limit_research.json").write_text(txt, encoding="utf-8")


if __name__ == "__main__":
    main()
