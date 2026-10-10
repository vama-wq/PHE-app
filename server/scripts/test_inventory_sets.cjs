// Test: items bought as a set (owner, 10 Oct 2026) — a heavy terminal pin PO
// line, at purchase QC, also puts 1 HV nut and 2 HV washers per piece into
// their own stock at ₹0. Rolled back — nothing kept.
//   node scripts/test_inventory_sets.cjs
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
  upload.uploadPurchaseItemQCFields = [(req, res, next) => { req.files = { image: [{ storagePath: 'test/qc.jpg', originalname: 'qc.jpg' }],
    rejection_photos: [{ storagePath: 'test/rej.jpg', originalname: 'rej.jpg' }] }; next(); }];
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
    const tbl = await q1(`SELECT 1 AS x FROM information_schema.tables WHERE table_name='inventory_set_components'`);
    if (!tbl || !owner) { ok('Database ready: inventory_set_components exists and an owner user exists', false); return; }
    const stock = async (id) => Number((await q1('SELECT current_stock FROM inventory_items WHERE id=$1', [id])).current_stock);
    const mk = async (code, s, cost) => (await q1(`INSERT INTO inventory_items (item_code, name, unit, category, current_stock, unit_cost) VALUES ($1,$1,'pcs','Heavy Terminal Pin',$2,$3) RETURNING id`, [code, s, cost])).id;
    const PIN = await mk('ZZTEST-SET-PIN', 100, 5), NUT = await mk('ZZTEST-SET-NUT', 1000, 0), WSH = await mk('ZZTEST-SET-WSH', 2000, 0);
    await client.query('INSERT INTO inventory_set_components (set_item_id, component_item_id, qty_per_set) VALUES ($1,$2,1),($1,$3,2)', [PIN, NUT, WSH]);
    const sup = (await q1('SELECT MIN(id) AS id FROM suppliers')).id;
    const mkPo = async (no, noStock, qty) => {
      const po = (await q1(
        `INSERT INTO purchase_orders (po_number, supplier_id, status, delivery_status, igst_percent, transport_charges, no_stock, received_at, created_by)
         VALUES ($1,$2,'approved','qc_pending',18,0,$3,NOW(),$4) RETURNING id`, [no, sup, noStock, owner.id])).id;
      const it = (await q1(
        `INSERT INTO purchase_order_items (po_id, inventory_item_id, description, unit, qty, rate, amount, received, received_at, billed_qty)
         VALUES ($1,$2,'ZZTEST heavy pin set','pcs',$3,6,$4,TRUE,NOW(),$5) RETURNING id`, [po, PIN, qty, qty * 6, qty])).id;
      return { po, it };
    };
    const A = await mkPo('ZZT-SET-A', false, 5000);
    let r = await call('GET', `/api/purchase-orders/${A.po}`);
    ok('1. the PO page knows the line is a set: 1 nut and 2 washers a piece', r.status === 200 && r.body.items?.[0]?.set_parts?.length === 2
      && r.body.items[0].set_parts.some(p => p.item_code === 'ZZTEST-SET-WSH' && p.per === 2), JSON.stringify(r.body.items?.[0]?.set_parts));
    const s0 = [await stock(PIN), await stock(NUT), await stock(WSH)];
    r = await call('POST', `/api/purchase-orders/${A.po}/items/${A.it}/qc`, { result: 'approved', weight_10: 1, received_qty: 5000 });
    ok('2. QC approves 5,000 sets: 5,000 pins, 5,000 nuts and 10,000 washers into stock',
      r.status === 200 && (await stock(PIN)) === s0[0] + 5000 && (await stock(NUT)) === s0[1] + 5000 && (await stock(WSH)) === s0[2] + 10000,
      `${r.status} ${JSON.stringify(r.body)} ${await stock(PIN)}/${await stock(NUT)}/${await stock(WSH)}`);
    const lots = await qa('SELECT item_id, qty_original::float q, unit_cost::float c FROM inventory_fifo_lots WHERE po_id=$1 ORDER BY item_id', [A.po]);
    ok('2. the set price stays on the pin (₹6); the nut and washer lots come in at ₹0, all tied to the PO',
      lots.length === 3 && lots.find(l => l.item_id === PIN)?.c === 6 && lots.find(l => l.item_id === NUT)?.c === 0 && lots.find(l => l.item_id === WSH)?.q === 10000, JSON.stringify(lots));
    ok('2. each part has its own "purchase in" line naming the PO',
      Number((await q1(`SELECT COUNT(*)::int n FROM inventory_transactions WHERE item_id = ANY($1) AND transaction_type='purchase_in' AND po_number='ZZT-SET-A'`, [[PIN, NUT, WSH]])).n) === 3);
    const B = await mkPo('ZZT-SET-B', false, 100);
    const s1 = [await stock(PIN), await stock(NUT), await stock(WSH)];
    r = await call('POST', `/api/purchase-orders/${B.po}/items/${B.it}/qc`, { result: 'partial', weight_10: 1, received_qty: 60, rejected_qty: 40, rejection_reason: 'bent', observations: 'x' });
    ok('3. partly approved (60 of 100): 60 pins, 60 nuts, 120 washers',
      r.status === 200 && (await stock(PIN)) === s1[0] + 60 && (await stock(NUT)) === s1[1] + 60 && (await stock(WSH)) === s1[2] + 120, `${r.status} ${JSON.stringify(r.body)}`);
    const C = await mkPo('ZZT-SET-C', true, 50);
    const s2 = [await stock(PIN), await stock(NUT), await stock(WSH)];
    r = await call('POST', `/api/purchase-orders/${C.po}/items/${C.it}/qc`, { result: 'approved', weight_10: 1, received_qty: 50 });
    ok('4. a "Don\'t add to inventory" PO adds none of the three', r.status === 200 && (await stock(PIN)) === s2[0] && (await stock(NUT)) === s2[1] && (await stock(WSH)) === s2[2], `${r.status}`);
    const s3 = [await stock(PIN), await stock(NUT), await stock(WSH)];
    r = await call('DELETE', `/api/purchase-orders/${A.po}`);
    ok('5. deleting the PO takes all three back out', r.status === 200 && (await stock(PIN)) === s3[0] - 5000 && (await stock(NUT)) === s3[1] - 5000 && (await stock(WSH)) === s3[2] - 10000, `${r.status} ${JSON.stringify(r.body)}`);
  } catch (e) { failed = true; console.error('ERROR', e); }
  finally {
    await client.query('ROLLBACK'); client.release(); server.close(); await realPool.end();
    console.log(failed ? '\nSOME CHECKS FAILED (rolled back)' : '\nALL PASS (rolled back — nothing kept)');
    process.exit(failed ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
