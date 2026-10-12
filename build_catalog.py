"""TradingView alan kataloğu: fields.json (id, Türkçe etiket, grup) ve screener_fields.json (çekilecek alanlar).
Bir kez çalıştırılır (alan listesi nadiren değişir): python build_catalog.py
Girdi: scratch_fields.json (metainfo) ve scratch_keep.json (BIST'te verisi olan alanlar)."""
import json
import re
from pathlib import Path

HERE = Path(__file__).parent

# ---- Elle yazılmış etiketler (en çok kullanılan alanlar) ----
LAB = {
    "close": "Fiyat (kapanış)", "open": "Açılış", "high": "Gün en yüksek", "low": "Gün en düşük", "change": "Günlük değişim %", "change_abs": "Günlük değişim (TL)",
    "change_from_open": "Açılıştan değişim %", "gap": "Gap %", "gap_up": "Yukarı gap %", "gap_down": "Aşağı gap %", "volume": "Hacim (adet)", "volume_change": "Hacim değişimi %",
    "relative_volume_10d_calc": "Göreceli hacim (10 gün)", "relative_volume_intraday": "Göreceli hacim (gün içi)", "average_volume_10d_calc": "Ort. hacim (10 gün)",
    "average_volume_30d_calc": "Ort. hacim (30 gün)", "average_volume_60d_calc": "Ort. hacim (60 gün)", "average_volume_90d_calc": "Ort. hacim (90 gün)",
    "market_cap_basic": "Piyasa değeri", "price_earnings_ttm": "F/K (12 ay)", "price_book_fq": "PD/DD", "price_sales_current": "Fiyat/Satış", "price_free_cash_flow_ttm": "Fiyat/Serbest nakit akışı",
    "enterprise_value_ebitda_ttm": "FD/FAVÖK", "enterprise_value_current": "Firma değeri", "earnings_per_share_diluted_ttm": "Hisse başı kâr (EPS, 12 ay)", "earnings_per_share_basic_ttm": "Hisse başı kâr (temel, 12 ay)",
    "book_value_per_share_fq": "Defter değeri / hisse", "book_value_per_share_current": "Defter değeri / hisse (güncel)", "return_on_equity": "Özsermaye getirisi ROE %", "return_on_assets": "Aktif getirisi ROA %",
    "return_on_invested_capital": "Yatırılan sermaye getirisi ROIC %", "net_margin_ttm": "Net kâr marjı % (12 ay)", "gross_margin_ttm": "Brüt marj % (12 ay)", "operating_margin_ttm": "Faaliyet marjı % (12 ay)",
    "debt_to_equity": "Borç/Özsermaye", "current_ratio": "Cari oran", "quick_ratio": "Asit-test oranı", "free_cash_flow_ttm": "Serbest nakit akışı (12 ay)", "dividends_yield_current": "Temettü verimi %",
    "dividends_yield": "Temettü verimi % (yıllık)", "total_revenue_yoy_growth_ttm": "Gelir büyümesi % (yıllık)", "earnings_per_share_diluted_yoy_growth_ttm": "EPS büyümesi % (yıllık)", "net_income_yoy_growth_ttm": "Net kâr büyümesi % (yıllık)",
    "beta_1_year": "Beta (1 yıl)", "total_debt_fq": "Toplam borç", "ebitda_ttm": "FAVÖK (12 ay)", "net_income_ttm": "Net kâr (12 ay)", "total_assets_fq": "Toplam varlık", "total_equity_fq": "Özsermaye",
    "cash_n_short_term_invest_fq": "Nakit ve kısa vadeli yatırımlar", "float_shares_outstanding_current": "Halka açık hisse adedi", "total_shares_outstanding_fundamental": "Toplam hisse adedi",
    "price_52_week_high": "52 hafta zirvesi", "price_52_week_low": "52 hafta dibi", "Perf.W": "Haftalık performans %", "Perf.1M": "1 aylık performans %", "Perf.3M": "3 aylık performans %",
    "Perf.6M": "6 aylık performans %", "Perf.Y": "1 yıllık performans %", "Perf.YTD": "Yıl başından beri %", "Perf.5Y": "5 yıllık performans %", "Perf.All": "Tüm zamanlar performans %",
    "High.1M": "1 aylık zirve", "Low.1M": "1 aylık dip", "High.3M": "3 aylık zirve", "Low.3M": "3 aylık dip", "High.6M": "6 aylık zirve", "Low.6M": "6 aylık dip", "High.All": "Tüm zamanların zirvesi", "Low.All": "Tüm zamanların dibi",
    "RSI": "RSI (14)", "MACD.macd": "MACD", "MACD.signal": "MACD sinyal", "MACD.hist": "MACD histogram", "Stoch.K": "Stokastik %K", "Stoch.D": "Stokastik %D", "Stoch.RSI.K": "Stokastik RSI %K", "Stoch.RSI.D": "Stokastik RSI %D",
    "ADX": "ADX (14)", "ADX+DI": "ADX +DI", "ADX-DI": "ADX −DI", "CCI20": "CCI (20)", "AO": "Awesome osilatör", "Mom": "Momentum (10)", "ROC": "ROC", "W.R": "Williams %R", "UO": "Ultimate osilatör", "BBPower": "Bull/Bear gücü",
    "ATR": "ATR (14)", "ATRP": "ATR %", "ADR": "Ort. günlük aralık", "ADRP": "Ort. günlük aralık %", "VWAP": "VWAP", "VWMA": "VWMA (20)", "P.SAR": "Parabolik SAR", "ChaikinMoneyFlow": "Chaikin para akışı", "MoneyFlow": "Para akışı endeksi (MFI)",
    "BB.upper": "Bollinger üst bant", "BB.lower": "Bollinger alt bant", "BB.basis": "Bollinger orta bant", "KltChnl.upper": "Keltner üst", "KltChnl.lower": "Keltner alt", "KltChnl.basis": "Keltner orta",
    "DonchCh20.Upper": "Donchian (20) üst", "DonchCh20.Lower": "Donchian (20) alt", "DonchCh20.Middle": "Donchian (20) orta", "Aroon.Up": "Aroon yukarı", "Aroon.Down": "Aroon aşağı",
    "Ichimoku.CLine": "Ichimoku dönüş çizgisi", "Ichimoku.BLine": "Ichimoku baz çizgisi", "Ichimoku.Lead1": "Ichimoku öncü A", "Ichimoku.Lead2": "Ichimoku öncü B", "HullMA9": "Hull MA (9)", "HullMA20": "Hull MA (20)", "HullMA200": "Hull MA (200)",
    "Recommend.All": "Teknik öneri (tümü, −1..+1)", "Recommend.MA": "Teknik öneri (hareketli ort.)", "Recommend.Other": "Teknik öneri (osilatörler)", "recommendation_mark": "Analist önerisi (1 al … 5 sat)",
    "price_target_average": "Analist hedef fiyat (ort.)", "price_target_high": "Analist hedef fiyat (yüksek)", "price_target_low": "Analist hedef fiyat (düşük)", "price_target_median": "Analist hedef fiyat (medyan)",
    "Volatility.D": "Oynaklık (günlük)", "Volatility.W": "Oynaklık (haftalık)", "Volatility.M": "Oynaklık (aylık)", "altman_z_score_fy": "Altman Z skoru", "piotroski_f_score_fy": "Piotroski F skoru",
}
TOK = {"price": "fiyat", "earnings": "kazanç", "per": "/", "share": "hisse", "book": "defter", "value": "değer", "return": "getiri", "on": "", "equity": "özsermaye", "assets": "varlık", "total": "toplam",
       "net": "net", "income": "gelir", "revenue": "gelir", "gross": "brüt", "profit": "kâr", "margin": "marj", "operating": "faaliyet", "debt": "borç", "cash": "nakit", "flow": "akış", "free": "serbest",
       "dividend": "temettü", "dividends": "temettü", "yield": "verim", "growth": "büyüme", "yoy": "yıllık", "qoq": "çeyreklik", "estimate": "tahmin", "forecast": "tahmin", "ratio": "oran", "turnover": "devir hızı",
       "long": "uzun", "term": "vadeli", "short": "kısa", "capital": "sermaye", "expenditures": "harcama", "expense": "gider", "expenses": "gider", "tax": "vergi", "interest": "faiz", "ebitda": "FAVÖK", "ebit": "FVÖK",
       "enterprise": "firma", "market": "piyasa", "cap": "değeri", "sales": "satış", "volume": "hacim", "average": "ortalama", "change": "değişim", "perf": "performans", "high": "yüksek", "low": "düşük",
       "target": "hedef", "analyst": "analist", "inventory": "stok", "receivables": "alacaklar", "payables": "borçlar", "goodwill": "şerefiye", "intangibles": "maddi olmayan", "research": "Ar-Ge", "development": "geliştirme",
       "working": "işletme", "per_employee": "çalışan başı", "employee": "çalışan", "employees": "çalışan", "depreciation": "amortisman", "amortization": "itfa", "invested": "yatırılan", "common": "adi", "preferred": "imtiyazlı",
       "stock": "hisse", "shares": "hisse", "outstanding": "dolaşımda", "float": "halka açık", "beta": "beta", "volatility": "oynaklık", "score": "skor", "rank": "sıra", "days": "gün", "period": "dönem",
       "current": "güncel", "quarter": "çeyrek", "annual": "yıllık", "ttm": "12 ay", "fq": "son çeyrek", "fy": "yıllık", "fh": "yarıyıl", "ntm": "gelecek 12 ay", "recent": "son", "upcoming": "yaklaşan", "next": "sonraki",
       "payout": "dağıtım", "buyback": "geri alım", "repurchase": "geri alım", "issuance": "ihraç", "other": "diğer", "operations": "faaliyet", "investing": "yatırım", "financing": "finansman", "activities": "faaliyetleri",
       "minority": "azınlık", "interests": "payları", "deferred": "ertelenmiş", "liabilities": "yükümlülük", "liability": "yükümlülük", "accounts": "hesaplar", "notes": "senet", "fixed": "duran", "property": "mülk", "plant": "tesis",
       "equipment": "ekipman", "ppe": "MTD", "pretax": "vergi öncesi", "diluted": "seyreltilmiş", "basic": "temel", "continuing": "sürdürülen", "discontinued": "durdurulan", "gain": "kazanç", "loss": "kayıp",
       "sell": "satış", "gen": "genel", "admin": "yönetim", "cost": "maliyet", "goods": "mal", "sold": "satılan", "cogs": "SMM", "surprise": "sürpriz", "percent": "yüzde", "calc": "", "fundamental": "", "basic_shares": "temel hisse"}
