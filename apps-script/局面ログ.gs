/**
 * 毎朝の局面ログ（Google Apps Script版）
 * IR通知.gs・地合い.gs・検証エンジン.gs・答え合わせ.gs と同じプロジェクトに「ファイル ＋ → スクリプト」で追加して使う。
 * 初回だけ「setupKyokumen」を実行 → 平日 8:10（局面ログ）と 16:15（その日の答え合わせ）に自動で動きます。
 * 試すときは「testKyokumen」（シートにもDiscordにも出さず、実行ログにだけ出す）。
 *
 * 1日1行、シート kyokumen に残す。目的は「マクロの層」を数字で記録して、2〜3か月後に
 * 「この局面の日だけ型（G7・H2・E040など）を使うと成績が上がるか」を検証すること。売買の推奨はしない。
 *   1層目 数字の層（機械）: 前夜のSOX・75日線、VIXと日経VIの過去1年での位置、ドル円、CMEの日経先物の窓、
 *                          TOPIX ETF の75日線、信用評価損益率 → 機械のラベル（リスクオン／リスクオフ／恐怖／油断）
 *   2層目 討論の層（AI）: 強気役・弱気役（ニュース＋数字）と数字役（数字だけ）が別々に判断 → まとめ役がラベルと自信の点数
 *   答え合わせ（16:15）: その日の TOPIX ETF・日経ETF・AI半導体8銘柄の寄り→引けを同じ行に書き足す
 *
 * 使うスクリプトのプロパティ（IR通知と共通）: ANTHROPIC_API_KEY、SECTOR_WEBHOOK_URL または DISCORD_WEBHOOK_URL
 * 任意: KYOKUMEN_WEBHOOK_URL（局面専用のDiscordチャンネル。あれば朝の地合いとは別のチャンネルに送る）
 * 任意: DEBATE_MODEL（3役のモデル、既定 claude-sonnet-5-5）、JUDGE_MODEL（まとめ役、既定 FINAL_MODEL か claude-opus-5-5）
 */

const KL_HEADER = ['date', '機械ラベル', 'SOX%', 'SOX75日線の上', 'VIX', 'VIX位置', '日経VI', '日経VI位置', 'ドル円%', 'CME窓%',
  'TOPIX75日線の上', '信用評価損益率', 'ニュース件数',
  '強気役_点', '強気役_ラベル', '弱気役_点', '弱気役_ラベル', '数字役_点', '数字役_ラベル',
  'まとめ_ラベル', 'まとめ_自信', 'まとめ_点', '勝った側', 'テーマ', '一言', '費用円',
  '答え_TOPIX寄り引け%', '答え_日経寄り引け%', '答え_AI半導体寄り引け%', '答え_向き一致'];
const KL_LABELS = ['リスクオン', 'リスクオフ', '恐怖', '油断'];
const KL_AI8 = ['6857', '8035', '6920', '6146', '4062', '285A', '5801', '5803'];
const KL_NEWS_Q = ['日経平均 OR 東証', '半導体 株価', '米国株 OR ナスダック OR ダウ', '円相場 OR 日銀 OR FRB', '地政学 OR 関税'];

