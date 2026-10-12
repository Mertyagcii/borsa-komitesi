#!/usr/bin/env node
/* Günlük kayıtlar (seans kapanışından sonra, hafta içi 18:45 TR):
   1) Komite karnesi: komitenin ve efsane ekranlarının o günkü kararları picks.json'a yazılır; önceki kayıtların 5/10/20 iş günü sonraki
      getirisi piyasa ortalamasıyla (likit 150 hisse) kıyaslanır.
   2) Haber katalizörü sınaması: etiketli haberler (temettü, ihale, bilanço ...) news_log.json'a yazılır; sonraki getirileri ölçülür.
   3) Noktasal temel veri: haftada bir fundamentals/<tarih>.json (kalite/değer faktörlerini ileride test etmek için).
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
const research = read("research.json", null);
const mtfr = read("mtf_composite.json", null);

function istanbul() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false}).formatToParts(new Date()).map(x => [x.type, x.value]));
  return {date: `${p.year}-${p.month}-${p.day}`, wd: p.weekday, min: (+p.hour % 24) * 60 + +p.minute};
}
const now = istanbul(), date = opt("date", now.date);
const mlog = read("mtf_log.json", {days: []}), store = read("picks.json", {picks: [], updated: null}), snaps = read("snapshots.json", {}), nlog = read("news_log.json", {events: []});
const afterClose = !["Sat", "Sun"].includes(now.wd) && now.min >= 18 * 60 + 45;

function publish() {
  fs.mkdirSync(SITE, {recursive: true});
  fs.writeFileSync(path.join(SITE, "picks.json"), JSON.stringify(store));
  fs.writeFileSync(path.join(SITE, "news_log.json"), JSON.stringify(nlog));
  fs.writeFileSync(path.join(SITE, "snapshots.json"), JSON.stringify(snaps));
  fs.writeFileSync(path.join(SITE, "mtf_log.json"), JSON.stringify(mlog));
}
if (!FORCE && (!afterClose || store.picks.some(p => p.d === date))) {
  console.log(!afterClose ? "Seans kapanışı değil; kayıt atlandı." : `${date} zaten kaydedildi.`);
  if (fs.existsSync("picks.json")) publish();
  process.exit(0);
}

/* ---- core.js'i bir vm içinde çalıştır (tarayıcıyla aynı mantık) ---- */
const coreSrc = fs.readFileSync(path.join(__dirname, "core.js"), "utf8");
const ctx = vm.createContext({console, Intl, Math, Date, __data: data, __hist: hist, __news: news, __research: research, __mtfr: mtfr, __NOW: Date.now()});
const FUND_COLS = ["name", "close", "roe", "nm", "gm", "de", "fcf", "mcap", "eps", "bvps", "epsg", "pe", "pb", "dy", "debt", "ebitda", "cash", "p1m", "p6m", "rs"];
const out = vm.runInContext(`
${coreSrc}
let R = Object.assign({}, DEFAULTS); let HIST = __hist; let NEWS = __news; let current = [];
RESEARCH = __research; MTFR = __mtfr; NOW = __NOW;
const UNI = __data.stocks.map(enrich); rankUniverse(UNI); computeSectorStats(UNI);
REGIME = computeRegime(UNI, HIST);
current = strengthList(UNI, 25, 5);
const res = current.map(s => [s, committee(s)]);
const sc = personaScreens(UNI, 8, []);
const liquid300 = UNI.filter(s => s.ok && s.tl >= 10).sort((a, b) => b.tl - a.tl).slice(0, 300);
const events = [];
Object.entries(NEWS).forEach(([n, v]) => { const s = UNI.find(x => x.name === n); if (!s || !s.close) return;
  (v.items || []).forEach(i => { const tg = tagsOf(i.t).map(x => x[0]); if (tg.length && NOW / 1000 - i.ts < 4 * 86400) events.push({k: n + "|" + i.ts, n, ts: i.ts, tags: tg, s: i.s, e: s.close}); }); });
({
  committee: res.map(([s, r]) => ({n: s.name, e: s.close, sc: r.score, v: [r.l.buffett.v, r.l.simons.v, r.l.livermore.v, r.l.kellogg.v, r.l.seytan.v]})),
  screens: Object.fromEntries(Object.entries(sc).map(([k, arr]) => [k, arr.map(([s, p]) => ({n: s.name, e: s.close, sc: p.score}))])),
  regime: REGIME && {trend: REGIME.trend, label: REGIME.label, a50: Math.round(REGIME.a50)},
  liquid: UNI.filter(s => s.close > 0 && s.volume).map(s => [s.name, s.close, s.tl]).sort((a, b) => b[2] - a[2]).slice(0, 150).map(([n, c]) => [n, c]),
  fund: liquid300.map(s => ${JSON.stringify(FUND_COLS)}.map(c => { const v = s[c]; return typeof v === "number" ? Math.round(v * 1e4) / 1e4 : v ?? null; })),
  events,
  mtf: UNI.filter(s => s.ok && s.mtf && s.mtf.w != null && s.close > 0).map(s => [s.name, s.mtf.d == null ? null : Math.round(s.mtf.d), Math.round(s.mtf.w), s.mtf.m == null ? null : Math.round(s.mtf.m), s.close, tierId(s.mtf.d, s.mtf.w, s.mtf.m)]),
})`, ctx);

