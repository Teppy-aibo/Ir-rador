/**
 * 本のローソク足の型（日足に置き換え）と「狩られにくい損切り」の検証（Google Apps Script版・完全無料）
 * 同じプロジェクトに追加し、このファイルを開いて candleBacktest を1回実行（3〜5分、終わるまでタブを開いたまま）。結果はシート candle_bt。
 * スイング検証.gs の swParse_ / swIndicators_ / SW_CODES / SW_COST と IR通知.gs の sheet_ / UA を使う。
 * 本は1分足で見ているが、1分足の過去データは手に入らないので日足で試す（形の考え方は同じ）。
 *
 * 型（シグナルの日の引けで判定 → 翌朝の寄りで入る、5日後と20日後の引けで手じまい、損切りなし）
 *  C1 アイランドボトム（安値圏）: 下に窓→2〜10日その下で横ばい→上に窓で島を置き去り → 買い
 *  C2 下放れ二本黒（下落中）: 下に窓を開けた陰線＋次の日も陰線 → 空売り
 *  C3 上放れ並び赤（上昇中）: 上に窓を開けた陽線＋次の日もほぼ同じ長さの陽線 → 買い
 *  C4 陽の抱き線（安値圏）: 前日の陰線を今日の陽線が包む → 買い
 *  C5 パンパカパン(PPP): 5日線＞25日線＞75日線、3本とも上向き、になった最初の日 → 買い
 *  C6 首吊り線（高値圏）: 実体が小さく長い下ヒゲ・上ヒゲほぼなし → 空売り
 *  安値圏 = 過去60日で-10%以上下げて75日線の下 / 高値圏 = 60日高値の97%以上
 * 損切りの置き場所（H2: 決算の窓・200日線の上・20日保有）
 *  L0 窓の日の安値×0.998（今のやり方＝目立つ場所） / L1 安値−ATRの0.5倍 / L2 安値−ATRの1倍 / L3 終値で安値を割ったら翌朝の寄りで売り
 * 基準: 同じ銘柄を毎日寄りで買って（空売りして）同じ日数持った場合
 */

const CB_HEADER = ['rule', 'trades', 'win_pct', 'avg_net_pct', 'excess_vs_base_pct', 'avg_net_2020_23', 'avg_net_2024_',
  'worst_pct', 'max_losing_streak', 'per_month', 'avg_R', 'note'];
const CB_NAMES = {
  C1_5: 'C1 アイランドボトム 5日', C1_20: 'C1 アイランドボトム 20日',
  C2_5: 'C2 下放れ二本黒 空売り 5日', C2_20: 'C2 下放れ二本黒 空売り 20日',
  C3_5: 'C3 上放れ並び赤 5日', C3_20: 'C3 上放れ並び赤 20日',
  C4_5: 'C4 安値圏の陽の抱き線 5日', C4_20: 'C4 安値圏の陽の抱き線 20日',
  C5_5: 'C5 パンパカパン 5日', C5_20: 'C5 パンパカパン 20日',
  C6_5: 'C6 高値圏の首吊り線 空売り 5日', C6_20: 'C6 高値圏の首吊り線 空売り 20日',
  L0: 'H2損切り L0 窓の安値×0.998（今）', L1: 'H2損切り L1 安値−0.5ATR', L2: 'H2損切り L2 安値−1ATR', L3: 'H2損切り L3 終値で安値割れ→翌寄り',
  B5: '基準 毎日買って5日', B20: '基準 毎日買って20日', S5: '基準 毎日空売りして5日', S20: '基準 毎日空売りして20日'
};
const CB_BASE = { C1_5: 'B5', C1_20: 'B20', C2_5: 'S5', C2_20: 'S20', C3_5: 'B5', C3_20: 'B20', C4_5: 'B5', C4_20: 'B20',
  C5_5: 'B5', C5_20: 'B20', C6_5: 'S5', C6_20: 'S20', L0: 'B20', L1: 'B20', L2: 'B20', L3: 'B20' };

/** 寄りで入って N 日目の引けで出る（side 1=買い, -1=空売り）。損益% */
function cbHold_(b, e, N, side) {
  const last = e + N - 1;
  if (last >= b.length) return null;
  return { g: side * (b[last].c / b[e].o - 1) * 100, days: N };
}

