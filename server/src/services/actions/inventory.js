// Owner actions on inventory items that accounts added and that wait for the
// owner's sign-off (approval_status = 'pending_approval').
//
// Shared by the Inventory routes and the WhatsApp reply dispatcher, so both
// paths do exactly the same thing. Every change is guarded on the item still
// waiting: when a dashboard click and a WhatsApp reply land together, the
// first one wins and the second is told what already happened.
//
// fn(db, params) → { ok:true, summary, data } | { ok:false, code, message }
//   code: 'not_found' | 'already_done' | 'invalid' | 'blocked' | 'forbidden'
const dbmod = require('../../db');
const upload = require('../../middleware/upload');

// Required when used, not at load: notifications pulls in lib/whatsapp, and the
// WhatsApp dispatcher pulls in this file — a load-time require would be a cycle.
const notify = (db, payload) => require('../../routes/notifications').createNotification(db, payload);

const OWNER_ONLY = ['owner'];

const viaSuffix = (via) => (via === 'whatsapp' ? ' (via WhatsApp)' : '');
const label = (item) => `${item.name} (${item.item_code})`;

function checkRole(actor, verb) {
  if (!actor || !OWNER_ONLY.includes(actor.role)) {
    return { ok: false, code: 'forbidden', message: `Only the owner can ${verb} new inventory items.` };
  }
  return null;
}

