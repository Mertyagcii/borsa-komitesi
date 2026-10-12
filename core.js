/* core.js: efsane mantığı. Tarayıcı ve Node (GitHub Actions karne/uyarı) ortak kullanır.
   Dışarıdan beklenenler (çağrı anında): R, HIST, NEWS, current. */
const fmt = (v, d = 2) => v == null || Number.isNaN(v) ? "–" : Number(v).toLocaleString("tr-TR", {minimumFractionDigits: d, maximumFractionDigits: d});

const RULE_DEFS = [
  ["Buffett (Hagstrom'un finansal ve değer ilkeleri)", [["bRoe", "ROE en az %", 15], ["bDe", "Borç/Özsermaye en çok", 0.5], ["bNm", "Net kâr marjı en az %", 10], ["bPe", "F/K en çok", 15], ["bPb", "PD/DD en çok", 1.5], ["bMos", "Güvenlik marjı en az %", 25]]],
  ["Simons (istatistik)", [["sZ", "Sapma (z) en az", 1.8], ["sMinN", "Geri test min. sinyal", 5], ["sWin", "Min. kazanma % (10g)", 55], ["sEdge", "Taban üstü min. fark (puan)", 0.5]]],
  ["Livermore (trend & pivot)", [["lPiv", "Pivota yakınlık %", 1], ["lVol", "Min. göreceli hacim", 1.2]]],
  ["Kellogg (momentum)", [["kRvol", "Min. göreceli hacim", 2], ["kChg", "Gün içi hareket en az %", 3], ["kAtr", "Min. ATR %", 3]]],
  ["Şeytanın Avukatı (risk)", [["dAtr", "Günlük oynaklık üst sınır %", 4], ["dTl", "Min. hacim (mn TL)", 20], ["dStop", "Stop olasılığı % uyarı", 50], ["dMaxDd", "Son 1 yıl maks. düşüş % (üst sınır)", 35], ["dSector", "Aynı sektörden en fazla aday", 3], ["dFlags", "Karşı çıkma için bayrak sayısı", 2]]],
  ["Simülasyon", [["mDays", "Ufuk (iş günü)", 20], ["mStop", "Stop seviyesi %", 7]]],
];
const DEFAULTS = Object.fromEntries(RULE_DEFS.flatMap(([, f]) => f.map(([k, , v]) => [k, v])));

function enrich(s) {
  s.ok = s.close > 0 && s.bb_lower != null && s.bb_upper != null && s.sma50 != null;
  s.bbDist = s.ok ? (s.close / s.bb_lower - 1) * 100 : null;
  s.smaDist = s.ok ? (s.close / s.sma50 - 1) * 100 : null;
  s.atrPct = s.atr != null && s.close > 0 ? s.atr / s.close * 100 : null;
  s.tl = s.close * s.volume / 1e6; // günlük işlem hacmi, milyon TL
  return s;
}

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

/* ---------- Geri test (history.json'dan) ---------- */
function btFor(s) {
  if (!HIST) return null;
  const own = HIST.stocks[s.name] && HIST.stocks[s.name].bt, base = HIST.pooled.base, pooled = HIST.pooled.A;
  const useOwn = own && own.n >= R.sMinN && own.h10;
  const b = useOwn ? own : pooled;
  if (!b || !b.h10 || !base || !base.h10) return null;
  return { own: !!useOwn, n: b.n, win: b.h10.win, mean: b.h10.mean, med: b.h10.med, p10: b.h10.p10, aw: b.h10.aw, al: b.h10.al,
    baseWin: base.h10.win, baseMean: base.h10.mean, edge: b.h10.mean - base.h10.mean };
}

/* ---------- Efsaneler: her biri gerçek yatırım felsefesinin kontrol listesiyle çalışır ----------
   Kaynaklar (ikincil): Hagstrom "The Warren Buffett Way", Zuckerman "The Man Who Solved the Market", Livermore "Reminiscences of a Stock Operator"
   özetleri, Kellogg röportaj/özetleri. Kesin kural setleri kamuya açık değildir; burada yorumlanmış, ölçülebilir karşılıkları kullanılır. */
