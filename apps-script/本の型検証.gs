/**
 * 本の3つの型を過去データで検証（Google Apps Script版・完全無料）
 * 同じプロジェクトに追加し、bookBacktest を1回実行（3〜5分、終わるまでタブを開いたまま）。結果はシート book_bt。
 * スイング検証.gs の swParse_ / swIndicators_ / SW_CODES / SW_COST と IR通知.gs の sheet_ / UA を使う。
 * 株価データだけで検証できる部分だけを試す（PER・時価総額・優待の有無はこのデータにないので使わない）。
 *
 * K1 決算モメンタム（本: 決算翌日〜3営業日以内に買う・含み損-5%で売る・20営業日で利確）
 *    シグナル: +5%以上の窓・出来高2倍・上半分引け（決算サプライズの代わり）
 *    a 翌日の寄り / b 2日目の寄り / c 3日目の寄りで買う、損切り-5%、20営業日後の引けで売る
 *    d 決算月(2・5・8・11月)だけ / e さらに「チャートが横ばい〜ゆるやかな上昇」(過去60日 -10%〜+20%) / f さらに「新高値間近」(250日高値の95%以上)
 * K2 新高値ブレイク（本: 過去2年の新高値・損切り-8%・株価2倍か半年〜2年で売る）
 *    終値が過去500日（約2年）の高値を更新 → 翌朝の寄りで買い、損切り-8%、+100%で利確、120日 / 250日たったら売る
 *    a 損切りなし120日 / b 損切り-8%で120日 / c 損切り-8%で250日 / d 損切り-8%・+100%利確・250日
 * K3 優待・3月権利の季節性（本: 権利確定日の3〜6か月前に買い、2週間〜1か月前に売る）
 *    優待の有無が分からないので、大型株全体で「12月の最初の営業日に買い、3月の最初の営業日に売る」を、他の月の同じ長さと比べる
 * K4 逆・決算モメンタム（本: 悪い決算の翌日の寄りで空売り、地合いが悪いときほど効く）
 *    シグナル: -5%以下の窓・出来高2倍・下半分引け → 翌日の寄りで空売り、損切り+5%、20営業日後の引けで買い戻す
 *    a 全部 / b 決算月だけ / c 決算月＋TOPIX(1306)が75日線の下
 * 基準: 同じ銘柄を毎日買って同じ日数持った場合（相場全体の上げを差し引くため）
 */

const BK_HEADER = ['rule', 'trades', 'win_pct', 'avg_net_pct', 'avg_days', 'excess_vs_base_pct', 'avg_net_2020_23', 'avg_net_2024_',
  'worst_pct', 'max_losing_streak', 'per_month', 'note'];
const BK_NAMES = {
  K1a: 'K1a 決算モメンタム 翌日寄り 損切り-5% 20日', K1b: 'K1b 決算モメンタム 2日目寄り', K1c: 'K1c 決算モメンタム 3日目寄り',
  K1d: 'K1d 翌日寄り＋決算月だけ', K1e: 'K1e 決算月＋チャート横ばい〜ゆるやか上昇', K1f: 'K1f 決算月＋横ばい＋新高値間近',
  K2a: 'K2a 2年来高値ブレイク 損切りなし 120日', K2b: 'K2b 2年来高値ブレイク 損切り-8% 120日', K2c: 'K2c 2年来高値ブレイク 損切り-8% 250日',
  K2d: 'K2d 2年来高値ブレイク -8%・2倍で利確・250日',
  K4a: 'K4a 逆・決算モメンタム 空売り 損切り+5% 20日', K4b: 'K4b 空売り＋決算月だけ', K4c: 'K4c 空売り＋決算月＋地合い悪い',
  K3: 'K3 12月初に買い→3月初に売る', K3x: 'K3 比較: ほかの月に同じ長さ(約60日)持つ',
  B20: '基準 毎日買って20日', S20: '基準 毎日空売りして20日', B60: '基準 毎日買って60日', B120: '基準 毎日買って120日', B250: '基準 毎日買って250日'
};
const BK_BASE = { K1a: 'B20', K1b: 'B20', K1c: 'B20', K1d: 'B20', K1e: 'B20', K1f: 'B20', K2a: 'B120', K2b: 'B120', K2c: 'B250', K2d: 'B250', K3: 'B60', K3x: 'B60', K4a: 'S20', K4b: 'S20', K4c: 'S20' };

