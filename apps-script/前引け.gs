/**
 * 前引けチェック（平日11:35にDiscordへ「🍱 前引けチェック」）。後場デイトレの候補選び用。
 * 同じプロジェクトに追加し、まず testLunch を手で実行（ログだけ、Discordには送らない）→ よければ setupLunch を1回実行。
 * 結果はシート lunch にも残す（後で後場の結果と照らして、クセが本当に効いたかを確かめる）。
 * IR通知.gs の sheet_ / UA / P、地合い.gs の postDiscordSafe_、クセ表.gs の KUSE_CODES / kuseRsi_ を使う。
 *
 * 銘柄ごとに出すもの: 前日比・寄り→前引け・前場の高安の中のどこで引けたか・5分足RSI(14)・5分足25本線からの乖離・
 *   前場の出来高（直近4日の前場平均と比べて）・前場VWAP・「みんなが損切りを置く場所」（前場安値/高値・キリ番）・当てはまるクセ
 */
const LUNCH_CODES = Object.assign({}, KUSE_CODES); // 足したい銘柄は KUSE_CODES に追加するか、ここに { '6920': 'レーザーテック' } のように足す
// グループ分け（グループごとに前場の平均を出して、どこにお金が向いているかを見る）。ここにない銘柄は「その他」
const LUNCH_GROUPS = { '装置': ['6857', '8035'], '後工程・パッケージ': ['4062'], '電線': ['5803', '5801'], 'メモリ（見るだけ）': ['285A'], '重工・防衛': ['7011'] };
const LUNCH_WATCH = ['285A']; // 見るだけ（売買しない）の銘柄
const LUNCH_HEADER = ['date', 'code', 'name', 'prev_close', 'am_close', 'am_chg_pct', 'open_to_am_pct', 'pos_in_range_pct',
  'rsi5m', 'dev_ma25_pct', 'vol_vs_avg', 'vwap', 'am_high', 'am_low', 'notes'];

function setupLunch() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'lunch').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('lunch').timeBased().everyDays(1).atHour(11).nearMinute(35).inTimezone('Asia/Tokyo').create();
  sheet_('lunch', LUNCH_HEADER);
  Logger.log('平日11:35の前引けチェックを登録しました（土日・祝日は自動で何もしません）');
}
function lunch() { lunch_(false); }
function testLunch() { lunch_(true); }

