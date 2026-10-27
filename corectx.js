/* Ortak yükleyici: core.js'i tarayıcıdaki gibi (vm içinde) ve tarayıcıyla aynı yardımcı verilerle çalıştırır.
   alarms.js (seans içi alarm motoru) ve archive.js (seans sonu arşiv) kullanır. */
const fs = require("fs"), vm = require("vm"), path = require("path");

function istanbul() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false}).formatToParts(new Date()).map(x => [x.type, x.value]));
  return {date: `${p.year}-${p.month}-${p.day}`, wd: p.weekday, min: (+p.hour % 24) * 60 + +p.minute, hm: `${p.hour}:${p.minute}`};
}

function load(site) {
  const rd = (f, d) => { for (const p of [path.join(site, f), f]) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { /* sıradaki konum */ } } return d; };
  const aux = {data: rd("data.json", null), hist: rd("history.json", null), news: (rd("news.json", {news: {}}) || {}).news || {}, research: rd("research.json", null),
    mtfr: rd("mtf_composite.json", null), k2: rd("kurul2_research.json", null), mr: rd("macro_research.json", null), viop: rd("viop.json", null),
    picks: ((rd("picks.json", {picks: []}) || {}).picks) || [], regime: ((rd("picks.json", {}) || {}).regime) || {}, viopr: rd("viop_research.json", null), stress: rd("stress.json", null), port: rd("portfolios.json", null), nm: rd("newsmood.json", null), geo: rd("geo.json", null), sealcard: rd("seal_card.json", null)};
  if (!aux.data || !aux.data.stocks || !aux.data.stocks.length) return null;
  const ctx = vm.createContext({console, Intl, Math, Date, __a: aux, __NOW: Date.now()});
  const core = fs.readFileSync(path.join(__dirname, "core.js"), "utf8");
  vm.runInContext(core + `
let R = Object.assign({}, DEFAULTS); let HIST = __a.hist; let NEWS = __a.news; let current = [];
RESEARCH = __a.research; MTFR = __a.mtfr; KUR2 = __a.k2; MACRO_R = __a.mr; VIOP = __a.viop; VIOP_R = __a.viopr; NMOOD = __a.nm; GEO = __a.geo; STRESS = __a.stress; SEALCARD = __a.sealcard; NOW = __NOW;
const UNI = __a.data.stocks.map(enrich); rankUniverse(UNI); computeSectorStats(UNI); REGIME = computeRegime(UNI, HIST); UNIVERSE = UNI;
current = strengthList(UNI, 25, 5); buildMemory(__a.picks, __a.regime); setPaper(__a.port);`, ctx);
  return {aux, run: code => vm.runInContext(code, ctx), read: rd};
}

module.exports = {load, istanbul};
