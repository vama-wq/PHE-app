const router = require('express').Router();
const { getDB } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/planning-data', authenticate, authorize('owner', 'production'), async (req, res) => {
  try {
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

    if (cards.length === 0) return res.json({ cards: [], stages: [] });

    // Fetch all checklist stages for active cards in one query using a subquery
    const stages = await db.all(`
      SELECT pc.job_card_id, pc.stage_no, pc.done, pc.done_at, pc.worker_name,
        pc.rejection_qty, pc.remade_qty
      FROM production_checklist pc
      WHERE pc.job_card_id IN (
        SELECT jc.id FROM job_cards jc
        WHERE jc.status NOT IN ('dispatched', 'resolved_dispatched')
      )
      ORDER BY pc.job_card_id, pc.stage_no
    `);

    res.json({ cards, stages });
  } catch (err) {
    console.error('Manufacturing planning-data error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Temporary debug endpoint — remove after testing
router.get('/debug', async (req, res) => {
  try {
    const db = getDB();
    const { rows } = await db.pool.query('SELECT COUNT(*) as c FROM job_cards WHERE status NOT IN ($1, $2)', ['dispatched', 'resolved_dispatched']);
    res.json({ ok: true, activeCards: rows[0].c });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
