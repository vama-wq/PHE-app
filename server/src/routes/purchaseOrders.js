const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadPurchaseQC, uploadPurchaseInvoice, uploadPurchaseItemQC, uploadPurchaseItemQCFields, uploadDebitNote, uploadChatAttachments } = require('../middleware/upload');
const { createNotification } = require('./notifications');

// Add a single received PO item's stock to inventory (FIFO lot + moving-average
// cost + transaction). `qty` is the ACTUAL quantity received (entered at QC),
// which may differ from the ordered quantity.
async function receiveItemStock(db, po, item, userId, qty) {
  if (!item.inventory_item_id) return;
  const q = Number(qty);
  if (!(q > 0)) return;
  const now = new Date().toISOString();
  const supplier = await db.get('SELECT name FROM suppliers WHERE id=$1', [po.supplier_id]);

  // Landed unit cost = material rate + (transport + local transport + other
  // receipt costs) spread across the received quantity, so stock valuation
  // reflects the true cost — even though transport is also logged as its own
  // Account-Statement expense.
  const baseRate = Number(item.rate) || 0;
  const transport = Number(item.receive_transport_cost) || 0;
  const localTransport = Number(item.receive_local_transport_cost) || 0;
  const other = Number(item.receive_other_cost) || 0;
  const extraPerUnit = (transport + localTransport + other) / q;
  const landedUnitCost = Math.round((baseRate + extraPerUnit) * 100) / 100;

  await db.run(
    `INSERT INTO inventory_fifo_lots (item_id, po_id, qty_original, qty_remaining, unit_cost, received_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [item.inventory_item_id, po.id, q, q, landedUnitCost, now]
  );
  const inv = await db.get('SELECT current_stock FROM inventory_items WHERE id=$1', [item.inventory_item_id]);
  const newStock = (Number(inv.current_stock) || 0) + q;
  const lots = await db.all('SELECT qty_remaining, unit_cost FROM inventory_fifo_lots WHERE item_id=$1 AND qty_remaining > 0', [item.inventory_item_id]);
  const totalQty = lots.reduce((s, l) => s + Number(l.qty_remaining), 0);
  const totalCost = lots.reduce((s, l) => s + Number(l.qty_remaining) * Number(l.unit_cost), 0);
  const avgCost = totalQty > 0 ? totalCost / totalQty : landedUnitCost;
  await db.run('UPDATE inventory_items SET current_stock=$1, unit_cost=$2 WHERE id=$3',
    [newStock, Math.round(avgCost * 100) / 100, item.inventory_item_id]);
  const landedNote = (transport + other) > 0 ? ` @ landed ₹${landedUnitCost}/u (rate ₹${baseRate} + ₹${Math.round(extraPerUnit * 100) / 100} costs)` : '';
  await db.run(
    `INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, po_number, supplier_name, notes, created_by)
     VALUES ($1,'purchase_in',$2,$3,$4,$5,$6,$7)`,
    [item.inventory_item_id, q, newStock, po.po_number, supplier?.name || '',
     `PO received (QC approved): ${po.po_number} — qty ${q}${Number(item.qty) !== q ? ` of ${item.qty} ordered` : ''}${landedNote}`, userId]
  );
}

// Detect PO items priced above their agreed rate (supplier-link rate), or for
// unlinked items above the most recent PO rate. Returns the list of increases.
async function detectRateIncreases(db, supplierId, items, excludePoId = 0) {
  const increases = [];
  for (const item of items) {
    if (!item.inventory_item_id) continue;
    const newRate = Number(item.rate) || 0;
    if (newRate <= 0) continue;
    let baseline = null, basis = '';
    const link = await db.get('SELECT supplier_price FROM supplier_items WHERE supplier_id=$1 AND inventory_item_id=$2', [supplierId, item.inventory_item_id]);
    if (link && link.supplier_price != null && Number(link.supplier_price) > 0) {
      baseline = Number(link.supplier_price); basis = 'agreed rate';
    } else {
      const last = await db.get(
        `SELECT poi.rate FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.po_id
         WHERE poi.inventory_item_id=$1 AND po.id <> $2 ORDER BY po.created_at DESC LIMIT 1`,
        [item.inventory_item_id, excludePoId]
      );
      if (last && Number(last.rate) > 0) { baseline = Number(last.rate); basis = 'last PO rate'; }
    }
    if (baseline != null && newRate > baseline) {
      increases.push({ description: item.description, oldRate: baseline, newRate, basis });
    }
  }
  return increases;
}

// Flag a PO as needing owner approval for a rate increase: set the flag, post an
// automated note in the PO chat, and notify owner/admin/accounts (dashboard).
async function flagRateIncrease(db, po, increases, byUserId) {
  await db.run('UPDATE purchase_orders SET rate_increase_pending=TRUE WHERE id=$1', [po.id]);
  const lines = increases.map(i => `• ${i.description}: ₹${i.oldRate} → ₹${i.newRate} (above ${i.basis})`).join('\n');
  await db.run('INSERT INTO purchase_order_messages (po_id, user_id, message) VALUES ($1,$2,$3)',
    [po.id, byUserId, `⚠️ Rate increase needs owner approval before this PO can be sent:\n${lines}`]);
  const recipients = await db.all(`SELECT id FROM users WHERE role IN ('owner','admin','accounts')`);
  for (const u of recipients) {
    await createNotification(db, {
      userId: u.id, type: 'po_rate_increase',
      title: `Rate increase on ${po.po_number}`,
      body: increases.map(i => `${i.description}: ₹${i.oldRate}→₹${i.newRate}`).join('; '),
      link: `/purchases/${po.id}`, sourceUserId: byUserId,
    });
  }
}

const VALID_DELIVERY_STATUSES = [
  'in_transit', 'material_rejected', 'reconfirm_order',
  'purchase_accepted', 'order_cancelled', 'qc_pending'
];

// Totals carry paise up to the tax line, then the payable is rounded to the
// nearest rupee the way a supplier bill does — the difference is kept as
// round_off so the arithmetic on the printed PO still adds up.
function calcTotals(items, transportCharges, igstPercent) {
  const subtotal = items.reduce((s, i) => s + i.amount, 0) + Number(transportCharges || 0);
  const igstAmount = Math.round(subtotal * (igstPercent / 100) * 100) / 100;
  const beforeRounding = Math.round((subtotal + igstAmount) * 100) / 100;
  const grandTotal = Math.round(beforeRounding);
  const roundOff = Math.round((grandTotal - beforeRounding) * 100) / 100;
  return { subtotal, igstAmount, grandTotal, roundOff };
}

async function nextPoNumber(db) {
  const last = await db.get('SELECT po_number FROM purchase_orders ORDER BY id DESC LIMIT 1');
  if (!last) return 'P PHE 01';
  const m = last.po_number.match(/P PHE (\d+)/i);
  const n = m ? parseInt(m[1], 10) + 1 : 1;
  return `P PHE ${String(n).padStart(2, '0')}`;
}

router.get('/', authenticate, async (req, res) => {
  const pos = await getDB().all(
    `SELECT po.*, s.name as supplier_name, u.name as created_by_name,
       (SELECT COUNT(*) FROM purchase_debit_notes dn WHERE dn.po_id = po.id AND dn.status='pending') AS pending_debit_notes
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     JOIN users u ON u.id = po.created_by
     ORDER BY po.created_at DESC`
  );
  res.json(pos);
});

router.get('/pending-material-qc', authenticate, authorize('design', 'owner', 'admin'), async (req, res) => {
  const db = getDB();
  // QC users get a restricted view — no supplier name or cost data.
  if (req.user.role === 'design') {
    const pos = await db.all(
      `SELECT po.id, po.po_number, po.status, po.delivery_status, po.created_at,
              (SELECT COUNT(*) FROM purchase_order_items poi WHERE poi.po_id = po.id) AS item_count
       FROM purchase_orders po
       WHERE po.status = 'approved' AND po.delivery_status = 'qc_pending'
       ORDER BY po.created_at DESC`
    );
    return res.json(pos);
  }
  const pos = await db.all(
    `SELECT po.*, s.name as supplier_name, u.name as created_by_name
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     JOIN users u ON u.id = po.created_by
     WHERE po.status = 'approved' AND po.delivery_status = 'qc_pending'
     ORDER BY po.created_at DESC`
  );
  res.json(pos);
});

// ── Purchase payments: monthly "payments due" planning ────────────────────────
// A purchase is payable for the value of goods actually received & QC-approved:
// material (rate × qc_received_qty) PLUS the PO's IGST %, rounded to the nearest
// rupee. Note the stored grand_total is on ORDERED qty, so we recompute here on
// received qty. Allocated = Σ of its linked Account-Statement entries (pending
// unpaid-bank + cleared paid-bank). Remaining = payable − allocated; only bills
// with a positive remaining show up. Grouped later by the RECEIVED month. Must
// be defined BEFORE '/:id'.

// Payable (GST-inclusive) for a received value, rounded to the nearest rupee.
const receivedPayable = (material, igstPercent) =>
  Math.round(Number(material || 0) * (1 + Number(igstPercent || 0) / 100));

router.get('/payments-due', authenticate, authorize('owner', 'admin', 'accounts'), async (req, res) => {
  const db = getDB();
  const rows = await db.all(`
    SELECT po.id, po.po_number, po.igst_percent, po.created_at, s.name AS supplier_name,
      COALESCE(po.received_at, (SELECT MAX(COALESCE(poi.received_at, poi.qc_at))
               FROM purchase_order_items poi WHERE poi.po_id = po.id AND poi.qc_status = 'approved')) AS received_at,
      COALESCE((SELECT SUM(poi.rate * poi.qc_received_qty) FROM purchase_order_items poi
                WHERE poi.po_id = po.id AND poi.qc_status = 'approved' AND poi.qc_received_qty IS NOT NULL), 0) AS material_value,
      COALESCE((SELECT SUM(pce.amount) FROM petty_cash_entries pce
                WHERE pce.po_id = po.id AND pce.entry_type = 'expense' AND pce.payment_method = 'paid_bank'), 0) AS paid_cleared,
      COALESCE((SELECT SUM(pce.amount) FROM petty_cash_entries pce
                WHERE pce.po_id = po.id AND pce.entry_type = 'expense' AND pce.payment_method = 'unpaid_bank'), 0) AS paid_pending
    FROM purchase_orders po
    JOIN suppliers s ON s.id = po.supplier_id
    WHERE po.status NOT IN ('draft', 'rejected')
    ORDER BY received_at DESC NULLS LAST`);
  const bills = rows.map(r => {
    const material = Math.round(Number(r.material_value) * 100) / 100;
    const igst_percent = Number(r.igst_percent || 0);
    const received_value = receivedPayable(material, igst_percent);   // GST-incl, rounded
    const paid_cleared = Number(r.paid_cleared), paid_pending = Number(r.paid_pending);
    const remaining = Math.round((received_value - paid_cleared - paid_pending) * 100) / 100;
    return {
      id: r.id, po_number: r.po_number, supplier_name: r.supplier_name,
      received_at: r.received_at, igst_percent, material_value: material,
      received_value, paid_cleared, paid_pending, remaining,
    };
  }).filter(b => b.material_value > 0 && b.remaining > 0.009);
  const total_remaining = Math.round(bills.reduce((s, b) => s + b.remaining, 0) * 100) / 100;
  res.json({ bills, total_remaining });
});

// Create this month's purchase payments. Each selected bill posts ONE unpaid-
// bank Account-Statement entry (Paid To = supplier) linked to the PO. The owner
// later marks it paid, which deducts the bank. Partial amounts are allowed but
// never more than the bill's remaining balance.
router.post('/payments-due/pay', authenticate, authorize('owner', 'admin', 'accounts'), async (req, res) => {
  const payments = Array.isArray(req.body.payments) ? req.body.payments : [];
  const entryDate = req.body.entry_date || new Date().toISOString().slice(0, 10);
  if (!payments.length) return res.status(400).json({ error: 'Select at least one bill to pay' });
  const db = getDB();
  try {
    let created = 0;
    const errors = [];
    await db.withTransaction(async (client) => {
      for (const p of payments) {
        const poId = parseInt(p.po_id, 10);
        const amount = Math.round(Number(p.amount) * 100) / 100;
        if (!Number.isInteger(poId) || !(amount > 0)) { errors.push('Invalid payment row skipped'); continue; }
        const po = await client.query(
          `SELECT po.po_number, po.igst_percent, s.name AS supplier_name,
             COALESCE((SELECT SUM(poi.rate * poi.qc_received_qty) FROM purchase_order_items poi
                       WHERE poi.po_id = po.id AND poi.qc_status='approved' AND poi.qc_received_qty IS NOT NULL),0) AS material_value,
             COALESCE((SELECT SUM(pce.amount) FROM petty_cash_entries pce
                       WHERE pce.po_id = po.id AND pce.entry_type='expense'
                         AND pce.payment_method IN ('paid_bank','unpaid_bank')),0) AS allocated
           FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id=$1`, [poId]);
        const row = po.rows[0];
        if (!row) { errors.push(`PO ${poId} not found`); continue; }
        const receivedValue = receivedPayable(row.material_value, row.igst_percent); // GST-incl, rounded
        const remaining = Math.round((receivedValue - Number(row.allocated)) * 100) / 100;
        if (remaining <= 0) { errors.push(`${row.po_number}: already fully allocated`); continue; }
        if (amount > remaining + 0.009) { errors.push(`${row.po_number}: ₹${amount} exceeds remaining ₹${remaining}`); continue; }
        await client.query(
          `INSERT INTO petty_cash_entries (entry_date, entry_type, category, description, paid_to, amount,
             payment_method, affects_cash, po_id, created_by)
           VALUES ($1,'expense','Purchase Payment',$2,$3,$4,'unpaid_bank',FALSE,$5,$6)`,
          [entryDate, `Payment for ${row.po_number}`, row.supplier_name, amount, poId, req.user.id]);
        created += 1;
      }
      if (created === 0) throw new Error(errors[0] || 'No valid payments to record');
    });
    await logActivity(null, null, 'purchase_payments_planned', `${created} purchase payment(s) sent to unpaid bank`, req.user.id);
    res.status(201).json({ created, warnings: errors });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Failed to record payments' });
  }
});

// Record an ADVANCE against a PO before goods are received. Logs one Unpaid-Bank
// Account-Statement entry linked to the PO (two-step: the owner later marks it
// Paid, which deducts the Bank). Because it's linked by po_id, the advance auto-
// nets against the PO's received payable later — so it can't be double-paid.
router.post('/:id/advance', authenticate, authorize('owner', 'admin', 'accounts'), async (req, res) => {
  const poId = parseInt(req.params.id, 10);
  const amount = Math.round(Number(req.body.amount) * 100) / 100;
  const entryDate = req.body.entry_date || new Date().toISOString().slice(0, 10);
  const note = (req.body.note || '').trim();
  if (!Number.isInteger(poId)) return res.status(400).json({ error: 'Invalid PO' });
  if (!(amount > 0)) return res.status(400).json({ error: 'Enter a valid advance amount' });
  const db = getDB();
  const po = await db.get(
    `SELECT po.po_number, po.status, s.name AS supplier_name
       FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id=$1`, [poId]);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (['draft', 'rejected'].includes(po.status)) return res.status(400).json({ error: 'Advance can be recorded only on an active PO' });
  const r = await db.insert(
    `INSERT INTO petty_cash_entries (entry_date, entry_type, category, description, paid_to, amount,
       payment_method, affects_cash, po_id, created_by)
     VALUES ($1,'expense','Purchase Payment',$2,$3,$4,'unpaid_bank',FALSE,$5,$6)`,
    [entryDate, `Advance for ${po.po_number}${note ? ` — ${note}` : ''}`, po.supplier_name, amount, poId, req.user.id]);
  await logActivity(null, null, 'purchase_advance', `Advance ₹${amount} logged for ${po.po_number} (unpaid bank)`, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.get('/:id', authenticate, async (req, res) => {
  const db = getDB();

  // QC (design) users get a restricted view: PO number + items (name, qty,
  // drawing, QC fields) only — no supplier, rates, costs, totals, or invoice.
  if (req.user.role === 'design') {
    const po = await db.get('SELECT id, po_number, status, delivery_status FROM purchase_orders WHERE id=$1', [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Not found' });
    const items = await db.all(
      `SELECT poi.id, poi.description, poi.qty, poi.received, poi.received_at,
              poi.qc_status, poi.qc_weight_10, poi.qc_received_qty, poi.qc_rejected_qty, poi.qc_image_file, poi.qc_image_name,
              poi.qc_observations, poi.qc_rejection_reason,
              ii.item_code, ii.name as item_name, ii.unit as item_unit,
              ii.drawing_file, ii.drawing_original_name
       FROM purchase_order_items poi
       LEFT JOIN inventory_items ii ON ii.id = poi.inventory_item_id
       WHERE poi.po_id = $1 ORDER BY poi.id`,
      [req.params.id]
    );
    return res.json({ ...po, qc_limited: true, items });
  }

  const po = await db.get(
    `SELECT po.*, s.name as supplier_name, s.address as supplier_address,
            s.gst_no as supplier_gst, s.phone as supplier_phone,
            s.email as supplier_email, u.name as created_by_name
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     JOIN users u ON u.id = po.created_by
     WHERE po.id = $1`,
    [req.params.id]
  );
  if (!po) return res.status(404).json({ error: 'Not found' });

  const items = await db.all(
    `SELECT poi.*, ii.item_code, ii.name as item_name, ii.unit as item_unit,
            ii.drawing_file, ii.drawing_original_name
     FROM purchase_order_items poi
     LEFT JOIN inventory_items ii ON ii.id = poi.inventory_item_id
     WHERE poi.po_id = $1
     ORDER BY poi.id`,
    [req.params.id]
  );

  const materialQc = await db.get(
    `SELECT pmq.*, u.name as created_by_name
     FROM purchase_material_qc pmq
     LEFT JOIN users u ON u.id = pmq.created_by
     WHERE pmq.po_id = $1
     ORDER BY pmq.created_at DESC LIMIT 1`,
    [req.params.id]
  );

  // Purchase payments (advances before receipt + bill payments after) linked to
  // this PO — so the page can show what's been paid/pending against it.
  const payments = await db.all(
    `SELECT id, entry_date, amount, payment_method, description, created_at
       FROM petty_cash_entries WHERE po_id = $1 AND entry_type = 'expense'
      ORDER BY entry_date, id`, [req.params.id]);
  const sumBy = (m) => Math.round(payments.filter(p => p.payment_method === m).reduce((s, p) => s + Number(p.amount), 0) * 100) / 100;

  // Rejection photos per item + the PO's debit notes (pending & raised)
  if (items.length) {
    const rej = await db.all('SELECT * FROM purchase_item_rejection_photos WHERE item_id = ANY($1) ORDER BY id',
      [items.map(i => i.id)]);
    items.forEach(i => { i.rejection_photos = rej.filter(r => r.item_id === i.id); });
  }
  const debitNotes = await db.all(
    `SELECT dn.*, poi.description AS item_description, u.name AS raised_by_name
       FROM purchase_debit_notes dn
       LEFT JOIN purchase_order_items poi ON poi.id = dn.po_item_id
       LEFT JOIN users u ON u.id = dn.raised_by
      WHERE dn.po_id = $1 ORDER BY dn.id`, [req.params.id]);

  res.json({ ...po, items, material_qc: materialQc || null, debit_notes: debitNotes,
    payments, paid_cleared: sumBy('paid_bank'), paid_pending: sumBy('unpaid_bank') });
});

router.post('/', authenticate, authorize('owner', 'admin', 'accounts'), async (req, res) => {
  const { supplier_id, items, transport_charges, igst_percent, notes, expected_delivery_date } = req.body;
  if (!supplier_id) return res.status(400).json({ error: 'Supplier is required' });
  if (!items || items.length === 0) return res.status(400).json({ error: 'At least one item is required' });

  const db = getDB();
  const igst = igst_percent !== undefined ? Number(igst_percent) : 18;
  const tc = Number(transport_charges || 0);
  const { subtotal, igstAmount, grandTotal, roundOff } = calcTotals(items, tc, igst);
  const poNumber = await nextPoNumber(db);

  const r = await db.insert(
    `INSERT INTO purchase_orders
       (po_number, supplier_id, transport_charges, igst_percent, subtotal, igst_amount, round_off, grand_total,
        notes, expected_delivery_date, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [poNumber, supplier_id, tc, igst, subtotal, igstAmount, roundOff, grandTotal,
     notes||null, expected_delivery_date||null, req.user.id]
  );

  const poId = r.lastInsertRowid;
  for (const item of items) {
    await db.run(
      `INSERT INTO purchase_order_items (po_id, inventory_item_id, description, unit, qty, rate, amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [poId, item.inventory_item_id||null, item.description, item.unit||null,
       Number(item.qty), Number(item.rate), Number(item.amount)]
    );
  }

  const increases = await detectRateIncreases(db, supplier_id, items, 0);
  if (increases.length) await flagRateIncrease(db, { id: poId, po_number: poNumber }, increases, req.user.id);

  res.json({ id: poId, po_number: poNumber, rateIncreasePending: increases.length > 0 });
});

router.put('/:id', authenticate, authorize('owner', 'admin', 'accounts'), async (req, res) => {
  const db = getDB();
  const po = await db.get('SELECT * FROM purchase_orders WHERE id=$1', [req.params.id]);
  if (!po) return res.status(404).json({ error: 'Not found' });
  if (!['draft', 'rejected'].includes(po.status)) {
    return res.status(400).json({ error: 'Only draft or rejected POs can be edited' });
  }

  const { supplier_id, items, transport_charges, igst_percent, notes, expected_delivery_date } = req.body;
  if (!items || items.length === 0) return res.status(400).json({ error: 'At least one item is required' });

  const igst = igst_percent !== undefined ? Number(igst_percent) : po.igst_percent;
  const tc = Number(transport_charges !== undefined ? transport_charges : po.transport_charges);
  const { subtotal, igstAmount, grandTotal, roundOff } = calcTotals(items, tc, igst);

  await db.run(
    `UPDATE purchase_orders SET
       supplier_id=$1, transport_charges=$2, igst_percent=$3, subtotal=$4,
       igst_amount=$5, round_off=$6, grand_total=$7, notes=$8, expected_delivery_date=$9, status='draft'
     WHERE id=$10`,
    [supplier_id||po.supplier_id, tc, igst, subtotal, igstAmount, roundOff, grandTotal,
     notes||null, expected_delivery_date||po.expected_delivery_date||null, po.id]
  );

  await db.run('DELETE FROM purchase_order_items WHERE po_id=$1', [po.id]);
  for (const item of items) {
    await db.run(
      `INSERT INTO purchase_order_items (po_id, inventory_item_id, description, unit, qty, rate, amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [po.id, item.inventory_item_id||null, item.description, item.unit||null,
       Number(item.qty), Number(item.rate), Number(item.amount)]
    );
  }

  // Re-evaluate the rate-increase gate after the edit.
  const increases = await detectRateIncreases(db, supplier_id || po.supplier_id, items, po.id);
  if (increases.length) {
    if (!po.rate_increase_pending) await flagRateIncrease(db, { id: po.id, po_number: po.po_number }, increases, req.user.id);
    else await db.run('UPDATE purchase_orders SET rate_increase_pending=TRUE WHERE id=$1', [po.id]);
  } else {
    await db.run('UPDATE purchase_orders SET rate_increase_pending=FALSE WHERE id=$1', [po.id]);
  }

  res.json({ message: 'Updated', rateIncreasePending: increases.length > 0 });
});

