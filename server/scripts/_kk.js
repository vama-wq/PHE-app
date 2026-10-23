// Apply the 23 Oct 2026 Khadya re-check (owner yes): ratings, skip for not-a-fit/duplicates,
// best/procurement contacts into EMPTY fields only, and a re-check line in notes.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const { getDB } = require('../src/db');
const WRITE = process.argv.includes('--write');
const final = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const TYPE = { 'purchase dept': 'purchase dept', 'vendor portal': 'vendor registration', 'main office': 'main office', sales: 'sales', owner: 'owner' };
const indMobile = raw => { let d = String(raw || '').replace(/\D/g, ''); if (d.startsWith('91') && d.length === 12) d = d.slice(2); d = d.replace(/^0/, ''); return /^[6-9]\d{9}$/.test(d) ? `+91 ${d.slice(0, 5)} ${d.slice(5)}` : null; };
const firstNum = s => String(s || '').split(/\s*[\/,;]\s*|\s+or\s+/)[0].trim();
const sameNum = (a, b) => a && b && String(a).replace(/\D/g, '').slice(-10) === String(b).replace(/\D/g, '').slice(-10);
(async () => {
  const db = getDB();
  const rows = await db.all(`SELECT id, company, priority, status, phone, office_phone, email, notes FROM prospects WHERE segment = 'khadya-khurak-exhibitors'`);
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  const stat = { pri: 0, skip: 0, phone: 0, office: 0, email: 0, notes: 0, emailConflict: [] };
  const plans = [];
  for (const f of final) {
    const r = byId[f.id]; if (!r) { console.log('missing row', f.id); continue; }
    if ((r.notes || '').includes('Re-checked 23 Oct 2026')) continue; // already applied
    const dup = f.potential === 'DUP', notFit = f.potential === 'L' || dup;
    const set = { priority: dup ? 'L' : f.potential };
    if (notFit && r.status === 'new') set.status = 'skip';
    const num = firstNum(f.procurement_phone);
    if (!notFit && num) {
      const mob = indMobile(num);
      const known = sameNum(num, r.phone) || sameNum(num, r.office_phone);
      if (!known) {
        if (mob && !r.phone && f.confidence === 'high') set.phone = mob;
        else if (!r.office_phone) set.office_phone = mob || num;
      }
    }
    if (!notFit && f.procurement_email && !r.email) set.email = f.procurement_email.trim().toLowerCase();
    const contact = [TYPE[f.contact_type] || f.contact_type, f.procurement_phone, f.procurement_email].filter(Boolean).join(' · ');
    const line = dup ? `Re-checked 23 Oct 2026: ${f.reason} — set to skip.`
      : notFit ? `Re-checked 23 Oct 2026 — makes: ${f.what_they_make}. Not a fit: ${f.reason} — set to skip.`
      : `Re-checked 23 Oct 2026 (${set.priority}) — makes: ${f.what_they_make}. Heaters: ${f.heater_types || '—'}. ${f.reason}.`
        + (f.confidence === 'low' ? ' Could not verify online — check at the stall.' : '')
        + ` Best/procurement contact: ${contact || 'not published (only directory routing numbers)'}${f.source_url ? ` (source: ${f.source_url})` : ''}.`
        + (f.id === 821 ? ' NOTE: the email/number on this row belong to Jay Bhavani Industries, Jasdan — a different company.' : '')
        + (f.id === 678 ? ' Same factory address and phone as Shanta G Technofoods (sister company).' : '');
    set.notes = `${r.notes || ''}${r.notes ? ' · ' : ''}${line.replace(/\.\./g, '.')}`;
    if (set.priority !== r.priority) stat.pri++; if (set.status) stat.skip++; if (set.phone) stat.phone++; if (set.office_phone) stat.office++; if (set.email) stat.email++; stat.notes++;
    plans.push([r, set]);
  }
  console.log(`rows to update: ${plans.length} | priority changes ${stat.pri} | set to skip ${stat.skip} | new WhatsApp ${stat.phone} | new office line ${stat.office} | new email ${stat.email}`);
  for (const [r, s] of plans.filter(([, s]) => s.phone || s.office_phone || s.email).slice(0, 60))
    console.log(`  #${r.id} ${r.company.slice(0, 32).padEnd(32)} ${s.phone ? 'WA ' + s.phone : ''} ${s.office_phone ? '☎ ' + s.office_phone : ''} ${s.email ? '✉ ' + s.email : ''}`);
  if (!WRITE) { console.log('(dry run)'); process.exit(0); }
  await db.run('BEGIN');
  try {
    for (const [r, s] of plans) {
      const keys = Object.keys(s); const vals = keys.map(k => s[k]);
      await db.run(`UPDATE prospects SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1}`, [...vals, r.id]);
    }
    await db.run('COMMIT');
  } catch (e) { await db.run('ROLLBACK'); throw e; }
  const after = await db.all(`SELECT priority, status, count(*)::int n FROM prospects WHERE segment='khadya-khurak-exhibitors' GROUP BY 1,2 ORDER BY 2,1`);
  console.table(after);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
