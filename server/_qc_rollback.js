// Reject QC on ORD-079-26 (order 94 / job card 184) and send the work back to
// the Brazing stage (15). Mirrors the app's own reject flow:
//   qc.js PUT /:id/reject  -> reopen checklist, status 'in_progress',
//                             qc_rejected=TRUE, then syncOrderStatus.
// Extended here to roll back to a chosen stage rather than only stage 29.
// settleAfterQC is deliberately NOT run: that settles inventory for work that
// is finished, and this work is going back onto the floor.
// Runs in one transaction; pass --commit to keep it, otherwise it rolls back.
require('dotenv').config({ path: '.env' });
const { Pool } = require('pg');

const JOB_CARD = 184, ORDER = 94, BACK_TO = 15;
const NOTES = 'QC rejected by owner — returned to Brazing (stage 15) for rework.';
const COMMIT = process.argv.includes('--commit');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    const before = await c.query(
      'SELECT status, current_stage, qc_rejected, qc_route, qc_dispatch_qty FROM job_cards WHERE id=$1', [JOB_CARD]);
    console.log('BEFORE card:', JSON.stringify(before.rows[0]));
    const ob = await c.query('SELECT status FROM orders WHERE id=$1', [ORDER]);
    console.log('BEFORE order:', ob.rows[0].status);

    // 1. Reopen every stage from Brazing onward so the work is redone.
    const re = await c.query(
      'UPDATE production_checklist SET done=0, done_at=NULL WHERE job_card_id=$1 AND stage_no >= $2 AND done=1',
      [JOB_CARD, BACK_TO]);
    console.log('stages reopened:', re.rowCount);

    // 2. Card returns to production at Brazing; clear the QC routing decision.
    await c.query(
      `UPDATE job_cards
          SET status='in_progress', current_stage=$2, qc_rejected=TRUE, qc_rejection_notes=$3,
              qc_route=NULL, qc_dispatch_qty=NULL, qc_fg_qty=NULL
        WHERE id=$1`, [JOB_CARD, BACK_TO, NOTES]);

    // 3. Order status recomputed the same way syncOrderStatus does it.
    const cards = await c.query('SELECT status FROM job_cards WHERE order_id=$1', [ORDER]);
    const st = cards.rows.map(r => r.status);
    const newStatus = st.every(s => s === 'dispatched') ? 'dispatched'
      : st.some(s => s === 'qc_approved') ? 'qc_approved'
      : st.some(s => s === 'qc_pending') ? 'qc_pending'
      : st.some(s => s === 'in_progress' || s === 'on_hold') ? 'in_progress'
      : 'job_card_created';
    await c.query('UPDATE orders SET status=$2 WHERE id=$1', [ORDER, newStatus]);

    // 4. Audit trail, same shape the route writes.
    await c.query(
      `INSERT INTO activity_log (order_id, job_card_id, activity_type, description, created_by)
       VALUES ($1,$2,'status_changed',$3,(SELECT id FROM users WHERE role='owner' ORDER BY id LIMIT 1))`,
      [ORDER, JOB_CARD, `Job card PT-FLAMEPROOF-230U-1.5KW-3IN1 QC Rejected — returned to production at Brazing. ${NOTES}`]);

    const after = await c.query(
      'SELECT status, current_stage, qc_rejected, qc_route FROM job_cards WHERE id=$1', [JOB_CARD]);
    console.log('AFTER card :', JSON.stringify(after.rows[0]));
    console.log('AFTER order:', newStatus);
    const cl = await c.query(
      'SELECT stage_no, done FROM production_checklist WHERE job_card_id=$1 ORDER BY stage_no', [JOB_CARD]);
    console.log('done stages now:', cl.rows.filter(r => r.done).map(r => r.stage_no).join(',') || '(none)');
    console.log('reopened      :', cl.rows.filter(r => !r.done).map(r => r.stage_no).join(','));

    if (COMMIT) { await c.query('COMMIT'); console.log('\nCOMMITTED'); }
    else { await c.query('ROLLBACK'); console.log('\nROLLED BACK (dry run — pass --commit to apply)'); }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('FAILED, rolled back:', e.message);
    process.exitCode = 1;
  } finally { c.release(); await pool.end(); }
})();
