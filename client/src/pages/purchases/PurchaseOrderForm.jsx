import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../../lib/api';
import { Plus, Trash2, ArrowLeft, Search } from 'lucide-react';

const EMPTY_ITEM = { inventory_item_id: null, description: '', unit: '', qty: '', rate: '', amount: 0 };

export default function PurchaseOrderForm() {
  const navigate = useNavigate();
  const { id } = useParams(); // present when editing
  const isEdit = !!id;

  const [suppliers, setSuppliers] = useState([]);
  const [invItems, setInvItems] = useState([]);
  const [linkedItems, setLinkedItems] = useState([]); // items linked to the selected supplier
  const [supplierId, setSupplierId] = useState('');
  const [items, setItems] = useState([]);
  const [transportCharges, setTransportCharges] = useState('0');
  const [igstPercent, setIgstPercent] = useState('18');
  const [notes, setNotes] = useState('');
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    Promise.all([api.get('/suppliers'), api.get('/inventory')]).then(([s, inv]) => {
      setSuppliers(s.data);
      setInvItems(inv.data);
    });
    if (isEdit) {
      api.get(`/purchase-orders/${id}`).then(r => {
        const po = r.data;
        setSupplierId(String(po.supplier_id));
        setTransportCharges(String(po.transport_charges || 0));
        setIgstPercent(String(po.igst_percent || 18));
        setNotes(po.notes || '');
        setExpectedDeliveryDate(po.expected_delivery_date || '');
        setItems(po.items.map(i => ({
          id: i.id,
          inventory_item_id: i.inventory_item_id,
          description: i.description,
          unit: i.unit || '',
          qty: String(i.qty),
          rate: String(i.rate),
          amount: i.amount,
        })));
      });
    }
  }, [id]);

  // Load the selected supplier's linked items — these are the only items a PO
  // for this supplier can contain, and they carry the agreed rate.
  useEffect(() => {
    if (!supplierId) { setLinkedItems([]); return; }
    api.get(`/suppliers/${supplierId}/items`).then(r => {
      setLinkedItems((r.data || []).map(li => ({
        id: li.inventory_item_id,
        item_code: li.item_code,
        name: li.item_name,
        unit: li.unit || '',
        current_stock: li.current_stock,
        drawing_file: li.drawing_file,
        supplier_price: li.supplier_price,
        lead_time_days: li.lead_time_days,
      })));
    }).catch(() => setLinkedItems([]));
  }, [supplierId]);

  const updateItem = (idx, field, value) => {
    setItems(prev => {
      const updated = [...prev];
      updated[idx] = { ...updated[idx], [field]: value };
      if (field === 'qty' || field === 'rate') {
        const q = parseFloat(field === 'qty' ? value : updated[idx].qty) || 0;
        const r = parseFloat(field === 'rate' ? value : updated[idx].rate) || 0;
        updated[idx].amount = Math.round(q * r * 100) / 100;
      }
      return updated;
    });
  };

  // Add a picked inventory item as a new row (with the agreed/last rate).
  const addPickedItem = async (invItem) => {
    if (items.some(i => i.inventory_item_id === invItem.id)) { setPickerSearch(''); setPickerOpen(false); return; }
    let rate = '0';
    if (invItem.supplier_price != null && invItem.supplier_price !== '') {
      rate = String(invItem.supplier_price);
    } else {
      try { const r = await api.get(`/purchase-orders/last-rate/${invItem.id}`); if (r.data.rate > 0) rate = String(r.data.rate); } catch {}
    }
    const row = { inventory_item_id: invItem.id, description: invItem.name, unit: invItem.unit || '', qty: '', rate, amount: 0 };
    setItems(prev => [...prev, row]);
    setPickerSearch('');
    setPickerOpen(false);
  };

  const removeItem = (idx) => setItems(prev => prev.filter((_, i) => i !== idx));

  // Computed totals
  const tc = parseFloat(transportCharges) || 0;
  const igst = parseFloat(igstPercent) || 0;
  const itemsSubtotal = items.reduce((s, i) => s + (i.amount || 0), 0);
  const subtotal = itemsSubtotal + tc;
  const igstAmount = Math.round(subtotal * (igst / 100) * 100) / 100;
  const grandTotal = Math.round((subtotal + igstAmount) * 100) / 100;
  const fmt = n => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 });

  // Strict where the supplier has linked items; fall back to all inventory when
  // the supplier has none linked (so POs aren't blocked before links are set up).
  const usingFallback = !!supplierId && linkedItems.length === 0;
  const pickerItems = supplierId ? (linkedItems.length ? linkedItems : invItems) : [];
  const pq = pickerSearch.toLowerCase();
  const pickerFiltered = pickerItems.filter(i =>
    !pq || i.name.toLowerCase().includes(pq) || (i.item_code || '').toLowerCase().includes(pq)
  ).slice(0, 50);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!supplierId) return setError('Please select a supplier');
    const validItems = items.filter(i => i.inventory_item_id);
    if (validItems.length === 0) return setError('Add at least one item from the supplier’s linked list');
    if (items.some(i => !i.inventory_item_id && (i.description || '').trim()))
      return setError('Each item must be picked from the supplier’s list (use the dropdown).');

    setSaving(true);
    setError('');
    const payload = {
      supplier_id: Number(supplierId),
      items: validItems.map(i => ({
        inventory_item_id: i.inventory_item_id || null,
        description: i.description,
        unit: i.unit || null,
        qty: Number(i.qty) || 0,
        rate: Number(i.rate) || 0,
        amount: i.amount || 0,
      })),
      transport_charges: tc,
      igst_percent: igst,
      notes,
      expected_delivery_date: expectedDeliveryDate || null,
    };

    try {
      if (isEdit) {
        await api.put(`/purchase-orders/${id}`, payload);
        navigate(`/purchases/${id}`);
      } else {
        const r = await api.post('/purchase-orders', payload);
        navigate(`/purchases/${r.data.id}`);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save');
      setSaving(false);
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate(isEdit ? `/purchases/${id}` : '/purchases')} className="btn-ghost btn-sm">
          <ArrowLeft size={16} /> Back
        </button>
        <h1 className="page-title">{isEdit ? 'Edit Purchase Order' : 'New Purchase Order'}</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Supplier + meta */}
        <div className="card p-5">
          <h2 className="font-semibold text-gray-900 mb-4">Purchase Order Details</h2>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 md:col-span-1">
              <label className="label">Supplier *</label>
              <select className="input" value={supplierId}
                onChange={e => { setSupplierId(e.target.value); setItems([]); setPickerSearch(''); }} required>
                <option value="">Select supplier...</option>
                {suppliers.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <p className="text-xs text-gray-400 mt-1">Only this supplier's linked items can be added below.</p>
            </div>
            <div>
              <label className="label">IGST %</label>
              <input className="input" type="number" step="0.01" value={igstPercent} onChange={e => setIgstPercent(e.target.value)} />
            </div>
            <div>
              <label className="label">Expected Delivery Date</label>
              <input className="input" type="date" value={expectedDeliveryDate} onChange={e => setExpectedDeliveryDate(e.target.value)} />
            </div>
            <div className="col-span-2">
              <label className="label">Notes</label>
              <input className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Any notes for this PO..." />
            </div>
          </div>
        </div>

        {/* Items */}
        <div className="card p-5">
          <h2 className="font-semibold text-gray-900 mb-3">Items</h2>

          {/* Prominent item search — adds a row when clicked */}
          <div className="relative mb-4">
            <div className={`flex items-center gap-2 border-2 rounded-xl px-3 py-2.5 transition-colors ${supplierId ? 'border-gray-200 focus-within:border-brand-400 bg-white' : 'border-gray-100 bg-gray-50'}`}>
              <Search size={17} className="text-gray-400 flex-shrink-0" />
              <input
                className="flex-1 outline-none text-sm bg-transparent disabled:cursor-not-allowed"
                placeholder={supplierId ? 'Search items and click to add…' : 'Select a supplier first'}
                value={pickerSearch}
                disabled={!supplierId}
                onChange={e => { setPickerSearch(e.target.value); setPickerOpen(true); }}
                onFocus={() => setPickerOpen(true)}
                onBlur={() => setTimeout(() => setPickerOpen(false), 200)}
              />
            </div>
            {pickerOpen && supplierId && (
              <div
                className="absolute z-30 left-0 right-0 bg-white border border-gray-200 rounded-xl shadow-2xl mt-1 overflow-y-auto"
                style={{ maxHeight: '460px' }}
              >
                <div className="p-2 border-b border-gray-100 sticky top-0 bg-white">
                  <span className="text-xs text-gray-400 font-medium px-1">
                    {pickerFiltered.length} {usingFallback ? 'item' : 'linked item'}{pickerFiltered.length !== 1 ? 's' : ''}{pickerSearch ? ' found' : ''}
                    {usingFallback && <span className="text-amber-500"> · supplier has no linked items (showing all inventory)</span>}
                  </span>
                </div>
                {pickerFiltered.length === 0 ? (
                  <div className="px-3 py-5 text-sm text-gray-400 text-center">
                    No {usingFallback ? 'inventory' : 'linked items'}{pickerSearch ? ' match your search' : ' available'}.
                  </div>
                ) : pickerFiltered.map(inv => {
                  const added = items.some(i => i.inventory_item_id === inv.id);
                  return (
                    <button
                      key={inv.id}
                      type="button"
                      disabled={added}
                      className={`w-full text-left px-3 py-2.5 flex items-center gap-3 border-b border-gray-50 last:border-0 ${added ? 'opacity-40 cursor-not-allowed' : 'hover:bg-brand-50'}`}
                      onMouseDown={() => !added && addPickedItem(inv)}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-gray-800 truncate">{inv.name}</div>
                        <div className="text-xs text-gray-400 mt-0.5">{inv.item_code} · {inv.unit} · Stock: {inv.current_stock}</div>
                      </div>
                      {inv.supplier_price != null && (
                        <div className="text-right flex-shrink-0">
                          <div className="text-sm font-semibold text-gray-700">₹{fmt(inv.supplier_price || 0)}</div>
                          {inv.lead_time_days != null && <div className="text-xs text-gray-400">{inv.lead_time_days}d lead</div>}
                        </div>
                      )}
                      {added
                        ? <span className="text-xs text-green-600 font-medium flex-shrink-0">added</span>
                        : inv.drawing_file && <span className="text-xs bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded font-medium flex-shrink-0">Drawing</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="table-header text-left" style={{ minWidth: '320px' }}>Item</th>
                  <th className="table-header text-center" style={{ width: '80px' }}>Unit</th>
                  <th className="table-header text-right" style={{ width: '90px' }}>Qty</th>
                  <th className="table-header text-right" style={{ width: '110px' }}>Rate (₹)</th>
                  <th className="table-header text-right" style={{ width: '120px' }}>Amount (₹)</th>
                  <th className="table-header" style={{ width: '40px' }}></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.length === 0 ? (
                  <tr><td colSpan={6} className="text-center text-gray-400 py-6 text-sm">No items added yet — search above to add.</td></tr>
                ) : items.map((item, idx) => (
                    <tr key={idx}>
                      <td className="table-cell" style={{ minWidth: '320px' }}>
                        <div className="font-medium text-gray-800">{item.description}</div>
                      </td>
                      <td className="table-cell text-center text-gray-600">{item.unit || '—'}</td>
                      <td className="table-cell">
                        <input className="input text-xs py-1.5 text-right" type="number" step="any" value={item.qty} onChange={e => updateItem(idx, 'qty', e.target.value)} placeholder="0" />
                      </td>
                      <td className="table-cell">
                        <input className="input text-xs py-1.5 text-right" type="number" step="0.01" value={item.rate} onChange={e => updateItem(idx, 'rate', e.target.value)} placeholder="0.00" />
                      </td>
                      <td className="table-cell text-right font-semibold text-gray-700">
                        ₹{fmt(item.amount || 0)}
                      </td>
                      <td className="table-cell">
                        <button type="button" className="text-red-400 hover:text-red-600 p-1" onClick={() => removeItem(idx)}>
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div className="mt-4 border-t border-gray-100 pt-4">
            <div className="flex flex-col items-end gap-1.5 text-sm max-w-xs ml-auto">
              <div className="flex justify-between w-full text-gray-600">
                <span>Items Subtotal</span>
                <span className="font-medium">₹{fmt(itemsSubtotal)}</span>
              </div>
              <div className="flex justify-between w-full text-gray-600 items-center">
                <span>Transport Charges</span>
                <div className="flex items-center gap-2">
                  <span>₹</span>
                  <input className="input text-xs py-1 text-right w-24" type="number" step="0.01" value={transportCharges} onChange={e => setTransportCharges(e.target.value)} />
                </div>
              </div>
              <div className="flex justify-between w-full text-gray-600">
                <span>Total (before GST)</span>
                <span className="font-medium">₹{fmt(subtotal)}</span>
              </div>
              <div className="flex justify-between w-full text-gray-600">
                <span>IGST ({igstPercent}%)</span>
                <span className="font-medium">₹{fmt(igstAmount)}</span>
              </div>
              <div className="flex justify-between w-full text-gray-900 font-bold text-base border-t border-gray-200 pt-2 mt-1">
                <span>Grand Total</span>
                <span>₹{fmt(grandTotal)}</span>
              </div>
            </div>
          </div>
        </div>

        {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

        <div className="flex gap-3 justify-end pb-6">
          <button type="button" className="btn-secondary" onClick={() => navigate(isEdit ? `/purchases/${id}` : '/purchases')}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Purchase Order'}
          </button>
        </div>
      </form>
    </div>
  );
}
