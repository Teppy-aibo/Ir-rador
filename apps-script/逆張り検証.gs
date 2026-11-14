/**
 * 本の「大型株の逆張り」の買い条件と利確ルールの検証（Google Apps Script版・完全無料）
 * 同じプロジェクトに追加し、このファイルを開いて reversalBacktest を1回実行（3〜5分、終わるまでタブを開いたまま）。結果はシート rev_bt。
 * スイング検証.gs の swParse_ / swIndicators_ / SW_CODES / SW_COST と IR通知.gs の sheet_ / UA を使う。
 *
 * どれも「引けで条件を満たす → 翌朝の寄りで買う → 利確の指値（本の表どおり）→ 20日たっても届かなければ引けで売る」。朝の注文だけで完結する。
 *  R1 前日比-2.5%以下の急落 → 利確: 急落前の終値まで戻したら
 *  R2 25日線を5%以上割り込んだ → 利確: 25日線まで戻したら（b: 100日線の上で止まっている時だけ）
 *  R3 ボリンジャーバンド(20日)-2σ以下で引け → 利確: 中央線まで（b: -3σ）
 *     R3c: -2σで買い、-3σを終値で割ったら翌朝の寄りで損切り（本のシナリオA）
 *  R4 RCI(9日)が-90%以下 → 利確: 25日線まで（b: RCI 26日が-90%以下）
 *  R5 ダブルボトム: 1番底が-2σの外、2番底が-2σの内側（20〜60日の間隔、安値の差3%以内）で、2番底から反発した日 → 利確: 25日線
 *  それぞれ「地合い」版も出す（TOPIX ETF 1306 が75日線の上の日だけ）。本の「下落中のセクターは見るだけ」に近い
 * 基準: 同じ銘柄を毎日買って20日持った平均を、実際の保有日数で按分して差し引く
 */

const RV_HEADER = ['rule', 'trades', 'win_pct', 'avg_net_pct', 'avg_days', 'excess_vs_base_pct', 'avg_net_2020_23', 'avg_net_2024_',
  'worst_pct', 'max_losing_streak', 'per_month', 'hit_target_pct', 'note'];
const RV_FOCUS = { '6857': 'アドテスト', '4062': 'イビデン', '8035': '東エレク', '7011': '三菱重' }; // ふだんデイで触る銘柄は別に集計
const RV_NAMES = {
  R1: 'R1 前日比-2.5%急落→急落前の終値で利確', R2: 'R2 25日線を5%割れ→25日線で利確', R2b: 'R2b 同＋100日線の上',
  R3: 'R3 BB-2σ→中央線で利確', R3b: 'R3b BB-3σ→中央線で利確', R3c: 'R3c BB-2σ→中央線、-3σ終値割れで損切り',
  R4: 'R4 RCI9≦-90→25日線で利確', R4b: 'R4b RCI26≦-90→25日線で利確', R5: 'R5 ダブルボトム(2番底が-2σの内側)→25日線で利確',
  B20: '基準 毎日買って20日'
};

/** 寄りで買い→指値 target に届いたら利確、stopClose を終値で割ったら翌寄りで損切り、N日で引け */
function rvHold_(b, e, N, target, stopClose) {
  const entry = b[e].o, last = e + N - 1;
  if (last >= b.length) return null;
  if (target <= entry) return { g: 0, days: 1, hit: true, skip: true }; // 寄りで既に届いている＝取引にならない
  for (let k = e; k <= last; k++) {
    if (b[k].h >= target) return { g: (Math.max(target, k > e ? b[k].o : target) / entry - 1) * 100, days: k - e + 1, hit: true };
    if (stopClose && b[k].c < stopClose[k] && k < last) return { g: (b[k + 1].o / entry - 1) * 100, days: k - e + 2, hit: false };
  }
  return { g: (b[last].c / entry - 1) * 100, days: N, hit: false };
}

function rvRci_(b, i, n) {
  if (i < n - 1) return null;
  const px = []; for (let j = 0; j < n; j++) px.push(b[i - j].c); // j=0 が最新
  const order = px.map((v, j) => j).sort((a, c) => px[c] - px[a]);
  const rank = []; order.forEach((j, r) => rank[j] = r + 1);
  let d = 0; for (let j = 0; j < n; j++) d += Math.pow((j + 1) - rank[j], 2);
  return (1 - 6 * d / (n * (n * n - 1))) * 100;
}

