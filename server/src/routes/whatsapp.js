// WhatsApp alerts — the owner's own settings, a test send, and the recent log.
// Owner-only for now (owner's request, 30 Sep 2026: "my WhatsApp").
const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const crypto = require('crypto');
const wa = require('../lib/whatsapp');
const replies = require('../lib/whatsappReplies');

// What the settings card needs. The token itself is never sent to the browser.
router.get('/settings', authenticate, authorize('owner'), async (req, res) => {
  try {
    await wa.ensureSchema();
    const u = await getDB().get(
      `SELECT whatsapp_number, whatsapp_enabled, whatsapp_types, whatsapp_verified_at,
              whatsapp_verify_code, whatsapp_verify_expires FROM users WHERE id=$1`, [req.user.id]);
    const c = wa.cfg();
    const sender = wa.isConfigured() ? await wa.senderNumber() : null;
    const codeLive = u?.whatsapp_verify_code && u.whatsapp_verify_expires && new Date(u.whatsapp_verify_expires) > new Date();
    res.json({
      verified: !!u?.whatsapp_verified_at,
      verified_at: u?.whatsapp_verified_at || null,
      pending_code: codeLive ? u.whatsapp_verify_code : null,
      sender_number: sender,
      approval_template: c.approvalTemplate || null,
      approval_template_body: wa.WHATSAPP_APPROVAL_TEMPLATE_BODY,
      number: u?.whatsapp_number || '',
      enabled: !!u?.whatsapp_enabled,
      types: Array.isArray(u?.whatsapp_types) ? u.whatsapp_types : wa.DEFAULT_TYPES,
      kinds: wa.KINDS,
      connected: wa.isConfigured(),
      webhook_ready: wa.webhookReady(),
      mode: c.template ? 'template' : 'text',
      template: c.template || null,
      template_body: wa.WHATSAPP_TEMPLATE_BODY,
    });
  } catch (e) {
    console.error('whatsapp settings get:', e);
    res.status(500).json({ error: 'Could not load WhatsApp settings' });
  }
});

router.put('/settings', authenticate, authorize('owner'), async (req, res) => {
  try {
    await wa.ensureSchema();
    const enabled = !!req.body?.enabled;
    const raw = String(req.body?.number || '').trim();
    const number = raw ? wa.normalizeNumber(raw) : null;
    if (raw && !number) return res.status(400).json({ error: 'Enter your WhatsApp number with the country code, e.g. +91 98765 43210' });
    if (enabled && !number) return res.status(400).json({ error: 'Add your WhatsApp number before switching alerts on' });
    const known = new Set(wa.KINDS.map(k => k.type));
    const types = Array.isArray(req.body?.types)
      ? [...new Set(req.body.types.map(String).filter(t => known.has(t)))]
      : wa.DEFAULT_TYPES;
    // A new number has to be confirmed again before replies from it can act.
    await getDB().run(
      `UPDATE users SET whatsapp_number=$1, whatsapp_enabled=$2, whatsapp_types=$3,
              whatsapp_verified_at = CASE WHEN whatsapp_number IS NOT DISTINCT FROM $1 THEN whatsapp_verified_at END,
              whatsapp_verify_code = CASE WHEN whatsapp_number IS NOT DISTINCT FROM $1 THEN whatsapp_verify_code END
        WHERE id=$4`,
      [number, enabled, types, req.user.id]);
    await wa.refreshRecipients(true);
    await logActivity(null, null, 'whatsapp_settings',
      `WhatsApp alerts ${enabled ? 'on' : 'off'}${number ? ` for …${number.slice(-4)}` : ''} — ${types.length} kind(s)`, req.user.id);
    res.json({ message: enabled ? 'WhatsApp alerts are on' : 'WhatsApp alerts are off', number, enabled, types });
  } catch (e) {
    console.error('whatsapp settings put:', e);
    res.status(500).json({ error: 'Could not save WhatsApp settings' });
  }
});

