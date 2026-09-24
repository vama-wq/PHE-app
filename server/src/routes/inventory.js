const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadItemDrawing, deleteFromStorage } = require('../middleware/upload');
const { createNotification } = require('./notifications');
const { gujaratiName } = require('../lib/gujarati');

// QC (design) can manage stock but must not see unit cost — strip it for them.
const stripCost = (req, data) => {
  if (req.user.role !== 'design' || !data) return data;
  const omit = (o) => { const { unit_cost, ...rest } = o; return rest; };
  return Array.isArray(data) ? data.map(omit) : omit(data);
};

// Items added by accounts stay 'pending_approval' until the owner approves.
// Default listing (used by all BOM/purchase/production pickers) hides them;
// the Inventory page passes ?include_pending=1 to show them with a badge.
router.get('/', authenticate, async (req, res) => {
  const where = req.query.include_pending === '1' ? '' : "WHERE COALESCE(approval_status,'approved')='approved'";
  res.json(stripCost(req, await getDB().all(`SELECT * FROM inventory_items ${where} ORDER BY category, item_code`)));
});

router.get('/low-stock', authenticate, async (req, res) => {
  res.json(stripCost(req, await getDB().all(
    `SELECT * FROM inventory_items
      WHERE reorder_level > 0 AND current_stock <= reorder_level
        AND COALESCE(approval_status,'approved')='approved'
      ORDER BY category, item_code`
  )));
});

// Existing category labels for the add/edit item dropdown
router.get('/categories', authenticate, async (req, res) => {
  const rows = await getDB().all(
    `SELECT DISTINCT TRIM(category) AS category FROM inventory_items
     WHERE category IS NOT NULL AND TRIM(category) <> '' ORDER BY 1`
  );
  res.json(rows.map(r => r.category));
});

