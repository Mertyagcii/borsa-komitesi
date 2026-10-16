#!/usr/bin/env node
/* Bildirim gönderici: alerts.txt (kapanış sinyalleri: yüksek güvenilirlikli adaylar) ve alarms.txt (kritik piyasa alarmları) dosyalarını
   Telegram'a ve (varsa) webhook'a (Slack/Discord/genel) yollar. Sır (secret) yoksa hiçbir şey göndermeden çıkar; hata verse bile CI'ı durdurmaz.
   Ortam değişkenleri: TG_TOKEN (ya da TELEGRAM_BOT_TOKEN), TG_CHAT (ya da TELEGRAM_CHAT_ID), ALARM_WEBHOOK_URL. Token hiçbir yere yazdırılmaz.
   Kullanım: node notify.js [--dry] [dosya ...]   (varsayılan: alarms.txt alerts.txt) */
const fs = require("fs");

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/* Telegram sınırı 4096 karakter: satır bütünlüğünü bozmadan parçala */
function chunks(text, max = 3800) {
  const out = []; let cur = "";
  for (const line of String(text).split("\n")) {
    if (line.length > max) { if (cur) { out.push(cur); cur = ""; } for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max)); continue; }
    if ((cur + "\n" + line).length > max && cur) { out.push(cur); cur = line; } else cur = cur ? cur + "\n" + line : line;
  }
  if (cur) out.push(cur);
  return out;
}
async function post(url, body) {
  const r = await fetch(url, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
  if (r.status === 429) { let wait = 3; try { wait = (await r.json()).parameters.retry_after || 3; } catch (e) { /* varsayılan */ } await new Promise(res => setTimeout(res, Math.min(wait, 20) * 1000)); return fetch(url, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)}); }
  return r;
}
async function sendTelegram(token, chat, text) {
  let ok = 0;
  for (const c of chunks(text)) { const r = await post(`https://api.telegram.org/bot${token}/sendMessage`, {chat_id: chat, text: esc(c), parse_mode: "HTML", disable_web_page_preview: true}); if (r.ok) ok++; else return {ok, error: "Telegram HTTP " + r.status}; }
  return {ok};
}
async function sendHook(url, text) { const r = await post(url, {text, content: text.slice(0, 1900)}); return r.ok ? {ok: 1} : {ok: 0, error: "webhook HTTP " + r.status}; }

async function main() {
  const args = process.argv.slice(2), dry = args.includes("--dry"), files = args.filter(a => !a.startsWith("--")), list = files.length ? files : ["alarms.txt", "alerts.txt"];
  const token = process.env.TG_TOKEN || process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TG_CHAT || process.env.TELEGRAM_CHAT_ID, hook = process.env.ALARM_WEBHOOK_URL;
  let sent = 0;
  for (const f of list) {
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, "utf8").trim(); if (!text) continue;
    const parts = chunks(text);
    if (dry) { console.log(`[dry] ${f}: ${text.length} karakter, ${parts.length} parça`); sent++; continue; }
    if (!(token && chat) && !hook) { console.log(`${f}: bildirim kanalı yapılandırılmamış (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID ya da ALARM_WEBHOOK_URL); atlandı.`); continue; }
    try {
      if (token && chat) { const r = await sendTelegram(token, chat, text); console.log(`${f}: Telegram ${r.error ? "HATA " + r.error : r.ok + " parça gönderildi"}`); if (!r.error) sent++; }
      if (hook) { const r = await sendHook(hook, text); console.log(`${f}: webhook ${r.error ? "HATA " + r.error : "gönderildi"}`); if (!r.error) sent++; }
    } catch (e) { console.log(`${f}: gönderim hatası (${e.message})`); }
  }
  console.log(sent ? `${sent} bildirim işlendi.` : "Gönderilecek bildirim yok.");
}
if (require.main === module) main().then(() => process.exit(0)); else module.exports = {chunks, esc};
