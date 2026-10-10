// Test for Inventory QC (owner, 6 Oct 2026): the rest of a job card's list is
// taken when the card completes its LAST stage (stage 29; stage 4 on a
// finished-goods card), Product QC only records where the pieces go, and
// Inventory QC reviews and corrects everything the card took, then sends it on —
// the final change to that card's inventory, ever. Rejected and remade pieces
// need nothing extra. Legacy cards (no last-stage take) keep today's settle.
//
// Runs inside one transaction that is ROLLED BACK, on its own made-up items
// (ZZTEST-IQC-…; TUB-ZZTEST-IQC is counted stock by its prefix), orders, order
// lines, job cards and lists, so no real stock row is touched. Fins go by item
// code, so a made-up fins code (ZZTEST-IQC-FIN) is added to the fins table in
// memory for this run only. Routes run through express as the owner; the QC
// photo upload is stubbed, nothing is stored.
//
// Needs a database the new server has started on once (initDB adds the
// Inventory QC columns and the 'inventory_qc' status) — it refuses otherwise.
//   node scripts/test_inventory_qc.cjs
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
  dbmod.getDB = () => txDb;
  dbmod.logActivity = async (orderId, jc, type, desc) => { logs.push({ orderId, jc, type, desc }); };
  const q1 = async (q, p = []) => (await client.query(q, p)).rows[0];
  const qa = async (q, p = []) => (await client.query(q, p)).rows;
  let failed = false;
  const ok = (label, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  ' + String(extra).slice(0, 300) : '')); if (!cond) failed = true; };
  // An async route that throws is not caught by express 4: count it as a failure
  // (the request then times out below and the run ends, rolled back).
  process.on('unhandledRejection', (e) => { failed = true; console.error('ROUTE ERROR (unhandled):', e); });

  // Every route call runs as the owner.
  const owner = await q1("SELECT id, name, role FROM users WHERE role='owner' ORDER BY id LIMIT 1");
  const auth = require(S + '/src/middleware/auth.js');
  auth.authenticate = (req, res, next) => { req.user = owner; next(); };
  // The Product QC photo: no real file is stored — the upload step is stubbed.
  const upload = require(S + '/src/middleware/upload.js');
  upload.deleteFromStorage = async () => {};
  upload.copyInStorage = async () => {};
  upload.uploadChecklistPhoto = [(req, res, next) => { req.file = { storagePath: 'test/qc.jpg', filename: 'qc.jpg', originalname: 'qc.jpg' }; next(); }];
  // The finished-goods job card file: nothing stored either.
  upload.uploadJobCard = [(req, res, next) => { req.file = { storagePath: 'test/jc.pdf', filename: 'jc.pdf', originalname: 'jc.pdf' }; next(); }];
  // No WhatsApp copy of any alert leaves the test (the fins alert below).
  const wa = require(S + '/src/lib/whatsapp.js');
  wa.queueWhatsApp = async () => {};

  const ded = require(S + '/src/lib/inventoryDeduction.js');
  // A made-up fins code (0.011 kg per 50.8 mm, as FIN-MS-08), so no real fins
  // stock is touched. Same array/object every module reads, for this run only.
  ded.FINS_WEIGHT_PER_BASE['ZZTEST-IQC-FIN'] = 0.011;
  ded.FINS_CODES.push('ZZTEST-IQC-FIN');
  const { takeLastStage } = require(S + '/src/lib/lastStageTake.js');
  const { applyBomCorrection } = require(S + '/src/lib/bomCorrection.js');
  const { applyMaterialDeductions } = require(S + '/src/lib/materialDeduction.js');
  const { isCountedItem } = require(S + '/src/lib/countedStock.js');
  const { approveSplitRequest } = require(S + '/src/services/actions/splitRequests.js');
  const express = require(S + '/node_modules/express');
  const app = express();
  app.use(express.json());
  app.use('/api/job-cards', require(S + '/src/routes/jobCards.js'));
  app.use('/api/qc', require(S + '/src/routes/qc.js'));
  app.use('/api/dispatch', require(S + '/src/routes/dispatch.js'));
  app.use('/api/orders', require(S + '/src/routes/orders.js'));
  const server = app.listen(0);
  const base = 'http://127.0.0.1:' + server.address().port;
  // The stages that must be done before stage 29, read from the route itself.
  const MANDATORY = JSON.parse(fs.readFileSync(S + '/src/routes/jobCards.js', 'utf8').match(/const MANDATORY_STAGES = (\[[^\]]+\])/)[1]);

  try {
    // ── Ready? The new columns and the 'inventory_qc' status must exist ──
    const cols = (await qa(`SELECT column_name FROM information_schema.columns WHERE table_name='job_cards' AND column_name = ANY($1)`,
      [['last_stage_taken_at', 'product_qc_at', 'product_qc_by', 'inventory_qc_at', 'inventory_qc_by', 'qc_fg_location', 'qc_split_notes']])).length;
    const con = await q1(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='job_cards_status_check'`);
    const tcol = await q1(`SELECT 1 AS x FROM information_schema.columns WHERE table_name='inventory_transactions' AND column_name='job_card_id'`);
    if (cols < 7 || !/inventory_qc/.test(con?.d || '') || !tcol || !owner) {
      ok('Database ready for Inventory QC (start the new server on it once first) and an owner user exists', false,
        `columns ${cols}/7, status 'inventory_qc' allowed ${/inventory_qc/.test(con?.d || '')}, inventory_transactions.job_card_id ${!!tcol}, owner ${!!owner}`);
      return;
    }
    const uid = owner.id;

    const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
    const stock = async (id) => Number((await q1('SELECT current_stock FROM inventory_items WHERE id=$1', [id])).current_stock);
    const line = async (oi, inv) => q1('SELECT qty::float q, qty_deducted::float d, COALESCE(qty_waived,0)::float w FROM order_item_inventory WHERE order_item_id=$1 AND inventory_item_id=$2', [oi, inv]);
    const cardRow = async (id) => q1('SELECT * FROM job_cards WHERE id=$1', [id]);
    const settledFlag = async (oi) => (await q1('SELECT inventory_deducted f FROM order_items WHERE id=$1', [oi])).f;
    const bin = async (inv) => Number((await q1('SELECT COALESCE(SUM(qty),0) n FROM inventory_rework_bins WHERE item_id=$1', [inv])).n);
    const snap = async (ids) => { const o = {}; for (const id of ids) o[id] = await stock(id); return o; };
    const moved = async (s) => { const out = []; for (const [id, v] of Object.entries(s)) { const n = await stock(id); if (!near(n, v)) out.push(`item ${id}: ${v} → ${n}`); } return out.join('; '); };
    const call = async (method, url, body) => {
      const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };

    const mkItem = async (code, cat, s, unit) => (await q1(
      `INSERT INTO inventory_items (item_code, name, unit, category, current_stock, unit_cost) VALUES ($1,$1,$2,$3,$4,1) RETURNING id`, [code, unit, cat, s])).id;
    const mkOrder = async (code, type = 'local_he', material = false) => (await q1(
      `INSERT INTO orders (order_code, customer_id, order_date, order_type, status, material_deduction)
       VALUES ($1, (SELECT MIN(id) FROM customers), CURRENT_DATE, $2, 'in_progress', $3) RETURNING id`, [code, type, material])).id;
    const mkLine = async (order, qty, dwg, tube = null) => (await q1(
      `INSERT INTO order_items (order_id, quantity, drawing_number, tube_material) VALUES ($1,$2,$3,$4) RETURNING id`, [order, qty, dwg, tube])).id;
    const mkCard = async (order, oi, no, qty, { status = 'in_progress', dwg = null, fg = false } = {}) => (await q1(
      `INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, drawing_no, is_fg)
       VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,$6,$7) RETURNING id`, [no, order, oi, qty, status, dwg, fg])).id;
    const putLine = (oi, inv, qty, d = 0) => client.query(
      `INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty, qty_deducted) VALUES ($1,$2,$3,$4)`, [oi, inv, qty, d]);
    // Stages marked done on the card directly (the floor's checks are not under test here).
    const tick = async (card, stages, { value1 = {}, rejected = {}, remade = {} } = {}) => {
      for (const st of stages) await client.query(
        `INSERT INTO production_checklist (job_card_id, stage_no, done, value1, rejection_qty, remade_qty, done_at) VALUES ($1,$2,1,$3,$4,$5,NOW())
         ON CONFLICT (job_card_id, stage_no) DO UPDATE SET done=1, done_at=NOW()`,
        [card, st, value1[st] ?? null, rejected[st] || 0, remade[st] || 0]);
    };
    const report = (card) => client.query(`INSERT INTO qc_reports (job_card_id, result, product_weight, created_by) VALUES ($1,'approved',1,$2)`, [card, uid]);
    // A stock-history row only (no stock change) — older rows written before the card column.
    const hist = (inv, type, qty, notes, oi) => client.query(
      `INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by, order_item_id, source)
       VALUES ($1,$2,$3,0,$4,$5,$6,$7)`, [inv, type, qty, notes, uid, oi, oi ? 'bom' : null]);
    const take = (card) => takeLastStage(txDb, { id: card }, uid);
    const lastStageRows = (card, inv) => qa(
      `SELECT quantity::float q, notes, job_card_id, order_item_id, source FROM inventory_transactions
        WHERE item_id=$1 AND job_card_id=$2 AND strpos(notes, 'Last stage (JC ') > 0`, [inv, card]);
    const split = async (card, qty) => {
      const sr = (await q1(`INSERT INTO job_card_split_requests (job_card_id, qty, reason, status) VALUES ($1,$2,'test','pending') RETURNING id`, [card, qty])).id;
      return approveSplitRequest(txDb, { requestId: sr, actor: owner });
    };

    const NUT = await mkItem('ZZTEST-IQC-NUT', 'Nut', 1000, 'pcs');
    const WIRE = await mkItem('ZZTEST-IQC-WIRE', 'Wire', 100, 'kg');
    const FLG = await mkItem('ZZTEST-IQC-FLG', 'Flange', 500, 'pcs');           // stage 15
    const NIP = await mkItem('ZZTEST-IQC-NIP', 'Nipple Washer', 500, 'pcs');    // stage 21
    const FIN = await mkItem('ZZTEST-IQC-FIN', 'Finns', 50, 'kg');
    const WSH = await mkItem('ZZTEST-IQC-WSH', 'Washer', 2, 'pcs');
    const PIN = await mkItem('ZZTEST-IQC-PIN', 'Terminal Pin', 500, 'pcs');
    const OLD = await mkItem('ZZTEST-IQC-OLD', 'Nut', 500, 'pcs');
    const TUBC = await mkItem('TUB-ZZTEST-IQC', 'Tube', 300, 'foot');           // counted stock
    const TUBE = await mkItem('ZZTEST-IQC-TUBE', 'Tube', 300, 'foot');          // the order line's own tube, not counted
    ok('TUB-ZZTEST-IQC is counted stock; ZZTEST-IQC-TUBE (the order line\'s tube) is not', isCountedItem('TUB-ZZTEST-IQC') && !isCountedItem('ZZTEST-IQC-TUBE'));

    // ════ A. One card through the real routes: last stage → Product QC → Inventory QC → done ════
    // An item of 12 pieces with one card of 6 (the other 6 never carded). List per
    // piece: 4 nuts, 0.25 kg wire, 2 flanges (stage 15), 1 nipple washer (stage 21),
    // fins by length. 2 pieces rejected and 1 remade on the floor.
    const oA = await mkOrder('ZZT-IQC-A', 'local_he', true);
    const oiA = await mkLine(oA, 12, 'ZZTEST-DWG-A', 'ZZTEST-IQC-TUBE');
    await putLine(oiA, NUT, 48); await putLine(oiA, WIRE, 3); await putLine(oiA, FLG, 24); await putLine(oiA, NIP, 12); await putLine(oiA, FIN, 1);
    const A1 = await mkCard(oA, oiA, 'ZZT-IQC-A1', 6, { dwg: 'ZZTEST-DWG-A' });
    await tick(A1, [...MANDATORY, 15, 21], { value1: { 8: '508' }, rejected: { 10: 2 }, remade: { 10: 1 } });
    await ded.deductStageCategories(txDb, await cardRow(A1), 15, uid);
    await ded.deductStageCategories(txDb, await cardRow(A1), 21, uid);
    ok('A0. stages 15 / 21 took the card\'s half: 12 flanges, 6 nipple washers', near((await line(oiA, FLG)).d, 12) && near((await line(oiA, NIP)).d, 6));

    const allA = [NUT, WIRE, FLG, NIP, FIN, WSH, OLD, TUBC, TUBE];
    let s0 = await snap(allA);
    let r = await call('PUT', `/api/job-cards/${A1}/checklist/29`, { done: true });
    let c = await cardRow(A1);
    ok('A1. stage 29 ticked on the checklist: card waits for Product QC, last-stage take stamped',
      r.status === 200 && c.status === 'qc_pending' && !!c.last_stage_taken_at, `${r.status} ${JSON.stringify(r.body)} ${c.status}`);
    ok('A1. the rest of the list is taken for the FULL card qty (6, though 2 were rejected): 24 nuts, 1.5 kg wire',
      near(await stock(NUT), s0[NUT] - 24) && near(await stock(WIRE), s0[WIRE] - 1.5), await moved(s0));
    ok('A1. flanges and nipple washers are not taken again — this card ticked their stages',
      near(await stock(FLG), s0[FLG]) && near(await stock(NIP), s0[NIP]), await moved(s0));
    ok('A1. fins at the last stage by the job card length, card qty: 508 mm × 0.011 kg/50.8 mm × 6 = 0.66 kg',
      near(await stock(FIN), s0[FIN] - 0.66) && c.fins_deducted === true && near(c.fins_kg, 0.66), `${s0[FIN]} → ${await stock(FIN)}, fins_kg ${c.fins_kg}`);
    let L = await line(oiA, NUT);
    ok('A1. the list line counts it as taken (nuts 24 of 48)', near(L.d, 24) && near(L.w, 0), JSON.stringify(L));
    const [nr] = await lastStageRows(A1, NUT);
    ok('A1. its stock row is tied to the card and the line, noted "Last stage (JC …)"',
      nr && nr.notes === 'Order: ZZT-IQC-A | Dwg: ZZTEST-DWG-A | Last stage (JC ZZT-IQC-A1)' && nr.order_item_id === oiA && nr.source === 'bom' && near(nr.q, 24), JSON.stringify(nr));

    s0 = await snap(allA);
    const rUndo = await call('PUT', `/api/job-cards/${A1}/checklist/29`, { done: false });
    const rRetick = await call('PUT', `/api/job-cards/${A1}/checklist/29`, { done: true });
    const again = await take(A1);
    ok('A2. stage 29 undone and ticked again, and the take called once more: nothing given back, nothing taken twice',
      rUndo.status === 200 && rRetick.status === 200 && !(await moved(s0)) && again.taken.length === 0 && (await cardRow(A1)).status === 'qc_pending', await moved(s0));

    // Older stock rows with no card column, tied to a card by its notes only —
    // this card's exact number, never its split card -P1. Plus one whole-line settle row.
    await hist(OLD, 'dispatch_to_production', 7, 'Order: ZZT-IQC-A | Dwg: ZZTEST-DWG-A | Stage 21 Nipple Press (JC ZZT-IQC-A1)', oiA);
    await hist(OLD, 'dispatch_to_production', 5, 'Order: ZZT-IQC-A | Dwg: ZZTEST-DWG-A | Stage 21 Nipple Press (JC ZZT-IQC-A1-P1)', oiA);
    await hist(OLD, 'scrap', 0.2, 'Scrap coil 0.2 Kgs (coil scrap, Stage 3) — ZZT-IQC-A · ZZTEST-DWG-A · JC ZZT-IQC-A1', null);
    await hist(OLD, 'scrap', 0.3, 'Scrap coil 0.3 Kgs (coil scrap, Stage 3) — ZZT-IQC-A · ZZTEST-DWG-A · JC ZZT-IQC-A1-P1', null);
    await hist(OLD, 'dispatch_to_production', 1, 'Order: ZZT-IQC-A | Dwg: ZZTEST-DWG-A | Consumed (QC/dispatch)', oiA);

    // ── Product QC ──
    await report(A1);
    let list = await call('GET', '/api/qc');
    ok('A3. the card is on the Product QC list', list.status === 200 && list.body.some(y => y.id === A1));
    s0 = await snap(allA);
    r = await call('PUT', `/api/qc/${A1}/approve`, { heater_destination: 'dispatch',
      remake_extras: [{ inventory_item_id: NUT, qty: 3 }], rework_items: [{ inventory_item_id: NUT, qty: 2 }] });
    c = await cardRow(A1);
    ok('A3. Product QC approve: the card moves to Inventory QC, recording 5 to dispatch (6 − 2 rejected + 1 remade)',
      r.status === 200 && r.body.status === 'inventory_qc' && c.status === 'inventory_qc' && c.qc_route === 'dispatch'
      && Number(c.qc_dispatch_qty) === 5 && Number(c.qc_fg_qty) === 0 && !!c.product_qc_at && c.product_qc_by === uid && !c.inventory_qc_at,
      `${r.status} ${JSON.stringify(r.body)}`);
    ok('A3. …takes and gives back nothing; remake extras and rework sent to it are ignored',
      !(await moved(s0)) && (await bin(NUT)) === 0
      && Number((await q1(`SELECT COUNT(*) n FROM inventory_transactions WHERE job_card_id=$1 AND source='remake'`, [A1])).n) === 0, await moved(s0));
    ok('A3. …no Finished Goods intake', Number((await q1(`SELECT COUNT(*) n FROM finished_goods_log WHERE job_card_no='ZZT-IQC-A1'`)).n) === 0);
    ok('A3. …the timeline says it waits for Inventory QC',
      logs.some(l => l.jc === A1 && /Product QC approved — 5 to dispatch \/ 0 to Finished Goods — waiting for Inventory QC/.test(l.desc)));
    ok('A3. …the order still shows QC pending (no new order status)', (await q1('SELECT status FROM orders WHERE id=$1', [oA])).status === 'qc_pending');
    list = await call('GET', '/api/qc');
    let queue = await call('GET', '/api/qc/inventory-queue');
    ok('A3. it leaves the Product QC list and is on the Inventory QC list',
      !list.body.some(y => y.id === A1) && queue.status === 200 && queue.body.some(y => y.id === A1));
    r = await call('PUT', `/api/dispatch/${A1}/mark-dispatched`, {});
    ok('A3. dispatch refuses a card waiting for Inventory QC', r.status === 400 && /waiting for Inventory QC/.test(r.body.error || ''), JSON.stringify(r.body));

    // ── Inventory QC screen ──
    const rowOf = (view, inv) => (view.items || []).find(i => i.inventory_item_id === inv);
    let v = (await call('GET', `/api/qc/${A1}/inventory`)).body;
    ok('A4. Inventory QC screen: editable, tube / NUT-BR-M4-08 not locked, the routing Product QC recorded',
      v.editable === true && v.counted_locked === false && v.routing?.route === 'dispatch' && Number(v.routing?.dispatch_qty) === 5,
      JSON.stringify({ e: v.editable, c: v.counted_locked, r: v.routing }));
    let x = rowOf(v, NUT);
    ok('A4. nuts: taken 24, net 24, on the list at 4 a piece = 24 for this card',
      x && near(x.taken, 24) && near(x.net, 24) && x.on_list && near(x.list_qty_per_piece, 4) && near(x.list_qty_for_card, 24), JSON.stringify(x));
    ok('A4. the stage takes and fins show under the card: flanges 12, nipple washers 6, fins 0.66 kg',
      near(rowOf(v, FLG)?.taken, 12) && near(rowOf(v, NIP)?.taken, 6) && near(rowOf(v, FIN)?.taken, 0.66) && near(v.materials?.fins_kg, 0.66));
    x = rowOf(v, OLD);
    ok('A4. older rows matched by the exact card number only: taken 7, scrap 0.2 — never its split card -P1',
      x && near(x.taken, 7) && near(x.scrap, 0.2) && near(x.net, 7.2) && !x.on_list, JSON.stringify(x));
    ok('A4. a whole-line settle row is listed apart ("item-level, not by card")',
      (v.item_level || []).some(t => t.item_id === OLD && /Consumed \(QC\/dispatch\)/.test(t.notes))
      && !(v.movements || []).some(t => /Consumed \(QC\/dispatch\)/.test(t.notes || '')));

    // ── Inventory QC changes ──
    let nChanges = 0;
    const adjust = async (changes) => {
      const res = await call('POST', `/api/qc/${A1}/inventory/adjust`, { changes });
      if (res.status === 200) nChanges += res.body.applied.length;
      return res;
    };
    s0 = await snap(allA);
    r = await adjust([{ inventory_item_id: NUT, kind: 'take', qty: 2 }, { inventory_item_id: WIRE, kind: 'give_back', qty: 0.5 }]);
    // QC's changes are the card's own: the order line's figures stay as the
    // last stage left them, so sister cards take exactly their share.
    ok('A5. take more: 2 more nuts out of stock, as this card\'s own — the line still counts 24',
      r.status === 200 && near(await stock(NUT), s0[NUT] - 2) && near((await line(oiA, NUT)).d, 24), JSON.stringify(r.body));
    ok('A5. give back: 0.5 kg wire back to stock, the line still counts 1.5', near(await stock(WIRE), s0[WIRE] + 0.5) && near((await line(oiA, WIRE)).d, 1.5));
    r = await adjust([{ inventory_item_id: NIP, kind: 'give_back', qty: 3 }, { inventory_item_id: WSH, kind: 'take', qty: 3, note: 'washers fitted, not nipple washers' }]);
    const wshRow = await q1(`SELECT order_item_id, source FROM inventory_transactions WHERE item_id=$1 AND job_card_id=$2 ORDER BY id DESC LIMIT 1`, [WSH, A1]);
    ok('A6. swap a wrong item: 3 nipple washers back, 3 washers taken (tied to the card and the order line as an Inventory QC change, not added to the list)',
      r.status === 200 && near(await stock(NIP), s0[NIP] + 3) && near(await stock(WSH), s0[WSH] - 3) && near((await line(oiA, NIP)).d, 6)
      && wshRow?.order_item_id === oiA && wshRow?.source === 'inventory_qc' && !(await line(oiA, WSH)), JSON.stringify(r.body));
    ok('A6. stock may go below zero — saved, and the answer flags it',
      (r.body.negative || []).some(n => n.inventory_item_id === WSH && near(n.current_stock, -1)), JSON.stringify(r.body.negative));
    r = await adjust([{ inventory_item_id: NUT, kind: 'scrap', qty: 1, note: 'dropped' }]);
    const scrapRow = await q1(`SELECT transaction_type FROM inventory_transactions WHERE item_id=$1 AND job_card_id=$2 ORDER BY id DESC LIMIT 1`, [NUT, A1]);
    ok('A7. scrap: 1 nut more out of stock, as scrap; the line\'s count stays 24',
      r.status === 200 && scrapRow?.transaction_type === 'scrap' && near(await stock(NUT), s0[NUT] - 3) && near((await line(oiA, NUT)).d, 24), JSON.stringify(scrapRow));
    r = await adjust([{ inventory_item_id: NUT, kind: 'rework', qty: 5 }]);
    ok('A8. rework: 5 recovered nuts into the rework bin, tied to the card; normal stock unchanged',
      r.status === 200 && (await bin(NUT)) === 5 && near(await stock(NUT), s0[NUT] - 3)
      && Number((await q1(`SELECT COALESCE(SUM(qty),0) n FROM inventory_rework_moves WHERE job_card_id=$1 AND kind='deposit' AND item_id=$2`, [A1, NUT])).n) === 5,
      JSON.stringify(r.body));

    const iqcLog = async (card) => Number((await q1(`SELECT COUNT(*) n FROM activity_log WHERE job_card_id=$1 AND activity_type='inventory_qc'`, [card])).n);
    const n0 = await iqcLog(A1);
    s0 = await snap(allA);
    r = await adjust([{ inventory_item_id: NUT, kind: 'take', qty: 1 }, { inventory_item_id: NUT, kind: 'rework', qty: 100 }]);
    ok('A9. reworking 100 nuts, more than the card used, is refused — and the whole batch with it (its take of 1 is undone too)',
      r.status === 400 && /more than this card used/.test(r.body.error || '') && !(await moved(s0)) && near((await line(oiA, NUT)).d, 24)
      && (await bin(NUT)) === 5 && (await iqcLog(A1)) === n0, r.body.error);
    r = await adjust([{ inventory_item_id: WIRE, kind: 'rework', qty: 1 }]);
    ok('A9. rework of an item counted in kg is refused', r.status === 400 && /only counted parts can be reworked/.test(r.body.error || ''), r.body.error);
    r = await adjust([{ inventory_item_id: NUT, kind: 'take', qty: 0 }]);
    ok('A9. a change with no quantity is refused', r.status === 400, r.body.error);

    s0 = await snap(allA);
    r = await adjust([{ inventory_item_id: TUBC, kind: 'take', qty: 2 }]);
    ok('A10. counted tube TUB-ZZTEST-IQC CAN be changed at Inventory QC (card was not through QC before): 2 ft taken',
      r.status === 200 && near(await stock(TUBC), s0[TUBC] - 2), JSON.stringify(r.body));
    r = await adjust([{ inventory_item_id: TUBE, kind: 'take', qty: 3 }]);
    const rBack = await adjust([{ inventory_item_id: TUBE, kind: 'give_back', qty: 1 }]);
    c = await cardRow(A1);
    ok('A11. the card\'s own tube goes by FIFO and keeps the card\'s figure in step: 3 taken, 1 back → tube used 2 ft',
      r.status === 200 && rBack.status === 200 && near(await stock(TUBE), s0[TUBE] - 2) && near(c.tube_used_qty, 2) && c.tube_deducted === true,
      JSON.stringify({ used: c.tube_used_qty, flag: c.tube_deducted }));

    v = (await call('GET', `/api/qc/${A1}/inventory`)).body;
    x = rowOf(v, NUT);
    ok(`A12. the screen shows it all: nuts taken 26, scrap 1, reworked 5, net 27; ${nChanges} changes on the card's Inventory QC log`,
      x && near(x.taken, 26) && near(x.scrap, 1) && near(x.reworked, 5) && near(x.net, 27) && (v.changes || []).length === nChanges
      && v.changes.some(ch => /scrap 1 pcs ZZTEST-IQC-NUT on ZZT-IQC-A1 — dropped/.test(ch.description)), JSON.stringify({ x, n: (v.changes || []).length, nChanges }));
    queue = await call('GET', '/api/qc/inventory-queue');
    ok('A12. the Inventory QC list counts the changes', queue.body.find(y => y.id === A1)?.inventory_qc_changes === nChanges);

    // ── Inventory QC done ──
    s0 = await snap(allA);
    r = await call('PUT', `/api/qc/${A1}/inventory-done`);
    c = await cardRow(A1);
    ok('A13. Inventory QC done: card QC-approved and on to dispatch, stamped by whom and when',
      r.status === 200 && r.body.status === 'qc_approved' && r.body.route === 'dispatch' && r.body.dispatch_qty === 5 && r.body.finished_good_id === null
      && c.status === 'qc_approved' && !!c.inventory_qc_at && c.inventory_qc_by === uid, JSON.stringify(r.body));
    ok('A13. the timeline carries the same approval line as before', logs.some(l => l.jc === A1 && l.desc === 'Job card ZZT-IQC-A1 QC Approved — 5 units going to dispatch'));
    ok('A13. done itself moves no stock', !(await moved(s0)), await moved(s0));
    const LN = await line(oiA, NUT), LW = await line(oiA, WIRE), LF = await line(oiA, FLG), LP = await line(oiA, NIP), LFin = await line(oiA, FIN);
    // Only 6 of the 12 ordered pieces have a card: the item is NOT settled yet,
    // so a top-up card for the other 6 still takes its own share later.
    ok('A14. half the item has no card yet: nothing settled, nothing taken, the line keeps the card\'s take (nuts 24, wire 1.5, flanges 12, nipple washers 6)',
      (await settledFlag(oiA)) === false && near(LN.d, 24) && near(LN.w, 0) && near(LW.d, 1.5) && near(LW.w, 0) && near(LF.d, 12) && near(LF.w, 0)
      && near(LP.d, 6) && near(LP.w, 0) && near(LFin.d, 0.66) && near(LFin.w, 0), JSON.stringify({ LN, LW, LF, LP, LFin }));

    r = await adjust([{ inventory_item_id: NUT, kind: 'take', qty: 1 }]);
    const rDone2 = await call('PUT', `/api/qc/${A1}/inventory-done`);
    v = (await call('GET', `/api/qc/${A1}/inventory`)).body;
    ok('A15. after done, nothing more: a change is refused, done again is refused, the screen is read-only',
      r.status === 400 && rDone2.status === 400 && v.editable === false, `${r.status} ${rDone2.status} ${v.editable}`);

    const dcard = (await call('GET', '/api/job-cards')).body.find(y => y.id === A1);
    ok(`A16. dispatch screens show who passed Product QC and Inventory QC, and ${nChanges} changes (rework 1, scrap 1)`,
      dcard && dcard.product_qc_by_name === owner.name && dcard.inventory_qc_by_name === owner.name
      && dcard.inventory_qc_changes === nChanges && dcard.inventory_qc_rework === 1 && dcard.inventory_qc_scrap === 1,
      JSON.stringify(dcard && { p: dcard.product_qc_by_name, i: dcard.inventory_qc_by_name, n: dcard.inventory_qc_changes, rw: dcard.inventory_qc_rework, s: dcard.inventory_qc_scrap }));

    // ── The lock: Inventory QC done was the final change to this card's inventory ──
    s0 = await snap(allA);
    let b = await applyBomCorrection(txDb, { orderItemId: oiA, userId: uid, userRole: 'owner',
      sels: [{ id: NUT, qty: 60 }, { id: WIRE, qty: 3 }, { id: FLG, qty: 24 }, { id: NIP, qty: 12 }, { id: FIN, qty: 1 }] });
    ok('A17. a corrected list on a line with a card through Inventory QC moves nothing — not the raised nuts, not the washers or ZZTEST-IQC-OLD left off the list — and says why',
      b.mode === 'difference' && !b.moves.length && !(await moved(s0)) && /at or through Inventory QC, where QC settles its inventory/.test(b.summary),
      `${b.mode} | ${b.summary} | ${await moved(s0)}`);
    s0 = await snap([TUBE]);
    await client.query('UPDATE production_checklist SET done=0, done_at=NULL WHERE job_card_id=$1 AND stage_no=5', [A1]);
    await applyMaterialDeductions(txDb, A1, 5, false, uid);
    await client.query('UPDATE production_checklist SET done=1, done_at=NOW() WHERE job_card_id=$1 AND stage_no=5', [A1]);
    await applyMaterialDeductions(txDb, A1, 5, true, uid);
    c = await cardRow(A1);
    ok('A18. Stage 5 undone and ticked again on the closed card: no tube back, none taken, the card keeps 2 ft, and the timeline says why',
      !(await moved(s0)) && near(c.tube_used_qty, 2) && c.tube_deducted === true && logs.filter(l => l.jc === A1 && l.type === 'inventory_locked').length === 2,
      `${await moved(s0)} | used ${c.tube_used_qty} | ${logs.filter(l => l.jc === A1 && l.type === 'inventory_locked').map(l => l.desc).join(' | ')}`);
    s0 = await snap(allA);
    r = await call('PUT', `/api/qc/${A1}/reject`, { notes: 'test reversal', send_to: 'qc' });
    c = await cardRow(A1);
    ok('A19. the owner reverses the approval: no stock moves, the 5 reworked nuts stay in the bin, the recorded routing is cleared',
      r.status === 200 && c.status === 'qc_pending' && !(await moved(s0)) && (await bin(NUT)) === 5 && c.qc_route === null && c.qc_fg_location === null,
      `${r.status} ${JSON.stringify(r.body)} ${await moved(s0)}`);

    // ════ B. Three cards of 1 on an item of 3: shares, rounding, the cap ════
    const oB = await mkOrder('ZZT-IQC-B');
    const oiB = await mkLine(oB, 3, 'ZZTEST-DWG-B');
    await putLine(oiB, NUT, 5); await putLine(oiB, WIRE, 1);
    const B = [];
    for (const n of [1, 2, 3]) B.push(await mkCard(oB, oiB, `ZZT-IQC-B${n}`, 1, { dwg: 'ZZTEST-DWG-B' }));
    s0 = await snap([NUT, WIRE]);
    let t = await take(B[0]);
    ok('B1. first card\'s share: 5 nuts ÷ 3 = 1.67 → 2 whole pieces; 1 kg wire ÷ 3 → 0.3333 kg (4 places)',
      near(await stock(NUT), s0[NUT] - 2) && near(await stock(WIRE), s0[WIRE] - 0.3333), JSON.stringify(t.taken));
    await take(B[1]);
    t = await take(B[2]);
    ok('B2. the third card takes only what is left on the line — 1 nut, not 2: the line is never over-taken',
      near(await stock(NUT), s0[NUT] - 5) && near((await line(oiB, NUT)).d, 5) && t.taken.find(y => y.inventory_item_id === NUT)?.qty === 1, JSON.stringify(t.taken));
    ok('B2. wire: 3 × 0.3333 kg', near(await stock(WIRE), s0[WIRE] - 0.9999) && near((await line(oiB, WIRE)).d, 0.9999));
    ok('B2. every card stamped', (await qa('SELECT last_stage_taken_at FROM job_cards WHERE id = ANY($1)', [B])).every(y => !!y.last_stage_taken_at));
    await client.query(`UPDATE job_cards SET status='dispatched', dispatched_at=NOW() WHERE id = ANY($1)`, [B]);
    s0 = await snap([NUT, WIRE]);
    await ded.settleItemInventory(txDb, oiB, uid, 'ZZT-IQC-B', { atDispatch: true });
    ok('B3. all three dispatched: the item settles without taking anything more', !(await moved(s0)) && (await settledFlag(oiB)) === true, await moved(s0));

    // ════ C. Stage 15 / 21 parts at the last stage: skipped when the card's stage was ticked, taken when not ════
    const oC = await mkOrder('ZZT-IQC-C');
    const oiC = await mkLine(oC, 20, 'ZZTEST-DWG-C');
    await putLine(oiC, FLG, 40); await putLine(oiC, NIP, 20); await putLine(oiC, NUT, 80);
    const C1 = await mkCard(oC, oiC, 'ZZT-IQC-C1', 10, { dwg: 'ZZTEST-DWG-C' });
    const C2 = await mkCard(oC, oiC, 'ZZT-IQC-C2', 10, { dwg: 'ZZTEST-DWG-C' });
    await tick(C1, [15]);   // Brazing ticked, its flanges never taken (e.g. added to the list after)
    s0 = await snap([FLG, NIP, NUT]);
    await take(C1);
    ok('C1. Brazing ticked on the card: its flanges are NOT taken at the last stage; Nipple Press never ticked: its 10 are; nuts 40',
      near(await stock(FLG), s0[FLG]) && near(await stock(NIP), s0[NIP] - 10) && near(await stock(NUT), s0[NUT] - 40), await moved(s0));
    await ded.deductStageCategories(txDb, await cardRow(C2), 15, uid);   // stage 15 took its flanges; no ticked row left
    s0 = await snap([FLG, NIP, NUT]);
    await take(C2);
    ok('C2. a card whose stage 15 already took its 20 flanges takes none again, though 20 are still open on the line',
      near(await stock(FLG), s0[FLG]) && near((await line(oiC, FLG)).d, 20) && near(await stock(NIP), s0[NIP] - 10) && near(await stock(NUT), s0[NUT] - 40), await moved(s0));

    // ════ D. A finished-goods card: stage 4 is its last stage, only the prep parts ════
    const oD = await mkOrder('ZZT-IQC-D', 'finished_goods');
    const oiD = await mkLine(oD, 5, 'ZZTEST-DWG-D');
    await putLine(oiD, NUT, 10); await putLine(oiD, PIN, 10); await putLine(oiD, FIN, 0.5);
    const D1 = await mkCard(oD, oiD, 'ZZT-IQC-D1', 5, { dwg: 'ZZTEST-DWG-D', fg: true });
    await tick(D1, [1, 2, 3]);
    s0 = await snap([NUT, PIN, FIN]);
    r = await call('PUT', `/api/job-cards/${D1}/checklist/4`, { done: true });
    c = await cardRow(D1);
    ok('D1. finished-goods card ticks stage 4 (Ready for Dispatch): to Product QC, last-stage take stamped',
      r.status === 200 && c.status === 'qc_pending' && !!c.last_stage_taken_at, `${r.status} ${JSON.stringify(r.body)}`);
    ok('D1. only the prep parts are taken: 10 nuts; fins are NEVER taken by the kg on the list (owner, 9 Oct 2026) — this card has no store row, so none, and it is flagged; the terminal pins are inside the heater already',
      near(await stock(NUT), s0[NUT] - 10) && near(await stock(FIN), s0[FIN]) && near(await stock(PIN), s0[PIN]) && !c.fins_deducted
      && (await qa(`SELECT 1 FROM activity_log WHERE job_card_id=$1 AND activity_type='fins_no_length'`, [D1])).length === 1, await moved(s0));

    // ════ D2. Finished goods: fins by the store heaters' tube length; nothing by stage (owner, 8 Oct 2026) ════
    // The heaters in the store were made on ZZT-IQC-SRC1 (stage 8: 508 mm). A
    // finished-goods order of 5 with fins on its list at 0 kg (auto) and
    // material deduction on.
    const oSrc = await mkOrder('ZZT-IQC-SRC', 'inventory_order');
    const oiSrc = await mkLine(oSrc, 5, 'ZZTEST-DWG-SRC-1');
    const SRC1 = await mkCard(oSrc, oiSrc, 'ZZT-IQC-SRC1', 5, { status: 'qc_approved', dwg: 'ZZTEST-DWG-SRC-1' });
    await tick(SRC1, [8], { value1: { 8: '508' } });
    const fgRow = (await q1(
      `INSERT INTO finished_goods (job_card_id, order_id, drawing_no, base_drawing_no, qty_in, qty_available)
       VALUES ($1,$2,'ZZTEST-DWG-SRC-1','ZZTEST-DWG-SRC',5,5) RETURNING id`, [SRC1, oSrc])).id;
    await client.query(`INSERT INTO finished_goods_log (finished_good_id, movement_type, qty, job_card_no) VALUES ($1,'inward',5,'ZZT-IQC-SRC1')`, [fgRow]);
    const oG2 = await mkOrder('ZZT-IQC-G2', 'finished_goods', true);
    const oiG2 = await mkLine(oG2, 5, 'ZZTEST-DWG-SRC-1');
    await putLine(oiG2, NUT, 10); await putLine(oiG2, FIN, 0);
    r = await call('GET', `/api/orders/${oG2}/items/${oiG2}/fg-fins-length`);
    ok('D2. the list editor learns the store heaters\' length: 508 mm from ZZT-IQC-SRC1', r.status === 200 && r.body.length_mm === 508 && r.body.card_no === 'ZZT-IQC-SRC1', JSON.stringify(r.body));
    const G2 = (await q1(
      `INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, drawing_no, is_fg, fg_source_id)
       VALUES ('ZZT-IQC-G2-FG1',$1,$2,5,'in_progress',CURRENT_DATE,'ZZTEST-DWG-SRC-1',TRUE,$3) RETURNING id`, [oG2, oiG2, fgRow])).id;
    s0 = await snap([NUT, FIN, WIRE, TUBE, TUBC]);
    await tick(G2, [1, 2, 3]);
    for (const st of [3, 4]) await applyMaterialDeductions(txDb, G2, st, true, uid);   // what a stage tick runs
    ok('D2. stages on the finished-goods card take nothing by stage (its stage 4 is "Ready", not the coil stage)', !(await moved(s0)), await moved(s0));
    r = await call('PUT', `/api/job-cards/${G2}/checklist/4`, { done: true });
    c = await cardRow(G2);
    ok('D2. its last stage (4) takes the list: 10 nuts, and fins by the store heaters\' length — 508 mm × 0.011 kg/50.8 mm × 5 = 0.55 kg — no coil, tube or filling',
      r.status === 200 && near(await stock(NUT), s0[NUT] - 10) && near(await stock(FIN), s0[FIN] - 0.55) && c.fins_deducted === true && near(c.fins_kg, 0.55)
      && c.coil_deducted === false && c.tube_deducted === false && c.fill_deducted === false && near(await stock(TUBE), s0[TUBE]) && near(await stock(TUBC), s0[TUBC]),
      `${r.status} ${await moved(s0)} fins_kg ${c.fins_kg}`);
    const finRow = await q1(`SELECT notes FROM inventory_transactions WHERE item_id=$1 AND job_card_id=$2`, [FIN, G2]);
    ok('D2. the fins row says whose length it used', /store heaters' tube length, oldest first: 5 pcs × 508mm \(ZZT-IQC-SRC1\)/.test(finRow?.notes || ''), finRow?.notes);

    // ════ D3. Finished goods first in, first out (owner, 9 Oct 2026) ════
    // A store row with: 4 from ZZT-IQC-FA (508 mm), 3 by hand, 5 from
    // ZZT-IQC-FB (1016 mm), then 2 gone out. Nothing is picked: the card takes
    // the oldest pieces, and its fins go by each intake's length (the hand
    // entry: the average, 762 mm).
    const oFA = await mkOrder('ZZT-IQC-FA', 'inventory_order');
    const oiFA = await mkLine(oFA, 9, 'ZZTEST-DWG-FIFO');
    const FA = await mkCard(oFA, oiFA, 'ZZT-IQC-FA', 4, { status: 'qc_approved', dwg: 'ZZTEST-DWG-FIFO' });
    const FB = await mkCard(oFA, oiFA, 'ZZT-IQC-FB', 5, { status: 'qc_approved', dwg: 'ZZTEST-DWG-FIFO' });
    await tick(FA, [8], { value1: { 8: '508' } });
    await tick(FB, [8], { value1: { 8: '1016' } });
    const fgF = (await q1(
      `INSERT INTO finished_goods (job_card_id, order_id, drawing_no, base_drawing_no, qty_in, qty_available)
       VALUES ($1,$2,'ZZTEST-DWG-FIFO','ZZTEST-DWG-FIFO',12,10) RETURNING id`, [FA, oFA])).id;
    await client.query(`INSERT INTO finished_goods_log (finished_good_id, movement_type, qty, job_card_no, order_code) VALUES ($1,'inward',4,'ZZT-IQC-FA','ZZT-IQC-FA')`, [fgF]);
    await client.query(`INSERT INTO finished_goods_log (finished_good_id, movement_type, qty, notes) VALUES ($1,'inward',3,'Manual entry')`, [fgF]);
    await client.query(`INSERT INTO finished_goods_log (finished_good_id, movement_type, qty, job_card_no, order_code) VALUES ($1,'inward',5,'ZZT-IQC-FB','ZZT-IQC-FA')`, [fgF]);
    await client.query(`INSERT INTO finished_goods_log (finished_good_id, movement_type, qty, outward_type, client_name) VALUES ($1,'outward',2,'sampling','ZZTEST')`, [fgF]);
    const oG3 = await mkOrder('ZZT-IQC-G3', 'finished_goods', true);
    const oiG3 = await mkLine(oG3, 6, 'ZZTEST-DWG-FIFO-Finns');      // the store's drawing + a word
    await putLine(oiG3, NUT, 12); await putLine(oiG3, FIN, 0);
    r = await call('GET', `/api/orders/${oG3}/items/${oiG3}/fg-plan?qty=6`);
    const pl = r.body.parts || [];
    ok('D3. the plan for 6: the store row found by its drawing ("-Finns" after it), oldest first — 2 left of FA (508 mm), the 3 by hand (average 762 mm), 1 of FB (1016 mm)',
      r.status === 200 && r.body.store?.id === fgF && r.body.store.qty_available === 10 && pl.length === 3
      && pl[0].job_card_no === 'ZZT-IQC-FA' && pl[0].qty === 2 && pl[0].mm === 508
      && pl[1].hand === true && pl[1].qty === 3 && pl[1].mm === 762 && pl[1].mm_from === 'average'
      && pl[2].job_card_no === 'ZZT-IQC-FB' && pl[2].qty === 1 && pl[2].mm === 1016 && r.body.short === 0, JSON.stringify(r.body));
    r = await call('POST', '/api/job-cards/fg', { order_id: oG3, order_item_id: oiG3, qty: 6, dispatch_date: '2026-10-20' });
    const G3 = r.body.id;
    c = G3 ? await cardRow(G3) : {};
    const fb = typeof c.fg_batches === 'string' ? JSON.parse(c.fg_batches) : c.fg_batches;
    ok('D3. the card is made with nothing picked: it remembers FA 2, hand 3, FB 1; the store row goes 10 → 4',
      r.status === 201 && c.fg_source_id === fgF && Array.isArray(fb) && fb.length === 3 && fb[0].job_card_no === 'ZZT-IQC-FA' && fb[0].qty === 2
      && fb[1].job_card_no === null && fb[1].qty === 3 && fb[2].job_card_no === 'ZZT-IQC-FB' && fb[2].qty === 1
      && Number((await q1('SELECT qty_available FROM finished_goods WHERE id=$1', [fgF])).qty_available) === 4, `${r.status} ${JSON.stringify(r.body)} ${JSON.stringify(fb)}`);
    await tick(G3, [1, 2, 3]);
    s0 = await snap([NUT, FIN]);
    r = await call('PUT', `/api/job-cards/${G3}/checklist/4`, { done: true });
    c = await cardRow(G3);
    ok('D3. its last stage takes the fins by each intake: (2 × 508 + 3 × 762 + 1 × 1016) mm ÷ 50.8 × 0.011 kg = 0.935 kg, and the 12 nuts',
      r.status === 200 && near(await stock(FIN), s0[FIN] - 0.935) && near(await stock(NUT), s0[NUT] - 12) && c.fins_deducted === true && near(c.fins_kg, 0.935),
      `${r.status} ${await moved(s0)} fins_kg ${c.fins_kg}`);
    const oG4 = await mkOrder('ZZT-IQC-G4', 'finished_goods', true);
    const oiG4 = await mkLine(oG4, 4, 'ZZTEST-DWG-FIFO');
    await putLine(oiG4, NUT, 8);
    r = await call('POST', '/api/job-cards/fg', { order_id: oG4, order_item_id: oiG4, qty: 4, dispatch_date: '2026-10-20' });
    c = r.body.id ? await cardRow(r.body.id) : {};
    const fb4 = typeof c.fg_batches === 'string' ? JSON.parse(c.fg_batches) : c.fg_batches;
    ok('D3. the next card gets the next pieces: the 4 left of FB; the row is empty', r.status === 201 && fb4?.length === 1 && fb4[0].job_card_no === 'ZZT-IQC-FB' && fb4[0].qty === 4
      && Number((await q1('SELECT qty_available FROM finished_goods WHERE id=$1', [fgF])).qty_available) === 0, `${r.status} ${JSON.stringify(r.body)} ${JSON.stringify(fb4)}`);
    const oG5 = await mkOrder('ZZT-IQC-G5', 'finished_goods', true);
    const oiG5 = await mkLine(oG5, 1, 'ZZTEST-DWG-FIFO');
    await putLine(oiG5, NUT, 2);
    r = await call('POST', '/api/job-cards/fg', { order_id: oG5, order_item_id: oiG5, qty: 1, dispatch_date: '2026-10-20' });
    ok('D3. none left: refused', r.status === 400 && /Insufficient Finished Goods stock/.test(r.body.error || ''), JSON.stringify(r.body));
    // Part now, the rest later (owner, 10 Oct 2026): 5 ordered, 3 in the store.
    const fgP = (await q1(
      `INSERT INTO finished_goods (drawing_no, base_drawing_no, qty_in, qty_available) VALUES ('ZZTEST-DWG-PART','ZZTEST-DWG-PART',3,3) RETURNING id`)).id;
    await client.query(`INSERT INTO finished_goods_log (finished_good_id, movement_type, qty, job_card_no) VALUES ($1,'inward',3,'ZZT-IQC-FA')`, [fgP]);
    const oG7 = await mkOrder('ZZT-IQC-G7', 'finished_goods', true);
    const oiG7 = await mkLine(oG7, 5, 'ZZTEST-DWG-PART');
    await putLine(oiG7, NUT, 10);
    r = await call('POST', '/api/job-cards/fg', { order_id: oG7, order_item_id: oiG7, qty: 3, dispatch_date: '2026-10-20' });
    const p1 = r.body.job_card_no;
    ok('D4. 5 ordered, 3 in the store: a card for the 3 now', r.status === 201, JSON.stringify(r.body));
    r = await call('POST', '/api/job-cards/fg', { order_id: oG7, order_item_id: oiG7, qty: 3, dispatch_date: '2026-10-20' });
    ok('D4. a second card for more than the 2 left is refused', r.status === 400 && /Only 2 pcs of this item are left to card/.test(r.body.error || ''), JSON.stringify(r.body));
    await client.query(`INSERT INTO finished_goods_log (finished_good_id, movement_type, qty, job_card_no) VALUES ($1,'inward',2,'ZZT-IQC-FB')`, [fgP]);
    await client.query('UPDATE finished_goods SET qty_in=qty_in+2, qty_available=qty_available+2 WHERE id=$1', [fgP]);
    r = await call('POST', '/api/job-cards/fg', { order_id: oG7, order_item_id: oiG7, qty: 2, dispatch_date: '2026-10-20' });
    ok('D4. once 2 more are in the store, a second card for the 2 left — its own number', r.status === 201 && r.body.job_card_no && r.body.job_card_no !== p1, JSON.stringify(r.body));
    r = await call('POST', '/api/job-cards/fg', { order_id: oG7, order_item_id: oiG7, qty: 1, dispatch_date: '2026-10-20' });
    ok('D4. all 5 carded: no more cards', r.status === 409 && /already have inventory job cards/.test(r.body.error || ''), JSON.stringify(r.body));

    // A row made only by hand: no job card length anywhere — nothing guessed, flagged.
    const fgH = (await q1(
      `INSERT INTO finished_goods (drawing_no, base_drawing_no, qty_in, qty_available) VALUES ('ZZTEST-DWG-HAND','ZZTEST-DWG-HAND',3,3) RETURNING id`)).id;
    await client.query(`INSERT INTO finished_goods_log (finished_good_id, movement_type, qty, notes) VALUES ($1,'inward',3,'Manual entry')`, [fgH]);
    const oG6 = await mkOrder('ZZT-IQC-G6', 'finished_goods', true);
    const oiG6 = await mkLine(oG6, 2, 'ZZTEST-DWG-HAND');
    await putLine(oiG6, NUT, 4); await putLine(oiG6, FIN, 0);
    r = await call('POST', '/api/job-cards/fg', { order_id: oG6, order_item_id: oiG6, qty: 2, dispatch_date: '2026-10-20' });
    const G6 = r.body.id;
    await tick(G6, [1, 2, 3]);
    s0 = await snap([NUT, FIN]);
    r = await call('PUT', `/api/job-cards/${G6}/checklist/4`, { done: true });
    c = await cardRow(G6);
    ok('D3. heaters only ever entered by hand: the nuts are taken, the fins are not (no length to go by) and it is flagged for the owner and Design / QC',
      r.status === 200 && near(await stock(NUT), s0[NUT] - 4) && near(await stock(FIN), s0[FIN]) && !c.fins_deducted
      && (await qa(`SELECT 1 FROM activity_log WHERE job_card_id=$1 AND activity_type='fins_no_length'`, [G6])).length === 1, `${r.status} ${await moved(s0)}`);

    // ════ E. Split cards ════
    const oF = await mkOrder('ZZT-IQC-F');
    const oiF = await mkLine(oF, 10, 'ZZTEST-DWG-F');
    await putLine(oiF, NUT, 40);
    const F1 = await mkCard(oF, oiF, 'ZZT-IQC-F1', 10, { dwg: 'ZZTEST-DWG-F' });
    await tick(F1, [29]);
    await take(F1);
    await client.query(`UPDATE job_cards SET status='qc_pending' WHERE id=$1`, [F1]);
    let sres = await split(F1, 4);
    const F1c = sres?.data?.childJobCardId;
    c = F1c ? await cardRow(F1c) : null;
    s0 = await snap([NUT]);
    t = F1c ? await take(F1c) : { taken: ['no split card'] };
    ok('E1. split after the last stage: the split card inherits the take (its pieces were in it) and takes nothing',
      sres?.ok && c && !!c.last_stage_taken_at && new Date(c.last_stage_taken_at).getTime() === new Date((await cardRow(F1)).last_stage_taken_at).getTime()
      && !t.taken.length && !(await moved(s0)), JSON.stringify(sres));
    const oiF2 = await mkLine(oF, 10, 'ZZTEST-DWG-F2');
    await putLine(oiF2, NUT, 40);
    const F2 = await mkCard(oF, oiF2, 'ZZT-IQC-F2', 10, { dwg: 'ZZTEST-DWG-F2' });
    sres = await split(F2, 4);
    const F2c = sres?.data?.childJobCardId;
    const childFlag = F2c ? (await cardRow(F2c)).last_stage_taken_at : 'no split card';
    s0 = await snap([NUT]);
    if (F2c) await take(F2c);
    const childTook = s0[NUT] - (await stock(NUT));
    await take(F2);
    ok('E2. split before the last stage: each card takes its own share at its own last stage (4 pcs → 16, 6 pcs → 24)',
      sres?.ok && !childFlag && near(childTook, 16) && near(await stock(NUT), s0[NUT] - 40), `${JSON.stringify(sres)} child took ${childTook}`);

    // ════ F. Product QC → Inventory QC done for a Finished Goods route ════
    const oH = await mkOrder('ZZT-IQC-H', 'inventory_order');
    const oiH = await mkLine(oH, 5, 'ZZTEST-DWG-H');
    await putLine(oiH, NUT, 20);
    const H1 = await mkCard(oH, oiH, 'ZZT-IQC-H1', 5, { dwg: 'ZZTEST-DWG-H' });
    await tick(H1, [29]);
    await take(H1);
    await client.query(`UPDATE job_cards SET status='qc_pending' WHERE id=$1`, [H1]);
    await report(H1);
    const fgRows = () => qa(`SELECT id, qty_available::float q, location FROM finished_goods WHERE base_drawing_no='ZZTEST-DWG-H'`);
    s0 = await snap([NUT]);
    r = await call('PUT', `/api/qc/${H1}/approve`, { io_qty: 5, fg_location: 'ZZ-TEST-RACK' });
    c = await cardRow(H1);
    ok('F1. inventory order at Product QC: 5 recorded for Finished Goods at ZZ-TEST-RACK — nothing goes into Finished Goods yet, no stock moves',
      r.status === 200 && c.status === 'inventory_qc' && c.qc_route === 'finished_goods' && Number(c.qc_fg_qty) === 5 && c.qc_fg_location === 'ZZ-TEST-RACK'
      && !(await fgRows()).length && !(await moved(s0)), JSON.stringify(r.body));
    r = await call('PUT', `/api/qc/${H1}/inventory-done`);
    c = await cardRow(H1);
    const fg = await fgRows();
    const fgLog = await q1(`SELECT qty::float q, location, movement_type FROM finished_goods_log WHERE job_card_no='ZZT-IQC-H1'`);
    ok('F2. Inventory QC done: the 5 go into Finished Goods at the recorded location, card QC-approved',
      r.status === 200 && r.body.route === 'finished_goods' && fg.length === 1 && near(fg[0].q, 5) && fg[0].location === 'ZZ-TEST-RACK'
      && r.body.finished_good_id === fg[0].id && fgLog?.movement_type === 'inward' && near(fgLog.q, 5) && c.status === 'qc_approved' && !!c.inventory_qc_at,
      JSON.stringify({ body: r.body, fg, fgLog }));
    ok('F2. same approval line as before, the order shows in Finished Goods, the item settled with no stock moved',
      logs.some(l => l.jc === H1 && l.desc === 'Job card ZZT-IQC-H1 QC Approved — 5 units added to Finished Goods')
      && (await q1('SELECT status FROM orders WHERE id=$1', [oH])).status === 'in_finished_goods' && (await settledFlag(oiH)) === true && !(await moved(s0)), await moved(s0));

    // ════ G. Cards already at QC when this goes live ════
    const oI = await mkOrder('ZZT-IQC-I');
    const oiI = await mkLine(oI, 10, 'ZZTEST-DWG-I');
    await putLine(oiI, NUT, 40);
    const I1 = await mkCard(oI, oiI, 'ZZT-IQC-I1', 10, { status: 'qc_pending', dwg: 'ZZTEST-DWG-I' });
    await tick(I1, [29]); await report(I1);
    s0 = await snap([NUT]);
    r = await call('PUT', `/api/qc/${I1}/approve`, {});
    c = await cardRow(I1);
    ok('G1. a card already past stage 29 with nothing taken: Product QC makes the catch-up take (40 nuts) so QC sees it at Inventory QC',
      r.status === 200 && c.status === 'inventory_qc' && !!c.last_stage_taken_at && near(await stock(NUT), s0[NUT] - 40) && (await lastStageRows(I1, NUT)).length === 1,
      `${r.status} ${JSON.stringify(r.body)} ${await moved(s0)}`);
    const oiI3 = await mkLine(oI, 20, 'ZZTEST-DWG-I3');
    await putLine(oiI3, NUT, 80, 40);
    const I3 = await mkCard(oI, oiI3, 'ZZT-IQC-I3', 10, { status: 'qc_pending', dwg: 'ZZTEST-DWG-I3' });
    await hist(NUT, 'dispatch_to_production', 40, 'Order: ZZT-IQC-I | Dwg: ZZTEST-DWG-I3 | Partial dispatch QC-approved (JC ZZT-IQC-I3)', oiI3);
    await tick(I3, [29]); await report(I3);
    s0 = await snap([NUT]);
    r = await call('PUT', `/api/qc/${I3}/approve`, {});
    c = await cardRow(I3);
    ok('G2. a card QC-approved the old way and sent back to QC: Product QC takes nothing again — it took its list then',
      r.status === 200 && c.status === 'inventory_qc' && !!c.last_stage_taken_at && !(await moved(s0)), await moved(s0));

    const oM = await mkOrder('ZZT-IQC-M');
    const oiM = await mkLine(oM, 10, 'ZZTEST-DWG-M');
    await putLine(oiM, NUT, 40);
    const M1 = await mkCard(oM, oiM, 'ZZT-IQC-M1', 10, { status: 'inventory_qc', dwg: 'ZZTEST-DWG-M' });
    s0 = await snap([NUT]);
    r = await call('POST', `/api/qc/${M1}/inventory/adjust`, { changes: [{ inventory_item_id: NUT, kind: 'take', qty: 1 }] });
    ok('G3. at Inventory QC with no last-stage take yet: it is made now and QC is asked to look again (409); the change itself is not applied',
      r.status === 409 && r.body.code === 'LAST_STAGE_JUST_TAKEN' && near(await stock(NUT), s0[NUT] - 40) && !!(await cardRow(M1)).last_stage_taken_at, JSON.stringify(r.body));
    r = await call('POST', `/api/qc/${M1}/inventory/adjust`, { changes: [{ inventory_item_id: NUT, kind: 'take', qty: 1 }] });
    ok('G3. sent again, the change is saved (the line still counts the last stage\'s 40)', r.status === 200 && near(await stock(NUT), s0[NUT] - 41) && near((await line(oiM, NUT)).d, 40), JSON.stringify(r.body));

    const oL = await mkOrder('ZZT-IQC-L');
    const oiL = await mkLine(oL, 10, 'ZZTEST-DWG-L');
    await putLine(oiL, NUT, 40, 40);
    const L1 = await mkCard(oL, oiL, 'ZZT-IQC-L1', 10, { status: 'inventory_qc', dwg: 'ZZTEST-DWG-L' });
    await client.query('UPDATE job_cards SET last_stage_taken_at=NOW(), dispatched_at=NOW() WHERE id=$1', [L1]);
    s0 = await snap([TUBC, NUT]);
    r = await call('POST', `/api/qc/${L1}/inventory/adjust`, { changes: [{ inventory_item_id: TUBC, kind: 'take', qty: 1 }] });
    const rPlain = await call('POST', `/api/qc/${L1}/inventory/adjust`, { changes: [{ inventory_item_id: NUT, kind: 'take', qty: 1 }] });
    v = (await call('GET', `/api/qc/${L1}/inventory`)).body;
    ok('G4. a card dispatched before Inventory QC went live: its tube stays as it is (refused); other items can still be corrected',
      r.status === 400 && /TUB-ZZTEST-IQC/.test(r.body.error || '') && rPlain.status === 200 && near(await stock(TUBC), s0[TUBC]) && near(await stock(NUT), s0[NUT] - 1)
      && v.counted_locked === true, `${r.status} ${r.body.error} | ${rPlain.status} ${JSON.stringify(rPlain.body)}`);

    // ════ H. After the last stage, before Inventory QC: corrections, rejection, re-tick ════
    const oK = await mkOrder('ZZT-IQC-K');
    const oiK = await mkLine(oK, 10, 'ZZTEST-DWG-K');
    await putLine(oiK, NUT, 40); await putLine(oiK, WIRE, 2);
    const K1 = await mkCard(oK, oiK, 'ZZT-IQC-K1', 10, { dwg: 'ZZTEST-DWG-K' });
    s0 = await snap([NUT, WIRE]);
    r = await call('PUT', `/api/job-cards/${K1}/checklist/4`, { done: true });
    ok('H1. a production card\'s stage 4 is not its last stage: nothing taken',
      r.status === 200 && !(await moved(s0)) && !(await cardRow(K1)).last_stage_taken_at, `${r.status} ${JSON.stringify(r.body)}`);
    await tick(K1, MANDATORY.filter(st => st !== 4));
    r = await call('PUT', `/api/job-cards/${K1}/checklist/29`, { done: true });
    ok('H1. stage 29: 40 nuts and 2 kg wire taken', r.status === 200 && near(await stock(NUT), s0[NUT] - 40) && near(await stock(WIRE), s0[WIRE] - 2), await moved(s0));
    s0 = await snap([NUT, WIRE]);
    b = await applyBomCorrection(txDb, { orderItemId: oiK, userId: uid, userRole: 'owner', sels: [{ id: NUT, qty: 40 }, { id: WIRE, qty: 2 }] });
    ok('H2. a card waiting for Product QC after its last stage: saving the same list gives nothing back',
      b.mode === 'difference' && !b.moves.length && !(await moved(s0)), `${b.mode} | ${b.summary}`);
    b = await applyBomCorrection(txDb, { orderItemId: oiK, userId: uid, userRole: 'owner', sels: [{ id: NUT, qty: 36 }, { id: WIRE, qty: 2 }] });
    ok('H2. nuts lowered 4 → 3.6 a piece: only the 4 difference goes back, not the 40 the last stage took',
      near(await stock(NUT), s0[NUT] + 4) && near(await stock(WIRE), s0[WIRE]), b.summary);
    await report(K1);
    s0 = await snap([NUT, WIRE]);
    r = await call('PUT', `/api/qc/${K1}/reject`, { notes: 'test', send_to: 'production', return_to_stage: 29 });
    c = await cardRow(K1);
    ok('H3. Product QC rejects it back to stage 29: nothing taken or given back', r.status === 200 && c.status === 'in_progress' && !(await moved(s0)), `${r.status} ${JSON.stringify(r.body)}`);
    r = await call('PUT', `/api/job-cards/${K1}/checklist/29`, { done: true });
    ok('H3. remade and stage 29 ticked again: nothing more taken — a real difference is QC\'s to correct at Inventory QC',
      r.status === 200 && (await cardRow(K1)).status === 'qc_pending' && !(await moved(s0)), await moved(s0));

    // ════ I. Legacy cards (no last-stage take) keep today's settle ════
    const oG = await mkOrder('ZZT-IQC-G');
    const oiG = await mkLine(oG, 10, 'ZZTEST-DWG-G');
    await putLine(oiG, NUT, 40);
    await mkCard(oG, oiG, 'ZZT-IQC-G1', 10, { status: 'qc_approved', dwg: 'ZZTEST-DWG-G' });
    s0 = await snap([NUT]);
    await ded.settleItemInventory(txDb, oiG, uid, 'ZZT-IQC-G');
    L = await line(oiG, NUT);
    ok('I1. a card from before (no last-stage take) approved: the settle takes the rest as it always did — 40 nuts',
      near(await stock(NUT), s0[NUT] - 40) && near(L.d, 40) && near(L.w, 0) && (await settledFlag(oiG)) === true, JSON.stringify(L));
    const oiX = await mkLine(oG, 20, 'ZZTEST-DWG-X');
    await putLine(oiX, NUT, 80);
    const X1 = await mkCard(oG, oiX, 'ZZT-IQC-X1', 10, { dwg: 'ZZTEST-DWG-X' });
    const X2 = await mkCard(oG, oiX, 'ZZT-IQC-X2', 10, { dwg: 'ZZTEST-DWG-X' });
    await take(X1);
    await client.query(`UPDATE job_cards SET status='dispatched', dispatched_at=NOW() WHERE id = ANY($1)`, [[X1, X2]]);
    s0 = await snap([NUT]);
    await ded.settleItemInventory(txDb, oiX, uid, 'ZZT-IQC-G', { atDispatch: true });
    ok('I2. an item with one new card and one card from before keeps the old settle: the old card\'s 40 nuts are taken at dispatch',
      near(await stock(NUT), s0[NUT] - 40) && near((await line(oiX, NUT)).d, 80) && (await settledFlag(oiX)) === true, await moved(s0));
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
