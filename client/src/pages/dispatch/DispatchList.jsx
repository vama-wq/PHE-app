import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import Modal from '../../components/ui/Modal';
import FileUpload from '../../components/ui/FileUpload';
import StatusBadge from '../../components/ui/StatusBadge';
import { fmtDate } from '../../lib/utils';
import { Upload, Search } from 'lucide-react';

export default function DispatchList() {
  const { user } = useAuthStore();
  const [cards, setCards] = useState([]);
  const [filtered, setFiltered] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(null); // job card id
  const navigate = useNavigate();

  const load = () => api.get('/job-cards').then(r => {
    const relevant = r.data.filter(jc => ['qc_approved','packaging','ready_for_dispatch','dispatched'].includes(jc.status));
    setCards(relevant);
    setFiltered(relevant);
  }).finally(() => setLoading(false));

  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!search) return setFiltered(cards);
    setFiltered(cards.filter(jc => jc.job_card_no.toLowerCase().includes(search.toLowerCase()) || jc.customer_code.toLowerCase().includes(search.toLowerCase())));
  }, [cards, search]);

  const canManage = ['accounts', 'owner'].includes(user.role);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Dispatch</h1>
        <p className="text-gray-500 text-sm mt-0.5">Job cards ready for or pending dispatch</p>
      </div>

      <div className="relative max-w-sm mb-5">
        <Search size={16} className="absolute left-3 top-2.5 text-gray-400" />
        <input className="input pl-9" placeholder="Search job card, customer..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="table-header text-left">Job Card</th>
              <th className="table-header text-left">Customer</th>
              <th className="table-header text-left">Product</th>
              <th className="table-header text-right">Qty</th>
              <th className="table-header text-left">Dispatch Date</th>
              <th className="table-header text-left">Status</th>
              {canManage && <th className="table-header" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={7} className="table-cell text-center text-gray-400 py-12">Loading...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={7} className="table-cell text-center text-gray-400 py-12">No jobs in dispatch pipeline yet</td></tr>
            ) : filtered.map(jc => (
              <tr key={jc.id} className="hover:bg-gray-50">
                <td className="table-cell">
                  <Link to={`/job-cards/${jc.id}`} className="font-semibold text-brand-700 hover:underline">{jc.job_card_no}</Link>
                </td>
                <td className="table-cell">{jc.customer_code}</td>
                <td className="table-cell text-gray-600">{jc.product_code}</td>
                <td className="table-cell text-right">{jc.qty}</td>
                <td className="table-cell">{fmtDate(jc.dispatch_date)}</td>
                <td className="table-cell"><StatusBadge status={jc.status} /></td>
                {canManage && (
                  <td className="table-cell text-right">
                    <button className="btn-secondary btn-sm" onClick={() => setShowUpload(jc.id)}>
                      <Upload size={13} /> Upload Doc
                    </button>
                  </td>
                )}
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
    setSaving(true);
    const fd = new FormData();
    fd.append('job_card_id', jcId);
    Object.entries(f).forEach(([k, v]) => fd.append(k, v));
    if (file) fd.append('file', file);
    try { await api.post('/dispatch', fd); onSave(); }
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
          <div><label className="label">Shipping Carrier</label><input className="input" placeholder="e.g. DTDC" value={f.shipping_carrier} onChange={set('shipping_carrier')} /></div>
          <div><label className="label">Tracking No</label><input className="input" value={f.tracking_number} onChange={set('tracking_number')} /></div>
          <div><label className="label">Dispatch Date</label><input className="input" type="date" value={f.dispatch_date} onChange={set('dispatch_date')} /></div>
          <div><label className="label">Notes</label><input className="input" value={f.notes} onChange={set('notes')} /></div>
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <div className="flex gap-3">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving}>{saving ? 'Uploading...' : 'Upload'}</button>
        </div>
      </form>
    </Modal>
  );
}
