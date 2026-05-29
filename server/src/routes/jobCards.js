const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadJobCard, uploadChecklistPhoto, uploadRejectionPhoto, deleteFromStorage } = require('../middleware/upload');

// Stages that must be done before Stage 28 (QC) can be triggered.
// Stage 13 is required only when Stage 12 is not done (hideIfDone logic).
const MANDATORY_STAGES = [1,3,4,5,6,7,8,9,10,11,12,14,15,16,18,19,20,22,23,24,25,26,27];

const TODAY = () => new Date().toISOString().split('T')[0];

// ── GET all job cards ─────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  const today = TODAY();
  const db = getDB();
  const cards = await db.all(`
    SELECT jc.*, o.order_code, c.customer_code, u.name as uploaded_by_name,
      (jc.dispatch_date::date - CURRENT_DATE) as days_until_dispatch,
      (SELECT COUNT(*) FROM production_daily_reports WHERE job_card_id = jc.id) as report_count,
      EXISTS(SELECT 1 FROM production_day_picks WHERE job_card_id = jc.id AND pick_date = $1) as picked_today
    FROM job_cards jc
    JOIN orders o ON jc.order_id = o.id
    JOIN customers c ON o.customer_id = c.id
    LEFT JOIN users u ON jc.uploaded_by = u.id
    ORDER BY jc.dispatch_date ASC
  `, [today]);
  res.json(cards);
});

