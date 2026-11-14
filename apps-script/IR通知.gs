/**
 * Ir-rador（Google Apps Script版）
 * TDnetの新着開示をAIで採点し、基準点以上だけDiscordに通知する。発注は一切しない。
 *
 * 使い方（初回だけ）:
 *   1. script.google.com →「新しいプロジェクト」→ このコードを貼り付けて保存
 *      （スプレッドシートの 拡張機能 → Apps Script から作ってもよい。単体で作った場合は
 *        setup のときに「Ir-rador 記録」というスプレッドシートが自動でできます）
 *   2. 左の歯車「プロジェクトの設定」→ スクリプト プロパティ に次を追加
 *        ANTHROPIC_API_KEY   … AnthropicのAPIキー
 *        DISCORD_WEBHOOK_URL … DiscordのWebhook URL
 *      （任意）THRESHOLD=75, THRESHOLD_INTRADAY=75（9:00〜15:30の場中開示だけの基準）, FINAL_MODEL, SCREEN_MODEL, SCREEN_THRESHOLD=70, MAX_PER_RUN=8, MAX_PAGES=4
 *   3. 上の関数の選択で「setup」を選んで ▶実行 → 権限を許可（5分おきの自動実行が登録されます）
 *   4. テスト: 「testDryRun」を実行すると、前の営業日の開示を通知せずに採点してログに出します
 *
 * 記録はこのスプレッドシートのシートに残ります:
 *   seen  … 既読の開示ID   calls … 本採点した開示（答え合わせ用）
 */

const P = PropertiesService.getScriptProperties();
const CFG = {
  THRESHOLD: Number(P.getProperty('THRESHOLD') || 75),
  THRESHOLD_INTRADAY: Number(P.getProperty('THRESHOLD_INTRADAY') || 75),
  FINAL_MODEL: P.getProperty('FINAL_MODEL') || 'claude-opus-5-5',
  SCREEN_MODEL: P.getProperty('SCREEN_MODEL') || 'claude-haiku-5-5',
  SCREEN_THRESHOLD: Number(P.getProperty('SCREEN_THRESHOLD') || 70),
  MAX_PER_RUN: Number(P.getProperty('MAX_PER_RUN') || 8),
  SKIP_INTRADAY: P.getProperty('SKIP_INTRADAY') === '1',
};
const PRICE = { 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5] };
const UA = { 'User-Agent': 'Mozilla/5.0 (ir-rador personal notifier)' };

const INCLUDE = ['業績予想', '配当予想', '増配', '剰余金の配当', '公開買付', 'TOB', 'MBO',
  '自己株式の取得', '自己株式取得', '株式分割', '株主優待', '資本業務提携', '業務提携', '資本提携',
  '決算短信', '特別利益', '受注', '契約締結', '子会社化', '株式の取得', '合併', '経営統合', '上場', '承認'];
// 需給悪化（売り物が増える）IR。好材料と同時に出たら通知しない
const SUPPLY = ['分売', '売出し', '売出', '公募', '第三者割当', '新株予約権', '新株式発行', '行使価額修正', 'ＭＳワラント', 'MSワラント'];
const EXCLUDE = ['訂正', '説明会', '決算説明資料', '補足資料', '役員', '人事', '定款',
  'コーポレート・ガバナンス', '独立役員', '招集', '月次', 'ストックオプション', '譲渡制限付株式',
  '自己株式の取得状況', '自己株式の買付状況', '取得状況'];

