const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadPettyCashReceipt, deleteFromStorage } = require('../middleware/upload');
const { createNotification } = require('./notifications');
const { statusAfterTrip, PLATING_COMPANIES } = require('../lib/plating');

// Office Expense — Petty Cash ledger.
// Categories are a fixed, owner-managed list. Accounts records expenses; the
// owner records top-ups and can delete entries. Balance = SUM(top_up) −
// SUM(expense WHERE affects_cash). Machinery expenses paid to "Jay Bhramani"
// are recorded but DON'T reduce cash-in-hand (affects_cash = FALSE); every
// other machinery company deducts and gets its own ledger.
const RECEIPT_REQUIRED_ABOVE = 500;
const MACHINERY = 'Machinery';
const SAMPLING = 'Sampling';
const EMPLOYEE_EXPENSE = 'Employee Expense';
const PLATING = 'Plating';
// External coating vendors come from lib/plating (imported above) so the payee
// list and the trip vendor list can never diverge.
// Bank → Cash transfer: a paid_bank expense (bank down) + auto-created linked
// cash top-up (cash up), committed together.
const BANK_WITHDRAWAL = 'Bank Withdrawal';
const NO_CASH_COMPANY = 'jay bhramani'; // lower-cased for comparison
// Employee Expense sub-types (stored in `description`). Advance Paid & Employee
// Care pick a worker from the payroll list; the others need a free-text Paid To.
const EMP_TYPES = ['Advance Paid', 'Employee Welfare', 'Employee Care', 'Miscellaneous'];
const EMP_TYPES_WORKER = ['Advance Paid', 'Employee Care'];

