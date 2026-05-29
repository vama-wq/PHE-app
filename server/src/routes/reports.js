const router = require('express').Router();
const { getDB } = require('../db');
const { authenticate } = require('../middleware/auth');

// ── Data source query runners (async, PostgreSQL positional params) ────────────

async function runOrders(db, filters = {}) {
  let sql = `
    SELECT
      o.id, o.order_code, c.name AS customer_name, c.customer_code,
      o.status, o.order_date, o.dispatch_date, o.notes,
      u.name AS created_by_name, o.created_at,
      COUNT(DISTINCT oi.id) AS item_count
    FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN users u ON u.id = o.created_by
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE 1=1
  `;
  const params = [];
  if (filters.status)    { sql += ` AND o.status = $${params.length+1}`;              params.push(filters.status); }
  if (filters.date_from) { sql += ` AND o.created_at::date >= $${params.length+1}`;   params.push(filters.date_from); }
  if (filters.date_to)   { sql += ` AND o.created_at::date <= $${params.length+1}`;   params.push(filters.date_to); }
  sql += ' GROUP BY o.id, c.name, c.customer_code, u.name ORDER BY o.created_at DESC';
  return db.all(sql, params);
}

async function runJobCards(db, filters = {}) {
  let sql = `
    SELECT
      jc.id, jc.job_card_no, o.order_code,
      c.name AS customer_name, c.customer_code,
      jc.product_name, jc.qty, jc.punching, jc.drawing_no,
      jc.status, jc.current_stage, jc.dispatch_date,
      u.name AS uploaded_by_name, jc.created_at
    FROM job_cards jc
    LEFT JOIN orders o ON o.id = jc.order_id
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN users u ON u.id = jc.uploaded_by
    WHERE 1=1
  `;
  const params = [];
  if (filters.status)    { sql += ` AND jc.status = $${params.length+1}`;             params.push(filters.status); }
  if (filters.date_from) { sql += ` AND jc.created_at::date >= $${params.length+1}`;  params.push(filters.date_from); }
  if (filters.date_to)   { sql += ` AND jc.created_at::date <= $${params.length+1}`;  params.push(filters.date_to); }
  sql += ' ORDER BY jc.dispatch_date ASC, jc.created_at DESC';
  return db.all(sql, params);
}

async function runQC(db, filters = {}) {
  let sql = `
    SELECT
      qr.id, jc.job_card_no, o.order_code,
      c.name AS customer_name, c.customer_code,
      qr.result, qr.observations, qr.corrective_action, qr.product_weight,
      qr.file_name, u.name AS created_by_name, qr.created_at
    FROM qc_reports qr
    LEFT JOIN job_cards jc ON jc.id = qr.job_card_id
    LEFT JOIN orders o ON o.id = jc.order_id
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN users u ON u.id = qr.created_by
    WHERE 1=1
  `;
  const params = [];
  if (filters.result)    { sql += ` AND qr.result = $${params.length+1}`;             params.push(filters.result); }
  if (filters.date_from) { sql += ` AND qr.created_at::date >= $${params.length+1}`;  params.push(filters.date_from); }
  if (filters.date_to)   { sql += ` AND qr.created_at::date <= $${params.length+1}`;  params.push(filters.date_to); }
  sql += ' ORDER BY qr.created_at DESC';
  return db.all(sql, params);
}

async function runDispatch(db, filters = {}) {
  let sql = `
    SELECT
      dd.id, jc.job_card_no, o.order_code,
      c.name AS customer_name, c.customer_code,
      dd.doc_type, dd.file_name, dd.notes,
      u.name AS uploaded_by_name, dd.created_at
    FROM dispatch_documents dd
    LEFT JOIN job_cards jc ON jc.id = dd.job_card_id
    LEFT JOIN orders o ON o.id = jc.order_id
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN users u ON u.id = dd.uploaded_by
    WHERE 1=1
  `;
  const params = [];
  if (filters.date_from) { sql += ` AND dd.created_at::date >= $${params.length+1}`;  params.push(filters.date_from); }
  if (filters.date_to)   { sql += ` AND dd.created_at::date <= $${params.length+1}`;  params.push(filters.date_to); }
  sql += ' ORDER BY dd.created_at DESC';
  return db.all(sql, params);
}

async function runInventory(db, filters = {}) {
  let sql = `
    SELECT
      ii.id, ii.item_code, ii.name, ii.category, ii.unit,
      ii.current_stock, ii.reorder_level, ii.unit_cost,
      ROUND((ii.current_stock * COALESCE(ii.unit_cost, 0))::numeric, 2) AS stock_value,
      CASE WHEN ii.current_stock <= ii.reorder_level THEN 'Low' ELSE 'OK' END AS stock_status,
      ii.notes, ii.created_at
    FROM inventory_items ii
    WHERE 1=1
  `;
  const params = [];
  if (filters.category)     { sql += ` AND ii.category = $${params.length+1}`;  params.push(filters.category); }
  if (filters.stock_status === 'low') { sql += ' AND ii.current_stock <= ii.reorder_level'; }
  sql += ' ORDER BY ii.category, ii.name ASC';
  return db.all(sql, params);
}

