/**
 * H2（決算の窓スイング）を全市場（コード1301〜9999の全部）で過去6年検証する。
 * 使い方: Ir-rador プロジェクトに追加 → h2AllStart を1回だけ実行。あとは10分おきに自動で続きを回し（1回約4.5分）、
 *   全部終わったら集計してシート h2all_bt に書き、Discord に「📊 H2全銘柄検証」を送る。自動の続きもそこで自分で止まる。
 *   全部で40分〜1時間ほど。途中経過はシート h2all_ev（見つかった窓1件＝1行）に増えていく。
 *   集計だけやり直したいときは h2AllSummary。最初からやり直すときは h2AllStart。
 * 使うもの: swParse_ / swIndicators_ / SW_CODES / SW_COST（スイング検証.gs）、sheet_ / UA / P / postDiscord_（IR通知.gs）
 *
 * H2の条件（今の運用と同じ）: 前日比+5%以上の窓で寄る・出来高が20日平均の2倍以上・上半分で引け・前日比+3%以上
 *   → 翌朝の寄りで買い、20営業日後の引けで売り。損切りは2通り:
 *   L3（今の運用）= 終値で「窓の日の安値×0.998」を割ったら翌朝の寄りで売り / 日中 = その値段に逆指値
 * 決算かどうか: 過去の開示日が無料では取れないので「決算の時期」で代わりにする
 *   （1/25〜2/15・4/25〜5/20・7/25〜8/15・10/25〜11/15。大型株の検証で勝っていたのはこの時期の窓だけ）
 * ETF・投信は除く（Yahooの種類がEQUITYのものだけ）。REITは含む。
 * 注意: 上場廃止になった銘柄はYahooに残らないので、成績は少し良く出る（生き残りの偏り）。
 */
const H2A_FROM = 1301, H2A_TO = 9999, H2A_HOLD = 20;
const H2A_EV_HEADER = ['code', 'signal', 'entry', 'exit', 'entry_px', 'risk_pct', 'ret_L3', 'ret_stop', 'days_L3', 'up200', 'value_oku', 'value20_oku', 'gap_pct', 'vol_x', 'big', 'price', 'mfe20', 'mae20', 'ret5', 'ret10', 'close_pos', 'pre20'];
const H2A_BT_HEADER = ['区分', '件数', '月あたり', '勝率%', '平均%', '平均R(L3)', '平均R(日中損切り)', 'TOPIX比%', '前半R(〜2023)', '後半R(2024〜)', 't値(日ごと)', '最悪%', '1R=5万の月額(円)'];

function h2AllStart() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'h2AllRun').forEach(t => ScriptApp.deleteTrigger(t));
  const sh = sheet_('h2all_ev', H2A_EV_HEADER);
  sh.clearContents(); sh.getRange(1, 1, 1, H2A_EV_HEADER.length).setValues([H2A_EV_HEADER]);
  P.setProperty('H2A_NEXT', String(H2A_FROM));
  P.setProperty('H2A_STOCKS', '0');
  ScriptApp.newTrigger('h2AllRun').timeBased().everyMinutes(10).create();
  Logger.log('全銘柄のH2検証を始めます。10分おきに自動で続きを回します');
  h2AllRun();
}

