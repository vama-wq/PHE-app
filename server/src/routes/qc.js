const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize, withCustomerVisibility } = require('../middleware/auth');
const { uploadQC, uploadChecklistPhoto } = require('../middleware/upload');
const { settleItemInventory, resolveJobCardItemId } = require('../lib/inventoryDeduction');

// Deduct the job card's order item from stock once it qualifies (split-aware).
// Wrapped so a failure here can never block QC approval. No-op when the item is
// not yet fully settled or already deducted.
async function settleAfterQC(db, jc, userId) {
  try {
    const itemId = await resolveJobCardItemId(db, jc);
    if (!itemId) return;
    let orderCode = jc.order_code;
    if (!orderCode) {
      const o = await db.get('SELECT order_code FROM orders WHERE id=$1', [jc.order_id]);
      orderCode = o?.order_code;
    }
    await settleItemInventory(db, itemId, userId, orderCode || `Order #${jc.order_id}`);
  } catch (e) { console.error('[qc] settle inventory failed:', e.message); }
}

// Recompute order status from all its job cards
async function syncOrderStatus(db, orderId, userId) {
  const cards = await db.all('SELECT status FROM job_cards WHERE order_id=$1', [orderId]);
  if (!cards.length) return;
  const statuses = cards.map(c => c.status);
  let newOrderStatus;
  if (statuses.every(s => s === 'dispatched'))                          newOrderStatus = 'dispatched';
  else if (statuses.some(s => s === 'qc_approved'))                     newOrderStatus = 'qc_approved';
  else if (statuses.some(s => s === 'qc_pending'))                      newOrderStatus = 'qc_pending';
  else if (statuses.some(s => s === 'in_progress' || s === 'on_hold'))  newOrderStatus = 'in_progress';
  else                                                                   newOrderStatus = 'job_card_created';
  const order = await db.get('SELECT status FROM orders WHERE id=$1', [orderId]);
  if (!order || order.status === newOrderStatus) return;
  const locked = ['pending_approval', 'approved', 'rejected', 'customer_query', 'product_return', 'resolved_dispatched'];
  if (locked.includes(order.status)) return;
  await db.run('UPDATE orders SET status=$1 WHERE id=$2', [newOrderStatus, orderId]);
  await logActivity(orderId, null, 'status_changed',
    `Order status updated to ${newOrderStatus.replace(/_/g, ' ')}`, userId);
}

router.get('/', authenticate, authorize('design', 'owner', 'admin'), async (req, res) => {
  const canSeeNames = withCustomerVisibility(req);
  const cards = await getDB().all(
    `SELECT jc.*, o.order_code, o.order_type, c.customer_code, ${canSeeNames ? "c.name as customer_name," : ''}
       u.name as uploaded_by_name,
       (SELECT COUNT(*) FROM qc_reports WHERE job_card_id = jc.id) as report_count,
       (jc.dispatch_date::date - CURRENT_DATE) as days_until_dispatch,
       GREATEST(
         jc.qty
           - COALESCE((SELECT SUM(rejection_qty) FROM production_checklist WHERE job_card_id = jc.id), 0)
           + COALESCE((SELECT SUM(remade_qty)    FROM production_checklist WHERE job_card_id = jc.id), 0),
         0
       ) as net_qty,
       COALESCE((SELECT SUM(rejection_qty) FROM production_checklist WHERE job_card_id = jc.id), 0) as total_rejected,
       COALESCE((SELECT SUM(remade_qty)    FROM production_checklist WHERE job_card_id = jc.id), 0) as total_remade,
       cq_return.query_no as return_query_no,
       cq_return.id as return_query_id,
       cq_return.subject as return_query_subject,
       cq_return.description as return_query_description,
       cq_return.category as return_query_category,
       cq_return.priority as return_query_priority,
       cq_return.return_type as return_query_type,
       cq_return.return_status as return_query_return_status,
       cq_return.return_coupon_no as return_coupon_no,
       cq_return.debit_note_no as return_debit_note_no,
       cq_return.created_at as return_query_created_at
     FROM job_cards jc
     JOIN orders o ON jc.order_id = o.id
     JOIN customers c ON o.customer_id = c.id
     LEFT JOIN users u ON jc.uploaded_by = u.id
     LEFT JOIN customer_queries cq_return
       ON cq_return.job_card_id = jc.id
       AND cq_return.status = 'product_return'
       AND cq_return.return_status IN ('qc_check', 'in_repair')
     WHERE (
       jc.status = 'qc_pending'
       OR (
         -- Catch stuck cards: stage 29 done but status didn't update correctly
         jc.status = 'in_progress'
         AND EXISTS (
           SELECT 1 FROM production_checklist
           WHERE job_card_id = jc.id AND stage_no = 29 AND done = 1
         )
       )
     )
     ORDER BY jc.dispatch_date ASC`
  );
  res.json(cards);
});

