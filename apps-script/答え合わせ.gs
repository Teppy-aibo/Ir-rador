/**
 * 答え合わせ（Google Apps Script版）
 * IR通知.gs と同じプロジェクトに「ファイル ＋ → スクリプト」で追加して使う。
 * 本採点した開示（calls シート）が、反応する日にどう動いたかを results シートに記録してDiscordに送る。
 *
 * 初回だけ: 関数の選択で「setupReview」を実行 → 平日16:10に自動で動きます。
 *
 * 反応日: 9:00前の開示→その日 / 15:30以降→次の取引日 / 場中→その日（基準は通知時の株価）
 * 記録: 寄りのギャップ（前日終値比）、9:30までの高値・安値（寄り値比）、終値、+2%到達
 * 場中の開示は、通知時刻から30分の高値・安値（通知時の株価比）を同じ欄に入れ、集計は別の行に分ける
 */

const RESULT_HEADER = ['id', 'date', 'time', 'code', 'name', 'score', 'notified', 'mode', 'reaction_day',
  'base', 'open', 'gap_pct', 'high_0930_pct', 'low_0930_pct', 'close_pct', 'hit_2pct', 'note', 'is_negative'];

function setupReview() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'review').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('review').timeBased().everyDays(1).atHour(16).nearMinute(10).inTimezone('Asia/Tokyo').create();
  sheet_('results', RESULT_HEADER);
  Logger.log('毎日16:10ごろの答え合わせを登録しました（休場日は何もしません）');
}

/** テスト: Discordに送らずログに出す */
function testReview() { review_(true); }

function review() { review_(false); }

function isTradingDay_(d) {
  const dow = Number(Utilities.formatDate(d, 'Asia/Tokyo', 'u'));
  if (dow >= 6) return false;
  const md = Utilities.formatDate(d, 'Asia/Tokyo', 'MMdd');
  if (['0101', '0102', '0103', '1231'].includes(md)) return false;
  const cal = CalendarApp.getCalendarById('ja.japanese#holiday@group.v.calendar.google.com');
  return !(cal && cal.getEventsForDay(d).length);
}

function ymdToDate_(ymd) {
  return new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T12:00:00+09:00`);
}

function nextTradingDay_(d) {
  const x = new Date(d.getTime());
  do { x.setTime(x.getTime() + 86400e3); } while (!isTradingDay_(x));
  return x;
}

function reactionDay_(ymd, hm) {
  const d = ymdToDate_(ymd);
  if (hm < '09:00') return [isTradingDay_(d) ? d : nextTradingDay_(d), '寄り前'];
  if (hm >= '15:30') return [nextTradingDay_(d), '引け後'];
  return [d, '場中'];
}

const pct_ = (a, b) => Math.round((a / b - 1) * 10000) / 100;

/** Yahoo Financeの公開チャートから、反応日の日足・5分足を取る */
function measure_(code, rday, mode, alertPrice, alertTime) {
  const day = Utilities.formatDate(rday, 'Asia/Tokyo', 'yyyy-MM-dd');
  const t0 = Math.floor(rday.getTime() / 1000) - 15 * 86400, t1 = Math.floor(rday.getTime() / 1000) + 86400;
  const get = (interval, p1) => {
    const r = UrlFetchApp.fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${code}.T?interval=${interval}&period1=${p1}&period2=${t1}`,
      { headers: UA, muteHttpExceptions: true });
    const res = JSON.parse(r.getContentText()).chart.result;
    if (!res) return [];
    const q = res[0].indicators.quote[0];
    return (res[0].timestamp || []).map((ts, i) => ({
      d: Utilities.formatDate(new Date(ts * 1000), 'Asia/Tokyo', 'yyyy-MM-dd'),
      t: Utilities.formatDate(new Date(ts * 1000), 'Asia/Tokyo', 'HH:mm'),
      o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i],
    })).filter(b => b.o != null);
  };
  const daily = get('1d', t0);
  const today = daily.filter(b => b.d === day), prev = daily.filter(b => b.d < day);
  if (!today.length || !prev.length) return { note: '反応日のデータなし' };
  const base = (mode === '場中' && alertPrice) ? Number(alertPrice) : prev[prev.length - 1].c;
  const out = { base: Math.round(base * 10) / 10, open: today[0].o, gap_pct: pct_(today[0].o, base),
    close_pct: pct_(today[0].c, base), note: '' };
  try {
    const all5 = get('5m', t1 - 86400 - 12 * 3600).filter(b => b.d === day && b.v > 0);
    if (mode === '場中' && alertTime) {
      // 通知時刻を含む5分足から30分間（寄り前の値動きは使わない）
      const [h, mi] = String(alertTime).slice(0, 5).split(':').map(Number);
      const st = h * 60 + mi - (h * 60 + mi) % 5, toMin = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
      const win = all5.filter(b => toMin(b.t) >= st && toMin(b.t) < st + 30);
      if (win.length) {
        out.open = win[0].o; out.gap_pct = pct_(win[0].o, base);
        out.high_0930_pct = pct_(Math.max(...win.map(b => b.h)), base);
        out.low_0930_pct = pct_(Math.min(...win.map(b => b.l)), base);
        out.hit_2pct = out.high_0930_pct >= 2 ? 1 : 0;
      } else out.note = '通知後30分の5分足なし';
      return out;
    }
    const bars = all5.filter(b => b.t < '09:30');
    if (bars.length) {
      const o = bars[0].o;
      out.open = o; out.gap_pct = pct_(o, base);
      out.high_0930_pct = pct_(Math.max(...bars.map(b => b.h)), o);
      out.low_0930_pct = pct_(Math.min(...bars.map(b => b.l)), o);
      out.hit_2pct = out.high_0930_pct >= 2 ? 1 : 0;
    } else {
      out.note = '9:30まで寄らず（気配のまま）';
    }
  } catch (e) {
    out.note = `5分足取得失敗 ${e}`.slice(0, 60);
  }
  return out;
}

