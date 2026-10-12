"""Sistem araştırması: hangi sinyallerin BIST'te gerçekten fazla getiri verdiğini ölçer.

TradingView'den likit hisselerin günlük OHLCV verisini çeker (tvdatafeed), sinyalleri ve faktörleri hesaplar,
sonraki 5/10/20 işlem günü getirisini (ertesi gün açılıştan giriş, kapanıştan çıkış) piyasa ortalamasına göre ölçer.
Çıktı: research.json (arayüzdeki "Sistem Araştırması" sayfası ve efsane kuralları bunu kullanır).

Uyarılar: ~3 yıl veri, tek rejim (enflasyonlu nominal TL), hayatta kalma yanlılığı (bugünün likit listesi), maliyet yok.
Bu yüzden sonuçlar KANIT DEĞİL, İPUCU olarak okunmalıdır; yarı-yarıya tutarlılık ve rejim kırılımı bu yüzden raporlanır.
"""
import argparse
import json
import pickle
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

from fetcher import TZ, fetch_snapshot, liquid_names

HERE = Path(__file__).parent
CACHE = HERE / "cache" / "ohlcv.pkl"
OUT = HERE / "research.json"
HORIZONS = (5, 10, 20)
N_BARS = 800


def pull(names: list[str], log=print) -> dict:
    from tvDatafeed import Interval, TvDatafeed
    tv = TvDatafeed()
    data = {}
    for k, n in enumerate(names + ["XU100", "XU030"], 1):
        df = None
        for _ in range(3):
            try:
                df = tv.get_hist(n, "BIST", interval=Interval.in_daily, n_bars=N_BARS)
                if df is not None:
                    break
            except Exception:
                pass
            time.sleep(1)
        if df is not None and len(df) > 300:
            df.index = pd.to_datetime(df.index).normalize()
            data[n] = df[["open", "high", "low", "close", "volume"]].astype(float)
        if k % 25 == 0:
            log(f"[{k}/{len(names) + 2}] ...")
        if k % 10 == 0:
            tv = TvDatafeed()
    return data


def load(force: bool = False, limit: int | None = None, log=print) -> dict:
    if CACHE.exists() and not force:
        return pickle.loads(CACHE.read_bytes())
    names = liquid_names(fetch_snapshot()["stocks"])[:limit]
    log(f"{len(names)} hisse çekiliyor...")
    data = pull(names, log)
    CACHE.parent.mkdir(exist_ok=True)
    CACHE.write_bytes(pickle.dumps(data))
    return data


def frames(data: dict):
    stocks = {k: v for k, v in data.items() if not k.startswith("XU")}
    idx = sorted(set().union(*[set(v.index) for v in stocks.values()]))
    f = {c: pd.DataFrame({k: v[c] for k, v in stocks.items()}).reindex(idx) for c in ("open", "high", "low", "close", "volume")}
    index = None
    for s in ("XU100", "XU030"):
        if s in data:
            index = data[s]["close"].reindex(idx).ffill()
            break
    return f, index


def rsi(c: pd.DataFrame, n: int = 14) -> pd.DataFrame:
    d = c.diff()
    up, dn = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean(), (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / dn.replace(0, np.nan))


def features(f: dict) -> dict:
    C, O, H, L, V = f["close"], f["open"], f["high"], f["low"], f["volume"]
    r1 = C.pct_change()
    sma20, sd20 = C.rolling(20).mean(), C.rolling(20).std(ddof=0)
    sma50, sma200 = C.rolling(50).mean(), C.rolling(200).mean()
    tr = pd.concat([(H - L), (H - C.shift()).abs(), (L - C.shift()).abs()]).groupby(level=0).max() if False else None
    prev = C.shift()
    trv = np.maximum(H - L, np.maximum((H - prev).abs(), (L - prev).abs()))
    atrp = trv.rolling(14).mean() / C
    return {
        "z": (C - sma20) / sd20, "rsi": rsi(C), "sma50": sma50, "sma200": sma200, "C": C, "O": O, "V": V, "r1": r1,
        "mom12_1": C.shift(21) / C.shift(252) - 1, "mom6_1": C.shift(21) / C.shift(126) - 1,
        "mom3": C / C.shift(63) - 1, "mom1": C / C.shift(21) - 1, "mom1w": C / C.shift(5) - 1,
        "dist52": C / C.rolling(252).max() - 1, "vol60": r1.rolling(60).std(), "atrp": atrp,
        "rvol": V / V.rolling(20).mean().shift(1), "hi20": C.shift(1).rolling(20).max(), "lo20": C.shift(1).rolling(20).min(),
        "trend": (C > sma50) & (sma50 > sma200),
    }


