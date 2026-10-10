"""TradingView haber akışından (Türkçe, KAP/Matriks vb.) hisse başlıkları ve basit anahtar kelime skoru."""
from concurrent.futures import ThreadPoolExecutor

import requests

URL = "https://news-headlines.tradingview.com/v2/headlines"
HEADERS = {"User-Agent": "Mozilla/5.0", "Origin": "https://www.tradingview.com",
           "Referer": "https://www.tradingview.com/"}
MAX_ITEMS = 6
WINDOW_DAYS = 10

POS = ["kâr", "kar payı", "temettü", "bedelsiz", "geri alım", "sipariş", "ihale kazan", "yeni sözleşme",
       "sözleşme imza", "rekor", "artırdı", "yükseltti", "beklentilerin üzerinde", "güçlü", "onay"]
NEG = ["zarar", "ceza", "soruşturma", "dava", "iflas", "konkordato", "düşürdü", "indirdi",
       "beklentilerin altında", "iptal", "işlem yasağı", "tedbir", "temerrüt", "azaldı", "geriledi"]


def tr_lower(s: str) -> str:
    return s.replace("İ", "i").replace("I", "ı").lower()


def score_title(title: str) -> int:
    t = tr_lower(title)
    return sum(k in t for k in POS) - sum(k in t for k in NEG)


def fetch_one(name: str, now: float) -> dict:
    try:
        r = requests.get(URL, params={"client": "web", "lang": "tr", "section": "", "streaming": "false",
                                      "symbol": f"BIST:{name}"}, headers=HEADERS, timeout=15)
        r.raise_for_status()
        items = r.json().get("items", [])
    except Exception:
        return {"ok": False, "items": [], "score": 0}
    out, total = [], 0
    for it in items[:MAX_ITEMS]:
        s = score_title(it.get("title", ""))
        fresh = now - it.get("published", 0) <= WINDOW_DAYS * 86400
        if fresh:
            total += s
        out.append({"t": it.get("title", ""), "ts": it.get("published", 0), "src": it.get("source", ""), "s": s})
    return {"ok": True, "items": out, "score": total}


def fetch_news(names: list[str], now: float) -> dict:
    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(lambda n: fetch_one(n, now), names))
    return dict(zip(names, results))
