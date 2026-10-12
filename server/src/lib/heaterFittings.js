// ── Heater fittings on a 2in1 / 3in1 / Xin1 item (owner, 12 Oct 2026) ───────
// "If in1 heaters are being made then ask, in a dropdown where more than one
// option can be selected:
//   1 Pocket — uses one other brazing ring in a heater apart from the element
//     brazing rings;
//   2 Cap — the heater's inventory needs a Flange Cap, a Flange Mid Patti and a
//     Sleeve, with its weight compulsory for production to add at brazing;
//   3 Short Patti — to phase the heater, one of the short pattis is added;
//   4 Gasket — the inventory needs one of the gaskets;
//   5 Thermostat — the inventory needs one of the thermostats."
// Kept on the order item (order_items.fittings, a JSON list of keys). Design's
// list must hold one part of each kind a fitting needs; the pocket's ring is
// taken at Stage 15 with the element rings (lib/brazingRings.js).
// The Cap's sleeve goes by WEIGHT (owner, 12 Oct 2026, "b"): its line on the
// list carries no quantity; the total grams production enters at Brazing leave
// the sleeve's stock (kept in kg) when Brazing is ticked, and come back if it is
// unticked.

const FITTINGS = [
  { key: 'pocket', label: 'Pocket' },
  { key: 'cap', label: 'Cap' },
  { key: 'short_patti', label: 'Short Patti' },
  { key: 'gasket', label: 'Gasket' },
  { key: 'thermostat', label: 'Thermostat' },
];
const KEYS = FITTINGS.map(f => f.key);
const LABEL = Object.fromEntries(FITTINGS.map(f => [f.key, f.label]));

const cat = (i) => String(i?.category || '').trim().toLowerCase();
const nm = (i) => String(i?.name || '');
const isSleeve = (i) => cat(i) === 'flange spare' && /sleeve/i.test(nm(i));

// One part of each of these must be on the list for the fitting.
const NEEDS = {
  cap: [
    { label: 'Flange Cap', test: (i) => cat(i) === 'flange cap' },
    // "Flange White Sleeve - Mid Patti" is the sleeve, not the patti.
    { label: 'Flange Mid Patti', test: (i) => /mid\s*patt?i/i.test(nm(i)) && !/sleeve/i.test(nm(i)) },
    { label: 'Sleeve', test: isSleeve },
  ],
  short_patti: [{ label: 'Short Patti', test: (i) => /short\s*patt?i/i.test(nm(i)) }],
  gasket: [{ label: 'Gasket', test: (i) => cat(i) === 'gasket' }],
  thermostat: [{ label: 'Thermostat', test: (i) => /^thermostat/.test(cat(i)) }],
};

// "3in1", "3 in 1", "3IN1" in the drawing or product code.
function elementsFromName(...names) {
  for (const n of names) {
    const m = String(n || '').match(/(\d+)\s*in\s*1(?![0-9])/i);
    if (m && parseInt(m[1], 10) > 0) return parseInt(m[1], 10);
  }
  return null;
}
const isMultiElement = (drawingNumber, productCode) => (elementsFromName(drawingNumber, productCode) || 1) > 1;

// A clean list of known keys in the dropdown's order; anything else dropped.
function normalize(raw) {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = v.split(','); } }
  if (!Array.isArray(v)) return [];
  const set = new Set(v.map(k => String(k || '').trim().toLowerCase()));
  return KEYS.filter(k => set.has(k));
}

// What the item may carry: only a multi-element heater, never on a
// finished-goods order (the heater is already built).
function forItem(raw, { drawingNumber, productCode, orderType }) {
  if (orderType === 'finished_goods') return [];
  if (!isMultiElement(drawingNumber, productCode)) return [];
  return normalize(raw);
}

// The parts missing from a list (inventory rows with category and name) for
// these fittings, as "Cap: Sleeve".
function missingParts(fittings, invRows) {
  const out = [];
  for (const k of normalize(fittings)) {
    for (const need of NEEDS[k] || []) {
      if (!(invRows || []).some(need.test)) out.push({ fitting: k, label: need.label, text: `${LABEL[k]}: ${need.label}` });
    }
  }
  return out;
}

