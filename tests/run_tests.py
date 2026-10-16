"""Otomatik test paketi (yerelde ve GitHub Actions'ta aynı komut):  python tests/run_tests.py [--site site] [--quick]
1) Statik: Python sözdizimi, Node sözdizimi, JSON dosyalarının geçerliliği
2) Çekirdek mantık (Node): tüm hisselerde komite/değerleme/ucuz-pahalı/çok zamanlı skor
3) Tarayıcı: tüm sayfalar JS hatasız açılıyor mu (başsız Chrome/Edge)
4) Tarayıcı işlevsel: filtreler, alarmlar, günlük, risk, takvim, uyarı merkezi, senaryo, rapor, karar kartı...
Çıkış kodu 0 = hepsi geçti. --quick: tarayıcı testlerini atlar."""
import argparse
import glob
import http.server
import json
import os
import ast
import re
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAGES = ["dashboard", "analiz", "tarama", "halkaarz", "grafik", "gunici", "gunluk", "risk", "takvim", "uyari", "senaryo", "aylik", "zaman", "tahmin", "adaylar", "tarayici", "ekranlar", "sektorler", "atolye",
         "arsiv", "arena", "kalite", "yorumcu", "portfoyler", "portfoyum", "hesabim", "rapor", "karsilastir", "haberler", "kutu", "karne", "arastirma", "geritest", "ayarlar", "yardim", "h=AHGAZ"]
fails, passes = [], 0


def check(name, ok, detail=""):
    global passes
    if ok:
        passes += 1
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name} {detail}")


