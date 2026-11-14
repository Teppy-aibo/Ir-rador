/**
 * 5分足を記録シートに書き出す（Claudeがチャート画像を作るため・11/13）
 * 使い方: このファイルを Ir-rador プロジェクトに追加して dump5m を1回実行。
 *   シート「adv5m」に、DUMP5M_CODES の銘柄の直近60日の5分足（Yahooの上限）を書き出す。
 *   書き出したらClaudeに「書き出した」と伝えるだけ。毎回上書きなので何度実行してもよい。
 * 使うもの: UA（IR通知.gs）、book_（IR通知.gs）
 */
const DUMP5M_CODES = ['6857', '4062', '8035', '285A', '7011', '5803', '5801', '6920', '6146', '9984'];

function dump5m() {
  const rows = [['code', 'date', 'time', 'open', 'high', 'low', 'close', 'volume']];
  DUMP5M_CODES.forEach(code => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}.T?range=60d&interval=5m`;
    const r = UrlFetchApp.fetch(url, { headers: UA, muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) { Logger.log(`${code}: 取得失敗 ${r.getResponseCode()}`); return; }
    const res = JSON.parse(r.getContentText()).chart.result;
    if (!res || !res[0].timestamp) { Logger.log(`${code}: データなし`); return; }
    const q = res[0].indicators.quote[0];
    res[0].timestamp.forEach((ts, i) => {
      if (q.open[i] == null || q.close[i] == null) return;
      const t = new Date(ts * 1000);
      rows.push([code, Utilities.formatDate(t, 'Asia/Tokyo', 'yyyyMMdd'), Utilities.formatDate(t, 'Asia/Tokyo', 'HH:mm'),
        q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i] || 0]);
    });
  });
  const ss = book_();
  const sh = ss.getSheetByName('adv5m') || ss.insertSheet('adv5m');
  sh.clearContents();
  sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  Logger.log(`adv5m に ${rows.length - 1} 行を書き出しました`);
}
