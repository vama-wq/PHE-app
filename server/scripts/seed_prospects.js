#!/usr/bin/env node
/**
 * Seed researched B2B prospects into the `prospects` table.
 *
 * Usage:
 *   node server/scripts/seed_prospects.js <path-to-json> [segment]
 *
 * The JSON is an array of objects using either the compact keys the
 * prospecting skill writes (co/seg/role/fit) or the full column names:
 *   { "co|company", "city", "state", "seg|segment", "email", "phone",
 *     "role|contact_role", "fit|product_fit", "priority" }
 *
 * Duplicates (same company + email) are skipped via the unique index.
 * Connects to whatever DATABASE_URL is in server/.env — that is PRODUCTION.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const { getDB } = require('../src/db');

async function main() {
  const file = process.argv[2];
  const segmentArg = process.argv[3];
  if (!file) {
    console.error('Usage: node server/scripts/seed_prospects.js <path-to-json> [segment]');
    process.exit(1);
  }
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.error(`File not found: ${abs}`);
    process.exit(1);
  }

  const list = JSON.parse(fs.readFileSync(abs, 'utf8'));
  if (!Array.isArray(list) || !list.length) {
    console.error('Expected a non-empty JSON array of prospects.');
    process.exit(1);
  }

  const db = getDB();
  let inserted = 0, updated = 0, skipped = 0;
  for (const p of list) {
    const company = (p.company || p.co || '').trim();
    const segment = (segmentArg || p.segment || p.seg || '').trim();
    if (!company || !segment) { skipped++; continue; }
    const v = [
      p.city || null, p.state || null, p.country || 'India',
      p.email || null, p.phone || null, p.role || p.contact_role || null,
      p.fit || p.product_fit || null, (p.priority || 'M').toUpperCase().slice(0, 1),
      p.source || 'claude-research', p.notes || null,
    ];
    // Upsert keyed on company+segment so re-runs (e.g. after a verification pass)
    // refresh contact details in place instead of creating duplicates.
    const upd = await db.run(
      `UPDATE prospects SET city=$1, state=$2, country=$3, email=$4, phone=$5,
         contact_role=$6, product_fit=$7, priority=$8, source=$9, notes=$10
       WHERE lower(company)=lower($11) AND segment=$12`,
      [...v, company, segment]
    );
    if (upd.rowCount > 0) { updated++; continue; }
    await db.run(
      `INSERT INTO prospects (city, state, country, email, phone, contact_role, product_fit, priority, source, notes, company, segment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [...v, company, segment]
    );
    inserted++;
  }

  console.log(`✅ Seeded prospects from ${path.basename(abs)}`);
  console.log(`   Inserted: ${inserted}   Updated in place: ${updated}   Skipped (invalid): ${skipped}   Total in file: ${list.length}`);
  await db.pool.end();
}

main().catch(err => { console.error('Seed failed:', err.message); process.exit(1); });
