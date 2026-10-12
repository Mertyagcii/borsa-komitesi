# TradingOfis'i GitHub Pages'te yayinlama / guncelleme

Yayin: `main` dalina yapilan her push siteyi otomatik gunceller (Actions). Veri 15 dakikada bir kendiliginden yenilenir.

Dosyalar: fetcher.py, news.py, history.py, build_site.py, signals.js, core.js, template.html, requirements.txt,
.github/workflows/pages.yml (+ history.json, picks.json, snapshots.json: Actions tarafindan guncellenir).

Komite karnesi: her is gunu kapanistan sonra (18:45 TR) signals.js komitenin kararlarini picks.json'a yazar.

Telegram uyarisi (istege bagli): GitHub deposunda Settings > Secrets and variables > Actions > New repository secret:
  TELEGRAM_BOT_TOKEN  (BotFather'dan alinan token)
  TELEGRAM_CHAT_ID    (botla konusup https://api.telegram.org/bot<TOKEN>/getUpdates adresinden chat id)
Tanimlaninca her kapanista yeni "guclu aday" varsa mesaj gelir.
