import { useEffect, useState } from 'react';
import api from '../../lib/api';
import Modal from '../../components/ui/Modal';
import ImportModal from '../../components/ui/ImportModal';
import SupplierModal from '../../components/SupplierModal';
import { Plus, Search, Phone, Mail, MapPin, Building2, Pencil, Trash2, Upload, AlertTriangle, Package, X } from 'lucide-react';

export default function SupplierList() {
  const [suppliers, setSuppliers] = useState([]);
  const [filtered, setFiltered] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [showImport, setShowImport] = useState(false);

  const load = () => api.get('/suppliers').then(r => { setSuppliers(r.data); setFiltered(r.data); }).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!search) return setFiltered(suppliers);
    const q = search.toLowerCase();
    setFiltered(suppliers.filter(s => s.name.toLowerCase().includes(q) || s.contact_person?.toLowerCase().includes(q) || s.supplier_code?.toLowerCase().includes(q)));
  }, [suppliers, search]);

  const handleDelete = async (s) => {
    if (!window.confirm(`Delete supplier "${s.name}"?`)) return;
    try {
      await api.delete(`/suppliers/${s.id}`);
      load();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to delete');
    }
  };

  const noItemsCount = suppliers.filter(s => !s.item_count || s.item_count === 0).length;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="page-title">Suppliers</h1>
          <p className="text-gray-500 text-sm mt-0.5">
            {suppliers.length} suppliers
            {noItemsCount > 0 && (
              <span className="text-amber-600 ml-2 font-medium">{noItemsCount} without items linked</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-secondary flex items-center gap-1.5 text-sm" onClick={() => setShowImport(true)}>
            <Upload size={15} /> Import Excel
          </button>
          <button className="btn-primary" onClick={() => setModal('new')}>
            <Plus size={16} /> Add Supplier
          </button>
        </div>
      </div>

      <div className="relative max-w-sm mb-5">
        <Search size={16} className="absolute left-3 top-2.5 text-gray-400" />
        <input className="input pl-9" placeholder="Search suppliers..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {loading ? (
          <div className="col-span-3 text-center text-gray-400 py-12">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="col-span-3 text-center text-gray-400 py-12">No suppliers found</div>
        ) : filtered.map(s => (
          <div key={s.id} className="card p-5">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-lg bg-brand-600 flex items-center justify-center flex-shrink-0">
                  <Building2 size={17} className="text-white" />
                </div>
                <div>
                  <div className="font-bold text-gray-900 text-sm leading-tight">{s.name}</div>
                  {s.supplier_code && <div className="text-xs text-gray-400 mt-0.5">{s.supplier_code}</div>}
                </div>
              </div>
              <div className="flex gap-1">
                <button className="btn-ghost btn-sm p-1.5" onClick={() => setModal(s)} title="Edit">
                  <Pencil size={14} />
                </button>
                <button className="btn-ghost btn-sm p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50" onClick={() => handleDelete(s)} title="Delete">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            <div className="space-y-1">
              {s.contact_person && <div className="text-sm text-gray-600">{s.contact_person}</div>}
              {s.phone && <div className="flex items-center gap-1.5 text-xs text-gray-400"><Phone size={11} />{s.phone}</div>}
              {s.email && <div className="flex items-center gap-1.5 text-xs text-gray-400"><Mail size={11} />{s.email}</div>}
              {s.address && <div className="flex items-center gap-1.5 text-xs text-gray-400"><MapPin size={11} /><span className="truncate">{s.address}</span></div>}
            </div>
            <div className="mt-3 pt-3 border-t border-gray-100">
              {s.item_count > 0 ? (
                <div className="flex items-center gap-1.5 text-xs text-green-600 font-medium">
                  <Package size={12} /> {s.item_count} item{s.item_count !== 1 ? 's' : ''} linked
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-xs text-amber-600 font-medium">
                  <AlertTriangle size={12} /> No items linked
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {modal && (
        <SupplierModal
          supplier={modal === 'new' ? null : modal}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); }}
        />
      )}
      {showImport && <ImportModal type="suppliers" onClose={() => setShowImport(false)} onDone={() => load()} />}
    </div>
  );
}
