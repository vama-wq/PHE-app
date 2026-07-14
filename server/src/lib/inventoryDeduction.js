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

const STAGE_CATEGORY_MAP = {
  15: ['Flange', 'Flange Cap', 'Flange Spare', 'Brazing EQ'],
  21: ['Nipple Fastner', 'Nipple Washer', 'Nipple Nut+Washer'],
};
const STAGE_LABEL = { 15: 'Stage 15 Brazing', 21: 'Stage 21 Nipple Press' };

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

async function deductLine(db, sel, dedQty, note, userId) {
  const inv = await db.get('SELECT * FROM inventory_items WHERE id=$1', [sel.inventory_item_id]);
  if (!inv || !(dedQty > 0)) return;
  const newStock = (inv.current_stock || 0) - dedQty; // allow negative so shortages are visible
  await db.run('UPDATE inventory_items SET current_stock=$1 WHERE id=$2', [newStock, sel.inventory_item_id]);
  await db.run('UPDATE order_item_inventory SET qty_deducted = COALESCE(qty_deducted,0) + $1 WHERE id=$2', [dedQty, sel.id]);
  await db.insert(
    `INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by)
     VALUES ($1,'dispatch_to_production',$2,$3,$4,$5)`,
    [sel.inventory_item_id, dedQty, newStock, note, userId]
  );
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
    const already = parseFloat(sel.qty_deducted || 0);
    const ded = Math.min(total * ratio, total - already);
    if (ded <= 0) continue;
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
  const item = await db.get('SELECT id, drawing_number, quantity, inventory_deducted FROM order_items WHERE id=$1', [itemId]);
  if (!item || item.inventory_deducted) return;
  const cardCount = await db.get('SELECT COUNT(*) AS n FROM job_cards WHERE order_item_id=$1', [itemId]);
  if (parseInt(cardCount.n, 10) <= 1) return; // single card → full settle handles it

  const fresh = await db.get('SELECT * FROM job_cards WHERE id=$1', [jc.id]); // qc_* qtys were just written
  const approvedQty = (Number(fresh?.qc_dispatch_qty) || 0) + (Number(fresh?.qc_fg_qty) || 0);
  const baseQty = approvedQty > 0 ? approvedQty : (Number(jc.qty) || 0);
  const ratio = Number(item.quantity) > 0 ? Math.min(1, baseQty / Number(item.quantity)) : 0;
  if (ratio <= 0) return;

  const stageCats = Object.values(STAGE_CATEGORY_MAP).flat();
  const o = await db.get('SELECT order_code FROM orders WHERE id=$1', [jc.order_id]);
  const orderCode = o?.order_code || `Order #${jc.order_id}`;
  const sels = await db.all(
    `SELECT oii.* FROM order_item_inventory oii JOIN inventory_items ii ON ii.id = oii.inventory_item_id
     WHERE oii.order_item_id=$1 AND (ii.category IS NULL OR TRIM(ii.category) <> ALL($2))
       AND ii.item_code <> ALL($3)`,
    [itemId, stageCats, FINS_CODES]
  );
  for (const sel of sels) {
    const total = parseFloat(sel.qty || 0);
    const already = parseFloat(sel.qty_deducted || 0);
    const ded = Math.min(total * ratio, total - already);
    if (ded <= 0) continue;
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
  const lengthMm = parseFloat(String(s8?.value1 || '').replace(/[^\d.]/g, ''));
  if (!(lengthMm > 0)) {
    console.warn(`[fins] JC ${jc.job_card_no}: no stage-8 Total Length — fins not deducted`);
    return;
  }

  // Per-piece weight × QC-approved qty of THIS card (dispatch + FG). A partial
  // dispatch therefore deducts fins only for the pieces actually approved.
  const fresh = await db.get('SELECT qc_dispatch_qty, qc_fg_qty, qty FROM job_cards WHERE id=$1', [jc.id]);
  const approvedQty = (Number(fresh?.qc_dispatch_qty) || 0) + (Number(fresh?.qc_fg_qty) || 0);
  const pcs = approvedQty > 0 ? approvedQty : (Number(fresh?.qty) || 0);
  if (!(pcs > 0)) return;

  const o = await db.get('SELECT order_code FROM orders WHERE id=$1', [jc.order_id]);
  const orderCode = o?.order_code || `Order #${jc.order_id}`;
  for (const sel of sels) {
    const perBase = FINS_WEIGHT_PER_BASE[sel.item_code];
    const kgs = Math.round((lengthMm / FINS_MM_BASE) * perBase * pcs * 1000) / 1000;
    if (!(kgs > 0)) continue;
    const noteParts = [`Order: ${orderCode}`];
    if (item.drawing_number) noteParts.push(`Dwg: ${item.drawing_number}`);
    noteParts.push(`Fins by tube length: ${lengthMm}mm × ${perBase}kg/${FINS_MM_BASE}mm × ${pcs} pcs = ${kgs}kg (JC ${jc.job_card_no})`);
    await deductLine(db, sel, kgs, noteParts.join(' | '), userId);
  }
}

// QC-time deduction: everything not already consumed by a stage trigger.
// Fins lines are excluded — they deduct by tube length (deductFinsByLength).
async function deductItemInventory(db, itemId, orderCode, userId, reasonNote = 'Consumed for production') {
  const item = await db.get('SELECT id, drawing_number, inventory_deducted FROM order_items WHERE id=$1', [itemId]);
  if (!item || item.inventory_deducted) return; // never double-deduct
  const sels = await db.all(
    `SELECT oii.*, ii.item_code FROM order_item_inventory oii
     JOIN inventory_items ii ON ii.id = oii.inventory_item_id
     WHERE oii.order_item_id=$1`, [itemId]
  );
  for (const sel of sels) {
    if (FINS_CODES.includes(sel.item_code)) continue; // length-based, handled separately
    const remaining = parseFloat(sel.qty || 0) - parseFloat(sel.qty_deducted || 0);
    if (remaining <= 0) continue;
    const noteParts = [`Order: ${orderCode}`];
    if (item.drawing_number) noteParts.push(`Dwg: ${item.drawing_number}`);
    noteParts.push(reasonNote);
    await deductLine(db, sel, remaining, noteParts.join(' | '), userId);
  }
  if (sels.length) await db.run('UPDATE order_items SET inventory_deducted=TRUE WHERE id=$1', [itemId]);
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
    const newStock = (inv.current_stock || 0) - qty;
    await db.run('UPDATE inventory_items SET current_stock=$1 WHERE id=$2', [newStock, invId]);
    await db.insert(
      `INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by)
       VALUES ($1,'dispatch_to_production',$2,$3,$4,$5)`,
      [invId, qty, newStock, `Order: ${orderCode} | Extra consumption for remade qty (QC approval, JC ${jc.job_card_no})`, userId]
    );
  }
}

