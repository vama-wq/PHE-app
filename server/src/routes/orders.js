const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize, withCustomerVisibility } = require('../middleware/auth');
const { uploadQuotation, uploadOrderDrawing, uploadOrderItemImage, deleteFromStorage } = require('../middleware/upload');

router.get('/', authenticate, async (req, res) => {
  const db = getDB();
  const canSeeNames = withCustomerVisibility(req);
  const orders = await db.all(
    `SELECT o.*, c.customer_code,
       ${canSeeNames ? 'c.name as customer_name,' : ''}
       u.name as created_by_name,
       jc.job_card_no,
       (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as item_count
     FROM orders o
     JOIN customers c ON o.customer_id = c.id
     LEFT JOIN users u ON o.created_by = u.id
     LEFT JOIN job_cards jc ON jc.order_id = o.id
     ORDER BY o.created_at DESC`
  );
  res.json(orders);
});

router.get('/:id', authenticate, async (req, res) => {
  const db = getDB();
  const canSeeNames = withCustomerVisibility(req);
  const order = await db.get(
    `SELECT o.*, c.customer_code,
       ${canSeeNames ? 'c.name as customer_name, c.contact_person, c.phone, c.email, c.address,' : ''}
       u.name as created_by_name, ua.name as approved_by_name
     FROM orders o
     JOIN customers c ON o.customer_id = c.id
     LEFT JOIN users u ON o.created_by = u.id
     LEFT JOIN users ua ON o.approved_by = ua.id
     WHERE o.id = $1`,
    [req.params.id]
  );
  if (!order) return res.status(404).json({ error: 'Order not found' });

  order.quotations = await db.all(
    `SELECT q.*, u.name as uploaded_by_name
     FROM quotations q LEFT JOIN users u ON q.uploaded_by = u.id
     WHERE q.order_id = $1 OR q.inquiry_id = (SELECT inquiry_id FROM orders WHERE id = $1)
     ORDER BY q.created_at DESC`,
    [order.id]
  );

  const rawItems = await db.all('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC', [order.id]);
  order.items = await Promise.all(rawItems.map(async item => ({
    ...item,
    images: await db.all('SELECT * FROM order_item_images WHERE item_id = $1 ORDER BY created_at ASC', [item.id])
  })));

  order.order_drawings = await db.all(
    `SELECT od.*, u.name as uploaded_by_name
     FROM order_drawings od LEFT JOIN users u ON od.uploaded_by = u.id
     WHERE od.order_id = $1 ORDER BY od.created_at ASC`,
    [order.id]
  );

  order.job_cards = await db.all(
    `SELECT jc.*, u.name as uploaded_by_name
     FROM job_cards jc LEFT JOIN users u ON jc.uploaded_by = u.id
     WHERE jc.order_id = $1 ORDER BY jc.dispatch_date ASC`,
    [order.id]
  );

  order.activity = await db.all(
    `SELECT a.*, u.name as user_name, u.role as user_role
     FROM activity_log a LEFT JOIN users u ON a.created_by = u.id
     WHERE a.order_id = $1 ORDER BY a.created_at ASC`,
    [order.id]
  );

  res.json(order);
});

