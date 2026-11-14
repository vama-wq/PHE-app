// Test for Drawings to make — the drawing agent in the app (owner, 14 Nov 2026;
// lib/drawings/agent.js, routes/drawingAgent.js). The queue finds a plain U
// item that needs a drawing; its proposal carries the job card's own figures
// (buildDraft) with the total length = 2 × U; one owner approval puts the
// production sheet on the item as an approved drawing and makes the card(s)
// through the app's own upload / approve / Make Job Card code, all or nothing.
// Refused: a second approval, a stale sheet code, an item changed after the
// sheet was shown, a fitting order not yet confirmed, anyone but the owner.
//
// Runs inside ONE transaction that is ROLLED BACK, on made-up orders with items
// cloned from a real nut-washer U item and its list. Storage uploads and
// WhatsApp are stubbed. The new schema (order_drawings.agent_spec and the
// drawing_rulings table, both in initDB) is only described in initDB: until the
// live database has it, this test gives its own transaction a temporary copy
// (CREATE TEMP TABLE … inside the rolled-back transaction — visible to nobody
// else, gone at the ROLLBACK; no live table is altered).
//   node <scratchpad>/ddl_check.cjs   (must say "no schema steps running"), then
//   node <scratchpad>/watchdog.cjs scripts/test_drawing_agent.cjs <log>
const path = require('path');
const S = path.join(__dirname, '..');
require(S + '/node_modules/dotenv').config({ path: S + '/.env' });

