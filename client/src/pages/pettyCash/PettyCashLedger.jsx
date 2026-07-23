import { useEffect, useState } from 'react';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import Modal from '../../components/ui/Modal';
import SupplierModal from '../../components/SupplierModal';
import InventoryItemModal from '../../components/InventoryItemModal';
import CategorySelect from '../../components/CategorySelect';
import { fmtDate, downloadExcel } from '../../lib/utils';
import { Wallet, Plus, Download, ExternalLink, Trash2, TrendingUp, TrendingDown, Upload, BookOpen, ArrowLeft, Building2, Landmark, Clock, CheckCircle, FlaskConical, XCircle } from 'lucide-react';

const inr = (n) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MACHINERY = 'Machinery';
const SAMPLING = 'Sampling';
const METHOD_BADGES = {
  cash:        { label: 'Cash',        cls: 'bg-emerald-100 text-emerald-700' },
  paid_bank:   { label: 'Paid Bank',   cls: 'bg-blue-100 text-blue-700' },
  unpaid_bank: { label: 'Unpaid Bank', cls: 'bg-amber-100 text-amber-700' },
};

export default function PettyCashLedger() {
  const { user } = useAuthStore();
  const isOwner = user.role === 'owner';
  const [data, setData] = useState(null);
  const [ledgers, setLedgers] = useState(null); // owner-only accounts summary
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [filter, setFilter] = useState(null); // { category } | { company } | null
  const [showEntry, setShowEntry] = useState(null); // 'expense' | 'top_up'
  const [samples, setSamples] = useState([]);
  const [approving, setApproving] = useState(null); // sample being approved
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    const params = new URLSearchParams({ month });
    if (filter?.category) params.set('category', filter.category);
    if (filter?.company) params.set('company', filter.company);
    api.get(`/petty-cash?${params}`).then(r => setData(r.data)).finally(() => setLoading(false));
  };
  const loadLedgers = () => { if (isOwner) api.get('/petty-cash/ledgers').then(r => setLedgers(r.data)).catch(() => {}); };
  const loadSamples = () => api.get('/petty-cash/samples').then(r => setSamples(r.data || [])).catch(() => {});
  useEffect(() => { load(); }, [month, filter]);
  useEffect(() => { loadLedgers(); loadSamples(); }, [showEntry]);

  const handleRejectSample = async (s) => {
    const reason = window.prompt(`Reject sample "${s.item_name}" from ${s.supplier_name}?\n\nRejection reason (required):`);
    if (reason === null) return;
    if (!reason.trim()) return alert('A rejection reason is required.');
    try { await api.put(`/petty-cash/samples/${s.id}/reject`, { reason: reason.trim() }); loadSamples(); }
    catch (err) { alert(err.response?.data?.error || 'Failed'); }
  };

  const handleDelete = async (e) => {
    const extra = e.category === SAMPLING ? '\n\nThis also deletes its sample record, including any review history.' : '';
    if (!window.confirm(`Delete this ${e.entry_type === 'top_up' ? 'top-up' : 'expense'} of ${inr(e.amount)}?${extra}`)) return;
    try { await api.delete(`/petty-cash/${e.id}`); load(); loadLedgers(); loadSamples(); }
    catch (err) { alert(err.response?.data?.error || 'Failed'); }
  };

  const handleMarkPaid = async (e) => {
    if (!window.confirm(`Mark this ${inr(e.amount)} expense (${e.paid_to || e.category}) as PAID from bank? It will then reduce the Bank balance.`)) return;
    try { await api.put(`/petty-cash/${e.id}/mark-paid`); load(); loadLedgers(); }
    catch (err) { alert(err.response?.data?.error || 'Failed'); }
  };

  const isLedgerView = !!(filter?.category || filter?.company);
  // Running columns: main view = Cash + Bank balances per payment method;
  // ledger view = cumulative spend in that account.
  let cashRun = data?.opening_cash ?? 0;
  let bankRun = data?.opening_bank ?? 0;
  let cumRun = data?.opening_balance ?? 0;
  const rows = (data?.entries || []).map(e => {
    const amt = Number(e.amount);
    const delta = e.entry_type === 'top_up' ? amt : -amt;
    if (e.payment_method === 'cash') cashRun += delta;
    else if (e.payment_method === 'paid_bank') bankRun += delta;
    if (e.entry_type === 'expense') cumRun += amt;
    return { ...e, cashRun, bankRun, cumRun };
  });
  const monthIn = (data?.entries || []).filter(e => e.entry_type === 'top_up').reduce((a, e) => a + Number(e.amount), 0);
  const monthOut = (data?.entries || []).filter(e => e.entry_type === 'expense').reduce((a, e) => a + Number(e.amount), 0);
  const ledgerTitle = filter?.company ? `Machinery — ${filter.company}` : filter?.category;
  const cols = isOwner ? 11 : 10;

  return (
    <div className="p-6 max-w-7xl mx-auto">
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
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <div className="card p-4">
          <div className="text-sm text-gray-500 flex items-center gap-1"><Wallet size={14} className="text-emerald-500" /> Cash in Hand</div>
          <div className={`text-2xl font-bold mt-1 ${Number(data?.cash_balance) < 0 ? 'text-red-600' : 'text-gray-900'}`}>
            {data ? inr(data.cash_balance) : '—'}
          </div>
        </div>
        <div className="card p-4">
          <div className="text-sm text-gray-500 flex items-center gap-1"><Landmark size={14} className="text-blue-500" /> Bank Balance</div>
          <div className={`text-2xl font-bold mt-1 ${Number(data?.bank_balance) < 0 ? 'text-red-600' : 'text-gray-900'}`}>
            {data ? inr(data.bank_balance) : '—'}
          </div>
        </div>
        <div className="card p-4">
          <div className="text-sm text-gray-500 flex items-center gap-1"><Clock size={14} className="text-amber-500" /> Unpaid (pending)</div>
          <div className="text-2xl font-bold mt-1 text-amber-700">{data ? inr(data.unpaid_pending) : '—'}</div>
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
                    <div className="text-sm font-medium text-gray-800 truncate">{co.name}</div>
                    <div className="text-lg font-bold text-gray-900">{inr(co.total_out)}</div>
                    <div className="text-xs text-gray-400">{co.entry_count} entr{co.entry_count == 1 ? 'y' : 'ies'}</div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Samples tracker: Sampling expenses create draft supplier + item records
          that the owner approves (→ real accounts via prefilled forms) or rejects */}
      {!isLedgerView && samples.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-gray-800 flex items-center gap-1.5 mb-2">
            <FlaskConical size={15} className="text-purple-600" /> Samples
            {samples.some(s => s.status === 'pending') && (
              <span className="text-[10px] font-bold bg-amber-100 text-amber-700 rounded-full px-2 py-0.5">
                {samples.filter(s => s.status === 'pending').length} pending
              </span>
            )}
          </h2>
          <div className="card overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="table-header text-left">Date</th>
                  <th className="table-header text-left">Item</th>
                  <th className="table-header text-left">Prospective Supplier</th>
                  <th className="table-header text-right">Qty</th>
                  <th className="table-header text-right">Cost</th>
                  <th className="table-header text-left">Status</th>
                  {isOwner && <th className="table-header text-center">Review</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {samples.map(s => (
                  <tr key={s.id} className="hover:bg-gray-50">
                    <td className="table-cell text-sm whitespace-nowrap">{fmtDate(s.entry_date || s.created_at)}</td>
                    <td className="table-cell text-sm">
                      <div className="font-medium text-gray-800">{s.item_name}</div>
                      <div className="text-xs text-gray-400">{[s.category, s.unit].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td className="table-cell text-sm text-gray-600">{s.supplier_name}</td>
                    <td className="table-cell text-sm text-right">{s.sample_qty ? Number(s.sample_qty) : '—'}</td>
                    <td className="table-cell text-sm text-right font-semibold">{inr(s.sample_cost)}</td>
                    <td className="table-cell">
                      {s.status === 'pending' && <span className="text-[10px] font-bold bg-amber-100 text-amber-700 rounded-full px-2 py-0.5">PENDING</span>}
                      {s.status === 'approved' && (
                        <div>
                          <span className="text-[10px] font-bold bg-green-100 text-green-700 rounded-full px-2 py-0.5">APPROVED</span>
                          <div className="text-[11px] text-gray-400 mt-0.5">{s.linked_supplier_name}{s.linked_item_code ? ` · ${s.linked_item_code}` : ''}</div>
                        </div>
                      )}
                      {s.status === 'rejected' && (
                        <div>
                          <span className="text-[10px] font-bold bg-red-100 text-red-700 rounded-full px-2 py-0.5">REJECTED</span>
                          {s.rejection_reason && <div className="text-[11px] text-gray-400 mt-0.5 max-w-[220px]">{s.rejection_reason}</div>}
                        </div>
                      )}
                    </td>
                    {isOwner && (
                      <td className="table-cell text-center whitespace-nowrap">
                        {s.status === 'pending' && (
                          <>
                            <button className="btn-primary btn-sm text-xs mr-1.5" onClick={() => setApproving(s)}>
                              <CheckCircle size={12} className="inline mr-0.5" /> Approve
                            </button>
                            <button className="p-1 text-gray-400 hover:text-red-600" onClick={() => handleRejectSample(s)} title="Reject with reason">
                              <XCircle size={15} />
                            </button>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
              <th className="table-header text-left">Method</th>
              <th className="table-header text-right">In</th>
              <th className="table-header text-right">Out</th>
              {isLedgerView ? (
                <th className="table-header text-right">Cumulative</th>
              ) : (
                <>
                  <th className="table-header text-right">Cash Bal.</th>
                  <th className="table-header text-right">Bank Bal.</th>
                </>
              )}
              <th className="table-header text-center">Receipt</th>
              <th className="table-header text-left">By</th>
              {isOwner && <th className="table-header text-center"></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={cols + 1} className="table-cell text-center text-gray-400 py-10">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={cols + 1} className="table-cell text-center text-gray-400 py-10">No entries this month</td></tr>
            ) : (
              <>
                <tr className="bg-gray-50/60">
                  <td colSpan={7} className="table-cell text-xs text-gray-500">{isLedgerView ? 'Brought forward' : 'Opening balances'}</td>
                  {isLedgerView ? (
                    <td className="table-cell text-right text-xs font-semibold text-gray-600">{inr(data.opening_balance)}</td>
                  ) : (
                    <>
                      <td className="table-cell text-right text-xs font-semibold text-gray-600">{inr(data.opening_cash)}</td>
                      <td className="table-cell text-right text-xs font-semibold text-gray-600">{inr(data.opening_bank)}</td>
                    </>
                  )}
                  <td colSpan={isOwner ? 3 : 2}></td>
                </tr>
                {rows.map(e => {
                  const badge = METHOD_BADGES[e.payment_method] || METHOD_BADGES.cash;
                  return (
                    <tr key={e.id} className="hover:bg-gray-50">
                      <td className="table-cell text-sm whitespace-nowrap">{fmtDate(e.entry_date)}</td>
                      <td className="table-cell text-sm">
                        {e.entry_type === 'top_up'
                          ? <span className="text-xs font-medium bg-green-100 text-green-700 rounded-full px-2 py-0.5">Top-up</span>
                          : <span>{e.category || '—'}</span>}
                      </td>
                      <td className="table-cell text-sm text-gray-600">{e.description || '—'}</td>
                      <td className="table-cell text-sm text-gray-600">{e.paid_to || '—'}</td>
                      <td className="table-cell">
                        <span className={`text-[10px] font-semibold rounded-full px-2 py-0.5 whitespace-nowrap ${badge.cls}`}>{badge.label}</span>
                      </td>
                      <td className="table-cell text-right text-sm font-semibold text-green-700">
                        {e.entry_type === 'top_up' ? inr(e.amount) : ''}
                      </td>
                      <td className="table-cell text-right text-sm font-semibold text-red-700">
                        {e.entry_type === 'expense' ? inr(e.amount) : ''}
                      </td>
                      {isLedgerView ? (
                        <td className="table-cell text-right text-sm font-medium text-gray-700">{inr(e.cumRun)}</td>
                      ) : (
                        <>
                          <td className={`table-cell text-right text-sm font-medium ${e.cashRun < 0 ? 'text-red-600' : 'text-gray-700'}`}>{inr(e.cashRun)}</td>
                          <td className={`table-cell text-right text-sm font-medium ${e.bankRun < 0 ? 'text-red-600' : 'text-gray-700'}`}>{inr(e.bankRun)}</td>
                        </>
                      )}
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
                        <td className="table-cell text-center whitespace-nowrap">
                          {e.entry_type === 'expense' && e.payment_method === 'unpaid_bank' && (
                            <button className="p-1 text-amber-500 hover:text-green-600" onClick={() => handleMarkPaid(e)} title="Mark as paid (bank)">
                              <CheckCircle size={14} />
                            </button>
                          )}
                          <button className="p-1 text-gray-300 hover:text-red-600" onClick={() => handleDelete(e)} title="Delete entry">
                            <Trash2 size={14} />
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </>
            )}
          </tbody>
        </table>
      </div>

      {showEntry && (
        <EntryModal type={showEntry} isOwner={isOwner} receiptLimit={data?.receipt_required_above ?? 500}
          onClose={() => setShowEntry(null)} onSaved={() => { setShowEntry(null); load(); }} />
      )}

      {approving && (
        <SampleApproveFlow sample={approving}
          onClose={() => { setApproving(null); loadSamples(); }}
          onDone={() => { setApproving(null); loadSamples(); }} />
      )}
    </div>
  );
}

// Approval walks the NORMAL creation forms, prefilled from the sampling draft:
// 1. Inventory item — create new (prefilled form) or pick an already-stocked
//    item. Either way the id is checkpointed on the sample so a cancelled or
//    failed flow resumes here without duplicating records.
// 2. Supplier — create new (prefilled, sample item pre-linked at unit cost) or
//    link the item to an existing supplier (price + lead time). Also
//    checkpointed before approval.
// 3. Both ids are posted to /samples/:id/approve → status APPROVED.
// Checkpoint failures ABORT the flow (the sample may have been deleted) — they
// are never silently skipped, so no orphan records get created past a dead
// sample.
function SampleApproveFlow({ sample, onClose, onDone }) {
  const qty = Number(sample.sample_qty);
  const unitCost = qty > 0 ? Math.round((Number(sample.sample_cost) / qty) * 100) / 100 : '';
  const [itemId, setItemId] = useState(sample.inventory_item_id || null);
  const [step, setStep] = useState(
    sample.inventory_item_id && sample.supplier_id ? 'finalize'
      : sample.inventory_item_id ? 'choice' : 'item-choice');
  const [suppliers, setSuppliers] = useState([]);
  const [inventory, setInventory] = useState([]);
  const [existingId, setExistingId] = useState('');
  const [existingItemId, setExistingItemId] = useState('');
  const [link, setLink] = useState({ supplier_price: unitCost, lead_time_days: '', supplier_part_no: '', min_order_qty: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/suppliers').then(r => setSuppliers(r.data || [])).catch(() => {});
    api.get('/inventory?include_pending=1').then(r => setInventory(r.data || [])).catch(() => {});
  }, []);

  // Persist progress on the sample; abort the whole flow if that fails.
  const checkpoint = async (payload) => {
    try {
      await api.put(`/petty-cash/samples/${sample.id}/link-item`, payload);
      return true;
    } catch (err) {
      alert(`${err.response?.data?.error || 'Could not update the sample'} — the approval cannot continue. Anything already created (item / supplier) still exists and can be reused.`);
      onClose();
      return false;
    }
  };

  const finalize = async (supplierId, invId) => {
    try {
      await api.put(`/petty-cash/samples/${sample.id}/approve`, { supplier_id: supplierId, inventory_item_id: invId });
      onDone();
    } catch (err) {
      alert(err.response?.data?.error || 'Approving the sample failed — open Approve again to finish (nothing needs re-creating).');
      onClose();
    }
  };

  if (step === 'item-new') {
    return (
      <InventoryItemModal
        initial={{ name: sample.item_name, category: sample.category || '', unit: sample.unit || '', unit_cost: unitCost, notes: `From sample — ${sample.supplier_name}` }}
        onClose={onClose}
        onSave={async (r) => {
          setItemId(r.id);
          if (await checkpoint({ inventory_item_id: r.id })) setStep('choice');
        }} />
    );
  }

  if (step === 'supplier') {
    return (
      <SupplierModal
        initial={{ name: sample.supplier_name, notes: `From sample — ${sample.item_name}` }}
        initialItems={[{ inventory_item_id: String(itemId), supplier_part_no: '', supplier_price: unitCost, lead_time_days: '', min_order_qty: '' }]}
        includePendingInventory
        onClose={onClose}
        onSaved={async (id) => {
          if (await checkpoint({ supplier_id: id })) await finalize(id, itemId);
        }} />
    );
  }

  // Remaining steps share one modal: 'item-choice', 'choice', 'link', 'finalize'
  const submitLink = async (e) => {
    e.preventDefault();
    if (!(Number(link.supplier_price) > 0)) return setError('Price is required.');
    if (!(parseInt(link.lead_time_days, 10) > 0)) return setError('Lead time is required.');
    setSaving(true);
    setError('');
    try {
      await api.post(`/suppliers/${existingId}/items`, { inventory_item_id: itemId, ...link });
      if (await checkpoint({ supplier_id: existingId })) await finalize(existingId, itemId);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed');
      setSaving(false);
    }
  };

  return (
    <Modal open title={`Approve Sample — ${sample.item_name}`} onClose={onClose}>
      {step === 'finalize' ? (
        <div className="space-y-3">
          <p className="text-sm text-gray-500">Supplier and item are already created for this sample — just complete the approval.</p>
          <button className="btn-primary w-full" onClick={() => finalize(sample.supplier_id, sample.inventory_item_id)}>
            Complete Approval
          </button>
        </div>
      ) : step === 'item-choice' ? (
        <div className="space-y-3">
          <p className="text-sm text-gray-500">First the inventory item for <span className="font-medium text-gray-700">{sample.item_name}</span>:</p>
          <button className="card p-4 w-full text-left hover:border-brand-400 transition-colors" onClick={() => setStep('item-new')}>
            <div className="font-medium text-gray-800">Create new inventory item</div>
            <div className="text-xs text-gray-400 mt-0.5">Opens the normal Inventory form prefilled with the sample's name, category, unit and unit cost</div>
          </button>
          <div className="card p-4">
            <div className="font-medium text-gray-800 mb-1">Link to an existing item</div>
            <div className="text-xs text-gray-400 mb-2">If this material is already in inventory (e.g. sampled from a new source)</div>
            <div className="flex gap-2">
              <select className="input flex-1" value={existingItemId} onChange={e => setExistingItemId(e.target.value)}>
                <option value="">— select item —</option>
                {inventory.map(inv => <option key={inv.id} value={inv.id}>{inv.item_code} — {inv.name} ({inv.unit})</option>)}
              </select>
              <button className="btn-primary btn-sm" disabled={!existingItemId} onClick={async () => {
                if (await checkpoint({ inventory_item_id: existingItemId })) { setItemId(existingItemId); setStep('choice'); }
              }}>Continue</button>
            </div>
          </div>
        </div>
      ) : step === 'choice' ? (
        <div className="space-y-3">
          <p className="text-sm text-gray-500">Item linked ✓ — now the supplier. The sample came from <span className="font-medium text-gray-700">{sample.supplier_name}</span>:</p>
          <button className="card p-4 w-full text-left hover:border-brand-400 transition-colors" onClick={() => setStep('supplier')}>
            <div className="font-medium text-gray-800">Create new supplier</div>
            <div className="text-xs text-gray-400 mt-0.5">Opens the normal Supplier form prefilled with "{sample.supplier_name}", sample item pre-linked at {unitCost !== '' ? inr(unitCost) : 'its'} / {sample.unit || 'unit'}</div>
          </button>
          <div className="card p-4">
            <div className="font-medium text-gray-800 mb-2">Link to an existing supplier</div>
            <div className="flex gap-2">
              <select className="input flex-1" value={existingId} onChange={e => setExistingId(e.target.value)}>
                <option value="">— select supplier —</option>
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.supplier_code ? `${s.supplier_code} — ` : ''}{s.name}</option>)}
              </select>
              <button className="btn-primary btn-sm" disabled={!existingId} onClick={() => setStep('link')}>Continue</button>
            </div>
          </div>
        </div>
      ) : (
        <form onSubmit={submitLink} className="space-y-4">
          <p className="text-sm text-gray-500">Link the sample item to <span className="font-medium text-gray-700">{suppliers.find(s => String(s.id) === String(existingId))?.name}</span>:</p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Price (per {sample.unit || 'unit'}) <span className="text-red-500">*</span></label>
              <input className="input" type="number" step="any" min="0" value={link.supplier_price}
                onChange={e => setLink(p => ({ ...p, supplier_price: e.target.value }))} required />
            </div>
            <div>
              <label className="label">Lead Time (days) <span className="text-red-500">*</span></label>
              <input className="input" type="number" min="1" value={link.lead_time_days}
                onChange={e => setLink(p => ({ ...p, lead_time_days: e.target.value }))} required />
            </div>
            <div>
              <label className="label">Supplier Part No</label>
              <input className="input" value={link.supplier_part_no}
                onChange={e => setLink(p => ({ ...p, supplier_part_no: e.target.value }))} />
            </div>
            <div>
              <label className="label">Min Order Qty</label>
              <input className="input" type="number" step="any" min="0" value={link.min_order_qty}
                onChange={e => setLink(p => ({ ...p, min_order_qty: e.target.value }))} />
            </div>
          </div>
          {error && <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
          <div className="flex gap-3 pt-1">
            <button type="button" className="btn-secondary flex-1" onClick={() => { setError(''); setStep('choice'); }}>Back</button>
            <button type="submit" className="btn-primary flex-1" disabled={saving}>{saving ? 'Saving…' : 'Link & Approve'}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function EntryModal({ type, isOwner, receiptLimit, onClose, onSaved }) {
  const isTopUp = type === 'top_up';
  const [f, setF] = useState({
    entry_date: new Date().toISOString().slice(0, 10),
    category: '', description: '', paid_to: '', amount: '',
    payment_method: isTopUp ? 'cash' : '',
    item_name: '', item_category: '', unit: '', sample_qty: '',
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
  const isSampling = f.category === SAMPLING;
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
    if (!f.payment_method) return setError(isTopUp ? 'Select Cash or Bank.' : 'Select a payment method.');
    if (!isTopUp) {
      if (!f.category) return setError('Category is required.');
      if (!f.paid_to.trim()) return setError('Paid To is required.');
      if (isMachinery && !f.description.trim()) return setError('Description is required for Machinery.');
      if (isSampling) {
        if (!f.item_name.trim()) return setError('Item name is required for Sampling.');
        if (!f.unit.trim()) return setError('Unit is required for Sampling.');
        if (!(parseFloat(f.sample_qty) > 0)) return setError('Enter a valid sample quantity.');
      }
      if (needsReceipt && !receipt) return setError(`A receipt/bill photo is required for expenses above ₹${receiptLimit}.`);
    }
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('entry_type', type);
      fd.append('entry_date', f.entry_date);
      fd.append('amount', f.amount);
      fd.append('payment_method', f.payment_method);
      if (!isTopUp) { fd.append('category', f.category); fd.append('paid_to', f.paid_to.trim()); }
      if (!isTopUp && isSampling) {
        fd.append('item_name', f.item_name.trim());
        fd.append('item_category', f.item_category);
        fd.append('unit', f.unit.trim());
        fd.append('sample_qty', f.sample_qty);
      }
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

        <div>
          <label className="label">{isTopUp ? 'Top-up Into' : 'Payment Method'} <span className="text-red-500">*</span></label>
          <select className="input" value={f.payment_method} onChange={set('payment_method')}>
            {!isTopUp && <option value="">— select —</option>}
            <option value="cash">Cash{isTopUp ? ' in Hand' : ''}</option>
            <option value="paid_bank">{isTopUp ? 'Bank' : 'Paid Bank'}</option>
            {!isTopUp && <option value="unpaid_bank">Unpaid Bank (pending — no deduction yet)</option>}
          </select>
          {f.payment_method === 'unpaid_bank' && (
            <p className="text-[11px] text-amber-700 mt-1">Recorded but not deducted — the owner can mark it Paid later, which then reduces the Bank balance.</p>
          )}
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
                <input className="input" value={f.paid_to} onChange={set('paid_to')}
                  placeholder={isSampling ? 'Prospective supplier name' : 'Shop / person / company'} />
              )}
            </div>

            {isSampling && (
              <div className="border border-purple-200 bg-purple-50/50 rounded-xl p-3 space-y-3">
                <p className="text-xs text-purple-700 font-medium flex items-center gap-1">
                  <FlaskConical size={13} /> Sample details — creates a draft supplier + item for owner approval
                </p>
                <div>
                  <label className="label">Item Name <span className="text-red-500">*</span></label>
                  <input className="input" value={f.item_name} onChange={set('item_name')} placeholder="e.g. Brass Nipple 1/2 inch" />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="label">Item Category</label>
                    <CategorySelect value={f.item_category} onChange={v => setF(p => ({ ...p, item_category: v }))} />
                  </div>
                  <div>
                    <label className="label">Unit <span className="text-red-500">*</span></label>
                    <input className="input" value={f.unit} onChange={set('unit')} placeholder="kg / mtr / nos" />
                  </div>
                  <div>
                    <label className="label">Sample Qty <span className="text-red-500">*</span></label>
                    <input className="input" type="number" step="any" min="0" value={f.sample_qty} onChange={set('sample_qty')} />
                  </div>
                </div>
              </div>
            )}

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
