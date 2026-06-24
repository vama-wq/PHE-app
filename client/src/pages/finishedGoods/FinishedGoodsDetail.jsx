import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import Modal from '../../components/ui/Modal';
import { ArrowLeft, ArrowDownCircle, ArrowUpCircle, Package, BarChart2,
         CheckCircle, Circle, AlertTriangle, ArrowRight, Plus } from 'lucide-react';
import { fmtDateTime, fmtDate, PRODUCTION_STAGES } from '../../lib/utils';

export default function FinishedGoodsDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [summaryJc, setSummaryJc]   = useState(null);
  const [showOutward, setShowOutward] = useState(false);
  const [showInward, setShowInward]   = useState(false);
  const canManage = ['accounts', 'owner', 'admin'].includes(user.role);

  const load = () => {
    api.get(`/finished-goods/${id}`)
      .then(r => { setData(r.data); setLoading(false); });
  };
  useEffect(() => { load(); }, [id]);

  if (loading) return <div className="p-6 text-gray-400">Loading...</div>;
  if (!data)   return <div className="p-6 text-red-500">Not found</div>;

  const fg = data;
  const inwardLog  = (fg.log || []).filter(l => l.movement_type === 'inward');
  const outwardLog = (fg.log || []).filter(l => l.movement_type === 'outward');
  const totalOutward = outwardLog.reduce((s, l) => s + (parseInt(l.qty) || 0), 0);

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* Back + Record Outward */}
      <div className="flex items-center justify-between">
        <button onClick={() => navigate('/finished-goods')}
          className="flex items-center gap-2 text-sm text-gray-500 hover:text-brand-600 transition-colors">
          <ArrowLeft size={16} /> Back to Finished Goods
        </button>
        <div className="flex items-center gap-2">
          {canManage && (
            <button className="btn-secondary flex items-center gap-1.5 text-sm"
              onClick={() => setShowInward(true)}>
              <ArrowDownCircle size={15} /> Add Stock
            </button>
          )}
          {fg.qty_available > 0 && (
            <button className="btn-primary flex items-center gap-1.5 text-sm"
              onClick={() => setShowOutward(true)}>
              <Plus size={15} /> Record Outward
            </button>
          )}
        </div>
      </div>

      {/* Product header */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 bg-brand-50 rounded-xl flex items-center justify-center flex-shrink-0">
            <Package size={22} className="text-brand-600" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-bold text-gray-900">
              {fg.base_drawing_no || fg.drawing_no || '—'}
            </h1>
            <div className="flex flex-wrap gap-2 mt-1.5">
              {fg.tube_material      && <Chip color="gray">{fg.tube_material}</Chip>}
              {fg.tube_diameter      && <Chip color="gray">⌀ {fg.tube_diameter} mm</Chip>}
              {fg.wattage            && <Chip color="amber">{fg.wattage} W</Chip>}
              {fg.voltage            && <Chip color="blue">{fg.voltage} V</Chip>}
              {fg.plating_instructions && <Chip color="purple">{fg.plating_instructions}</Chip>}
            </div>
          </div>
        </div>
      </div>

      {/* Stock cards */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard icon={ArrowDownCircle} color="green" label="Total Inward" value={fg.qty_in}
          sub={`${inwardLog.length} batch${inwardLog.length !== 1 ? 'es' : ''}`} />
        <StatCard icon={ArrowUpCircle} color="red" label="Total Outward" value={totalOutward}
          sub={`${outwardLog.length} movement${outwardLog.length !== 1 ? 's' : ''}`} />
        <StatCard icon={Package} color={fg.qty_available === 0 ? 'red' : 'blue'}
          label="Available Stock" value={fg.qty_available} sub="Nos" />
      </div>

      {/* ── Inward Batches ── */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 bg-green-50 flex items-center gap-2">
          <ArrowDownCircle size={15} className="text-green-600" />
          <h2 className="text-sm font-semibold text-green-800 uppercase tracking-wide">
            Inward Batches — Production History
          </h2>
        </div>

        {inwardLog.length === 0 ? (
          <p className="text-center text-gray-400 text-sm py-8">No inward batches yet</p>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="table-header text-left">Drawing No (Job Card)</th>
                <th className="table-header text-left">Order</th>
                <th className="table-header text-left">Customer</th>
                <th className="table-header text-center">Qty</th>
                <th className="table-header text-left">Date</th>
                <th className="table-header text-right">Checklist</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {inwardLog.map(l => (
                <tr key={l.id} className="hover:bg-gray-50">
                  {/* Drawing number from job card + job card no as sub-label */}
                  <td className="table-cell">
                    <div className="font-semibold text-brand-700 text-sm">
                      {l.jc_drawing_no || l.job_card_no || '—'}
                    </div>
                    {l.jc_drawing_no && l.job_card_no && (
                      <div className="text-xs text-gray-400">{l.job_card_no}</div>
                    )}
                  </td>

                  {/* Order */}
                  <td className="table-cell text-sm text-gray-700 font-medium">
                    {l.jc_order_code || l.order_code || '—'}
                  </td>

                  {/* Customer */}
                  <td className="table-cell text-sm">
                    {l.jc_customer_code
                      ? <>
                          <div className="font-medium text-gray-800">{l.jc_customer_code}</div>
                          {l.jc_customer_name && (
                            <div className="text-xs text-gray-400">{l.jc_customer_name}</div>
                          )}
                        </>
                      : <span className="text-gray-400">—</span>
                    }
                  </td>

                  {/* Qty */}
                  <td className="table-cell text-center">
                    <span className="inline-flex items-center gap-1 text-sm font-semibold text-green-700 bg-green-50 px-2 py-0.5 rounded-full">
                      +{l.qty}
                    </span>
                  </td>

                  {/* Date */}
                  <td className="table-cell text-sm text-gray-500">
                    {fmtDate(l.created_at)}
                  </td>

                  {/* Checklist summary button */}
                  <td className="table-cell text-right">
                    {l.job_card_id ? (
                      <button
                        onClick={() => setSummaryJc({
                          id: l.job_card_id,
                          job_card_no: l.job_card_no,
                          drawing_no: l.jc_drawing_no,
                          qty: null, net_qty: null,
                          qc_route: null, qc_dispatch_qty: null, qc_fg_qty: null,
                        })}
                        className="btn-secondary btn-sm flex items-center gap-1 text-xs py-1 px-2 ml-auto"
                      >
                        <BarChart2 size={12} /> Summary
                      </button>
                    ) : (
                      <span className="text-gray-300 text-xs">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Outward Movements ── */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 bg-red-50 flex items-center gap-2">
          <ArrowUpCircle size={15} className="text-red-500" />
          <h2 className="text-sm font-semibold text-red-700 uppercase tracking-wide">
            Outward Movements — Dispatch &amp; Sampling
          </h2>
        </div>
        {outwardLog.length === 0 ? (
          <p className="text-center text-gray-400 text-sm py-8">No outward movements recorded</p>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="table-header text-left">Type</th>
                <th className="table-header text-left">Client</th>
                <th className="table-header text-center">Qty</th>
                <th className="table-header text-left">Reference / Reason</th>
                <th className="table-header text-left">By</th>
                <th className="table-header text-left">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {outwardLog.map(l => (
                <tr key={l.id} className="hover:bg-gray-50">
                  <td className="table-cell">
                    {l.outward_type === 'sampling' ? (
                      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700">
                        🧪 Sampling
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-red-100 text-red-700">
                        📦 Dispatch
                      </span>
                    )}
                  </td>
                  <td className="table-cell text-sm">
                    <div className="font-medium text-gray-800">{l.client_name || '—'}</div>
                    {l.client_code && <div className="text-xs text-gray-400">{l.client_code}</div>}
                  </td>
                  <td className="table-cell text-center">
                    <span className="inline-flex items-center gap-1 text-sm font-semibold text-red-700 bg-red-50 px-2 py-0.5 rounded-full">
                      -{l.qty}
                    </span>
                  </td>
                  <td className="table-cell text-sm text-gray-500">
                    {l.reason    && <div className="text-amber-700 font-medium">{l.reason}</div>}
                    {l.reference && <div>{l.reference}</div>}
                    {l.notes     && <div className="text-gray-400">{l.notes}</div>}
                    {!l.reason && !l.reference && !l.notes && '—'}
                  </td>
                  <td className="table-cell text-sm text-gray-600">{l.created_by_name || '—'}</td>
                  <td className="table-cell text-sm text-gray-500">{fmtDate(l.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Inward modal */}
      {showInward && (
        <InwardModal
          fg={fg}
          onClose={() => setShowInward(false)}
          onDone={() => { setShowInward(false); load(); }}
        />
      )}

      {/* Outward modal */}
      {showOutward && (
        <OutwardModal
          fg={fg}
          onClose={() => setShowOutward(false)}
          onDone={() => { setShowOutward(false); load(); }}
        />
      )}

      {/* Checklist summary modal */}
      {summaryJc && (
        <ChecklistSummaryModal jc={summaryJc} onClose={() => setSummaryJc(null)} />
      )}
    </div>
  );
}

// ── Inward Modal (manual stock addition) ─────────────────────────────────────
function InwardModal({ fg, onClose, onDone }) {
  const [qty, setQty]       = useState('');
  const [notes, setNotes]   = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!qty || parseInt(qty) <= 0) return setError('Enter a valid quantity');
    setSaving(true);
    try {
      await api.post(`/finished-goods/${fg.id}/inward`, {
        qty: parseInt(qty),
        notes: notes || undefined,
      });
      onDone();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed');
      setSaving(false);
    }
  };

  return (
    <Modal open title="Add Inward Stock" onClose={onClose} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="bg-gray-50 rounded-xl p-3 text-sm">
          <p className="font-bold text-gray-900">{fg.base_drawing_no || fg.drawing_no}</p>
          <p className="text-gray-500 text-xs mt-0.5">
            {[fg.tube_material, fg.wattage ? `${fg.wattage}W` : null, fg.voltage ? `${fg.voltage}V` : null].filter(Boolean).join(' · ')}
          </p>
          <p className="text-blue-600 font-semibold mt-1">Current stock: {fg.qty_available} Nos</p>
        </div>
        <div>
          <label className="label">Quantity to Add *</label>
          <input className="input" type="number" min="1" placeholder="e.g. 50" value={qty}
            onChange={e => setQty(e.target.value)} required autoFocus />
        </div>
        <div>
          <label className="label">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
          <textarea className="input h-16 resize-none" placeholder="Reason for manual addition..."
            value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <div className="flex gap-3 pt-1">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving}>
            {saving ? 'Saving...' : 'Add Stock'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Outward Modal ─────────────────────────────────────────────────────────────
function OutwardModal({ fg, onClose, onDone }) {
  const [qty, setQty]                 = useState('');
  const [outwardType, setOutwardType] = useState('dispatch');
  const [customerId, setCustomerId]   = useState('');
  const [reason, setReason]           = useState('');
  const [reference, setRef]           = useState('');
  const [notes, setNotes]             = useState('');
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState('');
  const [customers, setCustomers]     = useState([]);

  useEffect(() => { api.get('/customers').then(r => setCustomers(r.data)).catch(() => {}); }, []);

  const selectedCustomer = customers.find(c => String(c.id) === String(customerId));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!qty || parseInt(qty) <= 0) return setError('Enter a valid quantity');
    if (!customerId) return setError('Select a client');
    if (outwardType === 'sampling' && !reason.trim()) return setError('Reason required for sampling');
    setSaving(true);
    try {
      await api.post(`/finished-goods/${fg.id}/outward`, {
        qty: parseInt(qty),
        outward_type: outwardType,
        client_code: selectedCustomer?.customer_code || '',
        client_name: selectedCustomer?.name || '',
        reason: outwardType === 'sampling' ? reason : undefined,
        reference, notes,
      });
      onDone();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed');
      setSaving(false);
    }
  };

  return (
    <Modal open title="Record Outward" onClose={onClose} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="bg-gray-50 rounded-xl p-3 text-sm">
          <p className="font-bold text-gray-900">{fg.base_drawing_no || fg.drawing_no}</p>
          <p className="text-gray-500 text-xs mt-0.5">
            {[fg.tube_material, fg.wattage ? `${fg.wattage}W` : null, fg.voltage ? `${fg.voltage}V` : null].filter(Boolean).join(' · ')}
          </p>
          <p className="text-green-600 font-semibold mt-1">{fg.qty_available} Nos available</p>
        </div>
        <div>
          <label className="label">Outward Type *</label>
          <div className="flex gap-3">
            {['dispatch', 'sampling'].map(t => (
              <button key={t} type="button" onClick={() => setOutwardType(t)}
                className={`flex-1 py-2 rounded-xl border-2 text-sm font-semibold transition-colors ${
                  outwardType === t
                    ? t === 'dispatch' ? 'bg-blue-50 border-blue-500 text-blue-700' : 'bg-amber-50 border-amber-500 text-amber-700'
                    : 'border-gray-200 text-gray-500 hover:border-gray-300'
                }`}>
                {t === 'dispatch' ? '📦 Dispatch' : '🧪 Sampling'}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="label">Client *</label>
          <select className="input" value={customerId} onChange={e => setCustomerId(e.target.value)} required>
            <option value="">— Select customer —</option>
            {customers.map(c => <option key={c.id} value={c.id}>{c.customer_code} · {c.name}</option>)}
          </select>
        </div>
        {outwardType === 'sampling' && (
          <div>
            <label className="label">Sampling Reason *</label>
            <input className="input" placeholder="e.g. New product trial..." value={reason} onChange={e => setReason(e.target.value)} />
          </div>
        )}
        <div>
          <label className="label">Quantity *</label>
          <input className="input" type="number" min="1" max={fg.qty_available} value={qty} onChange={e => setQty(e.target.value)} required />
        </div>
        <div>
          <label className="label">Reference <span className="text-gray-400 font-normal">(optional)</span></label>
          <input className="input" placeholder="e.g. Order ref, dispatch note..." value={reference} onChange={e => setRef(e.target.value)} />
        </div>
        <div>
          <label className="label">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
          <textarea className="input h-16 resize-none" value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <div className="flex gap-3 pt-1">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving}>
            {saving ? 'Saving...' : 'Record Outward'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────
function Chip({ children, color }) {
  const colors = {
    gray:   'bg-gray-100 text-gray-700',
    amber:  'bg-amber-100 text-amber-700',
    blue:   'bg-blue-100 text-blue-700',
    purple: 'bg-purple-100 text-purple-700',
    green:  'bg-green-100 text-green-700',
    red:    'bg-red-100 text-red-700',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[color] || colors.gray}`}>
      {children}
    </span>
  );
}

function StatCard({ icon: Icon, color, label, value, sub }) {
  const styles = {
    green: { bg: 'bg-green-50 border-green-100', icon: 'text-green-600', val: 'text-green-800', sub: 'text-green-600' },
    red:   { bg: 'bg-red-50 border-red-100',     icon: 'text-red-500',   val: 'text-red-700',   sub: 'text-red-500'   },
    blue:  { bg: 'bg-blue-50 border-blue-100',   icon: 'text-blue-600',  val: 'text-blue-800',  sub: 'text-blue-600'  },
  };
  const s = styles[color] || styles.blue;
  return (
    <div className={`border rounded-xl p-4 flex items-center gap-3 ${s.bg}`}>
      <Icon size={22} className={s.icon} />
      <div>
        <p className={`text-xs ${s.sub}`}>{label}</p>
        <p className={`text-2xl font-bold ${s.val}`}>{value}</p>
        {sub && <p className={`text-xs ${s.sub} mt-0.5`}>{sub}</p>}
      </div>
    </div>
  );
}

// ── Checklist Summary Modal (same as in DispatchList) ─────────────────────────
function ChecklistSummaryModal({ jc, onClose }) {
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get(`/job-cards/${jc.id}/checklist`),
      api.get(`/qc/${jc.id}/reports`),
    ]).then(([cl, qcR]) => {
      setData({ checklist: cl.data, qcReports: qcR.data });
    }).finally(() => setLoading(false));
  }, [jc.id]);

  const stages    = data?.checklist?.stages || [];
  const doneStages = stages.filter(s => s.done);
  const qcReport  = data?.qcReports?.[0];
  const totalRejected = stages.reduce((a, s) => a + (parseInt(s.rejection_qty, 10) || 0), 0);
  const totalRemade   = stages.filter(s => s.stage_no !== 29)
                               .reduce((a, s) => a + (parseInt(s.remade_qty, 10) || 0), 0);

  return (
    <Modal open title={`Checklist — ${jc.drawing_no || jc.job_card_no}`} onClose={onClose} size="xl">
      {loading ? (
        <div className="py-12 text-center text-gray-400">Loading...</div>
      ) : (
        <div className="space-y-5">

          {/* Stats */}
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: 'Original Qty', value: jc.qty ?? '—',     color: 'text-gray-800' },
              { label: 'Rejected',     value: totalRejected,       color: totalRejected > 0 ? 'text-red-600' : 'text-gray-800' },
              { label: 'Remade',       value: totalRemade,          color: totalRemade > 0 ? 'text-amber-600' : 'text-gray-800' },
              { label: 'Net Qty',      value: jc.net_qty ?? '—',  color: 'text-green-700' },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-gray-50 rounded-xl p-3 text-center border border-gray-100">
                <div className={`text-2xl font-bold ${color}`}>{value}</div>
                <div className="text-xs text-gray-500 mt-0.5">{label}</div>
              </div>
            ))}
          </div>

          {/* QC report */}
          {qcReport && (
            <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm space-y-1">
              <div className="font-semibold text-blue-800 flex items-center gap-1.5">
                QC Report
                <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                  qcReport.result === 'approved' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                }`}>{qcReport.result}</span>
              </div>
              {qcReport.observations && (
                <div className="text-gray-600"><span className="font-medium">Observations: </span>{qcReport.observations}</div>
              )}
              {qcReport.product_weight && (
                <div className="text-gray-600"><span className="font-medium">Product Weight: </span>{qcReport.product_weight} kg</div>
              )}
            </div>
          )}

          {/* Stage progress */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-gray-700">Production Stages</h3>
              <span className="text-xs text-gray-500">{doneStages.length} / {stages.length} completed</span>
            </div>
            <div className="w-full bg-gray-100 rounded-full h-1.5 mb-3">
              <div className="bg-brand-600 h-1.5 rounded-full"
                style={{ width: `${stages.length ? (doneStages.length / stages.length) * 100 : 0}%` }} />
            </div>

            <div className="divide-y divide-gray-100 border border-gray-200 rounded-xl overflow-hidden max-h-[400px] overflow-y-auto">
              {stages.map(s => {
                const def = PRODUCTION_STAGES.find(p => p.no === s.stage_no);
                const hasRej   = (parseInt(s.rejection_qty, 10) || 0) > 0;
                const hasRemade = (parseInt(s.remade_qty, 10)   || 0) > 0;
                const hasPhoto  = s.photo_file || s.rejection_photo_file;
                return (
                  <div key={s.stage_no}
                    className={`flex items-start gap-3 px-3 py-2 text-sm ${!s.done ? 'bg-gray-50 text-gray-400' : 'bg-white'}`}>
                    <div className="flex-shrink-0 mt-0.5">
                      {s.done
                        ? <CheckCircle size={15} className="text-green-500" />
                        : <Circle      size={15} className="text-gray-300" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`font-medium ${s.done ? 'text-gray-800' : 'text-gray-400'}`}>
                          {s.stage_no}. {def?.name || `Stage ${s.stage_no}`}
                        </span>
                        {hasRej && (
                          <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
                            <AlertTriangle size={10} /> Rej: {s.rejection_qty}
                          </span>
                        )}
                        {hasRemade && (
                          <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">
                            Remade: {s.remade_qty}
                          </span>
                        )}
                        {s.scrap_value && (
                          <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-full">
                            Scrap: {s.scrap_value}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-0.5">
                        {def?.hvLight && s.value1 ? (() => {
                          let d = {};
                          try { d = JSON.parse(s.value1); } catch { d = { light: s.value1 }; }
                          return (
                            <>
                              <span className={`text-xs font-medium ${d.hv === 'pass' ? 'text-green-600' : d.hv === 'fail' ? 'text-red-600' : 'text-gray-400'}`}>
                                HV {d.hv === 'pass' ? '✅' : d.hv === 'fail' ? `❌ (${d.hvCount || ''} — ${d.hvReason || ''})` : '—'}
                              </span>
                              <span className={`text-xs font-medium ${d.light === 'pass' ? 'text-green-600' : d.light === 'fail' ? 'text-red-600' : 'text-gray-400'}`}>
                                Light {d.light === 'pass' ? '✅' : d.light === 'fail' ? `❌ (${d.lightCount || ''} — ${d.lightReason || ''})` : '—'}
                              </span>
                              {d.ohms && <span className="text-xs text-gray-500">Ohms: <span className="text-gray-700">{d.ohms}</span></span>}
                            </>
                          );
                        })() : (
                          <>
                            {s.value1 && <span className="text-xs text-gray-500">{def?.fields?.[0]?.label || 'Value 1'}: <span className="text-gray-700">{s.value1}</span></span>}
                            {s.value2 && <span className="text-xs text-gray-500">{def?.fields?.[1]?.label || 'Value 2'}: <span className="text-gray-700">{s.value2}</span></span>}
                          </>
                        )}
                        {s.worker_name && <span className="text-xs text-gray-500">Worker: <span className="text-gray-700">{s.worker_name}</span></span>}
                        {s.done_at && <span className="text-xs text-gray-400">{fmtDateTime(s.done_at)}</span>}
                      </div>
                      {hasPhoto && (
                        <div className="flex gap-1.5 mt-1.5 flex-wrap">
                          {s.photo_file && (
                            <a href={`/uploads/checklist-photos/${s.photo_file}`} target="_blank" rel="noreferrer">
                              <img src={`/uploads/checklist-photos/${s.photo_file}`} alt="stage"
                                className="w-12 h-12 object-cover rounded border border-gray-200 hover:opacity-80" />
                            </a>
                          )}
                          {s.rejection_photo_file && (
                            <a href={`/uploads/rejection-photos/${s.rejection_photo_file}`} target="_blank" rel="noreferrer">
                              <img src={`/uploads/rejection-photos/${s.rejection_photo_file}`} alt="rejection"
                                className="w-12 h-12 object-cover rounded border border-red-200 hover:opacity-80" />
                            </a>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex justify-between items-center pt-1">
            <Link to={`/job-cards/${jc.id}`}
              className="text-sm text-brand-600 hover:underline flex items-center gap-1"
              onClick={onClose}>
              Open full checklist <ArrowRight size={13} />
            </Link>
            <button className="btn-secondary" onClick={onClose}>Close</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
