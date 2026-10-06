// Test for a customer query on PART of a job card (owner, 6 Oct 2026): "out of
// 50 nos only 3 are coming back for repair, return or replacement". A query
// that names a job card now says how many pieces are affected. Fewer than all
// of the card's dispatched pieces → those pieces are split off into their own
// card <orig>-Q<n> (status customer_query, still counted as dispatched, with
// the parent's flags and completed checklist INCLUDING Ready for Dispatch) and
// the query is tied to THAT card; the parent keeps the rest and stays
// dispatched. The owner may put a different job card document / product name /
// drawing no on the -Q card ("just in case they were wrong completely").
// Everything downstream — repair, debit-note return to Finished Goods,
// replacement — then works on the small card, not on 50. All pieces affected →
// the card itself carries the query, as before. Nothing moves in stock on a
// query split; the terminal pins of a dispatched parent are left alone. Older
// queries (qty NULL) still mean the whole card. A card that has not gone out
// cannot be queried — a customer query is for pieces at the customer.
//
// Runs inside one transaction that is ROLLED BACK, on its own made-up orders,
// lines, cards, items and queries (ZZT-Q…), so no real card, query, CAPA, stock
// row, Finished Goods row, notification or timeline line is kept. Routes run
// through express as the owner (a production user where a refusal is checked).
// The job-card document goes through the real upload middleware, but Supabase
// Storage is swapped for a recorder — nothing is stored. The WhatsApp copy of
// each alert is recorded, not queued.
//
// Needs a database the new server has started on once (initDB adds
// customer_queries.qty / qty_of / split_job_card_id) — it refuses otherwise.
//   node scripts/test_query_qty.cjs
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
  // All stubs BEFORE any other module loads: they are destructured at require
  // time, and the real logActivity writes through the pool, outside this transaction.
  dbmod.getDB = () => txDb;
  dbmod.logActivity = async (orderId, jc, type, desc, by) => { logs.push({ orderId, jc, type, desc, by }); };
  // Supabase Storage: middleware/upload.js takes createClient at load and makes
  // its client at the first upload, so the recorder goes in before any route
  // loads. The made-up document is never stored; the path it would have had is
  // still checked against the -Q card.
  const stored = [];
  const supa = require(S + '/node_modules/@supabase/supabase-js');
  supa.createClient = () => ({
    storage: {
      from: (bucket) => ({
        upload: async (p, buf, opts) => { stored.push({ bucket, path: p, bytes: buf ? buf.length : 0, type: opts?.contentType || null }); return { data: { path: p }, error: null }; },
        remove: async (paths) => ({ data: (paths || []).map(p => ({ name: p })), error: null }),
        copy: async (from, to) => { stored.push({ bucket, path: to, copied_from: from }); return { data: { path: to }, error: null }; },
        download: async () => ({ data: null, error: { message: 'test stub — nothing is stored' } }),
        getPublicUrl: (p) => ({ data: { publicUrl: `stub://${bucket}/${p}` } }),
      }),
    },
  });
  // The WhatsApp copy of a notification is recorded here, never queued — the
  // real one uses its own connection, which this rollback would not cover.
  const wa = require(S + '/src/lib/whatsapp.js');
  const waCalls = [];
  wa.queueWhatsApp = async (p) => { waCalls.push(p); };
  const q1 = async (q, p = []) => (await client.query(q, p)).rows[0];
  const qa = async (q, p = []) => (await client.query(q, p)).rows;
  let failed = false;
  const ok = (label, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  ' + String(extra).slice(0, 400) : '')); if (!cond) failed = true; };
  // An async route that throws is not caught by express 4: count it as a failure
  // (the request then times out below and the run ends, rolled back).
  process.on('unhandledRejection', (e) => { failed = true; console.error('ROUTE ERROR (unhandled):', e); });

  // Routes run as whoever `actor` is at the time: the owner unless a call says otherwise.
  const owner = await q1("SELECT id, name, role FROM users WHERE role='owner' ORDER BY id LIMIT 1");
  let actor = owner;
  const auth = require(S + '/src/middleware/auth.js');
  auth.authenticate = (req, res, next) => { req.user = actor; next(); };

  const express = require(S + '/node_modules/express');
  const app = express();
  app.use(express.json());
  app.use('/api/customer-queries', require(S + '/src/routes/customerQueries.js'));
  app.use('/api/job-cards', require(S + '/src/routes/jobCards.js'));
  const server = app.listen(0);
  const base = 'http://127.0.0.1:' + server.address().port;

  try {
    // ── Ready? The query columns and the card columns the split copies must exist ──
    const cqCols = (await qa(`SELECT column_name FROM information_schema.columns WHERE table_name='customer_queries' AND column_name = ANY($1)`,
      [['qty', 'qty_of', 'split_job_card_id']])).length;
    const jcCols = (await qa(`SELECT column_name FROM information_schema.columns WHERE table_name='job_cards' AND column_name = ANY($1)`,
      [['qc_dispatch_qty', 'qc_fg_qty', 'qc_route', 'dispatched_at', 'last_stage_taken_at', 'fins_deducted', 'parent_job_card_id']])).length;
    const table = await q1(`SELECT 1 AS x FROM information_schema.tables WHERE table_name='job_card_terminals'`);
    if (cqCols < 3 || jcCols < 7 || !table || !owner) {
      ok('Database ready for query quantities (start the new server on it once first) and an owner user exists', false,
        `customer_queries columns ${cqCols}/3, job_cards columns ${jcCols}/7, job_card_terminals ${!!table}, owner ${!!owner}`);
      return;
    }
    const uid = owner.id;

    // A production user shows who may NOT raise a query. Made up for the run
    // when the database has none (rolled back with the rest).
    const floor = (await q1("SELECT id, name, role FROM users WHERE role='production' ORDER BY id LIMIT 1")) || await q1(
      `INSERT INTO users (name, username, password_hash, role) VALUES ('ZZTEST Production','zztest_production','zztest','production') RETURNING id, name, role`);

    const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
    const sameTime = (a, b) => (a == null && b == null) || (a != null && b != null && new Date(a).getTime() === new Date(b).getTime());
    const cardRow = (id) => q1('SELECT * FROM job_cards WHERE id=$1', [id]);
    const cardByNo = (no) => q1('SELECT * FROM job_cards WHERE job_card_no=$1', [no]);
    const kidsOf = (id) => qa('SELECT id, job_card_no, qty, status FROM job_cards WHERE parent_job_card_id=$1 ORDER BY id', [id]);
    const queryRow = (id) => q1('SELECT * FROM customer_queries WHERE id=$1', [id]);
    const queriesOf = (order) => qa('SELECT id, query_no, job_card_id, qty, qty_of, split_job_card_id, status FROM customer_queries WHERE order_id=$1 ORDER BY id', [order]);
    const doneStages = async (card) => (await qa('SELECT stage_no FROM production_checklist WHERE job_card_id=$1 AND done=1 ORDER BY stage_no', [card])).map(r => Number(r.stage_no));
    const stageRow = (card, st) => q1('SELECT * FROM production_checklist WHERE job_card_id=$1 AND stage_no=$2', [card, st]);
    // The card's timeline, straight from the table (the split writes its lines inside its own transaction).
    const lines = (card) => qa('SELECT activity_type AS t, description AS d FROM activity_log WHERE job_card_id=$1 ORDER BY id', [card]);
    const hasLine = (rows, type, re) => rows.some(l => l.t === type && re.test(l.d));
    const capasOf = (card) => qa('SELECT id, status, trigger_type, customer_query_id FROM capa_reports WHERE job_card_id=$1 ORDER BY id', [card]);
    const orderStatus = async (id) => (await q1('SELECT status FROM orders WHERE id=$1', [id])).status;
    const pinsOf = (card) => qa('SELECT inventory_item_id AS inv, qty::float AS q, source FROM job_card_terminals WHERE job_card_id=$1 ORDER BY inventory_item_id', [card]);
    const fgOf = (card) => q1('SELECT id, qty_in::float AS qi, qty_available::float AS qa, drawing_no, base_drawing_no FROM finished_goods WHERE job_card_id=$1', [card]);
    const fgLogOf = (no) => qa('SELECT movement_type AS m, qty::float AS q, reference, notes FROM finished_goods_log WHERE job_card_no=$1 ORDER BY id', [no]);
    const ALL = Array.from({ length: 29 }, (_, i) => i + 1);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    const call = async (method, url, body, as = owner) => {
      actor = as;
      const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
      actor = owner;
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    // The same route as a multipart form — how the modal sends it when a job
    // card document is attached. Fields go as strings, as a browser sends them.
    const callForm = async (method, url, fields, file, as = owner) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields || {})) if (v !== undefined && v !== null) fd.append(k, String(v));
      if (file) fd.append('file', new Blob([file.bytes], { type: file.type }), file.name);
      actor = as;
      const r = await fetch(base + url, { method, body: fd, signal: AbortSignal.timeout(30000) });
      actor = owner;
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const CQ = '/api/customer-queries';
    const raise = (body, as = owner) => call('POST', CQ, body, as);

    // ── Made-up data ──
    const T_OUT = '2026-10-01T10:00:00.000Z';    // when the pieces went out
    const T_TAKE = '2026-09-30T12:00:00.000Z';   // the last-stage take on the floor
    const T_QC = '2026-09-30T15:00:00.000Z';     // Product QC / Inventory QC passed
    const today = new Date().toISOString().slice(0, 10);
    const mkItem = async (code, cat, s) => (await q1(
      `INSERT INTO inventory_items (item_code, name, unit, category, current_stock, unit_cost) VALUES ($1,$1,'pcs',$2,$3,1) RETURNING id`, [code, cat, s])).id;
    const mkOrder = async (code, status = 'dispatched') => (await q1(
      `INSERT INTO orders (order_code, customer_id, order_date, order_type, status, material_deduction)
       VALUES ($1, (SELECT MIN(id) FROM customers), CURRENT_DATE, 'local_he', $2, FALSE) RETURNING id`, [code, status])).id;
    const mkLine = async (order, qty, dwg) => (await q1(
      `INSERT INTO order_items (order_id, quantity, drawing_number) VALUES ($1,$2,$3) RETURNING id`, [order, qty, dwg])).id;
    const mkCard = async (fields) => {
      const keys = Object.keys(fields);
      return (await q1(`INSERT INTO job_cards (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, keys.map(k => fields[k]))).id;
    };
    // A card whose pieces went out: QC routed all of them to dispatch, every
    // material flag settled on the floor, both QCs passed, the last stage taken.
    const dispatchedCard = (order, oi, no, qty, extra = {}) => mkCard({
      job_card_no: no, order_id: order, order_item_id: oi, qty, status: 'dispatched', dispatch_date: today,
      drawing_no: `ZZTEST-DWG-${no}`, product_name: `ZZTEST Heater ${no}`, punching: 'ZZT-PUNCH', is_fg: false, current_stage: 29,
      dispatched_at: T_OUT, qc_route: 'dispatch', qc_dispatch_qty: qty, qc_fg_qty: 0,
      tube_deducted: true, coil_deducted: true, fill_deducted: true, fins_deducted: true, last_stage_taken_at: T_TAKE,
      product_qc_at: T_QC, product_qc_by: uid, inventory_qc_at: T_QC, inventory_qc_by: uid, plating_status: 'returned',
      file_path: `job-cards/zztest_${no}.pdf`, file_name: `zztest_${no}.pdf`, original_name: `${no}.pdf`, uploaded_by: uid,
      ...extra,
    });
    // Stages marked done on the card directly, with a reading and a worker so
    // the copy onto a -Q card can be seen (the floor's checks are not under test).
    const tick = async (card, stages) => {
      for (const st of stages) await client.query(
        `INSERT INTO production_checklist (job_card_id, stage_no, done, done_at, value1, worker_name) VALUES ($1,$2,1,NOW(),$3,'ZZTEST Worker')
         ON CONFLICT (job_card_id, stage_no) DO UPDATE SET done=1, done_at=NOW(), value1=EXCLUDED.value1, worker_name=EXCLUDED.worker_name`,
        [card, st, `v${st}`]);
    };

    // Two stock items on the order's list, fully taken (the card went out), and
    // the parent's own terminal-pin rows — so "nothing moves" can be seen.
    const PIN = await mkItem('ZZTEST-QT-PIN', 'Terminal Pin', 500);
    const NUT = await mkItem('ZZTEST-QT-NUT', 'Nut', 2000);
    const items = [PIN, NUT];

    // Order A: one item of 55 pcs — card A of 50 (under test) and an earlier
    // partial-dispatch child A-P1 of 5, so the -Q numbering can be seen to
    // ignore -P children.
    const oA = await mkOrder('ZZT-QA');
    const oiA = await mkLine(oA, 55, 'ZZTEST-DWG-QA');
    await client.query(`INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty, qty_deducted) VALUES ($1,$2,55,0), ($1,$3,220,220)`, [oiA, PIN, NUT]);
    await client.query(`UPDATE order_item_inventory SET qty_waived=55 WHERE order_item_id=$1 AND inventory_item_id=$2`, [oiA, PIN]);
    const A = await dispatchedCard(oA, oiA, 'ZZT-QA1', 50, { drawing_no: 'ZZTEST-DWG-QA', product_name: 'ZZTEST Heater 1kW' });
    await tick(A, ALL);
    // The Ready-for-Dispatch row carries the dispatched count the lists show
    await client.query('UPDATE production_checklist SET dispatched_qty=50 WHERE job_card_id=$1 AND stage_no=29', [A]);
    await client.query(`INSERT INTO job_card_terminals (job_card_id, inventory_item_id, qty, source) VALUES ($1,$2,50,'list')`, [A, PIN]);
    const P1 = await dispatchedCard(oA, oiA, 'ZZT-QA1-P1', 5, { drawing_no: 'ZZTEST-DWG-QA', product_name: 'ZZTEST Heater 1kW', parent_job_card_id: A });
    await tick(P1, ALL);
    const A0 = await cardRow(A);

    // Everything that must NOT move on a query split. Scoped to this run's
    // made-up items, drawings and cards — the database is live, and a real
    // Finished Goods movement during the run must not read as ours.
    const snapshot = async () => ({
      stock: await qa('SELECT id, current_stock::float AS s FROM inventory_items WHERE id = ANY($1) ORDER BY id', [items]),
      lines: await qa('SELECT inventory_item_id AS inv, qty::float AS q, COALESCE(qty_deducted,0)::float AS d, COALESCE(qty_waived,0)::float AS w FROM order_item_inventory WHERE order_item_id=$1 ORDER BY inventory_item_id', [oiA]),
      moves: Number((await q1('SELECT COUNT(*) AS n FROM inventory_transactions WHERE item_id = ANY($1)', [items])).n),
      bins: Number((await q1('SELECT COALESCE(SUM(qty),0) AS n FROM inventory_rework_bins WHERE item_id = ANY($1)', [items])).n),
      fg: Number((await q1("SELECT COALESCE(SUM(qty_available),0) AS n FROM finished_goods WHERE drawing_no LIKE 'ZZTEST-%'")).n),
      fgRows: Number((await q1("SELECT COUNT(*) AS n FROM finished_goods WHERE drawing_no LIKE 'ZZTEST-%'")).n),
      fgLog: Number((await q1("SELECT COUNT(*) AS n FROM finished_goods_log WHERE job_card_no LIKE 'ZZT-Q%'")).n),
      pins: await pinsOf(A),
    });
    const diff = (a, b) => Object.keys(a).filter(k => !same(a[k], b[k])).map(k => `${k}: ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`).join('; ');

    // ════ A. 3 of 50 come back ════
    let s0 = await snapshot();
    let r = await raise({ order_id: oA, job_card_id: A, subject: 'ZZTEST 3 pcs leaking at the nipple', description: 'three heaters', category: 'quality', priority: 'high', assigned_department: 'production', qty: 3 });
    const Q1 = r.body.id;
    const C1 = await cardByNo('ZZT-QA1-Q1');
    ok('A1. raised with 3 of 50: 201, the query is tied to a new card ZZT-QA1-Q1 (not to the parent), answer says 3 of 50 and names the -Q card',
      r.status === 201 && !!Q1 && !!C1 && r.body.job_card_id === C1.id && r.body.split_job_card_id === C1.id && r.body.split_job_card_no === 'ZZT-QA1-Q1'
      && r.body.qty === 3 && r.body.qty_of === 50 && /^CQ-\d{8}-\d{4}$/.test(r.body.query_no || ''), `${r.status} ${JSON.stringify(r.body)}`);
    ok('A1. numbered -Q1 although the card already has a -P1 child — only -Q children count',
      !!C1 && !(await cardByNo('ZZT-QA1-Q2')) && (await kidsOf(A)).map(k => k.job_card_no).join(',') === 'ZZT-QA1-P1,ZZT-QA1-Q1', JSON.stringify(await kidsOf(A)));
    ok('A2. the -Q1 card: 3 pcs, status customer_query, parent ZZT-QA1, same order / line / dispatch date / punching / drawing / product / document',
      !!C1 && Number(C1.qty) === 3 && C1.status === 'customer_query' && C1.parent_job_card_id === A && C1.order_id === oA && C1.order_item_id === oiA
      && sameTime(C1.dispatch_date, A0.dispatch_date) && C1.punching === 'ZZT-PUNCH' && C1.drawing_no === 'ZZTEST-DWG-QA' && C1.product_name === 'ZZTEST Heater 1kW'
      && C1.file_path === A0.file_path && C1.file_name === A0.file_name && C1.original_name === A0.original_name && C1.is_fg === false,
      JSON.stringify(C1).slice(0, 400));
    ok('A2. it still counts as dispatched: dispatched_at copied, QC route copied, 3 routed to dispatch, 0 to Finished Goods',
      !!C1 && sameTime(C1.dispatched_at, T_OUT) && C1.qc_route === 'dispatch' && Number(C1.qc_dispatch_qty) === 3 && Number(C1.qc_fg_qty) === 0,
      C1 && JSON.stringify({ dispatched_at: C1.dispatched_at, qc_route: C1.qc_route, qc_dispatch_qty: C1.qc_dispatch_qty, qc_fg_qty: C1.qc_fg_qty }));
    ok('A2. made and settled on the parent, so every flag travels: tube / coil / fill / fins deducted, last stage taken, Product QC and Inventory QC passed, plating done',
      !!C1 && C1.tube_deducted === true && C1.coil_deducted === true && C1.fill_deducted === true && C1.fins_deducted === true
      && sameTime(C1.last_stage_taken_at, T_TAKE) && sameTime(C1.product_qc_at, T_QC) && C1.product_qc_by === uid
      && sameTime(C1.inventory_qc_at, T_QC) && C1.inventory_qc_by === uid && C1.plating_status === 'returned',
      C1 && JSON.stringify({ tube: C1.tube_deducted, coil: C1.coil_deducted, fill: C1.fill_deducted, fins: C1.fins_deducted, take: C1.last_stage_taken_at, pqc: C1.product_qc_at, iqc: C1.inventory_qc_at, plating: C1.plating_status }));
    ok('A2. its note says which query and how many: "Customer query CQ-…: 3 of ZZT-QA1 affected"',
      !!C1 && C1.notes === `Customer query ${r.body.query_no}: 3 of ZZT-QA1 affected`, C1?.notes);
    let a = await cardRow(A);
    ok('A3. the parent keeps the rest: 47 pcs, 47 routed to dispatch, status STILL dispatched (not customer_query), dispatched_at untouched',
      Number(a.qty) === 47 && Number(a.qc_dispatch_qty) === 47 && a.status === 'dispatched' && sameTime(a.dispatched_at, T_OUT)
      && a.product_name === 'ZZTEST Heater 1kW' && a.drawing_no === 'ZZTEST-DWG-QA' && a.file_path === A0.file_path,
      JSON.stringify({ qty: a.qty, qc_dispatch_qty: a.qc_dispatch_qty, status: a.status }));
    let st = C1 ? await doneStages(C1.id) : [];
    let s29 = C1 ? await stageRow(C1.id, 29) : null;
    let s8 = C1 ? await stageRow(C1.id, 8) : null;
    ok('A4. the checklist is copied onto -Q1 — all 29 done stages INCLUDING 29 Ready for Dispatch (the pieces were finished), with the readings and the worker',
      same(st, ALL) && !!s29 && Number(s29.done) === 1 && !!s8 && s8.value1 === 'v8' && s8.worker_name === 'ZZTEST Worker', `stages ${JSON.stringify(st)} s29 ${JSON.stringify(s29)}`);
    ok('A4. the parent\'s checklist is untouched: 29 stages still done', same(await doneStages(A), ALL));
    ok('A4. the dispatched count on the Ready-for-Dispatch row follows the pieces: parent 47, -Q1 3 (the dispatch list and job card page read it)',
      Number((await stageRow(A, 29))?.dispatched_qty) === 47 && Number(s29?.dispatched_qty) === 3,
      JSON.stringify({ parent: (await stageRow(A, 29))?.dispatched_qty, child: s29?.dispatched_qty }));
    let s1 = await snapshot();
    ok('A5. NOTHING moved in stock: item stock, the list\'s taken / waived, stock rows, rework bins, Finished Goods — all exactly as before',
      !diff(s0, s1), diff(s0, s1));
    ok('A5. the parent\'s terminal pins are left alone (it took its last stage; a dispatched card is past pins): still 50 PIN from list, no "scaled" line, the -Q card has no rows',
      same(s1.pins, [{ inv: PIN, q: 50, source: 'list' }]) && !hasLine(await lines(A), 'terminals_changed', /./) && !logs.some(l => l.jc === A && l.type === 'terminals_changed')
      && !!C1 && (await pinsOf(C1.id)).length === 0,
      JSON.stringify(s1.pins));
    let qrow = await queryRow(Q1);
    ok('A6. the query row: job_card_id = the -Q1 card, qty 3, qty_of 50 (the pieces that had gone out), split_job_card_id = -Q1, open',
      !!qrow && !!C1 && qrow.job_card_id === C1.id && Number(qrow.qty) === 3 && Number(qrow.qty_of) === 50 && qrow.split_job_card_id === C1.id && qrow.status === 'open'
      && qrow.order_id === oA && qrow.created_by === uid, JSON.stringify(qrow).slice(0, 300));
    ok('A6. the order goes to customer_query', (await orderStatus(oA)) === 'customer_query');
    let la = await lines(A), lc = C1 ? await lines(C1.id) : [];
    ok('A7. the parent\'s timeline: "3 of this card raised as query CQ-… → ZZT-QA1-Q1"',
      hasLine(la, 'customer_query_split', new RegExp(`^3 of this card raised as query ${r.body.query_no} → ZZT-QA1-Q1$`)), la.map(l => l.d).join(' | '));
    ok('A7. the -Q1 card\'s timeline: the split line (3 of ZZT-QA1, 50 sent out) with nothing changed on it, and the query raised "(3 of 50 pcs, as ZZT-QA1-Q1)"',
      hasLine(lc, 'customer_query_split', new RegExp(`^ZZT-QA1-Q1: 3 of ZZT-QA1 \\(50 sent out\\) raised as query ${r.body.query_no}$`))
      && hasLine(lc, 'customer_query_raised', /ZZTEST 3 pcs leaking at the nipple \(3 of 50 pcs, as ZZT-QA1-Q1\)$/) && !lc.some(l => /Changed on this card/.test(l.d)),
      lc.map(l => l.d).join(' | '));
    let capC = C1 ? await capasOf(C1.id) : [], capA = await capasOf(A);
    ok('A8. the CAPA sits on the -Q1 card (customer_query trigger, linked to the query, open) — none on the parent',
      capC.length === 1 && capC[0].trigger_type === 'customer_query' && capC[0].customer_query_id === Q1 && capC[0].status === 'open' && capA.length === 0
      && logs.some(l => l.jc === C1?.id && l.type === 'capa_created'), JSON.stringify({ capC, capA }));
    ok('A8. the owner / production / admin logins are told a CAPA is required on ZZT-QA1-Q1, with a WhatsApp copy each',
      (await qa(`SELECT 1 FROM notifications WHERE type='capa_required' AND title=$1`, ['CAPA required — ZZT-QA1-Q1'])).length > 0
      && waCalls.filter(w => w.type === 'capa_required' && /ZZT-QA1-Q1/.test(w.title || '')).length > 0, `wa ${waCalls.length}`);

    // ── How the query reads back ──
    r = await call('GET', CQ);
    let row = (r.body || []).find(x => x.id === Q1);
    ok('A9. GET /customer-queries: the row carries qty 3, qty_of 50, split_job_card_id, job_card_no = the -Q card, parent_job_card_no = the card the pieces came off',
      r.status === 200 && !!row && row.qty === 3 && row.qty_of === 50 && row.split_job_card_id === C1?.id && row.job_card_no === 'ZZT-QA1-Q1' && row.parent_job_card_no === 'ZZT-QA1',
      JSON.stringify(row).slice(0, 300));
    r = await call('GET', `${CQ}/order/${oA}`);
    row = (r.body || []).find(x => x.id === Q1);
    ok('A9. GET /customer-queries/order/:id: the same', r.status === 200 && !!row && row.qty === 3 && row.qty_of === 50 && row.job_card_no === 'ZZT-QA1-Q1' && row.parent_job_card_no === 'ZZT-QA1', JSON.stringify(row).slice(0, 300));
    r = await call('GET', `${CQ}/${Q1}`);
    ok('A9. GET /customer-queries/:id: detail adds parent_job_card_id, and the tied card\'s own qty / status (3, customer_query)',
      r.status === 200 && r.body.qty === 3 && r.body.qty_of === 50 && r.body.job_card_no === 'ZZT-QA1-Q1' && r.body.parent_job_card_id === A && r.body.parent_job_card_no === 'ZZT-QA1'
      && r.body.jc_qty === 3 && r.body.jc_status === 'customer_query', JSON.stringify(r.body).slice(0, 300));
    r = C1 ? await call('GET', `/api/job-cards/${C1.id}`) : { body: {} };
    let rp = await call('GET', `/api/job-cards/${A}`);
    ok('A10. the -Q1 card shows its own query; the parent shows none (its pieces are fine)',
      r.body.active_query_id === Q1 && r.body.active_query_no === qrow?.query_no && rp.status === 200 && rp.body.active_query_id === undefined && Number(rp.body.qty) === 47,
      JSON.stringify({ child: r.body.active_query_id, parent: rp.body.active_query_id }));
    r = await call('GET', '/api/job-cards');
    let listA = (r.body || []).filter(x => x.id === A), listC = (r.body || []).filter(x => x.id === C1?.id);
    ok('A10. in the job-card list the parent appears once with no active query; -Q1 once with its query',
      listA.length === 1 && listA[0].active_query_id === null && listC.length === 1 && listC[0].active_query_id === Q1,
      JSON.stringify({ A: listA.map(x => x.active_query_id), C: listC.map(x => x.active_query_id) }));

    // ════ B. A second query on the same parent, with the owner's corrections ════
    // "I should be allowed to change the job card and name of the product if
    // needed just in case they were wrong completely" — a different document,
    // product name and drawing no go on the NEW card only.
    const pdf = { name: 'ZZTEST-corrected-card.pdf', type: 'application/pdf', bytes: Buffer.from('%PDF-1.4\n% ZZTEST corrected job card\n') };
    r = await callForm('POST', CQ, {
      order_id: oA, job_card_id: A, subject: 'ZZTEST 3 more — wrong drawing', assigned_department: 'design', qty: '3',
      product_name: 'ZZTEST Heater 1kW (corrected)', drawing_no: 'ZZTEST-DWG-QA-FIX',
    }, pdf);
    const Q2 = r.body.id;
    const C2 = await cardByNo('ZZT-QA1-Q2');
    ok('B1. multipart with a document, product name and drawing no, 3 of the remaining 47: 201, split off as ZZT-QA1-Q2, "3 of 47"',
      r.status === 201 && !!Q2 && !!C2 && r.body.split_job_card_no === 'ZZT-QA1-Q2' && r.body.job_card_id === C2.id && r.body.qty === 3 && r.body.qty_of === 47,
      `${r.status} ${JSON.stringify(r.body)}`);
    ok('B2. the corrections are on the -Q2 card only: the new document (storage path job-cards/<time>_ZZTEST-corrected-card.pdf), the new product name, the new drawing no',
      !!C2 && /^job-cards\/\d+_ZZTEST-corrected-card\.pdf$/.test(C2.file_path || '') && C2.file_name === C2.file_path.replace(/^job-cards\//, '') && C2.original_name === 'ZZTEST-corrected-card.pdf'
      && C2.product_name === 'ZZTEST Heater 1kW (corrected)' && C2.drawing_no === 'ZZTEST-DWG-QA-FIX' && Number(C2.qty) === 3 && C2.status === 'customer_query' && sameTime(C2.dispatched_at, T_OUT),
      C2 && JSON.stringify({ file_path: C2.file_path, file_name: C2.file_name, original_name: C2.original_name, product_name: C2.product_name, drawing_no: C2.drawing_no }));
    ok('B2. the document went through the real upload middleware to the job-cards folder (recorded, not stored)',
      stored.length === 1 && stored[0].path === C2?.file_path && stored[0].bytes === pdf.bytes.length && stored[0].type === 'application/pdf', JSON.stringify(stored));
    a = await cardRow(A);
    let c1 = C1 ? await cardRow(C1.id) : null;
    ok('B3. the parent and -Q1 keep their own document, name and drawing; the parent is down to 44',
      a.file_path === A0.file_path && a.product_name === 'ZZTEST Heater 1kW' && a.drawing_no === 'ZZTEST-DWG-QA' && Number(a.qty) === 44 && Number(a.qc_dispatch_qty) === 44 && a.status === 'dispatched'
      && !!c1 && c1.file_path === A0.file_path && c1.product_name === 'ZZTEST Heater 1kW' && c1.drawing_no === 'ZZTEST-DWG-QA' && Number(c1.qty) === 3,
      JSON.stringify({ a: [a.qty, a.product_name, a.drawing_no], c1: [c1?.qty, c1?.product_name, c1?.drawing_no] }));
    lc = C2 ? await lines(C2.id) : [];
    ok('B4. what was changed is on the -Q2 card\'s timeline: the document, "product name … → …", "drawing no … → …"',
      hasLine(lc, 'customer_query_split', /^ZZT-QA1-Q2: 3 of ZZT-QA1 \(47 sent out\) raised as query CQ-\d{8}-\d{4}\. Changed on this card: job card document ZZTEST-corrected-card\.pdf; product name "ZZTEST Heater 1kW" → "ZZTEST Heater 1kW \(corrected\)"; drawing no "ZZTEST-DWG-QA" → "ZZTEST-DWG-QA-FIX"$/),
      lc.map(l => l.d).join(' | '));
    ok('B4. the parent\'s line for it: "3 of this card raised as query … → ZZT-QA1-Q2"', hasLine(await lines(A), 'customer_query_split', /^3 of this card raised as query CQ-\d{8}-\d{4} → ZZT-QA1-Q2$/));
    qrow = await queryRow(Q2);
    ok('B5. the query row: tied to -Q2, 3 of 47; each -Q card carries its own query and its own CAPA',
      !!qrow && !!C2 && qrow.job_card_id === C2.id && Number(qrow.qty) === 3 && Number(qrow.qty_of) === 47 && qrow.split_job_card_id === C2.id
      && (await capasOf(C2.id)).length === 1 && (await capasOf(C1.id)).length === 1 && (await capasOf(A)).length === 0
      && (await call('GET', `/api/job-cards/${C2.id}`)).body.active_query_id === Q2 && (await call('GET', `/api/job-cards/${C1.id}`)).body.active_query_id === Q1,
      JSON.stringify(qrow).slice(0, 200));
    ok('B5. the checklist copied onto -Q2 too, incl. stage 29; stock still untouched',
      !!C2 && same(await doneStages(C2.id), ALL) && !diff(s0, await snapshot()), diff(s0, await snapshot()));

    // A third, plain JSON — the numbering keeps counting -Q children.
    r = await raise({ order_id: oA, job_card_id: A, subject: 'ZZTEST 3 to replace', assigned_department: 'production', qty: '3' });
    const Q3 = r.body.id;
    const C3 = await cardByNo('ZZT-QA1-Q3');
    a = await cardRow(A);
    ok('B6. a third query (3 of 44) → ZZT-QA1-Q3; the parent is down to 41 and still dispatched',
      r.status === 201 && !!C3 && r.body.split_job_card_no === 'ZZT-QA1-Q3' && r.body.qty_of === 44 && Number(C3.qty) === 3 && Number(a.qty) === 41 && Number(a.qc_dispatch_qty) === 41 && a.status === 'dispatched',
      `${r.status} ${JSON.stringify(r.body)} | parent ${a.qty}`);

    // ════ C. What is refused ════
    const before = { kids: (await kidsOf(A)).length, queries: (await queriesOf(oA)).length, capas: (await capasOf(A)).length, stored: stored.length };
    const bad = (body, as = owner) => raise({ order_id: oA, job_card_id: A, subject: 'ZZTEST refused', assigned_department: 'production', ...body }, as);
    let v = await bad({ qty: 0 });
    ok('C1. 0 pieces refused — between 1 and the 41 that are out', v.status === 400 && /between 1 and 41 — ZZT-QA1 sent out 41 pcs/.test(v.body.error || ''), v.body.error);
    v = await bad({ qty: 42 });
    ok('C1. 42 of 41 refused', v.status === 400 && /between 1 and 41/.test(v.body.error || ''), v.body.error);
    v = await bad({ qty: '2.5' });
    ok('C1. 2.5 refused — whole numbers', v.status === 400 && /whole number/.test(v.body.error || ''), v.body.error);
    v = await bad({ qty: 'abc' });
    ok('C1. "abc" refused', v.status === 400 && /whole number/.test(v.body.error || ''), v.body.error);
    v = await bad({ qty: '-1' });
    ok('C1. -1 refused', v.status === 400 && /whole number/.test(v.body.error || ''), v.body.error);
    v = await bad({ product_name: 'ZZTEST something else' });
    ok('C2. a different product name with ALL pieces affected is refused — there is no new card to put it on; the card itself is edited from its own screen',
      v.status === 400 && /applies only when fewer than all the pieces are affected/.test(v.body.error || ''), v.body.error);
    v = await bad({ qty: 41, drawing_no: 'ZZTEST-DWG-OTHER' });
    ok('C2. the same for a different drawing no with qty = all (41)', v.status === 400 && /applies only when fewer/.test(v.body.error || ''), v.body.error);
    v = await callForm('POST', CQ, { order_id: oA, job_card_id: A, subject: 'ZZTEST refused', assigned_department: 'production' }, pdf);
    ok('C2. a document with all pieces affected is refused the same way (the upload itself ran first — the file is in storage, as with the resolve flow)',
      v.status === 400 && /applies only when fewer/.test(v.body.error || ''), `${v.body.error} | stored ${stored.length} (was ${before.stored})`);
    v = await raise({ order_id: oA, subject: 'ZZTEST refused', assigned_department: 'production', product_name: 'ZZTEST no card' });
    ok('C2. a correction with no job card on the query is refused', v.status === 400 && /needs a job card on the query/.test(v.body.error || ''), v.body.error);
    v = await bad({ qty: 2 }, floor);
    ok('C3. production cannot raise a query', v.status === 403, JSON.stringify(v.body));
    v = await raise({ order_id: oA, job_card_id: A, assigned_department: 'production', qty: 2 });
    ok('C3. no subject refused (as today)', v.status === 400 && /Subject/.test(v.body.error || ''), v.body.error);
    v = await raise({ order_id: oA, job_card_id: A, subject: 'ZZTEST', qty: 2 });
    ok('C3. no department refused (as today)', v.status === 400 && /department/i.test(v.body.error || ''), v.body.error);
    v = await raise({ order_id: oA, job_card_id: 999999999, subject: 'ZZTEST', assigned_department: 'production', qty: 2 });
    ok('C3. a job card that does not exist: 404', v.status === 404, v.body.error);
    a = await cardRow(A);
    ok('C4. none of it changed anything: no new -Q card, no new query, no CAPA on the parent, parent still 41 and dispatched',
      (await kidsOf(A)).length === before.kids && (await queriesOf(oA)).length === before.queries && (await capasOf(A)).length === before.capas
      && Number(a.qty) === 41 && a.status === 'dispatched', JSON.stringify({ kids: (await kidsOf(A)).length, queries: (await queriesOf(oA)).length }));

    // A card still on the floor has no pieces at the customer.
    const oC = await mkOrder('ZZT-QC', 'in_progress');
    const oiC = await mkLine(oC, 10, 'ZZTEST-DWG-QC');
    const C = await mkCard({ job_card_no: 'ZZT-QC1', order_id: oC, order_item_id: oiC, qty: 10, status: 'in_progress', dispatch_date: today, drawing_no: 'ZZTEST-DWG-QC', is_fg: false, current_stage: 10 });
    await tick(C, ALL.slice(0, 10));
    v = await raise({ order_id: oC, job_card_id: C, subject: 'ZZTEST on the floor', assigned_department: 'production', qty: 2 });
    ok('C5. a card still in production cannot be queried: "ZZT-QC1 has not been dispatched — a customer query is for pieces that went out."',
      v.status === 400 && v.body.error === 'ZZT-QC1 has not been dispatched — a customer query is for pieces that went out.', `${v.status} ${v.body.error}`);
    v = await raise({ order_id: oC, job_card_id: C, subject: 'ZZTEST on the floor', assigned_department: 'production' });
    ok('C5. nor with all its pieces (blank qty)', v.status === 400 && /has not been dispatched/.test(v.body.error || ''), v.body.error);
    ok('C5. the card is untouched: in_progress, 10 pcs, no child, no query on its order',
      (await cardRow(C)).status === 'in_progress' && Number((await cardRow(C)).qty) === 10 && (await kidsOf(C)).length === 0 && (await queriesOf(oC)).length === 0);
    // A card once dispatched but back on the floor for repair keeps its
    // dispatched_at — its pieces are not at the customer, so no new query on it.
    const CR = await dispatchedCard(oC, oiC, 'ZZT-QC2', 10, { status: 'repair_in_progress' });
    v = await raise({ order_id: oC, job_card_id: CR, subject: 'ZZTEST back for repair', assigned_department: 'production', qty: 2 });
    ok('C6. a dispatched card back in repair (repair_in_progress, dispatched_at set) cannot be queried again — its pieces are on the floor',
      v.status === 400 && /has not been dispatched/.test(v.body.error || '') && (await kidsOf(CR)).length === 0, `${v.status} ${v.body.error}`);
    v = await raise({ order_id: oC, subject: 'ZZTEST order-level query', assigned_department: 'accounts' });
    ok('C6. a query on the order with no job card still works as today: no qty, no card, no split',
      v.status === 201 && v.body.job_card_id === null && v.body.qty === null && v.body.qty_of === null && v.body.split_job_card_id === null && (await orderStatus(oC)) === 'customer_query',
      `${v.status} ${JSON.stringify(v.body)}`);

    // ════ D. All the pieces affected → no split, as today ════
    // Card B went out before QC routing existed (qc_dispatch_qty NULL): the
    // pieces out fall back to its qty, 10. Blank qty = all of them.
    const oB = await mkOrder('ZZT-QB');
    const oiB = await mkLine(oB, 10, 'ZZTEST-DWG-QB');
    const B = await dispatchedCard(oB, oiB, 'ZZT-QB1', 10, { qc_dispatch_qty: null, qc_route: null, last_stage_taken_at: null });
    await tick(B, ALL);
    r = await raise({ order_id: oB, job_card_id: B, subject: 'ZZTEST whole card', assigned_department: 'production' });
    const QB = r.body.id;
    let b = await cardRow(B);
    qrow = await queryRow(QB);
    ok('D1. blank qty on a card of 10 (no QC routing): 201, tied to the card itself, 10 of 10, no split',
      r.status === 201 && r.body.job_card_id === B && r.body.qty === 10 && r.body.qty_of === 10 && r.body.split_job_card_id === null && r.body.split_job_card_no === null,
      `${r.status} ${JSON.stringify(r.body)}`);
    ok('D1. the card itself goes customer_query (as today), still 10 pcs, no -Q child, checklist untouched; the query stores 10 of 10 anyway',
      b.status === 'customer_query' && Number(b.qty) === 10 && (await kidsOf(B)).length === 0 && same(await doneStages(B), ALL)
      && !!qrow && Number(qrow.qty) === 10 && Number(qrow.qty_of) === 10 && qrow.split_job_card_id === null && qrow.job_card_id === B,
      JSON.stringify({ status: b.status, qty: b.qty, q: qrow }));
    r = await call('GET', CQ);
    row = (r.body || []).find(x => x.id === QB);
    ok('D1. the list reads it as the whole card: job_card_no ZZT-QB1, no parent, 10 of 10; the timeline says "(10 of 10 pcs)" with no -Q card',
      !!row && row.job_card_no === 'ZZT-QB1' && row.parent_job_card_no === null && row.qty === 10 && row.qty_of === 10 && row.split_job_card_id === null
      && hasLine(await lines(B), 'customer_query_raised', /\(10 of 10 pcs\)$/), JSON.stringify(row).slice(0, 200));
    ok('D1. the CAPA sits on the card itself', (await capasOf(B)).length === 1 && (await capasOf(B))[0].customer_query_id === QB);

    // ════ E. Repair on the first query reopens only the -Q1 card's stages ════
    r = await call('PUT', `${CQ}/${Q1}/resolve`, { resolution_summary: 'ZZTEST coming back for repair', resolution_type: 'product_return' });
    c1 = await cardRow(C1.id); a = await cardRow(A);
    ok('E1. product return on the query: -Q1 goes product_return, the parent stays dispatched',
      r.status === 200 && (await queryRow(Q1)).status === 'product_return' && (await queryRow(Q1)).return_status === 'pending_return'
      && c1.status === 'product_return' && a.status === 'dispatched' && Number(a.qty) === 41, `${r.status} ${JSON.stringify(r.body)} | ${c1.status} / ${a.status}`);
    r = await call('PUT', `${CQ}/${Q1}/return-type`, { return_type: 'repair' });
    ok('E2. return type repair with the next coupon off the ledger', r.status === 200 && /^RET-\d{3,}$/.test(r.body.return_coupon_no || ''), JSON.stringify(r.body));
    r = await call('PUT', `${CQ}/${Q1}/material-received`, { repair_from_stage: 20 });
    ok('E3. material received is held by the CAPA on the -Q1 card (not approved yet) — the cause before the rework',
      r.status === 400 && r.body.code === 'CAPA_REQUIRED' && r.body.capa_id === capC[0]?.id, `${r.status} ${JSON.stringify(r.body)}`);
    // The owner approves the CAPA (the CAPA chat itself is not under test).
    await client.query(`UPDATE capa_reports SET status='approved', approved_by=$2, approved_at=NOW() WHERE job_card_id=$1 AND status IN ('open','awaiting_approval')`, [C1.id, uid]);
    r = await call('PUT', `${CQ}/${Q1}/material-received`, { repair_from_stage: 20 });
    c1 = await cardRow(C1.id);
    ok('E3. with the CAPA approved: sent to production for repair from stage 20',
      r.status === 200 && /from stage 20/.test(r.body.message || '') && (await queryRow(Q1)).return_status === 'in_repair', `${r.status} ${JSON.stringify(r.body)}`);
    ok('E4. only the -Q1 card is reopened: stages 1–19 stay done, 20–29 cleared, status repair_in_progress, current stage 19',
      same(await doneStages(C1.id), ALL.slice(0, 19)) && c1.status === 'repair_in_progress' && Number(c1.current_stage) === 19, `${JSON.stringify(await doneStages(C1.id))} ${c1.status} ${c1.current_stage}`);
    ok('E4. the parent, -Q2 and -Q3 are untouched: all 29 stages still done, parent dispatched with 41',
      same(await doneStages(A), ALL) && same(await doneStages(C2.id), ALL) && same(await doneStages(C3.id), ALL)
      && (await cardRow(A)).status === 'dispatched' && Number((await cardRow(A)).qty) === 41 && (await cardRow(C2.id)).status === 'customer_query');
    ok('E4. on the -Q1 card\'s timeline, not the parent\'s', logs.some(l => l.jc === C1.id && l.type === 'material_received' && /Repair restarts at stage 20/.test(l.desc)) && !logs.some(l => l.jc === A && l.type === 'material_received'));
    r = await call('PUT', `${CQ}/${Q1}/repair-complete`, { shipping_carrier: 'ZZTEST Courier', tracking_number: 'ZZT-001' });
    c1 = await cardRow(C1.id);
    ok('E5. repair complete: the -Q1 card is repaired_dispatched with a fresh dispatched_at; the query is resolved; the parent as it was',
      r.status === 200 && c1.status === 'repaired_dispatched' && !sameTime(c1.dispatched_at, T_OUT) && (await queryRow(Q1)).status === 'resolved' && (await queryRow(Q1)).return_status === 'repaired_dispatched'
      && (await cardRow(A)).status === 'dispatched', `${r.status} ${c1.status} | order now ${await orderStatus(oA)} (recomputed from every card, as before)`);

    // ════ F. Debit note on the second query puts only ITS 3 into Finished Goods ════
    s0 = await snapshot();
    r = await call('PUT', `${CQ}/${Q2}/resolve`, { resolution_summary: 'ZZTEST coming back against a debit note', resolution_type: 'product_return' });
    let r2 = await call('PUT', `${CQ}/${Q2}/return-type`, { return_type: 'debit_note' });
    let r3 = await call('PUT', `${CQ}/${Q2}/material-received`, {});
    let c2 = await cardRow(C2.id);
    ok('F1. return → debit note → material received: the -Q2 card goes to QC (qc_pending), the query to qc_check',
      r.status === 200 && r2.status === 200 && r3.status === 200 && c2.status === 'qc_pending' && (await queryRow(Q2)).return_status === 'qc_check',
      `${r.status} ${r2.status} ${r3.status} ${c2.status}`);
    r = await call('PUT', `${CQ}/${Q2}/qc-result`, { result: 'pass' });
    c2 = await cardRow(C2.id);
    let fg = await fgOf(C2.id);
    let fgl = await fgLogOf('ZZT-QA1-Q2');
    s1 = await snapshot();
    ok('F2. QC pass: exactly 3 go into Finished Goods — a row for the -Q2 card (under ITS corrected drawing), 3 in / 3 available, one inward log line of 3',
      r.status === 200 && !!fg && near(fg.qi, 3) && near(fg.qa, 3) && fg.drawing_no === 'ZZTEST-DWG-QA-FIX' && fg.base_drawing_no === 'ZZTEST-DWG-QA-FIX'
      && fgl.length === 1 && fgl[0].m === 'inward' && near(fgl[0].q, 3) && /Return from customer — QC passed/.test(fgl[0].notes || '')
      && near(s1.fg - s0.fg, 3) && s1.fgRows - s0.fgRows === 1 && s1.fgLog - s0.fgLog === 1,
      `${r.status} ${JSON.stringify(r.body)} | fg ${JSON.stringify(fg)} | log ${JSON.stringify(fgl)} | ΔFG ${s1.fg - s0.fg}`);
    ok('F2. not 41, not 50: no Finished Goods row for the parent, which keeps its 41 dispatched; the -Q2 card reads completed; nothing else in stock moved',
      !(await fgOf(A)) && !(await fgLogOf('ZZT-QA1')).length && Number((await cardRow(A)).qty) === 41 && (await cardRow(A)).status === 'dispatched' && c2.status === 'completed'
      && same(s0.stock, s1.stock) && same(s0.lines, s1.lines) && s0.moves === s1.moves, diff(s0, s1));
    r = await call('PUT', `${CQ}/${Q2}/debit-note-complete`, {});
    ok('F3. debit note complete closes the query; the -Q2 card reads dispatched', r.status === 200 && (await queryRow(Q2)).status === 'resolved' && (await queryRow(Q2)).return_status === 'debit_note_issued' && (await cardRow(C2.id)).status === 'dispatched');

    // ════ G. Replacement on the third query clones only ITS 3 ════
    r = await call('PUT', `${CQ}/${Q3}/resolve`, { resolution_summary: 'ZZTEST replace without waiting', resolution_type: 'replaced' });
    const RPL = r.body.job_card_id ? await cardRow(r.body.job_card_id) : null;
    ok('G1. replaced: a new production card ZZT-QA1-Q3-RPL for 3 pcs (the -Q3 card\'s qty, not the parent\'s 41), on the same line, linked to the query',
      r.status === 200 && !!RPL && RPL.job_card_no === 'ZZT-QA1-Q3-RPL' && Number(RPL.qty) === 3 && RPL.replacement_query_id === Q3 && RPL.order_item_id === oiA && RPL.order_id === oA
      && RPL.drawing_no === 'ZZTEST-DWG-QA' && RPL.product_name === 'ZZTEST Heater 1kW' && RPL.parent_job_card_id === null && /^Replacement for query CQ-/.test(RPL.notes || ''),
      `${r.status} ${JSON.stringify(r.body)} | ${RPL && JSON.stringify({ no: RPL.job_card_no, qty: RPL.qty, link: RPL.replacement_query_id })}`);
    // (The pick is dated by the server's clock, not the database's — around
    // midnight the two can disagree, so only the pick itself is checked.)
    ok('G1. its checklist starts empty (a fresh run) and it is in today\'s work; production is told "3 pcs"',
      !!RPL && (await doneStages(RPL.id)).length === 0 && !!(await q1('SELECT 1 FROM production_day_picks WHERE job_card_id=$1', [RPL.id]))
      && (await qa(`SELECT body FROM notifications WHERE type='replacement_issued' AND link=$1`, [`/job-cards/${RPL.id}`])).every(n => /\(3 pcs/.test(n.body)),
      RPL && JSON.stringify(await qa(`SELECT body FROM notifications WHERE type='replacement_issued' AND link=$1 LIMIT 1`, [`/job-cards/${RPL.id}`])));
    ok('G1. the -Q3 card is closed as resolved_dispatched; the query resolved with a replacement issued; parent still 41 dispatched',
      (await cardRow(C3.id)).status === 'resolved_dispatched' && (await queryRow(Q3)).status === 'resolved' && (await queryRow(Q3)).return_status === 'replacement_issued'
      && Number((await cardRow(A)).qty) === 41 && (await cardRow(A)).status === 'dispatched');

    // ════ H. qty typed in = all the pieces that are out → no split (the parent itself) ════
    // The form prefills the product name and drawing no; sent back unchanged
    // they are not corrections, so they do not trip the "fewer than all" gate.
    r = await raise({ order_id: oA, job_card_id: A, subject: 'ZZTEST the rest too', assigned_department: 'production', qty: '41',
      product_name: 'ZZTEST Heater 1kW', drawing_no: 'ZZTEST-DWG-QA' });
    a = await cardRow(A);
    ok('H1. 41 of 41 typed in (with the prefilled name and drawing sent back as they are): 201, no -Q4, the query tied to ZZT-QA1 itself, 41 of 41 stored',
      r.status === 201 && r.body.job_card_id === A && r.body.split_job_card_id === null && r.body.qty === 41 && r.body.qty_of === 41 && !(await cardByNo('ZZT-QA1-Q4')),
      `${r.status} ${JSON.stringify(r.body)}`);
    ok('H1. the parent itself now carries the query: customer_query, still 41 pcs, its own CAPA, shown on its card',
      a.status === 'customer_query' && Number(a.qty) === 41 && (await capasOf(A)).length === 1 && (await call('GET', `/api/job-cards/${A}`)).body.active_query_id === r.body.id, `${a.status} ${a.qty}`);

    // ════ I. An older query with no qty still means the whole card ════
    const oD = await mkOrder('ZZT-QD');
    const oiD = await mkLine(oD, 20, 'ZZTEST-DWG-QD');
    const D = await dispatchedCard(oD, oiD, 'ZZT-QD1', 20);
    await tick(D, ALL);
    const QD = (await q1(
      `INSERT INTO customer_queries (query_no, order_id, job_card_id, subject, assigned_department, status, created_by)
       VALUES ('ZZT-CQ-LEGACY', $1, $2, 'ZZTEST query from before', 'production', 'open', $3) RETURNING id`, [oD, D, uid])).id;
    await client.query("UPDATE job_cards SET status='customer_query' WHERE id=$1", [D]);
    r = await call('GET', CQ);
    row = (r.body || []).find(x => x.id === QD);
    ok('I1. it reads as the whole card: qty / qty_of / split_job_card_id all NULL, job_card_no ZZT-QD1, no parent; the card shows it as its active query',
      !!row && row.qty === null && row.qty_of === null && row.split_job_card_id === null && row.job_card_no === 'ZZT-QD1' && row.parent_job_card_no === null
      && (await call('GET', `/api/job-cards/${D}`)).body.active_query_id === QD, JSON.stringify(row).slice(0, 200));
    r = await call('PUT', `${CQ}/${QD}/resolve`, { resolution_summary: 'ZZTEST old-style return', resolution_type: 'product_return' });
    r2 = await call('PUT', `${CQ}/${QD}/return-type`, { return_type: 'repair' });
    r3 = await call('PUT', `${CQ}/${QD}/material-received`, {});
    let d = await cardRow(D);
    ok('I2. repair on it (no CAPA on an old query, no start stage) reopens the WHOLE card as before: no stage done, repair_in_progress, 20 pcs, no -Q child',
      r.status === 200 && r2.status === 200 && r3.status === 200 && (await doneStages(D)).length === 0 && d.status === 'repair_in_progress' && Number(d.current_stage) === 0
      && Number(d.qty) === 20 && (await kidsOf(D)).length === 0, `${r.status} ${r2.status} ${r3.status} ${JSON.stringify(r3.body)} | ${d.status} ${(await doneStages(D)).length}`);

    // ════ J. Nothing leaked past the stubs ════
    ok('J1. every WhatsApp copy recorded was a CAPA or replacement alert for this run\'s cards',
      waCalls.length > 0 && waCalls.every(w => ['capa_required', 'replacement_issued'].includes(w.type) && /ZZT-Q/.test(w.title || '')),
      JSON.stringify([...new Set(waCalls.map(w => w.type))]) + ' ' + waCalls.filter(w => !/ZZT-Q/.test(w.title || '')).map(w => w.title).join(' | '));
    ok('J2. every document "stored" was this run\'s made-up PDF in the job-cards folder, bucket phe-uploads',
      stored.length === 2 && stored.every(s => s.bucket === 'phe-uploads' && /^job-cards\/\d+_ZZTEST-corrected-card\.pdf$/.test(s.path)), JSON.stringify(stored));
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
