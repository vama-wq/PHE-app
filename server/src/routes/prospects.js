const router = require('express').Router();
const { getDB } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

// Sales prospecting is a sales/management function — gate to these roles.
const SALES = ['owner', 'admin', 'accounts'];

/** List prospects, optionally filtered by segment / priority / status. */
router.get('/', authenticate, authorize(...SALES), async (req, res) => {
  const { segment, priority, status, source } = req.query;
  const where = [];
  const params = [];
  if (segment)  { params.push(segment);  where.push(`segment = $${params.length}`); }
  if (priority) { params.push(priority); where.push(`priority = $${params.length}`); }
  if (status)   { params.push(status);   where.push(`status = $${params.length}`); }
  if (source)   { params.push(source);   where.push(`source = $${params.length}`); }
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

/**
 * Zoho-ready CSV. ?type=email (default) → contacts with an email, for an email
 * campaign. ?type=sms → contacts with a phone, for an SMS campaign. Optional
 * ?segment=, ?source=, and ?ids=1,2,3 to scope the export.
 */
router.get('/export.csv', authenticate, authorize(...SALES), async (req, res) => {
  const { segment, ids, source } = req.query;
  const type = req.query.type === 'sms' ? 'sms' : 'email';
  const where = [], params = [];
  if (segment) { params.push(segment); where.push(`segment = $${params.length}`); }
  if (source)  { params.push(source);  where.push(`source = $${params.length}`); }
  if (ids) {
    const idList = String(ids).split(',').map(s => parseInt(s, 10)).filter(Boolean);
    if (idList.length) {
      const ph = idList.map((_, i) => `$${params.length + i + 1}`).join(',');
      where.push(`id IN (${ph})`);
      params.push(...idList);
    }
  }
  // Only export rows that actually have the channel's contact field.
  where.push(type === 'sms' ? `coalesce(phone,'') <> ''` : `coalesce(email,'') <> ''`);

  const rows = await getDB().all(
    `SELECT * FROM prospects ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY CASE priority WHEN 'H' THEN 0 WHEN 'M' THEN 1 ELSE 2 END, company`, params);

  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  let header, lines;
  if (type === 'sms') {
    header = ['Mobile Number', 'First Name', 'Company', 'City', 'Segment', 'Priority'];
    lines = [header.join(',')];
    for (const p of rows) lines.push([p.phone, p.company, p.company, p.city, p.segment, p.priority].map(esc).join(','));
  } else {
    header = ['First Name', 'Last Name', 'Email Address', 'Phone', 'City', 'State', 'Company', 'Segment', 'Priority'];
    lines = [header.join(',')];
    for (const p of rows) lines.push([p.company, '', p.email, p.phone, p.city, p.state, p.company, p.segment, p.priority].map(esc).join(','));
  }
  const fname = `PHE-${(segment || 'prospects').replace(/[^a-z0-9]+/gi, '-')}-${type}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(lines.join('\n'));
});

module.exports = router;
