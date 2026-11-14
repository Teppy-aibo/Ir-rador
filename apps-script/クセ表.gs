/**
 * 銘柄ごとの「クセ表」（Google Apps Script版・完全無料）
 * 同じプロジェクトに追加し、このファイルを開いて kuseTable を1回実行（1〜2分）。結果はシート kuse。
 * IR通知.gs の sheet_ / UA を使う。
 * 使うデータ（Yahoo で無料で取れる範囲）: 1時間足=直近2年 / 5分足=直近60日 / 日足=直近2年
 *
 * ① RSI(14)の帯ごとに、その後どれだけ動いたか（1時間足・5分足）
 *    「RSIがこのあたりで売られる」を確かめる。帯に入った最初の足（入り口）だけを数える版も出す
 * ② 高値更新が何日続いたか（日足）ごとに、翌日・3日後の動きと、3日以内の最大の下げ
 *    「ムクムク高値更新した後に急に下がる」を確かめる
 * ③ 時間帯別（5分足60日）: 30分ごとの騰落と、前場終わりの下げ・後場寄りの下げの後のジワ上げ
 * どの行も「その銘柄の全部の足の平均」と比べて見る（基準の行を一番上に出す）
 */
const KUSE_CODES = { '6857': 'アドテスト', '4062': 'イビデン', '7011': '三菱重', '8035': '東エレク', '5803': 'フジクラ', '5801': '古河電工', '285A': 'キオクシア' }; // 足したい銘柄はここに追加
const KUSE_HEADER = ['銘柄', '表', '条件', '回数', '後1', '後2', '後3', '後3で下げた割合%', 'メモ'];
const KUSE_BANDS = [[0, 20], [20, 30], [30, 40], [40, 60], [60, 70], [70, 80], [80, 101]];

