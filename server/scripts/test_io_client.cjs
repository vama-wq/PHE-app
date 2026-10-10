// Test: an Inventory Order's client is always IO and its type never changes;
// client IO is for Inventory Orders only (owner, 10 Oct 2026). Rolled back.
//   node scripts/test_io_client.cjs
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
  dbmod.logActivity = async (orderId, jc, type, desc) => { logs.push({ orderId, jc, type, desc }); };
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
  let actor = owner;
  const auth = require(S + '/src/middleware/auth.js');
  auth.authenticate = (req, res, next) => { req.user = actor; next(); };
  const express = require(S + '/node_modules/express');
  const app = express(); app.use(express.json());
  app.use('/api/orders', require(S + '/src/routes/orders.js'));
  app.use('/api/job-cards', require(S + '/src/routes/jobCards.js'));
  app.use('/api/dispatch', require(S + '/src/routes/dispatch.js'));
  const server = app.listen(0); const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, url, body, as = owner) => { actor = as; const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) }); actor = owner; return { status: r.status, body: await r.json().catch(() => ({})) }; };
  try {
    const io = await q1(`SELECT id FROM customers WHERE UPPER(customer_code)='IO' ORDER BY id LIMIT 1`);
    const other = await q1(`SELECT id FROM customers WHERE UPPER(customer_code) <> 'IO' ORDER BY id LIMIT 1`);
    if (!io || !other) { ok('Database has the IO customer and one other', false); return; }
    let r = await call('POST', '/api/orders', { order_code: 'ZZT-IO-1', customer_id: other.id, order_date: '2026-10-10', order_type: 'inventory_order' });
    ok('1. an Inventory Order saved with another client is saved with client IO', r.status === 201 && (await q1('SELECT customer_id c FROM orders WHERE id=$1', [r.body.id])).c === io.id, JSON.stringify(r.body));
    r = await call('POST', '/api/orders', { order_code: 'ZZT-IO-2', order_date: '2026-10-10', order_type: 'inventory_order' });
    ok('1. with no client at all, also IO', r.status === 201 && (await q1('SELECT customer_id c FROM orders WHERE id=$1', [r.body.id])).c === io.id, JSON.stringify(r.body));
    r = await call('POST', '/api/orders', { order_code: 'ZZT-IO-3', customer_id: io.id, order_date: '2026-10-10', order_type: 'local_he' });
    ok('2. client IO on a Local HE order is refused', r.status === 400 && r.body.code === 'IO_CLIENT_ONLY_FOR_IO', JSON.stringify(r.body));
    r = await call('POST', '/api/orders', { order_code: 'ZZT-IO-4', customer_id: io.id, order_date: '2026-10-10', order_type: 'io_export_he' });
    ok('2. …and on an IO + Export combo (it needs its real client)', r.status === 400 && r.body.code === 'IO_CLIENT_ONLY_FOR_IO', JSON.stringify(r.body));
    r = await call('POST', '/api/orders', { order_code: 'ZZT-IO-5', order_date: '2026-10-10', order_type: 'local_he' });
    ok('2. a Local HE order still needs a client', r.status === 400 && /Customer is required/.test(r.body.error || ''), JSON.stringify(r.body));
    r = await call('POST', '/api/orders', { order_code: 'ZZT-IO-6', customer_id: other.id, order_date: '2026-10-10', order_type: 'local_he' });
    ok('2. a Local HE order with a real client saves as before', r.status === 201, JSON.stringify(r.body));
    const loc = r.body.id;
    const inv = (await q1(`SELECT id FROM orders WHERE order_code='ZZT-IO-1'`)).id;
    await client.query("UPDATE orders SET status='rejected' WHERE id = ANY($1)", [[loc, inv]]);
    r = await call('PUT', `/api/orders/${inv}`, { notes: 'x', order_type: 'local_he' });
    ok('3. a rejected Inventory Order cannot be changed to another type', r.status === 400 && r.body.code === 'IO_TYPE_FIXED' && (await q1('SELECT order_type t FROM orders WHERE id=$1', [inv])).t === 'inventory_order', JSON.stringify(r.body));
    r = await call('PUT', `/api/orders/${loc}`, { notes: 'x', order_type: 'inventory_order' });
    ok('3. another order cannot be changed into an Inventory Order', r.status === 400 && r.body.code === 'IO_TYPE_FIXED' && (await q1('SELECT order_type t FROM orders WHERE id=$1', [loc])).t === 'local_he', JSON.stringify(r.body));
    r = await call('PUT', `/api/orders/${inv}`, { notes: 'kept', order_type: 'inventory_order' });
    ok('3. editing a rejected Inventory Order without changing its type still works', r.status === 200 && (await q1('SELECT notes n FROM orders WHERE id=$1', [inv])).n === 'kept', JSON.stringify(r.body));
    r = await call('PUT', `/api/orders/${loc}`, { notes: 'x', order_type: 'export_he' });
    ok('3. Local HE → Export HE on a rejected order still works', r.status === 200 && (await q1('SELECT order_type t FROM orders WHERE id=$1', [loc])).t === 'export_he', JSON.stringify(r.body));
  } catch (e) { failed = true; console.error('ERROR', e); }
  finally {
    await client.query('ROLLBACK'); client.release(); server.close(); await realPool.end();
    console.log(failed ? '\nSOME CHECKS FAILED (rolled back)' : '\nALL PASS (rolled back — nothing kept)');
    process.exit(failed ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
