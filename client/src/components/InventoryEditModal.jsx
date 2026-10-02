import { useEffect, useState } from 'react';
import api from '../lib/api';
import Modal from './ui/Modal';
import StockTag, { StockNote } from './StockTag';
import { Package, X } from 'lucide-react';

// Edit the inventory selected for an order item. If the item's drawing is already
// approved (stock deducted), saving reverses the old selection and re-deducts the
// new one server-side so stock stays accurate.
export default function InventoryEditModal({ orderId, item, onClose, onDone }) {
  const [inventoryItems, setInventoryItems] = useState([]);
  const [selected, setSelected] = useState(
    Object.fromEntries((item?.inventory_items || []).map(i => [i.id, i.qty ?? '']))
  );
  // Portion of each line drawn from the part's rework bin (reserved on save).
  const [reworkOf, setReworkOf] = useState(
    Object.fromEntries((item?.inventory_items || []).filter(i => Number(i.rework_qty) > 0).map(i => [i.id, i.rework_qty]))
  );
  const [invSearch, setInvSearch] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // What the inventory rules did with the save (owner, 1 Oct 2026).
  const [result, setResult] = useState(null);

  useEffect(() => { api.get('/inventory').then(r => setInventoryItems(r.data)).catch(() => {}); }, []);

  const filtered = inventoryItems.filter(i =>
    (i.item_code || '').toLowerCase().includes(invSearch.toLowerCase()) ||
    (i.name || '').toLowerCase().includes(invSearch.toLowerCase()) ||
    (i.category || '').toLowerCase().includes(invSearch.toLowerCase())
  ).slice(0, 10);

  const toggle = (id) => setSelected(prev => {
    if (id in prev) { const n = { ...prev }; delete n[id]; setReworkOf(r => { const c = { ...r }; delete c[id]; return c; }); return n; }
    return { ...prev, [id]: '' };
  });
  // What this item may claim: the bin's free count plus what its own line
  // already holds (that reservation is released and re-made on save).
  const reworkMax = (i) => (Number(i.rework_free) || 0) + (Number((item?.inventory_items || []).find(x => x.id === i.id)?.rework_qty) || 0);
  const setQty = (id, qty) => setSelected(prev => ({ ...prev, [id]: qty }));
  const selectedList = inventoryItems.filter(i => i.id in selected);
  // Fins need no qty — they deduct automatically by tube length at QC approval
  const isFins = (i) => (i?.category || '').trim().toLowerCase() === 'finns';
  const finsIds = new Set(inventoryItems.filter(isFins).map(i => String(i.id)));

  const handleSave = async () => {
    const ids = Object.keys(selected);
    if (!ids.length) return setError('Select at least one inventory item');
    const missingQty = ids.filter(id => !finsIds.has(String(id)) && (!selected[id] || parseFloat(selected[id]) <= 0));
    if (missingQty.length) return setError('Enter a quantity for every selected item');
    const inventory_item_ids = ids.map(id => ({ id: parseInt(id), qty: finsIds.has(String(id)) ? 0 : parseFloat(selected[id]),
      rework_qty: parseInt(reworkOf[id], 10) || 0 }));
    setSaving(true);
    setError('');
    try {
      const r = await api.put(`/orders/${orderId}/items/${item.id}/inventory`, { inventory_item_ids });
      if (r.data?.summary) { setResult(r.data); setSaving(false); return; }
      onDone?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update inventory');
      setSaving(false);
    }
  };

  if (result) {
    const moved = result.mode === 'difference' && (result.moves?.length || result.short?.length);
    return (
      <Modal open title={`Inventory — ${item?.drawing_number || `Item ${item?.id}`}`} onClose={() => onDone?.()} size="lg">
        <div className="space-y-4">
          <div className={`rounded-lg border px-3 py-2.5 text-sm ${moved ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-green-50 border-green-200 text-green-800'}`}>
            <div className="font-medium mb-0.5">Inventory saved</div>
            <div>{result.summary.charAt(0).toUpperCase() + result.summary.slice(1)}.</div>
          </div>
          <p className="text-xs text-gray-500">This is also written on the order's timeline.</p>
          <button type="button" className="btn-primary w-full" onClick={() => onDone?.()}>Done</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open title={`Inventory — ${item?.drawing_number || `Item ${item?.id}`}`} onClose={onClose} size="lg">
      <div className="space-y-4">
        <p className="text-xs text-gray-500">
          Correct the inventory this item consumes. Stock only changes where real stock was already
          taken for this item, and then only by the difference; otherwise just the list is corrected.
        </p>

        <div className="relative">
          <input className="input" placeholder="Search inventory by code or name..."
            value={invSearch}
            onChange={e => { setInvSearch(e.target.value); setShowDropdown(true); }}
            onFocus={() => setShowDropdown(true)}
            onBlur={() => setTimeout(() => setShowDropdown(false), 150)} />
          {showDropdown && invSearch && (
            <div className="absolute z-10 w-full bg-white border border-gray-200 rounded-lg shadow-lg mt-1 max-h-52 overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="px-3 py-2 text-sm text-gray-400">No matches</div>
              ) : filtered.map(i => (
                <button key={i.id} type="button"
                  className="w-full text-left px-3 py-2 text-sm hover:bg-brand-50 flex items-center justify-between"
                  onMouseDown={() => { toggle(i.id); setInvSearch(''); }}>
                  <span><span className="font-mono">{i.item_code}</span> — {i.name}
                    <StockTag item={i} />
                    {Number(i.rework_free) > 0 && <span className="ml-1.5 text-[10px] font-semibold bg-sky-100 text-sky-800 rounded px-1.5 py-0.5">REWORK {i.rework_qty} · {i.rework_free} free</span>}</span>
                  {i.id in selected && <span className="text-xs text-green-600">added</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        {selectedList.length > 0 ? (
          <div className="space-y-1.5">
            {selectedList.map(i => (
              <div key={i.id} className="flex items-center gap-2 bg-gray-50 rounded-lg px-2.5 py-1.5">
                <span className="text-sm flex-1 truncate"><span className="font-mono">{i.item_code}</span> — {i.name}</span>
                <StockNote item={i} />
                {isFins(i) ? (
                  <span className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1 whitespace-nowrap"
                    title="Deducts automatically from the tube length at QC approval">
                    auto — by tube length
                  </span>
                ) : (
                  <>
                    <input className="input w-24 text-sm py-1" type="number" min="0" step="any" placeholder="Qty"
                      value={selected[i.id]} onChange={e => setQty(i.id, e.target.value)} />
                    <span className="text-xs text-gray-400 w-8">{i.unit}</span>
                    {reworkMax(i) > 0 && (
                      <span className="flex items-center gap-1" title={`${i.rework_free} free in the rework bin`}>
                        <input className="input w-20 text-sm py-1 border-sky-300" type="number" min="0" max={reworkMax(i)} step="1" placeholder="0"
                          value={reworkOf[i.id] || ''} onChange={e => setReworkOf(r => ({ ...r, [i.id]: e.target.value }))} />
                        <span className="text-[10px] text-sky-700 whitespace-nowrap">from rework · {reworkMax(i)} free</span>
                      </span>
                    )}
                  </>
                )}
                <button type="button" className="p-1 text-gray-400 hover:text-red-600" onClick={() => toggle(i.id)}>
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-400 flex items-center gap-1.5"><Package size={14} /> No inventory selected yet.</p>
        )}

        {error && <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
        <div className="flex gap-3 pt-1">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary flex-1" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save Inventory'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
