const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadEsslReport, deleteFromStorage, downloadFromStorage } = require('../middleware/upload');
const { parseEssl, matchEmployees } = require('../lib/esslParser');

// ── Payroll ───────────────────────────────────────────────────────────────────
// Worker groups and policies (confirmed by owner):
//  • labour            — paid present_days × daily_rate, no paid leave
//  • fixed_admin       — monthly salary ÷ 30/day, 8h standard day
//  • fixed_production  — monthly salary ÷ 30/day, 10h standard day
//  • OT for everyone   = ot_hours × (day pay ÷ 8)
//  • Fixed groups accrue +1 paid leave per month (carryforward; max 5 carried
//    into a new year; >7 leaves together flagged & excess unpaid)
//  • Admin: a week with 4+ days leaving at/after 18:30 earns +1 sick credit
//  • Leave usage is decided by the OWNER per worker each month (ask-each-month)
//  • Advances tracked per employee; deducted in the month's run
// Roles: accounts PREPARES (attendance only — never sees rates, amounts or
// bank details); OWNER reviews, approves and marks paid (salary day = 7th).

const FIXED_GROUPS = ['fixed_admin', 'fixed_production'];
const MONTH_BASIS_DAYS = 30; // fixed salary ÷ 30, always
const OT_DIVISOR = 8;        // OT hour = day pay ÷ 8 for every group
const MAX_CARRYFORWARD = 5;  // leaves carried into a new year
const MAX_TOGETHER = 7;      // more than this together → flag, excess unpaid

const isOwner = (req) => req.user.role === 'owner';
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// Salary maths — single source of truth
function computeLine(emp, line) {
  const present = Number(line.present_days || 0);
  const absent = Number(line.absent_days || 0);
  const ot = Number(line.ot_hours || 0);
  const creditUsed = Number(line.leave_credit_used || 0);
  const petrol = Number(line.petrol ?? emp.petrol_monthly ?? 0);
  const advance = Number(line.advance_deduction || 0);

  if (emp.worker_group === 'labour') {
    const rate = Number(line.daily_rate ?? emp.daily_rate ?? 0);
    const base = r2(rate * present);
    const otAmount = r2((rate / OT_DIVISOR) * ot);
    return {
      daily_rate: rate, monthly_salary: null,
      base_pay: base, ot_amount: otAmount, absent_deduction: 0,
      petrol: 0, // labour never receives petrol
      advance_deduction: r2(advance),
      total_payable: r2(base + otAmount - advance),
    };
  }
  // fixed_admin / fixed_production
  const salary = Number(line.monthly_salary ?? emp.monthly_salary ?? 0);
  const perDay = salary / MONTH_BASIS_DAYS;
  const chargedAbsent = Math.max(absent - creditUsed, 0);
  const absentDeduction = r2(perDay * chargedAbsent);
  const otAmount = r2((perDay / OT_DIVISOR) * ot);
  return {
    daily_rate: r2(perDay), monthly_salary: salary,
    base_pay: r2(salary - absentDeduction), ot_amount: otAmount, absent_deduction: absentDeduction,
    petrol: r2(petrol), advance_deduction: r2(advance),
    total_payable: r2(salary - absentDeduction + otAmount + petrol - advance),
  };
}

// Leave balance = sum of ledger deltas
async function leaveBalance(db, employeeId) {
  const row = await db.get(
    'SELECT COALESCE(SUM(delta),0) AS bal FROM employee_leave_ledger WHERE employee_id=$1', [employeeId]);
  return Number(row.bal);
}

// Parse an ESSL PDF and turn it into per-line attendance for this run's
// employees. present from the report; for fixed groups absent = workingDays −
// present (unlisted days count as absent until the owner corrects); OT hours
// and 6:30 late-stays as counted; admin sick-credit weeks pre-filled as a
// suggestion. Returns { applied, unmatched, updates:[{employee_id,...}] }.
async function esslToAttendance(buffer, employees, workingDays) {
  const parsed = await parseEssl(buffer);
  const { matched, unmatched } = matchEmployees(parsed.workers, employees);
  const empById = Object.fromEntries(employees.map(e => [e.id, e]));
  const updates = [];
  for (const [empId, agg] of matched) {
    const emp = empById[empId];
    const present = agg.present;
    const isFixed = FIXED_GROUPS.includes(emp.worker_group);
    updates.push({
      employee_id: empId,
      present_days: present,
      absent_days: isFixed ? Math.max(workingDays - present, 0) : agg.absent,
      ot_hours: agg.otHours,
      late_stay_days: emp.worker_group === 'fixed_admin' ? agg.lateStays : 0,
      sick_credit_earned: emp.worker_group === 'fixed_admin' ? agg.sickCreditWeeks : 0,
    });
  }
  return { applied: updates.length, unmatched, period: parsed.period, updates };
}

