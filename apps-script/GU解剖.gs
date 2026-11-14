/**
 * GU解剖: 「+8%以上で寄った銘柄（ギャップアップ）のどれが寄り天し、どれが伸びるか」を全市場6年で調べる。
 * 使い方: Ir-rador プロジェクトに追加 → guStart を1回だけ実行。あとは10分おきに自動で続きを回し（1回約4.5分）、
 *   全部終わったら集計してシート gu_bt に書き、Discord に「🔬 GU解剖」を送る。自動の続きもそこで自分で止まる。
 *   全部で40分〜1時間ほど。途中経過はシート gu_ev（GU1件＝1行）に増えていく。
 *   集計だけやり直したいときは guSummary。最初からやり直すときは guStart。
 * 使うもの: swParse_ / swIndicators_ / SW_CODES / SW_COST（スイング検証.gs）、sheet_ / UA / P / postDiscord_（IR通知.gs）
 *
 * 交絡（地合いのせいか、銘柄のせいか）の消し方:
 *   市場比 = 寄り→引け − TOPIX(1306)の寄り→引け
 *   同日比 = 寄り→引け − 同じ日に+8%以上で寄った全銘柄の平均（その日に3件以上あるときだけ）＝同じ日の中で比べる
 *   半導体の向かい風 = 前の60日で東エレク(8035)と値動きが似ている銘柄（相関0.5以上）× その日の東エレクの寄り→引け
 *     ※その日の結果を使うので「説明用」。売買の条件には使えない。
 * 結果の G7R = 寄りで売り・損切り+2%・利確-4%・残りは引けで買い戻し（両方に触れたら損切りが先＝厳しめ）、コスト込み、1R=2%。
 * S高の判定は東証の制限値幅の表（前日終値から計算）。古い日の分割補正で少しずれることがある。
 * 注意: 上場廃止になった銘柄はYahooに残らないので少し良く出る（生き残りの偏り）。気配（8:59の値）は無料データに無いので「寄りの窓」で代わりにする。
 */
const GU_FROM = 1301, GU_TO = 9999, GU_MIN_GAP = 8;
const GU_EV_HEADER = ['code', 'date', 'prev_c', 'open', 'gap_pct', 'limup_open', 'limup_close', 'value20_oku', 'big', 'ret1', 'pre5', 'pre20',
  'volx_prev', 'up200', 'season', 'corr_semi', 'corr_mkt', 'semi_oc', 'mkt_oc', 'mkt75', 'oc', 'hi', 'lo', 'close_pos', 'next', 'next_gap', 'g7_ret'];
const GU_BT_HEADER = ['区分', '件数', '寄り天率%(引け<寄り)', '平均 寄り→引け%', '市場比%', '同日比%', '平均G7R', '前半G7R(〜2023)', '後半G7R(2024〜)',
  't値(G7R・日ごと)', '寄り後の高値 平均%', '寄り後の安値 平均%', '翌日%', '月あたり件数'];

function guStart() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'guRun').forEach(t => ScriptApp.deleteTrigger(t));
  const sh = sheet_('gu_ev', GU_EV_HEADER);
  sh.clearContents(); sh.getRange(1, 1, 1, GU_EV_HEADER.length).setValues([GU_EV_HEADER]);
  P.setProperty('GU_NEXT', String(GU_FROM));
  P.setProperty('GU_STOCKS', '0');
  ScriptApp.newTrigger('guRun').timeBased().everyMinutes(10).create();
  Logger.log('GU解剖を始めます。10分おきに自動で続きを回します');
  guRun();
}

