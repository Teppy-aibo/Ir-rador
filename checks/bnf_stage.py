"""BNFの6段階（大きく動いた日の引けで買い→翌朝に売る）を日足6年分で検証する。
GitHub Actions の「heavy-check」から手動で動かす。結果は Summary（表）と成果物（CSV）。コミットはしない。

6段階のうち「3 動き出し〜4 大きく動く」の日の引けで入り、「5 動きの終わり〜6 反転」の翌朝に出る、を機械的な決め事にする。
  大きく動いた日: 前日の引けから +3% / +5% / +7% 以上（下げは -3% / -5% / -7% 以下）
  出来高: その日の出来高が過去20日平均の2倍以上（「みんなが気づいた」の代わり）
  引けの位置: 上げの日は高値の近く（その日の値幅の上から25%以内）、下げの日は安値の近く
入る: その日の引け（大引けの成行と同じ）
出る: 翌日の寄り / 翌日の引け（日足なので 9:30 などの途中は測れない）
上げの日の買い＝勢いに乗る型、下げの日の買い＝売られすぎの戻りを取る型（BNFの逆張り側）。
比べる基準: 全部の日の引けで買い→翌日の寄り（何もしなくても夜をまたぐと上がるのか）。
局面: 東京の引けの時点で分かる「前夜のSOXが75日線の上（リスクオン）」で分けた結果も出す。
成績: 1回ごとの損益%（往復コスト0.1%込み）。同じ日に何銘柄も出たら日ごとに平均して1回と数える。
"""

from __future__ import annotations

import argparse
import os

import numpy as np
import pandas as pd

from week_flow import COST, OUT, UNIV, download, prime_codes, sox_up75, stats


def run(codes: list[str], data: dict[str, pd.DataFrame], sox: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for code in codes:
        b = data.get(f"{code}.T")
        if b is None or "volume" not in b:
            continue
        o, h, l, c, v = (b[k].to_numpy(dtype=float) for k in ("open", "high", "low", "close", "volume"))
        up = sox_up75(sox, b.index).to_numpy()
        vavg = pd.Series(v).rolling(20).mean().shift(1).to_numpy()  # 当日を含まない過去20日
        for i in range(21, len(b) - 1):
            rng = h[i] - l[i]
            chg, to_o, to_c = (c[i] / c[i - 1] - 1) * 100, (o[i + 1] / c[i] - 1) * 100, (c[i + 1] / c[i] - 1) * 100
            if max(abs(chg), abs(to_o), abs(to_c)) > 60:  # Yahoo の値の誤り（桁ずれ・分割の取りこぼし）を除く
                continue
            rows.append(dict(
                code=code, d=b.index[i], up=up[i],
                chg=chg,
                vx=v[i] / vavg[i] if vavg[i] > 0 else np.nan,
                pos=(c[i] - l[i]) / rng if rng > 0 else 0.5,  # 0=安値引け 1=高値引け
                to_open=to_o,
                to_close=to_c,
            ))
    return pd.DataFrame(rows)


def checks(ev: pd.DataFrame) -> list[tuple[str, pd.Series, pd.Series]]:
    out = []
    on, off = ev["up"] == True, ev["up"] == False  # noqa: E712
    vol2 = ev["vx"] >= 2

    def add(name, mask):
        x = ev[mask]
        out.append((name + " →翌日の寄り", x["to_open"] - COST, x["d"]))
        out.append((name + " →翌日の引け", x["to_close"] - COST, x["d"]))

    add("基準: 全部の日の引けで買い", ev["chg"].notna())
    add("基準: リスクオン局面の全部の日の引けで買い", on)
    for th in (3, 5, 7):
        big_up = (ev["chg"] >= th) & vol2 & (ev["pos"] >= 0.75)
        add(f"上げ+{th}%以上・出来高2倍・高値引け近くで買い", big_up)
        add(f"上げ+{th}%以上・出来高2倍・高値引け近くで買い（リスクオン）", big_up & on)
        add(f"上げ+{th}%以上・出来高2倍・高値引け近くで買い（リスクオフ）", big_up & off)
    for th in (3, 5, 7):
        big_dn = (ev["chg"] <= -th) & vol2 & (ev["pos"] <= 0.25)
        add(f"下げ-{th}%以下・出来高2倍・安値引け近くで買い", big_dn)
        add(f"下げ-{th}%以下・出来高2倍・安値引け近くで買い（リスクオン）", big_dn & on)
    # 条件をゆるめた形（出来高・引けの位置なし）で、決め事が効いているかを見る
    add("ゆるめ: 上げ+5%以上だけで買い", ev["chg"] >= 5)
    add("ゆるめ: 下げ-5%以下だけで買い", ev["chg"] <= -5)
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
    df = pd.DataFrame([dict(検証=n, **stats(r, d)) for n, r, d in checks(ev)])
    OUT.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT / f"bnf_stage_{a.universe}.csv", index=False, encoding="utf-8-sig")
    md = f"## BNFの6段階（大きく動いた日の引けで買い→翌朝） 対象: {a.universe} {ev['code'].nunique()}銘柄 {ev['d'].min():%Y-%m-%d}〜{ev['d'].max():%Y-%m-%d}\n\n"
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