const OK = 1, BAD = -1, NA = 0;
const chk = (c, t, val) => ({s: c == null ? NA : c ? OK : BAD, t, val: val ?? ""});
const pc = v => v == null || Number.isNaN(v) ? "–" : "%" + fmt(v, 1);
function tally(checks) {
  const ok = checks.filter(c => c.s === OK).length, bad = checks.filter(c => c.s === BAD).length, n = ok + bad;
  return {ok, bad, n, score: n ? Math.round(ok / n * 100) : null};
}
const isFin = s => s.sector === "Finance";
const graham = s => s.eps > 0 && s.bvps > 0 ? Math.sqrt(22.5 * s.eps * s.bvps) : null;

function buffett(s) {
  const fin = isFin(s), gn = graham(s), mos = gn ? (gn - s.close) / gn * 100 : null;
  const checks = [
    chk(s.roe == null ? null : s.roe >= R.bRoe, `Özsermaye getirisi (ROE) ≥ %${R.bRoe}`, pc(s.roe)),
    chk(fin || s.de == null ? null : s.de <= R.bDe, `Borç/Özsermaye ≤ ${R.bDe}`, fin ? "banka/finans: geçerli değil" : fmt(s.de)),
    chk(s.nm == null || s.nm > 100 ? null : s.nm >= R.bNm, `Net kâr marjı ≥ %${R.bNm}`, s.nm > 100 ? `anormal (${pc(s.nm)}): değerleme/tek seferlik kalem olabilir` : pc(s.nm)),
    chk(fin || s.fcf == null ? null : s.fcf > 0, "Serbest nakit akışı pozitif (owner earnings vekili)", fin ? "banka/finans: geçerli değil" : s.fcf == null ? "–" : s.fcf > 0 ? "pozitif" : "negatif"),
    chk(s.epsg == null ? null : s.epsg > 0, "Hisse başı kazanç büyüyor (nominal)", pc(s.epsg)),
    chk(s.pe == null ? null : s.pe > 0 && s.pe <= R.bPe, `F/K ≤ ${R.bPe}`, fmt(s.pe, 1)),
    chk(s.pb == null ? null : s.pb <= R.bPb, `PD/DD ≤ ${R.bPb}`, fmt(s.pb)),
    chk(mos == null ? null : mos >= R.bMos, `Güvenlik marjı ≥ %${R.bMos} (Graham sayısı ${gn ? fmt(gn) + " TL" : "–"})`, pc(mos)),
    chk(null, "Rekabet avantajı (moat), basit iş modeli, uzun vadeli beklenti", "veriyle ölçülemez: kendiniz doğrulayın"),
    chk(null, "Dürüst ve yetenekli yönetim", "veriyle ölçülemez"),
  ];
  const k = tally(checks);
  const v = k.n >= 5 && k.score >= 70 ? 1 : k.n >= 4 && k.score < 40 ? -1 : 0;
  const t = v > 0 ? `Rakamlar kaliteli ve makul fiyatlı bir işletmeye benziyor (${k.ok}/${k.n} ölçülebilir ilke geçti).`
    : v < 0 ? `Ölçülebilir ilkelerin çoğu başarısız (${k.ok}/${k.n} geçti): ya iş zayıf ya da fiyat pahalı. "Harika bir işletmeyi makul fiyata" arıyorum; bu o değil.`
    : `Karışık tablo (${k.ok}/${k.n} geçti). Bariz bir iskonto ya da bariz bir kusur yok; acele etmem.`;
  const cap = gn ? gn * (1 - R.bMos / 100) : null;
  const plan = cap ? `${fmt(cap)} TL altını makul alım sayardı (Graham sayısı ${fmt(gn)} TL − %${R.bMos} güvenlik marjı). Stop kullanmaz; fiyat düşerse işletmenin değerini yeniden sorgular, uzun vadeli tutar.`
    : "Güvenlik marjı hesaplanamadı (EPS/defter değeri eksik). Stop kullanmaz; işletmeyi uzun vadeli sahiplik gözüyle değerlendirir.";
  return {v, score: k.score, checks, t, plan};
}

