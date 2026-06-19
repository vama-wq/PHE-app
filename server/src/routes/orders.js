const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize, withCustomerVisibility } = require('../middleware/auth');
const { uploadQuotation, uploadOrderDrawing, uploadOrderItemImage, uploadChatAttachments, deleteFromStorage } = require('../middleware/upload');
const { createNotification } = require('./notifications');

// ── Mentions ──────────────────────────────────────────────────────────────────
router.get('/my-mentions', authenticate, async (req, res) => {
  const db = getDB();
  const orderMentions = await db.all(
    `SELECT mm.id, mm.is_read, mm.created_at,
            om.message, om.user_id as sender_id,
            u.name as sender_name, u.role as sender_role,
            o.id as order_id, o.order_code,
            'order' as source, NULL as query_id, NULL as query_no
     FROM message_mentions mm
     JOIN order_messages om ON om.id = mm.message_id
     JOIN users u ON u.id = om.user_id
     JOIN orders o ON o.id = mm.order_id
     WHERE mm.mentioned_user_id = $1
     ORDER BY mm.created_at DESC
     LIMIT 50`,
    [req.user.id]
  );
  const queryMentions = await db.all(
    `SELECT cqm.id, cqm.is_read, cqm.created_at,
            m.message, m.user_id as sender_id,
            u.name as sender_name, u.role as sender_role,
            NULL as order_id, NULL as order_code,
            'query' as source, cq.id as query_id, cq.query_no
     FROM customer_query_mentions cqm
     JOIN customer_query_messages m ON m.id = cqm.message_id
     JOIN users u ON u.id = m.user_id
     JOIN customer_queries cq ON cq.id = cqm.query_id
     WHERE cqm.mentioned_user_id = $1
     ORDER BY cqm.created_at DESC
     LIMIT 50`,
    [req.user.id]
  );
  const all = [...orderMentions, ...queryMentions]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 50);
  res.json(all);
});

router.put('/my-mentions/:id/read', authenticate, async (req, res) => {
  const { source } = req.query;
  if (source === 'query') {
    await getDB().run(
      'UPDATE customer_query_mentions SET is_read=1 WHERE id=$1 AND mentioned_user_id=$2',
      [req.params.id, req.user.id]
    );
  } else {
    await getDB().run(
      'UPDATE message_mentions SET is_read=1 WHERE id=$1 AND mentioned_user_id=$2',
      [req.params.id, req.user.id]
    );
  }
  res.json({ message: 'Marked as read' });
});

router.put('/my-mentions/read-all', authenticate, async (req, res) => {
  const db = getDB();
  await db.run('UPDATE message_mentions SET is_read=1 WHERE mentioned_user_id=$1', [req.user.id]);
  await db.run('UPDATE customer_query_mentions SET is_read=1 WHERE mentioned_user_id=$1', [req.user.id]);
  res.json({ message: 'All marked as read' });
});

// ── Next order code ───────────────────────────────────────────────────────────
router.get('/next-code', authenticate, async (req, res) => {
  const db = getDB();
  const yy = String(new Date().getFullYear()).slice(-2);
  const prefix = `ORD-`;
  const suffix = `-${yy}`;
  // Find the highest sequence number used this year
  const rows = await db.all(
    `SELECT order_code FROM orders WHERE order_code LIKE $1`,
    [`ORD-%-${yy}`]
  );
  let max = 0;
  for (const row of rows) {
    const match = row.order_code.match(/^ORD-(\d+)-\d{2}$/i);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > max) max = n;
    }
  }
  const next = String(max + 1).padStart(3, '0');
  res.json({ code: `${prefix}${next}${suffix}` });
});

