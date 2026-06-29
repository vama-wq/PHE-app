const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadPurchaseQC, uploadPurchaseInvoice, uploadPurchaseItemQC } = require('../middleware/upload');
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
  await db.run(
    `INSERT INTO inventory_fifo_lots (item_id, po_id, qty_original, qty_remaining, unit_cost, received_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [item.inventory_item_id, po.id, q, q, item.rate, now]
  );
  const inv = await db.get('SELECT current_stock FROM inventory_items WHERE id=$1', [item.inventory_item_id]);
  const newStock = (Number(inv.current_stock) || 0) + q;
  const lots = await db.all('SELECT qty_remaining, unit_cost FROM inventory_fifo_lots WHERE item_id=$1 AND qty_remaining > 0', [item.inventory_item_id]);
  const totalQty = lots.reduce((s, l) => s + Number(l.qty_remaining), 0);
  const totalCost = lots.reduce((s, l) => s + Number(l.qty_remaining) * Number(l.unit_cost), 0);
  const avgCost = totalQty > 0 ? totalCost / totalQty : Number(item.rate);
  await db.run('UPDATE inventory_items SET current_stock=$1, unit_cost=$2 WHERE id=$3',
    [newStock, Math.round(avgCost * 100) / 100, item.inventory_item_id]);
  await db.run(
    `INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, po_number, supplier_name, notes, created_by)
     VALUES ($1,'purchase_in',$2,$3,$4,$5,$6,$7)`,
    [item.inventory_item_id, q, newStock, po.po_number, supplier?.name || '',
     `PO received (QC approved): ${po.po_number} — qty ${q}${Number(item.qty) !== q ? ` of ${item.qty} ordered` : ''}`, userId]
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

function calcTotals(items, transportCharges, igstPercent) {
  const subtotal = items.reduce((s, i) => s + i.amount, 0) + Number(transportCharges || 0);
  const igstAmount = Math.round(subtotal * (igstPercent / 100) * 100) / 100;
  const grandTotal = Math.round((subtotal + igstAmount) * 100) / 100;
  return { subtotal, igstAmount, grandTotal };
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
    `SELECT po.*, s.name as supplier_name, u.name as created_by_name
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

