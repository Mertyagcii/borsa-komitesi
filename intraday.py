"""Gün içi (15 dakikalık) çubuklar: sanal portföylerdeki pozisyon/emir hisseleri için bugünün çubuklarını çeker (intraday.json).
Motor (engine.js) varsa bunları kullanarak stop ve hedefin gün içinde HANGİSİNİN önce gerçekleştiğini kronolojik olarak yürütür;
yoksa günlük OHLC'ye döner. Yalnızca işlenecek yeni bir işlem günü varsa çalışır."""
import json
import sys
import time
from datetime import datetime
from pathlib import Path

from fetcher import TZ

HERE = Path(__file__).parent


def main(force: bool = False) -> None:
    hist = json.loads((HERE / "history.json").read_text(encoding="utf-8")) if (HERE / "history.json").exists() else {}
    date = (hist.get("index") or {}).get("last")
    pf = HERE / "portfolios.json"
    if not date or not pf.exists():
        print("history/portfolios yok; atlandı.")
        return
    st = json.loads(pf.read_text(encoding="utf-8"))
    now = datetime.now(TZ)
    if not force and (date <= (st.get("lastDate") or "") or (date == now.date().isoformat() and now.hour * 60 + now.minute < 18 * 60 + 15)):
        print("İşlenecek yeni işlem günü yok; atlandı.")
        return
    names = set()
    for p in st["p"].values():
        names |= {x["n"] for x in p["pos"]} | {o["n"] for o in p["orders"]}
    if not names:
        print("Pozisyon/emir yok; atlandı.")
        return
    from tvDatafeed import Interval, TvDatafeed
    tv = TvDatafeed()
    bars = {}
    for k, n in enumerate(sorted(names), 1):
        df = None
        for _ in range(2):
            try:
                df = tv.get_hist(n, "BIST", interval=Interval.in_15_minute, n_bars=80)
                if df is not None:
                    break
            except Exception:
                pass
            time.sleep(1)
        if df is None:
            continue
        day = df[[str(i)[:10] == date for i in df.index]]
        if len(day):
            bars[n] = [[round(float(r.open), 4), round(float(r.high), 4), round(float(r.low), 4), round(float(r.close), 4)] for r in day.itertuples()]
        if k % 10 == 0:
            tv = TvDatafeed()
    (HERE / "intraday.json").write_text(json.dumps({"date": date, "bars": bars}, separators=(",", ":")), encoding="utf-8")
    print(f"intraday.json: {len(bars)}/{len(names)} hisse, {date}")


if __name__ == "__main__":
    main("--force" in sys.argv)
