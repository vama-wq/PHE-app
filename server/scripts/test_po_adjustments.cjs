// PO adjustments (owner, 18 Nov 2026) — checks on the LIVE data, all in one
// transaction that is ROLLED BACK: nothing is kept.
//  A. calcTotals: an adjustment is added after GST, + or −, then rounded.
//  B. A real received PO: adding −X / +Y moves its stored total by exactly that
//     and its Payments Due by exactly that, on the first part; a deduction
//     bigger than a part carries to the next; item costs are untouched.
//  C. Validation on the routes (400s only, before any write), in-process.
const S = __dirname + '/..';
require(S + '/node_modules/dotenv').config({ path: S + '/.env' });
const { Pool } = require(S + '/node_modules/pg');
const { calcTotals, recomputePoTotals, adjustmentsTotal } = require(S + '/src/lib/poSettle');
let failed = 0;
const ok = (name, cond, info = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  — ' + info}`); if (!cond) failed++; };
const r2 = (n) => Math.round(Number(n) * 100) / 100;

// A. pure
{
  const base = calcTotals([{ amount: 1000 }], 100, 18, 0, 0);      // 1100 + 198 = 1298
  const minus = calcTotals([{ amount: 1000 }], 100, 18, 0, -150.4); // 1147.6 → 1148 (round +0.4)
  const plus = calcTotals([{ amount: 1000 }], 100, 18, 50, 25);     // 1298 + 50 + 25 = 1373
  ok('A1. no adjustment: as before (1,100 + 18% = 1,298)', base.grandTotal === 1298 && base.subtotal === 1100 && base.igstAmount === 198, JSON.stringify(base));
  ok('A2. −150.40 after GST: GST unchanged (198), total 1,147.60 → 1,148 with round off +0.40', minus.igstAmount === 198 && minus.grandTotal === 1148 && minus.roundOff === 0.4, JSON.stringify(minus));
  ok('A3. +25 with packaging (no GST) 50: 1,298 + 50 + 25 = 1,373, no tax on either', plus.igstAmount === 198 && plus.grandTotal === 1373, JSON.stringify(plus));
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const c = await pool.connect();
  const db = { get: async (q, p) => (await c.query(q, p)).rows[0], all: async (q, p) => (await c.query(q, p)).rows, run: async (q, p) => c.query(q, p) };
  const router = require(S + '/src/routes/purchaseOrders.js');
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout='3s'"); await c.query("SET LOCAL statement_timeout='30s'");
    const counts = async () => (await db.get(`SELECT (SELECT count(*) FROM purchase_order_adjustments) a, (SELECT count(*) FROM purchase_orders) p,
      (SELECT COALESCE(SUM(amount),0) FROM petty_cash_entries) pc, (SELECT count(*) FROM activity_log) al`));
    const before = await counts();
    // A received PO with two or more delivered parts, if there is one; else any received PO.
    const pick = async (sql) => db.get(sql);
    const pos = await db.all(`SELECT po.id, po.po_number, po.igst_percent, po.transport_charges, po.packaging_no_gst, ${router.PO_ADJ_SQL}, s.name AS supplier_name, ${router.PO_PAID_SQL}
      FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.status NOT IN ('draft','rejected')`);
    const parts0 = await router.payableParts(db, pos);
    const multi = pos.find(p => (parts0.get(p.id) || []).length >= 2 && (parts0.get(p.id) || [])[0].payable > 500);
    const single = pos.find(p => (parts0.get(p.id) || []).length === 1 && (parts0.get(p.id) || [])[0].payable > 500);
    const target = multi || single;
    if (!target) throw new Error('no received PO to test on');
    const P0 = parts0.get(target.id);
    const po0 = await db.get('SELECT grand_total, subtotal, igst_amount FROM purchase_orders WHERE id=$1', [target.id]);
    const costs0 = await db.all('SELECT id, rate, amount FROM purchase_order_items WHERE po_id=$1 ORDER BY id', [target.id]);
    const lots0 = await db.all(`SELECT COUNT(*) n FROM information_schema.tables WHERE table_name='inventory_lots'`);
    console.log(`      on ${target.po_number}: ${P0.length} part(s), payables ${P0.map(p => p.payable).join(' / ')}, stored total ₹${po0.grand_total}`);

    // B1: −X on the first part
    const X = Math.min(1000, Math.floor(P0[0].payable / 2));
    await db.run('INSERT INTO purchase_order_adjustments (po_id, amount, reason, created_by) VALUES ($1,$2,$3,1)', [target.id, -X, 'test deduction']);
    const t1 = await recomputePoTotals(db, target.id);
    ok(`B1. −₹${X} on ${target.po_number}: stored total ₹${po0.grand_total} → ₹${r2(po0.grand_total - X)} (GST and subtotal unchanged)`,
      Math.abs(t1.grandTotal - (Number(po0.grand_total) - X)) <= 1 && r2(t1.subtotal) === r2(po0.subtotal) && r2(t1.igstAmount) === r2(po0.igst_amount),
      JSON.stringify({ t1, po0 }));
    ok('B1b. adjustmentsTotal reads it back', (await adjustmentsTotal(db, target.id)) === -X);
    const row1 = (await db.all(`SELECT po.id, po.po_number, po.igst_percent, po.transport_charges, po.packaging_no_gst, ${router.PO_ADJ_SQL}, s.name AS supplier_name, ${router.PO_PAID_SQL}
      FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id=$1`, [target.id]));
    const P1 = (await router.payableParts(db, row1)).get(target.id);
    ok(`B2. Payments Due: the first part's payable drops by exactly ₹${X}, the other parts are untouched`,
      r2(P1[0].payable) === r2(P0[0].payable - X) && P1[0].adjustment === -X && P1.slice(1).every((p, i) => r2(p.payable) === r2(P0[i + 1].payable)),
      JSON.stringify({ P0: P0.map(p => p.payable), P1: P1.map(p => [p.payable, p.adjustment]) }));

    // B3: a deduction bigger than the first part carries to the next (multi-part), or stays on the only part (negative = supplier owes us)
    await db.run('DELETE FROM purchase_order_adjustments WHERE po_id=$1', [target.id]);
    const big = r2(P0[0].payable + 100);
    await db.run('INSERT INTO purchase_order_adjustments (po_id, amount, reason, created_by) VALUES ($1,$2,$3,1)', [target.id, -big, 'test big deduction']);
    const row3 = (await db.all(`SELECT po.id, po.po_number, po.igst_percent, po.transport_charges, po.packaging_no_gst, ${router.PO_ADJ_SQL}, s.name AS supplier_name, ${router.PO_PAID_SQL}
      FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id=$1`, [target.id]));
    const P3 = (await router.payableParts(db, row3)).get(target.id);
    if (P0.length >= 2) {
      ok(`B3. −₹${big} (more than part 1's ₹${P0[0].payable}): part 1 goes to 0, the ₹100 left comes off part 2`,
        r2(P3[0].payable) === 0 && r2(P3[1].payable) === r2(P0[1].payable - 100) && r2(P3.reduce((t, p) => t + p.payable, 0)) === r2(P0.reduce((t, p) => t + p.payable, 0) - big),
        JSON.stringify(P3.map(p => [p.payable, p.adjustment])));
    } else {
      ok(`B3. −₹${big} on a one-part PO: the part goes ₹100 below 0 (the supplier owes us), never off the books; no negative "paid"`,
        r2(P3[0].payable) === -100 && P3[0].paid_cleared >= 0 && P3[0].paid_pending >= 0, JSON.stringify(P3));
    }
    // B4: an addition rides with part 1
    await db.run('DELETE FROM purchase_order_adjustments WHERE po_id=$1', [target.id]);
    await db.run('INSERT INTO purchase_order_adjustments (po_id, amount, reason, created_by) VALUES ($1,$2,$3,1)', [target.id, 1150, 'test addition']);
    const row4 = (await db.all(`SELECT po.id, po.po_number, po.igst_percent, po.transport_charges, po.packaging_no_gst, ${router.PO_ADJ_SQL}, s.name AS supplier_name, ${router.PO_PAID_SQL}
      FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id=$1`, [target.id]));
    const P4 = (await router.payableParts(db, row4)).get(target.id);
    ok('B4. +₹1,150: part 1 payable up by exactly ₹1,150, no GST on it', r2(P4[0].payable) === r2(P0[0].payable + 1150) && P4[0].adjustment === 1150, JSON.stringify(P4.map(p => p.payable)));
    const costs1 = await db.all('SELECT id, rate, amount FROM purchase_order_items WHERE po_id=$1 ORDER BY id', [target.id]);
    ok('B5. item rates and amounts untouched (landed cost unchanged)', JSON.stringify(costs1) === JSON.stringify(costs0));
    // B6: a 0 amount is refused by the table itself
    let zeroRefused = false;
    await c.query('SAVEPOINT z');
    try { await db.run('INSERT INTO purchase_order_adjustments (po_id, amount, reason) VALUES ($1,0,$2)', [target.id, 'zero']); } catch { zeroRefused = true; }
    await c.query('ROLLBACK TO SAVEPOINT z');
    ok('B6. the table refuses a 0 adjustment', zeroRefused);
    // B7: deleting the PO row would cascade (checked by the FK definition)
    const fk = await db.get(`SELECT confdeltype FROM pg_constraint WHERE conrelid='purchase_order_adjustments'::regclass AND contype='f' AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='purchase_order_adjustments'::regclass AND attname='po_id')]`);
    ok('B7. adjustments go with their PO (ON DELETE CASCADE)', fk && fk.confdeltype === 'c', JSON.stringify(fk));
    await c.query('ROLLBACK');
    const after = await counts();
    ok('B8. rolled back — adjustments, POs, account statement and activity log as before', JSON.stringify(after) === JSON.stringify(before), JSON.stringify({ before, after }));
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); ok('B. live checks ran', false, e.message); }
  finally { c.release(); await pool.end(); }

  // C. Payments Due on a two-part PO (stub rows — no database): a deduction
  //    larger than part 1 empties it and the rest comes off part 2.
  {
    const router = require(S + '/src/routes/purchaseOrders.js');
    let call = 0;
    const stub = { all: async () => (call++ === 0
      ? [{ po_id: 1, month: '2026-10', received_at: '2026-10-05', material: 1000 }, { po_id: 1, month: '2026-11', received_at: '2026-11-05', material: 500 }]
      : []) };
    const po = { id: 1, igst_percent: 0, transport_charges: 0, packaging_no_gst: 0, adjustments_total: -1200, paid_cleared: 300, paid_pending: 0 };
    const P = (await router.payableParts(stub, [po])).get(1);
    ok('C1. two parts ₹1,000 + ₹500, adjustment −₹1,200: part 1 → ₹0, part 2 → ₹300; the ₹300 already paid clears part 2 (nothing negative)',
      P[0].payable === 0 && P[0].adjustment === -1000 && P[1].payable === 300 && P[1].adjustment === -200
      && P[0].paid_cleared === 0 && P[1].paid_cleared === 300 && P[1].remaining === 0, JSON.stringify(P));
    call = 0;
    const P2 = (await router.payableParts(stub, [{ ...po, adjustments_total: 250, paid_cleared: 0 }])).get(1);
    ok('C2. +₹250 rides with part 1 only (₹1,250 / ₹500)', P2[0].payable === 1250 && P2[1].payable === 500, JSON.stringify(P2));
    // D. the input rules
    const A = router.adjustmentFrom;
    ok('D1. amount 0, no amount, or text is refused', !!A({ amount: 0, reason: 'x' }).error && !!A({ reason: 'x' }).error && !!A({ amount: 'abc', reason: 'x' }).error);
    ok('D2. a reason is required', !!A({ amount: 100, reason: '  ' }).error);
    ok('D3. −1,150.456 is kept as −1,150.46 with its reason and earlier PO', JSON.stringify(A({ amount: -1150.456, reason: ' transport paid by us ', ref_po_id: '41' }).value)
      === JSON.stringify({ amount: -1150.46, reason: 'transport paid by us', ref_po_id: 41 }));
    ok('D4. a bad earlier-PO id is refused', !!A({ amount: 10, reason: 'x', ref_po_id: 'P PHE 41' }).error);
  }
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL PASS (rolled back — nothing kept)');
  process.exit(failed ? 1 : 0);
})();