// ── Drawings pending status (for sidebar badge + drawings page) ───────────────
router.get('/drawings/pending', authenticate, async (req, res) => {
  const db = getDB();
  const rows = await db.all(`
    SELECT
      o.id, o.order_code, o.status, o.drawing_status, o.drawing_rejection_reason,
      o.created_at, o.order_date,
      c.customer_code, c.name AS customer_name,
      u.name AS created_by_name,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
      (SELECT COUNT(*) FROM order_drawings od WHERE od.order_id = o.id) AS drawing_count,
      (SELECT json_agg(json_build_object('id', od2.id, 'file_name', od2.file_name,
              'original_name', od2.original_name, 'notes', od2.notes, 'item_id', od2.item_id,
              'drawing_status', od2.drawing_status, 'rejection_reason', od2.rejection_reason,
              'created_at', od2.created_at, 'uploaded_by_name', u2.name))
       FROM order_drawings od2
       LEFT JOIN users u2 ON u2.id = od2.uploaded_by
       WHERE od2.order_id = o.id) AS drawings,
      (SELECT json_agg(json_build_object('id', oi3.id, 'drawing_number', oi3.drawing_number,
              'product_code', oi3.product_code, 'quantity', oi3.quantity,
              'tube_material', oi3.tube_material, 'wattage', oi3.wattage, 'voltage', oi3.voltage))
       FROM order_items oi3 WHERE oi3.order_id = o.id) AS items
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN users u ON u.id = o.created_by
    WHERE o.status NOT IN ('pending_approval', 'rejected', 'dispatched', 'resolved_dispatched')
      AND NOT (
        -- Hide orders that have job cards AND every item already has a drawing
        EXISTS (SELECT 1 FROM job_cards jc WHERE jc.order_id = o.id)
        AND (SELECT COUNT(*) FROM order_items oi2 WHERE oi2.order_id = o.id) > 0
        AND NOT EXISTS (
          SELECT 1 FROM order_items oi
          WHERE oi.order_id = o.id
            AND NOT EXISTS (
              SELECT 1 FROM order_drawings od WHERE od.order_id = o.id AND od.item_id = oi.id
            )
        )
      )
    ORDER BY o.created_at DESC
  `);
  res.json(rows);
});

