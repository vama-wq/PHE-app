// REAL bulk compression — trusts only actual downloaded bytes (metadata was
// corrupted by a failed run on 22 Jul while the project was quota-restricted).
// jpg/jpeg → 1600px JPEG q75; png → 1600px PNG. Upserts to the SAME path only
// when smaller; a successful upsert also repairs the object's metadata row.
require('dotenv').config();
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TMP = '/private/tmp/claude-501/-Users-vamashah-Desktop-Clients---AHM/062de007-8d9b-47c7-bd9f-9772c7741f39/scratchpad/compress';
fs.mkdirSync(TMP, { recursive: true });
const FOLDERS = ['checklist-photos', 'rejection-photos', 'product-photos', 'item-images', 'query-photos', 'qc'];
const MIN_BYTES = 300 * 1024;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const fmt = (b) => (b / 1024 / 1024).toFixed(2) + 'MB';

async function compressOne(name, idx, total) {
  const ext = name.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
  const inFile = path.join(TMP, `in_${idx}.${ext}`);
  const outFile = path.join(TMP, `out_${idx}.${ext}`);
  try {
    const { data, error } = await sb.storage.from('phe-uploads').download(name);
    if (error) throw new Error(`download: ${error.message}`);
    const buf = Buffer.from(await data.arrayBuffer());
    const before = buf.length; // REAL size — metadata is unreliable
    if (before <= MIN_BYTES) return { before, after: before, small: true };
    fs.writeFileSync(inFile, buf);
    const args = ext === 'jpg'
      ? ['-Z', '1600', '-s', 'format', 'jpeg', '-s', 'formatOptions', '75', inFile, '--out', outFile]
      : ['-Z', '1600', inFile, '--out', outFile];
    execFileSync('/usr/bin/sips', args, { stdio: 'ignore' });
    const after = fs.statSync(outFile).size;
    if (after >= before) {
      console.log(`[${idx + 1}/${total}] SKIP (no gain) ${name} ${fmt(before)}`);
      return { before, after: before, small: false };
    }
    const out = fs.readFileSync(outFile);
    const { error: upErr } = await sb.storage.from('phe-uploads').upload(name, out, {
      upsert: true, contentType: ext === 'jpg' ? 'image/jpeg' : 'image/png',
    });
    if (upErr) throw new Error(`upload: ${upErr.message}`);
    console.log(`[${idx + 1}/${total}] OK ${name} ${fmt(before)} -> ${fmt(after)}`);
    return { before, after, small: false, compressed: true };
  } finally {
    fs.rmSync(inFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}

(async () => {
  const { rows } = await pool.query(`
    SELECT name FROM storage.objects
    WHERE bucket_id='phe-uploads'
      AND split_part(name,'/',1) = ANY($1)
      AND lower(name) ~ '\\.(jpe?g|png)$'
    ORDER BY name`, [FOLDERS]);
  const list = rows.map(r => r.name);
  console.log(`candidates: ${list.length} images (real sizes checked per file)`);
  let done = 0, compressed = 0, small = 0, errors = 0, totBefore = 0, totAfter = 0;
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const r = await compressOne(list[i], i, list.length);
          totBefore += r.before; totAfter += r.after;
          if (r.compressed) compressed++;
          if (r.small) small++;
          done++;
          break;
        } catch (e) {
          if (attempt === 2) { errors++; console.log(`[${i + 1}/${list.length}] ERROR ${list[i]}: ${e.message}`); }
          else await new Promise(r2 => setTimeout(r2, 3000));
        }
      }
      if ((done + errors) % 50 === 0) console.log(`--- progress: ${done + errors}/${list.length}, real ${fmt(totBefore)} -> ${fmt(totAfter)}`);
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  console.log(`\nDONE: ${done} processed — ${compressed} compressed, ${small} already small, ${errors} errors`);
  console.log(`REAL SIZE: ${fmt(totBefore)} -> ${fmt(totAfter)} (saved ${fmt(totBefore - totAfter)})`);
  await pool.end();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
