#!/usr/bin/env node
/* guards.js testleri (sentetik senaryolar; engine.js ile aynı bağlam). Kullanım: node tests/guards_test.js [site] */
const fs = require("fs"), vm = require("vm"), path = require("path");
const ROOT = path.join(__dirname, ".."), SITE = process.argv[2] || path.join(ROOT, "site");
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
const data = read(path.join(SITE, "data.json"), null), hist = read(path.join(SITE, "history.json"), null);
const news = (read(path.join(SITE, "news.json"), {news: {}}) || {}).news || {};
if (!data || !hist) { console.log("HATA site verisi yok"); process.exit(2); }
const ctx = vm.createContext({console, Intl, Math, Date, JSON, __data: data, __hist: hist, __news: news, __research: read(path.join(ROOT, "research.json"), null), __mtfr: read(path.join(ROOT, "mtf_composite.json"), null),
  __k2: read(path.join(ROOT, "kurul2_research.json"), null), __mr: read(path.join(ROOT, "macro_research.json"), null), __stress: read(path.join(ROOT, "stress.json"), null)});
const src = ["core.js", "engine_core.js", "guards.js"].map(f => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
vm.runInContext(`${src}
let R = Object.assign({}, DEFAULTS); let HIST = __hist; let NEWS = __news; let current = [];
RESEARCH = __research; MTFR = __mtfr; KUR2 = __k2; MACRO_R = __mr; STRESS = __stress; NOW = Date.now(); INTRA = null;
const __stocks = __data.stocks.map(enrich), __by = Object.fromEntries(__stocks.map(s => [s.name, s])); window_by = __by;
rankUniverse(__stocks); computeSectorStats(__stocks); REGIME = computeRegime(__stocks, HIST); current = strengthList(__stocks, 25, 5);`, ctx);
const run = code => vm.runInContext(code, ctx);
let fails = 0;
const ok = (name, cond, extra) => { if (!cond) fails++; console.log((cond ? "  ok   " : "  HATA ") + name + (cond ? "" : "  → " + (extra || ""))); };

const T0 = "2026-11-04";
const fresh = () => run(`(() => { const st = initState("2026-10-01", 0.3); st.bench = [{d: "2026-11-03", xu: 1, ew: 100}]; bindAI(st, "${T0}"); globalThis.__st = st; return 1; })()`);
run("globalThis.__st = null;");

// ---- 1) Makro Kalkan ----
const setMacro = (o, risk) => run(`HIST.macro = Object.assign({}, __hist.macro, ${JSON.stringify(o)}); MACRO_R = Object.assign({}, __mr, {risk: ${JSON.stringify(risk || null)}}); bindAI(initState("2026-10-01", 0.3), "${T0}"); macroGuard()`);
const hot = {date: T0, vix: 35, usdtry_d5: 5, brent_d20: 20, dxy_d20: 3, gold_d20: 8, us10y_d20: 0.5, rf10_d20: 2};
const calm = {date: T0, vix: 15, usdtry_d5: 0, brent_d20: 0, dxy_d20: 0, gold_d20: 0, us10y_d20: 0, rf10_d20: 0};
let g = setMacro(hot, {"2+": {vol20: 22}, "0-1": {vol20: 24}, vol_fark: -1.7, vol_t: -0.66});
ok("makro: çok bayrak = Savunma seviyesi", g.level === 3 && g.name === "Savunma", JSON.stringify(g));
ok("makro: kanıt yokken (oynaklık artmıyor) izleme modu, alımı değiştirmez", g.mode === "izleme" && g.active === false && g.mult === 1, JSON.stringify(g));
g = setMacro(hot, {"2+": {vol20: 30}, "0-1": {vol20: 20}, vol_fark: 10, vol_t: 2.5});
ok("makro: kanıt varsa (t≥1,64) kalkan etkin, Savunmada alım ertelenir", g.mode === "etkin" && g.active && g.mult === 0, JSON.stringify(g));
g = setMacro(Object.assign({}, hot, {vix: 26, usdtry_d5: 0, brent_d20: 0, dxy_d20: 0, gold_d20: 0, us10y_d20: 0, rf10_d20: 0}),{"2+": {vol20: 30}, "0-1": {vol20: 20}, vol_fark: 10, vol_t: 2.5});
ok("makro: tek bayrak seviye 0 (sakin)", g.level === 0 && g.mult === 1, JSON.stringify(g));
g = setMacro(calm, null); ok("makro: sakin piyasa seviye 0", g.level === 0, JSON.stringify(g));
g = setMacro(Object.assign({}, hot, {date: "2026-10-01"}), {"2+": {vol20: 30}, "0-1": {vol20: 20}, vol_fark: 10, vol_t: 2.5});
ok("makro: bayat makro verisi (>5 gün) eylem üretmez", g.fresh === false && g.level === 0 && g.mode === "veri yok", JSON.stringify(g));
g = setMacro({date: T0, vix: 33}, {"2+": {vol20: 30}, "0-1": {vol20: 20}, vol_fark: 10, vol_t: 2.5});
ok("makro: VIX>30 tek başına en az Temkinli", g.level >= 2, JSON.stringify(g));
g = run(`GUARD.macroForce = true; HIST.macro = Object.assign({}, __hist.macro, ${JSON.stringify(hot)}); MACRO_R = Object.assign({}, __mr, {risk: {vol_t: -1, vol_fark: -1}}); bindAI(initState("2026-10-01", 0.3), "${T0}"); const x = macroGuard(); GUARD.macroForce = false; x`);
ok("makro: macroForce ile kanıtsız da etkin olur", g.active === true && g.mode === "etkin", JSON.stringify(g));

// ---- 2) Şüpheci Denetçi ----
run("HIST.macro = __hist.macro; MACRO_R = __mr;");
const clean = {name: "TESTX", sector: "Test", change: 1, rsi: 55, smaDist: 5, atrPct: 3, p1m: 5, rvol: 1.5, beta: 1, close: 10};
const rr = (v, veto) => ({score: 2, veto: !!veto, l: {buffett: {v: v[0]}, simons: {v: v[1]}, livermore: {v: v[2]}, kellogg: {v: v[3]}, seytan: {severe: veto ? ["test"] : []}}});
const sk = (s, r, x, regime) => { fresh(); return run(`(() => { const rg = REGIME; REGIME = ${JSON.stringify(regime === undefined ? null : regime)}; try { return skeptic(${JSON.stringify(s)}, ${JSON.stringify(r)}, ${JSON.stringify(Object.assign({mg: {level: 0}}, x || {}))}); } finally { REGIME = rg; } })()`); };
let k = sk(clean, rr([1, 0, 1, 0]));
ok("şüpheci: temiz aday onaylanır", k.ok && k.hard.length === 0 && k.soft.length === 0, JSON.stringify(k));
k = sk(Object.assign({}, clean, {change: 9}), rr([1, 0, 1, 0]));
ok("şüpheci: %9 yükselmiş (kovalama) = sert ret", !k.ok && k.hard.some(t => /Kovalama/.test(t)), JSON.stringify(k));
k = sk(Object.assign({}, clean, {rsi: 85}), rr([1, 0, 1, 0]));
ok("şüpheci: RSI 85 = sert ret", !k.ok && k.hard.some(t => /aşırı alım/.test(t)), JSON.stringify(k));
k = sk(clean, rr([1, 0, 1, 0], true));
ok("şüpheci: Şeytanın Avukatı vetosu = sert ret", !k.ok && k.hard.some(t => /veto/i.test(t)), JSON.stringify(k));
k = sk(Object.assign({}, clean, {rsi: 75}), rr([1, 0, 1, 0]));
ok("şüpheci: tek hafif çekince onayı engellemez", k.ok && k.soft.length === 1, JSON.stringify(k));
k = sk(Object.assign({}, clean, {rsi: 75, atrPct: 7}), rr([1, 0, 1, 0]));
ok("şüpheci: iki hafif çekince = ret", !k.ok && k.soft.length >= 2, JSON.stringify(k));
k = sk(Object.assign({}, clean, {rsi: 75}), rr([1, 1, 1, 1]));
ok("şüpheci: oy birliği + sıcak RSI = ret (onay yanlılığı kırılır)", !k.ok && k.soft.some(t => /Oy birliği/.test(t)), JSON.stringify(k));
k = sk(clean, rr([1, 1, 1, 1]));
ok("şüpheci: yalnız oy birliği (başka kusur yok) onayı engellemez, çekince olarak yazılır", k.ok && k.soft.length === 1, JSON.stringify(k));
k = sk(Object.assign({}, clean, {sector: "S"}), rr([1, 0, 1, 0]), {p: {pos: [{sector: "S"}, {sector: "S"}]}, mg: {level: 0}});
ok("şüpheci: portföyde aynı sektörden 2 pozisyon = hafif çekince", k.soft.some(t => /aynı sektör/.test(t)), JSON.stringify(k));

k = sk(clean, rr([1, 0, 1, 0]), {}, {trend: "bear"});
ok("şüpheci: ayı rejimi hafif çekince olarak sayılır (tek başına engellemez)", k.ok && k.soft.some(t => /ayı/.test(t)), JSON.stringify(k));
k = sk(Object.assign({}, clean, {rsi: 75}), rr([1, 0, 1, 0]), {}, {trend: "bear"});
ok("şüpheci: ayı rejimi + başka çekince = ret", !k.ok, JSON.stringify(k));
ok("duygu: 'zarar açıkladı, hisse sert düştü' artık olumlu sayılmaz (virgül kalıbı kesiyor)", run(`sentiment("T3 net zarar açıkladı, hisse sert düştü").score`) < -0.3, String(run(`sentiment("T3 net zarar açıkladı, hisse sert düştü").score`)));
ok("duygu: 'zararı azaldı' hâlâ olumlu (yön değiştiren kalıp bozulmadı)", run(`sentiment("Şirketin zararı azaldı").score`) > 0.3, String(run(`sentiment("Şirketin zararı azaldı").score`)));
ok("duygu: 'kârı düştü' hâlâ olumsuz", run(`sentiment("Şirketin kârı düştü").score`) < -0.3, String(run(`sentiment("Şirketin kârı düştü").score`)));

// ---- 3) Kapı (gateBuy): gerçek hisse üzerinde ----
const S0 = run("current[0].name");
const gate = (mut, macro, stubOk) => {
  fresh();
  return run(`(() => {
    const s = window_by["${S0}"], o0 = {change: s.change, rsi: s.rsi}; Object.assign(s, ${JSON.stringify(mut || {})});
    HIST.macro = Object.assign({}, __hist.macro, ${JSON.stringify(macro ? macro.m : {})}); MACRO_R = Object.assign({}, __mr, {risk: ${JSON.stringify(macro ? macro.r : null)}}); GMG = null;
    const keep = skeptic; ${stubOk ? 'skeptic = () => ({ok: true, hard: [], soft: [], text: "stub"});' : ""}
    const p = {key: "t", cash: 1e6, pos: [], orders: [], trades: [], log: []}, o = {n: "${S0}", amount: 100000, reason: "test"};
    queueBuy(p, o); skeptic = keep; Object.assign(s, o0);
    return {orders: p.orders, log: p.log.map(x => x.text), dec: __st_ai().dec};
  })()`);
};
run("function __st_ai() { return AIX; }");
let r = gate({change: 9}, null, false);
ok("kapı: kovalama yapılan hisse için emir yazılmaz, gerekçe günlüğe girer", r.orders.length === 0 && r.log.some(t => /Şüpheci Denetçi onay vermedi/.test(t)), JSON.stringify(r).slice(0, 400));
ok("kapı: ret kaydı ölçüm listesine (dec) girer", r.dec.length === 1 && r.dec[0].res === "ret" && r.dec[0].kind === "supheci" && r.dec[0].px > 0, JSON.stringify(r.dec));
const hotM = {m: hot, r: {"2+": {vol20: 30}, "0-1": {vol20: 20}, vol_fark: 10, vol_t: 2.5}};
r = gate({}, hotM, true);
ok("kapı: Savunma + kanıt varsa alım ertelenir", r.orders.length === 0 && r.dec.some(e => e.res === "ertele" && e.kind === "makro"), JSON.stringify(r).slice(0, 400));
const warmM = {m: Object.assign({}, calm, {vix: 31}), r: hotM.r};
r = gate({}, warmM, true);
ok("kapı: Temkinli + kanıt varsa tutar yarıya iner", r.orders.length === 1 && Math.abs(r.orders[0].amount - 50000) < 1 && r.dec.some(e => e.res === "küçült"), JSON.stringify(r).slice(0, 400));
r = gate({}, {m: hot, r: {"2+": {vol20: 22}, "0-1": {vol20: 24}, vol_fark: -1.7, vol_t: -0.66}}, true);
ok("kapı: kanıt yokken (izleme) alım aynen yazılır, ama gölge karar ölçülür", r.orders.length === 1 && r.orders[0].amount === 100000 && r.dec.some(e => e.res === "onay" && e.shadow === "ertelenirdi"), JSON.stringify(r).slice(0, 400));
ok("kapı: onaylanan emir bağlam (ctx) taşır (Hata Hafızası için)", r.orders[0].ctx && r.orders[0].ctx.sector !== undefined && r.orders[0].ctx.votes, JSON.stringify(r.orders[0]));

// ---- 4) Hata Hafızası ----
fresh();
let m = run(`(() => {
  const p = {key: "t", cash: 0, pos: [], orders: [], trades: [], log: []}, pos = {n: "AAA", sh: 100, avg: 10, entry: "2026-11-01", days: 2, sector: "X", why: "gerekçe", ctx: {sector: "X", rsiB: "50-65"}};
  p.pos.push(pos); sellPos(p, pos, 40, 12, "2026-11-02", "hedef", "t"); const afterPartial = AIX.mem.length;
  sellPos(p, pos, 60, 8, "2026-11-03", "stop", "t");
  return {afterPartial, last: AIX.mem[AIX.mem.length - 1], posLeft: p.pos.length};
})()`);
ok("hafıza: kısmi satış kayıt yazmaz, tam kapanış tek kayıt yazar", m.afterPartial === 0 && m.posLeft === 0 && m.last && m.last.n === "AAA", JSON.stringify(m));
ok("hafıza: toplam sonuç (kısmi kâr + kalan zarar) birlikte sayılır", m.last && Math.abs(m.last.pnl - ((40 * 12 * 0.9985 - 400) + (60 * 8 * 0.9985 - 600))) < 0.05 && m.last.win === false, JSON.stringify(m.last));
ok("hafıza: gerekçe ve bağlam saklanır", m.last.why === "gerekçe" && m.last.exit === "stop" && m.last.ctx.sector === "X", JSON.stringify(m.last));
const mem = (recs, name, feat) => { fresh(); return run(`(() => { AIX.mem = ${JSON.stringify(recs)}; return memCheck("${name}", ${JSON.stringify(feat || {sector: "X", rsiB: "50-65"})}, "2026-11-05"); })()`); };
let c = mem([{n: "BBB", d: "2026-11-03", win: false}], "BBB");
ok("hafıza: aynı hisse son günlerde 1 kez zararla kapandı → hafif çekince", c.hard.length === 0 && c.soft.length === 1, JSON.stringify(c));
c = mem([{n: "BBB", d: "2026-11-03", win: false}, {n: "BBB", d: "2026-11-04", win: false}], "BBB");
ok("hafıza: 2 ayrı günde zarar → sert engel", c.hard.length === 1, JSON.stringify(c));
c = mem([{n: "BBB", d: "2026-11-03", win: false, port: "a"}, {n: "BBB", d: "2026-11-03", win: false, port: "b"}, {n: "BBB", d: "2026-11-03", win: false, port: "c"}], "BBB");
ok("hafıza: aynı gün 3 portföyde zarar tek sayılır (bağımsız değil)", c.hard.length === 0 && c.soft.length === 1, JSON.stringify(c));
c = mem([{n: "BBB", d: "2026-09-01", win: false}], "BBB");
ok("hafıza: eski kayıt (>10 gün) etkilemez", c.hard.length === 0 && c.soft.length === 0, JSON.stringify(c));
const ctxRec = (i, win, sector) => ({n: "Z" + i, d: "2026-10-" + String(10 + (i % 15)).padStart(2, "0"), entry: "2026-10-0" + (1 + (i % 9)), win, ctx: {sector, rsiB: "50-65"}});
let recs = []; for (let i = 0; i < 12; i++) recs.push(ctxRec(i, false, "X")); for (let i = 12; i < 42; i++) recs.push(ctxRec(i, i % 3 !== 0, "Y"));
c = mem(recs, "NEW");
ok("hafıza: benzer işlemlerin zarar oranı tabandan anlamlı yüksekse sert engel", c.hard.length === 1 && /anlamlı/.test(c.hard[0]), JSON.stringify(c));
recs = []; for (let i = 0; i < 12; i++) recs.push(ctxRec(i, i % 2 === 0, "X")); for (let i = 12; i < 42; i++) recs.push(ctxRec(i, i % 2 === 0, "Y"));
c = mem(recs, "NEW");
ok("hafıza: zarar oranı tabandan farklı değilse uyarı yok (öğrenmek için kazançlar da sayılır)", c.hard.length === 0 && c.soft.length === 0, JSON.stringify(c));
recs = []; for (let i = 0; i < 6; i++) recs.push(ctxRec(i, false, "X")); for (let i = 6; i < 20; i++) recs.push(ctxRec(i, true, "Y"));
c = mem(recs, "NEW");
ok("hafıza: az örnekte (6) yalnız çekince, engel yok", c.hard.length === 0, JSON.stringify(c));
c = mem([{n: "L1", d: "2026-11-01", win: false}, {n: "L2", d: "2026-11-02", win: false}], "NEW");
ok("hafıza: bağlamsız (eski) kayıtlar örüntü tabanı oluşturmaz", c.hard.length === 0 && c.soft.length === 0, JSON.stringify(c));
const bf = run(`(() => { const st = initState("2026-10-01", 0.3); st.p.komite.trades = [{d: "2026-10-05", n: "AAA", side: "SAT", pnl: -5, pct: -3, why: "stop"}, {d: "2026-10-06", n: "BBB", side: "AL"}, {d: "2026-10-07", n: "CCC", side: "SAT", pnl: 7, pct: 2, why: "hedef"}]; bindAI(st, "${T0}"); const n1 = AIX.mem.length; bindAI(st, "${T0}"); return {n1, n2: AIX.mem.length, w: AIX.mem.map(x => x.win)}; })()`);
ok("hafıza: geçmiş satışlar bir kez aktarılır (alımlar değil), tekrar eklenmez", bf.n1 === 2 && bf.n2 === 2 && bf.w[0] === false && bf.w[1] === true, JSON.stringify(bf));

// ---- 5) Sağlık Tarayıcı ----
const mkState = pos => `(() => { const st = initState("2026-10-01", 0.3); st.bench = [{d: "2026-11-03", xu: 1, ew: 100}]; st.p.komite.pos = ${JSON.stringify(pos)}; st.p.komite.cash = 0; return st; })()`;
const nowO = {date: T0, hhmm: "14:30", ts: 1800000000};
const hs = (pos, byObj, newsObj, now) => run(`(() => { const st = globalThis.__hst || (globalThis.__hst = ${mkState(pos)}); NEWS = Object.assign({}, __news, ${JSON.stringify(newsObj || {})}); const ev = healthScan(st, ${JSON.stringify(byObj)}, ${JSON.stringify(now || nowO)}); return {ev, pos: st.p.komite.pos.map(x => ({n: x.n, sh: x.sh, stop: x.stop})), trades: st.p.komite.trades.map(x => ({n: x.n, sh: x.sh, why: x.why})), hl: st.ai.healthLast, n: st.ai.health.length}; })()`);
const fp = n => ({n, sh: 100, avg: 10, stop: 9.5, entry: "2026-11-01", days: 1, sector: "X", why: "t"});
run("globalThis.__hst = null;");
let h = hs([fp("T1")], {T1: {name: "T1", close: 9.4, atrPct: 3}});
ok("sağlık: fiyat stopun altındaysa pozisyon seans içinde kapatılır", h.pos.length === 0 && h.trades.length === 1 && h.ev[0].act === "kapat", JSON.stringify(h));
run("globalThis.__hst = null;");
h = hs([fp("T2")], {T2: {name: "T2", close: 10.2, atrPct: 3}}, {T2: {items: [{t: "T2 hakkında soruşturma başlatıldı", ts: nowO.ts - 600, p: "kap"}]}});
ok("sağlık: ağır olumsuz KAP (soruşturma) gelince pozisyon kapatılır", h.pos.length === 0 && h.ev[0].act === "kapat" && /KAP/.test(h.ev[0].why), JSON.stringify(h));
run("globalThis.__hst = null;");
h = hs([fp("T3")], {T3: {name: "T3", close: 10.2, atrPct: 3}}, {T3: {items: [{t: "T3 net zarar açıkladı, hisse sert düştü", ts: nowO.ts - 600, p: "matriks"}]}});
const sc = run(`sentiment("T3 net zarar açıkladı, hisse sert düştü").score`);
ok(`sağlık: (ön koşul) başlığın duygu skoru olumsuz (${sc})`, sc <= -0.3, String(sc));
ok("sağlık: orta olumsuz haberde yarıya iner, stop sıkılaşır", h.pos.length === 1 && h.pos[0].sh === 50 && h.pos[0].stop > 9.5 && h.ev[0].act === "yarıya indir", JSON.stringify(h));
h = hs([fp("T3")], {T3: {name: "T3", close: 10.2, atrPct: 3}}, {T3: {items: [{t: "T3 net zarar açıkladı, hisse sert düştü", ts: nowO.ts - 600, p: "matriks"}]}});
ok("sağlık: aynı haber ikinci taramada tekrar işlenmez", h.pos[0].sh === 50 && h.trades.length === 1, JSON.stringify(h));
run("globalThis.__hst = null;");
h = hs([fp("T4")], {T4: {name: "T4", close: 9.52, atrPct: 3}});
ok("sağlık: stopa yaklaşınca uyarı yazar, pozisyona dokunmaz", h.pos.length === 1 && h.ev.length === 1 && h.ev[0].act === "uyarı" && h.trades.length === 0, JSON.stringify(h));
h = hs([fp("T4")], {T4: {name: "T4", close: 9.52, atrPct: 3}});
ok("sağlık: aynı gün aynı uyarı tekrarlanmaz", h.ev.length === 0 && h.n === 1, JSON.stringify(h));
run("globalThis.__hst = null;");
h = hs([fp("T5")], {T5: {name: "T5", close: 11, atrPct: 3}});
ok("sağlık: sağlıklı pozisyon sessiz geçer, tarama kaydı (kalp atışı) tutulur", h.ev.length === 0 && h.pos.length === 1 && h.hl && h.hl.n === 1 && h.hl.t === "14:30", JSON.stringify(h));
run("globalThis.__hst = null;");
h = hs([fp("T6")], {T6: {name: "T6", close: 11, atrPct: 3}}, {T6: {items: [{t: "T6 hakkında soruşturma başlatıldı", ts: nowO.ts - 9 * 3600, p: "kap"}]}});
ok("sağlık: 6 saatten eski haber seans içi tepki üretmez", h.pos.length === 1 && h.ev.length === 0, JSON.stringify(h));
run("globalThis.__hst = null; NEWS = __news;");

// ---- 6) İleri sonuç ölçümü ----
const ds = run(`(() => {
  const st = initState("2026-10-01", 0.3); bindAI(st, "2026-11-04");
  st.bench = []; for (let i = 0; i < 12; i++) st.bench.push({d: "d" + i, xu: 1, ew: 100 + i});
  AIX.dec = [{k: "a", d: "d1", port: "p", n: "AAA", res: "onay", kind: "supheci", why: [], shadow: null, px: 10, bi: 1, r5: null, r10: null, x5: null, x10: null},
             {k: "b", d: "d1", port: "p", n: "BBB", res: "ret", kind: "supheci", why: [], shadow: null, px: 10, bi: 1, r5: null, r10: null, x5: null, x10: null},
             {k: "c", d: "d9", port: "p", n: "AAA", res: "onay", kind: "supheci", why: [], shadow: null, px: 10, bi: 9, r5: null, r10: null, x5: null, x10: null}];
  resolveDec(st, {AAA: {close: 12}, BBB: {close: 9}});
  return {dec: AIX.dec.map(e => [e.r5, e.x5, e.r10]), stats: decStats(AIX)};
})()`);
ok("ölçüm: 5 gün dolan kararın getirisi ve endekse göre fazlası hesaplanır, dolmayan beklemede kalır", ds.dec[0][0] === 20 && ds.dec[1][0] === -10 && ds.dec[2][0] === null, JSON.stringify(ds));
ok("ölçüm: 10 gün dolan karar r10 alır", ds.dec[0][2] === 20, JSON.stringify(ds));
ok("ölçüm: onay/ret grupları ayrı ortalanır", ds.stats.onay && ds.stats.ret && ds.stats.onay.mean > ds.stats.ret.mean, JSON.stringify(ds.stats));
console.log(fails ? `\nGUARDS: ${fails} başarısız` : "\nGUARDS: hepsi geçti");
process.exit(fails ? 1 : 0);
