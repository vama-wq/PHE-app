import { useEffect, useState } from 'react';
import api from '../lib/api';
import Modal from './ui/Modal';
import { Package, X } from 'lucide-react';

// Edit the inventory selected for an order item. If the item's drawing is already
// approved (stock deducted), saving reverses the old selection and re-deducts the
// new one server-side so stock stays accurate.
export default function InventoryEditModal({ orderId, item, onClose, onDone }) {
  const [inventoryItems, setInventoryItems] = useState([]);
  const [selected, setSelected] = useState(
    Object.fromEntries((item?.inventory_items || []).map(i => [i.id, i.qty ?? '']))
  );
  const [invSearch, setInvSearch] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { api.get('/inventory').then(r => setInventoryItems(r.data)).catch(() => {}); }, []);

  const filtered = inventoryItems.filter(i =>
    (i.item_code || '').toLowerCase().includes(invSearch.toLowerCase()) ||
    (i.name || '').toLowerCase().includes(invSearch.toLowerCase()) ||
    (i.category || '').toLowerCase().includes(invSearch.toLowerCase())
  ).slice(0, 10);

  const toggle = (id) => setSelected(prev => {
    if (id in prev) { const n = { ...prev }; delete n[id]; return n; }
    return { ...prev, [id]: '' };
  });
  const setQty = (id, qty) => setSelected(prev => ({ ...prev, [id]: qty }));
  const selectedList = inventoryItems.filter(i => i.id in selected);

  const handleSave = async () => {
    const ids = Object.keys(selected);
    if (!ids.length) return setError('Select at least one inventory item');
    const missingQty = ids.filter(id => !selected[id] || parseFloat(selected[id]) <= 0);
    if (missingQty.length) return setError('Enter a quantity for every selected item');
    const inventory_item_ids = ids.map(id => ({ id: parseInt(id), qty: parseFloat(selected[id]) }));
    setSaving(true);
    setError('');
    try {
      await api.put(`/orders/${orderId}/items/${item.id}/inventory`, { inventory_item_ids });
      onDone?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update inventory');
      setSaving(false);
    }
  };

  return (
    <Modal open title={`Inventory — ${item?.drawing_number || `Item ${item?.id}`}`} onClose={onClose} size="lg">
      <div className="space-y-4">
        <p className="text-xs text-gray-500">
          Adjust the inventory this item consumes. If its drawing is already approved, the change
          is reconciled in stock automatically.
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
                  <span><span className="font-mono">{i.item_code}</span> — {i.name}</span>
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
                <input className="input w-24 text-sm py-1" type="number" min="0" step="any" placeholder="Qty"
                  value={selected[i.id]} onChange={e => setQty(i.id, e.target.value)} />
                <span className="text-xs text-gray-400 w-8">{i.unit}</span>
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
