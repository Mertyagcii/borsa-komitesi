"""Mührün TEKNİK kısmının geriye dönük, ileri doğrulamalı (walk-forward) testi → tech_seal.json.

Neden: canlı mühür karnesi yavaş birikir (hüküm için haftalar). Mührün bilanço dışı (teknik) kısmı geçmişte noktasal olarak doğru yeniden kurulabilir
(bilanço verisinin geçmişi yok: geleceği bilme yanlılığı olurdu, bu yüzden kapsam dışı). Böylece "birden çok kanıtlı sinyal üst üste gelince avantaj artıyor mu?"
sorusuna beklemeden bir ilk yanıt alınır.

Yanlılığa karşı kurallar:
- SEÇİM ve SINAMA ayrıdır: bileşenler yalnızca ilk yarı örneklemde (seçim penceresi) seçilir, bileşik skor YALNIZCA ikinci yarıda (örneklem dışı) ölçülür.
- Seçimde çoklu test düzeltmesi (Benjamini-Hochberg %5); bileşen yönü seçim penceresindeki işaretten gelir.
- Örtüşmeyen gözlem: her h. günde bir örnek tarihi; hüküm gün kümelemeli (tarih başına ortalama fazla getiri).
- Kıyas: aynı gün tüm hisselerin eşit ağırlıklı ortalaması (canlı karne ile aynı); giriş = sinyal günü kapanışı (canlı karne ile aynı).
- Hayatta kalma yanlılığı: evren bugünün likit hisseleridir (düşmüş/delist olanlar yok) → mutlak getiriler iyimser olabilir; göreli (fazla getiri) sonuçlar daha az etkilenir.
Kullanım: python tech_seal.py"""
import json
import math
import statistics as S
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
OUT = HERE / "tech_seal.json"
TR = timezone(timedelta(hours=3))
HORIZONS = (5, 10, 20)


def p2(t: float) -> float:
    return math.erfc(abs(t) / math.sqrt(2))


def bh(ps, q=0.05):
    m = len(ps)
    order = sorted(range(m), key=lambda i: ps[i])
    kmax = -1
    for k, i in enumerate(order):
        if ps[i] <= q * (k + 1) / m:
            kmax = k
    return {order[k] for k in range(kmax + 1)}


def features(C: pd.DataFrame, V: pd.DataFrame) -> dict:
    r1 = C.pct_change()
    sma20, sd20 = C.rolling(20).mean(), C.rolling(20).std(ddof=0)
    sma50, sma200 = C.rolling(50).mean(), C.rolling(200).mean()
    d = C.diff()
    up, dn = d.clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean(), (-d.clip(upper=0)).ewm(alpha=1 / 14, adjust=False).mean()
    rsi = 100 - 100 / (1 + up / dn.replace(0, np.nan))
    trend = (C > sma50) & (sma50 > sma200)
    dist52 = C / C.rolling(252).max() - 1
    mom6_1, mom1 = C.shift(21) / C.shift(126) - 1, C / C.shift(21) - 1
    rk = lambda df: df.rank(axis=1, pct=True)
    comp = (rk(dist52) + rk(mom6_1) + rk(mom1)) / 3  # göreli güç bileşiği (haftalık skorun özü)
    rvol = V / V.rolling(20).mean().shift(1)
    hi20 = C.shift(1).rolling(20).max()
    return {
        "kirilim20": C > hi20,
        "yakin52": (dist52 >= -0.05) & trend,
        "rs_lider": comp >= 0.8,
        "rs_zayif": comp <= 0.2,
        "rsi30": rsi < 30,
        "bb_alt": (C - sma20) / sd20 <= -2,
        "kellogg_itis": (r1 >= 0.05) & (rvol >= 2),
        "dusus_hacim": (r1 <= -0.05) & (rvol >= 2),
        "trend": trend,
    }


