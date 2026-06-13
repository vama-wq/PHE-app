const router = require('express').Router();
const { getDB } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/planning-data', authenticate, authorize('owner', 'production'), async (req, res) => {
  const db = getDB();

  const cards = await db.all(`
    SELECT jc.id, jc.job_card_no, jc.qty, jc.dispatch_date, jc.status,
      jc.product_name, jc.drawing_no, jc.punching,
      o.order_code, c.customer_code
    FROM job_cards jc
    JOIN orders o ON jc.order_id = o.id
    JOIN customers c ON o.customer_id = c.id
    WHERE jc.status NOT IN ('dispatched', 'resolved_dispatched')
    ORDER BY jc.dispatch_date ASC
  `);

  const cardIds = cards.map(c => c.id);
  if (cardIds.length === 0) return res.json({ cards: [], stages: [] });

  const placeholders = cardIds.map((_, i) => `$${i + 1}`).join(',');
  const stages = await db.all(`
    SELECT job_card_id, stage_no, done, done_at, worker_name,
      rejection_qty, remade_qty
    FROM production_checklist
    WHERE job_card_id IN (${placeholders})
    ORDER BY job_card_id, stage_no
  `, cardIds);

  res.json({ cards, stages });
});

module.exports = router;
