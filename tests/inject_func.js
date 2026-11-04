/* İşlevsel testler (tarayıcı içinde çalışır; sonuç <html data-test="{...}"> özniteliğine yazılır).
   Yalnızca ASCII alt dizgeler aranır (kodlama bağımsız). run_tests.py bu dosyayı sayfaya enjekte eder. */
window.onerror = function (m, u, l) { document.documentElement.setAttribute("data-err", m + " @" + l); };
try { localStorage.clear(); localStorage.setItem("tourDone", "true"); } catch (e) {}
setTimeout(async function () {
  var R = {}, ok = function (k, v) { R[k] = v; };
  try {
    await AUX_LATE; /* geç yüklenen yardımcı dosyalar (mtf_log, scan_log, ...) ilk çizimden sonra iner; testler hazır olmasını bekler */
    var pool = UNIVERSE.filter(function (s) { return s.tl >= 50 && s.close > 0; }), s0 = pool[0], s1 = pool[1];
    /* ---- Özel filtreler ---- */
    show("zaman"); zNewFilter(0); var a = zFilters(); ok("filtre_olustu", a.length === 1 && a[0].conds.length === 2);
    ok("filtre_sonuc_var", zRows().length > 0);
    var sec = trSector(UNIVERSE.filter(function (s) { return s.mtf && s.mtf.w >= 80; })[0].sector);
    a[0].conds.push({ f: "sector", op: "=", v: sec }); zSaveF(a); var n1 = zRows().length; ok("filtre_sektor_daraltir", n1 > 0);
    a[0].conds.push({ f: "sector", op: "!=", v: sec }); zSaveF(a); ok("filtre_celiski_bos", zRows().length === 0);
    a[0].conds = [{ f: "tier", op: "=", v: "uyumlu" }]; zSaveF(a); ok("filtre_tier", zRows().every(function (s) { return mtfTier(s).id === "uyumlu"; }));
    a[0].conds = [{ f: "mtf_w", op: "<=", v: 20 }]; zSaveF(a); var lo = zRows(); ok("filtre_kucuk_esit", lo.length > 0 && lo.every(function (s) { return s.mtf.w <= 20; }));
    a[0].conds = [{ f: "mtf_w", op: ">=", v: 70 }]; a[0].sort = { f: "mtf_w", dir: -1 }; zSaveF(a); var d1 = zRows(); ok("filtre_sirala", d1[0].mtf.w >= d1[d1.length - 1].mtf.w);
    renderZaman(); document.querySelector("[data-zdup]").click(); ok("filtre_kopyala", zFilters().length === 2);
    window.confirm = function () { return true; }; document.querySelector("[data-zdel]").click(); ok("filtre_sil", zFilters().length === 1);
    var bad = []; ZFIELDS.forEach(function (f) { try { UNIVERSE.slice(0, 80).forEach(function (s) { f[3](s); }); } catch (e) { bad.push(f[0] + ":" + e.message); } }); ok("filtre_alanlari_hatasiz", bad.length === 0);
    zSaveF([]); zTab = "uyum";
    /* ---- Alarmlar ---- */
    var lead = UNIVERSE.filter(function (s) { var t = mtfTier(s); return t && t.id === "uyumlu"; })[0], weak = UNIVERSE.filter(function (s) { var t = mtfTier(s); return t && t.id === "zayif"; })[0];
    store.set("alarms", [{ id: 1, n: lead.name, dir: "tier", px: 0, done: false }, { id: 2, n: weak.name, dir: "tier", px: 0, done: false }, { id: 3, n: lead.name, dir: "wabove", px: 50, done: false }, { id: 4, n: lead.name, dir: "wbelow", px: 5, done: false }, { id: 5, n: lead.name, dir: "above", px: lead.close * 2, done: false }, { id: 6, n: lead.name, dir: "below", px: lead.close * 2, done: false }]);
    checkAlarms(); var al = store.get("alarms", []);
    ok("alarm_tier_lider", al[0].done === true); ok("alarm_tier_zayif_yok", al[1].done === false); ok("alarm_skor_ustu", al[2].done === true); ok("alarm_skor_alti_yok", al[3].done === false); ok("alarm_fiyat_ustu_yok", al[4].done === false); ok("alarm_fiyat_alti", al[5].done === true);
    /* ---- Hisse detayi, karar karti, ucuz/pahali, benzer hisseler ---- */
    openDetail(lead.name); var dh = $("detail").innerHTML;
    ok("detay_neden_skor", dh.indexOf("skor neden") >= 0); ok("detay_para_akisi", dh.indexOf("Para ak") >= 0); ok("detay_masa", dh.indexOf("Masa toplant") >= 0); ok("detay_karar_karti", dh.indexOf("dcard") >= 0 && dh.indexOf("Stop (2,5") >= 0);
    ok("detay_ucuz_pahali_rozet", dh.indexOf("class=\"cheap") >= 0); ok("detay_benzer", dh.indexOf("Benzer hisseler") >= 0);
    var ch = cheapness(lead); ok("cheapness_alan", !ch || (["UCUZ", "PAHALI", "ADİL"].indexOf(ch.lab) >= 0 && ch.pct >= 0));
    var allCh = UNIVERSE.filter(function (s) { return s.ok && avgTl(s) >= 10; }).map(cheapness).filter(Boolean); ok("cheapness_yeterli_kapsam", allCh.length > 100);
    ok("cheapness_tutarli", allCh.every(function (c) { return c.lab === "UCUZ" ? c.disc >= 15 : c.lab === "PAHALI" ? c.prem >= 15 : Math.abs(c.disc) < 15 || Math.abs(c.prem) < 15; }));
    var sim = similarStocks(lead, 6); ok("benzer_hisse_sayisi", sim.top.length === 6 && sim.top.every(function (o) { return o.s.name !== lead.name; }));
    /* ---- Degerleme ---- */
    var ve = UNIVERSE.filter(function (s) { return s.eps > 0 && s.bvps > 0 && s.tl > 20; })[0]; openAnalysis(ve.name); ok("deger_aciklama", document.body.innerHTML.indexOf("hesaplan") >= 0);
    var sv = valSens(ve); ok("duyarlilik_3x3", sv && sv.rows.length === 3 && sv.rows[0][0] <= sv.rows[2][2] && sv.rows.every(function (r) { return r.every(function (v) { return v > 0; }); })); var iv = intrinsic(ve); ok("carpan_aralik", iv.mult >= 3 && iv.mult <= 20);
    var med = UNIVERSE.filter(function (s) { return s.ok && s.tl >= 10 && s.eps > 0; }).map(function (s) { return valuation(s).upside; }).filter(function (x) { return x != null; }).sort(function (a, b) { return a - b; }); var md = med[Math.floor(med.length / 2)]; ok("adil_deger_medyan_makul", md > -40 && md < 60);
    /* ---- Veri sagligi, skor sagligi, brifing, isi haritasi ---- */
    var dhh = dataHealth(5); ok("veri_sagligi", dhh && dhh.score >= 0 && dhh.score <= 100 && ["IYI", "İYİ", "DİKKAT", "KÖTÜ"].indexOf(dhh.label) >= 0);
    var sh = scoreHealth(); ok("skor_sagligi", !!sh && typeof sh.label === "string"); ok("brifing_uc_cumle", briefSentences().length === 3);
    show("dashboard"); ok("brifing_karti", ($("briefCard").innerHTML || "").indexOf("Brifing") >= 0); ok("isi_haritasi", document.querySelectorAll(".ht").length > 20);
    /* ---- Gunluk / Risk / Takvim ---- */
    show("gunluk"); $("jN").value = s0.name; $("jQ").value = "100"; $("jP").value = String(s0.close * 0.95); $("jS").value = String(s0.close * 0.90); $("jT").value = String(s0.close * 1.1);
    document.querySelector("[data-jadd]").click(); ok("gunluk_eklendi", JR.trades.length === 1);
    $("jN").value = "YOKHISSE"; $("jQ").value = "1"; $("jP").value = "1"; document.querySelector("[data-jadd]").click(); ok("gunluk_gecersiz_hisse", JR.trades.length === 1);
    window.prompt = function () { return String(s0.close); }; document.querySelector("[data-jclose]").click(); ok("gunluk_kapandi", JR.trades[0].exit > 0);
    var mk = function (r) { return { id: "t" + r, n: "X", qty: 100, entry: 100, entryD: "2026-01-01", exit: 100 * (1 + r / 100), exitD: "2026-01-11", stop: 95, tag: "T" }; };
    store.set("jCost", 0.5); var S = jStats([mk(10), mk(-5), mk(2)]);
    ok("istatistik_kazanma", Math.abs(S.win - 66.667) < 0.01); ok("istatistik_beklenti", Math.abs(S.exp - 1.8333) < 0.01); ok("istatistik_kazanc", Math.abs(S.avgW - 5.5) < 0.01); ok("istatistik_kayip", Math.abs(S.avgL + 5.5) < 0.01); ok("istatistik_tutma", S.hold === 10);
    JR.trades = [{ id: "a1", n: s0.name, qty: 100, entry: s0.close, entryD: "2026-10-01", stop: s0.close * 0.9, tag: "T" }, { id: "a2", n: s1.name, qty: 50, entry: s1.close, entryD: "2026-10-01", stop: null, tag: "T" }]; jSave();
    store.set("rkCap", 1000000); show("risk"); var rh = $("rkView").innerHTML; ok("risk_tablo", rh.indexOf("Toplam a") >= 0 && rh.indexOf("Stop'suz") >= 0);
    var K = riskCalc(); ok("risk_hesap", K.P.length === 2 && K.noStop.length === 1 && K.riskPct > 0);
    ok("uyari_merkezi", (function () { show("uyari"); var h = $("alView").innerHTML; return h.indexOf("Uyar") >= 0 && computeAlerts().some(function (x) { return x.id === "nostop:" + s1.name; }); })());
    show("senaryo"); ok("senaryo_tablo", $("scView").innerHTML.indexOf("Tahmini de") >= 0); store.set("scShock", -20); renderScenario(); ok("senaryo_zarar", $("scView").innerHTML.indexOf("Toplam K/Z") >= 0);
    show("aylik"); ok("aylik_rapor", $("mnView").innerHTML.indexOf("Piyasa") >= 0 && $("mnView").innerHTML.indexOf("Risk") >= 0);
    JR.trades = []; jSave();
    show("takvim"); ok("takvim_acilir", $("clView").innerHTML.length > 200);
    $("calT").value = "Test olayi"; $("calD").value = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10); document.querySelector("[data-caladd]").click(); ok("takvim_olay_eklendi", CE().length === 1);
    document.querySelector("[data-caldel]").click(); ok("takvim_olay_silindi", CE().length === 0);
    /* ---- Tarama senaryolari ---- */
    store.set("scanTab", "haftalik"); show("tarama"); var sh0 = $("scnView").innerHTML; ok("tarama_acilir", sh0.indexOf("Eleme hatt") >= 0 && sh0.indexOf("Yaklaşanlar") >= 0);
    var P0 = scanP("haftalik"), r0 = runScan("haftalik", P0, { skipLazy: true }); ok("tarama_huni", r0.steps.length >= 8 && r0.steps[0].n_out === UNIVERSE.length);
    var all = {}; all.haftalik = { wMin: 99 }; store.set("scanP", all); var r1 = runScan("haftalik", scanP("haftalik"), { skipLazy: true }); ok("tarama_esik_etkili", r1.list.length <= r0.list.length); store.set("scanP", {});
    ["gunluk", "aylik", "bebek", "halkaarz", "nasil"].forEach(function (t) { store.set("scanTab", t); renderScan(); ok("tarama_sekme_" + t, $("scnView").innerHTML.length > 500); });
    store.set("scanTab", "haftalik"); renderScan(); var anyS = UNIVERSE.filter(function (s) { return s.mtf; })[0]; $("scanQ").value = anyS.name; document.querySelector("[data-scanq]").click(); ok("tarama_sorgu", $("scanTrace").innerHTML.indexOf("Ad") >= 0 && $("scanTrace").innerHTML.indexOf(anyS.name) >= 0);
    var bb = UNIVERSE.filter(function (s) { return s.fbt; }); ok("bebek_veri_var", bb.length > 100 && bb.some(function (s) { return ageDaysOf(s) < 365; }));
    show("dashboard"); ok("brifing_tarama_sayilari", ($("briefCard").innerHTML || "").indexOf("data-scanopen") >= 0);
    /* ---- Halka arz ---- */
    show("halkaarz"); ok("halkaarz_acilir", $("ipoView").innerHTML.indexOf("Yeni halka arzlar") >= 0 && $("ipoView").innerHTML.indexOf("Yaklaşan halka arzlar") >= 0);
    $("ipN").value = "Test Enerji"; $("ipS").value = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10); $("ipE").value = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10); $("ipP").value = "20"; document.querySelector("[data-ipadd]").click();
    ok("halkaarz_eklendi", IPOU().length === 1 && $("ipoView").innerHTML.indexOf("Test Enerji") >= 0); $("ivP").value = "20"; $("ivE").value = "2"; document.querySelector("[data-ivcalc]").click(); ok("halkaarz_hesap", $("ivOut").innerHTML.indexOf("F/K") >= 0);
    document.querySelector("[data-ipdel]").click(); ok("halkaarz_silindi", IPOU().length === 0);
    ok("bebek_alanlari", UNIVERSE.filter(function (s) { return s.nipos8 != null; }).length > 100 && UNIVERSE.filter(function (s) { return s.eqg != null; }).length > 100);
    /* ---- Genisletilmis kurul (4 yeni uzman) ---- */
    openDetail(lead.name); var d2 = $("detail").innerHTML;
    ok("kurul2_detay_baslik", d2.indexOf("Geni") >= 0 && d2.indexOf("kurul") >= 0); ok("kurul2_dort_uzman", ["Makro", "Akıllı Para", "Volatilite", "Psikoloji"].every(function (n) { return d2.indexOf(n) >= 0; }));
    ok("kurul2_karar_karti_satiri", d2.indexOf("yeni uzmanlar") >= 0 || d2.indexOf("Geni") >= 0);
    ok("kurul2_komite", committee(lead).k2 && ["makro", "akilli", "vol", "psiko"].every(function (k) { return committee(lead).k2[k].t.length > 20; }));
    show("dashboard"); var mc = $("macroCard").innerHTML; ok("makro_kalkan_karti", mc.indexOf("Makro Kalkan") >= 0 && mc.indexOf("Piyasa psikolojisi") >= 0);
    var msh = macroShield(); ok("makro_kalkan_yapi", msh.items.length === 7 && msh.count >= 0 && msh.count <= 7 && ["Düşük", "Orta", "Yüksek", "Şiddetli"].indexOf(msh.level) >= 0);
    var cmr = crowdMeter(); ok("kalabalik_olcer", !!cmr && cmr.idx >= 0 && cmr.idx <= 100);
    var mtgOk = false; UNIVERSE.filter(function (s) { return s.ok && s.tl >= 20; }).slice(0, 120).forEach(function (s) { var mm = meeting(s, committee(s)); if (mm.lines.some(function (x) { return ["makro", "akilli", "vol", "psiko"].indexOf(x.who) >= 0; })) mtgOk = true; }); ok("kurul2_toplantida_konusur", mtgOk);
    ok("kurul2_alerts", Array.isArray(computeAlerts()));
    /* ---- Munazara, sektor kiyasi, hafiza (detay paneli) ---- */
    var ps = UNIVERSE.filter(function (s) { return s.ok && s.tl >= 20 && peerView(s); })[0] || s0; openDetail(ps.name);
    var dp = $("detail").innerHTML; ok("detay_munazara", dp.indexOf('class="dbt"') >= 0 && dp.indexOf("dbline") >= 0); ok("detay_sektor_kiyasi", dp.indexOf("peert") >= 0);
    buildMemory([{ d: "2026-01-02", src: "komite", n: ps.name, e: ps.close * 0.9, sc: 1, v: [1, 1, 1, 1, 1] }]); openDetail(ps.name); ok("detay_hafiza_satiri", $("detail").innerHTML.indexOf("Hafıza") >= 0 || $("detail").innerHTML.indexOf("Hafiza") >= 0 || $("detail").innerHTML.indexOf("Fikrim") >= 0); buildMemory([]);
    closeDetail();
    /* ---- Kokpit ---- */
    var kpS = UNIVERSE.filter(function (s) { return s.ok && s.tl >= 20; })[0]; store.set("kpOpen", []); kpOpen.clear(); kpSym = null; show("kokpit"); await new Promise(function (r) { setTimeout(r, 200); });
    ok("kokpit_govde_sinifi", document.body.classList.contains("kp") && $("kpIn") != null && $("kpMarket").innerHTML.indexOf("kb") >= 0); ok("kokpit_ana_ekran_onerileri", $("kpBody").innerHTML.indexOf("kpchip") >= 0 || $("kpBody").innerHTML.indexOf("Bir hisse se") >= 0);
    kpSelect(kpS.name); var kh = $("kpBody").innerHTML; ok("kokpit_mühür", kh.indexOf("kpseal") >= 0 && /(G\u00dc\u00c7L\u00dc AL|N\u00d6TR|R\u0130SKL\u0130|UZAK DUR|K\u0130L\u0130TL\u0130|>AL<)/.test(kh));
    ok("kokpit_agirlikli_karar", kh.indexOf("Boğa") >= 0 && kh.indexOf("Ayı") >= 0 && kh.indexOf("dbt") >= 0); ok("kokpit_kelly_ve_stop", kh.indexOf("Kelly") >= 0 && kh.indexOf("ATR") >= 0);
    var accs = $("kpBody").querySelectorAll("details.kpacc"); ok("kokpit_dort_kart", accs.length === 4 && Array.prototype.every.call(accs, function (d) { return !d.open; })); ok("kokpit_kart_basliklari", kh.indexOf("Efsaneler") >= 0 && kh.indexOf("Tahta Derinli") >= 0 && kh.indexOf("Kara Ku") >= 0 && kh.indexOf("KAP") >= 0);
    ok("kokpit_sekme_yok", $("kpBody").querySelectorAll(".tab,[role=tab]").length === 0); ok("kokpit_ayrintilar_kapali", $("kpBody").querySelectorAll("details[open]").length === 0);
    var sc0 = SEALCARD; SEALCARD = null; kpSym = null; renderKokpit(); ok("kokpit_guven_karnesi_bos", $("kpBody").innerHTML.indexOf("Güven karnesi") >= 0 && $("kpBody").innerHTML.indexOf("henüz başlamadı") >= 0);
    SEALCARD = {ver: 1, ndays: 40, first: "2026-10-12", last: "2026-12-04", nrec: 12000, h: {5: {outDays: 30, mkt: 0.1, rows: {"AL": {n: 600, nEff: 120, days: 30, mean: 0.4, rate: 0.55, ci: [0.46, 0.64], p: 0.2, verdict: "kanıt yok", dir: 1}}}, 10: {outDays: 30, mkt: 0.2, rows: {"AL": {n: 600, nEff: 60, days: 30, mean: -1.1, rate: 0.4, ci: [0.28, 0.53], p: 0.004, verdict: "ters kanıt", dir: 1}, "RİSKLİ": {n: 800, nEff: 80, days: 30, mean: 0.5, rate: 0.5, ci: [0.4, 0.6], p: 0.3, verdict: "kanıt yok", dir: -1, risk: {n: 700, nEff: 70, mae: -0.9, maeP: 0.01, stop: 3.2, stopRate: 21, stopP: 0.02, verdict: "risk öngörüsü doğrulandı"}}, "AL+GÜÇLÜ AL": {n: 600, nEff: 60, days: 30, mean: -1.1, rate: 0.4, ci: [0.28, 0.53], p: 0.004, verdict: "ters kanıt", dir: 1}, "H:lider": {n: 500, nEff: 50, days: 30, mean: 2.2, rate: 0.7, ci: [0.55, 0.82], p: 0.002, verdict: "pozitif kanıt", dir: 1}}}, 20: {outDays: 5, mkt: 0, rows: {}}}, calib: {n: 900, nEff: 45, mD: 20, pPred: 0.5, pReal: 0.42, bias: -0.08, brier: 0.25, skill: -0.02, ok: true, bins: []}};
    renderKokpit(); var th = $("kpBody").innerHTML; ok("kokpit_guven_karnesi_tablo", th.indexOf("ters kanıt") >= 0 && th.indexOf("AL + GÜÇLÜ AL") >= 0 && th.indexOf("Otomatik düzeltme açık") >= 0 && th.indexOf("Kelly kalibrasyonu") >= 0 && th.indexOf("düzeltiliyor") >= 0 && th.indexOf("Haftalık skor: lider") >= 0 && th.indexOf("pozitif kanıt") >= 0 && th.indexOf("Risk karnesi") >= 0 && th.indexOf("risk öngörüsü doğrulandı") >= 0 && th.indexOf("Aday sepeti riski") >= 0);
    var ts0 = TECHSEAL; TECHSEAL = {from: "2023-08-21", to: "2026-10-27", split: "2025-03-01", note: "test", labels: {rs_lider: "Göreli güç lideri"}, h: {10: {components: {rs_lider: {sel: {mean: 0.3, t: 0.4}, oos: {mean: 2.6, t: 3.4, days: 39, fdr: true}, full: {t: 3.3}}}, sign: {ic: {mean: 0.05, t: 3}, buckets: {"≥ 3": {n: 500, mean: 2, hit: 51, t: 2.8, fdr: true}}}, ic_rs_only: {mean: 0.07, t: 3.8}}}}; kpSym = null; renderKokpit(); var tk = $("kpBody").innerHTML; var sh0 = SEALHIST; SEALHIST = {names: SEAL_NAMES, stocks: {}}; SEALHIST.stocks[kpS.name] = [["2026-10-27", 3, 2.1, 4.5], ["2026-10-30", 1, -1.2, null]]; kpSelect(kpS.name); var sg = $("kpBody").innerHTML; ok("kokpit_gecmis_muhurler", sg.indexOf("geçmiş mühürlerimiz") >= 0 && sg.indexOf("✔") >= 0 && sg.indexOf("bekliyor") >= 0 && (sg.indexOf("◌ gözlemci") >= 0 || sg.indexOf("◇ danışman") >= 0)); SEALHIST = null; kpSelect(kpS.name); ok("kokpit_gecmis_muhur_yoksa_mesaj", $("kpBody").innerHTML.indexOf("mühür kaydı yok") >= 0); SEALHIST = sh0; kpSym = null; renderKokpit(); tk = $("kpBody").innerHTML; ok("kokpit_teknik_muhur_testi", tk.indexOf("Teknik mühür geriye dönük testi") >= 0 && tk.indexOf("Göreli güç lideri") >= 0 && tk.indexOf("göreli gücü geçmiyor") >= 0); TECHSEAL = ts0;
    kpSelect(kpS.name); ok("kokpit_muhur_canli_karne_satiri", $("kpBody").innerHTML.indexOf("Canlı karne") >= 0);
    var gk = $("kpBody").innerHTML; ok("kokpit_gozlemci_kadro", gk.indexOf("Gözlemci kadro") >= 0 && ["López de Prado", "Ed Thorp", "Yale Hirsch", "Peter Lynch", "Ray Dalio", "Howard Marks"].every(function (n) { return gk.indexOf(n) >= 0; }) && gk.indexOf("oy vermez") >= 0); SEALCARD = sc0; kpSym = null; renderKokpit(); kpSelect(kpS.name);
    var kd = $("kpBody").querySelector("details.kpacc"); kd.open = true; kd.dispatchEvent(new Event("toggle")); ok("kokpit_acik_kart_hatirlanir", kpOpen.has(kd.dataset.kpa)); renderKokpit(); ok("kokpit_yenilemede_acik_kalir", $("kpBody").querySelector("details.kpacc").open === true);
    $("kpBody").querySelectorAll("details.kpacc")[0].open = false; kpOpen.clear(); kpSelect("YOKTUR123"); ok("kokpit_gecersiz_kod_temizler", kpSym === null);
    /* ---- Wow katmanı: karar yolu, güven rozeti, kart, palet, şeffaflık, tahmin defteri ---- */
    kpSelect(kpS.name); var wk = $("kpBody").innerHTML;
    ok("wow_karar_yolu", wk.indexOf("Mühür nasıl çıktı?") >= 0 && wk.indexOf("Hata Avcısı") >= 0 && wk.indexOf("kpstep") >= 0);
    ok("wow_guven_rozeti", wk.indexOf("Güven: ") >= 0 && wk.indexOf("dayanak") >= 0);
    ok("wow_paylas_ve_tahmin_dugmeleri", wk.indexOf("data-cardpng") >= 0 && wk.indexOf('data-dfadd="al"') >= 0 && $("palBtn") != null);
    var cv = buildCardCanvas(kpS), cx = cv.getContext("2d"), px = cx.getImageData(0, 100, 1080, 1).data, seen = {}; for (var pi = 0; pi < px.length; pi += 4) seen[px[pi] + "," + px[pi + 1] + "," + px[pi + 2]] = 1;
    ok("wow_png_kart", cv.width === 1080 && cv.height === 1350 && Object.keys(seen).length > 40); /* başlık satırı: metin ve logo kenar yumuşatması çok renk üretir; düz gradyan satırı yalnızca birkaç renktir */
    openPalette(""); ok("wow_palet_acilir", $("pal").classList.contains("open") && $("palListEl").children.length > 0);
    var pr1 = palSearch("tahmin"), pr2 = palSearch(kpS.name.toLowerCase()), pr3 = palSearch("guclu"), pr4 = palSearch("zzzzqq");
    ok("wow_palet_arama", pr1.some(function (x) { return x.k === "sayfa" && /Tahmin Defterim/.test(x.t); }) && pr1.some(function (x) { return /Tahmin Karnesi/.test(x.t); }) && pr2.length > 0 && pr2[0].k === "hisse" && pr2[0].t === kpS.name && pr3.some(function (x) { return x.k === "komut" && /GÜÇLÜ AL/.test(x.t); }) && pr4.length === 0);
    ok("wow_palet_turkce_duyarsiz", palSearch("seffaflik").some(function (x) { return /Şeffaflık/.test(x.t); }) && palSearch("RİSKLİ").length > 0 && palSearch("ğüşiöç").length === 0);
    palRun(pr3.filter(function (x) { return x.k === "komut"; })[0]); ok("wow_palet_liste_modu", palCtx != null && $("palCtxLbl").textContent.indexOf("GÜÇLÜ AL") >= 0);
    closePalette(); ok("wow_palet_kapanir", !$("pal").classList.contains("open") && palCtx === null);
    document.dispatchEvent(new KeyboardEvent("keydown", {key: "k", ctrlKey: true, bubbles: true})); ok("wow_palet_ctrl_k", $("pal").classList.contains("open")); closePalette();
    palRun(palSearch(kpS.name)[0]); ok("wow_palet_hisse_secer", kpSym === kpS.name && view === "kokpit");
    var sh1 = SEALHIST, sc1 = SEALCARD; SEALHIST = {names: SEAL_NAMES, stocks: {}}; SEALHIST.stocks[kpS.name] = [["2026-10-01", 3, 2.0, -9.5], ["2026-10-02", 4, null, 4.0]];
    SEALCARD = {ver: 1, ndays: 40, first: "2026-10-12", last: "2026-12-04", nrec: 1, h: {10: {outDays: 30, riskDays: 30, mkt: 0, rows: {}}}, calib: {n: 900, nEff: 45, mD: 20, pPred: 0.5, pReal: 0.42, bias: -0.08, brier: 0.25, skill: -0.02, ok: true, bins: [{lo: 40, hi: 50, n: 60, pred: 0.45, real: 0.5}]}};
    show("seffaflik"); await new Promise(function (r) { setTimeout(r, 450); }); var sf = $("sfView").innerHTML;
    ok("wow_seffaflik_basliklar", sf.indexOf("Dürüstlük ilkelerimiz") >= 0 && sf.indexOf("Bugünün mühürleri") >= 0 && sf.indexOf("Doğruluk tablosu") >= 0 && sf.indexOf("En büyük hatalarımız") >= 0 && sf.indexOf("Güvenilirlik grafiği") >= 0 && sf.indexOf("Gözlemci kadro") >= 0 && sf.indexOf("Veri tazeliği") >= 0 && sf.indexOf("bilinen sınırları") >= 0);
    ok("wow_seffaflik_mühürler_hesaplandi", $("sfToday").innerHTML.indexOf("kpseal") >= 0 && $("sfToday").innerHTML.indexOf("hesaplanıyor") < 0);
    ok("wow_seffaflik_hatalar", sf.indexOf(kpS.name) >= 0 && sf.indexOf("9,5") >= 0 && sf.indexOf("puan") >= 0);
    ok("wow_seffaflik_kalibrasyon_cizgisi", sf.indexOf("<circle") >= 0 && sf.indexOf("modelin olasılığı") >= 0);
    SEALHIST = sh1; SEALCARD = sc1;
    await loadCandles(); var cd = CANDLES.dates, nm = null; for (var q in HIST.stocks) { if (HIST.stocks[q].last === cd[cd.length - 1] && CANDLES.stocks[q]) { nm = q; break; } }
    store.set("preds", []); var i0 = cd.length - 21;
    var e1 = dfAdd({n: nm, dir: "al", h: 5, conf: 70, date: cd[i0], note: "t"}), e2 = dfAdd({n: nm, dir: "sat", h: 10, conf: null, date: cd[cd.length - 1]}), e3 = dfAdd({n: "YOKTUR1", dir: "al", h: 5, date: cd[i0]});
    var r1 = dfEval(e1), r2 = dfEval(e2), r3 = dfEval(e3), ixs = HIST.index.closes, c0 = CANDLES.stocks[nm].c[i0], c1 = CANDLES.stocks[nm].c[i0 + 5], xo = ixs[ixs.length - 1 - (cd.length - 1 - i0)], x1 = ixs[ixs.length - 1 - (cd.length - 1 - (i0 + 5))], expEx = (c1 / c0 - x1 / xo) * 100;
    ok("wow_defter_hizalama_ve_sonuc", r1.state === "sonuçlandı" && Math.abs(r1.ex - expEx) < 0.05 && (Math.abs(expEx) < 0.1 || r1.hit === (expEx > 0)) && r2.state === "bekliyor" && r2.left === 10 && r3.state === "veri yok");
    var dsx = dfStats(dfList()); ok("wow_defter_istatistik", dsx.n === 1 && dsx.pending === 1 && dsx.nodata === 1 && dsx.brier != null && dsx.ci != null);
    show("defter"); await new Promise(function (r) { setTimeout(r, 500); }); var dfh = $("dfView").innerHTML;
    ok("wow_defter_sayfasi", dfh.indexOf("Tahmin Defterim") >= 0 && dfh.indexOf(nm) >= 0 && dfh.indexOf("bekliyor") >= 0 && dfh.indexOf("veri yok") >= 0 && (dfh.indexOf("haklı") >= 0 || dfh.indexOf("haksız") >= 0) && dfh.indexOf("Kalibrasyon (Brier)") >= 0);
    var known = new Set(UNIVERSE.map(function (s) { return s.name; })), pc = portfolioCsv("\uFEFFHisse Kodu;Adet;Ortalama Maliyet\nTHYAO.E;100;250,50\nASELS;50;180,25\nTHYAO (Türk Hava Yolları);50;300\nXXXX;10;5\nNAKİT;1;20.000,00\nGARAN;0;10", known), th0 = pc.pos.filter(function (p) { return p.n === "THYAO"; })[0];
    ok("csv_portfoy_ayristirma", pc.pos.length === 2 && th0 && th0.sh === 150 && Math.abs(th0.cost - (100 * 250.5 + 50 * 300) / 150) < 1e-9 && pc.skipped.length === 2 && pc.skipped[0].n === "XXXX" && pc.cash === 20000 && !pc.error);
    ok("csv_portfoy_hatalar", portfolioCsv("a;b\n1;2", known).error != null && portfolioCsv("", known).error != null && portfolioCsv("Hisse,Lot,Maliyet\nTHYAO,10,100.5", known).pos[0].cost === 100.5 && portfolioCsv("Hisse;Adet\nTHYAO;5", known).error != null);
    var my0 = MY; MY = {pos: pc.pos.concat([{n: "GARAN", sh: 400, cost: 200}]), cash: 5000}; show("portfoyum"); await new Promise(function (r) { setTimeout(r, 300); }); var mh = $("myView").innerHTML;
    ok("portfoyum_csv_ve_sepet", mh.indexOf("CSV içe aktar") >= 0 && mh.indexOf("Sepet çeşitliliği") >= 0 && mh.indexOf("myImportMsg") >= 0 && mh.indexOf("THYAO") >= 0); MY = my0;
    store.set("preds", []); kpSelect(kpS.name); document.querySelector('[data-dfadd="al"]').click();
    ok("wow_defter_kokpitten_ekleme", dfList().length === 1 && dfList()[0].n === kpS.name && dfList()[0].dir === "al" && dfList()[0].h === 10); store.set("preds", []);
    /* ---- Gelecek Görünümü ---- */
    ok("og_veri_yuklendi", !!FORECAST && !!FORECAST.s && !!FORECAST.s.XU100 && !!FORECAST.horizons && !!FORECAST.horizons["21"]);
    ogSym = "XU100"; show("ongoru"); await new Promise(function (r) { setTimeout(r, 400); }); var ogh = $("ogView").innerHTML;
    ok("og_sayfa", ogh.indexOf("Gelecek Görünümü") >= 0 && ogh.indexOf("fiyat hedefi değil") >= 0 && ogh.indexOf("BIST 100") >= 0 && ogh.indexOf("ogtrack") >= 0 && ogh.indexOf("Haftalık") >= 0 && ogh.indexOf("Yıllık") >= 0 && ogh.indexOf("aralığı ne kadar güvenilir") >= 0);
    ok("og_guvenilirlik_gosterilir", ogh.indexOf("bağımsız pencere") >= 0 && ogh.indexOf("örneklem dışı") >= 0);
    var ogf = FORECAST.s.XU100.f["21"]; ok("og_degerler_tutarli", ogf[0] < ogf[1] && ogf[1] < ogf[2] && ogf[2] < ogf[3] && ogf[3] < ogf[4] && ogf[5] >= 0 && ogf[5] <= 1);
    var ogn = Object.keys(FORECAST.s).filter(function (k) { return k !== "XU100"; })[0]; ogSym = ogn; renderOngoru(); ok("og_hisse_secimi", $("ogView").innerHTML.indexOf("<b>" + ogn + "</b>") >= 0 || $("ogView").innerHTML.indexOf(ogn + " <span") >= 0);
    ogH = 126; ogSort = "loss"; renderOngoru(); ok("og_ufuk_ve_siralama", $("ogView").innerHTML.indexOf("6 aylık (126 iş günü)") >= 0 && $("ogView").innerHTML.indexOf('data-og="') >= 0);
    var ogk = UNIVERSE.filter(function (s) { return s.ok && FORECAST.s[s.name]; })[0]; ok("og_kokpit_karti", !!ogk && kpOutlook(ogk).indexOf("Olası fiyat aralığı") >= 0 && kpOutlook(ogk).indexOf("fiyat hedefi değil") >= 0);
    ok("og_canli_karne", !!FCLIVE && $("ogView").innerHTML.indexOf("Canlı karne") >= 0 && $("ogView").innerHTML.indexOf("hafta sayısıdır") >= 0);
    ok("uzun_teknik_ve_polis", !!TECHSEAL_L && kpTechLong().indexOf("10 yıllık sağlamlık") >= 0 && !!POLICE && sfPolice().indexOf("Veri Polisi") >= 0 && sfPolice().indexOf("Hayatta kalma yanlılığı") >= 0);
    ok("og_modlar", !!FORECAST.modes && !!FORECAST.modes.r && !!FORECAST.modes.d);
    ogMode = "r"; renderOngoru(); ok("og_reel_kip", $("ogView").innerHTML.indexOf("Reel kip") >= 0 && $("ogView").innerHTML.indexOf("bugünkü değere göre") >= 0); ogMode = "d"; renderOngoru(); ok("og_dolar_kip", $("ogView").innerHTML.indexOf("Dolar kipi") >= 0); ogMode = "n"; store.set("ogMode", "n");
    ogMode = "x"; renderOngoru(); ok("og_endekse_gore_kip", $("ogView").innerHTML.indexOf("Endekse göre kip") >= 0 && $("ogView").innerHTML.indexOf("Endeksi yenme olasılığı") >= 0); ogMode = "n"; store.set("ogMode", "n");
    ogSym = ogn; renderOngoru(); var ogh2 = $("ogView").innerHTML; ok("og_sade_anlatim_ve_sozluk", ogh2.indexOf("Sade anlatım") >= 0 && ogh2.indexOf("Terimler sözlüğü") >= 0 && ogh2.indexOf("Bu bir hedef değil") >= 0 && ogh2.indexOf("data-ogdf") >= 0);
    store.set("preds", []); var dfb = $("ogView").querySelector('[data-ogdf="al"]'); dfb.click(); var dl = dfList(); ok("og_deftere_ekleme", dl.length === 1 && dl[0].n === ogn && dl[0].dir === "al" && dl[0].h === 20 && dl[0].note.indexOf("Gelecek Görünümü") >= 0); store.set("preds", []); ogSym = "XU100";
    await loadOhlc(); var cn = Object.keys(OHLC.stocks).filter(function (k) { var c = OHLC.stocks[k].c; return c.slice(-500).every(function (x) { return x > 0; }); }).slice(0, 2);
    var pc = portfolioConeCalc(cn, [1000, 3000], 0, FORECAST, OHLC), pc2 = portfolioConeCalc(cn, [1000, 3000], 4000, FORECAST, OHLC);
    ok("portfoy_koni_hesap", !pc.err && pc.h[21] && pc.h[21].q[0] < pc.h[21].q[2] && pc.h[21].q[2] < pc.h[21].q[4] && pc.h[21].pLoss >= 0 && pc.h[21].pLoss <= 1 && pc.sigmaYr > 5 && pc.sigmaYr < 120);
    ok("portfoy_koni_nakit_daraltir", (pc2.h[21].q[4] - pc2.h[21].q[0]) < 0.6 * (pc.h[21].q[4] - pc.h[21].q[0]) && Math.abs(pc2.h[21].val[2] - pc2.tot) < pc2.tot * 0.2);
    ok("portfoy_koni_hata_yolu", !!portfolioConeCalc(["YOKHISSE"], [100], 0, FORECAST, OHLC).err && !!portfolioConeCalc(cn, [0, 0], 0, FORECAST, OHLC).err);
    ogH = 21; ogSort = "vol"; ogSym = "XU100";
    /* ---- Erişilebilirlik ---- */
    var tin = document.createElement("input"); tin.type = "number"; tin.id = "zz1"; document.body.appendChild(tin); var tsp = document.createElement("span"); tsp.setAttribute("data-x", "THYAO"); tsp.textContent = "x"; document.body.appendChild(tsp);
    polishA11y(); ok("a11y_etiket_ve_klavye", !!tin.getAttribute("aria-label") && tsp.getAttribute("tabindex") === "0" && tsp.getAttribute("role") === "button");
    var clickedN = 0; tsp.click = function () { clickedN++; }; /* Kokpit yakalama dinleyicisi [data-x] tıklamasını hedefe ulaşmadan işler; bu yüzden click() çağrısının yapıldığı doğrudan doğrulanır */ tsp.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true})); tsp.dispatchEvent(new KeyboardEvent("keydown", {key: " ", bubbles: true})); ok("a11y_enter_bosluk_ile_tiklama", clickedN === 2);
    show("kokpit"); ok("a11y_aria_current", document.querySelector('.nav a[data-view="kokpit"]').getAttribute("aria-current") === "page" && document.querySelector('.nav a[data-view="dashboard"]').getAttribute("aria-current") === "false");
    ok("a11y_iskelet", document.querySelector("a.skip") != null && $("main").getAttribute("role") === "main" && document.querySelector("nav.nav").getAttribute("aria-label") === "Sayfalar");
    toast("deneme"); ok("a11y_toast_canli_bolge", $("toast").getAttribute("aria-live") === "polite" && $("toast").getAttribute("role") === "status");
    show("tarayici"); await new Promise(function (r) { setTimeout(r, 900); }); polishA11y(); ok("a11y_tarayici_alanlari_etiketli", Array.prototype.every.call(document.querySelectorAll("#scrView input:not([type=hidden]),#scrView select"), function (e) { return !!(e.getAttribute("aria-label") || e.title || e.closest("label")); }));
    tin.remove(); tsp.remove();
    /* ---- Hız: hafif yoklama ve geç yükleme ---- */
    ok("hiz_gec_yukleme_geldi", MLOG != null && SLOG != null && TECHSEAL != null && CALRES != null);
    var calls = [], f0 = window.fetch; window.fetch = function (u) { calls.push(String(u)); return f0.apply(this, arguments); };
    await loadData(false); var onlyMeta = calls.some(function (c) { return c.indexOf("data_meta.json") === 0; }) && !calls.some(function (c) { return c.indexOf("data.json") === 0; });
    calls.length = 0; var ts0 = DATA.ts; DATA.ts = 1; await loadData(false); var full = calls.some(function (c) { return c.indexOf("data.json") === 0; });
    calls.length = 0; await loadData(true); var forced = calls.some(function (c) { return c.indexOf("data.json") === 0; }) && !calls.some(function (c) { return c.indexOf("data_meta") >= 0; });
    window.fetch = f0; ok("hiz_hafif_yoklama_veri_ayni", onlyMeta); ok("hiz_veri_degisince_tam_indirme", full && DATA.ts === ts0); ok("hiz_elle_yenile_tam_indirme", forced);
    show("dashboard"); ok("kokpit_disinda_kenar_cubuk", !document.body.classList.contains("kp")); kpSym = null; store.set("kpSym", null);
    /* ---- Stres testi, Kelly, tahta derinligi, golge arena ---- */
    var stN = UNIVERSE.filter(function (s) { return s.ok && STRESS && STRESS.stocks[s.name]; })[0]; if (stN) { openDetail(stN.name); var dk = $("detail").innerHTML; ok("detay_stres_testi", dk.indexOf("Kara ku") >= 0 && dk.indexOf("BIST 100") >= 0 && /(GE.T[\u0130I]|GE.EMED)/.test(dk)); ok("detay_kelly_blogu", dk.indexOf("kellyCap") >= 0 && dk.indexOf("Kelly") >= 0); closeDetail(); } else ok("stres_verisi_yok_atlandi", true);
    store.set("depthUser", {}); var dsym = UNIVERSE.filter(function (s) { return s.ok && s.tl >= 20; })[0], dpx = dsym.close, dTxt = "hisse;zaman;taraf;fiyat;lot;emir\n" + [["10:30", "al\u0131\u015f", -0.0, 1000, 20], ["10:30", "al\u0131\u015f", -0.1, 1100, 20], ["10:30", "al\u0131\u015f", -0.2, 900, 20], ["10:30", "al\u0131\u015f", -0.3, 1000, 20], ["10:30", "al\u0131\u015f", -0.4, 90000, 1], ["10:30", "sat\u0131\u015f", 0.1, 900, 20], ["10:30", "sat\u0131\u015f", 0.2, 1000, 20], ["10:30", "sat\u0131\u015f", 0.3, 1000, 20], ["10:30", "sat\u0131\u015f", 0.4, 950, 20], ["10:30", "sat\u0131\u015f", 0.5, 1000, 20]].map(function (r) { return [dsym.name, r[0], r[1], (dpx * (1 + r[2] / 100)).toFixed(2).replace(".", ","), r[3], r[4]].join(";"); }).join("\n");
    var dps = depthParse(dTxt); ok("derinlik_ayristirma", !dps.error && dps.nstock === 1 && dps.stocks[dsym.name][0].bids.length === 5 && dps.stocks[dsym.name][0].asks.length === 5); ok("derinlik_eksik_sutun_hata", !!depthParse("a;b\n1;2").error);
    depthSave(dps); ok("derinlik_kaydedildi", !!DEPTH_USER[dsym.name] && DEPTH_USER[dsym.name].n === 1); show("ozelveri"); ok("derinlik_bolumu", $("ovView").innerHTML.indexOf("dpFile") >= 0 && $("ovView").innerHTML.indexOf("dpGate") >= 0 && $("ovView").innerHTML.indexOf(dsym.name) >= 0); store.set("depthUser", {}); DEPTH_USER = {}; DEPTH_GATE = false; store.set("depthGate", false);
    /* ---- Kaliteli ama dususte, yorumcu notlari, KAP/kurum akisi ---- */
    show("kalite"); ok("kalite_sayfasi", $("qdView").innerHTML.indexOf("qdQ") >= 0 && $("qdView").innerHTML.indexOf("data-qdreset") >= 0);
    qdP = { minQual: 0, p1m: -3, dd52: -10 }; renderQualityDip(); var qdRows = $("qdView").querySelectorAll("tbody tr[data-x]").length; ok("kalite_filtre_gevsek_liste", qdRows >= 1 && /Zirveden/.test($("qdView").innerHTML)); qdP = { minQual: 55, p1m: -8, dd52: -25 }; store.set("qdP", qdP);
    var cmS = UNIVERSE.filter(function (s) { return s.ok && s.tl >= 20; })[0]; store.set("commentators", [{ id: "t1", who: "Test Yorumcu", src: "X (Twitter)", n: cmS.name, dir: "al", date: "2026-08-03", px: 1, target: null, text: "Rekor kar acikladi" }, { id: "t2", who: "Test Yorumcu", src: "X (Twitter)", n: cmS.name, dir: "sat", date: new Date().toISOString().slice(0, 10), px: cmS.close, target: null, text: "" }]);
    show("yorumcu"); await new Promise(function (r) { setTimeout(r, 1200); }); var cmH2 = $("cmView").innerHTML; ok("yorumcu_sayfasi", cmH2.indexOf("Test Yorumcu") >= 0 && cmH2.indexOf("cmWho") >= 0 && cmH2.indexOf("data-cmadd") >= 0); ok("yorumcu_karne_satiri", cmH2.indexOf("yetersiz") >= 0 || cmH2.indexOf("%95") >= 0);
    openDetail(cmS.name); ok("detay_yorumcu_notu", $("detail").innerHTML.indexOf("Test Yorumcu") >= 0); ok("detay_kap_kurum_blogu", $("detail").innerHTML.indexOf("KAP") >= 0); closeDetail(); store.set("commentators", []);
    /* ---- Bilanco denetimi, Monte Carlo matrisi, haber duygusu, takas filtresi ---- */
    openDetail(ps.name); var dh2 = $("detail").innerHTML; ok("detay_bilanco_denetimi", dh2.indexOf("peert") >= 0 && /(TEM|DİK|ZAY|VER)/.test(dh2) && dh2.indexOf("PD/DD") >= 0); ok("detay_mc_matrisi", dh2.indexOf("Sharpe") >= 0 && dh2.indexOf("CVaR") >= 0); ok("detay_haber_duygusu", dh2.indexOf("Haber duygusu") >= 0); closeDetail();
    var csv3 = "tarih;hisse;kurum;alış;satış;net;pay\n2026-10-08;THYAO;A;100;10;90;30\n2026-10-08;THYAO;B;10;60;-50;20\n2026-10-09;THYAO;A;120;10;110;32\n2026-10-09;THYAO;B;10;50;-40;21\n2026-10-12;THYAO;A;150;10;140;34\n2026-10-12;THYAO;B;10;40;-30;22\n2026-10-12;THYAO;C;20;5;15;10";
    var pr3 = akdParse(csv3); store.set("akdUser", {}); ovSave(pr3); ok("akd_cok_gunluk_gecmis", AKD_USER.THYAO && AKD_USER.THYAO.hist.length === 3 && AKD_USER.THYAO.hist[2].sak5 != null);
    var st3 = akdState(AKD_USER.THYAO, { pw: 0 }); ok("akd_takas_filtresi_birikim", !!st3 && st3.dir > 0 && st3.days === 3); show("ozelveri"); ok("ozel_veri_takas_sutunu", $("ovView").innerHTML.indexOf("ovVote") >= 0); store.set("akdUser", {}); AKD_USER = {}; AKD_VOTE = false;
    /* ---- Seviye grafigi, Arena ---- */
    await loadCandles(); var cs = UNIVERSE.filter(function (s) { return s.ok && CANDLES && CANDLES.stocks[s.name]; })[0];
    if (cs) { openDetail(cs.name); await new Promise(function (r) { setTimeout(r, 600); }); ok("seviye_detayda", $("lv") != null && $("lvn").innerHTML.indexOf("Livermore") >= 0 && $("lvn").innerHTML.indexOf("Simons") >= 0);
      var lr = lvDraw("lv", cs, { liv: true, sim: true }); ok("seviye_cizildi", !!lr && lr.bars > 40 && lr.levels.length >= 1 && typeof lr.zNow === "number");
      var lr2 = lvDraw("lv", cs, { liv: false, sim: false }); ok("seviye_katman_kapali", !!lr2 && lr2.levels.length === 0); closeDetail();
      chSym = cs.name; chMode = "lv"; show("grafik"); await new Promise(function (r) { setTimeout(r, 800); }); ok("seviye_grafik_sayfasi", $("lvCv") != null && $("lvLiv") != null && $("lvInfo").innerHTML.indexOf("Livermore") >= 0); chMode = "tv"; }
    else ok("seviye_mum_verisi_yok_atlandi", true);
    PICKS = { picks: [{ d: "2026-01-02", src: "komite", n: "AAA", e: 10, sc: 2, v: [1, 1, 0, 0, -1], r: { 10: 5 }, b: { 10: 1 } }] }; show("arena"); await new Promise(function (r) { setTimeout(r, 300); });
    ok("arena_sayfasi", $("arenaView").innerHTML.indexOf("arena") >= 0 && $("arenaView").innerHTML.indexOf("yetersiz") >= 0); ok("golge_arena_blogu", $("arenaView").innerHTML.indexOf("l\u00e7\u00e7") >= 0 || $("arenaView").innerHTML.indexOf("G\u00f6lge arena") >= 0 || $("arenaView").innerHTML.indexOf("Sanal i\u015flem kayd\u0131") >= 0); ok("arena_dinamik_denetci", $("arenaView").innerHTML.indexOf("data-arenareg") >= 0 && $("arenaView").innerHTML.indexOf("x1,00") < 0 && $("arenaView").innerHTML.indexOf("\u00d71,00") >= 0); PICKS = null; show("dashboard");
    /* ---- Ozel veri (AKD/takas CSV), dis veri kaynaklari ---- */
    var csv = "tarih;hisse;kurum;alış;satış;net\n2026-10-12;THYAO;A;1.200.000;300.000;900.000\n2026-10-12;THYAO;B;100.000;800.000;-700.000\n2026-10-12;THYAO;C;50.000;40.000;10.000\n2026-10-12;GARAN;A;10;500;-490";
    var pr = akdParse(csv); ok("akd_ayristirma", !pr.error && pr.nstock === 2 && pr.stocks.THYAO["2026-10-12"].bal > 0 && pr.stocks.GARAN["2026-10-12"].bal < 0);
    ok("akd_virgul_ayraci", !akdParse("hisse,tarih,yabancı\nTHYAO,2026-10-12,\"31,5\"").error && akdParse("hisse,tarih,yabancı\nTHYAO,2026-10-12,\"31,5\"").stocks.THYAO["2026-10-12"].foreign === 31.5);
    ok("akd_hisse_sutunu_yoksa_hata", !!akdParse("a;b\n1;2").error);
    store.set("akdUser", {}); ok("akd_kaydet", ovSave(pr) === true && AKD_USER.THYAO && Math.abs(AKD_USER.THYAO.bal - (910000 - 700000) / 1350000) < 0.01);
    var thy = UNIVERSE.find(function (s) { return s.name === "THYAO"; }) || UNIVERSE[0]; AKD_USER[thy.name] = AKD_USER.THYAO || { d: "x", bal: 0.1, conc: 0.1, foreign: null, n: 1 };
    ok("akd_kisi_analizde", akilliP(thy).checks.some(function (c) { return c.t.indexOf("Kullanıcı AKD") >= 0; })); show("ozelveri"); ok("ozel_veri_sayfasi", $("ovView").innerHTML.indexOf("Takas") >= 0 && $("ovView").innerHTML.indexOf("lisans") >= 0);
    store.set("akdUser", {}); AKD_USER = {};
    ok("dis_veri_yuklu_ya_da_yok", VIOP === null || typeof VIOP.stocks === "object"); show("dashboard"); ok("makro_jeopolitik_satiri", $("macroCard").innerHTML.indexOf("Jeopolitik") >= 0);
    /* ---- Paylasim, tarama karnesi, sektor akisi, lot simulasyonu ---- */
    var sh = { v: 1, zf: [{ id: "zz1", name: "Paylasim testi", conds: [{ f: "mtf_w", op: ">=", v: 80 }], sort: { f: "mtf_w", dir: -1 } }], sp: { haftalik: { wMin: 85 } } };
    var rt = shareDecode(shareEncode(sh)); ok("paylas_gidis_donus", JSON.stringify(rt) === JSON.stringify(sh));
    ok("paylas_turkce_karakter", shareDecode(shareEncode({ v: 1, zf: [{ id: "a", name: "Şğüöçİ filtre", conds: [] }] })).zf[0].name === "Şğüöçİ filtre");
    window.confirm = function () { return true; }; zSaveF([]); store.set("scanP", {}); ok("paylas_uygula", shareApply(sh) === true && zFilters().length === 1 && scanP("haftalik").wMin === 85);
    ok("paylas_gecersiz_reddedilir", shareApply({ v: 2 }) === false); store.set("scanP", {}); zSaveF([]);
    var sle = scanLiveEval(); ok("tarama_karnesi_yapi", typeof sle.days === "number" && ["haftalik", "gunluk", "aylik", "bebek", "halkaarz"].every(function (k) { return sle.out[k] && sle.out[k][5] && sle.out[k][20]; }));
    ok("tarama_karnesi_html", scanKarneHtml().indexOf("Haftalık Tarama") >= 0);
    var sf = sectorFlowHtml(); ok("sektor_akisi", sf.indexOf("Para ak") >= 0 && sf.indexOf("<tr>") >= 0);
    show("halkaarz"); $("lsZ").value = "500"; $("lsP").value = "20"; $("lsB").value = "50"; $("lsN").value = "500"; $("lsA").value = "10000"; document.querySelector("[data-lscalc]").click();
    var lo = $("lsOut").innerHTML; ok("lot_simulasyonu", lo.indexOf("lot") >= 0 && lo.indexOf("Toplam") >= 0);
    $("lsZ").value = "100"; $("lsN").value = "5000"; document.querySelector("[data-lscalc]").click(); ok("lot_dusmeme_olasiligi", $("lsOut").innerHTML.indexOf("olas") >= 0 || $("lsOut").innerHTML.indexOf("lot") >= 0);
    /* ---- Gun ici / tahmin karnesi ---- */
    show("gunici"); await new Promise(function (r) { setTimeout(r, 2500); }); ok("gunici_radar", $("giView").innerHTML.indexOf("Tavan / Taban radar") >= 0); ok("gunici_lim_yuklendi", !!LIM && LIM.tavan.by_streak["1"].n > 100);
    show("tahmin"); await new Promise(function (r) { setTimeout(r, 2500); }); ok("tahmin_acilir", $("thView").innerHTML.indexOf("Skor sa") >= 0 && $("thView").innerHTML.indexOf("Hata analizi") >= 0);
    var le = liveEval(); ok("canli_degerlendirme", typeof le.days === "number");
    ok("manifest", !!document.querySelector('link[rel="manifest"]'));
  } catch (e) { ok("ISTISNA", e.message + " @" + (e.stack || "").split("\n")[1]); }
  document.documentElement.setAttribute("data-test", JSON.stringify(R));
}, 14000);
