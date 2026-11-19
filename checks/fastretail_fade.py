"""ファストリ（9983）は「朝一番の高値をつけた後に空売りすれば、ほぼ勝つ」か（11/19 ユーザー仮説）。
GitHub Actions の「heavy-check」から手動で動かす。結果は Summary（表）と成果物（CSV）。コミットはしない。

後から見た「高値」にならないよう、入り方を先に決める（結果を見てから変えない）:
  朝の箱 = 9:00〜9:25 の5分足6本（寄り後30分）。その高値 H・安値 L。
  V1 9:30売り   : 9:25の足の終値で売る。損切り = H を超えたら（逆指値、Hで約定。窓で越えたら始値）。
                  ただし損切りは最低でも入り値の+0.5%（Hが入り値に近すぎる日は+0.5%）。V2も同じ。
  V2 安値割れ売り: 9:30〜11:00 の足が終値で L を割ったら、その終値で売る（1日1回）。損切り = H。
  手じまい       : 前引け（11:25の足の終値）と 大引け（15:25の足の終値）の2通り。
  コスト         : 往復0.1%。R = 損益 ÷（損切り − 入り値）。
比べるもの:
  ・同じルールを他の大型株（半導体・非半導体）にも当てる（ファストリだけの話か）
  ・日の分け方: 「型15の日」= 半導体（東エレク・アドテストの平均）が9:25時点で前日比 -1% 以下 かつ ファストリが前日比プラス
  ・前半／後半（60日を半分）、直近5日（ユーザーが見た「ここ数日」）
  ・後知恵の見え方: 「引けが朝の高値 H より下だった日の割合」（高値は最大値なので、どの銘柄でも高く出る）
Yahoo の5分足は直近60日が上限。日足の前日終値は日足で取る。
"""

from __future__ import annotations

import argparse
import math
import os
from pathlib import Path

import numpy as np
import pandas as pd

OUT = Path(os.environ.get("OUT_DIR", "out"))
COST = 0.1
MIN_STOP = 0.5  # 損切りは最低でも入り値の0.5%上（揺れに狩られないように。feedback-stop-hunt-2）
MAIN = "9983"
SEMIS = ["8035", "6857"]
OTHERS = {  # 比べる大型株（業種で先に決める）
    "8035": "東エレク", "6857": "アドテスト", "9984": "ソフトバンクG", "6367": "ダイキン", "9433": "KDDI",
    "4543": "テルモ", "6954": "ファナック", "7203": "トヨタ", "8306": "三菱UFJ", "6758": "ソニーG",
    "4063": "信越化学", "6098": "リクルート", "7974": "任天堂", "8058": "三菱商事",
}


def get5m(code: str) -> pd.DataFrame:
    import yfinance as yf
    for _ in range(3):
        try:
            df = yf.download(f"{code}.T", period="60d", interval="5m", progress=False, auto_adjust=False)
            break
        except Exception as e:  # noqa: BLE001
            print(code, "取得失敗", e)
    else:
        return pd.DataFrame()
    if df is None or df.empty:
        return pd.DataFrame()
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df = df[["Open", "High", "Low", "Close", "Volume"]].dropna().rename(columns=str.lower)
    idx = pd.to_datetime(df.index)
    idx = idx.tz_convert("Asia/Tokyo") if idx.tz is not None else idx.tz_localize("UTC").tz_convert("Asia/Tokyo")
    df.index = idx.tz_localize(None)
    df["d"] = df.index.normalize()
    df["t"] = df.index.strftime("%H:%M")
    return df[(df["close"] > 0)]


def getdaily(codes: list[str]) -> dict[str, pd.Series]:
    import yfinance as yf
    out = {}
    df = yf.download([f"{c}.T" for c in codes], period="6mo", interval="1d", progress=False, auto_adjust=False, group_by="ticker")
    for c in codes:
        try:
            s = df[f"{c}.T"]["Close"].dropna()
            s.index = pd.to_datetime(s.index).tz_localize(None).normalize()
            out[c] = s
        except Exception:  # noqa: BLE001
            pass
    return out


