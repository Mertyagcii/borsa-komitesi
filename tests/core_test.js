// Çekirdek mantık testi (Node): tüm hisselerde komite, masa toplantısı, değerleme, ucuz/pahalı, çok zamanlı skor hatasız ve makul aralıkta olmalı.
// Kullanım: node tests/core_test.js <site-klasörü>
const fs = require("fs"), vm = require("vm"), path = require("path");
const site = process.argv[2] || "site", rd = f => JSON.parse(fs.readFileSync(path.join(site, f), "utf8"));
let stressJ = null; try { stressJ = rd("stress.json"); } catch (e) { /* stres verisi yoksa ilgili testler atlanır */ }
let candlesJ = null; try { candlesJ = rd("candles.json"); } catch (e) { /* mum verisi yoksa seviye testi atlanır */ }
const data = rd("data.json"), hist = rd("history.json"), news = rd("news.json").news || {}, research = rd("research.json"), mtfr = rd("mtf_composite.json"), k2r = rd("kurul2_research.json"), mr = rd("macro_research.json");
const ctx = vm.createContext({console, Intl, Math, Date, __data: data, __hist: hist, __news: news, __research: research, __mtfr: mtfr, __k2: k2r, __mr: mr, __NOW: Date.now(), __candles: candlesJ, __stress: stressJ});
const out = vm.runInContext(`
${fs.readFileSync(path.join(__dirname, "..", "core.js"), "utf8")}
let R = Object.assign({}, DEFAULTS); let HIST = __hist; let NEWS = __news; let current = [];
RESEARCH = __research; MTFR = __mtfr; KUR2 = __k2; MACRO_R = __mr; STRESS = __stress; NOW = __NOW;
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
// --- Hafıza, Boğa/Ayı münazarası, Sektör kıyası ---
const hs = current[0], hr = committee(hs), dbg = debate(hs, hr);
if (!(dbg.al + dbg.tut + dbg.sat === 100 && dbg.al >= 0 && dbg.tut >= 0 && dbg.sat >= 0)) errs.push("ağırlıklı karar yüzdeleri 100 etmiyor: " + dbg.text);
if (!dbg.lines.length || !dbg.label) errs.push("münazara boş");
const seenTxt = new Set(); dbg.lines.forEach(x => { if (seenTxt.has(x.text)) errs.push("münazarada aynı satır tekrarlandı"); seenTxt.add(x.text); });
const nvote = hr.l.buffett.v + hr.l.simons.v + hr.l.livermore.v + hr.l.kellogg.v + hr.l.seytan.v; if (hr.score !== nvote) errs.push("komite skoru bozuldu");
const alAll = UNI.filter(x => x.ok && x.tl >= 20).slice(0, 120).map(x => debate(x, committee(x)));
if (alAll.some(d => d.al + d.tut + d.sat !== 100)) errs.push("bazı hisselerde ağırlıklı karar 100 etmiyor");
if (alAll.some(d => (d.bull.n === 0 && !d.bull.appointed) || (d.bear.n === 0 && !d.bear.appointed))) errs.push("resen atanan taraf işaretlenmedi");
// hafıza: yok -> satır yok; sentetik geçmiş -> satırlar, çelişen oy gerekçelenir; eşik titremesi ayırt edilir
buildMemory([]); if (memoryLines(hs, hr).lines.length) errs.push("hafıza boşken satır üretildi");
const dPast = new Date(Date.parse(fcToday()) - 7 * 864e5).toISOString().slice(0, 10), flip = [-hr.l.buffett.v || 1, hr.l.simons.v, hr.l.livermore.v, hr.l.kellogg.v, hr.l.seytan.v];
buildMemory([{d: dPast, src: "komite", n: hs.name, e: hs.close * 0.9, sc: 1, v: flip, r: {5: 4}, b: {5: 1}}]);
let ml = memoryLines(hs, hr);
if (!ml.lines.length || !/Hafızaya baktım/.test(ml.lines[0].text)) errs.push("hafıza girişi yok");
if (!ml.flips.some(f => f.k === "buffett" && !f.tiny)) errs.push("gerçek fikir değişimi algılanmadı");
if (!ml.lines.some(l => /Fikrim değişti çünkü/.test(l.text))) errs.push("oy değişimi gerekçelendirilmedi");
if (!ml.lines.some(l => /Sonuç notu/.test(l.text))) errs.push("geçmiş sonuç notu yok");
if (!meeting(hs, hr).lines.some(l => /Hafızaya baktım/.test(l.text))) errs.push("toplantıda hafıza yok");
buildMemory([{d: dPast, src: "komite", n: hs.name, e: hs.close * 0.999, sc: hr.score, v: flip}]);
ml = memoryLines(hs, hr); if (!ml.flips.some(f => f.tiny) || !ml.lines.some(l => /eşik sınırında/.test(l.text))) errs.push("eşik titremesi ayırt edilmedi");
if (!consistencyIssues(hs, hr).some(x => /titremesi/.test(x)) && flip[0] * hr.l.buffett.v < 0) errs.push("gerekçesiz tersine dönüş denetçiye bildirilmedi");
buildMemory([{d: fcToday(), src: "komite", n: hs.name, e: hs.close, sc: 9, v: flip}]); if (memoryLines(hs, hr).lines.length) errs.push("bugünün kaydı hafıza sayıldı");
// öğrenme: 30'dan az örnekte ağırlık 1; 40 örnekte isabet oranına göre
buildMemory([]); if (memWeight("simons") !== 1) errs.push("örneksizken ağırlık 1 olmalı");
const lp = []; for (let i = 0; i < 40; i++) lp.push({d: "2026-01-0" + (1 + i % 9), src: "komite", n: "X" + i, e: 10, sc: 2, v: [0, 1, 0, 0, 0], r: {10: i < 30 ? 5 : -5}, b: {10: 0}});
buildMemory(lp); const wS = memWeight("simons"); if (!(wS > 1.2 && wS <= 1.4) || memWeight("buffett") !== 1) errs.push("öğrenilmiş ağırlık hatalı: " + wS);
const lp2 = lp.map(x => Object.assign({}, x, {r: {10: -5}})); buildMemory(lp2); if (!(memWeight("simons") >= 0.6 && memWeight("simons") < 0.8)) errs.push("kötü isabette ağırlık düşmedi");
buildMemory([]);
// sektör kıyası: sentetik sektör (3 katman ayrımı)
const pg = UNI.filter(x => x.ok && x.tl >= 5 && x.sector === hs.sector);
const pv = peerView(hs); if (pg.length >= 4) { if (!pv || pv.rows.length !== 4 || pv.n !== pg.length) errs.push("sektör kıyası bozuk"); }
const sy = Object.assign({}, UNI.find(x => x.ok && x.tl >= 5), {name: "SYNTH", sector: "SYNSEC", change: -8, p1m: -20, p3m: -25, p6m: -30, mcap: 1e9});
const syPeers = [0, 1, 2, 3].map(i => Object.assign({}, sy, {name: "P" + i, change: -7.5 + i * 0.2, p1m: -19 + i, p3m: -24, p6m: -29, mcap: 2e9 - i}));
const syFlat = [0, 1, 2, 3].map(i => Object.assign({}, sy, {name: "Q" + i, sector: "SYNFLAT", change: 0.2, p1m: 1, p3m: 2, p6m: 3, mcap: 1e9 + i}));
const uniSave = UNIVERSE; UNIVERSE = uniSave.concat([sy], syPeers, syFlat);
let pS = peerView(sy); if (!pS || pS.rows[0].type !== "sektörel" || pS.rows[1].type !== "sektörel") errs.push("sektörel hareket ayırt edilemedi: " + (pS && pS.rows.map(x => x.type)));
const sy2 = Object.assign({}, sy, {sector: "SYNFLAT", name: "SYNTH2"}); UNIVERSE = uniSave.concat([sy2], syFlat); pS = peerView(sy2);
if (!pS || pS.rows[0].type !== "hisseye özel" || pS.rows[1].type !== "hisseye özel") errs.push("hisseye özel hareket ayırt edilemedi: " + (pS && pS.rows.map(x => x.type)));
if (pS.rows[0].rel > -7) errs.push("sektöre göre fark hatalı: " + pS.rows[0].rel);
const pl = peerLines(sy2, committee(any), pS); if (!pl.some(l => /hisseye özel/.test(l.text)) || !pl.some(l => l.who === "seytan")) errs.push("efsaneler hisseye özel düşüşü yorumlamadı");
UNIVERSE = uniSave.concat([sy], syPeers); pS = peerView(sy); const pl2 = peerLines(sy, committee(any), pS); if (!pl2.some(l => /sektörel/.test(l.text))) errs.push("efsaneler sektörel düşüşü yorumlamadı");
UNIVERSE = uniSave;
// Hata Avcısı üretilmiş satırları taramamalı
fcReset(); const gen = factCheck(hs, hr, {nocache: true}); if (gen.issues.some(i => i.kind === "metin")) errs.push("üretilmiş satırlar iddia olarak tarandı");
// --- Arena (isabet tablosu) ---
const wl = wilson(8, 10); if (!(wl[0] > 0.4 && wl[0] < 0.5 && wl[1] > 0.9 && wl[1] <= 1) || wilson(0, 0) !== null) errs.push("Wilson aralığı hatalı: " + wl);
const mkp = (d, n, sc, v, r10, b10, src) => ({d, src: src || "komite", n, e: 10, sc, v, v2: [1, 0, -1, 0], r: r10 == null ? undefined : {10: r10}, b: b10 == null ? undefined : {10: b10}});
const arP = []; for (let i = 0; i < 40; i++) arP.push(mkp("2026-01-" + String(1 + i % 28).padStart(2, "0"), "A" + i, 2, [1, -1, 0, 1, 0], i < 30 ? 6 : -6, 1));   // 1. oy: 40 olumlu (30 tuttu); 2. oy: 40 olumsuz (10 tuttu)
arP.push(mkp("2026-02-01", "Z", 3, [1, 1, 1, 1, 1], null, null));                    // sonucu henüz yok: bekleyen
arP.push(mkp("2026-02-01", "SCR", 0, undefined, 5, 0, "livermore"));                // ekran kaydı
const AS = arenaStats(arP, 10), rowOf = id => AS.rows.find(x => x.id === id);
if (!(rowOf("buffett").n === 40 && rowOf("buffett").hit === 30 && rowOf("buffett").up.n === 40 && rowOf("buffett").pending === 1)) errs.push("arena buffett sayımı hatalı: " + JSON.stringify(rowOf("buffett")));
if (!(rowOf("simons").n === 40 && rowOf("simons").hit === 10 && rowOf("simons").dn.n === 40 && rowOf("simons").status === "anlamlı olarak kötü")) errs.push("arena olumsuz oy isabeti hatalı: " + JSON.stringify(rowOf("simons")));
if (rowOf("buffett").status !== "anlamlı üstünlük") errs.push("arena anlamlılık hatalı: " + rowOf("buffett").status);
if (rowOf("livermore").n !== 0 || rowOf("livermore").pending !== 1 || rowOf("livermore").status !== "yetersiz örnek") errs.push("arena küçük örnek hatalı");
if (!rowOf("ekran:livermore") || rowOf("ekran:livermore").up.hit !== 1) errs.push("arena ekran satırı yok");
if (!rowOf("makro") || rowOf("makro").up.n !== 40) errs.push("arena yeni uzman (v2) oyları sayılmadı");
if (AS.rows[0].id !== "buffett" && AS.rows[0].id !== "makro" && AS.rows[0].id !== "komite") errs.push("arena sıralaması alt sınıra göre değil: " + AS.rows[0].id);
if (arenaStats([], 10).rows.length !== 0 || arenaStats(null, 10).rows.length !== 0) errs.push("arena boş kayıt hatalı");
const AS5 = arenaStats(arP, 5); if (AS5.measured !== 0) errs.push("arena ufku ayrımı hatalı (5g sonucu yokken ölçüm var)");
// --- Yüksek güvenilirlikli sinyal ---
let hcN = 0; for (const x of UNI.filter(y => y.ok && y.tl >= 10).slice(0, 200)) { const rr = committee(x), h = highConfidence(x, rr); if (h.ok) { hcN++; if (rr.score < 3 || rr.veto || rr.veto2 || !/Uyumlu|lider/i.test(h.tier || "")) errs.push("yüksek güvenilirlik koşulları ihlal: " + x.name); } else if (!h.why.length) errs.push("gerekçesiz ret " + x.name); }
const hcv = current.find(x => committee(x).veto), hcRet = hcv && highConfidence(hcv, committee(hcv)); if (hcv && (hcRet.ok || !hcRet.why.some(w => /veto/i.test(w)))) errs.push("veto edilen hisse yüksek güvenilirlik sayıldı");
stat.hc = hcN;
// --- Seviye grafiği verisi ---
if (__candles) {
  const cn = Object.keys(__candles.stocks).find(k => UNI.some(u => u.name === k && u.ok)), cs = UNI.find(u => u.name === cn), LD = levelsData(cs, Object.assign({dates: __candles.dates}, __candles.stocks[cn]));
  if (!LD || LD.c.length < 40) errs.push("seviye verisi üretilemedi");
  else {
    const L = LD.c.length; if (LD.o.length !== L || LD.h.length !== L || LD.sma20.length !== L || LD.z.length !== L) errs.push("seviye serileri uzunluğu tutmuyor");
    if (LD.h.some((v, i) => v < LD.l[i] - 1e-9 || v < Math.max(LD.o[i], LD.c[i]) - 1e-6)) errs.push("mum yüksek/düşük tutarsız");
    const zi = L - 1, m = LD.c.slice(zi - 19, zi + 1), mean = m.reduce((a, b) => a + b, 0) / 20, sd = Math.sqrt(m.reduce((a, b) => a + (b - mean) ** 2, 0) / 20); if (Math.abs(LD.zNow - (LD.c[zi] - mean) / sd) > 1e-9) errs.push("z-skor hesabı hatalı");
    if (!LD.liv.some(x => x.kind === "pivot") && cs.h1m > 0) errs.push("pivot seviyesi yok"); if (LD.liv.some(x => x.kind === "stop" && Math.abs(x.y - cs.h1m * 0.97) > 1e-9)) errs.push("yanılma noktası pivotun %3 altı değil");
    if (!(isFinite(LD.trend.y0) && isFinite(LD.trend.y1))) errs.push("trend çizgisi sonsuz");
    stat.levelBars = L;
  }
  if (levelsData(cs, {dates: [], o: [], h: [], l: [], c: []}) !== null || levelsData(cs, null) !== null) errs.push("boş mum verisi null dönmeli");
}
// --- Haber/KAP duygu katmanı ---
const sT = (a, b) => sentiment(a).score > 0 && sentiment(b).score < 0;
if (!(sT("Şirketin zararı azaldı", "Şirketin zararı arttı") && sT("Şirket kâra geçti", "Şirket zarara geçti") && sT("Net kârı arttı", "Net kârı geriledi") && sT("Temettü dağıtımı onaylandı", "Hakkında soruşturma başlatıldı"))) errs.push("duygu: yön değiştiren kalıplar hatalı");
if (!(sentiment("Konkordato ilan etti").score <= -0.8) || !(sentiment("Rekor kâr açıkladı").score > 0.4)) errs.push("duygu: yoğunluk hatalı");
if (sentiment("Bedelsiz sermaye artırımı yok").score >= sentiment("Bedelsiz sermaye artırımı").score) errs.push("duygu: olumsuzlama (yok) çalışmıyor");
if (Math.abs(sentiment("Hisse günü yatay kapattı").score) > 0.2) errs.push("duygu: nötr başlık puanlandı");
const nowS = NOW / 1000; NEWS["SYNS"] = {ok: true, score: 0, items: [{t: "Rekor kâr açıkladı", ts: nowS - 3600}, {t: "Temettü dağıtımı onaylandı", ts: nowS - 7200}, {t: "Konkordato ilan etti", ts: nowS - 86400 * 2.9}, {t: "Soruşturma başlatıldı", ts: nowS - 86400 * 5}]};
const ssn = stockSentiment("SYNS"); if (!ssn || ssn.n !== 3 || ssn.score <= 0.2 || ssn.label !== "pozitif" || ssn.kap < 2) errs.push("hisse duygusu (yeniliğe göre ağırlık/3 gün sınırı) hatalı: " + JSON.stringify(ssn));
NEWS["SYNS"].items.push({t: "Konkordato ilan etti", ts: nowS - 600}, {t: "İflas başvurusu", ts: nowS - 900}, {t: "Hakkında soruşturma", ts: nowS - 1200}); if (stockSentiment("SYNS").score >= ssn.score) errs.push("yeni olumsuz haberler skoru düşürmedi");
delete NEWS["SYNS"]; if (stockSentiment("YOKTUR") !== null) errs.push("haber yokken null dönmeli");
// --- Bilanço denetimi / hakiki PD/DD ---
const bs0 = UNI.find(x => x.ok && x.tl >= 20 && x.eps > 0 && x.bvps > 0 && x.mcap > 0 && !isFin(x) && x.roe > 0 && x.roe < 80);
const mkB = o => Object.assign({}, bs0, {name: "SYNB"}, o), shares0 = bs0.mcap / bs0.close;
const bCash = balanceAudit(mkB({debt: 1e9, cash: 5e9, ebitda: 2e9})), bDebt = balanceAudit(mkB({debt: bs0.bvps * shares0 * 4, cash: 0, ebitda: bs0.bvps * shares0 * 0.5, fcf: -1e9, cr: 0.7}));
const fl = (b, k) => (b.items.find(x => x.key === k) || {}).flag;
if (fl(bCash, "nd") !== "ok" || fl(bCash, "ndEbitda") !== "ok") errs.push("net nakit 'ok' sayılmadı");
if (fl(bDebt, "ndEq") !== "kötü" || fl(bDebt, "ndEbitda") !== "kötü" || fl(bDebt, "conv") !== "kötü" || bDebt.verdict !== "ZAYIF BİLANÇO") errs.push("aşırı borç yakalanmadı: " + bDebt.verdict);
if (balanceAudit(mkB({roe: 150})).items.find(x => x.key === "roe").flag !== "uyarı") errs.push("olağandışı ROE işaretlenmedi");
if (fl(balanceAudit(mkB({pe: bs0.close / bs0.eps * 2})), "pe") !== "uyarı") errs.push("F/K tutarsızlığı işaretlenmedi");
const bFin = balanceAudit(mkB({sector: "Finance"})); if (isFin(mkB({sector: "Finance"})) && !bFin.items.some(x => x.key === "fin")) errs.push("banka/finans için borç ölçütleri geçersiz sayılmadı");
const hk = balanceAudit(bs0), rjB = roePbValue(bs0, intrinsic(bs0)); if (rjB && hk.pb && Math.abs(hk.ratio - hk.pb / rjB.pbJ) > 1e-9) errs.push("hakiki PD/DD formülü hatalı");
if (!/Bilanço denetimi/.test(buffett(bs0).t) || !buffett(bs0).audit) errs.push("Buffett yorumuna bilanço denetimi eklenmedi");
// Buffett oyu denetimden etkilenmemeli (aynı hissede iki hesap aynı)
if (buffett(bs0).v !== buffett(Object.assign({}, bs0)).v) errs.push("Buffett oyu tutarsız");
// --- Takas filtresi (AKD birikim/dağıtım) ---
const hist3 = [0.15, 0.2, 0.12].map((b, i) => ({d: "2026-10-1" + i, bal: b, conc: 0.1, vol: 1000, sak5: 40 + i * 2})), au3 = {d: "2026-10-12", bal: 0.12, conc: 0.1, n: 3, hist: hist3};
let as1 = akdState(au3, {pw: -2}); if (!as1 || as1.state !== "birikim" || !as1.strong || !/sessiz birikim/.test(as1.div || "") || !/artıyor/.test(as1.cust || "")) errs.push("birikim tespiti hatalı: " + JSON.stringify(as1));
as1 = akdState({hist: hist3.map(x => Object.assign({}, x, {bal: -0.2, sak5: 50 - 2}))}, {pw: 3}); if (!as1 || as1.state !== "dağıtım" || !/yükselirken boşaltma/.test(as1.div || "")) errs.push("dağıtım tespiti hatalı: " + JSON.stringify(as1));
as1 = akdState({hist: hist3.slice(0, 2)}, {pw: 0}); if (!as1 || as1.strong || as1.state !== "olası birikim") errs.push("2 günlük veri 'olası' sayılmalı");
if (akdState({hist: hist3.slice(0, 1)}, {}) !== null || akdState(null, {}) !== null) errs.push("yetersiz AKD null dönmeli");
const nz = Object.assign({}, any, {cmf: 0, rvol: 1, change: 0, name: "SYNAKD"}); AKD_USER = {SYNAKD: au3}; AKD_VOTE = false; const v0 = akilliP(nz).v; AKD_VOTE = true; const v1 = akilliP(nz).v;
if (!(v0 === 0 && v1 === 1)) errs.push("takas filtresi oya katılma anahtarı hatalı: " + v0 + "→" + v1);
AKD_USER = {SYNAKD: {hist: hist3.map(x => Object.assign({}, x, {bal: -0.2}))}}; if (akilliP(nz).v !== -1) errs.push("dağıtım oyu (-1) üretmedi"); AKD_VOTE = false; AKD_USER = null;
// --- Monte Carlo (10.000 senaryo) ---
const mcS = UNI.find(x => x.ok && x.tl >= 20 && sigmaOf(x)); mcCache = {}; const m1 = monteCarlo(mcS);
if (m1.n !== 10000 || m1.finals.length !== 10000 || !isFinite(m1.sharpe0) || !(m1.cvar5 <= m1.p05 + 1e-9) || !(m1.p05 <= m1.p50 && m1.p50 <= m1.p95) || !(m1.sd > 0)) errs.push("Monte Carlo istatistikleri hatalı");
mcCache = {}; if (monteCarlo(mcS).probStop !== m1.probStop) errs.push("Monte Carlo deterministik değil");
const mm1 = mcMatrix(mcS); if (!mm1 || mm1.cells.length !== 4 || mm1.cells[0].length !== 3) errs.push("risk/ödül matrisi boyutu hatalı");
else {
  for (const row of mm1.cells) for (const c of row) { if (c.pT + c.pS > 1 + 1e-9 || c.pN < -1e-9 || Math.abs(c.ev - (c.pT * c.T - c.pS * c.S)) > 1e-9) errs.push("matris hücresi tutarsız"); }
  for (let b = 0; b < 3; b++) for (let a = 1; a < 4; a++) if (mm1.cells[a][b].pT > mm1.cells[a - 1][b].pT + 1e-9) errs.push("hedef yükseldikçe isabet olasılığı artmamalı");
  for (let a = 0; a < 4; a++) for (let b = 1; b < 3; b++) if (mm1.cells[a][b].pS > mm1.cells[a][b - 1].pS + 1e-9) errs.push("stop genişledikçe stop olasılığı artmamalı");
}
const sh1 = mcSharpe(mcS, 1), sh2 = mcSharpe(mcS, 3); if (!(sh2.sharpe > sh1.sharpe) || !(sh2.ir > sh1.ir)) errs.push("Sharpe beklentiyle artmıyor"); if (mcSharpe(mcS, null) !== null) errs.push("beklenti yokken Sharpe null olmalı");
const simAny = UNI.filter(x => x.ok && x.tl >= 20).map(x => simons(x)).find(x => x.mcs); if (simAny && !/Sharpe/.test(simAny.plan)) errs.push("Simons planında Monte Carlo Sharpe yok");
if (!/CVaR/.test(committee(mcS).l.seytan.plan)) errs.push("Şeytanın Avukatı planında CVaR yok");
stat.mcN = m1.n;
// --- Rejime duyarlı dinamik ağırlık ---
const regMap = {}, rp = []; for (let i = 0; i < 40; i++) { const dB = "2026-03-" + String(1 + i % 28).padStart(2, "0") + "b" + i, dR = "2026-04-" + String(1 + i % 28).padStart(2, "0") + "r" + i; regMap[dB] = {trend: "bull"}; regMap[dR] = {trend: "bear"};
  rp.push({d: dB, src: "komite", n: "B" + i, e: 10, sc: 1, v: [0, 1, 0, 0, 0], r: {10: i < 30 ? 5 : -5}, b: {10: 0}}); rp.push({d: dR, src: "komite", n: "R" + i, e: 10, sc: 1, v: [0, 1, 0, 0, 0], r: {10: i < 10 ? 5 : -5}, b: {10: 0}}); }
buildMemory(rp, regMap); const regSave = REGIME;
REGIME = {trend: "bull", label: "Boğa", a50: 60}; const wBull = memWeights().simons; REGIME = {trend: "bear", label: "Ayı", a50: 30}; const wBear = memWeights().simons; REGIME = {trend: "mixed", label: "Geçiş", a50: 50}; const wMix = memWeights().simons; REGIME = regSave;
if (!(wBull.src === "rejim" && wBull.w > 1.3 && wBear.src === "rejim" && wBear.w < 0.7 && wMix.src === "genel" && Math.abs(wMix.w - 1) < 1e-9)) errs.push("rejime duyarlı ağırlık hatalı: " + JSON.stringify([wBull, wBear, wMix]));
const br = arenaByRegime(rp, 10, regMap); if (!(br.bull.top && br.bull.top.id === "simons" && br.bear.top === null && br.mixed.top === null)) errs.push("rejime göre en iyi ajan hatalı: " + JSON.stringify([br.bull.top, br.bear.top]));
buildMemory([], {}); if (memWeights().simons.src !== "eşit") errs.push("örneksizken eşit ağırlık beklenir");
// --- Arşivde yeni bölümler ---
const dayN = archiveDay("2026-10-13", __data.ts), mdN = archiveMd(dayN, {});
for (const k of ["Bilanço denetimi", "Risk/ödül matrisi", "Dinamik ağırlıklar", "CVaR", "senaryo)"]) if (mdN.indexOf(k) < 0) errs.push("arşivde eksik: " + k);
// --- KAP / aracı kurum akışı ---
const nS = NOW / 1000; NEWS["SYNK"] = {ok: true, score: 0, items: [
  {t: "Temettü Ödemesi", ts: nS - 3600, p: "kap", src: "KAP", rel: 1}, {t: "Özel Durum Açıklaması (Genel)", ts: nS - 86400, p: "kap", src: "KAP", rel: 1},
  {t: "Sektör raporu - Otomotiv (Deniz Yatırım)", ts: nS - 7200, p: "matriks", src: "Matriks", rel: 2}, {t: "Piyasalarda bugün (İş Yatırım)", ts: nS - 3000, p: "matriks", src: "Matriks", rel: 12},
  {t: "Otomotiv Sektörü (OYAK Yatırım)", ts: nS - 86400 * 3, p: "matriks", src: "Matriks", rel: 1}, {t: "Eski rapor (Gedik Yatırım)", ts: nS - 86400 * 20, p: "matriks", src: "Matriks", rel: 1}, {t: "Petrol fiyatları düştü", ts: nS - 100, p: "reuters", src: "Reuters", rel: 1}]};
const nb = newsBreakdown("SYNK");
if (!nb || nb.kap.length !== 2 || nb.brokers.length !== 3 || nb.kurumlar.length !== 3 || nb.specific.length !== 2 || nb.other.length !== 1) errs.push("KAP/kurum ayrıştırma hatalı: " + JSON.stringify(nb && [nb.kap.length, nb.brokers.length, nb.kurumlar, nb.specific.length, nb.other.length]));
if (nb && nb.brokers.some(b => b.kurum.indexOf("Gedik") >= 0)) errs.push("10 günden eski kurum yazısı sayıldı");
if (nb && !nb.brokers.find(b => b.kurum === "İş Yatırım").specific === false) errs.push("çok sembollü rapor 'doğrudan' sayıldı");
if (stockSentiment("SYNK").kap < 2) errs.push("duygu katmanı KAP sağlayıcısını saymadı");
delete NEWS["SYNK"]; if (newsBreakdown("YOKTUR") !== null) errs.push("haber yokken null dönmeli");
// --- Kaliteli ama düşüşte ---
const qdAll = qualityDipList(UNI), qdLoose = qualityDipList(UNI, {minQual: 0});
stat.qd = qdAll.length + "/" + qdLoose.length;
if (qdLoose.length < qdAll.length) errs.push("kalite eşiği düşürülünce liste küçüldü");
for (const x of qdAll) { const s = x.s;
  if (!(s.smaDist < 0) || !(x.qual >= 55) || x.audit === "ZAYIF BİLANÇO" || !(s.eps > 0) || !(avgTl(s) >= 20) || s.p1m <= -60 || s.dist52 <= -70 || !((s.p1m <= -8) || (s.dist52 <= -25))) errs.push("kaliteli-düşüşte koşulu ihlal: " + s.name); }
for (let i = 1; i < qdAll.length; i++) if (qdAll[i].rank > qdAll[i - 1].rank + 1e-9) errs.push("kaliteli-düşüşte sıralaması bozuk");
const qSrc = UNI.find(x => x.ok && avgTl(x) >= 20 && x.eps > 0 && buffett(x).checks[0].s === OK && buffett(x).quality >= 55 && buffett(x).audit.verdict !== "ZAYIF BİLANÇO" && x.p1m > -60 && x.dist52 > -70);
if (qSrc) {
  const sv = {p: qSrc.p1m, sm: qSrc.smaDist, d: qSrc.dist52, c: qSrc.close, sma: qSrc.sma50};
  qSrc.sma50 = qSrc.close * 1.1; qSrc.smaDist = -9.1; qSrc.p1m = -15; if (!qualityDip(qSrc)) errs.push("kaliteli düşüştekini yakalamadı");
  qSrc.p1m = -2; qSrc.dist52 = -5; if (qualityDip(qSrc)) errs.push("düşüşte olmayanı listeledi");
  qSrc.p1m = -75; qSrc.dist52 = -80; if (qualityDip(qSrc)) errs.push("bedelsiz/bölünme kaynaklı sahte düşüşü elemedi");
  qSrc.p1m = -15; qSrc.dist52 = -30; qSrc.smaDist = 3; if (qualityDip(qSrc)) errs.push("SMA50 üstündekini listeledi");
  qSrc.p1m = sv.p; qSrc.smaDist = sv.sm; qSrc.dist52 = sv.d; qSrc.sma50 = sv.sma;
}
// --- Yorumcu notları karnesi ---
const OH = {dates: [], stocks: {AAA: {c: []}, BBB: {c: []}}, index: []}; for (let i = 0; i < 60; i++) { OH.dates.push("2026-01-" + String(1 + i).padStart(2, "0")); OH.index.push(100 + i * 0.1); OH.stocks.AAA.c.push(100 + i * 1.0); OH.stocks.BBB.c.push(100 - i * 0.5); }
OH.dates = Array.from({length: 60}, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
const ce = (n, dir, date) => ({id: n + dir + date, who: "Ali", n, dir, date, src: "X"});
const e1 = commentEval(ce("AAA", "al", "2026-01-05"), OH, 5), e2 = commentEval(ce("AAA", "sat", "2026-01-05"), OH, 5), e3 = commentEval(ce("BBB", "sat", "2026-01-05"), OH, 5);
if (!(e1.hit === true && e1.signed > 0 && e2.hit === false && e2.signed < 0 && e3.hit === true)) errs.push("yorum değerlendirme yönü hatalı: " + JSON.stringify([e1, e2, e3]));
if (commentEval(ce("AAA", "al", "2026-02-25"), OH, 20).pending !== true) errs.push("ufku dolmamış yorum bekleyen olmalı");
if (commentEval(ce("AAA", "izle", "2026-01-05"), OH, 5) !== null || commentEval(ce("ZZZ", "al", "2026-01-05"), OH, 5) !== null) errs.push("izle/yok hisse null dönmeli");
if (commentEval(ce("AAA", "al", "2025-12-01"), OH, 5) !== null) errs.push("veri öncesi tarih null dönmeli");
const ents = []; for (let i = 0; i < 40; i++) ents.push({id: "a" + i, who: "Doğru", n: "AAA", dir: "al", date: "2026-01-" + String(2 + (i % 20)).padStart(2, "0"), src: "X"}); for (let i = 0; i < 40; i++) ents.push({id: "b" + i, who: "Yanlış", n: "AAA", dir: "sat", date: "2026-01-" + String(2 + (i % 20)).padStart(2, "0"), src: "TradingView fikri"}); ents.push({id: "c1", who: "Az", n: "AAA", dir: "al", date: "2026-01-03", src: "X"});
const cs = commentStats(ents, OH, 5), rw = w => cs.rows.find(x => x.who === w);
if (!(rw("Doğru").rate === 1 && rw("Doğru").status === "anlamlı üstünlük" && rw("Yanlış").rate === 0 && rw("Yanlış").status === "anlamlı olarak kötü" && rw("Az").status === "yetersiz örnek" && cs.rows[0].who === "Doğru")) errs.push("yorumcu karnesi hatalı: " + JSON.stringify(cs.rows.map(r => [r.who, r.n, r.rate, r.status])));
const cc = commentConsensus(ents, "AAA"); if (!(cc.n === 81 && cc.al === 41 && cc.sat === 40) || commentConsensus(ents, "YOK") !== null) errs.push("yorumcu mutabakatı hatalı");
// --- Kara kuğu stres testi ---
if (STRESS) {
  const stk = Object.keys(STRESS.stocks).find(k => UNI.some(u => u.name === k && u.ok)), stS = UNI.find(u => u.name === stk), sx = stressOf(stS), bb = STRESS.stocks[stk], mm = STRESS.meta;
  const expBist = bb.bmd * -5, expKur = bb.bm2 * Math.min(0, mm.km * 10) + bb.bf * 10, expFaiz = bb.bm2 * Math.min(0, mm.ky * 3) + bb.by * 3, expSwan = bb.bmd * -10 + bb.bf * 8 + bb.by * 4;
  if (!sx || Math.abs(sx.loss.bist5 - expBist) > 1e-9 || Math.abs(sx.loss.kur10 - expKur) > 1e-9 || Math.abs(sx.loss.faiz3 - expFaiz) > 1e-9 || Math.abs(sx.loss.swan - expSwan) > 1e-9) errs.push("stres kayıp formülü hatalı");
  const synS = Object.assign({}, any, {name: "SYNSTRESS"}), setB = o => { STRESS.stocks.SYNSTRESS = Object.assign({bm: 1, bm2: 1, bmd: 1, bf: 0, by: 0, r2: 0.5, n: 800}, o); };
  setB({}); if (!stressOf(synS).ok) errs.push("zararsız hisse stres testini geçemedi");
  setB({bmd: 2.5}); let sf = stressOf(synS); if (sf.ok || !sf.fail.includes("bist5") || !sf.fail.includes("swan")) errs.push("yüksek düşüş betası yakalanmadı");
  setB({bf: -2}); sf = stressOf(synS); if (sf.ok || !sf.fail.includes("kur10")) errs.push("kur duyarlılığı yakalanmadı: " + JSON.stringify(sf.loss));
  setB({by: -4}); sf = stressOf(synS); if (sf.ok || !sf.fail.includes("faiz3")) errs.push("faiz duyarlılığı yakalanmadı");
  setB({bmd: 2.5}); mcCache = {}; R.stressVeto = 1; let dv1 = devil(synS, null); if (!dv1.veto || !dv1.severe.some(x => /kara kuğu/.test(x)) || !/GEÇEMEDİ/.test(dv1.plan)) errs.push("Şeytanın Avukatı stres testini geçemeyen hisseyi reddetmedi");
  R.stressVeto = 0; mcCache = {}; const dv0 = devil(synS, null); if (dv0.severe.some(x => /kara kuğu/.test(x))) errs.push("stressVeto=0 iken red verdi"); R.stressVeto = 1;
  if (stressOf(Object.assign({}, any, {name: "YOKTUR"})) !== null) errs.push("verisi olmayan hisse için null beklenir");
  delete STRESS.stocks.SYNSTRESS; mcCache = {};
  const failN = UNI.filter(u => u.ok && stressOf(u) && !stressOf(u).ok).length, haveN = UNI.filter(u => u.ok && stressOf(u)).length; stat.stress = failN + "/" + haveN;
  if (haveN > 20 && failN > haveN * 0.3) errs.push("stres testi çok fazla hisseyi reddediyor: " + failN + "/" + haveN);
  if (!(mm.calibration && Math.abs(mm.calibration.pred - mm.calibration.real) < 1.5)) errs.push("stres modeli çöküş günlerinde kalibre değil: " + JSON.stringify(mm.calibration));
}
// --- Kelly ve izleyen stop ---
const fp0 = mcFirstPassage(mcS, 12, 6, 0), fp1 = mcFirstPassage(mcS, 12, 6, 0.01);
if (!fp0 || Math.abs(fp0.pT / (fp0.pT + fp0.pS) - 1 / 3) > 0.07) errs.push("kenarsız ilk-geçiş olasılığı 1/3'e yakın değil: " + fp0.pT / (fp0.pT + fp0.pS));
if (!(fp1.pT / (fp1.pT + fp1.pS) > 0.6)) errs.push("pozitif sürüklenmede hedef olasılığı artmadı"); if (Math.abs(fp1.pT + fp1.pS + fp1.pN - 1) > 1e-9) errs.push("ilk-geçiş olasılıkları 1 etmiyor");
const tsA = {entry: 100, stop0: 94, peak: 105, atr: 2, k: 2.5, S: 6}, tsB = Object.assign({}, tsA, {peak: 106}), tsC = Object.assign({}, tsA, {peak: 120}), tsD = Object.assign({}, tsA, {peak: 130});
if (trailingStop(tsA) !== 94 || trailingStop(tsB) !== 101 || trailingStop(tsC) !== 115 || !(trailingStop(tsD) > trailingStop(tsC))) errs.push("izleyen stop hesabı hatalı: " + [trailingStop(tsA), trailingStop(tsB), trailingStop(tsC)]);
if (trailingStop(Object.assign({}, tsA, {peak: 107, atr: 10})) !== 100) errs.push("izleyen stop girişin altına düşmemeli (başa baş koruması)");
let nEdge = 0, nNo = 0; for (const x of UNI.filter(y => y.ok && y.tl >= 20 && y.atr).slice(0, 150)) { const kp = kellyPlan(x, 100000); if (!kp) continue;
  if (!(kp.S >= 3 && kp.S <= 15) || Math.abs(kp.T - 2 * kp.S) > 1e-9 || kp.f < 0 || kp.f > 0.2 + 1e-9 || kp.f > kp.fRisk + 1e-9 || kp.f > Math.max(0, kp.half) + 1e-9) errs.push("Kelly sınırları ihlal: " + x.name);
  if (kp.kelly <= 0 && (kp.f !== 0 || kp.edge)) errs.push("kenar yokken pozisyon önerildi: " + x.name); if (kp.edge) { nEdge++; if (!(kp.amount > 0) || kp.ladder.some((l, i) => l.stop < kp.stop0 - 1e-9 || (i && l.stop < kp.ladder[i - 1].stop - 1e-9)) || kp.ladder[0].stop < x.close - 1e-9) errs.push("izleyen stop merdiveni hatalı: " + x.name); } else nNo++;
  if (Math.abs(kp.pT + kp.pS + kp.pN - 1) > 1e-9) errs.push("Kelly olasılıkları tutarsız"); }
stat.kelly = nEdge + "/" + (nEdge + nNo); if (nEdge + nNo < 20) errs.push("Kelly planı çok az hissede üretildi");
// --- Tahta derinliği ---
const dpBase = (extra) => ({t: "10:30", bids: [{p: 100, q: 1000, o: 20}, {p: 99.9, q: 1200, o: 25}, {p: 99.8, q: 900, o: 18}, {p: 99.7, q: 1100, o: 22}, {p: 99.6, q: 1000, o: 20}].concat(extra && extra.bids || []), asks: [{p: 100.1, q: 900, o: 18}, {p: 100.2, q: 1100, o: 22}, {p: 100.3, q: 1000, o: 20}, {p: 100.4, q: 950, o: 19}, {p: 100.5, q: 1050, o: 21}].concat(extra && extra.asks || [])});
const dA = depthAnalyze(dpBase(), {avgVol: 500000, close: 100}); if (!dA || dA.verdict !== "dengeli" || dA.walls.length || dA.spreadTicks !== 1) errs.push("sağlıklı tahta 'dengeli' çıkmadı: " + JSON.stringify(dA && [dA.verdict, dA.walls.length, dA.spreadTicks]));
const farWall = dpBase(); farWall.bids[4] = {p: 99.6, q: 60000, o: 1}; const dB = depthAnalyze(farWall, {avgVol: 500000, close: 100}); if (!dB || dB.verdict !== "ŞÜPHELİ DERİNLİK" || !dB.walls.some(w => w.side === "alış" && w.dist === 4)) errs.push("uzak büyük/tek emir yakalanmadı: " + JSON.stringify(dB && [dB.verdict, dB.walls]));
const gone = dpBase(); gone.t = "10:45"; const dC = depthAnalyze(gone, {avgVol: 500000, close: 100, prev: farWall}); if (!dC || !dC.spoof || dC.verdict !== "SPOOFING RİSKİ" || !dC.flags.some(f => /kayboldu/.test(f))) errs.push("kaybolan duvar (spoofing) yakalanmadı: " + JSON.stringify(dC && [dC.verdict, dC.flags]));
const hit = dpBase(); hit.t = "10:45"; hit.bids = hit.bids.filter(b => b.p < 99.6).map(b => b); hit.bids.unshift({p: 99.5, q: 800, o: 15}); hit.bids = [{p: 99.5, q: 800, o: 15}, {p: 99.4, q: 900, o: 10}, {p: 99.3, q: 900, o: 10}, {p: 99.2, q: 900, o: 10}]; hit.asks = hit.asks.map(a => ({p: a.p - 0.6, q: a.q, o: a.o}));
const dD = depthAnalyze(hit, {avgVol: 500000, close: 99.6, prev: farWall}); if (dD && dD.spoof) errs.push("fiyat duvara gelip işlem yapılmışsa spoofing denmemeli");
const heavyBid = dpBase(); heavyBid.bids = heavyBid.bids.map(b => ({p: b.p, q: b.q * 10, o: b.o})); const dE = depthAnalyze(heavyBid, {avgVol: 5e6, close: 100}); if (!(dE.imb > 0.3) || dE.verdict !== "alıcı ağırlıklı") errs.push("alıcı ağırlığı hatalı: " + dE.verdict);
const askWallS = dpBase(); askWallS.asks[1] = {p: 100.2, q: 40000, o: 12}; const dF = depthAnalyze(askWallS, {avgVol: 5e6, close: 100}); if (!dF.askWall || !dF.block.some(b => /satış duvarı/.test(b))) errs.push("fiyatın üstündeki satış duvarı bulunamadı");
if (depthAnalyze({bids: [], asks: [{p: 1, q: 1}]}, {}) !== null) errs.push("tek taraflı tahta null dönmeli");
const dgS = any.name; DEPTH_USER = {[dgS]: dF}; DEPTH_GATE = false; if (depthGate(any) !== null) errs.push("kapı kapalıyken null beklenir"); DEPTH_GATE = true; const dg1 = depthGate(any); if (!dg1 || !dg1.block) errs.push("kapı açıkken engel üretilmedi");
let gated = 0; for (const x of UNI.filter(y => y.ok && y.tl >= 10)) { DEPTH_GATE = false; const l0 = livermore(x).v, k0 = kellogg(x).v; if (l0 > 0 || k0 > 0) { DEPTH_USER = {[x.name]: dF}; DEPTH_GATE = true; if ((l0 > 0 && livermore(x).v !== 0) || (k0 > 0 && kellogg(x).v !== 0)) errs.push("derinlik kapısı kırılım oyunu kapatmadı: " + x.name); else gated++; if (gated >= 3) break; } }
stat.depthGated = gated; DEPTH_USER = null; DEPTH_GATE = false;
// --- Sanal işlem performansına bağlı ağırlık ---
const mkNav = (g, n) => Array.from({length: n}, (_, i) => ({d: "2026-02-" + String(1 + i).padStart(2, "0"), v: 100000 * Math.pow(1 + g, i)})), mkBench = n => Array.from({length: n}, (_, i) => ({d: "2026-02-" + String(1 + i).padStart(2, "0"), ew: 100}));
const stP = {p: {buffett: {nav: mkNav(0.005, 25)}, simons: {nav: mkNav(-0.005, 25)}, livermore: {nav: mkNav(0.005, 10)}, kellogg: {nav: mkNav(0.0005, 25)}}, bench: mkBench(25)}, pw = paperWeights(stP);
if (!(pw.buffett.w === 1.3 && pw.simons.w === 0.7 && pw.livermore.w === 1 && /yetersiz/.test(pw.livermore.status) && pw.kellogg.w > 1 && pw.kellogg.w < 1.3 && pw.akilli.w === 1)) errs.push("sanal işlem ağırlığı hatalı: " + JSON.stringify([pw.buffett.w, pw.simons.w, pw.livermore.w, pw.kellogg.w]));
if (!/azaltıldı/.test(pw.simons.status) || !/artırıldı/.test(pw.buffett.status)) errs.push("sanal işlem durum metni hatalı");
buildMemory([], {}); setPaper(stP); const mw = memWeights(); if (!(mw.buffett.w === 1.3 && mw.simons.w === 0.7 && mw.livermore.w === 1 && mw.buffett.paper)) errs.push("memWeights sanal işlem çarpanını uygulamadı: " + JSON.stringify([mw.buffett.w, mw.simons.w]));
const dbB = debate(any, committee(any)), alB = dbB.al; setPaper(null); if (paperWeights(null) && Object.keys(paperWeights(null)).length) errs.push("boş durumda ağırlık üretildi"); if (memWeights().buffett.w !== 1) errs.push("setPaper(null) sonrası eşit ağırlık beklenir");
({stat, tiers: cnt, medianUpside: md, errs: errs.slice(0, 20), nerr: errs.length})
`, ctx);
console.log(JSON.stringify(out));
process.exit(out.nerr ? 1 : 0);
