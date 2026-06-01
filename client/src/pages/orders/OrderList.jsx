import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import StatusBadge from '../../components/ui/StatusBadge';
import Modal from '../../components/ui/Modal';
import FileUpload from '../../components/ui/FileUpload';
import { fmtDate, downloadExcel } from '../../lib/utils';
import { Plus, Search, Trash2, Edit2, Package, Image as ImageIcon, X, Download } from 'lucide-react';

// ── Validation helper ────────────────────────────────────────────────────────
function validateItem(f) {
  const missing = [];
  if (!f.product_code?.trim())       missing.push('Product Code');
  if (!f.drawing_number?.trim())     missing.push('Drawing Number');
  if (!f.tube_material?.trim())      missing.push('Tube Material');
  if (!f.tube_diameter)              missing.push('Tube Diameter');
  if (!f.wattage)                    missing.push('Wattage');
  if (!f.voltage)                    missing.push('Voltage');
  if (!f.plating_instructions?.trim()) missing.push('Plating Instructions');
  if (!f.quantity)                   missing.push('Quantity');
  return missing;
}

export default function OrderList() {
  const { user } = useAuthStore();
  const [orders, setOrders] = useState([]);
  const [filtered, setFiltered] = useState([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const navigate = useNavigate();

  useEffect(() => { load(); }, []);
  useEffect(() => {
    let r = orders;
    if (search) r = r.filter(o =>
      o.order_code.toLowerCase().includes(search.toLowerCase()) ||
      o.customer_code.toLowerCase().includes(search.toLowerCase()) ||
      (o.customer_name && o.customer_name.toLowerCase().includes(search.toLowerCase()))
    );
    if (statusFilter) r = r.filter(o => o.status === statusFilter);
    setFiltered(r);
  }, [orders, search, statusFilter]);

  async function load() {
    setLoading(true);
    try { const r = await api.get('/orders'); setOrders(r.data); setFiltered(r.data); }
    finally { setLoading(false); }
  }

  const canCreate = ['admin', 'owner'].includes(user.role);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Orders</h1>
          <p className="text-gray-500 text-sm mt-0.5">{orders.length} total orders</p>
        </div>
        <div className="flex items-center gap-2">
          {['admin','owner','accounts'].includes(user.role) && (
            <button className="btn-secondary flex items-center gap-1.5 text-sm"
              onClick={() => downloadExcel('orders', 'orders.xlsx')}>
              <Download size={15} /> Export Excel
            </button>
          )}
          {canCreate && (
            <button className="btn-primary" onClick={() => setShowNew(true)}>
              <Plus size={16} /> New Order
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-5">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-2.5 text-gray-400" />
          <input className="input pl-9" placeholder="Search order code, customer..." value={search}
            onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="input max-w-[200px]" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="pending_approval">Pending Approval</option>
          <option value="approved">Approved</option>
          <option value="job_card_created">Job Card Created</option>
          <option value="in_progress">In Progress</option>
          <option value="qc_pending">QC Pending</option>
          <option value="qc_approved">QC Approved</option>
          <option value="packaging">Packaging</option>
          <option value="dispatched">Dispatched</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="table-header text-left">Order Code</th>
              <th className="table-header text-left">Type</th>
              <th className="table-header text-left">Customer</th>
              <th className="table-header text-left">Order Date</th>
              <th className="table-header text-center">Items</th>
              <th className="table-header text-left">Job Card</th>
              <th className="table-header text-left">Status</th>
              <th className="table-header text-left">Created By</th>
              {user.role === 'owner' && <th className="table-header" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={9} className="table-cell text-center text-gray-400 py-12">Loading...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={9} className="table-cell text-center text-gray-400 py-12">No orders found</td></tr>
            ) : filtered.map(o => (
              <tr key={o.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => navigate(`/orders/${o.id}`)}>
                <td className="table-cell font-semibold text-brand-700">{o.order_code}</td>
                <td className="table-cell">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    o.order_type === 'export_he'       ? 'bg-purple-100 text-purple-700' :
                    o.order_type === 'inventory_order' ? 'bg-amber-100 text-amber-700' :
                    o.order_type === 'io_export_he'    ? 'bg-orange-100 text-orange-700' :
                    o.order_type === 'io_local_he'     ? 'bg-teal-100 text-teal-700' :
                                                         'bg-blue-50 text-blue-700'
                  }`}>
                    {o.order_type === 'export_he'       ? 'Export HE' :
                     o.order_type === 'inventory_order' ? 'IO' :
                     o.order_type === 'io_export_he'    ? 'IO + Export HE' :
                     o.order_type === 'io_local_he'     ? 'IO + Local HE' :
                                                          'Local HE'}
                  </span>
                </td>
                <td className="table-cell">
                  <div className="font-medium">{o.customer_code}</div>
                  {o.customer_name && <div className="text-xs text-gray-400">{o.customer_name}</div>}
                </td>
                <td className="table-cell text-gray-600">{fmtDate(o.order_date)}</td>
                <td className="table-cell text-center">
                  {o.item_count > 0
                    ? <span className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full font-medium"><Package size={11} />{o.item_count}</span>
                    : <span className="text-gray-300 text-xs">—</span>}
                </td>
                <td className="table-cell">
                  {o.job_card_no
                    ? <span className="text-brand-600 font-medium text-xs">{o.job_card_no}</span>
                    : <span className="text-gray-300 text-xs">—</span>}
                </td>
                <td className="table-cell"><StatusBadge status={o.status} /></td>
                <td className="table-cell text-gray-500 text-xs">{o.created_by_name}</td>
                {user.role === 'owner' && (
                  <td className="table-cell" onClick={e => e.stopPropagation()}>
                    <button
                      onClick={async () => {
                        if (!window.confirm(`Delete order "${o.order_code}" and all its data? This cannot be undone.`)) return;
                        try { await api.delete(`/orders/${o.id}`); setOrders(prev => prev.filter(x => x.id !== o.id)); }
                        catch (e) { alert(e.response?.data?.error || 'Failed to delete'); }
                      }}
                      className="p-1.5 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                      title="Delete order"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showNew && (
        <NewOrderModal
          onClose={() => setShowNew(false)}
          onSave={(id) => { setShowNew(false); navigate(`/orders/${id}`); }}
        />
      )}
    </div>
  );
}

// ── Item sub-modal ──────────────────────────────────────────────────────────
function ItemModal({ item, images: initialImages = [], onClose, onSave }) {
  const blank = {
    product_code: '', drawing_number: '', tube_material: '', tube_diameter: '',
    wattage: '', voltage: '', plating_instructions: '', quantity: '', remark: ''
  };
  const [f, setF] = useState(item || blank);
  const [images, setImages] = useState(initialImages); // File[] for new images
  const [error, setError] = useState('');
  const [products, setProducts] = useState([]);
  const [productSearch, setProductSearch] = useState(item?.product_code || '');
  const [showDropdown, setShowDropdown] = useState(false);
  const [inventoryItems, setInventoryItems] = useState([]);
  const [selectedInventory, setSelectedInventory] = useState(
    item?.inventory_items?.map(i => i.id) || []
  );
  const [invSearch, setInvSearch] = useState('');
  const [showInvDropdown, setShowInvDropdown] = useState(false);
  const imgRef = useRef();
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));

  useEffect(() => {
    api.get('/products').then(r => setProducts(r.data)).catch(() => {});
    api.get('/inventory').then(r => setInventoryItems(r.data)).catch(() => {});
  }, []);

  const filteredInventory = inventoryItems.filter(i =>
    i.item_code.toLowerCase().includes(invSearch.toLowerCase()) ||
    i.name.toLowerCase().includes(invSearch.toLowerCase()) ||
    (i.category || '').toLowerCase().includes(invSearch.toLowerCase())
  ).slice(0, 10);

  const toggleInventory = (id) => {
    setSelectedInventory(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const selectedInventoryItems = inventoryItems.filter(i => selectedInventory.includes(i.id));

  const filteredProducts = products.filter(p =>
    p.product_code.toLowerCase().includes(productSearch.toLowerCase()) ||
    p.name.toLowerCase().includes(productSearch.toLowerCase())
  ).slice(0, 8);

  const selectProduct = (p) => {
    setF(prev => ({ ...prev, product_code: p.product_code }));
    setProductSearch(p.product_code);
    setShowDropdown(false);
  };

  const addImages = (e) => {
    const files = Array.from(e.target.files);
    setImages(prev => [...prev, ...files]);
    e.target.value = '';
  };

  const handleSave = () => {
    const missing = validateItem(f);
    if (missing.length) {
      setError(`Required fields missing: ${missing.join(', ')}`);
      return;
    }
    if (selectedInventory.length === 0) {
      setError('Please select at least one inventory item');
      return;
    }
    onSave({ ...f, inventory_item_ids: selectedInventory }, images);
  };

  return (
    <Modal open title={item ? 'Edit Item' : 'Add Item'} onClose={onClose} size="lg">
      <div className="grid grid-cols-2 gap-4">
        {/* Product Code */}
        <div className="col-span-2 relative">
          <label className="label">Product Code <span className="text-red-500">*</span></label>
          <input
            className="input"
            placeholder="Search by product code or name..."
            value={productSearch}
            onChange={e => { setProductSearch(e.target.value); setShowDropdown(true); setF(p => ({ ...p, product_code: e.target.value })); }}
            onFocus={() => setShowDropdown(true)}
            onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
            autoComplete="off"
          />
          {showDropdown && filteredProducts.length > 0 && (
            <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-52 overflow-y-auto">
              {filteredProducts.map(p => (
                <button
                  key={p.id}
                  type="button"
                  className="w-full text-left px-4 py-2.5 hover:bg-brand-50 flex items-center gap-3 border-b border-gray-50 last:border-0"
                  onMouseDown={() => selectProduct(p)}
                >
                  {p.photo_file ? (
                    <img src={`/uploads/${p.photo_file}`} alt={p.name} className="w-8 h-8 object-cover rounded-md border border-gray-200 flex-shrink-0" />
                  ) : (
                    <div className="w-8 h-8 rounded-md bg-gray-100 flex-shrink-0" />
                  )}
                  <div>
                    <p className="text-sm font-semibold text-brand-700">{p.product_code}</p>
                    <p className="text-xs text-gray-500">{p.name}{p.category ? ` · ${p.category}` : ''}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Drawing Number */}
        <div className="col-span-2">
          <label className="label">Drawing Number <span className="text-red-500">*</span></label>
          <input className="input" placeholder="e.g. PT-FlangeHe-QU-2Kw-Cop"
            value={f.drawing_number} onChange={set('drawing_number')} />
        </div>

        {/* Tube */}
        <div>
          <label className="label">Tube Material <span className="text-red-500">*</span></label>
          <input className="input" placeholder="e.g. Copper, SS 304"
            value={f.tube_material} onChange={set('tube_material')} />
        </div>
        <div>
          <label className="label">Tube Diameter (mm) <span className="text-red-500">*</span></label>
          <input className="input" type="number" step="any" placeholder="e.g. 8"
            value={f.tube_diameter} onChange={set('tube_diameter')} />
        </div>

        {/* Electrical */}
        <div>
          <label className="label">Wattage (W) <span className="text-red-500">*</span></label>
          <input className="input" type="number" step="any" placeholder="e.g. 2000"
            value={f.wattage} onChange={set('wattage')} />
        </div>
        <div>
          <label className="label">Voltage (V) <span className="text-red-500">*</span></label>
          <input className="input" type="number" step="any" placeholder="e.g. 230"
            value={f.voltage} onChange={set('voltage')} />
        </div>

        {/* Plating */}
        <div className="col-span-2">
          <label className="label">Plating Instructions <span className="text-red-500">*</span></label>
          <input className="input" placeholder="e.g. Nickel Plating / None"
            value={f.plating_instructions} onChange={set('plating_instructions')} />
        </div>

        {/* Quantity + Remark */}
        <div>
          <label className="label">Quantity <span className="text-red-500">*</span></label>
          <input className="input" type="number" min="1" placeholder="e.g. 20"
            value={f.quantity} onChange={set('quantity')} />
        </div>
        <div>
          <label className="label">Remark <span className="text-gray-400 font-normal">(optional)</span></label>
          <input className="input" placeholder="Any remarks..."
            value={f.remark} onChange={set('remark')} />
        </div>

        {/* Inventory Items */}
        <div className="col-span-2 relative">
          <label className="label">
            Inventory Items <span className="text-red-500">*</span>
            <span className="text-gray-400 font-normal ml-1">(select all raw materials needed)</span>
          </label>
          {/* Selected chips */}
          {selectedInventoryItems.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {selectedInventoryItems.map(i => (
                <span key={i.id} className="inline-flex items-center gap-1 text-xs bg-brand-50 text-brand-700 border border-brand-200 px-2 py-1 rounded-full font-medium">
                  {i.item_code} — {i.name}
                  <button type="button" onClick={() => toggleInventory(i.id)} className="ml-0.5 hover:text-red-500">
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            className="input"
            placeholder="Search inventory by code, name or category..."
            value={invSearch}
            onChange={e => { setInvSearch(e.target.value); setShowInvDropdown(true); }}
            onFocus={() => setShowInvDropdown(true)}
            onBlur={() => setTimeout(() => setShowInvDropdown(false), 150)}
            autoComplete="off"
          />
          {showInvDropdown && filteredInventory.length > 0 && (
            <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-52 overflow-y-auto">
              {filteredInventory.map(i => {
                const selected = selectedInventory.includes(i.id);
                return (
                  <button
                    key={i.id}
                    type="button"
                    className={`w-full text-left px-4 py-2.5 flex items-center gap-3 border-b border-gray-50 last:border-0 transition-colors ${selected ? 'bg-brand-50' : 'hover:bg-gray-50'}`}
                    onMouseDown={() => { toggleInventory(i.id); setInvSearch(''); }}
                  >
                    <div className={`w-4 h-4 rounded border-2 flex-shrink-0 flex items-center justify-center ${selected ? 'bg-brand-600 border-brand-600' : 'border-gray-300'}`}>
                      {selected && <svg width="8" height="8" viewBox="0 0 8 8" fill="none"><path d="M1 4l2 2 4-4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-gray-800">{i.item_code}</p>
                      <p className="text-xs text-gray-500 truncate">{i.name}{i.category ? ` · ${i.category}` : ''} · {i.unit}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Reference Images */}
        <div className="col-span-2">
          <label className="label">
            <ImageIcon size={13} className="inline mr-1 text-blue-500" />
            Reference Images <span className="text-gray-400 font-normal">(from client — optional)</span>
          </label>
          <div className="border-2 border-dashed border-gray-200 rounded-xl p-4 bg-gray-50">
            <input ref={imgRef} type="file" multiple accept=".jpg,.jpeg,.png,.gif,.webp"
              className="hidden" onChange={addImages} />
            {images.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {images.map((file, i) => (
                  <div key={i} className="relative group">
                    <img
                      src={URL.createObjectURL(file)}
                      alt={file.name}
                      className="w-16 h-16 object-cover rounded-lg border border-gray-200"
                    />
                    <button
                      type="button"
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full text-xs flex items-center justify-center shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => setImages(prev => prev.filter((_, j) => j !== i))}
                    >
                      <X size={10} />
                    </button>
                    <span className="sr-only">{file.name}</span>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              className="btn-secondary btn-sm w-full"
              onClick={() => imgRef.current.click()}
            >
              <ImageIcon size={14} />
              {images.length > 0 ? 'Add More Images' : 'Add Reference Images'}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <p className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-3">
          {error}
        </p>
      )}

      <div className="flex gap-3 mt-5">
        <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
        <button className="btn-primary flex-1" onClick={handleSave}>
          {item ? 'Update Item' : 'Add Item'}
        </button>
      </div>
    </Modal>
  );
}

// ── New Order modal ─────────────────────────────────────────────────────────
function NewOrderModal({ onClose, onSave }) {
  const [form, setForm] = useState({
    order_code: '',
    customer_id: '',
    inquiry_id: '',
    order_date: new Date().toISOString().split('T')[0],
    dispatch_date: '',
    notes: '',
    order_type: 'local_he'
  });
  const [customers, setCustomers] = useState([]);
  const [inquiries, setInquiries] = useState([]);
  const [quotationFile, setQuotationFile] = useState(null);
  const [items, setItems] = useState([]);
  const [itemImages, setItemImages] = useState({}); // { [itemIndex]: File[] }
  const [showItemModal, setShowItemModal] = useState(false);
  const [editingItem, setEditingItem] = useState(null); // { index, data, images }
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/customers').then(r => setCustomers(r.data)).catch(() => {});
    api.get('/orders/inquiries/all').then(r => setInquiries(r.data)).catch(() => {});
  }, []);

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const addItem = (data, files) => {
    if (editingItem !== null) {
      setItems(prev => prev.map((it, i) => i === editingItem.index ? data : it));
      setItemImages(prev => ({ ...prev, [editingItem.index]: files }));
    } else {
      const newIdx = items.length;
      setItems(prev => [...prev, data]);
      setItemImages(prev => ({ ...prev, [newIdx]: files }));
    }
    setShowItemModal(false);
    setEditingItem(null);
  };

  const removeItem = (idx) => {
    setItems(prev => prev.filter((_, i) => i !== idx));
    setItemImages(prev => {
      const next = {};
      Object.keys(prev).forEach(k => {
        const ki = parseInt(k);
        if (ki < idx) next[ki] = prev[k];
        else if (ki > idx) next[ki - 1] = prev[k];
      });
      return next;
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (items.length === 0) {
      setError('Please add at least one item before creating the order.');
      return;
    }

    setSaving(true);
    try {
      // 1. Create the order
      const orderRes = await api.post('/orders', form);
      const orderId = orderRes.data.id;

      // 2. Upload quotation if selected
      if (quotationFile) {
        const fd = new FormData();
        fd.append('file', quotationFile);
        fd.append('sent_date', form.order_date);
        await api.post(`/orders/${orderId}/quotation`, fd);
      }

      // 3. Save all items, then upload their reference images
      for (let i = 0; i < items.length; i++) {
        const itemRes = await api.post(`/orders/${orderId}/items`, items[i]);
        const itemId = itemRes.data.id;
        const files = itemImages[i];
        if (files?.length) {
          const fd = new FormData();
          files.forEach(f => fd.append('images', f));
          await api.post(`/orders/${orderId}/items/${itemId}/images`, fd);
        }
      }

      onSave(orderId);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create order');
      setSaving(false);
    }
  };

  return (
    <>
      <Modal open title="New Order" onClose={onClose} size="xl">
        <form onSubmit={handleSubmit} className="space-y-6">

          {/* ── Order Details ── */}
          <section>
            <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3 pb-1 border-b border-gray-100">
              Order Details
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Order Code <span className="text-red-500">*</span></label>
                <input className="input" placeholder="e.g. ORD-2026-001" value={form.order_code} onChange={set('order_code')} required />
              </div>
              <div>
                <label className="label">Order Type <span className="text-red-500">*</span></label>
                <select className="input" value={form.order_type} onChange={set('order_type')} required>
                  <option value="local_he">Local HE</option>
                  <option value="export_he">Export HE</option>
                  <option value="inventory_order">Inventory Order (IO)</option>
                  <option value="io_export_he">IO + Export HE</option>
                  <option value="io_local_he">IO + Local HE</option>
                </select>
              </div>
              <div>
                <label className="label">Order Date <span className="text-red-500">*</span></label>
                <input className="input" type="date" value={form.order_date} onChange={set('order_date')} required />
              </div>
              <div>
                <label className="label">Dispatch Date <span className="text-gray-400 font-normal">(optional)</span></label>
                <input className="input" type="date" value={form.dispatch_date} onChange={set('dispatch_date')} />
              </div>
              <div>
                <label className="label">Customer <span className="text-red-500">*</span></label>
                <select className="input" value={form.customer_id} onChange={set('customer_id')} required>
                  <option value="">Select customer...</option>
                  {customers.map(c => <option key={c.id} value={c.id}>{c.customer_code} — {c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Linked Inquiry <span className="text-gray-400 font-normal">(optional)</span></label>
                <select className="input" value={form.inquiry_id} onChange={set('inquiry_id')}>
                  <option value="">None</option>
                  {inquiries
                    .filter(i => !form.customer_id || String(i.customer_id) === String(form.customer_id))
                    .map(i => <option key={i.id} value={i.id}>{i.inquiry_code}</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <label className="label">Notes</label>
                <textarea className="input h-16 resize-none" placeholder="Any notes about the order..." value={form.notes} onChange={set('notes')} />
              </div>
            </div>
          </section>

          {/* ── Quotation Upload ── */}
          <section>
            <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3 pb-1 border-b border-gray-100">
              Quotation <span className="text-gray-400 font-normal normal-case">(optional)</span>
            </h3>
            <FileUpload onFile={setQuotationFile} accept=".pdf" label="Upload quotation PDF" />
          </section>

          {/* ── Items ── */}
          <section>
            <div className="flex items-center justify-between mb-3 pb-1 border-b border-gray-100">
              <div>
                <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
                  Items <span className="text-gray-400 font-normal normal-case">({items.length})</span>
                </h3>
                <p className="text-xs text-gray-400 mt-0.5">At least one item is required to create an order.</p>
              </div>
              <button type="button" className="btn-secondary btn-sm" onClick={() => { setEditingItem(null); setShowItemModal(true); }}>
                <Plus size={14} /> Add Item
              </button>
            </div>

            {items.length === 0 ? (
              <div className="text-center py-8 border-2 border-dashed border-gray-200 rounded-xl text-gray-400 text-sm">
                <Package size={28} className="mx-auto mb-2 text-gray-300" />
                No items added yet. Click <strong>Add Item</strong> to add product details.
              </div>
            ) : (
              <div className="space-y-2">
                {items.map((item, idx) => (
                  <div key={idx} className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3">
                    <div className="flex items-start gap-3">
                      <span className="w-6 h-6 rounded-full bg-brand-100 text-brand-700 text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                        {idx + 1}
                      </span>
                      <div className="flex-1 grid grid-cols-4 gap-x-4 gap-y-0.5 text-sm">
                        <div className="col-span-2">
                          <span className="text-gray-400 text-xs">Drawing: </span>
                          <span className="font-semibold">{item.drawing_number}</span>
                        </div>
                        <div>
                          <span className="text-gray-400 text-xs">Tube: </span>
                          <span>{item.tube_material}{item.tube_diameter && <span className="text-gray-400"> · {item.tube_diameter}mm</span>}</span>
                        </div>
                        <div>
                          <span className="text-gray-400 text-xs">Elec: </span>
                          <span>{item.wattage}W / {item.voltage}V</span>
                        </div>
                        <div className="col-span-2">
                          <span className="text-gray-400 text-xs">Plating: </span>
                          <span>{item.plating_instructions}</span>
                        </div>
                        {item.remark && (
                          <div className="col-span-2">
                            <span className="text-gray-400 text-xs">Remark: </span>
                            <span className="text-gray-600">{item.remark}</span>
                          </div>
                        )}
                        {/* Image thumbnails preview */}
                        {itemImages[idx]?.length > 0 && (
                          <div className="col-span-4 mt-1.5 flex flex-wrap gap-1.5">
                            {itemImages[idx].map((f, fi) => (
                              <img key={fi} src={URL.createObjectURL(f)} alt=""
                                className="w-10 h-10 object-cover rounded border border-gray-200" />
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="text-sm font-bold text-gray-900 bg-white border border-gray-200 rounded-lg px-2 py-0.5">
                          Qty: {item.quantity}
                        </div>
                      </div>
                      <div className="flex gap-1 flex-shrink-0">
                        <button type="button" className="btn-ghost btn-sm p-1.5" title="Edit"
                          onClick={() => { setEditingItem({ index: idx, data: item, images: itemImages[idx] || [] }); setShowItemModal(true); }}>
                          <Edit2 size={14} />
                        </button>
                        <button type="button" className="btn-ghost btn-sm p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50" title="Remove"
                          onClick={() => removeItem(idx)}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {error && <p className="text-red-600 text-sm bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</p>}

          <div className="flex gap-3 pt-2">
            <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
            <button
              type="submit"
              className="btn-primary flex-1"
              disabled={saving || items.length === 0}
              title={items.length === 0 ? 'Add at least one item first' : ''}
            >
              {saving
                ? 'Creating...'
                : items.length === 0
                  ? 'Add Items First'
                  : `Create Order · ${items.length} item${items.length > 1 ? 's' : ''}`}
            </button>
          </div>
        </form>
      </Modal>

      {showItemModal && (
        <ItemModal
          item={editingItem?.data || null}
          images={editingItem?.images || []}
          onClose={() => { setShowItemModal(false); setEditingItem(null); }}
          onSave={addItem}
        />
      )}
    </>
  );
}