function lunchBars_(code) {
  const r = UrlFetchApp.fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${code}.T?range=5d&interval=5m`, { headers: UA, muteHttpExceptions: true });
  return kuseParse_(r.getContentText());
}

function lunchUs_() {
  const one = s => { const u = kuseUs_(s), k = Object.keys(u).sort(); return k.length ? { d: k[k.length - 1], v: u[k[k.length - 1]] } : null; };
  return { sox: one('^SOX'), intc: one('INTC') };
}

/** キリ番（100円・1000円単位など、値段に応じた区切り）で、今の値段に一番近いもの */
function lunchRound_(p) {
  const step = p >= 10000 ? 1000 : p >= 3000 ? 500 : p >= 1000 ? 100 : 50;
  return Math.round(p / step) * step;
}

function lunch_(dry) {
  const now = new Date(), today = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMdd'), dow = Number(Utilities.formatDate(now, 'Asia/Tokyo', 'u'));
  if (dow >= 6) { Logger.log('土日なので何もしません'); return; }
  const us = lunchUs_(), r2 = v => Math.round(v * 100) / 100, fmt = v => Math.round(v).toLocaleString();
  const lines = {}, chg = {}, rows = [];
  Object.keys(LUNCH_CODES).forEach(code => {
    const name = LUNCH_CODES[code], b = lunchBars_(code);
    const am = b.filter(x => x.d === today && x.t < '11:30');
    if (am.length < 10) { Logger.log(`${code} ${name}: 今日の前場の5分足がない（祝日か取得失敗）`); return; }
    const prevDays = Array.from(new Set(b.filter(x => x.d < today).map(x => x.d))).sort();
    if (!prevDays.length) return;
    const prevClose = b.filter(x => x.d === prevDays[prevDays.length - 1]).slice(-1)[0].c;
    const upto = b.filter(x => x.d < today || (x.d === today && x.t < '11:30'));
    const rsi = kuseRsi_(upto), rsiNow = rsi[rsi.length - 1];
    const ma25 = upto.slice(-25).reduce((s, x) => s + x.c, 0) / Math.min(25, upto.length);
    const o = am[0].o, c = am[am.length - 1].c, hi = Math.max(...am.map(x => x.h)), lo = Math.min(...am.map(x => x.l));
    const vol = am.reduce((s, x) => s + x.v, 0), pv = am.reduce((s, x) => s + (x.h + x.l + x.c) / 3 * x.v, 0);
    const vwap = vol ? pv / vol : c;
    const pastAmVol = prevDays.slice(-4).map(d => b.filter(x => x.d === d && x.t < '11:30').reduce((s, x) => s + x.v, 0)).filter(v => v > 0);
    const volX = pastAmVol.length ? vol / (pastAmVol.reduce((s, v) => s + v, 0) / pastAmVol.length) : NaN;
    const amChg = (c / prevClose - 1) * 100, o2c = (c / o - 1) * 100, pos = hi > lo ? (c - lo) / (hi - lo) * 100 : 50, dev = (c / ma25 - 1) * 100;
    // 当てはまるクセ（クセ表 kuse の5分足60日、回数は少ないので目安）
    const notes = [];
    const o2_11 = (() => { const x = am.filter(y => y.t < '11:00'); return x.length ? (x[x.length - 1].c / o - 1) * 100 : NaN; })();
    if (code === '4062') {
      notes.push('13:00までに前引け比-0.5%以上下げたら、引けまで戻りにくい（下げた割合70%）＝押し目買いしない');
      if (rsiNow >= 80) notes.push('RSI80超え＝売られやすい水準（1時間足でも5分足でも反落）');
      if (us.sox && us.intc && us.sox.v >= 1 && us.intc.v <= us.sox.v - 2) notes.push(`前夜はSOX高なのにインテルが弱い（SOX${r2(us.sox.v)}% / INTC${r2(us.intc.v)}%）＝イビデンは伸びにくい日`);
      if (us.sox && us.intc && us.sox.v >= 1 && us.intc.v >= us.sox.v) notes.push(`前夜はインテルもSOX以上（SOX${r2(us.sox.v)}% / INTC${r2(us.intc.v)}%）＝イビデンが一番伸びやすい日`);
    }
    if (code === '6857') {
      notes.push('13:00までに前引け比+0.5%以上上げたら、その後は下げやすい（11/10の売りの型）');
      if (rsiNow >= 60 && rsiNow < 80) notes.push('5分足RSI60〜80＝3時間後に下げやすい帯');
      if (rsiNow < 20) notes.push('5分足RSI20割れ＝3時間後+1.8%（反発買いの候補）');
      if (us.sox && us.intc && us.sox.v >= 1 && us.intc.v <= us.sox.v - 2) notes.push('前夜SOX高・インテル弱＝寄り→引け-0.88%の日（42回）');
    }
    if (code === '8035') {
      notes.push('13:00までに前引け比+0.5%以上上げたら、引けまで続きやすい（+0.25%）');
      if (rsiNow <= 30) notes.push('RSI30割れは逆張りが効かない（さらに下げやすい）');
    }
    if (code === '7011') {
      if (rsiNow >= 80) notes.push('5分足RSI80超え＝1時間後-0.5〜-0.7%（下げ67%）の水準。急騰は売り候補');
      else if (rsiNow >= 70) notes.push('5分足RSI70台＝80を超えたら売り候補（80上抜けは1時間後-0.5〜-0.7%）');
    }
    if (code === '5801') {
      notes.push('13:00までに前引け比+0.5%以上上げたら、引けまで+0.61%（下げたのは19%だけ）＝後場の上げに乗る');
      if (rsiNow <= 30) notes.push('5分足RSI30割れは3時間後-0.8%＝押し目買いしない（逆張り不向き）');
      notes.push('1時間足RSI80上抜けは6時間後+2.6%（順張りが効く、イビデンと逆）');
    }
    if (code === '5803') {
      notes.push('12:30〜13:00は売られやすい（下げ65%）＝後場寄りで飛びつかない');
    }
    if (code === '285A') {
      notes.push('見るだけ: 5分足RSI30〜40帯は3時間後-1.0%（下げ67%）、日足の高値更新3日目の翌日は-1.8%（3日以内に最大-9%）');
    }
    if (!isNaN(o2_11) && o2_11 >= 1) notes.push(`寄り→11:00 +${r2(o2_11)}%（前場で+1%以上上げた日）`);
    // みんなが置く場所（ここのすぐ外を損切りにすると狩られやすい／すぐ内側に置く）
    const rnd = lunchRound_(c);
    const crowd = `前場安値${fmt(lo)}・前場高値${fmt(hi)}・キリ番${fmt(rnd)}`;
    rows.push([today, code, name, prevClose, c, r2(amChg), r2(o2c), Math.round(pos), r2(rsiNow), r2(dev), isNaN(volX) ? '' : r2(volX),
      Math.round(vwap), hi, lo, notes.join(' / ')]);
    chg[code] = amChg;
    lines[code] = (`**${name}（${code}）${LUNCH_WATCH.includes(code) ? '［見るだけ］' : ''}** ${fmt(c)}円 前日比${amChg >= 0 ? '+' : ''}${r2(amChg)}%（寄りから${o2c >= 0 ? '+' : ''}${r2(o2c)}%）\n` +
      `前場の高安の中で ${Math.round(pos)}% の位置 / 5分RSI ${Math.round(rsiNow)} / 25本線から${dev >= 0 ? '+' : ''}${r2(dev)}% / 出来高 普段の${isNaN(volX) ? '?' : r2(volX)}倍 / VWAP ${fmt(vwap)}\n` +
      `みんなが置く場所: ${crowd}\n` + (notes.length ? notes.map(n => `・${n}`).join('\n') : '・当てはまるクセなし'));
    Utilities.sleep(200);
  });
  if (!rows.length) { Logger.log('前場のデータがない（祝日か取得失敗）ので送りません'); return; }
  const head = us.sox && us.intc ? `前夜 SOX ${r2(us.sox.v)}% / インテル ${r2(us.intc.v)}%\n\n` : '';
  const grouped = Object.assign({}, LUNCH_GROUPS), inG = new Set([].concat(...Object.values(LUNCH_GROUPS)));
  const others = Object.keys(lines).filter(c => !inG.has(c)); if (others.length) grouped['その他'] = others;
  const avg = cs => { const v = cs.filter(c => chg[c] != null).map(c => chg[c]); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };
  const order = Object.keys(grouped).filter(g => grouped[g].some(c => lines[c])).sort((a, b) => avg(grouped[b]) - avg(grouped[a]));
  const summary = '前場の強い順: ' + order.map(g => `${g} ${avg(grouped[g]) >= 0 ? '+' : ''}${r2(avg(grouped[g]))}%`).join(' > ');
  const body = order.map(g => `__${g}__（平均${avg(grouped[g]) >= 0 ? '+' : ''}${r2(avg(grouped[g]))}%）\n` + grouped[g].filter(c => lines[c]).map(c => lines[c]).join('\n\n')).join('\n\n');
  const text = head + summary + '\n\n' + body + '\n\nクセは5分足60日の目安（回数12〜23回）。入る理由・損切り・同値撤退を先に決めてから。';
  Logger.log(text);
  if (dry) return;
  const sh = sheet_('lunch', LUNCH_HEADER);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, LUNCH_HEADER.length).setValues(rows);
  postDiscordSafe_({ embeds: [{ title: `🍱 前引けチェック ${today.slice(4, 6)}/${today.slice(6)}`, description: text.slice(0, 4000), color: 0xf5a623 }] });
}
