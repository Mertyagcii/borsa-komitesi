"""İçerik tabanlı tazelik kontrolü.

Neden var: dosya değişiklik zamanı (mtime) GitHub Actions'ta her çalışmada "checkout" anına eşitlenir. "Haftada bir / günde bir yenile"
mantığı mtime'a bakınca CI'da dosya hep taze görünür ve iş HİÇ çalışmaz (araştırma, VİOP, haber ilgisi, jeopolitik, ohlcv 2 hafta bayat kalmıştı).
Burada yaş, dosyanın İÇİNDEKİ üretim damgasından okunur: ts (epoch) > generated > updated > date. Damga yoksa ya da dosya okunamıyorsa mtime'a düşülür."""
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

TR = timezone(timedelta(hours=3))


def _parse(v):
    """Damga değerini epoch saniyeye çevirir; tanınmazsa None. Yalnız tarih içerenler günün SONU sayılır (günlük iş aynı gün içinde taze)."""
    if isinstance(v, (int, float)) and v > 1e9:
        return float(v)
    if isinstance(v, str):
        for fmt, eod in (("%Y-%m-%d %H:%M", False), ("%Y-%m-%d %H:%M:%S", False), ("%Y-%m-%d", True), ("%Y%m%d", True)):
            try:
                d = datetime.strptime(v.strip()[:len(datetime.now().strftime(fmt))], fmt).replace(tzinfo=TR)
            except ValueError:
                continue
            return (d + timedelta(hours=23, minutes=59) if eod else d).timestamp()
    return None


def stamp(j):
    """JSON içeriğinden üretim damgası (epoch) ya da None."""
    if not isinstance(j, dict):
        return None
    for src in (j, j.get("meta") if isinstance(j.get("meta"), dict) else {}):
        for k in ("ts", "generated", "updated", "date"):
            t = _parse(src.get(k))
            if t:
                return t
    return None


def age_seconds(path):
    """Dosyanın içerik yaşı (saniye). Dosya yoksa None."""
    p = Path(path)
    if not p.exists():
        return None
    try:
        t = stamp(json.loads(p.read_text(encoding="utf-8")))
    except Exception:
        t = None
    return max(0.0, time.time() - (t if t else p.stat().st_mtime))


def is_fresh(path, max_age_seconds):
    a = age_seconds(path)
    return a is not None and a < max_age_seconds
