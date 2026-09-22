import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import Modal from '../../components/ui/Modal';
import CategorySelect from '../../components/CategorySelect';
import { fmtDateTime, fmtDate } from '../../lib/utils';
import { ArrowLeft, Plus, TrendingUp, TrendingDown, Upload, ExternalLink, FileText, Trash2, History, RotateCcw, CheckCircle } from 'lucide-react';

export default function InventoryDetail() {
  const { id } = useParams();
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showTransaction, setShowTransaction] = useState(false);
  const [showEdit, setShowEdit] = useState(false);

  const canManage = ['owner', 'admin'].includes(user.role);
  // Design keeps the drawings current: they attach newly approved ones, which
  // supersede the old (hidden from use, kept in the timeline).
  const canDraw = ['owner', 'admin', 'design'].includes(user.role);
  const canSeeTimeline = ['owner', 'admin', 'design'].includes(user.role);
  const canTransact = ['owner', 'admin', 'design'].includes(user.role); // QC can add stock transactions (no cost shown)
  const canDelete = ['owner', 'admin'].includes(user.role);
  const showCost = user.role !== 'design'; // hide all landed-cost figures from QC

  const [drawings, setDrawings] = useState([]);
  const [showDrawingModal, setShowDrawingModal] = useState(false);
  const loadDrawings = () => api.get(`/inventory/${id}/drawings`).then(r => setDrawings(r.data)).catch(() => {});
  const load = () => {
    if (canSeeTimeline) loadDrawings();
    return api.get(`/inventory/${id}`).then(r => setItem(r.data)).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [id]);

  const restoreDrawing = async (d) => {
    if (!window.confirm(`Bring version ${d.version} back into use?\n\nIt is recorded as a new version, so the timeline stays intact.`)) return;
    try {
      const r = await api.put(`/inventory/${id}/drawings/${d.id}/restore`);
      setDrawings(r.data.drawings);
      load();
    } catch (e) { alert(e.response?.data?.error || 'Failed to restore'); }
  };

  if (loading) return <div className="p-8 text-center text-gray-400">Loading...</div>;
  if (!item) return <div className="p-8 text-center text-red-500">Item not found</div>;

  // Reorder level 0 = order-driven item (bought only when an order needs it) — never "low".
  const isLow = Number(item.reorder_level) > 0 && item.current_stock <= item.reorder_level;

  const handleDelete = async () => {
    if (!window.confirm(`Delete inventory item "${item.item_code} — ${item.name}"?\n\nThis cannot be undone.`)) return;
    try {
      await api.delete(`/inventory/${id}`);
      navigate('/inventory');
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to delete item');
    }
  };

  // Owner-only: remove a manual stock transaction; the server reverses its
  // stock effect (auto-posted PO/production rows are protected server-side).
  const handleDeleteTx = async (t) => {
    if (!window.confirm(`Remove this ${t.transaction_type.replace(/_/g, ' ')} of ${t.quantity} ${item.unit}?\n\nStock will be adjusted back accordingly.`)) return;
    try { await api.delete(`/inventory/${id}/transactions/${t.id}`); load(); }
    catch (e) { alert(e.response?.data?.error || 'Failed to remove transaction'); }
  };

  // Owner-only: remove a FIFO cost lot — its remaining qty leaves stock and the
  // average landed cost recomputes from the remaining lots.
  const handleDeleteLot = async (l) => {
    if (!window.confirm(`Remove this FIFO lot (${l.qty_remaining} ${item.unit} remaining @ ₹${l.unit_cost})?\n\nStock reduces by ${l.qty_remaining} ${item.unit} and the average landed cost recomputes.`)) return;
    try { await api.delete(`/inventory/${id}/fifo-lots/${l.id}`); load(); }
    catch (e) { alert(e.response?.data?.error || 'Failed to remove lot'); }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-4 mb-6">
        <button onClick={() => navigate('/inventory')} className="btn-ghost btn-sm"><ArrowLeft size={16} /> Back</button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900">{item.item_code}</h1>
            {isLow && <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">⚠ Low Stock</span>}
          </div>
          <p className="text-gray-500 text-sm mt-0.5">{item.name}</p>
        </div>
        <div className="flex gap-2">
          {canManage && (
            <button className="btn-secondary btn-sm" onClick={() => setShowEdit(true)}>Edit</button>
          )}
          {canTransact && (
            <button className="btn-primary" onClick={() => setShowTransaction(true)}>
              <Plus size={16} /> Transaction
            </button>
          )}
          {canDelete && (
            <button className="btn-danger btn-sm flex items-center gap-1.5" onClick={handleDelete}>
              <Trash2 size={14} /> Delete
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 mb-6">
        <div className="card p-5 lg:col-span-1 flex flex-col gap-4">
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Current Stock</div>
            <div className={`text-4xl font-bold ${isLow ? 'text-red-600' : 'text-green-600'}`}>{item.current_stock}</div>
            <div className="text-gray-500 text-sm mt-1">{item.unit}</div>
            <div className="mt-3 pt-3 border-t border-gray-100">
              <div className="text-xs text-gray-500">Reorder Level: <span className="font-medium text-gray-700">{item.reorder_level} {item.unit}</span></div>
              {Number(item.min_order_qty) > 0 && <div className="text-xs text-gray-500 mt-1">Min Order Qty: <span className="font-medium text-gray-700">{item.min_order_qty} {item.unit}</span></div>}
              {showCost && item.unit_cost > 0 && <div className="text-xs text-gray-500 mt-1">Avg Landed Cost: <span className="font-medium text-gray-700">₹{Number(item.unit_cost).toLocaleString('en-IN', { minimumFractionDigits: 2 })}/{item.unit}</span></div>}
              {showCost && item.unit_cost > 0 && <div className="text-xs text-gray-500 mt-1">Stock Value: <span className="font-semibold text-gray-800">₹{(Number(item.current_stock) * Number(item.unit_cost)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>}
              {item.category && <div className="text-xs text-gray-500 mt-1">Category: <span className="font-medium text-gray-700">{item.category}</span></div>}
            </div>
          </div>
          <div className="border-t border-gray-100 pt-3">
            <div className="text-xs text-gray-500 uppercase tracking-wide mb-2 flex items-center justify-between gap-1">
              <span className="flex items-center gap-1"><FileText size={11} /> Drawing in use</span>
              {canDraw && (
                <button className="text-brand-600 hover:underline normal-case tracking-normal text-xs font-medium"
                  onClick={() => setShowDrawingModal(true)}>
                  {item.drawing_file ? 'Add new version' : 'Attach drawing'}
                </button>
              )}
            </div>
            {item.drawing_file ? (
              <a href={`/uploads/${item.drawing_file}`} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 text-brand-600 text-sm hover:underline">
                <ExternalLink size={13} />
                <span className="truncate">{item.drawing_original_name || 'View Drawing'}</span>
              </a>
            ) : (
              <span className="text-xs text-gray-400 italic">No drawing attached yet.</span>
            )}

            {/* Timeline — owner + design. Superseded versions stay readable but
                are clearly out of use, so nothing is lost when a drawing changes. */}
            {canSeeTimeline && drawings.length > 0 && (
              <div className="mt-4">
                <div className="text-xs text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1">
                  <History size={11} /> Drawing history ({drawings.length})
                </div>
                <ol className="space-y-2">
                  {drawings.map(d => {
                    const current = !d.superseded_at;
                    return (
                      <li key={d.id} className={`text-xs border-l-2 pl-2.5 py-0.5 ${current ? 'border-green-400' : 'border-gray-200'}`}>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className={`font-semibold ${current ? 'text-green-700' : 'text-gray-500'}`}>v{d.version}</span>
                          {current
                            ? <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-green-700 bg-green-50 rounded px-1 py-0.5"><CheckCircle size={9} /> In use</span>
                            : <span className="text-[10px] text-gray-400 bg-gray-50 rounded px-1 py-0.5">Superseded {fmtDate(d.superseded_at)}</span>}
                          <a href={`/uploads/${d.file_path}`} target="_blank" rel="noopener noreferrer"
                            className={`truncate hover:underline ${current ? 'text-brand-600' : 'text-gray-500'}`}>
                            {d.original_name || 'drawing'}
                          </a>
                          {!current && user.role === 'owner' && (
                            <button className="ml-auto text-[10px] text-brand-600 hover:underline inline-flex items-center gap-0.5"
                              onClick={() => restoreDrawing(d)} title="Bring this version back into use">
                              <RotateCcw size={9} /> Restore
                            </button>
                          )}
                        </div>
                        <div className="text-gray-400 mt-0.5">
                          {fmtDateTime(d.uploaded_at)}{d.uploaded_by_name ? ` · ${d.uploaded_by_name}` : ''}
                        </div>
                        {d.notes && <div className="text-gray-500 mt-0.5">{d.notes}</div>}
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}
          </div>
        </div>

        <div className="card overflow-hidden lg:col-span-3">
          <div className="px-5 py-4 border-b border-gray-100">
            <h2 className="section-title text-sm">Transaction History</h2>
          </div>
          <div className="overflow-x-auto max-h-72 overflow-y-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
                <tr>
                  <th className="table-header text-left">Date</th>
                  <th className="table-header text-left">Type</th>
                  <th className="table-header text-right">Qty</th>
                  <th className="table-header text-right">Balance</th>
                  <th className="table-header text-left">Reference</th>
                  <th className="table-header text-left">Notes</th>
                  {user.role === 'owner' && <th className="table-header w-8"></th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {item.transactions?.length === 0 ? (
                  <tr><td colSpan={user.role === 'owner' ? 7 : 6} className="table-cell text-center text-gray-400 py-6">No transactions yet</td></tr>
                ) : item.transactions?.map(t => {
                  const isIn = ['opening_stock','purchase_in','return_from_production'].includes(t.transaction_type);
                  return (
                    <tr key={t.id}>
                      <td className="table-cell text-gray-500 text-xs whitespace-nowrap">{fmtDate(t.created_at)}</td>
                      <td className="table-cell">
                        <div className="flex items-center gap-1.5">
                          {isIn ? <TrendingUp size={13} className="text-green-500" /> : <TrendingDown size={13} className="text-red-500" />}
                          <span className="text-xs capitalize">{t.transaction_type.replace(/_/g, ' ')}</span>
                        </div>
                      </td>
                      <td className={`table-cell text-right font-semibold text-sm ${isIn ? 'text-green-600' : 'text-red-600'}`}>
                        {isIn ? '+' : '-'}{t.quantity}
                      </td>
                      <td className="table-cell text-right text-gray-700 font-medium">{t.balance_after}</td>
                      <td className="table-cell text-xs text-gray-500">
                        {t.job_card_no && <Link to={`/job-cards/${t.job_card_id}`} className="text-brand-600 hover:underline">{t.job_card_no}</Link>}
                        {t.supplier_name && <span>{t.supplier_name}</span>}
                        {t.po_number && <span className="text-gray-400"> ({t.po_number})</span>}
                      </td>
                      <td className="table-cell text-xs text-gray-400">{t.notes}</td>
                      {user.role === 'owner' && (
                        <td className="table-cell text-center">
                          <button className="p-1 text-red-400 hover:text-red-600" title="Remove transaction (stock adjusts back)"
                            onClick={() => handleDeleteTx(t)}>
                            <Trash2 size={13} />
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {showCost && item.fifo_lots?.length > 0 && (
        <div className="card overflow-hidden mb-6">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <h2 className="section-title text-sm">Landed Cost — Open Lots (FIFO)</h2>
            <span className="text-xs text-gray-500">
              Total Value: <span className="font-semibold text-gray-800">₹{item.fifo_lots.reduce((s, l) => s + Number(l.qty_remaining) * Number(l.unit_cost), 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="table-header text-left">Received</th>
                  <th className="table-header text-left">PO</th>
                  <th className="table-header text-right">Qty Remaining</th>
                  <th className="table-header text-right">Landed Cost / {item.unit}</th>
                  <th className="table-header text-right">Lot Value</th>
                  {user.role === 'owner' && <th className="table-header w-8"></th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {item.fifo_lots.map(l => (
                  <tr key={l.id}>
                    <td className="table-cell text-gray-500 text-xs whitespace-nowrap">{fmtDate(l.received_at)}</td>
                    <td className="table-cell text-xs text-brand-600">{l.po_number || '—'}</td>
                    <td className="table-cell text-right text-gray-700">{l.qty_remaining} <span className="text-gray-400">/ {l.qty_original}</span></td>
                    <td className="table-cell text-right font-medium text-gray-800">₹{Number(l.unit_cost).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                    <td className="table-cell text-right text-gray-700">₹{(Number(l.qty_remaining) * Number(l.unit_cost)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    {user.role === 'owner' && (
                      <td className="table-cell text-center">
                        <button className="p-1 text-red-400 hover:text-red-600" title="Remove lot (stock reduces by its remaining qty; avg cost recomputes)"
                          onClick={() => handleDeleteLot(l)}>
                          <Trash2 size={13} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showTransaction && <TransactionModal itemId={id} item={item} onClose={() => setShowTransaction(false)} onSave={() => { setShowTransaction(false); load(); }} />}
      {showEdit && <EditItemModal item={item} onClose={() => setShowEdit(false)} onSave={() => { setShowEdit(false); load(); }} />}
      {showDrawingModal && <NewDrawingModal itemId={id} item={item} hasCurrent={!!item.drawing_file} onClose={() => setShowDrawingModal(false)} onSaved={() => { setShowDrawingModal(false); load(); }} />}
    </div>
  );
}

function TransactionModal({ itemId, item, onClose, onSave }) {
  const { user } = useAuthStore();
  const [f, setF] = useState({ transaction_type: 'purchase_in', quantity: '', supplier_name: '', po_number: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [suppliers, setSuppliers] = useState([]);
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));
  // QC/design must never see supplier data
  const canSeeSuppliers = user.role !== 'design';

  useEffect(() => {
    if (!canSeeSuppliers) return;
    api.get('/suppliers').then(r => setSuppliers(r.data)).catch(() => {});
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try { await api.post(`/inventory/${itemId}/transactions`, f); onSave(); }
    catch (err) { setError(err.response?.data?.error || 'Failed'); setSaving(false); }
  };

  return (
    <Modal open title={`Transaction — ${item.item_code}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">Transaction Type</label>
          <select className="input" value={f.transaction_type} onChange={set('transaction_type')}>
            <option value="purchase_in">Purchase In</option>
            <option value="return_from_production">Return from Production</option>
            <option value="adjustment">Stock Adjustment</option>
          </select>
        </div>
        <div>
          <label className="label">Quantity ({item.unit}) *</label>
          <input className="input" type="number" step="any" value={f.quantity} onChange={set('quantity')} required />
        </div>
        {['purchase_in'].includes(f.transaction_type) && canSeeSuppliers && (
          <>
            <div>
              <label className="label">Supplier</label>
              <select className="input" value={f.supplier_name} onChange={set('supplier_name')}>
                <option value="">— Select supplier —</option>
                {suppliers.map(s => (
                  <option key={s.id} value={s.name}>{s.name}{s.supplier_code ? ` (${s.supplier_code})` : ''}</option>
                ))}
              </select>
            </div>
            <div><label className="label">PO Number</label><input className="input" value={f.po_number} onChange={set('po_number')} /></div>
          </>
        )}
        <div><label className="label">Notes</label><textarea className="input h-16 resize-none" value={f.notes} onChange={set('notes')} /></div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <div className="flex gap-3">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving}>{saving ? 'Saving...' : 'Record Transaction'}</button>
        </div>
      </form>
    </Modal>
  );
}

function EditItemModal({ item, onClose, onSave }) {
  const [f, setF] = useState({ item_code: item.item_code, name: item.name, name_gu: item.name_gu || '', category: item.category || '', unit: item.unit, reorder_level: item.reorder_level, min_order_qty: item.min_order_qty || 0, unit_cost: item.unit_cost || '', notes: item.notes || '' });
  const [drawing, setDrawing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const fd = new FormData();
      Object.entries(f).forEach(([k, v]) => fd.append(k, v));
      if (drawing) fd.append('drawing', drawing);
      await api.put(`/inventory/${item.id}`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      onSave();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed');
      setSaving(false);
    }
  };

  return (
    <Modal open title="Edit Item" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div><label className="label">Item Code</label><input className="input" value={f.item_code} onChange={set('item_code')} /></div>
          <div><label className="label">Unit</label><input className="input" value={f.unit} onChange={set('unit')} /></div>
          <div className="col-span-2"><label className="label">Name</label><input className="input" value={f.name} onChange={set('name')} /></div>
          <div className="col-span-2"><label className="label">Name (ગુજરાતી) <span className="font-normal normal-case text-gray-400">(auto-generated if left blank)</span></label><input className="input" placeholder="ખાલી છોડો — આપમેળે બનશે" value={f.name_gu} onChange={set('name_gu')} /></div>
          <div><label className="label">Category</label><CategorySelect value={f.category} onChange={v => setF(p => ({ ...p, category: v }))} /></div>
          <div><label className="label">Reorder Level</label><input className="input" type="number" step="any" value={f.reorder_level} onChange={set('reorder_level')} /></div>
          <div><label className="label">Min Order Qty</label><input className="input" type="number" step="any" min="0" placeholder="e.g. 100" value={f.min_order_qty} onChange={set('min_order_qty')} /></div>
          <div><label className="label">Unit Price (₹)</label><input className="input" type="number" step="any" min="0" placeholder="e.g. 12.50" value={f.unit_cost} onChange={set('unit_cost')} /></div>
          <div><label className="label">Notes</label><input className="input" value={f.notes} onChange={set('notes')} /></div>
          <div className="col-span-2">
            <label className="label">
              {item.drawing_file ? 'Replace Drawing' : 'Attach Drawing'}
              <span className="font-normal normal-case text-gray-400 ml-1">(PDF or image, optional)</span>
            </label>
            {item.drawing_file && !drawing && (
              <div className="text-xs text-gray-500 mb-1">
                Current: <a href={`/uploads/${item.drawing_file}`} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline">{item.drawing_original_name}</a>
              </div>
            )}
            <label className="flex items-center gap-2 cursor-pointer border border-gray-200 rounded-lg px-3 py-2 hover:border-brand-400 transition-colors bg-gray-50">
              <Upload size={15} className="text-gray-400 flex-shrink-0" />
              <span className="text-sm text-gray-600 flex-1 truncate">
                {drawing ? drawing.name : item.drawing_file ? 'Click to replace...' : 'Click to attach drawing...'}
              </span>
              <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" className="hidden"
                onChange={e => setDrawing(e.target.files[0] || null)} />
            </label>
          </div>
        </div>
        {error && <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
        <div className="flex gap-3">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving}>{saving ? 'Saving...' : 'Update'}</button>
        </div>
      </form>
    </Modal>
  );
}

// Design attaches a newly approved drawing. It becomes the version in use; the
// previous one is superseded — hidden from the people who consume drawings,
// but kept in the item's timeline for the owner and design.
function NewDrawingModal({ itemId, item, hasCurrent, onClose, onSaved }) {
  const [file, setFile] = useState(null);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!file) return setError('Choose the approved drawing file.');
    setSaving(true); setError('');
    try {
      const fd = new FormData();
      fd.append('drawing', file);
      if (notes.trim()) fd.append('notes', notes.trim());
      await api.post(`/inventory/${itemId}/drawings`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to attach drawing');
      setSaving(false);
    }
  };

  return (
    <Modal open title={`New approved drawing — ${item.item_code}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs text-gray-500">
          {hasCurrent
            ? 'This becomes the drawing in use everywhere. The current one is kept in the history and stops being used.'
            : 'This becomes the drawing in use everywhere for this item.'}
        </p>
        <div>
          <label className="label">Drawing file *</label>
          <label className="flex items-center gap-2 border border-dashed border-gray-300 rounded-lg px-3 py-2.5 cursor-pointer hover:border-brand-400">
            <Upload size={15} className="text-gray-400" />
            <span className="text-sm text-gray-600 truncate">{file ? file.name : 'Click to choose the approved drawing...'}</span>
            <input type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png,.webp"
              onChange={e => setFile(e.target.files[0] || null)} />
          </label>
        </div>
        <div>
          <label className="label">What changed? (optional)</label>
          <input className="input" value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="e.g. PCD corrected to 56.3, approved 17 Sep" />
        </div>
        {error && <div className="text-sm text-red-600">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Attaching...' : 'Attach as new version'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