const SYSTEM = `あなたは日本株の短期トレーダーを手伝うアナリストです。TDnetの適時開示PDFを読み、
株価が強く上に反応しそうな「注目の好材料」かどうかを100点満点で採点します。

採点基準（合計100点）:
1. サプライズの大きさ 40点: 経常・営業利益の上方修正率（+30%以上で高得点）、市場予想（コンセンサス）超えの度合い、
   増配率（+30%以上で高得点）、TOB・MBOのプレミアム（30%以上で高得点）、自社株買いの規模（時価総額比5%以上で高得点）、
   特別利益・純利益の増加額の時価総額比（20%以上で高得点）。
2. 時価総額の小ささ 20点: 300億円未満=20、1,000億円未満=15、3,000億円未満=10、それ以上=5。不明なら10。
3. 材料の質 15点: 本業由来・通期・継続性ありは高く、一過性の特別利益・四半期だけの上振れは低く。
4. 織り込み度 15点: 直近1か月で上がっていない、修正後PERが割安になるほど高く。すでに急騰済みなら低く。
5. 種類ボーナス 10点: TOB・MBO・大型受注・業態の変化・資本提携など。

注意:
- 上方修正と増配（または自社株買い）を同時に発表した場合は、業績と株主還元の両方が出たとして種類ボーナスで+5〜10点を加える。
  （11/9〜13週の実績: この組み合わせは70〜83点止まりなのに翌日・当日に+7〜25%上げた例が多かった）
- 上方修正でも市場予想未達・織り込み済み・増益の減速は売られやすい。慎重に減点する。
- 下方修正・減配・赤字転落など悪材料は is_negative=true とし、点数は0〜20にする。
- 15:00〜15:30の引け前発表は当日中に反応して翌朝伸びにくい。15:30以降・朝8:30〜9:00の発表は翌朝・当日寄りの候補。
- 目標株価はあくまで目安。修正後EPS×同業PER、TOB価格、配当利回りなど根拠を必ず書く。
- ストップ高・ストップ安は前日終値が基準。渡された「本日のストップ高/安」の値をそのまま使い、自分で計算しない（通知時の株価から計算しない）。翌日の値幅は当日終値で決まるので「不明」と書く。
- 書いてない数字を作らない。PDFから読めない値は「不明」と書く。時価総額が「不明」ならPDFの発行済株式数×株価で推定してよい。
- 文章は日本語、簡潔に。`;

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['score', 'breakdown', 'is_negative', 'summary', 'surprise', 'reaction', 'target_price', 'target_reason', 'timing'],
  properties: {
    score: { type: 'integer' },
    breakdown: { type: 'string', description: '5項目それぞれの点数と一言' },
    is_negative: { type: 'boolean' },
    summary: { type: 'string', description: '開示の要点（3行以内）' },
    surprise: { type: 'string', description: '何がサプライズか（修正幅・増配率・TOBプレミアム等の数字）' },
    reaction: { type: 'string', description: '株価がどう反応しそうか' },
    target_price: { type: 'string', description: '目安の目標株価（円）。出せなければ「不明」' },
    target_reason: { type: 'string' },
    timing: { type: 'string', enum: ['翌朝の寄り向き', '当日場中', '不明'] },
  },
};

// ---------- 入口 ----------

/** 初回に1回だけ実行: 5分おきの自動実行を登録する */
function setup() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'run').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('run').timeBased().everyMinutes(5).create();
  sheet_('seen', ['date', 'id']);
  sheet_('calls', ['id', 'date', 'time', 'code', 'name', 'title', 'score', 'is_negative', 'timing', 'notified', 'price_at_alert', 'target_price']);
  Logger.log('5分おきの自動実行を登録しました');
}

/** 自動実行（5分おき） */
async function run() { await main_({ dryRun: false, force: false }); }

