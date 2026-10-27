"""Dış veri kaynakları (ücretsiz, gecikmeli): günde bir kez, kapanıştan sonra çalışır.
1) VİOP vadeli primi (TradingView 'HİSSE1!'): akıllı para / pozisyonlanma vekili → viop.json
2) Haber ilgisi ve tonu (Google Haberler RSS, hisse başına): kalabalık dikkati vekili → newsmood.json (+ newsmood_log.json: ileride doğrulama için günlük kayıt)
3) Jeopolitik ton ve hacim (GDELT, Türkiye + çatışma/yaptırım/kriz): makro kalkanın jeopolitik girdisi → geo.json
Kullanım: python extdata.py [--only viop|news|geo] [--force]
Lisans notu: aracı kurum dağılımı (AKD) ve takas verisi Borsa İstanbul'un lisanslı verisidir (2025'ten beri ücretli); herkese açık sitede yayınlanamaz. Bu yüzden
kullanıcıya özel, yalnızca tarayıcıda saklanan CSV içe aktarma (Akıllı Para) ayrıca sunulur."""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import fetcher
from freshness import is_fresh
from viop_research import expiry_after

HERE = Path(__file__).parent
UA = {"User-Agent": "Mozilla/5.0 (compatible; BorsaKomitesi/1.0)"}


def http(url, to=30):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=to).read().decode("utf-8", "replace")


def fresh(name, hours=20):
    # içerik damgası (ts/date): mtime GitHub Actions'ta her çalışmada "şimdi" olur ve bu işleri hiç çalıştırmazdı (freshness.py)
    return is_fresh(HERE / name, hours * 3600)


# ---------------- 1) VİOP ----------------
def run_viop(force=False):
    if not force and fresh("viop.json", 6):
        print("viop.json güncel."); return
    from tvDatafeed import Interval, TvDatafeed
    snap = fetcher.fetch_snapshot()["stocks"]
    names = fetcher.liquid_names(snap, min_tl=5, cap=220)
    vr = HERE / "viop_research.json"
    if vr.exists():  # vadelisi olan hisseler araştırmada biliniyor; boşuna 200+ sembol denenmesin
        known = json.loads(vr.read_text(encoding="utf-8")).get("names") or []
        if len(known) >= 10:
            names = [n for n in names if n in known] or known
    spot = {s["name"]: s["close"] for s in snap if s.get("close")}
    tv = TvDatafeed()
    r = tv.get_hist("TR02Y", "TVC", interval=Interval.in_daily, n_bars=3)
    rate = float(r["close"].iloc[-1]) / 100 if r is not None and len(r) else 0.35
    today = datetime.now().date(); exp = expiry_after(today); T = max((exp - today).days, 1)
    carry = rate * T / 365
    out = {}
    for k, n in enumerate(names, 1):
        df = None
        for _ in range(2):
            try:
                df = tv.get_hist(f"{n}1!", "BIST", interval=Interval.in_daily, n_bars=25)
                if df is not None and len(df) >= 5:
                    break
            except Exception:
                pass
            time.sleep(0.4)
        if df is not None and len(df) >= 5 and spot.get(n):
            f = float(df["close"].iloc[-1]); b = f / spot[n] - 1
            if abs(b) < 0.25:
                vol = df["volume"].astype(float)
                out[n] = {"fut": round(f, 4), "basis": round(b * 100, 2), "excess": round((b - carry) * 100, 2), "vol": int(vol.iloc[-1]), "vol_ratio": round(float(vol.iloc[-1] / max(vol.iloc[:-1].mean(), 1)), 2)}
        if k % 25 == 0:
            tv = TvDatafeed()
    # endeks vadelisi (XU030)
    idx = None
    try:
        d = tv.get_hist("XU030D1!", "BIST", interval=Interval.in_daily, n_bars=3); s = tv.get_hist("XU030", "BIST", interval=Interval.in_daily, n_bars=3)
        if d is not None and s is not None:
            b = float(d["close"].iloc[-1] / s["close"].iloc[-1] - 1); idx = {"basis": round(b * 100, 2), "excess": round((b - carry) * 100, 2)}
    except Exception:
        pass
    res = {"ts": int(time.time()), "date": str(today), "expiry": str(exp), "days": T, "rate": round(rate * 100, 2), "carry_pct": round(carry * 100, 2), "index": idx, "stocks": out}
    (HERE / "viop.json").write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"viop.json: {len(out)} hisse vadelisi, vade {exp}, taşıma %{carry * 100:.1f}")


# ---------------- 2) Haber ilgisi / tonu ----------------
POS = ["rekor", "artış", "yükseliş", "büyüme", "kâr", "kar payı", "temettü", "hedef fiyat", "al tavsiyesi", "güçlü", "yatırım", "sipariş", "ihale", "anlaşma", "onay", "bedelsiz", "geri alım", "ihracat", "olumlu"]
NEG = ["düşüş", "zarar", "ceza", "dava", "soruşturma", "iflas", "konkordato", "satış tavsiyesi", "gerileme", "kriz", "yaptırım", "borç", "uyarı", "iptal", "olumsuz", "dip", "çöktü", "tedbir", "işlem yasağı", "açığa satış"]


def tone(title):
    t = title.lower().replace("İ", "i").replace("I", "ı")
    p = sum(1 for w in POS if w in t); n = sum(1 for w in NEG if w in t)
    return p - n