// ── GET all stages with rejections (owner dashboard) ─────────────────────────
router.get('/rejections/all', authenticate, authorize('owner', 'admin'), async (req, res) => {
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
    WHERE pc.rejection_qty > 2
    ORDER BY pc.rejection_qty DESC, pc.done_at DESC
  `);
  res.json(rows);
});

// ── GET today's picks ─────────────────────────────────────────────────────────
router.get('/picks/today', authenticate, async (req, res) => {
  const today = TODAY();
  const picks = await getDB().all(`
    SELECT jc.*, o.order_code, c.customer_code,
      (jc.dispatch_date::date - CURRENT_DATE) as days_until_dispatch,
      EXISTS(
        SELECT 1 FROM production_daily_reports
        WHERE job_card_id = jc.id AND report_date = $1
      ) as has_report_today
    FROM production_day_picks pdp
    JOIN job_cards jc ON pdp.job_card_id = jc.id
    JOIN orders o ON jc.order_id = o.id
    JOIN customers c ON o.customer_id = c.id
    WHERE pdp.pick_date = $2
    ORDER BY jc.dispatch_date ASC
  `, [today, today]);
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

  jc.daily_reports = await db.all(`
    SELECT pr.*, u.name as reported_by_name
    FROM production_daily_reports pr
    LEFT JOIN users u ON pr.reported_by = u.id
    WHERE pr.job_card_id = $1
    ORDER BY pr.report_date DESC, pr.created_at DESC
  `, [req.params.id]);

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
  try {
    const r = await db.insert(`
      INSERT INTO job_cards (job_card_no, order_id, file_path, file_name, original_name, qty, dispatch_date, notes, punching, drawing_no, product_name, uploaded_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [
      job_card_no.toUpperCase(), parseInt(order_id, 10),
      req.file?.storagePath || null, req.file?.filename || null, req.file?.originalname || null,
      qty || null, dispatch_date, notes || null,
      punching || null, drawing_no || null, product_name || null,
      req.user.id
    ]);

    const existing = await db.get('SELECT COUNT(*) as c FROM job_cards WHERE order_id=$1', [order_id]);
    if (parseInt(existing.c, 10) <= 1) {
      await db.run("UPDATE orders SET status='job_card_created' WHERE id=$1 AND status='approved'", [order_id]);
    }

    await logActivity(order_id, r.lastInsertRowid, 'job_card_created', `Job Card ${job_card_no} uploaded`, req.user.id);
    res.status(201).json({ id: r.lastInsertRowid });
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

// ── DELETE unpick ─────────────────────────────────────────────────────────────
router.delete('/:id/pick', authenticate, authorize('production', 'owner', 'admin'), async (req, res) => {
  await getDB().run(
    'DELETE FROM production_day_picks WHERE job_card_id=$1 AND pick_date=$2',
    [req.params.id, TODAY()]
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

// ── Helper: recompute job card status + current_stage ─────────────────────────
async function updateJobCardAfterStageChange(db, jobCardId, userId) {
  const maxRow = await db.get(
    'SELECT MAX(stage_no) as m FROM production_checklist WHERE job_card_id=$1 AND done=1',
    [jobCardId]
  );
  const maxStage = maxRow?.m || 0;

  const stage28 = (await db.get(
    'SELECT done FROM production_checklist WHERE job_card_id=$1 AND stage_no=28',
    [jobCardId]
  ))?.done;

  const stage29 = (await db.get(
    'SELECT done FROM production_checklist WHERE job_card_id=$1 AND stage_no=29',
    [jobCardId]
  ))?.done;

  let newStatus;
  if (stage29)       newStatus = 'dispatched';
  else if (stage28)  newStatus = 'qc_pending';
  else if (maxStage) newStatus = 'in_progress';
  else               newStatus = 'pending';

  const jc = await db.get('SELECT * FROM job_cards WHERE id=$1', [jobCardId]);
  if (!jc) return;

  await db.run('UPDATE job_cards SET current_stage=$1, status=$2 WHERE id=$3', [maxStage, newStatus, jobCardId]);

  if (newStatus !== jc.status) {
    if (newStatus === 'qc_pending') {
      await logActivity(jc.order_id, jobCardId, 'status_changed',
        `Job card ${jc.job_card_no} moved to QC Pending`, userId);
    } else if (newStatus === 'dispatched') {
      await logActivity(jc.order_id, jobCardId, 'dispatched',
        `Job card ${jc.job_card_no} dispatched`, userId);

      const orderCards = await db.all(
        'SELECT status FROM job_cards WHERE order_id=$1',
        [jc.order_id]
      );
      const allDispatched = orderCards.length > 0 && orderCards.every(c => c.status === 'dispatched');
      if (allDispatched) {
        await db.run("UPDATE orders SET status='dispatched' WHERE id=$1", [jc.order_id]);
        await logActivity(jc.order_id, null, 'status_changed',
          `All job cards dispatched — Order marked Dispatched`, userId);
      }
    }
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

  const map = {};
  rows.forEach(r => { map[r.stage_no] = r; });
  const stages = Array.from({ length: 29 }, (_, i) => {
    const n = i + 1;
    return map[n] || {
      stage_no: n, done: 0, value1: null, value2: null,
      photo_file: null, photo_original_name: null, done_at: null,
      rejection_qty: 0, remade_qty: 0,
      rejection_photo_file: null, rejection_photo_original_name: null,
      worker_name: null, scrap_value: null,
    };
  });
  res.json({ stages, hold: activeHold || null });
});

// ── PUT update a checklist stage ──────────────────────────────────────────────
router.put('/:id/checklist/:stage', authenticate, authorize('production', 'owner', 'admin'), async (req, res) => {
  const jobCardId = parseInt(req.params.id, 10);
  const stageNo   = parseInt(req.params.stage, 10);
  if (isNaN(stageNo) || stageNo < 1 || stageNo > 29) return res.status(400).json({ error: 'Invalid stage' });

  const { done, value1, value2, rejection_qty, remade_qty, worker_name, scrap_value } = req.body;
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
    // Gate stage 29 (Dispatch): QC must be approved first
    if (stageNo === 29 && jcStatus !== 'qc_approved') {
      return res.status(400).json({
        error: 'Cannot dispatch — QC must be approved by the QC inspector first.',
        code: 'QC_NOT_APPROVED'
      });
    }
  }

  const rejQty = parseInt(rejection_qty, 10) || 0;
  const remQty = parseInt(remade_qty, 10) || 0;

  // Gate stage 28: all mandatory stages must be complete
  if (stageNo === 28 && done) {
    const stage12Row = await db.get(
      'SELECT done FROM production_checklist WHERE job_card_id=$1 AND stage_no=12',
      [jobCardId]
    );
    const stage12Done = stage12Row?.done;
    const mandatory = [...MANDATORY_STAGES];
    if (!stage12Done) mandatory.push(13);

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

  // Require rejection photo when rejection > 2
  if (done && rejQty > 2) {
    const existing = await db.get(
      'SELECT rejection_photo_file FROM production_checklist WHERE job_card_id=$1 AND stage_no=$2',
      [jobCardId, stageNo]
    );
    if (!existing?.rejection_photo_file) {
      return res.status(400).json({
        error: 'Upload rejection photo before marking done (rejection > 2 pieces).',
        code: 'REJECTION_PHOTO_REQUIRED'
      });
    }
  }

  const now = new Date().toISOString();

  await db.run(`
    INSERT INTO production_checklist
      (job_card_id, stage_no, done, value1, value2, rejection_qty, remade_qty, worker_name, scrap_value, done_at, updated_by, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
    ON CONFLICT(job_card_id, stage_no) DO UPDATE SET
      done          = EXCLUDED.done,
      value1        = EXCLUDED.value1,
      value2        = EXCLUDED.value2,
      rejection_qty = EXCLUDED.rejection_qty,
      remade_qty    = EXCLUDED.remade_qty,
      worker_name   = EXCLUDED.worker_name,
      scrap_value   = EXCLUDED.scrap_value,
      done_at = CASE
        WHEN EXCLUDED.done = 1 AND production_checklist.done_at IS NULL THEN EXCLUDED.done_at
        WHEN EXCLUDED.done = 0 THEN NULL
        ELSE production_checklist.done_at
      END,
      updated_by  = EXCLUDED.updated_by,
      updated_at  = NOW()
  `, [jobCardId, stageNo, done ? 1 : 0, value1 ?? null, value2 ?? null, rejQty, remQty,
    worker_name || null, scrap_value || null, done ? now : null, req.user.id]);

  if (done && rejQty > 2) {
    await triggerHold(db, jobCardId, stageNo, rejQty, req.user.id);
    return res.json({ message: 'Stage updated. Job card placed on hold.', on_hold: true });
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

// ── POST upload stage photo (stages 24 = Cleaning, 29 = Dispatch) ─────────────
router.post('/:id/checklist/:stage/photo', authenticate, authorize('production', 'owner', 'admin'),
  ...uploadChecklistPhoto, async (req, res) => {
    const jobCardId = parseInt(req.params.id, 10);
    const stageNo   = parseInt(req.params.stage, 10);
    if (![24, 29].includes(stageNo)) return res.status(400).json({ error: 'Only stages 24 and 29 support stage photos' });
    if (!req.file) return res.status(400).json({ error: 'File required' });

    const db = getDB();

    const jcRow = await db.get('SELECT status FROM job_cards WHERE id=$1', [jobCardId]);
    const jcStatus = jcRow?.status;
    if (jcStatus === 'on_hold') {
      return res.status(400).json({ error: 'Work is on hold. Owner must approve before continuing.', code: 'ON_HOLD' });
    }
    if (stageNo === 29 && jcStatus !== 'qc_approved') {
      return res.status(400).json({
        error: 'Cannot dispatch — QC must be approved by the QC inspector first.',
        code: 'QC_NOT_APPROVED'
      });
    }

    const rejQty = parseInt(req.body.rejection_qty, 10) || 0;
    const remQty = parseInt(req.body.remade_qty, 10) || 0;
    const workerName = req.body.worker_name || null;
    const scrapVal = req.body.scrap_value || null;

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

    const dispatchedQty = stageNo === 29 ? (parseInt(req.body.dispatched_qty, 10) || null) : null;
    if (stageNo === 29 && !dispatchedQty) {
      return res.status(400).json({ error: 'Dispatched quantity is required for dispatch stage.' });
    }

    await db.run(`
      INSERT INTO production_checklist
        (job_card_id, stage_no, done, photo_file, photo_original_name, rejection_qty, remade_qty, dispatched_qty, worker_name, scrap_value, done_at, updated_by, updated_at)
      VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
      ON CONFLICT(job_card_id, stage_no) DO UPDATE SET
        photo_file          = EXCLUDED.photo_file,
        photo_original_name = EXCLUDED.photo_original_name,
        rejection_qty       = EXCLUDED.rejection_qty,
        remade_qty          = EXCLUDED.remade_qty,
        dispatched_qty      = EXCLUDED.dispatched_qty,
        worker_name         = EXCLUDED.worker_name,
        scrap_value         = EXCLUDED.scrap_value,
        done                = 1,
        done_at             = COALESCE(production_checklist.done_at, EXCLUDED.done_at),
        updated_by          = EXCLUDED.updated_by,
        updated_at          = NOW()
    `, [jobCardId, stageNo, req.file.filename, req.file.originalname, rejQty, remQty, dispatchedQty, workerName, scrapVal, now, req.user.id]);

    if (rejQty > 2) {
      await triggerHold(db, jobCardId, stageNo, rejQty, req.user.id);
      return res.json({ file_name: req.file.filename, on_hold: true });
    }

    await updateJobCardAfterStageChange(db, jobCardId, req.user.id);
    res.json({ file_name: req.file.filename, original_name: req.file.originalname });
  }
);

// ── PUT approve hold (owner/admin) ────────────────────────────────────────────
router.put('/:id/hold/approve', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const db = getDB();
  const jc = await db.get('SELECT * FROM job_cards WHERE id=$1', [req.params.id]);
  if (!jc) return res.status(404).json({ error: 'Not found' });
  if (jc.status !== 'on_hold') return res.status(400).json({ error: 'Job card is not on hold' });

  await db.run(`
    UPDATE job_card_holds SET status='approved', approved_by=$1, approved_at=NOW()
    WHERE job_card_id=$2 AND status='pending'
  `, [req.user.id, req.params.id]);

  await db.run("UPDATE job_cards SET status='in_progress' WHERE id=$1", [req.params.id]);
  await logActivity(jc.order_id, jc.id, 'status_changed',
    `Job card ${jc.job_card_no} hold approved by ${req.user.name} — work resumed`, req.user.id);

  res.json({ message: 'Hold approved, work resumed' });
});

module.exports = router;
