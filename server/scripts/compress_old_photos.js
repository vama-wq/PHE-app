// One-time maintenance: re-compress existing photos in Supabase storage.
// Downloads each large image, resizes to max 1600px JPEG q75 via macOS `sips`,
// and re-uploads to the SAME path (upsert) so no DB reference changes.
// Run:  node scripts/compress_old_photos.js          (dry run — lists targets)
//       node scripts/compress_old_photos.js --run    (actually compress)
require('dotenv').config({ path: __dirname + '/../.env' });
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { getDB } = require('../src/db');

const BUCKET = 'phe-uploads';
const FOLDERS = ['checklist-photos', 'rejection-photos', 'product-photos', 'item-images', 'query-photos'];
const MIN_BYTES = 300 * 1024; // only files worth compressing
const RUN = process.argv.includes('--run');

(async () => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const db = getDB();
  const likeClauses = FOLDERS.map((_, i) => `name LIKE $${i + 2}`).join(' OR ');
  const rows = await db.all(
    `SELECT name, (metadata->>'size')::bigint AS bytes FROM storage.objects
     WHERE bucket_id=$1 AND (${likeClauses})
       AND (metadata->>'size')::bigint > ${MIN_BYTES}
       AND lower(name) ~ '\\.(jpe?g|png|webp|heic)$'
     ORDER BY bytes DESC`,
    [BUCKET, ...FOLDERS.map(f => `${f}/%`)]
  );
  const totalBefore = rows.reduce((s, r) => s + Number(r.bytes), 0);
  console.log(`${rows.length} files to compress, ${(totalBefore / 1048576).toFixed(0)} MB total`);
  if (!RUN) { console.log('Dry run — pass --run to compress.'); process.exit(0); }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phe-compress-'));
  let done = 0, saved = 0, skipped = 0, failed = 0;
  for (const r of rows) {
    try {
      const { data, error } = await sb.storage.from(BUCKET).download(r.name);
      if (error) throw new Error(error.message);
      const inFile = path.join(tmp, 'in' + path.extname(r.name));
      const outFile = path.join(tmp, 'out.jpg');
      fs.writeFileSync(inFile, Buffer.from(await data.arrayBuffer()));
      execFileSync('sips', ['-Z', '1600', '-s', 'format', 'jpeg', '-s', 'formatOptions', '75', inFile, '--out', outFile], { stdio: 'ignore' });
      const outBuf = fs.readFileSync(outFile);
      if (outBuf.length >= Number(r.bytes) * 0.9) { skipped++; done++; continue; } // not worth it
      const up = await sb.storage.from(BUCKET).upload(r.name, outBuf, { contentType: 'image/jpeg', upsert: true });
      if (up.error) throw new Error(up.error.message);
      saved += Number(r.bytes) - outBuf.length;
      done++;
      if (done % 25 === 0) console.log(`${done}/${rows.length} done — ${(saved / 1048576).toFixed(0)} MB saved so far`);
    } catch (e) {
      failed++;
      console.error(`FAIL ${r.name}: ${e.message}`);
      if (failed > 20) { console.error('Too many failures — aborting.'); break; }
    }
  }
  console.log(`\nFinished: ${done}/${rows.length} processed, ${skipped} skipped (already small), ${failed} failed`);
  console.log(`Saved ${(saved / 1048576).toFixed(0)} MB`);
  const after = await db.get(
    `SELECT pg_size_pretty(SUM((metadata->>'size')::bigint)) AS size FROM storage.objects WHERE bucket_id=$1`, [BUCKET]);
  console.log('Bucket total now:', after.size);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