LABELS = {"kirilim20": "20 günlük zirve kırılımı", "yakin52": "52 hafta zirvesine %5 içinde + trend", "rs_lider": "Göreli güç lideri (üst %20)", "rs_zayif": "Göreli güç zayıf (alt %20)",
          "rsi30": "RSI < 30 (aşırı satım)", "bb_alt": "Bollinger alt bandı", "kellogg_itis": "Günlük ≥ +%5 ve hacim ≥ 2x", "dusus_hacim": "Günlük ≤ −%5 ve hacim ≥ 2x (panik)", "trend": "Yükselen trend (SMA50 > SMA200)"}


def day_stats(rows, h):
    """rows: [(tarih, fazla getiri)] → gün kümelemeli özet (örtüşmeyen örnek tarihleri)."""
    g = {}
    for d, x in rows:
        g.setdefault(d, []).append(x)
    dm = [sum(v) / len(v) for v in g.values()]
    n = len(rows)
    if len(dm) < 3:
        return {"n": n, "days": len(dm), "mean": None, "hit": None, "t": None, "p": None}
    sd = S.stdev(dm)
    t = S.mean(dm) / (sd / math.sqrt(len(dm))) if sd > 0 else 0.0
    return {"n": n, "days": len(dm), "mean": round(S.mean([x for _, x in rows]) * 100, 3), "hit": round(sum(1 for _, x in rows if x > 0) / n * 100, 1), "t": round(t, 2), "p": p2(t)}


def build(C: pd.DataFrame, V: pd.DataFrame, min_stocks: int = 40) -> dict:
    f = features(C, V)
    n = len(C)
    mid = n // 2
    out = {"generated": datetime.now(TR).strftime("%Y-%m-%d %H:%M"), "from": str(C.index[0].date()), "to": str(C.index[-1].date()), "split": str(C.index[mid].date()), "stocks": int(C.shape[1]), "days": n,
           "note": "Seçim ilk yarıda, sınama ikinci yarıda (örneklem dışı). Evren bugünün likit hisseleri (hayatta kalma yanlılığı). Bilanço verisi geçmişte yok, bu yüzden yalnızca teknik bileşenler.",
           "labels": LABELS}
    res = {}

    def comp_rows(sig, ex, idxs):
        rows = []
        for i in idxs:
            m = sig.iloc[i].fillna(False).to_numpy(dtype=bool) & ex.iloc[i].notna().to_numpy()
            rows += [(i, float(x)) for x in ex.iloc[i].to_numpy()[m]]
        return rows

    for h in HORIZONS:
        fwd = C.shift(-h) / C - 1
        ex = fwd.sub(fwd.mean(axis=1), axis=0)
        idx = [i for i in range(0, n - h, h) if ex.iloc[i].notna().sum() >= min_stocks]  # örtüşmeyen örnek tarihleri
        sel = [i for i in idx if i < mid - h]
        oos = [i for i in idx if i >= mid]
        # 1) bileşen tablosu: seçim yarısı / sınama yarısı (örneklem dışı) / tüm örneklem; hepsi gün kümelemeli
        comps = {}
        for k, sig in f.items():
            comps[k] = {"sel": day_stats(comp_rows(sig, ex, sel), h), "oos": day_stats(comp_rows(sig, ex, oos), h), "full": day_stats(comp_rows(sig, ex, idx), h)}
        ks = [k for k in comps if comps[k]["sel"]["p"] is not None]
        keep = bh([comps[k]["sel"]["p"] for k in ks])
        strict = {k: (1 if comps[k]["sel"]["mean"] > 0 else -1) for i, k in enumerate(ks) if i in keep}
        # sınama yarısında bileşenler arası çoklu test düzeltmesi (hepsi önceden listelenmiş 9 aday)
        ko = [k for k in comps if comps[k]["oos"]["p"] is not None]
        kok = bh([comps[k]["oos"]["p"] for k in ko])
        for j, k in enumerate(ko):
            comps[k]["oos"]["fdr"] = j in kok
        for k in comps:
            for w in ("sel", "oos", "full"):
                if comps[k][w]["p"] is not None:
                    comps[k][w]["p"] = round(comps[k][w]["p"], 5)
        # 2) SINAMA: bileşik skor (yalnızca ikinci yarıda). İki sürüm: sıkı seçim (BH geçenler) ve işaret (hepsi, yön = seçim yarısındaki işaret; anlamlılık şartı yok)
        sign_only = {k: (1 if comps[k]["sel"]["mean"] > 0 else -1) for k in ks}

        def oos_composite(chosen):
            if not chosen:
                return {"components": {}, "buckets": {}, "ic": {"mean": None, "n": 0, "t": None}}
            buckets, ics = {}, []
            for i in oos:
                s = pd.Series(0.0, index=C.columns)
                for k, d in chosen.items():
                    s = s + d * f[k].iloc[i].fillna(False).astype(float)
                e = ex.iloc[i]
                m = e.notna()
                if m.sum() < min_stocks:
                    continue
                lab = s[m].clip(-1, 3)
                for name, mask in (("≤ −1", lab <= -1), ("0", lab == 0), ("1", lab == 1), ("2", lab == 2), ("≥ 3", lab >= 3)):
                    for x in e[m][mask].to_numpy():
                        buckets.setdefault(name, []).append((i, float(x)))
                if s[m].nunique() > 2:
                    ics.append(float(s[m].rank().corr(e[m].rank())))
            bst = {k: day_stats(v, h) for k, v in buckets.items()}
            kb = [k for k, st in bst.items() if st["p"] is not None]
            kk = bh([bst[k]["p"] for k in kb])
            for j, k in enumerate(kb):
                bst[k]["fdr"] = j in kk
            for st in bst.values():
                st["p"] = None if st["p"] is None else round(st["p"], 5)
            return {"components": {k: d for k, d in chosen.items()}, "buckets": bst, "ic": icsum(ics)}

        ic_rs = []
        for i in oos:
            e = ex.iloc[i]
            m = e.notna()
            c = f["rs_lider"].iloc[i].fillna(False).astype(float) - f["rs_zayif"].iloc[i].fillna(False).astype(float)
            if m.sum() >= min_stocks and c[m].nunique() > 1:
                ic_rs.append(float(c[m].rank().corr(e[m].rank())))
        res[str(h)] = {"sel_days": len(sel), "oos_days": len(oos), "components": comps, "strict": oos_composite(strict), "sign": oos_composite(sign_only), "ic_rs_only": icsum(ic_rs)}
    out["h"] = res
    return out


