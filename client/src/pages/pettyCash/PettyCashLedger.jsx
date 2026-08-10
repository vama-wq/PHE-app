import { useEffect, useState } from 'react';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import Modal from '../../components/ui/Modal';
import SupplierModal from '../../components/SupplierModal';
import InventoryItemModal from '../../components/InventoryItemModal';
import CategorySelect from '../../components/CategorySelect';
import { fmtDate, downloadExcel } from '../../lib/utils';
import { Wallet, Plus, Download, ExternalLink, Trash2, TrendingUp, TrendingDown, Upload, BookOpen, ArrowLeft, Building2, Landmark, Clock, CheckCircle, FlaskConical, XCircle, Boxes, CheckSquare, Square, Droplets, ChevronDown, ChevronRight, Printer } from 'lucide-react';

const inr = (n) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MACHINERY = 'Machinery';
const SAMPLING = 'Sampling';
const EMPLOYEE_EXPENSE = 'Employee Expense';
const PLATING = 'Plating';
const PLATING_COMPANIES = ['A S Plating', 'Aesha Plating', 'Akshar Enterprise'];
const PLATING_TRANSPORT = 'Plating Transportation';
const BANK_WITHDRAWAL = 'Bank Withdrawal'; // bank down → cash in hand up (linked top-up)
const EMP_TYPES = ['Advance Paid', 'Employee Welfare', 'Employee Care', 'Miscellaneous'];
const EMP_TYPES_WORKER = ['Advance Paid', 'Employee Care']; // pick a worker from payroll
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
  const [showLedgers, setShowLedgers] = useState(false); // ledger cards collapsed by default
  const [showEntry, setShowEntry] = useState(null); // 'expense' | 'top_up'
  const [samples, setSamples] = useState([]);
  const [approving, setApproving] = useState(null); // sample being approved
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    const params = new URLSearchParams({ month });
    if (filter?.category) params.set('category', filter.category);
    if (filter?.company) params.set('company', filter.company);
    if (filter?.method) params.set('method', filter.method);
    // Stamp the month/method the rows actually came from, and on failure clear
    // rather than keep the previous month's data — a stale table (or a printed
    // statement titled with the newly selected month) lies.
    const forMonth = month;
    api.get(`/petty-cash?${params}`)
      .then(r => setData({ ...r.data, loaded_month: forMonth }))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
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

  const isLedgerView = !!(filter?.category || filter?.company || filter?.method);
  // A Bank / Cash method ledger runs as a live balance (top-up +, expense −);
  // everything else (category, company, Unpaid Bank) runs as cumulative spend.
  const methodIsBalance = filter?.method === 'paid_bank' || filter?.method === 'cash';
  const runLabel = methodIsBalance ? 'Balance' : 'Cumulative';
  // Running columns: main view = Cash + Bank balances per payment method;
  // ledger view = cumulative spend (or running balance) in that account.
  let cashRun = data?.opening_cash ?? 0;
  let bankRun = data?.opening_bank ?? 0;
  let cumRun = data?.opening_balance ?? 0;
  const rows = (data?.entries || []).map(e => {
    const amt = Number(e.amount);
    const delta = e.entry_type === 'top_up' ? amt : -amt;
    if (e.payment_method === 'cash') cashRun += delta;
    else if (e.payment_method === 'paid_bank') bankRun += delta;
    if (methodIsBalance) cumRun += delta;
    else if (e.entry_type === 'expense') cumRun += amt;
    return { ...e, cashRun, bankRun, cumRun };
  });
  const monthIn = (data?.entries || []).filter(e => e.entry_type === 'top_up').reduce((a, e) => a + Number(e.amount), 0);
  const monthOut = (data?.entries || []).filter(e => e.entry_type === 'expense').reduce((a, e) => a + Number(e.amount), 0);
  const ledgerTitle = filter?.company ? `Machinery — ${filter.company}`
    : filter?.method ? ({ paid_bank: 'Bank', unpaid_bank: 'Unpaid Bank', cash: 'Cash' }[filter.method])
    : filter?.category;
  const cols = isOwner ? 11 : 9; // accounts has no Bank Bal. column or actions column

  // Print-to-PDF statement for a payment-method ledger — Cash and Bank print as
  // account statements (in / out / running balance), Unpaid Bank as a payables
  // statement (pending amounts + cumulative outstanding). Same window.print
  // pattern as the Purchase Payments Due export.
  const printStatement = () => {
    // Print only what was actually fetched — never label a stale month's rows
    // with a newly picked month.
    if (!data || data.loaded_month !== month || data.filter?.method !== filter?.method) {
      return alert('Still loading this month — try again in a moment.');
    }
    const w = window.open('', '_blank');
    if (!w) return alert('Allow pop-ups to print the statement.');
    const isCash = filter?.method === 'cash'; // cash is a balance ledger too, but not a "bank" one
    const monthName = new Date(`${month}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    const opening = Number(data?.opening_balance ?? 0);
    const closing = rows.length ? Number(rows[rows.length - 1].cumRun) : opening;
    const credits = rows.filter(e => e.entry_type === 'top_up').reduce((a, e) => a + Number(e.amount), 0);
    const debits = rows.filter(e => e.entry_type === 'expense').reduce((a, e) => a + Number(e.amount), 0);
    const bodyRows = rows.map(e => `<tr>
        <td>${fmtDate(e.entry_date)}</td>
        <td>${e.entry_type === 'top_up' ? 'Top-up' : esc(e.category || '—')}</td>
        <td>${esc(e.paid_to || '—')}</td>
        <td>${esc(e.description || '')}</td>
        ${methodIsBalance
          ? `<td class="r green">${e.entry_type === 'top_up' ? inr(e.amount) : ''}</td>
             <td class="r red">${e.entry_type === 'expense' ? inr(e.amount) : ''}</td>`
          : `<td class="r">${inr(e.amount)}</td>`}
        <td class="r${Number(e.cumRun) < 0 ? ' red' : ''}">${inr(e.cumRun)}</td>
      </tr>`).join('');
    const table = methodIsBalance
      ? `<table>
          <thead><tr><th>Date</th><th>Category / Type</th><th>Paid To</th><th>Description</th>
            <th class="r">${isCash ? 'In (received)' : 'Credit (in)'}</th>
            <th class="r">${isCash ? 'Out (spent)' : 'Debit (out)'}</th><th class="r">Balance</th></tr></thead>
          <tbody>
            <tr class="open"><td colspan="6">Brought forward</td><td class="r${opening < 0 ? ' red' : ''}">${inr(opening)}</td></tr>
            ${bodyRows}
          </tbody>
          <tfoot><tr><td colspan="4">Totals for ${esc(monthName)}</td>
            <td class="r">${inr(credits)}</td><td class="r">${inr(debits)}</td>
            <td class="r${closing < 0 ? ' red' : ''}">${inr(closing)}</td></tr></tfoot>
        </table>`
      : `<table>
          <thead><tr><th>Date</th><th>Category</th><th>Paid To</th><th>Description</th>
            <th class="r">Amount</th><th class="r">Cumulative</th></tr></thead>
          <tbody>
            <tr class="open"><td colspan="5">Brought forward (still pending)</td><td class="r">${inr(opening)}</td></tr>
            ${bodyRows}
          </tbody>
          <tfoot><tr><td colspan="4">Total outstanding</td>
            <td class="r">${inr(debits)}</td><td class="r">${inr(closing)}</td></tr></tfoot>
        </table>`;
    const title = isCash ? 'Cash in Hand Statement'
      : methodIsBalance ? 'Bank Statement' : 'Unpaid Bank — Payments Pending';
    const summary = methodIsBalance
      ? `Opening <b>${inr(opening)}</b> · ${isCash ? 'Received' : 'Credits'} <b>${inr(credits)}</b> · ${isCash ? 'Spent' : 'Debits'} <b>${inr(debits)}</b> · Closing <b>${inr(closing)}</b>`
      : `Brought forward <b>${inr(opening)}</b> · Added in ${esc(monthName)} <b>${inr(debits)}</b> · Total outstanding <b>${inr(closing)}</b>`;
    const foot = isCash
      ? 'Cash-in-hand account of the PHE Account Statement ledger — in = cash top-ups (including bank withdrawals), out = cash paid out. Closing balance should match the physical cash box.'
      : methodIsBalance
      ? 'Bank account of the PHE Account Statement ledger — credits are deposits / top-ups, debits are payments made from the bank.'
      : `Amounts recorded but not yet paid from the bank as of ${new Date().toLocaleDateString('en-IN')} — once marked Paid, an entry moves to the Bank statement (under its original date).`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title} — ${esc(monthName)}</title>
      <style>
        body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111;margin:32px;font-size:12px}
        h1{font-size:18px;margin:0 0 2px} h2{font-size:14px;margin:0 0 2px;color:#333;font-weight:600}
        .meta{color:#555;font-size:11px;margin-bottom:12px}
        table{width:100%;border-collapse:collapse;margin-bottom:6px} th,td{border:1px solid #ccc;padding:5px 7px;text-align:left}
        th{background:#f3f3f3;font-size:11px} .r{text-align:right} tfoot td{font-weight:700;background:#fafafa}
        .open td{background:#fafafa;color:#555;font-size:11px;font-weight:600}
        .green{color:#15803d} .red{color:#b91c1c}
        .foot{margin-top:20px;color:#777;font-size:10px;border-top:1px solid #ccc;padding-top:6px}
        @media print{body{margin:12mm}}
      </style></head><body>
      <h1>Peena Heat Elements</h1>
      <h2>${title} — ${esc(monthName)}</h2>
      <div class="meta">Generated ${new Date().toLocaleDateString('en-IN')} · ${summary}</div>
      ${table}
      <div class="foot">${foot}</div>
      </body></html>`;
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(() => w.print(), 350);
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Wallet size={24} className="text-emerald-600" /> Account Statement
          </h1>
          <p className="text-gray-500 text-sm mt-0.5">Cash &amp; bank expense ledger — receipts required above ₹{data?.receipt_required_above ?? 500}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Month + Year dropdowns — pick any past month to see its entries
              (the table shows that month with its brought-forward balances). */}
          <select className="input w-auto text-sm" value={month.split('-')[1]}
            onChange={e => setMonth(`${month.split('-')[0]}-${e.target.value}`)}>
            {['January','February','March','April','May','June','July','August','September','October','November','December'].map((name, i) => {
              const v = String(i + 1).padStart(2, '0');
              return <option key={v} value={v}>{name}</option>;
            })}
          </select>
          <select className="input w-auto text-sm" value={month.split('-')[0]}
            onChange={e => setMonth(`${e.target.value}-${month.split('-')[1]}`)}>
            {Array.from({ length: new Date().getFullYear() - 2025 + 1 }, (_, i) => String(2025 + i)).map(yy => (
              <option key={yy} value={yy}>{yy}</option>
            ))}
          </select>
          <button className="btn-secondary flex items-center gap-1.5 text-sm"
            onClick={() => downloadExcel('petty-cash?account=cash', 'cash_in_hand.xlsx')}
            title="Export the Cash-in-Hand statement">
            <Download size={15} /> Cash-in-Hand
          </button>
          <button className="btn-secondary flex items-center gap-1.5 text-sm"
            onClick={() => downloadExcel('petty-cash', 'account_statement.xlsx')}>
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

      {/* Balance cards — bank balance and totals are owner-only; accounts keeps
          Cash in Hand (they manage the physical cash box) */}
      <div className={`grid gap-4 mb-6 ${isOwner ? 'grid-cols-2 md:grid-cols-5' : 'grid-cols-1 max-w-xs'}`}>
        <div className="card p-4">
          <div className="text-sm text-gray-500 flex items-center gap-1"><Wallet size={14} className="text-emerald-500" /> Cash in Hand</div>
          <div className={`text-2xl font-bold mt-1 ${Number(data?.cash_balance) < 0 ? 'text-red-600' : 'text-gray-900'}`}>
            {data ? inr(data.cash_balance) : '—'}
          </div>
        </div>
        {isOwner && (
          <>
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
          </>
        )}
      </div>

      {/* Owner-only: ledger accounts (each category + each Machinery company) */}
      {isOwner && ledgers && !isLedgerView && (
        <div className="mb-6">
          {/* Collapsed by default — the cards are a drill-down tool, not
              something to scroll past on every visit. */}
          <button type="button" onClick={() => setShowLedgers(v => !v)}
            className="w-full flex items-center gap-1.5 text-sm font-semibold text-gray-800 mb-2 hover:text-emerald-700 transition-colors">
            {showLedgers ? <ChevronDown size={15} className="text-emerald-600" /> : <ChevronRight size={15} className="text-emerald-600" />}
            <BookOpen size={15} className="text-emerald-600" /> Ledger Accounts
            <span className="text-gray-400 font-normal">(owner only)</span>
            <span className="text-xs text-gray-400 font-normal ml-auto">
              {showLedgers ? 'hide' : `${ledgers.categories.length + (ledgers.methods?.length || 0) + ledgers.companies.length} accounts — show`}
            </span>
          </button>
          {showLedgers && (<>
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
          {ledgers.methods?.length > 0 && (
            <>
              <h3 className="text-xs font-semibold text-gray-500 mt-3 mb-1.5 flex items-center gap-1"><Landmark size={13} /> By payment method</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {ledgers.methods.map(m => (
                  <button key={m.key} onClick={() => setFilter({ method: m.key })}
                    className="card p-3 text-left hover:border-emerald-300 transition-colors">
                    <div className="text-sm font-medium text-gray-800 truncate">{m.label}{m.balance ? ' Balance' : ''}</div>
                    <div className={`text-lg font-bold ${m.total < 0 ? 'text-red-600' : 'text-gray-900'}`}>{inr(m.total)}</div>
                    <div className="text-xs text-gray-400">{m.count} entr{m.count == 1 ? 'y' : 'ies'}</div>
                  </button>
                ))}
              </div>
            </>
          )}
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
          </>)}
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
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-gray-800">{ledgerTitle} ledger</h2>
            {filter?.method && (
              <button className="btn-secondary flex items-center gap-1.5 text-sm" onClick={printStatement}
                disabled={loading || !data} title="Print this ledger as a statement (save as PDF from the print dialog)">
                <Printer size={15} /> Print Statement
              </button>
            )}
          </div>
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
                <th className="table-header text-right">{runLabel}</th>
              ) : (
                <>
                  <th className="table-header text-right">Cash Bal.</th>
                  {isOwner && <th className="table-header text-right">Bank Bal.</th>}
                </>
              )}
              <th className="table-header text-center">Receipt</th>
              <th className="table-header text-left">By</th>
              {isOwner && <th className="table-header text-center">Actions</th>}
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
                      {isOwner && <td className="table-cell text-right text-xs font-semibold text-gray-600">{inr(data.opening_bank)}</td>}
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
                          {isOwner && <td className={`table-cell text-right text-sm font-medium ${e.bankRun < 0 ? 'text-red-600' : 'text-gray-700'}`}>{inr(e.bankRun)}</td>}
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
                          <button className="p-1 text-red-400 hover:text-red-600" onClick={() => handleDelete(e)} title="Delete entry">
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
    emp_expense_type: '', employee_id: '',
  });
  const [categories, setCategories] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [receipt, setReceipt] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Machinery only: after the expense is saved, offer to add one or more parts
  // to inventory using the full inventory form (prefilled from this expense).
  const [addToInv, setAddToInv] = useState(false);
  const [showInvModal, setShowInvModal] = useState(false);
  const [partsAdded, setPartsAdded] = useState(0);   // how many parts stocked so far
  const [betweenParts, setBetweenParts] = useState(false); // "add another?" step
  // Plating Transportation: pick which Nickel/Electropolish/Teflon items this trip
  // carries (send out or bring back) — one cash bill shared across them.
  const [platingDir, setPlatingDir] = useState('sent');   // 'sent' | 'returned'
  const [platingItems, setPlatingItems] = useState([]);   // eligible order items
  const [platingSel, setPlatingSel] = useState({});       // order_item_id -> true
  const [platingVendor, setPlatingVendor] = useState('');
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));

  useEffect(() => {
    if (isTopUp) return;
    // Hide the system-managed 'Salary' category from manual entry
    // Hide system-managed categories from manual entry: Salary (payroll),
    // Purchase Payment (Payments Due) and Purchase Transport (PO receive).
    api.get('/petty-cash/categories').then(r => setCategories((r.data || []).filter(c => !['Salary', 'Purchase Payment', 'Purchase Transport'].includes(c)))).catch(() => {});
    api.get('/petty-cash/companies').then(r => setCompanies(r.data || [])).catch(() => {});
    api.get('/payroll/employees').then(r => setEmployees((r.data || []).filter(e => e.active))).catch(() => {});
  }, []);

  const isMachinery = f.category === MACHINERY;
  const isSampling = f.category === SAMPLING;
  const isEmpExpense = f.category === EMPLOYEE_EXPENSE;
  const isPlating = f.category === PLATING;
  const isPlatingTransport = f.category === PLATING_TRANSPORT;
  const isBankWithdrawal = f.category === BANK_WITHDRAWAL;
  const empNeedsWorker = isEmpExpense && EMP_TYPES_WORKER.includes(f.emp_expense_type);
  const needsReceipt = !isTopUp && !isPlatingTransport && !isBankWithdrawal && parseFloat(f.amount) > receiptLimit;

  // Load the eligible plating items whenever the trip direction changes
  useEffect(() => {
    if (!isPlatingTransport) return;
    setPlatingSel({});
    api.get(`/plating/eligible?direction=${platingDir}`).then(r => setPlatingItems(r.data || [])).catch(() => setPlatingItems([]));
  }, [isPlatingTransport, platingDir]);
  const platingSelIds = Object.keys(platingSel).map(Number);
  const platingShare = platingSelIds.length && parseFloat(f.amount) > 0
    ? Math.round((parseFloat(f.amount) / platingSelIds.length) * 100) / 100 : 0;

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
      if (isEmpExpense) {
        if (!f.emp_expense_type) return setError('Pick the expense type.');
        if (empNeedsWorker && !f.employee_id) return setError('Select the employee.');
        if (!empNeedsWorker && !f.paid_to.trim()) return setError('Paid To is required.');
      } else if (!isBankWithdrawal && !f.paid_to.trim()) {
        return setError('Paid To is required.');
      }
      if (isMachinery && !f.description.trim()) return setError('Description is required for Machinery.');
      if (isPlating && !receipt) return setError('A payment QR is required for Plating.');
      if (isPlatingTransport && platingSelIds.length === 0) return setError('Select the item(s) this transport carried.');
      if (isSampling) {
        if (!f.item_name.trim()) return setError('Item name is required for Sampling.');
        if (!f.unit.trim()) return setError('Unit is required for Sampling.');
        if (!(parseFloat(f.sample_qty) > 0)) return setError('Enter a valid sample quantity.');
      }
      if (needsReceipt && !receipt) return setError(`A receipt/bill photo is required for expenses above ₹${receiptLimit}.`);
    }
    setSaving(true);
    try {
      // Plating Transportation posts as a plating trip: the server records the
      // items' send/return status AND creates the cash ledger entry in one go.
      if (isPlatingTransport) {
        await api.post('/plating/trips', {
          direction: platingDir, item_ids: platingSelIds, vendor: platingVendor,
          paid_to: f.paid_to.trim(), transport_cost: f.amount,
          trip_date: f.entry_date, notes: f.description,
        });
        onSaved();
        return;
      }
      const fd = new FormData();
      fd.append('entry_type', type);
      fd.append('entry_date', f.entry_date);
      fd.append('amount', f.amount);
      fd.append('payment_method', isPlating ? 'unpaid_bank' : f.payment_method);
      if (!isTopUp) {
        fd.append('category', f.category);
        // For worker-linked employee expenses the payee is the selected worker
        if (!empNeedsWorker) fd.append('paid_to', f.paid_to.trim());
      }
      if (!isTopUp && isEmpExpense) {
        fd.append('emp_expense_type', f.emp_expense_type);
        if (empNeedsWorker) fd.append('employee_id', f.employee_id);
      }
      if (!isTopUp && isSampling) {
        fd.append('item_name', f.item_name.trim());
        fd.append('item_category', f.item_category);
        fd.append('unit', f.unit.trim());
        fd.append('sample_qty', f.sample_qty);
      }
      if (f.description && !isEmpExpense) fd.append('description', f.description);
      if (receipt) fd.append('receipt', receipt);
      await api.post('/petty-cash', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      // Machinery + "add to inventory" checked → keep the flow open and hand off
      // to the full inventory form; otherwise finish as usual.
      if (isMachinery && addToInv) { setShowInvModal(true); setSaving(false); }
      else onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to record entry');
      setSaving(false);
    }
  };

  // The machinery expense is already recorded — now collect the full inventory
  // details for each part it brought. The user can add as many parts as needed;
  // every part is optional, so finishing at any point keeps the saved expense.
  const invNotes = f.paid_to ? `Machinery purchased from ${f.paid_to}` : '';

  // "Add another part?" step shown after each part is stocked.
  if (betweenParts) {
    return (
      <Modal open title="Parts added to inventory" onClose={onSaved}>
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2.5 text-sm">
            <CheckCircle size={16} className="flex-shrink-0" />
            {partsAdded} part{partsAdded === 1 ? '' : 's'} added for this machinery expense.
          </div>
          <p className="text-sm text-gray-600">Did this purchase include another part to stock?</p>
          <div className="flex gap-3 pt-1">
            <button type="button" className="btn-secondary flex-1" onClick={onSaved}>Done</button>
            <button type="button" className="btn-primary flex-1"
              onClick={() => { setBetweenParts(false); setShowInvModal(true); }}>
              <Boxes size={15} /> Add another part
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  if (showInvModal) {
    // First part is prefilled from the expense; extra parts start blank (the
    // amount covers the whole purchase, so per-part price/qty is entered fresh).
    const initial = partsAdded === 0
      ? { name: f.description.trim(), category: 'Machinery', unit: 'nos', current_stock: 1, unit_cost: f.amount, notes: invNotes }
      : { category: 'Machinery', unit: 'nos', current_stock: 1, notes: invNotes };
    return (
      <InventoryItemModal
        key={partsAdded}
        initial={initial}
        note={`Adding part ${partsAdded + 1} for this machinery purchase${partsAdded > 0 ? ` (${partsAdded} already added)` : ''}. After you add it, you can add another part or finish.`}
        submitLabel="Add Part"
        onSave={() => { setPartsAdded(n => n + 1); setShowInvModal(false); setBetweenParts(true); }}
        onClose={() => { if (partsAdded > 0) setBetweenParts(true); else onSaved(); }}
      />
    );
  }

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
          <select className="input" value={f.payment_method} onChange={set('payment_method')} disabled={isPlating || isPlatingTransport || isBankWithdrawal}>
            {!isTopUp && <option value="">— select —</option>}
            <option value="cash">Cash{isTopUp ? ' in Hand' : ''}</option>
            <option value="paid_bank">{isTopUp ? 'Bank' : 'Paid Bank'}</option>
            {!isTopUp && <option value="unpaid_bank">Unpaid Bank (pending — no deduction yet)</option>}
          </select>
          {isPlating && (
            <p className="text-[11px] text-amber-700 mt-1">Plating always goes to Unpaid Bank first — the owner marks it Paid to deduct the Bank.</p>
          )}
          {isPlatingTransport && (
            <p className="text-[11px] text-emerald-700 mt-1">Plating transport is always paid in Cash.</p>
          )}
          {isBankWithdrawal && (
            <p className="text-[11px] text-emerald-700 mt-1">Withdraws from the Bank and adds the same amount to Cash in Hand (a linked cash top-up is recorded automatically).</p>
          )}
          {!isPlating && f.payment_method === 'unpaid_bank' && (
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
              <select className="input" value={f.category}
                onChange={e => setF(p => ({ ...p, category: e.target.value, paid_to: '',
                  // Some categories lock the method (Plating → unpaid bank,
                  // Plating Transport → cash, Bank Withdrawal → paid bank).
                  // Leaving a forced category CLEARS the method instead of
                  // silently keeping the forced value — the user must re-pick.
                  payment_method: e.target.value === PLATING ? 'unpaid_bank'
                    : e.target.value === PLATING_TRANSPORT ? 'cash'
                    : e.target.value === BANK_WITHDRAWAL ? 'paid_bank'
                    : [PLATING, PLATING_TRANSPORT, BANK_WITHDRAWAL].includes(p.category) ? '' : p.payment_method }))}>
                <option value="">— select category —</option>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            {isEmpExpense ? (
              <div className="border border-sky-200 bg-sky-50/50 rounded-xl p-3 space-y-3">
                <div>
                  <label className="label">Description <span className="text-red-500">*</span></label>
                  <select className="input" value={f.emp_expense_type}
                    onChange={e => setF(p => ({ ...p, emp_expense_type: e.target.value, employee_id: '', paid_to: '' }))}>
                    <option value="">— select type —</option>
                    {EMP_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                {empNeedsWorker ? (
                  <div>
                    <label className="label">Employee <span className="text-red-500">*</span></label>
                    <select className="input" value={f.employee_id} onChange={set('employee_id')}>
                      <option value="">— select worker —</option>
                      {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                    </select>
                    {f.emp_expense_type === 'Advance Paid' && (
                      <p className="text-[11px] text-sky-700 mt-1">This advance is added to the worker's payroll and auto-deducted from their next salary.</p>
                    )}
                  </div>
                ) : f.emp_expense_type ? (
                  <div>
                    <label className="label">Paid To <span className="text-red-500">*</span></label>
                    <input className="input" value={f.paid_to} onChange={set('paid_to')} placeholder="Person / shop / description" />
                  </div>
                ) : null}
              </div>
            ) : isBankWithdrawal ? (
              <div className="text-sm rounded-xl px-3 py-2.5 bg-emerald-50 border border-emerald-200 text-emerald-800">
                Bank → Cash in Hand transfer: no payee needed. The Bank balance drops and Cash in Hand rises by the amount above, as two linked entries.
              </div>
            ) : (
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
                ) : isPlating ? (
                  <select className="input" value={f.paid_to} onChange={set('paid_to')}>
                    <option value="">— select plating company —</option>
                    {PLATING_COMPANIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                ) : (
                  <input className="input" value={f.paid_to} onChange={set('paid_to')}
                    placeholder={isSampling ? 'Prospective supplier name' : 'Shop / person / company'} />
                )}
              </div>
            )}

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

            {isPlatingTransport && (
              <div className="border border-cyan-200 bg-cyan-50/50 rounded-xl p-3 space-y-3">
                <p className="text-xs text-cyan-700 font-medium flex items-center gap-1">
                  <Droplets size={13} /> Which items did this transport carry? Paid To above is the transporter.
                </p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setPlatingDir('sent')}
                    className={`btn-sm rounded-lg px-3 py-1.5 text-xs font-medium border ${platingDir === 'sent' ? 'bg-cyan-600 text-white border-cyan-600' : 'bg-white text-gray-600 border-gray-200'}`}>
                    Sending to plating
                  </button>
                  <button type="button" onClick={() => setPlatingDir('returned')}
                    className={`btn-sm rounded-lg px-3 py-1.5 text-xs font-medium border ${platingDir === 'returned' ? 'bg-cyan-600 text-white border-cyan-600' : 'bg-white text-gray-600 border-gray-200'}`}>
                    Returning from plating
                  </button>
                </div>
                {platingDir === 'sent' && (
                  <div>
                    <label className="label">Plating vendor</label>
                    <select className="input" value={platingVendor} onChange={e => setPlatingVendor(e.target.value)}>
                      <option value="">— select —</option>
                      {PLATING_COMPANIES.map(v => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label className="label">Items ({platingDir === 'sent' ? 'ready to send' : 'currently out for plating'}) <span className="text-red-500">*</span></label>
                  {platingItems.length === 0 ? (
                    <p className="text-xs text-gray-400 bg-white border border-gray-100 rounded-lg px-3 py-2">
                      {platingDir === 'sent' ? 'No Nickel-Plating / Electropolish / Teflon-Coating items are ready to send.' : 'Nothing is currently out for plating.'}
                    </p>
                  ) : (
                    <div className="max-h-44 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-50 bg-white">
                      {platingItems.map(it => {
                        const checked = !!platingSel[it.order_item_id];
                        return (
                          <button type="button" key={it.order_item_id}
                            onClick={() => setPlatingSel(p => { const n = { ...p }; if (n[it.order_item_id]) delete n[it.order_item_id]; else n[it.order_item_id] = true; return n; })}
                            className={`w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-50 ${checked ? 'bg-cyan-50/60' : ''}`}>
                            {checked ? <CheckSquare size={15} className="text-cyan-600 flex-shrink-0" /> : <Square size={15} className="text-gray-300 flex-shrink-0" />}
                            <span className="text-sm text-gray-800 truncate">{it.drawing_number || it.product_code}</span>
                            <span className="text-xs text-gray-400 truncate">{it.order_code} · {it.plating_instructions} · qty {it.quantity}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                {platingShare > 0 && (
                  <p className="text-[11px] text-cyan-800">
                    {platingSelIds.length} item(s) — per-item transport share: <b>₹{platingShare.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</b>
                  </p>
                )}
              </div>
            )}

            {!isEmpExpense && (
              <div>
                <label className="label">Description {isMachinery ? <span className="text-red-500">*</span> : <span className="text-gray-400 font-normal">(optional)</span>}</label>
                <input className="input" value={f.description} onChange={set('description')} />
              </div>
            )}

            {isMachinery && (
              <label className="flex items-start gap-2.5 border border-emerald-200 bg-emerald-50/50 rounded-xl p-3 cursor-pointer">
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-emerald-600 flex-shrink-0"
                  checked={addToInv} onChange={e => setAddToInv(e.target.checked)} />
                <span className="text-sm text-emerald-800">
                  <span className="font-medium flex items-center gap-1"><Boxes size={14} /> Also add part(s) to inventory</span>
                  <span className="block text-xs text-emerald-700 mt-0.5">After saving the expense, add one or more parts — each with the full inventory details (item code, unit, stock, price…).</span>
                </span>
              </label>
            )}

            <div>
              <label className="label">
                {isPlating
                  ? <>Payment QR <span className="text-red-500">*</span></>
                  : <>Receipt / Bill {needsReceipt ? <span className="text-red-500">*</span> : <span className="text-gray-400 font-normal">(optional below ₹{receiptLimit})</span>}</>}
              </label>
              <label className="flex items-center gap-2 cursor-pointer border border-gray-200 rounded-lg px-3 py-2 hover:border-brand-400 transition-colors bg-gray-50">
                <Upload size={15} className="text-gray-400 flex-shrink-0" />
                <span className="text-sm text-gray-600 flex-1 truncate">{receipt ? receipt.name : (isPlating ? 'Attach the payment QR (image / PDF)…' : 'Attach receipt photo / PDF…')}</span>
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
            {saving ? 'Saving…' : isTopUp ? 'Add Top-up' : (isMachinery && addToInv) ? 'Save & Add to Inventory' : 'Record Expense'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
