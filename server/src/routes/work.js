// One answer to "what is waiting on me?" — a count behind every nav item,
// worked out for the signed-in person's role and, where it is personal (a
// message sent to them), their user id. The sidebar polls this and pills each
// item, the way Drawings has always been pilled. Every count is its own query
// in its own try/catch: one bad query zeroes one badge, not the sidebar.
const router = require('express').Router();
const { getDB } = require('../db');
const { authenticate } = require('../middleware/auth');

const CLOSED = `('dispatched','in_finished_goods','resolved_dispatched','cancelled','closed','completed','rejected')`;

// A count is [label, sql, params]. Labels feed the tooltip so a "24" on
// Purchases says what the 24 are.
function rules(role, uid) {
  const R = {};
  const add = (nav, label, sql, params = []) => (R[nav] ||= []).push({ label, sql, params });
  const all = ['owner', 'admin', 'accounts', 'design', 'production'].includes(role);
  const is = (...roles) => roles.includes(role);

  // ── Dashboard: the bell ──
  add('dashboard', 'unread notifications', `SELECT COUNT(*)::int n FROM notifications WHERE user_id=$1 AND is_read=0`, [uid]);

  // ── Orders ──
  if (all) add('orders', 'messages mentioning you', `SELECT COUNT(*)::int n FROM message_mentions WHERE mentioned_user_id=$1 AND is_read=0`, [uid]);
  if (is('owner')) add('orders', 'orders awaiting your approval', `SELECT COUNT(*)::int n FROM orders WHERE status='pending_approval'`);
  if (is('design')) add('orders', 'carried inventory to check', `SELECT COUNT(*)::int n FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.bom_review='needed' AND o.status NOT IN ${CLOSED}`);

  // ── Drawings ──
  if (is('owner')) add('drawings', 'drawings awaiting your approval', `SELECT COUNT(*)::int n FROM order_drawings d JOIN orders o ON o.id=d.order_id WHERE d.drawing_status='pending_review' AND o.status NOT IN ${CLOSED}`);
  if (is('design', 'admin')) {
    add('drawings', 'drawings rejected — revise', `SELECT COUNT(*)::int n FROM order_drawings d JOIN orders o ON o.id=d.order_id WHERE d.drawing_status='rejected' AND o.status NOT IN ${CLOSED}`);
    add('drawings', 'items with no drawing yet', `SELECT COUNT(*)::int n FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.status NOT IN ${CLOSED} AND o.status<>'pending_approval' AND COALESCE(o.drawing_bypassed,FALSE)=FALSE AND NOT EXISTS (SELECT 1 FROM order_drawings d WHERE d.item_id=oi.id)`);
  }

  // ── Job Cards ──
  if (is('owner', 'admin')) add('job-cards', 'items still needing a job card',
    `SELECT COUNT(*)::int n FROM order_items oi JOIN orders o ON o.id=oi.order_id
      WHERE o.status NOT IN ${CLOSED} AND o.status<>'pending_approval'
        AND (COALESCE(o.drawing_bypassed,FALSE) OR EXISTS (SELECT 1 FROM order_drawings d WHERE d.item_id=oi.id AND d.drawing_status='approved'))
        AND COALESCE((SELECT SUM(qty) FROM job_cards jc WHERE jc.order_item_id=oi.id),0) < COALESCE(oi.quantity,0)`);
  if (is('owner')) {
    add('job-cards', 'split requests to approve', `SELECT COUNT(*)::int n FROM job_card_split_requests WHERE status='pending'`);
    add('job-cards', 'CAPA reports to approve', `SELECT COUNT(*)::int n FROM capa_reports WHERE status='awaiting_approval'`);
  }

  // ── Production ──
  if (is('production')) {
    add('production', 'new cards not started', `SELECT COUNT(*)::int n FROM job_cards WHERE status='pending'`);
    add('production', 'sent back by QC', `SELECT COUNT(*)::int n FROM job_cards WHERE status='in_progress' AND qc_rejected=TRUE`);
    add('production', 'CAPA reports to write', `SELECT COUNT(*)::int n FROM capa_reports WHERE status='open'`);
  }
  if (is('owner', 'admin')) add('production', 'holds to approve', `SELECT COUNT(*)::int n FROM job_card_holds WHERE status='pending'`);

  // ── Quality Check ──
  if (is('design', 'owner', 'admin')) {
    add('qc', 'job cards pending QC', `SELECT COUNT(*)::int n FROM job_cards jc WHERE jc.status='qc_pending' OR (jc.status='in_progress' AND EXISTS (SELECT 1 FROM production_checklist WHERE job_card_id=jc.id AND stage_no=29 AND done=1))`);
    add('qc', 'received materials awaiting QC', `SELECT COUNT(*)::int n FROM purchase_order_items WHERE received=TRUE AND qc_status IS NULL`);
    add('qc', 'returns awaiting QC check', `SELECT COUNT(*)::int n FROM customer_queries WHERE status='product_return' AND return_status='qc_check'`);
  }

  // ── Dispatch ──
  if (is('accounts', 'owner')) add('dispatch', 'cards ready to dispatch', `SELECT COUNT(*)::int n FROM job_cards WHERE status='qc_approved' AND COALESCE(qc_dispatch_qty,0)>0`);

  // ── Customer Queries ──
  if (all) add('customer-queries', 'query messages mentioning you', `SELECT COUNT(*)::int n FROM customer_query_mentions WHERE mentioned_user_id=$1 AND is_read=0`, [uid]);
  if (is('owner')) {
    add('customer-queries', 'open queries', `SELECT COUNT(*)::int n FROM customer_queries WHERE status IN ('open','in_progress')`);
    add('customer-queries', 'returns needing a return type', `SELECT COUNT(*)::int n FROM customer_queries WHERE status='product_return' AND return_status='pending_return' AND return_type IS NULL`);
  } else if (all) {
    add('customer-queries', `open queries for ${role}`, `SELECT COUNT(*)::int n FROM customer_queries WHERE status IN ('open','in_progress') AND assigned_department=$1`, [role]);
  }
  if (is('accounts', 'admin')) add('customer-queries', 'returns to mark received', `SELECT COUNT(*)::int n FROM customer_queries WHERE status='product_return' AND return_status='pending_return' AND return_type IS NOT NULL`);
  if (is('accounts')) add('customer-queries', 'debit notes to record', `SELECT COUNT(*)::int n FROM customer_queries WHERE status='product_return' AND return_type='debit_note' AND debit_note_no IS NULL`);
  if (is('production')) add('customer-queries', 'returns in repair', `SELECT COUNT(*)::int n FROM customer_queries WHERE status='product_return' AND return_status='in_repair'`);
  if (is('design')) add('customer-queries', 'returns awaiting QC check', `SELECT COUNT(*)::int n FROM customer_queries WHERE status='product_return' AND return_status='qc_check'`);

  // ── Inventory ──
  if (is('owner')) add('inventory', 'items awaiting your approval', `SELECT COUNT(*)::int n FROM inventory_items WHERE approval_status='pending_approval'`);

  // ── Purchases ──
  if (is('owner', 'admin', 'accounts')) {
    add('purchases', 'PO messages mentioning you', `SELECT COUNT(*)::int n FROM purchase_order_message_mentions WHERE mentioned_user_id=$1 AND is_read=0`, [uid]);
    add('purchases', 'draft POs to approve', `SELECT COUNT(*)::int n FROM purchase_orders WHERE status='draft'`);
    add('purchases', 'approved POs to send', `SELECT COUNT(*)::int n FROM purchase_orders WHERE status='approved'`);
    add('purchases', 'sent POs awaiting receipt', `SELECT COUNT(*)::int n FROM purchase_orders WHERE status='sent'`);
    add('purchases', 'received POs with no invoice', `SELECT COUNT(*)::int n FROM purchase_orders WHERE status='received' AND invoice_file IS NULL`);
    add('purchases', 'supplier debit notes to raise', `SELECT COUNT(*)::int n FROM purchase_debit_notes WHERE status='pending'`);
  }
  if (is('owner')) {
    add('purchases', 'rate increases to approve', `SELECT COUNT(*)::int n FROM purchase_orders WHERE rate_increase_pending=TRUE`);
    add('purchases', 'over-receipts to approve', `SELECT COUNT(*)::int n FROM purchase_order_items WHERE COALESCE(over_qty_pending,0)>0`);
  }

  // ── Account Statement ──
  if (is('owner')) {
    add('petty-cash', 'samples to approve', `SELECT COUNT(*)::int n FROM petty_cash_samples WHERE status='pending'`);
    add('petty-cash', 'bank expenses unpaid', `SELECT COUNT(*)::int n FROM petty_cash_entries WHERE entry_type='expense' AND payment_method='unpaid_bank'`);
  }
  if (is('accounts')) {
    add('petty-cash', 'samples to link to inventory', `SELECT COUNT(*)::int n FROM petty_cash_samples WHERE status='awaiting_inventory'`);
    add('petty-cash', 'approved samples to complete', `SELECT COUNT(*)::int n FROM petty_cash_samples WHERE status='approved'`);
  }

  // ── Payroll ──
  if (is('owner')) {
    add('payroll', 'runs to approve', `SELECT COUNT(*)::int n FROM payroll_runs WHERE status='submitted'`);
    add('payroll', 'approved runs to mark paid', `SELECT COUNT(*)::int n FROM payroll_runs WHERE status='approved'`);
  }
  if (is('accounts')) add('payroll', 'runs still being prepared', `SELECT COUNT(*)::int n FROM payroll_runs WHERE status NOT IN ('submitted','approved','paid')`);

  return R;
}