function simons(s) {
  const mc = monteCarlo(s), bt = btFor(s), h = HIST && HIST.stocks[s.name];
  const sd = (s.bb_upper - s.bb_lower) / 4, z = sd > 0 ? (s.close - (s.bb_upper + s.bb_lower) / 2) / sd : null;
  const checks = [
    chk(z == null ? null : z <= -R.sZ, `Fiyat 20 günlük ortalamadan ≥ ${R.sZ} standart sapma aşağıda (z-skoru)`, z == null ? "–" : fmt(z, 2)),
    chk(bt ? bt.n >= R.sMinN : null, `Geçmişte yeterli örnek (≥ ${R.sMinN} sinyal)`, bt ? `${bt.n} sinyal (${bt.own ? "bu hisse" : "tüm hisseler"})` : "geçmiş yok"),
    chk(bt ? bt.win >= R.sWin : null, `10 gün sonra kazanma oranı ≥ %${R.sWin}`, bt ? `${pc(bt.win)} (taban ${pc(bt.baseWin)})` : "–"),
    chk(bt ? bt.edge >= R.sEdge : null, `Ort. getiri tabanın ≥ ${R.sEdge} puan üstünde`, bt ? `${pc(bt.mean)} / taban ${pc(bt.baseMean)}` : "–"),
    chk(h && h.ac1 != null ? (h.ac1 <= -0.03 ? true : h.ac1 >= 0.08 ? false : null) : null, "Ortalamaya dönüş rejimi: günlük getirilerin otokorelasyonu negatif", h && h.ac1 != null ? fmt(h.ac1, 2) : "–"),
    chk(h ? h.sigma60 <= 1.5 * h.sigma250 : null, "Oynaklık rejimi sakin (60g σ ≤ 1,5 × 250g σ)", h ? `${pc(h.sigma60 * 100)} / ${pc(h.sigma250 * 100)}` : "–"),
    chk(mc ? mc.probStop < R.dStop : null, `Simülasyonda stop olasılığı < %${R.dStop}`, mc ? pc(mc.probStop) : "–"),
  ];
  const k = tally(checks);
  let kelly = null; if (bt && bt.aw > 0 && bt.al < 0) { const p = bt.win / 100, b = bt.aw / -bt.al; kelly = p - (1 - p) / b; }
  let v = 0;
  if ((mc && mc.probStop >= 65) || (bt && bt.edge <= -R.sEdge)) v = -1;
  else if (bt && bt.edge >= R.sEdge && bt.win >= R.sWin && z != null && z <= -R.sZ && k.score >= 60) v = 1;
  const t = v > 0 ? "Duygu yok, sadece sayı: sapma aşırı, geçmişte bu sinyal tabana göre pozitif sonuç vermiş. Yine de bu tek bir küçük avantaj; tek hisseye bahis değil, çok sayıda küçük avantajın toplamı kazandırır."
    : v < 0 ? "Sayılar aleyhine: ya geçmişte sinyal tabandan kötü sonuç vermiş ya da oynaklık stop'a değme ihtimalini çok yükseltiyor."
    : "Matematiksel olarak ayırt edilebilir bir avantaj göremiyorum. Avantaj yoksa işlem yok.";
  const plan = kelly == null ? "Geçmiş verisi (kazanç/kayıp oranı) yok; Kelly pozisyon büyüklüğü hesaplanamadı."
    : bt && bt.edge < R.sEdge ? `Tabana göre avantaj yok: pozisyon önerilmez. (Mutlak Kelly %${fmt(kelly * 100, 1)} görünse de bu, piyasanın nominal yükseliş eğiliminden gelir, sinyalden değil.)`
    : kelly > 0 ? `Kelly oranı %${fmt(kelly * 100, 1)}, yarı-Kelly %${fmt(kelly * 50, 1)}: pozisyon bu orandan büyük olmamalı (ekip Kelly'yi pozisyon boyutlamada kullanmıştır). Sinyal ufku ~10 iş günü.`
    : "Kelly ≤ 0: geçmiş veriye göre matematiksel avantaj yok, pozisyon önerilmez.";
  return {v, score: k.score, checks, t, plan};
}