function kuseFetch_(code, range, interval) {
  const r = UrlFetchApp.fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${code}.T?range=${range}&interval=${interval}`,
    { headers: UA, muteHttpExceptions: true });
  let res; try { res = JSON.parse(r.getContentText()).chart.result; } catch (e) { return []; }
  if (!res || !res[0].timestamp) return [];
  const q = res[0].indicators.quote[0], out = [];
  res[0].timestamp.forEach((ts, i) => {
    if (q.open[i] == null || q.close[i] == null || q.high[i] == null || q.low[i] == null) return;
    const dt = new Date(ts * 1000);
    out.push({ d: Utilities.formatDate(dt, 'Asia/Tokyo', 'yyyyMMdd'), t: Utilities.formatDate(dt, 'Asia/Tokyo', 'HH:mm'),
      o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 });
  });
  return out;
}

function kuseRsi_(b) {
  const out = []; let ag = 0, al = 0;
  b.forEach((x, i) => {
    if (!i) { out.push(null); return; }
    const ch = x.c - b[i - 1].c, g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= 14) { ag += g / 14; al += l / 14; } else { ag = (ag * 13 + g) / 14; al = (al * 13 + l) / 14; }
    out.push(i >= 14 ? (al === 0 ? 100 : 100 - 100 / (1 + ag / al)) : null);
  });
  return out;
}

/** RSIの帯ごとの、k本後の騰落%（sameDay=true なら同じ日の中だけ） */
function kuseRsiRows_(name, label, b, ks, sameDay) {
  const rsi = kuseRsi_(b), rows = [], mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
  const r2 = v => isNaN(v) ? '' : Math.round(v * 100) / 100;
  const fwd = (i, k) => (i + k < b.length && (!sameDay || b[i + k].d === b[i].d)) ? (b[i + k].c / b[i].c - 1) * 100 : NaN;
  const stat = (idx, cond, memo) => {
    const f = ks.map(k => idx.map(i => fwd(i, k)).filter(v => !isNaN(v)));
    if (!f[0].length) return;
    rows.push([name, label, cond, f[0].length, r2(mean(f[0])), r2(mean(f[1])), r2(mean(f[2])),
      f[2].length ? Math.round(f[2].filter(v => v < 0).length / f[2].length * 100) : '', memo]);
  };
  const all = []; for (let i = 15; i < b.length; i++) all.push(i);
  stat(all, '基準（全部の足）', `後1/2/3 = ${ks.join('/')}本後`);
  KUSE_BANDS.forEach(([lo, hi]) => stat(all.filter(i => rsi[i] >= lo && rsi[i] < hi), `RSI ${lo}〜${hi === 101 ? 100 : hi}`, ''));
  [[70, 1], [80, 1], [30, -1], [20, -1]].forEach(([lv, dir]) => stat(all.filter(i => rsi[i - 1] != null &&
    (dir > 0 ? rsi[i] >= lv && rsi[i - 1] < lv : rsi[i] <= lv && rsi[i - 1] > lv)), `RSIが${lv}を${dir > 0 ? '上に' : '下に'}抜けた足（入り口）`, ''));
  return rows;
}

/** 高値更新（20日高値を上回った日）が何日続いたかごとの、翌日・3日後・3日以内の最大の下げ */
function kuseHighRows_(name, b) {
  const rows = [], mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN, r2 = v => isNaN(v) ? '' : Math.round(v * 100) / 100;
  const streak = [];
  b.forEach((x, i) => {
    if (i < 20) { streak.push(0); return; }
    let m = -Infinity; for (let j = i - 20; j < i; j++) m = Math.max(m, b[j].h);
    streak.push(x.h > m ? (streak[i - 1] || 0) + 1 : 0);
  });
  const stat = (idx, cond) => {
    idx = idx.filter(i => i + 3 < b.length);
    if (!idx.length) return;
    const n1 = idx.map(i => (b[i + 1].c / b[i].c - 1) * 100), n3 = idx.map(i => (b[i + 3].c / b[i].c - 1) * 100);
    const dd = idx.map(i => (Math.min(b[i + 1].l, b[i + 2].l, b[i + 3].l) / b[i].c - 1) * 100);
    const gapUpFade = idx.filter(i => b[i + 1].o > b[i].c && b[i + 1].c < b[i + 1].o).length;
    rows.push([name, '日足 高値更新の連続', cond, idx.length, r2(mean(n1)), r2(mean(n3)), r2(mean(dd)),
      Math.round(n3.filter(v => v < 0).length / n3.length * 100), `翌日下げ${Math.round(n1.filter(v => v < 0).length / n1.length * 100)}% 翌日上に寄って陰線${Math.round(gapUpFade / idx.length * 100)}%`]);
  };
  const all = []; for (let i = 20; i < b.length; i++) all.push(i);
  stat(all, '基準（全部の日）  後1=翌日% 後2=3日後% 後3=3日以内の最大の下げ%');
  [1, 2, 3, 4].forEach(k => stat(all.filter(i => streak[i] === k), `${k}日連続で高値更新`));
  stat(all.filter(i => streak[i] >= 5), '5日以上連続で高値更新');
  stat(all.filter(i => streak[i] === 0 && streak[i - 1] >= 3), '3日以上の連続更新が止まった日');
  return rows;
}

/** 時間帯別：30分ごとの動き（その枠の最初の始値→最後の終値）と、前引け・後場の型（5分足） */
function kuseTimeRows_(name, label, b) {
  const rows = [], mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN, r2 = v => isNaN(v) ? '' : Math.round(v * 100) / 100;
  const days = {}; b.forEach(x => (days[x.d] = days[x.d] || []).push(x));
  const slot = t => { const [h, m] = t.split(':').map(Number); const mm = h * 60 + m; const s0 = mm - mm % 30; return `${('0' + Math.floor(s0 / 60)).slice(-2)}:${('0' + s0 % 60).slice(-2)}`; };
  const bySlot = {};
  Object.values(days).forEach(bars => {
    const g = {}; bars.forEach(x => (g[slot(x.t)] = g[slot(x.t)] || []).push(x));
    Object.keys(g).forEach(k => { const a = g[k]; (bySlot[k] = bySlot[k] || []).push((a[a.length - 1].c / a[0].o - 1) * 100); });
  });
  Object.keys(bySlot).sort().forEach(k => {
    const v = bySlot[k];
    rows.push([name, label + ' 時間帯', `${k}〜の30分`, v.length, r2(mean(v)), '', '', Math.round(v.filter(x => x < 0).length / v.length * 100), '後1=その30分の騰落%（始値→終値）']);
  });
  // 型：前場の動き→前引け前、後場寄りの下げ→その後
  const pat = { a: [], b: [], c: [], d: [] };
  Object.values(days).forEach(bars => {
    const am = bars.filter(x => x.t < '11:30'), pm = bars.filter(x => x.t >= '12:30');
    if (am.length < 20 || pm.length < 20) return;
    const at = t => { const x = bars.filter(y => y.t < t); return x.length ? x[x.length - 1].c : NaN; };
    const amClose = am[am.length - 1].c, dayOpen = am[0].o, c11 = at('11:00'), pmOpen = pm[0].o, c13 = at('13:00'), close = pm[pm.length - 1].c;
    const amMove = (c11 / dayOpen - 1) * 100, last30 = (amClose / c11 - 1) * 100;
    if (amMove >= 1) pat.a.push(last30);
    if (amMove <= -1) pat.b.push(last30);
    const pmDrop = (c13 / amClose - 1) * 100, rest = (close / c13 - 1) * 100;
    if (pmDrop <= -0.5) pat.c.push(rest);
    if (pmDrop >= 0.5) pat.d.push(rest);
  });
  const prow = (v, cond, memo) => { if (v.length) rows.push([name, label + ' 時間帯の型', cond, v.length, r2(mean(v)), '', '', Math.round(v.filter(x => x < 0).length / v.length * 100), memo]); };
  prow(pat.a, '9:00→11:00で+1%以上上げた日の 11:00→前引け', '前場終わりの利確売りを見る');
  prow(pat.b, '9:00→11:00で-1%以上下げた日の 11:00→前引け', '');
  prow(pat.c, '前引け→13:00で-0.5%以上下げた日の 13:00→大引け', '後場の「落ちる雰囲気からのジワ上げ」を見る');
  prow(pat.d, '前引け→13:00で+0.5%以上上げた日の 13:00→大引け', '');
  return rows;
}

function kuseTable() {
  const rows = [];
  Object.keys(KUSE_CODES).forEach(code => {
    const name = `${code} ${KUSE_CODES[code]}`;
    const h1 = kuseFetch_(code, '730d', '60m'), m5 = kuseFetch_(code, '60d', '5m'), d1 = kuseFetch_(code, '2y', '1d');
    Logger.log(`${name}: 1時間足${h1.length}本 5分足${m5.length}本 日足${d1.length}本`);
    if (h1.length > 50) rows.push(...kuseRsiRows_(name, `1時間足(${h1.length ? h1[0].d : ''}〜)`, h1, [1, 3, 6], false));
    if (m5.length > 50) rows.push(...kuseRsiRows_(name, `5分足(${m5.length ? m5[0].d : ''}〜)`, m5, [6, 12, 36], true));
    if (m5.length > 50) rows.push(...kuseTimeRows_(name, '5分足', m5));
    if (d1.length > 50) rows.push(...kuseHighRows_(name, d1));
    Utilities.sleep(300);
  });
  const sh = sheet_('kuse', KUSE_HEADER);
  sh.clearContents();
  sh.getRange(1, 1, 1, KUSE_HEADER.length).setValues([KUSE_HEADER]);
  if (rows.length) sh.getRange(2, 1, rows.length, KUSE_HEADER.length).setValues(rows);
  Logger.log(`完了: ${rows.length}行 → シート kuse`);
}

/* ===================== 108銘柄のクセ探し（kuseScan → シート kuse_scan） =====================
 * スイング検証.gs の SW_CODES（大型108銘柄）全部で、その銘柄の普段の動きから大きくずれる条件を探して強い順に並べる。
 * t値 = 普段との差がどれだけ偶然では出にくいか（3以上でかなり強い、2〜3は偶然でも出る）。108銘柄×約30条件を調べるので t2 前後は偶然が混ざる。
 * 1時間足は「前の1年」と「後の1年」で同じ向きかも出す（両方同じ向き＝クセが続いている）。
 * 同じ帯に何本も続けて入ると同じ値動きを何度も数えるので、数える足は k本以上あけている。1回5分で約40銘柄。ログに「全部完了」と出るまで kuseScan を繰り返し実行する。
 */
function kuseParse_(text) {
  let res; try { res = JSON.parse(text).chart.result; } catch (e) { return []; }
  if (!res || !res[0].timestamp) return [];
  const q = res[0].indicators.quote[0], out = [];
  res[0].timestamp.forEach((ts, i) => {
    if (q.open[i] == null || q.close[i] == null || q.high[i] == null || q.low[i] == null) return;
    const j = new Date((ts + 9 * 3600) * 1000), p2 = n => (n < 10 ? '0' : '') + n; // 日本時間（formatDate は遅いので使わない）
    out.push({ d: `${j.getUTCFullYear()}${p2(j.getUTCMonth() + 1)}${p2(j.getUTCDate())}`, t: `${p2(j.getUTCHours())}:${p2(j.getUTCMinutes())}`,
      o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: (q.volume && q.volume[i]) || 0 });
  });
  return out;
}

function kuseStat_(v) {
  const n = v.length; if (!n) return { n: 0, m: NaN, sd: NaN };
  const m = v.reduce((s, x) => s + x, 0) / n, sd = Math.sqrt(v.reduce((s, x) => s + (x - m) * (x - m), 0) / Math.max(n - 1, 1));
  return { n, m, sd };
}

/** 条件に当たった足の中から k本以上あけて拾う */
function kuseSpaced_(idx, k) { const o = []; let last = -1e9; idx.forEach(i => { if (i - last >= k) { o.push(i); last = i; } }); return o; }

function kuseScanStock_(name, h1, m5, d1) {
  const out = [];
  const push = (tbl, cond, v, base, memo, half) => {
    const s = kuseStat_(v); if (s.n < 15 || !(s.sd > 0)) return;
    const t = (s.m - base) / (s.sd / Math.sqrt(s.n));
    out.push([name, tbl, cond, s.n, Math.round(s.m * 100) / 100, Math.round(base * 100) / 100, Math.round((s.m - base) * 100) / 100,
      Math.round(t * 10) / 10, Math.round(v.filter(x => x < 0).length / s.n * 100), half || '', memo]);
  };
  // RSI（1時間足：6本後、5分足：同じ日の12本後=1時間後）
  [[h1, '1時間足', 6, false], [m5, '5分足', 12, true]].forEach(([b, lab, k, sameDay]) => {
    if (b.length < 100) return;
    const rsi = kuseRsi_(b), all = [];
    const fwd = i => (i + k < b.length && (!sameDay || b[i + k].d === b[i].d)) ? (b[i + k].c / b[i].c - 1) * 100 : NaN;
    for (let i = 15; i < b.length; i++) if (!isNaN(fwd(i))) all.push(i);
    const base = kuseStat_(all.map(fwd)).m, mid = b[Math.floor(b.length / 2)].d;
    const conds = KUSE_BANDS.map(([lo, hi]) => [`RSI ${lo}〜${hi === 101 ? 100 : hi}`, i => rsi[i] >= lo && rsi[i] < hi])
      .concat([[70, 1], [80, 1], [30, -1], [20, -1]].map(([lv, dir]) => [`RSIが${lv}を${dir > 0 ? '上' : '下'}に抜けた足`,
        i => rsi[i - 1] != null && (dir > 0 ? rsi[i] >= lv && rsi[i - 1] < lv : rsi[i] <= lv && rsi[i - 1] > lv)]));
    conds.forEach(([cond, f]) => {
      const idx = kuseSpaced_(all.filter(f), k), v = idx.map(fwd);
      let half = '';
      if (!sameDay) {
        const a = idx.filter(i => b[i].d < mid).map(fwd), c = idx.filter(i => b[i].d >= mid).map(fwd);
        const ma = kuseStat_(a).m - base, mc = kuseStat_(c).m - base;
        half = (a.length >= 5 && c.length >= 5) ? `前${Math.round(ma * 100) / 100}/後${Math.round(mc * 100) / 100}${Math.sign(ma) === Math.sign(mc) ? ' 両方同じ向き' : ' 向きが逆'}` : '';
      }
      push(lab, cond, v, base, `${k}本後の騰落%`, half);
    });
  });
  // 時間帯（5分足、30分ごと）
  if (m5.length > 100) {
    const days = {}; m5.forEach(x => (days[x.d] = days[x.d] || []).push(x));
    const slot = t => { const [h, m] = t.split(':').map(Number); const mm = h * 60 + m - (h * 60 + m) % 30; return `${('0' + Math.floor(mm / 60)).slice(-2)}:${('0' + mm % 60).slice(-2)}`; };
    const bySlot = {};
    Object.values(days).forEach(bars => {
      const g = {}; bars.forEach(x => (g[slot(x.t)] = g[slot(x.t)] || []).push(x));
      Object.keys(g).forEach(s => { const a = g[s]; (bySlot[s] = bySlot[s] || []).push((a[a.length - 1].c / a[0].o - 1) * 100); });
    });
    Object.keys(bySlot).sort().forEach(s => { if (s >= '09:00' && s < '15:30' && s !== '11:30') push('5分足 時間帯', `${s}〜の30分`, bySlot[s], 0, 'その30分の騰落%（普段=0と比べる）'); });
  }
  // 日足：高値更新の連続日数ごとの翌日
  if (d1.length > 60) {
    const streak = [], nd = i => i + 1 < d1.length ? (d1[i + 1].c / d1[i].c - 1) * 100 : NaN, all = [];
    d1.forEach((x, i) => { if (i < 20) { streak.push(0); return; } let m = -Infinity; for (let j = i - 20; j < i; j++) m = Math.max(m, d1[j].h); streak.push(x.h > m ? streak[i - 1] + 1 : 0); });
    for (let i = 20; i < d1.length - 1; i++) all.push(i);
    const base = kuseStat_(all.map(nd)).m;
    [[1, '1日目'], [2, '2日目'], [3, '3日目'], [4, '4日以上']].forEach(([k, lab]) =>
      push('日足 高値更新', `連続${lab}の翌日`, all.filter(i => k < 4 ? streak[i] === k : streak[i] >= 4).map(nd), base, '翌日の騰落%'));
    const gd = all.filter(i => i > 0 && (d1[i].c / d1[i - 1].c - 1) * 100 <= -2.5);
    push('日足', '前日比-2.5%以下の翌日', gd.map(nd), base, '翌日の騰落%');
  }
  return out;
}

/** 108銘柄を回す。6分の制限があるので、途中で止まったらもう一度実行すると続きから回る（ログに「全部完了」と出るまで繰り返す） */
function kuseScan() {
  const hdr = ['銘柄', '表', '条件', '回数', '平均%', '普段%', '差', 't値', '下げた割合%', '前の1年/後の1年の差', 'メモ'];
  const props = PropertiesService.getScriptProperties(), t0 = Date.now();
  let pos = Number(props.getProperty('KUSE_SCAN_POS') || 0);
  const raw = sheet_('kuse_scan_raw', hdr), ps = sheet_('kuse_scan_ps', ['銘柄', 't3', 't2.5', '値幅', '窓', '代金', '上位3']);
  if (pos === 0) { raw.clearContents(); ps.clearContents(); }
  const url = (c, r, iv) => `https://query1.finance.yahoo.com/v8/finance/chart/${c}.T?range=${r}&interval=${iv}`;
  while (pos < SW_CODES.length) {
    if (Date.now() - t0 > 300000) break;
    const code = SW_CODES[pos];
    const rs = UrlFetchApp.fetchAll([url(code, '730d', '60m'), url(code, '60d', '5m'), url(code, '2y', '1d')]
      .map(u => ({ url: u, headers: UA, muteHttpExceptions: true })));
    const [h1, m5, d1] = rs.map(r => kuseParse_(r.getContentText()));
    const name = `${code} ${KUSE_CODES[code] || ''}`.trim();
    const r = kuseScanStock_(name, h1, m5, d1);
    const strong = r.filter(x => Math.abs(x[7]) >= 3);
    const last = d1.slice(-61); let rng = '', gap = '', val = '';
    if (last.length > 20) {
      const m = a => a.reduce((x, y) => x + y, 0) / a.length;
      rng = Math.round(m(last.slice(1).map((x, i) => (x.h - x.l) / last[i].c * 100)) * 100) / 100;
      gap = Math.round(m(last.slice(1).map((x, i) => Math.abs(x.o / last[i].c - 1) * 100)) * 100) / 100;
      val = Math.round(m(last.slice(1).map(x => x.c * x.v)) / 1e8);
    }
    const top = r.filter(x => Math.abs(x[7]) >= 2.5);
    if (top.length) raw.getRange(raw.getLastRow() + 1, 1, top.length, 11).setValues(top);
    ps.appendRow([name, strong.length, top.length, rng, gap, val,
      strong.sort((a, b) => Math.abs(b[7]) - Math.abs(a[7])).slice(0, 3).map(x => `${x[1]} ${x[2]}(差${x[6]} t${x[7]})`).join(' / ')]);
    pos++;
    props.setProperty('KUSE_SCAN_POS', String(pos));
  }
  if (pos < SW_CODES.length) { Logger.log(`途中まで: ${pos}/${SW_CODES.length}銘柄。もう一度 kuseScan を実行すると続きから回ります`); return; }
  // 全部終わったらまとめる
  const rows = raw.getLastRow() > 0 ? raw.getDataRange().getValues().filter(x => x[0] !== '' && x[0] !== '銘柄') : [];
  const perStock = ps.getLastRow() > 0 ? ps.getDataRange().getValues().filter(x => x[0] !== '' && x[0] !== '銘柄') : [];
  rows.sort((a, b) => Math.abs(b[7]) - Math.abs(a[7]));
  perStock.sort((a, b) => b[1] - a[1] || b[2] - a[2]);
  const sh = sheet_('kuse_scan', hdr);
  sh.clearContents();
  const out = [['銘柄ごとのクセの強さ', 't3以上の数', 't2.5以上の数', '1日の値幅%(60日)', '窓の大きさ%(60日)', '売買代金 億円(60日)', '強い順の上位3つ', '', '', '', '']]
    .concat(perStock.map(p => p.slice(0, 7).concat(Array(4).fill(''))))
    .concat([Array(11).fill('')], [hdr], rows);
  sh.getRange(1, 1, out.length, 11).setValues(out);
  props.deleteProperty('KUSE_SCAN_POS');
  Logger.log(`全部完了: ${perStock.length}銘柄 t2.5以上 ${rows.length}行 → シート kuse_scan`);
}

