import { useEffect, useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import Modal from '../../components/ui/Modal';
import ImportModal from '../../components/ui/ImportModal';
import { Search, AlertTriangle, ClipboardList, Upload, Plus } from 'lucide-react';

export default function FinishedGoodsList() {
  const navigate  = useNavigate();
  const { user }  = useAuthStore();
  const [items, setItems]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');
  const [filterZero, setFilterZero] = useState(false);
  const [outwardModal, setOutwardModal] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  const load = () => {
    setLoading(true);
    api.get('/finished-goods')
      .then(r => setItems(r.data))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const outOfStock = useMemo(() => items.filter(i => (i.qty_available || 0) === 0).length, [items]);

  const filtered = useMemo(() => {
    let r = items;
    if (search) {
      const s = search.toLowerCase();
      r = r.filter(fg =>
        (fg.base_drawing_no || '').toLowerCase().includes(s) ||
        (fg.tube_material   || '').toLowerCase().includes(s) ||
        String(fg.wattage   || '').includes(s) ||
        String(fg.voltage   || '').includes(s)
      );
    }
    if (filterZero) r = r.filter(fg => fg.qty_available === 0);
    return r;
  }, [items, search, filterZero]);

  const canManage = ['accounts', 'owner', 'admin'].includes(user.role);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Finished Goods</h1>
          <p className="text-gray-500 text-sm mt-0.5">
            {items.length} products · {outOfStock} out of stock
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canManage && (
            <button
              className="btn-primary flex items-center gap-1.5 text-sm"
              onClick={() => setShowAdd(true)}>
              <Plus size={15} /> Add Finished Goods
            </button>
          )}
          {canManage && (
            <button
              className="btn-secondary flex items-center gap-1.5 text-sm"
              onClick={() => setShowImport(true)}>
              <Upload size={15} /> Import Excel
            </button>
          )}
          <Link to="/finished-goods/logs"
            className="btn-secondary flex items-center gap-1.5 text-sm">
            <ClipboardList size={15} /> Movement Log
          </Link>
        </div>
      </div>

      {/* Search + filter */}
      <div className="flex gap-3 mb-5">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-2.5 text-gray-400" />
          <input
            className="input pl-9"
            placeholder="Search drawing no, material, wattage..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <button
          className={`btn-sm ${filterZero ? 'btn-danger' : 'btn-secondary'}`}
          onClick={() => setFilterZero(f => !f)}>
          <AlertTriangle size={14} />
          {filterZero ? 'Show All' : `Out of Stock (${outOfStock})`}
        </button>
      </div>

      {/* Table — mirrors Inventory exactly */}
      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="table-header text-left">Item Code</th>
              <th className="table-header text-left">Specs</th>
              <th className="table-header text-left">Plating</th>
              <th className="table-header text-right">Total Inward</th>
              <th className="table-header text-right">Stock</th>
              <th className="table-header text-center">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={6} className="table-cell text-center text-gray-400 py-12">Loading...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={6} className="table-cell text-center text-gray-400 py-12">No finished goods yet</td></tr>
            ) : filtered.map(fg => {
              const isOut = fg.qty_available === 0;
              return (
                <tr
                  key={fg.id}
                  className="hover:bg-gray-50 cursor-pointer"
                  onClick={() => navigate(`/finished-goods/${fg.id}`)}>

                  {/* Item Code — matches inventory style */}
                  <td className="table-cell font-semibold text-brand-700">
                    {fg.base_drawing_no || fg.drawing_no || '—'}
                  </td>

                  {/* Specs — tube material + diameter + wattage + voltage */}
                  <td className="table-cell text-gray-700">
                    <div className="text-sm font-medium">
                      {[fg.tube_material,
                        fg.tube_diameter ? `⌀${fg.tube_diameter}mm` : null,
                        fg.wattage       ? `${fg.wattage}W`         : null,
                        fg.voltage       ? `${fg.voltage}V`         : null,
                      ].filter(Boolean).join(' · ') || '—'}
                    </div>
                    <div className="text-xs text-gray-400">
                      {fg.inward_batches ?? 0} batch{(fg.inward_batches ?? 0) !== 1 ? 'es' : ''} in
                    </div>
                  </td>

                  {/* Plating */}
                  <td className="table-cell text-sm text-gray-500">
                    {fg.plating_instructions || '—'}
                  </td>

                  {/* Total Inward */}
                  <td className="table-cell text-right text-gray-600 font-medium">
                    {fg.qty_in ?? 0} <span className="font-normal text-gray-400 text-xs">Nos</span>
                  </td>

                  {/* Available Stock */}
                  <td className={`table-cell text-right font-semibold ${isOut ? 'text-red-600' : 'text-gray-900'}`}>
                    {fg.qty_available ?? 0} <span className="font-normal text-gray-400 text-xs">Nos</span>
                  </td>

                  {/* Status — matches inventory */}
                  <td className="table-cell text-center">
                    {isOut ? (
                      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">
                        <AlertTriangle size={11} /> Out
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">
                        OK
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <AddFGModal
          onClose={() => setShowAdd(false)}
          onDone={() => { setShowAdd(false); load(); }}
        />
      )}

      {showImport && (
        <ImportModal
          type="finished-goods"
          onClose={() => setShowImport(false)}
          onDone={() => { setShowImport(false); load(); }}
        />
      )}

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

function AddFGModal({ onClose, onDone }) {
  const [code, setCode]         = useState('');
  const [material, setMaterial] = useState('');
  const [diameter, setDiameter] = useState('');
  const [wattage, setWattage]   = useState('');
  const [voltage, setVoltage]   = useState('');
  const [plating, setPlating]   = useState('');
  const [qty, setQty]           = useState('');
  const [notes, setNotes]       = useState('');
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!code.trim()) return setError('Item code is required');
    if (!qty || parseInt(qty) <= 0) return setError('Enter a valid quantity');
    setSaving(true);
    try {
      await api.post('/finished-goods', {
        base_drawing_no: code.trim(),
        tube_material: material || undefined,
        tube_diameter: diameter || undefined,
        wattage: wattage || undefined,
        voltage: voltage || undefined,
        plating_instructions: plating || undefined,
        qty: parseInt(qty),
        notes: notes || undefined,
      });
      onDone();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add');
      setSaving(false);
    }
  };

  return (
    <Modal open title="Add Finished Goods" onClose={onClose} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-xs text-gray-500 bg-blue-50 border border-blue-100 rounded-lg p-2">
          If an item with the same code already exists, the quantity will be added to the existing stock.
        </p>
        <div>
          <label className="label">Item Code / Drawing No *</label>
          <input className="input" placeholder="e.g. PT-STRAIGHT-20S-750W" value={code}
            onChange={e => setCode(e.target.value)} autoFocus />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Tube Material</label>
            <input className="input" placeholder="e.g. SS304" value={material} onChange={e => setMaterial(e.target.value)} />
          </div>
          <div>
            <label className="label">Tube Diameter (mm)</label>
            <input className="input" type="number" placeholder="e.g. 8.5" value={diameter} onChange={e => setDiameter(e.target.value)} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Wattage (W)</label>
            <input className="input" type="number" placeholder="e.g. 750" value={wattage} onChange={e => setWattage(e.target.value)} />
          </div>
          <div>
            <label className="label">Voltage (V)</label>
            <input className="input" type="number" placeholder="e.g. 230" value={voltage} onChange={e => setVoltage(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label">Plating Instructions</label>
          <input className="input" placeholder="e.g. Nickel plated" value={plating} onChange={e => setPlating(e.target.value)} />
        </div>
        <div>
          <label className="label">Quantity *</label>
          <input className="input" type="number" min="1" placeholder="e.g. 100" value={qty} onChange={e => setQty(e.target.value)} required />
        </div>
        <div>
          <label className="label">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
          <textarea className="input h-16 resize-none" placeholder="Any additional notes..." value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <div className="flex gap-3 pt-1">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving}>
            {saving ? 'Saving...' : 'Add Finished Goods'}
          </button>
        </div>
      </form>
    </Modal>
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
            {['dispatch','sampling'].map(t => (
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
