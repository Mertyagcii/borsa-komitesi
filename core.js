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
function monteCarlo(s, n = 2000) {
  const key = s.name; if (mcCache[key]) return mcCache[key];
  const sg = sigmaOf(s); if (!sg) return null;
  const days = Math.max(1, Math.round(R.mDays)), stop = R.mStop, sigma = Math.max(sg.v, 1e-4), r = rng(hash(s.name));
  const finals = new Float64Array(n); let stopHit = 0;
  for (let i = 0; i < n; i++) {
    let lp = 0, min = 0;
    for (let d = 0; d < days; d++) {
      const z = Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
      lp += -0.5 * sigma * sigma + sigma * z;
      if (lp < min) min = lp;
    }
    finals[i] = Math.exp(lp) - 1;
    if (Math.exp(min) <= 1 - stop / 100) stopHit++;
  }
  const sorted = Array.from(finals).sort((a, b) => a - b), q = p => sorted[Math.floor(p * (n - 1))] * 100;
  return mcCache[key] = { sigma: sigma * 100, src: sg.src, days, stop, p05: q(.05), p50: q(.5), p95: q(.95),
    probLoss: sorted.filter(x => x < 0).length / n * 100, probStop: stopHit / n * 100, finals: sorted };
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
  return {v, score: all.score, checks, t, plan, fv: iv.fv, mos: iv.mos, cap, quality: quality.score};
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
  return {v, score: k.score, checks, t, plan, exp, edge, w, dec, mexp};
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
  const t = v > 0 ? `Tape'e bakıyorum: trend yukarı, ${s.name} lider grupta (RS ${fmt(s.rs, 0)}) ve pivot ${nearPivot ? "kırılıyor" : "yakında"}${s.rvol >= R.lVol ? ", hacim de eşlik ediyor" : ""}. Burada beklentiye değil teyide oynuyorum; teyit geldi.`
    : v < 0 ? "Düşen bıçak tutulmaz. Trend aşağı ya da hisse liderlerin arasında değil; böyle yerde 'ucuz' diye alan umut ticareti yapıyordur."
    : bear ? "Piyasa ayı rejiminde; bu hisse yeterince güçlü bir lider değil. Beklemek de bir pozisyondur. Net fırsat yoksa işlem yapmam."
    : "Net bir fırsat yok: ya pivot kırılmadı ya hacim teyit etmedi ya da hisse çok uzamış. Acele edip yanlış zamanda girmem.";
  const unit = 25;
  const plan = pivot && np >= 0.9 ? `Test alımı: hedef pozisyonun %${unit}'i, pivot ${fmt(pivot)} TL üstünde hacimli kapanışta. Fiyat +%5 ilerledikçe birim ekler (en çok 3 ekleme), zarardaki pozisyona asla eklemez. Yanılma noktası pivotun %3 altı ≈ ${fmt(pivot * 0.97)} TL; çıkış: SMA20 altı kapanış ya da zirveden %8 geri verme.`
    : `Pivotun belirgin altında: işlem yok. Pivotu (≈ ${pivot ? fmt(pivot) : "–"} TL) hacimle aşan kapanışı bekler; stop alımdan önce belirlenir.`;
  return {v, score: k.score, checks, t, plan, pivot};
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
  const v = v0 > 0 && support === false ? 0 : v0;
  const t = v > 0 ? `Hacim ${fmt(rv, 1)}x, fiyat %${fmt(s.change, 1)} itiyor ve direnç ${brk ? "aşılıyor" : "yakın"}: momentum canlı${catalyst ? ", üstüne haber de var" : ""}. Hızlı hareket eden yerde olmak isterim; ama stop'um hazır.`
    : v < 0 ? "Hacim yüksek ama fiyat sert düşüyor: bu dağıtım, alıcı yok satıcı var. Kimse bıçağı tutmaz; uzak dururum."
    : bear ? "Piyasa ayı rejiminde; kırılımlar bu ortamda sık sık geri dönüyor. Yavaş piyasada kenarda beklerim."
    : "Hacim patlaması ve kırılım birlikte yok. Kimsenin ilgilenmediği hissede vakit kaybetmem.";
  const stopPx = s.lo ? Math.max(s.lo, s.close * 0.93) : s.close * 0.93;
  const plan = `Giriş ${fmt(s.close)} TL civarı; stop ${fmt(stopPx)} TL (gün içi dip ya da −%7, hangisi yakınsa; fiyatın ${pc((stopPx / s.close - 1) * 100)} altı). Pozisyon, sermayenin %1'i riske girecek şekilde boyutlanır. +%10'da yarısını satar (scale out), kalanı takip eden stopla taşır; en geç 8 iş gününde çıkar. Kaybı hızla keser, zarardaki pozisyona eklemez.`;
  return {v, score: k.score, checks, t, plan, stopPx};
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
  const veto = severe.length > 0;
  const v = veto || bads.length >= R.dFlags ? -1 : 0;
  const t = veto ? `VETO: ${severe.join("; ")}. Bu koşulda işlem yapılmaz; tersini düşünün, bu pozisyon nasıl para kaybettirir? Tam da buradan.`
    : bads.length ? `Tersini düşündüm: bu hisse şunlarla para kaybettirir → ${bads.slice(0, 3).map(c => c.t.replace(/ \(.*?\)/g, "").replace(/:.*$/, "")).join("; ")}.${v < 0 ? " Karşı çıkıyorum." : " Henüz itiraz sınırında değil; ama izliyorum."}`
    : "Tersini düşündüm ve belirgin bir batma nedeni bulamadım. Yine de makro şokta (kur, faiz, jeopolitik) korelasyonlar 1'e gider; pozisyon küçük olsun.";
  const plan = stopPct ? `Stres testi: ATR stopu (2×ATR) ≈ %${fmt(stopPct, 1)}. Sermayenin %1'ini riske atma kuralıyla azami pozisyon ≈ portföyün %${fmt(maxPos, 1)}. −%10 gap açarsa zarar portföyün ≈ %${fmt(maxPos * 0.1, 2)}'i. ${veto ? "Veto sürdükçe pozisyon açılmaz." : ""}`
    : "ATR verisi yok; stres testi yapılamadı.";
  return {v, score: k.score, checks, t, plan, veto, severe, maxPos, stopPct};
}