router.get('/:id/reports', authenticate, authorize('design', 'owner', 'admin', 'production'), async (req, res) => {
  const reports = await getDB().all(
    `SELECT qr.*, u.name as created_by_name
     FROM qc_reports qr
     LEFT JOIN users u ON qr.created_by = u.id
     WHERE qr.job_card_id = $1
     ORDER BY qr.created_at DESC`,
    [req.params.id]
  );
  res.json(reports);
});

router.post('/:id/report', authenticate, authorize('design', 'owner', 'admin'),
  ...uploadQC, async (req, res) => {
    const { observations, corrective_action, product_weight } = req.body;
    const db = getDB();
    const jc = await db.get('SELECT * FROM job_cards WHERE id=$1', [req.params.id]);
    if (!jc) return res.status(404).json({ error: 'Not found' });
    if (jc.status !== 'qc_pending') return res.status(400).json({ error: 'Job card is not in QC Pending state' });

    if (!product_weight || isNaN(parseFloat(product_weight))) {
      return res.status(400).json({ error: 'Weight of 1 product is required' });
    }

    const r = await db.insert(
      `INSERT INTO qc_reports (job_card_id, result, observations, corrective_action, product_weight, file_path, file_name, created_by)
       VALUES ($1,'approved',$2,$3,$4,$5,$6,$7)`,
      [req.params.id, observations||null, corrective_action||null,
       parseFloat(product_weight),
       req.file?.storagePath||null, req.file?.filename||null, req.user.id]
    );

    await logActivity(jc.order_id, jc.id, 'qc_report', `QC report uploaded for ${jc.job_card_no}`, req.user.id);
    res.status(201).json({ id: r.lastInsertRowid, file_name: req.file?.filename });
  }
);

