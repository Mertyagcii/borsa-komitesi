"""Gelecek Görünümü'nün CANLI karnesi: tahmin bantlarını kaydeder, ufuk dolunca gerçekleşenle kıyaslar → forecast_log.json, forecast_live.json.

Neden: geriye dönük test (forecast.py) geçmişte "aralık tuttu mu" sorusunu yanıtlar; asıl kanıt, ileriye dönük kayıttır.
Kayıt (forecast_log.json) yalnızca ekleme yapar, geçmiş origin'ler değişmez (depo geçmişi değişmez ön kayıt işlevi görür).
Kurallar:
- Origin = forecast.json'un son bar tarihi; en az 5 işlem günü arayla (haftalık) kaydedilir, böylece dosya küçük kalır.
- Gerçekleşen getiri = ohlcv.json kapanışlarından, origin kapanışından h işlem günü sonrası. Ufuk dolmadan ölçülmez.
- Ölçüt: %80 bandın (p10-p90) ve %50 bandın (p25-p75) gerçekten tutma oranı (hedef %80 / %50); gerçekleşen yükselme oranı.
- Aynı origin'deki hisseler ilişkilidir (ortak piyasa şoku): bağımsız gözlem sayısı origin sayısıdır, hisse sayısı değil; hüküm buna göre yazılır.
Kullanım: python forecast_log.py"""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).parent
TR = timezone(timedelta(hours=3))
HORIZONS = ("5", "21", "126", "252")
MIN_GAP = 5


def update(forecast, ohlcv, log, now=None):
    """log: {"origins": [...]}; dönüş: (log, live)."""
    dates = ohlcv["dates"]
    idx = {d: i for i, d in enumerate(dates)}
    origins = log.setdefault("origins", [])
    to = forecast.get("to")
    if to in idx and not any(o["d"] == to for o in origins):
        last_i = max((idx.get(o["d"], -99) for o in origins), default=-99)
        if idx[to] - last_i >= MIN_GAP:
            rec = {"d": to, "s": {}}
            for n, s in forecast["s"].items():
                row = {h: s["f"][h][:5] for h in HORIZONS if h in s["f"]}
                if row:
                    rec["s"][n] = {"p": s["p"], "f": row}
            origins.append(rec)
    closes = {n: v["c"] for n, v in ohlcv["stocks"].items()}
    closes["XU100"] = ohlcv["index"]
    live = {"generated": (now or datetime.now(TR)).strftime("%Y-%m-%d %H:%M"), "to": dates[-1], "origins": len(origins), "h": {}}
    for h in HORIZONS:
        hh = int(h)
        per = []
        up_n = up_all = 0
        for o in origins:
            i = idx.get(o["d"])
            if i is None or i + hh >= len(dates):
                continue
            n80 = n50 = n = ups = 0
            for sym, rec in o["s"].items():
                c = closes.get(sym)
                if not c or h not in rec["f"] or c[i] is None or c[i + hh] is None or c[i] <= 0:
                    continue
                r = (c[i + hh] / c[i] - 1) * 100
                f = rec["f"][h]
                n += 1
                n80 += f[0] <= r <= f[4]
                n50 += f[1] <= r <= f[3]
                ups += r > f[2]
            if n >= 20:
                per.append({"d": o["d"], "n": n, "c80": round(n80 / n, 3), "c50": round(n50 / n, 3), "above": round(ups / n, 3)})
        k = len(per)
        live["h"][h] = {"origins": k, "per": per[-12:],
                        "c80": round(sum(p["c80"] for p in per) / k, 3) if k else None,
                        "c50": round(sum(p["c50"] for p in per) / k, 3) if k else None,
                        "above": round(sum(p["above"] for p in per) / k, 3) if k else None}
        if k == 0:
            verdict = "henüz ölçülmedi"
        elif k < 4:
            verdict = "çok az bağımsız gözlem (yalnızca ipucu)"
        else:
            gap = abs(live["h"][h]["c80"] - 0.80)
            verdict = "hedefe uygun" if gap <= 0.06 else ("aralık fazla dar (güvenilmez)" if live["h"][h]["c80"] < 0.80 else "aralık fazla geniş")
        live["h"][h]["verdict"] = verdict
    return log, live


def main():
    forecast = json.loads((HERE / "forecast.json").read_text(encoding="utf-8-sig"))
    ohlcv = json.loads((HERE / "ohlcv.json").read_text(encoding="utf-8-sig"))
    lp = HERE / "forecast_log.json"
    log = json.loads(lp.read_text(encoding="utf-8-sig")) if lp.exists() else {"origins": []}
    log, live = update(forecast, ohlcv, log)
    lp.write_text(json.dumps(log, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (HERE / "forecast_live.json").write_text(json.dumps(live, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("origin:", len(log["origins"]), {h: (v["origins"], v["verdict"]) for h, v in live["h"].items()})


if __name__ == "__main__":
    main()
