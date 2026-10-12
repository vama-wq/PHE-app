// Test: heater fittings on an Xin1 item (owner, 12 Oct 2026) — Pocket, Cap,
// Short Patti, Gasket, Thermostat. Kept only on a multi-element heater (never a
// finished-goods order); Design's list must hold each fitting's part; a fitting
// added later sends the list back to Design; a Pocket takes 1 more ring per
// heater at Brazing (and in the stock held, and through a split); a Cap makes the
// sleeve weight compulsory at Brazing. Rolled back — nothing kept.
//   node scripts/test_heater_fittings.cjs
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
  const server = app.listen(0); const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, url, body, as = owner) => { actor = as; const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) }); actor = owner; return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const stock = async (id) => Number((await q1('SELECT current_stock FROM inventory_items WHERE id=$1', [id])).current_stock);
  const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
  try {
    if (!(await q1(`SELECT 1 AS x FROM information_schema.columns WHERE table_name='order_items' AND column_name='fittings'`))) { ok('Database ready (order_items.fittings)', false); return; }
    const id = async (code) => (await q1('SELECT id FROM inventory_items WHERE item_code=$1', [code])).id;
    const B8 = await id('BRZ-08'), CAP = await id('FCP-MS-125'), MID = await id('FPT-MID-L'), SLV = await id('FPS-PVC-FMP');
    const SHORT = await id('FPT-SHORT-L'), GSK = await id('GSK-125-RD'), THM = await id('THM-IMP-110D'), NUT = await id('NUT-SS-M4-08');
    const floor = { id: owner.id, name: 'ZZTEST Floor', role: 'production' };
    const cust = (await q1(`SELECT MIN(id) AS id FROM customers WHERE UPPER(customer_code) <> 'IO'`)).id;
    const mkOrder = async (code, type) => (await q1(`INSERT INTO orders (order_code, customer_id, order_date, order_type, status, material_deduction) VALUES ($1,$2,CURRENT_DATE,$3,'in_progress',TRUE) RETURNING id`, [code, cust, type])).id;
    const o = await mkOrder('ZZT-FIT-O', 'local_he');
    const itemBody = (dwg, qty, fittings) => ({ product_code: 'PT-FlangeHe', drawing_number: dwg, tube_material: 'TUB-SS316-038-T06', tube_diameter: 8,
      wattage: 2000, voltage: 230, plating_instructions: 'Nickel Plating', quantity: qty, remark: '', fittings });
    const fitsOf = async (itemId) => (await q1('SELECT fittings FROM order_items WHERE id=$1', [itemId])).fittings;

    // 1. Saving the item.
    let r = await call('POST', `/api/orders/${o}/items`, itemBody('ZZTEST-FIT-38U-3in1', 4, ['cap', 'pocket', 'bogus', 'cap']));
    const A = r.body.id;
    ok('1a. a 3in1 item keeps its ticked fittings, in the dropdown\'s order; an unknown one is dropped', r.status === 201 && JSON.stringify(await fitsOf(A)) === '["pocket","cap"]', `${r.status} ${JSON.stringify(await fitsOf(A))}`);
    r = await call('POST', `/api/orders/${o}/items`, itemBody('ZZTEST-FIT-SINGLE', 3, ['pocket', 'gasket']));
    ok('1b. a single-element heater keeps no fittings', r.status === 201 && (await fitsOf(r.body.id)) == null, JSON.stringify(await fitsOf(r.body.id)));
    const fgO = await mkOrder('ZZT-FIT-FG', 'finished_goods');
    r = await call('POST', `/api/orders/${fgO}/items`, itemBody('ZZTEST-FIT-FG-3in1', 3, ['pocket']));
    ok('1c. a finished-goods order keeps no fittings (the heater is already built)', r.status === 201 && (await fitsOf(r.body.id)) == null, JSON.stringify(await fitsOf(r.body.id)));
    r = await call('GET', `/api/orders/customer/${cust}/previous-items`);
    ok('1d. "reuse a previous item" carries the fittings', (r.body || []).some(p => p.id === A && JSON.stringify(p.fittings) === '["pocket","cap"]'));

    // 2. Design's list must hold the Cap's three parts.
    const put = (itemId, rows) => call('PUT', `/api/orders/${o}/items/${itemId}/inventory`, { inventory_item_ids: rows.map(([i, q]) => ({ id: i, qty: q })) });
    r = await put(A, [[CAP, 4], [MID, 4], [NUT, 24]]);
    ok('2a. Cap ticked, list without a sleeve: refused, naming the sleeve', r.status === 400 && r.body.code === 'FITTINGS_PARTS_MISSING' && /Cap: Sleeve/.test(r.body.error) && !/Flange Cap/.test(r.body.error), `${r.status} ${r.body.error}`);
    r = await put(A, [[SLV, 4], [MID, 4], [NUT, 24]]);
    ok('2b. …without a flange cap: refused, naming it', r.status === 400 && /Cap: Flange Cap/.test(r.body.error), `${r.status} ${r.body.error}`);
    r = await put(A, [[CAP, 4], [MID, 4], [SLV, 4], [NUT, 24]]);
    ok('2c. Flange Cap + Flange Mid Patti + Sleeve: saved', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);

    // 3. A fitting added after the list was made sends it back to Design.
    const cur = await q1('SELECT * FROM order_items WHERE id=$1', [A]);
    r = await call('PUT', `/api/orders/${o}/items/${A}`, { ...itemBody(cur.drawing_number, cur.quantity, ['pocket', 'cap', 'gasket', 'short_patti', 'thermostat']) });
    let it = await q1('SELECT fittings, bom_review, bom_review_reason FROM order_items WHERE id=$1', [A]);
    ok('3a. Gasket, Short Patti and Thermostat added: kept, and the list goes back to Design naming the missing parts',
      r.status === 200 && it.fittings.length === 5 && it.bom_review === 'needed' && /Short Patti: Short Patti/.test(it.bom_review_reason) && /Gasket: Gasket/.test(it.bom_review_reason) && /Thermostat: Thermostat/.test(it.bom_review_reason),
      `${r.status} ${JSON.stringify(it)}`);
    r = await call('PUT', `/api/orders/${o}/items/${A}/bom-confirm`);
    ok('3b. Design cannot confirm the list until the parts are on it', r.status === 400 && r.body.code === 'FITTINGS_PARTS_MISSING', `${r.status} ${r.body.error}`);
    r = await put(A, [[CAP, 4], [MID, 4], [SLV, 4], [NUT, 24], [SHORT, 4], [GSK, 4], [THM, 4]]);
    ok('3c. with a short patti, a gasket and a thermostat added the list saves', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
    r = await call('PUT', `/api/orders/${o}/items/${A}`, { ...itemBody(cur.drawing_number, cur.quantity, undefined) });
    ok('3d. an older screen that sends no fittings leaves them as they were', r.status === 200 && (await fitsOf(A)).length === 5, JSON.stringify(await fitsOf(A)));

    // 4. Stock held for the item: 4 heaters × (3 × 2 + 1 pocket) = 28 rings.
    const { heldByOrders } = require(S + '/src/lib/stockHolds.js');
    const held = await heldByOrders(txDb);
    const h8 = (held.get ? held.get(B8) : held[B8]) || [];
    const mine = (Array.isArray(h8) ? h8 : h8.by || []).find(x => x.order_id === o);
    ok('4. the stock held for the order counts the pocket: 28 BRZ-08 (4 × (3 × 2 + 1))', mine && near(mine.qty, 28), JSON.stringify(h8).slice(0, 200));

    // 5. Brazing: a Cap needs the sleeve weight; the Pocket adds 1 ring a heater.
    const spec3 = JSON.stringify({ input: { tubeDiameterMm: 8 }, computed: { elements: 3 } });
    const card = (await q1(`INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, drawing_no, generated_spec) VALUES ('ZZT-FIT-A',$1,$2,4,'in_progress',CURRENT_DATE,'ZZTEST-FIT-38U-3in1',$3) RETURNING id`, [o, A, spec3])).id;
    const brazing = (extra) => JSON.stringify({ airPressure: 'pass', airPressureRemark: '', airCleaning: true, remark: '', ...extra });
    const s8 = await stock(B8);
    r = await call('PUT', `/api/job-cards/${card}/checklist/15`, { done: true, value1: brazing({}) }, floor);
    ok('5a. a Cap heater: Brazing refused without the sleeve weight, nothing taken', r.status === 400 && r.body.code === 'SLEEVE_WEIGHT_REQUIRED' && near(await stock(B8), s8), `${r.status} ${r.body.error}`);
    r = await call('PUT', `/api/job-cards/${card}/checklist/15`, { done: true, value1: brazing({ sleeveWeightG: 0 }) }, floor);
    ok('5b. a sleeve weight of 0 is refused too', r.status === 400 && r.body.code === 'SLEEVE_WEIGHT_REQUIRED', `${r.status}`);
    r = await call('PUT', `/api/job-cards/${card}/checklist/15`, { done: true, value1: brazing({ sleeveWeightG: 36 }) }, floor);
    const c = await q1('SELECT rings_taken FROM job_cards WHERE id=$1', [card]);
    const row = await q1('SELECT value1 FROM production_checklist WHERE job_card_id=$1 AND stage_no=15', [card]);
    ok('5c. with 36 g: Brazing done, the weight kept on the stage, and 28 BRZ-08 taken (4 × (3 × 2 + 1 pocket))',
      r.status === 200 && JSON.parse(row.value1).sleeveWeightG === 36 && near(await stock(B8), s8 - 28) && c.rings_taken?.qty === 28 && c.rings_taken?.pocket === 1,
      `${r.status} ${JSON.stringify(r.body).slice(0, 120)} ${s8}→${await stock(B8)} ${JSON.stringify(c.rings_taken)}`);
    const note = await q1(`SELECT notes FROM inventory_transactions WHERE job_card_id=$1 AND item_id=$2 AND source='brazing' ORDER BY id DESC LIMIT 1`, [card, B8]);
    ok('5d. the ledger line says how: 4 × (3 elements × 2 + 1 pocket)', /4 × \(3 elements × 2 \+ 1 pocket\)/.test(note?.notes || ''), note?.notes);

    // 6. A split after Brazing: the split heaters' rings (7 a heater) move with them.
    const { approveSplitRequest } = require(S + '/src/services/actions/splitRequests.js');
    const sr = (await q1(`INSERT INTO job_card_split_requests (job_card_id, qty, reason, status) VALUES ($1,1,'test','pending') RETURNING id`, [card])).id;
    const sres = await approveSplitRequest(txDb, { requestId: sr, actor: owner });
    const child = sres?.data?.childJobCardId ? await q1('SELECT rings_taken FROM job_cards WHERE id=$1', [sres.data.childJobCardId]) : null;
    const parent = await q1('SELECT rings_taken FROM job_cards WHERE id=$1', [card]);
    ok('6. 1 heater split off: it carries 7 rings, the main card 21', child?.rings_taken?.qty === 7 && parent.rings_taken?.qty === 21 && child.rings_taken.pocket === 1,
      JSON.stringify({ sres: sres?.ok, child: child?.rings_taken, parent: parent.rings_taken }));

    // 7. The job card carries the fittings for the floor; a heater without a Cap needs no weight.
    r = await call('GET', `/api/job-cards/${card}`);
    ok('7a. the job card shows the item\'s fittings', r.status === 200 && Array.isArray(r.body.fittings) && r.body.fittings.includes('pocket'), JSON.stringify(r.body.fittings));
    r = await call('POST', `/api/orders/${o}/items`, itemBody('ZZTEST-FIT-2in1', 2, ['pocket']));
    const P = r.body.id;
    const card2 = (await q1(`INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, drawing_no) VALUES ('ZZT-FIT-P',$1,$2,2,'in_progress',CURRENT_DATE,'ZZTEST-FIT-2in1') RETURNING id`, [o, P])).id;
    const s8b = await stock(B8);
    r = await call('PUT', `/api/job-cards/${card2}/checklist/15`, { done: true, value1: brazing({}) }, floor);
    ok('7b. a Pocket-only 2in1 (uploaded card): no sleeve weight asked, 10 rings taken (2 × (2 × 2 + 1))', r.status === 200 && near(await stock(B8), s8b - 10), `${r.status} ${r.body.error || ''} ${s8b}→${await stock(B8)}`);
  } catch (e) { failed = true; console.error('ERROR', e); }
  finally {
    await client.query('ROLLBACK'); client.release(); server.close(); await realPool.end();
    console.log(failed ? '\nSOME CHECKS FAILED (rolled back)' : '\nALL PASS (rolled back — nothing kept)');
    process.exit(failed ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