def rss(q):
    x = http("https://news.google.com/rss/search?q=" + urllib.parse.quote(q) + "&hl=tr&gl=TR&ceid=TR:tr")
    out = []
    for it in ET.fromstring(x).findall(".//item"):
        try:
            ts = parsedate_to_datetime(it.find("pubDate").text).timestamp()
        except Exception:
            continue
        out.append((ts, (it.find("title").text or "")))
    return out


def run_news(force=False):
    if not force and fresh("newsmood.json", 6):
        print("newsmood.json güncel."); return
    snap = fetcher.fetch_snapshot()["stocks"]
    names = fetcher.liquid_names(snap, min_tl=10, cap=120)
    desc = {s["name"]: s.get("description") or s["name"] for s in snap}
    now = time.time(); out = {}
    for k, n in enumerate(names, 1):
        try:
            items = rss(f"{n} hisse")
        except Exception:
            time.sleep(1); continue
        items = [(ts, t) for ts, t in items if n.lower() in t.lower() or desc[n].split()[0].lower() in t.lower()]
        d1 = [(ts, t) for ts, t in items if now - ts < 86400]; d7 = [(ts, t) for ts, t in items if now - ts < 7 * 86400]
        if not d7:
            continue
        base = max(len(d7) / 7, 0.5)
        out[n] = {"n1": len(d1), "n7": len(d7), "attn": round(len(d1) / base, 2), "tone7": round(sum(tone(t) for _, t in d7) / len(d7), 2), "tone1": round(sum(tone(t) for _, t in d1) / len(d1), 2) if d1 else None, "top": (d1 or d7)[0][1][:110]}
        time.sleep(0.35)
    # piyasa geneli jeopolitik/makro anahtar kelime yoğunluğu (Google Haberler)
    mk = {}
    for key, q in (("jeo", "Türkiye jeopolitik gerilim savaş yaptırım"), ("makro", "TCMB faiz kararı enflasyon borsa"), ("borsa", "Borsa İstanbul BIST 100")):
        try:
            it = rss(q); d1 = [t for ts, t in it if now - ts < 86400]; d7 = [t for ts, t in it if now - ts < 7 * 86400]
            mk[key] = {"n1": len(d1), "n7": len(d7), "tone7": round(sum(tone(t) for t in d7) / max(len(d7), 1), 2)}
        except Exception:
            pass
        time.sleep(0.5)
    res = {"ts": int(time.time()), "date": datetime.now().strftime("%Y-%m-%d %H:%M"), "stocks": out, "market": mk}
    (HERE / "newsmood.json").write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    # günlük kayıt: ileride (≥ 30 gün) haber ilgisinin sonraki getiriyi öngörüp öngörmediğini ölçmek için
    lf = HERE / "newsmood_log.json"
    log = json.loads(lf.read_text(encoding="utf-8")) if lf.exists() else {"days": []}
    d = datetime.now().strftime("%Y-%m-%d")
    log["days"] = [x for x in log["days"] if x["d"] != d] + [{"d": d, "s": {n: [v["n1"], v["attn"], v["tone7"]] for n, v in out.items()}, "m": mk}]
    log["days"] = log["days"][-120:]
    lf.write_text(json.dumps(log, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"newsmood.json: {len(out)} hisse haber ilgisi")


# ---------------- 3) GDELT jeopolitik ----------------
def run_geo(force=False):
    if not force and fresh("geo.json", 18):
        print("geo.json güncel."); return
    q = urllib.parse.quote("Turkey (war OR conflict OR sanctions OR attack OR crisis)")
    end = datetime.now(timezone.utc); start = end - timedelta(days=420)
    rng = f"&startdatetime={start.strftime('%Y%m%d')}000000&enddatetime={end.strftime('%Y%m%d')}235959"
    res = {}
    for mode, key in (("timelinetone", "tone"), ("timelinevolraw", "vol")):
        for attempt in range(5):
            try:
                j = json.loads(http(f"https://api.gdeltproject.org/api/v2/doc/doc?query={q}&mode={mode}&format=json{rng}", 60))
                res[key] = [[d["date"][:8], round(float(d["value"]), 3)] for d in j["timeline"][0]["data"]]
                break
            except Exception as e:
                time.sleep(12 + 6 * attempt)
        time.sleep(6)
    if "tone" not in res:
        print("GDELT alınamadı (hız sınırı); önceki dosya korunur."); return
    res["ts"] = int(time.time())
    tone_s = [v for _, v in res["tone"]]; vol_s = [v for _, v in res.get("vol", [])]
    z = lambda a, n=30: (a[-1] - sum(a[-n:]) / min(n, len(a))) / ((sum((x - sum(a[-n:]) / min(n, len(a))) ** 2 for x in a[-n:]) / min(n, len(a))) ** 0.5 or 1) if len(a) >= 5 else None
    res["now"] = {"date": res["tone"][-1][0], "tone": tone_s[-1], "tone_z30": round(z(tone_s), 2) if z(tone_s) is not None else None, "vol_z30": round(z(vol_s), 2) if vol_s and z(vol_s) is not None else None}
    (HERE / "geo.json").write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("geo.json:", res["now"])


def main():
    a = sys.argv[1:]
    only = a[a.index("--only") + 1] if "--only" in a else None
    force = "--force" in a
    for name, fn in (("viop", run_viop), ("news", run_news), ("geo", run_geo)):
        if only and only != name:
            continue
        try:
            fn(force)
        except Exception as e:
            print(f"{name} başarısız:", e)


if __name__ == "__main__":
    main()

