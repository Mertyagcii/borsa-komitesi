"""Takvim ve mevsimsellik araştırması (Yale Hirsch kadro üyesi): ohlcv.json'daki likit hisselerin eşit ağırlıklı günlük getirisinde
haftanın günü, resmi tatil öncesi/sonrası, ay dönümü ve takvim ayı etkileri. Çıktı: calendar_research.json.

Dürüstlük kuralları:
- Tüm testler TEK ailedir ve Benjamini-Hochberg (%5) ile düzeltilir; "anlamlı" yalnızca düzeltme sonrası ayakta kalan VE iki yarı örneklemde aynı yönde olanlardır.
- Sonuçlar ÖRNEKLEM İÇİDİR (doğrulanmadı). Canlı doğrulama için signals.js her gün calendar_log.json'a piyasa getirisini yazar; core.js calendarLive ölçer.
- Resmi tatiller sabit listeden değil veriden türetilir: iki işlem günü arasında eksik hafta içi günü varsa o gün tatildir.
Kullanım: python calendar_research.py"""
import json
import math
import statistics as S
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "calendar_research.json"
TR = timezone(timedelta(hours=3))
WD = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma"]


def p2(t: float) -> float:
    """İki yönlü normal p (büyük örnekte t ≈ z)."""
    return math.erfc(abs(t) / math.sqrt(2))


def bh(ps, q=0.05):
    """Benjamini-Hochberg: ayakta kalanların indeks kümesi."""
    m = len(ps)
    order = sorted(range(m), key=lambda i: ps[i])
    kmax = -1
    for k, i in enumerate(order):
        if ps[i] <= q * (k + 1) / m:
            kmax = k
    return {order[k] for k in range(kmax + 1)}


def build(ohlcv: dict, min_stocks: int = 30) -> dict:
    dates = [date.fromisoformat(d) for d in ohlcv["dates"]]
    names = list(ohlcv["stocks"])
    n = len(dates)
    mr = [None] * n
    for i in range(1, n):
        rs = []
        for k in names:
            c = ohlcv["stocks"][k]["c"]
            if c[i] and c[i - 1] and c[i - 1] > 0:
                rs.append(c[i] / c[i - 1] - 1)
        mr[i] = sum(rs) / len(rs) * 100 if len(rs) >= min_stocks else None
    allr = [x for x in mr if x is not None]
    base = S.mean(allr)

    groups = {}  # id -> (etiket, tür, [getiriler])

    def put(gid, label, kind, v):
        if v is None:
            return
        groups.setdefault(gid, (label, kind, []))[2].append(v)

    by_month = {}
    for i in range(1, n):
        by_month.setdefault((dates[i].year, dates[i].month), []).append(i)
    first3 = {i for v in by_month.values() for i in v[:3]}
    last3 = {i for v in by_month.values() for i in v[-3:]}
    for i in range(1, n):
        wd = dates[i].weekday()
        if wd < 5:
            put(f"wd{wd + 1}", WD[wd], "haftanın günü", mr[i])
        put(f"mo{dates[i].month}", f"Ay {dates[i].month:02d}", "takvim ayı", mr[i])
        if i in last3:
            put("ay_sonu3", "Ayın son 3 işlem günü", "ay dönümü", mr[i])
        if i in first3:
            put("ay_basi3", "Ayın ilk 3 işlem günü", "ay dönümü", mr[i])
    for i in range(1, n - 1):  # resmi tatil: iki işlem günü arasında eksik hafta içi günü
        miss = sum(1 for k in range(1, (dates[i + 1] - dates[i]).days) if (dates[i] + timedelta(days=k)).weekday() < 5)
        if miss >= 1:
            put("tatil_once", "Resmi tatil öncesi son işlem günü", "tatil", mr[i])
            put("tatil_sonra", "Resmi tatil sonrası ilk işlem günü", "tatil", mr[i + 1])

    tests = []
    for gid, (label, kind, xs) in groups.items():
        if len(xs) < 10:
            continue
        sd = S.stdev(xs)
        t = (S.mean(xs) - base) / (sd / math.sqrt(len(xs))) if sd > 0 else 0.0
        h = len(xs) // 2
        h1, h2 = S.mean(xs[:h]) - base, S.mean(xs[h:]) - base
        tests.append({"id": gid, "label": label, "kind": kind, "n": len(xs), "mean": round(S.mean(xs), 3), "t": round(t, 2), "h1": round(h1, 3), "h2": round(h2, 3), "p": p2(t)})
    keep = bh([x["p"] for x in tests])
    bonf = 0.05 / len(tests)
    for i, x in enumerate(tests):
        # anlamlı: BH sonrası ayakta + iki yarıda aynı yön (örneklem içi tutarlılık)
        x["fdr"] = bool(i in keep and x["h1"] * x["h2"] > 0)
        x["bonf"] = bool(x["p"] < bonf)
        x["verdict"] = ("anlamlı (örneklem içi)" if x["fdr"] else "anlamsız")
        x["p"] = round(x["p"], 5)
    return {"generated": datetime.now(TR).strftime("%Y-%m-%d %H:%M"), "from": str(dates[0]), "to": str(dates[-1]), "days": len(allr), "stocks": len(names),
            "base": round(base, 3), "family": len(tests), "expected_false": round(len(tests) * 0.05, 1), "survivors": [x["id"] for x in tests if x["fdr"]], "tests": tests,
            "note": "Örneklem içi; doğrulanmadı. Canlı doğrulama calendar_log.json ile ölçülür."}


def main() -> None:
    import ohdata
    oh, _ = ohdata.load(HERE)   # kısa + uzun (≈10 yıl) birleşik: takvim etkileri çok rejimde sınanır
    res = build(oh)
    OUT.write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"calendar_research.json: {res['family']} test, ayakta kalan {len(res['survivors'])}: {res['survivors']} ({res['from']} → {res['to']})")


if __name__ == "__main__":
    main()
