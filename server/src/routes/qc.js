const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize, withCustomerVisibility } = require('../middleware/auth');
const { uploadQC, uploadChecklistPhoto } = require('../middleware/upload');
const { settleItemInventory, resolveJobCardItemId, reverseReworkDeposit, deductPartialAtQC, deductFinsByLength, fgTakes, FINS_CODES, STAGE_CATEGORY_MAP } = require('../lib/inventoryDeduction');
const rework = require('../lib/rework');
const { takeLastStage } = require('../lib/lastStageTake');
const { consumeFifo, returnFifo, invByCode, pvcCodeFor, MGO_CODE } = require('../lib/materialDeduction');
const { recordMove, r4 } = require('../lib/stockLedger');
const { clientDb } = require('../lib/bomCorrection');
const { isCountedItem, isHeldCard } = require('../lib/countedStock');
const { readTerminals, noTerminals, isTerminalCategory } = require('../lib/terminals');

// Stage names, for readable activity-log lines when work is sent back to a
// particular stage. Mirrors PRODUCTION_STAGES in client/src/lib/utils.js.
const STAGE_NAMES = {
  1: 'Coil', 2: 'Coil + Tube Cutting', 3: 'Ohms', 4: 'Spot', 5: 'Tube Cutting',
  6: 'Filling', 7: 'HV + Light Check', 8: 'Draw', 9: 'HV + Light Check',
  10: 'Straightening', 11: 'Trimming', 12: 'Spot Annealing or Furnace Annealing',
  13: 'Buffing', 14: 'Bending', 15: 'Brazing', 16: 'In Plating',
  17: 'Plating Completed', 18: 'Heater Cleaning', 19: 'Overnight Oven',
  20: 'HV + Light Check', 21: 'Nipple Press', 22: '3 Hours Oven', 23: 'Sealing',
  24: 'HV + Light Check', 25: 'Cleaning', 26: 'Nut Washer', 27: 'HV + Light Check',
  28: 'Megger', 29: 'Ready in Production', 30: 'Kharoch Process',
};

// Deduct the job card's order item from stock once it qualifies (split-aware).
// Wrapped so a failure here can never block QC. No-op when the item is not yet
// fully settled or already deducted. Only for cards made before Inventory QC
// (no last-stage take): a card in the new flow took its list at its last stage
// and is settled at Inventory QC done (owner, 6 Oct 2026).
async function settleAfterQC(db, jc, userId) {
  try {
    // Fins consume by this card's stage-8 tube length, not by BOM qty
    await deductFinsByLength(db, jc, userId);
    // Split items: this card's QC-approved share of the non-stage BOM goes out now
    await deductPartialAtQC(db, jc, userId);
    const itemId = await resolveJobCardItemId(db, jc);
    if (!itemId) return;
    let orderCode = jc.order_code;
    if (!orderCode) {
      const o = await db.get('SELECT order_code FROM orders WHERE id=$1', [jc.order_id]);
      orderCode = o?.order_code;
    }
    await settleItemInventory(db, itemId, userId, orderCode || `Order #${jc.order_id}`);
  } catch (e) { console.error('[qc] settle inventory failed:', e.message); }
}

// One rule for an order's status, and it lives in jobCards.js. This file used
// to carry its own copy from before Finished Goods and partial dispatch
// existed: no FG awareness, no 'partially_dispatched', and 'qc_approved'
// ranked above 'dispatched' — so every QC approval here could flip an order
// with one card shipped and one still at QC back to "QC Approved". Five live
// orders drifted that way.
const { syncOrderStatus } = require('./jobCards');

// A job card with the order and customer details QC and Finished Goods need.
function loadCardFull(db, id) {
  return db.get(`
    SELECT jc.*, o.order_code, o.order_type, c.customer_code, c.name as customer_name
    FROM job_cards jc
    JOIN orders o ON jc.order_id = o.id
    JOIN customers c ON o.customer_id = c.id
    WHERE jc.id = $1
  `, [id]);
}

// Technical specs for a Finished Goods row: first assembly, falling back to the
// order item — many cards never fill assemblies, but the order item always has
// the specs.
async function productSpecs(db, jc) {
  const asm = await db.get(
    'SELECT * FROM job_card_assemblies WHERE job_card_id=$1 ORDER BY assembly_no ASC LIMIT 1',
    [jc.id]
  );
  const oi = jc.order_item_id
    ? await db.get('SELECT * FROM order_items WHERE id=$1', [jc.order_item_id])
    : null;
  return {
    product_code: oi?.product_code || null,
    tube_material: asm?.tube_material || oi?.tube_material || null,
    tube_diameter: asm?.tube_diameter_mm || oi?.tube_diameter || null,
    wattage: asm?.wattage_actual || oi?.wattage || null,
    voltage: asm?.voltage_actual || oi?.voltage || null,
    plating: asm?.plating_description || oi?.plating_instructions || null,
  };
}

// Helper: strip trailing -N suffix to get the base drawing number for grouping
// e.g. "PT-UTYPE-12U-500W-1" → "PT-UTYPE-12U-500W"
function baseDrawingNo(drawingNo) {
  if (!drawingNo) return null;
  return drawingNo.replace(/-\d+$/, '');
}

