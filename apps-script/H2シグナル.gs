/**
 * H2（決算型スイング）の今日のシグナルを出す（1〜2分）。毎日16:40に自動実行＋Discord通知もできる。
 * 同じプロジェクトに追加し、まず h2Today を手で1回実行 → よければ setupH2 を1回実行（平日16:40の自動実行を登録）。
 * 結果はシート h2_now。シグナルがあればDiscordに「📊 H2シグナル」として送る（なければ送らない）。
 * スイング検証.gs の swParse_ / swIndicators_ / SW_CODES と IR通知.gs の sheet_ / UA / fetchTdnet_ / postDiscord_ を使う。
 *
 * 調べる銘柄: 大型108銘柄 ＋ 前営業日15:00以降〜今朝9:00までにTDnetで決算・業績修正を出した全銘柄（プライム以外も）
 *   検証では「決算の窓」だけが勝っていた（決算月+5.1%/回、それ以外はマイナス）ので、決算の開示がない窓は見送り扱い。
 *   大型株以外は過去の検証がないので、売買代金5億円以上だけに絞り、当面は紙トレードで成績を確かめる。
 * 条件（今日の引けで判定）: 前日比+5%以上の窓で寄る・出来高20日平均の2倍・上半分で引け・前日比+3%以上・200日線の上で上向き
 * 祝日明け: 前営業日はTOPIX ETFの実際の取引日から決めるので、連休中・祝日前の開示もまとめて拾う。
 * A判定（11/12追加、H2全銘柄検証 h2all_ex）: 引け位置0.7以上 × 損切り幅8%以下 × 出来高10倍未満。6年で319回0.94R・全年プラス、A以外は0.01R。
 *   さらに窓+5〜8%なら「★A（窓5〜8%）」＝前後半とも1.1R台で一番安定。A以外は通知に「A外」と出す（入るなら紙トレード）。
 * 注文（翌朝）: 寄り成で買い / 逆指値の損切り=今日の安値×0.998 / 株数=1R÷(終値−損切り) / 手じまい=15営業日以上たった後のSQ前日の引け成
 */
const H2_R = 50000;          // 1R（円）
const H2_MIN_VALUE = 5e8;    // 大型108銘柄以外は、今日の売買代金がこれ以上のものだけ
const H2_HEADER = ['date', 'code', 'name', 'close', 'gap_pct', 'vol_x', 'value_oku', 'stop', 'risk_pct', 'shares_1R', 'exit_hint', 'disclosure', 'judge', 'close_pos', 'a_flag'];
const H2_KW = ['決算短信', '業績予想', '業績予想の修正', '配当予想', '上方修正'];

function setupH2() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'h2Auto').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('h2Auto').timeBased().everyDays(1).atHour(16).nearMinute(40).inTimezone('Asia/Tokyo').create();
  sheet_('h2_now', H2_HEADER);
  Logger.log('毎日16:40のH2シグナル確認を登録しました（土日・祝日は自動で何もしません）');
}

function h2Auto() { h2_(true); }
function h2Today() { h2_(false); }