function setupKyokumen() {
  ScriptApp.getProjectTriggers().filter(t => ['kyokumen', 'kyokumenReview'].includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('kyokumen').timeBased().everyDays(1).atHour(8).nearMinute(10).inTimezone('Asia/Tokyo').create();
  ScriptApp.newTrigger('kyokumenReview').timeBased().everyDays(1).atHour(16).nearMinute(15).inTimezone('Asia/Tokyo').create();
  sheet_('kyokumen', KL_HEADER);
  Logger.log('毎朝8:10の局面ログと、16:15の答え合わせを登録しました');
}

function testKyokumen() { kyokumen_(true); }
function kyokumen() { kyokumen_(false); }

// ---------- 1層目: 数字 ----------

/** 過去 n 日の中で、最新の値より低い日の割合（0=一番低い〜1=一番高い） */
function klPct_(arr, n) {
  if (!arr || arr.length < n + 1) return '';
  const last = arr[arr.length - 1].c;
  let k = 0;
  for (let i = arr.length - 1 - n; i < arr.length - 1; i++) if (arr[i].c < last) k++;
  return Math.round(k / n * 100) / 100;
}

function klNumbers_() {
  const x = {};
  const sox = daily_('^SOX', '6mo');
  x.sox = chg_(sox, 1);
  x.soxUp75 = sox.length >= 75 ? sox[sox.length - 1].c > sox.slice(-75).reduce((s, b) => s + b.c, 0) / 75 : '';
  const vix = daily_('^VIX', '2y');
  x.vix = vix.length ? Math.round(vix[vix.length - 1].c * 10) / 10 : '';
  x.vixPct = klPct_(vix, 252);
  const c = { D: {} };
  exFetchNVI_(c);
  const nv = c.D.NVI;
  x.nvi = nv ? nv[nv.length - 1].c : '';
  x.nviPct = nv ? klPct_(nv, 245) : '';
  x.usdjpy = chg_(daily_('JPY=X', '1mo'), 1);
  // CMEの日経先物と日経平均の終値の差（地合い.gs と同じ求め方）
  const fut = daily_('NIY=F', '1mo');
  let nk = daily_('^N225', '1mo');
  let nkClose = nk.length ? nk[nk.length - 1].c : '';
  try {
    const m = JSON.parse(UrlFetchApp.fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EN225?range=5d&interval=1d',
      { headers: UA, muteHttpExceptions: true }).getContentText()).chart.result[0].meta;
    if (m.regularMarketPrice) nkClose = m.regularMarketPrice;
  } catch (e) { Logger.log('日経終値(meta): ' + e); }
  x.cmeGap = fut.length && nkClose ? Math.round((fut[fut.length - 1].c / nkClose - 1) * 10000) / 100 : '';
  const tp = splitAdj_(daily_('1306.T', '6mo'));
  x.topixUp75 = tp.length >= 75 ? tp[tp.length - 1].c > tp.slice(-75).reduce((s, b) => s + b.c, 0) / 75 : '';
  try { exFetchMPL_(c); x.mpl = c.D.MPL ? c.D.MPL[c.D.MPL.length - 1].c : ''; } catch (e) { x.mpl = ''; }
  // 機械のラベル: 恐怖を先に見る（E040 の条件と同じ「過去1年の上位10%」）
  const hi = v => v !== '' && v >= 0.9, lo = v => v !== '' && v <= 0.1;
  x.label = (hi(x.nviPct) || hi(x.vixPct) || (x.cmeGap !== '' && x.cmeGap <= -2)) ? '恐怖'
    : (lo(x.vixPct) && x.soxUp75 === true) ? '油断'
    : (x.soxUp75 === true && (x.cmeGap === '' || x.cmeGap > -1)) ? 'リスクオン' : 'リスクオフ';
  return x;
}

function klNumbersText_(x) {
  const s = v => v === '' ? '不明' : (v >= 0 ? '+' : '') + v + '%';
  return `前夜のSOX ${s(x.sox)}（75日線の${x.soxUp75 === '' ? '?' : x.soxUp75 ? '上' : '下'}）\n` +
    `VIX ${x.vix || '不明'}（過去1年の位置 ${x.vixPct === '' ? '不明' : x.vixPct}、0=最低〜1=最高）\n` +
    `日経VI ${x.nvi || '不明'}（過去1年の位置 ${x.nviPct === '' ? '不明' : x.nviPct}）\n` +
    `ドル円 ${s(x.usdjpy)}（プラス＝円安）／CMEの日経先物は日経平均の終値比 ${s(x.cmeGap)}\n` +
    `TOPIX ETF は75日線の${x.topixUp75 === '' ? '?' : x.topixUp75 ? '上' : '下'}／信用評価損益率 ${x.mpl === '' ? '不明' : x.mpl + '%'}（-15%以下で投げが近い）\n` +
    `機械のラベル: ${x.label}`;
}

// ---------- 2層目: ニュース ----------

