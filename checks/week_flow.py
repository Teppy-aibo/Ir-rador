"""週の中の流れ（型12〜14）を日足6年分で検証する。GitHub Actions の「heavy-check」から手動で動かす。

Apps Script の検証エンジン（E056〜E064）と同じ条件を、Apps Script の6分制限なしで
大型108銘柄やプライム全体にも広げて測る。結果は Actions の画面（Summary）と成果物（CSV）に出す。コミットはしない。

条件（すべて「前夜のSOXが75日線の上＝半導体がリスクオンの局面」に限る。比較用に局面なしも出す）
  型13  金曜: 月〜木で+3%以上の週は寄り→引けを売り / -3%以下の週は買い
  型12  月曜の寄りで買い→木曜の引け と 金曜の引け の比較
        基準: リスクオン中にどの曜日の寄りで買っても4日目の引けまで持つ（月曜だけが特別かを見る）
  型14  火曜・水曜に-3%以上下げた翌朝に買い→金曜の引け / 今週-3%以上の日があった週の金曜の寄り→引け
成績: 1回ごとの損益%（往復コスト0.1%込み）。同じ日に何銘柄も出たら日ごとに平均して1回と数え、t値と前半(〜2023)/後半(2024〜)を出す。
"""

from __future__ import annotations

import argparse
import io
import math
import os
import time
from pathlib import Path

import numpy as np
import pandas as pd

COST = 0.1
SPLIT = pd.Timestamp("2024-01-01")
OUT = Path(os.environ.get("OUT_DIR", "out"))

UNIV = {
    "AI半導体": ["6857", "8035", "6920", "6146", "4062", "285A", "5801", "5803"],
    "大型108": [
    "7203", "6758", "9984", "8306", "8316", "8411", "6861", "8035", "6857", "6146", "4063", "6098",
    "9432", "9433", "9434", "7974", "8058", "8031", "8001", "8053", "8002", "7011", "7012", "7013",
    "6501", "6503", "6702", "6752", "6954", "6981", "6762", "6971", "6594", "6367", "6273", "6301",
    "6326", "7267", "7269", "7270", "6902", "5108", "4502", "4503", "4568", "4519", "4523", "4578",
    "4452", "4911", "2914", "2502", "2802", "3382", "9983", "8267", "4661", "9020", "9022", "9101",
    "9104", "9107", "5401", "5411", "5713", "5802", "5803", "5801", "4062", "6920", "7735", "6723",
    "6526", "3436", "4004", "4005", "4188", "3407", "4901", "7751", "7741", "4543", "7733", "8766",
    "8725", "8630", "8591", "8604", "8601", "8801", "8802", "8830", "1925", "1928", "1801", "1802",
    "1803", "1812", "5020", "1605", "9501", "9503", "4689", "4755", "2413", "6201", "7832", "9766",
    ],
}
JPX_LIST = "https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j"  # 2026/11時点は .xlsx（以前は .xls）


def prime_codes() -> list[str]:
    import requests
    for ext in (".xlsx", ".xls"):
        r = requests.get(JPX_LIST + ext, timeout=60, headers={"User-Agent": "Mozilla/5.0"})
        if r.ok:
            break
    r.raise_for_status()
    df = pd.read_excel(io.BytesIO(r.content), dtype=str)
    keep = df[df["市場・商品区分"].fillna("").str.contains("プライム")]
    return sorted({c.strip() for c in keep["コード"] if c and len(c.strip()) == 4})


def download(symbols: list[str], period: str = "6y") -> dict[str, pd.DataFrame]:
    """Yahoo の日足。{記号: DataFrame(open,high,low,close,volume) 日付の昇順}"""
    import yfinance as yf
    out: dict[str, pd.DataFrame] = {}
    for n in range(0, len(symbols), 100):
        part = symbols[n:n + 100]
        for attempt in range(3):
            try:
                df = yf.download(part, period=period, interval="1d", progress=False, auto_adjust=False,
                                 group_by="ticker", threads=True)
                break
            except Exception as e:  # noqa: BLE001
                print(f"取得失敗（{attempt + 1}回目）: {e}")
                time.sleep(10)
        else:
            continue
        for s in part:
            if s not in df.columns.get_level_values(0):
                continue
            one = df[s][["Open", "High", "Low", "Close", "Volume"]].dropna()
            one = one[(one["Open"] > 0) & (one["Close"] > 0)]
            if len(one) > 100:
                one.index = pd.to_datetime(one.index).tz_localize(None).normalize()
                out[s] = one.rename(columns=str.lower)
        print(f"{min(n + 100, len(symbols))}/{len(symbols)} 取得")
        time.sleep(2)
    return out


