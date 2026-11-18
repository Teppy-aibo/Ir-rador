"""60分足の使い方5案を、Yahoo の60分足（取れる最大の約2年）で測る（11/18 ユーザー「60分足で今までと違う型ができるかも、極端でもいいので5つ」）。
GitHub Actions の「heavy-check」から手動で動かす。結果は Summary（表）と成果物（CSV）。コミットはしない。

共通: 線は60分足の終値の単純移動平均（5本・25本）。足をまたいで日をまたいでつなぐ（チャートと同じ）。
      入るのは合図が出た足の「次の足の始値」（先読みなし）。損益は1回ごとの%（往復コスト0.1%込み、売りは符号を反対）。
      同じ日に何銘柄も出たら日ごとに平均して1回と数え t値を出す。前半=1年より前／後半=直近1年。

案1 押し目: 60分足が上向き（5本>25本・25本が5本前より上）で、安値が25本線に初めて触れて終値は線の上 → 次の足で買い
            手じまい=終値が25本線の0.5%下で引けた足の終値 か 6本後（約1日）の終値。下向きの逆（戻り売り）と、向きに逆らう同じ形も比べる
案2 朝のふるい: 前日の最後の60分足で 5本>25本 なら翌日の寄り→引けを買い、5本<25本 なら売り（朝に注文を置くだけ）
案3 売られすぎ: 60分足RSI(14)が20以下（極端版15以下）で、価格が25本線の下 → 次の足で買い、RSIが50以上で引けた足の終値か12本後
案4 線の交差でドテン: 5本が25本を上に抜けたら次の足で買い、下に抜けたら売りに乗り換え（ずっと持つ・夜も持つ）
案5 後場寄りの足: 後場最初の60分足（12:30〜）が60分足の向きと同じ色（上向きで陽線/下向きで陰線）→ その次の足の始値で入り大引けで手じまい
"""

from __future__ import annotations

import argparse
import math
import time

import numpy as np
import pandas as pd

from week_flow import COST, OUT, UNIV, prime_codes


def download60(symbols: list[str]) -> dict[str, pd.DataFrame]:
    import yfinance as yf
    out: dict[str, pd.DataFrame] = {}
    for n in range(0, len(symbols), 50):
        part = symbols[n:n + 50]
        for attempt in range(3):
            try:
                df = yf.download(part, period="730d", interval="60m", progress=False, auto_adjust=False,
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
            if len(one) < 200:
                continue
            idx = pd.to_datetime(one.index)
            idx = idx.tz_convert("Asia/Tokyo") if idx.tz is not None else idx.tz_localize("UTC").tz_convert("Asia/Tokyo")
            one.index = idx.tz_localize(None)
            out[s] = one.rename(columns=str.lower)
        print(f"{min(n + 50, len(symbols))}/{len(symbols)} 取得")
        time.sleep(2)
    return out


def rsi(c: pd.Series, n: int = 14) -> pd.Series:
    d = c.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / dn)