// ── Ledger + balance ──────────────────────────────────────────────────────────
// Filters: ?month=YYYY-MM, ?category=<name>, ?company=<paid_to> (company scoped
// to Machinery). Category/company filters are owner-only (per-account ledgers).
router.get('/', authenticate, authorize('accounts', 'owner'), async (req, res) => {
  const db = getDB();
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null;
  const category = (req.query.category || '').trim() || null;
  const company = (req.query.company || '').trim() || null;
  const method = ['cash', 'paid_bank', 'unpaid_bank'].includes(req.query.method) ? req.query.method : null;
  if ((category || company || method) && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Ledger filters are owner-only' });
  }

  const conds = [];
  const params = [];
  if (month)    { params.push(month);    conds.push(`to_char(entry_date, 'YYYY-MM') = $${params.length}`); }
  if (category) { params.push(category); conds.push(`TRIM(category) = $${params.length}`); }
  if (company)  { params.push(company);  conds.push(`TRIM(category) = '${MACHINERY}' AND TRIM(paid_to) = $${params.length}`); }
  if (method)   { params.push(method);   conds.push(`payment_method = $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const entries = await db.all(`
    SELECT e.*, u.name AS created_by_name
    FROM petty_cash_entries e LEFT JOIN users u ON u.id = e.created_by
    ${where}
    ORDER BY e.entry_date ASC, e.id ASC`, params);

  // Two live balances (all entries, not filtered) driven by payment_method:
  //  cash → Cash balance, paid_bank → Bank balance, unpaid_bank → neither.
  const acctSum = (method) => `COALESCE(SUM(CASE WHEN payment_method='${method}'
      THEN (CASE WHEN entry_type='top_up' THEN amount ELSE -amount END) ELSE 0 END), 0)`;
  const bal = await db.get(`
    SELECT ${acctSum('cash')} AS cash, ${acctSum('paid_bank')} AS bank,
           COALESCE(SUM(CASE WHEN entry_type='expense' AND payment_method='unpaid_bank' THEN amount ELSE 0 END), 0) AS unpaid_pending
    FROM petty_cash_entries`);

  // Opening figures for the running columns, only meaningful when a month is set.
  //  • unfiltered → prior Cash + Bank balances (per account)
  //  • category/company ledger → prior CUMULATIVE spend in that account
  let opening = 0, opening_cash = 0, opening_bank = 0;
  if (month) {
    if (category || company) {
      const bp = [month];
      const bc = [`to_char(entry_date, 'YYYY-MM') < $1`, `entry_type='expense'`];
      if (category) { bp.push(category); bc.push(`TRIM(category) = $${bp.length}`); }
      if (company)  { bp.push(company);  bc.push(`TRIM(category) = '${MACHINERY}' AND TRIM(paid_to) = $${bp.length}`); }
      const o = await db.get(`SELECT COALESCE(SUM(amount),0) AS t FROM petty_cash_entries WHERE ${bc.join(' AND ')}`, bp);
      opening = Number(o.t);
    } else if (method) {
      // Bank / Cash carry a running balance (top-up − expense); Unpaid Bank a
      // cumulative pending total.
      const o = method === 'unpaid_bank'
        ? await db.get(`SELECT COALESCE(SUM(amount),0) AS t FROM petty_cash_entries WHERE to_char(entry_date,'YYYY-MM') < $1 AND entry_type='expense' AND payment_method='unpaid_bank'`, [month])
        : await db.get(`SELECT ${acctSum(method)} AS t FROM petty_cash_entries WHERE to_char(entry_date,'YYYY-MM') < $1`, [month]);
      opening = Number(o.t);
    } else {
      const o = await db.get(`
        SELECT ${acctSum('cash')} AS cash, ${acctSum('paid_bank')} AS bank
        FROM petty_cash_entries WHERE to_char(entry_date, 'YYYY-MM') < $1`, [month]);
      opening_cash = Number(o.cash);
      opening_bank = Number(o.bank);
    }
  }

  const catParams = month ? [month] : [];
  const category_totals = await db.all(`
    SELECT TRIM(category) AS category, SUM(amount) AS total
    FROM petty_cash_entries
    WHERE entry_type='expense' ${month ? `AND to_char(entry_date, 'YYYY-MM') = $1` : ''}
    GROUP BY TRIM(category) ORDER BY total DESC`, catParams);

  // Bank balance figures are owner-only — accounts keeps the entries list and
  // the cash balance (they manage the physical cash box), nothing bank-side.
  const isOwner = req.user.role === 'owner';
  res.json({
    entries,
    cash_balance: Number(bal.cash),
    bank_balance: isOwner ? Number(bal.bank) : null,
    unpaid_pending: isOwner ? Number(bal.unpaid_pending) : null,
    opening_cash,
    opening_bank: isOwner ? opening_bank : null,
    opening_balance: opening, // cumulative spend / running balance for filtered views
    category_totals,
    filter: { category, company, method },
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
  // Payment-method ledgers: Cash and Bank show their live balance
  // (top-up − expense); Unpaid Bank shows the pending total awaiting payment.
  const m = await db.get(`
    SELECT
      COALESCE(SUM(CASE WHEN payment_method='cash' THEN (CASE WHEN entry_type='top_up' THEN amount ELSE -amount END) ELSE 0 END), 0) AS cash_balance,
      COALESCE(COUNT(*) FILTER (WHERE payment_method='cash'), 0) AS cash_count,
      COALESCE(SUM(CASE WHEN payment_method='paid_bank' THEN (CASE WHEN entry_type='top_up' THEN amount ELSE -amount END) ELSE 0 END), 0) AS bank_balance,
      COALESCE(COUNT(*) FILTER (WHERE payment_method='paid_bank'), 0) AS bank_count,
      COALESCE(SUM(CASE WHEN payment_method='unpaid_bank' AND entry_type='expense' THEN amount ELSE 0 END), 0) AS unpaid_total,
      COALESCE(COUNT(*) FILTER (WHERE payment_method='unpaid_bank'), 0) AS unpaid_count
    FROM petty_cash_entries`);
  const methods = [
    { key: 'cash',        label: 'Cash in Hand', total: Number(m.cash_balance), count: Number(m.cash_count),  balance: true },
    { key: 'paid_bank',   label: 'Bank',        total: Number(m.bank_balance),  count: Number(m.bank_count),   balance: true },
    { key: 'unpaid_bank', label: 'Unpaid Bank', total: Number(m.unpaid_total),  count: Number(m.unpaid_count) },
  ];
  res.json({ categories, companies, methods });
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
  // The receipt is pushed to storage by the upload middleware BEFORE this
  // handler runs — discard it on every failure path so nothing is orphaned.
  let committed = false; // once the entry row exists, the receipt is referenced — never discard it
  const discardReceipt = () => { if (!committed && req.file?.storagePath) deleteFromStorage(req.file.storagePath).catch(() => {}); };
  const fail = (code, msg) => { discardReceipt(); return res.status(code).json({ error: msg }); };
  try {
    const { entry_type, entry_date, description, paid_to, amount } = req.body;
    const db = getDB();
    if (!['expense', 'top_up'].includes(entry_type)) return fail(400, 'Invalid entry type');
    if (entry_type === 'top_up' && req.user.role !== 'owner') {
      return fail(403, 'Only the owner can record cash top-ups');
    }
    if (!entry_date) return fail(400, 'Date is required');
    const amt = parseFloat(amount);
    if (!(amt > 0)) return fail(400, 'Enter a valid amount');

    let method = String(req.body.payment_method || '').trim();
    // Top-ups can only land in cash or paid_bank; expenses may also be unpaid_bank
    const validMethods = entry_type === 'top_up' ? ['cash', 'paid_bank'] : ['cash', 'paid_bank', 'unpaid_bank'];
    if (!validMethods.includes(method)) {
      return fail(400, entry_type === 'top_up' ? 'Select Cash or Bank' : 'Select a payment method (Cash / Paid Bank / Unpaid Bank)');
    }

    // Sampling expenses carry full draft details for the future supplier + item
    let sample = null;
    let cat = null;
    let empExpense = null;       // { type, employee_id, isAdvance } for Employee Expense
    let finalPaidTo = (paid_to || '').trim();
    let finalDescription = (description || '').trim() || null;
    if (entry_type === 'expense') {
      const to = (paid_to || '').trim();
      if (!(req.body.category || '').trim()) return fail(400, 'Category is required for expenses');
      // Canonical casing from the category list — branch checks AND the stored
      // value use it, so 'sampling'/'machinery' can't sidestep category rules.
      const known = await db.get('SELECT id, name FROM petty_cash_categories WHERE lower(name)=lower($1)', [req.body.category.trim()]);
      if (!known) return fail(400, 'Pick a valid category');
      cat = known.name;
      if (cat === 'Salary') return fail(400, 'Salary entries are posted automatically from Payroll');
      if (cat === 'Purchase Payment') return fail(400, 'Purchase Payment entries are posted from Purchases → Payments Due');
      if (cat === 'Purchase Transport') return fail(400, 'Purchase Transport entries are posted automatically when a purchase is received');

      if (cat === BANK_WITHDRAWAL) {
        // Internal transfer: money leaves the Bank and lands in Cash in Hand.
        // No payee, no receipt — the linked top-up is created below.
        method = 'paid_bank';
        finalPaidTo = 'Cash in Hand';
        if (!finalDescription) finalDescription = 'Cash withdrawn from bank';
      } else if (cat === EMPLOYEE_EXPENSE) {
        const type = (req.body.emp_expense_type || '').trim();
        if (!EMP_TYPES.includes(type)) return fail(400, 'Pick an expense type (Advance Paid / Employee Welfare / Employee Care / Miscellaneous)');
        finalDescription = type; // the sub-type is stored as the description
        if (EMP_TYPES_WORKER.includes(type)) {
          const empId = parseInt(req.body.employee_id, 10);
          if (!Number.isInteger(empId)) return fail(400, 'Select the employee from the list');
          const emp = await db.get('SELECT id, name FROM employees WHERE id=$1', [empId]);
          if (!emp) return fail(400, 'Employee not found');
          finalPaidTo = emp.name; // the chosen worker is the payee
          empExpense = { type, employee_id: empId, isAdvance: type === 'Advance Paid' };
        } else {
          if (!to) return fail(400, 'Paid To is required');
          empExpense = { type, employee_id: null, isAdvance: false };
        }
      } else {
        if (!to) return fail(400, 'Paid To is required');
      }

      if (cat === MACHINERY) {
        if (!(description || '').trim()) return fail(400, 'Description is required for Machinery expenses');
        const co = await db.get('SELECT id FROM petty_cash_companies WHERE lower(name)=lower($1)', [to]);
        if (!co) return fail(400, 'Pick a company from the list (or add it)');
      }
      if (cat === PLATING) {
        // One of the coating vendors, a mandatory payment QR, and always
        // Unpaid Bank first (the owner marks it Paid to deduct the bank).
        if (!PLATING_COMPANIES.some(c => c.toLowerCase() === to.toLowerCase())) {
          return fail(400, `Pick a plating company (${PLATING_COMPANIES.join(' / ')})`);
        }
        finalPaidTo = PLATING_COMPANIES.find(c => c.toLowerCase() === to.toLowerCase());
        if (!req.file) return fail(400, 'A payment QR is required for Plating expenses');
        method = 'unpaid_bank';
      }
      if (cat === SAMPLING) {
        const itemName = (req.body.item_name || '').trim();
        const unit = (req.body.unit || '').trim();
        const qty = parseFloat(req.body.sample_qty);
        if (!itemName) return fail(400, 'Item name is required for Sampling expenses');
        if (!unit) return fail(400, 'Unit is required for Sampling expenses');
        if (!(qty > 0)) return fail(400, 'Enter a valid sample quantity');
        sample = { item_name: itemName, category: (req.body.item_category || '').trim() || null, unit, qty };
      }
      if (amt > RECEIPT_REQUIRED_ABOVE && !req.file && cat !== BANK_WITHDRAWAL) {
        return fail(400, `A receipt/bill photo is required for expenses above ₹${RECEIPT_REQUIRED_ABOVE}`);
      }
    }

    // Entry + sampling draft (+ auto payroll advance) commit atomically.
    const entryId = await db.withTransaction(async (client) => {
      // Advance Paid → create the payroll advance so it deducts from the
      // worker's next salary run; link it back onto this entry.
      let advanceId = null;
      if (empExpense?.isAdvance) {
        const adv = await client.query(
          `INSERT INTO employee_advances (employee_id, amount, advance_date, notes, created_by)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [empExpense.employee_id, amt, entry_date, 'Advance paid via Account Statement', req.user.id]);
        advanceId = adv.rows[0].id;
        await client.query('UPDATE employees SET advance_balance = advance_balance + $1 WHERE id=$2',
          [amt, empExpense.employee_id]);
      }
      const { rows } = await client.query(
        `INSERT INTO petty_cash_entries (entry_date, entry_type, category, description, paid_to, amount, payment_method, affects_cash, receipt_file, receipt_original_name, employee_id, advance_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [entry_date, entry_type, cat, finalDescription, finalPaidTo || null, amt,
         method, method !== 'unpaid_bank',
         req.file?.storagePath || null, req.file?.originalname || null,
         empExpense?.employee_id || null, advanceId, req.user.id]);
      if (sample) {
        await client.query(
          `INSERT INTO petty_cash_samples (entry_id, supplier_name, item_name, category, unit, sample_qty, sample_cost, description, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [rows[0].id, paid_to.trim(), sample.item_name, sample.category, sample.unit,
           sample.qty, amt, (description || '').trim() || null, req.user.id]);
      }
      // Bank Withdrawal: the linked cash top-up lands in the same transaction —
      // bank down + cash up always move together (FK cascade keeps the pair).
      if (cat === BANK_WITHDRAWAL) {
        await client.query(
          `INSERT INTO petty_cash_entries (entry_date, entry_type, category, description, paid_to, amount, payment_method, affects_cash, transfer_entry_id, created_by)
           VALUES ($1,'top_up',NULL,$2,NULL,$3,'cash',TRUE,$4,$5)`,
          [entry_date, 'Cash withdrawn from bank', amt, rows[0].id, req.user.id]);
      }
      return rows[0].id;
    });
    committed = true;
    const methodLabel = { cash: 'Cash', paid_bank: 'Paid Bank', unpaid_bank: 'Unpaid Bank' }[method];
    await logActivity(null, null, 'petty_cash_entry',
      entry_type === 'top_up'
        ? `Petty cash top-up: ₹${amt} (${methodLabel})`
        : `Petty cash expense: ₹${amt} — ${cat}${paid_to ? ` (${paid_to})` : ''} [${methodLabel}]`, req.user.id);

    // Notify owners of a new Unpaid-Bank expense that needs paying (Plating &
    // Employee Expense), so it surfaces in their notification box.
    if (entry_type === 'expense' && method === 'unpaid_bank' && (cat === PLATING || cat === EMPLOYEE_EXPENSE)) {
      try {
        const owners = await db.all("SELECT id FROM users WHERE role='owner' AND id != $1", [req.user.id]);
        for (const o of owners) {
          await createNotification(db, {
            userId: o.id, type: 'petty_cash_unpaid',
            title: `Unpaid ${cat}: ₹${amt}`,
            body: `${finalPaidTo || cat} — awaiting bank payment`,
            link: '/petty-cash', sourceUserId: req.user.id,
          });
        }
      } catch (e) { console.error('unpaid-expense notify failed:', e.message); }
    }
    res.status(201).json({ id: entryId });
  } catch (e) {
    console.error('petty cash entry error:', e);
    discardReceipt();
    res.status(500).json({ error: 'Failed to record entry' });
  }
});

