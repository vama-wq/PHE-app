// ── Last-stage take (owner, 6 Oct 2026) ───────────────────────────────────────
// "All other inventory of the job card is taken when the card completes its
// LAST stage" — stage 29 (Ready in Production) on a production card, stage 4
// (Ready for Dispatch) on a finished-goods card. Not at QC any more. The stage
// takes are unchanged (Stage 4 coil, 5 tube, 6 PVC bush + MgO, 15 flange /
// brazing, 21 nipple): this takes everything else on the card's list.
//
// The card takes its FULL quantity — every piece built. Rejected and remade
// pieces need nothing extra here: any real difference is corrected by QC at
// Inventory QC (routes/qc.js), which is the final change to the card's
// inventory, ever.
//
// Once per card: last_stage_taken_at is stamped at the end, also when nothing
// was taken, and the whole take runs in one transaction with the card locked,
// so a double tick or a retry can never take twice.

const { STAGE_CATEGORY_MAP, STAGE_LABEL, FINS_CODES, fgTakes, deductLine, deductFinsByLength, resolveJobCardItemId, fgSourceLength } = require('./inventoryDeduction');
const { clientDb } = require('./bomCorrection');
const { isPieceUnit } = require('./rework');
const { isTerminalCategory, takeTerminalRows } = require('./terminals');

const r4 = (n) => Math.round(Number(n) * 1e4) / 1e4;

// The stage a stage-timed category is taken at (15 / 21), or null.
function stageOf(category) {
  const cat = String(category || '').trim();
  for (const [st, cats] of Object.entries(STAGE_CATEGORY_MAP)) if (cats.includes(cat)) return Number(st);
  return null;
}

