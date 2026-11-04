"""İleriye dönük olasılık konisi (hafta / ay / 6 ay / yıl) → forecast.json.

NOT BİR FİYAT HEDEFİ: tek bir "şu fiyata gider" sayısı üretmez. Her hisse ve ufuk için getirinin OLASI ARALIĞINI (p10/p25/p50/p75/p90) ve
"%10'dan fazla kaybetme / kazanma olasılığı"nı verir. Aralıklar kendi geçmişinden ölçülür ve geriye dönük, ileri doğrulamalı bir testle sınanır:
"%80'lik bandın gerçekten %80'i tutuyor mu?" sorusunun cevabı (kapsama) dosyaya yazılır, arayüz bunu hep tahminin yanında gösterir.

Yöntem (kural tabanlı, LLM yok):
- Ölçek: hissenin SON dönem oynaklığı (EWMA ve 1 yıllık varyansın karışımı) × √gün.
- Şekil: tüm hisselerin geçmiş h günlük getirilerinin oynaklığa bölünmüş (standardize) ampirik dağılımı (kalın kuyruklar dahil, normal varsayımı yok).
- Merkez: havuzun medyanı (tarihsel nominal TL sürüklenmesi, enflasyon dahil). Hisseye özel "momentum/yön" iddiası YOKTUR: kanıtlı sinyaller 5-20 günde zayıf, 6-12 ayda ölçülemiyor.
- Kalibrasyon: tek bir ölçek katsayısı k, ilk yarı kaynaklarla seçilir, ikinci yarıda sınanır (örneklem dışı kapsama ayrıca raporlanır).
Gelecek bilgisi sızmaz: t anındaki tahmin yalnızca t'ye kadar gerçekleşmiş (bitişi <= t) getirileri ve verileri kullanır.

Sınırlar (dosyada da yazar): veri ~3 yıl (3 piyasa rejimi görmedik), evren bugünün likit hisseleri (hayatta kalma yanlılığı), getiriler nominal TL.
6 ay ve 1 yıl ufkunda bağımsız gözlem sayısı çok azdır; güvenilirlik etiketi buna göre "düşük / doğrulanamadı" olur.
Kullanım: python forecast.py"""
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
OUT = HERE / "forecast.json"
TR = timezone(timedelta(hours=3))
HORIZONS = {5: "Haftalık", 21: "Aylık", 126: "6 aylık", 252: "Yıllık"}
QS = (10, 25, 50, 75, 90)
MIN_HIST = 120      # oynaklık için en az gün
LAM = 0.94          # EWMA


def sigma_series(R):
    """R: (T-1, N) günlük log getiri (eksik gün = NaN). Her t için (R[:t+1] ile bilinen) günlük oynaklık, (T-1, N). Yalnız geçmiş kullanılır.
    Eksik günler sıfır getiri sayılmaz (oynaklığı küçültürdü): yalnız gerçek gözlemler hesaba girer; < MIN_HIST gözlemi olan hisse NaN kalır."""
    T, N = R.shape
    fin = np.isfinite(R)
    r2 = np.where(fin, R, 0.0) ** 2
    ew = np.full((T, N), np.nan)
    v = np.full(N, np.nan)
    for t in range(T):
        upd = fin[t]
        v = np.where(upd & np.isnan(v), r2[t], np.where(upd, LAM * v + (1 - LAM) * r2[t], v))
        ew[t] = v
    cs = np.vstack([np.zeros((1, N)), np.cumsum(r2, axis=0)])
    cf = np.vstack([np.zeros((1, N)), np.cumsum(fin, axis=0)])
    hi = np.arange(T) + 1
    lo = np.maximum(0, hi - 250)
    cnt = cf[hi] - cf[lo]
    yr = (cs[hi] - cs[lo]) / np.maximum(cnt, 1)
    sig = np.sqrt(0.5 * ew + 0.5 * yr)
    sig[cnt < MIN_HIST] = np.nan
    return sig