/** 1306（TOPIX）と8035（東エレク）の日足 → 日付ごとの値 */
function guRefs_() {
  const get = s => swParse_(UrlFetchApp.fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${s}?range=6y&interval=1d`, { headers: UA, muteHttpExceptions: true }).getContentText()) || [];
  const tp = get('1306.T'), sm = get('8035.T'), R = { tRet: {}, sRet: {}, tOC: {}, sOC: {}, m75: {} };
  tp.forEach((y, i) => {
    if (i) R.tRet[y.d] = y.c / tp[i - 1].c - 1;
    R.tOC[y.d] = (y.c / y.o - 1) * 100;
    if (i >= 76) { let s = 0; for (let j = i - 76; j < i - 1; j++) s += tp[j].c; R.m75[y.d] = tp[i - 1].c > s / 75 ? 1 : 0; }
  });
  sm.forEach((y, i) => { if (i) R.sRet[y.d] = y.c / sm[i - 1].c - 1; R.sOC[y.d] = (y.c / y.o - 1) * 100; });
  return R;
}

function guRun() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const t0 = Date.now();
    let next = Number(P.getProperty('GU_NEXT') || GU_FROM), stocks = Number(P.getProperty('GU_STOCKS') || 0);
    const sh = sheet_('gu_ev', GU_EV_HEADER), refs = guRefs_();
    while (next <= GU_TO && Date.now() - t0 < 270000) {
      const codes = []; for (let c = next; c < next + 20 && c <= GU_TO; c++) codes.push(String(c));
      const rs = UrlFetchApp.fetchAll(codes.map(c => ({ url: `https://query1.finance.yahoo.com/v8/finance/chart/${c}.T?range=6y&interval=1d`, headers: UA, muteHttpExceptions: true })));
      const busy = rs.filter(r => r.getResponseCode() === 429 || r.getResponseCode() >= 500).length;
      if (busy >= 3) { Logger.log(`Yahooが混んでいる（${busy}件）→ ${next}から次の回でやり直し`); break; }
      const out = [];
      rs.forEach((r, j) => {
        if (r.getResponseCode() !== 200) return;
        const txt = r.getContentText();
        if (txt.indexOf('"instrumentType":"EQUITY"') < 0) return;
        const b = swParse_(txt);
        if (!b || b.length < 80) return;
        stocks++;
        out.push(...guEvents_(codes[j], b, refs));
      });
      if (out.length) {
        const need = sh.getLastRow() + out.length - sh.getMaxRows();
        if (need > 0) sh.insertRowsAfter(sh.getMaxRows(), need + 2000);
        sh.getRange(sh.getLastRow() + 1, 1, out.length, GU_EV_HEADER.length).setValues(out);
      }
      next += 20;
      P.setProperty('GU_NEXT', String(next)); P.setProperty('GU_STOCKS', String(stocks));
      Utilities.sleep(300);
    }
    Logger.log(`ここまで: コード${next - 1}まで・データのある銘柄${stocks}・GU${sh.getLastRow() - 1}件`);
    if (next > GU_TO) {
      ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'guRun').forEach(t => ScriptApp.deleteTrigger(t));
      guSummary();
    }
  } finally { lock.releaseLock(); }
}

/** 東証の制限値幅（前日終値 → 値幅） */
function guLimit_(p) {
  const T = [[100, 30], [200, 50], [500, 80], [700, 100], [1000, 150], [1500, 300], [2000, 400], [3000, 500], [5000, 700], [7000, 1000],
    [10000, 1500], [15000, 3000], [20000, 4000], [30000, 5000], [50000, 7000], [70000, 10000], [100000, 15000], [150000, 30000], [200000, 40000]];
  for (const [lim, w] of T) if (p < lim) return w;
  return 50000;
}

function guSeason_(d) {
  const md = d.slice(4, 8);
  return (md >= '0125' && md <= '0215') || (md >= '0425' && md <= '0520') || (md >= '0725' && md <= '0815') || (md >= '1025' && md <= '1115');
}