async function restoreItemInventory(db, itemId, orderCode, userId, reasonNote) {
  const item = await db.get('SELECT id, inventory_deducted FROM order_items WHERE id=$1', [itemId]);
  if (!item) return;
  const sels = await db.all('SELECT * FROM order_item_inventory WHERE order_item_id=$1', [itemId]);
  for (const sel of sels) {
    const deducted = parseFloat(sel.qty_deducted || 0); // restore only what actually went out
    if (deducted <= 0) continue;
    const inv = await db.get('SELECT * FROM inventory_items WHERE id=$1', [sel.inventory_item_id]);
    if (!inv) continue;
    const newStock = (inv.current_stock || 0) + deducted;
    await db.run('UPDATE inventory_items SET current_stock=$1 WHERE id=$2', [newStock, sel.inventory_item_id]);
    await db.run('UPDATE order_item_inventory SET qty_deducted = 0 WHERE id=$1', [sel.id]);
    await db.insert(
      `INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by)
       VALUES ($1,'return_from_production',$2,$3,$4,$5)`,
      [sel.inventory_item_id, deducted, newStock, `${reasonNote} — ${orderCode}`, userId]
    );
  }
  await db.run('UPDATE order_items SET inventory_deducted=FALSE WHERE id=$1', [itemId]);
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

module.exports = { deductItemInventory, restoreItemInventory, resolveJobCardItemId, settleItemInventory, deductStageCategories, applyRemakeExtras, deductPartialAtQC, deductFinsByLength };