function rvRun_(b, x, mkt) {
  const out = [], n = b.length;
  const ma = k => b.map((_, i) => { if (i < k - 1) return null; let s = 0; for (let j = i - k + 1; j <= i; j++) s += b[j].c; return s / k; });
  const m20 = ma(20), m100 = ma(100);
  const sd = b.map((_, i) => { if (i < 19) return null; let s = 0; for (let j = i - 19; j <= i; j++) s += Math.pow(b[j].c - m20[i], 2); return Math.sqrt(s / 20); });
  const lo2 = b.map((_, i) => sd[i] == null ? null : m20[i] - 2 * sd[i]), lo3 = b.map((_, i) => sd[i] == null ? null : m20[i] - 3 * sd[i]);
  const add = (rule, i, r) => {
    if (!r || r.skip) return;
    out.push({ rule, d: b[i + 1].d, g: r.g, days: r.days, hit: r.hit });
    if (mkt[b[i].d] === true) out.push({ rule: rule + 'F', d: b[i + 1].d, g: r.g, days: r.days, hit: r.hit });
  };
  for (let i = 215; i < n - 1; i++) {
    const t = b[i], p = b[i - 1], e = i + 1;
    out.push({ rule: 'B20', d: b[e].d, ...(rvHold_(b, e, 20, Infinity, null) || { g: NaN }) });
    if (t.c <= p.c * 0.975) add('R1', i, rvHold_(b, e, 20, p.c, null));
    if (x.ma25[i] && t.c <= x.ma25[i] * 0.95) {
      add('R2', i, rvHold_(b, e, 20, x.ma25[i], null));
      if (m100[i] && t.c > m100[i]) add('R2b', i, rvHold_(b, e, 20, x.ma25[i], null));
    }
    if (lo2[i] != null && t.c <= lo2[i] && p.c > lo2[i - 1]) {
      add('R3', i, rvHold_(b, e, 20, m20[i], null));
      add('R3c', i, rvHold_(b, e, 20, m20[i], lo3));
    }
    if (lo3[i] != null && t.c <= lo3[i] && p.c > lo3[i - 1]) add('R3b', i, rvHold_(b, e, 20, m20[i], null));
    const r9 = rvRci_(b, i, 9), r9p = rvRci_(b, i - 1, 9);
    if (r9 != null && r9 <= -90 && r9p > -90 && x.ma25[i]) add('R4', i, rvHold_(b, e, 20, x.ma25[i], null));
    const r26 = rvRci_(b, i, 26), r26p = rvRci_(b, i - 1, 26);
    if (r26 != null && r26 <= -90 && r26p > -90 && x.ma25[i]) add('R4b', i, rvHold_(b, e, 20, x.ma25[i], null));
    // R5 ダブルボトム: i-1 が2番底（直近5日の最安値）、今日 陽線で反発
    const b2 = i - 1;
    let isLow2 = true; for (let j = b2 - 4; j < b2; j++) if (b[j].l <= b[b2].l) isLow2 = false;
    if (isLow2 && t.c > t.o && t.c > p.h && lo2[b2] != null && b[b2].c > lo2[b2]) {
      for (let k = b2 - 20; k >= b2 - 60 && k > 25; k--) {
        let isLow1 = true; for (let j = k - 5; j <= k + 5; j++) if (j !== k && b[j].l <= b[k].l) isLow1 = false;
        if (!isLow1) continue;
        let mid = -Infinity; for (let j = k + 1; j < b2; j++) mid = Math.max(mid, b[j].h);
        if (lo2[k] != null && b[k].l < lo2[k] && Math.abs(b[b2].l / b[k].l - 1) <= 0.03 && mid > b[k].l * 1.05 && x.ma25[i]) {
          add('R5', i, rvHold_(b, e, 20, x.ma25[i], null)); break;
        }
      }
    }
  }
  return out;
}

