// Test: the app-made Inventory Job Card of a Finished Goods order (owner,
// 13 Oct 2026) — the form's store choice and derived stamping, a card made with
// no file (fixture required), the printed sheet's contents, a card cut from
// another drawing's stock, and an attached file still taken as the card.
// Rolled back — nothing kept (store stock touched only inside the transaction).
//   node scripts/test_fg_card.cjs
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
  const uploads = {};
  const supa = require(S + '/node_modules/@supabase/supabase-js');
  supa.createClient = () => ({ storage: { from: (b) => ({
    upload: async (p, body) => { uploads[p] = Buffer.isBuffer(body) ? body.toString('utf8') : String(body); return { data: { path: p }, error: null }; },
    remove: async () => ({ data: [], error: null }), copy: async (f, t) => ({ data: { path: t }, error: null }),
    download: async () => ({ data: null, error: { message: 'stub' } }), getPublicUrl: (p) => ({ data: { publicUrl: `stub://${b}/${p}` } }) }) } });
  const wa = require(S + '/src/lib/whatsapp.js'); wa.queueWhatsApp = async () => {};
  const q1 = async (q, p = []) => (await client.query(q, p)).rows[0];
  let failed = false;
  const ok = (label, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  ' + String(extra).slice(0, 300) : '')); if (!cond) failed = true; };
  const owner = await q1("SELECT id, name, role FROM users WHERE role='owner' ORDER BY id LIMIT 1");
  const auth = require(S + '/src/middleware/auth.js');
  auth.authenticate = (req, res, next) => { req.user = owner; next(); };
  const express = require(S + '/node_modules/express');
  const app = express(); app.use(express.json());
  app.use('/api/orders', require(S + '/src/routes/orders.js'));
  app.use('/api/job-cards', require(S + '/src/routes/jobCards.js'));
  const server = app.listen(0); const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (fields, file) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
    if (file) fd.append('file', new Blob([file.body], { type: file.type }), file.name);
    const r = await fetch(base + '/api/job-cards/fg', { method: 'POST', body: fd, signal: AbortSignal.timeout(30000) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  try {
    if (!(await q1(`SELECT 1 AS x FROM information_schema.columns WHERE table_name='job_cards' AND column_name='fg_card'`))) { ok('Database ready (job_cards.fg_card)', false); return; }
    const row17 = await q1(`SELECT id, qty_available::float q FROM finished_goods WHERE COALESCE(base_drawing_no, drawing_no)='PT-UType-17U-750W'`);
    const row18 = await q1(`SELECT id, qty_available::float q FROM finished_goods WHERE COALESCE(base_drawing_no, drawing_no)='PT-UType-18U-750W'`);
    const cust = await q1(`SELECT id, customer_code FROM customers WHERE customer_code='PSI'`);
    const o = (await q1(`INSERT INTO orders (order_code, customer_id, order_date, order_type, status, material_deduction) VALUES ('ZZT-FGC-O',$1,'2026-10-01','finished_goods','approved',TRUE) RETURNING id`, [cust.id])).id;
    const it = (await q1(`INSERT INTO order_items (order_id, product_code, drawing_number, tube_material, tube_diameter, wattage, voltage, plating_instructions, quantity, remark)
       VALUES ($1,'PT-UType','PT-UType-17U-750W','TUB-SS304-038-T06',8,750,230,'No Plating',6,'Centre to Centre, No rust, Nut Washer') RETURNING id`, [o])).id;
    const nut = (await q1(`SELECT id FROM inventory_items WHERE item_code='NUT-SS-M4-08'`)).id;
    await client.query('INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty) VALUES ($1,$2,24)', [it, nut]);

    // 1. The form's choices.
    let r = await fetch(`${base}/api/orders/${o}/items/${it}/fg-plan?qty=4`).then(x => x.json());
    ok('1. the form lists the store stock with the item\'s own drawing first, and the stamping from its rating',
      r.default_store_id === row17.id && r.stores?.[0]?.id === row17.id && r.stores.some(s => s.id === row18.id) && r.stamping === 'BHA-750W-230V' && r.store?.id === row17.id,
      JSON.stringify({ d: r.default_store_id, first: r.stores?.[0], st: r.stamping }));

    // 2. No file and no fixture: refused.
    r = await post({ order_id: o, order_item_id: it, qty: 4, dispatch_date: '2026-10-20' });
    ok('2. with no file the fixture type is required', r.status === 400 && /Fixture/.test(r.body.error), `${r.status} ${r.body.error}`);

    // 3. The app makes the card.
    r = await post({ order_id: o, order_item_id: it, qty: 4, dispatch_date: '2026-10-20', fixture: 'Nut washer', stamping: '' });
    const card = r.body.id ? await q1('SELECT * FROM job_cards WHERE id=$1', [r.body.id]) : null;
    const html = card ? uploads[card.file_path] || '' : '';
    ok('3a. made with no file: the card exists, stock is taken (4 from 17U-750W), and its printable sheet is its file',
      r.status === 201 && !!card && card.is_fg && card.qty === 4 && !!card.file_name && card.fg_card?.generated === true
      && Number((await q1('SELECT qty_available FROM finished_goods WHERE id=$1', [row17.id])).qty_available) === row17.q - 4,
      `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    ok('3b. the sheet reads like the office one: INVENTORY ORDERS, client PSI, dates 01.10.26 / 20.10.26, product, drawing, stamping BHA-750W-230V, 4 Nos, the four boxes',
      ['INVENTORY ORDERS', '>PSI<', '01.10.26', '20.10.26', 'PT-UType', 'PT-UType-17U-750W', 'BHA-750W-230V', '4 Nos', 'Final ohms', 'Megger', 'HV test report', 'Checked &amp; packaged by'].every(t => html.includes(t)),
      ['INVENTORY ORDERS', '>PSI<', '01.10.26', '20.10.26', 'BHA-750W-230V', '4 Nos'].filter(t => !html.includes(t)).join(' | missing: '));
    ok('3c. the remark and fixture carry their Hindi and Gujarati lines', /Centre to Centre/.test(html) && /[ऀ-ॿ]/.test(html) && /[઀-૿]/.test(html), html.slice(html.indexOf('Remark'), html.indexOf('Remark') + 200));

    // 4. Cut from another drawing's stock.
    r = await post({ order_id: o, order_item_id: it, qty: 1, dispatch_date: '2026-10-20', fixture: 'Nut washer', fg_store_id: row18.id });
    const card2 = r.body.id ? await q1('SELECT * FROM job_cards WHERE id=$1', [r.body.id]) : null;
    ok('4. cut from the 18U-750W stock: taken from that row, and the sheet says so',
      r.status === 201 && card2?.fg_source_id === row18.id && Number((await q1('SELECT qty_available FROM finished_goods WHERE id=$1', [row18.id])).qty_available) === row18.q - 1
      && /Cut from store stock of <b>PT-UType-18U-750W/.test(uploads[card2.file_path] || ''), `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);

    // 5. An attached file is still taken as the card.
    r = await post({ order_id: o, order_item_id: it, qty: 1, dispatch_date: '2026-10-20' }, { body: '%PDF-1.4 test', type: 'application/pdf', name: 'card.pdf' });
    const card3 = r.body.id ? await q1('SELECT * FROM job_cards WHERE id=$1', [r.body.id]) : null;
    ok('5. a file attached: no fixture needed, the file is the card, nothing generated', r.status === 201 && !!card3?.file_name && !card3.fg_card, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);

    // 6. One card holds at most 50; fewer is fine on a bigger order.
    const it80 = (await q1(`INSERT INTO order_items (order_id, product_code, drawing_number, tube_material, tube_diameter, wattage, voltage, plating_instructions, quantity)
       VALUES ($1,'PT-UType','PT-UType-18U-750W','TUB-SS304-038-T06',8,750,230,'No Plating',80) RETURNING id`, [o])).id;
    await client.query('INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty) VALUES ($1,$2,320)', [it80, nut]);
    r = await post({ order_id: o, order_item_id: it80, qty: 60, dispatch_date: '2026-10-20', fixture: 'Nut washer' });
    ok('6a. an order of 80: a card for 60 is refused (at most 50 per card), nothing split', r.status === 400 && r.body.code === 'FG_CARD_MAX', `${r.status} ${r.body.error}`);
    r = await post({ order_id: o, order_item_id: it80, qty: 30, dispatch_date: '2026-10-20', fixture: 'Nut washer' });
    ok('6b. …a card for 30 is made — one card, 30 pcs', r.status === 201 && r.body.cards?.length === 1 && r.body.cards[0].qty === 30, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  } catch (e) { failed = true; console.error('ERROR', e); }
  finally {
    await client.query('ROLLBACK'); client.release(); server.close(); await realPool.end();
    console.log(failed ? '\nSOME CHECKS FAILED (rolled back)' : '\nALL PASS (rolled back — nothing kept)');
    process.exit(failed ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
