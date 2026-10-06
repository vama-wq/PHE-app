// Owner actions on orders, shared by the dashboard routes (routes/orders.js)
// and the WhatsApp reply dispatcher:
//   approveOrder / rejectOrder   — the owner's decision on an order waiting for approval
//   addPriceNote                 — the owner answering a "Price requested for <JC>" alert
//   postOrderMessage             — a message in an order's chat thread
//
// Contract: fn(db, params) with params.actor = { id, name, role } and
// params.via = 'app' | 'whatsapp'. Returns { ok:true, summary, data } or
// { ok:false, code, message } — never throws for an expected condition.
// Always works through the db it is given, so a caller (or a test) can hand it
// a transaction-bound db.
//
// "First one wins": every state change is conditional on the waiting state
// (UPDATE … WHERE status='pending_approval', or an insert made under a lock
// after checking for the same answer), so a dashboard click and a WhatsApp
// reply that land together cannot both act — the second gets 'already_done'
// with the state the first one left.
const { createNotification } = require('../../routes/notifications');

const viaTag = (via) => (via === 'whatsapp' ? ' (via WhatsApp)' : '');

// The only order status in which the dashboard offers Approve / Reject
// (client/src/pages/orders/OrderDetail.jsx: canApprove).
const WAITING_STATUS = 'pending_approval';

// Same wording the dashboard shows (client/src/lib/utils.js STATUS_LABELS).
const STATUS_LABELS = {
  pending_approval: 'Pending Approval',
  approved: 'Approved',
  rejected: 'Rejected',
  job_card_created: 'Job Card Created',
  in_progress: 'In Progress',
  on_hold: 'On Hold',
  qc_pending: 'QC Pending',
  inventory_qc: 'Inventory QC',
  qc_approved: 'QC Approved',
  fg_qc_pending: 'FG QC Pending',
  fg_qc_approved: 'FG QC Approved',
  in_finished_goods: 'In Finished Goods',
  packaging: 'Packaging',
  dispatched: 'Dispatched',
  partially_dispatched: 'Partly Dispatched',
  customer_query: 'Query Raised',
  product_return: 'Product Return',
  resolved_dispatched: 'Query Resolved',
};
const statusLabel = (s) => STATUS_LABELS[s] || String(s || 'unknown').replace(/_/g, ' ');

// Advisory-lock namespaces (first key of pg_advisory_xact_lock(int, int)).
const LOCK_PRICE_NOTE = 0x50524345;   // 'PRCE' — one job card's price answer
const LOCK_ORDER_CHAT = 0x4f434854;   // 'OCHT' — one order's chat (WhatsApp replies only)

const MAX_MENTIONS = 25;

// ── helpers ───────────────────────────────────────────────────────────────────
const fail = (code, message, data) => (data ? { ok: false, code, message, data } : { ok: false, code, message });

function toId(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function fmtDate(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  } catch { return ''; }
}

// Same role check the route's authorize(...) does — the WhatsApp path skips
// the middleware, so the service checks again.
function checkRole(actor, roles, what) {
  if (!actor || !toId(actor.id)) return fail('forbidden', 'You need to be signed in to do this.');
  if (roles && !roles.includes(actor.role)) return fail('forbidden', `Only the owner can ${what}.`);
  return null;
}

