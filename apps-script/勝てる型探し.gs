/**
 * 勝てる型探し（Google Apps Script版・完全無料）
 * スイング検証.gs と同じプロジェクトに追加し、edgeBacktest を1回実行（3〜5分）。結果はシート edge_bt。
 * スイング検証.gs の swParse_ / swIndicators_ / SW_CODES / SW_COST と IR通知.gs の sheet_ / UA を使う。
 *
 * 「当てずっぽうに型を探すと、たまたま当たった型が見つかるだけ」なので、
 * 理屈（なぜ儲かるか）が説明できる、かつ朝に注文を置くだけ（寄り成・引け成・指値）で完結する型だけを試す。
 * 成績は1回あたりの損益%（コスト差引）と、1回400万円で回したときの月の損益。前半(〜2023)と後半(2024〜)を分ける。
 *
 * H1 夜間保有（引け成で買い→翌朝寄り成で売り）: 日本株は「夜に上がり、昼に下がる」傾向が知られている（海外勢の時間帯に上がる）
 *    a 全部 / b 25日線より上の銘柄だけ / c TOPIX ETF 1306 だけ
 * H2 決算サプライズ後のドリフト（D型の保有日数違い）: +5%窓・出来高2倍・上半分引けの翌朝寄り成で買い、N日後の引け成で売り（損切りなし）
 *    N=3/5/10/20、200日線フィルタあり/なし
 * H3 上昇トレンド中の短期の下げすぎ: 200日線の上・上向きで、5日で-8%以上下げた翌朝寄り成で買い、5日後の引け成で売り
 * H4 月末月初: 月の最終営業日の3日前の引け成で買い、翌月3営業日目の引け成で売り（年金・投信の資金流入）
 * H5 52週高値の更新: 終値が250日高値を更新（出来高1.5倍）した翌朝寄り成で買い、20日後の引け成で売り
 * 参考 B&H: 同じ期間ずっと持った場合の1日あたり（比べる基準）
 */

const EB_HEADER = ['rule', 'trades', 'win_pct', 'avg_net_pct', 'avg_gross_pct', 'per_month', 'avg_net_2020_23', 'avg_net_2024_',
  'worst_pct', 'max_losing_streak', 'yen_per_month_400man', 'note'];
const EB_NAMES = {
  H1a: 'H1a 夜間保有 全部', H1b: 'H1b 夜間保有 25日線の上だけ', H1c: 'H1c 夜間保有 TOPIX ETF 1306',
  H2_3: 'H2 決算型 3日保有', H2_5: 'H2 決算型 5日保有', H2_10: 'H2 決算型 10日保有', H2_20: 'H2 決算型 20日保有',
  H2_5L: 'H2 決算型 5日保有＋200日線', H2_10L: 'H2 決算型 10日保有＋200日線', H2_20L: 'H2 決算型 20日保有＋200日線',
  H3: 'H3 上昇中の5日-8%下げ 5日保有', H4: 'H4 月末月初', H5: 'H5 52週高値更新 20日保有', BH: '参考 ずっと保有(1日あたり)', R5: '基準 毎日寄りで買い5日保有(同じ銘柄)', R10: '基準 毎日寄りで買い10日保有', R20: '基準 毎日寄りで買い20日保有',
  S_low: 'H2 20日＋200日線 損切り=窓の日の安値', S_8: 'H2 20日＋200日線 損切り-8%', S_12: 'H2 20日＋200日線 損切り-12%',
  SQX: 'H2 損切り=窓の安値 15日以上持って次のSQ前日の引けで売り',
  T10: 'H2 損切り=窓の安値 10日保有', T30: 'H2 損切り=窓の安値 30日保有', T40: 'H2 損切り=窓の安値 40日保有', T60: 'H2 損切り=窓の安値 60日保有',
  B30: '基準 毎日寄りで買い30日保有', B40: '基準 毎日寄りで買い40日保有', B60: '基準 毎日寄りで買い60日保有'
};

