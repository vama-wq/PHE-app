// Test: DII and TT orders take no brazing rings (owner, 2 Nov 2026: "DII orders
// will not substract the Brazing rings when stage is ticked"; 3 Nov 2026: "tt
// orders will also use the same Brazing rod and not rings"). DII (Doit
// Industries Limited) and TT (Tirupati Tubes Pvt Ltd) braze with rod: ticking
// Brazing on their 3in1 cards takes no BRZ-08 / BRZ-11 and holds none, while
// the rod on the list still leaves stock at Brazing. Any other customer's 3in1
// card takes its rings as before. Rolled back.
//   node scripts/test_brazing_dii.cjs
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
  const ok = (label, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  ' + String(extra).slice(0, 300) : '')); if (!cond) failed = true; };
  try {
    const br = require(S + '/src/lib/brazingRings.js');
    const { deductStageCategories } = require(S + '/src/lib/inventoryDeduction.js');
    const { heldByOrders } = require(S + '/src/lib/stockHolds.js');
    const uid = (await q1("SELECT id FROM users WHERE role='owner' ORDER BY id LIMIT 1")).id;
    const dii = await q1("SELECT id FROM customers WHERE UPPER(customer_code)='DII'");
    const tt = await q1("SELECT id FROM customers WHERE UPPER(customer_code)='TT'");
    const other = await q1("SELECT MIN(id) AS id FROM customers WHERE UPPER(customer_code) NOT IN ('DII','TT','IO')");
    const RING = await q1("SELECT id, current_stock::float s FROM inventory_items WHERE item_code='BRZ-08'");
    const RING11 = await q1("SELECT id, current_stock::float s FROM inventory_items WHERE item_code='BRZ-11'");
    const ROD = await q1("SELECT id, current_stock::float s FROM inventory_items WHERE item_code='BRZ-ROD-RN'");
    if (!dii || !tt || !RING || !RING11 || !ROD) { ok('DII and TT customers, BRZ-08, BRZ-11 and BRZ-ROD-RN exist', false); return; }
    const stock = async (id) => Number((await q1('SELECT current_stock FROM inventory_items WHERE id=$1', [id])).current_stock);
    const mk = async (code, cust, dia = 8) => {
      const spec = JSON.stringify({ input: { tubeDiameterMm: dia }, computed: { elements: 3 } });
      const o = (await q1(`INSERT INTO orders (order_code, customer_id, order_date, order_type, status, material_deduction) VALUES ($1,$2,CURRENT_DATE,'local_he','in_progress',TRUE) RETURNING id`, [code, cust])).id;
      const it = (await q1(`INSERT INTO order_items (order_id, product_code, drawing_number, tube_diameter, quantity) VALUES ($1,'PT','ZZTEST-3in1-BRZ',$2,4) RETURNING id`, [o, dia])).id;
      await client.query('INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty) VALUES ($1,$2,2)', [it, ROD.id]);
      const jc = (await q1(`INSERT INTO job_cards (job_card_no, order_id, order_item_id, qty, status, dispatch_date, drawing_no, generated_spec)
        VALUES ($1,$2,$3,4,'in_progress',CURRENT_DATE,'ZZTEST-3in1-BRZ',$4) RETURNING id`, ['ZZT-' + code, o, it, spec])).id;
      return { o, it, jc };
    };
    const D = await mk('ZZT-BRZ-DII', dii.id), N = await mk('ZZT-BRZ-OTH', other.id);
    const T = await mk('ZZT-BRZ-TT', tt.id, 11), N11 = await mk('ZZT-BRZ-OTH11', other.id, 11);

    const holds = await heldByOrders(txDb);
    const ringHold = (order) => holds.get(RING.id)?.by.find(h => h.order_id === order)?.qty || 0;
    ok('1. stock holds: no brazing rings held for the DII order; the other order holds its 24 (4 × 3 elements × 2)',
      ringHold(D.o) === 0 && ringHold(N.o) === 24, JSON.stringify({ dii: ringHold(D.o), other: ringHold(N.o) }));

    await client.query(`INSERT INTO production_checklist (job_card_id, stage_no, done, done_at) VALUES ($1,15,1,NOW()),($2,15,1,NOW())`, [D.jc, N.jc]);
    const r0 = await stock(RING.id), rod0 = await stock(ROD.id);
    const took = await br.takeRingsAtBrazing(txDb, D.jc, uid);
    await deductStageCategories(txDb, await q1('SELECT * FROM job_cards WHERE id=$1', [D.jc]), 15, uid);
    ok('2. Brazing ticked on the DII 3in1 card: no rings taken, the card records none',
      took === null && (await stock(RING.id)) === r0 && !(await q1('SELECT rings_taken_at FROM job_cards WHERE id=$1', [D.jc])).rings_taken_at,
      JSON.stringify({ took, ring: [r0, await stock(RING.id)] }));
    ok('3. …and the brazing rod on its list still leaves stock at Brazing (2)', Math.abs((await stock(ROD.id)) - (rod0 - 2)) < 1e-6, `${rod0} → ${await stock(ROD.id)}`);

    const r1 = await stock(RING.id);
    const tookN = await br.takeRingsAtBrazing(txDb, N.jc, uid);
    ok('4. another customer\'s 3in1 card takes its rings as before: 24 BRZ-08', tookN?.qty === 24 && (await stock(RING.id)) === r1 - 24, JSON.stringify(tookN));

    const ring11Hold = (order) => holds.get(RING11.id)?.by.find(h => h.order_id === order)?.qty || 0;
    ok('5. stock holds: no BRZ-11 held for the TT 11 mm 3in1 order; another customer\'s holds its 24',
      ring11Hold(T.o) === 0 && ring11Hold(N11.o) === 24, JSON.stringify({ tt: ring11Hold(T.o), other: ring11Hold(N11.o) }));
    await client.query(`INSERT INTO production_checklist (job_card_id, stage_no, done, done_at) VALUES ($1,15,1,NOW())`, [T.jc]);
    const t0 = await stock(RING11.id), trod0 = await stock(ROD.id);
    const tookT = await br.takeRingsAtBrazing(txDb, T.jc, uid);
    await deductStageCategories(txDb, await q1('SELECT * FROM job_cards WHERE id=$1', [T.jc]), 15, uid);
    ok('6. Brazing ticked on the TT 3in1 card: no BRZ-11 taken, and its brazing rod still leaves stock (2)',
      tookT === null && (await stock(RING11.id)) === t0 && Math.abs((await stock(ROD.id)) - (trod0 - 2)) < 1e-6,
      JSON.stringify({ tookT, ring11: [t0, await stock(RING11.id)], rod: [trod0, await stock(ROD.id)] }));
  } catch (e) { failed = true; console.error('ERROR', e); }
  finally {
    await client.query('ROLLBACK'); client.release(); await realPool.end();
    console.log(failed ? '\nSOME CHECKS FAILED (rolled back)' : '\nALL PASS (rolled back — nothing kept)');
    process.exit(failed ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
