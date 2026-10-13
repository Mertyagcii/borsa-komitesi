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

/* =====================================================================================
   GENİŞLETİLMİŞ KURUL: 4 yeni uzman (Makro & Jeopolitik, Akıllı Para, Opsiyon & Volatilite, Piyasa Psikolojisi).
   ÖNEMLİ: Elimizde gerçek takas/aracı kurum (AKD) verisi, opsiyon zımni oynaklığı ve sosyal medya verisi YOKTUR; uzmanlar fiyat-hacim-makro VEKİLLERİYLE çalışır
   ve vekiller geçmişte test edilmiştir (kurul2_research.json, macro_research.json). Bir uzman yalnızca kanıtı ters çıkmayan sinyalle oy kullanır.
   Araştırma bulguları (BIST 2023-26): panik satışları ve "ayı tuzağı" sıçramaları DEVAM etti (düşen bıçak); dağıtım ve para çıkışı olumsuz sinyaldi; aşırı uzama
   (z-skor > 2,5) ortalamaya DÖNMEDİ (momentum sürdü); makro risk-off bayrakları BIST'in sonraki getirisini düşürmedi (nominal TL piyasasında kur şoku dönemlerinde hisseler yükseldi).
   Yeni uzmanların oyları mevcut komite skoruna KARIŞMAZ (sanal portföylerin kaydı bozulmasın); net oy ve itiraz vetosu ayrıca gösterilir. */
