// WhatsApp copies of dashboard notifications (owner's request, 30 Sep 2026).
//
// Approvals and @mentions that land on the owner's dashboard bell are also sent
// to the owner's WhatsApp through Meta's official WhatsApp Business Platform
// (Cloud API). The dashboard is unchanged: every notification is still created
// exactly as before, and this only queues a copy for a user who switched
// WhatsApp alerts on, for the kinds they chose.
//
// Delivery goes through an outbox table that a background worker drains, so a
// slow or failing WhatsApp call never holds up the request that raised the
// alert, and a send that fails for a passing reason is retried. Meta answering
// the send only means it ACCEPTED the message; whether it was delivered, read
// or failed (e.g. outside the 24-hour window) comes back later on the webhook.
//
// Configuration (set on Render — never in the code or the chat):
//   WHATSAPP_TOKEN            access token for the WhatsApp Business account (secret)
//   WHATSAPP_PHONE_NUMBER_ID  "Phone number ID" of the sender (Meta → WhatsApp → API Setup)
//   WHATSAPP_TEMPLATE         name of the approved utility template, e.g. phe_alert.
//                             Blank = plain text, which WhatsApp only delivers within
//                             24 hours of the recipient messaging the sender number.
//   WHATSAPP_TEMPLATE_LANG    the template's language code (default 'en')
//   WHATSAPP_API_VERSION      Graph API version (default 'v23.0')
//   WHATSAPP_VERIFY_TOKEN     any phrase you choose; typed into Meta's webhook setup too
//   WHATSAPP_APP_SECRET       the Meta app's App secret — used to check that webhook
//                             calls really come from Meta (secret)
//   WHATSAPP_API_BASE         default https://graph.facebook.com (tests point it elsewhere)
//   APP_BASE_URL              prefix for links in messages (default https://www.peenaheatelements.com)
//
// The template must have exactly three variables, in this order: {{1}} the alert's
// title, {{2}} its details, {{3}} the link. See WHATSAPP_TEMPLATE_BODY below.

const crypto = require('crypto');
const dbmod = require('../db');

const WHATSAPP_TEMPLATE_BODY =
  'PHE app alert: {{1}}\n\n{{2}}\n\nOpen it here: {{3}}\n\nPeena Heat Elements';
// The approval template: the same three variables, plus two QUICK REPLY
// buttons, "Approve" then "Reject", in that order. Set its name in
// WHATSAPP_TEMPLATE_APPROVAL once Meta approves it.
const WHATSAPP_APPROVAL_TEMPLATE_BODY =
  'PHE app approval needed: {{1}}\n\n{{2}}\n\nOpen it here: {{3}}\n\nTap a button, or swipe-reply yes or no.';

// What a reply to each kind of alert can do (see lib/whatsappReplies.js).
// 'decide' = yes/no buttons; 'price' = reply with a price; 'thread' = the reply
// is posted in that chat.
const REPLY_KIND = {
  inventory_item: 'decide', split_request: 'decide', po_rate: 'decide', po_over: 'decide',
  capa: 'decide', order_approval: 'decide',
  price: 'price',
  order_thread: 'thread', po_thread: 'thread', query_thread: 'thread',
};
const BUTTON_LABELS = {
  po_over: ['Accept extra', 'Only ordered qty'],
  po_rate: ['Approve', 'Decline'],
  capa: ['Approve', 'Send back'],
};
const DECIDE_REFS = Object.keys(REPLY_KIND).filter(k => ['decide', 'price'].includes(REPLY_KIND[k]));
const TEMPLATE_BUTTON_MEANING = {
  po_over: 'Approve keeps the extra quantity; Reject takes only the ordered quantity.',
  po_rate: 'Reject asks the buyer to revise the rates.',
  capa: 'Reject sends it back to the team.',
};
const replyHint = (refType) => ({
  decide: 'Tap a button, or swipe-reply yes or no.',
  price: 'Swipe-reply with the price, e.g. 12500 per pc.',
  thread: 'Swipe-reply to answer in the chat.',
}[REPLY_KIND[refType]] || '');

