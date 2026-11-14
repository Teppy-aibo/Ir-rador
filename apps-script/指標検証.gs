/**
 * シンプルな指標（RSI・ボリンジャーバンド・5本線/25本線）の条件が出たあと、どう動いたかを数える（5分足・直近60日）
 * 11/11 ユーザー「感覚より、シンプルな指標で結果と傾向を愚直に追いかける方が確実に感覚になる」から。
 *
 * 使い方: Ir-rador プロジェクトに追加し、indicatorBacktest を実行（1〜2分）。結果はシート ind_bt と ind_tp（利確幅×損切り幅でいくら取れたか）。
 * 使うもの: KUSE_CODES（クセ表.gs）、sheet_ / UA（IR通知.gs）
 *
 * 指標（チャートアプリと同じ一般的な設定）: RSI 9本（Wilder）、ボリンジャーバンド 20本・±2σ、移動平均 5本・25本、当日のVWAP。
 * 条件は5分足の終値の時点で判定し、続けて出た足は最初の1本だけ数える。その後の値動きはその日の中だけ（翌日にまたがない）。
 * 見る数字:
 *   15分後・30分後・引け の騰落%（プラス=上げ。売り目線の条件はマイナスなら売りが正解）
 *   30分以内の最大の上げ・最大の下げ%（すぐ利確すれば取れたか＝+50円取りの余地）
 *   基準 = 同じ銘柄・同じ時間帯の全部の足（何もしなくてもそうなる分）
 */

const IND_TIME = hm => hm < '09:30' ? '1 寄り〜9:30' : hm < '11:30' ? '2 前場9:30〜' : hm < '13:30' ? '3 後場寄り〜13:30'
  : hm < '14:30' ? '4 13:30〜14:30' : '5 14:30〜引け';

