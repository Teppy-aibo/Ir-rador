"""セクター代表銘柄の「前夜の連動先が大きく動いた朝 → 寄りで入り引けで出る」に集中した場合の損益（11/16 ユーザー質問）。
GitHub Actions の「heavy-check」から手動で動かす。結果は Summary（表）と成果物（CSV）。コミットはしない。

2通りで計算する。
  A 固定の7銘柄: 11/16 に6年分で選んだサイン（後から見て選んでいる＝良く出やすい）
  B 選び直し（先読みなし）: 毎年はじめに、その前の年までのデータだけで sector_reps の約50通りから合格したサインを選び、その1年だけ使う
     合格 = 2年以上の夜で日ごと平均の絶対値0.3%以上・t値の絶対値2以上・前半と後半が同じ向き
1回 250万円（信用のデイトレ）。損切りなし／損切り2%（=1R 5万円）の両方。コストは往復0.1%と0.3%。
同じ日・同じ銘柄に2つのサインが出たら1回だけ（先に並んだ方）。1日の建玉は合計2,500万円まで（10回）。
"""

from __future__ import annotations

import argparse
import math
import os

import numpy as np
import pandas as pd

from linkage import band, driver_move, prev_night
from sector_reps import REPS
from week_flow import OUT, download

NOTIONAL = 2_500_000
DAY_CAP = 10
FIXED = [  # (銘柄, 連動先, 夜 1=大きく上げた/-1=大きく下げた, 向き 1=買い/-1=売り)
    ("5801", "VRT", -1, -1), ("6301", "CAT", 1, 1), ("6301", "HG=F", -1, -1), ("7012", "RHM.DE", -1, -1),
    ("4519", "XBI", -1, -1), ("1911", "ITB", -1, -1), ("1911", "ITB", 1, 1), ("8031", "HG=F", -1, -1),
    ("8031", "CL=F", -1, -1), ("5401", "SLX", 1, 1),
]
NAMES = {r[1]: r[2] for r in REPS}


def build_events(data) -> pd.DataFrame:
    """全部の (銘柄, 連動先, 夜) の組の、毎日の寄り→引け%（コスト前）と高安"""
    rows = []
    for _, code, _, drv in REPS:
        b = data.get(f"{code}.T")
        if b is None:
            continue
        days = b.index
        o, h, l, c = b["open"], b["high"], b["low"], b["close"]
        gap = (o / c.shift(1) - 1) * 100
        oc = (c / o - 1) * 100
        ok = (gap.abs() < 30) & (oc.abs() < 30) & gap.notna() & oc.notna()
        for dsym, _, diff in drv:
            if dsym not in data:
                continue
            bd = band(prev_night(driver_move(data[dsym]["close"], diff), days))
            for night in (1, -1):
                m = (bd == night) & ok
                for d in days[m.to_numpy()]:
                    rows.append(dict(code=code, drv=dsym, night=night, date=d, oc=oc[d],
                                     up=(h[d] / o[d] - 1) * 100, dn=(l[d] / o[d] - 1) * 100))
    return pd.DataFrame(rows)


