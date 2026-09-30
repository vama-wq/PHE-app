// Owner actions on a purchase order, and posting in a PO's chat — shared by
// the Purchases routes (routes/purchaseOrders.js) and the WhatsApp reply
// dispatcher, so both paths do exactly the same thing.
//
// Contract: fn(db, params) with params.actor = { id, name, role } and
// params.via = 'app' | 'whatsapp'. Returns { ok:true, summary, data } or
// { ok:false, code, message } with code 'not_found' | 'already_done' |
// 'invalid' | 'blocked' | 'forbidden' — never throws for an expected condition.
//
// "First one wins": every state change is a conditional UPDATE on the waiting
// state (rate_increase_pending still TRUE, over_qty_pending still the quantity
// that was read), so a dashboard click and a WhatsApp reply that land together
// cannot both act — the second gets 'already_done' with where things stand.
const dbmod = require('../../db');
const { createNotification } = require('../../routes/notifications');
const { recomputePoTotals } = require('../../lib/poSettle');

const MAX_MENTIONS = 25;

const viaTag = (via) => (via === 'whatsapp' ? ' (via WhatsApp)' : '');

// Activity-log writes go through the module at call time (not a destructured
// copy) so the log stays pluggable, exactly like the routes' own writes.
const logActivity = (...args) => dbmod.logActivity(...args);

// The pg client inside db.withTransaction only has query(); give it the same
// get/all/run/insert shape the rest of the code expects.
function clientDb(client) {
  return {
    get: async (sql, params = []) => (await client.query(sql, params)).rows[0] || null,
    all: async (sql, params = []) => (await client.query(sql, params)).rows,
    run: (sql, params = []) => client.query(sql, params),
    insert: async (sql, params = []) => {
      const { rows } = await client.query(sql.trimEnd().replace(/;?\s*$/, '') + ' RETURNING id', params);
      return { lastInsertRowid: rows[0]?.id || null };
    },
  };
}

// Route ids arrive as strings; anything that is not a whole number cannot be
// a row (and would make Postgres throw on the integer column).
function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function fmtDate(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  } catch { return ''; }
}

const fmtQty = (q, unit) => `${Number(q)}${unit ? ` ${unit}` : ''}`;

const ownerOnly = (actor, what) => (
  !actor || actor.role !== 'owner'
    ? { ok: false, code: 'forbidden', message: `Only the owner can ${what}.` }
    : null
);

const poNotFound = (poId) => ({
  ok: false, code: 'not_found',
  message: `Purchase order #${poId} was not found — it may have been deleted.`,
});

async function loadPo(db, id) {
  return db.get(
    `SELECT po.*, s.name AS supplier_name, ua.name AS rate_approved_by_name, uc.name AS created_by_name
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN users ua ON ua.id = po.rate_increase_approved_by
       LEFT JOIN users uc ON uc.id = po.created_by
      WHERE po.id=$1`, [id]);
}

const poLabel = (po) => (po.supplier_name ? `${po.po_number} (${po.supplier_name})` : po.po_number);

const PO_STATE = {
  draft: 'it can now be marked as sent',
  rejected: 'it can now be marked as sent',
  sent: 'the PO has since been sent to the supplier',
  approved: 'the supplier has since accepted the PO',
  received: 'the PO has since been received',
};

// Plain-English "no rate increase is waiting — here is where it stands now".
function rateNotWaiting(po) {
  if (po.rate_increase_approved_by) {
    const by = po.rate_approved_by_name ? ` by ${po.rate_approved_by_name}` : '';
    const on = po.rate_increase_approved_at ? ` on ${fmtDate(po.rate_increase_approved_at)}` : '';
    const now = PO_STATE[po.status] || `the PO is now "${po.status}"`;
    return `The rate increase on ${poLabel(po)} was already approved${by}${on} — ${now}.`;
  }
  return `There is no rate increase waiting on ${poLabel(po)} — the rates may have been revised since the alert.`;
}

async function rateAlreadyDone(db, id) {
  const now = await loadPo(db, id);
  if (!now) return poNotFound(id);
  return { ok: false, code: 'already_done', message: rateNotWaiting(now), data: { status: now.status } };
}

