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

# Çok zamanlı tarama: günlük (|1 yok), haftalık (|1W), aylık (|1M). Ek ad: günlük "", haftalık "_w", aylık "_m".
MTF_BASES = {
    "RSI": "rsi", "MACD.macd": "macd", "MACD.signal": "macds", "ADX": "adx", "ADX+DI": "pdi", "ADX-DI": "mdi",
    "SMA20": "sma20", "SMA50": "sma50", "ChaikinMoneyFlow": "cmf", "MoneyFlow": "mfi", "Stoch.K": "stk", "Stoch.D": "std",
    "Mom": "mom", "CCI20": "cci", "AO": "ao", "Recommend.All": "rec", "Recommend.MA": "recma", "Recommend.Other": "recosc",
    "Ichimoku.BLine": "ichb", "P.SAR": "psar", "BB.upper": "bbu", "BB.lower": "bbl", "BBPower": "bbp", "UO": "uo", "W.R": "wr", "VWMA": "vwma",
}
MTF_EXTRA = {"SMA200|1W": "sma200_w", "EMA20": "ema20", "EMA50": "ema50", "EMA200": "ema200", "High.6M": "h6m", "Low.6M": "l6m", "Perf.Y": "py", "Perf.YTD": "pytd",
             "float_shares_percent_current": "ff", "average_volume_10d_calc": "av10", "average_volume_30d_calc": "av30", "average_volume_60d_calc": "av60",
             "average_volume_90d_calc": "av90", "volume_change": "vchg", "gap": "gap", "Volatility.W": "volw", "Volatility.M": "volm", "KltChnl.upper": "kcu", "KltChnl.lower": "kcl",
             "DonchCh20.Upper": "dcu", "DonchCh20.Lower": "dcl", "Aroon.Up": "aru", "Aroon.Down": "ard", "Pivot.M.Classic.R1": "pr1", "Pivot.M.Classic.S1": "ps1", "Pivot.M.Classic.Middle": "pmid"}
for _tf, _sfx in (("", ""), ("|1W", "_w"), ("|1M", "_m")):
    for _b, _k in MTF_BASES.items():
        if _tf == "" and _k in ("sma20", "sma50", "rsi", "adx", "bbu", "bbl"):
            continue  # günlükte zaten var
        COLUMNS.append(_b + _tf)
        RENAME[_b + _tf] = _k + _sfx
MTF_EXTRA.update({"net_income_fq_h": "niqh", "total_debt_fq_h": "dbth", "free_cash_flow_fq_h": "fcfh", "total_equity_fq": "eqq", "total_equity_fy": "eqy_", "net_debt_fq": "nd"})  # bilanço geçmişi (çeyreklik diziler türetilip atılır)
MTF_EXTRA.update({"first_bar_time": "fbt", "ipo_offer_price": "ipop", "ipo_offer_price_performance": "ipoperf", "ipo_market_cap": "ipomc"})  # bebek hisse (yeni halka arz) alanları
for _b, _k in MTF_EXTRA.items():
    COLUMNS.append(_b)
    RENAME[_b] = _k


def _fin(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and x == x and abs(x) != float("inf")


def _derive_fundamentals(st: dict) -> None:
    """Çeyreklik geçmiş dizilerinden küçük özet alanlar türetir (dizi JSON'a yazılmaz):
    nipos8 = son 8 çeyrekte net kârı pozitif olan sayısı; fcfpos4 = son 4 çeyrekte serbest nakit akışı pozitif sayısı;
    nig4 = son 4 çeyrek net kâr / önceki 4 çeyrek − 1; dbtg = borcun 4 çeyrek öncesine göre değişimi; eqg = özsermayenin yıl sonuna göre değişimi."""
    ni, db, fc = st.pop("niqh", None), st.pop("dbth", None), st.pop("fcfh", None)
    eq, eqy = st.pop("eqq", None), st.pop("eqy_", None)
    st["nipos8"] = st["fcfpos4"] = st["nig4"] = st["dbtg"] = st["eqg"] = None
    try:
        if isinstance(ni, list) and len(ni) >= 6:
            v = ni[:8]; st["nipos8"] = sum(1 for x in v if _fin(x) and x > 0)
            a, b = [x for x in ni[:4] if _fin(x)], [x for x in ni[4:8] if _fin(x)]
            if len(a) == 4 and len(b) == 4 and sum(b) > 0:
                st["nig4"] = round(sum(a) / sum(b) - 1, 4)
        if isinstance(fc, list) and len(fc) >= 4:
            st["fcfpos4"] = sum(1 for x in fc[:4] if _fin(x) and x > 0)
        if isinstance(db, list) and len(db) >= 5 and _fin(db[0]) and _fin(db[4]) and db[4] > 0:
            st["dbtg"] = round(db[0] / db[4] - 1, 4)
        if _fin(eq) and _fin(eqy) and eq > 0 and eqy > 0:
            st["eqg"] = round(eq / eqy - 1, 4)
    except Exception:
        pass


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
    for st in stocks:
        _derive_fundamentals(st)
    if not stocks:
        raise RuntimeError("TradingView boş veri döndürdü")
    return {"ts": int(time.time()), "generated": datetime.now(TZ).strftime("%Y-%m-%d %H:%M"),
            "stocks": stocks, "error": None}


def _round_sig(x):
    if x is None or isinstance(x, (str, bool)):
        return x
    if x == 0:
        return 0
    d = max(0, 4 - int(math.floor(math.log10(abs(x)))))
    return round(x, min(d, 6))


def fetch_wide() -> dict:
    """TradingView'in tüm (kapsamı yeterli) göstergelerini ve temel verilerini sütun-sütun döndürür (Tarayıcı sayfası için)."""
    import json as _json
    from pathlib import Path as _P
    ids = _json.loads((_P(__file__).parent / "screener_fields.json").read_text(encoding="utf-8"))
    names, cols = None, {}
    text_cols = ["description", "sector", "industry"]
    batches = [ids[i:i + 150] for i in range(0, len(ids), 150)]
    for k, batch in enumerate(batches):
        sel = ["name"] + (text_cols if k == 0 else []) + batch
        _, df = Query().set_markets("turkey").select(*sel).order_by("volume", ascending=False).limit(1500).get_scanner_data()
        if names is None:
            names = df["name"].tolist()
            for c in text_cols:
                cols[c] = [None if (v is None or (isinstance(v, float) and math.isnan(v))) else v for v in df[c].tolist()]
        elif df["name"].tolist() != names:  # sıralama farklıysa isme göre hizala
            df = df.set_index("name").reindex(names).reset_index()
        for c in batch:
            if c in df.columns:
                cols[c] = [None if (v is None or (isinstance(v, float) and math.isnan(v))) else _round_sig(v) for v in df[c].tolist()]
    return {"ts": int(time.time()), "generated": datetime.now(TZ).strftime("%Y-%m-%d %H:%M"), "names": names, "f": cols}
