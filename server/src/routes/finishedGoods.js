const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize, withCustomerVisibility } = require('../middleware/auth');

// ── Storage locations (predefined labels) ─────────────────────────────────────
// NOTE: defined before '/:id' so "locations" isn't captured as an :id.
router.get('/locations', authenticate, async (req, res) => {
  res.json(await getDB().all('SELECT * FROM finished_goods_locations ORDER BY active DESC, name ASC'));
});
router.post('/locations', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Location name is required' });
  try {
    const r = await getDB().insert('INSERT INTO finished_goods_locations (name) VALUES ($1)', [name]);
    res.status(201).json({ id: r.lastInsertRowid, name });
  } catch (e) {
    if (/unique|duplicate/i.test(e.message)) return res.status(409).json({ error: 'That location already exists' });
    throw e;
  }
});
router.put('/locations/:id', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const { name, active } = req.body;
  const db = getDB();
  const loc = await db.get('SELECT * FROM finished_goods_locations WHERE id=$1', [req.params.id]);
  if (!loc) return res.status(404).json({ error: 'Not found' });
  try {
    await db.run('UPDATE finished_goods_locations SET name=$1, active=$2 WHERE id=$3',
      [name?.trim() || loc.name, active !== undefined ? !!active : loc.active, req.params.id]);
    res.json({ message: 'Updated' });
  } catch (e) {
    if (/unique|duplicate/i.test(e.message)) return res.status(409).json({ error: 'That location already exists' });
    throw e;
  }
});
router.delete('/locations/:id', authenticate, authorize('owner', 'admin'), async (req, res) => {
  // Soft-deactivate rather than hard-delete, so historical movement labels stay intact.
  await getDB().run('UPDATE finished_goods_locations SET active=FALSE WHERE id=$1', [req.params.id]);
  res.json({ message: 'Location deactivated' });
});

// ── Global movement log (all inward + outward across all FG items) ────────────
router.get('/logs', authenticate, async (req, res) => {
  const rows = await getDB().all(`
    SELECT
      fgl.*,
      fg.base_drawing_no, fg.drawing_no,
      fg.tube_material, fg.wattage, fg.voltage,
      u.name AS created_by_name
    FROM finished_goods_log fgl
    JOIN finished_goods fg ON fgl.finished_good_id = fg.id
    LEFT JOIN users u ON fgl.created_by = u.id
    ORDER BY fgl.created_at DESC
    LIMIT 500
  `);
  res.json(rows);
});

// ── List all finished goods (one row per product / base_drawing_no) ───────────
router.get('/', authenticate, async (req, res) => {
  // Group by base_drawing_no so duplicate rows (from old schema) collapse correctly.
  // Use first-created row's specs for product display.
  const rows = await getDB().all(`
    SELECT
      fg.id,
      COALESCE(fg.base_drawing_no, fg.drawing_no) AS base_drawing_no,
      fg.drawing_no,
      fg.tube_material,
      fg.tube_diameter,
      fg.wattage,
      fg.voltage,
      fg.plating_instructions,
      fg.qty_in,
      fg.qty_available,
      fg.notes,
      fg.created_at,
      u.name AS created_by_name,
      -- Count distinct job cards that have contributed inward stock
      (SELECT COUNT(*) FROM finished_goods_log fgl
       WHERE fgl.finished_good_id = fg.id AND fgl.movement_type = 'inward') AS inward_batches
    FROM finished_goods fg
    LEFT JOIN users u ON fg.created_by = u.id
    ORDER BY fg.created_at DESC
  `);
  res.json(rows);
});

// ── Single finished good with enriched log ────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  const db = getDB();
  const canSeeNames = withCustomerVisibility(req);
  const fg = await db.get(`
    SELECT fg.*, u.name as created_by_name
    FROM finished_goods fg
    LEFT JOIN users u ON fg.created_by = u.id
    WHERE fg.id = $1
  `, [req.params.id]);
  if (!fg) return res.status(404).json({ error: 'Not found' });
  if (!canSeeNames) { fg.customer_name = undefined; }

  const log = await db.all(`
    SELECT fgl.*,
      u.name AS created_by_name,
      jc.id          AS job_card_id,
      jc.drawing_no  AS jc_drawing_no,
      jc.product_name,
      o.order_code   AS jc_order_code,
      c.customer_code AS jc_customer_code
      ${canSeeNames ? ", c.name AS jc_customer_name" : ''}
    FROM finished_goods_log fgl
    LEFT JOIN users u ON fgl.created_by = u.id
    LEFT JOIN job_cards jc ON jc.job_card_no = fgl.job_card_no
    LEFT JOIN orders o ON o.id = jc.order_id
    LEFT JOIN customers c ON c.id = o.customer_id
    WHERE fgl.finished_good_id = $1
    ORDER BY fgl.created_at DESC
  `, [req.params.id]);

  res.json({ ...fg, log });
});