// ── PO chat plumbing (shared by postPoMessage and declineRateIncrease) ───────

// @mentions from the app or the WhatsApp dispatcher: whole numbers only, each
// person once, and never more than MAX_MENTIONS (one message cannot flood
// everyone's dashboard and phone).
function cleanMentionIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    if (typeof v !== 'number' && !(typeof v === 'string' && /^\s*\d+\s*$/.test(v))) continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0 || out.includes(n)) continue;
    out.push(n);
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}

// Message + attachments + mention rows. Runs inside the caller's transaction
// (client from db.withTransaction) and returns the new message id.
async function insertPoMessage(client, { poId, userId, text, files, mentionIds }) {
  const q = clientDb(client);
  const r = await q.insert(
    'INSERT INTO purchase_order_messages (po_id, user_id, message) VALUES ($1,$2,$3)',
    [poId, userId, text]);
  const messageId = r.lastInsertRowid;
  for (const f of files) {
    await q.run(
      'INSERT INTO purchase_order_message_attachments (message_id, file_path, file_name, file_size, mime_type) VALUES ($1,$2,$3,$4,$5)',
      [messageId, f.storagePath, f.originalname, f.size, f.mimetype]);
  }
  for (const uid of mentionIds) {
    await q.run(
      'INSERT INTO purchase_order_message_mentions (message_id, po_id, mentioned_user_id) VALUES ($1,$2,$3)',
      [messageId, poId, uid]);
  }
  return messageId;
}

// The dashboard (and WhatsApp) alert for each @mention — after the commit, so a
// rolled-back message never leaves an alert behind.
async function notifyMentions(db, { po, actor, text, fileCount, userIds }) {
  const preview = (text || '').slice(0, 100);
  const fileNote = fileCount > 0 ? ` [+${fileCount} file${fileCount > 1 ? 's' : ''}]` : '';
  for (const userId of userIds) {
    // One failed alert must not stop the others (the message is already saved).
    try {
      await createNotification(db, {
        userId,
        type: 'po_message',
        title: `${actor.name} in ${po.po_number}`,
        body: preview ? preview + fileNote : `Sent${fileNote}`,
        link: `/purchases/${po.id}`,
        sourceUserId: actor.id,
        ref: { type: 'po_thread', id: po.id },
      });
    } catch (e) { console.error('PO mention alert failed:', e.message); }
  }
}

// What the PO's lines were when a rate-increase alert went out. Lines are
// re-inserted on every edit, so this uses their content, not their ids.
async function rateSnapshot(db, poId) {
  const r = await db.get(
    `SELECT COALESCE(string_agg(COALESCE(description,'') || '|' || qty::text || '|' || rate::text, ';'
              ORDER BY description, qty, rate), '') AS s
       FROM purchase_order_items WHERE po_id=$1`, [poId]);
  return r ? r.s : '';
}

// ── Owner approves a flagged rate increase — unlocks "Mark as Sent" ──────────
// expectSnapshot (optional, WhatsApp): the lines as they were when the alert
// went out — if they have changed since, the owner must look again in the app.
async function approveRateIncrease(db, { poId, actor, via = 'app', expectSnapshot } = {}) {
  const denied = ownerOnly(actor, 'approve a rate increase');
  if (denied) return denied;
  const id = toId(poId);
  if (!id) return poNotFound(poId);

  const po = await loadPo(db, id);
  if (!po) return poNotFound(id);
  if (!po.rate_increase_pending) {
    return { ok: false, code: 'already_done', message: rateNotWaiting(po), data: { status: po.status } };
  }
  if (expectSnapshot != null && (await rateSnapshot(db, id)) !== expectSnapshot) {
    return { ok: false, code: 'invalid', message: `The lines on ${poLabel(po)} have changed since this alert was sent, so it was not approved. Open the app to see the new rates.`, data: { reason: 'rates_changed' } };
  }

  const won = await db.withTransaction(async (client) => {
    const u = await client.query(
      `UPDATE purchase_orders SET rate_increase_pending=FALSE, rate_increase_approved_by=$1, rate_increase_approved_at=NOW()
        WHERE id=$2 AND rate_increase_pending=TRUE
        RETURNING id`,
      [actor.id, id]);
    if (!u.rowCount) return false; // someone else acted first
    await client.query('INSERT INTO purchase_order_messages (po_id, user_id, message) VALUES ($1,$2,$3)',
      [id, actor.id, `✅ Owner approved the rate increase — this PO can now be marked as sent.${viaTag(via)}`]);
    return true;
  });
  if (!won) return rateAlreadyDone(db, id);

  return {
    ok: true,
    summary: `Approved the rate increase on ${poLabel(po)} — it can now be marked as sent.`,
    data: { poId: id, poNumber: po.po_number },
  };
}

