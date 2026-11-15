"""上向きの線（安値の切り上げ）の下限割れで売る形を日足6年分で測る（11/16 ユーザーの画像「溜め→買い手が消える→ライン抜けで売り」）。
GitHub Actions の「heavy-check」から手動で動かす。結果は Summary（表）と成果物（CSV）。コミットはしない。

考え方: 上向きの線で買った人は、損切りを線の下に置く。線に何度も触れるほど損切りがたまる。
その中で高値が切り下がる＝買い手が減っている。そこで線を割ると損切りの売りが続いて下げやすい（はず）。

決め事（毎日その日までの値だけで決める＝先読みなし）
  安値の山: 前後3日で一番安い日（3日後にならないと確定しないので、確定した山だけ使う）
  線: 過去90日の中の最後の3つの安値の山が切り上がっている（L1<L2<L3）。L1とL3を結んだ線から L2 が±2%以内＝3回触れた
      L1 からきのうまで、終値が線の0.5%下より下に来ていない（線が守られてきた）
  割れ: きのうの終値は線の上、きょうの終値が線の下
  高値の切り下げ: L1 より後の高値の山（前後3日で一番高い日）の最後の2つが下がっている（3つ下がっているかも別に見る）
売り方: 割れた日の翌朝の寄りで売り → 翌日の引け／3日目の引け／5日目の引け で買い戻し（コスト0.1%込み、売りの向き＝プラスが勝ち）
        割れた日の引けで売る場合（14:50ごろに割れが分かる前提）も比べる
比べる: 高値の条件なし（線を割っただけ）／同じ日の日経ETF(1321)の動きを引いた値（相場全体で下げただけかを除く）
"""

from __future__ import annotations

import argparse
import os

import numpy as np
import pandas as pd

from week_flow import COST, OUT, UNIV, download, prime_codes, stats

K = 3  # 山の前後の日数
WIN = 90  # 線を探す日数
TOUCH = 0.02  # 真ん中の安値が線から離れてよい幅
HOLD_TOL = 0.005  # 線が守られてきたとみなす幅


def pivots(x: np.ndarray, low: bool) -> np.ndarray:
    """前後K日で一番安い（高い）日の位置"""
    s = pd.Series(x)
    r = s.rolling(2 * K + 1, center=True)
    ext = r.min() if low else r.max()
    return np.where((s == ext).to_numpy() & ext.notna().to_numpy())[0]


def events(b: pd.DataFrame) -> list[dict]:
    h, l, c = b["high"].to_numpy(), b["low"].to_numpy(), b["close"].to_numpy()
    pl, ph = pivots(l, True), pivots(h, False)
    out = []
    last_ev = -999
    for t in range(WIN, len(b) - 1):
        known = pl[(pl <= t - K - 1) & (pl >= t - WIN)]  # きのうまでに確定した山
        if len(known) < 3:
            continue
        i1, i2, i3 = known[-3:]
        if not (l[i1] < l[i2] < l[i3]):
            continue
        slope = (l[i3] - l[i1]) / (i3 - i1)
        line = lambda i: l[i1] + slope * (i - i1)  # noqa: E731
        if abs(l[i2] / line(i2) - 1) > TOUCH:
            continue
        seg = np.arange(i1 + 1, t)
        if (c[seg] < line(seg) * (1 - HOLD_TOL)).any():
            continue
        if not (c[t - 1] >= line(t - 1) and c[t] < line(t)):
            continue
        if t - last_ev < 10:  # 同じ割れを何度も数えない
            continue
        last_ev = t
        hs = ph[(ph > i1) & (ph <= t - K - 1)]
        down2 = len(hs) >= 2 and h[hs[-1]] < h[hs[-2]]
        down3 = len(hs) >= 3 and h[hs[-1]] < h[hs[-2]] < h[hs[-3]]
        out.append(dict(t=t, down2=down2, down3=down3, slope=slope / c[t] * 100,
                        depth=(c[t] / line(t) - 1) * 100))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--universe", default="大型108")
    ap.add_argument("--period", default="6y")
    a = ap.parse_args()
    codes = prime_codes() if a.universe == "プライム" else UNIV[a.universe]
    syms = [f"{c}.T" for c in codes] + ["1321.T"]
    data = download(syms, a.period)
    if "1321.T" not in data:
        data.update(download(["1321.T"], a.period))
    nk = data["1321.T"]

    rows = []
    for code in codes:
        b = data.get(f"{code}.T")
        if b is None or len(b) < WIN + 20:
            continue
        o, c = b["open"].to_numpy(), b["close"].to_numpy()
        nko = nk["open"].reindex(b.index).to_numpy()
        nkc = nk["close"].reindex(b.index).to_numpy()
        for ev in events(b):
            t = ev["t"]
            r = dict(code=code, date=b.index[t + 1], 割れた日=b.index[t], down2=ev["down2"], down3=ev["down3"],
                     線の傾き日=round(ev["slope"], 3), 割れの深さ=round(ev["depth"], 2),
                     翌朝の窓=round((o[t + 1] / c[t] - 1) * 100, 2))
            for n in (1, 3, 5):
                j = t + n
                if j >= len(b):
                    continue
                ret = (c[j] / o[t + 1] - 1) * 100
                r[f"寄り売り{n}日"] = -ret - COST
                if not (np.isnan(nko[t + 1]) or np.isnan(nkc[j])):
                    r[f"寄り売り{n}日_日経差"] = -(ret - (nkc[j] / nko[t + 1] - 1) * 100)
                r[f"引け売り{n}日"] = -((c[j] / c[t] - 1) * 100) - COST
            rows.append(r)
    ev = pd.DataFrame(rows)
    if ev.empty:
        raise SystemExit("割れが1つも見つかりませんでした")
    ev = ev[(ev["翌朝の窓"].abs() < 30)]  # Yahoo の値の誤りを除く
    groups = [("線を割っただけ（高値の条件なし）", ev.index == ev.index),
              ("高値が2回切り下げ（画像の形）", ev["down2"]),
              ("高値が3回切り下げ", ev["down3"]),
              ("高値の切り下げなし", ~ev["down2"])]
    cols = ["寄り売り1日", "寄り売り3日", "寄り売り5日", "寄り売り3日_日経差", "引け売り1日", "引け売り3日", "引け売り5日"]
    out = []
    for gname, m in groups:
        g = ev[m]
        for col in cols:
            if col not in g:
                continue
            x = g[col].dropna()
            st = stats(x, g.loc[x.index, "date"])
            out.append(dict(形=gname, 売り方=col, 翌朝の窓の平均=round(g["翌朝の窓"].mean(), 2), **st))
    df = pd.DataFrame(out)
    OUT.mkdir(parents=True, exist_ok=True)
    ev.to_csv(OUT / "channel_break_events.csv", index=False, encoding="utf-8-sig")
    df.to_csv(OUT / "channel_break.csv", index=False, encoding="utf-8-sig")
    md = f"## 上向きの線の下限割れで売る（{a.universe} {len(codes)}銘柄・日足{a.period}、割れ {len(ev)}回）\n\n"
    md += "損益%は売りの向き（プラスが勝ち）・コスト0.1%込み。日経差=同じ期間の日経ETFの動きを引いた値（コストなし）。判定はプラスの向きで見る。前半は〜2023、後半は2024〜。\n\n"
    hd = list(df.columns)
    md += "| " + " | ".join(hd) + " |\n|" + "---|" * len(hd) + "\n"
    for _, row in df.fillna("").iterrows():
        md += "| " + " | ".join(str(row[k]) for k in hd) + " |\n"
    print(md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(md + "\n")


if __name__ == "__main__":
    main()