// The kinds of notification that can be copied to WhatsApp. `default` is what a
// user gets before choosing: all approvals and @mentions (owner, 30 Sep 2026).
const KINDS = [
  { type: 'inventory_approval', group: 'approval', default: true,  label: 'New inventory item to approve' },
  { type: 'split_request',      group: 'approval', default: true,  label: 'Partial dispatch request' },
  { type: 'po_rate_increase',   group: 'approval', default: true,  label: 'Rate increase on a purchase order' },
  { type: 'po_over_receipt',    group: 'approval', default: true,  label: 'More arrived than ordered' },
  { type: 'capa_ready',         group: 'approval', default: true,  label: 'CAPA report ready for approval' },
  { type: 'price_request',      group: 'approval', default: true,  label: 'Price requested for a job card' },
  { type: 'terminals_short',    group: 'approval', default: true,  label: 'Terminal pin short — slip held until OK' },
  { type: 'order_message',      group: 'mention',  default: true,  label: 'Order threads — @mentions, and orders resubmitted for approval' },
  { type: 'po_message',         group: 'mention',  default: true,  label: 'Purchase-order threads — @mentions' },
  { type: 'query_message',      group: 'mention',  default: true,  label: 'Customer-query threads — @mentions' },
  { type: 'capa_required',      group: 'other',    default: false, label: 'CAPA required (work locked until it is written)' },
  { type: 'petty_cash_unpaid',  group: 'other',    default: false, label: 'Unpaid bank expense waiting to be paid' },
  { type: 'debit_note_pending', group: 'other',    default: false, label: 'Supplier debit note to raise' },
  { type: 'po_short_closed',    group: 'other',    default: false, label: 'Purchase-order line short-closed by Accounts' },
];
const KNOWN = new Set(KINDS.map(k => k.type));
const DEFAULT_TYPES = KINDS.filter(k => k.default).map(k => k.type);
const APPROVAL_TYPES = KINDS.filter(k => k.group === 'approval').map(k => k.type);

const MAX_ATTEMPTS = 5;
const RETRY_MINUTES = [1, 5, 15, 60];      // wait before attempts 2, 3, 4, 5
const STALE_HOURS = 24;                    // an alert older than this is not worth sending
const TICK_MS = 15000;
const BATCH = 3;                           // claimed per statement — a crash strands at most this many
// Flood guard: at most this many non-approval alerts per person per 10 minutes.
// Approvals are never capped.
const NON_APPROVAL_PER_10_MIN = 20;
// Statuses only move forward (webhooks can arrive out of order); 'failed' may
// land at any point.
const RANK = { pending: 0, sending: 0, accepted: 1, sent: 2, delivered: 3, read: 4 };

