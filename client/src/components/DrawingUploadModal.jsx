import { useEffect, useRef, useState } from 'react';
import api, { uploadApi } from '../lib/api';
import Modal from './ui/Modal';
import { Upload, Package, X, FileText } from 'lucide-react';

// Design uploads a reference drawing for an order item AND selects the inventory
// that item consumes. Inventory deducts when the owner approves the drawing.
export default function DrawingUploadModal({ orderId, item, label = 'Upload Drawing', onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [inventoryItems, setInventoryItems] = useState([]);
  const [selected, setSelected] = useState({}); // { [id]: qty }
  const [invSearch, setInvSearch] = useState('');
  const [showInvDropdown, setShowInvDropdown] = useState(false);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    api.get('/inventory').then(r => setInventoryItems(r.data)).catch(() => {});
    // Pre-fill the item's existing inventory selection (e.g. re-uploading a rejected drawing)
    if (orderId && item?.id) {
      api.get(`/orders/${orderId}/items`)
        .then(r => {
          const found = (r.data || []).find(it => String(it.id) === String(item.id));
          if (found?.inventory_items?.length) {
            setSelected(Object.fromEntries(found.inventory_items.map(i => [i.id, i.qty || ''])));
          }
        }).catch(() => {});
    }
  }, [orderId, item]);

  const filteredInventory = inventoryItems.filter(i =>
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

  const handleUpload = async () => {
    if (!file) return setError('Please choose a drawing file');
    const ids = Object.keys(selected);
    if (ids.length === 0) return setError('Select at least one inventory item for this drawing');
    const missingQty = ids.filter(id => !selected[id] || parseFloat(selected[id]) <= 0);
    if (missingQty.length) return setError('Enter a quantity for every selected inventory item');

    const inventory_item_ids = ids.map(id => ({ id: parseInt(id), qty: parseFloat(selected[id]) }));
    const fd = new FormData();
    fd.append('file', file);
    fd.append('item_id', item.id);
    fd.append('inventory_item_ids', JSON.stringify(inventory_item_ids));
    if (notes) fd.append('notes', notes);

    setUploading(true);
    setError('');
    try {
      await uploadApi.post(`/orders/${orderId}/drawings`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      onDone?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Upload failed');
      setUploading(false);
    }
  };

  return (
    <Modal open title={label} onClose={onClose} size="lg">
      <div className="space-y-4">
        <div className="text-sm text-gray-500">
          Item: <span className="font-mono font-medium text-gray-700">{item?.drawing_number || `Item ${item?.id}`}</span>
        </div>

        {/* File picker */}
        <div>
          <label className="label">Drawing file <span className="text-red-500">*</span></label>
          <div
            className={`border-2 border-dashed rounded-xl p-5 text-center cursor-pointer transition-colors ${
              file ? 'border-green-300 bg-green-50' : 'border-gray-200 hover:border-brand-400 hover:bg-brand-50'
            }`}
            onClick={() => fileRef.current?.click()}
          >
            {file ? (
              <div className="flex flex-col items-center gap-1 text-sm">
                <FileText size={24} className="text-green-500" />
                <span className="font-medium text-green-800">{file.name}</span>
                <span className="text-xs text-gray-400">Click to change</span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-1 text-gray-400">
                <Upload size={22} />
                <p className="text-sm font-medium text-gray-500">Click to select drawing</p>
                <p className="text-xs">PDF, JPG, PNG, DWG, DXF</p>
              </div>
            )}
          </div>
          <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.dwg,.dxf" className="hidden"
            onChange={e => { setFile(e.target.files[0] || null); setError(''); }} />
        </div>

        {/* Inventory selector */}
        <div>
          <label className="label flex items-center gap-1.5">
            <Package size={13} /> Inventory consumed by this item <span className="text-red-500">*</span>
          </label>
          <div className="relative">
            <input className="input" placeholder="Search inventory by code or name..."
              value={invSearch}
              onChange={e => { setInvSearch(e.target.value); setShowInvDropdown(true); }}
              onFocus={() => setShowInvDropdown(true)}
              onFocusCapture={() => setShowInvDropdown(true)}
              onBlur={() => setTimeout(() => setShowInvDropdown(false), 150)} />
            {showInvDropdown && invSearch && (
              <div className="absolute z-10 w-full bg-white border border-gray-200 rounded-lg shadow-lg mt-1 max-h-52 overflow-y-auto">
                {filteredInventory.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-gray-400">No matches</div>
                ) : filteredInventory.map(i => (
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

          {selectedList.length > 0 && (
            <div className="mt-2 space-y-1.5">
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
          )}
        </div>

        {/* Notes */}
        <div>
          <label className="label">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
          <input className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Any note for this drawing..." />
        </div>

        {error && <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</p>}

        <div className="flex gap-3 pt-1">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary flex-1" onClick={handleUpload} disabled={uploading}>
            {uploading ? 'Uploading…' : 'Upload Drawing'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
