const express = require('express');
const router = express.Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadCapaPhotos } = require('../middleware/upload');
const { createNotification } = require('./notifications');
const { runCapaTurn } = require('../lib/capaAI');

// Stage names for the checklist context — keep in sync with qc.js / client utils.
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
const FG_STAGE_NAMES = { 1: 'Nut Washer', 2: 'HV + Light Check + Ohms', 3: 'Megger', 4: 'Ready for Dispatch' };

// One compact line per checklist stage that has anything recorded, so the AI
// facilitator opens with the shopfloor record instead of asking for it.
function checklistLines(rows, isFg) {
  const names = isFg ? FG_STAGE_NAMES : STAGE_NAMES;
  const out = [];
  for (const r of rows) {
    const hasData = r.done || r.value1 || r.value2 || r.worker_name || r.coil_weight
      || r.scrap_value || Number(r.rejection_qty) > 0 || Number(r.remade_qty) > 0 || r.notes;
    if (!hasData) continue;
    const bits = [`stage ${r.stage_no} ${names[r.stage_no] || ''}`.trim() + ':'];
    bits.push(r.done ? `DONE${r.d ? ' ' + r.d : ''}` : 'not done');
    if (r.worker_name) bits.push(`worker ${r.worker_name}`);
    if (r.value1) bits.push(`reading1 ${r.value1}`);
    if (r.value2) bits.push(`reading2 ${r.value2}`);
    if (r.coil_weight) bits.push(`coil wt ${r.coil_weight}`);
    if (r.scrap_value !== null && r.scrap_value !== undefined && String(r.scrap_value) !== '') bits.push(`scrap ${r.scrap_value}`);
    if (Number(r.rejection_qty) > 0) bits.push(`REJECTED ${r.rejection_qty}${Number(r.remade_qty) > 0 ? `, remade ${r.remade_qty}` : ''}`);
    if (r.notes) bits.push(`note: ${r.notes}`);
    out.push('  ' + bits.join(' | '));
  }
  return out;
}

