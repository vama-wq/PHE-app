// Payments Due extras (owner, 26 Nov 2026) — on the LIVE data inside one transaction that is ROLLED BACK.
//  A. the leftover unpaid-bank list: every unpaid expense not linked to a PO.
//  B. paying more than a bill's balance: the entry is recorded in full, the extra comes off the supplier's
//     next bill as an adjustment (Anant P PHE 31 → P PHE 52), or is noted on the PO when none exists.
const S = __dirname + '/..';
require(S + '/node_modules/dotenv').config({ path: S + '/.env' });
const dbm = require(S + '/src/db');
let failed = 0;
const ok = (n, c, i = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  — ' + i}`); if (!c) failed++; };
const r2 = (n) => Math.round(Number(n) * 100) / 100;
(async () => {
  const db = dbm.getDB();
  const client = await db.pool.connect();
  const q = async (sql, p) => (await client.query(sql, p)).rows;
  // run every db call of the route on this one client
  db.get = async (s, p = []) => (await client.query(s, p)).rows[0] || null;
  db.all = async (s, p = []) => (await client.query(s, p)).rows;
  db.run = async (s, p = []) => client.query(s, p);
  db.insert = async (s, p = []) => ({ lastInsertRowid: (await client.query(s.trimEnd().replace(/;?\s*$/, '') + ' RETURNING id', p)).rows[0]?.id });
  db.withTransaction = async (fn) => fn(client);
  const router = require(S + '/src/routes/purchaseOrders.js');
  const handler = (path, method) => router.stack.find(l => l.route && l.route.path === path && l.route.methods[method]).route.stack.slice(-1)[0].handle;
  const call = async (h, req) => new Promise((resolve, reject) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    Promise.resolve(h({ user: { id: 1, role: 'owner' }, params: {}, query: {}, body: {}, ...req }, res)).catch(reject);
  });
  try {
    await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout='3s'"); await client.query("SET LOCAL statement_timeout='60s'");
    const before = (await q(`SELECT (SELECT count(*) FROM petty_cash_entries) e, (SELECT count(*) FROM purchase_order_adjustments) a, (SELECT COALESCE(SUM(grand_total),0) FROM purchase_orders) g`))[0];
    // A
    const list = (await call(handler('/payments-due', 'get'), {})).body;
    const want = (await q("SELECT count(*)::int n, COALESCE(SUM(amount),0)::float t FROM petty_cash_entries WHERE payment_method='unpaid_bank' AND entry_type='expense' AND po_id IS NULL"))[0];
    ok(`A1. Payments Due lists the ${want.n} unpaid-bank entries not linked to a PO (₹${r2(want.t)}), none linked to a PO`,
      list.other_unpaid.length === want.n && r2(list.other_unpaid_total) === r2(want.t) && list.other_unpaid.length > 0, JSON.stringify({ n: list.other_unpaid.length, t: list.other_unpaid_total, want }));
    // B1 Anant: pay P PHE 31 ₹626 more than due
    const anant = await q("SELECT po.id, po.po_number FROM purchase_orders po WHERE po.po_number IN ('P PHE 31','P PHE 52') ORDER BY po.po_number");
    const p31 = anant.find(x => x.po_number === 'P PHE 31'), p52 = anant.find(x => x.po_number === 'P PHE 52');
    const b31 = list.bills.find(b => b.po_id === p31.id), b52 = list.bills.find(b => b.po_id === p52.id);
    if (!b31 || !b52) throw new Error('Anant bills not on Payments Due any more — nothing to test on');
    const rem31 = b31.remaining, rem52 = b52.remaining;
    const pay = await call(handler('/payments-due/pay', 'post'), { body: { entry_date: '2026-11-26', payments: [{ po_id: p31.id, amount: r2(rem31 + 626) }] } });
    ok('B1. paying ₹626 more than P PHE 31 is accepted and says where the extra went', pay.code === 201 && (pay.body.warnings || []).some(w => /626 more than due — taken off P PHE 52/.test(w)), JSON.stringify(pay));
    const adj = await q("SELECT amount::float a, reason, ref_po_id FROM purchase_order_adjustments WHERE po_id=$1", [p52.id]);
    ok('B2. P PHE 52 got a −₹626 adjustment that points back to P PHE 31', adj.length === 1 && adj[0].a === -626 && adj[0].ref_po_id === p31.id, JSON.stringify(adj));
    const ent = await q("SELECT amount::float a, description, payment_method FROM petty_cash_entries WHERE po_id=$1 ORDER BY id DESC LIMIT 1", [p31.id]);
    ok('B3. one Unpaid Bank entry for the full amount paid, its description names P PHE 52', ent[0].a === r2(rem31 + 626) && ent[0].payment_method === 'unpaid_bank' && /taken off P PHE 52/.test(ent[0].description), JSON.stringify(ent));
    const after = (await call(handler('/payments-due', 'get'), {})).body;
    const a31 = after.bills.find(b => b.po_id === p31.id), a52 = after.bills.find(b => b.po_id === p52.id);
    ok(`B4. P PHE 31 is cleared (was ₹${rem31}); P PHE 52 now owes ₹${r2(rem52 - 626)} (was ₹${rem52}); the money tied out`,
      !a31 && a52 && r2(a52.remaining) === r2(rem52 - 626), JSON.stringify({ a31, a52 }));
    // B5 no next bill: a supplier with exactly one active PO
    const lone = await q(`SELECT po.id, po.po_number, po.supplier_id FROM purchase_orders po WHERE po.status NOT IN ('draft','rejected') AND po.delivery_status IS DISTINCT FROM 'order_cancelled'
      AND (SELECT count(*) FROM purchase_orders o WHERE o.supplier_id=po.supplier_id AND o.status NOT IN ('draft','rejected') AND o.delivery_status IS DISTINCT FROM 'order_cancelled') = 1 ORDER BY po.id`);
    const lb = lone.map(l => ({ l, b: after.bills.find(x => x.po_id === l.id) })).find(x => x.b);
    if (lb) {
      const r = await call(handler('/payments-due/pay', 'post'), { body: { entry_date: '2026-11-26', payments: [{ po_id: lb.l.id, amount: r2(lb.b.remaining + 100) }] } });
      const po = (await q('SELECT notes FROM purchase_orders WHERE id=$1', [lb.l.id]))[0];
      ok(`B5. ₹100 more than ${lb.l.po_number}'s balance with no next bill: accepted, noted on the PO`, r.code === 201 && /Paid ₹100 more/.test(po.notes || '') && (r.body.warnings || []).some(w => /no next bill, noted/.test(w)), JSON.stringify({ r, notes: po.notes }));
    } else console.log('      (no single-PO supplier with a bill due — B5 skipped)');
    // B6 an exact payment still works and adds nothing extra
    const c52 = after.bills.find(b => b.po_id === p52.id);
    const exact = await call(handler('/payments-due/pay', 'post'), { body: { entry_date: '2026-11-26', payments: [{ po_id: p52.id, amount: c52.remaining }] } });
    ok('B6. an exact payment is unchanged: no warning, no new adjustment', exact.code === 201 && !(exact.body.warnings || []).length
      && (await q('SELECT count(*)::int n FROM purchase_order_adjustments WHERE po_id=$1', [p52.id]))[0].n === 1, JSON.stringify(exact));
    await client.query('ROLLBACK');
    const end = (await q(`SELECT (SELECT count(*) FROM petty_cash_entries) e, (SELECT count(*) FROM purchase_order_adjustments) a, (SELECT COALESCE(SUM(grand_total),0) FROM purchase_orders) g`))[0];
    ok('C. rolled back — entries, adjustments and PO totals as before', JSON.stringify(end) === JSON.stringify(before), JSON.stringify({ before, end }));
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); ok('live checks ran', false, e.stack); }
  finally { client.release(); await db.pool.end(); }
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL PASS (rolled back — nothing kept)');
  process.exit(failed ? 1 : 0);
})();