// The refusal for a list that lacks a fitting's part, or null.
async function listError(db, orderItemId, invIds) {
  const it = await db.get(
    `SELECT oi.fittings, oi.drawing_number, oi.product_code, o.order_type
       FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.id=$1`, [orderItemId]);
  if (!it) return null;
  const f = forItem(it.fittings, { drawingNumber: it.drawing_number, productCode: it.product_code, orderType: it.order_type });
  if (!f.length) return null;
  const ids = (invIds || []).map(n => parseInt(n, 10)).filter(Boolean);
  const rows = ids.length ? await db.all('SELECT id, name, category FROM inventory_items WHERE id = ANY($1)', [ids]) : [];
  const miss = missingParts(f, rows);
  if (!miss.length) return null;
  return `This heater's fittings need these on its inventory list: ${miss.map(m => m.text).join(', ')} — add one of each.`;
}

// The card's order item: its own, else the order's item with the card's drawing.
async function itemForCard(db, card) {
  if (!card) return null;
  if (card.order_item_id) return db.get('SELECT * FROM order_items WHERE id=$1', [card.order_item_id]);
  return db.get('SELECT * FROM order_items WHERE order_id=$1 AND drawing_number=$2 ORDER BY id LIMIT 1', [card.order_id, card.drawing_no]);
}

// The card's fittings (finished-goods cards never have any).
async function forCard(db, card) {
  if (!card || card.is_fg) return [];
  const it = await itemForCard(db, card);
  if (!it) return [];
  const o = await db.get('SELECT order_type FROM orders WHERE id=$1', [it.order_id]);
  return forItem(it.fittings, { drawingNumber: it.drawing_number, productCode: it.product_code, orderType: o?.order_type });
}

const labels = (fittings) => normalize(fittings).map(k => LABEL[k]);

// The sleeve lines on a Cap item's list go by weight, not quantity: the ids of
// those among invIds (an empty set when the item has no Cap).
async function sleeveByWeightIds(db, orderItemId, invIds) {
  const it = await db.get(
    `SELECT oi.fittings, oi.drawing_number, oi.product_code, o.order_type
       FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.id=$1`, [orderItemId]);
  if (!it) return new Set();
  const f = forItem(it.fittings, { drawingNumber: it.drawing_number, productCode: it.product_code, orderType: it.order_type });
  if (!f.includes('cap')) return new Set();
  const ids = (invIds || []).map(n => parseInt(n, 10)).filter(Boolean);
  if (!ids.length) return new Set();
  const rows = await db.all('SELECT id, name, category FROM inventory_items WHERE id = ANY($1)', [ids]);
  return new Set(rows.filter(isSleeve).map(r => r.id));
}

// Grams in the item's unit: kg → ÷ 1000, grams as they are; null for a part
// counted in pieces (its weight cannot come off a count).
function gramsInUnit(grams, unit) {
  const u = String(unit || '').trim().toLowerCase().replace(/\.$/, '');
  if (/^(kg|kgs|kilo|kilos|kilogram|kilograms)$/.test(u)) return Math.round((Number(grams) / 1000) * 1e7) / 1e7;
  if (/^(g|gm|gms|gram|grams)$/.test(u)) return Number(grams);
  return null;
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
  ? db.withTransaction(async (client) => fn(txDb(client))) : fn(db));
const note = async (tx, card, type, text, userId) => tx.run(
  `INSERT INTO activity_log (order_id, job_card_id, activity_type, description, created_by) VALUES ($1,$2,$3,$4,$5)`,
  [card.order_id, card.id, type, text, userId || null]);

