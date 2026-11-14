"""局面ログの「機械のラベル」を過去6年の毎朝に当てはめて、ラベルごとにその日の値動きを測る。
GitHub Actions の「heavy-check」から手動で動かす。結果は Summary（表）と成果物（CSV）。コミットはしない。

朝7:45に分かる数字だけを使う（同じ日付の米国の値は使わない＝前夜までの値）。
  SOX: 前夜の騰落%、前夜の終値が75日線の上か
  VIX: 前夜の値の過去252日の中での位置（0=一番低い 1=一番高い）
  CME窓: 前夜の日経先物（Yahoo の NIY=F 円建て）の終値 ÷ 前日の日経平均の終値 - 1
  TOPIX: TOPIX連動ETF(1306)の前日の終値が75日線の上か
ラベル（局面ログ.gs と同じ決め事。ただし日経VIは Yahoo に無いので VIX だけで判定）
  恐怖     VIXの位置0.9以上 か CME窓-2%以下
  油断     VIXの位置0.1以下 かつ SOXが75日線の上
  リスクオン SOXが75日線の上 かつ CME窓-1%より上
  リスクオフ それ以外
測る値動き（どれも買いの向き。コスト0.1%込み）
  TOPIX(1306)・日経(1321)・AI半導体8の平均 の その日の寄り→引け
  AI半導体8の平均 の 寄り→3日目の引け（E037 恐怖の朝3日買い と同じ持ち方）
比べる基準: ラベルなしの全部の日。ラベルが値動きを分けているか（差があるか）を見る。
注意: NIY=F の日足の終値は CME の清算値に近く、朝7:45の気配とは少しずれる。
"""

from __future__ import annotations

import argparse
import os

import numpy as np
import pandas as pd

from week_flow import COST, OUT, UNIV, download, stats


def prev_us(s: pd.Series, days: pd.DatetimeIndex) -> pd.Series:
    """東京の日付 d の前夜（d より前の最後の米国の営業日）の値"""
    s = s.dropna()
    return s.reindex(s.index.union(days)).sort_index().shift(1).ffill().reindex(days)


def build(data: dict[str, pd.DataFrame]) -> pd.DataFrame:
    topix, n225 = data["1306.T"], data["^N225"]
    days = topix.index
    sox, vix, cme = data["^SOX"]["close"], data["^VIX"]["close"], data["NIY=F"]["close"]

    sox_chg = prev_us(sox.pct_change() * 100, days)
    sox_up = prev_us((sox > sox.rolling(75).mean()).where(sox.rolling(75).count() == 75), days)
    vix_pct = prev_us(vix.rolling(252).rank(pct=True), days)
    n225_prev = n225["close"].shift(1).reindex(days)
    cme_gap = (prev_us(cme, days) / n225_prev - 1) * 100
    tc = topix["close"]
    topix_up = ((tc > tc.rolling(75).mean()).where(tc.rolling(75).count() == 75)).shift(1).reindex(days)

    ev = pd.DataFrame(dict(soxChg=sox_chg, soxUp=sox_up, vixPct=vix_pct, cmeGap=cme_gap, topixUp=topix_up), index=days)

    def oc(df: pd.DataFrame) -> pd.Series:
        return ((df["close"] / df["open"] - 1) * 100).reindex(days)

    def o3(df: pd.DataFrame) -> pd.Series:
        return ((df["close"].shift(-2) / df["open"] - 1) * 100).reindex(days)

    ev["TOPIX"] = oc(topix)
    if "1321.T" in data:
        ev["日経"] = oc(data["1321.T"])
    ai = [data[f"{c}.T"] for c in UNIV["AI半導体"] if f"{c}.T" in data]
    ev["AI半導体"] = pd.concat([oc(b) for b in ai], axis=1).mean(axis=1)
    ev["AI半導体3日"] = pd.concat([o3(b) for b in ai], axis=1).mean(axis=1)

    ok = ev[["soxUp", "vixPct", "cmeGap"]].notna().all(axis=1)
    ev = ev[ok].copy()
    fear = (ev["vixPct"] >= 0.9) | (ev["cmeGap"] <= -2)
    calm = (ev["vixPct"] <= 0.1) & (ev["soxUp"] == True)  # noqa: E712
    on = (ev["soxUp"] == True) & (ev["cmeGap"] > -1)  # noqa: E712
    ev["ラベル"] = np.select([fear, calm, on], ["恐怖", "油断", "リスクオン"], "リスクオフ")
    return ev


def table(ev: pd.DataFrame) -> pd.DataFrame:
    rows = []
    d = pd.Series(ev.index, index=ev.index)
    targets = [c for c in ("TOPIX", "日経", "AI半導体", "AI半導体3日") if c in ev]
    groups = [("全部の日（基準）", ev.index == ev.index)] + [(lab, ev["ラベル"] == lab) for lab in ("リスクオン", "油断", "リスクオフ", "恐怖")]
    groups += [("リスクオフ かつ TOPIXが75日線の下（G7の出番）", (ev["ラベル"] == "リスクオフ") & (ev["topixUp"] == False))]  # noqa: E712
    for tgt in targets:
        base = ev[tgt].dropna().mean()
        for name, mask in groups:
            r = ev.loc[mask, tgt].dropna()
            st = stats(r - COST, d.loc[r.index])
            rows.append(dict(測る値動き=tgt + ("（寄り→3日目の引け）" if tgt.endswith("3日") else "（寄り→引け）"),
                             ラベル=name, 基準との差=round(r.mean() - base, 3) if len(r) else None, **st))
    return pd.DataFrame(rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--universe", default="AI半導体", help="使わない（heavy-check の入力に合わせるだけ）")
    ap.add_argument("--period", default="6y")
    a = ap.parse_args()
    syms = ["^SOX", "^VIX", "NIY=F", "^N225", "1306.T", "1321.T"] + [f"{c}.T" for c in UNIV["AI半導体"]]
    data = download(syms, a.period)
    for s in syms:  # まとめて取ると yfinance の一時保存が詰まって落ちる記号があるので、1つずつ取り直す
        if s not in data:
            data.update(download([s], a.period))
    miss = [s for s in ("^SOX", "^VIX", "NIY=F", "^N225", "1306.T") if s not in data]
    if miss:
        raise SystemExit(f"取れなかった記号: {miss}")
    ev = build(data)
    df = table(ev)
    OUT.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT / "kyokumen_bt.csv", index=False, encoding="utf-8-sig")
    ev.to_csv(OUT / "kyokumen_bt_days.csv", encoding="utf-8-sig")
    cnt = ev["ラベル"].value_counts()
    md = f"## 局面ラベルを過去に当てはめた結果 {ev.index.min():%Y-%m-%d}〜{ev.index.max():%Y-%m-%d} {len(ev)}日\n\n"
    md += "ラベルの日数: " + "、".join(f"{k} {v}日" for k, v in cnt.items()) + "\n\n"
    md += "損益%は買いの向き・コスト0.1%込み。基準との差＝そのラベルの日の平均−全部の日の平均（マイナスが大きく t値も大きくマイナスなら売り向きの日）。前半は〜2023、後半は2024〜。\n\n"
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