function reversalBacktest() {
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
      if (b[215].d < firstD) firstD = b[215].d; if (b[b.length - 1].d > lastD) lastD = b[b.length - 1].d;
      all.push(...rvRun_(b, swIndicators_(b), mkt).map(r => (r.code = chunk[j], r)));
    });
    Utilities.sleep(500);
  }
  const months = Math.max(1, (Number(lastD.slice(0, 4)) - Number(firstD.slice(0, 4))) * 12 + Number(lastD.slice(4, 6)) - Number(firstD.slice(4, 6)) + 1);
  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0, r2 = v => Math.round(v * 100) / 100;
  const base = mean(all.filter(r => r.rule === 'B20' && !isNaN(r.g)).map(r => r.g));
  const rules = [];
  Object.keys(RV_NAMES).forEach(k => { rules.push(k); if (k !== 'B20') rules.push(k + 'F'); });
  const rows = rules.map(rule => {
    const name = RV_NAMES[rule.replace(/F$/, '')] + (rule.endsWith('F') ? '＋地合い(TOPIX>75日線)' : '');
    const t = all.filter(r => r.rule === rule && !isNaN(r.g)).sort((a, c) => a.d < c.d ? -1 : 1);
    if (!t.length) return [name, 0, '', '', '', '', '', '', '', '', '', '', 'シグナルなし'];
    const net = t.map(r => r.g - (rule === 'B20' ? 0 : SW_COST));
    let st = 0, mxs = 0; net.forEach(v => { st = v <= 0 ? st + 1 : 0; mxs = Math.max(mxs, st); });
    const years = {}; t.forEach((r, i) => (years[r.d.slice(0, 4)] = years[r.d.slice(0, 4)] || []).push(net[i]));
    const avg = mean(net), days = mean(t.map(r => r.days));
    return [name, t.length, Math.round(net.filter(v => v > 0).length / t.length * 100), r2(avg), Math.round(days * 10) / 10,
      rule === 'B20' ? '' : r2(avg - base * days / 20),
      r2(mean(net.filter((v, i) => t[i].d < '20240101'))), r2(mean(net.filter((v, i) => t[i].d >= '20240101'))),
      r2(net.reduce((m, v) => Math.min(m, v), Infinity)), mxs, Math.round(t.length / months * 10) / 10,
      rule === 'B20' ? '' : Math.round(t.filter(r => r.hit).length / t.length * 100),
      Object.keys(years).sort().map(y => `${y}:${mean(years[y]).toFixed(1)}%`).join(' ')];
  });
  // ふだん触る4銘柄の銘柄別（本の「銘柄ごとの反発ライン」）
  Object.keys(RV_FOCUS).forEach(code => Object.keys(RV_NAMES).filter(k => k !== 'B20').forEach(rule => {
    const t = all.filter(r => r.code === code && r.rule === rule && !isNaN(r.g));
    if (!t.length) return;
    const net = t.map(r => r.g - SW_COST), avg = mean(net), days = mean(t.map(r => r.days));
    const bs = mean(all.filter(r => r.code === code && r.rule === 'B20' && !isNaN(r.g)).map(r => r.g));
    rows.push([`【${RV_FOCUS[code]}】${RV_NAMES[rule]}`, t.length, Math.round(net.filter(v => v > 0).length / t.length * 100), r2(avg),
      Math.round(days * 10) / 10, r2(avg - bs * days / 20), r2(mean(net.filter((v, i) => t[i].d < '20240101'))),
      r2(mean(net.filter((v, i) => t[i].d >= '20240101'))), r2(net.reduce((m, v) => Math.min(m, v), Infinity)), '', '',
      Math.round(t.filter(r => r.hit).length / t.length * 100), '']);
  }));
  const sh = sheet_('rev_bt', RV_HEADER);
  sh.clearContents();
  sh.getRange(1, 1, 1, RV_HEADER.length).setValues([RV_HEADER]);
  sh.getRange(2, 1, rows.length, RV_HEADER.length).setValues(rows);
  rows.forEach(r => Logger.log(`${r[0]}: ${r[1]}件 勝率${r[2]}% 平均${r[3]}% ${r[4]}日 超過${r[5]}%`));
  Logger.log(`完了: ${firstD}〜${lastD} → シート rev_bt`);
}

/**
 * 銘柄ごとの型の選び直し（前の期間で一番良かった型を選び、次の期間でも通用したかを見る）
 * このファイルを開いて reversalWalkForward を1回実行（3〜5分）。結果はシート rev_wf。
 *  A: 2020〜2023年で選ぶ → 2024年〜で確かめる
 *  B: 2023〜2024年で選ぶ → 2025年〜で確かめる（株主が入れ替わる前提で、直近に寄せた版）
 * 選ぶ条件: その期間に8回以上、平均がプラス、同じ銘柄の「毎日買って20日」を按分で上回る型のうち、超過が一番大きいもの
 */
