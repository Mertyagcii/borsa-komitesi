/* guards.js: sanal portföy motorunun koruma katmanları. core.js ve engine_core.js ile AYNI bağlamda çalışır (engine.js birleştirir).
   Dört katman, hepsi kural tabanlıdır (LLM yok), hepsinin kararı portfolios.json içindeki `ai` bölümüne yazılır ve arayüzde görünür:
   1) Makro Kalkan eylemi (macroGuard): küresel risk bayrakları (VIX, DXY, ABD 10Y, Brent, altın, kur, TR faizi, jeopolitik ton) çoğalınca yeni alımı küçültür/erteler.
      DÜRÜST NOT: macro_research.json bayrakların BIST 100'ün sonraki getirisini ya da oynaklığını artırdığını göstermedi. Bu yüzden kalkan KANIT KAPILIDIR:
      kanıt (oynaklık artışı, t ≥ 1,64) oluşana kadar "izleme" modunda çalışır: ne yapacağını loglar, sonucu ölçer, ama alımı değiştirmez. GUARD.macroForce = true ile zorlanabilir.
   2) Şüpheci Denetçi (skeptic): her yeni alımda bağımsız olarak KUSUR arar; onay vermeden emir yazılmaz (kovalama, aşırı alım, olumsuz haber, kilitli rapor, oy birliği, vb.).
   3) Sağlık Tarayıcı (healthScan): seans içinde açık pozisyonları tarar; stop altı fiyat ya da olumsuz haber gelirse pozisyonu kapatır/yarıya indirir.
   4) Hata Hafızası (memRecord/memCheck): kapanan her işlemin gerekçesi ve bağlamı kaydedilir; benzer tuzaklar yeni alımlarda uyarı/ret üretir.
   Her ret ve onayın ileri 5/10 günlük sonucu ölçülür (decStats): Şüpheci/Kalkan gerçekten işe yarıyor mu, yoksa fazla mı katı, rakamla görünür. */
const GUARD = {macroForce: false, volT: 1.64, chase: 8, rsiHard: 82, rsiSoft: 70, ext: 25, atr: 6, fomo: 40, sector: 2, coolDays: 10, memMin: 8, memBlock: 0.75, healthEvery: 30, softMax: 2, bearRs: 50, corrHi: 0.6, corrN: 2};
let AIX = null, GST = null, GDATE = null, GMG = null;
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const capArr = (arr, n) => { if (arr.length > n) arr.splice(0, arr.length - n); };
const SEVERE_RE = /soruşturma|işlem yasağı|konkordato|iflas|temerrüt|haciz|el koy|tedbir kararı|sermaye kaybı|görüş bildirmekten kaçın|olumsuz görüş|hakkında dava|ceza/;

function bindAI(st, date) {
  GST = st; if (date) GDATE = date; GMG = null;
  if (!st.ai) st.ai = {v: 1, macro: null, macroLog: [], dec: [], health: [], mem: [], healthLast: null, backfilled: false};
  AIX = st.ai;
  if (!AIX.backfilled) { backfillMemory(st); AIX.backfilled = true; }
  return AIX;
}
/* geçmiş işlemlerden başlangıç hafızası (bağlam kaydı yok: yalnızca hisse/tarih/sonuç/çıkış gerekçesi) */
function backfillMemory(st) {
  for (const k of Object.keys(st.p)) for (const t of st.p[k].trades) if (t.side === "SAT") AIX.mem.push({d: t.d, port: k, n: t.n, pct: t.pct, pnl: t.pnl, win: t.pnl > 0, exit: t.why, legacy: true});
  capArr(AIX.mem, 2000);
}