/** テスト: 前の営業日の開示を、通知せずに最大5件採点してログに出す */
async function testDryRun() {
  const d = new Date(Date.now() + 9 * 3600e3);
  do { d.setUTCDate(d.getUTCDate() - 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  await main_({ dryRun: true, force: true, day: Utilities.formatDate(d, 'UTC', 'yyyyMMdd'), max: 5 });
}

/** テスト: Discordに届くか確認 */
function testDiscord() {
  postDiscord_({ embeds: [{ title: '✅ Ir-rador（Apps Script版）のテスト通知です', color: 0x10B981 }] });
}

// ---------- 本体 ----------

async function main_(opt) {
  const now = new Date();
  const jst = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMdd HH:mm u');
  const [today, hm, dow] = jst.split(' ');
  if (!opt.force && !inWindow_(hm, Number(dow), now)) return;
  const day = opt.day || today;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // 前の回がまだ動いている
  try {
    const seen = loadSeen_(day);
    const items = fetchTdnet_(day);
    const fresh = items.filter(it => !seen.ids.has(it.id));
    Logger.log(`${day}: 一覧 ${items.length}件 / 新着 ${fresh.length}件`);

    const skip = [], targets = [];
    for (const it of fresh) {
      if (!titleOk_(it.title) || (CFG.SKIP_INTRADAY && it.time >= '09:00' && it.time < '15:00')) skip.push(it.id);
      else if (targets.length < (opt.max || CFG.MAX_PER_RUN)) targets.push(it);
    }
    if (!opt.dryRun) addSeen_(day, skip);

    const tokens = {};
    // PDFと株価をまとめて取得
    const pdfs = UrlFetchApp.fetchAll(targets.map(it => ({ url: it.pdf, headers: UA, muteHttpExceptions: true })));
    for (let i = 0; i < targets.length; i++) {
      const it = targets[i];
      it.mkt = marketInfo_(it.code);
      if (pdfs[i].getResponseCode() !== 200) { it.b64 = null; continue; }
      const bytes = pdfs[i].getContent();
      it.b64 = await trimPdf_(bytes);
      if (!it.b64 && bytes.length <= MAX_FULL_KB * 1024) it.b64 = Utilities.base64Encode(bytes);
      if (!it.b64) { Logger.log(`  大きいPDFを切り出せないため見送り ${it.code} ${it.title}`); it.done = true; it.skipped = true; }
    }
    const ok = targets.filter(it => it.b64);

    // 一次採点（安いモデル）→ 基準以上と、買われる側のTOB・MBOだけ本採点
    const isTob = it => it.title.includes('公開買付') && (it.title.includes('当社') || it.title.includes('による'));
    const screenList = ok.filter(it => !isTob(it));
    const first = scoreAll_(CFG.SCREEN_MODEL, screenList, tokens);
    const finalList = ok.filter(it => isTob(it));
    screenList.forEach((it, i) => {
      const r = first[i];
      if (r instanceof Error) { it.err = r; return; }
      Logger.log(`  一次 ${r.score} ${it.code} ${it.title}`);
      if (r.score >= CFG.SCREEN_THRESHOLD && !r.is_negative) finalList.push(it);
      else it.done = true;
    });
    const final = scoreAll_(CFG.FINAL_MODEL, finalList, tokens);
    // 基準点の前後（±5点）は2回目を採点して平均
    const again = finalList.filter((it, i) => !(final[i] instanceof Error) && Math.abs(final[i].score - thr_(it)) <= 5);
    const second = scoreAll_(CFG.FINAL_MODEL, again, tokens);
    finalList.forEach((it, i) => {
      let r = final[i];
      if (r instanceof Error) { it.err = r; return; }
      const j = again.indexOf(it);
      if (j >= 0 && !(second[j] instanceof Error)) {
        const avg = Math.round((r.score + second[j].score) / 2);
        if (second[j].score > r.score) r = second[j];
        r.score = avg; r.breakdown += '（2回採点の平均）';
      }
      it.res = r; it.done = true;
      Logger.log(`  本採点 ${r.score} ${it.code} ${it.name} ${it.title}`);
    });

    const done = [];
    for (const it of targets) {
      if (it.err) { Logger.log(`  失敗 ${it.code} ${it.title}: ${it.err.message}`); continue; } // 次回やり直す
      if (it.skipped) { done.push(it.id); continue; }
      if (!it.b64) { Logger.log(`  PDF取得失敗 ${it.code}`); continue; }
      if (!it.done) continue;
      let sent = false;
      // 同じ日に同じ銘柄から需給悪化のIR（分売・売出し・増資など）が出ていたら通知しない
      //（11/11 共和コーポレーション: 好決算80点と同時に立会外分売→S安）
      const supply = items.find(x => x.code === it.code && SUPPLY.some(k => x.title.includes(k)));
      if (supply && it.res) { it.res.breakdown = (it.res.breakdown || '') + ` ／⚠同時に「${supply.title}」→通知見送り`; Logger.log(`    需給悪化IRと同時のため見送り: ${supply.title}`); }
      if (it.res && !supply && it.res.score >= thr_(it) && !it.res.is_negative) {
        if (seen.notified.has(it.code)) Logger.log('    同じ銘柄はこの日すでに通知済み');
        else if (opt.dryRun) Logger.log(JSON.stringify(it.res, null, 1));
        else { postDiscord_(payload_(it)); seen.notified.add(it.code); sent = true; }
      }
      if (it.res && !opt.dryRun) logCall_(day, it, sent);
      done.push(sent ? it.id + '#' + it.code : it.id);
    }
    if (!opt.dryRun) addSeen_(day, done);

    let total = 0;
    Object.keys(tokens).forEach(m => {
      const [pi, po] = PRICE[m] || [4, 20];
      const c = tokens[m][0] / 1e6 * pi + tokens[m][1] / 1e6 * po;
      total += c;
      Logger.log(`使用量 ${m}: 入力 ${tokens[m][0]} / 出力 ${tokens[m][1]} ≈ $${c.toFixed(3)}`);
    });
    if (total) Logger.log(`今回の費用の目安: $${total.toFixed(3)}（約${Math.round(total * 150)}円）`);
  } finally {
    lock.releaseLock();
  }
}

function inWindow_(hm, dow, now) {
  if (dow >= 6) return false; // u: 1=月 … 7=日
  const cal = CalendarApp.getCalendarById('ja.japanese#holiday@group.v.calendar.google.com');
  if (cal && cal.getEventsForDay(now).length) return false;
  return hm >= '08:30' && hm <= '20:05';
}

function titleOk_(t) {
  if (EXCLUDE.some(w => t.includes(w))) return false;
  return INCLUDE.some(w => t.includes(w));
}

// ---------- TDnet ----------

function fetchTdnet_(day) {
  const items = [];
  for (let page = 1; page < 30; page++) {
    const url = `https://www.release.tdnet.info/inbs/I_list_${('00' + page).slice(-3)}_${day}.html`;
    const r = UrlFetchApp.fetch(url, { headers: UA, muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) {
      if (page === 1) Logger.log(`TDnet一覧の応答 ${r.getResponseCode()}（${url}）`);
      break;
    }
    const html = r.getContentText('UTF-8');
    const rows = html.split(/<tr[\s>]/).slice(1);
    let n = 0;
    for (const tr of rows) {
      const time = cell_(tr, 'kjTime'), code = cell_(tr, 'kjCode'), name = cell_(tr, 'kjName');
      const m = tr.match(/class="[^"]*kjTitle[^"]*"[^>]*>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!time || !code || !m) continue;
      n++;
      items.push({
        id: m[1].split('/').pop().replace('.pdf', ''), time, code: code.slice(0, 4), name,
        title: strip_(m[2]), pdf: 'https://www.release.tdnet.info/inbs/' + m[1],
      });
    }
    if (page === 1 && n === 0) Logger.log(`TDnet一覧を読めませんでした（${html.length}文字）: ${html.slice(0, 200)}`);
    if (n < 100) break;
  }
  return items.length ? items : fetchYanoshin_(day);
}

/** 予備: やのしん TDnet WEB-API */
function fetchYanoshin_(day) {
  try {
    const r = UrlFetchApp.fetch(`https://webapi.yanoshin.jp/webapi/tdnet/list/${day}.json?limit=2000`,
      { headers: UA, muteHttpExceptions: true });
    Logger.log(`予備APIの応答 ${r.getResponseCode()}`);
    if (r.getResponseCode() !== 200) return [];
    return (JSON.parse(r.getContentText()).items || []).map(x => {
      const d = x.Tdnet || {};
      return { id: String(d.id), time: String(d.pubdate || '').slice(11, 16), code: String(d.company_code || '').slice(0, 4),
        name: d.company_name || '', title: d.title || '', pdf: d.document_url || '' };
    });
  } catch (e) {
    Logger.log(`予備APIの取得に失敗: ${e}`);
    return [];
  }
}

/** 調べる用: TDnetの一覧ページがどう見えているかをログに出す */
function debugTdnet() {
  const url = 'https://www.release.tdnet.info/inbs/I_list_001_20261106.html';
  const r = UrlFetchApp.fetch(url, { headers: UA, muteHttpExceptions: true });
  const html = r.getContentText('UTF-8');
  Logger.log(`応答 ${r.getResponseCode()} / ${html.length}文字`);
  const i = html.indexOf('kjTime');
  Logger.log(i >= 0 ? html.slice(Math.max(0, i - 300), i + 900) : html.slice(0, 1500));
}

function cell_(tr, cls) {
  const m = tr.match(new RegExp(`class="[^"]*${cls}[^"]*"[^>]*>([\\s\\S]*?)</td>`));
  return m ? strip_(m[1]) : '';
}

function strip_(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}


// ---------- PDFを先頭ページだけにする（費用を抑えるため。pdf-libを使用） ----------

const MAX_PAGES = Number(P.getProperty('MAX_PAGES') || 4);
const MAX_FULL_KB = 400; // 切り出しに失敗したとき、これより大きいPDFは採点しない（費用の暴走を防ぐ）
var setTimeout = (f, ms) => { if (ms) Utilities.sleep(ms); f(); return 0; };
var clearTimeout = () => {};

function loadPdfLib_() {
  if (typeof PDFLib !== 'undefined') return;
  const src = UrlFetchApp.fetch('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js').getContentText();
  eval(src);
  if (typeof PDFLib === 'undefined' && typeof globalThis.PDFLib !== 'undefined') PDFLib = globalThis.PDFLib;
}

/** bytes（GASのバイト配列）→ 先頭 MAX_PAGES ページだけのPDFのbase64。失敗したら null */
async function trimPdf_(bytes) {
  try {
    loadPdfLib_();
    const src = await PDFLib.PDFDocument.load(new Uint8Array(bytes), { ignoreEncryption: true });
    const n = src.getPageCount();
    if (n <= MAX_PAGES) return Utilities.base64Encode(bytes);
    const out = await PDFLib.PDFDocument.create();
    const pages = await out.copyPages(src, [...Array(MAX_PAGES).keys()]);
    pages.forEach(pg => out.addPage(pg));
    const b = await out.save();
    return Utilities.base64Encode(Array.from(new Int8Array(b.buffer, b.byteOffset, b.byteLength)));
  } catch (e) {
    Logger.log(`  PDFの切り出しに失敗: ${e}`);
    return null;
  }
}

// ---------- 株価（Yahoo Financeの公開チャート） ----------

function marketInfo_(code) {
  const info = { price: null, market_cap_oku: '不明', chg_1m_pct: null, prev_close: null, limit_up: null, limit_down: null };
  try {
    const r = UrlFetchApp.fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${code}.T?range=1mo&interval=1d`,
      { headers: UA, muteHttpExceptions: true });
    const res = JSON.parse(r.getContentText()).chart.result[0];
    const closes = res.indicators.quote[0].close.filter(x => x != null);
    info.price = Math.round(res.meta.regularMarketPrice * 10) / 10;
    // 値幅制限の基準は「前日終値」（通知時の株価ではない）
    const bars = (res.timestamp || []).map((ts, i) => ({
      d: Utilities.formatDate(new Date(ts * 1000), 'Asia/Tokyo', 'yyyyMMdd'), c: res.indicators.quote[0].close[i] }))
      .filter(b => b.c != null);
    const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
    const prev = bars.filter(b => b.d < today);
    if (prev.length) {
      info.prev_close = prev[prev.length - 1].c;
      const w = limitWidth_(info.prev_close);
      info.limit_up = info.prev_close + w; info.limit_down = Math.max(1, info.prev_close - w);
    }
    if (closes.length > 1) info.chg_1m_pct = Math.round((closes[closes.length - 1] / closes[0] - 1) * 1000) / 10;
  } catch (e) {
    Logger.log(`${code}: 株価取得失敗 ${e}`);
  }
  return info;
}

/** 東証の制限値幅（基準値段＝前日終値） */
function limitWidth_(p) {
  const t = [[100, 30], [200, 50], [500, 80], [700, 100], [1000, 150], [1500, 300], [2000, 400], [3000, 500],
    [5000, 700], [7000, 1000], [10000, 1500], [15000, 3000], [20000, 4000], [30000, 5000], [50000, 7000],
    [70000, 10000], [100000, 15000], [150000, 30000], [200000, 40000], [300000, 50000], [500000, 70000],
    [700000, 100000], [1000000, 150000], [1500000, 300000], [2000000, 400000], [3000000, 500000]];
  for (const [lim, w] of t) if (p < lim) return w;
  return 700000;
}

// ---------- AI採点（まとめて並列に送る） ----------

function scoreAll_(model, list, tokens) {
  if (!list.length) return [];
  const key = P.getProperty('ANTHROPIC_API_KEY');
  const reqs = list.map(it => ({
    url: 'https://api.anthropic.com/v1/messages', method: 'post', muteHttpExceptions: true,
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model, max_tokens: 16000, system: SYSTEM,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: it.b64 } },
          { type: 'text', text: `銘柄: ${it.code} ${it.name}\n開示時刻: ${it.time}\nタイトル: ${it.title}\n` +
            `株価: ${it.mkt.price} 円 / 前日終値: ${it.mkt.prev_close ?? '不明'} 円 / 本日のストップ高: ${it.mkt.limit_up ?? '不明'} 円・ストップ安: ${it.mkt.limit_down ?? '不明'} 円 / 時価総額: ${it.mkt.market_cap_oku} 億円 / 直近1か月の騰落: ${it.mkt.chg_1m_pct} %\nこのPDFを採点してください。` },
        ],
      }],
    }),
  }));
  return UrlFetchApp.fetchAll(reqs).map(r => {
    try {
      const body = JSON.parse(r.getContentText());
      if (r.getResponseCode() !== 200) throw new Error(`${r.getResponseCode()} ${body.error ? body.error.message : ''}`);
      tokens[model] = tokens[model] || [0, 0];
      tokens[model][0] += body.usage.input_tokens;
      tokens[model][1] += body.usage.output_tokens;
      if (body.stop_reason === 'refusal') throw new Error('モデルが回答を拒否しました');
      return JSON.parse(body.content.filter(b => b.type === 'text').map(b => b.text).join(''));
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  });
}

// ---------- 通知 ----------

function payload_(it) {
  const r = it.res, m = it.mkt;
  const intraday = it.time >= '09:00' && it.time < '15:30';
  const tob = /公開買付|ＴＯＢ|TOB|ＭＢＯ|MBO/.test(it.title);
  const tag = tob && !intraday ? '⚠ **時間外のTOB/MBO**：翌朝はS高張り付き→比例配分になりやすく、参加しにくい\n\n'
    : intraday ? '⏱ **場中の開示**：これまでの実績では通知後30分より引けまで伸びやすい\n\n' : '';
  const desc = tag + `**${it.time}** ${it.title}\n[TDnetのPDF](${it.pdf})\n\n` +
    `**要点**\n${r.summary}\n\n**サプライズ**\n${r.surprise}\n\n` +
    `**株価**\n${m.price}円（1か月 ${m.chg_1m_pct}%）` +
    (m.limit_up ? ` / 前日終値 ${m.prev_close}円・本日S高 ${m.limit_up}円` : '') + `\n\n` +
    `**反応予想（${r.timing}）**\n${r.reaction}\n\n` +
    `**目安の目標株価** ${r.target_price}\n${r.target_reason}\n\n` +
    `採点内訳: ${r.breakdown}\n※発注はしません。判断はご自身で。`;
  return { embeds: [{ title: `📈 注目IR ${r.score}点｜${it.code} ${it.name}`.slice(0, 256), description: desc.slice(0, 4000), color: 0xE8452C }] };
}

function postDiscord_(payload) {
  UrlFetchApp.fetch(P.getProperty('DISCORD_WEBHOOK_URL'),
    { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload) });
}

// ---------- 記録（スプレッドシート） ----------

/** 記録用のスプレッドシート。script.google.com で単体で作った場合は「Ir-rador 記録」を自動で作る */
function book_() {
  const active = SpreadsheetApp.getActive();
  if (active) return active;
  let id = P.getProperty('SHEET_ID');
  if (!id) {
    id = SpreadsheetApp.create('Ir-rador 記録').getId();
    P.setProperty('SHEET_ID', id);
  }
  return SpreadsheetApp.openById(id);
}

function sheet_(name, header) {
  const ss = book_();
  let sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(header); }
  return sh;
}

/** 場中（9:00〜15:30）の開示はすぐ値が動くので基準を下げる */
function thr_(it) {
  const t = String(it.time || '').slice(0, 5);
  return t >= '09:00' && t < '15:30' ? CFG.THRESHOLD_INTRADAY : CFG.THRESHOLD;
}

function loadSeen_(day) {
  const sh = sheet_('seen', ['date', 'id']);
  const ids = new Set(), notified = new Set();
  const last = sh.getLastRow();
  if (last > 1) {
    const start = Math.max(2, last - 3000);
    sh.getRange(start, 1, last - start + 1, 2).getValues().forEach(([d, id]) => {
      if (String(d) !== day) return;
      const [i, code] = String(id).split('#');
      ids.add(i);
      if (code) notified.add(code);
    });
  }
  return { ids, notified };
}

function addSeen_(day, ids) {
  if (!ids.length) return;
  const sh = sheet_('seen', ['date', 'id']);
  sh.getRange(sh.getLastRow() + 1, 1, ids.length, 2).setNumberFormat('@').setValues(ids.map(id => [day, id]));
}

function logCall_(day, it, sent) {
  const r = it.res;
  sheet_('calls', []).appendRow([it.id, day, it.time, it.code, it.name, it.title.slice(0, 80), r.score,
    r.is_negative ? 1 : 0, r.timing, sent ? 1 : 0, it.mkt.price, r.target_price]);
}
