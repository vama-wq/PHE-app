import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import Modal from '../../components/ui/Modal';
import { fmtDate } from '../../lib/utils';
import { Banknote, Plus, Users, CalendarDays, Upload, Pencil, Wallet, CalendarClock, Trash2 } from 'lucide-react';

const inr = (n) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const GROUP_LABELS = {
  labour: 'Per-Day Labour',
  fixed_admin: 'Fixed — Admin (8h)',
  fixed_production: 'Fixed — Production (10h)',
  fixed_production_nl: 'Fixed — Production (10h, no leave)',
};
const STATUS_BADGES = {
  draft:     'bg-gray-100 text-gray-600',
  submitted: 'bg-blue-100 text-blue-700',
  approved:  'bg-green-100 text-green-700',
  paid:      'bg-emerald-100 text-emerald-800',
};

export default function PayrollList() {
  const { user } = useAuthStore();
  const isOwner = user.role === 'owner' || user.role === 'accounts'; // accounts has full payroll access (owner decision, Sep 2026)
  const [tab, setTab] = useState('runs');
  const [runs, setRuns] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [showNewRun, setShowNewRun] = useState(false);
  const [editEmp, setEditEmp] = useState(null); // null | 'new' | employee obj
  const [advanceEmp, setAdvanceEmp] = useState(null);
  const [leaveEmp, setLeaveEmp] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    Promise.all([
      api.get('/payroll/runs').then(r => setRuns(r.data || [])),
      api.get('/payroll/employees').then(r => setEmployees(r.data || [])),
    ]).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const handleDeleteEmp = async (e) => {
    if (!window.confirm(`Delete ${e.name}? This is only allowed if they have no payroll history — otherwise deactivate them via Edit.`)) return;
    try { await api.delete(`/payroll/employees/${e.id}`); load(); }
    catch (err) { alert(err.response?.data?.error || 'Failed'); }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Banknote size={24} className="text-emerald-600" /> Payroll
          </h1>
          <p className="text-gray-500 text-sm mt-0.5">
            Monthly salary from the ESSL attendance report — salary day is the 7th
          </p>
        </div>
        <div className="flex items-center gap-2">
          {tab === 'employees' && (
            <button className="btn-primary flex items-center gap-1.5" onClick={() => setEditEmp('new')}>
              <Plus size={16} /> Add Worker
            </button>
          )}
          {tab === 'runs' && (
            <button className="btn-primary flex items-center gap-1.5" onClick={() => setShowNewRun(true)}>
              <Plus size={16} /> New Month Run
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 bg-gray-100 rounded-xl p-1 w-fit">
        <button className={`px-4 py-1.5 rounded-lg text-sm font-medium ${tab === 'runs' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500'}`}
          onClick={() => setTab('runs')}>
          <CalendarDays size={14} className="inline mr-1" /> Salary Runs
        </button>
        <button className={`px-4 py-1.5 rounded-lg text-sm font-medium ${tab === 'employees' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500'}`}
          onClick={() => setTab('employees')}>
          <Users size={14} className="inline mr-1" /> Workers ({employees.length})
        </button>
        <button className={`px-4 py-1.5 rounded-lg text-sm font-medium ${tab === 'holidays' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500'}`}
          onClick={() => setTab('holidays')}>
          <CalendarDays size={14} className="inline mr-1" /> Holidays
        </button>
      </div>

      {tab === 'runs' ? (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="table-header text-left">Month</th>
                <th className="table-header text-left">Status</th>
                <th className="table-header text-right">Workers</th>
                {isOwner && <th className="table-header text-right">Total Payable</th>}
                <th className="table-header text-left">Prepared By</th>
                <th className="table-header text-left">Approved</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={6} className="table-cell text-center text-gray-400 py-10">Loading…</td></tr>
              ) : runs.length === 0 ? (
                <tr><td colSpan={6} className="table-cell text-center text-gray-400 py-10">
                  No salary runs yet — create the month's run and enter attendance from the ESSL report
                </td></tr>
              ) : runs.map(r => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="table-cell">
                    <Link to={`/payroll/runs/${r.id}`} className="font-semibold text-brand-600 hover:underline">{r.month}</Link>
                  </td>
                  <td className="table-cell">
                    <span className={`text-[10px] font-bold rounded-full px-2 py-0.5 uppercase ${STATUS_BADGES[r.status]}`}>{r.status}</span>
                  </td>
                  <td className="table-cell text-right text-sm">{r.line_count}</td>
                  {isOwner && <td className="table-cell text-right text-sm font-semibold">{r.total_payable != null ? inr(r.total_payable) : '—'}</td>}
                  <td className="table-cell text-sm text-gray-500">{r.prepared_by_name || '—'}</td>
                  <td className="table-cell text-sm text-gray-500">{r.approved_at ? `${r.approved_by_name || ''} · ${fmtDate(r.approved_at)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : tab === 'holidays' ? (
        <HolidaysTab isOwner={isOwner} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="table-header text-left">Name</th>
                <th className="table-header text-left">Type</th>
                <th className="table-header text-right">Rate / Salary</th>
                <th className="table-header text-right">Petrol</th>
                {isOwner && <th className="table-header text-right">Advance Bal.</th>}
                {isOwner && <th className="table-header text-right">Leave Bal.</th>}
                <th className="table-header text-left">Bank AC</th>
                <th className="table-header text-center">Status</th>
                <th className="table-header text-center"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {employees.length === 0 ? (
                <tr><td colSpan={isOwner ? 9 : 7} className="table-cell text-center text-gray-400 py-10">
                  No workers added yet — add your workers to get started
                </td></tr>
              ) : employees.map(e => (
                <tr key={e.id} className={`hover:bg-gray-50 ${!e.active ? 'opacity-50' : ''}`}>
                  <td className="table-cell text-sm font-medium text-gray-800">{e.name}</td>
                  <td className="table-cell text-xs text-gray-500">{GROUP_LABELS[e.worker_group]}</td>
                  <td className="table-cell text-right text-sm">
                    {e.worker_group === 'labour' ? `${inr(e.daily_rate || 0)}/day` : `${inr(e.monthly_salary || 0)}/mo`}
                  </td>
                  <td className="table-cell text-right text-sm">{Number(e.petrol_monthly) > 0 ? inr(e.petrol_monthly) : '—'}</td>
                  {isOwner && (
                    <td className="table-cell text-right text-sm">
                      {Number(e.advance_balance) > 0 ? <span className="text-amber-700 font-semibold">{inr(e.advance_balance)}</span> : '—'}
                    </td>
                  )}
                  {isOwner && (
                    <td className="table-cell text-right text-sm">
                      {e.worker_group === 'labour' ? '—' : <span className="font-semibold">{Number(e.leave_balance || 0)}</span>}
                    </td>
                  )}
                  <td className="table-cell text-xs text-gray-500">{e.bank_ac_no || '—'}</td>
                  <td className="table-cell text-center">
                    <span className={`text-[10px] font-bold rounded-full px-2 py-0.5 ${e.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {e.active ? 'ACTIVE' : 'INACTIVE'}
                    </span>
                  </td>
                  <td className="table-cell text-center whitespace-nowrap">
                    {isOwner && e.worker_group !== 'labour' && (
                      <button className="p-1 text-gray-400 hover:text-emerald-600" title="Adjust leave balance" onClick={() => setLeaveEmp(e)}>
                        <CalendarDays size={14} />
                      </button>
                    )}
                    {isOwner && (
                      <button className="p-1 text-gray-400 hover:text-brand-600" title="Record advance" onClick={() => setAdvanceEmp(e)}>
                        <Wallet size={14} />
                      </button>
                    )}
                    <button className="p-1 text-gray-400 hover:text-brand-600" title="Edit worker" onClick={() => setEditEmp(e)}>
                      <Pencil size={14} />
                    </button>
                    {isOwner && (
                      <button className="p-1 text-gray-300 hover:text-red-600" title="Delete worker (only if no payroll history)" onClick={() => handleDeleteEmp(e)}>
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNewRun && <NewRunModal onClose={() => setShowNewRun(false)} onDone={() => { setShowNewRun(false); load(); }} />}
      {editEmp && <EmployeeModal employee={editEmp === 'new' ? null : editEmp} onClose={() => setEditEmp(null)} onDone={() => { setEditEmp(null); load(); }} />}
      {advanceEmp && <AdvanceModal employee={advanceEmp} onClose={() => setAdvanceEmp(null)} onDone={() => { setAdvanceEmp(null); load(); }} />}
      {leaveEmp && <LeaveModal employee={leaveEmp} onClose={() => setLeaveEmp(null)} onDone={() => { setLeaveEmp(null); load(); }} />}
    </div>
  );
}

function HolidaysTab({ isOwner }) {
  const now = new Date();
  const [year, setYear] = useState(String(now.getFullYear()));
  const [holidays, setHolidays] = useState([]);
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.get(`/payroll/holidays?year=${year}`).then(r => setHolidays(r.data || [])).catch(() => {});
  useEffect(() => { load(); }, [year]);

  const add = async (e) => {
    e.preventDefault();
    if (!date) return setError('Pick a date.');
    if (!name.trim()) return setError('Enter the holiday name.');
    setSaving(true); setError('');
    try { await api.post('/payroll/holidays', { holiday_date: date, name: name.trim() }); setDate(''); setName(''); load(); }
    catch (err) { setError(err.response?.data?.error || 'Failed'); }
    finally { setSaving(false); }
  };
  const remove = async (h) => {
    if (!window.confirm(`Remove ${h.name} (${fmtDate(h.holiday_date)})?`)) return;
    try { await api.delete(`/payroll/holidays/${h.id}`); load(); }
    catch (err) { alert(err.response?.data?.error || 'Failed'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-sm text-gray-500">
          Paid festival holidays for the year. Any that fall in a payroll month are paid to every worker —
          per-day labour gets that day's rate, fixed-salary workers aren't deducted for it.
        </p>
        <select className="input w-28" value={year} onChange={e => setYear(e.target.value)}>
          {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      {isOwner && (
        <form onSubmit={add} className="card p-4 flex items-end gap-3 flex-wrap">
          <div>
            <label className="label">Date <span className="text-red-500">*</span></label>
            <input className="input" type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div className="flex-1 min-w-[200px]">
            <label className="label">Holiday Name <span className="text-red-500">*</span></label>
            <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Diwali, Uttarayan" />
          </div>
          <button type="submit" className="btn-primary flex items-center gap-1.5" disabled={saving}>
            <Plus size={16} /> {saving ? 'Adding…' : 'Add Holiday'}
          </button>
          {error && <p className="text-red-600 text-sm w-full">{error}</p>}
        </form>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="table-header text-left">Date</th>
              <th className="table-header text-left">Day</th>
              <th className="table-header text-left">Holiday</th>
              {isOwner && <th className="table-header text-center"></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {holidays.length === 0 ? (
              <tr><td colSpan={isOwner ? 4 : 3} className="table-cell text-center text-gray-400 py-10">No holidays added for {year}</td></tr>
            ) : holidays.map(h => (
              <tr key={h.id} className="hover:bg-gray-50">
                <td className="table-cell text-sm whitespace-nowrap">{fmtDate(h.holiday_date)}</td>
                <td className="table-cell text-sm text-gray-500">{new Date(h.holiday_date).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })}</td>
                <td className="table-cell text-sm font-medium text-gray-800">{h.name}</td>
                {isOwner && (
                  <td className="table-cell text-center">
                    <button className="p-1 text-gray-300 hover:text-red-600" onClick={() => remove(h)} title="Remove holiday">
                      <Trash2 size={14} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NewRunModal({ onClose, onDone }) {
  const navigate = useNavigate();
  const now = new Date();
  // Default to the previous month — salaries are computed after the month ends
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const [month, setMonth] = useState(`${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`);
  const [workingDays, setWorkingDays] = useState('30');
  const [essl, setEssl] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('month', month);
      fd.append('working_days', workingDays);
      if (essl) fd.append('essl', essl);
      const r = await api.post('/payroll/runs', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const info = r.data.essl;
      if (info) {
        const p = info.period;
        const monthOk = p?.from && p?.to && (p.from.slice(0, 7) === month || p.to.slice(0, 7) === month);
        alert(
          `ESSL parsed — attendance pre-filled for ${info.applied} worker(s).` +
          (p?.from ? `\nReport period: ${p.from} to ${p.to}` : '') +
          (!monthOk && p?.from ? `\n\n⚠ These dates are not in ${month} — check you uploaded the right month's report.` : '') +
          (info.unmatched?.length ? `\n\nNot matched to any worker (fix the name & re-parse): ${info.unmatched.join(', ')}` : '')
        );
      }
      navigate(`/payroll/runs/${r.data.id}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create run');
      setSaving(false);
    }
  };

  return (
    <Modal open title="New Salary Month" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs text-gray-500 bg-blue-50 border border-blue-100 rounded-lg p-2">
          Creates a line for every active worker. Attach the month's ESSL in/out report,
          then fill the attendance grid from it.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Salary Month <span className="text-red-500">*</span></label>
            <input className="input" type="month" value={month} onChange={e => setMonth(e.target.value)} required />
          </div>
          <div>
            <label className="label">Working Days</label>
            <input className="input" type="number" min="1" max="31" value={workingDays} onChange={e => setWorkingDays(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label">ESSL Report (PDF) <span className="text-gray-400 font-normal">(optional now — attach when you have it)</span></label>
          <label className="flex items-center gap-2 cursor-pointer border border-gray-200 rounded-lg px-3 py-2 hover:border-brand-400 transition-colors bg-gray-50">
            <Upload size={15} className="text-gray-400 flex-shrink-0" />
            <span className="text-sm text-gray-600 flex-1 truncate">{essl ? essl.name : 'Attach ESSL report…'}</span>
            <input type="file" accept=".pdf,image/*" className="hidden" onChange={e => setEssl(e.target.files[0] || null)} />
          </label>
        </div>
        {error && <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
        <div className="flex gap-3 pt-1">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving}>{saving ? 'Creating…' : 'Create Run'}</button>
        </div>
      </form>
    </Modal>
  );
}

function EmployeeModal({ employee, onClose, onDone }) {
  const [f, setF] = useState(employee ? { ...employee } : {
    name: '', worker_group: 'labour', daily_rate: '', monthly_salary: '', petrol_monthly: '',
    bank_ac_no: '', ifsc_code: '', ac_holder_name: '', joined_on: '', notes: '', active: true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));
  const isLabour = f.worker_group === 'labour';

  const submit = async (e) => {
    e.preventDefault();
    if (!f.name?.trim()) return setError('Name is required');
    if (isLabour && !(Number(f.daily_rate) > 0)) return setError('Rate per day is required');
    if (!isLabour && !(Number(f.monthly_salary) > 0)) return setError('Monthly salary is required');
    setSaving(true);
    setError('');
    try {
      if (employee) await api.put(`/payroll/employees/${employee.id}`, f);
      else await api.post('/payroll/employees', f);
      onDone();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed');
      setSaving(false);
    }
  };

  return (
    <Modal open title={employee ? `Edit — ${employee.name}` : 'Add Worker'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="label">Name <span className="text-red-500">*</span></label>
            <input className="input" value={f.name || ''} onChange={set('name')} required />
          </div>
          <div className="col-span-2">
            <label className="label">Worker Type <span className="text-red-500">*</span></label>
            <select className="input" value={f.worker_group} onChange={set('worker_group')}>
              <option value="labour">Per-Day Labour — paid by present days, no paid leave</option>
              <option value="fixed_admin">Fixed — Admin (8h day, 1 paid leave/mo + 6:30 sick rule)</option>
              <option value="fixed_production">Fixed — Production (10h day, 2 paid leaves/mo)</option>
              <option value="fixed_production_nl">Fixed — Production (10h day, no paid leave)</option>
            </select>
          </div>
          {isLabour ? (
            <div>
              <label className="label">Rate per Day (₹) <span className="text-red-500">*</span></label>
              <input className="input" type="number" step="any" min="0" value={f.daily_rate || ''} onChange={set('daily_rate')} />
            </div>
          ) : (
            <div>
              <label className="label">Monthly Salary (₹) <span className="text-red-500">*</span></label>
              <input className="input" type="number" step="any" min="0" value={f.monthly_salary || ''} onChange={set('monthly_salary')} />
            </div>
          )}
          {(f.worker_group === 'fixed_admin' || f.worker_group === 'fixed_production') && (
            <div>
              <label className="label">Petrol / month (₹)</label>
              <input className="input" type="number" step="any" min="0" value={f.petrol_monthly || ''} onChange={set('petrol_monthly')} />
            </div>
          )}
          <div>
            <label className="label">Bank AC No</label>
            <input className="input" value={f.bank_ac_no || ''} onChange={set('bank_ac_no')} />
          </div>
          <div>
            <label className="label">IFSC Code</label>
            <input className="input" value={f.ifsc_code || ''} onChange={set('ifsc_code')} />
          </div>
          <div>
            <label className="label">AC Holder Name</label>
            <input className="input" value={f.ac_holder_name || ''} onChange={set('ac_holder_name')} />
          </div>
          <div>
            <label className="label">Joined On</label>
            <input className="input" type="date" value={f.joined_on ? String(f.joined_on).slice(0, 10) : ''} onChange={set('joined_on')} />
          </div>
          <div className="col-span-2">
            <label className="label">Notes</label>
            <input className="input" value={f.notes || ''} onChange={set('notes')} />
          </div>
          {employee && (
            <div className="col-span-2 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={!!f.active} onChange={e => setF(p => ({ ...p, active: e.target.checked }))} />
                Active — included in new salary runs
              </label>
              <p className="text-[11px] text-gray-400 mt-0.5 ml-6">Uncheck when the worker leaves — they drop out of future runs but their past salary records are kept.</p>
            </div>
          )}
        </div>
        {error && <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
        <div className="flex gap-3 pt-1">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving}>{saving ? 'Saving…' : employee ? 'Update' : 'Add Worker'}</button>
        </div>
      </form>
    </Modal>
  );
}

function AdvanceModal({ employee, onClose, onDone }) {
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post(`/payroll/employees/${employee.id}/advances`, { amount, advance_date: date, notes });
      onDone();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed');
      setSaving(false);
    }
  };

  return (
    <Modal open title={`Advance — ${employee.name}`} onClose={onClose} size="sm">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs text-gray-500 bg-amber-50 border border-amber-100 rounded-lg p-2 flex items-center gap-1.5">
          <CalendarClock size={13} className="flex-shrink-0" />
          Current advance balance: <span className="font-semibold">₹{Number(employee.advance_balance || 0).toLocaleString('en-IN')}</span> — it auto-deducts in the next salary run.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Amount (₹) <span className="text-red-500">*</span></label>
            <input className="input" type="number" step="any" min="0.01" value={amount} onChange={e => setAmount(e.target.value)} required autoFocus />
          </div>
          <div>
            <label className="label">Date <span className="text-red-500">*</span></label>
            <input className="input" type="date" value={date} onChange={e => setDate(e.target.value)} required />
          </div>
        </div>
        <div>
          <label className="label">Notes</label>
          <input className="input" value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
        {error && <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
        <div className="flex gap-3 pt-1">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving}>{saving ? 'Saving…' : 'Record Advance'}</button>
        </div>
      </form>
    </Modal>
  );
}

// Owner adjusts a worker's paid-leave balance — e.g. an opening balance carried
// over from before the app, or a correction. Positive adds credit, negative
// removes. Posts to the leave ledger and shows recent entries for context.
function LeaveModal({ employee, onClose, onDone }) {
  const [data, setData] = useState(null); // { balance, entries }
  const [delta, setDelta] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.get(`/payroll/employees/${employee.id}/leave`).then(r => setData(r.data)).catch(() => setData({ balance: 0, entries: [] }));
  useEffect(() => { load(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    const d = Number(delta);
    if (!d) return setError('Enter a non-zero amount (e.g. 3 to add, -1 to remove).');
    setSaving(true); setError('');
    try {
      await api.post(`/payroll/employees/${employee.id}/leave`, { delta: d, notes: notes.trim() || undefined });
      onDone();
    } catch (err) { setError(err.response?.data?.error || 'Failed'); setSaving(false); }
  };

  const REASON_LABELS = { monthly_accrual: 'Monthly accrual', sick_630: '6:30 sick credit', used: 'Used', year_trim: 'Year-start trim', manual: 'Manual adjustment' };

  return (
    <Modal open title={`Leave Balance — ${employee.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="bg-emerald-50 border border-emerald-100 rounded-lg p-3 flex items-center justify-between">
          <span className="text-sm text-gray-600">Current balance</span>
          <span className="text-xl font-bold text-emerald-700">{data ? Number(data.balance) : '…'} <span className="text-sm font-normal text-gray-500">leaves</span></span>
        </div>
        <div>
          <label className="label">Adjustment <span className="text-red-500">*</span></label>
          <input className="input" type="number" step="0.5" value={delta} onChange={e => { setDelta(e.target.value); setError(''); }}
            placeholder="e.g. 3 to add carried-over leave, -1 to remove" autoFocus />
          <p className="text-[11px] text-gray-400 mt-1">Positive adds leave credit; negative removes. New balance will be {data ? Number(data.balance) + (Number(delta) || 0) : '…'}.</p>
        </div>
        <div>
          <label className="label">Note <span className="text-gray-400 font-normal">(optional)</span></label>
          <input className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. Leftover leave carried from before the app" />
        </div>

        {data?.entries?.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-500 mb-1">Recent ledger</p>
            <div className="max-h-40 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-50">
              {data.entries.slice(0, 8).map(en => (
                <div key={en.id} className="flex items-center justify-between px-3 py-1.5 text-xs">
                  <span className="text-gray-600">{REASON_LABELS[en.reason] || en.reason}{en.notes ? ` · ${en.notes}` : ''}</span>
                  <span className={`font-semibold ${Number(en.delta) < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{Number(en.delta) > 0 ? '+' : ''}{Number(en.delta)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
        <div className="flex gap-3 pt-1">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving}>{saving ? 'Saving…' : 'Apply Adjustment'}</button>
        </div>
      </form>
    </Modal>
  );
}