// Write parsed attendance onto the run's lines (used by create + re-parse).
async function applyAttendanceUpdates(client, runId, updates) {
  for (const u of updates) {
    const { rows } = await client.query(
      `SELECT pl.*, e.worker_group AS eg, e.daily_rate AS e_rate, e.monthly_salary AS e_salary,
              e.petrol_monthly AS e_petrol
       FROM payroll_lines pl JOIN employees e ON e.id = pl.employee_id
       WHERE pl.run_id=$1 AND pl.employee_id=$2`, [runId, u.employee_id]);
    const line = rows[0];
    if (!line) continue;
    const merged = {
      ...line,
      present_days: u.present_days, absent_days: u.absent_days,
      ot_hours: u.ot_hours, late_stay_days: u.late_stay_days,
    };
    const emp = { worker_group: line.worker_group, daily_rate: line.eg === 'labour' ? line.e_rate : null,
                  monthly_salary: line.e_salary, petrol_monthly: line.e_petrol };
    const pay = computeLine(emp, merged);
    await client.query(
      `UPDATE payroll_lines SET present_days=$1, absent_days=$2, ot_hours=$3, late_stay_days=$4,
         sick_credit_earned=$5, long_leave_flag=$6,
         base_pay=$7, ot_amount=$8, absent_deduction=$9, total_payable=$10
       WHERE id=$11`,
      [u.present_days, u.absent_days, u.ot_hours, u.late_stay_days, u.sick_credit_earned || 0,
       Number(u.absent_days) > MAX_TOGETHER,
       pay.base_pay, pay.ot_amount, pay.absent_deduction, pay.total_payable, line.id]);
  }
}

// Strip pay/bank fields for non-owner responses
const ATTENDANCE_FIELDS = ['id', 'run_id', 'employee_id', 'worker_group', 'present_days', 'absent_days',
  'ot_hours', 'late_stay_days', 'long_leave_flag', 'remarks', 'name', 'active'];
function visibleLine(line, owner) {
  if (owner) return line;
  return Object.fromEntries(Object.entries(line).filter(([k]) => ATTENDANCE_FIELDS.includes(k)));
}

// ── Employees ─────────────────────────────────────────────────────────────────
router.get('/employees', authenticate, authorize('owner', 'accounts'), async (req, res) => {
  try {
    const rows = await getDB().all('SELECT * FROM employees ORDER BY worker_group, name');
    if (isOwner(req)) {
      const balances = await getDB().all(
        'SELECT employee_id, COALESCE(SUM(delta),0) AS bal FROM employee_leave_ledger GROUP BY employee_id');
      const balMap = Object.fromEntries(balances.map(b => [b.employee_id, Number(b.bal)]));
      return res.json(rows.map(e => ({ ...e, leave_balance: balMap[e.id] || 0 })));
    }
    // accounts: names + groups only — no rates, salaries, petrol, advances or bank details
    res.json(rows.map(e => ({
      id: e.id, name: e.name, worker_group: e.worker_group, active: e.active, joined_on: e.joined_on,
    })));
  } catch (e) {
    console.error('employees list error:', e);
    res.status(500).json({ error: 'Failed to load employees' });
  }
});

