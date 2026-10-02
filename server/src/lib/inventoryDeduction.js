// ── Inventory consumption for order items ──────────────────────────────────────
// The inventory an order item consumes (its BOM) is selected by design at
// drawing-upload time and stored in order_item_inventory. Deduction timing is
// split by inventory category:
//   • Stage 21 (Nipple Press) completes  → nipple categories deduct
//   • Stage 15 (Brazing)      completes  → flange + brazing categories deduct
//   • QC clearance (split-aware)         → everything still remaining deducts
// order_item_inventory.qty_deducted tracks how much of each BOM line has been
// consumed so far (stage triggers prorate by job-card qty / item qty), and
// order_items.inventory_deducted marks the item fully settled.
// order_item_inventory.qty_waived is what a record-only correction settled
// WITHOUT taking stock (stockLedger.js) — it counts as done, never as taken, so
// later stages and QC do not take it and a give-back never returns it.

const rework = require('./rework');
const { recordMove } = require('./stockLedger');

const STAGE_CATEGORY_MAP = {
  15: ['Flange', 'Flange Cap', 'Flange Spare', 'Brazing EQ'],
  21: ['Nipple Fastner', 'Nipple Washer', 'Nipple Nut+Washer'],
};
const STAGE_LABEL = { 15: 'Stage 15 Brazing', 21: 'Stage 21 Nipple Press' };

// A finished-goods order fits parts onto a heater that ALREADY EXISTS, so its
// BOM should only list what is genuinely put on during prep (nuts, washers,
// nipple fittings, sealing bushes…). These categories are consumed while the
// heater is BUILT — if one appears on an FG item's BOM, the full build BOM has
// probably been attached by mistake and the stock would come off twice.
// Deliberately a WARNING, not a block: the BOM is curated by design, and
// silently refusing to deduct a part that really was used would overstate stock.
// Finished-goods orders (owner, 2 Oct 2026): the heater comes off the
// finished-goods store already built, and goes into the store WITHOUT its nuts
// and washers. While preparing the order the team fits only these, so only
// these are taken from stock for a finished-goods order — fins by the kg typed
// on the list (there is no tube length to measure). Everything else on its list
// (terminal pins, end sealing bushes, nipples, …) is inside the heater already.
const FG_PREP_CATEGORIES = ['Wire', 'Lugs', 'Finns', 'Thermostat Spare', 'Nut', 'Washer',
  'Heavy Terminal Nut', 'Heavy Terminal Washer', 'Heavy Terminal Pin', 'Bracket'];
const fgTakes = (category) =>
  FG_PREP_CATEGORIES.some(c => c.toLowerCase() === String(category || '').trim().toLowerCase());

const BUILD_ONLY_CATEGORIES = [
  'Tube', 'Spring Guage', 'Finns', 'Flange', 'Flange Cap', 'Flange Spare',
  'Brazing EQ', 'Powder', 'Chemical Oil', 'Sealing Liquid', 'Wire', 'Lugs',
];
const buildOnlyOnFg = (category) =>
  BUILD_ONLY_CATEGORIES.some(c => c.toLowerCase() === String(category || '').trim().toLowerCase());

// Fins consume by tube length, not by BOM qty: each code has a known weight per
// 50.8 mm. At QC approval the card's stage-8 (Draw) Total Length gives the
// PER-PIECE weight — length_mm × (weight / 50.8) — which is multiplied by the
// QC-approved qty of that card (partial dispatches deduct only their share).
// These lines are excluded from the normal qty-based BOM deduction paths below.
const FINS_MM_BASE = 50.8;
const FINS_WEIGHT_PER_BASE = {
  'FIN-MS-08': 0.011,
  'FIN-MS-11': 0.019,
  'FIN-SS-08-VE': 0.014,
  'FIN-SS-11-VE': 0.020,
};
const FINS_CODES = Object.keys(FINS_WEIGHT_PER_BASE);

