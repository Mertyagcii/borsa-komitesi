"""Gün içi (day trade) strateji araştırması: 15 dakikalık çubuklarla, nedensel (ileri bakışsız) kurallar.
Karar çubuk KAPANIŞINDA verilir, giriş bir SONRAKİ çubuğun açılışında yapılır; çıkış stop / hedef / seans kapanışı (gün içi pozisyon taşınmaz).
Yalnızca uzun (BIST'te perakende açığa satış kısıtlı). Maliyet duyarlılığı: gidiş-dönüş %0,2 (aktif işlemci komisyonu) ve %0,5 (komisyon+BSMV %0,15×2 + kayma %0,10×2).
Çıktı: daytrade_research.json (arayüzdeki Gün İçi sayfası ve Gün İçi Model hangi kuralın kanıtlı olduğunu buradan okur)."""
import json
import pickle
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
COSTS = (0.2, 0.5)  # gidiş-dönüş %


def day_frames(df):
    """15 dk çubukları günlere böler; çubuk SIRASI kullanılır (saat dilimi/UTC farkından bağımsız)."""
    df = df.copy()
    df["d"] = df.index.normalize()
    out = {}
    for d, g in df.groupby("d"):
        g = g.sort_index()
        if 24 <= len(g) <= 40:  # eksik / yarım günleri at
            out[d] = g
    return out


def daily_context(days):
    keys = sorted(days)
    rows = []
    for d in keys:
        g = days[d]
        rows.append({"d": d, "o": g.open.iloc[0], "h": g.high.max(), "l": g.low.min(), "c": g.close.iloc[-1], "v": g.volume.sum(), "n": len(g)})
    ctx = pd.DataFrame(rows).set_index("d")
    ctx["pc"] = ctx.c.shift()
    ctx["atrp"] = ((ctx.h - ctx.l) / ctx.c).rolling(14).mean().shift()  # önceki 14 günün ortalama günlük aralığı
    ctx["avgbar"] = (ctx.v / ctx.n).rolling(20).mean().shift()
    return ctx


def vwap_series(g):
    tp = (g.high + g.low + g.close) / 3
    return (tp * g.volume).cumsum() / g.volume.cumsum().replace(0, np.nan)


def run_exit(g, ei, entry, stop, target):
    """Girişten (çubuk ei açılışı) sonra stop/hedef/kapanış. Aynı çubukta ikisi de değerse stop önce sayılır (temkinli)."""
    n = len(g)
    for j in range(ei, n):
        lo, hi = g.low.iloc[j], g.high.iloc[j]
        if stop is not None and lo <= stop:
            return min(g.open.iloc[j], stop) if j > ei else stop, "stop", j
        if target is not None and hi >= target:
            return max(g.open.iloc[j], target) if j > ei else target, "hedef", j
    return g.close.iloc[-1], "kapanis", n - 1


