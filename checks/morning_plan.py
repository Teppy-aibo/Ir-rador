"""「前の晩に表を作り、朝は気配を照らすだけ」で、月に何回入れて、いくら残るかを過去にさかのぼって確かめる（11/16 ユーザー質問）。
GitHub Actions の「heavy-check」から手動で動かす。結果は Summary（表）と成果物（CSV）。コミットはしない。

どの日も、その日の朝までに分かる値だけで決める（先読みなし）。決め事は最初に決めて途中で変えない。
  G7     8:59の気配が前日比+8〜20%（寄りの窓で代用）で寄指売り。TOPIXの代わりに日経ETFが前日に75日線の下の日だけ。
         損切り+2%・利確-4%・どちらもなければ引けで買い戻し。1回250万円（=1R 5万円）。同じ日に両方触れたら損切り扱い。
  窓買い  前の晩の表: その日に前日比+5%以上の窓・出来高が20日平均の2倍以上・引けが日中の値幅の半分より上の銘柄を、
         出来高の倍率が大きい順に最大3つ。翌朝の寄りで買い（寄りが前の日の安値より下なら取り消し）。
         損切り＝前の日（窓の日）の安値を終値で割ったら翌朝の寄りで売り。10日目の引けで手じまい。株数は1R=5万円から逆算、
         1回の上限400万円・同時に持つ合計は800万円まで（現物）。地合い: 日経ETFが前日に75日線の上の日だけ（あり/なしを比べる）。
         決算の日かどうかは区別していない（H2の代わり）。
コストは往復0.3%（厳しめ）と0.1%の両方。対象は大型108銘柄。
"""

from __future__ import annotations

import argparse
import os

import numpy as np
import pandas as pd

from week_flow import OUT, UNIV, download

R_YEN = 50_000
G7_NOTIONAL = 2_500_000
MAX_ONE = 4_000_000
MAX_TOTAL = 8_000_000
START = pd.Timestamp("2019-01-01")


def fix_nk(nk: pd.DataFrame) -> pd.DataFrame:
    nk = nk.copy()
    jump = nk["close"].pct_change().abs() > 0.15
    for dt, r in nk["close"].pct_change()[jump].items():
        nk.loc[nk.index < dt, ["open", "high", "low", "close"]] *= (1 + r)
    return nk


def g7_trades(data, codes, nk_below75, below75_stock: bool, cost: float) -> list[dict]:
    out = []
    for code in codes:
        b = data.get(f"{code}.T")
        if b is None or len(b) < 100:
            continue
        o, h, l, c = (b[k].to_numpy() for k in ("open", "high", "low", "close"))
        ma75 = b["close"].rolling(75).mean().to_numpy()
        mk = nk_below75.reindex(b.index).to_numpy()
        for t in range(76, len(b)):
            if b.index[t] < START or not (mk[t] == 1):
                continue
            gap = o[t] / c[t - 1] - 1
            if not (0.08 <= gap < 0.20):
                continue
            if below75_stock and not (c[t - 1] < ma75[t - 1]):
                continue
            if h[t] >= o[t] * 1.02:
                ret = -2.0
            elif l[t] <= o[t] * 0.96:
                ret = 4.0
            else:
                ret = -(c[t] / o[t] - 1) * 100
            ret -= cost
            out.append(dict(型="G7", code=code, entry=b.index[t], exit=b.index[t], yen=G7_NOTIONAL * ret / 100, R=ret / 2.0))
    return out


def gap_buy_signals(data, codes, nk_up75, use_mkt: bool) -> pd.DataFrame:
    rows = []
    for code in codes:
        b = data.get(f"{code}.T")
        if b is None or len(b) < 250:
            continue
        o, h, l, c, v = (b[k].to_numpy() for k in ("open", "high", "low", "close", "volume"))
        v20 = b["volume"].rolling(20).mean().shift(1).to_numpy()
        mk = nk_up75.reindex(b.index).to_numpy()
        n = len(b)
        for t in range(201, n - 1):
            if b.index[t] < START - pd.Timedelta(days=5):
                continue
            gap = o[t] / c[t - 1] - 1
            if not (0.05 <= gap < 0.3) or not (v20[t] > 0) or not (h[t] > l[t]):
                continue
            if v[t] / v20[t] < 2.0 or (c[t] - l[t]) / (h[t] - l[t]) < 0.5:
                continue
            if use_mkt and not (mk[t] == 1):
                continue
            rows.append(dict(code=code, sig_i=t, sig=b.index[t], vmult=v[t] / v20[t], low=l[t]))
    return pd.DataFrame(rows)


