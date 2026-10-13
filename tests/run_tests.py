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
         "portfoyler", "portfoyum", "hesabim", "rapor", "karsilastir", "haberler", "kutu", "karne", "arastirma", "geritest", "ayarlar", "yardim", "h=AHGAZ"]
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default=str(ROOT / "site"))
    ap.add_argument("--quick", action="store_true")
    a = ap.parse_args()
    static_checks()
    if not (Path(a.site) / "data.json").exists():
        print("site/data.json yok: önce `python build_site.py` çalıştırın."); sys.exit(2)
    core_test(a.site)
    if not a.quick:
        browser_tests(a.site)
    print(f"\nSONUÇ: {passes} geçti, {len(fails)} başarısız" + (": " + ", ".join(fails) if fails else ""))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
