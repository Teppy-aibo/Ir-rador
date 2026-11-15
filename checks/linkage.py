"""銘柄ごとの「前夜の連動先」が大きく動いた朝、日本株の寄りの窓と寄り→引けがどうなるかを日足6年分で測る。
GitHub Actions の「heavy-check」から手動で動かす。結果は Summary（表）と成果物（CSV）。コミットはしない。

考え方（イビデン×インテルの拡張）: 業種の理屈で前夜の連動先を先に決め、数字は確かめるだけにする（後付けで探さない）。
  銀行（三菱UFJ・三井住友・みずほ） ← 米10年金利（^TNX の前日差。利ざやが広がる＝上げの向き）
  商社（三井物産・三菱商事・伊藤忠・住友商事） ← 原油(CL=F)・銅(HG=F)
  住宅（住友林業・積水ハウス） ← 米住宅建設株ETF(ITB)（米国の売上が大きい）
  ソフトバンクG ← ARM・ナスダック総合(^IXIC)
  装置（アドテスト・東エレク） ← エヌビディア(NVDA)・SOX
  防衛（三菱重工・川崎重工・IHI） ← 米防衛株ETF(ITA)・ラインメタル(RHM.DE)
  イビデン ← インテル(INTC)・SOX（すでに確かめた組。比べるため）
連動先の「前夜」= 東京の日付より前の最後の取引日の終値の騰落（ドイツ株は東京の朝の前に引けている）。
大きく動いた夜 = その連動先の過去250日の騰落の上位10%・下位10%（毎日その時点までの値で決める＝先読みなし）。
測る値: 窓（前日終値→寄り）、寄り→引け（コスト0.1%込み、買いの向き）、
        日経（1321）の同じ日の寄り→引けとの差（相場全体で動いただけかを除く）。
寄り→引けの t値が大きくプラスなら「寄りで買う」、大きくマイナスなら「寄りで売る」候補。窓だけ大きく寄り→引けが0なら、寄りで織り込み済み。
判定の欄は買いの向きだけを見る。売りの候補は t値が -2 以下で前半・後半ともマイナスの行（売りはコスト分さらに不利）。
"""

from __future__ import annotations

import argparse
import os

import numpy as np
import pandas as pd

from week_flow import COST, OUT, download, stats

GROUPS = [
    # (名前, 主役の銘柄, 同じ業種の仲間, [(連動先の記号, 呼び名, 差で見るか)])
    ("銀行", "8306", ["8316", "8411"], [("^TNX", "米10年金利", True)]),
    ("商社", "8031", ["8058", "8001", "8053"], [("CL=F", "原油", False), ("HG=F", "銅", False)]),
    ("住宅", "1911", ["1928"], [("ITB", "米住宅建設株", False)]),
    ("ソフトバンクG", "9984", [], [("ARM", "ARM", False), ("^IXIC", "ナスダック", False)]),
    ("装置", "6857", ["8035"], [("NVDA", "エヌビディア", False), ("^SOX", "SOX", False)]),
    ("防衛", "7011", ["7012", "7013"], [("ITA", "米防衛株", False), ("RHM.DE", "ラインメタル", False)]),
    ("イビデン", "4062", [], [("INTC", "インテル", False), ("^SOX", "SOX", False)]),
]
NAMES = {"8306": "三菱UFJ", "8316": "三井住友", "8411": "みずほ", "8031": "三井物産", "8058": "三菱商事", "8001": "伊藤忠",
         "8053": "住友商事", "1911": "住友林業", "1928": "積水ハウス", "9984": "ソフトバンクG", "6857": "アドテスト",
         "8035": "東エレク", "7011": "三菱重工", "7012": "川崎重工", "7013": "IHI", "4062": "イビデン"}


def prev_night(s: pd.Series, days: pd.DatetimeIndex) -> pd.Series:
    """東京の日付 d より前の最後の取引日の値（同じ日付の海外の値は使わない）"""
    s = s.dropna()
    return s.reindex(s.index.union(days)).sort_index().shift(1).ffill().reindex(days)


