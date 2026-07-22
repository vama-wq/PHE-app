import { useEffect, useState } from 'react';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import Modal from '../../components/ui/Modal';
import { fmtDate, downloadExcel } from '../../lib/utils';
import { Wallet, Plus, Download, ExternalLink, Trash2, TrendingUp, TrendingDown, Upload, BookOpen, ArrowLeft, Building2 } from 'lucide-react';

const inr = (n) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MACHINERY = 'Machinery';

export default function PettyCashLedger() {
  const { user } = useAuthStore();
  const isOwner = user.role === 'owner';
  const [data, setData] = useState(null);
  const [ledgers, setLedgers] = useState(null); // owner-only accounts summary
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [filter, setFilter] = useState(null); // { category } | { company } | null
  const [showEntry, setShowEntry] = useState(null); // 'expense' | 'top_up'
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    const params = new URLSearchParams({ month });
    if (filter?.category) params.set('category', filter.category);
    if (filter?.company) params.set('company', filter.company);
    api.get(`/petty-cash?${params}`).then(r => setData(r.data)).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [month, filter]);
  useEffect(() => { if (isOwner) api.get('/petty-cash/ledgers').then(r => setLedgers(r.data)).catch(() => {}); }, [showEntry]);

  const handleDelete = async (e) => {
    if (!window.confirm(`Delete this ${e.entry_type === 'top_up' ? 'top-up' : 'expense'} of ${inr(e.amount)}?`)) return;
    try { await api.delete(`/petty-cash/${e.id}`); load(); if (isOwner) api.get('/petty-cash/ledgers').then(r => setLedgers(r.data)); }
    catch (err) { alert(err.response?.data?.error || 'Failed'); }
  };

  const isLedgerView = !!(filter?.category || filter?.company);
  // Running column: main view = cash balance (Jay Bhramani expenses don't reduce cash);
  // ledger view = cumulative spend in that account.
  let running = data?.opening_balance ?? 0;
  const rows = (data?.entries || []).map(e => {
    if (isLedgerView) running += e.entry_type === 'expense' ? Number(e.amount) : 0;
    else running += e.entry_type === 'top_up' ? Number(e.amount) : (e.affects_cash === false ? 0 : -Number(e.amount));
    return { ...e, running };
  });
  const monthIn = (data?.entries || []).filter(e => e.entry_type === 'top_up').reduce((a, e) => a + Number(e.amount), 0);
  const monthOut = (data?.entries || []).filter(e => e.entry_type === 'expense').reduce((a, e) => a + Number(e.amount), 0);
  const ledgerTitle = filter?.company ? `Machinery — ${filter.company}` : filter?.category;

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

      {/* Owner-only: ledger accounts (each category + each Machinery company) */}
      {isOwner && ledgers && !isLedgerView && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-gray-800 flex items-center gap-1.5 mb-2">
            <BookOpen size={15} className="text-emerald-600" /> Ledger Accounts <span className="text-gray-400 font-normal">(owner only)</span>
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {ledgers.categories.map(c => (
              <button key={c.name} onClick={() => setFilter({ category: c.name })}
                className="card p-3 text-left hover:border-emerald-300 transition-colors">
                <div className="text-sm font-medium text-gray-800 truncate">{c.name}</div>
                <div className="text-lg font-bold text-gray-900">{inr(c.total_out)}</div>
                <div className="text-xs text-gray-400">{c.entry_count} entr{c.entry_count == 1 ? 'y' : 'ies'}</div>
              </button>
            ))}
          </div>
          {ledgers.companies.length > 0 && (
            <>
              <h3 className="text-xs font-semibold text-gray-500 mt-3 mb-1.5 flex items-center gap-1"><Building2 size={13} /> Machinery — by company</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {ledgers.companies.map(co => (
                  <button key={co.name} onClick={() => setFilter({ company: co.name })}
                    className="card p-3 text-left hover:border-emerald-300 transition-colors">
                    <div className="text-sm font-medium text-gray-800 truncate flex items-center gap-1">
                      {co.name}
                      {co.no_cash && <span className="text-[9px] font-bold bg-amber-100 text-amber-700 rounded px-1 py-0.5">NO CASH</span>}
                    </div>
                    <div className="text-lg font-bold text-gray-900">{inr(co.total_out)}</div>
                    <div className="text-xs text-gray-400">{co.entry_count} entr{co.entry_count == 1 ? 'y' : 'ies'}</div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Ledger-view header */}
      {isLedgerView && (
        <div className="flex items-center justify-between mb-3">
          <button className="btn-ghost btn-sm flex items-center gap-1 text-gray-500" onClick={() => setFilter(null)}>
            <ArrowLeft size={14} /> All entries
          </button>
          <h2 className="text-sm font-semibold text-gray-800">{ledgerTitle} ledger</h2>
        </div>
      )}

      {/* Category chips (main view only) */}
      {!isLedgerView && data?.category_totals?.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {data.category_totals.map(c => (
            <span key={c.category} className="text-xs bg-gray-100 text-gray-700 rounded-full px-2.5 py-1">
              {c.category || 'Uncategorised'}: <span className="font-semibold">{inr(c.total)}</span>
            </span>
          ))}
        </div>
      )}

      {/* Ledger table */}
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
              <th className="table-header text-right">{isLedgerView ? 'Cumulative' : 'Balance'}</th>
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
                  <td colSpan={6} className="table-cell text-xs text-gray-500">{isLedgerView ? 'Brought forward' : 'Opening balance'}</td>
                  <td className="table-cell text-right text-xs font-semibold text-gray-600">{inr(data.opening_balance)}</td>
                  <td colSpan={isOwner ? 3 : 2}></td>
                </tr>
                {rows.map(e => (
                  <tr key={e.id} className="hover:bg-gray-50">
                    <td className="table-cell text-sm whitespace-nowrap">{fmtDate(e.entry_date)}</td>
                    <td className="table-cell text-sm">
                      {e.entry_type === 'top_up'
                        ? <span className="text-xs font-medium bg-green-100 text-green-700 rounded-full px-2 py-0.5">Top-up</span>
                        : <span>{e.category || '—'}{e.affects_cash === false && <span className="ml-1 text-[9px] font-bold bg-amber-100 text-amber-700 rounded px-1 py-0.5">NO CASH</span>}</span>}
                    </td>
                    <td className="table-cell text-sm text-gray-600">{e.description || '—'}</td>
                    <td className="table-cell text-sm text-gray-600">{e.paid_to || '—'}</td>
                    <td className="table-cell text-right text-sm font-semibold text-green-700">
                      {e.entry_type === 'top_up' ? inr(e.amount) : ''}
                    </td>
                    <td className="table-cell text-right text-sm font-semibold text-red-700">
                      {e.entry_type === 'expense' ? inr(e.amount) : ''}
                    </td>
                    <td className={`table-cell text-right text-sm font-medium ${!isLedgerView && e.running < 0 ? 'text-red-600' : 'text-gray-700'}`}>{inr(e.running)}</td>
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
        <EntryModal type={showEntry} isOwner={isOwner} receiptLimit={data?.receipt_required_above ?? 500}
          onClose={() => setShowEntry(null)} onSaved={() => { setShowEntry(null); load(); }} />
      )}
    </div>
  );
}

function EntryModal({ type, isOwner, receiptLimit, onClose, onSaved }) {
  const isTopUp = type === 'top_up';
  const [f, setF] = useState({
    entry_date: new Date().toISOString().slice(0, 10),
    category: '', description: '', paid_to: '', amount: '',
  });
  const [categories, setCategories] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [receipt, setReceipt] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));

  useEffect(() => {
    if (isTopUp) return;
    api.get('/petty-cash/categories').then(r => setCategories(r.data || [])).catch(() => {});
    api.get('/petty-cash/companies').then(r => setCompanies(r.data || [])).catch(() => {});
  }, []);

  const isMachinery = f.category === MACHINERY;
  const isJayBhramani = isMachinery && f.paid_to.trim().toLowerCase() === 'jay bhramani';
  const needsReceipt = !isTopUp && parseFloat(f.amount) > receiptLimit;

  const addCategory = async () => {
    const name = window.prompt('New category name:');
    if (!name?.trim()) return;
    try { await api.post('/petty-cash/categories', { name: name.trim() }); const r = await api.get('/petty-cash/categories'); setCategories(r.data); setF(p => ({ ...p, category: name.trim() })); }
    catch (e) { alert(e.response?.data?.error || 'Failed'); }
  };
  const addCompany = async () => {
    const name = window.prompt('New company name (Paid To):');
    if (!name?.trim()) return;
    try { await api.post('/petty-cash/companies', { name: name.trim() }); const r = await api.get('/petty-cash/companies'); setCompanies(r.data); setF(p => ({ ...p, paid_to: name.trim() })); }
    catch (e) { alert(e.response?.data?.error || 'Failed'); }
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!(parseFloat(f.amount) > 0)) return setError('Enter a valid amount.');
    if (!isTopUp) {
      if (!f.category) return setError('Category is required.');
      if (!f.paid_to.trim()) return setError('Paid To is required.');
      if (isMachinery && !f.description.trim()) return setError('Description is required for Machinery.');
      if (needsReceipt && !receipt) return setError(`A receipt/bill photo is required for expenses above ₹${receiptLimit}.`);
    }
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('entry_type', type);
      fd.append('entry_date', f.entry_date);
      fd.append('amount', f.amount);
      if (!isTopUp) { fd.append('category', f.category); fd.append('paid_to', f.paid_to.trim()); }
      if (f.description) fd.append('description', f.description);
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
              <label className="label flex items-center justify-between">
                <span>Category <span className="text-red-500">*</span></span>
                {isOwner && <button type="button" className="text-xs text-brand-600 hover:underline" onClick={addCategory}>＋ New category</button>}
              </label>
              <select className="input" value={f.category} onChange={e => setF(p => ({ ...p, category: e.target.value, paid_to: '' }))}>
                <option value="">— select category —</option>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            <div>
              <label className="label flex items-center justify-between">
                <span>Paid To <span className="text-red-500">*</span></span>
                {isMachinery && <button type="button" className="text-xs text-brand-600 hover:underline" onClick={addCompany}>＋ New company</button>}
              </label>
              {isMachinery ? (
                <select className="input" value={f.paid_to} onChange={set('paid_to')}>
                  <option value="">— select company —</option>
                  {companies.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              ) : (
                <input className="input" value={f.paid_to} onChange={set('paid_to')} placeholder="Shop / person / company" />
              )}
              {isJayBhramani && (
                <p className="text-[11px] text-amber-700 mt-1">Jay Bhramani — recorded in the ledger but not deducted from cash-in-hand.</p>
              )}
            </div>

            <div>
              <label className="label">Description {isMachinery ? <span className="text-red-500">*</span> : <span className="text-gray-400 font-normal">(optional)</span>}</label>
              <input className="input" value={f.description} onChange={set('description')} />
            </div>

            <div>
              <label className="label">
                Receipt / Bill {needsReceipt ? <span className="text-red-500">*</span> : <span className="text-gray-400 font-normal">(optional below ₹{receiptLimit})</span>}
              </label>
              <label className="flex items-center gap-2 cursor-pointer border border-gray-200 rounded-lg px-3 py-2 hover:border-brand-400 transition-colors bg-gray-50">
                <Upload size={15} className="text-gray-400 flex-shrink-0" />
                <span className="text-sm text-gray-600 flex-1 truncate">{receipt ? receipt.name : 'Attach receipt photo / PDF…'}</span>
                <input type="file" accept="image/*,.pdf" className="hidden"
                  onChange={e => { setReceipt(e.target.files[0] || null); setError(''); }} />
              </label>
            </div>
          </>
        )}
        {isTopUp && (
          <div>
            <label className="label">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
            <input className="input" value={f.description} onChange={set('description')} />
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