function reversalWalkForward() {
  const mb = swDaily_('1306.T') || [], mx = swIndicators_(mb), mkt = {};
  mb.forEach((q, i) => { if (mx.ma75[i] != null) mkt[q.d] = q.c > mx.ma75[i]; });
  const all = [];
  for (let s = 0; s < SW_CODES.length; s += 20) {
    const chunk = SW_CODES.slice(s, s + 20);
    const resps = UrlFetchApp.fetchAll(chunk.map(c => ({
      url: `https://query1.finance.yahoo.com/v8/finance/chart/${c}.T?range=6y&interval=1d`, headers: UA, muteHttpExceptions: true })));
    resps.forEach((r, j) => {
      const b = swParse_(r.getContentText());
      if (!b || b.length < 300) return;
      rvRun_(b, swIndicators_(b), mkt).forEach(t => { if (!/F$/.test(t.rule) && !isNaN(t.g)) { t.code = chunk[j]; all.push(t); } });
    });
    Utilities.sleep(500);
  }
  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0, r2 = v => Math.round(v * 100) / 100;
  const rules = Object.keys(RV_NAMES).filter(k => k !== 'B20');
  const by = {}; all.forEach(t => ((by[t.code] = by[t.code] || {})[t.rule] = by[t.code][t.rule] || []).push(t));
  const exc = (ts, base) => {
    if (!ts.length) return null;
    const net = ts.map(t => t.g - (t.rule === 'B20' ? 0 : SW_COST)), days = mean(ts.map(t => t.days));
    return { n: ts.length, avg: mean(net), exc: mean(net) - base * days / 20, win: net.filter(v => v > 0).length / ts.length };
  };
  const splits = [['A', '20200101', '20240101', '20240101', '99999999'], ['B', '20230101', '20250101', '20250101', '99999999']];
  const rows = [], summary = [];
  splits.forEach(([tag, s1, e1, s2, e2]) => {
    const pickT = [], commonT = [], baseT = [];
    Object.keys(by).forEach(code => {
      const inP = (t, a, z) => t.d >= a && t.d < z;
      const b1 = mean((by[code].B20 || []).filter(t => inP(t, s1, e1)).map(t => t.g));
      const b2 = mean((by[code].B20 || []).filter(t => inP(t, s2, e2)).map(t => t.g));
      let best = null;
      rules.forEach(rule => {
        const st = exc((by[code][rule] || []).filter(t => inP(t, s1, e1)), b1);
        if (st && st.n >= 8 && st.avg > 0 && st.exc > 0 && (!best || st.exc > best.st.exc)) best = { rule, st };
      });
      const cm = (by[code].R2b || []).filter(t => inP(t, s2, e2)); commonT.push(...cm.map(t => ({ t, b2 })));
      if (!best) return;
      const later = (by[code][best.rule] || []).filter(t => inP(t, s2, e2));
      const st2 = exc(later, b2);
      pickT.push(...later.map(t => ({ t, b2 })));
      rows.push([tag, code, RV_NAMES[best.rule], best.st.n, r2(best.st.avg), r2(best.st.exc),
        st2 ? st2.n : 0, st2 ? r2(st2.avg) : '', st2 ? r2(st2.exc) : '', st2 ? Math.round(st2.win * 100) : '',
        st2 ? (st2.exc > 0 ? '通用' : '外れ') : '後半シグナルなし']);
    });
    const pool = arr => { const net = arr.map(x => x.t.g - SW_COST); return [arr.length, r2(mean(net)), r2(mean(arr.map(x => x.t.g - SW_COST - x.b2 * x.t.days / 20)))]; };
    const okN = rows.filter(r => r[0] === tag && r[10] === '通用').length, ngN = rows.filter(r => r[0] === tag && r[10] === '外れ').length;
    summary.push([`${tag} 銘柄ごとに選んだ型（確かめる期間の合計）`, ...pool(pickT), `通用${okN}銘柄・外れ${ngN}銘柄`]);
    summary.push([`${tag} 比較: 全銘柄共通のR2b（25日線-5%割れ＋100日線の上）`, ...pool(commonT), '']);
  });
  const sh = sheet_('rev_wf', ['split', 'code', 'picked_rule', 'n_pick', 'avg_pick', 'excess_pick', 'n_test', 'avg_test', 'excess_test', 'win_test', 'judge']);
  sh.clearContents();
  const H = ['split', 'code', 'picked_rule', 'n_pick', 'avg_pick', 'excess_pick', 'n_test', 'avg_test', 'excess_test', 'win_test', 'judge'];
  sh.getRange(1, 1, 1, 5).setValues([['まとめ', 'trades', 'avg_net_pct', 'excess_pct', 'note']]);
  sh.getRange(2, 1, summary.length, 5).setValues(summary);
  const r0 = summary.length + 3;
  sh.getRange(r0, 1, 1, H.length).setValues([H]);
  if (rows.length) sh.getRange(r0 + 1, 1, rows.length, H.length).setValues(rows);
  summary.forEach(s => Logger.log(s.join(' | ')));
  Logger.log('完了 → シート rev_wf');
}
