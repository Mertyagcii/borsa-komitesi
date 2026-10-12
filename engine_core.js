/* engine_core.js: sanal portföyler (kâğıt üstünde işlem). core.js ile AYNI bağlamda çalışır (engine.js birleştirir).
   Gerçekçilik kuralları:
   - Sinyal gün sonu kapanışta üretilir; emir ERTESİ GÜN AÇILIŞTA (kayma + komisyonla) doldurulur. Aynı gün kapanışı kullanılmaz (ileriye bakış yok).
   - Stop gün içi en düşük (LOW) fiyata göre kontrol edilir; açılış stop'un altındaysa açılış fiyatından çıkılır (gap). Aynı gün hem stop hem hedef değerse stop önce sayılır.
   - Komisyon+BSMV ≈ %0,15 ve kayma %0,10 (taraf başına) varsayımdır. Nakit, tahvil getirisine yakın bir oranla faiz kazanır.
   - Yalnızca uzun pozisyon (BIST'te açığa satış kısıtlı). Bedelsiz/bölünme tespit edilirse adet düzeltilir. */
const ENGINE = {capital: 1000000, cost: 0.0015, slip: 0.0010};
let INTRA = null; // {date, bars:{HISSE:[[o,h,l,c],...]}}: varsa stop/hedef gün içi kronolojik sırayla yürütülür
const LEGENDS = ["buffett", "simons", "livermore", "kellogg", "komite"];
const LNAME = {buffett: "Warren Buffett", simons: "Jim Simons", livermore: "Jesse Livermore", kellogg: "Jack Kellogg", komite: "Komite (Şeytanın Avukatı gözetiminde)"};
const r2 = x => Math.round(x * 100) / 100;

function initState(date, cashYield) {
  return {version: 1, start: date, lastDate: null, config: {...ENGINE, cashYield}, bench: [],
    p: Object.fromEntries(LEGENDS.map(k => [k, {cash: ENGINE.capital, pos: [], orders: [], nav: [], trades: [], log: []}]))};
}
const posVal = (x, by) => x.sh * ((by[x.n] && by[x.n].close) || x.lastClose || x.avg);
const navOf = (p, by) => p.cash + p.pos.reduce((a, x) => a + posVal(x, by), 0);
const heldOrOrdered = (p, n) => p.pos.some(x => x.n === n) || p.orders.some(o => o.n === n && o.side === "buy");
const say = (p, date, text, n) => { p.log.push({d: date, n: n || null, text}); if (p.log.length > 400) p.log.splice(0, p.log.length - 400); };

function sellPos(p, pos, sh, px, date, why, lg) {
  sh = Math.min(sh, pos.sh); if (sh <= 0) return;
  const gross = sh * px, fee = gross * ENGINE.cost;
  p.cash += gross - fee;
  const pnl = gross - fee - sh * pos.avg;
  p.trades.push({d: date, n: pos.n, side: "SAT", sh, px: r2(px), pnl: r2(pnl), pct: r2((px * (1 - ENGINE.cost) / pos.avg - 1) * 100), why});
  pos.sh -= sh;
  if (pos.sh <= 0) p.pos.splice(p.pos.indexOf(pos), 1);
  say(p, date, `${pos.n}: ${sh} adet ${fmt(px)} TL'den sattım (${pnl >= 0 ? "+" : ""}${fmt(pnl, 0)} TL). ${why}`, pos.n);
}

function fillOrders(p, by, date, lg) {
  const keep = [];
  for (const o of p.orders) {
    const s = by[o.n];
    if (!s || !(s.open > 0)) { if (o.age < 2) keep.push({...o, age: o.age + 1}); continue; }
    if (o.side === "buy") {
      const px = s.open * (1 + ENGINE.slip);
      if (o.limit && s.open > o.limit) { say(p, date, `${o.n}: açılış ${fmt(s.open)} TL limitimin (${fmt(o.limit)}) üstünde, boşluk açtı; almadım.`, o.n); continue; }
      let sh = Math.floor(o.amount / (px * (1 + ENGINE.cost)));
      sh = Math.min(sh, Math.floor(p.cash / (px * (1 + ENGINE.cost))));
      if (sh <= 0) continue;
      const gross = sh * px, fee = gross * ENGINE.cost; p.cash -= gross + fee;
      let pos = p.pos.find(x => x.n === o.n);
      if (pos) {
        pos.avg = (pos.avg * pos.sh + gross + fee) / (pos.sh + sh); pos.sh += sh; pos.units = (pos.units || 1) + (o.unit || 0); pos.lastAdd = px;
        if (o.moveStop) pos.stop = Math.max(pos.stop || 0, o.moveStop);
      } else {
        pos = {n: o.n, sh, avg: (gross + fee) / sh, entry: date, entryPx: px, stop: o.stop ?? null, target: o.target ?? null, trimmed: false, peak: s.hi || px,
          days: 0, units: o.unit || 1, lastAdd: px, sector: s.sector, why: o.reason, fv: o.fv ?? null, lastClose: s.close};
        p.pos.push(pos);
      }
      p.trades.push({d: date, n: o.n, side: "AL", sh, px: r2(px), why: o.reason});
      say(p, date, `${o.n}: ${sh} adet ${fmt(px)} TL'den aldım (${fmt(gross, 0)} TL). ${o.reason}`, o.n);
    } else {
      const pos = p.pos.find(x => x.n === o.n); if (!pos) continue;
      const sh = o.frac && o.frac < 1 ? Math.max(1, Math.floor(pos.sh * o.frac)) : pos.sh;
      sellPos(p, pos, sh, s.open * (1 - ENGINE.slip), date, o.reason, lg);
    }
  }
  p.orders = keep;
}