// The one place a BOM line leaves stock. A line may carry a rework portion
// (rework_qty): that part is taken from the item's rework bin first, and only
// the remainder from normal stock — so nothing is ever counted in both. If the
// bin turns out short, the rest comes from stock with a note and the line's
// rework portion shrinks to what was really taken, so no phantom reservation
// lingers. Production is never blocked here.
async function deductLine(db, sel, dedQty, note, userId) {
  const inv = await db.get('SELECT * FROM inventory_items WHERE id=$1', [sel.inventory_item_id]);
  if (!inv || !(dedQty > 0)) return;

  let fromRework = 0;
  const wantRework = Math.max(0, Number(sel.rework_qty || 0) - Number(sel.rework_deducted || 0));
  if (wantRework > 0) {
    const available = await rework.binQty(db, sel.inventory_item_id);
    fromRework = Math.min(dedQty, wantRework, available);
    if (fromRework > 0) {
      await rework.move(db, { itemId: sel.inventory_item_id, kind: 'draw', qty: fromRework,
        ref: await lineRef(db, sel), notes: note, userId });
      await db.run('UPDATE order_item_inventory SET rework_deducted = COALESCE(rework_deducted,0) + $1 WHERE id=$2',
        [fromRework, sel.id]);
    }
    const short = Math.min(dedQty, wantRework) - fromRework;
    if (short > 0) {
      // Bin short: the rest comes from stock, and the reservation is released.
      await db.run('UPDATE order_item_inventory SET rework_qty = COALESCE(rework_deducted,0) WHERE id=$1', [sel.id]);
      note = `${note} | rework bin short by ${short} — taken from stock`;
    }
  }

  const fromStock = dedQty - fromRework;
  if (fromStock > 0) {
    // Allow negative so shortages are visible. Atomic, so a correction or
    // another deduction running at the same moment cannot be overwritten.
    const newStock = Number((await db.get('UPDATE inventory_items SET current_stock = current_stock - $1 WHERE id=$2 RETURNING current_stock',
      [fromStock, sel.inventory_item_id])).current_stock);
    await recordMove(db, { itemId: sel.inventory_item_id, type: 'dispatch_to_production', qty: fromStock, balanceAfter: newStock,
      notes: fromRework > 0 ? `${note} | ${fromRework} from rework bin` : note, userId,
      orderItemId: sel.order_item_id || null, source: 'bom' });
  }
  await db.run('UPDATE order_item_inventory SET qty_deducted = COALESCE(qty_deducted,0) + $1 WHERE id=$2', [dedQty, sel.id]);
}

// Where a line's rework pieces went, for the bin's history.
async function lineRef(db, sel) {
  const r = await db.get(
    `SELECT oi.id AS order_item_id, oi.order_id, oi.drawing_number, o.order_code
       FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.id=$1`, [sel.order_item_id]);
  return r || { order_item_id: sel.order_item_id };
}

// Stage-triggered deduction: when a job card completes stage 15 or 21, deduct
// the mapped categories' BOM lines, prorated by the card's share of the item
// qty (e.g. 100 pcs BOM for 50 ordered → a 25-pc card deducts 50).
async function deductStageCategories(db, jc, stageNo, userId) {
  const cats = STAGE_CATEGORY_MAP[stageNo];
  if (!cats || !jc) return;
  const itemId = await resolveJobCardItemId(db, jc);
  if (!itemId) return;
  const item = await db.get('SELECT id, drawing_number, quantity, inventory_deducted FROM order_items WHERE id=$1', [itemId]);
  if (!item || item.inventory_deducted) return;
  const o = await db.get('SELECT order_code FROM orders WHERE id=$1', [jc.order_id]);
  const orderCode = o?.order_code || `Order #${jc.order_id}`;
  const ratio = Number(item.quantity) > 0 ? Math.min(1, (Number(jc.qty) || 0) / Number(item.quantity)) : 1;

  const sels = await db.all(
    `SELECT oii.*, TRIM(ii.category) AS category
     FROM order_item_inventory oii JOIN inventory_items ii ON ii.id = oii.inventory_item_id
     WHERE oii.order_item_id=$1 AND TRIM(ii.category) = ANY($2)`,
    [itemId, cats]
  );
  for (const sel of sels) {
    const total = parseFloat(sel.qty || 0);
    const already = parseFloat(sel.qty_deducted || 0) + parseFloat(sel.qty_waived || 0);
    const ded = Math.min(total * ratio, total - already);
    if (ded <= 1e-4) continue;     // rounding dust is not a take
    const noteParts = [`Order: ${orderCode}`];
    if (item.drawing_number) noteParts.push(`Dwg: ${item.drawing_number}`);
    noteParts.push(`${STAGE_LABEL[stageNo]} (JC ${jc.job_card_no})`);
    await deductLine(db, sel, ded, noteParts.join(' | '), userId);
  }
}

