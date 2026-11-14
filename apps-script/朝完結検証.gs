/**
 * 朝に注文を置いて終わる型の検証（Google Apps Script版・完全無料）
 * スイング検証.gs と同じプロジェクトに「ファイル ＋ → スクリプト」で追加し、morningBacktest を1回実行するだけ（3〜5分）。
 * スイング検証.gs の swDaily_ / swParse_ / swIndicators_ / SW_CODES と IR通知.gs の sheet_ / UA を使う。
 *
 * 前提（日中は一度も見ない）:
 *  - 朝8:50〜8:59に 寄り成 か 逆指値 で入り、同時にOCO（利確指値＋損切り逆指値）を置く
 *  - どちらにも当たらなければ 引け成 で決済（持ち越しなし）
 *  - 同じ日に利確と損切りの両方の価格に触れた日は「損切りが先」と数える（厳しめ）
 *  - 寄りで損切り価格を越えて始まった場合は寄り値で決済（逆指値の場合）
 *  - ギャップの条件は実際の始値で判定（実際には8:59の気配で判断するので少しズレる）
 *  - 往復コスト0.1%を差し引く。成績は R（損切り幅の何倍か）
 *
 * 型:
 *  G1 窓開け急騰の翌日（前日: +5%窓・出来高2倍・上半分引け）→ 寄り成で買い
 *  G2 長期上昇中（200日線の上・上向き）のギャップダウン -2〜-6% → 寄り成で買い（押し目の反発狙い）
 *  G3 上昇トレンド（終値＞25日線＞75日線）で 前日高値+1ティックの逆指値買い
 *  G4 ギャップアップ +3〜8% の寄り天売り → 寄り成で空売り（信用）
 *  G5 上昇トレンドでギャップアップ +2〜5% → 寄り成で買い（勢いに乗る）
 *  G6 ギャップダウン -3〜-8% の続落売り（200日線の下）→ 寄り成で空売り
 *  G7 大幅ギャップアップ +8〜20%（S高張り付き以外）の寄り天売り → 寄り成で空売り（11/10 森永・三菱重・フジクラ・メイコーが寄り＞引け）
 *  それぞれ 損切り 1/2/3%、利確 1/2/3R の9通り、地合いフィルタ（TOPIX 1306 が75日線の上＝買い、下＝売り）あり/なしで比べる
 *  過剰適合を避けるため 2020〜2023年（作った期間）と 2024年以降（確かめる期間）の成績を分けて出す
 */

const MB_HEADER = ['rule', 'stop_pct', 'target_R', 'trades', 'win_pct', 'avg_R', 'PF', 'max_losing_streak', 'per_month',
  'avg_R_2020_23', 'avg_R_2024_', 'yen_per_month_1R5man', 'note'];
const MB_NAMES = { G1: 'G1 窓開け急騰の翌日 寄り買い', G2: 'G2 上昇中のギャップダウン 寄り買い', G3: 'G3 前日高値の逆指値買い',
  G4: 'G4 ギャップアップ寄り天 空売り', G5: 'G5 上昇中のギャップアップ 寄り買い', G6: 'G6 下降中のギャップダウン 続落売り', G7: 'G7 大幅ギャップアップ(+8〜20%) 寄り天 空売り' };
const MB_STOPS = [1, 2, 3], MB_TARGETS = [1, 2, 3];

/** その日 i に入るか。入るなら {side: 1買い/-1売り, entry} */
function mbSignal_(rule, b, x, i) {
  const p = b[i - 1], o = b[i].o, gap = o / p.c - 1;
  const m25 = x.ma25[i - 1], m75 = x.ma75[i - 1], m200 = x.ma200[i - 1];
  if (m25 == null || m75 == null || i < 211) return null;
  const up200 = m200 != null && p.c > m200 && m200 >= x.ma200[i - 11];
  if (rule === 'G1') {
    const q = b[i - 2];
    if (p.o >= q.c * 1.05 && x.vol20[i - 1] > 0 && p.v >= 2 * x.vol20[i - 1] && p.c >= (p.h + p.l) / 2 && p.c > q.c * 1.03)
      return { side: 1, entry: o };
    return null;
  }
  if (rule === 'G2') return up200 && gap <= -0.02 && gap >= -0.06 ? { side: 1, entry: o } : null;
  if (rule === 'G3') {
    if (!(p.c > m25 && m25 > m75)) return null;
    const trig = p.h + tick_(p.h);
    if (b[i].h < trig) return null;
    return { side: 1, entry: Math.max(o, trig), breakout: true };
  }
  if (rule === 'G4') return gap >= 0.03 && gap <= 0.08 ? { side: -1, entry: o } : null;
  if (rule === 'G5') return p.c > m25 && m25 > m75 && gap >= 0.02 && gap <= 0.05 ? { side: 1, entry: o } : null;
  if (rule === 'G7') return gap > 0.08 && gap <= 0.20 ? { side: -1, entry: o } : null;
  if (rule === 'G6') return m200 != null && p.c < m200 && gap <= -0.03 && gap >= -0.08 ? { side: -1, entry: o } : null;
  return null;
}

