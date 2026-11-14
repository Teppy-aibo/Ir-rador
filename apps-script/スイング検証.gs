/**
 * スイングの型を過去データで検証（Google Apps Script版・完全無料）
 * IR通知.gs と同じプロジェクトに「ファイル ＋ → スクリプト」で追加し、swingBacktest を1回実行するだけ。
 * 大型株 約100銘柄 × 過去6年の日足で、4つの型を「買う前に損切りを決める」前提で検証し、
 * 結果を swing_bt（型ごとの成績）・swing_trades（全取引）・swing_now（今日シグナルが出た銘柄）シートに書く。
 *
 * 成績は R（1回に決めた損失の何倍か）で数える。+3R＝損切り幅の3倍取れた、-1R＝予定どおり損切り。
 * 窓開けで損切りより下に寄ったときは寄り値で売る（-1Rより悪くなる）＝現実どおり厳しめ。
 * 売買コストとして往復0.1%を差し引く。
 *
 * 型:
 *  A 押し目買い: 75日線が上向き・25日線＞75日線の上昇トレンドで、25日線まで押して陽線で戻した翌朝に買う
 *    損切り=直近5日の安値、利確=+3R、終値が25日線を2%割ったら翌朝手じまい、最長40日
 *  B 高値ブレイク: 終値が60日高値を出来高1.5倍以上で上抜け、75日線より上 → 翌朝買う
 *    損切り=買値-2ATR、利確=+3R、終値が25日線割れで翌朝手じまい、最長40日
 *  C 下げすぎ逆張り（これまでのイビデン・アドテスト型）: RSI14＜30 かつ 25日線から-10%以上 → 翌朝買う
 *    損切り=買値-2ATR、利確=25日線に戻ったところ、最長20日
 *  D 窓開け急騰の後追い（決算サプライズの代わり）: 前日比+5%以上の窓・出来高2倍・上半分で引けた日の翌朝に買う
 *    損切り=窓を開けた日の安値、利確=+3R、終値が25日線割れで翌朝手じまい、最長40日
 *  各型に「地合いフィルタあり」（TOPIX連動ETF 1306 が75日線より上の日だけ買う）と
 *  「200日線フィルタ」（その銘柄が200日線より上・200日線が上向き＝長期の上昇トレンドの中だけ買う）も並べる
 */

const SW_CODES = ['7203', '6758', '9984', '8306', '8316', '8411', '6861', '8035', '6857', '6146', '4063', '6098', '9432',
  '9433', '9434', '7974', '8058', '8031', '8001', '8053', '8002', '7011', '7012', '7013', '6501', '6503', '6702', '6752',
  '6954', '6981', '6762', '6971', '6594', '6367', '6273', '6301', '6326', '7267', '7269', '7270', '6902', '5108', '4502',
  '4503', '4568', '4519', '4523', '4578', '4452', '4911', '2914', '2502', '2802', '3382', '9983', '8267', '4661', '9020',
  '9022', '9101', '9104', '9107', '5401', '5411', '5713', '5802', '5803', '5801', '4062', '6920', '7735', '6723', '6526',
  '3436', '4004', '4005', '4188', '3407', '4901', '7751', '7741', '4543', '7733', '8766', '8725', '8630', '8591', '8604',
  '8601', '8801', '8802', '8830', '1925', '1928', '1801', '1802', '1803', '1812', '5020', '1605', '9501', '9503', '4689',
  '4755', '2413', '6201', '7832', '9766'];
const SW_COST = 0.1; // 往復コスト（%）
const SW_BT_HEADER = ['rule', 'trades', 'win_pct', 'avg_R', 'PF', 'avg_days', 'max_losing_streak', 'worst_R', 'per_month', 'note'];
const SW_TR_HEADER = ['rule', 'code', 'entry_date', 'entry', 'stop', 'exit_date', 'exit', 'R', 'days', 'reason'];
const SW_NOW_HEADER = ['date', 'rule', 'code', 'close', 'entry_hint', 'stop', 'target_3R', 'shares_for_40man'];

