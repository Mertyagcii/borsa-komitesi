/* core.js v2: efsane/komite mantığı. Tarayıcı ve Node (GitHub Actions: karne + sanal portföyler) ortak kullanır.
   Dışarıdan beklenenler (çağrı anında): R, HIST, NEWS, current.
   Tasarım ilkeleri:
   - Her efsane kendi "mandası" içinde karar verir (Buffett küçük/kârsız işletmeye bakmaz; Kellogg likit olmayan hisseye girmez ...).
   - Eşikler sezgi değil, research.json (3 yıllık BIST testi) ve araştırılan yöntemlere dayanır. Kanıtı ters çıkan sinyalleri (RSI<30, panik satış) kimse almaz.
   - Değerleme yüksek faiz/enflasyon ortamına göre yapılır: tahvil getirisi (TR10Y) iskonto oranıdır, EPS büyümesi enflasyonla sınırlanır. */
const fmt = (v, d = 2) => v == null || Number.isNaN(v) ? "–" : Number(v).toLocaleString("tr-TR", {minimumFractionDigits: d, maximumFractionDigits: d});

const RULE_DEFS = [
  ["Makro varsayımlar (veri yoksa)", [["rf", "Tahvil getirisi % (veri yoksa)", 33], ["erp", "Hisse risk primi % (tahvilin üstü)", 6], ["infl", "Enflasyon beklentisi %", 30], ["gMax", "Adil değer: reel büyüme üst sınırı %", 4], ["gMin", "Adil değer: reel büyüme alt sınırı %", -2], ["gK", "Adil değer: EPS büyümesine güven katsayısı", 0.35]]],
  ["Buffett: işletme sahibi gibi", [["bMcap", "Min. piyasa değeri (milyar TL)", 10], ["bRoe", "Reel ROE en az %", 5], ["bNm", "Net kâr marjı en az %", 8], ["bGm", "Brüt marj en az % (fiyatlama gücü)", 25], ["bDe", "Borç/Özsermaye en çok", 0.6], ["bMos", "Güvenlik marjı en az %", 25]]],
  ["Simons: model", [["sEdge", "Beklenen 10g fazla getiri en az %", 1], ["sRs", "Min. göreceli güç (RS) yüzdesi", 70], ["sKelly", "Kelly çarpanı (kesirli)", 0.25], ["sCap", "Tek hisse azami ağırlık %", 6]]],
  ["Livermore: trend ve pivot", [["lRs", "Lider sayılmak için min. RS", 80], ["lPiv", "Pivota yakınlık %", 2], ["lVol", "Min. göreceli hacim", 1.2], ["lExt", "Aşırı uzama (SMA50 üstü) % üst sınır", 30]]],
  ["Kellogg: momentum", [["kRvol", "Min. göreceli hacim", 2], ["kChg", "Gün içi itiş en az %", 4], ["kAtr", "Min. ATR %", 3], ["kTl", "Min. işlem hacmi (mn TL)", 30]]],
  ["Şeytanın Avukatı: risk", [["dAtr", "Günlük oynaklık üst sınır %", 4], ["dTl", "Min. hacim (mn TL)", 20], ["dStop", "Stop olasılığı % uyarı", 50], ["dMaxDd", "Son 1 yıl maks. düşüş % (üst sınır)", 35], ["dFomo", "1 ayda yükseliş % (kovalama)", 25], ["dSector", "Aynı sektörden en fazla aday", 3], ["dFlags", "Karşı çıkma için bayrak sayısı", 3], ["dPos", "Örnek pozisyon (bin TL, likidite için)", 500]]],
  ["Genişletilmiş kurul (4 yeni uzman)", [["k2veto", "İtiraz vetosu: yeni uzmanların net oyu ≤ −2 ise güçlü aday olmaz (1/0)", 1], ["makroVeto", "Makro kalkan alım vetosu (1/0; geçmişte kanıtsız, varsayılan kapalı)", 0], ["makroN", "Makro veto için en az risk-off bayrağı", 4], ["zHi", "Z-skor aşırı uzama eşiği", 2.5], ["zLo", "Z-skor aşırı düşüş eşiği", -2.5]]],
  ["Simülasyon", [["mDays", "Ufuk (iş günü)", 20], ["mStop", "Stop seviyesi %", 7]]],
];
const DEFAULTS = Object.fromEntries(RULE_DEFS.flatMap(([, f]) => f.map(([k, , v]) => [k, v])));

/* Seans içi hacim düzeltmesi: TradingView'in göreceli hacmi (rvol) "bugüne kadarki hacim / 10 günlük TAM gün ortalaması"dır.
   Öğleden önce her hisse düşük görünür (medyan ≈0,4) ve "hacim patlaması" hiç yakalanmaz. Geçen seans payına bölerek tam güne ölçeklenir
   (BIST sürekli işlem 10:00-18:00; hacim U biçimli olduğundan geçen süre^0,75 kullanılır). Seans dışında düzeltme yoktur. */
function sessionFrac() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {timeZone: "Europe/Istanbul", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false}).formatToParts(new Date()).map(x => [x.type, x.value]));
  if (p.weekday === "Sat" || p.weekday === "Sun") return 1;
  const min = (+p.hour % 24) * 60 + +p.minute, x = (min - 600) / 480;
  if (x >= 1 || x <= 0) return 1;
  return Math.max(0.12, Math.pow(x, 0.75));
}
function enrich(s) {
  if (s.rvolRaw === undefined) s.rvolRaw = s.rvol;
  const fr = sessionFrac();
  s.rvol = s.rvolRaw != null && fr < 1 ? s.rvolRaw / fr : s.rvolRaw;
  s.ok = s.close > 0 && s.bb_lower != null && s.bb_upper != null && s.sma50 != null;
  s.bbDist = s.ok ? (s.close / s.bb_lower - 1) * 100 : null;
  s.smaDist = s.ok ? (s.close / s.sma50 - 1) * 100 : null;
  s.atrPct = s.atr != null && s.close > 0 ? s.atr / s.close * 100 : null;
  s.tl = s.close * s.volume / 1e6; // günlük işlem hacmi, milyon TL
  s.dist52 = s.h52 > 0 ? (s.close / s.h52 - 1) * 100 : null;
  return s;
}

/* ---------- Zaman, makro, piyasa rejimi, göreceli güç ---------- */
let NOW = Date.now();
let REGIME = null;
let RESEARCH = null;
function macro() {
  const m = HIST && HIST.macro;
  return {rf: (m && m.rf10 ? m.rf10 : R.rf) / 100, rf2: (m && m.rf2 ? m.rf2 : R.rf) / 100, erp: R.erp / 100, infl: R.infl / 100, live: !!(m && m.rf10)};
}
function computeRegime(universe, hist) {
  const ok = universe.filter(s => s.ok);
  if (!ok.length) return null;
  const a50 = ok.filter(s => s.close > s.sma50).length / ok.length * 100;
  const s200 = ok.filter(s => s.sma200 != null);
  const a200 = s200.length ? s200.filter(s => s.close > s.sma200).length / s200.length * 100 : null;
  let idx = null;
  if (hist && hist.index && hist.index.closes && hist.index.closes.length >= 200) {
    const c = hist.index.closes, n = c.length, avg = k => c.slice(n - k).reduce((x, y) => x + y, 0) / k;
    const last = c[n - 1], m50 = avg(50), m200 = avg(200);
    idx = {name: hist.index.name, last, m50, m200, ch1m: (last / c[n - 22] - 1) * 100,
      trend: last > m50 && m50 > m200 ? "bull" : last < m50 && last < m200 ? "bear" : "mixed"};
  }
  const trend = idx ? idx.trend : a50 >= 60 ? "bull" : a50 <= 40 ? "bear" : "mixed";
  return {trend, label: {bull: "Boğa", bear: "Ayı", mixed: "Geçiş"}[trend], a50, a200, idx};
}
/* Göreceli güç (RS): 52 hafta zirvesine yakınlık + 6 ay + 1 ay getirinin yüzdelik ortalaması (research.py ile aynı bileşim) */
function rankUniverse(uni) {
  const el = uni.filter(s => s.ok && s.tl >= 5 && s.h52 > 0);
  el.forEach(s => { s._rk = []; });
  for (const key of ["dist52", "p6m", "p1m"]) {
    const arr = el.filter(s => s[key] != null && !Number.isNaN(s[key])).map(s => [s[key], s]).sort((a, b) => a[0] - b[0]);
    arr.forEach(([, s], i) => { s._rk.push(arr.length > 1 ? i / (arr.length - 1) * 100 : 50); });
  }
  el.forEach(s => { s.rs = s._rk.length >= 2 ? s._rk.reduce((a, b) => a + b, 0) / s._rk.length : null; delete s._rk; });
  const inEl = new Set(el);
  uni.forEach(s => { if (!inEl.has(s)) s.rs = null; });
  rankMtf(uni); // çok zamanlı skor RS'ye dayanır
}
/* ---------- Çok zamanlı skor (günlük / haftalık / aylık) ----------
   mtf_research.py: göstergeler zaman diliminin ufkunda test edildi (günlük→5g, haftalık→20g, aylık→60g); mtf_composite.py bileşikleri sınadı.
   Her skor, seçilen göstergelerin evren içindeki yüzdelik sıralamasının ortalamasıdır (0-100). Haftalık skor en tutarlı olandır;
   günlük skor zamanlama, aylık skor bağlam içindir. Göstergeler TradingView'in kendi hesaplarıdır (haftalık |1W, aylık |1M). */
function pctRankMap(el, fn) {
  const arr = el.map(s => [fn(s), s]).filter(([v]) => v != null && Number.isFinite(v)).sort((a, b) => a[0] - b[0]), m = new Map();
  for (let i = 0; i < arr.length;) { // eşit değerlere ortalama sıra
    let j = i; while (j + 1 < arr.length && arr[j + 1][0] === arr[i][0]) j++;
    const r = arr.length > 1 ? (i + j) / 2 / (arr.length - 1) * 100 : 50; for (let k = i; k <= j; k++) m.set(arr[k][1], r); i = j + 1;
  }
  return m;
}
const dmi = (a, b) => a != null && b != null ? a - b : null;
const RS_FEAT = ["Göreceli güç (RS: 52h yakınlık + 6 ay + 1 ay)", s => s.rs, "num"];
const MTF_FEATS = { // [ad, işlev, biçim, ağırlık]: pct = yüzde (×100), num = sayı, bool = evet/hayır
  d: [[...RS_FEAT, 1]],
  w: [["Haftalık trend (fiyat > SMA20 > SMA50)", s => s.sma20_w > 0 && s.sma50_w > 0 ? (s.close > s.sma20_w && s.sma20_w > s.sma50_w ? 1 : 0) : null, "bool"],
      ["6 aylık zirveye uzaklık", s => s.h6m > 0 ? s.close / s.h6m - 1 : null, "pct"], ["Fiyat/haftalık SMA50 farkı", s => s.sma50_w > 0 ? s.close / s.sma50_w - 1 : null, "pct"],
      ["Haftalık DI+ − DI−", s => dmi(s.pdi_w, s.mdi_w), "num"], ["Haftalık RSI", s => s.rsi_w, "num"], ["Haftalık CMF", s => s.cmf_w, "num"], ["6 ay getiri", s => s.p6m, "pct0"],
      [...RS_FEAT, 7]], // RS tek başına bileşiğin %50'si
  m: [["Uzun trend (SMA50 > SMA200)", s => trendUp(s) == null ? null : trendUp(s) ? 1 : 0, "bool"], ["52 hafta zirvesine uzaklık", s => s.dist52, "pct0"], ["Aylık CMF", s => s.cmf_m, "num"], ["6 ay getiri", s => s.p6m, "pct0"], ["1 yıl getiri", s => s.py, "pct0"]],
};
const MTF_AUX = { // yalnızca bilgi: günlük göstergeler ileri doğrulamada skoru iyileştirmediği için skora GİRMEZ
  d: [["CMF (para akışı)", s => s.cmf, "num"], ["RSI", s => s.rsi, "num"], ["DI+ − DI− (yön)", s => dmi(s.pdi, s.mdi), "num"], ["Fiyat/SMA20 farkı", s => s.sma20 > 0 ? s.close / s.sma20 - 1 : null, "pct"]],
};
const fmtFeat = (v, k) => v == null ? "–" : k === "bool" ? (v ? "evet" : "hayır") : k === "pct" ? "%" + fmt(v * 100, 1) : k === "pct0" ? "%" + fmt(v, 1) : fmt(v, 2);
function rankMtf(uni) {
  const el = uni.filter(s => s.ok && s.tl >= 5);
  const sc = {};
  for (const tf of ["d", "w", "m"]) {
    const F = MTF_FEATS[tf], maps = F.map(([, fn]) => pctRankMap(el, fn)), wts = F.map(f => f[3] || 1);
    sc[tf] = new Map(el.map(s => {
      let sum = 0, wsum = 0, n = 0; maps.forEach((m, i) => { const v = m.get(s); if (v != null) { sum += v * wts[i]; wsum += wts[i]; n++; } });
      return [s, n >= Math.ceil(F.length / 2) ? sum / wsum : null];
    }));
    const aux = (MTF_AUX[tf] || []), amaps = aux.map(([, fn]) => pctRankMap(el, fn));
    sc[tf + "P"] = new Map(el.map(s => [s, [...F.map(([n, fn, k, w], i) => [n + (w > 1 ? " (ağırlık %50)" : ""), fmtFeat(fn(s), k), maps[i].get(s) ?? null]),
      ...aux.map(([n, fn, k], i) => [n + " · bilgi (skora girmez)", fmtFeat(fn(s), k), amaps[i].get(s) ?? null])]]));
  }
  const inEl = new Set(el);
  uni.forEach(s => {
    if (!inEl.has(s)) { s.mtf = null; return; }
    const d = sc.d.get(s), w = sc.w.get(s), m = sc.m.get(s);
    s.mtf = {d, w, m, b: w == null ? null : 0.25 * (d ?? 50) + 0.5 * w + 0.25 * (m ?? 50), parts: {d: sc.dP.get(s), w: sc.wP.get(s), m: sc.mP.get(s)}};
  });
}
let MTFR = null; // mtf_composite.json: bileşik skorların geçmiş testi
function mtfExpect(s) { // haftalık skorun dilimine göre geçmiş 20 günlük fazla getiri (%)
  const t = MTFR && MTFR.tests && MTFR.tests.haftalik && MTFR.tests.haftalik["20"];
  if (!t || !s.mtf || s.mtf.w == null) return null;
  return t.dec[Math.min(9, Math.floor(s.mtf.w / 10))];
}
const MTF_TIERS = {
  uyumlu: {label: "Uyumlu lider", cls: "up", tip: "Günlük, haftalık ve aylık skorların üçü de ilk %40'ta ve haftalık ≥ 70. Geçmişte üç zaman diliminin uyumu en iyi ayrışmayı verdi."},
  hlider: {label: "Haftalık lider", cls: "up", tip: "Haftalık skor ≥ 80: en tutarlı bulgu (iki yarıda ve boğa/ayı rejiminde pozitif)."},
  toparlanan: {label: "Toparlanan (kanıtsız)", cls: "", tip: "Haftalık orta (50-80), günlük ≥ 75 ve CMF > 0: erken dönüş adayı. TEST EDİLDİ ve anlamlı çıkmadı (20g +%1,0, t=1,4; ilk yarıda ≈0, ayıda negatif): bir fırsat değil, izleme listesi."},
  zayif: {label: "Zayıf", cls: "down", tip: "Haftalık skor ≤ 30: geçmişte piyasanın altında kalan grup."},
  notr: {label: "Nötr", cls: "", tip: "Belirgin bir üstünlük yok."},
};
function tierId(d, w, m) { // canlı tahmin karnesi için: yalnızca skorlardan kurulum kimliği
  if (w == null) return null; d = d ?? 50; m = m ?? 50;
  return w >= 70 && d >= 60 && m >= 60 ? "uyumlu" : w >= 80 ? "hlider" : w <= 30 ? "zayif" : "notr";
}
function mtfTier(s) {
  const m = s.mtf; if (!m || m.w == null) return null;
  const d = m.d ?? 50, w = m.w, mo = m.m ?? 50;
  const id = w >= 70 && d >= 60 && mo >= 60 ? "uyumlu" : w >= 80 ? "hlider" : w < 80 && w >= 50 && d >= 75 && s.cmf > 0 ? "toparlanan" : w <= 30 ? "zayif" : "notr";
  return {id, ...MTF_TIERS[id]};
}
const rsDecile = s => s.rs == null ? null : Math.min(9, Math.floor(s.rs / 10));
const trendUp = s => s.sma200 == null ? null : s.close > s.sma50 && s.sma50 > s.sma200;

