const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadItemDrawing, deleteFromStorage } = require('../middleware/upload');
const { consumeFIFO, createFIFOLot } = require('../lib/fifo');

router.get('/', authenticate, async (req, res) => {
  res.json(await getDB().all('SELECT * FROM inventory_items ORDER BY category, item_code'));
});

router.get('/low-stock', authenticate, async (req, res) => {
  res.json(await getDB().all(
    'SELECT * FROM inventory_items WHERE current_stock <= reorder_level ORDER BY category, item_code'
  ));
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
  res.json(item);
});

router.post('/', authenticate, authorize('accounts', 'owner'), ...uploadItemDrawing, async (req, res) => {
  const { item_code, name, category, unit, current_stock, reorder_level, unit_cost, notes } = req.body;
  if (!item_code || !name || !unit) return res.status(400).json({ error: 'Code, name and unit required' });

  const db = getDB();
  const drawingFile = req.file?.storagePath || null;
  const drawingOriginalName = req.file?.originalname || null;

  try {
    const r = await db.insert(
      `INSERT INTO inventory_items
         (item_code, name, category, unit, current_stock, reorder_level, unit_cost, notes, drawing_file, drawing_original_name, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        item_code.toUpperCase(), name, category||null, unit,
        Number(current_stock)||0, Number(reorder_level)||0, Number(unit_cost)||0, notes||null,
        drawingFile, drawingOriginalName, req.user.id
      ]
    );

    if (Number(current_stock) > 0) {
      await db.run(
        `INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by)
         VALUES ($1,'opening_stock',$2,$3,'Opening stock',$4)`,
        [r.lastInsertRowid, Number(current_stock), Number(current_stock), req.user.id]
      );
    }

    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('unique') || e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Item code already exists' });
    throw e;
  }
});

router.put('/:id', authenticate, authorize('accounts', 'owner'), ...uploadItemDrawing, async (req, res) => {
  const { item_code, name, category, unit, reorder_level, unit_cost, notes } = req.body;
  const db = getDB();

  if (req.file) {
    await db.run(
      `UPDATE inventory_items
       SET item_code=$1, name=$2, category=$3, unit=$4, reorder_level=$5, unit_cost=$6, notes=$7,
           drawing_file=$8, drawing_original_name=$9
       WHERE id=$10`,
      [item_code?.toUpperCase(), name, category||null, unit, reorder_level, Number(unit_cost)||0, notes||null,
       req.file.storagePath, req.file.originalname, req.params.id]
    );
  } else {
    await db.run(
      `UPDATE inventory_items SET item_code=$1, name=$2, category=$3, unit=$4, reorder_level=$5, unit_cost=$6, notes=$7 WHERE id=$8`,
      [item_code?.toUpperCase(), name, category||null, unit, reorder_level, Number(unit_cost)||0, notes||null, req.params.id]
    );
  }
  res.json({ message: 'Updated' });
});

router.post('/:id/transactions', authenticate, authorize('accounts', 'owner'), async (req, res) => {
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
    newStock = item.current_stock - parseFloat(quantity);
    if (newStock < 0) return res.status(400).json({ error: 'Insufficient stock' });
  }

  // FIFO: consume lots on outbound; create lot on inbound (purchase_in, opening_stock)
  let unitCostFifo = 0, totalCost = 0;
  if (!isInbound) {
    ({ unitCostFifo, totalCost } = await consumeFIFO(db, req.params.id, quantity));
  } else if (['purchase_in', 'opening_stock'].includes(transaction_type)) {
    const unitCostVal = parseFloat(req.body.unit_cost) || item.unit_cost || 0;
    await createFIFOLot(db, req.params.id, quantity, unitCostVal);
    unitCostFifo = unitCostVal;
    totalCost = parseFloat(quantity) * unitCostVal;
  }

  const r = await db.insert(
    `INSERT INTO inventory_transactions
       (item_id, transaction_type, quantity, balance_after, unit_cost_fifo, total_cost, job_card_id, supplier_name, po_number, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [req.params.id, transaction_type, quantity, newStock, unitCostFifo, totalCost,
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
