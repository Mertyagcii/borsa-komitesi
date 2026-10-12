"""İleri doğrulama (walk-forward): skor ağırlıklarını/göstergeleri hep aynı geçmişte seçip aynı geçmişte sınamak aşırı uyum (overfitting) üretir.
Burada her katlamada (fold) göstergeler YALNIZCA eğitim penceresindeki verilerle seçilir (|t| ≥ 1,5, yön eğitimden gelir), sonraki
test penceresinde (görülmemiş dönem) sınanır. Eğitim ile test arasına ufuk kadar boşluk (embargo) konur (ileri bakış yok).
Karşılaştırma: WF (seçimi her katlamada yeniden yapar) | sabit (bugünkü PICK listesi; tüm örneklemle seçildiği için SIZINTILI/iyimser) |
saf (tüm göstergelerin ortalaması) | RS bazı. Sonuç: mtf_walkforward.json."""
import json
import pickle
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

from mtf_composite import PICK
from mtf_research import HOR, build, frames

HERE = Path(__file__).parent
TRAIN_MIN, TEST_LEN, WARM = 200, 60, 260


def spearman_rows(R, ex, pos):
    out = []
    for i in pos:
        a, b = R.iloc[i], ex.iloc[i]
        m = a.notna() & b.notna()
        out.append(a[m].corr(b[m].rank()) if m.sum() >= 30 else np.nan)
    return np.array(out, dtype=float)


def top10_stats(comp_by_pos, ex, pos):
    vals, hits = [], []
    for i in pos:
        a, b = comp_by_pos[i], ex.iloc[i]
        m = a.notna() & b.notna()
        if m.sum() < 40:
            continue
        r = a[m].rank(pct=True)
        t = b[m][r > 0.9]
        if len(t):
            vals.append(t.mean()); hits.append((t > 0).mean())
    return vals, hits


def summarize(vals, hits):
    if len(vals) < 3:
        return None
    v = np.array(vals)
    return {"n": int(len(v)), "top10": round(float(v.mean() * 100), 2), "hit": round(float(np.mean(hits) * 100), 1),
            "t": round(float(v.mean() / (v.std() / np.sqrt(len(v)))), 2) if v.std() > 0 else 0, "pos": round(float((v > 0).mean() * 100), 0)}


