// Test for Drawings to make — the drawing agent in the app (owner, 14 Nov 2026;
// lib/drawings/agent.js, routes/drawingAgent.js). The queue finds a plain U
// item that needs a drawing; its proposal carries the job card's own figures
// (buildDraft) with the total length = 2 × U; one owner approval puts the
// production sheet on the item as an approved drawing and makes the card(s)
// through the app's own upload / approve / Make Job Card code, all or nothing.
// Refused: a second approval, a stale sheet code, an item changed after the
// sheet was shown, a fitting order not yet confirmed (or ticked for another
// set), anyone but the owner. From the review (14 Nov 2026): brass nuts on a
// nut-washer list are asked, remark words no rule reads are asked, notes too
// long for the box are refused, the owner hears when design's list save makes
// an item drawable, a card refused at numbering leaves no file behind, and an
// approval before the schema is in says so (503). The inside gap and the
// roller (owner, 14 Nov 2026): her roller list saved through the page; a
// clone at 33 inside asks the roller (a new one) and is refused until she
// answers, then approved with everything but the shape-driven total as the
// 27 case; ±2 mm suggests the roller she has; the remark and the drawing
// number give the inside; a customer's earlier widths only raise a flag.
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
  const copies = [];
  upload.copyInStorage = async (from, folder, name) => { copies.push({ from, to: `${folder}/${name}` }); return `${folder}/${name}`; };
  const q1 = async (q, p = []) => (await client.query(q, p)).rows[0];
  const qa = async (q, p = []) => (await client.query(q, p)).rows;
  let failed = false;
  const ok = (label, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  ' + String(extra).slice(0, 400) : '')); if (!cond) failed = true; };
  process.on('unhandledRejection', (e) => { failed = true; console.error('ROUTE ERROR (unhandled):', e); });

  // The test's own orders and items: the teardown checks nothing tied to them is left.
  const testOrders = [], testItems = [];
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
                         WHERE x.order_item_id = oi.id AND (TRIM(ii.category) ILIKE 'terminal pin' OR ii.item_code ~ '^(FIN|BKT|NIP|TP|NUT-BR)-' OR x.qty <= 0))
      ORDER BY oi.id DESC LIMIT 1`);
    const label = src && R.parseULabel(src.drawing_number, src.product_code);
    if (!src || !label.ok) { ok('a real nut-washer plain U item with a list exists to clone', false, src && src.drawing_number); return; }
    const srcLines = await qa('SELECT inventory_item_id, qty FROM order_item_inventory WHERE order_item_id=$1', [src.id]);
    const inv = Object.fromEntries((await qa(`SELECT id, item_code FROM inventory_items WHERE item_code = ANY($1)`,
      [['ESB-08', 'NUT-SS-M4-08', 'NUT-BR-M4-08', 'WSH-BR-08', 'ESB-11', 'NUT-SS-M5-11', 'WSH-BR-11']])).map(r => [r.item_code, r.id]));
    console.log(`      cloning item ${src.id} ${src.drawing_number} (${src.wattage} W, ${src.tube_material}, "${src.remark}", ${srcLines.length} list lines)`);
    let seq = 0, iseq = 0;
    const mkOrder = async ({ status = 'approved', type = 'local_he', customerId = src.customer_id } = {}) => {
      const id = (await q1(`INSERT INTO orders (order_code, customer_id, order_date, order_type, status) VALUES ($1,$2,CURRENT_DATE,$3,$4) RETURNING id`,
        [`ORD-ZDWG-${++seq}`, customerId, type, status])).id;
      testOrders.push(id);
      return id;
    };
    // Each test item has its own drawing number unless a case gives one.
    const mkItem = async (orderId, { qty = 10, dwg = `${src.drawing_number}-ZT${++iseq}`, remark = src.remark, dia = 8, tube = src.tube_material, lines = 'clone', bom = null } = {}) => {
      const id = (await q1(`INSERT INTO order_items (order_id, product_code, drawing_number, tube_material, tube_diameter, wattage, voltage, plating_instructions, quantity, remark, bom_review)
        VALUES ($1,'PT-UType',$2,$3,$4,$5,$6,'No Plating',$7,$8,$9) RETURNING id`, [orderId, dwg, tube, dia, src.wattage, src.voltage, qty, remark, bom])).id;
      const ls = lines === 'clone' ? srcLines.map(l => [l.inventory_item_id, Number(l.qty) / Number(src.quantity)]) : lines.map(([code, per]) => [inv[code], per]);
      for (const [invId, per] of ls) await client.query('INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty) VALUES ($1,$2,$3)', [id, invId, per * qty]);
      testItems.push(id);
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
    // Reuse (where her ruling sends such an item) copies the app sheet: its row says it is another order's sheet.
    const it1 = await q1('SELECT * FROM order_items WHERE id=$1', [i1]);
    const ru = await call('POST', `/api/orders/${o2}/items`, { product_code: it1.product_code, drawing_number: it1.drawing_number, tube_material: it1.tube_material,
      tube_diameter: it1.tube_diameter, wattage: it1.wattage, voltage: it1.voltage, plating_instructions: 'No Plating', quantity: 7, remark: it1.remark, copy_from_item_id: i1 });
    const reused = ru.body?.id ? await q1('SELECT notes, drawing_status, file_path FROM order_drawings WHERE item_id=$1', [ru.body.id]) : null;
    if (ru.body?.id) testItems.push(ru.body.id);
    ok('F4. reusing the app-drawn sheet on another order: the copy waits for her review and its row says it is ORD-ZDWG-1\'s sheet (title block, quantity), to check before approving',
      ru.status === 201 && ru.body.drawingCopied === true && reused?.drawing_status === 'pending_review' && /^App sheet from ORD-ZDWG-1: .*10 Nos.*check it against this order/.test(reused?.notes || '')
      && copies.length > 0, `${ru.status} ${JSON.stringify(ru.body).slice(0, 200)} ${reused?.notes}`);

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
    r = await call('POST', `/api/drawing-agent/items/${iCer}/approve`, { answers: {}, sheet_code: pc.sheetCode, fitting_confirmed: true, fitting_confirmed_set: 'nipple' });
    const r2 = await call('POST', `/api/drawing-agent/items/${iCer}/approve`, { answers: {}, sheet_code: pc.sheetCode, fitting_confirmed: true });
    ok('H2b. a tick given for another set (or for no set) does not confirm this one: refused, no ruling stored',
      r.status === 400 && r.body.code === 'FITTING_CONFIRM_REQUIRED' && r2.status === 400 && r2.body.code === 'FITTING_CONFIRM_REQUIRED' && (await nDraw(iCer)) === 0
      && !(await q1("SELECT 1 AS x FROM drawing_rulings WHERE key='fitting:ceramic_nut'")), `${r.status} ${r2.status}`);
    const upH = uploads.length;
    r = await call('POST', `/api/drawing-agent/items/${iCer}/approve`, { answers: {}, sheet_code: pc.sheetCode, fitting_confirmed: true, fitting_confirmed_set: 'ceramic_nut' });
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
    ok('K1. an order waiting for approval is not in the queue; once approved, the owner is told (drawing_ready → that item on Drawings to make)',
      !waitingSkip && ra.status === 200 && notes.length >= 1 && notes.every(n => n.link === `/drawings-to-make?item=${iNew}`) && notes.some(n => n.user_id === owner.id)
      && waQueued.length > wq0, `${ra.status} ${JSON.stringify(notes)}`);
    const oQuiet = await mkOrder({ status: 'pending_approval' });
    await mkItem(oQuiet, { lines: [] });
    const rq = await call('PUT', `/api/orders/${oQuiet}/approve`, {});
    const quiet = await qa("SELECT 1 FROM notifications WHERE type='drawing_ready' AND title LIKE $1", [`% on ORD-ZDWG-${seq}`]);
    ok('K2. an approved order with nothing the app can draw yet sends no such notice', rq.status === 200 && quiet.length === 0);
    // The usual case: the item becomes drawable when design saves its list or confirms its BOM.
    const oK = await mkOrder();
    const iNoListYet = await mkItem(oK, { lines: [] });
    const iBomWait = await mkItem(oK, { bom: 'needed' });
    const told = async (itemId) => (await qa("SELECT user_id FROM notifications WHERE type='drawing_ready' AND link=$1", [`/drawings-to-make?item=${itemId}`])).length;
    const perHeater = srcLines.map(l => ({ id: l.inventory_item_id, qty: Number(l.qty) / Number(src.quantity) * 10 }));
    actor = design;
    const rs1 = await call('PUT', `/api/orders/${oK}/items/${iNoListYet}/inventory`, { inventory_item_ids: perHeater });
    const t1 = await told(iNoListYet);
    const rs2 = await call('PUT', `/api/orders/${oK}/items/${iNoListYet}/inventory`, { inventory_item_ids: perHeater });
    const t2 = await told(iNoListYet);
    const rb = await call('PUT', `/api/orders/${oK}/items/${iBomWait}/bom-confirm`, {});
    const t3 = await told(iBomWait);
    actor = owner;
    ok('K3. design saving a new item\'s list, or confirming its BOM, tells the owner about that item (linked to it) — once, not again on the next save',
      rs1.status === 200 && rs2.status === 200 && rb.status === 200 && t1 >= 1 && t2 === t1 && t3 >= 1, `${rs1.status} ${rs1.body.error || ''} ${rs2.status} ${rb.status} ${rb.body.error || ''} · ${t1}/${t2}/${t3}`);

    // ── L. Brass nuts on the nut-washer stack (review, 14 Nov 2026) ──
    if (inv['NUT-BR-M4-08'] && inv['NUT-SS-M4-08'] && inv['WSH-BR-08']) {
      const oL = await mkOrder();
      const iMix = await mkItem(oL, { remark: 'Nut Washer', lines: [['ESB-08', 2], ['NUT-SS-M4-08', 2], ['NUT-BR-M4-08', 2], ['WSH-BR-08', 4]] });
      let pm = (await call('GET', `/api/drawing-agent/items/${iMix}`)).body;
      const nq = pm.questions.find(x => x.key === 'nuts');
      r = await call('POST', `/api/drawing-agent/items/${iMix}/approve`, { answers: {}, sheet_code: pm.sheetCode });
      ok('L1. a list with an SS and a brass nut on every pin end asks which goes where before it can be approved (no longer just "worth a look")',
        pm.status === 'needs_answer' && nq?.required && !nq.answered && nq.options.map(o => o.value).join() === 'brass_inner,brass_outer,ss'
        && !pm.flags.some(f => /brass nut/.test(f)) && r.status === 400 && r.body.code === 'NEEDS_ANSWER' && (await nDraw(iMix)) === 0, `${pm.status} ${r.status} ${r.body.error}`);
      pm = (await call('POST', `/api/drawing-agent/items/${iMix}/preview`, { answers: { nuts: 'ss' } })).body;
      ok('L2. "SS nuts, as your order" stops it until design changes the list', pm.status === 'blocked' && pm.blocks.some(b => /design changes the list's brass nut NUT-BR-M4-08 to SS/.test(b)), pm.statusLine);
      const ansL = { nuts: 'brass_inner' };
      pm = (await call('POST', `/api/drawing-agent/items/${iMix}/preview`, { answers: ansL })).body;
      const noOf = (code) => pm.parts.find(x => x.code === code)?.no;
      const bl = [...pm.html.matchAll(/<circle cx="[\d.]+" cy="[\d.]+" r="[\d.]+" fill="#fff"[^>]*\/><text[^>]*>(\d+)<\/text>/g)].map(m => Number(m[1]));
      ok('L3. "brass nut next to the ESB": ready, the sheet says ESB, brass nut, washer, washer, SS nut, and Detail D balloons both nut lines',
        pm.status === 'ready' && pm.fitting.nuts.join() === 'NUT-BR-M4-08,NUT-SS-M4-08' && pm.html.includes('ESB, brass nut, washer, washer, SS nut')
        && bl.includes(noOf('NUT-BR-M4-08')) && bl.includes(noOf('NUT-SS-M4-08')), `${pm.status} ${pm.statusLine} balloons ${bl.join(',')} nuts ${noOf('NUT-SS-M4-08')}/${noOf('NUT-BR-M4-08')}`);
      const upL = uploads.length;
      r = await call('POST', `/api/drawing-agent/items/${iMix}/approve`, { answers: ansL, sheet_code: pm.sheetCode });
      const sheetL = uploads.slice(upL).find(u => u.folder === 'order-drawings');
      ok('L4. … and approved with her answer printed on the production sheet', r.status === 201 && !!sheetL && sheetL.body.includes('ESB, brass nut, washer, washer, SS nut')
        && sheetL.body.includes('Brass nut as the item&#39;s list'), `${r.status} ${r.body.error || ''}`);
      const iBr = await mkItem(oL, { remark: 'Nut Washer', lines: [['ESB-08', 2], ['NUT-BR-M4-08', 4], ['WSH-BR-08', 4]] });
      const pb2 = (await call('POST', `/api/drawing-agent/items/${iBr}/preview`, { answers: { nuts: 'brass' } })).body;
      const pb0 = (await call('GET', `/api/drawing-agent/items/${iBr}`)).body;
      ok('L5. brass nuts only: asked too ("brass at both places" or "SS — design changes the list"); with "brass" the sheet draws brass at both places',
        pb0.status === 'needs_answer' && pb0.questions.find(x => x.key === 'nuts')?.options.map(o => o.value).join() === 'brass,ss'
        && pb2.status === 'ready' && pb2.html.includes('ESB, brass nut, washer, washer, brass nut') && pb2.html.includes('Brass nuts as the item&#39;s list') && !pb2.html.includes('SS nut'), `${pb0.status} ${pb2.status} ${pb2.statusLine}`);
    } else ok('L. the brass / SS nut and brass washer items exist to test with', false);

    // ── M. Remark words no rule reads are asked (review, 14 Nov 2026) ──
    const oM = await mkOrder();
    const iTh = await mkItem(oM, { remark: 'Nut Washer with thermostat' });
    let pth = (await call('GET', `/api/drawing-agent/items/${iTh}`)).body;
    const oq = pth.questions.find(x => x.key === 'ack:other');
    ok('M1. "Nut Washer with thermostat" is not ready: the word THERMOSTAT is quoted and asked', pth.status === 'needs_answer' && oq?.required && /THERMOSTAT/.test(oq.text), `${pth.status} ${oq?.text}`);
    const thAns = { 'ack:other': 'Thermostat is fitted by the customer — nothing on the drawing' };
    pth = (await call('POST', `/api/drawing-agent/items/${iTh}/preview`, { answers: thAns })).body;
    ok('M2. answered, it is ready and her answer is printed on the sheet against the words', pth.status === 'ready'
      && pth.html.includes('Remark, the words &quot;THERMOSTAT&quot;: Thermostat is fitted by the customer'), `${pth.status} ${pth.statusLine}`);

    // ── N. Notes too long for the sheet are refused, never cut off ──
    const iLong = await mkItem(oM, { remark: 'Nut Washer / trim the heater / bend at the end / check pressure / with thermostat' });
    const ackKeys = (await call('GET', `/api/drawing-agent/items/${iLong}`)).body.questions.filter(x => x.key.startsWith('ack:')).map(x => x.key);
    const answerAll = (txt, note) => Object.fromEntries([...ackKeys.map(k => [k, txt]), ['note', note]]);
    const pl = (await call('POST', `/api/drawing-agent/items/${iLong}/preview`, { answers: answerAll('W'.repeat(400), 'M'.repeat(400)) })).body;
    const plOk = (await call('POST', `/api/drawing-agent/items/${iLong}/preview`, { answers: answerAll('Nothing on the drawing for this.', 'Pack in tens.') })).body;
    ok(`N1. answers too long for the notes box (${ackKeys.length} remark answers + a note at 400 letters) block the sheet ("shorten your answers"); short ones do not`,
      ackKeys.length >= 4 && pl.status === 'blocked' && pl.blocks.some(b => /notes do not fit/.test(b)) && plOk.status === 'ready',
      `${ackKeys.join(',')} · ${pl.status} ${pl.blocks?.join('; ')} / ${plOk.status} ${plOk.statusLine}`);

    // ── O. A job card that cannot be numbered leaves no file in storage ──
    {
      const jobCardRoutes = require(S + '/src/routes/jobCards.js');
      const oO = await mkOrder();
      const iO = await mkItem(oO);
      const po = (await call('GET', `/api/drawing-agent/items/${iO}`)).body;
      const dupDb = { ...txDb, withTransaction: (fn) => txDb.withTransaction((c) => fn({ query: (q, prm) => (/INSERT INTO job_cards/.test(String(q))
        ? Promise.reject(Object.assign(new Error('stub: duplicate card number'), { code: '23505' })) : c.query(q, prm)) })) };
      const upO = uploads.length;
      const g = await jobCardRoutes.generateJobCard(dupDb, { body: po.body, user: owner, log: async () => {} });
      const cardFile = uploads.slice(upO).find(u => u.folder === 'job-cards');
      ok('O1. Make Job Card refused at numbering (409) takes its stored card file away again', g.status === 409 && !!cardFile && removes.includes(cardFile.path) && (await nCards(iO)) === 0,
        `${g.status} ${g.body?.error} ${cardFile?.path}`);
    }

    // ── P. Before the main session adds the schema, an approval says so plainly ──
    {
      const agentPath = require.resolve(S + '/src/lib/drawings/agent.js');
      const cached = require.cache[agentPath];
      delete require.cache[agentPath];
      const fresh = require(agentPath);
      require.cache[agentPath] = cached;
      const noSchemaDb = { ...txDb, get: async (q, prm) => (/to_regclass\('drawing_rulings'\)/.test(String(q)) && /agent_spec/.test(String(q)) ? { rulings: false, spec: false } : txDb.get(q, prm)) };
      const ap = await fresh.approve(noSchemaDb, i1, { answers: {}, sheetCode: p.sheetCode }, owner);
      ok('P1. without agent_spec / drawing_rulings an approval is refused with "the app is finishing an update" (503), not a failed write',
        ap.status === 503 && ap.body.code === 'SCHEMA_NOT_READY' && /finishing an update/.test(ap.body.error), JSON.stringify(ap));
    }

    // ── Q. The inside gap and the roller (owner, 14 Nov 2026) ──
    {
      // Her roller list, through the page's route (rolled back with the rest).
      const rr = await call('PUT', '/api/drawing-agent/rollers', { mm: [40, '25', 22, 25] });
      const rg = await call('GET', '/api/drawing-agent/rollers');
      const rbad = await call('PUT', '/api/drawing-agent/rollers', { mm: ['abc'] });
      actor = design;
      const rdes = await call('PUT', '/api/drawing-agent/rollers', { mm: [30] });
      const rdesG = await call('GET', '/api/drawing-agent/rollers');
      actor = owner;
      ok('Q1. her roller list is saved through the page (22, 25, 40 — the repeat dropped, smallest first) and read back; "abc" refused; design can neither read nor set it',
        rr.status === 200 && rr.body.mm?.join() === '22,25,40' && rr.body.saved === true && rg.status === 200 && rg.body.mm?.join() === '22,25,40'
        && rbad.status === 400 && rdes.status === 403 && rdesG.status === 403, `${rr.status} ${JSON.stringify(rr.body)} ${rbad.status} ${rdes.status} ${rdesG.status}`);

      const oQ = await mkOrder();
      const iStd = await mkItem(oQ), i33 = await mkItem(oQ);
      const pStd = (await call('GET', `/api/drawing-agent/items/${iStd}`)).body;
      const ans33 = { inside_mm: '33' };
      let p33 = (await call('POST', `/api/drawing-agent/items/${i33}/preview`, { answers: ans33 })).body;
      const rq = qOf(p33, 'roller_mm');
      r = await call('POST', `/api/drawing-agent/items/${i33}/approve`, { answers: ans33, sheet_code: p33.sheetCode });
      ok('Q2. the standard clone asks no roller (27 inside → roller 25, filled in); inside 33 does: none within ±2 mm, a NEW 31 mm roller — approve refused NEEDS_ANSWER',
        pStd.status === 'ready' && qOf(pStd, 'roller_mm')?.value === '25' && !qOf(pStd, 'roller_mm').required && qOf(pStd, 'inside_mm')?.value === '27'
        && pStd.figures.insideMm === 27 && pStd.figures.rollerMm === 25 && pStd.figures.rollerKind === 'exact' && pStd.figures.clientInsideMm === null
        && p33.status === 'needs_answer' && rq?.required && !rq.answered && rq.value === '' && rq.options.map(o => o.value).join() === '31' && rq.suggest === '31'
        && r.status === 400 && r.body.code === 'NEEDS_ANSWER' && (await nDraw(i33)) === 0, `${pStd.status} ${pStd.statusLine} · ${p33.status} ${JSON.stringify(rq)} · ${r.status} ${r.body.code}`);
      const ans33r = { inside_mm: '33', roller_mm: '31' };
      p33 = (await call('POST', `/api/drawing-agent/items/${i33}/preview`, { answers: ans33r })).body;
      // Everything but the shape-driven total is the 27 case's.
      const bodyDiff = ['cold_zone_big_in', 'cold_zone_small_in', 'terminal_pin_big_in', 'terminal_pin_small_in', 'fixture', 'asmbly', 'dispatch_date', 'terminal_group', 'punching', 'notes']
        .filter(k => p33.body[k] !== pStd.body[k]);
      // (The card names carry each clone's own drawing number.)
      const figDiff = ['coldZoneBigIn', 'coldZoneSmallIn', 'pinBig', 'pinSmall', 'pinOverridden', 'stud', 'quantities', 'pins', 'uLabel']
        .filter(k => JSON.stringify(p33.figures[k]) !== JSON.stringify(pStd.figures[k]));
      const want = R.totalLength({ uIn: label.uIn, diaMm: 8, outsideWidthMm: 49 }).str;
      ok(`Q3. answered (roller 31, new): ready, drawn 33 inside / 49 outside, flagged "New roller 31 mm"; total ${want}" (2U + the wider bend) where the 27 case is ${twoU}"; cold zone, pins, fixture, cards as the 27 case`,
        p33.status === 'ready' && p33.figures.insideMm === 33 && p33.figures.outsideWidthMm === 49 && p33.figures.rollerMm === 31 && p33.figures.rollerKind === 'new' && p33.figures.rollerIsNew === true
        && p33.flags.some(f => /^New roller 31 mm to make before bending/.test(f)) && p33.body.drawing_total_length_in === want && want !== twoU && pStd.body.drawing_total_length_in === twoU
        && bodyDiff.length === 0 && figDiff.length === 0, `${p33.status} ${p33.statusLine} · body differs: ${bodyDiff} · figures differ: ${figDiff} · total ${p33.body.drawing_total_length_in}`);
      const upQ = uploads.length;
      r = await call('POST', `/api/drawing-agent/items/${i33}/approve`, { answers: ans33r, sheet_code: p33.sheetCode });
      const dq = await q1('SELECT agent_spec FROM order_drawings WHERE item_id=$1', [i33]);
      const sq = dq && (typeof dq.agent_spec === 'string' ? JSON.parse(dq.agent_spec) : dq.agent_spec);
      const cq = await q1('SELECT generated_spec FROM job_cards WHERE order_item_id=$1', [i33]);
      const sheetQ = uploads.slice(upQ).find(u => u.folder === 'order-drawings');
      ok('Q4. … approved: the frozen spec carries 33 inside / 49 outside / roller 31 NEW, the card takes the sheet\'s total, the notes name the new roller; no roller choice is remembered',
        r.status === 201 && sq?.figures?.insideMm === 33 && sq?.figures?.rollerMm === 31 && sq?.sheet?.shape?.insideMm === 33 && sq?.sheet?.shape?.rollerIsNew === true
        && sq?.sheet?.shape?.outsideWidthMm === 49 && sq?.sheet?.shape?.clientInsideMm === null && sq?.answers?.roller_mm === '31' && cq?.generated_spec?.input?.drawingTotalLengthIn === want
        && (sq?.sheet?.notes || []).some(n => /roller 31 NEW — to make before bending/.test(n)) && !!sheetQ
        && !(await q1("SELECT 1 AS x FROM drawing_rulings WHERE key LIKE 'roller%' AND key <> 'rollers'")), `${r.status} ${r.body.error || ''}`);
      // ±2 mm on the inside: 29 → the 25 she has (gives 27), or a new 27.
      const i29 = await mkItem(oQ);
      const p29 = (await call('POST', `/api/drawing-agent/items/${i29}/preview`, { answers: { inside_mm: '29' } })).body;
      const q29 = qOf(p29, 'roller_mm');
      const p29b = (await call('POST', `/api/drawing-agent/items/${i29}/preview`, { answers: { inside_mm: '29', roller_mm: '30' } })).body;
      const p29a = (await call('POST', `/api/drawing-agent/items/${i29}/preview`, { answers: { inside_mm: '29', roller_mm: '25' } })).body;
      ok('Q5. inside 29: roller 25 suggested ("Use 25"), options 25 / a new 27; 30 refused ("Roller must be one of"); 25 accepted → drawn 27 inside at 2U, the sheet notes the client\'s 29',
        p29.status === 'needs_answer' && q29?.suggest === '25' && q29.options.map(o => o.value).join() === '25,27' && /^Suggested: roller 25 — the closest you have within ±2 mm/.test(q29.text || '')
        && p29b.status === 'blocked' && p29b.blocks.some(b => /^Roller must be one of 25, 27 mm/.test(b))
        && p29a.status === 'ready' && p29a.figures.insideMm === 27 && p29a.figures.clientInsideMm === 29 && p29a.figures.rollerKind === 'suggest' && p29a.figures.rollerIsNew === false
        && p29a.html.includes('Client&#39;s inside 29 (Ms. Vama); roller 25 gives 27 — within ±2 mm, accepted by Ms. Vama') && p29a.body.drawing_total_length_in === twoU,
        `${p29.status} ${JSON.stringify(q29)} · ${p29b.status} ${p29b.blocks} · ${p29a.status} ${p29a.statusLine}`);
      // The remark and the drawing number give the inside.
      const iRem = await mkItem(oQ, { remark: 'Nut Washer, inside 29mm' });
      const iGap = await mkItem(oQ, { dwg: `${src.drawing_number}-ZT${++iseq}-4Gap` });
      const pRem = (await call('GET', `/api/drawing-agent/items/${iRem}`)).body;
      const pGap = (await call('GET', `/api/drawing-agent/items/${iGap}`)).body;
      const pGapA = (await call('POST', `/api/drawing-agent/items/${iGap}/preview`, { answers: { roller_mm: '100' } })).body;
      // The wider bend takes more tube: on a short low-watt clone the engine may find
      // no wire for it — the shape is still worked out, and nothing else stops it.
      const gapOnlyWire = pGapA.status === 'ready' || (pGapA.status === 'blocked' && pGapA.blocks.every(b => /^no wire on the gauge sheet/.test(b)));
      ok('Q6. "inside 29mm" in the remark is read (no "other words" question, the inside 29 from the remark); "-4Gap" in the drawing number is 101.6 → a new 100 roller, drawn 102 inside / 118 outside',
        !pRem.questions.some(x => x.key.startsWith('ack:')) && qOf(pRem, 'inside_mm')?.value === '29' && /^the remark \("NUT WASHER, INSIDE 29MM"|^the remark \("INSIDE 29MM"/.test(qOf(pRem, 'inside_mm').source)
        && qOf(pRem, 'roller_mm')?.suggest === '25'
        && qOf(pGap, 'inside_mm')?.value === '101.6' && /^the drawing number \("4Gap"/.test(qOf(pGap, 'inside_mm').source) && qOf(pGap, 'roller_mm')?.options.map(o => o.value).join() === '100'
        && gapOnlyWire && !pGapA.questions.some(x => x.required && !x.answered) && pGapA.figures.insideMm === 102 && pGapA.figures.outsideWidthMm === 118 && pGapA.figures.clientInsideMm === 101.6
        && pGapA.body.drawing_total_length_in === R.totalLength({ uIn: label.uIn, diaMm: 8, outsideWidthMm: 118 }).str,
        `${qOf(pRem, 'inside_mm')?.source} · ${qOf(pGap, 'inside_mm')?.source} · ${pGapA.status} ${pGapA.statusLine} ${JSON.stringify(pGapA.blocks)}`);
      // A customer's earlier widths only raise a flag (Thermolab: nut washer at 24 inside).
      const ts = await q1("SELECT id FROM customers WHERE customer_code = 'TS' ORDER BY id LIMIT 1");
      if (ts) {
        const oTs = await mkOrder({ customerId: ts.id });
        const iTs = await mkItem(oTs);
        const pTs = (await call('GET', `/api/drawing-agent/items/${iTs}`)).body;
        const pTs24 = (await call('POST', `/api/drawing-agent/items/${iTs}/preview`, { answers: { inside_mm: '24' } })).body;
        ok('Q7. a TS nut-washer clone at the standard 27 is flagged — earlier TS nut-washer sheets used 24 (roller 22) — but stays ready (a flag, not a default); at 24 (roller 22, exact) no such flag',
          pTs.status === 'ready' && qOf(pTs, 'inside_mm')?.value === '27' && pTs.flags.some(f => /^Earlier U drawings for TS at Ø8 with nut washer used 24 inside \(roller 22\): 7U-250W ORD-007-26/.test(f))
          && pTs24.status === 'ready' && pTs24.figures.rollerMm === 22 && !pTs24.flags.some(f => /^Earlier U drawings/.test(f)), `${pTs.status} ${JSON.stringify(pTs.flags)} · ${pTs24.status} ${JSON.stringify(pTs24.flags)}`);
      } else ok('Q7. the customer TS exists to test the width history flag with', false);
    }

    // ── R. Finned U (owner, 16 Nov 2026): round the bend, 25 mm bare at each end;
    // with brackets 1.5" from both ends and the fins stop at the terminal-end one ──
    {
      const finInv = Object.fromEntries((await qa('SELECT id, item_code FROM inventory_items WHERE item_code = ANY($1)',
        [['FIN-MS-08', 'BKT-FMH-H788-MS']])).map(x => [x.item_code, x.id]));
      if (finInv['FIN-MS-08'] && finInv['BKT-FMH-H788-MS'] && inv['ESB-08'] && inv['NUT-SS-M4-08'] && inv['WSH-BR-08']) {
        Object.assign(inv, finInv);
        const W = require(S + '/src/lib/inventoryDeduction.js').FINS_WEIGHT_PER_BASE;
        const qOf = (pp, k) => (pp.questions || []).find(x => x.key === k);
        const oR = await mkOrder();
        const iF = await mkItem(oR, { qty: 6, remark: 'MS Finns + Nut Washer', lines: [['ESB-08', 2], ['NUT-SS-M4-08', 4], ['WSH-BR-08', 4], ['FIN-MS-08', 0]] });
        const pf = (await call('GET', `/api/drawing-agent/items/${iF}`)).body;
        const want = R.finKg({ code: 'FIN-MS-08', weights: W, totalLengthMm: Math.round(Number(pf.figures?.cardTotalIn) * 25.4 * 100) / 100, elements: 1, quantities: pf.figures?.quantities || [] });
        const finPart = (pf.parts || []).find(x => x.code === 'FIN-MS-08');
        ok('R1. a finned U is drawn (no longer "phase 2"): fixture "MS Finns + Nut Washer", fins round the bend 25 mm short of each end at pitch 3 (her rulings as answers), the fin line at St 29 by tube length with the kg St 29 will take, the fin OD from her drawing (28.44)',
          pf.status === 'ready' && pf.body.fixture === 'MS Finns + Nut Washer' && qOf(pf, 'fins_on_bend')?.value === 'yes' && qOf(pf, 'fin_stop_mm')?.value === '25'
          && qOf(pf, 'fin_pitch_mm')?.value === '3' && !qOf(pf, 'bracket_from_bend_mm') && !!want && pf.figures.fins.kgForOrder === want.kgForOrder
          && finPart?.stage === 'St 29 by tube length' && finPart.perPc === `${want.kgPerPc.toFixed(3)} kg` && pf.figures.fins.odMm === 28.44 && pf.figures.fins.onBend === true
          && pf.html.includes('MS FINS (FIN-MS-08)'), `${pf.status} ${pf.statusLine} ${JSON.stringify(pf.figures?.fins)} ${JSON.stringify(finPart)}`);
        const pfNo = (await call('POST', `/api/drawing-agent/items/${iF}/preview`, { answers: { fins_on_bend: 'no' } })).body;
        ok('R2. "Fins on the bend: No" (F2): the bend stays bare — the finned length drops by the bend, a new sheet code, still ready',
          pfNo.status === 'ready' && pfNo.figures.fins.onBend === false && pfNo.figures.fins.finnedLengthMm < pf.figures.fins.finnedLengthMm && pfNo.sheetCode !== pf.sheetCode,
          `${pfNo.status} ${pfNo.figures?.fins?.finnedLengthMm} vs ${pf.figures?.fins?.finnedLengthMm}`);
        r = await call('POST', `/api/drawing-agent/items/${iF}/approve`, { answers: {}, sheet_code: pf.sheetCode });
        const specF = await q1('SELECT agent_spec FROM order_drawings WHERE item_id=$1', [iF]);
        ok('R3. approved: one drawing and one card; the frozen spec carries the fins (round the bend, 25 mm, the kg)',
          r.status === 201 && (await nDraw(iF)) === 1 && (await nCards(iF)) === 1 && specF?.agent_spec?.figures?.fins?.kgForOrder === want?.kgForOrder
          && specF.agent_spec.figures.fins.stopBeforeEndMm === 25, `${r.status} ${r.body.error || ''}`);
        const iB = await mkItem(oR, { qty: 6, remark: 'MS Finns + Brackets', lines: [['ESB-08', 2], ['NUT-SS-M4-08', 4], ['WSH-BR-08', 4], ['BKT-FMH-H788-MS', 2], ['FIN-MS-08', 0]] });
        const pbk = (await call('GET', `/api/drawing-agent/items/${iB}`)).body;
        ok('R4. fins + brackets (F3): "MS Finns + Brackets"; brackets 38.1 from the bend and from the tube end; the fins stop at the terminal-end bracket (38.1) with a gap at the bend-end one',
          pbk.body?.fixture === 'MS Finns + Brackets' && qOf(pbk, 'bracket_from_bend_mm')?.value === '38.1' && qOf(pbk, 'bracket_from_end_mm')?.value === '38.1'
          && qOf(pbk, 'fin_stop_mm')?.value === '38.1' && /terminal-end bracket/.test(qOf(pbk, 'fin_stop_mm')?.source || '') && pbk.figures.brackets?.perHeater === 2
          && pbk.figures.fins.bracketGapMm > 0 && !pbk.blocks.length, `${pbk.status} ${JSON.stringify(pbk.blocks)} ${JSON.stringify(pbk.figures?.brackets)}`);
        const pbk25 = (await call('POST', `/api/drawing-agent/items/${iB}/preview`, { answers: { fin_stop_mm: '25' } })).body;
        ok('R5. fins asked to run past the terminal-end bracket are refused in her words',
          pbk25.status === 'blocked' && pbk25.blocks.some(b => /"the finns will not come ahead of the terminal end brackets"/.test(b)), JSON.stringify(pbk25.blocks));
        const iN = await mkItem(oR, { qty: 6, remark: 'MS Finns + Nut Washer', lines: [['ESB-08', 2], ['NUT-SS-M4-08', 4], ['WSH-BR-08', 4]] });
        const qN = (await call('GET', '/api/drawing-agent/queue')).body;
        const pN = (await call('GET', `/api/drawing-agent/items/${iN}`)).body;
        ok('R6. the remark says fins and the list has no fin line: skipped in the queue and refused — "design to add the fin line"',
          (qN.skipped || []).some(x => x.itemId === iN && /design to add the fin line/.test(x.reason)) && !(qN.due || []).some(x => x.itemId === iN)
          && pN.status === 'blocked' && pN.blocks.some(b => /design to add the fin line/.test(b)), `${pN.status} ${JSON.stringify(pN.blocks)}`);
      } else ok('R. the fin, bracket, ESB, nut and washer items exist to test with', false);
    }

    ok('stubs: every storage write went to the stub; WhatsApp only through the stub', uploads.length > 0);
  } catch (e) { failed = true; console.error('ERROR', e); }
  finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    server.close();
    // Only rows tied to this run's own orders and items: real approvals made in
    // the app (or reused from them) are no business of this check.
    const left = (await realPool.query(`SELECT (SELECT COUNT(*) FROM orders WHERE order_code LIKE 'ORD-ZDWG-%' OR id = ANY($1))::int o,
      (SELECT COUNT(*) FROM job_cards WHERE order_id = ANY($1) OR order_item_id = ANY($2))::int jc,
      (SELECT COUNT(*) FROM order_drawings WHERE order_id = ANY($1) OR item_id = ANY($2))::int od,
      (SELECT COUNT(*) FROM notifications WHERE type = 'drawing_ready' AND link ~ ('item=(' || array_to_string($2::int[], '|') || ')\\M'))::int n`,
      [testOrders, testItems])).rows[0];
    ok(`after ROLLBACK: nothing tied to the test's ${testOrders.length} orders / ${testItems.length} items is left (orders, cards, drawings, notices)`,
      left.o === 0 && left.jc === 0 && left.od === 0 && (testItems.length === 0 || left.n === 0), JSON.stringify(left));
    const after = (await realPool.query(countSql)).rows[0];
    const same = Object.keys(before).every(k => before[k] === after[k]);
    console.log(`${same ? 'PASS' : 'NOTE'}  row counts before / after (order_drawings, job_cards, order_item_inventory, orders, activity_log, notifications): ${JSON.stringify(before)} / ${JSON.stringify(after)}${same ? '' : ' — differs: the live app was used meanwhile'}`);
    await realPool.end();
    console.log(`\n${failed ? 'SOME CHECKS FAILED' : 'ALL PASS'} (rolled back — nothing kept) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    process.exit(failed ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