function ebRun_(b, x, isEtf) {
  const out = [], n = b.length, add = (rule, i0, buy, sell, days) =>
    out.push({ rule, d: b[i0].d, g: (sell / buy - 1) * 100, days });
  const hi250 = [];
  for (let i = 0; i < n; i++) {
    if (i < 250) { hi250.push(null); continue; }
    let m = -Infinity; for (let j = i - 250; j < i; j++) m = Math.max(m, b[j].c); hi250.push(m);
  }
  // 月末月初の日付
  const monthLast = {};
  for (let i = 0; i < n - 1; i++) if (b[i].d.slice(0, 6) !== b[i + 1].d.slice(0, 6)) monthLast[i] = true;
  for (let i = 211; i < n - 1; i++) {
    const c = b[i].c, up200 = x.ma200[i] != null && c > x.ma200[i] && x.ma200[i] >= x.ma200[i - 10];
    // 基準: 同じ銘柄を毎日買った場合（相場全体の上げを差し引くため）
    if (!isEtf) [5, 10, 20].forEach(N => { if (i + N < n) add('R' + N, i + 1, b[i + 1].o, b[i + N].c, N); });
    if (!isEtf) [30, 40, 60].forEach(N => { if (i + N < n) add('B' + N, i + 1, b[i + 1].o, b[i + N].c, N); });
    // H1 夜間
    if (isEtf) add('H1c', i, c, b[i + 1].o, 1);
    else {
      add('H1a', i, c, b[i + 1].o, 1);
      if (x.ma25[i] != null && c > x.ma25[i]) add('H1b', i, c, b[i + 1].o, 1);
    }
    if (isEtf) { add('BH', i, c, b[i + 1].c, 1); continue; }
    // H2 決算型（D型）
    const p = b[i - 1];
    const d = b[i].o >= p.c * 1.05 && x.vol20[i] > 0 && b[i].v >= 2 * x.vol20[i] && c >= (b[i].h + b[i].l) / 2 && c > p.c * 1.03;
    if (d) [3, 5, 10, 20].forEach(N => {
      const k = i + N; if (k >= n) return;
      add('H2_' + N, i + 1, b[i + 1].o, b[k].c, N);
      if (up200 && N >= 5) add('H2_' + N + 'L', i + 1, b[i + 1].o, b[k].c, N);
    });
    // H2 20日＋200日線に損切り（逆指値）を入れた版。R=損切り幅、損切りに触れたら逆指値（窓で下に開けたら寄り値）で決済
    // SQ基準の手じまい: 買ってから15営業日以上たった後の、最初のSQ（第2金曜）の前営業日の引け成で売る
    if (d && up200) {
      const e = b[i + 1].o, stop = b[i].l * 0.998;
      let exitK = -1;
      for (let k = i + 16; k < n - 1; k++) {
        const dt = b[k + 1].d, y = +dt.slice(0, 4), m = +dt.slice(4, 6) - 1, day = +dt.slice(6, 8);
        const first = new Date(y, m, 1).getDay(), secondFri = 1 + ((5 - first + 7) % 7) + 7;
        if (day >= secondFri && b[k].d.slice(0, 6) + String(secondFri).padStart(2, '0') > b[k].d) { exitK = k; break; }
      }
      if (exitK > 0 && stop < e) {
        let exit = b[exitK].c, days = exitK - i;
        for (let k = i + 1; k <= exitK; k++) {
          if (b[k].o <= stop && k > i + 1) { exit = b[k].o; days = k - i; break; }
          if (b[k].l <= stop) { exit = stop; days = k - i; break; }
        }
        out.push({ rule: 'SQX', d: b[i + 1].d, g: (exit / e - 1) * 100, days, risk: (e - stop) / e * 100 });
      }
    }
    // 保有日数を変えた版（損切り=窓の日の安値）
    if (d && up200) [10, 30, 40, 60].forEach(N => {
      if (i + N >= n) return;
      const e = b[i + 1].o, stop = b[i].l * 0.998;
      if (!(stop < e)) return;
      let exit = b[i + N].c, days = N;
      for (let k = i + 1; k <= i + N; k++) {
        if (b[k].o <= stop && k > i + 1) { exit = b[k].o; days = k - i; break; }
        if (b[k].l <= stop) { exit = stop; days = k - i; break; }
      }
      out.push({ rule: 'T' + N, d: b[i + 1].d, g: (exit / e - 1) * 100, days, risk: (e - stop) / e * 100 });
    });
    if (d && up200 && i + 20 < n) {
      const e = b[i + 1].o;
      [['S_low', b[i].l * 0.998], ['S_8', e * 0.92], ['S_12', e * 0.88]].forEach(([rule, stop]) => {
        if (!(stop < e)) return;
        let exit = b[i + 20].c, days = 20;
        for (let k = i + 1; k <= i + 20; k++) {
          if (b[k].o <= stop && k > i + 1) { exit = b[k].o; days = k - i; break; }
          if (b[k].l <= stop) { exit = stop; days = k - i; break; }
        }
        out.push({ rule, d: b[i + 1].d, g: (exit / e - 1) * 100, days, risk: (e - stop) / e * 100 });
      });
    }
    // H3 上昇中の短期下げすぎ
    if (up200 && i >= 5 && c <= b[i - 5].c * 0.92 && i + 5 < n) add('H3', i + 1, b[i + 1].o, b[i + 5].c, 5);
    // H4 月末月初: 最終営業日の3日前の引けで買い → 翌月3営業日目の引けで売り
    if (monthLast[i + 3] && i + 6 < n) add('H4', i, c, b[i + 6].c, 6);
    // H5 52週高値更新
    if (hi250[i] != null && c > hi250[i] && x.vol20[i] > 0 && b[i].v >= 1.5 * x.vol20[i] && i + 20 < n)
      add('H5', i + 1, b[i + 1].o, b[i + 20].c, 20);
  }
  return out;
}