def events(code: str, b: pd.DataFrame) -> list[dict]:
    o, h, l, c = (b[k].to_numpy() for k in ("open", "high", "low", "close"))
    cs = b["close"]
    m5, m25 = cs.rolling(5).mean().to_numpy(), cs.rolling(25).mean().to_numpy()
    r = rsi(cs).to_numpy()
    day = b.index.normalize()
    dvals = day.to_numpy()
    n = len(b)
    # 日ごとの最初/最後の足の位置
    first = {}
    last = {}
    for i, d in enumerate(dvals):
        first.setdefault(d, i)
        last[d] = i
    rows = []

    def add(kind, i_in, i_out, side, d):
        if i_in >= n or i_out >= n or i_out < i_in:
            return
        px_in = o[i_in]
        px_out = c[i_out]
        rows.append(dict(code=code, d=pd.Timestamp(d), kind=kind, ret=side * (px_out / px_in - 1) * 100 - COST))

    def up(i):
        return m5[i] > m25[i] and i >= 5 and m25[i] > m25[i - 5]

    def dn(i):
        return m5[i] < m25[i] and i >= 5 and m25[i] < m25[i - 5]

    # 案1 押し目 / 戻り売り
    def exit_line(i_in, side):
        for k in range(i_in, min(i_in + 6, n)):
            if side == 1 and c[k] < m25[k] * 0.995:
                return k
            if side == -1 and c[k] > m25[k] * 1.005:
                return k
        return min(i_in + 5, n - 1)

    for i in range(30, n - 1):
        if np.isnan(m25[i]):
            continue
        touch_dn = l[i] <= m25[i] and c[i] > m25[i] and l[i - 1] > m25[i - 1]  # 上から触れて線の上で引け
        touch_up = h[i] >= m25[i] and c[i] < m25[i] and h[i - 1] < m25[i - 1]  # 下から触れて線の下で引け
        if touch_dn and up(i):
            add("案1 上向きの押し目買い（25本線タッチ）", i + 1, exit_line(i + 1, 1), 1, dvals[i + 1])
        if touch_dn and dn(i):
            add("案1比較 下向きで25本線に上から触れて買い", i + 1, exit_line(i + 1, 1), 1, dvals[i + 1])
        if touch_up and dn(i):
            add("案1 下向きの戻り売り（25本線タッチ）", i + 1, exit_line(i + 1, -1), -1, dvals[i + 1])
        if touch_up and up(i):
            add("案1比較 上向きで25本線に下から触れて売り", i + 1, exit_line(i + 1, -1), -1, dvals[i + 1])

    # 案2 朝のふるい（前日最後の足の向き → 今日の寄り→引け）
    days = sorted(first)
    for a, bday in zip(days[:-1], days[1:]):
        j = last[a]
        if np.isnan(m25[j]):
            continue
        i0, i1 = first[bday], last[bday]
        oc = (c[i1] / o[i0] - 1) * 100
        rows.append(dict(code=code, d=pd.Timestamp(bday), kind="基準 毎日の寄り→引け（買い）", ret=oc - COST))
        if m5[j] > m25[j]:
            rows.append(dict(code=code, d=pd.Timestamp(bday), kind="案2 前日の60分足が上向き→寄り買い引け売り", ret=oc - COST))
        elif m5[j] < m25[j]:
            rows.append(dict(code=code, d=pd.Timestamp(bday), kind="案2 前日の60分足が下向き→寄り売り引け買戻し", ret=-oc - COST))
        if up(j):
            rows.append(dict(code=code, d=pd.Timestamp(bday), kind="案2強 上向き＋25本線も上昇→寄り買い", ret=oc - COST))
        if dn(j):
            rows.append(dict(code=code, d=pd.Timestamp(bday), kind="案2強 下向き＋25本線も下降→寄り売り", ret=-oc - COST))

    # 案3 売られすぎの反発
    def exit_rsi(i_in):
        for k in range(i_in, min(i_in + 12, n)):
            if r[k] >= 50:
                return k
        return min(i_in + 11, n - 1)

    busy = -1
    for i in range(30, n - 1):
        if i <= busy or np.isnan(m25[i]):
            continue
        if r[i] <= 20 and c[i] < m25[i]:
            k = exit_rsi(i + 1)
            add("案3 RSI20以下＋25本線の下→反発買い", i + 1, k, 1, dvals[i + 1])
            if r[i] <= 15:
                add("案3極端 RSI15以下→反発買い", i + 1, k, 1, dvals[i + 1])
            busy = k
    busy = -1
    for i in range(30, n - 1):
        if i <= busy or np.isnan(m25[i]):
            continue
        if r[i] >= 80 and c[i] > m25[i]:
            k = i + 1
            while k < min(i + 13, n - 1) and r[k] > 50:
                k += 1
            add("案3逆 RSI80以上＋25本線の上→反落売り", i + 1, k, -1, dvals[i + 1])
            busy = k

    # 案4 交差でドテン
    pos, i_in = 0, None
    for i in range(30, n - 1):
        if np.isnan(m25[i]) or np.isnan(m25[i - 1]):
            continue
        cross_up = m5[i - 1] <= m25[i - 1] and m5[i] > m25[i]
        cross_dn = m5[i - 1] >= m25[i - 1] and m5[i] < m25[i]
        if (cross_up and pos <= 0) or (cross_dn and pos >= 0):
            if pos != 0:
                rows.append(dict(code=code, d=pd.Timestamp(dvals[i_in]), kind="案4 交差でドテン（買いと売りの合計）",
                                 ret=pos * (o[i + 1] / o[i_in] - 1) * 100 - COST))
                rows.append(dict(code=code, d=pd.Timestamp(dvals[i_in]),
                                 kind="案4 うち買い" if pos == 1 else "案4 うち売り",
                                 ret=pos * (o[i + 1] / o[i_in] - 1) * 100 - COST))
            pos, i_in = (1 if cross_up else -1), i + 1

    # 案5 後場寄りの足
    for d in days:
        idxs = [i for i in range(first[d], last[d] + 1) if b.index[i].hour >= 12]
        if len(idxs) < 2:
            continue
        i = idxs[0]
        if np.isnan(m25[i]):
            continue
        yang, yin = c[i] > o[i], c[i] < o[i]
        i_in, i_out = i + 1, last[d]
        base = (c[i_out] / o[i_in] - 1) * 100
        rows.append(dict(code=code, d=pd.Timestamp(d), kind="基準 毎日の13:30ごろ→大引け（買い）", ret=base - COST))
        if up(i) and yang:
            rows.append(dict(code=code, d=pd.Timestamp(d), kind="案5 上向き＋後場寄りの足が陽線→買い", ret=base - COST))
        if dn(i) and yin:
            rows.append(dict(code=code, d=pd.Timestamp(d), kind="案5 下向き＋後場寄りの足が陰線→売り", ret=-base - COST))
        if dn(i) and yang:
            rows.append(dict(code=code, d=pd.Timestamp(d), kind="案5比較 下向きなのに陽線→買い", ret=base - COST))
        if up(i) and yin:
            rows.append(dict(code=code, d=pd.Timestamp(d), kind="案5比較 上向きなのに陰線→売り", ret=-base - COST))
    return rows


