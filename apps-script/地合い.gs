/**
 * 朝の地合いスナップショット＋注目IR銘柄の5分足保存（Google Apps Script版）
 * IR通知.gs・答え合わせ.gs と同じプロジェクトに「ファイル ＋ → スクリプト」で追加して使う。
 * 初回だけ「setupMarket」を実行 → 平日 8:00（地合い）と 16:30（5分足）に自動で動きます。
 *
 * regime シート（毎朝1行）:
 *   前夜の米国（SOX・ナスダック・ダウ・S&P500）、ドル円、日経先物（CME）、VIX、
 *   前日の17業種のTOPIX比（上位3・下位3）、上昇業種数、地合いの見立て
 * sectors シート（毎朝17行）: 前日の業種別の騰落率・TOPIX比・5日/20日のTOPIX比・局面
 * bars5m シート: 70点以上だった開示の銘柄について、反応日の 9:00〜10:30 の5分足
 */

const US = { SOX: '^SOX', ナスダック: '^IXIC', ダウ: '^DJI', 'S&P500': '^GSPC', VIX: '^VIX', ドル円: 'JPY=X', 日経先物: 'NIY=F', 日経平均: '^N225' };
const SECTORS = {
  '1617': '食品', '1618': 'エネルギー資源', '1619': '建設・資材', '1620': '素材・化学', '1621': '医薬品',
  '1622': '自動車・輸送機', '1623': '鉄鋼・非鉄', '1624': '機械', '1625': '電機・精密', '1626': '情報通信・サービス',
  '1627': '電力・ガス', '1628': '運輸・物流', '1629': '商社・卸売', '1630': '小売', '1631': '銀行',
  '1632': '金融（除く銀行）', '1633': '不動産',
};
const REGIME_HEADER = ['date', 'SOX', 'ナスダック', 'ダウ', 'S&P500', 'VIX', 'ドル円', 'ドル円_chg', '日経先物', '先物_vs_日経終値',
  '前日_上昇業種数', '前日_強い業種', '前日_弱い業種', '主導', '改善', '見立て'];
const SECTOR_HEADER = ['date', 'code', 'name', 'ret1', 'rel1', 'rel5', 'rel20', 'phase'];
const BAR_HEADER = ['date', 'code', 'time', 'open', 'high', 'low', 'close', 'volume', 'score', 'call_id'];

function setupMarket() {
  ScriptApp.getProjectTriggers().filter(t => ['morning', 'saveBars'].includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('morning').timeBased().everyDays(1).atHour(8).nearMinute(0).inTimezone('Asia/Tokyo').create();
  ScriptApp.newTrigger('saveBars').timeBased().everyDays(1).atHour(16).nearMinute(30).inTimezone('Asia/Tokyo').create();
  sheet_('regime', REGIME_HEADER); sheet_('sectors', SECTOR_HEADER); sheet_('bars5m', BAR_HEADER);
  Logger.log('毎朝8:00の地合いと、16:30の5分足保存を登録しました');
}

/** テスト: 保存・通知せずログに出す */
function testMorning() { morning_(true); }
function morning() { morning_(false); }
/** 送り直し: シートには書かず、Discordにだけ送る（通知が来なかった朝に手動で実行） */
function resendMorning() { morning_(false, true); }

/** Discordへ送る。失敗したら最大3回やり直し、理由を実行ログに残す（失敗してもシートの記録は残る） */
function postDiscordSafe_(payload) {
  const url = P.getProperty('SECTOR_WEBHOOK_URL') || P.getProperty('DISCORD_WEBHOOK_URL');
  for (let i = 0; i < 3; i++) {
    const r = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json',
      payload: JSON.stringify(payload), muteHttpExceptions: true });
    const code = r.getResponseCode();
    if (code < 300) { Logger.log(`Discord送信OK (${code})`); return true; }
    Logger.log(`Discord送信失敗 ${code}: ${r.getContentText().slice(0, 300)}`);
    let wait = 2000 * (i + 1);
    try { wait = Math.max(wait, Math.ceil(JSON.parse(r.getContentText()).retry_after * 1000) || 0); } catch (e) {}
    Utilities.sleep(Math.min(wait, 20000));
  }
  return false;
}

