#!/usr/bin/env node
/* Günlük komite kaydı (karne) ve uyarılar.
   Seans kapanışından sonra (hafta içi 18:45 TR) komitenin o günkü kararlarını picks.json'a yazar,
   önceki kayıtların 5/10/20 iş günü sonraki getirisini piyasa ortalamasıyla (likit 150 hisse) kıyaslar.
   Kullanım: node signals.js [--site site] [--date YYYY-MM-DD] [--force] */
const fs = require("fs"), vm = require("vm"), path = require("path");

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const SITE = opt("site", "site"), FORCE = args.includes("--force");
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };

const data = read(path.join(SITE, "data.json"), null);
if (!data || !data.stocks || !data.stocks.length) { console.log("data.json yok; atlandı."); process.exit(0); }
const hist = read(path.join(SITE, "history.json"), null);
const news = (read(path.join(SITE, "news.json"), {news: {}}) || {}).news || {};

function istanbul() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false}).formatToParts(new Date()).map(x => [x.type, x.value]));
  return {date: `${p.year}-${p.month}-${p.day}`, wd: p.weekday, min: (+p.hour % 24) * 60 + +p.minute};
}
const now = istanbul(), date = opt("date", now.date);
const store = read("picks.json", {picks: [], updated: null}), snaps = read("snapshots.json", {});
const afterClose = !["Sat", "Sun"].includes(now.wd) && now.min >= 18 * 60 + 45;

function publish() {
  fs.mkdirSync(SITE, {recursive: true});
  fs.writeFileSync(path.join(SITE, "picks.json"), JSON.stringify(store));
}
if (!FORCE && (!afterClose || store.picks.some(p => p.d === date))) {
  console.log(!afterClose ? "Seans kapanışı değil; kayıt atlandı." : `${date} zaten kaydedildi.`);
  if (fs.existsSync("picks.json")) publish();
  process.exit(0);
}

/* ---- core.js'i bir vm içinde çalıştır (tarayıcıyla aynı mantık) ---- */
const coreSrc = fs.readFileSync(path.join(__dirname, "core.js"), "utf8");
const research = read("research.json", null);
const ctx = vm.createContext({console, Intl, Math, Date, __data: data, __hist: hist, __news: news, __research: research});
const out = vm.runInContext(`
${coreSrc}
let R = Object.assign({}, DEFAULTS); let HIST = __hist; let NEWS = __news; let current = [];
NOW = Date.now();
const UNI = __data.stocks.map(enrich);
REGIME = computeRegime(UNI, HIST);
RESEARCH = __research; rankUniverse(UNI);
current = strengthList(UNI, 25, 5);
const res = current.map(s => [s, committee(s)]);
const sc = personaScreens(UNI, 8, []);
({
  committee: res.map(([s, r]) => ({n: s.name, e: s.close, sc: r.score, v: [r.l.buffett.v, r.l.simons.v, r.l.livermore.v, r.l.kellogg.v, r.l.seytan.v]})),
  screens: Object.fromEntries(Object.entries(sc).map(([k, arr]) => [k, arr.map(([s, p]) => ({n: s.name, e: s.close, sc: p.score}))])),
  regime: REGIME && {trend: REGIME.trend, label: REGIME.label, a50: Math.round(REGIME.a50)},
  liquid: UNI.filter(s => s.close > 0 && s.volume).map(s => [s.name, s.close, s.tl]).sort((a, b) => b[2] - a[2]).slice(0, 150).map(([n, c]) => [n, c]),
})`, ctx);

const nowClose = Object.fromEntries(data.stocks.filter(s => s.close > 0).map(s => [s.name, s.close]));
const todaySnap = Object.fromEntries(out.liquid);
const bdays = (a, b) => { let n = 0; const d = new Date(a + "T12:00:00Z"), e = new Date(b + "T12:00:00Z");
  while (d < e) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; } return n; };
const r2 = x => Math.round(x * 100) / 100;

/* ---- eski kayıtları değerlendir ---- */
let evaluated = 0;
for (const p of store.picks) {
  if (p.d >= date) continue;
  const age = bdays(p.d, date), s0 = snaps[p.d];
  for (const h of [5, 10, 20]) {
    if (age < h || (p.r && p.r[h] != null) || !nowClose[p.n]) continue;
    p.r = p.r || {}; p.b = p.b || {};
    p.r[h] = r2((nowClose[p.n] / p.e - 1) * 100);
    if (s0) {
      const xs = Object.keys(s0).filter(n => todaySnap[n]).map(n => todaySnap[n] / s0[n] - 1);
      p.b[h] = xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length * 100) : null;
    } else p.b[h] = null;
    evaluated++;
  }
}

/* ---- bugünün kayıtları ---- */
const prevStrong = new Set(store.picks.filter(p => p.src === "komite" && p.sc >= 3).map(p => p.n + "@" + p.d));
store.picks = store.picks.filter(p => p.d !== date);
const rec = [];
out.committee.forEach(c => rec.push({d: date, src: "komite", n: c.n, e: c.e, sc: c.sc, v: c.v}));
for (const [k, arr] of Object.entries(out.screens)) arr.forEach(c => rec.push({d: date, src: k, n: c.n, e: c.e, sc: c.sc}));
store.picks.push(...rec);
store.regime = Object.assign({}, store.regime, {[date]: out.regime});
store.updated = date;
snaps[date] = todaySnap;
const keep = Object.keys(snaps).sort().slice(-45);
for (const k of Object.keys(snaps)) if (!keep.includes(k)) delete snaps[k];

fs.writeFileSync("picks.json", JSON.stringify(store));
fs.writeFileSync("snapshots.json", JSON.stringify(snaps));
publish();

const strong = out.committee.filter(c => c.sc >= 3).map(c => c.n);
if (strong.length) fs.writeFileSync("alerts.txt", `Borsa Komitesi ${date}: güçlü aday → ${strong.join(", ")}`);
console.log(`${date}: ${rec.length} kayıt, ${evaluated} sonuç değerlendirildi, güçlü aday: ${strong.length}, rejim: ${out.regime && out.regime.label}`);