SUF = {"fq": "son çeyrek", "fy": "yıllık", "ttm": "12 ay", "fh": "yarıyıl", "ntm": "gelecek 12 ay", "current": "güncel"}
TFN = {"60": "1 saatlik", "240": "4 saatlik", "1W": "haftalık", "1M": "aylık", "1": "1 dk", "5": "5 dk", "15": "15 dk", "30": "30 dk", "120": "2 saatlik"}


def pretty(fid: str) -> str:
    toks = re.split(r"[_.]", fid)
    out = []
    for t in toks:
        out.append(TOK.get(t.lower(), t))
    lab = " ".join(x for x in out if x)
    return lab[:1].upper() + lab[1:]


def group_of(fid: str, base_is_indicator: bool) -> str:
    f = fid.lower()
    if base_is_indicator:
        if f.startswith("candle."):
            return "Teknik: mum formasyonları"
        if f.startswith(("recommend", "rec.")):
            return "Teknik: öneri"
        if f.startswith(("ema", "sma", "hullma", "vwma", "vwap", "ichimoku", "p.sar", "kltchnl", "bb.", "donch")):
            return "Teknik: hareketli ort. ve bantlar"
        if f.startswith("pivot"):
            return "Teknik: pivot seviyeleri"
        if f.startswith(("volume", "average_volume", "relative_volume", "chaikin", "moneyflow", "volume_change")):
            return "Hacim ve likidite"
        if f.startswith(("close", "open", "high", "low", "change", "gap", "pre_", "post_", "bars", "indicators", "last_bar")):
            return "Fiyat ve değişim"
        return "Teknik: osilatörler"
    if f.startswith("perf") or "52_week" in f or f.startswith(("high.", "low.", "price_target")) and False:
        return "Performans"
    if any(k in f for k in ("volume", "float", "shares_outstanding")):
        return "Hacim ve likidite"
    if any(k in f for k in ("dividend", "yield", "payout")):
        return "Temettü"
    if any(k in f for k in ("estimate", "forecast", "target", "recommend", "surprise", "analyst")):
        return "Analist ve tahminler"
    if any(k in f for k in ("growth", "cagr", "yoy", "qoq")):
        return "Büyüme"
    if any(k in f for k in ("margin", "return_on", "roe", "roa", "roic", "profitab")):
        return "Kârlılık"
    if any(k in f for k in ("price_earnings", "price_book", "price_sales", "price_free", "enterprise_value", "ev_", "peg", "price_cash", "earnings_yield", "market_cap", "tobin", "graham")):
        return "Değerleme"
    if any(k in f for k in ("free_cash", "cash_f", "capital_expend", "operating_cash", "cash_from")):
        return "Nakit akışı"
    if any(k in f for k in ("debt", "equity", "asset", "liabilit", "cash", "inventory", "receivable", "payable", "goodwill", "current_ratio", "quick_ratio", "working_capital")):
        return "Bilanço"
    if any(k in f for k in ("revenue", "income", "ebit", "profit", "expense", "cogs", "sales", "earnings_per_share", "eps", "tax", "interest")):
        return "Gelir tablosu"
    if any(k in f for k in ("beta", "volatil", "altman", "piotroski", "z_score", "risk")):
        return "Risk ve kalite skorları"
    return "Diğer"