def forward(f: dict) -> dict:
    O, C = f["open"], f["close"]
    entry = O.shift(-1)
    return {h: C.shift(-h) / entry - 1 for h in HORIZONS}


def decluster(sig: pd.DataFrame, gap: int) -> pd.DataFrame:
    out = np.zeros(sig.shape, dtype=bool)
    arr = sig.to_numpy(dtype=bool)
    for j in range(arr.shape[1]):
        last = -10**9
        for i in np.flatnonzero(arr[:, j]):
            if i - last >= gap:
                out[i, j] = True
                last = i
    return pd.DataFrame(out, index=sig.index, columns=sig.columns)


def signal_defs(x: dict) -> list[dict]:
    z, rs, rv, C = x["z"], x["rsi"], x["rvol"], x["C"]
    return [
        {"id": "bb_alt", "label": "Bollinger alt bandı (z ≤ −2)", "who": "simons", "sig": z <= -2},
        {"id": "bb_alt_trend", "label": "Alt band + yükselen trend (SMA50>SMA200)", "who": "simons", "sig": (z <= -2) & x["trend"]},
        {"id": "bb_alt_dusen", "label": "Alt band + düşen trend", "who": "livermore", "sig": (z <= -2) & ~x["trend"]},
        {"id": "rsi30", "label": "RSI < 30 (aşırı satım)", "who": "simons", "sig": rs < 30},
        {"id": "kirilim20", "label": "20 günlük zirve kırılımı", "who": "livermore", "sig": C > x["hi20"]},
        {"id": "kirilim20_hacim", "label": "20g zirve kırılımı + hacim ≥ 1,5x", "who": "livermore", "sig": (C > x["hi20"]) & (rv >= 1.5)},
        {"id": "kirilim20_trend", "label": "20g kırılım + hacim + yükselen trend", "who": "livermore", "sig": (C > x["hi20"]) & (rv >= 1.5) & x["trend"]},
        {"id": "yakin52", "label": "52 hafta zirvesine %5 içinde + trend", "who": "livermore", "sig": (x["dist52"] >= -0.05) & x["trend"]},
        {"id": "kellogg_itis", "label": "Günlük ≥ +5% ve hacim ≥ 2x", "who": "kellogg", "sig": (x["r1"] >= 0.05) & (rv >= 2)},
        {"id": "kellogg_itis_kirilim", "label": "Günlük ≥ +4%, hacim ≥ 2x, 20g zirve kırılımı", "who": "kellogg", "sig": (x["r1"] >= 0.04) & (rv >= 2) & (C > x["hi20"])},
        {"id": "dusus_hacim", "label": "Günlük ≤ −5% ve hacim ≥ 2x (panik)", "who": "simons", "sig": (x["r1"] <= -0.05) & (rv >= 2)},
        {"id": "trend_pull", "label": "Yükselen trendde geri çekilme (z ≤ −1,5)", "who": "livermore", "sig": (z <= -1.5) & x["trend"]},
    ]


def factor_defs(x: dict) -> list[dict]:
    return [
        {"id": "mom12_1", "label": "12−1 ay momentum", "who": "livermore", "f": x["mom12_1"]},
        {"id": "mom6_1", "label": "6−1 ay momentum", "who": "livermore", "f": x["mom6_1"]},
        {"id": "mom3", "label": "3 ay momentum", "who": "kellogg", "f": x["mom3"]},
        {"id": "mom1", "label": "1 ay getiri (kısa vadeli tersine dönüş?)", "who": "simons", "f": x["mom1"]},
        {"id": "mom1w", "label": "1 hafta getiri", "who": "simons", "f": x["mom1w"]},
        {"id": "dist52", "label": "52 hafta zirvesine yakınlık", "who": "livermore", "f": x["dist52"]},
        {"id": "dusuk_vol", "label": "Düşük oynaklık (−σ60)", "who": "buffett", "f": -x["vol60"]},
        {"id": "z_ters", "label": "Ortalamadan sapma (−z): ucuzluk", "who": "simons", "f": -x["z"]},
        {"id": "rvol", "label": "Göreceli hacim", "who": "kellogg", "f": x["rvol"]},
        {"id": "atr", "label": "Hareket kapasitesi (ATR%)", "who": "kellogg", "f": x["atrp"]},
    ]


