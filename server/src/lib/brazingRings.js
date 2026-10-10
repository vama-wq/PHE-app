// ── Brazing rings from the job card (owner, 10 Oct 2026) ──────────────────────
// "Any job card that has 3in1 or 2in1 or Xin1 also uses brazing rings — 8 mm
// uses 8 mm rings and 11 mm uses 11 mm rings — 6 for a 3in1, 4 for a 2in1 and
// so on — deduct them automatically when stage Brazing is cleared, that much
// qty only, on those items."
//   • A heater of 2 or more elements takes 2 rings per element: card qty ×
//     elements × 2, BRZ-08 on an 8 mm tube, BRZ-11 on an 11 mm tube.
//   • Taken when Stage 15 (Brazing) is ticked; unticking gives exactly that back,
//     ticking again takes it again (job_cards.rings_taken_at / rings_taken).
//   • The item's list ring lines (BRZ-08 / BRZ-11) are not taken for such a
//     card — the card's count replaces them; its share of them is settled
//     without stock. Brazing rod, flux and flanges stay on the list as before.
//   • Single-element heaters: nothing here; their list works as before.
//   • From now on only: a card whose Stage 15 already took rings off its list
//     keeps that and takes nothing more here.
const { recordMove } = require('./stockLedger');

const RING_CODES = { 8: 'BRZ-08', 11: 'BRZ-11' };
const RINGS_PER_ELEMENT = 2;
const isRingCode = (code) => Object.values(RING_CODES).includes(String(code || '').trim().toUpperCase());

// "3in1", "3 in 1", "3IN1" in a drawing or card number.
function elementsFromName(...names) {
  for (const n of names) {
    const m = String(n || '').match(/(\d+)\s*in\s*1(?![0-9])/i);
    if (m && parseInt(m[1], 10) > 0) return parseInt(m[1], 10);
  }
  return null;
}

// What this card's brazing takes: { inv, qty, elements, dia } or null when the
// heater is single-element, its tube is neither 8 nor 11 mm, or the card took
// rings off its list at Stage 15 before this rule.
async function ringPlan(db, card) {
  if (!card || card.is_fg) return null;
  const { specForCard } = require('./cardSpec');
  let spec = await specForCard(db, card);
  try { spec = typeof spec === 'string' ? JSON.parse(spec) : spec; } catch { spec = null; }
  const item = card.order_item_id
    ? await db.get('SELECT id, drawing_number, tube_diameter, quantity FROM order_items WHERE id=$1', [card.order_item_id]) : null;
  let elements = parseInt(spec?.computed?.elements, 10) || null;
  if (!(elements > 1)) elements = elementsFromName(item?.drawing_number, card.drawing_no, card.job_card_no) || elements || 1;
  if (!(elements > 1)) return null;
  const dia = Number(spec?.input?.tubeDiameterMm) || Number(String(item?.tube_diameter || '').match(/\d+/)?.[0]) || null;
  const code = RING_CODES[dia];
  if (!code) return null;
  const inv = await db.get('SELECT id, item_code, unit FROM inventory_items WHERE UPPER(TRIM(item_code))=$1', [code]);
  if (!inv) return null;
  // Before this rule: rings already taken off the list at this card's Stage 15.
  const ringIds = (await db.all(`SELECT id FROM inventory_items WHERE UPPER(TRIM(item_code)) = ANY($1)`, [Object.values(RING_CODES)])).map(r => r.id);
  const legacy = await db.get(
    `SELECT 1 AS x FROM inventory_transactions WHERE item_id = ANY($1) AND strpos(notes, $2) > 0
        AND COALESCE(source,'') <> 'brazing' LIMIT 1`,
    [ringIds, `Stage 15 Brazing (JC ${card.job_card_no})`]);
  if (legacy) return null;
  const qty = (Number(card.qty) || 0) * elements * RINGS_PER_ELEMENT;
  if (!(qty > 0)) return null;
  return { inv, qty, elements, dia, item };
}

const txDb = (client) => ({
  get: async (sql, params = []) => (await client.query(sql, params)).rows[0] || null,
  all: async (sql, params = []) => (await client.query(sql, params)).rows,
  run: (sql, params = []) => client.query(sql, params),
  insert: async (sql, params = []) => {
    const { rows } = await client.query(sql.trimEnd().replace(/;?\s*$/, '') + ' RETURNING id', params);
    return { lastInsertRowid: rows[0]?.id || null };
  },
});
const inTx = (db, fn) => (typeof db.withTransaction === 'function'
  ? db.withTransaction(async (client) => fn(txDb(client), client)) : fn(db, null));