def main() -> None:
    meta = json.loads((HERE / "scratch_fields.json").read_text(encoding="utf-8"))
    keep = json.loads((HERE / "scratch_keep.json").read_text(encoding="utf-8"))["kept"]
    cov = json.loads((HERE / "scratch_cov.json").read_text(encoding="utf-8"))["cov"]
    kind = {x["n"]: x.get("t") for x in meta}
    ind_bases = {n.split("|")[0] for n in kept_all(meta) if "|" in n}
    # taban alanlar: kapsaması ≥ 60 olanlar; zaman dilimli: keep listesi
    base = [n for n, c in cov.items() if c >= 60]
    fields = []
    for fid in base + [k for k in keep if "|" in k]:
        tf = None
        b = fid
        if "|" in fid:
            b, tf = fid.split("|")
        is_ind = b in ind_bases
        lab = LAB.get(b) or pretty(b)
        if tf:
            lab = f"{lab} · {TFN.get(tf, tf)}"
        grp = "Teknik: zaman dilimleri (1sa/4sa/hafta/ay)" if tf else group_of(b, is_ind)
        fields.append({"id": fid, "l": lab, "g": grp, "k": kind.get(fid, "number")})
    seen = set(); uniq = []
    for f in fields:
        if f["id"] not in seen:
            seen.add(f["id"]); uniq.append(f)
    (HERE / "fields.json").write_text(json.dumps(uniq, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (HERE / "screener_fields.json").write_text(json.dumps([f["id"] for f in uniq], separators=(",", ":")), encoding="utf-8")
    from collections import Counter
    print(len(uniq), "alan;", Counter(f["g"] for f in uniq).most_common())


def kept_all(meta):
    return [x["n"] for x in meta if x.get("t") in ("number", "price", "percent", "fundamental_price")]


if __name__ == "__main__":
    main()