// Send one message now, straight away, to the saved number — the quickest way
// to see the whole chain (token, sender, template, allowed list) working.
router.post('/test', authenticate, authorize('owner'), async (req, res) => {
  try {
    await wa.ensureSchema();
    const u = await getDB().get('SELECT whatsapp_number FROM users WHERE id=$1', [req.user.id]);
    if (!u?.whatsapp_number) return res.status(400).json({ error: 'Save your WhatsApp number first' });
    const msg = {
      title: 'Test message',
      body: 'WhatsApp alerts from the PHE app are working. Approvals and @mentions will arrive here.',
      link: '/account',
    };
    const r = await wa.sendMessage(u.whatsapp_number, msg);
    await getDB().run(
      `INSERT INTO whatsapp_outbox (user_id, to_number, type, title, body, link, status, attempts, last_error, wa_message_id, sent_at)
       VALUES ($1,$2,'test',$3,$4,$5,$6,1,$7,$8,$9)`,
      [req.user.id, u.whatsapp_number, msg.title, msg.body, msg.link,
       r.ok ? 'accepted' : 'failed', r.ok ? null : r.error, r.ok ? r.id : null, r.ok ? new Date() : null]);
    if (!r.ok) return res.status(502).json({ error: r.error });
    // Meta accepting it is not delivery: a plain (non-template) message outside
    // the 24-hour window is accepted and then fails, reported on the webhook.
    res.json({ message: wa.cfg().template
      ? 'WhatsApp accepted the test message — it should arrive in a few seconds.'
      : 'WhatsApp accepted the test message. If it has not arrived within a minute, send any message to the business number first (WhatsApp\'s 24-hour rule until the template is approved) and try again.' });
  } catch (e) {
    console.error('whatsapp test:', e);
    res.status(500).json({ error: 'Could not send the test message' });
  }
});

// Confirm the number: the owner sends this code FROM their WhatsApp to the
// business number. That proves they hold the number, so replies from it may act.
router.post('/verify-code', authenticate, authorize('owner'), async (req, res) => {
  try {
    await wa.ensureSchema();
    const u = await getDB().get('SELECT whatsapp_number FROM users WHERE id=$1', [req.user.id]);
    if (!u?.whatsapp_number) return res.status(400).json({ error: 'Save your WhatsApp number first' });
    const code = 'PHE-' + String(crypto.randomInt(100000, 1000000));
    await getDB().run(
      `UPDATE users SET whatsapp_verify_code=$1, whatsapp_verify_expires=NOW() + INTERVAL '30 minutes' WHERE id=$2`,
      [code, req.user.id]);
    const sender = await wa.senderNumber();
    res.json({ code, sender_number: sender, wa_link: sender ? `https://wa.me/${sender}?text=${encodeURIComponent(code)}` : null });
  } catch (e) {
    console.error('whatsapp verify-code:', e);
    res.status(500).json({ error: 'Could not make a confirmation code' });
  }
});

router.get('/log', authenticate, authorize('owner'), async (req, res) => {
  try {
    await wa.ensureSchema();
    const rows = await getDB().all(
      `SELECT id, type, title, status, attempts, last_error, created_at, sent_at, action_state, action_note
         FROM whatsapp_outbox WHERE user_id=$1 ORDER BY id DESC LIMIT 25`, [req.user.id]);
    res.json(rows);
  } catch (e) {
    console.error('whatsapp log:', e);
    res.status(500).json({ error: 'Could not load the WhatsApp log' });
  }
});

// ── Webhook from Meta (no login: Meta calls it, and every call must carry a
// valid signature made with our app secret) ─────────────────────────────────
// GET: Meta's one-time check when the webhook is set up in the Meta app.
router.get('/webhook', (req, res) => {
  const c = wa.cfg();
  if (c.verifyToken && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === c.verifyToken) {
    return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] || ''));
  }
  res.sendStatus(403);
});

// POST: delivery statuses (accepted → sent → delivered → read, or failed) and
// the owner's replies. Replies are stored first — if that fails Meta is told
// so and sends them again — then Meta is answered, then the work happens.
// Each reply is acted on once (lib/whatsappReplies.js); one stored just before
// a restart is picked up by the worker afterwards.
router.post('/webhook', async (req, res) => {
  if (!wa.verifySignature(req.rawBody, req.get('x-hub-signature-256'))) return res.sendStatus(401);
  let ids = [];
  try { ids = await replies.storeInbound(req.body); }
  catch (e) { console.error('WhatsApp webhook: could not store the reply:', e.message); return res.sendStatus(500); }
  res.sendStatus(200);
  wa.applyStatuses(req.body).catch((e) => console.error('WhatsApp statuses:', e.message));
  if (ids.length) replies.processStored(ids).catch((e) => console.error('WhatsApp replies:', e.message));
});

module.exports = router;
