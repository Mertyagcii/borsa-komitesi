#!/usr/bin/env bash
# Kritik alarm ve günlük özeti GitHub bildirimi olarak gönderir (anahtar/Telegram gerekmez).
# Tek bir "bildirimler" başlığı (issue) tutulur; her alarm/özet bu başlığa yorum olarak eklenir. Depo sahibi @anılır: GitHub e-posta ve mobil uygulama bildirimi gönderir.
# Kullanım: GH_TOKEN ortam değişkeni ile: bash .github/scripts/bildir.sh   (alarms.txt, alerts.txt çalışma klasöründeyse gönderilir)
set -u
OWNER="${GITHUB_REPOSITORY_OWNER:-}"

baslik_no() {
  local n
  n=$(gh issue list --state open --label bildirim --json number --jq '.[0].number' 2>/dev/null || true)
  if [ -z "$n" ] || [ "$n" = "null" ]; then
    gh label create bildirim --description "Otomatik alarm ve günlük özetler" --force >/dev/null 2>&1 || true
    n=$(gh issue create --title "🔔 Borsa Komitesi bildirimleri" --label bildirim \
      --body "Bu başlık otomatik kritik alarmlar ve günlük özetler içindir. @${OWNER} anıldığı için GitHub size e-posta ve mobil bildirim gönderir. Eğitim amaçlıdır, yatırım tavsiyesi değildir." 2>/dev/null | grep -o '[0-9]*$' | tail -n1)
  fi
  echo "$n"
}

gonder() { # dosya başlık
  local f="$1" baslik="$2" no
  [ -s "$f" ] || return 0
  no=$(baslik_no)
  if [ -z "$no" ]; then echo "bildirim başlığı bulunamadı/oluşturulamadı"; return 1; fi
  {
    echo "@${OWNER} **${baslik}** · $(TZ=Europe/Istanbul date '+%d.%m.%Y %H:%M')"
    echo
    cat "$f"
    echo
    echo "_Eğitim amaçlıdır, yatırım tavsiyesi değildir._"
  } > "${RUNNER_TEMP:-/tmp}/bildirim.md"
  gh issue comment "$no" --body-file "${RUNNER_TEMP:-/tmp}/bildirim.md" && echo "gönderildi: $f -> #$no"
}

gonder alarms.txt "🚨 Yeni kritik alarm"
gonder alerts.txt "📊 Günlük özet"
exit 0