def strategies(g, c, nxt_open=None):
    """Bir hisse-gününde her strateji için (en çok bir) işlem üretir. g: gün çubukları, c: günlük bağlam satırı.
    Çubuk yapısı (BIST): 0 = açılış seansı tek fiyat (09:45), 1..32 = sürekli işlem (10:00-17:45), 33 = kapanış seansı tek fiyat (18:00)."""
    n = len(g)
    if n < 30:
        return []
    o, h, l, cl, v = g.open.values, g.high.values, g.low.values, g.close.values, g.volume.values
    vw = vwap_series(g).values
    pc, atrp, avgbar = c.pc, c.atrp, c.avgbar
    if not (pc > 0 and atrp > 0 and avgbar > 0):
        return []
    atr = atrp * pc
    last = n - 1  # kapanış seansı çubuğu
    tr = []
    gap = o[0] / pc - 1
    # S1: açılış aralığı kırılımı (ORB): ilk 2 sürekli çubuk (10:00-10:30) aralığı, hacim + VWAP üstü
    orh, orl = max(h[1], h[2]), min(l[1], l[2])
    for i in range(3, 20):
        if cl[i] > orh and v[i] >= 1.2 * avgbar and cl[i] > vw[i] and gap > -0.02:
            e = o[i + 1]; stop = max(orl, e - 1.5 * atr); risk = e - stop
            if risk > 0 and risk / e < 0.05:
                tr.append(("orb", i + 1, e, stop, e + 2 * risk))
            break
    # S2: gap-and-go: açılış seansı ≥ %2 yukarı, ilk sürekli çubuk güçlü (yeşil, üst %30'da kapanış)
    if gap >= 0.02 and cl[1] > o[1] and (cl[1] - l[1]) / max(h[1] - l[1], 1e-9) >= 0.7:
        tr.append(("gapgo", 2, o[2], l[1], None))
    # S3: gün içi VWAP geri çekilmesi (yükselen gün)
    for i in range(7, 25):
        above = (cl[1:i] > vw[1:i]).mean()
        if above >= 0.75 and cl[i - 1] > o[0] * 1.005 and l[i] <= vw[i] * 1.002 and cl[i] > vw[i] and v[i] >= avgbar:
            e = o[i + 1]; stop = min(l[i], vw[i]) - 0.3 * atr
            if e > stop and (e - stop) / e < 0.04:
                tr.append(("vwap_pull", i + 1, e, stop, e + 2 * (e - stop)))
            break
    # S4: öğleden sonra momentum (≈15:00): günün zirvesine yakın, ≥ %3 yukarı, VWAP üstünde; kapanışta sat
    i = 21
    if cl[i] / pc - 1 >= 0.03 and cl[i] >= h[1: i + 1].max() * 0.995 and cl[i] > vw[i]:
        tr.append(("pm_mom", i + 1, o[i + 1], None, None))
    # S5: sabah düşüş sıçraması: ≈11:15'te önceki kapanışa göre ≤ -%3 ve VWAP'ın %2 altında; hedef VWAP, stop -%1,5
    i = 6
    if cl[i] / pc - 1 <= -0.03 and cl[i] <= vw[i] * 0.98:
        e = o[i + 1]; tr.append(("dip_bounce", i + 1, e, e * 0.985, vw[i]))
    # S6: kapanışa doğru güç (≈16:45): ≥ %2 yukarı, günün zirvesine %0,3 içinde → kapanış seansında sat
    i = 28
    if cl[i] / pc - 1 >= 0.02 and cl[i] >= h[1: i + 1].max() * 0.997 and cl[i] > vw[i]:
        tr.append(("close_strength", i + 1, o[i + 1], None, None))
    # S7: BTST (akşam al, ertesi sabah açılışta sat): kapanış, günün aralığının üst %10'unda ve hacim ≥ 1,5x
    rng = max(h[1:].max() - l[1:].min(), 1e-9)
    if nxt_open and (cl[last - 1] - l[1:].min()) / rng >= 0.9 and v[1:last].sum() / (n - 2) >= 1.5 * avgbar and cl[last] / pc - 1 > 0:
        tr.append(("btst", last, cl[last], None, None, nxt_open))
    return tr