// Partial-dispatch deduction at QC approval: when an item is split into multiple
// job cards, each card's QC approval deducts the NON-stage-timed BOM lines at the
// ratio of the QC-approved qty (dispatch + FG) to the item qty. Stage-timed
// categories are left alone — their card share went out at stage 15/21, and any
// remainder (e.g. skipped optional stage) is swept up by the final settle.
async function deductPartialAtQC(db, jc, userId) {
  if (!jc) return;
  const itemId = await resolveJobCardItemId(db, jc);
  if (!itemId) return;
  const item = await db.get(
    `SELECT oi.id, oi.drawing_number, oi.quantity, oi.inventory_deducted, o.order_type
       FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.id=$1`, [itemId]);
  if (!item || item.inventory_deducted) return;
  const fgOrder = item.order_type === 'finished_goods';
  const cardCount = await db.get('SELECT COUNT(*) AS n FROM job_cards WHERE order_item_id=$1', [itemId]);
  if (parseInt(cardCount.n, 10) <= 1) return; // single card → full settle handles it

  const fresh = await db.get('SELECT * FROM job_cards WHERE id=$1', [jc.id]); // qc_* qtys were just written
  const approvedQty = (Number(fresh?.qc_dispatch_qty) || 0) + (Number(fresh?.qc_fg_qty) || 0);
  // Only a real approval consumes material. QC rejection returns work to stage
  // 29 and settles from there, at which point the qc_* quantities are unset —
  // falling back to the card quantity took half the BOM out of stock for pieces
  // that were sitting rejected on the floor.
  if (fresh?.status !== 'qc_approved' || !(approvedQty > 0)) return;
  const ratio = Number(item.quantity) > 0 ? Math.min(1, approvedQty / Number(item.quantity)) : 0;
  if (ratio <= 0) return;

  const stageCats = Object.values(STAGE_CATEGORY_MAP).flat();
  const o = await db.get('SELECT order_code FROM orders WHERE id=$1', [jc.order_id]);
  const orderCode = o?.order_code || `Order #${jc.order_id}`;
  const sels = (fgOrder
    ? (await db.all(
      `SELECT oii.*, TRIM(ii.category) AS category FROM order_item_inventory oii JOIN inventory_items ii ON ii.id = oii.inventory_item_id
        WHERE oii.order_item_id=$1`, [itemId])).filter(l => fgTakes(l.category))
    : await db.all(
      `SELECT oii.* FROM order_item_inventory oii JOIN inventory_items ii ON ii.id = oii.inventory_item_id
       WHERE oii.order_item_id=$1 AND (ii.category IS NULL OR TRIM(ii.category) <> ALL($2))
         AND ii.item_code <> ALL($3)`,
      [itemId, stageCats, FINS_CODES]
    ));
  for (const sel of sels) {
    const total = parseFloat(sel.qty || 0);
    const already = parseFloat(sel.qty_deducted || 0) + parseFloat(sel.qty_waived || 0);
    const ded = Math.min(total * ratio, total - already);
    if (ded <= 1e-4) continue;     // rounding dust is not a take
    const noteParts = [`Order: ${orderCode}`];
    if (item.drawing_number) noteParts.push(`Dwg: ${item.drawing_number}`);
    noteParts.push(`Partial dispatch QC-approved (JC ${jc.job_card_no})`);
    await deductLine(db, sel, ded, noteParts.join(' | '), userId);
  }
}

