// ── Rework inventory ──────────────────────────────────────────────────────────
// Pieces of a BOM part recovered at QC — pulled from a card, reusable after
// rework — go into that part's REWORK BIN: one bin per inventory item, a count
// that sits beside normal stock and never inside it. Nothing that reads
// current_stock (low stock, valuation, reports, purchase receive, FIFO) sees
// these pieces: they are not usable stock until reworked.
//
// The bin exists only while its count is above zero; at zero the row goes.
// Its history lives in inventory_rework_moves — deposit, draw, return,
// reversal, scrap — each with the order / card it came from or went to, so the
// provenance survives the bin being deleted and re-created.
//
// A later order item draws from the bin through its BOM line: the line's
// rework_qty is the portion of its total that comes from the bin, reserved
// the moment the BOM is saved (free = bin - what open items have claimed) and
// taken at the same moments normal stock is taken. If the bin is short when
// the draw happens the rest comes from normal stock, with a note — production
// is never blocked and the bin never goes negative. Owner's rules, 27 Sep 2026.
const { getDB } = require('../db');

// Pieces a job card's terminal pins are marked to take from the bin (Change
// pins, owner 8 Oct 2026) are held for that card until its last stage takes
// them — the same as a list line's rework portion holds pieces for its order.
// `excl` is a SQL fragment naming a card to leave out (its own hold).
const CARD_HOLDS = (itemExpr, excl = '') => `COALESCE((
  SELECT SUM(t.rework_qty) FROM job_card_terminals t JOIN job_cards jc ON jc.id = t.job_card_id
   WHERE t.inventory_item_id = ${itemExpr} AND t.rework_qty > 0 ${excl}
     AND jc.last_stage_taken_at IS NULL AND jc.pins_taken_at IS NULL AND jc.dispatched_at IS NULL AND jc.inventory_qc_at IS NULL), 0)`;

async function binQty(db, itemId) {
  const b = await db.get('SELECT qty FROM inventory_rework_bins WHERE item_id=$1', [itemId]);
  return Number(b?.qty) || 0;
}

// What open, not-yet-settled BOM lines have claimed and not yet drawn.
// excludeItemId: the order item being (re)saved, whose own old lines are about
// to be replaced and must not count against it.
async function reservedQty(db, itemId, excludeItemId = null) {
  const r = await db.get(
    `SELECT COALESCE(SUM(GREATEST(oii.rework_qty - oii.rework_deducted, 0)), 0) + ${CARD_HOLDS('$1::int')} AS r
       FROM order_item_inventory oii JOIN order_items oi ON oi.id = oii.order_item_id
      WHERE oii.inventory_item_id=$1 AND oi.inventory_deducted = FALSE
        AND ($2::int IS NULL OR oi.id <> $2)`, [itemId, excludeItemId]);
  return Number(r?.r) || 0;
}

async function freeQty(db, itemId, excludeItemId = null) {
  return Math.max(0, (await binQty(db, itemId)) - (await reservedQty(db, itemId, excludeItemId)));
}

// Every bin, with its free count — for pickers and the inventory list.
async function binsWithFree(db) {
  return db.all(
    `SELECT b.item_id, b.qty,
            GREATEST(b.qty - COALESCE((SELECT SUM(GREATEST(oii.rework_qty - oii.rework_deducted, 0))
                                          FROM order_item_inventory oii JOIN order_items oi ON oi.id = oii.order_item_id
                                         WHERE oii.inventory_item_id = b.item_id AND oi.inventory_deducted = FALSE), 0)
                     - ${CARD_HOLDS('b.item_id')}, 0) AS free
       FROM inventory_rework_bins b`);
}

async function move(db, { itemId, kind, qty, ref = {}, notes = null, userId }) {
  const q = Number(qty);
  if (!(q > 0)) return 0;
  const cur = await binQty(db, itemId);
  const after = kind === 'deposit' || kind === 'return' ? cur + q : cur - q;
  if (after < -1e-9) throw new Error(`Rework bin for item ${itemId} would go negative (${cur} - ${q})`);
  if (after > 1e-9) {
    await db.run(
      `INSERT INTO inventory_rework_bins (item_id, qty) VALUES ($1,$2)
       ON CONFLICT (item_id) DO UPDATE SET qty = EXCLUDED.qty, updated_at = NOW()`, [itemId, after]);
  } else {
    // Zero means no bin. Deleted, as the owner asked — the moves keep the story.
    await db.run('DELETE FROM inventory_rework_bins WHERE item_id=$1', [itemId]);
  }
  await db.run(
    `INSERT INTO inventory_rework_moves (item_id, kind, qty, bin_after, order_id, order_item_id, job_card_id,
                                         order_code, job_card_no, drawing_number, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [itemId, kind, q, Math.max(after, 0), ref.order_id || null, ref.order_item_id || null, ref.job_card_id || null,
     ref.order_code || null, ref.job_card_no || null, ref.drawing_number || null, notes, userId || null]);
  return q;
}

// Units that count in whole pieces. Anything else (kgs, metres, litres) is not
// reworked as a count and is refused at QC.
const PIECE_UNITS = new Set(['pcs', 'pc', 'nos', 'no', 'piece', 'pieces', 'set', 'sets', 'box', 'boxes']);
const isPieceUnit = (u) => PIECE_UNITS.has(String(u || '').trim().toLowerCase().replace(/\.$/, ''));

module.exports = { binQty, reservedQty, freeQty, binsWithFree, move, isPieceUnit, CARD_HOLDS };
