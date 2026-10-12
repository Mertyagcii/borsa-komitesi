"""Gece taşıma (kapanış → ertesi açılış) araştırması. Gün içi araştırması (daytrade_research.py) BIST'te uzun yönlü gün içi stratejilerin
maliyet sonrası kaybettirdiğini, getirinin büyük bölümünün kapanış→açılış (gece) aralığında oluştuğunu gösterdi. Burada bu etki ölçülür:
- Taban: tüm hisse-günleri kapanışta al, ertesi açılış seansında sat
- Koşullu: gün içi kapanış gücü, hacim, trend, haftanın günü
Giriş = kapanış seansı fiyatı (18:00 tek fiyat), çıkış = ertesi gün açılış seansı fiyatı (09:45 tek fiyat). İkisi de emirle işlem görebilen seans fiyatlarıdır.
Çıktı: overnight_research.json"""
import json
import pickle
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

from daytrade_research import COSTS, day_frames, daily_context

HERE = Path(__file__).parent


def build():
    data = pickle.loads((HERE / "cache" / "intraday15.pkl").read_bytes())
    rows = []
    for name, df in data.items():
        days = day_frames(df)
        if len(days) < 60:
            continue
        ctx = daily_context(days)
        keys = sorted(days)
        closes = pd.Series([days[d].close.iloc[-1] for d in keys], index=keys)
        sma20, sma50 = closes.rolling(20).mean(), closes.rolling(50).mean()
        for k, d in enumerate(keys[:-1]):
            g, c = days[d], ctx.loc[d]
            if len(g) < 30 or not (c.pc > 0 and c.avgbar > 0):
                continue
            nxt = days[keys[k + 1]]
            cl = g.close.iloc[-1]; rng = max(g.high.iloc[1:].max() - g.low.iloc[1:].min(), 1e-9)
            rows.append({"d": d, "n": name, "r": nxt.open.iloc[0] / cl - 1, "dayret": cl / c.pc - 1,
                         "pos": (g.close.iloc[-2] - g.low.iloc[1:].min()) / rng, "rvol": g.volume.iloc[1:-1].mean() / c.avgbar,
                         "trend": bool(closes.iloc[k] > sma50.iloc[k] and sma20.iloc[k] > sma50.iloc[k]) if not np.isnan(sma50.iloc[k]) else None,
                         "dow": d.dayofweek, "intra": g.close.iloc[-2] / g.open.iloc[1] - 1, "atrp": c.atrp, "tl": (cl * g.volume.sum()) / 1e6})
    return pd.DataFrame(rows)


