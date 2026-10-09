// Test: made wrongly in production → replacement order (owner, 9 Oct 2026).
// The owner / admin marks a card (no customer query); it goes to Inventory QC
// with nothing more taken; QC done puts the pieces into Finished Goods under the
// name given (a 3in1 off its flange → single elements, one element's length for
// fins), closes the card and the order as Replaced and tells the owner and the
// admin; the replacement order is pre-filled with everything editable, its cards
// end in -RPL and its invoice IS needed to dispatch. Rolled back — nothing kept.
//   node scripts/test_made_wrongly.cjs
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
  app.use('/api/qc', require(S + '/src/routes/qc.js'));
  app.use('/api/dispatch', require(S + '/src/routes/dispatch.js'));
  const fgFifo = require(S + '/src/lib/fgFifo.js');
  const server = app.listen(0); const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, url, body, as = owner) => { actor = as; const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) }); actor = owner; return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const stock = async (id) => Number((await q1('SELECT current_stock FROM inventory_items WHERE id=$1', [id])).current_stock);
  try {
    const cols = (await q1(`SELECT COUNT(*)::int n FROM information_schema.columns WHERE (table_name='job_cards' AND column_name='replace_plan')
       OR (table_name='orders' AND column_name IN ('replacement_of_order_id','replaced_by_order_id')) OR (table_name='finished_goods_log' AND column_name='elements_per_piece')`)).n;
    const con = await q1(`SELECT pg_get_constraintdef(oid) LIKE '%replaced%' AS ok FROM pg_constraint WHERE conname='job_cards_status_check'`);
    if (cols < 4 || !con?.ok) { ok('Database ready (columns + the Replaced status)', false, `${cols}/4 ${con?.ok}`); return; }
    const admin = { id: owner.id, name: 'ZZTEST Admin', role: 'admin' };
    const floor = { id: owner.id, name: 'ZZTEST Floor', role: 'production' };
    const cust = (await q1('SELECT MIN(id) AS id FROM customers')).id;
    const o = (await q1(`INSERT INTO orders (order_code, customer_id, order_date, order_type, status, material_deduction) VALUES ('ZZT-MW-O',$1,CURRENT_DATE,'local_he','in_progress',TRUE) RETURNING id`, [cust])).id;
    const oi = (await q1(`INSERT INTO order_items (order_id, quantity, drawing_number, product_code, tube_material, tube_diameter, wattage, voltage, remark)
       VALUES ($1,2,'ZZTEST-DWG-MW-3in1','ZZTEST-PC','TUB-ZZTEST',8,2100,230,'ZZTEST remark') RETURNING id`, [o])).id;
    const NUT = (await q1(`INSERT INTO inventory_items (item_code, name, unit, category, current_stock, unit_cost) VALUES ('ZZTEST-MW-NUT','ZZTEST-MW-NUT','pcs','Nut',100,1) RETURNING id`)).id;
    const PIN = (await q1(`INSERT INTO inventory_items (item_code, name, unit, category, current_stock, unit_cost) VALUES ('ZZTEST-MW-PIN','ZZTEST-MW-PIN','pcs','Terminal Pin',100,1) RETURNING id`)).id;
    await client.query('INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty, qty_deducted) VALUES ($1,$2,8,0)', [oi, NUT]);
    const spec = JSON.stringify({ computed: { cuttingLengthMm: 1600, totalLengthMm: 1948, elements: 3 } });
    const jc = (await q1(`INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, drawing_no, generated_spec)
       VALUES ('ZZT-MW-1',$1,$2,2,'in_progress',CURRENT_DATE,'ZZTEST-DWG-MW-3in1',$3) RETURNING id`, [o, oi, spec])).id;

    let r = await call('POST', `/api/job-cards/${jc}/replace`, { reason: 'x', mode: 'finished_goods', fg_name: 'A', fg_qty: 6 }, floor);
    ok('1. production cannot mark a card made wrongly', r.status === 403, `${r.status}`);
    r = await call('POST', `/api/job-cards/${jc}/replace`, { mode: 'finished_goods', fg_name: 'A', fg_qty: 6 }, admin);
    ok('1. a reason is required', r.status === 400 && /what was made wrongly/.test(r.body.error || ''), JSON.stringify(r.body));
    const nut0 = await stock(NUT);
    r = await call('POST', `/api/job-cards/${jc}/replace`, { reason: 'made as 3in1 on the wrong flange', mode: 'finished_goods', fg_name: 'ZZTEST-PT-UType-38U-700W', fg_qty: 6, elements_per_piece: 1 }, admin);
    let c = await q1('SELECT * FROM job_cards WHERE id=$1', [jc]);
    ok('2. the admin marks it: off to Inventory QC, the plan kept (6 single elements, 2100 W ÷ 3 = 700 W each), nothing more taken from stock',
      r.status === 200 && c.status === 'inventory_qc' && c.qc_route === 'replaced' && Number(c.qc_fg_qty) === 6 && !!c.last_stage_taken_at
      && c.replace_plan?.fg_name === 'ZZTEST-PT-UType-38U-700W' && c.replace_plan?.fg_wattage === 700 && c.replace_plan?.elements_per_piece === 1
      && (await stock(NUT)) === nut0 && logs.some(l => l.type === 'made_wrongly'), `${r.status} ${JSON.stringify(r.body)}`);
    ok('2. the order reads QC pending while the card waits', (await q1('SELECT status FROM orders WHERE id=$1', [o])).status === 'qc_pending');
    r = await call('POST', `/api/job-cards/${jc}/replace`, { reason: 'again', mode: 'scrap' }, admin);
    ok('2. it cannot be marked twice', r.status === 400, JSON.stringify(r.body));
    r = await call('GET', `/api/qc/${jc}/inventory`);
    ok('3. Inventory QC sees the plan and can edit', r.status === 200 && r.body.editable === true && r.body.card.replace_plan?.fg_qty === 6, JSON.stringify(r.body.card || r.body).slice(0, 200));
    r = await call('POST', `/api/qc/${jc}/inventory/adjust`, { changes: [{ inventory_item_id: PIN, kind: 'take', qty: 6, note: 'spotted on' }] });
    ok('3. QC takes the 6 terminal pins really used', r.status === 200 && (await stock(PIN)) === 94, JSON.stringify(r.body));
    r = await call('PUT', `/api/qc/${jc}/inventory-done`, {});
    c = await q1('SELECT * FROM job_cards WHERE id=$1', [jc]);
    const fg = await q1(`SELECT * FROM finished_goods WHERE base_drawing_no='ZZTEST-PT-UType-38U-700W'`);
    const fl = fg ? await q1(`SELECT * FROM finished_goods_log WHERE finished_good_id=$1`, [fg.id]) : null;
    ok('4. Inventory QC done: the card is Replaced, 6 × ZZTEST-PT-UType-38U-700W (700 W) go into Finished Goods, the intake made on ZZT-MW-1 with 1 element a piece',
      r.status === 200 && c.status === 'replaced' && !!c.inventory_qc_at && fg && Number(fg.qty_available) === 6 && Number(fg.wattage) === 700
      && fl?.job_card_no === 'ZZT-MW-1' && Number(fl.elements_per_piece) === 1 && /Replaced/.test(r.body.message || ''), `${r.status} ${JSON.stringify(r.body)} ${JSON.stringify(fg)}`);
    ok('4. the order is Replaced; the owner is told to start the replacement order',
      (await q1('SELECT status FROM orders WHERE id=$1', [o])).status === 'replaced'
      && Number((await q1(`SELECT COUNT(*) n FROM notifications WHERE type='replacement_needed' AND link=$1 AND user_id=$2`, [`/orders/${o}`, owner.id])).n) >= 1);
    const ln = await q1('SELECT qty_deducted::float d, COALESCE(qty_waived,0)::float w FROM order_item_inventory WHERE order_item_id=$1 AND inventory_item_id=$2', [oi, NUT]);
    ok('4. the item settles without taking the nuts never fitted', (await q1('SELECT inventory_deducted f FROM order_items WHERE id=$1', [oi])).f === true
      && ln.d === 0 && ln.w === 8 && (await stock(NUT)) === nut0, JSON.stringify(ln));
    const lens = await fgFifo.intakeLengths(txDb, fg.id);
    ok('5. a store piece from it goes by ONE element\'s length (1948 mm), not the 3in1\'s 5844 mm', lens.mmFor({ job_card_no: 'ZZT-MW-1', elements_per_piece: 1 }) === 1948 && lens.avg === 1948, JSON.stringify({ a: lens.mmFor({ job_card_no: 'ZZT-MW-1', elements_per_piece: 1 }), avg: lens.avg }));
    r = await call('GET', `/api/orders/${o}/replacement-draft`, null, admin);
    ok('6. the replacement draft: same customer, the item with every field open (nothing reused or locked), made-wrongly note',
      r.status === 200 && r.body.form.customer_id === cust && r.body.items[0]?.drawing_number === 'ZZTEST-DWG-MW-3in1' && r.body.items[0]?.quantity === 2
      && r.body.items[0].copy_from_item_id === undefined && /made wrongly/.test(r.body.form.notes) && r.body.replacement_of.order_code === 'ZZT-MW-O', JSON.stringify(r.body).slice(0, 300));
    r = await call('POST', '/api/orders', { order_code: 'ZZT-MW-NEW', customer_id: cust, order_date: '2026-10-09', order_type: 'local_he', replacement_of_order_id: o }, admin);
    const n = r.body.id;
    ok('7. saving it links both ways; it goes for approval like any order',
      r.status === 201 && (await q1('SELECT replacement_of_order_id x, status FROM orders WHERE id=$1', [n])).x === o
      && (await q1('SELECT replaced_by_order_id x FROM orders WHERE id=$1', [o])).x === n
      && (await q1('SELECT status FROM orders WHERE id=$1', [n])).status === 'pending_approval', JSON.stringify(r.body));
    r = await call('POST', '/api/orders', { order_code: 'ZZT-MW-NEW2', customer_id: cust, order_date: '2026-10-09', replacement_of_order_id: o }, admin);
    ok('7. a second replacement order is refused', r.status === 400 && /already has its replacement/.test(r.body.error || ''), JSON.stringify(r.body));
    r = await call('GET', `/api/orders/${o}`);
    const r2 = await call('GET', `/api/orders/${n}`);
    ok('7. each order page names the other', r.body.replaced_by_code === 'ZZT-MW-NEW' && r2.body.replacement_of_code === 'ZZT-MW-O', `${r.body.replaced_by_code} ${r2.body.replacement_of_code}`);
    const noi = (await q1(`INSERT INTO order_items (order_id, quantity, drawing_number) VALUES ($1,2,'ZZTEST-DWG-MW-RIGHT') RETURNING id`, [n])).id;
    await client.query("UPDATE orders SET status='approved' WHERE id=$1", [n]);
    await client.query('INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty) VALUES ($1,$2,4)', [noi, NUT]);
    const fd = new FormData();
    for (const [k, v] of Object.entries({ order_id: n, order_item_id: noi, qty: 2, dispatch_date: '2026-10-20', job_card_no: 'ZZT-MW-CARD', punching: 'ZZT-PUNCH' })) fd.append(k, String(v));
    fd.append('file', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'card.pdf');
    const up = await fetch(base + '/api/job-cards', { method: 'POST', body: fd, signal: AbortSignal.timeout(30000) });
    const upb = await up.json().catch(() => ({}));
    const card = await q1('SELECT * FROM job_cards WHERE order_id=$1 ORDER BY id DESC LIMIT 1', [n]);
    ok('8. the replacement order\'s job card ends in -RPL', !!card && /-RPL$/.test(card.job_card_no), `${up.status} ${JSON.stringify(upb).slice(0, 200)} ${card?.job_card_no}`);
    if (card) {
      await client.query("UPDATE job_cards SET status='qc_approved', product_qc_at=NOW(), inventory_qc_at=NOW(), qc_route='dispatch', qc_dispatch_qty=2 WHERE id=$1", [card.id]);
      r = await call('PUT', `/api/dispatch/${card.id}/mark-dispatched`, {});
      ok('9. its invoice IS needed to dispatch (made wrongly in production, not a customer query)', r.status === 400 && /invoice/i.test(r.body.error || ''), JSON.stringify(r.body));
    }
    const jc2 = (await q1(`INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date) VALUES ('ZZT-MW-2',$1,$2,1,'qc_approved',CURRENT_DATE) RETURNING id`, [o, oi])).id;
    r = await call('POST', `/api/job-cards/${jc2}/replace`, { reason: 'x', mode: 'scrap' }, admin);
    ok('10. a card already through QC cannot be marked here', r.status === 400 && /only a card still in production/.test(r.body.error || ''), JSON.stringify(r.body));
  } catch (e) { failed = true; console.error('ERROR', e); }
  finally {
    await client.query('ROLLBACK'); client.release(); server.close(); await realPool.end();
    console.log(failed ? '\nSOME CHECKS FAILED (rolled back)' : '\nALL PASS (rolled back — nothing kept)');
    process.exit(failed ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