/* gün içi: bölünme düzeltmesi, stop, hedef; günlük takip */
function manageDay(p, by, date, lg) {
  for (const pos of [...p.pos]) {
    const s = by[pos.n]; if (!s) continue;
    if (pos.lastClose && s.change != null) {
      const expected = pos.lastClose * (1 + s.change / 100), ratio = s.close / expected;
      if (Math.abs(ratio - 1) > 0.08) { // bedelsiz / bölünme / birleşme
        const f = expected / s.close;
        pos.sh = Math.round(pos.sh * f); pos.avg /= f; pos.entryPx /= f; pos.peak /= f; pos.lastAdd /= f;
        if (pos.stop) pos.stop /= f; if (pos.target) pos.target /= f; if (pos.fv) pos.fv /= f;
        say(p, date, `${pos.n}: fiyat yapısı değişti (bedelsiz/bölünme olabilir); adedi ${fmt(f, 2)} katsayıyla düzelttim.`, pos.n);
      }
    }
    if (pos.entry !== date) pos.days++;
    const bars = INTRA && INTRA.date === date && INTRA.bars && INTRA.bars[pos.n];
    if (bars && bars.length) { // kronolojik yürütme: önce hangisi gerçekleşti?
      let sold = false;
      for (const b of bars) {
        if (pos.stop && b[2] <= pos.stop) {
          sellPos(p, pos, pos.sh, Math.min(b[0], pos.stop) * (1 - ENGINE.slip), date, `Stop (${fmt(pos.stop)} TL) gün içinde çalıştı${b[0] < pos.stop ? " (boşlukla)" : ""}.`, lg);
          sold = true; break;
        }
        if (pos.target && !pos.trimmed && b[1] >= pos.target) {
          sellPos(p, pos, Math.max(1, Math.floor(pos.sh / 2)), pos.target * (1 - ENGINE.slip), date, `Hedef (${fmt(pos.target)} TL) geldi: yarısını sattım (scale out), kalanın stop'u girişe çekildi.`, lg);
          pos.trimmed = true; pos.stop = Math.max(pos.stop || 0, pos.avg);
        }
        pos.peak = Math.max(pos.peak, b[1]);
      }
      if (sold) continue;
      pos.lastClose = s.close;
      continue;
    }
    if (pos.stop && s.lo > 0 && s.lo <= pos.stop) {
      const px = Math.min(s.open, pos.stop) * (1 - ENGINE.slip);
      sellPos(p, pos, pos.sh, px, date, `Stop (${fmt(pos.stop)} TL) çalıştı${s.open < pos.stop ? " (açılış boşluğu)" : ""}.`, lg);
      continue;
    }
    if (pos.target && !pos.trimmed && s.hi >= pos.target) {
      sellPos(p, pos, Math.max(1, Math.floor(pos.sh / 2)), pos.target * (1 - ENGINE.slip), date, `Hedef (${fmt(pos.target)} TL) geldi: yarısını sattım (scale out), kalanın stop'u girişe çekildi.`, lg);
      pos.trimmed = true; pos.stop = Math.max(pos.stop || 0, pos.avg);
    }
    pos.peak = Math.max(pos.peak, s.hi || 0);
    pos.lastClose = s.close;
  }
}