router.post('/', authenticate, authorize('admin', 'owner'), async (req, res) => {
  const { order_code, customer_id, inquiry_id, order_date, dispatch_date, notes, order_type } = req.body;
  if (!order_code || !customer_id || !order_date) return res.status(400).json({ error: 'Code, customer and date required' });

  const db = getDB();
  try {
    const r = await db.insert(
      `INSERT INTO orders (order_code, customer_id, inquiry_id, order_date, dispatch_date, notes, order_type, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [order_code.toUpperCase(), customer_id, inquiry_id||null, order_date, dispatch_date||null, notes||null, order_type||'local_he', req.user.id]
    // valid: local_he, export_he, inventory_order, io_export_he, io_local_he
    );

    await logActivity(r.lastInsertRowid, null, 'order_created', `Order ${order_code} submitted for approval`, req.user.id);

    if (inquiry_id) {
      await db.run("UPDATE inquiries SET status='order_received' WHERE id=$1", [inquiry_id]);
    }

    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('unique') || e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Order code already exists' });
    throw e;
  }
});

router.post('/:id/quotation', authenticate, authorize('admin', 'owner'), ...uploadQuotation, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File required' });
  const { notes, sent_date } = req.body;
  const db = getDB();
  const r = await db.insert(
    `INSERT INTO quotations (order_id, file_path, file_name, sent_date, notes, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [req.params.id, req.file.storagePath, req.file.filename, sent_date||null, notes||null, req.user.id]
  );
  await logActivity(req.params.id, null, 'quotation_uploaded', 'Quotation uploaded', req.user.id);
  res.status(201).json({ id: r.lastInsertRowid, file_name: req.file.filename });
});

router.get('/:id/items', authenticate, async (req, res) => {
  const items = await getDB().all('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC', [req.params.id]);
  // Attach inventory selections to each item
  for (const item of items) {
    item.inventory_items = await getDB().all(
      `SELECT ii.id, ii.item_code, ii.name, ii.unit, ii.category, oii.qty
       FROM order_item_inventory oii
       JOIN inventory_items ii ON ii.id = oii.inventory_item_id
       WHERE oii.order_item_id = $1`,
      [item.id]
    );
  }
  res.json(items);
});

router.post('/:id/items', authenticate, authorize('admin', 'owner'), async (req, res) => {
  const { product_code, drawing_number, tube_material, tube_diameter, wattage, voltage, plating_instructions, quantity, remark, inventory_item_ids } = req.body;
  if (!quantity) return res.status(400).json({ error: 'Quantity is required' });

  const db = getDB();
  const r = await db.insert(
    `INSERT INTO order_items (order_id, product_code, drawing_number, tube_material, tube_diameter, wattage, voltage, plating_instructions, quantity, remark)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [req.params.id, product_code||null, drawing_number||null, tube_material||null, tube_diameter||null,
     wattage||null, voltage||null, plating_instructions||null, quantity, remark||null]
  );
  const itemId = r.lastInsertRowid;
  // Save inventory selections (deduction happens only on order approval)
  if (Array.isArray(inventory_item_ids) && inventory_item_ids.length) {
    for (const { id: invId, qty: invQty } of inventory_item_ids) {
      await db.run(
        'INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [itemId, invId, invQty || 0]
      );
    }
  }
  res.status(201).json({ id: itemId });
});

router.put('/:id/items/:itemId', authenticate, authorize('admin', 'owner'), async (req, res) => {
  const { product_code, drawing_number, tube_material, tube_diameter, wattage, voltage, plating_instructions, quantity, remark, inventory_item_ids } = req.body;
  const db = getDB();
  await db.run(
    `UPDATE order_items SET product_code=$1, drawing_number=$2, tube_material=$3, tube_diameter=$4, wattage=$5,
       voltage=$6, plating_instructions=$7, quantity=$8, remark=$9
     WHERE id=$10 AND order_id=$11`,
    [product_code||null, drawing_number||null, tube_material||null, tube_diameter||null, wattage||null,
     voltage||null, plating_instructions||null, quantity, remark||null, req.params.itemId, req.params.id]
  );
  // Replace inventory selections (no stock movement — deduction happens only on order approval)
  await db.run('DELETE FROM order_item_inventory WHERE order_item_id=$1', [req.params.itemId]);
  if (Array.isArray(inventory_item_ids) && inventory_item_ids.length) {
    for (const { id: invId, qty: invQty } of inventory_item_ids) {
      await db.run(
        'INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [req.params.itemId, invId, invQty || 0]
      );
    }
  }
  res.json({ message: 'Updated' });
});

router.delete('/:id/items/:itemId', authenticate, authorize('admin', 'owner'), async (req, res) => {
  await getDB().run('DELETE FROM order_items WHERE id=$1 AND order_id=$2', [req.params.itemId, req.params.id]);
  res.json({ message: 'Deleted' });
});

router.post('/:orderId/items/:itemId/images', authenticate, authorize('admin', 'owner'), ...uploadOrderItemImage, async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'Files required' });
  const db = getDB();
  const inserted = [];
  for (const f of req.files) {
    const r = await db.insert(
      `INSERT INTO order_item_images (item_id, file_path, file_name, original_name, uploaded_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.params.itemId, f.storagePath, f.filename, f.originalname, req.user.id]
    );
    inserted.push({ id: r.lastInsertRowid, file_name: f.filename, original_name: f.originalname });
  }
  res.status(201).json(inserted);
});

router.delete('/:orderId/items/:itemId/images/:imageId', authenticate, authorize('admin', 'owner'), async (req, res) => {
  const db = getDB();
  const img = await db.get('SELECT * FROM order_item_images WHERE id=$1 AND item_id=$2', [req.params.imageId, req.params.itemId]);
  if (!img) return res.status(404).json({ error: 'Not found' });
  await deleteFromStorage(img.file_path);
  await db.run('DELETE FROM order_item_images WHERE id=$1', [req.params.imageId]);
  res.json({ message: 'Deleted' });
});

router.get('/:id/drawings', authenticate, async (req, res) => {
  res.json(await getDB().all(
    `SELECT od.*, u.name as uploaded_by_name
     FROM order_drawings od LEFT JOIN users u ON od.uploaded_by = u.id
     WHERE od.order_id = $1 ORDER BY od.created_at ASC`,
    [req.params.id]
  ));
});

router.post('/:id/drawings', authenticate, authorize('design', 'admin', 'owner'), ...uploadOrderDrawing, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File required' });
  const { notes } = req.body;
  const db = getDB();
  const r = await db.insert(
    `INSERT INTO order_drawings (order_id, file_path, file_name, original_name, notes, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [req.params.id, req.file.storagePath, req.file.filename, req.file.originalname, notes||null, req.user.id]
  );
  await logActivity(req.params.id, null, 'drawing_uploaded', `Reference drawing uploaded: ${req.file.originalname}`, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid, file_name: req.file.filename, original_name: req.file.originalname });
});

router.delete('/:id/drawings/:drawingId', authenticate, authorize('design', 'admin', 'owner'), async (req, res) => {
  const db = getDB();
  const d = await db.get('SELECT * FROM order_drawings WHERE id=$1 AND order_id=$2', [req.params.drawingId, req.params.id]);
  if (!d) return res.status(404).json({ error: 'Not found' });
  await deleteFromStorage(d.file_path);
  await db.run('DELETE FROM order_drawings WHERE id=$1', [req.params.drawingId]);
  res.json({ message: 'Deleted' });
});

router.get('/:id/messages', authenticate, async (req, res) => {
  res.json(await getDB().all(
    `SELECT om.*, u.name as user_name, u.role as user_role
     FROM order_messages om JOIN users u ON om.user_id = u.id
     WHERE om.order_id = $1 ORDER BY om.created_at ASC`,
    [req.params.id]
  ));
});

router.post('/:id/messages', authenticate, async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message cannot be empty' });
  const r = await getDB().insert(
    'INSERT INTO order_messages (order_id, user_id, message) VALUES ($1,$2,$3)',
    [req.params.id, req.user.id, message.trim()]
  );
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/:id/approve', authenticate, authorize('owner'), async (req, res) => {
  const db = getDB();

  // Guard: don't double-deduct if already approved
  const order = await db.get('SELECT status FROM orders WHERE id=$1', [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status === 'approved') return res.status(409).json({ error: 'Order already approved' });

  await db.run(
    "UPDATE orders SET status='approved', approved_by=$1, approved_at=NOW() WHERE id=$2",
    [req.user.id, req.params.id]
  );

  // Deduct inventory for all items in this order
  const items = await db.all('SELECT id FROM order_items WHERE order_id=$1', [req.params.id]);
  for (const item of items) {
    const invSelections = await db.all('SELECT * FROM order_item_inventory WHERE order_item_id=$1', [item.id]);
    for (const sel of invSelections) {
      const invItem = await db.get('SELECT * FROM inventory_items WHERE id=$1', [sel.inventory_item_id]);
      if (invItem) {
        const newStock = Math.max((invItem.current_stock || 0) - parseFloat(sel.qty || 0), 0);
        await db.run('UPDATE inventory_items SET current_stock=$1 WHERE id=$2', [newStock, sel.inventory_item_id]);
        await db.insert(
          `INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by)
           VALUES ($1,'dispatch_to_production',$2,$3,$4,$5)`,
          [sel.inventory_item_id, parseFloat(sel.qty || 0), newStock, `Dispatch to production — Order #${req.params.id}`, req.user.id]
        );
      }
    }
  }

  await logActivity(req.params.id, null, 'order_approved', 'Order approved by owner', req.user.id);
  res.json({ message: 'Order approved' });
});

