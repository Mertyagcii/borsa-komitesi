"""Veri Polisi: veri ve tahmin hattının kendi kendini denetimi → veri_polisi.json (Şeffaflık Panosu'nda görünür).

Her gün araştırma iş akışında çalışır. Sessiz hataları (düzeltilmemiş bölünme, donmuş fiyat, bayat dosya, tahmin karnesinin hedeften sapması) görünür kılar.
Her denetim: {id, durum: "tamam" | "uyarı" | "bilinen sınır", ad, ayrıntı}. 'bilinen sınır' bir hata değil, dürüstçe duyurulan yapısal eksiktir (örn. hayatta kalma yanlılığı).
Kullanım: python veri_polisi.py"""
import json
import math
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).parent
TR = timezone(timedelta(hours=3))
JUMP = 0.115


def rd(name):
    p = HERE / name
    try:
        return json.loads(p.read_text(encoding="utf-8-sig")) if p.exists() else None
    except Exception:
        return None


def bdays_between(d0, d1):
    n, d = 0, d0
    while d < d1:
        d += timedelta(days=1)
        if d.weekday() < 5:
            n += 1
    return n


def survivorship_gap(long):
    """Hayatta kalma yanlılığının ÜST SINIR göstergesi: bugünkü evrenin eşit ağırlıklı yıllık getirisi − BIST 100 yıllık getirisi (endeks geçmiş üyeleri içerir, evren içermez).
    Fark yalnızca yanlılık değildir (eşit ağırlık / küçük hisse etkisini de içerir); gerçek yanlılık bundan küçüktür. Dönüş: (ew %, endeks %, fark puan, yıl) ya da None."""
    try:
        st = [[(x if x else float("nan")) for x in s["c"]] for s in long["stocks"].values()]
        idx = long["index"]
        n = len(idx) - 1
        ew, ir = [], []
        for t in range(1, n + 1):
            r = [c[t] / c[t - 1] - 1 for c in st if c[t - 1] == c[t - 1] and c[t] == c[t] and c[t - 1] > 0]
            if len(r) < 20 or not (idx[t - 1] and idx[t]):
                continue
            ew.append(sum(r) / len(r))
            ir.append(idx[t] / idx[t - 1] - 1)
        yrs = len(ew) / 252
        if yrs < 3:
            return None
        g = lambda x: (math.prod(1 + v for v in x) ** (1 / yrs) - 1) * 100
        a, b = g(ew), g(ir)
        return round(a, 1), round(b, 1), round(a - b, 1), round(yrs, 1)
    except Exception:
        return None


