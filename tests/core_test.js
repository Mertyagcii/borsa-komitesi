// Çekirdek mantık testi (Node): tüm hisselerde komite, masa toplantısı, değerleme, ucuz/pahalı, çok zamanlı skor hatasız ve makul aralıkta olmalı.
// Kullanım: node tests/core_test.js <site-klasörü>
const fs = require("fs"), vm = require("vm"), path = require("path");
const site = process.argv[2] || "site", rd = f => JSON.parse(fs.readFileSync(path.join(site, f), "utf8"));
const data = rd("data.json"), hist = rd("history.json"), news = rd("news.json").news || {}, research = rd("research.json"), mtfr = rd("mtf_composite.json"), k2r = rd("kurul2_research.json"), mr = rd("macro_research.json");
const ctx = vm.createContext({console, Intl, Math, Date, __data: data, __hist: hist, __news: news, __research: research, __mtfr: mtfr, __k2: k2r, __mr: mr, __NOW: Date.now()});
const out = vm.runInContext(`
${fs.readFileSync(path.join(__dirname, "..", "core.js"), "utf8")}
let R = Object.assign({}, DEFAULTS); let HIST = __hist; let NEWS = __news; let current = [];
RESEARCH = __research; MTFR = __mtfr; KUR2 = __k2; MACRO_R = __mr; NOW = __NOW;
const UNI = __data.stocks.map(enrich); rankUniverse(UNI); computeSectorStats(UNI); REGIME = computeRegime(UNI, HIST);
UNIVERSE = UNI;
current = strengthList(UNI, 25, 5);
const errs = [], stat = {n: UNI.length, committee: 0, meeting: 0, val: 0, mtf: 0, cheap: 0}, cnt = {};
for (const s of UNI) {
  try { if (s.mtf) { stat.mtf++; for (const k of ["d", "w", "m", "b"]) { const v = s.mtf[k]; if (v != null && !(v >= 0 && v <= 100)) errs.push(s.name + " skor aralık dışı " + k + "=" + v); } const t = mtfTier(s); if (t) cnt[t.id] = (cnt[t.id] || 0) + 1; mtfExpect(s); } } catch (e) { errs.push(s.name + " mtf: " + e.message); }
  if (!s.ok || s.tl < 5) continue;
  try { const r = committee(s); stat.committee++; if (!(r.score >= -5 && r.score <= 5)) errs.push(s.name + " komite skoru " + r.score); const m = meeting(s, r); if (!m.lines.length || !m.verdict) errs.push(s.name + " toplantı boş"); stat.meeting++; } catch (e) { errs.push(s.name + " komite: " + e.message); }
  try { const v = valuation(s); stat.val++; if (v.fair != null && !(v.fair > 0)) errs.push(s.name + " adil değer " + v.fair); const c = cheapness(s); if (c) { stat.cheap++; if (!(c.pct >= 0) || ["UCUZ", "PAHALI", "ADİL"].indexOf(c.lab) < 0) errs.push(s.name + " ucuz/pahalı bozuk"); } } catch (e) { errs.push(s.name + " değerleme: " + e.message); }
}
const el = UNI.filter(s => s.ok && s.tl >= 10 && s.eps > 0), ups = el.map(s => valuation(s).upside).filter(x => x != null).sort((a, b) => a - b), md = ups[Math.floor(ups.length / 2)];
if (!(md > -40 && md < 60)) errs.push("adil değer medyan fark makul değil: " + md);
const lead = UNI.find(s => s.mtf && mtfTier(s) && mtfTier(s).id === "uyumlu");
if (lead) { const sm = similarStocks(lead, 5); if (sm.top.length !== 5) errs.push("benzer hisse sayısı " + sm.top.length); }
for (const id of ["haftalik", "gunluk", "aylik", "bebek", "halkaarz"]) {
  const P = scanDefaults(id), r = runScan(id, P, {trace: false});
  for (let i = 1; i < r.steps.length; i++) if (r.steps[i].n_out > r.steps[i].n_in || r.steps[i].n_in !== r.steps[i - 1].n_out) errs.push("tarama huni tutarsız: " + id + " adım " + i);
  if (r.list.length !== r.steps[r.steps.length - 1].n_out) errs.push("tarama listesi son adımla uyuşmuyor: " + id);
  const nm = scanNearMiss(id, P, 10); if (nm.some(o => r.list.includes(o.s))) errs.push("yaklaşanlar listede olmamalı: " + id);
  if (id === "haftalik" && !r.list.every(s => s.mtf.w >= P.wMin && Math.abs(s.change) < 9.5 && s.tl >= P.minTl)) errs.push("haftalık tarama eşiği ihlal");
  if (id === "halkaarz" && !r.list.every(s => { const a = ageDaysOf(s); return a >= P.minAge && a <= P.maxAge; })) errs.push("bebek yaş eşiği ihlal");
  if (r.list[0]) { const tr = scanTrace(id, P, r.list[0]); if (!tr.pass && P.veto !== 1) errs.push("iz ile liste çelişiyor: " + id); }
  if (id === "bebek" && !r.list.every(s => s.de <= P.maxDe && s.nipos8 >= P.minPosQ && s.p6m <= P.maxP6)) errs.push("bebek eşiği ihlal");
  stat["scan_" + id] = r.list.length;
}
// --- genişletilmiş kurul (4 yeni uzman) ---
let k2n = 0, k2lines = 0, k2veto = 0;
for (const s of UNI.filter(x => x.ok && x.tl >= 20).slice(0, 250)) {
  try {
    const r = committee(s), k = r.k2;
    for (const key of PERSONAS2_KEYS) { if (!k[key] || ![-1, 0, 1].includes(k[key].v) || !Array.isArray(k[key].checks) || !k[key].t) errs.push(s.name + " yeni uzman bozuk: " + key); }
    if (r.net2 !== PERSONAS2_KEYS.reduce((a, x) => a + k[x].v, 0)) errs.push(s.name + " net2 tutarsız");
    if (r.veto2) k2veto++;
    const m = meeting(s, r); if (m.lines.some(x => PERSONAS2_KEYS.includes(x.who))) k2lines++; k2n++;
    if (typeof r.score !== "number" || r.score < -5 || r.score > 5) errs.push(s.name + " mevcut komite skoru bozuldu");
  } catch (e) { errs.push(s.name + " k2: " + e.message); }
}
stat.k2 = k2n; stat.k2lines = k2lines; stat.k2veto = k2veto;
if (k2lines < 5) errs.push("yeni uzmanlar toplantıda yeterince konuşmuyor: " + k2lines);
// makro kalkan: sentetik makro verisi
const savedMacro = HIST.macro; HIST.macro = {date: "2026-10-12", rf10: 32, rf2: 30, usdtry_d5: 5, vix: 30, brent_d20: 20, dxy_d20: 3, gold_d20: 8, rf10_d20: 2, us10y_d20: 0.5};
const sh = macroShield(); if (!(sh.count === 7 && sh.level === "Şiddetli" && sh.items.length === 7)) errs.push("makro kalkan sentetik: " + sh.count + "/" + sh.level);
const any = UNI.find(x => x.ok && x.tl >= 20);
R.makroVeto = 0; if (macroP(any).veto) errs.push("makro veto kapalıyken veto verdi");
R.makroVeto = 1; R.makroN = 4; if (!macroP(any).veto || !committee(any).veto2) errs.push("makro veto açıkken veto vermedi"); R.makroVeto = 0;
HIST.macro = {date: "2026-10-12", rf10: 32, rf2: 30, usdtry_d5: 0.2, vix: 14, brent_d20: 1, dxy_d20: 0, gold_d20: 0, rf10_d20: 0, us10y_d20: 0}; if (macroShield().count !== 0) errs.push("makro sakin sentetik 0 olmalı");
HIST.macro = savedMacro;
// dış veriler (VİOP, kullanıcı AKD) sentetik
VIOP = {expiry: "2026-10-30", stocks: {}}; VIOP.stocks[any.name] = {fut: 100, basis: 4, excess: 2, vol: 1000, vol_ratio: 1.2};
VIOP_R = {factors: {fazla_prim: {verdict: "kanıt var"}}, stats: {p10: -1, p90: 1}};
let ap0 = akilliP(any); if (!ap0.checks.some(c => c.t.indexOf("VİOP") >= 0) || ap0.viopV !== 1) errs.push("vadeli prim oyu: " + ap0.viopV);
VIOP_R.factors.fazla_prim.verdict = "belirsiz"; ap0 = akilliP(any); if (ap0.viopV !== 0) errs.push("belirsiz vadeli oy vermemeli");
VIOP = null; VIOP_R = null;
AKD_USER = {}; AKD_USER[any.name] = {d: "2026-10-12", bal: -0.12, conc: 0.05, foreign: 31, n: 1}; ap0 = akilliP(any); if (!ap0.checks.some(c => c.t.indexOf("Kullanıcı AKD") >= 0 && c.s === -1)) errs.push("AKD olumsuz işaretlenmedi");
AKD_USER = null;
// psikoloji: panik sentetik
const fake = Object.assign({}, any, {change: -8, rvol: 3.2, rsi: 22, name: "SENTETIK"}); const pp = psikoP(fake); if (!pp.panic) errs.push("panik tespit edilmedi"); if (pp.v !== -1 && KUR2.signals.panik.verdict === "ters kanıt") errs.push("panik oyu −1 olmalı");
// akıllı para: dağıtım sentetik
const fd = Object.assign({}, any, {rvol: 3, change: 0.5, cmf: -0.3}); const ap = akilliP(fd); if (ap.v !== -1) errs.push("dağıtım −1 olmalı");
const dh = dataHealth(5); if (!(dh.score >= 0 && dh.score <= 100)) errs.push("veri sağlığı aralık dışı");
if (!(tierId(80, 90, 70) === "uyumlu" && tierId(10, 85, 10) === "hlider" && tierId(50, 20, 50) === "zayif" && tierId(50, 50, 50) === "notr" && tierId(null, null, null) === null)) errs.push("tierId tanımı bozuk");
// --- Hata Avcısı (Fact-Checker) ---
fcReset();
const liqs = UNI.filter(x => x.ok && x.tl >= 10), lockedReal = liqs.filter(s => factCheck(s, committee(s), {nocache: true}).locked);
stat.fcLocked = lockedReal.length + "/" + liqs.length;
if (lockedReal.length > Math.max(2, liqs.length * 0.03)) errs.push("Hata Avcısı gerçek veride çok fazla kilit (yanlış alarm?): " + lockedReal.map(s => s.name).join(","));
const fcS = liqs.find(s => { const f = factCheck(s, committee(s), {nocache: true}); return !f.stale && !f.locked && f.checked >= 4; });
if (!fcS) errs.push("Hata Avcısı için ham verisi olan hisse bulunamadı");
else {
  const rr = committee(fcS), orig = {rsi: fcS.rsi, sma50: fcS.sma50, change: fcS.change, close: fcS.close};
  fcS.rsi = (fcS.rsi > 50 ? 12 : 88); let f1 = factCheck(fcS, rr, {nocache: true});
  if (!f1.locked || !f1.issues.some(i => i.field === "rsi" && i.kind === "veri")) errs.push("uydurma RSI yakalanmadı");
  if (!/Düzeltme talebi/.test(f1.request || "")) errs.push("kilitte düzeltme talebi yok");
  fcS.rsi = orig.rsi; fcS.sma50 = orig.sma50 * 1.2; f1 = factCheck(fcS, rr, {nocache: true}); if (!f1.locked || !f1.issues.some(i => i.field === "sma50")) errs.push("uydurma SMA50 yakalanmadı");
  fcS.sma50 = orig.sma50; fcS.change = orig.change + 6; f1 = factCheck(fcS, rr, {nocache: true}); if (!f1.locked) errs.push("uydurma günlük değişim yakalanmadı");
  fcS.change = orig.change;
  const rawRsi = fcRecalc(fcS).rsi[0], fakeR = Object.assign({}, rr, {l: Object.assign({}, rr.l, {kellogg: Object.assign({}, rr.l.kellogg, {t: "Hacim güçlü, RSI " + Math.round(rawRsi > 50 ? 5 : 95) + " ile aşırı."})})});
  f1 = factCheck(fcS, fakeR, {nocache: true}); if (!f1.locked || !f1.issues.some(i => i.kind === "metin")) errs.push("metindeki uydurma rakam yakalanmadı");
  const okR = Object.assign({}, rr, {l: Object.assign({}, rr.l, {kellogg: Object.assign({}, rr.l.kellogg, {t: "RSI " + Math.round(rawRsi) + " ile normal."})})});
  f1 = factCheck(fcS, okR, {nocache: true}); if (f1.issues.some(i => i.kind === "metin")) errs.push("doğru metin rakamı yanlışlıkla işaretlendi");
  f1 = factCheck(fcS, rr, {nocache: true}); if (f1.locked) errs.push("veri düzelince kilit kalkmadı");
  stat.fcChecked = f1.checked;
}
// --- Alarm motoru ---
const al0 = marketAlarms().length;
const aS = UNI.find(s => s.ok && s.tl >= 30 && s.sma50 > 0 && s.change != null), aOrig = {rvol: aS.rvol, change: aS.change, tl: aS.tl, close: aS.close};
aS.rvol = 6; aS.change = -5; aS.tl = 150; let am = marketAlarms();
const av = am.find(a => a.id === "vol:" + aS.name); if (!av || av.sev !== 3) errs.push("hacim patlaması alarmı kritik değil: " + JSON.stringify(av));
aS.change = 4; am = marketAlarms(); if (!am.find(a => a.id === "vol:" + aS.name)) errs.push("hacim patlaması (yükseliş) alarmı yok");
aS.rvol = 1.2; am = marketAlarms(); if (am.find(a => a.id === "vol:" + aS.name)) errs.push("normal hacimde alarm üretildi");
aS.rvol = 1; aS.change = -3; aS.close = aS.sma50 * 0.99; aS.change = (aS.close / (aS.sma50 * 1.02) - 1) * 100; am = marketAlarms(); if (!am.find(a => a.id === "sma50dn:" + aS.name)) errs.push("SMA50 aşağı kırılımı alarmı yok");
Object.assign(aS, aOrig);
const panicSave = UNI.map(s => s.change); UNI.forEach(s => { if (s.ok && s.tl >= 5) s.change = -4; }); am = marketAlarms(); if (!am.some(a => a.id === "breadth" && a.sev === 3)) errs.push("geniş satış alarmı yok"); if (!am.some(a => a.id === "taban" || a.id === "panic")) errs.push("piyasa panik alarmı yok");
UNI.forEach((s, i) => { s.change = panicSave[i]; }); stat.alarms = al0;
const dvS = current.find(s => devil(s, null).veto), dvAlarm = dvS && marketAlarms().find(a => a.id === "veto:" + dvS.name); if (dvS && !dvAlarm) errs.push("Şeytanın Avukatı vetosu alarm üretmedi");
// --- Arşiv ---
const dayA = archiveDay("2026-10-13", __data.ts), mdA = archiveMd(dayA, {alarms: [{t: "11:00", sev: 3, text: "deneme alarmı"}], scorecard: "skor kartı", portfolios: "portföy"});
if (dayA.stocks.length !== current.length) errs.push("arşiv aday sayısı tutarsız");
for (const k of ["# Borsa Komitesi Seans Raporu", "Baş Denetçi", "Hata Avcısı", "Monte Carlo", "Masa tartışması", "Geri test skor kartı", "Gün içi alarmlar", "deneme alarmı"]) if (mdA.indexOf(k) < 0) errs.push("arşivde eksik bölüm: " + k);
if (!/^\| .* \| .* \|/m.test(mdA)) errs.push("arşiv özet tablosu yok");
const lk = current[0], lkRsi = lk.rsi; lk.rsi = lkRsi > 50 ? 5 : 95; fcReset();
const dayB = archiveDay("2026-10-13", __data.ts), mdB = archiveMd(dayB, {});
if (!dayB.locks.includes(lk.name) || dayB.audit.indexOf("RED") !== 0) errs.push("kilitli hisse arşivde mühürü bozmadı");
if ((mdB.match(/### Masa tartışması/g) || []).length !== (mdA.match(/### Masa tartışması/g) || []).length - 1 && committee(lk) && factCheck(lk, committee(lk)).stale === false) errs.push("kilitli hissenin tartışması arşive girdi");
if (mdB.indexOf("RAPOR KİLİTLİ") < 0) errs.push("arşivde kilit notu yok");
lk.rsi = lkRsi; fcReset();
({stat, tiers: cnt, medianUpside: md, errs: errs.slice(0, 20), nerr: errs.length})
`, ctx);
console.log(JSON.stringify(out));
process.exit(out.nerr ? 1 : 0);
