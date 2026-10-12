# TradingOfis'i GitHub Pages'te yayinlama / guncelleme

Yayin: `main` dalina yapilan her push siteyi otomatik gunceller (Actions). Veri 15 dakikada bir kendiliginden yenilenir.

Dosyalar: fetcher.py, news.py, history.py, research.py, build_site.py, core.js (efsane mantigi), engine_core.js + engine.js (sanal portfoyler),
signals.js (karne), template.html, requirements.txt, .github/workflows/pages.yml
Actions tarafindan guncellenenler: history.json (gunluk), research.json (haftalik), picks.json, snapshots.json, portfolios.json (her is gunu kapanisinda).

Is gunu kapanisindan sonra (18:45 TR): once history.json yenilenir (endeksin son cubugu bugune ulasinca), sonra
  - signals.js: komitenin kararlarini picks.json'a yazar (karne)
  - engine.js: sanal portfoylerde dunku emirleri bugunun acilisinda doldurur, stop/hedefleri kontrol eder, NAV yazar, yarin icin emir uretir.

Telegram uyarisi (istege bagli, en sona birakildi): GitHub deposunda Settings > Secrets and variables > Actions:
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  -> tanimlaninca her kapanista yeni "guclu aday" varsa mesaj gelir.

Yerel: python server.py -> http://localhost:8765 ; research.py ilk kez 6-8 dk surer (3 yillik gunluk veri ceker, cache/ icinde saklanir).

## Testler
- Yerelde: python build_site.py ; python tests/run_tests.py   (hizli: --quick). GitHub Actions'ta her push'ta calisir (zamanlanmis calismalarda atlanir); basarisizsa yayin durur.
- Kapsam: statik kontroller, cekirdek mantik (tests/core_test.js), tum sayfalar (tarayici), islevsel testler (tests/inject_func.js).
