// Owner actions on partial-dispatch (split) requests: production asks to send
// part of a job card early (qty + reason) and the owner approves or rejects.
//
// Shared by the Job Card routes and the WhatsApp reply dispatcher, so both
// paths do exactly the same thing. Every change is guarded on the request still
// waiting (status = 'pending'): when a dashboard click and a WhatsApp reply land
// together, the first one wins and the second is told what already happened.
//
// fn(db, params) → { ok:true, summary, data } | { ok:false, code, message, data }
//   code: 'not_found' | 'already_done' | 'invalid' | 'blocked' | 'forbidden'
//   data.reason (on failures) names the exact case so the app route can give
//   the same response it always gave.
const dbmod = require('../../db');

// Required when used, not at load: notifications pulls in lib/whatsapp, and the
// WhatsApp dispatcher pulls in this file — a load-time require would be a cycle.
const notify = (db, payload) => require('../../routes/notifications').createNotification(db, payload);

// A partial dispatch can be requested — and approved — only while the parent
// card is still in production. The request route uses this same list.
const SPLIT_REQUESTABLE = ['pending', 'in_progress', 'on_hold'];
// Approval also accepts a card that has since reached QC (stage 29 moves it to
// qc_pending): a request made during production and approved a little later
// is still a real request. Anything later — QC approved, dispatched, finished —
// means the pieces have moved on, so the request can only be rejected.
const SPLIT_APPROVABLE = [...SPLIT_REQUESTABLE, 'qc_pending'];

const OWNER_ONLY = ['owner'];

const viaSuffix = (via) => (via === 'whatsapp' ? ' (via WhatsApp)' : '');

// Card statuses in the words the factory uses.
const STATUS_WORDS = {
  pending: 'not started', in_progress: 'in production', on_hold: 'on hold',
  qc_pending: 'waiting for QC', qc_approved: 'QC approved', completed: 'completed',
  dispatched: 'dispatched', resolved_dispatched: 'dispatched', repaired_dispatched: 'dispatched',
  customer_query: 'under a customer query', product_return: 'returned by the customer',
  repair_in_progress: 'under repair', packaging: 'in packaging',
};
const statusWords = (s) => STATUS_WORDS[s] || String(s || 'unknown').replace(/_/g, ' ');

function checkRole(actor, verb) {
  if (!actor || !OWNER_ONLY.includes(actor.role)) {
    return { ok: false, code: 'forbidden', message: `Only the owner can ${verb} a partial dispatch.`, data: { reason: 'forbidden' } };
  }
  return null;
}

