import { useState } from 'react';
import api from '../lib/api';
import { useAuthStore } from '../store/authStore';
import Modal from './ui/Modal';
import CategorySelect from './CategorySelect';
import { Upload } from 'lucide-react';

// Add Inventory Item — the single source of truth for item creation. Used by the
// Inventory page and inline from the PO form. onSave receives the API response
// ({ id, approval_status }) so callers can keep working with the new item.
export default function NewItemModal({ onClose, onSave }) {
  const { user } = useAuthStore();
  const [f, setF] = useState({ item_code: '', name: '', name_gu: '', category: '', unit: '', current_stock: 0, reorder_level: 0, min_order_qty: 0, unit_cost: '', notes: '' });
  const [drawing, setDrawing] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      // Use FormData to support optional drawing upload
      const fd = new FormData();
      Object.entries(f).forEach(([k, v]) => fd.append(k, v));
      if (drawing) fd.append('drawing', drawing);
      const r = await api.post('/inventory', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      onSave(r.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed');
      setSaving(false);
    }
  };

  return (
    <Modal open title="Add Inventory Item" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div><label className="label">Item Code *</label><input className="input" placeholder="e.g. WR-26SWG" value={f.item_code} onChange={set('item_code')} required /></div>
          <div><label className="label">Unit *</label><input className="input" placeholder="e.g. kg, mtr, nos" value={f.unit} onChange={set('unit')} required /></div>
          <div className="col-span-2"><label className="label">Name *</label><input className="input" placeholder="e.g. Resistance Wire 26 SWG" value={f.name} onChange={set('name')} required /></div>
          <div className="col-span-2"><label className="label">Name (ગુજરાતી) <span className="font-normal normal-case text-gray-400">(auto-generated if left blank)</span></label><input className="input" placeholder="ખાલી છોડો — આપમેળે બનશે" value={f.name_gu} onChange={set('name_gu')} /></div>
          <div><label className="label">Category</label><CategorySelect value={f.category} onChange={v => setF(p => ({ ...p, category: v }))} /></div>
          <div><label className="label">Opening Stock</label><input className="input" type="number" step="any" value={f.current_stock} onChange={set('current_stock')} /></div>
          <div><label className="label">Reorder Level</label><input className="input" type="number" step="any" value={f.reorder_level} onChange={set('reorder_level')} /></div>
          <div><label className="label">Min Order Qty</label><input className="input" type="number" step="any" min="0" placeholder="e.g. 100" value={f.min_order_qty} onChange={set('min_order_qty')} /></div>
          <div><label className="label">Unit Price (₹)</label><input className="input" type="number" step="any" min="0" placeholder="e.g. 12.50" value={f.unit_cost} onChange={set('unit_cost')} /></div>
          <div><label className="label">Notes</label><input className="input" value={f.notes} onChange={set('notes')} /></div>
          <div className="col-span-2">
            <label className="label">Item Drawing <span className="font-normal normal-case text-gray-400">(PDF or image, optional)</span></label>
            <label className="flex items-center gap-2 cursor-pointer border border-gray-200 rounded-lg px-3 py-2 hover:border-brand-400 transition-colors bg-gray-50">
              <Upload size={15} className="text-gray-400 flex-shrink-0" />
              <span className="text-sm text-gray-600 flex-1 truncate">
                {drawing ? drawing.name : 'Click to attach drawing...'}
              </span>
              <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" className="hidden"
                onChange={e => setDrawing(e.target.files[0] || null)} />
            </label>
          </div>
        </div>
        {user.role !== 'owner' && (
          <p className="text-amber-700 text-sm bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
            The item will be sent to the owner for approval — it becomes usable in orders and purchases once approved.
          </p>
        )}
        {error && <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
        <div className="flex gap-3 pt-2">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving}>{saving ? 'Saving...' : 'Add Item'}</button>
        </div>
      </form>
    </Modal>
  );
}
