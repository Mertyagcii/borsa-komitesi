/* İşlevsel testler (tarayıcı içinde çalışır; sonuç <html data-test="{...}"> özniteliğine yazılır).
   Yalnızca ASCII alt dizgeler aranır (kodlama bağımsız). run_tests.py bu dosyayı sayfaya enjekte eder. */
window.onerror = function (m, u, l) { document.documentElement.setAttribute("data-err", m + " @" + l); };
try { localStorage.clear(); localStorage.setItem("tourDone", "true"); } catch (e) {}
setTimeout(async function () {
  var R = {}, ok = function (k, v) { R[k] = v; };
  try {
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
    var allCh = UNIVERSE.filter(function (s) { return s.ok && s.tl >= 10; }).map(cheapness).filter(Boolean); ok("cheapness_yeterli_kapsam", allCh.length > 100);
    ok("cheapness_tutarli", allCh.every(function (c) { return c.lab === "UCUZ" ? c.disc >= 15 : c.lab === "PAHALI" ? c.prem >= 15 : Math.abs(c.disc) < 15 || Math.abs(c.prem) < 15; }));
    var sim = similarStocks(lead, 6); ok("benzer_hisse_sayisi", sim.top.length === 6 && sim.top.every(function (o) { return o.s.name !== lead.name; }));
    /* ---- Degerleme ---- */
    var ve = UNIVERSE.filter(function (s) { return s.eps > 0 && s.bvps > 0 && s.tl > 20; })[0]; openAnalysis(ve.name); ok("deger_aciklama", document.body.innerHTML.indexOf("hesaplan") >= 0);
    var sv = valSens(ve); ok("duyarlilik_3x3", sv && sv.rows.length === 3 && sv.rows[0][0] < sv.rows[2][2]); var iv = intrinsic(ve); ok("carpan_aralik", iv.mult >= 3 && iv.mult <= 20);
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