/* ======== 1) Makro Kalkan eylemi ======== */
function macroGuard() {
  if (GMG) return GMG;
  let ms = null; try { ms = macroShield(); } catch (e) { ms = null; }
  const m = (HIST && HIST.macro) || {}, today = GDATE || "";
  const fresh = !!(ms && ms.live && m.date && (!today || dayDiff(m.date, today) <= 5));
  let n = fresh ? ms.count + (ms.geo && ms.geo.shock ? 1 : 0) : 0;
  if (fresh && m.vix > 30) n = Math.max(n, 2);
  const level = n >= 3 ? 3 : n >= 2 ? 2 : 0, rk = (typeof MACRO_R !== "undefined" && MACRO_R && MACRO_R.risk) || null;
  const supported = !!(rk && rk.vol_t != null && rk.vol_t >= GUARD.volT && rk.vol_fark > 0), active = level > 0 && (supported || GUARD.macroForce);
  const hi = rk && rk["2+"], lo = rk && rk["0-1"];
  GMG = {level, name: ["Normal", "Normal", "Temkinli", "Savunma"][level], count: n, fresh, date: m.date || null, supported, active,
    mode: !fresh ? "veri yok" : level === 0 ? "sakin" : active ? "etkin" : "izleme", mult: active ? (level === 3 ? 0 : 0.5) : 1,
    reasons: ms ? ms.items.filter(x => x.on).map(x => `${x.name} ${x.val}`) : [],
    evidence: hi && lo ? `Geçmişte 2+ bayrak varken BIST 100'ün sonraki 20 gün oynaklığı %${fmt(hi.vol20, 1)}, az bayrakta %${fmt(lo.vol20, 1)} (fark ${fmt(rk.vol_fark, 1)} puan, t ${fmt(rk.vol_t, 2)}); ${supported ? "kanıt var: kalkan etkin." : "kanıt YOK: kalkan izleme modunda, alımı değiştirmez."}` : "Risk ölçümü henüz yok: kalkan izleme modunda."};
  return GMG;
}

/* ======== 4) Hata Hafızası ======== */
function memFeatures(s, r, mg, p) {
  return {sector: s.sector || "?", rsiB: s.rsi == null ? "?" : s.rsi < 50 ? "<50" : s.rsi < 65 ? "50-65" : ">65", regime: REGIME ? REGIME.trend : "?", macro: mg.level, score: r.score,
    votes: {b: r.l.buffett.v, s: r.l.simons.v, l: r.l.livermore.v, k: r.l.kellogg.v}, rsi: s.rsi == null ? null : Math.round(s.rsi), lg: p && p.key || null};
}
function memRecord(p, pos, date, pct, why) {
  if (!AIX) return;
  const tot = pos.real || 0;
  AIX.mem.push({d: date, port: p.key || null, n: pos.n, sector: pos.sector || null, entry: pos.entry || null, days: pos.days || 0, pct: Math.round(pct * 100) / 100, pnl: Math.round(tot * 100) / 100,
    win: tot > 0, why: pos.why || null, exit: why, ctx: pos.ctx || null});
  capArr(AIX.mem, 2000);
}
/* Benzer geçmiş: (a) aynı hisse son günlerde zararla kapandı mı, (b) aynı sektör+RSI kuşağında kapanan işlemlerin zarar oranı tabandan anlamlı yüksek mi?
   Aynı hisse+giriş günü birden çok portföyde tekrar eder; bağımsız sayılmaz (tek kayıt). */
