"""5分足の保存: 東証の全銘柄（プライム・スタンダード・グロース）の 9:00〜10:30 の5分足を毎日保存する。

Yahoo Financeの5分足は過去60日分しか取れないので、紙トレード検証のために毎日貯めておく。
完全無料（AIなし）。平日16:40 JSTに動く。

保存先: data/bars5m/YYYYMMDD.csv.gz（列: code, time, open, high, low, close, volume）
銘柄一覧: JPXの「東証上場銘柄一覧」（毎月更新）を state/universe.csv にキャッシュ
"""

from __future__ import annotations

import datetime as dt
import gzip
import io
import os
import time
from pathlib import Path

import requests

JST = dt.timezone(dt.timedelta(hours=9))
ROOT = Path(__file__).parent
OUT = ROOT / "data" / "bars5m"
UNIVERSE = ROOT / "state" / "universe.csv"
JPX_LIST = "https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls"
DRY_RUN = os.environ.get("DRY_RUN") == "1"
LIMIT = int(os.environ.get("LIMIT") or "0")   # テスト用に銘柄数を絞る
TARGET = os.environ.get("TARGET_DATE") or ""  # YYYYMMDD（空なら直近の取引日）
PERIOD = os.environ.get("PERIOD") or "5d"     # 初回は 59d で取れるだけ過去分を保存
CHUNK = 150
END = dt.time(10, 30)


def load_universe() -> list[str]:
    """JPXの一覧から内国株（プライム・スタンダード・グロース）の4桁コードを取る。月1回だけ取り直す。"""
    if UNIVERSE.exists():
        age = time.time() - UNIVERSE.stat().st_mtime
        lines = UNIVERSE.read_text(encoding="utf-8").split()
        if age < 28 * 86400 and len(lines) > 1000:
            return lines[1:]
    import pandas as pd
    r = requests.get(JPX_LIST, timeout=60, headers={"User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    df = pd.read_excel(io.BytesIO(r.content), dtype=str)
    seg = df["市場・商品区分"].fillna("")
    keep = df[seg.str.contains("内国株式")]
    codes = sorted({c.strip() for c in keep["コード"] if c and len(c.strip()) == 4})
    UNIVERSE.parent.mkdir(exist_ok=True)
    UNIVERSE.write_text("code\n" + "\n".join(codes) + "\n", encoding="utf-8")
    print(f"銘柄一覧を更新: {len(codes)}銘柄")
    return codes


def fetch(codes: list[str], day: dt.date | None):
    import pandas as pd
    import yfinance as yf
    frames = []
    for n in range(0, len(codes), CHUNK):
        part = [f"{c}.T" for c in codes[n:n + CHUNK]]
        for attempt in range(3):
            try:
                kw = {"period": PERIOD} if day is None else \
                     {"start": day, "end": day + dt.timedelta(days=1)}
                df = yf.download(part, interval="5m", progress=False, auto_adjust=False,
                                 group_by="ticker", threads=True, **kw)
                break
            except Exception as e:  # noqa: BLE001
                print(f"取得失敗（{attempt + 1}回目）: {e}")
                time.sleep(10)
        else:
            continue
        if df.empty:
            continue
        df.index = df.index.tz_convert(JST) if df.index.tz else df.index.tz_localize(JST)
        for t in part:
            if t not in df.columns.get_level_values(0):
                continue
            one = df[t].dropna(subset=["Open"])
            one = one[one["Volume"] > 0]
            if one.empty:
                continue
            one = one.assign(code=t[:-2])
            frames.append(one)
        print(f"{min(n + CHUNK, len(codes))}/{len(codes)} 銘柄")
        time.sleep(2)
    if not frames:
        return None
    return pd.concat(frames)


def main() -> None:
    codes = load_universe()
    if LIMIT:
        codes = codes[:LIMIT]
    day = dt.datetime.strptime(TARGET, "%Y%m%d").date() if TARGET else None
    bars = fetch(codes, day)
    if bars is None:
        raise SystemExit("5分足が1本も取れませんでした")
    dates = sorted({d for d in bars.index.date})
    OUT.mkdir(parents=True, exist_ok=True)
    for d in ([day] if day else dates):
        b = bars[(bars.index.date == d) & (bars.index.time < END)]
        if b.empty:
            continue
        path = OUT / f"{d:%Y%m%d}.csv.gz"
        if path.exists() and not TARGET:
            continue  # 保存済みの日は上書きしない
        out = b.reset_index().rename(columns={b.index.name or "index": "dt"})
        out["time"] = out["dt"].dt.strftime("%H:%M")
        out = out[["code", "time", "Open", "High", "Low", "Close", "Volume"]]
        out.columns = ["code", "time", "open", "high", "low", "close", "volume"]
        out = out.sort_values(["code", "time"])
        print(f"{d}: {out['code'].nunique()}銘柄 {len(out)}本")
        if DRY_RUN:
            print(out.head(15).to_string(index=False))
            continue
        with gzip.open(path, "wt", encoding="utf-8", newline="") as f:
            out.to_csv(f, index=False, float_format="%.6g")
        print(f"保存: {path.relative_to(ROOT)}（{path.stat().st_size // 1024}KB）")


if __name__ == "__main__":
    main()