// ── Approve ───────────────────────────────────────────────────────────────────
// Body for Local HE / Export HE:    {}
// Body for IO:                       { io_qty: N }
// Body for IO+Export/IO+Local:       { io_qty: N, dispatch_qty: N } + required qc_photo (field: file)
router.put('/:id/approve', authenticate, authorize('design', 'owner', 'admin'), ...uploadChecklistPhoto, async (req, res) => {
  const db = getDB();

  // Fetch job card with order + customer info
  const jc = await db.get(`
    SELECT jc.*, o.order_code, o.order_type, c.customer_code, c.name as customer_name
    FROM job_cards jc
    JOIN orders o ON jc.order_id = o.id
    JOIN customers c ON o.customer_id = c.id
    WHERE jc.id = $1
  `, [req.params.id]);

  if (!jc) return res.status(404).json({ error: 'Not found' });
  if (!req.file) return res.status(400).json({ error: 'A photo of the approved material is required' });
  // Accept both qc_pending and in_progress+stage29done (stuck cards)
  const stage29Done = await db.get(
    'SELECT 1 FROM production_checklist WHERE job_card_id=$1 AND stage_no=29 AND done=1',
    [req.params.id]
  );
  if (jc.status !== 'qc_pending' && !(jc.status === 'in_progress' && stage29Done)) {
    return res.status(400).json({ error: 'Job card is not in QC Pending state' });
  }

  const reportRow = await db.get('SELECT COUNT(*) AS c FROM qc_reports WHERE job_card_id=$1', [req.params.id]);
  if (parseInt(reportRow.c, 10) === 0) return res.status(400).json({ error: 'Upload a QC report before approving' });

  const { io_qty, dispatch_qty, heater_destination } = req.body;
  const orderType = jc.order_type || 'local_he';

  // Calculate net finished qty from production (original qty - total rejections + remade)
  const prodRow = await db.get(`
    SELECT
      COALESCE(SUM(rejection_qty), 0) as total_rejected,
      COALESCE(SUM(remade_qty), 0)    as total_remade
    FROM production_checklist
    WHERE job_card_id = $1
  `, [req.params.id]);
  const netQty = Math.max(
    (jc.qty || 0) - (prodRow.total_rejected - prodRow.total_remade),
    0
  );

  // Fetch first assembly for technical specs
  const asm = await db.get(
    'SELECT * FROM job_card_assemblies WHERE job_card_id=$1 ORDER BY assembly_no ASC LIMIT 1',
    [req.params.id]
  );

  // Helper: strip trailing -N suffix to get the base drawing number for grouping
  // e.g. "PT-UTYPE-12U-500W-1" → "PT-UTYPE-12U-500W"
  function baseDrawingNo(drawingNo) {
    if (!drawingNo) return null;
    return drawingNo.replace(/-\d+$/, '');
  }

  // Helper: create or add to a finished goods entry grouped by base drawing number.
  // One row per unique base_drawing_no — works like inventory stock.
  async function createFinishedGoodsEntry(qty, splitNotes) {
    const baseNo = baseDrawingNo(jc.drawing_no);

    // Check if a product entry already exists for this base drawing number
    const existing = baseNo
      ? await db.get(
          `SELECT id FROM finished_goods WHERE base_drawing_no = $1 LIMIT 1`,
          [baseNo]
        )
      : null;

    let fgId;
    if (existing) {
      // Add stock to the existing product entry
      await db.run(
        `UPDATE finished_goods SET qty_in = qty_in + $1, qty_available = qty_available + $1 WHERE id = $2`,
        [qty, existing.id]
      );
      fgId = existing.id;
    } else {
      // Create the product master row (product-centric, not order-centric)
      const fg = await db.insert(`
        INSERT INTO finished_goods
          (job_card_id, order_id, order_code, order_type, customer_code, customer_name,
           drawing_no, base_drawing_no, tube_material, tube_diameter, wattage, voltage, plating_instructions,
           qty_in, qty_available, notes, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$16)
      `, [
        jc.id, jc.order_id, jc.order_code, jc.order_type,
        jc.customer_code, jc.customer_name,
        jc.drawing_no || null, baseNo,
        asm?.tube_material || null, asm?.tube_diameter_mm || null,
        asm?.wattage_actual || null, asm?.voltage_actual || null,
        asm?.plating_description || null,
        qty, null, req.user.id,
      ]);
      fgId = fg.lastInsertRowid;
    }

    // Log this inward batch with full traceability (job card + order + customer)
    await db.insert(
      `INSERT INTO finished_goods_log
         (finished_good_id, movement_type, qty, job_card_no, order_code, customer_code, reference, notes, created_by)
       VALUES ($1,'inward',$2,$3,$4,$5,$6,$7,$8)`,
      [
        fgId, qty,
        jc.job_card_no, jc.order_code, jc.customer_code,
        jc.job_card_no,   // reference = job card number for easy lookup
        splitNotes || null,
        req.user.id,
      ]
    );

    return fgId;
  }

  // ── Route based on order type + heater_destination ────────────────────────
  if (orderType === 'local_he' || orderType === 'export_he') {
    const dest = heater_destination || 'dispatch';

    if (dest === 'finished_goods') {
      const qty = io_qty != null ? parseInt(io_qty) : netQty;
      if (!qty || qty <= 0) return res.status(400).json({ error: 'Finished Goods quantity must be greater than 0' });
      const fgId = await createFinishedGoodsEntry(qty);
      await db.run("UPDATE job_cards SET status='qc_approved', qc_route='finished_goods', qc_fg_qty=$1, qc_dispatch_qty=0 WHERE id=$2", [qty, req.params.id]);
      await logActivity(jc.order_id, jc.id, 'status_changed',
        `Job card ${jc.job_card_no} QC Approved — ${qty} units added to Finished Goods`, req.user.id);
      await syncOrderStatus(db, jc.order_id, req.user.id);
  await settleAfterQC(db, jc, req.user.id);
      return res.json({ message: 'QC Approved', route: 'finished_goods', finished_good_id: fgId, qty });
    }

    if (dest === 'both') {
      const parsedFgQty  = parseInt(io_qty);
      const parsedDispQty = parseInt(dispatch_qty);
      if (!parsedFgQty  || parsedFgQty  <= 0) return res.status(400).json({ error: 'Finished Goods quantity is required' });
      if (!parsedDispQty || parsedDispQty <= 0) return res.status(400).json({ error: 'Dispatch quantity is required' });
      if (parsedFgQty + parsedDispQty > netQty) {
        return res.status(400).json({ error: `Total (${parsedFgQty + parsedDispQty}) exceeds net finished qty (${netQty})` });
      }
      const fgId = await createFinishedGoodsEntry(parsedFgQty, `Split: ${parsedFgQty} Finished Goods + ${parsedDispQty} dispatch`);
      await db.run("UPDATE job_cards SET status='qc_approved', qc_route='both', qc_fg_qty=$1, qc_dispatch_qty=$2 WHERE id=$3", [parsedFgQty, parsedDispQty, req.params.id]);
      await logActivity(jc.order_id, jc.id, 'status_changed',
        `Job card ${jc.job_card_no} QC Approved — ${parsedFgQty} units to Finished Goods, ${parsedDispQty} to dispatch`, req.user.id);
      await syncOrderStatus(db, jc.order_id, req.user.id);
  await settleAfterQC(db, jc, req.user.id);
      return res.json({ message: 'QC Approved', route: 'both', finished_good_id: fgId, io_qty: parsedFgQty, dispatch_qty: parsedDispQty });
    }

    // Default: dispatch — entire net qty goes to dispatch
    const dispQty = parseInt(dispatch_qty) > 0 ? parseInt(dispatch_qty) : netQty;
    await db.run("UPDATE job_cards SET status='qc_approved', qc_route='dispatch', qc_dispatch_qty=$1, qc_fg_qty=0 WHERE id=$2", [dispQty, req.params.id]);
    await logActivity(jc.order_id, jc.id, 'status_changed', `Job card ${jc.job_card_no} QC Approved — ${dispQty} units going to dispatch`, req.user.id);
    await syncOrderStatus(db, jc.order_id, req.user.id);
  await settleAfterQC(db, jc, req.user.id);
    return res.json({ message: 'QC Approved', route: 'dispatch', dispatch_qty: dispQty });
  }

  if (orderType === 'inventory_order') {
    const qty = io_qty != null ? parseInt(io_qty) : netQty;
    if (!qty || qty <= 0) return res.status(400).json({ error: 'IO quantity must be greater than 0' });
    const fgId = await createFinishedGoodsEntry(qty);
    await db.run("UPDATE job_cards SET status='qc_approved', qc_route='finished_goods', qc_fg_qty=$1, qc_dispatch_qty=0 WHERE id=$2", [qty, req.params.id]);
    await logActivity(jc.order_id, jc.id, 'status_changed',
      `Job card ${jc.job_card_no} QC Approved — ${qty} units added to Finished Goods`, req.user.id);
    await syncOrderStatus(db, jc.order_id, req.user.id);
  await settleAfterQC(db, jc, req.user.id);
    return res.json({ message: 'QC Approved', route: 'finished_goods', finished_good_id: fgId, qty });
  }

  if (orderType === 'io_export_he' || orderType === 'io_local_he') {
    const parsedIoQty = parseInt(io_qty);
    const parsedDispatchQty = parseInt(dispatch_qty);
    if (!parsedIoQty || parsedIoQty <= 0) return res.status(400).json({ error: 'IO quantity is required' });
    if (!parsedDispatchQty || parsedDispatchQty <= 0) return res.status(400).json({ error: 'Dispatch quantity is required' });
    if (parsedIoQty + parsedDispatchQty > netQty) {
      return res.status(400).json({ error: `Total (${parsedIoQty + parsedDispatchQty}) exceeds net finished qty (${netQty})` });
    }
    const fgId = await createFinishedGoodsEntry(parsedIoQty, `Split: ${parsedIoQty} IO + ${parsedDispatchQty} dispatch`);
    await db.run("UPDATE job_cards SET status='qc_approved', qc_route='split', qc_fg_qty=$1, qc_dispatch_qty=$2 WHERE id=$3", [parsedIoQty, parsedDispatchQty, req.params.id]);
    await logActivity(jc.order_id, jc.id, 'status_changed',
      `Job card ${jc.job_card_no} QC Approved — ${parsedIoQty} units to Finished Goods, ${parsedDispatchQty} to dispatch`, req.user.id);
    await syncOrderStatus(db, jc.order_id, req.user.id);
  await settleAfterQC(db, jc, req.user.id);
    return res.json({ message: 'QC Approved', route: 'split', finished_good_id: fgId, io_qty: parsedIoQty, dispatch_qty: parsedDispatchQty });
  }

  // Fallback
  await db.run("UPDATE job_cards SET status='qc_approved', qc_route='dispatch', qc_dispatch_qty=$1, qc_fg_qty=0 WHERE id=$2", [netQty, req.params.id]);
  await logActivity(jc.order_id, jc.id, 'status_changed', `Job card ${jc.job_card_no} QC Approved`, req.user.id);
  await syncOrderStatus(db, jc.order_id, req.user.id);
  await settleAfterQC(db, jc, req.user.id);
  res.json({ message: 'QC Approved', route: 'dispatch' });
});

