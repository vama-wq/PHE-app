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
    SELECT * FROM prospects
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
    SELECT id, from_status, $1, $3, $4 FROM upd RETURNING prospect_id`, [status, ids, note || null, userId || null]);
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
  if (req.body.status !== undefined) await setStatus(db, [id], req.body.status, req.body.status_note, req.user.id);
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