// Create or add to a finished goods entry grouped by base drawing number.
// One row per unique base_drawing_no — works like inventory stock. Used when
// Inventory QC is done and Product QC sent pieces to Finished Goods.
// jc: a card from loadCardFull.
async function createFinishedGoodsEntry(db, { jc, specs, qty, location = null, splitNotes = null, userId }) {
  const baseNo = baseDrawingNo(jc.drawing_no);

  // Check if a product entry already exists for this base drawing number
  const existing = baseNo
    ? await db.get(
        `SELECT id FROM finished_goods WHERE base_drawing_no = $1 LIMIT 1`,
        [baseNo]
      )
    : null;

  let fgId;
  if (existing) {
    // Add stock to the existing product entry (update the stored location
    // label to the latest) and backfill any specs it's still missing.
    await db.run(
      `UPDATE finished_goods SET qty_in = qty_in + $1, qty_available = qty_available + $1, location = COALESCE($3, location),
         product_code         = COALESCE(product_code, $4),
         tube_material        = COALESCE(tube_material, $5),
         tube_diameter        = COALESCE(tube_diameter, $6),
         wattage              = COALESCE(wattage, $7),
         voltage              = COALESCE(voltage, $8),
         plating_instructions = COALESCE(plating_instructions, $9)
       WHERE id = $2`,
      [qty, existing.id, location, specs.product_code, specs.tube_material, specs.tube_diameter, specs.wattage, specs.voltage, specs.plating]
    );
    fgId = existing.id;
  } else {
    // Create the product master row (product-centric, not order-centric)
    const fg = await db.insert(`
      INSERT INTO finished_goods
        (job_card_id, order_id, order_code, order_type, customer_code, customer_name,
         drawing_no, base_drawing_no, product_code, tube_material, tube_diameter, wattage, voltage, plating_instructions,
         qty_in, qty_available, notes, location, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16,$17,$18)
    `, [
      jc.id, jc.order_id, jc.order_code, jc.order_type,
      jc.customer_code, jc.customer_name,
      jc.drawing_no || null, baseNo,
      specs.product_code,
      specs.tube_material, specs.tube_diameter,
      specs.wattage, specs.voltage,
      specs.plating,
      qty, null, location, userId,
    ]);
    fgId = fg.lastInsertRowid;
  }

  // Log this inward batch with full traceability (job card + order + customer + location)
  await db.insert(
    `INSERT INTO finished_goods_log
       (finished_good_id, movement_type, qty, job_card_no, order_code, customer_code, reference, notes, location, created_by)
     VALUES ($1,'inward',$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      fgId, qty,
      jc.job_card_no, jc.order_code, jc.customer_code,
      jc.job_card_no,   // reference = job card number for easy lookup
      splitNotes || null,
      location,
      userId,
    ]
  );

  return fgId;
}

router.get('/', authenticate, authorize('design', 'owner', 'admin'), async (req, res) => {
  const canSeeNames = withCustomerVisibility(req);
  const cards = await getDB().all(
    `SELECT jc.*, o.order_code, o.order_type, c.customer_code, ${canSeeNames ? "c.name as customer_name," : ''}
       u.name as uploaded_by_name,
       (SELECT COUNT(*) FROM qc_reports WHERE job_card_id = jc.id) as report_count,
       (jc.dispatch_date::date - CURRENT_DATE) as days_until_dispatch,
       GREATEST(
         jc.qty
           - COALESCE((SELECT SUM(rejection_qty) FROM production_checklist WHERE job_card_id = jc.id), 0)
           + LEAST(
               COALESCE((SELECT SUM(remade_qty)    FROM production_checklist WHERE job_card_id = jc.id), 0),
               COALESCE((SELECT SUM(rejection_qty) FROM production_checklist WHERE job_card_id = jc.id), 0)
             ),
         0
       ) as net_qty,
       COALESCE((SELECT SUM(rejection_qty) FROM production_checklist WHERE job_card_id = jc.id), 0) as total_rejected,
       COALESCE((SELECT SUM(remade_qty)    FROM production_checklist WHERE job_card_id = jc.id), 0) as total_remade,
       cq_return.query_no as return_query_no,
       cq_return.id as return_query_id,
       cq_return.subject as return_query_subject,
       cq_return.description as return_query_description,
       cq_return.category as return_query_category,
       cq_return.priority as return_query_priority,
       cq_return.return_type as return_query_type,
       cq_return.return_status as return_query_return_status,
       cq_return.return_coupon_no as return_coupon_no,
       cq_return.debit_note_no as return_debit_note_no,
       cq_return.created_at as return_query_created_at
     FROM job_cards jc
     JOIN orders o ON jc.order_id = o.id
     JOIN customers c ON o.customer_id = c.id
     LEFT JOIN users u ON jc.uploaded_by = u.id
     LEFT JOIN customer_queries cq_return
       ON cq_return.job_card_id = jc.id
       AND cq_return.status = 'product_return'
       AND cq_return.return_status IN ('qc_check', 'in_repair')
     WHERE (
       jc.status = 'qc_pending'
       OR (
         -- Catch stuck cards: stage 29 done but status didn't update correctly
         jc.status = 'in_progress'
         AND EXISTS (
           SELECT 1 FROM production_checklist
           WHERE job_card_id = jc.id AND stage_no = 29 AND done = 1
         )
       )
     )
     ORDER BY jc.dispatch_date ASC`
  );
  res.json(cards);
});

router.get('/:id/reports', authenticate, authorize('design', 'owner', 'admin', 'production'), async (req, res) => {
  const reports = await getDB().all(
    `SELECT qr.*, u.name as created_by_name
     FROM qc_reports qr
     LEFT JOIN users u ON qr.created_by = u.id
     WHERE qr.job_card_id = $1
     ORDER BY qr.created_at DESC`,
    [req.params.id]
  );
  res.json(reports);
});

router.post('/:id/report', authenticate, authorize('design', 'owner', 'admin'),
  ...uploadQC, async (req, res) => {
    const { observations, corrective_action, product_weight } = req.body;
    const db = getDB();
    const jc = await db.get('SELECT * FROM job_cards WHERE id=$1', [req.params.id]);
    if (!jc) return res.status(404).json({ error: 'Not found' });
    if (jc.status !== 'qc_pending') return res.status(400).json({ error: 'Job card is not in QC Pending state' });

    if (!product_weight || isNaN(parseFloat(product_weight))) {
      return res.status(400).json({ error: 'Weight of 1 product is required' });
    }

    const r = await db.insert(
      `INSERT INTO qc_reports (job_card_id, result, observations, corrective_action, product_weight, file_path, file_name, created_by)
       VALUES ($1,'approved',$2,$3,$4,$5,$6,$7)`,
      [req.params.id, observations||null, corrective_action||null,
       parseFloat(product_weight),
       req.file?.storagePath||null, req.file?.filename||null, req.user.id]
    );

    await logActivity(jc.order_id, jc.id, 'qc_report', `QC report uploaded for ${jc.job_card_no}`, req.user.id);
    res.status(201).json({ id: r.lastInsertRowid, file_name: req.file?.filename });
  }
);

// ── Product QC approve ────────────────────────────────────────────────────────
// Body for Local HE / Export HE:    {}
// Body for IO:                       { io_qty: N }
// Body for IO+Export/IO+Local:       { io_qty: N, dispatch_qty: N } + required qc_photo (field: file)
// Approval clears the rejection flag on every branch below. It used to clear
// only when the floor re-ticked stage 29 — fine while every reject went back
// to the floor, but a card sent back to QC for re-check never passes there,
// and would keep "QC rejected" and the old notes on the production screens
// after it had been approved.
//
// Product QC → Inventory QC → Dispatch (owner, 6 Oct 2026). Product QC keeps
// every check and works out where the pieces go exactly as before, but only
// RECORDS it (route, FG qty, dispatch qty, FG location): the card moves to
// 'inventory_qc', and the Finished Goods intake and the send to dispatch happen
// at "Inventory QC done". Remake extras and rework pieces are entered at
// Inventory QC now, not here.
router.put('/:id/approve', authenticate, authorize('design', 'owner', 'admin'), ...uploadChecklistPhoto, async (req, res) => {
  const db = getDB();

  // Fetch job card with order + customer info
  const jc = await loadCardFull(db, req.params.id);

  if (!jc) return res.status(404).json({ error: 'Not found' });
  if (!req.file) return res.status(400).json({ error: 'A photo of the approved material is required' });
  // Accept both qc_pending and in_progress+stage29done (stuck cards)
  const stage29Done = await db.get(
    'SELECT 1 FROM production_checklist WHERE job_card_id=$1 AND stage_no=29 AND done=1',
    [req.params.id]
  );
  if (jc.status !== 'qc_pending' && !(jc.status === 'in_progress' && stage29Done)) {
    return res.status(400).json({ error: 'Job card is not in QC Pending state' });
  }

  const reportRow = await db.get('SELECT COUNT(*) AS c FROM qc_reports WHERE job_card_id=$1', [req.params.id]);
  if (parseInt(reportRow.c, 10) === 0) return res.status(400).json({ error: 'Upload a QC report before approving' });

  const { io_qty, dispatch_qty, heater_destination, fg_location } = req.body;
  const orderType = jc.order_type || 'local_he';
  const fgLocation = (fg_location || '').trim() || null; // storage location for FG intake (optional label)

  // Calculate net finished qty from production (original qty - total rejections + remade)
  const prodRow = await db.get(`
    SELECT
      COALESCE(SUM(rejection_qty), 0) as total_rejected,
      COALESCE(SUM(remade_qty), 0)    as total_remade
    FROM production_checklist
    WHERE job_card_id = $1
  `, [req.params.id]);
  // Remade replaces rejected pieces — capped so it never adds beyond the rejections
  const netQty = Math.max(
    (jc.qty || 0) - prodRow.total_rejected + Math.min(Number(prodRow.total_remade), Number(prodRow.total_rejected)),
    0
  );

  // ── Route based on order type + heater_destination ────────────────────────
  // io_* combo orders honor the QC user's destination choice too; the legacy
  // forced-split branch below only handles old calls without heater_destination.
  // plan: { route, fgQty, dispQty, splitNotes } — recorded now, carried out at
  // Inventory QC done.
  let plan;
  if (netQty === 0) {
    // Every piece was rejected in production: there is nothing to route, so no
    // destination is asked. The card still goes through Inventory QC (its
    // material was used and must be settled) and then closes as Rejected —
    // "the one that has zero dispatchable will just say rejected after the
    // inventory is approved" (owner, 7 Oct 2026). Nothing is re-made
    // automatically: "just close it, I will decide".
    plan = { route: 'rejected', fgQty: 0, dispQty: 0 };
  } else if (orderType === 'local_he' || orderType === 'export_he' ||
      ((orderType === 'io_export_he' || orderType === 'io_local_he') && heater_destination)) {
    const dest = heater_destination || 'dispatch';

    if (dest === 'finished_goods') {
      const qty = io_qty != null ? parseInt(io_qty) : netQty;
      if (!qty || qty <= 0) return res.status(400).json({ error: 'Finished Goods quantity must be greater than 0' });
      plan = { route: 'finished_goods', fgQty: qty, dispQty: 0 };
    } else if (dest === 'both') {
      const parsedFgQty  = parseInt(io_qty);
      const parsedDispQty = parseInt(dispatch_qty);
      if (!parsedFgQty  || parsedFgQty  <= 0) return res.status(400).json({ error: 'Finished Goods quantity is required' });
      if (!parsedDispQty || parsedDispQty <= 0) return res.status(400).json({ error: 'Dispatch quantity is required' });
      if (parsedFgQty + parsedDispQty > netQty) {
        return res.status(400).json({ error: `Total (${parsedFgQty + parsedDispQty}) exceeds net finished qty (${netQty})` });
      }
      plan = { route: 'both', fgQty: parsedFgQty, dispQty: parsedDispQty,
        splitNotes: `Split: ${parsedFgQty} Finished Goods + ${parsedDispQty} dispatch` };
    } else {
      // Default: dispatch — entire net qty goes to dispatch
      const dispQty = parseInt(dispatch_qty) > 0 ? parseInt(dispatch_qty) : netQty;
      plan = { route: 'dispatch', fgQty: 0, dispQty };
    }
  } else if (orderType === 'inventory_order') {
    const qty = io_qty != null ? parseInt(io_qty) : netQty;
    if (!qty || qty <= 0) return res.status(400).json({ error: 'IO quantity must be greater than 0' });
    plan = { route: 'finished_goods', fgQty: qty, dispQty: 0 };
  } else if (orderType === 'io_export_he' || orderType === 'io_local_he') {
    const parsedIoQty = parseInt(io_qty);
    const parsedDispatchQty = parseInt(dispatch_qty);
    if (!parsedIoQty || parsedIoQty <= 0) return res.status(400).json({ error: 'IO quantity is required' });
    if (!parsedDispatchQty || parsedDispatchQty <= 0) return res.status(400).json({ error: 'Dispatch quantity is required' });
    if (parsedIoQty + parsedDispatchQty > netQty) {
      return res.status(400).json({ error: `Total (${parsedIoQty + parsedDispatchQty}) exceeds net finished qty (${netQty})` });
    }
    plan = { route: 'split', fgQty: parsedIoQty, dispQty: parsedDispatchQty,
      splitNotes: `Split: ${parsedIoQty} IO + ${parsedDispatchQty} dispatch` };
  } else {
    // Fallback (finished-goods orders and anything else): the net qty to dispatch
    plan = { route: 'dispatch', fgQty: 0, dispQty: netQty };
  }

  await db.run(
    `UPDATE job_cards SET status='inventory_qc', qc_rejected=FALSE, qc_rejection_notes=NULL,
       qc_route=$1, qc_fg_qty=$2, qc_dispatch_qty=$3, qc_fg_location=$4, qc_split_notes=$5,
       product_qc_at=NOW(), product_qc_by=$6
     WHERE id=$7`,
    [plan.route, plan.fgQty, plan.dispQty, fgLocation, plan.splitNotes || null, req.user.id, req.params.id]);

  // Catch-up: a card already past its last stage before this went live never
  // had its last-stage take — it happens now, so QC sees it at Inventory QC.
  // A no-op for every card that took it at its last stage.
  try { await takeLastStage(db, jc, req.user.id); }
  catch (e) { console.error('[qc] last-stage take at Product QC failed:', e.message); }

  await logActivity(jc.order_id, jc.id, 'status_changed',
    plan.route === 'rejected'
      ? `Job card ${jc.job_card_no} Product QC: all ${jc.qty} pieces rejected — waiting for Inventory QC, then closed as Rejected`
      : `Job card ${jc.job_card_no} Product QC approved — ${plan.dispQty} to dispatch / ${plan.fgQty} to Finished Goods — waiting for Inventory QC`,
    req.user.id);
  await syncOrderStatus(db, jc.order_id, req.user.id);
  res.json({
    message: plan.route === 'rejected'
      ? 'All pieces rejected — waiting for Inventory QC, then the card closes as Rejected'
      : 'Product QC approved — waiting for Inventory QC',
    status: 'inventory_qc',
    route: plan.route, dispatch_qty: plan.dispQty, fg_qty: plan.fgQty,
    // the names the old response used, for callers that read them
    qty: plan.route === 'finished_goods' ? plan.fgQty : plan.dispQty, io_qty: plan.fgQty,
  });
});

router.put('/:id/reject', authenticate, authorize('design', 'owner', 'admin'), async (req, res) => {
  const { notes } = req.body;
  const db = getDB();
  const jc = await db.get('SELECT * FROM job_cards WHERE id=$1', [req.params.id]);
  if (!jc) return res.status(404).json({ error: 'Not found' });
  const stage29DoneR = await db.get(
    'SELECT 1 FROM production_checklist WHERE job_card_id=$1 AND stage_no=29 AND done=1',
    [req.params.id]
  );
  // Reversing an ALREADY-APPROVED card is owner-only: it undoes a completed QC
  // decision, so it is deliberately not something design/admin can do.
  const isReversal = jc.status === 'qc_approved';
  if (isReversal && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Only the owner can reject an already-approved QC' });
  }
  if (!isReversal && jc.status !== 'qc_pending' && !(jc.status === 'in_progress' && stage29DoneR)) {
    return res.status(400).json({ error: 'Job card is not in QC Pending state' });
  }
  if (jc.status === 'dispatched') {
    return res.status(400).json({ error: 'This job card is already dispatched' });
  }

  // A reversal takes back what this card deposited into rework bins; refused
  // if another order has already claimed those pieces (nothing written yet).
  // Not for a card through Inventory QC: that was the final change to its
  // inventory, rework bin included (owner, 6 Oct 2026).
  if (isReversal && !jc.inventory_qc_at) {
    try { await reverseReworkDeposit(db, jc, req.user.id); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }

  // Where the rejected card goes. 'production' (the default, and the only
  // behaviour until 24 Sep 2026) re-opens the checklist from return_to_stage
  // and hands the card back to the floor. 'qc' keeps the work as it is and
  // puts the card straight back in the QC queue — for a re-inspection, a
  // re-done report, or a reversal that should be looked at again rather than
  // rebuilt. Nothing on the checklist moves in that case.
  const sendTo = req.body.send_to === 'qc' ? 'qc' : 'production';
  const backTo = parseInt(req.body.return_to_stage, 10);
  const returnToStage = Number.isInteger(backTo) && backTo >= 1 && backTo <= 29 ? backTo : 29;

  if (sendTo === 'qc') {
    await db.run(`UPDATE job_cards SET status='qc_pending' WHERE id=$1`, [req.params.id]);
  } else {
    // Re-open the stages that have to be redone (stage 29 at minimum, so
    // production can re-submit to QC after fixing).
    await db.run(
      `UPDATE production_checklist SET done=0, done_at=NULL WHERE job_card_id=$1 AND stage_no >= $2`,
      [req.params.id, returnToStage]
    );

    // Back to production. current_stage is the LAST COMPLETED stage (same rule as
    // updateJobCardAfterStageChange), so after re-opening it recomputes to the
    // stage just before the one being redone — the card then presents that stage
    // as the next thing to do.
    const maxDone = await db.get(
      'SELECT MAX(stage_no) AS m FROM production_checklist WHERE job_card_id=$1 AND done=1 AND stage_no < 30',
      [req.params.id]);
    await db.run(`UPDATE job_cards SET status='in_progress', current_stage=$2 WHERE id=$1`,
      [req.params.id, maxDone?.m || 0]);
  }

  // Flag the rejection for production to see (graceful — columns may not exist on first deploy)
  try {
    await db.run(
      `UPDATE job_cards SET qc_rejected=TRUE, qc_rejection_notes=$1 WHERE id=$2`,
      [notes || null, req.params.id]
    );
    // A reversal must also drop the routing decision the approval recorded,
    // or the card would still look destined for dispatch / finished goods.
    if (isReversal) {
      await db.run(
        `UPDATE job_cards SET qc_route=NULL, qc_dispatch_qty=NULL, qc_fg_qty=NULL, qc_fg_location=NULL, qc_split_notes=NULL WHERE id=$1`,
        [req.params.id]);
    }
  } catch (_) { /* column may not exist yet — ignore, core flow already done */ }

  const stageName = STAGE_NAMES[returnToStage] || `stage ${returnToStage}`;
  const where = sendTo === 'qc' ? 'sent back to QC for re-check' : `returned to production at ${stageName}`;
  await logActivity(jc.order_id, jc.id, 'status_changed',
    `Job card ${jc.job_card_no} QC ${isReversal ? 'approval reversed' : 'Rejected'} — ${where}. ${notes || ''}`,
    req.user.id);
  await syncOrderStatus(db, jc.order_id, req.user.id);
  // Only settle inventory when the goods are staying finished — a re-check,
  // whether it waits in the QC queue or goes back to the floor at stage 29
  // untouched. Sending work back to an earlier stage means it is not finished,
  // so nothing should be consumed yet.
  // A card that took its list at its last stage (owner, 6 Oct 2026) takes and
  // gives back nothing here: rejected and remade pieces need nothing extra, and
  // any real difference is corrected at Inventory QC.
  if (!jc.last_stage_taken_at && (sendTo === 'qc' || returnToStage === 29)) await settleAfterQC(db, jc, req.user.id);
  res.json({ message: `QC rejected — ${where}` });
});

// Inventory (BOM) the job card's order item consumes — shown at QC approval so
// design can confirm or edit it before approving. No cost fields (design-safe).
router.get('/:id/bom', authenticate, authorize('design', 'owner', 'admin'), async (req, res) => {
  const db = getDB();
  const jc = await db.get(
    'SELECT id, order_id, drawing_no, order_item_id FROM job_cards WHERE id=$1', [req.params.id]
  );
  if (!jc) return res.status(404).json({ error: 'Not found' });
  const itemId = await resolveJobCardItemId(db, jc);
  if (!itemId) {
    return res.json({ order_id: jc.order_id, item_id: null, drawing_number: jc.drawing_no || null,
      inventory_items: [], deducted: false, is_split: false });
  }
  const item = await db.get('SELECT id, drawing_number, inventory_deducted FROM order_items WHERE id=$1', [itemId]);
  const inventory_items = await db.all(
    `SELECT ii.id, ii.item_code, ii.name, ii.unit, TRIM(ii.category) AS category, oii.qty, COALESCE(oii.qty_deducted,0) AS qty_deducted,
            COALESCE(oii.rework_qty,0) AS rework_qty, COALESCE(oii.rework_deducted,0) AS rework_deducted,
            COALESCE((SELECT b.qty FROM inventory_rework_bins b WHERE b.item_id = ii.id), 0) AS rework_bin
     FROM order_item_inventory oii JOIN inventory_items ii ON ii.id = oii.inventory_item_id
     WHERE oii.order_item_id=$1 ORDER BY ii.item_code`,
    [itemId]
  );
  // Has this card already deposited? Then the block shows read-only.
  const deposited = await db.all(
    `SELECT item_id AS inventory_item_id, SUM(qty) AS qty FROM inventory_rework_moves WHERE job_card_id=$1 AND kind='deposit' GROUP BY item_id`,
    [req.params.id]);
  const cardCount = await db.get('SELECT COUNT(*) AS n FROM job_cards WHERE order_item_id=$1', [itemId]);
  // A finished-goods card fits parts onto a heater that already exists: only the
  // prep parts are taken at QC (owner, 2 Oct 2026 — lib/inventoryDeduction.js
  // FG_PREP_CATEGORIES). The QC screen lists the rest as "not taken".
  const card = await db.get('SELECT is_fg FROM job_cards WHERE id=$1', [req.params.id]);
  const fgBuildOnly = card?.is_fg
    ? inventory_items.filter(i => !fgTakes(i.category)).map(i => ({ item_code: i.item_code, category: i.category, qty: i.qty }))
    : [];
  res.json({
    order_id: jc.order_id,
    item_id: itemId,
    drawing_number: item?.drawing_number || jc.drawing_no || null,
    inventory_items,
    deducted: !!item?.inventory_deducted,
    is_split: parseInt(cardCount.n, 10) > 1,
    is_fg: !!card?.is_fg,
    fg_build_only: fgBuildOnly, // non-empty → warn before approving
    rework_deposited: deposited,
  });
});

// ══ Inventory QC (owner, 6 Oct 2026) ═════════════════════════════════════════
// Product QC → Inventory QC → Dispatch. At Inventory QC the QC user reviews
// ALL the inventory the card took from start to finish and can change a
// quantity (take more / give back), swap a wrongly taken item (give back the
// wrong one, take the right one), put recovered pieces into the rework bin and
// add scrap. "Inventory QC done" then sends the card on to Dispatch / Finished
// Goods — the final change to that card's inventory, ever.

// What materialDeduction takes from stock by FIFO lots (and keeps per card on
// job_cards): tube, coil wire, filling bush, MgO powder.
const MATERIAL_CATEGORIES = ['tube', 'spring guage', 'powder', 'bush'];
const isMaterial = (inv) => MATERIAL_CATEGORIES.includes(String(inv?.category || '').trim().toLowerCase());

// This card's own stock movements: rows tied to it by job_card_id, and older
// rows tied to it only by their notes — "(JC <no>)", "…, JC <no>)" or a
// material note ending "JC <no>". Always the exact card number, so a split
// sibling (<no>-P1) never matches.
function cardMoveMatch(alias, no) {
  return {
    sql: `(${alias}.job_card_id = $1 OR (${alias}.job_card_id IS NULL AND (
            strpos(${alias}.notes, $2) > 0 OR strpos(${alias}.notes, $3) > 0
            OR right(${alias}.notes, length($4)) = $4)))`,
    params: [`(JC ${no})`, `, JC ${no})`, `JC ${no}`],
  };
}

// Everything the Inventory QC screen shows for a card. db: pool or transaction.
async function inventoryView(db, cardId) {
  const card = await db.get(`
    SELECT jc.*, o.order_code, o.order_type, pu.name AS product_qc_by_name, iu.name AS inventory_qc_by_name
      FROM job_cards jc JOIN orders o ON o.id = jc.order_id
      LEFT JOIN users pu ON pu.id = jc.product_qc_by
      LEFT JOIN users iu ON iu.id = jc.inventory_qc_by
     WHERE jc.id=$1`, [cardId]);
  if (!card) return null;
  const itemId = await resolveJobCardItemId(db, card);
  const item = itemId ? await db.get(
    'SELECT id, drawing_number, quantity, inventory_deducted FROM order_items WHERE id=$1', [itemId]) : null;
  const itemQty = Number(item?.quantity) || 0;
  const cardQty = Number(card.qty) || 0;

  const m = cardMoveMatch('t', card.job_card_no);
  const moves = await db.all(`
    SELECT t.id, t.item_id, t.transaction_type, t.quantity::float AS quantity, t.balance_after::float AS balance_after,
           t.notes, t.source, t.order_item_id, t.job_card_id, t.created_at, u.name AS created_by_name,
           ii.item_code, ii.name AS item_name, ii.unit, TRIM(ii.category) AS category
      FROM inventory_transactions t JOIN inventory_items ii ON ii.id = t.item_id
      LEFT JOIN users u ON u.id = t.created_by
     WHERE ${m.sql}
     ORDER BY t.created_at, t.id`, [card.id, ...m.params]);
  const rm = cardMoveMatch('r', card.job_card_no);
  const reworkMoves = await db.all(`
    SELECT r.item_id, r.kind, r.qty::float AS qty, r.created_at
      FROM inventory_rework_moves r
     WHERE ${rm.sql} ORDER BY r.created_at, r.id`, [card.id, ...rm.params]);
  // Whole-line settles cannot be tied to one card: listed apart, not by card.
  const itemLevel = item ? await db.all(`
    SELECT t.id, t.item_id, t.transaction_type, t.quantity::float AS quantity, t.notes, t.created_at,
           ii.item_code, ii.name AS item_name, ii.unit
      FROM inventory_transactions t JOIN inventory_items ii ON ii.id = t.item_id
     WHERE t.order_item_id=$1 AND t.job_card_id IS NULL AND strpos(COALESCE(t.notes,''), 'JC ') = 0
     ORDER BY t.created_at, t.id`, [item.id]) : [];

  const list = item ? await db.all(`
    SELECT oii.inventory_item_id, oii.qty::float AS qty, COALESCE(oii.qty_deducted,0)::float AS qty_deducted,
           COALESCE(oii.qty_waived,0)::float AS qty_waived, ii.item_code, ii.name, ii.unit, TRIM(ii.category) AS category
      FROM order_item_inventory oii JOIN inventory_items ii ON ii.id = oii.inventory_item_id
     WHERE oii.order_item_id=$1 ORDER BY ii.item_code`, [item.id]) : [];
  // The card's own terminal-pin rows (owner, 6 Oct 2026; lib/terminals.js):
  // what the card took at its last stage under source 'terminal' — the list's
  // pins for its share, or what design changed for this card. Read as they
  // stand, never seeded here: QC looks at what really happened.
  const terminalRows = noTerminals(card) ? [] : await readTerminals(db, card.id);

  // Per item: taken / given back / scrap from stock, plus rework-bin draws
  // and what this card put into the rework bin.
  const by = new Map();
  const row = (id, info = {}) => {
    if (!by.has(id)) by.set(id, { inventory_item_id: id, item_code: info.item_code, name: info.name || info.item_name,
      unit: info.unit || '', category: info.category || null,
      taken: 0, given_back: 0, scrap: 0, from_rework_bin: 0, reworked: 0 });
    return by.get(id);
  };
  for (const t of moves) {
    const r = row(t.item_id, t);
    if (t.transaction_type === 'dispatch_to_production') r.taken += t.quantity;
    else if (t.transaction_type === 'return_from_production') r.given_back += t.quantity;
    else if (t.transaction_type === 'scrap') r.scrap += t.quantity;
  }
  for (const l of list) row(l.inventory_item_id, l);
  for (const x of reworkMoves) {
    if (!by.has(x.item_id)) {
      const info = await db.get('SELECT item_code, name, unit, TRIM(category) AS category FROM inventory_items WHERE id=$1', [x.item_id]);
      row(x.item_id, info || {});
    }
    const r = by.get(x.item_id);
    if (x.kind === 'draw') r.from_rework_bin += x.qty;
    else if (x.kind === 'deposit') r.reworked += x.qty;
    else if (x.kind === 'reversal') r.reworked -= x.qty;
  }
  const ids = [...by.keys()];
  const stock = ids.length ? Object.fromEntries((await db.all(
    `SELECT ii.id, ii.current_stock::float AS current_stock, COALESCE(b.qty,0)::float AS rework_bin
       FROM inventory_items ii LEFT JOIN inventory_rework_bins b ON b.item_id = ii.id WHERE ii.id = ANY($1)`, [ids]))
    .map(s => [s.id, s])) : {};
  const held = isHeldCard(card);
  const fgOrder = card.order_type === 'finished_goods';
  // A split card's stage 15/21 parts were taken on its parent before the split
  // (it inherits the ticked stages), so the list is no guide for them here.
  const splitChild = !!card.parent_job_card_id;
  const stageCats = Object.values(STAGE_CATEGORY_MAP).flat();
  for (const t of terminalRows) if (!by.has(t.inventory_item_id)) row(t.inventory_item_id, t);
  const items = [...by.values()].map(r => {
    const line = list.find(l => l.inventory_item_id === r.inventory_item_id);
    const pin = terminalRows.find(t => t.inventory_item_id === r.inventory_item_id) || null;
    let forCard = null, noGuide = null;
    if (pin) {
      // A pin on the card's own rows: the row is the guide for this card.
      forCard = Math.round(Number(pin.qty) || 0);
    } else if (line && terminalRows.length && isTerminalCategory(line.category)) {
      // On the list but not on this card's rows: design changed this card's pins.
      forCard = 0; noGuide = 'not used on this card — design changed its terminal pins';
    } else if (line) {
      if (fgOrder && !fgTakes(line.category)) noGuide = 'inside the heater already — never taken on a finished-goods card';
      else if (splitChild && stageCats.includes(String(line.category || '').trim())) noGuide = 'taken on the card this one was split from';
      else {
        forCard = itemQty > 0 ? (line.qty * cardQty) / itemQty : line.qty;
        forCard = rework.isPieceUnit(line.unit) ? Math.round(forCard) : r4(forCard);
      }
    }
    return {
      ...r,
      taken: r4(r.taken), given_back: r4(r.given_back), scrap: r4(r.scrap),
      from_rework_bin: r4(r.from_rework_bin), reworked: r4(r.reworked),
      // what left stock for this card: taken + scrap − given back
      net: r4(r.taken + r.scrap - r.given_back),
      on_list: !!line,
      list_qty: line ? line.qty : null,                                 // for the whole order line
      list_qty_per_piece: line && itemQty > 0 ? r4(line.qty / itemQty) : null,
      list_qty_for_card: forCard,                                       // null when the list is no guide for this card
      no_guide: noGuide,
      // the card's own terminal-pin row, when this item is one (source 'list' / 'design')
      terminal: pin ? { qty: Math.round(Number(pin.qty) || 0), source: pin.source } : null,
      current_stock: stock[r.inventory_item_id]?.current_stock ?? null,
      rework_bin: stock[r.inventory_item_id]?.rework_bin ?? 0,
      material: isMaterial(r),
      counted: isCountedItem(r.item_code),
      // tube / NUT-BR-M4-08 stay as they are on a card through QC or
      // dispatched before Inventory QC went live (lib/countedStock.js)
      locked: isCountedItem(r.item_code) && held,
    };
  }).sort((a, b) => String(a.item_code).localeCompare(String(b.item_code)));

  const changes = await db.all(
    `SELECT a.id, a.description, a.created_at, u.name AS created_by_name FROM activity_log a
       LEFT JOIN users u ON u.id = a.created_by
      WHERE a.job_card_id=$1 AND a.activity_type='inventory_qc' ORDER BY a.created_at, a.id`, [card.id]);

  return {
    card: {
      id: card.id, job_card_no: card.job_card_no, status: card.status, qty: cardQty, order_id: card.order_id,
      order_code: card.order_code, order_type: card.order_type, drawing_no: card.drawing_no, is_fg: !!card.is_fg,
      last_stage_taken_at: card.last_stage_taken_at,
      product_qc_at: card.product_qc_at, product_qc_by: card.product_qc_by, product_qc_by_name: card.product_qc_by_name,
      inventory_qc_at: card.inventory_qc_at, inventory_qc_by: card.inventory_qc_by, inventory_qc_by_name: card.inventory_qc_by_name,
    },
    editable: card.status === 'inventory_qc' && !card.inventory_qc_at,
    counted_locked: held,
    routing: {
      route: card.qc_route, fg_qty: card.qc_fg_qty, dispatch_qty: card.qc_dispatch_qty,
      fg_location: card.qc_fg_location, split_notes: card.qc_split_notes,
    },
    item: item ? { id: item.id, drawing_number: item.drawing_number, quantity: itemQty, settled: !!item.inventory_deducted } : null,
    materials: {
      coil_used_qty: card.coil_used_qty, coil_scrap_qty: card.coil_scrap_qty, coil_deducted: !!card.coil_deducted,
      tube_used_qty: card.tube_used_qty, tube_scrap_qty: card.tube_scrap_qty, tube_deducted: !!card.tube_deducted,
      fill_pvc_qty: card.fill_pvc_qty, fill_mgo_qty: card.fill_mgo_qty, fill_deducted: !!card.fill_deducted,
      fins_kg: card.fins_kg, fins_deducted: !!card.fins_deducted,
    },
    items,
    movements: moves,
    item_level: itemLevel,
    changes,
  };
}

// Cards waiting for Inventory QC (Product QC passed).
router.get('/inventory-queue', authenticate, authorize('design', 'owner', 'admin'), async (req, res) => {
  const canSeeNames = withCustomerVisibility(req);
  const cards = await getDB().all(
    `SELECT jc.*, o.order_code, o.order_type, c.customer_code, ${canSeeNames ? "c.name as customer_name," : ''}
       pu.name AS product_qc_by_name,
       (jc.dispatch_date::date - CURRENT_DATE) as days_until_dispatch,
       (SELECT COUNT(*) FROM activity_log WHERE job_card_id = jc.id AND activity_type = 'inventory_qc')::int AS inventory_qc_changes
     FROM job_cards jc
     JOIN orders o ON jc.order_id = o.id
     JOIN customers c ON o.customer_id = c.id
     LEFT JOIN users pu ON pu.id = jc.product_qc_by
     WHERE jc.status = 'inventory_qc'
     ORDER BY jc.dispatch_date ASC`
  );
  res.json(cards);
});

router.get('/:id/inventory', authenticate, authorize('design', 'owner', 'admin'), async (req, res) => {
  const view = await inventoryView(getDB(), req.params.id);
  if (!view) return res.status(404).json({ error: 'Not found' });
  res.json(view);
});

// The card must be waiting for Inventory QC, and its last-stage take must be
// in. If that take failed earlier it is made now and QC is asked to look again
// before changing anything — QC always decides on what really left stock.
// forDone: a card whose approval the owner reversed after Inventory QC comes
// back here through Product QC — its inventory stays closed (no changes), but
// it can still be sent on.
async function inventoryQcGate(db, id, userId, { forDone = false } = {}) {
  const jc = await db.get('SELECT * FROM job_cards WHERE id=$1', [id]);
  if (!jc) return { status: 404, error: 'Not found' };
  if (jc.status !== 'inventory_qc' || (jc.inventory_qc_at && !forDone)) {
    return { status: 400, error: jc.inventory_qc_at
      ? 'Inventory QC is already done for this job card — its inventory can no longer change.'
      : 'This job card is not waiting for Inventory QC.' };
  }
  if (!jc.last_stage_taken_at) {
    try { await takeLastStage(db, jc, userId); }
    catch (e) { return { status: 500, error: `The rest of this card's list could not be taken from stock: ${e.message}` }; }
    return { status: 409, code: 'LAST_STAGE_JUST_TAKEN',
      error: 'The rest of this card\'s list has only now been taken from stock — please review it, then try again.' };
  }
  return { jc };
}

