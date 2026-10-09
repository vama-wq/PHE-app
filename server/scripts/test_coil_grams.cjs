// Test: Stage 3 coil weight typed in GRAMS (owner, 9 Oct 2026 — "6 nos total
// used 48 grams, keep it simple"). Kept in kg underneath, so the coil-wire take
// at Spot is unchanged. One transaction, rolled back; made-up ZZTEST items.
//   node scripts/test_coil_grams.cjs
const path = require('path');
const fs = require('fs');
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
  const q1 = async (q, p = []) => (await client.query(q, p)).rows[0];
  const qa = async (q, p = []) => (await client.query(q, p)).rows;
  let failed = false;
  const ok = (label, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  ' + String(extra).slice(0, 300) : '')); if (!cond) failed = true; };
  // An async route that throws is not caught by express 4: count it as a failure
  // (the request then times out below and the run ends, rolled back).
  process.on('unhandledRejection', (e) => { failed = true; console.error('ROUTE ERROR (unhandled):', e); });

  // Every route call runs as the owner.
  const owner = await q1("SELECT id, name, role FROM users WHERE role='owner' ORDER BY id LIMIT 1");
  const auth = require(S + '/src/middleware/auth.js');
  auth.authenticate = (req, res, next) => { req.user = owner; next(); };
  // The Product QC photo: no real file is stored — the upload step is stubbed.
  const upload = require(S + '/src/middleware/upload.js');
  upload.deleteFromStorage = async () => {};
  upload.copyInStorage = async () => {};
  upload.uploadChecklistPhoto = [(req, res, next) => { req.file = { storagePath: 'test/qc.jpg', filename: 'qc.jpg', originalname: 'qc.jpg' }; next(); }];
  // The finished-goods job card file: nothing stored either.
  upload.uploadJobCard = [(req, res, next) => { req.file = { storagePath: 'test/jc.pdf', filename: 'jc.pdf', originalname: 'jc.pdf' }; next(); }];
  // No WhatsApp copy of any alert leaves the test (the fins alert below).
  const wa = require(S + '/src/lib/whatsapp.js');
  wa.queueWhatsApp = async () => {};

  const ded = require(S + '/src/lib/inventoryDeduction.js');
  // A made-up fins code (0.011 kg per 50.8 mm, as FIN-MS-08), so no real fins
  // stock is touched. Same array/object every module reads, for this run only.
  const { takeLastStage } = require(S + '/src/lib/lastStageTake.js');
  const { applyBomCorrection } = require(S + '/src/lib/bomCorrection.js');
  const { applyMaterialDeductions } = require(S + '/src/lib/materialDeduction.js');
  const { isCountedItem } = require(S + '/src/lib/countedStock.js');
  const { approveSplitRequest } = require(S + '/src/services/actions/splitRequests.js');
  const express = require(S + '/node_modules/express');
  const app = express();
  app.use(express.json());
  app.use('/api/job-cards', require(S + '/src/routes/jobCards.js'));
  app.use('/api/qc', require(S + '/src/routes/qc.js'));
  app.use('/api/dispatch', require(S + '/src/routes/dispatch.js'));
  app.use('/api/orders', require(S + '/src/routes/orders.js'));
  const server = app.listen(0);
  const base = 'http://127.0.0.1:' + server.address().port;
  // The stages that must be done before stage 29, read from the route itself.
  const MANDATORY = JSON.parse(fs.readFileSync(S + '/src/routes/jobCards.js', 'utf8').match(/const MANDATORY_STAGES = (\[[^\]]+\])/)[1]);

  try {
    // ── Ready? The new columns and the 'inventory_qc' status must exist ──
    const ucol = await q1(`SELECT 1 AS x FROM information_schema.columns WHERE table_name='production_checklist' AND column_name='coil_unit'`);
    if (!ucol || !owner) { ok('Database ready (production_checklist.coil_unit) and an owner user exists', false); return; }
    const uid = owner.id;

    const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
    const stock = async (id) => Number((await q1('SELECT current_stock FROM inventory_items WHERE id=$1', [id])).current_stock);
    const call = async (method, url, body) => {
      const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const mkItem = async (code, cat, s, unit) => (await q1(
      `INSERT INTO inventory_items (item_code, name, unit, category, current_stock, unit_cost) VALUES ($1,$1,$2,$3,$4,1) RETURNING id`, [code, unit, cat, s])).id;
    const mkOrder = async (code) => (await q1(
      `INSERT INTO orders (order_code, customer_id, order_date, order_type, status, material_deduction)
       VALUES ($1, (SELECT MIN(id) FROM customers), CURRENT_DATE, 'local_he', 'in_progress', TRUE) RETURNING id`, [code])).id;
    const mkLine = async (order, qty, dwg) => (await q1(
      `INSERT INTO order_items (order_id, quantity, drawing_number) VALUES ($1,$2,$3) RETURNING id`, [order, qty, dwg])).id;
    const mkCard = async (order, oi, no, qty) => (await q1(
      `INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, drawing_no)
       VALUES ($1,$2,$3,$4,'in_progress',CURRENT_DATE,$5) RETURNING id`, [no, order, oi, qty, `ZZTEST-DWG-${no}`])).id;
    const s3 = (card) => q1('SELECT coil_weight::float w, scrap_value, coil_unit, done FROM production_checklist WHERE job_card_id=$1 AND stage_no=3', [card]);

    // ════ Stage 3 coil in grams (owner, 9 Oct 2026): "6 nos total used 48 grams" ════
    const SPR = await mkItem('ZZTEST-CG-SPR', 'Spring Guage', 10, 'Kgs');
    const o = await mkOrder('ZZT-CG');
    const oi = await mkLine(o, 6, 'ZZTEST-DWG-CG');
    const C1 = await mkCard(o, oi, 'ZZT-CG-1', 6);
    await client.query(`INSERT INTO production_checklist (job_card_id, stage_no, done, value1, done_at) VALUES ($1,1,1,'ZZTEST-CG-SPR',NOW()),($1,2,1,NULL,NOW())`, [C1]);
    let r = await call('PUT', `/api/job-cards/${C1}/checklist/3`, { done: true, value1: '52', value2: '4.8', coil_weight: '0.5', coil_unit: 'g', scrap_value: '0' });
    ok('G1. 0.5 g for 6 coils is refused (0.08 g a coil) — the message speaks grams', r.status === 400 && r.body.code === 'COIL_WEIGHT_IMPLAUSIBLE' && /0\.5 g ÷ 6 coils/.test(r.body.error || '') && /total grams/.test(r.body.error || ''), JSON.stringify(r.body));
    r = await call('PUT', `/api/job-cards/${C1}/checklist/3`, { done: true, value1: '52', value2: '4.8', coil_weight: '48', coil_unit: 'g', scrap_value: '2' });
    let row = await s3(C1);
    ok('G2. 48 g typed for the 6 coils (2 g scrap): saved as 0.048 kg and 0.002 kg, marked grams', r.status === 200 && near(row.w, 0.048) && near(row.scrap_value, 0.002) && row.coil_unit === 'g' && row.done === 1, `${r.status} ${JSON.stringify(r.body)} ${JSON.stringify(row)}`);
    const before = await stock(SPR);
    await applyMaterialDeductions(txDb, C1, 4, true, uid);     // what the Spot tick runs
    const took = await q1(`SELECT COALESCE(SUM(quantity),0)::float n FROM inventory_transactions WHERE item_id=$1 AND notes LIKE 'Coil wire 0.048 Kgs%'`, [SPR]);
    ok('G3. Spot takes the coil wire as 0.048 kg — not 48 kg, not 0.000048', near(took.n, 0.048) && before - (await stock(SPR)) > 0.0479 && before - (await stock(SPR)) < 0.051, `took ${took.n}, stock ${before} → ${await stock(SPR)}`);
    r = await call('PUT', `/api/job-cards/${C1}/checklist/3`, { done: false, value1: '52', value2: '4.8', coil_weight: String(row.w) });
    row = await s3(C1);
    ok('G4. an undo (the screen sends back the stored kg, no unit) keeps 0.048 kg and the grams mark', r.status === 200 && near(row.w, 0.048) && row.coil_unit === 'g', `${r.status} ${JSON.stringify(row)}`);
    const C2 = await mkCard(o, oi, 'ZZT-CG-2', 6);
    await client.query(`INSERT INTO production_checklist (job_card_id, stage_no, done, value1, done_at) VALUES ($1,1,1,'ZZTEST-CG-SPR',NOW()),($1,2,1,NULL,NOW())`, [C2]);
    r = await call('PUT', `/api/job-cards/${C2}/checklist/3`, { done: true, value1: '52', value2: '4.8', coil_weight: '0.048', scrap_value: '0' });
    row = await s3(C2);
    ok('G5. an older screen sending kg (no unit) is still read as kg', r.status === 200 && near(row.w, 0.048) && row.coil_unit === null, `${r.status} ${JSON.stringify(r.body)} ${JSON.stringify(row)}`);
  } catch (e) {
    failed = true;
    console.error('ERROR', e);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    server.close();
    await realPool.end();
    console.log(failed ? '\nSOME CHECKS FAILED (rolled back)' : '\nALL PASS (rolled back — nothing kept)');
    process.exit(failed ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