/** Google ニュースのRSSから、直近18時間の見出しを集める（重複は除く・最大40本） */
function klNews_() {
  const since = Date.now() - 18 * 3600 * 1000, seen = {}, out = [];
  const reqs = KL_NEWS_Q.map(q => ({ url: `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ja&gl=JP&ceid=JP:ja`,
    headers: UA, muteHttpExceptions: true }));
  UrlFetchApp.fetchAll(reqs).forEach((r, k) => {
    if (r.getResponseCode() !== 200) { Logger.log(`ニュース取得失敗 ${KL_NEWS_Q[k]} ${r.getResponseCode()}`); return; }
    let items = [];
    try { items = XmlService.parse(r.getContentText()).getRootElement().getChild('channel').getChildren('item'); }
    catch (e) { Logger.log(`ニュースの読み取り失敗 ${KL_NEWS_Q[k]}: ${e}`); return; }
    items.forEach(it => {
      const t = it.getChildText('title') || '', d = new Date(it.getChildText('pubDate') || 0).getTime();
      const key = t.replace(/\s+-\s+[^-]+$/, '').slice(0, 40);
      if (!t || d < since || seen[key]) return;
      seen[key] = 1;
      out.push({ d, t: `${Utilities.formatDate(new Date(d), 'Asia/Tokyo', 'MM/dd HH:mm')} ${t}` });
    });
  });
  return out.sort((a, b) => b.d - a.d).slice(0, 40).map(o => o.t);
}

/** 前日15時以降の注目IR（IR通知の calls シート、70点以上） */
function klIR_() {
  try {
    const sh = book_().getSheetByName('calls');
    if (!sh || sh.getLastRow() < 2) return [];
    const n = Math.min(300, sh.getLastRow() - 1), v = sh.getRange(sh.getLastRow() - n + 1, 1, n, 7).getValues();
    const y = Utilities.formatDate(new Date(Date.now() - 4 * 86400000), 'Asia/Tokyo', 'yyyyMMdd');
    return v.filter(r => String(r[1]).replace(/-/g, '') >= y && Number(r[6]) >= 70)
      .slice(-12).map(r => `${r[1]} ${r[2]} ${r[3]} ${r[4]} ${r[5]}（AI採点 ${r[6]}点）`);
  } catch (e) { Logger.log('IRの読み取り: ' + e); return []; }
}

// ---------- 2層目: 討論 ----------

const KL_THEME = {
  type: 'array', items: { type: 'object', additionalProperties: false, required: ['theme', 'wind', 'reason'],
    properties: { theme: { type: 'string' }, wind: { type: 'string', enum: ['追い風', '向かい風', '中立'] }, reason: { type: 'string' } } },
};
const KL_ROLE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['label', 'score', 'reasons', 'themes'],
  properties: {
    label: { type: 'string', enum: KL_LABELS },
    score: { type: 'integer', description: '今日の日本株全体の向き。-100（大きく下げる）〜+100（大きく上げる）' },
    reasons: { type: 'array', items: { type: 'string' }, description: '根拠を3つまで。数字かニュースの見出しを必ず含める' },
    themes: KL_THEME,
  },
};
const KL_JUDGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['label', 'confidence', 'score', 'winner', 'themes', 'one_line'],
  properties: {
    label: { type: 'string', enum: KL_LABELS },
    confidence: { type: 'integer', description: 'ラベルへの自信 0〜100' },
    score: { type: 'integer', description: '今日の日本株全体の向き -100〜+100' },
    winner: { type: 'string', enum: ['強気役', '弱気役', '引き分け'] },
    themes: KL_THEME,
    one_line: { type: 'string', description: '今日の局面を一言（40字以内）' },
  },
};
const KL_COMMON = `あなたは日本株の寄り前（8時台）の局面を判断する担当です。今日の東京市場の寄り前の時点で分かる情報だけを使います。
ラベルは次の4つから1つ: リスクオン（買いが優勢）／リスクオフ（売りが優勢）／恐怖（投げ売りが出る・出た直後）／油断（楽観しすぎ）。
売買の推奨・様子見の推奨はしない（それは別の決め事が担当する）。局面を言い切ることだけが仕事。
書いてない数字を作らない。テーマは半導体・AI、銀行、自動車、内需・ディフェンシブなど、追い風/向かい風がはっきりしたものを3つまで。日本語で簡潔に。`;
const KL_ROLES = [
  { name: '強気役', sys: KL_COMMON + '\nあなたは強気役です。今日上がる理由を探して、一番強い形で主張してください。ただし数字に反することは言わない。', news: true },
  { name: '弱気役', sys: KL_COMMON + '\nあなたは弱気役です。今日下がる理由・危ない点を探して、一番強い形で主張してください。ただし数字に反することは言わない。', news: true },
  { name: '数字役', sys: KL_COMMON + '\nあなたは数字役です。ニュースは見ません。渡された数字だけから、過去の似た局面ならどうなりやすいかで判断してください。', news: false },
];

