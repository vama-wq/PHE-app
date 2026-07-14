const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadItemDrawing, deleteFromStorage } = require('../middleware/upload');
const { createNotification } = require('./notifications');

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
    `SELECT * FROM inventory_items WHERE current_stock <= reorder_level AND COALESCE(approval_status,'approved')='approved' ORDER BY category, item_code`
  )));
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

router.post('/', authenticate, authorize('accounts', 'owner', 'admin'), ...uploadItemDrawing, async (req, res) => {
  const { item_code, name, name_gu, category, unit, current_stock, reorder_level, unit_cost, min_order_qty, notes } = req.body;
  if (!item_code || !name || !unit) return res.status(400).json({ error: 'Code, name and unit required' });

  const db = getDB();
  const drawingFile = req.file?.storagePath || null;
  const drawingOriginalName = req.file?.originalname || null;
  // Accounts' additions need the owner's sign-off before the item becomes usable
  const approvalStatus = req.user.role === 'owner' ? 'approved' : 'pending_approval';

  try {
    const r = await db.insert(
      `INSERT INTO inventory_items
         (item_code, name, name_gu, category, unit, current_stock, reorder_level, unit_cost, min_order_qty, notes, drawing_file, drawing_original_name, created_by, approval_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        item_code.toUpperCase(), name, name_gu||null, category||null, unit,
        Number(current_stock)||0, Number(reorder_level)||0, Number(unit_cost)||0, Number(min_order_qty)||0, notes||null,
        drawingFile, drawingOriginalName, req.user.id, approvalStatus
      ]
    );

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

    res.status(201).json({ id: r.lastInsertRowid, approval_status: approvalStatus });
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

router.put('/:id', authenticate, authorize('accounts', 'owner', 'admin'), ...uploadItemDrawing, async (req, res) => {
  const { item_code, name, name_gu, category, unit, reorder_level, unit_cost, min_order_qty, notes } = req.body;
  const db = getDB();

  // Check if code is being changed to one that already exists (different item)
  const existing = await db.get('SELECT id FROM inventory_items WHERE item_code=$1 AND id!=$2', [item_code?.toUpperCase(), req.params.id]);
  if (existing) return res.status(409).json({ error: 'Item code already exists' });

  try {
    if (req.file) {
      await db.run(
        `UPDATE inventory_items
         SET item_code=$1, name=$2, name_gu=$3, category=$4, unit=$5, reorder_level=$6, unit_cost=$7, min_order_qty=$8, notes=$9,
             drawing_file=$10, drawing_original_name=$11
         WHERE id=$12`,
        [item_code?.toUpperCase(), name, name_gu||null, category||null, unit, reorder_level, Number(unit_cost)||0, Number(min_order_qty)||0, notes||null,
         req.file.storagePath, req.file.originalname, req.params.id]
      );
    } else {
      await db.run(
        `UPDATE inventory_items SET item_code=$1, name=$2, name_gu=$3, category=$4, unit=$5, reorder_level=$6, unit_cost=$7, min_order_qty=$8, notes=$9 WHERE id=$10`,
        [item_code?.toUpperCase(), name, name_gu||null, category||null, unit, reorder_level, Number(unit_cost)||0, Number(min_order_qty)||0, notes||null, req.params.id]
      );
    }
    res.json({ message: 'Updated' });
  } catch (e) {
    if (e.message.includes('unique') || e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Item code already exists' });
    throw e;
  }
});

router.post('/:id/transactions', authenticate, authorize('accounts', 'owner', 'design'), async (req, res) => {
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

router.delete('/:id', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const db = getDB();
  const item = await db.get('SELECT id FROM inventory_items WHERE id=$1', [req.params.id]);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const [txRow, poRow, fifoRow] = await Promise.all([
    db.get('SELECT COUNT(*) AS n FROM inventory_transactions WHERE item_id=$1', [req.params.id]),
    db.get('SELECT COUNT(*) AS n FROM purchase_order_items WHERE inventory_item_id=$1', [req.params.id]),
    db.get('SELECT COUNT(*) AS n FROM inventory_fifo_lots WHERE item_id=$1', [req.params.id]),
  ]);
  const txCount = parseInt(txRow.n, 10), poCount = parseInt(poRow.n, 10), fifoCnt = parseInt(fifoRow.n, 10);
  if (txCount + poCount + fifoCnt > 0) {
    return res.status(400).json({
      error: `Cannot delete: this item has ${txCount} transaction(s) and ${poCount} purchase order line(s). Remove those first or archive the item instead.`,
    });
  }

  await db.run('DELETE FROM inventory_items WHERE id=$1', [req.params.id]);
  res.json({ message: 'Deleted' });
});

module.exports = router;
