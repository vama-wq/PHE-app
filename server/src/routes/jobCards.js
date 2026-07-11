const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadJobCard, uploadChecklistPhoto, uploadRejectionPhoto, deleteFromStorage } = require('../middleware/upload');
const { createNotification } = require('./notifications');
const { applyMaterialDeductions } = require('../lib/materialDeduction');
const { deductStageCategories } = require('../lib/inventoryDeduction');

// Stages that must be done before Stage 29 (QC) can be triggered.
// Must match client MANDATORY_STAGE_NOS. Optional/excluded: 2, 13(Buffing), 15(Brazing),
// 16(In Plating), 17(Plating Completed), 18(Heater Cleaning), 21(Nipple Press), 22(3hrs Oven).
const MANDATORY_STAGES = [1,3,4,5,6,7,8,9,10,11,12,14,19,20,23,24,25,26,27,28];

const TODAY = () => new Date().toISOString().split('T')[0];

// ── GET all job cards ─────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  const today = TODAY();
  const db = getDB();
  const cards = await db.all(`
    SELECT jc.*, o.order_code, o.material_deduction, c.customer_code, u.name as uploaded_by_name,
      (jc.dispatch_date::date - CURRENT_DATE) as days_until_dispatch,
      (SELECT COUNT(*) FROM production_daily_reports WHERE job_card_id = jc.id) as report_count,
      EXISTS(SELECT 1 FROM production_day_picks WHERE job_card_id = jc.id AND pick_date = $1) as picked_today,
      GREATEST(
        jc.qty
          - COALESCE((SELECT SUM(rejection_qty) FROM production_checklist WHERE job_card_id = jc.id), 0)
          + COALESCE((SELECT SUM(remade_qty)    FROM production_checklist WHERE job_card_id = jc.id AND stage_no != 29), 0),
        0
      ) as net_qty,
      (SELECT dispatched_qty FROM production_checklist WHERE job_card_id = jc.id AND stage_no = 29 LIMIT 1) as dispatched_qty,
      jc.qc_dispatch_qty, jc.qc_fg_qty, jc.qc_route,
      cq_active.id as active_query_id,
      cq_active.query_no as active_query_no,
      cq_active.subject as active_query_subject,
      cq_active.description as active_query_description,
      cq_active.category as active_query_category,
      cq_active.assigned_department as active_query_dept,
      cq_active.status as active_query_status,
      cq_active.priority as active_query_priority,
      cq_active.return_type as active_query_return_type,
      cq_active.return_status as active_query_return_status,
      cq_active.return_coupon_no as active_query_return_coupon_no,
      cq_active.debit_note_no as active_query_debit_note_no,
      cq_active.created_at as active_query_created_at,
      (SELECT COUNT(*) FROM quotations WHERE order_id = jc.order_id) as quotation_count,
      (SELECT COUNT(*) FROM activity_log WHERE job_card_id = jc.id AND activity_type = 'price_requested') as price_requested
    FROM job_cards jc
    JOIN orders o ON jc.order_id = o.id
    JOIN customers c ON o.customer_id = c.id
    LEFT JOIN users u ON jc.uploaded_by = u.id
    LEFT JOIN customer_queries cq_active
      ON cq_active.job_card_id = jc.id
      AND cq_active.status IN ('open','in_progress','product_return')
    ORDER BY jc.dispatch_date ASC
  `, [today]);
  res.json(cards);
});

// ── GET all stages with rejections (owner dashboard) ─────────────────────────
router.get('/rejections/all', authenticate, authorize('owner', 'admin', 'production', 'design'), async (req, res) => {
  const rows = await getDB().all(`
    SELECT
      pc.job_card_id, pc.stage_no, pc.rejection_qty, pc.remade_qty,
      pc.rejection_photo_file, pc.done_at,
      jc.job_card_no, jc.status as card_status,
      o.order_code, c.customer_code
    FROM production_checklist pc
    JOIN job_cards jc ON pc.job_card_id = jc.id
    JOIN orders o ON jc.order_id = o.id
    JOIN customers c ON o.customer_id = c.id
    WHERE pc.rejection_qty > 0
    ORDER BY pc.rejection_qty DESC, pc.done_at DESC
  `);
  res.json(rows);
});

// ── GET all active (pending) holds ────────────────────────────────────────────
router.get('/holds/active', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const rows = await getDB().all(`
    SELECT jch.*, jc.job_card_no
    FROM job_card_holds jch
    JOIN job_cards jc ON jch.job_card_id = jc.id
    WHERE jch.status = 'pending'
    ORDER BY jch.created_at DESC
  `);
  res.json(rows);
});

// ── GET today's picks (persistent — once picked stays until manually removed or completed) ──
router.get('/picks/today', authenticate, async (req, res) => {
  const today = TODAY();
  const picks = await getDB().all(`
    SELECT DISTINCT ON (jc.id) jc.*, o.order_code, c.customer_code,
      (jc.dispatch_date::date - CURRENT_DATE) as days_until_dispatch,
      EXISTS(
        SELECT 1 FROM production_daily_reports
        WHERE job_card_id = jc.id AND report_date = $1
      ) as has_report_today
    FROM production_day_picks pdp
    JOIN job_cards jc ON pdp.job_card_id = jc.id
    JOIN orders o ON jc.order_id = o.id
    JOIN customers c ON o.customer_id = c.id
    WHERE jc.status IN ('pending','in_progress','on_hold','repair_in_progress')
    ORDER BY jc.id, jc.dispatch_date ASC
  `, [today]);
  res.json(picks);
});