def standardized(C, sig, h):
    """Z[s, i] = log(C[s+h]/C[s]) / (sig_s * sqrt(h)); s = fiyat indeksi (sig[s-1] = s'ye kadar gerçekleşen oynaklık)."""
    T, N = C.shape
    Z = np.full((T, N), np.nan)
    if T <= h + MIN_HIST:
        return Z
    F = np.log(C[h:] / C[:-h])               # F[s] = s'den s+h'ye
    sg = np.full((T, N), np.nan)
    sg[1:] = sig                              # sig[s-1] s anındaki bilgi
    Z[: T - h] = F / (sg[: T - h] * math.sqrt(h))
    return Z


def pool_quantiles(Z, t, h, cols):
    """t anında BİLİNEN havuz: bitişi <= t olan örnekler (s <= t-h)."""
    P = Z[: t - h + 1][:, cols].ravel()
    P = P[np.isfinite(P)]
    return P


def band(P, k):
    if len(P) < 500:
        return None
    qz = np.percentile(P, QS)
    zm = qz[2]
    return zm + k * (qz - zm)


def forecast_rows(C, sig, Z, t, h, cols, k):
    """t anındaki tahmin: (her hisse için log getiri bandı (N,5)), P(zarar>%10), P(kazanç>%10)."""
    P = pool_quantiles(Z, t, h, cols)
    qz = band(P, k)
    if qz is None:
        return None
    s_t = sig[t - 1] * math.sqrt(h)               # t anında bilinen oynaklık
    L = s_t[:, None] * qz[None, :]
    srt = np.sort(P)
    zm = np.percentile(P, 50)

    def cdf(x):  # x: (N,) z eşiği
        return np.searchsorted(srt, zm + (x - zm) / k, side="right") / len(srt)
    pl = cdf(math.log(0.9) / s_t)
    pg = 1 - cdf(math.log(1.1) / s_t)
    pup = 1 - cdf(np.zeros_like(s_t))
    return L, pl, pg, pup


def backtest(C, sig, Z, h, cols, ks, step=3):
    """Her aday k için kapsama (80/50) ve gerçekleşen/öngörülen yukarı oranı. Dönüş: origin listesi + k başına sayaçlar."""
    T = C.shape[0]
    origins = list(range(MIN_HIST + h + 1, T - h, step))
    rows = []
    for t in origins:
        P = pool_quantiles(Z, t, h, cols)
        if len(P) < 500:
            continue
        s_t = sig[t - 1] * math.sqrt(h)
        F = np.log(C[t + h] / C[t])
        qz0 = np.percentile(P, QS)
        zm = qz0[2]
        ok = np.isfinite(F) & np.isfinite(s_t)
        per_k = {}
        for k in ks:
            qz = zm + k * (qz0 - zm)
            lo80, hi80, lo50, hi50 = qz[0] * s_t, qz[4] * s_t, qz[1] * s_t, qz[3] * s_t
            per_k[k] = (np.mean((F >= lo80)[ok] & (F <= hi80)[ok]), np.mean((F >= lo50)[ok] & (F <= hi50)[ok]))
        up_pred = float(np.mean(P > 0))
        up_real = float(np.mean((F > 0)[ok]))
        rows.append((t, per_k, up_pred, up_real))
    return rows


def cov(rows, k, a, b):
    sel = [r for r in rows if a <= r[0] < b]
    if not sel:
        return None
    return float(np.mean([r[1][k][0] for r in sel])), float(np.mean([r[1][k][1] for r in sel])), len(sel)


def pick_k(rows, ks, a, b, target=0.80):
    best, bd = 1.0, 9
    for k in ks:
        c = cov(rows, k, a, b)
        if c and abs(c[0] - target) < bd:
            best, bd = k, abs(c[0] - target)
    return best