const cfg = () => ({
  token: (process.env.WHATSAPP_TOKEN || '').trim(),
  phoneId: (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim(),
  template: (process.env.WHATSAPP_TEMPLATE || '').trim(),
  approvalTemplate: (process.env.WHATSAPP_TEMPLATE_APPROVAL || '').trim(),
  lang: (process.env.WHATSAPP_TEMPLATE_LANG || 'en').trim(),
  version: (process.env.WHATSAPP_API_VERSION || 'v23.0').trim(),
  verifyToken: (process.env.WHATSAPP_VERIFY_TOKEN || '').trim(),
  appSecret: (process.env.WHATSAPP_APP_SECRET || '').trim(),
  base: (process.env.WHATSAPP_API_BASE || 'https://graph.facebook.com').trim().replace(/\/+$/, ''),
  appBase: (process.env.APP_BASE_URL || 'https://www.peenaheatelements.com').trim().replace(/\/+$/, ''),
});
const isConfigured = () => { const c = cfg(); return !!(c.token && c.phoneId); };
const webhookReady = () => { const c = cfg(); return !!(c.verifyToken && c.appSecret); };

// ── Schema ────────────────────────────────────────────────────────────────────
// initDB swallows its own errors and one failing migration skips every later
// one, so this feature makes sure of its own tables rather than relying on that
// chain. Column adds happen in one transaction with a short lock timeout, so a
// long-held lock on `users` can never make logins queue behind this ALTER.
let schemaPromise = null;
function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const have = new Set((await dbmod.getDB().all(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name='users' AND column_name LIKE 'whatsapp%'`))
        .map(r => r.column_name));
      const USER_COLS = {
        whatsapp_number: 'TEXT',
        whatsapp_enabled: 'BOOLEAN NOT NULL DEFAULT FALSE',
        whatsapp_types: 'TEXT[]',
        // Replies act only from a number its owner has proved they hold.
        whatsapp_verified_at: 'TIMESTAMPTZ',
        whatsapp_verify_code: 'TEXT',
        whatsapp_verify_expires: 'TIMESTAMPTZ',
      };
      const add = Object.entries(USER_COLS).filter(([c]) => !have.has(c))
        .map(([c, t]) => `ADD COLUMN IF NOT EXISTS ${c} ${t}`);
      await dbmod.getDB().withTransaction(async (c) => {
        await c.query("SET LOCAL lock_timeout = '3s'");
        if (add.length) await c.query('ALTER TABLE users ' + add.join(', '));
        await c.query(`
          CREATE TABLE IF NOT EXISTS whatsapp_outbox (
            id SERIAL PRIMARY KEY,
            notification_id INTEGER,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            to_number TEXT NOT NULL,
            type TEXT,
            title TEXT,
            body TEXT,
            link TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            claimed_at TIMESTAMPTZ,
            last_error TEXT,
            wa_message_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            sent_at TIMESTAMPTZ
          )`);
        // Which item the alert is about, and what has been done with a reply to it.
        for (const [col, t] of [['source_user_id', 'INTEGER'], ['ref_type', 'TEXT'], ['ref_id', 'INTEGER'],
                                ['ref_parent', 'INTEGER'], ['parent_outbox_id', 'INTEGER'], ['action_state', 'TEXT'],
                                ['action_note', 'TEXT'], ['acted_at', 'TIMESTAMPTZ'], ['ref_snapshot', 'TEXT']]) {
          await c.query(`ALTER TABLE whatsapp_outbox ADD COLUMN IF NOT EXISTS ${col} ${t}`);
        }
        // Every message received from WhatsApp, once each (Meta may deliver twice).
        await c.query(`
          CREATE TABLE IF NOT EXISTS whatsapp_inbox (
            id SERIAL PRIMARY KEY,
            wa_message_id TEXT NOT NULL UNIQUE,
            from_number TEXT,
            user_id INTEGER,
            kind TEXT,
            text TEXT,
            context_id TEXT,
            payload TEXT,
            sent_at TIMESTAMPTZ,
            received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            outbox_id INTEGER,
            result TEXT
          )`);
        // The whole message as received, stored before Meta is answered, so a
        // restart cannot lose a reply between "received" and "acted on".
        await c.query('ALTER TABLE whatsapp_inbox ADD COLUMN IF NOT EXISTS raw JSONB');
        await c.query('ALTER TABLE whatsapp_inbox ADD COLUMN IF NOT EXISTS phone_number_id TEXT');
        await c.query('CREATE INDEX IF NOT EXISTS whatsapp_outbox_due ON whatsapp_outbox (status, next_attempt_at)');
        await c.query('CREATE INDEX IF NOT EXISTS whatsapp_outbox_wamid ON whatsapp_outbox (wa_message_id)');
        await c.query('CREATE INDEX IF NOT EXISTS whatsapp_outbox_user ON whatsapp_outbox (user_id, created_at)');
      });
    })().catch((e) => { schemaPromise = null; throw e; });
  }
  return schemaPromise;
}

// ── Phone numbers ─────────────────────────────────────────────────────────────
// Stored as digits with the country code, as WhatsApp's API wants them. A bare
// 10-digit Indian mobile gets +91.
function normalizeNumber(input) {
  let d = String(input || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10 && /^[6-9]/.test(d)) d = '91' + d;
  return /^\d{11,15}$/.test(d) ? d : null;
}

// ── Who wants which alerts ────────────────────────────────────────────────────
// Held in memory so that creating a notification for someone who has not
// switched WhatsApp on (nearly everyone) costs no database work at all. On a
// failed refresh the last known list is kept (and retried in ~5 s) rather than
// silently dropping everyone's alerts for a minute.
let recipients = { at: 0, byUser: new Map() };
let refreshGen = 0;
let inflight = null;
function refreshRecipients(force = false) {
  if (!force && Date.now() - recipients.at < 60000) return Promise.resolve(recipients.byUser);
  if (!force && inflight) return inflight;
  const my = ++refreshGen;
  const p = (async () => {
    try {
      const rows = await dbmod.getDB().all(
        `SELECT id, whatsapp_number, whatsapp_types FROM users
          WHERE whatsapp_enabled = TRUE AND whatsapp_number IS NOT NULL`);
      const byUser = new Map();
      for (const r of rows) {
        const types = Array.isArray(r.whatsapp_types) ? r.whatsapp_types : DEFAULT_TYPES;
        byUser.set(Number(r.id), { number: r.whatsapp_number, types: new Set(types) });
      }
      if (my === refreshGen) recipients = { at: Date.now(), byUser };
    } catch (e) {
      if (my === refreshGen) recipients = { at: Date.now() - 55000, byUser: recipients.byUser };
      if (!/column .*whatsapp_|whatsapp_outbox/.test(e.message)) {
        console.error('WhatsApp recipients refresh failed (keeping the last known list):', e.message);
      }
    }
    return recipients.byUser;
  })();
  if (!force) { inflight = p; p.finally(() => { if (inflight === p) inflight = null; }); }
  return p;
}

// Called by createNotification for every notification. Never throws, and uses
// its own pool connection rather than the caller's, so it can never disturb
// the caller's work or transaction.
async function queueWhatsApp({ notificationId, userId, type, title, body, link, sourceUserId, ref }) {
  try {
    if (!isConfigured() || !KNOWN.has(type)) return;
    const who = (await refreshRecipients()).get(Number(userId));
    if (!who || !who.types.has(type)) return;
    const db = dbmod.getDB();
    const decision = DECIDE_REFS.includes(ref?.type) && Number.isInteger(Number(ref?.id));
    const snap = ref?.snap != null ? String(ref.snap) : null;
    // The same alert already queued moments ago (a message re-posted, a double
    // click) is not sent twice. For something to decide, only an unanswered
    // copy from the last minute counts — a resubmission must reach the owner.
    const dup = decision
      ? await db.get(
        `SELECT 1 FROM whatsapp_outbox
          WHERE user_id=$1 AND ref_type=$2 AND ref_id=$3 AND COALESCE(ref_snapshot,'')=COALESCE($4,'')
            AND COALESCE(title,'')=COALESCE($5,'') AND COALESCE(body,'')=COALESCE($6,'')
            AND action_state IS NULL AND created_at > NOW() - INTERVAL '1 minute' LIMIT 1`,
        [userId, ref.type, Number(ref.id), snap, title || '', body || null])
      : await db.get(
        `SELECT 1 FROM whatsapp_outbox
          WHERE user_id=$1 AND type=$2 AND COALESCE(link,'')=COALESCE($3,'') AND COALESCE(title,'')=COALESCE($4,'')
            AND COALESCE(body,'')=COALESCE($5,'') AND created_at > NOW() - INTERVAL '10 minutes' LIMIT 1`,
        [userId, type, link || null, title || '', body || null]);
    if (dup) return;
    // Flood guard: a burst of @mentions cannot bury the owner's phone; the
    // dashboard still has every one of them. Approvals always go, and the
    // app's own answers to the owner's replies do not count.
    const isApproval = APPROVAL_TYPES.includes(type) || ['decide', 'price'].includes(REPLY_KIND[ref?.type]);
    if (!isApproval) {
      const recent = await db.get(
        `SELECT COUNT(*)::int AS n FROM whatsapp_outbox
          WHERE user_id=$1 AND created_at > NOW() - INTERVAL '10 minutes' AND NOT (type = ANY($2::text[]))
            AND NOT (COALESCE(ref_type,'') = ANY($3::text[]))
            AND type NOT IN ('reply', 'prompt', 'test')`,
        [userId, APPROVAL_TYPES, DECIDE_REFS]);
      if (recent && recent.n >= NON_APPROVAL_PER_10_MIN) return;
    }
    const refId = Number.isInteger(Number(ref?.id)) ? Number(ref.id) : null;
    const refParent = Number.isInteger(Number(ref?.parent)) ? Number(ref.parent) : null;
    const row = await db.get(
      `INSERT INTO whatsapp_outbox (notification_id, user_id, to_number, type, title, body, link,
                                    source_user_id, ref_type, ref_id, ref_parent, ref_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [notificationId || null, userId, who.number, type, title || '', body || null, link || null,
       sourceUserId || null, ref?.type || null, refId, refParent, snap]);
    // A newer alert about the same thing (resubmitted, re-received, asked
    // again) replaces the older ones: they can no longer be answered, and any
    // not yet sent are not sent.
    if (decision && row) {
      await db.run(
        `UPDATE whatsapp_outbox
            SET action_state='superseded', action_note='A newer alert replaced this one',
                status = CASE WHEN status='pending' THEN 'expired' ELSE status END,
                last_error = CASE WHEN status='pending' THEN 'Replaced by a newer alert' ELSE last_error END
          WHERE user_id=$1 AND ref_type=$2 AND ref_id=$3 AND id < $4 AND (action_state IS NULL OR action_state='acting')`,
        [userId, ref.type, refId, row.id]);
    }
  } catch (e) {
    console.error('WhatsApp queue failed (dashboard notification unaffected):', e.message);
  }
}

// ── Sending ───────────────────────────────────────────────────────────────────
// Template variables may not contain new lines or tabs or more than four spaces
// in a row, and may not be empty.
function param(text, max) {
  let t = String(text ?? '').replace(/[\r\n\t]+/g, ' · ').replace(/ {2,}/g, ' ').trim();
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + '…';
  return t || '—';
}
const fullLink = (link) => {
  const c = cfg();
  if (!link) return c.appBase + '/';
  if (/^https?:\/\//i.test(link)) return link;
  return c.appBase + (link.startsWith('/') ? link : '/' + link);
};

// What to tell the owner when Meta refuses a message — synchronously, or later
// through a 'failed' status on the webhook.
function explain(err, status) {
  const code = err?.code, sub = err?.error_subcode;
  const meta = [err?.message || err?.title, err?.error_data?.details].filter(Boolean).join(' — ');
  const hints = {
    190: 'The WhatsApp access token is wrong or has expired. Make a permanent (system user) token and update WHATSAPP_TOKEN on Render.',
    131030: 'This number is not on the test number\'s allowed list. In Meta → WhatsApp → API Setup, add it under "To" and confirm the code WhatsApp sends.',
    131047: 'WhatsApp only delivers plain messages within 24 hours of you messaging the business number. Send it any message, or finish the approved template (WHATSAPP_TEMPLATE).',
    132001: 'The template was not found. Check WHATSAPP_TEMPLATE and WHATSAPP_TEMPLATE_LANG match the approved template exactly.',
    132000: 'The template needs exactly three variables: title, details, link.',
    132005: 'The message is too long for the template.',
    132012: 'The template\'s variables did not match what was sent.',
    131026: 'WhatsApp could not deliver to this number. Check it is on WhatsApp and includes the country code.',
    131056: 'Too many messages to this number in a short time. It will be retried.',
    130429: 'WhatsApp\'s sending limit was reached. It will be retried.',
    131009: 'WhatsApp rejected a value in the message.',
    133010: 'The sender number is not registered yet. Finish its registration in Meta.',
  };
  let hint = hints[code];
  if (!hint && code === 100 && sub === 33) hint = 'WHATSAPP_PHONE_NUMBER_ID is wrong. Copy the "Phone number ID" from Meta → WhatsApp → API Setup.';
  if (!hint && status === 401) hint = hints[190];
  return [hint, meta && `(WhatsApp: ${meta}${code ? `, code ${code}` : ''})`].filter(Boolean).join(' ')
    || `WhatsApp refused the message${status ? ` (HTTP ${status})` : ''}.`;
}
const RETRYABLE_CODES = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 131048, 131056, 133004]);

async function sendMessage(to, msg) {
  const { title, body, link } = msg;
  const c = cfg();
  if (!c.token || !c.phoneId) return { ok: false, retryable: false, error: 'WhatsApp is not connected yet: WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are not set on the server.' };
  const href = fullLink(link);
  const decide = REPLY_KIND[msg.ref_type] === 'decide' && msg.id;
  // The approval template already ends "Tap a button, or swipe-reply yes or
  // no", and its buttons always read Approve / Reject — so say what they mean
  // where that is not obvious. The plain template has no buttons.
  const hint = decide && c.approvalTemplate ? (TEMPLATE_BUTTON_MEANING[msg.ref_type] || '')
    : decide && c.template ? 'Swipe-reply yes or no.'
      : replyHint(msg.ref_type);
  const details = [body, hint].filter(Boolean).join('\n\n');
  const [yesLabel, noLabel] = BUTTON_LABELS[msg.ref_type] || ['Approve', 'Reject'];
  const bodyParams = [
    { type: 'text', text: param(title, 200) },
    { type: 'text', text: param(details, 600) },
    { type: 'text', text: param(href, 300) },
  ];
  let payload;
  if (decide && c.approvalTemplate) {
    // Template with quick-reply buttons: each button carries which alert and which answer.
    payload = {
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template',
      template: {
        name: c.approvalTemplate, language: { code: c.lang },
        components: [
          { type: 'body', parameters: bodyParams },
          { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: `ob:${msg.id}:yes` }] },
          { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: `ob:${msg.id}:no` }] },
        ],
      },
    };
  } else if (c.template) {
    payload = {
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template',
      template: { name: c.template, language: { code: c.lang }, components: [{ type: 'body', parameters: bodyParams }] },
    };
  } else if (decide) {
    // No template yet: WhatsApp's own reply buttons (delivered within the 24-hour window).
    payload = {
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: `*PHE app approval needed: ${String(title || '').slice(0, 200)}*\n\n${String(details || '').slice(0, 700)}\n\nOpen it here: ${href}`.slice(0, 1024) },
        action: { buttons: [
          { type: 'reply', reply: { id: `ob:${msg.id}:yes`, title: yesLabel.slice(0, 20) } },
          { type: 'reply', reply: { id: `ob:${msg.id}:no`, title: noLabel.slice(0, 20) } },
        ] },
      },
    };
  } else {
    payload = {
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text',
      text: { preview_url: false, body: `*PHE app alert: ${String(title || '').slice(0, 300)}*\n\n${String(details || '').slice(0, 1500)}\n\nOpen it here: ${href}` },
    };
  }
  return postToMeta(payload);
}