// ── GET single job card ───────────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  const today = TODAY();
  const db = getDB();
  const jc = await db.get(`
    SELECT jc.*, o.order_code, c.customer_code, u.name as uploaded_by_name,
      EXISTS(SELECT 1 FROM production_day_picks WHERE job_card_id = jc.id AND pick_date = $1) as picked_today
    FROM job_cards jc
    JOIN orders o ON jc.order_id = o.id
    JOIN customers c ON o.customer_id = c.id
    LEFT JOIN users u ON jc.uploaded_by = u.id
    WHERE jc.id = $2
  `, [today, req.params.id]);

  if (!jc) return res.status(404).json({ error: 'Job card not found' });

  // Active customer query for this job card (full details)
  const activeQuery = await db.get(`
    SELECT cq.id, cq.query_no, cq.subject, cq.description, cq.category,
      cq.assigned_department, cq.status, cq.priority,
      cq.return_type, cq.return_status, cq.return_coupon_no, cq.debit_note_no,
      cq.created_at, u_created.name as created_by_name,
      (SELECT COUNT(*) FROM customer_query_messages WHERE query_id = cq.id) as message_count,
      (SELECT COUNT(*) FROM customer_query_photos WHERE query_id = cq.id) as photo_count
    FROM customer_queries cq
    LEFT JOIN users u_created ON cq.created_by = u_created.id
    WHERE cq.job_card_id = $1 AND cq.status IN ('open','in_progress','product_return')
    ORDER BY cq.created_at DESC LIMIT 1
  `, [req.params.id]);
  if (activeQuery) {
    jc.active_query_id = activeQuery.id;
    jc.active_query_no = activeQuery.query_no;
    jc.active_query_subject = activeQuery.subject;
    jc.active_query_description = activeQuery.description;
    jc.active_query_category = activeQuery.category;
    jc.active_query_dept = activeQuery.assigned_department;
    jc.active_query_status = activeQuery.status;
    jc.active_query_priority = activeQuery.priority;
    jc.active_query_return_type = activeQuery.return_type;
    jc.active_query_return_status = activeQuery.return_status;
    jc.active_query_return_coupon_no = activeQuery.return_coupon_no;
    jc.active_query_debit_note_no = activeQuery.debit_note_no;
    jc.active_query_created_at = activeQuery.created_at;
    jc.active_query_created_by_name = activeQuery.created_by_name;
    jc.active_query_message_count = activeQuery.message_count;
    jc.active_query_photo_count = activeQuery.photo_count;
  }

  // Also check for recently resolved queries (to show "Query Resolved" info)
  const resolvedQuery = await db.get(`
    SELECT cq.id, cq.query_no, cq.subject, cq.description, cq.category,
      cq.assigned_department, cq.priority,
      cq.return_type, cq.return_coupon_no, cq.debit_note_no,
      cq.resolution_summary, cq.resolved_at, cq.created_at,
      u_resolved.name as resolved_by_name, u_created.name as created_by_name,
      (SELECT COUNT(*) FROM customer_query_messages WHERE query_id = cq.id) as message_count,
      (SELECT COUNT(*) FROM customer_query_photos WHERE query_id = cq.id) as photo_count
    FROM customer_queries cq
    LEFT JOIN users u_resolved ON cq.resolved_by = u_resolved.id
    LEFT JOIN users u_created ON cq.created_by = u_created.id
    WHERE cq.job_card_id = $1 AND cq.status = 'resolved'
    ORDER BY cq.resolved_at DESC LIMIT 1
  `, [req.params.id]);
  if (resolvedQuery) {
    jc.resolved_query_id = resolvedQuery.id;
    jc.resolved_query_no = resolvedQuery.query_no;
    jc.resolved_query_subject = resolvedQuery.subject;
    jc.resolved_query_description = resolvedQuery.description;
    jc.resolved_query_category = resolvedQuery.category;
    jc.resolved_query_dept = resolvedQuery.assigned_department;
    jc.resolved_query_priority = resolvedQuery.priority;
    jc.resolved_query_return_type = resolvedQuery.return_type;
    jc.resolved_query_return_coupon_no = resolvedQuery.return_coupon_no;
    jc.resolved_query_debit_note_no = resolvedQuery.debit_note_no;
    jc.resolved_query_summary = resolvedQuery.resolution_summary;
    jc.resolved_query_resolved_at = resolvedQuery.resolved_at;
    jc.resolved_query_created_at = resolvedQuery.created_at;
    jc.resolved_query_resolved_by_name = resolvedQuery.resolved_by_name;
    jc.resolved_query_created_by_name = resolvedQuery.created_by_name;
    jc.resolved_query_message_count = resolvedQuery.message_count;
    jc.resolved_query_photo_count = resolvedQuery.photo_count;
  }

  jc.daily_reports = await db.all(`
    SELECT pr.*, u.name as reported_by_name
    FROM production_daily_reports pr
    LEFT JOIN users u ON pr.reported_by = u.id
    WHERE pr.job_card_id = $1
    ORDER BY pr.report_date DESC, pr.created_at DESC
  `, [req.params.id]);

  // Qty summary from production checklist
  const qtySummary = await db.get(`
    SELECT
      COALESCE(SUM(rejection_qty), 0) as total_rejected,
      COALESCE(SUM(CASE WHEN stage_no != 29 THEN remade_qty ELSE 0 END), 0) as total_remade
    FROM production_checklist
    WHERE job_card_id = $1
  `, [req.params.id]);
  jc.total_rejected = parseInt(qtySummary?.total_rejected || 0, 10);
  jc.total_remade   = parseInt(qtySummary?.total_remade   || 0, 10);
  jc.net_qty        = Math.max((parseInt(jc.qty, 10) || 0) - jc.total_rejected + jc.total_remade, 0);

  jc.assemblies = await db.all(`
    SELECT a.*, u.name as dispatched_by_name
    FROM job_card_assemblies a LEFT JOIN users u ON a.raw_material_dispatched_by = u.id
    WHERE a.job_card_id = $1 ORDER BY a.id
  `, [req.params.id]);

  jc.drawings = await db.all(`
    SELECT d.*, u.name as uploaded_by_name
    FROM drawings d LEFT JOIN users u ON d.uploaded_by = u.id
    WHERE d.job_card_id = $1 ORDER BY d.created_at DESC
  `, [req.params.id]);

  jc.dispatch_docs = await db.all(`
    SELECT d.*, u.name as created_by_name
    FROM dispatch_documents d LEFT JOIN users u ON d.created_by = u.id
    WHERE d.job_card_id = $1 ORDER BY d.created_at DESC
  `, [req.params.id]);

  jc.activity = await db.all(`
    SELECT a.*, u.name as user_name
    FROM activity_log a LEFT JOIN users u ON a.created_by = u.id
    WHERE a.job_card_id = $1 ORDER BY a.created_at DESC
  `, [req.params.id]);

  jc.production_reports = await db.all(`
    SELECT pr.*, u.name as reported_by_name
    FROM production_daily_reports pr LEFT JOIN users u ON pr.reported_by = u.id
    WHERE pr.job_card_id = $1 ORDER BY pr.report_date DESC, pr.created_at DESC
  `, [req.params.id]);

  jc.package_photos = await db.all(`
    SELECT p.*, u.name as uploaded_by_name
    FROM package_photos p LEFT JOIN users u ON p.uploaded_by = u.id
    WHERE p.job_card_id = $1 ORDER BY p.created_at DESC
  `, [req.params.id]);

  const qcReport = await db.get(`
    SELECT q.*, u.name as created_by_name
    FROM qc_reports q LEFT JOIN users u ON q.created_by = u.id
    WHERE q.job_card_id = $1 ORDER BY q.created_at DESC LIMIT 1
  `, [req.params.id]);
  jc.qc_report = qcReport || null;

  res.json(jc);
});