async function runTake(tx, jobCardId, userId) {
  const card = await tx.get(
    `SELECT jc.*, o.order_code, o.order_type FROM job_cards jc JOIN orders o ON o.id = jc.order_id
      WHERE jc.id=$1 FOR UPDATE OF jc`, [jobCardId]);
  if (!card || card.last_stage_taken_at) return { taken: [] };
  const stamp = () => tx.run('UPDATE job_cards SET last_stage_taken_at = NOW() WHERE id=$1', [card.id]);

  // Closed at Inventory QC: nothing ever moves again.
  if (card.inventory_qc_at) { await stamp(); return { taken: [] }; }

  // A card that was already through QC the old way — approved before this went
  // live and now back for a repair or a reversed approval — took its list then.
  // "Cards already qc_approved or dispatched at go-live … stay as they are."
  const legacyQc = !!card.dispatched_at || !!card.fins_deducted || !!(await tx.get(
    `SELECT 1 AS x FROM inventory_transactions WHERE strpos(notes, $1) > 0 LIMIT 1`,
    [`QC-approved (JC ${card.job_card_no})`]));
  if (legacyQc) { await stamp(); return { taken: [] }; }

  const itemId = await resolveJobCardItemId(tx, card);
  const item = itemId ? await tx.get(
    'SELECT id, drawing_number, quantity, inventory_deducted FROM order_items WHERE id=$1 FOR UPDATE', [itemId]) : null;
  // Nothing to take: no order line, or the line is already settled (a
  // replacement or repair card behaves as today).
  if (!item || item.inventory_deducted) { await stamp(); return { taken: [] }; }

  const fgOrder = card.order_type === 'finished_goods';
  const orderCode = card.order_code || `Order #${card.order_id}`;
  const cardQty = Number(card.qty) || 0;
  const itemQty = Number(item.quantity) || 0;
  const taken = [];

  const lines = await tx.all(
    `SELECT oii.*, ii.item_code, ii.unit, TRIM(ii.category) AS category
       FROM order_item_inventory oii JOIN inventory_items ii ON ii.id = oii.inventory_item_id
      WHERE oii.order_item_id=$1 ORDER BY oii.inventory_item_id`, [item.id]);

  // Was this card's stage 15 / 21 ever ticked? Its stage take then already
  // took its share of those categories. A split card inherits its parent's
  // ticked stages — the parent's take covered its pieces.
  const stageTicked = {};
  for (const st of Object.keys(STAGE_CATEGORY_MAP).map(Number)) {
    const ticked = await tx.get(
      'SELECT 1 AS x FROM production_checklist WHERE job_card_id=$1 AND stage_no=$2 AND done=1', [card.id, st]);
    const took = ticked ? null : await tx.get(
      `SELECT 1 AS x FROM inventory_transactions WHERE (job_card_id=$1 OR job_card_id IS NULL) AND strpos(notes, $2) > 0 LIMIT 1`,
      [card.id, `${STAGE_LABEL[st]} (JC ${card.job_card_no})`]);
    stageTicked[st] = !!(ticked || took);
  }

  // Terminal pins (owner, 6 Oct 2026): a production card takes ITS OWN pin
  // rows (lib/terminals.js) — the list's pins for its share by default, or what
  // design changed for this card — not the list's lines. The lines are still
  // settled for the card's share (qty_waived) so the list bookkeeping is right.
  // If the card has no rows, today's list share is taken as for any other part.
  let terminalsByRows = false;
  if (!fgOrder) {
    // Also when the list has no pin line at all: design may have put the
    // pins on the card itself, and those must leave stock too.
    const tpLines = lines.filter(l => isTerminalCategory(l.category));
    const r = await takeTerminalRows(tx, card, item, tpLines, orderCode, userId);
    if (r) { terminalsByRows = true; taken.push(...r.taken); }
  }

  let finsLines = false;
  // Finished goods: fins go by the tube length of the heaters in the store
  // (owner, 8 Oct 2026); when none is on record, the kg on the list as before.
  const fgLength = fgOrder && lines.some(l => FINS_CODES.includes(l.item_code)) ? await fgSourceLength(tx, card) : null;
  for (const line of lines) {
    if (fgOrder) {
      // Finished goods: only what is on its list that is fitted while preparing
      // it; the rest is inside the heater.
      if (!fgTakes(line.category)) continue;
      if (fgLength && FINS_CODES.includes(line.item_code)) { finsLines = true; continue; }   // by length, below
    } else {
      if (FINS_CODES.includes(line.item_code)) { finsLines = true; continue; } // by tube length, below
      if (terminalsByRows && isTerminalCategory(line.category)) continue;      // taken by the card's rows, above
      const st = stageOf(line.category);
      if (st && stageTicked[st]) continue;
    }
    // This card's share of the line, capped at what is left on it so the
    // line is never over-taken.
    const total = Number(line.qty) || 0;
    let share = itemQty > 0 ? (total * cardQty) / itemQty : total;
    share = isPieceUnit(line.unit) ? Math.round(share) : r4(share);
    const left = total - (Number(line.qty_deducted) || 0) - (Number(line.qty_waived) || 0);
    const ded = r4(Math.min(share, left));
    if (!(ded > 1e-4)) continue;   // rounding dust is not a take
    const noteParts = [`Order: ${orderCode}`];
    if (item.drawing_number) noteParts.push(`Dwg: ${item.drawing_number}`);
    noteParts.push(`Last stage (JC ${card.job_card_no})`);
    await deductLine(tx, line, ded, noteParts.join(' | '), userId, { jobCardId: card.id });
    taken.push({ inventory_item_id: line.inventory_item_id, item_code: line.item_code, qty: ded, unit: line.unit || '' });
  }

  // Fins by the job card's length, for the card's full quantity.
  if (finsLines) await deductFinsByLength(tx, card, userId, { qty: cardQty, length: fgLength });

  await stamp();
  return { taken };
}

// jc: a job_cards row (or anything with its id). A failure rolls the whole take
// back and throws; callers wrap it like the other takes so it never blocks
// saving a stage or a QC decision, and the next call simply tries again.
async function takeLastStage(db, jc, userId) {
  if (!jc?.id) return { taken: [] };
  if (typeof db.withTransaction === 'function') {
    return db.withTransaction(async (client) => {
      await client.query("SET LOCAL lock_timeout = '10s'");
      return runTake(clientDb(client), jc.id, userId);
    });
  }
  return runTake(db, jc.id, userId);
}

module.exports = { takeLastStage };