def day_trades(b: pd.DataFrame, prev_close: float) -> dict:
    """1日分の5分足 b（9:00〜15:30）から V1・V2 の結果を出す"""
    box = b[(b["t"] >= "09:00") & (b["t"] <= "09:25")]
    if len(box) < 5:
        return {}
    H, L = box["high"].max(), box["low"].min()
    c925 = box["close"].iloc[-1]
    after = b[b["t"] >= "09:30"]
    res = dict(H=H, L=L, c925=c925, chg925=(c925 / prev_close - 1) * 100 if prev_close else np.nan)
    am_end = b[b["t"] <= "11:25"]
    day_end = b[b["t"] <= "15:25"]
    if am_end.empty or day_end.empty:
        return {}
    res["close_below_H"] = day_end["close"].iloc[-1] < H

    def run(entry: float, start_t: str, stop: float, end_t: str):
        stop = max(stop, entry * (1 + MIN_STOP / 100))  # 入り値が高値に近すぎる日も、揺れの外（0.5%）に置く
        path = b[(b["t"] >= start_t) & (b["t"] <= end_t)]
        risk = stop - entry
        if risk <= 0 or path.empty:
            return None
        for _, x in path.iterrows():
            if x["high"] >= stop:
                ex = max(stop, x["open"]) if x["open"] > stop else stop
                return ex, "損切り", risk
        return path["close"].iloc[-1], "時間", risk

    for name, end_t in (("前引け", "11:25"), ("大引け", "15:25")):
        r = run(c925, "09:30", H, end_t)
        if r:
            ex, why, risk = r
            res[f"V1_{name}_pct"] = (c925 - ex) / c925 * 100 - COST
            res[f"V1_{name}_R"] = ((c925 - ex) - c925 * COST / 100) / risk
            res[f"V1_{name}_why"] = why
    sig = after[(after["t"] <= "11:00") & (after["close"] < L)]
    if not sig.empty:
        e_t, e = sig.index[0], sig["close"].iloc[0]
        nxt = (e_t + pd.Timedelta(minutes=5)).strftime("%H:%M")
        for name, end_t in (("前引け", "11:25"), ("大引け", "15:25")):
            r = run(e, nxt, H, end_t)
            if r:
                ex, why, risk = r
                res[f"V2_{name}_pct"] = (e - ex) / e * 100 - COST
                res[f"V2_{name}_R"] = ((e - ex) - e * COST / 100) / risk
                res[f"V2_{name}_why"] = why
                res["V2_t"] = e_t.strftime("%H:%M")
    return res