function h2_(notify) {
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
  // 決算・業績修正の開示（前営業日15:00以降〜今朝9:00）
  // 前営業日は実際の取引日（TOPIX ETF 1306 の日足）から決める＝祝日明けでも取りこぼさない
  const etf = swParse_(UrlFetchApp.fetch('https://query1.finance.yahoo.com/v8/finance/chart/1306.T?range=1mo&interval=1d',
    { headers: UA, muteHttpExceptions: true }).getContentText()) || [];
  const tradeDays = etf.map(b => b.d).filter(d => d < today);
  const prevDay = tradeDays.length ? tradeDays[tradeDays.length - 1] : null;
  const disc = h2Disclosures_(today, prevDay);
  const codes = Array.from(new Set(SW_CODES.concat(Object.keys(disc))));
  const rows = [];
  let lastBar = '';
  for (let s = 0; s < codes.length; s += 20) {
    const chunk = codes.slice(s, s + 20);
    const resps = UrlFetchApp.fetchAll(chunk.map(c => ({
      url: `https://query1.finance.yahoo.com/v8/finance/chart/${c}.T?range=2y&interval=1d`, headers: UA, muteHttpExceptions: true })));
    resps.forEach((r, j) => {
      const code = chunk[j], b = swParse_(r.getContentText());
      if (!b || b.length < 230) return;
      const x = swIndicators_(b), i = b.length - 1, p = b[i - 1], t = b[i];
      if (t.d > lastBar) lastBar = t.d;
      if (t.d !== today) return; // 今日の足がない（休場・取得遅れ）
      const ok = t.o >= p.c * 1.05 && x.vol20[i] > 0 && t.v >= 2 * x.vol20[i] && t.c >= (t.h + t.l) / 2 && t.c > p.c * 1.03;
      if (!ok) return;
      const value = t.c * t.v, big = SW_CODES.includes(code);
      if (!big && value < H2_MIN_VALUE) return;
      const up200 = x.ma200[i] != null && t.c > x.ma200[i] && x.ma200[i] >= x.ma200[i - 10];
      const stop = Math.floor(t.l * 0.998), risk = t.c - stop, d = disc[code];
      const cpos = t.h > t.l ? (t.c - t.l) / (t.h - t.l) : 1, gapPct = (t.o / p.c - 1) * 100, volx = t.v / x.vol20[i];
      const isA = cpos >= 0.7 && risk / t.c * 100 <= 8 && volx < 10;
      const aFlag = !isA ? 'A外' : gapPct < 8 ? '★A（窓5〜8%）' : '★A';
      const judge = !up200 ? '見送り（200日線×）' : !d ? '見送り（決算の窓ではない）' : big ? '候補' : '候補（大型以外＝紙トレード）';
      rows.push([t.d, code, d ? d.name : '', t.c, Math.round((t.o / p.c - 1) * 1000) / 10, Math.round(t.v / x.vol20[i] * 10) / 10,
        Math.round(value / 1e7) / 10, stop, Math.round(risk / t.c * 1000) / 10, Math.floor(H2_R / risk / 100) * 100,
        h2Exit_(t.d), d ? `${d.time} ${d.title}` : '', judge, Math.round(cpos * 100) / 100, aFlag]);
    });
    Utilities.sleep(300);
  }
  if (lastBar && lastBar !== today) { Logger.log(`今日(${today})の足がありません（最新 ${lastBar}）＝休場か取得前`); if (notify) return; }
  const rank = r => (r[12].startsWith('候補') ? 0 : 2) + (String(r[14]).startsWith('★') ? 0 : 1);
  rows.sort((a, b) => rank(a) - rank(b));
  const sh = sheet_('h2_now', H2_HEADER);
  sh.clearContents();
  sh.getRange(1, 1, 1, H2_HEADER.length).setValues([H2_HEADER]);
  if (rows.length) sh.getRange(2, 1, rows.length, H2_HEADER.length).setValues(rows);
  Logger.log(`調べた銘柄 ${codes.length}（うち決算などの開示 ${Object.keys(disc).length}）→ シグナル ${rows.length}件`);
  rows.forEach(r => Logger.log(r.join(' | ')));
  const picks = rows.filter(r => String(r[12]).startsWith('候補'));
  if (notify && picks.length) {
    const lines = picks.map(r => `${String(r[14]).startsWith('★') ? r[14] : '　A外（検証では期待値ほぼ0＝入るなら紙）'}\n**${r[1]} ${r[2]}** 終値${r[3]}（窓+${r[4]}%・出来高${r[5]}倍・引け位置${r[13]}）\n` +
      `　寄り成で買い／逆指値 ${r[7]}（-${r[8]}%）／${r[9]}株（1R=5万）／手じまい ${r[10]}\n　${r[11]}${r[12].includes('紙') ? '\n　※大型以外＝紙トレード' : ''}`);
    postDiscord_({ content: `📊 H2シグナル（${today}引け → 明日の朝の注文）\n` + lines.join('\n') });
  }
}

/** 前営業日15:00以降〜今朝9:00までの決算・業績修正の開示 {code: {time,title,name}} */
function h2Disclosures_(today, prevDay) {
  const out = {}, base = new Date(+today.slice(0, 4), +today.slice(4, 6) - 1, +today.slice(6, 8));
  // 今日から前営業日までさかのぼって全部の日の開示を見る（前営業日が分からなければ平日に着くまで、最大10日）
  const days = [];
  for (let k = 0; k <= 10; k++) {
    const dt = new Date(base); dt.setDate(base.getDate() - k);
    const day = Utilities.formatDate(dt, 'Asia/Tokyo', 'yyyyMMdd');
    days.push(day);
    if (k > 0 && (prevDay ? day <= prevDay : dt.getDay() % 6)) break;
  }
  if (!prevDay) Logger.log('前営業日を取得できなかったので、直前の平日を前営業日として扱いました（祝日明けは要確認）');
  days.forEach((day, idx) => {
    let items = [];
    try { items = fetchTdnet_(day); } catch (e) { Logger.log(`TDnet ${day} 取得失敗: ${e}`); }
    const isToday = idx === 0, isPrev = idx === days.length - 1;
    items.forEach(it => {
      const tm = String(it.time || '').slice(0, 5);
      if (isToday && tm >= '09:00') return;   // 今日の場中・引け後は明日の窓になる
      if (isPrev && tm < '15:00') return;     // 前営業日の場中の開示はその日に反応済み
      if (!H2_KW.some(w => String(it.title).includes(w))) return;
      if (!out[it.code]) out[it.code] = { time: `${day.slice(4, 6)}/${day.slice(6)} ${tm}`, title: String(it.title).slice(0, 40), name: it.name };
    });
  });
  return out;
}

/** 15営業日（土日を除く、祝日は無視の近似）以上たった後の最初のSQ（第2金曜）の前日 */
function h2Exit_(d) {
  const dt = new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
  let n = 0; while (n < 16) { dt.setDate(dt.getDate() + 1); if (dt.getDay() % 6) n++; }
  for (let k = 0; k < 2; k++) {
    const y = dt.getFullYear(), m = dt.getMonth() + k;
    const f = new Date(y, m, 1), sq = new Date(y, m, 1 + ((5 - f.getDay() + 7) % 7) + 7);
    if (sq > dt) { sq.setDate(sq.getDate() - 1); return Utilities.formatDate(sq, 'Asia/Tokyo', 'yyyy/MM/dd') + ' 引け成'; }
  }
  return '';
}
