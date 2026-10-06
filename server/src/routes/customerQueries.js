const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { syncOrderStatus } = require('./jobCards');
const { authenticate, authorize, withCustomerVisibility } = require('../middleware/auth');
const { uploadToStorage, deleteFromStorage, uploadChatAttachments, uploadJobCard } = require('../middleware/upload');
const { createNotification } = require('./notifications');
const { postQueryMessage } = require('../services/actions/customerQueries');
const { cloneChildCard, readyStageFor } = require('../lib/childCard');
const { clientDb } = require('../lib/bomCorrection');
const { rescaleAfterSplit } = require('../lib/terminals');
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

// Next return coupon: RET-NNN, one past the highest number already used.
// Numbered by hand until now, which is how RET-001 ended up on two returns and
// RET-003 on none — so the number is read off the ledger, not off memory. Any
// coupon whose tail is a number counts, whatever prefix it was written with.
async function nextReturnCoupon(db) {
  const rows = await db.all(
    "SELECT return_coupon_no AS c FROM customer_queries WHERE return_coupon_no ~ '[0-9]+$'");
  const highest = rows.reduce((m, r) => Math.max(m, parseInt(String(r.c).match(/(\d+)$/)[1], 10)), 0);
  return `RET-${String(highest + 1).padStart(3, '0')}`;
}

// ── The next free return coupon number (to prefill the form) ────────────────
router.get('/next-return-coupon', authenticate, authorize('accounts', 'owner', 'admin'), async (req, res) => {
  res.json({ next: await nextReturnCoupon(getDB()) });
});

// ── List all queries (with filters) ─────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  const { status, order_id, assigned_department } = req.query;
  const canSeeName = withCustomerVisibility(req);
  let sql = `
    SELECT cq.*, o.order_code, c.customer_code,
           ${canSeeName ? "c.name as customer_name," : ''}
           jc.job_card_no, jc.drawing_no, jc.product_name,
           pjc.job_card_no as parent_job_card_no,
           u.name as created_by_name,
           ru.name as resolved_by_name,
           (SELECT COUNT(*) FROM customer_query_messages WHERE query_id = cq.id) as message_count,
           (SELECT COUNT(*) FROM customer_query_photos WHERE query_id = cq.id) as photo_count
    FROM customer_queries cq
    JOIN orders o ON cq.order_id = o.id
    JOIN customers c ON o.customer_id = c.id
    LEFT JOIN job_cards jc ON cq.job_card_id = jc.id
    -- The card the pieces were cut off (a -Q card's parent): "3 of 50 pcs of JC-123"
    LEFT JOIN job_cards pjc ON pjc.id = jc.parent_job_card_id AND cq.split_job_card_id = jc.id
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
    SELECT cq.*, u.name as created_by_name, jc.job_card_no, pjc.job_card_no as parent_job_card_no,
           (SELECT COUNT(*) FROM customer_query_messages WHERE query_id = cq.id) as message_count
    FROM customer_queries cq
    LEFT JOIN users u ON cq.created_by = u.id
    LEFT JOIN job_cards jc ON jc.id = cq.job_card_id
    LEFT JOIN job_cards pjc ON pjc.id = jc.parent_job_card_id AND cq.split_job_card_id = jc.id
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
           pjc.id as parent_job_card_id, pjc.job_card_no as parent_job_card_no,
           u.name as created_by_name, u.role as created_by_role,
           ru.name as resolved_by_name
    FROM customer_queries cq
    JOIN orders o ON cq.order_id = o.id
    JOIN customers c ON o.customer_id = c.id
    LEFT JOIN job_cards jc ON cq.job_card_id = jc.id
    LEFT JOIN job_cards pjc ON pjc.id = jc.parent_job_card_id AND cq.split_job_card_id = jc.id
    LEFT JOIN users u ON cq.created_by = u.id
    LEFT JOIN users ru ON cq.resolved_by = ru.id
    WHERE cq.id = $1
  `, [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Query not found' });
  res.json(q);
});

