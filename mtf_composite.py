"""Bileşik çok zamanlı skor testi (v2).
- Bileşik skorların dilim (decile) bazında fazla getirisi ve isabeti, kalibrasyon için dilim isabet oranları
- Olay testleri (kurulum günleri): uyumlu, haftalık lider, zayıf, toparlanan; likit alt küme; İŞLEM MALİYETİ düşülmüş net getiri
- Hazır filtre şablonlarının geçmiş testi (temel veri gerektirmeyen koşullar)
- Rejime göre (boğa/karışık/ayı) zaman dilimlerinin gücü ve rejim ağırlıkları
- Geniş evren (≈400 hisse, cache/ohlcv_wide.pkl varsa) ile dayanıklılık kontrolü
Seçim mtf_research.py çıktısına (tutarlı + anlamlı) dayanır. Sonuç mtf_composite.json'a yazılır (arayüzdeki skor kartları ve kalibrasyon bunu gösterir)."""
import json
import pickle
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

from mtf_research import HOR, build, frames
from research import evaluate_signal

HERE = Path(__file__).parent
COST = 0.5  # gidiş-dönüş % (komisyon+BSMV %0,15×2 + kayma %0,10×2)

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
    rows = {"dec": [[] for _ in range(10)], "dhit": [[] for _ in range(10)], "top10": [], "top20": [], "bot20": [], "top10_hit": [], "dates": []}
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
                rows["dhit"][d].append((v > 0).mean())
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
           "dec": [round(float(np.mean(v) * 100), 2) if v else None for v in rows["dec"]],
           "dhit": [round(float(np.mean(v) * 100), 1) if v else None for v in rows["dhit"]]}
    if rg is not None:
        for k in ("bull", "mixed", "bear"):
            s = rg == k
            out[k] = round(float(t10[s].mean() * 100), 2) if s.sum() >= 5 else None
            out[k + "_n"] = int(s.sum())
    return out


def scores(feats, C):
    """CANLI TANIM (core.js ile aynı): günlük skor = RS; haftalık = (çok göstergeli bileşik + RS)/2; aylık = aylık bileşik.
    İleri doğrulamada (mtf_walkforward.py) çok göstergeli günlük bileşik görülmemiş dönemde işe yaramadı, sade RS en iyisiydi;
    haftalık bileşik RS ile birleşince (ens_rs) istikrarlı kaldı. Eski tanımlar karşılaştırma için '_eski' ile saklanır."""
    rk = lambda df: df.rank(axis=1, pct=True)
    rs = (rk(C / C.rolling(252).max()) + rk(C.shift(21) / C.shift(126)) + rk(C / C.shift(21))) / 3
    old = {tf: comp(feats, tf) for tf in PICK}
    sc = {"gunluk": rs, "haftalik": (old["haftalik"] + rs) / 2, "aylik": old["aylik"]}
    sc["birlesik"] = 0.25 * sc["gunluk"] + 0.5 * sc["haftalik"] + 0.25 * sc["aylik"]
    sc["rs_baz"] = rs
    sc["gunluk_eski"], sc["haftalik_eski"] = old["gunluk"], old["haftalik"]
    return sc


def event_defs(sc, feats, f):
    C, H, L, V = f["close"], f["high"], f["low"], f["volume"]
    d, w, m = sc["gunluk"], sc["haftalik"], sc["aylik"]
    cmf, cmf_w = feats["gunluk"]["cmf20"], feats["haftalik"]["w_cmf10"]
    tl = (C * V).rolling(20).mean() / 1e6
    prev = C.shift()
    atrp = np.maximum(H - L, np.maximum((H - prev).abs(), (L - prev).abs())).rolling(14).mean() / C
    rvol = V / V.rolling(20).mean().shift(1)
    ev = {
        "toparlanan": (d >= 0.75) & (w >= 0.5) & (w < 0.8) & (cmf > 0),
        "haftalik_lider": w >= 0.8,
        "haftalik_lider_likit": (w >= 0.8) & (tl >= 15),
        "uyumlu": (d >= 0.6) & (w >= 0.7) & (m >= 0.6),
        "uyumlu_cmf": (d >= 0.6) & (w >= 0.7) & (m >= 0.6) & (cmf > 0),
        "zayif": w <= 0.3,
        # hazır filtre şablonları (temel veri gerektirmeyenler; yaklaşık eşleşme)
        "tpl_saglam_lider": (w >= 0.8) & (cmf >= 0) & (tl >= 15) & (feats["haftalik"]["w_dist26"] >= -0.10),
        "tpl_para_girisi": (cmf >= 0.1) & (cmf_w >= 0) & (rvol >= 1.5) & (d >= 0.6),
        "tpl_sakin_trend": (feats["haftalik"]["w_trend"] == 1) & (atrp <= 0.03) & (w >= 0.7) & (tl >= 10),
    }
    return ev


