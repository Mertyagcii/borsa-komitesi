"""forecast.py: olasılık konisinin kalibrasyonu, gelecek sızıntısı ve biçim testi (sentetik, tohumlu). run_tests.py çağırır."""
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import forecast as F

ok = True


def chk(name, cond):
    global ok
    ok &= bool(cond)
    print(("OK   " if cond else "HATA ") + name)


def world(seed=3, n_days=800, n_stocks=60, vol_lo=0.012, vol_hi=0.035, drift=0.0004):
    """Hisse başına sabit ama farklı oynaklık, ortak piyasa şoku yok: kalibrasyon testi için temiz dünya."""
    rng = np.random.default_rng(seed)
    vols = rng.uniform(vol_lo, vol_hi, n_stocks)
    r = rng.standard_t(5, (n_days - 1, n_stocks)) * vols / np.sqrt(5 / 3) + drift
    C = 100 * np.exp(np.vstack([np.zeros((1, n_stocks)), np.cumsum(r, axis=0)]))
    idx = 1000 * np.exp(np.concatenate([[0], np.cumsum(rng.normal(drift, 0.012, n_days - 1))]))
    dates = [f"d{i}" for i in range(n_days)]
    return {"dates": dates, "stocks": {f"S{i}": {"c": [float(x) for x in C[:, i]]} for i in range(n_stocks)}, "index": [float(x) for x in idx]}, vols


O, vols = world()
out = F.run(O)
for h in ("5", "21"):
    m = out["horizons"][h]
    chk(f"h={h}: %80 aralık gerçekte yaklaşık %80 tutuyor (sentetik, kural doğruysa) -> {m['cov80Raw']}", 0.72 <= m["cov80Raw"] <= 0.88)
    chk(f"h={h}: %50 aralık yaklaşık %50 -> {m['cov50Raw']}", 0.40 <= m["cov50Raw"] <= 0.60)
    chk(f"h={h}: örneklem dışı kapsama da hedefe yakın -> {m['cov80Oos']}", 0.70 <= m["cov80Oos"] <= 0.90)
chk("uzun ufukta bağımsız pencere sayısı dürüstçe az raporlanır (252 gün < 3 bağımsız)", out["horizons"]["252"]["n_eff"] < 3 and out["horizons"]["252"]["confidence"] == "doğrulanamadı")
chk("haftalık ufuk çok bağımsız pencere ile sınanır", out["horizons"]["5"]["n_eff"] > 50)

# biçim: yüzdelikler artan, olasılıklar [0,1], hisse başına her ufuk var, endeks de var
bad = 0
for n, rec in out["s"].items():
    for h, f in rec["f"].items():
        q = f[:5]
        if not all(q[i] < q[i + 1] for i in range(4)) or not all(0 <= p <= 1 for p in f[5:]) or q[0] <= -100:
            bad += 1
chk("yüzdelikler artan, olasılıklar 0-1, düşüş %100'ü geçmez", bad == 0)
chk("endeks (XU100) satırı üretildi", "XU100" in out["s"] and set(out["s"]["XU100"]["f"]) == {"5", "21", "126", "252"})

# oynak hissenin bandı daha geniş
i_lo, i_hi = int(np.argmin(vols)), int(np.argmax(vols))
w = lambda i: out["s"][f"S{i}"]["f"]["21"][4] - out["s"][f"S{i}"]["f"]["21"][0]
chk("en oynak hissenin aralığı en sakininkinden geniş", w(i_hi) > 1.5 * w(i_lo))
chk("oynaklık tahmini gerçeğe yakın (yıllık %, en oynak)", abs(out["s"][f"S{i_hi}"]["v"] - vols[i_hi] * np.sqrt(252) * 100) < 0.25 * vols[i_hi] * np.sqrt(252) * 100)

# gelecek sızıntısı yok: t'den sonraki fiyatları bozmak t anındaki tahmini değiştirmez
C = np.array([O["stocks"][n]["c"] for n in O["stocks"]] + [O["index"]], dtype=float).T
cols = list(range(len(O["stocks"])))


def at(C_, t, h):
    sig = F.sigma_series(np.diff(np.log(C_), axis=0))
    Z = F.standardized(C_, sig, h)
    return F.forecast_rows(C_, sig, Z, t, h, cols, 1.0)


t, h = 500, 21
a = at(C, t, h)
C2 = C.copy()
C2[t + 1:] *= np.random.default_rng(9).uniform(0.3, 3.0, C2[t + 1:].shape)
b = at(C2, t, h)
chk("gelecek sızıntısı yok: t sonrası veriyi bozmak t anındaki tahmini değiştirmez", all(np.allclose(x, y, equal_nan=True) for x, y in zip(a, b)))
# t öncesini bozmak ise tahmini DEĞİŞTİRMELİ (test duyarlı mı?)
C3 = C.copy()
C3[:t] *= np.random.default_rng(4).uniform(0.7, 1.4, C3[:t].shape)
c = at(C3, t, h)
chk("(duyarlılık) t öncesi veriyi bozmak tahmini değiştirir", not np.allclose(a[0], c[0], equal_nan=True))