def summarize(df: pd.DataFrame, col: str) -> dict:
    s = df[col].dropna()
    if s.empty:
        return dict(回数=0)
    n = len(s)
    t = s.mean() / (s.std(ddof=1) / math.sqrt(n)) if n > 1 and s.std(ddof=1) > 0 else 0
    return dict(回数=n, 平均=round(s.mean(), 3), 勝率=round((s > 0).mean() * 100), t値=round(t, 2), 合計=round(s.sum(), 2))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--universe", default="")
    ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    codes = [MAIN] + list(OTHERS)
    daily = getdaily(codes)
    bars = {c: get5m(c) for c in codes}
    rows = []
    for c in codes:
        b, dc = bars.get(c), daily.get(c)
        if b is None or b.empty or dc is None:
            print(c, "データなし")
            continue
        for d, g in b.groupby("d"):
            prev = dc[dc.index < d]
            if prev.empty:
                continue
            r = day_trades(g, float(prev.iloc[-1]))
            if r:
                r.update(code=c, date=d)
                rows.append(r)
    ev = pd.DataFrame(rows)
    ev.to_csv(OUT / "fastretail_fade_days.csv", index=False)
    # 型15の日: 半導体2銘柄の 9:25 前日比の平均 ≤ -1% かつ ファストリがプラス
    semi = ev[ev["code"].isin(SEMIS)].groupby("date")["chg925"].mean()
    fr = ev[ev["code"] == MAIN].set_index("date")["chg925"]
    t15 = set(d for d in fr.index if d in semi.index and semi[d] <= -1 and fr[d] > 0)
    ev["型15の日"] = ev["date"].isin(t15)
    days = sorted(ev["date"].unique())
    mid = days[len(days) // 2]
    last5 = set(days[-5:])

    lines = ["# ファストリ「朝の高値の後に空売り」の検証（5分足60日、コスト往復0.1%込み）", "",
             f"期間 {pd.Timestamp(days[0]).date()}〜{pd.Timestamp(days[-1]).date()}（{len(days)}営業日）。型15の日 = {len(t15)}日: " + ", ".join(str(pd.Timestamp(d).date()) for d in sorted(t15)), ""]
    me = ev[ev["code"] == MAIN]
    lines += ["## 1. ファストリ（損益%・Rは1回あたり）", "", "| ルール | 分け方 | 回数 | 平均% | 勝率% | t値 | 平均R | 合計% |", "|---|---|---|---|---|---|---|---|"]
    splits = [("全部", me), ("型15の日", me[me["型15の日"]]), ("型15以外", me[~me["型15の日"]]),
              ("前半", me[me["date"] < mid]), ("後半", me[me["date"] >= mid]), ("直近5日", me[me["date"].isin(last5)])]
    for rule in ("V1_前引け", "V1_大引け", "V2_前引け", "V2_大引け"):
        for nm, sub in splits:
            p, r = summarize(sub, f"{rule}_pct"), summarize(sub, f"{rule}_R")
            if p.get("回数", 0) == 0:
                lines.append(f"| {rule} | {nm} | 0 | | | | | |")
                continue
            lines.append(f"| {rule} | {nm} | {p['回数']} | {p['平均']} | {p['勝率']} | {p['t値']} | {r['平均']} | {p['合計']} |")
    lines += ["", "## 2. 同じルールを他の大型株に（全期間）", "", "| 銘柄 | V1前引け 平均%(勝率) | V1大引け | V2前引け | V2大引け | 引けが朝の高値より下の日% |", "|---|---|---|---|---|---|"]
    for c in codes:
        sub = ev[ev["code"] == c]
        if sub.empty:
            continue
        cell = []
        for rule in ("V1_前引け", "V1_大引け", "V2_前引け", "V2_大引け"):
            p = summarize(sub, f"{rule}_pct")
            cell.append(f"{p['平均']} ({p['勝率']}%, {p['回数']}回)" if p.get("回数") else "-")
        nm = "ファストリ" if c == MAIN else OTHERS[c]
        lines.append(f"| {c} {nm} | " + " | ".join(cell) + f" | {round(sub['close_below_H'].mean() * 100)} |")
    lines += ["", "## 3. ファストリの直近10日（1日ずつ）", "", "| 日 | 9:25前日比% | 型15 | 朝の高値H | 安値L | V1前引け% | V1大引け% | V2入り | V2前引け% | V2大引け% |", "|---|---|---|---|---|---|---|---|---|---|"]
    f = lambda v: "" if v is None or (isinstance(v, float) and math.isnan(v)) else (round(v, 2) if isinstance(v, float) else v)  # noqa: E731
    for _, x in me.sort_values("date").tail(10).iterrows():
        lines.append(f"| {pd.Timestamp(x['date']).date()} | {f(x['chg925'])} | {'○' if x['型15の日'] else ''} | {f(x['H'])} | {f(x['L'])} | {f(x.get('V1_前引け_pct'))} | {f(x.get('V1_大引け_pct'))} | {f(x.get('V2_t'))} | {f(x.get('V2_前引け_pct'))} | {f(x.get('V2_大引け_pct'))} |")
    text = "\n".join(lines)
    print(text)
    (OUT / "fastretail_fade.md").write_text(text, encoding="utf-8")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as fh:
            fh.write(text + "\n")


if __name__ == "__main__":
    main()