def analyze(data, light=False):
    f, index = frames(data)
    C, O = f["close"], f["open"]
    fwd = {h: C.shift(-h) / O.shift(-1) - 1 for h in (1, 2, 3, 5, 10, 20, 60)}
    m50, m200 = index.rolling(50).mean(), index.rolling(200).mean()
    regime = pd.Series(np.where((index > m50) & (m50 > m200), "bull", np.where((index < m50) & (index < m200), "bear", "mixed")), index=index.index)
    feats = build(f)
    sc = scores(feats, C)
    res = {"stocks": int(C.shape[1]), "from": str(C.index[0].date()), "to": str(C.index[-1].date()), "tests": {}, "events": {}}
    for name in ("gunluk", "haftalik", "aylik", "birlesik", "rs_baz", "gunluk_eski", "haftalik_eski"):
        res["tests"][name] = {}
        for h in ((20,) if light else (1, 2, 3, 5, 10, 20, 60)):
            res["tests"][name][str(h)] = test(sc[name], fwd[h], h, regime, name)
    for k, sig in event_defs(sc, feats, f).items():
        res["events"][k] = {}
        for h in (5, 10, 20):
            e = evaluate_signal(sig.fillna(False), fwd, regime, h)
            if e:
                e["net"] = round(e["excess"] - COST, 2)  # maliyet sonrası fazla getiri (%)
            res["events"][k][str(h)] = e
    if not light:
        # rejime göre dilim gücü (20 günlük ufuk, en iyi %10 fazla getirisi) ve ağırlıklar
        rw = {}
        for rg in ("bull", "mixed", "bear"):
            vals = {tf: (res["tests"][tf]["20"] or {}).get(rg) for tf in ("gunluk", "haftalik", "aylik")}
            n = (res["tests"]["haftalik"]["20"] or {}).get(rg + "_n", 0)
            pos = {k: max(0.0, v) if v is not None else 0.0 for k, v in vals.items()}
            tot = sum(pos.values())
            wts = {k: round(v / tot, 3) for k, v in pos.items()} if tot > 0 and n >= 8 else None
            rw[rg] = {"top10": vals, "n": int(n), "weights": wts}
        res["regime"] = rw
        res["uyum"] = {}
        for h in (5, 10, 20, 60):
            ex = fwd[h].sub(fwd[h].mean(axis=1), axis=0)
            uy = ((sc["gunluk"] >= 0.6) & (sc["haftalik"] >= 0.6) & (sc["aylik"] >= 0.6)).astype(float)
            a = ex.where(uy == 1).stack().dropna(); b = ex.where(uy == 0).stack().dropna()
            d = a.index.get_level_values(0); half = d <= d[len(d) // 2]
            res["uyum"][str(h)] = {"uyumlu": round(float(a.mean() * 100), 2), "diger": round(float(b.mean() * 100), 2), "hit": round(float((a > 0).mean() * 100), 1),
                                   "h1": round(float(a[half].mean() * 100), 2), "h2": round(float(a[~half].mean() * 100), 2)}
    return res


def load(name):
    p = HERE / "cache" / name
    return pickle.loads(p.read_bytes()) if p.exists() else None


def main():
    core = load("ohlcv.pkl")
    res = analyze(core)
    res["generated"] = datetime.now().strftime("%Y-%m-%d %H:%M")
    res["pick"] = PICK
    res["cost"] = COST
    wide = load("ohlcv_wide.pkl")
    prev = json.loads((HERE / "mtf_composite.json").read_text(encoding="utf-8")) if (HERE / "mtf_composite.json").exists() else {}
    if wide is None and "wide" in prev:
        res["wide"] = prev["wide"]  # geniş önbellek yoksa önceki sonucu koru
    if wide is not None:
        try:
            res["wide"] = analyze(wide, light=True)
        except Exception as e:  # geniş evren başarısız olursa çekirdek sonuç yine yazılır
            print("geniş evren testi başarısız:", e)
    txt = json.dumps(res, ensure_ascii=False, separators=(",", ":"))
    assert "NaN" not in txt, "NaN"
    (HERE / "mtf_composite.json").write_text(txt, encoding="utf-8")
    print(f"{'skor':10}{'ufuk':>5}{'top10%':>8}{'bot20%':>8}{'isabet':>8}{'t':>6}{'y1':>6}{'y2':>6}{'boğa':>7}{'karışık':>8}{'ayı':>7}")
    for name in ("gunluk", "haftalik", "aylik", "birlesik", "rs_baz", "gunluk_eski", "haftalik_eski"):
        for h, e in res["tests"][name].items():
            if e:
                print(f"{name:10}{h:>5}{e['top10']:>8}{e['bot20']:>8}{e['hit']:>8}{e['t']:>6}{e['h1']:>6}{e['h2']:>6}{str(e.get('bull')):>7}{str(e.get('mixed')):>8}{str(e.get('bear')):>7}")
    print("\nOlaylar (20g fazla / net / t / y1 / y2 / boğa / ayı):")
    for k, o in res["events"].items():
        e = o.get("20")
        if e:
            print(f"{k:22} n={e['n']:>5} fazla={e['excess']:>5} net={e['net']:>5} isabet={e['win']:>5} t={e['t']:>5} y1={e['h1']} y2={e['h2']} boğa={e.get('bull')} ayı={e.get('bear')}")
    print("\nRejim ağırlıkları:", json.dumps(res["regime"], ensure_ascii=False))
    if "wide" in res:
        w = res["wide"]
        print(f"\nGENİŞ EVREN ({w['stocks']} hisse):")
        for name in ("haftalik", "birlesik", "rs_baz"):
            e = w["tests"][name]["20"]
            if e:
                print(f"{name:10} 20g top10={e['top10']} bot20={e['bot20']} isabet={e['hit']} t={e['t']} y1={e['h1']} y2={e['h2']} ayı={e.get('bear')}")
        for k in ("haftalik_lider", "uyumlu", "zayif"):
            e = w["events"][k]["20"]
            if e:
                print(f"{k:16} n={e['n']} fazla={e['excess']} net={e['net']} t={e['t']} y1={e['h1']} y2={e['h2']}")


if __name__ == "__main__":
    main()
