"""「自分で負けを調べて直し続ける仕組み」が、直さない場合より残高を増やせるかを、過去にさかのぼって確かめる（11/16 ユーザー案）。
GitHub Actions の「heavy-check」から手動で動かす。結果は Summary（表）と成果物（CSV）。コミットはしない。

元手100万円・信用あり（建玉は残高の3.3倍まで）・100株単位・1回の損切り＝残高の2%から株数を逆算。
大型108銘柄の日足（8年取って、最初の約2年は準備だけ）。2021年7月から売買を始める。

型（どれも日足で決められるもの）
  G7     前日比+8%以上の窓で寄りに売り。損切り+2%・利確-4%（2R）・どちらもなければ引けで買い戻し
  窓買い  前日比+gmin以上の窓・出来高が20日平均のvm倍以上・引け位置cp以上の日の引けで買い。損切り＝その日の安値（終値で割ったら翌朝の寄りで売り）、hold日目の引けで手じまい
         （決算の日かは区別していない＝H2の代わり）
  連動売り 前夜の銅・原油・米住宅株・ラインメタルが過去250日の下位bandなら、連動する銘柄を寄りで売り・引けで買い戻し（損切り+2%）
  恐怖買い 前夜のVIXが過去252日の上位（thr以上）なら、AI半導体を寄りで買い・hold日目の引けで売り（損切り-5%）
どの決め事も、その日までの値だけで決める（先読みなし）。コストは1回0.1%。

負けの理由（機械で付ける札）
  地合い   持っている間に日経ETFが逆に1%以上動いた
  逆張り   買いなのに75日線の下・売りなのに75日線の上
  飛び越え  損切りを越えて-1.2Rより悪く終わった（窓で飛ばされた）
  大きい窓  窓が12%以上
直す仕組み（毎週はじめ）
  1. 型ごとに、直近13週の負けの札を数える。一番多い札に効くつまみ（例: 地合い→日経が75日線の上/下の条件）を1つずつ動かした案を作る
  2. 直近2年の成績を前半・後半に分け、両方で今の決め事より平均Rが0.05以上良く、どちらも8回以上ある案だけ採用
  3. 直近1年の平均Rがマイナス（15回以上）の型は止める。止めた型は、直近2年の前半・後半とも平均+0.1R以上に戻ったら再開
比べる相手: 最初の決め事のまま何も直さない口座
"""

from __future__ import annotations

import argparse
import itertools
import os

import numpy as np
import pandas as pd

from week_flow import OUT, UNIV, download

COST = 0.1  # %
START_CASH = 1_000_000
RISK = 0.02
LEV = 3.3
SIM_START = pd.Timestamp("2021-07-01")
AI = ["6857", "8035", "6920", "6146", "4062", "5801", "5803"]
LINKS = [("HG=F", ["8031", "8053", "8058", "8001"]), ("CL=F", ["8031", "8058"]),
         ("ITB", ["1911", "1928"]), ("RHM.DE", ["7012", "7013"])]

KNOBS = {
    "G7": {"upper": [0.12, 0.16, 0.20], "below75": [0, 1], "mkt": [0, 1]},
    "窓買い": {"gmin": [0.03, 0.05, 0.08], "vm": [1.5, 2.0, 3.0], "cp": [0.5, 0.7], "ma200": [0, 1], "mkt": [0, 1], "hold": [5, 10, 20]},
    "連動売り": {"band": [0.10, 0.05]},
    "恐怖買い": {"thr": [0.90, 0.95], "hold": [1, 3, 5]},
}
DEFAULT = {"G7": {"upper": 0.20, "below75": 0, "mkt": 0},
           "窓買い": {"gmin": 0.05, "vm": 2.0, "cp": 0.5, "ma200": 0, "mkt": 0, "hold": 10},
           "連動売り": {"band": 0.10}, "恐怖買い": {"thr": 0.90, "hold": 3}}
