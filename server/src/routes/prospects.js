const router = require('express').Router();
const { getDB } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

// Sales prospecting is a sales/management function — gate to these roles.
const SALES = ['owner', 'admin', 'accounts'];

// Prospect statuses (owner, 26 Oct 2026): the sales pipeline plus the two that stop all campaign messages.
const STATUSES = ['new', 'exported', 'contacted', 'replied', 'interested', 'quoted', 'won', 'not_interested', 'skip'];
const NO_CAMPAIGN = ['skip', 'not_interested'];
const CHANNELS = ['email', 'whatsapp', 'call'];
const idList = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(x => parseInt(x, 10)).filter(Number.isInteger);

/** List prospects, optionally filtered by segment / priority / status. */
router.get('/', authenticate, authorize(...SALES), async (req, res) => {
  const { segment, priority, status, source, state, application } = req.query;
  const where = [];
  const params = [];
  if (segment)     { params.push(segment);     where.push(`segment = $${params.length}`); }
  if (priority)    { params.push(priority);    where.push(`priority = $${params.length}`); }
  if (status)      { params.push(status);      where.push(`status = $${params.length}`); }
  if (source)      { params.push(source);      where.push(`source = $${params.length}`); }
  if (state)       { params.push(state);       where.push(`state = $${params.length}`); }
  if (application) { params.push(application); where.push(`application = $${params.length}`); }
  const sql = `
    SELECT *, (SELECT c.customer_code FROM customers c WHERE c.id = prospects.customer_id) AS customer_code FROM prospects
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE priority WHEN 'H' THEN 0 WHEN 'M' THEN 1 ELSE 2 END, company`;
  res.json(await getDB().all(sql, params));
});

/** Distinct segments with counts — powers the segment filter + stats. */
router.get('/segments', authenticate, authorize(...SALES), async (req, res) => {
  const rows = await getDB().all(`
    SELECT segment,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE priority = 'H')::int AS high,
      COUNT(*) FILTER (WHERE status = 'new')::int AS unactioned
    FROM prospects GROUP BY segment ORDER BY segment`);
  res.json(rows);
});

/** Bulk insert a researched list. Skips duplicates (company+email). Returns counts. */
router.post('/bulk', authenticate, authorize(...SALES), async (req, res) => {
  const { prospects, segment } = req.body;
  if (!Array.isArray(prospects) || !prospects.length)
    return res.status(400).json({ error: 'prospects must be a non-empty array' });

  const db = getDB();
  let inserted = 0, skipped = 0;
  for (const p of prospects) {
    const company = (p.company || p.co || '').trim();
    const seg = (p.segment || p.seg || segment || '').trim();
    if (!company || !seg) { skipped++; continue; }
    const r = await db.run(
      `INSERT INTO prospects (company, city, state, country, segment, email, phone, contact_role, product_fit, priority, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (lower(company), lower(coalesce(email,''))) DO NOTHING`,
      [company, p.city || null, p.state || null, p.country || 'India', seg,
       p.email || null, p.phone || null, p.role || p.contact_role || null,
       p.fit || p.product_fit || null, (p.priority || 'M').toUpperCase().slice(0, 1),
       p.source || 'claude-research', req.user.id]
    );
    r.rowCount ? inserted++ : skipped++;
  }
  res.json({ inserted, skipped, total: prospects.length });
});

/**
 * Move prospects to a status and log each change (from → to, who, note). 'exported' only ever moves
 * rows that are still 'new' — exporting the next touch must never pull a 'replied' row back.
 */
async function setStatus(db, ids, status, note, userId) {
  if (!ids.length) return [];
  const onlyNew = status === 'exported';
  return db.all(`
    WITH old AS (SELECT id, status FROM prospects WHERE id = ANY($2::int[]) ${onlyNew ? `AND status = 'new'` : ''}),
    upd AS (UPDATE prospects p SET status = $1 FROM old WHERE p.id = old.id AND old.status IS DISTINCT FROM $1 RETURNING p.id, old.status AS from_status)
    INSERT INTO prospect_status_log (prospect_id, from_status, to_status, note, changed_by)
    SELECT id, from_status, $1, $3, $4 FROM upd RETURNING prospect_id`, [status, ids, note ? String(note).slice(0, 500) : null, userId || null]);
}

