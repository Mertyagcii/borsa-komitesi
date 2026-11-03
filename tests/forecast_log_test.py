"""forecast_log.py: kayıt (yalnız ekleme, aralık), ufuk dolmadan ölçmeme, kapsama hesabı (sentetik)."""
import copy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import forecast_log as L

ok = True


def chk(name, cond):
    global ok
    ok &= bool(cond)
    print(("OK   " if cond else "HATA ") + name)


def mk(n_days, to_i, path):
    dates = [f"d{i:03d}" for i in range(n_days)]
    stocks = {f"S{i}": {"c": [100.0 + path(i, t) for t in range(n_days)]} for i in range(30)}
    fc = {"to": dates[to_i], "s": {n: {"p": 100.0, "f": {"5": [-5, -2, 0, 2, 5, .1, .1, .5], "21": [-9, -4, 0, 4, 9, .1, .1, .5]}} for n in stocks}}
    return fc, {"dates": dates, "stocks": stocks, "index": [1000.0] * n_days}


# 1) kayıt eklenir, aynı origin tekrar eklenmez, 5 günden yakın origin eklenmez
fc, oh = mk(40, 10, lambda i, t: 0.0)
log, live = L.update(fc, oh, {"origins": []})
chk("ilk origin kaydedildi (30 hisse + endeks yok çünkü forecast'ta yok)", len(log["origins"]) == 1 and len(log["origins"][0]["s"]) == 30)
log, live = L.update(fc, oh, log)
chk("aynı origin ikinci kez eklenmez", len(log["origins"]) == 1)
fc2 = copy.deepcopy(fc); fc2["to"] = "d012"
log, _ = L.update(fc2, oh, log)
chk("5 işlem gününden yakın origin eklenmez", len(log["origins"]) == 1)
fc3 = copy.deepcopy(fc); fc3["to"] = "d016"
log, _ = L.update(fc3, oh, log)
chk("5+ gün sonrası origin eklenir", len(log["origins"]) == 2)

# 2) ufuk dolmadan ölçülmez: origin 10, h=5 için son bar >= 16 gerekir
fc, oh = mk(15, 10, lambda i, t: 0.0)
_, live = L.update(fc, oh, {"origins": []})
chk("ufuk dolmadan ölçülmez", live["h"]["5"]["origins"] == 0 and live["h"]["5"]["verdict"] == "henüz ölçülmedi")

# 3) kapsama: hareket tamamen bantın içinde (0) -> c80 = c50 = 1; bandın dışında (+20) -> 0
fc, oh = mk(30, 10, lambda i, t: 0.0)
_, live = L.update(fc, oh, {"origins": []})
h5 = live["h"]["5"]
chk("fiyat değişmedi: %80 ve %50 bant tam tutar", h5["origins"] == 1 and h5["c80"] == 1.0 and h5["c50"] == 1.0)
fc, oh = mk(30, 10, lambda i, t: 20.0 if t > 10 else 0.0)
_, live = L.update(fc, oh, {"origins": []})
chk("fiyat +%20 sıçradı: bant hiç tutmaz", live["h"]["5"]["c80"] == 0.0)
chk("tek origin 'çok az bağımsız gözlem' olarak etiketlenir (hisse sayısı bağımsız sayılmaz)", live["h"]["5"]["verdict"].startswith("çok az"))
sys.exit(0 if ok else 1)