// ── Sampling drafts ──────────────────────────────────────────────────────────
// A Sampling expense creates a pending draft supplier + item. The owner tests
// the sample, then either approves (the client walks the normal prefilled
// Supplier / Inventory forms and posts the resulting ids here) or rejects with
// a reason. Accounts can view status; only the owner reviews.
router.get('/samples', authenticate, authorize('accounts', 'owner'), async (req, res) => {
  try {
    const rows = await getDB().all(`
      SELECT s.*, u.name AS created_by_name, rv.name AS reviewed_by_name,
             e.entry_date, e.receipt_file,
             sup.name AS linked_supplier_name, inv.item_code AS linked_item_code
      FROM petty_cash_samples s
      LEFT JOIN users u  ON u.id = s.created_by
      LEFT JOIN users rv ON rv.id = s.reviewed_by
      LEFT JOIN petty_cash_entries e ON e.id = s.entry_id
      LEFT JOIN suppliers sup ON sup.id = s.supplier_id
      LEFT JOIN inventory_items inv ON inv.id = s.inventory_item_id
      ORDER BY (s.status = 'pending') DESC, s.id DESC`);
    res.json(rows);
  } catch (e) {
    console.error('samples list error:', e);
    res.status(500).json({ error: 'Failed to load samples' });
  }
});

