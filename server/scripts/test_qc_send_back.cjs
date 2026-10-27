// Test: the owner sends a purchase QC back to be done again (owner, 27 Oct 2026:
// "The qc is done wrong send it back to redo the same"). What the QC put into
// stock comes back out (a set's other parts too), a pending debit note it
// raised is dropped, the line waits for QC again, and a PO that had closed
// waits for QC again. Refused for anyone but the owner, and once a debit note
// from that QC has gone to the supplier. Rolled back — nothing kept.
//   node scripts/test_qc_send_back.cjs
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
  const logs = [], notes = [];
  dbmod.getDB = () => txDb;
  dbmod.logActivity = async (orderId, jc, type, desc) => { logs.push({ type, desc }); };
  const q1 = async (q, p = []) => (await client.query(q, p)).rows[0];
  const qa = async (q, p = []) => (await client.query(q, p)).rows;
  let failed = false;
  const ok = (label, cond, extra = '') => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  ' + String(extra).slice(0, 300) : '')); if (!cond) failed = true; };
  process.on('unhandledRejection', (e) => { failed = true; console.error('ROUTE ERROR (unhandled):', e); });
  const owner = await q1("SELECT id, name, role FROM users WHERE role='owner' ORDER BY id LIMIT 1");
  const admin = { id: owner.id, name: 'ZZTEST Admin', role: 'admin' };
  let actor = owner;
  const auth = require(S + '/src/middleware/auth.js');
  auth.authenticate = (req, res, next) => { req.user = actor; next(); };
  const upload = require(S + '/src/middleware/upload.js');
  upload.uploadPurchaseItemQCFields = [(req, res, next) => { req.files = { image: [{ storagePath: 'test/qc.jpg', originalname: 'qc.jpg' }],
    rejection_photos: [{ storagePath: 'test/rej.jpg', originalname: 'rej.jpg' }] }; next(); }];
  const notif = require(S + '/src/routes/notifications.js');
  notif.createNotification = async (db, n) => { notes.push(n); };
  const express = require(S + '/node_modules/express');
  const app = express();
  app.use(express.json());
  app.use('/api/purchase-orders', require(S + '/src/routes/purchaseOrders.js'));
  const server = app.listen(0);
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, url, body, as = owner) => {
    actor = as;
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    actor = owner;
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  try {
    const stock = async (id) => Number((await q1('SELECT current_stock FROM inventory_items WHERE id=$1', [id])).current_stock);
    const line = (id) => q1('SELECT qc_status, qc_received_qty, qc_weight_10, qc_image_file, qc_at FROM purchase_order_items WHERE id=$1', [id]);
    const poRow = (id) => q1('SELECT status, delivery_status, received_at FROM purchase_orders WHERE id=$1', [id]);
    const mkItem = async (code, s, cat = 'Heavy Terminal Nut') => (await q1(
      `INSERT INTO inventory_items (item_code, name, unit, category, current_stock, unit_cost) VALUES ($1,$1,'pcs',$2,$3,0.5) RETURNING id`, [code, cat, s])).id;
    const sup = (await q1('SELECT MIN(id) AS id FROM suppliers')).id;
    const mkPo = async (no, lines, { noStock = false } = {}) => {
      const po = (await q1(
        `INSERT INTO purchase_orders (po_number, supplier_id, status, delivery_status, igst_percent, transport_charges, no_stock, received_at, created_by)
         VALUES ($1,$2,'approved','qc_pending',18,0,$3,NOW(),$4) RETURNING id`, [no, sup, noStock, owner.id])).id;
      const ids = [];
      for (const [inv, qty, rate] of lines) {
        ids.push((await q1(
          `INSERT INTO purchase_order_items (po_id, inventory_item_id, description, unit, qty, rate, amount, received, received_at, billed_qty)
           VALUES ($1,$2,$3,'pcs',$4,$5,$6,TRUE,NOW(),$7) RETURNING id`, [po, inv, `ZZTEST line ${ids.length + 1}`, qty, rate, qty * rate, qty])).id);
      }
      return { po, ids };
    };
    const qc = (po, it, body) => call('POST', `/api/purchase-orders/${po}/items/${it}/qc`, { weight_10: 0.021, observations: 'OK', ...body });
    const sendBack = (po, it, as = owner) => call('PUT', `/api/purchase-orders/${po}/items/${it}/qc-send-back`, null, as);

    // ── 1. The P PHE 52 case: 19,800 accepted against 10,000 billed ──
    const NUT = await mkItem('ZZTEST-QSB-NUT', 304), WSH = await mkItem('ZZTEST-QSB-WSH', 608, 'Heavy Terminal Washer');
    const A = await mkPo('ZZT-QSB-A', [[NUT, 10000, 0.85], [WSH, 20000, 0.45]]);
    let r = await qc(A.po, A.ids[0], { result: 'approved', received_qty: 19800 });
    ok('1. the wrong QC put 19,800 into stock (304 → 20,104)', r.status === 200 && (await stock(NUT)) === 20104, `${r.status} ${await stock(NUT)}`);
    r = await sendBack(A.po, A.ids[0], admin);
    ok('2. only the owner can send a QC back', r.status === 403, JSON.stringify(r.body));
    r = await sendBack(A.po, A.ids[0]);
    const l1 = await line(A.ids[0]);
    const adj = await q1(`SELECT quantity::float q, balance_after::float b, notes FROM inventory_transactions WHERE item_id=$1 AND transaction_type='adjustment' ORDER BY id DESC LIMIT 1`, [NUT]);
    ok('3. sent back: the 19,800 come back out (20,104 → 304), as one stock adjustment naming the PO',
      r.status === 200 && (await stock(NUT)) === 304 && adj?.q === 19800 && adj?.b === 304 && /ZZT-QSB-A QC sent back to redo/.test(adj?.notes || ''), `${r.status} ${JSON.stringify(r.body)} ${JSON.stringify(adj)}`);
    ok('3. the QC\'s lot is gone', Number((await q1('SELECT COUNT(*)::int n FROM inventory_fifo_lots WHERE po_id=$1', [A.po])).n) === 0);
    ok('3. the line waits for QC again — every QC field cleared', l1.qc_status === null && l1.qc_received_qty === null && l1.qc_weight_10 === null && l1.qc_image_file === null && l1.qc_at === null, JSON.stringify(l1));
    ok('3. the PO is still waiting for QC', (await poRow(A.po)).delivery_status === 'qc_pending');
    ok('3. the timeline says so, and Design / QC is told to do it again',
      logs.some(l => l.type === 'purchase_qc_sent_back' && /19800 ZZTEST-QSB-NUT taken back out \(20104 → 304\)/.test(l.desc))
      && (notes.length === 0 || notes.every(n => n.type === 'purchase_qc_redo' && /QC to do again — ZZT-QSB-A/.test(n.title))),
      JSON.stringify({ log: logs.slice(-1), notes: notes.slice(-1) }));
    r = await sendBack(A.po, A.ids[0]);
    ok('4. a line with no QC cannot be sent back', r.status === 400 && /no QC to send back/.test(r.body.error || ''), JSON.stringify(r.body));
    r = await qc(A.po, A.ids[0], { result: 'approved', received_qty: 10000 });
    ok('5. QC done again with the real 10,000: stock 304 → 10,304, one new lot', r.status === 200 && (await stock(NUT)) === 10304
      && Number((await q1('SELECT SUM(qty_original)::float q FROM inventory_fifo_lots WHERE po_id=$1 AND item_id=$2', [A.po, NUT])).q) === 10000, `${r.status} ${await stock(NUT)}`);

    // ── 6. A PO that had closed waits for QC again ──
    const B = await mkPo('ZZT-QSB-B', [[NUT, 500, 0.85]]);
    await qc(B.po, B.ids[0], { result: 'approved', received_qty: 500 });
    const closed = await poRow(B.po);
    r = await sendBack(B.po, B.ids[0]);
    const reopened = await poRow(B.po);
    ok('6. a PO closed by its only QC goes back to waiting for QC', closed.status === 'received' && r.status === 200
      && reopened.status === 'approved' && reopened.delivery_status === 'qc_pending' && reopened.received_at === null, JSON.stringify({ closed, reopened }));

    // ── 7. Partial: its pending debit note is dropped; a raised one blocks ──
    const C = await mkPo('ZZT-QSB-C', [[NUT, 100, 0.85]]);
    const sC = await stock(NUT);
    await qc(C.po, C.ids[0], { result: 'partial', received_qty: 60, rejected_qty: 40, rejection_reason: 'bent' });
    r = await sendBack(C.po, C.ids[0]);
    ok('7. a partial QC sent back: its 60 out of stock and its pending debit note dropped', r.status === 200 && (await stock(NUT)) === sC && r.body.dropped === 1
      && Number((await q1('SELECT COUNT(*)::int n FROM purchase_debit_notes WHERE po_item_id=$1', [C.ids[0]])).n) === 0, JSON.stringify(r.body));
    await qc(C.po, C.ids[0], { result: 'partial', received_qty: 60, rejected_qty: 40, rejection_reason: 'bent' });
    await client.query("UPDATE purchase_debit_notes SET status='raised', note_no='ZZT-DN', amount=1 WHERE po_item_id=$1", [C.ids[0]]);
    const sC2 = await stock(NUT);
    r = await sendBack(C.po, C.ids[0]);
    ok('8. once its debit note has gone to the supplier, the QC cannot be sent back — nothing changes',
      r.status === 400 && /already been raised/.test(r.body.error || '') && (await stock(NUT)) === sC2 && (await line(C.ids[0])).qc_status === 'partial', JSON.stringify(r.body));

    // ── 9. A set: the pin and its nut and washers all come back out ──
    const PIN = await mkItem('ZZTEST-QSB-PIN', 100, 'Heavy Terminal Pin');
    await client.query('INSERT INTO inventory_set_components (set_item_id, component_item_id, qty_per_set) VALUES ($1,$2,1),($1,$3,2)', [PIN, NUT, WSH]);
    const D = await mkPo('ZZT-QSB-D', [[PIN, 50, 6]]);
    const sD = [await stock(PIN), await stock(NUT), await stock(WSH)];
    await qc(D.po, D.ids[0], { result: 'approved', received_qty: 50 });
    r = await sendBack(D.po, D.ids[0]);
    ok('9. a set sent back: the 50 pins, 50 nuts and 100 washers all come back out',
      r.status === 200 && (await stock(PIN)) === sD[0] && (await stock(NUT)) === sD[1] && (await stock(WSH)) === sD[2] && (r.body.moved || []).length === 3, JSON.stringify(r.body));

    // ── 10. Partly used already: the whole lot comes out; what production took stays taken ──
    const E = await mkPo('ZZT-QSB-E', [[NUT, 1000, 0.85]]);
    const sE = await stock(NUT);
    await qc(E.po, E.ids[0], { result: 'approved', received_qty: 1000 });
    await client.query('UPDATE inventory_fifo_lots SET qty_remaining = qty_remaining - 300 WHERE po_id=$1', [E.po]);
    await client.query('UPDATE inventory_items SET current_stock = current_stock - 300 WHERE id=$1', [NUT]);
    r = await sendBack(E.po, E.ids[0]);
    ok('10. 300 already used: all 1,000 come out (stock ends 300 below where it started), and the message says 300 were used',
      r.status === 200 && (await stock(NUT)) === sE - 300 && /300 of them already used in production/.test(r.body.message || ''), JSON.stringify(r.body));

    // ── 11. Rejected outright, and a "don't add to inventory" PO: nothing in stock to take back ──
    const F = await mkPo('ZZT-QSB-F', [[NUT, 10, 0.85]]);
    const sF = await stock(NUT);
    await qc(F.po, F.ids[0], { result: 'rejected', rejected_qty: 10, rejection_reason: 'rusted' });
    r = await sendBack(F.po, F.ids[0]);
    ok('11. a rejection sent back: stock untouched, its pending debit note dropped, the line waits for QC',
      r.status === 200 && (await stock(NUT)) === sF && r.body.dropped === 1 && (await line(F.ids[0])).qc_status === null && /nothing had gone into stock/i.test(r.body.message || ''), JSON.stringify(r.body));
    const G = await mkPo('ZZT-QSB-G', [[NUT, 10, 0.85]], { noStock: true });
    await qc(G.po, G.ids[0], { result: 'approved', received_qty: 10 });
    r = await sendBack(G.po, G.ids[0]);
    ok('12. a "don\'t add to inventory" PO: sent back with no stock move', r.status === 200 && (await stock(NUT)) === sF && (r.body.moved || []).length === 0, JSON.stringify(r.body));
  } catch (e) { failed = true; console.error('ERROR', e); }
  finally {
    await client.query('ROLLBACK'); client.release(); server.close(); await realPool.end();
    console.log(failed ? '\nSOME CHECKS FAILED (rolled back)' : '\nALL PASS (rolled back — nothing kept)');
    process.exit(failed ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
