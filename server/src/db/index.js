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
      // Receiving is per item, each with its own invoice; then per-item QC.
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS received BOOLEAN DEFAULT FALSE`);
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ`);
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS invoice_file TEXT`);
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS invoice_original_name TEXT`);
      // Costs known only at receipt: transport + any other cost (with a reason).
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS receive_transport_cost NUMERIC`);
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS receive_other_cost NUMERIC`);
      await pool.query(`ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS receive_other_cost_reason TEXT`);

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