/** 買い→損切り/利確/日数で決済。stopPct/tpPct は null なら使わない */
function bkHold_(b, e, N, stopPct, tpPct) {
  const entry = b[e].o, last = Math.min(b.length - 1, e + N - 1);
  if (e + N - 1 >= b.length) return null;
  const stop = stopPct ? entry * (1 - stopPct / 100) : null, tp = tpPct ? entry * (1 + tpPct / 100) : null;
  for (let k = e; k <= last; k++) {
    if (stop && k > e && b[k].o <= stop) return { g: (b[k].o / entry - 1) * 100, days: k - e + 1 };
    if (stop && b[k].l <= stop) return { g: -stopPct, days: k - e + 1 };
    if (tp && b[k].h >= tp) return { g: Math.max(tpPct, (b[k].o / entry - 1) * 100), days: k - e + 1 };
  }
  return { g: (b[last].c / entry - 1) * 100, days: last - e + 1 };
}

/** 空売り版: 寄りで売り→損切り(上)/日数で買い戻し。g は空売りの損益% */
function bkShort_(b, e, N, stopPct) {
  if (e + N - 1 >= b.length) return null;
  const entry = b[e].o, last = e + N - 1, stop = entry * (1 + stopPct / 100);
  for (let k = e; k <= last; k++) {
    if (k > e && b[k].o >= stop) return { g: -(b[k].o / entry - 1) * 100, days: k - e + 1 };
    if (b[k].h >= stop) return { g: -stopPct, days: k - e + 1 };
  }
  return { g: -(b[last].c / entry - 1) * 100, days: last - e + 1 };
}

function bkRun_(b, x, mkt) {
  const out = [], n = b.length, add = (rule, e, r) => { if (r) out.push({ rule, d: b[e].d, g: r.g, days: r.days }); };
  const hi = (i, len) => { let m = -Infinity; for (let j = Math.max(0, i - len); j < i; j++) m = Math.max(m, b[j].h); return m; };
  for (let i = 260; i < n - 1; i++) {
    const c = b[i].c, p = b[i - 1], m = +b[i].d.slice(4, 6);
    // 基準
    [20, 60, 120, 250].forEach(N => add('B' + N, i + 1, bkHold_(b, i + 1, N, null, null)));
    add('S20', i + 1, bkShort_(b, i + 1, 20, 1e9));
    // K1 決算モメンタム
    const gap = b[i].o >= p.c * 1.05 && x.vol20[i] > 0 && b[i].v >= 2 * x.vol20[i] && c >= (b[i].h + b[i].l) / 2 && c > p.c * 1.03;
    if (gap) {
      add('K1a', i + 1, bkHold_(b, i + 1, 20, 5, null));
      if (i + 2 < n) add('K1b', i + 2, bkHold_(b, i + 2, 20, 5, null));
      if (i + 3 < n) add('K1c', i + 3, bkHold_(b, i + 3, 20, 5, null));
      if ([2, 5, 8, 11].includes(m)) {
        add('K1d', i + 1, bkHold_(b, i + 1, 20, 5, null));
        const r60 = p.c / b[i - 61].c - 1;
        if (r60 >= -0.1 && r60 <= 0.2) {
          add('K1e', i + 1, bkHold_(b, i + 1, 20, 5, null));
          if (c >= hi(i, 250) * 0.95) add('K1f', i + 1, bkHold_(b, i + 1, 20, 5, null));
        }
      }
    }
    // K4 逆・決算モメンタム（空売り）
    const gd = b[i].o <= p.c * 0.95 && x.vol20[i] > 0 && b[i].v >= 2 * x.vol20[i] && c <= (b[i].h + b[i].l) / 2 && c < p.c * 0.97;
    if (gd) {
      add('K4a', i + 1, bkShort_(b, i + 1, 20, 5));
      if ([2, 5, 8, 11].includes(m)) {
        add('K4b', i + 1, bkShort_(b, i + 1, 20, 5));
        if (mkt[b[i].d] === false) add('K4c', i + 1, bkShort_(b, i + 1, 20, 5));
      }
    }
    // K2 新高値ブレイク（過去500日の高値を終値で更新、前日はまだ更新していない）
    if (i >= 500) {
      const h500 = hi(i, 500);
      if (c > h500 && p.c <= hi(i - 1, 500)) {
        add('K2a', i + 1, bkHold_(b, i + 1, 120, null, null));
        add('K2b', i + 1, bkHold_(b, i + 1, 120, 8, null));
        add('K2c', i + 1, bkHold_(b, i + 1, 250, 8, null));
        add('K2d', i + 1, bkHold_(b, i + 1, 250, 8, 100));
      }
    }
    // K3 季節性: 月の最初の営業日
    if (b[i].d.slice(0, 6) !== p.d.slice(0, 6)) {
      add(m === 12 ? 'K3' : 'K3x', i, bkHold_(b, i, 60, null, null));
    }
  }
  return out;
}

