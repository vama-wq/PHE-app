// Test: frozen orders take no inventory (owner, 19 Oct 2026) — every order
// BELOW ORD-126-26, plus ORD-127-26. A frozen card's last-stage take stamps it
// but deducts nothing; brazing rings and stage-category takes are no-ops. A
// non-frozen card (ORD-126 and up, except 127) still takes. Rolled back.
//   node scripts/test_inventory_freeze.cjs
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
  const ok = (label, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  ' + String(extra).slice(0, 200) : '')); if (!cond) failed = true; };
  const fz = require(S + '/src/lib/inventoryFreeze.js');
  const { takeLastStage } = require(S + '/src/lib/lastStageTake.js');
  const { deductStageCategories } = require(S + '/src/lib/inventoryDeduction.js');
  const br = require(S + '/src/lib/brazingRings.js');
  const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
  const stock = async (id) => Number((await q1('SELECT current_stock FROM inventory_items WHERE id=$1', [id])).current_stock);
  try {
    // Unit: the cutoff.
    ok('cutoff: through 127 frozen, 128+ not',
      fz.isFrozenCode('ORD-005-26') && fz.isFrozenCode('ORD-125-26') && fz.isFrozenCode('ORD-126-26')
      && fz.isFrozenCode('ORD-127-26') && !fz.isFrozenCode('ORD-128-26') && !fz.isFrozenCode('ORD-171-26'),
      [5, 125, 126, 127, 128, 171].map(n => fz.isFrozenCode(`ORD-${n}-26`)).join(','));

    ok('cutoff date is the count date 12 Oct', fz.CUTOFF === '2026-10-12', fz.CUTOFF);

    const owner = (await q1("SELECT id FROM users WHERE role='owner' ORDER BY id LIMIT 1")).id;
    const cust = (await q1("SELECT MIN(id) id FROM customers WHERE UPPER(customer_code)<>'IO'")).id;
    const NUT = (await q1("SELECT id, current_stock::float s FROM inventory_items WHERE item_code='NUT-SS-M4-08'"));
    const B8 = (await q1("SELECT id, current_stock::float s FROM inventory_items WHERE item_code='BRZ-08'"));
    const spec3 = JSON.stringify({ input: { tubeDiameterMm: 8 }, computed: { elements: 3 } });

    // Build a 3in1 card with a NUT line (swept at the last stage), its Brazing
    // (stage 15) checklist row completed on `stageDate`. For a ≤127 order that
    // date decides the freeze: on/before 12 Oct = already counted (skip), after
    // = real current work (deduct).
    const mk = async (code, stageDate) => {
      const o = (await q1(`INSERT INTO orders (order_code, customer_id, order_date, order_type, status, material_deduction) VALUES ($1,$2,CURRENT_DATE,'local_he','in_progress',TRUE) RETURNING id`, [code, cust])).id;
      const it = (await q1(`INSERT INTO order_items (order_id, product_code, drawing_number, tube_diameter, quantity) VALUES ($1,'PT','ZZT-FRZ-3in1',8,4) RETURNING id`, [o])).id;
      await client.query('INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty) VALUES ($1,$2,8)', [it, NUT.id]);
      const jc = (await q1(`INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, drawing_no, generated_spec) VALUES ($1,$2,$3,4,'in_progress',CURRENT_DATE,'ZZT-FRZ-3in1',$4) RETURNING id, order_id, job_card_no, qty, drawing_no, is_fg`, ['ZZT-'+code, o, it, spec3]));
      await client.query(`INSERT INTO production_checklist (job_card_id, stage_no, done, done_at) VALUES ($1,15,1,$2::timestamptz)`, [jc.id, stageDate + ' 12:00:00+05:30']);
      return { o, it, jc };
    };
    const runCard = async (c) => {
      await br.takeRingsAtBrazing(txDb, c.jc.id, owner);
      await deductStageCategories(txDb, await q1('SELECT * FROM job_cards WHERE id=$1', [c.jc.id]), 15, owner);
      await takeLastStage(txDb, c.jc, owner);
    };

    const FB = await mk('ORD-7-26', '2026-09-01');   // frozen, Brazing before the count
    const FA = await mk('ORD-8-26', '2026-10-20');   // frozen, Brazing after the count
    const L  = await mk('ORD-600-26', '2026-09-01'); // live (128+)

    // Unit: the helpers read stage 15's done_at and classify.
    ok('unit frozenSkipsStage(15): frozen+before → skip, frozen+after → deduct, live → deduct',
      (await fz.frozenSkipsStage(txDb, { id: FB.jc.id, order_code: 'ORD-7-26' }, 15)) === true
      && (await fz.frozenSkipsStage(txDb, { id: FA.jc.id, order_code: 'ORD-8-26' }, 15)) === false
      && (await fz.frozenSkipsStage(txDb, { id: L.jc.id, order_code: 'ORD-600-26' }, 15)) === false,
      `${await fz.frozenSkipsStage(txDb, { id: FB.jc.id, order_code: 'ORD-7-26' }, 15)},${await fz.frozenSkipsStage(txDb, { id: FA.jc.id, order_code: 'ORD-8-26' }, 15)},${await fz.frozenSkipsStage(txDb, { id: L.jc.id, order_code: 'ORD-600-26' }, 15)}`);
    ok('unit frozenSkipsLastStage: frozen+before → skip, frozen+after → deduct, live → deduct',
      (await fz.frozenSkipsLastStage(txDb, { id: FB.jc.id, order_code: 'ORD-7-26' })) === true
      && (await fz.frozenSkipsLastStage(txDb, { id: FA.jc.id, order_code: 'ORD-8-26' })) === false
      && (await fz.frozenSkipsLastStage(txDb, { id: L.jc.id, order_code: 'ORD-600-26' })) === false);
    ok('unit blanket no-deduct: ORD-178-26 skips every deduction regardless of stage date',
      fz.isBlanketNoDeduct('ORD-178-26') === true && fz.isBlanketNoDeduct('ORD-200-26') === false
      && (await fz.frozenSkipsStage(txDb, { id: FA.jc.id, order_code: 'ORD-178-26' }, 15)) === true
      && (await fz.frozenSkipsLastStage(txDb, { id: FA.jc.id, order_code: 'ORD-178-26' })) === true);

    // 1. Frozen, Brazing BEFORE the count → nothing moves (already in the count).
    const b0 = await stock(B8.id), n0 = await stock(NUT.id);
    await runCard(FB);
    const fc = await q1('SELECT last_stage_taken_at, rings_taken_at FROM job_cards WHERE id=$1', [FB.jc.id]);
    ok('1. frozen ORD-7-26, Brazing 01 Sep (≤ cutoff): no rings, no nuts; last stage stamped so it still progresses',
      near(await stock(B8.id), b0) && near(await stock(NUT.id), n0) && !!fc.last_stage_taken_at && !fc.rings_taken_at,
      `BRZ ${b0}->${await stock(B8.id)} NUT ${n0}->${await stock(NUT.id)} stamped ${!!fc.last_stage_taken_at}`);

    // 2. Frozen, Brazing AFTER the count → real current work, DOES deduct.
    const b1 = await stock(B8.id), n1 = await stock(NUT.id);
    await runCard(FA);
    ok('2. frozen ORD-8-26, Brazing 20 Oct (> cutoff): 24 rings + 8 nuts DO deduct',
      near(await stock(B8.id), b1 - 24) && near(await stock(NUT.id), n1 - 8),
      `BRZ ${b1}->${await stock(B8.id)} NUT ${n1}->${await stock(NUT.id)}`);

    // 3. Live order (128+): always deducts, whatever the date.
    const b2 = await stock(B8.id), n2 = await stock(NUT.id);
    await runCard(L);
    ok('3. live ORD-600-26: 24 rings + 8 nuts taken regardless of stage date',
      near(await stock(B8.id), b2 - 24) && near(await stock(NUT.id), n2 - 8),
      `BRZ ${b2}->${await stock(B8.id)} NUT ${n2}->${await stock(NUT.id)}`);
  } catch (e) { failed = true; console.error('ERROR', e); }
  finally {
    await client.query('ROLLBACK'); client.release(); await realPool.end();
    console.log(failed ? '\nSOME CHECKS FAILED (rolled back)' : '\nALL PASS (rolled back — nothing kept)');
    process.exit(failed ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
