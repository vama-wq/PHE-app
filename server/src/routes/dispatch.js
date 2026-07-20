const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadDispatch, deleteFromStorage } = require('../middleware/upload');
const { createNotification } = require('./notifications');
const { settleItemInventory, resolveJobCardItemId } = require('../lib/inventoryDeduction');

router.get('/job-card/:jobCardId', authenticate, async (req, res) => {
  const docs = await getDB().all(
    `SELECT d.*, u.name as created_by_name
     FROM dispatch_documents d LEFT JOIN users u ON d.created_by = u.id
     WHERE d.job_card_id = $1
     ORDER BY d.created_at DESC`,
    [req.params.jobCardId]
  );
  res.json(docs);
});

router.post('/', authenticate, authorize('accounts', 'owner'), ...uploadDispatch, async (req, res) => {
  const { job_card_id, doc_type, shipping_carrier, tracking_number, dispatch_date, notes } = req.body;
  if (!job_card_id) return res.status(400).json({ error: 'Job card ID required' });

  const db = getDB();
  const r = await db.insert(
    `INSERT INTO dispatch_documents (job_card_id, doc_type, file_path, file_name, shipping_carrier, tracking_number, dispatch_date, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [job_card_id, doc_type||null,
     req.file?.storagePath||null, req.file?.filename||null,
     shipping_carrier||null, tracking_number||null, dispatch_date||null, notes||null, req.user.id]
  );

  const jc = await db.get('SELECT order_id FROM job_cards WHERE id=$1', [job_card_id]);
  if (jc) await logActivity(jc.order_id, job_card_id, 'dispatch_doc_uploaded',
    `Dispatch document uploaded: ${doc_type || 'document'}`, req.user.id);

  res.status(201).json({ id: r.lastInsertRowid });
});

// ── Update / replace a dispatch document (edit invoice) ─────────────────────
router.put('/doc/:id', authenticate, authorize('accounts', 'owner'), ...uploadDispatch, async (req, res) => {
  const { doc_type, shipping_carrier, tracking_number, dispatch_date, notes } = req.body;
  const db = getDB();
  const doc = await db.get('SELECT * FROM dispatch_documents WHERE id=$1', [req.params.id]);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  // If a new file was uploaded, delete the old one and use the new path
  let filePath = doc.file_path;
  let fileName = doc.file_name;
  if (req.file) {
    if (doc.file_path) await deleteFromStorage(doc.file_path);
    filePath = req.file.storagePath;
    fileName = req.file.filename;
  }

  await db.run(
    `UPDATE dispatch_documents SET doc_type=$1, file_path=$2, file_name=$3,
       shipping_carrier=$4, tracking_number=$5, dispatch_date=$6, notes=$7
     WHERE id=$8`,
    [doc_type || doc.doc_type, filePath, fileName,
     shipping_carrier ?? doc.shipping_carrier, tracking_number ?? doc.tracking_number,
     dispatch_date || doc.dispatch_date, notes ?? doc.notes, req.params.id]
  );

  const jc = await db.get('SELECT order_id FROM job_cards WHERE id=$1', [doc.job_card_id]);
  if (jc) await logActivity(jc.order_id, doc.job_card_id, 'dispatch_doc_updated',
    `Dispatch document updated: ${doc_type || doc.doc_type}`, req.user.id);

  res.json({ message: 'Document updated' });
});

router.put('/:jobCardId/mark-dispatched', authenticate, authorize('accounts', 'owner'), async (req, res) => {
  const { dispatch_date, shipping_carrier, tracking_number } = req.body;
  const db = getDB();
  const jc = await db.get('SELECT * FROM job_cards WHERE id=$1', [req.params.jobCardId]);
  if (!jc) return res.status(404).json({ error: 'Job card not found' });

  // Block dispatch if card is on hold or has pending holds
  if (jc.status === 'on_hold') {
    return res.status(400).json({ error: 'Cannot dispatch — job card is on hold. Owner must approve the hold first.' });
  }

  // Cards QC-routed entirely into Finished Goods have nothing to dispatch
  if (jc.status === 'qc_approved' && jc.qc_route === 'finished_goods' && (Number(jc.qc_dispatch_qty) || 0) === 0) {
    return res.status(400).json({ error: 'Nothing to dispatch — QC sent the entire quantity to Finished Goods.' });
  }
  const pendingHold = await db.get(
    "SELECT id FROM job_card_holds WHERE job_card_id=$1 AND status='pending' LIMIT 1",
    [req.params.jobCardId]
  );
  if (pendingHold) {
    return res.status(400).json({ error: 'Cannot dispatch — job card has a pending hold that must be approved first.' });
  }

  // Is this a repaired return being re-dispatched? The original dispatch already had an
  // invoice, so accounts can dispatch without raising a new one.
  const repairQuery = await db.get(
    `SELECT id, query_no FROM customer_queries
     WHERE job_card_id=$1 AND status='product_return' AND return_type='repair'
       AND return_status NOT IN ('repaired_dispatched','debit_note_issued')
     ORDER BY id DESC LIMIT 1`,
    [req.params.jobCardId]
  );
  const isRepairDispatch = !!repairQuery;

  // Require an invoice before dispatching — except for repaired returns and
  // replacement cards (the original dispatch was already invoiced).
  const invoiceDoc = await db.get(
    "SELECT id FROM dispatch_documents WHERE job_card_id=$1 AND doc_type='invoice' LIMIT 1",
    [req.params.jobCardId]
  );
  if (!invoiceDoc && !isRepairDispatch && !jc.replacement_query_id) {
    return res.status(400).json({ error: 'An invoice document is required before dispatching. Please upload an invoice first.' });
  }

  // Save shipping details on the invoice document (if one exists)
  if (invoiceDoc) {
    await db.run(
      `UPDATE dispatch_documents SET shipping_carrier=$1, tracking_number=$2, dispatch_date=$3
       WHERE id=$4`,
      [shipping_carrier || null, tracking_number || null, dispatch_date || null, invoiceDoc.id]
    );
  }

  await db.run("UPDATE job_cards SET status='dispatched', dispatched_at=NOW() WHERE id=$1", [req.params.jobCardId]);
  await db.run("UPDATE orders SET status='dispatched' WHERE id=$1", [jc.order_id]);

  // Repaired return: close the customer query now that it's re-dispatched.
  if (isRepairDispatch) {
    await db.run(
      `UPDATE customer_queries SET status='resolved', return_status='repaired_dispatched', updated_at=NOW() WHERE id=$1`,
      [repairQuery.id]
    );
    await logActivity(jc.order_id, jc.id, 'repair_dispatched',
      `Repaired product re-dispatched (query ${repairQuery.query_no})${invoiceDoc ? '' : ' — no new invoice required'}`, req.user.id);
  }

  // Settle this item's inventory. For a partially-dispatched (split) item this is
  // where the full BOM finally deducts — once every split is dispatched / in FG.
  try {
    const itemId = await resolveJobCardItemId(db, jc);
    if (itemId) {
      const ord = await db.get('SELECT order_code FROM orders WHERE id=$1', [jc.order_id]);
      await settleItemInventory(db, itemId, req.user.id, ord?.order_code || `Order #${jc.order_id}`);
    }
  } catch (e) { console.error('[dispatch] settle inventory failed:', e.message); }

  await logActivity(jc.order_id, jc.id, 'dispatched',
    `Order dispatched via ${shipping_carrier || 'carrier'} — Tracking: ${tracking_number || 'N/A'}`, req.user.id);

  res.json({ message: 'Marked as dispatched' });
});