/** 最初からやり直したいとき */
function kuseScanReset() { PropertiesService.getScriptProperties().deleteProperty('KUSE_SCAN_POS'); Logger.log('リセットしました'); }

/* ===================== イビデンとインテルの連動（kuseIntel → シート kuse_intel） =====================
 * 前夜の米国（インテルINTC・SOX指数）の動きで日本の翌日を分けて、窓（前日終値→始値）・寄り→引け・前日終値→終値を比べる。
 * 比べる相手としてアドテスト・東エレクも同じ表を出す（インテル特有ならイビデンだけ差が大きいはず）。日足2年。
 */
function kuseUs_(sym) {
  const r = UrlFetchApp.fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=2y&interval=1d`, { headers: UA, muteHttpExceptions: true });
  let res; try { res = JSON.parse(r.getContentText()).chart.result[0]; } catch (e) { return {}; }
  const q = res.indicators.quote[0], out = {}; let prev = null;
  res.timestamp.forEach((ts, i) => {
    if (q.close[i] == null) return;
    const d = Utilities.formatDate(new Date(ts * 1000), 'America/New_York', 'yyyyMMdd');
    if (prev != null) out[d] = (q.close[i] / prev - 1) * 100;
    prev = q.close[i];
  });
  return out;
}

function kuseIntel() {
  const intc = kuseUs_('INTC'), sox = kuseUs_('^SOX'), usDays = Object.keys(sox).filter(d => intc[d] != null).sort();
  const hdr = ['銘柄', '前夜の米国', '回数', '窓%', '寄り→引け%', '終値比%', '終値で上げた割合%', '前夜SOX平均%', '前夜INTC平均%'];
  const rows = [], corr = [];
  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN, r2 = v => isNaN(v) ? '' : Math.round(v * 100) / 100;
  const cor = (x, y) => { const mx = mean(x), my = mean(y); let a = 0, b = 0, c = 0; x.forEach((v, i) => { a += (v - mx) * (y[i] - my); b += (v - mx) ** 2; c += (y[i] - my) ** 2; }); return a / Math.sqrt(b * c); };
  [['4062', 'イビデン'], ['6857', 'アドテスト'], ['8035', '東エレク']].forEach(([code, nm]) => {
    const b = kuseFetch_(code, '2y', '1d'), ev = [];
    for (let i = 1; i < b.length; i++) {
      let u = null; for (let k = usDays.length - 1; k >= 0; k--) if (usDays[k] < b[i].d) { u = usDays[k]; break; }
      if (!u) continue;
      ev.push({ s: sox[u], n: intc[u], gap: (b[i].o / b[i - 1].c - 1) * 100, oc: (b[i].c / b[i].o - 1) * 100, cc: (b[i].c / b[i - 1].c - 1) * 100 });
    }
    const name = `${code} ${nm}`;
    const add = (lab, f) => { const e = ev.filter(f); if (e.length < 8) return;
      rows.push([name, lab, e.length, r2(mean(e.map(x => x.gap))), r2(mean(e.map(x => x.oc))), r2(mean(e.map(x => x.cc))),
        Math.round(e.filter(x => x.cc > 0).length / e.length * 100), r2(mean(e.map(x => x.s))), r2(mean(e.map(x => x.n)))]); };
    add('全部の日', () => true);
    add('SOX +1%以上 かつ インテルもSOX以上', x => x.s >= 1 && x.n >= x.s);
    add('SOX +1%以上 なのに インテルがSOXより2%以上弱い', x => x.s >= 1 && x.n <= x.s - 2);
    add('SOX +1%以上 なのに インテルがマイナス', x => x.s >= 1 && x.n < 0);
    add('インテル一強（インテル+2%以上・SOX+0.5%未満）', x => x.n >= 2 && x.s < 0.5);
    add('インテル+3%以上', x => x.n >= 3);
    add('インテル-3%以下', x => x.n <= -3);
    add('SOX -1%以下 なのに インテル+1%以上', x => x.s <= -1 && x.n >= 1);
    // インテルがSOXよりどれだけ強かったか（INTC-SOX）と、SOXそのもの、それぞれと翌日終値比の相関
    corr.push([name, '相関（前夜→翌日の終値比）', ev.length, 'SOXと ' + r2(cor(ev.map(x => x.s), ev.map(x => x.cc))),
      'インテルと ' + r2(cor(ev.map(x => x.n), ev.map(x => x.cc))), 'インテル−SOXと ' + r2(cor(ev.map(x => x.n - x.s), ev.map(x => x.cc))), '', '', '']);
    Utilities.sleep(300);
  });
  const sh = sheet_('kuse_intel', hdr);
  sh.clearContents();
  const out = [hdr].concat(rows, [Array(9).fill('')], corr);
  sh.getRange(1, 1, out.length, 9).setValues(out);
  Logger.log(`完了 → シート kuse_intel（米国 ${usDays.length}日）`);
}