# 負けの札 → 動かすつまみ
FIX = {"G7": {"地合い": ["mkt"], "逆張り": ["below75"], "飛び越え": ["upper"], "大きい窓": ["upper"]},
       "窓買い": {"地合い": ["mkt"], "逆張り": ["ma200"], "飛び越え": ["cp", "gmin"], "大きい窓": ["vm", "gmin"]},
       "連動売り": {"地合い": ["band"], "逆張り": ["band"], "飛び越え": ["band"], "大きい窓": ["band"]},
       "恐怖買い": {"地合い": ["thr", "hold"], "逆張り": ["thr"], "飛び越え": ["hold"], "大きい窓": ["thr"]}}
PRIORITY = ["G7", "連動売り", "恐怖買い", "窓買い"]


def prev_night(s: pd.Series, days: pd.DatetimeIndex) -> pd.Series:
    s = s.dropna()
    return s.reindex(s.index.union(days)).sort_index().shift(1).ffill().reindex(days)


def tag(side: int, R: float, gap: float, trend_against: bool, mkt_ret: float) -> list[str]:
    t = []
    if side * mkt_ret <= -1:
        t.append("地合い")
    if trend_against:
        t.append("逆張り")
    if R < -1.2:
        t.append("飛び越え")
    if abs(gap) >= 0.12:
        t.append("大きい窓")
    return t


