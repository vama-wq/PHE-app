const router = require('express').Router();
const { getDB } = require('../db');
const { authenticate } = require('../middleware/auth');

router.get('/unread-count', authenticate, async (req, res) => {
  const r = await getDB().get(
    'SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND is_read = 0',
    [req.user.id]
  );
  res.json({ count: parseInt(r?.count || 0) });
});

router.get('/', authenticate, async (req, res) => {
  const notifications = await getDB().all(
    `SELECT n.*, u.name as source_user_name, u.role as source_user_role
     FROM notifications n
     LEFT JOIN users u ON u.id = n.source_user_id
     WHERE n.user_id = $1
     ORDER BY n.created_at DESC
     LIMIT 50`,
    [req.user.id]
  );
  res.json(notifications);
});

router.put('/:id/read', authenticate, async (req, res) => {
  await getDB().run(
    'UPDATE notifications SET is_read = 1 WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );
  res.json({ message: 'Marked as read' });
});

router.put('/read-all', authenticate, async (req, res) => {
  await getDB().run(
    'UPDATE notifications SET is_read = 1 WHERE user_id = $1',
    [req.user.id]
  );
  res.json({ message: 'All marked as read' });
});

async function createNotification(db, { userId, type, title, body, link, sourceUserId }) {
  await db.insert(
    'INSERT INTO notifications (user_id, type, title, body, link, source_user_id) VALUES ($1,$2,$3,$4,$5,$6)',
    [userId, type, title, body || null, link || null, sourceUserId || null]
  );
}

async function notifyAllExcept(db, excludeUserId, payload) {
  const users = await db.all('SELECT id FROM users WHERE id != $1', [excludeUserId]);
  for (const u of users) {
    await createNotification(db, { ...payload, userId: u.id });
  }
}

module.exports = router;
module.exports.createNotification = createNotification;
module.exports.notifyAllExcept = notifyAllExcept;
