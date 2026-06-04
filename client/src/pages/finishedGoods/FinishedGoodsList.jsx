import { useEffect, useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../../lib/api';
import { Package, TrendingDown, Search, Eye, ArrowUpCircle, ArrowDownCircle, ClipboardList, X } from 'lucide-react';
import Modal from '../../components/ui/Modal';

export default function FinishedGoodsList() {
  const navigate = useNavigate();
  const [items, setItems]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');
  const [outwardModal, setOutwardModal] = useState(null);

  const load = () => {
    setLoading(true);
    api.get('/finished-goods').then(r => { setItems(r.data); setLoading(false); });
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    if (!search) return items;
    const s = search.toLowerCase();
    return items.filter(fg =>
      (fg.base_drawing_no || '').toLowerCase().includes(s) ||
      (fg.drawing_no || '').toLowerCase().includes(s) ||
      (fg.tube_material || '').toLowerCase().includes(s) ||
      String(fg.wattage || '').includes(s) ||
      String(fg.voltage || '').includes(s)
    );
  }, [items, search]);

  const totalIn    = items.reduce((s, i) => s + (i.qty_in || 0), 0);
  const totalAvail = items.reduce((s, i) => s + (i.qty_available || 0), 0);
  const lowStock   = items.filter(i => (i.qty_available || 0) === 0).length;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Finished Goods</h1>
          <p className="text-sm text-gray-500 mt-0.5">Stock of completed production items — one entry per product</p>
        </div>
        <Link to="/finished-goods/logs" className="btn-secondary flex items-center gap-1.5 text-sm">
          <ClipboardList size={15} /> Movement Log
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'Products', value: items.length, icon: Package, bg: 'bg-amber-50', icon_color: 'text-amber-600' },
          { label: 'Total Inward', value: totalIn, icon: ArrowDownCircle, bg: 'bg-green-50', icon_color: 'text-green-600' },
          { label: 'Available Stock', value: totalAvail, icon: TrendingDown, bg: 'bg-blue-50', icon_color: 'text-blue-600' },
          { label: 'Out of Stock', value: lowStock, icon: X, bg: 'bg-red-50', icon_color: 'text-red-500' },
        ].map(({ label, value, icon: Icon, bg, icon_color }) => (
          <div key={label} className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-3">
            <div className={`w-10 h-10 ${bg} rounded-lg flex items-center justify-center flex-shrink-0`}>
              <Icon size={20} className={icon_color} />
            </div>
            <div>
              <p className="text-xs text-gray-500">{label}</p>
              <p className="text-xl font-bold text-gray-900">{value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          className="input pl-9 text-sm"
          placeholder="Search drawing no, material, wattage..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="table-header text-left">Product (Base Drawing No.)</th>
              <th className="table-header text-left">Tube Material</th>
              <th className="table-header text-right">Wattage</th>
              <th className="table-header text-right">Voltage</th>
              <th className="table-header text-left">Plating</th>
              <th className="table-header text-center">Batches In</th>
              <th className="table-header text-center">Total Inward</th>
              <th className="table-header text-center">Available</th>
              <th className="table-header" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={9} className="table-cell text-center text-gray-400 py-12">Loading...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={9} className="table-cell text-center text-gray-400 py-12">No finished goods yet</td></tr>
            ) : filtered.map(fg => (
              <tr key={fg.id} className="hover:bg-gray-50">
                <td className="table-cell">
                  <div className="font-semibold text-brand-700">{fg.base_drawing_no || fg.drawing_no || '—'}</div>
                  {fg.tube_diameter && (
                    <div className="text-xs text-gray-400">⌀ {fg.tube_diameter} mm</div>
                  )}
                </td>
                <td className="table-cell text-sm text-gray-700">{fg.tube_material || '—'}</td>
                <td className="table-cell text-right text-sm">{fg.wattage ? `${fg.wattage} W` : '—'}</td>
                <td className="table-cell text-right text-sm">{fg.voltage ? `${fg.voltage} V` : '—'}</td>
                <td className="table-cell text-sm text-gray-600 max-w-[140px] truncate" title={fg.plating_instructions}>
                  {fg.plating_instructions || '—'}
                </td>
                <td className="table-cell text-center">
                  <span className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full font-medium">
                    {fg.inward_batches ?? 0}
                  </span>
                </td>
                <td className="table-cell text-center">
                  <span className="text-sm font-medium text-gray-800">{fg.qty_in}</span>
                </td>
                <td className="table-cell text-center">
                  <span className={`text-sm font-bold px-2 py-0.5 rounded-full ${
                    fg.qty_available === 0
                      ? 'bg-red-100 text-red-600'
                      : fg.qty_available <= 5
                        ? 'bg-amber-100 text-amber-700'
                        : 'bg-green-100 text-green-700'
                  }`}>
                    {fg.qty_available}
                  </span>
                </td>
                <td className="table-cell">
                  <div className="flex items-center gap-1 justify-end">
                    <button
                      onClick={() => navigate(`/finished-goods/${fg.id}`)}
                      className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 hover:text-brand-600 transition-colors"
                      title="View details & movement log"
                    >
                      <Eye size={15} />
                    </button>
                    {fg.qty_available > 0 && (
                      <button
                        onClick={() => setOutwardModal(fg)}
                        className="p-1.5 rounded-lg hover:bg-red-50 text-gray-500 hover:text-red-600 transition-colors"
                        title="Record outward (dispatch / sampling)"
                      >
                        <ArrowUpCircle size={15} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {outwardModal && (
        <OutwardModal
          fg={outwardModal}
          onClose={() => setOutwardModal(null)}
          onDone={() => { setOutwardModal(null); load(); }}
        />
      )}
    </div>
  );
}

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

  useEffect(() => {
    api.get('/customers').then(r => setCustomers(r.data)).catch(() => {});
  }, []);

  const selectedCustomer = customers.find(c => String(c.id) === String(customerId));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!qty || parseInt(qty) <= 0) return setError('Enter a valid quantity');
    if (!customerId) return setError('Select a client');
    if (outwardType === 'sampling' && !reason.trim()) return setError('Reason is required for sampling');
    setSaving(true);
    try {
      await api.post(`/finished-goods/${fg.id}/outward`, {
        qty: parseInt(qty),
        outward_type: outwardType,
        client_code: selectedCustomer?.customer_code || '',
        client_name: selectedCustomer?.name || '',
        reason: outwardType === 'sampling' ? reason : undefined,
        reference,
        notes,
      });
      onDone();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to record outward');
      setSaving(false);
    }
  };

  return (
    <Modal open title="Record Outward" onClose={onClose} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="bg-gray-50 rounded-xl p-3 text-sm">
          <p className="font-bold text-gray-900">{fg.base_drawing_no || fg.drawing_no}</p>
          <p className="text-gray-500 text-xs mt-0.5">
            {[fg.tube_material, fg.wattage ? `${fg.wattage}W` : null, fg.voltage ? `${fg.voltage}V` : null]
              .filter(Boolean).join(' · ')}
          </p>
          <p className="text-green-600 font-semibold mt-1">{fg.qty_available} units available</p>
        </div>

        <div>
          <label className="label">Outward Type <span className="text-red-500">*</span></label>
          <div className="flex gap-3">
            {['dispatch', 'sampling'].map(t => (
              <button key={t} type="button"
                onClick={() => setOutwardType(t)}
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
          <label className="label">Client <span className="text-red-500">*</span></label>
          <select className="input" value={customerId} onChange={e => setCustomerId(e.target.value)} required>
            <option value="">— Select customer —</option>
            {customers.map(c => (
              <option key={c.id} value={c.id}>{c.customer_code} · {c.name}</option>
            ))}
          </select>
        </div>

        {outwardType === 'sampling' && (
          <div>
            <label className="label">Sampling Reason <span className="text-red-500">*</span></label>
            <input className="input" placeholder="e.g. New product trial, quality test..." value={reason} onChange={e => setReason(e.target.value)} />
          </div>
        )}

        <div>
          <label className="label">Quantity <span className="text-red-500">*</span></label>
          <input className="input" type="number" min="1" max={fg.qty_available} value={qty} onChange={e => setQty(e.target.value)} required />
        </div>
        <div>
          <label className="label">Reference <span className="text-gray-400 font-normal">(optional)</span></label>
          <input className="input" placeholder="e.g. Dispatch note, order ref..." value={reference} onChange={e => setRef(e.target.value)} />
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