function queueSell(p, pos, why, frac) {
  if (!p.orders.some(o => o.side === "sell" && o.n === pos.n)) p.orders.push({n: pos.n, side: "sell", frac: frac || 1, reason: why, age: 0});
}
function queueBuy(p, o) { p.orders.push({side: "buy", age: 0, ...o}); }
/* risk limiti (Şeytanın Avukatı): aynı sektörden en fazla maxN pozisyon+emir */
const sectorOk = (p, s, maxN) => p.pos.filter(x => x.sector === s.sector).length + p.orders.filter(o => o.side === "buy" && !o.add && ((window_by || {})[o.n] || {}).sector === s.sector).length < maxN;
let window_by = null;
const pendingBuyAmt = p => p.orders.filter(o => o.side === "buy").reduce((a, o) => a + o.amount, 0);
const pendingBuys = p => p.orders.filter(o => o.side === "buy" && !o.add).length;

/* ======== Sinyal üretimi (gün sonu, ertesi sabah açılış emirleri) ======== */
function signalsBuffett(p, stocks, by, date, nav) {
  for (const pos of p.pos) {
    const s = by[pos.n]; if (!s) continue; const b = buffett(s); pos.fv = b.fv || pos.fv;
    if (pos.days >= 20 && b.v < 0) queueSell(p, pos, "İşletme kalitesi bozuldu; ucuz diye tutmam.");
    else if (pos.days >= 20 && pos.fv && s.close >= pos.fv) queueSell(p, pos, `Fiyat adil değere (${fmt(pos.fv)} TL) ulaştı; artık güvenlik marjı yok.`);
  }
  const slots = 8 - p.pos.length - pendingBuys(p);
  if (slots <= 0) return;
  const c = stocks.filter(s => s.ok && s.tl >= 20 && !heldOrOrdered(p, s.name)).map(s => [s, buffett(s)]).filter(([, b]) => b.v > 0).sort((a, b) => b[1].mos - a[1].mos);
  if (!c.length) say(p, date, "Bugün alınacak işletme bulamadım: kalite ve fiyat birlikte tutmuyor. Beklemek de bir stratejidir.");
  for (const [s, b] of c.filter(([s]) => sectorOk(p, s, 3)).slice(0, slots)) {
    if (!sectorOk(p, s, 3)) continue;
    const amount = Math.min(0.12 * nav, p.cash - pendingBuyAmt(p)); if (amount < 0.02 * nav) break;
    queueBuy(p, {n: s.name, amount, limit: s.close * 1.03, fv: b.fv, reason: `Kalite ${b.quality}/100, adil değere göre güvenlik marjı %${fmt(b.mos, 0)} (adil değer ${fmt(b.fv)} TL). Uzun vadeli sahiplik.`});
    say(p, date, `${s.name} için alım emri verdim: iyi bir işletme ve fiyatı makul (güvenlik marjı %${fmt(b.mos, 0)}). Yarın açılışta alırım.`, s.name);
  }
}
function signalsSimons(p, stocks, by, date, nav) {
  for (const pos of p.pos) {
    const s = by[pos.n]; if (!s) continue; const m = simons(s);
    if (m.v < 0) queueSell(p, pos, "Model negatife döndü; modelin dediğini yaparım.");
    else if (pos.days >= 10) { if (m.v > 0) { pos.days = 0; say(p, date, `${pos.n}: 10 günlük ufuk doldu, model hâlâ pozitif; pozisyon yenilendi.`, pos.n); } else queueSell(p, pos, "10 günlük ufuk doldu ve model artık avantaj görmüyor."); }
  }
  const slots = 15 - p.pos.length - pendingBuys(p); if (slots <= 0) return;
  const c = stocks.filter(s => s.ok && s.tl >= 15 && !heldOrOrdered(p, s.name)).map(s => [s, simons(s)]).filter(([, m]) => m.v > 0 && m.w >= 1).sort((a, b) => b[1].exp - a[1].exp);
  for (const [s, m] of c.slice(0, slots * 2)) {
    if (p.pos.length + pendingBuys(p) >= 15 || !sectorOk(p, s, 4)) continue;
    const amount = Math.min(m.w / 100 * nav, p.cash - pendingBuyAmt(p)); if (amount < 0.01 * nav) break;
    queueBuy(p, {n: s.name, amount, limit: s.close * 1.03, stop: s.close * 0.92, reason: `Model beklentisi 10 günde ${m.exp > 0 ? "+" : ""}${fmt(m.exp, 2)}% fazla getiri (RS dilimi ${m.dec + 1}/10), ağırlık %${fmt(m.w, 1)}.`});
    say(p, date, `${s.name}: model pozitif (+${fmt(m.exp, 2)}%), %${fmt(m.w, 1)} ağırlıkla alım emri verdim. Hikâye bilmiyorum, örüntü biliyorum.`, s.name);
  }
}
function signalsLivermore(p, stocks, by, date, nav) {
  const bear = REGIME && REGIME.trend === "bear", unit = (bear ? 3 : 5) / 100 * nav;
  for (const pos of p.pos) {
    const s = by[pos.n]; if (!s) continue;
    if (s.sma20 && s.close < s.sma20) { queueSell(p, pos, "Fiyat SMA20'nin altında kapattı: kısa vadeli trend bozuldu."); continue; }
    if (s.sma50 && s.close < s.sma50) { queueSell(p, pos, "Trend bozuldu (SMA50 altı)."); continue; }
    if (pos.peak && s.close < pos.peak * 0.92) { queueSell(p, pos, "Zirveden %8 geri verdi; kârı koruyorum."); continue; }
    if (pos.units < 4 && s.close > pos.avg && s.close >= pos.lastAdd * 1.05 && !p.orders.some(o => o.n === pos.n && o.side === "buy")) {
      const amount = Math.min(unit, p.cash - pendingBuyAmt(p)); if (amount > 0.01 * nav)
        { queueBuy(p, {n: pos.n, amount, unit: 1, add: true, moveStop: pos.avg, reason: `Pozisyon kazanıyor (+%${fmt((s.close / pos.avg - 1) * 100, 1)}): piramit, ${pos.units + 1}. birim. Kazanana eklerim, kaybedene asla.`});
          say(p, date, `${pos.n} bana doğru yürüyor; bir birim daha ekleyeceğim (piramit). Stop maliyete çekilecek.`, pos.n); }
    }
  }
  const slots = 6 - p.pos.length - pendingBuys(p); if (slots <= 0) return;
  const c = stocks.filter(s => s.ok && s.tl >= 20 && !heldOrOrdered(p, s.name)).map(s => [s, livermore(s)]).filter(([, l]) => l.v > 0).sort((a, b) => b[0].rs - a[0].rs);
  if (!c.length) say(p, date, bear ? "Piyasa ayı rejiminde ve yeterince güçlü bir lider yok. Oturuyorum; beklemek de bir pozisyondur." : "Net bir pivot kırılımı yok. İşlem yapmıyorum.");
  for (const [s, l] of c.slice(0, slots * 2)) {
    if (p.pos.length + pendingBuys(p) >= 6 || !sectorOk(p, s, 3)) continue;
    const amount = Math.min(unit, p.cash - pendingBuyAmt(p)); if (amount < 0.01 * nav) break;
    const stop = Math.max(Math.min((s.h1m || s.close) * 0.97, s.close - 2 * (s.atr || s.close * 0.03)), s.close * 0.90); // yapı stopu ya da 2×ATR (hangisi daha geniş), en çok %10
    queueBuy(p, {n: s.name, amount, limit: s.close * 1.03, stop, unit: 1, reason: `Pivot ${fmt(l.pivot)} TL civarında, lider (RS ${fmt(s.rs, 0)}), trend yukarı: test alımı (hedef pozisyonun ~%25'i). Stop ${fmt(stop)} TL.`});
    say(p, date, `${s.name} pivotunda ve lider: küçük bir test alımı için emir verdim. Teyit gelirse eklerim.`, s.name);
  }
}
function signalsKellogg(p, stocks, by, date, nav) {
  for (const pos of p.pos) {
    const s = by[pos.n]; if (!s) continue;
    if (pos.days >= 8) queueSell(p, pos, "8 günlük süre doldu: momentum yoksa pozisyon da yok.");
    else if (pos.trimmed && s.close < pos.peak * 0.93) queueSell(p, pos, "Zirveden %7 geri verdi; kalan yarıyı da kapatıyorum.");
  }
  const slots = 5 - p.pos.length - pendingBuys(p); if (slots <= 0) return;
  const c = stocks.filter(s => s.ok && s.tl >= R.kTl && !heldOrOrdered(p, s.name)).map(s => [s, kellogg(s)]).filter(([, k]) => k.v > 0).sort((a, b) => b[0].change * b[0].rvol - a[0].change * a[0].rvol);
  for (const [s, k] of c.slice(0, slots * 2)) {
    if (p.pos.length + pendingBuys(p) >= 5 || !sectorOk(p, s, 2)) continue;
    const rps = s.close - k.stopPx; if (!(rps > 0)) continue;
    const amount = Math.min(0.20 * nav, 0.01 * nav / rps * s.close, p.cash - pendingBuyAmt(p)); if (amount < 0.01 * nav) break;
    queueBuy(p, {n: s.name, amount, limit: s.close * 1.04, stop: k.stopPx, target: s.close * 1.10, reason: `Hacim ${fmt(s.rvol, 1)}x, +%${fmt(s.change, 1)} itiş ve kırılım. Stop ${fmt(k.stopPx)} TL (sermayenin %1 riski), hedef +%10'da yarısını satarım.`});
    say(p, date, `${s.name} hacimle patladı (${fmt(s.rvol, 1)}x, +%${fmt(s.change, 1)}). Stop'u belli, yarın açılışta giriyorum.`, s.name);
  }
}
function signalsKomite(p, stocks, by, date, nav) {
  for (const pos of p.pos) {
    const s = by[pos.n]; if (!s) continue;
    if (s.atr) pos.stop = Math.max(pos.stop || 0, s.close - 2 * s.atr); // chandelier benzeri izleyen stop
    const r = committee(s);
    if (r.veto) queueSell(p, pos, `Şeytanın Avukatı veto etti: ${r.l.seytan.severe.join(", ")}.`);
    else if (r.score <= 0) queueSell(p, pos, "Masa artık olumlu değil (skor ≤ 0).");
    else if (pos.days >= 20) queueSell(p, pos, "20 günlük süre doldu.");
  }
  const slots = 10 - p.pos.length - pendingBuys(p); if (slots <= 0) return;
  const bySec = {}; p.pos.forEach(x => { bySec[x.sector] = (bySec[x.sector] || 0) + 1; });
  const pool = strengthList(stocks, 80, 15).filter(s => !heldOrOrdered(p, s.name));
  const c = pool.map(s => [s, committee(s)]).filter(([, r]) => r.score >= 2 && !r.veto && r.l.seytan.v === 0 && (r.l.livermore.v > 0 || r.l.simons.v > 0)).sort((a, b) => b[1].score - a[1].score || b[0].rs - a[0].rs);
  for (const [s, r] of c) {
    if (p.pos.length + pendingBuys(p) >= 10) break;
    if ((bySec[s.sector] || 0) >= 3) continue;
    const stopPct = r.l.seytan.stopPct; if (!stopPct) continue;
    const amount = Math.min(0.10 * nav, 0.01 * nav / (stopPct / 100), p.cash - pendingBuyAmt(p)); if (amount < 0.01 * nav) break;
    queueBuy(p, {n: s.name, amount, limit: s.close * 1.03, stop: s.close * (1 - stopPct / 100), reason: `Masa uzlaştı (skor ${r.score}/5, veto yok). Stop %${fmt(stopPct, 1)} (2×ATR); pozisyon sermayenin %1'ini riske atacak şekilde boyutlandı.`});
    say(p, date, `${s.name}: masa uzlaştı (skor ${r.score}). Şeytanın Avukatı veto etmedi; stop %${fmt(stopPct, 1)}, boyut risk kuralına göre.`, s.name);
    bySec[s.sector] = (bySec[s.sector] || 0) + 1;
  }
}

