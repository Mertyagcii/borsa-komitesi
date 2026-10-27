"""Tazelik mantığı testi: dosya mtime'ı CI'da hep "şimdi" olur; yaş içerikten okunmalı (freshness.py, history.write_ohlcv). run_tests.py çağırır."""
import json, os, sys, tempfile, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import freshness as F
import history as H
TR = timezone(timedelta(hours=3)); now = datetime.now(TR)
ok = True
def chk(name, cond):
    global ok; ok &= bool(cond); print(("OK  " if cond else "HATA"), name)
d = Path(tempfile.mkdtemp())
def w(name, obj, mtime=None):
    p = d / name; p.write_text(json.dumps(obj), encoding="utf-8")
    if mtime: os.utime(p, (mtime, mtime))
    return p
# 1) mtime "şimdi" ama içerik 14 gün eski: CI senaryosu -> BAYAT sayılmalı
old = (now - timedelta(days=14)).strftime("%Y-%m-%d %H:%M")
p = w("research.json", {"generated": old})
chk("generated 14 gün eski + mtime şimdi -> taze DEĞİL", not F.is_fresh(p, 7 * 86400))
chk("yaş ~14 gün", abs(F.age_seconds(p) / 86400 - 14) < 0.1)
# 2) içerik taze
p = w("a.json", {"generated": (now - timedelta(hours=2)).strftime("%Y-%m-%d %H:%M")}); chk("2 saatlik içerik 7 gün eşiğinde taze", F.is_fresh(p, 7 * 86400))
# 3) ts önceliği
p = w("b.json", {"ts": int(time.time()) - 3600, "generated": old}); chk("ts, generated'dan önce okunur", F.age_seconds(p) < 4000)
# 4) yalnız tarih: aynı gün taze, dünkü 6 saatlik eşikte bayat olabilir ama günlük eşikte değil
p = w("c.json", {"date": now.strftime("%Y-%m-%d")}); chk("bugünün tarihi (günlük iş) taze", F.is_fresh(p, 20 * 3600))
p = w("c2.json", {"date": (now - timedelta(days=14)).strftime("%Y-%m-%d")}); chk("14 gün önceki tarih bayat", not F.is_fresh(p, 20 * 3600))
# 5) meta.generated (stress.json biçimi)
p = w("s.json", {"meta": {"generated": old}}); chk("meta.generated okunur", not F.is_fresh(p, 7 * 86400))
# 6) damga yoksa mtime'a düşer; dosya yoksa None
p = w("n.json", {"x": 1}); chk("damgasız -> mtime (taze)", F.is_fresh(p, 3600)); chk("yok -> None", F.age_seconds(d / "yok.json") is None and not F.is_fresh(d / "yok.json", 1))
p = d / "bozuk.json"; p.write_text("{bozuk", encoding="utf-8"); chk("bozuk JSON çökmez, mtime", F.age_seconds(p) is not None)
# 7) ohlcv: son bar tarihine göre yenileme (mtime'dan bağımsız)
def oh(last, n=10):
    dts = [(datetime.fromisoformat(last) - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(5, -1, -1)]
    return {"dates": dts, "stocks": {f"S{i}": {"c": [1] * 6, "v": [1] * 6} for i in range(n)}, "index": None}
H.write_ohlcv(oh("2026-10-12"), d)
before = (d / "ohlcv.json").read_text(); os.utime(d / "ohlcv.json", (time.time(), time.time()))  # mtime şimdi (CI)
H.write_ohlcv(oh("2026-10-27"), d); chk("ohlcv 15 gün bayat + mtime şimdi -> YENİLENDİ", (d / "ohlcv.json").read_text() != before)
mid = (d / "ohlcv.json").read_text(); H.write_ohlcv(oh("2026-10-30"), d); chk("ohlcv 3 gün fark -> depo şişmesin, yenilenmez", (d / "ohlcv.json").read_text() == mid)
H.write_ohlcv(oh("2026-10-30", 20), d); chk("hisse sayısı %10+ artınca yenilenir", (d / "ohlcv.json").read_text() != mid)
H.write_ohlcv(oh("2026-11-10"), d / "alt"); chk("dest klasörü oluşturulur (yerel sunucu)", (d / "alt" / "ohlcv.json").exists())
# 8) history.is_stale(path): yol parametresi
chk("is_stale(yok) True", H.is_stale(d / "yok.json") is True)
print("SONUC", "TAMAM" if ok else "HATA VAR"); sys.exit(0 if ok else 1)

