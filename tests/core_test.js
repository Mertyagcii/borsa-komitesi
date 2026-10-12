// Çekirdek mantık testi (Node): tüm hisselerde komite, masa toplantısı, değerleme, ucuz/pahalı, çok zamanlı skor hatasız ve makul aralıkta olmalı.
// Kullanım: node tests/core_test.js <site-klasörü>
const fs = require("fs"), vm = require("vm"), path = require("path");
const site = process.argv[2] || "site", rd = f => JSON.parse(fs.readFileSync(path.join(site, f), "utf8"));
const data = rd("data.json"), hist = rd("history.json"), news = rd("news.json").news || {}, research = rd("research.json"), mtfr = rd("mtf_composite.json");
const ctx = vm.createContext({console, Intl, Math, Date, __data: data, __hist: hist, __news: news, __research: research, __mtfr: mtfr, __NOW: Date.now()});
const out = vm.runInContext(`
${fs.readFileSync(path.join(__dirname, "..", "core.js"), "utf8")}
let R = Object.assign({}, DEFAULTS); let HIST = __hist; let NEWS = __news; let current = [];
RESEARCH = __research; MTFR = __mtfr; NOW = __NOW;
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
for (const id of ["haftalik", "gunluk", "aylik", "bebek"]) {
  const P = scanDefaults(id), r = runScan(id, P, {trace: false});
  for (let i = 1; i < r.steps.length; i++) if (r.steps[i].n_out > r.steps[i].n_in || r.steps[i].n_in !== r.steps[i - 1].n_out) errs.push("tarama huni tutarsız: " + id + " adım " + i);
  if (r.list.length !== r.steps[r.steps.length - 1].n_out) errs.push("tarama listesi son adımla uyuşmuyor: " + id);
  const nm = scanNearMiss(id, P, 10); if (nm.some(o => r.list.includes(o.s))) errs.push("yaklaşanlar listede olmamalı: " + id);
  if (id === "haftalik" && !r.list.every(s => s.mtf.w >= P.wMin && Math.abs(s.change) < 9.5 && s.tl >= P.minTl)) errs.push("haftalık tarama eşiği ihlal");
  if (id === "bebek" && !r.list.every(s => { const a = ageDaysOf(s); return a >= P.minAge && a <= P.maxAge; })) errs.push("bebek yaş eşiği ihlal");
  if (r.list[0]) { const tr = scanTrace(id, P, r.list[0]); if (!tr.pass && P.veto !== 1) errs.push("iz ile liste çelişiyor: " + id); }
  stat["scan_" + id] = r.list.length;
}
const dh = dataHealth(5); if (!(dh.score >= 0 && dh.score <= 100)) errs.push("veri sağlığı aralık dışı");
if (!(tierId(80, 90, 70) === "uyumlu" && tierId(10, 85, 10) === "hlider" && tierId(50, 20, 50) === "zayif" && tierId(50, 50, 50) === "notr" && tierId(null, null, null) === null)) errs.push("tierId tanımı bozuk");
({stat, tiers: cnt, medianUpside: md, errs: errs.slice(0, 20), nerr: errs.length})
`, ctx);
console.log(JSON.stringify(out));
process.exit(out.nerr ? 1 : 0);
