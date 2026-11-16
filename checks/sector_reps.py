"""各セクターの代表銘柄のうち「前夜の米国で寄りを読み、朝の注文だけで完結する」やり方に合う銘柄を選ぶ（11/16 ユーザー質問）。
GitHub Actions の「heavy-check」から手動で動かす。結果は Summary（表）と成果物（CSV）。コミットはしない。

連動先は業種の理屈で先に決め、数字は確かめるだけにする（後付けで探さない）。
銘柄ごとに出すもの:
  値幅%   直近1年の (高値-安値)/前日終値 の平均（ボラ）
  売買代金 直近1年の 終値×出来高 の平均（億円）
  連動先が大きく動いた夜（過去250日の上位・下位10%、先読みなし）の 窓% と 寄り→引け%（コスト前。候補は平均の絶対値0.3%以上＝コスト0.3%を払っても残る）
寄り→引けが t値±2 以上で前半（〜2023）・後半（2024〜）とも同じ向き＝「朝の寄りで入れる」候補。
窓は大きいのに寄り→引けが0なら、寄りで織り込み済み（読んでも取れない）。
"""

from __future__ import annotations

import argparse
import os

import numpy as np
import pandas as pd

from linkage import band, driver_move, prev_night
from week_flow import OUT, download, stats

# (セクター, 銘柄, 呼び名, [(連動先, 呼び名, 差で見るか)])
REPS = [
    ("電気機器・装置", "6857", "アドテスト", [("NVDA", "エヌビディア", False), ("^SOX", "SOX", False)]),
    ("電気機器・装置", "8035", "東エレク", [("^SOX", "SOX", False), ("AMAT", "アプライド", False)]),
    ("電気機器・後工程", "4062", "イビデン", [("INTC", "インテル", False), ("^SOX", "SOX", False)]),
    ("電気機器・部品", "6981", "村田製作所", [("AAPL", "アップル", False), ("^SOX", "SOX", False)]),
    ("非鉄・電線", "5801", "古河電工", [("VRT", "バーティブ", False), ("GLW", "コーニング", False)]),
    ("非鉄・電線", "5803", "フジクラ", [("VRT", "バーティブ", False), ("GLW", "コーニング", False)]),
    ("小売", "9983", "ファストリ", [("XRT", "米小売株", False), ("^IXIC", "ナスダック", False)]),
    ("情報通信", "9984", "ソフトバンクG", [("ARM", "ARM", False), ("^IXIC", "ナスダック", False)]),
    ("機械・防衛", "7011", "三菱重工", [("RHM.DE", "ラインメタル", False), ("ITA", "米防衛株", False)]),
    ("機械", "6301", "コマツ", [("CAT", "キャタピラー", False), ("HG=F", "銅", False)]),
    ("輸送用機器・防衛", "7012", "川崎重工", [("RHM.DE", "ラインメタル", False), ("ITA", "米防衛株", False)]),
    ("化学・半導体材料", "4004", "レゾナック", [("^SOX", "SOX", False)]),
    ("化学", "4063", "信越化学", [("^SOX", "SOX", False)]),
    ("精密機器", "7741", "HOYA", [("^SOX", "SOX", False)]),
    ("医薬品", "4568", "第一三共", [("AZN", "アストラゼネカ", False), ("XBI", "米バイオ株", False)]),
    ("医薬品", "4519", "中外製薬", [("LLY", "イーライリリー", False), ("XBI", "米バイオ株", False)]),
    ("不動産", "8830", "住友不動産", [("^TNX", "米10年金利", True), ("ITB", "米住宅建設株", False)]),
    ("建設・住宅", "1911", "住友林業", [("ITB", "米住宅建設株", False)]),
    ("商社", "8031", "三井物産", [("HG=F", "銅", False), ("CL=F", "原油", False)]),
    ("銀行", "8306", "三菱UFJ", [("^TNX", "米10年金利", True), ("KBE", "米銀行株", False)]),
    ("鉱業・石油", "1605", "INPEX", [("CL=F", "原油", False)]),
    ("海運", "9101", "日本郵船", [("ZIM", "ZIM", False)]),
    ("鉄鋼", "5401", "日本製鉄", [("SLX", "米鉄鋼株", False)]),
    ("自動車", "7203", "トヨタ", [("JPY=X", "ドル円", False), ("^GSPC", "S&P500", False)]),
    ("サービス", "6098", "リクルート", [("^IXIC", "ナスダック", False)]),
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--universe", default="", help="使わない（heavy-check の入力に合わせるだけ）")
    ap.add_argument("--period", default="6y")
    a = ap.parse_args()
    drivers = sorted({d for r in REPS for d, _, _ in r[3]})
    stocks = sorted({r[1] for r in REPS})
    syms = drivers + [f"{c}.T" for c in stocks]
    data = download(syms, a.period)
    for s in syms:
        if s not in data:
            data.update(download([s], a.period))

    rows, brief = [], []
    for sector, code, name, drv in REPS:
        b = data.get(f"{code}.T")
        if b is None:
            brief.append(dict(セクター=sector, 銘柄=f"{code} {name}", 値幅="取れず"))
            continue
        last = b[b.index >= b.index[-1] - pd.Timedelta(days=365)]
        rng = ((last["high"] - last["low"]) / last["close"].shift(1) * 100).mean()
        tv = (last["close"] * last["volume"]).mean() / 1e8
        days = b.index
        gap = (b["open"] / b["close"].shift(1) - 1) * 100
        oc = (b["close"] / b["open"] - 1) * 100
        ok = (gap.abs() < 30) & (oc.abs() < 30) & gap.notna() & oc.notna()
        d = pd.Series(days, index=days)
        best = []
        for dsym, dname, diff in drv:
            if dsym not in data:
                rows.append(dict(セクター=sector, 銘柄=f"{code} {name}", 連動先=dname, 夜="取れず"))
                continue
            mv = prev_night(driver_move(data[dsym]["close"], diff), days)
            bd = band(mv)
            corr = pd.concat([mv, gap], axis=1).dropna().corr().iloc[0, 1]
            for label, m in (("大きく上げた夜", bd == 1), ("大きく下げた夜", bd == -1)):
                m = m & ok
                st = stats(oc[m], d[m])  # コスト前（売りにも使うため）
                rows.append(dict(セクター=sector, 銘柄=f"{code} {name}", 連動先=dname, 窓との相関=round(corr, 2), 夜=label,
                                 窓の平均=round(gap[m].mean(), 2) if m.any() else None,
                                 **{f"寄り→引け_{k}": v for k, v in st.items()}))
                t, e, l = st.get("t値", 0), st.get("前半"), st.get("後半")
                if st.get("日数", 0) >= 20 and e is not None and l is not None and abs(t) >= 2 and abs(st["日ごと平均"]) >= 0.3 and np.sign(e) == np.sign(l) == np.sign(t):
                    side = "寄りで買い" if t > 0 else "寄りで売り"
                    best.append(f"{dname}{label[:4]}→{side} {st['日ごと平均']:+.2f}%（t{t:+.1f}）")
        brief.append(dict(セクター=sector, 銘柄=f"{code} {name}", 値幅=f"{rng:.2f}%", 売買代金=f"{tv:.0f}億",
                          朝に取れる読み="／".join(best) if best else "なし（窓で織り込み済み）"))

    df, bf = pd.DataFrame(rows), pd.DataFrame(brief)
    OUT.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT / "sector_reps.csv", index=False, encoding="utf-8-sig")
    bf.to_csv(OUT / "sector_reps_brief.csv", index=False, encoding="utf-8-sig")

    def tbl(x: pd.DataFrame) -> str:
        cols = list(x.columns)
        s = "| " + " | ".join(cols) + " |\n|" + "---|" * len(cols) + "\n"
        for _, r in x.fillna("").iterrows():
            s += "| " + " | ".join(str(r[c]) for c in cols) + " |\n"
        return s

    md = "## セクター代表銘柄: ボラと「前夜の米国で朝に取れる読み」\n\n" + tbl(bf) + "\n### くわしく\n" + tbl(df.drop(columns=["寄り→引け_回数"], errors="ignore"))
    print(md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(md + "\n")


if __name__ == "__main__":
    main()