function livermore(s) {
  const trend = s.sma200 == null ? null : s.close > s.sma50 && s.sma50 > s.sma200, pivot = s.h1m, np = pivot ? s.close / pivot : null;
  const checks = [
    chk(trend, "Ana trend yukarı: fiyat > SMA50 > SMA200", `${fmt(s.close)} / ${fmt(s.sma50)} / ${s.sma200 ? fmt(s.sma200) : "–"}`),
    chk(np == null ? null : np >= 1 - R.lPiv / 100 ? true : np < 0.95 ? false : null, `Pivot noktası (1 aylık zirve ${pivot ? fmt(pivot) : "–"}) kırılıyor ya da üstünde`, np == null ? "–" : `zirvenin ${pc(np * 100 - 100)}`),
    chk(s.rvol == null ? null : s.rvol >= R.lVol ? s.change > 0 : null, `Kırılım hacimle teyitli (göreceli hacim ≥ ${R.lVol}x ve fiyat artıyor)`, `${fmt(s.rvol, 1)}x, ${pc(s.change)}`),
    chk(s.close >= s.sma50 ? true : s.sma20 != null && s.close < s.sma20 ? false : null, "Düşen bıçak değil (SMA50 üstünde ya da toparlanıyor)", `SMA50'ye ${pc(s.smaDist)}`),
    chk(s.h52 ? s.close >= 0.85 * s.h52 : null, "Zirveye yakın: 52 hafta zirvesinin %85'i üstünde", s.h52 ? pc((s.close / s.h52 - 1) * 100) : "–"),
    chk(s.p3m == null ? null : s.p3m > 0, "Son 3 ayda fiyat artmış (en az direnç çizgisi yukarı)", pc(s.p3m)),
    chk(REGIME ? REGIME.trend !== "bear" : null, "Piyasa rejimi ayı değil (endeks trendi ve genişlik)", REGIME ? `${REGIME.label} · SMA50 üstü hisse %${fmt(REGIME.a50, 0)}` : "–"),
  ];
  const k = tally(checks);
  let v = k.n >= 4 && k.score >= 70 && trend !== false ? 1 : k.n >= 4 && k.score < 35 ? -1 : 0;
  if (REGIME && REGIME.trend === "bear" && v > 0) v = 0; // ayı piyasasında uzun pozisyon açmaz
  const t = v > 0 ? "Trend dostum: fiyat en az direnç çizgisinde, pivot üstünde ve hacim eşlik ediyor. Beklenti değil teyit arıyorum, burada teyit var."
    : v < 0 ? "Düşen bıçak tutulmaz. Trend aşağı ya da pivot çok uzakta; bu hisseye şimdi girmek umut ticaretidir."
    : "Net bir fırsat yok. Açık bir kırılım olmadan işlem yapmam; beklemek de bir pozisyondur.";
  const plan = pivot && np >= 0.95 ? `Pivot ${fmt(pivot)} TL üstünde hacimli kapanışta ilk küçük alım. Pozisyon kâra geçtikçe eklenir (piramit), zarardakine asla eklenmez. Yanılma noktası (stop): pivotun %3 altı ≈ ${fmt(pivot * 0.97)} TL; stop alım öncesinde belirlenir.`
    : "Şu an pivotun belirgin altında: işlem yok. Pivotu hacimle aşan bir kapanış beklenir; stop ancak alımdan önce belirlenirse anlamlıdır.";
  return {v, score: k.score, checks, t, plan};
}