def icsum(a):
    if len(a) < 3:
        return {"mean": None, "n": len(a), "t": None}
    sd = S.stdev(a)
    return {"mean": round(S.mean(a), 4), "n": len(a), "t": round(S.mean(a) / (sd / math.sqrt(len(a))), 2) if sd > 0 else None}


def main() -> None:
    oh = json.loads((HERE / "ohlcv.json").read_text(encoding="utf-8"))
    idx = pd.to_datetime(oh["dates"])
    C = pd.DataFrame({k: v["c"] for k, v in oh["stocks"].items()}, index=idx).astype(float)
    V = pd.DataFrame({k: v["v"] for k, v in oh["stocks"].items()}, index=idx).astype(float)
    res = build(C, V)
    OUT.write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for h, r in res["h"].items():
        print(f"\n== {h} iş günü | seçim tarihleri {r['sel_days']}, sınama (örneklem dışı) tarihleri {r['oos_days']}")
        for k, c in r["components"].items():
            s, o, fu = c["sel"], c["oos"], c["full"]
            print(f"   {k:13s} seçim: ort {s['mean']} t={s['t']} | SINAMA: ort {o['mean']} t={o['t']} fdr={o.get('fdr')} n={o['n']} gün={o['days']} | tümü t={fu['t']}")
        for v in ("strict", "sign"):
            x = r[v]
            print(f"   [{v}] bileşenler {x['components']} | IC {x['ic']}")
            for k, st in x["buckets"].items():
                print(f"        skor {k:>5}: n={st['n']:5d} gün={st['days']:3d} ort fazla %{st['mean']} isabet %{st['hit']} t={st['t']} fdr={st.get('fdr')}")
        print("   IC (yalnız RS, sınama):", r["ic_rs_only"])

if __name__ == "__main__":
    main()
