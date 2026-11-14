/**
 * 夜間の検証エンジン: シート experiments の1行＝1つの仮説。status が new の行を毎晩自動で検証して、結果を同じ行に書く。
 * ユーザーはコードを貼らなくてよい。Claude（またはユーザー）がシートに行を足すだけで回る。
 *
 * 使い方: Ir-rador プロジェクトに追加 → setupExperiments を1回実行（シート作成・最初の仮説・毎晩20:30の自動実行を登録）。
 *   手で回すときは runExperiments。もう一度検証したい行は status を new に戻す。止めたい行は off。
 * 使うもの: swParse_ / SW_CODES / SW_COST（スイング検証.gs）、indFetch_ / indCalc_（指標検証.gs）、KUSE_CODES（クセ表.gs）、
 *   sheet_ / UA / postDiscord_（IR通知.gs）
 *
 * 列: id | status | 足(日足/5分足) | 対象 | 条件 | 売買(買い/売り) | 手じまい | 損切り% | 利確% | メモ | 結果…
 *  対象: 108 / 半導体 / AI半導体 / 値がさ / 注力 / 米半導体 / 米大型 / コードをカンマ区切り（例 6857,8035 や NVDA,AMD）
 *   米国株は検証専用。日足の米国株では x.sox x.tGap x.mkt75 x.nt など日本の市場の値は空（null）
 *  条件: JavaScript の式。x.〇〇 で下の値が使える（例  x.sox >= 3 && x.gap > 0 ）
 *   日足（その日の寄りの時点で分かる値。入るのは寄り）:
 *     x.gap 寄りの窓% / x.ret1 前日の騰落% / x.ret5 前日までの5日% / x.ret20 20日% / x.dev25 前日終値の25日線乖離%
 *     x.above200 前日終値が200日線の上 / x.rsi 前日のRSI14 / x.vol 前日の出来高÷20日平均 / x.hi52 前日に52週高値を更新
 *     x.sox 前夜の米SOX騰落% / x.tGap TOPIX ETF(1306)の窓% / x.tRet1 TOPIXの前日% / x.mkt75 TOPIXが75日線の上
 *     x.nkUp 日経ETF(1321)の前日までの連騰日数 / x.nkRet5 日経ETFの前日までの5日% 
 *     x.vix x.vixChg x.vixPct 前夜のVIX・前日比%・過去1年での位置(0〜1) / x.nvi x.nviChg x.nviPct 前日の日経VI・前日比%・過去1年での位置
 *     x.mpl 信用評価損益率%（二市場・週次・公表済みの最新） / x.mplChg その前週差（ポイント）
 *     x.ago(k) k営業日前の日: .gap 窓% / .vixPct / .nviPct / .ret その日の寄り→前日の引け%（例 x.ago(3).gap <= -2）
 *     x.soxUp75 前夜のSOXが75日線の上 / x.wk 今週最初の日の寄り→前日の引け% / x.wkMin 今週すでに終わった日で一番悪い日の騰落% / x.wkDays 今週すでに終わった営業日数
 *     x.nt 日経ETF(1321)の窓−TOPIXの窓（%） / x.dow 曜日(1=月〜5=金) / x.month 月 / x.day 日 / x.code / x.price 寄り値
 *   5分足（足の終値の時点。入るのはその足の終値。直近60日）:
 *     x.rsi RSI9 / x.ma5 / x.ma25 / x.up x.dn ボリンジャー±2σ / x.bw バンド幅 / x.bw6 6本前のバンド幅 / x.vwap
 *     x.o x.h x.l x.c / x.p 1本前の足（同じ日だけ、なければ null） / x.hm 時刻 '13:05'（米国株はNY時間） / x.min 寄りから何分（日本9:00・米国9:30から。日米で同じ条件を使うときはこちら） / x.dayRet 前日比% / x.fromOpen 始値比%
 *     x.ema60 EMA60（≒15分足のEMA20） / x.ema60s その12本前 / x.above x.below 終値がEMA60の上・下に続いている本数 / x.pdh x.pdl 前日の高値・安値 / x.dayHigh x.dayLow その日のこの足より前の高値・安値 / x.bwRank バンド幅の順位（0=直近100本で一番狭い）
 *  手じまい: 日足は close（当日の引け）か 3d（3日目の引け）など。5分足は 6本（30分後）か close（その日の引け）
 *  損切り%・利確%: 空欄ならなし。足の中で両方に触れたら損切りが先（厳しめ）。持ち越しで窓を開けたら寄り値で損切り。
 *  コスト: 日足は往復 SW_COST%、5分足は 0.05%。
 * 判定: 日ごとに平均した成績（同じ日に何銘柄も出ても1回と数える）で、t値・前半/後半・基準（同じ対象の全部の日/足）との差を見る。 前半/後半は日足が2024/1で分ける（片方が4分の1未満なら日数の真ん中で分ける）。
 *   ◎ 合格候補 = 20日以上・t≥2・前半も後半もプラス・基準より上 / △ 要観察 = t≥1.5・前後半プラス / × 優位性なし / 件数不足
 */

