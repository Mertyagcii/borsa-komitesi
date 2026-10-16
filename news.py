"""TradingView haber akışından (Türkçe) hisse başlıkları: KAP bildirimleri (provider=kap), aracı kurum raporları/görüşleri (Matriks üzerinden) ve Reuters.
Her başlık için sağlayıcı (p) ve ilişkili sembol sayısı (rel; küçükse haber/rapor doğrudan bu hisseyle ilgilidir) saklanır; duygu puanı arayüzde (core.js) hesaplanır."""
import time
from concurrent.futures import ThreadPoolExecutor

import requests

URL = "https://news-headlines.tradingview.com/v2/headlines"
HEADERS = {"User-Agent": "Mozilla/5.0", "Origin": "https://www.tradingview.com",
           "Referer": "https://www.tradingview.com/"}
MAX_ITEMS = 16
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
    items = None
    for attempt in range(3):  # hız sınırı (429) ve geçici hatalara karşı yeniden dene
        try:
            r = requests.get(URL, params={"client": "web", "lang": "tr", "section": "", "streaming": "false",
                                          "symbol": f"BIST:{name}"}, headers=HEADERS, timeout=15)
            if r.status_code == 429:
                time.sleep(2 + 3 * attempt)
                continue
            r.raise_for_status()
            items = r.json().get("items", [])
            break
        except Exception:
            time.sleep(1 + attempt)
    if items is None:
        return {"ok": False, "items": [], "score": 0}
    out, total = [], 0
    # KAP bildirimleri ve doğrudan bu hisseyle ilgili haberler önce; sonra çok sembollü piyasa/sektör raporları
    items = sorted(items, key=lambda it: (it.get("provider") != "kap", len(it.get("relatedSymbols") or []) > 3, -it.get("published", 0)))
    for it in items[:MAX_ITEMS]:
        s = score_title(it.get("title", ""))
        fresh = now - it.get("published", 0) <= WINDOW_DAYS * 86400
        if fresh:
            total += s
        out.append({"t": it.get("title", ""), "ts": it.get("published", 0), "src": it.get("source", ""), "p": it.get("provider", ""),
                    "rel": len(it.get("relatedSymbols") or []), "s": s})
    out.sort(key=lambda x: -x["ts"])
    return {"ok": True, "items": out, "score": total}


def fetch_news(names: list[str], now: float) -> dict:
    with ThreadPoolExecutor(max_workers=5) as ex:
        results = list(ex.map(lambda n: fetch_one(n, now), names))
    return dict(zip(names, results))