function committee(s) {
  const l = { buffett: buffett(s), simons: simons(s), livermore: livermore(s), kellogg: kellogg(s) };
  l.seytan = devil(s, Object.values(l));
  const score = Object.values(l).reduce((a, x) => a + x.v, 0), veto = l.seytan.veto;
  const label = score >= 3 && !veto ? "GÜÇLÜ ADAY" : score === 2 && !veto ? "ADAY" : score >= 1 ? "İZLE" : score >= -1 ? "NÖTR" : "UZAK DUR";
  return { l, score, label, veto };
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
  const mt = s.mtf, tier = mtfTier(s), mexp = mtfExpect(s);
  if (tier && (tier.id === "uyumlu" || tier.id === "hlider")) {
    say("simons", `Çok zamanlı tabloya bakın: günlük ${fmt(mt.d, 0)}, haftalık ${fmt(mt.w, 0)}, aylık ${fmt(mt.m, 0)}. Haftalık skoru bu dilimdeki hisseler geçmişte 20 günde piyasanın ortalamasının ${mexp != null ? (mexp > 0 ? "+" : "") + fmt(mexp, 1) + "% " : ""}üstünde kaldı ve bu iki yarıda, boğada da ayıda da tuttu. İsabet oranı %53 civarı: avantaj küçük, ama çok işleme yayılınca birikir. Heyecanlıyım, ama abartmıyorum.`);
    if (s.sma20_w > 0) say("livermore", `Haftalık grafikte de aynı hikâye: fiyat haftalık SMA20 (${fmt(s.sma20_w)}) üstünde${s.sma50_w ? `, o da SMA50 (${fmt(s.sma50_w)}) üstünde` : ""}. Günlük ve haftalık aynı yöne bakınca en az direnç çizgisi gerçekten yukarıdır.`);
    if (s.cmf != null && s.cmf > 0.05) say("kellogg", `Para akışı da olumlu: CMF ${fmt(s.cmf, 2)}${s.cmf_w != null ? ` (haftalık ${fmt(s.cmf_w, 2)})` : ""}. Alıcılar gün sonunda fiyatı üst yarıda tutuyor; hacmin yönü doğru.`);
    if (REGIME && REGIME.trend === "bear") say("seytan", `Dikkat: piyasa ayı rejiminde. Bu skorların avantajı piyasa ORTALAMASINA göre ölçüldü: hisse piyasadan iyi olabilir ama mutlak getiri yine de eksi çıkabilir. Pozisyon küçük, stop hazır.`);
  } else if (tier && tier.id === "toparlanan") {
    say("kellogg", `Dipte toparlanma izi var: günlük skor ${fmt(mt.d, 0)}, para girişi (CMF ${fmt(s.cmf, 2)}). Haftalık trend henüz oturmadı; bu bir erken dönüş denemesi, kanıtlı bir kural değil. Küçük pozisyon, sıkı stop.`);
  }
  const verdict = r.veto && r.score >= 3 ? "Karar: güçlü ama Şeytanın Avukatı veto etti; masa işlem yapmıyor." : r.score >= 3 ? "Karar: masa uzlaştı, güçlü aday." : r.score === 2 ? "Karar: aday; masanın çoğu olumlu, kalan itirazlar not edildi." : r.score >= 1 ? "Karar: izleme listesi; teyit bekleniyor." : r.score === 0 ? "Karar: net değil, bekleyelim." : "Karar: uzak durulacak.";
  return {lines, verdict};
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