router.post('/employees', authenticate, authorize('owner'), async (req, res) => {
  try {
    const { name, worker_group, daily_rate, monthly_salary, petrol_monthly,
            bank_ac_no, ifsc_code, ac_holder_name, joined_on, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!['labour', 'fixed_admin', 'fixed_production'].includes(worker_group)) {
      return res.status(400).json({ error: 'Pick a valid worker type' });
    }
    if (worker_group === 'labour' && !(Number(daily_rate) > 0)) {
      return res.status(400).json({ error: 'Daily rate is required for per-day labour' });
    }
    if (FIXED_GROUPS.includes(worker_group) && !(Number(monthly_salary) > 0)) {
      return res.status(400).json({ error: 'Monthly salary is required for fixed-salary workers' });
    }
    const r = await getDB().insert(
      `INSERT INTO employees (name, worker_group, daily_rate, monthly_salary, petrol_monthly,
         bank_ac_no, ifsc_code, ac_holder_name, joined_on, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [name.trim(), worker_group,
       worker_group === 'labour' ? Number(daily_rate) : null,
       FIXED_GROUPS.includes(worker_group) ? Number(monthly_salary) : null,
       Number(petrol_monthly) || 0,
       (bank_ac_no || '').trim() || null, (ifsc_code || '').trim() || null, (ac_holder_name || '').trim() || null,
       joined_on || null, (notes || '').trim() || null, req.user.id]);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) {
    console.error('employee create error:', e);
    res.status(500).json({ error: 'Failed to add employee' });
  }
});

router.put('/employees/:id', authenticate, authorize('owner'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid employee id' });
    const db = getDB();
    const emp = await db.get('SELECT * FROM employees WHERE id=$1', [id]);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const { name, worker_group, daily_rate, monthly_salary, petrol_monthly,
            bank_ac_no, ifsc_code, ac_holder_name, joined_on, notes, active } = req.body;
    const group = worker_group || emp.worker_group;
    if (!['labour', 'fixed_admin', 'fixed_production'].includes(group)) {
      return res.status(400).json({ error: 'Pick a valid worker type' });
    }
    await db.run(
      `UPDATE employees SET name=$1, worker_group=$2, daily_rate=$3, monthly_salary=$4, petrol_monthly=$5,
         bank_ac_no=$6, ifsc_code=$7, ac_holder_name=$8, joined_on=$9, notes=$10, active=$11 WHERE id=$12`,
      [(name ?? emp.name).trim(), group,
       group === 'labour' ? (daily_rate != null ? Number(daily_rate) : emp.daily_rate) : null,
       FIXED_GROUPS.includes(group) ? (monthly_salary != null ? Number(monthly_salary) : emp.monthly_salary) : null,
       petrol_monthly != null ? Number(petrol_monthly) : emp.petrol_monthly,
       bank_ac_no !== undefined ? ((bank_ac_no || '').trim() || null) : emp.bank_ac_no,
       ifsc_code !== undefined ? ((ifsc_code || '').trim() || null) : emp.ifsc_code,
       ac_holder_name !== undefined ? ((ac_holder_name || '').trim() || null) : emp.ac_holder_name,
       joined_on !== undefined ? (joined_on || null) : emp.joined_on,
       notes !== undefined ? ((notes || '').trim() || null) : emp.notes,
       active !== undefined ? !!active : emp.active, id]);
    res.json({ message: 'Employee updated' });
  } catch (e) {
    console.error('employee update error:', e);
    res.status(500).json({ error: 'Failed to update employee' });
  }
});

// Leave ledger (owner) — balance + history, plus manual adjustment
router.get('/employees/:id/leave', authenticate, authorize('owner'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid employee id' });
    const db = getDB();
    const entries = await db.all(
      `SELECT l.*, u.name AS created_by_name FROM employee_leave_ledger l
       LEFT JOIN users u ON u.id = l.created_by
       WHERE l.employee_id=$1 ORDER BY l.id DESC`, [id]);
    res.json({ balance: await leaveBalance(db, id), entries });
  } catch (e) {
    console.error('leave ledger error:', e);
    res.status(500).json({ error: 'Failed to load leave ledger' });
  }
});

router.post('/employees/:id/leave', authenticate, authorize('owner'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid employee id' });
    const delta = Number(req.body.delta);
    if (!delta || Number.isNaN(delta)) return res.status(400).json({ error: 'Enter a non-zero adjustment' });
    const db = getDB();
    const emp = await db.get('SELECT id FROM employees WHERE id=$1', [id]);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    await db.insert(
      `INSERT INTO employee_leave_ledger (employee_id, delta, reason, notes, created_by)
       VALUES ($1,$2,'manual',$3,$4)`,
      [id, delta, (req.body.notes || '').trim() || null, req.user.id]);
    res.status(201).json({ balance: await leaveBalance(db, id) });
  } catch (e) {
    console.error('leave adjust error:', e);
    res.status(500).json({ error: 'Failed to adjust leave' });
  }
});

// ── Advances (owner) ──────────────────────────────────────────────────────────
router.get('/employees/:id/advances', authenticate, authorize('owner'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid employee id' });
    const rows = await getDB().all(
      'SELECT * FROM employee_advances WHERE employee_id=$1 ORDER BY id DESC', [id]);
    res.json(rows);
  } catch (e) {
    console.error('advances list error:', e);
    res.status(500).json({ error: 'Failed to load advances' });
  }
});

router.post('/employees/:id/advances', authenticate, authorize('owner'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid employee id' });
    const amount = Number(req.body.amount);
    if (!(amount > 0)) return res.status(400).json({ error: 'Enter a valid amount' });
    if (!req.body.advance_date) return res.status(400).json({ error: 'Date is required' });
    const db = getDB();
    const emp = await db.get('SELECT id FROM employees WHERE id=$1', [id]);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    await db.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO employee_advances (employee_id, amount, advance_date, notes, created_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, amount, req.body.advance_date, (req.body.notes || '').trim() || null, req.user.id]);
      await client.query('UPDATE employees SET advance_balance = advance_balance + $1 WHERE id=$2', [amount, id]);
    });
    res.status(201).json({ message: 'Advance recorded' });
  } catch (e) {
    console.error('advance create error:', e);
    res.status(500).json({ error: 'Failed to record advance' });
  }
});

// ── Payroll runs ──────────────────────────────────────────────────────────────
router.get('/runs', authenticate, authorize('owner', 'accounts'), async (req, res) => {
  try {
    const rows = await getDB().all(`
      SELECT r.*, p.name AS prepared_by_name, a.name AS approved_by_name,
        (SELECT COUNT(*) FROM payroll_lines pl WHERE pl.run_id = r.id) AS line_count,
        ${isOwner(req) ? '(SELECT COALESCE(SUM(total_payable),0) FROM payroll_lines pl WHERE pl.run_id = r.id)' : 'NULL'} AS total_payable
      FROM payroll_runs r
      LEFT JOIN users p ON p.id = r.prepared_by
      LEFT JOIN users a ON a.id = r.approved_by
      ORDER BY r.month DESC`);
    res.json(rows);
  } catch (e) {
    console.error('runs list error:', e);
    res.status(500).json({ error: 'Failed to load payroll runs' });
  }
});

// Create a month's run (accounts or owner). Seeds a line per active employee.
// The ESSL PDF is attached for record; attendance is entered/edited in the grid
// (PDF auto-parse arrives once the owner shares a sample report format).
router.post('/runs', authenticate, authorize('owner', 'accounts'), ...uploadEsslReport, async (req, res) => {
  const discardFile = () => { if (req.file?.storagePath) deleteFromStorage(req.file.storagePath).catch(() => {}); };
  try {
    const month = String(req.body.month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) { discardFile(); return res.status(400).json({ error: 'Month (YYYY-MM) is required' }); }
    const workingDays = parseInt(req.body.working_days, 10) || 30;
    const db = getDB();
    const dupe = await db.get('SELECT id FROM payroll_runs WHERE month=$1', [month]);
    if (dupe) { discardFile(); return res.status(409).json({ error: `A payroll run for ${month} already exists` }); }

    const employees = await db.all('SELECT * FROM employees WHERE active = TRUE ORDER BY id');
    if (!employees.length) { discardFile(); return res.status(400).json({ error: 'Add employees first' }); }

    // Parse the ESSL PDF up front (best-effort) so the grid arrives pre-filled
    let parseResult = null;
    if (req.file?.buffer) {
      try { parseResult = await esslToAttendance(req.file.buffer, employees, workingDays); }
      catch (pe) { console.error('ESSL parse (non-fatal):', pe.message); }
    }

    const runId = await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO payroll_runs (month, working_days, essl_file, essl_original_name, prepared_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [month, workingDays, req.file?.storagePath || null, req.file?.originalname || null, req.user.id]);
      for (const emp of employees) {
        // Labour never receives petrol — only fixed staff do
        const petrol = emp.worker_group === 'labour' ? 0 : (emp.petrol_monthly || 0);
        await client.query(
          `INSERT INTO payroll_lines (run_id, employee_id, worker_group, daily_rate, monthly_salary, petrol, advance_deduction)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [rows[0].id, emp.id, emp.worker_group,
           emp.worker_group === 'labour' ? emp.daily_rate : r2(Number(emp.monthly_salary || 0) / MONTH_BASIS_DAYS),
           FIXED_GROUPS.includes(emp.worker_group) ? emp.monthly_salary : null,
           petrol, emp.advance_balance || 0]);
      }
      if (parseResult?.updates?.length) await applyAttendanceUpdates(client, rows[0].id, parseResult.updates);
      return rows[0].id;
    });
    await logActivity(null, null, 'payroll_run_created', `Payroll run created for ${month}`, req.user.id);
    res.status(201).json({
      id: runId,
      essl: parseResult ? { applied: parseResult.applied, unmatched: parseResult.unmatched, period: parseResult.period } : null,
    });
  } catch (e) {
    console.error('run create error:', e);
    discardFile();
    // Concurrent duplicate-month create surfaces the UNIQUE(month) violation
    if (e.code === '23505') return res.status(409).json({ error: `A payroll run for this month already exists` });
    res.status(500).json({ error: 'Failed to create payroll run' });
  }
});

