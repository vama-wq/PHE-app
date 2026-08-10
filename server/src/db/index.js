const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  family: 4,  // Force IPv4 — Render free tier doesn't support IPv6
});

pool.on('error', (err) => {
  console.error('Unexpected pool error', err);
});

// Thin async wrapper over pg pool
const db = {
  /** Return first matching row, or null */
  async get(sql, params = []) {
    const { rows } = await pool.query(sql, params);
    return rows[0] || null;
  },

  /** Return all matching rows */
  async all(sql, params = []) {
    const { rows } = await pool.query(sql, params);
    return rows;
  },

  /** Execute a statement (UPDATE / DELETE / INSERT without RETURNING) */
  async run(sql, params = []) {
    const result = await pool.query(sql, params);
    return result;
  },

  /** INSERT … RETURNING id — returns the new row's id */
  async insert(sql, params = []) {
    const insertSql = sql.trimEnd().replace(/;?\s*$/, '') + ' RETURNING id';
    const { rows } = await pool.query(insertSql, params);
    return { lastInsertRowid: rows[0]?.id || null };
  },

  /** Run multiple statements inside a single transaction */
  async withTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  pool,
};

function getDB() {
  return db;
}

async function initDB(retries = 20, delayMs = 10000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // ── Self-heal: clear zombie transactions before running startup DDL ──────
      // On Render's free tier the container is spun down after idle. If it's
      // killed mid-query it can leave an 'idle in transaction' session on the
      // Supabase pooler that still holds locks. On the next cold start the very
      // first migration below (ALTER TABLE … needs an exclusive lock) blocks on
      // that zombie, the boot hangs, and the app shows "Application loading"
      // forever. Terminate any stale idle-in-transaction session first so the
      // migrations can always acquire their locks.
      try {
        const z = await pool.query(`
          SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = current_database()
            AND state = 'idle in transaction'
            AND state_change < now() - interval '20 seconds'
        `);
        if (z.rowCount) console.log(`Cleared ${z.rowCount} stale idle-in-transaction session(s) before migrations`);
      } catch (e) {
        console.warn('Zombie-connection cleanup skipped:', e.message);
      }

      // Run idempotent migrations
      await pool.query(`ALTER TABLE job_card_holds ADD COLUMN IF NOT EXISTS notes TEXT`);
      // Sales prospecting: B2B lead lists researched in Claude Code, reviewed & exported in-app
      await pool.query(`
        CREATE TABLE IF NOT EXISTS prospects (
          id            SERIAL PRIMARY KEY,
          company       TEXT NOT NULL,
          city          TEXT,
          state         TEXT,
          country       TEXT DEFAULT 'India',
          segment       TEXT NOT NULL,
          email         TEXT,
          phone         TEXT,
          contact_role  TEXT,
          product_fit   TEXT,
          priority      TEXT NOT NULL DEFAULT 'M',
          status        TEXT NOT NULL DEFAULT 'new',
          source        TEXT DEFAULT 'claude-research',
          notes         TEXT,
          created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_prospects_segment ON prospects(segment)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_prospects_status  ON prospects(status)`);
      // De-dupe guard: same company+email won't be inserted twice by the seeder
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_prospect_company_email ON prospects(lower(company), lower(coalesce(email,'')))`);
      // Application category (e.g. "Boilers & steam") — for region+application filtering & tailored emails
      await pool.query(`ALTER TABLE prospects ADD COLUMN IF NOT EXISTS application TEXT`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS backup_log (
          id SERIAL PRIMARY KEY,
          backup_date   DATE NOT NULL,
          completed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          status        TEXT NOT NULL,
          db_bytes      BIGINT,
          file_count    INTEGER,
          storage_bytes BIGINT,
          failures      INTEGER,
          total_bytes   BIGINT,
          host          TEXT
        )`);
      await pool.query(`ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS qc_rejected BOOLEAN DEFAULT FALSE`);
      await pool.query(`ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS qc_rejection_notes TEXT`);
      await pool.query(`ALTER TABLE finished_goods_log ADD COLUMN IF NOT EXISTS client_code TEXT`);
      await pool.query(`ALTER TABLE finished_goods_log ADD COLUMN IF NOT EXISTS client_name TEXT`);
      await pool.query(`ALTER TABLE finished_goods_log ADD COLUMN IF NOT EXISTS outward_type TEXT`);
      await pool.query(`ALTER TABLE finished_goods_log ADD COLUMN IF NOT EXISTS reason TEXT`);
      await pool.query(`ALTER TABLE finished_goods ADD COLUMN IF NOT EXISTS base_drawing_no TEXT`);
      await pool.query(`ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS qc_dispatch_qty INTEGER DEFAULT NULL`);
      await pool.query(`ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS qc_fg_qty INTEGER DEFAULT NULL`);
      await pool.query(`ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS qc_route TEXT DEFAULT NULL`);
      // Finished goods log traceability: track which job card / order / customer each inward came from
      await pool.query(`ALTER TABLE finished_goods_log ADD COLUMN IF NOT EXISTS job_card_no TEXT`);
      await pool.query(`ALTER TABLE finished_goods_log ADD COLUMN IF NOT EXISTS order_code TEXT`);
      await pool.query(`ALTER TABLE finished_goods_log ADD COLUMN IF NOT EXISTS customer_code TEXT`);

      // Finished Goods storage locations (predefined labels). Location is a recorded
      // label only — stock is still one total qty per product (base_drawing_no).
      await pool.query(`
        CREATE TABLE IF NOT EXISTS finished_goods_locations (
          id         SERIAL PRIMARY KEY,
          name       TEXT NOT NULL,
          active     BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_fg_location_name ON finished_goods_locations(lower(name))`);
      await pool.query(`ALTER TABLE finished_goods ADD COLUMN IF NOT EXISTS location TEXT`);       // latest/primary storage location
      await pool.query(`ALTER TABLE finished_goods_log ADD COLUMN IF NOT EXISTS location TEXT`);   // location per movement

      // Finished-Goods order type: not a production order (no job card). After drawing
      // approval an "inventory QC report" is uploaded, then it goes to QC which picks the
      // FG stock + location per item; dispatch deducts the FG stock.
      await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS fg_qc_report_file TEXT`);
      await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS fg_qc_report_original_name TEXT`);
      await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS fg_source_id INTEGER`);   // chosen finished_goods.id
      await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS fg_location TEXT`);        // chosen storage location
      await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS fg_qc_qty INTEGER`);       // qty approved from stock
      await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS fg_qc_done BOOLEAN DEFAULT FALSE`);
      await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS fg_dispatched BOOLEAN DEFAULT FALSE`);
      // FG orders may record a drawing entry (inventory selection) without a file
      await pool.query(`ALTER TABLE order_drawings ALTER COLUMN file_path DROP NOT NULL`);
      await pool.query(`ALTER TABLE order_drawings ALTER COLUMN file_name DROP NOT NULL`);
      // Gujarati item name for the shopfloor — copyable in the UI, included in exports
      await pool.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS name_gu TEXT`);
      // Accounts-added items need owner approval before they become usable
      await pool.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'approved'`);
      // Finished-goods inventory job cards: short 4-stage checklist, material drawn
      // from the Finished Goods store (fg_source_id) at creation.
      await pool.query(`ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS is_fg BOOLEAN DEFAULT FALSE`);
      await pool.query(`ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS fg_source_id INTEGER`);
      // Actual dispatch moment (dispatch_date is only the planned/target date)
      await pool.query(`ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ`);
      // Replacement cards: query resolved as "replaced" spawns a fresh production
      // run tagged with the query; dispatching it needs no new invoice.
      await pool.query(`ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS replacement_query_id INTEGER`);

      // Office Expense — Petty Cash ledger: accounts records expenses, owner
      // records top-ups. Record-only (no approval); balance = top_ups − expenses.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS petty_cash_entries (
          id          SERIAL PRIMARY KEY,
          entry_date  DATE NOT NULL,
          entry_type  TEXT NOT NULL CHECK (entry_type IN ('expense','top_up')),
          category    TEXT,
          description TEXT,
          paid_to     TEXT,
          amount      NUMERIC NOT NULL CHECK (amount > 0),
          receipt_file TEXT,
          receipt_original_name TEXT,
          created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_petty_cash_date ON petty_cash_entries(entry_date)`);
      await pool.query(`ALTER TABLE petty_cash_entries ENABLE ROW LEVEL SECURITY`).catch(() => {});

      // PO chat parity with order chat: attachments + @mentions (→ dashboard notifications)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS purchase_order_message_attachments (
          id         SERIAL PRIMARY KEY,
          message_id INTEGER NOT NULL REFERENCES purchase_order_messages(id) ON DELETE CASCADE,
          file_path  TEXT NOT NULL,
          file_name  TEXT,
          file_size  BIGINT,
          mime_type  TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS purchase_order_message_mentions (
          id                SERIAL PRIMARY KEY,
          message_id        INTEGER NOT NULL REFERENCES purchase_order_messages(id) ON DELETE CASCADE,
          po_id             INTEGER NOT NULL,
          mentioned_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          is_read           INTEGER NOT NULL DEFAULT 0,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await pool.query(`ALTER TABLE purchase_order_message_attachments ENABLE ROW LEVEL SECURITY`).catch(() => {});
      await pool.query(`ALTER TABLE purchase_order_message_mentions ENABLE ROW LEVEL SECURITY`).catch(() => {});

      // Petty cash: fixed categories (owner-managed) + Machinery "paid to" companies.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS petty_cash_categories (
          id SERIAL PRIMARY KEY, name TEXT NOT NULL, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_pc_category ON petty_cash_categories(lower(name))`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS petty_cash_companies (
          id SERIAL PRIMARY KEY, name TEXT NOT NULL, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_pc_company ON petty_cash_companies(lower(name))`);
      // Jay Bhramani (Machinery) entries are recorded but don't reduce cash-in-hand.
      await pool.query(`ALTER TABLE petty_cash_entries ADD COLUMN IF NOT EXISTS affects_cash BOOLEAN NOT NULL DEFAULT TRUE`);
      for (const c of ['Office Expense', 'Plating Transportation', 'Machinery', 'Sampling', 'Employee Expense', 'Salary', 'Purchase Payment', 'Plating', 'Purchase Transport', 'Bank Withdrawal']) {
        await pool.query(`INSERT INTO petty_cash_categories (name) VALUES ($1) ON CONFLICT DO NOTHING`, [c]);
      }
      await pool.query(`INSERT INTO petty_cash_companies (name) VALUES ($1) ON CONFLICT DO NOTHING`, ['Jay Bhramani']);
      await pool.query(`ALTER TABLE petty_cash_categories ENABLE ROW LEVEL SECURITY`).catch(() => {});
      await pool.query(`ALTER TABLE petty_cash_companies ENABLE ROW LEVEL SECURITY`).catch(() => {});
      // Payment method drives which account an entry hits: cash → Cash balance,
      // paid_bank → Bank balance, unpaid_bank → neither (pending; owner marks paid).
      // Replaces the old affects_cash / Jay-Bhramani rule.
      await pool.query(`ALTER TABLE petty_cash_entries ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'cash'`);
      // Migrate legacy rows: non-cash-affecting (Jay Bhramani) → unpaid_bank, rest → cash
      await pool.query(`UPDATE petty_cash_entries SET payment_method = CASE WHEN affects_cash THEN 'cash' ELSE 'unpaid_bank' END
                        WHERE payment_method IS NULL OR payment_method = 'cash' AND affects_cash = FALSE`);
      // Sampling drafts: a Sampling petty-cash expense captures draft supplier +
      // item details. Owner approves (→ real supplier + inventory records via the
      // normal prefilled forms, ids stored here) or rejects with a reason.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS petty_cash_samples (
          id SERIAL PRIMARY KEY,
          entry_id INTEGER REFERENCES petty_cash_entries(id) ON DELETE CASCADE,
          supplier_name TEXT NOT NULL,
          item_name TEXT NOT NULL,
          category TEXT,
          unit TEXT,
          sample_qty NUMERIC,
          sample_cost NUMERIC NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
          rejection_reason TEXT,
          supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
          inventory_item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
          reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          reviewed_at TIMESTAMPTZ,
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )`);
      await pool.query(`ALTER TABLE petty_cash_samples ENABLE ROW LEVEL SECURITY`).catch(() => {});
      // Repair databases where the table was created by the first cut of this
      // migration: user FKs must not block user deletion, and timestamps follow
      // the schema-wide TIMESTAMPTZ convention. Conditional → no-op thereafter.
      await pool.query(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='petty_cash_samples_created_by_fkey' AND confdeltype <> 'n') THEN
          ALTER TABLE petty_cash_samples DROP CONSTRAINT petty_cash_samples_created_by_fkey;
          ALTER TABLE petty_cash_samples ADD CONSTRAINT petty_cash_samples_created_by_fkey
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='petty_cash_samples_reviewed_by_fkey' AND confdeltype <> 'n') THEN
          ALTER TABLE petty_cash_samples DROP CONSTRAINT petty_cash_samples_reviewed_by_fkey;
          ALTER TABLE petty_cash_samples ADD CONSTRAINT petty_cash_samples_reviewed_by_fkey
            FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='petty_cash_samples'
                   AND column_name='created_at' AND data_type='timestamp without time zone') THEN
          ALTER TABLE petty_cash_samples ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';
          ALTER TABLE petty_cash_samples ALTER COLUMN reviewed_at TYPE TIMESTAMPTZ USING reviewed_at AT TIME ZONE 'UTC';
        END IF;
      END $$`);
      // ── Payroll: employees, monthly runs, advances, leave ledger ────────────
      // Worker groups: labour (per-day, no paid leave), fixed_admin (8h std day),
      // fixed_production (10h std day). Fixed groups: salary ÷ 30 per day, +1
      // paid leave/month (carryforward, max 5 into a new year, >7 together
      // flagged); admin earns +1 sick credit for weeks with 4+ days out ≥18:30.
      // OT for everyone = hours beyond std day at (day pay ÷ 8)/hour.
      // Accounts prepares attendance; ONLY the owner sees amounts/bank details,
      // approves the run and marks salaries paid (7th of each month).
      await pool.query(`
        CREATE TABLE IF NOT EXISTS employees (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          worker_group TEXT NOT NULL CHECK (worker_group IN ('labour','fixed_admin','fixed_production')),
          daily_rate NUMERIC,
          monthly_salary NUMERIC,
          petrol_monthly NUMERIC NOT NULL DEFAULT 0,
          advance_balance NUMERIC NOT NULL DEFAULT 0,
          bank_ac_no TEXT, ifsc_code TEXT, ac_holder_name TEXT,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          joined_on DATE, notes TEXT,
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS employee_advances (
          id SERIAL PRIMARY KEY,
          employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          amount NUMERIC NOT NULL,
          advance_date DATE NOT NULL,
          notes TEXT,
          settled BOOLEAN NOT NULL DEFAULT FALSE,
          payroll_run_id INTEGER,
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS payroll_runs (
          id SERIAL PRIMARY KEY,
          month TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','paid')),
          working_days INTEGER NOT NULL DEFAULT 30,
          essl_file TEXT, essl_original_name TEXT,
          prepared_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          submitted_at TIMESTAMPTZ,
          approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          approved_at TIMESTAMPTZ, paid_at TIMESTAMPTZ,
          notes TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS payroll_lines (
          id SERIAL PRIMARY KEY,
          run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
          employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          worker_group TEXT NOT NULL,
          present_days NUMERIC NOT NULL DEFAULT 0,
          absent_days NUMERIC NOT NULL DEFAULT 0,
          ot_hours NUMERIC NOT NULL DEFAULT 0,
          late_stay_days INTEGER NOT NULL DEFAULT 0,
          leave_credit_used NUMERIC NOT NULL DEFAULT 0,
          sick_credit_earned NUMERIC NOT NULL DEFAULT 0,
          long_leave_flag BOOLEAN NOT NULL DEFAULT FALSE,
          daily_rate NUMERIC, monthly_salary NUMERIC,
          petrol NUMERIC NOT NULL DEFAULT 0,
          advance_deduction NUMERIC NOT NULL DEFAULT 0,
          base_pay NUMERIC NOT NULL DEFAULT 0,
          ot_amount NUMERIC NOT NULL DEFAULT 0,
          absent_deduction NUMERIC NOT NULL DEFAULT 0,
          total_payable NUMERIC NOT NULL DEFAULT 0,
          paid BOOLEAN NOT NULL DEFAULT FALSE,
          remarks TEXT,
          UNIQUE (run_id, employee_id)
        )`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS employee_leave_ledger (
          id SERIAL PRIMARY KEY,
          employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
          delta NUMERIC NOT NULL,
          reason TEXT NOT NULL CHECK (reason IN ('monthly_accrual','sick_630','used','year_trim','manual')),
          payroll_run_id INTEGER REFERENCES payroll_runs(id) ON DELETE SET NULL,
          notes TEXT,
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )`);
      for (const t of ['employees', 'employee_advances', 'payroll_runs', 'payroll_lines', 'employee_leave_ledger']) {
        await pool.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`).catch(() => {});
      }
      // 4th worker group: fixed_production_nl — 10h production on fixed salary but
      // NO paid leave (every absence deducts). Widen the CHECK on existing DBs.
      await pool.query(`ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_worker_group_check`);
      await pool.query(`ALTER TABLE employees ADD CONSTRAINT employees_worker_group_check
        CHECK (worker_group IN ('labour','fixed_admin','fixed_production','fixed_production_nl'))`);

      // Account Statement ↔ Payroll links on petty_cash_entries (added after the
      // payroll tables exist): a 'Salary' entry links to the payroll line it was
      // posted from (mark-paid syncs both ways); an 'Employee Expense / Advance
      // Paid' entry links to the employee + the advance it created (deducted in
      // the worker's next run; reversed if the entry is deleted while unsettled).
      await pool.query(`ALTER TABLE petty_cash_entries ADD COLUMN IF NOT EXISTS employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL`);
      await pool.query(`ALTER TABLE petty_cash_entries ADD COLUMN IF NOT EXISTS payroll_line_id INTEGER REFERENCES payroll_lines(id) ON DELETE SET NULL`);
      await pool.query(`ALTER TABLE petty_cash_entries ADD COLUMN IF NOT EXISTS advance_id INTEGER REFERENCES employee_advances(id) ON DELETE SET NULL`);
      // Links a 'Purchase Payment' unpaid-bank entry back to the PO it settles,
      // so a PO's paid/remaining balance = its received value − Σ linked entries.
      await pool.query(`ALTER TABLE petty_cash_entries ADD COLUMN IF NOT EXISTS po_id INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL`);
      // Bank Withdrawal: a paid_bank expense (bank down) whose linked cash
      // top-up (cash up) carries transfer_entry_id → the expense; deleting the
      // expense cascades the top-up so the pair can never diverge.
      await pool.query(`ALTER TABLE petty_cash_entries ADD COLUMN IF NOT EXISTS transfer_entry_id INTEGER REFERENCES petty_cash_entries(id) ON DELETE CASCADE`);
      // Consolidate a pre-existing owner-added 'Employee Expenses' (plural) into
      // the canonical 'Employee Expense' the Employee-Expense form keys on.
      await pool.query(`UPDATE petty_cash_entries SET category='Employee Expense' WHERE category='Employee Expenses'`);
      await pool.query(`DELETE FROM petty_cash_categories WHERE name='Employee Expenses'`);

      // Paid festival holidays (owner-managed, one list per year). A holiday in a
      // run's month is paid for every worker: labour gets +1 day's rate; fixed
      // workers aren't deducted for it. payroll_lines.holiday_pay stores the
      // labour holiday amount.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS holidays (
          id SERIAL PRIMARY KEY,
          holiday_date DATE NOT NULL UNIQUE,
          name TEXT NOT NULL,
          paid BOOLEAN NOT NULL DEFAULT TRUE,
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await pool.query(`ALTER TABLE holidays ENABLE ROW LEVEL SECURITY`).catch(() => {});
      await pool.query(`ALTER TABLE payroll_lines ADD COLUMN IF NOT EXISTS holiday_pay NUMERIC NOT NULL DEFAULT 0`);
      // Late-arrival penalty (graduated): late_days = count of late arrivals,
      // late_cut_minutes = total graduated cut minutes from the ESSL punch-ins,
      // late_deduction = the money (cut_minutes/60 × hourly rate).
      await pool.query(`ALTER TABLE payroll_lines ADD COLUMN IF NOT EXISTS late_days NUMERIC NOT NULL DEFAULT 0`);
      await pool.query(`ALTER TABLE payroll_lines ADD COLUMN IF NOT EXISTS late_cut_minutes NUMERIC NOT NULL DEFAULT 0`);
      await pool.query(`ALTER TABLE payroll_lines ADD COLUMN IF NOT EXISTS late_deduction NUMERIC NOT NULL DEFAULT 0`);
      // employee_advances predates payroll_runs, so its settlement backlink FK
      // couldn't be inline — add it idempotently (ON DELETE SET NULL).
      await pool.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='employee_advances_payroll_run_id_fkey') THEN
          ALTER TABLE employee_advances ADD CONSTRAINT employee_advances_payroll_run_id_fkey
            FOREIGN KEY (payroll_run_id) REFERENCES payroll_runs(id) ON DELETE SET NULL;
        END IF;
      END $$`).catch(() => {});
      // One-time-only grant of the payroll module to existing accounts users.
      // Gated behind a marker row so it never re-grants after an owner removes
      // it (permitted_modules is a JSON array in a text column).
      await pool.query(`CREATE TABLE IF NOT EXISTS app_flags (key TEXT PRIMARY KEY, set_at TIMESTAMPTZ DEFAULT NOW())`);
      const grant = await pool.query(
        `INSERT INTO app_flags (key) VALUES ('payroll_module_granted') ON CONFLICT DO NOTHING RETURNING key`);
      if (grant.rowCount === 1) {
        const { rows: accUsers } = await pool.query(
          `SELECT id, permitted_modules FROM users WHERE role='accounts' AND permitted_modules IS NOT NULL`);
        for (const u of accUsers) {
          try {
            const mods = typeof u.permitted_modules === 'string' ? JSON.parse(u.permitted_modules) : u.permitted_modules;
            if (Array.isArray(mods) && !mods.includes('payroll')) {
              mods.push('payroll');
              await pool.query('UPDATE users SET permitted_modules=$1 WHERE id=$2', [JSON.stringify(mods), u.id]);
            }
          } catch { /* leave malformed lists untouched */ }
        }
      }

      // Owner can bypass drawing approval per order (button on the order page,
      // reversible). Replaces the old hardcoded client-side list — those orders
      // are migrated here once.
      await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS drawing_bypassed BOOLEAN NOT NULL DEFAULT FALSE`);
      await pool.query(
        `UPDATE orders SET drawing_bypassed=TRUE WHERE drawing_bypassed=FALSE AND order_code = ANY($1)`,
        [['ORD-017-26', 'ORD-020-26', 'ORD-024-26', 'ORD-053-26', 'ORD-064-26', 'ORD-067-26', 'ORD-069-26', 'ORD-075-26']]);
      // Finished goods carry the product family (picked first on manual entry;
      // copied from the order item on production/return inwards). Backfill from
      // each row's job card → order item.
      await pool.query(`ALTER TABLE finished_goods ADD COLUMN IF NOT EXISTS product_code TEXT`);
      await pool.query(`
        UPDATE finished_goods fg SET product_code = oi.product_code
        FROM job_cards jc JOIN order_items oi ON oi.id = jc.order_item_id
        WHERE jc.id = fg.job_card_id AND fg.product_code IS NULL AND oi.product_code IS NOT NULL`);
      // Per-BOM-line deduction tracking: stage-timed categories (15 brazing/flange,
      // 21 nipple) deduct early; QC deducts the remainder. qty_deducted accumulates.
      await pool.query(`ALTER TABLE order_item_inventory ADD COLUMN IF NOT EXISTS qty_deducted NUMERIC DEFAULT 0`);
      await pool.query(`
        UPDATE order_item_inventory oii SET qty_deducted = oii.qty
        FROM order_items oi
        WHERE oi.id = oii.order_item_id AND oi.inventory_deducted = TRUE AND COALESCE(oii.qty_deducted,0) = 0`);
      // The order_type CHECK predates finished_goods — recreate it. (The status
      // CHECK is recreated in the customer-query migration further below.)
      await pool.query(`ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_type_check`);
      await pool.query(`ALTER TABLE orders ADD CONSTRAINT orders_order_type_check CHECK (order_type = ANY (ARRAY[
        'local_he','export_he','inventory_order','io_export_he','io_local_he','finished_goods']))`);

      // ── Consolidate finished_goods: one row per base_drawing_no ──────────────
      // 1. Fill base_drawing_no by stripping trailing job-card suffix (-1, -2, etc.)
      await pool.query(`
        UPDATE finished_goods
        SET base_drawing_no = regexp_replace(drawing_no, '-[0-9]+$', '')
        WHERE drawing_no IS NOT NULL
      `);
      // 2. Re-point log entries from duplicate rows to the canonical (lowest id) row
      await pool.query(`
        UPDATE finished_goods_log fgl
        SET finished_good_id = canonical.id
        FROM (
          SELECT base_drawing_no, MIN(id) AS id
          FROM finished_goods
          WHERE base_drawing_no IS NOT NULL
          GROUP BY base_drawing_no
        ) canonical
        JOIN finished_goods fg
          ON fg.base_drawing_no = canonical.base_drawing_no AND fg.id != canonical.id
        WHERE fgl.finished_good_id = fg.id
      `);
      // 3. Aggregate qty_in + qty_available into the canonical row
      await pool.query(`
        UPDATE finished_goods fg
        SET qty_in        = totals.sum_in,
            qty_available = totals.sum_avail
        FROM (
          SELECT base_drawing_no,
                 SUM(qty_in)        AS sum_in,
                 SUM(qty_available) AS sum_avail
          FROM finished_goods
          WHERE base_drawing_no IS NOT NULL
          GROUP BY base_drawing_no
          HAVING COUNT(*) > 1
        ) totals
        WHERE fg.base_drawing_no = totals.base_drawing_no
          AND fg.id = (
            SELECT MIN(id) FROM finished_goods
            WHERE base_drawing_no = fg.base_drawing_no
          )
      `);
      // 4. Delete non-canonical duplicate rows (log entries already moved)
      await pool.query(`
        DELETE FROM finished_goods
        WHERE base_drawing_no IS NOT NULL
          AND id NOT IN (
            SELECT MIN(id) FROM finished_goods
            WHERE base_drawing_no IS NOT NULL
            GROUP BY base_drawing_no
          )
      `);
      // 5. Backfill job_card_no from reference field for old log entries created before
      //    the job_card_no column existed (reference was set to the job card number).
      //    Only update where reference actually matches a real job card.
      await pool.query(`
        UPDATE finished_goods_log fgl
        SET job_card_no = fgl.reference
        FROM job_cards jc
        WHERE fgl.movement_type = 'inward'
          AND fgl.job_card_no IS NULL
          AND fgl.reference IS NOT NULL
          AND jc.job_card_no = fgl.reference
      `);
      // Per-item drawings: link each order_drawing to a specific order item
      await pool.query(`ALTER TABLE order_drawings ADD COLUMN IF NOT EXISTS item_id INTEGER REFERENCES order_items(id) ON DELETE SET NULL`);
      // Drawing approval workflow: track review status per order (legacy — kept for fallback)
      await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS drawing_status TEXT DEFAULT NULL`);
      await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS drawing_rejection_reason TEXT DEFAULT NULL`);
      // Per-drawing approval: approve/reject each drawing individually
      await pool.query(`ALTER TABLE order_drawings ADD COLUMN IF NOT EXISTS drawing_status TEXT DEFAULT NULL`);
      await pool.query(`ALTER TABLE order_drawings ADD COLUMN IF NOT EXISTS rejection_reason TEXT DEFAULT NULL`);
      // Inventory is now selected by design at drawing-upload time and deducted when the
      // drawing is approved (not at order approval). Track per-item deduction so we never
      // double-deduct, and can restore stock if an approved drawing is reopened.
      // One-time backfill (only when the column is first created): orders that were already
      // approved under the OLD flow already had their inventory deducted at order approval —
      // mark their items as deducted so approving their pending drawings doesn't deduct again.
      {
        const colExists = await pool.query(
          `SELECT 1 FROM information_schema.columns WHERE table_name='order_items' AND column_name='inventory_deducted'`
        );
        await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS inventory_deducted BOOLEAN DEFAULT FALSE`);
        if (colExists.rowCount === 0) {
          await pool.query(`
            UPDATE order_items oi SET inventory_deducted = TRUE
            FROM orders o
            WHERE o.id = oi.order_id AND o.status NOT IN ('pending_approval','rejected')
          `);
          console.log('Backfilled inventory_deducted=TRUE for already-approved orders');
        }
      }
      // Widen stage_no check constraint. 1–29 are the linear stages; 30+ are
      // out-of-sequence optional stages (e.g. 30 = Kharoch Process after Bending).
      await pool.query(`ALTER TABLE production_checklist DROP CONSTRAINT IF EXISTS production_checklist_stage_no_check`);
      await pool.query(`ALTER TABLE production_checklist ADD CONSTRAINT production_checklist_stage_no_check CHECK (stage_no BETWEEN 1 AND 40)`);
      // Add notes column for rework/notes per stage
      await pool.query(`ALTER TABLE production_checklist ADD COLUMN IF NOT EXISTS notes TEXT`);
      // Stage 3 (Ohms) captures the total weight of all coils produced for the job card
      await pool.query(`ALTER TABLE production_checklist ADD COLUMN IF NOT EXISTS coil_weight NUMERIC`);
      // Add unique constraint on supplier_code to prevent duplicates
      try {
        await pool.query(`ALTER TABLE suppliers ADD CONSTRAINT suppliers_supplier_code_unique UNIQUE (supplier_code)`);
      } catch (e) {
        // Constraint may already exist, ignore
        if (!e.message.includes('already exists')) console.log('Note: supplier_code unique constraint may already exist');
      }
      // Fix incorrectly auto-approved job cards: reset to qc_pending if they have no QC reports
      // A card should only be qc_approved if it actually has a QC report from the QC team
      await pool.query(`
        UPDATE job_cards SET status = 'qc_pending'
        WHERE status = 'qc_approved'
          AND id NOT IN (
            SELECT DISTINCT job_card_id FROM qc_reports
          )
          AND id IN (
            SELECT jc.id FROM job_cards jc
            JOIN production_checklist pc ON pc.job_card_id = jc.id AND pc.stage_no = 29 AND pc.done = 1
          )
      `);
      // Fix desync: if a pending hold exists but job card status is not 'on_hold', fix it
      await pool.query(`
        UPDATE job_cards SET status = 'on_hold'
        WHERE status != 'on_hold'
          AND id IN (
            SELECT DISTINCT job_card_id FROM job_card_holds WHERE status = 'pending'
          )
      `);

      await pool.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS min_order_qty NUMERIC DEFAULT 0`);

      // Partial dispatch: production can request to split N units off a job card for
      // early dispatch; owner approves → a child job card (skips production, starts at
      // QC) is created and the parent qty reduces.
      await pool.query(`ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS parent_job_card_id INTEGER`);

      // Link a job card to the specific order item it produces, so inventory can be
      // deducted at that item's QC / dispatch (not at drawing approval). Backfill
      // legacy cards by matching drawing number within the order.
      await pool.query(`ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS order_item_id INTEGER`);
      await pool.query(`
        UPDATE job_cards jc
        SET order_item_id = oi.id
        FROM order_items oi
        WHERE jc.order_item_id IS NULL
          AND oi.order_id = jc.order_id
          AND oi.drawing_number IS NOT NULL
          AND jc.drawing_no = oi.drawing_number
      `);

      // Checklist-driven tube & spring-gauge consumption (new orders only). The flag
      // gates the whole feature so existing orders are untouched (default FALSE).
      await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS material_deduction BOOLEAN DEFAULT FALSE`);
      await pool.query(`ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS tube_deducted BOOLEAN DEFAULT FALSE`);
      await pool.query(`ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS coil_deducted BOOLEAN DEFAULT FALSE`);
      await pool.query(`ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS tube_used_qty NUMERIC`);
      await pool.query(`ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS tube_scrap_qty NUMERIC`);
      await pool.query(`ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS coil_used_qty NUMERIC`);
      await pool.query(`ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS coil_scrap_qty NUMERIC`);
      // Allow 'scrap' transactions (tube/coil scrap consumption) alongside the existing types.
      await pool.query(`ALTER TABLE inventory_transactions DROP CONSTRAINT IF EXISTS inventory_transactions_transaction_type_check`);
      await pool.query(`ALTER TABLE inventory_transactions ADD CONSTRAINT inventory_transactions_transaction_type_check
        CHECK (transaction_type IN ('opening_stock','purchase_in','dispatch_to_production','return_from_production','adjustment','scrap'))`);
      // Stage 6 (Filling): PVC bush + MGO powder consumption, tracked for reversal.
      await pool.query(`ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS fill_deducted BOOLEAN DEFAULT FALSE`);
      await pool.query(`ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS fill_pvc_qty NUMERIC`);
      await pool.query(`ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS fill_mgo_qty NUMERIC`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS job_card_split_requests (
          id SERIAL PRIMARY KEY,
          job_card_id INTEGER NOT NULL REFERENCES job_cards(id),
          qty INTEGER NOT NULL,
          reason TEXT,
          status TEXT DEFAULT 'pending',
          child_job_card_id INTEGER REFERENCES job_cards(id),
          rejection_reason TEXT,
          created_by INTEGER REFERENCES users(id),
          approved_by INTEGER REFERENCES users(id),
          approved_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )`);

      // A PO priced above the agreed/last rate needs owner approval before it can be sent.
      await pool.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS rate_increase_pending BOOLEAN DEFAULT FALSE`);
      await pool.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS rate_increase_approved_by INTEGER`);
      await pool.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS rate_increase_approved_at TIMESTAMPTZ`);

      // Post-approval PO flow: invoice captured at "Received", then per-item QC
      // (material image + weight of 10 pcs) before stock is added.
      await pool.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS invoice_file TEXT`);
      await pool.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS invoice_original_name TEXT`);
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS qc_status TEXT`);
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS qc_weight_10 NUMERIC`);
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS qc_image_file TEXT`);
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS qc_image_name TEXT`);
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS qc_observations TEXT`);
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS qc_rejection_reason TEXT`);
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS qc_by INTEGER`);
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS qc_at TIMESTAMPTZ`);
      // QC records the actual quantity received; only that qty is added to stock.
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS qc_received_qty NUMERIC`);
      // Purchase QC can approve part of an item's qty and reject the rest:
      // qc_status gains 'partial', the rejected qty is tracked, every rejection
      // (full or partial) carries photos, and each rejection spawns a pending
      // debit note for accounts to raise against the supplier.
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS qc_rejected_qty NUMERIC`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS purchase_item_rejection_photos (
          id SERIAL PRIMARY KEY,
          item_id INTEGER NOT NULL REFERENCES purchase_order_items(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL,
          original_name TEXT,
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS purchase_debit_notes (
          id SERIAL PRIMARY KEY,
          po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
          po_item_id INTEGER REFERENCES purchase_order_items(id) ON DELETE SET NULL,
          rejected_qty NUMERIC NOT NULL,
          suggested_amount NUMERIC,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','raised')),
          note_no TEXT,
          amount NUMERIC,
          notes TEXT,
          file_path TEXT,
          original_name TEXT,
          raised_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          raised_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_pdn_po ON purchase_debit_notes(po_id)`);
      // Receiving is per item, each with its own invoice; then per-item QC.
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS received BOOLEAN DEFAULT FALSE`);
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ`);
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS invoice_file TEXT`);
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS invoice_original_name TEXT`);
      // Costs known only at receipt: transport + any other cost (with a reason).
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS receive_transport_cost NUMERIC`);
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS receive_other_cost NUMERIC`);
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS receive_other_cost_reason TEXT`);
      // Split transport at receive: main vehicle freight (→ Unpaid Bank, owner pays)
      // and local dock→unit transport (→ Cash), each with its own transporter name.
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS receive_transport_paid_to TEXT`);
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS receive_local_transport_cost NUMERIC`);
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS receive_local_transport_paid_to TEXT`);

      // ── Plating transport tracking ──────────────────────────────────────────
      // Order items with Nickel Plating / Electropolish are sent out to a plating
      // vendor and come back. Each "trip" is one transport bill (Cash) shared by
      // the items in it; per-item share = cost / item-count. order_items.plating_status
      // tracks each item's current leg (out_for_plating / returned).
      await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS plating_status TEXT`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS plating_trips (
          id SERIAL PRIMARY KEY,
          direction TEXT NOT NULL CHECK (direction IN ('sent','returned')),
          vendor TEXT,
          paid_to TEXT,
          transport_cost NUMERIC NOT NULL CHECK (transport_cost >= 0),
          trip_date DATE NOT NULL,
          notes TEXT,
          petty_cash_entry_id INTEGER REFERENCES petty_cash_entries(id) ON DELETE SET NULL,
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS plating_trip_items (
          id SERIAL PRIMARY KEY,
          trip_id INTEGER NOT NULL REFERENCES plating_trips(id) ON DELETE CASCADE,
          order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE
        )`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_plating_trip_items_trip ON plating_trip_items(trip_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_plating_trip_items_item ON plating_trip_items(order_item_id)`);
      // One-off: ORD-065-26's flange item was physically at the plating vendor
      // before this tracking existed — mark it out_for_plating so its return can
      // be recorded. NULL guard = runs once; after the return it stays 'returned'.
      await pool.query(`
        UPDATE order_items oi SET plating_status='out_for_plating'
        FROM orders o WHERE o.id = oi.order_id AND o.order_code='ORD-065-26'
          AND oi.plating_instructions ILIKE '%nickle%' AND oi.plating_status IS NULL`);
      // One-off: P PHE 05's single ₹480 freight bill also posted three duplicate
      // Unpaid-Bank ledger entries (one per received item). Keep the earliest
      // (relabelled), delete the rest — only while still unpaid, so a paid row
      // is never touched. Idempotent: one row left → nothing more to delete.
      await pool.query(`
        DELETE FROM petty_cash_entries
         WHERE category='Purchase Transport' AND payment_method='unpaid_bank'
           AND amount=480 AND description LIKE 'Main vehicle transport%P PHE 05%'
           AND id NOT IN (
             SELECT MIN(id) FROM petty_cash_entries
              WHERE category='Purchase Transport' AND payment_method='unpaid_bank'
                AND amount=480 AND description LIKE 'Main vehicle transport%P PHE 05%')`);
      await pool.query(`
        UPDATE petty_cash_entries
           SET description='Main vehicle transport — P PHE 05 (3 items)'
         WHERE category='Purchase Transport' AND amount=480
           AND description LIKE 'Main vehicle transport%P PHE 05%(MS Flange Cap%'`);
      // One-off: the July run was APPROVED before Gayaji's 1 leave credit was
      // applied, freezing her at ₹22,452 (7 charged absences). Owner-confirmed
      // figures: credit 1 → 6 charged → ded ₹5,613 → total ₹23,387. Fix the
      // frozen line, the posted (still-unpaid) Salary entry, and post the
      // 'used' ledger row approval would have written. Guarded on the old
      // values + her entry being unpaid → runs once, never touches paid money.
      {
        const gl = await pool.query(`
          SELECT pl.id FROM payroll_lines pl
            JOIN payroll_runs r ON r.id = pl.run_id
            JOIN employees e ON e.id = pl.employee_id
           WHERE r.month='2026-07' AND e.name='Gayaji'
             AND COALESCE(pl.leave_credit_used,0)=0 AND ROUND(pl.total_payable)=22452 LIMIT 1`);
        if (gl.rows.length) {
          const lineId = gl.rows[0].id;
          const sal = await pool.query(
            `SELECT id FROM petty_cash_entries
              WHERE payroll_line_id=$1 AND payment_method='unpaid_bank' AND amount=22452 LIMIT 1`, [lineId]);
          if (sal.rows.length) {
            await pool.query(`
              UPDATE payroll_lines SET leave_credit_used=1, absent_deduction=5613,
                base_pay=23387, total_payable=23387 WHERE id=$1`, [lineId]);
            await pool.query('UPDATE petty_cash_entries SET amount=23387 WHERE id=$1', [sal.rows[0].id]);
            await pool.query(`
              INSERT INTO employee_leave_ledger (employee_id, delta, reason, payroll_run_id, notes)
              SELECT pl.employee_id, -1, 'used', pl.run_id, 'Used in 2026-07 (applied post-approval)'
                FROM payroll_lines pl WHERE pl.id=$1`, [lineId]);
          }
        }
      }
      // One-off: restore the accidentally-deleted 05-Aug Sampling entry (id 66,
      // SS Plate ₹3,540 paid_bank, SHIVAKSH LASER TECH INDUSTRIES) and its
      // cascade-deleted pending sample (id 2). Receipt already re-uploaded to
      // storage. Original ids/timestamps preserved; NOT-EXISTS guards → runs once.
      await pool.query(`
        INSERT INTO petty_cash_entries (id, entry_date, entry_type, category, description, paid_to, amount,
          receipt_file, receipt_original_name, created_by, created_at, affects_cash, payment_method)
        SELECT 66, '2026-08-05', 'expense', 'Sampling', NULL, 'SHIVAKSH LASER TECH INDUSTRIES', 3540,
          'petty-cash/1785924014652_SS_PLATE_.jpeg', 'SS PLATE .jpeg', 3, '2026-08-05 10:00:15.874453+00', TRUE, 'paid_bank'
        WHERE NOT EXISTS (SELECT 1 FROM petty_cash_entries WHERE id = 66)`);
      await pool.query(`
        INSERT INTO petty_cash_samples (id, entry_id, supplier_name, item_name, category, unit, sample_qty,
          sample_cost, status, created_by, created_at)
        SELECT 2, 66, 'SHIVAKSH LASER TECH INDUSTRIES', 'SS Plate', 'ss Plate', 'Pcs', 6,
          3540, 'pending', 3, '2026-08-05 10:00:15.874453+00'
        WHERE EXISTS (SELECT 1 FROM petty_cash_entries WHERE id = 66)
          AND NOT EXISTS (SELECT 1 FROM petty_cash_samples WHERE id = 2)`);
      // One-off: reverse the 10-Aug ₹3,100 Plating Transportation entry (porter,
      // 1 item sent). Removes the trip + its ledger entry and reverts the item's
      // plating_status to whatever its previous trip left it in — the same
      // unwind the delete endpoint now performs. Guarded → runs once.
      {
        const ent = await pool.query(
          `SELECT id FROM petty_cash_entries
            WHERE entry_date='2026-08-10' AND category='Plating Transportation'
              AND amount=3100 AND TRIM(paid_to)='porter' LIMIT 1`);
        if (ent.rows.length) {
          const entryId = ent.rows[0].id;
          const trips = await pool.query('SELECT id FROM plating_trips WHERE petty_cash_entry_id=$1', [entryId]);
          for (const trip of trips.rows) {
            const tItems = await pool.query('SELECT order_item_id FROM plating_trip_items WHERE trip_id=$1', [trip.id]);
            for (const ti of tItems.rows) {
              const prev = await pool.query(
                `SELECT pt.direction FROM plating_trip_items pti
                   JOIN plating_trips pt ON pt.id = pti.trip_id
                  WHERE pti.order_item_id=$1 AND pt.id <> $2
                  ORDER BY pt.id DESC LIMIT 1`, [ti.order_item_id, trip.id]);
              const status = prev.rows.length ? (prev.rows[0].direction === 'sent' ? 'out_for_plating' : 'returned') : null;
              await pool.query('UPDATE order_items SET plating_status=$1 WHERE id=$2', [status, ti.order_item_id]);
            }
            await pool.query('DELETE FROM plating_trips WHERE id=$1', [trip.id]);
          }
          await pool.query('DELETE FROM petty_cash_entries WHERE id=$1', [entryId]);
        }
      }
      // One-off: the 07-Aug ₹3,000 Machinery entry was booked to payee "lathe
      // repair"; owner renamed the payee to "Gayatri Guddu Bhai". Add the
      // company (Machinery payees come from petty_cash_companies) and repoint
      // the entry. Idempotent: the old paid_to guard stops re-runs.
      await pool.query(
        `INSERT INTO petty_cash_companies (name) VALUES ('Gayatri Guddu Bhai') ON CONFLICT DO NOTHING`);
      await pool.query(`
        UPDATE petty_cash_entries SET paid_to='Gayatri Guddu Bhai'
         WHERE category='Machinery' AND entry_date='2026-08-07'
           AND amount=3000 AND TRIM(paid_to)='lathe repair'`);
      // One-off: two 05-Aug Office Expenses were entered as Unpaid Bank but a
      // category-browsing quirk stomped the method to Cash (Canteen TDS ₹7,917
      // + umiya zerox ₹10,966 → cash went ₹−18,183). Convert them to
      // unpaid_bank so the owner pays them from the bank as intended.
      // Idempotent: the method='cash' guard stops re-runs.
      await pool.query(`
        UPDATE petty_cash_entries SET payment_method='unpaid_bank', affects_cash=FALSE
         WHERE entry_date='2026-08-05' AND category='Office Expense'
           AND entry_type='expense' AND payment_method='cash'
           AND ((paid_to ILIKE 'tds' AND amount=7917) OR (paid_to ILIKE 'umiya%zerox' AND amount=10966))`);
      // Bank accounts: the company runs two (Kotak + Kalupur), but the ledger
      // kept ONE combined Bank balance, so neither could be reconciled against
      // its own statement. Every bank entry now carries the account it moved
      // through. Owner-managed rows, not a hardcoded list.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS bank_accounts (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          is_primary BOOLEAN NOT NULL DEFAULT FALSE,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_bank_account ON bank_accounts(lower(name))`);
      await pool.query(`INSERT INTO bank_accounts (name, is_primary) VALUES ('Kotak', TRUE) ON CONFLICT DO NOTHING`);
      await pool.query(`INSERT INTO bank_accounts (name, is_primary) VALUES ('Kalupur', FALSE) ON CONFLICT DO NOTHING`);
      await pool.query(`ALTER TABLE petty_cash_entries ADD COLUMN IF NOT EXISTS bank_account_id INTEGER REFERENCES bank_accounts(id) ON DELETE SET NULL`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_pce_bank_account ON petty_cash_entries(bank_account_id)`);
      {
        // One-time backfill: every existing bank entry is Kotak except the
        // 22-Jul "Bank KCC" opening, which IS the Kalupur balance. Verified by
        // reconciliation — the app's July total ties to Kotak's 31-Jul closing
        // plus that KCC opening, to ₹0.80. Guarded on nothing being tagged yet,
        // so it never re-runs and never overwrites the owner's own tagging.
        const { rows: done } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM petty_cash_entries WHERE bank_account_id IS NOT NULL`);
        if (done[0].n === 0) {
          const { rows: accts } = await pool.query(`SELECT id, name FROM bank_accounts`);
          const idOf = (n) => (accts.find(a => a.name.toLowerCase() === n) || {}).id || null;
          const kotak = idOf('kotak'), kalupur = idOf('kalupur');
          if (kotak) {
            await pool.query(
              `UPDATE petty_cash_entries SET bank_account_id=$1
                WHERE payment_method='paid_bank' AND bank_account_id IS NULL`, [kotak]);
          }
          if (kalupur) {
            await pool.query(
              `UPDATE petty_cash_entries SET bank_account_id=$1
                WHERE payment_method='paid_bank' AND TRIM(COALESCE(description,'')) ILIKE 'bank kcc'`, [kalupur]);
          }
        }
      }
      // Owner-confirmed correction to that backfill: the 05-Aug ₹1,41,596.55
      // loan repayment went out of the KALUPUR account, not Kotak. (The 06-Aug
      // ₹3,000 Machinery entry is Kotak, which the backfill already gets right.)
      // Runs AFTER the backfill — doing it before would leave a tagged row and
      // trip the backfill's "nothing tagged yet" guard. Idempotent: it only
      // touches the row while it is still on the wrong account.
      await pool.query(`
        UPDATE petty_cash_entries
           SET bank_account_id = (SELECT id FROM bank_accounts WHERE lower(name)='kalupur')
         WHERE payment_method='paid_bank' AND amount=141596.55
           AND TRIM(COALESCE(paid_to,'')) ILIKE 'Kalupur Loan Account'
           AND bank_account_id IS DISTINCT FROM (SELECT id FROM bank_accounts WHERE lower(name)='kalupur')`);
      // One-off (only while the 2026-07 run is unapproved): the last-saved July
      // payroll is FINAL and late cuts are waived for this month. Zero the
      // stored cut minutes + deduction (so any later Save/approve recompute
      // also yields no cut) and give the amount back on each line's total.
      // Late-day counts stay for information. Future months keep the rule.
      {
        const run = await pool.query(
          `SELECT id FROM payroll_runs WHERE month='2026-07' AND status IN ('draft','submitted') LIMIT 1`);
        if (run.rows.length) {
          await pool.query(`
            UPDATE payroll_lines SET
              total_payable    = COALESCE(total_payable, 0) + COALESCE(late_deduction, 0),
              late_deduction   = 0,
              late_cut_minutes = 0
            WHERE run_id = $1
              AND (COALESCE(late_deduction, 0) > 0 OR COALESCE(late_cut_minutes, 0) > 0)`,
            [run.rows[0].id]);
        }
      }
      // One-off (only while the 2026-07 run is unapproved): owner-final July
      // leave AVAILABILITY (before this month's usage) — Gayaji 2, Ajay 6,
      // Nayan Bhai 10. ONLY the leave ledger moves: carried is set so that with
      // each line's CURRENT accrual (+1 admin / +2 production) and sick credit
      // the run reads exactly the target. Also rounds the run's stored totals to
      // whole rupees so the grid ties out with the payments posted at approval.
      {
        const run = await pool.query(
          `SELECT id FROM payroll_runs WHERE month='2026-07' AND status IN ('draft','submitted') LIMIT 1`);
        if (run.rows.length) {
          const runId = run.rows[0].id;
          // Round EVERY money field on unapproved runs to the whole rupee and
          // rebuild the total from those rounded parts, matching computeLine —
          // so each row adds up by hand. Idempotent (rounding an integer is a
          // no-op), and it self-heals any run created before this rule.
          await pool.query(`
            UPDATE payroll_lines pl SET
              base_pay          = ROUND(COALESCE(pl.base_pay, 0)),
              ot_amount         = ROUND(COALESCE(pl.ot_amount, 0)),
              absent_deduction  = ROUND(COALESCE(pl.absent_deduction, 0)),
              holiday_pay       = ROUND(COALESCE(pl.holiday_pay, 0)),
              late_deduction    = ROUND(COALESCE(pl.late_deduction, 0)),
              petrol            = ROUND(COALESCE(pl.petrol, 0)),
              advance_deduction = ROUND(COALESCE(pl.advance_deduction, 0)),
              total_payable     = CASE WHEN pl.worker_group = 'labour'
                THEN ROUND(COALESCE(pl.base_pay,0)) + ROUND(COALESCE(pl.ot_amount,0))
                     + ROUND(COALESCE(pl.holiday_pay,0)) - ROUND(COALESCE(pl.advance_deduction,0))
                     - ROUND(COALESCE(pl.late_deduction,0))
                ELSE ROUND(COALESCE(pl.monthly_salary,0)) - ROUND(COALESCE(pl.absent_deduction,0))
                     + ROUND(COALESCE(pl.ot_amount,0)) + ROUND(COALESCE(pl.petrol,0))
                     - ROUND(COALESCE(pl.advance_deduction,0)) - ROUND(COALESCE(pl.late_deduction,0))
              END
            FROM payroll_runs r
            WHERE r.id = pl.run_id AND r.status IN ('draft','submitted')`);
          const ACCRUAL = { fixed_admin: 1, fixed_production: 2 };
          const targets = [
            // Owner's targets are the balance REMAINING AFTER this run:
            // Gayaji 1, Ajay 6, Nayan 8. Approval posts +accrual +sick −used, so
            //   after = carried + accrual + sick − used.
            // Gayaji: 0 + 1 + 1 − 1 = 1 ✓ (avail 2, uses 1)
            // Ajay:   4 + 1 + 1 − 0 = 6 ✓ (avail 6, uses 0)
            // Nayan:  6 + 2 + 0 − 0 = 8 ✓ — carried reduced by 2 (owner's call)
            //   in place of the 2 accrued credits he spent on late days, which
            //   the system can't consume (credits only offset recorded absences).
            { name: 'Gayaji', avail: 2 },
            { name: 'Ajay', avail: 6 },
            { name: 'Nayan Bhai', avail: 8 },
          ];
          // Owner: Gayaji uses 1 leave credit this month (2 available → 1 left).
          // Credits offset an absence, so her charged absences drop by 1 and the
          // line's money fields are recomputed on the ÷31 basis. (Nayan's 2
          // credits are NOT set: he has 0 recorded absences and the save/approve
          // paths clamp credits to absent days, so they would be dropped.)
          {
            const g = await pool.query(`SELECT id FROM employees WHERE name='Gayaji' LIMIT 1`);
            if (g.rows.length) {
              const gl = await pool.query(
                'SELECT * FROM payroll_lines WHERE run_id=$1 AND employee_id=$2 LIMIT 1', [runId, g.rows[0].id]);
              const l = gl.rows[0];
              if (l && Number(l.leave_credit_used || 0) === 0 && Number(l.absent_days || 0) >= 1) {
                const holQ = await pool.query(
                  `SELECT COUNT(*)::int AS n FROM holidays WHERE paid=TRUE AND to_char(holiday_date,'YYYY-MM')='2026-07'`);
                const holidays = Number(holQ.rows[0]?.n || 0);
                const salary = Number(l.monthly_salary || 0);
                const perDay = salary / 31;
                const otDiv = 8; // admin
                const charged = Math.max(Math.max(Number(l.absent_days || 0) - holidays, 0) - 1, 0);
                // Whole rupees throughout, total built from the rounded parts.
                const absentDed = Math.round(perDay * charged);
                const otAmt = Math.round((perDay / otDiv) * Number(l.ot_hours || 0));
                const lateDed = Math.round((Number(l.late_cut_minutes || 0) / 60) * (perDay / otDiv));
                const pet = Math.round(Number(l.petrol || 0));
                const adv = Math.round(Number(l.advance_deduction || 0));
                const total = Math.round(salary) - absentDed + otAmt + pet - adv - lateDed;
                await pool.query(
                  `UPDATE payroll_lines SET leave_credit_used=1, base_pay=$1, absent_deduction=$2,
                     ot_amount=$3, late_deduction=$4, petrol=$5, advance_deduction=$6, total_payable=$7 WHERE id=$8`,
                  [Math.round(salary) - absentDed, absentDed, otAmt, lateDed, pet, adv, total, l.id]);
              }
            }
          }
          for (const t of targets) {
            const emp = await pool.query('SELECT id, worker_group FROM employees WHERE name=$1 LIMIT 1', [t.name]);
            if (!emp.rows.length) continue;
            const empId = emp.rows[0].id;
            const accrual = ACCRUAL[emp.rows[0].worker_group] || 0;
            const line = await pool.query(
              `SELECT COALESCE(sick_credit_earned,0) AS sick, COALESCE(leave_credit_used,0) AS used
                 FROM payroll_lines WHERE run_id=$1 AND employee_id=$2 LIMIT 1`, [runId, empId]);
            const sick = Number(line.rows[0]?.sick || 0);
            const used = Number(line.rows[0]?.used || 0);
            // "Available" now excludes this month's usage, so no +used term.
            const targetCarried = t.avail - accrual - sick;
            const bal = await pool.query(
              'SELECT COALESCE(SUM(delta),0) AS b FROM employee_leave_ledger WHERE employee_id=$1', [empId]);
            const delta = targetCarried - Number(bal.rows[0].b);
            if (delta !== 0) {
              await pool.query(
                `INSERT INTO employee_leave_ledger (employee_id, delta, reason, notes)
                 VALUES ($1,$2,'manual','Owner-set: July Leaves Avail. = ' || $3)`,
                [empId, delta, String(t.avail)]);
            }
          }
        }
      }
      // One-off (while 2026-07 unapproved): owner switched admin & production-
      // with-leave to a days-in-month basis INCLUDING July (÷31). Recompute the
      // divisor-driven money fields on those July lines; attendance, leaves and
      // the late-cut waiver (late_cut_minutes = 0) are untouched. Deterministic
      // → safe to re-run.
      {
        const run = await pool.query(
          `SELECT id FROM payroll_runs WHERE month='2026-07' AND status IN ('draft','submitted') LIMIT 1`);
        if (run.rows.length) {
          const runId = run.rows[0].id;
          const hol = await pool.query(
            `SELECT COUNT(*)::int AS n FROM holidays WHERE paid=TRUE AND to_char(holiday_date,'YYYY-MM')='2026-07'`);
          const holidays = Number(hol.rows[0]?.n || 0);
          const lines = await pool.query(
            `SELECT * FROM payroll_lines WHERE run_id=$1 AND worker_group IN ('fixed_admin','fixed_production','fixed_production_nl')`, [runId]);
          const r2m = (n) => Math.round(Number(n || 0) * 100) / 100;
          for (const l of lines.rows) {
            const salary = Number(l.monthly_salary || 0);
            const perDay = salary / 31;
            const otDiv = l.worker_group === 'fixed_admin' ? 8 : 10;
            const deductible = Math.max(Number(l.absent_days || 0) - holidays, 0);
            const charged = Math.max(deductible - Number(l.leave_credit_used || 0), 0);
            const absentDed = r2m(perDay * charged);
            const otAmt = r2m((perDay / otDiv) * Number(l.ot_hours || 0));
            const lateDed = r2m((Number(l.late_cut_minutes || 0) / 60) * (perDay / otDiv));
            const total = r2m(salary - absentDed + otAmt + Number(l.petrol || 0) - Number(l.advance_deduction || 0) - lateDed);
            await pool.query(
              `UPDATE payroll_lines SET daily_rate=$1, base_pay=$2, ot_amount=$3, absent_deduction=$4,
                 late_deduction=$5, total_payable=$6 WHERE id=$7`,
              [r2m(perDay), r2m(salary - absentDed), otAmt, absentDed, lateDed, total, l.id]);
          }
        }
      }
      // Sweep: reverse ANY fins draw whose parsed length was implausible (>20m
      // per piece — mashed multi-value stage-8 entries like "1610-1625" →
      // 16101625mm or "930-897" → 930897mm) and re-post the correct draw from
      // the AVERAGE of the stage-8 numbers. Idempotent: bad rows are deleted and
      // corrected rows say "(corrected):", which this scan's pattern skips.
      {
        const finsBase = { 'FIN-MS-08': 0.011, 'FIN-MS-11': 0.019, 'FIN-SS-08-VE': 0.014, 'FIN-SS-11-VE': 0.020 };
        const txs = await pool.query(
          `SELECT t.*, ii.item_code FROM inventory_transactions t
             JOIN inventory_items ii ON ii.id = t.item_id
            WHERE t.transaction_type='dispatch_to_production'
              AND t.notes LIKE '%Fins by tube length: %mm%'`);
        for (const tx of txs.rows) {
          const m = String(tx.notes).match(/Fins by tube length: ([\d.]+)mm .*× (\d+) pcs .*\(JC ([^)]+)\)/);
          if (!m) continue;
          const badLen = parseFloat(m[1]);
          const pcs = parseInt(m[2], 10);
          if (!(badLen > 20000)) continue; // plausible length — leave it alone
          const qty = Number(tx.quantity);
          const jcRow = await pool.query('SELECT id, order_item_id FROM job_cards WHERE job_card_no=$1 LIMIT 1', [m[3]]);
          const jc = jcRow.rows[0];
          // 1) reverse: stock back, BOM qty_deducted back, drop the bad row
          await pool.query('UPDATE inventory_items SET current_stock = current_stock + $1 WHERE id=$2', [qty, tx.item_id]);
          if (jc?.order_item_id) {
            await pool.query(
              `UPDATE order_item_inventory SET qty_deducted = GREATEST(COALESCE(qty_deducted,0) - $1, 0)
                WHERE order_item_id=$2 AND inventory_item_id=$3`, [qty, jc.order_item_id, tx.item_id]);
          }
          await pool.query('DELETE FROM inventory_transactions WHERE id=$1', [tx.id]);
          // 2) re-deduct from the average of the stage-8 numbers
          const perBase = finsBase[tx.item_code];
          if (!jc || !perBase || !(pcs > 0)) continue;
          const s8 = await pool.query('SELECT value1 FROM production_checklist WHERE job_card_id=$1 AND stage_no=8', [jc.id]);
          const nums = (String(s8.rows[0]?.value1 || '').match(/\d+(?:\.\d+)?/g) || []).map(Number);
          const lengthMm = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
          if (!(lengthMm > 0 && lengthMm <= 20000)) continue;
          const kgs = Math.round((lengthMm / 50.8) * perBase * pcs * 1000) / 1000;
          const inv = await pool.query('SELECT current_stock FROM inventory_items WHERE id=$1', [tx.item_id]);
          const newStock = Number(inv.rows[0].current_stock) - kgs;
          await pool.query('UPDATE inventory_items SET current_stock=$1 WHERE id=$2', [newStock, tx.item_id]);
          if (jc.order_item_id) {
            await pool.query(
              `UPDATE order_item_inventory SET qty_deducted = COALESCE(qty_deducted,0) + $1
                WHERE order_item_id=$2 AND inventory_item_id=$3`, [kgs, jc.order_item_id, tx.item_id]);
          }
          const note = String(tx.notes)
            .replace(/Fins by tube length: [\d.]+mm/, `Fins by tube length (corrected): ${Math.round(lengthMm * 100) / 100}mm`)
            .replace(/= [\d.]+kg/, `= ${kgs}kg`);
          await pool.query(
            `INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by)
             VALUES ($1,'dispatch_to_production',$2,$3,$4,$5)`,
            [tx.item_id, kgs, newStock, note, tx.created_by]);
        }
      }
      // One-off: P PHE 05's single ₹480 freight bill was entered on each of its
      // items. Spread ₹480 across them by material value instead (the =480 guard
      // makes this run once; shares never equal exactly 480 with multiple items).
      await pool.query(`
        UPDATE purchase_order_items poi
           SET receive_transport_cost = ROUND(480.0 * poi.amount / NULLIF(t.total, 0), 2)
          FROM purchase_orders po,
               (SELECT SUM(poi2.amount) AS total
                  FROM purchase_order_items poi2 JOIN purchase_orders po2 ON po2.id = poi2.po_id
                 WHERE po2.po_number = 'P PHE 05') t
         WHERE po.id = poi.po_id AND po.po_number = 'P PHE 05'
           AND poi.receive_transport_cost = 480`);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS supplier_items (
          id SERIAL PRIMARY KEY,
          supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
          inventory_item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
          supplier_part_no TEXT,
          supplier_price NUMERIC DEFAULT 0,
          lead_time_days INTEGER,
          min_order_qty NUMERIC DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(supplier_id, inventory_item_id)
        )
      `);

      // ── Customer Queries tables ──────────────────────────────────────────────
      await pool.query(`
        CREATE TABLE IF NOT EXISTS customer_queries (
          id SERIAL PRIMARY KEY,
          query_no TEXT UNIQUE NOT NULL,
          order_id INTEGER NOT NULL REFERENCES orders(id),
          job_card_id INTEGER REFERENCES job_cards(id),
          subject TEXT NOT NULL,
          description TEXT,
          category TEXT DEFAULT 'general',
          priority TEXT DEFAULT 'medium',
          assigned_department TEXT,
          status TEXT DEFAULT 'open',
          return_type TEXT,
          return_status TEXT,
          debit_note_no TEXT,
          return_coupon_no TEXT,
          resolution_summary TEXT,
          resolved_by INTEGER REFERENCES users(id),
          resolved_at TIMESTAMPTZ,
          created_by INTEGER REFERENCES users(id),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS customer_query_photos (
          id SERIAL PRIMARY KEY,
          query_id INTEGER NOT NULL REFERENCES customer_queries(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL,
          file_name TEXT NOT NULL,
          caption TEXT,
          uploaded_by INTEGER REFERENCES users(id),
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS customer_query_messages (
          id SERIAL PRIMARY KEY,
          query_id INTEGER NOT NULL REFERENCES customer_queries(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id),
          message TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS customer_query_mentions (
          id SERIAL PRIMARY KEY,
          message_id INTEGER NOT NULL REFERENCES customer_query_messages(id) ON DELETE CASCADE,
          query_id INTEGER NOT NULL REFERENCES customer_queries(id) ON DELETE CASCADE,
          mentioned_user_id INTEGER NOT NULL REFERENCES users(id),
          is_read INTEGER DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      // ── Notifications ─────────────────────────────────────────────────────────
      await pool.query(`
        CREATE TABLE IF NOT EXISTS notifications (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT,
          link TEXT,
          source_user_id INTEGER REFERENCES users(id),
          is_read INTEGER DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications (user_id, is_read, created_at DESC)`);

      // ── Message attachments ──────────────────────────────────────────────────
      await pool.query(`
        CREATE TABLE IF NOT EXISTS message_attachments (
          id SERIAL PRIMARY KEY,
          message_id INTEGER NOT NULL,
          file_path TEXT NOT NULL,
          file_name TEXT NOT NULL,
          file_size INTEGER DEFAULT 0,
          mime_type TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS customer_query_message_attachments (
          id SERIAL PRIMARY KEY,
          message_id INTEGER NOT NULL REFERENCES customer_query_messages(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL,
          file_name TEXT NOT NULL,
          file_size INTEGER DEFAULT 0,
          mime_type TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      // Add customer_query status to orders check constraint (allow new statuses)
      // Also add 'customer_query' and 'product_return' to job_cards status options
      // We'll just add the columns we need, constraints are loose in code
      await pool.query(`ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check`);
      await pool.query(`ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK(status IN (
        'pending_approval','approved','rejected','job_card_created','in_progress',
        'qc_pending','qc_approved','packaging','dispatched','on_hold',
        'customer_query','resolved_dispatched','product_return',
        'fg_qc_pending','fg_qc_approved'
      ))`);
      await pool.query(`ALTER TABLE job_cards DROP CONSTRAINT IF EXISTS job_cards_status_check`);
      await pool.query(`ALTER TABLE job_cards ADD CONSTRAINT job_cards_status_check CHECK(status IN (
        'pending','in_progress','on_hold','qc_pending','qc_approved','completed','dispatched',
        'customer_query','product_return','repair_in_progress','repaired_dispatched','resolved_dispatched'
      ))`);

      // Enable Row-Level Security on every public table. The app connects as a
      // BYPASSRLS role so this changes nothing for it — it only blocks Supabase's
      // auto-generated public REST API (anon key), which this app doesn't use.
      // No policies are defined: deny-by-default. Covers future tables too.
      const rlsOff = await pool.query(
        `SELECT tablename FROM pg_tables WHERE schemaname='public' AND NOT rowsecurity`);
      for (const { tablename } of rlsOff.rows) {
        await pool.query(`ALTER TABLE "${tablename}" ENABLE ROW LEVEL SECURITY`);
      }
      if (rlsOff.rows.length) console.log(`RLS enabled on ${rlsOff.rows.length} table(s)`);

      // Seed default users only on first run (empty table)
      const { rows } = await pool.query('SELECT COUNT(*) AS c FROM users');
      if (parseInt(rows[0].c, 10) === 0) {
        const hash = bcrypt.hashSync('PHE@2024', 10);
        const seeds = [
          ['Mitesh / Vama Shah', 'owner',      hash, 'owner'],
          ['Admin',              'admin',       hash, 'admin'],
          ['Accounts Manager',   'accounts',    hash, 'accounts'],
          ['Design / QC',        'design',      hash, 'design'],
          ['Production Manager', 'production',  hash, 'production'],
        ];
        for (const [name, username, password_hash, role] of seeds) {
          await pool.query(
            `INSERT INTO users (name, username, password_hash, role, force_password_change)
             VALUES ($1, $2, $3, $4, 1)
             ON CONFLICT (username) DO NOTHING`,
            [name, username, password_hash, role]
          );
        }
        console.log('Default users seeded. Password: PHE@2024 (all users must change on first login)');
      }
      console.log('Database connected');
      return; // success
    } catch (err) {
      console.error(`initDB attempt ${attempt}/${retries} failed: ${err.message}`);
      if (attempt === retries) {
        console.error('Failed to connect to database after all retries');
        throw err;
      }
      console.log(`Retrying in ${delayMs / 1000}s...`);
      await new Promise(res => setTimeout(res, delayMs));
    }
  }
}

async function logActivity(orderId, jobCardId, activityType, description, userId) {
  try {
    await pool.query(
      `INSERT INTO activity_log (order_id, job_card_id, activity_type, description, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [orderId || null, jobCardId || null, activityType, description, userId]
    );
  } catch (err) {
    console.error('logActivity error:', err.message);
  }
}

module.exports = { getDB, initDB, logActivity };