// ── Owner says no to a rate increase (owner decision 30 Sep 2026) ────────────
// The "no" goes into the PO chat for the buyer, @mentioning whoever made the
// PO. The flag stays on, so the PO stays blocked until the rates are revised.
async function declineRateIncrease(db, { poId, actor, note, via = 'app' } = {}) {
  const denied = ownerOnly(actor, 'decline a rate increase');
  if (denied) return denied;
  const id = toId(poId);
  if (!id) return poNotFound(poId);

  const po = await loadPo(db, id);
  if (!po) return poNotFound(id);
  if (!po.rate_increase_pending) {
    return { ok: false, code: 'already_done', message: rateNotWaiting(po), data: { status: po.status } };
  }

  const noteText = typeof note === 'string' ? note.trim() : '';
  const text = `Rate increase not approved${noteText ? `: ${noteText}` : ''} — please revise the rates.${viaTag(via)}`;
  const creatorId = po.created_by_name ? toId(po.created_by) : null; // a creator who still exists
  const mentionIds = creatorId && creatorId !== Number(actor.id) ? [creatorId] : [];

  // Lock the PO while the "no" is written, so an approval landing at the same
  // moment is decided strictly before or after it, never in between.
  const messageId = await db.withTransaction(async (client) => {
    const lock = await client.query(
      'SELECT id FROM purchase_orders WHERE id=$1 AND rate_increase_pending=TRUE FOR UPDATE', [id]);
    if (!lock.rowCount) return null; // approved (or revised) in the meantime
    return insertPoMessage(client, { poId: id, userId: actor.id, text, files: [], mentionIds });
  });
  if (!messageId) return rateAlreadyDone(db, id);

  await notifyMentions(db, { po, actor, text, fileCount: 0, userIds: mentionIds });
  const buyer = po.created_by_name || 'the buyer';
  await logActivity(null, null, 'po_rate_declined',
    `${po.po_number}: rate increase not approved${noteText ? ` — "${noteText}"` : ''}; ${buyer} asked to revise the rates${viaTag(via)}`,
    actor.id);

  const asked = mentionIds.length ? `asked ${buyer} to revise the rates` : 'the rates need revising';
  return {
    ok: true,
    summary: `Declined the rate increase on ${poLabel(po)} — ${asked}; the PO stays blocked until they are.`,
    data: { poId: id, poNumber: po.po_number, messageId },
  };
}

// ── Owner decides on an over-receipt ─────────────────────────────────────────
// Approving raises the PO line to what actually arrived and recomputes the
// PO's totals, so the document, the stock and the payable all agree.
// Rejecting keeps the line at the ordered quantity — only that much is
// treated as received.
async function loadOverItem(db, id) {
  return db.get(
    `SELECT poi.*, po.po_number, s.name AS supplier_name, ua.name AS over_qty_approved_by_name
       FROM purchase_order_items poi
       JOIN purchase_orders po ON po.id = poi.po_id
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN users ua ON ua.id = poi.over_qty_approved_by
      WHERE poi.id=$1`, [id]);
}

const itemLabel = (item) => `"${item.description}" (${item.po_number})`;

const itemNotFound = (poItemId) => ({
  ok: false, code: 'not_found',
  message: `Purchase-order line #${poItemId} was not found — the PO may have been edited or deleted.`,
});

