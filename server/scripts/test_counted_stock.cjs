// Test for counted stock (owner, 5 Oct 2026; lib/countedStock.js): dispatched
// job cards never change tube or NUT-BR-M4-08 stock again; every other card
// works as before. Runs inside one transaction that is ROLLED BACK, on its own
// made-up items, order and cards (TUB-ZZTEST-… is counted by its prefix,
// ZZTEST-PLAIN is not), so no real stock row is locked while it runs.
//   node scripts/test_counted_stock.cjs
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
  dbmod.logActivity = async (orderId, jc, type, desc) => { logs.push({ jc, type, desc }); };
  const { applyBomCorrection } = require(S + '/src/lib/bomCorrection.js');
  const { applyMaterialDeductions } = require(S + '/src/lib/materialDeduction.js');
  const { isCountedItem, isHeldCard } = require(S + '/src/lib/countedStock.js');

  const q1 = async (q, p = []) => (await client.query(q, p)).rows[0];
  let failed = false;
  const ok = (label, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  ' + String(extra).slice(0, 300) : '')); if (!cond) failed = true; };
  const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
  const stock = async (id) => Number((await q1('SELECT current_stock FROM inventory_items WHERE id=$1', [id])).current_stock);
  const line = async (oi, inv) => q1('SELECT qty::float q, qty_deducted::float d, COALESCE(qty_waived,0)::float w FROM order_item_inventory WHERE order_item_id=$1 AND inventory_item_id=$2', [oi, inv]);

  try {
    ok('counted items: every TUB- code and NUT-BR-M4-08 only',
      isCountedItem('TUB-SS304-038-T06') && isCountedItem(' nut-br-m4-08 ') && !isCountedItem('NUT-BR-M5-11') && !isCountedItem('NUT-SS-M4-08'));
    ok('a held card: through QC (approved) or dispatched (time or status); not one in production or at QC',
      isHeldCard({ dispatched_at: new Date() }) && isHeldCard({ status: 'dispatched' }) && isHeldCard({ status: 'qc_approved' })
      && !isHeldCard({ status: 'in_progress' }) && !isHeldCard({ status: 'qc_pending' }));

    const mkItem = async (code, cat, s = 1000, unit = 'pcs') => (await q1(
      `INSERT INTO inventory_items (item_code, name, unit, category, current_stock, unit_cost) VALUES ($1,$1,$2,$3,$4,1) RETURNING id`, [code, unit, cat, s])).id;
    const order = (await q1(`INSERT INTO orders (order_code, customer_id, order_date, order_type, status) VALUES ('ZZT-CNT-1', (SELECT MIN(id) FROM customers), CURRENT_DATE, 'local_he', 'in_progress') RETURNING id`)).id;
    const mkLine = async (qty, dwg) => (await q1(`INSERT INTO order_items (order_id, quantity, drawing_number) VALUES ($1,$2,$3) RETURNING id`, [order, qty, dwg])).id;
    const mkCard = async (oi, no, qty, status, dispatched) => (await q1(
      `INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, qc_dispatch_qty, dispatch_date, dispatched_at)
       VALUES ($1,$2,$3,$4,$5,$4,CURRENT_DATE,$6) RETURNING id`, [no, order, oi, qty, status, dispatched ? new Date() : null])).id;
    const takeOn = async (inv, oi, qty, notes) => {
      await client.query('UPDATE inventory_items SET current_stock = current_stock - $1 WHERE id=$2', [qty, inv]);
      await client.query(`INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by, order_item_id, source)
        VALUES ($1,'dispatch_to_production',$2,0,$3,1,$4,'bom')`, [inv, qty, notes, oi]);
    };
    const putLine = (oi, inv, qty, ded) => client.query(`INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty, qty_deducted) VALUES ($1,$2,$3,$4)`, [oi, inv, qty, ded]);
    const save = (oi, list) => applyBomCorrection(txDb, { orderItemId: oi, userId: 1, userRole: 'owner', sels: list.map(([id, qty]) => ({ id, qty })) });

    const ded = require(S + '/src/lib/inventoryDeduction.js');
    const held = (r) => /left as it stands — this line has job cards through QC or dispatched/.test(r.summary);

    // ── A line of 100 pcs: C1 (50) dispatched, C2 (50) QC-approved, not dispatched. 4 a piece. ──
    const CNT = await mkItem('TUB-ZZTEST-CNT', 'Nut');
    const PLN = await mkItem('ZZTEST-PLAIN', 'Nut');
    const oi = await mkLine(100, 'ZZT-DWG');
    await mkCard(oi, 'ZZT-C1', 50, 'dispatched', true);
    await mkCard(oi, 'ZZT-C2', 50, 'qc_approved', false);
    for (const inv of [CNT, PLN]) {
      for (const no of ['ZZT-C1', 'ZZT-C2']) await takeOn(inv, oi, 200, `Order: ZZT-CNT-1 | Dwg: ZZT-DWG | Partial dispatch QC-approved (JC ${no})`);
      await putLine(oi, inv, 400, 400);
    }
    let s0 = { c: await stock(CNT), p: await stock(PLN) };
    let r = await save(oi, [[CNT, 300], [PLN, 300]]);
    ok('A. 4 → 3 a piece: plain item gives back 100', near(await stock(PLN), s0.p + 100), `${s0.p} → ${await stock(PLN)}`);
    ok('A. counted item on a line with a dispatched card: nothing moves, and it says so', near(await stock(CNT), s0.c) && held(r), `${s0.c} → ${await stock(CNT)} | ${r.summary}`);
    let L = await line(oi, CNT);
    ok('A. counted line settled at the new list (deducted 300, waived 0)', near(L.d, 300) && near(L.w, 0), JSON.stringify(L));

    s0 = { c: await stock(CNT), p: await stock(PLN) };
    r = await save(oi, [[CNT, 300], [PLN, 300]]);
    ok('B. saving the same list again moves nothing, no note', near(await stock(CNT), s0.c) && near(await stock(PLN), s0.p) && !held(r), r.summary);

    s0 = { c: await stock(CNT), p: await stock(PLN) };
    r = await save(oi, [[CNT, 500], [PLN, 500]]);
    ok('C. 3 → 5 a piece: plain item takes 200, counted item nothing', near(await stock(PLN), s0.p - 200) && near(await stock(CNT), s0.c) && held(r), r.summary);
    L = await line(oi, CNT);
    ok('C. counted line settled at 500 (deducted 400 as really taken, waived 100)', near(L.d, 400) && near(L.w, 100), JSON.stringify(L));

    s0 = { c: await stock(CNT), p: await stock(PLN) };
    r = await save(oi, [[CNT, 500], [PLN, 500]]);
    ok('D. repeat save moves nothing, no note', near(await stock(CNT), s0.c) && near(await stock(PLN), s0.p) && !held(r), r.summary);

    s0 = { c: await stock(CNT), p: await stock(PLN) };
    r = await save(oi, [[PLN, 500]]);
    ok('E. counted item taken off the list: nothing goes back', near(await stock(CNT), s0.c) && near(await stock(PLN), s0.p) && held(r), r.summary);

    // ── F. Every card dispatched: the counted item never moves ──
    const oiF = await mkLine(50, 'ZZT-F');
    await mkCard(oiF, 'ZZT-F1', 50, 'dispatched', true);
    for (const inv of [CNT, PLN]) { await takeOn(inv, oiF, 100, 'Order: ZZT-CNT-1 | Dwg: ZZT-F | Consumed (QC/dispatch)'); await putLine(oiF, inv, 100, 100); }
    await client.query('UPDATE order_items SET inventory_deducted=TRUE WHERE id=$1', [oiF]);
    for (const [label, perPc, wantPlain] of [['F. all dispatched, 2 → 4 a piece', 4, -100], ['F. all dispatched, 4 → 1 a piece', 1, +150]]) {
      s0 = { c: await stock(CNT), p: await stock(PLN) };
      r = await save(oiF, [[CNT, perPc * 50], [PLN, perPc * 50]]);
      ok(`${label}: counted item unchanged, plain item moves ${wantPlain}`, near(await stock(CNT), s0.c) && near(await stock(PLN), s0.p + wantPlain), `cnt ${s0.c}→${await stock(CNT)} plain ${s0.p}→${await stock(PLN)} | ${r.summary}`);
    }

    // ── G. Every card still in production: the counted item moves exactly like any other ──
    // (a Stage-15 part, so production has reached it: Brazing ticked on the card)
    const CNTF = await mkItem('TUB-ZZTEST-FLG', 'Flange');
    const PLNF = await mkItem('ZZTEST-FLG', 'Flange');
    const inProd = async (oiX, no) => {
      const id = await mkCard(oiX, no, 50, 'in_progress', false);
      await client.query('UPDATE job_cards SET qc_dispatch_qty=NULL WHERE id=$1', [id]);
      await client.query(`INSERT INTO production_checklist (job_card_id, stage_no, done, done_at) VALUES ($1,15,1,NOW())`, [id]);
      return id;
    };
    const oiG = await mkLine(50, 'ZZT-G');
    await inProd(oiG, 'ZZT-G1');
    for (const inv of [CNTF, PLNF]) { await takeOn(inv, oiG, 100, 'Order: ZZT-CNT-1 | Dwg: ZZT-G | Stage 15 Brazing (JC ZZT-G1)'); await putLine(oiG, inv, 100, 100); }
    s0 = { c: await stock(CNTF), p: await stock(PLNF) };
    r = await save(oiG, [[CNTF, 150], [PLNF, 150]]);
    ok('G. every card in production: counted and plain both take 50', near(await stock(CNTF), s0.c - 50) && near(await stock(PLNF), s0.p - 50), r.summary);

    // ── T. A card approved at QC, none dispatched yet: the counted item is held ──
    const oiT2 = await mkLine(50, 'ZZT-T');
    await mkCard(oiT2, 'ZZT-TA1', 50, 'qc_approved', false);
    for (const inv of [CNT, PLN]) { await takeOn(inv, oiT2, 100, 'Order: ZZT-CNT-1 | Dwg: ZZT-T | Partial dispatch QC-approved (JC ZZT-TA1)'); await putLine(oiT2, inv, 100, 100); }
    s0 = { c: await stock(CNT), p: await stock(PLN) };
    r = await save(oiT2, [[CNT, 150], [PLN, 150]]);
    ok('T. card through QC, waiting at dispatch: counted item held, plain takes 50', near(await stock(CNT), s0.c) && near(await stock(PLN), s0.p - 50) && held(r), r.summary);

    // ── H. A card still in production takes by the new list at QC ──
    for (const [label, perPc, want] of [['H. list raised 4 → 5', 5, 250], ['H. list lowered 4 → 3', 3, 150]]) {
      const CNTH = await mkItem(`TUB-ZZTEST-H${perPc}`, 'Nut');
      const oiH = await mkLine(100, `ZZT-H${perPc}`);
      await mkCard(oiH, `ZZT-H${perPc}-1`, 50, 'dispatched', true);
      const h2 = await mkCard(oiH, `ZZT-H${perPc}-2`, 50, 'in_progress', false);
      await client.query('UPDATE job_cards SET qc_dispatch_qty=NULL WHERE id=$1', [h2]);
      await takeOn(CNTH, oiH, 200, `Order: ZZT-CNT-1 | Dwg: ZZT-H${perPc} | Partial dispatch QC-approved (JC ZZT-H${perPc}-1)`);
      await putLine(oiH, CNTH, 400, 200);
      s0 = { c: await stock(CNTH) };
      r = await save(oiH, [[CNTH, perPc * 100]]);
      ok(`${label}: nothing moves on the save`, near(await stock(CNTH), s0.c), r.summary);
      await client.query("UPDATE job_cards SET status='qc_approved', qc_dispatch_qty=50 WHERE id=$1", [h2]);
      await ded.deductPartialAtQC(txDb, await q1('SELECT * FROM job_cards WHERE id=$1', [h2]), 1);
      ok(`${label}: the card in production then takes ${want} at QC, by the new list`, near(await stock(CNTH), s0.c - want), `${s0.c} → ${await stock(CNTH)}`);
    }

    // ── S. A card marked dispatched by hand (no dispatch time): the line is held ──
    {
      const CNT5 = await mkItem('TUB-ZZTEST-CNT5', 'Nut');
      const oiS = await mkLine(100, 'ZZT-S');
      await mkCard(oiS, 'ZZT-S1', 50, 'dispatched', false);
      await mkCard(oiS, 'ZZT-S2', 50, 'qc_approved', false);
      for (const no of ['ZZT-S1', 'ZZT-S2']) await takeOn(CNT5, oiS, 200, `Order: ZZT-CNT-1 | Dwg: ZZT-S | Partial dispatch QC-approved (JC ${no})`);
      await putLine(oiS, CNT5, 400, 400);
      s0 = { c: await stock(CNT5) };
      r = await save(oiS, [[CNT5, 200]]);
      ok('S. a card set to dispatched by hand counts as dispatched: nothing moves', near(await stock(CNT5), s0.c) && held(r), r.summary);
    }

    // ── U. The whole-line settle: at dispatch a counted remainder is settled, not taken; at QC it is taken ──
    for (const [label, atDispatch, wantCnt] of [['U. settle at dispatch', true, 0], ['U. settle at QC approval', false, 100]]) {
      const oiU = await mkLine(100, `ZZT-U${atDispatch ? 'D' : 'Q'}`);
      const u1 = await mkCard(oiU, `ZZT-U${atDispatch ? 'D' : 'Q'}1`, 50, 'dispatched', true);
      await mkCard(oiU, `ZZT-U${atDispatch ? 'D' : 'Q'}2`, 50, 'dispatched', true);
      for (const inv of [CNT, PLN]) {
        await takeOn(inv, oiU, 300, `Order: ZZT-CNT-1 | Dwg: ZZT-U | Partial dispatch QC-approved (JC ZZT-U${atDispatch ? 'D' : 'Q'}1)`);
        await putLine(oiU, inv, 400, 300);
      }
      s0 = { c: await stock(CNT), p: await stock(PLN) };
      await ded.settleItemInventory(txDb, oiU, 1, 'ZZT-CNT-1', { atDispatch });
      L = await line(oiU, CNT);
      ok(`${label}: counted item −${wantCnt}, plain item −100${atDispatch ? '; the 100 is settled without stock' : ''}`,
        near(await stock(CNT), s0.c - wantCnt) && near(await stock(PLN), s0.p - 100) && (!atDispatch || near(L.w, 100)),
        `cnt ${s0.c}→${await stock(CNT)} plain ${s0.p}→${await stock(PLN)} ${JSON.stringify(L)}`);
    }

    // ── N. A card dispatched between two saves: nothing moves on either ──
    const oiNN = await mkLine(100, 'ZZT-N');
    await mkCard(oiNN, 'ZZT-N1', 50, 'dispatched', true);
    const n2 = await mkCard(oiNN, 'ZZT-N2', 50, 'qc_approved', false);
    for (const no of ['ZZT-N1', 'ZZT-N2']) await takeOn(CNT, oiNN, 200, `Order: ZZT-CNT-1 | Dwg: ZZT-N | Partial dispatch QC-approved (JC ${no})`);
    await putLine(oiNN, CNT, 400, 400);
    s0 = { c: await stock(CNT) };
    r = await save(oiNN, [[CNT, 500]]);
    await client.query('UPDATE job_cards SET status=$1, dispatched_at=NOW() WHERE id=$2', ['dispatched', n2]);
    r = await save(oiNN, [[CNT, 500]]);
    ok('N. raised, then the other card dispatched and saved again: nothing moves', near(await stock(CNT), s0.c), r.summary);

    // ── O. A plain correction made while nothing was dispatched, then a card dispatched ──
    const CNT4 = await mkItem('TUB-ZZTEST-CNT4', 'Flange');
    const oiO = await mkLine(100, 'ZZT-O');
    const o1 = await inProd(oiO, 'ZZT-O1');
    await inProd(oiO, 'ZZT-O2');
    for (const no of ['ZZT-O1', 'ZZT-O2']) await takeOn(CNT4, oiO, 100, `Order: ZZT-CNT-1 | Dwg: ZZT-O | Stage 15 Brazing (JC ${no})`);
    await putLine(oiO, CNT4, 200, 200);
    s0 = { c: await stock(CNT4) };
    r = await save(oiO, [[CNT4, 400]]);
    ok('O. 2 → 4 a piece with every card in production: takes 200 as usual', near(await stock(CNT4), s0.c - 200), r.summary);
    await client.query('UPDATE job_cards SET status=$1, dispatched_at=NOW() WHERE id=$2', ['dispatched', o1]);
    s0 = { c: await stock(CNT4) };
    r = await save(oiO, [[CNT4, 400]]);
    ok('O. one card dispatched, same list saved: nothing moves', near(await stock(CNT4), s0.c), r.summary);

    // ── Stage 5 undo ──
    const TUBE = await mkItem('TUB-ZZTEST-T', 'Tube', 500, 'foot');
    const PLAINTUBE = await mkItem('ZZTEST-TUBE', 'Tube', 500, 'foot');
    const ord5 = (await q1(`INSERT INTO orders (order_code, customer_id, order_date, order_type, status, material_deduction) VALUES ('ZZT-CNT-5', (SELECT MIN(id) FROM customers), CURRENT_DATE, 'local_he', 'in_progress', TRUE) RETURNING id`)).id;
    const tubeLine = async (code) => (await q1(`INSERT INTO order_items (order_id, quantity, tube_material) VALUES ($1, 10, $2) RETURNING id`, [ord5, code])).id;
    const tubeCard = async (no, oiT, invId, dispatched, status = 'in_progress') => {
      const id = (await q1(`INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, tube_deducted, tube_used_qty, tube_scrap_qty, dispatched_at)
        VALUES ($1,$2,$3,10,$4,CURRENT_DATE,TRUE,10,1,$5) RETURNING id`, [no, ord5, oiT, status, dispatched ? new Date() : null])).id;
      await client.query(`INSERT INTO production_checklist (job_card_id, stage_no, done, value1, done_at) VALUES ($1,5,1,'300',NOW())`, [id]);
      await client.query('UPDATE inventory_items SET current_stock = current_stock - 11 WHERE id=$1', [invId]);
      return id;
    };
    const undo = async (id) => { await client.query('UPDATE production_checklist SET done=0, done_at=NULL WHERE job_card_id=$1 AND stage_no=5', [id]); await applyMaterialDeductions(txDb, id, 5, false, 1); };
    const flags = async (id) => q1('SELECT tube_deducted, tube_used_qty::float u, tube_scrap_qty::float s FROM job_cards WHERE id=$1', [id]);

    const oiT = await tubeLine('TUB-ZZTEST-T');
    let t0 = await stock(TUBE);
    const tDisp = await tubeCard('ZZT-T1', oiT, TUBE, true, 'dispatched');
    await undo(tDisp);
    let f = await flags(tDisp);
    ok('I. Stage 5 undone on a dispatched card: no tube back, card keeps it as taken', near(await stock(TUBE), t0 - 11) && f.tube_deducted === true && near(f.u, 10), JSON.stringify(f));
    ok('I. the timeline says why', logs.some(l => l.jc === tDisp && l.type === 'tube_not_returned' && /11 ft not put back/.test(l.desc)), logs.filter(l => l.jc === tDisp).map(l => l.desc).join(' | '));
    await client.query('UPDATE production_checklist SET done=1, done_at=NOW() WHERE job_card_id=$1 AND stage_no=5', [tDisp]);
    await applyMaterialDeductions(txDb, tDisp, 5, true, 1);
    ok('I. ticking Stage 5 again takes nothing more', near(await stock(TUBE), t0 - 11));

    const tBack = await tubeCard('ZZT-T2', oiT, TUBE, true, 'repair_in_progress');
    t0 = await stock(TUBE);
    await undo(tBack);
    ok('J. a dispatched card back for repair is still held', near(await stock(TUBE), t0) && (await flags(tBack)).tube_deducted === true);

    const tProd = await tubeCard('ZZT-T3', oiT, TUBE, false);
    t0 = await stock(TUBE);
    await undo(tProd);
    f = await flags(tProd);
    ok('K. a card still in production gets its tube back as usual', near(await stock(TUBE), t0 + 11) && f.tube_deducted === false, JSON.stringify(f));

    const oiN = await tubeLine('TUB-ZZTEST-T');
    const tGone = await tubeCard('ZZT-T4', oiN, TUBE, true, 'dispatched');
    await client.query(`UPDATE order_items SET tube_material='TUB-ZZTEST-NOPE' WHERE id=$1`, [oiN]);
    t0 = await stock(TUBE);
    await undo(tGone);
    ok('L. dispatched card whose Tube Material no longer resolves: still held', near(await stock(TUBE), t0) && (await flags(tGone)).tube_deducted === true);

    // Q. Ticking Stage 5 on a dispatched card whose tube was never taken: takes nothing
    const tQ = (await q1(`INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, tube_deducted, dispatched_at)
      VALUES ('ZZT-T5',$1,$2,10,'repair_in_progress',CURRENT_DATE,FALSE,NOW()) RETURNING id`, [ord5, oiT])).id;
    await client.query(`INSERT INTO production_checklist (job_card_id, stage_no, done, value1, done_at) VALUES ($1,5,1,'300',NOW())`, [tQ]);
    t0 = await stock(TUBE);
    await applyMaterialDeductions(txDb, tQ, 5, true, 1);
    f = await flags(tQ);
    ok('Q. Stage 5 ticked on a dispatched card: no tube taken, card marked done with 0',
      near(await stock(TUBE), t0) && f.tube_deducted === true && near(f.u, 0) && logs.some(l => l.jc === tQ && l.type === 'tube_not_taken'), JSON.stringify(f));

    // R. A split parent still in production: its undo keeps the dispatched split card's share
    const tR = (await q1(`INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, tube_deducted, tube_used_qty, tube_scrap_qty, created_at)
      VALUES ('ZZT-T6',$1,$2,4,'in_progress',CURRENT_DATE,TRUE,50,5,NOW() - interval '2 hours') RETURNING id`, [ord5, oiT])).id;
    await client.query(`INSERT INTO production_checklist (job_card_id, stage_no, done, value1, done_at) VALUES ($1,5,1,'300',NOW() - interval '2 hours')`, [tR]);
    await client.query(`INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by, created_at) VALUES ($1,'dispatch_to_production',50,0,'Tube used 50 ft (300mm job card cutting length × 50 pcs) — ZZT-CNT-5 · JC ZZT-T6',1,NOW() - interval '2 hours')`, [TUBE]);
    await client.query(`INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, tube_deducted, parent_job_card_id, dispatched_at, created_at)
      VALUES ('ZZT-T6-P1',$1,$2,46,'dispatched',CURRENT_DATE,TRUE,$3,NOW(),NOW() - interval '1 hour')`, [ord5, oiT, tR]);
    t0 = await stock(TUBE);
    await undo(tR);
    ok('R. split parent (4 of 50) undone: gives back only its 4/50 of 55 ft = 4.4 ft', near(await stock(TUBE), t0 + 4.4) && logs.some(l => l.jc === tR && /50.6 ft kept as taken/.test(l.desc)),
      `${t0} → ${await stock(TUBE)} | ${logs.filter(l => l.jc === tR).map(l => l.desc).join(' | ')}`);

    // R2. A card split off BEFORE the parent's take, and its own dispatched split card: not in the parent's cut
    const tR2 = (await q1(`INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, tube_deducted, tube_used_qty, tube_scrap_qty, created_at)
      VALUES ('ZZT-T7',$1,$2,30,'in_progress',CURRENT_DATE,TRUE,30,3,NOW() - interval '3 hours') RETURNING id`, [ord5, oiT])).id;
    await client.query(`INSERT INTO production_checklist (job_card_id, stage_no, done, value1, done_at) VALUES ($1,5,1,'300',NOW() - interval '2 hours')`, [tR2]);
    const early = (await q1(`INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, tube_deducted, parent_job_card_id, created_at)
      VALUES ('ZZT-T7-P1',$1,$2,20,'in_progress',CURRENT_DATE,FALSE,$3,NOW() - interval '150 minutes') RETURNING id`, [ord5, oiT, tR2])).id;
    await client.query(`INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by, created_at) VALUES ($1,'dispatch_to_production',30,0,'Tube used 30 ft (300mm job card cutting length × 30 pcs) — ZZT-CNT-5 · JC ZZT-T7',1,NOW() - interval '2 hours')`, [TUBE]);
    await client.query(`INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, tube_deducted, parent_job_card_id, dispatched_at, created_at)
      VALUES ('ZZT-T7-P1-P1',$1,$2,10,'dispatched',CURRENT_DATE,FALSE,$3,NOW(),NOW() - interval '1 hour')`, [ord5, oiT, early]);
    t0 = await stock(TUBE);
    await undo(tR2);
    ok('R2. a split card made before the take (and its dispatched split card) is not in the parent\'s cut: all 33 ft back', near(await stock(TUBE), t0 + 33), `${t0} → ${await stock(TUBE)}`);

    // R3. A split card that later took its own tube paid for its pieces: the parent gives back all
    const tR3 = (await q1(`INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, tube_deducted, tube_used_qty, tube_scrap_qty, created_at)
      VALUES ('ZZT-T8',$1,$2,4,'in_progress',CURRENT_DATE,TRUE,50,5,NOW() - interval '3 hours') RETURNING id`, [ord5, oiT])).id;
    await client.query(`INSERT INTO production_checklist (job_card_id, stage_no, done, value1, done_at) VALUES ($1,5,1,'300',NOW() - interval '3 hours')`, [tR3]);
    await client.query(`INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by, created_at) VALUES ($1,'dispatch_to_production',50,0,'Tube used 50 ft (300mm job card cutting length × 50 pcs) — ZZT-CNT-5 · JC ZZT-T8',1,NOW() - interval '3 hours')`, [TUBE]);
    await client.query(`INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, tube_deducted, tube_used_qty, parent_job_card_id, dispatched_at, created_at)
      VALUES ('ZZT-T8-P1',$1,$2,46,'dispatched',CURRENT_DATE,TRUE,46,$3,NOW(),NOW() - interval '2 hours')`, [ord5, oiT, tR3]);
    await client.query(`INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by, created_at) VALUES ($1,'dispatch_to_production',46,0,'Tube used 46 ft (300mm job card cutting length × 46 pcs) — ZZT-CNT-5 · JC ZZT-T8-P1',1,NOW() - interval '1 hour')`, [TUBE]);
    t0 = await stock(TUBE);
    await undo(tR3);
    ok('R3. its split card took its own tube later: the parent gives back all 55 ft', near(await stock(TUBE), t0 + 55), `${t0} → ${await stock(TUBE)}`);

    // R4. Split of a split: the middle card re-took its own tube after its own split — the grandchild's share stays
    {
      const P = (await q1(`INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, tube_deducted, tube_used_qty, tube_scrap_qty, created_at)
        VALUES ('ZZT-T9',$1,$2,30,'in_progress',CURRENT_DATE,TRUE,50,5,NOW() - interval '5 hours') RETURNING id`, [ord5, oiT])).id;
      await client.query(`INSERT INTO production_checklist (job_card_id, stage_no, done, value1, done_at) VALUES ($1,5,1,'300',NOW() - interval '5 hours')`, [P]);
      await client.query(`INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by, created_at) VALUES ($1,'dispatch_to_production',50,0,'Tube used 50 ft (300mm job card cutting length × 50 pcs) — ZZT-CNT-5 · JC ZZT-T9',1,NOW() - interval '5 hours')`, [TUBE]);
      const K = (await q1(`INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, tube_deducted, tube_used_qty, parent_job_card_id, created_at)
        VALUES ('ZZT-T9-P1',$1,$2,10,'in_progress',CURRENT_DATE,TRUE,10,$3,NOW() - interval '4 hours') RETURNING id`, [ord5, oiT, P])).id;
      await client.query(`INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, tube_deducted, parent_job_card_id, dispatched_at, created_at)
        VALUES ('ZZT-T9-P1-P1',$1,$2,10,'dispatched',CURRENT_DATE,TRUE,$3,NOW(),NOW() - interval '3 hours')`, [ord5, oiT, K]);
      await client.query(`INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by, created_at) VALUES ($1,'dispatch_to_production',10,0,'Tube used 10 ft (300mm job card cutting length × 10 pcs) — ZZT-CNT-5 · JC ZZT-T9-P1',1,NOW() - interval '1 hour')`, [TUBE]);
      t0 = await stock(TUBE);
      await undo(P);
      ok('R4. the middle card re-took only for itself: the dispatched grandchild\'s 10/50 stays — 44 of 55 ft back', near(await stock(TUBE), t0 + 44), `${t0} → ${await stock(TUBE)}`);
    }

    // V. Stage 5 undone on a card approved at QC, not dispatched: held
    {
      const tV = await tubeCard('ZZT-T11', oiT, TUBE, false, 'qc_approved');
      t0 = await stock(TUBE);
      await undo(tV);
      ok('V. Stage 5 undone on a card through QC (waiting at dispatch): nothing back', near(await stock(TUBE), t0) && (await flags(tV)).tube_deducted === true);
    }

    // S2. Stage 5 undone on a card set to dispatched by hand: held
    {
      const tS = await tubeCard('ZZT-T10', oiT, TUBE, false, 'dispatched');
      t0 = await stock(TUBE);
      await undo(tS);
      ok('S2. Stage 5 undone on a card set to dispatched by hand: nothing back', near(await stock(TUBE), t0) && (await flags(tS)).tube_deducted === true);
    }

    const oiP = await tubeLine('ZZTEST-TUBE');
    const tPlain = await tubeCard('ZZT-P1', oiP, PLAINTUBE, true, 'dispatched');
    let p0 = await stock(PLAINTUBE);
    await undo(tPlain);
    ok('M. a tube code outside the count works as before (back on undo)', near(await stock(PLAINTUBE), p0 + 11), `${p0} → ${await stock(PLAINTUBE)}`);
  } catch (e) {
    failed = true;
    console.error('ERROR', e);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await realPool.end();
    console.log(failed ? '\nSOME CHECKS FAILED (rolled back)' : '\nALL PASS (rolled back — nothing kept)');
    process.exit(failed ? 1 : 0);
  }
})();
