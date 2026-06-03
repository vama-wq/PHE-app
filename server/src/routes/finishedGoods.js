const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

// ── List all finished goods ───────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  const rows = await getDB().all(`
    SELECT fg.*, u.name as created_by_name
    FROM finished_goods fg
    LEFT JOIN users u ON fg.created_by = u.id
    ORDER BY fg.created_at DESC
  `);
  res.json(rows);
});

// ── Single finished good with log ─────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  const db = getDB();
  const fg = await db.get(`
    SELECT fg.*, u.name as created_by_name
    FROM finished_goods fg
    LEFT JOIN users u ON fg.created_by = u.id
    WHERE fg.id = $1
  `, [req.params.id]);
  if (!fg) return res.status(404).json({ error: 'Not found' });

  const log = await db.all(`
    SELECT fgl.*, u.name as created_by_name
    FROM finished_goods_log fgl
    LEFT JOIN users u ON fgl.created_by = u.id
    WHERE fgl.finished_good_id = $1
    ORDER BY fgl.created_at DESC
  `, [req.params.id]);

  res.json({ ...fg, log });
});

// ── Manual outward (dispatch / sampling from finished goods) ──────────────────
router.post('/:id/outward', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const { qty, outward_type, client_code, client_name, reason, reference, notes } = req.body;
  if (!qty || parseInt(qty) <= 0) return res.status(400).json({ error: 'Valid quantity required' });
  if (!outward_type || !['dispatch', 'sampling'].includes(outward_type))
    return res.status(400).json({ error: 'Outward type must be dispatch or sampling' });
  if (!client_name || !client_name.trim())
    return res.status(400).json({ error: 'Client name is required' });
  if (outward_type === 'sampling' && !reason?.trim())
    return res.status(400).json({ error: 'Reason is required for sampling outward' });

  const db = getDB();
  const fg = await db.get('SELECT * FROM finished_goods WHERE id=$1', [req.params.id]);
  if (!fg) return res.status(404).json({ error: 'Not found' });
  const parsedQty = parseInt(qty);
  if (fg.qty_available < parsedQty) return res.status(400).json({ error: `Only ${fg.qty_available} units available` });

  await db.run('UPDATE finished_goods SET qty_available = qty_available - $1 WHERE id=$2', [parsedQty, fg.id]);
  await db.insert(
    `INSERT INTO finished_goods_log
       (finished_good_id, movement_type, qty, outward_type, client_code, client_name, reason, reference, notes, created_by)
     VALUES ($1,'outward',$2,$3,$4,$5,$6,$7,$8,$9)`,
    [fg.id, parsedQty, outward_type, client_code || null, client_name.trim(),
     reason || null, reference || null, notes || null, req.user.id]
  );

  res.json({ message: 'Outward recorded' });
});

module.exports = router;