// ── Create a new customer query ────────────────────────────────────────────
// A query names the pieces that came back, not the whole card (owner, 6 Oct
// 2026: "out of 50 nos only 3 are coming back for repair, return or
// replacement"). When fewer than all of a card's dispatched pieces are
// affected, those pieces are split off into their own card <orig>-Q<n> and the
// query is tied to THAT card, so everything downstream — repair, debit-note
// return to Finished Goods, replacement — works on 3 pieces, not 50. The owner
// may also give the -Q card a different job card document / product name /
// drawing no ("just in case they were wrong completely"), which is why this
// route takes multipart like POST /job-cards; plain JSON still works.

// The pieces a card sent out: what QC routed to dispatch, or the card's qty
// for a card dispatched before QC routing existed.
const piecesOut = (jc) => (Number(jc.qc_dispatch_qty) > 0 ? Number(jc.qc_dispatch_qty) : Number(jc.qty) || 0);
// Queries are for pieces at the customer — a card still on the floor has none.
// Decided by STATUS: a card once dispatched keeps its dispatched_at even after
// a query brought it back for repair, and pieces in the repair batch on the
// floor are not at the customer (they are already under a query).
const WENT_OUT = ['dispatched', 'resolved_dispatched', 'repaired_dispatched'];
const wentOut = (jc) => WENT_OUT.includes(jc.status);
// Timeline lines written INSIDE the split's transaction, so they go only if the
// split does (db.logActivity writes through the pool and would survive a rollback).
const logInTx = (tx, orderId, jobCardId, type, text, userId) => tx.run(
  `INSERT INTO activity_log (order_id, job_card_id, activity_type, description, created_by) VALUES ($1,$2,$3,$4,$5)`,
  [orderId || null, jobCardId || null, type, text, userId || null]);