const EX_HEADER = ['id', 'status', '足', '対象', '条件', '売買', '手じまい', '損切り%', '利確%', 'メモ',
  '回数', '日数', '平均%', '勝率%', '平均R', '基準%', '基準との差%', '前半%', '後半%', 't値', '判定', '実行日時', '前回判定'];
const EX_UNIV = {
  '半導体': ['8035', '6857', '6146', '6920', '4062', '7735', '6723', '6526', '3436', '4063', '6981'],
  // 米国株（売買はしない。日本で見つけた型が別の市場でも効くか＝偶然でないかの確認用）
  '米半導体': ['NVDA', 'AMD', 'MU', 'AVGO', 'TSM', 'INTC', 'QCOM', 'AMAT', 'LRCX', 'KLAC', 'ASML', 'MRVL'],
  '米大型': ['AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'TSLA', 'NVDA', 'JPM', 'XOM', 'UNH', 'COST', 'NFLX'],
  // AI・半導体8銘柄（型11の紙トレードと同じ組。業種で先に決めた）
  'AI半導体': ['6857', '8035', '6920', '6146', '4062', '285A', '5801', '5803'],
  '値がさ': ['9983', '8035', '6857', '9984', '6367', '4543', '6954', '9433', '6762', '4063', '6098', '6971'],
};
const EX_SEED = [
  ['E001', 'new', '日足', '半導体', 'x.sox >= 3', '売り', 'close', '', '', 'SOX+3%以上の翌朝、半導体を寄りで売り（寄り天？）'],
  ['E002', 'new', '日足', '半導体', 'x.sox <= -3', '買い', 'close', '', '', 'SOX-3%以下の翌朝、半導体を寄りで買い（寄り底？）'],
  ['E003', 'new', '日足', '108', 'x.ret1 <= -10', '買い', 'close', '', '', '大型株の-10%急落の翌日、寄り買い→引け'],
  ['E004', 'new', '日足', '108', 'x.ret1 <= -10 && x.tRet1 > -3', '買い', '3d', '', '', '個別の-10%急落（全面安でない）→3日'],
  ['E005', 'new', '日足', '値がさ', 'x.nt >= 1', '売り', 'close', '', '', '日経の窓がTOPIXより+1%以上大きい朝、値がさ株を寄り売り'],
  ['E006', 'new', '日足', '値がさ', 'x.nt <= -1', '買い', 'close', '', '', '日経の窓がTOPIXより-1%以上小さい朝、値がさ株を寄り買い'],
  ['E007', 'new', '5分足', '注力', "x.hm < '09:30' && x.p && x.p.ma5 >= x.p.ma25 && x.ma5 < x.ma25", '売り', '6本', '0.8', '1.0', '朝の5本線25本線下抜け（11/11に+0.27%）を再確認'],
  ['E008', 'new', '日足', '108', 'x.gap >= 8 && x.gap <= 20 && !x.mkt75', '売り', 'close', '2', '4', 'G7の再現（基準の確認用）'],
  // 11/11 ユーザーが共有した4つの鉄則（急騰急落の逆張り禁止・抜けでなく戻り・水平線・収束）を数字で確かめる
  ['E009', 'new', '5分足', '注力', 'x.fromOpen >= 3 && x.rsi >= 85', '売り', '6本', '0.5', '1.0', '鉄則1の確認: 急騰中（始値+3%・RSI85）の逆張り売りは負けるか'],
  ['E010', 'new', '5分足', '注力', 'x.pdh && x.p && x.p.c <= x.pdh && x.c > x.pdh', '買い', '6本', '0.5', '1.0', '鉄則2の比較用: 前日高値を抜けた瞬間に買う'],
  ['E011', 'new', '5分足', '注力', 'x.pdh && x.dayHigh > x.pdh * 1.003 && x.l <= x.pdh * 1.001 && x.c > x.pdh', '買い', '6本', '0.5', '1.0', '鉄則2・3: 前日高値を抜けた後、戻ってきて支えられたら買う'],
  ['E012', 'new', '5分足', '注力', 'x.p && x.p.bwRank <= 0.1 && x.p.c <= x.p.up && x.c > x.up', '買い', '6本', '0.5', '1.5', '鉄則4: バンドが一番狭い所（収束）から上に抜けたら買う'],
  ['E013', 'new', '5分足', '注力', 'x.p && x.p.bwRank <= 0.1 && x.p.c >= x.p.dn && x.c < x.dn', '売り', '6本', '0.5', '1.5', '鉄則4: 収束から下に抜けたら売る'],
];

function setupExperiments() {
  const sh = sheet_('experiments', EX_HEADER);
  const have = new Set(sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(r => String(r[0])) : []);
  const add = EX_SEED.filter(r => !have.has(r[0]));
  if (add.length) sh.getRange(sh.getLastRow() + 1, 1, add.length, add[0].length).setValues(add);
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'runExperiments').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runExperiments').timeBased().everyDays(1).atHour(20).nearMinute(30).inTimezone('Asia/Tokyo').create();
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'recheckExperiments').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('recheckExperiments').timeBased().onMonthDay(1).atHour(19).inTimezone('Asia/Tokyo').create();
  Logger.log(`シート experiments を用意し、毎晩20:30の runExperiments を登録しました（仮説 ${sh.getLastRow() - 1}行）`);
}