// Re-parse an ESSL report onto an existing draft/submitted run (owner/accounts).
// Accepts a fresh upload, else re-reads the run's stored PDF. Overwrites the
// parsed attendance fields; owner review fields (credits/petrol/advance) untouched.
router.put('/runs/:id/parse-essl', authenticate, authorize('owner', 'accounts'), ...uploadEsslReport, async (req, res) => {
  const discardFile = () => { if (req.file?.storagePath) deleteFromStorage(req.file.storagePath).catch(() => {}); };
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) { discardFile(); return res.status(400).json({ error: 'Invalid run id' }); }
    const db = getDB();
    const run = await db.get('SELECT * FROM payroll_runs WHERE id=$1', [id]);
    if (!run) { discardFile(); return res.status(404).json({ error: 'Run not found' }); }
    if (!['draft', 'submitted'].includes(run.status)) { discardFile(); return res.status(400).json({ error: 'Run is locked after approval' }); }

    let buffer = req.file?.buffer;
    if (!buffer) {
      if (!run.essl_file) return res.status(400).json({ error: 'No ESSL report on this run — attach one' });
      buffer = await downloadFromStorage(run.essl_file);
    }
    const employees = await db.all(
      'SELECT * FROM employees WHERE id IN (SELECT employee_id FROM payroll_lines WHERE run_id=$1)', [id]);
    const result = await esslToAttendance(buffer, employees, run.working_days);
    await db.withTransaction(async (client) => {
      if (req.file?.storagePath) {
        const old = run.essl_file;
        await client.query('UPDATE payroll_runs SET essl_file=$1, essl_original_name=$2 WHERE id=$3',
          [req.file.storagePath, req.file.originalname, id]);
        if (old && old !== req.file.storagePath) deleteFromStorage(old).catch(() => {});
      }
      await applyAttendanceUpdates(client, id, result.updates);
    });
    res.json({ message: 'ESSL applied', applied: result.applied, unmatched: result.unmatched, period: result.period });
  } catch (e) {
    console.error('essl parse error:', e);
    discardFile();
    res.status(500).json({ error: 'Failed to parse ESSL report' });
  }
});