router.get('/', authenticate, async (req, res) => {
  const db = getDB();
  const canSeeNames = withCustomerVisibility(req);
  const orders = await db.all(
    `SELECT o.*, c.customer_code,
       ${canSeeNames ? 'c.name as customer_name,' : ''}
       u.name as created_by_name,
       jc.job_card_no, jc.id as job_card_id, jc.status as card_status,
       (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as item_count,
       (SELECT string_agg(DISTINCT oi2.product_code, ', ') FROM order_items oi2 WHERE oi2.order_id = o.id AND oi2.product_code IS NOT NULL AND oi2.product_code != '') as product_codes
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

  const priceReq = await db.get(
    `SELECT id FROM activity_log WHERE order_id = $1 AND activity_type = 'price_requested' ORDER BY created_at DESC LIMIT 1`,
    [order.id]
  );
  order.has_price_request = !!priceReq;

  const rawItems = await db.all('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC', [order.id]);
  order.items = await Promise.all(rawItems.map(async item => ({
    ...item,
    images: await db.all('SELECT * FROM order_item_images WHERE item_id = $1 ORDER BY created_at ASC', [item.id])
  })));

  order.order_drawings = await db.all(
    `SELECT od.*, u.name as uploaded_by_name, oi.drawing_number as item_drawing_number
     FROM order_drawings od
     LEFT JOIN users u ON od.uploaded_by = u.id
     LEFT JOIN order_items oi ON oi.id = od.item_id
     WHERE od.order_id = $1 ORDER BY od.item_id NULLS LAST, od.created_at ASC`,
    [order.id]
  );
  // Compute per-item drawing status for easy UI consumption
  // item_drawing_status: map of item_id → 'approved'|'pending_review'|'rejected'|null
  const itemDrawingMap = {};
  for (const d of order.order_drawings) {
    if (!d.item_id) continue;
    const existing = itemDrawingMap[d.item_id];
    // If any drawing for this item is approved, the item is approved
    // Otherwise worst status wins: rejected > pending_review > null
    if (!existing || d.drawing_status === 'approved' ||
        (d.drawing_status === 'pending_review' && existing !== 'approved') ||
        (d.drawing_status === 'rejected' && !['approved','pending_review'].includes(existing))) {
      itemDrawingMap[d.item_id] = d.drawing_status || null;
    }
  }
  order.item_drawing_status = itemDrawingMap;

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
  const { notes, sent_date } = req.body;
  const db = getDB();

  if (!req.file) {
    const priceReq = await db.get(
      `SELECT id FROM activity_log WHERE order_id = $1 AND activity_type = 'price_requested' LIMIT 1`,
      [req.params.id]
    );
    if (!priceReq) return res.status(400).json({ error: 'File required' });
    if (!notes || !notes.trim()) return res.status(400).json({ error: 'Price note is required when no file is attached' });
  }

  const r = await db.insert(
    `INSERT INTO quotations (order_id, file_path, file_name, sent_date, notes, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [req.params.id, req.file?.storagePath || null, req.file?.filename || null, sent_date||null, notes||null, req.user.id]
  );
  await logActivity(req.params.id, null, 'quotation_uploaded', 'Quotation uploaded', req.user.id);
  res.status(201).json({ id: r.lastInsertRowid, file_name: req.file?.filename || null });
});

router.put('/:id/quotation/:qid', authenticate, authorize('owner'), async (req, res) => {
  const { notes } = req.body;
  const db = getDB();
  const q = await db.get('SELECT * FROM quotations WHERE id=$1 AND order_id=$2', [req.params.qid, req.params.id]);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  await db.run('UPDATE quotations SET notes=$1 WHERE id=$2', [notes || null, req.params.qid]);
  res.json({ message: 'Updated' });
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
  const { notes, item_id } = req.body;
  const db = getDB();
  const r = await db.insert(
    `INSERT INTO order_drawings (order_id, item_id, file_path, file_name, original_name, notes, uploaded_by, drawing_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending_review')`,
    [req.params.id, item_id ? parseInt(item_id) : null, req.file.storagePath, req.file.filename, req.file.originalname, notes||null, req.user.id]
  );
  await logActivity(req.params.id, null, 'drawing_uploaded', `Reference drawing uploaded: ${req.file.originalname}`, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid, file_name: req.file.filename, original_name: req.file.originalname });
});

// ── Drawing review: owner approves or rejects individual drawings ──────────────
router.put('/:id/drawings/:drawingId/approve', authenticate, authorize('owner'), async (req, res) => {
  const db = getDB();
  const d = await db.get('SELECT * FROM order_drawings WHERE id=$1 AND order_id=$2', [req.params.drawingId, req.params.id]);
  if (!d) return res.status(404).json({ error: 'Drawing not found' });
  await db.run(`UPDATE order_drawings SET drawing_status='approved', rejection_reason=NULL WHERE id=$1`, [req.params.drawingId]);
  await logActivity(req.params.id, null, 'drawing_approved', `Drawing approved: ${d.original_name || d.file_name}`, req.user.id);
  res.json({ message: 'Drawing approved' });
});

router.put('/:id/drawings/:drawingId/reject', authenticate, authorize('owner'), async (req, res) => {
  const { reason } = req.body;
  if (!reason?.trim()) return res.status(400).json({ error: 'Rejection reason is required' });
  const db = getDB();
  const d = await db.get('SELECT * FROM order_drawings WHERE id=$1 AND order_id=$2', [req.params.drawingId, req.params.id]);
  if (!d) return res.status(404).json({ error: 'Drawing not found' });
  await db.run(`UPDATE order_drawings SET drawing_status='rejected', rejection_reason=$1 WHERE id=$2`, [reason.trim(), req.params.drawingId]);
  await logActivity(req.params.id, null, 'drawing_rejected', `Drawing rejected: ${reason}`, req.user.id);
  res.json({ message: 'Drawing rejected' });
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
  const db = getDB();
  const messages = await db.all(
    `SELECT om.*, u.name as user_name, u.role as user_role
     FROM order_messages om JOIN users u ON om.user_id = u.id
     WHERE om.order_id = $1 ORDER BY om.created_at ASC`,
    [req.params.id]
  );
  for (const msg of messages) {
    msg.attachments = await db.all(
      'SELECT id, file_path, file_name, file_size, mime_type FROM message_attachments WHERE message_id = $1',
      [msg.id]
    );
  }
  res.json(messages);
});