const qtyChanged = (item, expect) => ({
  ok: false, code: 'already_done',
  message: `The quantity on ${itemLabel(item)} changed since the alert — ${fmtQty(item.over_qty_pending, item.unit)} is waiting now, not ${fmtQty(expect, item.unit)}. Open the PO to decide.`,
  data: { overQtyPending: Number(item.over_qty_pending) },
});

// Plain-English "nothing is waiting on this line — here is what happened".
async function overNotWaiting(db, item) {
  if (item.over_qty_approved_by) {
    const by = item.over_qty_approved_by_name ? ` by ${item.over_qty_approved_by_name}` : '';
    const on = item.over_qty_approved_at ? ` on ${fmtDate(item.over_qty_approved_at)}` : '';
    return {
      ok: false, code: 'already_done',
      message: `The extra on ${itemLabel(item)} was already accepted${by}${on} — the line now stands at ${fmtQty(item.qty, item.unit)}.`,
    };
  }
  // A decline stores no name on the line; the activity log has it.
  try {
    const esc = (s) => String(s).replace(/[\\%_]/g, '\\$&');
    const log = await db.get(
      `SELECT u.name, a.created_at FROM activity_log a LEFT JOIN users u ON u.id = a.created_by
        WHERE a.activity_type='po_over_qty_rejected' AND a.description LIKE $1
        ORDER BY a.created_at DESC LIMIT 1`,
      [`${esc(item.po_number)}: "${esc(item.description)}" over-receipt declined%`]);
    if (log) {
      const by = `${log.name ? ` by ${log.name}` : ''}${log.created_at ? ` on ${fmtDate(log.created_at)}` : ''}`;
      return {
        ok: false, code: 'already_done',
        message: `The extra on ${itemLabel(item)} was already declined${by} — only the ordered ${fmtQty(item.qty, item.unit)} stands.`,
      };
    }
  } catch (_) { /* who declined is a nicety */ }
  return {
    ok: false, code: 'already_done',
    message: `Nothing is waiting on ${itemLabel(item)} — there is no extra quantity to decide.`,
  };
}

async function overAlreadyDone(db, id, expect) {
  const now = await loadOverItem(db, id);
  if (!now) return itemNotFound(id);
  if (now.over_qty_pending != null) return qtyChanged(now, expect);
  return overNotWaiting(db, now);
}