const httpError = (status, message) => Object.assign(new Error(message), { status });
const fmtQ = (n) => String(r4(n));

// Body: { changes: [{ inventory_item_id, kind: 'take'|'give_back'|'scrap'|'rework', qty, note }] }
// All in one transaction: one bad change refuses the lot, nothing half-done.
router.post('/:id/inventory/adjust', authenticate, authorize('design', 'owner', 'admin'), async (req, res) => {
  const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
  if (!changes.length) return res.status(400).json({ error: 'No changes sent.' });
  if (changes.length > 100) return res.status(400).json({ error: 'Too many changes in one go — send at most 100.' });
  const db = getDB();
  const gate = await inventoryQcGate(db, req.params.id, req.user.id);
  if (!gate.jc) return res.status(gate.status).json({ error: gate.error, code: gate.code });
  const userId = req.user.id;

  let result;
  try {
    result = await db.withTransaction(async (client) => {
      const tx = clientDb(client);
      await client.query("SET LOCAL lock_timeout = '10s'");
      const card = await tx.get(
        `SELECT jc.*, o.order_code FROM job_cards jc JOIN orders o ON o.id = jc.order_id WHERE jc.id=$1 FOR UPDATE OF jc`,
        [req.params.id]);
      if (!card || card.status !== 'inventory_qc' || card.inventory_qc_at) throw httpError(400, 'This job card is not waiting for Inventory QC.');
      const no = card.job_card_no;
      const orderCode = card.order_code || `Order #${card.order_id}`;
      const itemId = await resolveJobCardItemId(tx, card);
      const item = itemId ? await tx.get('SELECT id, drawing_number, tube_material, tube_diameter FROM order_items WHERE id=$1', [itemId]) : null;
      const where = `${orderCode}${item?.drawing_number ? ` · ${item.drawing_number}` : ''}`;
      const held = isHeldCard(card);

      // The items the card's Stage 4/5/6 take from stock, so their per-card
      // figures on job_cards stay in step (a Stage undo puts back exactly those).
      const s1 = await tx.get('SELECT value1 FROM production_checklist WHERE job_card_id=$1 AND stage_no=1', [card.id]);
      const tubeInv = item ? await invByCode(tx, item.tube_material, 'tube') : null;
      const gaugeInv = await invByCode(tx, s1?.value1, 'spring guage');
      const pvcInv = item ? await invByCode(tx, pvcCodeFor(item.tube_diameter), 'bush') : null;
      const mgoInv = await invByCode(tx, MGO_CODE, 'powder');
      const cardCols = (invId) => {
        if (tubeInv && invId === tubeInv.id) return { used: 'tube_used_qty', scrap: 'tube_scrap_qty', flag: 'tube_deducted' };
        if (gaugeInv && invId === gaugeInv.id) return { used: 'coil_used_qty', scrap: 'coil_scrap_qty', flag: 'coil_deducted' };
        if (pvcInv && invId === pvcInv.id) return { used: 'fill_pvc_qty', scrap: 'fill_pvc_qty', flag: 'fill_deducted' };
        if (mgoInv && invId === mgoInv.id) return { used: 'fill_mgo_qty', scrap: 'fill_mgo_qty', flag: 'fill_deducted' };
        return null;
      };
      const bumpCard = async (col, flag, delta) => {
        await tx.run(`UPDATE job_cards SET ${col} = GREATEST(0, COALESCE(${col},0) + $1)${delta > 0 ? `, ${flag} = TRUE` : ''} WHERE id=$2`,
          [delta, card.id]);
      };

      const applied = [];
      const touched = new Set();
      for (const ch of changes) {
        const invId = parseInt(ch?.inventory_item_id, 10);
        const kind = ch?.kind;
        const qty = Number(ch?.qty);
        const note = String(ch?.note || '').trim().slice(0, 500);
        if (!invId) throw httpError(400, 'Each change needs an inventory item.');
        if (!['take', 'give_back', 'scrap', 'rework'].includes(kind)) throw httpError(400, `Unknown change "${kind}" — use take, give_back, scrap or rework.`);
        if (!Number.isFinite(qty) || !(qty > 0)) throw httpError(400, 'Each change needs a quantity above 0.');
        const q = r4(qty);
        const inv = await tx.get(
          'SELECT id, item_code, name, unit, TRIM(category) AS category FROM inventory_items WHERE id=$1 FOR UPDATE', [invId]);
        if (!inv) throw httpError(400, `Inventory item #${invId} not found.`);
        const unit = inv.unit || '';
        if (isCountedItem(inv.item_code) && held) {
          throw httpError(400, `${inv.item_code}: this card was through QC or dispatched before Inventory QC, so it no longer changes ${inv.item_code} stock (owner, 6 Oct 2026).`);
        }
        const line = item ? await tx.get(
          'SELECT * FROM order_item_inventory WHERE order_item_id=$1 AND inventory_item_id=$2 ORDER BY id LIMIT 1', [item.id, invId]) : null;
        const tag = note ? ` | ${note}` : '';
        let desc;

        if (kind === 'rework') {
          // Recovered whole pieces into the rework bin — same rules as at the
          // old QC approval: on this item's list, counted in pieces, whole, and
          // never more than this card took of it (all deposits together).
          if (!line) throw httpError(400, `Rework: ${inv.item_code} is not on this item's inventory.`);
          if (FINS_CODES.includes(inv.item_code) || !rework.isPieceUnit(inv.unit)) {
            throw httpError(400, `Rework: ${inv.item_code} is measured in ${inv.unit || 'a non-piece unit'} — only counted parts can be reworked.`);
          }
          if (!Number.isInteger(qty)) throw httpError(400, `Rework: ${inv.item_code} must be a whole number of pieces (got ${qty}).`);
          const m = cardMoveMatch('t', no);
          const took = await tx.get(
            `SELECT COALESCE(SUM(CASE WHEN t.transaction_type='dispatch_to_production' THEN t.quantity
                                      WHEN t.transaction_type='return_from_production' THEN -t.quantity ELSE 0 END),0)::float AS n
               FROM inventory_transactions t WHERE t.item_id=$5 AND ${m.sql}`, [card.id, ...m.params, invId]);
          const rm = cardMoveMatch('r', no);
          const bin = await tx.get(
            `SELECT COALESCE(SUM(CASE WHEN r.kind='draw' THEN r.qty ELSE 0 END),0)::float AS drawn,
                    COALESCE(SUM(CASE WHEN r.kind='deposit' THEN r.qty WHEN r.kind='reversal' THEN -r.qty ELSE 0 END),0)::float AS deposited
               FROM inventory_rework_moves r WHERE r.item_id=$5 AND ${rm.sql}`, [card.id, ...rm.params, invId]);
          const cap = Math.floor(Number(took.n) + Number(bin.drawn) - Number(bin.deposited) + 1e-9);
          if (qty > cap) throw httpError(400, `Rework: ${inv.item_code} — ${qty} is more than this card used (${Math.max(cap, 0)} left to rework).`);
          await rework.move(tx, { itemId: invId, kind: 'deposit', qty,
            ref: { order_id: card.order_id, order_item_id: item?.id || null, job_card_id: card.id, order_code: card.order_code,
                   job_card_no: no, drawing_number: item?.drawing_number },
            notes: `Recovered at Inventory QC of ${no}${note ? ` — ${note}` : ''}`, userId });
          desc = `Inventory QC: rework ${fmtQ(q)} ${unit} ${inv.item_code} from ${no} into the rework bin`;
        } else {
          const label = { take: 'took more', give_back: 'gave back', scrap: 'scrap' }[kind];
          const moveNote = `Inventory QC — ${label} | ${where} (JC ${no})${tag}`;
          const type = kind === 'give_back' ? 'return_from_production' : kind === 'scrap' ? 'scrap' : 'dispatch_to_production';
          if (isMaterial(inv)) {
            // Tube, coil wire, filling bush, MgO: by FIFO lots, as the stages take them.
            // Tagged 'inventory_qc', not 'bom': QC's correction is this card's
            // own — the line's figures and later list corrections never see it.
            const opts = { note: moveNote, userId, jobCardId: card.id,
              orderItemId: item?.id || null, source: 'inventory_qc' };
            if (kind === 'give_back') await returnFifo(tx, invId, q, opts);
            else await consumeFifo(tx, invId, q, { ...opts, type });
            const cols = cardCols(invId);
            if (cols) await bumpCard(kind === 'scrap' ? cols.scrap : cols.used, cols.flag, kind === 'give_back' ? -q : q);
          } else {
            const sign = kind === 'give_back' ? 1 : -1;
            const after = Number((await tx.get(
              'UPDATE inventory_items SET current_stock = current_stock + $1 WHERE id=$2 RETURNING current_stock', [sign * q, invId])).current_stock);
            await recordMove(tx, { itemId: invId, type, qty: q, balanceAfter: after, notes: moveNote, userId,
              orderItemId: item?.id || null, source: 'inventory_qc', jobCardId: card.id });
          }
          // The order line's figures (qty_deducted / qty_waived) are left alone:
          // this card used more or less than the list says, which neither changes
          // what its sibling cards take nor reopens the line for a later settle.
          desc = kind === 'take' ? `Inventory QC: took ${fmtQ(q)} ${unit} ${inv.item_code} more for ${no}`
            : kind === 'give_back' ? `Inventory QC: gave back ${fmtQ(q)} ${unit} ${inv.item_code} from ${no}`
            : `Inventory QC: scrap ${fmtQ(q)} ${unit} ${inv.item_code} on ${no}`;
          touched.add(invId);
        }
        await tx.run(
          `INSERT INTO activity_log (order_id, job_card_id, activity_type, description, created_by) VALUES ($1,$2,'inventory_qc',$3,$4)`,
          [card.order_id, card.id, `${desc.replace(/\s+/g, ' ')}${note ? ` — ${note}` : ''}`, userId]);
        applied.push({ inventory_item_id: invId, item_code: inv.item_code, kind, qty: q, unit });
      }
      // Stock may go below zero (production is never blocked) — flagged here.
      const negative = touched.size ? await tx.all(
        `SELECT id AS inventory_item_id, item_code, current_stock::float AS current_stock, unit
           FROM inventory_items WHERE id = ANY($1) AND current_stock < 0 ORDER BY item_code`, [[...touched]]) : [];
      return { applied, negative };
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  res.json({ message: `${result.applied.length} change${result.applied.length === 1 ? '' : 's'} saved`, ...result });
});

// Inventory QC done: carry out what Product QC recorded — Finished Goods intake
// for finished_goods / both / split, the rest to dispatch — and close the
// card's inventory for good.
router.put('/:id/inventory-done', authenticate, authorize('design', 'owner', 'admin'), async (req, res) => {
  const db = getDB();
  const gate = await inventoryQcGate(db, req.params.id, req.user.id, { forDone: true });
  if (!gate.jc) return res.status(gate.status).json({ error: gate.error, code: gate.code });

  let done;
  try {
    done = await db.withTransaction(async (client) => {
      const tx = clientDb(client);
      // Claimed in one step, so a double press can never take Finished Goods in twice.
      // A card whose every piece was rejected has nothing to send or stock: it
      // closes as Rejected right here (owner, 7 Oct 2026) — the material was
      // settled by Inventory QC, the pieces are decided by the owner.
      const won = await tx.get(
        `UPDATE job_cards SET status = CASE WHEN qc_route='rejected' THEN 'rejected' ELSE 'qc_approved' END,
                inventory_qc_at=NOW(), inventory_qc_by=$2
          WHERE id=$1 AND status='inventory_qc' RETURNING id`, [req.params.id, req.user.id]);
      if (!won) throw httpError(400, 'This job card is not waiting for Inventory QC.');
      const jc = await loadCardFull(tx, req.params.id);
      const route = jc.qc_route || 'dispatch';
      const fgQty = Number(jc.qc_fg_qty) || 0;
      const dispQty = Number(jc.qc_dispatch_qty) || 0;
      let fgId = null;
      if (['finished_goods', 'both', 'split'].includes(route) && fgQty > 0) {
        fgId = await createFinishedGoodsEntry(tx, { jc, specs: await productSpecs(tx, jc), qty: fgQty,
          location: jc.qc_fg_location || null, splitNotes: jc.qc_split_notes || null, userId: req.user.id });
      }
      return { jc, route, fgQty, dispQty, fgId };
    });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  const { jc, route, fgQty, dispQty, fgId } = done;

  // The same approval line as before Inventory QC existed.
  const text = route === 'rejected'
    ? `Job card ${jc.job_card_no} closed as Rejected — all ${jc.qty} pieces rejected at production (QC)`
    : route === 'finished_goods'
    ? `Job card ${jc.job_card_no} QC Approved — ${fgQty} units added to Finished Goods`
    : (route === 'both' || route === 'split')
      ? `Job card ${jc.job_card_no} QC Approved — ${fgQty} units to Finished Goods, ${dispQty} to dispatch`
      : `Job card ${jc.job_card_no} QC Approved — ${dispQty} units going to dispatch`;
  await logActivity(jc.order_id, jc.id, 'status_changed', text, req.user.id);
  await syncOrderStatus(db, jc.order_id, req.user.id);

  // Settle the order line: in the new flow nothing more is taken — what is
  // left on it is settled without stock (lib/inventoryDeduction.js).
  try {
    const itemId = await resolveJobCardItemId(db, jc);
    if (itemId) await settleItemInventory(db, itemId, req.user.id, jc.order_code || `Order #${jc.order_id}`);
  } catch (e) { console.error('[qc] settle after Inventory QC failed:', e.message); }

  res.json({
    message: route === 'rejected' ? 'Inventory QC done — job card closed as Rejected' : 'Inventory QC done',
    status: jc.status, route, dispatch_qty: dispQty, fg_qty: fgQty, finished_good_id: fgId,
  });
});

module.exports = router;