// Months that have ended with no payroll run at all — the run accounts has
// not even started. Runs carry month as 'YYYY-MM' text.
async function missingPayrollMonths(db) {
  const last = await db.get(`SELECT MAX(month) AS m FROM payroll_runs`);
  const now = new Date();
  const lastEnded = new Date(now.getFullYear(), now.getMonth(), 1); // first of this month = last month has ended
  let cursor = last?.m ? new Date(Number(last.m.slice(0, 4)), Number(last.m.slice(5, 7)), 1) // month after the last run
                       : lastEnded;
  let n = 0;
  while (cursor < lastEnded) { n++; cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1); }
  return n;
}

router.get('/pending', authenticate, async (req, res) => {
  const db = getDB();
  const role = req.user.role, uid = req.user.id;
  const R = rules(role, uid);
  const counts = {}, detail = {};
  for (const [nav, items] of Object.entries(R)) {
    for (const it of items) {
      let n = 0;
      try { n = (await db.get(it.sql, it.params))?.n || 0; }
      catch (e) { console.error(`[work] ${nav} / ${it.label}: ${e.message}`); }
      if (n > 0) { counts[nav] = (counts[nav] || 0) + n; (detail[nav] ||= []).push([it.label, n]); }
    }
  }
  if (['owner', 'accounts'].includes(role)) {
    try {
      const n = await missingPayrollMonths(db);
      if (n > 0) { counts.payroll = (counts.payroll || 0) + n; (detail.payroll ||= []).push(['months with no payroll run', n]); }
    } catch (e) { console.error('[work] payroll months: ' + e.message); }
  }
  res.json({ counts, detail });
});

module.exports = router;
module.exports.rules = rules;
module.exports.missingPayrollMonths = missingPayrollMonths;
