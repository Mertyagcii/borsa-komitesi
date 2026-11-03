"""Veri döngüsü zinciri: bir sonraki otomatik çalışmaya kadar bekleme süresini (saniye) yazdırır; 0 = zincir durur.

Neden: GitHub'ın kendi zamanlayıcısı (schedule) "15 dakikada bir" yerine pratikte 4-5 saatte bir çalışıyor (ölçülen: %6). Dışarıdan tetikleyici (anahtar, ek hesap) istemiyoruz.
Çözüm: pages.yml'nin son adımı bu süreyi hesaplar ve zincir.yml'yi (GITHUB_TOKEN ile, anahtar gerekmez) tetikler; zincir.yml bekler ve pages.yml'yi tekrar tetikler.
Zincir HİÇ DURMAZ: seansta sık, diğer zamanlarda seyrek (30 dk) çalışır. (İlk sürüm geceleri duruyor ve sabah başlatmayı GitHub'ın güvenilmez zamanlayıcısına bırakıyordu;
3 Kasım'da sabah 04:37'den 07:46'ya kadar hiç çalışma olmadı, seans açılışına 2 saat kala zincir kopuktu.)
Kullanım: python zincir.py [--now 2026-11-02T10:15:00+03:00]"""
import sys
from datetime import datetime, timedelta, timezone

TR = timezone(timedelta(hours=3))


def wait_seconds(now: datetime) -> int:
    now = now.astimezone(TR)
    if now.weekday() >= 5:  # cumartesi, pazar: piyasa kapalı, yine de zincir yaşasın (pazartesi sabahı hazır olsun)
        return 1800
    m = now.hour * 60 + now.minute
    if 9 * 60 + 30 <= m < 18 * 60 + 30:  # seans (10:00-18:00) ve açılış/kapanış payı: yaklaşık 10 dakikada bir
        return 540
    if 6 * 60 + 30 <= m < 9 * 60 + 30:  # seans öncesi: haber/dış veri yenilemesi ve zincirin güvenli başlaması
        return 1800
    if 18 * 60 + 30 <= m < 22 * 60:  # kapanış sonrası: günlük kayıt (18:45+), geçmiş, arşiv, sanal portföyler
        return 1200
    return 1800  # gece: seyrek ama zincir kopmaz


def main() -> None:
    now = datetime.now(TR)
    if "--now" in sys.argv:
        now = datetime.fromisoformat(sys.argv[sys.argv.index("--now") + 1])
    print(wait_seconds(now))


if __name__ == "__main__":
    main()
