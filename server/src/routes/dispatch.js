const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadDispatch, deleteFromStorage } = require('../middleware/upload');

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

router.put('/:jobCardId/mark-dispatched', authenticate, authorize('accounts', 'owner'), async (req, res) => {
  const { dispatch_date, shipping_carrier, tracking_number } = req.body;
  const db = getDB();
  const jc = await db.get('SELECT * FROM job_cards WHERE id=$1', [req.params.jobCardId]);
  if (!jc) return res.status(404).json({ error: 'Job card not found' });

  // Block dispatch if card is on hold or has pending holds
  if (jc.status === 'on_hold') {
    return res.status(400).json({ error: 'Cannot dispatch — job card is on hold. Owner must approve the hold first.' });
  }
  const pendingHold = await db.get(
    "SELECT id FROM job_card_holds WHERE job_card_id=$1 AND status='pending' LIMIT 1",
    [req.params.jobCardId]
  );
  if (pendingHold) {
    return res.status(400).json({ error: 'Cannot dispatch — job card has a pending hold that must be approved first.' });
  }

  await db.run("UPDATE job_cards SET status='dispatched' WHERE id=$1", [req.params.jobCardId]);
  await db.run("UPDATE orders SET status='dispatched' WHERE id=$1", [jc.order_id]);

  await logActivity(jc.order_id, jc.id, 'dispatched',
    `Order dispatched via ${shipping_carrier || 'carrier'} — Tracking: ${tracking_number || 'N/A'}`, req.user.id);

  res.json({ message: 'Marked as dispatched' });
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