router.put('/:id/send', authenticate, authorize('owner', 'admin', 'accounts'), async (req, res) => {
  const db = getDB();
  const po = await db.get('SELECT * FROM purchase_orders WHERE id=$1', [req.params.id]);
  if (!po) return res.status(404).json({ error: 'Not found' });
  if (!['draft', 'rejected'].includes(po.status)) {
    return res.status(400).json({ error: 'Only draft or rejected POs can be sent' });
  }
  if (po.rate_increase_pending) {
    return res.status(400).json({ error: 'This PO has a rate increase that needs owner approval before it can be sent.' });
  }
  await db.run("UPDATE purchase_orders SET status='sent', sent_at=NOW() WHERE id=$1", [po.id]);
  res.json({ message: 'PO marked as sent' });
});

// Owner approves a flagged rate increase, unlocking "Mark as Sent".
router.put('/:id/approve-rate', authenticate, authorize('owner'), async (req, res) => {
  const db = getDB();
  const po = await db.get('SELECT * FROM purchase_orders WHERE id=$1', [req.params.id]);
  if (!po) return res.status(404).json({ error: 'Not found' });
  if (!po.rate_increase_pending) return res.status(400).json({ error: 'No pending rate increase on this PO' });
  await db.run('UPDATE purchase_orders SET rate_increase_pending=FALSE, rate_increase_approved_by=$1, rate_increase_approved_at=NOW() WHERE id=$2', [req.user.id, po.id]);
  await db.run('INSERT INTO purchase_order_messages (po_id, user_id, message) VALUES ($1,$2,$3)',
    [po.id, req.user.id, '✅ Owner approved the rate increase — this PO can now be marked as sent.']);
  res.json({ message: 'Rate increase approved' });
});