router.get('/runs/:id', authenticate, authorize('owner', 'accounts'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid run id' });
    const db = getDB();
    const run = await db.get('SELECT * FROM payroll_runs WHERE id=$1', [id]);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const owner = isOwner(req);
    const lines = await db.all(`
      SELECT pl.*, e.name, e.active, e.petrol_monthly, e.advance_balance,
             e.bank_ac_no, e.ifsc_code, e.ac_holder_name
      FROM payroll_lines pl JOIN employees e ON e.id = pl.employee_id
      WHERE pl.run_id=$1
      ORDER BY CASE pl.worker_group WHEN 'labour' THEN 0 ELSE 1 END, e.name`, [id]);

    let leaveBalances = null;
    if (owner) {
      const bals = await db.all(
        `SELECT employee_id, COALESCE(SUM(delta),0) AS bal FROM employee_leave_ledger
         WHERE employee_id IN (SELECT employee_id FROM payroll_lines WHERE run_id=$1)
         GROUP BY employee_id`, [id]);
      leaveBalances = Object.fromEntries(bals.map(b => [b.employee_id, Number(b.bal)]));
    }
    res.json({
      run,
      lines: lines.map(l => visibleLine(l, owner)),
      leave_balances: leaveBalances,
      policy: { month_basis_days: MONTH_BASIS_DAYS, ot_divisor: OT_DIVISOR, max_carryforward: MAX_CARRYFORWARD, max_together: MAX_TOGETHER },
    });
  } catch (e) {
    console.error('run get error:', e);
    res.status(500).json({ error: 'Failed to load run' });
  }
});

// Attendance entry (accounts + owner) while draft/submitted:
// present/absent/OT hours/6:30-stays/remarks per line. Recomputes pay fields.
router.put('/runs/:id/attendance', authenticate, authorize('owner', 'accounts'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid run id' });
    const db = getDB();
    const run = await db.get('SELECT * FROM payroll_runs WHERE id=$1', [id]);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (!['draft', 'submitted'].includes(run.status)) {
      return res.status(400).json({ error: 'Attendance is locked after approval' });
    }
    const updates = Array.isArray(req.body.lines) ? req.body.lines : [];
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    await db.withTransaction(async (client) => {
      for (const u of updates) {
        const lineId = parseInt(u.id, 10);
        if (!Number.isInteger(lineId)) continue;
        const { rows } = await client.query(
          `SELECT pl.*, e.worker_group AS eg, e.daily_rate AS e_rate, e.monthly_salary AS e_salary,
                  e.petrol_monthly AS e_petrol
           FROM payroll_lines pl JOIN employees e ON e.id = pl.employee_id
           WHERE pl.id=$1 AND pl.run_id=$2`, [lineId, id]);
        const line = rows[0];
        if (!line) continue;
        const newAbsent = Math.max(u.absent_days != null ? Number(u.absent_days) : Number(line.absent_days), 0);
        // Re-clamp any credit already chosen so it never exceeds the new absent
        // count — otherwise reducing absences leaves stale credit that would
        // over-debit the leave ledger at approval.
        const clampedCredit = Math.min(Number(line.leave_credit_used || 0), newAbsent);
        const merged = {
          ...line,
          present_days: u.present_days != null ? Math.max(Number(u.present_days), 0) : line.present_days,
          absent_days: newAbsent,
          ot_hours: u.ot_hours != null ? Math.max(Number(u.ot_hours), 0) : line.ot_hours,
          late_stay_days: u.late_stay_days != null ? Math.max(parseInt(u.late_stay_days, 10) || 0, 0) : line.late_stay_days,
          leave_credit_used: clampedCredit,
        };
        const emp = { worker_group: line.worker_group, daily_rate: line.eg === 'labour' ? line.e_rate : null,
                      monthly_salary: line.e_salary, petrol_monthly: line.e_petrol };
        const pay = computeLine(emp, merged);
        await client.query(
          `UPDATE payroll_lines SET present_days=$1, absent_days=$2, ot_hours=$3, late_stay_days=$4,
             leave_credit_used=$5, remarks=$6, long_leave_flag=$7,
             base_pay=$8, ot_amount=$9, absent_deduction=$10, total_payable=$11
           WHERE id=$12`,
          [merged.present_days, merged.absent_days, merged.ot_hours, merged.late_stay_days, clampedCredit,
           u.remarks !== undefined ? ((u.remarks || '').trim() || null) : line.remarks,
           Number(merged.absent_days) > MAX_TOGETHER,
           pay.base_pay, pay.ot_amount, pay.absent_deduction, pay.total_payable, lineId]);
      }
    });
    res.json({ message: 'Attendance saved' });
  } catch (e) {
    console.error('attendance save error:', e);
    res.status(500).json({ error: 'Failed to save attendance' });
  }
});

// Accounts submits the prepared attendance to the owner
router.put('/runs/:id/submit', authenticate, authorize('owner', 'accounts'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid run id' });
    const db = getDB();
    const run = await db.get('SELECT * FROM payroll_runs WHERE id=$1', [id]);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.status !== 'draft') return res.status(400).json({ error: 'Run is not in draft' });
    await db.run("UPDATE payroll_runs SET status='submitted', submitted_at=NOW() WHERE id=$1", [id]);
    await logActivity(null, null, 'payroll_submitted', `Payroll ${run.month} attendance submitted for owner review`, req.user.id);
    res.json({ message: 'Submitted for owner review' });
  } catch (e) {
    console.error('run submit error:', e);
    res.status(500).json({ error: 'Failed to submit run' });
  }
});

