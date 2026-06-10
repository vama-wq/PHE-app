import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import StatusBadge from '../../components/ui/StatusBadge';
import { fmtDate, fmtDateTime } from '../../lib/utils';
import { Search, Plus, MessageSquare, Camera, X, AlertTriangle, Filter } from 'lucide-react';

const QUERY_STATUS_LABELS = {
  open: 'Open',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  product_return: 'Product Return',
};

const QUERY_STATUS_COLORS = {
  open: 'bg-red-100 text-red-800',
  in_progress: 'bg-amber-100 text-amber-800',
  resolved: 'bg-green-100 text-green-800',
  product_return: 'bg-rose-100 text-rose-800',
};

const RETURN_STATUS_LABELS = {
  pending_return: 'Pending Return',
  received: 'Received',
  qc_check: 'QC Check',
  qc_pass: 'QC Passed',
  qc_fail: 'QC Failed',
  in_repair: 'In Repair',
  repaired_dispatched: 'Repaired & Dispatched',
  debit_note_issued: 'Debit Note Issued',
};

const PRIORITY_COLORS = {
  low: 'text-gray-500',
  medium: 'text-amber-600',
  high: 'text-orange-600',
  critical: 'text-red-600',
};

export default function CustomerQueryList() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [queries, setQueries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');

  const load = () => api.get('/customer-queries').then(r => setQueries(r.data)).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    let r = queries;
    if (search) {
      const s = search.toLowerCase();
      r = r.filter(q =>
        q.query_no.toLowerCase().includes(s) ||
        (q.order_code || '').toLowerCase().includes(s) ||
        (q.customer_code || '').toLowerCase().includes(s) ||
        (q.subject || '').toLowerCase().includes(s) ||
        (q.job_card_no || '').toLowerCase().includes(s)
      );
    }
    if (statusFilter) r = r.filter(q => q.status === statusFilter);
    if (deptFilter) r = r.filter(q => q.assigned_department === deptFilter);
    return r;
  }, [queries, search, statusFilter, deptFilter]);

  const hasFilters = search || statusFilter || deptFilter;

  const stats = useMemo(() => ({
    open: queries.filter(q => q.status === 'open').length,
    in_progress: queries.filter(q => q.status === 'in_progress').length,
    product_return: queries.filter(q => q.status === 'product_return').length,
    resolved: queries.filter(q => q.status === 'resolved').length,
  }), [queries]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Customer Queries</h1>
          <p className="text-gray-500 text-sm mt-0.5">Post-dispatch issue tracking and resolution</p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        {[
          { label: 'Open', value: stats.open, color: 'text-red-600', bg: 'bg-red-50 border-red-100' },
          { label: 'In Progress', value: stats.in_progress, color: 'text-amber-600', bg: 'bg-amber-50 border-amber-100' },
          { label: 'Returns', value: stats.product_return, color: 'text-rose-600', bg: 'bg-rose-50 border-rose-100' },
          { label: 'Resolved', value: stats.resolved, color: 'text-green-600', bg: 'bg-green-50 border-green-100' },
        ].map(s => (
          <div key={s.label} className={`rounded-xl border p-3 text-center ${s.bg}`}>
            <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
            <div className="text-xs text-gray-500 mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-5">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search size={16} className="absolute left-3 top-2.5 text-gray-400" />
          <input className="input pl-9" placeholder="Search query, order, customer..."
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="input max-w-[160px]" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="open">Open</option>
          <option value="in_progress">In Progress</option>
          <option value="product_return">Product Return</option>
          <option value="resolved">Resolved</option>
        </select>
        <select className="input max-w-[160px]" value={deptFilter} onChange={e => setDeptFilter(e.target.value)}>
          <option value="">All Departments</option>
          <option value="design">Design</option>
          <option value="production">Production</option>
          <option value="admin">Admin</option>
        </select>
        {hasFilters && (
          <button className="btn-ghost text-sm flex items-center gap-1 text-gray-500"
            onClick={() => { setSearch(''); setStatusFilter(''); setDeptFilter(''); }}>
            <X size={14} /> Clear
          </button>
        )}
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="table-header text-left">Query No</th>
              <th className="table-header text-left">Subject</th>
              <th className="table-header text-left">Order / Job Card</th>
              <th className="table-header text-left">Customer</th>
              <th className="table-header text-left">Department</th>
              <th className="table-header text-left">Priority</th>
              <th className="table-header text-left">Status</th>
              <th className="table-header text-left">Created</th>
              <th className="table-header text-right">Activity</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={9} className="table-cell text-center text-gray-400 py-12">Loading...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={9} className="table-cell text-center text-gray-400 py-12">
                {hasFilters ? 'No results match your filters' : 'No customer queries yet'}
              </td></tr>
            ) : filtered.map(q => (
              <tr key={q.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => navigate(`/customer-queries/${q.id}`)}>
                <td className="table-cell">
                  <span className="font-semibold text-brand-700">{q.query_no}</span>
                </td>
                <td className="table-cell">
                  <div className="font-medium text-gray-800 max-w-[200px] truncate">{q.subject}</div>
                  {q.return_status && (
                    <span className="text-xs bg-rose-50 text-rose-600 px-1.5 py-0.5 rounded mt-0.5 inline-block">
                      {RETURN_STATUS_LABELS[q.return_status] || q.return_status}
                    </span>
                  )}
                </td>
                <td className="table-cell text-sm">
                  <div className="text-gray-700">{q.order_code}</div>
                  {q.job_card_no && <div className="text-xs text-gray-400">{q.job_card_no}</div>}
                </td>
                <td className="table-cell text-sm">{q.customer_code}</td>
                <td className="table-cell">
                  <span className="text-xs font-medium capitalize px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">
                    {q.assigned_department || '—'}
                  </span>
                </td>
                <td className="table-cell">
                  <span className={`text-xs font-semibold uppercase ${PRIORITY_COLORS[q.priority] || 'text-gray-500'}`}>
                    {q.priority === 'critical' && <AlertTriangle size={11} className="inline mr-0.5 mb-0.5" />}
                    {q.priority}
                  </span>
                </td>
                <td className="table-cell">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${QUERY_STATUS_COLORS[q.status]}`}>
                    {QUERY_STATUS_LABELS[q.status]}
                  </span>
                </td>
                <td className="table-cell text-sm text-gray-500">{fmtDate(q.created_at)}</td>
                <td className="table-cell text-right">
                  <div className="flex items-center justify-end gap-2 text-gray-400">
                    {q.message_count > 0 && (
                      <span className="flex items-center gap-0.5 text-xs">
                        <MessageSquare size={12} /> {q.message_count}
                      </span>
                    )}
                    {q.photo_count > 0 && (
                      <span className="flex items-center gap-0.5 text-xs">
                        <Camera size={12} /> {q.photo_count}
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
