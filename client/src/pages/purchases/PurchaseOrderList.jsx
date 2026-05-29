import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import { fmtDate } from '../../lib/utils';
import { Plus, Search, ShoppingCart, Trash2 } from 'lucide-react';

const STATUS_STYLES = {
  draft:    'bg-gray-100 text-gray-600',
  sent:     'bg-blue-100 text-blue-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  received: 'bg-teal-100 text-teal-700',
};
const STATUS_LABELS = {
  draft: 'Draft', sent: 'Sent — Awaiting Approval',
  approved: 'Approved', rejected: 'Rejected', received: 'Received',
};

export default function PurchaseOrderList() {
  const { user } = useAuthStore();
  const [pos, setPos] = useState([]);
  const [filtered, setFiltered] = useState([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [loading, setLoading] = useState(true);

  const load = () => api.get('/purchase-orders').then(r => { setPos(r.data); setFiltered(r.data); }).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const handleDelete = async (po, e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm(`Delete PO "${po.po_number}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/purchase-orders/${po.id}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to delete');
    }
  };
  useEffect(() => {
    let r = pos;
    if (statusFilter !== 'all') r = r.filter(p => p.status === statusFilter);
    if (search) {
      const q = search.toLowerCase();
      r = r.filter(p => p.po_number.toLowerCase().includes(q) || p.supplier_name.toLowerCase().includes(q));
    }
    setFiltered(r);
  }, [pos, search, statusFilter]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="page-title flex items-center gap-2">
            <ShoppingCart size={24} className="text-brand-600" /> Purchase Orders
          </h1>
          <p className="text-gray-500 text-sm mt-0.5">{pos.length} total orders</p>
        </div>
        <Link to="/purchases/new" className="btn-primary">
          <Plus size={16} /> New PO
        </Link>
      </div>

      <div className="flex gap-3 mb-5 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-2.5 text-gray-400" />
          <input className="input pl-9" placeholder="Search PO number, supplier..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1.5">
          {['all','draft','sent','approved','rejected','received'].map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`btn-sm rounded-lg px-3 py-1.5 text-xs font-medium border transition-colors ${
                statusFilter === s
                  ? 'bg-brand-600 text-white border-brand-600'
                  : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
              }`}
            >
              {s === 'all' ? 'All' : STATUS_LABELS[s] || s}
            </button>
          ))}
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="table-header text-left">PO Number</th>
              <th className="table-header text-left">Supplier</th>
              <th className="table-header text-left">Date</th>
              <th className="table-header text-right">Grand Total</th>
              <th className="table-header text-center">Status</th>
              {['owner', 'admin'].includes(user?.role) && <th className="table-header text-center">Action</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={['owner', 'admin'].includes(user?.role) ? 6 : 5} className="table-cell text-center text-gray-400 py-12">Loading...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={['owner', 'admin'].includes(user?.role) ? 6 : 5} className="table-cell text-center text-gray-400 py-12">No purchase orders found</td></tr>
            ) : filtered.map(po => (
              <tr key={po.id} className="hover:bg-gray-50">
                <td className="table-cell">
                  <Link to={`/purchases/${po.id}`} className="font-semibold text-brand-700 hover:underline">
                    {po.po_number}
                  </Link>
                </td>
                <td className="table-cell text-gray-700">{po.supplier_name}</td>
                <td className="table-cell text-gray-500">{fmtDate(po.created_at)}</td>
                <td className="table-cell text-right font-semibold text-gray-900">
                  ₹{Number(po.grand_total).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </td>
                <td className="table-cell text-center">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[po.status]}`}>
                    {STATUS_LABELS[po.status] || po.status}
                  </span>
                </td>
                {['owner', 'admin'].includes(user?.role) && (
                  <td className="table-cell text-center">
                    {(user?.role === 'owner' || ['draft', 'rejected'].includes(po.status)) && (
                      <button
                        onClick={(e) => handleDelete(po, e)}
                        className="text-red-400 hover:text-red-600 transition-colors p-1 rounded"
                        title="Delete PO"
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