// ── Drawing versions ────────────────────────────────────────────────────────
// A new drawing never overwrites: it becomes the next version, the previous
// current one is marked superseded (file kept), and the item's drawing_file
// is repointed so job cards, POs and slips pick up the new one automatically.
async function addDrawingVersion(db, itemId, { file_path, original_name, notes, userId, restoredFrom = null }) {
  const last = await db.get('SELECT COALESCE(MAX(version),0)::int AS v FROM inventory_item_drawings WHERE item_id=$1', [itemId]);
  const version = (last?.v || 0) + 1;
  await db.run('UPDATE inventory_item_drawings SET superseded_at=NOW() WHERE item_id=$1 AND superseded_at IS NULL', [itemId]);
  const r = await db.insert(
    `INSERT INTO inventory_item_drawings (item_id, version, file_path, original_name, notes, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [itemId, version, file_path, original_name || null,
     restoredFrom ? `Restored from version ${restoredFrom}${notes ? ` — ${notes}` : ''}` : (notes || null), userId]);
  await db.run('UPDATE inventory_items SET drawing_file=$1, drawing_original_name=$2 WHERE id=$3',
    [file_path, original_name || null, itemId]);
  return { id: r.lastInsertRowid, version };
}

async function drawingTimeline(db, itemId) {
  return db.all(
    `SELECT d.*, u.name AS uploaded_by_name
       FROM inventory_item_drawings d LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.item_id=$1 ORDER BY d.version DESC`, [itemId]);
}

// Owner + design see the full history (admin too — they can also upload).
router.get('/:id/drawings', authenticate, authorize('owner', 'design', 'admin'), async (req, res) => {
  const db = getDB();
  res.json(await drawingTimeline(db, req.params.id));
});

// Design attaches a newly approved drawing: it replaces the one in use and the
// old one drops out of sight but stays in the timeline.
router.post('/:id/drawings', authenticate, authorize('owner', 'admin', 'design'), ...uploadItemDrawing, async (req, res) => {
  const db = getDB();
  const item = await db.get('SELECT id, item_code FROM inventory_items WHERE id=$1', [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (!req.file) return res.status(400).json({ error: 'Attach the drawing file' });
  const { version } = await addDrawingVersion(db, item.id, {
    file_path: req.file.storagePath, original_name: req.file.originalname,
    notes: (req.body.notes || '').trim() || null, userId: req.user.id,
  });
  await logActivity(null, null, 'inventory_drawing',
    `${item.item_code}: drawing version ${version} attached${req.body.notes ? ` — ${String(req.body.notes).trim()}` : ''}`, req.user.id);
  res.status(201).json({ message: `Drawing version ${version} is now in use`, version, drawings: await drawingTimeline(db, item.id) });
});

// Owner can bring an older version back into use. It is recorded as a new
// version (pointing at the old file) so the timeline stays a straight line.
router.put('/:id/drawings/:did/restore', authenticate, authorize('owner'), async (req, res) => {
  const db = getDB();
  const d = await db.get('SELECT * FROM inventory_item_drawings WHERE id=$1 AND item_id=$2', [req.params.did, req.params.id]);
  if (!d) return res.status(404).json({ error: 'Drawing version not found' });
  if (!d.superseded_at) return res.status(400).json({ error: 'That version is already the one in use' });
  const item = await db.get('SELECT item_code FROM inventory_items WHERE id=$1', [req.params.id]);
  const { version } = await addDrawingVersion(db, req.params.id, {
    file_path: d.file_path, original_name: d.original_name, userId: req.user.id, restoredFrom: d.version,
  });
  await logActivity(null, null, 'inventory_drawing',
    `${item?.item_code || 'Item'}: drawing version ${d.version} restored as version ${version}`, req.user.id);
  res.json({ message: `Version ${d.version} restored as version ${version}`, drawings: await drawingTimeline(db, req.params.id) });
});

router.get('/:id', authenticate, async (req, res) => {
  const db = getDB();
  const item = await db.get('SELECT * FROM inventory_items WHERE id=$1', [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Not found' });

  item.transactions = await db.all(
    `SELECT t.*, u.name as created_by_name, jc.job_card_no
     FROM inventory_transactions t
     LEFT JOIN users u ON t.created_by = u.id
     LEFT JOIN job_cards jc ON t.job_card_id = jc.id
     WHERE t.item_id = $1
     ORDER BY t.created_at DESC LIMIT 100`,
    [req.params.id]
  );
  // QC/design must never see supplier names
  if (req.user.role === 'design') {
    item.transactions = item.transactions.map(({ supplier_name, ...rest }) => rest);
  }

  // Open FIFO lots show the landed cost (rate + transport/other) of stock still
  // on hand. Cost-bearing, so never expose to design (QC).
  if (req.user.role !== 'design') {
    item.fifo_lots = await db.all(
      `SELECT l.id, l.qty_original, l.qty_remaining, l.unit_cost, l.received_at, po.po_number
       FROM inventory_fifo_lots l
       LEFT JOIN purchase_orders po ON l.po_id = po.id
       WHERE l.item_id = $1 AND l.qty_remaining > 0
       ORDER BY l.received_at`,
      [req.params.id]
    );
  }
  res.json(stripCost(req, item));
});

// accounts included for the PO-page inline flow — their items still land as
// pending_approval and they have no Inventory section access
router.post('/', authenticate, authorize('owner', 'admin', 'accounts'), ...uploadItemDrawing, async (req, res) => {
  const { item_code, name, name_gu, category, unit, current_stock, reorder_level, unit_cost, min_order_qty, notes } = req.body;
  if (!item_code || !name || !unit) return res.status(400).json({ error: 'Code, name and unit required' });
  // Owner's rule (Sep 2026): an inventory item may not exist without its
  // drawing — no item can be bought, QC'd or built against a blank spec. This
  // covers every UI path, since they all post here.
  if (!req.file) {
    return res.status(400).json({
      error: 'A drawing is required — attach the drawing PDF or a photo of it before adding this item.',
      code: 'DRAWING_REQUIRED',
    });
  }

  const db = getDB();
  const drawingFile = req.file?.storagePath || null;
  const drawingOriginalName = req.file?.originalname || null;
  // Non-owner additions need the owner's sign-off before the item becomes
  // usable — EXCEPT an item being created from a sample the owner has already
  // approved, which would otherwise ask the owner to approve the same thing
  // twice. The sample must genuinely be sitting in 'awaiting_inventory', so
  // this cannot be used to slip an unapproved item through.
  let approvalStatus = req.user.role === 'owner' ? 'approved' : 'pending_approval';
  const fromSampleId = parseInt(req.body.from_sample_id, 10);
  if (approvalStatus === 'pending_approval' && Number.isInteger(fromSampleId)) {
    const sample = await db.get(
      "SELECT id FROM petty_cash_samples WHERE id=$1 AND status='awaiting_inventory'", [fromSampleId]);
    if (sample) approvalStatus = 'approved';
  }
  // Gujarati name auto-generates from the English name when left blank
  const guName = (name_gu || '').trim() || gujaratiName(name);
  // Trim the category: "Pocket " and "Pocket" are the same category to a human
  // but two separate entries in every filter and grouping.
  const cat = (category || '').trim() || null;

  try {
    const r = await db.insert(
      `INSERT INTO inventory_items
         (item_code, name, name_gu, category, unit, current_stock, reorder_level, unit_cost, min_order_qty, notes, drawing_file, drawing_original_name, created_by, approval_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        item_code.toUpperCase(), name, guName||null, cat, unit,
        Number(current_stock)||0, Number(reorder_level)||0, Number(unit_cost)||0, Number(min_order_qty)||0, notes||null,
        drawingFile, drawingOriginalName, req.user.id, approvalStatus
      ]
    );
    // Record the attached drawing as version 1 so the timeline starts here.
    if (drawingFile) {
      await db.run(
        `INSERT INTO inventory_item_drawings (item_id, version, file_path, original_name, notes, uploaded_by)
         VALUES ($1, 1, $2, $3, 'Original drawing', $4)`,
        [r.lastInsertRowid, drawingFile, drawingOriginalName || null, req.user.id]);
    }

    if (Number(current_stock) > 0) {
      await db.run(
        `INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by)
         VALUES ($1,'opening_stock',$2,$3,'Opening stock',$4)`,
        [r.lastInsertRowid, Number(current_stock), Number(current_stock), req.user.id]
      );
    }

    if (approvalStatus === 'pending_approval') {
      try {
        const owners = await db.all("SELECT id FROM users WHERE role='owner'");
        for (const o of owners) {
          await createNotification(db, {
            userId: o.id, type: 'inventory_approval', title: 'New inventory item awaits approval',
            body: `${req.user.name || 'Accounts'} added "${name}" (${item_code.toUpperCase()}) — approve it on the Inventory page.`,
            link: '/inventory', sourceUserId: req.user.id,
          });
        }
      } catch (_) { /* notifications are best-effort */ }
    }

    res.status(201).json({ id: r.lastInsertRowid, approval_status: approvalStatus, item_code: item_code.toUpperCase(), name, unit });
  } catch (e) {
    if (e.message.includes('unique') || e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Item code already exists' });
    throw e;
  }
});