function memCheck(name, feat, today) {
  const hard = [], soft = [];
  if (!AIX) return {hard, soft};
  const recent = new Set(AIX.mem.filter(m => m.n === name && !m.win && m.d !== today && dayDiff(m.d, today) <= GUARD.coolDays && dayDiff(m.d, today) >= 0).map(m => m.d));
  if (recent.size >= 2) hard.push(`Hafıza: ${name} son ${GUARD.coolDays} günde ${recent.size} ayrı günde zararla kapandı (aynı tuzak tekrarı)`);
  else if (recent.size === 1) soft.push(`Hafıza: ${name} son ${GUARD.coolDays} günde zararla kapandı`);
  const done = new Map(); AIX.mem.filter(m => m.ctx).forEach(m => done.set(m.n + "|" + (m.entry || m.d), m));
  const all = [...done.values()];
  if (all.length >= GUARD.memMin) {
    const base = all.filter(m => !m.win).length / all.length, sim = all.filter(m => m.ctx.sector === feat.sector && m.ctx.rsiB === feat.rsiB);
    if (sim.length >= 4) {
      const L = sim.filter(m => !m.win).length / sim.length, se = Math.sqrt(Math.max(base * (1 - base), 0.0001) / sim.length), z = (L - base) / se;
      const txt = `Hafıza: aynı sektör ve RSI kuşağında kapanan ${sim.length} işlemin %${Math.round(L * 100)}'i zararla bitti (genel %${Math.round(base * 100)})`;
      if (sim.length >= GUARD.memMin && L >= GUARD.memBlock && z >= 1.64) hard.push(txt + " (anlamlı)"); else if (L >= GUARD.memBlock && L > base) soft.push(txt);
    }
  }
  return {hard, soft};
}

