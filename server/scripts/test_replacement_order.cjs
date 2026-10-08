// Test: a replacement is a NEW ORDER (owner, 8 Oct 2026). The query gives a
// pre-filled draft; saving the order (POST /orders with replacement_query_id)
// closes the query as "Replacement issued — ORD-xxx"; the order's job cards end
// in -RPL; they dispatch without an invoice. Rolled back — nothing kept.
//   node scripts/test_replacement_order.cjs
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
  app.use('/api/customer-queries', require(S + '/src/routes/customerQueries.js'));
  app.use('/api/orders', require(S + '/src/routes/orders.js'));
  app.use('/api/job-cards', require(S + '/src/routes/jobCards.js'));
  app.use('/api/dispatch', require(S + '/src/routes/dispatch.js'));
  const server = app.listen(0); const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, url, body, as = owner) => { actor = as; const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) }); actor = owner; return { status: r.status, body: await r.json().catch(() => ({})) }; };
  try {
    const cols = (await client.query(`SELECT COUNT(*)::int n FROM information_schema.columns WHERE (table_name='orders' AND column_name='replacement_query_id') OR (table_name='customer_queries' AND column_name='replacement_order_id')`)).rows[0].n;
    if (cols < 2) { ok('Database ready (orders.replacement_query_id, customer_queries.replacement_order_id)', false, `${cols}/2`); return; }
    const admin = { id: owner.id, name: 'ZZTEST Admin', role: 'admin' };
    const cust = (await q1('SELECT MIN(id) AS id FROM customers')).id;
    const o = (await q1(`INSERT INTO orders (order_code, customer_id, order_date, order_type, status) VALUES ('ZZT-RPL-O',$1,CURRENT_DATE,'local_he','customer_query') RETURNING id`, [cust])).id;
    const oi = (await q1(`INSERT INTO order_items (order_id, quantity, drawing_number, product_code, wattage, voltage, remark) VALUES ($1,50,'ZZTEST-DWG-RPL','ZZTEST-PC',500,230,'ZZTEST remark') RETURNING id`, [o])).id;
    const jc = (await q1(`INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, dispatched_at) VALUES ('ZZT-RPL-1',$1,$2,3,'customer_query',CURRENT_DATE,NOW()) RETURNING id`, [o, oi])).id;
    const q = (await q1(`INSERT INTO customer_queries (query_no, order_id, job_card_id, subject, assigned_department, status, created_by, qty) VALUES ('ZZT-CQ-RPL',$1,$2,'ZZTEST leak','production','open',$3,3) RETURNING id`, [o, jc, owner.id])).id;

    let r = await call('GET', `/api/customer-queries/${q}/replacement-draft`, null, admin);
    ok('1. the admin gets a pre-filled draft: same customer and type, the item with the 3 pieces that came back, as a reuse of the returned item',
      r.status === 200 && r.body.form.customer_id === cust && r.body.form.order_type === 'local_he' && r.body.items[0]?.quantity === 3
      && r.body.items[0]?.drawing_number === 'ZZTEST-DWG-RPL' && r.body.items[0]?.copy_from_item_id === oi && r.body.replacement.query_no === 'ZZT-CQ-RPL', JSON.stringify(r.body).slice(0, 300));
    r = await call('PUT', `/api/customer-queries/${q}/resolve`, { resolution_type: 'replaced', resolution_summary: 'x' });
    ok('2. the old "clone a card" replacement is closed', r.status === 400 && r.body.code === 'REPLACEMENT_IS_AN_ORDER', JSON.stringify(r.body));
    r = await call('POST', '/api/orders', { order_code: 'ZZT-RPL-NEW', customer_id: cust, order_date: '2026-10-08', order_type: 'local_he', replacement_query_id: q, replacement_summary: 'Leaking — replace 3' }, admin);
    const newOrder = r.body.id;
    const qq = await q1('SELECT * FROM customer_queries WHERE id=$1', [q]);
    ok('3. saving the order closes the query: resolved, "replacement issued", linked both ways; the returned card reads Query Resolved',
      r.status === 201 && qq.status === 'resolved' && qq.return_status === 'replacement_issued' && qq.replacement_order_id === newOrder && /replacement order ZZT-RPL-NEW/.test(qq.resolution_summary)
      && (await q1('SELECT replacement_query_id r FROM orders WHERE id=$1', [newOrder])).r === q && (await q1('SELECT status FROM job_cards WHERE id=$1', [jc])).status === 'resolved_dispatched'
      && (await q1('SELECT status FROM orders WHERE id=$1', [o])).status === 'resolved_dispatched', JSON.stringify({ r: r.body, qq: { s: qq.status, rs: qq.return_status, ro: qq.replacement_order_id } }));
    ok('3. it goes for approval like any new order', (await q1('SELECT status FROM orders WHERE id=$1', [newOrder])).status === 'pending_approval');
    r = await call('POST', '/api/orders', { order_code: 'ZZT-RPL-NEW2', customer_id: cust, order_date: '2026-10-08', replacement_query_id: q }, admin);
    ok('4. a second replacement order for the same (now resolved) query is refused', r.status === 400, JSON.stringify(r.body));
    // A job card on the replacement order (the upload route, as a PDF card).
    const noi = (await q1(`INSERT INTO order_items (order_id, quantity, drawing_number) VALUES ($1,3,'ZZTEST-DWG-RPL') RETURNING id`, [newOrder])).id;
    await client.query("UPDATE orders SET status='approved' WHERE id=$1", [newOrder]);
    const nut = (await q1(`INSERT INTO inventory_items (item_code, name, unit, category, current_stock, unit_cost) VALUES ('ZZTEST-RPL-NUT','ZZTEST-RPL-NUT','pcs','Nut',100,1) RETURNING id`)).id;
    await client.query('INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty) VALUES ($1,$2,6)', [noi, nut]);
    const fd = new FormData();
    for (const [k, v] of Object.entries({ order_id: newOrder, order_item_id: noi, qty: 3, dispatch_date: '2026-10-20', job_card_no: 'ZZT-RPL-CARD', punching: 'ZZT-PUNCH' })) fd.append(k, String(v));
    fd.append('file', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'card.pdf');
    const up = await fetch(base + '/api/job-cards', { method: 'POST', body: fd, signal: AbortSignal.timeout(30000) });
    const upb = await up.json().catch(() => ({}));
    const card = await q1('SELECT * FROM job_cards WHERE order_id=$1 ORDER BY id DESC LIMIT 1', [newOrder]);
    ok('5. the replacement order\'s job card ends in -RPL', !!card && /-RPL$/.test(card.job_card_no), `${up.status} ${JSON.stringify(upb).slice(0, 200)} ${card?.job_card_no}`);
    if (card) {
      await client.query("UPDATE job_cards SET status='qc_approved', product_qc_at=NOW(), inventory_qc_at=NOW(), qc_route='dispatch', qc_dispatch_qty=3 WHERE id=$1", [card.id]);
      r = await call('PUT', `/api/dispatch/${card.id}/mark-dispatched`, {});
      ok('6. it dispatches without an invoice', r.status === 200 && (await q1('SELECT status FROM job_cards WHERE id=$1', [card.id])).status === 'dispatched', JSON.stringify(r.body));
    }
    const ord = await q1(`INSERT INTO orders (order_code, customer_id, order_date, order_type, status) VALUES ('ZZT-RPL-PLAIN',$1,CURRENT_DATE,'local_he','approved') RETURNING id`, [cust]);
    const poi = (await q1(`INSERT INTO order_items (order_id, quantity) VALUES ($1,2) RETURNING id`, [ord.id])).id;
    const pc = (await q1(`INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, product_qc_at, inventory_qc_at, qc_route, qc_dispatch_qty) VALUES ('ZZT-RPL-PLAIN-1',$1,$2,2,'qc_approved',CURRENT_DATE,NOW(),NOW(),'dispatch',2) RETURNING id`, [ord.id, poi])).id;
    r = await call('PUT', `/api/dispatch/${pc}/mark-dispatched`, {});
    ok('7. an ordinary order still needs its invoice', r.status === 400 && /invoice/i.test(r.body.error || ''), JSON.stringify(r.body));
  } catch (e) { failed = true; console.error('ERROR', e); }
  finally {
    await client.query('ROLLBACK'); client.release(); server.close(); await realPool.end();
    console.log(failed ? '\nSOME CHECKS FAILED (rolled back)' : '\nALL PASS (rolled back — nothing kept)');
    process.exit(failed ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
