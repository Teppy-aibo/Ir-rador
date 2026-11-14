/**
 * 型1（ユーザーの型）の検証: 「テーマの代表格の、材料への反応」でテーマ全体のその後が読めるか
 *
 * 型1   : 前日爆上げ → 当日に悪材料で大きく窓を開けて下げた代表格が、寄り後に下げ止まる
 *         → そのテーマの悪材料は織り込み済み → テーマの他銘柄は下げない（売り目線をやめる）
 * 型1の逆: 下げトレンドの銘柄が好材料で大きく窓を開けて上げたのに、寄り後に上げ止まる
 *         → 好材料でも効かない → テーマの下げは続く。ただし2〜3番手が付いてくる（1強で引っ張る）ならセクターは崩れない
 *
 * 材料の中身は価格データにないので、次の形で近似する（どれも10:00の時点で分かる情報だけ）:
 *  - 「材料」= その銘柄の寄りの窓が、同じテーマの他銘柄の窓の中央値より ±2% 以上ずれている（＝個別の材料）
 *  - 型1   : 前日+3%以上 ＆ 当日の窓 -3%以下 ＆ 個別のずれ -2%以下
 *  - 型1の逆: 終値＜25日線＜（5日前の25日線）の下げトレンド ＆ 当日の窓 +3%以上 ＆ 個別のずれ +2%以上
 *  - 「下げ止まり」= 最初の1時間足（9:00〜10:00）が 陽線 か、安値から値幅の6割以上戻して終わる
 *  - 「上げ止まり」= 最初の1時間足が 陰線 か、高値から値幅の6割以上押して終わる
 *  - 「付いてくる」= 10:00の時点で、同じテーマの他銘柄の過半数が前日終値より上（型1の逆のとき）
 * 結果（テーマの他銘柄の平均）: 10:00→大引けの騰落、翌日の騰落。比べる基準は「材料は同じで止まらなかった日」と「全部の日」。
 *
 * データ: Yahooの1時間足（直近730日＝約2年）。ユーザーの「この1年でこのパターンが多い」に合わせて、直近1年も分けて出す。
 * 使い方: G7セクター検証.gs と同じプロジェクトに追加し、themeReactionBacktest を実行。途中で止まったらもう一度実行（続きから）。
 * 使うもの: G7_SECTOR（G7セクター検証.gs）、SW_CODES（スイング検証.gs）、sheet_ / UA（IR通知.gs）
 * 結果: シート theme_rx（集計）と theme_rx_events（1件ずつ）
 */

// AI・半導体・電線はTOPIX-17をまたぐので、1つのテーマにまとめる
const TX_AI = ['8035', '6857', '6146', '6920', '4062', '7735', '6723', '6526', '3436', '9984', '5803', '5801', '5802',
  '6981', '6762', '6971', '285A', '4063', '6501'];

function txGroups_() {
  const g = {};
  const add = (k, c) => (g[k] = g[k] || []).push(c);
  TX_AI.forEach(c => add('AI・半導体', c));
  SW_CODES.forEach(c => { if (!TX_AI.includes(c) && G7_SECTOR[c]) add(G7_SECTOR[c], c); });
  Object.keys(g).forEach(k => { if (g[k].length < 3) delete g[k]; });
  return g;
}

/** 1時間足 → 日ごとの {d, o, h1:{o,h,l,c}, c} の配列（日付はJSTを足し算で出す＝formatDateより速い） */
function txParse_(text) {
  let res;
  try { res = JSON.parse(text).chart.result; } catch (e) { return null; }
  if (!res || !res[0].timestamp) return null;
  const q = res[0].indicators.quote[0], days = {}, order = [];
  const z = n => (n < 10 ? '0' : '') + n;
  res[0].timestamp.forEach((ts, i) => {
    if (q.open[i] == null || q.close[i] == null) return;
    const t = new Date((ts + 9 * 3600) * 1000);
    const d = '' + t.getUTCFullYear() + z(t.getUTCMonth() + 1) + z(t.getUTCDate());
    const hm = z(t.getUTCHours()) + ':' + z(t.getUTCMinutes());
    if (!days[d]) { days[d] = { d, o: null, h1: null, c: null }; order.push(d); }
    const x = days[d];
    if (hm === '09:00') { x.o = q.open[i]; x.h1 = { o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] }; }
    x.c = q.close[i];
  });
  return order.map(d => days[d]).filter(x => x.h1);
}

