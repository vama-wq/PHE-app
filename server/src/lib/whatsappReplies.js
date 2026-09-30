// The owner's WhatsApp replies, acted on in the app (owner's request and
// decisions, 30 Sep 2026).
//
//   • An approval alert: "yes" (or the Approve button) approves; "no" (or
//     Reject) rejects — when the app needs a reason, WhatsApp asks for one first.
//   • A rate increase: "no" is posted in the purchase order's chat for the buyer.
//   • A price request: the reply with the price is saved on the order.
//   • An @mention: the reply is posted in that chat as the owner, marked
//     "(via WhatsApp)".
//
// Safety, in order:
//   1. Meta's signature is checked before anything reaches here (routes/whatsapp.js).
//   2. Every incoming message is stored once (UNIQUE message id) before Meta is
//      answered: a message delivered twice is acted on once, and one stored
//      just before a restart is picked up afterwards (processPending).
//   3. Only a number the owner has proved they hold (whatsapp_verified_at) can
//      act, and only while that user is an owner with WhatsApp alerts on.
//   4. A reply acts only on the alert it is tied to — the button tapped or the
//      message swipe-replied to. A loose "yes" is never guessed, and only a
//      plain yes or no counts: "ok but reduce qty", "no problem", "yes?" are
//      asked again, never acted on.
//   5. A reply that reached us hours late, or an alert over a week old, does
//      nothing. An alert replaced by a newer one about the same thing (a
//      resubmission) can no longer be answered, and a rate increase whose
//      lines changed after the alert is not approved from the old alert.
//   6. One answer per alert: the alert is claimed before acting, and the action
//      itself re-checks the item is still waiting ("first one wins" guard in
//      services/actions/*), so a dashboard click and a reply cannot both act.
//   7. Removing an inventory item always asks for a confirming reply first.
//   8. Everything is written to the activity log as done via WhatsApp.

const dbmod = require('../db');
const wa = require('./whatsapp');

const LATE_HOURS = 3;             // a reply older than this does nothing
const PROMPT_MINUTES = 30;        // a swipe-reply to the app's "why?" question
const PROMPT_LOOSE_MINUTES = 10;  // a plain typed answer to it
const ALERT_MAX_DAYS = 7;         // an approval alert older than this is not acted on

// ── Reading yes / no ──────────────────────────────────────────────────────────
// Only a plain answer counts: "yes", "ok go ahead", "haan ji", "no", "nahi",
// "no, too costly". Anything that qualifies, questions or contradicts itself
// ("ok but reduce qty", "no problem", "yes?", "theek nahi hai", "approve only
// 10") is not guessed — the app asks again and nothing is done.
const YES_WORDS = new Set(['yes', 'y', 'yeah', 'yep', 'yup', 'ya', 'ok', 'okay', 'okk', 'k', 'approve', 'approved',
  'accept', 'accepted', 'agree', 'agreed', 'confirm', 'confirmed', 'done', 'sure', 'fine', 'go', 'ahead', 'proceed',
  'haan', 'han', 'haa', 'ha', 'theek', 'thik', 'chalega', 'chale', 'barabar']);
const NO_WORDS = new Set(['no', 'n', 'nope', 'nah', 'reject', 'rejected', 'decline', 'declined', 'deny', 'denied',
  'nahi', 'nai', 'na', 'mat', 'nathi', 'nako']);
const FILLER = new Set(['please', 'pls', 'plz', 'sir', 'ji', 'hai', 'he', 'che', 'chhe', 'it', 'this', 'bhai', 'boss']);
const CANCEL = /^\s*(cancel|stop|wait|leave( it)?|skip|undo|never ?mind|rehne do|chhodo|ruko)\b/i;
// A question back ("which one is this") is not a reason either.
const QUESTION = /^\s*(which|what|who|why|when|where|how|kaun|kaunsa|konsa|kya|kyu|kyun|kyon|kab|kahan|kaise|kayu|shu)\b/i;
// Putting it off is not a reason — it cancels the question.
const DEFER = /\b(not now|later|hold on|abhi nahi|ek min|one min|wait|baad me|baad mein|kal|ruk|ruko)\b/i;

