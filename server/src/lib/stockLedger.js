// ── Inventory-correction rules (owner, 1 Oct 2026) ─────────────────────────────
// Design is re-entering the inventory (BOM) of every order from order 1 so
// future orders reuse correct lists. A correction must never move stock
// wrongly, so each save is judged by fixed rules instead of the old
// "give everything back, take the whole new list from today's stock":
//
//   1. Look at the order line's stock history: what was really taken, and from
//      which real items. TRAIN placeholders do not count as really taken.
//   2. Nothing real was taken → the list is corrected, stock is not touched.
//   3. Real items were taken → only the difference moves: a wrong item gets its
//      pieces back, a right or forgotten item is taken, a changed quantity
//      takes only the extra or gives back the excess.
//   4. Still in production → only as much as production has reached.
//   5. Never below zero: a take the stock cannot cover is skipped and noted.
//   6. Saving again never moves stock a second time.
//   7. Every move is written on the order's history.
//
// "Really taken" comes from inventory_transactions tied to the order line
// (order_item_id) — NEVER from order_item_inventory.qty_deducted, which old
// data and a startup sweep filled in without any stock moving. When the
// history cannot be tied to the line with certainty, the save is record-only:
// a doubt never takes stock.

const dbmod = require('../db');

const PLACEHOLDER = /TRAIN/i;            // TER-03-WH-TRAIN, TER-3"-WOH-TRAIN
const EPS = 1e-6;
const r4 = (n) => Math.round(Number(n) * 10000) / 10000;

// A card in any of these has been through QC: what it was built with is used up.
// 'inventory_qc' (Product QC passed, Inventory QC still to do) counts too — its
// whole list was taken when it finished its last stage.
const PASSED_QC = new Set(['inventory_qc', 'qc_approved', 'dispatched', 'completed', 'customer_query', 'product_return',
  'repair_in_progress', 'resolved_dispatched', 'repaired_dispatched']);

