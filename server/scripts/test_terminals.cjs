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
    const pins = [WH, WO, X, LOW, TRN, HV, NUT];

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

    // ════ D. No real pin on the list yet (TRAIN placeholder): nothing seeded, the old take; whole pieces ════
    const oD = await mkOrder('ZZT-TD');
    const oiD = await mkLine(oD, 10, 'ZZTEST-DWG-TD');
    await putLine(oiD, TRN, 10); await putLine(oiD, NUT, 40);
    const D1 = await mkCard(oD, oiD, 'ZZT-TD1', 10, { dwg: 'ZZTEST-DWG-TD' });
    r = await call('GET', terminals(D1));
    ok('D1. design has not picked the pin yet (TRAIN placeholder on the list): no row is seeded, the list shows the placeholder line, nothing held',
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

    // ════ G. Nothing leaked past the stubs ════
    ok('G1. every WhatsApp copy recorded was a terminals_short alert for one of the test cards',
      waCalls.every(w => w.type === 'terminals_short' && [B1].includes(w.ref?.id)), JSON.stringify(waCalls.map(w => [w.type, w.ref?.id])));
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
