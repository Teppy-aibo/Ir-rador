/**
 * G7（+8〜20%の大幅ギャップアップを寄り成で空売り・損切り2%・利確2R・引け成）を「セクターの風向き」で分けて検証する。
 * 11/11 住友不動産・資生堂・ホンダなど好決算の大型株がそろって寄り天 → 資金が半導体へ戻った日だった、という気づきから。
 *
 * 使い方: スイング検証.gs / 朝完結検証.gs と同じプロジェクトに追加し、g7SectorBacktest を1回実行（3〜5分）。
 * 使うもの: swParse_ / swIndicators_ / swStats_ / SW_CODES / SW_COST（スイング検証.gs）、mbTrade_（朝完結検証.gs）、sheet_ / UA（IR通知.gs）
 * 結果: シート g7_sector と実行ログ
 *
 * 分け方（どれも寄りの時点で分かる情報だけ）:
 *  A 前日のセクター: その銘柄の業種ETF（TOPIX-17）の前日の騰落 − TOPIX(1306)の前日の騰落 が プラス / マイナス
 *  B 当日の寄りのセクター: 業種ETFの寄りのギャップ − 1306の寄りのギャップ が プラス / マイナス（＝今日その業種に資金が来ているか）
 *  C 5日のセクター: 業種ETFの前日までの5日騰落 − 1306の5日騰落 が プラス / マイナス
 *  それぞれ、地合いフィルタ（1306が75日線の下）あり／なし。2020〜23年と2024年〜を分けて出す。
 */

// 108銘柄 → TOPIX-17業種ETF
const G7_SECTOR = (() => {
  const m = {
    '1617': ['2914', '2502', '2802'],
    '1618': ['5020', '1605'],
    '1619': ['1925', '1928', '1801', '1802', '1803', '1812'],
    '1620': ['4063', '4452', '4911', '4004', '4005', '4188', '3407', '4901'],
    '1621': ['4502', '4503', '4568', '4519', '4523', '4578'],
    '1622': ['7203', '7267', '7269', '7270', '6902', '5108', '7012', '6201'],
    '1623': ['5401', '5411', '5713', '5802', '5803', '5801', '3436'],
    '1624': ['6146', '6367', '6273', '6301', '6326', '7011', '7013'],
    '1625': ['6758', '6861', '8035', '6857', '6501', '6503', '6702', '6752', '6954', '6981', '6762', '6971', '6594',
      '4062', '6920', '7735', '6723', '6526', '7751', '7741', '4543', '7733'],
    '1626': ['9984', '6098', '9432', '9433', '9434', '7974', '4661', '4689', '4755', '2413', '9766', '7832'],
    '1627': ['9501', '9503'],
    '1628': ['9020', '9022', '9101', '9104', '9107'],
    '1629': ['8058', '8031', '8001', '8053', '8002'],
    '1630': ['3382', '9983', '8267'],
    '1631': ['8306', '8316', '8411'],
    '1632': ['8766', '8725', '8630', '8591', '8604', '8601'],
    '1633': ['8801', '8802', '8830'],
  };
  const out = {};
  Object.entries(m).forEach(([etf, codes]) => codes.forEach(c => out[c] = etf));
  return out;
})();

const G7S_HEADER = ['split', 'bucket', 'filter', 'trades', 'win_pct', 'avg_R', 'PF', 'max_losing_streak', 'per_month',
  'avg_R_2020_23', 'avg_R_2024_', 'yen_per_month_1R5man'];