def sox_up75(sox: pd.DataFrame, days: pd.DatetimeIndex) -> pd.Series:
    """東京の日付 d の前夜（d より前の最後の米国の営業日）のSOXが75日線の上か"""
    up = sox["close"] > sox["close"].rolling(75).mean()
    up = up[sox["close"].rolling(75).count() == 75]
    s = up.reindex(up.index.union(days)).sort_index().shift(1).ffill()  # shift: 同じ日付の米国分は使わない
    return s.reindex(days)


def run(codes: list[str], data: dict[str, pd.DataFrame], sox: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for code in codes:
        b = data.get(f"{code}.T")
        if b is None:
            continue
        b = b.rename(columns={"open": "o", "high": "h", "low": "l", "close": "c"})
        idx = b.index
        o, c = b["o"].to_numpy(), b["c"].to_numpy()
        chg = np.r_[np.nan, (c[1:] / c[:-1] - 1) * 100]
        week = idx.to_period("W-SUN")
        dow = idx.day_of_week + 1
        up = sox_up75(sox, idx).to_numpy()
        # 週の最初の営業日の位置
        first = np.zeros(len(b), dtype=int)
        for i in range(1, len(b)):
            first[i] = first[i - 1] if week[i] == week[i - 1] else i
        for i in range(1, len(b)):
            j = first[i]
            wk_days = i - j
            wk = (c[i - 1] / o[j] - 1) * 100 if wk_days > 0 else np.nan
            seg = chg[max(j, 1):i]  # 今週すでに終わった日の騰落%
            wk_min = float(np.min(seg)) if wk_days > 0 and len(seg) else np.nan
            # その週の最後の営業日（金曜の引けの代わり。祝日で金曜が休みなら木曜）
            k = i
            while k + 1 < len(b) and week[k + 1] == week[i]:
                k += 1
            rows.append(dict(code=code, d=idx[i], dow=int(dow[i]), up=up[i], wk=wk, wkMin=wk_min, wkDays=wk_days,
                             ret1=chg[i - 1] if i >= 2 else np.nan,
                             oc=(c[i] / o[i] - 1) * 100,          # その日の寄り→引け
                             to_wend=(c[k] / o[i] - 1) * 100,     # その日の寄り→その週の最後の引け
                             wend_dow=int(dow[k]),
                             to_4d=(c[i + 3] / o[i] - 1) * 100 if i + 3 < len(b) else np.nan,  # 寄りで買い→4日目の引け（曜日をまたいでよい）
                             to_thu=(c[i + 3] / o[i] - 1) * 100 if i + 3 < len(b) and week[i + 3] == week[i] and dow[i + 3] == 4 else np.nan))
    return pd.DataFrame(rows)


def stats(r: pd.Series, d: pd.Series) -> dict:
    """r: 1回ごとの損益%（コスト込み）。日ごとに平均して t値・前半/後半を出す"""
    if r.empty:
        return dict(回数=0, 日数=0)
    byday = r.groupby(d).mean()
    n, m = len(byday), byday.mean()
    sd = byday.std(ddof=1) if n > 1 else 0
    t = m / (sd / math.sqrt(n)) if sd and n > 1 else 0
    e, l = byday[byday.index < SPLIT].mean(), byday[byday.index >= SPLIT].mean()
    judge = "件数不足" if n < 20 else ("◎ 合格候補" if t >= 2 and e > 0 and l > 0 else ("△ 要観察" if t >= 1.5 and e > 0 and l > 0 else "× 優位性なし"))
    return dict(回数=len(r), 日数=n, 平均=round(r.mean(), 3), 日ごと平均=round(m, 3), 勝率=round((r > 0).mean() * 100),
                t値=round(t, 2), 前半=round(e, 3) if not math.isnan(e) else None, 後半=round(l, 3) if not math.isnan(l) else None, 判定=judge)


def checks(ev: pd.DataFrame) -> list[tuple[str, pd.Series, pd.Series]]:
    """(名前, 損益%, 日付) の並び。売りは符号を反対にする"""
    on, off = ev["up"] == True, ev["up"] == False  # noqa: E712
    fri = ev["dow"] == 5
    out = []
    def add(name, mask, col, side=1):
        x = ev[mask & ev[col].notna()]
        out.append((name, side * x[col] - COST, x["d"]))
    add("基準: 全部の日の寄り→引け（買い）", ev["dow"] > 0, "oc")
    add("基準: リスクオン局面の全部の日の寄り→引け（買い）", on, "oc")
    add("比較: リスクオン局面の金曜の寄り→引け（買い）", on & fri, "oc")
    add("型13 リスクオン 月〜木+3%以上の週の金曜を売り", on & fri & (ev["wkDays"] >= 3) & (ev["wk"] >= 3), "oc", -1)
    add("型13 リスクオン 月〜木-3%以下の週の金曜を買い", on & fri & (ev["wkDays"] >= 3) & (ev["wk"] <= -3), "oc")
    add("型13 リスクオフ 月〜木+3%以上の週の金曜を売り", off & fri & (ev["wkDays"] >= 3) & (ev["wk"] >= 3), "oc", -1)
    add("型13 リスクオフ 月〜木-3%以下の週の金曜を買い", off & fri & (ev["wkDays"] >= 3) & (ev["wk"] <= -3), "oc")
    add("型12 リスクオン 月曜の寄りで買い→木曜の引け", on & (ev["dow"] == 1), "to_thu")
    # 型12の比べる基準: リスクオンならどの曜日に買っても4日持てば同じくらい上がるのか
    add("型12基準 リスクオン 全部の日の寄りで買い→4日目の引け", on, "to_4d")
    for k, w in enumerate("月火水木金", start=1):
        add(f"型12基準 リスクオン {w}曜の寄りで買い→4日目の引け", on & (ev["dow"] == k), "to_4d")
    add("型12基準 リスクオフ 全部の日の寄りで買い→4日目の引け", off, "to_4d")
    add("型12 リスクオン 月曜の寄りで買い→週の最後の引け", on & (ev["dow"] == 1) & (ev["wend_dow"] == 5), "to_wend")
    add("型14 リスクオン 火曜-3%以下→水曜の寄りで買い→週の最後の引け", on & (ev["dow"] == 3) & (ev["ret1"] <= -3), "to_wend")
    add("型14 リスクオン 水曜-3%以下→木曜の寄りで買い→週の最後の引け", on & (ev["dow"] == 4) & (ev["ret1"] <= -3), "to_wend")
    add("型14 リスクオン 今週-3%以下の日があった週の金曜を買い", on & fri & (ev["wkMin"] <= -3), "oc")
    add("型14 リスクオフ 今週-3%以下の日があった週の金曜を買い", off & fri & (ev["wkMin"] <= -3), "oc")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--universe", default="AI半導体", help="AI半導体 / 大型108 / プライム")
    ap.add_argument("--period", default="6y")
    a = ap.parse_args()
    codes = prime_codes() if a.universe == "プライム" else UNIV[a.universe]
    print(f"対象 {a.universe}: {len(codes)}銘柄")
    data = download(["^SOX"] + [f"{c}.T" for c in codes], a.period)
    if "^SOX" not in data:
        raise SystemExit("SOXが取れませんでした")
    ev = run(codes, data, data["^SOX"])
    if ev.empty:
        raise SystemExit("株価が1本も取れませんでした")
    res = []
    for name, r, d in checks(ev):
        res.append(dict(検証=name, **stats(r, d)))
    df = pd.DataFrame(res)
    OUT.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT / f"week_flow_{a.universe}.csv", index=False, encoding="utf-8-sig")
    ev.to_csv(OUT / f"week_flow_{a.universe}_events.csv.gz", index=False, encoding="utf-8")
    md = f"## 週の中の流れ（型12〜14） 対象: {a.universe} {ev['code'].nunique()}銘柄 {ev['d'].min():%Y-%m-%d}〜{ev['d'].max():%Y-%m-%d}\n\n"
    md += "損益%はコスト0.1%込み。日ごと平均・t値・前半(〜2023)/後半(2024〜)は同じ日の複数銘柄を1回と数えたもの。\n\n"
    cols = list(df.columns)
    md += "| " + " | ".join(cols) + " |\n|" + "---|" * len(cols) + "\n"
    for _, row in df.fillna("").iterrows():
        md += "| " + " | ".join(str(row[k]) for k in cols) + " |\n"
    print(md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(md + "\n")


if __name__ == "__main__":
    main()
