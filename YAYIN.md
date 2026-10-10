# TradingOfis'i GitHub Pages'te yayinlama / guncelleme

Yuklenecek dosyalar (depoya, Add file > Upload files; ayni adli dosyalarin uzerine yazilir):
  fetcher.py, news.py, history.py, build_site.py, template.html, requirements.txt
Ayrica .github/workflows/pages.yml dosyasinin ICERIGINI yenisiyle degistirin
(depoda dosyayi acin > kalem simgesi > icerigi yapistirin > Commit).

Ilk kurulumda:
1. github.com'da Public bir depo olusturun (or. borsa-komitesi).
2. Settings > Pages > Source: GitHub Actions.
3. Actions sekmesi > "Veri guncelle ve yayinla" > Run workflow.
   Ilk calismada fiyat gecmisi cekildigi icin 10-15 dakika surebilir.
4. Adres: https://KULLANICI_ADINIZ.github.io/DEPO_ADI/

Not: Gecmis verisi (history.json) gunde bir kez, piyasa kapanisindan sonra (18:45 TR) guncellenir ve
depoya otomatik kaydedilir (bu ayni zamanda 60 gunluk pasiflik kapanmasini da onler).
