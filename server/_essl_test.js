const fs = require('fs');
const { parseEssl } = require('./src/lib/esslParser');
(async () => {
  const buf = fs.readFileSync('/Users/vamashah/Desktop/Daily Attendance Report.pdf');
  const r = await parseEssl(buf);
  console.log('period:', r.period, '| days parsed:', r.dayCount);
  console.log('workers found:', r.workers.size);
  const rows = [...r.workers.values()].map(w => ({
    name: w.nameShift.slice(0, 24), days: w.days, present: w.present, absent: w.absent,
    noOut: w.noOutPunch, otHrs: w.otHours, lateStays: w.lateStays, sickWeeks: w.sickCreditWeeks,
  }));
  console.table(rows);
})().catch(e => { console.error('ERR:', e); process.exit(1); });