def evaluate_signal(sig: pd.DataFrame, fwd: dict, regime: pd.Series | None, h: int):
    ev = decluster(sig.fillna(False), h)
    rows = []
    dates = ev.index
    mean_day = fwd[h].mean(axis=1)
    ex = fwd[h].sub(mean_day, axis=0)
    mask = ev & ex.notna()
    vals = ex.where(mask).stack().dropna()
    if len(vals) < 15:
        return None
    n = len(vals)
    d = vals.index.get_level_values(0)
    half = d <= d[len(d) // 2]
    t = vals.mean() / (vals.std() / np.sqrt(n)) if vals.std() > 0 else 0
    out = {"n": int(n), "excess": round(float(vals.mean() * 100), 2), "win": round(float((vals > 0).mean() * 100), 1), "t": round(float(t), 2),
           "h1": round(float(vals[half].mean() * 100), 2) if half.any() else None, "h2": round(float(vals[~half].mean() * 100), 2) if (~half).any() else None}
    if regime is not None:
        rg = regime.reindex(d).to_numpy()
        for k in ("bull", "bear"):
            m = rg == k
            out[k] = round(float(vals[m].mean() * 100), 2) if m.sum() >= 8 else None
            out[k + "_n"] = int(m.sum())
    return out


def evaluate_factor(fac: pd.DataFrame, fwd: dict, h: int):
    ex = fwd[h].sub(fwd[h].mean(axis=1), axis=0)
    ics, spreads = [], []
    for i in range(0, len(fac), h):  # örtüşmeyen gözlemler
        a, b = fac.iloc[i], ex.iloc[i]
        m = a.notna() & b.notna()
        if m.sum() < 30:
            continue
        ics.append(a[m].rank().corr(b[m].rank()))
        q = a[m].rank(pct=True)
        spreads.append(b[m][q >= 0.8].mean() - b[m][q <= 0.2].mean())
    if len(ics) < 8:
        return None
    ics, spreads = np.array(ics), np.array(spreads)
    return {"n": int(len(ics)), "ic": round(float(ics.mean()), 3), "t": round(float(ics.mean() / (ics.std() / np.sqrt(len(ics)))), 2),
            "spread": round(float(spreads.mean() * 100), 2), "pos": round(float((ics > 0).mean() * 100), 0)}


HIST_FILE = HERE / "research_history.json"
FUND_DIR = HERE / "fundamentals"


def track_history(res: dict) -> list:
    """Haftalık araştırma geçmişi: her sinyalin karar/t/fazla getirisi. Önceki çalıştırmaya göre karar değişimlerini döndürür."""
    hist = []
    if HIST_FILE.exists():
        try:
            hist = json.loads(HIST_FILE.read_text(encoding="utf-8"))
        except Exception:
            hist = []
    now = {"date": res["generated"][:10], "signals": {s["id"]: {"v": s["verdict"], "t": (s.get("h10") or {}).get("t"), "x": (s.get("h10") or {}).get("excess"), "aging": s.get("aging")} for s in res["signals"]},
           "deciles": res.get("rs_deciles")}
    changes = []
    if hist:
        prev = hist[-1]["signals"]
        for s in res["signals"]:
            a = prev.get(s["id"])
            if a and (a["v"] != s["verdict"] or bool(a.get("aging")) != bool(s.get("aging"))):
                changes.append({"id": s["id"], "label": s["label"], "from": a["v"] + (" (yaşlanıyor)" if a.get("aging") else ""),
                                "to": s["verdict"] + (" (yaşlanıyor)" if s.get("aging") else ""), "date": now["date"]})
    if not hist or hist[-1]["date"] != now["date"]:
        hist.append(now)
    HIST_FILE.write_text(json.dumps(hist[-80:], ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return changes


def pit_eval() -> dict:
    """Noktasal (point-in-time) temel veri testi: haftalık temel veri kayıtları biriktikçe kalite/değer faktörlerinin sonraki dönem getirisini ölçer."""
    files = sorted(FUND_DIR.glob("*.json")) if FUND_DIR.exists() else []
    out = {"snapshots": len(files), "needed": 8, "ready": False, "factors": []}
    if len(files) < 8:
        return out
    snaps = []
    for fp in files:
        d = json.loads(fp.read_text(encoding="utf-8"))
        df = pd.DataFrame(d["rows"], columns=d["cols"]).set_index("name")
        snaps.append((d["d"], df))
    defs = {"roe": ("ROE", 1), "nm": ("Net marj", 1), "gm": ("Brüt marj", 1), "de": ("Düşük borç/özsermaye", -1), "pe": ("Düşük F/K", -1),
            "pb": ("Düşük PD/DD", -1), "upside": ("Adil değere uzaklık (+ ucuz)", 1), "eqg": ("Özsermaye büyümesi (yıl sonuna göre)", 1), "nipos8": ("Kârlı çeyrek sayısı (son 8)", 1), "dbtg": ("Borç artışı (düşük iyi)", -1), "nig4": ("Kâr büyümesi (4 çeyrek)", 1), "fcfy": ("FCF getirisi", 1), "epsg": ("EPS büyümesi", 1), "dy": ("Temettü verimi", 1)}
    for k, (label, sg) in defs.items():
        ics = []
        for (d0, a), (d1, b) in zip(snaps[:-1], snaps[1:]):
            a = a.copy()
            a["fcfy"] = a["fcf"] / a["mcap"] * 100 if "fcf" in a and "mcap" in a else np.nan
            if k not in a.columns:
                continue
            ret = (b["close"] / a["close"] - 1).replace([np.inf, -np.inf], np.nan)
            m = a[k].notna() & ret.notna()
            if k == "pe":
                m &= a["pe"] > 0
            if m.sum() < 30:
                continue
            ics.append((a[k][m] * sg).rank().corr((ret[m] - ret[m].mean()).rank()))
        if len(ics) >= 6:
            arr = np.array(ics)
            out["factors"].append({"id": k, "label": label, "ic": round(float(arr.mean()), 3), "t": round(float(arr.mean() / (arr.std() / np.sqrt(len(arr)))), 2), "n": len(arr)})
    out["ready"] = bool(out["factors"])
    return out


def run(force=False, limit=None, log=print) -> dict:
    data = load(force, limit, log)
    f, index = frames(data)
    x, fwd = features(f), forward(f)
    regime = None
    if index is not None:
        m50, m200 = index.rolling(50).mean(), index.rolling(200).mean()
        regime = pd.Series(np.where((index > m50) & (m50 > m200), "bull", np.where((index < m50) & (index < m200), "bear", "mixed")), index=index.index)
        regime[m200.isna()] = np.nan
    sigs = []
    cut = f["close"].index[-1] - pd.Timedelta(days=365)
    fwd_r = {h: fwd[h].loc[cut:] for h in HORIZONS}
    reg_r = regime.loc[cut:] if regime is not None else None
    for s in signal_defs(x):
        row = {k: s[k] for k in ("id", "label", "who")}
        for h in HORIZONS:
            row[f"h{h}"] = evaluate_signal(s["sig"], fwd, regime, h)
        row["recent"] = evaluate_signal(s["sig"].loc[cut:], fwd_r, reg_r, 10)  # son 1 yıl: yaşlanma kontrolü
        sigs.append(row)
    facs = []
    for s in factor_defs(x):
        row = {k: s[k] for k in ("id", "label", "who")}
        for h in HORIZONS:
            row[f"h{h}"] = evaluate_factor(s["f"], fwd, h)
        facs.append(row)
    def verdict(h):
        if not h:
            return "yetersiz"
        a, b = h.get("h1"), h.get("h2")
        same = a is not None and b is not None and a * b > 0
        if h.get("t") is None:
            return "yetersiz"
        if h["t"] >= 2 and same and a > 0:
            return "kanıt var"
        if h["t"] <= -2 and same and a < 0:
            return "ters kanıt"
        return "belirsiz"
    for s in sigs:
        s["verdict"] = verdict(s.get("h10"))
        r = s.get("recent")
        # tam örneklemde kanıt var ama son 1 yılda avantaj kaybolmuşsa: yaşlanıyor
        s["aging"] = bool(s["verdict"] == "kanıt var" and (not r or r["excess"] <= 0 or r["t"] < 1.0))
        s["active"] = bool(s["verdict"] == "kanıt var" and not s["aging"]) or (s["verdict"] == "belirsiz" and (s.get("h10") or {}).get("excess", 0) > 0)
    for s in facs:
        h = s.get("h10")
        s["verdict"] = "yetersiz" if not h else "kanıt var" if h["t"] >= 2 and h["spread"] > 0 else "ters kanıt" if h["t"] <= -2 and h["spread"] < 0 else "belirsiz"
    # bileşik göreli güç (RS) skoru: 52h yakınlık + 6-1 ay + 1 ay getiri, dilim (decile) bazında 10g fazla getiri
    rk = lambda df: df.rank(axis=1, pct=True)
    comp = (rk(x["dist52"]) + rk(x["mom6_1"]) + rk(x["mom1"])) / 3
    ex10 = fwd[10].sub(fwd[10].mean(axis=1), axis=0)
    dec = [[] for _ in range(10)]
    top_tr = []
    for i in range(0, len(comp), 10):
        a, b = comp.iloc[i], ex10.iloc[i]
        m = a.notna() & b.notna()
        if m.sum() < 40:
            continue
        q = np.minimum((a[m].rank(pct=True) * 10).astype(int), 9)
        for d in range(10):
            vals = b[m][q == d]
            if len(vals):
                dec[d].append(vals.mean())
        top = a[m].nlargest(10).index
        tt = x["trend"].iloc[i][top].fillna(False)
        if tt.sum() >= 3:
            top_tr.append(b[m][top][tt].mean())
    rs_dec = [round(float(np.mean(v) * 100), 2) if v else None for v in dec]
    top_tr = np.array(top_tr)
    # evrenin kendi ortalama getirisi (taban): enflasyonlu nominal drift ne kadar?
    ew = fwd[10].mean(axis=1).dropna()
    idx0, idx1 = f["close"].index[0], f["close"].index[-1]
    res = {
        "generated": datetime.now(TZ).strftime("%Y-%m-%d %H:%M"), "stocks": int(f["close"].shape[1]),
        "from": str(idx0.date()), "to": str(idx1.date()), "days": int(len(f["close"])),
        "base10": round(float(ew.mean() * 100), 2),
        "regime_share": {k: int((regime == k).sum()) for k in ("bull", "mixed", "bear")} if regime is not None else None,
        "signals": sigs, "factors": facs, "rs_deciles": rs_dec,
        "rs_top_trend": {"excess": round(float(top_tr.mean() * 100), 2), "std": round(float(top_tr.std() * 100), 2), "win": round(float((top_tr > 0).mean() * 100), 0), "n": int(len(top_tr))} if len(top_tr) else None,
        "sigma10": round(float(ex10.stack().dropna().std() * 100), 2),
    }
    res["pit"] = pit_eval()
    res["changes"] = track_history(res)
    OUT.write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return res


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="Veriyi yeniden çek")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--if-stale", action="store_true", help="research.json 7 günden eskiyse çalıştır")
    a = ap.parse_args()
    if a.if_stale and OUT.exists() and time.time() - OUT.stat().st_mtime < 7 * 86400:
        print("research.json güncel, atlandı.")
        raise SystemExit(0)
    if a.if_stale:
        a.force = True
    r = run(a.force, a.limit, log=lambda m: print(m, flush=True))
    print(f"{r['stocks']} hisse, {r['from']} → {r['to']}, 10g taban: %{r['base10']}")
    for s in r["signals"]:
        h = s["h10"]
        print(f"{s['id']:22} n={h['n'] if h else '-':>5} fazla={h['excess'] if h else '-':>6} win={h['win'] if h else '-':>5} t={h['t'] if h else '-':>5} y1={h['h1'] if h else '-'} y2={h['h2'] if h else '-'}" if h else f"{s['id']:22} yetersiz")
    for s in r["factors"]:
        h = s["h10"]
        print(f"{s['id']:12} IC={h['ic'] if h else '-':>6} t={h['t'] if h else '-':>5} spread={h['spread'] if h else '-'}" if h else f"{s['id']:12} yetersiz")