function h2AllRun() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // 前の回がまだ動いている
  try {
    const t0 = Date.now();
    let next = Number(P.getProperty('H2A_NEXT') || H2A_FROM), stocks = Number(P.getProperty('H2A_STOCKS') || 0);
    const sh = sheet_('h2all_ev', H2A_EV_HEADER);
    while (next <= H2A_TO && Date.now() - t0 < 270000) {
      const codes = []; for (let c = next; c < next + 20 && c <= H2A_TO; c++) codes.push(String(c));
      const rs = UrlFetchApp.fetchAll(codes.map(c => ({ url: `https://query1.finance.yahoo.com/v8/finance/chart/${c}.T?range=6y&interval=1d`, headers: UA, muteHttpExceptions: true })));
      const busy = rs.filter(r => r.getResponseCode() === 429 || r.getResponseCode() >= 500).length;
      if (busy >= 3) { Logger.log(`Yahooが混んでいる（${busy}件）→ ${next}から次の回でやり直し`); break; }
      const out = [];
      rs.forEach((r, j) => {
        if (r.getResponseCode() !== 200) return;
        const txt = r.getContentText();
        if (txt.indexOf('"instrumentType":"EQUITY"') < 0) return; // ETF・投信などは除く（レバETFの窓が混ざるため）
        const b = swParse_(txt);
        if (!b || b.length < 230) return;
        stocks++;
        out.push(...h2aEvents_(codes[j], b));
      });
      if (out.length) {
        const need = sh.getLastRow() + out.length - sh.getMaxRows();
        if (need > 0) sh.insertRowsAfter(sh.getMaxRows(), need + 2000); // シートの行が足りないと書き込めずに止まるため
        sh.getRange(sh.getLastRow() + 1, 1, out.length, H2A_EV_HEADER.length).setValues(out);
      }
      next += 20;
      P.setProperty('H2A_NEXT', String(next)); P.setProperty('H2A_STOCKS', String(stocks));
      Utilities.sleep(300);
    }
    Logger.log(`ここまで: コード${next - 1}まで・データのある銘柄${stocks}・窓${sh.getLastRow() - 1}件`);
    if (next > H2A_TO) {
      ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'h2AllRun').forEach(t => ScriptApp.deleteTrigger(t));
      h2AllSummary();
    }
  } finally { lock.releaseLock(); }
}

/** 1銘柄の中のH2の窓を全部拾い、L3と日中損切りの両方で20日の成績を出す */
function h2aEvents_(code, b) {
  const x = swIndicators_(b), n = b.length, out = [], big = SW_CODES.indexOf(code) >= 0;
  for (let i = 211; i + H2A_HOLD < n; i++) {
    const p = b[i - 1], t = b[i];
    if (!(t.o >= p.c * 1.05 && x.vol20[i] > 0 && t.v >= 2 * x.vol20[i] && t.c >= (t.h + t.l) / 2 && t.c > p.c * 1.03)) continue;
    const e = b[i + 1].o, stop = t.l * 0.998;
    if (!(stop < e) || !(e > 0)) continue;
    // L3: 終値で割ったら翌朝の寄り
    let exL3 = b[i + H2A_HOLD].c, kL3 = i + H2A_HOLD;
    for (let k = i + 1; k < i + H2A_HOLD; k++) if (b[k].c < stop) { exL3 = b[k + 1].o; kL3 = k + 1; break; }
    // 日中の逆指値（窓で下に開けたら寄り値）
    let exS = b[i + H2A_HOLD].c;
    for (let k = i + 1; k <= i + H2A_HOLD; k++) {
      if (b[k].o <= stop && k > i + 1) { exS = b[k].o; break; }
      if (b[k].l <= stop) { exS = stop; break; }
    }
    // 探索用: 20日の間の最大の上げ・下げ（どこまで伸びたか／どこまで掘ったか）、5日・10日後、窓の日の引けの位置、窓の前20日の上げ
    let hi = -Infinity, lo = Infinity;
    for (let k = i + 1; k <= i + H2A_HOLD; k++) { hi = Math.max(hi, b[k].h); lo = Math.min(lo, b[k].l); }
    const up200 = x.ma200[i] != null && t.c > x.ma200[i] && x.ma200[i] >= x.ma200[i - 10];
    const r1 = v => Math.round(v * 100) / 100;
    out.push([code, t.d, b[i + 1].d, b[kL3].d, e, r1((e - stop) / e * 100), r1((exL3 / e - 1) * 100), r1((exS / e - 1) * 100), kL3 - i,
      up200 ? 1 : 0, r1(t.c * t.v / 1e8), r1(x.vol20[i] * t.c / 1e8), r1((t.o / p.c - 1) * 100), r1(t.v / x.vol20[i]), big ? 1 : 0, t.c,
      r1((hi / e - 1) * 100), r1((lo / e - 1) * 100), r1((b[i + 5].c / e - 1) * 100), r1((b[i + 10].c / e - 1) * 100),
      t.h > t.l ? r1((t.c - t.l) / (t.h - t.l)) : 1, r1((p.c / b[i - 21].c - 1) * 100)]);
  }
  return out;
}

