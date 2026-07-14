import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import Modal from '../../components/ui/Modal';
import ImportModal from '../../components/ui/ImportModal';
import { downloadExcel } from '../../lib/utils';
import { Plus, Search, AlertTriangle, Download, Upload, X } from 'lucide-react';

export default function InventoryList() {
  const { user } = useAuthStore();
  const [items, setItems] = useState([]);
  const [filtered, setFiltered] = useState([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [stockStatus, setStockStatus] = useState('all'); // all | in | low | out
  const [sortBy, setSortBy] = useState('code'); // code | name | stock_asc | value_desc
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const navigate = useNavigate();

  const copyGujarati = (e, item) => {
    e.stopPropagation();
    navigator.clipboard.writeText(`${item.item_code} — ${item.name_gu}`).then(() => {
      setCopiedId(item.id);
      setTimeout(() => setCopiedId(c => (c === item.id ? null : c)), 1200);
    }).catch(() => {});
  };

  const load = () => api.get('/inventory?include_pending=1').then(r => { setItems(r.data); setFiltered(r.data); }).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    let r = items;
    if (search) r = r.filter(i => i.item_code.toLowerCase().includes(search.toLowerCase()) || i.name.toLowerCase().includes(search.toLowerCase()) || i.category?.toLowerCase().includes(search.toLowerCase()));
    if (category !== 'all') r = r.filter(i => (i.category || '') === category);
    if (stockStatus === 'in')  r = r.filter(i => i.current_stock > i.reorder_level);
    if (stockStatus === 'low') r = r.filter(i => i.current_stock <= i.reorder_level && i.current_stock > 0);
    if (stockStatus === 'out') r = r.filter(i => i.current_stock <= 0);
    r = [...r].sort((a, b) => {
      if (sortBy === 'name')       return (a.name || '').localeCompare(b.name || '');
      if (sortBy === 'stock_asc')  return Number(a.current_stock) - Number(b.current_stock);
      if (sortBy === 'value_desc') return (Number(b.current_stock) * (Number(b.unit_cost) || 0)) - (Number(a.current_stock) * (Number(a.unit_cost) || 0));
      return (a.item_code || '').localeCompare(b.item_code || ''); // 'code'
    });
    setFiltered(r);
  }, [items, search, category, stockStatus, sortBy]);

  const lowCount = items.filter(i => i.current_stock <= i.reorder_level).length;
  const canManage = ['accounts', 'owner', 'admin'].includes(user.role);
  const showCost = user.role !== 'design'; // landed cost / valuation hidden from QC
  const totalValue = items.reduce((s, i) => s + Number(i.current_stock) * (Number(i.unit_cost) || 0), 0);
  const categories = [...new Set(items.map(i => i.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const filtersActive = search || category !== 'all' || stockStatus !== 'all' || sortBy !== 'code';
  const resetFilters = () => { setSearch(''); setCategory('all'); setStockStatus('all'); setSortBy('code'); };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Inventory</h1>
          <p className="text-gray-500 text-sm mt-0.5">
            {items.length} items · {lowCount} low stock
            {showCost && totalValue > 0 && <> · Total Value <span className="font-semibold text-gray-700">₹{totalValue.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {['accounts','owner','admin','design'].includes(user.role) && (
            <button className="btn-secondary flex items-center gap-1.5 text-sm"
              onClick={() => downloadExcel('inventory', 'inventory.xlsx')}>
              <Download size={15} /> Export Excel
            </button>
          )}
          {canManage && (
            <>
              <button className="btn-secondary flex items-center gap-1.5 text-sm" onClick={() => setShowImport(true)}>
                <Upload size={15} /> Import Excel
              </button>
              <button className="btn-primary" onClick={() => setShowNew(true)}><Plus size={16} /> Add Item</button>
            </>
          )}
        </div>
      </div>

      <div className="flex gap-2 mb-5 flex-wrap items-center">
        <div className="relative flex-1 min-w-[14rem] max-w-sm">
          <Search size={16} className="absolute left-3 top-2.5 text-gray-400" />
          <input className="input pl-9" placeholder="Search code, name, category..." value={search}
            onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="input w-auto text-sm" value={category} onChange={e => setCategory(e.target.value)}>
          <option value="all">All categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="input w-auto text-sm" value={stockStatus} onChange={e => setStockStatus(e.target.value)}>
          <option value="all">All stock</option>
          <option value="in">In stock</option>
          <option value="low">Low stock ({lowCount})</option>
          <option value="out">Out of stock</option>
        </select>
        <select className="input w-auto text-sm" value={sortBy} onChange={e => setSortBy(e.target.value)}>
          <option value="code">Sort: Code</option>
          <option value="name">Sort: Name</option>
          <option value="stock_asc">Sort: Stock (low → high)</option>
          {showCost && <option value="value_desc">Sort: Value (high → low)</option>}
        </select>
        {filtersActive && (
          <button className="btn-sm btn-secondary flex items-center gap-1" onClick={resetFilters}>
            <X size={14} /> Clear
          </button>
        )}
        <span className="text-xs text-gray-400 ml-auto">{filtered.length} of {items.length}</span>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="table-header text-left">Item Code</th>
              <th className="table-header text-left">Name</th>
              <th className="table-header text-left">Category</th>
              <th className="table-header text-right">Stock</th>
              <th className="table-header text-right">Reorder Level</th>
              {showCost && <th className="table-header text-right">Landed Cost</th>}
              {showCost && <th className="table-header text-right">Value</th>}
              <th className="table-header text-center">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={showCost ? 8 : 6} className="table-cell text-center text-gray-400 py-12">Loading...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={showCost ? 8 : 6} className="table-cell text-center text-gray-400 py-12">No items found</td></tr>
            ) : filtered.map(item => {
              const isLow = item.current_stock <= item.reorder_level;
              return (
                <tr key={item.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => navigate(`/inventory/${item.id}`)}>
                  <td className="table-cell font-semibold text-brand-700">{item.item_code}</td>
                  <td className="table-cell">
                    {item.name}
                    {item.name_gu && (
                      <button
                        className={`ml-1.5 text-[10px] font-bold px-1 py-0.5 rounded align-middle transition-colors ${
                          copiedId === item.id ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500 hover:bg-brand-100 hover:text-brand-700'
                        }`}
                        title={`${item.name_gu} — ક્લિક કરી કૉપિ કરો`}
                        onClick={e => copyGujarati(e, item)}
                      >
                        {copiedId === item.id ? '✓' : 'ગુ'}
                      </button>
                    )}
                  </td>
                  <td className="table-cell text-gray-500">{item.category || '—'}</td>
                  <td className={`table-cell text-right font-semibold ${isLow ? 'text-red-600' : 'text-gray-900'}`}>
                    {item.current_stock} <span className="font-normal text-gray-400">{item.unit}</span>
                  </td>
                  <td className="table-cell text-right text-gray-500">{item.reorder_level} {item.unit}</td>
                  {showCost && <td className="table-cell text-right text-gray-700">{Number(item.unit_cost) > 0 ? `₹${Number(item.unit_cost).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—'}</td>}
                  {showCost && <td className="table-cell text-right text-gray-700">{Number(item.unit_cost) > 0 ? `₹${(Number(item.current_stock) * Number(item.unit_cost)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}</td>}
                  <td className="table-cell text-center">
                    {item.approval_status === 'pending_approval' ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">Pending Approval</span>
                        {user.role === 'owner' && (
                          <>
                            <button className="text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-700 font-semibold hover:bg-green-200"
                              title="Approve item"
                              onClick={async (e) => {
                                e.stopPropagation();
                                try { await api.put(`/inventory/${item.id}/approve`); load(); }
                                catch (err) { alert(err.response?.data?.error || 'Failed'); }
                              }}>✓</button>
                            <button className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-semibold hover:bg-red-200"
                              title="Reject & remove item"
                              onClick={async (e) => {
                                e.stopPropagation();
                                if (!window.confirm(`Reject and remove "${item.name}"?`)) return;
                                try { await api.put(`/inventory/${item.id}/reject`); load(); }
                                catch (err) { alert(err.response?.data?.error || 'Failed'); }
                              }}>✕</button>
                          </>
                        )}
                      </span>
                    ) : isLow ? (
                      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">
                        <AlertTriangle size={11} /> Low
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">OK</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showNew && <NewItemModal onClose={() => setShowNew(false)} onSave={() => { setShowNew(false); load(); }} />}
      {showImport && <ImportModal type="inventory" onClose={() => setShowImport(false)} onDone={() => load()} />}
    </div>
  );
}

function NewItemModal({ onClose, onSave }) {
  const { user } = useAuthStore();
  const [f, setF] = useState({ item_code: '', name: '', name_gu: '', category: '', unit: '', current_stock: 0, reorder_level: 0, min_order_qty: 0, unit_cost: '', notes: '' });
  const [drawing, setDrawing] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      // Use FormData to support optional drawing upload
      const fd = new FormData();
      Object.entries(f).forEach(([k, v]) => fd.append(k, v));
      if (drawing) fd.append('drawing', drawing);
      await api.post('/inventory', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      onSave();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed');
      setSaving(false);
    }
  };

  return (
    <Modal open title="Add Inventory Item" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div><label className="label">Item Code *</label><input className="input" placeholder="e.g. WR-26SWG" value={f.item_code} onChange={set('item_code')} required /></div>
          <div><label className="label">Unit *</label><input className="input" placeholder="e.g. kg, mtr, nos" value={f.unit} onChange={set('unit')} required /></div>
          <div className="col-span-2"><label className="label">Name *</label><input className="input" placeholder="e.g. Resistance Wire 26 SWG" value={f.name} onChange={set('name')} required /></div>
          <div className="col-span-2"><label className="label">Name (ગુજરાતી) <span className="font-normal normal-case text-gray-400">(optional — shown on copy & export)</span></label><input className="input" placeholder="દા.ત. રેઝિસ્ટન્સ વાયર 26 SWG" value={f.name_gu} onChange={set('name_gu')} /></div>
          <div><label className="label">Category</label><input className="input" placeholder="e.g. Wire, Tube, Terminal" value={f.category} onChange={set('category')} /></div>
          <div><label className="label">Opening Stock</label><input className="input" type="number" step="any" value={f.current_stock} onChange={set('current_stock')} /></div>
          <div><label className="label">Reorder Level</label><input className="input" type="number" step="any" value={f.reorder_level} onChange={set('reorder_level')} /></div>
          <div><label className="label">Min Order Qty</label><input className="input" type="number" step="any" min="0" placeholder="e.g. 100" value={f.min_order_qty} onChange={set('min_order_qty')} /></div>
          <div><label className="label">Unit Price (₹)</label><input className="input" type="number" step="any" min="0" placeholder="e.g. 12.50" value={f.unit_cost} onChange={set('unit_cost')} /></div>
          <div><label className="label">Notes</label><input className="input" value={f.notes} onChange={set('notes')} /></div>
          <div className="col-span-2">
            <label className="label">Item Drawing <span className="font-normal normal-case text-gray-400">(PDF or image, optional)</span></label>
            <label className="flex items-center gap-2 cursor-pointer border border-gray-200 rounded-lg px-3 py-2 hover:border-brand-400 transition-colors bg-gray-50">
              <Upload size={15} className="text-gray-400 flex-shrink-0" />
              <span className="text-sm text-gray-600 flex-1 truncate">
                {drawing ? drawing.name : 'Click to attach drawing...'}
              </span>
              <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" className="hidden"
                onChange={e => setDrawing(e.target.files[0] || null)} />
            </label>
          </div>
        </div>
        {user.role !== 'owner' && (
          <p className="text-amber-700 text-sm bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
            The item will be sent to the owner for approval — it becomes usable in orders and purchases once approved.
          </p>
        )}
        {error && <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
        <div className="flex gap-3 pt-2">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving}>{saving ? 'Saving...' : 'Add Item'}</button>
        </div>
      </form>
    </Modal>
  );
}