// Fins by tube length: at QC approval, each fins BOM line deducts kgs computed
// from THIS card's stage-8 (Draw) Total Length — not the BOM qty.
async function deductFinsByLength(db, jc, userId) {
  if (!jc || jc.is_fg) return; // FG inventory cards have no Draw stage
  // Once per card. Nothing used to stop this running again on a second QC
  // cycle, and a rejection that returns work to stage 29 settles too — so a
  // card could draw fin strip several times over, uncapped, including for
  // pieces that were rejected.
  const guard = await db.get('SELECT fins_deducted, status, qc_dispatch_qty, qc_fg_qty FROM job_cards WHERE id=$1', [jc.id]);
  if (guard?.fins_deducted) return;
  const approved = (Number(guard?.qc_dispatch_qty) || 0) + (Number(guard?.qc_fg_qty) || 0);
  if (guard?.status !== 'qc_approved' || !(approved > 0)) return;
  const itemId = await resolveJobCardItemId(db, jc);
  if (!itemId) return;
  const item = await db.get('SELECT id, drawing_number, inventory_deducted FROM order_items WHERE id=$1', [itemId]);
  if (!item || item.inventory_deducted) return;

  const sels = await db.all(
    `SELECT oii.*, ii.item_code FROM order_item_inventory oii
     JOIN inventory_items ii ON ii.id = oii.inventory_item_id
     WHERE oii.order_item_id=$1 AND ii.item_code = ANY($2)`,
    [itemId, FINS_CODES]
  );
  if (!sels.length) return;

  const s8 = await db.get(
    'SELECT value1 FROM production_checklist WHERE job_card_id=$1 AND stage_no=8', [jc.id]
  );
  // Workers may record several readings in one field ("1610-1625", "1610+1620"):
  // deduct on the AVERAGE of every number found. (Stripping all non-digits once
  // mashed a range into 16,101,625mm and drew 163,868kg of fins.) The >20m guard
  // below stays as a second net against implausible entries.
  const s8nums = (String(s8?.value1 || '').match(/\d+(?:\.\d+)?/g) || []).map(Number);
  const lengthMm = s8nums.length ? s8nums.reduce((a, b) => a + b, 0) / s8nums.length : NaN;
  if (!(lengthMm > 0)) {
    console.warn(`[fins] JC ${jc.job_card_no}: no stage-8 Total Length — fins not deducted`);
    return;
  }
  if (lengthMm > 20000) {
    console.warn(`[fins] JC ${jc.job_card_no}: stage-8 length ${lengthMm}mm implausible (>20m) — fins not deducted, fix the stage value`);
    return;
  }

  // Per-piece weight × QC-approved qty of THIS card (dispatch + FG). A partial
  // dispatch therefore deducts fins only for the pieces actually approved.
  const pcs = approved;

  const o = await db.get('SELECT order_code FROM orders WHERE id=$1', [jc.order_id]);
  const orderCode = o?.order_code || `Order #${jc.order_id}`;
  let totalKg = 0;
  for (const sel of sels) {
    const perBase = FINS_WEIGHT_PER_BASE[sel.item_code];
    const kgs = Math.round((lengthMm / FINS_MM_BASE) * perBase * pcs * 1000) / 1000;
    if (!(kgs > 0)) continue;
    const noteParts = [`Order: ${orderCode}`];
    if (item.drawing_number) noteParts.push(`Dwg: ${item.drawing_number}`);
    noteParts.push(`Fins by tube length: ${lengthMm}mm × ${perBase}kg/${FINS_MM_BASE}mm × ${pcs} pcs = ${kgs}kg (JC ${jc.job_card_no})`);
    await deductLine(db, sel, kgs, noteParts.join(' | '), userId);
    totalKg += kgs;
  }
  await db.run('UPDATE job_cards SET fins_deducted=TRUE, fins_kg=$1 WHERE id=$2', [totalKg, jc.id]);
}

