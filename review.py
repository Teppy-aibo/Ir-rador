"""答え合わせ: 本採点した開示が、反応する日（翌営業日など）にどう動いたかを記録してDiscordに送る。

state/calls.csv（main.py が記録）→ state/results.csv に値動きを追記する。
反応日:
  9:00より前の開示   → その日（取引日でなければ次の取引日）
  15:30以降の開示    → 次の取引日
  場中の開示         → その日（基準は通知時の株価）
記録する値（基準＝反応日の前日終値。場中は通知時の株価）:
  寄り値・ギャップ率／9:30までの高値と安値（寄り値比）／終値（基準比）／+2%到達
"""

from __future__ import annotations

import csv
import datetime as dt
import os
import sys
from pathlib import Path

import requests

JST = dt.timezone(dt.timedelta(hours=9))
BASE = Path(__file__).parent / "state"
CALLS = BASE / "calls.csv"
RESULTS = BASE / "results.csv"
HEADER = ["id", "date", "time", "code", "name", "score", "notified", "mode", "reaction_day",
          "base", "open", "gap_pct", "high_0930_pct", "low_0930_pct", "close_pct", "hit_2pct", "note"]
DRY_RUN = os.environ.get("DRY_RUN") == "1"


def is_trading_day(d: dt.date) -> bool:
    if d.weekday() >= 5:
        return False
    if (d.month, d.day) in {(1, 1), (1, 2), (1, 3), (12, 31)}:
        return False
    try:
        import jpholiday
        return not jpholiday.is_holiday(d)
    except ImportError:
        return True


def next_trading_day(d: dt.date) -> dt.date:
    d += dt.timedelta(days=1)
    while not is_trading_day(d):
        d += dt.timedelta(days=1)
    return d


def reaction_day(day: str, hhmm: str) -> tuple[dt.date, str]:
    d = dt.datetime.strptime(day, "%Y%m%d").date()
    if hhmm < "09:00":
        return (d if is_trading_day(d) else next_trading_day(d)), "寄り前"
    if hhmm >= "15:30":
        return next_trading_day(d), "引け後"
    return d, "場中"


def pct(a: float, b: float) -> float:
    return round((a / b - 1) * 100, 2)


def measure(code: str, rday: dt.date, mode: str, alert_price: str) -> dict:
    import yfinance as yf
    t = yf.Ticker(f"{code}.T")
    daily = t.history(start=rday - dt.timedelta(days=10), end=rday + dt.timedelta(days=1))
    if daily.empty:
        return {"note": "株価データなし"}
    daily.index = daily.index.tz_convert(JST) if daily.index.tz else daily.index.tz_localize(JST)
    today = daily[daily.index.date == rday]
    prev = daily[daily.index.date < rday]
    if today.empty or prev.empty:
        return {"note": "反応日のデータなし"}
    if mode == "場中" and alert_price not in ("", "None"):
        base = float(alert_price)
    else:
        base = float(prev["Close"].iloc[-1])
    d_open = float(today["Open"].iloc[0])
    d_close = float(today["Close"].iloc[-1])
    out = {"base": round(base, 1), "open": round(d_open, 1), "gap_pct": pct(d_open, base),
           "close_pct": pct(d_close, base), "note": ""}
    # 9:00〜9:30の5分足（取れれば）
    try:
        bars = t.history(interval="5m", start=rday, end=rday + dt.timedelta(days=1))
        if not bars.empty:
            bars.index = bars.index.tz_convert(JST)
            early = bars[(bars.index.time < dt.time(9, 30)) & (bars["Volume"] > 0)]
            if not early.empty:
                o = float(early["Open"].iloc[0])
                out["open"] = round(o, 1)
                out["gap_pct"] = pct(o, base)
                out["high_0930_pct"] = pct(float(early["High"].max()), o)
                out["low_0930_pct"] = pct(float(early["Low"].min()), o)
                out["hit_2pct"] = int(out["high_0930_pct"] >= 2.0)
            else:
                out["note"] = "9:30まで寄らず（気配のまま）"
    except Exception as e:  # noqa: BLE001
        out["note"] = f"5分足取得失敗 {e}"[:60]
    return out


def load_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def bucket(score: int) -> str:
    if score >= 95:
        return "95点以上"
    if score >= 85:
        return "85〜94点"
    if score >= 70:
        return "70〜84点"
    return "70点未満"