function words(s) {
  return String(s || '').toLowerCase().split(/\s+/).map(w => w.replace(/[^\p{L}\p{N}']/gu, '')).filter(Boolean);
}
// Every word is an answer word (or filler), and at least one is an answer word.
const allOf = (ws, set) => ws.length > 0 && ws.some(w => set.has(w)) && ws.every(w => set.has(w) || FILLER.has(w));

function intentOf(text) {
  const t = String(text || '').trim().replace(/\bnot approved\b/i, 'no');
  if (!t || t.includes('?')) return { intent: null, rest: t };
  // "no, too costly" / "reject: wrong unit" — the answer, then a reason.
  const m = t.match(/^([^,:;.\n\-–—]*)[,:;.\n\-–—]+\s*([\s\S]*)$/);
  const head = words(m ? m[1] : t);
  const tail = m ? m[2].trim() : '';
  const tw = words(tail);
  if (allOf(head, YES_WORDS)) {
    // "ok, go ahead" is still a yes; "ok, but check the rate" is not.
    return (tw.length === 0 || allOf(tw, YES_WORDS)) ? { intent: 'yes', rest: '' } : { intent: null, rest: t };
  }
  if (allOf(head, NO_WORDS)) {
    // "no, ok" contradicts itself; "no, wait" / "na, abhi ruk" is not a decision yet.
    if (tw.length && allOf(tw, YES_WORDS)) return { intent: null, rest: t };
    if (CANCEL.test(tail) || /\b(ruk|ruko|wait|later|baad|kal)\b/i.test(tail)) return { intent: null, rest: t };
    return { intent: 'no', rest: tail };
  }
  return { intent: null, rest: t };
}
const startsLikeYes = (text) => YES_WORDS.has(words(text)[0] || '');

// Which service action answers which kind of alert. Loaded lazily so a
// missing piece degrades to "open the app" instead of breaking the webhook.
function svc(name) {
  try { return require(`../services/actions/${name}`); } catch (_) { return null; }
}

const LABEL = {
  inventory_item: 'new inventory item',
  split_request: 'partial dispatch request',
  po_rate: 'rate increase',
  po_over: 'extra quantity',
  capa: 'CAPA report',
  order_approval: 'order',
};

// What a "no" needs before it can act.
const NO_NEEDS_REASON = {
  inventory_item: 'Rejecting permanently removes this item. Reply with the reason to confirm, or reply cancel.',
  split_request: 'Why are you rejecting it? Your reason goes to the person who asked. Reply cancel to stop.',
  capa: 'What is missing? Your note goes to the team with the CAPA report. Reply cancel to stop.',
  order_approval: 'Why are you rejecting the order? Your reason is shown to the team. Reply cancel to stop.',
};
// A "no" that deletes something is always confirmed, even with a reason given.
const CONFIRM_ALWAYS = new Set(['inventory_item']);

async function runDecision(db, row, intent, reason, actor) {
  const id = row.ref_id;
  switch (row.ref_type) {
    case 'inventory_item': {
      const s = svc('inventory'); if (!s) return null;
      return intent === 'yes'
        ? s.approveInventoryItem(db, { itemId: id, actor, via: 'whatsapp' })
        : s.rejectInventoryItem(db, { itemId: id, actor, reason, via: 'whatsapp' });
    }
    case 'split_request': {
      const s = svc('splitRequests'); if (!s) return null;
      return intent === 'yes'
        ? s.approveSplitRequest(db, { requestId: id, actor, via: 'whatsapp', refuseIfOnHold: true })
        : s.rejectSplitRequest(db, { requestId: id, actor, reason, via: 'whatsapp' });
    }
    case 'po_rate': {
      const s = svc('purchaseOrders'); if (!s) return null;
      return intent === 'yes'
        ? s.approveRateIncrease(db, { poId: id, actor, via: 'whatsapp', expectSnapshot: row.ref_snapshot ?? undefined })
        : s.declineRateIncrease(db, { poId: id, actor, note: reason || null, via: 'whatsapp' });
    }
    case 'po_over': {
      const s = svc('purchaseOrders'); if (!s) return null;
      const expectOverQty = row.ref_snapshot != null && row.ref_snapshot !== '' ? Number(row.ref_snapshot) : undefined;
      return s.decideOverReceipt(db, { poItemId: id, approve: intent === 'yes', actor, via: 'whatsapp', expectOverQty });
    }
    case 'capa': {
      const s = svc('capa'); if (!s) return null;
      return intent === 'yes'
        ? s.approveCapa(db, { capaId: id, actor, via: 'whatsapp' })
        : s.sendBackCapa(db, { capaId: id, actor, note: reason, via: 'whatsapp' });
    }
    case 'order_approval': {
      const s = svc('orders'); if (!s) return null;
      return intent === 'yes'
        ? s.approveOrder(db, { orderId: id, actor, via: 'whatsapp' })
        : s.rejectOrder(db, { orderId: id, actor, reason, via: 'whatsapp' });
    }
    default: return null;
  }
}

async function runThreadReply(db, row, text, actor) {
  const mentionIds = row.source_user_id ? [row.source_user_id] : [];
  if (row.ref_type === 'order_thread') { const s = svc('orders'); return s && s.postOrderMessage(db, { orderId: row.ref_id, actor, message: text, mentionIds, via: 'whatsapp' }); }
  if (row.ref_type === 'po_thread') { const s = svc('purchaseOrders'); return s && s.postPoMessage(db, { poId: row.ref_id, actor, message: text, mentionIds, via: 'whatsapp' }); }
  if (row.ref_type === 'query_thread') { const s = svc('customerQueries'); return s && s.postQueryMessage(db, { queryId: row.ref_id, actor, message: text, mentionIds, via: 'whatsapp' }); }
  return null;
}

// ── helpers ───────────────────────────────────────────────────────────────────
async function reply(db, user, text, inboundId, extra = {}) {
  const r = await wa.sendText(user.whatsapp_number, text, inboundId);
  try {
    // A question that never reached the owner must not wait for an answer.
    const state = extra.state && !r.ok ? 'unsent' : (extra.state || null);
    await db.run(
      `INSERT INTO whatsapp_outbox (user_id, to_number, type, title, body, status, attempts, last_error, wa_message_id, sent_at,
                                    parent_outbox_id, action_state, action_note)
       VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12)`,
      [user.id, user.whatsapp_number, extra.type || 'reply', String(text).split('\n')[0].slice(0, 200), text,
       r.ok ? 'accepted' : 'failed', r.ok ? null : r.error, r.ok ? r.id : null, r.ok ? new Date() : null,
       extra.parent || null, state, extra.note || null]);
  } catch (e) { console.error('WhatsApp reply log failed:', e.message); }
  return r;
}

async function markActed(db, row, note) {
  await db.run(`UPDATE whatsapp_outbox SET action_state='done', action_note=$2, acted_at=NOW() WHERE id=$1`, [row.id, String(note).slice(0, 500)]);
  if (row.notification_id) {
    await db.run('UPDATE notifications SET is_read=1 WHERE id=$1 AND user_id=$2', [row.notification_id, row.user_id]).catch(() => {});
  }
}

const openLink = (row) => (row?.link ? `\nOpen it here: ${wa.fullLink(row.link)}` : '');
const ageMs = (row) => Date.now() - new Date(row.created_at).getTime();

// Why an alert cannot be answered right now, or null if it can.
function closedReason(row) {
  if (row.action_state === 'superseded') return { result: 'superseded', text: `A newer alert about this replaced that one — please answer the latest alert.${openLink(row)}` };
  if (row.action_state === 'done') return { result: 'already answered', text: `You already answered this alert: ${row.action_note || 'done'}.` };
  // A claim older than 10 minutes was interrupted (a restart) — the alert is open again.
  if (row.action_state === 'acting' && !(row.acted_at && Date.now() - new Date(row.acted_at).getTime() > 10 * 60e3)) {
    return { result: 'still acting', text: 'Your earlier answer to this alert is still being handled — nothing more was done.' };
  }
  return null;
}

// Claim the alert, act, and report. The claim means two answers to one alert
// (a tap and a swipe-reply landing together) cannot both act.
async function act(db, user, m, row, fn, done) {
  const claim = await db.get(
    `UPDATE whatsapp_outbox SET action_state='acting', acted_at=NOW()
      WHERE id=$1 AND (action_state IS NULL OR (action_state='acting' AND acted_at < NOW() - INTERVAL '10 minutes'))
      RETURNING id`, [row.id]);
  if (!claim) {
    const now = await db.get('SELECT * FROM whatsapp_outbox WHERE id=$1', [row.id]);
    const c = closedReason(now || row) || { result: 'not claimed', text: 'This alert is being handled — nothing more was done.' };
    await reply(db, user, c.text, m.id);
    return done(c.result, row.id);
  }
  // Not finished (refused, invalid, an error) → the alert can be answered again.
  // Only 'acting' is cleared, so a 'done' or 'superseded' set meanwhile stays.
  try {
    return await finish(db, user, m, row, await fn(), done);
  } finally {
    await db.run(`UPDATE whatsapp_outbox SET action_state=NULL WHERE id=$1 AND action_state='acting'`, [row.id]).catch(() => {});
  }
}

// ── storing what Meta sends ───────────────────────────────────────────────────
// Stored before Meta is answered (routes/whatsapp.js), so nothing received is
// ever lost; returns the ids of messages not seen before.
async function storeInbound(payload) {
  const msgs = [];
  for (const entry of payload?.entry || []) {
    for (const ch of entry?.changes || []) {
      const v = ch?.value || {};
      for (const m of v.messages || []) if (m?.id) msgs.push({ m, pid: v.metadata?.phone_number_id || null });
    }
  }
  if (!msgs.length) return [];
  await wa.ensureSchema();
  const db = dbmod.getDB();
  const ids = [];
  for (const { m, pid } of msgs) {
    const kind = m.type;
    const text = kind === 'text' ? String(m.text?.body || '') : kind === 'button' ? String(m.button?.text || '') : '';
    const payloadId = kind === 'button' ? String(m.button?.payload || '')
      : kind === 'interactive' ? String(m.interactive?.button_reply?.id || m.interactive?.list_reply?.id || '') : '';
    const r = await db.get(
      `INSERT INTO whatsapp_inbox (wa_message_id, from_number, kind, text, context_id, payload, sent_at, raw, phone_number_id)
       VALUES ($1,$2,$3,$4,$5,$6, to_timestamp($7), $8::jsonb, $9)
       ON CONFLICT (wa_message_id) DO NOTHING RETURNING id`,
      [m.id, m.from || null, kind || null, text || null, m.context?.id || null, payloadId || null,
       Number(m.timestamp) || Date.now() / 1000, JSON.stringify(m), pid]);
    if (r) ids.push(r.id);
  }
  return ids;
}

// Act on stored messages, each once (claimed by setting result).
async function processStored(ids) {
  const db = dbmod.getDB();
  let n = 0;
  for (const id of ids) {
    const ins = await db.get(`UPDATE whatsapp_inbox SET result='processing' WHERE id=$1 AND result IS NULL RETURNING *`, [id]);
    if (!ins) continue;
    try {
      const r = await handleStored(db, ins);
      console.log(`WhatsApp reply ${ins.wa_message_id}: ${r}`);
      n++;
    } catch (e) {
      console.error('WhatsApp reply failed:', e);
      try {
        await db.run('UPDATE whatsapp_inbox SET result=$2 WHERE id=$1', [ins.id, 'error: ' + String(e.message).slice(0, 400)]);
        const u = await db.get('SELECT id, whatsapp_number FROM users WHERE whatsapp_number=$1 AND whatsapp_verified_at IS NOT NULL', [String(ins.from_number || '').replace(/\D/g, '')]);
        if (u) await wa.sendText(u.whatsapp_number, 'Something went wrong handling your reply. Please check in the app whether it was done.', ins.wa_message_id);
      } catch (_) { /* nothing more to do */ }
    }
  }
  return n;
}

// Messages stored but never acted on (a restart between storing and acting).
// The late-reply rule still applies to them.
let pendingRunning = false;
async function processPending() {
  if (pendingRunning) return 0;
  pendingRunning = true;
  try {
    const rows = await dbmod.getDB().all(
      `SELECT id FROM whatsapp_inbox
        WHERE result IS NULL AND raw IS NOT NULL
          AND received_at < NOW() - INTERVAL '1 minute' AND received_at > NOW() - INTERVAL '${LATE_HOURS} hours'
        ORDER BY id LIMIT 20`);
    return rows.length ? await processStored(rows.map(r => r.id)) : 0;
  } finally { pendingRunning = false; }
}

// ── one incoming message ──────────────────────────────────────────────────────
async function handleStored(db, ins) {
  const done = async (result, outboxId) => {
    await db.run('UPDATE whatsapp_inbox SET result=$2, outbox_id=COALESCE($3, outbox_id) WHERE id=$1', [ins.id, String(result).slice(0, 500), outboxId || null]);
    return result;
  };
  const m = ins.raw || {};
  const c = wa.cfg();
  if (c.phoneId && ins.phone_number_id && String(ins.phone_number_id) !== c.phoneId) return done('ignored: other sender number');
  const kind = ins.kind;
  const text = ins.text || '';
  const payload = ins.payload || '';
  const contextId = ins.context_id || null;

  // Who is it?
  const user = await db.get(
    `SELECT id, name, role, whatsapp_number, whatsapp_enabled, whatsapp_verified_at, whatsapp_verify_code, whatsapp_verify_expires
       FROM users WHERE whatsapp_number=$1 ORDER BY id LIMIT 1`, [String(ins.from_number || '').replace(/\D/g, '')]);
  if (!user) return done('ignored: unknown number');
  await db.run('UPDATE whatsapp_inbox SET user_id=$2 WHERE id=$1', [ins.id, user.id]);

  // Proving the number: the code shown on Account Settings, sent from this phone.
  const code = String(text).trim().toUpperCase().replace(/\s+/g, '');
  if (user.whatsapp_verify_code && code && code === String(user.whatsapp_verify_code).toUpperCase()) {
    if (user.whatsapp_verify_expires && new Date(user.whatsapp_verify_expires) < new Date()) {
      await reply(db, user, 'That code has expired. Make a new one in the app: Account Settings → WhatsApp alerts → Confirm my number.', m.id);
      return done('verify: expired code');
    }
    await db.run(`UPDATE users SET whatsapp_verified_at=NOW(), whatsapp_verify_code=NULL, whatsapp_verify_expires=NULL WHERE id=$1`, [user.id]);
    await reply(db, user, '✅ Your number is confirmed. You can now answer PHE app alerts from WhatsApp: tap a button or swipe-reply to the alert.', m.id);
    await dbmod.logActivity(null, null, 'whatsapp_verified', `WhatsApp number …${String(user.whatsapp_number).slice(-4)} confirmed for replies`, user.id);
    return done('verified');
  }
  if (user.role !== 'owner') return done('ignored: not an owner');
  if (!user.whatsapp_verified_at) {
    await reply(db, user, 'Replies from this number are not switched on yet. In the app, go to Account Settings → WhatsApp alerts → Confirm my number.', m.id);
    return done('ignored: number not confirmed');
  }
  if (!user.whatsapp_enabled) {
    await reply(db, user, 'WhatsApp alerts are switched off for you in the app, so replies do nothing. Switch them on in Account Settings.', m.id);
    return done('ignored: alerts off');
  }

  // Too late?
  const sentAt = ins.sent_at ? new Date(ins.sent_at) : new Date();
  if (Date.now() - sentAt.getTime() > LATE_HOURS * 3600e3) {
    await reply(db, user, `This reply reached the app late (you sent it ${sentAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}), so nothing was done. Please reply again or open the app.`, m.id);
    return done('late: nothing done');
  }

  if (kind === 'reaction') return done('ignored: reaction');
  if (!['text', 'button', 'interactive'].includes(kind)) {
    await reply(db, user, 'Only text replies and the buttons are understood for now. Nothing was done.', m.id);
    return done('ignored: ' + kind);
  }

  const actor = { id: user.id, name: user.name, role: user.role };

  // Which alert is this about?
  let row = null, forced = null, prompt = null, loose = false;
  const pm = payload.match(/^ob:(\d+):(yes|no)$/);
  if (pm) {
    row = await db.get('SELECT * FROM whatsapp_outbox WHERE id=$1 AND user_id=$2', [Number(pm[1]), user.id]);
    forced = pm[2];
    if (row && contextId && row.wa_message_id && row.wa_message_id !== contextId) row = null;
  } else if (contextId) {
    const quoted = await db.get('SELECT * FROM whatsapp_outbox WHERE wa_message_id=$1 AND user_id=$2', [contextId, user.id]);
    if (quoted && quoted.type === 'prompt') { prompt = quoted; }
    else row = quoted;
  } else {
    // A plain typed message only ever answers the one question the app just
    // asked — never an alert, and not when more than one question is open.
    const open = await db.all(
      `SELECT * FROM whatsapp_outbox WHERE user_id=$1 AND type='prompt' AND action_state='awaiting'
          AND created_at > NOW() - INTERVAL '${PROMPT_LOOSE_MINUTES} minutes' ORDER BY id DESC`, [user.id]);
    if (open.length > 1) {
      await reply(db, user, `You have ${open.length} questions from the app open. Swipe-reply to the one you are answering. Nothing was done.`, m.id);
      return done('prompt: several open');
    }
    prompt = open[0] || null;
    loose = true;
  }

  // The answer to a "why?" / "are you sure?" question.
  if (prompt) return answerPrompt(db, user, m, prompt, text, loose, actor, done);

  if (!row) {
    await reply(db, user, 'Please swipe-reply to the alert you are answering (hold the message, then Reply), or tap its button, so I know which one you mean. Nothing was done.', m.id);
    return done('no target');
  }

  const replyKind = wa.REPLY_KIND[row.ref_type];
  const closed = closedReason(row);
  // A price may be sent again to correct it; everything else is answered once.
  if (closed && !(replyKind === 'price' && row.action_state === 'done')) {
    await reply(db, user, closed.text, m.id);
    return done(closed.result, row.id);
  }

  // Chat threads: the words go into the chat.
  if (replyKind === 'thread') {
    const said = String(text).trim();
    if (!said) return done('empty', row.id);
    return finish(db, user, m, row, await runThreadReply(db, row, said, actor), done, { keepOpen: true });
  }

  // Price requests: the reply must start with the amount ("12500 per pc",
  // "₹12,500 each") — "will check in 10 min" is not a price.
  if (replyKind === 'price') {
    const said = String(text).trim();
    const amount = /^(₹|rs\.?|inr)?\s*\d[\d,]*(\.\d+)?/i;
    const timeNotPrice = /^(₹|rs\.?|inr)?\s*\d[\d,]*(\.\d+)?\s*(min|mins|minute|minutes|hr|hrs|hour|hours|ghanta|ghante|day|days|din|week|weeks|baje|am|pm|o'?clock)\b/i;
    if (!amount.test(said) || timeNotPrice.test(said)) {
      await reply(db, user, /\d/.test(said)
        ? 'Nothing was saved. To add the price, swipe-reply starting with the amount, e.g. 12500 per pc.'
        : 'I did not see a price. Swipe-reply to the alert with the amount, e.g. 12500 per pc.', m.id);
      return done('price: not a price', row.id);
    }
    const s = svc('orders');
    const r = s ? await s.addPriceNote(db, { orderId: row.ref_parent, jobCardId: row.ref_id, actor, text: said, via: 'whatsapp', requesterId: row.source_user_id }) : null;
    return finish(db, user, m, row, r, done);
  }

  // Decisions.
  if (replyKind === 'decide') {
    if (ageMs(row) > ALERT_MAX_DAYS * 86400e3) {
      await reply(db, user, `This alert is over a week old, so it can't be answered from WhatsApp — please decide in the app.${openLink(row)}`, m.id);
      return done('alert too old', row.id);
    }
    let intent = forced, rest = '';
    if (!intent) ({ intent, rest } = intentOf(text));
    if (!intent) {
      const [y, n] = row.ref_type === 'po_over' ? ['yes to keep the extra', 'no for only the ordered quantity'] : ['yes to approve', 'no to reject'];
      await reply(db, user, `I couldn't tell if that was a yes or a no, so nothing was done. Please reply just ${y}, or ${n} — or tap a button.${openLink(row)}`, m.id);
      return done('decision: not understood', row.id);
    }
    // A rate increase whose lines changed after this alert went out.
    if (row.ref_type === 'po_rate' && row.ref_snapshot != null) {
      const s = svc('purchaseOrders');
      if (s && (await s.rateSnapshot(db, row.ref_id)) !== row.ref_snapshot) {
        await markActed(db, row, 'The lines changed after this alert — decide in the app');
        await reply(db, user, `⚠️ The lines on this purchase order changed after this alert was sent, so nothing was done. Please look at the new rates in the app.${openLink(row)}`, m.id);
        return done('po_rate: lines changed', row.id);
      }
    }
    if (intent === 'no' && NO_NEEDS_REASON[row.ref_type] && (!rest || CONFIRM_ALWAYS.has(row.ref_type))) {
      // One open question per alert.
      await db.run(`UPDATE whatsapp_outbox SET action_state='cancelled' WHERE parent_outbox_id=$1 AND type='prompt' AND action_state='awaiting'`, [row.id]);
      const ask = rest
        ? `You're rejecting the ${LABEL[row.ref_type]}: ${row.title} — reason: "${rest.slice(0, 200)}".\nThis permanently removes it. Reply yes to confirm, or cancel.`
        : `You're saying no to the ${LABEL[row.ref_type]}: ${row.title}.\n${NO_NEEDS_REASON[row.ref_type]}`;
      const q = await reply(db, user, ask, m.id, { type: 'prompt', parent: row.id, state: 'awaiting', note: JSON.stringify({ reason: rest || null }) });
      return done(q.ok ? 'asked for a reason' : 'could not ask for a reason', row.id);
    }
    return act(db, user, m, row, () => runDecision(db, row, intent, rest || null, actor), done);
  }

  await reply(db, user, `This alert can't be answered from WhatsApp — please open it in the app.${openLink(row)}`, m.id);
  return done('not answerable', row.id);
}

async function answerPrompt(db, user, m, prompt, text, loose, actor, done) {
  const window = loose ? PROMPT_LOOSE_MINUTES : PROMPT_MINUTES;
  if (prompt.action_state !== 'awaiting' || Date.now() - new Date(prompt.created_at).getTime() > window * 60e3) {
    await reply(db, user, 'That question has closed. Please answer the original alert again.', m.id);
    return done('prompt closed', prompt.id);
  }
  const row = await db.get('SELECT * FROM whatsapp_outbox WHERE id=$1 AND user_id=$2', [prompt.parent_outbox_id, user.id]);
  if (!row) return done('prompt without alert', prompt.id);
  const said = String(text).trim();
  const it = intentOf(said);
  // "cancel", "wait", "no", "nahi", "later", "not now", "abhi nahi" — stop.
  if (CANCEL.test(said) || (it.intent === 'no' && !it.rest) || DEFER.test(said)) {
    await db.run(`UPDATE whatsapp_outbox SET action_state='cancelled' WHERE id=$1`, [prompt.id]);
    await reply(db, user, 'Cancelled — nothing was changed.', m.id);
    return done('cancelled', row.id);
  }
  let saved = {};
  try { saved = JSON.parse(prompt.action_note || '{}') || {}; } catch (_) { saved = {}; }
  let reason;
  if (saved.reason) {
    // "Reply yes to confirm": only a plain yes confirms.
    if (it.intent !== 'yes') {
      await reply(db, user, 'Nothing was done. Reply yes to confirm, or cancel.', m.id);
      return done('prompt: not confirmed', row.id);
    }
    reason = saved.reason;
  } else if (it.intent === 'yes' || startsLikeYes(said) || said.includes('?') || QUESTION.test(said)) {
    // "ok" / "Ok send it" / "which one?" is not a reason — likely meant for something else.
    await reply(db, user, 'That needs the reason in a few words, or reply cancel. Nothing was done.', m.id);
    return done('prompt: not a reason', row.id);
  } else {
    reason = said;
  }
  if (String(reason).replace(/[^\p{L}]/gu, '').length < 3) {
    await reply(db, user, 'Please reply with the reason in a few words, or cancel. Nothing was done.', m.id);
    return done('prompt: reason too short', row.id);
  }
  const closed = closedReason(row);
  if (closed) {
    await db.run(`UPDATE whatsapp_outbox SET action_state='cancelled' WHERE id=$1`, [prompt.id]);
    await reply(db, user, closed.text, m.id);
    return done(closed.result, row.id);
  }
  await db.run(`UPDATE whatsapp_outbox SET action_state='answered' WHERE id=$1`, [prompt.id]);
  return act(db, user, m, row, () => runDecision(db, row, 'no', reason, actor), done);
}

async function finish(db, user, m, row, r, done, opts = {}) {
  if (!r) {
    await reply(db, user, `This can't be done from WhatsApp yet — please open it in the app.${openLink(row)}`, m.id);
    return done('no action available', row.id);
  }
  if (r.ok) {
    if (!opts.keepOpen) await markActed(db, row, r.summary);
    await reply(db, user, `✅ ${r.summary}`, m.id);
    return done('ok: ' + r.summary, row.id);
  }
  if (r.code === 'already_done') await markActed(db, row, r.message);
  await reply(db, user, `⚠️ ${r.message}${['blocked', 'invalid', 'not_found'].includes(r.code) ? openLink(row) : ''}`, m.id);
  return done(`${r.code}: ${r.message}`, row.id);
}

// Entry point for a (signed) Meta payload when storing and acting happen
// together — the webhook stores first and acts after answering Meta.
async function handleInbound(payload) {
  return processStored(await storeInbound(payload));
}

module.exports = { handleInbound, storeInbound, processStored, processPending, intentOf };