router.post('/', authenticate, authorize('accounts', 'owner', 'admin'), ...uploadJobCard, async (req, res) => {
  const { order_id, job_card_id, subject, description, category, priority, assigned_department } = req.body;
  if (!order_id) return res.status(400).json({ error: 'Order ID is required' });
  if (!subject?.trim()) return res.status(400).json({ error: 'Subject is required' });
  if (!assigned_department) return res.status(400).json({ error: 'Assigned department is required' });

  const db = getDB();

  // Verify order exists and is dispatched
  const order = await db.get('SELECT * FROM orders WHERE id=$1', [order_id]);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  // Pieces affected — required when a job card is named. Whole number from 1
  // to the pieces that went out on that card; left blank = all of them.
  let jc = null, qty = null, pieces = null;
  if (job_card_id) {
    jc = await db.get('SELECT * FROM job_cards WHERE id=$1', [job_card_id]);
    if (!jc) return res.status(404).json({ error: 'Job card not found' });
    if (!wentOut(jc)) {
      return res.status(400).json({ error: `${jc.job_card_no} has not been dispatched — a customer query is for pieces that went out.` });
    }
    pieces = piecesOut(jc);
    const raw = req.body.qty;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      qty = pieces;
    } else {
      if (!/^\d+$/.test(String(raw).trim())) {
        return res.status(400).json({ error: 'Pieces affected must be a whole number' });
      }
      qty = parseInt(String(raw).trim(), 10);
      if (qty < 1 || qty > pieces) {
        return res.status(400).json({ error: `Pieces affected must be between 1 and ${pieces} — ${jc.job_card_no} sent out ${pieces} pcs.` });
      }
    }
  }

  // A different document / product name / drawing no is for the split-off
  // pieces only: with every piece affected there is no new card to put them
  // on, and the original card is corrected from its own screen, not from here.
  const newName = typeof req.body.product_name === 'string' && req.body.product_name.trim() !== ''
    && req.body.product_name.trim() !== (jc?.product_name || '') ? req.body.product_name.trim() : null;
  const newDrawing = typeof req.body.drawing_no === 'string' && req.body.drawing_no.trim() !== ''
    && req.body.drawing_no.trim() !== (jc?.drawing_no || '') ? req.body.drawing_no.trim() : null;
  const corrections = !!(req.file || newName || newDrawing);
  if (corrections && !(jc && qty < pieces)) {
    return res.status(400).json({
      error: jc
        ? 'A different job card document, product name or drawing no applies only when fewer than all the pieces are affected — edit the job card itself otherwise.'
        : 'A different job card document, product name or drawing no needs a job card on the query.',
    });
  }

  let made;
  try {
    made = await db.withTransaction(async (client) => {
      const tx = clientDb(client);
      const queryNo = await genQueryNo(tx);
      let cardId = jc?.id || null, splitId = null, childNo = null, piecesNow = pieces;

      if (jc) {
        // Lock the card so its pieces cannot change under us (a second query
        // or a split approving at the same moment) before we re-check and cut.
        const parent = (await client.query('SELECT * FROM job_cards WHERE id=$1 FOR UPDATE', [jc.id])).rows[0];
        if (!parent) throw Object.assign(new Error('Job card not found'), { status: 404 });
        piecesNow = piecesOut(parent);
        if (qty > piecesNow) {
          throw Object.assign(new Error(`Pieces affected must be between 1 and ${piecesNow} — ${parent.job_card_no} sent out ${piecesNow} pcs.`), { status: 400 });
        }

        if (qty < piecesNow) {
          // Only some pieces came back: they get their own card. Numbered
          // -Q1, -Q2… by the -Q children already cut off this card.
          const kids = await tx.all('SELECT job_card_no FROM job_cards WHERE parent_job_card_id=$1', [parent.id]);
          const n = kids.filter(k => String(k.job_card_no).startsWith(`${parent.job_card_no}-Q`)).length + 1;
          childNo = `${parent.job_card_no}-Q${n}`;

          const changed = [];
          if (req.file) changed.push(`job card document ${req.file.originalname}`);
          if (newName) changed.push(`product name "${parent.product_name || '—'}" → "${newName}"`);
          if (newDrawing) changed.push(`drawing no "${parent.drawing_no || '—'}" → "${newDrawing}"`);

          splitId = await cloneChildCard(tx, parent, {
            childNo, qty, status: 'customer_query',
            notes: `Customer query ${queryNo}: ${qty} of ${parent.job_card_no} affected`,
            // The pieces were finished and went out, so the Ready-for-Dispatch row travels with them
            copyReadyStage: true,
            columns: {
              // The pieces DID go out — the -Q card still counts as dispatched,
              // with the whole of its quantity routed to dispatch and none to FG.
              dispatched_at: parent.dispatched_at, qc_route: parent.qc_route,
              qc_dispatch_qty: qty, qc_fg_qty: 0,
              // Made and settled on the parent: fins were drawn, both QCs were
              // passed, plating was done — the -Q card must not ask for any of
              // it again. (Tube/coil/fill/last-stage flags come with the clone.)
              fins_deducted: parent.fins_deducted || false,
              product_qc_at: parent.product_qc_at, product_qc_by: parent.product_qc_by,
              inventory_qc_at: parent.inventory_qc_at, inventory_qc_by: parent.inventory_qc_by,
              plating_status: parent.plating_status,
              // The owner's corrections, when given, replace the parent's
              ...(req.file ? { file_path: req.file.storagePath, file_name: req.file.filename, original_name: req.file.originalname } : {}),
              ...(newName ? { product_name: newName } : {}),
              ...(newDrawing ? { drawing_no: newDrawing } : {}),
            },
          });
          cardId = splitId;

          // The parent keeps the rest and stays dispatched — those pieces are
          // fine and with the customer. Its qty never drops below 1, its
          // dispatched count never below 0.
          await tx.run(
            `UPDATE job_cards SET qty = GREATEST(1, qty - $1),
                    qc_dispatch_qty = CASE WHEN qc_dispatch_qty IS NULL THEN NULL ELSE GREATEST(0, qc_dispatch_qty - $1) END
              WHERE id=$2`, [qty, parent.id]);
          // The Ready-for-Dispatch row carries its own dispatched count, which
          // the dispatch list, the job card page and the Excel export read
          // ahead of qc_dispatch_qty for a dispatched card — so the parent's
          // count comes down by the pieces that left it and the -Q card's
          // copied row says how many it carries. Otherwise the parent keeps
          // showing "50 dispatched" against a 47-piece card.
          const readyStage = readyStageFor(parent);
          await tx.run(
            `UPDATE production_checklist SET dispatched_qty = GREATEST(0, dispatched_qty - $1)
              WHERE job_card_id=$2 AND stage_no=$3 AND dispatched_qty IS NOT NULL`, [qty, parent.id, readyStage]);
          await tx.run(
            `UPDATE production_checklist SET dispatched_qty = $1 WHERE job_card_id=$2 AND stage_no=$3`,
            [qty, splitId, readyStage]);
          // Terminal pins: a dispatched card is past pins, and rescaleAfterSplit
          // leaves a card with a last-stage take alone; only an older card with
          // no take has rows to scale. Stock: NOTHING moves on a query split —
          // the pieces were made and their material was taken on the parent.
          await rescaleAfterSplit(tx, parent.id, parent.qty, parent.qty - qty, req.user.id);

          await logInTx(tx, parent.order_id, parent.id, 'customer_query_split',
            `${qty} of this card raised as query ${queryNo} → ${childNo}`, req.user.id);
          await logInTx(tx, parent.order_id, splitId, 'customer_query_split',
            `${childNo}: ${qty} of ${parent.job_card_no} (${piecesNow} sent out) raised as query ${queryNo}`
            + (changed.length ? `. Changed on this card: ${changed.join('; ')}` : ''), req.user.id);
        } else {
          // Every piece affected: the card itself carries the query, as before
          await tx.run("UPDATE job_cards SET status='customer_query' WHERE id=$1", [parent.id]);
        }
      }

      const r = await tx.insert(`
        INSERT INTO customer_queries (query_no, order_id, job_card_id, subject, description, category, priority, assigned_department, status, created_by,
                                      qty, qty_of, split_job_card_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11,$12)
      `, [queryNo, order_id, cardId, subject.trim(), description || null,
          category || 'general', priority || 'medium', assigned_department, req.user.id,
          qty, piecesNow, splitId]);

      // Update order status to customer_query
      await tx.run("UPDATE orders SET status='customer_query' WHERE id=$1", [order_id]);

      await logInTx(tx, order_id, cardId, 'customer_query_raised',
        `Customer query raised: ${queryNo} — ${subject.trim()}`
        + (jc ? ` (${qty} of ${piecesNow} pcs${childNo ? `, as ${childNo}` : ''})` : ''), req.user.id);

      return { id: r.lastInsertRowid, queryNo, cardId, splitId, childNo, qty, piecesNow };
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Customer query create failed:', err);
    return res.status(500).json({ error: 'Could not raise the query — please try again' });
  }

  // A production-site failure reached the customer — a CAPA must be completed
  // (and owner-approved) before any repair work starts. It sits on the card the
  // query is tied to: the -Q card when the pieces were split off.
  if (made.cardId) {
    const { ensureCapa } = require('./capa');
    await ensureCapa(db, {
      jobCardId: made.cardId, orderId: order_id, triggerType: 'customer_query',
      customerQueryId: made.id, userId: req.user.id,
    });
  }

  res.status(201).json({
    id: made.id, query_no: made.queryNo, job_card_id: made.cardId,
    qty: made.qty, qty_of: made.piecesNow,
    split_job_card_id: made.splitId, split_job_card_no: made.childNo,
  });
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
  // The work itself lives in services/actions/customerQueries.js, shared with
  // the WhatsApp reply dispatcher.
  try {
    const { message } = req.body;
    let mentionIds = req.body.mentionIds;
    if (typeof mentionIds === 'string') try { mentionIds = JSON.parse(mentionIds); } catch { mentionIds = []; }
    const hasFiles = req.files?.length > 0;
    const text = message == null ? '' : String(message);
    if (!text.trim() && !hasFiles) return res.status(400).json({ error: 'Message or attachment required' });

    const result = await postQueryMessage(getDB(), {
      queryId: req.params.id, actor: req.user, message: text, mentionIds,
      attachments: req.files || [], via: 'app',
    });
    if (result.ok) return res.status(201).json({ id: result.data.id });
    if (result.code === 'not_found') return res.status(404).json({ error: 'Query not found' });
    if (result.code === 'forbidden') return res.status(403).json({ error: 'Access denied' });
    return res.status(400).json({ error: result.message });
  } catch (err) {
    console.error('Customer query message failed:', err);
    res.status(500).json({ error: 'Could not post the message — please try again' });
  }
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
router.put('/:id/resolve', authenticate, authorize('owner'), ...uploadJobCard, async (req, res) => {
  const { resolution_summary, resolution_type } = req.body;
  // resolution_type: 'resolved', 'product_return' or 'replaced' (no return —
  // a replacement production run starts immediately)
  if (!resolution_summary?.trim()) return res.status(400).json({ error: 'Resolution summary is required' });
  if (!['resolved', 'product_return', 'replaced'].includes(resolution_type)) {
    return res.status(400).json({ error: 'Resolution type must be "resolved", "product_return" or "replaced"' });
  }

  const db = getDB();
  const q = await db.get('SELECT * FROM customer_queries WHERE id=$1', [req.params.id]);
  if (!q) return res.status(404).json({ error: 'Query not found' });
  if (q.status === 'resolved') return res.status(400).json({ error: 'Query is already resolved' });

  if (resolution_type === 'replaced') {
    // Replace without waiting for the product to come back: clone the original
    // job card into a fresh production run (empty checklist), tagged with the
    // query. The original card's lifecycle is closed as resolved.
    if (!q.job_card_id) return res.status(400).json({ error: 'This query has no job card to replace' });
    const orig = await db.get('SELECT * FROM job_cards WHERE id=$1', [q.job_card_id]);
    if (!orig) return res.status(400).json({ error: 'Original job card not found' });

    const base = `${orig.job_card_no}-RPL`;
    const dup = await db.get('SELECT COUNT(*) AS n FROM job_cards WHERE job_card_no LIKE $1', [`${base}%`]);
    const jobCardNo = parseInt(dup.n, 10) > 0 ? `${base}${parseInt(dup.n, 10) + 1}` : base;

    // Keep the original target date if it is still ahead; otherwise a week out
    const dispatchDate = (orig.dispatch_date && new Date(orig.dispatch_date) > new Date())
      ? orig.dispatch_date
      : new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

    // Owner chose either to keep the original job card document or upload a new one
    const filePath = req.file?.storagePath || orig.file_path;
    const fileName = req.file?.filename || orig.file_name;
    const originalName = req.file?.originalname || orig.original_name;
    const r = await db.insert(
      `INSERT INTO job_cards (job_card_no, order_id, file_path, file_name, original_name, qty, dispatch_date,
         notes, punching, drawing_no, product_name, uploaded_by, order_item_id, replacement_query_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [jobCardNo, orig.order_id, filePath, fileName, originalName, orig.qty, dispatchDate,
       `Replacement for query ${q.query_no} — ${resolution_summary.trim()}`,
       orig.punching, orig.drawing_no, orig.product_name, req.user.id, orig.order_item_id, q.id]
    );

    // Straight into today's production work
    try {
      await db.run('INSERT INTO production_day_picks (pick_date, job_card_id, picked_by) VALUES ($1,$2,$3)',
        [new Date().toISOString().split('T')[0], r.lastInsertRowid, req.user.id]);
    } catch (e) { if (e.code !== '23505') console.error('replacement pick failed:', e.message); }

    await db.run(`
      UPDATE customer_queries SET status='resolved', resolution_summary=$1, return_status='replacement_issued',
        resolved_by=$2, resolved_at=NOW(), updated_at=NOW() WHERE id=$3
    `, [resolution_summary.trim(), req.user.id, req.params.id]);
    await db.run("UPDATE job_cards SET status='resolved_dispatched' WHERE id=$1", [q.job_card_id]);
    await db.run("UPDATE orders SET status='in_progress' WHERE id=$1", [q.order_id]);

    await logActivity(q.order_id, r.lastInsertRowid, 'replacement_issued',
      `Replacement issued for query ${q.query_no} — new job card ${jobCardNo} sent to production`, req.user.id);

    try {
      const prodUsers = await db.all("SELECT id FROM users WHERE role='production'");
      for (const u of prodUsers) {
        await createNotification(db, {
          userId: u.id, type: 'replacement_issued', title: `Replacement job card — ${jobCardNo}`,
          body: `Query ${q.query_no}: produce a replacement (${orig.qty} pcs, ${orig.drawing_no || orig.product_name || ''}). Already in Today's Work.`,
          link: `/job-cards/${r.lastInsertRowid}`, sourceUserId: req.user.id,
        });
      }
    } catch (_) { /* notifications are best-effort */ }

    return res.json({ message: `Replacement job card ${jobCardNo} created and sent to production`, job_card_id: r.lastInsertRowid });
  }

  if (resolution_type === 'resolved') {
    // Mark query resolved, order goes to resolved_dispatched (Query Resolved)
    await db.run(`
      UPDATE customer_queries SET status='resolved', resolution_summary=$1,
        resolved_by=$2, resolved_at=NOW(), updated_at=NOW() WHERE id=$3
    `, [resolution_summary.trim(), req.user.id, req.params.id]);

    await db.run("UPDATE orders SET status='resolved_dispatched' WHERE id=$1", [q.order_id]);
    if (q.job_card_id) {
      await db.run("UPDATE job_cards SET status='resolved_dispatched', dispatched_at=NOW() WHERE id=$1", [q.job_card_id]);
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

  // Left blank, the next number is taken off the ledger. Typed in, it is checked
  // against the coupons already issued — two returns sharing a number is what
  // made these hard to track in the first place.
  let coupon = (return_coupon_no || '').trim();
  if (!coupon) {
    coupon = await nextReturnCoupon(db);
  } else {
    const clash = await db.get(
      'SELECT query_no FROM customer_queries WHERE UPPER(return_coupon_no)=UPPER($1) AND id<>$2',
      [coupon, req.params.id]);
    if (clash) {
      return res.status(400).json({
        error: `Coupon ${coupon} is already on ${clash.query_no}. The next free number is ${await nextReturnCoupon(db)}.`,
      });
    }
  }

  // Set the return type but stay at pending_return — user must confirm material received next
  await db.run(`
    UPDATE customer_queries SET return_type=$1, return_coupon_no=$2,
      return_status='pending_return', updated_at=NOW() WHERE id=$3
  `, [return_type, coupon, req.params.id]);

  await logActivity(q.order_id, q.job_card_id, 'return_type_set',
    `Return type set to ${return_type} for ${q.query_no} — coupon: ${coupon}. Awaiting material return.`, req.user.id);

  res.json({ message: `Return type set to ${return_type} — coupon ${coupon}. Mark material as received when product arrives.`, return_coupon_no: coupon });
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
    // The CAPA on this card must be owner-approved before repair work starts —
    // the cause has to be understood before the rework happens.
    if (q.job_card_id) {
      const { activeCapaFor } = require('./capa');
      const capa = await activeCapaFor(db, q.job_card_id);
      if (capa) {
        return res.status(400).json({
          error: capa.status === 'awaiting_approval'
            ? 'The CAPA report is awaiting owner approval — approve it before starting the repair.'
            : 'A CAPA report must be completed and approved before repair work can start.',
          code: 'CAPA_REQUIRED', capa_id: capa.id,
        });
      }
    }
    // Send to production for repair, restarting at the stage the repair
    // actually begins from. Everything BEFORE that stage stays done — the work
    // is still good and must not be redone. From that stage on the ticks are
    // cleared so the work is done again, but the recorded values (readings,
    // weights, worker) are left in place so production can see what was there
    // last time. Default 1 = redo the whole card, the old behaviour.
    const raw = parseInt(req.body?.repair_from_stage, 10);
    const fromStage = Number.isInteger(raw) && raw >= 1 ? raw : 1;
    if (q.job_card_id) {
      // Stage 30 (Kharoch) is numbered out of band but runs between Bending
      // (14) and Brazing (15), so it must follow its POSITION, not its number:
      // reopen it only when the repair restarts at or before Bending.
      await db.run(
        `UPDATE production_checklist SET done=0, done_at=NULL
          WHERE job_card_id=$1 AND ((stage_no >= $2 AND stage_no < 30) OR (stage_no = 30 AND $2 <= 14))`,
        [q.job_card_id, fromStage]);
      // current_stage is the LAST COMPLETED stage, so recompute it from what
      // is still ticked rather than assuming.
      const maxDone = await db.get(
        'SELECT MAX(stage_no) AS m FROM production_checklist WHERE job_card_id=$1 AND done=1 AND stage_no < 30',
        [q.job_card_id]);
      await db.run("UPDATE job_cards SET status='repair_in_progress', current_stage=$2 WHERE id=$1",
        [q.job_card_id, maxDone?.m || 0]);
    }
    await db.run(`UPDATE customer_queries SET return_status='in_repair', updated_at=NOW() WHERE id=$1`, [req.params.id]);
    const stageLabel = fromStage > 1 ? ` Repair restarts at stage ${fromStage}.` : ' Full checklist reopened.';
    await logActivity(q.order_id, q.job_card_id, 'material_received',
      `Material received for ${q.query_no}. Sent to production for repair.${stageLabel}`, req.user.id);
    return res.json({ message: `Material received — sent to production for repair${fromStage > 1 ? ` from stage ${fromStage}` : ''}` });
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

      if (jc && jc.qc_route === 'finished_goods') {
        // Production QC already cleared this repaired card into Finished Goods —
        // adding again here would double-count the same physical pieces.
        await logActivity(q.order_id, q.job_card_id, 'return_qc_pass',
          `Returned product QC passed — already in Finished Goods via production QC (no double entry). Coupon: ${q.return_coupon_no || 'N/A'}`, req.user.id);
        await db.run("UPDATE job_cards SET status='completed' WHERE id=$1", [q.job_card_id]);
      } else if (jc) {
        const baseNo = jc.drawing_no ? jc.drawing_no.replace(/-\d+$/, '') : null;
        const existing = baseNo
          ? await db.get('SELECT id FROM finished_goods WHERE base_drawing_no=$1 LIMIT 1', [baseNo])
          : null;

        // Specs: first assembly, falling back to the order item (assemblies are
        // often never filled; the order item always carries the specs).
        const asm = await db.get('SELECT * FROM job_card_assemblies WHERE job_card_id=$1 LIMIT 1', [q.job_card_id]);
        const oi = jc.order_item_id ? await db.get('SELECT * FROM order_items WHERE id=$1', [jc.order_item_id]) : null;
        const specs = {
          product_code: oi?.product_code || null,
          tube_material: asm?.tube_material || oi?.tube_material || null,
          tube_diameter: asm?.tube_diameter_mm || oi?.tube_diameter || null,
          wattage: asm?.wattage_actual || oi?.wattage || null,
          voltage: asm?.voltage_actual || oi?.voltage || null,
          plating: asm?.plating_description || oi?.plating_instructions || null,
        };

        if (existing) {
          await db.run(
            `UPDATE finished_goods SET qty_in=qty_in+$1, qty_available=qty_available+$1,
               product_code         = COALESCE(product_code, $3),
               tube_material        = COALESCE(tube_material, $4),
               tube_diameter        = COALESCE(tube_diameter, $5),
               wattage              = COALESCE(wattage, $6),
               voltage              = COALESCE(voltage, $7),
               plating_instructions = COALESCE(plating_instructions, $8)
             WHERE id=$2`,
            [jc.qty || 1, existing.id, specs.product_code, specs.tube_material, specs.tube_diameter, specs.wattage, specs.voltage, specs.plating]);
          await db.insert(
            `INSERT INTO finished_goods_log (finished_good_id, movement_type, qty, job_card_no, order_code, customer_code, reference, notes, created_by)
             VALUES ($1,'inward',$2,$3,$4,$5,$6,$7,$8)`,
            [existing.id, jc.qty || 1, jc.job_card_no, jc.order_code, jc.customer_code,
             q.return_coupon_no || q.query_no, `Return from customer — QC passed — Coupon: ${q.return_coupon_no || 'N/A'}`, req.user.id]
          );
        } else {
          const fg = await db.insert(`
            INSERT INTO finished_goods (job_card_id, order_id, order_code, order_type, customer_code, customer_name,
              drawing_no, base_drawing_no, product_code, tube_material, tube_diameter, wattage, voltage, plating_instructions,
              qty_in, qty_available, notes, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16,$17)
          `, [jc.id, jc.order_id, jc.order_code, jc.order_type, jc.customer_code, jc.customer_name,
              jc.drawing_no, baseNo, specs.product_code, specs.tube_material, specs.tube_diameter,
              specs.wattage, specs.voltage, specs.plating,
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
    await db.run("UPDATE job_cards SET status='repaired_dispatched', dispatched_at=NOW() WHERE id=$1", [q.job_card_id]);
  }
  // Recompute from every card rather than stamping the order closed — a
  // repaired card going out does not mean its siblings have.
  await syncOrderStatus(db, q.order_id, req.user.id);

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

  if (q.job_card_id) {
    await db.run("UPDATE job_cards SET status='dispatched', dispatched_at=NOW() WHERE id=$1", [q.job_card_id]);
  }
  await syncOrderStatus(db, q.order_id, req.user.id);

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