/** 日ごとの配列 → 前日・前々日・翌日の終値と下げトレンドの印を足した {日付: 日} */
function txDerive_(out) {
  for (let i = 0; i < out.length; i++) {
    out[i].pc = i > 0 ? out[i - 1].c : null;
    out[i].ppc = i > 1 ? out[i - 2].c : null;
    out[i].nc = i + 1 < out.length ? out[i + 1].c : null;
    if (i >= 30) {
      const ma = k => out.slice(k - 24, k + 1).reduce((s, x) => s + x.c, 0) / 25;
      out[i].down = out[i - 1].c < ma(i - 1) && ma(i - 1) < ma(i - 6);
    }
  }
  const m = {};
  out.forEach(x => m[x.d] = x);
  return m;
}

/**
 * 6分の制限に引っかかったら、取れた分を一時保存（6時間）して止まる。
 * ログに「もう一度実行」と出たら、そのまま themeReactionBacktest をもう一度実行すると続きから取る。
 */
function themeReactionBacktest() {
  const t0 = Date.now(), cache = CacheService.getScriptCache();
  const groups = txGroups_(), codes = [...new Set(Object.values(groups).flat())];
  const data = {};
  const cached = cache.getAll(codes.map(c => 'tx_' + c));
  codes.forEach(c => { const v = cached['tx_' + c]; if (v) data[c] = txDerive_(JSON.parse(v)); });
  const todo = codes.filter(c => !data[c] && !cached['tx_' + c]);
  Logger.log(`保存済み ${codes.length - todo.length}銘柄、これから取る ${todo.length}銘柄`);
  for (let s = 0; s < todo.length; s += 10) {
    if (Date.now() - t0 > 240000) {
      Logger.log(`時間切れ前に一時停止: 残り${todo.length - s}銘柄。themeReactionBacktest をもう一度実行してください（続きから取ります）`);
      return;
    }
    const chunk = todo.slice(s, s + 10);
    const rs = UrlFetchApp.fetchAll(chunk.map(c => ({
      url: `https://query1.finance.yahoo.com/v8/finance/chart/${c}.T?range=730d&interval=60m`, headers: UA, muteHttpExceptions: true })));
    rs.forEach((r, j) => {
      const arr = txParse_(r.getContentText()), c = chunk[j];
      if (!arr) { Logger.log(`${c}: データなし`); cache.put('tx_' + c, '[]', 21600); return; }
      const v = JSON.stringify(arr);
      if (v.length < 95000) cache.put('tx_' + c, v, 21600);
      data[c] = txDerive_(arr);
    });
    Utilities.sleep(300);
  }
  const oneYearAgo = Utilities.formatDate(new Date(Date.now() - 365 * 864e5), 'Asia/Tokyo', 'yyyyMMdd');
  const med = a => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };
  const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
  const pct = v => v == null ? '' : Math.round(v * 10000) / 100;

  const buckets = {}, events = [];
  const put = (k, rec) => (buckets[k] = buckets[k] || []).push(rec);

  Object.entries(groups).forEach(([gname, members]) => {
    const dates = new Set();
    members.forEach(c => data[c] && Object.keys(data[c]).forEach(d => dates.add(d)));
    [...dates].sort().forEach(d => {
      const today = members.map(c => data[c] && data[c][d]).filter(x => x && x.pc);
      if (today.length < 3) return;
      // 基準: その日のテーマ全体の 10:00→大引け
      const allPeer = avg(today.map(x => x.c / x.h1.c - 1));
      put(`基準（全部の日）|${gname}|-|-`, { d, peer: allPeer, next: avg(today.filter(x => x.nc).map(x => x.nc / x.c - 1)) });
      members.forEach(code => {
        const x = data[code] && data[code][d];
        if (!x || !x.pc) return;
        const peers = members.filter(c => c !== code).map(c => data[c] && data[c][d]).filter(p => p && p.pc);
        if (peers.length < 2) return;
        const gap = x.o / x.pc - 1, peerGap = med(peers.map(p => p.o / p.pc - 1)), own = gap - peerGap;
        const prev = x.ppc ? x.pc / x.ppc - 1 : null;
        const rng = x.h1.h - x.h1.l;
        let type = null, stop = null;
        if (prev != null && prev >= 0.03 && gap <= -0.03 && own <= -0.02) {
          type = '型1（前日爆上げ→悪材料の窓下げ）';
          stop = x.h1.c > x.h1.o || (rng > 0 && (x.h1.c - x.h1.l) / rng >= 0.6);
        } else if (x.down && gap >= 0.03 && own >= 0.02) {
          type = '型1の逆（下げトレンド→好材料の窓上げ）';
          stop = x.h1.c < x.h1.o || (rng > 0 && (x.h1.h - x.h1.c) / rng >= 0.6);
        }
        if (!type) return;
        const follow = peers.filter(p => p.h1.c > p.pc).length / peers.length; // 10:00に前日終値より上の割合
        const peerRet = avg(peers.map(p => p.c / p.h1.c - 1));
        const peerNext = avg(peers.filter(p => p.nc).map(p => p.nc / p.c - 1));
        const selfRet = x.c / x.h1.c - 1;
        const stopLbl = type.startsWith('型1（') ? (stop ? '下げ止まった' : '止まらなかった') : (stop ? '上げ止まった' : '止まらなかった');
        const folLbl = type.startsWith('型1の逆') ? (follow > 0.5 ? '他銘柄が付いてくる' : '付いてこない') : '-';
        const rec = { d, peer: peerRet, next: peerNext, self: selfRet };
        put(`${type}|全テーマ|${stopLbl}|-`, rec);
        put(`${type}|全テーマ|${stopLbl}|${folLbl}`, rec);
        put(`${type}|${gname}|${stopLbl}|-`, rec);
        events.push([d, gname, code, type, stopLbl, folLbl, pct(prev), pct(gap), pct(own), pct(selfRet), pct(peerRet), pct(peerNext),
          Math.round(follow * 100)]);
      });
    });
  });

  const HEADER = ['型', 'テーマ', '寄り後の反応', '他銘柄', '回数', '直近1年の回数', '他銘柄 10:00→大引け 平均%', '同 上げた割合%',
    '同 直近1年 平均%', '他銘柄 翌日 平均%', '本人 10:00→大引け 平均%'];
  const rows = Object.entries(buckets).map(([k, a]) => {
    const [type, g, st, fol] = k.split('|');
    const y1 = a.filter(r => r.d >= oneYearAgo);
    const pv = a.map(r => r.peer).filter(v => v != null);
    return [type, g, st, fol, a.length, y1.length, pct(avg(pv)), pv.length ? Math.round(pv.filter(v => v > 0).length / pv.length * 100) : '',
      pct(avg(y1.map(r => r.peer).filter(v => v != null))), pct(avg(a.map(r => r.next).filter(v => v != null))),
      pct(avg(a.map(r => r.self).filter(v => v != null)))];
  }).filter(r => r[4] >= 3 || r[0].startsWith('基準'));
  // 基準はテーマごとに1行で十分なので全テーマ平均も足す
  rows.sort((a, b) => (a[0] + a[1] + a[2] + a[3]).localeCompare(b[0] + b[1] + b[2] + b[3]));

  const sh = sheet_('theme_rx', HEADER);
  sh.clearContents();
  sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
  if (rows.length) sh.getRange(2, 1, rows.length, HEADER.length).setValues(rows);
  const EH = ['date', 'テーマ', 'code', '型', '反応', '他銘柄', '前日%', '窓%', '個別のずれ%', '本人10→引け%', '他銘柄10→引け%', '他銘柄翌日%', '10時に前日比プラスの他銘柄%'];
  const se = sheet_('theme_rx_events', EH);
  se.clearContents();
  se.getRange(1, 1, 1, EH.length).setValues([EH]);
  events.sort((a, b) => a[0] < b[0] ? 1 : -1);
  if (events.length) se.getRange(2, 1, events.length, EH.length).setValues(events);
  rows.filter(r => r[1] === '全テーマ').forEach(r =>
    Logger.log(`${r[0]}［${r[2]}${r[3] !== '-' ? '・' + r[3] : ''}］${r[4]}回(直近1年${r[5]}) 他銘柄10→引け ${r[6]}%（上げ${r[7]}%、直近1年${r[8]}%）翌日${r[9]}% 本人${r[10]}%`));
  Logger.log(`完了: ${Object.keys(groups).length}テーマ ${codes.length}銘柄、イベント${events.length}件 → シート theme_rx / theme_rx_events`);
}