function bookBacktest() {
  const mb = swDaily_('1306.T') || [], mx = swIndicators_(mb), mkt = {};
  mb.forEach((q, i) => { if (mx.ma75[i] != null) mkt[q.d] = q.c > mx.ma75[i]; });
  const all = [];
  let firstD = '99999999', lastD = '00000000';
  for (let s = 0; s < SW_CODES.length; s += 20) {
    const chunk = SW_CODES.slice(s, s + 20);
    const resps = UrlFetchApp.fetchAll(chunk.map(c => ({
      url: `https://query1.finance.yahoo.com/v8/finance/chart/${c}.T?range=6y&interval=1d`, headers: UA, muteHttpExceptions: true })));
    resps.forEach((r, j) => {
      const b = swParse_(r.getContentText());
      if (!b || b.length < 300) { Logger.log(`${chunk[j]}: データ不足`); return; }
      if (b[260].d < firstD) firstD = b[260].d; if (b[b.length - 1].d > lastD) lastD = b[b.length - 1].d;
      all.push(...bkRun_(b, swIndicators_(b), mkt));
    });
    Utilities.sleep(500);
  }
  const months = Math.max(1, (Number(lastD.slice(0, 4)) - Number(firstD.slice(0, 4))) * 12 + Number(lastD.slice(4, 6)) - Number(firstD.slice(4, 6)) + 1);
  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0, r2 = v => Math.round(v * 100) / 100;
  const stat = {};
  Object.keys(BK_NAMES).forEach(rule => {
    const t = all.filter(r => r.rule === rule).sort((a, b) => a.d < b.d ? -1 : 1);
    const net = t.map(r => r.g - (rule[0] === 'B' || rule[0] === 'S' ? 0 : SW_COST));
    stat[rule] = { t, net, avg: mean(net) };
  });
  const rows = Object.keys(BK_NAMES).map(rule => {
    const { t, net, avg } = stat[rule];
    if (!t.length) return [BK_NAMES[rule], 0, '', '', '', '', '', '', '', '', '', 'シグナルなし'];
    let st = 0, mx = 0; net.forEach(v => { st = v <= 0 ? st + 1 : 0; mx = Math.max(mx, st); });
    const years = {}; t.forEach((r, i) => (years[r.d.slice(0, 4)] = years[r.d.slice(0, 4)] || []).push(net[i]));
    const base = BK_BASE[rule] ? stat[BK_BASE[rule]].avg : null;
    // 損切りで早く終わった取引もあるので、基準は「実際の平均保有日数」に合わせて按分する
    const avgDays = mean(t.map(r => r.days)), baseDays = BK_BASE[rule] ? Number(BK_BASE[rule].slice(1)) : null;
    const excess = base != null ? avg - base * avgDays / baseDays : '';
    return [BK_NAMES[rule], t.length, Math.round(net.filter(v => v > 0).length / t.length * 100), r2(avg), Math.round(avgDays),
      excess === '' ? '' : r2(excess), r2(mean(net.filter((v, i) => t[i].d < '20240101'))), r2(mean(net.filter((v, i) => t[i].d >= '20240101'))),
      r2(net.reduce((m, v) => Math.min(m, v), Infinity)), mx, Math.round(t.length / months * 10) / 10,
      Object.keys(years).sort().map(y => `${y}:${mean(years[y]).toFixed(1)}%`).join(' ')];
  });
  const sh = sheet_('book_bt', BK_HEADER);
  sh.clearContents();
  sh.getRange(1, 1, 1, BK_HEADER.length).setValues([BK_HEADER]);
  sh.getRange(2, 1, rows.length, BK_HEADER.length).setValues(rows);
  rows.forEach(r => Logger.log(`${r[0]}: ${r[1]}件 勝率${r[2]}% 平均${r[3]}% 保有${r[4]}日 超過${r[5]}%`));
  Logger.log(`完了: ${firstD}〜${lastD} → シート book_bt`);
}
