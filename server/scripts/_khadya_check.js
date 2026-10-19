require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getDB } = require('../src/db');
(async () => {
  const db = getDB();
  const rows = await db.all(
    "SELECT company, segment FROM prospects WHERE campaign_sequence LIKE '%Khadya%' ORDER BY company"
  );
  console.log('Khadya rows in prod:', rows.length);
  const segs = [...new Set(rows.map(r => r.segment))];
  console.log('distinct segments:', JSON.stringify(segs));
  rows.forEach(r => console.log(' -', r.company, '|', r.segment));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
