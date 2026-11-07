# Ir-rador

TDnetの新着適時開示を平日8:30〜20:00に5分おきにチェックし、AIがPDFを読んで100点満点で採点、
95点以上の「熱い開示」だけをDiscordに通知します。**発注は一切しません。**

## 仕組み

1. TDnetの当日一覧を取得（取れなければ予備のやのしんAPI）。既読は `state/seen.json` で除外。
2. タイトルで絞り込み（業績予想・配当・TOB・自社株買いなど）。
3. PDFと株価・時価総額をAIに渡して採点（基準は `main.py` の `SYSTEM`）。
4. 95点以上だけDiscordへ通知：要点／サプライズ／時価総額と株価／反応予想（翌朝向きか場中か）／目安の目標株価。

## 初期設定（iPadのSafariでできます）

Settings → Secrets and variables → Actions → **Secrets** に登録:

| 名前 | 中身 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic ConsoleのAPIキー |
| `DISCORD_WEBHOOK_URL` | DiscordのWebhook URL |

任意で同じ画面の **Variables** に登録できるもの:

| 名前 | 既定 | 意味 |
|---|---|---|
| `THRESHOLD` | 95 | 通知する点数 |
| `FINAL_MODEL` | claude-opus-5-5 | 採点に使うモデル |
| `SCREEN_MODEL` | claude-haiku-5-5 | 一次採点用の安いモデル。60点以上（と買われる側のTOB・MBO）だけ `FINAL_MODEL` で本採点 |
| `MAX_PAGES` | 4 | AIに渡すPDFの先頭ページ数 |

## テスト実行

Actions → ir-rador → Run workflow。`dry_run=1` なら通知せずログに結果だけ出ます。
`target_date` に過去の日付（例 `20261030`）、`threshold` を低く（例 `60`）すれば過去分で試せます。

## 安全のために

- APIキーはコードに書かず必ずSecretsへ。Anthropic Consoleで月の利用上限を設定しておく。
- 目標株価はAIの目安です。投資判断はご自身で。