// Brazing ticked on a Cap heater: the sleeve weight entered leaves the stock of
// the sleeve on its list. Once per tick; nothing after Inventory QC.
async function takeSleeveAtBrazing(db, jobCardId, userId) {
  const { recordMove } = require('./stockLedger');
  return inTx(db, async (tx) => {
    const card = await tx.get(
      `SELECT jc.*, o.order_code FROM job_cards jc JOIN orders o ON o.id = jc.order_id WHERE jc.id=$1 FOR UPDATE OF jc`, [jobCardId]);
    if (!card || card.is_fg || card.sleeve_taken_at || card.inventory_qc_at) return null;
    if (!(await forCard(tx, card)).includes('cap')) return null;
    const st = await tx.get('SELECT value1 FROM production_checklist WHERE job_card_id=$1 AND stage_no=15', [card.id]);
    let b = st?.value1;
    try { b = typeof b === 'string' ? JSON.parse(b) : b; } catch { b = null; }
    const grams = Number(b?.sleeveWeightG);
    if (!(grams > 0)) return null;
    const item = await itemForCard(tx, card);
    const sleeve = item ? (await tx.all(
      `SELECT ii.id, ii.item_code, ii.name, ii.category, ii.unit FROM order_item_inventory oii
         JOIN inventory_items ii ON ii.id = oii.inventory_item_id WHERE oii.order_item_id=$1 ORDER BY oii.id`, [item.id])).find(isSleeve) : null;
    if (!sleeve) {
      await note(tx, card, 'sleeve_not_taken', `Brazing ticked with ${grams} g of sleeve, but no sleeve is on the item's list — nothing taken`, userId);
      return null;
    }
    const qty = gramsInUnit(grams, sleeve.unit);
    if (!(qty > 0)) {
      await note(tx, card, 'sleeve_not_taken', `Brazing ticked with ${grams} g of sleeve, but ${sleeve.item_code} is counted in ${sleeve.unit || 'pieces'}, not by weight — nothing taken`, userId);
      return null;
    }
    const after = Number((await tx.get(
      'UPDATE inventory_items SET current_stock = current_stock - $1 WHERE id=$2 RETURNING current_stock', [qty, sleeve.id])).current_stock);
    await recordMove(tx, { itemId: sleeve.id, type: 'dispatch_to_production', qty, balanceAfter: after,
      notes: `Order: ${card.order_code}${item?.drawing_number ? ` | Dwg: ${item.drawing_number}` : ''} | Sleeve by weight ${grams} g | Stage 15 Brazing (JC ${card.job_card_no})`,
      userId, orderItemId: item?.id || null, source: 'sleeve', jobCardId: card.id });
    const rec = { item_id: sleeve.id, item_code: sleeve.item_code, qty, unit: sleeve.unit, grams };
    await tx.run('UPDATE job_cards SET sleeve_taken_at = NOW(), sleeve_taken = $2 WHERE id=$1', [card.id, JSON.stringify(rec)]);
    await note(tx, card, 'sleeve_taken', `Brazing ticked: sleeve ${grams} g — ${qty} ${sleeve.unit} ${sleeve.item_code} taken for ${card.job_card_no}`, userId);
    return rec;
  });
}

// Brazing unticked: exactly what the tick took goes back.
async function giveSleeveBack(db, jobCardId, userId) {
  const { recordMove } = require('./stockLedger');
  return inTx(db, async (tx) => {
    const card = await tx.get(
      `SELECT jc.*, o.order_code FROM job_cards jc JOIN orders o ON o.id = jc.order_id WHERE jc.id=$1 FOR UPDATE OF jc`, [jobCardId]);
    if (!card || !card.sleeve_taken_at || card.inventory_qc_at) return null;
    let rec = card.sleeve_taken;
    try { rec = typeof rec === 'string' ? JSON.parse(rec) : rec; } catch { rec = null; }
    if (rec?.item_id && Number(rec.qty) > 0) {
      const after = Number((await tx.get(
        'UPDATE inventory_items SET current_stock = current_stock + $1 WHERE id=$2 RETURNING current_stock', [rec.qty, rec.item_id])).current_stock);
      await recordMove(tx, { itemId: rec.item_id, type: 'return_from_production', qty: rec.qty, balanceAfter: after,
        notes: `Order: ${card.order_code} | Brazing undone — sleeve back (JC ${card.job_card_no})`, userId,
        orderItemId: card.order_item_id || null, source: 'sleeve', jobCardId: card.id });
      await note(tx, card, 'sleeve_returned', `Brazing unticked: ${rec.qty} ${rec.unit || ''} ${rec.item_code} (sleeve) given back for ${card.job_card_no}`, userId);
    }
    await tx.run('UPDATE job_cards SET sleeve_taken_at = NULL, sleeve_taken = NULL WHERE id=$1', [card.id]);
    return rec;
  });
}

module.exports = { FITTINGS, KEYS, LABEL, NEEDS, normalize, forItem, isMultiElement, isSleeve, missingParts, listError, itemForCard, forCard, labels,
  sleeveByWeightIds, gramsInUnit, takeSleeveAtBrazing, giveSleeveBack };