def find_browser():
    for env in ("CHROME", "BROWSER"):
        if os.environ.get(env):
            return os.environ[env]
    for n in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "msedge"):
        p = shutil.which(n)
        if p:
            return p
    for p in (r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", r"C:\Program Files\Microsoft\Edge\Application\msedge.exe", r"C:\Program Files\Google\Chrome\Application\chrome.exe"):
        if os.path.exists(p):
            return p
    return None


def static_checks():
    print("1) Statik kontroller")
    bad = []
    for f in glob.glob(str(ROOT / "*.py")) + glob.glob(str(ROOT / "tests" / "*.py")):
        try:
            ast.parse(Path(f).read_text(encoding="utf-8-sig"), filename=f)
        except Exception as e:
            bad.append(f"{os.path.basename(f)}: {e}")
    check("python sözdizimi", not bad, "; ".join(bad))
    nodes = [f for f in glob.glob(str(ROOT / "*.js")) + glob.glob(str(ROOT / "tests" / "*.js"))]
    badn = [os.path.basename(f) for f in nodes if subprocess.run(["node", "--check", f], capture_output=True).returncode]
    check("node sözdizimi", not badn, ", ".join(badn))
    badj = []
    for f in glob.glob(str(ROOT / "*.json")) + glob.glob(str(ROOT / "site" / "*.json")) + [str(ROOT / "manifest.webmanifest")]:
        if os.path.basename(f) in ("scratch_cov.json", "scratch_fields.json", "scratch_keep.json", "scratch_mtf.json"):
            continue
        try:
            json.loads(Path(f).read_text(encoding="utf-8-sig"))
        except Exception as e:
            badj.append(os.path.basename(f))
    check("json geçerli", not badj, ", ".join(badj))


def core_test(site):
    print("2) Çekirdek mantık")
    r = subprocess.run(["node", str(ROOT / "tests" / "core_test.js"), site], capture_output=True, text=True, encoding="utf-8")
    try:
        o = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        check("çekirdek test çalıştı", False, (r.stdout + r.stderr)[-400:]); return
    check("çekirdek mantık hatasız", r.returncode == 0, json.dumps(o.get("errs"), ensure_ascii=False)[:400])
    print(f"       {o['stat']['committee']} hisse komite, {o['stat']['val']} değerleme, {o['stat']['cheap']} ucuz/pahalı; medyan adil değer farkı %{o['medianUpside']:.1f}; kurulumlar {o['tiers']}")


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def run_chrome(browser, url, budget=30000, timeout=120):
    prof = tempfile.mkdtemp(prefix="bk_prof_")
    args = [browser, "--headless", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", f"--user-data-dir={prof}", "--window-size=1400,1000", f"--virtual-time-budget={budget}", "--dump-dom", url]
    try:
        r = subprocess.run(args, capture_output=True, timeout=timeout)
        return r.stdout.decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        return ""
    finally:
        shutil.rmtree(prof, ignore_errors=True)


def attr(dom, name):
    m = re.search(name + r'="([^"]*)"', dom) or re.search(name + r"='([^']*)'", dom)
    if not m:
        return ""
    return m.group(1).replace("&quot;", '"').replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&#39;", "'")


def browser_tests(site):
    print("3) Tarayıcı: sayfalar")
    browser = find_browser()
    if not browser:
        check("tarayıcı bulundu", False, "Chrome/Edge yok (CHROME ortam değişkeni verin)"); return
    site_dir = Path(site)
    html = (site_dir / "index.html").read_text(encoding="utf-8")
    hook = '<script>window.onerror=function(m,u,l){document.documentElement.setAttribute("data-err",m+" @"+l)};window.addEventListener("unhandledrejection",function(e){document.documentElement.setAttribute("data-err","promise:"+(e.reason&&e.reason.message))});try{localStorage.setItem("tourDone","1")}catch(e){}</script>'
    (site_dir / "t_sweep.html").write_text(html.replace("<head>", "<head>" + hook, 1), encoding="utf-8")
    func = (ROOT / "tests" / "inject_func.js").read_text(encoding="utf-8")
    (site_dir / "t_func.html").write_text(html.replace("<head>", "<head><script>" + func + "</script>", 1), encoding="utf-8")
    os.chdir(site_dir)
    srv = socketserver.TCPServer(("0.0.0.0", 0), Quiet); srv.allow_reuse_address = True
    port = srv.server_address[1]; threading.Thread(target=srv.serve_forever, daemon=True).start()
    host = socket.gethostname()  # localhost yerine ana makine adı: uygulama "yerel sunucu" kipine geçmesin
    try:
        for pg in PAGES:
            dom = run_chrome(browser, f"http://{host}:{port}/t_sweep.html#{pg}")
            err = attr(dom, "data-err"); name = pg.split("=")[0]; name = "dashboard" if name == "h" else name
            m = re.search(r'id="v-' + name + r'"[^>]*>(.*?)<div class="view[ "]', dom, re.S)
            n = len(re.sub(r"<[^>]+>", "", m.group(1)).strip()) if m else -1
            check(f"sayfa {pg}", bool(dom) and not err and n != 0, f"hata={err} metin={n}")
        print("4) Tarayıcı: işlevsel testler")
        dom = run_chrome(browser, f"http://{host}:{port}/t_func.html", budget=120000, timeout=300)
        err = attr(dom, "data-err")
        if err:
            check("işlevsel test sayfa hatası", False, err)
        raw = attr(dom, "data-test")
        if not raw:
            check("işlevsel test sonucu", False, f"sonuç yok (dom {len(dom)} bayt; ...{dom[-300:]!r})"); return
        res = json.loads(raw)
        for k, v in res.items():
            check(f"işlev {k}", v is True, str(v))
    finally:
        srv.shutdown()
        os.chdir(ROOT)
        for f in ("t_sweep.html", "t_func.html"):
            try:
                (site_dir / f).unlink()
            except OSError:
                pass


def script_tests(site):
    print("2b) Betikler: alarms.js ve archive.js")
    site = str(Path(site).resolve())
    tmp = Path(tempfile.mkdtemp(prefix="bk_scr_"))
    try:
        r = subprocess.run(["node", str(ROOT / "archive.js"), "--site", site, "--out", str(tmp / "Arsiv"), "--force", "--nopublish"], capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))
        md = sorted((tmp / "Arsiv").glob("2*.md"))
        ok = r.returncode == 0 and len(md) == 1 and (tmp / "Arsiv" / "index.json").exists() and len(list((tmp / "Arsiv").glob("2*.json"))) == 1
        check("arşiv betiği dosya üretti", ok, (r.stdout + r.stderr)[-300:])
        if md:
            txt = md[0].read_text(encoding="utf-8")
            check("arşiv raporu içeriği", "Baş Denetçi" in txt and "Hata Avcısı" in txt and "Monte Carlo" in txt and "Masa tartışması" in txt, "bölüm eksik")
            idx = json.loads((tmp / "Arsiv" / "index.json").read_text(encoding="utf-8"))
            check("arşiv dizini", len(idx["days"]) == 1 and idx["days"][0]["file"].endswith(".md"), str(idx)[:200])
        # aynı gün ikinci çalışma (zorlamasız, seans içi/dışı fark etmez) indeksi bozmamalı
        r2 = subprocess.run(["node", str(ROOT / "archive.js"), "--site", site, "--out", str(tmp / "Arsiv"), "--nopublish"], capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))
        idx2 = json.loads((tmp / "Arsiv" / "index.json").read_text(encoding="utf-8"))
        check("arşiv tekrar çalışınca çoğalmıyor", r2.returncode == 0 and len(idx2["days"]) == 1, (r2.stdout + r2.stderr)[-200:])
        a = subprocess.run(["node", str(ROOT / "alarms.js"), "--site", site, "--state", str(tmp / "st.json"), "--log", str(tmp / "log.json"), "--force", "--nopublish"], capture_output=True, text=True, encoding="utf-8", cwd=str(tmp))
        check("alarm betiği çalıştı", a.returncode == 0 and (tmp / "st.json").exists() and (tmp / "log.json").exists(), (a.stdout + a.stderr)[-300:])
        st1 = json.loads((tmp / "st.json").read_text(encoding="utf-8"))
        a2 = subprocess.run(["node", str(ROOT / "alarms.js"), "--site", site, "--state", str(tmp / "st.json"), "--log", str(tmp / "log.json"), "--force", "--nopublish"], capture_output=True, text=True, encoding="utf-8", cwd=str(tmp))
        lg = json.loads((tmp / "log.json").read_text(encoding="utf-8"))
        ids = [(x["d"], x["id"]) for x in lg["alarms"]]
        check("alarm tekrarı yok (aynı alarm bir kez)", a2.returncode == 0 and len(ids) == len(set(ids)), "yinelenen kayıt")
        check("alarm durum dosyası", "sent" in st1 and "date" in st1, str(st1)[:100])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def engine_tests(site):
    print("2d) Sanal işlem motoru: gölge arena (100.000 TL)")
    tmp = Path(tempfile.mkdtemp(prefix="bk_eng_")); st = tmp / "state.json"
    try:
        r = subprocess.run(["node", str(ROOT / "engine.js"), "--site", site, "--state", str(st), "--nopublish", "--force", "--reset"], capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))
        ok = r.returncode == 0 and st.exists()
        check("sanal işlem motoru çalıştı", ok, (r.stdout + r.stderr)[-400:])
        if ok:
            o = json.loads(st.read_text(encoding="utf-8")); p = o["p"]
            check("gölge ajanlar var", all(k in p for k in ("akilli", "vol", "kelly")), str(list(p)))
            check("gölge sermaye 100.000 TL", all(p[k]["cap"] == 100000 and abs(p[k]["nav"][0]["v"] - 100000) < 1 for k in ("akilli", "vol", "kelly")), str({k: (p[k].get("cap"), p[k]["nav"][:1]) for k in ("akilli", "vol", "kelly")}))
            check("eski portföyler 1.000.000 TL", all(abs(p[k]["nav"][0]["v"] - 1000000) < 1 for k in ("buffett", "simons", "livermore", "kellogg", "komite", "zaman")), "")
            check("emirler tutarlı (bütçeyi aşmıyor)", all(sum(x["amount"] for x in p[k]["orders"] if x["side"] == "buy") <= p[k]["cash"] + 1 for k in p), "")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def notify_tests():
    print("2c) Bildirim: notify.js")
    tmp = Path(tempfile.mkdtemp(prefix="bk_ntf_"))
    try:
        env = {k: v for k, v in os.environ.items() if k not in ("TG_TOKEN", "TG_CHAT", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "ALARM_WEBHOOK_URL")}
        long = tmp / "long.txt"; long.write_text("\n".join(f"• satır {i} <b>&</b> " + "x" * 80 for i in range(120)), encoding="utf-8")
        r = subprocess.run(["node", str(ROOT / "notify.js"), "--dry", str(long)], capture_output=True, text=True, encoding="utf-8", env=env, cwd=str(tmp))
        m = re.search(r"(\d+) parça", r.stdout)
        check("bildirim uzun mesajı parçalıyor", r.returncode == 0 and m is not None and int(m.group(1)) >= 3, r.stdout[-200:] + r.stderr[-200:])
        short = tmp / "short.txt"; short.write_text("🚨 deneme", encoding="utf-8")
        r = subprocess.run(["node", str(ROOT / "notify.js"), str(short)], capture_output=True, text=True, encoding="utf-8", env=env, cwd=str(tmp))
        check("bildirim sır yokken sessizce atlıyor", r.returncode == 0 and "yapılandırılmamış" in r.stdout, r.stdout[-200:] + r.stderr[-200:])
        r = subprocess.run(["node", str(ROOT / "notify.js"), str(tmp / "yok.txt")], capture_output=True, text=True, encoding="utf-8", env=env, cwd=str(tmp))
        check("bildirim dosya yokken hata vermiyor", r.returncode == 0, r.stdout[-200:] + r.stderr[-200:])
        js = "const n=require(%r);const c=n.chunks('a\\n'.repeat(5000),3800);console.log(JSON.stringify({ok:c.every(x=>x.length<=3800),n:c.length,e:n.esc('<a&b>')}))" % str(ROOT / "notify.js").replace("\\", "/")
        r = subprocess.run(["node", "-e", js], capture_output=True, text=True, encoding="utf-8")
        o = json.loads(r.stdout.strip().splitlines()[-1]) if r.returncode == 0 and r.stdout.strip() else {}
        check("bildirim parça sınırı ve kaçış", o.get("ok") is True and o.get("n", 0) >= 2 and o.get("e") == "&lt;a&amp;b&gt;", r.stdout[-200:] + r.stderr[-200:])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default=str(ROOT / "site"))
    ap.add_argument("--quick", action="store_true")
    a = ap.parse_args()
    static_checks()
    if not (Path(a.site) / "data.json").exists():
        print("site/data.json yok: önce `python build_site.py` çalıştırın."); sys.exit(2)
    core_test(a.site)
    script_tests(a.site)
    notify_tests()
    engine_tests(a.site)
    if not a.quick:
        browser_tests(a.site)
    print(f"\nSONUÇ: {passes} geçti, {len(fails)} başarısız" + (": " + ", ".join(fails) if fails else ""))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
