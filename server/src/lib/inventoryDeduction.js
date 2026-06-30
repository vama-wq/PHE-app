// ── Inventory consumption for order items ──────────────────────────────────────
// The inventory an order item consumes (its BOM) is selected by design at
// drawing-upload time and stored in order_item_inventory. It is NO LONGER
// deducted at drawing approval — deduction now happens when the item clears QC
// (single job card) or, for a partially-dispatched item (split into multiple job
// cards), only once the whole ordered qty has been dispatched / moved to Finished
// Goods. order_items.inventory_deducted guards against double-deduction.

async function deductItemInventory(db, itemId, orderCode, userId, reasonNote = 'Consumed for production') {
  const item = await db.get('SELECT id, drawing_number, inventory_deducted FROM order_items WHERE id=$1', [itemId]);
  if (!item || item.inventory_deducted) return; // never double-deduct
  const sels = await db.all('SELECT * FROM order_item_inventory WHERE order_item_id=$1', [itemId]);
  for (const sel of sels) {
    const inv = await db.get('SELECT * FROM inventory_items WHERE id=$1', [sel.inventory_item_id]);
    if (!inv) continue;
    const newStock = (inv.current_stock || 0) - parseFloat(sel.qty || 0); // allow negative so shortages are visible
    await db.run('UPDATE inventory_items SET current_stock=$1 WHERE id=$2', [newStock, sel.inventory_item_id]);
    const noteParts = [`Order: ${orderCode}`];
    if (item.drawing_number) noteParts.push(`Dwg: ${item.drawing_number}`);
    noteParts.push(reasonNote);
    await db.insert(
      `INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by)
       VALUES ($1,'dispatch_to_production',$2,$3,$4,$5)`,
      [sel.inventory_item_id, parseFloat(sel.qty || 0), newStock, noteParts.join(' | '), userId]
    );
  }
  if (sels.length) await db.run('UPDATE order_items SET inventory_deducted=TRUE WHERE id=$1', [itemId]);
}

async function restoreItemInventory(db, itemId, orderCode, userId, reasonNote) {
  const item = await db.get('SELECT id, inventory_deducted FROM order_items WHERE id=$1', [itemId]);
  if (!item || !item.inventory_deducted) return; // only restore what was actually deducted
  const sels = await db.all('SELECT * FROM order_item_inventory WHERE order_item_id=$1', [itemId]);
  for (const sel of sels) {
    const inv = await db.get('SELECT * FROM inventory_items WHERE id=$1', [sel.inventory_item_id]);
    if (!inv) continue;
    const newStock = (inv.current_stock || 0) + parseFloat(sel.qty || 0);
    await db.run('UPDATE inventory_items SET current_stock=$1 WHERE id=$2', [newStock, sel.inventory_item_id]);
    await db.insert(
      `INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by)
       VALUES ($1,'return_from_production',$2,$3,$4,$5)`,
      [sel.inventory_item_id, parseFloat(sel.qty || 0), newStock, `${reasonNote} — ${orderCode}`, userId]
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

module.exports = { deductItemInventory, restoreItemInventory, resolveJobCardItemId, settleItemInventory };
