// Test: purchase material rejected → "Send for repair" (owner, 16 Oct 2026).
// Instead of a debit note, the item is un-received and the PO reverts to its
// original numbers; it is received and QC'd again when it returns. Only a full
// rejection repairs. Rolled back — nothing kept.
//   node scripts/test_po_repair.cjs
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
  dbmod.getDB = () => txDb;
  dbmod.logActivity = async () => {};
  const supa = require(S + '/node_modules/@supabase/supabase-js');
  supa.createClient = () => ({ storage: { from: (b) => ({
    upload: async (p) => ({ data: { path: p }, error: null }), remove: async () => ({ data: [], error: null }),
    copy: async (f, t) => ({ data: { path: t }, error: null }), download: async () => ({ data: null, error: { message: 'stub' } }),
    getPublicUrl: (p) => ({ data: { publicUrl: `stub://${b}/${p}` } }) }) } });
  const wa = require(S + '/src/lib/whatsapp.js'); wa.queueWhatsApp = async () => {};
  const q1 = async (q, p = []) => (await client.query(q, p)).rows[0];
  let failed = false;
  const ok = (label, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  ' + String(extra).slice(0, 300) : '')); if (!cond) failed = true; };
  process.on('unhandledRejection', (e) => { failed = true; console.error('ROUTE ERROR (unhandled):', e); });
  const owner = await q1("SELECT id, name, role FROM users WHERE role='owner' ORDER BY id LIMIT 1");
  const auth = require(S + '/src/middleware/auth.js');
  auth.authenticate = (req, res, next) => { req.user = owner; next(); };
  const upload = require(S + '/src/middleware/upload.js');
  upload.uploadPurchaseItemQCFields = [(req, res, next) => {
    req.files = { image: [{ storagePath: 'test/qc.jpg', originalname: 'qc.jpg' }],
      rejection_photos: [{ storagePath: 'test/rej.jpg', originalname: 'rej.jpg' }] }; next();
  }];
  const notif = require(S + '/src/routes/notifications.js'); notif.createNotification = async () => {};
  const express = require(S + '/node_modules/express');
  const app = express(); app.use(express.json());
  app.use('/api/purchase-orders', require(S + '/src/routes/purchaseOrders.js'));
  const server = app.listen(0); const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, url, body) => { const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  try {
    if (!(await q1(`SELECT 1 AS x FROM information_schema.columns WHERE table_name='purchase_order_items' AND column_name='repair_sent_at'`))) { ok('Database ready (repair_sent_at)', false); return; }
    const sup = (await q1('SELECT MIN(id) AS id FROM suppliers')).id;
    const inv = (await q1(`INSERT INTO inventory_items (item_code, name, unit, category, current_stock, unit_cost) VALUES ('ZZTEST-PO-REPAIR','ZZTEST','pcs','Tube',0,50) RETURNING id`)).id;
    const mkPo = async () => {
      const po = (await q1(`INSERT INTO purchase_orders (po_number, supplier_id, status, delivery_status, igst_percent, transport_charges, subtotal, igst_amount, grand_total, received_at, created_by)
        VALUES ('ZZT-REPAIR-'||floor(random()*1e6)::int,$1,'approved','qc_pending',18,0,2000,360,2360,NOW(),$2) RETURNING id, subtotal::float, grand_total::float`, [sup, owner.id]));
      const it = (await q1(`INSERT INTO purchase_order_items (po_id, inventory_item_id, description, unit, qty, rate, amount, received, received_at, billed_qty)
        VALUES ($1,$2,'ZZTEST repair item','pcs',10,200,2000,TRUE,NOW(),10) RETURNING id`, [po.id, inv]));
      return { po: po.id, it: it.id, sub0: po.subtotal, gt0: po.grand_total };
    };

    // 1. Full rejection → send for repair.
    const A = await mkPo();
    const s0 = await stockOf(inv);
    let r = await call('POST', `/api/purchase-orders/${A.po}/items/${A.it}/qc`, { result: 'rejected', rejection_action: 'repair', rejection_reason: 'threads damaged', rejected_qty: 10 });
    const it = await q1('SELECT received, qc_status, repair_sent_at, repair_reason, qty, amount::float FROM purchase_order_items WHERE id=$1', [A.it]);
    const po = await q1('SELECT delivery_status FROM purchase_orders WHERE id=$1', [A.po]);
    const dn = await q1('SELECT COUNT(*)::int n FROM purchase_debit_notes WHERE po_id=$1', [A.po]);
    ok('1a. repair: item un-received, marked out for repair, qc not recorded',
      r.status === 200 && r.body.repaired === true && it.received === false && it.qc_status == null && !!it.repair_sent_at && it.repair_reason === 'threads damaged', `${r.status} ${JSON.stringify(it)}`);
    ok('1b. no debit note is raised', dn.n === 0, JSON.stringify(dn));
    ok('1c. the PO goes back to awaiting receipt (purchase_accepted)', po.delivery_status === 'purchase_accepted', po.delivery_status);
    ok('1d. no stock was added', (await stockOf(inv)) === s0, `${s0} -> ${await stockOf(inv)}`);
    const rejPhoto = await q1('SELECT COUNT(*)::int n FROM purchase_item_rejection_photos WHERE item_id=$1', [A.it]);
    ok('1e. the rejection photo is kept as the record', rejPhoto.n === 1, JSON.stringify(rejPhoto));

    // 2. The item can be received and QC'd again when it returns.
    await client.query("UPDATE purchase_order_items SET received=TRUE, received_at=NOW() WHERE id=$1", [A.it]);
    await client.query("UPDATE purchase_orders SET delivery_status='qc_pending' WHERE id=$1", [A.po]);
    r = await call('POST', `/api/purchase-orders/${A.po}/items/${A.it}/qc`, { result: 'approved', weight_10: 1, received_qty: 10 });
    const it2 = await q1('SELECT qc_status FROM purchase_order_items WHERE id=$1', [A.it]);
    ok('2. received and QC-approved again on return → stock added', r.status === 200 && it2.qc_status === 'approved' && (await stockOf(inv)) === s0 + 10, `${r.status} ${it2.qc_status} stock ${await stockOf(inv)}`);

    // 3. A full rejection with debit note (default) still raises one, no repair mark.
    const B = await mkPo();
    r = await call('POST', `/api/purchase-orders/${B.po}/items/${B.it}/qc`, { result: 'rejected', rejection_action: 'debit_note', rejection_reason: 'bent', rejected_qty: 10 });
    const bi = await q1('SELECT received, qc_status, repair_sent_at FROM purchase_order_items WHERE id=$1', [B.it]);
    const bdn = await q1('SELECT COUNT(*)::int n FROM purchase_debit_notes WHERE po_id=$1', [B.po]);
    ok('3. debit-note path unchanged: item stays rejected, a debit note opens, no repair mark', r.status === 200 && bi.qc_status === 'rejected' && bdn.n === 1 && !bi.repair_sent_at, `${r.status} ${JSON.stringify(bi)} dn ${bdn.n}`);
  } catch (e) { failed = true; console.error('ERROR', e); }
  finally {
    await client.query('ROLLBACK'); client.release(); server.close(); await realPool.end();
    console.log(failed ? '\nSOME CHECKS FAILED (rolled back)' : '\nALL PASS (rolled back — nothing kept)');
    process.exit(failed ? 1 : 0);
  }
  async function stockOf(id) { return Number((await q1('SELECT current_stock FROM inventory_items WHERE id=$1', [id])).current_stock); }
})().catch(e => { console.error(e); process.exit(1); });
