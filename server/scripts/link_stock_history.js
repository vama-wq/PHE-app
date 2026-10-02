#!/usr/bin/env node
// One-off (1 Oct 2026): tie every past BOM stock movement to its order line, so
// the inventory-correction rules (src/lib/stockLedger.js) can see what was
// really taken. It writes ONLY inventory_transactions.order_item_id and .source
// — no stock, no BOM line, no balance changes. Rows it cannot place with
// certainty are left unlinked; the rules then treat that order as record-only.
//
//   node scripts/link_stock_history.js            → dry run: report only
//   node scripts/link_stock_history.js --apply    → write the links
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { linkStockHistory } = require('../src/lib/linkStockHistory');

const APPLY = process.argv.includes('--apply');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const NOT_BOM = ['material usage, not a BOM line', 'order deleted', 'order no longer exists'];

(async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout = '10s'");
    await c.query('ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS order_item_id INTEGER');
    await c.query('ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS source TEXT');
    const { considered, link, why, tx } = await linkStockHistory(c, { apply: APPLY });
    const bySrc = {};
    for (const l of link.values()) bySrc[l.source] = (bySrc[l.source] || 0) + 1;
    const reasons = {};
    for (const w of why.values()) reasons[w] = (reasons[w] || 0) + 1;
    console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — movements considered: ${considered}`);
    console.log('linked by source:', bySrc);
    console.log('left unlinked:', reasons);
    const blocking = [...why.entries()].filter(([, w]) => !NOT_BOM.includes(w));
    if (blocking.length) {
      const codes = [...new Set(blocking.map(([id]) => (tx.find(x => x.id === id)?.notes || '').match(/ORD-\d+-\d+/)?.[0]))].sort();
      console.log(`Orders that stay record-only (history not placeable): ${codes.join(', ')}`);
    }
    await c.query(APPLY ? 'COMMIT' : 'ROLLBACK');
    if (APPLY) console.log(`linked ${link.size} movements`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error(e);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
})();
