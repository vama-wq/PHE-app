const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadPettyCashReceipt, deleteFromStorage } = require('../middleware/upload');

// Office Expense — Petty Cash ledger.
// Categories are a fixed, owner-managed list. Accounts records expenses; the
// owner records top-ups and can delete entries. Balance = SUM(top_up) −
// SUM(expense WHERE affects_cash). Machinery expenses paid to "Jay Bhramani"
// are recorded but DON'T reduce cash-in-hand (affects_cash = FALSE); every
// other machinery company deducts and gets its own ledger.
const RECEIPT_REQUIRED_ABOVE = 500;
const MACHINERY = 'Machinery';
const NO_CASH_COMPANY = 'jay bhramani'; // lower-cased for comparison

// Whether an expense reduces cash-in-hand
const affectsCash = (category, paidTo) =>
  !(String(category).trim() === MACHINERY && String(paidTo || '').trim().toLowerCase() === NO_CASH_COMPANY);

// ── Ledger + balance ──────────────────────────────────────────────────────────
// Filters: ?month=YYYY-MM, ?category=<name>, ?company=<paid_to> (company scoped
// to Machinery). Category/company filters are owner-only (per-account ledgers).
router.get('/', authenticate, authorize('accounts', 'owner'), async (req, res) => {
  const db = getDB();
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null;
  const category = (req.query.category || '').trim() || null;
  const company = (req.query.company || '').trim() || null;
  if ((category || company) && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Category / company ledgers are owner-only' });
  }

  const conds = [];
  const params = [];
  if (month)    { params.push(month);    conds.push(`to_char(entry_date, 'YYYY-MM') = $${params.length}`); }
  if (category) { params.push(category); conds.push(`TRIM(category) = $${params.length}`); }
  if (company)  { params.push(company);  conds.push(`TRIM(category) = '${MACHINERY}' AND TRIM(paid_to) = $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const entries = await db.all(`
    SELECT e.*, u.name AS created_by_name
    FROM petty_cash_entries e LEFT JOIN users u ON u.id = e.created_by
    ${where}
    ORDER BY e.entry_date ASC, e.id ASC`, params);

  // Cash-in-hand always reflects ALL cash-affecting entries (not filtered).
  const bal = await db.get(`
    SELECT COALESCE(SUM(CASE WHEN entry_type='top_up' THEN amount
                             WHEN affects_cash THEN -amount ELSE 0 END), 0) AS balance
    FROM petty_cash_entries`);

  // Opening figure for the running column, only meaningful when a month is set.
  //  • unfiltered → prior CASH balance (cash-impact aware)
  //  • category/company ledger → prior CUMULATIVE spend in that account
  let opening = 0;
  if (month) {
    if (category || company) {
      const bp = [month];
      const bc = [`to_char(entry_date, 'YYYY-MM') < $1`, `entry_type='expense'`];
      if (category) { bp.push(category); bc.push(`TRIM(category) = $${bp.length}`); }
      if (company)  { bp.push(company);  bc.push(`TRIM(category) = '${MACHINERY}' AND TRIM(paid_to) = $${bp.length}`); }
      const o = await db.get(`SELECT COALESCE(SUM(amount),0) AS t FROM petty_cash_entries WHERE ${bc.join(' AND ')}`, bp);
      opening = Number(o.t);
    } else {
      const o = await db.get(`
        SELECT COALESCE(SUM(CASE WHEN entry_type='top_up' THEN amount
                                 WHEN affects_cash THEN -amount ELSE 0 END), 0) AS balance
        FROM petty_cash_entries WHERE to_char(entry_date, 'YYYY-MM') < $1`, [month]);
      opening = Number(o.balance);
    }
  }

  const catParams = month ? [month] : [];
  const category_totals = await db.all(`
    SELECT TRIM(category) AS category, SUM(amount) AS total
    FROM petty_cash_entries
    WHERE entry_type='expense' ${month ? `AND to_char(entry_date, 'YYYY-MM') = $1` : ''}
    GROUP BY TRIM(category) ORDER BY total DESC`, catParams);

  res.json({
    entries,
    balance: Number(bal.balance),
    opening_balance: opening,
    category_totals,
    filter: { category, company },
    receipt_required_above: RECEIPT_REQUIRED_ABOVE,
  });
});

// Owner-only: list of ledger accounts (each category + each Machinery company)
router.get('/ledgers', authenticate, authorize('owner'), async (req, res) => {
  const db = getDB();
  const categories = await db.all(`
    SELECT c.name,
      COALESCE((SELECT SUM(amount) FROM petty_cash_entries e WHERE TRIM(e.category)=c.name AND e.entry_type='expense'), 0) AS total_out,
      COALESCE((SELECT COUNT(*) FROM petty_cash_entries e WHERE TRIM(e.category)=c.name AND e.entry_type='expense'), 0) AS entry_count
    FROM petty_cash_categories c ORDER BY c.id`);
  const companies = await db.all(`
    SELECT co.name,
      COALESCE((SELECT SUM(amount) FROM petty_cash_entries e WHERE TRIM(e.category)='${MACHINERY}' AND TRIM(e.paid_to)=co.name AND e.entry_type='expense'), 0) AS total_out,
      COALESCE((SELECT COUNT(*) FROM petty_cash_entries e WHERE TRIM(e.category)='${MACHINERY}' AND TRIM(e.paid_to)=co.name AND e.entry_type='expense'), 0) AS entry_count,
      (lower(co.name) = '${NO_CASH_COMPANY}') AS no_cash
    FROM petty_cash_companies co ORDER BY co.id`);
  res.json({ categories, companies });
});

// Category list (fixed, owner-managed)
router.get('/categories', authenticate, authorize('accounts', 'owner'), async (req, res) => {
  const rows = await getDB().all('SELECT name FROM petty_cash_categories ORDER BY id');
  res.json(rows.map(r => r.name));
});

// Machinery "paid to" companies
router.get('/companies', authenticate, authorize('accounts', 'owner'), async (req, res) => {
  const rows = await getDB().all('SELECT name FROM petty_cash_companies ORDER BY id');
  res.json(rows.map(r => r.name));
});

// Owner-only: add a category
router.post('/categories', authenticate, authorize('owner'), async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Category name is required' });
  try {
    await getDB().run('INSERT INTO petty_cash_categories (name, created_by) VALUES ($1,$2)', [name, req.user.id]);
    res.status(201).json({ message: 'Category added' });
  } catch (e) {
    if (/unique|duplicate/i.test(e.message)) return res.status(409).json({ error: 'Category already exists' });
    throw e;
  }
});

// accounts + owner: add a Machinery "paid to" company
router.post('/companies', authenticate, authorize('accounts', 'owner'), async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Company name is required' });
  try {
    await getDB().run('INSERT INTO petty_cash_companies (name, created_by) VALUES ($1,$2)', [name, req.user.id]);
    res.status(201).json({ message: 'Company added' });
  } catch (e) {
    if (/unique|duplicate/i.test(e.message)) return res.status(409).json({ error: 'Company already exists' });
    throw e;
  }
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

    let cash = true;
    if (entry_type === 'expense') {
      const cat = (category || '').trim();
      const to = (paid_to || '').trim();
      if (!cat) return res.status(400).json({ error: 'Category is required for expenses' });
      const known = await db.get('SELECT id FROM petty_cash_categories WHERE lower(name)=lower($1)', [cat]);
      if (!known) return res.status(400).json({ error: 'Pick a valid category' });
      if (!to) return res.status(400).json({ error: 'Paid To is required' });
      if (cat === MACHINERY) {
        if (!(description || '').trim()) return res.status(400).json({ error: 'Description is required for Machinery expenses' });
        const co = await db.get('SELECT id FROM petty_cash_companies WHERE lower(name)=lower($1)', [to]);
        if (!co) return res.status(400).json({ error: 'Pick a company from the list (or add it)' });
      }
      if (amt > RECEIPT_REQUIRED_ABOVE && !req.file) {
        return res.status(400).json({ error: `A receipt/bill photo is required for expenses above ₹${RECEIPT_REQUIRED_ABOVE}` });
      }
      cash = affectsCash(cat, to);
    }

    const r = await db.insert(
      `INSERT INTO petty_cash_entries (entry_date, entry_type, category, description, paid_to, amount, affects_cash, receipt_file, receipt_original_name, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [entry_date, entry_type, entry_type === 'expense' ? category.trim() : null,
       (description || '').trim() || null, (paid_to || '').trim() || null, amt,
       entry_type === 'top_up' ? true : cash,
       req.file?.storagePath || null, req.file?.originalname || null, req.user.id]
    );
    await logActivity(null, null, 'petty_cash_entry',
      entry_type === 'top_up'
        ? `Petty cash top-up: ₹${amt}`
        : `Petty cash expense: ₹${amt} — ${category}${paid_to ? ` (${paid_to})` : ''}${cash ? '' : ' [no cash impact]'}`, req.user.id);
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
