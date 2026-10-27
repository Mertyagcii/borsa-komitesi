# Dış tetikleyici: verinin gerçekten 10 dakikada bir yenilenmesi

**Sorun:** GitHub'ın `schedule` zamanlayıcısı "15 dakikada bir" yerine pratikte ortalama 4 saatte bir çalışıyor (386 saatte 1544 yerine 97 çalışma).
Seans içinde fiyatlar 5 saate kadar eski kalabiliyor.

**Çözüm:** Cloudflare'ın güvenilir cron'u, GitHub'a "iş akışını şimdi çalıştır" çağrısı yapar. Bu klasördeki Worker bunu yapar. Ücretsiz plan yeterlidir.

## Güvenlik (önemli)
- Anahtarı **kimseye yazmayın**, sohbete de yapıştırmayın. Yalnızca Cloudflare panelinde "Secret" olarak girilir.
- Anahtar yalnızca **bu depoda** ve yalnızca **Actions: Read and write** yetkisiyle sınırlı olmalı (aşağıda). Süre sınırı koyun (ör. 1 yıl).
- Sızarsa en kötü sonuç: biri iş akışını gereksiz çalıştırır. Kod okuyamaz/değiştiremez (depo zaten herkese açık, kod yazma yetkisi verilmiyor).

## Kurulum (yaklaşık 10 dakika)
1. **GitHub anahtarı:** GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.
   - Repository access: **Only select repositories** → `borsa-komitesi`
   - Permissions → Repository permissions → **Actions: Read and write** (başka hiçbir şey)
   - Expiration: 1 yıl. Oluşturup değeri bir kenara kopyalayın (bir kez gösterilir).
2. **Cloudflare:** https://dash.cloudflare.com → ücretsiz hesap açın → Workers & Pages → Create → **Create Worker** → adı `tradingofis-tetikleyici` → Deploy.
3. Worker sayfasında **Edit code** → içeriği bu klasördeki `worker.js` ile değiştirin → Deploy.
4. Worker → **Settings → Variables and Secrets → Add** → Type: **Secret**, Name: `GH_TOKEN`, Value: 1. adımdaki anahtar → Deploy.
5. Worker → **Settings → Trigger Events → Cron Triggers → Add** → şu iki satırı ekleyin (saatler UTC):
   - `*/10 6-15 * * 1-5`
   - `12 * * * *`
6. Doğrulama: Worker adresini tarayıcıda açın → `"token_tanimli": true` görmelisiniz. Birkaç dakika sonra GitHub → Actions sekmesinde
   "Veri guncelle ve yayinla" çalışmalarının `workflow_dispatch` olayıyla geldiğini görürsünüz.

(İsterseniz `wrangler` ile de kurulabilir: bu klasörde `npx wrangler deploy` ve `npx wrangler secret put GH_TOKEN`; `wrangler.toml` hazırdır.)

## Maliyet ve etki
- Çalışma sayısı: seansta saatte 6, diğer zamanlarda saatte 1 → günde yaklaşık 85. Her çalışma ~1-3 dakika; herkese açık depoda GitHub Actions ücretsizdir.
- İş akışında `concurrency` olduğundan çalışmalar üst üste binmez, sıraya girer.
- Beklenen: seans içinde veri en çok ~10-15 dakika eski olur (Kokpit'teki "Veri: İYİ/DİKKAT" etiketi bunu gösterir).

## Kaldırmak
Cloudflare'da Worker'ı silin ve GitHub'da anahtarı iptal edin (Settings → Developer settings → Tokens → Delete).
