import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import StatusBadge from '../../components/ui/StatusBadge';
import { fmtDate, daysUntil, getStageLabel, downloadExcel } from '../../lib/utils';
import { Search, ExternalLink, Download, Trash2, X } from 'lucide-react';

export default function JobCardList() {
  const { user } = useAuthStore();
  const [cards, setCards]     = useState([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [search, setSearch]         = useState('');
  const [statusFilter, setStatus]   = useState('');
  const [clientFilter, setClient]   = useState('');
  const [productFilter, setProduct] = useState('');
  const [dateFrom, setDateFrom]     = useState('');
  const [dateTo, setDateTo]         = useState('');

  useEffect(() => {
    api.get('/job-cards').then(r => setCards(r.data)).finally(() => setLoading(false));
  }, []);

  // Unique options
  const clientOptions  = useMemo(() => [...new Set(cards.map(c => c.customer_code).filter(Boolean))].sort(), [cards]);
  const productOptions = useMemo(() => [...new Set(cards.map(c => c.product_name || c.drawing_no).filter(Boolean))].sort(), [cards]);

  const filtered = useMemo(() => {
    let r = cards;
    if (search) {
      const s = search.toLowerCase();
      r = r.filter(jc =>
        (jc.job_card_no || '').toLowerCase().includes(s) ||
        (jc.order_code  || '').toLowerCase().includes(s) ||
        (jc.customer_code || '').toLowerCase().includes(s) ||
        (jc.drawing_no  || '').toLowerCase().includes(s) ||
        (jc.product_name|| '').toLowerCase().includes(s)
      );
    }
    if (statusFilter) r = r.filter(jc => jc.status === statusFilter);
    if (clientFilter) r = r.filter(jc => jc.customer_code === clientFilter);
    if (productFilter) r = r.filter(jc =>
      (jc.product_name || jc.drawing_no) === productFilter
    );
    if (dateFrom) r = r.filter(jc => jc.dispatch_date && jc.dispatch_date >= dateFrom);
    if (dateTo)   r = r.filter(jc => jc.dispatch_date && jc.dispatch_date <= dateTo);
    return r;
  }, [cards, search, statusFilter, clientFilter, productFilter, dateFrom, dateTo]);

  const hasFilters = search || statusFilter || clientFilter || productFilter || dateFrom || dateTo;
  const clearFilters = () => { setSearch(''); setStatus(''); setClient(''); setProduct(''); setDateFrom(''); setDateTo(''); };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Job Cards</h1>
          <p className="text-gray-500 text-sm mt-0.5">{filtered.length} of {cards.length} · sorted by dispatch date</p>
        </div>
        {['admin','owner','accounts','production'].includes(user.role) && (
          <button className="btn-secondary flex items-center gap-1.5 text-sm"
            onClick={() => downloadExcel('job-cards', 'job_cards.xlsx')}>
            <Download size={15} /> Export Excel
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search size={15} className="absolute left-3 top-2.5 text-gray-400" />
          <input className="input pl-9" placeholder="Search job card, order, customer..."
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="input w-[150px]" value={statusFilter} onChange={e => setStatus(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="in_progress">In Progress</option>
          <option value="qc_pending">QC Pending</option>
          <option value="qc_approved">QC Approved</option>
          <option value="completed">Completed</option>
          <option value="dispatched">Dispatched</option>
        </select>
        <select className="input w-[150px]" value={clientFilter} onChange={e => setClient(e.target.value)}>
          <option value="">All Clients</option>
          {clientOptions.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="input w-[170px]" value={productFilter} onChange={e => setProduct(e.target.value)}>
          <option value="">All Products</option>
          {productOptions.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <input type="date" className="input w-[145px]" value={dateFrom}
          onChange={e => setDateFrom(e.target.value)} title="Dispatch date from" />
        <input type="date" className="input w-[145px]" value={dateTo}
          onChange={e => setDateTo(e.target.value)} title="Dispatch date to" />
        {hasFilters && (
          <button className="btn-secondary flex items-center gap-1 text-xs" onClick={clearFilters}>
            <X size={13} /> Clear
          </button>
        )}
      </div>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="table-header text-left">Job Card</th>
              <th className="table-header text-left">Order / Customer</th>
              <th className="table-header text-right">Dispatchable Qty</th>
              <th className="table-header text-left">Dispatch Date</th>
              <th className="table-header text-left">Status</th>
              <th className="table-header text-center">File</th>
              {user.role === 'owner' && <th className="table-header" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={8} className="table-cell text-center text-gray-400 py-12">Loading...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={8} className="table-cell text-center text-gray-400 py-12">No job cards found</td></tr>
            ) : filtered.map(jc => {
              const days = daysUntil(jc.dispatch_date);
              return (
                <tr key={jc.id} className="hover:bg-gray-50">
                  <td className="table-cell">
                    <Link to={`/job-cards/${jc.id}`} className="font-semibold text-brand-700 hover:underline">
                      {jc.job_card_no}
                    </Link>
                    {jc.picked_today && (
                      <span className="ml-2 text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full font-medium">Today</span>
                    )}
                  </td>
                  <td className="table-cell">
                    <Link to={`/orders/${jc.order_id}`} className="text-brand-600 hover:underline text-sm font-medium"
                      onClick={e => e.stopPropagation()}>
                      {jc.order_code}
                    </Link>
                    <div className="text-xs text-gray-400">{jc.customer_code}</div>
                  </td>
                  <td className="table-cell text-right">
                    {jc.net_qty != null && jc.net_qty < jc.qty ? (
                      <div>
                        <span className="font-semibold text-orange-600">{jc.net_qty}</span>
                        <div className="text-xs text-gray-400">of {jc.qty}</div>
                      </div>
                    ) : (
                      <span className="font-semibold text-gray-700">{jc.net_qty ?? jc.qty ?? '—'}</span>
                    )}
                  </td>
                  <td className="table-cell">
                    <div className="text-sm">{fmtDate(jc.dispatch_date)}</div>
                    {jc.status !== 'dispatched' && days !== null && (
                      <div className={`text-xs font-medium ${days < 0 ? 'text-red-600' : days <= 3 ? 'text-orange-500' : 'text-gray-400'}`}>
                        {days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? 'Today' : `${days}d left`}
                      </div>
                    )}
                  </td>
                  <td className="table-cell">
                    <StatusBadge status={jc.status} />
                    {jc.status === 'in_progress' && jc.current_stage > 0 && (
                      <div className="text-xs text-gray-400 mt-0.5">{getStageLabel(jc.current_stage)}</div>
                    )}
                  </td>
                  <td className="table-cell text-center">
                    {jc.file_name ? (
                      <a href={`/uploads/job-cards/${jc.file_name}`} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center justify-center text-brand-600 hover:text-brand-800 p-1 rounded hover:bg-brand-50 transition-colors">
                        <ExternalLink size={15} />
                      </a>
                    ) : (
                      <span className="text-gray-300 text-xs">—</span>
                    )}
                  </td>
                  {user.role === 'owner' && (
                    <td className="table-cell">
                      <button
                        onClick={async e => {
                          e.stopPropagation();
                          if (!window.confirm(`Delete job card "${jc.job_card_no}"? This cannot be undone.`)) return;
                          try { await api.delete(`/job-cards/${jc.id}`); setCards(prev => prev.filter(x => x.id !== jc.id)); }
                          catch (err) { alert(err.response?.data?.error || 'Failed to delete'); }
                        }}
                        className="p-1.5 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                        title="Delete job card"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
