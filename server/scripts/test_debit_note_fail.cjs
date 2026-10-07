// Test for a debit-note return that fails QC (owner, 7 Oct 2026): QC chooses
// REPAIR — from the stage QC picks, the whole flow again (production, Product
// QC, Inventory QC), then back into Finished Goods, not to dispatch — or SCRAP —
// the counted parts that can be reused go into their rework bins and the card
// reads Scrapped. Either way Accounts then completes the debit note.
//
// Runs inside one transaction that is ROLLED BACK, on its own made-up items,
// orders, lines, cards and queries (ZZT-DN…), so no real card, query, CAPA,
// stock row or rework bin is touched. Routes run through express as the owner;
// the QC photo upload and Supabase Storage are stubbed, the WhatsApp copy of
// each alert is recorded, not queued.
//
// Needs a database the new server has started on once (the 'scrapped' job
// card status must be allowed) — it refuses otherwise.
//   node scripts/test_debit_note_fail.cjs
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
  const logs = [];
  dbmod.getDB = () => txDb;
  dbmod.logActivity = async (orderId, jc, type, desc, by) => { logs.push({ orderId, jc, type, desc, by }); };
  const supa = require(S + '/node_modules/@supabase/supabase-js');
  supa.createClient = () => ({
    storage: {
      from: (bucket) => ({
        upload: async (p) => ({ data: { path: p }, error: null }),
        remove: async (paths) => ({ data: (paths || []).map(p => ({ name: p })), error: null }),
        copy: async (from, to) => ({ data: { path: to }, error: null }),
        download: async () => ({ data: null, error: { message: 'test stub — nothing is stored' } }),
        getPublicUrl: (p) => ({ data: { publicUrl: `stub://${bucket}/${p}` } }),
      }),
    },
  });
  const wa = require(S + '/src/lib/whatsapp.js');
  wa.queueWhatsApp = async () => {};
  const q1 = async (q, p = []) => (await client.query(q, p)).rows[0];
  const qa = async (q, p = []) => (await client.query(q, p)).rows;
  let failed = false;
  const ok = (label, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  ' + String(extra).slice(0, 400) : '')); if (!cond) failed = true; };
  process.on('unhandledRejection', (e) => { failed = true; console.error('ROUTE ERROR (unhandled):', e); });
  const owner = await q1("SELECT id, name, role FROM users WHERE role='owner' ORDER BY id LIMIT 1");
  const auth = require(S + '/src/middleware/auth.js');
  auth.authenticate = (req, res, next) => { req.user = owner; next(); };
  const upload = require(S + '/src/middleware/upload.js');
  upload.uploadChecklistPhoto = [(req, res, next) => { req.file = { storagePath: 'test/qc.jpg', filename: 'qc.jpg', originalname: 'qc.jpg' }; next(); }];
  const express = require(S + '/node_modules/express');
  const app = express();
  app.use(express.json());
  app.use('/api/customer-queries', require(S + '/src/routes/customerQueries.js'));
  app.use('/api/job-cards', require(S + '/src/routes/jobCards.js'));
  app.use('/api/qc', require(S + '/src/routes/qc.js'));
  app.use('/api/dispatch', require(S + '/src/routes/dispatch.js'));
  const server = app.listen(0);
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const con = await q1(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='job_cards_status_check'`);
    if (!/'scrapped'/.test(con?.d || '') || !owner) {
      ok("Database ready: the 'scrapped' job card status is allowed and an owner user exists", false, `allowed ${/'scrapped'/.test(con?.d || '')}, owner ${!!owner}`);
      return;
    }
    const uid = owner.id;
    const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
    const cardRow = (id) => q1('SELECT * FROM job_cards WHERE id=$1', [id]);
    const cardByNo = (no) => q1('SELECT * FROM job_cards WHERE job_card_no=$1', [no]);
    const queryRow = (id) => q1('SELECT * FROM customer_queries WHERE id=$1', [id]);
    const doneStages = async (card) => (await qa('SELECT stage_no FROM production_checklist WHERE job_card_id=$1 AND done=1 ORDER BY stage_no', [card])).map(r => Number(r.stage_no));
    const stock = async (id) => Number((await q1('SELECT current_stock FROM inventory_items WHERE id=$1', [id])).current_stock);
    const bin = async (id) => Number((await q1('SELECT COALESCE(SUM(qty),0) n FROM inventory_rework_bins WHERE item_id=$1', [id])).n);
    const fgLogOf = (no) => qa('SELECT movement_type AS m, qty::float AS q FROM finished_goods_log WHERE job_card_no=$1 ORDER BY id', [no]);
    const ALL = Array.from({ length: 29 }, (_, i) => i + 1);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const call = async (method, url, body) => {
      const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const CQ = '/api/customer-queries';
    const T_OUT = '2026-10-01T10:00:00.000Z';
    const today = new Date().toISOString().slice(0, 10);
    const mkItem = async (code, cat, s, unit = 'pcs') => (await q1(
      `INSERT INTO inventory_items (item_code, name, unit, category, current_stock, unit_cost) VALUES ($1,$1,$2,$3,$4,1) RETURNING id`, [code, unit, cat, s])).id;
    const mkOrder = async (code) => (await q1(
      `INSERT INTO orders (order_code, customer_id, order_date, order_type, status, material_deduction)
       VALUES ($1, (SELECT MIN(id) FROM customers), CURRENT_DATE, 'local_he', 'dispatched', FALSE) RETURNING id`, [code])).id;
    const mkLine = async (order, qty, dwg) => (await q1(
      `INSERT INTO order_items (order_id, quantity, drawing_number, inventory_deducted) VALUES ($1,$2,$3,TRUE) RETURNING id`, [order, qty, dwg])).id;
    const putLine = (oi, inv, qty) => client.query(
      `INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty, qty_deducted) VALUES ($1,$2,$3,$4)`, [oi, inv, qty, qty]);
    // A card whose pieces went out, through both QCs, every stage done.
    const dispatchedCard = async (order, oi, no, qty, dwg) => {
      const id = (await q1(
        `INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, drawing_no, product_name, is_fg, current_stage,
                                dispatched_at, qc_route, qc_dispatch_qty, qc_fg_qty, tube_deducted, coil_deducted, fill_deducted, fins_deducted,
                                last_stage_taken_at, product_qc_at, inventory_qc_at)
         VALUES ($1,$2,$3,$4,'dispatched',$5,$6,$7,FALSE,29,$8,'dispatch',$4,0,TRUE,TRUE,TRUE,TRUE,$8,$8,$8) RETURNING id`,
        [no, order, oi, qty, today, dwg, `ZZTEST ${no}`, T_OUT])).id;
      for (const st of ALL) await client.query(
        `INSERT INTO production_checklist (job_card_id, stage_no, done, done_at, value1) VALUES ($1,$2,1,NOW(),$3)`, [id, st, `v${st}`]);
      return id;
    };
    // Raise → product return → debit note → material received: the card waits for QC.
    const toQcCheck = async (body, label) => {
      let r = await call('POST', CQ, body);
      const id = r.body.id;
      const r1 = await call('PUT', `${CQ}/${id}/resolve`, { resolution_summary: `ZZTEST ${label} returned against a debit note`, resolution_type: 'product_return' });
      const r2 = await call('PUT', `${CQ}/${id}/return-type`, { return_type: 'debit_note' });
      const r3 = await call('PUT', `${CQ}/${id}/material-received`, {});
      return { id, ok: r.status === 201 && r1.status === 200 && r2.status === 200 && r3.status === 200, res: [r.status, r1.status, r2.status, r3.status, r.body.error, r3.body.error] };
    };

    const PIN = await mkItem('ZZTEST-DN-PIN', 'Terminal Pin', 100);
    const NUT = await mkItem('ZZTEST-DN-NUT', 'Nut', 500);
    const WIRE = await mkItem('ZZTEST-DN-WIRE', 'Wire', 50, 'kg');

    // ════ A. 4 of 10 come back against a debit note, fail QC, are repaired → Finished Goods ════
    const oA = await mkOrder('ZZT-DNA');
    const oiA = await mkLine(oA, 10, 'ZZTEST-DWG-DNA');
    await putLine(oiA, PIN, 20); await putLine(oiA, NUT, 40); await putLine(oiA, WIRE, 2);
    const A = await dispatchedCard(oA, oiA, 'ZZT-DNA1', 10, 'ZZTEST-DWG-DNA');
    const QA = await toQcCheck({ order_id: oA, job_card_id: A, subject: 'ZZTEST 4 heaters returned', assigned_department: 'production', qty: 4 }, 'A');
    const A1 = await cardByNo('ZZT-DNA1-Q1');
    ok('A0. 4 of 10 raised, returned against a debit note and received: the -Q1 card of 4 waits for QC (qc_check)',
      QA.ok && !!A1 && Number(A1.qty) === 4 && A1.status === 'qc_pending' && (await queryRow(QA.id)).return_status === 'qc_check', JSON.stringify(QA.res));

    let r = await call('PUT', `${CQ}/${QA.id}/qc-result`, { result: 'fail' });
    ok('A1. a fail without Repair or Scrap is refused, nothing changes',
      r.status === 400 && /repaired or scrapped/.test(r.body.error || '') && (await queryRow(QA.id)).return_status === 'qc_check' && (await cardRow(A1.id)).status === 'qc_pending', JSON.stringify(r.body));
    r = await call('PUT', `${CQ}/${QA.id}/qc-result`, { result: 'fail', action: 'repair', repair_from_stage: 20 });
    ok('A2. Repair waits for the CAPA on the card, like any repair', r.status === 400 && r.body.code === 'CAPA_REQUIRED' && (await queryRow(QA.id)).return_status === 'qc_check', JSON.stringify(r.body));
    await client.query(`UPDATE capa_reports SET status='approved', approved_by=$2, approved_at=NOW() WHERE job_card_id=$1 AND status IN ('open','awaiting_approval')`, [A1.id, uid]);
    r = await call('PUT', `${CQ}/${QA.id}/qc-result`, { result: 'fail', action: 'repair', repair_from_stage: 20 });
    let c = await cardRow(A1.id);
    ok('A3. Repair from stage 20: stages 1–19 stay done, 20–29 reopen, the card is Repair In Progress, the query In Repair',
      r.status === 200 && c.status === 'repair_in_progress' && Number(c.current_stage) === 19 && same(await doneStages(A1.id), ALL.slice(0, 19))
      && (await queryRow(QA.id)).return_status === 'in_repair', `${r.status} ${JSON.stringify(r.body)} ${c.status} ${await doneStages(A1.id)}`);
    ok('A3. timeline: sent for repair from stage 20, back into Finished Goods after Product QC and Inventory QC',
      logs.some(l => l.jc === A1.id && /QC failed .* sent to production for repair from stage 20; after Product QC and Inventory QC it goes back into Finished Goods/.test(l.desc)));
    r = await call('PUT', `${CQ}/${QA.id}/qc-result`, { result: 'fail', action: 'repair', repair_from_stage: 20 });
    ok('A3. a second press is refused (no longer waiting for QC)', r.status === 400, JSON.stringify(r.body));

    // Production redoes 20–28, then 29 through the checklist route.
    for (const st of ALL.slice(19, 28)) await client.query(`UPDATE production_checklist SET done=1, done_at=NOW() WHERE job_card_id=$1 AND stage_no=$2`, [A1.id, st]);
    const sPin = await stock(PIN), sNut = await stock(NUT);
    r = await call('PUT', `/api/job-cards/${A1.id}/checklist/29`, { done: true });
    c = await cardRow(A1.id);
    ok('A4. stage 29 again: the card waits for Product QC; no stock taken (its list was settled when it first went out)',
      r.status === 200 && c.status === 'qc_pending' && near(await stock(PIN), sPin) && near(await stock(NUT), sNut), `${r.status} ${JSON.stringify(r.body)} ${c.status}`);
    const list = await call('GET', '/api/qc');
    const row = list.body.find?.(y => y.id === A1.id);
    ok('A5. on the Product QC list it is marked as a debit-note return in repair (the screen hides the destination)',
      !!row && row.return_query_type === 'debit_note' && row.return_query_return_status === 'in_repair', JSON.stringify(row && { t: row.return_query_type, s: row.return_query_return_status }));
    await client.query(`INSERT INTO qc_reports (job_card_id, result, product_weight, created_by) VALUES ($1,'approved',1,$2)`, [A1.id, uid]);
    r = await call('PUT', `/api/qc/${A1.id}/approve`, { heater_destination: 'dispatch' });
    c = await cardRow(A1.id);
    ok('A6. Product QC: routed to Finished Goods whatever is sent — 4 to Finished Goods, 0 to dispatch — waiting for Inventory QC',
      r.status === 200 && r.body.route === 'finished_goods' && r.body.fg_qty === 4 && r.body.dispatch_qty === 0 && c.status === 'inventory_qc' && c.qc_route === 'finished_goods',
      `${r.status} ${JSON.stringify(r.body)}`);
    r = await call('PUT', `/api/qc/${A1.id}/inventory-done`);
    c = await cardRow(A1.id);
    const fl = await fgLogOf('ZZT-DNA1-Q1');
    ok('A7. Inventory QC done: 4 go back into Finished Goods, the card is Completed, the query back at "QC Passed" for the debit note',
      r.status === 200 && r.body.status === 'completed' && r.body.finished_good_id && c.status === 'completed'
      && fl.length === 1 && fl[0].m === 'inward' && near(fl[0].q, 4) && (await queryRow(QA.id)).return_status === 'qc_pass',
      `${r.status} ${JSON.stringify(r.body)} ${c.status} ${JSON.stringify(fl)}`);
    ok('A7. timeline: repaired after the debit-note return — 4 units back into Finished Goods',
      logs.some(l => l.jc === A1.id && /repaired after debit-note return .* 4 units back into Finished Goods/.test(l.desc)));
    r = await call('PUT', `${CQ}/${QA.id}/debit-note`, { debit_note_no: 'ZZTEST-DN-1' });
    const r2 = await call('PUT', `${CQ}/${QA.id}/debit-note-complete`, {});
    ok('A8. debit note added and completed: the query is resolved', r.status === 200 && r2.status === 200 && (await queryRow(QA.id)).status === 'resolved', `${r.status} ${r2.status}`);

    // ════ B. 6 of 6 come back, fail QC and are scrapped: reusable parts into the rework bin ════
    const oB = await mkOrder('ZZT-DNB');
    const oiB = await mkLine(oB, 6, 'ZZTEST-DWG-DNB');
    await putLine(oiB, PIN, 12); await putLine(oiB, NUT, 24); await putLine(oiB, WIRE, 1.2);
    const B = await dispatchedCard(oB, oiB, 'ZZT-DNB1', 6, 'ZZTEST-DWG-DNB');
    const QB = await toQcCheck({ order_id: oB, job_card_id: B, subject: 'ZZTEST all 6 returned', assigned_department: 'production' }, 'B');
    ok('B0. all 6 raised (no split), returned against a debit note and received: the card waits for QC', QB.ok && (await cardRow(B)).status === 'qc_pending', JSON.stringify(QB.res));
    r = await call('GET', `${CQ}/${QB.id}/scrap-parts`);
    const pp = (id) => (r.body.parts || []).find(p => p.inventory_item_id === id);
    ok('B1. the parts that can come off: the counted ones on the list, up to what 6 pcs carried — 12 pins, 24 nuts; the kg wire is not offered',
      r.status === 200 && r.body.pieces === 6 && pp(PIN)?.max === 12 && pp(NUT)?.max === 24 && !pp(WIRE), JSON.stringify(r.body));
    const bPin = await bin(PIN), bNut = await bin(NUT), sPin2 = await stock(PIN), sNut2 = await stock(NUT);
    r = await call('PUT', `${CQ}/${QB.id}/qc-result`, { result: 'fail', action: 'scrap', parts: [{ inventory_item_id: WIRE, qty: 1 }] });
    ok('B2. a kg item cannot go into the rework bin', r.status === 400 && /counted parts/.test(r.body.error || ''), JSON.stringify(r.body));
    r = await call('PUT', `${CQ}/${QB.id}/qc-result`, { result: 'fail', action: 'scrap', parts: [{ inventory_item_id: PIN, qty: 13 }] });
    ok('B2. more pins than the heaters carried is refused', r.status === 400 && /at most 12/.test(r.body.error || ''), JSON.stringify(r.body));
    r = await call('PUT', `${CQ}/${QB.id}/qc-result`, { result: 'fail', action: 'scrap', parts: [{ inventory_item_id: PIN, qty: 1.5 }] });
    ok('B2. a part-piece is refused', r.status === 400 && /whole number/.test(r.body.error || ''), JSON.stringify(r.body));
    ok('B2. none of the refusals changed anything', (await bin(PIN)) === bPin && (await queryRow(QB.id)).return_status === 'qc_check' && (await cardRow(B)).status === 'qc_pending');
    r = await call('PUT', `${CQ}/${QB.id}/qc-result`, { result: 'fail', action: 'scrap', parts: [{ inventory_item_id: PIN, qty: 12 }, { inventory_item_id: NUT, qty: 10 }, { inventory_item_id: WIRE, qty: '' }] });
    c = await cardRow(B);
    ok('B3. Scrap with 12 pins and 10 nuts taken off: both into their rework bins, normal stock untouched, card Scrapped, query Scrapped (no CAPA needed)',
      r.status === 200 && (await bin(PIN)) === bPin + 12 && (await bin(NUT)) === bNut + 10 && near(await stock(PIN), sPin2) && near(await stock(NUT), sNut2)
      && c.status === 'scrapped' && (await queryRow(QB.id)).return_status === 'scrapped', `${r.status} ${JSON.stringify(r.body)} ${c.status}`);
    ok('B3. the bin history names the card and the query',
      (await qa(`SELECT 1 FROM inventory_rework_moves WHERE job_card_id=$1 AND kind='deposit' AND item_id = ANY($2) AND notes LIKE '%scrapped heater ZZT-DNB1%'`, [B, [PIN, NUT]])).length === 2);
    ok('B3. timeline on the card: scrapped, with what went into the rework bin',
      (await qa(`SELECT 1 FROM activity_log WHERE job_card_id=$1 AND activity_type='return_scrapped' AND description LIKE '%ZZT-DNB1 scrapped%ZZTEST-DN-PIN × 12%ZZTEST-DN-NUT × 10%'`, [B])).length === 1);
    r = await call('PUT', `${CQ}/${QB.id}/qc-result`, { result: 'fail', action: 'scrap', parts: [] });
    ok('B4. a second press is refused, nothing put in twice', r.status === 400 && (await bin(PIN)) === bPin + 12, JSON.stringify(r.body));
    r = await call('PUT', `/api/dispatch/${B}/mark-dispatched`, {});
    ok('B5. a scrapped card cannot be dispatched', r.status === 400 && /scrapped/.test(r.body.error || ''), JSON.stringify(r.body));
    r = await call('PUT', `/api/job-cards/${A1.id}/status`, { status: 'scrapped' });
    ok('B6. "scrapped" cannot be set by hand', r.status === 400, JSON.stringify(r.body));
    await call('PUT', `${CQ}/${QB.id}/debit-note`, { debit_note_no: 'ZZTEST-DN-2' });
    r = await call('PUT', `${CQ}/${QB.id}/debit-note-complete`, {});
    ok('B7. debit note completed: the query is resolved and the card STAYS Scrapped', r.status === 200 && (await queryRow(QB.id)).status === 'resolved' && (await cardRow(B)).status === 'scrapped',
      `${r.status} ${(await cardRow(B)).status}`);

    // ════ C. Scrap with nothing reusable ════
    const oC = await mkOrder('ZZT-DNC');
    const oiC = await mkLine(oC, 2, 'ZZTEST-DWG-DNC');
    await putLine(oiC, PIN, 4);
    const C = await dispatchedCard(oC, oiC, 'ZZT-DNC1', 2, 'ZZTEST-DWG-DNC');
    const QC = await toQcCheck({ order_id: oC, job_card_id: C, subject: 'ZZTEST burnt', assigned_department: 'production' }, 'C');
    const bPin3 = await bin(PIN);
    r = await call('PUT', `${CQ}/${QC.id}/qc-result`, { result: 'fail', action: 'scrap', parts: [] });
    ok('C1. scrapped with nothing taken off: card Scrapped, bins unchanged', QC.ok && r.status === 200 && (await cardRow(C)).status === 'scrapped' && (await bin(PIN)) === bPin3, JSON.stringify(r.body));
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
