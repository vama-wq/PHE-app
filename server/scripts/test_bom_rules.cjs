// Test for the inventory-correction rules (1 Oct 2026), on LIVE data inside one
// transaction that is ROLLED BACK: links the stock history, saves corrected
// lists through the real route and checks every stock figure. Nothing is kept.
//   node scripts/test_bom_rules.cjs
const path = require('path');
const S = path.join(__dirname, '..');
require(S + '/node_modules/dotenv').config({ path: S + '/.env' });

(async () => {
  const dbmod = require(S + '/src/db/index.js');
  const realPool = dbmod.getDB().pool;
  const client = await realPool.connect();
  await client.query('BEGIN');
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
  dbmod.logActivity = async (orderId, jc, type, desc) => { logs.push({ orderId, type, desc }); };
  const q1 = async (q, p = []) => (await client.query(q, p)).rows[0];
  const qa = async (q, p = []) => (await client.query(q, p)).rows;
  const designer = await q1("SELECT id, name, role FROM users WHERE id=4");
  const auth = require(S + '/src/middleware/auth.js');
  auth.authenticate = (req, res, next) => { req.user = designer; next(); };
  // Drawing uploads: no real file is stored — the upload step is stubbed.
  const upload = require(S + '/src/middleware/upload.js');
  upload.uploadOrderDrawing = [(req, res, next) => { if (req.body.__file) req.file = { storagePath: 'test/x.pdf', filename: 'x.pdf', originalname: 'x.pdf' }; next(); }];
  const express = require(S + '/node_modules/express');
  const app = express();
  app.use(express.json());
  app.use('/api/orders', require(S + '/src/routes/orders.js'));
  const server = app.listen(0);
  const base = 'http://127.0.0.1:' + server.address().port;
  const { linkStockHistory } = require(S + '/src/lib/linkStockHistory.js');
  const { ledgerForItem } = require(S + '/src/lib/stockLedger.js');
  const ded = require(S + '/src/lib/inventoryDeduction.js');

  let failed = false;
  const ok = (label, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  ' + String(extra).slice(0, 260) : '')); if (!cond) failed = true; };
  const stock = async (id) => Number((await q1('SELECT current_stock FROM inventory_items WHERE id=$1', [id])).current_stock);
  const lines = async (itemId) => qa(`SELECT oii.inventory_item_id AS id, oii.qty::float AS qty, oii.qty_deducted::float AS deducted,
      COALESCE(oii.qty_waived,0)::float AS waived, ii.item_code, TRIM(ii.category) AS category
      FROM order_item_inventory oii JOIN inventory_items ii ON ii.id=oii.inventory_item_id WHERE oii.order_item_id=$1 ORDER BY oii.inventory_item_id`, [itemId]);
  const save = async (orderId, itemId, sels) => {
    const r = await fetch(`${base}/api/orders/${orderId}/items/${itemId}/inventory`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inventory_item_ids: sels }) });
    return { status: r.status, body: await r.json() };
  };
  const asSels = (ls) => ls.map(l => ({ id: l.id, qty: l.qty }));
  const uploadDrawing = async (orderId, itemId, sels) => {
    const r = await fetch(`${base}/api/orders/${orderId}/drawings`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ __file: 1, item_id: String(itemId), inventory_item_ids: JSON.stringify(sels) }) });
    return { status: r.status, body: await r.json() };
  };
  const snapshot = async (ids) => { const o = {}; for (const id of new Set(ids)) o[id] = await stock(id); return o; };
  const unchanged = async (snap) => { for (const [id, v] of Object.entries(snap)) if (Math.abs((await stock(id)) - v) > 1e-6) return `item ${id}: ${v} → ${await stock(id)}`; return null; };
  const pickStock = async (exclude, min, cat = null) => q1(`SELECT id, item_code, current_stock::float AS s FROM inventory_items
      WHERE current_stock >= $1 AND id <> ALL($2) AND TRIM(COALESCE(category,'')) NOT ILIKE 'finns' AND item_code NOT ILIKE '%TRAIN%'
        AND COALESCE(approval_status,'approved')='approved' AND lower(COALESCE(unit,'')) IN ('pcs','nos','pc')
        ${cat ? `AND TRIM(category) = '${cat}'` : `AND TRIM(COALESCE(category,'')) NOT IN ('Flange','Flange Cap','Flange Spare','Brazing EQ','Nipple Fastner','Nipple Washer','Nipple Nut+Washer','Terminal Pin','Heavy Terminal Pin')`}
      ORDER BY current_stock DESC LIMIT 1`, [min, exclude]);

  try {
    // ── R1. Before the history is linked: record-only must never un-settle ──
    {
      const it = await q1(`SELECT oi.id, oi.order_id, o.order_code FROM order_items oi JOIN orders o ON o.id=oi.order_id
         WHERE oi.inventory_deducted = TRUE AND o.order_type <> 'finished_goods'
           AND EXISTS (SELECT 1 FROM job_cards jc WHERE jc.order_item_id=oi.id AND jc.status IN ('in_progress','pending','qc_pending'))
           AND EXISTS (SELECT 1 FROM order_item_inventory l WHERE l.order_item_id=oi.id AND l.qty_deducted > 0)
         ORDER BY oi.id LIMIT 1`);
      if (it) {
        const L0 = await lines(it.id);
        const snap = await snapshot(L0.map(l => l.id));
        const r = await save(it.order_id, it.id, asSels(L0));
        const L1 = await lines(it.id);
        const flag = (await q1('SELECT inventory_deducted f FROM order_items WHERE id=$1', [it.id])).f;
        ok(`${it.order_code} (list already taken, cards back in production): saving the same list moves nothing`, r.status === 200 && !(await unchanged(snap)), r.body.summary);
        ok('…and never un-settles it: same taken amounts kept, flag stays on', flag === true && L1.every(l => { const o = L0.find(x => x.id === l.id); return l.deducted + l.waived + 1e-6 >= o.deducted + o.waived; }), JSON.stringify(L1.slice(0, 2)));
        const cards = await qa('SELECT * FROM job_cards WHERE order_item_id=$1', [it.id]);
        for (const c of cards) { await ded.deductPartialAtQC(txDb, c, 4); await ded.deductStageCategories(txDb, c, 15, 4); await ded.deductStageCategories(txDb, c, 21, 4); }
        await ded.deductItemInventory(txDb, it.id, it.order_code, 4, 'test settle');
        ok('…so later stages, QC and settle take nothing a second time', !(await unchanged(snap)), await unchanged(snap));
      } else ok('No settled item with cards back in production right now (skipped)', true);
    }

    // ── 0. Link the history (inside this transaction) ──
    const linked = await linkStockHistory(client, { apply: true });
    const linkedTotal = Number((await q1('SELECT COUNT(*) n FROM inventory_transactions WHERE order_item_id IS NOT NULL')).n);
    ok(`History linked: ${linkedTotal} movements tied to their order line (${linked.link.size} newly in this run)`, linkedTotal > 1000);

    // ── A. The June TRAIN orders: record only, nothing moves ──
    for (const code of ['ORD-003-26', 'ORD-004-26', 'ORD-009-26', 'ORD-012-26', 'ORD-016-26', 'ORD-018-26', 'ORD-022-26', 'ORD-024-26']) {
      const it = await q1(`SELECT oi.id, oi.order_id FROM order_items oi JOIN orders o ON o.id=oi.order_id
         WHERE o.order_code=$1 AND EXISTS (SELECT 1 FROM inventory_transactions t WHERE t.order_item_id=oi.id AND t.source='correction') ORDER BY oi.id LIMIT 1`, [code]);
      const L = await ledgerForItem(txDb, it.id);
      ok(`${code}: history says TRAIN only, nothing real taken`, L.known && L.hadPlaceholder && !L.naturalReal, JSON.stringify({ known: L.known, ph: L.hadPlaceholder, real: L.naturalReal, why: L.why }));
    }
    {
      const it = await q1(`SELECT oi.id, oi.order_id FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.order_code='ORD-024-26' ORDER BY oi.id LIMIT 1`);
      const before = await lines(it.id);
      const extra = await pickStock(before.map(l => l.id), 50);
      const sels = [...asSels(before), { id: extra.id, qty: 24 }];
      const snap = await snapshot([...sels.map(s => s.id), ...(await qa('SELECT DISTINCT item_id FROM inventory_transactions WHERE order_item_id=$1', [it.id])).map(r => r.item_id)]);
      const r = await save(it.order_id, it.id, sels);
      ok('ORD-024-26 (June, TRAIN): saving a corrected list with an extra item is record-only', r.status === 200 && r.body.mode === 'record' && /TRAIN/.test(r.body.summary), JSON.stringify(r.body));
      ok('…no stock changed on any item', !(await unchanged(snap)), await unchanged(snap));
      const after = await lines(it.id);
      ok('…the new list is saved, settled without taking stock (waived = qty, taken = 0)', after.length === sels.length && after.every(l => l.deducted === 0 && Math.abs(l.waived - l.qty) < 1e-6), JSON.stringify(after.slice(0, 3)));
      ok('…and the order history says so', /list corrected only — stock not changed \(its old inventory was a TRAIN placeholder\)/.test(logs[logs.length - 1]?.desc), logs[logs.length - 1]?.desc);
      const r2 = await save(it.order_id, it.id, sels);
      ok('…saving it again still moves nothing', r2.body.mode === 'record' && !(await unchanged(snap)));
      // a later settle or stage on it takes nothing
      const card = await q1('SELECT * FROM job_cards WHERE order_item_id=$1 LIMIT 1', [it.id]);
      await client.query('UPDATE order_items SET inventory_deducted=FALSE WHERE id=$1', [it.id]);
      await ded.deductItemInventory(txDb, it.id, 'ORD-024-26', 4, 'test settle');
      await ded.deductStageCategories(txDb, card, 15, 4);
      ok('…even if a settle or a stage tick ran on it later, nothing would be taken', !(await unchanged(snap)), await unchanged(snap));
    }

    // ── B. A dispatched item that really was taken from real stock ──
    const unplaceable = ['ORD-005-26', 'ORD-017-26', 'ORD-019-26', 'ORD-025-26', 'ORD-040-26', 'ORD-078-26', 'ORD-092-26', 'ORD-119-26', 'ORD-124-26', 'ORD-135-26'];
    const cand = await q1(`
      WITH led AS (SELECT order_item_id, item_id, SUM(CASE WHEN transaction_type='dispatch_to_production' THEN quantity ELSE -quantity END) net,
                          bool_or(source='correction') corr FROM inventory_transactions WHERE source IN ('bom','correction') GROUP BY 1,2)
      SELECT oi.id, oi.order_id, o.order_code FROM order_items oi JOIN orders o ON o.id=oi.order_id
       WHERE o.order_type <> 'finished_goods' AND o.order_code <> ALL($1)
         AND EXISTS (SELECT 1 FROM job_cards jc WHERE jc.order_item_id=oi.id)
         AND NOT EXISTS (SELECT 1 FROM job_cards jc WHERE jc.order_item_id=oi.id AND jc.status <> 'dispatched')
         AND NOT EXISTS (SELECT 1 FROM led JOIN inventory_items ii ON ii.id=led.item_id WHERE led.order_item_id=oi.id AND (ii.item_code ILIKE '%TRAIN%' OR led.corr))
         AND EXISTS (SELECT 1 FROM led WHERE led.order_item_id=oi.id AND led.net > 0)
         AND NOT EXISTS (SELECT 1 FROM order_item_inventory l JOIN inventory_items ii ON ii.id=l.inventory_item_id
                          LEFT JOIN led ON led.order_item_id=l.order_item_id AND led.item_id=l.inventory_item_id
                          WHERE l.order_item_id=oi.id AND ii.item_code NOT LIKE 'FIN-%' AND abs(COALESCE(led.net,0) - l.qty) > 0.001)
         AND NOT EXISTS (SELECT 1 FROM order_item_inventory l WHERE l.order_item_id=oi.id AND (COALESCE(l.rework_qty,0)>0 OR COALESCE(l.rework_deducted,0)>0))
         AND (SELECT COUNT(*) FROM order_item_inventory l JOIN inventory_items ii ON ii.id=l.inventory_item_id
               WHERE l.order_item_id=oi.id AND TRIM(ii.category) NOT IN ('Terminal Pin','Heavy Terminal Pin') AND ii.item_code NOT LIKE 'FIN-%') > 0
       ORDER BY oi.id DESC LIMIT 1`, [unplaceable]);
    ok('Found a dispatched item whose list was really taken from real stock', !!cand, cand && cand.order_code);
    if (cand) {
      const base0 = await lines(cand.id);
      const L = await ledgerForItem(txDb, cand.id);
      ok(`${cand.order_code}: history says real stock was taken`, L.known && L.naturalReal && !L.hadPlaceholder);
      // B1 same list
      let snap = await snapshot(base0.map(l => l.id));
      let r = await save(cand.order_id, cand.id, asSels(base0));
      ok(`${cand.order_code}: saving the same list moves nothing ("already matches")`, r.body.mode === 'difference' && /already matches/.test(r.body.summary) && !(await unchanged(snap)), JSON.stringify(r.body));
      // B2 forgotten item
      const X = await pickStock(base0.map(l => l.id), 100);
      const sx = await stock(X.id);
      let sels = [...asSels(base0), { id: X.id, qty: 10 }];
      r = await save(cand.order_id, cand.id, sels);
      ok(`Forgotten item: adding 10 × ${X.item_code} takes exactly 10`, Math.abs((await stock(X.id)) - (sx - 10)) < 1e-6 && /took 10 /.test(r.body.summary), r.body.summary);
      ok('…and the history line names the rule', /auto-corrected by inventory rules: took 10/.test(logs[logs.length - 1].desc));
      // B3 wrong item replaced
      const A = base0.find(l => !['Terminal Pin', 'Heavy Terminal Pin'].includes(l.category) && !/^FIN-/.test(l.item_code));
      const Bi = await pickStock([...base0.map(l => l.id), X.id], A.qty + 10);
      const sA = await stock(A.id), sB = await stock(Bi.id);
      sels = [...asSels(base0).filter(s => s.id !== A.id), { id: X.id, qty: 10 }, { id: Bi.id, qty: A.qty }];
      r = await save(cand.order_id, cand.id, sels);
      ok(`Wrong item: replacing ${A.qty} × ${A.item_code} with ${Bi.item_code} gives ${A.item_code} back and takes ${Bi.item_code}`,
        Math.abs((await stock(A.id)) - (sA + A.qty)) < 1e-6 && Math.abs((await stock(Bi.id)) - (sB - A.qty)) < 1e-6, r.body.summary);
      // B4 repeat
      snap = await snapshot(sels.map(s => s.id).concat(A.id));
      r = await save(cand.order_id, cand.id, sels);
      ok('Saving the same corrected list again moves nothing', !(await unchanged(snap)) && /already matches/.test(r.body.summary), r.body.summary);
      // B5 qty up / down
      const sB2 = await stock(Bi.id);
      sels = sels.map(s => s.id === Bi.id ? { ...s, qty: A.qty + 5 } : s);
      r = await save(cand.order_id, cand.id, sels);
      ok('Quantity raised by 5 → only the extra 5 is taken', Math.abs((await stock(Bi.id)) - (sB2 - 5)) < 1e-6, r.body.summary);
      sels = sels.map(s => s.id === Bi.id ? { ...s, qty: A.qty + 2 } : s);
      r = await save(cand.order_id, cand.id, sels);
      ok('Quantity lowered by 3 → only the excess 3 is given back', Math.abs((await stock(Bi.id)) - (sB2 - 2)) < 1e-6, r.body.summary);
      // B6 not enough stock
      const Z = await q1(`SELECT id, item_code, current_stock::float s FROM inventory_items WHERE current_stock <= 0 AND item_code NOT ILIKE '%TRAIN%'
                            AND id <> ALL($1) AND TRIM(COALESCE(category,'')) NOT ILIKE 'finns' ORDER BY id LIMIT 1`, [sels.map(s => s.id)]);
      const sZ = await stock(Z.id);
      r = await save(cand.order_id, cand.id, [...sels, { id: Z.id, qty: 4 }]);
      ok(`Not enough stock: 4 × ${Z.item_code} (stock ${sZ}) is not taken and the order notes it`,
        (await stock(Z.id)) === sZ && new RegExp(`not taken: ${Z.item_code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(needs 4, only`).test(r.body.summary), r.body.summary);
      ok('…stock never goes below zero from a correction', (await stock(Z.id)) === sZ);
    }

    // ── C. An item still in production whose stage-15 parts were really taken ──
    const prod = await q1(`
      SELECT oi.id, oi.order_id, o.order_code, jc.id AS card_id FROM order_items oi JOIN orders o ON o.id=oi.order_id
        JOIN job_cards jc ON jc.order_item_id=oi.id
       WHERE o.order_code <> ALL($1) AND jc.status IN ('in_progress','pending')
         AND (SELECT COUNT(*) FROM job_cards x WHERE x.order_item_id=oi.id) = 1
         AND EXISTS (SELECT 1 FROM production_checklist pc WHERE pc.job_card_id=jc.id AND pc.stage_no=15 AND pc.done=1)
         AND EXISTS (SELECT 1 FROM inventory_transactions t JOIN inventory_items ii ON ii.id=t.item_id
                      WHERE t.order_item_id=oi.id AND t.source='bom' AND TRIM(ii.category) IN ('Flange','Flange Cap','Flange Spare','Brazing EQ'))
         AND NOT EXISTS (SELECT 1 FROM order_item_inventory l WHERE l.order_item_id=oi.id AND (COALESCE(l.rework_qty,0)>0))
       ORDER BY oi.id DESC LIMIT 1`, [unplaceable]);
    if (prod) {
      const L0 = await lines(prod.id);
      const fl = L0.find(l => ['Flange', 'Flange Cap', 'Flange Spare', 'Brazing EQ'].includes(l.category));
      const other = L0.filter(l => l.id !== fl.id && !/^FIN-/.test(l.item_code));
      const snapOther = await snapshot(other.map(l => l.id));
      const L = await ledgerForItem(txDb, prod.id);
      const have = Math.max(0, L.net[fl.id] || 0);
      const sF = await stock(fl.id);
      const r = await save(prod.order_id, prod.id, L0.map(l => ({ id: l.id, qty: l.id === fl.id ? l.qty + 2 : l.qty })));
      const expectDiff = (fl.qty + 2) - have;
      ok(`${prod.order_code} (in production, stage 15 done): raising ${fl.item_code} by 2 takes only the difference for the stage reached`,
        Math.abs((await stock(fl.id)) - (sF - expectDiff)) < 1e-6, `${r.body.summary} | have ${have}, line ${fl.qty}`);
      ok('…and parts for stages not reached yet are not taken', !(await unchanged(snapOther)), await unchanged(snapOther));
    } else ok('No in-production item with stage-15 parts taken right now (skipped)', true);

    // ── D. In production, nothing taken yet: record only, later stages still take normally ──
    const early = await q1(`
      SELECT oi.id, oi.order_id, o.order_code, jc.id AS card_id, oi.quantity FROM order_items oi JOIN orders o ON o.id=oi.order_id
        JOIN job_cards jc ON jc.order_item_id=oi.id
       WHERE o.order_code <> ALL($1) AND o.order_type <> 'finished_goods' AND jc.status IN ('in_progress','pending')
         AND (SELECT COUNT(*) FROM job_cards x WHERE x.order_item_id=oi.id) = 1
         AND NOT EXISTS (SELECT 1 FROM production_checklist pc WHERE pc.job_card_id=jc.id AND pc.stage_no IN (15,21) AND pc.done=1)
         AND NOT EXISTS (SELECT 1 FROM inventory_transactions t WHERE t.order_item_id=oi.id AND t.source IN ('bom','correction'))
         AND EXISTS (SELECT 1 FROM order_item_inventory l JOIN inventory_items ii ON ii.id=l.inventory_item_id
                      WHERE l.order_item_id=oi.id AND TRIM(ii.category) IN ('Flange','Flange Cap','Flange Spare','Brazing EQ'))
         AND NOT EXISTS (SELECT 1 FROM order_item_inventory l WHERE l.order_item_id=oi.id AND COALESCE(l.rework_qty,0)>0)
       ORDER BY oi.id DESC LIMIT 1`, [unplaceable]);
    if (early) {
      const L0 = await lines(early.id);
      const snap = await snapshot(L0.map(l => l.id));
      const r = await save(early.order_id, early.id, asSels(L0));
      ok(`${early.order_code} (in production, nothing taken yet): saving is record-only and moves nothing`, r.body.mode === 'record' && !(await unchanged(snap)), r.body.summary);
      const after = await lines(early.id);
      ok('…nothing is marked settled, because production has not reached any stage', after.every(l => l.waived === 0 && l.deducted === 0));
      const fl = after.find(l => ['Flange', 'Flange Cap', 'Flange Spare', 'Brazing EQ'].includes(l.category));
      const sF = await stock(fl.id);
      const card = await q1('SELECT * FROM job_cards WHERE id=$1', [early.card_id]);
      await ded.deductStageCategories(txDb, card, 15, 4);
      ok(`…when stage 15 is ticked later, ${fl.item_code} is taken normally`, (await stock(fl.id)) < sF, `${sF} → ${await stock(fl.id)}`);
      // Now real stock has been taken at stage 15: a correction moves only the difference for that stage.
      await client.query(`INSERT INTO production_checklist (job_card_id, stage_no, done) VALUES ($1, 15, 1)
                            ON CONFLICT DO NOTHING`, [early.card_id]).catch(async () => {
        await client.query('UPDATE production_checklist SET done=1 WHERE job_card_id=$1 AND stage_no=15', [early.card_id]);
      });
      const done15 = await q1('SELECT done FROM production_checklist WHERE job_card_id=$1 AND stage_no=15', [early.card_id]);
      const L1 = await lines(early.id);
      const fl1 = L1.find(l => l.id === fl.id);
      const others = L1.filter(l => l.id !== fl.id && !/^FIN-/.test(l.item_code) && !['Flange', 'Flange Cap', 'Flange Spare', 'Brazing EQ'].includes(l.category));
      const snapOthers = await snapshot(others.map(l => l.id));
      const sF1 = await stock(fl.id);
      const cardRow = await q1('SELECT qty FROM job_cards WHERE id=$1', [early.card_id]);
      const share = Math.min(1, Number(cardRow.qty) / Number(early.quantity));
      const r2 = await save(early.order_id, early.id, L1.map(l => ({ id: l.id, qty: l.id === fl.id ? l.qty + 4 : l.qty })));
      const expect = Math.round(((fl1.qty + 4) * share - fl1.deducted) * 10000) / 10000;
      ok(`…after stage 15, raising ${fl.item_code} by 4 takes only the stage-15 difference (${expect})`,
        done15?.done === 1 && r2.body.mode === 'difference' && Math.abs((await stock(fl.id)) - (sF1 - expect)) < 1e-4, `${r2.body.summary} | ${sF1} → ${await stock(fl.id)}`);
      ok('…and nothing is taken for stages production has not reached', !(await unchanged(snapOthers)), await unchanged(snapOthers));
    } else ok('No suitable early in-production item right now (skipped)', true);

    // ── E. Order whose history cannot be placed: record only ──
    const amb = await q1(`SELECT oi.id, oi.order_id FROM order_items oi JOIN orders o ON o.id=oi.order_id
                           WHERE o.order_code='ORD-092-26' AND EXISTS (SELECT 1 FROM order_item_inventory l WHERE l.order_item_id=oi.id) ORDER BY oi.id LIMIT 1`);
    if (amb) {
      const L0 = await lines(amb.id);
      const snap = await snapshot(L0.map(l => l.id));
      const r = await save(amb.order_id, amb.id, asSels(L0));
      ok('ORD-092-26 (history cannot be placed for certain): record-only, nothing moves', r.body.mode === 'record' && /could not be tied/.test(r.body.summary) && !(await unchanged(snap)), r.body.summary);
    }

    // ── F. A refused save changes nothing ──
    {
      const it = await q1(`SELECT oi.id, oi.order_id FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.order_code='ORD-024-26' ORDER BY oi.id LIMIT 1`);
      const L0 = await lines(it.id);
      const r = await save(it.order_id, it.id, L0.filter(l => !/Terminal Pin/.test(l.category)).map(l => ({ id: l.id, qty: l.qty })));
      ok('A list without a terminal pin is refused and nothing changes', r.status === 400 && JSON.stringify(await lines(it.id)) === JSON.stringify(L0), r.body.error);
    }

    // ── R2. A settled item whose card is sent back before QC (owner reversal / repair / return) ──
    if (cand) {
      const card = await q1('SELECT id FROM job_cards WHERE order_item_id=$1 ORDER BY id LIMIT 1', [cand.id]);
      await client.query("UPDATE job_cards SET status='qc_pending' WHERE id=$1", [card.id]);
      const L0 = await lines(cand.id);
      const snap = await snapshot(L0.map(l => l.id));
      const r = await save(cand.order_id, cand.id, asSels(L0));
      const flag = (await q1('SELECT inventory_deducted f FROM order_items WHERE id=$1', [cand.id])).f;
      ok(`${cand.order_code} with its card sent back to QC: saving moves nothing and it stays settled`, !(await unchanged(snap)) && flag === true, r.body.summary);
      await ded.settleItemInventory(txDb, cand.id, 4, cand.order_code);
      await client.query("UPDATE job_cards SET status='qc_approved' WHERE id=$1", [card.id]);
      await ded.settleItemInventory(txDb, cand.id, 4, cand.order_code);
      ok('…and approving QC again takes nothing a second time', !(await unchanged(snap)), await unchanged(snap));
    }

    // ── R3. A share settled record-only is never taken by a later save ──
    if (early) {
      const L = await lines(early.id);
      const fl = L.find(l => ['Flange', 'Flange Cap', 'Flange Spare', 'Brazing EQ'].includes(l.category));
      if (fl) {
        // Make the line "record-only settled" for the flange, then give the item a real take elsewhere.
        await client.query('UPDATE order_item_inventory SET qty_waived = qty, qty_deducted = 0 WHERE order_item_id=$1 AND inventory_item_id=$2', [early.id, fl.id]);
        const other = L.find(l => l.id !== fl.id && !/^FIN-/.test(l.item_code));
        await client.query(`INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by, order_item_id, source)
                            VALUES ($1,'dispatch_to_production',1,0,'test natural take',4,$2,'bom')`, [other.id, early.id]);
        await client.query('UPDATE order_item_inventory SET qty_deducted = qty_deducted + 1 WHERE order_item_id=$1 AND inventory_item_id=$2', [early.id, other.id]);
        const sF = await stock(fl.id);
        const r = await save(early.order_id, early.id, asSels(await lines(early.id)));
        ok('A flange settled record-only is not taken when a later save runs by difference', r.body.mode === 'difference' && (await stock(fl.id)) === sF, `${r.body.summary} | ${sF} → ${await stock(fl.id)}`);
      }
    }

    // ── U. Drawing uploads follow the same rules ──
    {
      const it = await q1(`SELECT oi.id, oi.order_id FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.order_code='ORD-024-26' ORDER BY oi.id LIMIT 1`);
      const L0 = await lines(it.id);
      const extra = await pickStock(L0.map(l => l.id), 50);
      const snap = await snapshot([...L0.map(l => l.id), extra.id]);
      const nDw = Number((await q1('SELECT COUNT(*) n FROM order_drawings WHERE item_id=$1', [it.id])).n);
      const r = await uploadDrawing(it.order_id, it.id, [...asSels(L0), { id: extra.id, qty: 12 }]);
      const after = await lines(it.id);
      ok('Drawing upload on ORD-024-26 (TRAIN): drawing saved, list record-only, no stock moved',
        r.status === 201 && r.body.mode === 'record' && !(await unchanged(snap)) && Number((await q1('SELECT COUNT(*) n FROM order_drawings WHERE item_id=$1', [it.id])).n) === nDw + 1, r.body.summary);
      ok('…and the list keeps its settled record (nothing can be taken for it later)', after.every(l => l.deducted + l.waived + 1e-6 >= l.qty), JSON.stringify(after.slice(0, 2)));
    }
    if (cand) {
      const L0 = await lines(cand.id);
      const X = await pickStock(L0.map(l => l.id), 100);
      const sx = await stock(X.id);
      const snapOld = await snapshot(L0.map(l => l.id));
      const r = await uploadDrawing(cand.order_id, cand.id, [...asSels(L0), { id: X.id, qty: 7 }]);
      ok(`Drawing upload on ${cand.order_code} (really taken) with a forgotten item: takes exactly 7 ${X.item_code}, nothing else moves`,
        r.status === 201 && Math.abs((await stock(X.id)) - (sx - 7)) < 1e-6 && !(await unchanged(snapOld)), r.body.summary);
    }
    {
      const fresh = await q1(`SELECT oi.id, oi.order_id, o.order_code FROM order_items oi JOIN orders o ON o.id=oi.order_id
         WHERE NOT EXISTS (SELECT 1 FROM job_cards jc WHERE jc.order_item_id=oi.id)
           AND NOT EXISTS (SELECT 1 FROM inventory_transactions t WHERE t.order_item_id=oi.id)
           AND COALESCE(oi.inventory_deducted,FALSE)=FALSE AND o.order_type <> 'finished_goods'
         ORDER BY oi.id DESC LIMIT 1`);
      if (fresh) {
        const pin = await q1(`SELECT id FROM inventory_items WHERE TRIM(category)='Terminal Pin' AND current_stock > 10 ORDER BY id LIMIT 1`);
        const hv = await q1(`SELECT id FROM inventory_items WHERE TRIM(category)='Heavy Terminal Pin' AND current_stock > 10 ORDER BY id LIMIT 1`);
        const remark = (await q1('SELECT remark FROM order_items WHERE id=$1', [fresh.id])).remark || '';
        const pinId = /heavy[\s\-_.]*terminal[\s\-_.]*pin/i.test(remark) ? hv.id : pin.id;
        const snap = await snapshot([pinId]);
        const r = await uploadDrawing(fresh.order_id, fresh.id, [{ id: pinId, qty: 4 }]);
        const after = await lines(fresh.id);
        ok(`First drawing upload on a new item (${fresh.order_code}): the list is simply saved, nothing taken, no extra message`,
          r.status === 201 && r.body.fresh === true && !(await unchanged(snap)) && after.length === 1 && after[0].deducted === 0 && after[0].waived === 0, r.body.summary);
      } else ok('No brand-new item without cards right now (skipped)', true);
    }
    if (early) {
      // stage 15 was ticked and its flange share recorded earlier in this test
      const L0 = await lines(early.id);
      const fl = L0.find(l => ['Flange', 'Flange Cap', 'Flange Spare', 'Brazing EQ'].includes(l.category));
      if (fl) {
        const before = fl.deducted + fl.waived;
        const r = await uploadDrawing(early.order_id, early.id, asSels(L0));
        const fl2 = (await lines(early.id)).find(l => l.id === fl.id);
        const sF = await stock(fl.id);
        const card = await q1('SELECT * FROM job_cards WHERE id=$1', [early.card_id]);
        await ded.deductStageCategories(txDb, card, 15, 4);
        ok('Drawing upload part-way through production keeps what stage 15 already took, so stage 15 never takes it twice',
          r.status === 201 && fl2.deducted + fl2.waived + 1e-6 >= before && (await stock(fl.id)) === sF, `${r.body.summary} | before ${before}, after ${fl2.deducted + fl2.waived}`);
      }
    }

    // ── G. The every-restart sweep is gone ──
    const src = require('fs').readFileSync(S + '/src/db/index.js', 'utf8');
    ok('The startup sweep only runs when the column is first created', /if \(!hadQtyDeducted\) \{\s*await pool\.query\(`\s*UPDATE order_item_inventory oii SET qty_deducted = oii\.qty/.test(src));
  } catch (e) { console.error('HARNESS ERROR:', e); failed = true; }
  finally {
    await client.query('ROLLBACK');
    client.release(); server.close(); await realPool.end();
    console.log('rolled back — nothing was kept');
    process.exit(failed ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
