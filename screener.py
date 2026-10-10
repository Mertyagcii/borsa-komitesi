"""BIST tarayıcı: TradingView verisiyle Bollinger alt bandı / SMA50 durumlarını filtreler."""
import argparse

import pandas as pd
from tradingview_screener import Query, col

COLUMNS = [
    "name", "description", "close", "volume", "SMA50", "BB.lower", "BB.upper", "RSI",
    "change", "relative_volume_10d_calc", "ATR",
    "price_earnings_ttm", "price_book_fq", "market_cap_basic", "sector",
]


def fetch_bist(min_volume: int = 100_000, limit: int = 1000) -> pd.DataFrame:
    """BIST hisselerinin günlük verilerini çeker."""
    _, df = (
        Query()
        .set_markets("turkey")
        .select(*COLUMNS)
        .where(col("volume") > min_volume)
        .order_by("volume", ascending=False)
        .limit(limit)
        .get_scanner_data()
    )
    return df


def add_signals(df: pd.DataFrame, bb_tolerance: float = 0.02) -> pd.DataFrame:
    """Bollinger alt bant ve SMA50 durum sütunlarını ekler."""
    df = df.dropna(subset=["close", "SMA50", "BB.lower", "BB.upper"]).copy()
    df["bb_lower_dist_pct"] = (df["close"] / df["BB.lower"] - 1) * 100
    df["sma50_dist_pct"] = (df["close"] / df["SMA50"] - 1) * 100
    df["near_bb_lower"] = df["close"] <= df["BB.lower"] * (1 + bb_tolerance)
    df["above_sma50"] = df["close"] > df["SMA50"]
    return df


def scan(
    min_volume: int = 100_000,
    bb_tolerance: float = 0.02,
    sma50: str = "any",
    max_rsi: float | None = None,
) -> pd.DataFrame:
    """Alt banda yakın/altındaki hisseleri döndürür. sma50: 'above' | 'below' | 'any'."""
    df = add_signals(fetch_bist(min_volume), bb_tolerance)
    df = df[df["near_bb_lower"]]
    if sma50 == "above":
        df = df[df["above_sma50"]]
    elif sma50 == "below":
        df = df[~df["above_sma50"]]
    if max_rsi is not None:
        df = df[df["RSI"] <= max_rsi]
    return df.sort_values("bb_lower_dist_pct").reset_index(drop=True)


def main() -> None:
    p = argparse.ArgumentParser(description="BIST Bollinger alt bant / SMA50 tarayıcı")
    p.add_argument("--min-volume", type=int, default=100_000)
    p.add_argument("--tolerance", type=float, default=0.02, help="Alt banda yakınlık oranı (0.02 = %%2)")
    p.add_argument("--sma50", choices=["above", "below", "any"], default="any")
    p.add_argument("--max-rsi", type=float, default=None)
    p.add_argument("--csv", help="Sonucu CSV olarak kaydet")
    args = p.parse_args()

    result = scan(args.min_volume, args.tolerance, args.sma50, args.max_rsi)
    if result.empty:
        print("Kriterlere uyan hisse bulunamadı.")
        return
    cols = ["name", "close", "BB.lower", "bb_lower_dist_pct", "SMA50", "sma50_dist_pct", "RSI", "volume"]
    with pd.option_context("display.width", 200, "display.float_format", "{:.2f}".format):
        print(result[cols].to_string(index=False))
    print(f"\n{len(result)} hisse bulundu.")
    if args.csv:
        result.to_csv(args.csv, index=False, encoding="utf-8-sig")


if __name__ == "__main__":
    main()