// Fetch a pending sample by id, validating :id — shared by the review routes
const getPendingSample = async (db, rawId, res) => {
  const id = parseInt(rawId, 10);
  if (!Number.isInteger(id)) { res.status(400).json({ error: 'Invalid sample id' }); return null; }
  const s = await db.get('SELECT * FROM petty_cash_samples WHERE id=$1', [id]);
  if (!s) { res.status(404).json({ error: 'Sample not found' }); return null; }
  if (s.status !== 'pending') { res.status(400).json({ error: 'Sample is not pending' }); return null; }
  return s;
};

// Mid-approval checkpoints: the item is created first (the Supplier form needs
// an item to link), then the supplier. Storing each id as it's created lets a
// cancelled or failed flow resume without creating duplicates next time.
router.put('/samples/:id/link-item', authenticate, authorize('owner'), async (req, res) => {
  try {
    const db = getDB();
    const s = await getPendingSample(db, req.params.id, res);
    if (!s) return;
    const hasInv = req.body.inventory_item_id != null;
    const hasSup = req.body.supplier_id != null;
    if (!hasInv && !hasSup) return res.status(400).json({ error: 'Nothing to link' });
    if (hasInv) {
      const invId = parseInt(req.body.inventory_item_id, 10);
      if (!Number.isInteger(invId)) return res.status(400).json({ error: 'Invalid inventory item' });
      const inv = await db.get('SELECT id FROM inventory_items WHERE id=$1', [invId]);
      if (!inv) return res.status(404).json({ error: 'Inventory item not found' });
      await db.run('UPDATE petty_cash_samples SET inventory_item_id=$1 WHERE id=$2', [invId, s.id]);
    }
    if (hasSup) {
      const supId = parseInt(req.body.supplier_id, 10);
      if (!Number.isInteger(supId)) return res.status(400).json({ error: 'Invalid supplier' });
      const sup = await db.get('SELECT id FROM suppliers WHERE id=$1', [supId]);
      if (!sup) return res.status(404).json({ error: 'Supplier not found' });
      await db.run('UPDATE petty_cash_samples SET supplier_id=$1 WHERE id=$2', [supId, s.id]);
    }
    res.json({ message: 'Checkpoint saved' });
  } catch (e) {
    console.error('sample link error:', e);
    res.status(500).json({ error: 'Failed to update sample' });
  }
});

