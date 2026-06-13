const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize, withCustomerVisibility } = require('../middleware/auth');
const { uploadToStorage, deleteFromStorage, uploadChatAttachments } = require('../middleware/upload');
const multer = require('multer');

const memStorage = multer.memoryStorage();
const imageFilter = (req, file, cb) => {
  const ext = file.originalname.toLowerCase().split('.').pop();
  /jpg|jpeg|png|gif|webp|pdf/.test(ext) ? cb(null, true) : cb(new Error('Only images and PDFs allowed'));
};
const upload = multer({ storage: memStorage, fileFilter: imageFilter, limits: { fileSize: 10 * 1024 * 1024 } });

// Generate query number: CQ-YYYYMMDD-XXXX
async function genQueryNo(db) {
  const prefix = `CQ-${new Date().toISOString().slice(0,10).replace(/-/g,'')}`;
  const last = await db.get(
    "SELECT query_no FROM customer_queries WHERE query_no LIKE $1 ORDER BY id DESC LIMIT 1",
    [`${prefix}%`]
  );
  const seq = last ? (parseInt(last.query_no.split('-').pop(), 10) + 1) : 1;
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}

// ── List all queries (with filters) ─────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  const { status, order_id, assigned_department } = req.query;
  const canSeeName = withCustomerVisibility(req);
  let sql = `
    SELECT cq.*, o.order_code, c.customer_code,
           ${canSeeName ? "c.name as customer_name," : ''}
           jc.job_card_no, jc.drawing_no, jc.product_name,
           u.name as created_by_name,
           ru.name as resolved_by_name,
           (SELECT COUNT(*) FROM customer_query_messages WHERE query_id = cq.id) as message_count,
           (SELECT COUNT(*) FROM customer_query_photos WHERE query_id = cq.id) as photo_count
    FROM customer_queries cq
    JOIN orders o ON cq.order_id = o.id
    JOIN customers c ON o.customer_id = c.id
    LEFT JOIN job_cards jc ON cq.job_card_id = jc.id
    LEFT JOIN users u ON cq.created_by = u.id
    LEFT JOIN users ru ON cq.resolved_by = ru.id
    WHERE 1=1
  `;
  const params = [];
  if (status) { params.push(status); sql += ` AND cq.status = $${params.length}`; }
  if (order_id) { params.push(order_id); sql += ` AND cq.order_id = $${params.length}`; }
  if (assigned_department) { params.push(assigned_department); sql += ` AND cq.assigned_department = $${params.length}`; }
  sql += ` ORDER BY cq.created_at DESC`;
  res.json(await getDB().all(sql, params));
});

// ── Get users list (for mentions) ──────────────────────────────────────────
router.get('/users/list', authenticate, async (req, res) => {
  const users = await getDB().all('SELECT id, name, role FROM users ORDER BY name');
  res.json(users);
});

// ── Get unread mentions for current user ────────────────────────────────────
router.get('/mentions/unread', authenticate, async (req, res) => {
  const mentions = await getDB().all(`
    SELECT cqm.id, cqm.is_read, cqm.created_at,
           m.message, m.user_id as sender_id,
           u.name as sender_name, u.role as sender_role,
           cq.id as query_id, cq.query_no, cq.subject
    FROM customer_query_mentions cqm
    JOIN customer_query_messages m ON m.id = cqm.message_id
    JOIN users u ON u.id = m.user_id
    JOIN customer_queries cq ON cq.id = cqm.query_id
    WHERE cqm.mentioned_user_id = $1 AND cqm.is_read = 0
    ORDER BY cqm.created_at DESC
    LIMIT 50
  `, [req.user.id]);
  res.json(mentions);
});

router.put('/mentions/:mentionId/read', authenticate, async (req, res) => {
  await getDB().run(
    'UPDATE customer_query_mentions SET is_read=1 WHERE id=$1 AND mentioned_user_id=$2',
    [req.params.mentionId, req.user.id]
  );
  res.json({ message: 'Marked as read' });
});

