"""セクターローテ記録: 東証17業種ETF（NEXT FUNDS 1617〜1633）の値動きを毎日記録してDiscordに送る。

完全無料（Yahoo Financeの日足のみ、AIは使わない）。平日16:20 JSTに動く。

記録するもの（state/sector_daily.csv、1日17行）:
  騰落率   1日・5日・20日
  相対     TOPIX（1306）との差。プラスならTOPIXより強い＝資金が入っている
  売買代金 20日平均との比（1.5倍以上は「資金が集まった」目安）
  局面     20日相対（強さ）と5日相対（勢い）で4つに分ける
             主導 = 強い＆まだ勢いあり   失速 = 強いが勢いが落ちた
             出遅れ = 弱い＆勢いもない   改善 = 弱いが勢いが出てきた（次の主導候補）
           ローテーションは 改善→主導→失速→出遅れ→改善 の順に回ることが多い
地合い（state/regime_daily.csv）: 上昇業種数と電機・精密の強さから
  全面高 / 全面安 / 半導体主導 / ローテーション のどれかを付ける（トレード台帳と同じ分類）
"""

from __future__ import annotations

import csv
import datetime as dt
import os
from pathlib import Path

import requests

JST = dt.timezone(dt.timedelta(hours=9))
BASE = Path(__file__).parent / "state"
DAILY = BASE / "sector_daily.csv"
REGIME = BASE / "regime_daily.csv"
DRY_RUN = os.environ.get("DRY_RUN") == "1"
BACKFILL = int(os.environ.get("BACKFILL_DAYS") or "0")  # 過去分もまとめて記録する日数

BENCH = "1306"  # TOPIX連動ETF
SECTORS = {
    "1617": "食品", "1618": "エネルギー資源", "1619": "建設・資材", "1620": "素材・化学",
    "1621": "医薬品", "1622": "自動車・輸送機", "1623": "鉄鋼・非鉄", "1624": "機械",
    "1625": "電機・精密", "1626": "情報通信・サービス", "1627": "電力・ガス", "1628": "運輸・物流",
    "1629": "商社・卸売", "1630": "小売", "1631": "銀行", "1632": "金融（除く銀行）", "1633": "不動産",
}
DAILY_HEADER = ["date", "code", "name", "close", "ret1", "ret5", "ret20", "rel1", "rel5", "rel20",
                "turnover_ratio", "rank1", "rank5", "rank20", "phase"]
REGIME_HEADER = ["date", "topix_ret1", "up_count", "regime", "leaders", "laggards"]
PHASE_ICON = {"主導": "🟢", "失速": "🟡", "出遅れ": "🔴", "改善": "🔵"}


def download():
    import yfinance as yf
    tickers = [f"{c}.T" for c in [*SECTORS, BENCH]]
    df = yf.download(tickers, period="1y", interval="1d", auto_adjust=False,
                     progress=False, group_by="column", threads=True)
    close = df["Close"].rename(columns=lambda t: t.replace(".T", ""))
    vol = df["Volume"].rename(columns=lambda t: t.replace(".T", ""))
    # 一部ETFは売買が薄く値が付かない日がある → 前日の値で埋める（騰落0扱い）
    close = close.dropna(how="all").ffill()
    vol = vol.reindex(close.index).fillna(0)
    close.index = [d.date() for d in close.index]
    vol.index = close.index
    return close, vol


def phase(rel20: float, rel5: float) -> str:
    if rel20 >= 0:
        return "主導" if rel5 >= 0 else "失速"
    return "改善" if rel5 >= 0 else "出遅れ"


def compute(close, vol, i: int) -> tuple[list[dict], dict]:
    """i 番目の日の17業種の行と地合いを作る。"""
    day = close.index[i]

    def ret(code: str, n: int) -> float:
        return round(float(close[code].iloc[i] / close[code].iloc[i - n] - 1) * 100, 2)

    turnover = close * vol
    b1, b5, b20 = ret(BENCH, 1), ret(BENCH, 5), ret(BENCH, 20)
    rows = []
    for code, name in SECTORS.items():
        r1, r5, r20 = ret(code, 1), ret(code, 5), ret(code, 20)
        avg = turnover[code].iloc[i - 20:i].mean()
        tr = round(float(turnover[code].iloc[i] / avg), 2) if avg > 0 else ""
        rel5, rel20 = round(r5 - b5, 2), round(r20 - b20, 2)
        rows.append({"date": day.strftime("%Y%m%d"), "code": code, "name": name,
                     "close": round(float(close[code].iloc[i]), 1),
                     "ret1": r1, "ret5": r5, "ret20": r20,
                     "rel1": round(r1 - b1, 2), "rel5": rel5, "rel20": rel20,
                     "turnover_ratio": tr, "phase": phase(rel20, rel5)})
    for key, col in (("rank1", "rel1"), ("rank5", "rel5"), ("rank20", "rel20")):
        for n, r in enumerate(sorted(rows, key=lambda r: -r[col]), 1):
            r[key] = n

    up = sum(1 for r in rows if r["ret1"] > 0)
    denki = next(r for r in rows if r["code"] == "1625")
    if up >= 14:
        regime = "全面高"
    elif up <= 3:
        regime = "全面安"
    elif denki["rank1"] <= 3 and denki["rel1"] >= 1.0:
        regime = "半導体主導"
    else:
        regime = "ローテーション"
    by1 = sorted(rows, key=lambda r: -r["rel1"])
    reg = {"date": day.strftime("%Y%m%d"), "topix_ret1": b1, "up_count": up, "regime": regime,
           "leaders": "、".join(r["name"] for r in by1[:3]),
           "laggards": "、".join(r["name"] for r in by1[-3:])}
    return rows, reg


