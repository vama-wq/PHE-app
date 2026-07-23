// Bulk-compress old photos in Supabase storage IN PLACE (same paths).
// jpg/jpeg → resized 1600px JPEG q75; png → resized 1600px PNG.
// Only uploads when the result is SMALLER. Usage: node _compress_photos.js [limit]
require('dotenv').config();
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TMP = '/private/tmp/claude-501/-Users-vamashah-Desktop-Clients---AHM/062de007-8d9b-47c7-bd9f-9772c7741f39/scratchpad/compress';
fs.mkdirSync(TMP, { recursive: true });
const FOLDERS = ['checklist-photos', 'rejection-photos', 'product-photos', 'item-images', 'query-photos'];
const MIN_BYTES = 300 * 1024;
const LIMIT = parseInt(process.argv[2], 10) || 0;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const fmt = (b) => (b / 1024 / 1024).toFixed(2) + 'MB';

async function targets() {
  const { rows } = await pool.query(`
    SELECT name, (metadata->>'size')::bigint AS size
    FROM storage.objects
    WHERE bucket_id='phe-uploads'
      AND split_part(name,'/',1) = ANY($1)
      AND (metadata->>'size')::bigint > $2
      AND lower(name) ~ '\\.(jpe?g|png)$'
    ORDER BY size DESC`, [FOLDERS, MIN_BYTES]);
  return LIMIT ? rows.slice(0, LIMIT) : rows;
}

async function compressOne(obj, idx, total) {
  const ext = obj.name.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
  const inFile = path.join(TMP, `in_${idx}.${ext}`);
  const outFile = path.join(TMP, `out_${idx}.${ext}`);
  try {
    const { data, error } = await sb.storage.from('phe-uploads').download(obj.name);
    if (error) throw new Error(`download: ${error.message}`);
    fs.writeFileSync(inFile, Buffer.from(await data.arrayBuffer()));

    const args = ext === 'jpg'
      ? ['-Z', '1600', '-s', 'format', 'jpeg', '-s', 'formatOptions', '75', inFile, '--out', outFile]
      : ['-Z', '1600', inFile, '--out', outFile];
    execFileSync('/usr/bin/sips', args, { stdio: 'ignore' });

    const before = Number(obj.size);
    const after = fs.statSync(outFile).size;
    if (after >= before) {
      console.log(`[${idx + 1}/${total}] SKIP (no gain) ${obj.name} ${fmt(before)}`);
      return { before, after: before, skipped: true };
    }
    const buf = fs.readFileSync(outFile);
    const { error: upErr } = await sb.storage.from('phe-uploads').upload(obj.name, buf, {
      upsert: true, contentType: ext === 'jpg' ? 'image/jpeg' : 'image/png',
    });
    if (upErr) throw new Error(`upload: ${upErr.message}`);
    console.log(`[${idx + 1}/${total}] OK ${obj.name} ${fmt(before)} -> ${fmt(after)}`);
    return { before, after, skipped: false };
  } finally {
    fs.rmSync(inFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}

(async () => {
  const list = await targets();
  console.log(`targets: ${list.length} files, ${fmt(list.reduce((a, o) => a + Number(o.size), 0))} total`);
  let done = 0, saved = 0, errors = 0, totBefore = 0, totAfter = 0;
  const CONC = 3;
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      try {
        const r = await compressOne(list[i], i, list.length);
        totBefore += r.before; totAfter += r.after;
        if (!r.skipped) saved++;
        done++;
      } catch (e) {
        errors++;
        console.log(`[${i + 1}/${list.length}] ERROR ${list[i].name}: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`\nDONE: ${done} processed (${saved} compressed), ${errors} errors`);
  console.log(`SIZE: ${fmt(totBefore)} -> ${fmt(totAfter)} (saved ${fmt(totBefore - totAfter)})`);
  await pool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