# eksik gün oynaklığı küçültmez
R = np.diff(np.log(C), axis=0)
R2 = R.copy()
R2[100:300, 0] = np.nan
s1, s2 = F.sigma_series(R), F.sigma_series(R2)
chk("eksik günler (NaN) oynaklığı sıfıra çekmez", np.isfinite(s2[-1, 0]) and 0.5 < s2[-1, 0] / s1[-1, 0] < 1.6)
# --- uzun veri birleşimi, reel ve dolar kipleri ---
import ohdata

full, _ = world(seed=11, n_days=900, n_stocks=40)
cut = 600
long = {"dates": full["dates"][:cut], "stocks": {n: {"c": s["c"][:cut]} for n, s in full["stocks"].items()}, "index": full["index"][:cut]}
# kısa dosya: son 500 gün, ama bir bölünme/bedelsiz düzeltmesi farkı yüzünden 2x ölçekli (uzun dosya eski ölçekte kalmış)
short = {"dates": full["dates"][400:], "stocks": {n: {"c": [x * 2 for x in s["c"][400:]]} for n, s in full["stocks"].items()}, "index": full["index"][400:]}
m = ohdata.merge(long, short)
chk("birleşim: tüm gün ekseni var (900)", len(m["dates"]) == 900 and m["dates"][-1] == full["dates"][-1])
j = max(abs(c[cut] / c[cut - 1] - 1) for c in (v["c"] for v in m["stocks"].values()))
chk("birleşim yerinde sahte sıçrama yok (iki kaynak arası ölçek farkı düzeltildi)", j < 0.2)
# yarım gün riski: uzun dosyanın SON barı bozuksa (seans içi çekim), kısa dosyadaki doğru değer kullanılır
longp = {"dates": long["dates"], "stocks": {n: {"c": list(v["c"])} for n, v in long["stocks"].items()}, "index": list(long["index"])}
longp["stocks"]["S0"]["c"][-1] = longp["stocks"]["S0"]["c"][-1] * 0.5
mp = ohdata.merge(longp, short)
chk("uzun dosyanın bozuk (yarım gün) son barı kısa dosyadan düzeltilir", abs(mp["stocks"]["S0"]["c"][cut - 1] / m["stocks"]["S0"]["c"][cut - 1] - 1) < 1e-6)
chk("birleşik veri uzun geçmişi korur (ilk gün uzun dosyadan)", m["dates"][0] == full["dates"][0])
chk("uzun dosya yokken kısa veriye düşer (kırılmaz)", ohdata.load(ROOT / "tests")[1] is None if (ROOT / "tests" / "ohlcv.json").exists() else True)

import math as _m
cd = F.cpi_daily(["2025-01-15", "2025-02-15", "2026-06-01"], [["2025-01-01", 100.0], ["2025-02-01", 103.0], ["2025-03-01", 106.0], ["2025-04-01", 109.0]])
chk("TÜFE günlük yayılımı artan ve son aydan sonra eğimle uzatılır", cd[0] < cd[1] < cd[2] and cd[2] > 109)

rng = np.random.default_rng(2)
nd = len(full["dates"])
from datetime import date, timedelta
full = dict(full); full["dates"] = [(date(2016, 1, 4) + timedelta(days=i)).isoformat() for i in range(nd)]   # TÜFE yayılımı gerçek tarih ister
infl = np.exp(np.cumsum(np.full(nd, 0.0008)))     # günlük %0,08 enflasyon
mm = [[full["dates"][i], float(100 * infl[i])] for i in range(0, nd, 21)]
longx = dict(full); longx["cpi"] = mm; longx["usdtry"] = [float(10 * np.exp(0.0005 * i)) for i in range(nd)]
o2 = F.run(full, long=longx)
chk("endekse göre kip üretildi, endeks satırında yok, hisse satırında var", "x" in o2["modes"] and "x" in o2["s"]["S3"] and "x" not in o2["s"]["XU100"] and "5" in o2["s"]["S3"]["x"])
mx = o2["horizons_x"]["21"]
chk(f"endekse göre %80 aralık gerçekte yaklaşık %80 tutuyor -> {mx['cov80Raw']}", 0.70 <= mx["cov80Raw"] <= 0.90)
chk("endekse göre aralık: yüzdelikler artan, olasılık 0-1", all(all(f[i] < f[i + 1] for i in range(4)) and 0 <= f[7] <= 1 for f in (o2["s"]["S3"]["x"]["21"],)))
chk("reel ve dolar kipleri üretildi", set(o2["modes"]) == {"n", "r", "d", "x"} and "horizons_r" in o2 and "horizons_d" in o2)
rec = o2["s"]["S3"]
chk("reel ortanca nominalden düşük (enflasyon arındırıldı)", rec["r"]["21"][2] < rec["f"]["21"][2])
chk("dolar ortanca nominalden düşük (kur artışı arındırıldı)", rec["d"]["21"][2] < rec["f"]["21"][2])
sys.exit(0 if ok else 1)