function exUniverse_(s) {
  const one = t => {
    if (t === '108') return SW_CODES.slice();
    if (EX_UNIV[t]) return EX_UNIV[t].slice();
    if (t === '注力') return Object.keys(typeof KUSE_CODES !== 'undefined' ? KUSE_CODES : { '6857': '' });
    return /^[0-9][0-9A-Z]{3}$/.test(t) || /^[A-Z][A-Z.\-]{0,5}$/.test(t) ? [t] : [];
  };
  const out = [];
  String(s || '').trim().split(/[,、\s]+/).forEach(t => one(t).forEach(c => { if (out.indexOf(c) < 0) out.push(c); }));
  return out; // 「米半導体,米大型」のようにまとめても重複は1回
}
/** 日本株（4桁）は .T を付ける。米国株（英字）はそのまま */
const exUS_ = c => !/^[0-9]/.test(c);
const exSym_ = c => exUS_(c) ? c : c + '.T';

/** 5分足。日本株は指標検証.gs の indFetch_、米国株はニューヨーク時間 9:30〜16:00 の足（夏時間も自動） */
function exFetch5m_(c) {
  if (!exUS_(c)) return indFetch_(c);
  const r = UrlFetchApp.fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(c)}?range=60d&interval=5m`, { headers: UA, muteHttpExceptions: true });
  let res; try { res = JSON.parse(r.getContentText()).chart.result; } catch (e) { return []; }
  if (!res || !res[0].timestamp) return [];
  const q = res[0].indicators.quote[0], out = [];
  res[0].timestamp.forEach((ts, i) => {
    if (q.open[i] == null || q.close[i] == null || q.high[i] == null || q.low[i] == null) return;
    const t = Utilities.formatDate(new Date(ts * 1000), 'America/New_York', 'yyyyMMdd HH:mm'), hm = t.slice(9);
    if (hm < '09:30' || hm >= '16:00') return;
    out.push({ d: t.slice(0, 8), hm, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 });
  });
  return out;
}

/** Yahooの日足を取る（20件ずつ・失敗したら少し待って1回だけ取り直す）。取れた分は cache.D にためて使い回す */
function exFetchDaily_(syms, cache) {
  const need = syms.filter(s => !(s in cache.D));
  for (let s = 0; s < need.length; s += 15) {
    const chunk = need.slice(s, s + 15);
    const req = c => ({ url: `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(c)}?range=6y&interval=1d`, headers: UA, muteHttpExceptions: true });
    let rs = UrlFetchApp.fetchAll(chunk.map(req));
    const bad = chunk.filter((c, j) => rs[j].getResponseCode() !== 200);
    if (bad.length) {
      Logger.log(`取得失敗 ${bad.length}件（${rs.find(r => r.getResponseCode() !== 200).getResponseCode()}）→ 10秒待って取り直し`);
      Utilities.sleep(10000);
      const rs2 = UrlFetchApp.fetchAll(bad.map(req));
      rs = rs.map((r, j) => { const k = bad.indexOf(chunk[j]); return k >= 0 ? rs2[k] : r; });
    }
    rs.forEach((r, j) => { const b = r.getResponseCode() === 200 ? swParse_(r.getContentText()) : null; cache.D[chunk[j]] = b && b.length > 60 ? b : null; });
    Utilities.sleep(800);
  }
}

/** 日経VI（日本の恐怖指数）の日足。Yahooにないので日経の公式CSVから取る。取れなければ null（ログに理由） */
const NVI_URL = 'https://indexes.nikkei.co.jp/nkave/historical/nikkei_stock_average_vi_daily_jp.csv';
function exFetchNVI_(cache) {
  if ('NVI' in cache.D) return;
  cache.D.NVI = null;
  try {
    const r = UrlFetchApp.fetch(NVI_URL, { headers: UA, muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) { Logger.log(`日経VI 取得失敗 ${r.getResponseCode()}`); return; }
    const out = [];
    r.getContentText('Shift_JIS').split(/\r?\n/).forEach(line => {
      const f = line.split(',').map(x => x.replace(/"/g, '').trim());
      const m = (f[0] || '').match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/), c = parseFloat(f[1]);
      if (m && isFinite(c)) out.push({ d: m[1] + m[2].padStart(2, '0') + m[3].padStart(2, '0'), c });
    });
    out.sort((a, b) => a.d < b.d ? -1 : 1);
    cache.D.NVI = out.length > 60 ? out : null;
    Logger.log(`日経VI ${out.length}日分（${out.length ? out[0].d + '〜' + out[out.length - 1].d : 'なし'}）`);
  } catch (e) { Logger.log(`日経VI 取得エラー ${e}`); }
}

/** 日経VIが取れるかの確認用（1回実行してログを見る） */
function testNVI() { const c = { D: {} }; exFetchNVI_(c); if (c.D.NVI) Logger.log(JSON.stringify(c.D.NVI.slice(-3))); }

/** 信用評価損益率（二市場・週次、買い方）。トレーダーズ・ウェブの「信用残の推移」から全ページ取る。取れなければ null
 *  申込日（金曜）の値は翌週の第3営業日の夕方に出るので、申込日+6日（翌週木曜）から使う */
function exFetchMPL_(cache) {
  if ('MPL' in cache.D) return;
  cache.D.MPL = null;
  const out = {};
  for (let pg = 1; pg <= 20; pg++) {
    let r;
    try { r = UrlFetchApp.fetch(`https://www.traders.co.jp/margin_derivatives/margin_transition/${pg}`, { headers: UA, muteHttpExceptions: true }); }
    catch (e) { Logger.log(`信用評価損益率 ${pg}ページ目 取得エラー ${e}`); break; }
    if (r.getResponseCode() !== 200) { if (pg === 1) Logger.log(`信用評価損益率 取得失敗 ${r.getResponseCode()}`); break; }
    const text = r.getContentText().replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
    const parts = text.split(/(\d{4}\/\d{2}\/\d{2})/);
    let found = 0;
    for (let k = 1; k + 1 < parts.length; k += 2) {
      const nums = (parts[k + 1].match(/[-+]?\d[\d,]*\.?\d*/g) || []).map(x => parseFloat(x.replace(/,/g, ''))).filter(isFinite);
      if (nums.length < 10) continue;
      // 並び: 売り株数・前週比・売り金額・前週比・買い株数・前週比・買い金額・前週比・評価損益率・信用倍率
      const pl = nums[8], ratio = nums[9];
      if (pl < -60 || pl > 30 || !(nums[2] > 0) || Math.abs(nums[6] / nums[2] / ratio - 1) > 0.05) continue; // 倍率=買い金額÷売り金額で並びを確かめる
      out[parts[k].replace(/\//g, '')] = pl; found++;
    }
    if (!found) break;
    Utilities.sleep(500);
  }
  const arr = Object.keys(out).sort().map(d => ({ d, c: out[d] }));
  cache.D.MPL = arr.length > 20 ? arr : null;
  Logger.log(`信用評価損益率 ${arr.length}週分（${arr.length ? arr[0].d + '〜' + arr[arr.length - 1].d + ' 最新' + arr[arr.length - 1].c + '%' : 'なし'}）`);
}

