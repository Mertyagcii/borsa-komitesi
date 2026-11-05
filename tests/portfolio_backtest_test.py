"""portfolio_backtest.py: rejim kırılımlı portföy testi ve portföy konisi (sentetik, tohumlu). run_tests.py çağırır.
Sınanan: (1) saf gürültüde RS portföyü evreni yenmez (sahte avantaj üretmez), (2) kalıcı kazananlar varsa avantajı bulur,
(3) ortak faktör varken korelasyon yüksek çıkar ve bağımsız varsayım portföy riskini küçümser, (4) biçim ve rejim sayıları."""
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import portfolio_backtest as PB

ok = True


def chk(name, cond):
    global ok
    ok &= bool(cond)
    print(("OK   " if cond else "HATA ") + name)


def world(seed, persist=0.0, factor=0.0, n_days=1700, n=60):
    rng = np.random.default_rng(seed)
    vols = rng.uniform(0.012, 0.03, n)
    edge = rng.normal(0, 1, n) * persist          # hisse başına kalıcı günlük sürüklenme (0 = saf gürültü)
    f = rng.normal(0, 0.01, n_days - 1)[:, None]  # ortak faktör
    r = rng.standard_t(5, (n_days - 1, n)) * vols / np.sqrt(5 / 3) + edge + factor * f
    C = 100 * np.exp(np.vstack([np.zeros((1, n)), np.cumsum(r, axis=0)]))
    idx = 1000 * np.exp(np.concatenate([[0], np.cumsum(r.mean(axis=1))]))
    return {"dates": [f"d{i}" for i in range(n_days)], "stocks": {f"S{i}": {"c": [float(x) for x in C[:, i]]} for i in range(n)}, "index": [float(x) for x in idx]}


O0 = PB.run(world(5))
a = O0["regimes"]["20"]["all"]
chk(f"saf gürültüde RS portföyü evrenden üstün çıkmıyor (t={a['excess_t']})", abs(a["excess_t"]) < 3.0)
chk("rejim günleri toplamı mantıklı (3 rejim de görülüyor)", all(O0["regime_days"][k] > 50 for k in ("bull", "mixed", "bear")))
chk("her rejimde örnek ve etkin örnek raporlanıyor, etkin <= n", all(v["neff"] <= v["n"] and v["n"] > 0 for v in O0["regimes"]["20"].values()))
chk("etkin örnek 20 günde n*5/20", abs(a["neff"] - a["n"] * 5 / 20) < 0.11)

O1 = PB.run(world(6, persist=0.0012))
b = O1["regimes"]["20"]["all"]
chk(f"kalıcı kazananlar varsa RS portföyü bunu buluyor (fazla {b['excess']} puan, t={b['excess_t']})", b["excess"] > 0 and b["excess_t"] > 3.0)

O2 = PB.run(world(7, factor=2.0))
O3 = PB.run(world(7, factor=0.0))
chk(f"ortak faktör varken ikili korelasyon yüksek ({O2['cone']['avg_pair_corr']} > {O3['cone']['avg_pair_corr']})", O2["cone"]["avg_pair_corr"] > O3["cone"]["avg_pair_corr"] + 0.2)
chk(f"ortak faktör varken bağımsız varsayım riski küçümser (sapma {O2['cone']['ind']['z_sd_out']} > korelasyonlu {O2['cone']['corr']['z_sd_out']})", O2["cone"]["ind"]["z_sd_out"] > O2["cone"]["corr"]["z_sd_out"] * 1.2)
chk("tam bağlı varsayım gereğinden geniş (sapma < korelasyonlu)", O2["cone"]["com"]["z_sd_out"] < O2["cone"]["corr"]["z_sd_out"])
chk("koni kapsaması %80 civarında (örneklem dışı)", 65 <= O2["cone"]["corr"]["cov_out"] <= 92)
chk("eğri kesişmeyen 20 günlük turlarla kuruluyor", all(int(O0["curve"][i + 1]["d"][1:]) - int(O0["curve"][i]["d"][1:]) >= 20 for i in range(len(O0["curve"]) - 1)) and O0["curve"][0]["p"] > 0)
sys.exit(0 if ok else 1)
