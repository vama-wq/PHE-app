// Test: stock held for open orders, shown beside the free figure in the pickers
// (owner, 10 Oct 2026) — display only. Rolled back — nothing kept.
//   node scripts/test_stock_holds.cjs
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
  app.use('/api/inventory', require(S + '/src/routes/inventory.js'));
  app.use('/api/job-cards', require(S + '/src/routes/jobCards.js'));
  app.use('/api/dispatch', require(S + '/src/routes/dispatch.js'));
  const server = app.listen(0); const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, url, body, as = owner) => { actor = as; const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) }); actor = owner; return { status: r.status, body: await r.json().catch(() => ({})) }; };
  try {
    const cust = (await q1(`SELECT MIN(id) AS id FROM customers WHERE UPPER(customer_code) <> 'IO'`)).id;
    const X = (await q1(`INSERT INTO inventory_items (item_code, name, unit, category, current_stock, unit_cost) VALUES ('ZZTEST-HOLD-X','ZZTEST-HOLD-X','pcs','Nut',100,1) RETURNING id`)).id;
    const mkOrder = async (code, status = 'in_progress') => (await q1(`INSERT INTO orders (order_code, customer_id, order_date, order_type, status) VALUES ($1,$2,CURRENT_DATE,'local_he',$3) RETURNING id`, [code, cust, status])).id;
    const mkItem = async (o, qty) => (await q1(`INSERT INTO order_items (order_id, quantity, drawing_number) VALUES ($1,$2,'ZZTEST-DWG-HOLD') RETURNING id`, [o, qty])).id;
    const oA = await mkOrder('ZZT-HOLD-A'); const iA = await mkItem(oA, 10);
    await client.query('INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty, qty_deducted, qty_waived) VALUES ($1,$2,40,10,5)', [iA, X]);
    const oB = await mkOrder('ZZT-HOLD-B'); const iB = await mkItem(oB, 10);
    await client.query('INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty, qty_deducted, rework_qty, rework_deducted) VALUES ($1,$2,30,0,8,2)', [iB, X]);
    const oC = await mkOrder('ZZT-HOLD-C', 'dispatched'); const iC = await mkItem(oC, 10);
    await client.query('INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty, qty_deducted) VALUES ($1,$2,50,0)', [iC, X]);
    const oD = await mkOrder('ZZT-HOLD-D'); const iD = await mkItem(oD, 10);
    await client.query('INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty, qty_deducted) VALUES ($1,$2,50,0)', [iD, X]);
    await client.query('UPDATE order_items SET inventory_deducted=TRUE WHERE id=$1', [iD]);
    const r = await call('GET', '/api/inventory');
    const it = (r.body || []).find(i => i.id === X);
    const byA = it?.held_by?.find(h => h.order_id === oA), byB = it?.held_by?.find(h => h.order_id === oB);
    ok('1. held = what open lists still have to take: A 40 − 10 taken − 5 settled = 25; B 30 less the 6 still to come from the rework bin = 24; 49 in all',
      r.status === 200 && it && it.held_qty === 49 && byA?.qty === 25 && byB?.qty === 24, JSON.stringify(it && { held: it.held_qty, by: it.held_by }));
    ok('2. a dispatched order and a settled item hold nothing', it && !it.held_by.some(h => h.order_id === oC || h.order_id === oD), JSON.stringify(it?.held_by));
    ok('3. stock itself is untouched (display only)', it && Number(it.current_stock) === 100);
  } catch (e) { failed = true; console.error('ERROR', e); }
  finally {
    await client.query('ROLLBACK'); client.release(); server.close(); await realPool.end();
    console.log(failed ? '\nSOME CHECKS FAILED (rolled back)' : '\nALL PASS (rolled back — nothing kept)');
    process.exit(failed ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
