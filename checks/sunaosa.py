"""素直さ（1日の中で向きがすぐ変わるか、素直に続くか）を5分足60日で測る（11/19 ユーザー: X投稿の1000ティック足の太陽誘電とキオクシア）。
GitHub Actions の「heavy-check」から手動で動かす。結果は Summary（表）と成果物（CSV）。コミットはしない。

測るもの（銘柄ごと・1日ごと、5分足）
  効率: |最後の終値 − 最初の始値| ÷ 5分ごとの動きの絶対値の合計。1に近いほど一方向、0に近いほど行ったり来たり。
  その日の差: 効率 − 同じ日の全銘柄の効率の平均（相場全体が一方向の日の分を除く）
  向きの変わる回数: 5分足の終値で、平均の動き幅の3倍以上戻したら「向きが変わった」と数える
確かめる事
  1. 続くか: 前半30日と後半30日で「その日の差」の銘柄の順位が同じか（順位の相関）。前日・前5日の差が今日の差を当てるか。
  2. 使えるか（先読みなし）: 5分足の順張り（25本線を下に抜け＋25本線が下向き→次の足の始値で売り、25本線を上に戻したら買い戻し、
     引けで手じまい。買いは反対）。入りは9:30〜14:30。コスト0.1%込み。
     a) 前半の素直さで銘柄を3組に分け、後半の順張りの成績を比べる
     b) 毎日、その日より前の10日の素直さで3組に分けて比べる（毎日選び直す）
     c) 下げ局面（前日の終値が日足25日線の下）の売りだけでも比べる
"""

from __future__ import annotations

import argparse
import math
import os
import time

import numpy as np
import pandas as pd

from week_flow import OUT, UNIV, download

COST = 0.1
WATCH = {
    "6857": "アドテスト", "8035": "東エレク", "6920": "レーザーテック", "6146": "ディスコ", "4062": "イビデン",
    "285A": "キオクシア", "5801": "古河電工", "5803": "フジクラ", "6976": "太陽誘電", "6981": "村田製",
    "9984": "ソフトバンクG", "4004": "レゾナック", "3436": "SUMCO", "6871": "マイクロニクス", "6315": "TOWA",
    "6525": "KOKUSAI", "7735": "スクリン", "7729": "東京精密", "6526": "ソシオネクスト", "4063": "信越化",
    "6762": "TDK", "6723": "ルネサス", "5802": "住友電工", "5805": "SWCC", "6501": "日立", "7011": "三菱重",
    "7203": "トヨタ", "8306": "三菱UFJ", "6758": "ソニーG", "9983": "ファストリ", "8058": "三菱商事",
}