/** 決算の時期（1/25〜2/15・4/25〜5/20・7/25〜8/15・10/25〜11/15）か */
function h2aSeason_(d) {
  const md = d.slice(4, 8);
  return (md >= '0125' && md <= '0215') || (md >= '0425' && md <= '0520') || (md >= '0725' && md <= '0815') || (md >= '1025' && md <= '1115');
}

function h2AllSummary() {
  const sh = sheet_('h2all_ev', H2A_EV_HEADER), last = sh.getLastRow();
  if (last < 2) { Logger.log('h2all_ev が空です。先に h2AllStart'); return; }
  const ev = sh.getRange(2, 1, last - 1, H2A_EV_HEADER.length).getValues().map(r => ({
    code: String(r[0]), d: String(r[1]), entry: String(r[2]), exit: String(r[3]), risk: +r[5], L3: +r[6] - SW_COST, S: +r[7] - SW_COST,
    up200: +r[9] === 1, val20: +r[11], big: +r[14] === 1, season: h2aSeason_(String(r[1])) }))
    .filter(e => e.risk >= 1); // 損切り幅が1%未満（窓の安値≒寄り値）はRが極端になるので除く（実戦でも1%未満の損切りは置かない）
  // TOPIX(1306) で同じ期間の上げを差し引く
  const tp = swParse_(UrlFetchApp.fetch('https://query1.finance.yahoo.com/v8/finance/chart/1306.T?range=6y&interval=1d', { headers: UA, muteHttpExceptions: true }).getContentText()) || [];
  const tpO = {}, tpC = {}; tp.forEach(y => { tpO[y.d] = y.o; tpC[y.d] = y.c; });
  ev.forEach(e => { e.ex = tpO[e.entry] && tpC[e.exit] ? e.L3 - (tpC[e.exit] / tpO[e.entry] - 1) * 100 : null; });
  const ds = ev.map(e => e.d).sort(), months = Math.max(1, (+ds[ds.length - 1].slice(0, 4) - +ds[0].slice(0, 4)) * 12 + (+ds[ds.length - 1].slice(4, 6)) - (+ds[0].slice(4, 6)) + 1);
  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null, r2 = v => v == null || isNaN(v) ? '' : Math.round(v * 100) / 100;
  const row = (name, f) => {
    const t = ev.filter(f);
    if (!t.length) return [name, 0, '', '', '', '', '', '', '', '', '', '', ''];
    const R = t.map(e => e.L3 / e.risk), perM = t.length / months;
    const byDay = {}; t.forEach((e, i) => (byDay[e.d] = byDay[e.d] || []).push(R[i]));
    const dm = Object.keys(byDay).map(k => mean(byDay[k])), m = mean(dm);
    const sd = Math.sqrt(dm.reduce((s, v) => s + (v - m) * (v - m), 0) / Math.max(1, dm.length - 1));
    const ex = t.map(e => e.ex).filter(v => v != null);
    const early = t.filter(e => e.d < '20240101').map(e => e.L3 / e.risk), late = t.filter(e => e.d >= '20240101').map(e => e.L3 / e.risk);
    return [name, t.length, Math.round(perM * 10) / 10, Math.round(t.filter(e => e.L3 > 0).length / t.length * 100), r2(mean(t.map(e => e.L3))),
      r2(mean(R)), r2(mean(t.map(e => e.S / e.risk))), r2(mean(ex)), r2(mean(early)), r2(mean(late)),
      r2(sd > 0 ? m / sd * Math.sqrt(dm.length) : null), r2(Math.min(...t.map(e => e.L3))), Math.round(perM * mean(R) * 50000)];
  };
  const H = e => e.up200, HS = e => e.up200 && e.season;
  const rows = [
    row('全部の窓（200日線を問わない）', e => true),
    row('H2（200日線の上）', H),
    row('H2 × 決算の時期', HS),
    row('H2 × 決算の時期以外', e => e.up200 && !e.season),
    row('H2 × 決算の時期 × 大型108銘柄', e => HS(e) && e.big),
    row('H2 × 決算の時期 × 大型以外', e => HS(e) && !e.big),
    row('H2 × 決算の時期 × 売買代金20日平均 20億以上', e => HS(e) && e.val20 >= 20),
    row('H2 × 決算の時期 × 5〜20億', e => HS(e) && e.val20 >= 5 && e.val20 < 20),
    row('H2 × 決算の時期 × 1〜5億', e => HS(e) && e.val20 >= 1 && e.val20 < 5),
    row('H2 × 決算の時期 × 1億未満', e => HS(e) && e.val20 < 1),
    row('★実戦候補: H2 × 決算の時期 × 5億以上', e => HS(e) && e.val20 >= 5),
    row('★実戦候補 × 損切り幅8%以下', e => HS(e) && e.val20 >= 5 && e.risk <= 8),
  ];
  const ys = Array.from(new Set(ev.map(e => e.d.slice(0, 4)))).sort();
  ys.forEach(y => rows.push(row(`★実戦候補 ${y}年`, e => HS(e) && e.val20 >= 5 && e.d.slice(0, 4) === y)));
  const out = sheet_('h2all_bt', H2A_BT_HEADER);
  out.clearContents();
  out.getRange(1, 1, 1, H2A_BT_HEADER.length).setValues([H2A_BT_HEADER]);
  out.getRange(2, 1, rows.length, H2A_BT_HEADER.length).setValues(rows);
  const msg = rows.slice(1, 12).map(r => `${r[0]}: ${r[1]}件 月${r[2]}回 平均${r[5]}R TOPIX比${r[7]}% 前半${r[8]}/後半${r[9]} t=${r[10]} → 月${r[12]}円`);
  msg.forEach(s => Logger.log(s));
  Logger.log(`集計: ${ds[0]}〜${ds[ds.length - 1]}（${months}か月）、銘柄 ${P.getProperty('H2A_STOCKS')} → シート h2all_bt`);
  try { postDiscord_({ embeds: [{ title: '📊 H2全銘柄検証', description: msg.join('\n').slice(0, 4000), color: 0x10B981 }] }); } catch (e) { Logger.log('Discord送信に失敗: ' + e); }
}