// Stage 15 ticked.
async function takeRingsAtBrazing(db, jobCardId, userId) {
  return inTx(db, async (tx) => {
    const card = await tx.get(
      `SELECT jc.*, o.order_code FROM job_cards jc JOIN orders o ON o.id = jc.order_id WHERE jc.id=$1 FOR UPDATE OF jc`, [jobCardId]);
    if (!card || card.is_fg || card.rings_taken_at || card.inventory_qc_at) return null;
    const plan = await ringPlan(tx, card);
    if (!plan) return null;
    if (plan.item) {
      const it = await tx.get('SELECT inventory_deducted FROM order_items WHERE id=$1', [plan.item.id]);
      if (it?.inventory_deducted) return null;
    }
    const after = Number((await tx.get(
      'UPDATE inventory_items SET current_stock = current_stock - $1 WHERE id=$2 RETURNING current_stock', [plan.qty, plan.inv.id])).current_stock);
    const note = `Order: ${card.order_code}${plan.item?.drawing_number ? ` | Dwg: ${plan.item.drawing_number}` : ''} | Brazing rings ${plan.qty} pcs (${card.qty} × ${plan.elements} elements × ${RINGS_PER_ELEMENT}, ${plan.dia} mm) | Stage 15 Brazing (JC ${card.job_card_no})`;
    await recordMove(tx, { itemId: plan.inv.id, type: 'dispatch_to_production', qty: plan.qty, balanceAfter: after,
      notes: note, userId, orderItemId: plan.item?.id || null, source: 'brazing', jobCardId: card.id });
    // The list's ring lines: this card's share settled without stock.
    const waived = [];
    if (plan.item) {
      const lines = await tx.all(
        `SELECT oii.id, oii.qty::float AS qty, COALESCE(oii.qty_deducted,0)::float AS d, COALESCE(oii.qty_waived,0)::float AS w
           FROM order_item_inventory oii JOIN inventory_items ii ON ii.id = oii.inventory_item_id
          WHERE oii.order_item_id=$1 AND UPPER(TRIM(ii.item_code)) = ANY($2)`, [plan.item.id, Object.values(RING_CODES)]);
      const itemQty = Number(plan.item.quantity) || 0;
      for (const l of lines) {
        const share = itemQty > 0 ? Math.round((l.qty * (Number(card.qty) || 0)) / itemQty) : l.qty;
        const w = Math.min(share, Math.max(0, l.qty - l.d - l.w));
        if (w > 0) {
          await tx.run('UPDATE order_item_inventory SET qty_waived = COALESCE(qty_waived,0) + $1 WHERE id=$2', [w, l.id]);
          waived.push({ line_id: l.id, qty: w });
        }
      }
    }
    const rec = { item_id: plan.inv.id, item_code: plan.inv.item_code, qty: plan.qty, elements: plan.elements, waived };
    await tx.run('UPDATE job_cards SET rings_taken_at = NOW(), rings_taken = $2 WHERE id=$1', [card.id, JSON.stringify(rec)]);
    await tx.run(`INSERT INTO activity_log (order_id, job_card_id, activity_type, description, created_by) VALUES ($1,$2,'rings_taken',$3,$4)`,
      [card.order_id, card.id, `Brazing ticked: ${plan.qty} × ${plan.inv.item_code} taken for ${card.job_card_no} (${card.qty} × ${plan.elements} elements × ${RINGS_PER_ELEMENT})`, userId || null]);
    return rec;
  });
}

// Stage 15 unticked: exactly what the tick took goes back.
async function giveRingsBack(db, jobCardId, userId) {
  return inTx(db, async (tx) => {
    const card = await tx.get(
      `SELECT jc.*, o.order_code FROM job_cards jc JOIN orders o ON o.id = jc.order_id WHERE jc.id=$1 FOR UPDATE OF jc`, [jobCardId]);
    if (!card || !card.rings_taken_at || card.inventory_qc_at) return null;
    let rec = card.rings_taken;
    try { rec = typeof rec === 'string' ? JSON.parse(rec) : rec; } catch { rec = null; }
    if (!rec?.item_id || !(Number(rec.qty) > 0)) return null;
    const after = Number((await tx.get(
      'UPDATE inventory_items SET current_stock = current_stock + $1 WHERE id=$2 RETURNING current_stock', [rec.qty, rec.item_id])).current_stock);
    await recordMove(tx, { itemId: rec.item_id, type: 'return_from_production', qty: rec.qty, balanceAfter: after,
      notes: `Order: ${card.order_code} | Brazing undone — rings back (JC ${card.job_card_no})`, userId,
      orderItemId: card.order_item_id || null, source: 'brazing', jobCardId: card.id });
    for (const w of rec.waived || []) {
      await tx.run('UPDATE order_item_inventory SET qty_waived = GREATEST(0, COALESCE(qty_waived,0) - $1) WHERE id=$2', [w.qty, w.line_id]);
    }
    await tx.run('UPDATE job_cards SET rings_taken_at = NULL, rings_taken = NULL WHERE id=$1', [card.id]);
    await tx.run(`INSERT INTO activity_log (order_id, job_card_id, activity_type, description, created_by) VALUES ($1,$2,'rings_returned',$3,$4)`,
      [card.order_id, card.id, `Brazing unticked: ${rec.qty} × ${rec.item_code} given back for ${card.job_card_no}`, userId || null]);
    return rec;
  });
}

module.exports = { RING_CODES, RINGS_PER_ELEMENT, isRingCode, elementsFromName, ringPlan, takeRingsAtBrazing, giveRingsBack };
