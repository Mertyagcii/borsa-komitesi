"""Uzun fiyat geçmişi (~10 yıl) → ohlcv_long.json. YALNIZ araştırma betikleri için (siteye gitmez, tarayıcı yüklemez).

Neden: ohlcv.json 800 bar (~3 yıl, tek rejim). 6 ay / yıllık tahmin aralıkları ve "kanıt" bulguları bu yüzden zayıf doğrulanıyordu.
TradingView günlük serisi 2006'ya gider; 2600 bar ≈ 10 yıl (2018 krizi, 2020, 2021 faiz indirimi, 2023 seçim dahil).
İçerik: hisse kapanışları (ohlcv.json'daki likit evren), BIST 100, USD/TL (dolar getirisi için), TÜFE endeksi (reel getiri için, aylık).
Veri polisi: limit dışı günlük hareket (2020-06 sonrası ±%11,5; öncesi ±%21,5, çünkü o dönemde BIST limiti ±%20 idi) 'audit' alanına yazılır:
bölünme/bedelsiz düzeltilmemiş ya da hatalı veri belirtisi. Fiyat getirisi kullanılır (temettü dahil değil): temettü çıkış günleri düşüş olarak görünür.
Hayatta kalma yanlılığı sürer: evren bugünün likit hisseleridir (kapanmış/çıkarılmış hisseler yok).
Kullanım: python history_long.py [--if-stale]  (25 günden eskiyse yeniler)"""
import argparse
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "ohlcv_long.json"
TR = timezone(timedelta(hours=3))
BARS = 2600
STALE_DAYS = 25
JUMP = 0.115          # günlük fiyat limiti ±%10 döneminde bunun üstü şüphelidir
JUMP_OLD = 0.215      # Nisan 2020 öncesi BIST günlük limiti ±%20 idi (veride tam 20,0 hareketler; bölünme imzası 1/k yok)
LIMIT_CHANGE = "2020-06-01"


def fetch(tv, sym, ex, n, interval, retries=4):
    for _ in range(retries):
        try:
            df = tv.get_hist(sym, ex, interval=interval, n_bars=n)
            if df is not None and len(df) > 0:
                return df
        except Exception:
            pass
        time.sleep(1.0)
    return None


def align(df, axis_pos, n, ffill=False):
    """df.close'u ortak tarih eksenine oturtur; ffill=True ise eksik günler son değerle (döviz hafta sonu/tatil farkı) doldurulur."""
    out = [None] * n
    for d, v in zip(df.index, df["close"].astype(float).tolist()):
        i = axis_pos.get(str(d)[:10])
        if i is not None:
            out[i] = round(v, 4)
    if ffill:
        last = None
        for i in range(n):
            if out[i] is None:
                out[i] = last
            else:
                last = out[i]
    return out


def audit_jumps(dates, stocks, index):
    rows = []
    for n, c in list(stocks.items()) + [("XU100", index)]:
        for i in range(1, len(c)):
            a, b = c[i - 1], c[i]
            if a and b and a > 0 and abs(b / a - 1) > (JUMP_OLD if dates[i] < LIMIT_CHANGE else JUMP):
                rows.append({"n": n, "d": dates[i], "r": round((b / a - 1) * 100, 1)})
    return rows


def build(names, log=print):
    from tvDatafeed import Interval, TvDatafeed
    tv = TvDatafeed()
    idf = fetch(tv, "XU100", "BIST", BARS, Interval.in_daily)
    if idf is None:
        raise SystemExit("XU100 alınamadı")
    now = datetime.now(TR)
    if str(idf.index[-1])[:10] == now.date().isoformat() and now.hour * 60 + now.minute < 18 * 60 + 45:
        idf = idf.iloc[:-1]   # seans içinde bugünün barı yarımdır: dosyaya girmesin
    dates = [str(d)[:10] for d in idf.index]
    pos = {d: i for i, d in enumerate(dates)}
    n = len(dates)
    index = align(idf, pos, n, ffill=True)
    stocks = {}
    for k, name in enumerate(names, 1):
        df = fetch(tv, name, "BIST", BARS, Interval.in_daily)
        if df is None:
            log(f"[{k}/{len(names)}] {name}: alınamadı")
            if k % 10 == 0:
                tv = TvDatafeed()
            continue
        stocks[name] = align(df, pos, n)
        if k % 25 == 0:
            log(f"[{k}/{len(names)}] ...")
    udf = fetch(tv, "USDTRY", "FX_IDC", BARS + 100, Interval.in_daily)
    usd = align(udf, pos, n, ffill=True) if udf is not None else None
    cdf = fetch(tv, "TRCPI", "ECONOMICS", 400, Interval.in_monthly)
    cpi = [[str(d)[:10], round(float(v), 3)] for d, v in zip(cdf.index, cdf["close"].astype(float))] if cdf is not None else None
    return {"generated": datetime.now(TR).strftime("%Y-%m-%d %H:%M"), "dates": dates, "stocks": {k: {"c": v} for k, v in stocks.items()},
            "index": index, "usdtry": usd, "cpi": cpi, "audit": {"jump_limit": JUMP, "jumps": audit_jumps(dates, stocks, index)}}


def is_stale(path=OUT):
    try:
        g = datetime.strptime(json.loads(Path(path).read_text(encoding="utf-8"))["generated"], "%Y-%m-%d %H:%M").replace(tzinfo=TR)
        return datetime.now(TR) - g > timedelta(days=STALE_DAYS)
    except Exception:
        return True


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--if-stale", action="store_true")
    a = p.parse_args()
    if a.if_stale and not is_stale():
        print("ohlcv_long.json güncel, atlandı")
        return
    names = list(json.loads((HERE / "ohlcv.json").read_text(encoding="utf-8-sig"))["stocks"].keys())
    out = build(names)
    if len(out["stocks"]) < len(names) * 0.9:
        raise SystemExit(f"yalnızca {len(out['stocks'])}/{len(names)} hisse alındı, dosya yazılmadı")
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print("yazıldı:", len(out["stocks"]), "hisse,", len(out["dates"]), "gün,", out["dates"][0], "→", out["dates"][-1], "| şüpheli sıçrama:", len(out["audit"]["jumps"]))


if __name__ == "__main__":
    main()