// Activity entry written with the caller's db/transaction client, so it lands
// (or rolls back) together with the change it describes.
async function logActivityTx(q, orderId, jobCardId, type, description, userId) {
  await q(
    `INSERT INTO activity_log (order_id, job_card_id, activity_type, description, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [orderId || null, jobCardId || null, type, description, userId]);
}

async function loadOrder(db, id) {
  return db.get(
    `SELECT o.id, o.order_code, o.status, o.rejection_reason, o.approved_at,
            c.name AS customer_name, c.customer_code, ua.name AS approved_by_name
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN users ua ON ua.id = o.approved_by
      WHERE o.id = $1`, [id]);
}

function orderLabel(o) {
  const code = o.order_code || `#${o.id}`;
  const cust = o.customer_name || o.customer_code;
  return cust ? `${code} (${cust})` : code;
}

// Plain-English "it is no longer waiting for approval — here is where it is".
async function notWaitingMessage(db, o) {
  const code = o.order_code || `#${o.id}`;
  const approvedBy = o.approved_by_name ? ` by ${o.approved_by_name}` : '';
  const approvedOn = o.approved_at ? ` on ${fmtDate(o.approved_at)}` : '';
  if (o.status === 'approved') {
    return `Order ${code} is already approved${approvedBy}${approvedOn}.`;
  }
  if (o.status === 'rejected') {
    const last = await db.get(
      `SELECT u.name FROM activity_log a LEFT JOIN users u ON u.id = a.created_by
        WHERE a.order_id = $1 AND a.activity_type = 'order_rejected'
        ORDER BY a.created_at DESC, a.id DESC LIMIT 1`, [o.id]);
    const by = last?.name ? ` by ${last.name}` : '';
    const why = o.rejection_reason ? ` (reason: ${o.rejection_reason})` : '';
    return `Order ${code} was already rejected${by}${why} — it is not waiting for approval.`;
  }
  const approved = o.approved_by_name ? ` It was approved${approvedBy}${approvedOn}.` : '';
  return `Order ${code} is no longer waiting for approval — it is now ${statusLabel(o.status)}.${approved}`;
}

// ── Approve / reject an order ─────────────────────────────────────────────────
async function decideOrder(db, { orderId, actor, via, decision, reason }) {
  const denied = checkRole(actor, ['owner'], `${decision} orders`);
  if (denied) return denied;
  const id = toId(orderId);
  if (!id) return fail('invalid', 'No order was given.');

  const order = await loadOrder(db, id);
  if (!order) return fail('not_found', `Order #${id} was not found — it may have been deleted.`);

  const why = typeof reason === 'string' && reason.trim() ? reason.trim() : null;
  const changed = await db.withTransaction(async (client) => {
    const q = (sql, p) => client.query(sql, p);
    let r;
    if (decision === 'approve') {
      // No drawing gate here — the order is approved first, then design uploads
      // drawings per item. Inventory is not deducted here (it deducts per item
      // later — see lib/inventoryDeduction).
      r = await q(
        `UPDATE orders SET status='approved', approved_by=$1, approved_at=NOW()
          WHERE id=$2 AND status='${WAITING_STATUS}' RETURNING id`, [actor.id, id]);
      if (!r.rowCount) return false;
      await logActivityTx(q, id, null, 'order_approved', 'Order approved by owner' + viaTag(via), actor.id);
    } else {
      r = await q(
        `UPDATE orders SET status='rejected', rejection_reason=$1
          WHERE id=$2 AND status='${WAITING_STATUS}' RETURNING id`, [why, id]);
      if (!r.rowCount) return false;
      await logActivityTx(q, id, null, 'order_rejected',
        `Order rejected: ${why || 'No reason given'}` + viaTag(via), actor.id);
    }
    return true;
  });

  if (!changed) {
    const now = await loadOrder(db, id);
    if (!now) return fail('not_found', `Order #${id} was not found — it may have been deleted.`);
    return fail('already_done', await notWaitingMessage(db, now), { orderId: id, status: now.status });
  }

  if (decision === 'approve') {
    return { ok: true, summary: `Approved order ${orderLabel(order)}`,
      data: { orderId: id, order_code: order.order_code, status: 'approved' } };
  }
  return { ok: true,
    summary: `Rejected order ${orderLabel(order)}${why ? ` — reason: ${why}` : ' with no reason given'}`,
    data: { orderId: id, order_code: order.order_code, status: 'rejected', reason: why } };
}

async function approveOrder(db, { orderId, actor, via = 'app' } = {}) {
  return decideOrder(db, { orderId, actor, via, decision: 'approve' });
}

// `reason` is optional here (the dashboard lets the owner leave it blank); the
// WhatsApp side insists on one before calling.
async function rejectOrder(db, { orderId, actor, reason, via = 'app' } = {}) {
  return decideOrder(db, { orderId, actor, via, decision: 'reject', reason });
}

// ── Owner answers a "Price requested for <JC>" alert ─────────────────────────
// Recorded exactly as the order page's "price note" quotation (a quotations row
// with no file — routes/orders.js POST /:id/quotation), then the person who
// asked is told.
async function addPriceNote(db, { orderId, jobCardId, actor, text, via = 'app', requesterId } = {}) {
  const denied = checkRole(actor, ['owner'], 'add prices');
  if (denied) return denied;
  const jcId = toId(jobCardId);
  if (!jcId) return fail('invalid', 'No job card was given for the price.');
  const price = typeof text === 'string' || typeof text === 'number' ? String(text).trim() : '';
  if (!price) return fail('invalid', 'Price note is required — type the price to add.');

  const jc = await db.get(
    `SELECT jc.id, jc.job_card_no, jc.order_id, jc.product_name, jc.drawing_no, o.order_code
       FROM job_cards jc JOIN orders o ON o.id = jc.order_id
      WHERE jc.id = $1`, [jcId]);
  if (!jc) return fail('not_found', `Job card #${jcId} was not found — it may have been deleted.`);

  let oid = jc.order_id;
  if (orderId !== undefined && orderId !== null && orderId !== '') {
    oid = toId(orderId);
    if (oid !== jc.order_id) {
      return fail('invalid', `Job card ${jc.job_card_no} does not belong to that order — it is on order ${jc.order_code}.`);
    }
  }

  // Same rule as the quotation route: a price note without a file is only
  // accepted when a price was asked for on this order.
  const priceReq = await db.get(
    `SELECT id FROM activity_log WHERE order_id = $1 AND activity_type = 'price_requested' LIMIT 1`, [oid]);
  if (!priceReq) {
    return fail('invalid', `No price was requested for order ${jc.order_code}, so there is nothing to answer. Add the quotation from the order page.`);
  }

  const itemLabel = jc.product_name || jc.drawing_no || jc.job_card_no;
  const base = `JC ${jc.job_card_no} (${itemLabel}): ${price}`;
  const note = base + (via === 'whatsapp' ? ' — via WhatsApp' : '');

  const result = await db.withTransaction(async (client) => {
    const q = (sql, p) => client.query(sql, p);
    // One answer at a time per job card, so two identical replies landing
    // together cannot both pass the duplicate check below.
    await q('SELECT pg_advisory_xact_lock($1::int, $2::int)', [LOCK_PRICE_NOTE, jcId]);
    const dup = (await q(
      `SELECT q.id, q.created_at, u.name AS by_name
         FROM quotations q LEFT JOIN users u ON u.id = q.uploaded_by
        WHERE q.order_id = $1 AND q.notes = ANY($2::text[])
          AND q.created_at > NOW() - INTERVAL '10 minutes'
        ORDER BY q.id DESC LIMIT 1`,
      [oid, [base, base + ' — via WhatsApp']])).rows[0];
    if (dup) return { dup };
    const ins = await q(
      `INSERT INTO quotations (order_id, file_path, file_name, sent_date, notes, uploaded_by)
       VALUES ($1, NULL, NULL, NULL, $2, $3) RETURNING id`, [oid, note, actor.id]);
    await logActivityTx(q, oid, jcId, 'quotation_uploaded',
      `Quotation uploaded — price note for ${jc.job_card_no}` + viaTag(via), actor.id);
    return { quotationId: ins.rows[0].id };
  });

  if (result.dup) {
    const by = result.dup.by_name ? ` by ${result.dup.by_name}` : '';
    return fail('already_done',
      `That price for job card ${jc.job_card_no} was already added${by} a few minutes ago — it is on order ${jc.order_code}.`,
      { orderId: oid, jobCardId: jcId, quotationId: result.dup.id });
  }

  // Tell whoever asked for the price. When the caller does not say who that
  // was, it is the person who raised the latest price request for this card.
  let requester = toId(requesterId);
  if (!requester) {
    const req = await db.get(
      `SELECT created_by FROM activity_log
        WHERE job_card_id = $1 AND activity_type = 'price_requested'
        ORDER BY created_at DESC, id DESC LIMIT 1`, [jcId]);
    requester = toId(req?.created_by);
  }
  let notified = null;
  if (requester && requester !== Number(actor.id)) {
    try {
      const u = await db.get('SELECT id FROM users WHERE id = $1', [requester]);
      if (u) {
        await createNotification(db, {
          userId: requester,
          type: 'price_added',
          title: `Price added for ${jc.job_card_no}`,
          body: note,
          link: `/orders/${oid}`,
          sourceUserId: actor.id,
        });
        notified = requester;
      }
    } catch (e) {
      // The price is already recorded; a failed alert must not undo or hide that.
      console.error('[orders] price_added notification failed:', e.message);
    }
  }

  return { ok: true,
    summary: `Added the price for job card ${jc.job_card_no} (${itemLabel}) on order ${jc.order_code}: ${price}`,
    data: { orderId: oid, jobCardId: jcId, quotationId: result.quotationId, note, notified } };
}

// ── A message in an order's chat ──────────────────────────────────────────────
// Numbers only (numeric strings accepted), de-duplicated, at most 25.
function cleanMentionIds(v) {
  let a = v;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = []; } }
  if (!Array.isArray(a)) return [];
  const out = [];
  for (const x of a) {
    if (typeof x !== 'number' && !(typeof x === 'string' && /^\s*\d+\s*$/.test(x))) continue;
    const n = toId(x);
    if (n && !out.includes(n)) out.push(n);
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}

