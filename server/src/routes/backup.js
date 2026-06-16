const router = require('express').Router();
const { getDB } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

// Latest backup status for the dashboard badge. Owner/admin only.
// Resilient: if the backup_log table doesn't exist yet, returns { status: null }.
router.get('/status', authenticate, authorize('owner', 'admin'), async (req, res) => {
  try {
    const row = await getDB().get(
      `SELECT backup_date, status, file_count, db_bytes, storage_bytes, total_bytes,
              failures, host, completed_at
       FROM backup_log
       ORDER BY completed_at DESC
       LIMIT 1`
    );
    res.json(row || { status: null });
  } catch (err) {
    if (err.code === '42P01') return res.json({ status: null }); // table not created yet
    console.error('backup status error:', err.message);
    res.json({ status: null });
  }
});

module.exports = router;