def driver_move(close: pd.Series, diff: bool) -> pd.Series:
    return close.diff() if diff else close.pct_change() * 100


def band(x: pd.Series) -> pd.Series:
    """その日の値が、それまでの250日の中で上位10%なら1、下位10%なら-1、それ以外0（先読みなし）"""
    hi = x.shift(1).rolling(250, min_periods=120).quantile(0.9)
    lo = x.shift(1).rolling(250, min_periods=120).quantile(0.1)
    out = pd.Series(0, index=x.index, dtype=float)
    out[x >= hi] = 1
    out[x <= lo] = -1
    out[hi.isna()] = np.nan
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--universe", default="AI半導体", help="使わない（heavy-check の入力に合わせるだけ）")
    ap.add_argument("--period", default="6y")
    a = ap.parse_args()
    drivers = sorted({d for g in GROUPS for d, _, _ in g[3]})
    stocks = sorted({s for g in GROUPS for s in [g[1], *g[2]]}) + ["1321"]
    syms = drivers + [f"{c}.T" for c in stocks]
    data = download(syms, a.period)
    for s in syms:  # まとめて取ると落ちる記号があるので1つずつ取り直す
        if s not in data:
            data.update(download([s], a.period))
    if "1321.T" not in data:
        raise SystemExit("日経ETF(1321)が取れませんでした")
    nk = data["1321.T"]
    nk_oc = nk["close"] / nk["open"] - 1

    rows = []
    for gname, main_code, peers, drv in GROUPS:
        for dsym, dname, diff in drv:
            if dsym not in data:
                rows.append(dict(業種=gname, 連動先=dname, 銘柄="", 夜="取れず"))
                continue
            for code in [main_code, *peers]:
                b = data.get(f"{code}.T")
                if b is None:
                    continue
                days = b.index
                mv = prev_night(driver_move(data[dsym]["close"], diff), days)
                bd = band(mv)
                gap = (b["open"] / b["close"].shift(1) - 1) * 100
                oc = (b["close"] / b["open"] - 1) * 100
                rel = oc - nk_oc.reindex(days) * 100
                ok = (gap.abs() < 30) & (oc.abs() < 30)  # Yahoo の値の誤りを除く
                d = pd.Series(days, index=days)
                for label, m in (("全部の夜", bd.notna()), ("大きく上げた夜", bd == 1), ("大きく下げた夜", bd == -1)):
                    m = m & ok & gap.notna() & oc.notna()
                    st = stats(oc[m] - COST, d[m])
                    rows.append(dict(
                        業種=gname, 連動先=dname, 銘柄=f"{code} {NAMES.get(code, '')}", 主役="◯" if code == main_code else "",
                        夜=label, 連動先の平均=round(mv[m].mean(), 2) if m.any() else None,
                        窓の平均=round(gap[m].mean(), 2) if m.any() else None,
                        窓が同じ向き=round(((np.sign(gap[m]) == np.sign(mv[m])).mean()) * 100) if m.any() and label != "全部の夜" else None,
                        日経との差=round(rel[m].mean(), 3) if m.any() else None,
                        **{f"寄り→引け_{k}": v for k, v in st.items()},
                    ))
    df = pd.DataFrame(rows)
    OUT.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT / "linkage.csv", index=False, encoding="utf-8-sig")
    md = "## 銘柄ごとの前夜の連動先（大きく動いた夜＝その連動先の過去250日の上位・下位10%）\n\n"
    md += "窓=前日終値→寄り%、窓が同じ向き=連動先と同じ向きに窓を開けた割合%、寄り→引けはコスト0.1%込み・買いの向き（判定も買いだけ。t値が-2以下で前半・後半ともマイナスなら売りの候補）。日経との差=同じ日の日経ETFの寄り→引けを引いた値。\n\n"
    cols = [c for c in df.columns if c not in ("寄り→引け_回数",)]
    md += "| " + " | ".join(cols) + " |\n|" + "---|" * len(cols) + "\n"
    for _, row in df.fillna("").iterrows():
        md += "| " + " | ".join(str(row[k]) for k in cols) + " |\n"
    print(md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(md + "\n")


if __name__ == "__main__":
    main()