// ── Manual create / add finished goods ───────────────────────────────────────
router.post('/', authenticate, authorize('owner', 'admin', 'accounts'), async (req, res) => {
  const { base_drawing_no, tube_material, tube_diameter, wattage, voltage,
          plating_instructions, qty, notes } = req.body;
  if (!base_drawing_no?.trim()) return res.status(400).json({ error: 'Item code (drawing no) is required' });
  const parsedQty = parseInt(qty);
  if (!parsedQty || parsedQty <= 0) return res.status(400).json({ error: 'Valid quantity required' });

  const db = getDB();
  const code = base_drawing_no.trim().toUpperCase();

  const existing = await db.get(
    'SELECT id, qty_in, qty_available FROM finished_goods WHERE UPPER(base_drawing_no) = $1',
    [code]
  );

  let fgId;
  if (existing) {
    await db.run(
      'UPDATE finished_goods SET qty_in = qty_in + $1, qty_available = qty_available + $1 WHERE id = $2',
      [parsedQty, existing.id]
    );
    fgId = existing.id;
  } else {
    const result = await db.insert(
      `INSERT INTO finished_goods
         (base_drawing_no, drawing_no, tube_material, tube_diameter, wattage, voltage, plating_instructions, qty_in, qty_available, notes, created_by)
       VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$7,$8,$9)`,
      [code, tube_material || null, tube_diameter || null,
       wattage || null, voltage || null, plating_instructions || null,
       parsedQty, notes || null, req.user.id]
    );
    fgId = result.lastInsertRowid;
  }

  await db.insert(
    `INSERT INTO finished_goods_log
       (finished_good_id, movement_type, qty, notes, created_by)
     VALUES ($1,'inward',$2,$3,$4)`,
    [fgId, parsedQty, notes ? `Manual entry: ${notes}` : 'Manual entry', req.user.id]
  );

  res.json({ id: fgId, message: existing ? 'Stock added to existing item' : 'Finished good created' });
});

// ── Manual inward (add stock to existing FG item) ────────────────────────────
router.post('/:id/inward', authenticate, authorize('owner', 'admin', 'accounts'), async (req, res) => {
  const { qty, notes, location } = req.body;
  const parsedQty = parseInt(qty);
  if (!parsedQty || parsedQty <= 0) return res.status(400).json({ error: 'Valid quantity required' });

  const db = getDB();
  const fg = await db.get('SELECT * FROM finished_goods WHERE id=$1', [req.params.id]);
  if (!fg) return res.status(404).json({ error: 'Not found' });

  const loc = (location || '').trim() || null;
  await db.run(
    'UPDATE finished_goods SET qty_in = qty_in + $1, qty_available = qty_available + $1, location = COALESCE($3, location) WHERE id = $2',
    [parsedQty, fg.id, loc]
  );

  await db.insert(
    `INSERT INTO finished_goods_log
       (finished_good_id, movement_type, qty, notes, location, created_by)
     VALUES ($1,'inward',$2,$3,$4,$5)`,
    [fg.id, parsedQty, notes ? `Manual entry: ${notes}` : 'Manual entry', loc, req.user.id]
  );

  res.json({ message: 'Inward stock recorded' });
});

// ── Manual outward (dispatch / sampling from finished goods) ──────────────────
router.post('/:id/outward', authenticate, authorize('owner', 'admin', 'accounts'), async (req, res) => {
  const { qty, outward_type, client_code, client_name, reason, reference, notes, location } = req.body;
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
  if (fg.qty_available < parsedQty)
    return res.status(400).json({ error: `Only ${fg.qty_available} units available` });

  await db.run(
    'UPDATE finished_goods SET qty_available = qty_available - $1 WHERE id=$2',
    [parsedQty, fg.id]
  );
  await db.insert(
    `INSERT INTO finished_goods_log
       (finished_good_id, movement_type, qty, outward_type, client_code, client_name, reason, reference, notes, location, created_by)
     VALUES ($1,'outward',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [fg.id, parsedQty, outward_type, client_code || null, client_name.trim(),
     reason || null, reference || null, notes || null, (location || '').trim() || null, req.user.id]
  );

  res.json({ message: 'Outward recorded' });
});

module.exports = router;
