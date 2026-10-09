// Test for terminal pins per job card (owner, 6 Oct 2026): every job card has
// its OWN terminal-pin rows — the item list's 'Terminal Pin' lines for its
// share by default (design's pick at drawing upload, whole pieces), or what
// design changes for that card. A pin short of stock holds the card's material
// slip and tells the owner and Design / QC once, until one of them presses OK;
// a rework-bin shortfall never does. At the card's last stage its rows leave
// stock under source 'terminal' (the card on the row) and the list's share is
// settled as waived, so a BOM correction never gives back a pin design changed
// for one card. Heavy terminal pins, nuts and washers stay on the list exactly
// as before; TRAIN placeholders are never picked; a finished-goods card has no
// rows at all and its slip is unchanged.
//
// Runs inside one transaction that is ROLLED BACK, on its own made-up items
// (ZZTEST-TP-…), orders, lines, cards and lists, so no real stock row, slip
// print, notification or timeline line is kept. Routes run through express as
// the owner, the Design / QC login or a production user (made-up ones are added
// for the run when the database has none). The WhatsApp copy of each alert is
// recorded, not queued.
//
// Needs a database the new server has started on once (initDB adds
// job_card_terminals and the terminals_* columns) — it refuses otherwise.
//   node scripts/test_terminals.cjs
const path = require('path');
const fs = require('fs');
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
  const logs = [];
  // Both stubs BEFORE any other module loads: they are destructured at require
  // time, and the real logActivity writes through the pool, outside this transaction.
  dbmod.getDB = () => txDb;
  dbmod.logActivity = async (orderId, jc, type, desc, by) => { logs.push({ orderId, jc, type, desc, by }); };
  // The WhatsApp copy of a notification is recorded here, never queued — the
  // real one uses its own connection, which this rollback would not cover.
  const wa = require(S + '/src/lib/whatsapp.js');
  const waCalls = [];
  wa.queueWhatsApp = async (p) => { waCalls.push(p); };
  const q1 = async (q, p = []) => (await client.query(q, p)).rows[0];
  const qa = async (q, p = []) => (await client.query(q, p)).rows;
  let failed = false;
  const ok = (label, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  ' + String(extra).slice(0, 300) : '')); if (!cond) failed = true; };
  // An async route that throws is not caught by express 4: count it as a failure
  // (the request then times out below and the run ends, rolled back).
  process.on('unhandledRejection', (e) => { failed = true; console.error('ROUTE ERROR (unhandled):', e); });

  // Routes run as whoever `actor` is at the time: the owner unless a call says otherwise.
  const owner = await q1("SELECT id, name, role FROM users WHERE role='owner' ORDER BY id LIMIT 1");
  let actor = owner;
  const auth = require(S + '/src/middleware/auth.js');
  auth.authenticate = (req, res, next) => { req.user = actor; next(); };

  const rework = require(S + '/src/lib/rework.js');
  const { applyBomCorrection } = require(S + '/src/lib/bomCorrection.js');
  const { approveSplitRequest } = require(S + '/src/services/actions/splitRequests.js');
  const express = require(S + '/node_modules/express');
  const app = express();
  app.use(express.json());
  app.use('/api/job-cards', require(S + '/src/routes/jobCards.js'));
  app.use('/api/qc', require(S + '/src/routes/qc.js'));
  app.use('/api/orders', require(S + '/src/routes/orders.js'));
  // Orders up to ORD-160-26 keep the old pin rules; sections A–I test those, so
  // every test order counts as old until section J switches the cut-off.
  const { PINS_RULE } = require(S + '/src/lib/terminals.js');
  PINS_RULE.afterOrderId = 1e12;
  const server = app.listen(0);
  const base = 'http://127.0.0.1:' + server.address().port;
  // The stages that must be done before stage 29, read from the route itself.
  const MANDATORY = JSON.parse(fs.readFileSync(S + '/src/routes/jobCards.js', 'utf8').match(/const MANDATORY_STAGES = (\[[^\]]+\])/)[1]);

  try {
    // ── Ready? The terminals table and columns must exist ──
    const cols = (await qa(`SELECT column_name FROM information_schema.columns WHERE table_name='job_cards' AND column_name = ANY($1)`,
      [['terminals_short_at', 'terminals_ok_by', 'terminals_ok_at', 'terminals_ok_note', 'last_stage_taken_at']])).length;
    const table = await q1(`SELECT 1 AS x FROM information_schema.tables WHERE table_name='job_card_terminals'`);
    const tcol = await q1(`SELECT 1 AS x FROM information_schema.columns WHERE table_name='inventory_transactions' AND column_name='job_card_id'`);
    if (cols < 5 || !table || !tcol || !owner) {
      ok('Database ready for terminal pins (start the new server on it once first) and an owner user exists', false,
        `job_cards columns ${cols}/5, job_card_terminals ${!!table}, inventory_transactions.job_card_id ${!!tcol}, owner ${!!owner}`);
      return;
    }
    const uid = owner.id;

    // The two logins the alert goes to are ROLES, never user ids: every owner
    // and every 'design' user. A production user shows who is NOT told. Made up
    // for the run when the database has none (rolled back with the rest).
    const mkUser = (name, username, role) => q1(
      `INSERT INTO users (name, username, password_hash, role) VALUES ($1,$2,'zztest',$3) RETURNING id, name, role`, [name, username, role]);
    const design = (await q1("SELECT id, name, role FROM users WHERE role='design' ORDER BY id LIMIT 1")) || await mkUser('ZZTEST Design / QC', 'zztest_design', 'design');
    const floor = (await q1("SELECT id, name, role FROM users WHERE role='production' ORDER BY id LIMIT 1")) || await mkUser('ZZTEST Production', 'zztest_production', 'production');
    const alertUsers = (await qa("SELECT id FROM users WHERE role IN ('owner','design') ORDER BY id")).map(u => u.id);

    const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
    const sameIds = (a, b) => a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);
    const stock = async (id) => Number((await q1('SELECT current_stock FROM inventory_items WHERE id=$1', [id])).current_stock);
    const setStock = (id, n) => client.query('UPDATE inventory_items SET current_stock=$2 WHERE id=$1', [id, n]);
    const line = async (oi, inv) => q1(
      `SELECT qty::float q, COALESCE(qty_deducted,0)::float d, COALESCE(qty_waived,0)::float w,
              COALESCE(rework_qty,0)::float rework_qty, COALESCE(rework_deducted,0)::float rework_deducted
         FROM order_item_inventory WHERE order_item_id=$1 AND inventory_item_id=$2`, [oi, inv]);
    const cardRow = async (id) => q1('SELECT * FROM job_cards WHERE id=$1', [id]);
    const bin = async (inv) => Number((await q1('SELECT COALESCE(SUM(qty),0) n FROM inventory_rework_bins WHERE item_id=$1', [inv])).n);
    const snap = async (ids) => { const o = {}; for (const id of ids) o[id] = await stock(id); return o; };
    const moved = async (s) => { const out = []; for (const [id, v] of Object.entries(s)) { const n = await stock(id); if (!near(n, v)) out.push(`item ${id}: ${v} → ${n}`); } return out.join('; '); };
    const call = async (method, url, body, as = owner) => {
      actor = as;
      const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
      actor = owner;
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    // The card's own pin rows, straight from the table.
    const rowsOf = (card) => qa(
      `SELECT inventory_item_id AS inv, qty::float AS q, source, updated_by FROM job_card_terminals WHERE job_card_id=$1 ORDER BY inventory_item_id`, [card]);
    const rowQ = (rs, inv) => rs.find(x => x.inv === inv) || null;
    // The 'terminal'-source stock rows of a pin for a card.
    const termRows = (card, inv) => qa(
      `SELECT quantity::float q, notes, job_card_id, order_item_id, source FROM inventory_transactions
        WHERE item_id=$1 AND job_card_id=$2 AND source='terminal' ORDER BY id`, [inv, card]);
    const alerts = (card) => qa(
      `SELECT user_id, title, body, link FROM notifications WHERE type='terminals_short' AND link=$1 ORDER BY id`, [`/job-cards/${card}`]);
    const waFor = (card) => waCalls.filter(w => w.type === 'terminals_short' && w.ref?.type === 'terminals_short' && w.ref?.id === card);
    const prints = async (card) => Number((await q1('SELECT COUNT(*) n FROM material_slip_prints WHERE job_card_id=$1', [card])).n);
    const terminals = (card) => `/api/job-cards/${card}/terminals`;
    const slipOf = (card) => `/api/job-cards/${card}/slip`;

    const mkItem = async (code, cat, s, unit) => (await q1(
      `INSERT INTO inventory_items (item_code, name, unit, category, current_stock, unit_cost) VALUES ($1,$1,$2,$3,$4,1) RETURNING id`, [code, unit, cat, s])).id;
    const mkOrder = async (code, type = 'local_he') => (await q1(
      `INSERT INTO orders (order_code, customer_id, order_date, order_type, status, material_deduction)
       VALUES ($1, (SELECT MIN(id) FROM customers), CURRENT_DATE, $2, 'in_progress', FALSE) RETURNING id`, [code, type])).id;
    const mkLine = async (order, qty, dwg) => (await q1(
      `INSERT INTO order_items (order_id, quantity, drawing_number) VALUES ($1,$2,$3) RETURNING id`, [order, qty, dwg])).id;
    const mkCard = async (order, oi, no, qty, { status = 'in_progress', dwg = null, fg = false } = {}) => (await q1(
      `INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, drawing_no, is_fg)
       VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,$6,$7) RETURNING id`, [no, order, oi, qty, status, dwg, fg])).id;
    const putLine = (oi, inv, qty, rw = 0) => client.query(
      `INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty, qty_deducted, rework_qty) VALUES ($1,$2,$3,0,$4)`, [oi, inv, qty, rw]);
    // Stages marked done on the card directly (the floor's checks are not under test here).
    const tick = async (card, stages) => {
      for (const st of stages) await client.query(
        `INSERT INTO production_checklist (job_card_id, stage_no, done, done_at) VALUES ($1,$2,1,NOW())
         ON CONFLICT (job_card_id, stage_no) DO UPDATE SET done=1, done_at=NOW()`, [card, st]);
    };
    const split = async (card, qty) => {
      const sr = (await q1(`INSERT INTO job_card_split_requests (job_card_id, qty, reason, status) VALUES ($1,$2,'test','pending') RETURNING id`, [card, qty])).id;
      return approveSplitRequest(txDb, { requestId: sr, actor: owner });
    };

    // The made-up pins. WO's category carries a trailing space: the category
    // match is TRIM / case-insensitive, as inventory categories are typed.
    const WH  = await mkItem('ZZTEST-TP-WH', 'Terminal Pin', 500, 'pcs');
    const WO  = await mkItem('ZZTEST-TP-WO', 'Terminal Pin ', 500, 'pcs');
    const X   = await mkItem('ZZTEST-TP-X', 'Terminal Pin', 500, 'pcs');          // the pin design picks instead
    const LOW = await mkItem('ZZTEST-TP-LOW', 'Terminal Pin', 3, 'pcs');          // short of stock
    const TRN = await mkItem('ZZTEST-TP-TRAIN', 'Terminal Pin', 1000, 'pcs');     // TRAIN placeholder
    const HV  = await mkItem('ZZTEST-TP-HV', 'Heavy Terminal Pin', 500, 'pcs');   // stays on the list as today
    const NUT = await mkItem('ZZTEST-TP-NUT', 'Nut', 2000, 'pcs');
    const RW  = await mkItem('ZZTEST-TP-RW', 'Terminal Pin', 0, 'pcs');            // none in stock — the list takes it from the rework bin
    const MK  = await mkItem('ZZTEST-TP-MK', 'Terminal Pin', 0, 'pcs');            // none in stock — marked from the bin in Change pins
    const pins = [WH, WO, X, LOW, TRN, HV, NUT, RW, MK];

    // ════ A. Two cards of 50 on an item of 100: lazy seed, design's change, the slip, the last stage, a correction ════
    // List per piece: 1 WH + 1 WO terminal pin, 1 heavy pin, 4 nuts.
    const oA = await mkOrder('ZZT-TA');
    const oiA = await mkLine(oA, 100, 'ZZTEST-DWG-TA');
    await putLine(oiA, WH, 100); await putLine(oiA, WO, 100); await putLine(oiA, HV, 100); await putLine(oiA, NUT, 400);
    const A1 = await mkCard(oA, oiA, 'ZZT-TA1', 50, { dwg: 'ZZTEST-DWG-TA' });
    const A2 = await mkCard(oA, oiA, 'ZZT-TA2', 50, { dwg: 'ZZTEST-DWG-TA' });
    ok('A0. nothing is seeded until a card is read', (await rowsOf(A1)).length === 0 && (await rowsOf(A2)).length === 0);

    let r = await call('GET', terminals(A1));
    let rs = await rowsOf(A1);
    ok('A1. first read seeds the card\'s pins from the list: 100 WH + 100 WO on 100 pcs, a card of 50 → 50 WH + 50 WO, from list',
      r.status === 200 && rs.length === 2 && rowQ(rs, WH)?.q === 50 && rowQ(rs, WH)?.source === 'list' && rowQ(rs, WO)?.q === 50 && rowQ(rs, WO)?.source === 'list',
      `${r.status} ${JSON.stringify(rs)}`);
    ok('A1. the heavy pin and the nuts stay on the list only — no row of their own', !rowQ(rs, HV) && !rowQ(rs, NUT));
    ok('A1. the answer: two rows with stock 500, the list\'s two pin lines for reference (100, share 50), nothing short, the owner may edit and OK',
      r.body.rows.length === 2 && r.body.rows.every(x => x.current_stock === 500 && x.short === false)
      && r.body.list.length === 2 && r.body.list.every(l => l.qty === 100 && l.share === 50)
      && r.body.short.length === 0 && r.body.held === false && r.body.ok === null && r.body.short_at === null
      && r.body.editable === true && r.body.can_ok === true && r.body.no_terminals === false, JSON.stringify(r.body).slice(0, 300));
    ok('A1. the sibling card is still unread: no rows of its own yet', (await rowsOf(A2)).length === 0);
    r = await call('GET', terminals(A1));
    ok('A1. read again: still two rows — never seeded twice', r.body.rows.length === 2 && (await rowsOf(A1)).length === 2);

    r = await call('GET', terminals(A2), null, floor);
    rs = await rowsOf(A2);
    ok('A2. production reads the sibling: seeded 50 / 50 from the list, read-only for the floor (no edit, no OK)',
      r.status === 200 && rowQ(rs, WH)?.q === 50 && rowQ(rs, WO)?.q === 50 && r.body.editable === false && r.body.can_ok === false, `${r.status} ${JSON.stringify(rs)}`);

    // ── Design changes one card's pins ──
    r = await call('PUT', terminals(A1), { rows: [{ inventory_item_id: X, qty: 50 }, { inventory_item_id: WO, qty: 60 }] }, design);
    rs = await rowsOf(A1);
    ok('A3. Design / QC changes the card to 50 X + 60 WO: saved as design\'s change, stamped with who',
      r.status === 200 && rs.length === 2 && rowQ(rs, X)?.q === 50 && rowQ(rs, X)?.source === 'design' && rowQ(rs, WO)?.q === 60 && rowQ(rs, WO)?.source === 'design'
      && !rowQ(rs, WH) && rs.every(x => x.updated_by === design.id) && r.body.rows.every(x => x.updated_by_name === design.name && x.source === 'design'),
      `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    ok('A3. on the card\'s timeline, with what it was before',
      logs.some(l => l.jc === A1 && l.type === 'terminals_changed' && l.by === design.id
        && /ZZTEST-TP-X × 50, ZZTEST-TP-WO × 60 \(was: ZZTEST-TP-WH × 50, ZZTEST-TP-WO × 50\)/.test(l.desc)),
      logs.filter(l => l.jc === A1).map(l => l.desc).join(' | '));
    rs = await rowsOf(A2);
    ok('A3. the sibling card keeps its list pins 50 / 50, untouched', rowQ(rs, WH)?.q === 50 && rowQ(rs, WO)?.q === 50 && rs.every(x => x.source === 'list'));

    // ── What a save refuses ──
    const bad = (rows, as = owner) => call('PUT', terminals(A1), { rows }, as);
    let v = await bad([{ inventory_item_id: HV, qty: 50 }]);
    ok('A4. a heavy terminal pin is refused — only category Terminal Pin goes here', v.status === 400 && /only 'Terminal Pin'/.test(v.body.error || ''), v.body.error);
    v = await bad([{ inventory_item_id: TRN, qty: 50 }]);
    ok('A4. a TRAIN placeholder is refused', v.status === 400 && /TRAIN placeholder/.test(v.body.error || ''), v.body.error);
    v = await bad([{ inventory_item_id: X, qty: 20 }, { inventory_item_id: X, qty: 30 }]);
    ok('A4. the same pin twice is refused', v.status === 400 && /twice/.test(v.body.error || ''), v.body.error);
    v = await bad([{ inventory_item_id: X, qty: 2.5 }]);
    ok('A4. 2.5 pieces refused — whole numbers', v.status === 400 && /whole number/.test(v.body.error || ''), v.body.error);
    v = await bad([{ inventory_item_id: X, qty: 0 }]);
    ok('A4. zero refused', v.status === 400, v.body.error);
    v = await bad([]);
    ok('A4. no rows refused — a card needs at least one pin', v.status === 400 && /at least one/.test(v.body.error || ''), v.body.error);
    v = await bad(Array.from({ length: 21 }, () => ({ inventory_item_id: X, qty: 1 })));
    ok('A4. 21 rows refused', v.status === 400 && /at most 20/.test(v.body.error || ''), v.body.error);
    v = await bad([{ inventory_item_id: X, qty: 50 }], floor);
    ok('A4. production cannot edit', v.status === 403);
    rs = await rowsOf(A1);
    ok('A4. none of it changed the card: still 50 X + 60 WO, one change on the timeline',
      rowQ(rs, X)?.q === 50 && rowQ(rs, WO)?.q === 60 && rs.length === 2 && logs.filter(l => l.jc === A1 && l.type === 'terminals_changed').length === 1);

    r = await call('PUT', terminals(A1), [{ inventory_item_id: X, qty: 50 }, { inventory_item_id: WO, qty: 50 }], design);
    rs = await rowsOf(A1);
    ok('A5. a bare array is accepted; WO back at the list\'s 50 reads "from list" again, X stays design\'s',
      r.status === 200 && rowQ(rs, WO)?.q === 50 && rowQ(rs, WO)?.source === 'list' && rowQ(rs, X)?.source === 'design', `${r.status} ${JSON.stringify(rs)}`);
    r = await call('PUT', terminals(A1), { rows: [{ inventory_item_id: X, qty: 50 }, { inventory_item_id: WO, qty: 60 }] }, design);
    ok('A5. …and back to 50 X + 60 WO for the rest of the run', r.status === 200 && rowQ(await rowsOf(A1), WO)?.q === 60);

    // ── The slip ──
    let sl = await call('POST', slipOf(A1), {}, floor);
    const tr = (inv) => (sl.body.terminals || []).find(t => t.inventory_item_id === inv) || {};
    ok('A6. the slip (stock fine) prints: its pins are the CARD\'s own — 50 X + 60 WO exact, not apportioned — with stock and source',
      sl.status === 200 && sl.body.printNo === 1 && sl.body.isReprint === false && (sl.body.terminals || []).length === 2
      && tr(X).qty === 50 && tr(X).source === 'design' && tr(X).rework_qty === 0 && tr(X).current_stock === 500 && tr(X).item_code === 'ZZTEST-TP-X'
      && tr(WO).qty === 60 && tr(WO).rework_qty === 0 && (await prints(A1)) === 1, `${sl.status} ${JSON.stringify(sl.body.terminals)}`);
    ok('A6. the list\'s Terminal Pin lines are left out of the apportioned part; the heavy pin and the nuts stay in it',
      (sl.body.lines || []).length === 2 && sl.body.lines.every(l => l.category !== 'Terminal Pin')
      && sl.body.lines.some(l => l.item_code === 'ZZTEST-TP-HV') && sl.body.lines.some(l => l.item_code === 'ZZTEST-TP-NUT'), JSON.stringify((sl.body.lines || []).map(l => l.item_code)));
    ok('A6. no alert — nothing is short', (await alerts(A1)).length === 0 && !logs.some(l => l.jc === A1 && l.type === 'terminals_short') && (await cardRow(A1)).terminals_short_at === null);

    // ── The last stage takes the card's pins ──
    await tick(A1, MANDATORY);
    let s0 = await snap(pins);
    r = await call('PUT', `/api/job-cards/${A1}/checklist/29`, { done: true }, floor);
    let c = await cardRow(A1);
    ok('A7. stage 29: the card takes ITS pins — 50 X and 60 WO leave stock, none of the list\'s WH',
      r.status === 200 && !!c.last_stage_taken_at && near(await stock(X), s0[X] - 50) && near(await stock(WO), s0[WO] - 60) && near(await stock(WH), s0[WH]),
      `${r.status} ${JSON.stringify(r.body)} | ${await moved(s0)}`);
    ok('A7. the rest of the list as before: 200 nuts and 50 heavy pins for the card\'s half', near(await stock(NUT), s0[NUT] - 200) && near(await stock(HV), s0[HV] - 50), await moved(s0));
    let tx = await termRows(A1, X);
    ok('A7. the pin\'s stock row: source terminal, tied to the card and the order line, noted "Terminal pins (JC …)"',
      tx.length === 1 && tx[0].source === 'terminal' && tx[0].job_card_id === A1 && tx[0].order_item_id === oiA && near(tx[0].q, 50)
      && tx[0].notes === 'Order: ZZT-TA | Dwg: ZZTEST-DWG-TA | Terminal pins (JC ZZT-TA1)', JSON.stringify(tx));
    tx = await termRows(A1, WO);
    ok('A7. the WO row the same way, 60', tx.length === 1 && near(tx[0].q, 60) && tx[0].job_card_id === A1, JSON.stringify(tx));
    let LWH = await line(oiA, WH), LWO = await line(oiA, WO), LNUT = await line(oiA, NUT);
    ok('A7. the list\'s pin lines are settled for the card\'s share WITHOUT stock (waived 50 each, deducted 0); the nuts line counts its 200 as taken',
      near(LWH.d, 0) && near(LWH.w, 50) && near(LWO.d, 0) && near(LWO.w, 50) && near(LNUT.d, 200) && near(LNUT.w, 0), JSON.stringify({ LWH, LWO, LNUT }));
    ok('A7. no bom-source row for any pin on this card — a correction never sees them',
      (await qa(`SELECT 1 FROM inventory_transactions WHERE job_card_id=$1 AND item_id = ANY($2) AND source <> 'terminal'`, [A1, [WH, WO, X]])).length === 0);

    r = await call('PUT', terminals(A1), { rows: [{ inventory_item_id: X, qty: 40 }] }, design);
    ok('A8. after the last stage the pins cannot be changed — they have left stock; a difference is fixed at Inventory QC',
      r.status === 400 && /past the point where pins are issued/.test(r.body.error || '') && rowQ(await rowsOf(A1), X)?.q === 50, r.body.error);
    r = await call('GET', terminals(A1));
    ok('A8. the card reads as taken: no edit, nothing held', r.body.editable === false && r.body.held === false && !!r.body.last_stage_taken_at);
    const xNow = await stock(X);
    await setStock(X, 0);
    sl = await call('POST', slipOf(A1), {}, floor);
    ok('A8. a reprint after the take is never held, though X reads 0 right now — the pins have already left stock',
      sl.status === 200 && sl.body.isReprint === true && sl.body.printNo === 2 && (await alerts(A1)).length === 0, `${sl.status} ${JSON.stringify(sl.body).slice(0, 200)}`);
    await setStock(X, xNow);

    // ── The sibling card with list pins takes its own ──
    await tick(A2, MANDATORY);
    s0 = await snap(pins);
    r = await call('PUT', `/api/job-cards/${A2}/checklist/29`, { done: true }, floor);
    ok('A9. the sibling card takes its own 50 WH + 50 WO under source terminal, tied to it — not X',
      r.status === 200 && near(await stock(WH), s0[WH] - 50) && near(await stock(WO), s0[WO] - 50) && near(await stock(X), s0[X])
      && (await termRows(A2, WH)).length === 1 && near((await termRows(A2, WH))[0].q, 50) && (await termRows(A2, WO)).length === 1,
      `${r.status} ${JSON.stringify(r.body)} | ${await moved(s0)}`);
    LWH = await line(oiA, WH); LWO = await line(oiA, WO); LNUT = await line(oiA, NUT);
    ok('A9. both pin lines now fully settled as waived (100 / 100), nothing deducted through them; nuts 400 taken',
      near(LWH.w, 100) && near(LWH.d, 0) && near(LWO.w, 100) && near(LWO.d, 0) && near(LNUT.d, 400), JSON.stringify({ LWH, LWO, LNUT }));

    // ── Inventory QC sees the card's pins as its own ──
    let view = (await call('GET', `/api/qc/${A1}/inventory`)).body;
    let it = (inv) => (view.items || []).find(i => i.inventory_item_id === inv);
    ok('A10. Inventory QC on the changed card: X taken 50 (design\'s row is the guide, 50, not on the list), WO taken 60 (guide 60), WH on the list but not on this card — guide 0, "design changed"',
      it(X) && near(it(X).taken, 50) && it(X).terminal?.qty === 50 && it(X).terminal?.source === 'design' && it(X).list_qty_for_card === 50 && it(X).on_list === false
      && it(WO) && near(it(WO).taken, 60) && it(WO).list_qty_for_card === 60 && it(WO).terminal?.source === 'design'
      && it(WH) && near(it(WH).taken, 0) && it(WH).list_qty_for_card === 0 && /design changed its terminal pins/.test(it(WH).no_guide || '') && it(WH).terminal === null,
      JSON.stringify({ X: it(X), WO: it(WO), WH: it(WH) }).slice(0, 300));
    view = (await call('GET', `/api/qc/${A2}/inventory`)).body;
    ok('A10. on the sibling: WH taken 50 from its list row, guide 50',
      it(WH) && near(it(WH).taken, 50) && it(WH).terminal?.qty === 50 && it(WH).terminal?.source === 'list' && it(WH).list_qty_for_card === 50, JSON.stringify(it(WH)));

    // ── A BOM correction afterwards never gives back a design-changed pin ──
    s0 = await snap(pins);
    let b = await applyBomCorrection(txDb, { orderItemId: oiA, userId: uid, userRole: 'owner',
      sels: [{ id: WH, qty: 100 }, { id: WO, qty: 100 }, { id: HV, qty: 100 }, { id: NUT, qty: 400 }] });
    ok('A11. the same list saved again after both cards took: a real correction (difference mode) that moves nothing — not WH (never taken from stock), not X (design\'s pin, unknown to the list)',
      b.mode === 'difference' && !b.moves.length && !b.short.length && !(await moved(s0)), `${b.mode} | ${b.summary} | ${await moved(s0)}`);
    b = await applyBomCorrection(txDb, { orderItemId: oiA, userId: uid, userRole: 'owner',
      sels: [{ id: WO, qty: 80 }, { id: HV, qty: 100 }, { id: NUT, qty: 400 }] });
    LWO = await line(oiA, WO);
    ok('A11. WH taken off the list and WO lowered to 80: nothing comes back — the lowered WO is absorbed in what was waived (80), the X pins stay taken',
      b.mode === 'difference' && !b.moves.length && !(await moved(s0)) && near(LWO.w, 80) && near(LWO.d, 0) && !(await line(oiA, WH)) && near(await stock(X), s0[X]),
      `${b.mode} | ${b.summary} | ${await moved(s0)} | ${JSON.stringify(LWO)}`);

    // ════ B. A pin short of stock: the alert, the held slip, the OK ════
    // 10 LOW on an item of 10, one card of 10; LOW has 3 in stock.
    const oB = await mkOrder('ZZT-TB');
    const oiB = await mkLine(oB, 10, 'ZZTEST-DWG-TB');
    await putLine(oiB, LOW, 10); await putLine(oiB, NUT, 40);
    const B1 = await mkCard(oB, oiB, 'ZZT-TB1', 10, { dwg: 'ZZTEST-DWG-TB' });
    r = await call('GET', terminals(B1));
    c = await cardRow(B1);
    ok('B1. a pin short of stock (need 10, stock 3): the card reads as held, the row flagged, the time stamped, no OK yet',
      r.status === 200 && r.body.held === true && r.body.short.length === 1 && r.body.short[0].inventory_item_id === LOW
      && r.body.short[0].need === 10 && r.body.short[0].stock === 3 && r.body.short[0].item_code === 'ZZTEST-TP-LOW'
      && r.body.rows[0].short === true && !!c.terminals_short_at && c.terminals_ok_at === null && !!r.body.short_at && r.body.ok === null,
      `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    let al = await alerts(B1);
    ok(`B1. every owner and every Design / QC login (${alertUsers.length}) is told once — no one else`,
      sameIds(al.map(a => a.user_id), alertUsers) && !al.some(a => a.user_id === floor.id), JSON.stringify(al.map(a => a.user_id)) + ' vs ' + JSON.stringify(alertUsers));
    ok('B1. the message: "Job card ZZT-TB1: terminal pin ZZTEST-TP-LOW short — need 10, stock 3. Press OK to release the slip.", linking to the card',
      al.length > 0 && al.every(a => a.title === 'Terminal pin short — ZZT-TB1' && a.link === `/job-cards/${B1}`
        && a.body === 'Job card ZZT-TB1: terminal pin ZZTEST-TP-LOW short — need 10, stock 3. Press OK to release the slip.'), JSON.stringify(al[0]));
    ok('B1. a WhatsApp copy is offered for each dashboard alert (kind terminals_short — approval group, on by default), pointing at the card',
      waFor(B1).length === al.length && waFor(B1).every(w => !!w.notificationId && w.link === `/job-cards/${B1}`)
      && wa.KINDS.some(k => k.type === 'terminals_short' && k.group === 'approval' && k.default === true), `${waFor(B1).length} vs ${al.length}`);
    ok('B1. on the card\'s timeline', logs.some(l => l.jc === B1 && l.type === 'terminals_short' && /ZZTEST-TP-LOW short — need 10, stock 3/.test(l.desc)));

    sl = await call('POST', slipOf(B1), {}, floor);
    ok('B2. the slip is held: 409 TERMINALS_SHORT with the short pin, no print logged; the floor cannot OK it',
      sl.status === 409 && sl.body.code === 'TERMINALS_SHORT' && sl.body.short?.[0]?.item_code === 'ZZTEST-TP-LOW' && sl.body.short[0].need === 10 && sl.body.can_ok === false
      && sl.body.error === 'Slip held — pin ZZTEST-TP-LOW short (need 10, stock 3). The owner or Design / QC must press OK.' && (await prints(B1)) === 0,
      `${sl.status} ${JSON.stringify(sl.body)}`);
    sl = await call('POST', slipOf(B1), {});
    ok('B2. for the owner the same hold offers the OK', sl.status === 409 && sl.body.can_ok === true && (await prints(B1)) === 0);
    r = await call('GET', terminals(B1));
    ok('B2. read again and asked for the slip twice: still told once — the same short state',
      (await alerts(B1)).length === al.length && waFor(B1).length === al.length && r.body.held === true);

    r = await call('POST', `${terminals(B1)}/ok`, { note: 'pins arriving tomorrow' }, floor);
    ok('B3. production cannot press OK', r.status === 403);
    r = await call('POST', `${terminals(B1)}/ok`, { note: 'pins arriving tomorrow' }, design);
    c = await cardRow(B1);
    ok('B3. Design / QC presses OK: recorded with who, when and the note; the card is released',
      r.status === 200 && r.body.held === false && r.body.ok?.by === design.id && r.body.ok?.by_name === design.name && r.body.ok?.note === 'pins arriving tomorrow'
      && c.terminals_ok_by === design.id && !!c.terminals_ok_at && c.terminals_ok_note === 'pins arriving tomorrow' && /OK recorded/.test(r.body.message || ''),
      `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    ok('B3. on the timeline', logs.some(l => l.jc === B1 && l.type === 'terminals_ok' && l.by === design.id && /OK'd by/.test(l.desc) && /pins arriving tomorrow/.test(l.desc)));
    r = await call('POST', `${terminals(B1)}/ok`, {}, design);
    ok('B3. pressed again: already OK\'d, nothing changes', r.status === 200 && /Already OK/.test(r.body.message || '') && r.body.ok?.by === design.id, JSON.stringify(r.body).slice(0, 200));
    r = await call('GET', terminals(B1));
    ok('B3. the card now reads released, still short, OK shown with the name',
      r.body.held === false && r.body.short.length === 1 && r.body.ok?.by_name === design.name && !!r.body.short_at);
    sl = await call('POST', slipOf(B1), {}, floor);
    ok('B3. the slip prints now, with the card\'s 10 LOW',
      sl.status === 200 && sl.body.printNo === 1 && sl.body.terminals?.[0]?.item_code === 'ZZTEST-TP-LOW' && sl.body.terminals[0].qty === 10 && (await prints(B1)) === 1,
      `${sl.status} ${JSON.stringify(sl.body.terminals)}`);

    // ── An edit after the OK is a new question ──
    r = await call('PUT', terminals(B1), { rows: [{ inventory_item_id: LOW, qty: 8 }] });
    c = await cardRow(B1);
    al = await alerts(B1);
    ok('B4. the owner changes the card to 8 LOW after the OK: the OK is cleared; still short (8 > 3), so held again and everyone told again',
      r.status === 200 && r.body.ok === null && r.body.held === true && c.terminals_ok_at === null && c.terminals_ok_by === null && !!c.terminals_short_at
      && al.length === 2 * alertUsers.length && al.filter(a => /need 8, stock 3/.test(a.body)).length === alertUsers.length && waFor(B1).length === al.length,
      `${r.status} ${JSON.stringify(r.body).slice(0, 200)} | alerts ${al.length}`);
    sl = await call('POST', slipOf(B1), {}, floor);
    ok('B4. the slip is held again, no print', sl.status === 409 && (await prints(B1)) === 1);
    r = await call('POST', `${terminals(B1)}/ok`, {});
    ok('B4. the owner OKs it', r.status === 200 && r.body.ok?.by === uid && r.body.held === false, JSON.stringify(r.body).slice(0, 200));

    // ── Stock arrives: the question is closed ──
    await setStock(LOW, 20);
    r = await call('GET', terminals(B1));
    c = await cardRow(B1);
    ok('B5. stock arrives (20): nothing short, the short state AND the OK are both cleared — a later shortage asks afresh',
      r.body.short.length === 0 && r.body.held === false && r.body.short_at === null && r.body.ok === null && r.body.rows[0].short === false
      && c.terminals_short_at === null && c.terminals_ok_at === null && c.terminals_ok_by === null, JSON.stringify(r.body).slice(0, 200));
    r = await call('POST', `${terminals(B1)}/ok`, {});
    ok('B5. OK with nothing short is refused (NOT_SHORT) — a stale OK can never release a later shortage', r.status === 400 && r.body.code === 'NOT_SHORT', JSON.stringify(r.body));
    sl = await call('POST', slipOf(B1), {}, floor);
    ok('B5. the slip prints (copy 2)', sl.status === 200 && sl.body.isReprint === true && sl.body.printNo === 2);
    ok('B5. no new alert for all that', (await alerts(B1)).length === 2 * alertUsers.length);

    // ── Short again, never OK'd: production is not blocked at the last stage ──
    await setStock(LOW, 3);
    r = await call('GET', terminals(B1));
    ok('B6. stock falls again (3): held again and told a third time', r.body.held === true && (await alerts(B1)).length === 3 * alertUsers.length, `alerts ${(await alerts(B1)).length}`);
    await tick(B1, MANDATORY);
    s0 = await snap(pins);
    r = await call('PUT', `/api/job-cards/${B1}/checklist/29`, { done: true }, floor);
    tx = await termRows(B1, LOW);
    ok('B6. stage 29 with no OK: production is never blocked — the card\'s 8 LOW are taken anyway, stock goes to −5, source terminal; the list\'s 10 settled as waived',
      r.status === 200 && near(await stock(LOW), -5) && tx.length === 1 && near(tx[0].q, 8) && near((await line(oiB, LOW)).w, 10) && near((await line(oiB, LOW)).d, 0),
      `${r.status} ${JSON.stringify(r.body)} | ${await moved(s0)} | ${JSON.stringify(await line(oiB, LOW))}`);
    r = await call('GET', terminals(B1));
    sl = await call('POST', slipOf(B1), {}, floor);
    ok('B6. after the take the check is off: not short, not held, the reprint comes out — the pins have left stock, so the low reading is expected',
      r.body.held === false && r.body.short.length === 0 && r.body.short_at === null && sl.status === 200 && (await alerts(B1)).length === 3 * alertUsers.length,
      `${JSON.stringify(r.body).slice(0, 200)} | slip ${sl.status}`);

    // ════ C. A rework portion on the list's pin line ════
    // 20 WO on an item of 10, 6 of them from WO's rework bin; one card of 10.
    const oC = await mkOrder('ZZT-TC');
    const oiC = await mkLine(oC, 10, 'ZZTEST-DWG-TC');
    await putLine(oiC, WO, 20, 6); await putLine(oiC, NUT, 40);
    const C1 = await mkCard(oC, oiC, 'ZZT-TC1', 10, { dwg: 'ZZTEST-DWG-TC' });
    const alertsBefore = (await qa(`SELECT 1 FROM notifications WHERE type='terminals_short'`)).length;
    r = await call('GET', terminals(C1));
    ok('C1. a pin with a rework portion (6 of 20 from the bin) and an EMPTY bin: stock covers the 20, so nothing is short and no one is told — rework pins never trigger anything',
      r.status === 200 && r.body.held === false && r.body.short.length === 0 && r.body.rows[0]?.qty === 20 && r.body.rows[0]?.rework_bin === 0
      && r.body.list[0]?.rework_qty === 6 && (await alerts(C1)).length === 0 && (await qa(`SELECT 1 FROM notifications WHERE type='terminals_short'`)).length === alertsBefore
      && (await cardRow(C1)).terminals_short_at === null, JSON.stringify(r.body).slice(0, 300));
    sl = await call('POST', slipOf(C1), {}, floor);
    ok('C1. the slip prints the card\'s 20 WO with a REWORK portion of 6 — the card\'s share of the line\'s rework',
      sl.status === 200 && sl.body.terminals?.[0]?.qty === 20 && sl.body.terminals[0].rework_qty === 6, `${sl.status} ${JSON.stringify(sl.body.terminals)}`);
    // 4 WO recovered into the bin before the card's last stage — 2 fewer than the line reserved.
    await rework.move(txDb, { itemId: WO, kind: 'deposit', qty: 4, ref: {}, notes: 'test deposit', userId: uid });
    ok('C2. 4 WO in the rework bin', (await bin(WO)) === 4);
    await tick(C1, MANDATORY);
    s0 = await snap(pins);
    r = await call('PUT', `/api/job-cards/${C1}/checklist/29`, { done: true }, floor);
    tx = await termRows(C1, WO);
    let LC = await line(oiC, WO);
    ok('C2. stage 29: the bin is drawn first — 4 from the bin, 16 from stock (the bin was 2 short of the 6 reserved); one stock row, source terminal, noted',
      r.status === 200 && near(await stock(WO), s0[WO] - 16) && (await bin(WO)) === 0 && tx.length === 1 && near(tx[0].q, 16) && tx[0].source === 'terminal' && tx[0].job_card_id === C1
      && /Terminal pins \(JC ZZT-TC1\)/.test(tx[0].notes) && /4 from rework bin/.test(tx[0].notes) && /rework bin short by 2/.test(tx[0].notes),
      `${r.status} ${JSON.stringify(r.body)} | ${await moved(s0)} | ${JSON.stringify(tx)}`);
    ok('C2. the line: 4 drawn from rework and its reservation shrunk to 4; the card\'s 20 settled as waived, nothing deducted through it',
      near(LC.rework_deducted, 4) && near(LC.rework_qty, 4) && near(LC.w, 20) && near(LC.d, 0), JSON.stringify(LC));
    ok('C2. the bin\'s history shows the draw against this card',
      (await qa(`SELECT 1 FROM inventory_rework_moves WHERE item_id=$1 AND job_card_id=$2 AND kind='draw' AND qty=4`, [WO, C1])).length === 1);

    // ════ C3. Stock 0, the list takes the whole pin from the rework bin (owner, 7 Oct 2026) ════
    // 18 RW on an item of 6, all 18 from RW's rework bin; one card of 6. Stock 0.
    const oR = await mkOrder('ZZT-TR');
    const oiR = await mkLine(oR, 6, 'ZZTEST-DWG-TR');
    await putLine(oiR, RW, 18, 18); await putLine(oiR, NUT, 24);
    const R1 = await mkCard(oR, oiR, 'ZZT-TR1', 6, { dwg: 'ZZTEST-DWG-TR' });
    await rework.move(txDb, { itemId: RW, kind: 'deposit', qty: 10, ref: {}, notes: 'test deposit', userId: uid });
    r = await call('GET', terminals(R1));
    ok('C3. bin holds 10 of the 18 the list takes from rework, stock 0: short by the 8 the bin cannot cover — need 8 from stock, 10 from the bin',
      r.status === 200 && r.body.held === true && r.body.short.length === 1 && r.body.short[0].need === 8 && r.body.short[0].from_rework === 10
      && r.body.short[0].stock === 0 && r.body.rows[0]?.from_rework === 10 && r.body.rows[0]?.short === true, JSON.stringify(r.body.short));
    await rework.move(txDb, { itemId: RW, kind: 'deposit', qty: 10, ref: {}, notes: 'test deposit', userId: uid });
    r = await call('GET', terminals(R1));
    c = await cardRow(R1);
    ok('C3. bin now 20: the 18 are covered by the bin — NOT short, slip not held, the short state cleared, the row says 18 from the rework bin',
      r.status === 200 && r.body.held === false && r.body.short.length === 0 && r.body.rows[0]?.from_rework === 18 && r.body.rows[0]?.short === false
      && c.terminals_short_at === null, JSON.stringify({ short: r.body.short, row: r.body.rows[0] }));
    await tick(R1, MANDATORY);
    s0 = await snap(pins);
    r = await call('PUT', `/api/job-cards/${R1}/checklist/29`, { done: true }, floor);
    ok('C3. stage 29: all 18 come out of the bin (20 → 2), stock untouched at 0',
      r.status === 200 && (await bin(RW)) === 2 && near(await stock(RW), 0) && (await termRows(R1, RW)).length === 0,
      `${r.status} bin ${await bin(RW)} | ${await moved(s0)}`);

    // ════ C3b. Two cards and the list's rework portion (owner, 9 Oct 2026) ════
    // 10 RW on an item of 10, 4 of them from the bin; two cards of 5. The bin
    // pins go on the LAST card (all 4); the first card takes new stock only.
    const oS = await mkOrder('ZZT-TS');
    const oiS = await mkLine(oS, 10, 'ZZTEST-DWG-TS');
    await putLine(oiS, RW, 10, 4); await putLine(oiS, NUT, 40);
    const S1 = await mkCard(oS, oiS, 'ZZT-TS1', 5, { dwg: 'ZZTEST-DWG-TS' });
    const S2 = await mkCard(oS, oiS, 'ZZT-TS2', 5, { dwg: 'ZZTEST-DWG-TS' });
    const rS1 = await call('GET', terminals(S1));
    const rS2 = await call('GET', terminals(S2));
    ok('C3b. two cards of 5 and 4 bin pins: all 4 are the last card\'s (the bin holds only 2 now, so it counts 2 — short 3); the first card none (short 5)',
      rS1.body.rows?.[0]?.from_rework === 0 && rS1.body.short[0]?.need === 5 && rS2.body.rows?.[0]?.from_rework === 2 && rS2.body.short[0]?.need === 3
      && rS1.body.list?.[0]?.rework_share === 0 && rS2.body.list?.[0]?.rework_share === 4, JSON.stringify({ a: rS1.body.short, b: rS2.body.short, list: rS1.body.list }));
    sl = await call('POST', slipOf(S1), {}, floor);
    ok('C3b. the first card\'s slip is held (short 5) — no REWORK on it', sl.status === 409 && sl.body.code === 'TERMINALS_SHORT' && sl.body.short?.[0]?.from_rework === 0, `${sl.status} ${JSON.stringify(sl.body)}`);
    r = await call('POST', `/api/job-cards/${S1}/terminals/use-bin`, {}, design);
    ok('C3b. a list that takes the pin from the bin decides — no extra bin approval on the card (older orders)', r.status === 400 && r.body.code === 'NO_BIN_OFFER', JSON.stringify(r.body));

    // ════ C4. Marked from the rework bin in Change pins (owner, 8 Oct 2026) ════
    // 4 MK on an item of 2 (no rework on the list), one card of 2; stock 0.
    // MK's bin holds 10, but another open order's list has 9 of them reserved.
    const oM = await mkOrder('ZZT-TM');
    const oiM = await mkLine(oM, 2, 'ZZTEST-DWG-TM');
    await putLine(oiM, MK, 4); await putLine(oiM, NUT, 8);
    const M1 = await mkCard(oM, oiM, 'ZZT-TM1', 2, { dwg: 'ZZTEST-DWG-TM' });
    const oMo = await mkOrder('ZZT-TMO');
    const oiMo = await mkLine(oMo, 9, 'ZZTEST-DWG-TMO');
    await putLine(oiMo, MK, 9, 9);
    await rework.move(txDb, { itemId: MK, kind: 'deposit', qty: 10, ref: {}, notes: 'test deposit', userId: uid });
    r = await call('GET', terminals(M1));
    ok('C4. stock 0, nothing marked: short by 4', r.status === 200 && r.body.held === true && r.body.short[0]?.need === 4, JSON.stringify(r.body.short));
    r = await call('PUT', terminals(M1), { rows: [{ inventory_item_id: MK, qty: 4, rework_qty: 5 }] }, design);
    ok('C4. more from the bin than the pins on the row is refused', r.status === 400 && /No more than the 4 pins/.test(r.body.error || ''), JSON.stringify(r.body));
    r = await call('PUT', terminals(M1), { rows: [{ inventory_item_id: MK, qty: 4, rework_qty: 4 }] }, design);
    ok('C4. 4 marked from the bin while 9 of its 10 are held for another order: only 1 counts — still short by 3, the slip needs OK',
      r.status === 200 && r.body.held === true && r.body.short[0]?.need === 3 && r.body.short[0]?.from_rework === 1 && r.body.short[0]?.rework_marked === 4
      && r.body.rows[0]?.rework_qty === 4 && r.body.rows[0]?.from_rework === 1, JSON.stringify({ short: r.body.short, row: r.body.rows[0] }));
    ok('C4. the change is on the timeline with the rework mark',
      (await qa(`SELECT 1 FROM activity_log WHERE job_card_id=$1 AND activity_type='terminals_changed' AND description LIKE '%ZZTEST-TP-MK × 4 (4 from rework bin)%'`, [M1])).length === 1
      || logs.some(l => /ZZTEST-TP-MK × 4 \(4 from rework bin\)/.test(l.desc || '')));
    await client.query('UPDATE order_item_inventory SET rework_qty=0 WHERE order_item_id=$1', [oiMo]);
    r = await call('GET', terminals(M1));
    c = await cardRow(M1);
    ok('C4. the other order no longer holds them: the 4 are free, so marked from the bin — not short, no OK needed, short state cleared',
      r.status === 200 && r.body.held === false && r.body.short.length === 0 && r.body.rows[0]?.from_rework === 4 && c.terminals_short_at === null,
      JSON.stringify({ short: r.body.short, row: r.body.rows[0] }));
    ok('C4. the 4 are held for this card: the bin shows 6 free to everyone else', (await rework.freeQty(txDb, MK)) === 6, String(await rework.freeQty(txDb, MK)));
    // A list correction does not undo a pin design marked from the bin.
    await client.query('UPDATE order_item_inventory SET qty=6 WHERE order_item_id=$1 AND inventory_item_id=$2', [oiM, MK]);
    r = await call('GET', terminals(M1));
    ok('C4. a later list correction leaves the marked row alone (4, 4 from the bin)', r.body.rows?.length === 1 && r.body.rows[0].qty === 4 && r.body.rows[0].rework_qty === 4, JSON.stringify(r.body.rows));
    sl = await call('POST', slipOf(M1), {}, floor);
    ok('C4. the slip prints the 4 as a REWORK row', sl.status === 200 && sl.body.terminals?.[0]?.qty === 4 && sl.body.terminals[0].rework_qty === 4, `${sl.status} ${JSON.stringify(sl.body.terminals)}`);
    await tick(M1, MANDATORY);
    s0 = await snap(pins);
    r = await call('PUT', `/api/job-cards/${M1}/checklist/29`, { done: true }, floor);
    ok('C4. stage 29: the 4 come out of the bin (10 → 6), stock untouched, the draw is against this card; the hold ends',
      r.status === 200 && (await bin(MK)) === 6 && near(await stock(MK), 0) && (await termRows(M1, MK)).length === 0
      && (await qa(`SELECT 1 FROM inventory_rework_moves WHERE item_id=$1 AND job_card_id=$2 AND kind='draw' AND qty=4`, [MK, M1])).length === 1
      && (await rework.freeQty(txDb, MK)) === 6, `${r.status} bin ${await bin(MK)} free ${await rework.freeQty(txDb, MK)} | ${await moved(s0)}`);
    // Where the list already takes the pin from the bin, the list decides.
    const oL = await mkOrder('ZZT-TL');
    const oiL = await mkLine(oL, 2, 'ZZTEST-DWG-TL');
    await putLine(oiL, MK, 4, 2);
    const L1 = await mkCard(oL, oiL, 'ZZT-TL1', 2, { dwg: 'ZZTEST-DWG-TL' });
    await call('GET', terminals(L1));
    r = await call('PUT', terminals(L1), { rows: [{ inventory_item_id: MK, qty: 4, rework_qty: 3 }] }, design);
    ok('C4. a pin the list already takes from the bin cannot be marked again on the card', r.status === 400 && /already takes ZZTEST-TP-MK from the rework bin/.test(r.body.error || ''), JSON.stringify(r.body));

    // ════ D. No real pin on the list yet (TRAIN placeholder): nothing seeded, the old take; whole pieces ════
    const oD = await mkOrder('ZZT-TD');
    const oiD = await mkLine(oD, 10, 'ZZTEST-DWG-TD');
    await putLine(oiD, TRN, 10); await putLine(oiD, NUT, 40);
    const D1 = await mkCard(oD, oiD, 'ZZT-TD1', 10, { dwg: 'ZZTEST-DWG-TD' });
    r = await call('GET', terminals(D1));
    ok('D1. design has not picked the pin yet (TRAIN placeholder on the list): no row is seeded, the list shows the placeholder line, nothing held (an order up to ORD-160)',
      r.status === 200 && r.body.rows.length === 0 && (await rowsOf(D1)).length === 0 && r.body.list.length === 1 && r.body.list[0].inventory_item_id === TRN
      && r.body.held === false && r.body.no_terminals === false, JSON.stringify(r.body).slice(0, 300));
    sl = await call('POST', slipOf(D1), {}, floor);
    ok('D1. its slip is as before: no card pins, the placeholder line stays in the apportioned part',
      sl.status === 200 && (sl.body.terminals || []).length === 0 && (sl.body.lines || []).some(l => l.item_code === 'ZZTEST-TP-TRAIN'), `${sl.status} ${JSON.stringify((sl.body.lines || []).map(l => l.item_code))}`);
    await tick(D1, MANDATORY);
    s0 = await snap(pins);
    r = await call('PUT', `/api/job-cards/${D1}/checklist/29`, { done: true }, floor);
    const ld = await line(oiD, TRN);
    const tdRows = await qa(`SELECT source, notes, quantity::float q FROM inventory_transactions WHERE item_id=$1 AND job_card_id=$2`, [TRN, D1]);
    ok('D1. with no rows of its own the card falls back to today\'s list share: 10 TRAIN taken through the line (source bom, "Last stage"), deducted 10, nothing waived, still no rows',
      r.status === 200 && near(await stock(TRN), s0[TRN] - 10) && near(ld.d, 10) && near(ld.w, 0) && tdRows.length === 1 && tdRows[0].source === 'bom'
      && /Last stage \(JC ZZT-TD1\)/.test(tdRows[0].notes) && near(tdRows[0].q, 10) && (await rowsOf(D1)).length === 0,
      `${r.status} ${JSON.stringify(r.body)} | ${JSON.stringify({ ld, tdRows })}`);
    ok('D1. the nuts as always: 40', near(await stock(NUT), s0[NUT] - 40), await moved(s0));

    const oE = await mkOrder('ZZT-TE');
    const oiE = await mkLine(oE, 3, 'ZZTEST-DWG-TE');
    await putLine(oiE, WH, 5);
    const E1 = await mkCard(oE, oiE, 'ZZT-TE1', 1, { dwg: 'ZZTEST-DWG-TE' });
    r = await call('GET', terminals(E1));
    ok('D2. whole pieces: 5 pins on 3 pcs, a card of 1 → 1.67 → 2', r.body.rows?.[0]?.qty === 2 && r.body.list?.[0]?.share === 2, JSON.stringify(r.body).slice(0, 200));

    // ════ E. A partial-dispatch split ════
    const oF = await mkOrder('ZZT-TF');
    const oiF = await mkLine(oF, 100, 'ZZTEST-DWG-TF');
    await putLine(oiF, WH, 100); await putLine(oiF, WO, 100);
    const F1 = await mkCard(oF, oiF, 'ZZT-TF1', 50, { dwg: 'ZZTEST-DWG-TF' });
    await call('GET', terminals(F1));   // seeds 50 / 50
    const sres = await split(F1, 20);
    const F1c = sres?.data?.childJobCardId;
    rs = await rowsOf(F1);
    ok('E1. 20 split off a card of 50 (rows 50 / 50): the parent\'s rows are scaled to its remaining 30 (30 WH + 30 WO), noted on its timeline',
      sres?.ok && !!F1c && Number((await cardRow(F1)).qty) === 30 && rowQ(rs, WH)?.q === 30 && rowQ(rs, WO)?.q === 30 && rs.every(x => x.source === 'list')
      && (await qa(`SELECT 1 FROM activity_log WHERE job_card_id=$1 AND activity_type='terminals_changed' AND description LIKE '%scaled to its remaining 30 pcs%'`, [F1])).length === 1,
      `${JSON.stringify(sres)} | ${JSON.stringify(rs)}`);
    ok('E1. the split card has no rows until it is read', !!F1c && (await rowsOf(F1c)).length === 0);
    r = F1c ? await call('GET', terminals(F1c)) : { body: {} };
    rs = F1c ? await rowsOf(F1c) : [];
    ok('E1. read, it seeds from its own 20: 20 WH + 20 WO from the list — not a copy of the parent\'s',
      rowQ(rs, WH)?.q === 20 && rowQ(rs, WO)?.q === 20 && rs.every(x => x.source === 'list') && r.body.held === false, JSON.stringify(rs));

    // ════ F. A finished-goods card: no pins of its own, slip unchanged ════
    const oG = await mkOrder('ZZT-TG', 'finished_goods');
    const oiG = await mkLine(oG, 5, 'ZZTEST-DWG-TG');
    await putLine(oiG, NUT, 10); await putLine(oiG, WH, 5);
    const G1 = await mkCard(oG, oiG, 'ZZT-TG1', 5, { dwg: 'ZZTEST-DWG-TG', fg: true });
    r = await call('GET', terminals(G1));
    ok('F1. a finished-goods card: no terminal rows ever (the pins are inside the heater), nothing to edit',
      r.status === 200 && r.body.no_terminals === true && r.body.rows.length === 0 && r.body.editable === false && r.body.held === false && (await rowsOf(G1)).length === 0,
      JSON.stringify(r.body).slice(0, 200));
    r = await call('PUT', terminals(G1), { rows: [{ inventory_item_id: WH, qty: 5 }] }, design);
    ok('F1. design cannot give it pins', r.status === 400 && /finished-goods/.test(r.body.error || '') && (await rowsOf(G1)).length === 0, r.body.error);
    const whNow = await stock(WH);
    await setStock(WH, 0);
    sl = await call('POST', slipOf(G1), {}, floor);
    ok('F1. its slip is unchanged: prints with the pin line in the apportioned part, no card pins, never held (WH at 0 right now), no alert',
      sl.status === 200 && (sl.body.terminals || []).length === 0 && (sl.body.lines || []).some(l => l.item_code === 'ZZTEST-TP-WH') && (await alerts(G1)).length === 0
      && (await cardRow(G1)).terminals_short_at === null, `${sl.status} ${JSON.stringify(sl.body).slice(0, 200)}`);
    await setStock(WH, whNow);
    await tick(G1, [1, 2, 3]);
    s0 = await snap(pins);
    r = await call('PUT', `/api/job-cards/${G1}/checklist/4`, { done: true }, floor);
    ok('F1. its last stage (4) takes the 10 nuts and leaves the pins alone — no terminal rows, no rows seeded',
      r.status === 200 && near(await stock(NUT), s0[NUT] - 10) && near(await stock(WH), s0[WH]) && (await rowsOf(G1)).length === 0
      && (await qa(`SELECT 1 FROM inventory_transactions WHERE job_card_id=$1 AND source='terminal'`, [G1])).length === 0,
      `${r.status} ${JSON.stringify(r.body)} | ${await moved(s0)}`);

    // ════ I2. An order up to ORD-160 still needs its pin on the list ════
    {
      const oOld = await mkOrder('ZZT-TOLD');
      const oiOld = await mkLine(oOld, 2, 'ZZTEST-DWG-TOLD');
      const rr = await call('PUT', `/api/orders/${oOld}/items/${oiOld}/inventory`, { inventory_item_ids: [{ id: NUT, qty: 8 }] }, owner);
      ok('I2. an order up to ORD-160: a list without a Terminal Pin is still refused', rr.status === 400 && /Terminal Pin is required/.test(rr.body.error || ''), JSON.stringify(rr.body));
    }

    // ════ N. Rework pins go on the LAST job cards (owner, 9 Oct 2026) ════
    // ORD-159-26's shape: 360 pcs on 7 cards of 50 + 1 of 10, the list takes 60
    // WH and 15 WO from the bin (owner: rework only on S13 and S12). S13 takes
    // 10 + 10 from the bin, S12 50 WH + 5 WO; S6–S11 take new stock only.
    const NH = await mkItem('ZZTEST-TP-NH', 'Terminal Pin', 1000, 'pcs');
    const NO = await mkItem('ZZTEST-TP-NO', 'Terminal Pin', 1000, 'pcs');
    await rework.move(txDb, { itemId: NH, kind: 'deposit', qty: 100, ref: {}, notes: 'test deposit', userId: uid });
    await rework.move(txDb, { itemId: NO, kind: 'deposit', qty: 15, ref: {}, notes: 'test deposit', userId: uid });
    const oN = await mkOrder('ZZT-TN');
    const oiN = await mkLine(oN, 360, 'ZZTEST-DWG-TN');
    await putLine(oiN, NH, 360, 60); await putLine(oiN, NO, 360, 15); await putLine(oiN, NUT, 720);
    const NC = [];
    for (let i = 6; i <= 13; i++) NC.push(await mkCard(oN, oiN, `ZZT-TN-S${i}`, i === 13 ? 10 : 50, { dwg: 'ZZTEST-DWG-TN' }));
    const shareOf = (b, inv) => b.list?.find(l => l.inventory_item_id === inv)?.rework_share;
    const fromOf = (b, inv) => b.rows?.find(x => x.inventory_item_id === inv)?.from_rework;
    const nb = [];
    for (const id of NC) nb.push((await call('GET', terminals(id))).body);
    ok('N1. the rework sits on the last cards: S13 10 WH + 10 WO, S12 50 WH + 5 WO, S6–S11 none',
      shareOf(nb[7], NH) === 10 && shareOf(nb[7], NO) === 10 && shareOf(nb[6], NH) === 50 && shareOf(nb[6], NO) === 5
      && nb.slice(0, 6).every(b => shareOf(b, NH) === 0 && shareOf(b, NO) === 0), JSON.stringify(nb.map(b => [shareOf(b, NH), shareOf(b, NO)])));
    ok('N1. the rows count the same from the bin, and nothing is short (stock 1000)',
      fromOf(nb[7], NH) === 10 && fromOf(nb[7], NO) === 10 && fromOf(nb[6], NH) === 50 && fromOf(nb[6], NO) === 5
      && nb.slice(0, 6).every(b => fromOf(b, NH) === 0 && fromOf(b, NO) === 0) && nb.every(b => b.held === false && b.short.length === 0),
      JSON.stringify(nb.map(b => [fromOf(b, NH), fromOf(b, NO), b.held])));
    sl = await call('POST', slipOf(NC[7]), {}, floor);
    const slT = (b, inv) => b.terminals?.find(t => t.inventory_item_id === inv);
    ok('N2. S13\'s slip: 10 WH and 10 WO, all REWORK', sl.status === 200 && slT(sl.body, NH)?.qty === 10 && slT(sl.body, NH)?.rework_qty === 10
      && slT(sl.body, NO)?.rework_qty === 10, `${sl.status} ${JSON.stringify(sl.body.terminals)}`);
    sl = await call('POST', slipOf(NC[6]), {}, floor);
    ok('N2. S12\'s slip: REWORK 50 WH and 5 WO', sl.status === 200 && slT(sl.body, NH)?.rework_qty === 50 && slT(sl.body, NO)?.rework_qty === 5, `${sl.status} ${JSON.stringify(sl.body.terminals)}`);
    sl = await call('POST', slipOf(NC[0]), {}, floor);
    ok('N2. S6\'s slip: no REWORK at all', sl.status === 200 && sl.body.terminals?.length === 2 && sl.body.terminals.every(t => t.rework_qty === 0), `${sl.status} ${JSON.stringify(sl.body.terminals)}`);
    // S6 finishes first: new stock only.
    await tick(NC[0], MANDATORY);
    s0 = await snap([NH, NO]);
    let bH = await bin(NH), bO = await bin(NO);
    r = await call('PUT', `/api/job-cards/${NC[0]}/checklist/29`, { done: true }, floor);
    ok('N3. S6 (a first card) finishes first: 50 + 50 from new stock, the bin untouched',
      r.status === 200 && near(await stock(NH), s0[NH] - 50) && near(await stock(NO), s0[NO] - 50) && (await bin(NH)) === bH && (await bin(NO)) === bO,
      `${r.status} ${await moved(s0)} bin ${await bin(NH)}/${await bin(NO)}`);
    await tick(NC[7], MANDATORY);
    s0 = await snap([NH, NO]);
    r = await call('PUT', `/api/job-cards/${NC[7]}/checklist/29`, { done: true }, floor);
    ok('N4. S13 (the last card): its 10 WH + 10 WO come out of the bin, nothing from stock',
      r.status === 200 && near(await stock(NH), s0[NH]) && near(await stock(NO), s0[NO]) && (await bin(NH)) === bH - 10 && (await bin(NO)) === bO - 10,
      `${r.status} ${await moved(s0)} bin ${await bin(NH)}/${await bin(NO)}`);
    await tick(NC[6], MANDATORY);
    s0 = await snap([NH, NO]);
    r = await call('PUT', `/api/job-cards/${NC[6]}/checklist/29`, { done: true }, floor);
    let LNH = await line(oiN, NH), LNO = await line(oiN, NO);
    ok('N5. S12: 50 WH from the bin, WO 5 from the bin + 45 new; the list\'s 60 + 15 are all drawn',
      r.status === 200 && near(await stock(NH), s0[NH]) && near(await stock(NO), s0[NO] - 45) && (await bin(NH)) === bH - 60 && (await bin(NO)) === 0
      && near(LNH.rework_deducted, 60) && near(LNH.rework_qty, 60) && near(LNO.rework_deducted, 15),
      `${r.status} ${await moved(s0)} bin ${await bin(NH)}/${await bin(NO)} ${JSON.stringify([LNH, LNO])}`);
    // The bin short on the last cards: only the shortfall is released.
    const NS = await mkItem('ZZTEST-TP-NS', 'Terminal Pin', 100, 'pcs');
    await rework.move(txDb, { itemId: NS, kind: 'deposit', qty: 6, ref: {}, notes: 'test deposit', userId: uid });
    const oN2 = await mkOrder('ZZT-TN2');
    const oiN2 = await mkLine(oN2, 10, 'ZZTEST-DWG-TN2');
    await putLine(oiN2, NS, 10, 8); await putLine(oiN2, NUT, 40);
    const N21 = await mkCard(oN2, oiN2, 'ZZT-TN2-1', 5, { dwg: 'ZZTEST-DWG-TN2' });
    const N22 = await mkCard(oN2, oiN2, 'ZZT-TN2-2', 5, { dwg: 'ZZTEST-DWG-TN2' });
    const n21 = (await call('GET', terminals(N21))).body, n22 = (await call('GET', terminals(N22))).body;
    ok('N6. 8 from the bin on two cards of 5: the last card 5, the one before it 3', shareOf(n22, NS) === 5 && shareOf(n21, NS) === 3,
      JSON.stringify([shareOf(n21, NS), shareOf(n22, NS)]));
    await tick(N22, MANDATORY); await tick(N21, MANDATORY);
    await call('PUT', `/api/job-cards/${N22}/checklist/29`, { done: true }, floor);
    s0 = await snap([NS]);
    r = await call('PUT', `/api/job-cards/${N21}/checklist/29`, { done: true }, floor);
    const LNS = await line(oiN2, NS);
    ok('N6. the last card drew 5 (bin 6 → 1); the one before wanted 3, got 1 — 4 from stock — and only its shortfall of 2 was released (8 → 6)',
      r.status === 200 && (await bin(NS)) === 0 && near(await stock(NS), s0[NS] - 4) && near(LNS.rework_deducted, 6) && near(LNS.rework_qty, 6),
      `${r.status} bin ${await bin(NS)} ${await moved(s0)} ${JSON.stringify(LNS)}`);

    // ════ J. Pins from the job card, taken at Spot — orders after ORD-160 (owner, 8 Oct 2026) ════
    PINS_RULE.afterOrderId = 0;
    // Made-up stud M9 so no real pin item matches: TP-SS-M9-03-WH / -WO.
    const P9H = await mkItem('TP-SS-M9-03-WH', 'Terminal Pin', 100, 'pcs');
    const P9O = await mkItem('TP-SS-M9-03-WO', 'Terminal Pin', 100, 'pcs');
    const P9X = await mkItem('TP-SS-M9-04-WH', 'Terminal Pin', 100, 'pcs');   // design's other pin
    const spec = (big, small, el = 1) => JSON.stringify({ computed: { studLabel: 'M9-SS', terminalPinBig: { studs: big }, terminalPinSmall: { studs: small }, elements: el } });
    const pin9 = [P9H, P9O, P9X];
    const oJ = await mkOrder('ZZT-TJ');
    const oiJ = await mkLine(oJ, 10, 'ZZTEST-DWG-TJ');
    await putLine(oiJ, NUT, 40);                                   // no pin on the list at all
    const J1 = await mkCard(oJ, oiJ, 'ZZT-TJ1', 10, { dwg: 'ZZTEST-DWG-TJ' });
    await client.query('UPDATE job_cards SET generated_spec=$2 WHERE id=$1', [J1, spec(3, 3)]);
    r = await call('GET', terminals(J1));
    let jr = await rowsOf(J1);
    ok('J1. an app-made card: pins from the job card — 10 × TP-SS-M9-03-WH + 10 × -WO (one with head, one without, per element), "from job card", not held',
      r.status === 200 && jr.length === 2 && rowQ(jr, P9H)?.q === 10 && rowQ(jr, P9O)?.q === 10 && jr.every(x => x.source === 'card') && r.body.held === false && r.body.from === 'card',
      JSON.stringify({ rows: jr, held: r.body.held, from: r.body.from }));
    r = await call('PUT', `/api/orders/${oJ}/items/${oiJ}/inventory`, { inventory_item_ids: [{ id: NUT, qty: 40 }] }, owner);
    ok('J2. the list saves without a Terminal Pin now', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
    r = await call('PUT', `/api/orders/${oJ}/items/${oiJ}/inventory`, { inventory_item_ids: [{ id: NUT, qty: 40 }, { id: WH, qty: 10 }] }, owner);
    ok('J2. a Terminal Pin sent with the list is dropped — pins are not on the list any more',
      r.status === 200 && !(await qa('SELECT 1 FROM order_item_inventory WHERE order_item_id=$1 AND inventory_item_id=$2', [oiJ, WH])).length, `${r.status} ${JSON.stringify(r.body)}`);
    await tick(J1, [1, 2, 3]);
    s0 = await snap(pin9);
    r = await call('PUT', `/api/job-cards/${J1}/checklist/4`, { done: true }, floor);
    c = await cardRow(J1);
    ok('J3. Spot ticked: the 10 + 10 pins leave stock, stamped on the card',
      r.status === 200 && near(await stock(P9H), s0[P9H] - 10) && near(await stock(P9O), s0[P9O] - 10) && !!c.pins_taken_at
      && (await termRows(J1, P9H)).length === 1 && /Terminal pins at Spot \(JC ZZT-TJ1\)/.test((await termRows(J1, P9H))[0].notes),
      `${r.status} ${JSON.stringify(r.body)} | ${await moved(s0)}`);
    r = await call('PUT', terminals(J1), { rows: [{ inventory_item_id: P9X, qty: 10 }, { inventory_item_id: P9O, qty: 10 }] }, design);
    ok('J3. after Spot the pins cannot be changed — untick Spot or Inventory QC', r.status === 400 && /taken at Spot/.test(r.body.error || ''), JSON.stringify(r.body));
    s0 = await snap(pin9);
    r = await call('PUT', `/api/job-cards/${J1}/checklist/4`, { done: false }, floor);
    c = await cardRow(J1);
    ok('J4. Spot unticked: exactly those pins go back, the stamp is cleared',
      r.status === 200 && near(await stock(P9H), s0[P9H] + 10) && near(await stock(P9O), s0[P9O] + 10) && !c.pins_taken_at && c.pins_taken === null,
      `${r.status} | ${await moved(s0)}`);
    r = await call('PUT', terminals(J1), { rows: [{ inventory_item_id: P9X, qty: 10 }, { inventory_item_id: P9O, qty: 10 }] }, design);
    ok('J5. pins from the job card are not changed on the card — only at Inventory QC', r.status === 400 && r.body.code === 'PINS_FIXED', JSON.stringify(r.body));
    r = await call('GET', terminals(J1));
    ok('J5. the box offers no Change pins for job-card pins', r.body.editable === false, JSON.stringify({ editable: r.body.editable }));
    s0 = await snap(pin9);
    r = await call('PUT', `/api/job-cards/${J1}/checklist/4`, { done: true }, floor);
    ok('J5. Spot ticked again: the same 10 + 10 pins are taken again',
      r.status === 200 && near(await stock(P9H), s0[P9H] - 10) && near(await stock(P9O), s0[P9O] - 10), await moved(s0));
    await tick(J1, MANDATORY);
    s0 = await snap(pin9);
    r = await call('PUT', `/api/job-cards/${J1}/checklist/29`, { done: true }, floor);
    ok('J6. the last stage takes the list but NOT the pins again', r.status === 200 && !(await moved(s0)) && !!(await cardRow(J1)).last_stage_taken_at, await moved(s0));

    // An uploaded job card (no spec) whose list names no pin: design picks them.
    const J2c = await mkCard(oJ, oiJ, 'ZZT-TJ2', 10, { dwg: 'ZZTEST-DWG-TJ' });
    r = await call('GET', terminals(J2c));
    ok('J7. an uploaded card with no pin named anywhere: pins not set, slip held', r.status === 200 && r.body.unset === true && r.body.held === true && (await rowsOf(J2c)).length === 0, JSON.stringify({ unset: r.body.unset, held: r.body.held }));
    sl = await call('POST', slipOf(J2c), {}, floor);
    ok('J7. the slip says the pins are not set (409 TERMINALS_UNSET), no OK button', sl.status === 409 && sl.body.code === 'TERMINALS_UNSET' && sl.body.can_ok === false, JSON.stringify(sl.body));
    r = await call('POST', `/api/job-cards/${J2c}/terminals/ok`, {}, owner);
    ok('J7. an OK cannot release pins that are not set', r.status === 400 && r.body.code === 'PINS_NOT_SET', JSON.stringify(r.body));
    await tick(J2c, [1, 2, 3]);
    s0 = await snap(pin9);
    r = await call('PUT', `/api/job-cards/${J2c}/checklist/4`, { done: true }, floor);
    ok('J7. Spot with no pins set takes nothing and stamps nothing', r.status === 200 && !(await moved(s0)) && !(await cardRow(J2c)).pins_taken_at, await moved(s0));
    r = await call('PUT', terminals(J2c), { rows: [{ inventory_item_id: P9H, qty: 10 }, { inventory_item_id: P9O, qty: 10 }] }, design);
    ok('J7. design sets them: the slip is released', r.status === 200 && r.body.held === false && r.body.unset === false, JSON.stringify({ held: r.body.held, unset: r.body.unset }));
    await tick(J2c, MANDATORY);
    s0 = await snap(pin9);
    r = await call('PUT', `/api/job-cards/${J2c}/checklist/29`, { done: true }, floor);
    ok('J7. Spot was ticked before the pins were set, so the last stage takes them as a catch-up (10 + 10)',
      r.status === 200 && near(await stock(P9H), s0[P9H] - 10) && near(await stock(P9O), s0[P9O] - 10), await moved(s0));

    // The job card asks for a pin length stock has no item for.
    const oK = await mkOrder('ZZT-TK');
    const oiK = await mkLine(oK, 5, 'ZZTEST-DWG-TK');
    await putLine(oiK, NUT, 20);
    const K1 = await mkCard(oK, oiK, 'ZZT-TK1', 5, { dwg: 'ZZTEST-DWG-TK' });
    await client.query('UPDATE job_cards SET generated_spec=$2 WHERE id=$1', [K1, spec(7, 3)]);
    r = await call('GET', terminals(K1));
    ok('J8. the card asks for TP-SS-M9-07-WH, which has no item: held, named as missing', r.status === 200 && r.body.held === true && (r.body.missing || []).includes('TP-SS-M9-07-WH'), JSON.stringify({ held: r.body.held, missing: r.body.missing }));
    r = await call('PUT', terminals(K1), { rows: [{ inventory_item_id: P9X, qty: 5 }, { inventory_item_id: P9O, qty: 5 }] }, design);
    ok('J8. design picks another pin: released', r.status === 200 && r.body.held === false, JSON.stringify({ held: r.body.held, missing: r.body.missing }));

    // A pin marked from the rework bin: Spot draws the bin, untick puts it back.
    const oL2 = await mkOrder('ZZT-TL2');
    const oiL2 = await mkLine(oL2, 4, 'ZZTEST-DWG-TL2');
    await putLine(oiL2, NUT, 16);
    const L2 = await mkCard(oL2, oiL2, 'ZZT-TL2-1', 4, { dwg: 'ZZTEST-DWG-TL2' });   // uploaded: design picks its pins
    await rework.move(txDb, { itemId: P9H, kind: 'deposit', qty: 5, ref: {}, notes: 'test deposit', userId: uid });
    await call('GET', terminals(L2));
    r = await call('PUT', terminals(L2), { rows: [{ inventory_item_id: P9H, qty: 4, rework_qty: 4 }, { inventory_item_id: P9O, qty: 4 }] }, design);
    await tick(L2, [1, 2, 3]);
    s0 = await snap(pin9);
    const b0 = await bin(P9H);
    r = await call('PUT', `/api/job-cards/${L2}/checklist/4`, { done: true }, floor);
    ok('J9. Spot with 4 WH marked from the bin: the bin gives 4 (5 → 1), stock gives only the 4 WO',
      r.status === 200 && (await bin(P9H)) === b0 - 4 && near(await stock(P9H), s0[P9H]) && near(await stock(P9O), s0[P9O] - 4), `${await moved(s0)} bin ${await bin(P9H)}`);
    r = await call('PUT', `/api/job-cards/${L2}/checklist/4`, { done: false }, floor);
    ok('J9. Spot unticked: the 4 go back into the bin, the 4 WO back to stock', r.status === 200 && (await bin(P9H)) === b0 && near(await stock(P9O), s0[P9O]), `bin ${await bin(P9H)} ${await moved(s0)}`);

    // A list that still names a pin, on an app-made card: the job card wins.
    const oM2 = await mkOrder('ZZT-TM2');
    const oiM2 = await mkLine(oM2, 6, 'ZZTEST-DWG-TM2');
    await putLine(oiM2, WH, 6); await putLine(oiM2, NUT, 24);
    const M2 = await mkCard(oM2, oiM2, 'ZZT-TM2-1', 6, { dwg: 'ZZTEST-DWG-TM2' });
    await call('GET', terminals(M2));                                   // seeded from the list first (no spec yet)
    await client.query('UPDATE job_cards SET generated_spec=$2 WHERE id=$1', [M2, spec(3, 3)]);
    r = await call('GET', terminals(M2));
    jr = await rowsOf(M2);
    ok('J10. list pins on an app-made card are replaced by the job card\'s (6 × M9-03-WH + 6 × -WO), and the timeline says so',
      jr.length === 2 && rowQ(jr, P9H)?.q === 6 && rowQ(jr, P9O)?.q === 6 && !rowQ(jr, WH) && jr.every(x => x.source === 'card')
      && logs.some(l => /now come from the job card \(M9 3" × 1 element\)/.test(l.desc || '')), JSON.stringify(jr));

    // ════ O. App-picked pins: new stock for the first cards; the bin only when stock runs out, on the last cards, with an approval (owner, 9 Oct 2026) ════
    const P7H = await mkItem('TP-SS-M7-03-WH', 'Terminal Pin', 25, 'pcs');
    const P7O = await mkItem('TP-SS-M7-03-WO', 'Terminal Pin', 100, 'pcs');
    const spec7 = JSON.stringify({ computed: { studLabel: 'M7-SS', terminalPinBig: { studs: 3 }, terminalPinSmall: { studs: 3 }, elements: 1 } });
    await rework.move(txDb, { itemId: P7H, kind: 'deposit', qty: 8, ref: {}, notes: 'test deposit', userId: uid });
    const oO = await mkOrder('ZZT-TO');
    const oiO = await mkLine(oO, 30, 'ZZTEST-DWG-TO');
    await putLine(oiO, NUT, 120);
    const OC = [];
    for (let i = 1; i <= 3; i++) {
      const id = await mkCard(oO, oiO, `ZZT-TO-${i}`, 10, { dwg: 'ZZTEST-DWG-TO' });
      await client.query('UPDATE job_cards SET generated_spec=$2 WHERE id=$1', [id, spec7]);
      OC.push(id);
    }
    const ob = [];
    for (const id of OC) ob.push((await call('GET', terminals(id))).body);
    const sh = (b) => b.short?.find(x => x.inventory_item_id === P7H);
    ok('O1. 25 WH in stock for three cards of 10: cards 1 and 2 are covered by new stock, card 3 has 5 left — short 5, the bin can give 5',
      ob[0].held === false && ob[1].held === false && ob[2].held === true && sh(ob[2])?.need === 10 && sh(ob[2])?.stock_for_card === 5
      && sh(ob[2])?.stock === 25 && sh(ob[2])?.bin_offer === 5 && ob[2].can_use_bin === true, JSON.stringify(ob.map(b => [b.held, b.short])));
    ok('O1. nothing is marked from the bin without an approval', (await qa('SELECT 1 FROM job_card_terminals WHERE job_card_id = ANY($1) AND rework_qty > 0', [OC])).length === 0);
    sl = await call('POST', slipOf(OC[2]), {}, owner);
    ok('O1. card 3\'s slip is held, and the owner is offered the bin', sl.status === 409 && sl.body.can_use_bin === true && sl.body.short?.[0]?.bin_offer === 5, JSON.stringify(sl.body));
    r = await call('POST', `/api/job-cards/${OC[2]}/terminals/use-bin`, {}, floor);
    ok('O2. production cannot approve the bin', r.status === 403, `${r.status}`);
    r = await call('POST', `/api/job-cards/${OC[2]}/terminals/use-bin`, {}, design);
    const o3r = (await rowsOf(OC[2])).find(x => x.inv === P7H);
    ok('O2. Design / QC approves: 5 WH marked from the bin on card 3, the slip is no longer held, the approval is on the timeline',
      r.status === 200 && r.body.held === false && Number((await q1('SELECT rework_qty FROM job_card_terminals WHERE job_card_id=$1 AND inventory_item_id=$2', [OC[2], P7H])).rework_qty) === 5
      && o3r && (logs.some(l => /Rework bin approved by .* for ZZT-TO-3: 5 TP-SS-M7-03-WH/.test(l.desc || ''))
        || (await qa(`SELECT 1 FROM activity_log WHERE job_card_id=$1 AND activity_type='terminals_rework_approved'`, [OC[2]])).length === 1),
      `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    r = await call('GET', terminals(OC[0]));
    ok('O2. the first cards are untouched: card 1 still all new stock, not held', r.body.held === false && r.body.rows.every(x => !(Number(x.rework_qty) > 0)), JSON.stringify(r.body.rows));
    sl = await call('POST', slipOf(OC[2]), {}, floor);
    ok('O3. card 3\'s slip prints REWORK 5 on the WH row', sl.status === 200 && sl.body.terminals?.find(t => t.inventory_item_id === P7H)?.rework_qty === 5, `${sl.status} ${JSON.stringify(sl.body.terminals)}`);
    r = await call('POST', `/api/job-cards/${OC[2]}/terminals/use-bin`, {}, owner);
    ok('O3. approving again with nothing short is refused', r.status === 400 && r.body.code === 'NO_BIN_OFFER', JSON.stringify(r.body));
    await tick(OC[2], [1, 2, 3]);
    s0 = await snap([P7H, P7O]);
    r = await call('PUT', `/api/job-cards/${OC[2]}/checklist/4`, { done: true }, floor);
    ok('O4. Spot on card 3: 5 WH from the bin (8 → 3) and 5 from stock, 10 WO from stock',
      r.status === 200 && (await bin(P7H)) === 3 && near(await stock(P7H), s0[P7H] - 5) && near(await stock(P7O), s0[P7O] - 10), `${r.status} bin ${await bin(P7H)} ${await moved(s0)}`);
    // The bin too small, and the first card short as well: the bin goes to the LAST card.
    const P7X = await mkItem('TP-SS-M7-04-WH', 'Terminal Pin', 5, 'pcs');
    const P7Y = await mkItem('TP-SS-M7-04-WO', 'Terminal Pin', 100, 'pcs');
    const spec74 = JSON.stringify({ computed: { studLabel: 'M7-SS', terminalPinBig: { studs: 4 }, terminalPinSmall: { studs: 4 }, elements: 1 } });
    await rework.move(txDb, { itemId: P7X, kind: 'deposit', qty: 3, ref: {}, notes: 'test deposit', userId: uid });
    const oP = await mkOrder('ZZT-TP');
    const oiP = await mkLine(oP, 20, 'ZZTEST-DWG-TP');
    await putLine(oiP, NUT, 80);
    const PC = [];
    for (let i = 1; i <= 2; i++) {
      const id = await mkCard(oP, oiP, `ZZT-TP-${i}`, 10, { dwg: 'ZZTEST-DWG-TP' });
      await client.query('UPDATE job_cards SET generated_spec=$2 WHERE id=$1', [id, spec74]);
      PC.push(id);
    }
    const p1 = (await call('GET', terminals(PC[0]))).body, p2 = (await call('GET', terminals(PC[1]))).body;
    const shX = (b) => b.short?.find(x => x.inventory_item_id === P7X);
    ok('O5. stock 5 and 3 in the bin for two cards of 10: both short; the bin is offered to the LAST card only (3), the first card none',
      p1.held && p2.held && shX(p1)?.bin_offer === 0 && shX(p2)?.bin_offer === 3 && shX(p1)?.stock_for_card === 5 && shX(p2)?.stock_for_card === 0,
      JSON.stringify([p1.short, p2.short]));
    r = await call('POST', `/api/job-cards/${PC[1]}/terminals/use-bin`, {}, owner);
    ok('O5. approved: 3 from the bin, still short 7 — the slip waits for an OK as before',
      r.status === 200 && r.body.held === true && shX(r.body)?.need === 7 && shX(r.body)?.from_rework === 3 && shX(r.body)?.bin_offer === 0, JSON.stringify(r.body.short));
    r = await call('POST', `/api/job-cards/${PC[0]}/terminals/use-bin`, {}, owner);
    ok('O5. the first card is never given bin pins the last card holds', r.status === 400 && r.body.code === 'NO_BIN_OFFER', JSON.stringify(r.body));

    // ════ G. Nothing leaked past the stubs ════
    ok('G1. every WhatsApp copy recorded was a terminals_short alert for one of the test cards',
      waCalls.every(w => w.type === 'terminals_short' && [B1, R1, M1, L1, S1, S2, J2c, K1, D1, L2, ...OC, ...PC].includes(w.ref?.id)), JSON.stringify(waCalls.filter(w => ![B1, R1, M1, L1, S1, S2, J2c, K1, D1, L2, ...OC, ...PC].includes(w.ref?.id)).map(w => [w.type, w.ref?.id, w.title])));
  } catch (e) {
    failed = true;
    console.error('ERROR', e);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    server.close();
    await realPool.end();
    console.log(failed ? '\nSOME CHECKS FAILED (rolled back)' : '\nALL PASS (rolled back — nothing kept)');
    process.exit(failed ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
