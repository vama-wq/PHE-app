import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../lib/api';
import { fmtDate } from '../../lib/utils';
import { Droplets, Send, PackageCheck, CheckSquare, Square, History } from 'lucide-react';

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const VENDORS = ['A S Plating', 'Aesha Plating', 'Akshar Enterprise'];

// Plating transport tracker. Nickel-Plating / Electropolish order items are sent
// out for plating and come back; each trip is one Cash transport bill shared by
// the items in it (per-item share = cost ÷ items). Sent → Returned is tracked
// per item, so accounts can see what's currently out and the full trip history.
export default function PlatingTransport() {
  const [direction, setDirection] = useState('sent');   // 'sent' | 'returned'
  const [eligible, setEligible] = useState([]);
  const [sel, setSel] = useState({});                   // order_item_id -> true
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ vendor: '', paid_to: '', transport_cost: '', trip_date: new Date().toISOString().slice(0, 10), notes: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const loadEligible = () => {
    setLoading(true);
    api.get(`/plating/eligible?direction=${direction}`).then(r => setEligible(r.data || [])).finally(() => setLoading(false));
  };
  const loadTrips = () => api.get('/plating/trips').then(r => setTrips(r.data || [])).catch(() => {});
  useEffect(() => { setSel({}); loadEligible(); /* eslint-disable-next-line */ }, [direction]);
  useEffect(() => { loadTrips(); }, []);

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const toggle = (id) => setSel(p => { const n = { ...p }; if (n[id]) delete n[id]; else n[id] = true; return n; });
  const selectedIds = Object.keys(sel).map(Number);
  const perItemShare = selectedIds.length && parseFloat(form.transport_cost) > 0
    ? Math.round((parseFloat(form.transport_cost) / selectedIds.length) * 100) / 100 : 0;

  const submit = async () => {
    setError(''); setMsg('');
    if (!selectedIds.length) return setError('Select at least one item.');
    if (!(parseFloat(form.transport_cost) >= 0)) return setError('Enter a valid transport cost.');
    if (!form.paid_to.trim()) return setError('Enter who the transport was paid to.');
    setSaving(true);
    try {
      await api.post('/plating/trips', {
        direction, item_ids: selectedIds, vendor: form.vendor, paid_to: form.paid_to,
        transport_cost: form.transport_cost, trip_date: form.trip_date, notes: form.notes,
      });
      setMsg(`${direction === 'sent' ? 'Sent' : 'Returned'} ${selectedIds.length} item(s) · ${inr(form.transport_cost)} (${inr(perItemShare)}/item, cash)`);
      setSel({}); setForm(f => ({ ...f, transport_cost: '', notes: '' }));
      loadEligible(); loadTrips();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to record trip');
    } finally { setSaving(false); }
  };

  const tabCls = (active) => `btn-sm rounded-lg px-3 py-1.5 text-sm font-medium border flex items-center gap-1.5 ${active ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-4">
        <h1 className="page-title flex items-center gap-2"><Droplets size={24} className="text-brand-600" /> Plating Transport</h1>
        <p className="text-gray-500 text-sm mt-0.5">Send Nickel-Plating / Electropolish items out for plating and log the transport, then record their return. One transport bill per trip is shared across its items and paid in cash.</p>
      </div>

      <div className="flex gap-2 mb-4">
        <button onClick={() => setDirection('sent')} className={tabCls(direction === 'sent')}><Send size={14} /> Send to Plating</button>
        <button onClick={() => setDirection('returned')} className={tabCls(direction === 'returned')}><PackageCheck size={14} /> Receive from Plating</button>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        <div className="md:col-span-2 card overflow-hidden">
          <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200 text-sm font-semibold text-gray-700">
            {direction === 'sent' ? 'Items ready to send' : 'Items out for plating'}
            <span className="text-gray-400 font-normal"> · {eligible.length}</span>
          </div>
          {loading ? (
            <div className="p-8 text-center text-gray-400 text-sm">Loading…</div>
          ) : eligible.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">{direction === 'sent' ? 'No plating items ready to send.' : 'Nothing is currently out for plating.'}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-white border-b border-gray-100">
                  <tr>
                    <th className="table-header text-center w-10"></th>
                    <th className="table-header text-left">Order</th>
                    <th className="table-header text-left">Drawing</th>
                    <th className="table-header text-left">Plating</th>
                    <th className="table-header text-right">Qty</th>
                    <th className="table-header text-left">Customer</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {eligible.map(it => {
                    const checked = !!sel[it.order_item_id];
                    return (
                      <tr key={it.order_item_id} className={`hover:bg-gray-50 ${checked ? 'bg-brand-50/40' : ''}`}>
                        <td className="table-cell text-center"><button onClick={() => toggle(it.order_item_id)}>{checked ? <CheckSquare size={16} className="text-brand-600" /> : <Square size={16} className="text-gray-400" />}</button></td>
                        <td className="table-cell text-sm"><Link to={`/orders/${it.order_id}`} className="text-brand-600 hover:underline">{it.order_code}</Link></td>
                        <td className="table-cell text-sm font-medium text-gray-800">{it.drawing_number}</td>
                        <td className="table-cell text-xs text-gray-500">{it.plating_instructions}{it.last_vendor && direction === 'returned' ? ` · ${it.last_vendor}` : ''}</td>
                        <td className="table-cell text-right text-sm">{it.quantity}</td>
                        <td className="table-cell text-xs text-gray-500">{it.customer_code || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card p-4 space-y-3 h-fit">
          <h3 className="text-sm font-semibold text-gray-800">{direction === 'sent' ? 'Send trip' : 'Return trip'}</h3>
          <div className="text-xs text-gray-500">{selectedIds.length} item(s) selected</div>
          {direction === 'sent' && (
            <div>
              <label className="label">Plating vendor</label>
              <select className="input" value={form.vendor} onChange={set('vendor')}>
                <option value="">— select —</option>
                {VENDORS.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="label">Paid to (transporter) <span className="text-red-500">*</span></label>
            <input className="input" value={form.paid_to} onChange={set('paid_to')} placeholder="Tempo / driver / agency" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">Transport ₹ <span className="text-red-500">*</span></label>
              <input className="input" type="number" step="any" min="0" value={form.transport_cost} onChange={set('transport_cost')} placeholder="0.00" />
            </div>
            <div>
              <label className="label">Date</label>
              <input className="input" type="date" value={form.trip_date} onChange={set('trip_date')} />
            </div>
          </div>
          <div>
            <label className="label">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
            <input className="input" value={form.notes} onChange={set('notes')} />
          </div>
          {perItemShare > 0 && <div className="text-xs text-gray-600 bg-gray-50 rounded-lg px-2 py-1.5">Per-item share: <b>{inr(perItemShare)}</b> · paid in <b>Cash</b></div>}
          {error && <p className="text-red-600 text-xs bg-red-50 px-2 py-1.5 rounded-lg">{error}</p>}
          {msg && <p className="text-green-700 text-xs bg-green-50 px-2 py-1.5 rounded-lg">{msg}</p>}
          <button className="btn-primary w-full" disabled={saving || !selectedIds.length} onClick={submit}>
            {saving ? 'Saving…' : direction === 'sent' ? 'Record Send + Transport' : 'Record Return + Transport'}
          </button>
        </div>
      </div>

      <div className="mt-6">
        <h2 className="text-sm font-semibold text-gray-800 flex items-center gap-1.5 mb-2"><History size={15} className="text-brand-600" /> Trip History</h2>
        {trips.length === 0 ? (
          <div className="card p-6 text-center text-gray-400 text-sm">No plating trips yet.</div>
        ) : (
          <div className="space-y-2">
            {trips.map(t => (
              <div key={t.id} className="card p-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2 text-sm flex-wrap">
                    <span className={`text-[10px] font-bold rounded-full px-2 py-0.5 ${t.direction === 'sent' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>{t.direction === 'sent' ? 'SENT' : 'RETURNED'}</span>
                    <span className="font-medium text-gray-800">{inr(t.transport_cost)}</span>
                    <span className="text-xs text-gray-400">({inr(t.per_item_share)}/item · {t.item_count} item{t.item_count > 1 ? 's' : ''})</span>
                    {t.vendor && <span className="text-xs text-gray-500">· {t.vendor}</span>}
                    <span className="text-xs text-gray-400">· paid to {t.paid_to}</span>
                  </div>
                  <span className="text-xs text-gray-400">{fmtDate(t.trip_date)}</span>
                </div>
                <div className="text-xs text-gray-500 mt-1">{t.items.map(i => i.drawing_number || i.product_code || `#${i.order_item_id}`).join(', ')}</div>
                {t.notes && <div className="text-xs text-gray-400 mt-0.5 italic">{t.notes}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
