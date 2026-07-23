import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import { downloadExcel } from '../../lib/utils';
import { ArrowLeft, Banknote, Download, FileText, Send, CheckCircle, AlertTriangle, Save } from 'lucide-react';

const inr = (n) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const STATUS_BADGES = {
  draft:     'bg-gray-100 text-gray-600',
  submitted: 'bg-blue-100 text-blue-700',
  approved:  'bg-green-100 text-green-700',
  paid:      'bg-emerald-100 text-emerald-800',
};

// Attendance + review grid for one salary month.
// accounts: enters attendance (present/absent/OT/6:30 stays) and submits.
// owner: additionally sees pay figures, decides leave credits, petrol and
// advance deductions, approves, and marks lines paid.
export default function PayrollRun() {
  const { id } = useParams();
  const { user } = useAuthStore();
  const isOwner = user.role === 'owner';
  const [data, setData] = useState(null);
  const [edits, setEdits] = useState({}); // lineId → field changes
  const [saving, setSaving] = useState(false);
  const [warnings, setWarnings] = useState([]);
  const [error, setError] = useState('');

  const load = () => api.get(`/payroll/runs/${id}`).then(r => { setData(r.data); setEdits({}); }).catch(e => setError(e.response?.data?.error || 'Failed to load'));
  useEffect(() => { load(); }, [id]);

  if (error) return <div className="p-6 text-red-600">{error}</div>;
  if (!data) return <div className="p-6 text-gray-400">Loading…</div>;

  const { run, lines, leave_balances: leaveBal } = data;
  const editable = ['draft', 'submitted'].includes(run.status);
  const approved = ['approved', 'paid'].includes(run.status);

  const val = (l, k) => edits[l.id]?.[k] !== undefined ? edits[l.id][k] : (l[k] ?? '');
  const setVal = (l, k) => (e) => setEdits(p => ({ ...p, [l.id]: { ...p[l.id], [k]: e.target.value } }));
  const dirty = Object.keys(edits).length > 0;

  const saveGrid = async () => {
    if (!dirty) return;
    setSaving(true);
    setWarnings([]);
    try {
      const payload = Object.entries(edits).map(([lineId, ch]) => ({ id: lineId, ...ch }));
      // Attendance fields go to /attendance; owner-only fields to /review
      const attFields = ['present_days', 'absent_days', 'ot_hours', 'late_stay_days', 'remarks'];
      const revFields = ['leave_credit_used', 'sick_credit_earned', 'petrol', 'advance_deduction', 'remarks'];
      const att = payload.map(u => Object.fromEntries(Object.entries(u).filter(([k]) => k === 'id' || attFields.includes(k)))).filter(u => Object.keys(u).length > 1);
      const rev = payload.map(u => Object.fromEntries(Object.entries(u).filter(([k]) => k === 'id' || revFields.includes(k)))).filter(u => Object.keys(u).length > 1);
      if (att.length) await api.put(`/payroll/runs/${id}/attendance`, { lines: att });
      if (isOwner && rev.length) {
        const r = await api.put(`/payroll/runs/${id}/review`, { lines: rev });
        if (r.data.warnings?.length) setWarnings(r.data.warnings);
      }
      await load();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const doAction = async (action, confirmMsg) => {
    if (dirty) return alert('Save your changes first.');
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    try { await api.put(`/payroll/runs/${id}/${action}`); load(); }
    catch (err) { alert(err.response?.data?.error || 'Failed'); }
  };

  const markLinePaid = async (lineId) => {
    try { await api.put(`/payroll/runs/${id}/mark-paid`, { line_ids: [lineId] }); load(); }
    catch (err) { alert(err.response?.data?.error || 'Failed'); }
  };

  const labour = lines.filter(l => l.worker_group === 'labour');
  const fixed = lines.filter(l => l.worker_group !== 'labour');
  const totalPayable = isOwner ? lines.reduce((a, l) => a + Number(l.total_payable || 0), 0) : null;

  const numInput = (l, k, { step = 'any', width = 'w-16', disabled = false } = {}) => (
    editable && !disabled ? (
      <input className={`input text-sm py-1 px-1.5 text-right ${width}`} type="number" step={step} min="0"
        value={val(l, k)} onChange={setVal(l, k)} />
    ) : (
      <span className="text-sm">{Number(l[k] || 0)}</span>
    )
  );

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <Link to="/payroll" className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-3">
        <ArrowLeft size={14} /> Back to Payroll
      </Link>

      <div className="flex items-start justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Banknote size={24} className="text-emerald-600" /> Salary — {run.month}
            <span className={`text-[10px] font-bold rounded-full px-2 py-0.5 uppercase ${STATUS_BADGES[run.status]}`}>{run.status}</span>
          </h1>
          <p className="text-gray-500 text-sm mt-0.5">
            {run.working_days} working days
            {isOwner && totalPayable != null && <> · Total payable: <span className="font-semibold text-gray-800">{inr(totalPayable)}</span></>}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {run.essl_file && (
            <a className="btn-secondary btn-sm flex items-center gap-1.5 text-xs" href={`/uploads/${run.essl_file}`} target="_blank" rel="noopener noreferrer">
              <FileText size={13} /> ESSL Report
            </a>
          )}
          {isOwner && (
            <button className="btn-secondary btn-sm flex items-center gap-1.5 text-xs"
              onClick={() => downloadExcel(`payroll/${run.month}`, `payroll_${run.month}.xlsx`)}>
              <Download size={13} /> Export
            </button>
          )}
          {dirty && (
            <button className="btn-primary flex items-center gap-1.5" onClick={saveGrid} disabled={saving}>
              <Save size={15} /> {saving ? 'Saving…' : 'Save Changes'}
            </button>
          )}
          {!dirty && editable && run.status === 'draft' && (
            <button className="btn-secondary flex items-center gap-1.5" onClick={() => doAction('submit', 'Submit attendance to the owner for review?')}>
              <Send size={15} /> Submit for Review
            </button>
          )}
          {!dirty && isOwner && editable && (
            <button className="btn-primary flex items-center gap-1.5"
              onClick={() => doAction('approve', `Approve ${run.month} salaries? This locks attendance, posts leave credits and settles advances.`)}>
              <CheckCircle size={15} /> Approve Payroll
            </button>
          )}
          {!dirty && isOwner && approved && run.status !== 'paid' && (
            <button className="btn-primary flex items-center gap-1.5"
              onClick={() => doAction('mark-paid', 'Mark ALL salaries as paid?')}>
              <CheckCircle size={15} /> Mark All Paid
            </button>
          )}
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="mb-4 text-sm rounded-xl px-4 py-3 bg-amber-50 border border-amber-200 text-amber-800">
          {warnings.map((w, i) => <div key={i} className="flex items-center gap-1.5"><AlertTriangle size={13} /> {w}</div>)}
        </div>
      )}

      {/* ── Per-Day Labour ── */}
      {labour.length > 0 && (
        <Section title="Per-Day Labour" subtitle="Paid by present days × daily rate · OT = rate ÷ 8 per hour · no paid leave">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="table-header text-left">Name</th>
                {isOwner && <th className="table-header text-right">Rate/Day</th>}
                <th className="table-header text-right">Present</th>
                <th className="table-header text-right">Absent</th>
                <th className="table-header text-right">OT (hrs)</th>
                {isOwner && (
                  <>
                    <th className="table-header text-right">Salary (Present)</th>
                    <th className="table-header text-right">OT Amt</th>
                    <th className="table-header text-right">Advance</th>
                    <th className="table-header text-right">Total</th>
                    <th className="table-header text-center">Paid</th>
                  </>
                )}
                <th className="table-header text-left">Remarks</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {labour.map(l => (
                <tr key={l.id} className="hover:bg-gray-50">
                  <td className="table-cell text-sm font-medium text-gray-800">{l.name}</td>
                  {isOwner && <td className="table-cell text-right text-sm">{inr(l.daily_rate || 0)}</td>}
                  <td className="table-cell text-right">{numInput(l, 'present_days')}</td>
                  <td className="table-cell text-right">{numInput(l, 'absent_days')}</td>
                  <td className="table-cell text-right">{numInput(l, 'ot_hours')}</td>
                  {isOwner && (
                    <>
                      <td className="table-cell text-right text-sm">{inr(l.base_pay)}</td>
                      <td className="table-cell text-right text-sm">{inr(l.ot_amount)}</td>
                      <td className="table-cell text-right">
                        {editable ? (
                          <input className="input text-sm py-1 px-1.5 text-right w-20" type="number" step="any" min="0"
                            value={val(l, 'advance_deduction')} onChange={setVal(l, 'advance_deduction')} />
                        ) : <span className="text-sm">{inr(l.advance_deduction)}</span>}
                      </td>
                      <td className="table-cell text-right text-sm font-bold">{inr(l.total_payable)}</td>
                      <td className="table-cell text-center">
                        {approved ? (
                          l.paid ? <CheckCircle size={15} className="inline text-green-600" />
                            : <button className="text-xs text-brand-600 hover:underline" onClick={() => markLinePaid(l.id)}>mark</button>
                        ) : '—'}
                      </td>
                    </>
                  )}
                  <td className="table-cell">
                    {editable ? (
                      <input className="input text-sm py-1 px-1.5 w-32" value={val(l, 'remarks') || ''} onChange={setVal(l, 'remarks')} />
                    ) : <span className="text-xs text-gray-500">{l.remarks || '—'}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {/* ── Fixed Salary (Admin + Production) ── */}
      {fixed.length > 0 && (
        <Section title="Fixed Salary — Admin & Production"
          subtitle="Salary ÷ 30 per day · OT = day pay ÷ 8 per hour · 1 paid leave/month (max 5 carried to next year, >7 together flagged) · Admin: 4+ days past 6:30pm in a week = +1 sick credit">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="table-header text-left">Name</th>
                <th className="table-header text-left">Type</th>
                {isOwner && <th className="table-header text-right">Salary</th>}
                <th className="table-header text-right">Absent</th>
                <th className="table-header text-right">OT (hrs)</th>
                <th className="table-header text-right" title="Days the worker stayed past 6:30pm (admin sick-credit rule)">6:30 Stays</th>
                {isOwner && (
                  <>
                    <th className="table-header text-right" title="Available leave credit balance">Leave Bal.</th>
                    <th className="table-header text-right" title="Absences to charge against leave credit (no salary cut)">Credit Used</th>
                    <th className="table-header text-right" title="Sick credits earned this month (admin 6:30 rule)">Sick +</th>
                    <th className="table-header text-right">Absent Ded.</th>
                    <th className="table-header text-right">OT Amt</th>
                    <th className="table-header text-right">Petrol</th>
                    <th className="table-header text-right">Advance</th>
                    <th className="table-header text-right">Total</th>
                    <th className="table-header text-center">Paid</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {fixed.map(l => (
                <tr key={l.id} className={`hover:bg-gray-50 ${l.long_leave_flag ? 'bg-red-50/50' : ''}`}>
                  <td className="table-cell text-sm font-medium text-gray-800">
                    {l.name}
                    {l.long_leave_flag && <span className="ml-1.5 text-[9px] font-bold bg-red-100 text-red-700 rounded px-1 py-0.5" title="More than 7 leaves together">&gt;7 LEAVES</span>}
                  </td>
                  <td className="table-cell text-xs text-gray-500">{l.worker_group === 'fixed_admin' ? 'Admin (8h)' : 'Production (10h)'}</td>
                  {isOwner && <td className="table-cell text-right text-sm">{inr(l.monthly_salary || 0)}</td>}
                  <td className="table-cell text-right">{numInput(l, 'absent_days')}</td>
                  <td className="table-cell text-right">{numInput(l, 'ot_hours')}</td>
                  <td className="table-cell text-right">{numInput(l, 'late_stay_days', { step: '1', disabled: l.worker_group !== 'fixed_admin' })}</td>
                  {isOwner && (
                    <>
                      <td className="table-cell text-right text-sm font-semibold">{leaveBal?.[l.employee_id] ?? 0}</td>
                      <td className="table-cell text-right">
                        {editable ? (
                          <input className="input text-sm py-1 px-1.5 text-right w-14" type="number" step="0.5" min="0"
                            value={val(l, 'leave_credit_used')} onChange={setVal(l, 'leave_credit_used')} />
                        ) : <span className="text-sm">{Number(l.leave_credit_used)}</span>}
                      </td>
                      <td className="table-cell text-right">
                        {editable && l.worker_group === 'fixed_admin' ? (
                          <input className="input text-sm py-1 px-1.5 text-right w-14" type="number" step="1" min="0"
                            value={val(l, 'sick_credit_earned')} onChange={setVal(l, 'sick_credit_earned')} />
                        ) : <span className="text-sm">{Number(l.sick_credit_earned)}</span>}
                      </td>
                      <td className="table-cell text-right text-sm text-red-600">{inr(l.absent_deduction)}</td>
                      <td className="table-cell text-right text-sm">{inr(l.ot_amount)}</td>
                      <td className="table-cell text-right">
                        {editable ? (
                          <input className="input text-sm py-1 px-1.5 text-right w-18" type="number" step="any" min="0"
                            value={val(l, 'petrol')} onChange={setVal(l, 'petrol')} />
                        ) : <span className="text-sm">{inr(l.petrol)}</span>}
                      </td>
                      <td className="table-cell text-right">
                        {editable ? (
                          <input className="input text-sm py-1 px-1.5 text-right w-20" type="number" step="any" min="0"
                            value={val(l, 'advance_deduction')} onChange={setVal(l, 'advance_deduction')} />
                        ) : <span className="text-sm">{inr(l.advance_deduction)}</span>}
                      </td>
                      <td className="table-cell text-right text-sm font-bold">{inr(l.total_payable)}</td>
                      <td className="table-cell text-center">
                        {approved ? (
                          l.paid ? <CheckCircle size={15} className="inline text-green-600" />
                            : <button className="text-xs text-brand-600 hover:underline" onClick={() => markLinePaid(l.id)}>mark</button>
                        ) : '—'}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </div>
  );
}

function Section({ title, subtitle, children }) {
  return (
    <div className="mb-6">
      <h2 className="text-sm font-semibold text-gray-800">{title}</h2>
      <p className="text-[11px] text-gray-400 mb-2">{subtitle}</p>
      <div className="card overflow-x-auto">{children}</div>
    </div>
  );
}