/** 信用評価損益率が取れるかの確認用（1回実行してログを見る） */
function testMPL() { const c = { D: {} }; exFetchMPL_(c); if (c.D.MPL) Logger.log(JSON.stringify(c.D.MPL.slice(-4))); }

/** 日足の材料（対象の銘柄＋市場の指標）。1回の実行の中で使い回す */
function exDailyData_(codes, cache) {
  cache.D = cache.D || {};
  exFetchDaily_(['^SOX', '^VIX', '1306.T', '1321.T', ...codes.map(exSym_)], cache);
  exFetchNVI_(cache);
  exFetchMPL_(cache);
  if (cache.mkt) return;
  const mkt = {}; // 日付 -> {tGap, tRet1, mkt75, nt, sox}
  const tp = cache.D['1306.T'], nk = cache.D['1321.T'], sx = cache.D['^SOX'], vx = cache.D['^VIX'], nv = cache.D.NVI, mp = cache.D.MPL;
  if (tp) {
    const nIdx = {}; if (nk) nk.forEach((x, i) => nIdx[x.d] = i);
    for (let i = 2; i < tp.length; i++) {
      const m75 = i >= 76 ? tp.slice(i - 76, i - 1).reduce((s, y) => s + y.c, 0) / 75 : null;
      const k = nIdx[tp[i].d], tGap = (tp[i].o / tp[i - 1].c - 1) * 100;
      mkt[tp[i].d] = { tGap, tRet1: (tp[i - 1].c / tp[i - 2].c - 1) * 100, mkt75: m75 != null ? tp[i - 1].c > m75 : null,
        nt: k > 0 ? (nk[k].o / nk[k - 1].c - 1) * 100 - tGap : null, sox: null, nkUp: null, nkRet5: null };
      if (k > 5) { // 日経ETFの前日までの連騰日数と5日騰落%
        let u = 0; for (let j = k - 1; j > 0 && nk[j].c > nk[j - 1].c; j--) u++;
        mkt[tp[i].d].nkUp = u; mkt[tp[i].d].nkRet5 = (nk[k - 1].c / nk[k - 6].c - 1) * 100;
      }
    }
    if (sx) { // 東京の日付 d の前夜 = d より前の最後の米国の営業日
      let j = 0; const ds = Object.keys(mkt).sort();
      ds.forEach(d => { while (j + 1 < sx.length && sx[j + 1].d < d) j++; if (j > 0 && sx[j].d < d) {
        mkt[d].sox = (sx[j].c / sx[j - 1].c - 1) * 100;
        // 前夜のSOXが75日線の上か（半導体がリスクオンの局面かどうかの目安）
        if (j >= 74) { let s = 0; for (let t = j - 74; t <= j; t++) s += sx[t].c; mkt[d].soxUp75 = sx[j].c > s / 75; }
      } });
    }
    if (vx) { // 恐怖指数VIX: 東京の日付 d の前夜の終値・前日比%・過去1年(252日)の中での位置(0=一番低い〜1=一番高い)
      let j = 0; const ds = Object.keys(mkt).sort();
      ds.forEach(d => {
        while (j + 1 < vx.length && vx[j + 1].d < d) j++;
        if (j > 0 && vx[j].d < d) {
          const m = mkt[d]; m.vix = vx[j].c; m.vixChg = (vx[j].c / vx[j - 1].c - 1) * 100;
          if (j >= 252) { let k = 0; for (let t = j - 252; t < j; t++) if (vx[t].c < vx[j].c) k++; m.vixPct = k / 252; }
        }
      });
    }
    if (nv) { // 日経VI: 東京の日付 d の前日（東京の前営業日）の終値・前日比%・過去1年(245日)の中での位置
      let j = 0; const ds = Object.keys(mkt).sort();
      ds.forEach(d => {
        while (j + 1 < nv.length && nv[j + 1].d < d) j++;
        if (j > 0 && nv[j].d < d) {
          const m = mkt[d]; m.nvi = nv[j].c; m.nviChg = (nv[j].c / nv[j - 1].c - 1) * 100;
          if (j >= 245) { let k = 0; for (let t = j - 245; t < j; t++) if (nv[t].c < nv[j].c) k++; m.nviPct = k / 245; }
        }
      });
    }
    if (mp) { // 信用評価損益率: 東京の日付 d の時点で公表済みの最新週（申込日+6日 <= d）とその前週差
      const ds = Object.keys(mkt).sort(); let j = -1;
      const avail = x => { const t = new Date(`${x.slice(0, 4)}-${x.slice(4, 6)}-${x.slice(6, 8)}T12:00:00+09:00`); t.setDate(t.getDate() + 6); return Utilities.formatDate(t, 'Asia/Tokyo', 'yyyyMMdd'); };
      const av = mp.map(x => avail(x.d));
      ds.forEach(d => {
        while (j + 1 < mp.length && av[j + 1] <= d) j++;
        if (j >= 0) { mkt[d].mpl = mp[j].c; mkt[d].mplChg = j > 0 ? mp[j].c - mp[j - 1].c : null; }
      });
    }
  }
  cache.mkt = mkt;
}