// QC-time deduction: everything not already consumed by a stage trigger.
// Fins lines are excluded — they deduct by tube length (deductFinsByLength).
//
// FINISHED-GOODS cards are different: the heater already exists and its parts
// were consumed when it was BUILT (on the inventory order). Only the fittings
// genuinely put on again while preparing it for dispatch may be consumed a
// second time — nuts and washers. Anything else on an FG item's BOM is already
// in the heater, so deducting it would take the same part out of stock twice.
async function deductItemInventory(db, itemId, orderCode, userId, reasonNote = 'Consumed for production') {
  const item = await db.get(
    `SELECT oi.id, oi.drawing_number, oi.inventory_deducted, o.order_type
       FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.id=$1`, [itemId]);
  if (!item || item.inventory_deducted) return; // never double-deduct
  const fgOrder = item.order_type === 'finished_goods';
  const sels = await db.all(
    `SELECT oii.*, ii.item_code, TRIM(ii.category) AS category FROM order_item_inventory oii
     JOIN inventory_items ii ON ii.id = oii.inventory_item_id
     WHERE oii.order_item_id=$1`, [itemId]
  );
  for (const sel of sels) {
    if (fgOrder && !fgTakes(sel.category)) {
      // Inside the heater already: settled without taking stock.
      const rest = parseFloat(sel.qty || 0) - parseFloat(sel.qty_deducted || 0) - parseFloat(sel.qty_waived || 0);
      if (rest > 1e-4) await db.run('UPDATE order_item_inventory SET qty_waived = COALESCE(qty_waived,0) + $1 WHERE id=$2', [rest, sel.id]);
      continue;
    }
    if (!fgOrder && FINS_CODES.includes(sel.item_code)) continue; // length-based, handled separately
    const remaining = parseFloat(sel.qty || 0) - parseFloat(sel.qty_deducted || 0) - parseFloat(sel.qty_waived || 0);
    if (remaining <= 1e-4) continue; // rounding dust is not a take
    const noteParts = [`Order: ${orderCode}`];
    if (item.drawing_number) noteParts.push(`Dwg: ${item.drawing_number}`);
    noteParts.push(reasonNote);
    await deductLine(db, sel, remaining, noteParts.join(' | '), userId);
  }
  if (sels.length) await db.run('UPDATE order_items SET inventory_deducted=TRUE WHERE id=$1', [itemId]);
}

// Pieces recovered at QC go into the part's rework bin. Idempotent per card:
// a second call for the same card deposits nothing, so a card can never
// deposit twice however many times the approval path runs.
async function applyReworkDeposit(db, jc, items, userId) {
  if (!Array.isArray(items) || !items.length) return;
  const done = await db.get(`SELECT 1 AS x FROM inventory_rework_moves WHERE job_card_id=$1 AND kind='deposit' LIMIT 1`, [jc.id]);
  if (done) return;
  const o = await db.get('SELECT order_code FROM orders WHERE id=$1', [jc.order_id]);
  const itemId = await resolveJobCardItemId(db, jc);
  const item = itemId ? await db.get('SELECT drawing_number FROM order_items WHERE id=$1', [itemId]) : null;
  for (const it of items) {
    const qty = Number(it?.qty), invId = parseInt(it?.inventory_item_id, 10);
    if (!(qty > 0) || !invId) continue;
    await rework.move(db, { itemId: invId, kind: 'deposit', qty,
      ref: { order_id: jc.order_id, order_item_id: itemId, job_card_id: jc.id, order_code: o?.order_code,
             job_card_no: jc.job_card_no, drawing_number: item?.drawing_number },
      notes: `Recovered at QC approval of ${jc.job_card_no}`, userId });
  }
}