router.put('/:id/reject', authenticate, authorize('design', 'owner', 'admin'), async (req, res) => {
  const { notes } = req.body;
  const db = getDB();
  const jc = await db.get('SELECT * FROM job_cards WHERE id=$1', [req.params.id]);
  if (!jc) return res.status(404).json({ error: 'Not found' });
  const stage29DoneR = await db.get(
    'SELECT 1 FROM production_checklist WHERE job_card_id=$1 AND stage_no=29 AND done=1',
    [req.params.id]
  );
  if (jc.status !== 'qc_pending' && !(jc.status === 'in_progress' && stage29DoneR)) {
    return res.status(400).json({ error: 'Job card is not in QC Pending state' });
  }

  // Reset stage 29 so production can re-submit to QC after fixing
  await db.run(
    `UPDATE production_checklist SET done=0, done_at=NULL WHERE job_card_id=$1 AND stage_no=29`,
    [req.params.id]
  );

  // Set status back to in_progress
  await db.run(`UPDATE job_cards SET status='in_progress' WHERE id=$1`, [req.params.id]);

  // Flag the rejection for production to see (graceful — columns may not exist on first deploy)
  try {
    await db.run(
      `UPDATE job_cards SET qc_rejected=TRUE, qc_rejection_notes=$1 WHERE id=$2`,
      [notes || null, req.params.id]
    );
  } catch (_) { /* column may not exist yet — ignore, core flow already done */ }

  await logActivity(jc.order_id, jc.id, 'status_changed',
    `Job card ${jc.job_card_no} QC Rejected — returned to production. ${notes || ''}`, req.user.id);
  await syncOrderStatus(db, jc.order_id, req.user.id);
  await settleAfterQC(db, jc, req.user.id);
  res.json({ message: 'QC rejected, returned to production' });
});