router.post('/:id/messages', authenticate, ...uploadChatAttachments, async (req, res) => {
  const { message } = req.body;
  let mentionIds = req.body.mentionIds;
  if (typeof mentionIds === 'string') try { mentionIds = JSON.parse(mentionIds); } catch { mentionIds = []; }
  const hasFiles = req.files?.length > 0;
  if (!message?.trim() && !hasFiles) return res.status(400).json({ error: 'Message or attachment required' });
  const db = getDB();
  const r = await db.insert(
    'INSERT INTO order_messages (order_id, user_id, message) VALUES ($1,$2,$3)',
    [req.params.id, req.user.id, (message || '').trim()]
  );
  const messageId = r.lastInsertRowid;

  if (hasFiles) {
    for (const f of req.files) {
      await db.insert(
        'INSERT INTO message_attachments (message_id, file_path, file_name, file_size, mime_type) VALUES ($1,$2,$3,$4,$5)',
        [messageId, f.storagePath, f.originalname, f.size, f.mimetype]
      );
    }
  }

  // Insert mentions using client-supplied user IDs (avoids regex parsing of names with spaces/slashes)
  if (Array.isArray(mentionIds) && mentionIds.length) {
    for (const userId of mentionIds) {
      if (userId !== req.user.id) {
        await db.run(
          'INSERT INTO message_mentions (message_id, order_id, mentioned_user_id) VALUES ($1,$2,$3)',
          [messageId, req.params.id, userId]
        );
      }
    }
  }

  if (Array.isArray(mentionIds) && mentionIds.length) {
    const order = await db.get('SELECT order_code FROM orders WHERE id=$1', [req.params.id]);
    const orderCode = order?.order_code || `Order #${req.params.id}`;
    const preview = (message || '').trim().slice(0, 100);
    const fileNote = hasFiles ? ` [+${req.files.length} file${req.files.length > 1 ? 's' : ''}]` : '';
    for (const userId of mentionIds) {
      if (userId !== req.user.id) {
        await createNotification(db, {
          userId,
          type: 'order_message',
          title: `${req.user.name} in ${orderCode}`,
          body: preview ? preview + fileNote : `Sent${fileNote}`,
          link: `/orders/${req.params.id}`,
          sourceUserId: req.user.id,
        });
      }
    }
  }

  res.status(201).json({ id: messageId });
});

