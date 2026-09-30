import { useEffect, useMemo, useState } from 'react';
import api from '../../lib/api';
import Modal from '../../components/ui/Modal';
import { Boxes, Search, ArrowLeft } from 'lucide-react';

// A Machinery expense's part, stocked into an inventory item that already
// exists. Owner's rule (30 Sep 2026): the same part bought again goes into the
// item it already has, not a second item. The expense is saved before this
// opens; this only adds the pieces to stock (POST /petty-cash/:id/stock-in).
const STOP = new Set(['for', 'the', 'of', 'and', 'with', 'to', 'in', 'an', 'on', 'by', 'from']);
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1 && !STOP.has(w));
const qtyText = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const isMachinery = (it) => (it.category || '').trim().toLowerCase() === 'machinery';
const SHOW = 30;

export default function StockExistingPartModal({ entryId, initialSearch = '', note, onBack, onClose, onSaved }) {
  const [items, setItems] = useState(null);   // null while loading
  const [q, setQ] = useState(initialSearch);
  const [picked, setPicked] = useState(null);
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/inventory')
      .then(r => setItems(r.data || []))
      .catch(() => { setItems([]); setError('Could not load the inventory list. Close this and try again.'); });
  }, []);

  // Items matching the most search words come first; Machinery items lead a
  // tie, since that is what a Machinery expense bought.
  const { list, total } = useMemo(() => {
    if (!items) return { list: [], total: 0 };
    const ws = words(q);
    const scored = items
      .map(it => {
        const hay = `${it.name || ''} ${it.item_code || ''} ${it.category || ''}`.toLowerCase();
        return { it, score: ws.filter(w => hay.includes(w)).length };
      })
      .filter(x => ws.length === 0 || x.score > 0);
    scored.sort((a, b) => (b.score - a.score)
      || (isMachinery(b.it) - isMachinery(a.it))
      || String(a.it.name || '').localeCompare(String(b.it.name || '')));
    return { list: scored.slice(0, SHOW).map(x => x.it), total: scored.length };
  }, [items, q]);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!picked) return setError('Pick the item these parts go into.');
    if (!(parseFloat(qty) > 0)) return setError('Enter the quantity received.');
    if (price !== '' && !(parseFloat(price) >= 0)) return setError('Enter a valid price, or leave it blank.');
    setSaving(true);
    try {
      const r = await api.post(`/petty-cash/${entryId}/stock-in`, { item_id: picked.id, quantity: qty, unit_price: price });
      onSaved(r.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add the parts to inventory');
      setSaving(false);
    }
  };

  return (
    <Modal open title="Add to an existing item" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {note && (
          <div className="flex items-start gap-2 text-sm rounded-xl px-3 py-2.5 bg-emerald-50 border border-emerald-200 text-emerald-800">
            <Boxes size={15} className="flex-shrink-0 mt-0.5" /> <span>{note}</span>
          </div>
        )}

        {!picked ? (
          <div>
            <label className="label">Inventory item <span className="text-red-500">*</span></label>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input className="input pl-8" autoFocus placeholder="Search by name or item code"
                value={q} onChange={e => setQ(e.target.value)} />
            </div>
            <div className="mt-2 border border-gray-200 rounded-xl divide-y divide-gray-100 max-h-72 overflow-y-auto">
              {items === null ? (
                <div className="px-3 py-3 text-sm text-gray-400">Loading inventory…</div>
              ) : list.length === 0 ? (
                <div className="px-3 py-3 text-sm text-gray-500">
                  No item matches “{q}”. Try fewer words, or go back and create a new item.
                </div>
              ) : list.map(it => (
                <button type="button" key={it.id} onClick={() => { setPicked(it); setError(''); }}
                  className="w-full text-left px-3 py-2 hover:bg-emerald-50 focus:bg-emerald-50 focus:outline-none">
                  <div className="text-sm font-medium text-gray-900">{it.name}</div>
                  <div className="text-xs text-gray-500">
                    {it.item_code}{it.category ? ` · ${it.category}` : ''} · in stock {qtyText(it.current_stock)} {it.unit}
                  </div>
                </button>
              ))}
            </div>
            {total > SHOW && (
              <p className="text-xs text-gray-400 mt-1">Showing {SHOW} of {total}. Type more of the name to narrow it down.</p>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3 border border-emerald-200 bg-emerald-50/50 rounded-xl px-3 py-2.5">
              <div>
                <div className="text-sm font-medium text-gray-900">{picked.name}</div>
                <div className="text-xs text-gray-500">{picked.item_code} · in stock {qtyText(picked.current_stock)} {picked.unit}</div>
              </div>
              <button type="button" className="text-xs font-medium text-emerald-700 hover:underline flex-shrink-0"
                onClick={() => { setPicked(null); setError(''); }}>
                Change
              </button>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Quantity received <span className="text-red-500">*</span></label>
                <div className="flex items-center gap-2">
                  <input className="input" type="number" step="any" min="0" autoFocus required
                    value={qty} onChange={e => setQty(e.target.value)} />
                  <span className="text-sm text-gray-500 flex-shrink-0">{picked.unit}</span>
                </div>
              </div>
              <div>
                <label className="label">Price per {picked.unit} (₹) <span className="font-normal normal-case text-gray-400">(optional)</span></label>
                <input className="input" type="number" step="any" min="0"
                  value={price} onChange={e => setPrice(e.target.value)} />
              </div>
            </div>
            <p className="text-xs text-gray-500">
              The item's stock goes up by this quantity. Its stock history records the supplier and this expense.
            </p>
          </>
        )}

        {error && <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
        <div className="flex gap-3 pt-1">
          <button type="button" className="btn-secondary flex-1" onClick={onBack}>
            <ArrowLeft size={15} /> Back
          </button>
          <button type="submit" className="btn-primary flex-1" disabled={!picked || saving}>
            {saving ? 'Adding…' : 'Add to stock'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