async function runPurchaseOrders(db, filters = {}) {
  let sql = `
    SELECT
      po.id, po.po_number, s.name AS supplier_name,
      po.status, po.delivery_status, po.total_amount,
      po.expected_delivery_date, po.received_at,
      po.created_at, po.notes
    FROM purchase_orders po
    LEFT JOIN suppliers s ON s.id = po.supplier_id
    WHERE 1=1
  `;
  const params = [];
  if (filters.status)          { sql += ` AND po.status = $${params.length+1}`;           params.push(filters.status); }
  if (filters.delivery_status) { sql += ` AND po.delivery_status = $${params.length+1}`;  params.push(filters.delivery_status); }
  if (filters.date_from)       { sql += ` AND po.created_at::date >= $${params.length+1}`;  params.push(filters.date_from); }
  if (filters.date_to)         { sql += ` AND po.created_at::date <= $${params.length+1}`;  params.push(filters.date_to); }
  sql += ' ORDER BY po.created_at DESC';
  return db.all(sql, params);
}

async function runRejections(db, filters = {}) {
  let sql = `
    SELECT
      pc.id, jc.job_card_no, o.order_code,
      c.name AS customer_name, c.customer_code,
      pc.stage_no, pc.rejection_qty, pc.remade_qty,
      pc.done_at, jc.status AS card_status,
      jch.status AS hold_status, jch.approved_at,
      ua.name AS approved_by
    FROM production_checklist pc
    LEFT JOIN job_cards jc ON jc.id = pc.job_card_id
    LEFT JOIN orders o ON o.id = jc.order_id
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN job_card_holds jch ON jch.job_card_id = pc.job_card_id AND jch.stage_no = pc.stage_no
    LEFT JOIN users ua ON ua.id = jch.approved_by
    WHERE pc.rejection_qty > 0
  `;
  const params = [];
  if (filters.date_from) { sql += ` AND pc.done_at::date >= $${params.length+1}`;  params.push(filters.date_from); }
  if (filters.date_to)   { sql += ` AND pc.done_at::date <= $${params.length+1}`;  params.push(filters.date_to); }
  sql += ' ORDER BY pc.rejection_qty DESC, pc.done_at DESC';
  return db.all(sql, params);
}

const DATA_RUNNERS = {
  orders:          runOrders,
  job_cards:       runJobCards,
  qc:              runQC,
  dispatch:        runDispatch,
  inventory:       runInventory,
  purchase_orders: runPurchaseOrders,
  rejections:      runRejections,
};

// ── GET /api/reports/data/:source ─────────────────────────────────────────────
router.get('/data/:source', authenticate, async (req, res) => {
  const { source } = req.params;
  const runner = DATA_RUNNERS[source];
  if (!runner) return res.status(400).json({ error: 'Unknown data source' });
  try {
    const db = getDB();
    const rows = await runner(db, req.query);
    res.json(rows);
  } catch (err) {
    console.error('Report data error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Template CRUD ─────────────────────────────────────────────────────────────

// GET /api/reports/templates
router.get('/templates', authenticate, async (req, res) => {
  const db = getDB();
  const rows = await db.all(`
    SELECT rt.*, u.name AS created_by_name
    FROM report_templates rt
    LEFT JOIN users u ON u.id = rt.created_by
    ORDER BY rt.updated_at DESC
  `);
  res.json(rows);
});

// POST /api/reports/templates
router.post('/templates', authenticate, async (req, res) => {
  const { name, description, data_source, columns_config } = req.body;
  if (!name || !data_source || !columns_config)
    return res.status(400).json({ error: 'name, data_source, and columns_config are required' });
  if (!DATA_RUNNERS[data_source])
    return res.status(400).json({ error: 'Invalid data source' });

  const db = getDB();
  const result = await db.insert(`
    INSERT INTO report_templates (name, description, data_source, columns_config, created_by)
    VALUES ($1,$2,$3,$4,$5)
  `, [name.trim(), description || null, data_source, columns_config, req.user.id]);

  res.json({ id: result.lastInsertRowid, message: 'Template saved' });
});

// PUT /api/reports/templates/:id
router.put('/templates/:id', authenticate, async (req, res) => {
  const { name, description, data_source, columns_config } = req.body;
  const db = getDB();
  const tpl = await db.get('SELECT * FROM report_templates WHERE id=$1', [req.params.id]);
  if (!tpl) return res.status(404).json({ error: 'Template not found' });

  if (data_source && !DATA_RUNNERS[data_source])
    return res.status(400).json({ error: 'Invalid data source' });

  await db.run(`
    UPDATE report_templates
    SET name=$1, description=$2, data_source=$3, columns_config=$4, updated_at=NOW()
    WHERE id=$5
  `, [
    name?.trim() || tpl.name,
    description !== undefined ? description : tpl.description,
    data_source || tpl.data_source,
    columns_config || tpl.columns_config,
    req.params.id
  ]);
  res.json({ message: 'Updated' });
});

// DELETE /api/reports/templates/:id
router.delete('/templates/:id', authenticate, async (req, res) => {
  const db = getDB();
  const tpl = await db.get('SELECT id, created_by FROM report_templates WHERE id=$1', [req.params.id]);
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  if (tpl.created_by !== req.user.id && req.user.role !== 'owner')
    return res.status(403).json({ error: 'Not allowed' });
  await db.run('DELETE FROM report_templates WHERE id=$1', [req.params.id]);
  res.json({ message: 'Deleted' });
});

module.exports = router;