let KUR2 = null, MACRO_R = null; // kurul2_research.json, macro_research.json (tarayıcı yükler)
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
  const geo = macroNewsHeat();
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
  const veto = !!(R.makroVeto && sh.count >= R.makroN);
  const v = veto ? -1 : 0;
  const checks = sh.items.map(x => chk(x.on ? false : (x.val === "–" ? null : true), `${x.name}: ${x.hint}`, x.val)).concat([
    chk(sh.inverted ? false : true, "Getiri eğrisi normal (2 yıllık < 10 yıllık)", sh.inverted ? "ters: kısa vade faizi uzundan yüksek" : "normal"),
    chk(beta == null ? null : !hi, "Piyasa duyarlılığı (beta) ≤ 1,2: makro şokta hisse fazla savrulmaz", beta == null ? "–" : fmt(beta, 2))]);
  const t = sh.count >= 3
    ? `Dikkat: makro tablo ${sh.level.toLowerCase()} risk gösteriyor (${sh.count}/7 bayrak). Ama sayılara dürüst olalım: ${sh.evidence} Bu piyasada kur şoku dönemlerinde hisse enflasyon ve kur koruması gibi davranıyor; bu yüzden ${veto ? "vetomu açtım" : "alım vetosu koymuyorum"}, yalnızca pozisyonu küçültmenizi öneririm${hi ? "; üstelik bu hisse yüksek betalı" : ""}.`
    : sh.count === 2 ? `Makro tablo orta düzeyde karışık (${sh.count}/7 bayrak). Büyük resim alım kararını engellemiyor ama haber akışını izleyin; ${sh.evidence}`
    : `Makro tabloda belirgin bir stres yok (${sh.count}/7 bayrak${sh.inverted ? "; getiri eğrisi ters, para sıkı" : ""}). ${sh.geo.tot ? `Son 3 günün haberlerinin ${sh.geo.n}/${sh.geo.tot}'i jeopolitik/makro konulu (zayıf bir gösterge).` : ""} Rüzgâr ne lehe ne aleyhte; karar hissenin kendi hikâyesine kalıyor.`;
  const plan = sh.count >= 3 ? "Pozisyon boyutunu normalin yarısına indirin; stop'u önceden belirleyin; yeni alımları kademeli yapın." : "Makro nedeniyle ek bir kısıt yok; her zamanki risk kuralları geçerli.";
  return {v, score: tally(checks).score, checks, t, plan, shield: sh, veto};
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
  const checks = [
    chk(cmf == null ? null : cmf > 0, "Para akışı (CMF günlük) pozitif: alıcı baskın", cmf == null ? "–" : fmt(cmf, 2)),
    chk(cmfw == null ? null : cmfw > 0, "Haftalık para akışı pozitif: birikim sürüyor", cmfw == null ? "–" : fmt(cmfw, 2)),
    chk(strong ? true : null, "Güçlü para girişi: CMF > 0,15 ve yükselen trend", strong ? "evet · " + k2ev("cmf_guclu") : "hayır"),
    chk(weak ? false : null, "Para çıkışı: CMF < −0,15", weak ? "evet · " + k2ev("cmf_zayif") : "hayır"),
    chk(dist ? false : null, "Dağıtım: yüksek hacim, fiyat yerinde, CMF negatif", dist ? "evet · " + k2ev("dagitim") : "hayır"),
    chk(acc ? true : null, "Emilim (birikim): yüksek hacim, fiyat yerinde, CMF pozitif", acc ? "evet · " + k2ev("birikim") + " (kanıtsız)" : "hayır"),
    chk(vt == null ? null : vt >= 1, "Hacim eğilimi (10g/60g) ≥ 1: ilgi artıyor", vt == null ? "–" : fmt(vt, 2) + "x"),
    chk(s.ff == null ? null : s.ff >= 20, "Halka açıklık ≥ %20: tahtayı birkaç elin oynatması zor", s.ff == null ? "–" : "%" + fmt(s.ff, 0)),
    chk(null, "Aracı kurum dağılımı, takas, kurumsal fon hareketi: veri kaynağı yok", "vekil göstergelerle çalışıyor")];
  const t = v > 0 ? `Tahtanın izini sürüyorum: CMF ${fmt(cmf, 2)}${cmfw != null ? ` (haftalık ${fmt(cmfw, 2)})` : ""} ve trend yukarı; para içeri giriyor. Geçmişte bu yapı piyasayı geçti (${k2ev("cmf_guclu")}). Kimin aldığını (aracı kurum/takas) göremiyorum, yalnızca parasal akışın yönünü.`
    : v < 0 ? `Tahta bana ${dist ? "dağıtım" : "para çıkışı"} gösteriyor: ${dist ? "hacim yüksek ama fiyat yerinde, CMF negatif: biri sessizce mal veriyor" : `CMF ${fmt(cmf, 2)}`}. Geçmişte bu sinyal olumsuz çıktı (${k2ev(dist ? "dagitim" : "cmf_zayif")}). Büyük oyuncunun kim olduğunu bilmiyorum ama yönü çıkışa bakıyor.`
    : acc ? `Hacim yüksek, fiyat yerinde, CMF pozitif: emilim izi var. Ama dürüst olayım, bu "birikim" sinyali geçmişte kanıtlanmadı (${k2ev("birikim")}); izleme listesine alırım.`
    : "Tahtada belirgin bir izi yok: ne güçlü bir para girişi ne de dağıtım var. Gerçek takas verisi olmadan daha fazlasını söylemem.";
  return {v, score: tally(checks).score, checks, t, plan: v > 0 ? "Para girişi sürdükçe tutun; CMF negatife dönerse azaltın." : v < 0 ? "Yeni alım yapmayın; mevcut pozisyonda CMF'yi izleyin." : "Bekleyin: akış teyidi yok.", dist, acc, strong, weak};
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
  const panic = s.change <= -6 && s.rvol >= 2.5 && s.rsi < 30, cm = crowdMeter();
  let v = 0; if ((panic && k2bad("panik")) || (trapBear && k2bad("ayi_tuzagi"))) v = -1;
  const checks = [
    chk(fomoStrict ? false : null, "FOMO: RSI > 78, 1 ayda > %25, hacim ≥ 2x", fomoStrict ? "evet · " + k2ev("fomo") : "hayır"),
    chk(fomo ? false : null, "Aşırı coşku: SMA20'nin %15 üstünde ve RSI > 75", fomo ? "evet · " + k2ev("fomo_kismi") : "hayır"),
    chk(panic ? false : null, "Panik satışı: gün ≤ −%6, hacim ≥ 2,5x, RSI < 30", panic ? "evet · " + k2ev("panik") : "hayır"),
    chk(trapBull ? false : null, "Boğa tuzağı: dün 20g zirve kırılımı, bugün ≤ −%2 ve hacimli", brkUp == null ? "geçmiş yok" : trapBull ? "evet · " + k2ev("boga_tuzagi") : "hayır"),
    chk(trapBear ? false : null, "Ayı tuzağı sıçraması: dün 20g dip kırılımı, bugün ≥ +%2 ve hacimli", brkDn == null ? "geçmiş yok" : trapBear ? "evet · " + k2ev("ayi_tuzagi") : "hayır"),
    chk(cm ? !(cm.idx >= 70 || cm.idx <= 30) : null, "Piyasa geneli coşku/korku dengeli", cm ? `${cm.label} (${fmt(cm.idx, 0)}/100; tavan ${cm.tav}, taban ${cm.tab})` : "–"),
    chk(null, "Sosyal medya ve yatırımcı forumları: veri kaynağı yok", "fiyat davranışı vekili kullanıldı")];
  const t = panic ? `Panik: hisse günde %${fmt(s.change, 1)} düştü, hacim ${fmt(s.rvol, 1)}x, RSI ${fmt(s.rsi, 0)}. Herkes çıkıyor, "dip" diye atlamak cazip. Verim ne diyor? Geçmişte böyle panikten sonra hisse 10 günde ortalama ${k2sig("panik") && k2sig("panik").h10 ? fmt(k2sig("panik").h10.excess, 1) : "?"}% daha geride kaldı: panik çoğu zaman devam ediyor. Düşen bıçağı tutmayın.`
    : trapBear ? `Dikkat, "ayı tuzağı" sıçraması: dün 20 günlük dibi kırdı, bugün %${fmt(s.change, 1)} sıçradı. Rahatlama gibi görünüyor ama geçmişte bu tür sıçramalar tutmadı (${k2ev("ayi_tuzagi")}). Teyit gelmeden güvenmeyin.`
    : trapBull ? `Olası boğa tuzağı: dün 20 günlük zirveyi kırdı, bugün %${fmt(s.change, 1)} geri verdi ve hacimli. Dürüst olayım: geçmişte bu tek başına anlamlı bir sinyal çıkmadı (${k2ev("boga_tuzagi")}); ama kırılımın tutmadığını not ediyorum, Livermore'un pivotu bu yüzden bozuldu.`
    : fomoStrict || fomo ? `Coşku var (RSI ${fmt(s.rsi, 0)}, SMA20'nin %${fmt((s.close / s.sma20 - 1) * 100, 0)} üstü). "Herkes alıyor" cümlesi beni ürkütür, ama veriye bakınca: BIST'te bu kadar coşkulu hisseler geçmişte çoğu zaman yükselmeye devam etti (${k2ev("fomo_kismi")}). Yani coşku tek başına satış nedeni değil; sadece geç kalmış alıcı olmayın.`
    : `Kalabalık davranışında uç bir işaret görmüyorum: ne FOMO ne panik ne de tuzak. Piyasa geneli: ${cm ? cm.label.toLowerCase() : "–"}. (Sosyal medyayı tarayamıyorum; yalnızca fiyat ve hacim davranışına bakıyorum.)`;
  return {v, score: tally(checks).score, checks, t, plan: v < 0 ? "Teyit gelene kadar bekleyin; tuzak ya da panik sürüyorsa yeni alım yapmayın." : "Kalabalığa karşı çıkmak için bir neden yok; kendi planınıza sadık kalın.", panic, trapBull, trapBear, fomo: fomoStrict || fomo, crowd: cm};
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
  return {lines, verdict: verdict + v2};
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
