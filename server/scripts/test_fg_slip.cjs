// Test: a Finished Goods card prints with its material slip (owner, 2 Nov 2026:
// "fg order should also have print slip when they are printed"). The slip
// comes back with the card's saved sheet — exactly as saved, its styles scoped
// so they cannot reach the slip — and the two print as one job. An older
// uploaded FG card still opens in its own tab. Rolled back — nothing kept.
//   node scripts/test_fg_slip.cjs
const path = require('path');
const S = path.join(__dirname, '..');
require(S + '/node_modules/dotenv').config({ path: S + '/.env' });
(async () => {
  const dbmod = require(S + '/src/db/index.js');
  const realPool = dbmod.getDB().pool;
  const client = await realPool.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '3s'");
  let sp = 0;
  const txDb = {
    get: async (q, p = []) => (await client.query(q, p)).rows[0] || null,
    all: async (q, p = []) => (await client.query(q, p)).rows,
    run: async (q, p = []) => client.query(q, p),
    insert: async (q, p = []) => ({ lastInsertRowid: (await client.query(q.trimEnd().replace(/;?\s*$/, '') + ' RETURNING id', p)).rows[0]?.id || null }),
    withTransaction: async (fn) => { const n = `s${++sp}`; await client.query(`SAVEPOINT ${n}`); try { const r = await fn(client); await client.query(`RELEASE SAVEPOINT ${n}`); return r; } catch (e) { await client.query(`ROLLBACK TO SAVEPOINT ${n}`); throw e; } },
    pool: realPool,
  };
  dbmod.getDB = () => txDb;
  dbmod.logActivity = async () => {};
  const q1 = async (q, p = []) => (await client.query(q, p)).rows[0];
  let failed = false;
  const ok = (label, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  ' + String(extra).slice(0, 300) : '')); if (!cond) failed = true; };
  process.on('unhandledRejection', (e) => { failed = true; console.error('ROUTE ERROR (unhandled):', e); });
  const owner = await q1("SELECT id, name, role FROM users WHERE role='owner' ORDER BY id LIMIT 1");
  const auth = require(S + '/src/middleware/auth.js');
  auth.authenticate = (req, res, next) => { req.user = owner; next(); };
  const notif = require(S + '/src/routes/notifications.js');
  notif.createNotification = async () => {};
  const express = require(S + '/node_modules/express');
  const app = express();
  app.use(express.json());
  app.use('/api/job-cards', require(S + '/src/routes/jobCards.js'));
  const server = app.listen(0);
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  try {
    const { renderFgCard, fgCardForPrint, scopeCss } = require(S + '/src/lib/fgCardRender.js');
    const { downloadFromStorage } = require(S + '/src/middleware/upload.js');

    // 1–3: the parts, from a card rendered by today's template.
    const html = renderFgCard({ card_no: 'ZZT-FG-1', order_code: 'ORD-999-26', client_code: 'ZZ', order_date: '2026-11-02', dispatch_date: '2026-11-09',
      product_code: 'PT-UType', drawing_no: 'PT-UType-12U-1KW', stamping: 'BHA-1000W-230V', fixture: 'Nut Washer', remark: '', qty: 10, took: [{ qty: 10, job_card_no: 'ZZT-SRC' }] });
    const p = fgCardForPrint(html);
    const css = (p?.styles || '').replace(/<\/?style>/g, '');
    const selectors = [];
    css.replace(/(^|\})\s*([^{}@]+?)\s*\{/g, (m, a, s) => { selectors.push(...s.split(',').map(x => x.trim())); return m; });
    ok('1. every rule of the card is scoped to .fg-sheet, so none reaches the slip',
      selectors.length >= 12 && selectors.every(s => s === '.fg-sheet' || s.startsWith('.fg-sheet ')), JSON.stringify(selectors));
    ok('2. its table and th rules are scoped (table-layout fixed / th width 30% would squeeze the slip), body → .fg-sheet, and its @page is left to the slip',
      /\.fg-sheet table \{[^}]*table-layout: fixed/.test(css) && /\.fg-sheet th \{[^}]*width: 30%/.test(css)
      && /\.fg-sheet \{[^}]*padding: 16px/.test(css) && /@media print \{\s*\.fg-sheet \{ padding: 0; \}\s*\.fg-sheet \.noprint/.test(css) && !/@page/.test(css), css.slice(0, 300));
    ok('3. the sheet is the saved body as it is, inside .fg-sheet, titled by the card',
      p.sheets.startsWith('<div class="fg-sheet">') && p.sheets.includes('INVENTORY ORDERS') && p.sheets.includes('ZZT-FG-1')
      && p.title === 'ZZT-FG-1 — Inventory Job Card' && p.fontLink === '' && p.fitScript === '', p.title);
    ok('4. a file that is not a card sheet gives nothing (the slip prints alone, the file opens in its own tab)',
      fgCardForPrint('%PDF-1.4 binary') === null && fgCardForPrint('<html><body></body></html>') === null);
    ok('5. the scoper keeps body descendants and other at-rules',
      scopeCss('body .x{a:1} html{b:2} @font-face{font-family:Q}', '.s') === '.s .x {a:1}\n.s {b:2}\n@font-face {font-family:Q}', scopeCss('body .x{a:1} html{b:2} @font-face{font-family:Q}', '.s'));

    // 6–8: through the slip route, on a real app-made FG card.
    const fg = await q1(`SELECT id, job_card_no, file_path FROM job_cards WHERE is_fg AND file_path ILIKE '%.html' ORDER BY id DESC LIMIT 1`);
    if (!fg) { ok('an app-made Finished Goods card exists', false); return; }
    let r = await call('POST', `/api/job-cards/${fg.id}/slip`);
    const saved = (await downloadFromStorage(fg.file_path)).toString('utf8');
    const savedBody = saved.match(/<body[^>]*>([\s\S]*?)<\/body>/i)[1];
    ok(`6. the slip for ${fg.job_card_no} comes back with the card, so the two print as one job`,
      r.status === 200 && !!r.body.card && r.body.card.sheets.includes(fg.job_card_no) && /\.fg-sheet table/.test(r.body.card.styles),
      JSON.stringify({ s: r.status, err: r.body.error, card: !!r.body.card }));
    ok('7. …the card exactly as it was saved when made (never re-made from today\'s data)',
      r.body.card?.sheets === `<div class="fg-sheet">${savedBody}</div>`);
    ok('8. …its list lines for the store, and no terminal-pin rows (an FG heater\'s pins are inside it)',
      r.body.lines?.length > 0 && Array.isArray(r.body.terminals) && r.body.terminals.length === 0 && r.body.printNo >= 1,
      JSON.stringify({ lines: r.body.lines?.map(l => `${l.item_code} ${l.qty}`), printNo: r.body.printNo }));

    // 9: an older FG card whose file is an upload, not a saved sheet.
    const up = await q1(`SELECT jc.id, jc.job_card_no FROM job_cards jc WHERE jc.is_fg AND jc.file_path IS NOT NULL AND jc.file_path NOT ILIKE '%.html'
      AND EXISTS (SELECT 1 FROM order_item_inventory oii WHERE oii.order_item_id=jc.order_item_id) ORDER BY jc.id DESC LIMIT 1`);
    if (up) {
      r = await call('POST', `/api/job-cards/${up.id}/slip`);
      ok(`9. an older uploaded FG card (${up.job_card_no}) still prints its slip, with its file left to open in its own tab`,
        r.status === 200 && r.body.card === null && r.body.lines?.length > 0, JSON.stringify({ s: r.status, err: r.body.error, card: r.body.card }));
    } else console.log('SKIP  9. no older uploaded FG card with a list');
  } catch (e) { failed = true; console.error('ERROR', e); }
  finally {
    await client.query('ROLLBACK'); client.release(); server.close(); await realPool.end();
    console.log(failed ? '\nSOME CHECKS FAILED (rolled back)' : '\nALL PASS (rolled back — nothing kept)');
    process.exit(failed ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
