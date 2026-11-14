/**
 * 狩り検証（11/12）: 「AIや個人が置きそうな分かりやすい損切り・利確」は本当に狩られているか、
 * 狩られにくい位置に置けば勝てるかを、大型108銘柄・直近2年の日足で調べる（1分ほど）。
 * 同じプロジェクトに追加して huntTest を1回実行 → 結果はシート hunt_bt と Discord「🎯 狩り検証」。
 * スイング検証.gs の swParse_ / SW_CODES / SW_COST、IR通知.gs の sheet_ / UA / postDiscord_ を使う。
 *
 * ① 狩りの跡があるか（取引の前提なしで値動きだけ見る）
 *   「前日安値」「寄りの下のキリ番(3000円以上は100円、未満は50円)」を安値が割ったあと、引けでその上に戻した割合を、
 *   同じ距離のダミーの線と比べる。目立つ線だけ戻りが多ければ「割らせてから戻す」＝狩りの跡。
 *   利確側: 高値が前日高値の「すぐ手前(0.1ATR)」で止まる割合をダミーと比べる（多ければ前日高値の手前に売りの壁）。
 * ② 出口の置き方を変えて損益を比べる（入り口は同じ＝毎日寄りで買い、決着しなければ引けで手じまい）
 *   日足では同じ日の損切りと利確の順番が分からないので、両方に届いた日は損切りが先（不利な方）とする。
 */
const HUNT_SPLIT = '20251112'; // ここから直近1年、その前が1〜2年前
const HUNT_HEADER = ['区分', '名前', '期間', '回数', '平均R', '勝率', '平均%(コスト込み)', '損切りに掛かった割合', '利確に届いた割合', '両方に届いた日', 'メモ'];

function huntTest() {
  const all = [];
  for (let s = 0; s < SW_CODES.length; s += 20) {
    const chunk = SW_CODES.slice(s, s + 20);
    UrlFetchApp.fetchAll(chunk.map(c => ({ url: `https://query1.finance.yahoo.com/v8/finance/chart/${c}.T?range=2y&interval=1d`, headers: UA, muteHttpExceptions: true })))
      .forEach((r, j) => { const b = swParse_(r.getContentText()); if (b && b.length > 60) all.push({ code: chunk[j], b }); });
    Utilities.sleep(300);
  }
  const rows = huntRun_(all);
  const sh = sheet_('hunt_bt', HUNT_HEADER);
  sh.clearContents();
  sh.getRange(1, 1, 1, HUNT_HEADER.length).setValues([HUNT_HEADER]);
  sh.getRange(2, 1, rows.length, HUNT_HEADER.length).setValues(rows);
  const msg = rows.filter(r => r[2] === '2年全体').map(r => `${r[0]} ${r[1]}: ${r[3]}回 ${r[0].startsWith('①') ? r[5] + '% ' + r[10] : r[4] + 'R ' + r[6] + '% ' + r[10]}`);
  Logger.log(msg.join('\n'));
  try { postDiscord_({ embeds: [{ title: '🎯 狩り検証（大型108・2年）', description: msg.join('\n').slice(0, 4000), color: 0xF59E0B }] }); } catch (e) { Logger.log('Discord送信に失敗: ' + e); }
}

/** 本体（テストしやすいように分けてある）。all = [{code, b:[{d,o,h,l,c,v}]}]
 * 偏りの対策: 日足だと「線までの距離」が違うだけで結果が変わる（近い線ほど同じ日に損切りと利確の両方に届きやすい等）。
 * そこで、どの線にも「比較用（ダミー）」を作る＝同じ銘柄の別の日（37営業日ずらした日）の“寄りからの距離”をそのまま使った線。
 * 距離の分布は同じで、目立つ価格かどうかだけが違う → 本物とダミーの差だけを「狩りの効果」として読む。 */