def run(data):
    f, index = frames(data)
    C, O = f["close"], f["open"]
    feats = build(f)
    n = len(C)
    res = {"generated": datetime.now().strftime("%Y-%m-%d %H:%M"), "stocks": int(C.shape[1]), "from": str(C.index[0].date()), "to": str(C.index[-1].date()),
           "train_min": TRAIN_MIN, "test_len": TEST_LEN, "tests": {}, "selected": {}, "folds": []}
    starts = list(range(WARM + TRAIN_MIN, n - TEST_LEN, TEST_LEN))
    res["folds"] = [{"test_from": str(C.index[s].date()), "test_to": str(C.index[min(s + TEST_LEN, n - 1)].date())} for s in starts]
    R = {tf: {k: v.rank(axis=1, pct=True) for k, v in feats[tf].items()} for tf in feats}
    rk = lambda df: df.rank(axis=1, pct=True)
    rs_base = (rk(C / C.rolling(252).max()) + rk(C.shift(21) / C.shift(126)) + rk(C / C.shift(21))) / 3
    def comp_w(i):
        rows = [R['haftalik'][k].iloc[i] for k in PICK['haftalik']]
        return sum(rows) / len(rows)
    exs = {}
    for tf in ("gunluk", "haftalik", "aylik"):
        h = HOR[tf]
        fwd = C.shift(-h) / O.shift(-1) - 1
        ex = fwd.sub(fwd.mean(axis=1), axis=0)
        exs[tf] = ex
        names = list(R[tf])
        ic_pos = list(range(WARM, n - h - 1, 5))
        IC = {k: spearman_rows(R[tf][k], ex, ic_pos) for k in names}
        ic_idx = np.array(ic_pos)
        out = {"wf": ([], []), "fixed": ([], []), "naive": ([], []), "rs": ([], []), "rs_cmf": ([], []), "ens_rs": ([], []), "ens_rs_w": ([], [])}
        sel_log = []
        for s in starts:
            tr = ic_idx <= s - h  # embargo
            sel, sign = [], {}
            ts = {}
            for k in names:
                x = IC[k][tr]; x = x[~np.isnan(x)]
                if len(x) < 10:
                    continue
                eff = len(x) * 5 / h if h > 5 else len(x)
                t = x.mean() / (x.std() / np.sqrt(max(eff, 2))) if x.std() > 0 else 0
                ts[k] = t
            chosen = sorted([k for k, t in ts.items() if abs(t) >= 1.5], key=lambda k: -abs(ts[k]))[:8]
            sel_log.append({k: round(float(ts[k]), 1) for k in chosen})
            test_pos = [i for i in range(s, min(s + TEST_LEN, n - h - 1)) if (i - s) % h == 0]
            if not test_pos:
                continue
            def comp(keys, signs=None, i=None):
                rows = [(R[tf][k].iloc[i] if (signs is None or signs[k] > 0) else 1 - R[tf][k].iloc[i]) for k in keys]
                return sum(rows) / len(rows)
            cw = {i: (comp(chosen, {k: np.sign(ts[k]) for k in chosen}, i) if chosen else comp(names, None, i)) for i in test_pos}
            cf = {i: comp(PICK[tf], None, i) if all(k in R[tf] for k in PICK[tf]) else comp(names, None, i) for i in test_pos}
            cn = {i: comp(names, None, i) for i in test_pos}
            for nm, cc in (("wf", cw), ("fixed", cf), ("naive", cn)):
                v, hh = top10_stats(cc, ex, test_pos)
                out[nm][0].extend(v); out[nm][1].extend(hh)
            rsp = {i: rs_base.iloc[i] for i in test_pos}
            v, hh = top10_stats(rsp, ex, test_pos)
            out["rs"][0].extend(v); out["rs"][1].extend(hh)
            # sabit (eğitimsiz) alternatifler: RS + CMF; RS + sabit bileşik; hepsi
            cmf_r = {i: R["gunluk"]["cmf20"].iloc[i] for i in test_pos}
            alt = {"rs_cmf": {i: (rsp[i] + cmf_r[i]) / 2 for i in test_pos}, "ens_rs": {i: (rsp[i] + cf[i]) / 2 for i in test_pos}}
            if tf != "haftalik":
                wk = {i: comp_w(i) for i in test_pos}
                alt["ens_rs_w"] = {i: (rsp[i] + wk[i]) / 2 for i in test_pos}
            for nm, cc in alt.items():
                v, hh = top10_stats(cc, ex, test_pos)
                out[nm][0].extend(v); out[nm][1].extend(hh)
        res["tests"][tf] = {k: summarize(*v) for k, v in out.items()}
        res["tests"][tf]["horizon"] = h
        res["selected"][tf] = sel_log
    return res


def main():
    out_file = HERE / "mtf_walkforward.json"
    old = json.loads(out_file.read_text(encoding="utf-8")) if out_file.exists() else {}
    if "core" not in old:
        old = {}  # eski biçim
    res = {"generated": datetime.now().strftime("%Y-%m-%d %H:%M"), "core": run(pickle.loads((HERE / "cache" / "ohlcv.pkl").read_bytes()))}
    wp = HERE / "cache" / "ohlcv_wide.pkl"
    if wp.exists():
        res["wide"] = run(pickle.loads(wp.read_bytes()))
    elif "wide" in old:
        res["wide"] = old["wide"]  # geniş önbellek yoksa önceki sonucu koru
    txt = json.dumps(res, ensure_ascii=False, separators=(",", ":"))
    assert "NaN" not in txt
    out_file.write_text(txt, encoding="utf-8")
    for key in ("core", "wide"):
        r = res.get(key)
        if not r:
            continue
        print(f"\nEvren: {key} ({r['stocks']} hisse), {len(r['folds'])} katlama, test {TEST_LEN} gün")
        print(f"{'dilim':10}{'yöntem':9}{'n':>4}{'top10%':>8}{'isabet':>8}{'t':>6}{'poz%':>6}")
        for tf, o in r["tests"].items():
            for nm in ("wf", "fixed", "naive", "rs", "rs_cmf", "ens_rs", "ens_rs_w"):
                e = o.get(nm)
                if e:
                    print(f"{tf:10}{nm:9}{e['n']:>4}{e['top10']:>8}{e['hit']:>8}{e['t']:>6}{e['pos']:>6}")


if __name__ == "__main__":
    main()
