import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../lib/api';
import { ArrowDownCircle, ArrowUpCircle, Search } from 'lucide-react';

function fmtDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

export default function FinishedGoodsLog() {
  const [logs, setLogs]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');
  const [typeFilter, setTypeFilter] = useState(''); // '' | 'inward' | 'dispatch' | 'sampling'

  useEffect(() => {
    api.get('/finished-goods/logs').then(r => { setLogs(r.data); setLoading(false); });
  }, []);

  const filtered = logs.filter(l => {
    const q = search.toLowerCase();
    const matchSearch = !q ||
      (l.base_drawing_no || l.drawing_no || '').toLowerCase().includes(q) ||
      (l.client_name || '').toLowerCase().includes(q) ||
      (l.client_code || '').toLowerCase().includes(q) ||
      (l.original_customer_code || '').toLowerCase().includes(q) ||
      (l.order_code || '').toLowerCase().includes(q) ||
      (l.reference || '').toLowerCase().includes(q);
    const matchType = !typeFilter || (
      typeFilter === 'inward' ? l.movement_type === 'inward' :
      typeFilter === 'dispatch' ? l.movement_type === 'outward' && l.outward_type === 'dispatch' :
      typeFilter === 'sampling' ? l.movement_type === 'outward' && l.outward_type === 'sampling' : true
    );
    return matchSearch && matchType;
  });

  const totalInward   = logs.filter(l => l.movement_type === 'inward').reduce((s, l) => s + (l.qty || 0), 0);
  const totalDispatch = logs.filter(l => l.outward_type === 'dispatch').reduce((s, l) => s + (l.qty || 0), 0);
  const totalSampling = logs.filter(l => l.outward_type === 'sampling').reduce((s, l) => s + (l.qty || 0), 0);

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Finished Goods — Movement Log</h1>
          <p className="text-sm text-gray-500 mt-0.5">All inward and outward movements across finished goods inventory</p>
        </div>
        <Link to="/finished-goods" className="btn-secondary text-sm">← Back to Inventory</Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-3">
          <div className="w-10 h-10 bg-green-50 rounded-lg flex items-center justify-center">
            <ArrowDownCircle size={20} className="text-green-600" />
          </div>
          <div>
            <p className="text-xs text-gray-500">Total Inward</p>
            <p className="text-xl font-bold text-gray-900">{totalInward}</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-3">
          <div className="w-10 h-10 bg-red-50 rounded-lg flex items-center justify-center">
            <ArrowUpCircle size={20} className="text-red-500" />
          </div>
          <div>
            <p className="text-xs text-gray-500">Total Dispatched</p>
            <p className="text-xl font-bold text-gray-900">{totalDispatch}</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-3">
          <div className="w-10 h-10 bg-amber-50 rounded-lg flex items-center justify-center">
            <ArrowUpCircle size={20} className="text-amber-500" />
          </div>
          <div>
            <p className="text-xs text-gray-500">Total Sampling</p>
            <p className="text-xl font-bold text-gray-900">{totalSampling}</p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input className="input pl-9 text-sm" placeholder="Search drawing, client, order..."
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-2">
          {[
            { key: '', label: 'All' },
            { key: 'inward', label: '⬇ Inward' },
            { key: 'dispatch', label: '⬆ Dispatch' },
            { key: 'sampling', label: '🧪 Sampling' },
          ].map(f => (
            <button key={f.key}
              onClick={() => setTypeFilter(f.key)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                typeFilter === f.key ? 'bg-brand-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:border-brand-300'
              }`}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="table-header text-left">Date & Time</th>
              <th className="table-header text-left">Type</th>
              <th className="table-header text-left">Drawing No.</th>
              <th className="table-header text-left">Client / Customer</th>
              <th className="table-header text-center">Qty</th>
              <th className="table-header text-left">Reference / Reason</th>
              <th className="table-header text-left">Recorded By</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={7} className="table-cell text-center text-gray-400 py-12">Loading...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={7} className="table-cell text-center text-gray-400 py-12">No movements found</td></tr>
            ) : filtered.map(l => (
              <tr key={l.id} className="hover:bg-gray-50">
                <td className="table-cell text-xs text-gray-500 whitespace-nowrap">{fmtDateTime(l.created_at)}</td>
                <td className="table-cell">
                  {l.movement_type === 'inward' ? (
                    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-green-100 text-green-700">
                      <ArrowDownCircle size={11} /> Inward
                    </span>
                  ) : l.outward_type === 'sampling' ? (
                    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700">
                      <ArrowUpCircle size={11} /> Sampling
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-red-100 text-red-700">
                      <ArrowUpCircle size={11} /> Dispatch
                    </span>
                  )}
                </td>
                <td className="table-cell">
                  <Link to={`/finished-goods/${l.finished_good_id}`}
                    className="font-semibold text-brand-700 hover:underline text-sm">
                    {l.base_drawing_no || l.drawing_no || '—'}
                  </Link>
                  {l.tube_material && (
                    <div className="text-xs text-gray-400">
                      {l.tube_material}{l.wattage ? ` · ${l.wattage}W` : ''}{l.voltage ? ` ${l.voltage}V` : ''}
                    </div>
                  )}
                </td>
                <td className="table-cell text-sm">
                  {l.movement_type === 'outward' ? (
                    <div>
                      <div className="font-medium text-gray-800">{l.client_name || '—'}</div>
                      {l.client_code && <div className="text-xs text-gray-400">{l.client_code}</div>}
                    </div>
                  ) : (
                    <div className="text-gray-400 text-xs">{l.original_customer_code || '—'}</div>
                  )}
                </td>
                <td className="table-cell text-center">
                  <span className={`font-bold text-sm ${l.movement_type === 'inward' ? 'text-green-600' : 'text-red-600'}`}>
                    {l.movement_type === 'inward' ? '+' : '-'}{l.qty}
                  </span>
                </td>
                <td className="table-cell text-sm">
                  {l.reason && <div className="text-amber-700 font-medium">{l.reason}</div>}
                  {l.reference && <div className="text-gray-700">{l.reference}</div>}
                  {l.notes && <div className="text-gray-400 text-xs">{l.notes}</div>}
                  {!l.reason && !l.reference && !l.notes && <span className="text-gray-300">—</span>}
                </td>
                <td className="table-cell text-sm text-gray-500">{l.created_by_name || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