router.put('/:id/approve', authenticate, authorize('owner'), async (req, res) => {
  const db = getDB();

  // Guard: don't double-deduct if already approved
  const order = await db.get('SELECT status FROM orders WHERE id=$1', [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status === 'approved') return res.status(409).json({ error: 'Order already approved' });

  // No drawing gate here — order is approved first, then design uploads drawings per item
  await db.run(
    "UPDATE orders SET status='approved', approved_by=$1, approved_at=NOW() WHERE id=$2",
    [req.user.id, req.params.id]
  );

  // Deduct inventory for all items in this order
  const orderInfo = await db.get('SELECT order_code FROM orders WHERE id=$1', [req.params.id]);
  const items = await db.all('SELECT id, drawing_number FROM order_items WHERE order_id=$1', [req.params.id]);
  for (const item of items) {
    const invSelections = await db.all('SELECT * FROM order_item_inventory WHERE order_item_id=$1', [item.id]);
    for (const sel of invSelections) {
      const invItem = await db.get('SELECT * FROM inventory_items WHERE id=$1', [sel.inventory_item_id]);
      if (invItem) {
        const newStock = Math.max((invItem.current_stock || 0) - parseFloat(sel.qty || 0), 0);
        await db.run('UPDATE inventory_items SET current_stock=$1 WHERE id=$2', [newStock, sel.inventory_item_id]);
        const noteParts = [`Order: ${orderInfo?.order_code || req.params.id}`];
        if (item.drawing_number) noteParts.push(`Dwg: ${item.drawing_number}`);
        await db.insert(
          `INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by)
           VALUES ($1,'dispatch_to_production',$2,$3,$4,$5)`,
          [sel.inventory_item_id, parseFloat(sel.qty || 0), newStock, noteParts.join(' | '), req.user.id]
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

router.put('/:id', authenticate, authorize('admin', 'owner', 'accounts'), async (req, res) => {
  const db = getDB();
  const order = await db.get('SELECT status FROM orders WHERE id=$1', [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.status === 'rejected') {
    const { dispatch_date, notes, order_type } = req.body;
    const sets = ['notes = $1'];
    const params = [notes || null];
    let idx = 2;
    if (dispatch_date !== undefined) { sets.push(`dispatch_date = $${idx}`); params.push(dispatch_date || null); idx++; }
    if (order_type !== undefined) { sets.push(`order_type = $${idx}`); params.push(order_type); idx++; }
    params.push(req.params.id);
    await db.run(`UPDATE orders SET ${sets.join(', ')} WHERE id = $${idx}`, params);
  } else {
    const { notes } = req.body;
    await db.run('UPDATE orders SET notes=$1 WHERE id=$2', [notes || null, req.params.id]);
  }
  res.json({ message: 'Updated' });
});

router.put('/:id/resubmit', authenticate, authorize('admin', 'owner', 'accounts'), async (req, res) => {
  const db = getDB();
  const order = await db.get('SELECT id, status, order_code FROM orders WHERE id=$1', [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'rejected') return res.status(400).json({ error: 'Only rejected orders can be resubmitted' });
  await db.run("UPDATE orders SET status='pending_approval', rejection_reason=NULL WHERE id=$1", [req.params.id]);
  await logActivity(req.params.id, null, 'order_resubmitted', `Order resubmitted for approval`, req.user.id);
  const owners = await db.all("SELECT id FROM users WHERE role='owner' AND id != $1", [req.user.id]);
  for (const o of owners) {
    await createNotification(db, {
      userId: o.id,
      type: 'order_message',
      title: `${order.order_code} resubmitted`,
      body: `${req.user.name} resubmitted order for approval`,
      link: `/orders/${req.params.id}`,
      sourceUserId: req.user.id,
    });
  }
  res.json({ message: 'Order resubmitted for approval' });
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

  const fullOrder = await db.get('SELECT order_code FROM orders WHERE id=$1', [order.id]);
  const items = await db.all('SELECT id FROM order_items WHERE order_id=$1', [order.id]);
  for (const item of items) {
    // Always reverse any inventory that was deducted for this order
    const invSelections = await db.all('SELECT * FROM order_item_inventory WHERE order_item_id=$1', [item.id]);
    for (const sel of invSelections) {
      const invItem = await db.get('SELECT * FROM inventory_items WHERE id=$1', [sel.inventory_item_id]);
      if (invItem) {
        const restoredStock = (invItem.current_stock || 0) + parseFloat(sel.qty || 0);
        await db.run('UPDATE inventory_items SET current_stock=$1 WHERE id=$2', [restoredStock, sel.inventory_item_id]);
        await db.insert(
          `INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by)
           VALUES ($1,'return_from_production',$2,$3,$4,$5)`,
          [sel.inventory_item_id, parseFloat(sel.qty || 0), restoredStock, `Order deleted — ${fullOrder?.order_code || 'Order #' + req.params.id}`, req.user.id]
        );
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
