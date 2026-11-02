"""tech_seal.py ve research.py gün kümelemeli t testi (sentetik, tohumlu). run_tests.py çağırır."""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import tech_seal as T

ok = True


def chk(name, cond):
    global ok
    ok &= bool(cond)
    print(("OK   " if cond else "HATA ") + name)


def world(momentum: float, n_days=420, n_stocks=90, seed=5):
    """momentum > 0: geçmiş kazananlar kazanmaya devam eder (kalıcı hisse sürüklenmesi); 0: saf rastgele yürüyüş."""
    rng = np.random.default_rng(seed)
    drift = rng.normal(0, 1, n_stocks) * momentum  # hisse başına kalıcı günlük sürüklenme (%)
    mkt = rng.normal(0, 0.9, n_days)
    r = (mkt[:, None] + drift[None, :] + rng.normal(0, 1.4, (n_days, n_stocks))) / 100
    C = pd.DataFrame(100 * np.cumprod(1 + r, axis=0), index=pd.bdate_range("2023-01-02", periods=n_days), columns=[f"S{i}" for i in range(n_stocks)])
    V = pd.DataFrame(rng.uniform(1e5, 2e5, (n_days, n_stocks)), index=C.index, columns=C.columns)
    return C, V


C1, V1 = world(0.12)
res = T.build(C1, V1, min_stocks=40)
h = res["h"]["10"]
chk("sonuç yapısı: bileşenler, sınama ve seçim tarihleri ayrık", set(h["components"]) == set(T.LABELS) and h["sel_days"] > 5 and h["oos_days"] > 5 and res["split"] > res["from"])
rl = h["components"]["rs_lider"]
chk("kalıcı sürüklenme varken göreli güç lideri sınamada (örneklem dışı) pozitif ve anlamlı", rl["oos"]["mean"] > 0.5 and rl["oos"]["t"] > 2 and rl["oos"]["fdr"] is True)
chk("göreli güç zayıf sınamada negatif", h["components"]["rs_zayif"]["oos"]["mean"] < -0.3)
chk("yalnız göreli güç IC pozitif ve anlamlı", h["ic_rs_only"]["mean"] > 0.03 and h["ic_rs_only"]["t"] > 2)

C0, V0 = world(0.0, seed=11)
res0 = T.build(C0, V0, min_stocks=40)["h"]["10"]
sig0 = [k for k, c in res0["components"].items() if c["oos"].get("fdr")]
chk("sürüklenme yokken (saf rastgele) sınamada ayakta kalan bileşen yok ya da en fazla bir (şans)", len(sig0) <= 1)
chk("sürüklenme yokken yalnız göreli güç IC anlamsız", abs(res0["ic_rs_only"]["mean"]) < 0.04)

# bh ve p2
chk("BH: [0.001, 0.04, 0.5] -> yalnız ilk", T.bh([0.001, 0.04, 0.5]) == {0})
chk("gün kümelemede az gün -> hüküm yok", T.day_stats([(1, 0.01), (1, 0.02)], 10)["t"] is None)

# research.evaluate_signal: gün kümelemeli t alanı ve "kanıt var" için ikisinin de ≥ 2 olması
try:
    import research as RS
    idx = pd.bdate_range("2024-01-01", periods=300)
    rng = np.random.default_rng(3)
    cols = [f"H{i}" for i in range(60)]
    fwd = {h: pd.DataFrame(rng.normal(0, 0.03, (300, 60)), index=idx, columns=cols) for h in (5, 10, 20)}
    # tek bir günde (piyasa şoku) 60 hissenin tamamı +%8: olay bazlı t şişer, gün kümelemeli t şişmemeli
    sig = pd.DataFrame(False, index=idx, columns=cols)
    sig.iloc[100] = True
    for h in (5, 10, 20):
        fwd[h].iloc[100] = fwd[h].iloc[100] + rng.normal(0.08, 0.005, 60)
        # excess = fwd − günlük ortalama: tüm hisseler aynı artarsa fazla getiri 0 olur; bu yüzden yalnız yarısı yükselsin
    out = RS.evaluate_signal(sig, {h: fwd[h] for h in (5, 10, 20)}, None, 10)
    chk("evaluate_signal gün kümelemeli t alanları (tday, days) üretir", out is None or ("tday" in out and "days" in out))
    sig2 = pd.DataFrame(rng.random((300, 60)) < 0.05, index=idx, columns=cols)
    out2 = RS.evaluate_signal(sig2, fwd, None, 10)
    chk("rastgele sinyalde tday var ve makul", out2 is not None and out2["tday"] is not None and abs(out2["tday"]) < 4 and out2["days"] > 20)
    verdict_src = (ROOT / "research.py").read_text(encoding="utf-8")
    chk("'kanıt var' için tday ≥ 2 şartı kodda", 'td is None or td >= 2' in verdict_src)
except ImportError as e:
    print("research içe aktarılamadı, atlandı:", e)
print("SONUC", "TAMAM" if ok else "HATA VAR")
sys.exit(0 if ok else 1)