/* ======== 2) Şüpheci Denetçi ======== */
function skeptic(s, r, x) {
  const hard = [...((x.mem && x.mem.hard) || [])], soft = [...((x.mem && x.mem.soft) || [])];
  let fc = null; try { fc = factCheck(s, r); } catch (e) { fc = null; }
  if (fc && fc.locked) hard.push("Hata Avcısı raporu kilitledi (metin/veri çelişkisi)");
  if (r.veto) hard.push("Şeytanın Avukatı vetosu: " + r.l.seytan.severe.join(", "));
  if (s.change != null && s.change >= GUARD.chase) hard.push(`Kovalama: bugün %${fmt(s.change, 1)} yükselmiş (tavana yakın; ertesi gün açılış boşluğu riski)`);
  if (s.rsi != null && s.rsi > GUARD.rsiHard) hard.push(`RSI ${fmt(s.rsi, 0)}: aşırı alım`);
  const snt = stockSentiment(s.name);
  if (snt && snt.n >= 2 && snt.score <= -0.35) hard.push(`Haber akışı belirgin olumsuz (skor ${fmt(snt.score, 2)}, ${snt.n} başlık)`);
  else if (snt && snt.neg >= 1 && snt.kap >= 1 && snt.score < 0) soft.push("Olumsuz eğilimli KAP/özel durum türü başlık var");
  const v = r.l, all4 = [v.buffett, v.simons, v.livermore, v.kellogg].every(y => y.v > 0);
  if (all4) soft.push("Oy birliği: dört efsane de olumlu. Onay yanlılığı riski: karşı kanıt aranmadan hemfikir olunmuş olabilir");
  if (s.rsi != null && s.rsi > GUARD.rsiSoft && s.rsi <= GUARD.rsiHard) soft.push(`RSI ${fmt(s.rsi, 0)}: alım bölgesi sıcak`);
  if (s.smaDist != null && s.smaDist > GUARD.ext) soft.push(`Fiyat SMA50'nin %${fmt(s.smaDist, 0)} üstünde (aşırı uzama)`);
  if (s.atrPct != null && s.atrPct > GUARD.atr) soft.push(`Günlük oynaklık %${fmt(s.atrPct, 1)}: yüksek`);
  if (s.p1m != null && s.p1m > GUARD.fomo) soft.push(`Son 1 ayda %${fmt(s.p1m, 0)} yükselmiş (kovalama)`);
  if (s.rvol != null && s.rvol > 4 && s.change != null && s.change > 5) soft.push(`Hacim ${fmt(s.rvol, 1)}x ve fiyat %${fmt(s.change, 1)}: tükeniş (blow-off) riski`);
  /* Ayı rejimi yalnız zayıf göreceli güçteki adaylara çekince olur. Geriye test (portfolio_backtest.py, 2017-2026): RS lideri adaylar ayıda evreni
     geçmez ama onlardan kötü de değildir (fazla getiri ≈ 0, t 0,4); yani rejim tek başına "ele" gerekçesi değil. Eşik (RS<50) kanıt değil, tutucu bir yargıdır;
     RS bilinmiyorsa eski tutucu davranış sürer. Karar günlüğü (decStats) bunu canlı sınar. */
  if (REGIME && REGIME.trend === "bear" && (s.rs == null || s.rs < GUARD.bearRs)) soft.push(s.rs == null ? "Piyasa rejimi ayı (göreceli güç bilinmiyor)" : `Piyasa rejimi ayı ve zayıf göreceli güç (RS ${fmt(s.rs, 0)})`);
  if (x.p && x.p.pos.filter(y => y.sector === s.sector).length >= GUARD.sector) soft.push(`Portföyde aynı sektörden zaten ${GUARD.sector}+ pozisyon var`);
  /* Korelasyon çeşitlendirme: aynı sektör olmasa da fiyatı birlikte hareket eden pozisyonlar tek risk faktörü gibi davranır (portföy geriye testi: 10'lu RS portföyünde ortalama ikili ρ ≈ 0,25;
     bağımsız varsayım portföy riskini ~2,4 kat küçümsüyor). Aday, portföydeki ≥ corrN pozisyonla 60 günlük ρ ≥ corrHi ise çekince. Eşikler yargıdır; karar günlüğü sınar. */
  if (x.p && x.p.pos.length >= GUARD.corrN) {
    const ra = retsOf(s.name); if (ra) {
      const hi = x.p.pos.filter(y => y.n !== s.name).map(y => { const rb = retsOf(y.n); return rb && rb.length === ra.length ? {n: y.n, c: corr2(ra, rb)} : null; }).filter(y => y && y.c >= GUARD.corrHi);
      if (hi.length >= GUARD.corrN) soft.push(`Portföydeki ${hi.length} pozisyonla yüksek fiyat korelasyonu (${hi.slice(0, 3).map(y => y.n + " ρ" + fmt(y.c, 2)).join(", ")}): aynı risk faktörü yoğunlaşması`);
    }
  }
  if (x.mg && x.mg.level >= 2 && s.beta != null && s.beta > 1.3) soft.push(`Makro ${x.mg.name} iken yüksek beta (${fmt(s.beta, 2)})`);
  const days = s.nextEarn ? (s.nextEarn * 1000 - NOW) / 864e5 : null; if (days != null && days >= -1 && days <= 5) soft.push("Bilanço 5 gün içinde (sürpriz riski)");
  const ok = hard.length === 0 && soft.length < GUARD.softMax;
  return {ok, hard, soft, text: ok ? (soft.length ? `Onay (1 küçük çekince: ${soft[0]})` : "Onay: kusur bulunamadı") : `Ret: ${hard.concat(soft).join("; ")}`};
}

