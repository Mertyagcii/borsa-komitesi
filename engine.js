#!/usr/bin/env node
/* Sanal portföy motoru: efsaneler kâğıt üstünde işlem yapar (portfolios.json).
   Her işlem günü kapanıştan sonra bir kez çalışır: önceki günün emirlerini bugünün AÇILIŞINDA doldurur, stop/hedefleri günün
   en düşük/en yüksek fiyatıyla kontrol eder, NAV'ı kapanışla yazar ve yarın için yeni emirler üretir.
   Kullanım: node engine.js [--site site] [--force] [--reset] */
const fs = require("fs"), vm = require("vm"), path = require("path");

const args = process.argv.slice(2), FORCE = args.includes("--force"), RESET = args.includes("--reset");
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const SITE = opt("site", "site");
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };

const data = read(path.join(SITE, "data.json"), null), hist = read(path.join(SITE, "history.json"), null);
const news = (read(path.join(SITE, "news.json"), {news: {}}) || {}).news || {};
const research = read("research.json", null);
const intra = read("intraday.json", null);
if (!data || !data.stocks || !data.stocks.length || !hist) { console.log("data/history yok; atlandı."); process.exit(0); }

function istanbul() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false}).formatToParts(new Date()).map(x => [x.type, x.value]));
  return {date: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute};
}
const now = istanbul();
const date = (hist.index && hist.index.last) || now.date;
let st = RESET ? null : read("portfolios.json", null);

if (!FORCE) {
  if (st && st.lastDate && date <= st.lastDate) { console.log(`${date} zaten işlendi.`); copyOut(); process.exit(0); }
  if (date === now.date && now.min < 18 * 60 + 15) { console.log("Seans henüz kapanmadı; atlandı."); copyOut(); process.exit(0); }
  const genDate = String(data.generated || "").slice(0, 10);
  if (genDate && genDate < date) { console.log("Veri bu işlem gününden eski; atlandı."); copyOut(); process.exit(0); }
}
function copyOut() { if (fs.existsSync("portfolios.json")) { fs.mkdirSync(SITE, {recursive: true}); fs.copyFileSync("portfolios.json", path.join(SITE, "portfolios.json")); } }

const src = ["core.js", "engine_core.js"].map(f => fs.readFileSync(path.join(__dirname, f), "utf8")).join("\n");
const rf2 = hist.macro && hist.macro.rf2 ? hist.macro.rf2 : 33;
const idxClose = hist.index && hist.index.closes && hist.index.closes.length ? hist.index.closes[hist.index.closes.length - 1] : null;
const ctx = vm.createContext({console, Intl, Math, Date, JSON, __data: data, __hist: hist, __news: news, __research: research, __intra: intra, __state: st, __date: date, __cy: Math.round(rf2 * 0.85) / 100, __idx: idxClose});
const out = vm.runInContext(`
${src}
let R = Object.assign({}, DEFAULTS); let HIST = __hist; let NEWS = __news; let current = [];
RESEARCH = __research; NOW = Date.now(); INTRA = __intra;
let ST = __state || initState(__date, __cy);
ST.config.cashYield = __cy;
runDay(ST, __data, __date, __idx);
ST`, ctx);

fs.writeFileSync("portfolios.json", JSON.stringify(out));
copyOut();
const nav = k => out.p[k].nav[out.p[k].nav.length - 1];
console.log(`${date}: ` + Object.keys(out.p).map(k => `${k} ${nav(k).v.toLocaleString("tr-TR")} TL (poz:${out.p[k].pos.length}, emir:${out.p[k].orders.length})`).join(" | "));
