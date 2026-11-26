import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../lib/api';
import { fmtDate, istTodayInput } from '../../lib/utils';
import { useAuthStore } from '../../store/authStore';
import { Wallet, ArrowLeft, Send, AlertTriangle, CheckSquare, Square, FileDown } from 'lucide-react';

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const monthLabel = (key) => new Date(`${key}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

// Monthly purchase-payment planning. Bills are grouped by their PO month; the
// account manager can select individual bills or a whole month (full or partial),
// export a payables report for external review, then post the selected bills as
// Unpaid-Bank entries. The owner later marks those Paid, deducting the Bank.
export default function PurchasePaymentsDue() {
  const { user } = useAuthStore();
  const isOwner = user?.role === 'owner';
  const [bills, setBills] = useState([]);
  // The rest of the Account Statement's Unpaid Bank — not linked to a PO (owner, 26 Nov 2026).
  const [otherUnpaid, setOtherUnpaid] = useState([]);
  const [otherTotal, setOtherTotal] = useState(0);
  const [banks, setBanks] = useState([]);
  const [paying, setPaying] = useState(null);   // { id, bank, paidOn, external }
  const [payBusy, setPayBusy] = useState(false);
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
      .then(r => { setBills(r.data.bills || []); setTotalRemaining(r.data.total_remaining || 0);
        setOtherUnpaid(r.data.other_unpaid || []); setOtherTotal(r.data.other_unpaid_total || 0); })
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { if (isOwner) api.get('/petty-cash/bank-accounts').then(r => setBanks((r.data || []).filter(b => b.active !== false))).catch(() => {}); }, [isOwner]);

  // Mark one of the leftover unpaid entries paid, as on the Account Statement:
  // which bank paid it and the day the money left (or paid externally).
  const markPaid = async () => {
    if (!paying) return;
    if (!paying.external && !paying.bank) return setError('Choose which bank account paid it.');
    setPayBusy(true); setError(''); setMsg('');
    try {
      await api.put(`/petty-cash/${paying.id}/mark-paid`, paying.external
        ? { paid_external: true, paid_on: paying.paidOn } : { bank_account_id: Number(paying.bank), paid_on: paying.paidOn });
      setPaying(null); setMsg('Marked paid — it is now on the Account Statement as paid.'); load();
    } catch (e) { setError(e.response?.data?.error || 'Could not mark it paid'); }
    finally { setPayBusy(false); }
  };

  // Group by the RECEIVED month (YYYY-MM), oldest month first so the longest-
  // outstanding dues surface at the top. A PO that came in parts has one row per
  // delivery, each in the month it was received (owner, 5 Oct 2026).
  const groups = useMemo(() => {
    const m = new Map();
    for (const b of bills) {
      const key = b.month || (b.received_at || '').slice(0, 7) || 'unknown';
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
      payments.push({ po_id: b.po_id ?? b.id, amount: amt });
    }
    if (!payments.length) return setError('Select at least one bill to pay.');
    const over = bills.filter(b => sel[b.id] != null && (parseFloat(sel[b.id]) || 0) > b.remaining + 0.009)
      .map(b => `${b.po_number}: ${inr((parseFloat(sel[b.id]) || 0) - b.remaining)} more than due`);
    if (!window.confirm(`Send ${payments.length} payment(s) totalling ${inr(totalSelected)} to the Unpaid-Bank ledger? The owner then marks each Paid to deduct the Bank.`
      + (over.length ? `\n\nMore than the balance — ${over.join('; ')}. The extra comes off that supplier's next bill (or is noted on the PO if there is none).` : ''))) return;
    setSaving(true);
    try {
      const r = await api.post('/purchase-orders/payments-due/pay', { entry_date: entryDate, payments });
      setMsg(`${r.data.created} payment(s) sent to the Account Statement (Unpaid Bank).${(r.data.warnings || []).length ? ' ' + r.data.warnings.join(' · ') : ''}`);
      setSel({});
      load();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to record payments');
    } finally {
      setSaving(false);
    }
  };

  // Print-to-PDF in the owner's Debtors sheet layout (26 Nov 2026, "Debtors Dec
  // 2025.pdf"): one row per supplier / payee, one INV/DT column per outstanding
  // bill (date over amount), a TOTAL column, and a TOTAL row. Purchase bills and
  // the other unpaid Account Statement entries are in the same table. Amounts are
  // what is still outstanding on each bill.
  const exportPdf = () => {
    const w = window.open('', '_blank');
    if (!w) return setError('Allow pop-ups to export the report.');
    const ymd = (d) => { try { return new Date(d).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '.'); } catch { return ''; } };
    const num = (n) => { const v = Math.round(Number(n || 0) * 100) / 100; return v.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 }); };
    const money = (n) => `₹ ${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const bySupplier = new Map();
    const add = (name, date, amount) => {
      // Spellings of one payee are one row (owner, 26 Nov 2026: "all anjani are same").
      let key = String(name || '—').trim().toUpperCase();
      if (/^ANA?JANI\b/.test(key)) key = 'ANJANI TRANSPORT';
      if (!bySupplier.has(key)) bySupplier.set(key, []);
      bySupplier.get(key).push({ date, amount });
    };
    for (const b of bills) add(b.supplier_name, b.received_at, b.remaining);
    for (const e of otherUnpaid) add(e.paid_to || e.category, e.entry_date, e.amount);
    const names = [...bySupplier.keys()].sort((x, y) => x.localeCompare(y));
    for (const n of names) bySupplier.get(n).sort((x, y) => (new Date(x.date).getTime() || 0) - (new Date(y.date).getTime() || 0));
    const PER = 6;   // bills per line; a supplier with more continues on the next line
    const cols = Math.max(5, Math.min(PER, Math.max(0, ...names.map(n => bySupplier.get(n).length))));
    const grand = names.reduce((t, n) => t + bySupplier.get(n).reduce((x, bl) => x + bl.amount, 0), 0);
    const head = Array.from({ length: cols }, () => '<th>INV/DT</th>').join('');
    const rowsHtml = names.map(n => {
      const list = bySupplier.get(n), total = list.reduce((t, bl) => t + bl.amount, 0);
      const lines = []; for (let i = 0; i < list.length; i += cols) lines.push(list.slice(i, i + cols));
      return lines.map((ln, li) => `<tr>
        <td class="name">${li === 0 ? esc(n) : ''}</td>
        ${Array.from({ length: cols }, (_, i) => ln[i] ? `<td class="c"><div>${esc(ymd(ln[i].date))}</div><div>${num(ln[i].amount)}</div></td>` : '<td class="c"></td>').join('')}
        <td class="tot">${li === 0 ? money(total) : ''}</td></tr>`).join('');
    }).join('');
    const month = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', month: 'short', year: '2-digit' }).replace(' ', '-').toLowerCase();
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Payments Due ${month}</title>
      <style>
        @page{size:landscape;margin:12mm}
        body{font-family:Calibri,Arial,Helvetica,sans-serif;color:#000;margin:18px;font-size:11px}
        .title{text-align:center;font-size:11px;margin:0 0 2px}
        table{width:100%;border-collapse:collapse;border:1.5px solid #000;table-layout:fixed}
        th,td{border:1px solid #000;padding:2px 4px;vertical-align:bottom}
        th{text-align:left;font-weight:700} th:first-child{width:24%} th:last-child{width:14%}
        td.name{text-align:left;text-transform:uppercase} td.c{text-align:left} td.c div{line-height:1.25} td.tot{text-align:right;font-weight:700;white-space:nowrap}
        tr{page-break-inside:avoid}
        tfoot td{font-weight:700;text-align:center;border-top:1.5px solid #000} tfoot td.tot{text-align:right}
      </style></head><body>
      <div class="title">Payments Due ${esc(month)}</div>
      <table>
        <thead><tr><th>SUPPLIER NAME</th>${head}<th>TOTAL</th></tr></thead>
        <tbody>${rowsHtml || `<tr><td colspan="${cols + 2}" style="text-align:center">Nothing is due for payment.</td></tr>`}</tbody>
        <tfoot><tr><td colspan="${cols + 1}">TOTAL</td><td class="tot">${money(grand)}</td></tr></tfoot>
      </table>
      </body></html>`;
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(() => w.print(), 350);
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div>
          <h1 className="page-title flex items-center gap-2"><Wallet size={24} className="text-brand-600" /> Purchase Payments Due</h1>
          <p className="text-gray-500 text-sm mt-0.5">Received purchases with an outstanding balance, grouped by the month each delivery was received.</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-secondary" onClick={exportPdf} disabled={bills.length === 0 && otherUnpaid.length === 0}><FileDown size={16} /> Export PDF</button>
          <Link to="/purchases" className="btn-secondary"><ArrowLeft size={16} /> Purchases</Link>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 my-4">
        <div className="card p-4">
          <div className="text-xs text-gray-400 uppercase tracking-wide">Purchase Bills Outstanding</div>
          <div className="text-2xl font-bold text-red-700 mt-1">{inr(totalRemaining)}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs text-gray-400 uppercase tracking-wide">Other Unpaid Bills</div>
          <div className="text-2xl font-bold text-red-700 mt-1">{inr(otherTotal)}</div>
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
                    <th className="table-header text-right" title="Material (rate × received qty) + the PO's Packaging & Forwarding + the PO's IGST %, rounded to the nearest rupee">Payable (incl. GST)</th>
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
                        <td className="table-cell text-sm">
                          <Link to={`/purchases/${b.po_id ?? b.id}`} className="text-brand-600 hover:underline">{b.po_number}</Link>
                          {b.parts_count > 1 && <span className="ml-1.5 text-[10px] font-semibold bg-sky-100 text-sky-800 rounded px-1.5 py-0.5" title="This PO came in parts — each delivery is due in the month it was received">part {b.part_no} of {b.parts_count}</span>}
                        </td>
                        <td className="table-cell text-xs text-gray-500">{fmtDate(b.received_at)}</td>
                        <td className="table-cell text-right text-sm" title={`Material ${inr(b.material_value)}${b.packaging_forwarding > 0 ? ` + P&F ${inr(b.packaging_forwarding)}` : ''} + ${b.igst_percent}% GST${b.packaging_no_gst > 0 ? ` + packaging (no GST) ${inr(b.packaging_no_gst)}` : ''}${b.adjustment ? ` ${b.adjustment > 0 ? '+' : '−'} adjustment ${inr(Math.abs(b.adjustment))}` : ''}`}>{inr(b.received_value)}{b.adjustment ? <span className={`ml-1 text-[10px] font-semibold rounded px-1 py-0.5 ${b.adjustment > 0 ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`} title="Adjustment on this PO (no GST)">{b.adjustment > 0 ? '+' : '−'}adj</span> : null}</td>
                        <td className="table-cell text-right text-sm text-green-700">{b.paid_cleared > 0 ? inr(b.paid_cleared) : '—'}</td>
                        <td className="table-cell text-right text-sm text-amber-700">{b.paid_pending > 0 ? inr(b.paid_pending) : '—'}</td>
                        <td className="table-cell text-right text-sm font-bold text-red-700">{inr(b.remaining)}</td>
                        <td className="table-cell text-right">
                          {checked ? (
                            <div>
                              <input className="input text-sm py-1 px-2 text-right w-32" type="number" step="any" min="0"
                                value={sel[b.id]} onChange={e => setAmount(b, e.target.value)} />
                              {(parseFloat(sel[b.id]) || 0) > b.remaining + 0.009 && (
                                <div className="text-[10px] text-amber-700 mt-0.5 w-32 ml-auto leading-tight">{inr((parseFloat(sel[b.id]) || 0) - b.remaining)} more than due — comes off this supplier's next bill</div>
                              )}
                            </div>
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

      {/* The rest of the Account Statement's Unpaid Bank — not linked to a purchase order. */}
      {!loading && otherUnpaid.length > 0 && (
        <div className="card overflow-hidden mt-6">
          <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 border-b border-gray-200">
            <div className="text-sm font-semibold text-gray-700">
              Other unpaid bills <span className="text-xs font-normal text-gray-400">· from the Account Statement, not linked to a purchase order · {otherUnpaid.length} entr{otherUnpaid.length > 1 ? 'ies' : 'y'}</span>
            </div>
            <span className="text-sm font-semibold text-red-700">{inr(otherTotal)}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-white border-b border-gray-100">
                <tr>
                  <th className="table-header text-left">Date</th>
                  <th className="table-header text-left">Category</th>
                  <th className="table-header text-left">Paid to</th>
                  <th className="table-header text-left">Description</th>
                  <th className="table-header text-right">Amount</th>
                  {isOwner && <th className="table-header text-right w-28"></th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {otherUnpaid.map(e => (
                  <tr key={e.id} className="hover:bg-gray-50 align-top">
                    <td className="table-cell text-xs text-gray-500 whitespace-nowrap">{fmtDate(e.entry_date)}</td>
                    <td className="table-cell text-sm">{e.category || '—'}</td>
                    <td className="table-cell text-sm font-medium text-gray-800">{e.paid_to || '—'}</td>
                    <td className="table-cell text-sm text-gray-600">{e.description || '—'}</td>
                    <td className="table-cell text-right text-sm font-bold text-red-700 whitespace-nowrap">{inr(e.amount)}</td>
                    {isOwner && (
                      <td className="table-cell text-right">
                        {paying?.id === e.id ? (
                          <div className="flex flex-col items-end gap-1.5">
                            <label className="flex items-center gap-1 text-[11px] text-gray-500">
                              <input type="checkbox" checked={paying.external} onChange={ev => setPaying({ ...paying, external: ev.target.checked })} /> paid externally
                            </label>
                            {!paying.external && (
                              <select className="input text-xs py-1 w-32" value={paying.bank} onChange={ev => setPaying({ ...paying, bank: ev.target.value })}>
                                <option value="">Bank…</option>
                                {banks.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                              </select>
                            )}
                            <input className="input text-xs py-1 w-32" type="date" max={istTodayInput()} value={paying.paidOn} onChange={ev => setPaying({ ...paying, paidOn: ev.target.value })} />
                            <div className="flex gap-1">
                              <button className="btn-primary btn-sm" onClick={markPaid} disabled={payBusy}>{payBusy ? '…' : 'Mark paid'}</button>
                              <button className="btn-secondary btn-sm" onClick={() => { setPaying(null); setError(''); }}>Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <button className="btn-secondary btn-sm" onClick={() => { setPaying({ id: e.id, bank: banks[0] ? String(banks[0].id) : '', paidOn: istTodayInput(), external: false }); setError(''); }}>Mark paid</button>
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
