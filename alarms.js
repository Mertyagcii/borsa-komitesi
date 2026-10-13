#!/usr/bin/env node
/* Anlık alarm motoru (seans içi, her CI çalışmasında ≈15 dk): hacim patlaması, SMA50 kırılımı, Şeytanın Avukatı vetosu, piyasa paniği.
   Yeni "kritik" (sev 3) alarm varsa alarms.txt üretir; CI bunu webhook (ALARM_WEBHOOK_URL) ve Telegram'a gönderir.
   Aynı alarm aynı gün bir kez gönderilir (alarm_state.json). Tüm önemli alarmlar alarm_log.json'a yazılır (arayüz ve arşiv okur).
   Kullanım: node alarms.js [--site site] [--state alarm_state.json] [--log alarm_log.json] [--force] */
const fs = require("fs"), path = require("path");
const {load, istanbul} = require("./corectx");
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const SITE = opt("site", "site"), STATE = opt("state", "alarm_state.json"), LOG = opt("log", "alarm_log.json"), FORCE = args.includes("--force"), NOPUB = args.includes("--nopublish");
const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
const now = istanbul();
const inSession = !["Sat", "Sun"].includes(now.wd) && now.min >= 10 * 60 && now.min <= 18 * 60 + 30;

const log = rj(LOG, {alarms: []});
const publishLog = () => { if (NOPUB) return; try { fs.mkdirSync(SITE, {recursive: true}); fs.writeFileSync(path.join(SITE, "alarm_log.json"), JSON.stringify(log)); } catch (e) { /* site yoksa atla */ } };
if (!FORCE && !inSession) { console.log(`Seans dışı (${now.wd} ${now.hm}); alarm taraması atlandı.`); publishLog(); process.exit(0); }

const C = load(SITE);
if (!C) { console.log("data.json yok; atlandı."); process.exit(0); }
const alarms = C.run("marketAlarms()");
let st = rj(STATE, {date: now.date, sent: []});
if (st.date !== now.date) st = {date: now.date, sent: []};
const fresh = alarms.filter(a => a.sev >= 3 && !st.sent.includes(a.id));
const seen = new Set(log.alarms.filter(a => a.d === now.date).map(a => a.id));
alarms.filter(a => a.sev >= 2 && !seen.has(a.id)).forEach(a => log.alarms.push({d: now.date, t: now.hm, id: a.id, sev: a.sev, type: a.type, n: a.n, text: a.text}));
log.alarms = log.alarms.slice(-600); log.updated = now.date + " " + now.hm;
fs.writeFileSync(LOG, JSON.stringify(log)); publishLog();
if (fresh.length) {
  st.sent.push(...fresh.map(a => a.id));
  fs.writeFileSync("alarms.txt", `🚨 KRİTİK PİYASA ALARMI ${now.date} ${now.hm}\n` + fresh.slice(0, 12).map(a => "• " + a.text).join("\n") + "\n(yatırım tavsiyesi değildir)");
}
fs.writeFileSync(STATE, JSON.stringify(st));
console.log(`${now.date} ${now.hm}: ${alarms.length} alarm (kritik ${alarms.filter(a => a.sev >= 3).length}, yeni gönderilecek ${fresh.length})`);