function huntRun_(all) {
  const r2 = v => v == null || isNaN(v) ? '' : Math.round(v * 100) / 100;
  const per = d => d >= HUNT_SPLIT ? '直近1年' : '1〜2年前';
  const SHIFT = 37;
  const kiri = o => { const u = o >= 3000 ? 100 : 50; const lo = Math.floor(o / u) * u; return { lo: lo === o ? lo - u : lo, hi: Math.ceil(o / u) * u === o ? o + u : Math.ceil(o / u) * u }; };
  // 線の定義: 寄りから見た損切り・利確の価格（null=置かない）
  const V = [
    ['素直なAI', 'A1 損切り=前日安値ちょうど / 利確=前日高値ちょうど', (t, p, a) => ({ sl: p.l, tp: p.h })],
    ['狩られにくい', 'B1 損切り=前日安値-0.3ATR / 利確=前日高値-0.1ATR', (t, p, a) => ({ sl: p.l - 0.3 * a, tp: p.h - 0.1 * a })],
    ['素直なAI', 'A2 損切り=寄り-1% / 利確=寄り+2%（固定%）', (t, p, a) => ({ sl: t.o * 0.99, tp: t.o * 1.02 })],
    ['狩られにくい', 'B2 損切り=寄り-1%-0.3ATR / 利確=寄り+2%-0.1ATR', (t, p, a) => ({ sl: t.o * 0.99 - 0.3 * a, tp: t.o * 1.02 - 0.1 * a })],
    ['素直なAI', 'A3 損切り=寄りの下のキリ番 / 利確=寄りの上のキリ番', (t, p, a) => { const k = kiri(t.o); return { sl: k.lo, tp: k.hi }; }],
    ['狩られにくい', 'B3 損切り=キリ番-0.3ATR / 利確=キリ番-0.1ATR', (t, p, a) => { const k = kiri(t.o); return { sl: k.lo - 0.3 * a, tp: k.hi - 0.1 * a }; }],
    ['狩りの逆', 'C 前日安値-0.2ATRに買い指値（狩られた所で入る）/ 損切り-0.5ATR / 引けで売る', null],
  ];
  const acc = {};
  const add = (key, P, o) => [P, '2年全体'].forEach(q => { const x = acc[key + '|' + q] = acc[key + '|' + q] || { n: 0, R: 0, pct: 0, win: 0, sl: 0, tp: 0, both: 0, back: 0 };
    x.n++; ['R', 'pct'].forEach(k => x[k] += o[k] || 0); if (o.pct > 0) x.win++; if (o.hitSl) x.sl++; if (o.hitTp) x.tp++; if (o.both) x.both++; if (o.back) x.back++; });
  // 寄りで買って、損切り距離dsl・利確距離dtp（寄りに対する割合）で手じまう
  const sim = (t, dsl, dtp) => {
    const sl = dsl != null ? t.o * (1 - dsl) : null, tp = dtp != null ? t.o * (1 + dtp) : null;
    const hitSl = sl != null && t.l <= sl, hitTp = tp != null && t.h >= tp;
    const px = hitSl ? sl : hitTp ? tp : t.c; // 両方に届いた日は損切りが先（不利な方）
    const pct = (px / t.o - 1) * 100 - SW_COST;
    return { pct, R: pct / (dsl != null ? dsl * 100 : 1), hitSl, hitTp: hitTp && !hitSl, both: hitSl && hitTp };
  };
  // 指値dで買い（寄りよりd下）、損切りはさらにds下、引けで売る
  const simC = (t, d, ds) => {
    const ent = t.o * (1 - d), sl = ent - t.o * ds;
    if (!(t.l <= ent)) return null;
    const hitSl = t.l <= sl, px = hitSl ? sl : t.c, pct = (px / ent - 1) * 100 - SW_COST;
    return { pct, R: pct / ((ent - sl) / ent * 100), hitSl };
  };
  const bunch = {};
  all.forEach(({ b }) => {
    const atr = b.map((x, i) => { if (i < 15) return null; let s = 0; for (let k = i - 14; k < i; k++) s += Math.max(b[k].h - b[k].l, Math.abs(b[k].h - b[k - 1].c), Math.abs(b[k].l - b[k - 1].c)); return s / 14; });
    // 1周目: 各日の線までの距離（寄りに対する割合）
    const days = [];
    for (let i = 16; i < b.length; i++) {
      const t = b[i], p = b[i - 1], a = atr[i];
      if (!a || !(t.o > 0)) continue;
      const dist = V.map(v => {
        if (!v[2]) return { d: (t.o - (p.l - 0.2 * a)) / t.o, ds: 0.5 * a / t.o, ok: t.o > p.l };
        const { sl, tp } = v[2](t, p, a);
        return { sl: (t.o - sl) / t.o, tp: (tp - t.o) / t.o, ok: sl < t.o && tp > t.o };
      });
      const k = kiri(t.o);
      const lines = { pl: (t.o - p.l) / t.o, kr: (t.o - k.lo) / t.o, ph: (p.h - t.o) / t.o, a: a / t.o };
      days.push({ t, p, P: per(t.d), dist, lines });
    }
    // 2周目: 本物とダミー（37日ずらした日の距離）を同じ日に当てる
    days.forEach((x, i) => {
      const y = days[(i + SHIFT) % days.length], t = x.t;
      // ① 狩りの跡: 目立つ線を割った後、引けで線の上に戻したか
      [['前日安値', 'pl'], ['寄りの下のキリ番', 'kr']].forEach(([name, key]) => {
        [[name, x.lines[key]], ['ダミー（' + name + 'と同じ距離）', y.lines[key]]].forEach(([nm, dd]) => {
          if (!(dd > 0)) return; const L = t.o * (1 - dd);
          if (t.l < L) add('①|' + nm, x.P, { back: t.c > L });
        });
      });
      // 利確側: 高値が前日高値のすぐ手前で止まるか、すぐ上で止まるか（ダミーも同じ距離で）
      [['前日高値', x.lines.ph], ['ダミー（前日高値と同じ距離）', y.lines.ph]].forEach(([nm, dd]) => {
        if (!(dd > 0)) return; const H = t.o * (1 + dd), w = x.lines.a * t.o * 0.1;
        const kk = nm + '|' + x.P; bunch[kk] = bunch[kk] || { below: 0, above: 0 };
        if (t.h >= H - w && t.h < H) bunch[kk].below++; else if (t.h >= H && t.h < H + w) bunch[kk].above++;
      });
      // ② 出口の置き方
      V.forEach((v, j) => {
        const dx = x.dist[j], dy = y.dist[j];
        if (!v[2]) {
          if (dx.ok) { const r = simC(t, dx.d, dx.ds); if (r) add('②|' + v[1], x.P, r); }
          if (dy.ok) { const r = simC(t, dy.d, dy.ds); if (r) add('②ダミー|' + v[1], x.P, r); }
          return;
        }
        if (dx.ok) add('②|' + v[1], x.P, sim(t, dx.sl, dx.tp));
        if (dy.ok) add('②ダミー|' + v[1], x.P, sim(t, dy.sl, dy.tp));
      });
      add('②|Z 基準: 寄りで買って引けで売る', x.P, sim(t, null, null));
    });
  });
  const rows = [], periods = ['2年全体', '1〜2年前', '直近1年'];
  const get = k => acc[k] || { n: 0 };
  [['前日安値'], ['寄りの下のキリ番']].forEach(([name]) => periods.forEach(q => {
    const a = get('①|' + name + '|' + q), d = get('①|ダミー（' + name + 'と同じ距離）|' + q);
    const ra = a.n ? a.back / a.n * 100 : null, rd = d.n ? d.back / d.n * 100 : null;
    rows.push(['①狩りの跡', `${name}を割った日→引けで上に戻した割合`, q, a.n, '', r2(ra), '', '', '', '', `ダミー ${r2(rd)}%（${d.n}回）→ 差 ${r2(ra - rd)}pt（プラス＝割らせて戻す＝狩りの跡）`]);
  }));
  ['1〜2年前', '直近1年'].forEach(q => {
    const a = bunch['前日高値|' + q] || { below: 0, above: 0 }, d = bunch['ダミー（前日高値と同じ距離）|' + q] || { below: 0, above: 0 };
    const fa = a.below / Math.max(1, a.below + a.above) * 100, fd = d.below / Math.max(1, d.below + d.above) * 100;
    rows.push(['①狩りの跡', '高値が前日高値の「すぐ手前」で止まった割合（すぐ上との比）', q, a.below + a.above, '', r2(fa), '', '', '', '', `ダミー ${r2(fd)}% → 差 ${r2(fa - fd)}pt（プラス＝前日高値の手前に売りの壁）`]);
  });
  V.map(v => [v[0], v[1]]).concat([['基準', 'Z 基準: 寄りで買って引けで売る']]).forEach(([g, n]) => periods.forEach(q => {
    const o = get('②|' + n + '|' + q), d = get('②ダミー|' + n + '|' + q); if (!o.n) return;
    rows.push(['②出口の置き方', n, q, o.n, r2(o.R / o.n), r2(o.win / o.n * 100), r2(o.pct / o.n), r2(o.sl / o.n * 100), r2(o.tp / o.n * 100), o.both,
      d.n ? `${g}｜ダミー ${r2(d.R / d.n)}R ${r2(d.pct / d.n)}% → 差 ${r2(o.R / o.n - d.R / d.n)}R` : g]);
  }));
  return rows;
}