// ── Shared: create a CAPA if the card doesn't already have an active one ─────
// Used by the rejection trigger (jobCards.js) and query creation (customerQueries.js).
// Watermark: a rejections-CAPA is only created when the current total exceeds the
// highest total an APPROVED rejections-CAPA already covered.
async function ensureCapa(db, { jobCardId, orderId, triggerType, customerQueryId = null, triggerTotal = null, userId }) {
  const active = await db.get(
    "SELECT id FROM capa_reports WHERE job_card_id=$1 AND status IN ('open','awaiting_approval')",
    [jobCardId]);
  if (active) return null; // one active CAPA per card covers all triggers

  if (triggerType === 'rejections') {
    const watermark = await db.get(
      "SELECT COALESCE(MAX(trigger_total),0) AS t FROM capa_reports WHERE job_card_id=$1 AND trigger_type='rejections' AND status='approved'",
      [jobCardId]);
    if (triggerTotal <= parseInt(watermark?.t || 0, 10)) return null;
  }

  const id = await db.insert(
    `INSERT INTO capa_reports (job_card_id, order_id, customer_query_id, trigger_type, trigger_total, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [jobCardId, orderId || null, customerQueryId, triggerType, triggerTotal, userId]);

  const jc = await db.get('SELECT job_card_no, order_id FROM job_cards WHERE id=$1', [jobCardId]);
  const reason = triggerType === 'rejections'
    ? `${triggerTotal} pieces rejected across stages`
    : 'customer query raised';
  const users = await db.all("SELECT id FROM users WHERE role IN ('owner','production','admin')");
  for (const u of users) {
    await createNotification(db, {
      userId: u.id, type: 'capa_required',
      title: `CAPA required — ${jc?.job_card_no || 'job card'}`,
      body: `Work is locked (${reason}). Complete the CAPA report to continue.`,
      link: `/capa/${id}`, sourceUserId: userId,
    });
  }
  await logActivity(jc?.order_id || orderId || null, jobCardId, 'capa_created',
    `CAPA required on ${jc?.job_card_no || `card #${jobCardId}`} — ${reason}`, userId);
  return id;
}

// Any CAPA (open or awaiting approval) that blocks work on this job card?
async function activeCapaFor(db, jobCardId) {
  return db.get(
    "SELECT id, status, trigger_type FROM capa_reports WHERE job_card_id=$1 AND status IN ('open','awaiting_approval') ORDER BY id DESC LIMIT 1",
    [jobCardId]);
}

// ── GET the CAPA for a job card (active first, else latest) ──────────────────
router.get('/job-card/:jobCardId', authenticate, async (req, res) => {
  const db = getDB();
  const capa = await db.get(
    `SELECT * FROM capa_reports WHERE job_card_id=$1
     ORDER BY (status IN ('open','awaiting_approval')) DESC, id DESC LIMIT 1`,
    [req.params.jobCardId]);
  res.json(capa || null);
});

// ── GET one CAPA with its context ────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  const db = getDB();
  const capa = await db.get(`
    SELECT c.*, jc.job_card_no, jc.product_name, jc.drawing_no, jc.qty AS card_qty,
           o.order_code, u.name AS created_by_name, ua.name AS approved_by_name,
           cq.query_no
    FROM capa_reports c
    JOIN job_cards jc ON jc.id = c.job_card_id
    LEFT JOIN orders o ON o.id = c.order_id
    LEFT JOIN users u ON u.id = c.created_by
    LEFT JOIN users ua ON ua.id = c.approved_by
    LEFT JOIN customer_queries cq ON cq.id = c.customer_query_id
    WHERE c.id=$1`, [req.params.id]);
  if (!capa) return res.status(404).json({ error: 'CAPA not found' });
  capa.rejections = await db.all(`
    SELECT stage_no, rejection_qty, remade_qty, notes FROM production_checklist
    WHERE job_card_id=$1 AND rejection_qty > 0 ORDER BY stage_no`, [capa.job_card_id]);
  res.json(capa);
});

// ── POST a message into the CAPA conversation (photos optional) ──────────────
router.post('/:id/message', authenticate, authorize('production', 'admin', 'owner'),
  ...uploadCapaPhotos, async (req, res) => {
  const db = getDB();
  const capa = await db.get('SELECT * FROM capa_reports WHERE id=$1', [req.params.id]);
  if (!capa) return res.status(404).json({ error: 'CAPA not found' });
  if (capa.status === 'approved') return res.status(400).json({ error: 'This CAPA is already approved.' });

  const text = (req.body.text || '').trim();
  const photos = (req.files || []).map(f => ({ path: f.storagePath, name: f.originalname }));
  if (!text && !photos.length) return res.status(400).json({ error: 'Write a message or attach a photo.' });

  for (const p of photos) {
    await db.run('INSERT INTO capa_photos (capa_id, file_path, original_name, created_by) VALUES ($1,$2,$3,$4)',
      [capa.id, p.path, p.name, req.user.id]);
  }

  const conversation = Array.isArray(capa.conversation) ? capa.conversation : [];
  conversation.push({ role: 'user', text, photos, by: req.user.name, at: new Date().toISOString() });

  // Fresh job-card context every call — stage rejections included, so Claude
  // opens with facts rather than asking for what the app already knows.
  const jc = await db.get(`
    SELECT jc.*, o.order_code FROM job_cards jc LEFT JOIN orders o ON o.id = jc.order_id WHERE jc.id=$1`,
    [capa.job_card_id]);
  const checklist = await db.all(`
    SELECT stage_no, done, value1, value2, worker_name, coil_weight, scrap_value,
           rejection_qty, remade_qty, notes, done_at::date AS d
    FROM production_checklist WHERE job_card_id=$1 ORDER BY stage_no`, [capa.job_card_id]);
  const bom = jc.order_item_id ? await db.all(`
    SELECT ii.item_code, TRIM(COALESCE(ii.category,'')) AS cat, oii.qty
    FROM order_item_inventory oii JOIN inventory_items ii ON ii.id=oii.inventory_item_id
    WHERE oii.order_item_id = $1 ORDER BY ii.item_code`, [jc.order_item_id]) : [];
  const query = capa.customer_query_id
    ? await db.get('SELECT query_no, subject, description FROM customer_queries WHERE id=$1', [capa.customer_query_id])
    : null;

  const chkLines = checklistLines(checklist, !!jc.is_fg);
  const contextText = [
    `CAPA #${capa.id} — trigger: ${capa.trigger_type === 'rejections' ? `cumulative rejections (${capa.trigger_total} pcs)` : `customer query ${query?.query_no || ''}`}`,
    `Job card: ${jc.job_card_no} | Order: ${jc.order_code || '-'} | Product: ${jc.product_name || '-'} | Drawing: ${jc.drawing_no || '-'} | Qty: ${jc.qty}${jc.is_fg ? ' | FG inventory card (4-stage checklist)' : ''}`,
    chkLines.length
      ? `CHECKLIST RECORD (authoritative — stage, status/date, worker, recorded readings and gauge/spring codes, coil weight, scrap, rejections, notes):\n${chkLines.join('\n')}`
      : 'No checklist entries recorded yet.',
    bom.length
      ? `Bill of materials for this item: ${bom.map(b => `${b.item_code} (${b.cat}) ×${b.qty}`).join(', ')}`
      : null,
    query ? `Customer query: ${query.subject}${query.description ? ` — ${query.description}` : ''}` : null,
    `The production user you are talking to is: ${req.user.name}.`,
  ].filter(Boolean).join('\n');

  let result;
  try {
    result = await runCapaTurn({ contextText, conversation });
  } catch (err) {
    if (err.code === 'AI_NOT_CONFIGURED') return res.status(503).json({ error: err.message });
    console.error('CAPA AI turn failed:', err.message);
    return res.status(502).json({ error: 'AI is unreachable right now — your message was not saved. Try again in a minute.' });
  }

  conversation.push({ role: 'assistant', text: result.reply, at: new Date().toISOString() });

  if (result.finalized) {
    await db.run(`
      UPDATE capa_reports SET conversation=$1::jsonb, problem_statement=$2, root_cause=$3,
        corrective_action=$4, preventive_action=$5, status='awaiting_approval', updated_at=NOW()
      WHERE id=$6`,
      [JSON.stringify(conversation), result.finalized.problem_statement, result.finalized.root_cause,
       result.finalized.corrective_action, result.finalized.preventive_action, capa.id]);
    const owners = await db.all("SELECT id FROM users WHERE role='owner'");
    const jcNo = jc.job_card_no;
    for (const o of owners) {
      await createNotification(db, {
        userId: o.id, type: 'capa_ready',
        title: `CAPA ready for approval — ${jcNo}`,
        body: 'The CAPA report is complete. Review and approve to unlock the job card.',
        link: `/capa/${capa.id}`, sourceUserId: req.user.id,
      });
    }
    await logActivity(capa.order_id, capa.job_card_id, 'capa_submitted',
      `CAPA report on ${jcNo} completed — awaiting owner approval`, req.user.id);
  } else {
    await db.run('UPDATE capa_reports SET conversation=$1::jsonb, updated_at=NOW() WHERE id=$2',
      [JSON.stringify(conversation), capa.id]);
  }

  res.json({ reply: result.reply, finalized: !!result.finalized });
});