// ── POST create job card ──────────────────────────────────────────────────────
router.post('/', authenticate, authorize('admin', 'owner'), ...uploadJobCard, async (req, res) => {
  const { job_card_no, order_id, qty, dispatch_date, notes, punching, drawing_no, product_name } = req.body;
  if (!job_card_no || !order_id || !dispatch_date) {
    return res.status(400).json({ error: 'Job card number, order, and dispatch date are required' });
  }
  if (!punching) {
    return res.status(400).json({ error: 'Punching value is required' });
  }

  const db = getDB();
  let finalNo = job_card_no.toUpperCase();
  const dup = await db.get('SELECT id FROM job_cards WHERE job_card_no = $1', [finalNo]);
  if (dup) {
    const count = await db.get(
      "SELECT COUNT(*) as c FROM job_cards WHERE job_card_no = $1 OR job_card_no LIKE $2",
      [finalNo, `${finalNo}-%`]
    );
    finalNo = `${finalNo}-${parseInt(count.c) + 1}`;
  }

  // Link this job card to the order item it produces (match by drawing number)
  // so its inventory deducts at this item's QC / dispatch.
  let orderItemId = null;
  if (drawing_no) {
    const oi = await db.get(
      'SELECT id FROM order_items WHERE order_id=$1 AND drawing_number=$2 ORDER BY id LIMIT 1',
      [parseInt(order_id, 10), drawing_no]
    );
    orderItemId = oi?.id || null;
  }

  try {
    const r = await db.insert(`
      INSERT INTO job_cards (job_card_no, order_id, file_path, file_name, original_name, qty, dispatch_date, notes, punching, drawing_no, product_name, uploaded_by, order_item_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `, [
      finalNo, parseInt(order_id, 10),
      req.file?.storagePath || null, req.file?.filename || null, req.file?.originalname || null,
      qty || null, dispatch_date, notes || null,
      punching || null, drawing_no || null, product_name || null,
      req.user.id, orderItemId
    ]);

    const existing = await db.get('SELECT COUNT(*) as c FROM job_cards WHERE order_id=$1', [order_id]);
    if (parseInt(existing.c, 10) <= 1) {
      await db.run("UPDATE orders SET status='job_card_created' WHERE id=$1 AND status='approved'", [order_id]);
    }

    await logActivity(order_id, r.lastInsertRowid, 'job_card_created', `Job Card ${finalNo} uploaded`, req.user.id);
    res.status(201).json({ id: r.lastInsertRowid, job_card_no: finalNo });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Job card number already exists' });
    throw e;
  }
});

// ── PUT update job card metadata ──────────────────────────────────────────────
router.put('/:id', authenticate, authorize('admin', 'owner'), async (req, res) => {
  const { job_card_no, qty, dispatch_date, notes, punching, drawing_no, product_name } = req.body;
  await getDB().run(`
    UPDATE job_cards SET job_card_no=$1, qty=$2, dispatch_date=$3, notes=$4, punching=$5, drawing_no=$6, product_name=$7 WHERE id=$8
  `, [job_card_no, qty || null, dispatch_date, notes || null,
    punching || null, drawing_no || null, product_name || null, req.params.id]);
  res.json({ message: 'Updated' });
});

// ── DELETE job card ───────────────────────────────────────────────────────────
router.delete('/:id', authenticate, authorize('admin', 'owner'), async (req, res) => {
  const db = getDB();
  const jc = await db.get('SELECT * FROM job_cards WHERE id=$1', [req.params.id]);
  if (!jc) return res.status(404).json({ error: 'Not found' });

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
  await db.run('DELETE FROM job_cards WHERE id=$1', [req.params.id]);
  res.json({ message: 'Deleted' });
});

// ── PUT update status ─────────────────────────────────────────────────────────
router.put('/:id/status', authenticate, authorize('admin', 'owner', 'production'), async (req, res) => {
  const { status } = req.body;
  const db = getDB();
  const jc = await db.get('SELECT * FROM job_cards WHERE id=$1', [req.params.id]);
  if (!jc) return res.status(404).json({ error: 'Not found' });

  // Prevent changing away from on_hold if pending holds exist — must use proper approve flow
  if (jc.status === 'on_hold' && status !== 'on_hold') {
    const pendingHold = await db.get(
      "SELECT id FROM job_card_holds WHERE job_card_id=$1 AND status='pending' LIMIT 1",
      [req.params.id]
    );
    if (pendingHold) {
      return res.status(400).json({
        error: 'Cannot change status — job card has a pending hold. Use "Approve to Resume" to clear the hold first.',
        code: 'PENDING_HOLD'
      });
    }
  }

  await db.run('UPDATE job_cards SET status=$1 WHERE id=$2', [status, req.params.id]);
  await logActivity(jc.order_id, jc.id, 'status_changed', `Job card ${jc.job_card_no} → ${status}`, req.user.id);
  res.json({ message: 'Updated' });
});

// ── POST pick a job card for today ────────────────────────────────────────────
router.post('/:id/pick', authenticate, authorize('production', 'owner', 'admin'), async (req, res) => {
  try {
    await getDB().run(`
      INSERT INTO production_day_picks (pick_date, job_card_id, picked_by) VALUES ($1,$2,$3)
    `, [TODAY(), req.params.id, req.user.id]);
    res.status(201).json({ message: 'Picked for today' });
  } catch (e) {
    if (e.code === '23505') return res.json({ message: 'Already picked' });
    throw e;
  }
});

// ── DELETE unpick (removes all picks for this card across all dates) ──────────
router.delete('/:id/pick', authenticate, authorize('production', 'owner', 'admin'), async (req, res) => {
  await getDB().run(
    'DELETE FROM production_day_picks WHERE job_card_id=$1',
    [req.params.id]
  );
  res.json({ message: 'Unpicked' });
});