// ── Columns this needs (added in initDB; checked here so that a request in the
// seconds before the migration ran degrades instead of failing) ─────────────
let colsReady = false;
let colsCheckedAt = 0;
async function ledgerColumnsReady() {
  if (colsReady) return true;
  if (Date.now() - colsCheckedAt < 60e3) return false;
  colsCheckedAt = Date.now();
  try {
    const r = await dbmod.getDB().pool.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE (table_name='inventory_transactions' AND column_name IN ('order_item_id','source'))
           OR (table_name='order_item_inventory' AND column_name='qty_waived')`);
    colsReady = r.rows[0].n === 3;
  } catch (_) { colsReady = false; }
  return colsReady;
}

// Every stock movement tied to an order line goes through here, so the line's
// history can be read back exactly. source: 'bom' (production), 'correction'
// (a corrected list), 'remake' (QC extras).
// jobCardId: the card the stock went to (or came back from), so Inventory QC
// can read a card's own movements by column rather than by its notes.
async function recordMove(db, { itemId, type, qty, balanceAfter, notes, userId, orderItemId = null, source = null, jobCardId = null }) {
  if (await ledgerColumnsReady()) {
    return db.insert(
      `INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by, order_item_id, source, job_card_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [itemId, type, qty, balanceAfter, notes, userId, orderItemId, source, jobCardId]);
  }
  return db.insert(
    `INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by, job_card_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [itemId, type, qty, balanceAfter, notes, userId, jobCardId]);
}

// ── What really happened to an order line ─────────────────────────────────────
// known=false means the history cannot be trusted (columns missing, or this
// order has production movements not tied to a line) — the caller then treats
// the save as record-only.
async function ledgerForItem(db, orderItemId) {
  if (!(await ledgerColumnsReady())) return { known: false, why: 'stock history not linked yet' };
  const it = await db.get(
    `SELECT oi.id, oi.order_id, o.order_code, o.created_at FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.id=$1`,
    [orderItemId]);
  if (!it) return { known: false, why: 'order line not found' };
  const unlinked = await db.get(
    `SELECT 1 AS x FROM inventory_transactions
      WHERE order_item_id IS NULL AND transaction_type IN ('dispatch_to_production','return_from_production')
        AND created_at >= $2
        AND (notes LIKE 'Order: ' || $1 || ' |%' OR notes LIKE '%— ' || $1)
      LIMIT 1`, [it.order_code, it.created_at]);
  if (unlinked) return { known: false, why: 'part of this order\'s stock history could not be tied to a line' };

  const rows = await db.all(
    `SELECT t.item_id, ii.item_code, t.transaction_type, t.source, SUM(t.quantity)::float AS q
       FROM inventory_transactions t JOIN inventory_items ii ON ii.id = t.item_id
      WHERE t.order_item_id=$1 AND t.source IN ('bom','correction')
        AND t.transaction_type IN ('dispatch_to_production','return_from_production')
      GROUP BY 1,2,3,4`, [orderItemId]);
  const natural = {};   // production only (source 'bom'), taken − given back
  const net = {};       // everything, incl. earlier corrections
  const codes = {};
  for (const r of rows) {
    const sign = r.transaction_type === 'dispatch_to_production' ? 1 : -1;
    codes[r.item_id] = r.item_code;
    net[r.item_id] = (net[r.item_id] || 0) + sign * r.q;
    if (r.source === 'bom') natural[r.item_id] = (natural[r.item_id] || 0) + sign * r.q;
  }
  const isPh = (id) => PLACEHOLDER.test(codes[id] || '');
  const naturalReal = Object.keys(natural).some(id => !isPh(id) && natural[id] > EPS);
  const hadPlaceholder = Object.keys(natural).some(id => isPh(id) && natural[id] > EPS);
  const realNet = {};
  for (const id of Object.keys(net)) if (!isPh(id)) realNet[id] = r4(net[id]);
  return { known: true, naturalReal, hadPlaceholder, net: realNet, natural, codes };
}

// ── How much of each line production has reached ─────────────────────────────
// A card that has been through QC used its share of every line; a card still
// in production used its share of the stage-timed lines whose stage is ticked.
// Shares are card qty ÷ item qty, capped at the line. Fins lines are left out:
// they go by tube length at QC and a correction never moves them.
async function progressTargets(db, orderItemId, lines, { stageMap, finsCodes, settled = false }) {
  const item = await db.get('SELECT id, quantity FROM order_items WHERE id=$1', [orderItemId]);
  const cards = await db.all(
    'SELECT id, job_card_no, qty, status, fins_deducted, qc_dispatch_qty, qc_fg_qty, last_stage_taken_at FROM job_cards WHERE order_item_id=$1', [orderItemId]);
  const cardIds = cards.map(c => c.id);
  // A card sent back after QC (owner reversal, repair, debit-note return) has
  // still used its parts: it counts as through QC if it ever got there.
  const qcTook = new Set((await db.all(
    `SELECT DISTINCT substring(notes from '\\(JC ([^)]+)\\)') AS jc FROM inventory_transactions
      WHERE order_item_id=$1 AND source='bom' AND notes LIKE '%QC-approved (JC %'`, [orderItemId])).map(r => r.jc));
  // A card whose last stage took the rest of its list has used its share too
  // (owner, 6 Oct 2026) — a correction must never give that back.
  const everPassed = (c) => PASSED_QC.has(c.status) || !!c.fins_deducted || !!c.last_stage_taken_at
    || (Number(c.qc_dispatch_qty) || 0) + (Number(c.qc_fg_qty) || 0) > 0 || qcTook.has(c.job_card_no);
  const done = cardIds.length ? await db.all(
    `SELECT job_card_id, stage_no FROM production_checklist
      WHERE job_card_id = ANY($1) AND done=1 AND stage_no = ANY($2)`,
    [cardIds, Object.keys(stageMap).map(Number)]) : [];
  const stageDone = new Set(done.map(d => `${d.job_card_id}:${d.stage_no}`));
  const itemQty = Number(item?.quantity) || cards.reduce((a, c) => a + (Number(c.qty) || 0), 0) || 1;
  // An item already settled (its whole list taken at QC/dispatch) stays settled.
  const allPassed = settled || (cards.length > 0 && cards.every(everPassed));
  const stageOf = (category) => {
    const cat = String(category || '').trim();
    for (const [st, cats] of Object.entries(stageMap)) if (cats.includes(cat)) return Number(st);
    return null;
  };
  const out = new Map();
  for (const ln of lines) {
    if (finsCodes.includes(ln.item_code)) { out.set(ln.inventory_item_id, null); continue; }
    const total = Number(ln.qty) || 0;
    if (allPassed) { out.set(ln.inventory_item_id, r4(total)); continue; }
    const st = stageOf(ln.category);
    let used = 0;
    for (const c of cards) {
      const share = Math.min(1, (Number(c.qty) || 0) / itemQty);
      if (everPassed(c)) used += share * total;
      else if (st && stageDone.has(`${c.id}:${st}`)) used += share * total;
    }
    out.set(ln.inventory_item_id, r4(Math.min(total, used)));
  }
  return { targets: out, allPassed, cards: cards.length };
}

module.exports = { PLACEHOLDER, PASSED_QC, ledgerColumnsReady, recordMove, ledgerForItem, progressTargets, r4, EPS };