function klAsk_(model, system, text, schema, tokens) {
  return {
    url: 'https://api.anthropic.com/v1/messages', method: 'post', muteHttpExceptions: true, contentType: 'application/json',
    headers: { 'x-api-key': P.getProperty('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({ model, max_tokens: 8000, system,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: text }] }),
  };
}

function klRead_(r, model, tokens) {
  const body = JSON.parse(r.getContentText());
  if (r.getResponseCode() !== 200) throw new Error(`${r.getResponseCode()} ${body.error ? body.error.message : ''}`);
  tokens[model] = tokens[model] || [0, 0];
  tokens[model][0] += body.usage.input_tokens; tokens[model][1] += body.usage.output_tokens;
  return JSON.parse(body.content.filter(b => b.type === 'text').map(b => b.text).join(''));
}

function klDebate_(numText, news, ir) {
  const tokens = {}, dm = P.getProperty('DEBATE_MODEL') || 'claude-sonnet-5-5';
  const jm = P.getProperty('JUDGE_MODEL') || P.getProperty('FINAL_MODEL') || 'claude-opus-5-5';
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd(E)');
  const newsText = `【前夜〜今朝のニュース見出し】\n${news.join('\n') || 'なし'}\n\n【昨日〜今朝の注目IR（AI採点70点以上）】\n${ir.join('\n') || 'なし'}`;
  const res = UrlFetchApp.fetchAll(KL_ROLES.map(role => klAsk_(dm, role.sys,
    `今日は ${today}。\n【数字】\n${numText}\n\n${role.news ? newsText : ''}`, KL_ROLE_SCHEMA, tokens)));
  const out = {};
  KL_ROLES.forEach((role, k) => {
    try { out[role.name] = klRead_(res[k], dm, tokens); } catch (e) { Logger.log(`${role.name}: ${e}`); out[role.name] = null; }
  });
  const views = KL_ROLES.map(r => `【${r.name}】${out[r.name] ? JSON.stringify(out[r.name]) : '（回答なし）'}`).join('\n');
  try {
    out.まとめ = klRead_(UrlFetchApp.fetchAll([klAsk_(jm,
      KL_COMMON + '\nあなたはまとめ役です。3人の意見を読み、どちらの根拠が数字とニュースに裏付けられているかで判定してください。' +
      '多数決にしない。迷ったら数字役を重く見る。自信が低いなら自信の点数を下げて表す（ラベルを曖昧にしない）。',
      `今日は ${today}。\n【数字】\n${numText}\n\n${views}`, KL_JUDGE_SCHEMA, tokens)])[0], jm, tokens);
  } catch (e) { Logger.log('まとめ役: ' + e); out.まとめ = null; }
  let usd = 0;
  Object.keys(tokens).forEach(m => { const [pi, po] = PRICE[m] || [4, 20]; usd += tokens[m][0] / 1e6 * pi + tokens[m][1] / 1e6 * po; });
  out.yen = Math.round(usd * 150);
  return out;
}

// ---------- 入口 ----------

function kyokumen_(dry) {
  const now = new Date();
  if (!dry && !isTradingDay_(now)) return;
  const today = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMdd');
  const x = klNumbers_(), numText = klNumbersText_(x);
  const news = klNews_(), ir = klIR_();
  Logger.log(numText + `\nニュース ${news.length}本・IR ${ir.length}本`);
  const d = klDebate_(numText, news, ir);
  const g = r => d[r] || {}, j = d.まとめ || {};
  const themes = (j.themes || []).map(t => `${t.wind === '追い風' ? '↑' : t.wind === '向かい風' ? '↓' : '→'}${t.theme}`).join(' ');
  const row = [today, x.label, x.sox, x.soxUp75, x.vix, x.vixPct, x.nvi, x.nviPct, x.usdjpy, x.cmeGap, x.topixUp75, x.mpl, news.length,
    g('強気役').score ?? '', g('強気役').label || '', g('弱気役').score ?? '', g('弱気役').label || '', g('数字役').score ?? '', g('数字役').label || '',
    j.label || '', j.confidence ?? '', j.score ?? '', j.winner || '', themes, j.one_line || '', d.yen];
  const sc = v => v === undefined || v === '' ? '—' : (v > 0 ? '+' : '') + v;
  const desc = `**${j.label || '判定できず'}**（自信 ${j.confidence ?? '—'}・向き ${sc(j.score)}）${j.one_line ? '\n' + j.one_line : ''}\n` +
    `機械のラベル: ${x.label}\n\n` +
    KL_ROLES.map(r => `${r.name} ${sc(g(r.name).score)} ${g(r.name).label || ''}：${(g(r.name).reasons || [])[0] || ''}`).join('\n') +
    `\n勝った側: ${j.winner || '—'}\n` + ((j.themes || []).map(t => `${t.wind === '追い風' ? '📈' : t.wind === '向かい風' ? '📉' : '➖'} ${t.theme}：${t.reason}`).join('\n')) +
    `\n\n※売買の推奨ではありません。型（G7・H2など）の決め事はそのまま。費用 約${d.yen}円`;
  Logger.log(desc);
  if (dry) return;
  const sh = sheet_('kyokumen', KL_HEADER);
  const last = sh.getLastRow();
  if (last >= 2 && String(sh.getRange(last, 1).getValue()) === today) sh.getRange(last, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
  const payload = { embeds: [{ title: `🧭 今日の局面 ${Utilities.formatDate(now, 'Asia/Tokyo', 'MM/dd')}`, description: desc.slice(0, 4000), color: 0x6366F1 }] };
  const url = P.getProperty('KYOKUMEN_WEBHOOK_URL');
  if (!url) { postDiscordSafe_(payload); return; }
  // 局面専用のチャンネルへ（朝の地合いの通知と混ざらないように）。失敗したら3回までやり直す
  for (let i = 0; i < 3; i++) {
    const r = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true });
    if (r.getResponseCode() < 300) return;
    Logger.log(`局面の通知の送信失敗 ${r.getResponseCode()}: ${r.getContentText().slice(0, 200)}`);
    Utilities.sleep(3000 * (i + 1));
  }
}

// ---------- 答え合わせ（16:15） ----------

/** 今日の寄り→引け%（取れなければ ''） */
function klOC_(sym, today) {
  try {
    const r = JSON.parse(UrlFetchApp.fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`,
      { headers: UA, muteHttpExceptions: true }).getContentText()).chart.result[0];
    const q = r.indicators.quote[0], ts = r.timestamp || [];
    for (let i = ts.length - 1; i >= 0; i--) {
      if (Utilities.formatDate(new Date(ts[i] * 1000), 'Asia/Tokyo', 'yyyyMMdd') !== today) continue;
      if (q.open[i] && q.close[i]) return Math.round((q.close[i] / q.open[i] - 1) * 10000) / 100;
    }
  } catch (e) { Logger.log(`${sym}: ${e}`); }
  return '';
}

function kyokumenReview() {
  const now = new Date();
  if (!isTradingDay_(now)) return;
  const today = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMdd');
  const sh = sheet_('kyokumen', KL_HEADER), last = sh.getLastRow();
  if (last < 2 || String(sh.getRange(last, 1).getValue()) !== today) { Logger.log('今日の行がありません'); return; }
  const tp = klOC_('1306.T', today), nk = klOC_('1321.T', today);
  const ai = KL_AI8.map(c => klOC_(c + '.T', today)).filter(v => v !== '');
  const aiAvg = ai.length ? Math.round(ai.reduce((s, v) => s + v, 0) / ai.length * 100) / 100 : '';
  const score = Number(sh.getRange(last, KL_HEADER.indexOf('まとめ_点') + 1).getValue());
  // 向きが合ったか: まとめの点が ±20 以上のときだけ判定（それ未満は「弱い」）
  const hit = tp === '' || !isFinite(score) ? '' : Math.abs(score) < 20 ? '弱い' : (score > 0) === (tp > 0) ? '○' : '×';
  sh.getRange(last, KL_HEADER.indexOf('答え_TOPIX寄り引け%') + 1, 1, 4).setValues([[tp, nk, aiAvg, hit]]);
  Logger.log(`答え合わせ ${today}: TOPIX ${tp}% / 日経 ${nk}% / AI半導体 ${aiAvg}% / 向き ${hit}`);
}
