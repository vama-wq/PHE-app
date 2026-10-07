// Test for "Don't add to inventory" on a PO (owner, 7 Oct 2026 — P PHE 46):
// QC passes the goods and Payments Due bills them, but no stock is added — no
// lot, no cost change, no "purchase in" line. The owner turns it on or off
// until the first line passes QC.
//
// Runs inside one transaction that is ROLLED BACK, on its own made-up item and
// POs (ZZT-PO-NS…), so no real stock, PO or payment is touched. Routes run
// through express; the QC photo upload is stubbed.
//   node scripts/test_po_no_stock.cjs
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
  dbmod.logActivity = async (orderId, jc, type, desc) => { logs.push({ type, desc }); };
  const q1 = async (q, p = []) => (await client.query(q, p)).rows[0];
  const qa = async (q, p = []) => (await client.query(q, p)).rows;
  let failed = false;
  const ok = (label, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  ' + String(extra).slice(0, 300) : '')); if (!cond) failed = true; };
  process.on('unhandledRejection', (e) => { failed = true; console.error('ROUTE ERROR (unhandled):', e); });
  const owner = await q1("SELECT id, name, role FROM users WHERE role='owner' ORDER BY id LIMIT 1");
  const accounts = { id: owner.id, name: 'ZZTEST Accounts', role: 'accounts' };
  let actor = owner;
  const auth = require(S + '/src/middleware/auth.js');
  auth.authenticate = (req, res, next) => { req.user = actor; next(); };
  const upload = require(S + '/src/middleware/upload.js');
  upload.uploadPurchaseItemQCFields = [(req, res, next) => { req.files = { image: [{ storagePath: 'test/qc.jpg', originalname: 'qc.jpg' }] }; next(); }];
  const notif = require(S + '/src/routes/notifications.js');
  notif.createNotification = async () => {};
  const express = require(S + '/node_modules/express');
  const app = express();
  app.use(express.json());
  app.use('/api/purchase-orders', require(S + '/src/routes/purchaseOrders.js'));
  const server = app.listen(0);
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, url, body, as = owner) => {
    actor = as;
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    actor = owner;
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  try {
    const col = await q1(`SELECT 1 AS x FROM information_schema.columns WHERE table_name='purchase_orders' AND column_name='no_stock'`);
    if (!col || !owner) { ok('Database ready: purchase_orders.no_stock exists and an owner user exists', false); return; }
    const stock = async (id) => Number((await q1('SELECT current_stock FROM inventory_items WHERE id=$1', [id])).current_stock);
    const lots = async (po) => Number((await q1('SELECT COUNT(*)::int n FROM inventory_fifo_lots WHERE po_id=$1', [po])).n);
    const ins = async (inv, poNo) => Number((await q1(`SELECT COUNT(*)::int n FROM inventory_transactions WHERE item_id=$1 AND transaction_type='purchase_in' AND po_number=$2`, [inv, poNo])).n);
    const ITEM = (await q1(`INSERT INTO inventory_items (item_code, name, unit, category, current_stock, unit_cost) VALUES ('ZZTEST-PO-NS','ZZTEST-PO-NS','pcs','Tube',100,50) RETURNING id`)).id;
    const sup = (await q1('SELECT MIN(id) AS id FROM suppliers')).id;
    // A PO received and waiting for QC: 10 pcs @ ₹200, 18% GST.
    const mkPo = async (no, noStock) => {
      const po = (await q1(
        `INSERT INTO purchase_orders (po_number, supplier_id, status, delivery_status, igst_percent, transport_charges, no_stock, received_at, created_by)
         VALUES ($1,$2,'approved','qc_pending',18,0,$3,NOW(),$4) RETURNING id`, [no, sup, noStock, owner.id])).id;
      const it = (await q1(
        `INSERT INTO purchase_order_items (po_id, inventory_item_id, description, unit, qty, rate, amount, received, received_at, billed_qty)
         VALUES ($1,$2,'ZZTEST tube','pcs',10,200,2000,TRUE,NOW(),10) RETURNING id`, [po, ITEM])).id;
      return { po, it };
    };
    const qcPass = (p) => call('POST', `/api/purchase-orders/${p.po}/items/${p.it}/qc`, { result: 'approved', weight_10: 1, received_qty: 10 });

    // ════ A. The switch ════
    const A = await mkPo('ZZT-PO-NS-A', false);
    let r = await call('PUT', `/api/purchase-orders/${A.po}/no-stock`, { no_stock: true }, accounts);
    ok('A1. only the owner can turn it on', r.status === 403 && (await q1('SELECT no_stock FROM purchase_orders WHERE id=$1', [A.po])).no_stock === false, `${r.status}`);
    r = await call('PUT', `/api/purchase-orders/${A.po}/no-stock`, { no_stock: true });
    const page = await call('GET', `/api/purchase-orders/${A.po}`);
    ok('A2. the owner turns it on before QC; the PO page shows it', r.status === 200 && r.body.no_stock === true
      && page.body.no_stock === true
      && logs.some(l => l.type === 'purchase_no_stock' && /ZZT-PO-NS-A: "Don't add to inventory" turned ON/.test(l.desc)),
      `${JSON.stringify(r.body)} | page ${page.status} no_stock=${page.body.no_stock} ${page.body.error || ''} | ${JSON.stringify(logs.map(l => l.desc))}`);

    // ════ B. QC passes it: no stock, still on Payments Due ════
    const s0 = await stock(ITEM);
    r = await qcPass(A);
    ok('B1. QC approves the 10 pcs: the line is QC-passed', r.status === 200 && (await q1('SELECT qc_status FROM purchase_order_items WHERE id=$1', [A.it])).qc_status === 'approved', `${r.status} ${JSON.stringify(r.body)}`);
    ok('B2. nothing goes into stock — stock unchanged, no lot, no "purchase in" line',
      (await stock(ITEM)) === s0 && (await lots(A.po)) === 0 && (await ins(ITEM, 'ZZT-PO-NS-A')) === 0, `${s0} → ${await stock(ITEM)}`);
    ok('B3. the PO history says it was not added to inventory',
      logs.some(l => l.type === 'purchase_no_stock' && /ZZT-PO-NS-A: "ZZTEST tube" passed QC \(10 pcs\) — not added to inventory/.test(l.desc)));
    const due = await call('GET', '/api/purchase-orders/payments-due');
    const bill = (due.body.bills || []).find(b => b.po_id === A.po);
    ok('B4. it shows on Payments Due: 10 × ₹200 + 18% = ₹2,360', !!bill && bill.remaining === 2360, JSON.stringify(bill));
    r = await call('PUT', `/api/purchase-orders/${A.po}/no-stock`, { no_stock: false });
    ok('B5. once a line has passed QC the switch is locked', r.status === 400 && /already passed QC/.test(r.body.error || ''), JSON.stringify(r.body));

    // ════ C. A PO without it: stock added as always ════
    const C = await mkPo('ZZT-PO-NS-C', false);
    const s1 = await stock(ITEM);
    r = await qcPass(C);
    ok('C1. an ordinary PO still adds its 10 pcs to stock with a lot and a "purchase in" line',
      r.status === 200 && (await stock(ITEM)) === s1 + 10 && (await lots(C.po)) === 1 && (await ins(ITEM, 'ZZT-PO-NS-C')) === 1, `${s1} → ${await stock(ITEM)}`);

    // ════ D. Turned on, then off again before QC: back to normal ════
    const D = await mkPo('ZZT-PO-NS-D', false);
    await call('PUT', `/api/purchase-orders/${D.po}/no-stock`, { no_stock: true });
    r = await call('PUT', `/api/purchase-orders/${D.po}/no-stock`, { no_stock: false });
    const s2 = await stock(ITEM);
    const rq = await qcPass(D);
    ok('D1. on then off before QC: QC adds the stock as usual', r.status === 200 && r.body.no_stock === false && rq.status === 200 && (await stock(ITEM)) === s2 + 10, `${s2} → ${await stock(ITEM)}`);
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
