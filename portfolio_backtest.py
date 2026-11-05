"""Portföy düzeyinde geriye dönük test (rejim kırılımlı) + portföy olasılık konisi -> portfolio_backtest.json.

Soru 1 (rejim): Göreceli güç (RS) lideri 10 hissenin eşit ağırlıklı portföyü, boğa / geçiş / ayı rejiminde evrenin eşit ağırlıklı ortalamasını
5/10/20 günde yeniliyor mu? (Ayı rejiminin adaylara "yumuşak bayrak" koyması kanıta dayanıyor mu?)
Soru 2 (koni): Portföyün 20 günlük getiri aralığı, hisselerin KORELASYONU hesaba katılınca daha doğru mu? Rejim bazında kapsama.

Yöntem (kural tabanlı, LLM yok, ileriye sızıntı yok):
- Rejim tarihi t: BIST 100 kapanışı ile 50/200 gün ortalaması (core.js computeRegime ile aynı kural): son>m50>m200 boğa; son<m50 ve son<m200 ayı; diğer geçiş.
- RS: 52 hafta zirvesine yakınlık + 6 ay + 1 ay getirinin evren içi yüzdelik ortalaması (core.js rankUniverse bileşimi). Yalnız t'ye kadar veri.
- Her 5 işlem gününde bir t; portföy = RS en yüksek 10 hisse, eşit ağırlık, al-tut h gün. Kıyas: aynı t'de tüm evrenin eşit ağırlığı.
- Kesişen pencereler bağımsız değildir: etkin örneklem = n * 5 / h; t-istatistiği buna göre.
- Koni: portföy oynaklığı = sqrt(w' S w), S = hisse oynaklıkları (forecast.sigma_series) + son 250 günlük korelasyon. Üç varyant: korelasyonlu (gerçek),
  bağımsız (çeşitlenme abartılı), tam bağlı (hiç çeşitlenme yok). Ölçek k ilk yarıda seçilir, ikinci yarıda sınanır.
Sınırlar: fiyat getirisi (temettü yok), evren bugünün likit hisseleri (hayatta kalma yanlılığı: geçmiş getiriler iyimser), gerçek komite/zaman skoru geçmişi yok,
bu yüzden RS vekil strateji kullanılır; işlem maliyeti 20 günlükte tur başına %0,30 (net sütun) varsayılır.
Kullanım: python portfolio_backtest.py"""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from forecast import sigma_series

HERE = Path(__file__).parent
OUT = HERE / "portfolio_backtest.json"
TR = timezone(timedelta(hours=3))
TOPN = 10
STEP = 5
HZ = (5, 10, 20)
COST20 = 0.003
WARM = 252
REG = ("bull", "mixed", "bear")
REG_TR = {"bull": "Boğa", "mixed": "Geçiş", "bear": "Ayı"}


def pctrank(v):
    o = np.argsort(np.argsort(v))
    return o / max(len(v) - 1, 1) * 100


def main():
    d = json.load(open(HERE / "ohlcv_long.json", encoding="utf-8"))
    out = run(d)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: out[k] for k in ("data", "regime_days", "regimes", "curve_summary", "cone")}, ensure_ascii=False, indent=1))