router.put('/:id/approve', authenticate, authorize('owner', 'admin', 'accounts'), async (req, res) => {
  const db = getDB();
  const po = await db.get('SELECT * FROM purchase_orders WHERE id=$1', [req.params.id]);
  if (!po) return res.status(404).json({ error: 'Not found' });
  if (po.status !== 'sent') return res.status(400).json({ error: 'PO must be in sent status to approve' });

  const { expected_delivery_date } = req.body;

  // On approval the PO automatically enters "Purchase Accepted".
  await db.run(
    `UPDATE purchase_orders SET
       status='approved', approved_at=NOW(),
       delivery_status='purchase_accepted', expected_delivery_date=COALESCE($1, expected_delivery_date)
     WHERE id=$2`,
    [expected_delivery_date||null, po.id]
  );

  // Sync the supplier-item link rate to this PO's approved rate. If an item's
  // final rate differs from the rate stored on the supplier↔item link, update
  // the link so the catalog always reflects the latest approved price.
  let ratesUpdated = 0;
  const poItems = await db.all('SELECT inventory_item_id, rate FROM purchase_order_items WHERE po_id=$1 AND inventory_item_id IS NOT NULL', [po.id]);
  for (const it of poItems) {
    const link = await db.get('SELECT supplier_price FROM supplier_items WHERE supplier_id=$1 AND inventory_item_id=$2', [po.supplier_id, it.inventory_item_id]);
    if (link && Number(link.supplier_price) !== Number(it.rate)) {
      await db.run('UPDATE supplier_items SET supplier_price=$1 WHERE supplier_id=$2 AND inventory_item_id=$3', [Number(it.rate), po.supplier_id, it.inventory_item_id]);
      ratesUpdated++;
    }
  }

  res.json({ message: 'PO approved', ratesUpdated });
});