function swDaily_(sym) {
  const r = UrlFetchApp.fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=6y&interval=1d`,
    { headers: UA, muteHttpExceptions: true });
  return swParse_(r.getContentText());
}

function swParse_(text) {
  let res;
  try { res = JSON.parse(text).chart.result; } catch (e) { return null; }
  if (!res || !res[0].timestamp) return null;
  const q = res[0].indicators.quote[0], out = [];
  res[0].timestamp.forEach((ts, i) => {
    if (q.open[i] == null || q.close[i] == null || q.high[i] == null || q.low[i] == null) return;
    out.push({ d: Utilities.formatDate(new Date(ts * 1000), 'Asia/Tokyo', 'yyyyMMdd'),
      o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 });
  });
  return swSplitAdj_(out);
}

/** 株式分割の補正（Yahooが未補正のことがある）: 寄りが前日終値の-45%超/+80%超に飛び、分割比率に近い日より前を割り戻す */
function swSplitAdj_(b) {
  const f = [2, 3, 4, 5, 10, 20, 0.5, 1 / 3, 0.25, 0.2, 0.1];
  for (let i = b.length - 1; i > 0; i--) {
    const r = b[i].o / b[i - 1].c;
    if (r > 0.55 && r < 1.8) continue;
    const k = f.find(x => Math.abs(r * x - 1) < 0.15);
    if (!k) continue;
    for (let j = 0; j < i; j++) { b[j].o /= k; b[j].h /= k; b[j].l /= k; b[j].c /= k; b[j].v *= k; }
  }
  return b;
}

/** 移動平均・ATR・RSI・60日高値・出来高平均をまとめて計算 */
function swIndicators_(b) {
  const n = b.length, ma = (k, i) => {
    if (i < k - 1) return null;
    let s = 0; for (let j = i - k + 1; j <= i; j++) s += b[j].c; return s / k;
  };
  const ma25 = [], ma75 = [], ma200 = [], atr = [], rsi = [], hi60 = [], vol20 = [];
  let ag = 0, al = 0, a = 0;
  for (let i = 0; i < n; i++) {
    ma25.push(ma(25, i)); ma75.push(ma(75, i)); ma200.push(ma(200, i));
    const tr = i ? Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)) : b[i].h - b[i].l;
    a = i < 14 ? (a * i + tr) / (i + 1) : (a * 13 + tr) / 14; atr.push(i >= 14 ? a : null);
    if (i) {
      const ch = b[i].c - b[i - 1].c, g = Math.max(ch, 0), l = Math.max(-ch, 0);
      if (i <= 14) { ag += g / 14; al += l / 14; } else { ag = (ag * 13 + g) / 14; al = (al * 13 + l) / 14; }
    }
    rsi.push(i >= 14 ? (al === 0 ? 100 : 100 - 100 / (1 + ag / al)) : null);
    if (i >= 60) { let m = -Infinity; for (let j = i - 60; j < i; j++) m = Math.max(m, b[j].h); hi60.push(m); } else hi60.push(null);
    if (i >= 20) { let s = 0; for (let j = i - 20; j < i; j++) s += b[j].v; vol20.push(s / 20); } else vol20.push(null);
  }
  return { ma25, ma75, ma200, atr, rsi, hi60, vol20 };
}

/** その日の終値で型の条件を満たすか。満たせば {stop, kind} を返す（買いは翌朝の寄り） */
function swSignal_(rule, b, x, i) {
  const c = b[i].c, m25 = x.ma25[i], m75 = x.ma75[i], at = x.atr[i];
  if (m25 == null || m75 == null || at == null || i < 80) return null;
  if (rule === 'A') {
    const up = m75 > x.ma75[i - 5] && m25 > m75 && c > m75;
    if (!(up && b[i].l <= m25 * 1.01 && c > m25 && c > b[i].o)) return null;
    let lo = Infinity; for (let j = i - 4; j <= i; j++) lo = Math.min(lo, b[j].l);
    return { stop: lo * 0.998 };
  }
  if (rule === 'B') {
    if (!(x.hi60[i] != null && c > x.hi60[i] && x.vol20[i] > 0 && b[i].v >= 1.5 * x.vol20[i] && c > m75)) return null;
    return { stop: null, atrMult: 2 };
  }
  if (rule === 'D') {
    // 決算サプライズの代わり: 前日終値から+5%以上の窓・出来高2倍以上・上半分で引けた（窓を守った）日
    if (!(b[i].o >= b[i - 1].c * 1.05 && x.vol20[i] > 0 && b[i].v >= 2 * x.vol20[i] && c >= (b[i].h + b[i].l) / 2 && c > b[i - 1].c * 1.03)) return null;
    return { stop: b[i].l * 0.998 };
  }
  if (rule === 'C') {
    if (!(x.rsi[i] != null && x.rsi[i] < 30 && c < m25 * 0.9)) return null;
    return { stop: null, atrMult: 2 };
  }
  return null;
}

/** 1銘柄・1つの型を最初から最後まで回す */
function swRun_(rule, code, b, x, mkt) {
  const base = rule[0], useFilter = rule.includes('F'), use200 = rule.includes('2'), trades = [];
  let i = 80;
  while (i < b.length - 1) {
    const sig = swSignal_(base, b, x, i);
    if (!sig || (useFilter && !(mkt[b[i].d] === true))) { i++; continue; }
    if (use200 && !(x.ma200[i] != null && b[i].c > x.ma200[i] && x.ma200[i] >= x.ma200[i - 10])) { i++; continue; }
    const e = i + 1, entry = b[e].o;
    // 損切りが近すぎると1回の窓開けで-10Rになる→最低でも1ATR（かつ買値の1.5%）は離す
    const stop = Math.min(sig.stop != null ? sig.stop : entry - sig.atrMult * x.atr[i], entry - x.atr[i], entry * 0.985);
    const risk = entry - stop;
    if (!(risk > 0) || risk / entry > 0.15) { i++; continue; }
    const target = base === 'C' ? null : entry + 3 * risk;
    let exit = null, reason = '', k = e, pendingExit = false;
    for (k = e; k < b.length; k++) {
      const bar = b[k];
      if (pendingExit) { exit = bar.o; reason = base === 'A' ? '25日線割れ' : '25日線割れ'; break; }
      if (bar.l <= stop) { exit = Math.min(bar.o, stop); reason = bar.o < stop ? '窓開け損切り' : '損切り'; break; }
      if (target && bar.h >= target) { exit = Math.max(bar.o, target); reason = '+3R利確'; break; }
      if (base === 'C' && x.ma25[k] != null && bar.h >= x.ma25[k] && k > e) { exit = Math.max(bar.o, x.ma25[k]); reason = '25日線で利確'; break; }
      const maxDays = base === 'C' ? 20 : 40;
      if (k - e + 1 >= maxDays) { exit = bar.c; reason = '時間切れ'; break; }
      if (base === 'A' && x.ma25[k] != null && bar.c < x.ma25[k] * 0.98) pendingExit = true;
      if ((base === 'B' || base === 'D') && x.ma25[k] != null && bar.c < x.ma25[k]) pendingExit = true;
    }
    if (exit == null) break; // まだ保有中（データの終わり）
    const R = ((exit - entry) - entry * SW_COST / 100) / risk;
    trades.push({ rule, code, entry_date: b[e].d, entry: Math.round(entry * 10) / 10, stop: Math.round(stop * 10) / 10,
      exit_date: b[k].d, exit: Math.round(exit * 10) / 10, R: Math.round(R * 100) / 100, days: k - e + 1, reason });
    i = k + 1;
  }
  return trades;
}

function swStats_(rule, t, months) {
  if (!t.length) return { rule, trades: 0, note: 'シグナルなし' };
  const win = t.filter(r => r.R > 0), loss = t.filter(r => r.R <= 0);
  const gw = win.reduce((s, r) => s + r.R, 0), gl = -loss.reduce((s, r) => s + r.R, 0);
  let streak = 0, maxStreak = 0;
  t.slice().sort((a, b) => a.exit_date < b.exit_date ? -1 : 1).forEach(r => { streak = r.R <= 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak); });
  const years = {};
  t.forEach(r => { const y = r.entry_date.slice(0, 4); (years[y] = years[y] || []).push(r.R); });
  const note = Object.keys(years).sort().map(y => `${y}:${(years[y].reduce((s, v) => s + v, 0) / years[y].length).toFixed(2)}R`).join(' ');
  return { rule, trades: t.length, win_pct: Math.round(win.length / t.length * 100),
    avg_R: Math.round((gw - gl) / t.length * 100) / 100, PF: gl ? Math.round(gw / gl * 100) / 100 : '∞',
    avg_days: Math.round(t.reduce((s, r) => s + r.days, 0) / t.length * 10) / 10, max_losing_streak: maxStreak,
    worst_R: Math.min(...t.map(r => r.R)), per_month: Math.round(t.length / months * 10) / 10, note };
}

const SW_NAMES = { A: 'A 押し目買い', AF: 'A 押し目買い＋地合い', B: 'B 高値ブレイク', BF: 'B 高値ブレイク＋地合い',
  C: 'C 下げすぎ逆張り', CF: 'C 下げすぎ逆張り＋地合い',
  A2: 'A 押し目買い＋200日線', B2: 'B 高値ブレイク＋200日線', C2: 'C 下げすぎ逆張り＋200日線（長期上昇中の急落）',
  AF2: 'A 押し目買い＋地合い＋200日線', BF2: 'B 高値ブレイク＋地合い＋200日線',
  D: 'D 窓開け急騰の後追い（決算サプライズ型）', DF: 'D 窓開け急騰＋地合い', D2: 'D 窓開け急騰＋200日線' };

/** 実行するのはこれだけ（3〜5分かかります） */
function swingBacktest() {
  const mktBars = swDaily_('1306.T') || [];
  const mx = swIndicators_(mktBars), mkt = {};
  mktBars.forEach((b, i) => { if (mx.ma75[i] != null) mkt[b.d] = b.c > mx.ma75[i]; });

  const all = [], now = [];
  for (let s = 0; s < SW_CODES.length; s += 20) {
    const chunk = SW_CODES.slice(s, s + 20);
    const resps = UrlFetchApp.fetchAll(chunk.map(c => ({
      url: `https://query1.finance.yahoo.com/v8/finance/chart/${c}.T?range=6y&interval=1d`, headers: UA, muteHttpExceptions: true })));
    resps.forEach((r, j) => {
      const code = chunk[j], b = swParse_(r.getContentText());
      if (!b || b.length < 200) { Logger.log(`${code}: データ不足`); return; }
      const x = swIndicators_(b);
      Object.keys(SW_NAMES).forEach(rule => all.push(...swRun_(rule, code, b, x, mkt)));
      // 今日（最新の終値）でシグナルが出た銘柄
      const i = b.length - 1;
      ['A', 'B', 'D'].forEach(rule => {
        const sig = swSignal_(rule, b, x, i);
        if (!sig) return;
        const stop = sig.stop != null ? sig.stop : b[i].c - sig.atrMult * x.atr[i], risk = b[i].c - stop;
        if (!(risk > 0)) return;
        now.push([b[i].d, SW_NAMES[rule] + (mkt[b[i].d] ? '' : '（地合い×）'), code, b[i].c, '翌朝の寄り', Math.round(stop),
          Math.round(b[i].c + 3 * risk), Math.floor(400000 / risk / 100) * 100]);
      });
    });
    Utilities.sleep(500);
  }
  const dates = all.map(t => t.entry_date).sort();
  const months = dates.length ? Math.max(1, (Number(dates[dates.length - 1].slice(0, 4)) - Number(dates[0].slice(0, 4))) * 12 +
    Number(dates[dates.length - 1].slice(4, 6)) - Number(dates[0].slice(4, 6)) + 1) : 1;
  const stats = Object.keys(SW_NAMES).map(rule => {
    const st = swStats_(rule, all.filter(t => t.rule === rule), months);
    st.rule = SW_NAMES[rule]; return st;
  });

  const write = (name, header, rows) => {
    const sh = sheet_(name, header);
    sh.clearContents();
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  };
  write('swing_bt', SW_BT_HEADER, stats.map(st => SW_BT_HEADER.map(h => st[h] === undefined ? '' : st[h])));
  write('swing_trades', SW_TR_HEADER, all.map(t => SW_TR_HEADER.map(h => h === 'rule' ? SW_NAMES[t.rule] : t[h])));
  write('swing_now', SW_NOW_HEADER, now);
  stats.forEach(st => Logger.log(`${st.rule}: ${st.trades}件 勝率${st.win_pct}% 平均${st.avg_R}R PF${st.PF} 最大連敗${st.max_losing_streak} 最悪${st.worst_R}R`));
  Logger.log(`完了: ${SW_CODES.length}銘柄、取引 ${all.length}件、今日のシグナル ${now.length}件`);
}