/** 銘柄ごとの指標を先に1回だけ計算しておく（毎回計算すると遅いため）。値は「その日の前日の引けまで」で揃える */
function exPrep_(b) {
  const n = b.length, cs = [0], vs = [0];
  b.forEach((x, i) => { cs.push(cs[i] + x.c); vs.push(vs[i] + x.v); });
  const sumC = (from, to) => cs[to] - cs[from], sumV = (from, to) => vs[to] - vs[from]; // [from, to)
  const P = { ma25: [], ma200: [], vol20: [], rsi: [], hi52: [] };
  let ag = 0, al = 0, dq = []; // RSI14（Wilder）、52週高値は単調キューで
  for (let i = 0; i < n; i++) {
    P.ma25[i] = i >= 25 ? sumC(i - 25, i) / 25 : null;     // 前日までの25本
    P.ma200[i] = i >= 200 ? sumC(i - 200, i) / 200 : null;
    P.vol20[i] = i >= 21 ? sumV(i - 21, i - 1) / 20 : null; // 前々日までの20本の平均（前日の出来高と比べる）
    if (i >= 2) {
      const ch = b[i - 1].c - b[i - 2].c, g = Math.max(ch, 0), l = Math.max(-ch, 0);
      if (i <= 15) { ag += g / 14; al += l / 14; } else { ag = (ag * 13 + g) / 14; al = (al * 13 + l) / 14; }
      P.rsi[i] = i >= 15 ? (al === 0 ? 100 : 100 - 100 / (1 + ag / al)) : null;
    }
    // 前日より前の250本の高値の最大（前日が更新したか）
    if (i >= 2) {
      const k = i - 2;
      while (dq.length && b[dq[dq.length - 1]].h <= b[k].h) dq.pop();
      dq.push(k);
      while (dq[0] < i - 251) dq.shift();
      P.hi52[i] = b[i - 1].h >= b[dq[0]].h;
    }
  }
  return P;
}

