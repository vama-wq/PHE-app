import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import Modal from '../../components/ui/Modal';
import FileUpload from '../../components/ui/FileUpload';
import StatusBadge from '../../components/ui/StatusBadge';
import { fmtDate, downloadExcel } from '../../lib/utils';
import { Upload, Search, ClipboardList, Download, X } from 'lucide-react';

export default function DispatchList() {
  const { user } = useAuthStore();
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(null); // job card id

  // Filters
  const [search, setSearch] = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [productFilter, setProductFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const load = () => api.get('/job-cards').then(r => {
    const relevant = r.data.filter(jc => ['qc_approved','packaging','ready_for_dispatch','dispatched'].includes(jc.status));
    setCards(relevant);
  }).finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  // Derive unique clients and products from loaded cards
  const clientOptions = useMemo(() => [...new Set(cards.map(jc => jc.customer_code).filter(Boolean))].sort(), [cards]);
  const productOptions = useMemo(() => [...new Set(cards.map(jc => jc.product_name || jc.drawing_no).filter(Boolean))].sort(), [cards]);

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
    if (productFilter) r = r.filter(jc => (jc.product_name || jc.drawing_no) === productFilter);
    if (statusFilter) r = r.filter(jc => jc.status === statusFilter);
    return r;
  }, [cards, search, clientFilter, productFilter, statusFilter]);

  const hasFilters = search || clientFilter || productFilter || statusFilter;
  const clearFilters = () => { setSearch(''); setClientFilter(''); setProductFilter(''); setStatusFilter(''); };

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
          <input className="input pl-9" placeholder="Search job card, drawing, product..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="input max-w-[180px]" value={clientFilter} onChange={e => setClientFilter(e.target.value)}>
          <option value="">All Clients</option>
          {clientOptions.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="input max-w-[220px]" value={productFilter} onChange={e => setProductFilter(e.target.value)}>
          <option value="">All Products</option>
          {productOptions.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className="input max-w-[160px]" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="qc_approved">QC Approved</option>
          <option value="packaging">Packaging</option>
          <option value="dispatched">Dispatched</option>
        </select>
        {hasFilters && (
          <button className="btn-ghost text-sm flex items-center gap-1 text-gray-500" onClick={clearFilters}>
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
              <th className="table-header text-right">Qty</th>
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
            ) : filtered.map(jc => (
              <tr key={jc.id} className="hover:bg-gray-50">
                <td className="table-cell">
                  <Link to={`/job-cards/${jc.id}`} className="font-semibold text-brand-700 hover:underline">{jc.job_card_no}</Link>
                </td>
                <td className="table-cell">{jc.customer_code}</td>
                <td className="table-cell text-gray-600 text-sm">
                  {jc.product_name && <div className="font-medium text-gray-800">{jc.product_name}</div>}
                  {jc.drawing_no && <div className="text-xs text-gray-400">{jc.drawing_no}</div>}
                </td>
                <td className="table-cell text-right">
                  {jc.status === 'dispatched' && jc.dispatched_qty
                    ? <span className="font-semibold text-gray-800">{jc.dispatched_qty}</span>
                    : jc.net_qty != null && jc.net_qty !== jc.qty
                      ? <span><span className="font-semibold text-orange-600">{jc.net_qty}</span> <span className="text-xs text-gray-400">of {jc.qty}</span></span>
                      : <span className="font-semibold text-gray-800">{jc.qty}</span>
                  }
                </td>
                <td className="table-cell">{fmtDate(jc.dispatch_date)}</td>
                <td className="table-cell"><StatusBadge status={jc.status} /></td>
                <td className="table-cell text-right">
                  <div className="flex items-center justify-end gap-2">
                    <Link to={`/job-cards/${jc.id}`}
                      className="btn-secondary btn-sm flex items-center gap-1 text-xs py-1 px-2">
                      <ClipboardList size={13} /> Checklist
                    </Link>
                    {canManage && jc.status !== 'dispatched' && (
                      <button className="btn-secondary btn-sm flex items-center gap-1 text-xs py-1 px-2"
                        onClick={() => setShowUpload(jc.id)}>
                        <Upload size={13} /> Dispatch
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showUpload && (
        <DispatchDocModal jcId={showUpload}
          onClose={() => setShowUpload(null)}
          onSave={() => { setShowUpload(null); load(); }} />
      )}
    </div>
  );
}

function DispatchDocModal({ jcId, onClose, onSave }) {
  const [f, setF] = useState({ doc_type: 'delivery_challan', shipping_carrier: '', tracking_number: '', dispatch_date: new Date().toISOString().split('T')[0], notes: '' });
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!f.shipping_carrier.trim()) { setError('Shipping carrier is required'); return; }
    if (!f.tracking_number.trim()) { setError('Tracking number is required'); return; }
    setSaving(true);
    setError('');
    const fd = new FormData();
    fd.append('job_card_id', jcId);
    Object.entries(f).forEach(([k, v]) => fd.append(k, v));
    if (file) fd.append('file', file);
    try {
      await api.post('/dispatch', fd);
      await api.put(`/dispatch/${jcId}/mark-dispatched`);
      onSave();
    }
    catch (err) { setError(err.response?.data?.error || 'Failed'); setSaving(false); }
  };

  return (
    <Modal open title="Upload Dispatch Document" onClose={onClose}>
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
          <div><label className="label">Shipping Carrier <span className="text-red-500">*</span></label><input className="input" placeholder="e.g. DTDC" value={f.shipping_carrier} onChange={set('shipping_carrier')} required /></div>
          <div><label className="label">Tracking No <span className="text-red-500">*</span></label><input className="input" value={f.tracking_number} onChange={set('tracking_number')} required /></div>
          <div><label className="label">Dispatch Date</label><input className="input" type="date" value={f.dispatch_date} onChange={set('dispatch_date')} /></div>
          <div><label className="label">Notes</label><input className="input" value={f.notes} onChange={set('notes')} /></div>
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <div className="flex gap-3">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving}>{saving ? 'Uploading...' : 'Upload & Dispatch'}</button>
        </div>
      </form>
    </Modal>
  );
}
