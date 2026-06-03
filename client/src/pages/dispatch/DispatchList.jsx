import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import Modal from '../../components/ui/Modal';
import FileUpload from '../../components/ui/FileUpload';
import StatusBadge from '../../components/ui/StatusBadge';
import { fmtDate, fmtDateTime, downloadExcel, PRODUCTION_STAGES } from '../../lib/utils';
import { Upload, Search, BarChart2, Download, X, CheckCircle, Circle, AlertTriangle, ArrowRight } from 'lucide-react';

// Route label helper
function routeLabel(route, dispQty, fgQty) {
  if (!route) return null;
  if (route === 'dispatch')        return `${dispQty ?? '—'} units → Dispatch`;
  if (route === 'finished_goods')  return `${fgQty ?? '—'} units → Finished Goods`;
  if (route === 'both')            return `${fgQty ?? '—'} → Finished Goods  +  ${dispQty ?? '—'} → Dispatch`;
  if (route === 'split')           return `${fgQty ?? '—'} → Finished Goods (IO)  +  ${dispQty ?? '—'} → Dispatch`;
  return route;
}

export default function DispatchList() {
  const { user } = useAuthStore();
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(null);   // job card object
  const [showSummary, setShowSummary] = useState(null); // job card object

  // Filters
  const [search, setSearch] = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [productFilter, setProductFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const load = () => api.get('/job-cards').then(r => {
    const relevant = r.data.filter(jc =>
      ['qc_approved','packaging','ready_for_dispatch','dispatched'].includes(jc.status)
    );
    setCards(relevant);
  }).finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  // Unique filter options
  const clientOptions = useMemo(() =>
    [...new Set(cards.map(jc => jc.customer_code).filter(Boolean))].sort(), [cards]);
  const productOptions = useMemo(() =>
    [...new Set(cards.map(jc => jc.product_name || jc.drawing_no).filter(Boolean))].sort(), [cards]);

  const filtered = useMemo(() => {
    let r = cards;
    if (search) {
      const s = search.toLowerCase();
      r = r.filter(jc =>
        jc.job_card_no.toLowerCase().includes(s) ||
        (jc.customer_code || '').toLowerCase().includes(s) ||
        (jc.drawing_no || '').toLowerCase().includes(s) ||
        (jc.product_name || '').toLowerCase().includes(s)
      );
    }
    if (clientFilter) r = r.filter(jc => jc.customer_code === clientFilter);
    if (productFilter) r = r.filter(jc =>
      (jc.product_name || jc.drawing_no) === productFilter
    );
    if (statusFilter) r = r.filter(jc => jc.status === statusFilter);
    return r;
  }, [cards, search, clientFilter, productFilter, statusFilter]);

  const hasFilters = search || clientFilter || productFilter || statusFilter;
  const clearFilters = () => {
    setSearch(''); setClientFilter(''); setProductFilter(''); setStatusFilter('');
  };

  const canManage = ['accounts', 'owner'].includes(user.role);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dispatch</h1>
          <p className="text-gray-500 text-sm mt-0.5">Job cards ready for or pending dispatch</p>
        </div>
        {canManage && (
          <button className="btn-secondary flex items-center gap-1.5 text-sm"
            onClick={() => downloadExcel('dispatch-checklist', 'dispatch_checklist.xlsx')}>
            <Download size={15} /> Export Checklist
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-5">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search size={16} className="absolute left-3 top-2.5 text-gray-400" />
          <input className="input pl-9" placeholder="Search job card, drawing, product..."
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="input max-w-[180px]" value={clientFilter}
          onChange={e => setClientFilter(e.target.value)}>
          <option value="">All Clients</option>
          {clientOptions.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="input max-w-[220px]" value={productFilter}
          onChange={e => setProductFilter(e.target.value)}>
          <option value="">All Products</option>
          {productOptions.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className="input max-w-[160px]" value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="qc_approved">QC Approved</option>
          <option value="packaging">Packaging</option>
          <option value="dispatched">Dispatched</option>
        </select>
        {hasFilters && (
          <button className="btn-ghost text-sm flex items-center gap-1 text-gray-500"
            onClick={clearFilters}>
            <X size={14} /> Clear
          </button>
        )}
      </div>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="table-header text-left">Job Card</th>
              <th className="table-header text-left">Customer</th>
              <th className="table-header text-left">Product / Drawing</th>
              <th className="table-header text-right">QC Approved Qty</th>
              <th className="table-header text-left">Dispatch Date</th>
              <th className="table-header text-left">Status</th>
              <th className="table-header text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={7} className="table-cell text-center text-gray-400 py-12">Loading...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={7} className="table-cell text-center text-gray-400 py-12">
                {hasFilters ? 'No results match your filters' : 'No jobs in dispatch pipeline yet'}
              </td></tr>
            ) : filtered.map(jc => {
              // Show QC-approved dispatch qty (not the pre-QC stage 29 value)
              const dispQty = jc.qc_dispatch_qty != null ? jc.qc_dispatch_qty : jc.net_qty;
              return (
                <tr key={jc.id} className="hover:bg-gray-50">
                  <td className="table-cell">
                    <Link to={`/job-cards/${jc.id}`}
                      className="font-semibold text-brand-700 hover:underline">
                      {jc.job_card_no}
                    </Link>
                  </td>
                  <td className="table-cell">{jc.customer_code}</td>
                  <td className="table-cell text-sm">
                    {jc.product_name && <div className="font-medium text-gray-800">{jc.product_name}</div>}
                    {jc.drawing_no && <div className="text-xs text-gray-400">{jc.drawing_no}</div>}
                  </td>
                  <td className="table-cell text-right">
                    {jc.status === 'dispatched' && jc.dispatched_qty
                      ? <span className="font-semibold text-gray-800">{jc.dispatched_qty}</span>
                      : dispQty != null && dispQty !== jc.qty
                        ? <span>
                            <span className="font-semibold text-orange-600">{dispQty}</span>
                            <span className="text-xs text-gray-400 ml-1">of {jc.qty}</span>
                          </span>
                        : <span className="font-semibold text-gray-800">{dispQty ?? jc.qty}</span>
                    }
                    {jc.qc_route && (
                      <div className="text-xs text-gray-400 mt-0.5">
                        {jc.qc_route === 'finished_goods' ? 'All → FG'
                         : jc.qc_route === 'both' || jc.qc_route === 'split'
                           ? `FG: ${jc.qc_fg_qty} + Dispatch: ${jc.qc_dispatch_qty}`
                           : 'All → Dispatch'}
                      </div>
                    )}
                  </td>
                  <td className="table-cell">{fmtDate(jc.dispatch_date)}</td>
                  <td className="table-cell"><StatusBadge status={jc.status} /></td>
                  <td className="table-cell text-right">
                    <div className="flex items-center justify-end gap-2">
                      {/* Summary button — always visible */}
                      <button
                        className="btn-secondary btn-sm flex items-center gap-1 text-xs py-1 px-2"
                        onClick={() => setShowSummary(jc)}
                        title="View checklist summary">
                        <BarChart2 size={13} /> Summary
                      </button>
                      {canManage && jc.status !== 'dispatched' && (
                        <button
                          className="btn-primary btn-sm flex items-center gap-1 text-xs py-1 px-2"
                          onClick={() => setShowUpload(jc)}>
                          <Upload size={13} /> Dispatch
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showUpload && (
        <DispatchDocModal
          jc={showUpload}
          onClose={() => setShowUpload(null)}
          onSave={() => { setShowUpload(null); load(); }} />
      )}

      {showSummary && (
        <ChecklistSummaryModal
          jc={showSummary}
          onClose={() => setShowSummary(null)} />
      )}
    </div>
  );
}

// ── Checklist Summary Modal ────────────────────────────────────────────────────
function ChecklistSummaryModal({ jc, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get(`/job-cards/${jc.id}/checklist`),
      api.get(`/qc/${jc.id}/reports`),
    ]).then(([cl, qcR]) => {
      setData({ checklist: cl.data, qcReports: qcR.data });
    }).finally(() => setLoading(false));
  }, [jc.id]);

  const stages = data?.checklist?.stages || [];
  const doneStages = stages.filter(s => s.done);
  const qcReport = data?.qcReports?.[0];

  const totalRejected = stages.reduce((a, s) => a + (parseInt(s.rejection_qty, 10) || 0), 0);
  const totalRemade   = stages.filter(s => s.stage_no !== 29)
                               .reduce((a, s) => a + (parseInt(s.remade_qty, 10) || 0), 0);

  return (
    <Modal open title={`Checklist Summary — ${jc.job_card_no}`} onClose={onClose} size="xl">
      {loading ? (
        <div className="py-12 text-center text-gray-400">Loading...</div>
      ) : (
        <div className="space-y-5">

          {/* ── Header Stats ── */}
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: 'Original Qty', value: jc.qty, color: 'text-gray-800' },
              { label: 'Total Rejected', value: totalRejected, color: totalRejected > 0 ? 'text-red-600' : 'text-gray-800' },
              { label: 'Remade', value: totalRemade, color: totalRemade > 0 ? 'text-amber-600' : 'text-gray-800' },
              { label: 'Net Qty', value: jc.net_qty ?? jc.qty, color: 'text-green-700' },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-gray-50 rounded-xl p-3 text-center border border-gray-100">
                <div className={`text-2xl font-bold ${color}`}>{value}</div>
                <div className="text-xs text-gray-500 mt-0.5">{label}</div>
              </div>
            ))}
          </div>

          {/* ── QC Routing ── */}
          {jc.qc_route && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-3 flex items-center gap-2">
              <CheckCircle size={16} className="text-green-600 flex-shrink-0" />
              <div>
                <span className="text-sm font-semibold text-green-800">QC Approved — </span>
                <span className="text-sm text-green-700">
                  {routeLabel(jc.qc_route, jc.qc_dispatch_qty, jc.qc_fg_qty)}
                </span>
              </div>
            </div>
          )}

          {/* ── QC Report Info ── */}
          {qcReport && (
            <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm space-y-1">
              <div className="font-semibold text-blue-800 flex items-center gap-1.5">
                QC Report
                <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                  qcReport.result === 'approved' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                }`}>{qcReport.result}</span>
              </div>
              {qcReport.observations && <div className="text-gray-600"><span className="font-medium">Observations:</span> {qcReport.observations}</div>}
              {qcReport.product_weight && <div className="text-gray-600"><span className="font-medium">Product Weight:</span> {qcReport.product_weight} kg</div>}
            </div>
          )}

          {/* ── Stage Progress ── */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-gray-700">Production Stages</h3>
              <span className="text-xs text-gray-500">{doneStages.length} / {stages.length} completed</span>
            </div>

            {/* Progress bar */}
            <div className="w-full bg-gray-100 rounded-full h-1.5 mb-3">
              <div
                className="bg-brand-600 h-1.5 rounded-full transition-all"
                style={{ width: `${stages.length ? (doneStages.length / stages.length) * 100 : 0}%` }}
              />
            </div>

            <div className="divide-y divide-gray-100 border border-gray-200 rounded-xl overflow-hidden">
              {stages.map(s => {
                const def = PRODUCTION_STAGES.find(p => p.no === s.stage_no);
                const hasRejection = (parseInt(s.rejection_qty, 10) || 0) > 0;
                const hasRemade    = (parseInt(s.remade_qty, 10) || 0) > 0;
                const hasPhoto     = s.photo_file || s.rejection_photo_file;
                return (
                  <div key={s.stage_no}
                    className={`flex items-start gap-3 px-3 py-2 text-sm ${
                      !s.done ? 'bg-gray-50 text-gray-400' : 'bg-white'
                    }`}>
                    {/* Status icon */}
                    <div className="flex-shrink-0 mt-0.5">
                      {s.done
                        ? <CheckCircle size={15} className="text-green-500" />
                        : <Circle size={15} className="text-gray-300" />
                      }
                    </div>

                    {/* Stage info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`font-medium ${s.done ? 'text-gray-800' : 'text-gray-400'}`}>
                          {s.stage_no}. {def?.name || `Stage ${s.stage_no}`}
                        </span>
                        {hasRejection && (
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
                      {/* Values + worker */}
                      <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-0.5">
                        {s.value1 && <span className="text-xs text-gray-500">{def?.fields?.[0]?.label || 'Value 1'}: <span className="text-gray-700">{s.value1}</span></span>}
                        {s.value2 && <span className="text-xs text-gray-500">{def?.fields?.[1]?.label || 'Value 2'}: <span className="text-gray-700">{s.value2}</span></span>}
                        {s.worker_name && <span className="text-xs text-gray-500">Worker: <span className="text-gray-700">{s.worker_name}</span></span>}
                        {s.done_at && <span className="text-xs text-gray-400">{fmtDateTime(s.done_at)}</span>}
                        {s.stage_no === 29 && s.dispatched_qty != null && (
                          <span className="text-xs text-gray-500">Ready Qty: <span className="font-semibold text-gray-700">{s.dispatched_qty}</span></span>
                        )}
                      </div>
                      {/* Photos row */}
                      {hasPhoto && (
                        <div className="flex gap-1.5 mt-1.5 flex-wrap">
                          {s.photo_file && (
                            <a href={`/uploads/${s.photo_file}`} target="_blank" rel="noreferrer">
                              <img src={`/uploads/${s.photo_file}`} alt="stage"
                                className="w-12 h-12 object-cover rounded border border-gray-200 hover:opacity-80 transition-opacity" />
                            </a>
                          )}
                          {s.rejection_photo_file && (
                            <a href={`/uploads/${s.rejection_photo_file}`} target="_blank" rel="noreferrer">
                              <img src={`/uploads/${s.rejection_photo_file}`} alt="rejection"
                                className="w-12 h-12 object-cover rounded border border-red-200 hover:opacity-80 transition-opacity" />
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

          {/* ── Footer link ── */}
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

// ── Dispatch Doc Modal ─────────────────────────────────────────────────────────
function DispatchDocModal({ jc, onClose, onSave }) {
  const [f, setF] = useState({
    doc_type: 'delivery_challan', shipping_carrier: '', tracking_number: '',
    dispatch_date: new Date().toISOString().split('T')[0], notes: ''
  });
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));

  // Show QC-approved dispatch qty
  const dispQty = jc.qc_dispatch_qty != null ? jc.qc_dispatch_qty : jc.net_qty ?? jc.qty;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!f.shipping_carrier.trim()) { setError('Shipping carrier is required'); return; }
    if (!f.tracking_number.trim())  { setError('Tracking number is required'); return; }
    setSaving(true);
    setError('');
    const fd = new FormData();
    fd.append('job_card_id', jc.id);
    Object.entries(f).forEach(([k, v]) => fd.append(k, v));
    if (file) fd.append('file', file);
    try {
      await api.post('/dispatch', fd);
      await api.put(`/dispatch/${jc.id}/mark-dispatched`);
      onSave();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed');
      setSaving(false);
    }
  };

  return (
    <Modal open title={`Dispatch — ${jc.job_card_no}`} onClose={onClose}>
      <div className="mb-4 bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 text-sm">
        <span className="text-blue-700 font-medium">QC-approved dispatch qty: </span>
        <span className="font-bold text-blue-900">{dispQty}</span>
        {jc.qc_route && (
          <span className="text-blue-600 ml-2">({routeLabel(jc.qc_route, jc.qc_dispatch_qty, jc.qc_fg_qty)})</span>
        )}
      </div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">Document Type</label>
          <select className="input" value={f.doc_type} onChange={set('doc_type')}>
            <option value="invoice">Invoice</option>
            <option value="packing_list">Packing List</option>
            <option value="delivery_challan">Delivery Challan</option>
            <option value="eway_bill">E-Way Bill</option>
            <option value="other">Other</option>
          </select>
        </div>
        <FileUpload onFile={setFile} accept=".pdf,.jpg,.jpeg,.png" label="Select document (optional)" />
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Shipping Carrier <span className="text-red-500">*</span></label>
            <input className="input" placeholder="e.g. DTDC" value={f.shipping_carrier} onChange={set('shipping_carrier')} />
          </div>
          <div>
            <label className="label">Tracking No <span className="text-red-500">*</span></label>
            <input className="input" value={f.tracking_number} onChange={set('tracking_number')} />
          </div>
          <div>
            <label className="label">Dispatch Date</label>
            <input className="input" type="date" value={f.dispatch_date} onChange={set('dispatch_date')} />
          </div>
          <div>
            <label className="label">Notes</label>
            <input className="input" value={f.notes} onChange={set('notes')} />
          </div>
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <div className="flex gap-3">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving}>
            {saving ? 'Dispatching...' : 'Upload & Mark Dispatched'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