/* ---------- Monte Carlo (GBM, drift=0). Oynaklık: gerçek geçmiş (sigma60) varsa o, yoksa 0.8×ATR% ---------- */
let mcCache = {};
function hash(str) { let h = 2166136261; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function sigmaOf(s) {
  const h = HIST && HIST.stocks[s.name];
  if (h && h.sigma60 > 0) return {v: h.sigma60, src: "gerçek geçmiş (60 gün)"};
  if (s.atrPct != null) return {v: 0.8 * s.atrPct / 100, src: "0,8×ATR% tahmini"};
  return null;
}
/* Ortak rastgele sayılar (common random numbers): standart normal şoklar bir kez üretilir, her hissede kendi σ'sı ile ölçeklenir. Her hissenin dağılımı doğru kalır,
   hisseler arası karşılaştırma gürültüsüz olur ve 10.000 senaryo ~50 kat ucuzlar. */
let MC_Z = null;
function mcZ(n, days) {
  if (MC_Z && MC_Z.n === n && MC_Z.days === days) return MC_Z.z;
  const z = new Float64Array(n * days), r = rng(20261013);
  for (let i = 0; i < z.length; i += 2) { const m = Math.sqrt(-2 * Math.log(1 - r())), a = 2 * Math.PI * r(); z[i] = m * Math.cos(a); if (i + 1 < z.length) z[i + 1] = m * Math.sin(a); }
  MC_Z = {n, days, z}; return z;
}
function monteCarlo(s, n = 10000) {
  const key = s.name; if (mcCache[key]) return mcCache[key];
  const sg = sigmaOf(s); if (!sg) return null;
  const days = Math.max(1, Math.round(R.mDays)), stop = R.mStop, sigma = Math.max(sg.v, 1e-4), z = mcZ(n, days), drift = -0.5 * sigma * sigma, lstop = Math.log(1 - stop / 100);
  const finals = new Float64Array(n); let stopHit = 0;
  for (let i = 0, k = 0; i < n; i++) {
    let lp = 0, min = 0;
    for (let d = 0; d < days; d++, k++) { lp += drift + sigma * z[k]; if (lp < min) min = lp; }
    finals[i] = Math.exp(lp) - 1;
    if (min <= lstop) stopHit++;
  }
  finals.sort();
  const sorted = finals, q = p => sorted[Math.floor(p * (n - 1))] * 100;
  let sum = 0, loss = 0; for (let i = 0; i < n; i++) { sum += sorted[i]; if (sorted[i] < 0) loss++; }
  const mean = sum / n * 100; let ss = 0; for (let i = 0; i < n; i++) ss += (sorted[i] * 100 - mean) ** 2; const sd = Math.sqrt(ss / n);
  const nt = Math.max(1, Math.floor(n * 0.05)); let ts = 0; for (let i = 0; i < nt; i++) ts += sorted[i]; const cvar5 = ts / nt * 100, rf = macro().rf * days / 250 * 100;
  return mcCache[key] = { sigma: sigma * 100, src: sg.src, days, stop, n, p05: q(.05), p50: q(.5), p95: q(.95), mean, sd, cvar5, rf, sharpe0: sd > 0 ? (mean - rf) / sd : null,
    probLoss: loss / n * 100, probStop: stopHit / n * 100, finals: Array.from(sorted) };
}

/* ---------- Eski geri test (history.json): Geri Test sayfası ve hesaplayıcı kullanır ---------- */
function btFor(s) {
  if (!HIST) return null;
  const own = HIST.stocks[s.name] && HIST.stocks[s.name].bt, base = HIST.pooled.base, pooled = HIST.pooled.A;
  const useOwn = own && own.n >= 5 && own.h10;
  const b = useOwn ? own : pooled;
  if (!b || !b.h10 || !base || !base.h10) return null;
  return { own: !!useOwn, n: b.n, win: b.h10.win, mean: b.h10.mean, med: b.h10.med, p10: b.h10.p10, aw: b.h10.aw, al: b.h10.al,
    baseWin: base.h10.win, baseMean: base.h10.mean, edge: b.h10.mean - base.h10.mean };
}

/* ---------- Kontrol listesi yardımcıları ---------- */
const OK = 1, BAD = -1, NA = 0;
const chk = (c, t, val) => ({s: c == null ? NA : c ? OK : BAD, t, val: val ?? ""});
const pc = v => v == null || Number.isNaN(v) ? "–" : "%" + fmt(v, 1);
function tally(checks) {
  const ok = checks.filter(c => c.s === OK).length, bad = checks.filter(c => c.s === BAD).length, n = ok + bad;
  return {ok, bad, n, score: n ? Math.round(ok / n * 100) : null};
}
const isFin = s => s.sector === "Finance";
const graham = s => s.eps > 0 && s.bvps > 0 ? Math.sqrt(22.5 * s.eps * s.bvps) : null;
const evidence = id => RESEARCH && RESEARCH.signals ? RESEARCH.signals.find(x => x.id === id) : null;
/* Sinyal yaşlanması: araştırmada kanıtı ters çıkan ya da son 1 yılda avantajı kaybolan sinyal "false" döner (kural devre dışı).
   true = kanıtlı, null = kanıt yok/belirsiz (kural çalışır ama destek sayılmaz). */
function signalOk(id) {
  const e = evidence(id); if (!e) return null;
  if (e.verdict === "ters kanıt" || e.aging) return false;
  if (e.verdict === "kanıt var") return true;
  return e.recent && e.recent.excess <= 0 ? false : null;
}

/* ---------- Haber türleri (KAP/haber başlığı sınıflandırması) ---------- */
const trLower = s => String(s || "").replace(/İ/g, "i").replace(/I/g, "ı").toLowerCase();
const NEWS_TAGS = [["Temettü", /temettü|kâr payı|kar payı/, "up"], ["Bedelsiz", /bedelsiz|bölünme/, "up"], ["Bilanço", /bilanço|finansal sonuç|net dönem|çeyrek|faaliyet raporu/, ""],
  ["İhale/Sözleşme", /ihale|sözleşme|sipariş|anlaşma/, "up"], ["Dava/Ceza", /dava|ceza|soruşturma|tedbir|yasak|iflas|konkordato/, "down"], ["Geri alım", /geri alım/, "up"],
  ["Analist", /hedef fiyat|tavsiye|\(.*yatırım\)|beklenti/, ""]];
const tagsOf = title => { const x = trLower(title); return NEWS_TAGS.filter(([, re]) => re.test(x)); };

/* ---------- Sektör istatistikleri: medyan RS, 1 ay getiri, SMA50 üstü oranı; RS'ye göre sıralama ---------- */
let SECTOR_STATS = {};
function computeSectorStats(uni) {
  const g = {};
  uni.filter(s => s.ok && s.rs != null && s.tl >= 10).forEach(s => { (g[s.sector || "Diğer"] = g[s.sector || "Diğer"] || []).push(s); });
  const med = a => { const b = a.filter(x => x != null && !Number.isNaN(x)).sort((x, y) => x - y); return b.length ? b[Math.floor((b.length - 1) / 2)] : null; };
  const ratio = (a, fn) => { const r = a.map(fn).filter(x => x != null && Number.isFinite(x) && x > 0.05 && x < 20); return r.length >= 5 ? med(r) : null; };
  const rows = Object.entries(g).filter(([, a]) => a.length >= 3).map(([name, a]) => ({name, n: a.length,
    peArr: a.map(s => s.pe > 0 ? s.pe : null).filter(x => x != null).sort((x, y) => x - y), pbArr: a.map(s => s.pb > 0 ? s.pb : null).filter(x => x != null).sort((x, y) => x - y),
    kEps: ratio(a, s => { const f = intrinsic(s).fvEps; return f > 0 ? s.close / f : null; }), kRoe: ratio(a, s => { const q = roePbValue(s, intrinsic(s)); return q ? s.close / q.v : null; }), rs: med(a.map(s => s.rs)), p1m: med(a.map(s => s.p1m)), p3m: med(a.map(s => s.p3m)), above: a.filter(s => s.close > s.sma50).length / a.length * 100, medPe: med(a.map(s => s.pe > 0 ? s.pe : null)), medPb: med(a.map(s => s.pb > 0 ? s.pb : null)), medRoe: med(a.map(s => s.roe))}));
  rows.sort((x, y) => y.rs - x.rs); rows.forEach((r, i) => { r.rank = i + 1; });
  SECTOR_STATS = Object.fromEntries(rows.map(r => [r.name, {...r, total: rows.length}]));
  return rows;
}

/* Adil değer: ENFLASYONDAN ARINDIRILMIŞ (reel) iskonto ve büyüme. (Denetim notu: önceki sürüm nominal iskonto (tahvil %33 + risk primi) kullanıp
   büyümeyi 0'a sabitliyordu; %30 enflasyonda bu, hisselerin çoğuna "adil F/K ≈ 2,6" biçiyordu (gerçek medyan F/K ≈ 11) ve sistematik olarak "pahalı" diyordu.)
   - Nominal iskonto = tahvil getirisi + hisse risk primi; reel iskonto = (1 + tahvil) / (1 + enflasyon beklentisi) − 1 + hisse risk primi.
   - Reel büyüme g: son EPS büyümesinin %35'i (TMS 29 sonrası rakamlar reel kabul edilir) (gürültülü olduğundan güven katsayısı düşük), [gMin, gMax] (varsayılan −%2, +%4) aralığıyla sınırlı;
     |EPS büyümesi| > %200 ise taban etkisi sayılır, büyüme 0 alınır.
   - Adil çarpan = (1 + g) / (r_reel − g), [3, 20] ile sınırlı. Reel çarpan nominal EPS'e uygulanır (nominal ve reel oranlar aynı enflasyonla ölçeklendiğinde çarpan aynıdır).
   - Banka/finans ve varlık ağırlıklı işletmeler için ayrıca gerekçeli PD/DD = (reel ROE − g) / (r_reel − g) (valuation içinde).
   İki tahmin: kazanç (EPS) ve sahip kazancı (FCF/hisse; banka dışı). Buffett için temkinli olan (küçük olan) alınır. */
function intrinsic(s) {
  const m = macro(), rNom = m.rf + m.erp, rReal = (1 + m.rf) / (1 + m.infl) - 1 + m.erp, fin = isFin(s); // reel risksiz getiri + hisse risk primi
  const epsgReal = s.epsg != null && Math.abs(s.epsg) <= 200 ? s.epsg / 100 : null; // TMS 29 (enflasyon muhasebesi) sonrası bilanço rakamları cari satın alma gücüyle yeniden ifade edilir: büyüme zaten reel kabul edilir
  const gMax = (R.gMax ?? 4) / 100, gMin = (R.gMin ?? -2) / 100, gK = R.gK ?? 0.35;
  const g = Math.max(gMin, Math.min(gMax, epsgReal == null ? 0 : gK * epsgReal));
  const mult = rReal - g > 0.01 ? Math.max(3, Math.min(20, (1 + g) / (rReal - g))) : 20;
  const out = {g, r: rReal, rNom, mult, fvEps: null, fvOe: null, fv: null, mos: null, gn: graham(s), epsgReal};
  if (s.eps > 0) out.fvEps = s.eps * mult;
  if (!fin && s.fcf > 0 && s.mcap > 0 && s.close > 0) out.fvOe = (s.fcf / (s.mcap / s.close)) * mult;
  const c = [out.fvEps, out.fvOe].filter(v => v != null);
  out.fv = c.length ? Math.min(...c) : null;
  out.mos = out.fv ? (out.fv - s.close) / out.fv * 100 : null;
  return out;
}
/* Duyarlılık: adil değer iskonto oranı ve büyümeye çok duyarlıdır; ±2 puanlık değişimle kazanç değeri nasıl oynuyor? */
function roePbValue(s, iv) { // gerekçeli PD/DD: sürdürülebilir ROE (TMS 29 sonrası reel kabul; yarı yarıya iskonto oranına sönümlü)
  const book = s.bvps > 0 ? s.bvps : null; if (!(book && s.roe != null && s.roe > 0 && s.roe < 200)) return null;
  const roeS = 0.5 * s.roe / 100 + 0.5 * iv.r, pbJ = Math.max(0.2, Math.min(4, (roeS - iv.g) / (iv.r - iv.g)));
  return {v: pbJ * book, roeS, pbJ};
}
function valSens(s) {
  const iv = intrinsic(s); if (!(s.eps > 0)) return null;
  const rows = [-0.02, 0, 0.02].map(dg => [-0.02, 0, 0.02].map(dr => { const g = iv.g + dg, r = iv.r + dr, k = r - g > 0.01 ? Math.max(3, Math.min(20, (1 + g) / (r - g))) : 20; return s.eps * k; }));
  return {rows, g: iv.g, r: iv.r};
}

/* =====================================================================================
   WARREN BUFFETT: işletmenin sahibi gibi düşünür. Piyasa fiyatı (Mr. Market) bir tekliftir, görüş değil.
   Manda: anlayabileceği, kârlı, yeterince büyük işletmeler. Kalite + fiyat disiplini; neredeyse hiç satmaz. */
function buffett(s) {
  const m = macro(), fin = isFin(s), iv = intrinsic(s);
  const real = x => x == null ? null : ((1 + x / 100) / (1 + m.infl) - 1) * 100;
  const roeReal = real(s.roe), nd = s.debt != null && s.ebitda > 0 ? (s.debt - (s.cash || 0)) / s.ebitda : null;
  const ey = s.pe > 0 ? 100 / s.pe : null, fcfy = !fin && s.fcf != null && s.mcap > 0 ? s.fcf / s.mcap * 100 : null;
  const gyo = /GYO$/.test(s.name); // GYO kazancı çoğunlukla değer artışıdır, işletme kazancı değildir
  const inCircle = s.mcap >= R.bMcap * 1e9 && s.eps > 0 && !gyo;
  const checks = [
    chk(inCircle, `Yeterince büyük, kârlı ve anlaşılır işletme (piyasa değeri ≥ ${R.bMcap} mlr TL, EPS > 0, GYO değil)`, gyo ? "GYO: kazanç değer artışı kaynaklı" : `${s.mcap ? fmt(s.mcap / 1e9, 0) + " mlr TL" : "–"}, EPS ${fmt(s.eps)}`),
    chk(roeReal == null ? null : roeReal >= R.bRoe, `Reel özsermaye getirisi ≥ %${R.bRoe} (enflasyon düşülmüş)`, `${pc(s.roe)} nominal → ${pc(roeReal)} reel`),
    chk(s.nm == null || s.nm > 100 ? null : s.nm >= R.bNm, `Net kâr marjı ≥ %${R.bNm}`, s.nm > 100 ? `anormal (${pc(s.nm)})` : pc(s.nm)),
    chk(fin || s.gm == null ? null : s.gm >= R.bGm, `Brüt marj ≥ %${R.bGm} (fiyatlama gücü vekili)`, fin ? "banka/finans: geçerli değil" : pc(s.gm)),
    chk(fin || s.de == null ? null : s.de <= R.bDe && (nd == null || nd <= 2.5), `Borç/Özsermaye ≤ ${R.bDe} ve net borç/FAVÖK ≤ 2,5`, fin ? "banka/finans: geçerli değil" : `${fmt(s.de)} / ${nd == null ? "–" : fmt(nd, 1)}`),
    chk(fin || s.fcf == null ? null : s.fcf > 0, "Serbest nakit akışı pozitif (sahip kazancı)", fin ? "banka/finans: geçerli değil" : s.fcf == null ? "–" : s.fcf > 0 ? `pozitif (getiri ${pc(fcfy)})` : "negatif"),
    chk(s.epsg == null ? null : s.epsg >= m.infl * 100, "Kazanç büyümesi enflasyonu karşılıyor (reel büyüme ≥ 0)", `${pc(s.epsg)} vs enflasyon ${pc(m.infl * 100)}`),
    chk(iv.mos == null ? null : iv.mos >= R.bMos, `Güvenlik marjı ≥ %${R.bMos}: adil değer ${iv.fv ? fmt(iv.fv) + " TL" : "–"} (reel iskonto %${fmt(iv.r * 100, 1)} = tahvil %${fmt(m.rf * 100, 1)} + risk primi %${fmt(m.erp * 100, 0)} enflasyondan arındırılmış; reel büyüme %${fmt(iv.g * 100, 1)}; çarpan ${fmt(iv.mult, 1)}x)`, pc(iv.mos)),
    chk(ey == null ? null : ey >= m.rf * 100 * 0.5, "Kazanç getirisi (1/FK) tahvil faizinin yarısından fazla (kalanı büyümeyle gelir)", `${pc(ey)} vs tahvil ${pc(m.rf * 100)}`),
    chk(null, "Kalıcı rekabet avantajı (moat), basit iş modeli, yetenek çevresi", "veriyle ölçülemez: kendiniz doğrulayın"),
    chk(null, "Dürüst ve yetenekli yönetim", "veriyle ölçülemez"),
  ];
  const quality = tally(checks.slice(1, 8)), all = tally(checks);
  const v = !inCircle ? (s.eps <= 0 ? -1 : 0) : quality.n >= 4 && quality.score >= 65 && iv.mos != null && iv.mos >= R.bMos ? 1 : quality.n >= 4 && quality.score < 35 ? -1 : 0;
  const hurdle = `Tahvil %${fmt(m.rf * 100, 1)} getiri veriyor; hisse bundan fazlasını vaat etmeli.`;
  let t;
  if (!inCircle) t = gyo ? "Gayrimenkul ortaklığının kazancı çoğu zaman değer artışından gelir; bu işletme kazancı değil, defter hareketidir. Anlamadığım yere girmem." : s.eps <= 0 ? "Kazanç yok. Bir işletmenin kâr etmediğini görünce kalemi bırakırım; hikâye anlatan şirketlerle işim olmaz." : "Bu işletme benim için fazla küçük; büyük bir pozisyon alamayacağım yere zaman harcamam.";
  else if (v > 0) t = `Kaliteli bir işletme ve fiyatı makul: adil değere göre %${fmt(iv.mos, 0)} iskonto var. ${hurdle} Burada var. Alır ve unuturum.`;
  else if (v < 0) t = `İş zayıf görünüyor (kalite ölçütlerinin ${quality.ok}/${quality.n}'i geçiyor). Ucuz diye zayıf işletme almam; ucuzluk bazen sadece ucuzluktur.`;
  else t = iv.mos != null && iv.mos < R.bMos ? `İşletme fena değil ama fiyat bana yer bırakmıyor (güvenlik marjı %${fmt(iv.mos, 0)}). Güzel bir işletmeyi yanlış fiyata almak hata olur; bekleyebilirim. ${hurdle}` : `Tablo karışık (${quality.ok}/${quality.n}). Anlamadığım ya da emin olmadığım yerde pas geçerim.`;
  const cap = iv.fv ? iv.fv * (1 - R.bMos / 100) : null;
  const plan = cap ? `En fazla ${fmt(cap)} TL'ye alırdım (adil değer ${fmt(iv.fv)} TL − %${R.bMos} güvenlik marjı). Stop kullanmam; fiyat düşerse işletmenin değeri değişti mi diye bakarım. Fiyat adil değere ulaşırsa ya da iş bozulursa satarım, aksi halde yıllarca tutarım.`
    : "Adil değer hesaplanamadı (EPS/nakit akışı eksik): bu yüzden fiyat veremem. Stop kullanmam; uzun vadeli sahiplik gözüyle bakarım.";
  const audit = balanceAudit(s);
  return {v, score: all.score, checks, t: t + (audit.text ? " " + audit.text : ""), plan, fv: iv.fv, mos: iv.mos, cap, quality: quality.score, audit};
}

/* =====================================================================================
   JIM SIMONS: hikâye yok, model var. "Bu şirket ne yapıyor" sorusuyla ilgilenmez; "bu örüntü geçmişte para kazandırdı mı?" der.
   Model: göreceli güç (RS) dilimine göre beklenen fazla getiri (research.json). Kanıtı ters çıkan sinyalleri (RSI<30, panik satış) cezalandırır.
   Küçük avantajı kesirli Kelly ile boyutlar; modeli tek bir hisse için ezmez. */
function simons(s) {
  const dec = rsDecile(s), tab = RESEARCH && RESEARCH.rs_deciles, sg = sigmaOf(s);
  let exp = dec != null && tab ? tab[dec] : null;
  const pen = [];
  if (exp != null) {
    const ev1 = evidence("rsi30"), ev2 = evidence("dusus_hacim");
    if (s.rsi != null && s.rsi < 30 && ev1 && ev1.verdict === "ters kanıt") { exp += ev1.h10.excess; pen.push(`RSI<30 (geçmiş ${fmt(ev1.h10.excess, 1)}%)`); }
    if (s.change <= -5 && s.rvol >= 2 && ev2 && ev2.verdict === "ters kanıt") { exp += ev2.h10.excess; pen.push(`hacimli panik düşüş (geçmiş ${fmt(ev2.h10.excess, 1)}%)`); }
  }
  const s10 = sg ? sg.v * Math.sqrt(10) * 100 : null, edge = exp != null && s10 ? exp / s10 : null;
  const f = exp != null && s10 ? exp / 100 / ((s10 / 100) ** 2) : null;
  const w = f != null && f > 0 ? Math.min(R.sCap, R.sKelly * f * 100) : 0;
  const top = RESEARCH && RESEARCH.rs_top_trend, tr = trendUp(s);
  const mt = s.mtf, mexp = mtfExpect(s), mtOk = mt && mt.w != null && mt.w >= 80 && mexp != null && mexp >= R.sEdge;
  const checks = [
    chk(exp == null ? null : exp >= R.sEdge, `Model beklentisi: 10 günde piyasa ortalamasının ≥ %${R.sEdge} üstü`, exp == null ? "araştırma yok" : `${exp > 0 ? "+" : ""}${fmt(exp, 2)}% (RS dilimi ${dec == null ? "–" : dec + 1}/10)`),
    chk(s.rs == null ? null : s.rs >= R.sRs, `Göreceli güç yüzdesi ≥ ${R.sRs} (52 hafta yakınlığı + 6 ay + 1 ay)`, s.rs == null ? "–" : fmt(s.rs, 0)),
    chk(tr, "Yükselen trend filtresi (SMA50 > SMA200): araştırmada en iyi sonuç bu filtreyle", tr == null ? "–" : tr ? "evet" : "hayır"),
    chk(pen.length ? false : (exp == null ? null : true), "Kanıtı ters çıkan sinyal yok (RSI<30, hacimli panik)", pen.length ? pen.join("; ") : "yok"),
    chk(edge == null ? null : edge >= 0.1, "Beklenti/oynaklık oranı ≥ 0,1 (gürültüye göre sinyal)", edge == null ? "–" : fmt(edge, 2)),
    chk(top ? top.n >= 20 : null, "Model yeterli gözlemle test edilmiş (≥ 20 örtüşmeyen dönem)", top ? `${top.n} dönem, isabet ${pc(top.win)}` : "–"),
    chk(s.tl >= R.kTl / 2, "Likit (modelin işlem yapabileceği boyut)", `${fmt(s.tl, 0)} mn TL`),
    chk(mt && mt.w != null ? mt.w >= 70 : null, "Haftalık çok göstergeli skor ≥ 70 (araştırmanın en tutarlı grubu)", mt && mt.w != null ? `${fmt(mt.w, 0)}/100${mexp != null ? `, geçmiş 20g fazla getiri ${mexp > 0 ? "+" : ""}${fmt(mexp, 1)}%` : ""}` : "–"),
    chk(mt && mt.d != null && mt.w != null && mt.m != null ? mt.d >= 60 && mt.w >= 60 && mt.m >= 60 : null, "Üç zaman dilimi uyumlu (günlük, haftalık, aylık skorların hepsi ≥ 60)", mt ? `${fmt(mt.d, 0)} / ${fmt(mt.w, 0)} / ${fmt(mt.m, 0)}` : "–"),
  ];
  const k = tally(checks);
  let v = 0;
  if (exp != null && (exp <= -0.8 || pen.length)) v = -1;
  else if (exp != null && exp >= R.sEdge && s.rs >= R.sRs && !pen.length) v = 1;
  else if (mtOk && !pen.length && (exp == null || exp > -0.8)) v = 1; // RS dilimi sınırda olsa da haftalık çok göstergeli skor güçlüyse model olumlu
  const t = v > 0 ? `Model "al" diyor: ${exp != null ? `RS dilimi ${dec + 1}/10, beklenen fazla getiri ${exp > 0 ? "+" : ""}${fmt(exp, 2)}% / 10 gün` : "haftalık çok göstergeli skor güçlü"}${mtOk ? `; haftalık skor ${fmt(mt.w, 0)}/100 (geçmişte bu dilim 20 günde ${mexp > 0 ? "+" : ""}${fmt(mexp, 1)}% fazla getirdi)` : ""}. Bunu bir hikâyeye bağlamıyorum; örüntü geçmişte (${top ? top.n : "?"} dönemde) kazandırdı. Tek işlemde haklı olmak zorunda değilim; küçük avantajı çok işleme yayarım.`
    : v < 0 ? `Model karşı: ${pen.length ? pen.join(", ") + " geçmişte tutarlı biçimde kaybettirdi" : "RS dilimi en alt grupta, beklenti negatif"}. Modelin dediğini yaparım, kendi fikrimi araya sokmam.`
    : "Beklenti avantaj eşiğinin altında. Avantaj yoksa işlem yok; modeli zorlamam.";
  const plan = w > 0 ? `Önerilen ağırlık %${fmt(w, 1)} (kesirli Kelly ${R.sKelly}, tavan %${R.sCap}). Ufuk 10 iş günü; süre dolunca ya da model skoru bozulunca çıkar. Aşırı sapmaya karşı −%8 emniyet stopu.`
    : "Ağırlık sıfır: model bu hissede avantaj görmüyor.";
  const mcs = mcSharpe(s, exp), mcq = mcs ? monteCarlo(s) : null;
  const plan2 = plan + (mcs && mcq ? ` Monte Carlo (${mcq.n.toLocaleString("tr-TR")} senaryo, ${mcq.days} gün): model beklentisiyle Sharpe ${fmt(mcs.sharpe, 2)} (risksiz getiri %${fmt(mcq.rf, 1)} düşülmüş), bilgi oranı ${fmt(mcs.ir, 2)}; en kötü %5 senaryonun ortalaması (CVaR) %${fmt(mcq.cvar5, 1)}.` : "");
  return {v, score: k.score, checks, t, plan: plan2, exp, edge, w, dec, mexp, mcs};
}

/* =====================================================================================
   JESSE LIVERMORE: tahmin etmez, teyit bekler. "En az direnç çizgisi" yukarıysa ve fiyat pivotu hacimle kırdıysa girer.
   Önce küçük test alımı (hedef pozisyonun ~%25'i), kazanıyorsa ekler (piramit), kaybedene asla eklemez. Trend bozulunca çıkar.
   Ayı piyasasında yalnızca en güçlü liderlere bakar; net fırsat yoksa işlem yapmaz. */
function livermore(s) {
  const tr = trendUp(s), pivot = s.h1m, np = pivot ? s.close / pivot : null;
  const bear = REGIME && REGIME.trend === "bear";
  const nearPivot = np != null && np >= 1 - R.lPiv / 100;
  const leader = s.rs != null && s.rs >= (bear ? 90 : R.lRs);
  const extended = s.smaDist != null && s.smaDist > R.lExt;
  const secRank = SECTOR_STATS[s.sector || "Diğer"] || null;
  const sA = signalOk("yakin52"), sB = signalOk("kirilim20_trend"), support = sA === false || sB === false ? false : sA || sB ? true : null;
  const checks = [
    chk(tr, "En az direnç çizgisi yukarı: fiyat > SMA50 > SMA200", `${fmt(s.close)} / ${fmt(s.sma50)} / ${s.sma200 ? fmt(s.sma200) : "–"}`),
    chk(s.rs == null ? null : leader, `Lider hisse: göreceli güç ≥ ${bear ? 90 : R.lRs}${bear ? " (ayı rejimi: yalnızca en güçlüler)" : ""}`, s.rs == null ? "–" : fmt(s.rs, 0)),
    chk(np == null ? null : nearPivot ? true : np < 0.95 ? false : null, `Pivot (1 aylık zirve ${pivot ? fmt(pivot) : "–"}) kırılıyor ya da %${R.lPiv} içinde`, np == null ? "–" : `zirvenin ${pc(np * 100 - 100)}`),
    chk(s.rvol == null ? null : s.rvol >= R.lVol ? s.change > 0 : null, `Kırılım hacimle teyitli (göreceli hacim ≥ ${R.lVol}x ve fiyat artıyor)`, `${fmt(s.rvol, 1)}x, ${pc(s.change)}`),
    chk(s.close >= s.sma50 ? true : s.sma20 != null && s.close < s.sma20 ? false : null, "Düşen bıçak değil (SMA50 üstünde ya da toparlanıyor)", `SMA50'ye ${pc(s.smaDist)}`),
    chk(s.dist52 == null ? null : s.dist52 >= -10, "Zirveye yakın: 52 hafta zirvesinin %10 içinde", pc(s.dist52)),
    chk(s.smaDist == null ? null : !extended, `Pivottan çok uzaklaşmamış (SMA50 üstü ≤ %${R.lExt}): kovalamam`, pc(s.smaDist)),
    chk(REGIME ? !bear || s.rs >= 90 : null, "Piyasa rejimi uygun (ayıda yalnızca en güçlü liderler)", REGIME ? REGIME.label : "–"),
    chk(secRank ? secRank.rank <= Math.ceil(secRank.total * 0.4) : null, "Sektörü güçlü: sektör RS sıralamasında ilk %40 (liderler sektörleriyle yükselir)", secRank ? `${secRank.rank}/${secRank.total}. sıra` : "–"),
    chk(support, "Araştırma desteği: 52h yakınlık / kırılım sinyalleri hâlâ kanıtlı (yaşlanmamış)", support == null ? "kanıt yok" : support ? "kanıtlı" : "KANIT KAYBI: yeni giriş yok"),
    chk(s.sma20_w > 0 && s.sma50_w > 0 ? s.close > s.sma20_w && s.sma20_w > s.sma50_w : null, "Haftalık grafik de yukarı: fiyat > haftalık SMA20 > SMA50 (araştırmada en güçlü tek gösterge)", s.sma20_w > 0 ? `${fmt(s.close)} / ${fmt(s.sma20_w)} / ${s.sma50_w ? fmt(s.sma50_w) : "–"}` : "–"),
  ];
  const k = tally(checks);
  let v = tr && leader && k.score >= 70 && (nearPivot || (s.dist52 != null && s.dist52 >= -5)) && !extended ? 1 : (tr === false && s.close < s.sma50) || k.score < 30 ? -1 : 0;
  if (bear && v > 0 && !(s.rs >= 90)) v = 0;
  if (support === false && v > 0) v = 0; // araştırmada avantaj kaybolmuşsa yeni pozisyon açmaz
  const dgL = depthGate(s); if (dgL && dgL.block && v > 0) v = 0; // kullanıcı derinlik kapısını açtıysa ve tahta kırılımı teyit etmiyorsa
  const t = v > 0 ? `Tape'e bakıyorum: trend yukarı, ${s.name} lider grupta (RS ${fmt(s.rs, 0)}) ve pivot ${nearPivot ? "kırılıyor" : "yakında"}${s.rvol >= R.lVol ? ", hacim de eşlik ediyor" : ""}. Burada beklentiye değil teyide oynuyorum; teyit geldi.`
    : v < 0 ? "Düşen bıçak tutulmaz. Trend aşağı ya da hisse liderlerin arasında değil; böyle yerde 'ucuz' diye alan umut ticareti yapıyordur."
    : bear ? "Piyasa ayı rejiminde; bu hisse yeterince güçlü bir lider değil. Beklemek de bir pozisyondur. Net fırsat yoksa işlem yapmam."
    : "Net bir fırsat yok: ya pivot kırılmadı ya hacim teyit etmedi ya da hisse çok uzamış. Acele edip yanlış zamanda girmem.";
  const unit = 25;
  const plan = pivot && np >= 0.9 ? `Test alımı: hedef pozisyonun %${unit}'i, pivot ${fmt(pivot)} TL üstünde hacimli kapanışta. Fiyat +%5 ilerledikçe birim ekler (en çok 3 ekleme), zarardaki pozisyona asla eklemez. Yanılma noktası pivotun %3 altı ≈ ${fmt(pivot * 0.97)} TL; çıkış: SMA20 altı kapanış ya da zirveden %8 geri verme.`
    : `Pivotun belirgin altında: işlem yok. Pivotu (≈ ${pivot ? fmt(pivot) : "–"} TL) hacimle aşan kapanışı bekler; stop alımdan önce belirlenir.`;
  const dTxt = dgL && dgL.block ? ` Derinlik kapısı: kırılım teyitsiz (${dgL.reasons.join("; ")}).` : "";
  return {v, score: k.score, checks, t: t + dTxt, plan, pivot, depth: dgL};
}

/* =====================================================================================
   JACK KELLOGG: hızlı hareket eden, hacmi patlayan hisselerde kısa-orta vadeli momentum (birkaç gün–hafta).
   Basit araçlar: destek/direnç, hacim. Kaybı hızla keser, zarardakine asla eklemez, kazananı kademeli satar (scale out), likiditeyi önemser.
   Kesin kural seti kamuya açık değildir; eşikler yorumdur ve araştırmayla (kırılımlı itişin boğa rejiminde +, ayıda − olması) uyumludur. */
function kellogg(s) {
  const rv = s.rvol, bear = REGIME && REGIME.trend === "bear";
  const brk = s.h1m ? s.close >= s.h1m * 0.98 : null;
  const support = signalOk("kellogg_itis_kirilim");
  const nn = NEWS[s.name], catalyst = nn && nn.items && nn.items.some(i => NOW / 1000 - i.ts < 2 * 86400 && i.s > 0);
  const thrust = s.change >= R.kChg && rv >= R.kRvol;
  const checks = [
    chk(rv == null ? null : rv >= R.kRvol, `Olağandışı hacim: göreceli hacim ≥ ${R.kRvol}x`, `${fmt(rv, 1)}x`),
    chk(s.change == null ? null : s.change >= R.kChg ? true : s.change <= -R.kChg ? false : null, `Güçlü itiş: gün içi ≥ %${R.kChg}`, pc(s.change)),
    chk(brk, "Kırılım: 1 aylık zirvenin %2 yakınında ya da üstünde (direnç aşılıyor)", s.h1m ? pc((s.close / s.h1m - 1) * 100) : "–"),
    chk(s.pw == null ? null : s.pw > 0 && (s.p1m == null || s.p1m > 0), "Haftalık ve aylık momentum pozitif", `${pc(s.pw)} / ${pc(s.p1m)}`),
    chk(s.atrPct == null ? null : s.atrPct >= R.kAtr, `Hareket kapasitesi: ATR ≥ %${R.kAtr} (kısa vadede kâr için hareket lazım)`, pc(s.atrPct)),
    chk(s.tl >= R.kTl, `Likidite/spread: günlük hacim ≥ ${R.kTl} mn TL`, `${fmt(s.tl, 0)} mn TL`),
    chk(REGIME ? !bear : null, "Piyasa ayıda değil (kırılımlar ayıda tutmuyor)", REGIME ? REGIME.label : "–"),
    chk(catalyst ? true : null, "Katalizör: son 2 günde olumlu haber/KAP", catalyst ? "var" : "yok (zorunlu değil)"),
    chk(s.cmf == null ? null : s.cmf > 0, "Para girişi: Chaikin Para Akışı (CMF) > 0 (alıcılar gün içi aralığın üst yarısında kapatıyor)", s.cmf == null ? "–" : fmt(s.cmf, 2)),
    chk(support, "Araştırma desteği: hacimli itiş + kırılım sinyali hâlâ avantajlı (son 1 yıl)", support == null ? "kanıt yok/belirsiz" : support ? "kanıtlı" : "KANIT KAYBI: yeni giriş yok"),
  ];
  const k = tally(checks);
  const v0 = thrust && brk !== false && s.tl >= R.kTl && !bear && k.score >= 60 ? 1 : rv >= R.kRvol && s.change <= -R.kChg ? -1 : 0;
  const dgK = depthGate(s), v1 = v0 > 0 && support === false ? 0 : v0, v = v1 > 0 && dgK && dgK.block ? 0 : v1;
  const t = v > 0 ? `Hacim ${fmt(rv, 1)}x, fiyat %${fmt(s.change, 1)} itiyor ve direnç ${brk ? "aşılıyor" : "yakın"}: momentum canlı${catalyst ? ", üstüne haber de var" : ""}. Hızlı hareket eden yerde olmak isterim; ama stop'um hazır.`
    : v < 0 ? "Hacim yüksek ama fiyat sert düşüyor: bu dağıtım, alıcı yok satıcı var. Kimse bıçağı tutmaz; uzak dururum."
    : bear ? "Piyasa ayı rejiminde; kırılımlar bu ortamda sık sık geri dönüyor. Yavaş piyasada kenarda beklerim."
    : "Hacim patlaması ve kırılım birlikte yok. Kimsenin ilgilenmediği hissede vakit kaybetmem.";
  const stopPx = s.lo ? Math.max(s.lo, s.close * 0.93) : s.close * 0.93;
  const plan = `Giriş ${fmt(s.close)} TL civarı; stop ${fmt(stopPx)} TL (gün içi dip ya da −%7, hangisi yakınsa; fiyatın ${pc((stopPx / s.close - 1) * 100)} altı). Pozisyon, sermayenin %1'i riske girecek şekilde boyutlanır. +%10'da yarısını satar (scale out), kalanı takip eden stopla taşır; en geç 8 iş gününde çıkar. Kaybı hızla keser, zarardaki pozisyona eklemez.`;
  return {v, score: k.score, checks, t: t + (dgK && dgK.block ? ` Derinlik kapısı: kırılım teyitsiz (${dgK.reasons.join("; ")}).` : ""), plan, stopPx, depth: dgK};
}

/* =====================================================================================
   ŞEYTANIN AVUKATI (Munger tarzı tersine çevirme + risk yöneticisi): "Bu hisse nasıl para kaybettirir?" diye sorar,
   kontrol listesiyle hataları önler, psikolojik tuzakları (kovalama/FOMO, sürü) işaretler. Pozisyonu stop mesafesinden boyutlar.
   Veto: bilanço eşiğinde, çıkış likiditesi zayıfken ya da stop olasılığı aşırıyken işlemi durdurur. */
function devil(s, others) {
  const mc = monteCarlo(s), n = NEWS[s.name], h = HIST && HIST.stocks[s.name], sg = mc ? mc.sigma : s.atrPct;
  const secN = current.filter(x => x.sector === s.sector).length;
  const days = s.nextEarn ? (s.nextEarn * 1000 - NOW) / 864e5 : null, exd = s.exDiv ? (s.exDiv * 1000 - NOW) / 864e5 : null;
  const stopPct = s.atrPct != null ? 2 * s.atrPct : null, maxPos = stopPct ? Math.min(100, 100 / stopPct) : null;
  const exitDays = s.tl > 0 ? (R.dPos / 1000) / (0.1 * s.tl) : null; // pozisyonu günlük hacmin %10'u ile kaç günde satarım
  const pos = others ? others.filter(o => o.v > 0).length : 0, neg = others ? others.filter(o => o.v < 0).length : 0;
  const checks = [
    chk(mc ? mc.probStop < R.dStop : null, `${mc ? mc.days : R.mDays} günde %${R.mStop} stop'a değme olasılığı < %${R.dStop}`, mc ? pc(mc.probStop) : "–"),
    chk(sg == null ? null : sg <= R.dAtr, `Günlük oynaklık ≤ %${R.dAtr}`, pc(sg)),
    chk(exitDays == null ? null : exitDays <= 1, `Çıkış likiditesi: ${R.dPos} bin TL'yi günlük hacmin %10'uyla ≤ 1 günde satabilirim`, exitDays == null ? "–" : `${fmt(exitDays, 2)} gün (hacim ${fmt(s.tl, 0)} mn TL)`),
    chk(s.smaDist >= -5, "Fiyat SMA50'nin %5'ten fazla altında değil", pc(s.smaDist)),
    chk(s.l52 ? s.close >= 1.1 * s.l52 : null, "52 hafta dibine %10'dan fazla uzak (dipte değil)", s.l52 ? pc((s.close / s.l52 - 1) * 100) : "–"),
    chk(h && h.dd250 != null ? h.dd250 >= -R.dMaxDd : null, `Son 1 yılda maks. düşüş ≤ %${R.dMaxDd}`, h && h.dd250 != null ? pc(h.dd250) : "–"),
    chk(s.pe == null ? null : s.pe > 0, "Şirket kâr ediyor (F/K tanımlı)", fmt(s.pe, 1)),
    chk(n && n.ok ? n.score > -2 : null, "Haber akışı olumsuz değil", n && n.ok ? `skor ${n.score}` : "haber yok"),
    chk(secN <= R.dSector, `Sektör yoğunlaşması: aynı sektörden ≤ ${R.dSector} aday`, `${secN} aday`),
    chk(s.p1m == null ? null : s.p1m <= R.dFomo, `Kovalama (FOMO) değil: son 1 ayda ≤ %${R.dFomo} yükselmiş`, pc(s.p1m)),
    chk(s.rsi == null ? null : s.rsi <= 80, "RSI aşırı alımda değil (≤ 80)", fmt(s.rsi, 0)),
    chk(days == null ? null : !(days >= -1 && days <= 5), "Yaklaşan bilanço yok (5 gün içinde): sürpriz riski", days == null ? "–" : days < -1 ? "geçti" : `${fmt(days, 0)} gün sonra (tahmini)`),
    chk(exd == null ? null : !(exd >= 0 && exd <= 3), "Temettü kesim tarihi yakın değil (fiyat düşer)", exd == null ? "–" : `${fmt(exd, 0)} gün`),
    chk(REGIME ? REGIME.trend !== "bear" : null, "Piyasa rejimi ayı değil", REGIME ? REGIME.label : "–"),
    chk(s.beta == null ? null : s.beta <= 1.3, "Piyasa duyarlılığı (beta) ≤ 1,3", s.beta == null ? "–" : fmt(s.beta, 2)),
    chk(others ? !(pos >= 2 && neg >= 1) : null, "Efsaneler arasında uzlaşmazlık yok (karar bölünmüş değil)", others ? `${pos} olumlu / ${neg} olumsuz` : "–"),
  ];
  const k = tally(checks), bads = checks.filter(c => c.s === BAD);
  const severe = [];
  if (days != null && days >= -1 && days <= 2) severe.push("bilanço 2 gün içinde");
  if (exitDays != null && exitDays > 2) severe.push("çıkış likiditesi çok zayıf");
  if (mc && mc.probStop >= 65) severe.push("stop olasılığı aşırı yüksek");
  const stx = stressOf(s); if (stx && !stx.ok && (R.stressVeto ?? 1)) severe.push("kara kuğu stres testini geçemedi");
  const veto = severe.length > 0;
  const v = veto || bads.length >= R.dFlags ? -1 : 0;
  const t = veto ? `VETO: ${severe.join("; ")}. Bu koşulda işlem yapılmaz; tersini düşünün, bu pozisyon nasıl para kaybettirir? Tam da buradan.`
    : bads.length ? `Tersini düşündüm: bu hisse şunlarla para kaybettirir → ${bads.slice(0, 3).map(c => c.t.replace(/ \(.*?\)/g, "").replace(/:.*$/, "")).join("; ")}.${v < 0 ? " Karşı çıkıyorum." : " Henüz itiraz sınırında değil; ama izliyorum."}`
    : "Tersini düşündüm ve belirgin bir batma nedeni bulamadım. Yine de makro şokta (kur, faiz, jeopolitik) korelasyonlar 1'e gider; pozisyon küçük olsun.";
  const plan = stopPct ? `Stres testi: ATR stopu (2×ATR) ≈ %${fmt(stopPct, 1)}. Sermayenin %1'ini riske atma kuralıyla azami pozisyon ≈ portföyün %${fmt(maxPos, 1)}. −%10 gap açarsa zarar portföyün ≈ %${fmt(maxPos * 0.1, 2)}'i. ${veto ? "Veto sürdükçe pozisyon açılmaz." : ""}`
    : "ATR verisi yok; stres testi yapılamadı.";
  const mcx = mc ? ` Monte Carlo (${mc.n.toLocaleString("tr-TR")} senaryo, ${mc.days} gün): en kötü %5 senaryonun ortalaması (CVaR) %${fmt(mc.cvar5, 1)}; %${mc.stop} stop'a değme olasılığı %${fmt(mc.probStop, 0)}; Sharpe (tarafsız sürüklenme) ${fmt(mc.sharpe0, 2)}.` : "";
  const stp = stx ? ` ${stx.text}${maxPos && stx.worst < 0 ? ` En kötü senaryoda, önerilen azami pozisyonla portföye etkisi ≈ −%${fmt(maxPos * Math.abs(stx.worst) / 100, 2)}.` : ""}` : "";
  return {v, score: k.score, checks, t, plan: plan + mcx + stp, veto, severe, maxPos, stopPct, cvar5: mc ? mc.cvar5 : null, stress: stx};
}

/* =====================================================================================
   GENİŞLETİLMİŞ KURUL: 4 yeni uzman (Makro & Jeopolitik, Akıllı Para, Opsiyon & Volatilite, Piyasa Psikolojisi).
   ÖNEMLİ: Elimizde gerçek takas/aracı kurum (AKD) verisi, opsiyon zımni oynaklığı ve sosyal medya verisi YOKTUR; uzmanlar fiyat-hacim-makro VEKİLLERİYLE çalışır
   ve vekiller geçmişte test edilmiştir (kurul2_research.json, macro_research.json). Bir uzman yalnızca kanıtı ters çıkmayan sinyalle oy kullanır.
   Araştırma bulguları (BIST 2023-26): panik satışları ve "ayı tuzağı" sıçramaları DEVAM etti (düşen bıçak); dağıtım ve para çıkışı olumsuz sinyaldi; aşırı uzama
   (z-skor > 2,5) ortalamaya DÖNMEDİ (momentum sürdü); makro risk-off bayrakları BIST'in sonraki getirisini düşürmedi (nominal TL piyasasında kur şoku dönemlerinde hisseler yükseldi).
   Yeni uzmanların oyları mevcut komite skoruna KARIŞMAZ (sanal portföylerin kaydı bozulmasın); net oy ve itiraz vetosu ayrıca gösterilir. */
let KUR2 = null, MACRO_R = null; // kurul2_research.json, macro_research.json (tarayıcı yükler)
let VIOP = null, VIOP_R = null, NMOOD = null, GEO = null, AKD_USER = null, AKD_VOTE = false; // viop.json (vadeli prim), viop_research.json, newsmood.json (Google Haberler), geo.json (GDELT), kullanıcıya özel AKD/takas özeti
const k2sig = id => KUR2 && KUR2.signals ? KUR2.signals[id] : null;
const k2ev = id => { const e = k2sig(id); if (!e || !e.h10) return "kanıt yok"; return `${e.verdict}: 10g ${e.h10.excess > 0 ? "+" : ""}${fmt(e.h10.excess, 2)}% (t ${fmt(e.h10.t, 1)}, n ${e.h10.n})`; };
const k2bad = id => { const e = k2sig(id); return !!(e && e.verdict === "ters kanıt"); };   // sinyalin tersi doğru çıktı
const k2good = id => { const e = k2sig(id); return !e || e.verdict !== "ters kanıt"; };        // kanıt yoksa ya da ters değilse kullanılabilir

function macroShield() {
  const m = (HIST && HIST.macro) || {}, items = [], push = (id, name, val, on, hint) => items.push({id, name, val, on: !!on, hint});
  const has = k => m[k] != null;
  push("usdtry5", "Dolar/TL 5 günde", has("usdtry_d5") ? `%${fmt(m.usdtry_d5, 1)}` : "–", m.usdtry_d5 > 3, "Kur şoku (eşik > %3)");
  push("vix", "VIX (korku endeksi)", has("vix") ? fmt(m.vix, 1) : "–", m.vix > 25, "Küresel risk iştahı (eşik > 25)");
  push("brent", "Brent petrol 20 günde", has("brent_d20") ? `%${fmt(m.brent_d20, 1)}` : "–", m.brent_d20 > 15, "Enerji maliyeti şoku (eşik > %15)");
  push("dxy", "Dolar endeksi 20 günde", has("dxy_d20") ? `%${fmt(m.dxy_d20, 1)}` : "–", m.dxy_d20 > 2, "Güçlü dolar: gelişen piyasa baskısı (eşik > %2)");
  push("gold", "Altın 20 günde", has("gold_d20") ? `%${fmt(m.gold_d20, 1)}` : "–", m.gold_d20 > 6, "Sığınma talebi (eşik > %6)");
  push("tr10", "TR 10 yıllık faiz 20 günde", has("rf10_d20") ? `${m.rf10_d20 > 0 ? "+" : ""}${fmt(m.rf10_d20, 1)} puan` : "–", m.rf10_d20 > 1.5, "Yerel faiz şoku (eşik > +1,5 puan)");
  push("us10", "ABD 10 yıllık faiz 20 günde", has("us10y_d20") ? `${m.us10y_d20 > 0 ? "+" : ""}${fmt(m.us10y_d20, 2)} puan` : "–", m.us10y_d20 > 0.3, "Küresel faiz baskısı (eşik > +0,3 puan)");
  const count = items.filter(x => x.on).length, inverted = has("rf2") && has("rf10") && m.rf2 > m.rf10;
  const level = count >= 4 ? "Şiddetli" : count >= 3 ? "Yüksek" : count >= 2 ? "Orta" : "Düşük";
  const cn = MACRO_R && MACRO_R.count ? MACRO_R.count[String(Math.min(count, 3))] : null;
  const geo = macroNewsHeat(), gn = GEO && GEO.now ? GEO.now : null, nj = NMOOD && NMOOD.market && NMOOD.market.jeo ? NMOOD.market.jeo : null;
  geo.gdelt = gn; geo.news = nj;
  const gc = MACRO_R && MACRO_R.conds ? MACRO_R.conds["gdelt_ton_ve_hacim_sok"] : null;
  geo.evidence = gc && gc.diff20 != null ? `Geçmişte GDELT ton+hacim şoku olduğunda BIST 100 sonraki 20 günde ${gc.on20 > 0 ? "+" : ""}${fmt(gc.on20, 1)}% (olmadığında ${fmt(gc.off20, 1)}%), t ${fmt(gc.t20, 1)}.` : "Jeopolitik ton şokunun geçmiş testi yok/yetersiz.";
  geo.shock = !!(gn && gn.tone_z30 != null && gn.tone_z30 <= -1 && gn.vol_z30 != null && gn.vol_z30 >= 1);
  return {items, count, level, inverted, live: !!m.date, date: m.date || null, geo, evidence: cn ? `Geçmişte (${MACRO_R.from} → ${MACRO_R.to}) ${count >= 3 ? "3+" : count} bayrak olduğunda BIST 100 sonraki 20 günde ortalama ${cn.ret20 > 0 ? "+" : ""}${fmt(cn.ret20, 1)}% getirdi (n ${cn.n}, isabet %${fmt(cn.hit, 0)}).` : "Geçmiş test verisi yüklenmedi."};
}
/* Jeopolitik: veri kaynağı yok; likit hisse haberlerinde son 3 günde jeopolitik/makro anahtar kelime yoğunluğu (zayıf vekil) */
function macroNewsHeat() {
  const re = /savaş|saldırı|yaptırım|gerilim|çatışma|abluka|ateşkes|seçim|kriz|faiz kararı|enflasyon|merkez bankası|tcmb|fed |opec/;
  let n = 0, tot = 0; const now = (typeof NOW === "number" ? NOW : Date.now()) / 1000;
  Object.values(NEWS || {}).forEach(v => (v.items || []).forEach(i => { if (now - i.ts < 3 * 86400) { tot++; if (re.test(trLower(i.t))) n++; } }));
  return {n, tot};
}
function macroP(s) {
  const sh = macroShield(), beta = s.beta, hi = beta != null && beta > 1.2;
  const stx = stressOf(s), stFail = !!(stx && !stx.ok && (R.stressVeto ?? 1));
  const veto = stFail || !!(R.makroVeto && sh.count >= R.makroN);
  const v = veto ? -1 : 0;
  const checks = sh.items.map(x => chk(x.on ? false : (x.val === "–" ? null : true), `${x.name}: ${x.hint}`, x.val)).concat([
    chk(stx ? stx.ok : null, "Kara kuğu stres testi (BIST çöküşü, kur şoku, +500 baz puan faiz, döviz açık pozisyonu): geçti", stx ? stx.text : "duyarlılık/bilanço verisi yok"),
    chk(sh.inverted ? false : true, "Getiri eğrisi normal (2 yıllık < 10 yıllık)", sh.inverted ? "ters: kısa vade faizi uzundan yüksek" : "normal"),
    chk(beta == null ? null : !hi, "Piyasa duyarlılığı (beta) ≤ 1,2: makro şokta hisse fazla savrulmaz", beta == null ? "–" : fmt(beta, 2))]);
  const t = stFail ? `ONAY VERMİYORUM: ${stx.text} Makro şokta bu hisse sınırı aşıyor; alım onayı yok.` : sh.count >= 3
    ? `Dikkat: makro tablo ${sh.level.toLowerCase()} risk gösteriyor (${sh.count}/7 bayrak). Ama sayılara dürüst olalım: ${sh.evidence} Bu piyasada kur şoku dönemlerinde hisse enflasyon ve kur koruması gibi davranıyor; bu yüzden ${veto ? "vetomu açtım" : "alım vetosu koymuyorum"}, yalnızca pozisyonu küçültmenizi öneririm${hi ? "; üstelik bu hisse yüksek betalı" : ""}.`
    : sh.count === 2 ? `Makro tablo orta düzeyde karışık (${sh.count}/7 bayrak). Büyük resim alım kararını engellemiyor ama haber akışını izleyin; ${sh.evidence}`
    : `Makro tabloda belirgin bir stres yok (${sh.count}/7 bayrak${sh.inverted ? "; getiri eğrisi ters, para sıkı" : ""}). ${sh.geo.tot ? `Son 3 günün haberlerinin ${sh.geo.n}/${sh.geo.tot}'i jeopolitik/makro konulu (zayıf bir gösterge).` : ""} Rüzgâr ne lehe ne aleyhte; karar hissenin kendi hikâyesine kalıyor.`;
  const plan = sh.count >= 3 ? "Pozisyon boyutunu normalin yarısına indirin; stop'u önceden belirleyin; yeni alımları kademeli yapın." : "Makro nedeniyle ek bir kısıt yok; her zamanki risk kuralları geçerli.";
  return {v, score: tally(checks).score, checks, t, plan: stFail ? "Stres testini geçene kadar yeni alım yok; mevcut pozisyonu küçültün." : plan, shield: sh, veto, stress: stx};
}

/* Z-skor, ortalamaya dönüş yarı ömrü (AR(1)) ve oynaklık sıkışması; HIST kapanışlarından */
function volStats(s) {
  const h = HIST && HIST.stocks && HIST.stocks[s.name], c = h && h.closes && h.closes.length >= 90 ? h.closes.slice(-130) : null;
  const sd = s.bb_upper != null && s.bb_lower != null ? (s.bb_upper - s.bb_lower) / 4 : null;
  const z20 = sd > 0 && s.sma20 > 0 ? (s.close - s.sma20) / sd : null;
  let half = null, ratio = null, z60 = null;
  if (c) {
    const n = c.length, zs = [];
    for (let i = 20; i < n; i++) { const w = c.slice(i - 19, i + 1), m = w.reduce((a, b) => a + b, 0) / 20, sdv = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / 20); zs.push(sdv > 0 ? (c[i] - m) / sdv : 0); }
    const z = zs.slice(-61); let sxy = 0, sxx = 0; for (let i = 1; i < z.length; i++) { sxy += z[i] * z[i - 1]; sxx += z[i - 1] ** 2; }
    const b = sxx > 0 ? Math.min(0.995, Math.max(0.05, sxy / sxx)) : null; half = b ? -Math.LN2 / Math.log(b) : null;
    const r = c.slice(1).map((v, i) => v / c[i] - 1), sig = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
    const s5 = sig(r.slice(-5)), s60 = sig(r.slice(-60)); ratio = s60 > 0 ? s5 / s60 : null;
    const w60 = c.slice(-60), m60 = w60.reduce((a, b) => a + b, 0) / 60, sd60 = Math.sqrt(w60.reduce((a, b) => a + (b - m60) ** 2, 0) / 60); z60 = sd60 > 0 ? (s.close - m60) / sd60 : null;
  }
  return {z20, z60, half, ratio};
}
function volP(s, simonsVote) {
  const vs = volStats(s), tr = trendUp(s) === true, z = vs.z20;
  const healthy = z != null && z > 0.5 && z < 1.8 && tr, squeeze = vs.ratio != null && vs.ratio < 0.5 && tr, knife = z != null && z < R.zLo && !tr, stretched = z != null && z > R.zHi;
  let v = 0; if ((healthy && k2good("z_ort_trend")) || (squeeze && k2good("vol_sikisma"))) v = 1; else if (knife && k2bad("z_asiri_alt")) v = -1;
  const checks = [
    chk(z == null ? null : Math.abs(z) < R.zHi, `Z-skor (20 gün) aşırı değil (|z| < ${R.zHi})`, z == null ? "–" : fmt(z, 2)),
    chk(z == null ? null : healthy ? true : null, "Sağlıklı trend: z-skor 0,5-1,8 ve yükselen trend", healthy ? "evet · " + k2ev("z_ort_trend") : "hayır"),
    chk(vs.ratio == null ? null : squeeze ? true : null, "Oynaklık sıkışması: son 5 gün σ < 0,5 × 60 gün σ ve trend yukarı", vs.ratio == null ? "–" : `${fmt(vs.ratio, 2)}x${squeeze ? " · " + k2ev("vol_sikisma") : ""}`),
    chk(z == null ? null : !knife, `Düşen bıçak değil: z-skor < ${R.zLo} ve trend aşağı olmasın`, knife ? "evet · " + k2ev("z_asiri_alt") : "hayır"),
    chk(vs.half == null ? null : null, "Ortalamaya dönüş yarı ömrü (AR(1), 60 gün)", vs.half == null ? "–" : `${fmt(vs.half, 1)} gün`),
    chk(null, "Zımni oynaklık (opsiyon): veri kaynağı yok", "gerçekleşen oynaklık kullanıldı")];
  let stance = "tarafsız", reply;
  if (simonsVote > 0) {
    if (v > 0) { stance = "destekler"; reply = `Jim'in modelini destekliyorum: z-skor ${fmt(z, 2)}, trend sağlıklı${squeeze ? ", üstüne oynaklık sıkışmış" : ""}. Aşırı uzama yok; model pozitifken risk de makul.`; }
    else if (stretched) { stance = "çürütmez"; reply = `Z-skor ${fmt(z, 2)}: aşırı uzamış görünüyor ama Jim'in modelini çürütmüyorum. Hesapladım: BIST'te z > 2,5 sonrası ortalamaya dönüş yok (${k2ev("z_asiri_ust")}); yani "çok uzadı, satın" demek veriyle desteklenmiyor. Sadece stop'u sıkı tutun.`; }
    else if (knife) { stance = "çürütür"; reply = `Jim, modelin pozitif ama z-skor ${fmt(z, 2)} ve trend aşağı: düşen bıçak. Geçmişte bu koşulda hisse piyasanın gerisinde kaldı (${k2ev("z_asiri_alt")}). Modeli çürütüyorum.`; }
    else { reply = `Z-skor ${z == null ? "–" : fmt(z, 2)}: modelin işaretiyle çelişen bir sapma görmüyorum; ne destek ne itiraz.`; }
  } else if (simonsVote < 0) { reply = knife ? `Jim'le aynı fikirdeyim: z-skor ${fmt(z, 2)}, trend aşağı. Aşırı satım bile alım sinyali değil; geçmişte düşüş sürdü.` : `Jim'in modeli negatif; z-skor ${z == null ? "–" : fmt(z, 2)}, ben bir karşı argüman bulamadım.`; }
  else reply = `Model nötr. Z-skor ${z == null ? "–" : fmt(z, 2)}${vs.half != null ? `, yarı ömür ${fmt(vs.half, 1)} gün` : ""}; sayılarda belirgin bir uç yok.`;
  const t = `Rakamlara bakıyorum: z-skor ${z == null ? "–" : fmt(z, 2)}${vs.z60 != null ? ` (60 günde ${fmt(vs.z60, 2)})` : ""}, 5g/60g oynaklık oranı ${vs.ratio == null ? "–" : fmt(vs.ratio, 2)}. ${v > 0 ? "Sağlıklı, sıkışmış bir trend: geçmişte iyi sonuç veren bir yapı." : v < 0 ? "Düşen bıçak: ortalamaya dönüş umudu geçmişte kaybettirdi." : "Ayırt edici bir uç yok."} (Not: opsiyon zımni oynaklığı yok, gerçekleşen oynaklık kullanıyorum.)`;
  return {v, score: tally(checks).score, checks, t, plan: v < 0 ? "Düşen bıçağı tutmayın; trend dönene kadar bekleyin." : "Oynaklık stop'unu (2,5×ATR) kullanın; z-skor 2,5'ı aşarsa pozisyonu büyütmeyin.", vs, stance, reply, stretched, knife, healthy};
}
function akilliP(s) {
  const cmf = s.cmf, cmfw = s.cmf_w, rv = s.rvol, ch = s.change, tr = trendUp(s) === true, vt = s.av10 > 0 && s.av60 > 0 ? s.av10 / s.av60 : null;
  const dist = rv != null && rv >= 2 && ch != null && Math.abs(ch) <= 1.5 && cmf != null && cmf < -0.1, acc = rv != null && rv >= 2 && ch != null && Math.abs(ch) <= 1.5 && cmf != null && cmf > 0.1;
  const strong = cmf != null && cmf > 0.15 && tr, weak = cmf != null && cmf < -0.15;
  let v = 0; if (strong && k2good("cmf_guclu")) v = 1; else if ((weak && k2bad("cmf_zayif")) || (dist && k2bad("dagitim"))) v = -1;
  // VİOP vadeli primi (taşıma maliyeti düşülmüş fazla prim): vadelide alıcı/satıcı iştahı. Oy yalnızca geçmiş testte (viop_research.json) kanıtlıysa.
  const vp = VIOP && VIOP.stocks ? VIOP.stocks[s.name] : null, vf = VIOP_R && VIOP_R.factors ? VIOP_R.factors.fazla_prim : null, vst = VIOP_R && VIOP_R.stats;
  let viopTxt = "", viopV = 0;
  if (vp) {
    const hi = vst && vp.excess >= vst.p90, lo = vst && vp.excess <= vst.p10;
    if (vf && vf.verdict === "kanıt var") viopV = hi ? 1 : lo ? -1 : 0; else if (vf && vf.verdict === "ters kanıt") viopV = hi ? -1 : lo ? 1 : 0;
    viopTxt = `Vadelide fazla prim %${fmt(vp.excess, 2)} (ham prim %${fmt(vp.basis, 2)}, vade ${VIOP.expiry}; hisse vadeli hacmi ${fmt(vp.vol_ratio, 1)}x)`;
  }
  const au = AKD_USER ? AKD_USER[s.name] : null; // kullanıcı CSV (Matriks vb.): doğrulanamaz; çok günlük takas filtresi yalnızca kullanıcı "oya kat" derse oyu etkiler
  const ast = akdState(au, s);
  if (AKD_VOTE && ast && ast.strong && ast.days >= 3) { if (ast.dir > 0 && v === 0) v = 1; else if (ast.dir < 0) v = v > 0 ? 0 : -1; }
  if (viopV !== 0 && v === 0) v = viopV; else if (viopV < 0 && v > 0) v = 0;
  const dpA = DEPTH_USER ? DEPTH_USER[s.name] : null; if (DEPTH_GATE && dpA && dpA.block.length && v > 0) v = 0; // tahta teyit etmiyorsa (sahte duvar, satış duvarı, satıcı ağırlığı) para girişi oyu verilmez // vadeli olumsuz ise kuvvetli CMF oyunu nötrle
  const checks = [
    chk(dpA ? (dpA.block.length ? false : true) : null, "Tahta derinliği (Level-2): sahte duvar/spoofing yok, satış duvarı ve satıcı baskısı yok", dpA ? dpA.text + (DEPTH_GATE ? " · kapı açık" : " · bilgi (kapı kapalı)") : "tahta verisi yok (Özel Veri sayfasından yükleyin)"),
    chk(vp ? (viopV > 0 ? true : viopV < 0 ? false : null) : null, "Vadeli (VİOP) pozisyonlanma: taşıma maliyeti düşülmüş fazla prim", vp ? `${viopTxt} · ${vf ? vf.verdict : "test yok"}` : "bu hissenin vadelisi yok"),
    chk(ast ? (ast.dir > 0 ? true : ast.dir < 0 ? false : null) : null, "Takas filtresi: mal toplanıyor mu (birikim) boşaltılıyor mu (dağıtım)? Çok günlük AKD + takas saklama", ast ? ast.text + (AKD_VOTE ? " · oya katıldı" : " · bilgi (oya katılmadı)") : "yeterli gün yok (≥ 2 günlük AKD içe aktarın)"),
    chk(au ? (au.bal > 0.05 ? true : au.bal < -0.05 ? false : null) : null, "Kullanıcı AKD verisi: ilk 5 alıcı − ilk 5 satıcı dengesi (toplam hacme oranı)", au ? `${au.d}: %${fmt(au.bal * 100, 1)} (alıcı yoğunlaşması %${fmt(au.conc * 100, 1)})${au.foreign != null ? ", yabancı oranı %" + fmt(au.foreign, 1) : ""} · kullanıcı verisi, doğrulanamadı` : "içe aktarılmadı (Özel Veri sayfası)"),
    chk(cmf == null ? null : cmf > 0, "Para akışı (CMF günlük) pozitif: alıcı baskın", cmf == null ? "–" : fmt(cmf, 2)),
    chk(cmfw == null ? null : cmfw > 0, "Haftalık para akışı pozitif: birikim sürüyor", cmfw == null ? "–" : fmt(cmfw, 2)),
    chk(strong ? true : null, "Güçlü para girişi: CMF > 0,15 ve yükselen trend", strong ? "evet · " + k2ev("cmf_guclu") : "hayır"),
    chk(weak ? false : null, "Para çıkışı: CMF < −0,15", weak ? "evet · " + k2ev("cmf_zayif") : "hayır"),
    chk(dist ? false : null, "Dağıtım: yüksek hacim, fiyat yerinde, CMF negatif", dist ? "evet · " + k2ev("dagitim") : "hayır"),
    chk(acc ? true : null, "Emilim (birikim): yüksek hacim, fiyat yerinde, CMF pozitif", acc ? "evet · " + k2ev("birikim") + " (kanıtsız)" : "hayır"),
    chk(vt == null ? null : vt >= 1, "Hacim eğilimi (10g/60g) ≥ 1: ilgi artıyor", vt == null ? "–" : fmt(vt, 2) + "x"),
    chk(s.ff == null ? null : s.ff >= 20, "Halka açıklık ≥ %20: tahtayı birkaç elin oynatması zor", s.ff == null ? "–" : "%" + fmt(s.ff, 0)),
    chk(null, "Aracı kurum dağılımı/takas (herkese açık): Borsa İstanbul lisanslı veri, ücretsiz kaynak yok", au ? "kullanıcı CSV'si kullanılıyor" : "vekiller: CMF, hacim, VİOP primi")];
  const t = (au && au.bal <= -0.08 ? `Kendi AKD verinizde ilk 5 satıcı baskın (%${fmt(au.bal * 100, 1)}): ` : au && au.bal >= 0.08 ? `Kendi AKD verinizde ilk 5 alıcı baskın (+%${fmt(au.bal * 100, 1)}): ` : "") + (viopV !== 0 ? `${viopTxt}: geçmişte bu uç ${viopV > 0 ? "olumlu" : "olumsuz"} sonuç verdi. ` : "") + (v > 0 ? `Tahtanın izini sürüyorum: CMF ${fmt(cmf, 2)}${cmfw != null ? ` (haftalık ${fmt(cmfw, 2)})` : ""} ve trend yukarı; para içeri giriyor. Geçmişte bu yapı piyasayı geçti (${k2ev("cmf_guclu")}). Kimin aldığını (aracı kurum/takas) göremiyorum, yalnızca parasal akışın yönünü.`
    : v < 0 ? `Tahta bana ${dist ? "dağıtım" : "para çıkışı"} gösteriyor: ${dist ? "hacim yüksek ama fiyat yerinde, CMF negatif: biri sessizce mal veriyor" : `CMF ${fmt(cmf, 2)}`}. Geçmişte bu sinyal olumsuz çıktı (${k2ev(dist ? "dagitim" : "cmf_zayif")}). Büyük oyuncunun kim olduğunu bilmiyorum ama yönü çıkışa bakıyor.`
    : acc ? `Hacim yüksek, fiyat yerinde, CMF pozitif: emilim izi var. Ama dürüst olayım, bu "birikim" sinyali geçmişte kanıtlanmadı (${k2ev("birikim")}); izleme listesine alırım.`
    : "Tahtada belirgin bir izi yok: ne güçlü bir para girişi ne de dağıtım var. Gerçek takas verisi olmadan daha fazlasını söylemem.");
  return {v, score: tally(checks).score, checks, t, vp, viopV, au, ast, depth: dpA, plan: v > 0 ? "Para girişi sürdükçe tutun; CMF negatife dönerse azaltın." : v < 0 ? "Yeni alım yapmayın; mevcut pozisyonda CMF'yi izleyin." : "Bekleyin: akış teyidi yok.", dist, acc, strong, weak};
}
/* Piyasa coşku/korku göstergesi (tüm piyasa): sosyal medya yerine fiyat davranışından */
function crowdMeter() {
  const u = UNIVERSE && UNIVERSE.length ? UNIVERSE.filter(x => x.ok && x.tl >= 5 && x.change != null) : [];
  if (!u.length) return null;
  const up = u.filter(x => x.change >= 3).length / u.length * 100, dn = u.filter(x => x.change <= -3).length / u.length * 100, tav = u.filter(x => x.change >= 9.5).length, tab = u.filter(x => x.change <= -9.5).length;
  const idx = Math.max(0, Math.min(100, 50 + (up - dn) * 2 + (tav - tab) * 0.6));
  return {idx, up, dn, tav, tab, label: idx >= 70 ? "AŞIRI COŞKU" : idx >= 58 ? "Coşkulu" : idx <= 30 ? "PANİK" : idx <= 42 ? "Korku" : "Dengeli"};
}
function psikoP(s) {
  const h = HIST && HIST.stocks && HIST.stocks[s.name], today = new Date().toISOString().slice(0, 10), c = h && h.closes && h.closes.length >= 30 ? h.closes : null;
  let brkUp = null, brkDn = null;
  if (c) { const incl = h.last === today, n = c.length, yest = incl ? c[n - 2] : c[n - 1], prior = incl ? c.slice(n - 22, n - 2) : c.slice(n - 21, n - 1); brkUp = yest > Math.max(...prior); brkDn = yest < Math.min(...prior); }
  const trapBull = brkUp === true && s.change <= -2 && s.rvol >= 1.5, trapBear = brkDn === true && s.change >= 2 && s.rvol >= 1.5;
  const fomoStrict = s.rsi > 78 && s.p1m > 25 && s.rvol >= 2, fomo = s.sma20 > 0 && (s.close / s.sma20 - 1) > 0.15 && s.rsi > 75;
  const panic = s.change <= -6 && s.rvol >= 2.5 && s.rsi < 30, cm = crowdMeter(), nm = NMOOD && NMOOD.stocks ? NMOOD.stocks[s.name] : null;
  let v = 0; if ((panic && k2bad("panik")) || (trapBear && k2bad("ayi_tuzagi"))) v = -1;
  const checks = [
    chk(fomoStrict ? false : null, "FOMO: RSI > 78, 1 ayda > %25, hacim ≥ 2x", fomoStrict ? "evet · " + k2ev("fomo") : "hayır"),
    chk(fomo ? false : null, "Aşırı coşku: SMA20'nin %15 üstünde ve RSI > 75", fomo ? "evet · " + k2ev("fomo_kismi") : "hayır"),
    chk(panic ? false : null, "Panik satışı: gün ≤ −%6, hacim ≥ 2,5x, RSI < 30", panic ? "evet · " + k2ev("panik") : "hayır"),
    chk(trapBull ? false : null, "Boğa tuzağı: dün 20g zirve kırılımı, bugün ≤ −%2 ve hacimli", brkUp == null ? "geçmiş yok" : trapBull ? "evet · " + k2ev("boga_tuzagi") : "hayır"),
    chk(trapBear ? false : null, "Ayı tuzağı sıçraması: dün 20g dip kırılımı, bugün ≥ +%2 ve hacimli", brkDn == null ? "geçmiş yok" : trapBear ? "evet · " + k2ev("ayi_tuzagi") : "hayır"),
    chk(cm ? !(cm.idx >= 70 || cm.idx <= 30) : null, "Piyasa geneli coşku/korku dengeli", cm ? `${cm.label} (${fmt(cm.idx, 0)}/100; tavan ${cm.tav}, taban ${cm.tab})` : "–"),
    chk(nm ? (nm.attn >= 3 && s.rsi > 70 ? false : null) : null, "Haber ilgisi (Google Haberler, son 24 saat / 7 gün ortalaması): ilgi patlaması + yüksek RSI = haber coşkusu", nm ? `${nm.n1} haber (7g: ${nm.n7}), ilgi ${fmt(nm.attn, 1)}x, ton ${nm.tone7 > 0 ? "+" : ""}${fmt(nm.tone7, 2)} · oy yok: geçmiş doğrulaması birikiyor` : "veri yok"),
    chk(null, "Sosyal medya ve yatırımcı forumları: ücretsiz/güvenilir kaynak yok", "fiyat davranışı ve haber ilgisi vekil")];
  const t = panic ? `Panik: hisse günde %${fmt(s.change, 1)} düştü, hacim ${fmt(s.rvol, 1)}x, RSI ${fmt(s.rsi, 0)}. Herkes çıkıyor, "dip" diye atlamak cazip. Verim ne diyor? Geçmişte böyle panikten sonra hisse 10 günde ortalama ${k2sig("panik") && k2sig("panik").h10 ? fmt(k2sig("panik").h10.excess, 1) : "?"}% daha geride kaldı: panik çoğu zaman devam ediyor. Düşen bıçağı tutmayın.`
    : trapBear ? `Dikkat, "ayı tuzağı" sıçraması: dün 20 günlük dibi kırdı, bugün %${fmt(s.change, 1)} sıçradı. Rahatlama gibi görünüyor ama geçmişte bu tür sıçramalar tutmadı (${k2ev("ayi_tuzagi")}). Teyit gelmeden güvenmeyin.`
    : trapBull ? `Olası boğa tuzağı: dün 20 günlük zirveyi kırdı, bugün %${fmt(s.change, 1)} geri verdi ve hacimli. Dürüst olayım: geçmişte bu tek başına anlamlı bir sinyal çıkmadı (${k2ev("boga_tuzagi")}); ama kırılımın tutmadığını not ediyorum, Livermore'un pivotu bu yüzden bozuldu.`
    : fomoStrict || fomo ? `Coşku var (RSI ${fmt(s.rsi, 0)}, SMA20'nin %${fmt((s.close / s.sma20 - 1) * 100, 0)} üstü). "Herkes alıyor" cümlesi beni ürkütür, ama veriye bakınca: BIST'te bu kadar coşkulu hisseler geçmişte çoğu zaman yükselmeye devam etti (${k2ev("fomo_kismi")}). Yani coşku tek başına satış nedeni değil; sadece geç kalmış alıcı olmayın.`
    : `Kalabalık davranışında uç bir işaret görmüyorum: ne FOMO ne panik ne de tuzak. Piyasa geneli: ${cm ? cm.label.toLowerCase() : "–"}. (Sosyal medyayı tarayamıyorum; yalnızca fiyat ve hacim davranışına bakıyorum.)`;
  return {v, score: tally(checks).score, checks, t, nm, plan: v < 0 ? "Teyit gelene kadar bekleyin; tuzak ya da panik sürüyorsa yeni alım yapmayın." : "Kalabalığa karşı çıkmak için bir neden yok; kendi planınıza sadık kalın.", panic, trapBull, trapBear, fomo: fomoStrict || fomo, crowd: cm};
}
const PERSONAS2_KEYS = ["makro", "akilli", "vol", "psiko"];
function committee(s) {
  const l = { buffett: buffett(s), simons: simons(s), livermore: livermore(s), kellogg: kellogg(s) };
  l.seytan = devil(s, Object.values(l));
  const score = Object.values(l).reduce((a, x) => a + x.v, 0), veto = l.seytan.veto;
  const label = score >= 3 && !veto ? "GÜÇLÜ ADAY" : score === 2 && !veto ? "ADAY" : score >= 1 ? "İZLE" : score >= -1 ? "NÖTR" : "UZAK DUR";
  let memo = null; const K = () => memo || (memo = (() => { const k2 = {makro: macroP(s), akilli: akilliP(s), vol: volP(s, l.simons.v), psiko: psikoP(s)}, net2 = PERSONAS2_KEYS.reduce((a, k) => a + k2[k].v, 0); return {k2, net2, veto2: !!((R.k2veto && net2 <= -2) || k2.makro.veto)}; })());
  return { l, score, label, veto, get k2() { return K().k2; }, get net2() { return K().net2; }, get veto2() { return K().veto2; } }; // yeni uzmanlar tembel hesaplanır
}