// Inventory (BOM) the job card's order item consumes — shown at QC approval so
// design can confirm or edit it before approving. No cost fields (design-safe).
router.get('/:id/bom', authenticate, authorize('design', 'owner', 'admin'), async (req, res) => {
  const db = getDB();
  const jc = await db.get(
    'SELECT id, order_id, drawing_no, order_item_id FROM job_cards WHERE id=$1', [req.params.id]
  );
  if (!jc) return res.status(404).json({ error: 'Not found' });
  const itemId = await resolveJobCardItemId(db, jc);
  if (!itemId) {
    return res.json({ order_id: jc.order_id, item_id: null, drawing_number: jc.drawing_no || null,
      inventory_items: [], deducted: false, is_split: false });
  }
  const item = await db.get('SELECT id, drawing_number, inventory_deducted FROM order_items WHERE id=$1', [itemId]);
  const inventory_items = await db.all(
    `SELECT ii.id, ii.item_code, ii.name, ii.unit, oii.qty
     FROM order_item_inventory oii JOIN inventory_items ii ON ii.id = oii.inventory_item_id
     WHERE oii.order_item_id=$1 ORDER BY ii.item_code`,
    [itemId]
  );
  const cardCount = await db.get('SELECT COUNT(*) AS n FROM job_cards WHERE order_item_id=$1', [itemId]);
  res.json({
    order_id: jc.order_id,
    item_id: itemId,
    drawing_number: item?.drawing_number || jc.drawing_no || null,
    inventory_items,
    deducted: !!item?.inventory_deducted,
    is_split: parseInt(cardCount.n, 10) > 1,
  });
});

module.exports = router;
