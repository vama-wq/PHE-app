import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api, { uploadApi } from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import {
  PenLine, CheckCircle2, Clock, AlertTriangle, Upload,
  FileImage, ExternalLink, ChevronRight, RefreshCw, XCircle
} from 'lucide-react';

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function DrawingsList() {
  const { user } = useAuthStore();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('pending'); // 'pending' | 'ready'

  const load = () => {
    setLoading(true);
    api.get('/orders/drawings/pending')
      .then(r => setOrders(r.data))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const canUpload = ['design', 'admin', 'owner'].includes(user?.role);

  // Tabs: needs drawing, awaiting owner review, rejected, approved
  const needsDrawing   = orders.filter(o => !o.drawing_status);
  const awaitingReview = orders.filter(o => o.drawing_status === 'pending_review');
  const rejectedOrders = orders.filter(o => o.drawing_status === 'rejected');
  const approvedOrders = orders.filter(o => o.drawing_status === 'approved');

  // backward compat aliases for displayed
  const pendingOrders = needsDrawing;
  const readyOrders   = approvedOrders;

  const displayed = tab === 'pending' ? needsDrawing
    : tab === 'review' ? awaitingReview
    : tab === 'rejected' ? rejectedOrders
    : approvedOrders;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <PenLine size={22} className="text-brand-600" />
            Reference Drawings
          </h1>
          <p className="text-gray-500 text-sm mt-0.5">
            Upload reference drawings for orders before the Owner can approve them
          </p>
        </div>
        <button onClick={load} className="btn-secondary flex items-center gap-1.5 text-sm">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        {[
          { key: 'pending',  count: needsDrawing.length,   label: 'Needs Drawing',     sub: 'No drawing uploaded',          color: 'red',   Icon: AlertTriangle },
          { key: 'review',   count: awaitingReview.length, label: 'Awaiting Review',   sub: 'Owner must approve',           color: 'blue',  Icon: Clock },
          { key: 'rejected', count: rejectedOrders.length, label: 'Rejected',           sub: 'Design must revise',           color: 'amber', Icon: XCircle },
          { key: 'ready',    count: approvedOrders.length, label: 'Approved',           sub: 'Ready for order approval',     color: 'green', Icon: CheckCircle2 },
        ].map(({ key, count, label, sub, color, Icon }) => (
          <div key={key}
            className={`card p-3 cursor-pointer border-2 transition-colors ${tab === key ? `border-${color}-400 bg-${color}-50` : 'border-transparent hover:border-gray-200'}`}
            onClick={() => setTab(key)}
          >
            <div className="flex items-center gap-2.5">
              <div className={`w-9 h-9 rounded-xl bg-${color}-100 flex items-center justify-center flex-shrink-0`}>
                <Icon size={16} className={`text-${color}-600`} />
              </div>
              <div>
                <p className={`text-xl font-bold text-${color}-700`}>{loading ? '…' : count}</p>
                <p className={`text-xs font-medium text-${color}-600`}>{label}</p>
                <p className="text-xs text-gray-400">{sub}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Tab label */}
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
          {tab === 'pending' ? 'Orders Needing Drawings' : tab === 'review' ? 'Awaiting Owner Review' : tab === 'rejected' ? 'Rejected — Needs Revision' : 'Approved Drawings'}
        </h2>
        <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
          tab === 'pending' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
        }`}>
          {displayed.length}
        </span>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-gray-400">Loading…</div>
        ) : displayed.length === 0 ? (
          <div className="p-12 text-center text-gray-400">
            {tab === 'pending'
              ? '🎉 All pending orders have reference drawings uploaded.'
              : 'No orders with drawings yet.'}
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="table-header text-left">Order</th>
                <th className="table-header text-left">Customer</th>
                <th className="table-header text-left">Items</th>
                <th className="table-header text-left">Created</th>
                <th className="table-header text-center">Status</th>
                {tab === 'ready' && <th className="table-header text-left">Drawings</th>}
                <th className="table-header text-center">
                  {tab === 'pending' && canUpload ? 'Upload' : 'Action'}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {displayed.map(order => (
                <OrderRow
                  key={order.id}
                  order={order}
                  tab={tab}
                  canUpload={canUpload}
                  onUploaded={load}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function OrderRow({ order, tab, canUpload, onUploaded }) {
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);

  const handleUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await uploadApi.post(`/orders/${order.id}/drawings`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      onUploaded();
    } catch (err) {
      alert(err.response?.data?.error || 'Upload failed');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const drawings = Array.isArray(order.drawings) ? order.drawings : [];

  return (
    <tr className="hover:bg-gray-50">
      {/* Order code */}
      <td className="table-cell">
        <Link to={`/orders/${order.id}`} className="font-semibold text-brand-700 hover:underline">
          {order.order_code}
        </Link>
        <div className="text-xs text-gray-400 mt-0.5">{fmtDate(order.order_date)}</div>
      </td>

      {/* Customer */}
      <td className="table-cell">
        <div className="text-sm font-medium text-gray-800">{order.customer_code}</div>
        <div className="text-xs text-gray-400">{order.customer_name}</div>
      </td>

      {/* Items */}
      <td className="table-cell text-sm text-gray-600">
        {order.item_count} item{order.item_count !== 1 ? 's' : ''}
      </td>

      {/* Created */}
      <td className="table-cell text-sm text-gray-500">
        {fmtDate(order.created_at)}
        <div className="text-xs text-gray-400">{order.created_by_name}</div>
      </td>

      {/* Status + item drawing numbers */}
      <td className="table-cell">
        {parseInt(order.drawing_count) === 0 ? (
          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium mb-1.5">
            <AlertTriangle size={10} /> No Drawing
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium mb-1.5">
            <CheckCircle2 size={10} /> {order.drawing_count} file{order.drawing_count !== 1 ? 's' : ''}
          </span>
        )}
        {/* Item drawing numbers needed */}
        {Array.isArray(order.items) && order.items.length > 0 && (
          <div className="flex flex-col gap-0.5 mt-1">
            {order.items.map((item, i) => {
              const itemDrawings = (drawings).filter(d => d.item_id === item.id);
              const done = itemDrawings.length > 0;
              return (
                <div key={item.id} className="flex items-center gap-1.5">
                  {done
                    ? <CheckCircle2 size={10} className="text-green-500 flex-shrink-0" />
                    : <AlertTriangle size={10} className="text-amber-500 flex-shrink-0" />
                  }
                  <span className={`text-xs font-mono ${done ? 'text-green-700' : 'text-gray-600'}`}>
                    {item.drawing_number || `Item ${i + 1}`}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </td>

      {/* Drawings list (ready tab) */}
      {tab === 'ready' && (
        <td className="table-cell">
          <div className="flex flex-col gap-1">
            {drawings.map(d => (
              <a
                key={d.id}
                href={`/uploads/order-drawings/${d.file_name}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs text-brand-600 hover:underline"
              >
                <FileImage size={12} />
                {d.original_name || d.file_name}
                <ExternalLink size={10} />
              </a>
            ))}
          </div>
        </td>
      )}

      {/* Action */}
      <td className="table-cell text-center">
        {tab === 'pending' && canUpload ? (
          <>
            <button
              className="btn-primary text-xs px-3 py-1.5 flex items-center gap-1.5 mx-auto"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? (
                <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <Upload size={12} />
              )}
              {uploading ? 'Uploading…' : 'Upload Drawing'}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.dwg,.dxf"
              className="hidden"
              onChange={handleUpload}
            />
          </>
        ) : (
          <Link
            to={`/orders/${order.id}`}
            className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline"
          >
            View Order <ChevronRight size={12} />
          </Link>
        )}
      </td>
    </tr>
  );
}
