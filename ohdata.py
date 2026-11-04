"""Araştırma betikleri için fiyat verisi yükleyici: kısa (ohlcv.json, güncel) + uzun (ohlcv_long.json, ~10 yıl, aylık yenilenir) birleştirir.

Uzun dosya yoksa ya da bozuksa yalnız kısa veri döner (hiçbir betik kırılmaz).
Birleşim kuralı: uzun dosyanın bittiği tarihten sonraki barlar kısa dosyadan eklenir. Süreklilik için ortak son günde ikisinin oranı ölçülür; iki kaynak
arasında bölünme/bedelsiz düzeltmesi farkı varsa (oran 1'den %0,2'den fazla sapar) kısa seri o orana ölçeklenir ki birleşim yerinde sahte sıçrama oluşmasın."""
import json
from pathlib import Path

HERE = Path(__file__).parent
TOL = 0.002
FRESH_BARS = 6   # uzun dosyanın son barları (yarım gün/eksik olabilir) varsa kısa dosyadan alınır: kısa dosya her gün kapanıştan sonra yenilenir


def _num(x):
    return x if (x is not None and x > 0) else None


def merge(long, short):
    ld, sd = long["dates"], short["dates"]
    last = ld[-1]
    dates = ld + [d for d in sd if d > last]
    spos = {d: i for i, d in enumerate(sd)}
    lpos = {d: i for i, d in enumerate(ld)}
    common = [d for d in sd if d in lpos and lpos[d] < len(ld) - FRESH_BARS]   # çapa: uzun dosyanın bozuk olabilecek son barlarından önce
    anchor = common[-1] if common else None

    def ratio(lc, sc):
        if anchor is None:
            return 1.0
        a, b = _num(lc[lpos[anchor]]), _num(sc[spos[anchor]])
        if a and b and abs(a / b - 1) > TOL:
            return a / b
        return 1.0

    def combine(lc, sc):
        k = ratio(lc, sc) if lc is not None and sc is not None else 1.0
        out = []
        for i, d in enumerate(dates):
            v = _num(lc[i]) if (lc is not None and i < len(ld)) else None
            if v is not None and i >= len(ld) - FRESH_BARS and sc is not None and d in spos and _num(sc[spos[d]]) is not None:
                v = None   # son barlarda kısa dosya geçerli
            if v is None and sc is not None and d in spos:
                s = _num(sc[spos[d]])
                v = round(s * k, 4) if s is not None else None
            out.append(v)
        return out

    stocks = {}
    for n in sorted(set(long["stocks"]) | set(short["stocks"])):
        lc = long["stocks"].get(n, {}).get("c")
        sc = short["stocks"].get(n, {}).get("c")
        c = combine(lc, sc)
        if sum(v is not None for v in c) >= 120:
            stocks[n] = {"c": c}
    return {"dates": dates, "stocks": stocks, "index": combine(long["index"], short["index"]), "merged": True}


def load(root=HERE):
    """(ohlcv, long): ohlcv = birleşik nominal veri; long = ham uzun dosya ya da None."""
    root = Path(root)
    short = json.loads((root / "ohlcv.json").read_text(encoding="utf-8-sig"))
    lp = root / "ohlcv_long.json"
    if not lp.exists():
        return short, None
    try:
        long = json.loads(lp.read_text(encoding="utf-8-sig"))
        if not long.get("dates") or not long.get("stocks"):
            return short, None
        return merge(long, short), long
    except Exception:
        return short, None