// Route ids arrive as strings; anything that is not a whole number cannot be
// an item (and would make Postgres throw on the integer column).
function parseId(itemId) {
  const n = Number(itemId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const notFound = (itemId) => ({
  ok: false, code: 'not_found',
  message: `Inventory item #${itemId} was not found — it may already have been rejected and removed.`,
});

// Plain-English "it is no longer waiting" for an item that still exists.
async function notPending(db, item) {
  const status = item.approval_status || 'approved';
  if (status === 'approved') {
    // Approvals are logged from now on; name who did it when the log says so.
    let by = '';
    try {
      const log = await db.get(
        `SELECT u.name FROM activity_log a LEFT JOIN users u ON u.id = a.created_by
          WHERE a.activity_type='inventory_approved' AND a.description LIKE $1
          ORDER BY a.created_at DESC LIMIT 1`,
        [`Inventory item approved: ${label(item)}%`]);
      if (log?.name) by = ` by ${log.name}`;
    } catch (_) { /* who approved is a nicety */ }
    return { ok: false, code: 'already_done', message: `${label(item)} is already approved${by} — nothing left to do.` };
  }
  return { ok: false, code: 'already_done', message: `${label(item)} is no longer waiting for approval (it is now "${status}").` };
}

async function approveInventoryItem(db, { itemId, actor, via = 'app' } = {}) {
  const denied = checkRole(actor, 'approve');
  if (denied) return denied;
  const id = parseId(itemId);
  if (!id) return notFound(itemId);

  // First one wins: only a row still pending flips; a second click gets 0 rows.
  const item = await db.get(
    `UPDATE inventory_items SET approval_status='approved'
      WHERE id=$1 AND approval_status='pending_approval'
      RETURNING id, name, item_code, created_by`, [id]);
  if (!item) {
    const cur = await db.get('SELECT id, name, item_code, approval_status FROM inventory_items WHERE id=$1', [id]);
    if (!cur) return notFound(id);
    return notPending(db, cur);
  }

  if (item.created_by) {
    try {
      await notify(db, {
        userId: item.created_by, type: 'inventory_approved', title: 'Inventory item approved',
        body: `"${item.name}" (${item.item_code}) was approved and is now live.`,
        link: `/inventory/${item.id}`, sourceUserId: actor.id,
      });
    } catch (_) { /* notifications are best-effort */ }
  }
  await dbmod.logActivity(null, null, 'inventory_approved',
    `Inventory item approved: ${label(item)}${viaSuffix(via)}`, actor.id);

  return {
    ok: true,
    summary: `Approved new inventory item ${label(item)}`,
    data: { item: { id: item.id, name: item.name, item_code: item.item_code } },
  };
}

// Thrown inside the transaction to roll it back when the guarded delete finds
// nothing left to delete (the lock makes this near-impossible, but the lots and
// ledger rows deleted before it must never go without the item).
class GuardMiss extends Error {}

async function rejectInventoryItem(db, { itemId, actor, reason, via = 'app' } = {}) {
  const denied = checkRole(actor, 'reject');
  if (denied) return denied;
  const id = parseId(itemId);
  if (!id) return notFound(itemId);
  const why = String(reason || '').trim();

  let outcome;
  try {
    outcome = await db.withTransaction(async (client) => {
      // Lock the row: a concurrent approve waits, and no purchase order line or
      // BOM row can start pointing at it until this is settled.
      const { rows: [item] } = await client.query(
        'SELECT id, name, item_code, approval_status, created_by, drawing_file FROM inventory_items WHERE id=$1 FOR UPDATE', [id]);
      if (!item) return { result: notFound(id) };
      if (item.approval_status !== 'pending_approval') return { stale: item };

      // Refuse BEFORE deleting anything — a purchase order line holds the item
      // by foreign key, and it is the owner's call what happens to that PO.
      const { rows: pos } = await client.query(
        `SELECT DISTINCT COALESCE(po.po_number, 'PO #' || poi.po_id::text) AS po
           FROM purchase_order_items poi LEFT JOIN purchase_orders po ON po.id = poi.po_id
          WHERE poi.inventory_item_id=$1 ORDER BY 1`, [id]);
      if (pos.length) {
        return { result: { ok: false, code: 'blocked',
          message: `${label(item)} is on purchase order ${pos.map(p => p.po).join(', ')} — open the app to deal with it.` } };
      }
      // Same for an order's bill of materials (also held by foreign key).
      const { rows: orders } = await client.query(
        `SELECT DISTINCT o.order_code FROM order_item_inventory oii
           JOIN order_items oi ON oi.id = oii.order_item_id JOIN orders o ON o.id = oi.order_id
          WHERE oii.inventory_item_id=$1 ORDER BY 1`, [id]);
      if (orders.length) {
        return { result: { ok: false, code: 'blocked',
          message: `${label(item)} is on the bill of materials of order ${orders.map(o => o.order_code).join(', ')} — open the app to deal with it.` } };
      }

      const { rows: versions } = await client.query(
        'SELECT DISTINCT file_path FROM inventory_item_drawings WHERE item_id=$1', [id]);
      const l = await client.query('DELETE FROM inventory_fifo_lots WHERE item_id=$1', [id]);
      const t = await client.query('DELETE FROM inventory_transactions WHERE item_id=$1', [id]);
      const d = await client.query(
        "DELETE FROM inventory_items WHERE id=$1 AND approval_status='pending_approval' RETURNING id", [id]);
      if (!d.rowCount) throw new GuardMiss();
      const files = [...new Set([item.drawing_file, ...versions.map(v => v.file_path)].filter(Boolean))];
      return { item, files, removed: { lots: l.rowCount, transactions: t.rowCount } };
    });
  } catch (e) {
    if (e instanceof GuardMiss) {
      const cur = await db.get('SELECT id, name, item_code, approval_status FROM inventory_items WHERE id=$1', [id]);
      return cur ? notPending(db, cur) : notFound(id);
    }
    // Held by some other record the checks above do not cover — the whole
    // transaction rolled back, so nothing was removed.
    if (e.code === '23503') {
      const cur = await db.get('SELECT name, item_code FROM inventory_items WHERE id=$1', [id]);
      return { ok: false, code: 'blocked',
        message: `${cur ? label(cur) : `Inventory item #${id}`} is still used by another record in the app — open the app to deal with it.` };
    }
    throw e;
  }
  if (outcome.result) return outcome.result;
  if (outcome.stale) return notPending(db, outcome.stale);
  const { item, files, removed } = outcome;

  // Drawing files do not cascade with the rows. Remove every version's file —
  // unless another item still points at the same file (a bulk import can share
  // one drawing between items). Best effort: a missing file is not an error.
  let filesDeleted = 0;
  for (const f of files) {
    try {
      const still = await db.get(
        `SELECT 1 FROM inventory_items WHERE drawing_file=$1
          UNION ALL SELECT 1 FROM inventory_item_drawings WHERE file_path=$1 LIMIT 1`, [f]);
      if (still) continue;
      await upload.deleteFromStorage(f);
      filesDeleted++;
    } catch (_) { /* best effort */ }
  }

  if (item.created_by) {
    try {
      await notify(db, {
        userId: item.created_by, type: 'inventory_rejected', title: 'Inventory item rejected',
        body: `"${item.name}" (${item.item_code}) was rejected by the owner${why ? `: ${why}` : ''}. It has been removed.`,
        link: '/inventory', sourceUserId: actor.id,
      });
    } catch (_) { /* notifications are best-effort */ }
  }
  await dbmod.logActivity(null, null, 'inventory_rejected',
    `Inventory item rejected and removed: ${label(item)}${why ? ` — ${why}` : ''}` +
    ` (${removed.transactions} ledger entries and ${removed.lots} FIFO lots removed with it)${viaSuffix(via)}`,
    actor.id);

  return {
    ok: true,
    summary: `Rejected and removed new inventory item ${label(item)}`,
    data: { item: { id: item.id, name: item.name, item_code: item.item_code }, removed, files_deleted: filesDeleted },
  };
}

module.exports = { approveInventoryItem, rejectInventoryItem };
