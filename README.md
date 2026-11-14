# Ir-rador

> いまの通知は Google Apps Script 版（`apps-script/IR通知.gs`）で動いています。GitHub 側の定時実行は 2026-11-12 に止めました。

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

## そのほかのフォルダ

- `apps-script/` … Google Apps Script に貼っているコードの控え（履歴を残すため。詳しくは中の README）。
- `checks/` と Actions の **heavy-check** … Apps Script の6分制限では回らない重い検証を、**手動で1回だけ**動かす。
  Actions → heavy-check → Run workflow で検証と対象を選ぶ。結果はその実行の Summary（表）と Artifacts（CSV）に出る。定時実行・自動コミットはしない。
  - `week_flow` … 週の中の流れ（型12〜14: 木曜までが仕掛け・金曜の締め・週の途中の下げ）を日足6年分で検証。型12の比べる基準（リスクオン中にどの曜日に買っても4日持つ）も出す。
  - `bnf_stage` … BNFの6段階（大きく動いた日の引けで買い→翌日の寄り/引けで売る。上げの日と下げの日、出来高2倍・引けの位置つき）を日足6年分で検証。
