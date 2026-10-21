const router = require('express').Router();
const { getDB } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

// Sales prospecting is a sales/management function — gate to these roles.
const SALES = ['owner', 'admin', 'accounts'];

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

/** Update a single prospect's status or editable fields. */
router.patch('/:id', authenticate, authorize(...SALES), async (req, res) => {
  const allowed = ['status', 'priority', 'email', 'phone', 'contact_role', 'product_fit', 'notes'];
  const sets = [], params = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) { params.push(req.body[key]); sets.push(`${key} = $${params.length}`); }
  }
  if (!sets.length) return res.status(400).json({ error: 'No updatable fields provided' });
  params.push(req.params.id);
  await getDB().run(`UPDATE prospects SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  res.json({ message: 'Updated' });
});

/** Mark many prospects with a status in one call (e.g. exported / contacted). */
router.post('/bulk-status', authenticate, authorize(...SALES), async (req, res) => {
  const { ids, status } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
  if (!status) return res.status(400).json({ error: 'status required' });
  const ph = ids.map((_, i) => `$${i + 2}`).join(',');
  await getDB().run(`UPDATE prospects SET status = $1 WHERE id IN (${ph})`, [status, ...ids]);
  res.json({ message: 'Updated', count: ids.length });
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
  // "skip" rows (no fit / existing customers on an outreach list) never go to Zoho.
  if (status !== 'skip') where.push(`coalesce(status,'') <> 'skip'`);

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
