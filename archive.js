#!/usr/bin/env node
/* Otomatik Denetim ve Yatırım Notu Arşivcisi: seans kapanışından sonra (hafta içi 18:45 TR) günde bir kez
   Arsiv/YYYY-MM-DD.md (okunur rapor) + Arsiv/YYYY-MM-DD.json (geri test için makine okunur kayıt) + Arsiv/index.json üretir.
   İçerik: konsey tartışması, efsane oyları, Monte Carlo, Baş Denetçi mührü, Hata Avcısı mührü, gün içi alarmlar, geri test skor kartı, sanal portföyler.
   Kullanım: node archive.js [--site site] [--out Arsiv] [--date YYYY-MM-DD] [--force] */
const fs = require("fs"), path = require("path");
const {load, istanbul} = require("./corectx");
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };
const SITE = opt("site", "site"), OUT = opt("out", "Arsiv"), FORCE = args.includes("--force"), NOPUB = args.includes("--nopublish");
const now = istanbul(), date = opt("date", now.date);
const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
const afterClose = !["Sat", "Sun"].includes(now.wd) && now.min >= 18 * 60 + 45;
fs.mkdirSync(OUT, {recursive: true});
const idxFile = path.join(OUT, "index.json"), index = rj(idxFile, {days: []});
const publish = () => { if (NOPUB) return; try { const d = path.join(SITE, "Arsiv"); fs.mkdirSync(d, {recursive: true}); for (const f of fs.readdirSync(OUT)) if (/\.(md|json)$/.test(f)) fs.copyFileSync(path.join(OUT, f), path.join(d, f)); } catch (e) { /* site yoksa atla */ } };

if (!FORCE && (!afterClose || index.days.some(x => x.d === date))) {
  console.log(!afterClose ? "Seans kapanışı değil; arşiv atlandı." : `${date} arşivi zaten var.`); publish(); process.exit(0);
}
const C = load(SITE);
if (!C) { console.log("data.json yok; arşiv atlandı."); process.exit(0); }

const day = C.run(`archiveDay(${JSON.stringify(date)}, __a.data.ts)`);
if (!day.stocks.length) { console.log("Aday yok; arşiv atlandı."); process.exit(0); }

/* gün içi alarmlar */
const alog = rj("alarm_log.json", {alarms: []}).alarms.filter(a => a.d === date);

/* geri test skor kartı: arşivdeki (picks.json) komite kararlarının 5/10/20 iş günü sonraki, piyasa ortalamasına göre fazla getirisi */
const picks = (rj("picks.json", {picks: []}).picks || []).filter(p => p.src === "komite" && p.r);
const groups = [["Güçlü aday (skor ≥ 3)", p => p.sc >= 3], ["Aday (skor 2)", p => p.sc === 2], ["İzle (skor 1)", p => p.sc === 1], ["Nötr/olumsuz (skor ≤ 0)", p => p.sc <= 0]];
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const rows = groups.map(([lab, f]) => {
  const cells = [5, 10, 20].map(h => { const a = picks.filter(p => f(p) && p.r[h] != null && p.b && p.b[h] != null).map(p => p.r[h] - p.b[h]); return a.length ? `${mean(a) > 0 ? "+" : ""}${mean(a).toFixed(2)}% (n ${a.length}, isabet %${Math.round(a.filter(x => x > 0).length / a.length * 100)})` : "henüz ölçülemedi"; });
  return `| ${lab} | ${cells.join(" | ")} |`;
});
const scorecard = picks.length ? "Fazla getiri = hissenin getirisi − likit hisselerin ortalaması. Örnek sayısı küçükse (n < 30) sonuç kanıt değil, ipucudur.\n\n| Karar grubu | 5 iş günü | 10 iş günü | 20 iş günü |\n|---|---|---|---|\n" + rows.join("\n")
  : "Henüz sonucu ölçülmüş karar yok (kararların 5/10/20 iş günü geçmesi gerekir); kayıtlar bu arşivde birikiyor.";

/* sanal portföyler */
const pf = rj("portfolios.json", null); let portfolios = "";
if (pf && pf.p) {
  const cap = (pf.config && pf.config.capital) || 1e6, b = pf.bench || [], bx = b.length > 1 ? (b[b.length - 1].xu / b[0].xu - 1) * 100 : null;
  portfolios = "| Portföy | Değer (TL) | Getiri | Açık pozisyon |\n|---|---:|---:|---:|\n" + Object.entries(pf.p).map(([k, v]) => { const last = (v.nav || []).slice(-1)[0], val = last ? last.v : cap; return `| ${k} | ${Math.round(val).toLocaleString("tr-TR")} | ${((val / cap - 1) * 100).toFixed(2)}% | ${(v.pos || []).length} |`; }).join("\n")
    + (bx != null ? `\n\nKıyas: BIST 100 başlangıçtan beri ${bx.toFixed(2)}%.` : "");
}

const md = C.run(`archiveMd(${JSON.stringify(day)}, ${JSON.stringify({alarms: alog, scorecard, portfolios})})`);
fs.writeFileSync(path.join(OUT, date + ".md"), md, "utf8");
fs.writeFileSync(path.join(OUT, date + ".json"), JSON.stringify({d: date, regime: day.regime, audit: day.audit, issues: day.issues, locks: day.locks,
  stocks: day.stocks.map(s => ({n: s.n, e: s.close, sc: s.score, label: s.label, veto: s.veto, net2: s.net2, votes: s.votes, probStop: s.mc ? Math.round(s.mc.probStop) : null, locked: s.fact.locked}))}), "utf8");
index.days = index.days.filter(x => x.d !== date);
index.days.push({d: date, file: date + ".md", regime: day.regime, audit: day.audit, n: day.stocks.length, strong: day.stocks.filter(s => s.score >= 3 && !s.fact.locked).map(s => s.n), locked: day.locks, alarms: alog.length});
index.days.sort((a, b) => a.d < b.d ? -1 : 1); index.updated = date;
fs.writeFileSync(idxFile, JSON.stringify(index), "utf8");
publish();
console.log(`${date}: arşiv yazıldı (${day.stocks.length} hisse, mühür ${day.audit}, kilitli ${day.locks.length}, alarm ${alog.length}, skor kartı ${picks.length} karar)`);