router.post('/request-price', authenticate, authorize('accounts', 'owner'), async (req, res) => {
  const { job_card_id } = req.body;
  if (!job_card_id) return res.status(400).json({ error: 'Job card ID required' });

  const db = getDB();
  const jc = await db.get(
    `SELECT jc.job_card_no, jc.order_id, jc.product_name, jc.drawing_no, o.order_code, c.customer_code
     FROM job_cards jc JOIN orders o ON jc.order_id = o.id JOIN customers c ON o.customer_id = c.id
     WHERE jc.id = $1`, [job_card_id]
  );
  if (!jc) return res.status(404).json({ error: 'Job card not found' });

  const owners = await db.all("SELECT id FROM users WHERE role = 'owner'");
  const itemLabel = jc.product_name || jc.drawing_no || jc.job_card_no;
  for (const owner of owners) {
    await createNotification(db, {
      userId: owner.id,
      type: 'price_request',
      title: `Price requested for ${jc.job_card_no}`,
      body: `${itemLabel} (${jc.customer_code}) — no quotation attached. Please add pricing.`,
      link: `/orders/${jc.order_id}`,
      sourceUserId: req.user.id,
    });
  }

  await logActivity(jc.order_id, job_card_id, 'price_requested',
    `Price requested for dispatch item: ${itemLabel}`, req.user.id);

  res.json({ message: 'Price request sent to owner' });
});

router.delete('/:id', authenticate, authorize('accounts', 'owner'), async (req, res) => {
  const db = getDB();
  const doc = await db.get('SELECT * FROM dispatch_documents WHERE id=$1', [req.params.id]);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  if (doc.file_path) await deleteFromStorage(doc.file_path);
  await db.run('DELETE FROM dispatch_documents WHERE id=$1', [req.params.id]);
  res.json({ message: 'Deleted' });
});

module.exports = router;