router.put('/samples/:id/approve', authenticate, authorize('owner'), async (req, res) => {
  try {
    const db = getDB();
    const s = await getPendingSample(db, req.params.id, res);
    if (!s) return;
    const supId = parseInt(req.body.supplier_id, 10);
    const invId = parseInt(req.body.inventory_item_id, 10);
    if (!Number.isInteger(supId)) return res.status(400).json({ error: 'Supplier is required' });
    if (!Number.isInteger(invId)) return res.status(400).json({ error: 'Inventory item is required' });
    const sup = await db.get('SELECT id, name FROM suppliers WHERE id=$1', [supId]);
    if (!sup) return res.status(404).json({ error: 'Supplier not found' });
    const inv = await db.get('SELECT id, item_code FROM inventory_items WHERE id=$1', [invId]);
    if (!inv) return res.status(404).json({ error: 'Inventory item not found' });
    await db.run(
      `UPDATE petty_cash_samples SET status='approved', supplier_id=$1, inventory_item_id=$2,
         rejection_reason=NULL, reviewed_by=$3, reviewed_at=NOW() WHERE id=$4`,
      [supId, invId, req.user.id, s.id]);
    await logActivity(null, null, 'sample_approved',
      `Sample approved: ${s.item_name} (${s.supplier_name}) → supplier "${sup.name}", item ${inv.item_code}`, req.user.id);
    res.json({ message: 'Sample approved' });
  } catch (e) {
    console.error('sample approve error:', e);
    res.status(500).json({ error: 'Failed to approve sample' });
  }
});