function exDailyCtx_(b, i, code, mkt, P) {
  const p = b[i - 1], d = b[i].d;
  const dt = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T12:00:00+09:00`);
  const m = mkt[d] || {};
  return { gap: (b[i].o / p.c - 1) * 100, ret1: (p.c / b[i - 2].c - 1) * 100, ret5: (p.c / b[i - 6].c - 1) * 100,
    ret20: (p.c / b[i - 21].c - 1) * 100, dev25: P.ma25[i] ? (p.c / P.ma25[i] - 1) * 100 : null,
    above200: P.ma200[i] ? p.c > P.ma200[i] : null, rsi: P.rsi[i], vol: P.vol20[i] ? p.v / P.vol20[i] : null, hi52: P.hi52[i],
    sox: m.sox, vix: m.vix, vixChg: m.vixChg, vixPct: m.vixPct, nvi: m.nvi, nviChg: m.nviChg, nviPct: m.nviPct, mpl: m.mpl, mplChg: m.mplChg, tGap: m.tGap, tRet1: m.tRet1, mkt75: m.mkt75, nt: m.nt, nkUp: m.nkUp, nkRet5: m.nkRet5,
    soxUp75: m.soxUp75 == null ? null : m.soxUp75, ...exWeek_(b, i),
    dow: dt.getDay(), month: dt.getMonth() + 1, day: dt.getDate(), code, price: b[i].o,
    // k営業日前の日の様子（「暴落は三日待て」用）: その日の窓%・VIX/日経VIの位置、その日の寄り→昨日の引けの騰落%
    ago: k => { const j = i - k; if (j < 1) return {}; const mj = mkt[b[j].d] || {};
      return { gap: (b[j].o / b[j - 1].c - 1) * 100, vixPct: mj.vixPct, nviPct: mj.nviPct, ret: (p.c / b[j].o - 1) * 100 }; } };
}

/** 今週（月曜始まり）のその日より前の様子: wkDays 今週すでに終わった営業日数 / wk 今週最初の日の寄り→前日の引け% /
 *  wkMin 今週すでに終わった日の中で一番悪い日の騰落%（前日終値比）。週の最初の日は wkDays=0・wk と wkMin は null */
function exWeek_(b, i) {
  const toDate = d => new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T12:00:00+09:00`);
  const t = toDate(b[i].d), mon = new Date(t); mon.setDate(t.getDate() - ((t.getDay() + 6) % 7));
  const monStr = Utilities.formatDate(mon, 'Asia/Tokyo', 'yyyyMMdd');
  let j = i; while (j - 1 >= 1 && b[j - 1].d >= monStr) j--; // j = 今週の最初の営業日
  if (j === i) return { wkDays: 0, wk: null, wkMin: null };
  let mn = Infinity; for (let k = j; k < i; k++) mn = Math.min(mn, (b[k].c / b[k - 1].c - 1) * 100);
  return { wkDays: i - j, wk: (b[i - 1].c / b[j].o - 1) * 100, wkMin: mn };
}

/** 1回の売買の損益%（コスト込み）。path = [[o,h,l,c], ...] 入った後の足、entry = 入値 */
function exTrade_(side, entry, path, stop, tp, cost) {
  const sP = stop ? entry * (1 - side * stop / 100) : null, tP = tp ? entry * (1 + side * tp / 100) : null;
  let exit = path.length ? path[path.length - 1][3] : entry;
  for (let k = 0; k < path.length; k++) {
    const [o, h, l] = path[k];
    if (k > 0 && sP && (side > 0 ? o <= sP : o >= sP)) { exit = o; break; }      // 持ち越しの窓で損切りを越えた
    if (sP && (side > 0 ? l <= sP : h >= sP)) { exit = sP; break; }
    if (tP && (side > 0 ? h >= tP : l <= tP)) { exit = tP; break; }
  }
  return side * (exit / entry - 1) * 100 - cost;
}

function exStats_(trades, baseAvg, split) {
  const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
  const byDay = {}; trades.forEach(t => (byDay[t.d] = byDay[t.d] || []).push(t.r));
  const days = Object.keys(byDay).sort().map(d => ({ d, r: avg(byDay[d]) }));
  const m = avg(days.map(x => x.r)), n = days.length;
  const sd = n > 1 ? Math.sqrt(days.reduce((s, x) => s + (x.r - m) * (x.r - m), 0) / (n - 1)) : 0;
  const t = sd > 0 ? m / (sd / Math.sqrt(n)) : 0;
  const mid = days.length ? days[Math.floor(days.length / 2)].d : '';
  // 決めた日付で分けると片方が全体の4分の1未満になるとき（日経VIのようにデータが短い）は、日数の真ん中で分ける
  const early = split ? days.filter(x => x.d < split).length : 0;
  const cut = split && early >= n / 4 && n - early >= n / 4 ? split : mid;
  const e = avg(days.filter(x => x.d < cut).map(x => x.r)), l = avg(days.filter(x => x.d >= cut).map(x => x.r));
  const all = avg(trades.map(x => x.r)), win = trades.length ? trades.filter(x => x.r > 0).length / trades.length * 100 : 0;
  let judge = '× 優位性なし';
  if (n < 20) judge = '件数不足';
  else if (t >= 2 && e > 0 && l > 0 && (baseAvg == null || m > baseAvg)) judge = '◎ 合格候補';
  else if (t >= 1.5 && e > 0 && l > 0) judge = '△ 要観察';
  return { n: trades.length, days: n, avg: all, dayAvg: m, win, t, e, l, judge };
}