def run(d):
    names = sorted(d["stocks"])
    T = len(d["dates"])
    C = np.full((T, len(names)), np.nan)
    for j, n in enumerate(names):
        c = d["stocks"][n]["c"]
        C[-len(c):, j] = [np.nan if x is None else x for x in c]
    ix = np.array([np.nan if x is None else x for x in d["index"]], float)
    dates = d["dates"]
    R = np.diff(np.log(C), axis=0)
    SIG = sigma_series(R)  # SIG[s-1] -> fiyat indeksi s için bilinen günlük oynaklık

    def regime(t):
        w50, w200 = ix[t - 49:t + 1], ix[t - 199:t + 1]
        if np.isnan(w200).any():
            return None
        last, m50, m200 = ix[t], w50.mean(), w200.mean()
        return "bull" if last > m50 and m50 > m200 else "bear" if last < m50 and last < m200 else "mixed"

    rows = {h: [] for h in HZ}   # (t, reg, port, ew, idx)
    cone = []                    # (t, reg, rp, sig_corr, sig_ind, sig_com)
    ts = list(range(WARM, T - max(HZ), STEP))
    for t in ts:
        reg = regime(t)
        if reg is None:
            continue
        c = C[t]
        el = np.where(np.isfinite(c) & np.isfinite(C[t - 252:t + 1]).all(axis=0) & np.isfinite(SIG[t - 1]))[0]
        if len(el) < 30:
            continue
        dist = c[el] / np.nanmax(C[t - 251:t + 1, el], axis=0) - 1
        p6, p1 = c[el] / C[t - 126, el] - 1, c[el] / C[t - 21, el] - 1
        rs = (pctrank(dist) + pctrank(p6) + pctrank(p1)) / 3
        top = el[np.argsort(-rs)[:TOPN]]
        for h in HZ:
            fw = C[t + h, el] / c[el] - 1
            fwtop = C[t + h, top] / c[top] - 1
            ok = np.isfinite(fw)
            if np.isfinite(fwtop).sum() < TOPN - 1 or ok.sum() < 20:
                continue
            rows[h].append((t, reg, float(np.nanmean(fwtop)), float(fw[ok].mean()), float(ix[t + h] / ix[t] - 1)))
        # koni: yalnızca 20 gün
        h = 20
        fwtop = C[t + h, top] / c[top] - 1
        if np.isfinite(fwtop).sum() < TOPN - 1:
            continue
        w = np.where(np.isfinite(fwtop), 1.0, 0.0)
        w /= w.sum()
        sg = SIG[t - 1, top]
        win = R[t - 250:t, :][:, top]
        win = np.where(np.isfinite(win), win, 0.0)
        cr = np.corrcoef(win.T)
        cr = np.nan_to_num(cr, nan=0.0)
        np.fill_diagonal(cr, 1.0)
        S = (sg[:, None] * sg[None, :]) * cr
        sc = float(np.sqrt(w @ S @ w))
        si = float(np.sqrt((w * w * sg * sg).sum()))
        sm = float((w * sg).sum())
        cone.append((t, reg, float(np.nansum(w * np.nan_to_num(fwtop))), sc, si, sm, float(cr[np.triu_indices(TOPN, 1)].mean())))

    out = {"generated": datetime.now(TR).strftime("%Y-%m-%d %H:%M"), "topn": TOPN, "step": STEP,
           "data": {"from": dates[WARM], "to": dates[-1], "stocks": len(names)},
           "assumptions": ("Fiyat getirisi, evren bugünün likit hisseleri (hayatta kalma yanlılığı), RS vekil strateji; komite/zaman skoru geçmişi yok. "
                           f"Net = brüt − %{COST20 * 100:.2f} (20g tur maliyeti)."), "regimes": {}, "cone": {}}

    # ---- rejim kırılımı
    for h in HZ:
        res = {}
        for key in REG + ("all",):
            sel = [r for r in rows[h] if key == "all" or r[1] == key]
            if not sel:
                continue
            p = np.array([r[2] for r in sel]); e = np.array([r[3] for r in sel]); x = np.array([r[4] for r in sel])
            ex = p - e
            n = len(sel); neff = max(n * STEP / h, 1.0)
            sd = ex.std(ddof=1) if n > 1 else float("nan")
            t = ex.mean() / (sd / np.sqrt(neff)) if sd and sd > 0 else None
            res[key] = {"n": n, "neff": round(neff, 1), "port": round(p.mean() * 100, 2), "ew": round(e.mean() * 100, 2), "bist": round(x.mean() * 100, 2),
                        "excess": round(ex.mean() * 100, 2), "excess_t": None if t is None else round(float(t), 2),
                        "hit": round(float((ex > 0).mean() * 100), 1), "pos_abs": round(float((p > 0).mean() * 100), 1)}
        out["regimes"][str(h)] = res

    # ---- eğri (20g tur, kesişmeyen): portföy vs eşit ağırlık vs BIST, rejim etiketi
    curve, eq_p, eq_e, eq_x, last_t = [], 1.0, 1.0, 1.0, None
    for r in rows[20]:
        if last_t is not None and r[0] < last_t + 20:
            continue
        last_t = r[0]
        eq_p *= 1 + r[2] - COST20; eq_e *= 1 + r[3]; eq_x *= 1 + r[4]
        curve.append({"d": dates[r[0] + 20], "r": r[1], "p": round(eq_p, 4), "e": round(eq_e, 4), "x": round(eq_x, 4)})
    out["curve"] = curve
    if curve:
        yrs = (len(curve) * 20) / 252
        out["curve_summary"] = {"years": round(yrs, 1), "port_cagr": round((curve[-1]["p"] ** (1 / yrs) - 1) * 100, 1),
                                "ew_cagr": round((curve[-1]["e"] ** (1 / yrs) - 1) * 100, 1), "bist_cagr": round((curve[-1]["x"] ** (1 / yrs) - 1) * 100, 1)}

    # ---- koni
    if cone:
        ct = np.array([c[0] for c in cone]); rg = np.array([c[1] for c in cone]); rp = np.array([c[2] for c in cone])
        sg3 = {"corr": np.array([c[3] for c in cone]), "ind": np.array([c[4] for c in cone]), "com": np.array([c[5] for c in cone])}
        avgc = float(np.mean([c[6] for c in cone]))
        lr = np.log1p(rp)
        half = len(cone) // 2
        out["cone"]["n"] = len(cone); out["cone"]["avg_pair_corr"] = round(avgc, 3)
        out["cone"]["split"] = dates[int(ct[half])]
        for nm, sg in sg3.items():
            z = (lr - np.median(lr[:half])) / (sg * np.sqrt(20))
            z1 = z[:half]
            lo, hi = np.percentile(z1, 10), np.percentile(z1, 90)
            # ölçek k: ilk yarıda p10-p90 bandı %80 kapsasın diye bandı k ile ölçekle (k=1 değişmez; burada ampirik kantiller zaten kapsıyor)
            inb = (z >= lo) & (z <= hi)
            res = {"cov_in": round(float(inb[:half].mean() * 100), 1), "cov_out": round(float(inb[half:].mean() * 100), 1),
                   "z_sd_in": round(float(z1.std()), 2), "z_sd_out": round(float(z[half:].std()), 2), "by_regime_out": {}}
            for key in REG:
                m = (rg == key); m[:half] = False
                if m.sum() >= 8:
                    res["by_regime_out"][key] = {"n": int(m.sum()), "cov": round(float(inb[m].mean() * 100), 1), "z_sd": round(float(z[m].std()), 2)}
            out["cone"][nm] = res
        # portföy p10-p90 bandı (korelasyonlu) - ortalama genişlik, 20 gün
        z = (lr - np.median(lr[:half])) / (sg3["corr"] * np.sqrt(20))
        lo, hi = np.percentile(z[:half], 10), np.percentile(z[:half], 90)
        out["cone"]["band_example"] = {"sigma20_pct": round(float(np.mean(sg3["corr"]) * np.sqrt(20) * 100), 1),
                                       "p10_pct": round(float(np.expm1(np.median(lr[:half]) + lo * np.mean(sg3["corr"]) * np.sqrt(20)) * 100), 1),
                                       "p90_pct": round(float(np.expm1(np.median(lr[:half]) + hi * np.mean(sg3["corr"]) * np.sqrt(20)) * 100), 1)}
    # rejim gün sayıları (tüm örneklem)
    allreg = [regime(t) for t in range(WARM, T, 1)]
    out["regime_days"] = {k: int(sum(1 for r in allreg if r == k)) for k in REG}
    return out


if __name__ == "__main__":
    main()