/* ---------- Masa toplantısı: efsaneler birbirine yanıt verir (her cümle verideki bir sonuca bağlıdır) ---------- */
function pickOne(arr, s) { return arr[hash(s.name) % arr.length]; }
function meeting(s, r) {
  const L = r.l, lines = [], say = (who, text) => lines.push({who, text});
  const sm = L.simons, lv = L.livermore, kl = L.kellogg, bf = L.buffett, dv = L.seytan;
  say("simons", sm.v > 0 ? `${s.name} için modelim pozitif: RS dilimi ${sm.dec != null ? sm.dec + 1 : "–"}/10, beklenen fazla getiri ${sm.exp != null ? (sm.exp > 0 ? "+" : "") + fmt(sm.exp, 2) + "%" : "–"} (10 gün). Önerilen ağırlık %${fmt(sm.w, 1)}.`
    : sm.v < 0 ? `${s.name}: model negatif. ${sm.t}` : `${s.name}: modelde ayırt edilebilir bir avantaj yok. Beklenti ${sm.exp != null ? fmt(sm.exp, 2) + "%" : "–"}; eşik altı.`);
  say("livermore", lv.v > 0 ? pickOne([`Tape güçlü. ${s.name} liderlerden biri, pivot ${fmt(lv.pivot)} civarında. Küçük bir test alımıyla başlarım, hisse bana doğru yürürse eklerim.`, `Hisse piyasadan güçlü ve en az direnç yönünde ilerliyor. Pivot ${fmt(lv.pivot)}; teyit var, beklemek için sebebim yok.`], s)
    : lv.v < 0 ? `Bu hisse düşen tarafta. ${s.name}'de ucuzluk aramam; trend dönmeden bıçağı tutmam.` : `${s.name}'de net bir giriş noktası görmüyorum. Pivotu bekler, o zamana kadar oturur izlerim.`);
  if (bf.v <= 0 && (lv.v > 0 || kl.v > 0 || sm.v > 0)) say("buffett", bf.v < 0 ? `${s.name} bana göre bir işletme olarak zayıf${bf.mos != null && bf.mos < 0 ? " ve pahalı" : ""}. Fiyat yükseliyor diye değer artmıyor.` : `İşletme fena değil ama fiyat bana güvenlik marjı bırakmıyor${bf.mos != null ? ` (%${fmt(bf.mos, 0)})` : ""}. Ben beklemekten rahatsız olmam.`);
  else say("buffett", bf.v > 0 ? `Bu bir işletme gibi görünüyor: kalite ölçütleri iyi ve adil değere göre %${fmt(bf.mos, 0)} iskonto var. ${fmt(bf.cap)} TL altında alırım ve unuturum.` : `${s.name} benim ilgi alanımın dışında ya da tablo net değil; pas geçiyorum.`);
  if (bf.v <= 0 && lv.v > 0) say("livermore", "Warren, tape fiyatın değer olup olmadığıyla ilgilenmez; yalnızca nereye gittiğini söyler. Ben yönü izliyorum, sen işletmeyi izliyorsun; ikimiz de haklı olabiliriz.");
  if (bf.v <= 0 && sm.v > 0) say("simons", "Şirketin ne sattığını bilmiyorum, bilmem de gerekmiyor. Bu örüntü geçmişte kazandırdı; modelim bu kadarını söylüyor.");
  say("kellogg", kl.v > 0 ? `Hacim ${fmt(s.rvol, 1)}x ve fiyat %${fmt(s.change, 1)} gidiyor. Hızlı hareket burada. Stop ${fmt(kl.stopPx)} TL; yarısını +%10'da satar, kalanı taşırım.`
    : kl.v < 0 ? "Hacimli düşüş var; bu satıcı baskısı. Ben uzağım." : `Benim için ${s.name}'de hacim ve kırılım birlikte yok; ilgi çekmeyen yerde vakit harcamam.`);
  say("seytan", dv.veto ? `Durun. ${dv.severe.join(" ve ")}. Bu koşulda işlem olmaz.` : dv.v < 0 ? `Tersini düşünelim: ${s.name} nasıl para kaybettirir? ${dv.checks.filter(c => c.s === BAD).slice(0, 3).map(c => c.t.replace(/ \(.*?\)/g, "").replace(/:.*$/, "")).join("; ")}. Karşıyım.`
    : `Tersini düşündüm; büyük bir batma nedeni görmüyorum. Ama pozisyon, stop mesafesine göre en çok %${fmt(dv.maxPos, 1)} olsun.`);
  if (bf.audit && bf.audit.text && (bf.audit.verdict === "ZAYIF BİLANÇO" || bf.audit.verdict === "DİKKAT" || bf.v > 0)) lines.push({who: "buffett", text: bf.audit.text, gen: true});
  if (sm.mcs && sm.v !== 0) { const mq = monteCarlo(s); if (mq) lines.push({who: "simons", text: `Simülasyona baktım (${mq.n.toLocaleString("tr-TR")} senaryo, ${mq.days} gün): model beklentisiyle Sharpe ${fmt(sm.mcs.sharpe, 2)}, bilgi oranı ${fmt(sm.mcs.ir, 2)}; en kötü %5 senaryonun ortalaması %${fmt(mq.cvar5, 1)}. ${sm.mcs.sharpe > 0.3 ? "Risk/ödül makul." : "Sharpe düşük: avantaj gürültüye yakın, küçük pozisyon."}`, gen: true}); }
  if (sm.v > 0) { const kp = kellyPlan(s, 100000); if (kp) lines.push({who: "simons", text: `${kp.text}${kp.edge ? ` Başlangıç stop ${fmt(kp.stop0)} TL, hedef ${fmt(kp.target)} TL; +1R'den sonra ${fmt(kp.k, 1)}×ATR izleyen stop.` : ""}`, gen: true}); }
  if (dv.stress && !dv.stress.ok) lines.push({who: "seytan", text: `REDDEDİYORUM: ${dv.stress.text}`, gen: true});
  const snt = stockSentiment(s.name); if (snt && snt.n >= 2 && Math.abs(snt.score) >= 0.25) lines.push({who: "psiko", text: `Haber akışı (KAP/basın başlıkları, son 3 gün, ${snt.n} başlık${snt.kap ? ", " + snt.kap + " tanesi KAP/özel durum türü" : ""}): duygu skoru ${snt.score > 0 ? "+" : ""}${fmt(snt.score, 2)} (${snt.label}). En belirgin başlık: "${snt.top}". Sözlük tabanlı bir okuma, oy değildir; başlıkları kendiniz de okuyun.`, gen: true});
  const mt = s.mtf, tier = mtfTier(s), mexp = mtfExpect(s);
  if (tier && (tier.id === "uyumlu" || tier.id === "hlider")) {
    say("simons", `Çok zamanlı tabloya bakın: günlük ${fmt(mt.d, 0)}, haftalık ${fmt(mt.w, 0)}, aylık ${fmt(mt.m, 0)}. Haftalık skoru bu dilimdeki hisseler geçmişte 20 günde piyasanın ortalamasının ${mexp != null ? (mexp > 0 ? "+" : "") + fmt(mexp, 1) + "% " : ""}üstünde kaldı ve bu iki yarıda, boğada da ayıda da tuttu. İsabet oranı %53 civarı: avantaj küçük, ama çok işleme yayılınca birikir. Heyecanlıyım, ama abartmıyorum.`);
    if (s.sma20_w > 0) say("livermore", `Haftalık grafikte de aynı hikâye: fiyat haftalık SMA20 (${fmt(s.sma20_w)}) üstünde${s.sma50_w ? `, o da SMA50 (${fmt(s.sma50_w)}) üstünde` : ""}. Günlük ve haftalık aynı yöne bakınca en az direnç çizgisi gerçekten yukarıdır.`);
    if (s.cmf != null && s.cmf > 0.05) say("kellogg", `Para akışı da olumlu: CMF ${fmt(s.cmf, 2)}${s.cmf_w != null ? ` (haftalık ${fmt(s.cmf_w, 2)})` : ""}. Alıcılar gün sonunda fiyatı üst yarıda tutuyor; hacmin yönü doğru.`);
    if (REGIME && REGIME.trend === "bear") say("seytan", `Dikkat: piyasa ayı rejiminde. Bu skorların avantajı piyasa ORTALAMASINA göre ölçüldü: hisse piyasadan iyi olabilir ama mutlak getiri yine de eksi çıkabilir. Pozisyon küçük, stop hazır.`);
  } else if (tier && tier.id === "toparlanan") {
    say("kellogg", `Dipte toparlanma izi var: günlük skor ${fmt(mt.d, 0)}, para girişi (CMF ${fmt(s.cmf, 2)}). Haftalık trend henüz oturmadı; bu bir erken dönüş denemesi, kanıtlı bir kural değil. Küçük pozisyon, sıkı stop.`);
  }
  const k2 = r.k2;
  if (k2) {
    const act = lv => lv.v > 0 || (typeof lv.v === "number" && lv.v >= 1);
    if (k2.vol.reply && (sm.v !== 0 || k2.vol.v !== 0 || k2.vol.stretched || k2.vol.knife)) say("vol", k2.vol.reply);
    if (k2.akilli.v !== 0 || k2.akilli.acc || (kl.v > 0 || lv.v > 0)) {
      if (kl.v > 0 && k2.akilli.v < 0) say("akilli", `Jack, hacim ${fmt(s.rvol, 1)}x diyorsun ama kimin aldığına bak: tahta ${k2.akilli.dist ? "dağıtım" : "para çıkışı"} gösteriyor (CMF ${fmt(s.cmf, 2)}). Hacim her zaman alım demek değildir; bu hacimde biri mal veriyor olabilir.`);
      else if (kl.v > 0 && k2.akilli.v > 0) say("akilli", `Jack'in hacmini teyit ediyorum: CMF ${fmt(s.cmf, 2)}, alıcı baskın. Bu hacim satıcı hacmi değil; para içeri giriyor.`);
      else if (lv.v > 0 && k2.akilli.v < 0) say("akilli", `Jesse, tape yukarı diyor ama tahtanın altında para çıkışı var (CMF ${fmt(s.cmf, 2)}). Kırılımlar böyle zayıf elde tutmaz; ben şüpheliyim.`);
      else say("akilli", k2.akilli.t);
    }
    if (k2.psiko.panic || k2.psiko.trapBear || k2.psiko.trapBull || (k2.psiko.fomo && (lv.v > 0 || kl.v > 0 || sm.v > 0))) say("psiko", (k2.psiko.fomo && !k2.psiko.panic ? `Arkadaşlar, bu hissede coşku var ve hepimiz aynı kapıya bakıyoruz. ` : "") + k2.psiko.t);
    if (k2.makro.shield.count >= 2 && (sm.v > 0 || lv.v > 0 || kl.v > 0 || bf.v > 0)) say("makro", `Önce rüzgâra bakalım: makro tabloda ${k2.makro.shield.count}/7 risk bayrağı var (${k2.makro.shield.items.filter(x => x.on).map(x => x.name.split(" ")[0]).join(", ") || "–"}). ${k2.makro.shield.evidence} ${R.makroVeto ? "Vetomu kullanıyorum." : "Veto koymuyorum ama pozisyonlar küçük olsun."}`);
    if (r.veto2 && !r.veto && r.score >= 3) say("seytan", `Yeni uzmanların net oyu ${r.net2}: itirazları ciddiye alıyorum. Masa güçlü diyordu ama genişletilmiş kurul onay vermiyor.`);
  }
  const verdict = r.veto && r.score >= 3 ? "Karar: güçlü ama Şeytanın Avukatı veto etti; masa işlem yapmıyor." : r.score >= 3 ? "Karar: masa uzlaştı, güçlü aday." : r.score === 2 ? "Karar: aday; masanın çoğu olumlu, kalan itirazlar not edildi." : r.score >= 1 ? "Karar: izleme listesi; teyit bekleniyor." : r.score === 0 ? "Karar: net değil, bekleyelim." : "Karar: uzak durulacak.";
  const v2 = r.k2 && r.veto2 && !r.veto && r.score >= 3 ? " Genişletilmiş kurul: itiraz var (net " + r.net2 + "), güçlü aday ihtiyatla okunmalı." : "";
  const mem = memoryLines(s, r), pv = peerView(s), db = debate(s, r);
  return {lines: mem.lines.concat(lines, peerLines(s, r, pv)), verdict: verdict + v2 + ` Ağırlıklı karar skoru: ${db.text} (${db.label}).`, mem, peer: pv, debate: db};
}

/* ---------- Efsane ekranları ---------- */
function personaScreens(uni, n, exclude) {
  const ex = new Set(exclude || []), rest = uni.filter(s => s.ok && s.tl >= 5 && !ex.has(s.name));
  const top = (fn, tie, pre) => (pre ? rest.filter(pre) : rest).map(s => [s, fn(s)]).filter(([, p]) => p.v > 0)
    .sort((a, b) => (b[1].score - a[1].score) || tie(a[0], b[0])).slice(0, n);
  return {
    buffett: top(buffett, (a, b) => b.tl - a.tl),
    simons: top(simons, (a, b) => (b.rs ?? 0) - (a.rs ?? 0), s => s.rs != null && s.rs >= R.sRs),
    livermore: top(livermore, (a, b) => (b.rs ?? 0) - (a.rs ?? 0)),
    kellogg: top(kellogg, (a, b) => (b.rvol ?? 0) - (a.rvol ?? 0)),
  };
}
function riskRadar(uni, n) {
  return uni.filter(s => s.ok && s.tl >= 20).map(s => { const p = devil(s, null); return [s, p, p.checks.filter(c => c.s === BAD).length]; })
    .sort((a, b) => b[2] - a[2] || a[0].tl - b[0].tl).slice(0, n);
}
/* Güç listesi: araştırmanın en güçlü bulgusu (RS lideri + yükselen trend). Aday Hisseler sayfasının varsayılan kaynağı. */
function strengthList(uni, n, minTl) {
  const lead = s => { const t = mtfTier(s); return t && (t.id === "uyumlu" || t.id === "hlider"); };
  const key = s => 0.5 * s.rs + 0.5 * (s.mtf && s.mtf.b != null ? s.mtf.b : s.rs);
  return uni.filter(s => s.ok && s.rs != null && s.tl >= (minTl ?? 5) && (trendUp(s) || lead(s))).sort((a, b) => key(b) - key(a)).slice(0, n);
}

/* ---------- Ucuz / pahalı göstergesi ----------
   UCUZ %X: fiyat adil değerin %X ALTINDA (iskonto); PAHALI %X: fiyat adil değerin %X ÜSTÜNDE (prim). |fark| < %15 ise ADİL.
   Güven, yöntemlerin birbirine yakınlığıdır (düşükse işaret kesin değil). Sektör içi yüzdelik: F/K ve PD/DD bakımından sektördeki hisselerin kaçından ucuz. */
function cheapness(s) {
  const v = valuation(s); if (v.fair == null || !(v.fair > 0)) return null;
  const disc = (1 - s.close / v.fair) * 100, prem = (s.close / v.fair - 1) * 100;
  const lab = disc >= 15 ? "UCUZ" : prem >= 15 ? "PAHALI" : "ADİL", st = SECTOR_STATS[s.sector || "Diğer"];
  const rk = (arr, x) => arr && arr.length >= 5 && x > 0 ? arr.filter(y => y > x).length / arr.length * 100 : null; // x'ten pahalı hisselerin oranı = x'in ucuzluk yüzdeliği
  const conf = v.confidence, sure = conf === "yüksek" || conf === "orta";
  return {lab, pct: lab === "UCUZ" ? disc : lab === "PAHALI" ? prem : Math.abs(disc), disc, prem, upside: v.upside, conf, sure, fair: v.fair, lo: v.lo, hi: v.hi, secPe: st ? rk(st.peArr, s.pe) : null, secPb: st ? rk(st.pbArr, s.pb) : null,
    text: lab === "ADİL" ? "Adil değere yakın" : lab === "UCUZ" ? `Fiyat adil değerin %${fmt(disc, 0)} altında` : `Fiyat adil değerin %${fmt(prem, 0)} üstünde`};
}
/* ---------- Benzer hisseler: sektör, skor, boyut, oynaklık ve (varsa) 60 günlük fiyat korelasyonu ---------- */
function retsOf(name) { const h = HIST && HIST.stocks[name]; if (!h || !h.closes || h.closes.length < 62) return null; const c = h.closes.slice(-61); return c.slice(1).map((v, i) => v / c[i] - 1); }
function corr2(a, b) { const n = a.length; let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return sab / Math.sqrt(saa * sbb || 1); }
function similarStocks(s, n) {
  const ra = retsOf(s.name), cs = cheapness(s), out = [];
  for (const x of UNIVERSE) {
    if (x.name === s.name || !x.ok || x.tl < 10 || !x.mtf || !s.mtf || s.mtf.w == null || x.mtf.w == null) continue;
    let d = (x.sector === s.sector ? 0 : 1.0) + Math.abs(x.mtf.w - s.mtf.w) / 100 + 0.5 * Math.abs((x.mtf.d ?? 50) - (s.mtf.d ?? 50)) / 100 + 0.5 * Math.abs((x.mtf.m ?? 50) - (s.mtf.m ?? 50)) / 100;
    if (x.mcap > 0 && s.mcap > 0) d += Math.abs(Math.log10(x.mcap / s.mcap)) / 2;
    if (x.atrPct != null && s.atrPct != null) d += Math.abs(x.atrPct - s.atrPct) / 8;
    const rb = ra ? retsOf(x.name) : null, c = ra && rb ? corr2(ra, rb) : null; d += c == null ? 0.35 : (1 - c) * 0.7;
    out.push({s: x, d, corr: c, ch: cheapness(x)});
  }
  out.sort((a, b) => a.d - b.d);
  const top = out.slice(0, n || 6);
  const cheaper = cs ? out.slice(0, 40).filter(o => o.ch && o.ch.sure && o.ch.disc >= cs.disc + 15 && o.s.mtf.w >= s.mtf.w - 10).slice(0, 4) : [];
  return {top, cheaper};
}
/* ---------- Veri sağlığı: eksik veri skoru bozar; kapsama düşükse uyarı verilir ---------- */
function dataHealth(ageMin) {
  const act = UNIVERSE.filter(s => s.close > 0 && s.volume > 0), okN = act.filter(s => s.ok).length, el = act.filter(s => s.ok && s.tl >= 5);
  const mtfCov = el.length ? el.filter(s => s.mtf && s.mtf.w != null).length / el.length : 0, cmfCov = el.length ? el.filter(s => s.cmf != null).length / el.length : 0;
  const hist = HIST && HIST.stocks ? Object.keys(HIST.stocks).length : 0;
  let score = 100; const issues = [];
  if (act.length < 400) { score -= 30; issues.push(`yalnızca ${act.length} aktif hisse (beklenen > 500)`); }
  if (okN / (act.length || 1) < 0.9) { score -= 15; issues.push(`${act.length - okN} hisse eksik veri nedeniyle dışarıda`); }
  if (mtfCov < 0.85) { score -= 25; issues.push(`çok zamanlı skor kapsaması %${Math.round(mtfCov * 100)} (haftalık/aylık göstergeler eksik)`); }
  if (cmfCov < 0.85) { score -= 10; issues.push(`para akışı kapsaması %${Math.round(cmfCov * 100)}`); }
  if (ageMin != null && ageMin > 60) { score -= 20; issues.push(`veri ${Math.round(ageMin)} dk önce çekildi`); }
  if (!hist) { score -= 10; issues.push("fiyat geçmişi yok"); }
  return {score: Math.max(0, score), label: score >= 85 ? "İYİ" : score >= 60 ? "DİKKAT" : "KÖTÜ", issues, mtfCov, cmfCov, n: act.length};
}

/* ---------- Değer tablosu: defter değeri, şu anki değer, olması gereken değer ----------
   Altı yöntem (varsa): kazanç değeri, nakit akışı değeri, gerekçeli PD/DD (reel ROE), Graham sayısı, sektör medyan F/K ve PD/DD çarpanları.
   "Olması gereken değer" = yöntemlerin medyanı; aralık = en düşük–en yüksek. Yöntemler birbirinden çok farklıysa güven düşüktür. */
function valuation(s) {
  const iv = intrinsic(s), gn = graham(s), st = SECTOR_STATS[s.sector || "Diğer"], book = s.bvps > 0 ? s.bvps : null, m = [];
  if (iv.fvEps != null) m.push({id: "eps", l: `Kazanç değeri (EPS × adil çarpan ${fmt(iv.mult, 1)}; reel iskonto %${fmt(iv.r * 100, 1)}, reel büyüme %${fmt(iv.g * 100, 1)})`, v: iv.fvEps});
  if (iv.fvOe != null) m.push({id: "fcf", l: `Nakit akışı değeri (serbest nakit akışı/hisse × ${fmt(iv.mult, 1)})`, v: iv.fvOe});
  const rp = roePbValue(s, iv);
  if (rp) m.push({id: "roepb", l: `Gerekçeli PD/DD (sürdürülebilir ROE %${fmt(rp.roeS * 100, 1)}; ${fmt(rp.pbJ, 2)}x) × defter değeri`, v: rp.v});
  // Sektör kalibreli yöntemler: piyasa bu sektöre mutlak modelin kaç katını ödüyor? Hisse, sektörünün seviyesine büyüme/kârlılık farkıyla ayarlanarak değerlenir.
  if (st && st.kEps && iv.fvEps != null) m.push({id: "sec_eps", l: `Sektör kalibreli kazanç değeri (piyasa bu sektöre modelin ${fmt(st.kEps, 2)} katını ödüyor)`, v: iv.fvEps * st.kEps});
  if (st && st.kRoe && rp) m.push({id: "sec_roe", l: `Sektör kalibreli gerekçeli PD/DD (piyasa modelin ${fmt(st.kRoe, 2)} katını ödüyor)`, v: rp.v * st.kRoe});
  if (gn != null) m.push({id: "graham", l: "Graham sayısı (√(22,5 × EPS × defter değeri))", v: gn});
  if (st && st.medPe > 0 && s.eps > 0) m.push({id: "pe", l: `Sektör medyan F/K (${fmt(st.medPe, 1)}) × EPS`, v: st.medPe * s.eps});
  if (st && st.medPb > 0 && book) m.push({id: "pb", l: `Sektör medyan PD/DD (${fmt(st.medPb, 2)}) × defter değeri`, v: st.medPb * book});
  const vals = m.map(x => x.v).filter(x => x > 0).sort((a, b) => a - b);
  const mid = vals.length ? (vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2) : null;
  const spread = vals.length >= 2 ? vals[vals.length - 1] / vals[0] : null;
  return {book, price: s.close, pbNow: book ? s.close / book : null, methods: m, lo: vals.length ? vals[0] : null, hi: vals.length ? vals[vals.length - 1] : null, fair: mid,
    upside: mid ? (mid / s.close - 1) * 100 : null, bookUpside: book ? (book / s.close - 1) * 100 : null, confidence: spread == null ? "az yöntem" : spread < 1.6 ? "yüksek" : spread < 3 ? "orta" : "düşük"};
}


/* =====================================================================================
   TARAMA SENARYOLARI: "potansiyelli hisse" bulmak için adım adım eleme hattı (huni).
   Her senaryo: evren → sıralı süzgeçler → sıralı aday listesi. Her süzgecin NEDEN'i ve kanıt durumu vardır; eşikler ayarlanabilir.
   Hisse hangi adımda elendiyse görülebilir (iz). Komite vetosu yalnızca hayatta kalanlarda hesaplanır (pahalı).
   Senaryolar: haftalık (ana, kanıtlı), günlük (zamanlama), aylık (kalite + değer: bağlam), bebek (yeni halka arz). */
const ageDaysOf = s => s.fbt ? (NOW / 1000 - s.fbt) / 86400 : null;
const earnDaysOf = s => s.nextEarn ? (s.nextEarn * 1000 - NOW) / 864e5 : null;
const SCAN_META = {
  haftalik: {name: "Haftalık Tarama", ufuk: "2-4 hafta (tutma 5-20 gün)", amac: "Piyasanın gerisinde kalmayan, trendi yukarı, güçlü hisseleri bulur. Sistemin ana taramasıdır: en çok kanıt bu zaman dilimindedir.", kanit: "haftalik_lider_likit"},
  gunluk: {name: "Günlük Tarama", ufuk: "giriş zamanlaması (1-5 gün); tutma yine haftalık", amac: "Haftalık zemini sağlam hisselerden BUGÜN giriş zamanlaması iyi olanları ayıklar (güç, para girişi, aşırı uzamamış). Günlük skor tek başına yeterli kanıt taşımaz; bu yüzden haftalık zemin şarttır.", kanit: "uyumlu"},
  aylik: {name: "Aylık Tarama", ufuk: "2-3 ay (bağlam; bağımsız sinyal sayılmaz)", amac: "Uzun trendi bozulmamış, kaliteli ve adil değere göre ucuz işletmeleri bulur (Buffett tarzı). Aylık ufukta fiyat skorları anlamlı çıkmadı, değerleme geçmişte test edilemiyor: sonuçlar KANITSIZ bağlamdır.", kanit: null},
  bebek: {name: "Bebek Hisse Taraması", ufuk: "1-6 ay (erken aşama)", amac: "Henüz yükselmemiş ama borcu az, özsermayesi büyüyen, kârlı ve satış/kâr büyümesi pozitif ilerleyen sağlam şirketleri bulur ('uyuyan kalite'). Temel koşullar geçmişte test edilemiyor; fiyat tarafında ise geçmiş test henüz yükselmemiş (zayıf) hisselerin piyasanın gerisinde kaldığını gösterdi, bu yüzden trend onayı (haftalık skor ≥ 50) arar. Onay gelmeyenler 'Yaklaşanlar'da gözlem listesidir.", kanit: null},
  halkaarz: {name: "Halka Arz Taraması", ufuk: "2-8 hafta", amac: "Son 1 yıl içinde halka arz olmuş hisselerde, çözülmemiş (zirveden fazla düşmemiş) ve momentumu pozitif olanları bulur. Halka arz hisseleri çok oynaktır; örnek küçüktür.", kanit: null},
};
const SCAN_PARAMS = {
  haftalik: [["minTl", "Min. günlük hacim (mn TL)", 10], ["wMin", "Haftalık skor en az", 70], ["trendW", "Haftalık trend yukarı şart (1/0)", 1], ["align", "Üç zaman dilimi uyumu şart (1/0)", 0], ["maxAtr", "En çok ATR % (stop ≤ %10 kalsın)", 4], ["earn", "Bilançoya en az gün", 5], ["veto", "Komite vetosu olmasın (1/0)", 1]],
  gunluk: [["minTl", "Min. günlük hacim (mn TL)", 10], ["wMin", "Haftalık zemin en az", 60], ["dMin", "Günlük skor (RS) en az", 70], ["cmf", "Para girişi (CMF > 0) şart (1/0)", 1], ["maxExt", "SMA50'nin üstünde en çok %", 25], ["rsiMax", "RSI en çok", 80], ["rvol", "Göreceli hacim en az (seans düzeltmeli)", 0.8], ["earn", "Bilançoya en az gün", 3], ["veto", "Komite vetosu olmasın (1/0)", 1]],
  aylik: [["minTl", "Min. günlük hacim (mn TL)", 10], ["mMin", "Aylık skor en az", 60], ["qMin", "Buffett kalite skoru en az", 60], ["cheap", "Adil değere göre UCUZ şart (1/0)", 1], ["minDisc", "Min. iskonto %", 15], ["earn", "Bilançoya en az gün", 5], ["veto", "Komite vetosu olmasın (1/0)", 0]],
  bebek: [["minTl", "Min. günlük hacim (mn TL)", 5], ["maxDe", "Borç/özsermaye en çok", 0.3], ["minCr", "Cari oran en az", 1.2], ["netCash", "Net nakitte olsun (net borç ≤ 0) (1/0)", 0], ["minEq", "Özsermaye yıl sonuna göre en az büyüme %", 0], ["minPosQ", "Son 8 çeyrekte kârlı çeyrek en az", 6], ["minRev", "Satış büyümesi en az %", 0], ["maxP6", "6 aylık getiri en çok %", 30], ["maxPy", "1 yıllık getiri en çok %", 60], ["minDd", "52h zirveden en az uzaklık %", 5], ["turn", "Trend onayı şart (haftalık skor ≥ eşik) (1/0)", 1], ["wTurn", "Trend onayı: haftalık skor en az", 50], ["maxAtr", "En çok ATR %", 6], ["earn", "Bilançoya en az gün", 3], ["veto", "Komite vetosu olmasın (1/0)", 0]],
  halkaarz: [["minAge", "En az yaş (gün)", 20], ["maxAge", "En çok yaş (gün)", 365], ["minTl", "Min. günlük hacim (mn TL)", 5], ["ddMax", "Zirveden en çok düşüş %", 20], ["mom", "1 ay getiri > 0 şart (1/0)", 1], ["maxAtr", "En çok ATR %", 8], ["earn", "Bilançoya en az gün", 3]],
};
const scanDefaults = id => Object.fromEntries(SCAN_PARAMS[id].map(([k, , v]) => [k, v]));
const fp = (v, d = 1) => v == null || Number.isNaN(v) ? "–" : fmt(v, d);
const T_ = (ok, txt) => [ok, txt];
const S_COMMON = [
  {id: "veri", name: "Veri tam", why: "Skor ve göstergeler hesaplanabilmeli; eksik veride tarama yanıltır.", test: s => T_(!!(s.ok && s.mtf && s.mtf.w != null), s.ok ? (s.mtf && s.mtf.w != null ? "tam" : "skor yok") : "eksik veri")},
  {id: "likit", name: "Yeterince likit", why: "Çıkış kolay olmalı; düşük hacimde spread ve kayma avantajı yer.", pk: "minTl", test: (s, P) => T_(s.tl >= P.minTl, fp(s.tl, 0) + " mn TL")},
  {id: "limit", name: "Tavan/taban değil", why: "Tavandaki hisse kuyrukta olduğundan alınamaz; tabandaki hisse ertesi gün ortalama %2,5 daha düşük kapanıyor.", note: "limit_research.json", test: s => T_(s.change != null && Math.abs(s.change) < 9.5, fp(s.change) + "%")},
  {id: "bilanco", name: "Bilanço yakın değil", why: "Bilançoya birkaç gün kala sürpriz riski, skorun avantajından büyük olabilir.", pk: "earn", test: (s, P) => { const d = earnDaysOf(s); return T_(d == null || d < -1 || d > P.earn, d == null ? "tarih yok" : fp(d, 0) + " gün"); }},
];
const S_VETO = {id: "veto", name: "Komite vetosu yok", why: "Şeytanın Avukatı bilanço, çıkış likiditesi ya da aşırı stop olasılığı gibi ağır bir nedenle işlemi durdurmamalı.", pk: "veto", lazy: true, test: (s, P) => { if (!P.veto) return T_(true, "kapalı"); const r = committee(s); return T_(!r.veto, r.veto ? r.l.seytan.severe.join(", ") : "veto yok"); }};
const SCAN_STEPS = {
  haftalik: [...S_COMMON,
    {id: "wmin", name: "Haftalık lider", why: "Haftalık çok göstergeli skor (haftalık trend, 6 ay zirve, DI, RSI, CMF + göreceli güç) araştırmanın en tutarlı bulgusudur; ≥ 80 iken en iyi sonuç.", pk: "wMin", ev: "haftalik_lider_likit", test: (s, P) => T_(s.mtf && s.mtf.w >= P.wMin, "H " + fp(s.mtf && s.mtf.w, 0))},
    {id: "trendw", name: "Haftalık trend yukarı", why: "Fiyat > haftalık SMA20 > SMA50: araştırmada tek başına en güçlü gösterge (iki yarıda ve boğa/ayıda tutarlı).", pk: "trendW", ev: "gosterge:haftalik:w_trend", test: (s, P) => { const ok = s.sma20_w > 0 && s.sma50_w > 0 ? s.close > s.sma20_w && s.sma20_w > s.sma50_w : null; return T_(!P.trendW || ok === true, ok == null ? "veri yok" : ok ? "yukarı" : "yukarı değil"); }},
    {id: "align", name: "Üç zaman dilimi uyumlu", why: "Günlük (RS), haftalık, aylık skorların üçü de güçlüyse avantaj tutarlıydı; zorunlu değil, kapalıysa atlanır.", pk: "align", ev: "uyumlu", test: (s, P) => T_(!P.align || (s.mtf.d >= 60 && s.mtf.w >= 70 && s.mtf.m >= 60), `${fp(s.mtf && s.mtf.d, 0)}/${fp(s.mtf && s.mtf.w, 0)}/${fp(s.mtf && s.mtf.m, 0)}`)},
    {id: "stop", name: "Stop mesafesi makul", why: "Stop = 2,5×ATR; %10'dan geniş stop gerektiren hisse pozisyon boyutunu küçültür, risk/getiri bozulur.", pk: "maxAtr", test: (s, P) => T_(s.atrPct != null && s.atrPct <= P.maxAtr, "ATR %" + fp(s.atrPct))},
    S_VETO],
  gunluk: [...S_COMMON,
    {id: "wzemin", name: "Haftalık zemin sağlam", why: "Günlük sinyaller tek başına kanıtsız; giriş zamanlaması yalnızca haftalık olarak güçlü hissede aranır.", pk: "wMin", ev: "haftalik_lider_likit", test: (s, P) => T_(s.mtf && s.mtf.w >= P.wMin, "H " + fp(s.mtf && s.mtf.w, 0))},
    {id: "dgus", name: "Günlük göreceli güç", why: "Günlük skor = göreceli güç (RS): ileri doğrulamada her evrende en tutarlı kısa vadeli ölçüt.", pk: "dMin", ev: "wf:gunluk:rs", test: (s, P) => T_(s.mtf && s.mtf.d >= P.dMin, "G " + fp(s.mtf && s.mtf.d, 0))},
    {id: "cmf", name: "Para girişi", why: "Chaikin Para Akışı > 0: kapanışlar günün üst yarısında, alıcı baskın (günlük göstergeler içinde en tutarlısı).", pk: "cmf", ev: "gosterge:gunluk:cmf20", test: (s, P) => T_(!P.cmf || (s.cmf != null && s.cmf > 0), "CMF " + fp(s.cmf, 2))},
    {id: "sma20", name: "Kısa trend yukarı", why: "Fiyat 20 günlük ortalamanın üstünde: düşen bıçak değil.", test: s => T_(s.sma20 > 0 && s.close > s.sma20, "SMA20'ye " + fp(s.sma20 > 0 ? (s.close / s.sma20 - 1) * 100 : null) + "%")},
    {id: "uzama", name: "Aşırı uzamamış", why: "SMA50'nin çok üstünde ya da RSI aşırı yüksek hisseyi kovalamak riskli (Şeytanın Avukatı: FOMO).", pk: "maxExt", test: (s, P) => T_(s.smaDist != null && s.smaDist <= P.maxExt && (s.rsi == null || s.rsi <= P.rsiMax), `SMA50 +%${fp(s.smaDist)}, RSI ${fp(s.rsi, 0)}`)},
    {id: "hacim", name: "Hacim canlı", why: "Seans düzeltmeli göreceli hacim: ilgi görmeyen hissede hareket kalıcı olmaz.", pk: "rvol", ev: "gosterge:gunluk:rvol", test: (s, P) => T_(s.rvol != null && s.rvol >= P.rvol, fp(s.rvol, 1) + "x")},
    S_VETO],
  aylik: [...S_COMMON,
    {id: "mskor", name: "Uzun trend sağlam", why: "Aylık skor (uzun trend, 52h yakınlık, aylık CMF, 6-12 ay getiri) ve SMA50 > SMA200. Aylık ufukta kanıt zayıf: bağlam verir.", pk: "mMin", test: (s, P) => T_(s.mtf && s.mtf.m >= P.mMin && trendUp(s) === true, `A ${fp(s.mtf && s.mtf.m, 0)}, ${trendUp(s) ? "SMA50>SMA200" : "uzun trend zayıf"}`)},
    {id: "kalite", name: "İşletme kalitesi", why: "Buffett'ın kalite ölçütleri (reel ROE, marj, borç, serbest nakit akışı, kazanç büyümesi) tutan şirketler.", pk: "qMin", lazy: true, test: (s, P) => { const b = buffett(s); return T_(b.quality != null && b.quality >= P.qMin, "kalite " + fp(b.quality, 0) + "/100"); }},
    {id: "ucuz", name: "Adil değere göre ucuz", why: "Fiyat adil değerin en az %15 altında ve yöntemler birbirine yakın (güven orta/yüksek). Değerleme geçmişte test EDİLEMİYOR: kanıtsız bağlam.", pk: "minDisc", lazy: true, test: (s, P) => { if (!P.cheap) return T_(true, "kapalı"); const c = cheapness(s); return T_(!!(c && c.sure && c.disc >= P.minDisc), c ? `${c.lab} %${fp(c.lab === "UCUZ" ? c.disc : c.prem, 0)}, güven ${c.conf}` : "hesaplanamadı"); }},
    S_VETO],
  bebek: [...S_COMMON,
    {id: "borc", name: "Borcu az", why: "Borç/özsermaye düşük ve cari oran yeterli: faiz yükü az, kriz anında dayanıklı. Bankalar/finans için geçerli değildir (atlanır).", pk: "maxDe", test: (s, P) => { if (isFin(s)) return T_(false, "banka/finans: geçerli değil"); const nc = !P.netCash || (s.nd != null && s.nd <= 0); return T_(s.de != null && s.de <= P.maxDe && (s.cr == null || s.cr >= P.minCr) && nc, `B/Ö ${fp(s.de, 2)}, cari ${fp(s.cr, 2)}${P.netCash ? ", net borç " + (s.nd == null ? "–" : s.nd <= 0 ? "yok" : "var") : ""}`); }},
    {id: "ozsermaye", name: "Özsermayesi büyüyor", why: "Son bilanço özsermayesi yıl sonundakinden büyük ve pozitif: kâr birikiyor, zarar değil. (Tam geçmiş seri yok; yıl sonuna göre değişim ve kârlı çeyrek sayısı birlikte okunur.)", pk: "minEq", test: (s, P) => T_(s.eqg != null && s.eqg * 100 >= P.minEq && s.bvps > 0, "yıl sonuna göre " + (s.eqg == null ? "–" : "%" + fmt(s.eqg * 100, 1)))},
    {id: "karli", name: "Sürekli kârlı", why: "Son 8 çeyreğin çoğunda net kâr pozitif, F/K tanımlı, net marj ve serbest nakit akışı pozitif: tek seferlik değil, süreklilik.", pk: "minPosQ", test: (s, P) => T_(s.nipos8 != null && s.nipos8 >= P.minPosQ && s.eps > 0 && s.nm > 0 && (s.fcf == null || s.fcf > 0), `kârlı çeyrek ${s.nipos8 == null ? "–" : s.nipos8 + "/8"}, marj %${fp(s.nm)}`)},
    {id: "buyume", name: "Pozitif ilerliyor", why: "Satışlar yıllık büyüyor ve son 4 çeyrek kârı önceki 4 çeyrekten yüksek: iş genişliyor. (Enflasyonlu ortamda nominal büyüme düşük olabilir; eşiği ayarlayın.)", pk: "minRev", test: (s, P) => T_(s.revg != null && s.revg >= P.minRev && (s.nig4 == null || s.nig4 > 0), `satış %${fp(s.revg, 0)}, kâr 4Ç ${s.nig4 == null ? "–" : "%" + fmt(s.nig4 * 100, 0)}`)},
    {id: "yukselmemis", name: "Henüz yükselmemiş", why: "Fiyat son 6 ayda ve 1 yılda fazla koşmamış ve 52 hafta zirvesinden uzak: 'erken' aşama. Dikkat: salt ucuzluk/gerilik geçmişte piyasanın gerisinde kaldı; bu yüzden aşağıdaki trend onayı vardır.", pk: "maxP6", test: (s, P) => T_(s.p6m != null && s.p6m <= P.maxP6 && (s.py == null || s.py <= P.maxPy) && s.dist52 != null && s.dist52 <= -P.minDd, `6ay %${fp(s.p6m, 0)}, 1y %${fp(s.py, 0)}, zirveden %${fp(s.dist52, 0)}`)},
    {id: "onay", name: "Trend onayı", why: "Haftalık skor eşiğin üstünde: fiyat da toparlıyor. Olmayanlar gözlem listesindedir (Yaklaşanlar). Haftalık skor araştırmanın kanıtlı tek parçasıdır.", pk: "wTurn", ev: "haftalik_lider_likit", test: (s, P) => T_(!P.turn || (s.mtf && s.mtf.w >= P.wTurn), "H " + fp(s.mtf && s.mtf.w, 0))},
    {id: "atr", name: "Oynaklık makul", why: "Stop mesafesi (2,5×ATR) çok genişse pozisyon küçülür.", pk: "maxAtr", test: (s, P) => T_(s.atrPct != null && s.atrPct <= P.maxAtr, "ATR %" + fp(s.atrPct))},
    S_VETO],
  halkaarz: [
    {id: "veri", name: "Veri tam", why: "Fiyat ve halka arz bilgisi olmalı.", test: s => T_(!!(s.ok && s.fbt), s.fbt ? "tam" : "listeleme tarihi yok")},
    {id: "yas", name: "Bebek yaşında", why: "İlk işlem gününden bu yana geçen süre. İlk haftalar tavan serisiyle geçer (alınamaz); 20. günden sonra fiyat serbest oluşmaya başlar.", pk: "minAge", test: (s, P) => { const a = ageDaysOf(s); return T_(a != null && a >= P.minAge && a <= P.maxAge, "yaş " + fp(a, 0) + " gün"); }},
    S_COMMON[1], S_COMMON[2], S_COMMON[3],
    {id: "dd", name: "Çözülmemiş (zirveden uzak değil)", why: "Halka arz hisselerinde zirveden ≥ %40 düşmüş olanlar 20 günde piyasanın ~%1,6 gerisinde kaldı; zirveye %20 içinde olanlar ~%2,6 önde (~100 halka arzlık örnek).", pk: "ddMax", ev: "ipo:Zirveden < %20 düşmüş", test: (s, P) => { const dd = s.h52 > 0 ? (1 - s.close / s.h52) * 100 : null; return T_(dd != null && dd <= P.ddMax, "zirveden -%" + fp(dd, 0)); }},
    {id: "mom", name: "Momentum pozitif", why: "Aylık getirisi pozitif halka arzlar 20 günde piyasayı ~%1 geçti; negatif olanlar ~%1 geride kaldı.", pk: "mom", ev: "ipo:Aylık momentum > 0", test: (s, P) => T_(!P.mom || (s.p1m != null && s.p1m > 0), "1 ay " + fp(s.p1m) + "%")},
    {id: "atr", name: "Oynaklık kabul edilebilir", why: "Halka arz hisseleri çok oynaktır; stop mesafesi çok genişse pozisyon küçülür.", pk: "maxAtr", test: (s, P) => T_(s.atrPct != null && s.atrPct <= P.maxAtr, "ATR %" + fp(s.atrPct))}],
};
const SCAN_RANK = {
  haftalik: (a, b) => (b.mtf.b - a.mtf.b), gunluk: (a, b) => (b.mtf.d - a.mtf.d) || ((b.cmf ?? 0) - (a.cmf ?? 0)),
  aylik: (a, b) => { const x = cheapness(a), y = cheapness(b); return ((y ? y.disc : -99) - (x ? x.disc : -99)); },
  bebek: (a, b) => ((b.nipos8 ?? 0) - (a.nipos8 ?? 0)) || ((b.eqg ?? 0) - (a.eqg ?? 0)), halkaarz: (a, b) => (b.rs ?? 0) - (a.rs ?? 0),
};
/* skipLazy: pahalı adımlar (komite vetosu, kalite, değerleme) atlanır; yalnızca hızlı sayım için */
function runScan(id, P, opt) {
  const steps = SCAN_STEPS[id], skipLazy = !!(opt && opt.skipLazy), res = [], trace = new Map();
  let alive = UNIVERSE.slice();
  res.push({id: "evren", name: "Evren (tüm BIST hisseleri)", why: "Borsa İstanbul'daki bütün hisseler (TradingView taraması).", n_in: alive.length, n_out: alive.length});
  const need = !!(opt && opt.trace);
  if (need) UNIVERSE.forEach(s => trace.set(s.name, []));
  for (const st of steps) {
    const n_in = alive.length, out = [];
    if (skipLazy && st.lazy) { res.push({...stepInfo(st, P), n_in, n_out: n_in, skipped: true}); continue; }
    for (const s of alive) { let r; try { r = st.test(s, P); } catch (e) { r = [false, "hata"]; } if (need) trace.get(s.name).push({step: st.id, name: st.name, ok: r[0], txt: r[1]}); if (r[0]) out.push(s); }
    res.push({...stepInfo(st, P), n_in, n_out: out.length}); alive = out;
  }
  alive.sort(SCAN_RANK[id]);
  return {steps: res, list: alive, trace};
}
const stepInfo = (st, P) => ({id: st.id, name: st.name, why: st.why, pk: st.pk || null, ev: st.ev || null, val: st.pk ? P[st.pk] : null});
/* tek hisse için tüm adımların değerleri (elendiği ilk adım işaretlenir) */
function scanTrace(id, P, s) {
  const out = []; let dead = false;
  for (const st of SCAN_STEPS[id]) { let r; try { r = st.test(s, P); } catch (e) { r = [false, "hata"]; } out.push({id: st.id, name: st.name, why: st.why, ok: r[0], txt: r[1], first: !r[0] && !dead}); if (!r[0]) dead = true; }
  return {steps: out, pass: !dead};
}
function scanPlan(s) { // ortak işlem planı: stop 2,5×ATR (en çok %10), hedef 2R, %1 risk kuralı
  const atr = s.atr, stop = atr ? Math.max(s.close - 2.5 * atr, s.close * 0.9) : null, risk = stop ? s.close - stop : null;
  return {entry: s.close, stop, target: risk ? s.close + 2 * risk : null, stopPct: risk ? risk / s.close * 100 : null, maxPos: risk ? Math.min(33, 100 / (risk / s.close * 100)) : null};
}

/* Yaklaşanlar: sert süzgeçleri (veri, likidite, tavan/taban) geçen ve yalnızca BİR hızlı adımda elenen hisseler.
   Eşiğe yakın olduğu için "potansiyel" sayılır: bir sonraki gün/hafta listeye girebilir. Pahalı (lazy) adımlar atlanır. */
function scanNearMiss(id, P, limit) {
  const steps = SCAN_STEPS[id].filter(st => !st.lazy), hard = new Set(["veri", "likit", "limit", "yas"]), out = [];
  for (const s of UNIVERSE) {
    let bad = null, nb = 0, okHard = true;
    for (const st of steps) { let r; try { r = st.test(s, P); } catch (e) { r = [false, "hata"]; } if (!r[0]) { if (hard.has(st.id)) { okHard = false; break; } nb++; bad = {id: st.id, name: st.name, txt: r[1]}; if (nb > 1) break; } }
    if (okHard && nb === 1) out.push({s, miss: bad});
  }
  out.sort((a, b) => SCAN_RANK[id](a.s, b.s));
  return out.slice(0, limit || 25);
}

/* =====================================================================================
   HATA AVCISI (Fact-Checker): komitenin ürettiği rakamları BAĞIMSIZ bir kaynakla çapraz kontrol eder.
   Not: bu sistemde ajanlar kural tabanlıdır (LLM yok), yani "halüsinasyon" yerine veri/kod hatası olur; ama aynı risk geçerlidir: metindeki rakam, ham veriyle uyuşmalı.
   Karşılaştırma: anlık tablo (TradingView tarayıcı verisi, s.*) ile TradingView günlük kapanış geçmişi (HIST.closes) yeniden hesaplanır
   (RSI-14 Wilder, SMA20/50, z-skor, günlük değişim, 1 ay getiri, F/K = fiyat/EPS, 52 hafta aralığı). Ayrıca ajan metinlerindeki rakamlar ("RSI 72", "z-skor 1,4" ...) ham değerle sınanır.
   Çelişki varsa: rapor KİLİTLENİR (kilit nedeni + düzeltme talebi üretilir; oylar ve sanal portföyler değişmez, yalnızca "yayın" engellenir).
   Veri sonradan düzelirse kilit kendiliğinden kalkar (her yenilemede yeniden hesaplanır). */
const FC_TOL = {change: 0.9, rsi: 3.5, sma50: 1.2, sma20: 1.2, p1m: 4, z: 0.35, pe: 0.12, cmp: 0.02};
let FC_MEMO = new Map();
function fcReset() { FC_MEMO = new Map(); }
function fcToday() { try { return new Date(typeof NOW === "number" ? NOW : Date.now()).toLocaleDateString("sv-SE", {timeZone: "Europe/Istanbul"}); } catch (e) { return new Date().toISOString().slice(0, 10); } }
function rsiWilder(c, n = 14) {
  if (!c || c.length < n + 2) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); }
  g /= n; l /= n;
  for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
const fcAvg = a => a.reduce((x, y) => x + y, 0) / a.length;
const fcSd = a => { const m = fcAvg(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
/* Ham seri: geçmişin son çubuğu bugünkü anlık fiyatla aynı çubuk olabilir ya da bir önceki seanstır; iki aday da denenir, en yakını seçilir. */
function fcRaw(s) {
  const h = HIST && HIST.stocks && HIST.stocks[s.name]; if (!h || !h.closes || h.closes.length < 60 || !(s.close > 0)) return null;
  const c = h.closes, today = fcToday(), age = h.last ? (Date.parse(today) - Date.parse(h.last)) / 864e5 : null;
  if (age != null && age > 6) return {stale: true, age};
  const base = h.last === today ? c.slice(0, -1) : c;
  return {stale: false, base, withNow: base.concat([s.close]), n: base.length};
}
function fcBest(cands, said, tol, rel) {
  let best = null;
  for (const v of cands) { if (v == null || Number.isNaN(v)) continue; const d = rel ? Math.abs(v / said - 1) : Math.abs(v - said); if (best == null || d < best.d) best = {v, d}; }
  return best && {raw: best.v, diff: best.d, ok: best.d <= tol};
}
/* Ham verilerden bağımsız yeniden hesap: {alan: [aday değerler]} */
function fcRecalc(s) {
  const raw = fcRaw(s); if (!raw || raw.stale) return raw;
  const A = raw.withNow, B = raw.base, out = {};
  const pct = (a, b) => (a / b - 1) * 100;
  const n = B.length;
  out.change = [pct(s.close, B[n - 1]), n > 1 ? pct(s.close, B[n - 2]) : null];
  out.rsi = [rsiWilder(A), rsiWilder(B)];
  out.sma50 = [fcAvg(A.slice(-50)), fcAvg(B.slice(-50))];
  out.sma20 = [fcAvg(A.slice(-20)), fcAvg(B.slice(-20))];
  out.p1m = []; for (const X of [A, B]) for (let k = 19; k <= 24; k++) if (X.length > k + 1) out.p1m.push(pct(s.close, X[X.length - 1 - k])); // TradingView 1 ay = takvim ayı (19-24 işlem günü)
  const z = X => { const w = X.slice(-20), sd = fcSd(w); return sd > 0 ? (s.close - fcAvg(w)) / sd : null; };
  out.z20 = [z(A), z(B)];
  out.hi = Math.max(...A.slice(-250)); out.lo = Math.min(...A.slice(-250));
  return out;
}
/* Ajan metinlerindeki rakam iddiaları: yalnızca kendi hissesine ait, belirsizliği olmayan kalıplar */
function fcClaims(text) {
  const num = t => Number(String(t).replace(/\./g, "").replace(",", ".")), out = [];
  let m;
  const rx = [["rsi", /RSI (\d{1,3}(?:,\d+)?)/g, 1], ["z20", /Z-skor (-?\d{1,2},\d{1,2})(?! \()/gi, 1], ["z20", /z-skor (-?\d{1,2},\d{1,2}) ve trend/g, 1]];
  for (const [k, re, g] of rx) { re.lastIndex = 0; while ((m = re.exec(text))) out.push({k, said: num(m[g]), ctx: m[0]}); }
  return out;
}
function fcTexts(s, r) {
  const L = r.l, t = [];
  ["buffett", "simons", "livermore", "kellogg", "seytan"].forEach(k => { if (L[k] && L[k].t) t.push([k, L[k].t]); });
  try { const mt = meeting(s, r); mt.lines.forEach(x => { if (!x.gen) t.push([x.who, x.text]); }); t.push(["karar", mt.verdict]); } catch (e) { t.push(["hata", "toplantı üretilemedi: " + e.message]); }
  return t;
}
/* Ana kontrol: {locked, issues:[{kind, field, said, raw, msg}], checked, stale} */
function factCheck(s, r, opts) {
  const key = s.name + "|" + s.close + "|" + (r ? 1 : 0) + "|" + (opts && opts.tamper ? 1 : 0);
  if (!(opts && opts.nocache) && FC_MEMO.has(key)) return FC_MEMO.get(key);
  const issues = [];
  let checked = 0, stale = false;
  const rc = fcRecalc(s);
  const bad = (kind, field, said, raw, msg) => issues.push({kind, field, said, raw, msg});
  if (rc === null || rc === undefined) stale = true;
  else if (rc.stale) stale = true;
  else {
    const px = s.close;
    const tests = [
      ["change", "Günlük değişim %", s.change, FC_TOL.change + 2 * (0.02 / Math.max(px, 0.01)) * 100, false],
      ["rsi", "RSI (14)", s.rsi, FC_TOL.rsi, false],
      ["sma50", "SMA50", s.sma50, FC_TOL.sma50 / 100, true],
      ["sma20", "SMA20", s.sma20, FC_TOL.sma20 / 100, true],
      ["p1m", "1 ay getiri %", s.p1m, FC_TOL.p1m, false],
    ];
    for (const [k, lab, said, tol, rel] of tests) {
      if (said == null || rc[k] == null) continue; checked++;
      const b = fcBest(rc[k], said, tol, rel);
      if (b && !b.ok) bad("veri", k, said, b.raw, `${lab}: tabloda ${fmt(said, 2)}, TradingView kapanış geçmişinden hesap ${fmt(b.raw, 2)}`);
    }
    if (s.pe > 0 && s.eps > 0) { checked++; const p = s.close / s.eps; if (Math.abs(p / s.pe - 1) > FC_TOL.pe + 0.03) bad("veri", "pe", s.pe, p, `F/K: tabloda ${fmt(s.pe, 1)}, fiyat/EPS ${fmt(p, 1)}`); }
    if (s.h52 > 0 && s.l52 > 0) { checked++; if (rc.hi > s.h52 * 1.01 || rc.lo < s.l52 * 0.99) bad("veri", "range", null, null, `52 hafta aralığı (${fmt(s.l52)}–${fmt(s.h52)}) kapanış geçmişini kapsamıyor (${fmt(rc.lo)}–${fmt(rc.hi)})`); }
    if (r) {
      for (const [who, text] of fcTexts(s, r)) {
        for (const c of fcClaims(text)) {
          const rawv = c.k === "rsi" ? rc.rsi : rc.z20, tol = c.k === "rsi" ? FC_TOL.rsi + 0.6 : FC_TOL.z + 0.1; checked++;
          const b = fcBest(rawv, c.said, tol, false);
          if (b && !b.ok) bad("metin", c.k, c.said, b.raw, `${(WHO_TXT[who] || who)} "${c.ctx}" diyor; ham veriden hesap ${fmt(b.raw, 2)}`);
        }
      }
    }
  }
  const res = {locked: issues.length > 0, issues, checked, stale, name: s.name};
  if (res.locked) res.request = `Düzeltme talebi (${s.name}): ${issues.map(i => i.msg).join(" | ")}. Veri yeniden çekilene ya da kaynak düzeltilene kadar rapor yayınlanmaz.`;
  FC_MEMO.set(key, res);
  return res;
}
const WHO_TXT = {buffett: "Buffett", simons: "Simons", livermore: "Livermore", kellogg: "Kellogg", seytan: "Şeytanın Avukatı", vol: "Volatilite Uzmanı", akilli: "Akıllı Para", psiko: "Psikoloji Analisti", makro: "Makro Uzmanı", karar: "Karar", masa: "Masa"};
/* Kilitli hisselerin özet listesi (yalnızca verilen liste) */
function factSweep(list) { const out = []; for (const s of list) { try { const f = factCheck(s, committee(s)); if (f.locked) out.push(f); } catch (e) { out.push({locked: true, name: s.name, issues: [{kind: "hata", msg: "kontrol çalışmadı: " + e.message}], checked: 0}); } } return out; }

/* =====================================================================================
   ANLIK ALARM MOTORU: seans içinde her veri yenilemesinde (tarayıcıda dakikada bir, sunucuda 15 dakikada bir) çalışır.
   Tetikler: (1) ani hacim patlaması, (2) 50 günlük ortalama kırılımı (hisse ve BIST 100), (3) Şeytanın Avukatı'nın vetosu/risk tetiği (aday ve favoriler),
   (4) piyasa geneli panik / geniş satış / taban yağmuru. sev 3 = "Kritik Piyasa Alarmı" (kırmızı banner + webhook), sev 2 = önemli, sev 1 = bilgi. */
const ALARM_P = {volX: 3, volTl: 20, volChg: 2, brkTl: 20, panicIdx: 30, medChg: -2.5, tabanN: 8};
function marketAlarms(extra) {
  const uni = (typeof UNIVERSE !== "undefined" && UNIVERSE) || [], out = [], watch = new Set([...(extra && extra.watch || []), ...(typeof current !== "undefined" && current ? current.map(x => x.name) : [])]);
  const add = (id, sev, type, n, text) => out.push({id, sev, type, n: n || null, text});
  const liq = uni.filter(s => s.ok && s.tl >= ALARM_P.volTl);
  // 1) hacim patlaması
  liq.filter(s => s.rvol != null && s.rvol >= ALARM_P.volX && s.change != null && Math.abs(s.change) >= ALARM_P.volChg).sort((a, b) => b.tl - a.tl).slice(0, 10).forEach(s => {
    const hot = s.rvol >= 5 && s.tl >= 100, w = watch.has(s.name);
    add("vol:" + s.name, hot || (w && s.change < 0) ? 3 : 2, "hacim", s.name, `${s.name}: ani hacim patlaması: hacim ${fmt(s.rvol, 1)}x (normalin), fiyat ${s.change > 0 ? "+" : ""}${fmt(s.change, 1)}%, işlem ${fmt(s.tl, 0)} mn TL${w ? " (izleme listenizde/aday)" : ""}`);
  });
  // 2) SMA50 kırılımı
  liq.forEach(s => {
    if (s.change == null || !(s.sma50 > 0)) return;
    const prev = s.close / (1 + s.change / 100), dn = prev >= s.sma50 && s.close < s.sma50, up = prev <= s.sma50 && s.close > s.sma50, w = watch.has(s.name);
    if (dn && s.tl >= ALARM_P.brkTl) add("sma50dn:" + s.name, (s.rvol >= 2 && w) ? 3 : 2, "sma50", s.name, `${s.name}: 50 günlük ortalamanın (${fmt(s.sma50)}) ALTINA indi${s.rvol >= 2 ? ", hacimli (" + fmt(s.rvol, 1) + "x)" : ""}: trend desteği kırıldı`);
    else if (up && w) add("sma50up:" + s.name, 1, "sma50", s.name, `${s.name}: 50 günlük ortalamanın (${fmt(s.sma50)}) üstüne çıktı`);
  });
  try {
    const ix = HIST && HIST.index && HIST.index.closes; if (ix && ix.length > 55) {
      const n = ix.length, m50 = fcAvg(ix.slice(-50)), last = ix[n - 1], prevM = fcAvg(ix.slice(-51, -1)), prev = ix[n - 2];
      if (prev >= prevM && last < m50) add("xu100sma50dn", 3, "endeks", null, `BIST 100 (${fmt(last, 0)}) 50 günlük ortalamanın (${fmt(m50, 0)}) altına indi: piyasa geneli trend kırılımı`);
    }
  } catch (e) {}
  // 3) Şeytanın Avukatı: aday/favori hisselerde veto
  const seen = new Set();
  [...watch].forEach(nm => { const s = uni.find(x => x.name === nm); if (!s || !s.ok || s.tl < 5 || seen.has(nm)) return; seen.add(nm);
    try { const d = devil(s, null); if (d.veto) add("veto:" + nm, (typeof committee === "function" && committee(s).score >= 2) ? 3 : 2, "veto", nm, `${nm}: Şeytanın Avukatı vetosu: ${d.severe.join("; ")}. Bu koşulda yeni işlem açılmaz`); } catch (e) {} });
  // 4) piyasa geneli
  const cm = crowdMeter(); if (cm && cm.idx <= ALARM_P.panicIdx) add("panic", 3, "piyasa", null, `Piyasa paniği: korku göstergesi ${fmt(cm.idx, 0)}/100 (taban ${cm.tab}, tavan ${cm.tav})`);
  const chs = uni.filter(s => s.ok && s.tl >= 5 && s.change != null).map(s => s.change).sort((a, b) => a - b);
  if (chs.length > 50) { const med = chs[Math.floor(chs.length / 2)]; if (med <= ALARM_P.medChg) add("breadth", 3, "piyasa", null, `Geniş satış: hisselerin yarısından fazlası günde ${fmt(med, 1)}% veya daha kötü`); }
  const tab = uni.filter(s => s.ok && s.tl >= 5 && s.change <= -9.5).length; if (tab >= ALARM_P.tabanN) add("taban", 3, "piyasa", null, `${tab} hisse taban oldu`);
  return out.sort((a, b) => b.sev - a.sev);
}

/* =====================================================================================
   OTOMATİK DENETİM ARŞİVİ: seans kapanışında konseyin kararlarını, efsanelerin oylarını, Monte Carlo sonuçlarını, Baş Denetçi ve Hata Avcısı mührünü
   okunur bir Markdown raporu olarak üretir (archive.js bunu Arsiv/ klasörüne yazar). Saf biçimlendirme: tarayıcıda da test edilebilir. */
function auditIssues(cands, results, dataTs) {
  const issues = [], age = dataTs ? (Date.now() - dataTs * 1000) / 36e5 : null;
  if (!cands.length) issues.push("Filtreye uyan hisse yok.");
  if (age != null && age > 24) issues.push(`Veri ${fmt(age, 0)} saat önce çekilmiş.`);
  const bad = UNIVERSE.filter(s => !s.ok).length; if (bad) issues.push(`${bad} hisse eksik/hatalı veri nedeniyle tarama dışı.`);
  const noPe = cands.filter(c => c.pe == null || c.pe <= 0).length; if (noPe) issues.push(`${noPe} adayda F/K yok; Buffett değerlemesi bunlarda geçersiz.`);
  if (!HIST) issues.push("Fiyat geçmişi yüklenmedi."); else {
    const nohist = cands.filter(c => !HIST.stocks[c.name]).length; if (nohist) issues.push(`${nohist} adayın geçmişi yok.`);
    const small = cands.filter(c => HIST.stocks[c.name] && HIST.stocks[c.name].bt.n < R.sMinN).length; if (small) issues.push(`${small} adayda geçmiş sinyal sayısı < ${R.sMinN}.`);
  }
  if (!Object.keys(NEWS || {}).length) issues.push("Haber verisi yüklenmedi.");
  if (!RESEARCH) issues.push("Araştırma verisi yüklenmedi.");
  results.forEach(([s, r]) => {
    const mc = monteCarlo(s);
    if (r.score >= 3 && mc && mc.probStop >= 60) issues.push(`${s.name}: "GÜÇLÜ ADAY" ama stop olasılığı %${fmt(mc.probStop, 0)}, çelişki var.`);
    const n = NEWS[s.name]; if (r.score >= 3 && n && n.score <= -2) issues.push(`${s.name}: "GÜÇLÜ ADAY" ama haber akışı olumsuz.`);
  });
  results.slice(0, 40).forEach(([s, r]) => { try { consistencyIssues(s, r).forEach(i => issues.push(i)); } catch (e) { /* tutarlılık denetimi çalışmadı */ } });
  return issues;
}
function archiveDay(date, dataTs) {
  const cands = current.slice(), results = cands.map(s => [s, committee(s)]);
  const issues = auditIssues(cands, results, dataTs), locks = [];
  const stocks = results.map(([s, r]) => {
    const f = factCheck(s, r), mc = monteCarlo(s), mt = meeting(s, r), v = r.l, db = mt.debate, pv = mt.peer, mcm = mcMatrix(s), sn = stockSentiment(s.name), au = v.buffett.audit, stz = v.seytan.stress, kpl = kellyPlan(s, 100000);
    if (f.locked) locks.push(f);
    return {n: s.name, desc: s.description, sector: s.sector, close: s.close, change: s.change, score: r.score, label: r.label, veto: r.veto, veto2: !!r.veto2, net2: r.net2,
      votes: {buffett: v.buffett.v, simons: v.simons.v, livermore: v.livermore.v, kellogg: v.kellogg.v, seytan: v.seytan.v, makro: r.k2.makro.v, akilli: r.k2.akilli.v, vol: r.k2.vol.v, psiko: r.k2.psiko.v},
      mc: mc && {sigma: mc.sigma, days: mc.days, stop: mc.stop, n: mc.n, p05: mc.p05, p50: mc.p50, p95: mc.p95, probLoss: mc.probLoss, probStop: mc.probStop, sharpe0: mc.sharpe0, cvar5: mc.cvar5, mean: mc.mean, sd: mc.sd, rf: mc.rf},
      mcs: v.simons.mcs || null, mcm: mcm && {days: mcm.days, best: mcm.best, cells: mcm.cells.map(row => row.map(c => [c.T, c.S, c.pT, c.pS, c.ev]))},
      stress: stz && {ok: stz.ok, loss: stz.loss, fail: stz.fail, text: stz.text}, kelly: kpl && {S: kpl.S, T: kpl.T, pWin: kpl.pWin, kelly: kpl.kelly, f: kpl.f, k: kpl.k, stop0: kpl.stop0, target: kpl.target, edge: kpl.edge, text: kpl.text, ladder: kpl.ladder.map(x => [x.r, x.peak, x.stop])},
      audit: au && {verdict: au.verdict, text: au.text, items: au.items.map(x => [x.label, x.val, x.flag])}, sent: sn && {score: sn.score, label: sn.label, n: sn.n, kap: sn.kap, top: sn.top},
      devil: {t: v.seytan.t, plan: v.seytan.plan, severe: v.seytan.severe},
      lines: mt.lines.map(x => [x.who, x.text]), verdict: mt.verdict,
      debate: {text: db.text, label: db.label, al: db.al, tut: db.tut, sat: db.sat, learned: db.learned, bull: db.bull.pts.map(p => p.text), bear: db.bear.pts.map(p => p.text), unrefBull: db.bull.unref, unrefBear: db.bear.unref, lines: db.lines.map(x => [x.side, x.who, x.text])},
      memory: mt.mem.ref ? {ref: mt.mem.ref, flips: mt.mem.flips.map(f => [f.k, f.from, f.to, f.tiny])} : null,
      peer: pv && {sector: pv.sector, n: pv.n, rank: pv.rank, rankOf: pv.rankOf, pePrem: pv.pePrem, rows: pv.rows.map(x => [x.label, x.st, x.sec, x.mkt, x.rel, x.type]), peers: pv.peers}, fact: {locked: f.locked, checked: f.checked, stale: f.stale, issues: f.issues.map(i => i.msg), request: f.request || null}};
  });
  return {date, weights: memWeights(), regime: REGIME && REGIME.label, a50: REGIME && Math.round(REGIME.a50), stocks, issues, locks: locks.map(l => l.name), audit: locks.length ? "RED (KİLİTLİ RAPOR VAR)" : issues.length ? "ŞARTLI ONAY" : "ONAY"};
}
const AR_VOTE = v => v > 0 ? "▲ olumlu" : v < 0 ? "▼ olumsuz" : "• nötr";
const AR_NAME = {buffett: "Warren Buffett", simons: "Jim Simons", livermore: "Jesse Livermore", kellogg: "Jack Kellogg", seytan: "Şeytanın Avukatı", makro: "Makro & Jeopolitik", akilli: "Akıllı Para", vol: "Opsiyon & Volatilite", psiko: "Piyasa Psikolojisi"};
function archiveMd(day, extras) {
  const x = extras || {}, L = [], seal = day.audit.startsWith("RED") ? "🔴" : day.audit === "ONAY" ? "🟢" : "🟡";
  L.push(`# Borsa Komitesi Seans Raporu: ${day.date}`, "", `> Eğitim amaçlıdır, yatırım tavsiyesi değildir. Otomatik üretilmiştir (kural tabanlı ajanlar; yapay zekâ metni yoktur).`, "");
  L.push(`**Piyasa rejimi:** ${day.regime || "–"}${day.a50 != null ? ` (hisselerin %${day.a50}'i SMA50 üstünde)` : ""} · **Aday sayısı:** ${day.stocks.length} · **Baş Denetçi mührü:** ${seal} ${day.audit}`, "");
  L.push("## Mühürler", "", `- **Baş Denetçi:** ${day.audit}${day.issues.length ? "" : " (sorun bulunmadı)"}`);
  day.issues.forEach(i => L.push(`  - ${i}`));
  L.push(`- **Hata Avcısı (veri/rakam çapraz kontrolü):** ${day.locks.length ? `🔒 ${day.locks.length} rapor KİLİTLİ: ${day.locks.join(", ")}` : "✅ çelişki bulunmadı; metinlerdeki rakamlar TradingView kapanış geçmişiyle uyumlu"}`, "");
  { const wl = Object.entries(day.weights || {}).filter(([, o]) => o.src !== "eşit"); L.push(`- **Dinamik ağırlıklar (rejime duyarlı denetçi):** ${wl.length ? wl.map(([k, o]) => `${AR_NAME[k]} ×${fmt(o.w, 2)} (${o.src})`).join(", ") : "tüm ajanlar eşit ağırlıkta (her rejimde ≥ 30 ölçülmüş oy gerekir; henüz birikmedi)"}`, ""); }
  if (x.alarms && x.alarms.length) { L.push("## Gün içi alarmlar", ""); x.alarms.slice(0, 25).forEach(a => L.push(`- ${a.t || ""} ${a.sev >= 3 ? "🚨" : "⚠"} ${a.text}`)); L.push(""); }
  L.push("## Özet tablo", "", "| Hisse | Kapanış | Gün % | Skor | Karar | B | S | L | K | Ş | Yeni uzman net | Ağırlıklı karar | Stop olasılığı | Mühür |", "|---|---:|---:|---:|---|:-:|:-:|:-:|:-:|:-:|---:|---|---:|---|");
  const sym = v => v > 0 ? "+" : v < 0 ? "−" : "0";
  day.stocks.forEach(s => L.push(`| ${s.n} | ${fmt(s.close)} | ${s.change == null ? "–" : fmt(s.change, 1)} | ${s.score} | ${s.fact.locked ? "🔒 KİLİTLİ" : s.label + (s.veto ? " (VETO)" : "")} | ${sym(s.votes.buffett)} | ${sym(s.votes.simons)} | ${sym(s.votes.livermore)} | ${sym(s.votes.kellogg)} | ${sym(s.votes.seytan)} | ${s.net2} | ${s.fact.locked ? "–" : s.debate.text} | ${s.mc ? "%" + fmt(s.mc.probStop, 0) : "–"} | ${s.fact.locked ? "🔴" : "🟢"} |`));
  L.push("");
  day.stocks.forEach(s => {
    L.push(`## ${s.n}: ${s.desc || ""}`, "", `Kapanış ${fmt(s.close)} TL · gün ${s.change == null ? "–" : fmt(s.change, 2)}% · sektör ${s.sector ? trSector(s.sector) : "–"} · komite skoru **${s.score}** (${s.label}${s.veto ? ", Şeytanın Avukatı VETO" : ""})`, "");
    if (s.fact.locked) { L.push(`> 🔒 **RAPOR KİLİTLİ (Hata Avcısı).** Karar bölümü yayınlanmadı.`, `> ${s.fact.request}`, ""); L.push("### Oylar", ""); Object.entries(s.votes).forEach(([k, v]) => L.push(`- ${AR_NAME[k]}: ${AR_VOTE(v)}`)); L.push(""); return; }
    L.push("### Efsanelerin oyları", ""); Object.entries(s.votes).forEach(([k, v]) => L.push(`- **${AR_NAME[k]}:** ${AR_VOTE(v)}`));
    L.push("", `Yeni uzmanların net oyu: ${s.net2}${s.veto2 ? " (itiraz vetosu var)" : ""}`, "");
    if (s.mc) L.push(`### Monte Carlo (${s.mc.n.toLocaleString("tr-TR")} senaryo)`, "", `${s.mc.days} günlük ufuk, günlük oynaklık %${fmt(s.mc.sigma, 2)}: %5 / medyan / %95 getiri ${fmt(s.mc.p05, 1)}% / ${fmt(s.mc.p50, 1)}% / ${fmt(s.mc.p95, 1)}%; zarar olasılığı %${fmt(s.mc.probLoss, 0)}, %${s.mc.stop} stop'a değme olasılığı **%${fmt(s.mc.probStop, 0)}**. Sharpe (tarafsız sürüklenme, risksiz getiri %${fmt(s.mc.rf, 1)} düşülmüş) ${fmt(s.mc.sharpe0, 2)}${s.mcs ? `; Simons'ın model beklentisiyle Sharpe ${fmt(s.mcs.sharpe, 2)} (bilgi oranı ${fmt(s.mcs.ir, 2)})` : ""}; en kötü %5 senaryonun ortalaması (CVaR) ${fmt(s.mc.cvar5, 1)}%.`, "");
    if (s.mcm) { L.push("**Risk/ödül matrisi** (hücre: önce hedefe / önce stop'a değme olasılığı · beklenen değer %):", "", "| Hedef \\ Stop | " + s.mcm.cells[0].map(c => `−%${c[1]}`).join(" | ") + " |", "|---|" + s.mcm.cells[0].map(() => "---:").join("|") + "|"); s.mcm.cells.forEach(row => L.push(`| +%${row[0][0]} | ` + row.map(c => `%${fmt(c[2] * 100, 0)} / %${fmt(c[3] * 100, 0)} · E ${c[4] > 0 ? "+" : ""}${fmt(c[4], 1)}%`).join(" | ") + " |")); L.push(""); }
    if (s.stress) L.push("### Kara kuğu stres testi", "", s.stress.text, "");
    if (s.kelly) { L.push("### Pozisyon büyüklüğü (Kelly) ve izleyen stop", "", s.kelly.text, ""); if (s.kelly.edge) { L.push("| Tepe (R) | Tepe fiyat | İzleyen stop |", "|---|---:|---:|"); s.kelly.ladder.forEach(x => L.push(`| +${x[0]}R | ${fmt(x[1])} | ${fmt(x[2])} |`)); L.push(""); } }
    if (s.audit) { L.push(`### Bilanço denetimi (hakiki PD/DD): ${s.audit.verdict}`, ""); s.audit.items.filter(i => i[2]).forEach(i => L.push(`- ${i[0]}: ${i[1]} (${i[2]})`)); L.push(""); }
    if (s.sent) L.push(`### Haber duygusu (KAP/basın, son 3 gün)`, "", `Skor ${s.sent.score > 0 ? "+" : ""}${fmt(s.sent.score, 2)} (${s.sent.label}), ${s.sent.n} başlık${s.sent.kap ? `, ${s.sent.kap} KAP/özel durum türü` : ""}${s.sent.top ? `; en belirgin: "${s.sent.top}"` : ""}. Sözlük tabanlı okuma, oy değildir.`, "");
    L.push("### Masa tartışması", ""); s.lines.forEach(([w, t]) => L.push(`- **${(WHO_TXT[w] || w)}:** ${t}`));
    if (s.memory) { L.push("", "### Hafıza (geçmiş kararlar)", "", `Önceki kayıt: ${s.memory.ref.d} (${s.memory.ref.age} gün önce), masa skoru ${s.memory.ref.sc}, o günden fiyat ${s.memory.ref.px > 0 ? "+" : ""}${fmt(s.memory.ref.px, 1)}%.`); s.memory.flips.forEach(([k, a, b, tiny]) => L.push(`- ${AR_NAME[k]}: ${AR_VOTE(a)} → ${AR_VOTE(b)}${tiny ? " (eşik titremesi, fikir değişimi sayılmaz)" : ""}`)); if (!s.memory.flips.length) L.push("- Hiçbir efsane oyunu değiştirmedi (tutarlı)."); }
    L.push("", "### Boğa vs Ayı münazarası", "", `**Ağırlıklı karar skoru: ${s.debate.text} (${s.debate.label})**${s.debate.learned ? " · öğrenilmiş ağırlıklarla" : " · eşit ağırlık (öğrenme için yeterli sonuç birikmedi)"}`, "");
    s.debate.lines.forEach(([side, w, t]) => L.push(`- ${side === "bull" ? "🐂" : "🐻"} **${WHO_TXT[w] || w}:** ${t}`));
    L.push("", `Çürütülemeyen tezler: boğa ${s.debate.unrefBull}, ayı ${s.debate.unrefBear}.`);
    if (s.peer) { L.push("", `### Sektör ve rakip kıyası (${trSector(s.peer.sector)}, ${s.peer.n} hisse)`, "", "| Dönem | Hisse % | Sektör medyanı % | Piyasa medyanı % | Fark (puan) | Hareket |", "|---|---:|---:|---:|---:|---|"); s.peer.rows.forEach(([lab, st, sec, mk, rel, type]) => L.push(`| ${lab} | ${st == null ? "–" : fmt(st, 1)} | ${sec == null ? "–" : fmt(sec, 1)} | ${mk == null ? "–" : fmt(mk, 1)} | ${rel == null ? "–" : fmt(rel, 1)} | ${type || "–"} |`)); L.push("", `Sektör içi göreceli güç sırası: ${s.peer.rank || "–"}/${s.peer.rankOf}. Büyük rakipler: ${s.peer.peers.map(p => `${p.n} (gün ${p.change == null ? "–" : fmt(p.change, 1)}%, 1 ay ${p.p1m == null ? "–" : fmt(p.p1m, 1)}%)`).join("; ")}.`); }
    L.push("", `**${s.verdict}**`, "", `**Şeytanın Avukatı planı:** ${s.devil.plan}`, "", `Hata Avcısı: ${s.fact.stale ? "ham veri eski/yok, kıyaslanamadı" : `${s.fact.checked} rakam kontrol edildi, çelişki yok`} ✅`, "");
  });
  if (x.scorecard) { L.push("## Geri test skor kartı (komite kararlarının sonradan ölçümü)", "", x.scorecard, ""); }
  if (x.portfolios) { L.push("## Sanal portföyler", "", x.portfolios, ""); }
  L.push("---", "*Bu arşiv her seans kapanışında otomatik üretilir; geçmiş kararların izlenmesi ve geri test skor kartı için kalıcı kayıttır.*");
  return L.join("\n");
}

/* =====================================================================================
   EFSANELERİN HAFIZASI VE ÖĞRENMESİ: komite kararları picks.json'a (ve Arsiv/*.json'a) her seans kapanışında yazılır; efsaneler masaya oturunca
   aynı hissedeki GEÇMİŞ oylarına bakar, tersine döndüklerinde veriyle gerekçelendirir, "eşik titremesi" ile gerçek fikir değişimini ayırır.
   Öğrenme: her efsanenin olumlu/olumsuz oyunun, sonradan (10 iş günü, yoksa 5) piyasa ortalamasına göre tutup tutmadığı sayılır. Örnek ≥ 30 olunca
   isabet oranı o efsanenin ağırlıklı karar skorundaki ağırlığını (0,6–1,4) belirler; daha azsa ağırlık 1'dir (az örnekten ders çıkarılmaz).
   Hafıza komite skorunu ve sanal portföyleri DEĞİŞTİRMEZ; yalnızca yorumu ve ağırlıklı karar skorunu etkiler. */
let MEM = null;
const MEM_KEYS = ["buffett", "simons", "livermore", "kellogg", "seytan"];
function buildMemory(picks, regime) {
  const by = {}, skill = {}, skillR = {}, days = new Set(), K = MEM_KEYS.concat(["makro", "akilli", "vol", "psiko"]);
  K.forEach(k => { skill[k] = {n: 0, hit: 0}; skillR[k] = {bull: {n: 0, hit: 0}, mixed: {n: 0, hit: 0}, bear: {n: 0, hit: 0}}; });
  (picks || []).forEach(p => {
    if (p.src !== "komite" || !p.v) return; days.add(p.d); (by[p.n] = by[p.n] || []).push(p);
    const h = p.r && p.r[10] != null && p.b && p.b[10] != null ? 10 : p.r && p.r[5] != null && p.b && p.b[5] != null ? 5 : null; if (!h) return;
    const ex = p.r[h] - p.b[h], reg = regime && regime[p.d] ? regime[p.d].trend : null, all = p.v.concat(p.v2 || [0, 0, 0, 0]);
    K.forEach((k, i) => { const v = all[i]; if (!v) return; const ok = (v > 0 && ex > 0) || (v < 0 && ex < 0); skill[k].n++; if (ok) skill[k].hit++; if (reg && skillR[k][reg]) { skillR[k][reg].n++; if (ok) skillR[k][reg].hit++; } });
  });
  Object.values(by).forEach(a => a.sort((x, y) => x.d < y.d ? -1 : 1));
  return MEM = {by, skill, skillR, days: days.size};
}
function memWeight(k) { const w = memWeights()[k]; return w ? w.w : 1; }
function memBack(name) {
  const a = MEM && MEM.by[name]; if (!a) return null; const today = fcToday(), T = Date.parse(today);
  const old = a.filter(p => p.d < today && p.e > 0).map(p => ({p, age: Math.round((T - Date.parse(p.d)) / 864e5)})); if (!old.length) return null;
  old.sort((x, y) => Math.abs(x.age - 7) - Math.abs(y.age - 7)); return old[0];
}
const memAge = a => a <= 1 ? "Dün" : a <= 4 ? `${a} gün önce` : a <= 10 ? "Geçen hafta" : `${a} gün önce`;
const memWord = v => v > 0 ? "olumluydum" : v < 0 ? "olumsuzdum" : "nötrdüm";
function memReason(l) {
  const cs = l.checks || [], c = l.v > 0 ? cs.find(x => x.s === OK) : l.v < 0 ? cs.find(x => x.s === BAD) : null;
  return c ? `"${c.t.replace(/ \(.*?\)/g, "").replace(/:.*$/, "")}" ${c.s === OK ? "sağlanıyor" : "sağlanmıyor"}${c.val ? " (" + c.val + ")" : ""}` : "net bir üstünlük ya da zayıflık kalmadı";
}
function memoryLines(s, r) {
  const m = memBack(s.name); if (!m) return {lines: [], flips: [], ref: null};
  const p = m.p, px = (s.close / p.e - 1) * 100, lines = [], flips = [], say = (who, text) => lines.push({who, text, gen: true}), when = `${memAge(m.age)} (${p.d})`;
  say("simons", `Hafızaya baktım: ${when} bu hisse için masa skoru ${p.sc > 0 ? "+" : ""}${p.sc} idi, bugün ${r.score > 0 ? "+" : ""}${r.score}. Fiyat o günden ${px > 0 ? "+" : ""}${fmt(px, 1)}% oynadı (${fmt(p.e)} → ${fmt(s.close)} TL).`);
  MEM_KEYS.forEach((k, i) => {
    const pv = p.v[i], nv = r.l[k].v; if (pv == null || pv === nv) return;
    const hard = pv !== 0 && nv !== 0, tiny = Math.abs(px) < 1.5 && Math.abs(r.score - p.sc) <= 1;
    flips.push({k, from: pv, to: nv, hard, tiny, px});
    say(k, `${memAge(m.age)} bu hisse için ${memWord(pv)}${hard ? " (tam tersi)" : ""}; bugün ${nv > 0 ? "olumluyum" : nv < 0 ? "olumsuzum" : "nötrüm"}. ${tiny ? "Fiyat ve masa skoru neredeyse aynı; sinyal eşik sınırında dalgalanıyor, bunu kesin bir fikir değişikliği saymayın." : `Fikrim değişti çünkü ${memReason(r.l[k])}.`}`);
  });
  const same = MEM_KEYS.filter((k, i) => p.v[i] != null && p.v[i] === r.l[k].v && p.v[i] !== 0);
  if (same.length) say(same[0], `Yönümü koruyorum: ${when} ${memWord(p.v[MEM_KEYS.indexOf(same[0])])}, bugün de aynı${same.length > 1 ? "; masada " + same.slice(1).map(k => WHO_TXT[k]).join(", ") + " da yönünü korudu" : ""}. Geçmişte söylediğimle çelişmiyorum.`);
  const h = p.r && p.b && p.r[10] != null && p.b[10] != null ? 10 : p.r && p.b && p.r[5] != null && p.b[5] != null ? 5 : null;
  if (h) { const ex = p.r[h] - p.b[h]; say("seytan", `Sonuç notu: o günkü karardan ${h} iş günü sonra hisse piyasa ortalamasına göre ${ex > 0 ? "+" : ""}${fmt(ex, 1)} puan fark yaptı${p.sc >= 2 ? (ex > 0 ? "; o aday kararı doğru çıktı." : "; o aday kararı yanlış çıktı: aynı gerekçeyle ısrar etmiyorum, veriyi yeniden tartıyorum.") : "."}`); }
  return {lines, flips, ref: {d: p.d, sc: p.sc, age: m.age, px}};
}
/* Tutarlılık denetimi (Baş Denetçi): gerekçesiz tam ters oy ve zayıf konsensüs */
function consistencyIssues(s, r) {
  const out = [], mem = memoryLines(s, r);
  mem.flips.filter(f => f.hard && f.tiny).forEach(f => out.push(`${s.name}: ${WHO_TXT[f.k]} geçmişte tam tersi oy vermişti ama fiyat/skor neredeyse değişmedi (eşik titremesi; fikir değişimi sayılmaz).`));
  const d = debate(s, r); if (r.score >= 3 && !r.veto && d.sat >= 40) out.push(`${s.name}: "GÜÇLÜ ADAY" ama ağırlıklı karar skorunda %${d.sat} Sat oyu var; konsensüs zayıf.`);
  return out;
}

/* =====================================================================================
   BOĞA vs AYI MÜNAZARASI ve AĞIRLIKLI KARAR SKORU: 9 oy sahibi (5 efsane + 4 yeni uzman) oylarına göre boğa/ayı kampına ayrılır; her kamp kendi kontrol listesinden
   TEZ kurar, karşı kamp aynı konudaki (trend, değer, para akışı, risk, momentum) doğrulanmış maddeyle YANIT verir; yanıtsız kalan tezler "çürütülemedi" sayılır.
   Sonuç: oylar efsanenin öğrenilmiş ağırlığıyla çarpılıp %Al / %Tut / %Sat olarak toplanır. Not: bu bir tahmin değil, mevcut oyların özetidir. */
const DB_CAT = [["trend", /SMA|trend|RS\b|göreceli|haftalık|pivot|zirve|dip/i], ["değer", /F\/K|değer|iskonto|PD\/DD|ROE|kâr|borç|FCF|marj|temettü/i], ["akış", /CMF|para|hacim|takas|dağıtım|emilim|VİOP|alıcı/i], ["risk", /stop|oynaklık|likidite|bilanço|beta|düşüş|FOMO|kovalama|rejim|batma|sektör|haber/i], ["momentum", /RSI|momentum|kırılım|MACD|z-skor|bıçak|aşırı/i]];
const dbCat = t => { const c = DB_CAT.find(([, re]) => re.test(t)); return c ? c[0] : "diğer"; };
function debate(s, r) {
  const L = r.l, K = r.k2;
  const W = memWeights(), voters = MEM_KEYS.map(k => ({k, v: L[k].v, w: W[k].w, checks: L[k].checks || []})).concat(PERSONAS2_KEYS.map(k => ({k, v: K[k].v, w: W[k].w, checks: K[k].checks || []})));
  const pick = (pool, n) => { const out = [], seenC = new Set(); for (const p of pool) if (!seenC.has(p.cat) && out.length < n) { out.push(p); seenC.add(p.cat); } for (const p of pool) if (out.length < n && !out.includes(p)) out.push(p); return out; };
  const mk = (x, c) => ({who: x.k, text: c.t.replace(/ \(.*?\)/g, ""), val: c.val || "", cat: dbCat(c.t)});
  const poolOf = (voterList, st) => voterList.flatMap(x => x.checks.filter(c => c.s === st).map(c => mk(x, c)));
  const bulls = voters.filter(x => x.v > 0), bears = voters.filter(x => x.v < 0);
  let bullPool = poolOf(bulls, OK), bearPool = poolOf(bears, BAD).concat(poolOf(voters.filter(x => x.k === "seytan" && x.v >= 0), BAD));
  const appointedBull = !bulls.length, appointedBear = !bears.length;
  if (appointedBull) bullPool = poolOf(voters, OK); if (appointedBear) bearPool = poolOf(voters, BAD);
  const bearPts = pick(bearPool, 3), used = new Set(bearPts);
  const answer = (pts, pool) => pts.map(p => { const rb = pool.find(q => !used.has(q) && q.cat === p.cat); if (rb) used.add(rb); return {point: p, reply: rb || null}; });
  const bearRounds = answer(bearPts, bullPool);                        // 1. tur: ayı tezi, boğa yanıtı
  const bullPts = pick(bullPool.filter(q => !used.has(q)), 3), bullRounds = answer(bullPts, bearPool); // 2. tur: boğa tezi, ayı yanıtı (aynı madde iki kez gösterilmez)
  const unrefBear = bearRounds.filter(x => !x.reply).length, unrefBull = bullRounds.filter(x => !x.reply).length;
  const tot = voters.reduce((a, x) => a + x.w, 0), pct = f => voters.filter(f).reduce((a, x) => a + x.w, 0) / tot * 100;
  const al = Math.round(pct(x => x.v > 0)), sat = Math.round(pct(x => x.v < 0)), tut = 100 - al - sat;
  const label = r.veto ? "BEKLE (Şeytanın Avukatı vetosu)" : r.veto2 && al >= 50 ? "İZLE (uzman itirazı)" : al >= 50 ? "AL ağırlıklı" : sat >= 40 ? "SAT / UZAK DUR ağırlıklı" : "TUT / İZLE";
  const lines = [];
  bearRounds.forEach(x => { lines.push({side: "bear", who: x.point.who, text: `Ayı tezi: "${x.point.text}" sağlanmıyor${x.point.val ? " (" + x.point.val + ")" : ""}.`});
    lines.push({side: "bull", who: x.reply ? x.reply.who : "masa", text: x.reply ? `Boğa yanıtı: aynı konuda "${x.reply.text}" sağlanıyor${x.reply.val ? " (" + x.reply.val + ")" : ""}.` : `Boğa yanıtı: "${x.point.text}" itirazına veriyle cevap bulunamadı (çürütülemedi).`}); });
  bullRounds.forEach(x => { lines.push({side: "bull", who: x.point.who, text: `Boğa tezi: "${x.point.text}" sağlanıyor${x.point.val ? " (" + x.point.val + ")" : ""}.`});
    lines.push({side: "bear", who: x.reply ? x.reply.who : "masa", text: x.reply ? `Ayı yanıtı: aynı konuda "${x.reply.text}" sağlanmıyor${x.reply.val ? " (" + x.reply.val + ")" : ""}.` : `Ayı yanıtı: "${x.point.text}" tezine veriyle karşı çıkılamadı (çürütülemedi).`}); });
  return {voters: voters.map(x => ({k: x.k, v: x.v, w: x.w})), bull: {n: bulls.length, pts: bullPts, unref: unrefBull, appointed: appointedBull}, bear: {n: bears.length, pts: bearPts, unref: unrefBear, appointed: appointedBear},
    lines, al, tut, sat, label, learned: voters.some(x => x.w !== 1), text: `%${al} Al / %${tut} Tut / %${sat} Sat`};
}

/* =====================================================================================
   SEKTÖR VE RAKİP KIYASLAMASI (Peer Benchmark): aynı veri çekiminden (TradingView tarayıcı tablosu) hissenin sektör medyanı, piyasa medyanı ve en büyük 5 rakibiyle farkı.
   Her dönem için hareketi 3 katmana ayırır: piyasa → sektör (sektör − piyasa) → hisseye özel (hisse − sektör). Hareket sektörü izliyorsa SEKTÖREL, sektör sakinken
   ya da ters yöndeyken hareket ediyorsa HİSSEYE ÖZEL denir. Sektör medyanı hissenin kendisini içermez. */
// Sektör adları (TradingView İngilizce verir): çekirdekte tanımlı, arayüz ve arşiv aynı çeviriyi kullanır
const SECTORS = {"Finance": "Finans", "Non-Energy Minerals": "Enerji Dışı Madenler", "Energy Minerals": "Enerji / Madenler", "Transportation": "Ulaştırma", "Retail Trade": "Perakende",
  "Consumer Services": "Tüketici Hizmetleri", "Consumer Durables": "Dayanıklı Tüketim", "Consumer Non-Durables": "Dayanıksız Tüketim", "Electronic Technology": "Elektronik Teknoloji",
  "Technology Services": "Teknoloji Hizmetleri", "Health Technology": "Sağlık Teknolojisi", "Health Services": "Sağlık Hizmetleri", "Industrial Services": "Endüstriyel Hizmetler",
  "Process Industries": "Proses Sanayi", "Producer Manufacturing": "Üretici İmalat", "Distribution Services": "Dağıtım Hizmetleri", "Commercial Services": "Ticari Hizmetler",
  "Communications": "İletişim", "Utilities": "Kamu Hizmetleri", "Miscellaneous": "Çeşitli", "Government": "Kamu"};
const trSector = s => SECTORS[s] || s || "Diğer";
const secName = trSector;
const PEER_PERIODS = [["Bugün", "change", 1], ["1 ay", "p1m", 3], ["3 ay", "p3m", 5], ["6 ay", "p6m", 8]];
const medianOf = a => { const b = a.filter(x => x != null && Number.isFinite(x)).sort((x, y) => x - y); return b.length ? b[Math.floor((b.length - 1) / 2)] : null; };
function peerView(s) {
  const uni = ((typeof UNIVERSE !== "undefined" && UNIVERSE) || []).filter(x => x.ok && x.tl >= 5), grp = uni.filter(x => x.sector && x.sector === s.sector && x.name !== s.name);
  if (!s.sector || grp.length < 3) return null;
  const rows = PEER_PERIODS.map(([label, key, th]) => {
    const st = s[key], sec = medianOf(grp.map(x => x[key])), mkt = medianOf(uni.filter(x => x.name !== s.name).map(x => x[key]));
    if (st == null || sec == null || mkt == null) return {label, key, st, sec, mkt, rel: null, secRel: null, type: null};
    const rel = st - sec, secRel = sec - mkt, follow = Math.abs(rel) <= Math.max(th, 0.35 * Math.abs(st)), sameDir = sec * st > 0;
    const type = Math.abs(st) < th ? "sakin" : follow ? "sektörel" : (!sameDir || Math.abs(sec) < 0.35 * Math.abs(st)) ? "hisseye özel" : "karma";
    return {label, key, st, sec, mkt, rel, secRel, type};
  });
  const peers = grp.slice().sort((a, b) => (b.mcap || 0) - (a.mcap || 0)).slice(0, 5).map(x => ({n: x.name, change: x.change, p1m: x.p1m, rs: x.rs, pe: x.pe > 0 ? x.pe : null}));
  const byRs = [s, ...grp].filter(x => x.rs != null).sort((a, b) => b.rs - a.rs), rank = byRs.findIndex(x => x.name === s.name) + 1;
  const medPe = medianOf(grp.map(x => x.pe > 0 ? x.pe : null)), pePrem = s.pe > 0 && medPe > 0 ? (s.pe / medPe - 1) * 100 : null;
  const lead = rows.find(x => x.type && x.type !== "sakin") || null;
  return {sector: s.sector, n: grp.length + 1, rows, peers, rank: rank || null, rankOf: byRs.length, medPe, pePrem, lead};
}
function peerLines(s, r, pv) {
  if (!pv || !pv.lead) return [];
  const w = pv.lead, L = [], say = (who, text) => L.push({who, text, gen: true}), sg = x => (x > 0 ? "+" : "") + fmt(x, 1);
  const seg = secName(pv.sector);
  if (w.type === "sektörel") say("livermore", `Hareketin kaynağına baktım: ${w.label} ${seg} sektörü medyanı %${sg(w.sec)}, ${s.name} %${sg(w.st)}; hisse sektörü izliyor, yani bu bir ${w.st < 0 ? "sektörel düşüş" : "sektörel yükseliş"}, tek hissenin hikâyesi değil. Sektör piyasadan ${sg(w.secRel)} puan ${w.secRel >= 0 ? "güçlü" : "zayıf"}.`);
  else if (w.type === "hisseye özel") say("livermore", `${w.label} ${seg} sektörü medyanı %${sg(w.sec)} iken ${s.name} %${sg(w.st)}: bu hisseye özel bir hareket; sektör rüzgârı ${w.sec * w.st < 0 ? "ters yönde" : "yeterince eşlik etmiyor"}. Hareketin nedenini hissenin kendisinde (haber, bilanço, hacim) aramalıyız.`);
  else say("livermore", `${w.label} hareketin bir kısmı sektörden (${seg} %${sg(w.sec)}), bir kısmı hisseden: ${s.name} %${sg(w.st)}, sektörden ${sg(w.rel)} puan ayrışıyor.`);
  say("simons", `Sektöre göre artık getiri (${w.label}): ${sg(w.rel)} puan. Sektör içi göreceli güç sıralaması ${pv.rank || "–"}/${pv.rankOf}${pv.pePrem != null ? `; F/K sektör medyanının %${fmt(Math.abs(pv.pePrem), 0)} ${pv.pePrem > 0 ? "üstünde" : "altında"}` : ""}. Bu, hissenin kendi alfası ile sektör betasını ayırmamı sağlıyor.`);
  if (w.st < 0 && w.type === "hisseye özel") say("seytan", `Tersini düşünelim: sektör ayakta ama ${s.name} düşüyor. Sektörel bir bahane yok; hissenin kendi hikâyesi bozulmuş olabilir. Haber akışını ve bilanço takvimini kontrol etmeden "ucuzladı" demeyin.`);
  else if (w.st < 0 && w.type === "sektörel") say("seytan", `Düşüş sektörel: ${s.name} tek başına çürümüyor ama sektör dönmeden alım erken; sektör düzeltmeleri hisselerin hepsini birlikte çeker. Pozisyonu küçük tutun.`);
  else if (w.st > 0 && w.type === "hisseye özel") say("seytan", `Yükseliş hisseye özel, sektör eşlik etmiyor: tek başına giden hisse sektöre dönebilir ya da sektörü sürükleyebilir. Kovalamayın, stop'u önceden belirleyin.`);
  return L;
}

/* =====================================================================================
   AJAN İSABET ARENASI (Leaderboard): her ajanın geçmiş oylarının sonradan ölçülen başarısı. Ölçüt: piyasa ortalamasına göre fazla getiri (5/10/20 iş günü).
   Olumlu oy → hisse piyasayı yenerse isabet; olumsuz oy → piyasanın gerisinde kalırsa isabet. Sıralama %95 Wilson alt sınırına göredir (az örnekle şans eseri
   yükselenler öne geçmesin); n < 30 olanlar "yetersiz örnek" sayılır. Not: BIST'te tek bir tahminin tutma olasılığı %50-55 civarıdır; %80 gibi oranlar
   beklenmemeli, avantaj küçük ve çok işleme yayılınca birikir. Ardışık günlerin kayıtları örtüştüğünden gerçek bağımsız örnek sayısı n'den azdır. */
const ARENA_NAMES = {buffett: "Warren Buffett", simons: "Jim Simons", livermore: "Jesse Livermore", kellogg: "Jack Kellogg", seytan: "Şeytanın Avukatı", makro: "Makro & Jeopolitik Uzmanı", akilli: "Akıllı Para Takipçisi", vol: "Opsiyon & Volatilite Uzmanı", psiko: "Piyasa Psikolojisi Analisti"};
function wilson(k, n) { if (!n) return null; const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [(c - m) / d, (c + m) / d]; }
function arenaStats(picks, h) {
  const ex = p => p.r && p.b && p.r[h] != null && p.b[h] != null ? p.r[h] - p.b[h] : null, rows = {};
  const row = (id, name, kind) => rows[id] || (rows[id] = {id, name, kind, up: {n: 0, hit: 0, sum: 0}, dn: {n: 0, hit: 0, sum: 0}, pending: 0});
  const vote = (r, v, p) => { if (!v) return; const e = ex(p); if (e == null) { r.pending++; return; } const side = v > 0 ? r.up : r.dn; side.n++; side.sum += e; if ((v > 0 && e > 0) || (v < 0 && e < 0)) side.hit++; };
  const K5 = ["buffett", "simons", "livermore", "kellogg", "seytan"], K4 = ["makro", "akilli", "vol", "psiko"];
  let days = new Set(), total = 0;
  (picks || []).forEach(p => {
    if (p.src === "komite") {
      days.add(p.d); total++;
      if (p.v) K5.forEach((k, i) => vote(row(k, ARENA_NAMES[k], "oy"), p.v[i], p));
      if (p.v2) K4.forEach((k, i) => vote(row(k, ARENA_NAMES[k], "oy"), p.v2[i], p));
      vote(row("komite", "Komite (masa skoru ±2)", "komite"), p.sc >= 2 ? 1 : p.sc <= -2 ? -1 : 0, p);
    } else if (K5.includes(p.src)) vote(row("ekran:" + p.src, "Ekran: " + ARENA_NAMES[p.src], "ekran"), 1, p);
  });
  const out = Object.values(rows).map(r => { const n = r.up.n + r.dn.n, hit = r.up.hit + r.dn.hit, ci = wilson(hit, n);
    const status = n < 30 ? "yetersiz örnek" : ci[0] > 0.5 ? "anlamlı üstünlük" : ci[1] < 0.5 ? "anlamlı olarak kötü" : "şanstan ayırt edilemiyor";
    // örtüşme düzeltmesi: aynı hisse h gün boyunca art arda pencerelerde yer alır; bağımsız örnek ≈ n / h (daha dürüst, daha temkinli)
    const nEff = Math.floor(n / h), ciEff = nEff ? wilson(Math.round(hit / n * nEff), nEff) : null;
    const statusEff = nEff < 30 ? "yetersiz örnek" : ciEff[0] > 0.5 ? "anlamlı üstünlük" : ciEff[1] < 0.5 ? "anlamlı olarak kötü" : "şanstan ayırt edilemiyor";
    return {...r, n, hit, rate: n ? hit / n : null, ci, status, nEff, ciEff, statusEff, avgUp: r.up.n ? r.up.sum / r.up.n : null, upRate: r.up.n ? r.up.hit / r.up.n : null, dnRate: r.dn.n ? r.dn.hit / r.dn.n : null}; });
  out.sort((a, b) => (b.ci ? b.ci[0] : -1) - (a.ci ? a.ci[0] : -1) || b.n - a.n);
  return {h, rows: out, days: days.size, total, measured: out.reduce((a, r) => a + r.n, 0)};
}

/* =====================================================================================
   YÜKSEK GÜVENİLİRLİKLİ SİNYAL (Telegram/bildirim için): yalnızca tüm koşullar birlikte sağlanırsa. Her koşul geçmiş araştırmaya ya da bir denetime dayanır:
   masa skoru ≥ 3 · Şeytanın Avukatı ve uzman vetosu yok · haftalık çok zamanlı skor lider (araştırmanın en tutarlı grubu) · Monte Carlo stop olasılığı < %60 ·
   Hata Avcısı kilidi yok. Bu, kazanç garantisi değildir; yalnızca "tüm kontrollerden geçti" demektir. */
function highConfidence(s, r) {
  const t = mtfTier(s), lead = t && (t.id === "uyumlu" || t.id === "hlider"), mc = monteCarlo(s), f = factCheck(s, r), why = [];
  if (r.score < 3) why.push("masa skoru < 3"); if (r.veto) why.push("Şeytanın Avukatı vetosu"); if (r.veto2) why.push("uzman itirazı"); if (!lead) why.push("haftalık lider değil");
  if (mc && mc.probStop >= 60) why.push("stop olasılığı yüksek"); if (f.locked) why.push("rapor kilitli (Hata Avcısı)");
  return {ok: !why.length, why, debate: debate(s, r).text, stop: mc ? Math.round(mc.probStop) : null, tier: t ? t.label : null};
}

/* =====================================================================================
   SEVİYE GRAFİĞİ VERİSİ (mum grafiği üzerine Livermore ve Simons katmanları): saf hesap, çizim arayüzde (template.html).
   Livermore: pivot (1 aylık zirve), yanılma noktası (pivotun %3 altı), SMA50/SMA200, 52 hafta zirvesi, 60 günlük en küçük kareler trend çizgisi ("en az direnç çizgisi").
   Simons: 20 günlük ortalama etrafında ±1σ ve ±2σ sapma bantları (z-skor), ±2σ dışındaki günler işaretlenir; bugünkü z-skor. */
function levelsData(s, cand) {
  if (!cand || !cand.c) return null;
  const idx = cand.c.map((v, i) => v != null && cand.o[i] != null && cand.h[i] != null && cand.l[i] != null ? i : -1).filter(i => i >= 0);
  if (idx.length < 40) return null;
  const pick = a => idx.map(i => a[i]), o = pick(cand.o), h = pick(cand.h), l = pick(cand.l), c = pick(cand.c), n = c.length, dates = idx.map(i => cand.dates[i]);
  const sma = (k, i) => i >= k - 1 ? fcAvg(c.slice(i - k + 1, i + 1)) : null, sma20 = c.map((_, i) => sma(20, i)), sma50 = c.map((_, i) => sma(50, i));
  const sd20 = c.map((_, i) => i >= 19 ? fcSd(c.slice(i - 19, i + 1)) : null), z = c.map((v, i) => sd20[i] > 0 ? (v - sma20[i]) / sd20[i] : null);
  const m = Math.min(60, n), xs = Array.from({length: m}, (_, i) => i), ys = c.slice(n - m), mx = fcAvg(xs), my = fcAvg(ys);
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0), icpt = my - slope * mx;
  const trend = {from: n - m, y0: icpt, y1: icpt + slope * (m - 1), slopePct: slope / my * 100};
  const liv = [];
  if (s.h1m > 0) { liv.push({y: s.h1m, label: "Pivot (1 aylık zirve)", kind: "pivot"}); liv.push({y: s.h1m * 0.97, label: "Yanılma noktası (pivot −%3)", kind: "stop"}); }
  if (s.sma50 > 0) liv.push({y: s.sma50, label: "SMA50", kind: "ma"});
  if (s.sma200 > 0) liv.push({y: s.sma200, label: "SMA200", kind: "ma"});
  if (s.h52 > 0) liv.push({y: s.h52, label: "52 hafta zirvesi", kind: "hi"});
  const marks = z.map((v, i) => v != null && Math.abs(v) > 2 ? {i, z: v} : null).filter(Boolean);
  const lv = livermore(s);
  return {dates, o, h, l, c, sma20, sma50, sd20, z, trend, liv, marks, zNow: z[n - 1], livVote: lv.v, simVote: simons(s).v, pivotNear: s.h1m ? s.close / s.h1m : null};
}

/* =====================================================================================
   1) BİLANÇO DENETİM KATMANI ve HAKİKİ PD/DD: yüzeysel oranların arkasına bakar. Net borç (finansal borç − nakit), özsermaye yapısı, net borç/özsermaye ve /FAVÖK,
   nakit dönüşümü (serbest nakit akışı / net kâr), TMS 29 (enflasyon muhasebesi) kaynaklı şüpheli rakamlar (taban etkisi, olağandışı ROE), F/K ve ROE tutarlılığı.
   Hakiki PD/DD = piyasa PD/DD ÷ gerekçeli PD/DD (gerekçeli PD/DD = (reel ROE − g) / (reel iskonto − g), valuation ile aynı); 1'in üstü pahalı. Ek olarak
   "fiyat / yatırılan sermaye" = (piyasa değeri + net borç) / (özsermaye + net borç): borçla şişmiş şirketlerde PD/DD'nin gizlediği tabloyu gösterir.
   Buffett'ın yorumuna eklenir; oyunu değiştirmez (oyun kuralları araştırmayla kalibre edildi). Banka/finans için borç ölçütleri geçersizdir. */
function balanceAudit(s) {
  const fin = isFin(s), m = macro(), iv = intrinsic(s), shares = s.mcap > 0 && s.close > 0 ? s.mcap / s.close : null;
  const equity = s.bvps > 0 && shares ? s.bvps * shares : null, nd = s.debt != null ? s.debt - (s.cash || 0) : null;
  const ndEq = nd != null && equity ? nd / equity : null, ndEbitda = nd != null && s.ebitda > 0 ? nd / s.ebitda : null;
  const pb = s.pb > 0 ? s.pb : s.bvps > 0 ? s.close / s.bvps : null, rj = roePbValue(s, iv), ratio = pb != null && rj ? pb / rj.pbJ : null;
  const evInv = nd != null && s.mcap > 0 && equity ? (s.mcap + nd) / (equity + Math.max(nd, 0)) : null;
  const roeReal = s.roe != null ? ((1 + s.roe / 100) / (1 + m.infl) - 1) * 100 : null, items = [];
  const add = (key, label, val, flag, note) => items.push({key, label, val, flag, note: note || ""});
  const bn = x => x == null ? "–" : (x < 0 ? "−" : "") + fmt(Math.abs(x) / 1e9, 2) + " mlr TL";
  if (fin) add("fin", "Borç ölçütleri", "banka/finans: geçerli değil", null, "Finansal kuruluşlarda borç faaliyetin hammaddesidir; özsermaye ve ROE'ye bakılır.");
  else {
    add("nd", "Net borç (finansal borç − nakit)", nd == null ? "–" : nd <= 0 ? `net nakit ${bn(-nd)}` : bn(nd), nd == null ? null : nd <= 0 ? "ok" : null);
    add("ndEq", "Net borç / özsermaye", ndEq == null ? "–" : fmt(ndEq, 2), ndEq == null ? null : ndEq <= 0.5 ? "ok" : ndEq <= 1.5 ? "uyarı" : "kötü", "≤ 0,5 rahat; > 1,5 borç özsermayeyi aşıyor.");
    add("ndEbitda", "Net borç / FAVÖK", ndEbitda == null ? (nd != null && nd <= 0 ? "net nakit" : "–") : fmt(ndEbitda, 1) + "x", ndEbitda == null ? (nd != null && nd <= 0 ? "ok" : null) : ndEbitda <= 2.5 ? "ok" : ndEbitda <= 4 ? "uyarı" : "kötü", "borcun faaliyet kârıyla kaç yılda kapanacağı.");
    const ni = s.eps > 0 && shares ? s.eps * shares : null, conv = s.fcf != null && ni ? s.fcf / ni : null;
    add("conv", "Nakit dönüşümü (serbest nakit akışı / net kâr)", conv == null ? "–" : fmt(conv, 2) + "x", conv == null ? null : conv >= 0.7 ? "ok" : conv >= 0 ? "uyarı" : "kötü", "kâr nakde dönmüyorsa (< 0,3x) muhasebe kârı kalitesizdir.");
    add("cr", "Cari oran", s.cr == null ? "–" : fmt(s.cr, 2), s.cr == null ? null : s.cr >= 1.2 ? "ok" : s.cr >= 1 ? "uyarı" : "kötü", "kısa vadeli borcu ödeme gücü.");
  }
  add("eq", "Özsermaye (defter değeri)", equity == null ? "–" : bn(equity), s.bvps == null ? null : s.bvps > 0 ? "ok" : "kötü", s.bvps != null && s.bvps <= 0 ? "Negatif özsermaye: PD/DD anlamsız." : "");
  add("pb", "Piyasa PD/DD", pb == null ? "–" : fmt(pb, 2), null);
  add("pbj", "Gerekçeli PD/DD (reel ROE ve iskonto oranına göre)", rj ? fmt(rj.pbJ, 2) : "–", null, "sürdürülebilir reel ROE yarı yarıya iskonto oranına sönümlenerek hesaplanır.");
  add("hakiki", "HAKİKİ PD/DD (piyasa ÷ gerekçeli)", ratio == null ? "–" : fmt(ratio, 2) + "x", ratio == null ? null : ratio <= 1 ? "ok" : ratio <= 1.5 ? "uyarı" : "kötü", ratio == null ? "" : ratio <= 1 ? "gerekçeli değerin altında/yanında: iskontolu." : "gerekçeli PD/DD'nin " + fmt((ratio - 1) * 100, 0) + "% üstünde.");
  if (!fin) add("evinv", "Fiyat / yatırılan sermaye ((piyasa değeri+net borç)/(özsermaye+net borç))", evInv == null ? "–" : fmt(evInv, 2) + "x", null, "borçlu şirketlerde PD/DD'nin düşük göstermesini düzeltir.");
  add("roe", "Reel ROE (enflasyon düşülmüş)", roeReal == null ? "–" : pc(roeReal), roeReal == null ? null : s.roe > 80 ? "uyarı" : roeReal >= 5 ? "ok" : roeReal >= -5 ? "uyarı" : "kötü", s.roe > 80 ? "ROE > %80: TMS 29 parasal kazancı ya da tek seferlik kalem olabilir; sürdürülebilir saymayın." : "");
  const base = s.epsg != null && Math.abs(s.epsg) > 200;
  add("epsg", "EPS büyümesi", s.epsg == null ? "–" : pc(s.epsg), base ? "uyarı" : null, base ? "|büyüme| > %200: taban etkisi; değerlemede büyüme sıfır alındı." : "");
  const peImp = s.eps > 0 ? s.close / s.eps : null, peOk = peImp == null || s.pe == null ? null : Math.abs(peImp / s.pe - 1) <= 0.15;
  add("pe", "F/K tutarlılığı (tablo F/K ↔ fiyat/EPS)", peOk == null ? "–" : peOk ? "tutarlı" : `tabloda ${fmt(s.pe, 1)}, fiyat/EPS ${fmt(peImp, 1)}`, peOk == null ? null : peOk ? "ok" : "uyarı", "TTM ve dönem EPS'i farklıysa fark çıkabilir.");
  const roeImp = s.eps > 0 && s.bvps > 0 ? s.eps / s.bvps * 100 : null, roeOk = roeImp == null || s.roe == null ? null : Math.abs(roeImp - s.roe) <= Math.max(10, 0.4 * Math.abs(s.roe));
  add("roeimp", "ROE tutarlılığı (EPS/defter değeri ↔ tablo ROE)", roeOk == null ? "–" : roeOk ? "tutarlı" : `tabloda ${pc(s.roe)}, EPS/DD ${pc(roeImp)}`, roeOk == null ? null : roeOk ? "ok" : "uyarı", "uyumsuzluk enflasyon düzeltmesi/dönem farkından olabilir.");
  const bad = items.filter(x => x.flag === "kötü").length, warn = items.filter(x => x.flag === "uyarı").length, known = items.filter(x => x.flag).length;
  const verdict = !known ? "VERİ YETERSİZ" : bad >= 2 || (bad >= 1 && warn >= 2) ? "ZAYIF BİLANÇO" : bad || warn >= 2 ? "DİKKAT" : "TEMİZ";
  const parts = [];
  if (!fin && nd != null) parts.push(nd <= 0 ? `net nakit pozisyonu (${bn(-nd)})` : `net borç ${bn(nd)}${ndEq != null ? ` (özsermayenin ${fmt(ndEq, 1)} katı)` : ""}${ndEbitda != null ? `, FAVÖK'e göre ${fmt(ndEbitda, 1)} yıllık` : ""}`);
  if (ratio != null) parts.push(`PD/DD ${fmt(pb, 2)}, gerekçeli PD/DD ${fmt(rj.pbJ, 2)}: hakiki PD/DD ${fmt(ratio, 2)}x (${ratio <= 1 ? "iskontolu" : ratio <= 1.5 ? "biraz pahalı" : "pahalı"})`);
  if (!fin && evInv != null && ndEq != null && ndEq > 0.5) parts.push(`borcu sayınca fiyat/yatırılan sermaye ${fmt(evInv, 2)}x`);
  const warns = items.filter(x => x.flag === "uyarı" || x.flag === "kötü").map(x => x.label.split(" (")[0].toLowerCase());
  const text = known ? `Bilanço denetimi (${trLower(verdict)}): ${parts.length ? parts.join("; ") + "." : ""}${warns.length ? " Dikkat çeken: " + warns.slice(0, 4).join(", ") + "." : ""}` : "";
  return {items, verdict, text, pb, pbJ: rj ? rj.pbJ : null, ratio, evInv, ndEq, ndEbitda, nd, equity, roeReal, bad, warn};
}

/* =====================================================================================
   2) TAKAS FİLTRESİ (kullanıcının kendi AKD/takas CSV'si): birden çok günün ilk-5 alıcı/satıcı dengesi ve takas saklama yoğunluğundan
   BİRİKİM (mal toplanıyor) ya da DAĞITIM (mal boşaltılıyor) tespiti; fiyatla ayrışma (fiyat düşerken alım = sessiz birikim; fiyat yükselirken satış = yükselirken boşaltma).
   Veri herkese açık değil (lisanslı) ve geçmiş testi yoktur; bu yüzden oy yalnızca kullanıcı "oya kat" seçeneğini açarsa ve ≥ 3 gün verisi varsa etkiler. */
function akdState(au, s) {
  if (!au || !au.hist || au.hist.length < 2) return null;
  const h = au.hist.slice(-5), last3 = h.slice(-3), avg = a => a.reduce((x, y) => x + y, 0) / a.length, b3 = avg(last3.map(x => x.bal || 0));
  const dir = b3 >= 0.08 ? 1 : b3 <= -0.08 ? -1 : 0, consist = dir === 0 ? 0 : h.filter(x => Math.sign(x.bal || 0) === dir).length / h.length;
  const sk = h.filter(x => x.sak5 != null), skD = sk.length >= 2 ? sk[sk.length - 1].sak5 - sk[0].sak5 : null;
  const strong = dir !== 0 && h.length >= 3 && consist >= 0.67;
  const state = dir > 0 ? (strong ? "birikim" : "olası birikim") : dir < 0 ? (strong ? "dağıtım" : "olası dağıtım") : "nötr";
  const px = s && s.pw != null ? s.pw : null;
  const div = dir > 0 && px != null && px <= 0 ? "sessiz birikim: fiyat yatay/düşerken ilk 5 alıcı baskın" : dir < 0 && px != null && px >= 0 ? "yükselirken boşaltma: fiyat yükselirken ilk 5 satıcı baskın" : null;
  const cust = skD == null ? null : skD >= 2 ? "takas saklama yoğunluğu artıyor (az elde toplanma)" : skD <= -2 ? "takas saklama yoğunluğu azalıyor (dağılma)" : "takas saklama yoğunluğu sabit";
  const text = `${au.hist.length} günlük AKD: son 3 gün ortalama ilk5 alıcı−satıcı dengesi %${fmt(b3 * 100, 1)} → ${state.toUpperCase()}${strong ? "" : " (teyit için daha çok gün/tutarlılık gerekir)"}${div ? "; " + div : ""}${cust ? "; " + cust : ""}.`;
  return {state, dir, strong, b3, days: au.hist.length, consist, div, cust, skD, text};
}

/* =====================================================================================
   3) MONTE CARLO RİSK ve STRES TESTİ: 10.000 senaryo (geometrik Brownian hareket, sigma = gerçekleşen oynaklık, ufuk = R.mDays gün, tarafsız sürüklenme).
   monteCarlo(): olasılık dağılımı, ortalama/σ, Sharpe (risksiz getiri düşülmüş, tarafsız sürüklenmeyle), CVaR%5 (en kötü %5 senaryonun ortalaması), stop olasılığı.
   mcMatrix(): risk/ödül matrisi: hedef (+5/10/15/20%) ve stop (−5/8/10%) çiftleri için "hangisine önce değer" olasılığı ve beklenen değer.
   mcSharpe(): Simons'ın modelinin beklenen fazla getirisi eklenerek model Sharpe ve bilgi oranı. Jim Simons ve Şeytanın Avukatı bu çıktıları kullanır. */
const MC_T = [5, 10, 15, 20], MC_S = [5, 8, 10];
function mcSharpe(s, exp) {
  const mc = monteCarlo(s); if (!mc || exp == null || !(mc.sd > 0)) return null;
  const e = exp * mc.days / 10; // beklenti 10 günlük; ufka ölçekle
  return {exp: e, sharpe: (mc.mean + e - mc.rf) / mc.sd, ir: e / mc.sd, rf: mc.rf};
}
function mcMatrix(s, n = 10000) {
  const key = "m:" + s.name; if (mcCache[key]) return mcCache[key];
  const sg = sigmaOf(s); if (!sg) return null;
  const days = Math.max(1, Math.round(R.mDays)), sigma = Math.max(sg.v, 1e-4), z = mcZ(n, days), drift = -0.5 * sigma * sigma, nT = MC_T.length, nS = MC_S.length;
  const lT = MC_T.map(T => Math.log(1 + T / 100)), lS = MC_S.map(S => Math.log(1 - S / 100)); // eşikler log uzayında: adım başına exp gerekmez
  const tHit = new Int32Array(nT * nS), sHit = new Int32Array(nT * nS), done = new Uint8Array(nT * nS);
  for (let i = 0, kz = 0; i < n; i++) {
    done.fill(0); let lp = 0;
    for (let d = 0; d < days; d++, kz++) {
      lp += drift + sigma * z[kz];
      for (let a = 0; a < nT; a++) for (let b = 0; b < nS; b++) { const k = a * nS + b; if (done[k]) continue; if (lp >= lT[a]) { tHit[k]++; done[k] = 1; } else if (lp <= lS[b]) { sHit[k]++; done[k] = 1; } }
    }
  }
  const cells = MC_T.map((T, a) => MC_S.map((S, b) => { const k = a * nS + b, pT = tHit[k] / n, pS = sHit[k] / n; return {T, S, pT, pS, pN: 1 - pT - pS, rr: T / S, ev: pT * T - pS * S, be: S / (T + S)}; }));
  const flat = cells.flat(), best = flat.reduce((x, y) => y.ev > x.ev ? y : x);
  return mcCache[key] = {T: MC_T, S: MC_S, cells, days, n, best};
}

/* =====================================================================================
   4) REJİME DUYARLI ÖZ-DÜZENLEMELİ AĞIRLIK (dinamik denetçi): her ajanın isabeti piyasa rejimine (boğa / yatay-geçiş / ayı) göre ayrı izlenir.
   Bir rejimde ≥ 30 ölçülmüş oy varsa o rejimin isabeti, yoksa genel isabet (≥ 30), yoksa eşit ağırlık (1) kullanılır. Ağırlık = clamp(1 + (isabet − 0,5) × 2, 0,6, 1,4).
   Ağırlık yalnızca ağırlıklı karar skorunu etkiler; komite skoru ve sanal portföyler değişmez. */
function memWeights(regimeKey) {
  const reg = regimeKey === undefined ? (REGIME ? REGIME.trend : null) : regimeKey, out = {};
  MEM_KEYS.concat(["makro", "akilli", "vol", "psiko"]).forEach(k => {
    const sk = MEM && MEM.skill[k], skr = MEM && MEM.skillR && MEM.skillR[k] && reg ? MEM.skillR[k][reg] : null, f = x => Math.max(0.6, Math.min(1.4, 1 + (x.hit / x.n - 0.5) * 2));
    if (skr && skr.n >= 30) out[k] = {w: f(skr), src: "rejim", n: skr.n, rate: skr.hit / skr.n};
    else if (sk && sk.n >= 30) out[k] = {w: f(sk), src: "genel", n: sk.n, rate: sk.hit / sk.n};
    else out[k] = {w: 1, src: "eşit", n: sk ? sk.n : 0, rate: sk && sk.n ? sk.hit / sk.n : null};
  });
  Object.keys(out).forEach(k => { const pw = PAPER_W[k]; out[k].paper = pw || null; if (pw && pw.w !== 1) { out[k].hitW = out[k].w; out[k].w = Math.max(0.5, Math.min(1.5, out[k].w * pw.w)); } });
  return out;
}
/* rejim bazlı en başarılı ajan (≥ 30 ölçülmüş oy ve Wilson alt sınırına göre) */
function arenaByRegime(picks, h, regimeMap) {
  const out = {};
  ["bull", "mixed", "bear"].forEach(g => {
    const sub = (picks || []).filter(p => regimeMap && regimeMap[p.d] && regimeMap[p.d].trend === g), A = arenaStats(sub, h);
    const top = A.rows.filter(r => r.n >= 30 && r.kind === "oy" && r.rate > 0.5).sort((a, b) => b.ci[0] - a.ci[0])[0] || null;
    out[g] = {measured: A.measured, top: top && {id: top.id, name: top.name, n: top.n, rate: top.rate, lo: top.ci[0]}, rows: A.rows};
  });
  return out;
}

/* =====================================================================================
   5) HABER / KAP DUYGU KATMANI (Türkçe sözlük tabanlı NLP): başlıkları olumsuzlama, yön değiştiren kalıplar ("zararı azaldı" = olumlu, "kârı düştü" = olumsuz)
   ve KAP olay türü ağırlıklarıyla (temettü, bedelsiz, geri alım, ihale, dava, tedbir, konkordato ...) −1..+1 puanlar; hisse bazında son 3 günün başlıklarını
   yeniliğe göre ağırlıklandırıp toplar. KAP'ın kendi API'si buradan güvenilir erişilemedi; KAP kaynaklı başlıklar Google Haberler akışıyla (news.json, 15 dakikada bir) gelir.
   Sosyal medya (X/forum) için ücretsiz güvenilir kaynak yoktur: dahil değildir. Bu bir makine öğrenmesi modeli değil, kurallı sözlük yöntemidir; başlıkları okuyun. Oy vermez, bilgi olarak masaya iletilir. */
const SENT_RULES = [ // yön değiştiren kalıplar: önce uygulanır, eşleşen kısım sözlüğe girmez
  [/(zarar|borç|maliyet|gider)\w*.{0,28}?(azal|düş|geriled|iyileş|kapan)/, 1.2], [/(zarar|borç|maliyet|gider)\w*.{0,28}?(art|yüksel|büyü|derinleş)/, -1.3],
  [/(kâr|kar|gelir|satış|hasılat|marj|sipariş|ihracat)\w*.{0,28}?(düş|azal|geriled|eridi|daral)/, -1.2], [/(kâr|kar|gelir|satış|hasılat|marj|sipariş|ihracat)\w*.{0,28}?(art|yüksel|büyü|rekor|katla|iyileş)/, 1.2],
  [/zarar (etmedi|açıklamadı)|kâra geçti|kara geçti|zarardan kâra/, 1.4], [/kâr(a|ı)?\s*(ulaşamadı|açıklayamadı)|zarara geçti|zarara döndü/, -1.5]];
const SENT_POS = [[/rekor/, 1.2], [/temettü|kâr payı|kar payı/, 1], [/bedelsiz/, 1.2], [/geri alım/, 1], [/ihale|sipariş|sözleşme imza|anlaşma imza|yeni anlaşma|iş ilişkisi/, 0.8], [/hedef fiyat\w*.{0,15}(yükselt|artır)/, 1], [/al tavsiyesi|endeksin üzerinde getiri|olumlu/, 0.8],
  [/yükseliş|yükseldi|arttı|artış|büyüme|büyüdü|güçlü|onay|yatırım|kapasite artış|tavan|rekabetçi|kazandı/, 0.6]];
const SENT_NEG = [[/konkordato|iflas|işlem yasağı|sermaye kaybı|tasfiye/, -2], [/borç yapılandırma|temerrüt|haciz|ödeyemedi/, -1.6], [/soruşturma|dava|ceza\b|ceza(sı)?|tedbir|yasak|fesih|iptal/, -1.2], [/zarar|zarara/, -1.1],
  [/açığa satış|satış tavsiyesi|hedef fiyat\w*.{0,15}(düşür|indir)|endeksin altında getiri/, -0.9], [/düşüş|geriledi|azaldı|düştü|daraldı|kayıp|taban/, -0.7], [/bedelli|sermaye artırımı/, -0.5], [/uyarı|riskli|belirsizlik|olumsuz|baskı/, -0.5]];
const SENT_NEGATE = /(değil|olmadı|olmayacak|gerçekleşmedi|beklenmiyor|yok)\b/;
function sentiment(title) {
  let t = trLower(title), score = 0; const hits = [];
  for (const [re, w] of SENT_RULES) { const m = t.match(re); if (m) { score += w; hits.push(m[0].slice(0, 28)); t = t.replace(re, " "); } }
  for (const [re, w] of SENT_POS) { const m = t.match(re); if (m) { const neg = SENT_NEGATE.test(t.slice(m.index, m.index + m[0].length + 24)); score += neg ? -0.6 * w : w; hits.push((neg ? "¬" : "") + m[0].slice(0, 20)); } }
  for (const [re, w] of SENT_NEG) { const m = t.match(re); if (m) { const neg = SENT_NEGATE.test(t.slice(m.index, m.index + m[0].length + 20)); score += neg ? -0.5 * w : w; hits.push((neg ? "¬" : "") + m[0].slice(0, 20)); } }
  return {score: Math.max(-1, Math.min(1, score / 2)), hits};
}
const KAP_TAGS = /temettü|kâr payı|bedelsiz|geri alım|ihale|sözleşme|bilanço|finansal sonuç|dava|soruşturma|tedbir|işlem yasağı|konkordato|sermaye artırımı|bedelli|pay alım|özel durum|kap\b/;
function stockSentiment(name, nowMs) {
  const n = typeof NEWS !== "undefined" && NEWS ? NEWS[name] : null; if (!n || !n.items || !n.items.length) return null;
  const now = (nowMs || (typeof NOW === "number" ? NOW : Date.now())) / 1000, rows = n.items.map(i => ({t: i.t, ts: i.ts, age: (now - i.ts) / 86400, s: sentiment(i.t).score})).filter(x => x.age <= 3 && x.age >= -0.2);
  if (!rows.length) return null;
  let sw = 0, sv = 0; rows.forEach(x => { const w = Math.pow(0.5, Math.max(0, x.age) / 1.5); sw += w; sv += w * x.s; });
  const score = sv / sw, kap = rows.filter(x => KAP_TAGS.test(trLower(x.t))).length, ext = rows.slice().sort((a, b) => Math.abs(b.s) - Math.abs(a.s))[0];
  return {score, n: rows.length, kap, label: score >= 0.2 ? "pozitif" : score <= -0.2 ? "negatif" : "nötr", top: ext && ext.t, topScore: ext && ext.s, pos: rows.filter(x => x.s > 0.15).length, neg: rows.filter(x => x.s < -0.15).length};
}

/* =====================================================================================
   KAP VE ARACI KURUM AKIŞI (TradingView haber akışı): başlıklar sağlayıcıya göre ayrılır: KAP bildirimleri (provider=kap), aracı kurum raporları (Matriks üzerinden,
   başlık sonundaki "(Kurum Adı)"), diğer (Reuters, Matriks haber). Kurum raporlarının başlığında öneri/hedef fiyat yoktur: yalnızca KİM, NE ZAMAN yazdığı bilinir
   (kapsam yoğunluğu). Çok sembollü sektör/piyasa raporları (rel > 3) "genel" sayılır. */
const BROKER_RE = /yatırım|menkul|securities|bank|capital|değerler|invest|ak yat|gedik|tera|info|şeker|oyak|deniz|destek|kuzey|garanti|işbank|is yatirim/i;
function newsBreakdown(name) {
  const n = typeof NEWS !== "undefined" && NEWS ? NEWS[name] : null; if (!n || !n.items) return null;
  const now = (typeof NOW === "number" ? NOW : Date.now()) / 1000, kap = [], brokers = [], other = [];
  n.items.forEach(i => {
    const age = (now - i.ts) / 86400; if (age > 10 || age < -0.5) return;
    if (i.p === "kap") { kap.push(i); return; }
    const m = String(i.t).match(/\(([^()]*)\)\s*$/), kurum = m && BROKER_RE.test(m[1]) ? m[1].trim() : null;
    if (kurum && (i.p === "matriks" || !i.p)) brokers.push({t: i.t, ts: i.ts, kurum, specific: (i.rel == null ? 9 : i.rel) <= 3, s: sentiment(i.t).score}); else other.push(i);
  });
  const kurumlar = [...new Set(brokers.map(b => b.kurum))];
  return {kap, brokers, other, kurumlar, specific: brokers.filter(b => b.specific)};
}

/* =====================================================================================
   KALİTELİ AMA DÜŞÜŞTE (izleme listesi): Buffett kalite ölçütlerini (büyüklük, kârlılık, reel ROE, marj, borç, nakit akışı, büyüme) geçen, bilanço denetimi
   "zayıf" olmayan, ama fiyatı SMA50'nin altında ve (1 ayda ≥ %8 düşmüş ya da 52 hafta zirvesinden ≥ %25 aşağıda) olan likit hisseler.
   DİKKAT: bu bir alım sinyali değildir. Araştırmamız düşen bıçağın (aşırı düşüş, panik satışı) geçmişte devam ettiğini gösterdi; liste "teyit bekleyen" hisseleri toplar.
   Toparlanma işaretleri (para girişi, SMA20 üstü, haftalık para akışı, 'toparlanan' kurulum) ve düşüşün sektörel mi hisseye özel mi olduğu yanında gösterilir. */
const QD_P = {minQual: 55, minTl: 20, p1m: -8, dd52: -25};
const avgTl = s => (s.av30 > 0 ? s.av30 : s.av60 > 0 ? s.av60 : s.volume || 0) * (s.close || 0) / 1e6; // ortalama günlük işlem hacmi (mn TL): gün içi saatten bağımsız likidite
function qualityDip(s, P) {
  P = Object.assign({}, QD_P, P || {});
  if (!s.ok || !(avgTl(s) >= P.minTl) || !(s.eps > 0)) return null;
  if ((s.p1m != null && s.p1m <= -60) || (s.dist52 != null && s.dist52 <= -70)) return null; // olası bedelsiz/bölünme (fiyat düzeltmesi) görünümü: gerçek düşüş sayılmaz
  const down = s.smaDist != null && s.smaDist < 0 && ((s.p1m != null && s.p1m <= P.p1m) || (s.dist52 != null && s.dist52 <= P.dd52));
  if (!down) return null;
  const b = buffett(s); if (b.checks[0].s !== OK || !(b.quality >= P.minQual) || b.audit.verdict === "ZAYIF BİLANÇO") return null;
  const t = mtfTier(s), vs = volStats(s), tr = trendUp(s) === true, knife = vs.z20 != null && vs.z20 < R.zLo && !tr, cheap = cheapness(s), pv = peerView(s), mc = monteCarlo(s);
  const rec = [];
  if (s.cmf != null && s.cmf > 0.05) rec.push("para girişi (CMF > 0)");
  if (s.cmf_w != null && s.cmf_w > 0) rec.push("haftalık para akışı pozitif");
  if (s.sma20 > 0 && s.close > s.sma20) rec.push("fiyat SMA20 üstünde");
  if (t && t.id === "toparlanan") rec.push("'toparlanan' kurulum");
  if (s.rsi != null && s.rsi > 30 && s.rsi < 50 && s.change > 0) rec.push("RSI aşırı satımdan çıkıyor");
  const lead = pv && pv.rows.find(x => x.key === "p1m" && x.type && x.type !== "sakin");
  const warn = []; if (knife) warn.push("düşen bıçak: z-skor çok düşük ve trend aşağı"); if (mc && mc.probStop >= 55) warn.push(`stop olasılığı %${fmt(mc.probStop, 0)}`);
  if (REGIME && REGIME.trend === "bear") warn.push("piyasa ayı rejiminde"); if (b.audit.verdict === "DİKKAT") warn.push("bilanço denetimi: dikkat");
  const nx = s.nextEarn ? (s.nextEarn * 1000 - (typeof NOW === "number" ? NOW : Date.now())) / 864e5 : null; if (nx != null && nx >= -1 && nx <= 7) warn.push("bilanço yaklaşıyor");
  const rank = b.quality + 10 * rec.length + (cheap && cheap.lab === "UCUZ" ? 10 : 0) - (knife ? 15 : 0) - (mc && mc.probStop >= 55 ? 5 : 0);
  return {s, qual: b.quality, audit: b.audit.verdict, ratio: b.audit.ratio, dd: s.dist52, p1m: s.p1m, smaDist: s.smaDist, cheap, rec, warn, knife, lead, stop: mc ? mc.probStop : null, tier: t ? t.id : null, rank};
}
function qualityDipList(uni, P) { return uni.map(s => { try { return qualityDip(s, P); } catch (e) { return null; } }).filter(Boolean).sort((a, b) => b.rank - a.rank); }

/* =====================================================================================
   YORUMCU NOTLARI KARNESİ: kullanıcının kendi girdiği yorumlar (X hesapları, TradingView fikirleri, aracı kurum/birim görüşleri, tanıdıklar...). Otomatik çekilmez:
   X'in ücretsiz API'si yok ve kişi/hesap sınıflaması (ör. "tahtacı") doğrulanamaz bir iddiadır. Bunun yerine her yorumun YÖNÜ (al/sat) ve tarihi kaydedilir,
   sonradan 5/10/20 iş günü içinde BIST 100'e göre fazla getiriyle ölçülür; yorumcu "ünlü" değil "isabetli mi" diye değerlendirilir (%95 Wilson aralığı, n < 30 yetersiz). */
function commentEval(e, ohlc, h) {
  const st = ohlc && ohlc.stocks && ohlc.stocks[e.n]; if (!st || !ohlc.index || (e.dir !== "al" && e.dir !== "sat")) return null;
  let i0 = -1; for (let i = ohlc.dates.length - 1; i >= 0; i--) if (ohlc.dates[i] <= e.date && st.c[i] != null && ohlc.index[i] != null) { i0 = i; break; }
  if (i0 < 0) return null; const i1 = i0 + h; if (i1 >= ohlc.dates.length) return {pending: true};
  const c0 = st.c[i0], c1 = st.c[i1], x0 = ohlc.index[i0], x1 = ohlc.index[i1]; if (!c0 || !c1 || !x0 || !x1) return null;
  const ex = (c1 / c0 - x1 / x0) * 100, signed = e.dir === "al" ? ex : -ex;
  return {ex, signed, hit: signed > 0};
}
function commentStats(entries, ohlc, h) {
  const by = {};
  (entries || []).forEach(e => {
    const w = (by[e.who] = by[e.who] || {who: e.who, notes: 0, n: 0, hit: 0, sum: 0, pending: 0, src: new Set()}); w.notes++; if (e.src) w.src.add(e.src);
    const r = commentEval(e, ohlc, h); if (!r) return; if (r.pending) { w.pending++; return; } w.n++; w.sum += r.signed; if (r.hit) w.hit++;
  });
  const rows = Object.values(by).map(w => { const ci = wilson(w.hit, w.n); return {who: w.who, notes: w.notes, n: w.n, hit: w.hit, rate: w.n ? w.hit / w.n : null, ci, avg: w.n ? w.sum / w.n : null, pending: w.pending, src: [...w.src],
    status: w.n < 30 ? "yetersiz örnek" : ci[0] > 0.5 ? "anlamlı üstünlük" : ci[1] < 0.5 ? "anlamlı olarak kötü" : "şanstan ayırt edilemiyor"}; });
  rows.sort((a, b) => (b.ci ? b.ci[0] : -1) - (a.ci ? a.ci[0] : -1) || b.notes - a.notes);
  return {h, rows};
}
function commentConsensus(entries, name) {
  const xs = (entries || []).filter(e => e.n === name); if (!xs.length) return null;
  return {n: xs.length, al: xs.filter(e => e.dir === "al").length, sat: xs.filter(e => e.dir === "sat").length, izle: xs.filter(e => e.dir === "izle").length, items: xs.slice().sort((a, b) => b.date < a.date ? -1 : 1)};
}

/* =====================================================================================
   KAOS ve KARA KUĞU STRES TESTİ: hissenin piyasa şoklarına geçmişte gösterdiği duyarlılıktan (stress_research.py: 800 günlük regresyon
   r_i = a + b_m·r_m + b_f·USDTRY + b_y·faiz; çöküş günleri için ayrı düşüş betası b_md) dört senaryoda kayıp tahmini:
     BIST 100 −%5 çöküş · ani kur şoku (USDTRY +%10) · faiz şoku (TR 10 yıllık +3 puan) · kombine kara kuğu (BIST −%10, USDTRY +%8, faiz +4 puan).
   Kur ve faiz senaryolarında piyasanın tepkisi (km, ky) geçmişte gözlenen günlük ilişkiyle eklenir, yalnızca olumsuz yönde (iyimser tepki varsayılmaz).
   Testten geçemeyen hisse (herhangi bir senaryoda kayıp sınırı aşılırsa) Şeytanın Avukatı tarafından REDDEDİLİR (veto; kapatmak için R.stressVeto = 0).
   Doğrulama (stress.json meta.calibration): BIST 100'ün ≥ %2 düştüğü günlerde modelin öngördüğü ve gerçekleşen ortalama hisse getirisi. UYARI: kur/faiz şokları
   gözlenen en büyük günlük hareketin katlarıdır (ör. USDTRY +%10 ≈ gözlenen azami günlük artışın ~3 katı): doğrusal ekstrapolasyondur, kesin tahmin değildir. */
let STRESS = null; // stress.json
const STRESS_LIM = {bist5: -7.5, kur10: -15, faiz3: -9, swan: -16, borc500: 0.5, kurBf: -0.15, kurNd: 0.75}; // borc500: ek faiz gideri / FAVÖK; kurBf/kurNd: kur duyarlılığı ve net borç/özsermaye
const STRESS_SC = [["bist5", "BIST 100 −%5 çöküş"], ["kur10", "Ani kur şoku (USDTRY +%10)"], ["faiz3", "Faiz şoku (TR 10 yıllık +3 puan)"], ["swan", "Kara kuğu: BIST −%10, USDTRY +%8, faiz +4 puan"]];
function stressOf(s) {
  const b = STRESS && STRESS.stocks ? STRESS.stocks[s.name] : null, m = STRESS && STRESS.meta, fin = isFin(s);
  // (c) +500 baz puan: tüm borcun yeniden fiyatlandığı en kötü durumda ek faiz gideri / FAVÖK (bilançodan; regresyondan bağımsız, tüm hisselere uygulanır)
  const shares = s.mcap > 0 && s.close > 0 ? s.mcap / s.close : null, equity = s.bvps > 0 && shares ? s.bvps * shares : null, nd = s.debt != null ? s.debt - (s.cash || 0) : null, ndEq = nd != null && equity ? nd / equity : null;
  const debt = !fin && s.debt != null && s.ebitda > 0 ? {extra: s.debt * 0.05, burden: s.debt * 0.05 / s.ebitda, ndEq, ndEbitda: nd != null ? nd / s.ebitda : null} : null;
  if (debt) debt.fail = debt.burden >= STRESS_LIM.borc500;
  // (b) döviz açık pozisyonu vekili: bilançodaki döviz borcu/varlığı KAP dipnotundadır (yapılandırılmış ücretsiz veri yok); kur duyarlılığı negatif VE net borcu yüksek şirket = açık pozisyon şüphesi
  const fxOpen = b && !fin && ndEq != null ? {bf: b.bf, ndEq, fail: b.bf <= STRESS_LIM.kurBf && ndEq >= STRESS_LIM.kurNd} : null;
  if (!b && !debt) return null;
  const loss = b && m ? {bist5: b.bmd * -5, kur10: b.bm2 * Math.min(0, m.km * 10) + b.bf * 10, faiz3: b.bm2 * Math.min(0, m.ky * 3) + b.by * 3, swan: b.bmd * -10 + b.bf * 8 + b.by * 4} : null;
  const fail = (loss ? STRESS_SC.filter(([id]) => loss[id] <= STRESS_LIM[id]).map(([id]) => id) : []);
  if (debt && debt.fail) fail.push("borc500"); if (fxOpen && fxOpen.fail) fail.push("kurborc");
  const worst = loss ? Math.min(...Object.values(loss)) : null, lab = id => (STRESS_SC.find(x => x[0] === id) || [id, id === "borc500" ? "Faiz +500 baz puan: borç yükü" : "Döviz açık pozisyonu şüphesi"])[1];
  const parts = [];
  if (loss) parts.push(STRESS_SC.map(([id, l]) => `${l.split(":")[0].replace(/ \(.*\)/, "")} ${fmt(loss[id], 1)}%`).join(", "));
  if (debt) parts.push(`faiz +500 baz puan: ek faiz gideri FAVÖK'ün %${fmt(debt.burden * 100, 0)}'i`);
  if (fxOpen) parts.push(`kur duyarlılığı ${fmt(fxOpen.bf, 2)}, net borç/özsermaye ${fmt(ndEq, 1)}`);
  return {loss, debt, fxOpen, fail, ok: !fail.length, worst, weak: b ? b.r2 < 0.1 : false, b, n: b ? b.n : 0, lab,
    extrap: m ? {kur: m.usdtry_max ? 10 / m.usdtry_max : null, faiz: m.tr10y_max ? 3 / m.tr10y_max : null} : {},
    text: `Stres testi: ${parts.join("; ")}. ${fail.length ? `GEÇEMEDİ (${fail.map(lab).join("; ")}; sınır aşıldı).` : "Tüm senaryolarda kayıp sınırların içinde."}`};
}

/* =====================================================================================
   OTONOM POZİSYON BÜYÜKLÜĞÜ (KELLY) ve DİNAMİK İZLEYEN STOP (ATR):
   Başarı olasılığı = Monte Carlo ilk-geçiş olasılığı: hedefe (2R) stop'tan (R = 2×ATR) önce ulaşma. Sürüklenme (kenar) yalnızca araştırmayla kanıtlı ajandan gelir:
   Simons'ın 10 günlük beklenen fazla getirisi ile çok zamanlı haftalık skorun 20 günlük beklentisinin ortalaması. Kenar yoksa Kelly ≤ 0 ve öneri "pozisyon açma"dır.
   Kelly: f* = p − (1 − p)/b (b = hedef/stop = 2, p = karar verilen yollar içinde hedefe ulaşma oranı). Uygulama: YARIM Kelly, işlem başına %1 sermaye riski sınırı ve %20 tavan.
   İzleyen stop (chandelier): +1R'ye ulaşana kadar sabit başlangıç stop'u; sonra stop = max(giriş, tepe − k×ATR); k = 2 + ATR%/3 (2,2–3,5 arası: oynak hissede daha geniş). */
function mcFirstPassage(s, T, S, mu, n = 10000) {
  const sg = sigmaOf(s); if (!sg) return null;
  const days = Math.max(1, Math.round(R.mDays)), sigma = Math.max(sg.v, 1e-4), z = mcZ(n, days), drift = -0.5 * sigma * sigma + (mu || 0), lT = Math.log(1 + T / 100), lS = Math.log(1 - S / 100);
  let hT = 0, hS = 0;
  for (let i = 0, k = 0; i < n; i++) { let lp = 0, done = 0; for (let d = 0; d < days; d++, k++) { lp += drift + sigma * z[k]; if (!done) { if (lp >= lT) { hT++; done = 1; } else if (lp <= lS) { hS++; done = 1; } } } }
  return {pT: hT / n, pS: hS / n, pN: 1 - (hT + hS) / n, days};
}
function trailingStop(o) { // {entry, stop0, peak, atr, k, S}: izleyen stop seviyesi
  const lvl = o.entry * (1 + o.S / 100);
  return o.peak >= lvl ? Math.max(o.entry, o.stop0 || 0, o.peak - o.k * o.atr) : (o.stop0 || 0);
}
function tickRound(p, mode) { const tk = bistTick(p), q = p / tk; return Number(((mode === "up" ? Math.ceil(q - 1e-9) : mode === "down" ? Math.floor(q + 1e-9) : Math.round(q)) * tk).toFixed(2)); }
function kellyFrac(p, b) { const k = p - (1 - p) / b; return {kelly: k, half: k / 2}; }
/* Kullanıcı kendi güvenilirlik olasılığını (ör. %70, %85) girebilir: aynı formül, ama geçmiş testte ölçülen isabet BIST'te ≈ %53'tür: uyarı üretilir. */
const KELLY_P_TABLE = [0.30, 0.45, 0.55, 0.70, 0.85];
function kellyPlan(s, capital, pOverride) {
  if (!(s.atrPct > 0) || !(s.close > 0) || !(s.atr > 0)) return null;
  const S = Math.max(3, Math.min(15, 2 * s.atrPct)), T = 2 * S, sm = simons(s), mexp = mtfExpect(s);
  const mus = [sm.exp != null ? sm.exp / 10 : null, mexp != null ? mexp / 20 : null].filter(x => x != null).map(x => x / 100), mu = mus.length ? mus.reduce((a, b) => a + b, 0) / mus.length : 0;
  const fp = mcFirstPassage(s, T, S, mu); if (!fp) return null;
  // canlı kalibrasyon (seal_card.json): model olasılığı geçmişte gerçekleşenden saptıysa (≥ 30 bağımsız sonuç) ortalama sapma kadar düzeltilir
  const decided = fp.pT + fp.pS, pModel = decided > 0 ? fp.pT / decided : 0, cb = SEALCARD && SEALCARD.calib && SEALCARD.calib.ok ? SEALCARD.calib : null, pCal = cb ? Math.max(0.01, Math.min(0.99, pModel + cb.bias)) : null;
  const pWin = pOverride != null ? Math.max(0.01, Math.min(0.99, pOverride)) : pCal != null ? pCal : pModel, b = T / S, kelly = pWin - (1 - pWin) / b, half = kelly / 2, fRisk = 1 / S; // %1 risk: f × S% = %1
  const f = Math.max(0, Math.min(half, fRisk, 0.2)), k = Math.max(2.2, Math.min(3.5, 2 + s.atrPct / 3)), stop0 = tickRound(s.close * (1 - S / 100), "down");
  const ladder = [1, 2, 3, 5].map(r => { const peak = tickRound(s.close * (1 + r * S / 100), "up"); return {r, peak, stop: tickRound(trailingStop({entry: s.close, stop0, peak, atr: s.atr, k, S}), "down")}; });
  const tp = [{r: 1, frac: 1 / 3}, {r: 2, frac: 1 / 3}].map(x => ({...x, px: tickRound(s.close * (1 + x.r * S / 100), "up")})); // kar al: +1R'de üçte biri (stop başa baş), +2R'de üçte biri, kalan izleyen stopla
  const amount = capital > 0 ? f * capital : null, riskTl = amount ? amount * S / 100 : null;
  const tbl = KELLY_P_TABLE.map(p => ({p, ...kellyFrac(p, b), f: Math.max(0, Math.min(kellyFrac(p, b).half, fRisk, 0.2))}));
  const emp = 0.53, over = pOverride != null && pOverride > 0.6;
  return {S, T, mu, pT: fp.pT, pS: fp.pS, pN: fp.pN, pWin, pModel, pCal, calib: cb, pUser: pOverride != null ? pWin : null, b, kelly, half, fRisk, f, k, stop0, target: tickRound(s.close * (1 + T / 100), "up"), ladder, tp, tbl, amount, riskTl, shares: amount ? Math.floor(amount / s.close) : null, edge: kelly > 0 && (pOverride != null || mu > 0), days: fp.days,
    warn: over ? `Girdiğiniz olasılık (%${fmt(pWin * 100, 0)}) geçmişte ölçülen BIST isabetinin (≈ %${fmt(emp * 100, 0)}) çok üstünde; bu güvenilirliği destekleyen bir test yok, pozisyonu abartabilir.` : null,
    text: kelly > 0 ? `Kelly: ${pOverride != null ? "girdiğiniz" : pCal != null ? "canlı kalibrasyonlu model" : "model"} başarı olasılığı %${fmt(pWin * 100, 0)} (hedefe stop'tan önce ulaşma${pOverride != null ? "" : ", " + fp.days + " gün"}${pCal != null && pOverride == null ? `; ham model %${fmt(pModel * 100, 0)}, ${cb.nEff} bağımsız canlı sonuca göre ${cb.bias >= 0 ? "+" : ""}${fmt(cb.bias * 100, 1)} puan düzeltildi` : ""}), ödül/risk ${fmt(b, 1)}; tam Kelly %${fmt(kelly * 100, 1)}, yarım Kelly %${fmt(half * 100, 1)}; %1 risk sınırı %${fmt(fRisk * 100, 1)} → önerilen pozisyon sermayenin %${fmt(f * 100, 1)}'i.` : `Kelly ≤ 0: başarı olasılığı %${fmt(pWin * 100, 0)} (${fmt(b, 1)} ödül/risk için gereken ≈ %${fmt(100 / (1 + b), 0)}); istatistiksel kenar yok, pozisyon önerilmez.`};
}

/* =====================================================================================
   TAHTA DERİNLİĞİ (Level-2) ve SAHTE EMİR (SPOOFING) DENETİMİ: BIST kademe/derinlik verisi lisanslıdır ve TradingView'de yoktur; bu yüzden kullanıcının kendi
   dışa aktardığı tahta görüntüleri (Özel Veri sayfası) çözümlenir. Tek görüntüde: alış/satış dengesizliği (yakın kademelere ağırlıklı), makas, "duvar" (kademe lotu medyanın ≥ 3 katı ve tarafın ≥ %25'i),
   uzak büyük duvar ve günlük hacme oranla aşırı büyük/tek emir. İki ve daha çok görüntüde: bir duvar piyasa o fiyata gelmeden kaybolduysa (≥ %70 azaldı) iptal edilmiş sahte derinlik sayılır.
   Kırılım kapısı: kullanıcı açarsa Livermore/Kellogg'un kırılım (olumlu) oyu, derinlik teyit etmezse (spoofing riski, direnç duvarı, satıcı ağırlığı) 0'a çekilir. Veri doğrulanamaz. */
let DEPTH_USER = null, DEPTH_GATE = false;
function bistTick(p) { return p < 20 ? 0.01 : p < 50 ? 0.02 : p < 100 ? 0.05 : p < 250 ? 0.1 : p < 500 ? 0.25 : p < 1000 ? 0.5 : p < 2500 ? 1 : 2.5; }
function depthAnalyze(snap, ctx) {
  ctx = ctx || {}; const bids = (snap.bids || []).filter(x => x.q > 0).sort((a, b) => b.p - a.p), asks = (snap.asks || []).filter(x => x.q > 0).sort((a, b) => a.p - b.p);
  if (!bids.length || !asks.length) return null;
  const tick = bistTick((bids[0].p + asks[0].p) / 2), spreadTicks = Math.round((asks[0].p - bids[0].p) / tick), N = 5, w = i => 1 / (1 + i);
  const wsum = a => a.slice(0, N).reduce((t, x, i) => t + x.q * w(i), 0), B = wsum(bids), A = wsum(asks), imb = B + A > 0 ? (B - A) / (B + A) : 0;
  const med = a => { const q = a.map(x => x.q).sort((x, y) => x - y); return q[Math.floor((q.length - 1) / 2)]; };
  const walls = [], flags = [];
  [["alış", bids, bids[0].p], ["satış", asks, asks[0].p]].forEach(([side, arr, best]) => {
    const tot = arr.reduce((t, x) => t + x.q, 0), m = med(arr);
    arr.forEach((x, i) => { const share = x.q / tot; if (arr.length >= 4 && x.q >= 3 * m && share >= 0.25) {
      const dist = Math.round(Math.abs(x.p - best) / tick), vsDay = ctx.avgVol > 0 ? x.q / ctx.avgVol : null, single = x.o === 1 || (x.o > 0 && x.q / x.o >= (ctx.avgVol || 1e9) * 0.03);
      walls.push({side, p: x.p, q: x.q, share, dist, vsDay, single});
      if (dist >= 3 && vsDay != null && vsDay >= 0.03) flags.push(`${side} tarafında uzak büyük duvar (${fmt(x.p)} TL, ${dist} kademe uzakta, günlük hacmin %${fmt(vsDay * 100, 1)}'i)`);
      if (single && vsDay != null && vsDay >= 0.03) flags.push(`${side} tarafında tek büyük emir (${fmt(x.p)} TL)`); } });
  });
  const pulled = [];
  if (ctx.prev) { const pb = (ctx.prev.bids || []), pa = (ctx.prev.asks || []);
    [["alış", pb, bids, (p) => bids[0].p > p], ["satış", pa, asks, (p) => asks[0].p < p]].forEach(([side, parr, cur, away]) => { const pm = med(parr.filter(x => x.q > 0)); parr.forEach(x => { if (!(x.q >= 3 * pm)) return; const c = cur.find(y => Math.abs(y.p - x.p) < 1e-9), left = c ? c.q : 0;
      if (left <= 0.3 * x.q && away(x.p)) pulled.push({side, p: x.p, was: x.q, now: left}); }); });
    pulled.forEach(x => flags.push(`${x.side} duvarı kayboldu (${fmt(x.p)} TL: ${fmt(x.was, 0)} → ${fmt(x.now, 0)} lot) ama fiyat oraya gelmedi: iptal edilmiş sahte derinlik olabilir`)); }
  const spoof = pulled.length > 0, suspect = flags.length > 0;
  const askWall = walls.find(x => x.side === "satış" && ctx.close > 0 && (x.p - ctx.close) / ctx.close * 100 <= 2 && x.p >= ctx.close);
  const verdict = spoof ? "SPOOFING RİSKİ" : suspect ? "ŞÜPHELİ DERİNLİK" : imb >= 0.3 ? "alıcı ağırlıklı" : imb <= -0.3 ? "satıcı ağırlıklı" : "dengeli";
  const block = []; if (spoof) block.push("iptal edilen büyük emir (olası spoofing)"); if (suspect && !spoof) block.push("şüpheli büyük emir/duvar"); if (askWall) block.push(`fiyatın %2 üstünde satış duvarı (${fmt(askWall.p)} TL)`); if (imb <= -0.3) block.push("satıcı ağırlıklı tahta");
  return {t: snap.t || null, spreadTicks, imb, B, A, walls, flags, verdict, spoof, suspect, askWall: askWall || null, block, bid0: bids[0].p, ask0: asks[0].p,
    text: `Tahta: ${verdict.toLowerCase()} (denge ${imb > 0 ? "+" : ""}${fmt(imb * 100, 0)}%, makas ${spreadTicks} kademe${walls.length ? ", " + walls.length + " duvar" : ""})${flags.length ? "; " + flags[0] : ""}.`};
}
function depthGate(s) { // kırılım için derinlik teyidi: {block, reasons} ya da veri yoksa null
  const d = DEPTH_USER && DEPTH_USER[s.name]; if (!d || !DEPTH_GATE) return null; return {block: d.block.length > 0, reasons: d.block, d};
}

/* =====================================================================================
   SANAL İŞLEM PERFORMANSINA BAĞLI OY AĞIRLIĞI (gölge arena): sanal portföyde (engine_core.js) her ajanın son ≤ 60 işlem gününün BIST'te eşit ağırlıklı kıyasa göre
   fazla getirisi ölçülür; ≥ 20 işlem günü varsa ağırlık çarpanı = clamp(1 + fazla/25, 0,7, 1,3). Performansı düşen ajanın oy ağırlığı otomatik düşer.
   Çarpan isabet (Arena) ağırlığıyla birlikte uygulanır (toplam 0,5–1,5). Öncesinde çarpan 1'dir (kısa dönem gürültüdür). */
let PAPER_W = {};
const PAPER_MAP = {buffett: "buffett", simons: "simons", livermore: "livermore", kellogg: "kellogg", akilli: "akilli", vol: "vol"};
function paperWeights(st) {
  const out = {}; if (!st || !st.p) return out;
  Object.entries(PAPER_MAP).forEach(([k, pk]) => {
    const p = st.p[pk]; if (!p || !p.nav || p.nav.length < 2) { out[k] = {w: 1, status: "kayıt yok", days: 0}; return; }
    const n = p.nav.length, win = Math.min(60, n - 1), a = p.nav[n - 1 - win], b = p.nav[n - 1], ba = (st.bench || []).find(x => x.d === a.d), bb = (st.bench || []).find(x => x.d === b.d);
    if (win < 20 || !ba || !bb) { out[k] = {w: 1, status: "yetersiz (en az 20 işlem günü)", days: win}; return; }
    const ret = (b.v / a.v - 1) * 100, bret = (bb.ew / ba.ew - 1) * 100, ex = ret - bret, w = Math.max(0.7, Math.min(1.3, 1 + ex / 25));
    out[k] = {w, excess: ex, ret, bench: bret, days: win, status: w < 1 ? "performans düşük: ağırlık azaltıldı" : w > 1 ? "performans yüksek: ağırlık artırıldı" : "kıyasla başa baş"};
  });
  return out;
}
function setPaper(st) { return PAPER_W = paperWeights(st); }

/* =====================================================================================
   KOKPİT KARAR MÜHRÜ (Baş Denetçi): tek bakışta okunan sonuç. Sıra önemlidir (üstteki kural alttakini ezer):
   KİLİTLİ (Hata Avcısı: rakamlar ham veriyle çelişiyor) > RİSKLİ (Şeytanın Avukatı vetosu ya da kara kuğu stres testi/uzman itirazı) > GÜÇLÜ AL (tüm filtreleri geçen
   yüksek güvenilirlikli sinyal) > AL (masa skoru ≥ 2 ve ağırlıklı kararda ≥ %40 Al) > UZAK DUR (masa skoru ≤ −2 ya da ≥ %50 Sat) > NÖTR.
   "AL" bir tavsiye değil, ajanların oy özetidir; tahmin kazanç garantisi vermez (BIST'te ölçülen en iyi isabet ≈ %53). */
function kokpitSealRaw(s, r) {
  const f = factCheck(s, r), d = debate(s, r), hc = highConfidence(s, r), why = [];
  if (f.locked) return {label: "KİLİTLİ", cls: "lock", why: ["Hata Avcısı: rakamlar ham veriyle çelişiyor, düzeltme bekleniyor"].concat(f.issues.map(i => i.msg)), d, hc, f};
  if (r.veto) { r.l.seytan.severe.forEach(x => why.push("Şeytanın Avukatı: " + x)); return {label: "RİSKLİ", cls: "risk", why, d, hc, f}; }
  if (r.veto2) { if (r.k2.makro.veto) why.push("Makro Risk Uzmanı onay vermiyor"); why.push(`Yeni uzmanların net oyu ${r.net2}`); return {label: "RİSKLİ", cls: "risk", why, d, hc, f}; }
  if (hc.ok) return {label: "GÜÇLÜ AL", cls: "strong", why: ["Masa ≥ 3, veto yok, haftalık lider, stop riski düşük, rakamlar doğrulandı"], d, hc, f};
  if (r.score >= 2 && d.al >= 40) return {label: "AL", cls: "buy", why: [`Masa skoru ${r.score}, ağırlıklı karar ${d.text}`], d, hc, f};
  if (r.score <= -2 || d.sat >= 50) return {label: "UZAK DUR", cls: "avoid", why: [`Masa skoru ${r.score}, ağırlıklı karar ${d.text}`], d, hc, f};
  return {label: "NÖTR", cls: "neutral", why: [`Masa skoru ${r.score}, ağırlıklı karar ${d.text}`], d, hc, f};
}
function kokpitSeal(s, r, opt) { const sl = kokpitSealRaw(s, r); return opt && opt.raw ? sl : sealGateApply(sl); }

/* =====================================================================================
   MÜHÜR KARNESİ (canlı, ileriye dönük doğrulama): signals.js her seans kapanışında TÜM likit hisselerin ham mührünü seal_log.json'a yazar
   ([ad, kapanış, mühür no, masa skoru, Boğa %, ATR %, model başarı olasılığı %]); sealCard() bunları 5/10/20 iş gün sonraki gerçek getiriyle ölçer. Dürüstlük kuralları:
   · Kıyas: aynı gün kaydedilen ~300 likit hissenin eşit ağırlıklı ortalaması (fazla getiri = hisse − bu ortalama; yani piyasa yönünden arındırılmış).
   · Şans testi: aynı gün, aynı sayıda RASTGELE hisse seçilseydi ortalama fazla getiri ne olurdu? (permütasyon; iki yönlü %5 → p < 0,025). Böylece "piyasa düştü ama biz az düştük" ya da şans eseri başarı ayrılır.
   · Örtüşme: bir hisse h gün boyunca art arda pencerelerde yer alır; bağımsız örnek ≈ n / h. En az 30 bağımsız gözlem VE 3 çakışmayan pencere (gün ≥ 3h) olmadan hüküm verilmez ("yetersiz veri").
   · Otomatik düzeltme: AL/GÜÇLÜ AL mühürleri 10 günde "ters kanıt" (piyasanın anlamlı biçimde gerisinde) verirse Kokpit bunları NÖTR'e düşürür (R.sealGate = 0 ile kapatılır). Kanıt olmadan mühür değiştirilmez (az örnekle ayar yapmak aşırı uyumdur).
   · Kelly kalibrasyonu: modelin "hedefe stop'tan önce ulaşma" olasılığı, günlük kapanışlarla gerçekleşen sonuçla karşılaştırılır (tam gözlenmiş pencereler; gün içi dokunuşlar görünmez). ≥ 30 bağımsız sonuçta ortalama sapma Kelly olasılığına eklenir. */
const SEAL_VER = 1, SEAL_NAMES = ["KİLİTLİ", "RİSKLİ", "GÜÇLÜ AL", "AL", "UZAK DUR", "NÖTR"], SEAL_BUY = "AL+GÜÇLÜ AL";
const SEAL_DIR = {"KİLİTLİ": -1, "RİSKLİ": -1, "GÜÇLÜ AL": 1, "AL": 1, "AL+GÜÇLÜ AL": 1, "UZAK DUR": -1, "NÖTR": 0};
let SEALCARD = null; // seal_card.json
function sealRng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function sealRecord(s, r) {
  const sl = kokpitSealRaw(s, r); let pm = null; try { const k = kellyPlan(s, 0); pm = k ? Math.round(k.pModel * 100) : null; } catch (e) { /* ATR yok */ }
  return [s.name, s.close, SEAL_NAMES.indexOf(sl.label), r.score, sl.d.al, s.atrPct > 0 ? Math.round(s.atrPct * 10) / 10 : null, pm];
}
function sealCard(days, opt) {
  opt = opt || {}; const M = opt.draws || 400, H = [5, 10, 20], mD = Math.max(1, Math.round(R.mDays || 20));
  const ds = (days || []).filter(x => x && x.d && x.r && x.v === SEAL_VER).sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
  const card = {ver: SEAL_VER, ndays: ds.length, first: ds.length ? ds[0].d : null, last: ds.length ? ds[ds.length - 1].d : null, nrec: ds.reduce((a, x) => a + x.r.length, 0), h: {}, calib: null};
  if (ds.length < 2) return card;
  // ufuk = KAYITLI işlem günü sırası (hafta içi sayısı değil: resmi tatiller kayıt almaz). Aradaki boşluk (kayıp gün) makul değilse çift atlanır.
  const gap = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5), at = (i, k) => { const y = ds[i + k]; return y && gap(ds[i].d, y.d) <= Math.ceil(k * 1.45) + 5 ? y : null; };
  const rk = a => { const o = a.map((v, i) => i).sort((i, j) => a[i] - a[j]), r = new Array(a.length); for (let i = 0; i < o.length;) { let j = i; while (j + 1 < o.length && a[o[j + 1]] === a[o[i]]) j++; for (let k = i; k <= j; k++) r[o[k]] = (i + j) / 2; i = j + 1; } return r; };
  const corr = (a, b) => { const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null; };
  const icStat = (arr, h) => { const v = arr.filter(x => x != null), n = v.length; if (!n) return null; const mean = v.reduce((s, x) => s + x, 0) / n, sd = n > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0, nIndep = Math.floor(n / h);
    const t = nIndep >= 3 && sd > 0 ? mean / (sd / Math.sqrt(nIndep)) : null; // ardışık günlerin IC'leri örtüştüğünden bağımsız pencere sayısıyla temkinli t
    return {mean, days: n, nIndep, t, verdict: nIndep < 5 || t == null ? "yetersiz veri" : Math.abs(t) >= 2 ? (mean > 0 ? "pozitif kanıt" : "ters kanıt") : "kanıt yok"}; };
  const cl = new Map(), closes = x => { let m = cl.get(x.d); if (!m) { m = new Map(x.r.map(a => [a[0], a[1]])); cl.set(x.d, m); } return m; };
  const buckets = SEAL_NAMES.concat([SEAL_BUY]);
  H.forEach(h => {
    const acc = {}; buckets.forEach(b => acc[b] = {n: 0, sum: 0, pos: 0, neg: 0, days: []}); let outDays = 0, mk = 0;
    const ic = {sc: [], al: []};
    ds.forEach((x, i) => { const y = at(i, h); if (!y) return; const cy = closes(y);
      const rows = x.r.filter(a => a[1] > 0 && cy.get(a[0]) > 0).map(a => [a[2], (cy.get(a[0]) / a[1] - 1) * 100, a[3], a[4]]); if (rows.length < 50) return;
      const m = rows.reduce((t, q) => t + q[1], 0) / rows.length, exs = rows.map(q => q[1] - m), by = {}; outDays++; mk += m;
      { const rr = rk(rows.map(q => q[1])); ic.sc.push(corr(rk(rows.map(q => q[2])), rr)); ic.al.push(corr(rk(rows.map(q => q[3])), rr)); } // sıralama gücü: skor ↔ ileri getiri (Spearman)
      rows.forEach((q, i) => { const nm = SEAL_NAMES[q[0]]; if (!nm) return; (by[nm] = by[nm] || []).push(exs[i]); if (nm === "AL" || nm === "GÜÇLÜ AL") (by[SEAL_BUY] = by[SEAL_BUY] || []).push(exs[i]); });
      Object.entries(by).forEach(([nm, arr]) => { const a = acc[nm]; a.n += arr.length; arr.forEach(v => { a.sum += v; if (v > 0) a.pos++; else if (v < 0) a.neg++; }); a.days.push({k: arr.length, all: exs}); });
    });
    const rowsOut = {};
    buckets.forEach((b, bi) => { const a = acc[b]; if (!a.n) return; const n = a.n, mean = a.sum / n, dir = SEAL_DIR[b], good = dir < 0 ? a.neg : a.pos, nEff = Math.floor(n / h), ci = nEff ? wilson(Math.round(good / n * nEff), nEff) : null;
      let p = null, verdict = "yetersiz veri";
      if (nEff >= 30 && outDays >= 3 * h) {
        const rng = sealRng(h * 1000 + bi * 17 + 1); let ge = 0, le = 0;
        for (let t = 0; t < M; t++) { let tot = 0; for (const dy of a.days) { const al = dy.all; for (let q = 0; q < dy.k; q++) tot += al[Math.floor(rng() * al.length)]; } const mt = tot / n; if (mt >= mean) ge++; if (mt <= mean) le++; }
        p = Math.min(1, 2 * Math.min((ge + 1) / (M + 1), (le + 1) / (M + 1))); // iki yönlü
        verdict = dir === 0 ? "izleme" : p < 0.05 ? ((dir > 0 ? mean > 0 : mean < 0) ? "pozitif kanıt" : "ters kanıt") : "kanıt yok";
      }
      rowsOut[b] = {n, nEff, days: a.days.length, mean, rate: good / n, ci, p, verdict, dir};
    });
    card.h[h] = {outDays, mkt: outDays ? mk / outDays : null, rows: rowsOut, ic: {sc: icStat(ic.sc, h), al: icStat(ic.al, h)}};
  });
  // Kelly olasılığı kalibrasyonu: tam gözlenmiş pencereler, günlük kapanışlarla hedef(2R)/stop(R) ilk geçişi
  const bins = [[0, 40], [40, 50], [50, 60], [60, 101]].map(([lo, hi]) => ({lo, hi, n: 0, win: 0, pred: 0}));
  let dec = 0, win = 0, pSum = 0, brier = 0;
  ds.forEach((x, i) => { if (!at(i, mD)) return; // yalnız penceresi tam gözlenmiş kayıtlar (sağdan kırpılma yanlılığı olmasın)
    x.r.forEach(a => { if (a[5] == null || a[6] == null || !(a[1] > 0)) return; const S = Math.max(3, Math.min(15, 2 * a[5])), T = 2 * S; let res = 0;
      for (let k = 1; k <= mD && !res; k++) { const y = at(i, k); if (!y) continue; const c = closes(y).get(a[0]); if (!(c > 0)) continue; const ret = (c / a[1] - 1) * 100; if (ret >= T) res = 1; else if (ret <= -S) res = -1; }
      if (!res) return; const w = res > 0 ? 1 : 0, p = a[6] / 100; dec++; win += w; pSum += p; brier += (p - w) ** 2;
      const bk = bins.find(q => a[6] >= q.lo && a[6] < q.hi); bk.n++; bk.win += w; bk.pred += p; });
  });
  if (dec) { const pReal = win / dec, base = pReal * (1 - pReal), nEff = Math.floor(dec / mD);
    card.calib = {n: dec, nEff, mD, pPred: pSum / dec, pReal, bias: pReal - pSum / dec, brier: brier / dec, skill: base > 0 ? 1 - (brier / dec) / base : null, ok: nEff >= 30,
      bins: bins.filter(q => q.n).map(q => ({lo: q.lo, hi: q.hi, n: q.n, pred: q.pred / q.n, real: q.win / q.n}))}; }
  return card;
}
function sealGateApply(sl, card) {
  card = card === undefined ? SEALCARD : card; sl.rawLabel = sl.label;
  const rows = card && card.h && card.h[10] && card.h[10].rows ? card.h[10].rows : null; sl.ev = rows ? rows[sl.label] || null : null;
  if ((R.sealGate ?? 1) && (sl.label === "AL" || sl.label === "GÜÇLÜ AL") && rows && rows[SEAL_BUY] && rows[SEAL_BUY].verdict === "ters kanıt") {
    const e = rows[SEAL_BUY]; sl.gated = true; sl.why = [`Canlı karne: AL/GÜÇLÜ AL mühürleri 10 iş gününde piyasanın anlamlı biçimde gerisinde kaldı (ort. ${fmt(e.mean, 2)} puan, p = ${fmt(e.p, 3)}, ${e.nEff} bağımsız gözlem); kanıt düzelene kadar NÖTR gösterilir`].concat(sl.why);
    sl.label = "NÖTR"; sl.cls = "neutral";
  }
  return sl;
}