// Owner review: decide leave credits used, sick credits earned, petrol and
// advance deduction per line. Server clamps credits to balance and absences.
router.put('/runs/:id/review', authenticate, authorize('owner'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid run id' });
    const db = getDB();
    const run = await db.get('SELECT * FROM payroll_runs WHERE id=$1', [id]);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (!['draft', 'submitted'].includes(run.status)) {
      return res.status(400).json({ error: 'Run is locked after approval' });
    }
    const updates = Array.isArray(req.body.lines) ? req.body.lines : [];
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    const errors = [];
    await db.withTransaction(async (client) => {
      for (const u of updates) {
        const lineId = parseInt(u.id, 10);
        if (!Number.isInteger(lineId)) continue;
        const { rows } = await client.query(
          `SELECT pl.*, e.worker_group AS eg, e.daily_rate AS e_rate, e.monthly_salary AS e_salary,
                  e.petrol_monthly AS e_petrol, e.advance_balance, e.name
           FROM payroll_lines pl JOIN employees e ON e.id = pl.employee_id
           WHERE pl.id=$1 AND pl.run_id=$2`, [lineId, id]);
        const line = rows[0];
        if (!line) continue;

        let creditUsed = u.leave_credit_used != null ? Number(u.leave_credit_used) : Number(line.leave_credit_used);
        if (FIXED_GROUPS.includes(line.worker_group)) {
          const { rows: balRows } = await client.query(
            'SELECT COALESCE(SUM(delta),0) AS bal FROM employee_leave_ledger WHERE employee_id=$1', [line.employee_id]);
          const bal = Number(balRows[0].bal);
          if (creditUsed > bal) { errors.push(`${line.name}: only ${bal} leave credit available`); creditUsed = bal; }
          if (creditUsed > Number(line.absent_days)) creditUsed = Number(line.absent_days);
          // No more than 7 paid leaves may be taken together — excess is unpaid
          if (creditUsed > MAX_TOGETHER) { errors.push(`${line.name}: paid leave capped at ${MAX_TOGETHER} (max together)`); creditUsed = MAX_TOGETHER; }
          if (creditUsed < 0) creditUsed = 0;
        } else {
          creditUsed = 0; // labour has no paid leave
        }

        let advance = u.advance_deduction != null ? Number(u.advance_deduction) : Number(line.advance_deduction);
        if (advance < 0) advance = 0;
        if (advance > Number(line.advance_balance)) {
          errors.push(`${line.name}: advance deduction capped at balance ₹${line.advance_balance}`);
          advance = Number(line.advance_balance);
        }

        const sickEarned = line.worker_group === 'fixed_admin'
          ? Math.max(u.sick_credit_earned != null ? Number(u.sick_credit_earned) : Number(line.sick_credit_earned), 0)
          : 0;

        const merged = { ...line, leave_credit_used: creditUsed, advance_deduction: advance,
          petrol: u.petrol != null ? Number(u.petrol) : Number(line.petrol) };
        const emp = { worker_group: line.worker_group, daily_rate: line.eg === 'labour' ? line.e_rate : null,
                      monthly_salary: line.e_salary, petrol_monthly: merged.petrol };
        const pay = computeLine(emp, merged);
        await client.query(
          `UPDATE payroll_lines SET leave_credit_used=$1, sick_credit_earned=$2, petrol=$3, advance_deduction=$4,
             remarks=$5, base_pay=$6, ot_amount=$7, absent_deduction=$8, total_payable=$9
           WHERE id=$10`,
          [creditUsed, sickEarned, merged.petrol, advance,
           u.remarks !== undefined ? ((u.remarks || '').trim() || null) : line.remarks,
           pay.base_pay, pay.ot_amount, pay.absent_deduction, pay.total_payable, lineId]);
      }
    });
    res.json({ message: 'Review saved', warnings: errors });
  } catch (e) {
    console.error('run review error:', e);
    res.status(500).json({ error: 'Failed to save review' });
  }
});

