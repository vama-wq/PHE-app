import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import StatusBadge from '../../components/ui/StatusBadge';
import { fmtDate, daysUntil, getStageLabel, downloadExcel } from '../../lib/utils';
import { Search, ExternalLink, FileText, Download, Trash2 } from 'lucide-react';

export default function JobCardList() {
  const { user } = useAuthStore();
  const [cards, setCards] = useState([]);
  const [filtered, setFiltered] = useState([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/job-cards').then(r => { setCards(r.data); setFiltered(r.data); }).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let r = cards;
    if (search) r = r.filter(jc =>
      jc.job_card_no.toLowerCase().includes(search.toLowerCase()) ||
      jc.order_code.toLowerCase().includes(search.toLowerCase()) ||
      jc.customer_code.toLowerCase().includes(search.toLowerCase())
    );
    if (statusFilter) r = r.filter(jc => jc.status === statusFilter);
    setFiltered(r);
  }, [cards, search, statusFilter]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Job Cards</h1>
          <p className="text-gray-500 text-sm mt-0.5">{cards.length} total · sorted by dispatch date</p>
        </div>
        {['admin','owner','accounts','production'].includes(user.role) && (
          <button className="btn-secondary flex items-center gap-1.5 text-sm"
            onClick={() => downloadExcel('job-cards', 'job_cards.xlsx')}>
            <Download size={15} /> Export Excel
          </button>
        )}
      </div>

      <div className="flex gap-3 mb-5">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-2.5 text-gray-400" />
          <input className="input pl-9" placeholder="Search job card, order, customer..."
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="input max-w-[180px]" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="in_progress">In Progress</option>
          <option value="completed">Completed</option>
          <option value="dispatched">Dispatched</option>
        </select>
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
                    <span className="font-semibold text-brand-700">{jc.job_card_no}</span>
                    {jc.picked_today ? (
                      <span className="ml-2 text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full font-medium">
                        Today
                      </span>
                    ) : null}
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
