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
//   2. Every incoming message is stored once (UNIQUE message id): a message
//      Meta delivers twice is acted on once.
//   3. Only a number the owner has proved they hold (whatsapp_verified_at) can
//      act, and only while that user is an owner with WhatsApp alerts on.
//   4. A reply acts only on the alert it is tied to — the button tapped or the
//      message swipe-replied to. A loose "yes" is never guessed.
//   5. A reply that reached us hours late does nothing.
//   6. The action itself re-checks that the item is still waiting ("first one
//      wins" guard in services/actions/*), so a dashboard click and a reply
//      landing together cannot both act.
//   7. Everything is written to the activity log as done via WhatsApp.

const dbmod = require('../db');
const wa = require('./whatsapp');

const LATE_HOURS = 3;             // a reply older than this does nothing
const PROMPT_MINUTES = 30;        // how long a "why?" question waits for its answer

const YES = /^(yes|y|yeah|yep|yup|ok|okay|k|approve|approved|accept|accepted|agree|confirm|confirmed|done|sure|haan|han|haa|ha|ji|theek|thik|chalega)\b/i;
const NO = /^(no|n|nope|nah|reject|rejected|decline|declined|deny|not approved|nahi|nai|na|mat)\b/i;

function intentOf(text) {
  const t = String(text || '').trim();
  const m = t.match(YES) || t.match(NO);
  if (!m) return { intent: null, rest: t };
  const rest = t.slice(m[0].length).replace(/^[\s,.:;!\-–—]+/, '').trim();
  return { intent: YES.test(t) ? 'yes' : 'no', rest };
}

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
        ? s.approveRateIncrease(db, { poId: id, actor, via: 'whatsapp' })
        : s.declineRateIncrease(db, { poId: id, actor, note: reason || null, via: 'whatsapp' });
    }
    case 'po_over': {
      const s = svc('purchaseOrders'); if (!s) return null;
      return s.decideOverReceipt(db, { poItemId: id, approve: intent === 'yes', actor, via: 'whatsapp' });
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
    await db.run(
      `INSERT INTO whatsapp_outbox (user_id, to_number, type, title, body, status, attempts, last_error, wa_message_id, sent_at,
                                    parent_outbox_id, action_state, action_note)
       VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12)`,
      [user.id, user.whatsapp_number, extra.type || 'reply', String(text).split('\n')[0].slice(0, 200), text,
       r.ok ? 'accepted' : 'failed', r.ok ? null : r.error, r.ok ? r.id : null, r.ok ? new Date() : null,
       extra.parent || null, extra.state || null, extra.note || null]);
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

// ── one incoming message ──────────────────────────────────────────────────────
async function handleMessage(db, m, phoneNumberId) {
  const c = wa.cfg();
  if (c.phoneId && phoneNumberId && String(phoneNumberId) !== c.phoneId) return 'other sender number';
  const kind = m.type;
  const text = kind === 'text' ? String(m.text?.body || '') : kind === 'button' ? String(m.button?.text || '') : '';
  const payload = kind === 'button' ? String(m.button?.payload || '')
    : kind === 'interactive' ? String(m.interactive?.button_reply?.id || m.interactive?.list_reply?.id || '') : '';
  const contextId = m.context?.id || null;

  // 1. Once only.
  const ins = await db.get(
    `INSERT INTO whatsapp_inbox (wa_message_id, from_number, kind, text, context_id, payload, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6, to_timestamp($7))
     ON CONFLICT (wa_message_id) DO NOTHING RETURNING id`,
    [m.id, m.from, kind, text || null, contextId, payload || null, Number(m.timestamp) || Date.now() / 1000]);
  if (!ins) return 'duplicate';
  const done = async (result, outboxId) => {
    await db.run('UPDATE whatsapp_inbox SET result=$2, outbox_id=COALESCE($3, outbox_id) WHERE id=$1', [ins.id, String(result).slice(0, 500), outboxId || null]);
    return result;
  };

  // 2. Who is it?
  const user = await db.get(
    `SELECT id, name, role, whatsapp_number, whatsapp_enabled, whatsapp_verified_at, whatsapp_verify_code, whatsapp_verify_expires
       FROM users WHERE whatsapp_number=$1 ORDER BY id LIMIT 1`, [String(m.from || '').replace(/\D/g, '')]);
  if (!user) return done('ignored: unknown number');
  await db.run('UPDATE whatsapp_inbox SET user_id=$2 WHERE id=$1', [ins.id, user.id]);

  // 3. Proving the number: the code shown on Account Settings, sent from this phone.
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

  // 4. Too late?
  const sentAt = Number(m.timestamp) ? new Date(Number(m.timestamp) * 1000) : new Date();
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

  // 5. Which alert is this about?
  let row = null, forced = null, prompt = null;
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
    // An unquoted message only ever answers the question the app just asked.
    prompt = await db.get(
      `SELECT * FROM whatsapp_outbox WHERE user_id=$1 AND type='prompt' AND action_state='awaiting'
          AND created_at > NOW() - INTERVAL '${PROMPT_MINUTES} minutes' ORDER BY id DESC LIMIT 1`, [user.id]);
  }

  // 5a. The answer to a "why?" question.
  if (prompt) {
    if (prompt.action_state !== 'awaiting' || Date.now() - new Date(prompt.created_at).getTime() > PROMPT_MINUTES * 60e3) {
      await reply(db, user, 'That question has closed. Please answer the original alert again.', m.id);
      return done('prompt closed', prompt.id);
    }
    row = await db.get('SELECT * FROM whatsapp_outbox WHERE id=$1 AND user_id=$2', [prompt.parent_outbox_id, user.id]);
    if (!row) return done('prompt without alert', prompt.id);
    if (/^\s*cancel\s*$/i.test(text)) {
      await db.run(`UPDATE whatsapp_outbox SET action_state='cancelled' WHERE id=$1`, [prompt.id]);
      await reply(db, user, 'Cancelled — nothing was changed.', m.id);
      return done('cancelled', row.id);
    }
    const reason = String(text).trim();
    if (!reason) { await reply(db, user, 'Please reply with a few words, or cancel.', m.id); return done('empty reason', row.id); }
    await db.run(`UPDATE whatsapp_outbox SET action_state='answered' WHERE id=$1`, [prompt.id]);
    return finish(db, user, m, row, await runDecision(db, row, 'no', reason, actor), done);
  }

  if (!row) {
    await reply(db, user, 'Please swipe-reply to the alert you are answering (hold the message, then Reply), or tap its button, so I know which one you mean. Nothing was done.', m.id);
    return done('no target');
  }
  if (row.action_state === 'done') {
    await reply(db, user, `You already answered this alert: ${row.action_note || 'done'}.`, m.id);
    return done('already answered', row.id);
  }

  const replyKind = wa.REPLY_KIND[row.ref_type];

  // 5b. Chat threads: the words go into the chat.
  if (replyKind === 'thread') {
    const words = String(text).trim();
    if (!words) return done('empty', row.id);
    return finish(db, user, m, row, await runThreadReply(db, row, words, actor), done, { keepOpen: true });
  }

  // 5c. Price requests: a price, in the owner's own words.
  if (replyKind === 'price') {
    const words = String(text).trim();
    if (!/\d/.test(words)) {
      await reply(db, user, 'I did not see a price. Swipe-reply to the alert with the amount, e.g. 12500 per pc.', m.id);
      return done('price: no number', row.id);
    }
    const s = svc('orders');
    const r = s ? await s.addPriceNote(db, { orderId: row.ref_parent, jobCardId: row.ref_id, actor, text: words, via: 'whatsapp', requesterId: row.source_user_id }) : null;
    return finish(db, user, m, row, r, done);
  }

  // 5d. Decisions.
  if (replyKind === 'decide') {
    let intent = forced, rest = '';
    if (!intent) ({ intent, rest } = intentOf(text));
    if (!intent) {
      const [y, n] = row.ref_type === 'po_over' ? ['yes to keep the extra', 'no for only the ordered quantity'] : ['yes to approve', 'no to reject'];
      await reply(db, user, `Please reply ${y}, or ${n} — or tap a button. Nothing was done.${openLink(row)}`, m.id);
      return done('decision: not understood', row.id);
    }
    if (intent === 'no' && NO_NEEDS_REASON[row.ref_type] && !rest) {
      const q = await reply(db, user, `You're saying no to the ${LABEL[row.ref_type]}: ${row.title}.\n${NO_NEEDS_REASON[row.ref_type]}`, m.id,
        { type: 'prompt', parent: row.id, state: 'awaiting', note: 'no' });
      return done(q.ok ? 'asked for a reason' : 'could not ask for a reason', row.id);
    }
    return finish(db, user, m, row, await runDecision(db, row, intent, rest || null, actor), done);
  }

  await reply(db, user, `This alert can't be answered from WhatsApp — please open it in the app.${openLink(row)}`, m.id);
  return done('not answerable', row.id);
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

// Entry point from the webhook: every message in a (signed) Meta payload.
async function handleInbound(payload) {
  await wa.ensureSchema();
  const db = dbmod.getDB();
  let n = 0;
  for (const entry of payload?.entry || []) {
    for (const ch of entry?.changes || []) {
      const v = ch?.value || {};
      for (const m of v.messages || []) {
        try {
          const r = await handleMessage(db, m, v.metadata?.phone_number_id);
          console.log(`WhatsApp reply ${m.id}: ${r}`);
          n++;
        } catch (e) {
          console.error('WhatsApp reply failed:', e);
          try {
            await db.run('UPDATE whatsapp_inbox SET result=$2 WHERE wa_message_id=$1', [m.id, 'error: ' + e.message]);
            const u = await db.get('SELECT id, whatsapp_number FROM users WHERE whatsapp_number=$1 AND whatsapp_verified_at IS NOT NULL', [String(m.from || '').replace(/\D/g, '')]);
            if (u) await wa.sendText(u.whatsapp_number, 'Something went wrong handling your reply. Please check in the app whether it was done.', m.id);
          } catch (_) { /* nothing more to do */ }
        }
      }
    }
  }
  return n;
}

module.exports = { handleInbound, handleMessage, intentOf };
