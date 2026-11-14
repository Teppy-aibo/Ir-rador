/**
 * 週次振り返り（IR通知の採点の良し悪しを見る）
 * IR通知.gs・答え合わせ.gs と同じプロジェクトに「ファイル ＋ → スクリプト」で追加。
 * 関数「weeklyReview」を1回実行 → Discordに集計が届き、シート「weekly」にも書きます。
 *
 * 分け方: TOB/MBO（場中）・TOB/MBO（時間外）・それ以外。採点の良し悪しは「それ以外」で判断する。
 * 使うもの: rows_ / bucket_ / book_ / sheet_ / postDiscord_（答え合わせ.gs・IR通知.gs）
 */
const WR_DAYS = 7;                                   // 何日分を見るか
const WR_TOB = /公開買付|ＴＯＢ|TOB|ＭＢＯ|MBO/;
const WR_SUPPLY = /分売|売出|公募|第三者割当|新株予約権|新株式発行|行使価額|ＭＳ|MSワラント/;

function weeklyReview() {
  const since = Utilities.formatDate(new Date(Date.now() - WR_DAYS * 864e5), 'Asia/Tokyo', 'yyyyMMdd');
  const calls = rows_('calls');
  const title = Object.fromEntries(calls.map(c => [c.id, c.title || '']));
  // 同じ日・同じ銘柄に増資・売出系の開示があったか
  const supply = new Set(calls.filter(c => WR_SUPPLY.test(c.title || '')).map(c => `${c.code}|${c.date}`));
  const rows = rows_('results').filter(r => r.date >= since && r.is_negative !== '1' && r.close_pct !== '');

  const kind = r => {
    if (!WR_TOB.test(title[r.id] || '')) return 'それ以外';
    return r.mode === '場中' ? 'TOB/MBO（場中）' : 'TOB/MBO（時間外）';
  };
  // 評価する値: 場中＝通知後30分高値、寄り前・引け後＝寄り→9:30高値。終値は基準比
  const n = v => v === '' || v === undefined ? null : Number(v);
  const out = [`**IR通知 週次振り返り（${since}〜、${rows.length}件）**`];
  const sheetRows = [['区分', '点数帯', '件数', '平均ギャップ%', '平均 早い時間の高値%', '+2%到達', '平均終値%']];

  for (const k of ['それ以外', 'TOB/MBO（場中）', 'TOB/MBO（時間外）']) {
    const g = rows.filter(r => kind(r) === k);
    if (!g.length) continue;
    out.push(`\n__${k}__`);
    for (const b of ['95点以上', '85〜94点', '70〜84点', '70点未満']) {
      const x = g.filter(r => bucket_(Number(r.score)) === b);
      if (!x.length) continue;
      const avg = key => { const v = x.map(r => n(r[key])).filter(v => v !== null); return v.length ? v.reduce((a, c) => a + c, 0) / v.length : null; };
      const hits = x.filter(r => r.hit_2pct !== '');
      const hit = hits.length ? `${hits.filter(r => r.hit_2pct === '1').length}/${hits.length}` : '-';
      const f = v => v === null ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
      out.push(`${b}: ${x.length}件 ギャップ ${f(avg('gap_pct'))} / 早い高値 ${f(avg('high_0930_pct'))} / +2% ${hit} / 終値 ${f(avg('close_pct'))}`);
      sheetRows.push([k, b, x.length, avg('gap_pct'), avg('high_0930_pct'), hit, avg('close_pct')]);
    }
  }

  // 外れ: 通知したのに終値がマイナス
  const bad = rows.filter(r => r.notified === '1' && n(r.close_pct) < 0).sort((a, b) => n(a.close_pct) - n(b.close_pct));
  // 見逃し: 通知しなかったのに大きく上げた（早い高値+5%以上 か 終値+5%以上）、TOB以外
  const miss = rows.filter(r => r.notified !== '1' && kind(r) === 'それ以外' &&
    (n(r.high_0930_pct) >= 5 || n(r.close_pct) >= 5)).sort((a, b) => n(b.close_pct) - n(a.close_pct));
  const line = r => `${r.score}点 ${r.code} ${r.name}（${r.mode}）早い高値 ${r.high_0930_pct || '-'}% / 終値 ${r.close_pct}%` +
    (supply.has(`${r.code}|${r.date}`) ? ' ⚠同日に増資・売出系' : '') + `\n　${(title[r.id] || '').slice(0, 40)}`;
  out.push(`\n**通知したのに終値マイナス（${bad.length}件）**`, ...bad.slice(0, 8).map(line));
  out.push(`\n**通知しなかったのに+5%以上（TOB以外、${miss.length}件）**`, ...miss.slice(0, 10).map(line));

  const sh = sheet_('weekly', ['区分']);
  sh.clear();
  sh.getRange(1, 1, sheetRows.length, sheetRows[0].length).setValues(sheetRows.map(r => r.map(v => v === null ? '' : v)));
  const msg = out.join('\n');
  Logger.log(msg);
  try { postDiscord_({ embeds: [{ title: '🗓 IR通知 週次振り返り', description: msg.slice(0, 4000), color: 0xF59E0B }] }); }
  catch (e) { Logger.log('Discord送信に失敗: ' + e); }
}