/* ======== Bir işlem günü ======== */
function runDay(st, data, date, idx) {
  const stocks = data.stocks.map(enrich), by = Object.fromEntries(stocks.map(s => [s.name, s])); window_by = by;
  rankUniverse(stocks); computeSectorStats(stocks); REGIME = computeRegime(stocks, HIST);
  current = strengthList(stocks, 25, 5);
  const prevDate = st.lastDate, days = prevDate ? Math.max(1, Math.round((new Date(date) - new Date(prevDate)) / 864e5)) : 0;
  const cy = st.config.cashYield || 0.30;
  for (const lg of LEGENDS) {
    const p = st.p[lg];
    if (prevDate) {
      p.cash += p.cash * cy * days / 365; // nakit faizi
      fillOrders(p, by, date, lg);
      manageDay(p, by, date, lg);
    }
    const nav = navOf(p, by);
    p.nav.push({d: date, v: r2(nav), c: r2(p.cash), rg: REGIME ? REGIME.trend : null});
    ({buffett: signalsBuffett, simons: signalsSimons, livermore: signalsLivermore, kellogg: signalsKellogg, komite: signalsKomite})[lg](p, stocks, by, date, nav);
  }
  // kıyas: BIST100 ve likit 150 hissenin eşit ağırlıklı endeksi
  const liquid = stocks.filter(s => s.close > 0 && s.volume).sort((a, b) => b.tl - a.tl).slice(0, 150).map(s => s.change).filter(c => c != null && Math.abs(c) <= 15);
  const mean = liquid.length ? liquid.reduce((a, b) => a + b, 0) / liquid.length : 0, last = st.bench[st.bench.length - 1];
  st.bench.push({d: date, xu: idx ?? (last ? last.xu : null), ew: r2((last ? last.ew : 100) * (prevDate ? 1 + mean / 100 : 1))});
  st.lastDate = date;
  return st;
}