def stat(sub, label):
    if len(sub) < 30:
        return {"label": label, "n": len(sub)}
    out = {"label": label, "n": int(len(sub)), "gross": round(float(sub.r.mean() * 100), 3), "hit_gross": round(float((sub.r > 0).mean() * 100), 1)}
    for c in COSTS:
        net = sub.r - c / 100
        dd = sub.assign(net=net).groupby("d").net.mean()
        out[f"net{c}"] = round(float(net.mean() * 100), 3); out[f"hit{c}"] = round(float((net > 0).mean() * 100), 1)
        out[f"t{c}"] = round(float(dd.mean() / (dd.std() / np.sqrt(len(dd)))), 2) if len(dd) > 5 and dd.std() > 0 else 0
    ds = sorted(sub.d.unique()); mid = ds[len(ds) // 2]
    out["h1"] = round(float(sub[sub.d <= mid].r.mean() * 100), 3); out["h2"] = round(float(sub[sub.d > mid].r.mean() * 100), 3)
    out["days"] = int(len(ds)); out["per_day"] = round(float(len(sub) / len(ds)), 1)
    return out


def main():
    df = build()
    res = {"generated": datetime.now().strftime("%Y-%m-%d %H:%M"), "stocks": int(df.n.nunique()), "from": str(df.d.min().date()), "to": str(df.d.max().date()), "costs": COSTS, "groups": {}}
    G = {
        "all": ("Taban: tüm hisse-günleri", df),
        "pos90": ("Kapanış günün aralığının üst %10'unda", df[df.pos >= 0.9]),
        "pos90_rv": ("… ve hacim ≥ 1,5x", df[(df.pos >= 0.9) & (df.rvol >= 1.5)]),
        "pos90_up": ("… ve gün getirisi > 0", df[(df.pos >= 0.9) & (df.dayret > 0)]),
        "pos90_rv_up": ("… hacim ≥ 1,5x ve gün getirisi > 0 (BTST)", df[(df.pos >= 0.9) & (df.rvol >= 1.5) & (df.dayret > 0)]),
        "pos90_rv_up_tr": ("BTST + yükselen trend", df[(df.pos >= 0.9) & (df.rvol >= 1.5) & (df.dayret > 0) & (df.trend == True)]),
        "pos90_rv_up_notfri": ("BTST, cuma hariç (hafta sonu riski)", df[(df.pos >= 0.9) & (df.rvol >= 1.5) & (df.dayret > 0) & (df.dow != 4)]),
        "big_up": ("Gün ≥ +%3 ve üst %20'de kapanış", df[(df.dayret >= 0.03) & (df.pos >= 0.8)]),
        "weak": ("Kapanış alt %10'da (tersi)", df[df.pos <= 0.1]),
        "trend_only": ("Yükselen trend (tüm günler)", df[df.trend == True]),
        "fri": ("Cuma kapanışı (hafta sonu taşıma)", df[df.dow == 4]),
        "midweek": ("Salı-Çarşamba-Perşembe", df[df.dow.isin([1, 2, 3])]),
    }
    print(f"{res['stocks']} hisse, {res['from']} → {res['to']}; hisse-günü {len(df)}")
    print(f"{'grup':46}{'n':>6}{'/gün':>6}{'brüt%':>8}{'net0.2':>8}{'net0.5':>8}{'t0.5':>6}{'isabet0.5':>10}{'y1':>7}{'y2':>7}")
    for k, (label, sub) in G.items():
        e = stat(sub, label); res["groups"][k] = e
        if e.get("gross") is not None:
            print(f"{label[:45]:46}{e['n']:>6}{e['per_day']:>6}{e['gross']:>8}{e['net0.2']:>8}{e['net0.5']:>8}{e['t0.5']:>6}{e['hit0.5']:>10}{e['h1']:>7}{e['h2']:>7}")
        else:
            print(f"{label[:45]:46}{e['n']:>6} (yetersiz)")
    # günlük portföy: her gün kapanış gücü en yüksek N hisse (kendi içinde sıralı), N=3 ve 5
    for N in (3, 5):
        d2 = df[(df.rvol >= 1.0) & (df.dayret > 0)].sort_values(["d", "pos", "rvol"], ascending=[True, False, False]).groupby("d").head(N)
        e = stat(d2, f"Her gün en güçlü {N} kapanış (pos, hacim ≥ 1x, gün > 0)"); res["groups"][f"top{N}"] = e
        if e.get("gross") is not None:
            print(f"{e['label'][:45]:46}{e['n']:>6}{e['per_day']:>6}{e['gross']:>8}{e['net0.2']:>8}{e['net0.5']:>8}{e['t0.5']:>6}{e['hit0.5']:>10}{e['h1']:>7}{e['h2']:>7}")
    # KRİTİK KONTROL: sinyallerin çoğu TAVAN (gün getirisi ≥ %9,5) kapatan hisseler; tavandaki hisse kuyrukta olduğundan alınamaz.
    base_ = df[(df.pos >= 0.9) & (df.rvol >= 1.5) & (df.dayret > 0)]
    res["tavan"] = {"share": round(float((base_.dayret >= 0.095).mean() * 100), 1), "only_tavan": stat(base_[base_.dayret >= 0.095], "Yalnızca tavan kapatanlar (alınamaz)"),
                    "ex_tavan": stat(base_[base_.dayret < 0.095], "Tavan hariç (alınabilir)"),
                    "top3_ex_tavan": stat(df[(df.pos >= 0.9) & (df.rvol >= 1.0) & (df.dayret > 0) & (df.dayret < 0.095)].sort_values(["d", "pos", "rvol"], ascending=[True, False, False]).groupby("d").head(3), "Günde en güçlü 3, tavan hariç")}
    print("TAVAN KONTROLÜ:", res["tavan"]["share"], "% tavan; tavan hariç net0.5:", res["tavan"]["ex_tavan"].get("net0.5"), "t", res["tavan"]["ex_tavan"].get("t0.5"))
    # (eski) NİHAİ KURAL (BTST) – tavanlar dahil olduğu için UYGULANABİLİR DEĞİL, yalnızca kıyas için saklanır: kapanış günün aralığının üst %10'unda, hacim ≥ 1,5x, gün getirisi > 0; her gün en güçlü 3; eşit ağırlık.
    # Eşik ızgarası (pos 0,8-0,95 × hacim 1-2x × N 3-99) boyunca sonuç yön olarak tutarlıydı; seçilen orta nokta, ızgaranın en iyisi DEĞİL (aşırı uyum riski).
    rule = df[(df.pos >= 0.9) & (df.rvol >= 1.5) & (df.dayret > 0)].sort_values(["d", "pos", "rvol"], ascending=[True, False, False]).groupby("d").head(3)
    res["rule"] = {"def": "kapanış aralığın üst %10'unda · hacim ≥ 1,5x · gün > 0 · günde en güçlü 3 · kapanış seansında al, ertesi açılış seansında sat", "stat": stat(rule, "BTST kuralı")}
    days = sorted(df.d.unique())
    dret = rule.groupby("d").r.mean()
    res["rule"]["monthly"] = {str(k): [int(v["count"]), round(float(v["mean"] * 100), 2)] for k, v in rule.assign(m=rule.d.dt.to_period("M")).groupby("m").r.agg(["count", "mean"]).iterrows()}
    eq, cum = [], 1.0
    for d in days:
        if d in dret.index:
            cum *= 1 + dret[d] - 0.005 if False else 1 + (dret[d] - 0.005)
        eq.append([str(d.date()), round(cum, 4)])
    res["rule"]["equity_net05"] = eq
    day_net = dret - 0.005
    res["rule"]["daily"] = {"islem_gunu": int(len(day_net)), "ort_net": round(float(day_net.mean() * 100), 3), "negatif_gun": round(float((day_net < 0).mean() * 100), 1), "en_kotu_gun": round(float(day_net.min() * 100), 2), "en_iyi_gun": round(float(day_net.max() * 100), 2), "toplam_gun": int(len(days))}
    liq = df.tl.median(); b = df[(df.pos >= 0.9) & (df.rvol >= 1.5) & (df.dayret > 0)]
    res["rule"]["liquidity"] = {"ust_yari": stat(b[b.tl >= liq], "likit üst yarı"), "alt_yari": stat(b[b.tl < liq], "likit alt yarı")}
    txt = json.dumps(res, ensure_ascii=False, separators=(",", ":")); assert "NaN" not in txt
    (HERE / "overnight_research.json").write_text(txt, encoding="utf-8")


if __name__ == "__main__":
    main()