// ── Get queries for a specific order ────────────────────────────────────────
router.get('/order/:orderId', authenticate, async (req, res) => {
  const queries = await getDB().all(`
    SELECT cq.*, u.name as created_by_name,
           (SELECT COUNT(*) FROM customer_query_messages WHERE query_id = cq.id) as message_count
    FROM customer_queries cq
    LEFT JOIN users u ON cq.created_by = u.id
    WHERE cq.order_id = $1
    ORDER BY cq.created_at DESC
  `, [req.params.orderId]);
  res.json(queries);
});

// ── Get single query with all details (must be AFTER static /order, /mentions, /users routes) ──
router.get('/:id', authenticate, async (req, res) => {
  const db = getDB();
  const canSeeName = withCustomerVisibility(req);
  const q = await db.get(`
    SELECT cq.*, o.order_code, o.order_type, o.dispatch_date as order_dispatch_date,
           c.customer_code,
           ${canSeeName ? "c.name as customer_name," : ''}
           jc.job_card_no, jc.drawing_no, jc.product_name, jc.qty as jc_qty, jc.status as jc_status,
           u.name as created_by_name, u.role as created_by_role,
           ru.name as resolved_by_name
    FROM customer_queries cq
    JOIN orders o ON cq.order_id = o.id
    JOIN customers c ON o.customer_id = c.id
    LEFT JOIN job_cards jc ON cq.job_card_id = jc.id
    LEFT JOIN users u ON cq.created_by = u.id
    LEFT JOIN users ru ON cq.resolved_by = ru.id
    WHERE cq.id = $1
  `, [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Query not found' });
  res.json(q);
});

// ── Create a new customer query ────────────────────────────────────────────
router.post('/', authenticate, authorize('accounts', 'owner', 'admin'), async (req, res) => {
  const { order_id, job_card_id, subject, description, category, priority, assigned_department } = req.body;
  if (!order_id) return res.status(400).json({ error: 'Order ID is required' });
  if (!subject?.trim()) return res.status(400).json({ error: 'Subject is required' });
  if (!assigned_department) return res.status(400).json({ error: 'Assigned department is required' });

  const db = getDB();

  // Verify order exists and is dispatched
  const order = await db.get('SELECT * FROM orders WHERE id=$1', [order_id]);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const queryNo = await genQueryNo(db);
  const r = await db.insert(`
    INSERT INTO customer_queries (query_no, order_id, job_card_id, subject, description, category, priority, assigned_department, status, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9)
  `, [queryNo, order_id, job_card_id || null, subject.trim(), description || null,
      category || 'general', priority || 'medium', assigned_department, req.user.id]);

  // Update order status to customer_query
  await db.run("UPDATE orders SET status='customer_query' WHERE id=$1", [order_id]);

  // If job card specified, update its status too
  if (job_card_id) {
    await db.run("UPDATE job_cards SET status='customer_query' WHERE id=$1", [job_card_id]);
  }

  await logActivity(order_id, job_card_id || null, 'customer_query_raised',
    `Customer query raised: ${queryNo} — ${subject.trim()}`, req.user.id);

  res.status(201).json({ id: r.lastInsertRowid, query_no: queryNo });
});

// ── Upload photos to a query ─────────────────────────────────────────────
router.post('/:id/photos', authenticate, upload.array('photos', 10), async (req, res) => {
  const db = getDB();
  const q = await db.get('SELECT id FROM customer_queries WHERE id=$1', [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Query not found' });

  if (!req.files?.length) return res.status(400).json({ error: 'No photos uploaded' });

  const uploaded = [];
  for (const f of req.files) {
    const ts = Date.now();
    const safe = f.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const filename = `${ts}_${safe}`;
    const storagePath = await uploadToStorage('query-photos', filename, f.buffer, f.mimetype);
    const r = await db.insert(
      'INSERT INTO customer_query_photos (query_id, file_path, file_name, caption, uploaded_by) VALUES ($1,$2,$3,$4,$5)',
      [req.params.id, storagePath, filename, req.body.caption || null, req.user.id]
    );
    uploaded.push({ id: r.lastInsertRowid, file_name: filename, file_path: storagePath });
  }
  res.status(201).json(uploaded);
});

// ── Get photos for a query ─────────────────────────────────────────────────
router.get('/:id/photos', authenticate, async (req, res) => {
  res.json(await getDB().all(
    'SELECT qp.*, u.name as uploaded_by_name FROM customer_query_photos qp LEFT JOIN users u ON qp.uploaded_by = u.id WHERE qp.query_id = $1 ORDER BY qp.created_at ASC',
    [req.params.id]
  ));
});

// ── Delete a photo ──────────────────────────────────────────────────────────
router.delete('/:id/photos/:photoId', authenticate, async (req, res) => {
  const db = getDB();
  const photo = await db.get('SELECT * FROM customer_query_photos WHERE id=$1 AND query_id=$2', [req.params.photoId, req.params.id]);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  if (photo.file_path) await deleteFromStorage(photo.file_path);
  await db.run('DELETE FROM customer_query_photos WHERE id=$1', [req.params.photoId]);
  res.json({ message: 'Deleted' });
});

// ── Chat messages ──────────────────────────────────────────────────────────
router.get('/:id/messages', authenticate, async (req, res) => {
  const db = getDB();
  const messages = await db.all(
    `SELECT m.*, u.name as user_name, u.role as user_role
     FROM customer_query_messages m JOIN users u ON m.user_id = u.id
     WHERE m.query_id = $1 ORDER BY m.created_at ASC`,
    [req.params.id]
  );
  for (const msg of messages) {
    msg.attachments = await db.all(
      'SELECT id, file_path, file_name, file_size, mime_type FROM customer_query_message_attachments WHERE message_id = $1',
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

  const q = await db.get('SELECT id, query_no FROM customer_queries WHERE id=$1', [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Query not found' });

  const r = await db.insert(
    'INSERT INTO customer_query_messages (query_id, user_id, message) VALUES ($1,$2,$3)',
    [req.params.id, req.user.id, (message || '').trim()]
  );
  const messageId = r.lastInsertRowid;

  if (hasFiles) {
    for (const f of req.files) {
      await db.insert(
        'INSERT INTO customer_query_message_attachments (message_id, file_path, file_name, file_size, mime_type) VALUES ($1,$2,$3,$4,$5)',
        [messageId, f.storagePath, f.originalname, f.size, f.mimetype]
      );
    }
  }

  // Insert mentions
  if (Array.isArray(mentionIds) && mentionIds.length) {
    for (const userId of mentionIds) {
      if (userId !== req.user.id) {
        await db.run(
          'INSERT INTO customer_query_mentions (message_id, query_id, mentioned_user_id) VALUES ($1,$2,$3)',
          [messageId, req.params.id, userId]
        );
      }
    }
  }

  // Mark query as in_progress if it was open
  await db.run("UPDATE customer_queries SET status='in_progress', updated_at=NOW() WHERE id=$1 AND status='open'", [req.params.id]);

  res.status(201).json({ id: messageId });
});

// mentions routes moved above /:id

// ── Update query (status, assign dept, priority) ────────────────────────────
router.put('/:id', authenticate, authorize('accounts', 'owner', 'admin'), async (req, res) => {
  const { assigned_department, priority, category, description } = req.body;
  const db = getDB();
  const q = await db.get('SELECT * FROM customer_queries WHERE id=$1', [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Query not found' });

  const updates = [];
  const params = [];
  if (assigned_department !== undefined) { params.push(assigned_department); updates.push(`assigned_department=$${params.length}`); }
  if (priority !== undefined) { params.push(priority); updates.push(`priority=$${params.length}`); }
  if (category !== undefined) { params.push(category); updates.push(`category=$${params.length}`); }
  if (description !== undefined) { params.push(description); updates.push(`description=$${params.length}`); }
  updates.push('updated_at=NOW()');

  if (updates.length > 1) {
    params.push(req.params.id);
    await db.run(`UPDATE customer_queries SET ${updates.join(',')} WHERE id=$${params.length}`, params);
  }
  res.json({ message: 'Updated' });
});

// ── Resolve query (OWNER ONLY) ─────────────────────────────────────────────
router.put('/:id/resolve', authenticate, authorize('owner'), async (req, res) => {
  const { resolution_summary, resolution_type } = req.body;
  // resolution_type: 'resolved' or 'product_return'
  if (!resolution_summary?.trim()) return res.status(400).json({ error: 'Resolution summary is required' });
  if (!['resolved', 'product_return'].includes(resolution_type)) {
    return res.status(400).json({ error: 'Resolution type must be "resolved" or "product_return"' });
  }

  const db = getDB();
  const q = await db.get('SELECT * FROM customer_queries WHERE id=$1', [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Query not found' });
  if (q.status === 'resolved') return res.status(400).json({ error: 'Query is already resolved' });

  if (resolution_type === 'resolved') {
    // Mark query resolved, order goes to resolved_dispatched (Query Resolved)
    await db.run(`
      UPDATE customer_queries SET status='resolved', resolution_summary=$1,
        resolved_by=$2, resolved_at=NOW(), updated_at=NOW() WHERE id=$3
    `, [resolution_summary.trim(), req.user.id, req.params.id]);

    await db.run("UPDATE orders SET status='resolved_dispatched' WHERE id=$1", [q.order_id]);
    if (q.job_card_id) {
      await db.run("UPDATE job_cards SET status='resolved_dispatched' WHERE id=$1", [q.job_card_id]);
    }

    await logActivity(q.order_id, q.job_card_id, 'customer_query_resolved',
      `Query ${q.query_no} resolved: ${resolution_summary.trim()}`, req.user.id);

    return res.json({ message: 'Query resolved' });
  }

  // Product return path
  await db.run(`
    UPDATE customer_queries SET status='product_return', resolution_summary=$1,
      resolved_by=$2, resolved_at=NOW(), return_status='pending_return', updated_at=NOW() WHERE id=$3
  `, [resolution_summary.trim(), req.user.id, req.params.id]);

  await db.run("UPDATE orders SET status='product_return' WHERE id=$1", [q.order_id]);
  if (q.job_card_id) {
    await db.run("UPDATE job_cards SET status='product_return' WHERE id=$1", [q.job_card_id]);
  }

  await logActivity(q.order_id, q.job_card_id, 'product_return_initiated',
    `Product return initiated for query ${q.query_no}: ${resolution_summary.trim()}`, req.user.id);

  res.json({ message: 'Product return initiated' });
});

// ── Set return type (repair or debit_note) — OWNER ONLY ────────────────────
router.put('/:id/return-type', authenticate, authorize('owner'), async (req, res) => {
  const { return_type, return_coupon_no } = req.body;
  if (!['repair', 'debit_note'].includes(return_type)) {
    return res.status(400).json({ error: 'Return type must be "repair" or "debit_note"' });
  }

  const db = getDB();
  const q = await db.get('SELECT * FROM customer_queries WHERE id=$1', [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Query not found' });
  if (q.status !== 'product_return') return res.status(400).json({ error: 'Query must be in product_return status' });

  // Set the return type but stay at pending_return — user must confirm material received next
  await db.run(`
    UPDATE customer_queries SET return_type=$1, return_coupon_no=$2,
      return_status='pending_return', updated_at=NOW() WHERE id=$3
  `, [return_type, return_coupon_no || null, req.params.id]);

  await logActivity(q.order_id, q.job_card_id, 'return_type_set',
    `Return type set to ${return_type} for ${q.query_no} — coupon: ${return_coupon_no || 'N/A'}. Awaiting material return.`, req.user.id);

  res.json({ message: `Return type set to ${return_type}. Mark material as received when product arrives.` });
});

// ── Add debit note number ──────────────────────────────────────────────────
router.put('/:id/debit-note', authenticate, authorize('accounts', 'owner'), async (req, res) => {
  const { debit_note_no } = req.body;
  if (!debit_note_no?.trim()) return res.status(400).json({ error: 'Debit note number is required' });

  const db = getDB();
  const q = await db.get('SELECT * FROM customer_queries WHERE id=$1', [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Query not found' });

  await db.run(`
    UPDATE customer_queries SET debit_note_no=$1, updated_at=NOW() WHERE id=$2
  `, [debit_note_no.trim(), req.params.id]);

  await logActivity(q.order_id, q.job_card_id, 'debit_note_added',
    `Debit note ${debit_note_no.trim()} added for query ${q.query_no}`, req.user.id);

  res.json({ message: 'Debit note added' });
});

// ── Mark material as received — triggers QC or production based on return_type ──
router.put('/:id/material-received', authenticate, authorize('accounts', 'owner', 'admin'), async (req, res) => {
  const db = getDB();
  const q = await db.get('SELECT * FROM customer_queries WHERE id=$1', [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Query not found' });
  if (q.return_status !== 'pending_return') {
    return res.status(400).json({ error: 'Query must be in pending_return status' });
  }
  if (!q.return_type) {
    return res.status(400).json({ error: 'Return type must be set first' });
  }

  if (q.return_type === 'repair') {
    // Send to production for repair
    if (q.job_card_id) {
      await db.run("UPDATE production_checklist SET done=0, done_at=NULL WHERE job_card_id=$1", [q.job_card_id]);
      await db.run("UPDATE job_cards SET status='repair_in_progress' WHERE id=$1", [q.job_card_id]);
    }
    await db.run(`UPDATE customer_queries SET return_status='in_repair', updated_at=NOW() WHERE id=$1`, [req.params.id]);
    await logActivity(q.order_id, q.job_card_id, 'material_received',
      `Material received for ${q.query_no}. Sent to production for repair.`, req.user.id);
    return res.json({ message: 'Material received — sent to production for repair' });
  }

  // Debit note path — send to QC
  if (q.job_card_id) {
    await db.run("UPDATE job_cards SET status='qc_pending' WHERE id=$1", [q.job_card_id]);
  }
  await db.run(`UPDATE customer_queries SET return_status='qc_check', updated_at=NOW() WHERE id=$1`, [req.params.id]);
  await logActivity(q.order_id, q.job_card_id, 'material_received',
    `Material received for ${q.query_no}. Sent to QC for inspection (debit note return).`, req.user.id);
  res.json({ message: 'Material received — sent to QC for inspection' });
});

// ── QC check result for returned product ────────────────────────────────────
router.put('/:id/qc-result', authenticate, authorize('design', 'owner', 'admin'), async (req, res) => {
  const { result } = req.body; // 'pass' or 'fail'
  if (!['pass', 'fail'].includes(result)) {
    return res.status(400).json({ error: 'Result must be "pass" or "fail"' });
  }

  const db = getDB();
  const q = await db.get('SELECT * FROM customer_queries WHERE id=$1', [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Query not found' });
  if (q.return_status !== 'qc_check') return res.status(400).json({ error: 'Query must be in QC check status' });

  if (result === 'pass') {
    // QC pass — add to finished goods with 'return from customer' tag
    await db.run(`UPDATE customer_queries SET return_status='qc_pass', updated_at=NOW() WHERE id=$1`, [req.params.id]);

    // Get job card info for finished goods entry
    if (q.job_card_id) {
      const jc = await db.get(`
        SELECT jc.*, o.order_code, o.order_type, c.customer_code, c.name as customer_name
        FROM job_cards jc
        JOIN orders o ON jc.order_id = o.id
        JOIN customers c ON o.customer_id = c.id
        WHERE jc.id = $1
      `, [q.job_card_id]);

      if (jc) {
        const baseNo = jc.drawing_no ? jc.drawing_no.replace(/-\d+$/, '') : null;
        const existing = baseNo
          ? await db.get('SELECT id FROM finished_goods WHERE base_drawing_no=$1 LIMIT 1', [baseNo])
          : null;

        if (existing) {
          await db.run('UPDATE finished_goods SET qty_in=qty_in+$1, qty_available=qty_available+$1 WHERE id=$2',
            [jc.qty || 1, existing.id]);
          await db.insert(
            `INSERT INTO finished_goods_log (finished_good_id, movement_type, qty, job_card_no, order_code, customer_code, reference, notes, created_by)
             VALUES ($1,'inward',$2,$3,$4,$5,$6,$7,$8)`,
            [existing.id, jc.qty || 1, jc.job_card_no, jc.order_code, jc.customer_code,
             q.return_coupon_no || q.query_no, `Return from customer — QC passed — Coupon: ${q.return_coupon_no || 'N/A'}`, req.user.id]
          );
        } else {
          const asm = await db.get('SELECT * FROM job_card_assemblies WHERE job_card_id=$1 LIMIT 1', [q.job_card_id]);
          const fg = await db.insert(`
            INSERT INTO finished_goods (job_card_id, order_id, order_code, order_type, customer_code, customer_name,
              drawing_no, base_drawing_no, tube_material, tube_diameter, wattage, voltage,
              qty_in, qty_available, notes, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$15)
          `, [jc.id, jc.order_id, jc.order_code, jc.order_type, jc.customer_code, jc.customer_name,
              jc.drawing_no, baseNo, asm?.tube_material||null, asm?.tube_diameter_mm||null,
              asm?.wattage_actual||null, asm?.voltage_actual||null,
              jc.qty || 1, `Return from customer — QC passed — Coupon: ${q.return_coupon_no || 'N/A'}`, req.user.id]);
          await db.insert(
            `INSERT INTO finished_goods_log (finished_good_id, movement_type, qty, job_card_no, order_code, customer_code, reference, notes, created_by)
             VALUES ($1,'inward',$2,$3,$4,$5,$6,$7,$8)`,
            [fg.lastInsertRowid, jc.qty || 1, jc.job_card_no, jc.order_code, jc.customer_code,
             q.return_coupon_no || q.query_no, `Return from customer — QC passed — Coupon: ${q.return_coupon_no || 'N/A'}`, req.user.id]
          );
        }
        await db.run("UPDATE job_cards SET status='completed' WHERE id=$1", [q.job_card_id]);
      }
    }

    await logActivity(q.order_id, q.job_card_id, 'return_qc_pass',
      `Returned product QC passed — added to finished goods. Coupon: ${q.return_coupon_no || 'N/A'}`, req.user.id);
    return res.json({ message: 'QC passed — added to finished goods' });
  }

  // QC fail — send back to production for repair
  await db.run(`UPDATE customer_queries SET return_status='qc_fail', updated_at=NOW() WHERE id=$1`, [req.params.id]);

  if (q.job_card_id) {
    await db.run("UPDATE production_checklist SET done=0, done_at=NULL WHERE job_card_id=$1", [q.job_card_id]);
    await db.run("UPDATE job_cards SET status='repair_in_progress' WHERE id=$1", [q.job_card_id]);
  }

  await logActivity(q.order_id, q.job_card_id, 'return_qc_fail',
    `Returned product QC failed — sent back to production for repair`, req.user.id);

  res.json({ message: 'QC failed — sent to production for repair' });
});

// ── Mark repair complete & dispatch ─────────────────────────────────────────
router.put('/:id/repair-complete', authenticate, authorize('owner', 'accounts'), async (req, res) => {
  const { shipping_carrier, tracking_number } = req.body;
  const db = getDB();
  const q = await db.get('SELECT * FROM customer_queries WHERE id=$1', [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Query not found' });

  await db.run(`
    UPDATE customer_queries SET return_status='repaired_dispatched', status='resolved', updated_at=NOW() WHERE id=$1
  `, [req.params.id]);

  if (q.job_card_id) {
    await db.run("UPDATE job_cards SET status='repaired_dispatched' WHERE id=$1", [q.job_card_id]);
  }
  await db.run("UPDATE orders SET status='dispatched' WHERE id=$1", [q.order_id]);

  await logActivity(q.order_id, q.job_card_id, 'repair_dispatched',
    `Repaired product dispatched — ${shipping_carrier || 'carrier'}, tracking: ${tracking_number || 'N/A'}`, req.user.id);

  res.json({ message: 'Repair complete — dispatched' });
});

// ── Debit note complete ─────────────────────────────────────────────────────
router.put('/:id/debit-note-complete', authenticate, authorize('owner', 'accounts'), async (req, res) => {
  const db = getDB();
  const q = await db.get('SELECT * FROM customer_queries WHERE id=$1', [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Query not found' });

  await db.run(`
    UPDATE customer_queries SET return_status='debit_note_issued', status='resolved', updated_at=NOW() WHERE id=$1
  `, [req.params.id]);

  await db.run("UPDATE orders SET status='dispatched' WHERE id=$1", [q.order_id]);
  if (q.job_card_id) {
    await db.run("UPDATE job_cards SET status='dispatched' WHERE id=$1", [q.job_card_id]);
  }

  await logActivity(q.order_id, q.job_card_id, 'debit_note_issued',
    `Debit note ${q.debit_note_no || 'N/A'} issued for return ${q.query_no}`, req.user.id);

  res.json({ message: 'Debit note process complete' });
});

// ── Full order timeline / summary ───────────────────────────────────────────
router.get('/order/:orderId/timeline', authenticate, async (req, res) => {
  const db = getDB();
  const orderId = req.params.orderId;
  const canSeeName = withCustomerVisibility(req);

  // Get order info
  const order = await db.get(`
    SELECT o.*, c.customer_code ${canSeeName ? ", c.name as customer_name" : ''}
    FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.id=$1
  `, [orderId]);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  // Get all items
  const items = await db.all('SELECT * FROM order_items WHERE order_id=$1 ORDER BY id', [orderId]);

  // Get drawings
  const drawings = await db.all(`
    SELECT od.*, u.name as uploaded_by_name FROM order_drawings od
    LEFT JOIN users u ON od.uploaded_by = u.id WHERE od.order_id=$1 ORDER BY od.created_at
  `, [orderId]);

  // Get job cards with their checklist and QC info
  const jobCards = await db.all(`
    SELECT jc.*, u.name as uploaded_by_name
    FROM job_cards jc LEFT JOIN users u ON jc.uploaded_by = u.id
    WHERE jc.order_id=$1 ORDER BY jc.created_at
  `, [orderId]);

  for (const jc of jobCards) {
    jc.checklist = await db.all('SELECT * FROM production_checklist WHERE job_card_id=$1 ORDER BY stage_no', [jc.id]);
    jc.qcReports = await db.all(`
      SELECT qr.*, u.name as created_by_name FROM qc_reports qr
      LEFT JOIN users u ON qr.created_by = u.id WHERE qr.job_card_id=$1 ORDER BY qr.created_at
    `, [jc.id]);
    jc.dispatchDocs = await db.all('SELECT * FROM dispatch_documents WHERE job_card_id=$1 ORDER BY created_at', [jc.id]);
  }

  // Get customer queries
  const queries = await db.all(`
    SELECT cq.*, u.name as created_by_name
    FROM customer_queries cq LEFT JOIN users u ON cq.created_by = u.id
    WHERE cq.order_id=$1 ORDER BY cq.created_at
  `, [orderId]);

  // Get activity log
  const activity = await db.all(`
    SELECT al.*, u.name as created_by_name FROM activity_log al
    LEFT JOIN users u ON al.created_by = u.id
    WHERE al.order_id=$1 ORDER BY al.created_at ASC
  `, [orderId]);

  res.json({ order, items, drawings, jobCards, queries, activity });
});

// users list route moved above /:id

module.exports = router;