// Route ids arrive as strings; anything that is not a whole number cannot be a
// request (and would make Postgres throw on the integer column).
function parseId(requestId) {
  const s = String(requestId ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && n <= 2147483647 ? n : null;
}

const notFound = (requestId) => ({
  ok: false, code: 'not_found',
  message: `Partial-dispatch request #${requestId} was not found.`,
  data: { reason: 'request_missing' },
});

// Plain-English "it is no longer waiting" for a request that exists but is not
// pending any more — who acted and what came of it, when the data says.
async function notPending(db, id) {
  const row = await db.get(
    `SELECT sr.status, sr.qty, sr.rejection_reason, jc.job_card_no, ch.job_card_no AS child_no, u.name AS acted_by
       FROM job_card_split_requests sr
       LEFT JOIN job_cards jc ON jc.id = sr.job_card_id
       LEFT JOIN job_cards ch ON ch.id = sr.child_job_card_id
       LEFT JOIN users u ON u.id = sr.approved_by
      WHERE sr.id = $1`, [id]);
  if (!row) return notFound(id);
  const what = `The partial dispatch of ${row.qty} from ${row.job_card_no || 'this job card'}`;
  const by = row.acted_by ? ` by ${row.acted_by}` : '';
  let message;
  if (row.status === 'approved') {
    message = `${what} was already approved${by}${row.child_no ? ` — split off as ${row.child_no}` : ''}.`;
  } else if (row.status === 'rejected') {
    message = `${what} was already rejected${by}${row.rejection_reason ? ` (reason: ${row.rejection_reason})` : ''}.`;
  } else {
    message = `${what} is no longer waiting (it is now "${row.status}").`;
  }
  return { ok: false, code: 'already_done', message, data: { reason: 'request_not_pending', status: row.status } };
}

// Thrown inside the approve transaction to undo the claim and hand back a
// plain result instead of an error.
class Refusal extends Error {
  constructor(result) { super(result.message); this.result = result; }
}

/**
 * Approve a pending partial-dispatch request: a child job card is created for
 * the requested qty (it inherits the parent's completed stages; straight to QC
 * if the parent already finished production) and the parent's qty is reduced.
 *
 * refuseIfOnHold: the WhatsApp path passes true so a card held for a CAPA is
 * decided in the app; the app route passes false (unchanged behaviour).
 */
async function approveSplitRequest(db, { requestId, actor, via = 'app', refuseIfOnHold = false } = {}) {
  const denied = checkRole(actor, 'approve');
  if (denied) return denied;
  const id = parseId(requestId);
  if (!id) return notFound(requestId);

  let done;
  try {
    done = await db.withTransaction(async (client) => {
      // First one wins: claim the request while it is still pending.
      const claim = await client.query(
        `UPDATE job_card_split_requests SET status='approved', approved_by=$2, approved_at=NOW()
          WHERE id=$1 AND status='pending' RETURNING *`,
        [id, actor.id]);
      const sr = claim.rows[0];
      if (!sr) return { unclaimed: true };

      // Lock the parent so its qty cannot change under us before it is reduced.
      const jc = (await client.query('SELECT * FROM job_cards WHERE id=$1 FOR UPDATE', [sr.job_card_id])).rows[0];
      if (!jc) {
        throw new Refusal({ ok: false, code: 'not_found', message: 'The job card for this partial-dispatch request was not found.', data: { reason: 'job_card_missing' } });
      }
      if (!SPLIT_APPROVABLE.includes(jc.status)) {
        throw new Refusal({
          ok: false, code: 'blocked',
          message: `${jc.job_card_no} is already ${statusWords(jc.status)}, so ${sr.qty} can no longer be split off it — reject this request instead.`,
          data: { reason: 'job_card_moved_on', status: jc.status },
        });
      }
      if (refuseIfOnHold && jc.status === 'on_hold') {
        throw new Refusal({
          ok: false, code: 'blocked',
          message: `${jc.job_card_no} is on hold for a CAPA — open the app to decide.`,
          data: { reason: 'on_hold' },
        });
      }
      if (sr.qty >= jc.qty) {
        throw new Refusal({
          ok: false, code: 'invalid',
          message: `${jc.job_card_no} now has only ${jc.qty} pcs, so ${sr.qty} cannot be split off — at least 1 must remain.`,
          data: { reason: 'qty_too_large', jobCardQty: jc.qty, requestQty: sr.qty },
        });
      }

      // Has the parent finished production? A finished split has nothing left to
      // produce and goes straight to QC as before. A mid-production split instead
      // gets its OWN checklist: it inherits the parent's completed stages and
      // continues from the current stage to Ready-for-Dispatch, which then triggers
      // QC exactly like any card. Inventory timing unchanged.
      // Ready-for-Dispatch is stage 29 on a production card but stage 4 on an FG
      // inventory card, which runs the short 4-stage checklist — asking about 29 on
      // an FG card can only ever answer "not finished".
      const readyStageNo = jc.is_fg ? 4 : 29;
      const readyDone = (await client.query(
        'SELECT id FROM production_checklist WHERE job_card_id=$1 AND stage_no=$2 AND done=1',
        [jc.id, readyStageNo])).rows[0] || null;
      const childStatus = readyDone ? 'qc_pending' : 'in_progress';

      const childCount = (await client.query('SELECT COUNT(*) AS n FROM job_cards WHERE parent_job_card_id=$1', [jc.id])).rows[0];
      const childNo = `${jc.job_card_no}-P${parseInt(childCount.n, 10) + 1}`;

      const { rows } = await client.query(
        `INSERT INTO job_cards (job_card_no, order_id, qty, dispatch_date, current_stage, punching, drawing_no, product_name, status, notes, uploaded_by, parent_job_card_id, order_item_id, file_path, file_name, original_name, replacement_query_id, tube_deducted, coil_deducted, fill_deducted, is_fg, fg_source_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
        [childNo, jc.order_id, sr.qty, jc.dispatch_date, jc.current_stage || 0, jc.punching, jc.drawing_no, jc.product_name,
         childStatus,
         `Partial dispatch of ${sr.qty} split from ${jc.job_card_no}. Reason: ${sr.reason}`, jc.uploaded_by, jc.id, jc.order_item_id,
         // Carry the parent's job-card document so the shopfloor can open it on the child too
         jc.file_path, jc.file_name, jc.original_name,
         // Inherit the replacement link so a split replacement card stays invoice-exempt
         jc.replacement_query_id || null,
         // Inherit the material-deduction flags: the parent's stage 3/5/6 draws
         // covered the whole batch (child pieces included), so re-ticking those
         // stages on the child must NOT deduct tube/coil/filling a second time.
         jc.tube_deducted || false, jc.coil_deducted || false, jc.fill_deducted || false,
         // A split of a Finished Goods inventory card is still a Finished Goods
         // card. Without these the child falls back to the full 29-stage
         // production checklist for material it never produced — it was drawn
         // from FG stock. fg_source_id keeps it pointing at the same FG row.
         jc.is_fg || false, jc.fg_source_id || null]);
      const childId = rows[0].id;
      // The split pieces went through the parent's completed stages as part of the
      // batch — copy those rows (values, worker, time, notes) so their records
      // travel with them and the mandatory-stage gate sees them as done.
      // Rejection/remade/dispatched/scrap quantities stay with the parent (its
      // accounting); the Ready-for-Dispatch stage is never copied so the child's
      // dispatch is its own — 29 on a production card, 4 on an FG card.
      await client.query(
        `INSERT INTO production_checklist (job_card_id, stage_no, done, value1, value2, worker_name, done_at, notes, coil_weight)
         SELECT $1, stage_no, done, value1, value2, worker_name, done_at, notes, coil_weight
         FROM production_checklist WHERE job_card_id=$2 AND done=1 AND stage_no <> $3`,
        [childId, jc.id, readyStageNo]);
      await client.query('UPDATE job_cards SET qty = qty - $1 WHERE id=$2', [sr.qty, jc.id]);
      await client.query('UPDATE job_card_split_requests SET child_job_card_id=$1 WHERE id=$2', [childId, sr.id]);
      return { sr, jc, childId, childNo, readyDone: !!readyDone };
    });
  } catch (err) {
    if (err instanceof Refusal) return err.result;
    throw err;
  }

  if (done.unclaimed) return notPending(db, id);

  const { sr, jc, childId, childNo, readyDone } = done;
  const remaining = jc.qty - sr.qty;
  if (sr.created_by) {
    await notify(db, {
      userId: sr.created_by, type: 'split_approved',
      title: `Partial dispatch approved — ${childNo}`,
      body: `${sr.qty} units split off as ${childNo} (${readyDone ? 'now in QC' : 'continue its checklist to Ready for Dispatch'}). ${jc.job_card_no} continues with ${remaining}.`,
      link: `/job-cards/${childId}`, sourceUserId: actor.id,
    });
  }
  await dbmod.logActivity(jc.order_id, jc.id, 'split_approved',
    `Partial dispatch approved: ${sr.qty} → ${childNo}${readyDone ? ' (to QC)' : ' (continues production)'}; ${jc.job_card_no} now ${remaining}${viaSuffix(via)}`,
    actor.id);

  return {
    ok: true,
    summary: `Approved partial dispatch of ${sr.qty} from ${jc.job_card_no} — split off as ${childNo} (${readyDone ? 'now in QC' : 'continues production'}); ${jc.job_card_no} continues with ${remaining}.`,
    data: {
      requestId: sr.id, jobCardId: jc.id, jobCardNo: jc.job_card_no,
      childJobCardId: childId, childJobCardNo: childNo, qty: sr.qty, remainingQty: remaining, readyDone,
    },
  };
}

/**
 * Reject a pending partial-dispatch request. A reason is mandatory.
 */
async function rejectSplitRequest(db, { requestId, actor, reason, via = 'app' } = {}) {
  const denied = checkRole(actor, 'reject');
  if (denied) return denied;
  const why = String(reason ?? '').trim();
  if (!why) return { ok: false, code: 'invalid', message: 'A rejection reason is required.', data: { reason: 'reason_required' } };
  const id = parseId(requestId);
  if (!id) return notFound(requestId);

  // First one wins: only a still-pending request can be rejected.
  const r = await db.run(
    `UPDATE job_card_split_requests SET status='rejected', rejection_reason=$1, approved_by=$2, approved_at=NOW()
      WHERE id=$3 AND status='pending' RETURNING *`,
    [why, actor.id, id]);
  const sr = r.rows?.[0];
  if (!sr) return notPending(db, id);

  const jc = await db.get('SELECT order_id, job_card_no FROM job_cards WHERE id=$1', [sr.job_card_id]);
  if (sr.created_by) {
    await notify(db, {
      userId: sr.created_by, type: 'split_rejected',
      title: `Partial dispatch rejected — ${jc?.job_card_no || ''}`,
      body: `Reason: ${why}`, link: `/job-cards/${sr.job_card_id}`, sourceUserId: actor.id,
    });
  }
  await dbmod.logActivity(jc?.order_id, sr.job_card_id, 'split_rejected', `Partial dispatch rejected: ${why}${viaSuffix(via)}`, actor.id);

  return {
    ok: true,
    summary: `Rejected partial dispatch of ${sr.qty} from ${jc?.job_card_no || `job card #${sr.job_card_id}`} (reason: ${why}).`,
    data: { requestId: sr.id, jobCardId: sr.job_card_id, jobCardNo: jc?.job_card_no || null, qty: sr.qty },
  };
}

module.exports = { approveSplitRequest, rejectSplitRequest, SPLIT_REQUESTABLE };