def passes(x: pd.DataFrame) -> int:
    """合格なら向き（1/-1）、だめなら0"""
    byday = x.groupby("date")["oc"].mean()
    n = len(byday)
    if n < 20:
        return 0
    m, sd = byday.mean(), byday.std(ddof=1)
    t = m / (sd / math.sqrt(n)) if sd else 0
    half = byday.index[n // 2]
    e, l = byday[byday.index < half].mean(), byday[byday.index >= half].mean()
    if abs(m) >= 0.3 and abs(t) >= 2 and np.sign(e) == np.sign(l) == np.sign(m):
        return int(np.sign(m))
    return 0


def trade_ret(r, side: int, stop: float | None, cost: float) -> float:
    if stop is not None:
        if side == 1 and r["dn"] <= -stop:
            return -stop - cost
        if side == -1 and r["up"] >= stop:
            return -stop - cost
    return side * r["oc"] - cost


def run(ev: pd.DataFrame, picks: pd.DataFrame, stop, cost) -> pd.DataFrame:
    """picks: date, code, side の並び（同じ日・銘柄は1回、1日 DAY_CAP 回まで）"""
    t = ev.merge(picks, on=["code", "drv", "night"])
    t = t.drop_duplicates(["date", "code"]).sort_values("date")
    t = t.groupby("date").head(DAY_CAP)
    t["ret"] = [trade_ret(r, s, stop, cost) for (_, r), s in zip(t.iterrows(), t["side"])]
    t["yen"] = NOTIONAL * t["ret"] / 100
    return t


def summarize(name: str, t: pd.DataFrame, months: pd.PeriodIndex) -> tuple[dict, pd.Series]:
    m = t.groupby(t["date"].dt.to_period("M"))["yen"].sum().reindex(months, fill_value=0)
    n = t.groupby(t["date"].dt.to_period("M")).size().reindex(months, fill_value=0)
    eq = m.cumsum()
    return dict(案=name, 月数=len(m), 月の平均回数=round(n.mean(), 1), 入れない月=int((n == 0).sum()),
                平均の1回=f"{t['ret'].mean():+.3f}%" if len(t) else "", 勝率=f"{(t['ret'] > 0).mean() * 100:.0f}%" if len(t) else "",
                月の平均損益=int(m.mean()), 月の真ん中=int(m.median()), プラスの月=f"{(m > 0).mean() * 100:.0f}%",
                一番悪い月=int(m.min()), 一番良い月=int(m.max()), 最大の落ち込み=int((eq - eq.cummax()).min()),
                直近12か月=int(m.iloc[-12:].sum())), m


def tbl(x: pd.DataFrame) -> str:
    cols = list(x.columns)
    s = "| " + " | ".join(map(str, cols)) + " |\n|" + "---|" * len(cols) + "\n"
    for _, r in x.astype(object).fillna("").iterrows():
        s += "| " + " | ".join(str(r[c]) for c in cols) + " |\n"
    return s


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--universe", default="", help="使わない")
    ap.add_argument("--period", default="8y")
    a = ap.parse_args()
    drivers = sorted({d for r in REPS for d, _, _ in r[3]})
    syms = drivers + [f"{r[1]}.T" for r in REPS]
    data = download(syms, a.period)
    for s in syms:
        if s not in data:
            data.update(download([s], a.period))
    ev = build_events(data)
    first = ev["date"].min()
    # B 選び直し: 毎年はじめに前の年までで選ぶ（最初の2年は準備だけ）
    years = sorted(ev["date"].dt.year.unique())
    start_year = first.year + 3
    wf_picks, pick_log = [], []
    for y in [y for y in years if y >= start_year]:
        past = ev[ev["date"] < pd.Timestamp(f"{y}-01-01")]
        chosen = []
        for (code, drv, night), g in past.groupby(["code", "drv", "night"]):
            side = passes(g)
            if side:
                chosen.append(dict(code=code, drv=drv, night=night, side=side, year=y))
        wf_picks += chosen
        pick_log.append(dict(年=y, 選んだ数=len(chosen), 中身="／".join(
            f"{NAMES.get(c['code'], c['code'])} {c['drv']}{'↑' if c['night'] == 1 else '↓'}→{'買' if c['side'] == 1 else '売'}" for c in chosen)))
    wf = pd.DataFrame(wf_picks)
    fixed = pd.DataFrame(FIXED, columns=["code", "drv", "night", "side"])
    sim_start = pd.Timestamp(f"{start_year}-01-01")
    ev_s = ev[ev["date"] >= sim_start]
    months = pd.period_range(sim_start, ev["date"].max(), freq="M")

    md = f"## 代表銘柄の前夜サインに集中した場合（1回250万円・{sim_start:%Y-%m}〜{ev['date'].max():%Y-%m-%d}）\n\n"
    md += "### 選び直しで毎年選んだサイン（その年より前のデータだけ）\n" + tbl(pd.DataFrame(pick_log)) + "\n"
    OUT.mkdir(parents=True, exist_ok=True)
    keep = {}
    for cost in (0.1, 0.3):
        rows = []
        for stop in (None, 2.0):
            st = "損切りなし" if stop is None else "損切り2%"
            tA = run(ev_s, fixed, stop, cost)
            rA, mA = summarize(f"A 固定の7銘柄・{st}", tA, months)
            if len(wf):
                parts = []
                for y, g in wf.groupby("year"):
                    e = ev_s[ev_s["date"].dt.year == y]
                    parts.append(run(e, g.drop(columns="year"), stop, cost))
                tB = pd.concat(parts) if parts else pd.DataFrame(columns=tA.columns)
            else:
                tB = tA.iloc[0:0]
            rB, mB = summarize(f"B 選び直し・{st}", tB, months)
            rows += [rA, rB]
            keep[(cost, st)] = (mA, mB, tA, tB)
        md += f"### コスト往復{cost}%\n" + tbl(pd.DataFrame(rows)) + "\n"
    mA, mB, tA, tB = keep[(0.1, "損切り2%")]
    yr = pd.DataFrame({"A 固定": mA.groupby(mA.index.year).sum(), "B 選び直し": mB.groupby(mB.index.year).sum(),
                       "A 回数": tA.groupby(tA["date"].dt.year).size(), "B 回数": tB.groupby(tB["date"].dt.year).size()}).fillna(0).astype(int)
    md += "### 年ごと（コスト0.1%・損切り2%）\n" + tbl(yr.reset_index().rename(columns={"index": "年"})) + "\n"
    if len(tB):
        g = tB.groupby("code").agg(回数=("ret", "size"), 平均=("ret", "mean"), 損益=("yen", "sum")).round(3).reset_index()
        g["銘柄"] = g["code"].map(NAMES)
        g["損益"] = g["損益"].astype(int)
        md += "### 選び直し・銘柄ごと（コスト0.1%・損切り2%）\n" + tbl(g[["銘柄", "回数", "平均", "損益"]]) + "\n"
    mon = pd.DataFrame({"A 固定": mA, "B 選び直し": mB}).astype(int)
    md += "### 月ごと（コスト0.1%・損切り2%）\n" + tbl(mon.reset_index().rename(columns={"index": "月"}).assign(月=lambda x: x["月"].astype(str)))
    tA.to_csv(OUT / "sector_sim_fixed.csv", index=False, encoding="utf-8-sig")
    tB.to_csv(OUT / "sector_sim_walkforward.csv", index=False, encoding="utf-8-sig")
    print(md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(md + "\n")


if __name__ == "__main__":
    main()
