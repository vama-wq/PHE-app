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

// One part of each of these must be on the list for the fitting.
const NEEDS = {
  cap: [
    { label: 'Flange Cap', test: (i) => cat(i) === 'flange cap' },
    // "Flange White Sleeve - Mid Patti" is the sleeve, not the patti.
    { label: 'Flange Mid Patti', test: (i) => /mid\s*patt?i/i.test(nm(i)) && !/sleeve/i.test(nm(i)) },
    { label: 'Sleeve', test: (i) => cat(i) === 'flange spare' && /sleeve/i.test(nm(i)) },
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

module.exports = { FITTINGS, KEYS, LABEL, NEEDS, normalize, forItem, isMultiElement, missingParts, listError, itemForCard, forCard, labels };