/* ======== kapı: her alım emri buradan geçer ======== */
function logDec(p, o, s, res, kind, why, shadow) {
  if (!AIX || !GST) return;
  const key = GDATE + "|" + p.key + "|" + o.n + "|" + kind;
  AIX.dec = AIX.dec.filter(e => e.k !== key);
  AIX.dec.push({k: key, d: GDATE, port: p.key || null, n: o.n, res, kind, why: why.slice(0, 6), shadow: shadow || null, px: s.close, bi: GST.bench.length, r5: null, r10: null, x5: null, x10: null});
  capArr(AIX.dec, 600);
}
function gateBuy(p, o) {
  if (!AIX || !GDATE) return o;
  const s = typeof window_by !== "undefined" && window_by ? window_by[o.n] : null; if (!s) return o;
  let r = null; try { r = committee(s); } catch (e) { return o; }
  const mg = macroGuard();
  if (mg.active && mg.mult === 0) {
    logDec(p, o, s, "ertele", "makro", [`Makro Kalkan ${mg.name}: ${mg.reasons.join("; ")}`]);
    say(p, GDATE, `${o.n}: Makro Kalkan (${mg.name}) alımı erteledi: ${mg.reasons.slice(0, 3).join("; ")}.`, o.n);
    return null;
  }
  const feat = memFeatures(s, r, mg, p); let sk = null;
  if (!o.add) {
    sk = skeptic(s, r, {p, mg, mem: memCheck(o.n, feat, GDATE)});
    if (!sk.ok) {
      logDec(p, o, s, "ret", "supheci", sk.hard.concat(sk.soft));
      say(p, GDATE, `${o.n}: Şüpheci Denetçi onay vermedi, emir yazılmadı. ${sk.text.replace(/^Ret: /, "")}.`, o.n);
      return null;
    }
  }
  const out = Object.assign({}, o, {ctx: feat});
  const shadow = mg.level > 0 && !mg.active ? (mg.level === 3 ? "ertelenirdi" : "yarıya inerdi") : null;
  if (mg.active && mg.mult < 1) { out.amount = o.amount * mg.mult; say(p, GDATE, `${o.n}: Makro Kalkan (${mg.name}) pozisyonu yarıya indirdi: ${mg.reasons.slice(0, 3).join("; ")}.`, o.n); }
  logDec(p, o, s, mg.active && mg.mult < 1 ? "küçült" : "onay", mg.active && mg.mult < 1 ? "makro" : "supheci", sk ? [sk.text] : ["makro kontrolü geçti"], shadow);
  return out;
}

/* açılışta doldurma öncesi son denetim: emir bir önceki kapanışta (ya da korumalardan önce) yazılmış olabilir; açılış verisiyle yeniden bakılır.
   Dönüş: ret gerekçesi (metin) ya da null (doldur). Yalnız yeni pozisyonlar (eklemeler hariç). */
function gateFill(p, o, s) {
  if (!AIX || !GDATE || !s || typeof window_by === "undefined" || !window_by || o.add) return null;
  let r = null; try { r = committee(s); } catch (e) { return null; }
  const mg = macroGuard(), sk = skeptic(s, r, {p, mg, mem: memCheck(o.n, memFeatures(s, r, mg, p), GDATE)});
  if (sk.ok) return null;
  const why = sk.hard.concat(sk.soft);
  logDec(p, o, s, "ret", "supheci-dolum", why);
  return why.join("; ");
}

/* ileri 5/10 işlem günü sonucu: karar günü kapanışına göre getiri ve eşit ağırlıklı likit endekse göre fazla getiri */
function resolveDec(st, by) {
  if (!AIX) return;
  const L = st.bench.length;
  for (const e of AIX.dec) {
    if (e.r10 != null) continue;
    const h = L - 1 - e.bi, b0 = st.bench[e.bi], s = by[e.n];
    if (h < 5 || !b0 || !s || !(s.close > 0) || !(e.px > 0)) continue;
    const r = (s.close / e.px - 1) * 100, x = r - (st.bench[L - 1].ew / b0.ew - 1) * 100, q = v => Math.round(v * 100) / 100;
    if (e.r5 == null) { e.r5 = q(r); e.x5 = q(x); }
    if (h >= 10) { e.r10 = q(r); e.x10 = q(x); }
  }
}
/* grup başına ölçüm: karar günleri bazında kümelenmiş (aynı gün aynı piyasa şoku paylaşılır) ortalama fazla getiri ve t */
function decStats(ai, field) {
  field = field || "x5";
  const grp = {};
  for (const e of (ai && ai.dec) || []) { if (e[field] == null) continue; const g = e.res + (e.shadow ? "*" : ""); ((grp[g] = grp[g] || {})[e.d] = grp[g][e.d] || []).push(e[field]); }
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length, out = {};
  for (const [g, byDay] of Object.entries(grp)) {
    const days = Object.values(byDay).map(mean), n = Object.values(byDay).reduce((a, v) => a + v.length, 0);
    const m = mean(days), sd = days.length > 1 ? Math.sqrt(days.reduce((a, v) => a + (v - m) ** 2, 0) / (days.length - 1)) : null;
    out[g] = {n, days: days.length, mean: Math.round(m * 100) / 100, t: sd ? Math.round(m / (sd / Math.sqrt(days.length)) * 100) / 100 : null};
  }
  return out;
}

