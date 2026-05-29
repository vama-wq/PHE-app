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

async function initDB() {
  try {
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
  } catch (err) {
    console.error('initDB error:', err.message);
    throw err;
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