// ── Owner approves — unlocks the job card ────────────────────────────────────
router.put('/:id/approve', authenticate, authorize('owner'), async (req, res) => {
  const db = getDB();
  const capa = await db.get('SELECT * FROM capa_reports WHERE id=$1', [req.params.id]);
  if (!capa) return res.status(404).json({ error: 'CAPA not found' });
  if (capa.status !== 'awaiting_approval') return res.status(400).json({ error: 'CAPA is not awaiting approval.' });

  await db.run(
    "UPDATE capa_reports SET status='approved', approved_by=$1, approved_at=NOW(), updated_at=NOW() WHERE id=$2",
    [req.user.id, capa.id]);

  // Lift the rejection lock (the on-hold status the trigger set). Query-CAPAs
  // don't hold the card — the repair-start endpoint checks CAPA state itself.
  const jc = await db.get('SELECT * FROM job_cards WHERE id=$1', [capa.job_card_id]);
  if (capa.trigger_type === 'rejections' && jc?.status === 'on_hold') {
    await db.run("UPDATE job_cards SET status='in_progress' WHERE id=$1", [capa.job_card_id]);
  }

  if (capa.created_by) {
    await createNotification(db, {
      userId: capa.created_by, type: 'capa_approved',
      title: `CAPA approved — ${jc?.job_card_no || ''}`,
      body: 'Work can continue on the job card.',
      link: `/capa/${capa.id}`, sourceUserId: req.user.id,
    });
  }
  await logActivity(capa.order_id, capa.job_card_id, 'capa_approved',
    `CAPA on ${jc?.job_card_no || `card #${capa.job_card_id}`} approved — work unlocked`, req.user.id);
  res.json({ message: 'CAPA approved — job card unlocked.' });
});

// ── Owner sends it back for more work ────────────────────────────────────────
router.put('/:id/reopen', authenticate, authorize('owner'), async (req, res) => {
  const db = getDB();
  const note = (req.body.note || '').trim();
  if (!note) return res.status(400).json({ error: 'Tell the team what is missing.' });
  const capa = await db.get('SELECT * FROM capa_reports WHERE id=$1', [req.params.id]);
  if (!capa) return res.status(404).json({ error: 'CAPA not found' });
  if (capa.status !== 'awaiting_approval') return res.status(400).json({ error: 'CAPA is not awaiting approval.' });

  const conversation = Array.isArray(capa.conversation) ? capa.conversation : [];
  conversation.push({ role: 'user', text: `[Owner sent the report back]: ${note}`, by: req.user.name, at: new Date().toISOString() });

  await db.run(
    "UPDATE capa_reports SET status='open', reopen_note=$1, conversation=$2::jsonb, updated_at=NOW() WHERE id=$3",
    [note, JSON.stringify(conversation), capa.id]);

  if (capa.created_by) {
    await createNotification(db, {
      userId: capa.created_by, type: 'capa_reopened',
      title: 'CAPA sent back by owner',
      body: note, link: `/capa/${capa.id}`, sourceUserId: req.user.id,
    });
  }
  res.json({ message: 'CAPA reopened.' });
});

module.exports = router;
module.exports.ensureCapa = ensureCapa;
module.exports.activeCapaFor = activeCapaFor;