def build_trades(data: dict[str, pd.DataFrame], codes: list[str]) -> dict[str, pd.DataFrame]:
    """型ごとに、つまみに使う特徴と結果を全部持った売買の候補を作る（設定はあとで行を選ぶだけ）"""
    nk = data["1321.T"]
    nk_up75 = (nk["close"] > nk["close"].rolling(75).mean()).shift(1)  # 前日までに分かる
    vix = data["^VIX"]["close"]
    out = {k: [] for k in KNOBS}
    for code in codes:
        b = data.get(f"{code}.T")
        if b is None or len(b) < 300:
            continue
        o, h, l, c, v = (b[k].to_numpy() for k in ("open", "high", "low", "close", "volume"))
        d = b.index
        ma75 = b["close"].rolling(75).mean().to_numpy()
        ma200 = b["close"].rolling(200).mean().to_numpy()
        v20 = b["volume"].rolling(20).mean().shift(1).to_numpy()
        nko = nk["open"].reindex(d).to_numpy()
        nkc = nk["close"].reindex(d).to_numpy()
        up75 = nk_up75.reindex(d).to_numpy()
        n = len(b)
        for t in range(201, n):
            gap = o[t] / c[t - 1] - 1
            if abs(gap) > 0.3 or not np.isfinite(gap):
                continue
            mk = (nkc[t] / nko[t] - 1) * 100 if np.isfinite(nkc[t]) and np.isfinite(nko[t]) else 0.0
            # G7（売り）
            if 0.08 <= gap < 0.20:
                if h[t] >= o[t] * 1.02:
                    ret = -2.0
                elif l[t] <= o[t] * 0.96:
                    ret = 4.0
                else:
                    ret = -(c[t] / o[t] - 1) * 100
                ret -= COST
                R = ret / 2.0
                ag = bool(c[t - 1] > ma75[t - 1])
                out["G7"].append(dict(code=code, entry=d[t], exit=d[t], px=o[t], stop=2.0, side=-1, ret=ret, R=R,
                                      gap=gap, below75=int(c[t - 1] < ma75[t - 1]), mkt=int(up75[t] == False),  # noqa: E712
                                      tags=tag(-1, R, gap, ag, mk)))
            # 窓買い
            if gap >= 0.03 and v20[t] > 0 and h[t] > l[t] and t + 21 < n:
                stop_pct = (c[t] - l[t]) / c[t] * 100
                if 0.5 <= stop_pct <= 8:
                    row = dict(code=code, entry=d[t], px=c[t], stop=stop_pct, side=1, gap=gap,
                               vmult=v[t] / v20[t], cpos=(c[t] - l[t]) / (h[t] - l[t]),
                               ma200=int(c[t] > ma200[t]), mkt=int(up75[t] == True))  # noqa: E712
                    for hold in (5, 10, 20):
                        ex_i, ex_px = t + hold, c[t + hold]
                        for j in range(t + 1, t + hold + 1):
                            if c[j] < l[t]:
                                ex_i, ex_px = j + 1, o[j + 1]
                                break
                        ret = (ex_px / c[t] - 1) * 100 - COST
                        R = ret / stop_pct
                        m = (nkc[ex_i] / nkc[t] - 1) * 100 if np.isfinite(nkc[ex_i]) and np.isfinite(nkc[t]) else 0.0
                        row[f"exit{hold}"] = d[ex_i]
                        row[f"ret{hold}"] = ret
                        row[f"R{hold}"] = R
                        row[f"tags{hold}"] = tag(1, R, gap, bool(c[t] < ma75[t]), m)
                    out["窓買い"].append(row)
        # 恐怖買い（AI半導体だけ）
        if code in AI:
            vp = prev_night(vix.rolling(252).rank(pct=True), d).to_numpy()
            for t in range(201, n - 6):
                if not (vp[t] >= 0.90):
                    continue
                row = dict(code=code, entry=d[t], px=o[t], stop=5.0, side=1, gap=o[t] / c[t - 1] - 1, vix=vp[t])
                for hold in (1, 3, 5):
                    j_end = t + hold - 1
                    ex_px, ex_i = c[j_end], j_end
                    for j in range(t, j_end + 1):
                        if l[j] <= o[t] * 0.95:
                            ex_px, ex_i = min(o[j], o[t] * 0.95) if j > t else o[t] * 0.95, j
                            break
                    ret = (ex_px / o[t] - 1) * 100 - COST
                    R = ret / 5.0
                    m = (nkc[ex_i] / nko[t] - 1) * 100 if np.isfinite(nkc[ex_i]) and np.isfinite(nko[t]) else 0.0
                    row[f"exit{hold}"] = d[ex_i]
                    row[f"ret{hold}"] = ret
                    row[f"R{hold}"] = R
                    row[f"tags{hold}"] = tag(1, R, row["gap"], bool(c[t - 1] < ma75[t - 1]), m)
                out["恐怖買い"].append(row)
    # 連動売り
    for sym, cs in LINKS:
        if sym not in data:
            continue
        mv = data[sym]["close"].pct_change() * 100
        for code in cs:
            b = data.get(f"{code}.T")
            if b is None:
                continue
            d = b.index
            x = prev_night(mv, d)
            q10 = x.shift(1).rolling(250, min_periods=120).quantile(0.10)
            q05 = x.shift(1).rolling(250, min_periods=120).quantile(0.05)
            o, h, c = b["open"], b["high"], b["close"]
            ma75 = c.rolling(75).mean()
            nko, nkc = nk["open"].reindex(d), nk["close"].reindex(d)
            for t in np.where((x <= q10).to_numpy())[0]:
                if t < 1:
                    continue
                gap = o.iloc[t] / c.iloc[t - 1] - 1
                if abs(gap) > 0.3:
                    continue
                ret = (-2.0 if h.iloc[t] >= o.iloc[t] * 1.02 else -(c.iloc[t] / o.iloc[t] - 1) * 100) - COST
                R = ret / 2.0
                mk = (nkc.iloc[t] / nko.iloc[t] - 1) * 100 if np.isfinite(nkc.iloc[t]) else 0.0
                out["連動売り"].append(dict(code=code, entry=d[t], exit=d[t], px=o.iloc[t], stop=2.0, side=-1, ret=ret, R=R,
                                         gap=gap, deep=int(x.iloc[t] <= q05.iloc[t]),
                                         tags=tag(-1, R, gap, bool(c.iloc[t - 1] > ma75.iloc[t - 1]), mk)))
    return {k: pd.DataFrame(v) for k, v in out.items()}


def select(fam: str, ev: pd.DataFrame, cfg: dict) -> pd.DataFrame:
    """設定に合う行を選び、entry/exit/ret/R/tags の形にそろえる"""
    if ev.empty:
        return ev
    if fam == "G7":
        m = (ev["gap"] < cfg["upper"])
        if cfg["below75"]:
            m &= ev["below75"] == 1
        if cfg["mkt"]:
            m &= ev["mkt"] == 1
        return ev[m]
    if fam == "窓買い":
        m = (ev["gap"] >= cfg["gmin"]) & (ev["vmult"] >= cfg["vm"]) & (ev["cpos"] >= cfg["cp"])
        if cfg["ma200"]:
            m &= ev["ma200"] == 1
        if cfg["mkt"]:
            m &= ev["mkt"] == 1
        k = cfg["hold"]
        s = ev[m]
        return s.assign(exit=s[f"exit{k}"], ret=s[f"ret{k}"], R=s[f"R{k}"], tags=s[f"tags{k}"])
    if fam == "連動売り":
        return ev[ev["deep"] == 1] if cfg["band"] == 0.05 else ev
    if fam == "恐怖買い":
        k = cfg["hold"]
        s = ev[ev["vix"] >= cfg["thr"]]
        return s.assign(exit=s[f"exit{k}"], ret=s[f"ret{k}"], R=s[f"R{k}"], tags=s[f"tags{k}"])
    raise ValueError(fam)


