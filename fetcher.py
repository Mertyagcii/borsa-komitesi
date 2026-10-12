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
    "return_on_equity": "roe", "return_on_assets": "roa", "debt_to_equity": "de", "free_cash_flow_ttm": "fcf",
    "current_ratio": "cr", "net_margin_ttm": "nm", "operating_margin_ttm": "om", "total_revenue_yoy_growth_ttm": "revg",
    "earnings_per_share_diluted_yoy_growth_ttm": "epsg", "earnings_per_share_diluted_ttm": "eps",
    "book_value_per_share_fq": "bvps", "dividends_yield_current": "dy", "VWAP": "vwap", "High.1M": "h1m",
    "Low.1M": "l1m", "High.3M": "h3m", "price_52_week_high": "h52", "price_52_week_low": "l52", "Perf.W": "pw",
    "Perf.1M": "p1m", "Perf.3M": "p3m", "Perf.6M": "p6m", "SMA20": "sma20", "SMA200": "sma200", "high": "hi",
    "low": "lo", "ADX": "adx", "beta_1_year": "beta", "enterprise_value_ebitda_ttm": "evebitda",
    "earnings_release_next_date": "nextEarn", "ex_dividend_date_upcoming": "exDiv",
    "open": "open", "gross_margin_ttm": "gm", "total_debt_fq": "debt", "ebitda_ttm": "ebitda", "cash_n_short_term_invest_fq": "cash",
}
COLUMNS = [
    "name", "description", "sector", "close", "volume", "change", "SMA50", "BB.lower", "BB.upper",
    "RSI", "relative_volume_10d_calc", "ATR", "price_earnings_ttm", "price_book_fq", "market_cap_basic",
    "return_on_equity", "return_on_assets", "debt_to_equity", "free_cash_flow_ttm", "current_ratio", "net_margin_ttm",
    "operating_margin_ttm", "total_revenue_yoy_growth_ttm", "earnings_per_share_diluted_yoy_growth_ttm",
    "earnings_per_share_diluted_ttm", "book_value_per_share_fq", "dividends_yield_current", "VWAP", "High.1M",
    "Low.1M", "High.3M", "price_52_week_high", "price_52_week_low", "Perf.W", "Perf.1M", "Perf.3M", "Perf.6M",
    "SMA20", "SMA200", "high", "low", "ADX", "beta_1_year", "enterprise_value_ebitda_ttm",
    "earnings_release_next_date", "ex_dividend_date_upcoming",
    "open", "gross_margin_ttm", "total_debt_fq", "ebitda_ttm", "cash_n_short_term_invest_fq",
]


def clean(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return round(v, 4) if isinstance(v, float) else v


def liquid_names(stocks: list[dict], min_tl: float = 30, cap: int = 150) -> list[str]:
    """Günlük işlem hacmi (milyon TL) yüksek hisselerin adları: geçmiş ve haber bunlar için çekilir."""
    rows = [(s["close"] * s["volume"] / 1e6, s["name"]) for s in stocks if s.get("close") and s.get("volume")]
    return [n for tl, n in sorted(rows, reverse=True) if tl >= min_tl][:cap]


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