function rows_(name) {
  const sh = book_().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  const v = sh.getDataRange().getDisplayValues();
  return v.slice(1).map(r => Object.fromEntries(v[0].map((h, i) => [h, r[i]])));
}

function bucket_(s) { return s >= 95 ? '95点以上' : s >= 85 ? '85〜94点' : s >= 70 ? '70〜84点' : '70点未満'; }

function stats_(rows) {
  const g = {}, uniq = new Set();
  // 過去に重複して記録された行も集計では1件に数える（通知した行を優先）
  rows = [...rows].sort((a, b) => Number(b.notified) - Number(a.notified) || Number(b.score) - Number(a.score))
    .filter(r => { const k = `${r.code}|${r.reaction_day}`; if (uniq.has(k)) return false; uniq.add(k); return true; });
  const live = rows.filter(r => r.is_negative !== '1' && r.mode === '場中' && r.close_pct !== '');
  rows.filter(r => r.is_negative !== '1' && r.gap_pct !== '' && r.mode !== '場中').forEach(r => { const b = bucket_(Number(r.score)); (g[b] = g[b] || []).push(r); });
  return ['95点以上', '85〜94点', '70〜84点', '70点未満'].filter(b => g[b]).map(b => {
    const x = g[b], avg = k => x.filter(r => r[k] !== '').reduce((s, r, _, a) => s + Number(r[k]) / a.length, 0);
    const hits = x.filter(r => r.hit_2pct !== '');
    let s = `${b}: ${x.length}件 平均ギャップ ${avg('gap_pct').toFixed(1)}%`;
    if (x.some(r => r.high_0930_pct !== '')) s += ` / 寄り→9:30高値 平均 ${avg('high_0930_pct').toFixed(1)}%`;
    if (hits.length) s += ` / +2%到達 ${hits.filter(r => r.hit_2pct === '1').length}/${hits.length}`;
    return s;
  }).concat(live.length ? [`場中の開示: ${live.length}件 通知後30分高値 平均 ${(live.filter(r => r.high_0930_pct !== '').reduce((a, r, _, x) => a + Number(r.high_0930_pct) / x.length, 0)).toFixed(1)}% / 通知→終値 平均 ${(live.reduce((a, r) => a + Number(r.close_pct) / live.length, 0)).toFixed(1)}%`] : [])
    .join('\n') || 'まだデータがありません';
}

