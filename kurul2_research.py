"""Yeni uzmanların (Akıllı Para, Volatilite, Psikoloji) vekil sinyallerinin geçmiş testi. Gerçek takas/AKD, zımni oynaklık ve sosyal medya verisi YOK;
bu yüzden her uzman fiyat-hacim vekilleriyle çalışır ve vekiller burada sınanır. Yöntem research.py ile aynı: ertesi gün açılıştan giriş, evrene göre fazla getiri,
5/10/20 gün, t, yarılar, boğa/ayı. Çıktı: kurul2_research.json (uzmanlar yalnızca kanıtı ters çıkmayan sinyallerle oy kullanır)."""
import json
import pickle
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

from mtf_research import cmf as cmf_f
from research import evaluate_signal, frames, rsi

HERE = Path(__file__).parent


def main():
    data = pickle.loads((HERE / "cache" / "ohlcv_wide.pkl").read_bytes())
    f, index = frames(data)
    C, O, H, L, V = f["close"], f["open"], f["high"], f["low"], f["volume"]
    fwd = {h: C.shift(-h) / O.shift(-1) - 1 for h in (5, 10, 20)}
    m50, m200 = index.rolling(50).mean(), index.rolling(200).mean()
    regime = pd.Series(np.where((index > m50) & (m50 > m200), "bull", np.where((index < m50) & (index < m200), "bear", "mixed")), index=index.index)
    r1 = C.pct_change(); rv = V / V.rolling(20).mean().shift(1); rs14 = rsi(C)
    sma20, sd20 = C.rolling(20).mean(), C.rolling(20).std(ddof=0)
    z20 = (C - sma20) / sd20
    cmf = cmf_f(H, L, C, V, 20)
    hi20, lo20 = C.shift(2).rolling(20).max(), C.shift(2).rolling(20).min()
    brk_up_prev = C.shift(1) > hi20  # dün 20g zirveyi kırdı
    brk_dn_prev = C.shift(1) < lo20
    # ortalamaya dönüş hızı: z-skorunun AR(1) katsayısı (60 gün) → yarı ömür
    zs = z20
    b = (zs * zs.shift(1)).rolling(60).sum() / (zs.shift(1) ** 2).rolling(60).sum()
    half = -np.log(2) / np.log(b.clip(lower=0.05, upper=0.995))
    trend = (C > C.rolling(50).mean()) & (C.rolling(50).mean() > C.rolling(200).mean())
    vol5 = r1.rolling(5).std(); vol60 = r1.rolling(60).std()
    S = {
        # Psikoloji
        "fomo": ("FOMO: RSI > 78, 1 ayda > +%25, hacim ≥ 2x", (rs14 > 78) & (C / C.shift(21) - 1 > 0.25) & (rv >= 2), "psiko"),
        "fomo_kismi": ("Aşırı coşku: SMA20'nin %15 üstü + RSI > 75", (C / sma20 - 1 > 0.15) & (rs14 > 75), "psiko"),
        "panik": ("Panik: gün ≤ −%6, hacim ≥ 2,5x, RSI < 30", (r1 <= -0.06) & (rv >= 2.5) & (rs14 < 30), "psiko"),
        "boga_tuzagi": ("Boğa tuzağı: dün 20g zirve kırılımı, bugün ≤ −%2 ve hacimli", brk_up_prev & (r1 <= -0.02) & (rv >= 1.5), "psiko"),
        "ayi_tuzagi": ("Ayı tuzağı: dün 20g dip kırılımı, bugün ≥ +%2 ve hacimli", brk_dn_prev & (r1 >= 0.02) & (rv >= 1.5), "psiko"),
        # Akıllı para
        "birikim": ("Birikim: hacim ≥ 2x, |gün| ≤ %1,5, CMF > 0,1 (emilim)", (rv >= 2) & (r1.abs() <= 0.015) & (cmf > 0.1), "akilli"),
        "dagitim": ("Dağıtım: hacim ≥ 2x, |gün| ≤ %1,5, CMF < −0,1", (rv >= 2) & (r1.abs() <= 0.015) & (cmf < -0.1), "akilli"),
        "cmf_guclu": ("Para girişi: CMF20 > 0,15 ve trend yukarı", (cmf > 0.15) & trend, "akilli"),
        "cmf_zayif": ("Para çıkışı: CMF20 < −0,15", cmf < -0.15, "akilli"),
        # Volatilite / ortalamaya dönüş
        "z_asiri_ust": ("Z-skor > 2,5 (aşırı uzama)", z20 > 2.5, "vol"),
        "z_asiri_ust_hizli": ("Z-skor > 2,5 ve ortalamaya dönüş hızlı (yarı ömür < 10 gün)", (z20 > 2.5) & (half < 10), "vol"),
        "z_asiri_alt": ("Z-skor < −2,5 (aşırı düşüş)", z20 < -2.5, "vol"),
        "z_asiri_alt_trend": ("Z-skor < −2,5 ve yükselen trend", (z20 < -2.5) & trend, "vol"),
        "z_ort_trend": ("Z-skor 0,5-1,8 ve yükselen trend (sağlıklı trend)", (z20 > 0.5) & (z20 < 1.8) & trend, "vol"),
        "vol_sikisma": ("Oynaklık sıkışması (5g σ < 0,5 × 60g σ) ve trend yukarı", (vol5 < 0.5 * vol60) & trend, "vol"),
    }
    res = {"generated": datetime.now().strftime("%Y-%m-%d %H:%M"), "stocks": int(C.shape[1]), "from": str(C.index[0].date()), "to": str(C.index[-1].date()), "signals": {}}
    cut = C.index[-1] - pd.Timedelta(days=365)
    print(f"{'sinyal':24}{'n':>6}{'5g':>7}{'10g':>7}{'20g':>7}{'t10':>6}{'y1':>7}{'y2':>7}{'boğa':>7}{'ayı':>7}  karar")
    for k, (label, sig, who) in S.items():
        row = {"label": label, "who": who}
        for h in (5, 10, 20):
            row[f"h{h}"] = evaluate_signal(sig.fillna(False), fwd, regime, h)
        e = row["h10"]
        if e:
            same = e["h1"] is not None and e["h2"] is not None and e["h1"] * e["h2"] > 0
            row["verdict"] = "kanıt var" if e["t"] >= 2 and same and e["h1"] > 0 else "ters kanıt" if e["t"] <= -2 and same and e["h1"] < 0 else "belirsiz"
            print(f"{k:24}{e['n']:>6}{row['h5']['excess'] if row['h5'] else '-':>7}{e['excess']:>7}{row['h20']['excess'] if row['h20'] else '-':>7}{e['t']:>6}{str(e['h1']):>7}{str(e['h2']):>7}{str(e.get('bull')):>7}{str(e.get('bear')):>7}  {row['verdict']}")
        else:
            row["verdict"] = "yetersiz"
            print(f"{k:24} yetersiz örnek")
        res["signals"][k] = row
    txt = json.dumps(res, ensure_ascii=False, separators=(",", ":")); assert "NaN" not in txt
    (HERE / "kurul2_research.json").write_text(txt, encoding="utf-8")


if __name__ == "__main__":
    main()