def evaluate(trades, label):
    if len(trades) < 30:
        return {"label": label, "n": len(trades)}
    t = pd.DataFrame(trades)
    out = {"label": label, "n": int(len(t)), "gross": round(float(t.r.mean() * 100), 3), "hit_gross": round(float((t.r > 0).mean() * 100), 1)}
    for c in COSTS:
        net = t.r - c / 100
        sd = net.std()
        out[f"net{c}"] = round(float(net.mean() * 100), 3)
        out[f"hit{c}"] = round(float((net > 0).mean() * 100), 1)
        # günlük kümelenmeyi hesaba katan t: gün bazında ortalama getiri
        dd = t.assign(net=net).groupby("d").net.mean()
        out[f"t{c}"] = round(float(dd.mean() / (dd.std() / np.sqrt(len(dd)))), 2) if len(dd) > 5 and dd.std() > 0 else 0
    ds = sorted(t.d.unique()); mid = ds[len(ds) // 2]
    out["h1"] = round(float(t[t.d <= mid].r.mean() * 100), 3); out["h2"] = round(float(t[t.d > mid].r.mean() * 100), 3)
    out["avg_win"] = round(float(t[t.r > 0].r.mean() * 100), 2) if (t.r > 0).any() else None
    out["avg_loss"] = round(float(t[t.r <= 0].r.mean() * 100), 2) if (t.r <= 0).any() else None
    out["exits"] = {k: int(v) for k, v in t.reason.value_counts().items()}
    if "reg" in t:
        for k in ("bull", "bear", "mixed"):
            s = t[t.reg == k]
            out[k] = round(float(s.r.mean() * 100), 3) if len(s) >= 20 else None
    out["days"] = int(len(ds))
    return out


def main():
    data = pickle.loads((HERE / "cache" / "intraday15.pkl").read_bytes())
    all_tr, base = [], []
    firstd, lastd = None, None
    for name, df in data.items():
        days = day_frames(df)
        if len(days) < 40:
            continue
        ctx = daily_context(days)
        for d, g in days.items():
            c = ctx.loc[d]
            firstd = d if firstd is None or d < firstd else firstd; lastd = d if lastd is None or d > lastd else lastd
            if len(g) < 26 or not (c.pc > 0):
                continue
            # taban: rastgele giriş (bar 4 sonrası açılış) → kapanış, tüm hisse-günleri
            e0 = g.open.iloc[6]; base.append({"d": d, "n": name, "r": g.close.iloc[-1] / e0 - 1, "reason": "kapanis"})
            ds_ = list(days)
            k_ = ds_.index(d); nxt = days[ds_[k_ + 1]].open.iloc[0] if k_ + 1 < len(ds_) else None
            for tr_ in strategies(g, c, nxt):
                sname, ei, e, stop, target = tr_[:5]
                if sname == "btst":
                    all_tr.append({"s": sname, "d": d, "n": name, "r": tr_[5] / e - 1, "reason": "ertesi_acilis", "ei": ei}); continue
                x, why, xj = run_exit(g, ei, e, stop, target)
                all_tr.append({"s": sname, "d": d, "n": name, "r": x / e - 1, "reason": why, "ei": ei})
    df = pd.DataFrame(all_tr)
    # rejim: endeks yoksa evrenin eşit ağırlıklı günlük getirisinden 20 gün trend (yaklaşık)
    daily = pd.DataFrame(base).groupby("d").r.mean()
    res = {"generated": datetime.now().strftime("%Y-%m-%d %H:%M"), "stocks": len(data), "from": str(firstd.date()), "to": str(lastd.date()), "costs": COSTS, "strategies": {}}
    res["baseline"] = evaluate(base, "Taban: her hisse-günü 11:15'te al, kapanışta sat (sürekli işlem)")
    names = {"close_strength": "Kapanışa doğru güç (16:45)", "btst": "BTST: akşam al, ertesi açılışta sat", "orb": "Açılış aralığı kırılımı (ORB)", "gapgo": "Gap-and-go (≥ %2 yukarı açılış)", "vwap_pull": "VWAP geri çekilmesi (yükselen gün)", "pm_mom": "Öğleden sonra momentum", "dip_bounce": "Sabah düşüş sıçraması (ters yön)"}
    print(f"{res['stocks']} hisse, {res['from']} → {res['to']}")
    hdr = f"{'strateji':34}{'n':>6}{'brüt%':>8}{'net0.2':>8}{'net0.5':>8}{'t0.5':>6}{'isabet0.5':>10}{'y1':>7}{'y2':>7}"
    print(hdr)
    b = res["baseline"]; print(f"{'TABAN':34}{b['n']:>6}{b.get('gross')!s:>8}{b.get('net0.2')!s:>8}{b.get('net0.5')!s:>8}{b.get('t0.5')!s:>6}{b.get('hit0.5')!s:>10}{b.get('h1')!s:>7}{b.get('h2')!s:>7}")
    for s, label in names.items():
        e = evaluate(df[df.s == s].to_dict("records"), label) if len(df) else {"label": label, "n": 0}
        res["strategies"][s] = e
        if e.get("gross") is not None:
            print(f"{label[:33]:34}{e['n']:>6}{e['gross']:>8}{e['net0.2']:>8}{e['net0.5']:>8}{e['t0.5']:>6}{e['hit0.5']:>10}{e['h1']:>7}{e['h2']:>7}  çıkışlar={e['exits']}")
        else:
            print(f"{label[:33]:34}{e['n']:>6} (yetersiz)")
    txt = json.dumps(res, ensure_ascii=False, separators=(",", ":"))
    assert "NaN" not in txt
    (HERE / "daytrade_research.json").write_text(txt, encoding="utf-8")


if __name__ == "__main__":
    main()
