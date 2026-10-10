"""TradingView'den BIST verisini çeker (yerel sunucu ve GitHub Actions ortak kullanır)."""
import math
import time
from datetime import datetime

from tradingview_screener import Query, col

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("Europe/Istanbul")
except Exception:  # tzdata yoksa yerel saat
    TZ = None

RENAME = {
    "BB.lower": "bb_lower", "BB.upper": "bb_upper", "SMA50": "sma50", "RSI": "rsi",
    "relative_volume_10d_calc": "rvol", "price_earnings_ttm": "pe", "price_book_fq": "pb",
    "market_cap_basic": "mcap", "ATR": "atr",
}
COLUMNS = [
    "name", "description", "sector", "close", "volume", "change", "SMA50", "BB.lower", "BB.upper",
    "RSI", "relative_volume_10d_calc", "ATR", "price_earnings_ttm", "price_book_fq", "market_cap_basic",
]


def clean(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return round(v, 4) if isinstance(v, float) else v


def fetch_snapshot() -> dict:
    """{ts, generated, stocks, error} döndürür. Hata olursa istisna fırlatır."""
    _, df = (
        Query().set_markets("turkey").select(*COLUMNS)
        .where(col("volume") > 0).order_by("volume", ascending=False).limit(1500)
        .get_scanner_data()
    )
    df = df.drop(columns=["ticker"]).rename(columns=RENAME)
    stocks = [{k: clean(v) for k, v in r.items()} for r in df.to_dict("records")]
    if not stocks:
        raise RuntimeError("TradingView boş veri döndürdü")
    return {"ts": int(time.time()), "generated": datetime.now(TZ).strftime("%Y-%m-%d %H:%M"),
            "stocks": stocks, "error": None}
