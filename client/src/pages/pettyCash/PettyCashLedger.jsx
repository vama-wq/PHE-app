import { useEffect, useState } from 'react';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import Modal from '../../components/ui/Modal';
import { fmtDate, downloadExcel } from '../../lib/utils';
import { Wallet, Plus, Download, ExternalLink, Trash2, TrendingUp, TrendingDown, Upload } from 'lucide-react';

const inr = (n) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function PettyCashLedger() {
  const { user } = useAuthStore();
  const [data, setData] = useState(null);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [loading, setLoading] = useState(true);
  const [showEntry, setShowEntry] = useState(null); // 'expense' | 'top_up'

  const isOwner = user.role === 'owner';

  const load = () => {
    setLoading(true);
    api.get(`/petty-cash?month=${month}`)
      .then(r => setData(r.data))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [month]);

  const handleDelete = async (e) => {
    if (!window.confirm(`Delete this ${e.entry_type === 'top_up' ? 'top-up' : 'expense'} of ${inr(e.amount)}?`)) return;
    try { await api.delete(`/petty-cash/${e.id}`); load(); }
    catch (err) { alert(err.response?.data?.error || 'Failed'); }
  };

  // Running balance within the filtered month, seeded by the opening balance
  let running = data?.opening_balance ?? 0;
  const rows = (data?.entries || []).map(e => {
    running += e.entry_type === 'top_up' ? Number(e.amount) : -Number(e.amount);
    return { ...e, running };
  });
  const monthIn = (data?.entries || []).filter(e => e.entry_type === 'top_up').reduce((a, e) => a + Number(e.amount), 0);
  const monthOut = (data?.entries || []).filter(e => e.entry_type === 'expense').reduce((a, e) => a + Number(e.amount), 0);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Wallet size={24} className="text-emerald-600" /> Petty Cash
          </h1>
          <p className="text-gray-500 text-sm mt-0.5">Office expense ledger — record-only, receipts required above ₹{data?.receipt_required_above ?? 500}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input type="month" className="input w-[160px]" value={month} onChange={e => setMonth(e.target.value)} />
          <button className="btn-secondary flex items-center gap-1.5 text-sm"
            onClick={() => downloadExcel('petty-cash', 'petty_cash.xlsx')}>
            <Download size={15} /> Export
          </button>
          {isOwner && (
            <button className="btn-secondary flex items-center gap-1.5 text-sm" onClick={() => setShowEntry('top_up')}>
              <TrendingUp size={15} /> Add Top-up
            </button>
          )}
          <button className="btn-primary flex items-center gap-1.5" onClick={() => setShowEntry('expense')}>
            <Plus size={16} /> Add Expense
          </button>
        </div>
      </div>

      {/* Balance cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="card p-4">
          <div className="text-sm text-gray-500">Cash in Hand</div>
          <div className={`text-2xl font-bold mt-1 ${Number(data?.balance) < 0 ? 'text-red-600' : 'text-gray-900'}`}>
            {data ? inr(data.balance) : '—'}
          </div>
        </div>
        <div className="card p-4">
          <div className="text-sm text-gray-500 flex items-center gap-1"><TrendingUp size={14} className="text-green-500" /> Top-ups this month</div>
          <div className="text-2xl font-bold mt-1 text-green-700">{inr(monthIn)}</div>
        </div>
        <div className="card p-4">
          <div className="text-sm text-gray-500 flex items-center gap-1"><TrendingDown size={14} className="text-red-500" /> Expenses this month</div>
          <div className="text-2xl font-bold mt-1 text-red-700">{inr(monthOut)}</div>
        </div>
      </div>

      {/* Category summary for the month */}
      {data?.category_totals?.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {data.category_totals.map(c => (
            <span key={c.category} className="text-xs bg-gray-100 text-gray-700 rounded-full px-2.5 py-1">
              {c.category || 'Uncategorised'}: <span className="font-semibold">{inr(c.total)}</span>
            </span>
          ))}
        </div>
      )}

      {/* Ledger */}
      <div className="card overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="table-header text-left">Date</th>
              <th className="table-header text-left">Category / Type</th>
              <th className="table-header text-left">Description</th>
              <th className="table-header text-left">Paid To</th>
              <th className="table-header text-right">Cash In</th>
              <th className="table-header text-right">Cash Out</th>
              <th className="table-header text-right">Balance</th>
              <th className="table-header text-center">Receipt</th>
              <th className="table-header text-left">By</th>
              {isOwner && <th className="table-header text-center"></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={10} className="table-cell text-center text-gray-400 py-10">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={10} className="table-cell text-center text-gray-400 py-10">No entries this month</td></tr>
            ) : (
              <>
                <tr className="bg-gray-50/60">
                  <td colSpan={6} className="table-cell text-xs text-gray-500">Opening balance</td>
                  <td className="table-cell text-right text-xs font-semibold text-gray-600">{inr(data.opening_balance)}</td>
                  <td colSpan={isOwner ? 3 : 2}></td>
                </tr>
                {rows.map(e => (
                  <tr key={e.id} className="hover:bg-gray-50">
                    <td className="table-cell text-sm whitespace-nowrap">{fmtDate(e.entry_date)}</td>
                    <td className="table-cell text-sm">
                      {e.entry_type === 'top_up'
                        ? <span className="text-xs font-medium bg-green-100 text-green-700 rounded-full px-2 py-0.5">Top-up</span>
                        : <span>{e.category || '—'}</span>}
                    </td>
                    <td className="table-cell text-sm text-gray-600">{e.description || '—'}</td>
                    <td className="table-cell text-sm text-gray-600">{e.paid_to || '—'}</td>
                    <td className="table-cell text-right text-sm font-semibold text-green-700">
                      {e.entry_type === 'top_up' ? inr(e.amount) : ''}
                    </td>
                    <td className="table-cell text-right text-sm font-semibold text-red-700">
                      {e.entry_type === 'expense' ? inr(e.amount) : ''}
                    </td>
                    <td className={`table-cell text-right text-sm font-medium ${e.running < 0 ? 'text-red-600' : 'text-gray-700'}`}>{inr(e.running)}</td>
                    <td className="table-cell text-center">
                      {e.receipt_file ? (
                        <a href={`/uploads/${e.receipt_file}`} target="_blank" rel="noopener noreferrer"
                          className="text-brand-600 hover:text-brand-700 inline-flex" title={e.receipt_original_name || 'View receipt'}>
                          <ExternalLink size={14} />
                        </a>
                      ) : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="table-cell text-xs text-gray-400">{e.created_by_name || ''}</td>
                    {isOwner && (
                      <td className="table-cell text-center">
                        <button className="p-1 text-gray-300 hover:text-red-600" onClick={() => handleDelete(e)} title="Delete entry">
                          <Trash2 size={14} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </>
            )}
          </tbody>
        </table>
      </div>

      {showEntry && (
        <EntryModal type={showEntry} receiptLimit={data?.receipt_required_above ?? 500}
          onClose={() => setShowEntry(null)} onSaved={() => { setShowEntry(null); load(); }} />
      )}
    </div>
  );
}

function EntryModal({ type, receiptLimit, onClose, onSaved }) {
  const isTopUp = type === 'top_up';
  const [f, setF] = useState({
    entry_date: new Date().toISOString().slice(0, 10),
    category: '', description: '', paid_to: '', amount: '',
  });
  const [categories, setCategories] = useState([]);
  const [newCategory, setNewCategory] = useState(false);
  const [receipt, setReceipt] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));

  useEffect(() => {
    if (isTopUp) return;
    api.get('/petty-cash/categories').then(r => {
      setCategories(r.data || []);
      if (!(r.data || []).length) setNewCategory(true);
    }).catch(() => setNewCategory(true));
  }, []);

  const needsReceipt = !isTopUp && parseFloat(f.amount) > receiptLimit;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!(parseFloat(f.amount) > 0)) return setError('Enter a valid amount.');
    if (!isTopUp && !f.category.trim()) return setError('Category is required.');
    if (needsReceipt && !receipt) return setError(`A receipt/bill photo is required for expenses above ₹${receiptLimit}.`);
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('entry_type', type);
      fd.append('entry_date', f.entry_date);
      fd.append('amount', f.amount);
      if (!isTopUp) fd.append('category', f.category.trim());
      if (f.description) fd.append('description', f.description);
      if (f.paid_to) fd.append('paid_to', f.paid_to);
      if (receipt) fd.append('receipt', receipt);
      await api.post('/petty-cash', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to record entry');
      setSaving(false);
    }
  };

  return (
    <Modal open title={isTopUp ? 'Add Cash Top-up' : 'Add Expense'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Date <span className="text-red-500">*</span></label>
            <input className="input" type="date" value={f.entry_date} onChange={set('entry_date')} required />
          </div>
          <div>
            <label className="label">Amount (₹) <span className="text-red-500">*</span></label>
            <input className="input" type="number" min="0.01" step="any" value={f.amount} onChange={set('amount')} required />
          </div>
        </div>
        {!isTopUp && (
          <>
            <div>
              <label className="label">Category <span className="text-red-500">*</span></label>
              {newCategory ? (
                <div className="flex gap-2">
                  <input className="input flex-1" placeholder="e.g. Tea & Refreshments, Stationery, Courier"
                    value={f.category} onChange={set('category')} autoFocus />
                  {categories.length > 0 && (
                    <button type="button" className="btn-secondary text-xs px-2"
                      onClick={() => { setNewCategory(false); setF(p => ({ ...p, category: '' })); }}>List</button>
                  )}
                </div>
              ) : (
                <select className="input" value={f.category}
                  onChange={e => {
                    if (e.target.value === '__new__') { setNewCategory(true); setF(p => ({ ...p, category: '' })); }
                    else setF(p => ({ ...p, category: e.target.value }));
                  }}>
                  <option value="">— select category —</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                  <option value="__new__">＋ New category…</option>
                </select>
              )}
            </div>
            <div>
              <label className="label">Paid To <span className="text-gray-400 font-normal">(optional)</span></label>
              <input className="input" value={f.paid_to} onChange={set('paid_to')} placeholder="Shop / person" />
            </div>
          </>
        )}
        <div>
          <label className="label">{isTopUp ? 'Notes' : 'Description'} <span className="text-gray-400 font-normal">(optional)</span></label>
          <input className="input" value={f.description} onChange={set('description')} />
        </div>
        {!isTopUp && (
          <div>
            <label className="label">
              Receipt / Bill {needsReceipt
                ? <span className="text-red-500">*</span>
                : <span className="text-gray-400 font-normal">(optional below ₹{receiptLimit})</span>}
            </label>
            <label className="flex items-center gap-2 cursor-pointer border border-gray-200 rounded-lg px-3 py-2 hover:border-brand-400 transition-colors bg-gray-50">
              <Upload size={15} className="text-gray-400 flex-shrink-0" />
              <span className="text-sm text-gray-600 flex-1 truncate">{receipt ? receipt.name : 'Attach receipt photo / PDF…'}</span>
              <input type="file" accept="image/*,.pdf" className="hidden"
                onChange={e => { setReceipt(e.target.files[0] || null); setError(''); }} />
            </label>
          </div>
        )}
        {error && <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
        <div className="flex gap-3 pt-1">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving}>
            {saving ? 'Saving…' : isTopUp ? 'Add Top-up' : 'Record Expense'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