def checks(oh, long, fc, live, today=None):
    today = today or datetime.now(TR).date()
    out = []

    def add(i, ad, durum, ayr):
        out.append({"id": i, "ad": ad, "durum": durum, "ayrinti": ayr})

    if not oh:
        add("fiyat_dosyasi", "Fiyat geçmişi dosyası", "uyarı", "ohlcv.json okunamadı")
        return out
    last = date.fromisoformat(oh["dates"][-1])
    lag = bdays_between(last, today)
    add("fiyat_tazelik", "Fiyat geçmişi taze mi", "tamam" if lag <= 3 else "uyarı", f"son bar {last.isoformat()} ({lag} iş günü önce)")
    # donmuş seri: son 8 işlem gününde tamamen aynı kapanış (likit hissede olmaz; veri kaynağı takılmış olabilir)
    frozen = [n for n, s in oh["stocks"].items() if len([x for x in s["c"][-8:] if x]) == 8 and len({x for x in s["c"][-8:]}) == 1]
    add("donmus_seri", "Donmuş fiyat serisi", "tamam" if len(frozen) <= 3 else "uyarı", f"{len(frozen)} hissede 8 gün üst üste aynı kapanış" + (": " + ", ".join(frozen[:6]) if frozen else ""))
    # son 60 günde limit dışı sıçrama
    jumps = []
    for n, s in oh["stocks"].items():
        c = s["c"][-61:]
        for i in range(1, len(c)):
            if c[i] and c[i - 1] and c[i - 1] > 0 and abs(c[i] / c[i - 1] - 1) > JUMP:
                jumps.append(n)
                break
    add("sicrama", "Düzeltilmemiş bölünme / hatalı fiyat şüphesi (son 60 gün)", "tamam" if not jumps else "uyarı",
        "günlük ±%11,5'i aşan hareket yok (BIST limiti ±%10)" if not jumps else f"{len(jumps)} hissede limit dışı sıçrama: {', '.join(jumps[:8])} (bölünme/bedelsiz düzeltmesi ya da veri hatası olabilir)")
    if long:
        lj = long.get("audit", {}).get("jumps", [])
        age = (today - datetime.strptime(long["generated"], "%Y-%m-%d %H:%M").date()).days
        add("uzun_veri", "Uzun geçmiş (≈10 yıl) dosyası", "tamam" if age <= 35 else "uyarı", f"{len(long['dates'])} gün, {long['dates'][0]} → {long['dates'][-1]}; {age} gün önce yenilendi; {len(lj)} şüpheli sıçrama")
        if lj:
            neg = all(j["r"] < 0 for j in lj)
            add("uzun_sicrama", "Uzun geçmişte limit dışı günler", "bilinen sınır" if neg and len(lj) <= 20 else "uyarı",
                ("hepsi düşüş (çoğu temettü çıkış günü: getiriler fiyat getirisidir, temettü dahil değil): " if neg else "") + "; ".join(f"{j['n']} {j['d']} {j['r']:+.0f}%" for j in lj[:6]) + (" …" if len(lj) > 6 else ""))
    else:
        add("uzun_veri", "Uzun geçmiş (≈10 yıl) dosyası", "uyarı", "yok: tahmin ve araştırmalar yalnız ~3 yıllık veriyle çalışıyor")
    if fc:
        newest = max(oh["dates"][-1], long["dates"][-1] if long else "")
        flag = fc["to"] >= newest
        add("tahmin_tazelik", "Gelecek Görünümü güncel mi", "tamam" if flag else "uyarı", f"tahmin son bar {fc['to']}; en yeni fiyat verisi {newest}")
    else:
        add("tahmin_tazelik", "Gelecek Görünümü güncel mi", "uyarı", "forecast.json yok")
    if live and live.get("h"):
        bad, info = [], []
        for h, x in live["h"].items():
            if x.get("origins", 0) >= 4 and x.get("c80") is not None:
                info.append(f"{h}g: %{round(x['c80'] * 100)}")
                if abs(x["c80"] - 0.80) > 0.10:
                    bad.append(f"{h}g %{round(x['c80'] * 100)}")
        if bad:
            add("tahmin_karne", "Canlı tahmin karnesi hedefte mi", "uyarı", "%80 bant hedeften >10 puan saptı: " + ", ".join(bad))
        elif info:
            add("tahmin_karne", "Canlı tahmin karnesi hedefte mi", "tamam", "ölçülen: " + ", ".join(info))
        else:
            add("tahmin_karne", "Canlı tahmin karnesi hedefte mi", "tamam", "henüz hüküm için yeterli ölçülmüş hafta yok (en az 4 gerekir)")
    sg = survivorship_gap(long) if long else None
    add("hayatta_kalma", "Hayatta kalma yanlılığı", "bilinen sınır", "evren bugünün likit hisseleri; düşüp çıkarılan hisseler yok, mutlak getiriler iyimser olabilir (göreli sonuçlar daha az etkilenir)"
        + (f". Üst sınır göstergesi: evrenin eşit ağırlıklı getirisi (son {sg[3]} yıl) yıllık %{sg[0]}, BIST 100 %{sg[1]} (fark {sg[2]:+.1f} puan/yıl; bu fark kısmen eşit ağırlık/küçük hisse etkisidir, gerçek yanlılık bundan küçüktür). Mutlak getirilerin iyimser olabileceğini unutmayın; göreli sıralama sonuçları daha az etkilenir" if sg else ""))
    add("rejim_cesitliligi", "Rejim çeşitliliği", "tamam" if long else "bilinen sınır", "≈10 yıl: 2018 krizi, 2020, 2021 faiz indirimi, 2023 seçim dahil" if long else "yalnız ~3 yıl, tek rejim")
    return out


def main():
    oh, long, fc, live = rd("ohlcv.json"), rd("ohlcv_long.json"), rd("forecast.json"), rd("forecast_live.json")
    cs = checks(oh, long, fc, live)
    warn = [c for c in cs if c["durum"] == "uyarı"]
    res = {"generated": datetime.now(TR).strftime("%Y-%m-%d %H:%M"), "durum": "uyarı" if warn else "tamam", "uyari": len(warn), "checks": cs}
    (HERE / "veri_polisi.json").write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("durum:", res["durum"], "| uyarı:", len(warn))
    for c in cs:
        print(" ", c["durum"].ljust(14), c["ad"], "-", c["ayrinti"])


if __name__ == "__main__":
    main()