/** H2の損切り違い。mode: 'px'=逆指値 stop / 'close'=終値で stop を割ったら翌朝の寄り */
function cbStop_(b, e, N, stop, mode) {
  const entry = b[e].o, last = e + N - 1;
  if (last >= b.length || !(stop < entry)) return null;
  const risk = (entry - stop) / entry * 100;
  for (let k = e; k <= last; k++) {
    if (mode === 'px') {
      if (k > e && b[k].o <= stop) return { g: (b[k].o / entry - 1) * 100, days: k - e + 1, risk };
      if (b[k].l <= stop) return { g: (stop / entry - 1) * 100, days: k - e + 1, risk };
    } else if (b[k].c < stop && k < last) {
      return { g: (b[k + 1].o / entry - 1) * 100, days: k - e + 2, risk };
    }
  }
  return { g: (b[last].c / entry - 1) * 100, days: N, risk };
}

function cbRun_(b, x) {
  const out = [], n = b.length;
  const add = (rule, e, r) => { if (r) out.push({ rule, d: b[e].d, g: r.g, days: r.days, risk: r.risk }); };
  const ma5 = b.map((_, i) => i < 4 ? null : (b[i].c + b[i - 1].c + b[i - 2].c + b[i - 3].c + b[i - 4].c) / 5);
  const ppp = i => ma5[i - 5] != null && x.ma75[i - 5] != null && ma5[i] > x.ma25[i] && x.ma25[i] > x.ma75[i] &&
    ma5[i] > ma5[i - 5] && x.ma25[i] > x.ma25[i - 5] && x.ma75[i] > x.ma75[i - 5];
  for (let i = 215; i < n - 1; i++) {
    const t = b[i], p = b[i - 1], q = b[i - 2], e = i + 1;
    const body = Math.abs(t.c - t.o), rng = t.h - t.l;
    const low = b[i - 60].c > 0 && t.c / b[i - 60].c - 1 <= -0.10 && x.ma75[i] != null && t.c < x.ma75[i];
    const high = x.hi60[i] != null && t.h >= x.hi60[i] * 0.97;
    const up = x.ma25[i] != null && x.ma75[i] != null && t.c > x.ma25[i] && x.ma25[i] > x.ma75[i];
    const down = x.ma25[i] != null && x.ma75[i] != null && t.c < x.ma25[i] && x.ma25[i] < x.ma75[i];
    const both = (k, s) => { add(k + '_5', e, cbHold_(b, e, 5, s)); add(k + '_20', e, cbHold_(b, e, 20, s)); };
    // 基準
    add('B5', e, cbHold_(b, e, 5, 1)); add('B20', e, cbHold_(b, e, 20, 1));
    add('S5', e, cbHold_(b, e, 5, -1)); add('S20', e, cbHold_(b, e, 20, -1));
    // C1 アイランドボトム: 今日 上窓（今日の安値 > 島の高値）、島の前に下窓（島の高値 < 島の前の日の安値）
    for (let len = 2; len <= 10; len++) {
      const s = i - len, pre = s - 1; // 島 = s..i-1
      if (pre < 60) break;
      let ih = -Infinity; for (let j = s; j < i; j++) ih = Math.max(ih, b[j].h);
      if (t.l > ih && ih < b[pre].l && b[pre].c / b[pre - 60].c - 1 <= -0.10) { both('C1', 1); break; }
    }
    // C2 下放れ二本黒: 下落中、昨日 下窓の陰線、今日も陰線
    if (down && p.h < q.l && p.c < p.o && t.c < t.o) both('C2', -1);
    // C3 上放れ並び赤: 上昇中、昨日 上窓の陽線、今日も陽線で実体の長さが0.7〜1.3倍、寄りが昨日の寄りの±2%
    const pb = p.c - p.o;
    if (up && p.l > q.h && pb > 0 && t.c > t.o && body >= 0.7 * pb && body <= 1.3 * pb && Math.abs(t.o / p.o - 1) <= 0.02) both('C3', 1);
    // C4 安値圏の陽の抱き線
    if (low && p.c < p.o && t.c > t.o && t.o <= p.c && t.c >= p.o) both('C4', 1);
    // C5 PPP になった最初の日
    if (ppp(i) && !ppp(i - 1)) both('C5', 1);
    // C6 高値圏の首吊り線: 実体が値幅の3割以下、下ヒゲが実体の2倍以上、上ヒゲが値幅の1割以下
    if (high && up && rng > 0 && body <= 0.3 * rng && Math.min(t.o, t.c) - t.l >= 2 * body && t.h - Math.max(t.o, t.c) <= 0.1 * rng) both('C6', -1);
    // H2 の損切り違い
    const h2 = t.o >= p.c * 1.05 && x.vol20[i] > 0 && t.v >= 2 * x.vol20[i] && t.c >= (t.h + t.l) / 2 && t.c > p.c * 1.03 &&
      x.ma200[i] != null && t.c > x.ma200[i] && x.ma200[i] >= x.ma200[i - 10];
    if (h2 && x.atr[i]) {
      add('L0', e, cbStop_(b, e, 20, t.l * 0.998, 'px'));
      add('L1', e, cbStop_(b, e, 20, t.l - 0.5 * x.atr[i], 'px'));
      add('L2', e, cbStop_(b, e, 20, t.l - 1.0 * x.atr[i], 'px'));
      add('L3', e, cbStop_(b, e, 20, t.l, 'close'));
    }
  }
  return out;
}