function g7SectorBacktest() {
  const etfs = ['1306', ...new Set(Object.values(G7_SECTOR))];
  const ref = {}; // etf -> {d: {o,c,prevC,c5}}
  const resps = UrlFetchApp.fetchAll(etfs.map(c => ({
    url: `https://query1.finance.yahoo.com/v8/finance/chart/${c}.T?range=6y&interval=1d`, headers: UA, muteHttpExceptions: true })));
  let mkt75 = {};
  resps.forEach((r, j) => {
    const b = swParse_(r.getContentText());
    if (!b) { Logger.log(`${etfs[j]}: データなし`); return; }
    const m = {};
    for (let i = 6; i < b.length; i++) m[b[i].d] = { o: b[i].o, c: b[i].c, p1: b[i - 1].c, p2: b[i - 2].c, p6: b[i - 6].c };
    ref[etfs[j]] = m;
    if (etfs[j] === '1306') {
      const x = swIndicators_(b);
      b.forEach((bb, i) => { if (x.ma75[i] != null) mkt75[bb.d] = bb.c > x.ma75[i]; });
    }
  });
  if (!ref['1306']) throw new Error('1306 が取れませんでした');

  const res = {}; // key -> [{entry_date, R}]
  const add = (k, d, R) => (res[k] = res[k] || []).push({ entry_date: d, exit_date: d, R, days: 1 });
  let firstD = '99999999', lastD = '00000000', n = 0;
  for (let s = 0; s < SW_CODES.length; s += 20) {
    const chunk = SW_CODES.slice(s, s + 20);
    const rs = UrlFetchApp.fetchAll(chunk.map(c => ({
      url: `https://query1.finance.yahoo.com/v8/finance/chart/${c}.T?range=6y&interval=1d`, headers: UA, muteHttpExceptions: true })));
    rs.forEach((r, j) => {
      const code = chunk[j], etf = G7_SECTOR[code];
      const b = swParse_(r.getContentText());
      if (!b || b.length < 30 || !etf || !ref[etf]) return;
      for (let i = 1; i < b.length; i++) {
        const d = b[i].d, prevD = b[i - 1].d, gap = b[i].o / b[i - 1].c - 1;
        if (!(gap > 0.08 && gap <= 0.20)) continue;
        const t = ref['1306'][d], e = ref[etf][d], tp = ref['1306'][prevD], ep = ref[etf][prevD];
        if (!t || !e || !tp || !ep) continue;
        if (d < firstD) firstD = d; if (d > lastD) lastD = d; n++;
        const tr = mbTrade_({ side: -1, entry: b[i].o }, b[i], 2, 2);
        const A = (ep.c / ep.p1 - 1) - (tp.c / tp.p1 - 1);       // 前日のセクター相対
        const B = (e.o / e.p1 - 1) - (t.o / t.p1 - 1);            // 当日寄りのセクター相対
        const C = (ep.c / ep.p6 - 1) - (tp.c / tp.p6 - 1);       // 前日までの5日セクター相対
        const f = mkt75[prevD] === false; // 売りなので1306が75日線の下の日
        [['全部', '-', true], ['A 前日セクター', A > 0 ? '強い' : '弱い', true], ['B 当日寄りのセクター', B > 0 ? '資金が来ている' : '来ていない', true],
          ['C 5日セクター', C > 0 ? '強い' : '弱い', true]].forEach(([sp, bk]) => {
          add(`${sp}|${bk}|`, d, tr.R);
          if (f) add(`${sp}|${bk}|地合い`, d, tr.R);
        });
      }
    });
    Utilities.sleep(500);
  }
  const months = Math.max(1, (Number(lastD.slice(0, 4)) - Number(firstD.slice(0, 4))) * 12 +
    Number(lastD.slice(4, 6)) - Number(firstD.slice(4, 6)) + 1);
  const avg = a => a.length ? Math.round(a.reduce((s, v) => s + v, 0) / a.length * 100) / 100 : '';
  const rows = Object.keys(res).map(k => {
    const [sp, bk, f] = k.split('|'), tr = res[k];
    tr.sort((a, b) => a.entry_date < b.entry_date ? -1 : 1);
    const st = swStats_(k, tr, months);
    const early = tr.filter(r => r.entry_date < '20240101').map(r => r.R), late = tr.filter(r => r.entry_date >= '20240101').map(r => r.R);
    return [sp, bk, f || 'なし', st.trades, st.win_pct, st.avg_R, st.PF, st.max_losing_streak, st.per_month,
      avg(early), avg(late), Math.round(st.avg_R * st.per_month * 50000)];
  });
  rows.sort((a, b) => (a[0] + a[2] + a[1]).localeCompare(b[0] + b[2] + b[1]));
  const sh = sheet_('g7_sector', G7S_HEADER);
  sh.clearContents();
  sh.getRange(1, 1, 1, G7S_HEADER.length).setValues([G7S_HEADER]);
  if (rows.length) sh.getRange(2, 1, rows.length, G7S_HEADER.length).setValues(rows);
  rows.forEach(r => Logger.log(`${r[0]}［${r[1]}］地合い${r[2]}: ${r[3]}件 勝率${r[4]}% 平均${r[5]}R (前半${r[9]} 後半${r[10]}) 月${r[8]}回`));
  Logger.log(`完了: G7シグナル${n}件 ${firstD}〜${lastD} → シート g7_sector`);
}
