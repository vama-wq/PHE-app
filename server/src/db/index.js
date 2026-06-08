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

async function initDB(retries = 10, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Run idempotent migrations
      await pool.query(`ALTER TABLE job_card_holds ADD COLUMN IF NOT EXISTS notes TEXT`);
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
      // Widen stage_no check constraint to include stage 30 (Dispatch)
      await pool.query(`ALTER TABLE production_checklist DROP CONSTRAINT IF EXISTS production_checklist_stage_no_check`);
      await pool.query(`ALTER TABLE production_checklist ADD CONSTRAINT production_checklist_stage_no_check CHECK (stage_no BETWEEN 1 AND 30)`);
      // Add notes column for rework/notes per stage
      await pool.query(`ALTER TABLE production_checklist ADD COLUMN IF NOT EXISTS notes TEXT`);
      // Add unique constraint on supplier_code to prevent duplicates
      await pool.query(`ALTER TABLE suppliers ADD CONSTRAINT IF NOT EXISTS suppliers_supplier_code_unique UNIQUE (supplier_code)`);
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
