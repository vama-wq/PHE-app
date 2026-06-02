/**
 * FIFO inventory consumption helper.
 *
 * Consumes `qty` units of `itemId` from the oldest lots first.
 * Updates qty_remaining on each lot, returns { unitCostFifo, totalCost }.
 *
 * unitCostFifo = weighted-average cost of units consumed across lots.
 * totalCost    = sum(qty_consumed_from_lot × lot.unit_cost)
 */
async function consumeFIFO(db, itemId, qty) {
  let remaining = parseFloat(qty);
  let totalCost = 0;

  // Get lots oldest-first with remaining stock
  const lots = await db.all(
    `SELECT id, qty_remaining, unit_cost
     FROM inventory_fifo_lots
     WHERE item_id = $1 AND qty_remaining > 0
     ORDER BY received_at ASC, id ASC`,
    [itemId]
  );

  for (const lot of lots) {
    if (remaining <= 0) break;
    const consume = Math.min(lot.qty_remaining, remaining);
    totalCost += consume * lot.unit_cost;
    remaining -= consume;
    await db.run(
      'UPDATE inventory_fifo_lots SET qty_remaining = qty_remaining - $1 WHERE id = $2',
      [consume, lot.id]
    );
  }

  // If no lots exist (e.g. opening stock added without PO), fall back to item's unit_cost
  if (lots.length === 0) {
    const item = await db.get('SELECT unit_cost FROM inventory_items WHERE id=$1', [itemId]);
    totalCost = parseFloat(qty) * (item?.unit_cost || 0);
  }

  const consumed = parseFloat(qty) - Math.max(remaining, 0);
  const unitCostFifo = consumed > 0 ? totalCost / consumed : 0;

  return { unitCostFifo, totalCost };
}

/**
 * Create a FIFO lot for inbound stock (purchase_in, opening_stock).
 */
async function createFIFOLot(db, itemId, qty, unitCost, poId = null) {
  await db.run(
    `INSERT INTO inventory_fifo_lots (item_id, po_id, qty_original, qty_remaining, unit_cost, received_at)
     VALUES ($1, $2, $3, $3, $4, NOW())`,
    [itemId, poId || null, parseFloat(qty), parseFloat(unitCost) || 0]
  );
}

module.exports = { consumeFIFO, createFIFOLot };