// `attachments` are the uploaded files as the chat upload middleware leaves
// them on req.files: { storagePath, originalname, size, mimetype }.
async function postOrderMessage(db, { orderId, actor, message, mentionIds, via = 'app', attachments } = {}) {
  const denied = checkRole(actor, null, 'post in the order chat'); // any signed-in user
  if (denied) return denied;
  const id = toId(orderId);
  if (!id) return fail('invalid', 'No order was given for the message.');

  const files = Array.isArray(attachments) ? attachments : [];
  const hasFiles = files.length > 0;
  const raw = typeof message === 'string' || typeof message === 'number' ? String(message) : '';
  if (!raw.trim() && !hasFiles) return fail('invalid', 'Message or attachment required');

  const order = await db.get('SELECT id, order_code FROM orders WHERE id = $1', [id]);
  if (!order) return fail('not_found', `Order #${id} was not found — it may have been deleted.`);
  const orderCode = order.order_code || `Order #${id}`;

  const text = (raw.trim() + viaTag(via)).trim();
  const actorId = Number(actor.id);

  // Mentioned people: cleaned, never the author, and only real users (an
  // unknown id would otherwise break the whole post).
  let mentioned = cleanMentionIds(mentionIds).filter(uid => uid !== actorId);
  if (mentioned.length) {
    const rows = await db.all('SELECT id FROM users WHERE id = ANY($1::int[])', [mentioned]);
    const real = new Set(rows.map(r => Number(r.id)));
    mentioned = mentioned.filter(uid => real.has(uid));
  }

  const result = await db.withTransaction(async (client) => {
    const q = (sql, p) => client.query(sql, p);
    if (via === 'whatsapp') {
      // A WhatsApp reply delivered twice must not post twice.
      await q('SELECT pg_advisory_xact_lock($1::int, $2::int)', [LOCK_ORDER_CHAT, id]);
      const dup = (await q(
        `SELECT id FROM order_messages
          WHERE order_id = $1 AND user_id = $2 AND message = $3
            AND created_at > NOW() - INTERVAL '2 minutes'
          ORDER BY id DESC LIMIT 1`, [id, actorId, text])).rows[0];
      if (dup) return { dup };
    }
    const m = await q(
      'INSERT INTO order_messages (order_id, user_id, message) VALUES ($1,$2,$3) RETURNING id',
      [id, actorId, text]);
    const messageId = m.rows[0].id;
    for (const f of files) {
      await q(
        'INSERT INTO message_attachments (message_id, file_path, file_name, file_size, mime_type) VALUES ($1,$2,$3,$4,$5)',
        [messageId, f.storagePath, f.originalname, f.size, f.mimetype]);
    }
    for (const uid of mentioned) {
      await q(
        'INSERT INTO message_mentions (message_id, order_id, mentioned_user_id) VALUES ($1,$2,$3)',
        [messageId, id, uid]);
    }
    return { messageId };
  });

  if (result.dup) {
    return fail('already_done', `That message is already in the ${orderCode} chat — it was posted a moment ago.`,
      { orderId: id, messageId: result.dup.id });
  }

  if (mentioned.length) {
    const preview = text.slice(0, 100);
    const fileNote = hasFiles ? ` [+${files.length} file${files.length > 1 ? 's' : ''}]` : '';
    for (const uid of mentioned) {
      try {
        await createNotification(db, {
          userId: uid,
          type: 'order_message',
          title: `${actor.name} in ${orderCode}`,
          body: preview ? preview + fileNote : `Sent${fileNote}`,
          link: `/orders/${id}`,
          sourceUserId: actorId,
          ref: { type: 'order_thread', id },
        });
      } catch (e) {
        // The message is already posted; one failed alert must not fail it.
        console.error('[orders] mention notification failed:', e.message);
      }
    }
  }

  const who = mentioned.length ? ` mentioning ${mentioned.length} ${mentioned.length === 1 ? 'person' : 'people'}` : '';
  return { ok: true,
    summary: `Posted a message in the ${orderCode} chat${who}`,
    data: { id: result.messageId, orderId: id, mentioned } };
}

module.exports = {
  approveOrder,
  rejectOrder,
  addPriceNote,
  postOrderMessage,
  cleanMentionIds,
  WAITING_STATUS,
};