router.get('/:id', authenticate, async (req, res) => {
  const db = getDB();

  // QC (design) users get a restricted view: PO number + items (name, qty,
  // drawing, QC fields) only — no supplier, rates, costs, totals, or invoice.
  if (req.user.role === 'design') {
    const po = await db.get('SELECT id, po_number, status, delivery_status FROM purchase_orders WHERE id=$1', [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Not found' });
    const items = await db.all(
      `SELECT poi.id, poi.description, poi.qty, poi.received, poi.received_at,
              poi.qc_status, poi.qc_weight_10, poi.qc_received_qty, poi.qc_image_file, poi.qc_image_name,
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

  res.json({ ...po, items, material_qc: materialQc || null });
});

router.post('/', authenticate, authorize('owner', 'admin', 'accounts'), async (req, res) => {
  const { supplier_id, items, transport_charges, igst_percent, notes, expected_delivery_date } = req.body;
  if (!supplier_id) return res.status(400).json({ error: 'Supplier is required' });
  if (!items || items.length === 0) return res.status(400).json({ error: 'At least one item is required' });

  const db = getDB();
  const igst = igst_percent !== undefined ? Number(igst_percent) : 18;
  const tc = Number(transport_charges || 0);
  const { subtotal, igstAmount, grandTotal } = calcTotals(items, tc, igst);
  const poNumber = await nextPoNumber(db);

  const r = await db.insert(
    `INSERT INTO purchase_orders
       (po_number, supplier_id, transport_charges, igst_percent, subtotal, igst_amount, grand_total,
        notes, expected_delivery_date, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [poNumber, supplier_id, tc, igst, subtotal, igstAmount, grandTotal,
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
  const { subtotal, igstAmount, grandTotal } = calcTotals(items, tc, igst);

  await db.run(
    `UPDATE purchase_orders SET
       supplier_id=$1, transport_charges=$2, igst_percent=$3, subtotal=$4,
       igst_amount=$5, grand_total=$6, notes=$7, expected_delivery_date=$8, status='draft'
     WHERE id=$9`,
    [supplier_id||po.supplier_id, tc, igst, subtotal, igstAmount, grandTotal,
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

    await db.run(
      `UPDATE purchase_order_items SET received=TRUE, received_at=NOW(), invoice_file=$1, invoice_original_name=$2 WHERE id=$3`,
      [req.file.storagePath, req.file.originalname, item.id]
    );
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

// Per-item QC: a material image and weight of 10 pcs are mandatory to approve.
// Approving an item adds its stock to inventory; once every item is resolved the
// PO is finalised (received, or material_rejected if any item was rejected).
router.post('/:id/items/:itemId/qc', authenticate, authorize('design', 'owner', 'admin'),
  ...uploadPurchaseItemQC, async (req, res) => {
   try {
    const db = getDB();
    const po = await db.get('SELECT * FROM purchase_orders WHERE id=$1', [req.params.id]);
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.delivery_status !== 'qc_pending') return res.status(400).json({ error: 'PO is not awaiting QC' });
    const item = await db.get('SELECT * FROM purchase_order_items WHERE id=$1 AND po_id=$2', [req.params.itemId, po.id]);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (!item.received) return res.status(400).json({ error: 'This item must be marked received before QC' });
    if (item.qc_status === 'approved') return res.status(400).json({ error: 'This item is already QC-approved' });

    const { result, weight_10, received_qty, observations, rejection_reason } = req.body;
    const accepted = result !== 'rejected';
    if (accepted) {
      if (!req.file) return res.status(400).json({ error: 'A material image is required to approve this item' });
      if (!weight_10 || Number(weight_10) <= 0) return res.status(400).json({ error: 'Weight of 10 pcs is required to approve this item' });
      if (!received_qty || Number(received_qty) <= 0) return res.status(400).json({ error: 'Actual quantity received is required to approve this item' });
    } else if (!rejection_reason?.trim()) {
      return res.status(400).json({ error: 'A rejection reason is required' });
    }

    await db.run(
      `UPDATE purchase_order_items SET qc_status=$1, qc_weight_10=$2, qc_received_qty=$3, qc_image_file=$4, qc_image_name=$5,
         qc_observations=$6, qc_rejection_reason=$7, qc_by=$8, qc_at=NOW() WHERE id=$9`,
      [accepted ? 'approved' : 'rejected', accepted ? Number(weight_10) : null, accepted ? Number(received_qty) : null,
       req.file?.storagePath || null, req.file?.originalname || null,
       observations || null, accepted ? null : rejection_reason.trim(), req.user.id, item.id]
    );

    if (accepted) await receiveItemStock(db, po, item, req.user.id, Number(received_qty));

    // Finalise the PO once every item has been QC-resolved.
    const items = await db.all('SELECT qc_status FROM purchase_order_items WHERE po_id=$1', [po.id]);
    const allResolved = items.every(i => i.qc_status === 'approved' || i.qc_status === 'rejected');
    if (allResolved) {
      const anyRejected = items.some(i => i.qc_status === 'rejected');
      await db.run(
        "UPDATE purchase_orders SET status='received', received_at=NOW(), delivery_status=$1 WHERE id=$2",
        [anyRejected ? 'material_rejected' : 'received', po.id]
      );
    }
    await logActivity(null, null, 'purchase_qc', `PO ${po.po_number}: item QC ${accepted ? 'approved' : 'rejected'}`, req.user.id);
    res.json({ message: accepted ? 'Item QC approved — stock added' : 'Item QC rejected', allResolved });
   } catch (err) {
    console.error('[po/item-qc] error:', err);
    res.status(500).json({ error: err.message || 'Failed to record QC' });
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
  const db = getDB();
  const po = await db.get('SELECT * FROM purchase_orders WHERE id=$1', [req.params.id]);
  if (!po) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'owner' && !['draft', 'rejected'].includes(po.status)) {
    return res.status(400).json({ error: 'Only draft or rejected POs can be deleted' });
  }
  await db.run('DELETE FROM purchase_order_messages WHERE po_id=$1', [po.id]);
  await db.run('DELETE FROM purchase_material_qc WHERE po_id=$1', [po.id]);
  await db.run('DELETE FROM purchase_orders WHERE id=$1', [po.id]);
  res.json({ message: 'Purchase order deleted' });
});

router.get('/:id/messages', authenticate, async (req, res) => {
  const messages = await getDB().all(
    `SELECT pom.*, u.name as user_name, u.role as user_role
     FROM purchase_order_messages pom
     JOIN users u ON pom.user_id = u.id
     WHERE pom.po_id = $1
     ORDER BY pom.created_at ASC`,
    [req.params.id]
  );
  res.json(messages);
});

router.post('/:id/messages', authenticate, async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message cannot be empty' });
  await getDB().run(
    'INSERT INTO purchase_order_messages (po_id, user_id, message) VALUES ($1,$2,$3)',
    [req.params.id, req.user.id, message.trim()]
  );
  res.status(201).json({ message: 'Sent' });
});

module.exports = router;