// Owner reversed an approval: the pieces that card deposited come back out.
// Refused (throws) if another order has already claimed or drawn them.
async function reverseReworkDeposit(db, jc, userId) {
  const deps = await db.all(
    `SELECT item_id, SUM(qty) AS q FROM inventory_rework_moves WHERE job_card_id=$1 AND kind='deposit' GROUP BY item_id`, [jc.id]);
  const back = await db.all(
    `SELECT item_id, SUM(qty) AS q FROM inventory_rework_moves WHERE job_card_id=$1 AND kind='reversal' GROUP BY item_id`, [jc.id]);
  const already = Object.fromEntries(back.map(b => [b.item_id, Number(b.q)]));
  for (const d of deps) {
    const qty = Number(d.q) - (already[d.item_id] || 0);
    if (!(qty > 0)) continue;
    const free = await rework.freeQty(db, d.item_id);
    if (free + 1e-9 < qty) {
      const inv = await db.get('SELECT item_code FROM inventory_items WHERE id=$1', [d.item_id]);
      throw new Error(`Cannot reverse: ${qty} ${inv?.item_code || ''} from this card's rework deposit are already claimed by another order (${free} free).`);
    }
    await rework.move(db, { itemId: d.item_id, kind: 'reversal', qty,
      ref: { order_id: jc.order_id, job_card_id: jc.id, job_card_no: jc.job_card_no },
      notes: `QC approval of ${jc.job_card_no} reversed`, userId });
  }
}

// Extra consumption entered by QC for remade pieces — deducts immediately.
async function applyRemakeExtras(db, jc, extras, userId) {
  if (!Array.isArray(extras) || !extras.length) return;
  const o = await db.get('SELECT order_code FROM orders WHERE id=$1', [jc.order_id]);
  const orderCode = o?.order_code || `Order #${jc.order_id}`;
  for (const ex of extras) {
    const qty = parseFloat(ex?.qty);
    const invId = parseInt(ex?.inventory_item_id, 10);
    if (!(qty > 0) || !invId) continue;
    const inv = await db.get('SELECT * FROM inventory_items WHERE id=$1', [invId]);
    if (!inv) continue;
    const newStock = Number((await db.get('UPDATE inventory_items SET current_stock = current_stock - $1 WHERE id=$2 RETURNING current_stock',
      [qty, invId])).current_stock);
    await recordMove(db, { itemId: invId, type: 'dispatch_to_production', qty, balanceAfter: newStock,
      notes: `Order: ${orderCode} | Extra consumption for remade qty (QC approval, JC ${jc.job_card_no})`, userId,
      orderItemId: await resolveJobCardItemId(db, jc), source: 'remake' });
  }
}

async function restoreItemInventory(db, itemId, orderCode, userId, reasonNote) {
  const item = await db.get('SELECT id, inventory_deducted FROM order_items WHERE id=$1', [itemId]);
  if (!item) return;
  const sels = await db.all('SELECT * FROM order_item_inventory WHERE order_item_id=$1', [itemId]);
  for (const sel of sels) {
    const deducted = parseFloat(sel.qty_deducted || 0); // restore only what actually went out
    if (deducted <= 0) continue;
    // The rework portion goes back to the bin (re-creating it if it had been
    // deleted at zero); only the stock portion returns to stock.
    const rw = Math.min(deducted, parseFloat(sel.rework_deducted || 0));
    if (rw > 0) {
      await rework.move(db, { itemId: sel.inventory_item_id, kind: 'return', qty: rw,
        ref: await lineRef(db, sel), notes: `${reasonNote} — ${orderCode}`, userId });
    }
    const toStock = deducted - rw;
    if (toStock > 0) {
      const inv = await db.get('SELECT * FROM inventory_items WHERE id=$1', [sel.inventory_item_id]);
      if (inv) {
        const newStock = Number((await db.get('UPDATE inventory_items SET current_stock = current_stock + $1 WHERE id=$2 RETURNING current_stock',
          [toStock, sel.inventory_item_id])).current_stock);
        await recordMove(db, { itemId: sel.inventory_item_id, type: 'return_from_production', qty: toStock, balanceAfter: newStock,
          notes: `${reasonNote} — ${orderCode}`, userId, orderItemId: itemId, source: 'bom' });
      }
    }
    await db.run('UPDATE order_item_inventory SET qty_deducted = 0, rework_deducted = 0 WHERE id=$1', [sel.id]);
  }
  await db.run('UPDATE order_items SET inventory_deducted=FALSE WHERE id=$1', [itemId]);
}

