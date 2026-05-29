const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadDrawing, deleteFromStorage } = require('../middleware/upload');

router.get('/job-card/:jobCardId', authenticate, async (req, res) => {
  const drawings = await getDB().all(
    `SELECT d.*, u.name as uploaded_by_name, a.assembly_no
     FROM drawings d
     LEFT JOIN users u ON d.uploaded_by = u.id
     LEFT JOIN job_card_assemblies a ON d.assembly_id = a.id
     WHERE d.job_card_id = $1
     ORDER BY d.assembly_id, d.version DESC, d.created_at DESC`,
    [req.params.jobCardId]
  );
  res.json(drawings);
});

router.post('/', authenticate, authorize('design', 'owner'), ...uploadDrawing, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File required' });
  const { job_card_id, assembly_id, notes } = req.body;
  if (!job_card_id) return res.status(400).json({ error: 'Job card ID required' });

  const db = getDB();

  const lastVersion = await db.get(
    `SELECT MAX(version) as v FROM drawings
     WHERE job_card_id=$1 AND (assembly_id=$2 OR (assembly_id IS NULL AND $2 IS NULL))`,
    [job_card_id, assembly_id || null]
  );
  const version = (lastVersion?.v || 0) + 1;

  const r = await db.insert(
    `INSERT INTO drawings (job_card_id, assembly_id, file_path, file_name, original_name, version, notes, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [job_card_id, assembly_id||null, req.file.storagePath, req.file.filename, req.file.originalname, version, notes||null, req.user.id]
  );

  const jc = await db.get('SELECT order_id FROM job_cards WHERE id=$1', [job_card_id]);
  let assemblyInfo = '';
  if (assembly_id) {
    const asm = await db.get('SELECT assembly_no FROM job_card_assemblies WHERE id=$1', [assembly_id]);
    assemblyInfo = asm ? ` for Assembly ${asm.assembly_no}` : '';
  }
  await logActivity(jc?.order_id, job_card_id, 'drawing_uploaded',
    `Drawing uploaded${assemblyInfo} (v${version}): ${req.file.originalname}`, req.user.id);

  res.status(201).json({ id: r.lastInsertRowid, version, file_name: req.file.filename });
});

router.delete('/:id', authenticate, authorize('design', 'owner'), async (req, res) => {
  const db = getDB();
  const drawing = await db.get('SELECT * FROM drawings WHERE id=$1', [req.params.id]);
  if (!drawing) return res.status(404).json({ error: 'Not found' });
  if (drawing.file_path) await deleteFromStorage(drawing.file_path);
  await db.run('DELETE FROM drawings WHERE id=$1', [req.params.id]);
  res.json({ message: 'Deleted' });
});

// Serve a drawing file (redirect to storage path via the /uploads proxy)
router.get('/file/:filename', authenticate, async (req, res) => {
  const drawing = await getDB().get('SELECT * FROM drawings WHERE file_name=$1', [req.params.filename]);
  if (!drawing) return res.status(404).json({ error: 'File not found' });
  // Redirect to the /uploads proxy which fetches from Supabase Storage
  res.redirect(`/uploads/${drawing.file_path}`);
});

module.exports = router;