/** 前の60日の日次リターンの相関（i-1まで） */
function guCorr_(b, i, ref) {
  const a = [], c = [];
  for (let k = Math.max(1, i - 60); k < i; k++) { const r = ref[b[k].d]; if (r == null) continue; a.push(b[k].c / b[k - 1].c - 1); c.push(r); }
  if (a.length < 30) return null;
  const ma = a.reduce((s, v) => s + v, 0) / a.length, mc = c.reduce((s, v) => s + v, 0) / c.length;
  let sab = 0, saa = 0, scc = 0;
  for (let k = 0; k < a.length; k++) { sab += (a[k] - ma) * (c[k] - mc); saa += (a[k] - ma) ** 2; scc += (c[k] - mc) ** 2; }
  return saa > 0 && scc > 0 ? sab / Math.sqrt(saa * scc) : null;
}

/** 1銘柄の中の+8%以上の寄りを全部拾う */
function guEvents_(code, b, refs) {
  const x = swIndicators_(b), n = b.length, out = [], big = SW_CODES.indexOf(code) >= 0, r2 = v => v == null || isNaN(v) ? '' : Math.round(v * 100) / 100;
  for (let i = 61; i + 1 < n; i++) {
    const p = b[i - 1], t = b[i], gap = (t.o / p.c - 1) * 100;
    if (!(gap >= GU_MIN_GAP) || !(t.o > 0)) continue;
    const lim = p.c + guLimit_(p.c);
    const oc = (t.c / t.o - 1) * 100, hi = (t.h / t.o - 1) * 100, lo = (t.l / t.o - 1) * 100;
    const g7 = hi >= 2 ? -2 : lo <= -4 ? 4 : -oc; // 寄りで売り: 損切り+2%が先、次に利確-4%、残りは引け
    out.push([code, t.d, r2(p.c), r2(t.o), r2(gap), t.o >= lim * 0.999 ? 1 : 0, t.c >= lim * 0.999 ? 1 : 0,
      r2(x.vol20[i] * p.c / 1e8), big ? 1 : 0, r2((p.c / b[i - 2].c - 1) * 100), r2((p.c / b[i - 6].c - 1) * 100), r2((p.c / b[i - 21].c - 1) * 100),
      x.vol20[i - 1] > 0 ? r2(p.v / x.vol20[i - 1]) : '', x.ma200[i - 1] != null ? (p.c > x.ma200[i - 1] ? 1 : 0) : '', guSeason_(t.d) ? 1 : 0,
      r2(guCorr_(b, i, refs.sRet)), r2(guCorr_(b, i, refs.tRet)), r2(refs.sOC[t.d]), r2(refs.tOC[t.d]), refs.m75[t.d] == null ? '' : refs.m75[t.d],
      r2(oc), r2(hi), r2(lo), t.h > t.l ? r2((t.c - t.l) / (t.h - t.l)) : 1, r2((b[i + 1].c / t.c - 1) * 100), r2((b[i + 1].o / t.c - 1) * 100), r2(g7 - SW_COST)]);
  }
  return out;
}