function exRunDaily_(row, cache) {
  const codes = exUniverse_(row.univ);
  exDailyData_(codes, cache);
  const missing = codes.filter(c => !cache.D[exSym_(c)]);
  if (missing.length && missing.length === codes.length) throw new Error('対象の株価が取れません');
  const f = new Function('x', `return (${row.cond});`);
  const side = row.side, hold = row.exit === 'close' ? 1 : Number(String(row.exit).replace(/[^0-9]/g, '')) || 1;
  const trades = [], base = [];
  codes.forEach(c => {
    const b = cache.D[exSym_(c)]; if (!b) return;
    cache.P = cache.P || {};
    const P = cache.P[c] = cache.P[c] || exPrep_(b);
    for (let i = 22; i + hold - 1 < b.length; i++) {
      const path = b.slice(i, i + hold).map(y => [y.o, y.h, y.l, y.c]);
      const r = exTrade_(side, b[i].o, path, row.stop, row.tp, SW_COST);
      base.push({ d: b[i].d, r });
      let hit = false;
      try { hit = !!f(exDailyCtx_(b, i, c, exUS_(c) ? {} : cache.mkt, P)); } catch (e) { throw new Error('条件の式でエラー: ' + e.message); }
      if (hit) trades.push({ d: b[i].d, r });
    }
  });
  const baseAvg = base.length ? base.reduce((s, x) => s + x.r, 0) / base.length : null;
  return Object.assign(exStats_(trades, baseAvg, '20240101'), { base: baseAvg });
}

/** 5分足に、前日の高値・安値、その日のそれまでの高値・安値、バンド幅の順位（直近100本の中で何番目に狭いか 0〜1）を足す */
function exPrep5m_(b) {
  let day = null, pdh = null, pdl = null, dh = null, dl = null, curH = null, curL = null;
  for (let i = 0; i < b.length; i++) {
    const x = b[i];
    if (x.d !== day) { if (day) { pdh = curH; pdl = curL; } day = x.d; curH = x.h; curL = x.l; dh = null; dl = null; }
    x.pdh = pdh; x.pdl = pdl; x.dayHigh = dh; x.dayLow = dl; // この足より前の、その日の高値・安値
    curH = Math.max(curH, x.h); curL = Math.min(curL, x.l); dh = curH; dl = curL;
    if (x.bw != null && i >= 100) { let k = 0; for (let j = i - 100; j < i; j++) if (b[j].bw != null && b[j].bw < x.bw) k++; x.bwRank = k / 100; }
    // EMA60（5分足60本＝15分足のEMA20とほぼ同じ）、その12本前（傾き）、終値がEMAの上/下に何本続いているか
    const k = 2 / 61; x.ema60 = i === 0 ? x.c : b[i - 1].ema60 + k * (x.c - b[i - 1].ema60);
    x.ema60s = i >= 12 ? b[i - 12].ema60 : null;
    x.above = x.c > x.ema60 ? (i ? b[i - 1].above : 0) + 1 : 0;
    x.below = x.c < x.ema60 ? (i ? b[i - 1].below : 0) + 1 : 0;
  }
}