function kellogg(s) {
  const rv = s.rvol, brk = s.h1m ? s.close >= s.h1m * 0.98 : null;
  const checks = [
    chk(rv == null ? null : rv >= R.kRvol, `Olağandışı hacim: göreceli hacim ≥ ${R.kRvol}x`, `${fmt(rv, 1)}x`),
    chk(s.change == null ? null : s.change >= R.kChg ? true : s.change <= -R.kChg ? false : null, `Güçlü hareket: gün içi ≥ %${R.kChg}`, pc(s.change)),
    chk(brk, "Kırılım: 1 aylık zirvenin %2 yakınında ya da üstünde", s.h1m ? pc((s.close / s.h1m - 1) * 100) : "–"),
    chk(s.pw == null ? null : s.pw > 0, "Haftalık momentum pozitif", pc(s.pw)),
    chk(s.atrPct == null ? null : s.atrPct >= R.kAtr, `Hareket kapasitesi: ATR ≥ %${R.kAtr}`, pc(s.atrPct)),
    chk(s.tl >= R.dTl, `Likidite/spread: günlük hacim ≥ ${R.dTl} mn TL`, `${fmt(s.tl, 0)} mn TL`),
  ];
  const k = tally(checks), big = rv != null && rv >= R.kRvol;
  const v = big && s.change > 0 && k.score >= 60 ? 1 : big && s.change < 0 ? -1 : 0;
  const t = v > 0 ? "Hacim patladı, fiyat kırılıyor: momentum teyitli. Hızlı hareket eden hisse, kısa vadeli fırsat."
    : v < 0 ? "Hacim yüksek ama fiyat düşüyor: bu dağıtım, alıcı değil satıcı baskın."
    : "Hacim ve kırılım yok; ilgi görmeyen hissede vakit kaybetmem.";
  const plan = s.lo ? `Stop: gün içi dip ${fmt(s.lo)} TL (fiyatın ${pc((s.lo / s.close - 1) * 100)} altı). Birkaç gün–hafta tutulur; kâr kademeli satılır (scale out), kayıp hızla kesilir, zarardaki pozisyona ekleme yapılmaz.` : "Stop için gün içi dip verisi yok.";
  return {v, score: k.score, checks, t, plan};
}

