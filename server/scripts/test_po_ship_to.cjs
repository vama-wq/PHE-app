// Test: Ship To on a purchase order (owner, 30 Oct 2026: "billing is me but
// shipping address is another company"). A PO can carry the company the
// supplier delivers to — name and address required, GSTIN and contact
// optional; none means "to us", as before. Editing a draft keeps, changes or
// clears it. Rolled back — nothing kept.
//   node scripts/test_po_ship_to.cjs
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
  const q1 = async (q, p = []) => (await client.query(q, p)).rows[0];
  let failed = false;
  const ok = (label, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  ' + String(extra).slice(0, 300) : '')); if (!cond) failed = true; };
  process.on('unhandledRejection', (e) => { failed = true; console.error('ROUTE ERROR (unhandled):', e); });
  const owner = await q1("SELECT id, name, role FROM users WHERE role='owner' ORDER BY id LIMIT 1");
  const auth = require(S + '/src/middleware/auth.js');
  auth.authenticate = (req, res, next) => { req.user = owner; next(); };
  const notif = require(S + '/src/routes/notifications.js');
  notif.createNotification = async () => {};
  const express = require(S + '/node_modules/express');
  const app = express();
  app.use(express.json());
  app.use('/api/purchase-orders', require(S + '/src/routes/purchaseOrders.js'));
  const server = app.listen(0);
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  try {
    const col = await q1(`SELECT 1 AS x FROM information_schema.columns WHERE table_name='purchase_orders' AND column_name='ship_to'`);
    if (!col) { ok('purchase_orders.ship_to exists', false); return; }
    const sup = (await q1('SELECT MIN(id) AS id FROM suppliers')).id;
    const item = (await q1(`INSERT INTO inventory_items (item_code, name, unit, category, current_stock, unit_cost) VALUES ('ZZTEST-SHIP','ZZTEST-SHIP','pcs','Nut',0,1) RETURNING id`)).id;
    const body = (extra = {}) => ({ supplier_id: sup, igst_percent: 18, transport_charges: 0, notes: 'ZZTEST',
      items: [{ inventory_item_id: item, description: 'ZZTEST nut', unit: 'pcs', qty: 10, rate: 2, amount: 20 }], ...extra });
    const shipTo = { name: ' ABC Industries Pvt Ltd ', address: 'Plot 12, GIDC Naroda\nAhmedabad 382330', gstin: '24abcde1234f1z5', contact: 'Rakesh Bhai, 98250 00000' };

    let r = await call('POST', '/api/purchase-orders', body({ ship_to: shipTo }));
    const A = r.body.id;
    let po = A ? (await call('GET', `/api/purchase-orders/${A}`)).body : {};
    ok('1. a PO made with a Ship To keeps it — name trimmed, GSTIN in capitals, address lines kept',
      r.status === 200 && po.ship_to?.name === 'ABC Industries Pvt Ltd' && po.ship_to?.address === 'Plot 12, GIDC Naroda\nAhmedabad 382330'
      && po.ship_to?.gstin === '24ABCDE1234F1Z5' && po.ship_to?.contact === 'Rakesh Bhai, 98250 00000', JSON.stringify({ s: r.status, st: po.ship_to }));
    r = await call('POST', '/api/purchase-orders', body({ ship_to: { name: 'Only a name', address: '  ' } }));
    ok('2. a Ship To without its address is refused', r.status === 400 && /company name and its address/.test(r.body.error || ''), JSON.stringify(r.body));
    r = await call('POST', '/api/purchase-orders', body());
    po = r.body.id ? (await call('GET', `/api/purchase-orders/${r.body.id}`)).body : {};
    ok('3. a PO with no Ship To delivers to us, as before (none stored)', r.status === 200 && po.ship_to == null, JSON.stringify({ s: r.status, st: po.ship_to }));
    r = await call('POST', '/api/purchase-orders', body({ ship_to: { name: '', address: '', gstin: '', contact: '' } }));
    po = r.body.id ? (await call('GET', `/api/purchase-orders/${r.body.id}`)).body : {};
    ok('4. an all-blank Ship To counts as none', r.status === 200 && po.ship_to == null, JSON.stringify({ s: r.status, st: po.ship_to }));

    const status = (await q1('SELECT status FROM purchase_orders WHERE id=$1', [A])).status;
    if (!['draft', 'rejected'].includes(status)) await client.query("UPDATE purchase_orders SET status='draft' WHERE id=$1", [A]);
    r = await call('PUT', `/api/purchase-orders/${A}`, body());
    po = (await call('GET', `/api/purchase-orders/${A}`)).body;
    ok('5. editing a draft without sending Ship To keeps it', r.status === 200 && po.ship_to?.name === 'ABC Industries Pvt Ltd', JSON.stringify({ s: r.status, st: po.ship_to }));
    r = await call('PUT', `/api/purchase-orders/${A}`, body({ ship_to: { ...shipTo, name: 'XYZ Engineering' } }));
    po = (await call('GET', `/api/purchase-orders/${A}`)).body;
    ok('6. editing it to another company changes it', r.status === 200 && po.ship_to?.name === 'XYZ Engineering', JSON.stringify({ s: r.status, st: po.ship_to }));
    r = await call('PUT', `/api/purchase-orders/${A}`, body({ ship_to: null }));
    po = (await call('GET', `/api/purchase-orders/${A}`)).body;
    ok('7. unticking it clears it — back to delivering to us', r.status === 200 && po.ship_to == null, JSON.stringify({ s: r.status, st: po.ship_to }));
  } catch (e) { failed = true; console.error('ERROR', e); }
  finally {
    await client.query('ROLLBACK'); client.release(); server.close(); await realPool.end();
    console.log(failed ? '\nSOME CHECKS FAILED (rolled back)' : '\nALL PASS (rolled back — nothing kept)');
    process.exit(failed ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