/** 呼値（TOPIX500以外の一般の呼値で近似） */
function tick_(px) {
  return px < 3000 ? 1 : px < 5000 ? 5 : px < 30000 ? 10 : px < 50000 ? 50 : 100;
}

/** 1日で完結する1回の取引の R */
function mbTrade_(sig, bar, stopPct, tR) {
  const e = sig.entry, s = sig.side, risk = e * stopPct / 100;
  const stop = e - s * risk, target = e + s * tR * risk;
  const hitStop = s > 0 ? bar.l <= stop : bar.h >= stop;
  const hitTgt = s > 0 ? bar.h >= target : bar.l <= target;
  let exit, reason;
  if (hitStop) { exit = stop; reason = '損切り'; }            // 両方触れた日も損切りが先（厳しめ）
  else if (hitTgt) { exit = target; reason = '利確'; }
  else { exit = bar.c; reason = '引け成'; }
  // 逆指値ブレイク: 高値を抜けた後どこまで下げたかは日足では分からないので、安値が損切り以下なら損切り扱い
  const R = (s * (exit - e) - e * SW_COST / 100) / risk;
  return { R: Math.round(R * 100) / 100, reason };
}

function morningBacktest() {
  const mktBars = swDaily_('1306.T') || [];
  const mx = swIndicators_(mktBars), mkt = {};
  mktBars.forEach((b, i) => { if (mx.ma75[i] != null) mkt[b.d] = b.c > mx.ma75[i]; });

  const res = {}; // key -> [{d, R}]
  const add = (k, d, R) => (res[k] = res[k] || []).push({ entry_date: d, exit_date: d, R, days: 1 });
  let firstD = '99999999', lastD = '00000000';
  for (let s = 0; s < SW_CODES.length; s += 20) {
    const chunk = SW_CODES.slice(s, s + 20);
    const resps = UrlFetchApp.fetchAll(chunk.map(c => ({
      url: `https://query1.finance.yahoo.com/v8/finance/chart/${c}.T?range=6y&interval=1d`, headers: UA, muteHttpExceptions: true })));
    resps.forEach((r, j) => {
      const b = swParse_(r.getContentText());
      if (!b || b.length < 260) { Logger.log(`${chunk[j]}: データ不足`); return; }
      const x = swIndicators_(b);
      for (let i = 211; i < b.length; i++) {
        const d = b[i].d, prevD = b[i - 1].d;
        if (d < firstD) firstD = d; if (d > lastD) lastD = d;
        Object.keys(MB_NAMES).forEach(rule => {
          const sig = mbSignal_(rule, b, x, i);
          if (!sig || !(sig.entry > 0)) return;
          const mOk = sig.side > 0 ? mkt[prevD] === true : mkt[prevD] === false;
          MB_STOPS.forEach(sp => MB_TARGETS.forEach(t => {
            const tr = mbTrade_(sig, b[i], sp, t);
            add(`${rule}|${sp}|${t}|`, d, tr.R);
            if (mOk) add(`${rule}|${sp}|${t}|F`, d, tr.R);
          }));
        });
      }
    });
    Utilities.sleep(500);
  }
  const months = Math.max(1, (Number(lastD.slice(0, 4)) - Number(firstD.slice(0, 4))) * 12 +
    Number(lastD.slice(4, 6)) - Number(firstD.slice(4, 6)) + 1);
  const avg = a => a.length ? Math.round(a.reduce((s, v) => s + v, 0) / a.length * 100) / 100 : '';
  const rows = Object.keys(res).map(k => {
    const [rule, sp, t, f] = k.split('|'), tr = res[k];
    tr.sort((a, b) => a.entry_date < b.entry_date ? -1 : 1);
    const st = swStats_(k, tr, months);
    const early = tr.filter(r => r.entry_date < '20240101').map(r => r.R), late = tr.filter(r => r.entry_date >= '20240101').map(r => r.R);
    return [MB_NAMES[rule] + (f ? '＋地合い' : ''), Number(sp), Number(t), st.trades, st.win_pct, st.avg_R, st.PF,
      st.max_losing_streak, st.per_month, avg(early), avg(late), Math.round(st.avg_R * st.per_month * 50000), st.note];
  });
  rows.sort((a, b) => b[5] - a[5]);
  const sh = sheet_('morning_bt', MB_HEADER);
  sh.clearContents();
  sh.getRange(1, 1, 1, MB_HEADER.length).setValues([MB_HEADER]);
  if (rows.length) sh.getRange(2, 1, rows.length, MB_HEADER.length).setValues(rows);
  rows.slice(0, 15).forEach(r => Logger.log(`${r[0]} 損切り${r[1]}% 利確${r[2]}R: ${r[3]}件 勝率${r[4]}% 平均${r[5]}R ` +
    `(前半${r[9]} 後半${r[10]}) 月${r[8]}回 → 1R=5万で月${r[11]}円`));
  Logger.log(`完了: ${SW_CODES.length}銘柄 ${firstD}〜${lastD}、${rows.length}通り → シート morning_bt`);
}