function indFetch_(code) {
  const r = UrlFetchApp.fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${code}.T?range=60d&interval=5m`,
    { headers: UA, muteHttpExceptions: true });
  let res; try { res = JSON.parse(r.getContentText()).chart.result; } catch (e) { return []; }
  if (!res || !res[0].timestamp) return [];
  const q = res[0].indicators.quote[0], out = [], z = n => (n < 10 ? '0' : '') + n;
  res[0].timestamp.forEach((ts, i) => {
    if (q.open[i] == null || q.close[i] == null || q.high[i] == null || q.low[i] == null) return;
    const t = new Date((ts + 9 * 3600) * 1000);
    const hm = z(t.getUTCHours()) + ':' + z(t.getUTCMinutes());
    if (hm < '09:00' || hm > '15:30') return;
    out.push({ d: '' + t.getUTCFullYear() + z(t.getUTCMonth() + 1) + z(t.getUTCDate()), hm, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 });
  });
  return out;
}

/** 指標を足に書き込む */
function indCalc_(b) {
  let ag = 0, al = 0;
  for (let i = 0; i < b.length; i++) {
    const x = b[i];
    if (i > 0) {
      const ch = x.c - b[i - 1].c, g = Math.max(ch, 0), l = Math.max(-ch, 0);
      if (i <= 9) { ag += g / 9; al += l / 9; } else { ag = (ag * 8 + g) / 9; al = (al * 8 + l) / 9; }
      if (i >= 9) x.rsi = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    if (i >= 4) x.ma5 = b.slice(i - 4, i + 1).reduce((s, y) => s + y.c, 0) / 5;
    if (i >= 24) x.ma25 = b.slice(i - 24, i + 1).reduce((s, y) => s + y.c, 0) / 25;
    if (i >= 19) {
      const w = b.slice(i - 19, i + 1).map(y => y.c), m = w.reduce((s, v) => s + v, 0) / 20;
      const sd = Math.sqrt(w.reduce((s, v) => s + (v - m) * (v - m), 0) / 20);
      x.up = m + 2 * sd; x.dn = m - 2 * sd; x.bw = 4 * sd / m;
    }
  }
  // その日の始値・前日終値・引けの位置
  let day = null, dayOpen = 0, prevClose = null, lastClose = null, start = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i].d !== day) {
      if (day) for (let k = start; k < i; k++) b[k].end = i - 1;
      prevClose = lastClose; day = b[i].d; dayOpen = b[i].o; start = i;
    }
    if (i === start) { b[i]._pv = 0; b[i]._v = 0; }
    const tp = (b[i].h + b[i].l + b[i].c) / 3, pv = (i === start ? 0 : b[i - 1]._pv) + tp * b[i].v, vv = (i === start ? 0 : b[i - 1]._v) + b[i].v;
    b[i]._pv = pv; b[i]._v = vv; b[i].vwap = vv > 0 ? pv / vv : null;
    b[i].dayOpen = dayOpen; b[i].pc = prevClose; lastClose = b[i].c;
  }
  for (let k = start; k < b.length; k++) b[k].end = b.length - 1;
}

const IND_CONDS = [
  ['売り目線: RSI80以上＋+2σタッチ', (x, p) => x.rsi >= 80 && x.h >= x.up],
  ['　〃 バンドが広がり中（バンドウォーク）', (x, p, b6) => x.rsi >= 80 && x.h >= x.up && b6 && x.bw > b6.bw * 1.1],
  ['　〃 バンドが横ばい・すぼみ', (x, p, b6) => x.rsi >= 80 && x.h >= x.up && b6 && x.bw <= b6.bw * 1.1],
  ['売り目線: RSI80以上＋+2σ＋次の足で前の足の安値割れ', (x, p) => p && p.rsi >= 80 && p.h >= p.up && x.c < p.l],
  ['買い目線: RSI20以下＋-2σタッチ', (x, p) => x.rsi <= 20 && x.l <= x.dn],
  ['買い目線: 上げの日に25本線タッチ（上で引け）', (x, p) => x.pc && x.c > x.pc && x.c > x.dayOpen && x.l <= x.ma25 && x.c >= x.ma25],
  ['売り目線: 下げの日に25本線タッチ（下で引け）', (x, p) => x.pc && x.c < x.pc && x.c < x.dayOpen && x.h >= x.ma25 && x.c <= x.ma25],
  // VWAP: 機関の執行アルゴ（VWAP執行）の目安。上げの日にVWAPまで押して上で引ける＝アルゴの買いが入る場所か
  ['買い目線: 上げの日にVWAPタッチ（上で引け）', (x, p) => x.vwap && x.pc && x.c > x.pc && x.l <= x.vwap && x.c >= x.vwap],
  ['売り目線: 下げの日にVWAPタッチ（下で引け）', (x, p) => x.vwap && x.pc && x.c < x.pc && x.h >= x.vwap && x.c <= x.vwap],
  ['売り目線: VWAPから+1.5%以上の乖離', (x, p) => x.vwap && x.c / x.vwap - 1 >= 0.015],
  ['買い目線: VWAPから-1.5%以下の乖離', (x, p) => x.vwap && x.c / x.vwap - 1 <= -0.015],
  ['買い目線: 5本線が25本線を上抜け', (x, p) => p && p.ma5 <= p.ma25 && x.ma5 > x.ma25],
  ['売り目線: 5本線が25本線を下抜け', (x, p) => p && p.ma5 >= p.ma25 && x.ma5 < x.ma25],
];

function indicatorBacktest() {
  const codes = typeof KUSE_CODES !== 'undefined' ? KUSE_CODES : { '6857': 'アドテスト' };
  const acc = {}; // key -> {n, f3:[], f6:[], fc:[], mu:[], md:[]}
  const put = (k, v) => { const a = acc[k] = acc[k] || { f3: [], f6: [], fc: [], mu: [], md: [] }; Object.keys(v).forEach(z => v[z] != null && a[z].push(v[z])); };
  let first = '', last = '';
  const paths = {}; // key -> {side, p:[[ [高,安,終] ... ]]}
  Object.entries(codes).forEach(([code, name]) => {
    const b = indFetch_(code);
    if (b.length < 100) { Logger.log(`${code} ${name}: データなし`); return; }
    if (!first || b[0].d < first) first = b[0].d; if (b[b.length - 1].d > last) last = b[b.length - 1].d;
    indCalc_(b);
    const prevHit = {};
    for (let i = 30; i < b.length; i++) {
      const x = b[i], p = b[i - 1].d === x.d ? b[i - 1] : null, b6 = b[i - 6];
      if (x.rsi == null || x.ma25 == null || x.up == null || i >= x.end) continue; // 引けの足は先がないので外す
      const fw = k => i + k <= x.end ? (b[i + k].c / x.c - 1) * 100 : null;
      const win = b.slice(i + 1, Math.min(i + 6, x.end) + 1);
      const v = { f3: fw(3), f6: fw(6), fc: (b[x.end].c / x.c - 1) * 100,
        mu: win.length ? (Math.max(...win.map(y => y.h)) / x.c - 1) * 100 : null,
        md: win.length ? (Math.min(...win.map(y => y.l)) / x.c - 1) * 100 : null };
      const tb = IND_TIME(x.hm);
      put(`${name}|基準（全部の足）|${tb}`, v); put(`全銘柄|基準（全部の足）|${tb}`, v); put(`全銘柄|基準（全部の足）|全時間`, v);
      IND_CONDS.forEach(([label, f], ci) => {
        const hit = !!f(x, p, b6);
        const fresh = hit && !(prevHit[ci] === i - 1);
        if (hit) prevHit[ci] = i;
        if (!fresh) return;
        [`${name}|${label}|全時間`, `${name}|${label}|${tb}`, `全銘柄|${label}|全時間`, `全銘柄|${label}|${tb}`].forEach(k => put(k, v));
        // 利確・損切りの組み合わせ用に、その後60分（12本）の足を取っておく
        const side = label.indexOf('売り') >= 0 || label.startsWith('　〃') ? -1 : 1; // 〃 はRSI80の売りの内訳
        const path = b.slice(i + 1, Math.min(i + 12, x.end) + 1).map(y => [y.h / x.c - 1, y.l / x.c - 1, y.c / x.c - 1]);
        [`全銘柄|${label}|全時間`, `全銘柄|${label}|${tb}`].forEach(k => (paths[k] = paths[k] || { side, p: [] }).p.push(path));
      });
    }
    Logger.log(`${code} ${name}: 5分足 ${b.length}本`);
  });
  const avg = a => a.length ? Math.round(a.reduce((s, v) => s + v, 0) / a.length * 100) / 100 : '';
  const upPct = a => a.length ? Math.round(a.filter(v => v > 0).length / a.length * 100) : '';
  const H = ['銘柄', '条件', '時間帯', '回数', '15分後 平均%', '15分後 上げ%', '30分後 平均%', '30分後 上げ%', '引けまで 平均%',
    '30分内 最大の上げ 平均%', '30分内 最大の下げ 平均%'];
  const order = ['全銘柄', ...Object.values(codes)];
  const rows = Object.entries(acc).map(([k, a]) => {
    const [nm, c, t] = k.split('|');
    return [nm, c, t, a.f3.length || a.fc.length, avg(a.f3), upPct(a.f3), avg(a.f6), upPct(a.f6), avg(a.fc), avg(a.mu), avg(a.md)];
  }).filter(r => r[3] >= 5)
    .sort((x, y) => order.indexOf(x[0]) - order.indexOf(y[0]) || (x[1].startsWith('基準') ? -1 : 0) - (y[1].startsWith('基準') ? -1 : 0)
      || IND_CONDS.findIndex(c => c[0] === x[1]) - IND_CONDS.findIndex(c => c[0] === y[1]) || x[2].localeCompare(y[2]));
  const sh = sheet_('ind_bt', H);
  sh.clearContents();
  sh.getRange(1, 1, 1, H.length).setValues([H]);
  if (rows.length) sh.getRange(2, 1, rows.length, H.length).setValues(rows);
  // 利確幅×損切り幅（%）。足の中で両方に触れたら損切りが先（厳しめ）。60分で決着しなければ60分後の終値で手じまい
  const TP = [0.3, 0.5, 0.8, 1.0, 1.5], SL = [0.3, 0.5, 0.8], H2 = ['条件', '時間帯', '回数', '利確%', '損切り%', '利確に届いた%', '損切り%', '1回の平均%', '平均×回数（合計%）'];
  const tpRows = [];
  Object.entries(paths).forEach(([k, o]) => {
    const [, label, tb] = k.split('|');
    if (o.p.length < 10) return;
    TP.forEach(tp => SL.forEach(sl => {
      let win = 0, lose = 0, sum = 0;
      o.p.forEach(path => {
        let res = null;
        for (const [h, l, c] of path) {
          const fav = o.side > 0 ? h : -l, adv = o.side > 0 ? -l : h;
          if (adv * 100 >= sl) { res = -sl; lose++; break; }
          if (fav * 100 >= tp) { res = tp; win++; break; }
        }
        if (res == null) res = path.length ? o.side * path[path.length - 1][2] * 100 : 0;
        sum += res;
      });
      const n = o.p.length;
      tpRows.push([label, tb, n, tp, sl, Math.round(win / n * 100), Math.round(lose / n * 100), Math.round(sum / n * 100) / 100, Math.round(sum * 10) / 10]);
    }));
  });
  tpRows.sort((x, y) => IND_CONDS.findIndex(c => c[0] === x[0]) - IND_CONDS.findIndex(c => c[0] === y[0]) || x[1].localeCompare(y[1]) || y[7] - x[7]);
  const st = sheet_('ind_tp', H2);
  st.clearContents();
  st.getRange(1, 1, 1, H2.length).setValues([H2]);
  if (tpRows.length) st.getRange(2, 1, tpRows.length, H2.length).setValues(tpRows);
  rows.filter(r => r[0] === '全銘柄' && r[2] === '全時間').forEach(r =>
    Logger.log(`${r[1]}: ${r[3]}回 15分後${r[4]}%(上げ${r[5]}%) 30分後${r[6]}%(上げ${r[7]}%) 引け${r[8]}% 30分内 上${r[9]}%/下${r[10]}%`));
  Logger.log(`完了: ${first}〜${last} → シート ind_bt（条件ごと）/ ind_tp（利確幅×損切り幅、コスト抜き）`);
}
