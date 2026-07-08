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
  let inserted = 0, skipped = 0;
  for (const p of list) {
    const company = (p.company || p.co || '').trim();
    const segment = (segmentArg || p.segment || p.seg || '').trim();
    if (!company || !segment) { skipped++; continue; }
    const r = await db.run(
      `INSERT INTO prospects (company, city, state, country, segment, email, phone, contact_role, product_fit, priority, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (lower(company), lower(coalesce(email,''))) DO NOTHING`,
      [company, p.city || null, p.state || null, p.country || 'India', segment,
       p.email || null, p.phone || null, p.role || p.contact_role || null,
       p.fit || p.product_fit || null, (p.priority || 'M').toUpperCase().slice(0, 1),
       p.source || 'claude-research']
    );
    r.rowCount ? inserted++ : skipped++;
  }

  console.log(`✅ Seeded prospects from ${path.basename(abs)}`);
  console.log(`   Inserted: ${inserted}   Skipped (dupes/invalid): ${skipped}   Total in file: ${list.length}`);
  await db.pool.end();
}

main().catch(err => { console.error('Seed failed:', err.message); process.exit(1); });
