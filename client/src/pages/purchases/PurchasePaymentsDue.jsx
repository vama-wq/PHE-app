import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../lib/api';
import { fmtDate } from '../../lib/utils';
import { Wallet, ArrowLeft, Send, AlertTriangle, CheckSquare, Square } from 'lucide-react';

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Monthly purchase-payment planning. Lists received (QC-approved) purchases that
// still owe money; the account manager picks which bills to pay this month (full
// or partial) and each posts one Unpaid-Bank entry to the Account Statement. The
// owner later marks those Paid, which deducts the Bank balance.
export default function PurchasePaymentsDue() {
  const [bills, setBills] = useState([]);
  const [totalRemaining, setTotalRemaining] = useState(0);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState({});            // po_id -> amount string (present only if selected)
  const [entryDate, setEntryDate] = useState(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const load = () => {
    setLoading(true);
    api.get('/purchase-orders/payments-due')
      .then(r => { setBills(r.data.bills || []); setTotalRemaining(r.data.total_remaining || 0); })
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const toggle = (b) => setSel(prev => {
    const next = { ...prev };
    if (next[b.id] != null) delete next[b.id];
    else next[b.id] = String(b.remaining);
    return next;
  });
  const setAmount = (b, v) => setSel(prev => ({ ...prev, [b.id]: v }));

  const selectedIds = Object.keys(sel);
  const totalSelected = useMemo(
    () => selectedIds.reduce((s, id) => s + (parseFloat(sel[id]) || 0), 0),
    [sel] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const allSelected = bills.length > 0 && selectedIds.length === bills.length;
  const toggleAll = () => {
    if (allSelected) setSel({});
    else setSel(Object.fromEntries(bills.map(b => [b.id, String(b.remaining)])));
  };

  const submit = async () => {
    setError(''); setMsg('');
    const payments = [];
    for (const b of bills) {
      if (sel[b.id] == null) continue;
      const amt = Math.round((parseFloat(sel[b.id]) || 0) * 100) / 100;
      if (!(amt > 0)) return setError(`Enter a valid amount for ${b.po_number}.`);
      if (amt > b.remaining + 0.009) return setError(`${b.po_number}: amount can't exceed remaining ${inr(b.remaining)}.`);
      payments.push({ po_id: b.id, amount: amt });
    }
    if (!payments.length) return setError('Select at least one bill to pay.');
    if (!window.confirm(`Send ${payments.length} payment(s) totalling ${inr(totalSelected)} to the Unpaid-Bank ledger? The owner then marks each Paid to deduct the Bank.`)) return;
    setSaving(true);
    try {
      const r = await api.post('/purchase-orders/payments-due/pay', { entry_date: entryDate, payments });
      setMsg(`${r.data.created} payment(s) sent to the Account Statement (Unpaid Bank).`);
      setSel({});
      load();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to record payments');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h1 className="page-title flex items-center gap-2"><Wallet size={24} className="text-brand-600" /> Purchase Payments Due</h1>
          <p className="text-gray-500 text-sm mt-0.5">Received purchases with an outstanding balance — select the bills to pay this month.</p>
        </div>
        <Link to="/purchases" className="btn-secondary"><ArrowLeft size={16} /> Purchases</Link>
      </div>

      <div className="grid grid-cols-3 gap-4 my-4">
        <div className="card p-4">
          <div className="text-xs text-gray-400 uppercase tracking-wide">Total Outstanding</div>
          <div className="text-2xl font-bold text-red-700 mt-1">{inr(totalRemaining)}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs text-gray-400 uppercase tracking-wide">Bills Selected</div>
          <div className="text-2xl font-bold text-gray-800 mt-1">{selectedIds.length}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs text-gray-400 uppercase tracking-wide">Selected to Pay</div>
          <div className="text-2xl font-bold text-brand-700 mt-1">{inr(totalSelected)}</div>
        </div>
      </div>

      <div className="text-xs text-gray-600 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mb-4 flex items-start gap-2">
        <AlertTriangle size={14} className="text-amber-500 flex-shrink-0 mt-0.5" />
        <span>Selected bills post to the Account Statement as <b>Unpaid Bank</b> entries (one per bill). The owner then marks each <b>Paid</b>, which deducts the Bank balance. A partial amount leaves the rest outstanding for a later month.</span>
      </div>

      {loading ? (
        <div className="card p-10 text-center text-gray-400">Loading…</div>
      ) : bills.length === 0 ? (
        <div className="card p-10 text-center text-gray-400">No purchases are due for payment right now. 🎉</div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="table-header text-center w-10">
                  <button onClick={toggleAll} title="Select all">
                    {allSelected ? <CheckSquare size={16} className="text-brand-600" /> : <Square size={16} className="text-gray-400" />}
                  </button>
                </th>
                <th className="table-header text-left">Supplier</th>
                <th className="table-header text-left">PO #</th>
                <th className="table-header text-left">Received</th>
                <th className="table-header text-right">Received Value</th>
                <th className="table-header text-right">Paid</th>
                <th className="table-header text-right">Pending</th>
                <th className="table-header text-right">Remaining</th>
                <th className="table-header text-right w-36">Pay This Month</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {bills.map(b => {
                const checked = sel[b.id] != null;
                return (
                  <tr key={b.id} className={`hover:bg-gray-50 ${checked ? 'bg-brand-50/40' : ''}`}>
                    <td className="table-cell text-center">
                      <button onClick={() => toggle(b)}>
                        {checked ? <CheckSquare size={16} className="text-brand-600" /> : <Square size={16} className="text-gray-400" />}
                      </button>
                    </td>
                    <td className="table-cell text-sm font-medium text-gray-800">{b.supplier_name}</td>
                    <td className="table-cell text-sm"><Link to={`/purchases/${b.id}`} className="text-brand-600 hover:underline">{b.po_number}</Link></td>
                    <td className="table-cell text-xs text-gray-500">{fmtDate(b.created_at)}</td>
                    <td className="table-cell text-right text-sm">{inr(b.received_value)}</td>
                    <td className="table-cell text-right text-sm text-green-700">{b.paid_cleared > 0 ? inr(b.paid_cleared) : '—'}</td>
                    <td className="table-cell text-right text-sm text-amber-700">{b.paid_pending > 0 ? inr(b.paid_pending) : '—'}</td>
                    <td className="table-cell text-right text-sm font-bold text-red-700">{inr(b.remaining)}</td>
                    <td className="table-cell text-right">
                      {checked ? (
                        <input className="input text-sm py-1 px-2 text-right w-32" type="number" step="any" min="0" max={b.remaining}
                          value={sel[b.id]} onChange={e => setAmount(b, e.target.value)} />
                      ) : <span className="text-xs text-gray-300">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {error && <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg mt-4">{error}</p>}
      {msg && <p className="text-green-700 text-sm bg-green-50 px-3 py-2 rounded-lg mt-4">{msg}</p>}

      {bills.length > 0 && (
        <div className="flex items-center justify-between mt-4 flex-wrap gap-3">
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <label>Payment date</label>
            <input className="input w-auto py-1.5" type="date" value={entryDate} onChange={e => setEntryDate(e.target.value)} />
          </div>
          <button className="btn-primary" disabled={saving || selectedIds.length === 0} onClick={submit}>
            <Send size={16} /> {saving ? 'Sending…' : `Send to Payments — ${inr(totalSelected)}`}
          </button>
        </div>
      )}
    </div>
  );
}
