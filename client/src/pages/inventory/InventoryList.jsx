import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import Modal from '../../components/ui/Modal';
import ImportModal from '../../components/ui/ImportModal';
import CategorySelect from '../../components/CategorySelect';
import InventoryItemModal from '../../components/InventoryItemModal';
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
  const canManage = ['owner', 'admin'].includes(user.role);
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
          {['owner','admin','design'].includes(user.role) && (
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

      {showNew && <InventoryItemModal onClose={() => setShowNew(false)} onSave={() => { setShowNew(false); load(); }} />}
      {showImport && <ImportModal type="inventory" onClose={() => setShowImport(false)} onDone={() => load()} />}
    </div>
  );
}