router.put('/samples/:id/reject', authenticate, authorize('owner'), async (req, res) => {
  try {
    const db = getDB();
    const s = await getPendingSample(db, req.params.id, res);
    if (!s) return;
    const reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A rejection reason is required' });
    await db.run(
      `UPDATE petty_cash_samples SET status='rejected', rejection_reason=$1,
         reviewed_by=$2, reviewed_at=NOW() WHERE id=$3`,
      [reason, req.user.id, s.id]);
    await logActivity(null, null, 'sample_rejected',
      `Sample rejected: ${s.item_name} (${s.supplier_name}) — ${reason}`, req.user.id);
    res.json({ message: 'Sample rejected' });
  } catch (e) {
    console.error('sample reject error:', e);
    res.status(500).json({ error: 'Failed to reject sample' });
  }
});

// Owner marks an Unpaid Bank expense as Paid — it then hits the Bank balance.
// For an auto-posted Salary entry, this ALSO marks the worker paid in Payroll
// (and flips the whole run to 'paid' once every worker is settled).
router.put('/:id/mark-paid', authenticate, authorize('owner'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid entry id' });
    const db = getDB();
    const e = await db.get('SELECT * FROM petty_cash_entries WHERE id=$1', [id]);
    if (!e) return res.status(404).json({ error: 'Entry not found' });
    if (e.entry_type !== 'expense' || e.payment_method !== 'unpaid_bank') {
      return res.status(400).json({ error: 'Only an Unpaid Bank expense can be marked paid' });
    }
    await db.withTransaction(async (client) => {
      await client.query("UPDATE petty_cash_entries SET payment_method='paid_bank', affects_cash=TRUE WHERE id=$1", [id]);
      if (e.payroll_line_id) {
        await client.query('UPDATE payroll_lines SET paid=TRUE WHERE id=$1', [e.payroll_line_id]);
        const { rows: r } = await client.query('SELECT run_id FROM payroll_lines WHERE id=$1', [e.payroll_line_id]);
        const runId = r[0]?.run_id;
        if (runId) {
          const { rows: rem } = await client.query(
            'SELECT COUNT(*)::int AS n FROM payroll_lines WHERE run_id=$1 AND paid=FALSE', [runId]);
          if (rem[0].n === 0) {
            await client.query("UPDATE payroll_runs SET status='paid', paid_at=NOW() WHERE id=$1 AND status<>'paid'", [runId]);
          }
        }
      }
    });
    await logActivity(null, null, 'petty_cash_marked_paid',
      `${e.category === 'Salary' ? 'Salary' : 'Unpaid bank expense'} marked paid: ₹${e.amount}${e.paid_to ? ` (${e.paid_to})` : ''}`, req.user.id);
    res.json({ message: 'Marked as paid' });
  } catch (e) {
    console.error('petty cash mark-paid error:', e);
    res.status(500).json({ error: 'Failed to mark as paid' });
  }
});

