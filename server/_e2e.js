// Verify esslToAttendance + computeLine math without a DB
const fs = require('fs');
const { parseEssl, matchEmployees } = require('./src/lib/esslParser');
(async () => {
  const buf = fs.readFileSync('/Users/vamashah/Desktop/Daily Attendance Report.pdf');
  const parsed = await parseEssl(buf);
  // Mock employees matching some report names
  const emps = [
    { id: 1, name: 'Mahendra', worker_group: 'fixed_admin', monthly_salary: 26400, petrol_monthly: 1190, daily_rate: null, advance_balance: 0 },
    { id: 2, name: 'Gaya', worker_group: 'fixed_admin', monthly_salary: 29000, petrol_monthly: 0, daily_rate: null, advance_balance: 0 },
    { id: 3, name: 'Nayan Lakhani', worker_group: 'fixed_production', monthly_salary: 52000, petrol_monthly: 550, daily_rate: null, advance_balance: 0 },
    { id: 4, name: 'Reena', worker_group: 'labour', daily_rate: 440, monthly_salary: null, petrol_monthly: 0, advance_balance: 2000 },
  ];
  const { matched, unmatched } = matchEmployees(parsed.workers, emps);
  const workingDays = 30;
  console.log('unmatched report names:', unmatched.length);
  for (const [empId, agg] of matched) {
    const e = emps.find(x => x.id === empId);
    const present = agg.present;
    const isFixed = e.worker_group !== 'labour';
    const absent = isFixed ? Math.max(workingDays - present, 0) : agg.absent;
    // Inline computeLine replica
    const r2 = n => Math.round(Number(n||0)*100)/100;
    let line;
    if (e.worker_group === 'labour') {
      const base = r2(e.daily_rate * present);
      const ot = r2((e.daily_rate/8) * agg.otHours);
      line = { base, ot, total: r2(base + ot - 0) };
    } else {
      const perDay = e.monthly_salary/30;
      const absDed = r2(perDay * Math.max(absent - 0, 0));
      const ot = r2((perDay/8) * agg.otHours);
      line = { perDay: r2(perDay), absDed, ot, petrol: e.petrol_monthly, total: r2(e.monthly_salary - absDed + ot + e.petrol_monthly) };
    }
    console.log(`${e.name} [${e.worker_group}] present=${present} absent=${absent} OT=${agg.otHours}h lateStays=${agg.lateStays} sickWk=${agg.sickCreditWeeks} =>`, line);
  }
})().catch(e => { console.error(e); process.exit(1); });