def stats(rows: list[dict]) -> str:
    groups: dict[str, list[dict]] = {}
    for r in rows:
        if r.get("is_negative") == "1" or not r.get("gap_pct"):
            continue
        groups.setdefault(bucket(int(r["score"])), []).append(r)
    lines = []
    for b in ["95点以上", "85〜94点", "70〜84点", "70点未満"]:
        g = groups.get(b, [])
        if not g:
            continue
        gap = sum(float(r["gap_pct"]) for r in g) / len(g)
        hi = [float(r["high_0930_pct"]) for r in g if r.get("high_0930_pct")]
        hit = [int(r["hit_2pct"]) for r in g if r.get("hit_2pct") != ""]
        s = f"{b}: {len(g)}件 平均ギャップ {gap:+.1f}%"
        if hi:
            s += f" / 寄り→9:30高値 平均 {sum(hi)/len(hi):+.1f}%"
        if hit:
            s += f" / +2%到達 {sum(hit)}/{len(hit)}"
        lines.append(s)
    return "\n".join(lines) or "まだデータがありません"


def main() -> None:
    now = dt.datetime.now(JST)
    calls = load_csv(CALLS)
    results = load_csv(RESULTS)
    done = {r["id"] for r in results}
    new_rows = []
    for c in calls:
        if c["id"] in done:
            continue
        rday, mode = reaction_day(c["date"], c["time"])
        # 反応日の大引け（15:30）後のデータが出るまで待つ
        if dt.datetime.combine(rday, dt.time(15, 45), JST) > now:
            continue
        m = measure(c["code"], rday, mode, c.get("price_at_alert", ""))
        row = {k: "" for k in HEADER}
        row.update({"id": c["id"], "date": c["date"], "time": c["time"], "code": c["code"],
                    "name": c["name"], "score": c["score"], "notified": c["notified"],
                    "mode": mode, "reaction_day": rday.strftime("%Y%m%d")})
        row.update({k: v for k, v in m.items() if k in HEADER})
        row["is_negative"] = c.get("is_negative", "0")
        new_rows.append(row)
        print(row)

    if new_rows and not DRY_RUN:
        exists = RESULTS.exists()
        with RESULTS.open("a", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=HEADER, extrasaction="ignore")
            if not exists:
                w.writeheader()
            w.writerows(new_rows)

    if not new_rows:
        print("新しく答え合わせできる開示はありません")
        return

    # Discordへ。通知した銘柄と、80点以上の惜しい銘柄だけ載せる
    all_rows = load_csv(RESULTS) + (new_rows if DRY_RUN else [])
    neg = {c["id"] for c in calls if c.get("is_negative") == "1"}
    for r in all_rows:
        r["is_negative"] = "1" if r["id"] in neg else "0"
    shown = sorted([r for r in new_rows if r["notified"] == "1" or int(r["score"]) >= 80],
                   key=lambda r: -int(r["score"]))
    lines = []
    for r in shown[:15]:
        mark = "🔔" if r["notified"] == "1" else "・"
        s = f"{mark} {r['score']}点 {r['code']} {r['name']}（{r['mode']}）"
        if r.get("gap_pct"):
            s += f" 寄り {float(r['gap_pct']):+.1f}%"
        if r.get("high_0930_pct"):
            s += f" → 9:30高値 {float(r['high_0930_pct']):+.1f}%"
        if r.get("close_pct"):
            s += f" / 終値 {float(r['close_pct']):+.1f}%"
        if r.get("note"):
            s += f"（{r['note']}）"
        lines.append(s)
    desc = ("\n".join(lines) or "80点以上の開示はありませんでした") + \
        f"\n\n**これまでの集計（点数別）**\n{stats(all_rows)}\n\n※寄り・終値は前日終値比、9:30高値は寄り値比"
    payload = {"embeds": [{"title": f"📊 答え合わせ {now:%m/%d}（{len(new_rows)}件）",
                           "description": desc[:4000], "color": 0x3B82F6}]}
    if DRY_RUN or not os.environ.get("DISCORD_WEBHOOK_URL"):
        print(desc)
        return
    requests.post(os.environ["DISCORD_WEBHOOK_URL"], json=payload, timeout=20).raise_for_status()


if __name__ == "__main__":
    main()