function guSummary() {
  const sh = sheet_('gu_ev', GU_EV_HEADER), last = sh.getLastRow();
  if (last < 2) { Logger.log('gu_ev が空です。先に guStart'); return; }
  const H = GU_EV_HEADER, ix = {}; H.forEach((h, i) => ix[h] = i);
  const num = v => v === '' || v == null ? null : +v;
  const ev = sh.getRange(2, 1, last - 1, H.length).getValues().map(r => {
    const e = {}; H.forEach((h, i) => e[h] = h === 'code' || h === 'date' ? String(r[i]) : num(r[i])); return e;
  }).filter(e => e.oc != null && e.gap_pct <= 60);
  // 同じ日の平均（3件以上の日だけ）
  const byD = {}; ev.forEach(e => (byD[e.date] = byD[e.date] || []).push(e.oc));
  const dMean = {}; Object.keys(byD).forEach(d => { if (byD[d].length >= 3) dMean[d] = byD[d].reduce((s, v) => s + v, 0) / byD[d].length; });
  ev.forEach(e => { e.same = dMean[e.date] != null ? e.oc - dMean[e.date] : null; e.mkt = e.mkt_oc != null ? e.oc - e.mkt_oc : null; e.R = e.g7_ret / 2; });
  const ds = ev.map(e => e.date).sort(), months = Math.max(1, (+ds[ds.length - 1].slice(0, 4) - +ds[0].slice(0, 4)) * 12 + (+ds[ds.length - 1].slice(4, 6)) - (+ds[0].slice(4, 6)) + 1);
  const mean = a => { const b = a.filter(v => v != null && !isNaN(v)); return b.length ? b.reduce((s, v) => s + v, 0) / b.length : null; };
  const r2 = v => v == null || isNaN(v) ? '' : Math.round(v * 100) / 100;
  const row = (name, f) => {
    const t = ev.filter(f);
    if (!t.length) return [name, 0, '', '', '', '', '', '', '', '', '', '', '', ''];
    const bd = {}; t.forEach(e => (bd[e.date] = bd[e.date] || []).push(e.R));
    const dm = Object.keys(bd).map(k => mean(bd[k])), m = mean(dm);
    const sd = Math.sqrt(dm.reduce((s, v) => s + (v - m) * (v - m), 0) / Math.max(1, dm.length - 1));
    return [name, t.length, Math.round(t.filter(e => e.oc < 0).length / t.length * 100), r2(mean(t.map(e => e.oc))), r2(mean(t.map(e => e.mkt))),
      r2(mean(t.map(e => e.same))), r2(mean(t.map(e => e.R))), r2(mean(t.filter(e => e.date < '20240101').map(e => e.R))),
      r2(mean(t.filter(e => e.date >= '20240101').map(e => e.R))), r2(sd > 0 && dm.length > 1 ? m / sd * Math.sqrt(dm.length) : null),
      r2(mean(t.map(e => e.hi))), r2(mean(t.map(e => e.lo))), r2(mean(t.map(e => e.next))), Math.round(t.length / months * 10) / 10];
  };
  const L = (lo, hi) => v => v != null && v >= lo && v < hi;
  const liq = e => e.value20_oku != null && e.value20_oku >= 1; // 売買代金1億未満は実戦で売れないので、分け方の多くはこの中で見る
  const semiHead = e => e.corr_semi != null && e.corr_semi >= 0.5 && e.semi_oc != null && e.semi_oc <= -1;
  const semiTail = e => e.corr_semi != null && e.corr_semi >= 0.5 && e.semi_oc != null && e.semi_oc >= 1;
  const rows = [
    row('全部（+8%以上の寄り）', e => true),
    row('売買代金20日平均 1億以上（以下この中）', liq),
    ['── 窓の大きさ'],
    row('窓 8〜12%', e => liq(e) && L(8, 12)(e.gap_pct)), row('窓 12〜15%', e => liq(e) && L(12, 15)(e.gap_pct)),
    row('窓 15〜20%', e => liq(e) && L(15, 20)(e.gap_pct)), row('窓 20%以上', e => liq(e) && e.gap_pct >= 20),
    row('S高で寄った', e => liq(e) && e.limup_open === 1), row('S高未満で寄った', e => liq(e) && e.limup_open === 0),
    ['── 規模（売買代金20日平均）'],
    row('1〜5億', e => L(1, 5)(e.value20_oku)), row('5〜20億', e => L(5, 20)(e.value20_oku)), row('20〜100億', e => L(20, 100)(e.value20_oku)),
    row('100億以上', e => e.value20_oku >= 100), row('大型108銘柄', e => e.big === 1),
    ['── 寄る前の値動き'],
    row('前日 マイナス', e => liq(e) && e.ret1 < 0), row('前日 0〜5%', e => liq(e) && L(0, 5)(e.ret1)), row('前日 +5%以上（連騰）', e => liq(e) && e.ret1 >= 5),
    row('前20日 マイナス', e => liq(e) && e.pre20 < 0), row('前20日 0〜20%', e => liq(e) && L(0, 20)(e.pre20)),
    row('前20日 20〜50%', e => liq(e) && L(20, 50)(e.pre20)), row('前20日 50%以上', e => liq(e) && e.pre20 >= 50),
    row('前日の出来高 1倍未満（静か→いきなり）', e => liq(e) && e.volx_prev != null && e.volx_prev < 1), row('前日の出来高 2倍以上（前から動意）', e => liq(e) && e.volx_prev >= 2),
    row('200日線の上', e => liq(e) && e.up200 === 1), row('200日線の下', e => liq(e) && e.up200 === 0),
    row('決算の時期', e => liq(e) && e.season === 1), row('決算の時期以外', e => liq(e) && e.season === 0),
    ['── 株価'],
    row('300円未満', e => liq(e) && e.open < 300), row('300〜1000円', e => liq(e) && L(300, 1000)(e.open)),
    row('1000〜3000円', e => liq(e) && L(1000, 3000)(e.open)), row('3000円以上', e => liq(e) && e.open >= 3000),
    ['── 地合い・業種（交絡のチェック）'],
    row('TOPIXが75日線の下（G7の地合い）', e => liq(e) && e.mkt75 === 0), row('TOPIXが75日線の上', e => liq(e) && e.mkt75 === 1),
    row('半導体連動(相関0.5以上)', e => liq(e) && e.corr_semi >= 0.5), row('半導体と無関係(相関0.2未満)', e => liq(e) && e.corr_semi != null && e.corr_semi < 0.2),
    row('半導体連動 × その日の東エレク-1%以下（向かい風）※説明用', e => liq(e) && semiHead(e)),
    row('半導体連動 × その日の東エレク+1%以上（追い風）※説明用', e => liq(e) && semiTail(e)),
    row('半導体と無関係 × その日の東エレク-1%以下 ※説明用', e => liq(e) && e.corr_semi != null && e.corr_semi < 0.2 && e.semi_oc != null && e.semi_oc <= -1),
    ['── 11/12の形'],
    row('SUMCO型: 20億以上 × 半導体連動 × 向かい風 ※説明用', e => e.value20_oku >= 20 && semiHead(e)),
    row('テイカ型: 1〜20億 × 半導体と無関係 × 東エレク-1%以下 ※説明用', e => L(1, 20)(e.value20_oku) && e.corr_semi != null && e.corr_semi < 0.2 && e.semi_oc != null && e.semi_oc <= -1),
    row('大型(20億以上) × 窓15%以上', e => e.value20_oku >= 20 && e.gap_pct >= 15),
    row('中小型(1〜20億) × 窓15%以上', e => L(1, 20)(e.value20_oku) && e.gap_pct >= 15),
  ];
  const ys = Array.from(new Set(ev.map(e => e.date.slice(0, 4)))).sort();
  rows.push(['── 年別（1億以上）']);
  ys.forEach(y => rows.push(row(`${y}年`, e => liq(e) && e.date.slice(0, 4) === y)));
  const W = GU_BT_HEADER.length, out = sheet_('gu_bt', GU_BT_HEADER);
  out.clearContents();
  out.getRange(1, 1, 1, W).setValues([GU_BT_HEADER]);
  out.getRange(2, 1, rows.length, W).setValues(rows.map(r => r.concat(Array(W).fill('')).slice(0, W)));
  const pick = rows.filter(r => r.length > 1 && /窓 |S高|規模|億|SUMCO|テイカ|半導体連動 ×/.test(r[0])).slice(0, 18);
  const msg = pick.map(r => `${r[0]}: ${r[1]}件 寄り天${r[2]}% 同日比${r[5]}% G7R${r[6]}（前${r[7]}/後${r[8]}）`);
  msg.forEach(s => Logger.log(s));
  Logger.log(`集計: ${ds[0]}〜${ds[ds.length - 1]}（${months}か月）、GU ${ev.length}件、銘柄 ${P.getProperty('GU_STOCKS')} → シート gu_bt`);
  try { postDiscord_({ embeds: [{ title: '🔬 GU解剖', description: msg.join('\n').slice(0, 4000), color: 0x8B5CF6 }] }); } catch (e) { Logger.log('Discord送信に失敗: ' + e); }
}
