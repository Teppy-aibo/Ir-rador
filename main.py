"""Ir-rador: TDnetの新着開示をAIで採点し、閾値以上だけDiscordに通知する。

発注は一切しない。通知だけ。
環境変数:
  ANTHROPIC_API_KEY   必須
  DISCORD_WEBHOOK_URL 必須（DRY_RUN=1 のときは不要）
  FINAL_MODEL         本採点のモデル（既定 claude-opus-5-5）
  SCREEN_MODEL        一次採点のモデル（空なら一次採点なし。ワークフローの既定 claude-haiku-5-5）
  MAX_PAGES           AIに渡すPDFの先頭ページ数（既定 4）
  SCREEN_THRESHOLD    一次採点でこの点以上だけ本採点へ（既定 80）
  THRESHOLD           通知する点数（既定 95）
  MAX_PER_RUN         1回で採点する最大件数（既定 30。残りは次回）
  FORCE=1             時間帯チェックを無視して実行（テスト用）
  DRY_RUN=1           通知せず結果を表示するだけ（テスト用）
  TARGET_DATE         YYYYMMDD を指定するとその日の開示を対象にする（テスト用）
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

import anthropic
import requests
from bs4 import BeautifulSoup

JST = dt.timezone(dt.timedelta(hours=9))
STATE_FILE = Path(__file__).parent / "state" / "seen.json"
UA = {"User-Agent": "Mozilla/5.0 (ir-rador personal notifier)"}

THRESHOLD = int(os.environ.get("THRESHOLD", "95"))
FINAL_MODEL = os.environ.get("FINAL_MODEL", "claude-opus-5-5")
SCREEN_MODEL = os.environ.get("SCREEN_MODEL", "").strip()
SCREEN_THRESHOLD = int(os.environ.get("SCREEN_THRESHOLD", "80"))
MAX_PER_RUN = int(os.environ.get("MAX_PER_RUN", "30"))
MAX_PAGES = int(os.environ.get("MAX_PAGES", "4"))  # AIに渡すPDFの先頭ページ数（費用を抑えるため）
DRY_RUN = os.environ.get("DRY_RUN") == "1"
TOKENS: dict[str, list[int]] = {}
# 100万トークンあたりのドル（入力, 出力）。費用の目安表示用
PRICE = {"claude-opus-5-5": (4, 20), "claude-sonnet-5-5": (2, 10), "claude-haiku-5-5": (0.1, 0.5)}

# タイトルによる一次絞り込み（この語を含むものだけ読む）
INCLUDE = [
    "業績予想", "配当予想", "増配", "剰余金の配当", "公開買付", "TOB", "MBO",
    "自己株式の取得", "自己株式取得", "株式分割", "株主優待", "資本業務提携",
    "業務提携", "資本提携", "決算短信", "特別利益", "受注", "契約締結",
    "子会社化", "株式の取得", "合併", "経営統合", "上場", "承認",
]
# 明らかに材料にならないもの
EXCLUDE = [
    "訂正", "説明会", "決算説明資料", "補足資料", "役員", "人事", "定款",
    "コーポレート・ガバナンス", "独立役員", "招集", "月次", "ストックオプション",
    "譲渡制限付株式", "自己株式の取得状況", "自己株式の買付状況", "取得状況",
]


# ---------- 時間帯 ----------

def in_window(now: dt.datetime) -> bool:
    if now.weekday() >= 5:
        return False
    try:
        import jpholiday
        if jpholiday.is_holiday(now.date()):
            return False
    except ImportError:
        pass
    hm = now.hour * 60 + now.minute
    return 8 * 60 + 30 <= hm <= 20 * 60 + 5


# ---------- 既読管理 ----------

def load_seen(day: str) -> tuple[set[str], set[str]]:
    """(既読の開示ID, その日すでに通知した銘柄コード)"""
    if STATE_FILE.exists():
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if data.get("date") == day:
            return set(data.get("ids", [])), set(data.get("notified", []))
    return set(), set()


def save_seen(day: str, ids: set[str], notified: set[str]) -> None:
    STATE_FILE.parent.mkdir(exist_ok=True)
    STATE_FILE.write_text(
        json.dumps({"date": day, "ids": sorted(ids), "notified": sorted(notified)},
                   ensure_ascii=False, indent=0),
        encoding="utf-8",
    )


# ---------- TDnet一覧の取得 ----------

def fetch_tdnet(day: str) -> list[dict]:
    """TDnet公式の一覧ページを全ページ読む。"""
    items: list[dict] = []
    for page in range(1, 30):
        url = f"https://www.release.tdnet.info/inbs/I_list_{page:03d}_{day}.html"
        r = requests.get(url, headers=UA, timeout=20)
        if r.status_code == 404:
            break
        r.raise_for_status()
        r.encoding = "utf-8"
        soup = BeautifulSoup(r.text, "html.parser")
        rows = soup.select("#main-list-table tr")
        if not rows:
            break
        for tr in rows:
            t = tr.select_one(".kjTime")
            c = tr.select_one(".kjCode")
            n = tr.select_one(".kjName")
            a = tr.select_one(".kjTitle a")
            if not (t and c and n and a):
                continue
            href = a.get("href", "")
            items.append({
                "id": href.rsplit("/", 1)[-1].replace(".pdf", ""),
                "time": t.get_text(strip=True),
                "code": c.get_text(strip=True)[:4],
                "name": n.get_text(strip=True),
                "title": a.get_text(strip=True),
                "pdf": "https://www.release.tdnet.info/inbs/" + href,
            })
        if len(rows) < 100:
            break
    return items


def fetch_yanoshin(day: str) -> list[dict]:
    """予備: やのしん TDnet WEB-API。"""
    url = f"https://webapi.yanoshin.jp/webapi/tdnet/list/{day}.json?limit=2000"
    r = requests.get(url, headers=UA, timeout=30)
    r.raise_for_status()
    items = []
    for it in r.json().get("items", []):
        d = it.get("Tdnet", {})
        pub = d.get("pubdate", "")
        items.append({
            "id": str(d.get("id")),
            "time": pub[11:16],
            "code": str(d.get("company_code", ""))[:4],
            "name": d.get("company_name", ""),
            "title": d.get("title", ""),
            "pdf": d.get("document_url", ""),
        })
    return items


def fetch_list(day: str) -> list[dict]:
    try:
        items = fetch_tdnet(day)
        if items:
            return items
    except Exception as e:  # noqa: BLE001
        print(f"TDnet一覧の取得に失敗: {e} → 予備APIを使います", file=sys.stderr)
    return fetch_yanoshin(day)


def title_ok(title: str) -> bool:
    if any(w in title for w in EXCLUDE):
        return False
    return any(w in title for w in INCLUDE)


# ---------- 株価・時価総額 ----------

def market_info(code: str) -> dict:
    info = {"price": None, "market_cap_oku": None, "chg_1m_pct": None}
    try:
        import yfinance as yf
        t = yf.Ticker(f"{code}.T")
        fi = t.fast_info
        info["price"] = round(float(fi.last_price), 1)
        if fi.market_cap:
            info["market_cap_oku"] = round(float(fi.market_cap) / 1e8)
        hist = t.history(period="1mo")
        if len(hist) > 1:
            first, last = float(hist["Close"].iloc[0]), float(hist["Close"].iloc[-1])
            info["chg_1m_pct"] = round((last / first - 1) * 100, 1)
    except Exception as e:  # noqa: BLE001
        print(f"{code}: 株価取得失敗 {e}", file=sys.stderr)
    return info


# ---------- PDFを先頭ページだけにする ----------

def trim_pdf(pdf: bytes, pages: int) -> bytes:
    """要点はほぼ先頭数ページ（決算短信の1枚目サマリーなど）にあるので、そこだけ渡す。"""
    try:
        import io
        from pypdf import PdfReader, PdfWriter
        reader = PdfReader(io.BytesIO(pdf))
        if len(reader.pages) <= pages:
            return pdf
        w = PdfWriter()
        for i in range(pages):
            w.add_page(reader.pages[i])
        out = io.BytesIO()
        w.write(out)
        return out.getvalue()
    except Exception as e:  # noqa: BLE001
        print(f"  PDFの切り出しに失敗（全ページで続行）: {e}", file=sys.stderr)
        return pdf


# ---------- AI採点 ----------

SYSTEM = """あなたは日本株の短期トレーダーを手伝うアナリストです。TDnetの適時開示PDFを読み、
株価が強く上に反応しそうな「バカアツIR」かどうかを100点満点で採点します。