/** Update a single prospect's status or editable fields (a status change is logged, with an optional status_note). */
router.patch('/:id', authenticate, authorize(...SALES), async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id, 10);
  if (req.body.status !== undefined && !STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Unknown status' });
  const allowed = ['priority', 'email', 'phone', 'contact_role', 'product_fit', 'notes'];
  const sets = [], params = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) { params.push(req.body[key]); sets.push(`${key} = $${params.length}`); }
  }
  if (!sets.length && req.body.status === undefined) return res.status(400).json({ error: 'No updatable fields provided' });
  if (sets.length) {
    params.push(id);
    await db.run(`UPDATE prospects SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  }
  if (req.body.status !== undefined) {
    const changed = await setStatus(db, [id], req.body.status, req.body.status_note, req.user.id);
    // Same status but a note to keep ("wants a quote for 2 kW, call Monday") — logged as a note
    if (!changed.length && req.body.status_note) await db.run(
      `INSERT INTO prospect_status_log (prospect_id, from_status, to_status, note, changed_by)
       SELECT id, coalesce(status, 'new'), coalesce(status, 'new'), $2, $3 FROM prospects WHERE id = $1`,
      [id, String(req.body.status_note).slice(0, 500), req.user.id]);
  }
  res.json({ message: 'Updated' });
});

/** Move many prospects to a status in one call (logged per row). */
router.post('/bulk-status', authenticate, authorize(...SALES), async (req, res) => {
  const ids = idList(req.body.ids);
  const { status, note } = req.body;
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
  const changed = await setStatus(getDB(), ids, status, note, req.user.id);
  res.json({ message: 'Updated', count: changed.length });
});

/** Campaign tracking: every touch done for a list, for the progress lines, ticks and filters. */
router.get('/touches', authenticate, authorize(...SALES), async (req, res) => {
  const { segment } = req.query;
  if (!segment) return res.status(400).json({ error: 'segment required' });
  res.json(await getDB().all(`
    SELECT t.prospect_id, t.touch_key, t.channel, t.note, t.done_at, u.name AS done_by
    FROM prospect_touches t LEFT JOIN users u ON u.id = t.done_by
    WHERE t.segment = $1 ORDER BY t.done_at`, [segment]));
});

/**
 * Mark a touch done on a channel for some prospects (e.g. the Zoho email went to these 106).
 * Rows still 'new' or 'exported' move to 'contacted' — logged as automatic.
 */
router.post('/touches', authenticate, authorize(...SALES), async (req, res) => {
  const db = getDB();
  const ids = idList(req.body.ids);
  const { segment, touch_key, channel } = req.body;
  const note = req.body.note ? String(req.body.note).slice(0, 500) : null;
  if (!segment || !ids.length) return res.status(400).json({ error: 'segment and ids required' });
  if (!CHANNELS.includes(channel)) return res.status(400).json({ error: 'Unknown channel' });
  if (!/^[a-z0-9_-]{1,40}$/i.test(String(touch_key || ''))) return res.status(400).json({ error: 'Bad touch' });
  const marked = await db.all(`
    INSERT INTO prospect_touches (prospect_id, segment, touch_key, channel, note, done_by)
    SELECT id, segment, $3, $4, $5, $6 FROM prospects WHERE id = ANY($1::int[]) AND segment = $2
    ON CONFLICT (prospect_id, touch_key, channel) DO UPDATE SET note = COALESCE(EXCLUDED.note, prospect_touches.note)
    RETURNING prospect_id`, [ids, segment, touch_key, channel, note, req.user.id]);
  const fresh = await db.all(`SELECT id FROM prospects WHERE id = ANY($1::int[]) AND status IN ('new','exported')`, [marked.map(m => m.prospect_id)]);
  const advanced = await setStatus(db, fresh.map(r => r.id), 'contacted', `auto: ${channel} · ${touch_key}`, req.user.id);
  res.json({ marked: marked.length, advanced: advanced.length });
});

/** Undo a touch mark (a mistaken click). The status stays as it is. */
router.post('/touches/undo', authenticate, authorize(...SALES), async (req, res) => {
  const ids = idList(req.body.ids);
  const { touch_key, channel } = req.body;
  if (!ids.length || !CHANNELS.includes(channel) || !touch_key) return res.status(400).json({ error: 'ids, touch_key and channel required' });
  const r = await getDB().run(`DELETE FROM prospect_touches WHERE prospect_id = ANY($1::int[]) AND touch_key = $2 AND channel = $3`, [ids, touch_key, channel]);
  res.json({ removed: r.rowCount });
});

/** One prospect's history: status changes and touches done, newest first. */
router.get('/:id/history', authenticate, authorize(...SALES), async (req, res) => {
  const db = getDB();
  const id = parseInt(req.params.id, 10);
  const [status, touches] = await Promise.all([
    db.all(`SELECT l.from_status, l.to_status, l.note, l.changed_at, u.name AS changed_by FROM prospect_status_log l
            LEFT JOIN users u ON u.id = l.changed_by WHERE l.prospect_id = $1 ORDER BY l.changed_at DESC`, [id]),
    db.all(`SELECT t.touch_key, t.channel, t.note, t.done_at, u.name AS done_by FROM prospect_touches t
            LEFT JOIN users u ON u.id = t.done_by WHERE t.prospect_id = $1 ORDER BY t.done_at DESC`, [id]),
  ]);
  res.json({ status, touches });
});

/** LinkedIn calendar: which planned posts went out (the posts are defined in client linkedinCampaign.js). */
router.get('/linkedin', authenticate, authorize(...SALES), async (req, res) => {
  res.json(await getDB().all(`SELECT l.post_key, l.posted_at, l.url, l.note, u.name AS posted_by
    FROM linkedin_posts l LEFT JOIN users u ON u.id = l.posted_by ORDER BY l.posted_at`));
});
router.post('/linkedin/:key', authenticate, authorize(...SALES), async (req, res) => {
  const key = String(req.params.key);
  if (!/^[a-z0-9_-]{1,40}$/i.test(key)) return res.status(400).json({ error: 'Bad post key' });
  const url = req.body.url ? String(req.body.url).slice(0, 500) : null;
  const note = req.body.note ? String(req.body.note).slice(0, 500) : null;
  await getDB().run(`INSERT INTO linkedin_posts (post_key, posted_by, url, note) VALUES ($1, $2, $3, $4)
    ON CONFLICT (post_key) DO UPDATE SET url = COALESCE(EXCLUDED.url, linkedin_posts.url), note = COALESCE(EXCLUDED.note, linkedin_posts.note)`,
    [key, req.user.id, url, note]);
  res.json({ message: 'Posted' });
});
router.delete('/linkedin/:key', authenticate, authorize(...SALES), async (req, res) => {
  await getDB().run('DELETE FROM linkedin_posts WHERE post_key = $1', [String(req.params.key)]);
  res.json({ message: 'Removed' });
});

/** Social plan (owner, 13 Nov 2026): the weekly LinkedIn / Instagram / YouTube posts written by the social agent.
 *  Only the owner approves a week; the approval is pinned to plan_hash, so the agent posts exactly what was seen. */
router.get('/social', authenticate, authorize(...SALES), async (req, res) => {
  res.json(await getDB().all(`SELECT s.week_key, s.post_date::text AS post_date, s.topic, s.plan, s.plan_hash, s.status,
      s.approved_hash, s.approved_at, ua.name AS approved_by, s.change_note, s.change_at, uc.name AS change_by,
      s.results, s.updated_at
    FROM social_plan s LEFT JOIN users ua ON ua.id = s.approved_by LEFT JOIN users uc ON uc.id = s.change_by
    ORDER BY s.post_date`));
});
const socialKey = k => /^[a-z0-9_-]{1,40}$/i.test(String(k || ''));
router.post('/social/:key/approve', authenticate, authorize('owner'), async (req, res) => {
  if (!socialKey(req.params.key)) return res.status(400).json({ error: 'Bad week' });
  const row = await getDB().get('SELECT plan_hash FROM social_plan WHERE week_key = $1', [req.params.key]);
  if (!row) return res.status(404).json({ error: 'Week not found' });
  // The page sends the hash it showed; if the agent changed the plan meanwhile, the owner must look again.
  if (String(req.body.hash || '') !== row.plan_hash) return res.status(409).json({ error: 'This week changed since you opened it. Refresh and check it again.' });
  await getDB().run(`UPDATE social_plan SET status = 'approved', approved_hash = plan_hash, approved_by = $2, approved_at = NOW(),
      change_note = NULL WHERE week_key = $1`, [req.params.key, req.user.id]);
  res.json({ message: 'Approved' });
});
router.post('/social/:key/unapprove', authenticate, authorize('owner'), async (req, res) => {
  if (!socialKey(req.params.key)) return res.status(400).json({ error: 'Bad week' });
  await getDB().run(`UPDATE social_plan SET status = 'draft', approved_hash = NULL, approved_by = NULL, approved_at = NULL
    WHERE week_key = $1`, [req.params.key]);
  res.json({ message: 'Approval withdrawn' });
});
router.post('/social/:key/changes', authenticate, authorize(...SALES), async (req, res) => {
  if (!socialKey(req.params.key)) return res.status(400).json({ error: 'Bad week' });
  const note = String(req.body.note || '').trim().slice(0, 2000);
  if (!note) return res.status(400).json({ error: 'Say what to change' });
  await getDB().run(`UPDATE social_plan SET status = 'changes_requested', change_note = $2, change_by = $3, change_at = NOW(),
      approved_hash = NULL, approved_by = NULL, approved_at = NULL WHERE week_key = $1`, [req.params.key, note, req.user.id]);
  res.json({ message: 'Sent to the social agent' });
});

// Became a customer (owner, 13 Nov 2026). A prospect who places an order becomes a Customers record (or is linked
// to the one already there), is marked Won, and moves into "Existing customers · reorder", so it gets the reorder
// emails and stops getting its old list's cold campaign. Its old touches stay in its history, renamed
// '<old list>:<touch>' so they can't collide with the same-named touch of the reorder campaign.
const EC_SEGMENT = 'existing-customers';
const EC_NEW_APP = 'Ordered 1–2 times';
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{0,11}$/;
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'hotmail.com', 'outlook.com',
  'live.com', 'icloud.com', 'rediffmail.com', 'aol.com', 'zoho.com', 'protonmail.com', 'ymail.com', 'msn.com', 'mail.com']);
const istDay = () => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const httpErr = (status, message) => Object.assign(new Error(message), { status });

// Their codes are mostly the initials of the first words (Rajhans Metals Pvt Ltd → RMP); she can change it.
function suggestCode(name, taken) {
  const words = String(name || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/)
    .filter(w => w && !['THE', 'AND', 'M', 'S', 'MS'].includes(w));
  const base = (words.length === 1 ? words[0].slice(0, 3) : words.slice(0, 3).map(w => w[0]).join('')) || 'NEW';
  let code = base, n = 2;
  while (taken.has(code)) code = `${base}${n++}`;
  return code;
}
const normName = s => String(s || '').toLowerCase()
  .replace(/\b(pvt|private|ltd|limited|llp|llc|co|company|the|m\/s|ms)\b\.?/g, '').replace(/[^a-z0-9]/g, '');
const mailDomains = s => String(s || '').toLowerCase().split(/[\s,;/]+/).map(e => e.split('@')[1]).filter(d => d && !FREE_MAIL.has(d));
const mailAddrs = s => String(s || '').toLowerCase().split(/[\s,;/]+/).filter(e => e.includes('@'));
const phones10 = s => String(s || '').split(/[/,;]/).map(x => x.replace(/\D/g, '').slice(-10)).filter(x => x.length === 10);

/** Customers this prospect may already be, and a suggested code for a new one. */
router.get('/:id/customer-match', authenticate, authorize('owner'), async (req, res) => {
  const db = getDB();
  const p = await db.get('SELECT id, company, email, phone, office_phone FROM prospects WHERE id = $1', [parseInt(req.params.id, 10)]);
  if (!p) return res.status(404).json({ error: 'Prospect not found' });
  const customers = await db.all('SELECT id, customer_code, name, email, phone FROM customers');
  const pName = normName(p.company), pMail = mailAddrs(p.email), pDom = mailDomains(p.email);
  const pTel = [...phones10(p.phone), ...phones10(p.office_phone)];
  const matches = [];
  for (const c of customers) {
    const cName = normName(c.name);
    let why = null;
    if (pMail.some(e => mailAddrs(c.email).includes(e))) why = 'same email';
    else if (pTel.some(t => phones10(c.phone).includes(t))) why = 'same phone';
    else if (pName && cName === pName) why = 'same name';
    else if (pDom.some(d => mailDomains(c.email).includes(d))) why = 'same email domain';
    else if (pName.length >= 5 && cName.length >= 5 && (cName.startsWith(pName) || pName.startsWith(cName))) why = 'similar name';
    if (why) matches.push({ id: c.id, customer_code: c.customer_code, name: c.name, why });
  }
  const taken = new Set(customers.map(c => String(c.customer_code).toUpperCase()));
  const RANK = ['same email', 'same phone', 'same name', 'same email domain', 'similar name'];
  matches.sort((a, b) => RANK.indexOf(a.why) - RANK.indexOf(b.why));
  res.json({ suggested_code: suggestCode(p.company, taken), matches: matches.slice(0, 5) });
});

/** Became a customer: create (or link) the Customers record, mark Won, move into Existing customers. */
router.post('/:id/convert', authenticate, authorize('owner'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const linkId = b.customer_id ? parseInt(b.customer_id, 10) : null;
  const code = String(b.customer_code || '').trim().toUpperCase();
  if (!linkId && !CODE_RE.test(code)) return res.status(400).json({ error: 'Customer code: capital letters or numbers, up to 12 (e.g. BE)' });
  const clean = v => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
  try {
    const out = await getDB().withTransaction(async (c) => {
      const p = (await c.query('SELECT * FROM prospects WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!p) throw httpErr(404, 'Prospect not found');
      if (p.customer_id) throw httpErr(409, 'Already linked to a customer');
      if (p.segment === EC_SEGMENT) throw httpErr(409, 'Already in the existing customers list');
      const day = istDay();
      let cust;
      if (linkId) {
        cust = (await c.query('SELECT id, customer_code, name FROM customers WHERE id = $1', [linkId])).rows[0];
        if (!cust) throw httpErr(404, 'Customer not found');
      } else {
        const name = clean(b.name) || p.company;
        const country = clean(b.country) ?? clean(p.country);
        try {
          cust = (await c.query(`
            INSERT INTO customers (customer_code, name, contact_person, phone, email, country_of_destination, notes, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, customer_code, name`,
            [code, name, clean(b.contact_person) ?? clean(p.contact_role), clean(b.phone) ?? clean(p.phone), clean(b.email) ?? clean(p.email),
             country && !/^india$/i.test(country) ? country : null,
             `Became a customer on ${day}, from the prospect list "${p.segment}".`, req.user.id])).rows[0];
        } catch (e) {
          if (e.code === '23505') throw httpErr(409, `Customer code ${code} is already used: pick another`);
          throw e;
        }
      }
      const touched = (await c.query(`
        UPDATE prospect_touches SET touch_key = $2 || ':' || touch_key
        WHERE prospect_id = $1 AND position(':' in touch_key) = 0 RETURNING channel`, [id, p.segment])).rows;
      const note = `Customer code ${cust.customer_code}. Became a customer on ${day} (moved from the ${p.segment} list).`;
      await c.query(`UPDATE prospects SET segment = $2, application = $3, priority = 'M', customer_id = $4, status = 'won',
          notes = $5 || coalesce(E'\n' || notes, '') WHERE id = $1`, [id, EC_SEGMENT, EC_NEW_APP, cust.id, note]);
      await c.query(`INSERT INTO prospect_status_log (prospect_id, from_status, to_status, note, changed_by) VALUES ($1,$2,'won',$3,$4)`,
        [id, p.status, `Became a customer: ${cust.customer_code} · ${cust.name} (${linkId ? 'linked to the existing record' : 'added to Customers'}); moved from ${p.segment} to existing customers`, req.user.id]);
      return { customer: cust, created: !linkId, from_segment: p.segment, emailed: touched.some(t => t.channel === 'email') || !['new'].includes(p.status) };
    });
    res.json(out);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error('convert prospect failed:', e);
    res.status(500).json({ error: 'Could not convert: ' + e.message });
  }
});

router.delete('/:id', authenticate, authorize(...SALES), async (req, res) => {
  await getDB().run('DELETE FROM prospects WHERE id = $1', [req.params.id]);
  res.json({ message: 'Deleted' });
});

// Zoho SMS sends to the contact's "Mobile" field in E.164 (+<country code><number>, no spaces).
// Only a real mobile goes there: older lists still hold some landlines in `phone`, and an SMS to
// those just fails. [country code, mobile pattern for the number after the code]
const MOBILE_RULES = {
  india: ['91', /^[6-9]\d{9}$/], vietnam: ['84', /^[35789]\d{8}$/], oman: ['968', /^[79]\d{7}$/],
  qatar: ['974', /^[3567]\d{7}$/], 'united arab emirates': ['971', /^5\d{8}$/], uae: ['971', /^5\d{8}$/],
  'saudi arabia': ['966', /^5\d{8}$/], kuwait: ['965', /^[569]\d{7}$/], bahrain: ['973', /^3\d{7}$/],
  'south africa': ['27', /^[6-8]\d{8}$/], 'new zealand': ['64', /^2\d{7,9}$/],
};
const RULES_BY_CC = Object.values(MOBILE_RULES).sort((a, b) => b[0].length - a[0].length);

function mobileE164(raw, country) {
  const first = String(raw || '').split(/[/,;]/)[0].trim();
  if (!first) return '';
  const intl = /^(\+|00)/.test(first);
  const digits = first.replace(/^(\+|00)/, '').replace(/\D/g, '');
  let rule = MOBILE_RULES[String(country || 'India').trim().toLowerCase()];
  let national = digits;
  if (intl) {
    // Written with a country code: trust the code, even when it differs from the row's country.
    rule = RULES_BY_CC.find(([cc]) => digits.startsWith(cc));
    if (!rule) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : '';
    national = digits.slice(rule[0].length);
  } else {
    if (!rule) return '';
    if (national.startsWith(rule[0]) && rule[1].test(national.slice(rule[0].length))) national = national.slice(rule[0].length);
  }
  national = national.replace(/^0+/, ''); // trunk 0, e.g. Vietnam 0912 345 678
  // India: "+91-79-26800000" is an Ahmedabad landline written STD-style (a 2–4 digit code, then
  // the number); a mobile is written as one block or 5+5. Digits alone can't tell them apart.
  if (rule[0] === '91') {
    const groups = first.replace(/^(\+|00)\s*91/, '').split(/[\s.-]+/).filter(Boolean);
    if (groups.length >= 2 && /^0?\d{2,4}$/.test(groups[0])) return '';
  }
  return rule[1].test(national) ? `+${rule[0]}${national}` : '';
}

/**
 * Zoho-ready CSV — ONE list for both channels: every contact with an email (Zoho Campaigns
 * ignores a contact without one), with their mobile in "Mobile" so the same list also takes
 * the SMS campaign. Optional ?segment=, ?source=, ?state=, ?application= and ?ids=1,2,3.
 */
router.get('/export.csv', authenticate, authorize(...SALES), async (req, res) => {
  const { segment, ids, source, state, application, status, priority } = req.query;
  const where = [], params = [];
  if (segment)     { params.push(segment);     where.push(`segment = $${params.length}`); }
  if (source)      { params.push(source);      where.push(`source = $${params.length}`); }
  if (state)       { params.push(state);       where.push(`state = $${params.length}`); }
  if (application) { params.push(application); where.push(`application = $${params.length}`); }
  if (status)      { params.push(status);      where.push(`status = $${params.length}`); }
  if (priority)    { params.push(priority);    where.push(`priority = $${params.length}`); }
  if (ids) {
    const idList = String(ids).split(',').map(s => parseInt(s, 10)).filter(Boolean);
    if (idList.length) {
      const ph = idList.map((_, i) => `$${params.length + i + 1}`).join(',');
      where.push(`id IN (${ph})`);
      params.push(...idList);
    }
  }
  // Zoho Campaigns imports a contact only with an email address.
  where.push(`coalesce(email,'') <> ''`);
  // "skip" rows (no fit / existing customers on an outreach list) and "not interested" never go to Zoho
  // (unless that status is what's being filtered on).
  if (!NO_CAMPAIGN.includes(status)) where.push(`coalesce(status,'') NOT IN ('skip','not_interested')`);

  const rows = await getDB().all(
    `SELECT * FROM prospects ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY CASE priority WHEN 'H' THEN 0 WHEN 'M' THEN 1 ELSE 2 END, company`, params);

  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  // Headers are Zoho Campaigns' own field names, so the import maps them by itself.
  // First Name deliberately carries the company: Zoho's only dependable merge tag is
  // $[FNAME|...]$, and the tailored emails and SMS use it to merge the company.
  // Mobile = SMS number (E.164); Phone = the office line, for calls.
  const header = ['Contact Email', 'First Name', 'Last Name', 'Company Name', 'Mobile', 'Phone', 'City', 'State', 'Country', 'Application', 'Priority'];
  const lines = [header.join(',')];
  for (const p of rows) {
    lines.push([p.email, p.company, '', p.company, mobileE164(p.phone, p.country), p.office_phone || '',
      p.city, p.state, p.country, p.application, p.priority].map(esc).join(','));
  }
  // Filename reflects the active filters so downloaded files are self-describing
  const slug = s => String(s).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  const parts = ['PHE', slug(segment || 'prospects')];
  if (application) parts.push(slug(application));
  if (state) parts.push(slug(state));
  const fname = `${parts.join('-')}-zoho.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(lines.join('\n'));
});

module.exports = router;
