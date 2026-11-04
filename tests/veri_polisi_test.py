"""veri_polisi.py: sıçrama, donmuş seri, bayatlık ve karne sapması denetimleri doğru uyarı veriyor mu (sentetik)."""
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import veri_polisi as V

ok = True


def chk(name, cond):
    global ok
    ok &= bool(cond)
    print(("OK   " if cond else "HATA ") + name)


def mk(dates_n=100, jump=False, frozen=False):
    ds = [date.fromordinal(date(2026, 6, 1).toordinal() + i).isoformat() for i in range(dates_n)]
    base = [100 + 0.1 * i for i in range(dates_n)]
    s1 = list(base)
    if jump:
        s1[-10] = s1[-11] * 2   # bölünme imzası
    s2 = list(base)
    if frozen:
        s2[-8:] = [s2[-8]] * 8
    return {"dates": ds, "stocks": {"A": {"c": s1}, "B": {"c": s2}}, "index": base}


today = date.fromisoformat(mk()["dates"][-1])
byid = lambda cs: {c["id"]: c for c in cs}
c0 = byid(V.checks(mk(), None, None, None, today))
chk("temiz veri: sıçrama ve donmuş seri uyarısı yok", c0["sicrama"]["durum"] == "tamam" and c0["donmus_seri"]["durum"] == "tamam")
c1 = byid(V.checks(mk(jump=True), None, None, None, today))
chk("bölünme imzalı sıçrama yakalanır", c1["sicrama"]["durum"] == "uyarı" and "A" in c1["sicrama"]["ayrinti"])
c2 = byid(V.checks(mk(frozen=True), None, None, None, today))
chk("8 gün donmuş seri sayılır", "1 hissede" in c2["donmus_seri"]["ayrinti"])
c3 = byid(V.checks(mk(), None, None, None, date.fromordinal(today.toordinal() + 14)))
chk("bayat fiyat verisi uyarı verir", c3["fiyat_tazelik"]["durum"] == "uyarı")
chk("uzun veri yoksa uyarı, rejim çeşitliliği bilinen sınır", c0["uzun_veri"]["durum"] == "uyarı" and c0["rejim_cesitliligi"]["durum"] == "bilinen sınır")
live_bad = {"h": {"5": {"origins": 6, "c80": 0.62}, "21": {"origins": 1, "c80": 0.2}}}
c4 = byid(V.checks(mk(), None, {"to": mk()["dates"][-1]}, live_bad, today))
chk("tahmin karnesi hedeften >10 puan sapınca uyarı (yalnız ≥4 hafta ölçülen ufuk)", c4["tahmin_karne"]["durum"] == "uyarı" and "5g" in c4["tahmin_karne"]["ayrinti"] and "21g" not in c4["tahmin_karne"]["ayrinti"])
live_ok = {"h": {"5": {"origins": 6, "c80": 0.78}}}
c5 = byid(V.checks(mk(), None, {"to": mk()["dates"][-1]}, live_ok, today))
chk("hedefe yakın karne tamam", c5["tahmin_karne"]["durum"] == "tamam" and c5["tahmin_tazelik"]["durum"] == "tamam")
chk("hayatta kalma yanlılığı her zaman duyurulur", c0["hayatta_kalma"]["durum"] == "bilinen sınır")
# hayatta kalma göstergesi: evren endeksten hızlı büyüyorsa pozitif fark
n = 1000
idx = [1000 * (1.0004 ** i) for i in range(n)]
stk = {f"S{i}": {"c": [100 * (1.0010 ** t) for t in range(n)]} for i in range(30)}
sg = V.survivorship_gap({"stocks": stk, "index": idx})
chk(f"hayatta kalma göstergesi pozitif farkı bulur (evren %{sg[0]}, endeks %{sg[1]}, fark {sg[2]})" if sg else "hayatta kalma göstergesi hesaplandı", sg is not None and sg[2] > 10 and 3.5 < sg[3] < 4.5)
chk("kısa veride (<3 yıl) gösterge üretilmez", V.survivorship_gap({"stocks": {"A": {"c": [1.0] * 300}}, "index": [1.0] * 300}) is None)
long_ok = {"dates": [f"d{i}" for i in range(n)], "generated": "2026-11-03 07:00", "stocks": stk, "index": idx, "audit": {"jumps": []}}
c6 = byid(V.checks(mk(), long_ok, None, None, today))
chk("uzun veri varken hayatta kalma ayrıntısı sayısal üst sınırı içerir", "Üst sınır göstergesi" in c6["hayatta_kalma"]["ayrinti"] and "puan/yıl" in c6["hayatta_kalma"]["ayrinti"])
sys.exit(0 if ok else 1)
