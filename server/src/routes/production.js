const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadPackage } = require('../middleware/upload');

router.get('/reports', authenticate, async (req, res) => {
  const { date, job_card_id } = req.query;
  let sql = `
    SELECT pr.*, u.name as created_by_name, jc.job_card_no
    FROM production_daily_reports pr
    LEFT JOIN users u ON pr.reported_by = u.id
    LEFT JOIN job_cards jc ON pr.job_card_id = jc.id
    WHERE 1=1
  `;
  const params = [];
  if (date)        { sql += ` AND pr.report_date = $${params.length+1}`;    params.push(date); }
  if (job_card_id) { sql += ` AND pr.job_card_id = $${params.length+1}`;  params.push(job_card_id); }
  sql += ' ORDER BY pr.report_date DESC, pr.created_at DESC';

  res.json(await getDB().all(sql, params));
});

// Package photos
router.post('/package-photos', authenticate, authorize('production', 'owner'), ...uploadPackage, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File required' });
  const { job_card_id, notes } = req.body;
  if (!job_card_id) return res.status(400).json({ error: 'Job card ID required' });

  const db = getDB();
  const r = await db.insert(
    `INSERT INTO package_photos (job_card_id, file_path, file_name, notes, uploaded_by)
     VALUES ($1,$2,$3,$4,$5)`,
    [job_card_id, req.file.storagePath, req.file.filename, notes||null, req.user.id]
  );

  const jc = await db.get('SELECT order_id FROM job_cards WHERE id=$1', [job_card_id]);
  if (jc) await logActivity(jc.order_id, job_card_id, 'package_photo_uploaded', 'Package photo uploaded', req.user.id);

  res.status(201).json({ id: r.lastInsertRowid, file_name: req.file.filename });
});

module.exports = router;