function devil(s, others) {
  const mc = monteCarlo(s), n = NEWS[s.name], h = HIST && HIST.stocks[s.name], sg = mc ? mc.sigma : s.atrPct;
  const secN = current.filter(x => x.sector === s.sector).length;
  const days = s.nextEarn ? (s.nextEarn * 1000 - NOW) / 864e5 : null;
  const stopPct = s.atrPct != null ? 2 * s.atrPct : null, maxPos = stopPct ? Math.min(100, 100 / stopPct) : null;
  const checks = [
    chk(mc ? mc.probStop < R.dStop : null, `${mc ? mc.days : R.mDays} günde %${R.mStop} stop'a değme olasılığı < %${R.dStop}`, mc ? pc(mc.probStop) : "–"),
    chk(sg == null ? null : sg <= R.dAtr, `Günlük oynaklık ≤ %${R.dAtr}`, pc(sg)),
    chk(s.tl >= R.dTl, `Likidite: günlük hacim ≥ ${R.dTl} mn TL (çıkış kolay)`, `${fmt(s.tl, 0)} mn TL`),
    chk(s.smaDist >= -5, "Fiyat SMA50'nin %5'ten fazla altında değil", pc(s.smaDist)),
    chk(s.l52 ? s.close >= 1.1 * s.l52 : null, "52 hafta dibine %10'dan fazla uzak (dipte değil)", s.l52 ? pc((s.close / s.l52 - 1) * 100) : "–"),
    chk(h && h.dd250 != null ? h.dd250 >= -R.dMaxDd : null, `Son 1 yılda maks. düşüş ≤ %${R.dMaxDd}`, h && h.dd250 != null ? pc(h.dd250) : "–"),
    chk(s.pe == null ? null : s.pe > 0, "Şirket kâr ediyor (F/K tanımlı)", fmt(s.pe, 1)),
    chk(n && n.ok ? n.score > -2 : null, "Haber akışı olumsuz değil", n && n.ok ? `skor ${n.score}` : "haber yok"),
    chk(secN <= R.dSector, `Sektör yoğunlaşması: aynı sektörden ≤ ${R.dSector} aday`, `${secN} aday`),
    chk(s.rsi == null ? null : s.rsi <= 70, "RSI aşırı alımda değil", fmt(s.rsi, 0)),
    chk(days == null ? null : !(days >= -1 && days <= 5), "Yaklaşan bilanço yok (5 gün içinde)", days == null ? "–" : days < -1 ? "geçti" : `${fmt(days, 0)} gün sonra (tahmini)`),
    chk(REGIME ? REGIME.trend !== "bear" : null, "Piyasa rejimi ayı değil", REGIME ? REGIME.label : "–"),
  ];
  const k = tally(checks), bads = checks.filter(c => c.s === BAD);
  const v = bads.length >= R.dFlags ? -1 : 0;
  const t = bads.length ? `Pre-mortem: bu işlem batarsa nedenleri şunlar olur → ${bads.slice(0, 3).map(c => c.t.replace(/ \(.*?\)/g, "")).join("; ")}.${v < 0 ? " Karşı çıkıyorum." : " Henüz itiraz sınırında değil."}`
    : "Pre-mortem'de belirgin bir başarısızlık nedeni bulamadım; ama makro şokta (kur, faiz, jeopolitik) BIST'te korelasyonlar 1'e gider.";
  const plan = stopPct ? `Stres testi: ATR stopu (2×ATR) ≈ %${fmt(stopPct, 1)}. Portföyün %1'ini riske atma kuralıyla azami pozisyon ≈ portföyün %${fmt(maxPos, 1)}. Hisse −%10 gap açarsa zarar portföyün ≈ %${fmt(maxPos * 0.1, 2)}'i olur.` : "ATR verisi yok; stres testi yapılamadı.";
  return {v, score: k.score, checks, t, plan};
}
function committee(s) {
  const l = { buffett: buffett(s), simons: simons(s), livermore: livermore(s), kellogg: kellogg(s) };
  l.seytan = devil(s, Object.values(l));
  const score = Object.values(l).reduce((a, x) => a + x.v, 0);
  const label = score >= 3 ? "GÜÇLÜ ADAY" : score >= 1 ? "İZLE" : score === 0 ? "NÖTR" : "UZAK DUR";
  return { l, score, label };
}

/* ---------- Zaman, piyasa rejimi ve efsane ekranları ---------- */
let NOW = Date.now();
let REGIME = null;
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
function personaScreens(uni, n, exclude) {
  const ex = new Set(exclude || []), rest = uni.filter(s => s.ok && s.tl >= 5 && !ex.has(s.name));
  const top = (fn, tie, pre) => (pre ? rest.filter(pre) : rest).map(s => [s, fn(s)]).filter(([, p]) => p.v > 0)
    .sort((a, b) => (b[1].score - a[1].score) || tie(a[0], b[0])).slice(0, n);
  return {
    buffett: top(buffett, (a, b) => b.tl - a.tl),
    simons: top(simons, (a, b) => a.bbDist - b.bbDist, s => { const sd = (s.bb_upper - s.bb_lower) / 4; return sd > 0 && HIST && HIST.stocks[s.name] && (s.close - (s.bb_upper + s.bb_lower) / 2) / sd <= -R.sZ; }),
    livermore: top(livermore, (a, b) => b.tl - a.tl),
    kellogg: top(kellogg, (a, b) => (b.rvol ?? 0) - (a.rvol ?? 0)),
  };
}
function riskRadar(uni, n) {
  return uni.filter(s => s.ok && s.tl >= 20).map(s => { const p = devil(s, []); return [s, p, p.checks.filter(c => c.s === BAD).length]; })
    .sort((a, b) => b[2] - a[2] || a[0].tl - b[0].tl).slice(0, n);
}
