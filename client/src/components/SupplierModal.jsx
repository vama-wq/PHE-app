import { useEffect, useState } from 'react';
import api from '../lib/api';
import Modal from './ui/Modal';
import { Plus, Package, X } from 'lucide-react';

// Add/Edit Supplier — the single source of truth for supplier creation.
// Used by the Suppliers page and inline from the PO form (includePendingInventory
// lets the PO flow link items that are still awaiting owner approval).
export default function SupplierModal({ supplier, onClose, onSaved, includePendingInventory = false }) {
  const [f, setF] = useState(supplier || { supplier_code: '', name: '', contact_person: '', phone: '', email: '', address: '', notes: '' });
  const [items, setItems] = useState([]);
  const [inventoryList, setInventoryList] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loadingItems, setLoadingItems] = useState(!!supplier);
  const [initialItemIds, setInitialItemIds] = useState([]);
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));

  useEffect(() => {
    // Pending items are linkable here (tagged) — supplier links are purchase-side
    api.get('/inventory?include_pending=1').then(r => setInventoryList(r.data)).catch(() => {});
    if (supplier) {
      api.get(`/suppliers/${supplier.id}/items`)
        .then(r => { setInitialItemIds(r.data.map(si => String(si.inventory_item_id))); return r; })
        .then(r => setItems(r.data.map(si => ({
          inventory_item_id: si.inventory_item_id,
          supplier_part_no: si.supplier_part_no || '',
          supplier_price: si.supplier_price || '',
          lead_time_days: si.lead_time_days || '',
          min_order_qty: si.min_order_qty || '',
        }))))
        .finally(() => setLoadingItems(false));
    }
  }, []);

  const addItem = () => {
    setItems(prev => [...prev, { inventory_item_id: '', supplier_part_no: '', supplier_price: '', lead_time_days: '', min_order_qty: '' }]);
  };

  const updateItem = (idx, field, value) => {
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, [field]: value } : it));
  };

  const removeItem = (idx) => {
    setItems(prev => prev.filter((_, i) => i !== idx));
  };

  const usedItemIds = items.map(i => String(i.inventory_item_id)).filter(Boolean);
  const availableFor = (idx) => inventoryList.filter(inv =>
    String(inv.id) === String(items[idx]?.inventory_item_id) || !usedItemIds.includes(String(inv.id))
  );

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!f.supplier_code?.trim()) return setError('Supplier code is required');
    if (!f.name?.trim()) return setError('Supplier name is required');
    if (!f.phone?.trim()) return setError('Phone number is required');
    if (!f.address?.trim()) return setError('Address is required');

    const validItems = items.filter(i => i.inventory_item_id);
    if (!validItems.length) return setError('At least one inventory item must be linked');
    const incomplete = validItems.find(i => !i.supplier_price || Number(i.supplier_price) <= 0 || !i.lead_time_days || Number(i.lead_time_days) <= 0);
    if (incomplete) {
      const inv = inventoryList.find(inv => String(inv.id) === String(incomplete.inventory_item_id));
      return setError(`Price and lead time are required for ${inv?.item_code || 'each item'}`);
    }

    setSaving(true);
    setError('');
    try {
      let finalItems = validItems;
      if (supplier) {
        // Preserve links added elsewhere (e.g. from the PO page) while this form
        // was open — only links the user SAW and removed should be deleted.
        try {
          const fresh = await api.get(`/suppliers/${supplier.id}/items`);
          const knownIds = new Set([...initialItemIds, ...validItems.map(i => String(i.inventory_item_id))]);
          const preserved = (fresh.data || []).filter(si => !knownIds.has(String(si.inventory_item_id)))
            .map(si => ({ inventory_item_id: si.inventory_item_id, supplier_part_no: si.supplier_part_no || '',
              supplier_price: si.supplier_price, lead_time_days: si.lead_time_days, min_order_qty: si.min_order_qty || '' }));
          finalItems = [...validItems, ...preserved];
        } catch (_) { /* keep the user's list if the check fails */ }
      }
      const payload = { ...f, items: finalItems };
      if (supplier) { await api.put(`/suppliers/${supplier.id}`, payload); onSaved(supplier.id); }
      else { const r = await api.post('/suppliers', payload); onSaved(r.data.id); }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed');
      setSaving(false);
    }
  };

  const getItemLabel = (invId) => {
    const inv = inventoryList.find(i => String(i.id) === String(invId));
    return inv ? `${inv.item_code} — ${inv.name}` : '';
  };

  return (
    <Modal open title={supplier ? `Edit — ${supplier.name}` : 'Add Supplier'} onClose={onClose} size="lg">
      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Supplier info */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Supplier Code <span className="text-red-500">*</span></label>
            <input className="input" value={f.supplier_code||''} onChange={set('supplier_code')} placeholder="e.g. SUP-001" required />
          </div>
          <div>
            <label className="label">Supplier Name <span className="text-red-500">*</span></label>
            <input className="input" value={f.name||''} onChange={set('name')} required />
          </div>
          <div>
            <label className="label">Contact Person</label>
            <input className="input" value={f.contact_person||''} onChange={set('contact_person')} />
          </div>
          <div>
            <label className="label">Phone <span className="text-red-500">*</span></label>
            <input className="input" type="tel" value={f.phone||''} onChange={set('phone')} required />
          </div>
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" value={f.email||''} onChange={set('email')} />
          </div>
          <div className="col-span-2">
            <label className="label">Address <span className="text-red-500">*</span></label>
            <textarea className="input h-16 resize-none" value={f.address||''} onChange={set('address')} required />
          </div>
          <div className="col-span-2">
            <label className="label">Notes</label>
            <textarea className="input h-12 resize-none" value={f.notes||''} onChange={set('notes')} />
          </div>
        </div>

        {/* Items section */}
        <div className="border-t border-gray-200 pt-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-1.5">
                <Package size={14} /> Supplied Items <span className="text-red-500">*</span>
              </h3>
              <p className="text-xs text-gray-400 mt-0.5">Select inventory items this supplier provides</p>
            </div>
            <button type="button" className="btn-secondary btn-sm flex items-center gap-1 text-xs" onClick={addItem}>
              <Plus size={13} /> Add Item
            </button>
          </div>

          {loadingItems ? (
            <p className="text-sm text-gray-400 py-4 text-center">Loading items...</p>
          ) : items.length === 0 ? (
            <div className="border-2 border-dashed border-gray-200 rounded-xl py-6 text-center">
              <p className="text-sm text-gray-400 mb-2">No items linked yet</p>
              <button type="button" className="btn-primary btn-sm text-xs" onClick={addItem}>
                <Plus size={13} /> Add First Item
              </button>
            </div>
          ) : (
            <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1">
              {items.map((item, idx) => (
                <div key={idx} className="bg-gray-50 rounded-xl p-3 border border-gray-100 relative">
                  <button type="button" onClick={() => removeItem(idx)}
                    className="absolute top-2 right-2 p-1 rounded-md hover:bg-red-100 text-gray-400 hover:text-red-600 transition-colors">
                    <X size={14} />
                  </button>
                  <div className="grid grid-cols-1 gap-2 mb-2">
                    <div>
                      <label className="text-xs text-gray-500 font-medium">Inventory Item <span className="text-red-500">*</span></label>
                      <select className="input text-sm mt-0.5" value={item.inventory_item_id}
                        onChange={e => updateItem(idx, 'inventory_item_id', e.target.value)}>
                        <option value="">— Select item —</option>
                        {availableFor(idx).map(inv => (
                          <option key={inv.id} value={inv.id}>{inv.item_code} — {inv.name} ({inv.unit}){inv.approval_status === 'pending_approval' ? ' — pending approval' : ''}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    <div>
                      <label className="text-xs text-gray-500 font-medium">Supplier Part No</label>
                      <input className="input text-sm mt-0.5" placeholder="e.g. ABC-123" value={item.supplier_part_no}
                        onChange={e => updateItem(idx, 'supplier_part_no', e.target.value)} />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 font-medium">Price (per unit) <span className="text-red-500">*</span></label>
                      <input className="input text-sm mt-0.5" type="number" step="any" min="0" placeholder="0.00" value={item.supplier_price}
                        onChange={e => updateItem(idx, 'supplier_price', e.target.value)} required />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 font-medium">Lead Time (days) <span className="text-red-500">*</span></label>
                      <input className="input text-sm mt-0.5" type="number" min="1" placeholder="e.g. 7" value={item.lead_time_days}
                        onChange={e => updateItem(idx, 'lead_time_days', e.target.value)} required />
                    </div>
                    <div>
                      <label className="text-xs text-gray-500 font-medium">Min Order Qty</label>
                      <input className="input text-sm mt-0.5" type="number" step="any" min="0" placeholder="e.g. 100" value={item.min_order_qty}
                        onChange={e => updateItem(idx, 'min_order_qty', e.target.value)} />
                    </div>
                  </div>
                  {item.inventory_item_id && (
                    <div className="text-xs text-brand-600 mt-1.5 font-medium">{getItemLabel(item.inventory_item_id)}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {error && <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
        <div className="flex gap-3 pt-1">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving}>{saving ? 'Saving...' : supplier ? 'Update' : 'Add Supplier'}</button>
        </div>
      </form>
    </Modal>
  );
}