function edgeBacktest() {
  const codes = SW_CODES.concat(['1306']);
  const all = [];
  let firstD = '99999999', lastD = '00000000';
  for (let s = 0; s < codes.length; s += 20) {
    const chunk = codes.slice(s, s + 20);
    const resps = UrlFetchApp.fetchAll(chunk.map(c => ({
      url: `https://query1.finance.yahoo.com/v8/finance/chart/${c}.T?range=6y&interval=1d`, headers: UA, muteHttpExceptions: true })));
    resps.forEach((r, j) => {
      const b = swParse_(r.getContentText());
      if (!b || b.length < 260) { Logger.log(`${chunk[j]}: データ不足`); return; }
      if (b[211].d < firstD) firstD = b[211].d; if (b[b.length - 1].d > lastD) lastD = b[b.length - 1].d;
      all.push(...ebRun_(b, swIndicators_(b), chunk[j] === '1306'));
    });
    Utilities.sleep(500);
  }
  const months = Math.max(1, (Number(lastD.slice(0, 4)) - Number(firstD.slice(0, 4))) * 12 +
    Number(lastD.slice(4, 6)) - Number(firstD.slice(4, 6)) + 1);
  const r2 = v => Math.round(v * 1000) / 1000, mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
  const rows = Object.keys(EB_NAMES).map(rule => {
    const t = all.filter(r => r.rule === rule).sort((a, b) => a.d < b.d ? -1 : 1);
    if (!t.length) return [EB_NAMES[rule], 0, '', '', '', '', '', '', '', '', '', 'シグナルなし'];
    const cost = rule === 'BH' ? 0 : SW_COST, net = t.map(r => r.g - cost);
    let st = 0, mx = 0; net.forEach(v => { st = v <= 0 ? st + 1 : 0; mx = Math.max(mx, st); });
    const years = {}; t.forEach((r, i) => (years[r.d.slice(0, 4)] = years[r.d.slice(0, 4)] || []).push(net[i]));
    let note = Object.keys(years).sort().map(y => `${y}:${mean(years[y]).toFixed(2)}%`).join(' ');
    if (t[0].risk) note = `平均${mean(t.map((r, i) => net[i] / r.risk)).toFixed(2)}R 損切り幅平均${mean(t.map(r => r.risk)).toFixed(1)}% 平均保有${mean(t.map(r => r.days)).toFixed(0)}日 | ` + note;
    if (rule === 'S_low') {
      const mo = {}; t.forEach((r, i) => (mo[r.d.slice(4, 6)] = mo[r.d.slice(4, 6)] || []).push(net[i]));
      note += ' | 買った月別: ' + Object.keys(mo).sort().map(m => `${+m}月${mean(mo[m]).toFixed(1)}%(${mo[m].length})`).join(' ');
    }
    const early = net.filter((v, i) => t[i].d < '20240101'), late = net.filter((v, i) => t[i].d >= '20240101');
    const perM = t.length / months;
    return [EB_NAMES[rule], t.length, Math.round(net.filter(v => v > 0).length / t.length * 100), r2(mean(net)), r2(mean(t.map(r => r.g))),
      Math.round(perM * 10) / 10, r2(mean(early)), r2(mean(late)), r2(net.reduce((m, v) => Math.min(m, v), Infinity)), mx,
      Math.round(mean(net) / 100 * 4000000 * perM), note];
  });
  const sh = sheet_('edge_bt', EB_HEADER);
  sh.clearContents();
  sh.getRange(1, 1, 1, EB_HEADER.length).setValues([EB_HEADER]);
  sh.getRange(2, 1, rows.length, EB_HEADER.length).setValues(rows);
  rows.forEach(r => Logger.log(`${r[0]}: ${r[1]}件 勝率${r[2]}% 平均${r[3]}%(前半${r[6]} 後半${r[7]}) 月${r[5]}回 → 400万で月${r[10]}円`));
  Logger.log(`完了: ${firstD}〜${lastD} → シート edge_bt`);
}