def stats(x: pd.DataFrame, split: pd.Timestamp) -> dict:
    r, d = x["ret"], x["d"]
    byday = r.groupby(d).mean()
    n, m = len(byday), byday.mean()
    sd = byday.std(ddof=1) if n > 1 else 0
    t = m / (sd / math.sqrt(n)) if sd and n > 1 else 0
    e, la = byday[byday.index < split].mean(), byday[byday.index >= split].mean()
    ok = e > 0 and la > 0
    judge = "件数不足" if n < 20 else ("◎ 合格候補" if t >= 2 and ok else ("△ 要観察" if t >= 1.5 and ok else "× 優位性なし"))
    return dict(回数=len(r), 日数=n, 平均=round(r.mean(), 3), 日ごと平均=round(m, 3), 勝率=round((r > 0).mean() * 100),
                t値=round(t, 2), 前半=None if math.isnan(e) else round(e, 3), 直近1年=None if math.isnan(la) else round(la, 3),
                判定=judge)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--universe", default="AI半導体")
    a = ap.parse_args()
    codes = prime_codes() if a.universe == "プライム" else UNIV[a.universe]
    data = download60([f"{c}.T" for c in codes])
    print(f"取れた銘柄 {len(data)}")
    if data:
        any_b = next(iter(data.values()))
        print("期間", any_b.index.min(), "〜", any_b.index.max(), "足の時刻", sorted({t.strftime('%H:%M') for t in any_b.index[-30:]}))
    rows = []
    for s, b in data.items():
        rows += events(s.replace(".T", ""), b)
    ev = pd.DataFrame(rows)
    OUT.mkdir(parents=True, exist_ok=True)
    ev.to_csv(OUT / "h60_events.csv", index=False)
    split = ev["d"].max() - pd.Timedelta(days=365)
    res = []
    for k in sorted(ev["kind"].unique()):
        res.append(dict(案=k, **stats(ev[ev["kind"] == k], split)))
    tab = pd.DataFrame(res)
    tab.to_csv(OUT / "h60_summary.csv", index=False)
    md = f"## 60分足5案（{a.universe}、{len(data)}銘柄、{ev['d'].min().date()}〜{ev['d'].max().date()}、損益%はコスト0.1%込み）\n\n" + tab.to_markdown(index=False)
    print(md)
    import os
    p = os.environ.get("GITHUB_STEP_SUMMARY")
    if p:
        with open(p, "a") as f:
            f.write(md + "\n")


if __name__ == "__main__":
    main()
