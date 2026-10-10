// Test: brazing rings from the job card (owner, 10 Oct 2026) — a 2in1 / 3in1 /
// Xin1 heater takes 2 rings per element at Stage 15, BRZ-08 on 8 mm, BRZ-11 on
// 11 mm; untick gives back, re-tick takes again; the list's ring lines are not
// taken for it; single-element heaters and cards that took rings before are
// unchanged. Rolled back — nothing kept (real BRZ-08 / BRZ-11 rows, briefly).
//   node scripts/test_brazing_rings.cjs
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
  try {
    const cols = (await q1(`SELECT COUNT(*)::int n FROM information_schema.columns WHERE table_name='job_cards' AND column_name IN ('rings_taken_at','rings_taken')`)).n;
    if (cols < 2) { ok('Database ready (job_cards.rings_taken_at / rings_taken)', false); return; }
    const floor = { id: owner.id, name: 'ZZTEST Floor', role: 'production' };
    const cust = (await q1(`SELECT MIN(id) AS id FROM customers WHERE UPPER(customer_code) <> 'IO'`)).id;
    const B8 = (await q1(`SELECT id FROM inventory_items WHERE item_code='BRZ-08'`)).id;
    const B11 = (await q1(`SELECT id FROM inventory_items WHERE item_code='BRZ-11'`)).id;
    const ROD = (await q1(`SELECT id FROM inventory_items WHERE item_code='BRZ-ROD'`)).id;
    const o = (await q1(`INSERT INTO orders (order_code, customer_id, order_date, order_type, status, material_deduction) VALUES ('ZZT-BR-O',$1,CURRENT_DATE,'local_he','in_progress',TRUE) RETURNING id`, [cust])).id;
    const mkItem = async (dwg, qty, dia) => (await q1(`INSERT INTO order_items (order_id, quantity, drawing_number, tube_diameter) VALUES ($1,$2,$3,$4) RETURNING id`, [o, qty, dwg, dia])).id;
    const mkCard = async (no, oi, qty, spec, dwg) => (await q1(`INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, drawing_no, generated_spec) VALUES ($1,$2,$3,$4,'in_progress',CURRENT_DATE,$5,$6) RETURNING id`, [no, o, oi, qty, dwg, spec])).id;
    const line = (oi, inv, qty) => client.query('INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty, qty_deducted) VALUES ($1,$2,$3,0)', [oi, inv, qty]);
    const lineRow = (oi, inv) => q1('SELECT COALESCE(qty_deducted,0)::float d, COALESCE(qty_waived,0)::float w FROM order_item_inventory WHERE order_item_id=$1 AND inventory_item_id=$2', [oi, inv]);
    const tick = (card, done) => call('PUT', `/api/job-cards/${card}/checklist/15`, { done }, floor);
    const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
    const spec3 = JSON.stringify({ input: { tubeDiameterMm: 8 }, computed: { elements: 3, cuttingLengthMm: 1600, totalLengthMm: 1948 } });

    // A. 4 × 3in1, 8 mm; the list says 48 rings (12 a heater) and 0.1 kg brazing rod.
    const oiA = await mkItem('ZZTEST-DWG-BR-3in1', 4, '8');
    await line(oiA, B8, 48); await line(oiA, ROD, 0.1);
    const A = await mkCard('ZZT-BR-A', oiA, 4, spec3, 'ZZTEST-DWG-BR-3in1');
    let s8 = await stock(B8), sRod = await stock(ROD);
    let r = await tick(A, true);
    let c = await q1('SELECT rings_taken_at, rings_taken FROM job_cards WHERE id=$1', [A]);
    ok('A1. Brazing ticked on 4 × 3in1 (8 mm): 24 BRZ-08 taken (4 × 3 × 2), not the list\'s 48; the brazing rod still comes off the list',
      r.status === 200 && near(await stock(B8), s8 - 24) && near(await stock(ROD), sRod - 0.1) && !!c.rings_taken_at && c.rings_taken?.qty === 24, `${r.status} ${JSON.stringify(r.body)} BRZ ${s8}→${await stock(B8)} rod ${sRod}→${await stock(ROD)}`);
    let L = await lineRow(oiA, B8);
    ok('A1. the list\'s 48-ring line is settled without stock for this card (nothing taken through it)', L.d === 0 && L.w === 48, JSON.stringify(L));
    r = await tick(A, false);
    ok('A2. Brazing unticked: the 24 go back, the list line reopens', r.status === 200 && near(await stock(B8), s8) && (await lineRow(oiA, B8)).w === 0
      && !(await q1('SELECT rings_taken_at FROM job_cards WHERE id=$1', [A])).rings_taken_at, `${r.status} ${await stock(B8)}`);
    r = await tick(A, true);
    ok('A3. ticked again: taken again (24), once', r.status === 200 && near(await stock(B8), s8 - 24), `${await stock(B8)}`);

    // B. An uploaded 2in1 card (no spec), 11 mm: elements from "2in1" in the drawing.
    const oiB = await mkItem('ZZTEST-DWG-BR-2in1-11', 5, '11');
    const Bc = await mkCard('ZZT-BR-B', oiB, 5, null, 'ZZTEST-DWG-BR-2in1-11');
    const s11 = await stock(B11);
    r = await tick(Bc, true);
    ok('B. an uploaded 2in1 on 11 mm tube: 20 BRZ-11 (5 × 2 × 2), read from "2in1" in the drawing', r.status === 200 && near(await stock(B11), s11 - 20), `${s11}→${await stock(B11)}`);

    // C. A single-element heater: nothing automatic, its list as before.
    const oiC = await mkItem('ZZTEST-DWG-BR-SINGLE', 3, '8');
    await line(oiC, B8, 6);
    const Cc = await mkCard('ZZT-BR-C', oiC, 3, JSON.stringify({ input: { tubeDiameterMm: 8 }, computed: { elements: 1 } }), 'ZZTEST-DWG-BR-SINGLE');
    s8 = await stock(B8);
    r = await tick(Cc, true);
    ok('C. a single-element heater: no rings of its own; the list\'s 6 are taken as before', r.status === 200 && near(await stock(B8), s8 - 6)
      && !(await q1('SELECT rings_taken_at FROM job_cards WHERE id=$1', [Cc])).rings_taken_at, `${s8}→${await stock(B8)}`);

    // D. A card that already took rings off its list at Stage 15 (before this rule): nothing more.
    const oiD = await mkItem('ZZTEST-DWG-BR-OLD-3in1', 2, '8');
    await line(oiD, B8, 24);
    const Dc = await mkCard('ZZT-BR-D', oiD, 2, spec3, 'ZZTEST-DWG-BR-OLD-3in1');
    await client.query(`INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by, order_item_id, source, job_card_id)
       VALUES ($1,'dispatch_to_production',24,0,'Order: ZZT-BR-O | Stage 15 Brazing (JC ZZT-BR-D)',$2,$3,'bom',$4)`, [B8, owner.id, oiD, Dc]);
    await client.query('UPDATE order_item_inventory SET qty_deducted=24 WHERE order_item_id=$1 AND inventory_item_id=$2', [oiD, B8]);
    s8 = await stock(B8);
    r = await tick(Dc, true);
    ok('D. a card that took its rings off the list before this rule takes nothing more', r.status === 200 && near(await stock(B8), s8)
      && !(await q1('SELECT rings_taken_at FROM job_cards WHERE id=$1', [Dc])).rings_taken_at, `${s8}→${await stock(B8)}`);

    // E. Two cards of 5 on an item of 10 × 3in1 (list 120): each takes 30 and settles only its own 60.
    const oiE = await mkItem('ZZTEST-DWG-BR-SPLIT-3in1', 10, '8');
    await line(oiE, B8, 120);
    const E1 = await mkCard('ZZT-BR-E1', oiE, 5, spec3, 'ZZTEST-DWG-BR-SPLIT-3in1');
    const E2 = await mkCard('ZZT-BR-E2', oiE, 5, spec3, 'ZZTEST-DWG-BR-SPLIT-3in1');
    s8 = await stock(B8);
    await tick(E1, true);
    L = await lineRow(oiE, B8);
    ok('E. the first of two cards takes 30 and settles its own 60 of the 120 — nothing of the other card\'s', near(await stock(B8), s8 - 30) && L.w === 60 && L.d === 0, `${s8}→${await stock(B8)} ${JSON.stringify(L)}`);
    await tick(E2, true);
    L = await lineRow(oiE, B8);
    ok('E. the second takes its 30 and settles the other 60', near(await stock(B8), s8 - 60) && L.w === 120 && L.d === 0, `${await stock(B8)} ${JSON.stringify(L)}`);
    ok('F. every take is on the card\'s timeline', (await q1(`SELECT COUNT(*)::int n FROM activity_log WHERE job_card_id = ANY($1) AND activity_type='rings_taken'`, [[A, Bc, E1, E2]])).n >= 5);
  } catch (e) { failed = true; console.error('ERROR', e); }
  finally {
    await client.query('ROLLBACK'); client.release(); server.close(); await realPool.end();
    console.log(failed ? '\nSOME CHECKS FAILED (rolled back)' : '\nALL PASS (rolled back — nothing kept)');
    process.exit(failed ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