function review_(dry) {
  const now = new Date();
  if (!dry && !isTradingDay_(now)) return;
  const past = rows_('results'), done = new Set(past.map(r => r.id));
  // 同じ銘柄・同じ反応日の開示が複数あっても1件にまとめる（通知したもの→点数の高いものを残す）
  const seenKey = new Set(past.map(r => `${r.code}|${r.reaction_day}`));
  const calls = rows_('calls').sort((a, b) => (Number(b.notified) - Number(a.notified)) || (Number(b.score) - Number(a.score)));
  const fresh = [];
  for (const c of calls) {
    if (done.has(c.id)) continue;
    const [rday, mode] = reactionDay_(c.date, c.time);
    const key = `${c.code}|${Utilities.formatDate(rday, 'Asia/Tokyo', 'yyyyMMdd')}`;
    if (seenKey.has(key)) continue;
    const close = new Date(`${Utilities.formatDate(rday, 'Asia/Tokyo', 'yyyy-MM-dd')}T15:45:00+09:00`);
    if (close > now) continue; // 反応日の大引け後まで待つ
    const m = measure_(c.code, rday, mode, c.price_at_alert, c.time);
    const row = { id: c.id, date: c.date, time: c.time, code: c.code, name: c.name, score: c.score,
      notified: c.notified, mode, reaction_day: Utilities.formatDate(rday, 'Asia/Tokyo', 'yyyyMMdd'),
      is_negative: c.is_negative, ...m };
    fresh.push(row);
    seenKey.add(key);
    Logger.log(JSON.stringify(row));
  }
  if (!fresh.length) { Logger.log('新しく答え合わせできる開示はありません'); return; }
  if (!dry) {
    const sh = sheet_('results', RESULT_HEADER);
    sh.getRange(sh.getLastRow() + 1, 1, fresh.length, RESULT_HEADER.length)
      .setValues(fresh.map(r => RESULT_HEADER.map(h => r[h] === undefined ? '' : String(r[h]))));
  }
  const all = dry ? rows_('results').concat(fresh.map(r => Object.fromEntries(RESULT_HEADER.map(h => [h, r[h] === undefined ? '' : String(r[h])])))) : rows_('results');
  const shown = fresh.filter(r => r.notified === '1' || Number(r.score) >= 80).sort((a, b) => b.score - a.score).slice(0, 15);
  const lines = shown.map(r => {
    let s = `${r.notified === '1' ? '🔔' : '・'} ${r.score}点 ${r.code} ${r.name}（${r.mode}）`;
    if (r.mode === '場中') {
      if (r.high_0930_pct !== undefined) s += ` 通知後30分高値 +${r.high_0930_pct.toFixed(1)}%`;
    } else {
      if (r.gap_pct !== undefined) s += ` 寄り ${r.gap_pct >= 0 ? '+' : ''}${r.gap_pct.toFixed(1)}%`;
      if (r.high_0930_pct !== undefined) s += ` → 9:30高値 +${r.high_0930_pct.toFixed(1)}%`;
    }
    if (r.close_pct !== undefined) s += ` / 終値 ${r.close_pct >= 0 ? '+' : ''}${r.close_pct.toFixed(1)}%`;
    if (r.note) s += `（${r.note}）`;
    return s;
  });
  const desc = (lines.join('\n') || '80点以上の開示はありませんでした') +
    `\n\n**これまでの集計（点数別）**\n${stats_(all)}\n\n※寄り・終値は前日終値比、9:30高値は寄り値比（場中の開示は通知時の株価比）`;
  const payload = { embeds: [{ title: `📊 答え合わせ ${Utilities.formatDate(now, 'Asia/Tokyo', 'MM/dd')}（${fresh.length}件）`,
    description: desc.slice(0, 4000), color: 0x3B82F6 }] };
  if (dry) Logger.log(JSON.stringify(payload, null, 1));
  else postDiscord_(payload);
}