// Owner can remove a wrong entry (receipt file is cleaned up too). Deleting a
// Sampling entry also cascades away its sample draft/review record — the
// client warns about that in its confirm dialog.
router.delete('/:id', authenticate, authorize('owner'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid entry id' });
    const db = getDB();
    const e = await db.get('SELECT * FROM petty_cash_entries WHERE id=$1', [id]);
    if (!e) return res.status(404).json({ error: 'Entry not found' });
    // Salary entries are posted from an approved payroll run — don't orphan them
    if (e.payroll_line_id) {
      return res.status(400).json({ error: 'This is an auto-posted salary entry — it can\'t be deleted here' });
    }
    // An Advance Paid entry created a payroll advance. It's cleanly reversible
    // only while fully outstanding: if it's been settled — or partially recovered
    // in a run (balance no longer covers all unsettled advances) — block, since
    // we can't attribute the recovered portion. Adjust in Payroll instead.
    if (e.advance_id) {
      const adv = await db.get('SELECT * FROM employee_advances WHERE id=$1', [e.advance_id]);
      if (adv) {
        if (adv.settled) {
          return res.status(400).json({ error: 'This advance was already recovered in a salary run — it can\'t be deleted' });
        }
        const outstanding = await db.get(
          'SELECT COALESCE(SUM(amount),0) AS s FROM employee_advances WHERE employee_id=$1 AND settled=FALSE', [adv.employee_id]);
        const emp = await db.get('SELECT advance_balance FROM employees WHERE id=$1', [adv.employee_id]);
        if (Number(emp.advance_balance) < Number(outstanding.s)) {
          return res.status(400).json({ error: 'This advance has been partly recovered in a salary run — adjust it in Payroll instead of deleting' });
        }
      }
    }
    await db.withTransaction(async (client) => {
      if (e.advance_id) {
        const { rows: a } = await client.query('SELECT * FROM employee_advances WHERE id=$1 AND settled=FALSE', [e.advance_id]);
        if (a[0]) {
          await client.query('UPDATE employees SET advance_balance = GREATEST(advance_balance - $1, 0) WHERE id=$2',
            [Number(a[0].amount), a[0].employee_id]);
          await client.query('DELETE FROM employee_advances WHERE id=$1', [e.advance_id]);
        }
      }
      // Bank-Withdrawal pairs live and die together: deleting the linked cash
      // top-up removes the withdrawal too (FK cascade then clears this row),
      // and deleting the withdrawal cascades its top-up.
      if (e.transfer_entry_id) {
        await client.query('DELETE FROM petty_cash_entries WHERE id=$1', [e.transfer_entry_id]);
      }
      // A Plating-Transportation entry is the money side of a plating trip:
      // reverse the trip too, else its items stay stuck out-for-plating. Each
      // item reverts to the state its PREVIOUS trip left it in (sent →
      // out_for_plating, returned → returned, none → never tracked).
      const { rows: trips } = await client.query(
        'SELECT id FROM plating_trips WHERE petty_cash_entry_id=$1', [id]);
      for (const trip of trips) {
        const { rows: tItems } = await client.query(
          'SELECT order_item_id FROM plating_trip_items WHERE trip_id=$1', [trip.id]);
        for (const ti of tItems) {
          const { rows: prev } = await client.query(
            `SELECT pt.direction, pt.vendor FROM plating_trip_items pti
               JOIN plating_trips pt ON pt.id = pti.trip_id
              WHERE pti.order_item_id=$1 AND pt.id <> $2
              ORDER BY pt.id DESC LIMIT 1`, [ti.order_item_id, trip.id]);
          const status = prev.length ? statusAfterTrip(prev[0].direction, prev[0].vendor) : null;
          await client.query('UPDATE order_items SET plating_status=$1 WHERE id=$2', [status, ti.order_item_id]);
        }
        await client.query('DELETE FROM plating_trips WHERE id=$1', [trip.id]); // cascades trip items
      }
      await client.query('DELETE FROM petty_cash_entries WHERE id=$1', [id]);
    });
    await deleteFromStorage(e.receipt_file).catch(() => {});
    await logActivity(null, null, 'petty_cash_deleted',
      `Account statement entry deleted: ${e.entry_type} ₹${e.amount}${e.category ? ` (${e.category})` : ''}`, req.user.id);
    res.json({ message: 'Entry deleted' });
  } catch (e) {
    console.error('petty cash delete error:', e);
    res.status(500).json({ error: 'Failed to delete entry' });
  }
});

module.exports = router;