function candleBacktest() {
  const all = [];
  let firstD = '99999999', lastD = '00000000';
  for (let s = 0; s < SW_CODES.length; s += 20) {
    const chunk = SW_CODES.slice(s, s + 20);
    const resps = UrlFetchApp.fetchAll(chunk.map(c => ({
      url: `https://query1.finance.yahoo.com/v8/finance/chart/${c}.T?range=6y&interval=1d`, headers: UA, muteHttpExceptions: true })));
    resps.forEach((r, j) => {
      const b = swParse_(r.getContentText());
      if (!b || b.length < 300) { Logger.log(`${chunk[j]}: データ不足`); return; }
      if (b[215].d < firstD) firstD = b[215].d; if (b[b.length - 1].d > lastD) lastD = b[b.length - 1].d;
      all.push(...cbRun_(b, swIndicators_(b)));
    });
    Utilities.sleep(500);
  }
  const months = Math.max(1, (Number(lastD.slice(0, 4)) - Number(firstD.slice(0, 4))) * 12 + Number(lastD.slice(4, 6)) - Number(firstD.slice(4, 6)) + 1);
  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0, r2 = v => Math.round(v * 100) / 100;
  const stat = {};
  Object.keys(CB_NAMES).forEach(rule => {
    const t = all.filter(r => r.rule === rule).sort((a, b) => a.d < b.d ? -1 : 1);
    const net = t.map(r => r.g - (/^[BS]\d/.test(rule) ? 0 : SW_COST));
    stat[rule] = { t, net, avg: mean(net) };
  });
  const rows = Object.keys(CB_NAMES).map(rule => {
    const { t, net, avg } = stat[rule];
    if (!t.length) return [CB_NAMES[rule], 0, '', '', '', '', '', '', '', '', '', 'シグナルなし'];
    let st = 0, mx = 0; net.forEach(v => { st = v <= 0 ? st + 1 : 0; mx = Math.max(mx, st); });
    const years = {}; t.forEach((r, i) => (years[r.d.slice(0, 4)] = years[r.d.slice(0, 4)] || []).push(net[i]));
    const bk = CB_BASE[rule], avgDays = mean(t.map(r => r.days));
    const excess = bk ? avg - stat[bk].avg * avgDays / Number(bk.slice(1)) : '';
    const R = rule[0] === 'L' ? r2(mean(t.map((r, i) => net[i] / r.risk))) : '';
    const note = (rule[0] === 'L' ? `損切り幅平均${mean(t.map(r => r.risk)).toFixed(1)}% 保有${Math.round(avgDays)}日 ` : '') +
      Object.keys(years).sort().map(y => `${y}:${mean(years[y]).toFixed(1)}%`).join(' ');
    return [CB_NAMES[rule], t.length, Math.round(net.filter(v => v > 0).length / t.length * 100), r2(avg),
      excess === '' ? '' : r2(excess), r2(mean(net.filter((v, i) => t[i].d < '20240101'))), r2(mean(net.filter((v, i) => t[i].d >= '20240101'))),
      r2(net.reduce((m, v) => Math.min(m, v), Infinity)), mx, Math.round(t.length / months * 10) / 10, R, note];
  });
  const sh = sheet_('candle_bt', CB_HEADER);
  sh.clearContents();
  sh.getRange(1, 1, 1, CB_HEADER.length).setValues([CB_HEADER]);
  sh.getRange(2, 1, rows.length, CB_HEADER.length).setValues(rows);
  rows.forEach(r => Logger.log(`${r[0]}: ${r[1]}件 勝率${r[2]}% 平均${r[3]}% 超過${r[4]}% R${r[10]}`));
  Logger.log(`完了: ${firstD}〜${lastD} → シート candle_bt`);
}
