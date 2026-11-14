/**
 * 注力銘柄の1分足を毎日自動で保存する（Google Apps Script・無料）
 * 目的: 2〜4週間ためて、ユーザーの型（先導株の底打ち・後場の利確売り・前場高値の再テスト）と
 *       銘柄ごとの押しの深さを数字で検証する。Yahooの1分足は直近7日分しか取れないので、毎日ためるしかない。
 *
 * 使い方（同じ Ir-rador プロジェクトに「ファイル ＋ → スクリプト」で追加）:
 *  1. setupBars1m を1回実行 → 保存先のスプレッドシート「Ir-rador 1分足」を作り、平日15:45の自動保存を登録し、
 *     ついでに直近7日分をまとめて保存する（ログに保存先のURLが出る）
 *  2. あとは毎日自動。手で取りたいときは saveBars1m、7日分を取り直すときは backfillBars1m
 *
 * 使うもの: KUSE_CODES（クセ表.gs）、UA（IR通知.gs）、isTradingDay_（答え合わせ.gs）
 * 保存先: 別のスプレッドシート（記録シートを重くしないため）。銘柄ごとにシートを分ける（シート名=コード）
 *   列: date, time, open, high, low, close, volume
 *   1銘柄 1日 約330行 → 1年で約8万行。Googleスプレッドシートの上限（1,000万セル）まで数年もつ。
 */

const B1_EXTRA = { '9984': 'SBG', '1306': 'TOPIX ETF', '1321': '日経225 ETF' };
const B1_HEADER = ['date', 'time', 'open', 'high', 'low', 'close', 'volume'];

function b1Codes_() {
  return Object.assign({}, typeof KUSE_CODES !== 'undefined' ? KUSE_CODES : {}, B1_EXTRA);
}

function b1Book_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('BARS1M_SHEET_ID');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) { Logger.log('保存先が開けないので作り直します: ' + e); } }
  const ss = SpreadsheetApp.create('Ir-rador 1分足');
  props.setProperty('BARS1M_SHEET_ID', ss.getId());
  Logger.log('保存先を作りました: ' + ss.getUrl());
  return ss;
}

function setupBars1m() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'saveBars1m').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('saveBars1m').timeBased().everyDays(1).atHour(15).nearMinute(45).inTimezone('Asia/Tokyo').create();
  Logger.log('平日15:45ごろに saveBars1m を登録しました');
  backfillBars1m();
  Logger.log('保存先: ' + b1Book_().getUrl());
}

/** 毎日の保存（当日分） */
function saveBars1m() {
  const now = new Date();
  if (!isTradingDay_(now)) return;
  b1Save_('1d');
}

/** 直近7日分をまとめて保存（初回・取りこぼしたとき） */
function backfillBars1m() { b1Save_('7d'); }

function b1Save_(range) {
  const ss = b1Book_(), codes = b1Codes_();
  const keys = Object.keys(codes);
  const resps = UrlFetchApp.fetchAll(keys.map(c => ({
    url: `https://query1.finance.yahoo.com/v8/finance/chart/${c}.T?range=${range}&interval=1m`, headers: UA, muteHttpExceptions: true })));
  const props = PropertiesService.getScriptProperties();
  const done = JSON.parse(props.getProperty('BARS1M_DONE') || '{}'); // code -> [保存済みの日付]
  resps.forEach((r, j) => {
    const code = keys[j];
    let res;
    try { res = JSON.parse(r.getContentText()).chart.result; } catch (e) { Logger.log(`${code}: 読めませんでした`); return; }
    if (!res || !res[0].timestamp) { Logger.log(`${code}: データなし`); return; }
    const q = res[0].indicators.quote[0], have = new Set(done[code] || []), rows = [], days = new Set();
    res[0].timestamp.forEach((ts, i) => {
      if (q.open[i] == null || q.close[i] == null) return;
      const d = new Date(ts * 1000), day = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyyMMdd');
      const hm = Utilities.formatDate(d, 'Asia/Tokyo', 'HH:mm');
      if (have.has(day) || hm < '09:00' || hm > '15:30') return;
      rows.push([day, hm, q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i] || 0]);
      days.add(day);
    });
    // 当日分は大引けの値がそろってから（15:31以降）でないと確定扱いにしない
    const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
    const nowHm = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'HH:mm');
    if (days.has(today) && nowHm < '15:31') {
      days.delete(today);
      for (let k = rows.length - 1; k >= 0; k--) if (rows[k][0] === today) rows.splice(k, 1);
    }
    if (!rows.length) { Logger.log(`${code} ${codes[code]}: 新しい足なし`); return; }
    let sh = ss.getSheetByName(code);
    if (!sh) { sh = ss.insertSheet(code); sh.appendRow(B1_HEADER); }
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, B1_HEADER.length).setValues(rows);
    done[code] = [...have, ...days].sort().slice(-40);
    Logger.log(`${code} ${codes[code]}: ${[...days].sort().join(',')} を ${rows.length}本 保存`);
  });
  props.setProperty('BARS1M_DONE', JSON.stringify(done));
  const first = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (first && ss.getSheets().length > 1) ss.deleteSheet(first);
}
