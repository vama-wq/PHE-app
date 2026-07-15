import { useEffect, useRef, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import api, { uploadApi } from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import StatusBadge from '../../components/ui/StatusBadge';
import Modal from '../../components/ui/Modal';
import FileUpload from '../../components/ui/FileUpload';
import DrawingUploadModal from '../../components/DrawingUploadModal';
import InventoryEditModal from '../../components/InventoryEditModal';
import { fmtDate, fmtDateTime, ACTIVITY_ICONS, ROLE_COLORS, ROLE_LABELS, transliterateHindi, transliterateGujarati } from '../../lib/utils';
import {
  ArrowLeft, CheckCircle, CheckCircle2, XCircle, FileText, Plus, Upload,
  ExternalLink, Trash2, Edit2, Package, PenLine, MessageSquare,
  Clock, AlertTriangle, Image as ImageIcon, Send, X, RefreshCw, ClipboardList, Paperclip, Download, File, RotateCcw
} from 'lucide-react';

// ── Required-field validation (mirrors OrderList) ────────────────────────────
function validateItem(f) {
  const missing = [];
  if (!f.drawing_number?.trim())       missing.push('Drawing Number');
  if (!f.tube_material?.trim())        missing.push('Tube Material');
  if (!f.tube_diameter)                missing.push('Tube Diameter');
  if (!f.wattage)                      missing.push('Wattage');
  if (!f.voltage)                      missing.push('Voltage');
  if (!f.plating_instructions?.trim()) missing.push('Plating Instructions');
  if (!f.quantity)                     missing.push('Quantity');
  return missing;
}

// Orders allowed to upload job cards before their drawings are approved.
// Drawings still show and follow the normal approval flow.
const DRAWING_BYPASS_ORDERS = ['ORD-020-26', 'ORD-024-26', 'ORD-017-26', 'ORD-053-26'];

export default function OrderDetail() {
  const { id } = useParams();
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sidebarTab, setSidebarTab] = useState('chat');

  // Modal visibility
  const [showApproveModal, setShowApproveModal] = useState(false);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [showQuotationModal, setShowQuotationModal] = useState(false);
  const [showJobCardModal, setShowJobCardModal] = useState(false);
  const [showItemModal, setShowItemModal] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [invEditItem, setInvEditItem] = useState(null);
  const [showDrawingModal, setShowDrawingModal] = useState(false);
  const [drawingUploadItemId, setDrawingUploadItemId] = useState(null); // null = order-level upload
  const [drawingUploadItem, setDrawingUploadItem]     = useState(null); // full item object for modal title
  const [showDrawingRejectModal, setShowDrawingRejectModal] = useState(false);
  const [deletingJobCard, setDeletingJobCard] = useState(null);
  const [editingOrder, setEditingOrder] = useState(false);
  const [editFields, setEditFields] = useState({});
  const [resubmitting, setResubmitting] = useState(false);
  const [fgJobCardItem, setFgJobCardItem] = useState(null); // item to create an FG inventory job card for

  const load = () =>
    api.get(`/orders/${id}`).then(r => setOrder(r.data)).finally(() => setLoading(false));
  useEffect(() => { load(); }, [id]);

  if (loading) return <div className="p-8 text-center text-gray-400">Loading order...</div>;
  if (!order) return <div className="p-8 text-center text-red-500">Order not found</div>;

  const restrictedRole       = ['design', 'qc', 'production'].includes(user.role);
  // Step 1: Owner approves the order (business approval — no drawing gate)
  const canApprove           = user.role === 'owner' && order.status === 'pending_approval';
  const orderApproved        = !['pending_approval', 'rejected'].includes(order.status);
  const isRejected           = order.status === 'rejected';
  const canResubmit          = isRejected && ['admin', 'owner', 'accounts'].includes(user.role);
  const hasDrawings          = order.order_drawings?.length > 0;
  // Per-item drawing status (computed server-side)
  const itemDrawingStatus    = order.item_drawing_status || {};
  const allItemsApproved     = (order.items || []).length > 0 &&
    (order.items || []).every(it => itemDrawingStatus[it.id] === 'approved');
  // Finished Goods orders skip production/job cards — they need an inventory QC report instead
  const isFG                 = order.order_type === 'finished_goods';
  const canManageItems       = ['admin', 'owner'].includes(user.role) || canResubmit;
  const canEditInventory     = ['design', 'admin', 'owner'].includes(user.role);
  const canUploadQuotation   = ['admin', 'owner'].includes(user.role) && !restrictedRole;
  // Step 2: Design can upload drawings only after order is approved
  const canUploadDrawing     = ['design', 'admin', 'owner'].includes(user.role) && orderApproved;
  // Step 3: Job card uploadable only if order approved AND item's drawing is individually approved
  const canUploadJobCardBase = ['admin', 'owner'].includes(user.role) && orderApproved;

  const handleDeleteItem = async (itemId) => {
    if (!window.confirm('Remove this item?')) return;
    await api.delete(`/orders/${id}/items/${itemId}`);
    load();
  };

  const handleDeleteItemImage = async (itemId, imageId) => {
    if (!window.confirm('Delete this image?')) return;
    await api.delete(`/orders/${id}/items/${itemId}/images/${imageId}`);
    load();
  };

  const handleDeleteDrawing = async (drawingId) => {
    if (!window.confirm('Delete this drawing?')) return;
    await api.delete(`/orders/${id}/drawings/${drawingId}`);
    load();
  };

  const handleDeleteJobCard = async (jcId) => {
    if (!window.confirm('Delete this job card? This cannot be undone.')) return;
    try {
      await api.delete(`/job-cards/${jcId}`);
      load();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to delete job card');
    }
  };

  const handleDeleteOrder = async () => {
    if (!window.confirm(`Delete order "${order.order_code}" and ALL its job cards, items and files? This cannot be undone.`)) return;
    try {
      await api.delete(`/orders/${id}`);
      navigate('/orders');
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to delete order');
    }
  };

  const startEditOrder = () => {
    setEditFields({
      dispatch_date: order.dispatch_date ? order.dispatch_date.slice(0, 10) : '',
      notes: order.notes || '',
      order_type: order.order_type || 'local_he',
    });
    setEditingOrder(true);
  };

  const saveOrderEdits = async () => {
    await api.put(`/orders/${id}`, editFields);
    setEditingOrder(false);
    load();
  };

  const handleResubmit = async () => {
    if (!window.confirm('Resubmit this order for approval?')) return;
    setResubmitting(true);
    try {
      if (editingOrder) await saveOrderEdits();
      await api.put(`/orders/${id}/resubmit`);
      load();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to resubmit');
    }
    setResubmitting(false);
  };

  const isImage = (name) => /\.(jpg|jpeg|png|gif|webp)$/i.test(name);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* ── Header ── */}
      <div className="flex items-center gap-4 mb-6">
        <button onClick={() => navigate('/orders')} className="btn-ghost btn-sm">
          <ArrowLeft size={16} /> Back
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900">{order.order_code}</h1>
            <StatusBadge status={order.status} />
          </div>
          <p className="text-gray-500 text-sm mt-0.5">
            Created by {order.created_by_name} · {fmtDate(order.order_date)}
          </p>
        </div>
        <div className="flex gap-2">
          {user.role === 'owner' && (
            <Link to={`/order-timeline/${order.id}`} className="btn-secondary btn-sm flex items-center gap-1">
              <ClipboardList size={15} /> Timeline
            </Link>
          )}
          {user.role === 'owner' && !restrictedRole && (
            <button className="btn-danger btn-sm" onClick={handleDeleteOrder} title="Delete this order">
              <Trash2 size={15} /> Delete Order
            </button>
          )}
          {canResubmit && (
            <button className="btn-primary" onClick={handleResubmit} disabled={resubmitting}>
              <Send size={15} /> {resubmitting ? 'Resubmitting...' : 'Resubmit for Approval'}
            </button>
          )}
          {canApprove && !restrictedRole && (
            <>
              <button className="btn-danger btn-sm" onClick={() => setShowRejectModal(true)}>
                <XCircle size={15} /> Reject
              </button>
              <button className="btn-primary" onClick={() => setShowApproveModal(true)}>
                <CheckCircle size={15} /> Approve Order
              </button>
            </>
          )}
        </div>
      </div>

      {/* Customer Query Alert Banner */}
      {isRejected && (
        <div className="mb-5 bg-red-50 border border-red-200 rounded-xl px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <XCircle size={20} className="text-red-500 flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-red-800">Order Rejected</p>
              {order.rejection_reason && (
                <p className="text-sm text-red-600 mt-0.5">{order.rejection_reason}</p>
              )}
              {canResubmit && (
                <p className="text-xs text-red-500 mt-1">Edit the order details or items below, then resubmit for approval.</p>
              )}
            </div>
          </div>
          {canResubmit && (
            <button className="btn-primary btn-sm flex-shrink-0" onClick={handleResubmit} disabled={resubmitting}>
              <Send size={14} /> {resubmitting ? 'Resubmitting...' : 'Resubmit'}
            </button>
          )}
        </div>
      )}

      {['customer_query', 'product_return'].includes(order.status) && (
        <div className="mb-5 bg-amber-50 border border-amber-200 rounded-xl px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-amber-600 text-lg">❓</span>
            <div>
              <p className="text-sm font-semibold text-amber-800">
                {order.status === 'customer_query' ? 'Active Customer Query' : 'Product Return In Progress'}
              </p>
              <p className="text-xs text-amber-600">This order has an active customer query that needs attention</p>
            </div>
          </div>
          <a href={`/customer-queries?order_id=${order.id}`}
            className="btn-sm bg-amber-200 text-amber-900 hover:bg-amber-300 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors">
            View Queries
          </a>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ═══════════════ LEFT COLUMN ═══════════════ */}
        <div className="lg:col-span-2 space-y-5">

          {/* ── Order Info ── */}
          <div className="card p-5">
            <h2 className="section-title mb-4">Order Details</h2>
            <dl className="grid grid-cols-2 gap-4">
              <div>
                <dt className="text-xs text-gray-500 uppercase tracking-wide">Customer Code</dt>
                <dd className="text-sm font-semibold mt-1">{order.customer_code}</dd>
              </div>
              {order.customer_name && (
                <div>
                  <dt className="text-xs text-gray-500 uppercase tracking-wide">Customer Name</dt>
                  <dd className="text-sm font-semibold mt-1">{order.customer_name}</dd>
                </div>
              )}
              <div>
                <dt className="text-xs text-gray-500 uppercase tracking-wide">Order Date</dt>
                <dd className="text-sm mt-1">{fmtDate(order.order_date)}</dd>
              </div>
              {order.dispatch_date && (
                <div>
                  <dt className="text-xs text-gray-500 uppercase tracking-wide">Dispatch Date</dt>
                  <dd className="text-sm mt-1 font-semibold text-brand-700">{fmtDate(order.dispatch_date)}</dd>
                </div>
              )}
              <div>
                <dt className="text-xs text-gray-500 uppercase tracking-wide">Status</dt>
                <dd className="mt-1"><StatusBadge status={order.status} /></dd>
              </div>
              {order.approved_by_name && (
                <div>
                  <dt className="text-xs text-gray-500 uppercase tracking-wide">Approved By</dt>
                  <dd className="text-sm mt-1">{order.approved_by_name} · {fmtDate(order.approved_at)}</dd>
                </div>
              )}
              {order.rejection_reason && (
                <div className="col-span-2">
                  <dt className="text-xs text-gray-500 uppercase tracking-wide">Rejection Reason</dt>
                  <dd className="text-sm mt-1 text-red-600 bg-red-50 px-3 py-2 rounded-lg">{order.rejection_reason}</dd>
                </div>
              )}
              {order.notes && !editingOrder && (
                <div className="col-span-2">
                  <dt className="text-xs text-gray-500 uppercase tracking-wide">Notes</dt>
                  <dd className="text-sm mt-1 text-gray-600">{order.notes}</dd>
                </div>
              )}
            </dl>

            {/* Editable fields when rejected */}
            {canResubmit && !editingOrder && (
              <div className="mt-4 pt-4 border-t border-red-100">
                <button className="btn-secondary btn-sm" onClick={startEditOrder}>
                  <Edit2 size={14} /> Edit Order Details
                </button>
              </div>
            )}
            {editingOrder && (
              <div className="mt-4 pt-4 border-t border-gray-200 space-y-3">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="label">Dispatch Date</label>
                    <input type="date" className="input" value={editFields.dispatch_date || ''}
                      onChange={e => setEditFields(p => ({ ...p, dispatch_date: e.target.value }))} />
                  </div>
                  <div>
                    <label className="label">Order Type</label>
                    <select className="input" value={editFields.order_type || 'local_he'}
                      onChange={e => setEditFields(p => ({ ...p, order_type: e.target.value }))}>
                      <option value="local_he">Local HE</option>
                      <option value="export_he">Export HE</option>
                      <option value="inventory_order">Inventory Order (IO)</option>
                      <option value="io_export_he">IO Export HE</option>
                      <option value="io_local_he">IO Local HE</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="label">Notes</label>
                  <textarea className="input" rows={2} value={editFields.notes || ''}
                    onChange={e => setEditFields(p => ({ ...p, notes: e.target.value }))} />
                </div>
                <div className="flex gap-2">
                  <button className="btn-primary btn-sm" onClick={saveOrderEdits}>Save Changes</button>
                  <button className="btn-ghost btn-sm" onClick={() => setEditingOrder(false)}>Cancel</button>
                </div>
              </div>
            )}
          </div>

          {/* ── Items ── */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="section-title">
                <Package size={18} className="text-blue-500" />
                Items
                {order.items?.length > 0 && (
                  <span className="ml-1 text-sm font-normal text-gray-400">({order.items.length})</span>
                )}
              </h2>
              {canManageItems && (
                <button className="btn-secondary btn-sm" onClick={() => { setEditingItem(null); setShowItemModal(true); }}>
                  <Plus size={14} /> Add Item
                </button>
              )}
            </div>

            {!order.items?.length ? (
              <p className="text-gray-400 text-sm">No items added yet.</p>
            ) : (
              <div className="divide-y divide-gray-100">
                {order.items.map((item, idx) => (
                  <div key={item.id} className="py-4 first:pt-0 last:pb-0">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        {/* Row 1: Number + Drawing + Qty */}
                        <div className="flex items-center gap-3 mb-2">
                          <span className="w-6 h-6 rounded-full bg-brand-100 text-brand-700 text-xs font-bold flex items-center justify-center flex-shrink-0">
                            {idx + 1}
                          </span>
                          <div className="flex flex-col min-w-0">
                            <span className="font-semibold text-gray-900 text-sm">{item.drawing_number}</span>
                            {item.drawing_number && (
                              <div className="flex gap-3 mt-0.5">
                                {[
                                  { lang: 'ગુ', text: transliterateGujarati(item.drawing_number) },
                                  { lang: 'हि', text: transliterateHindi(item.drawing_number) },
                                ].map(({ lang, text }) => (
                                  <span key={lang} className="flex items-center gap-1 text-xs text-gray-400">
                                    <span className="font-medium">{lang}:</span>
                                    <span className="font-mono">{text}</span>
                                    <button type="button" title="Copy"
                                      className="text-gray-300 hover:text-brand-500 transition-colors"
                                      onClick={() => navigator.clipboard.writeText(text)}>
                                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                                    </button>
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          <span className="ml-auto text-sm font-semibold text-gray-700 bg-gray-100 px-2 py-0.5 rounded-full flex-shrink-0">
                            Qty: {item.quantity}
                          </span>
                        </div>
                        {/* Row 2: Specs */}
                        <div className="ml-9 grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1">
                          <div className="text-xs">
                            <span className="text-gray-400">Tube: </span>
                            <span className="text-gray-700">{item.tube_material}
                              {item.tube_diameter && <span className="text-gray-400"> · {item.tube_diameter} mm</span>}
                            </span>
                          </div>
                          <div className="text-xs">
                            <span className="text-gray-400">Electrical: </span>
                            <span className="text-gray-700">{item.wattage} W / {item.voltage} V</span>
                          </div>
                          <div className="text-xs">
                            <span className="text-gray-400">Plating: </span>
                            <span className="text-gray-700">{item.plating_instructions}</span>
                          </div>
                          {item.remark && (
                            <div className="text-xs col-span-2 md:col-span-3">
                              <span className="text-gray-400">Remark: </span>
                              <span className="text-gray-600">{item.remark}</span>
                            </div>
                          )}
                        </div>
                        {/* Reference images */}
                        {item.images?.length > 0 && (
                          <div className="ml-9 mt-2 flex flex-wrap gap-1.5">
                            {item.images.map(img => (
                              <div key={img.id} className="relative group">
                                <a href={`/uploads/item-images/${img.file_name}`} target="_blank" rel="noopener noreferrer">
                                  <img
                                    src={`/uploads/item-images/${img.file_name}`}
                                    alt={img.original_name}
                                    className="w-14 h-14 object-cover rounded-lg border border-gray-200 hover:border-brand-400 transition-colors"
                                    title={img.original_name}
                                  />
                                </a>
                                {canManageItems && (
                                  <button
                                    className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
                                    onClick={() => handleDeleteItemImage(item.id, img.id)}
                                    title="Delete image"
                                  >
                                    <X size={10} />
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {/* Inventory selected by design at drawing stage */}
                        <div className="ml-9 mt-2">
                          <div className="flex items-center gap-1.5 mb-1">
                            <Package size={11} className="text-gray-400" />
                            <span className="text-xs text-gray-400">Inventory</span>
                            {canEditInventory && (
                              <button className="text-xs text-brand-600 hover:underline ml-1"
                                onClick={() => setInvEditItem(item)}>
                                {item.inventory_items?.length ? 'Edit' : 'Add'}
                              </button>
                            )}
                          </div>
                          {item.inventory_items?.length > 0 ? (
                            <div className="flex flex-wrap gap-1.5">
                              {item.inventory_items.map(inv => (
                                <span key={inv.id} className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-700 rounded-full px-2 py-0.5">
                                  <span className="font-mono font-medium">{inv.item_code}</span>
                                  <span className="text-gray-400">× {inv.qty} {inv.unit}</span>
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-xs text-gray-400 italic">None selected yet — added with the drawing.</span>
                          )}
                        </div>
                      </div>
                      {canManageItems && (
                        <div className="flex gap-1 flex-shrink-0">
                          <button className="btn-ghost btn-sm p-1.5" title="Edit"
                            onClick={() => { setEditingItem(item); setShowItemModal(true); }}>
                            <Edit2 size={14} />
                          </button>
                          <button className="btn-ghost btn-sm p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50" title="Delete"
                            onClick={() => handleDeleteItem(item.id)}>
                            <Trash2 size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Reference Drawings (per item) ── */}
          <div className="card p-5">
            <div className="mb-4">
              <h2 className="section-title">
                <PenLine size={18} className="text-orange-500" />
                Reference Drawings
              </h2>
              <p className="text-xs text-gray-400 mt-0.5">
                One drawing per item · owner approves/rejects each individually · approved items can have job cards uploaded
              </p>
            </div>

            {/* Gate: drawings only relevant after order is approved */}
            {!orderApproved && (
              <div className="mb-4 text-sm rounded-xl px-4 py-3 bg-gray-50 border border-gray-200 text-gray-500">
                🔒 Order must be approved first. Once approved, the Design team will be required to upload reference drawings for each item.
              </div>
            )}
            {orderApproved && allItemsApproved && (
              <div className="mb-4 flex items-center gap-2 text-sm rounded-xl px-4 py-3 bg-green-50 border border-green-200 text-green-700">
                <CheckCircle size={15} /> All item drawings approved. Job cards can be created for all items.
              </div>
            )}
            {orderApproved && !hasDrawings && (
              <div className="mb-4 text-sm rounded-xl px-4 py-3 bg-amber-50 border border-amber-200 text-amber-700">
                {canUploadDrawing
                  ? '⚠️ Upload reference drawings for each item below. Owner must approve each before job cards can be created.'
                  : '⚠️ Waiting for Design team to upload reference drawings for each item.'}
              </div>
            )}

            {/* Per-item drawing rows */}
            <div className="space-y-3">
              {(order.items || []).map((item, idx) => {
                const itemDrawings = (order.order_drawings || []).filter(d => d.item_id === item.id);
                const hasItemDrawing = itemDrawings.length > 0;
                const itemStatus = itemDrawingStatus[item.id]; // 'approved'|'pending_review'|'rejected'|null
                const itemApproved = itemStatus === 'approved';
                const itemPending = itemStatus === 'pending_review';
                const itemRejected = itemStatus === 'rejected';

                const borderColor = itemApproved ? 'border-green-300 bg-green-50'
                  : itemPending  ? 'border-blue-200 bg-blue-50'
                  : itemRejected ? 'border-red-200 bg-red-50'
                  : 'border-gray-200 bg-gray-50';

                return (
                  <div key={item.id} className={`rounded-xl border ${borderColor}`}>
                    {/* Item header row */}
                    <div className="flex items-center justify-between px-4 py-2.5 gap-2">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full flex-shrink-0 ${
                          itemApproved ? 'bg-green-100 text-green-700'
                          : itemPending ? 'bg-blue-100 text-blue-700'
                          : itemRejected ? 'bg-red-100 text-red-700'
                          : 'bg-gray-200 text-gray-500'
                        }`}>Item {idx + 1}</span>
                        <div className="min-w-0">
                          <span className="text-sm font-semibold text-gray-800 font-mono">
                            {item.drawing_number || <span className="text-gray-400 font-sans font-normal italic">No drawing no.</span>}
                          </span>
                          {item.product_code && <span className="ml-2 text-xs text-gray-400">{item.product_code}</span>}
                          <div className="text-xs text-gray-400 mt-0.5">
                            {[item.tube_material, item.wattage ? `${item.wattage}W` : null, item.voltage ? `${item.voltage}V` : null].filter(Boolean).join(' · ')}
                            {' · '}{item.quantity} Nos
                          </div>
                        </div>
                      </div>
                      {/* Status badge + actions */}
                      <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
                        {itemApproved && <span className="text-xs text-green-700 font-semibold flex items-center gap-1"><CheckCircle size={12} /> Approved</span>}
                        {itemPending  && <span className="text-xs text-blue-700 font-semibold flex items-center gap-1"><Clock size={12} /> Awaiting Review</span>}
                        {itemRejected && <span className="text-xs text-red-700 font-semibold flex items-center gap-1"><AlertTriangle size={12} /> Rejected</span>}
                        {!hasItemDrawing && <span className="text-xs text-amber-600 font-medium">Missing</span>}
                        {/* Owner approve/reject per drawing */}
                        {user.role === 'owner' && itemPending && itemDrawings.length > 0 && itemDrawings.map(d => (
                          <div key={d.id} className="flex gap-1">
                            <button className="btn-danger btn-sm py-0.5 px-2 text-xs"
                              onClick={async () => {
                                const reason = window.prompt('Rejection reason:');
                                if (!reason?.trim()) return;
                                await api.put(`/orders/${id}/drawings/${d.id}/reject`, { reason });
                                load();
                              }}>
                              <XCircle size={11} /> Reject
                            </button>
                            <button className="btn-primary btn-sm py-0.5 px-2 text-xs"
                              onClick={async () => { await api.put(`/orders/${id}/drawings/${d.id}/approve`); load(); }}>
                              <CheckCircle size={11} /> Approve
                            </button>
                          </div>
                        ))}
                        {canUploadDrawing && (!itemApproved) && (
                          <button className="btn-secondary btn-sm py-1 px-2 text-xs"
                            onClick={() => { setDrawingUploadItemId(item.id); setDrawingUploadItem(item); setShowDrawingModal(true); }}>
                            <Upload size={11} /> Upload
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Rejection reason */}
                    {itemRejected && itemDrawings.some(d => d.rejection_reason) && (
                      <div className="px-4 pb-2 text-xs text-red-600">
                        Reason: {itemDrawings.find(d => d.rejection_reason)?.rejection_reason}
                        {canUploadDrawing && <span className="ml-2 text-red-400">— delete and re-upload a corrected drawing.</span>}
                      </div>
                    )}

                    {/* Uploaded drawings for this item */}
                    {itemDrawings.length > 0 && (
                      <div className={`border-t divide-y ${itemApproved ? 'border-green-200 divide-green-100' : itemRejected ? 'border-red-200 divide-red-100' : 'border-blue-200 divide-blue-100'}`}>
                        {itemDrawings.map(d => (
                          <div key={d.id} className="flex items-center gap-3 px-4 py-2">
                            {isImage(d.file_name)
                              ? <img src={`/uploads/order-drawings/${d.file_name}`} alt="" className="w-9 h-9 object-cover rounded-lg flex-shrink-0" />
                              : <div className="w-9 h-9 bg-red-50 rounded-lg flex items-center justify-center flex-shrink-0"><FileText size={16} className="text-red-400" /></div>
                            }
                            <div className="flex-1 min-w-0">
                              {d.file_name ? (
                                <a href={`/uploads/order-drawings/${d.file_name}`} target="_blank" rel="noopener noreferrer"
                                  className="text-xs font-medium text-brand-600 hover:underline block truncate">
                                  {d.original_name || d.file_name}
                                </a>
                              ) : (
                                <span className="text-xs font-medium text-gray-500 block truncate">No drawing file — inventory only</span>
                              )}
                              <div className="text-xs text-gray-400">{d.uploaded_by_name} · {fmtDate(d.created_at)}</div>
                            </div>
                            {canUploadDrawing && !itemApproved && (
                              <button className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded flex-shrink-0"
                                onClick={() => handleDeleteDrawing(d.id)} title="Delete drawing">
                                <Trash2 size={13} />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Job Cards ── (production orders only) */}
          {!isFG && <div className="card p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="section-title">Job Cards
                  {order.job_cards?.length > 0 && (
                    <span className="ml-1 text-sm font-normal text-gray-400">({order.job_cards.length})</span>
                  )}
                </h2>
                <p className="text-xs text-gray-400 mt-0.5">One job card per item — available once the item's drawing is approved</p>
              </div>
            </div>

            {/* Gate messages */}
            {order.status === 'pending_approval' && (
              <p className="text-gray-400 text-sm">Order must be approved first.</p>
            )}
            {order.status === 'rejected' && (
              <p className="text-gray-400 text-sm">Order was rejected.</p>
            )}

            {/* Per-item job card upload gates */}
            {canUploadJobCardBase && !['pending_approval','rejected'].includes(order.status) && (
              <div className="space-y-2 mb-3">
                {(order.items || []).map((item, idx) => {
                  // Use itemDrawingStatus map first; fall back to scanning order_drawings directly
                  const itemDrawings = (order.order_drawings || []).filter(d => d.item_id === item.id);
                  const drawingStatus = itemDrawingStatus[item.id]
                    ?? (itemDrawings.some(d => d.drawing_status === 'approved') ? 'approved'
                      : itemDrawings.some(d => d.drawing_status === 'pending_review') ? 'pending_review'
                      : itemDrawings.some(d => d.drawing_status === 'rejected') ? 'rejected'
                      : itemDrawings.length > 0 ? 'pending_review' : null);
                  const hasJC = (order.job_cards || []).some(jc =>
                    item.drawing_number && jc.drawing_no === item.drawing_number
                  );
                  const rowColor = hasJC
                    ? 'border-gray-200 bg-gray-50'
                    : drawingStatus === 'approved'
                    ? 'border-green-200 bg-green-50'
                    : drawingStatus === 'pending_review'
                    ? 'border-blue-200 bg-blue-50'
                    : drawingStatus === 'rejected'
                    ? 'border-red-200 bg-red-50'
                    : 'border-gray-200 bg-gray-50';
                  return (
                    <div key={item.id} className={`flex items-center justify-between px-3 py-2 rounded-lg border text-sm ${rowColor}`}>
                      <div>
                        <span className={`font-medium ${hasJC ? 'text-gray-500' : 'text-gray-800'}`}>{item.drawing_number || `Item ${idx + 1}`}</span>
                        {item.product_code && <span className="ml-2 text-xs text-gray-400">{item.product_code}</span>}
                      </div>
                      {hasJC ? (
                        <span className="text-xs text-gray-500 font-medium flex items-center gap-1">
                          <CheckCircle2 size={11} className="text-green-500" /> Job Card Uploaded
                        </span>
                      ) : drawingStatus === 'approved' || DRAWING_BYPASS_ORDERS.includes(order.order_code) ? (
                        <button className="btn-primary btn-sm py-1 px-2 text-xs"
                          onClick={() => { setShowJobCardModal(true); }}>
                          <Upload size={12} /> Upload Job Card
                        </button>
                      ) : drawingStatus === 'pending_review' ? (
                        <span className="text-xs text-blue-600 font-medium flex items-center gap-1">
                          <Clock size={11} /> Drawing awaiting approval
                        </span>
                      ) : drawingStatus === 'rejected' ? (
                        <span className="text-xs text-red-600 font-medium flex items-center gap-1">
                          <XCircle size={11} /> Drawing rejected — needs revision
                        </span>
                      ) : (
                        <span className="text-xs text-amber-600 font-medium flex items-center gap-1">
                          <AlertTriangle size={11} /> No drawing uploaded
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Job card list */}
            {hasDrawings && order.job_cards?.length === 0 && (
              <p className="text-gray-400 text-sm">No job cards uploaded yet.</p>
            )}
            {order.job_cards?.length > 0 && (
              <div className="space-y-2">
                {order.job_cards.map(jc => {
                  const isImg = /\.(jpg|jpeg|png|gif|webp)$/i.test(jc.file_name || '');
                  return (
                    <div key={jc.id} className="flex items-center gap-3 p-3 rounded-xl border bg-gray-50 border-gray-200">
                      <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
                        <FileText size={20} className="text-gray-400" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm text-gray-600">{jc.job_card_no}</span>
                          <StatusBadge status={jc.status} />
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          {jc.qty && `Qty: ${jc.qty} · `}Dispatch: {fmtDate(jc.dispatch_date)}
                        </div>
                        {jc.notes && <div className="text-xs text-gray-400 mt-0.5 italic">{jc.notes}</div>}
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <Link to={`/job-cards/${jc.id}`}
                          className="btn-secondary btn-sm py-1 px-2 text-xs flex items-center gap-1">
                          <ClipboardList size={12} /> Checklist
                        </Link>
                        {jc.file_name && (
                          <a href={`/uploads/job-cards/${jc.file_name}`} target="_blank" rel="noopener noreferrer"
                            className="btn-secondary btn-sm py-1 px-2 text-xs flex items-center gap-1">
                            <ExternalLink size={12} /> View
                          </a>
                        )}
                        {canUploadJobCardBase && (
                          <button className="btn-ghost btn-sm p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50"
                            onClick={() => handleDeleteJobCard(jc.id)} title="Delete">
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>}

          {/* ── Inventory Job Cards ── (Finished Goods orders only) */}
          {isFG && <div className="card p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="section-title">Inventory Job Cards
                  {order.job_cards?.length > 0 && (
                    <span className="ml-1 text-sm font-normal text-gray-400">({order.job_cards.length})</span>
                  )}
                </h2>
                <p className="text-xs text-gray-400 mt-0.5">One per item — material is drawn from the Finished Goods store, then runs the short 4-stage checklist before QC &amp; dispatch</p>
              </div>
            </div>

            {order.status === 'pending_approval' && (
              <p className="text-gray-400 text-sm">Order must be approved first.</p>
            )}
            {order.status === 'rejected' && (
              <p className="text-gray-400 text-sm">Order was rejected.</p>
            )}

            {canUploadJobCardBase && !['pending_approval','rejected'].includes(order.status) && (
              <div className="space-y-2 mb-3">
                {(order.items || []).map((item, idx) => {
                  const itemDrawings = (order.order_drawings || []).filter(d => d.item_id === item.id);
                  const drawingStatus = itemDrawingStatus[item.id]
                    ?? (itemDrawings.some(d => d.drawing_status === 'approved') ? 'approved'
                      : itemDrawings.length > 0 ? 'pending_review' : null);
                  const hasJC = (order.job_cards || []).some(jc => jc.order_item_id === item.id);
                  return (
                    <div key={item.id} className={`flex items-center justify-between px-3 py-2 rounded-lg border text-sm ${
                      hasJC ? 'border-gray-200 bg-gray-50' : drawingStatus === 'approved' ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-gray-50'
                    }`}>
                      <div>
                        <span className={`font-medium ${hasJC ? 'text-gray-500' : 'text-gray-800'}`}>{item.drawing_number || `Item ${idx + 1}`}</span>
                        <span className="ml-2 text-xs text-gray-400">Qty: {item.quantity}</span>
                      </div>
                      {hasJC ? (
                        <span className="text-xs text-gray-500 font-medium flex items-center gap-1">
                          <CheckCircle2 size={11} className="text-green-500" /> Job Card Created
                        </span>
                      ) : drawingStatus === 'approved' ? (
                        <button className="btn-primary btn-sm py-1 px-2 text-xs"
                          onClick={() => setFgJobCardItem(item)}>
                          <Plus size={12} /> Create Inventory Job Card
                        </button>
                      ) : (
                        <span className="text-xs text-blue-600 font-medium flex items-center gap-1">
                          <Clock size={11} /> Drawing awaiting approval
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {order.job_cards?.length > 0 && (
              <div className="space-y-2">
                {order.job_cards.map(jc => (
                  <div key={jc.id} className="flex items-center gap-3 p-3 rounded-xl border bg-gray-50 border-gray-200">
                    <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center flex-shrink-0">
                      <Package size={20} className="text-emerald-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-gray-600">{jc.job_card_no}</span>
                        <StatusBadge status={jc.status} />
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {jc.qty && `Qty: ${jc.qty} · `}Dispatch: {fmtDate(jc.dispatch_date)} · From Finished Goods stock
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <Link to={`/job-cards/${jc.id}`}
                        className="btn-secondary btn-sm py-1 px-2 text-xs flex items-center gap-1">
                        <ClipboardList size={12} /> Checklist
                      </Link>
                      {jc.file_name && (
                        <a href={`/uploads/job-cards/${jc.file_name}`} target="_blank" rel="noopener noreferrer"
                          className="btn-secondary btn-sm py-1 px-2 text-xs flex items-center gap-1">
                          <ExternalLink size={12} /> View
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>}

          {/* ── Quotations ── (hidden from design/qc/production) */}
          {!restrictedRole && <div className="card p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="section-title">Quotations</h2>
              {canUploadQuotation && (
                <button className="btn-secondary btn-sm" onClick={() => setShowQuotationModal(true)}>
                  <Upload size={14} /> Upload
                </button>
              )}
            </div>
            {!order.quotations?.length ? (
              <p className="text-gray-400 text-sm">No quotations uploaded.</p>
            ) : order.quotations.map(q => (
              <QuotationRow key={q.id} q={q} orderId={id} isOwner={user?.role === 'owner'} onSaved={load} />
            ))}
          </div>}
        </div>

        {/* ═══════════════ RIGHT SIDEBAR ═══════════════ */}
        <div className="card overflow-hidden h-fit sticky top-6">
          {/* Tab bar */}
          <div className="flex border-b border-gray-100">
            <button
              className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-1.5 transition-colors ${
                sidebarTab === 'chat'
                  ? 'text-brand-600 border-b-2 border-brand-500 bg-brand-50/40'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
              onClick={() => setSidebarTab('chat')}
            >
              <MessageSquare size={15} /> Chat
            </button>
            <button
              className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-1.5 transition-colors ${
                sidebarTab === 'timeline'
                  ? 'text-brand-600 border-b-2 border-brand-500 bg-brand-50/40'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
              onClick={() => setSidebarTab('timeline')}
            >
              <Clock size={15} /> Timeline
            </button>
          </div>

          {sidebarTab === 'chat'
            ? <ChatPanel orderId={id} currentUser={user} />
            : <TimelinePanel activity={order.activity} />
          }
        </div>
      </div>

      {/* ── Modals ── */}
      {showApproveModal && (
        <ConfirmModal
          title="Approve Order"
          message={`Approve order ${order.order_code}? Reference drawing is uploaded and ready. Job cards can be created after approval.`}
          confirmLabel="Approve"
          onClose={() => setShowApproveModal(false)}
          onConfirm={async () => { await api.put(`/orders/${id}/approve`); setShowApproveModal(false); load(); }}
        />
      )}
      {showRejectModal && (
        <RejectModal
          onClose={() => setShowRejectModal(false)}
          onConfirm={async (reason) => { await api.put(`/orders/${id}/reject`, { reason }); setShowRejectModal(false); load(); }}
        />
      )}
      {showQuotationModal && (
        <QuotationModal orderId={id}
          hasPriceRequest={order.has_price_request && !order.quotations?.length}
          onClose={() => setShowQuotationModal(false)}
          onSave={() => { setShowQuotationModal(false); load(); }}
        />
      )}
      {invEditItem && (
        <InventoryEditModal orderId={id}
          item={invEditItem}
          onClose={() => setInvEditItem(null)}
          onDone={() => { setInvEditItem(null); load(); }}
        />
      )}
      {showDrawingModal && (
        <DrawingUploadModal orderId={id}
          item={drawingUploadItem}
          fileOptional={isFG}
          onClose={() => { setShowDrawingModal(false); setDrawingUploadItemId(null); setDrawingUploadItem(null); }}
          onDone={() => { setShowDrawingModal(false); setDrawingUploadItemId(null); setDrawingUploadItem(null); load(); }}
        />
      )}
      {fgJobCardItem && (
        <FgJobCardModal
          order={order}
          item={fgJobCardItem}
          onClose={() => setFgJobCardItem(null)}
          onSaved={() => { setFgJobCardItem(null); load(); }}
        />
      )}
      {showJobCardModal && (
        <UploadJobCardModal orderId={id}
          orderCode={order.order_code}
          defaultDispatchDate={order.dispatch_date || ''}
          items={order.items || []}
          jobCards={order.job_cards || []}
          itemDrawingStatus={itemDrawingStatus}
          onClose={() => setShowJobCardModal(false)}
          onSave={() => { setShowJobCardModal(false); load(); }}
        />
      )}
      {showItemModal && (
        <ItemModal
          item={editingItem}
          orderId={id}
          customerId={order?.customer_id}
          onClose={() => { setShowItemModal(false); setEditingItem(null); }}
          onSave={() => { setShowItemModal(false); setEditingItem(null); load(); }}
        />
      )}
    </div>
  );
}

// ── Render message with highlighted @mentions ─────────────────────────────────
function MessageText({ text, isMe }) {
  const parts = text.split(/(@[\w][\w\s/]*[\w])/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('@') ? (
          <span
            key={i}
            className={`font-semibold rounded px-0.5 ${isMe ? 'bg-white/20 text-white' : 'bg-brand-100 text-brand-700'}`}
          >
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

// ── Quotation Row (editable notes for owner) ─────────────────────────────────
function QuotationRow({ q, orderId, isOwner, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState(q.notes || '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/orders/${orderId}/quotation/${q.id}`, { notes });
      setEditing(false);
      onSaved();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg mb-2">
      <FileText size={18} className={`flex-shrink-0 mt-0.5 ${q.file_name ? 'text-red-500' : 'text-purple-500'}`} />
      <div className="flex-1 min-w-0">
        {q.file_name ? (
          <a href={`/uploads/quotations/${q.file_name}`} target="_blank" rel="noopener noreferrer"
            className="text-sm font-medium text-brand-600 hover:underline truncate block">{q.file_name}</a>
        ) : (
          <span className="text-sm font-medium text-gray-800">Price Note</span>
        )}
        {editing ? (
          <div className="mt-1 flex gap-1.5">
            <textarea className="input text-sm flex-1" rows={2} value={notes}
              onChange={e => setNotes(e.target.value)} autoFocus />
            <div className="flex flex-col gap-1">
              <button className="btn-primary text-xs px-2 py-1" onClick={save} disabled={saving}>
                {saving ? '…' : 'Save'}
              </button>
              <button className="btn-secondary text-xs px-2 py-1" onClick={() => { setEditing(false); setNotes(q.notes || ''); }}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-1.5 mt-0.5">
            {q.notes ? (
              <div className="text-sm text-gray-700">{q.notes}</div>
            ) : (
              <div className="text-sm text-gray-400 italic">No notes</div>
            )}
            {isOwner && (
              <button onClick={() => setEditing(true)} className="text-gray-400 hover:text-brand-600 flex-shrink-0 mt-0.5" title="Edit note">
                <Edit2 size={12} />
              </button>
            )}
          </div>
        )}
        <div className="text-xs text-gray-400 mt-1">{q.uploaded_by_name} · {fmtDate(q.created_at)}</div>
      </div>
    </div>
  );
}

// ── Chat Panel ───────────────────────────────────────────────────────────────
function ChatPanel({ orderId, currentUser }) {
  const [messages, setMessages] = useState([]);
  const [newMsg, setNewMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState([]);
  const [mentionQuery, setMentionQuery] = useState(null);
  const [mentionPos, setMentionPos] = useState(0);
  const [mentionedIds, setMentionedIds] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  const loadMessages = async () => {
    const r = await api.get(`/orders/${orderId}/messages`);
    setMessages(r.data);
    setLoading(false);
  };

  useEffect(() => { loadMessages(); }, [orderId]);
  useEffect(() => {
    api.get('/auth/users').then(r => setUsers(r.data)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!loading) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Detect @mention as user types
  const handleChange = (e) => {
    const val = e.target.value;
    setNewMsg(val);
    const caret = e.target.selectionStart;
    const textToCaret = val.slice(0, caret);
    const atIdx = textToCaret.lastIndexOf('@');
    if (atIdx !== -1 && (atIdx === 0 || /\s/.test(textToCaret[atIdx - 1]))) {
      const query = textToCaret.slice(atIdx + 1).toLowerCase();
      const hasMatches = query.length === 0 || users.some(u =>
        u.name.toLowerCase().includes(query) || (u.role || '').toLowerCase().includes(query)
      );
      if (hasMatches) {
        setMentionQuery(query);
        setMentionPos(atIdx);
        return;
      }
    }
    setMentionQuery(null);
  };

  const filteredUsers = mentionQuery !== null
    ? users.filter(u =>
        u.name.toLowerCase().includes(mentionQuery) ||
        (u.role || '').toLowerCase().includes(mentionQuery)
      ).slice(0, 6)
    : [];

  const insertMention = (user) => {
    const before = newMsg.slice(0, mentionPos);
    const after = newMsg.slice(mentionPos + 1 + (mentionQuery?.length || 0));
    const inserted = `@${user.name} `;
    const next = before + inserted + after;
    setNewMsg(next);
    setMentionQuery(null);
    // Track this user's ID so server doesn't need to parse the name
    setMentionedIds(prev => prev.includes(user.id) ? prev : [...prev, user.id]);
    setTimeout(() => {
      textareaRef.current?.focus();
      const pos = before.length + inserted.length;
      textareaRef.current?.setSelectionRange(pos, pos);
    }, 0);
  };

  const sendMessage = async () => {
    if ((!newMsg.trim() && !attachments.length) || sending) return;
    setSending(true);
    try {
      const fd = new FormData();
      fd.append('message', newMsg);
      fd.append('mentionIds', JSON.stringify(mentionedIds));
      attachments.forEach(f => fd.append('attachments', f));
      const client = attachments.length > 0 ? uploadApi : api;
      await client.post(`/orders/${orderId}/messages`, fd);
      setNewMsg('');
      setMentionQuery(null);
      setMentionedIds([]);
      setAttachments([]);
      await loadMessages();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const handleKey = (e) => {
    if (mentionQuery !== null && filteredUsers.length > 0 && e.key === 'Escape') {
      setMentionQuery(null);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && mentionQuery === null) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="flex flex-col" style={{ height: '480px' }}>
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-gray-50 flex items-center justify-between">
        <span className="text-xs text-gray-400 font-medium uppercase tracking-wide">
          {messages.length} message{messages.length !== 1 ? 's' : ''}
        </span>
        <button onClick={loadMessages} className="text-gray-400 hover:text-gray-600 transition-colors" title="Refresh">
          <RefreshCw size={13} />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {loading ? (
          <p className="text-center text-gray-300 text-sm mt-8">Loading...</p>
        ) : messages.length === 0 ? (
          <div className="text-center mt-8">
            <MessageSquare size={28} className="mx-auto mb-2 text-gray-200" />
            <p className="text-gray-400 text-sm">No messages yet.</p>
            <p className="text-gray-300 text-xs mt-1">Start the conversation!</p>
          </div>
        ) : (
          messages.map(msg => {
            const isMe = msg.user_id === currentUser.id;
            return (
              <div key={msg.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[88%] flex flex-col gap-1 ${isMe ? 'items-end' : 'items-start'}`}>
                  {!isMe && (
                    <div className="flex items-center gap-1.5">
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${ROLE_COLORS[msg.user_role] || 'bg-gray-100 text-gray-600'}`}>
                        {ROLE_LABELS[msg.user_role] || msg.user_role}
                      </span>
                      <span className="text-xs text-gray-500 font-medium">{msg.user_name}</span>
                    </div>
                  )}
                  <div className={`rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                    isMe
                      ? 'bg-brand-600 text-white rounded-tr-sm'
                      : 'bg-gray-100 text-gray-800 rounded-tl-sm'
                  }`}>
                    {msg.message && <MessageText text={msg.message} isMe={isMe} />}
                    {msg.attachments?.length > 0 && (
                      <div className={`flex flex-wrap gap-2 ${msg.message ? 'mt-2' : ''}`}>
                        {msg.attachments.map(att => {
                          const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(att.file_name);
                          return isImage ? (
                            <a key={att.id} href={`/uploads/${att.file_path}`} target="_blank" rel="noreferrer" className="block">
                              <img src={`/uploads/${att.file_path}`} alt={att.file_name} className="max-w-[200px] max-h-[150px] rounded-lg border border-white/20 object-cover" />
                            </a>
                          ) : (
                            <a key={att.id} href={`/uploads/${att.file_path}`} target="_blank" rel="noreferrer"
                              className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs ${isMe ? 'bg-white/15 text-white hover:bg-white/25' : 'bg-white border border-gray-200 text-gray-700 hover:bg-gray-50'}`}>
                              <File size={12} />
                              <span className="truncate max-w-[120px]">{att.file_name}</span>
                              <Download size={10} />
                            </a>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <span className="text-xs text-gray-300">{fmtDateTime(msg.created_at)}</span>
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-100 p-3 relative">
        {/* @mention dropdown */}
        {mentionQuery !== null && filteredUsers.length > 0 && (
          <div className="absolute bottom-full left-3 mb-1 w-56 bg-white border border-gray-200 rounded-xl shadow-lg z-50 overflow-hidden">
            <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-100">
              <span className="text-xs text-gray-400 font-medium">Mention someone</span>
            </div>
            {filteredUsers.map(u => (
              <button
                key={u.id}
                type="button"
                className="w-full text-left px-3 py-2 hover:bg-brand-50 flex items-center gap-2 transition-colors"
                onMouseDown={e => { e.preventDefault(); insertMention(u); }}
              >
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${ROLE_COLORS[u.role] || 'bg-gray-100 text-gray-600'}`}>
                  {ROLE_LABELS[u.role] || u.role}
                </span>
                <span className="text-sm text-gray-800 font-medium">{u.name}</span>
              </button>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {attachments.map((f, i) => (
              <div key={i} className="flex items-center gap-1.5 bg-gray-100 rounded-lg px-2 py-1 text-xs text-gray-600">
                <Paperclip size={10} />
                <span className="truncate max-w-[120px]">{f.name}</span>
                <button type="button" onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-500">
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <input type="file" ref={fileInputRef} className="hidden" multiple
            accept=".jpg,.jpeg,.png,.gif,.webp,.heic,.heif,.pdf,.doc,.docx,.xls,.xlsx"
            onChange={e => { if (e.target.files?.length) setAttachments(prev => [...prev, ...Array.from(e.target.files)]); e.target.value = ''; }}
          />
          <button type="button" onClick={() => fileInputRef.current?.click()}
            className="p-2 text-gray-400 hover:text-brand-600 transition-colors flex-shrink-0" title="Attach files">
            <Paperclip size={16} />
          </button>
          <textarea
            ref={textareaRef}
            className="input flex-1 resize-none text-sm py-2 leading-snug"
            placeholder="Type a message… use @ to mention someone"
            value={newMsg}
            onChange={handleChange}
            onKeyDown={handleKey}
            rows={2}
            style={{ minHeight: '40px', maxHeight: '80px' }}
          />
          <button
            className="btn-primary px-3 py-2 flex-shrink-0"
            disabled={sending || (!newMsg.trim() && !attachments.length)}
            onClick={sendMessage}
            title="Send"
          >
            <Send size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Timeline Panel ───────────────────────────────────────────────────────────
function TimelinePanel({ activity }) {
  return (
    <div className="divide-y divide-gray-50 overflow-y-auto" style={{ maxHeight: '480px' }}>
      {!activity?.length ? (
        <div className="px-5 py-6 text-center text-gray-400 text-sm">No activity yet</div>
      ) : activity.map(log => (
        <div key={log.id} className="px-5 py-3.5">
          <div className="flex items-start gap-2.5">
            <span className="text-lg leading-none mt-0.5">{ACTIVITY_ICONS[log.activity_type] || '📌'}</span>
            <div>
              <p className="text-sm text-gray-800">{log.description}</p>
              <p className="text-xs text-gray-400 mt-0.5">
                <span className="font-medium text-gray-500">{log.user_name}</span>
                {' · '}{fmtDateTime(log.created_at)}
              </p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Item modal (add / edit on existing order) ────────────────────────────────
function ItemModal({ item, orderId, customerId, onClose, onSave }) {
  const blank = {
    product_code: '', drawing_number: '', tube_material: '', tube_diameter: '',
    wattage: '', voltage: '', plating_instructions: '', quantity: '', remark: ''
  };
  const [f, setF] = useState(item ? { ...item } : blank);
  const [existingImages, setExistingImages] = useState(item?.images || []);
  const [newFiles, setNewFiles] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const imgRef = useRef();
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));

  // Product code searchable dropdown
  const [products, setProducts] = useState([]);
  const [productSearch, setProductSearch] = useState(item?.product_code || '');
  const [showProductDropdown, setShowProductDropdown] = useState(false);

  // Inventory selection
  const [inventoryItems, setInventoryItems] = useState([]);
  const [selectedInventory, setSelectedInventory] = useState(
    Object.fromEntries((item?.inventory_items || []).map(i => [i.id, i.qty || '']))
  );
  const [invSearch, setInvSearch] = useState('');
  const [showInvDropdown, setShowInvDropdown] = useState(false);

  // "Reuse a previous item" picker (only when adding a new item)
  const [prevItems, setPrevItems] = useState([]);
  const [copyFromItemId, setCopyFromItemId] = useState(null);

  useEffect(() => {
    api.get('/products').then(r => setProducts(r.data)).catch(() => {});
    api.get('/inventory').then(r => setInventoryItems(r.data)).catch(() => {});
  }, []);

  // Load the customer's previous items (excluding this order) to reuse
  useEffect(() => {
    if (item?.id || !customerId) { setPrevItems([]); return; }
    api.get(`/orders/customer/${customerId}/previous-items`)
      .then(r => setPrevItems((r.data || []).filter(p => String(p.order_id) !== String(orderId))))
      .catch(() => setPrevItems([]));
  }, [customerId, item, orderId]);

  const selectPrevItem = (e) => {
    const pid = e.target.value;
    if (!pid) { setCopyFromItemId(null); return; }
    const p = prevItems.find(x => String(x.id) === String(pid));
    if (!p) return;
    setF({
      product_code: p.product_code || '', drawing_number: p.drawing_number || '',
      tube_material: '', // not carried forward — must be re-selected from the Tube list
      tube_diameter: p.tube_diameter || '',
      wattage: p.wattage || '', voltage: p.voltage || '',
      plating_instructions: p.plating_instructions || '',
      quantity: '', // left blank on purpose — quantity varies per order
      remark: p.remark || '',
    });
    setProductSearch(p.product_code || '');
    setCopyFromItemId(p.id); // inventory is copied server-side from the source item
  };

  const filteredProducts = products.filter(p =>
    (p.product_code || '').toLowerCase().includes(productSearch.toLowerCase()) ||
    (p.name || '').toLowerCase().includes(productSearch.toLowerCase())
  ).slice(0, 8);
  const selectProduct = (p) => {
    setF(prev => ({ ...prev, product_code: p.product_code }));
    setProductSearch(p.product_code);
    setShowProductDropdown(false);
  };

  const filteredInventory = inventoryItems.filter(i =>
    (i.item_code || '').toLowerCase().includes(invSearch.toLowerCase()) ||
    (i.name || '').toLowerCase().includes(invSearch.toLowerCase()) ||
    (i.category || '').toLowerCase().includes(invSearch.toLowerCase())
  ).slice(0, 10);
  const toggleInventory = (id) => setSelectedInventory(prev => {
    if (id in prev) { const n = { ...prev }; delete n[id]; return n; }
    return { ...prev, [id]: '' };
  });
  const setInvQty = (id, qty) => setSelectedInventory(prev => ({ ...prev, [id]: qty }));
  const selectedInventoryItems = inventoryItems.filter(i => i.id in selectedInventory);

  // Tube Material options come from the "Tube" inventory category (stores the item code).
  const tubeItems = inventoryItems.filter(i => (i.category || '').toLowerCase().trim() === 'tube');

  const addFiles = (e) => {
    const files = Array.from(e.target.files);
    setNewFiles(prev => [...prev, ...files]);
    e.target.value = '';
  };

  const handleSave = async () => {
    const missing = validateItem(f);
    if (missing.length) { setError(`Required fields missing: ${missing.join(', ')}`); return; }
    // Inventory is chosen by design at the drawing stage, not here.
    const payload = { ...f };
    if (!item?.id && copyFromItemId) payload.copy_from_item_id = copyFromItemId;
    setSaving(true);
    // Upload in batches — the server accepts up to 40 images per request
    const uploadImages = async (itemId) => {
      for (let i = 0; i < newFiles.length; i += 25) {
        const fd = new FormData();
        newFiles.slice(i, i + 25).forEach(file => fd.append('images', file));
        await api.post(`/orders/${orderId}/items/${itemId}/images`, fd);
      }
    };
    try {
      if (item?.id) {
        await api.put(`/orders/${orderId}/items/${item.id}`, payload);
        if (newFiles.length) await uploadImages(item.id);
      } else {
        const res = await api.post(`/orders/${orderId}/items`, payload);
        if (newFiles.length) await uploadImages(res.data.id);
      }
      onSave();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save');
      setSaving(false);
    }
  };

  const handleDeleteExistingImage = async (imageId) => {
    if (!window.confirm('Delete this image?')) return;
    await api.delete(`/orders/${orderId}/items/${item.id}/images/${imageId}`);
    setExistingImages(prev => prev.filter(i => i.id !== imageId));
  };

  return (
    <Modal open title={item?.id ? 'Edit Item' : 'Add Item'} onClose={onClose} size="lg">
      <div className="grid grid-cols-2 gap-4">

        {/* Reuse a previous item (only when adding a new item) */}
        {!item?.id && (
          <div className="col-span-2 bg-brand-50 border border-brand-100 rounded-lg p-3">
            <label className="label flex items-center gap-1.5 mb-0">
              <RotateCcw size={13} /> Reuse a previous item for this customer
              <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            {!customerId ? (
              <p className="text-xs text-gray-400 mt-1">No customer on this order.</p>
            ) : prevItems.length === 0 ? (
              <p className="text-xs text-gray-400 mt-1">No previous items found for this customer.</p>
            ) : (
              <>
                <select className="input mt-1" value={copyFromItemId || ''} onChange={selectPrevItem}>
                  <option value="">Start fresh — enter new item details</option>
                  {prevItems.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.order_code} · {p.drawing_number || p.product_code || 'item'}
                      {p.has_drawing ? ' · has drawing' : ''} · qty {p.quantity}
                    </option>
                  ))}
                </select>
                {copyFromItemId && (
                  <p className="text-xs text-brand-600 mt-1.5">
                    {prevItems.find(p => String(p.id) === String(copyFromItemId))?.has_drawing
                      ? 'Details pre-filled. Its reference drawing will be copied in for re-approval.'
                      : 'Details pre-filled. This item had no drawing on file.'}
                    {' '}Enter this order's quantity (left blank since it varies).
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {/* Product Code — searchable dropdown */}
        <div className="col-span-2 relative">
          <label className="label">Product Code <span className="text-red-500">*</span></label>
          <input
            className="input"
            placeholder="Search by product code or name..."
            value={productSearch}
            onChange={e => { setProductSearch(e.target.value); setShowProductDropdown(true); setF(p => ({ ...p, product_code: e.target.value })); }}
            onFocus={() => setShowProductDropdown(true)}
            onBlur={() => setTimeout(() => setShowProductDropdown(false), 150)}
            autoComplete="off"
          />
          {showProductDropdown && filteredProducts.length > 0 && (
            <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-52 overflow-y-auto">
              {filteredProducts.map(p => (
                <button key={p.id} type="button"
                  className="w-full text-left px-4 py-2.5 hover:bg-brand-50 flex items-center gap-3 border-b border-gray-50 last:border-0"
                  onMouseDown={() => selectProduct(p)}>
                  {p.photo_file
                    ? <img src={`/uploads/${p.photo_file}`} alt={p.name} className="w-8 h-8 object-cover rounded-md border border-gray-200 flex-shrink-0" />
                    : <div className="w-8 h-8 rounded-md bg-gray-100 flex-shrink-0" />}
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
          <input className="input" placeholder="e.g. PT-FlangeHe-QU-2Kw-Cop" value={f.drawing_number} onChange={set('drawing_number')} />
        </div>

        {/* Tube */}
        <div>
          <label className="label">Tube Material <span className="text-red-500">*</span></label>
          <select className="input" value={f.tube_material} onChange={set('tube_material')}>
            <option value="">— Select tube —</option>
            {f.tube_material && !tubeItems.some(i => i.item_code === f.tube_material) && (
              <option value={f.tube_material}>{f.tube_material} (existing)</option>
            )}
            {tubeItems.map(i => (
              <option key={i.id} value={i.item_code}>{i.item_code} — {i.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Tube Diameter (mm) <span className="text-red-500">*</span></label>
          <select className="input" value={f.tube_diameter ?? ''} onChange={set('tube_diameter')}>
            <option value="">— Select diameter —</option>
            <option value="8">8mm</option>
            <option value="11">11mm</option>
          </select>
        </div>

        {/* Electrical */}
        <div>
          <label className="label">Wattage (W) <span className="text-red-500">*</span></label>
          <input className="input" type="number" step="any" placeholder="e.g. 2000" value={f.wattage ?? ''} onChange={set('wattage')} />
        </div>
        <div>
          <label className="label">Voltage (V) <span className="text-red-500">*</span></label>
          <input className="input" type="number" step="any" placeholder="e.g. 230" value={f.voltage ?? ''} onChange={set('voltage')} />
        </div>
        <div className="col-span-2">
          <label className="label">Plating Instructions <span className="text-red-500">*</span></label>
          <input className="input" placeholder="e.g. Nickel Plating / None" value={f.plating_instructions ?? ''} onChange={set('plating_instructions')} />
        </div>
        <div>
          <label className="label">Quantity <span className="text-red-500">*</span></label>
          <input className="input" type="number" min="1" placeholder="e.g. 20" value={f.quantity ?? ''} onChange={set('quantity')} />
        </div>
        <div>
          <label className="label">Remark <span className="text-gray-400 font-normal">(optional)</span></label>
          <input className="input" placeholder="Any remarks..." value={f.remark ?? ''} onChange={set('remark')} />
        </div>

        {/* Inventory is now selected by design at the drawing-upload stage */}
        <div className="col-span-2 text-xs text-gray-500 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2 flex items-center gap-1.5">
          <Package size={13} className="text-gray-400" />
          Inventory for this item is chosen by the design team when they upload its drawing.
        </div>

        {/* Reference Images */}
        <div className="col-span-2">
          <label className="label">
            <ImageIcon size={13} className="inline mr-1 text-blue-500" />
            Reference Images <span className="text-gray-400 font-normal">(from client — optional)</span>
          </label>
          <div className="border-2 border-dashed border-gray-200 rounded-xl p-4 bg-gray-50">
            <input ref={imgRef} type="file" multiple accept=".jpg,.jpeg,.png,.gif,.webp"
              className="hidden" onChange={addFiles} />
            {/* Existing images */}
            {existingImages.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {existingImages.map(img => (
                  <div key={img.id} className="relative group">
                    <a href={`/uploads/item-images/${img.file_name}`} target="_blank" rel="noopener noreferrer">
                      <img src={`/uploads/item-images/${img.file_name}`} alt={img.original_name}
                        className="w-14 h-14 object-cover rounded-lg border border-gray-200" />
                    </a>
                    <button
                      type="button"
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => handleDeleteExistingImage(img.id)}
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {/* New files staged */}
            {newFiles.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {newFiles.map((file, i) => (
                  <div key={i} className="relative group">
                    <img src={URL.createObjectURL(file)} alt={file.name}
                      className="w-14 h-14 object-cover rounded-lg border-2 border-dashed border-brand-300" />
                    <button
                      type="button"
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => setNewFiles(prev => prev.filter((_, j) => j !== i))}
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button type="button" className="btn-secondary btn-sm w-full" onClick={() => imgRef.current.click()}>
              <ImageIcon size={14} />
              {existingImages.length + newFiles.length > 0 ? 'Add More Images' : 'Add Reference Images'}
            </button>
          </div>
        </div>
      </div>

      {error && <p className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-3">{error}</p>}
      <div className="flex gap-3 mt-5">
        <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
        <button className="btn-primary flex-1" disabled={saving} onClick={handleSave}>
          {saving ? 'Saving...' : item?.id ? 'Update Item' : 'Add Item'}
        </button>
      </div>
    </Modal>
  );
}

// ── Drawing Upload Modal ──────────────────────────────────────────────────────
function DrawingRejectModal({ onClose, onConfirm }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal open title="Reject Reference Drawings" onClose={onClose} size="sm">
      <div className="space-y-4">
        <div className="bg-red-50 border border-red-100 text-red-700 text-sm rounded-lg px-3 py-2">
          The design team will be asked to upload corrected drawings.
        </div>
        <div>
          <label className="label">Rejection Reason <span className="text-red-500">*</span></label>
          <textarea className="input h-24 resize-none" value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Describe what needs to be changed or corrected..." />
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <div className="flex gap-3">
          <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-danger flex-1" disabled={saving || !reason.trim()}
            onClick={async () => {
              if (!reason.trim()) return setError('Reason is required');
              setSaving(true);
              try { await onConfirm(reason); }
              catch (e) { setError(e.response?.data?.error || 'Failed'); setSaving(false); }
            }}>
            {saving ? 'Rejecting...' : 'Reject Drawings'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Supporting modals ─────────────────────────────────────────────────────────
function ConfirmModal({ title, message, confirmLabel, onClose, onConfirm }) {
  const [loading, setLoading] = useState(false);
  return (
    <Modal open title={title} onClose={onClose} size="sm">
      <p className="text-gray-600 mb-6">{message}</p>
      <div className="flex gap-3">
        <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
        <button className="btn-primary flex-1" disabled={loading}
          onClick={async () => { setLoading(true); await onConfirm(); }}>
          {loading ? 'Processing...' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

function RejectModal({ onClose, onConfirm }) {
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  return (
    <Modal open title="Reject Order" onClose={onClose} size="sm">
      <div className="mb-4">
        <label className="label">Reason for rejection</label>
        <textarea className="input h-24 resize-none" value={reason}
          onChange={e => setReason(e.target.value)} placeholder="Enter reason..." />
      </div>
      <div className="flex gap-3">
        <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
        <button className="btn-danger flex-1" disabled={loading}
          onClick={async () => { setLoading(true); await onConfirm(reason); }}>
          {loading ? 'Rejecting...' : 'Reject Order'}
        </button>
      </div>
    </Modal>
  );
}

function QuotationModal({ orderId, hasPriceRequest, onClose, onSave }) {
  const [file, setFile] = useState(null);
  const [notes, setNotes] = useState('');
  const [sentDate, setSentDate] = useState(new Date().toISOString().split('T')[0]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (!file && !hasPriceRequest) return setError('Please select a file');
    if (!file && hasPriceRequest && !notes.trim()) return setError('Please enter the price in notes');
    setSaving(true);
    const fd = new FormData();
    if (file) fd.append('file', file);
    fd.append('notes', notes);
    fd.append('sent_date', sentDate);
    try {
      await api.post(`/orders/${orderId}/quotation`, fd);
      onSave();
    } catch (err) {
      setError(err.response?.data?.error || 'Upload failed');
      setSaving(false);
    }
  };

  return (
    <Modal open title={hasPriceRequest ? "Add Price / Quotation" : "Upload Quotation"} onClose={onClose} size="sm">
      <div className="space-y-4">
        {hasPriceRequest && (
          <div className="bg-purple-50 border border-purple-200 rounded-lg px-3 py-2 text-sm text-purple-800">
            Price was requested from dispatch. You can attach a quotation file or just enter the price below.
          </div>
        )}
        <FileUpload onFile={setFile} accept=".pdf" label={hasPriceRequest ? "Quotation PDF (optional)" : "Select Quotation PDF"} />
        <div>
          <label className="label">Date Sent</label>
          <input className="input" type="date" value={sentDate} onChange={e => setSentDate(e.target.value)} />
        </div>
        <div>
          <label className="label">{hasPriceRequest && !file ? 'Price / Notes *' : 'Notes'}</label>
          <textarea className="input h-20 resize-none" value={notes} onChange={e => setNotes(e.target.value)}
            placeholder={hasPriceRequest ? 'e.g. ₹12,500 per unit' : ''} />
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <div className="flex gap-3">
          <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={saving} onClick={handleSubmit}>
            {saving ? 'Saving...' : file ? 'Upload' : 'Save Price'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function UploadJobCardModal({ orderId, orderCode, defaultDispatchDate, items, jobCards, itemDrawingStatus = {}, onClose, onSave }) {
  const [selectedItemId, setSelectedItemId] = useState('');
  const [form, setForm] = useState({
    qty: '', dispatch_date: defaultDispatchDate || '',
    notes: '', punching: '',
  });
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const bypassDrawing = DRAWING_BYPASS_ORDERS.includes(orderCode);
  const takenDrawings = new Set(jobCards.map(jc => jc.drawing_no).filter(Boolean));
  const availableItems = items.filter(item =>
    (bypassDrawing || itemDrawingStatus[item.id] === 'approved') && !takenDrawings.has(item.drawing_number)
  );

  // The selected item object
  const selectedItem = items.find(i => String(i.id) === String(selectedItemId)) || null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!selectedItemId) return setError('Please select an item');
    if (!form.dispatch_date) return setError('Dispatch date is required');
    if (!form.punching.trim()) return setError('Punching value is required');
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('order_id', orderId);
      fd.append('order_item_id', selectedItemId);
      // Drawing number is the job card identity
      fd.append('job_card_no', selectedItem.drawing_number || selectedItem.product_code || `ITEM-${selectedItemId}`);
      fd.append('drawing_no', selectedItem.drawing_number || '');
      fd.append('product_name', selectedItem.product_code || '');
      fd.append('dispatch_date', form.dispatch_date);
      fd.append('punching', form.punching);
      if (form.qty) fd.append('qty', form.qty);
      if (form.notes) fd.append('notes', form.notes);
      if (file) fd.append('file', file);
      await api.post('/job-cards', fd);
      onSave();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to upload');
      setSaving(false);
    }
  };

  return (
    <Modal open title="Upload Job Card" onClose={onClose} size="md">
      <form onSubmit={handleSubmit} className="space-y-4">

        {/* Step 1 — Pick item */}
        <div>
          <label className="label">Select Item <span className="text-red-500">*</span></label>
          {availableItems.length === 0 ? (
            <div className="input bg-gray-50 text-gray-400 text-sm flex items-center">
              ✅ All approved items already have a job card uploaded
            </div>
          ) : (
            <select
              className="input"
              value={selectedItemId}
              onChange={e => setSelectedItemId(e.target.value)}
              required
            >
              <option value="">— Choose an order item —</option>
              {availableItems.map((item, idx) => {
                const originalIdx = items.indexOf(item);
                return (
                  <option key={item.id} value={item.id}>
                    Item {originalIdx + 1}{item.product_code ? ` · ${item.product_code}` : ''}{item.drawing_number ? ` · ${item.drawing_number}` : ''}
                  </option>
                );
              })}
            </select>
          )}
        </div>

        {/* Auto-filled read-only fields once item is selected */}
        {selectedItem && (
          <div className="grid grid-cols-2 gap-3 bg-gray-50 rounded-xl p-3 border border-gray-100">
            <div>
              <div className="text-xs text-gray-400 mb-0.5 uppercase tracking-wide">Product Code</div>
              <div className="text-sm font-semibold text-brand-700">{selectedItem.product_code || '—'}</div>
            </div>
            <div>
              <div className="text-xs text-gray-400 mb-0.5 uppercase tracking-wide">Drawing Number</div>
              <div className="text-sm font-semibold text-gray-800">{selectedItem.drawing_number || '—'}</div>
            </div>
            <div>
              <div className="text-xs text-gray-400 mb-0.5 uppercase tracking-wide">Tube Material</div>
              <div className="text-sm text-gray-600">{selectedItem.tube_material || '—'}</div>
            </div>
            <div>
              <div className="text-xs text-gray-400 mb-0.5 uppercase tracking-wide">Wattage / Voltage</div>
              <div className="text-sm text-gray-600">{selectedItem.wattage ? `${selectedItem.wattage}W / ${selectedItem.voltage}V` : '—'}</div>
            </div>
            <div>
              <div className="text-xs text-gray-400 mb-0.5 uppercase tracking-wide">Order Quantity</div>
              <div className="text-sm font-semibold text-gray-800">{selectedItem.quantity || '—'}</div>
            </div>
          </div>
        )}

        {/* Remaining fields */}
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="label">Punching <span className="text-red-500">*</span></label>
            <input className="input" placeholder="Enter punching value" value={form.punching} onChange={set('punching')} required />
          </div>
          <div>
            <label className="label">Quantity</label>
            <input className="input" type="number" placeholder="e.g. 50" value={form.qty} onChange={set('qty')} />
          </div>
          <div>
            <label className="label">Dispatch Date <span className="text-red-500">*</span></label>
            <input className="input" type="date" value={form.dispatch_date} onChange={set('dispatch_date')} required />
          </div>
          <div className="col-span-2">
            <label className="label">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
            <input className="input" placeholder="Any additional notes..." value={form.notes} onChange={set('notes')} />
          </div>
        </div>

        <div>
          <label className="label">Job Card File <span className="text-gray-400 font-normal">(PDF or image)</span></label>
          <FileUpload onFile={setFile} accept=".pdf,.jpg,.jpeg,.png" label="Upload job card document" />
        </div>

        {error && <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
        <div className="flex gap-3 pt-2">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving}>
            {saving ? 'Uploading...' : 'Upload Job Card'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── FG inventory job card creation ──────────────────────────────────────────
// Admin picks which Finished Goods stock the item's material comes from; the
// stock deducts immediately (blocked if short) and the card enters production
// with the short 4-stage checklist.
function FgJobCardModal({ order, item, onClose, onSaved }) {
  const [fgStock, setFgStock] = useState(null);
  const [sourceId, setSourceId] = useState('');
  const [qty, setQty] = useState(item.quantity || '');
  const [dispatchDate, setDispatchDate] = useState(order.dispatch_date ? order.dispatch_date.slice(0, 10) : '');
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const baseDrawing = (item.drawing_number || '').trim().replace(/-\d+$/, '').toUpperCase();

  useEffect(() => {
    api.get('/finished-goods').then(r => {
      const rows = (r.data || []).filter(f => Number(f.qty_available) > 0);
      setFgStock(rows);
      const match = rows.find(f => (f.base_drawing_no || '').toUpperCase() === baseDrawing);
      if (match) setSourceId(String(match.id));
    }).catch(() => setFgStock([]));
  }, []);

  const chosen = (fgStock || []).find(f => String(f.id) === String(sourceId));
  const short = chosen && parseInt(qty, 10) > Number(chosen.qty_available);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!sourceId) return setError('Select the Finished Goods stock to draw from.');
    if (!(parseInt(qty, 10) > 0)) return setError('Enter a valid quantity.');
    if (short) return setError(`Only ${chosen.qty_available} available in stock.`);
    if (!dispatchDate) return setError('Dispatch date is required.');
    if (!file) return setError('Upload the job card file.');
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('order_id', order.id);
      fd.append('order_item_id', item.id);
      fd.append('fg_source_id', parseInt(sourceId));
      fd.append('qty', parseInt(qty, 10));
      fd.append('dispatch_date', dispatchDate);
      if (notes) fd.append('notes', notes);
      await api.post('/job-cards/fg', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create inventory job card');
      setSaving(false);
    }
  };

  return (
    <Modal open title={`Inventory Job Card — ${item.drawing_number || 'Item'}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-gray-500">
          Select which Finished Goods stock this item's material comes from. The stock deducts immediately and the card runs the 4-stage checklist (Nut Washer → HV+Light+Ohms → Megger → Ready) before QC.
        </p>
        <div>
          <label className="label">Finished Goods stock <span className="text-red-500">*</span></label>
          {!fgStock ? (
            <p className="text-sm text-gray-400">Loading stock…</p>
          ) : fgStock.length === 0 ? (
            <p className="text-sm text-amber-600">No Finished Goods stock available.</p>
          ) : (
            <select className="input" value={sourceId} onChange={e => setSourceId(e.target.value)} required>
              <option value="">— select stock —</option>
              {fgStock.map(f => (
                <option key={f.id} value={f.id}>
                  {f.base_drawing_no || f.drawing_no} (avail: {f.qty_available}{f.location ? ` · ${f.location}` : ''})
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Qty <span className="text-red-500">*</span></label>
            <input className="input" type="number" min="1" value={qty} onChange={e => setQty(e.target.value)} required />
            {short && <p className="text-xs text-red-600 mt-1">Only {chosen.qty_available} available — cannot draw more.</p>}
          </div>
          <div>
            <label className="label">Dispatch Date <span className="text-red-500">*</span></label>
            <input className="input" type="date" value={dispatchDate} onChange={e => setDispatchDate(e.target.value)} required />
          </div>
        </div>
        <div>
          <label className="label">Job Card File <span className="text-red-500">*</span></label>
          <label className="flex items-center gap-2 cursor-pointer border border-gray-200 rounded-lg px-3 py-2 hover:border-brand-400 transition-colors bg-gray-50">
            <Upload size={15} className="text-gray-400 flex-shrink-0" />
            <span className="text-sm text-gray-600 flex-1 truncate">{file ? file.name : 'Click to attach the job card…'}</span>
            <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.xls,.xlsx" className="hidden"
              onChange={e => { setFile(e.target.files[0] || null); setError(''); }} />
          </label>
        </div>
        <div>
          <label className="label">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
          <input className="input" value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
        {error && <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
        <div className="flex gap-3 pt-1">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving || short || !file}>
            {saving ? 'Creating…' : 'Create & Deduct Stock'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