/* ======== 3) Sağlık Tarayıcı (seans içi) ======== */
function healthScan(st, by, now) {
  bindAI(st, now.date);
  const out = [], push = (k, pos, act, why, px) => { const e = {d: now.date, t: now.hhmm, port: k, n: pos.n, act, why, px: Math.round(px * 100) / 100}; AIX.health.push(e); out.push(e); };
  let scanned = 0;
  for (const k of Object.keys(st.p)) {
    const p = st.p[k]; p.key = k;
    for (const pos of [...p.pos]) {
      const s = by[pos.n]; if (!s || !(s.close > 0)) continue;
      scanned++;
      const px = s.close, atr = s.atrPct != null ? s.atrPct : 3, fill = px * (1 - ENGINE.slip);
      const items = ((typeof NEWS !== "undefined" && NEWS && NEWS[pos.n] && NEWS[pos.n].items) || []).filter(i => i.ts > (pos.hs || 0) && now.ts - i.ts < 6 * 3600 && i.ts - now.ts < 600);
      let worst = null;
      for (const i of items) { const sc = sentiment(i.t).score, sev = SEVERE_RE.test(trLower(i.t)) || sc <= -0.95; if ((sc <= -0.3 || sev) && (!worst || sc < worst.sc)) worst = {t: i.t, sc, sev, kap: i.p === "kap"}; }
      if (items.length) pos.hs = Math.max(...items.map(i => i.ts));
      if (pos.stop && px <= pos.stop) { push(k, pos, "kapat", `Fiyat ${fmt(px)} TL stop seviyesinin (${fmt(pos.stop)}) altına indi`, px); sellPos(p, pos, pos.sh, fill, now.date, `Seans içi sağlık taraması: fiyat ${fmt(px)} TL stop (${fmt(pos.stop)}) altında; kapattım.`, k); continue; }
      if (worst && worst.sev) { push(k, pos, "kapat", `Ağır olumsuz ${worst.kap ? "KAP" : "haber"}: "${worst.t}"`, px); sellPos(p, pos, pos.sh, fill, now.date, `Seans içi olumsuz ${worst.kap ? "KAP" : "haber"} ("${worst.t}"): pozisyonu kapattım.`, k); continue; }
      if (worst) {
        const half = Math.max(1, Math.floor(pos.sh / 2)); push(k, pos, "yarıya indir", `Olumsuz haber (skor ${fmt(worst.sc, 2)}): "${worst.t}"; stop sıkılaştırıldı`, px);
        sellPos(p, pos, half, fill, now.date, `Seans içi olumsuz haber ("${worst.t}"): yarısını sattım, stopu sıkılaştırdım.`, k);
        if (pos.sh > 0) pos.stop = Math.max(pos.stop || 0, px * (1 - atr / 100));
        continue;
      }
      if (pos.stop && (px / pos.stop - 1) * 100 < 0.35 * atr && pos.hw !== now.date) { pos.hw = now.date; push(k, pos, "uyarı", `Fiyat ${fmt(px)} TL stopa (${fmt(pos.stop)}) %${fmt((px / pos.stop - 1) * 100, 1)} kala`, px); }
    }
  }
  capArr(AIX.health, 300);
  const hl = AIX.healthLast;
  if (out.length || !hl || now.ts - (hl.ts || 0) >= GUARD.healthEvery * 60) AIX.healthLast = {d: now.date, t: now.hhmm, ts: now.ts, n: scanned, a: out.length};
  return out;
}