// Owner approves: locks the month, posts the leave ledger (+1 monthly accrual
// for fixed groups, +sick credits, −credits used), settles advances, trims
// year-start carryforward to the 5-leave cap.
router.put('/runs/:id/approve', authenticate, authorize('owner'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid run id' });
    const db = getDB();
    const pre = await db.get('SELECT id, status, month FROM payroll_runs WHERE id=$1', [id]);
    if (!pre) return res.status(404).json({ error: 'Run not found' });
    if (!['draft', 'submitted'].includes(pre.status)) {
      return res.status(400).json({ error: 'Run is already approved' });
    }

    let total = 0, lineCount = 0;
    const outcome = await db.withTransaction(async (client) => {
      // Lock the run row and re-check status inside the txn so two concurrent
      // approvals can't both post the ledger / settle advances.
      const { rows: runRows } = await client.query('SELECT * FROM payroll_runs WHERE id=$1 FOR UPDATE', [id]);
      const run = runRows[0];
      if (!run || !['draft', 'submitted'].includes(run.status)) return { already: true };
      const isJanuary = run.month.endsWith('-01');
      const lines = (await client.query(
        `SELECT pl.*, e.name, e.daily_rate AS e_rate, e.monthly_salary AS e_salary, e.petrol_monthly AS e_petrol,
                e.advance_balance
         FROM payroll_lines pl JOIN employees e ON e.id = pl.employee_id WHERE pl.run_id=$1`, [id])).rows;

      for (const line of lines) {
        const emp = { worker_group: line.worker_group, daily_rate: line.worker_group === 'labour' ? line.e_rate : null,
                      monthly_salary: line.e_salary, petrol_monthly: line.petrol };
        let creditUsed = Number(line.leave_credit_used || 0);

        if (FIXED_GROUPS.includes(line.worker_group)) {
          // Year start: trim carryforward above the cap BEFORE this month's postings
          if (isJanuary) {
            const { rows: b } = await client.query(
              'SELECT COALESCE(SUM(delta),0) AS bal FROM employee_leave_ledger WHERE employee_id=$1', [line.employee_id]);
            const bal = Number(b[0].bal);
            if (bal > MAX_CARRYFORWARD) {
              await client.query(
                `INSERT INTO employee_leave_ledger (employee_id, delta, reason, payroll_run_id, notes, created_by)
                 VALUES ($1,$2,'year_trim',$3,$4,$5)`,
                [line.employee_id, MAX_CARRYFORWARD - bal, id,
                 `Carryforward trimmed to ${MAX_CARRYFORWARD} at year start`, req.user.id]);
            }
          }
          // Re-clamp credit against the LIVE (post-trim) balance, absences and the
          // max-together cap, then re-price the line if it changed — the review
          // clamp may be stale (attendance edited, or the January trim just ran).
          const { rows: b2 } = await client.query(
            'SELECT COALESCE(SUM(delta),0) AS bal FROM employee_leave_ledger WHERE employee_id=$1', [line.employee_id]);
          const liveBal = Number(b2[0].bal);
          creditUsed = Math.max(0, Math.min(creditUsed, liveBal, Number(line.absent_days), MAX_TOGETHER));
        } else {
          creditUsed = 0;
        }

        // Re-cap the advance deduction against the LIVE balance (a prior month's
        // run may have settled part of it since this line was seeded/reviewed).
        const liveAdvBal = Number(line.advance_balance || 0);
        const deduction = Math.max(0, Math.min(Number(line.advance_deduction || 0), liveAdvBal));

        // Recompute pay with the final clamped values and freeze it on the line
        const pay = computeLine(emp, { ...line, leave_credit_used: creditUsed, advance_deduction: deduction, petrol: line.petrol });
        await client.query(
          `UPDATE payroll_lines SET leave_credit_used=$1, advance_deduction=$2,
             base_pay=$3, ot_amount=$4, absent_deduction=$5, total_payable=$6 WHERE id=$7`,
          [creditUsed, deduction, pay.base_pay, pay.ot_amount, pay.absent_deduction, pay.total_payable, line.id]);
        total += Number(pay.total_payable);
        lineCount += 1;

        if (FIXED_GROUPS.includes(line.worker_group)) {
          if (creditUsed > 0) {
            await client.query(
              `INSERT INTO employee_leave_ledger (employee_id, delta, reason, payroll_run_id, notes, created_by)
               VALUES ($1,$2,'used',$3,$4,$5)`,
              [line.employee_id, -creditUsed, id, `Used in ${run.month}`, req.user.id]);
          }
          await client.query(
            `INSERT INTO employee_leave_ledger (employee_id, delta, reason, payroll_run_id, notes, created_by)
             VALUES ($1,1,'monthly_accrual',$2,$3,$4)`,
            [line.employee_id, id, `Monthly paid leave for ${run.month}`, req.user.id]);
          if (line.worker_group === 'fixed_admin' && Number(line.sick_credit_earned) > 0) {
            await client.query(
              `INSERT INTO employee_leave_ledger (employee_id, delta, reason, payroll_run_id, notes, created_by)
               VALUES ($1,$2,'sick_630',$3,$4,$5)`,
              [line.employee_id, Number(line.sick_credit_earned), id,
               `6:30 late-stay sick credit for ${run.month}`, req.user.id]);
          }
        }

        // Settle advances oldest-first, up to the deducted amount only
        if (deduction > 0) {
          await client.query('UPDATE employees SET advance_balance = GREATEST(advance_balance - $1, 0) WHERE id=$2',
            [deduction, line.employee_id]);
          let remaining = deduction;
          const { rows: adv } = await client.query(
            'SELECT id, amount FROM employee_advances WHERE employee_id=$1 AND settled=FALSE ORDER BY advance_date, id', [line.employee_id]);
          for (const a of adv) {
            if (remaining <= 0.0001) break;
            if (Number(a.amount) <= remaining + 0.0001) {
              await client.query('UPDATE employee_advances SET settled=TRUE, payroll_run_id=$1 WHERE id=$2', [id, a.id]);
              remaining = r2(remaining - Number(a.amount));
            }
            // partial coverage of an advance leaves it unsettled (balance still tracks the remainder)
          }
        }
      }
      await client.query(
        `UPDATE payroll_runs SET status='approved', approved_by=$1, approved_at=NOW() WHERE id=$2`,
        [req.user.id, id]);
      return { already: false };
    });
    if (outcome.already) return res.status(400).json({ error: 'Run is already approved' });
    await logActivity(null, null, 'payroll_approved',
      `Payroll ${pre.month} approved — ${lineCount} workers, ₹${r2(total)}`, req.user.id);
    res.json({ message: 'Payroll approved' });
  } catch (e) {
    console.error('run approve error:', e);
    res.status(500).json({ error: 'Failed to approve run' });
  }
});