/** 日足（終値の配列）を取る */
function daily_(sym, range) {
  const r = UrlFetchApp.fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range || '3mo'}&interval=1d`,
    { headers: UA, muteHttpExceptions: true });
  const res = JSON.parse(r.getContentText()).chart.result;
  if (!res) return [];
  const q = res[0].indicators.quote[0];
  return (res[0].timestamp || []).map((ts, i) => ({ d: Utilities.formatDate(new Date(ts * 1000), 'Asia/Tokyo', 'yyyyMMdd'), c: q.close[i] }))
    .filter(b => b.c != null);
}

/** 株式分割の補正: 前日比が-45%超や+80%超に飛んだ日を分割とみなし、それより前の値を割り戻す（Yahooが未補正のことがある） */
function splitAdj_(b, key) {
  const f = [2, 3, 4, 5, 10, 20, 0.5, 1 / 3, 0.25, 0.2, 0.1];
  for (let i = b.length - 1; i > 0; i--) {
    const now = key === 'o' && b[i].o != null ? b[i].o : b[i].c, r = now / b[i - 1].c;
    if (r > 0.55 && r < 1.8) continue;
    const k = f.find(x => Math.abs(r * x - 1) < 0.15);
    if (!k) continue;
    for (let j = 0; j < i; j++) ['o', 'h', 'l', 'c'].forEach(p => { if (b[j][p] != null) b[j][p] /= k; });
  }
  return b;
}

const chg_ = (b, n) => b.length > n ? Math.round((b[b.length - 1].c / b[b.length - 1 - n].c - 1) * 10000) / 100 : '';

function morning_(dry, resendOnly) {
  const now = new Date();
  if (!dry && !resendOnly && !isTradingDay_(now)) return;
  const today = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMdd');

  // 前夜の米国・為替・先物
  const us = {};
  Object.entries(US).forEach(([k, s]) => { try { us[k] = daily_(s, '1mo'); } catch (e) { us[k] = []; } });
  const last = k => us[k].length ? us[k][us[k].length - 1].c : '';
  // ^N225 の日足は最終日が欠けることがある（11/11朝に前々日の終値で+2.42%と誤表示）→ meta の最新値を優先
  let nkClose = last('日経平均');
  try {
    const m = JSON.parse(UrlFetchApp.fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EN225?range=5d&interval=1d',
      { headers: UA, muteHttpExceptions: true }).getContentText()).chart.result[0].meta;
    if (m.regularMarketPrice) nkClose = m.regularMarketPrice;
  } catch (e) { Logger.log('日経終値(meta): ' + e); }
  const fut = last('日経先物');

  // 前日の業種（TOPIX連動ETF 1306 比）
  const bench = splitAdj_(daily_('1306.T'));
  const rows = [];
  Object.entries(SECTORS).forEach(([code, name]) => {
    try {
      const b = splitAdj_(daily_(code + '.T'));
      if (b.length < 22 || bench.length < 22) return;
      const rel = n => Math.round((chg_(b, n) - chg_(bench, n)) * 100) / 100;
      const r5 = rel(5), r20 = rel(20);
      const phase = r20 >= 0 ? (r5 >= 0 ? '主導' : '失速') : (r5 >= 0 ? '改善' : '出遅れ');
      rows.push({ date: b[b.length - 1].d, code, name, ret1: chg_(b, 1), rel1: rel(1), rel5: r5, rel20: r20, phase });
    } catch (e) { Logger.log(`${code}: ${e}`); }
  });
  rows.sort((a, b) => b.rel1 - a.rel1);
  const up = rows.filter(r => r.ret1 > 0).length;
  const names = (list) => list.map(r => r.name).join('、');

  // 見立て（寄り前の目安。答え合わせはトレード台帳の地合いと照らす）
  // G7（大幅窓の寄り売り）の出番: TOPIX ETF 1306 が75日線より下の日だけ
  let g7 = 'G7 判定できず';
  try {
    const t = splitAdj_(daily_('1306.T', '6mo'));
    if (t.length >= 75) {
      const c = t[t.length - 1].c, ma = t.slice(-75).reduce((s, b) => s + b.c, 0) / 75, dev = Math.round((c / ma - 1) * 1000) / 10;
      g7 = c < ma ? `🩳 **G7 出番あり**: TOPIX ETF が75日線の下（${dev}%）→ 8:59気配+8〜20%の窓は寄り成売り・損切り2%・利確2R・引け成`
        : `G7 出番なし（TOPIX ETF が75日線の上 +${dev}%）`;
    }
  } catch (e) { Logger.log('G7判定: ' + e); }
  const sox = chg_(us.SOX, 1), nas = chg_(us.ナスダック, 1), gap = (fut && nkClose) ? Math.round((fut / nkClose - 1) * 10000) / 100 : '';
  let view = 'ローテーション';
  if (gap !== '' && gap <= -1.5) view = '全面安';
  else if (gap !== '' && gap >= 1.5 && sox >= 1.5) view = '半導体主導（全面高寄り）';
  else if (sox >= 2) view = '半導体主導';
  else if (sox <= -2) view = '半導体安→ほかへのローテーション';
  else if (gap !== '' && gap >= 1.5) view = '全面高';

  const reg = {
    date: today, SOX: sox, ナスダック: nas, ダウ: chg_(us.ダウ, 1), 'S&P500': chg_(us['S&P500'], 1), VIX: last('VIX'),
    ドル円: last('ドル円') && Math.round(last('ドル円') * 100) / 100, ドル円_chg: chg_(us.ドル円, 1),
    日経先物: fut, 先物_vs_日経終値: gap, 前日_上昇業種数: up,
    前日_強い業種: names(rows.slice(0, 3)), 前日_弱い業種: names(rows.slice(-3).reverse()),
    主導: names(rows.filter(r => r.phase === '主導')), 改善: names(rows.filter(r => r.phase === '改善')), 見立て: view,
  };
  Logger.log(JSON.stringify(reg));

  const sign = v => v === '' ? '—' : `${v >= 0 ? '+' : ''}${v}%`;
  const desc = `**見立て: ${view}**\n` +
    `SOX ${sign(reg.SOX)} / ナスダック ${sign(reg.ナスダック)} / ダウ ${sign(reg.ダウ)} / VIX ${typeof reg.VIX === 'number' ? reg.VIX.toFixed(1) : '—'}\n` +
    `ドル円 ${reg.ドル円 || '—'}（${sign(reg.ドル円_chg)}）/ 日経先物 ${fut ? Math.round(fut) : '—'}（日経終値比 ${sign(gap)}）\n\n` +
    `**前日の業種**（上昇 ${up}/${rows.length}）\n📈 ${reg.前日_強い業種}\n📉 ${reg.前日_弱い業種}\n` +
    `🟢主導: ${reg.主導 || 'なし'}\n🔵改善（次の候補）: ${reg.改善 || 'なし'}\n\n${g7}`;
  // 7:45 の局面ログ（局面ログ.gs）があれば、その一言を最後に載せる（詳しい方は局面チャンネル）
  let kl = '';
  try {
    const ks = book_().getSheetByName('kyokumen');
    if (ks && ks.getLastRow() >= 2) {
      const h = ks.getRange(1, 1, 1, ks.getLastColumn()).getValues()[0], v = ks.getRange(ks.getLastRow(), 1, 1, h.length).getValues()[0];
      const g = k => v[h.indexOf(k)];
      if (String(g('date')) === today && g('まとめ_ラベル'))
        kl = `\n\n🧭 **局面: ${g('まとめ_ラベル')}**（自信 ${g('まとめ_自信')}・機械 ${g('機械ラベル')}）${g('一言') ? ' ' + g('一言') : ''}`;
    }
  } catch (e) { Logger.log('局面ログの読み取り: ' + e); }
  const payload = { embeds: [{ title: `🌅 朝の地合い ${Utilities.formatDate(now, 'Asia/Tokyo', 'MM/dd')}`, description: (desc + kl).slice(0, 4000), color: 0x10B981 }] };
  if (dry) { Logger.log(desc); return; }
  if (resendOnly) { postDiscordSafe_(payload); return; }

  // 先にDiscordへ送る（送信に失敗してもシートの記録は必ず残す）
  const sent = postDiscordSafe_(payload);
  sheet_('regime', REGIME_HEADER).appendRow(REGIME_HEADER.map(h => reg[h]));
  const sh = sheet_('sectors', SECTOR_HEADER);
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, SECTOR_HEADER.length).setValues(rows.map(r => SECTOR_HEADER.map(h => r[h])));
  if (!sent) throw new Error('朝の地合いをDiscordに送れませんでした（シートには記録済み）。実行ログの「Discord送信失敗」の理由を確認してください');
}

/** 16:30: 今日が反応日だった70点以上の開示の銘柄について、9:00〜10:30の5分足を保存 */
function saveBars() {
  const now = new Date();
  if (!isTradingDay_(now)) return;
  const today = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMdd');
  const done = new Set(rows_('bars5m').filter(r => r.date === today).map(r => r.code));
  const targets = {};
  rows_('calls').forEach(c => {
    if (Number(c.score) < 70) return;
    const [rday] = reactionDay_(c.date, c.time);
    if (Utilities.formatDate(rday, 'Asia/Tokyo', 'yyyyMMdd') !== today || done.has(c.code)) return;
    targets[c.code] = targets[c.code] || c;
  });
  const t1 = Math.floor(now.getTime() / 1000), t0 = t1 - 12 * 3600;
  const out = [];
  Object.values(targets).forEach(c => {
    try {
      const r = UrlFetchApp.fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${c.code}.T?interval=5m&period1=${t0}&period2=${t1}`,
        { headers: UA, muteHttpExceptions: true });
      const res = JSON.parse(r.getContentText()).chart.result[0], q = res.indicators.quote[0];
      (res.timestamp || []).forEach((ts, i) => {
        const d = new Date(ts * 1000), hm = Utilities.formatDate(d, 'Asia/Tokyo', 'HH:mm');
        if (Utilities.formatDate(d, 'Asia/Tokyo', 'yyyyMMdd') !== today || hm >= '10:30' || q.open[i] == null) return;
        out.push([today, c.code, hm, q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i], c.score, c.id]);
      });
    } catch (e) { Logger.log(`${c.code}: ${e}`); }
  });
  if (out.length) {
    const sh = sheet_('bars5m', BAR_HEADER);
    sh.getRange(sh.getLastRow() + 1, 1, out.length, BAR_HEADER.length).setValues(out);
  }
  Logger.log(`5分足を保存: ${Object.keys(targets).length}銘柄 ${out.length}本`);
}
