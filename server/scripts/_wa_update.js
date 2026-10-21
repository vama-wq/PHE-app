// One-off: push the restructured WhatsApp copy to prod. Content columns only — never notes / contacts / priority.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const { getDB } = require('../src/db');
const D = '/Users/vamashah/Desktop/Clients - AHM/phe-claude-code/data/';
const SETS = [['prospects_vietnam.json', 'vietnam'], ['prospects_oman.json', 'oman'], ['prospects_qatar.json', 'qatar'], ['prospects_khadya_khurak.json', 'pharma-tech-expo']];
(async () => {
  const db = getDB();
  for (const [file, seg] of SETS) {
    const rows = JSON.parse(fs.readFileSync(D + file, 'utf8'));
    let upd = 0; const miss = [];
    for (const p of rows) {
      const seq = p.campaign_sequence == null ? null : (typeof p.campaign_sequence === 'string' ? p.campaign_sequence : JSON.stringify(p.campaign_sequence));
      const r = await db.run(
        'UPDATE prospects SET email_subject=$1, email_body=$2, whatsapp_msg=$3, call_script=$4, campaign_sequence=$5 WHERE lower(company)=lower($6) AND segment=$7',
        [p.email_subject || null, p.email_body || null, p.whatsapp_msg || null, p.call_script || null, seq, p.co, seg]);
      if (r.rowCount) upd += r.rowCount; else miss.push(p.co);
    }
    const chk = await db.get(`SELECT COUNT(*)::int n, SUM(CASE WHEN whatsapp_msg LIKE '%*What we make for you*%' OR campaign_sequence LIKE '%📍 *Khadya Khurak 2026*%' THEN 1 ELSE 0 END)::int structured FROM prospects WHERE segment=$1`, [seg]);
    console.log(`${seg.padEnd(17)} updated ${upd}/${rows.length} | not found ${miss.length} | structured WhatsApp in prod: ${chk.structured}/${chk.n}`);
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