def neighbors(fam: str, cfg: dict, knobs: list[str]) -> list[dict]:
    outs = []
    for k in knobs:
        for val in KNOBS[fam][k]:
            if val != cfg[k]:
                outs.append({**cfg, k: val})
    return outs


def halves(tr: pd.DataFrame, lo: pd.Timestamp, hi: pd.Timestamp):
    """[lo, hi) に手じまいが終わった売買を前半・後半に分ける（hi 時点で結果が分かっているものだけ）"""
    s = tr[(tr["entry"] >= lo) & (tr["exit"] < hi)]
    mid = lo + (hi - lo) / 2
    return s[s["entry"] < mid]["R"], s[s["entry"] >= mid]["R"]


def simulate(trades: dict[str, pd.DataFrame], days: pd.DatetimeIndex, adaptive: bool, stop_rule: str = "1y", every: int = 1):
    """stop_rule: 1y=直近1年の平均がマイナスで止める / 2y=直近2年の前半・後半とも平均マイナスで止める。every: 何週に1回見直すか"""
    cfg = {k: dict(v) for k, v in DEFAULT.items()}
    on = {k: True for k in KNOBS}
    cache: dict[tuple, pd.DataFrame] = {}

    def get(fam, c):
        key = (fam, tuple(sorted(c.items())))
        if key not in cache:
            cache[key] = select(fam, trades[fam], c)
        return cache[key]

    cash, open_pos, curve, log, done = START_CASH, [], [], [], []
    by_day = None
    week = None
    nweek = -1
    for day in days[days >= SIM_START]:
        # 手じまい
        keep = []
        for p in open_pos:
            if p["exit"] <= day:
                pnl = p["notional"] * p["ret"] / 100
                cash += pnl
                done.append({**p, "pnl": pnl})
            else:
                keep.append(p)
        open_pos = keep
        # 週はじめの見直し
        wk = day.isocalendar()[:2]
        if wk != week:
            week = wk
            nweek += 1
            if adaptive and nweek % every == 0:
                for fam in KNOBS:
                    cur = get(fam, cfg[fam])
                    lo2, lo1 = day - pd.Timedelta(weeks=104), day - pd.Timedelta(weeks=52)
                    if on[fam]:
                        if stop_rule == "1y":
                            last = cur[(cur["entry"] >= lo1) & (cur["exit"] < day)]["R"]
                            if len(last) >= 15 and last.mean() < 0:
                                on[fam] = False
                                log.append(dict(date=day, 型=fam, 変更="止める", 理由=f"直近1年 平均{last.mean():.2f}R（{len(last)}回）"))
                                continue
                        else:
                            s1, s2 = halves(cur, lo2, day)
                            if len(s1) >= 15 and len(s2) >= 15 and s1.mean() < 0 and s2.mean() < 0:
                                on[fam] = False
                                log.append(dict(date=day, 型=fam, 変更="止める", 理由=f"直近2年 前半{s1.mean():.2f}R・後半{s2.mean():.2f}R"))
                                continue
                        recent = cur[(cur["entry"] >= day - pd.Timedelta(weeks=13)) & (cur["exit"] < day) & (cur["R"] < 0)]
                        if recent.empty:
                            continue
                        cnt = pd.Series([t for ts in recent["tags"] for t in ts]).value_counts()
                        if cnt.empty:
                            continue
                        top = cnt.index[0]
                        a1, a2 = halves(cur, lo2, day)
                        best, best_gain = None, 0.0
                        for cand in neighbors(fam, cfg[fam], FIX[fam][top]):
                            b1, b2 = halves(get(fam, cand), lo2, day)
                            if len(b1) < 8 or len(b2) < 8:
                                continue
                            g1 = b1.mean() - (a1.mean() if len(a1) else 0)
                            g2 = b2.mean() - (a2.mean() if len(a2) else 0)
                            if g1 >= 0.05 and g2 >= 0.05 and min(g1, g2) > best_gain:
                                best, best_gain = cand, min(g1, g2)
                        if best:
                            chg = ", ".join(f"{k}:{cfg[fam][k]}→{best[k]}" for k in best if best[k] != cfg[fam][k])
                            log.append(dict(date=day, 型=fam, 変更=chg, 理由=f"直近13週の負けで多い札「{top}」{int(cnt.iloc[0])}回、前後半とも+{best_gain:.2f}R以上"))
                            cfg[fam] = best
                    else:
                        b1, b2 = halves(cur, lo2, day)
                        if len(b1) >= 8 and len(b2) >= 8 and b1.mean() > 0.1 and b2.mean() > 0.1:
                            on[fam] = True
                            log.append(dict(date=day, 型=fam, 変更="再開", 理由=f"直近2年 前半{b1.mean():.2f}R・後半{b2.mean():.2f}R"))
        # 入る
        equity = cash
        gross = sum(p["notional"] for p in open_pos)
        for fam in PRIORITY:
            if not on[fam]:
                continue
            tr = get(fam, cfg[fam])
            today = tr[tr["entry"] == day]
            for _, r in today.iterrows():
                notional = min(equity * RISK / (r["stop"] / 100), equity)
                lots = int(notional // (r["px"] * 100))
                if lots < 1:
                    continue
                notional = lots * 100 * r["px"]
                if gross + notional > equity * LEV:
                    continue
                gross += notional
                open_pos.append(dict(型=fam, code=r["code"], entry=day, exit=r["exit"], notional=notional, ret=r["ret"], R=r["R"],
                                     tags=r["tags"], side=r["side"]))
        curve.append(dict(date=day, 残高=cash))
        if cash <= 0:
            break
    return pd.DataFrame(curve).set_index("date")["残高"], pd.DataFrame(log), pd.DataFrame(done), cfg, on


def summary(name: str, eq: pd.Series, done: pd.DataFrame) -> dict:
    yrs = (eq.index[-1] - eq.index[0]).days / 365.25
    dd = (eq / eq.cummax() - 1).min() * 100
    return dict(口座=name, 最後の残高=int(eq.iloc[-1]), 何倍=round(eq.iloc[-1] / START_CASH, 2),
                年率=f"{((eq.iloc[-1] / START_CASH) ** (1 / yrs) - 1) * 100:.1f}%", 最大の落ち込み=f"{dd:.1f}%",
                売買の回数=len(done), 平均R=round(done["R"].mean(), 3) if len(done) else None,
                勝率=f"{(done['pnl'] > 0).mean() * 100:.0f}%" if len(done) else None)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--universe", default="大型108")
    ap.add_argument("--period", default="8y")
    a = ap.parse_args()
    codes = UNIV["大型108"]
    extra = sorted({c for _, cs in LINKS for c in cs} | set(AI))
    codes = sorted(set(codes) | set(extra))
    syms = [f"{c}.T" for c in codes] + ["1321.T", "^VIX"] + [s for s, _ in LINKS]
    data = download(syms, a.period)
    for s in syms:
        if s not in data:
            data.update(download([s], a.period))
    if "1321.T" not in data or "^VIX" not in data:
        raise SystemExit("日経ETFかVIXが取れませんでした")
    # 日経ETFは分割で値がとぶので、前日比±15%超の日を除く（値の誤り対策）
    nk = data["1321.T"]
    jump = (nk["close"].pct_change().abs() > 0.15)
    if jump.any():
        print("日経ETFの値のとび:", list(nk.index[jump].strftime("%Y-%m-%d")))
        k = nk["close"].pct_change()[jump]
        for dt, r in k.items():  # とびの前を割り戻す
            nk.loc[nk.index < dt, ["open", "high", "low", "close"]] *= (1 + r)
    trades = build_trades(data, codes)
    for k, v in trades.items():
        print(f"{k}: 候補 {len(v)} 件")
    days = data["1321.T"].index
    eq_a, log_a, done_a, cfg_a, on_a = simulate(trades, days, adaptive=True)
    eq_f, _, done_f, _, _ = simulate(trades, days, adaptive=False)
    variants = {}
    for name, kw in (("止める基準を重く", dict(stop_rule="2y", every=1)), ("四半期に1回", dict(stop_rule="1y", every=13)),
                     ("重く＋四半期", dict(stop_rule="2y", every=13))):
        variants[name] = simulate(trades, days, adaptive=True, **kw)

    OUT.mkdir(parents=True, exist_ok=True)
    pd.DataFrame({"直す": eq_a, "直さない": eq_f, **{k: v[0] for k, v in variants.items()}}).to_csv(OUT / "self_improve_equity.csv", encoding="utf-8-sig")
    log_a.to_csv(OUT / "self_improve_log.csv", index=False, encoding="utf-8-sig")
    done_a.to_csv(OUT / "self_improve_trades_adaptive.csv", index=False, encoding="utf-8-sig")
    done_f.to_csv(OUT / "self_improve_trades_fixed.csv", index=False, encoding="utf-8-sig")

    def tbl(df: pd.DataFrame) -> str:
        if df.empty:
            return "（なし）\n"
        cols = list(df.columns)
        s = "| " + " | ".join(cols) + " |\n|" + "---|" * len(cols) + "\n"
        for _, r in df.fillna("").iterrows():
            s += "| " + " | ".join(str(r[c]) for c in cols) + " |\n"
        return s

    md = f"## 自分で直し続ける仕組み vs 直さない（元手{START_CASH:,}円・{SIM_START:%Y-%m}〜{days[-1]:%Y-%m-%d}）\n\n"
    md += tbl(pd.DataFrame([summary("直す（週1・1年で止める）", eq_a, done_a), summary("直さない", eq_f, done_f)]
                           + [summary(k, v[0], v[2]) for k, v in variants.items()]))
    for k, v in variants.items():
        lg = v[1]
        md += f"\n### {k}: 直した記録（{len(lg)}回）\n" + tbl(lg.assign(date=lg["date"].dt.strftime("%Y-%m-%d")) if len(lg) else lg)
        if len(v[2]):
            g = v[2].groupby("型").agg(回数=("R", "size"), 平均R=("R", "mean"), 損益=("pnl", "sum")).round(3).reset_index()
            g["損益"] = g["損益"].astype(int)
            md += f"\n### {k}: 型ごと\n" + tbl(g)
    for name, dn in (("直す", done_a), ("直さない", done_f)):
        if len(dn):
            g = dn.groupby("型").agg(回数=("R", "size"), 平均R=("R", "mean"), 損益=("pnl", "sum")).round(3).reset_index()
            g["損益"] = g["損益"].astype(int)
            md += f"\n### {name}: 型ごと\n" + tbl(g)
            yr = dn.groupby(dn["exit"].dt.year)["pnl"].sum().astype(int).rename("損益").reset_index()
            md += f"\n### {name}: 年ごとの損益\n" + tbl(yr)
    md += f"\n### 直した記録（{len(log_a)}回）\n" + tbl(log_a.assign(date=log_a["date"].dt.strftime("%Y-%m-%d")) if len(log_a) else log_a)
    md += "\n### 最後の決め事（直す口座）\n" + "\n".join(f"- {k}: {'使う' if on_a[k] else '止めている'} {cfg_a[k]}" for k in KNOBS) + "\n"
    lt = [t for ts in done_a[done_a["pnl"] < 0]["tags"] for t in ts] if len(done_a) else []
    md += "\n### 負けの札（直す口座）\n" + tbl(pd.Series(lt, dtype=str).value_counts().rename_axis("札").reset_index(name="回数"))
    wk = pd.DataFrame({"直す": eq_a, "直さない": eq_f, **{k: v[0] for k, v in variants.items()}}).resample("ME").last().ffill().astype(int)
    md += "\n### 月末の残高\n" + tbl(wk.reset_index().assign(date=lambda x: x["date"].dt.strftime("%Y-%m")))
    print(md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(md + "\n")


if __name__ == "__main__":
    main()