// approve must be a real boolean. poId (optional) — when given, the line must
// belong to that PO. expectOverQty (optional) — the quantity the alert showed;
// if what is waiting now differs, nothing is decided.
async function decideOverReceipt(db, { poItemId, poId, approve, actor, via = 'app', expectOverQty } = {}) {
  const denied = ownerOnly(actor, 'decide on material that arrived over the ordered quantity');
  if (denied) return denied;
  if (typeof approve !== 'boolean') {
    return { ok: false, code: 'invalid', message: 'Say whether to accept the extra quantity or keep only the ordered quantity.' };
  }
  if (expectOverQty != null && !Number.isFinite(Number(expectOverQty))) {
    return { ok: false, code: 'invalid', message: 'The expected quantity must be a number.' };
  }
  const id = toId(poItemId);
  if (!id) return itemNotFound(poItemId);

  const item = await loadOverItem(db, id);
  if (!item || (poId != null && Number(item.po_id) !== Number(poId))) return itemNotFound(id);
  if (item.over_qty_pending == null) return overNotWaiting(db, item);
  if (expectOverQty != null && Math.abs(Number(expectOverQty) - Number(item.over_qty_pending)) > 1e-9) {
    return qtyChanged(item, expectOverQty);
  }
  // Guard on the exact quantity that was read (as Postgres returned it).
  const pendingRaw = item.over_qty_pending;
  const expect = expectOverQty != null ? expectOverQty : pendingRaw;

  if (approve) {
    const qty = Number(pendingRaw);
    const totals = await db.withTransaction(async (client) => {
      const u = await client.query(
        `UPDATE purchase_order_items
            SET qty=$1, amount=$2, over_qty_pending=NULL, over_qty_approved_by=$3, over_qty_approved_at=NOW()
          WHERE id=$4 AND over_qty_pending=$5
          RETURNING id`,
        [qty, Math.round(qty * (Number(item.rate) || 0) * 100) / 100, actor.id, item.id, pendingRaw]);
      if (!u.rowCount) return null; // someone else decided first
      // The PO is worth more now — recompute its totals from the lines.
      return recomputePoTotals(clientDb(client), item.po_id);
    });
    if (!totals) return overAlreadyDone(db, id, expect);
    const { grandTotal } = totals;
    await logActivity(null, null, 'po_over_qty_approved',
      `${item.po_number}: "${item.description}" over-receipt approved — ${item.qty} ordered, ${qty} accepted. PO now ₹${grandTotal}${viaTag(via)}`,
      actor.id);
    return {
      ok: true,
      summary: `Accepted the extra on ${itemLabel(item)} — ${fmtQty(qty, item.unit)} taken instead of the ${fmtQty(item.qty, item.unit)} ordered; the PO is now ₹${grandTotal}.`,
      data: { approved: true, poId: item.po_id, poItemId: item.id, qty, grandTotal },
    };
  }

  const u = await db.run(
    'UPDATE purchase_order_items SET over_qty_pending=NULL WHERE id=$1 AND over_qty_pending=$2 RETURNING id',
    [item.id, pendingRaw]);
  if (!u.rowCount) return overAlreadyDone(db, id, expect);
  await logActivity(null, null, 'po_over_qty_rejected',
    `${item.po_number}: "${item.description}" over-receipt declined — only the ordered ${item.qty} treated as received${viaTag(via)}`,
    actor.id);
  return {
    ok: true,
    summary: `Declined the extra on ${itemLabel(item)} — only the ordered ${fmtQty(item.qty, item.unit)} stands.`,
    data: { approved: false, poId: item.po_id, poItemId: item.id, qty: Number(item.qty) },
  };
}

// ── Post in a PO's chat ──────────────────────────────────────────────────────
// Anyone signed in may post (the route has no role gate). attachments are the
// uploaded files exactly as the upload middleware leaves them on req.files
// ({ storagePath, originalname, size, mimetype }).
async function postPoMessage(db, { poId, actor, message, mentionIds, via = 'app', attachments } = {}) {
  if (!actor || !actor.id) {
    return { ok: false, code: 'forbidden', message: 'Only a signed-in user can post in a purchase-order chat.' };
  }
  const files = Array.isArray(attachments) ? attachments : [];
  let text = typeof message === 'string' ? message.trim() : '';
  if (!text && !files.length) return { ok: false, code: 'invalid', message: 'Message or attachment required' };
  const id = toId(poId);
  if (!id) return poNotFound(poId);
  const po = await db.get('SELECT id, po_number FROM purchase_orders WHERE id=$1', [id]);
  if (!po) return poNotFound(id);

  if (via === 'whatsapp') text = text ? `${text}${viaTag(via)}` : viaTag(via).trim();

  // Mentions: cleaned, never yourself, and only people who exist.
  const wanted = cleanMentionIds(mentionIds).filter(uid => uid !== Number(actor.id));
  const people = wanted.length
    ? await db.all('SELECT id, name FROM users WHERE id = ANY($1::int[])', [wanted])
    : [];
  const userIds = wanted.filter(uid => people.some(p => Number(p.id) === uid));

  const messageId = await db.withTransaction(
    (client) => insertPoMessage(client, { poId: id, userId: actor.id, text, files, mentionIds: userIds }));

  await notifyMentions(db, { po, actor, text, fileCount: files.length, userIds });

  const names = userIds.map(uid => people.find(p => Number(p.id) === uid)?.name).filter(Boolean);
  const told = names.length ? ` and notified ${names.join(', ')}` : '';
  return {
    ok: true,
    summary: `Posted your message in the ${po.po_number} chat${told}.`,
    data: { id: messageId, poId: id, mentioned: userIds },
  };
}

module.exports = {
  rateSnapshot,
  approveRateIncrease,
  declineRateIncrease,
  decideOverReceipt,
  postPoMessage,
  cleanMentionIds,
};