def confidence(n_eff, oos_cov):
    if n_eff < 3:
        return "doğrulanamadı"
    if n_eff < 10:
        return "düşük"
    return "orta" if (oos_cov is not None and abs(oos_cov - 0.80) <= 0.06) else "düşük"


def cpi_daily(dates, cpi):
    """Aylık TÜFE endeksini günlük eksene log-doğrusal yayar; son aydan sonrası son 3 ayın eğimiyle uzatılır (yayın gecikmesi). Dönüş: (T,) endeks."""
    from datetime import date
    xs = np.array([date.fromisoformat(d).toordinal() for d, _ in cpi], dtype=float)
    ys = np.log(np.array([v for _, v in cpi], dtype=float))
    t = np.array([date.fromisoformat(d).toordinal() for d in dates], dtype=float)
    out = np.interp(t, xs, ys)
    if len(xs) >= 4:
        slope = (ys[-1] - ys[-4]) / (xs[-1] - xs[-4])
        m = t > xs[-1]
        out[m] = ys[-1] + slope * (t[m] - xs[-1])
    return np.exp(out)


def _engine(C, dates, ncols, label_names):
    """Tek bir fiyat matrisi (T, N+1; son sütun endeks) için ufuk başına sınama özeti + bugünkü bantlar."""
    T = C.shape[0]
    R = np.diff(np.log(C), axis=0)
    sig = sigma_series(R)
    cols = list(range(ncols))   # havuza endeks girmez
    ks = [round(0.6 + 0.05 * i, 2) for i in range(0, 25)]
    meta_all, results = {}, {}
    for h, label in HORIZONS.items():
        Z = standardized(C, sig, h)
        rows = backtest(C, sig, Z, h, cols, ks)
        n_o = len(rows)
        meta = {"label": label, "days": h, "origins": n_o, "n_eff": round(n_o * 3 / h, 1) if n_o else 0}
        if n_o >= 12:
            ts = [r[0] for r in rows]
            mid = ts[len(ts) // 2]
            k1 = pick_k(rows, ks, ts[0], mid)
            raw_all = cov(rows, 1.0, ts[0], ts[-1] + 1)
            oos_raw = cov(rows, 1.0, mid, ts[-1] + 1)
            oos_adj = cov(rows, k1, mid, ts[-1] + 1)     # ilk yarıdan seçilen k ikinci yarıda
            k = pick_k(rows, ks, ts[0], ts[-1] + 1)       # nihai k tüm örneklemde
            meta.update(kRaw=1.0, k=k, kFirstHalf=k1, cov80Raw=round(raw_all[0], 3), cov50Raw=round(raw_all[1], 3),
                        cov80Oos=round(oos_adj[0], 3), cov50Oos=round(oos_adj[1], 3), cov80OosRaw=round(oos_raw[0], 3),
                        upPred=round(float(np.mean([r[2] for r in rows])), 3), upReal=round(float(np.mean([r[3] for r in rows])), 3),
                        first=dates[ts[0]], last=dates[ts[-1]])
            meta["confidence"] = confidence(meta["n_eff"], meta["cov80Oos"])
        else:
            k = 1.0
            meta["confidence"] = "doğrulanamadı"
        results[h] = forecast_rows(C, sig, Z, T - 1, h, cols, k)
        Pq = pool_quantiles(Z, T - 1, h, cols)
        if len(Pq) >= 500:  # havuzun standart getiri şekli (kalibrasyon ayarlı, %5..%95 yüzdelikleri): tarayıcı portföy konisini bununla ölçekler
            q19 = np.percentile(Pq, list(range(5, 100, 5)))
            meta["zq"] = [round(float(q19[9] + k * (x - q19[9])), 4) for x in q19]
        meta_all[str(h)] = meta
    recs = {}
    last = C[-1]
    for i, n in enumerate(label_names):
        if not np.isfinite(last[i]) or not np.isfinite(sig[-1][i]):
            continue
        f = {}
        for h in HORIZONS:
            res = results[h]
            if res is None:
                continue
            L, pl, pg, pup = res
            f[str(h)] = [round(float((math.exp(x) - 1) * 100), 1) for x in L[i]] + [round(float(pl[i]), 3), round(float(pg[i]), 3), round(float(pup[i]), 3)]
        recs[n] = {"p": round(float(last[i]), 2), "v": round(float(sig[-1][i] * math.sqrt(252) * 100), 1), "f": f}
    return meta_all, recs


def _matrix(ohlcv):
    names = list(ohlcv["stocks"].keys())
    C = np.array([ohlcv["stocks"][n]["c"] for n in names] + [ohlcv["index"]], dtype=float).T   # (T, N+1), son sütun = BIST 100
    C[C <= 0] = np.nan
    return names, C


def run(ohlcv, now=None, long=None):
    """ohlcv: nominal TL için (kısa+uzun birleşik); long: ham uzun dosya (reel ve dolar kipleri için, cpi/usdtry içermeli) ya da None."""
    dates = ohlcv["dates"]
    names, C = _matrix(ohlcv)
    out = {"generated": (now or datetime.now(TR)).strftime("%Y-%m-%d %H:%M"), "to": dates[-1], "from": dates[0], "days": C.shape[0],
           "stocks": len(names), "horizons": {}, "s": {}}
    out["horizons"], recs = _engine(C, dates, len(names), names + ["XU100"])
    out["s"] = recs
    out["modes"] = {"n": "Nominal TL"}
    # Endekse göre: hisse/BIST 100 oranı aynı sınanmış motordan geçer ("piyasayı yener mi?"); P(yukarı) = endeksi yenme olasılığı
    meta_x, rx = _engine(C[:, :-1] / C[:, -1:], dates, len(names), names)
    out["horizons_x"] = meta_x
    out["modes"]["x"] = "Endekse göre (BIST 100'e kıyasla)"
    for n, rec in rx.items():
        if n in out["s"]:
            out["s"][n]["x"] = rec["f"]
    if long and long.get("cpi") and long.get("usdtry"):
        ld = long["dates"]
        ln, LC = _matrix(long)
        usd = np.array([x if x else np.nan for x in long["usdtry"]], dtype=float)
        cpi = cpi_daily(ld, long["cpi"])
        for key, label, div in (("r", "Reel TL (enflasyondan arındırılmış)", cpi), ("d", "ABD doları", usd)):
            meta, rr = _engine(LC / div[:, None], ld, len(ln), ln + ["XU100"])
            out["horizons_" + key] = meta
            out["modes"][key] = label
            for n, rec in rr.items():
                if n in out["s"]:
                    out["s"][n][key] = rec["f"]
        out["long"] = {"from": ld[0], "to": ld[-1], "days": len(ld)}
    out["note"] = ("Fiyat hedefi değildir; geçmiş oynaklığın ölçülmüş olası aralığıdır. Nominal kipte merkez, tarihsel nominal TL sürüklenmesidir (enflasyon dahil); reel kipte TÜFE'den, dolar kipinde USD/TL'den arındırılmıştır. "
                   "Hisseye özel yön iddiası yoktur. Bağımsız gözlem 6 ay ve 1 yıl ufkunda hâlâ azdır. Evren bugünün likit hisseleridir (hayatta kalma yanlılığı). Eğitim amaçlıdır, yatırım tavsiyesi değildir.")
    return out


def main():
    import ohdata
    ohlcv, long = ohdata.load(HERE)
    out = run(ohlcv, long=long)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for h, m in out["horizons"].items():
        print(h, {k: v for k, v in m.items() if k in ("origins", "n_eff", "k", "cov80Raw", "cov80Oos", "cov80OosRaw", "upPred", "upReal", "confidence")})
    print("hisse:", len(out["s"]), "| boyut", OUT.stat().st_size)


if __name__ == "__main__":
    main()