def load(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def save(path: Path, header: list[str], old: list[dict], new: list[dict]) -> None:
    """同じ日付の行は置き換えて、日付順に保存する。"""
    days = {r["date"] for r in new}
    rows = [r for r in old if r["date"] not in days] + new
    rows.sort(key=lambda r: (r["date"], r.get("code", "")))
    path.parent.mkdir(exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=header, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def message(rows: list[dict], reg: dict, prev: list[dict]) -> dict:
    prev_phase = {r["code"]: r["phase"] for r in prev}
    prev_rank5 = {r["code"]: int(r["rank5"]) for r in prev}
    by1 = sorted(rows, key=lambda r: -r["rel1"])

    def line(r: dict) -> str:
        s = f"{r['name']} {r['ret1']:+.1f}%（対TOPIX {r['rel1']:+.1f}）"
        if r["turnover_ratio"] != "" and r["turnover_ratio"] >= 1.5:
            s += f" 💰代金{r['turnover_ratio']:.1f}倍"
        return s

    parts = [f"**地合い: {reg['regime']}**　TOPIX {reg['topix_ret1']:+.2f}% / 上昇 {reg['up_count']}/17業種"]
    parts.append("**今日強い**\n" + "\n".join("📈 " + line(r) for r in by1[:3]))
    parts.append("**今日弱い**\n" + "\n".join("📉 " + line(r) for r in by1[-3:][::-1]))

    changes = []
    for r in rows:
        p = prev_phase.get(r["code"])
        if p and p != r["phase"]:
            changes.append(f"{PHASE_ICON[p]}{p} → {PHASE_ICON[r['phase']]}{r['phase']}　{r['name']}")
    if changes:
        parts.append("**局面が変わった業種**\n" + "\n".join(changes))

    movers = []
    for r in rows:
        p = prev_rank5.get(r["code"])
        if p and abs(p - r["rank5"]) >= 4:
            arrow = "⤴️" if r["rank5"] < p else "⤵️"
            movers.append(f"{arrow} {r['name']} 5日順位 {p}→{r['rank5']}位")
    if movers:
        parts.append("**5日の強さ順位が大きく動いた**\n" + "\n".join(movers))

    groups = []
    for ph in ("主導", "改善", "失速", "出遅れ"):
        names = [r["name"] for r in sorted(rows, key=lambda r: -r["rel5"]) if r["phase"] == ph]
        groups.append(f"{PHASE_ICON[ph]}{ph}: {'、'.join(names) or 'なし'}")
    parts.append("**局面マップ（20日の強さ×5日の勢い）**\n" + "\n".join(groups))
    parts.append("※ 改善→主導→失速→出遅れの順に回りやすい。🔵改善は次の資金の行き先の候補")
    day = dt.datetime.strptime(reg["date"], "%Y%m%d")
    return {"embeds": [{"title": f"🔄 セクターローテ {day:%m/%d}",
                        "description": "\n\n".join(parts)[:4000], "color": 0x10B981}]}


def main() -> None:
    close, vol = download()
    if len(close) < 22:
        raise SystemExit(f"データが足りません（{len(close)}日分）")
    last = len(close) - 1
    today = dt.datetime.now(JST).date()
    if close.index[last] != today:
        print(f"注意: 最新データは {close.index[last]}（今日 {today} の分はまだ／休場）")

    start = max(21, last - BACKFILL) if BACKFILL else last
    all_rows, all_regs = [], []
    for i in range(start, last + 1):
        rows, reg = compute(close, vol, i)
        all_rows += rows
        all_regs.append(reg)

    old_daily = load(DAILY)
    rows, reg = all_rows[-17:], all_regs[-1]
    prev_day = close.index[last - 1].strftime("%Y%m%d")
    prev = [r for r in all_rows if r["date"] == prev_day] or \
           [r for r in old_daily if r["date"] == prev_day]
    if not prev:  # 初回は前日分も計算して比べる
        prev, _ = compute(close, vol, last - 1)

    for r in rows:
        print(r)
    print(reg)
    payload = message(rows, reg, prev)
    print(payload["embeds"][0]["description"])

    if DRY_RUN:
        print("DRY_RUN: 保存・通知はしません")
        return
    save(DAILY, DAILY_HEADER, old_daily, all_rows)
    save(REGIME, REGIME_HEADER, load(REGIME), all_regs)
    hook = os.environ.get("SECTOR_WEBHOOK_URL") or os.environ.get("DISCORD_WEBHOOK_URL")
    if hook and close.index[last] == today:
        requests.post(hook, json=payload, timeout=20).raise_for_status()
        print("Discordに送りました")
    elif not hook:
        print("Webhook未設定のため通知しません")
    else:
        print("今日の分がないので通知しません（休場日など）")


if __name__ == "__main__":
    main()
