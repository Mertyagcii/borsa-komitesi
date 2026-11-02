"""Zincir (kendi kendini süren veri döngüsü) testi: bekleme süresi hesabı ve iş akışı dosyalarının tutarlılığı. run_tests.py çağırır."""
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import zincir as Z

ok = True


def chk(name, cond):
    global ok
    ok &= bool(cond)
    print(("OK   " if cond else "HATA ") + name)


def w(s):
    return Z.wait_seconds(datetime.fromisoformat(s))


# 2026-11-02 pazartesi, 2026-11-06 cuma, 2026-11-07 cumartesi
chk("pazartesi 06:00 -> durur", w("2026-11-02T06:00:00+03:00") == 0)
chk("pazartesi 06:30 -> 1800 (seans öncesi)", w("2026-11-02T06:30:00+03:00") == 1800)
chk("pazartesi 09:29 -> 1800", w("2026-11-02T09:29:00+03:00") == 1800)
chk("pazartesi 09:30 -> 540 (seans)", w("2026-11-02T09:30:00+03:00") == 540)
chk("cuma 17:00 -> 540", w("2026-11-06T17:00:00+03:00") == 540)
chk("pazartesi 18:29 -> 540", w("2026-11-02T18:29:00+03:00") == 540)
chk("pazartesi 18:30 -> 1200 (kapanış sonrası kayıtlar)", w("2026-11-02T18:30:00+03:00") == 1200)
chk("pazartesi 21:59 -> 1200", w("2026-11-02T21:59:00+03:00") == 1200)
chk("pazartesi 22:00 -> durur", w("2026-11-02T22:00:00+03:00") == 0)
chk("cumartesi 12:00 -> durur", w("2026-11-07T12:00:00+03:00") == 0)
chk("UTC verilince TR'ye çevrilir (07:00 UTC = 10:00 TR -> 540)", w("2026-11-02T07:00:00+00:00") == 540)
chk("kapanış sonrası ilk kayıt penceresi (18:45 TR) zincirde", w("2026-11-02T18:45:00+03:00") > 0)

pages = (ROOT / ".github/workflows/pages.yml").read_text(encoding="utf-8")
zin = (ROOT / ".github/workflows/zincir.yml").read_text(encoding="utf-8")
chk("pages.yml actions: write izni var (zincir tetiklemek için)", "actions: write" in pages)
chk("pages.yml zinciri son adımda tetikler (iptal edilmedikçe)", "python zincir.py" in pages and "gh workflow run zincir.yml" in pages and "!cancelled()" in pages)
chk("zincir adımı en sonda (deploy'dan sonra)", pages.index("python zincir.py") > pages.index("actions/deploy-pages"))
chk("zincir.yml pages.yml'yi tetikler, secret/anahtar kullanmaz", "gh workflow run pages.yml" in zin and "secrets." not in zin and "GITHUB_TOKEN" not in zin.replace("GITHUB_TOKEN ile", ""))
chk("zincir.yml tek zincir (concurrency iptal) ve sayısal giriş doğrulaması", "cancel-in-progress: true" in zin and "*[!0-9]*" in zin)
chk("pages.yml sabah başlatma cron'ları var", "42 3,4,5,6 * * 1-5" in pages)
res = (ROOT / ".github/workflows/research.yml").read_text(encoding="utf-8")
chk("pages.yml ve research.yml çalışma başında en güncel main'i çeker (kuyruktaki çalışma bayat SHA ile başlayıp çakışmasın)", "ref: main" in pages and "ref: main" in res)
bil = (ROOT / ".github/scripts/bildir.sh").read_text(encoding="utf-8")
bt = (ROOT / ".github/workflows/bildirim-testi.yml").read_text(encoding="utf-8")
chk("bildirim: pages.yml issues: write izni ve continue-on-error (yayını engellemez)", "issues: write" in pages and "bildir.sh" in pages and pages[pages.index("bildir.sh") - 400:pages.index("bildir.sh")].count("continue-on-error: true") >= 1)
chk("bildirim: betik anahtarsız (GITHUB_TOKEN), sahibi anar, alarms.txt ve alerts.txt gönderir, her zaman 0 ile çıkar", "GH_TOKEN" in bil and "@${OWNER}" in bil and "alarms.txt" in bil and "alerts.txt" in bil and bil.rstrip().endswith("exit 0") and "secrets." not in bil)
chk("bildirim: bildirim-testi.yml yalnız elle (workflow_dispatch) ve betiği çağırır", "workflow_dispatch" in bt and "schedule" not in bt and "push:" not in bt and "bildir.sh" in bt)
chk("bildirim: betik LF satır sonlu (Linux çalıştırıcıda bozulmaz)", b"\r\n" not in (ROOT / ".github/scripts/bildir.sh").read_bytes())
print("SONUC", "TAMAM" if ok else "HATA VAR")
sys.exit(0 if ok else 1)
