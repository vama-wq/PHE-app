const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadQC } = require('../middleware/upload');

router.get('/', authenticate, authorize('design', 'owner', 'admin'), async (req, res) => {
  const cards = await getDB().all(
    `SELECT jc.*, o.order_code, c.customer_code, u.name as uploaded_by_name,
       (SELECT COUNT(*) FROM qc_reports WHERE job_card_id = jc.id) as report_count,
       (jc.dispatch_date::date - CURRENT_DATE) as days_until_dispatch
     FROM job_cards jc
     JOIN orders o ON jc.order_id = o.id
     JOIN customers c ON o.customer_id = c.id
     LEFT JOIN users u ON jc.uploaded_by = u.id
     WHERE jc.status = 'qc_pending'
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

router.put('/:id/approve', authenticate, authorize('design', 'owner', 'admin'), async (req, res) => {
  const db = getDB();
  const jc = await db.get('SELECT * FROM job_cards WHERE id=$1', [req.params.id]);
  if (!jc) return res.status(404).json({ error: 'Not found' });
  if (jc.status !== 'qc_pending') return res.status(400).json({ error: 'Job card is not in QC Pending state' });

  const reportRow = await db.get('SELECT COUNT(*) AS c FROM qc_reports WHERE job_card_id=$1', [req.params.id]);
  if (parseInt(reportRow.c, 10) === 0) return res.status(400).json({ error: 'Upload a QC report before approving' });

  await db.run("UPDATE job_cards SET status='qc_approved' WHERE id=$1", [req.params.id]);
  await logActivity(jc.order_id, jc.id, 'status_changed', `Job card ${jc.job_card_no} QC Approved`, req.user.id);
  res.json({ message: 'QC Approved' });
});

router.put('/:id/reject', authenticate, authorize('design', 'owner', 'admin'), async (req, res) => {
  const { notes } = req.body;
  const db = getDB();
  const jc = await db.get('SELECT * FROM job_cards WHERE id=$1', [req.params.id]);
  if (!jc) return res.status(404).json({ error: 'Not found' });
  if (jc.status !== 'qc_pending') return res.status(400).json({ error: 'Job card is not in QC Pending state' });

  await db.run("UPDATE job_cards SET status='in_progress' WHERE id=$1", [req.params.id]);
  await logActivity(jc.order_id, jc.id, 'status_changed',
    `Job card ${jc.job_card_no} QC Rejected — returned to production. ${notes || ''}`, req.user.id);
  res.json({ message: 'QC rejected, returned to production' });
});

module.exports = router;
