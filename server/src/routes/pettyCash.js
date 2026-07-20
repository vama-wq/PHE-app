const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadPettyCashReceipt, deleteFromStorage } = require('../middleware/upload');

// Office Expense — Petty Cash ledger.
// Accounts records expenses; the owner records top-ups and can delete entries.
// Record-only (no approval gate). Balance = SUM(top_up) − SUM(expense).
// Receipt is compulsory for expenses above this amount (₹):
const RECEIPT_REQUIRED_ABOVE = 500;

// Ledger + balance. Optional ?month=YYYY-MM filters the entry list; the running
// balance always reflects ALL entries, and opening_balance is the balance before
// the filtered month so the client can show a true running column.
router.get('/', authenticate, authorize('accounts', 'owner'), async (req, res) => {
  const db = getDB();
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null;

  const params = [];
  let where = '';
  if (month) {
    where = `WHERE to_char(entry_date, 'YYYY-MM') = $1`;
    params.push(month);
  }
  const entries = await db.all(`
    SELECT e.*, u.name AS created_by_name
    FROM petty_cash_entries e LEFT JOIN users u ON u.id = e.created_by
    ${where}
    ORDER BY e.entry_date ASC, e.id ASC`, params);

  const bal = await db.get(`
    SELECT COALESCE(SUM(CASE WHEN entry_type='top_up' THEN amount ELSE -amount END), 0) AS balance
    FROM petty_cash_entries`);

  let opening = 0;
  if (month) {
    const o = await db.get(`
      SELECT COALESCE(SUM(CASE WHEN entry_type='top_up' THEN amount ELSE -amount END), 0) AS balance
      FROM petty_cash_entries WHERE to_char(entry_date, 'YYYY-MM') < $1`, [month]);
    opening = Number(o.balance);
  }

  const catParams = month ? [month] : [];
  const categories = await db.all(`
    SELECT TRIM(category) AS category, SUM(amount) AS total
    FROM petty_cash_entries
    WHERE entry_type='expense' ${month ? `AND to_char(entry_date, 'YYYY-MM') = $1` : ''}
    GROUP BY TRIM(category) ORDER BY total DESC`, catParams);

  res.json({
    entries,
    balance: Number(bal.balance),
    opening_balance: opening,
    category_totals: categories,
    receipt_required_above: RECEIPT_REQUIRED_ABOVE,
  });
});

// Distinct expense categories for the dropdown
router.get('/categories', authenticate, authorize('accounts', 'owner'), async (req, res) => {
  const rows = await getDB().all(`
    SELECT DISTINCT TRIM(category) AS category FROM petty_cash_entries
    WHERE category IS NOT NULL AND TRIM(category) <> '' ORDER BY 1`);
  res.json(rows.map(r => r.category));
});

// Record an entry. Expenses: accounts + owner. Top-ups: owner only.
router.post('/', authenticate, authorize('accounts', 'owner'), ...uploadPettyCashReceipt, async (req, res) => {
  try {
    const { entry_type, entry_date, category, description, paid_to, amount } = req.body;
    const db = getDB();
    if (!['expense', 'top_up'].includes(entry_type)) return res.status(400).json({ error: 'Invalid entry type' });
    if (entry_type === 'top_up' && req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Only the owner can record cash top-ups' });
    }
    if (!entry_date) return res.status(400).json({ error: 'Date is required' });
    const amt = parseFloat(amount);
    if (!(amt > 0)) return res.status(400).json({ error: 'Enter a valid amount' });
    if (entry_type === 'expense') {
      if (!(category || '').trim()) return res.status(400).json({ error: 'Category is required for expenses' });
      if (amt > RECEIPT_REQUIRED_ABOVE && !req.file) {
        return res.status(400).json({ error: `A receipt/bill photo is required for expenses above ₹${RECEIPT_REQUIRED_ABOVE}` });
      }
    }
    const r = await db.insert(
      `INSERT INTO petty_cash_entries (entry_date, entry_type, category, description, paid_to, amount, receipt_file, receipt_original_name, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [entry_date, entry_type, entry_type === 'expense' ? category.trim() : null,
       (description || '').trim() || null, (paid_to || '').trim() || null, amt,
       req.file?.storagePath || null, req.file?.originalname || null, req.user.id]
    );
    await logActivity(null, null, 'petty_cash_entry',
      entry_type === 'top_up'
        ? `Petty cash top-up: ₹${amt}`
        : `Petty cash expense: ₹${amt} — ${category}${paid_to ? ` (${paid_to})` : ''}`, req.user.id);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) {
    console.error('petty cash entry error:', e);
    res.status(500).json({ error: 'Failed to record entry' });
  }
});

// Owner can remove a wrong entry (receipt file is cleaned up too)
router.delete('/:id', authenticate, authorize('owner'), async (req, res) => {
  const db = getDB();
  const e = await db.get('SELECT * FROM petty_cash_entries WHERE id=$1', [req.params.id]);
  if (!e) return res.status(404).json({ error: 'Entry not found' });
  await db.run('DELETE FROM petty_cash_entries WHERE id=$1', [req.params.id]);
  await deleteFromStorage(e.receipt_file).catch(() => {});
  await logActivity(null, null, 'petty_cash_deleted',
    `Petty cash entry deleted: ${e.entry_type} ₹${e.amount}${e.category ? ` (${e.category})` : ''}`, req.user.id);
  res.json({ message: 'Entry deleted' });
});

module.exports = router;