/**
 * 探索: ★実戦候補（200日線の上・決算の時期・売買代金20日平均5億以上・損切り幅1%以上）を、窓の大きさ・出来高の倍率・引けの位置などで分けて、
 *   前半（〜2023）と後半（2024〜）の平均Rを並べる。前半で良く見えて後半でも同じ向きのものだけが「新しい仮説」の候補。
 *   保有日数（5日・10日・20日）と、20日の間の最大の上げ（mfe）・下げ（mae）の分布も出す。→ シート h2all_ex
 */
function h2AllExplore() {
  const sh = sheet_('h2all_ev', H2A_EV_HEADER), last = sh.getLastRow();
  const all = sh.getRange(2, 1, last - 1, H2A_EV_HEADER.length).getValues().map(r => ({
    d: String(r[1]), risk: +r[5], L3: +r[6] - SW_COST, up200: +r[9] === 1, val20: +r[11], gap: +r[12], volx: +r[13], price: +r[15],
    mfe: +r[16], mae: +r[17], r5: +r[18] - SW_COST, r10: +r[19] - SW_COST, cpos: +r[20], pre20: +r[21] }));
  const base = all.filter(e => e.up200 && h2aSeason_(e.d) && e.val20 >= 5 && e.risk >= 1);
  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null, r2 = v => v == null || isNaN(v) ? '' : Math.round(v * 100) / 100;
  const pct = (a, q) => { if (!a.length) return ''; const s = a.slice().sort((x, y) => x - y); return r2(s[Math.min(s.length - 1, Math.floor(q * s.length))]); };
  const H = ['区分', '件数', '平均R', '前半R(〜2023)', '後半R(2024〜)', '前半件数', '後半件数', '平均%', '勝率%', 'mfe中央値%', 'mae中央値%'];
  const row = (name, t) => {
    const R = e => e.L3 / e.risk, E = t.filter(e => e.d < '20240101'), L = t.filter(e => e.d >= '20240101');
    return [name, t.length, r2(mean(t.map(R))), r2(mean(E.map(R))), r2(mean(L.map(R))), E.length, L.length, r2(mean(t.map(e => e.L3))),
      t.length ? Math.round(t.filter(e => e.L3 > 0).length / t.length * 100) : '', pct(t.map(e => e.mfe), 0.5), pct(t.map(e => e.mae), 0.5)];
  };
  const cut = (name, key, edges) => edges.slice(0, -1).map((lo, i) => row(`${name} ${lo}〜${edges[i + 1] === Infinity ? '' : edges[i + 1]}`, base.filter(e => e[key] >= lo && e[key] < edges[i + 1])));
  const rows = [row('★実戦候補（全体）', base)]
    .concat(cut('窓%', 'gap', [5, 8, 12, 20, Infinity]))
    .concat(cut('出来高倍率', 'volx', [2, 3, 5, 10, Infinity]))
    .concat(cut('引けの位置(0=安値 1=高値)', 'cpos', [0.5, 0.7, 0.9, 1.01]))
    .concat(cut('窓の前20日%', 'pre20', [-Infinity, 0, 10, 30, Infinity]))
    .concat(cut('損切り幅%', 'risk', [1, 4, 8, 12, Infinity]))
    .concat(cut('株価', 'price', [0, 1000, 3000, 10000, Infinity]))
    .concat(cut('売買代金20日平均(億)', 'val20', [5, 10, 20, 50, Infinity]));
  // 組み合わせ（前半・後半とも良かった特徴を重ねる。11/12）
  rows.push(['── 組み合わせ（前半も後半も良かった特徴を重ねる）', '', '', '', '', '', '', '', '', '', '']);
  const cA = e => e.cpos >= 0.7 && e.risk <= 8 && e.volx < 10;
  rows.push(row('A: 引け位置0.7以上 × 損切り幅8%以下 × 出来高10倍未満', base.filter(cA)));
  rows.push(row('A × 窓5〜8%', base.filter(e => cA(e) && e.gap < 8)));
  rows.push(row('A × 出来高2〜5倍', base.filter(e => cA(e) && e.volx < 5)));
  rows.push(row('A × 売買代金50億以上', base.filter(e => cA(e) && e.val20 >= 50)));
  rows.push(row('Aの逆（どれか1つでも外れ）', base.filter(e => !cA(e))));
  Array.from(new Set(base.map(e => e.d.slice(0, 4)))).sort().forEach(y => rows.push(row(`A ${y}年`, base.filter(e => cA(e) && e.d.slice(0, 4) === y))));
  rows.push(['── 保有日数（損切りなし・寄りで買って何日後の引けか）', '', '', '', '', '', '', '', '', '', '']);
  [['5日', 'r5'], ['10日', 'r10']].forEach(([n, k]) => {
    const t = base, E = t.filter(e => e.d < '20240101'), L = t.filter(e => e.d >= '20240101');
    rows.push([`${n}後の引け`, t.length, '', '', '', E.length, L.length, r2(mean(t.map(e => e[k]))), Math.round(t.filter(e => e[k] > 0).length / t.length * 100),
      `前半${r2(mean(E.map(e => e[k])))}%`, `後半${r2(mean(L.map(e => e[k])))}%`]);
  });
  rows.push(['── 20日の間にどこまで伸びた/掘ったか（分布）', '', '', '', '', '', '', '', '', '', '']);
  [0.1, 0.25, 0.5, 0.75, 0.9].forEach(q => rows.push([`上位から${Math.round((1 - q) * 100)}%の位置`, base.length, '', '', '', '', '', '', '', pct(base.map(e => e.mfe), q), pct(base.map(e => e.mae), q)]));
  [5, 10, 15, 20, 30].forEach(x => rows.push([`20日のうちに+${x}%に届いた割合`, base.length, '', '', '', '', '', Math.round(base.filter(e => e.mfe >= x).length / base.length * 100) + '%', '', '', '']));
  const out = sheet_('h2all_ex', H);
  out.clearContents();
  out.getRange(1, 1, 1, H.length).setValues([H]);
  out.getRange(2, 1, rows.length, H.length).setValues(rows);
  Logger.log(`探索 ${base.length}件 → シート h2all_ex`);
}
