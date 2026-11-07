# Ir-rador

TDnetの新着適時開示を平日8:30〜20:00に5分おきにチェックし、AIがPDFを読んで100点満点で採点、
85点以上の「熱い開示」だけをDiscordに通知します。**発注は一切しません。**

## 仕組み

1. TDnetの当日一覧を取得（取れなければ予備のやのしんAPI）。既読は `state/seen.json` で除外。
2. タイトルで絞り込み（業績予想・配当・TOB・自社株買いなど）。
3. PDFと株価・時価総額をAIに渡して採点（基準は `main.py` の `SYSTEM`）。
4. 85点以上だけDiscordへ通知：要点／サプライズ／時価総額と株価／反応予想（翌朝向きか場中か）／目安の目標株価。

## 初期設定（iPadのSafariでできます）

Settings → Secrets and variables → Actions → **Secrets** に登録:

| 名前 | 中身 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic ConsoleのAPIキー |
| `DISCORD_WEBHOOK_URL` | DiscordのWebhook URL |

任意で同じ画面の **Variables** に登録できるもの:

| 名前 | 既定 | 意味 |
|---|---|---|
| `THRESHOLD` | 85 | 通知する点数 |
| `FINAL_MODEL` | claude-opus-5-5 | 採点に使うモデル |
| `SCREEN_MODEL` | claude-haiku-5-5 | 一次採点用の安いモデル。70点以上（と買われる側のTOB・MBO）だけ `FINAL_MODEL` で本採点 |
| `MAX_PAGES` | 4 | AIに渡すPDFの先頭ページ数 |

## テスト実行

Actions → ir-rador → Run workflow。`dry_run=1` なら通知せずログに結果だけ出ます。
`target_date` に過去の日付（例 `20261030`）、`threshold` を低く（例 `60`）すれば過去分で試せます。

## 安全のために

- APIキーはコードに書かず必ずSecretsへ。Anthropic Consoleで月の利用上限を設定しておく。
- 目標株価はAIの目安です。投資判断はご自身で。

## 答え合わせ（自動）

`main.py` は本採点した開示をすべて `state/calls.csv` に記録します。
平日16:10に `review.py`（ワークフロー answer-check）が動き、反応した日の値動きを `state/results.csv` に追記して、Discordに送ります。

- 寄り（ギャップ）と終値：前日終値比（場中の開示は通知時の株価比）
- 9:30までの高値・安値：寄り値比。高値が+2%以上なら「+2%到達」
- 点数別（95点以上／85〜94点／70〜84点／70点未満）の平均を毎回集計。通知の基準を決める材料にします。

## セクターローテ記録（無料・AIなし）

`sector.py`（ワークフロー sector-rotation）が平日16:20に東証17業種ETF（1617〜1633）をTOPIX（1306）と比べて記録し、Discordに送ります。
APIキーは不要（Yahoo Financeの日足だけ）。

- `state/sector_daily.csv`：業種ごとの1日・5日・20日の騰落率、TOPIX比、売買代金の20日平均比、順位、局面
- `state/regime_daily.csv`：その日の地合い（全面高／全面安／半導体主導／ローテーション）と強い・弱い業種
- 局面＝20日のTOPIX比（強さ）×5日のTOPIX比（勢い）
  - 🟢主導（強い・勢いあり）→ 🟡失速（強いが勢い低下）→ 🔴出遅れ → 🔵改善（弱いが勢いが出てきた＝次の行き先候補）
- 通知先を分けたいときは Secrets に `SECTOR_WEBHOOK_URL` を登録（なければ `DISCORD_WEBHOOK_URL` に送ります）

初回だけ Actions → sector-rotation → Run workflow で `backfill_days` を `200` にすると、過去200営業日分をまとめて記録します。
※業種ETFは売買が薄い日があり、売買代金の倍率はブレやすいので目安です。