// A plain reply to the owner (confirmations, questions) — allowed because the
// owner has just written to us, which opens WhatsApp's 24-hour window.
async function sendText(to, text, replyToWamid) {
  const c = cfg();
  if (!c.token || !c.phoneId) return { ok: false, retryable: false, error: 'WhatsApp is not connected.' };
  const payload = {
    messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text',
    text: { preview_url: false, body: String(text).slice(0, 4000) },
  };
  if (replyToWamid) payload.context = { message_id: replyToWamid };
  return postToMeta(payload);
}

async function postToMeta(payload) {
  const c = cfg();
  const url = `${c.base}/${c.version}/${encodeURIComponent(c.phoneId)}/messages`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    const id = j?.messages?.[0]?.id;
    if (r.ok && id) return { ok: true, id };
    const err = j?.error || {};
    return {
      ok: false, status: r.status, code: err.code,
      retryable: r.status >= 500 || r.status === 429 || RETRYABLE_CODES.has(err.code),
      error: explain(err, r.status),
    };
  } catch (e) {
    return { ok: false, retryable: true, error: e.name === 'AbortError' ? 'WhatsApp did not answer within 15 seconds. It will be retried.' : `Could not reach WhatsApp: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

// The business number's display form, for the "confirm my number" link.
let senderCache = { at: 0, number: null };
async function senderNumber() {
  const c = cfg();
  if (!c.token || !c.phoneId) return null;
  if (senderCache.number && Date.now() - senderCache.at < 6 * 3600e3) return senderCache.number;
  try {
    const r = await fetch(`${c.base}/${c.version}/${encodeURIComponent(c.phoneId)}?fields=display_phone_number`,
      { headers: { Authorization: `Bearer ${c.token}` } });
    const j = await r.json().catch(() => ({}));
    const n = String(j?.display_phone_number || '').replace(/\D/g, '');
    if (n) senderCache = { at: Date.now(), number: n };
    return n || null;
  } catch (_) { return null; }
}

// ── The worker ────────────────────────────────────────────────────────────────
async function writeWithRetry(db, sql, params) {
  for (let i = 0; ; i++) {
    try { return await db.run(sql, params); }
    catch (e) { if (i >= 2) throw e; await new Promise(s => setTimeout(s, 1000 * (i + 1))); }
  }
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    if (!isConfigured()) return;
    await ensureSchema();
    const db = dbmod.getDB();
    // Replies stored but not acted on (a restart in between) are picked up.
    try { await require('./whatsappReplies').processPending(); }
    catch (e) { console.error('WhatsApp reply recovery:', e.message); }
    // A send interrupted by a restart is released after 10 minutes.
    await db.run(`UPDATE whatsapp_outbox SET status='pending'
                   WHERE status='sending' AND claimed_at < NOW() - INTERVAL '10 minutes'`);
    // A replaced alert still waiting (put back after a failed try) is not sent.
    await db.run(`UPDATE whatsapp_outbox SET status='expired', last_error=COALESCE(last_error, 'Replaced by a newer alert')
                   WHERE status='pending' AND action_state='superseded'`);
    // An alert that could not go out for a day is stale — the dashboard has it.
    await db.run(`UPDATE whatsapp_outbox SET status='expired',
                     last_error=COALESCE(last_error, 'Not sent within ${STALE_HOURS} hours')
                   WHERE status='pending' AND created_at < NOW() - INTERVAL '${STALE_HOURS} hours'`);
    for (let round = 0; round < 5; round++) {
      // Claim a few; SKIP LOCKED keeps two server instances (e.g. during a
      // deploy) from sending the same message twice. Approvals go first.
      const rows = await db.all(`
        UPDATE whatsapp_outbox SET status='sending', attempts=attempts+1, claimed_at=NOW()
         WHERE id IN (SELECT id FROM whatsapp_outbox
                       WHERE status='pending' AND next_attempt_at <= NOW()
                         AND action_state IS DISTINCT FROM 'superseded'
                       ORDER BY (type = ANY($1::text[]) OR COALESCE(ref_type,'') = ANY($2::text[])) DESC, id
                       LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
        RETURNING *`, [APPROVAL_TYPES, DECIDE_REFS]);
      if (!rows.length) break;
      const first = (r) => APPROVAL_TYPES.includes(r.type) || DECIDE_REFS.includes(r.ref_type);
      rows.sort((a, b) => (first(b) - first(a)) || (a.id - b.id));
      for (const row of rows) {
        let r;
        try {
          r = await sendMessage(row.to_number, row);
          if (r.ok) {
            // Recording an accepted message must survive a DB blip, or the
            // 10-minute reclaim would send it again.
            await writeWithRetry(db, `UPDATE whatsapp_outbox SET status='accepted', sent_at=NOW(), wa_message_id=$2, last_error=NULL WHERE id=$1`, [row.id, r.id]);
          } else if (r.retryable && row.attempts < MAX_ATTEMPTS) {
            const wait = RETRY_MINUTES[Math.min(row.attempts - 1, RETRY_MINUTES.length - 1)];
            await writeWithRetry(db, `UPDATE whatsapp_outbox SET status='pending', last_error=$2,
                                         next_attempt_at=NOW() + ($3 || ' minutes')::interval WHERE id=$1`,
              [row.id, r.error, String(wait)]);
          } else {
            await writeWithRetry(db, `UPDATE whatsapp_outbox SET status='failed', last_error=$2 WHERE id=$1`, [row.id, r.error]);
            console.error(`WhatsApp alert #${row.id} failed:`, r.error);
          }
        } catch (e) {
          // One row's trouble must not abandon the rest of the batch; this row
          // is released by the 10-minute reclaim.
          console.error(`WhatsApp alert #${row.id}: status write failed${r?.ok ? ' after WhatsApp accepted it' : ''}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error('WhatsApp worker:', e.message);
  } finally {
    running = false;
  }
}

// ── Webhook: delivery statuses from Meta ──────────────────────────────────────
// Meta signs every call with the app secret (X-Hub-Signature-256 over the raw
// body). Anything not signed with our secret is refused.
function verifySignature(rawBody, header) {
  const c = cfg();
  if (!c.appSecret || !rawBody || !header || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', c.appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected.toLowerCase()), b = Buffer.from(String(header).toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function applyStatuses(payload) {
  const statuses = [];
  for (const entry of payload?.entry || []) {
    for (const ch of entry?.changes || []) {
      for (const s of ch?.value?.statuses || []) statuses.push(s);
    }
  }
  if (!statuses.length) return 0;
  await ensureSchema();
  const db = dbmod.getDB();
  let n = 0;
  for (const s of statuses) {
    if (!s?.id || !s?.status) continue;
    const row = await db.get('SELECT id, status FROM whatsapp_outbox WHERE wa_message_id=$1', [s.id]);
    if (!row) continue;
    if (s.status === 'failed') {
      if (row.status === 'failed') continue;
      // A question that never arrived stops waiting for an answer.
      await db.run(`UPDATE whatsapp_outbox SET status='failed', last_error=$2,
                       action_state = CASE WHEN type='prompt' AND action_state='awaiting' THEN 'unsent' ELSE action_state END
                     WHERE id=$1`,
        [row.id, explain(s.errors?.[0] || {}, null)]);
      n++;
    } else if (RANK[s.status] != null && row.status !== 'failed' && (RANK[s.status] > (RANK[row.status] ?? 0))) {
      await db.run('UPDATE whatsapp_outbox SET status=$2 WHERE id=$1', [row.id, s.status]);
      n++;
    }
  }
  return n;
}

let timer = null;
function startWhatsAppWorker() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  if (isConfigured()) {
    ensureSchema()
      .then(() => refreshRecipients(true))
      .then(() => tick())
      .catch((e) => console.error('WhatsApp setup:', e.message));
  }
  console.log(`WhatsApp alerts worker started (${isConfigured() ? 'connected' : 'not connected — WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID not set'})`);
}

module.exports = {
  KINDS, DEFAULT_TYPES, APPROVAL_TYPES, WHATSAPP_TEMPLATE_BODY, WHATSAPP_APPROVAL_TEMPLATE_BODY,
  REPLY_KIND, sendText, senderNumber,
  cfg, isConfigured, webhookReady, ensureSchema, normalizeNumber, refreshRecipients,
  queueWhatsApp, sendMessage, tick, startWhatsAppWorker, param, fullLink, explain,
  verifySignature, applyStatuses,
};
