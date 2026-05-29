const router = require('express').Router();
const { getDB } = require('../db');
const { authenticate } = require('../middleware/auth');

router.get('/order/:orderId', authenticate, async (req, res) => {
  const logs = await getDB().all(
    `SELECT a.*, u.name as user_name, u.role as user_role
     FROM activity_log a LEFT JOIN users u ON a.created_by = u.id
     WHERE a.order_id = $1
     ORDER BY a.created_at ASC`,
    [req.params.orderId]
  );
  res.json(logs);
});

router.get('/recent', authenticate, async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 20;
  const logs = await getDB().all(
    `SELECT a.*, u.name as user_name, u.role as user_role,
       o.order_code, jc.job_card_no
     FROM activity_log a
     LEFT JOIN users u ON a.created_by = u.id
     LEFT JOIN orders o ON a.order_id = o.id
     LEFT JOIN job_cards jc ON a.job_card_id = jc.id
     ORDER BY a.created_at DESC LIMIT $1`,
    [limit]
  );
  res.json(logs);
});

module.exports = router;