def download5(symbols: list[str]) -> dict[str, pd.DataFrame]:
    import yfinance as yf
    out: dict[str, pd.DataFrame] = {}
    for n in range(0, len(symbols), 40):
        part = symbols[n:n + 40]
        for attempt in range(3):
            try:
                df = yf.download(part, period="60d", interval="5m", progress=False, auto_adjust=False,
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
            if len(one) < 500:
                continue
            idx = pd.to_datetime(one.index)
            idx = idx.tz_convert("Asia/Tokyo") if idx.tz is not None else idx.tz_localize("UTC").tz_convert("Asia/Tokyo")
            one.index = idx.tz_localize(None)
            out[s] = one.rename(columns=str.lower).sort_index()
        print(f"{min(n + 40, len(symbols))}/{len(symbols)} 取得（5分足）")
        time.sleep(2)
    return out


def zigzag_turns(p: np.ndarray, thr: float) -> int:
    direction, ext, turns = 0, p[0], 0
    for x in p[1:]:
        if direction == 0:
            if x - ext >= thr:
                direction, ext = 1, x
            elif ext - x >= thr:
                direction, ext = -1, x
        elif direction == 1:
            if x > ext:
                ext = x
            elif ext - x >= thr:
                direction, ext, turns = -1, x, turns + 1
        else:
            if x < ext:
                ext = x
            elif x - ext >= thr:
                direction, ext, turns = 1, x, turns + 1
    return turns


def day_rows(code: str, b: pd.DataFrame) -> list[dict]:
    rows = []
    for d, g in b.groupby(b.index.normalize()):
        if len(g) < 50:  # 半日・欠けの多い日は使わない
            continue
        path = np.r_[g["open"].iloc[0], g["close"].to_numpy()]
        mv = np.abs(np.diff(path))
        tot = mv.sum()
        if tot <= 0:
            continue
        rows.append(dict(code=code, date=d, 効率=abs(path[-1] - path[0]) / tot,
                         向きの変わる回数=zigzag_turns(path, 3 * mv.mean()),
                         値幅=(g["high"].max() / g["low"].min() - 1) * 100))
    return rows


def trend_trades(code: str, b: pd.DataFrame) -> list[dict]:
    c, o = b["close"].to_numpy(), b["open"].to_numpy()
    ma = pd.Series(c).rolling(25).mean().to_numpy()
    days = b.index.normalize()
    hm = b.index.hour * 100 + b.index.minute
    out = []
    pos, entry, ent_i = 0, 0.0, 0
    n = len(b)
    for i in range(31, n - 1):
        last_of_day = days[i + 1] != days[i]
        if pos != 0:
            back = (pos == -1 and c[i] > ma[i]) or (pos == 1 and c[i] < ma[i])
            if back or last_of_day:
                px = c[i] if last_of_day else o[i + 1]
                out.append(dict(code=code, date=days[ent_i], 向き="売り" if pos == -1 else "買い",
                                損益=pos * (px / entry - 1) * 100 - COST))
                pos = 0
                continue
        if pos == 0 and not last_of_day and 930 <= hm[i] <= 1430 and days[i - 6] == days[i]:
            if c[i] < ma[i] and c[i - 1] >= ma[i - 1] and ma[i] < ma[i - 6]:
                pos, entry, ent_i = -1, o[i + 1], i + 1
            elif c[i] > ma[i] and c[i - 1] <= ma[i - 1] and ma[i] > ma[i - 6]:
                pos, entry, ent_i = 1, o[i + 1], i + 1
    return out


def tstat(r: pd.Series, d: pd.Series) -> dict:
    if r.empty:
        return dict(回数=0, 日数=0)
    byday = r.groupby(d).mean()
    k, m = len(byday), byday.mean()
    sd = byday.std(ddof=1) if k > 1 else 0
    t = m / (sd / math.sqrt(k)) if sd and k > 1 else 0
    return dict(回数=len(r), 日数=k, 平均=round(r.mean(), 3), 勝率=round((r > 0).mean() * 100), t値=round(t, 2))


def table(df: pd.DataFrame) -> str:
    hd = list(df.columns)
    s = "| " + " | ".join(hd) + " |\n|" + "---|" * len(hd) + "\n"
    for _, row in df.fillna("").iterrows():
        s += "| " + " | ".join(str(row[k]) for k in hd) + " |\n"
    return s + "\n"


def spearman(a: pd.Series, b: pd.Series) -> tuple[float, float, int]:
    x = pd.concat([a, b], axis=1).dropna()
    k = len(x)
    if k < 5:
        return float("nan"), float("nan"), k
    r = x.iloc[:, 0].rank().corr(x.iloc[:, 1].rank())
    t = r * math.sqrt((k - 2) / max(1e-9, 1 - r * r))
    return round(r, 2), round(t, 2), k


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--universe", default="AI半導体")
    a = ap.parse_args()
    codes = list(WATCH)
    if a.universe != "AI半導体":
        codes += [c for c in UNIV["大型108"] if c not in WATCH]
    names = {c: WATCH.get(c, c) for c in codes}
    data5 = download5([f"{c}.T" for c in codes])
    daily = download([f"{c}.T" for c in codes], "1y")
    print(f"5分足 {len(data5)}銘柄 / 日足 {len(daily)}銘柄")

    drows, trades = [], []
    for code in codes:
        b = data5.get(f"{code}.T")
        if b is None:
            continue
        b = b[(b.index.hour * 100 + b.index.minute >= 900) & (b.index.hour * 100 + b.index.minute <= 1530)]
        drows += day_rows(code, b)
        trades += trend_trades(code, b)
    dd = pd.DataFrame(drows)
    tr = pd.DataFrame(trades)
    if dd.empty or tr.empty:
        raise SystemExit("5分足が取れませんでした")
    dd["その日の差"] = dd["効率"] - dd.groupby("date")["効率"].transform("mean")
    dd = dd.sort_values(["code", "date"])
    dd["前日の差"] = dd.groupby("code")["その日の差"].shift(1)
    dd["前5日の差"] = dd.groupby("code")["その日の差"].transform(lambda s: s.shift(1).rolling(5, min_periods=3).mean())
    dd["前10日の差"] = dd.groupby("code")["その日の差"].transform(lambda s: s.shift(1).rolling(10, min_periods=6).mean())
    alld = sorted(dd["date"].unique())
    mid = alld[len(alld) // 2]
    dd["半分"] = np.where(dd["date"] < mid, "前半", "後半")

    # 下げ局面（前日の終値が日足25日線の下）
    down = {}
    for code in codes:
        b = daily.get(f"{code}.T")
        if b is None:
            continue
        below = (b["close"] < b["close"].rolling(25).mean()).shift(1)
        down[code] = below
    def _dn(code, d):
        v = down.get(code, pd.Series(dtype=object)).get(d)
        return bool(v) if v is not None and v == v else False
    tr["下げ局面"] = [_dn(r.code, r.date) for r in tr.itertuples()]
    tr = tr.merge(dd[["code", "date", "前10日の差", "半分"]], on=["code", "date"], how="left")

    # 1. 銘柄ごとの表
    per = dd.groupby("code").agg(日数=("date", "count"), 効率=("効率", "mean"), 向きの変わる回数=("向きの変わる回数", "mean"),
                                  値幅=("値幅", "mean"))
    h = dd.pivot_table(index="code", columns="半分", values="その日の差", aggfunc="mean")
    per["その日の差_前半"], per["その日の差_後半"] = h.get("前半"), h.get("後半")
    th = tr.pivot_table(index="code", columns="半分", values="損益", aggfunc="mean")
    per["順張り_前半"], per["順張り_後半"] = th.get("前半"), th.get("後半")
    per["順張り_回数"] = tr.groupby("code").size()
    per.insert(0, "名前", [names.get(c, c) for c in per.index])
    per = per.sort_values("その日の差_前半", ascending=False).round(3)

    # 2. 続くか
    keep = []
    r, t, k = spearman(per["その日の差_前半"], per["その日の差_後半"])
    keep.append(dict(調べた事="素直さの順位 前半と後半", 相関=r, t値=t, 数=k))
    tm = dd.groupby(["code", "半分"])["向きの変わる回数"].mean().unstack()
    r, t, k = spearman(tm.get("前半"), tm.get("後半"))
    keep.append(dict(調べた事="向きの変わる回数の順位 前半と後半", 相関=r, t値=t, 数=k))
    r, t, k = spearman(per["順張り_前半"], per["順張り_後半"])
    keep.append(dict(調べた事="順張りの成績の順位 前半と後半", 相関=r, t値=t, 数=k))
    for col in ("前日の差", "前5日の差", "前10日の差"):
        x = dd[[col, "その日の差"]].dropna()
        rr = x[col].corr(x["その日の差"])
        tt = rr * math.sqrt((len(x) - 2) / max(1e-9, 1 - rr * rr))
        keep.append(dict(調べた事=f"{col}→今日の差（全部の日をまとめて）", 相関=round(rr, 3), t値=round(tt, 2), 数=len(x)))
    keep = pd.DataFrame(keep)

    # 3. 使えるか
    use = []
    def add(name, m):
        x = tr[m]
        use.append(dict(条件=name, **tstat(x["損益"], x["date"])))
    add("全部の順張り", tr.index == tr.index)
    add("全部 売りだけ", tr["向き"] == "売り")
    add("全部 買いだけ", tr["向き"] == "買い")
    add("下げ局面 売りだけ", (tr["向き"] == "売り") & tr["下げ局面"])
    add("下げ局面 買いだけ", (tr["向き"] == "買い") & tr["下げ局面"])
    # a) 前半の素直さで3組→後半
    q = per["その日の差_前半"].rank(pct=True)
    grp = pd.cut(q, [0, 1 / 3, 2 / 3, 1.0], labels=["行ったり来たり組", "真ん中組", "素直組"])
    tr["前半で決めた組"] = tr["code"].map(grp)
    for gname in ["素直組", "真ん中組", "行ったり来たり組"]:
        add(f"a) 後半 {gname}（前半で選ぶ）", (tr["半分"] == "後半") & (tr["前半で決めた組"] == gname))
        add(f"a) 後半 {gname} 下げ局面の売り", (tr["半分"] == "後半") & (tr["前半で決めた組"] == gname) & (tr["向き"] == "売り") & tr["下げ局面"])
    # b) 毎日、前10日で3組
    v = tr["前10日の差"]
    lo, hi = v.quantile(1 / 3), v.quantile(2 / 3)
    for gname, m in [("素直組", v >= hi), ("真ん中組", (v > lo) & (v < hi)), ("行ったり来たり組", v <= lo)]:
        add(f"b) {gname}（前10日で毎日選ぶ）", m)
        add(f"b) {gname} 下げ局面の売り", m & (tr["向き"] == "売り") & tr["下げ局面"])
    use = pd.DataFrame(use)

    OUT.mkdir(parents=True, exist_ok=True)
    dd.to_csv(OUT / "sunaosa_days.csv", index=False, encoding="utf-8-sig")
    tr.to_csv(OUT / "sunaosa_trades.csv", index=False, encoding="utf-8-sig")
    per.to_csv(OUT / "sunaosa_per_stock.csv", encoding="utf-8-sig")
    md = (f"## 素直さの検証（5分足 {pd.Timestamp(alld[0]):%Y-%m-%d}〜{pd.Timestamp(alld[-1]):%Y-%m-%d}・{len(alld)}日・{dd['code'].nunique()}銘柄、"
          f"前半/後半の境目 {pd.Timestamp(mid):%Y-%m-%d}）\n\n")
    md += "効率=1日の最初から最後までの動き÷途中の動きの合計（1に近いほど素直）。その日の差=同じ日の全銘柄平均との差。順張りの損益%はコスト0.1%込み。\n\n"
    md += "### 1. 素直さは続くか\n\n" + table(keep)
    md += "### 2. 順張りで使えるか（先読みなし）\n\n" + table(use)
    md += "### 3. 銘柄ごと（前半の素直さの順）\n\n" + table(per.reset_index())
    print(md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(md + "\n")


if __name__ == "__main__":
    main()
