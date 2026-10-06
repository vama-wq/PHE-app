// Test for a card with nothing left to send (owner, 7 Oct 2026): "the one that
// has zero dispatchable will just say rejected after the inventory is approved"
// — Product QC approves it without a destination, Inventory QC settles what it
// used as for any card, and Inventory QC done closes it as 'rejected'. Nothing
// is re-made on its own ("just close it, I will decide"). A rejected card never
// dispatches, never holds its order open, counts as settled for its item, and
// is locked like every card through Inventory QC.
//
// Runs inside one transaction that is ROLLED BACK, on its own made-up items
// (ZZTEST-REJ-…), orders, lines, cards and lists — no real row is touched.
// Routes run through express as the owner; the QC photo upload is stubbed.
//
// Needs a database the new server has started on once (the 'rejected' status
// must be allowed by job_cards_status_check) — it refuses otherwise.
//   node scripts/test_rejected_card.cjs
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
  process.on('unhandledRejection', (e) => { failed = true; console.error('ROUTE ERROR (unhandled):', e); });

  const owner = await q1("SELECT id, name, role FROM users WHERE role='owner' ORDER BY id LIMIT 1");
  const auth = require(S + '/src/middleware/auth.js');
  auth.authenticate = (req, res, next) => { req.user = owner; next(); };
  const upload = require(S + '/src/middleware/upload.js');
  upload.deleteFromStorage = async () => {};
  upload.copyInStorage = async () => {};
  upload.uploadChecklistPhoto = [(req, res, next) => { req.file = { storagePath: 'test/qc.jpg', filename: 'qc.jpg', originalname: 'qc.jpg' }; next(); }];

  const { isHeldCard } = require(S + '/src/lib/countedStock.js');
  const { PASSED_QC } = require(S + '/src/lib/stockLedger.js');
  const express = require(S + '/node_modules/express');
  const app = express();
  app.use(express.json());
  app.use('/api/job-cards', require(S + '/src/routes/jobCards.js'));
  app.use('/api/qc', require(S + '/src/routes/qc.js'));
  app.use('/api/dispatch', require(S + '/src/routes/dispatch.js'));
  const server = app.listen(0);
  const base = 'http://127.0.0.1:' + server.address().port;
  const MANDATORY = JSON.parse(fs.readFileSync(S + '/src/routes/jobCards.js', 'utf8').match(/const MANDATORY_STAGES = (\[[^\]]+\])/)[1]);

  try {
    const con = await q1(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='job_cards_status_check'`);
    if (!/'rejected'/.test(con?.d || '') || !owner) {
      ok("Database ready: the 'rejected' job card status is allowed (start the new server on it once first) and an owner user exists", false,
        `allowed ${/'rejected'/.test(con?.d || '')}, owner ${!!owner}`);
      return;
    }
    const uid = owner.id;

    const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
    const stock = async (id) => Number((await q1('SELECT current_stock FROM inventory_items WHERE id=$1', [id])).current_stock);
    const cardRow = async (id) => q1('SELECT * FROM job_cards WHERE id=$1', [id]);
    const orderStatus = async (id) => (await q1('SELECT status FROM orders WHERE id=$1', [id])).status;
    const snap = async (ids) => { const o = {}; for (const id of ids) o[id] = await stock(id); return o; };
    const moved = async (s) => { const out = []; for (const [id, v] of Object.entries(s)) { const n = await stock(id); if (!near(n, v)) out.push(`item ${id}: ${v} → ${n}`); } return out.join('; '); };
    const call = async (method, url, body) => {
      const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const mkItem = async (code, cat, s, unit) => (await q1(
      `INSERT INTO inventory_items (item_code, name, unit, category, current_stock, unit_cost) VALUES ($1,$1,$2,$3,$4,1) RETURNING id`, [code, unit, cat, s])).id;
    const mkOrder = async (code, type = 'local_he') => (await q1(
      `INSERT INTO orders (order_code, customer_id, order_date, order_type, status)
       VALUES ($1, (SELECT MIN(id) FROM customers), CURRENT_DATE, $2, 'in_progress') RETURNING id`, [code, type])).id;
    const mkLine = async (order, qty, dwg) => (await q1(
      `INSERT INTO order_items (order_id, quantity, drawing_number) VALUES ($1,$2,$3) RETURNING id`, [order, qty, dwg])).id;
    const mkCard = async (order, oi, no, qty, { status = 'in_progress', dwg = null, cols = {} } = {}) => {
      const extra = Object.keys(cols);
      return (await q1(
        `INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, drawing_no${extra.map(k => ', ' + k).join('')})
         VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,$6${extra.map((_, i) => `,$${7 + i}`).join('')}) RETURNING id`,
        [no, order, oi, qty, status, dwg, ...extra.map(k => cols[k])])).id;
    };
    const putLine = (oi, inv, qty, d = 0) => client.query(
      `INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty, qty_deducted) VALUES ($1,$2,$3,$4)`, [oi, inv, qty, d]);
    const tick = async (card, stages, { rejected = {}, remade = {} } = {}) => {
      for (const st of stages) await client.query(
        `INSERT INTO production_checklist (job_card_id, stage_no, done, rejection_qty, remade_qty, done_at) VALUES ($1,$2,1,$3,$4,NOW())
         ON CONFLICT (job_card_id, stage_no) DO UPDATE SET done=1, done_at=NOW()`,
        [card, st, rejected[st] || 0, remade[st] || 0]);
    };
    const report = (card) => client.query(`INSERT INTO qc_reports (job_card_id, result, product_weight, created_by) VALUES ($1,'approved',1,$2)`, [card, uid]);
    const fgRows = (no) => qa(`SELECT id FROM finished_goods_log WHERE job_card_no=$1`, [no]);
    const toQc = async (card) => { const r = await call('PUT', `/api/job-cards/${card}/checklist/29`, { done: true }); await report(card); return r; };

    const NUT = await mkItem('ZZTEST-REJ-NUT', 'Nut', 1000, 'pcs');
    const WIRE = await mkItem('ZZTEST-REJ-WIRE', 'Wire', 100, 'kg');

    // ════ A. A card of 2 with both pieces rejected: Product QC → Inventory QC → Rejected ════
    // Item of 4 pieces: card A1 (2 pcs, both rejected at stage 10) and card A2
    // (2 pcs, already dispatched the new way). List per piece: 4 nuts, 0.25 kg wire.
    const oA = await mkOrder('ZZT-REJ-A');
    const oiA = await mkLine(oA, 4, 'ZZTEST-DWG-REJ-A');
    await putLine(oiA, NUT, 16, 8); await putLine(oiA, WIRE, 1, 0.5);
    const A2 = await mkCard(oA, oiA, 'ZZT-REJ-A2', 2, { status: 'dispatched', dwg: 'ZZTEST-DWG-REJ-A',
      cols: { dispatched_at: new Date(), last_stage_taken_at: new Date(), product_qc_at: new Date(), inventory_qc_at: new Date(), qc_route: 'dispatch', qc_dispatch_qty: 2, qc_fg_qty: 0 } });
    const A1 = await mkCard(oA, oiA, 'ZZT-REJ-A1', 2, { dwg: 'ZZTEST-DWG-REJ-A' });
    await tick(A1, MANDATORY, { rejected: { 10: 2 } });

    let s0 = await snap([NUT, WIRE]);
    let r = await toQc(A1);
    let c = await cardRow(A1);
    ok('A1. stage 29 ticked: the card waits for Product QC and took the rest of its list for its full qty (8 nuts, 0.5 kg wire) — rejected pieces used material too',
      r.status === 200 && c.status === 'qc_pending' && !!c.last_stage_taken_at && near(await stock(NUT), s0[NUT] - 8) && near(await stock(WIRE), s0[WIRE] - 0.5),
      `${r.status} ${c.status} ${await moved(s0)}`);
    const list = await call('GET', '/api/qc');
    const row = list.body.find?.(y => y.id === A1);
    ok('A2. on the Product QC list it shows 0 dispatchable', !!row && Number(row.net_qty) === 0, JSON.stringify(row && { qty: row.qty, net_qty: row.net_qty, total_rejected: row.total_rejected }));

    s0 = await snap([NUT, WIRE]);
    r = await call('PUT', `/api/qc/${A1}/approve`, { heater_destination: 'finished_goods', io_qty: 2 });
    c = await cardRow(A1);
    ok('A3. Product QC approve with nothing left: allowed, no destination recorded — route "rejected", 0 to dispatch, 0 to Finished Goods, card at Inventory QC',
      r.status === 200 && r.body.status === 'inventory_qc' && r.body.route === 'rejected' && r.body.dispatch_qty === 0 && r.body.fg_qty === 0
      && c.status === 'inventory_qc' && c.qc_route === 'rejected' && Number(c.qc_dispatch_qty) === 0 && Number(c.qc_fg_qty) === 0 && !!c.product_qc_at && c.product_qc_by === uid,
      `${r.status} ${JSON.stringify(r.body)} ${c.status}/${c.qc_route}`);
    ok('A3. nothing moved in stock at Product QC (the take happened at the last stage)', !(await moved(s0)), await moved(s0));
    ok('A3. timeline: "Product QC: all 2 pieces rejected — waiting for Inventory QC, then closed as Rejected"',
      logs.some(l => l.jc === A1 && /Product QC: all 2 pieces rejected — waiting for Inventory QC, then closed as Rejected/.test(l.desc)),
      logs.filter(l => l.jc === A1).map(l => l.desc).join(' | '));
    ok('A3. the order still counts this card as open: one card out, one in QC → partly dispatched', (await orderStatus(oA)) === 'partially_dispatched', await orderStatus(oA));
    ok('A3. no Finished Goods row for this card', (await fgRows('ZZT-REJ-A1')).length === 0);

    r = await call('GET', `/api/qc/${A1}/inventory`);
    ok('A4. the Inventory QC screen shows the card, editable, routing "rejected"',
      r.status === 200 && r.body.editable === true && r.body.routing?.route === 'rejected' && Number(r.body.routing.dispatch_qty) === 0,
      JSON.stringify(r.body.routing));
    const queue = await call('GET', '/api/qc/inventory-queue');
    ok('A4. it is on the Inventory QC queue', queue.status === 200 && queue.body.some?.(y => y.id === A1));

    r = await call('PUT', `/api/dispatch/${A1}/mark-dispatched`, {});
    ok('A5. dispatch refused while at Inventory QC', r.status === 400 && /Inventory QC/.test(r.body.error || ''), JSON.stringify(r.body));

    s0 = await snap([NUT, WIRE]);
    r = await call('POST', `/api/qc/${A1}/inventory/adjust`, { changes: [{ inventory_item_id: NUT, kind: 'take', qty: 2 }, { inventory_item_id: WIRE, kind: 'scrap', qty: 0.1 }] });
    ok('A6. Inventory QC corrections work as on any card: 2 more nuts taken, 0.1 kg wire scrapped',
      r.status === 200 && near(await stock(NUT), s0[NUT] - 2) && near(await stock(WIRE), s0[WIRE] - 0.1), `${r.status} ${JSON.stringify(r.body).slice(0, 200)} ${await moved(s0)}`);

    s0 = await snap([NUT, WIRE]);
    r = await call('PUT', `/api/qc/${A1}/inventory-done`);
    c = await cardRow(A1);
    ok('A7. Inventory QC done: the card closes as Rejected — stamped by whom and when, no Finished Goods intake, nothing dispatched',
      r.status === 200 && r.body.status === 'rejected' && r.body.route === 'rejected' && r.body.finished_good_id === null && r.body.fg_qty === 0 && r.body.dispatch_qty === 0
      && c.status === 'rejected' && !!c.inventory_qc_at && c.inventory_qc_by === uid && !c.dispatched_at && (await fgRows('ZZT-REJ-A1')).length === 0,
      `${r.status} ${JSON.stringify(r.body)} ${c.status}`);
    ok('A7. nothing moved in stock at done', !(await moved(s0)), await moved(s0));
    ok('A7. timeline: "closed as Rejected — all 2 pieces rejected at production (QC)"',
      logs.some(l => l.jc === A1 && /closed as Rejected — all 2 pieces rejected at production \(QC\)/.test(l.desc)),
      logs.filter(l => l.jc === A1).map(l => l.desc).join(' | '));
    ok('A8. the order is not stuck on it: with its other card dispatched, the order reads dispatched', (await orderStatus(oA)) === 'dispatched', await orderStatus(oA));
    ok('A9. the item settles: the rejected card counts as settled next to the dispatched one',
      (await q1('SELECT inventory_deducted f FROM order_items WHERE id=$1', [oiA])).f === true);

    // ── Locked afterwards, like every card through Inventory QC ──
    s0 = await snap([NUT, WIRE]);
    r = await call('POST', `/api/qc/${A1}/inventory/adjust`, { changes: [{ inventory_item_id: NUT, kind: 'take', qty: 1 }] });
    ok('A10. no more inventory changes on a closed card', r.status === 400 && !(await moved(s0)), `${r.status} ${JSON.stringify(r.body)}`);
    const rDone2 = await call('PUT', `/api/qc/${A1}/inventory-done`);
    ok('A10. Inventory QC done cannot be pressed twice', rDone2.status === 400 && (await cardRow(A1)).status === 'rejected', JSON.stringify(rDone2.body));
    r = await call('PUT', `/api/job-cards/${A1}/checklist/10`, { done: false });
    c = await cardRow(A1);
    ok('A11. a stage undone on the rejected card moves nothing and the card stays Rejected',
      !(await moved(s0)) && c.status === 'rejected', `${r.status} ${c.status} ${await moved(s0)}`);
    r = await call('PUT', `/api/dispatch/${A1}/mark-dispatched`, {});
    ok('A12. dispatch refused: "closed as Rejected"', r.status === 400 && /Rejected/.test(r.body.error || '') && (await cardRow(A1)).status === 'rejected', JSON.stringify(r.body));
    r = await call('GET', `/api/qc/${A1}/inventory`);
    ok('A13. the Inventory QC screen is read-only afterwards', r.status === 200 && r.body.editable === false, JSON.stringify({ editable: r.body.editable }));
    const q2 = await call('GET', '/api/qc/inventory-queue');
    const l2 = await call('GET', '/api/qc');
    ok('A14. off both QC lists', !q2.body.some?.(y => y.id === A1) && !l2.body.some?.(y => y.id === A1));
    ok('A15. held for tube / NUT-BR-M4-08 and counted as past QC in the stock ledger',
      isHeldCard({ status: 'rejected' }) === true && PASSED_QC.has('rejected'));

    // ════ B. Hand-set status: 'rejected' is QC's to give ════
    const oB = await mkOrder('ZZT-REJ-B');
    const oiB = await mkLine(oB, 2, 'ZZTEST-DWG-REJ-B');
    const B1 = await mkCard(oB, oiB, 'ZZT-REJ-B1', 2, { dwg: 'ZZTEST-DWG-REJ-B' });
    r = await call('PUT', `/api/job-cards/${B1}/status`, { status: 'rejected' });
    ok('B1. "rejected" cannot be set by hand', r.status === 400 && (await cardRow(B1)).status === 'in_progress', JSON.stringify(r.body));

    // ════ C. A card with SOME pieces left is unchanged: it still routes ════
    await putLine(oiB, NUT, 8);
    await tick(B1, MANDATORY, { rejected: { 10: 1 } });
    await toQc(B1);
    r = await call('PUT', `/api/qc/${B1}/approve`, { heater_destination: 'dispatch' });
    c = await cardRow(B1);
    ok('C1. 1 of 2 rejected: approved to dispatch with 1 piece, as before', r.status === 200 && r.body.route === 'dispatch' && r.body.dispatch_qty === 1 && c.status === 'inventory_qc' && c.qc_route === 'dispatch', JSON.stringify(r.body));
    r = await call('PUT', `/api/qc/${B1}/inventory-done`);
    c = await cardRow(B1);
    ok('C1. Inventory QC done: QC-approved and on to dispatch, not Rejected', r.status === 200 && r.body.status === 'qc_approved' && c.status === 'qc_approved', JSON.stringify(r.body));

    // ════ D. Remade pieces count: 2 rejected, 2 remade → nothing is rejected ════
    const oD = await mkOrder('ZZT-REJ-D');
    const oiD = await mkLine(oD, 2, 'ZZTEST-DWG-REJ-D');
    await putLine(oiD, NUT, 8);
    const D1 = await mkCard(oD, oiD, 'ZZT-REJ-D1', 2, { dwg: 'ZZTEST-DWG-REJ-D' });
    await tick(D1, MANDATORY, { rejected: { 10: 2 }, remade: { 10: 2 } });
    await toQc(D1);
    r = await call('PUT', `/api/qc/${D1}/approve`, { heater_destination: 'dispatch' });
    ok('D1. 2 rejected but 2 remade: 2 to dispatch, the normal route', r.status === 200 && r.body.route === 'dispatch' && r.body.dispatch_qty === 2, JSON.stringify(r.body));

    // ════ E. An order whose ONLY card is rejected keeps its status — the owner decides ════
    const oE = await mkOrder('ZZT-REJ-E');
    const oiE = await mkLine(oE, 2, 'ZZTEST-DWG-REJ-E');
    await putLine(oiE, NUT, 8);
    const E1 = await mkCard(oE, oiE, 'ZZT-REJ-E1', 2, { dwg: 'ZZTEST-DWG-REJ-E' });
    await tick(E1, MANDATORY, { rejected: { 10: 2 } });
    await toQc(E1);
    await call('PUT', `/api/qc/${E1}/approve`, {});
    r = await call('PUT', `/api/qc/${E1}/inventory-done`);
    ok('E1. only card rejected: card Rejected, the order is not called dispatched', r.status === 200 && (await cardRow(E1)).status === 'rejected' && (await orderStatus(oE)) !== 'dispatched',
      `${(await cardRow(E1)).status} order ${await orderStatus(oE)}`);
  } catch (e) {
    failed = true;
    console.error('ERROR', e);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    server.close();
    await realPool.end().catch(() => {});
    console.log(failed ? '\nSOME CHECKS FAILED (rolled back)' : '\nALL PASS (rolled back — nothing kept)');
    process.exit(failed ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(1); });