// ── POST daily report ─────────────────────────────────────────────────────────
router.post('/:id/daily-report', authenticate, authorize('production', 'owner', 'admin'), async (req, res) => {
  const { qty_completed, qty_rejected, rejection_reason, notes } = req.body;
  const db = getDB();
  const jc = await db.get('SELECT * FROM job_cards WHERE id=$1', [req.params.id]);
  if (!jc) return res.status(404).json({ error: 'Not found' });

  const r = await db.insert(`
    INSERT INTO production_daily_reports
      (report_date, job_card_id, qty_completed, qty_rejected, rejection_reason, notes, reported_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, [TODAY(), req.params.id, qty_completed || 0, qty_rejected || 0, rejection_reason || null, notes || null, req.user.id]);

  if (jc.status === 'pending') {
    await db.run("UPDATE job_cards SET status='in_progress' WHERE id=$1", [req.params.id]);
  }

  await logActivity(jc.order_id, jc.id, 'production_report',
    `Daily report for ${jc.job_card_no}: ${qty_completed || 0} done, ${qty_rejected || 0} rejected`, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid });
});

// ── Helper: recompute ORDER status from all its job cards ─────────────────────
// Priority (highest wins):
//   dispatched   → all job cards dispatched
//   qc_approved  → any card qc_approved (and not all dispatched)
//   qc_pending   → any card qc_pending
//   in_progress  → any card in_progress or on_hold
//   job_card_created → otherwise (cards exist but none started)
async function syncOrderStatus(db, orderId, userId) {
  const cards = await db.all('SELECT status FROM job_cards WHERE order_id=$1', [orderId]);
  if (!cards.length) return;

  const statuses = cards.map(c => c.status);
  let newOrderStatus;

  const nonDispatched = statuses.filter(s => s !== 'dispatched');

  if (statuses.every(s => s === 'dispatched')) {
    newOrderStatus = 'dispatched';
  } else if (nonDispatched.length > 0 && nonDispatched.every(s => s === 'qc_approved')) {
    // All remaining (non-dispatched) cards must be qc_approved
    newOrderStatus = 'qc_approved';
  } else if (statuses.some(s => s === 'qc_pending')) {
    newOrderStatus = 'qc_pending';
  } else if (statuses.some(s => s === 'in_progress' || s === 'on_hold')) {
    newOrderStatus = 'in_progress';
  } else {
    newOrderStatus = 'job_card_created';
  }

  const order = await db.get('SELECT status FROM orders WHERE id=$1', [orderId]);
  if (!order || order.status === newOrderStatus) return;

  // Don't overwrite terminal/upstream statuses or active query statuses
  const locked = ['pending_approval', 'approved', 'rejected', 'customer_query', 'product_return', 'resolved_dispatched'];
  if (locked.includes(order.status)) return;

  await db.run('UPDATE orders SET status=$1 WHERE id=$2', [newOrderStatus, orderId]);
  await logActivity(orderId, null, 'status_changed',
    `Order status updated to ${newOrderStatus.replace(/_/g, ' ')}`, userId);
}

// ── Helper: recompute job card status + current_stage, then sync order ────────
async function updateJobCardAfterStageChange(db, jobCardId, userId) {
  // Linear progress only — exclude out-of-sequence optional stages (30+, e.g. Kharoch)
  // so completing them doesn't freeze current_stage at the top.
  const maxRow = await db.get(
    'SELECT MAX(stage_no) as m FROM production_checklist WHERE job_card_id=$1 AND done=1 AND stage_no < 30',
    [jobCardId]
  );
  const maxStage = maxRow?.m || 0;

  // Stage 29 = Dispatch (triggers QC). No stage 30 — QC approval handled separately.
  const stage29 = (await db.get(
    'SELECT done FROM production_checklist WHERE job_card_id=$1 AND stage_no=29',
    [jobCardId]
  ))?.done;

  const jc = await db.get('SELECT * FROM job_cards WHERE id=$1', [jobCardId]);
  if (!jc) return;

  let newStatus;
  if (jc.status === 'on_hold')     newStatus = 'on_hold';     // preserve hold — owner must approve
  else if (jc.status === 'qc_approved') newStatus = 'qc_approved'; // preserve QC approval
  else if (stage29)                newStatus = 'qc_pending';  // dispatch done → awaiting QC
  else if (maxStage)               newStatus = 'in_progress';
  else                             newStatus = 'pending';

  await db.run('UPDATE job_cards SET current_stage=$1, status=$2 WHERE id=$3', [maxStage, newStatus, jobCardId]);

  if (newStatus !== jc.status) {
    await logActivity(jc.order_id, jobCardId, 'status_changed',
      `Job card ${jc.job_card_no} → ${newStatus.replace(/_/g, ' ')}`, userId);
  }

  // Always sync the parent order status
  await syncOrderStatus(db, jc.order_id, userId);
}

// ── Helper: check cumulative rejections across all stages ─────────────────────
// If total > 4 and card is not already on hold, put it on hold (stage_no=0 sentinel).
// If a cumulative hold was previously approved at some total N, only re-flag when total > N.
async function checkCumulativeRejections(db, jobCardId, userId) {
  const jcRow = await db.get('SELECT status FROM job_cards WHERE id=$1', [jobCardId]);
  if (!jcRow || jcRow.status === 'on_hold') return; // already on hold, skip

  const totRow = await db.get(
    'SELECT COALESCE(SUM(rejection_qty), 0) AS total FROM production_checklist WHERE job_card_id=$1',
    [jobCardId]
  );
  const total = parseInt(totRow?.total || 0, 10);
  if (total <= 4) return;

  // Don't re-flag if a pending cumulative hold already exists
  const pending = await db.get(
    "SELECT id FROM job_card_holds WHERE job_card_id=$1 AND stage_no=0 AND status='pending'",
    [jobCardId]
  );
  if (pending) return;

  // Find the highest rejection_qty from previously approved cumulative holds.
  // Only re-flag if current total exceeds that approved watermark.
  const approvedRow = await db.get(
    "SELECT COALESCE(MAX(rejection_qty), 0) AS max_approved FROM job_card_holds WHERE job_card_id=$1 AND stage_no=0 AND status='approved'",
    [jobCardId]
  );
  const approvedWatermark = parseInt(approvedRow?.max_approved || 0, 10);
  if (total <= approvedWatermark) return; // no new rejections beyond what was already approved

  await db.insert(`
    INSERT INTO job_card_holds (job_card_id, stage_no, rejection_qty, notes, created_by)
    VALUES ($1, 0, $2, $3, $4)
  `, [jobCardId, total, `Cumulative rejection total: ${total} pieces across all stages`, userId]);

  await db.run("UPDATE job_cards SET status='on_hold' WHERE id=$1", [jobCardId]);

  const jc = await db.get('SELECT * FROM job_cards WHERE id=$1', [jobCardId]);
  if (jc) {
    await logActivity(jc.order_id, jobCardId, 'status_changed',
      `Job card ${jc.job_card_no} ON HOLD — cumulative rejections total ${total} pieces across all stages`, userId);
  }
}

// ── Helper: trigger hold when rejection > 2 ──────────────────────────────────
async function triggerHold(db, jobCardId, stageNo, rejQty, userId) {
  const row = await db.get(
    'SELECT rejection_photo_file, rejection_photo_original_name FROM production_checklist WHERE job_card_id=$1 AND stage_no=$2',
    [jobCardId, stageNo]
  );

  await db.insert(`
    INSERT INTO job_card_holds (job_card_id, stage_no, rejection_qty, hold_photo_file, hold_photo_original_name, created_by)
    VALUES ($1,$2,$3,$4,$5,$6)
  `, [jobCardId, stageNo, rejQty, row?.rejection_photo_file || null, row?.rejection_photo_original_name || null, userId]);

  await db.run("UPDATE job_cards SET status='on_hold' WHERE id=$1", [jobCardId]);

  const jc = await db.get('SELECT * FROM job_cards WHERE id=$1', [jobCardId]);
  if (jc) {
    await logActivity(jc.order_id, jobCardId, 'status_changed',
      `Job card ${jc.job_card_no} ON HOLD — ${rejQty} rejections at Stage ${stageNo}`, userId);
    await syncOrderStatus(db, jc.order_id, userId);
  }
}

// ── GET checklist for a job card ──────────────────────────────────────────────
router.get('/:id/checklist', authenticate, async (req, res) => {
  const db = getDB();
  const rows = await db.all(
    'SELECT * FROM production_checklist WHERE job_card_id=$1 ORDER BY stage_no',
    [req.params.id]
  );

  const activeHold = await db.get(
    "SELECT * FROM job_card_holds WHERE job_card_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1",
    [req.params.id]
  );

  // Stage numbers in display order. 30 = Kharoch Process — an optional stage shown
  // right after Bending (14); it keeps a high id so existing data is never renumbered.
  const STAGE_NOS = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,30,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29];
  const map = {};
  rows.forEach(r => { map[r.stage_no] = r; });
  const stages = STAGE_NOS.map(n => map[n] || {
    stage_no: n, done: 0, value1: null, value2: null,
    photo_file: null, photo_original_name: null, done_at: null,
    rejection_qty: 0, remade_qty: 0,
    rejection_photo_file: null, rejection_photo_original_name: null,
    worker_name: null, scrap_value: null,
  });
  let qcRejected = false, qcRejectionNotes = null;
  try {
    const jcInfo = await db.get(
      'SELECT qc_rejected, qc_rejection_notes FROM job_cards WHERE id=$1',
      [req.params.id]
    );
    qcRejected = jcInfo?.qc_rejected || false;
    qcRejectionNotes = jcInfo?.qc_rejection_notes || null;
  } catch (_) { /* columns may not exist yet */ }
  res.json({ stages, hold: activeHold || null, qc_rejected: qcRejected, qc_rejection_notes: qcRejectionNotes });
});

// ── PUT update a checklist stage ──────────────────────────────────────────────
router.put('/:id/checklist/:stage', authenticate, authorize('production', 'owner', 'admin'), async (req, res) => {
  const jobCardId = parseInt(req.params.id, 10);
  const stageNo   = parseInt(req.params.stage, 10);
  if (isNaN(stageNo) || stageNo < 1 || stageNo > 40) return res.status(400).json({ error: 'Invalid stage' });

  const { done, value1, value2, rejection_qty, remade_qty, worker_name, scrap_value, notes, coil_weight } = req.body;
  const db = getDB();

  // Block if card is on hold and trying to mark done
  if (done) {
    const jcRow = await db.get('SELECT status FROM job_cards WHERE id=$1', [jobCardId]);
    const jcStatus = jcRow?.status;
    if (jcStatus === 'on_hold') {
      return res.status(400).json({
        error: 'Work is on hold. Owner must approve before continuing.',
        code: 'ON_HOLD'
      });
    }
  }

  const rejQty = parseInt(rejection_qty, 10) || 0;
  const remQty = parseInt(remade_qty, 10) || 0;

  // Gate stage 29 (Dispatch Preparation → triggers QC): all mandatory stages must be complete
  if (stageNo === 29 && done) {
    const mandatory = [...MANDATORY_STAGES];
    const doneRows = await db.all(
      'SELECT stage_no FROM production_checklist WHERE job_card_id=$1 AND done=1',
      [jobCardId]
    );
    const doneSet = new Set(doneRows.map(r => r.stage_no));
    const missing = mandatory.filter(s => !doneSet.has(s));
    if (missing.length > 0) {
      return res.status(400).json({
        error: `Cannot send to QC — complete mandatory stages first: ${missing.map(n => 'Stage ' + n).join(', ')}`,
        code: 'MISSING_STAGES',
        missing
      });
    }
  }

  // Require rejection photo when any rejection exists
  if (done && rejQty > 0) {
    const existing = await db.get(
      'SELECT rejection_photo_file FROM production_checklist WHERE job_card_id=$1 AND stage_no=$2',
      [jobCardId, stageNo]
    );
    if (!existing?.rejection_photo_file) {
      return res.status(400).json({
        error: 'Upload rejection photo before marking done (rejection detected).',
        code: 'REJECTION_PHOTO_REQUIRED'
      });
    }
  }

  // Stage 28 (Megger) requires a value to be entered
  if (stageNo === 28 && done && !value1?.trim()) {
    return res.status(400).json({
      error: 'Megger value is required before marking this stage done.',
      code: 'MEGGER_VALUE_REQUIRED'
    });
  }

  // Stage 3 (Ohms) requires the total weight of all coils produced for this job card
  const coilWeightNum = (coil_weight === '' || coil_weight == null) ? null : Number(coil_weight);
  if (stageNo === 3 && done && !(coilWeightNum > 0)) {
    return res.status(400).json({
      error: 'Total weight of all coils is required before marking this stage done.',
      code: 'COIL_WEIGHT_REQUIRED'
    });
  }

  // Stage 1 (Coil): gauge selection is required for material-tracked (new) orders,
  // since the spring-gauge deduction depends on it. Existing orders are unaffected.
  if (stageNo === 1 && done && !value1?.trim()) {
    const ord = await db.get(
      'SELECT o.material_deduction FROM job_cards jc JOIN orders o ON o.id=jc.order_id WHERE jc.id=$1', [jobCardId]
    );
    if (ord?.material_deduction) {
      return res.status(400).json({
        error: 'Gauge selection is required before marking this stage done.',
        code: 'GAUGE_REQUIRED'
      });
    }
  }

  const now = new Date().toISOString();

  await db.run(`
    INSERT INTO production_checklist
      (job_card_id, stage_no, done, value1, value2, rejection_qty, remade_qty, worker_name, scrap_value, notes, coil_weight, done_at, updated_by, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
    ON CONFLICT(job_card_id, stage_no) DO UPDATE SET
      done          = EXCLUDED.done,
      value1        = EXCLUDED.value1,
      value2        = EXCLUDED.value2,
      rejection_qty = EXCLUDED.rejection_qty,
      remade_qty    = EXCLUDED.remade_qty,
      worker_name   = EXCLUDED.worker_name,
      scrap_value   = EXCLUDED.scrap_value,
      notes         = EXCLUDED.notes,
      coil_weight   = EXCLUDED.coil_weight,
      done_at = CASE
        WHEN EXCLUDED.done = 1 AND production_checklist.done_at IS NULL THEN EXCLUDED.done_at
        WHEN EXCLUDED.done = 0 THEN NULL
        ELSE production_checklist.done_at
      END,
      updated_by  = EXCLUDED.updated_by,
      updated_at  = NOW()
  `, [jobCardId, stageNo, done ? 1 : 0, value1 ?? null, value2 ?? null, rejQty, remQty,
    worker_name || null, scrap_value || null, notes || null, coilWeightNum, done ? now : null, req.user.id]);

  // When stage 29 is re-submitted to QC, clear the QC rejection flag
  if (stageNo === 29 && done) {
    try {
      await db.run(
        `UPDATE job_cards SET qc_rejected=FALSE, qc_rejection_notes=NULL WHERE id=$1`,
        [jobCardId]
      );
    } catch (_) { /* column may not exist yet — ignore */ }
  }

  // New orders: deduct tube (Stage 5) / spring-gauge (Stage 3) from stock via FIFO,
  // based on the checklist. Wrapped so it can never block saving the stage.
  try { await applyMaterialDeductions(db, jobCardId, stageNo, !!done, req.user.id); }
  catch (e) { console.error('[checklist] material deduction failed:', e.message); }

  // Category-timed BOM deduction: Stage 15 (Brazing) → flange/brazing categories,
  // Stage 21 (Nipple Press) → nipple categories, prorated by the card's qty share.
  if (done && (stageNo === 15 || stageNo === 21)) {
    try {
      const jcFull = await db.get('SELECT * FROM job_cards WHERE id=$1', [jobCardId]);
      await deductStageCategories(db, jcFull, stageNo, req.user.id);
    } catch (e) { console.error('[checklist] stage-category deduction failed:', e.message); }
  }

  if (done && rejQty > 2) {
    await triggerHold(db, jobCardId, stageNo, rejQty, req.user.id);
    return res.json({ message: 'Stage updated. Job card placed on hold.', on_hold: true });
  }

  // Check cumulative rejection limit (>4 across all stages)
  if (done) {
    await checkCumulativeRejections(db, jobCardId, req.user.id);
    const jcCheck = await db.get('SELECT status FROM job_cards WHERE id=$1', [jobCardId]);
    if (jcCheck?.status === 'on_hold') {
      return res.json({ message: 'Stage updated. Job card placed on hold — cumulative rejections exceeded limit.', on_hold: true, cumulative: true });
    }
  }

  await updateJobCardAfterStageChange(db, jobCardId, req.user.id);
  res.json({ message: 'Stage updated' });
});

// ── POST upload rejection photo for a stage ───────────────────────────────────
router.post('/:id/checklist/:stage/rejection-photo', authenticate, authorize('production', 'owner', 'admin'),
  ...uploadRejectionPhoto, async (req, res) => {
    const jobCardId = parseInt(req.params.id, 10);
    const stageNo   = parseInt(req.params.stage, 10);
    if (!req.file) return res.status(400).json({ error: 'File required' });

    const db = getDB();
    await db.run(`
      INSERT INTO production_checklist
        (job_card_id, stage_no, rejection_photo_file, rejection_photo_original_name, updated_by, updated_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT(job_card_id, stage_no) DO UPDATE SET
        rejection_photo_file          = EXCLUDED.rejection_photo_file,
        rejection_photo_original_name = EXCLUDED.rejection_photo_original_name,
        updated_by  = EXCLUDED.updated_by,
        updated_at  = NOW()
    `, [jobCardId, stageNo, req.file.filename, req.file.originalname, req.user.id]);

    res.json({ file_name: req.file.filename, original_name: req.file.originalname });
  }
);

// ── POST upload stage photo (any stage — required after 6pm, mandatory for stages 24 & 29) ──
router.post('/:id/checklist/:stage/photo', authenticate, authorize('production', 'owner', 'admin'),
  ...uploadChecklistPhoto, async (req, res) => {
    const jobCardId = parseInt(req.params.id, 10);
    const stageNo   = parseInt(req.params.stage, 10);
    if (!req.file) return res.status(400).json({ error: 'File required' });

    const db = getDB();

    const jcRow = await db.get('SELECT status FROM job_cards WHERE id=$1', [jobCardId]);
    const jcStatus = jcRow?.status;
    if (jcStatus === 'on_hold') {
      return res.status(400).json({ error: 'Work is on hold. Owner must approve before continuing.', code: 'ON_HOLD' });
    }
    const rejQty    = parseInt(req.body.rejection_qty, 10) || 0;
    const remQty    = parseInt(req.body.remade_qty, 10) || 0;
    const workerName = req.body.worker_name || null;
    const scrapVal  = req.body.scrap_value || null;
    const value1    = req.body.value1 || null;
    const value2    = req.body.value2 || null;
    // mark_done=false means: just save the photo, keep stage incomplete (used for after-6pm flow)
    const markDone  = req.body.mark_done !== 'false';

    if (rejQty > 2) {
      const existing = await db.get(
        'SELECT rejection_photo_file FROM production_checklist WHERE job_card_id=$1 AND stage_no=$2',
        [jobCardId, stageNo]
      );
      if (!existing?.rejection_photo_file) {
        return res.status(400).json({
          error: 'Upload rejection photo before completing this stage (rejection > 2 pieces).',
          code: 'REJECTION_PHOTO_REQUIRED'
        });
      }
    }

    const now = new Date().toISOString();

    // Stage 28 (Megger) requires a value to be entered
    if (stageNo === 28 && markDone && !value1?.trim()) {
      return res.status(400).json({
        error: 'Megger value is required before marking this stage done.',
        code: 'MEGGER_VALUE_REQUIRED'
      });
    }

    // Stage 29 = Dispatch — stores dispatched_qty before QC.
    const dispatchedQty = stageNo === 29 ? (parseInt(req.body.dispatched_qty, 10) || null) : null;
    if (stageNo === 29 && markDone && !dispatchedQty) {
      return res.status(400).json({ error: 'Dispatched quantity is required for dispatch stage.' });
    }

    if (markDone) {
      await db.run(`
        INSERT INTO production_checklist
          (job_card_id, stage_no, done, photo_file, photo_original_name, rejection_qty, remade_qty, dispatched_qty, worker_name, scrap_value, value1, value2, done_at, updated_by, updated_at)
        VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
        ON CONFLICT(job_card_id, stage_no) DO UPDATE SET
          photo_file          = EXCLUDED.photo_file,
          photo_original_name = EXCLUDED.photo_original_name,
          rejection_qty       = EXCLUDED.rejection_qty,
          remade_qty          = EXCLUDED.remade_qty,
          dispatched_qty      = EXCLUDED.dispatched_qty,
          worker_name         = EXCLUDED.worker_name,
          scrap_value         = EXCLUDED.scrap_value,
          value1              = COALESCE(EXCLUDED.value1, production_checklist.value1),
          value2              = COALESCE(EXCLUDED.value2, production_checklist.value2),
          done                = 1,
          done_at             = COALESCE(production_checklist.done_at, EXCLUDED.done_at),
          updated_by          = EXCLUDED.updated_by,
          updated_at          = NOW()
      `, [jobCardId, stageNo, req.file.filename, req.file.originalname, rejQty, remQty, dispatchedQty, workerName, scrapVal, value1, value2, now, req.user.id]);
    } else {
      // Photo only — do NOT mark done, keep existing done value
      await db.run(`
        INSERT INTO production_checklist
          (job_card_id, stage_no, done, photo_file, photo_original_name, worker_name, scrap_value, value1, value2, updated_by, updated_at)
        VALUES ($1,$2,0,$3,$4,$5,$6,$7,$8,$9,NOW())
        ON CONFLICT(job_card_id, stage_no) DO UPDATE SET
          photo_file          = EXCLUDED.photo_file,
          photo_original_name = EXCLUDED.photo_original_name,
          worker_name         = COALESCE(EXCLUDED.worker_name, production_checklist.worker_name),
          scrap_value         = COALESCE(EXCLUDED.scrap_value, production_checklist.scrap_value),
          value1              = COALESCE(EXCLUDED.value1, production_checklist.value1),
          value2              = COALESCE(EXCLUDED.value2, production_checklist.value2),
          updated_by          = EXCLUDED.updated_by,
          updated_at          = NOW()
      `, [jobCardId, stageNo, req.file.filename, req.file.originalname, workerName, scrapVal, value1, value2, req.user.id]);
    }

    if (markDone) {
      if (rejQty > 2) {
        await triggerHold(db, jobCardId, stageNo, rejQty, req.user.id);
        return res.json({ file_name: req.file.filename, on_hold: true });
      }
      // Check cumulative rejection limit (>4 across all stages)
      await checkCumulativeRejections(db, jobCardId, req.user.id);
      const jcCheck = await db.get('SELECT status FROM job_cards WHERE id=$1', [jobCardId]);
      if (jcCheck?.status === 'on_hold') {
        return res.json({ file_name: req.file.filename, marked_done: true, on_hold: true, cumulative: true });
      }
      await updateJobCardAfterStageChange(db, jobCardId, req.user.id);
    }

    res.json({ file_name: req.file.filename, original_name: req.file.originalname, marked_done: markDone });
  }
);

// ── PUT approve hold (owner/admin) ────────────────────────────────────────────
router.put('/:id/hold/approve', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const db = getDB();
  const jc = await db.get('SELECT * FROM job_cards WHERE id=$1', [req.params.id]);
  if (!jc) return res.status(404).json({ error: 'Not found' });

  // Check for pending holds — handles desync where hold exists but status drifted
  const pendingHold = await db.get(
    "SELECT id FROM job_card_holds WHERE job_card_id=$1 AND status='pending' LIMIT 1",
    [req.params.id]
  );
  if (jc.status !== 'on_hold' && !pendingHold) {
    return res.status(400).json({ error: 'Job card is not on hold' });
  }

  await db.run(`
    UPDATE job_card_holds SET status='approved', approved_by=$1, approved_at=NOW()
    WHERE job_card_id=$2 AND status='pending'
  `, [req.user.id, req.params.id]);

  await db.run("UPDATE job_cards SET status='in_progress' WHERE id=$1", [req.params.id]);
  await logActivity(jc.order_id, jc.id, 'status_changed',
    `Job card ${jc.job_card_no} hold approved by ${req.user.name} — work resumed`, req.user.id);
  await syncOrderStatus(db, jc.order_id, req.user.id);

  res.json({ message: 'Hold approved, work resumed' });
});

// ── Partial-dispatch split requests ────────────────────────────────────────────
// Production asks to dispatch part of a job card early (qty + reason). Owner
// approves → a child job card (qty = requested) is created at 'qc_pending' (it
// skips production) and the parent's qty is reduced. Requestable any time while
// the parent is still in production.
const SPLIT_REQUESTABLE = ['pending', 'in_progress', 'on_hold'];

router.post('/:id/split-request', authenticate, authorize('production', 'admin', 'owner'), async (req, res) => {
  const db = getDB();
  const qty = parseInt(req.body.qty, 10);
  const reason = (req.body.reason || '').trim();
  const jc = await db.get('SELECT * FROM job_cards WHERE id=$1', [req.params.id]);
  if (!jc) return res.status(404).json({ error: 'Job card not found' });
  if (!SPLIT_REQUESTABLE.includes(jc.status)) return res.status(400).json({ error: 'Partial dispatch can only be requested while the job card is in production' });
  if (!qty || qty < 1) return res.status(400).json({ error: 'Enter the quantity to dispatch early' });
  if (qty >= jc.qty) return res.status(400).json({ error: `Quantity must be less than the job card qty (${jc.qty}) — at least 1 must remain` });
  if (!reason) return res.status(400).json({ error: 'A reason is required' });
  const existing = await db.get("SELECT id FROM job_card_split_requests WHERE job_card_id=$1 AND status='pending'", [jc.id]);
  if (existing) return res.status(400).json({ error: 'A partial-dispatch request is already pending owner approval for this job card' });

  await db.insert('INSERT INTO job_card_split_requests (job_card_id, qty, reason, created_by) VALUES ($1,$2,$3,$4)', [jc.id, qty, reason, req.user.id]);
  const recipients = await db.all(`SELECT id FROM users WHERE role IN ('owner','admin')`);
  for (const u of recipients) {
    await createNotification(db, {
      userId: u.id, type: 'split_request',
      title: `Partial dispatch request — ${jc.job_card_no}`,
      body: `Dispatch ${qty} of ${jc.qty} early. Reason: ${reason}`,
      link: `/job-cards/${jc.id}`, sourceUserId: req.user.id,
    });
  }
  await logActivity(jc.order_id, jc.id, 'split_requested', `Partial dispatch requested: ${qty} of ${jc.qty} — ${reason}`, req.user.id);
  res.status(201).json({ message: 'Partial dispatch request sent for owner approval' });
});

router.get('/split-requests/pending', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const rows = await getDB().all(`
    SELECT sr.*, jc.job_card_no, jc.qty AS jc_qty, jc.product_name, jc.drawing_no,
           o.order_code, u.name AS requested_by_name
    FROM job_card_split_requests sr
    JOIN job_cards jc ON jc.id = sr.job_card_id
    JOIN orders o ON o.id = jc.order_id
    LEFT JOIN users u ON u.id = sr.created_by
    WHERE sr.status='pending'
    ORDER BY sr.created_at ASC`);
  res.json(rows);
});

router.get('/:id/split-requests', authenticate, async (req, res) => {
  const rows = await getDB().all(
    `SELECT sr.*, u.name AS requested_by_name, a.name AS approved_by_name, ch.job_card_no AS child_job_card_no
     FROM job_card_split_requests sr
     LEFT JOIN users u ON u.id = sr.created_by
     LEFT JOIN users a ON a.id = sr.approved_by
     LEFT JOIN job_cards ch ON ch.id = sr.child_job_card_id
     WHERE sr.job_card_id=$1 ORDER BY sr.created_at DESC`,
    [req.params.id]
  );
  res.json(rows);
});

router.put('/split-requests/:reqId/approve', authenticate, authorize('owner'), async (req, res) => {
  const db = getDB();
  const sr = await db.get("SELECT * FROM job_card_split_requests WHERE id=$1 AND status='pending'", [req.params.reqId]);
  if (!sr) return res.status(404).json({ error: 'Pending request not found' });
  const jc = await db.get('SELECT * FROM job_cards WHERE id=$1', [sr.job_card_id]);
  if (!jc) return res.status(404).json({ error: 'Job card not found' });
  if (sr.qty >= jc.qty) return res.status(400).json({ error: `Job card qty is now ${jc.qty}; cannot split off ${sr.qty}` });

  const childCount = await db.get('SELECT COUNT(*) AS n FROM job_cards WHERE parent_job_card_id=$1', [jc.id]);
  const childNo = `${jc.job_card_no}-P${parseInt(childCount.n, 10) + 1}`;
  const child = await db.insert(
    `INSERT INTO job_cards (job_card_no, order_id, qty, dispatch_date, current_stage, punching, drawing_no, product_name, status, notes, uploaded_by, parent_job_card_id, order_item_id, file_path, file_name, original_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'qc_pending',$9,$10,$11,$12,$13,$14,$15)`,
    [childNo, jc.order_id, sr.qty, jc.dispatch_date, jc.current_stage || 0, jc.punching, jc.drawing_no, jc.product_name,
     `Partial dispatch of ${sr.qty} split from ${jc.job_card_no}. Reason: ${sr.reason}`, jc.uploaded_by, jc.id, jc.order_item_id,
     // Carry the parent's job-card document so the shopfloor can open it on the child too
     jc.file_path, jc.file_name, jc.original_name]
  );
  await db.run('UPDATE job_cards SET qty = qty - $1 WHERE id=$2', [sr.qty, jc.id]);
  await db.run('UPDATE job_card_split_requests SET status=$1, child_job_card_id=$2, approved_by=$3, approved_at=NOW() WHERE id=$4',
    ['approved', child.lastInsertRowid, req.user.id, sr.id]);

  if (sr.created_by) {
    await createNotification(db, {
      userId: sr.created_by, type: 'split_approved',
      title: `Partial dispatch approved — ${childNo}`,
      body: `${sr.qty} units split off as ${childNo} (now in QC). ${jc.job_card_no} continues with ${jc.qty - sr.qty}.`,
      link: `/job-cards/${child.lastInsertRowid}`, sourceUserId: req.user.id,
    });
  }
  await logActivity(jc.order_id, jc.id, 'split_approved', `Partial dispatch approved: ${sr.qty} → ${childNo}; ${jc.job_card_no} now ${jc.qty - sr.qty}`, req.user.id);
  res.json({ message: 'Approved', child_job_card_id: child.lastInsertRowid, child_job_card_no: childNo });
});

router.put('/split-requests/:reqId/reject', authenticate, authorize('owner'), async (req, res) => {
  const db = getDB();
  const reason = (req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A rejection reason is required' });
  const sr = await db.get("SELECT * FROM job_card_split_requests WHERE id=$1 AND status='pending'", [req.params.reqId]);
  if (!sr) return res.status(404).json({ error: 'Pending request not found' });
  await db.run("UPDATE job_card_split_requests SET status='rejected', rejection_reason=$1, approved_by=$2, approved_at=NOW() WHERE id=$3",
    [reason, req.user.id, sr.id]);
  const jc = await db.get('SELECT order_id, job_card_no FROM job_cards WHERE id=$1', [sr.job_card_id]);
  if (sr.created_by) {
    await createNotification(db, {
      userId: sr.created_by, type: 'split_rejected',
      title: `Partial dispatch rejected — ${jc?.job_card_no || ''}`,
      body: `Reason: ${reason}`, link: `/job-cards/${sr.job_card_id}`, sourceUserId: req.user.id,
    });
  }
  await logActivity(jc?.order_id, sr.job_card_id, 'split_rejected', `Partial dispatch rejected: ${reason}`, req.user.id);
  res.json({ message: 'Rejected' });
});

module.exports = router;