def gap_buy_trades(data, sig: pd.DataFrame, cost: float, top: int = 3) -> tuple[list[dict], int, int]:
    """前の晩の表（最大top）→翌朝の寄りで買う。持っている合計の上限は日付順に守る。戻り値: 売買, 取り消し数, 上限で見送り数"""
    if sig.empty:
        return [], 0, 0
    cand = []
    for _, r in sig.iterrows():
        b = data[f"{r['code']}.T"]
        o, l, c = b["open"].to_numpy(), b["low"].to_numpy(), b["close"].to_numpy()
        t = int(r["sig_i"])
        e = t + 1
        if e >= len(b) or b.index[e] < START:
            continue
        entry = o[e]
        cancel = entry <= r["low"]
        risk_ps = entry - r["low"]
        ex_i = min(e + 9, len(b) - 1)
        ex_px = c[ex_i]
        for j in range(e, min(e + 9, len(b) - 1) + 1):
            if c[j] < r["low"]:
                if j + 1 < len(b):
                    ex_i, ex_px = j + 1, o[j + 1]
                else:
                    ex_i, ex_px = j, c[j]
                break
        cand.append(dict(code=r["code"], sig=r["sig"], vmult=r["vmult"], entry=b.index[e], exit=b.index[ex_i], px=entry,
                         risk_ps=risk_ps, cancel=cancel, ret=(ex_px / entry - 1) * 100 - cost))
    cdf = pd.DataFrame(cand)
    if cdf.empty:
        return [], 0, 0
    cdf = cdf.sort_values(["sig", "vmult"], ascending=[True, False])
    cdf = cdf.groupby("sig").head(top)  # 前の晩の表は最大3つ
    n_cancel = int(cdf["cancel"].sum())
    cdf = cdf[~cdf["cancel"]]
    out, held, n_full = [], [], 0
    for _, r in cdf.sort_values("entry").iterrows():
        held = [p for p in held if p["exit"] > r["entry"]]
        shares = int(R_YEN / r["risk_ps"] // 100 * 100)
        notional = min(shares * r["px"], MAX_ONE)
        shares = int(notional / r["px"] // 100 * 100)
        if shares < 100:
            continue
        notional = shares * r["px"]
        if sum(p["notional"] for p in held) + notional > MAX_TOTAL:
            n_full += 1
            continue
        held.append(dict(exit=r["exit"], notional=notional))
        yen = notional * r["ret"] / 100
        out.append(dict(型="窓買い", code=r["code"], entry=r["entry"], exit=r["exit"], yen=yen, R=yen / R_YEN))
    return out, n_cancel, n_full


def month_table(tr: pd.DataFrame, months: pd.PeriodIndex) -> pd.DataFrame:
    tr = tr.assign(月=tr["exit"].dt.to_period("M"), 入月=tr["entry"].dt.to_period("M"))
    cnt = tr.groupby(["入月", "型"]).size().unstack(fill_value=0).reindex(months, fill_value=0)
    pnl = tr.groupby("月")["yen"].sum().reindex(months, fill_value=0)
    m = pd.DataFrame(index=months)
    for k in ("G7", "窓買い"):
        m[f"{k}回数"] = cnt[k] if k in cnt else 0
    m["合計回数"] = m["G7回数"] + m["窓買い回数"]
    m["損益"] = pnl.round(0).astype(int)
    return m


def summarize(name: str, m: pd.DataFrame, tr: pd.DataFrame) -> dict:
    eq = m["損益"].cumsum()
    dd = (eq - eq.cummax()).min()
    last12 = m.iloc[-12:]
    return dict(案=name, 月数=len(m), 月の平均回数=round(m["合計回数"].mean(), 1),
                入れない月=int((m["合計回数"] == 0).sum()), 回数3回以下の月=int((m["合計回数"] <= 3).sum()),
                月の平均損益=int(m["損益"].mean()), 月の真ん中=int(m["損益"].median()), プラスの月=f"{(m['損益'] > 0).mean() * 100:.0f}%",
                一番悪い月=int(m["損益"].min()), 一番良い月=int(m["損益"].max()), 最大の落ち込み=int(dd),
                直近12か月の合計=int(last12["損益"].sum()), 平均R=round(tr["R"].mean(), 3) if len(tr) else None,
                G7平均R=round(tr[tr["型"] == "G7"]["R"].mean(), 3) if (tr["型"] == "G7").any() else None,
                窓買い平均R=round(tr[tr["型"] == "窓買い"]["R"].mean(), 3) if (tr["型"] == "窓買い").any() else None)


def tbl(df: pd.DataFrame) -> str:
    if df.empty:
        return "（なし）\n"
    cols = list(df.columns)
    s = "| " + " | ".join(map(str, cols)) + " |\n|" + "---|" * len(cols) + "\n"
    for _, r in df.fillna("").iterrows():
        s += "| " + " | ".join(str(r[c]) for c in cols) + " |\n"
    return s


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--universe", default="大型108")
    ap.add_argument("--period", default="8y")
    a = ap.parse_args()
    codes = UNIV["大型108"]
    syms = [f"{c}.T" for c in codes] + ["1321.T"]
    data = download(syms, a.period)
    if "1321.T" not in data:
        data.update(download(["1321.T"], a.period))
    nk = fix_nk(data["1321.T"])
    ma = nk["close"].rolling(75).mean()
    nk_up75 = (nk["close"] > ma).astype(float).where(ma.notna()).shift(1)
    nk_below75 = (nk["close"] < ma).astype(float).where(ma.notna()).shift(1)
    days = nk.index[nk.index >= START]
    months = pd.period_range(days[0], days[-1], freq="M")

    variants = [("基本（G7＋窓買い・地合いあり・表は3つまで）", dict(g7s=False, mkt=True, top=3)),
                ("G7は銘柄も75日線の下だけ", dict(g7s=True, mkt=True, top=3)),
                ("窓買いの地合いなし", dict(g7s=False, mkt=False, top=3)),
                ("表を5つまで", dict(g7s=False, mkt=True, top=5))]
    md = f"## 前の晩の表＋朝は照らすだけ（大型108・{START:%Y-%m}〜{days[-1]:%Y-%m-%d}・1R=5万円固定）\n\n"
    sigs = {m: gap_buy_signals(data, codes, nk_up75, m) for m in (True, False)}
    OUT.mkdir(parents=True, exist_ok=True)
    base_month = None
    for cost in (0.3, 0.1):
        rows, extra = [], []
        for name, v in variants:
            g7 = g7_trades(data, codes, nk_below75, v["g7s"], cost)
            gb, n_cancel, n_full = gap_buy_trades(data, sigs[v["mkt"]], cost, v["top"])
            tr = pd.DataFrame(g7 + gb)
            m = month_table(tr, months)
            rows.append(summarize(name, m, tr))
            extra.append(dict(案=name, 窓買いの取り消し=n_cancel, 持ちすぎで見送り=n_full))
            if cost == 0.3 and base_month is None:
                base_month, base_tr = m, tr
                tr.to_csv(OUT / "morning_plan_trades.csv", index=False, encoding="utf-8-sig")
                m.to_csv(OUT / "morning_plan_months.csv", encoding="utf-8-sig")
        md += f"### コスト往復{cost}%\n" + tbl(pd.DataFrame(rows)) + "\n" + tbl(pd.DataFrame(extra)) + "\n"
    yr = base_month.assign(年=base_month.index.year).groupby("年").agg(
        G7回数=("G7回数", "sum"), 窓買い回数=("窓買い回数", "sum"), 入れない月=("合計回数", lambda s: int((s == 0).sum())),
        損益=("損益", "sum"), プラスの月=("損益", lambda s: int((s > 0).sum()))).reset_index()
    md += "### 基本・コスト0.3%: 年ごと\n" + tbl(yr) + "\n"
    md += "### 基本・コスト0.3%: 月ごと\n" + tbl(base_month.reset_index().rename(columns={"index": "月"}).assign(月=lambda x: x["月"].astype(str)))
    print(md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(md + "\n")


if __name__ == "__main__":
    main()