// Add a worker to an existing draft/submitted run (owner) — for someone hired
// or reactivated after the run was created. Seeds one line; UNIQUE(run_id,
// employee_id) guards against duplicates.
router.post('/runs/:id/add-employee', authenticate, authorize('owner'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const empId = parseInt(req.body.employee_id, 10);
    if (!Number.isInteger(id) || !Number.isInteger(empId)) return res.status(400).json({ error: 'Invalid id' });
    const db = getDB();
    const run = await db.get('SELECT * FROM payroll_runs WHERE id=$1', [id]);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (!['draft', 'submitted'].includes(run.status)) return res.status(400).json({ error: 'Run is locked after approval' });
    const emp = await db.get('SELECT * FROM employees WHERE id=$1', [empId]);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const dupe = await db.get('SELECT id FROM payroll_lines WHERE run_id=$1 AND employee_id=$2', [id, empId]);
    if (dupe) return res.status(409).json({ error: 'Worker already in this run' });
    const petrol = emp.worker_group === 'labour' ? 0 : (emp.petrol_monthly || 0);
    await db.run(
      `INSERT INTO payroll_lines (run_id, employee_id, worker_group, daily_rate, monthly_salary, petrol, advance_deduction)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, empId, emp.worker_group,
       emp.worker_group === 'labour' ? emp.daily_rate : r2(Number(emp.monthly_salary || 0) / MONTH_BASIS_DAYS),
       FIXED_GROUPS.includes(emp.worker_group) ? emp.monthly_salary : null, petrol, emp.advance_balance || 0]);
    res.status(201).json({ message: 'Worker added to run' });
  } catch (e) {
    console.error('add-employee error:', e);
    res.status(500).json({ error: 'Failed to add worker to run' });
  }
});

// Delete a draft/submitted run (owner) — before approval, e.g. to recreate it
// with a corrected ESSL or roster. Lines cascade. Approved/paid runs are kept.
router.delete('/runs/:id', authenticate, authorize('owner'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid run id' });
    const db = getDB();
    const run = await db.get('SELECT * FROM payroll_runs WHERE id=$1', [id]);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (!['draft', 'submitted'].includes(run.status)) {
      return res.status(400).json({ error: 'Approved payroll cannot be deleted' });
    }
    await db.run('DELETE FROM payroll_runs WHERE id=$1', [id]);
    if (run.essl_file) deleteFromStorage(run.essl_file).catch(() => {});
    await logActivity(null, null, 'payroll_run_deleted', `Draft payroll run ${run.month} deleted`, req.user.id);
    res.json({ message: 'Run deleted' });
  } catch (e) {
    console.error('run delete error:', e);
    res.status(500).json({ error: 'Failed to delete run' });
  }
});

// Owner marks the whole month paid (salary day = 7th) or individual lines
router.put('/runs/:id/mark-paid', authenticate, authorize('owner'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid run id' });
    const db = getDB();
    const run = await db.get('SELECT * FROM payroll_runs WHERE id=$1', [id]);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.status === 'draft' || run.status === 'submitted') {
      return res.status(400).json({ error: 'Approve the run first' });
    }
    if (Array.isArray(req.body.line_ids) && req.body.line_ids.length) {
      const ids = req.body.line_ids.map(n => parseInt(n, 10)).filter(Number.isInteger);
      await db.run(`UPDATE payroll_lines SET paid=TRUE WHERE run_id=$1 AND id = ANY($2)`, [id, ids]);
    } else {
      await db.run('UPDATE payroll_lines SET paid=TRUE WHERE run_id=$1', [id]);
    }
    const remaining = await db.get(
      'SELECT COUNT(*)::int AS n FROM payroll_lines WHERE run_id=$1 AND paid=FALSE', [id]);
    if (remaining.n === 0 && run.status !== 'paid') {
      await db.run("UPDATE payroll_runs SET status='paid', paid_at=NOW() WHERE id=$1", [id]);
      await logActivity(null, null, 'payroll_paid', `Payroll ${run.month} fully paid`, req.user.id);
    }
    res.json({ message: 'Marked paid', all_paid: remaining.n === 0 });
  } catch (e) {
    console.error('mark paid error:', e);
    res.status(500).json({ error: 'Failed to mark paid' });
  }
});

module.exports = router;