function exRun5m_(row, cache) {
  const codes = exUniverse_(row.univ);
  cache.m5 = cache.m5 || {};
  codes.forEach(c => { if (!cache.m5[c]) { const b = exFetch5m_(c); if (b.length > 100) { indCalc_(b); exPrep5m_(b); cache.m5[c] = b; } } });
  const f = new Function('x', `return (${row.cond});`);
  const side = row.side, nBars = row.exit === 'close' ? 9999 : Number(String(row.exit).replace(/[^0-9]/g, '')) || 6;
  const trades = [], base = [];
  codes.forEach(c => {
    const b = cache.m5[c]; if (!b) return;
    let last = -2;
    for (let i = 30; i < b.length; i++) {
      const x = b[i];
      if (x.rsi == null || x.ma25 == null || x.up == null || i >= x.end) continue;
      const path = b.slice(i + 1, Math.min(i + nBars, x.end) + 1).map(y => [y.o, y.h, y.l, y.c]);
      const r = exTrade_(side, x.c, path, row.stop, row.tp, 0.05);
      base.push({ d: x.d, r });
      const ctx = Object.assign({}, x, { p: b[i - 1].d === x.d ? b[i - 1] : null, bw6: b[i - 6] ? b[i - 6].bw : null,
        dayRet: x.pc ? (x.c / x.pc - 1) * 100 : null, fromOpen: (x.c / x.dayOpen - 1) * 100, code: c, us: exUS_(c),
        min: (+x.hm.slice(0, 2)) * 60 + (+x.hm.slice(3)) - (exUS_(c) ? 570 : 540) });
      let hit = false;
      try { hit = !!f(ctx); } catch (e) { throw new Error('条件の式でエラー: ' + e.message); }
      if (hit) { if (last !== i - 1) trades.push({ d: x.d, r }); last = i; }
    }
  });
  const baseAvg = base.length ? base.reduce((s, x) => s + x.r, 0) / base.length : null;
  return Object.assign(exStats_(trades, baseAvg, null), { base: baseAvg });
}

function runExperiments() {
  const t0 = Date.now(), sh = sheet_('experiments', EX_HEADER);
  const vals = sh.getDataRange().getValues(), cache = {}, done = [];
  const r2 = v => v == null || v === '' || isNaN(v) ? '' : Math.round(v * 100) / 100;
  for (let k = 1; k < vals.length; k++) {
    const v = vals[k];
    if (String(v[1]).trim() !== 'new') continue;
    if (Date.now() - t0 > 270000) { Logger.log('時間切れ。残りは次の実行で'); break; }
    const row = { id: v[0], tf: String(v[2]).trim(), univ: v[3], cond: String(v[4]), side: String(v[5]).indexOf('売') >= 0 ? -1 : 1,
      exit: String(v[6] || 'close').trim(), stop: Number(v[7]) || null, tp: Number(v[8]) || null };
    const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
    try {
      const s = row.tf.indexOf('5') >= 0 ? exRun5m_(row, cache) : exRunDaily_(row, cache);
      const R = row.stop ? r2(s.avg / row.stop) : '';
      sh.getRange(k + 1, 2).setValue('done');
      sh.getRange(k + 1, 11, 1, 12).setValues([[s.n, s.days, r2(s.avg), Math.round(s.win), R, r2(s.base), s.dayAvg == null || s.base == null ? '' : r2(s.dayAvg - s.base),
        r2(s.e), r2(s.l), r2(s.t), s.judge, now]]);
      const prev = String(v[22] || '');
      const warn = prev && prev.indexOf('×') < 0 && s.judge.indexOf('×') >= 0 ? '⬇ 効きが落ちた ' : '';
      done.push(`${warn}［${s.judge}］${row.id} ${v[9] || row.cond}: ${s.days}日 平均${r2(s.dayAvg)}%（基準${r2(s.base)}） t=${r2(s.t)} 前半${r2(s.e)}/後半${r2(s.l)}`);
    } catch (e) {
      sh.getRange(k + 1, 2).setValue('error');
      sh.getRange(k + 1, 21, 1, 2).setValues([[String(e.message).slice(0, 200), now]]);
      done.push(`⚠ ${row.id}: ${e.message}`);
    }
  }
  if (!done.length) { Logger.log('新しい仮説（status=new）はありません'); return; }
  done.forEach(s => Logger.log(s));
  try { postDiscord_({ embeds: [{ title: `🧪 夜の検証 ${done.length}件`, description: done.join('\n').slice(0, 4000), color: 0x8B5CF6 }] }); }
  catch (e) { Logger.log('Discord送信に失敗: ' + e); }
}

/** 毎月1日19時: 合格候補・要観察（◎/△）の行と、メモに「使用中」と書いた行を new に戻して、その夜もう一度検証する。
 *  前の判定は「前回判定」列に残し、◎/△ から × に落ちたら Discord に「⬇ 効きが落ちた」と出す（市場が変わって効かなくなった型を早く見つける）。
 *  5分足の行は毎回「直近60日」で測り直すので、最近の相場で効いているかの確認になる。 */
function recheckExperiments() {
  const sh = sheet_('experiments', EX_HEADER);
  sh.getRange(1, 1, 1, EX_HEADER.length).setValues([EX_HEADER]);
  const vals = sh.getDataRange().getValues();
  let n = 0;
  for (let k = 1; k < vals.length; k++) {
    const v = vals[k], judge = String(v[20] || ''), keep = String(v[9] || '').indexOf('使用中') >= 0;
    if (String(v[1]).trim() !== 'done' || !(keep || judge.indexOf('◎') >= 0 || judge.indexOf('△') >= 0)) continue;
    sh.getRange(k + 1, 23).setValue(judge);
    sh.getRange(k + 1, 2).setValue('new');
    n++;
  }
  Logger.log(`月次の見直し: ${n}行を new に戻しました（今夜20:30に再検証）`);
}