router.put('/:id/reject', authenticate, authorize('owner', 'admin', 'accounts'), async (req, res) => {
  const db = getDB();
  const po = await db.get('SELECT * FROM purchase_orders WHERE id=$1', [req.params.id]);
  if (!po) return res.status(404).json({ error: 'Not found' });
  if (po.status !== 'sent') return res.status(400).json({ error: 'PO must be in sent status to reject' });
  await db.run("UPDATE purchase_orders SET status='rejected' WHERE id=$1", [po.id]);
  res.json({ message: 'PO rejected — edit and resend' });
});

router.put('/:id/delivery-status', authenticate, authorize('owner', 'admin', 'accounts'), async (req, res) => {
  const db = getDB();
  const po = await db.get('SELECT * FROM purchase_orders WHERE id=$1', [req.params.id]);
  if (!po) return res.status(404).json({ error: 'Not found' });
  if (po.status !== 'approved') return res.status(400).json({ error: 'PO must be approved to update delivery status' });

  const { delivery_status, expected_delivery_date } = req.body;
  // After approval only In Transit or Order Cancelled are manual options.
  // "Received" is its own action (requires an invoice) and QC is automatic.
  if (!['in_transit', 'order_cancelled'].includes(delivery_status)) {
    return res.status(400).json({ error: 'Invalid delivery status' });
  }
  if (!['purchase_accepted', 'in_transit'].includes(po.delivery_status)) {
    return res.status(400).json({ error: 'Delivery status can no longer be changed for this PO' });
  }

  await db.run(
    `UPDATE purchase_orders SET delivery_status=$1,
       expected_delivery_date=COALESCE($2, expected_delivery_date)
     WHERE id=$3`,
    [delivery_status, expected_delivery_date||null, po.id]
  );
  res.json({ message: 'Delivery status updated' });
});

