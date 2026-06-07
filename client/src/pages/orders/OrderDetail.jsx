import { useEffect, useRef, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import StatusBadge from '../../components/ui/StatusBadge';
import Modal from '../../components/ui/Modal';
import FileUpload from '../../components/ui/FileUpload';
import { fmtDate, fmtDateTime, ACTIVITY_ICONS, ROLE_COLORS, ROLE_LABELS, transliterateHindi, transliterateGujarati } from '../../lib/utils';
import {
  ArrowLeft, CheckCircle, XCircle, FileText, Plus, Upload,
  ExternalLink, Trash2, Edit2, Package, PenLine, MessageSquare,
  Clock, AlertTriangle, Image as ImageIcon, Send, X, RefreshCw, ClipboardList
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
  const [showDrawingModal, setShowDrawingModal] = useState(false);
  const [drawingUploadItemId, setDrawingUploadItemId] = useState(null); // null = order-level upload
  const [drawingUploadItem, setDrawingUploadItem]     = useState(null); // full item object for modal title
  const [showDrawingRejectModal, setShowDrawingRejectModal] = useState(false);
  const [deletingJobCard, setDeletingJobCard] = useState(null);

  const load = () =>
    api.get(`/orders/${id}`).then(r => setOrder(r.data)).finally(() => setLoading(false));
  useEffect(() => { load(); }, [id]);

  if (loading) return <div className="p-8 text-center text-gray-400">Loading order...</div>;
  if (!order) return <div className="p-8 text-center text-red-500">Order not found</div>;

  const canApprove         = user.role === 'owner' && order.status === 'pending_approval';
  const hasDrawings        = order.order_drawings?.length > 0;
  const drawingStatus      = order.drawing_status; // null | 'pending_review' | 'approved' | 'rejected'
  const drawingsApproved   = drawingStatus === 'approved';
  const canApproveDrawing  = user.role === 'owner' && drawingStatus === 'pending_review';
  const canUploadJobCard   = ['admin', 'owner'].includes(user.role) &&
    !['pending_approval', 'rejected'].includes(order.status) && hasDrawings;
  const canManageItems     = ['admin', 'owner'].includes(user.role);
  const canUploadQuotation = ['admin', 'owner'].includes(user.role);
  const canUploadDrawing   = ['design', 'admin', 'owner'].includes(user.role);

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
            <button className="btn-danger btn-sm" onClick={handleDeleteOrder} title="Delete this order">
              <Trash2 size={15} /> Delete Order
            </button>
          )}
          {canApprove && (
            <>
              <button className="btn-danger btn-sm" onClick={() => setShowRejectModal(true)}>
                <XCircle size={15} /> Reject
              </button>
              <div className="relative group">
                <button
                  className={`btn-primary ${!drawingsApproved ? 'opacity-50 cursor-not-allowed' : ''}`}
                  onClick={() => drawingsApproved && setShowApproveModal(true)}
                  disabled={!drawingsApproved}
                >
                  <CheckCircle size={15} /> Approve Order
                </button>
                {!drawingsApproved && (
                  <div className="absolute right-0 top-full mt-1.5 w-72 bg-gray-900 text-white text-xs rounded-lg px-3 py-2 shadow-lg z-10 hidden group-hover:block">
                    {!hasDrawings
                      ? '⚠️ Drawings must be uploaded and approved before order can be approved.'
                      : drawingStatus === 'pending_review'
                        ? '⚠️ Approve the reference drawings first, then approve the order.'
                        : drawingStatus === 'rejected'
                          ? '⚠️ Drawings were rejected. Design must upload new drawings.'
                          : '⚠️ Reference drawings must be approved before this order can be approved.'}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

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
              {order.notes && (
                <div className="col-span-2">
                  <dt className="text-xs text-gray-500 uppercase tracking-wide">Notes</dt>
                  <dd className="text-sm mt-1 text-gray-600">{order.notes}</dd>
                </div>
              )}
            </dl>
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
                          <span className="font-semibold text-gray-900 text-sm">{item.drawing_number}</span>
                          <span className="ml-auto text-sm font-semibold text-gray-700 bg-gray-100 px-2 py-0.5 rounded-full">
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
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="section-title">
                  <PenLine size={18} className="text-orange-500" />
                  Reference Drawings
                </h2>
                <p className="text-xs text-gray-400 mt-0.5">
                  One drawing per item · <strong className="text-red-500">owner must approve drawings before order approval</strong>
                </p>
              </div>
              {/* Owner approve/reject drawing buttons */}
              {canApproveDrawing && (
                <div className="flex gap-2">
                  <button
                    className="btn-danger btn-sm"
                    onClick={() => setShowDrawingRejectModal(true)}
                  >
                    <XCircle size={13} /> Reject Drawings
                  </button>
                  <button
                    className="btn-primary btn-sm"
                    onClick={async () => {
                      await api.put(`/orders/${id}/drawings/approve`);
                      load();
                    }}
                  >
                    <CheckCircle size={13} /> Approve Drawings
                  </button>
                </div>
              )}
            </div>

            {/* Drawing status banner */}
            {drawingStatus === 'approved' && (
              <div className="mb-4 flex items-center gap-2 text-sm rounded-xl px-4 py-3 bg-green-50 border border-green-200 text-green-700">
                <CheckCircle size={15} /> Reference drawings approved by owner. Order can now be approved.
              </div>
            )}
            {drawingStatus === 'pending_review' && (
              <div className="mb-4 flex items-center gap-2 text-sm rounded-xl px-4 py-3 bg-blue-50 border border-blue-200 text-blue-700">
                <Clock size={15} /> Drawings uploaded and awaiting owner review.
                {user.role === 'owner' && ' Use the Approve / Reject buttons above.'}
              </div>
            )}
            {drawingStatus === 'rejected' && (
              <div className="mb-4 text-sm rounded-xl px-4 py-3 bg-red-50 border border-red-200 text-red-700">
                <div className="flex items-center gap-2 font-semibold mb-1">
                  <AlertTriangle size={15} /> Drawings Rejected — upload new drawings
                </div>
                <div className="text-xs text-red-600">Reason: {order.drawing_rejection_reason}</div>
                {canUploadDrawing && (
                  <div className="text-xs text-red-500 mt-1">Please delete the rejected drawings below and upload corrected versions.</div>
                )}
              </div>
            )}

            {/* Overall no-drawing warning */}
            {!hasDrawings && !drawingStatus && ['pending', 'pending_approval'].includes(order.status) && (
              <div className="mb-4 text-sm rounded-xl px-4 py-3 bg-amber-50 border border-amber-200 text-amber-700">
                {canUploadDrawing
                  ? '⚠️ Upload reference drawings for each item below. Owner must approve before order can be approved.'
                  : '⚠️ Waiting for Design team to upload reference drawings. Owner must approve them before order approval.'}
              </div>
            )}

            {/* Per-item drawing rows */}
            <div className="space-y-3">
              {(order.items || []).map((item, idx) => {
                const itemDrawings = (order.order_drawings || []).filter(d => d.item_id === item.id);
                const hasItemDrawing = itemDrawings.length > 0;
                return (
                  <div key={item.id} className={`rounded-xl border ${hasItemDrawing ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-gray-50'}`}>
                    {/* Item header row */}
                    <div className="flex items-center justify-between px-4 py-2.5">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full flex-shrink-0 ${
                          hasItemDrawing ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500'
                        }`}>
                          Item {idx + 1}
                        </span>
                        <div className="min-w-0">
                          <span className="text-sm font-semibold text-gray-800 font-mono">
                            {item.drawing_number || <span className="text-gray-400 font-sans font-normal italic">No drawing no.</span>}
                          </span>
                          {item.product_code && (
                            <span className="ml-2 text-xs text-gray-400">{item.product_code}</span>
                          )}
                          <div className="text-xs text-gray-400 mt-0.5">
                            {[item.tube_material, item.wattage ? `${item.wattage}W` : null, item.voltage ? `${item.voltage}V` : null]
                              .filter(Boolean).join(' · ') || 'No specs'}
                            {' · '}{item.quantity} Nos
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {hasItemDrawing
                          ? <span className="text-xs text-green-600 font-medium flex items-center gap-1">
                              <CheckCircle size={12} /> {itemDrawings.length} file{itemDrawings.length !== 1 ? 's' : ''}
                            </span>
                          : <span className="text-xs text-amber-600 font-medium">Missing</span>
                        }
                        {canUploadDrawing && (
                          <button
                            className="btn-secondary btn-sm py-1 px-2 text-xs"
                            onClick={() => { setDrawingUploadItemId(item.id); setDrawingUploadItem(item); setShowDrawingModal(true); }}
                          >
                            <Upload size={11} /> Upload
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Uploaded drawings for this item */}
                    {itemDrawings.length > 0 && (
                      <div className="border-t border-green-200 divide-y divide-green-100">
                        {itemDrawings.map(d => (
                          <div key={d.id} className="flex items-center gap-3 px-4 py-2">
                            {isImage(d.file_name)
                              ? <img src={`/uploads/order-drawings/${d.file_name}`} alt=""
                                  className="w-9 h-9 object-cover rounded-lg flex-shrink-0 border border-green-200" />
                              : <div className="w-9 h-9 bg-red-50 rounded-lg flex items-center justify-center flex-shrink-0 border border-red-100">
                                  <FileText size={16} className="text-red-400" />
                                </div>
                            }
                            <div className="flex-1 min-w-0">
                              <a href={`/uploads/order-drawings/${d.file_name}`} target="_blank" rel="noopener noreferrer"
                                className="text-xs font-medium text-brand-600 hover:underline block truncate">
                                {d.original_name || d.file_name}
                              </a>
                              <div className="text-xs text-gray-400">{d.uploaded_by_name} · {fmtDate(d.created_at)}</div>
                            </div>
                            {canUploadDrawing && (
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

              {/* Order-level drawings (not tied to a specific item) */}
              {(order.order_drawings || []).filter(d => !d.item_id).map(d => (
                <div key={d.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl border border-gray-100">
                  {isImage(d.file_name)
                    ? <img src={`/uploads/order-drawings/${d.file_name}`} alt=""
                        className="w-12 h-12 object-cover rounded-lg flex-shrink-0 border border-gray-200" />
                    : <div className="w-12 h-12 bg-red-50 rounded-lg flex items-center justify-center flex-shrink-0">
                        <FileText size={22} className="text-red-500" />
                      </div>
                  }
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-gray-400 mb-0.5">General drawing (not linked to a specific item)</div>
                    <a href={`/uploads/order-drawings/${d.file_name}`} target="_blank" rel="noopener noreferrer"
                      className="text-sm font-medium text-brand-600 hover:underline block truncate">
                      {d.original_name || d.file_name}
                    </a>
                    <div className="text-xs text-gray-400 mt-0.5">{d.uploaded_by_name} · {fmtDate(d.created_at)}</div>
                  </div>
                  {canUploadDrawing && (
                    <button className="btn-ghost btn-sm p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 flex-shrink-0"
                      onClick={() => handleDeleteDrawing(d.id)} title="Delete drawing">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* ── Job Cards ── */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="section-title">Job Cards
                  {order.job_cards?.length > 0 && (
                    <span className="ml-1 text-sm font-normal text-gray-400">({order.job_cards.length})</span>
                  )}
                </h2>
                <p className="text-xs text-gray-400 mt-0.5">One job card per item — uploaded by Admin/Owner</p>
              </div>
              {canUploadJobCard && (
                <button className="btn-primary btn-sm" onClick={() => setShowJobCardModal(true)}>
                  <Upload size={14} /> Upload Job Card
                </button>
              )}
            </div>

            {/* Gate messages */}
            {order.status === 'pending_approval' && (
              <p className="text-gray-400 text-sm">Order must be approved first.</p>
            )}
            {order.status === 'rejected' && (
              <p className="text-gray-400 text-sm">Order was rejected.</p>
            )}
            {!['pending_approval', 'rejected'].includes(order.status) && !hasDrawings && (
              <p className="text-amber-600 text-sm bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                ⚠️ Design team must upload reference drawings before job cards can be uploaded.
              </p>
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
                    <div key={jc.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl border border-gray-100">
                      <div className="w-10 h-10 rounded-lg bg-brand-50 flex items-center justify-center flex-shrink-0">
                        <FileText size={20} className="text-brand-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-gray-900 text-sm">{jc.job_card_no}</span>
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
                        {canUploadJobCard && (
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
          </div>

          {/* ── Quotations ── */}
          <div className="card p-5">
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
              <div key={q.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg mb-2">
                <FileText size={18} className="text-red-500 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <a href={`/uploads/quotations/${q.file_name}`} target="_blank" rel="noopener noreferrer"
                    className="text-sm font-medium text-brand-600 hover:underline truncate block">{q.file_name}</a>
                  <div className="text-xs text-gray-400">{q.uploaded_by_name} · {fmtDate(q.created_at)}</div>
                </div>
              </div>
            ))}
          </div>
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
          onClose={() => setShowQuotationModal(false)}
          onSave={() => { setShowQuotationModal(false); load(); }}
        />
      )}
      {showDrawingModal && (
        <DrawingUploadModal orderId={id}
          itemId={drawingUploadItemId}
          item={drawingUploadItem}
          onClose={() => { setShowDrawingModal(false); setDrawingUploadItemId(null); setDrawingUploadItem(null); }}
          onSave={() => { setShowDrawingModal(false); setDrawingUploadItemId(null); setDrawingUploadItem(null); load(); }}
        />
      )}
      {showDrawingRejectModal && (
        <DrawingRejectModal
          onClose={() => setShowDrawingRejectModal(false)}
          onConfirm={async (reason) => {
            await api.put(`/orders/${id}/drawings/reject`, { reason });
            setShowDrawingRejectModal(false);
            load();
          }}
        />
      )}
      {showJobCardModal && (
        <UploadJobCardModal orderId={id}
          defaultDispatchDate={order.dispatch_date || ''}
          items={order.items || []}
          jobCards={order.job_cards || []}
          onClose={() => setShowJobCardModal(false)}
          onSave={() => { setShowJobCardModal(false); load(); }}
        />
      )}
      {showItemModal && (
        <ItemModal
          item={editingItem}
          orderId={id}
          onClose={() => { setShowItemModal(false); setEditingItem(null); }}
          onSave={() => { setShowItemModal(false); setEditingItem(null); load(); }}
        />
      )}
    </div>
  );
}

// ── Render message with highlighted @mentions ─────────────────────────────────
function MessageText({ text, isMe }) {
  const parts = text.split(/(@\w[\w\s]*)/g);
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

// ── Chat Panel ───────────────────────────────────────────────────────────────
function ChatPanel({ orderId, currentUser }) {
  const [messages, setMessages] = useState([]);
  const [newMsg, setNewMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState([]);
  const [mentionQuery, setMentionQuery] = useState(null); // string after @ or null
  const [mentionPos, setMentionPos] = useState(0);        // caret position where @ was typed
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);

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
    // Find the last @ before caret
    const textToCaret = val.slice(0, caret);
    const atIdx = textToCaret.lastIndexOf('@');
    if (atIdx !== -1) {
      const query = textToCaret.slice(atIdx + 1);
      // Only show dropdown if no space before caret (i.e. still typing the mention)
      if (!query.includes(' ') || query.length === 0) {
        setMentionQuery(query.toLowerCase());
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
    setTimeout(() => {
      textareaRef.current?.focus();
      const pos = before.length + inserted.length;
      textareaRef.current?.setSelectionRange(pos, pos);
    }, 0);
  };

  const sendMessage = async () => {
    if (!newMsg.trim() || sending) return;
    setSending(true);
    try {
      await api.post(`/orders/${orderId}/messages`, { message: newMsg });
      setNewMsg('');
      setMentionQuery(null);
      await loadMessages();
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
                    <MessageText text={msg.message} isMe={isMe} />
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
      <div className="border-t border-gray-100 p-3 flex gap-2 items-end relative">
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
          disabled={sending || !newMsg.trim()}
          onClick={sendMessage}
          title="Send"
        >
          <Send size={15} />
        </button>
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
function ItemModal({ item, orderId, onClose, onSave }) {
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
  useEffect(() => { api.get('/products').then(r => setProducts(r.data)).catch(() => {}); }, []);
  const filteredProducts = products.filter(p =>
    (p.product_code || '').toLowerCase().includes(productSearch.toLowerCase()) ||
    (p.name || '').toLowerCase().includes(productSearch.toLowerCase())
  ).slice(0, 8);
  const selectProduct = (p) => {
    setF(prev => ({ ...prev, product_code: p.product_code }));
    setProductSearch(p.product_code);
    setShowProductDropdown(false);
  };

  const addFiles = (e) => {
    const files = Array.from(e.target.files);
    setNewFiles(prev => [...prev, ...files]);
    e.target.value = '';
  };

  const handleSave = async () => {
    const missing = validateItem(f);
    if (missing.length) {
      setError(`Required fields missing: ${missing.join(', ')}`);
      return;
    }
    setSaving(true);
    try {
      if (item?.id) {
        await api.put(`/orders/${orderId}/items/${item.id}`, f);
        if (newFiles.length) {
          const fd = new FormData();
          newFiles.forEach(file => fd.append('images', file));
          await api.post(`/orders/${orderId}/items/${item.id}/images`, fd);
        }
      } else {
        const res = await api.post(`/orders/${orderId}/items`, f);
        if (newFiles.length) {
          const fd = new FormData();
          newFiles.forEach(file => fd.append('images', file));
          await api.post(`/orders/${orderId}/items/${res.data.id}/images`, fd);
        }
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
          {f.drawing_number && (
            <div className="mt-1.5 space-y-0.5">
              {[
                { lang: 'ગુ', text: transliterateGujarati(f.drawing_number) },
                { lang: 'हि', text: transliterateHindi(f.drawing_number) },
              ].map(({ lang, text }) => (
                <div key={lang} className="flex items-center gap-1.5 text-xs text-gray-500">
                  <span className="text-gray-400 font-medium w-5 flex-shrink-0">{lang}:</span>
                  <span className="font-mono">{text}</span>
                  <button type="button" className="ml-1 text-gray-400 hover:text-brand-600 transition-colors" title="Copy"
                    onClick={() => navigator.clipboard.writeText(text)}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Tube */}
        <div>
          <label className="label">Tube Material <span className="text-red-500">*</span></label>
          <select className="input" value={f.tube_material} onChange={set('tube_material')}>
            <option value="">— Select material —</option>
            <option value="SS 304">SS 304</option>
            <option value="SS 316">SS 316</option>
            <option value="Incoloy">Incoloy</option>
            <option value="Copper">Copper</option>
            <option value="Titanium">Titanium</option>
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

function DrawingUploadModal({ orderId, itemId, item, onClose, onSave }) {
  const [file, setFile] = useState(null);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (!file) return setError('Please select a file');
    setSaving(true);
    const fd = new FormData();
    fd.append('file', file);
    if (notes) fd.append('notes', notes);
    if (itemId) fd.append('item_id', itemId);
    try {
      await api.post(`/orders/${orderId}/drawings`, fd);
      onSave();
    } catch (err) {
      setError(err.response?.data?.error || 'Upload failed');
      setSaving(false);
    }
  };

  const modalTitle = item
    ? `Upload Drawing — ${item.drawing_number || item.product_code || 'Item'}`
    : 'Upload Reference Drawing';

  return (
    <Modal open title={modalTitle} onClose={onClose} size="sm">
      <div className="space-y-4">
        {item && (
          <div className="bg-blue-50 border border-blue-100 text-blue-700 text-xs rounded-lg px-3 py-2">
            <span className="font-semibold">For: </span>
            {item.drawing_number && <span className="font-mono">{item.drawing_number}</span>}
            {item.product_code && <span className="ml-1 text-blue-500">({item.product_code})</span>}
            <div className="mt-0.5 text-blue-500">
              {[item.tube_material, item.wattage && `${item.wattage}W`, item.voltage && `${item.voltage}V`, item.quantity && `Qty: ${item.quantity}`].filter(Boolean).join(' · ')}
            </div>
          </div>
        )}
        <FileUpload onFile={setFile} accept=".pdf,.jpg,.jpeg,.png,.dwg,.dxf" label="Select drawing (PDF, Image, DWG, DXF)" />
        <div>
          <label className="label">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
          <textarea className="input h-20 resize-none" value={notes}
            onChange={e => setNotes(e.target.value)} placeholder="Assembly notes, revision info, etc." />
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <div className="flex gap-3">
          <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={saving} onClick={handleSubmit}>
            {saving ? 'Uploading...' : 'Upload Drawing'}
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

function QuotationModal({ orderId, onClose, onSave }) {
  const [file, setFile] = useState(null);
  const [notes, setNotes] = useState('');
  const [sentDate, setSentDate] = useState(new Date().toISOString().split('T')[0]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (!file) return setError('Please select a file');
    setSaving(true);
    const fd = new FormData();
    fd.append('file', file);
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
    <Modal open title="Upload Quotation" onClose={onClose} size="sm">
      <div className="space-y-4">
        <FileUpload onFile={setFile} accept=".pdf" label="Select Quotation PDF" />
        <div>
          <label className="label">Date Sent</label>
          <input className="input" type="date" value={sentDate} onChange={e => setSentDate(e.target.value)} />
        </div>
        <div>
          <label className="label">Notes</label>
          <textarea className="input h-20 resize-none" value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <div className="flex gap-3">
          <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={saving} onClick={handleSubmit}>
            {saving ? 'Uploading...' : 'Upload'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function UploadJobCardModal({ orderId, defaultDispatchDate, items, jobCards, onClose, onSave }) {
  const [selectedItemId, setSelectedItemId] = useState('');
  const [form, setForm] = useState({
    qty: '', dispatch_date: defaultDispatchDate || '',
    notes: '', punching: '',
  });
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  // Items that already have a job card uploaded (matched by drawing_number → job_card_no / drawing_no)
  const takenDrawings = new Set(jobCards.flatMap(jc => [jc.job_card_no, jc.drawing_no].filter(Boolean)));
  const availableItems = items.filter(item =>
    !takenDrawings.has(item.drawing_number) && !takenDrawings.has(item.product_code)
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
              ✅ All items already have a job card uploaded
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
