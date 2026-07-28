import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../lib/api';
import { fmtDate } from '../../lib/utils';
import { Wallet, ArrowLeft, Send, AlertTriangle, CheckSquare, Square, FileDown } from 'lucide-react';

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const monthLabel = (key) => new Date(`${key}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

// Monthly purchase-payment planning. Bills are grouped by their PO month; the
// account manager can select individual bills or a whole month (full or partial),
// export a payables report for external review, then post the selected bills as
// Unpaid-Bank entries. The owner later marks those Paid, deducting the Bank.
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

  // Group by the RECEIVED month (YYYY-MM), oldest month first so the longest-
  // outstanding dues surface at the top.
  const groups = useMemo(() => {
    const m = new Map();
    for (const b of bills) {
      const key = (b.received_at || '').slice(0, 7) || 'unknown';
      if (!m.has(key)) m.set(key, { key, label: key === 'unknown' ? 'Undated' : monthLabel(key), bills: [], total: 0 });
      const g = m.get(key); g.bills.push(b); g.total += b.remaining;
    }
    return Array.from(m.values()).sort((a, b) => a.key.localeCompare(b.key));
  }, [bills]);

  const setAmount = (b, v) => setSel(prev => ({ ...prev, [b.id]: v }));
  const toggle = (b) => setSel(prev => {
    const next = { ...prev };
    if (next[b.id] != null) delete next[b.id]; else next[b.id] = String(b.remaining);
    return next;
  });
  const monthChecked = (g) => g.bills.length > 0 && g.bills.every(b => sel[b.id] != null);
  const toggleMonth = (g) => setSel(prev => {
    const next = { ...prev };
    const all = g.bills.every(b => next[b.id] != null);
    if (all) g.bills.forEach(b => delete next[b.id]);
    else g.bills.forEach(b => { if (next[b.id] == null) next[b.id] = String(b.remaining); });
    return next;
  });
  const selectAll = () => setSel(Object.fromEntries(bills.map(b => [b.id, String(b.remaining)])));
  const clearAll = () => setSel({});

  const selectedIds = Object.keys(sel);
  const totalSelected = useMemo(
    () => selectedIds.reduce((s, id) => s + (parseFloat(sel[id]) || 0), 0),
    [sel] // eslint-disable-line react-hooks/exhaustive-deps
  );

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

  // Print-to-PDF report of the payables (grouped by month), including any amounts
  // currently proposed — for external review BEFORE anything hits the ledger.
  const exportPdf = () => {
    const w = window.open('', '_blank');
    if (!w) return setError('Allow pop-ups to export the report.');
    const section = (g) => `
      <h3>${esc(g.label)} <span class="muted">· received · ${g.bills.length} bill${g.bills.length > 1 ? 's' : ''} · outstanding ${inr(g.total)}</span></h3>
      <table>
        <thead><tr><th>Supplier</th><th>PO #</th><th>Received</th>
          <th class="r">Material</th><th class="r">GST %</th><th class="r">Payable</th>
          <th class="r">Paid</th><th class="r">Pending</th><th class="r">Remaining</th><th class="r">Proposed</th></tr></thead>
        <tbody>${g.bills.map(b => `<tr>
          <td>${esc(b.supplier_name)}</td><td>${esc(b.po_number)}</td><td>${fmtDate(b.received_at)}</td>
          <td class="r">${inr(b.material_value)}</td><td class="r">${b.igst_percent}%</td><td class="r">${inr(b.received_value)}</td>
          <td class="r">${b.paid_cleared > 0 ? inr(b.paid_cleared) : '—'}</td>
          <td class="r">${b.paid_pending > 0 ? inr(b.paid_pending) : '—'}</td><td class="r">${inr(b.remaining)}</td>
          <td class="r">${sel[b.id] != null ? inr(parseFloat(sel[b.id]) || 0) : '—'}</td></tr>`).join('')}</tbody>
      </table>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Purchase Payments Due</title>
      <style>
        body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111;margin:32px;font-size:12px}
        h1{font-size:18px;margin:0 0 2px} h3{font-size:13px;margin:22px 0 6px;border-bottom:2px solid #333;padding-bottom:3px}
        .muted{color:#777;font-weight:400;font-size:11px} .meta{color:#555;font-size:11px;margin-bottom:8px}
        table{width:100%;border-collapse:collapse;margin-bottom:6px} th,td{border:1px solid #ccc;padding:5px 7px;text-align:left}
        th{background:#f3f3f3;font-size:11px} .r{text-align:right} tfoot td{font-weight:700;background:#fafafa}
        .foot{margin-top:20px;color:#777;font-size:10px;border-top:1px solid #ccc;padding-top:6px}
        @media print{body{margin:12mm}}
      </style></head><body>
      <h1>Peena Heat Elements — Purchase Payments Due</h1>
      <div class="meta">Generated ${new Date().toLocaleDateString('en-IN')} · Total outstanding <b>${inr(totalRemaining)}</b>${totalSelected > 0 ? ` · Proposed this run <b>${inr(totalSelected)}</b>` : ''}</div>
      ${groups.map(section).join('')}
      <div class="foot">For external review — these bills have <b>not</b> yet been posted to the Unpaid-Bank ledger.</div>
      </body></html>`;
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(() => w.print(), 350);
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div>
          <h1 className="page-title flex items-center gap-2"><Wallet size={24} className="text-brand-600" /> Purchase Payments Due</h1>
          <p className="text-gray-500 text-sm mt-0.5">Received purchases with an outstanding balance, grouped by month.</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-secondary" onClick={exportPdf} disabled={bills.length === 0}><FileDown size={16} /> Export PDF</button>
          <Link to="/purchases" className="btn-secondary"><ArrowLeft size={16} /> Purchases</Link>
        </div>
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

      {!loading && bills.length > 0 && (
        <div className="flex items-center gap-3 mb-2 text-xs">
          <button className="text-brand-600 hover:underline" onClick={selectAll}>Select all</button>
          <span className="text-gray-300">|</span>
          <button className="text-gray-500 hover:underline" onClick={clearAll}>Clear</button>
        </div>
      )}

      {loading ? (
        <div className="card p-10 text-center text-gray-400">Loading…</div>
      ) : bills.length === 0 ? (
        <div className="card p-10 text-center text-gray-400">No purchases are due for payment right now. 🎉</div>
      ) : (
        groups.map(g => (
          <div key={g.key} className="card overflow-hidden mb-4">
            <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 border-b border-gray-200">
              <button onClick={() => toggleMonth(g)} className="flex items-center gap-2 text-sm font-semibold text-gray-700">
                {monthChecked(g) ? <CheckSquare size={16} className="text-brand-600" /> : <Square size={16} className="text-gray-400" />}
                {g.label}
                <span className="text-xs font-normal text-gray-400">· {g.bills.length} bill{g.bills.length > 1 ? 's' : ''}</span>
              </button>
              <span className="text-sm font-semibold text-red-700">{inr(g.total)}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-white border-b border-gray-100">
                  <tr>
                    <th className="table-header text-center w-10"></th>
                    <th className="table-header text-left">Supplier</th>
                    <th className="table-header text-left">PO #</th>
                    <th className="table-header text-left">Received</th>
                    <th className="table-header text-right" title="Material (rate × received qty) + PO's IGST %, rounded to the nearest rupee">Payable (incl. GST)</th>
                    <th className="table-header text-right">Paid</th>
                    <th className="table-header text-right">Pending</th>
                    <th className="table-header text-right">Remaining</th>
                    <th className="table-header text-right w-36">Pay This Month</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {g.bills.map(b => {
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
                        <td className="table-cell text-xs text-gray-500">{fmtDate(b.received_at)}</td>
                        <td className="table-cell text-right text-sm" title={`Material ${inr(b.material_value)} + ${b.igst_percent}% GST`}>{inr(b.received_value)}</td>
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
          </div>
        ))
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