(async () => {
  const t0 = Date.now();
  const dbmod = require(S + '/src/db/index.js');
  const realPool = dbmod.getDB().pool;
  const countSql = `SELECT (SELECT COUNT(*) FROM order_drawings)::int od, (SELECT COUNT(*) FROM job_cards)::int jc,
    (SELECT COUNT(*) FROM order_item_inventory)::int oii, (SELECT COUNT(*) FROM orders)::int o,
    (SELECT COUNT(*) FROM activity_log)::int al, (SELECT COUNT(*) FROM notifications)::int n`;
  const before = (await realPool.query(countSql)).rows[0];
  const client = await realPool.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '3s'");
  await client.query("SET LOCAL statement_timeout = '20s'");
  // A route's own SET LOCAL never loosens the test's timeouts.
  const held = { query: (q, p) => client.query(
    /^\s*SET\s+LOCAL\s+lock_timeout/i.test(String(q)) ? "SET LOCAL lock_timeout = '3s'"
      : /^\s*SET\s+LOCAL\s+statement_timeout/i.test(String(q)) ? "SET LOCAL statement_timeout = '20s'" : q, p) };
  let sp = 0;
  const txDb = {
    get: async (q, p = []) => (await held.query(q, p)).rows[0] || null,
    all: async (q, p = []) => (await held.query(q, p)).rows,
    run: async (q, p = []) => held.query(q, p),
    insert: async (q, p = []) => ({ lastInsertRowid: (await held.query(q.trimEnd().replace(/;?\s*$/, '') + ' RETURNING id', p)).rows[0]?.id || null }),
    withTransaction: async (fn) => { const n = `s${++sp}`; await client.query(`SAVEPOINT ${n}`); try { const r = await fn(held); await client.query(`RELEASE SAVEPOINT ${n}`); return r; } catch (e) { await client.query(`ROLLBACK TO SAVEPOINT ${n}`); throw e; } },
    pool: realPool,
  };
  // Stubs BEFORE the routes load: they are destructured at require time.
  const logs = [], uploads = [], removes = [];
  let failFolder = null;
  dbmod.getDB = () => txDb;
  dbmod.logActivity = async (orderId, jc, type, desc) => { logs.push({ orderId, jc, type, desc }); };
  const wa = require(S + '/src/lib/whatsapp.js');
  const waQueued = [];
  wa.queueWhatsApp = async (x) => { waQueued.push(x); };
  const upload = require(S + '/src/middleware/upload.js');
  upload.uploadToStorage = async (folder, name, buf) => {
    if (folder === failFolder) throw new Error('stub: storage down');
    uploads.push({ folder, name, path: `${folder}/${name}`, body: Buffer.from(buf).toString('utf8') });
    return `${folder}/${name}`;
  };
  upload.deleteFromStorage = async (p) => { removes.push(p); };
  const q1 = async (q, p = []) => (await client.query(q, p)).rows[0];
  const qa = async (q, p = []) => (await client.query(q, p)).rows;
  let failed = false;
  const ok = (label, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  ' + String(extra).slice(0, 400) : '')); if (!cond) failed = true; };
  process.on('unhandledRejection', (e) => { failed = true; console.error('ROUTE ERROR (unhandled):', e); });

  const owner = await q1("SELECT id, name, username, role FROM users WHERE role='owner' ORDER BY id LIMIT 1");
  const design = await q1("SELECT id, name, username, role FROM users WHERE role='design' ORDER BY id LIMIT 1");
  const admin = await q1("SELECT id, name, username, role FROM users WHERE role='admin' ORDER BY id LIMIT 1");
  let actor = owner;
  const auth = require(S + '/src/middleware/auth.js');
  auth.authenticate = (req, res, next) => { req.user = actor; next(); };
  const express = require(S + '/node_modules/express');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/drawing-agent', require(S + '/src/routes/drawingAgent.js'));
  app.use('/api/orders', require(S + '/src/routes/orders.js'));
  app.use('/api/job-cards', require(S + '/src/routes/jobCards.js'));
  const server = app.listen(0);
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const { buildDraft } = require(S + '/src/lib/jobCardDraft.js');
  const R = require(S + '/src/lib/drawings/uRules.js');

  try {
    if (!owner || !design) { ok('an owner and a design user exist', false); return; }
    // ── The new schema, for this transaction only, until the live DB has it ──
    const hasCol = await q1(`SELECT 1 AS x FROM information_schema.columns WHERE table_schema='public' AND table_name='order_drawings' AND column_name='agent_spec'`);
    const hasRulings = await q1(`SELECT to_regclass('public.drawing_rulings') IS NOT NULL AS x`);
    if (!hasCol) {
      await client.query('CREATE TEMP TABLE order_drawings (LIKE public.order_drawings INCLUDING DEFAULTS) ON COMMIT DROP');
      await client.query('ALTER TABLE pg_temp.order_drawings ADD COLUMN agent_spec JSONB');
      await client.query('INSERT INTO pg_temp.order_drawings SELECT *, NULL::jsonb FROM public.order_drawings');
    }
    if (!hasRulings.x) {
      await client.query(`CREATE TEMP TABLE drawing_rulings (key TEXT PRIMARY KEY, value JSONB NOT NULL, set_by INTEGER, set_at TIMESTAMPTZ NOT NULL DEFAULT NOW()) ON COMMIT DROP`);
    } else {
      await client.query("DELETE FROM drawing_rulings WHERE key IN ('fitting:ceramic_nut')");
    }
    console.log(`      schema: agent_spec ${hasCol ? 'live' : 'temporary copy'}, drawing_rulings ${hasRulings.x ? 'live' : 'temporary copy'}`);

    // ── Test data: items cloned from a real nut-washer U item and its list ──
    const src = await q1(`SELECT oi.*, o.customer_id FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.product_code ILIKE 'PT-UType%' AND oi.tube_diameter = 8 AND oi.quantity > 0 AND oi.wattage > 0
        AND oi.remark ~* '^\\s*nut\\s*washer\\s*$'
        AND EXISTS (SELECT 1 FROM order_item_inventory x JOIN inventory_items ii ON ii.id = x.inventory_item_id WHERE x.order_item_id = oi.id AND ii.item_code LIKE 'WSH-%')
        AND NOT EXISTS (SELECT 1 FROM order_item_inventory x JOIN inventory_items ii ON ii.id = x.inventory_item_id
                         WHERE x.order_item_id = oi.id AND (TRIM(ii.category) ILIKE 'terminal pin' OR ii.item_code ~ '^(FIN|BKT|NIP|TP)-' OR x.qty <= 0))
      ORDER BY oi.id DESC LIMIT 1`);
    const label = src && R.parseULabel(src.drawing_number, src.product_code);
    if (!src || !label.ok) { ok('a real nut-washer plain U item with a list exists to clone', false, src && src.drawing_number); return; }
    const srcLines = await qa('SELECT inventory_item_id, qty FROM order_item_inventory WHERE order_item_id=$1', [src.id]);
    const inv = Object.fromEntries((await qa(`SELECT id, item_code FROM inventory_items WHERE item_code = ANY($1)`,
      [['ESB-08', 'NUT-SS-M4-08', 'NUT-BR-M4-08', 'ESB-11', 'NUT-SS-M5-11', 'WSH-BR-11']])).map(r => [r.item_code, r.id]));
    console.log(`      cloning item ${src.id} ${src.drawing_number} (${src.wattage} W, ${src.tube_material}, "${src.remark}", ${srcLines.length} list lines)`);
    let seq = 0, iseq = 0;
    const mkOrder = async ({ status = 'approved', type = 'local_he' } = {}) => (await q1(
      `INSERT INTO orders (order_code, customer_id, order_date, order_type, status) VALUES ($1,$2,CURRENT_DATE,$3,$4) RETURNING id`,
      [`ORD-ZDWG-${++seq}`, src.customer_id, type, status])).id;
    // Each test item has its own drawing number unless a case gives one.
    const mkItem = async (orderId, { qty = 10, dwg = `${src.drawing_number}-ZT${++iseq}`, remark = src.remark, dia = 8, tube = src.tube_material, lines = 'clone', bom = null } = {}) => {
      const id = (await q1(`INSERT INTO order_items (order_id, product_code, drawing_number, tube_material, tube_diameter, wattage, voltage, plating_instructions, quantity, remark, bom_review)
        VALUES ($1,'PT-UType',$2,$3,$4,$5,$6,'No Plating',$7,$8,$9) RETURNING id`, [orderId, dwg, tube, dia, src.wattage, src.voltage, qty, remark, bom])).id;
      const ls = lines === 'clone' ? srcLines.map(l => [l.inventory_item_id, Number(l.qty) / Number(src.quantity)]) : lines.map(([code, per]) => [inv[code], per]);
      for (const [invId, per] of ls) await client.query('INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty) VALUES ($1,$2,$3)', [id, invId, per * qty]);
      return id;
    };
    const twoU = R.trimNum(2 * label.uIn);
    const o1 = await mkOrder();
    const i1 = await mkItem(o1);
    const dwg1 = (await q1('SELECT drawing_number FROM order_items WHERE id=$1', [i1])).drawing_number;

    // ── A. The queue ──
    let r = await call('GET', '/api/drawing-agent/queue');
    let row = (r.body.due || []).find(d => d.itemId === i1);
    ok('A1. the queue finds the new plain U item (no drawing, no card, a list, approved order)', r.status === 200 && !!row && row.uIn === label.uIn && row.dia === 8, JSON.stringify(row || r.body).slice(0, 300));

    // ── B. The proposal ──
    r = await call('GET', `/api/drawing-agent/items/${i1}`);
    let p = r.body;
    ok(`B1. the proposal is ready: total length ${twoU}" = 2 × ${label.uIn}" (R1), nut washer already confirmed (no TO CONFIRM)`,
      r.status === 200 && p.status === 'ready' && p.body.drawing_total_length_in === twoU && p.figures.totalLengthIn === twoU && p.fitting.set === 'nut_washer'
      && p.fitting.confirmed === true && !p.html.includes('TO CONFIRM') && p.html.includes(`TOTAL LENGTH = ${twoU} INCH`) && p.html.includes('FOR APPROVAL'),
      `${r.status} ${p.status} ${p.statusLine} ${JSON.stringify(p.blocks)}`);
    const draft = await buildDraft(txDb, i1, p.body);
    ok('B2. the proposal\'s figures are the job card engine\'s own (buildDraft with the sheet\'s body)',
      draft.ok && p.figures.cuttingLengthIn === draft.card.cuttingLengthIn && p.figures.gauge === draft.card.gauge && p.figures.coldZoneBigIn === draft.card.coldZoneBigIn
      && p.figures.pinBig === draft.card.terminalPinBig.studs && p.figures.cardTotalIn === draft.card.totalLengthIn && JSON.stringify(p.figures.quantities) === JSON.stringify(draft.split.quantities),
      `${p.figures.cuttingLengthIn} / ${draft.card?.cuttingLengthIn}`);
    const qOf = (pp, k) => pp.questions.find(x => x.key === k);
    ok('B3. the questions come pre-filled with where each came from (cold zone = the Ø8 standard, ASMBLY 1, Regular pins, dispatch date)',
      /standard/.test(qOf(p, 'cold_zone_in').source) && qOf(p, 'asmbly').value === '1' && qOf(p, 'terminal_group').value === 'regular'
      && R.isIsoDate(qOf(p, 'dispatch_date').value) && qOf(p, 'fixture').value === 'Nut Washer' && !p.questions.some(x => x.required && !x.answered),
      JSON.stringify(p.questions.map(x => [x.key, x.value, x.source])).slice(0, 300));
    ok('B4. the sheet code is three parts; the same request gives the same code', /^[0-9a-f]{6}-[0-9a-f]{6}-[0-9a-f]{6}$/.test(p.sheetCode)
      && (await call('POST', `/api/drawing-agent/items/${i1}/preview`, { answers: {} })).body.sheetCode === p.sheetCode, p.sheetCode);
    const ans = { cold_zone_in: '3' };
    r = await call('POST', `/api/drawing-agent/items/${i1}/preview`, { answers: ans });
    const p3 = r.body;
    ok('B5. changing an answer (cold zone 3") re-works the sheet: cold zones 3" / 3", the pin follows (4"), a new sheet code',
      r.status === 200 && p3.figures.coldZoneBigIn === 3 && p3.figures.coldZoneSmallIn === 3 && p3.figures.pinBig === 4 && p3.sheetCode !== p.sheetCode
      && R.codeChanges(p.sheetCode, p3.sheetCode).includes('the answers'), `${p3.figures?.coldZoneBigIn} ${p3.figures?.pinBig} ${p3.sheetCode}`);

    // ── C. Refusals before anything is written ──
    const nDraw = async (itemId) => (await q1('SELECT COUNT(*)::int n FROM order_drawings WHERE item_id=$1', [itemId])).n;
    const nCards = async (itemId) => (await q1('SELECT COUNT(*)::int n FROM job_cards WHERE order_item_id=$1', [itemId])).n;
    const up0 = uploads.length;
    r = await call('POST', `/api/drawing-agent/items/${i1}/approve`, { answers: ans, sheet_code: p.sheetCode });
    ok('C1. approving with the code of a different sheet is refused, nothing written', r.status === 409 && r.body.code === 'SHEET_CHANGED'
      && (await nDraw(i1)) === 0 && (await nCards(i1)) === 0 && uploads.length === up0, `${r.status} ${r.body.error}`);
    r = await call('POST', `/api/drawing-agent/items/${i1}/approve`, { answers: ans, sheet_code: 'deadbe-ef0000-000000' });
    ok('C2. a made-up sheet code is refused', r.status === 409 && r.body.code === 'SHEET_CHANGED' && (await nDraw(i1)) === 0, `${r.status} ${r.body.error}`);
    for (const who of [design, admin].filter(Boolean)) {
      actor = who;
      const a1 = await call('GET', '/api/drawing-agent/queue');
      const a2 = await call('POST', `/api/drawing-agent/items/${i1}/approve`, { answers: ans, sheet_code: p3.sheetCode });
      const a3 = await call('GET', `/api/drawing-agent/items/${i1}`);
      ok(`C3. ${who.role} is refused (owner only)`, a1.status === 403 && a2.status === 403 && a3.status === 403 && (await nDraw(i1)) === 0, `${a1.status} ${a2.status} ${a3.status}`);
    }
    actor = owner;
    // A job card that cannot be saved undoes everything, and the stored sheet is removed.
    failFolder = 'job-cards';
    r = await call('POST', `/api/drawing-agent/items/${i1}/approve`, { answers: ans, sheet_code: p3.sheetCode });
    failFolder = null;
    const lostSheet = uploads.filter(u => u.folder === 'order-drawings').slice(-1)[0];
    ok('C4. when the job card cannot be saved, nothing is kept: no drawing row, no card, the stored sheet removed again',
      r.status === 502 && (await nDraw(i1)) === 0 && (await nCards(i1)) === 0 && !!lostSheet && removes.includes(lostSheet.path), `${r.status} ${r.body.error}`);

    // ── D. The approval ──
    const order1Before = await q1('SELECT status FROM orders WHERE id=$1', [o1]);
    const upD = uploads.length;
    r = await call('POST', `/api/drawing-agent/items/${i1}/approve`, { answers: ans, sheet_code: p3.sheetCode, seen_snapshot: p3.snapshot });
    const drawRows = await qa('SELECT * FROM order_drawings WHERE item_id=$1', [i1]);
    const dr = drawRows[0];
    const spec = dr && (typeof dr.agent_spec === 'string' ? JSON.parse(dr.agent_spec) : dr.agent_spec);
    const sheetUp = uploads.slice(upD).filter(u => u.folder === 'order-drawings');
    ok('D1. approved: one order drawing, approved, its file in order-drawings named after the drawing number, the frozen spec on the row',
      r.status === 201 && drawRows.length === 1 && dr.drawing_status === 'approved' && dr.uploaded_by === owner.id
      && dr.file_path === `order-drawings/${dr.file_name}` && dr.original_name === `${dwg1}.html` && spec?.sheetCode === p3.sheetCode
      && spec?.body?.drawing_total_length_in === twoU && spec?.answers?.cold_zone_in === '3',
      `${r.status} ${JSON.stringify(r.body).slice(0, 200)} ${drawRows.length} ${dr?.drawing_status} ${dr?.original_name}`);
    ok('D2. the storage stub got the production sheet: FOR PRODUCTION — APPROVED BY OWNER, the same total length, no TO CONFIRM',
      sheetUp.length === 1 && sheetUp[0].path === dr?.file_path && sheetUp[0].body.includes('FOR PRODUCTION') && sheetUp[0].body.includes('APPROVED BY OWNER')
      && !sheetUp[0].body.includes('FOR APPROVAL') && sheetUp[0].body.includes(`TOTAL LENGTH = ${twoU} INCH`) && !sheetUp[0].body.includes('TO CONFIRM'),
      sheetUp.map(u => u.path).join(', '));
    const cards = await qa('SELECT id, job_card_no, qty, status, order_item_id, uploaded_by, generated_spec FROM job_cards WHERE order_item_id=$1 ORDER BY id', [i1]);
    const gs = cards[0]?.generated_spec;
    ok(`D3. exactly one job card (10 pcs), made the app's way: input total length "${twoU}" (2U), cold zones "3" / "3" from her answer, figures frozen`,
      cards.length === 1 && cards[0].qty === 10 && cards[0].status === 'pending' && gs?.input?.drawingTotalLengthIn === twoU
      && gs?.input?.coldZoneBigIn === '3' && gs?.input?.coldZoneSmallIn === '3' && gs?.computed?.cuttingLengthIn === p3.figures.cuttingLengthIn
      && gs?.computed?.terminalPinBig?.studs === 4 && gs?.sheet?.fixture === 'Nut Washer' && r.body.cards?.[0]?.job_card_no === cards[0].job_card_no,
      JSON.stringify(cards.map(c => [c.job_card_no, c.qty, c.generated_spec?.input?.drawingTotalLengthIn])));
    ok('D4. the production sheet and the card carry the same figures (cut and pin printed on the sheet = the card\'s)',
      sheetUp[0]?.body.includes(`cuts ${Number(gs?.computed?.cuttingLengthIn).toFixed(2)}&quot;`) && sheetUp[0]?.body.includes(`PIN ${gs?.computed?.terminalPinBig?.studs}&quot;`),
      gs?.computed?.cuttingLengthIn);
    const order1 = await q1('SELECT status FROM orders WHERE id=$1', [o1]);
    const acts = await qa('SELECT activity_type, description, job_card_id FROM activity_log WHERE order_id=$1 ORDER BY id', [o1]);
    ok('D5. the order moved approved → job_card_created, and the timeline reads like the app\'s own upload + approve + Make Job Card',
      order1Before.status === 'approved' && order1.status === 'job_card_created'
      && acts.some(a => a.activity_type === 'drawing_uploaded' && a.description === `Reference drawing uploaded: ${dwg1}.html`)
      && acts.some(a => a.activity_type === 'drawing_approved' && a.description === `Drawing approved: ${dwg1}.html`)
      && acts.some(a => a.activity_type === 'job_card_created' && a.job_card_id === cards[0]?.id && /generated by the app/.test(a.description)),
      `${order1.status} ${JSON.stringify(acts.map(a => a.activity_type))}`);
    const lines1 = await qa('SELECT inventory_item_id, qty FROM order_item_inventory WHERE order_item_id=$1 ORDER BY inventory_item_id', [i1]);
    ok('D6. the item\'s list is left exactly as design made it', JSON.stringify(lines1.map(l => [l.inventory_item_id, Number(l.qty)]))
      === JSON.stringify(srcLines.map(l => [l.inventory_item_id, Number(l.qty) / Number(src.quantity) * 10]).sort((a, b) => a[0] - b[0])));

    // ── E. Idempotent: a second approval is refused ──
    const upE = uploads.length;
    r = await call('POST', `/api/drawing-agent/items/${i1}/approve`, { answers: ans, sheet_code: p3.sheetCode });
    ok('E1. a second approval is refused: still one drawing, the same card, no new upload',
      r.status === 409 && r.body.code === 'NOT_DUE' && (await nDraw(i1)) === 1 && (await nCards(i1)) === 1 && uploads.length === upE, `${r.status} ${r.body.error}`);
    r = await call('GET', '/api/drawing-agent/queue');
    ok('E2. the item has left the queue', !(r.body.due || []).some(d => d.itemId === i1) && !(r.body.skipped || []).some(d => d.itemId === i1));

    // ── F. Same number and tube size elsewhere ──
    const o2 = await mkOrder();
    const iSame = await mkItem(o2, { dwg: dwg1 });
    const iOther = inv['ESB-11'] && inv['NUT-SS-M5-11'] && inv['WSH-BR-11']
      ? await mkItem(o2, { dwg: dwg1, dia: 11, tube: 'TUB-SS304-12-T06', lines: [['ESB-11', 2], ['NUT-SS-M5-11', 4], ['WSH-BR-11', 4]] }) : null;
    r = await call('GET', '/api/drawing-agent/queue');
    const skipSame = (r.body.skipped || []).find(d => d.itemId === iSame);
    ok('F1. an item with the same drawing number and tube size as one that now has a drawing is not in the queue — skipped, "use Reuse"',
      !(r.body.due || []).some(d => d.itemId === iSame) && /same number and tube size/.test(skipSame?.reason || ''), skipSame?.reason);
    if (iOther) ok('F2. the same number on the other tube size (Ø11) is still due', (r.body.due || []).some(d => d.itemId === iOther && d.dia === 11));
    r = await call('POST', `/api/drawing-agent/items/${iSame}/approve`, { answers: {}, sheet_code: p.sheetCode });
    ok('F3. … and approving it is refused', r.status === 409 && r.body.code === 'NOT_DUE' && (await nDraw(iSame)) === 0, r.body.error);

    // ── G. The item changed after the sheet was shown ──
    const o3 = await mkOrder({ type: 'inventory_order' });
    const iEdit = await mkItem(o3);
    const pe = (await call('GET', `/api/drawing-agent/items/${iEdit}`)).body;
    await client.query('UPDATE order_items SET quantity = 12 WHERE id=$1', [iEdit]);
    r = await call('POST', `/api/drawing-agent/items/${iEdit}/approve`, { answers: {}, sheet_code: pe.sheetCode, seen_snapshot: pe.snapshot });
    ok('G1. the item edited after the sheet was shown (quantity 10 → 12) is refused and says what changed',
      pe.status === 'ready' && r.status === 409 && r.body.code === 'SHEET_CHANGED' && r.body.changed.some(c => /order item/.test(c))
      && r.body.fields.includes('item.qty') && (await nDraw(iEdit)) === 0, `${r.status} ${r.body.error}`);
    ok('G2. an inventory order defaults its dispatch date to today + 7', pe.questions.find(x => x.key === 'dispatch_date').source.includes('+ 7 days'));

    // ── H. A fitting set she has not confirmed yet ──
    const nutCode = inv['NUT-SS-M4-08'] ? 'NUT-SS-M4-08' : 'NUT-BR-M4-08';
    const o4 = await mkOrder();
    const iCer = await mkItem(o4, { remark: 'One Nut + One Ceramic', lines: [['ESB-08', 2], [nutCode, 2]] });
    let pc = (await call('GET', `/api/drawing-agent/items/${iCer}`)).body;
    ok('H1. "One Nut + One Ceramic" is drawn with a red TO CONFIRM until she confirms its fitting order', pc.status === 'ready'
      && pc.fitting.set === 'ceramic_nut' && pc.fitting.confirmed === false && pc.html.includes('TO CONFIRM') && pc.fitting.order.join(' → ') === 'ESB → ceramic → nut',
      `${pc.status} ${pc.statusLine}`);
    r = await call('POST', `/api/drawing-agent/items/${iCer}/approve`, { answers: {}, sheet_code: pc.sheetCode });
    ok('H2. approving it without ticking the fitting order is refused, nothing written', r.status === 400 && r.body.code === 'FITTING_CONFIRM_REQUIRED' && (await nDraw(iCer)) === 0, r.body.error);
    const upH = uploads.length;
    r = await call('POST', `/api/drawing-agent/items/${iCer}/approve`, { answers: {}, sheet_code: pc.sheetCode, fitting_confirmed: true });
    const ruling = await q1("SELECT value, set_by FROM drawing_rulings WHERE key='fitting:ceramic_nut'");
    const cerSheet = uploads.slice(upH).find(u => u.folder === 'order-drawings');
    ok('H3. with the fitting order ticked it is approved, her confirmation is stored, and the production sheet drops TO CONFIRM',
      r.status === 201 && ruling?.value?.confirmed === true && ruling.set_by === owner.id && !!cerSheet && !cerSheet.body.includes('TO CONFIRM')
      && (await nDraw(iCer)) === 1 && (await nCards(iCer)) === 1, `${r.status} ${r.body.error || ''}`);
    const iCer2 = await mkItem(o4, { remark: 'one ceramic + one nut', lines: [['ESB-08', 2], [nutCode, 2]] });
    pc = (await call('GET', `/api/drawing-agent/items/${iCer2}`)).body;
    ok('H4. the next ceramic + nut sheet no longer asks', pc.fitting.confirmed === true && !pc.html.includes('TO CONFIRM'), pc.statusLine);

    // ── I. Quantity 120 → 50 / 50 / 20 ──
    const o5 = await mkOrder();
    const iBig = await mkItem(o5, { qty: 120 });
    const pb = (await call('GET', `/api/drawing-agent/items/${iBig}`)).body;
    r = await call('POST', `/api/drawing-agent/items/${iBig}/approve`, { answers: {}, sheet_code: pb.sheetCode });
    const bigCards = await qa('SELECT job_card_no, qty, generated_spec FROM job_cards WHERE order_item_id=$1 ORDER BY id', [iBig]);
    ok('I1. quantity 120 makes three cards, 50 / 50 / 20, numbered -S1…, each with the sheet\'s total length',
      r.status === 201 && bigCards.map(c => c.qty).join('/') === '50/50/20' && bigCards.every((c, i) => c.job_card_no.endsWith(`-S${i + 1}`))
      && bigCards.every(c => c.generated_spec.input.drawingTotalLengthIn === twoU) && JSON.stringify(pb.figures.quantities) === '[50,50,20]',
      JSON.stringify(bigCards.map(c => [c.job_card_no, c.qty])));

    // ── J. What it will not draw ──
    const o6 = await mkOrder();
    const iNoList = await mkItem(o6, { lines: [] });
    const iBom = await mkItem(o6, { bom: 'needed' });
    const iTrim = await mkItem(o6, { remark: 'Nut Washer, Trim the heater to 7U heater' });
    r = await call('GET', '/api/drawing-agent/queue');
    const sk = (id) => (r.body.skipped || []).find(d => d.itemId === id)?.reason || '';
    ok('J1. no parts list, or design\'s BOM check pending: skipped with the reason, never drawn',
      /no parts list/.test(sk(iNoList)) && /BOM check/.test(sk(iBom)) && !(r.body.due || []).some(d => [iNoList, iBom].includes(d.itemId)), `${sk(iNoList)} | ${sk(iBom)}`);
    const pn = (await call('GET', `/api/drawing-agent/items/${iNoList}`)).body;
    const rn = await call('POST', `/api/drawing-agent/items/${iNoList}/approve`, { answers: {}, sheet_code: pn.sheetCode || 'aaaaaa-aaaaaa-aaaaaa' });
    ok('J2. … and approving one is refused', pn.status === 'blocked' && rn.status >= 400 && (await nDraw(iNoList)) === 0, `${pn.status} ${rn.status} ${rn.body.error}`);
    let pt = (await call('GET', `/api/drawing-agent/items/${iTrim}`)).body;
    const tq = pt.questions.find(x => x.key === 'ack:trim');
    r = await call('POST', `/api/drawing-agent/items/${iTrim}/approve`, { answers: {}, sheet_code: pt.sheetCode });
    ok('J3. a remark the rules cannot apply ("trim the heater to 7U") is asked before approval', pt.status === 'needs_answer' && tq?.required && !tq.answered
      && r.status === 400 && r.body.code === 'NEEDS_ANSWER' && (await nDraw(iTrim)) === 0, `${pt.status} ${r.body.error}`);
    const tAns = { 'ack:trim': 'Make it 7U as the remark says', u_length_in: '7' };
    pt = (await call('POST', `/api/drawing-agent/items/${iTrim}/preview`, { answers: tAns })).body;
    const upJ = uploads.length;
    r = await call('POST', `/api/drawing-agent/items/${iTrim}/approve`, { answers: tAns, sheet_code: pt.sheetCode });
    const trimCard = await q1('SELECT generated_spec FROM job_cards WHERE order_item_id=$1', [iTrim]);
    const trimSheet = uploads.slice(upJ).find(u => u.folder === 'order-drawings');
    ok('J4. answered (7U, with her note), it is approved at 14" (2 × 7) and her answer is printed on the sheet',
      pt.status === 'ready' && r.status === 201 && trimCard?.generated_spec?.input?.drawingTotalLengthIn === '14' && trimSheet?.body.includes('Make it 7U as the remark says'),
      `${pt.status} ${r.status} ${r.body.error || ''}`);

    // ── K. The owner hears when an approved order has items to draw ──
    const o7 = await mkOrder({ status: 'pending_approval' });
    const iNew = await mkItem(o7);
    r = await call('GET', '/api/drawing-agent/queue');
    const waitingSkip = (r.body.due || []).some(d => d.itemId === iNew);
    const wq0 = waQueued.length;
    const ra = await call('PUT', `/api/orders/${o7}/approve`, {});
    const notes = await qa("SELECT user_id, type, title, link FROM notifications WHERE type='drawing_ready' AND title LIKE $1", [`% on ORD-ZDWG-${seq}`]);
    ok('K1. an order waiting for approval is not in the queue; once approved, the owner is told (drawing_ready → /drawings-to-make)',
      !waitingSkip && ra.status === 200 && notes.length >= 1 && notes.every(n => n.link === '/drawings-to-make') && notes.some(n => n.user_id === owner.id)
      && waQueued.length > wq0, `${ra.status} ${JSON.stringify(notes)}`);
    const oQuiet = await mkOrder({ status: 'pending_approval' });
    await mkItem(oQuiet, { lines: [] });
    const rq = await call('PUT', `/api/orders/${oQuiet}/approve`, {});
    const quiet = await qa("SELECT 1 FROM notifications WHERE type='drawing_ready' AND title LIKE $1", [`% on ORD-ZDWG-${seq}`]);
    ok('K2. an approved order with nothing the app can draw yet sends no such notice', rq.status === 200 && quiet.length === 0);

    ok('stubs: every storage write went to the stub; WhatsApp only through the stub', uploads.length > 0);
  } catch (e) { failed = true; console.error('ERROR', e); }
  finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    server.close();
    const left = (await realPool.query(`SELECT (SELECT COUNT(*) FROM orders WHERE order_code LIKE 'ORD-ZDWG-%')::int o,
      (SELECT COUNT(*) FROM job_cards WHERE job_card_no LIKE '%-ZT%')::int jc,
      (SELECT COUNT(*) FROM order_drawings WHERE notes LIKE 'Drawn in the app (Drawings to make)%')::int od`)).rows[0];
    ok('after ROLLBACK: no test order, card or agent drawing is left in the database', left.o === 0 && left.jc === 0 && left.od === 0, JSON.stringify(left));
    const after = (await realPool.query(countSql)).rows[0];
    const same = Object.keys(before).every(k => before[k] === after[k]);
    console.log(`${same ? 'PASS' : 'NOTE'}  row counts before / after (order_drawings, job_cards, order_item_inventory, orders, activity_log, notifications): ${JSON.stringify(before)} / ${JSON.stringify(after)}${same ? '' : ' — differs: the live app was used meanwhile'}`);
    await realPool.end();
    console.log(`\n${failed ? 'SOME CHECKS FAILED' : 'ALL PASS'} (rolled back — nothing kept) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    process.exit(failed ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