// Owner approves an accounts-added item — it becomes visible to all pickers
router.put('/:id/approve', authenticate, authorize('owner'), async (req, res) => {
  const db = getDB();
  const item = await db.get('SELECT * FROM inventory_items WHERE id=$1', [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (item.approval_status !== 'pending_approval') return res.status(400).json({ error: 'Item is not pending approval' });
  await db.run("UPDATE inventory_items SET approval_status='approved' WHERE id=$1", [req.params.id]);
  if (item.created_by) {
    try {
      await createNotification(db, {
        userId: item.created_by, type: 'inventory_approved', title: 'Inventory item approved',
        body: `"${item.name}" (${item.item_code}) was approved and is now live.`,
        link: `/inventory/${item.id}`, sourceUserId: req.user.id,
      });
    } catch (_) {}
  }
  res.json({ message: 'Item approved' });
});

// Owner rejects an accounts-added item — the pending entry is removed
router.put('/:id/reject', authenticate, authorize('owner'), async (req, res) => {
  const db = getDB();
  const item = await db.get('SELECT * FROM inventory_items WHERE id=$1', [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (item.approval_status !== 'pending_approval') return res.status(400).json({ error: 'Item is not pending approval' });
  const reason = (req.body?.reason || '').trim();
  await db.run('DELETE FROM inventory_fifo_lots WHERE item_id=$1', [req.params.id]).catch(() => {});
  await db.run('DELETE FROM inventory_transactions WHERE item_id=$1', [req.params.id]);
  await db.run('DELETE FROM inventory_items WHERE id=$1', [req.params.id]);
  await deleteFromStorage(item.drawing_file).catch(() => {});
  if (item.created_by) {
    try {
      await createNotification(db, {
        userId: item.created_by, type: 'inventory_rejected', title: 'Inventory item rejected',
        body: `"${item.name}" (${item.item_code}) was rejected by the owner${reason ? `: ${reason}` : ''}. It has been removed.`,
        link: '/inventory', sourceUserId: req.user.id,
      });
    } catch (_) {}
  }
  res.json({ message: 'Item rejected and removed' });
});

router.put('/:id', authenticate, authorize('owner', 'admin'), ...uploadItemDrawing, async (req, res) => {
  const { item_code, name, name_gu, category, unit, reorder_level, unit_cost, min_order_qty, notes } = req.body;
  const db = getDB();

  // Check if code is being changed to one that already exists (different item)
  const existing = await db.get('SELECT id FROM inventory_items WHERE item_code=$1 AND id!=$2', [item_code?.toUpperCase(), req.params.id]);
  if (existing) return res.status(409).json({ error: 'Item code already exists' });

  // Gujarati name auto-generates from the English name when left blank
  const guName = (name_gu || '').trim() || gujaratiName(name);
  // Same trim as on create — a stray space would split the category in two.
  const cat = (category || '').trim() || null;

  try {
    await db.run(
      `UPDATE inventory_items SET item_code=$1, name=$2, name_gu=$3, category=$4, unit=$5, reorder_level=$6, unit_cost=$7, min_order_qty=$8, notes=$9 WHERE id=$10`,
      [item_code?.toUpperCase(), name, guName||null, cat, unit, reorder_level, Number(unit_cost)||0, Number(min_order_qty)||0, notes||null, req.params.id]
    );
    // A drawing on the edit form is a new version, not an overwrite — the
    // previous one stays in the timeline.
    if (req.file) {
      await addDrawingVersion(db, req.params.id, {
        file_path: req.file.storagePath, original_name: req.file.originalname,
        notes: 'Replaced from the item edit form', userId: req.user.id,
      });
    }
    res.json({ message: 'Updated' });
  } catch (e) {
    if (e.message.includes('unique') || e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Item code already exists' });
    throw e;
  }
});

router.post('/:id/transactions', authenticate, authorize('owner', 'design', 'admin'), async (req, res) => {
  const { transaction_type, quantity, job_card_id, supplier_name, po_number, notes } = req.body;
  if (!transaction_type || !quantity) return res.status(400).json({ error: 'Type and quantity required' });

  const db = getDB();
  const item = await db.get('SELECT * FROM inventory_items WHERE id=$1', [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const isInbound = ['opening_stock', 'purchase_in', 'return_from_production'].includes(transaction_type);
  let newStock;
  if (isInbound) {
    newStock = item.current_stock + parseFloat(quantity);
  } else {
    newStock = item.current_stock - parseFloat(quantity); // allow negative so shortages are visible
  }

  const r = await db.insert(
    `INSERT INTO inventory_transactions
       (item_id, transaction_type, quantity, balance_after, job_card_id, supplier_name, po_number, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [req.params.id, transaction_type, quantity, newStock,
     job_card_id||null, supplier_name||null, po_number||null, notes||null, req.user.id]
  );

  await db.run('UPDATE inventory_items SET current_stock=$1 WHERE id=$2', [newStock, req.params.id]);

  if (job_card_id && transaction_type === 'dispatch_to_production') {
    const jc = await db.get('SELECT order_id FROM job_cards WHERE id=$1', [job_card_id]);
    if (jc) await logActivity(jc.order_id, job_card_id, 'inventory_dispatched',
      `${quantity} ${item.unit} of ${item.name} dispatched to production`, req.user.id);
  }

  res.status(201).json({ id: r.lastInsertRowid, new_stock: newStock });
});

// Owner-only: delete a single MANUAL stock transaction, reversing its effect on
// current stock. Auto-posted rows are protected — PO receives carry a FIFO lot,
// and production/QC deductions ('Order: …' notes) track BOM consumption; both
// must be adjusted through their own flows, not deleted here.
router.delete('/:id/transactions/:txId', authenticate, authorize('owner'), async (req, res) => {
  const db = getDB();
  const tx = await db.get('SELECT * FROM inventory_transactions WHERE id=$1 AND item_id=$2',
    [req.params.txId, req.params.id]);
  if (!tx) return res.status(404).json({ error: 'Transaction not found' });
  const notes = tx.notes || '';
  if (/PO received/i.test(notes)) {
    return res.status(400).json({ error: 'This entry came from a purchase receive (it has a FIFO stock lot) — adjust it through the PO, not here' });
  }
  if (/^Order:\s/i.test(notes)) {
    return res.status(400).json({ error: 'This entry was posted automatically by production/QC — record a manual adjustment instead of deleting it' });
  }
  if (/^FIFO lot removed/i.test(notes)) {
    return res.status(400).json({ error: 'This is the audit record of a deleted FIFO lot — it can\'t be removed' });
  }
  const isInbound = ['opening_stock', 'purchase_in', 'return_from_production'].includes(tx.transaction_type);
  const delta = isInbound ? -parseFloat(tx.quantity) : parseFloat(tx.quantity);
  await db.withTransaction(async (client) => {
    await client.query('DELETE FROM inventory_transactions WHERE id=$1', [tx.id]);
    await client.query('UPDATE inventory_items SET current_stock = current_stock + $1 WHERE id=$2',
      [delta, req.params.id]);
  });
  await logActivity(null, null, 'inventory_tx_deleted',
    `Stock transaction removed: ${tx.transaction_type} ${tx.quantity} (item #${req.params.id}) — stock ${delta > 0 ? '+' : ''}${delta}`, req.user.id);
  res.json({ message: 'Transaction removed and stock reversed' });
});

// Owner-only: delete a FIFO cost lot. Its remaining quantity leaves stock (it
// was counted in current stock), the moving-average cost recomputes from the
// lots that are left, and an audit adjustment row records the removal.
router.delete('/:id/fifo-lots/:lotId', authenticate, authorize('owner'), async (req, res) => {
  const db = getDB();
  const lot = await db.get('SELECT * FROM inventory_fifo_lots WHERE id=$1 AND item_id=$2',
    [req.params.lotId, req.params.id]);
  if (!lot) return res.status(404).json({ error: 'Lot not found' });
  const item = await db.get('SELECT * FROM inventory_items WHERE id=$1', [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const qtyOut = Number(lot.qty_remaining) || 0;
  await db.withTransaction(async (client) => {
    await client.query('DELETE FROM inventory_fifo_lots WHERE id=$1', [lot.id]);
    const newStock = (Number(item.current_stock) || 0) - qtyOut;
    const { rows: lots } = await client.query(
      'SELECT qty_remaining, unit_cost FROM inventory_fifo_lots WHERE item_id=$1 AND qty_remaining > 0', [req.params.id]);
    const totQ = lots.reduce((s, l) => s + Number(l.qty_remaining), 0);
    const totC = lots.reduce((s, l) => s + Number(l.qty_remaining) * Number(l.unit_cost), 0);
    const avg = totQ > 0 ? Math.round(totC / totQ * 100) / 100 : item.unit_cost;
    await client.query('UPDATE inventory_items SET current_stock=$1, unit_cost=$2 WHERE id=$3',
      [newStock, avg, req.params.id]);
    if (qtyOut > 0) {
      await client.query(
        `INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by)
         VALUES ($1,'adjustment',$2,$3,$4,$5)`,
        [req.params.id, qtyOut, newStock,
         `FIFO lot removed${lot.po_id ? ` (PO #${lot.po_id})` : ''}: ${qtyOut} remaining @ ₹${lot.unit_cost}`, req.user.id]);
    }
  });
  await logActivity(null, null, 'inventory_lot_deleted',
    `FIFO lot removed on item #${req.params.id}: ${qtyOut} @ ₹${lot.unit_cost}`, req.user.id);
  res.json({ message: 'Lot removed — stock and average cost updated' });
});

router.delete('/:id', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const db = getDB();
  const item = await db.get('SELECT id, item_code, name, current_stock, drawing_file FROM inventory_items WHERE id=$1', [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  // Say what is holding it BEFORE trying. The FK would refuse anyway, but
  // "still referenced by an order" sends the owner hunting through 36 orders;
  // naming them is the difference between a dead end and a to-do list.
  const holders = await db.all(
    `SELECT DISTINCT o.order_code FROM order_item_inventory oii
       JOIN order_items oi ON oi.id = oii.order_item_id JOIN orders o ON o.id = oi.order_id
      WHERE oii.inventory_item_id=$1 ORDER BY o.order_code`, [req.params.id]);
  if (holders.length) {
    const codes = holders.map(h => h.order_code);
    const shown = codes.slice(0, 6).join(', ') + (codes.length > 6 ? ` and ${codes.length - 6} more` : '');
    return res.status(400).json({
      error: `Cannot delete: ${item.item_code} is still on the bill of materials of ${codes.length} order(s) — ${shown}. Swap it for the right item on each (Edit inventory) and try again.`,
      code: 'ITEM_IN_USE', orders: codes,
    });
  }

  const poRow = await db.get('SELECT COUNT(*) AS n FROM purchase_order_items WHERE inventory_item_id=$1', [req.params.id]);
  const poCount = parseInt(poRow.n, 10);
  // Items tied to real purchase orders keep their procurement history — block.
  if (poCount > 0) {
    return res.status(400).json({
      error: `Cannot delete: this item is linked to ${poCount} purchase order line(s). Remove those first or archive the item instead.`,
    });
  }
  // Don't delete an item that still has stock on hand — zero it out first so a
  // live material can't vanish by accident. (Manual stock history like opening
  // stock / adjustments is cascaded below; this is how test or retired items go.)
  if (Number(item.current_stock) > 0) {
    return res.status(400).json({
      error: `Cannot delete: this item still has ${item.current_stock} in stock. Adjust the stock to 0 first, then delete.`,
    });
  }

  let removed = { lots: 0, transactions: 0 };
  try {
    await db.withTransaction(async (client) => {
      const l = await client.query('DELETE FROM inventory_fifo_lots WHERE item_id=$1', [req.params.id]);
      const t = await client.query('DELETE FROM inventory_transactions WHERE item_id=$1', [req.params.id]);
      await client.query('DELETE FROM inventory_items WHERE id=$1', [req.params.id]);
      removed = { lots: l.rowCount, transactions: t.rowCount };
    });
  } catch (e) {
    // Referenced somewhere the pre-check does not cover — FK stops the delete.
    if (e.code === '23503') {
      return res.status(400).json({ error: `Cannot delete: ${item.item_code} is still referenced by another record (${e.constraint || 'foreign key'}). Remove that reference first.` });
    }
    throw e;
  }
  // The drawing row cascades with the item; its file in storage does not, so
  // it would sit orphaned forever. Best effort — a missing file is not an error.
  if (item.drawing_file) await deleteFromStorage(item.drawing_file).catch(() => {});
  // This was the one destructive route that left no trace. The ledger it
  // removes is gone, so the log line is the only record of what went with it.
  await logActivity(null, null, 'inventory_item_deleted',
    `Inventory item ${item.item_code} — ${item.name || ''} deleted (stock was ${item.current_stock}; ${removed.transactions} ledger entries and ${removed.lots} FIFO lots removed with it)`,
    req.user.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