router.put('/:id/reject', authenticate, authorize('owner'), async (req, res) => {
  const { reason } = req.body;
  const db = getDB();
  await db.run("UPDATE orders SET status='rejected', rejection_reason=$1 WHERE id=$2", [reason||null, req.params.id]);
  await logActivity(req.params.id, null, 'order_rejected', `Order rejected: ${reason || 'No reason given'}`, req.user.id);
  res.json({ message: 'Order rejected' });
});

router.put('/:id', authenticate, authorize('admin', 'owner'), async (req, res) => {
  const { notes } = req.body;
  await getDB().run('UPDATE orders SET notes=$1 WHERE id=$2', [notes||null, req.params.id]);
  res.json({ message: 'Updated' });
});

router.delete('/:id', authenticate, authorize('owner'), async (req, res) => {
  const db = getDB();
  const order = await db.get('SELECT id FROM orders WHERE id=$1', [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const jobCards = await db.all('SELECT * FROM job_cards WHERE order_id=$1', [order.id]);
  for (const jc of jobCards) {
    await db.run('DELETE FROM production_day_picks WHERE job_card_id=$1', [jc.id]);
    await db.run('DELETE FROM job_card_holds WHERE job_card_id=$1', [jc.id]);
    await db.run('DELETE FROM qc_reports WHERE job_card_id=$1', [jc.id]);
    await db.run('DELETE FROM package_photos WHERE job_card_id=$1', [jc.id]);
    await db.run('DELETE FROM dispatch_documents WHERE job_card_id=$1', [jc.id]);
    await db.run('DELETE FROM production_daily_reports WHERE job_card_id=$1', [jc.id]);
    await db.run('UPDATE inventory_transactions SET job_card_id=NULL WHERE job_card_id=$1', [jc.id]);
    await db.run('UPDATE drawings SET job_card_id=NULL WHERE job_card_id=$1', [jc.id]);
    await db.run('DELETE FROM job_card_assemblies WHERE job_card_id=$1', [jc.id]);
    await db.run('UPDATE activity_log SET job_card_id=NULL WHERE job_card_id=$1', [jc.id]);
    if (jc.file_path) await deleteFromStorage(jc.file_path);
    await db.run('DELETE FROM job_cards WHERE id=$1', [jc.id]);
  }

  const fullOrder = await db.get('SELECT status FROM orders WHERE id=$1', [order.id]);
  const items = await db.all('SELECT id FROM order_items WHERE order_id=$1', [order.id]);
  for (const item of items) {
    // If order was approved, reverse inventory deductions on delete
    if (fullOrder?.status === 'approved') {
      const invSelections = await db.all('SELECT * FROM order_item_inventory WHERE order_item_id=$1', [item.id]);
      for (const sel of invSelections) {
        const invItem = await db.get('SELECT * FROM inventory_items WHERE id=$1', [sel.inventory_item_id]);
        if (invItem) {
          const restoredStock = (invItem.current_stock || 0) + parseFloat(sel.qty || 0);
          await db.run('UPDATE inventory_items SET current_stock=$1 WHERE id=$2', [restoredStock, sel.inventory_item_id]);
          await db.insert(
            `INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by)
             VALUES ($1,'return_from_production',$2,$3,$4,$5)`,
            [sel.inventory_item_id, parseFloat(sel.qty || 0), restoredStock, `Order deleted — Order #${req.params.id}`, req.user.id]
          );
        }
      }
    }
    const images = await db.all('SELECT file_path FROM order_item_images WHERE item_id=$1', [item.id]);
    for (const img of images) await deleteFromStorage(img.file_path);
    await db.run('DELETE FROM order_item_images WHERE item_id=$1', [item.id]);
  }
  await db.run('DELETE FROM order_items WHERE order_id=$1', [order.id]);

  const quotations = await db.all('SELECT file_path FROM quotations WHERE order_id=$1', [order.id]);
  for (const q of quotations) await deleteFromStorage(q.file_path);
  await db.run('DELETE FROM quotations WHERE order_id=$1', [order.id]);

  const drawings = await db.all('SELECT file_path FROM order_drawings WHERE order_id=$1', [order.id]);
  for (const d of drawings) await deleteFromStorage(d.file_path);
  await db.run('DELETE FROM order_drawings WHERE order_id=$1', [order.id]);

  await db.run('DELETE FROM order_messages WHERE order_id=$1', [order.id]);
  await db.run('UPDATE activity_log SET order_id=NULL WHERE order_id=$1', [order.id]);
  await db.run('DELETE FROM orders WHERE id=$1', [order.id]);
  res.json({ message: 'Order deleted' });
});

router.get('/:orderId/inquiries', authenticate, async (req, res) => {
  res.json(await getDB().all(
    'SELECT * FROM inquiries WHERE id = (SELECT inquiry_id FROM orders WHERE id=$1)',
    [req.params.orderId]
  ));
});

router.post('/inquiries', authenticate, authorize('admin', 'owner'), async (req, res) => {
  const { inquiry_code, customer_id, description, is_custom_design, notes } = req.body;
  if (!inquiry_code || !customer_id) return res.status(400).json({ error: 'Code and customer required' });
  try {
    const r = await getDB().insert(
      `INSERT INTO inquiries (inquiry_code, customer_id, description, is_custom_design, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [inquiry_code.toUpperCase(), customer_id, description||null, is_custom_design ? 1 : 0, notes||null, req.user.id]
    );
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('unique') || e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Inquiry code already exists' });
    throw e;
  }
});

router.get('/inquiries/all', authenticate, authorize('admin', 'owner'), async (req, res) => {
  res.json(await getDB().all(
    `SELECT i.*, c.customer_code, c.name as customer_name
     FROM inquiries i JOIN customers c ON i.customer_id = c.id
     ORDER BY i.created_at DESC`
  ));
});

router.post('/inquiries/:id/quotation', authenticate, authorize('admin', 'owner'), ...uploadQuotation, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File required' });
  const { notes, sent_date } = req.body;
  const db = getDB();
  const r = await db.insert(
    `INSERT INTO quotations (inquiry_id, file_path, file_name, sent_date, notes, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [req.params.id, req.file.storagePath, req.file.filename, sent_date||null, notes||null, req.user.id]
  );
  await db.run("UPDATE inquiries SET status='quotation_sent' WHERE id=$1", [req.params.id]);
  res.status(201).json({ id: r.lastInsertRowid, file_name: req.file.filename });
});

module.exports = router;