const nowClose = Object.fromEntries(data.stocks.filter(s => s.close > 0).map(s => [s.name, s.close]));
const todaySnap = Object.fromEntries(out.liquid);
const bdays = (a, b) => { let n = 0; const d = new Date(a + "T12:00:00Z"), e = new Date(b + "T12:00:00Z");
  while (d < e) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; } return n; };
const r2 = x => Math.round(x * 100) / 100;

/* ---- geçmiş kayıtları değerlendir (karne + haber olayları aynı mantık) ---- */
function evalList(list, dateOf) {
  let n = 0;
  for (const p of list) {
    const d0 = dateOf(p); if (d0 >= date) continue;
    const age = bdays(d0, date), s0 = snaps[d0];
    for (const h of [5, 10, 20]) {
      if (age < h || (p.r && p.r[h] != null) || !nowClose[p.n]) continue;
      p.r = p.r || {}; p.b = p.b || {};
      p.r[h] = r2((nowClose[p.n] / p.e - 1) * 100);
      if (s0) {
        const xs = Object.keys(s0).filter(k => todaySnap[k]).map(k => todaySnap[k] / s0[k] - 1);
        p.b[h] = xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length * 100) : null;
      } else p.b[h] = null;
      n++;
    }
  }
  return n;
}
const evaluated = evalList(store.picks, p => p.d) + evalList(nlog.events, p => p.d);

/* ---- bugünün kayıtları ---- */
store.picks = store.picks.filter(p => p.d !== date);
const rec = [];
out.committee.forEach(c => rec.push({d: date, src: "komite", n: c.n, e: c.e, sc: c.sc, v: c.v}));
for (const [k, arr] of Object.entries(out.screens)) arr.forEach(c => rec.push({d: date, src: k, n: c.n, e: c.e, sc: c.sc}));
store.picks.push(...rec);
store.regime = Object.assign({}, store.regime, {[date]: out.regime});
store.updated = date;

// haber olayları (aynı habere tek kayıt)
const seen = new Set(nlog.events.map(e => e.k));
let newEv = 0;
for (const ev of out.events) if (!seen.has(ev.k)) { nlog.events.push({k: ev.k, d: date, n: ev.n, ts: ev.ts, tags: ev.tags, s: ev.s, e: ev.e}); newEv++; }
nlog.events = nlog.events.filter(e => bdays(e.d, date) <= 60 || !e.r).slice(-4000);
nlog.updated = date;

/* canlı tahmin karnesi: her gün TÜM skorlu hisselerin [ad, günlük, haftalık, aylık skor, kapanış, kurulum] kaydı.
   Sonuçlar (5/10/20 gün sonrası, piyasa ortalamasına göre) tarayıcıda bu kayıttan hesaplanır: kalibrasyon ve isabet. */
const prevDay = mlog.days.filter(x => x.d < date).slice(-1)[0];
mlog.days = mlog.days.filter(x => x.d !== date);
mlog.days.push({d: date, r: out.mtf});
mlog.days = mlog.days.slice(-160);
mlog.updated = date;
const liquidSet = new Set(out.liquid.slice(0, 100).map(x => x[0])), prevT = prevDay ? Object.fromEntries(prevDay.r.map(x => [x[0], x[5]])) : {};
const isLead = t => t === "uyumlu" || t === "hlider";
const newLeaders = out.mtf.filter(x => isLead(x[5]) && !isLead(prevT[x[0]]) && liquidSet.has(x[0]) && prevDay).map(x => x[0]).slice(0, 12);
snaps[date] = todaySnap;
const keep = Object.keys(snaps).sort().slice(-45);
for (const k of Object.keys(snaps)) if (!keep.includes(k)) delete snaps[k];

// noktasal temel veri: son kayıttan ≥5 gün geçtiyse yaz
fs.mkdirSync("fundamentals", {recursive: true});
const fdates = fs.readdirSync("fundamentals").filter(f => f.endsWith(".json")).map(f => f.slice(0, 10)).sort();
let fundNote = "";
if (!fdates.length || bdays(fdates[fdates.length - 1], date) >= 5) {
  fs.writeFileSync(path.join("fundamentals", date + ".json"), JSON.stringify({d: date, cols: FUND_COLS, rows: out.fund}));
  fundNote = ` | temel veri kaydı: ${out.fund.length} hisse`;
}

fs.writeFileSync("picks.json", JSON.stringify(store));
fs.writeFileSync("snapshots.json", JSON.stringify(snaps));
fs.writeFileSync("news_log.json", JSON.stringify(nlog));
fs.writeFileSync("mtf_log.json", JSON.stringify(mlog));
publish();

const strong = out.committee.filter(c => c.sc >= 3).map(c => c.n);
const alertLines = [];
if (strong.length) alertLines.push(`güçlü aday → ${strong.join(", ")}`);
if (newLeaders.length) alertLines.push(`yeni lider kurulum (haftalık skor) → ${newLeaders.join(", ")}`);
if (alertLines.length) fs.writeFileSync("alerts.txt", `Borsa Komitesi ${date}: ` + alertLines.join(" | ") + " (yatırım tavsiyesi değildir)");
console.log(`${date}: ${rec.length} kayıt, ${evaluated} sonuç değerlendirildi, ${newEv} yeni haber olayı, güçlü aday: ${strong.length}, yeni lider: ${newLeaders.length}, skor kaydı: ${out.mtf.length} hisse, rejim: ${out.regime && out.regime.label}${fundNote}`);
