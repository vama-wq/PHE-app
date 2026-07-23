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
const SAMPLING = 'Sampling';
const NO_CASH_COMPANY = 'jay bhramani'; // lower-cased for comparison

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
    opening_balance: opening, // cumulative spend, for filtered ledger views
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

    const method = String(req.body.payment_method || '').trim();
    // Top-ups can only land in cash or paid_bank; expenses may also be unpaid_bank
    const validMethods = entry_type === 'top_up' ? ['cash', 'paid_bank'] : ['cash', 'paid_bank', 'unpaid_bank'];
    if (!validMethods.includes(method)) {
      return fail(400, entry_type === 'top_up' ? 'Select Cash or Bank' : 'Select a payment method (Cash / Paid Bank / Unpaid Bank)');
    }

    // Sampling expenses carry full draft details for the future supplier + item
    let sample = null;
    let cat = null;
    if (entry_type === 'expense') {
      const to = (paid_to || '').trim();
      if (!(req.body.category || '').trim()) return fail(400, 'Category is required for expenses');
      // Canonical casing from the category list — branch checks AND the stored
      // value use it, so 'sampling'/'machinery' can't sidestep category rules.
      const known = await db.get('SELECT id, name FROM petty_cash_categories WHERE lower(name)=lower($1)', [req.body.category.trim()]);
      if (!known) return fail(400, 'Pick a valid category');
      cat = known.name;
      if (!to) return fail(400, 'Paid To is required');
      if (cat === MACHINERY) {
        if (!(description || '').trim()) return fail(400, 'Description is required for Machinery expenses');
        const co = await db.get('SELECT id FROM petty_cash_companies WHERE lower(name)=lower($1)', [to]);
        if (!co) return fail(400, 'Pick a company from the list (or add it)');
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
      if (amt > RECEIPT_REQUIRED_ABOVE && !req.file) {
        return fail(400, `A receipt/bill photo is required for expenses above ₹${RECEIPT_REQUIRED_ABOVE}`);
      }
    }

    // Entry + sampling draft commit atomically — they must never drift apart.
    const entryId = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO petty_cash_entries (entry_date, entry_type, category, description, paid_to, amount, payment_method, affects_cash, receipt_file, receipt_original_name, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [entry_date, entry_type, cat,
         (description || '').trim() || null, (paid_to || '').trim() || null, amt,
         method, method !== 'unpaid_bank',
         req.file?.storagePath || null, req.file?.originalname || null, req.user.id]);
      if (sample) {
        await client.query(
          `INSERT INTO petty_cash_samples (entry_id, supplier_name, item_name, category, unit, sample_qty, sample_cost, description, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [rows[0].id, paid_to.trim(), sample.item_name, sample.category, sample.unit,
           sample.qty, amt, (description || '').trim() || null, req.user.id]);
      }
      return rows[0].id;
    });
    committed = true;
    const methodLabel = { cash: 'Cash', paid_bank: 'Paid Bank', unpaid_bank: 'Unpaid Bank' }[method];
    await logActivity(null, null, 'petty_cash_entry',
      entry_type === 'top_up'
        ? `Petty cash top-up: ₹${amt} (${methodLabel})`
        : `Petty cash expense: ₹${amt} — ${cat}${paid_to ? ` (${paid_to})` : ''} [${methodLabel}]`, req.user.id);
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

// Owner marks an Unpaid Bank expense as Paid — it then hits the Bank balance
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
    await db.run("UPDATE petty_cash_entries SET payment_method='paid_bank', affects_cash=TRUE WHERE id=$1", [id]);
    await logActivity(null, null, 'petty_cash_marked_paid',
      `Unpaid bank expense marked paid: ₹${e.amount} — ${e.category || ''}${e.paid_to ? ` (${e.paid_to})` : ''}`, req.user.id);
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
    await db.run('DELETE FROM petty_cash_entries WHERE id=$1', [id]);
    await deleteFromStorage(e.receipt_file).catch(() => {});
    await logActivity(null, null, 'petty_cash_deleted',
      `Petty cash entry deleted: ${e.entry_type} ₹${e.amount}${e.category ? ` (${e.category})` : ''}`, req.user.id);
    res.json({ message: 'Entry deleted' });
  } catch (e) {
    console.error('petty cash delete error:', e);
    res.status(500).json({ error: 'Failed to delete entry' });
  }
});

module.exports = router;