// Rebuild an item's deductions against its CURRENT BOM, to the exact progress
// its cards have actually made. Used after the BOM is edited mid-run: the
// caller restores everything first (so qty_deducted is zero across the board),
// swaps the lines, then calls this to re-take what production has genuinely
// consumed so far.
//
// It works because each deduction path caps itself at `total - already`, so
// replaying a stage that has been reached takes exactly that stage's share of
// the new BOM and nothing more.
async function replayDeductions(db, itemId, orderCode, userId) {
  const cards = await db.all('SELECT * FROM job_cards WHERE order_item_id=$1 ORDER BY id', [itemId]);
  for (const jc of cards) {
    const done = await db.all(
      'SELECT stage_no FROM production_checklist WHERE job_card_id=$1 AND done=1 AND stage_no = ANY($2)',
      [jc.id, Object.keys(STAGE_CATEGORY_MAP).map(Number)]);
    for (const { stage_no } of done) await deductStageCategories(db, jc, Number(stage_no), userId);

    if (jc.status === 'qc_approved') {
      // Fins were restored with everything else, so let them re-take too.
      await db.run('UPDATE job_cards SET fins_deducted=FALSE WHERE id=$1', [jc.id]);
      await deductFinsByLength(db, jc, userId);
      await deductPartialAtQC(db, jc, userId);
    }
  }
  // If every card is finished the item settles in full, exactly as it would
  // have done on its own.
  await settleItemInventory(db, itemId, userId, orderCode);
}

// Resolve which order item a job card belongs to. Job cards carry order_item_id
// going forward; fall back to matching the drawing number within the order for
// legacy cards created before that link existed.
async function resolveJobCardItemId(db, jc) {
  if (jc && jc.order_item_id) return jc.order_item_id;
  if (jc && jc.drawing_no && jc.order_id) {
    const it = await db.get(
      'SELECT id FROM order_items WHERE order_id=$1 AND drawing_number=$2 ORDER BY id LIMIT 1',
      [jc.order_id, jc.drawing_no]
    );
    if (it) return it.id;
  }
  return null;
}

// Split-aware deduction. Call this whenever a job card for the item is QC-approved
// or dispatched — it figures out whether the item is now fully consumed:
//   • Single job card  → deduct as soon as it is QC-approved (or beyond).
//   • Multiple job cards (partial-dispatch split) → deduct only once EVERY card is
//     settled, i.e. dispatched OR QC-approved entirely into Finished Goods with
//     nothing left to dispatch. Finished Goods counts as "done".
// Idempotent — the inventory_deducted flag prevents a second deduction.
async function settleItemInventory(db, orderItemId, userId, orderCode) {
  if (!orderItemId) return;
  const item = await db.get('SELECT id, inventory_deducted FROM order_items WHERE id=$1', [orderItemId]);
  if (!item || item.inventory_deducted) return;

  const cards = await db.all(
    'SELECT status, qc_dispatch_qty FROM job_cards WHERE order_item_id=$1', [orderItemId]
  );
  if (!cards.length) return;

  const settled = (c) =>
    c.status === 'dispatched' ||
    (c.status === 'qc_approved' && (Number(c.qc_dispatch_qty) || 0) === 0);

  const ready = cards.length === 1
    ? ['qc_approved', 'dispatched', 'completed'].includes(cards[0].status)
    : cards.every(settled);

  if (ready) await deductItemInventory(db, orderItemId, orderCode, userId, 'Consumed (QC/dispatch)');
}

module.exports = { STAGE_CATEGORY_MAP, FG_PREP_CATEGORIES, fgTakes, buildOnlyOnFg, BUILD_ONLY_CATEGORIES, deductItemInventory, restoreItemInventory, resolveJobCardItemId, settleItemInventory, deductStageCategories, applyRemakeExtras, applyReworkDeposit, reverseReworkDeposit, deductPartialAtQC, deductFinsByLength, replayDeductions, FINS_CODES };