採点基準（合計100点）:
1. サプライズの大きさ 40点: 経常・営業利益の上方修正率（+30%以上で高得点）、市場予想（コンセンサス）超えの度合い、
   増配率（+30%以上で高得点）、TOB・MBOのプレミアム（30%以上で高得点）、自社株買いの規模（時価総額比5%以上で高得点）、
   特別利益・純利益の増加額の時価総額比（20%以上で高得点）。
2. 時価総額の小ささ 20点: 300億円未満=20、1,000億円未満=15、3,000億円未満=10、それ以上=5。不明なら10。
3. 材料の質 15点: 本業由来・通期・継続性ありは高く、一過性の特別利益・四半期だけの上振れは低く。
4. 織り込み度 15点: 直近1か月で上がっていない、修正後PERが割安になるほど高く。すでに急騰済みなら低く。
5. 種類ボーナス 10点: TOB・MBO・大型受注・業態の変化・資本提携など。

注意:
- 上方修正でも市場予想未達・織り込み済み・増益の減速は売られやすい。慎重に減点する。
- 下方修正・減配・赤字転落など悪材料は is_negative=true とし、点数は0〜20にする。
- 15:00〜15:30の引け前発表は当日中に反応して翌朝伸びにくい。15:30以降・朝8:30〜9:00の発表は翌朝・当日寄りの候補。
- 目標株価はあくまで目安。修正後EPS×同業PER、TOB価格、配当利回りなど根拠を必ず書く。
- 書いてない数字を作らない。PDFから読めない値は「不明」と書く。
- 文章は日本語、簡潔に。"""

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "score", "breakdown", "is_negative", "summary", "surprise",
        "reaction", "target_price", "target_reason", "timing",
    ],
    "properties": {
        "score": {"type": "integer"},
        "breakdown": {"type": "string", "description": "5項目それぞれの点数と一言"},
        "is_negative": {"type": "boolean"},
        "summary": {"type": "string", "description": "開示の要点（3行以内）"},
        "surprise": {"type": "string", "description": "何がサプライズか（修正幅・増配率・TOBプレミアム等の数字）"},
        "reaction": {"type": "string", "description": "株価がどう反応しそうか"},
        "target_price": {"type": "string", "description": "目安の目標株価（円）。出せなければ「不明」"},
        "target_reason": {"type": "string"},
        "timing": {"type": "string", "enum": ["翌朝の寄り向き", "当日場中", "不明"]},
    },
}


def score(client: anthropic.Anthropic, model: str, item: dict, pdf_b64: str, mkt: dict) -> dict:
    ctx = (
        f"銘柄: {item['code']} {item['name']}\n"
        f"開示時刻: {item['time']}\n"
        f"タイトル: {item['title']}\n"
        f"株価: {mkt['price']} 円 / 時価総額: {mkt['market_cap_oku']} 億円 / 直近1か月の騰落: {mkt['chg_1m_pct']} %\n"
        "このPDFを採点してください。"
    )
    resp = client.beta.messages.create(
        model=model,
        max_tokens=16000,
        system=SYSTEM,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": SCHEMA}},
        messages=[{
            "role": "user",
            "content": [
                {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": pdf_b64}},
                {"type": "text", "text": ctx},
            ],
        }],
    )
    u = resp.usage
    TOKENS.setdefault(model, [0, 0])
    TOKENS[model][0] += u.input_tokens
    TOKENS[model][1] += u.output_tokens
    if resp.stop_reason == "refusal":
        raise RuntimeError("モデルが回答を拒否しました")
    text = "".join(b.text for b in resp.content if b.type == "text")
    return json.loads(text)


# ---------- 通知 ----------

def notify(item: dict, mkt: dict, res: dict) -> None:
    title = f"🔥 バカアツIR {res['score']}点｜{item['code']} {item['name']}"
    desc = (
        f"**{item['time']}** {item['title']}\n[TDnetのPDF]({item['pdf']})\n\n"
        f"**要点**\n{res['summary']}\n\n"
        f"**サプライズ**\n{res['surprise']}\n\n"
        f"**株価・時価総額**\n{mkt['price']}円 / {mkt['market_cap_oku']}億円（1か月 {mkt['chg_1m_pct']}%）\n\n"
        f"**反応予想（{res['timing']}）**\n{res['reaction']}\n\n"
        f"**目安の目標株価** {res['target_price']}\n{res['target_reason']}\n\n"
        f"採点内訳: {res['breakdown']}\n※発注はしません。判断はご自身で。"
    )
    payload = {"embeds": [{"title": title[:256], "description": desc[:4000], "color": 0xE8452C}]}
    if DRY_RUN:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    r = requests.post(os.environ["DISCORD_WEBHOOK_URL"], json=payload, timeout=20)
    r.raise_for_status()


# ---------- メイン ----------

def main() -> None:
    now = dt.datetime.now(JST)
    if os.environ.get("FORCE") != "1" and not in_window(now):
        print("時間外のため終了")
        return
    day = os.environ.get("TARGET_DATE") or now.strftime("%Y%m%d")
    seen, notified = load_seen(day)
    items = fetch_list(day)
    new = [it for it in items if it["id"] not in seen]
    print(f"{day}: 一覧 {len(items)} 件 / 新着 {len(new)} 件")

    client = anthropic.Anthropic()
    done = 0
    for it in new:
        if not title_ok(it["title"]):
            seen.add(it["id"])
            continue
        if done >= MAX_PER_RUN:
            break  # 残りは次回
        done += 1
        try:
            pdf = trim_pdf(requests.get(it["pdf"], headers=UA, timeout=60).content, MAX_PAGES)
            b64 = base64.standard_b64encode(pdf).decode()
            mkt = market_info(it["code"])
            if SCREEN_MODEL:
                first = score(client, SCREEN_MODEL, it, b64, mkt)
                print(f"  一次 {first['score']:>3} {it['code']} {it['title']}")
                if first["score"] < SCREEN_THRESHOLD or first["is_negative"]:
                    seen.add(it["id"])
                    continue
            res = score(client, FINAL_MODEL, it, b64, mkt)
            print(f"  本採点 {res['score']:>3} {it['code']} {it['name']} {it['title']}")
            if res["score"] >= THRESHOLD and not res["is_negative"]:
                if it["code"] in notified:
                    print("    同じ銘柄はこの日すでに通知済みのため省略")
                else:
                    notify(it, mkt, res)
                    notified.add(it["code"])
            seen.add(it["id"])
        except anthropic.BadRequestError as e:
            print(f"  失敗 {it['code']} {it['title']}: {e}", file=sys.stderr)
            if "credit balance" in str(e):
                print("APIのクレジット残高不足のため中断します", file=sys.stderr)
                save_seen(day, seen, notified)
                sys.exit(1)
        except Exception as e:  # noqa: BLE001
            # 失敗したものは既読にせず次回やり直す
            print(f"  失敗 {it['code']} {it['title']}: {e}", file=sys.stderr)
        finally:
            save_seen(day, seen, notified)
    save_seen(day, seen, notified)
    total = 0.0
    for m, (i, o) in TOKENS.items():
        pi, po = PRICE.get(m, (4, 20))
        cost = i / 1e6 * pi + o / 1e6 * po
        total += cost
        print(f"使用量 {m}: 入力 {i:,} / 出力 {o:,} トークン ≈ ${cost:.3f}")
    if TOKENS:
        print(f"今回の費用の目安: ${total:.3f}（約{total*150:.0f}円）")


if __name__ == "__main__":
    main()