// Undo a receive — for a mistake caught before QC (e.g. the transport bill was
// forgotten). Owner only. Stock is added at QC, not at receive, so nothing has
// moved yet; this just puts the item back to "not received" so it can be
// received again properly.
//
// It refuses once QC has looked at the item, or once a transport bill has been
// posted: that bill is a real Account-Statement entry paid to a transporter and
// is not linked to the PO, so silently unwinding it here would leave the bank
// reconciliation wrong. Delete that entry from the Account Statement first.
router.put('/:id/items/:itemId/unreceive', authenticate, authorize('owner'), async (req, res) => {
  try {
    const db = getDB();
    const po = await db.get('SELECT * FROM purchase_orders WHERE id=$1', [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Not found' });
    const item = await db.get('SELECT * FROM purchase_order_items WHERE id=$1 AND po_id=$2', [req.params.itemId, po.id]);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (!item.received) return res.status(400).json({ error: 'This item is not received' });
    if (item.qc_status) return res.status(400).json({ error: 'QC has already inspected this item — it cannot be un-received' });
    const lots = await db.get('SELECT COUNT(*)::int AS n FROM inventory_fifo_lots WHERE po_id=$1 AND item_id=$2',
      [po.id, item.inventory_item_id || 0]);
    if (lots?.n > 0) return res.status(400).json({ error: 'Stock from this item is already in inventory — it cannot be un-received' });
    const t = Number(item.receive_transport_cost) || 0, l = Number(item.receive_local_transport_cost) || 0;
    if (t > 0 || l > 0) {
      return res.status(400).json({
        error: 'A transport bill was already posted for this item. Delete that Purchase Transport entry from the Account Statement first, then un-receive.',
      });
    }

    await db.run(
      `UPDATE purchase_order_items
          SET received=FALSE, received_at=NULL, invoice_file=NULL, invoice_original_name=NULL,
              receive_other_cost=NULL, receive_other_cost_reason=NULL
        WHERE id=$1`, [item.id]);
    // Nothing received on the PO any more → back to the state it was in before.
    const stillReceived = await db.get(
      'SELECT COUNT(*)::int AS n FROM purchase_order_items WHERE po_id=$1 AND received=TRUE', [po.id]);
    if (stillReceived.n === 0 && po.delivery_status === 'qc_pending') {
      await db.run("UPDATE purchase_orders SET delivery_status='purchase_accepted', received_at=NULL WHERE id=$1", [po.id]);
    }
    await logActivity(null, null, 'purchase_unreceived',
      `${po.po_number}: "${item.description}" un-received — to be received again`, req.user.id);
    res.json({ message: 'Item un-received — receive it again with the correct details' });
  } catch (e) {
    console.error('unreceive error:', e);
    res.status(500).json({ error: 'Failed to un-receive the item' });
  }
});

// Mark a SINGLE item received: its own invoice is mandatory. The item then
// awaits QC. Items can be received one at a time as they arrive. Stock is added
// per item when it passes QC.
router.post('/:id/items/:itemId/receive', authenticate, authorize('owner', 'admin', 'accounts'),
  ...uploadPurchaseInvoice, async (req, res) => {
   try {
    const db = getDB();
    const po = await db.get('SELECT * FROM purchase_orders WHERE id=$1', [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.status !== 'approved') return res.status(400).json({ error: 'PO must be approved to receive items' });
    if (!['purchase_accepted', 'in_transit', 'qc_pending'].includes(po.delivery_status)) {
      return res.status(400).json({ error: 'This PO is not in a receivable state' });
    }
    const item = await db.get('SELECT * FROM purchase_order_items WHERE id=$1 AND po_id=$2', [req.params.itemId, po.id]);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.received) return res.status(400).json({ error: 'This item is already received' });
    if (!req.file) return res.status(400).json({ error: 'The invoice received with this item is required' });

    const transportCost = Number(req.body.transport_cost) || 0;             // main vehicle freight (the whole bill)
    const transportPaidTo = (req.body.transport_paid_to || '').trim() || null;
    const localCost = Number(req.body.local_transport_cost) || 0;           // dock → unit transport (the whole bill)
    const localPaidTo = (req.body.local_transport_paid_to || '').trim() || null;
    const otherCost = Number(req.body.other_cost) || 0;
    const otherReason = (req.body.other_cost_reason || '').trim() || null;
    if (otherCost > 0 && !otherReason) return res.status(400).json({ error: 'A reason is required for the other cost' });
    if (transportCost > 0 && !transportPaidTo) return res.status(400).json({ error: 'Enter the main-vehicle transporter name' });
    if (localCost > 0 && !localPaidTo) return res.status(400).json({ error: 'Enter the local transporter name' });

    // One transport bill can cover several items of the delivery (one truck
    // bringing the whole PO). The client sends the covered item ids: the bill
    // posts ONCE to the Account Statement, and each covered item gets a
    // landed-cost share proportional to its material value (poi.amount) —
    // added, not overwritten, so a later second vehicle's bill stacks onto
    // whichever items it carried. Entries are NOT linked to the PO's payable
    // (paid to a transporter, not the supplier).
    let coveredIds = [item.id];
    try {
      const raw = JSON.parse(req.body.transport_covered_item_ids || '[]');
      if (Array.isArray(raw) && raw.length) {
        coveredIds = [...new Set(raw.map(n => parseInt(n, 10)).filter(Number.isInteger).concat(item.id))];
      }
    } catch { /* default: just this item */ }
    const covered = (transportCost > 0 || localCost > 0)
      ? await db.all('SELECT id, description, amount FROM purchase_order_items WHERE id = ANY($1) AND po_id=$2', [coveredIds, po.id])
      : [];
    if ((transportCost > 0 || localCost > 0) && covered.length !== coveredIds.length) {
      return res.status(400).json({ error: 'Covered items must belong to this PO' });
    }
    // Value-based shares that sum exactly to the bill (last item takes the remainder)
    const shares = (total) => {
      const base = covered.reduce((s, c) => s + (Number(c.amount) || 0), 0);
      let acc = 0;
      return covered.map((c, i) => {
        if (i === covered.length - 1) return Math.round((total - acc) * 100) / 100;
        const sh = Math.round((base > 0 ? total * (Number(c.amount) || 0) / base : total / covered.length) * 100) / 100;
        acc += sh;
        return sh;
      });
    };
    const tShares = transportCost > 0 ? shares(transportCost) : [];
    const lShares = localCost > 0 ? shares(localCost) : [];

    await db.withTransaction(async (client) => {
      await client.query(
        `UPDATE purchase_order_items SET received=TRUE, received_at=NOW(), invoice_file=$1, invoice_original_name=$2,
           receive_other_cost=$3, receive_other_cost_reason=$4 WHERE id=$5`,
        [req.file.storagePath, req.file.originalname, otherCost, otherReason, item.id]
      );
      for (let i = 0; i < covered.length; i++) {
        if (transportCost > 0) {
          await client.query(
            `UPDATE purchase_order_items SET receive_transport_cost = COALESCE(receive_transport_cost,0) + $1,
               receive_transport_paid_to = COALESCE(receive_transport_paid_to, $2) WHERE id=$3`,
            [tShares[i], transportPaidTo, covered[i].id]);
        }
        if (localCost > 0) {
          await client.query(
            `UPDATE purchase_order_items SET receive_local_transport_cost = COALESCE(receive_local_transport_cost,0) + $1,
               receive_local_transport_paid_to = COALESCE(receive_local_transport_paid_to, $2) WHERE id=$3`,
            [lShares[i], localPaidTo, covered[i].id]);
        }
      }
      const coveredLabel = covered.length > 1 ? `${covered.length} items` : (item.description || '1 item');
      if (transportCost > 0) {
        await client.query(
          `INSERT INTO petty_cash_entries (entry_date, entry_type, category, description, paid_to, amount, payment_method, affects_cash, created_by)
           VALUES (CURRENT_DATE,'expense','Purchase Transport',$1,$2,$3,'unpaid_bank',FALSE,$4)`,
          [`Main vehicle transport — ${po.po_number} (${coveredLabel})`, transportPaidTo, transportCost, req.user.id]);
      }
      if (localCost > 0) {
        await client.query(
          `INSERT INTO petty_cash_entries (entry_date, entry_type, category, description, paid_to, amount, payment_method, affects_cash, created_by)
           VALUES (CURRENT_DATE,'expense','Purchase Transport',$1,$2,$3,'cash',TRUE,$4)`,
          [`Local transport (dock → unit) — ${po.po_number} (${coveredLabel})`, localPaidTo, localCost, req.user.id]);
      }
    });

    // Notify owners of the new Unpaid-Bank main-vehicle freight awaiting payment.
    if (transportCost > 0) {
      try {
        const owners = await db.all("SELECT id FROM users WHERE role='owner' AND id != $1", [req.user.id]);
        for (const o of owners) {
          await createNotification(db, {
            userId: o.id, type: 'petty_cash_unpaid',
            title: `Main-vehicle transport: ₹${transportCost}`,
            body: `${transportPaidTo} — ${po.po_number} freight, awaiting bank payment`,
            link: '/petty-cash', sourceUserId: req.user.id,
          });
        }
      } catch (e) { console.error('transport notify failed:', e.message); }
    }
    // Move the PO into QC (if not already) so it surfaces in the QC section.
    if (po.delivery_status !== 'qc_pending') {
      await db.run("UPDATE purchase_orders SET delivery_status='qc_pending' WHERE id=$1", [po.id]);
    }
    const qcUsers = await db.all(`SELECT id FROM users WHERE role = 'design'`);
    for (const u of qcUsers) {
      await createNotification(db, {
        userId: u.id, type: 'purchase_qc_pending',
        title: `Material QC needed — ${po.po_number}`,
        body: `Item "${item.description}" received — awaiting QC (material image + weight of 10 pcs).`,
        link: `/purchases/${po.id}`, sourceUserId: req.user.id,
      });
    }
    await logActivity(null, null, 'purchase_received', `PO ${po.po_number}: item "${item.description}" received & sent to QC`, req.user.id);
    res.json({ message: 'Item received — sent to QC' });
   } catch (err) {
    console.error('[po/receive] error:', err);
    res.status(500).json({ error: err.message || 'Failed to receive item' });
   }
  }
);

// Per-item QC with three outcomes:
//   approved — everything accepted (material image + weight of 10 mandatory);
//   rejected — everything rejected (reason + ≥1 rejection photo mandatory);
//   partial  — accepted qty goes to stock, rejected qty (reason + photos) doesn't.
// Any rejected qty (full or partial) opens a PENDING DEBIT NOTE for the item —
// suggested amount = rejected qty × rate + the PO's IGST — and notifies accounts
// to raise it with the supplier (photos attached on the PO page).
router.post('/:id/items/:itemId/qc', authenticate, authorize('design', 'owner', 'admin'),
  ...uploadPurchaseItemQCFields, async (req, res) => {
   try {
    const db = getDB();
    const po = await db.get('SELECT * FROM purchase_orders WHERE id=$1', [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.delivery_status !== 'qc_pending') return res.status(400).json({ error: 'PO is not awaiting QC' });
    const item = await db.get('SELECT * FROM purchase_order_items WHERE id=$1 AND po_id=$2', [req.params.itemId, po.id]);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (!item.received) return res.status(400).json({ error: 'This item must be marked received before QC' });
    if (['approved', 'rejected', 'partial'].includes(item.qc_status)) {
      return res.status(400).json({ error: 'This item\'s QC is already recorded' });
    }

    const { result, weight_10, received_qty, rejected_qty, observations, rejection_reason } = req.body;
    if (!['approved', 'rejected', 'partial'].includes(result)) {
      return res.status(400).json({ error: 'Pick a QC result (approved / partial / rejected)' });
    }
    const materialImage = req.files?.image?.[0] || null;
    const rejPhotos = req.files?.rejection_photos || [];
    const acceptedQty = result === 'rejected' ? 0 : Number(received_qty);
    const rejectedQty = result === 'approved' ? 0
      : result === 'partial' ? Number(rejected_qty)
      : (Number(rejected_qty) > 0 ? Number(rejected_qty) : Number(item.qty));

    if (result !== 'rejected') {
      if (!materialImage) return res.status(400).json({ error: 'A material image is required to approve material' });
      if (!weight_10 || Number(weight_10) <= 0) return res.status(400).json({ error: 'Weight of 10 pcs is required to approve material' });
      if (!(acceptedQty > 0)) return res.status(400).json({ error: 'Enter the accepted quantity' });
    }
    if (result !== 'approved') {
      if (!rejection_reason?.trim()) return res.status(400).json({ error: 'A rejection reason is required' });
      if (!rejPhotos.length) return res.status(400).json({ error: 'At least one rejection photo is required for any rejection' });
      if (!(rejectedQty > 0)) return res.status(400).json({ error: 'Enter the rejected quantity' });
    }

    let debitNoteId = null;
    await db.withTransaction(async (client) => {
      await client.query(
        `UPDATE purchase_order_items SET qc_status=$1, qc_weight_10=$2, qc_received_qty=$3, qc_rejected_qty=$4,
           qc_image_file=$5, qc_image_name=$6, qc_observations=$7, qc_rejection_reason=$8, qc_by=$9, qc_at=NOW() WHERE id=$10`,
        [result, result !== 'rejected' ? Number(weight_10) : null, acceptedQty > 0 ? acceptedQty : null,
         rejectedQty > 0 ? rejectedQty : null,
         materialImage?.storagePath || null, materialImage?.originalname || null,
         observations || null, result !== 'approved' ? rejection_reason.trim() : null, req.user.id, item.id]
      );
      for (const p of rejPhotos) {
        await client.query(
          'INSERT INTO purchase_item_rejection_photos (item_id, file_path, original_name, created_by) VALUES ($1,$2,$3,$4)',
          [item.id, p.storagePath, p.originalname, req.user.id]);
      }
      if (rejectedQty > 0) {
        // One debit note per item: rejected qty × rate, plus the PO's IGST —
        // editable by accounts when they actually raise it.
        const suggested = Math.round(rejectedQty * (Number(item.rate) || 0) * (1 + (Number(po.igst_percent) || 0) / 100) * 100) / 100;
        const { rows: dn } = await client.query(
          `INSERT INTO purchase_debit_notes (po_id, po_item_id, rejected_qty, suggested_amount) VALUES ($1,$2,$3,$4) RETURNING id`,
          [po.id, item.id, rejectedQty, suggested]);
        debitNoteId = dn[0].id;
      }
    });

    if (acceptedQty > 0) await receiveItemStock(db, po, item, req.user.id, acceptedQty);

    // Accounts raise the debit note — tell them what, how much, and where.
    if (debitNoteId) {
      try {
        const accountsUsers = await db.all("SELECT id FROM users WHERE role IN ('accounts','owner') AND id != $1", [req.user.id]);
        for (const u of accountsUsers) {
          await createNotification(db, {
            userId: u.id, type: 'debit_note_pending',
            title: `Debit note needed — ${po.po_number}`,
            body: `${item.description}: ${rejectedQty} rejected at QC. Raise a debit note to the supplier (photos on the PO page).`,
            link: `/purchases/${po.id}`, sourceUserId: req.user.id,
          });
        }
      } catch (e) { console.error('debit-note notify failed:', e.message); }
    }

    // Finalise the PO once every item has been QC-resolved.
    const items = await db.all('SELECT qc_status FROM purchase_order_items WHERE po_id=$1', [po.id]);
    const allResolved = items.every(i => ['approved', 'rejected', 'partial'].includes(i.qc_status));
    if (allResolved) {
      // Fully-rejected POs flag as material_rejected; partials received (their
      // accepted stock is in — the rejection lives on in the debit note).
      const anyFullReject = items.some(i => i.qc_status === 'rejected');
      await db.run(
        "UPDATE purchase_orders SET status='received', received_at=NOW(), delivery_status=$1 WHERE id=$2",
        [anyFullReject ? 'material_rejected' : 'received', po.id]
      );
    }
    await logActivity(null, null, 'purchase_qc',
      `PO ${po.po_number}: item QC ${result}${rejectedQty > 0 ? ` (${rejectedQty} rejected → debit note pending)` : ''}`, req.user.id);
    res.json({ message: result === 'approved' ? 'Item QC approved — stock added'
      : result === 'partial' ? `Partial: ${acceptedQty} accepted to stock, ${rejectedQty} rejected — debit note pending`
      : 'Item QC rejected — debit note pending', allResolved });
   } catch (err) {
    console.error('[po/item-qc] error:', err);
    res.status(500).json({ error: err.message || 'Failed to record QC' });
   }
  }
);

// Accounts raises a pending debit note: note number required, amount defaults
// to the suggestion but is editable, optional document upload of what was sent.
router.put('/:id/debit-notes/:dnId/raise', authenticate, authorize('accounts', 'owner', 'admin'),
  ...uploadDebitNote, async (req, res) => {
   try {
    const db = getDB();
    const dn = await db.get('SELECT * FROM purchase_debit_notes WHERE id=$1 AND po_id=$2', [req.params.dnId, req.params.id]);
    if (!dn) return res.status(404).json({ error: 'Debit note not found' });
    if (dn.status === 'raised') return res.status(400).json({ error: 'This debit note is already raised' });
    const noteNo = (req.body.note_no || '').trim();
    if (!noteNo) return res.status(400).json({ error: 'Enter the debit note number' });
    const amount = Math.round((Number(req.body.amount) > 0 ? Number(req.body.amount) : Number(dn.suggested_amount)) * 100) / 100;
    await db.run(
      `UPDATE purchase_debit_notes SET status='raised', note_no=$1, amount=$2, notes=$3,
         file_path=$4, original_name=$5, raised_by=$6, raised_at=NOW() WHERE id=$7`,
      [noteNo, amount, (req.body.notes || '').trim() || null,
       req.file?.storagePath || null, req.file?.originalname || null, req.user.id, dn.id]);
    const po = await db.get('SELECT po_number FROM purchase_orders WHERE id=$1', [req.params.id]);
    await logActivity(null, null, 'debit_note_raised',
      `Debit note ${noteNo} (₹${amount}) raised for ${po?.po_number || `PO #${req.params.id}`}`, req.user.id);
    res.json({ message: 'Debit note raised' });
   } catch (err) {
    console.error('[po/debit-note] error:', err);
    res.status(500).json({ error: err.message || 'Failed to raise debit note' });
   }
  }
);

router.get('/last-rate/:itemId', authenticate, async (req, res) => {
  const last = await getDB().get(
    `SELECT poi.rate FROM purchase_order_items poi
     JOIN purchase_orders po ON po.id = poi.po_id
     WHERE poi.inventory_item_id = $1
     ORDER BY po.created_at DESC LIMIT 1`,
    [req.params.itemId]
  );
  res.json({ rate: last?.rate || 0 });
});

router.delete('/:id', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    const db = getDB();
    const po = await db.get('SELECT * FROM purchase_orders WHERE id=$1', [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (req.user.role !== 'owner' && !['draft', 'rejected'].includes(po.status)) {
      return res.status(400).json({ error: 'Only draft or rejected POs can be deleted' });
    }

    // Reverse any stock this PO still has on hand (from its FIFO lots), then remove
    // the lots — they reference the PO and would otherwise block the delete.
    const lots = await db.all('SELECT * FROM inventory_fifo_lots WHERE po_id=$1', [po.id]);
    for (const lot of lots) {
      const remaining = Number(lot.qty_remaining) || 0;
      if (remaining > 0 && lot.item_id) {
        const inv = await db.get('SELECT current_stock FROM inventory_items WHERE id=$1', [lot.item_id]);
        if (inv) {
          const newStock = (Number(inv.current_stock) || 0) - remaining;
          await db.run('UPDATE inventory_items SET current_stock=$1 WHERE id=$2', [newStock, lot.item_id]);
          await db.insert(
            `INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, po_number, notes, created_by)
             VALUES ($1,'return_from_production',$2,$3,$4,$5,$6)`,
            [lot.item_id, remaining, newStock, po.po_number, `PO ${po.po_number} deleted — on-hand stock reversed`, req.user.id]
          );
        }
      }
    }
    await db.run('DELETE FROM inventory_fifo_lots WHERE po_id=$1', [po.id]);
    await db.run('DELETE FROM purchase_order_messages WHERE po_id=$1', [po.id]);
    await db.run('DELETE FROM purchase_material_qc WHERE po_id=$1', [po.id]);
    await db.run('DELETE FROM purchase_order_items WHERE po_id=$1', [po.id]);
    await db.run('DELETE FROM purchase_orders WHERE id=$1', [po.id]);
    res.json({ message: 'Purchase order deleted' });
  } catch (err) {
    console.error('[po/delete] error:', err);
    res.status(500).json({ error: err.message || 'Failed to delete' });
  }
});

router.get('/:id/messages', authenticate, async (req, res) => {
  const db = getDB();
  const messages = await db.all(
    `SELECT pom.*, u.name as user_name, u.role as user_role
     FROM purchase_order_messages pom
     JOIN users u ON pom.user_id = u.id
     WHERE pom.po_id = $1
     ORDER BY pom.created_at ASC`,
    [req.params.id]
  );
  for (const msg of messages) {
    msg.attachments = await db.all(
      'SELECT id, file_path, file_name, file_size, mime_type FROM purchase_order_message_attachments WHERE message_id = $1',
      [msg.id]
    );
  }
  res.json(messages);
});

router.post('/:id/messages', authenticate, ...uploadChatAttachments, async (req, res) => {
  const { message } = req.body;
  let mentionIds = req.body.mentionIds;
  if (typeof mentionIds === 'string') try { mentionIds = JSON.parse(mentionIds); } catch { mentionIds = []; }
  const hasFiles = req.files?.length > 0;
  if (!message?.trim() && !hasFiles) return res.status(400).json({ error: 'Message or attachment required' });

  const db = getDB();
  const r = await db.insert(
    'INSERT INTO purchase_order_messages (po_id, user_id, message) VALUES ($1,$2,$3)',
    [req.params.id, req.user.id, (message || '').trim()]
  );
  const messageId = r.lastInsertRowid;

  if (hasFiles) {
    for (const f of req.files) {
      await db.insert(
        'INSERT INTO purchase_order_message_attachments (message_id, file_path, file_name, file_size, mime_type) VALUES ($1,$2,$3,$4,$5)',
        [messageId, f.storagePath, f.originalname, f.size, f.mimetype]
      );
    }
  }

  if (Array.isArray(mentionIds) && mentionIds.length) {
    for (const userId of mentionIds) {
      if (userId !== req.user.id) {
        await db.run(
          'INSERT INTO purchase_order_message_mentions (message_id, po_id, mentioned_user_id) VALUES ($1,$2,$3)',
          [messageId, req.params.id, userId]
        );
      }
    }
    const po = await db.get('SELECT po_number FROM purchase_orders WHERE id=$1', [req.params.id]);
    const poNo = po?.po_number || `PO #${req.params.id}`;
    const preview = (message || '').trim().slice(0, 100);
    const fileNote = hasFiles ? ` [+${req.files.length} file${req.files.length > 1 ? 's' : ''}]` : '';
    for (const userId of mentionIds) {
      if (userId !== req.user.id) {
        await createNotification(db, {
          userId,
          type: 'po_message',
          title: `${req.user.name} in ${poNo}`,
          body: preview ? preview + fileNote : `Sent${fileNote}`,
          link: `/purchases/${req.params.id}`,
          sourceUserId: req.user.id,
        });
      }
    }
  }

  res.status(201).json({ id: messageId });
});

module.exports = router;
