// ── Items bought as a set (owner, 10 Oct 2026) ────────────────────────────────
// "The heavy terminal comes in a set: 1 M6XM4 needs 1 HV nut and 2 HV washers.
// The PO is made of the pin, but when QC is carried out it splits into all three
// and puts each into its own inventory." inventory_set_components lists, for an
// item bought as a set, the other parts in each set and how many. At purchase QC
// the approved quantity goes into the set item as before, and each part gets
// quantity × its count, at ₹0 — the set's price stays on the item ordered.

async function setParts(db, itemId) {
  if (!itemId) return [];
  try {
    return await db.all(
      `SELECT c.component_item_id, c.qty_per_set::float AS per, ii.item_code, ii.name, ii.unit
         FROM inventory_set_components c JOIN inventory_items ii ON ii.id = c.component_item_id
        WHERE c.set_item_id = $1 ORDER BY ii.item_code`, [itemId]);
  } catch { return []; }   // table not there yet: nothing is a set
}

// Parts per item for several items at once (PO pages).
async function setPartsFor(db, itemIds) {
  const ids = [...new Set((itemIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  let rows = [];
  try {
    rows = await db.all(
      `SELECT c.set_item_id, c.component_item_id, c.qty_per_set::float AS per, ii.item_code, ii.unit
         FROM inventory_set_components c JOIN inventory_items ii ON ii.id = c.component_item_id
        WHERE c.set_item_id = ANY($1) ORDER BY ii.item_code`, [ids]);
  } catch { rows = []; }
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.set_item_id)) m.set(r.set_item_id, []);
    m.get(r.set_item_id).push({ item_code: r.item_code, per: r.per, unit: r.unit });
  }
  return m;
}

module.exports = { setParts, setPartsFor };
