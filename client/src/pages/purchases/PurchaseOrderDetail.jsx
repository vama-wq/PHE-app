import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import api, { uploadApi } from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import { fmtDate, fmtDateTime, ROLE_COLORS, ROLE_LABELS } from '../../lib/utils';
import Modal from '../../components/ui/Modal';
import FileUpload from '../../components/ui/FileUpload';
import {
  ArrowLeft, Printer, Send, CheckCircle, XCircle,
  PackageCheck, Pencil, Loader2, Truck, Upload, FileText,
  ExternalLink, RefreshCw, MessageSquare, Trash2, AlertTriangle
} from 'lucide-react';

// ── Constants ─────────────────────────────────────────────────────────────────
const STATUS_STYLES = {
  draft:    'bg-gray-100 text-gray-600',
  sent:     'bg-blue-100 text-blue-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  received: 'bg-teal-100 text-teal-700',
};
const STATUS_LABELS = {
  draft: 'Draft', sent: 'Sent — Awaiting Approval',
  approved: 'Approved', rejected: 'Rejected', received: 'Received',
};

const DELIVERY_STATUSES = [
  { value: 'in_transit',        label: 'In Transit',        style: 'bg-blue-100 text-blue-700' },
  { value: 'material_rejected', label: 'Material Rejected', style: 'bg-red-100 text-red-700' },
  { value: 'reconfirm_order',   label: 'Reconfirm Order',   style: 'bg-orange-100 text-orange-700' },
  { value: 'purchase_accepted', label: 'Purchase Accepted', style: 'bg-green-100 text-green-700' },
  { value: 'order_cancelled',   label: 'Order Cancelled',   style: 'bg-gray-100 text-gray-500' },
  { value: 'qc_pending',        label: 'QC Pending',        style: 'bg-purple-100 text-purple-700' },
  { value: 'received',          label: 'Received',          style: 'bg-teal-100 text-teal-700' },
];
// After approval, the only manual delivery updates are In Transit / Order Cancelled.
// "Received" is a separate invoice-gated action and QC is automatic.
const MANUAL_DELIVERY_OPTIONS = DELIVERY_STATUSES.filter(d => ['in_transit', 'order_cancelled'].includes(d.value));
const deliveryStyle = (v) => DELIVERY_STATUSES.find(d => d.value === v)?.style || 'bg-gray-100 text-gray-600';
const deliveryLabel = (v) => DELIVERY_STATUSES.find(d => d.value === v)?.label || v;

// ── Main component ────────────────────────────────────────────────────────────
export default function PurchaseOrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [po, setPo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState('');
  const [showApproveModal, setShowApproveModal] = useState(false);
  const [showReceiveModal, setShowReceiveModal] = useState(false);

  // delivery status update (for purchase manager)
  const [newDeliveryStatus, setNewDeliveryStatus] = useState('');
  const [newExpectedDate, setNewExpectedDate] = useState('');
  const [updatingStatus, setUpdatingStatus] = useState(false);

  const load = () => api.get(`/purchase-orders/${id}`)
    .then(r => { setPo(r.data); setNewDeliveryStatus(r.data.delivery_status || ''); setNewExpectedDate(r.data.expected_delivery_date || ''); })
    .finally(() => setLoading(false));

  useEffect(() => { load(); }, [id]);

  const act = async (endpoint, label) => {
    if (!window.confirm(`${label} this PO?`)) return;
    setActing(label);
    try {
      const res = await api.put(`/purchase-orders/${id}/${endpoint}`);
      if (res.data?.qc_required) {
        alert('PO sent to QC. The QC manager must inspect and accept the material before it can be marked as received.');
      }
      await load();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed');
    } finally {
      setActing('');
    }
  };

  const handleDeletePO = async () => {
    if (!window.confirm(`Delete PO "${po.po_number}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/purchase-orders/${id}`);
      navigate('/purchases');
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to delete PO');
    }
  };

  const handleUpdateDeliveryStatus = async () => {
    if (!newDeliveryStatus) return;
    setUpdatingStatus(true);
    try {
      await api.put(`/purchase-orders/${id}/delivery-status`, {
        delivery_status: newDeliveryStatus,
        expected_delivery_date: newExpectedDate || null,
      });
      await load();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to update');
    } finally {
      setUpdatingStatus(false);
    }
  };

  if (loading) return <div className="p-6 text-gray-400">Loading...</div>;
  if (!po) return <div className="p-6 text-red-500">Not found</div>;

  const fmt = n => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const canManagePO = ['owner', 'admin', 'accounts'].includes(user?.role);
  const canQC = ['design', 'owner', 'admin'].includes(user?.role);
  const isQCPending = po.status === 'approved' && po.delivery_status === 'qc_pending';
  const materialQCDone = !!po.material_qc;
  const drawingItems = po.items.filter(i => i.drawing_file);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* ── Header bar (screen only) ── */}
      <div className="flex items-center justify-between mb-5 no-print flex-wrap gap-3">
        <button onClick={() => navigate('/purchases')} className="btn-ghost btn-sm">
          <ArrowLeft size={16} /> Back
        </button>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold ${STATUS_STYLES[po.status]}`}>
            {STATUS_LABELS[po.status]}
          </span>
          {po.delivery_status && (
            <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold ${deliveryStyle(po.delivery_status)}`}>
              <Truck size={11} className="mr-1" /> {deliveryLabel(po.delivery_status)}
            </span>
          )}

          {['draft', 'rejected'].includes(po.status) && canManagePO && (
            <Link to={`/purchases/${id}/edit`} className="btn-secondary btn-sm flex items-center gap-1.5">
              <Pencil size={13} /> Edit PO
            </Link>
          )}
          {(user?.role === 'owner' || (['admin'].includes(user?.role) && ['draft', 'rejected'].includes(po.status))) && (
            <button className="btn-danger btn-sm flex items-center gap-1.5" onClick={handleDeletePO}>
              <Trash2 size={13} /> Delete PO
            </button>
          )}
          {['draft', 'rejected'].includes(po.status) && po.rate_increase_pending && user?.role === 'owner' && (
            <button className="btn-primary btn-sm flex items-center gap-1.5 bg-amber-600 hover:bg-amber-700 border-amber-600" disabled={!!acting}
              onClick={() => act('approve-rate', 'Approve Rate Change')}>
              {acting === 'Approve Rate Change' ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle size={13} />}
              Approve Rate Change
            </button>
          )}
          {['draft', 'rejected'].includes(po.status) && canManagePO && (
            <button className="btn-primary btn-sm flex items-center gap-1.5" disabled={!!acting || po.rate_increase_pending}
              title={po.rate_increase_pending ? 'A rate increase needs owner approval before this PO can be sent' : ''}
              onClick={() => act('send', 'Send')}>
              {acting === 'Send' ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
              Mark as Sent
            </button>
          )}
          {po.status === 'sent' && canManagePO && (
            <>
              <button className="btn-primary btn-sm flex items-center gap-1.5 bg-green-600 hover:bg-green-700 border-green-600" disabled={!!acting}
                onClick={() => setShowApproveModal(true)}>
                <CheckCircle size={13} /> Mark Approved
              </button>
              <button className="btn-secondary btn-sm flex items-center gap-1.5 text-red-600 border-red-200 hover:bg-red-50" disabled={!!acting}
                onClick={() => act('reject', 'Reject')}>
                <XCircle size={13} /> Reject (needs changes)
              </button>
            </>
          )}
          {po.status === 'approved' && canManagePO && po.delivery_status !== 'order_cancelled' && po.items.some(i => !i.received) && (
            <button className="btn-primary btn-sm flex items-center gap-1.5 bg-teal-600 hover:bg-teal-700 border-teal-600"
              onClick={() => setShowReceiveModal(true)}>
              <PackageCheck size={13} /> Receive an Item
            </button>
          )}
          {po.status === 'approved' && isQCPending && (
            <span className="text-xs bg-purple-100 text-purple-700 px-3 py-1.5 rounded-full font-medium">
              ⏳ QC {po.items.filter(i => i.qc_status).length}/{po.items.length} · received {po.items.filter(i => i.received).length}/{po.items.length}
            </span>
          )}
          <button className="btn-secondary btn-sm flex items-center gap-1.5" onClick={() => window.print()}>
            <Printer size={13} /> Print / PDF
          </button>
        </div>
      </div>

      {/* ── Rate-increase approval banner ── */}
      {po.rate_increase_pending && (
        <div className="card p-4 mb-5 bg-amber-50 border border-amber-200 no-print flex items-start gap-2.5">
          <AlertTriangle size={18} className="text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="text-sm text-amber-800">
            <span className="font-semibold">Rate increase pending owner approval.</span>{' '}
            This PO is priced above the agreed/last rate, so it can’t be marked as sent until the owner approves the change.
            {user?.role === 'owner' ? ' Use “Approve Rate Change” above.' : ' An owner has been notified.'} See the details in the messages below.
          </div>
        </div>
      )}

      {/* ── Delivery Status panel (only while still in transit / accepted) ── */}
      {po.status === 'approved' && canManagePO && ['purchase_accepted', 'in_transit'].includes(po.delivery_status) && (
        <div className="card p-5 mb-5 no-print">
          <h3 className="font-semibold text-gray-900 mb-1 flex items-center gap-2">
            <Truck size={16} className="text-brand-600" />
            Delivery Status
          </h3>
          <p className="text-xs text-gray-400 mb-4">Current: <span className={`px-2 py-0.5 rounded-full font-medium ${deliveryStyle(po.delivery_status)}`}>{deliveryLabel(po.delivery_status)}</span> · Use “Mark as Received” (above) when the goods arrive with the invoice.</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
            <div>
              <label className="label">Update to</label>
              <select className="input" value={newDeliveryStatus} onChange={e => setNewDeliveryStatus(e.target.value)}>
                <option value="">— Select status —</option>
                {MANUAL_DELIVERY_OPTIONS.map(d => (
                  <option key={d.value} value={d.value}>{d.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Expected Delivery Date</label>
              <input type="date" className="input" value={newExpectedDate} onChange={e => setNewExpectedDate(e.target.value)} />
            </div>
            <div>
              <button
                className="btn-primary w-full flex items-center justify-center gap-2"
                onClick={handleUpdateDeliveryStatus}
                disabled={updatingStatus || !newDeliveryStatus}
              >
                {updatingStatus ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                Update Status
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Received invoice ── */}
      {po.invoice_file && (
        <div className="card p-4 mb-5 no-print flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-gray-700"><FileText size={15} className="text-brand-600" /> Received invoice attached</div>
          <a href={`/uploads/${po.invoice_file}`} target="_blank" rel="noopener noreferrer" className="text-brand-600 text-sm hover:underline flex items-center gap-1"><ExternalLink size={13} /> View invoice</a>
        </div>
      )}

      {/* ── Item Receiving & QC panel (approved POs, screen only) ── */}
      {((po.status === 'approved' && po.delivery_status !== 'order_cancelled') || po.status === 'received') && (
        <div className="card p-5 mb-5 no-print">
          <h3 className="font-semibold text-gray-900 mb-1 flex items-center gap-2">
            <PackageCheck size={16} className="text-teal-600" /> Item Receiving & QC
          </h3>
          <p className="text-xs text-gray-400 mb-4">
            Receive each item as it arrives (attach its invoice), then QC it — material image + weight of 10 pcs are required to approve.
          </p>
          <div className="space-y-2.5">
            {po.items.map(item => (
              <ItemQCRow key={item.id} poId={id} item={item} canQC={canQC} onDone={load} />
            ))}
          </div>
        </div>
      )}

      {/* ── Item drawings panel (screen only) ── */}
      {drawingItems.length > 0 && (
        <div className="card p-5 mb-5 no-print">
          <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
            <FileText size={16} className="text-brand-600" />
            Item Drawings ({drawingItems.length})
          </h3>
          <div className="space-y-2">
            {drawingItems.map(item => (
              <div key={item.id} className="flex items-center justify-between p-2.5 bg-gray-50 rounded-lg">
                <div>
                  <div className="text-sm font-medium text-gray-800">{item.description}</div>
                  <div className="text-xs text-gray-500">{item.drawing_original_name}</div>
                </div>
                <a
                  href={`/uploads/${item.drawing_file}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-secondary btn-sm flex items-center gap-1.5"
                >
                  <ExternalLink size={12} /> View Drawing
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── PRINTABLE PO DOCUMENT ── */}
      <div className="po-print-area bg-white" id="po-document">
        {/* Company Header */}
        <table className="po-header-table" style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 0 }}>
          <tbody>
            <tr>
              <td style={{ width: '80px', padding: '8px', verticalAlign: 'top' }}>
                <div style={{ border: '1px solid #ccc', padding: '4px', display: 'inline-block' }}>
                  <img src="/logo.png" alt="PHE" style={{ width: '70px', height: '70px', objectFit: 'contain' }} />
                </div>
              </td>
              <td style={{ padding: '8px', verticalAlign: 'top' }}>
                <div style={{ color: '#1a2a6e', fontWeight: 900, fontSize: '22px', letterSpacing: '0.5px' }}>
                  PEENA HEAT ELEMENTS LLP
                </div>
                <div style={{ fontSize: '11px', color: '#333', lineHeight: '1.5' }}>
                  Shed no 2 to 5, Ravi Estate, near Kothari Char Rasta, Santej, Tal: Kalol,<br />
                  Dist.: Gandhinagar: 382721
                </div>
              </td>
              <td style={{ width: '130px', padding: '8px', textAlign: 'right', verticalAlign: 'top' }}>
                <img src="/logo.png" alt="PHE Globe" style={{ width: '80px', height: '80px', objectFit: 'contain' }} />
              </td>
            </tr>
          </tbody>
        </table>

        {/* PO Title */}
        <div style={{ textAlign: 'center', fontWeight: 800, fontSize: '15px', padding: '6px', borderTop: '2px solid #1a2a6e', borderBottom: '1px solid #1a2a6e', letterSpacing: '2px', marginTop: '4px' }}>
          PURCHASE ORDER
        </div>
        <div style={{ textAlign: 'center', fontSize: '12px', padding: '4px 0', borderBottom: '1px solid #1a2a6e', fontWeight: 600 }}>
          GST NO. 24ABGFP7267B1ZA
        </div>

        {/* Supplier + PO Meta */}
        <table style={{ width: '100%', borderCollapse: 'collapse', borderBottom: '1px solid #999', fontSize: '12px' }}>
          <tbody>
            <tr>
              <td style={{ padding: '8px 10px', width: '60%', verticalAlign: 'top' }}>
                <div style={{ fontWeight: 600, marginBottom: '2px' }}>To,</div>
                <div style={{ fontWeight: 700, fontSize: '13px' }}>{po.supplier_name}</div>
                {po.supplier_address && <div style={{ marginTop: '2px', color: '#444', lineHeight: '1.4' }}>{po.supplier_address}</div>}
                {po.supplier_gst && <div style={{ marginTop: '2px' }}>GST: {po.supplier_gst}</div>}
                {po.supplier_phone && <div>{po.supplier_phone}</div>}
                {po.supplier_email && <div>{po.supplier_email}</div>}
              </td>
              <td style={{ padding: '8px 10px', borderLeft: '1px solid #999', verticalAlign: 'top' }}>
                <table style={{ width: '100%' }}>
                  <tbody>
                    <tr>
                      <td style={{ paddingBottom: '4px', whiteSpace: 'nowrap' }}><strong>PO No. :</strong></td>
                      <td style={{ paddingBottom: '4px', paddingLeft: '8px' }}>{po.po_number}</td>
                    </tr>
                    <tr>
                      <td style={{ paddingBottom: '4px', whiteSpace: 'nowrap' }}><strong>Date :</strong></td>
                      <td style={{ paddingLeft: '8px' }}>{fmtDate(po.created_at)}</td>
                    </tr>
                    {po.expected_delivery_date && (
                      <tr>
                        <td style={{ whiteSpace: 'nowrap' }}><strong>Delivery By :</strong></td>
                        <td style={{ paddingLeft: '8px' }}>{fmtDate(po.expected_delivery_date)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>

        {/* Items Table */}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', border: '1px solid #999' }}>
          <thead>
            <tr style={{ background: '#f0f0f0' }}>
              <th style={{ border: '1px solid #999', padding: '5px 8px', textAlign: 'center', width: '40px' }}>S.N.</th>
              <th style={{ border: '1px solid #999', padding: '5px 8px', textAlign: 'left' }}>Description of Goods</th>
              <th style={{ border: '1px solid #999', padding: '5px 8px', textAlign: 'center', width: '60px' }}>Unit</th>
              <th style={{ border: '1px solid #999', padding: '5px 8px', textAlign: 'right', width: '70px' }}>Qty</th>
              <th style={{ border: '1px solid #999', padding: '5px 8px', textAlign: 'right', width: '80px' }}>Rate<br /><span style={{ fontWeight: 'normal' }}>Rupees</span></th>
              <th style={{ border: '1px solid #999', padding: '5px 8px', textAlign: 'right', width: '90px' }}>Amount<br /><span style={{ fontWeight: 'normal' }}>Rupees</span></th>
            </tr>
          </thead>
          <tbody>
            {po.items.map((item, i) => (
              <tr key={item.id}>
                <td style={{ border: '1px solid #ccc', padding: '4px 8px', textAlign: 'center' }}>{i + 1}</td>
                <td style={{ border: '1px solid #ccc', padding: '4px 8px' }}>
                  {item.description}
                  {item.drawing_original_name && (
                    <span style={{ fontSize: '10px', color: '#666', marginLeft: '6px' }}>
                      [Dwg: {item.drawing_original_name}]
                    </span>
                  )}
                </td>
                <td style={{ border: '1px solid #ccc', padding: '4px 8px', textAlign: 'center' }}>{item.unit || ''}</td>
                <td style={{ border: '1px solid #ccc', padding: '4px 8px', textAlign: 'right' }}>{Number(item.qty).toLocaleString('en-IN')}</td>
                <td style={{ border: '1px solid #ccc', padding: '4px 8px', textAlign: 'right' }}>{fmt(item.rate)}</td>
                <td style={{ border: '1px solid #ccc', padding: '4px 8px', textAlign: 'right' }}>{fmt(item.amount)}</td>
              </tr>
            ))}
            {Array.from({ length: Math.max(0, 12 - po.items.length) }).map((_, i) => (
              <tr key={`blank-${i}`} style={{ height: '22px' }}>
                <td style={{ border: '1px solid #ccc' }}></td>
                <td style={{ border: '1px solid #ccc' }}></td>
                <td style={{ border: '1px solid #ccc' }}></td>
                <td style={{ border: '1px solid #ccc' }}></td>
                <td style={{ border: '1px solid #ccc' }}></td>
                <td style={{ border: '1px solid #ccc', textAlign: 'right', padding: '2px 8px', color: '#999' }}>0.00</td>
              </tr>
            ))}
            <tr>
              <td colSpan={5} style={{ border: '1px solid #ccc', padding: '4px 8px', textAlign: 'right', fontWeight: 600 }}>Transport Charges</td>
              <td style={{ border: '1px solid #ccc', padding: '4px 8px', textAlign: 'right' }}>{fmt(po.transport_charges)}</td>
            </tr>
            <tr style={{ background: '#fafafa' }}>
              <td colSpan={5} style={{ border: '1px solid #ccc', padding: '4px 8px', textAlign: 'right', fontWeight: 700 }}>Total</td>
              <td style={{ border: '1px solid #ccc', padding: '4px 8px', textAlign: 'right', fontWeight: 700 }}>{fmt(po.subtotal)}</td>
            </tr>
            <tr>
              <td colSpan={3} style={{ border: '1px solid #ccc', padding: '4px 8px', textAlign: 'right', fontWeight: 700 }}>IGST</td>
              <td style={{ border: '1px solid #ccc', padding: '4px 8px', textAlign: 'center', fontWeight: 600 }}>{po.igst_percent}%</td>
              <td style={{ border: '1px solid #ccc' }}></td>
              <td style={{ border: '1px solid #ccc', padding: '4px 8px', textAlign: 'right' }}>{fmt(po.igst_amount)}</td>
            </tr>
            <tr style={{ background: '#f0f0f0' }}>
              <td colSpan={5} style={{ border: '1px solid #ccc', padding: '5px 8px', textAlign: 'right', fontWeight: 800, fontSize: '13px' }}>Grand Total</td>
              <td style={{ border: '1px solid #ccc', padding: '5px 8px', textAlign: 'right', fontWeight: 800, fontSize: '13px' }}>{fmt(po.grand_total)}</td>
            </tr>
          </tbody>
        </table>

        {/* Footer */}
        <table style={{ width: '100%', marginTop: '12px', fontSize: '11px' }}>
          <tbody>
            <tr>
              <td style={{ width: '50%', verticalAlign: 'top', paddingRight: '16px' }}>
                <div style={{ fontWeight: 700, textDecoration: 'underline', marginBottom: '4px' }}>BANK DETAILS:</div>
                <div style={{ color: '#b91c1c' }}>
                  <div><strong>BANK NAME : KOTAK MAHINDRA BANK</strong></div>
                  <div><strong>ACCOUNT NO : 9999555595</strong></div>
                  <div><strong>IFSC CODE : KKBK0002621</strong></div>
                  <div><strong>BENEFICIARY NAME: PEENA HEAT ELEMENTS LLP</strong></div>
                  <div><strong>WITH NEW SINDHUBHAVAN BRANCH</strong></div>
                </div>
              </td>
              <td style={{ width: '50%', textAlign: 'center', verticalAlign: 'bottom', paddingTop: '32px' }}>
                <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '2px' }}>For Peena Traders</div>
                <div style={{ fontWeight: 600 }}>Authorised Signatory</div>
              </td>
            </tr>
          </tbody>
        </table>

        {po.notes && (
          <div style={{ marginTop: '10px', fontSize: '11px', color: '#555', borderTop: '1px solid #eee', paddingTop: '6px' }}>
            <strong>Notes:</strong> {po.notes}
          </div>
        )}
      </div>

      {/* ── Timeline (screen only) ── */}
      <div className="mt-6 card p-5 no-print">
        <h3 className="font-semibold text-gray-900 mb-3 text-sm">Timeline</h3>
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2 text-gray-600">
            <div className="w-2 h-2 rounded-full bg-brand-600" />
            Created: {fmtDate(po.created_at)} by {po.created_by_name}
          </div>
          {po.sent_at && (
            <div className="flex items-center gap-2 text-blue-600">
              <div className="w-2 h-2 rounded-full bg-blue-500" />
              Sent: {fmtDate(po.sent_at)}
            </div>
          )}
          {po.approved_at && (
            <div className="flex items-center gap-2 text-green-600">
              <div className="w-2 h-2 rounded-full bg-green-500" />
              Approved: {fmtDate(po.approved_at)}
              {po.expected_delivery_date && <span className="text-gray-500 text-xs">· Expected delivery: {fmtDate(po.expected_delivery_date)}</span>}
            </div>
          )}
          {po.delivery_status && (
            <div className={`flex items-center gap-2`}>
              <div className="w-2 h-2 rounded-full bg-orange-400" />
              <span className="text-gray-700">Delivery status: </span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${deliveryStyle(po.delivery_status)}`}>
                {deliveryLabel(po.delivery_status)}
              </span>
            </div>
          )}
          {po.material_qc && (
            <div className="flex items-center gap-2 text-purple-600">
              <div className="w-2 h-2 rounded-full bg-purple-500" />
              Material QC approved: {fmtDate(po.material_qc.created_at)} by {po.material_qc.created_by_name}
            </div>
          )}
          {po.received_at && (
            <div className="flex items-center gap-2 text-teal-600">
              <div className="w-2 h-2 rounded-full bg-teal-500" />
              Goods Received: {fmtDate(po.received_at)}
            </div>
          )}
        </div>
      </div>

      {/* ── Chat Panel (screen only) ── */}
      <div className="mt-6 card no-print overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2">
          <MessageSquare size={16} className="text-brand-500" />
          <h3 className="font-semibold text-gray-900 text-sm">Chat</h3>
        </div>
        <POChatPanel poId={id} currentUser={user} />
      </div>

      {/* ── Modals ── */}
      {showApproveModal && (
        <ApproveModal
          poId={id}
          defaultDate={po.expected_delivery_date || ''}
          onClose={() => setShowApproveModal(false)}
          onApproved={() => { setShowApproveModal(false); load(); }}
        />
      )}
      {showReceiveModal && (
        <ReceiveItemModal
          poId={id}
          items={po.items.filter(i => !i.received)}
          onClose={() => setShowReceiveModal(false)}
          onDone={() => { setShowReceiveModal(false); load(); }}
        />
      )}
    </div>
  );
}

// Receive a single item: pick it from the dropdown of not-yet-received items and
// attach that item's invoice (mandatory). The item then goes to QC.
function ReceiveItemModal({ poId, items, onClose, onDone }) {
  const [itemId, setItemId] = useState(items[0]?.id ? String(items[0].id) : '');
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    if (!itemId) return setError('Select the item that was received');
    if (!file) return setError('Attach the invoice received with this item');
    setSaving(true); setError('');
    try {
      const fd = new FormData();
      fd.append('invoice', file);
      await uploadApi.post(`/purchase-orders/${poId}/items/${itemId}/receive`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      onDone();
    } catch (e) { setError(e.response?.data?.error || 'Failed'); setSaving(false); }
  };
  return (
    <Modal open title="Receive an Item" onClose={onClose} size="md">
      <div className="space-y-4">
        {items.length === 0 ? (
          <p className="text-sm text-gray-500">All items on this PO have already been received.</p>
        ) : (
          <>
            <div>
              <label className="label">Item received <span className="text-red-500">*</span></label>
              <select className="input" value={itemId} onChange={e => setItemId(e.target.value)}>
                {items.map(i => <option key={i.id} value={i.id}>{i.description} · qty {i.qty}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Invoice received with this item <span className="text-red-500">*</span></label>
              <FileUpload onFile={setFile} accept=".pdf,.jpg,.jpeg,.png" label="Select invoice (PDF or image)" />
            </div>
            {error && <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
            <div className="flex gap-3">
              <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
              <button className="btn-primary flex-1" disabled={saving} onClick={submit}>
                {saving ? 'Saving…' : 'Receive & Send to QC'}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// One PO item's QC: material image + weight of 10 pcs (both mandatory to approve).
function ItemQCRow({ poId, item, canQC, onDone }) {
  const [open, setOpen] = useState(false);
  const [image, setImage] = useState(null);
  const [weight10, setWeight10] = useState('');
  const [observations, setObservations] = useState('');
  const [mode, setMode] = useState('approve'); // approve | reject
  const [rejectReason, setRejectReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Resolved QC (approved/rejected) — read-only summary.
  if (item.qc_status === 'approved' || item.qc_status === 'rejected') {
    return (
      <div className={`rounded-lg px-3 py-2.5 border ${item.qc_status === 'approved' ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-gray-800">{item.description}</span>
          <span className={`text-xs font-semibold ${item.qc_status === 'approved' ? 'text-green-700' : 'text-red-700'}`}>
            {item.qc_status === 'approved' ? '✓ QC Approved' : '✕ Rejected'}
          </span>
        </div>
        <div className="text-xs text-gray-500 mt-0.5 flex flex-wrap gap-x-2">
          {item.qc_status === 'approved'
            ? <span>Weight of 10: <b>{item.qc_weight_10}</b>{item.qc_observations ? ` · ${item.qc_observations}` : ''}{item.qc_image_file && <> · <a className="text-brand-600 hover:underline" href={`/uploads/${item.qc_image_file}`} target="_blank" rel="noopener noreferrer">image</a></>}</span>
            : <span>Reason: {item.qc_rejection_reason}</span>}
          {item.invoice_file && <a className="text-brand-600 hover:underline" href={`/uploads/${item.invoice_file}`} target="_blank" rel="noopener noreferrer">invoice</a>}
        </div>
      </div>
    );
  }

  // Not yet received — receiving is done from the "Receive an Item" dropdown.
  if (!item.received) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white px-3 py-2.5 flex items-center justify-between">
        <span className="text-sm font-medium text-gray-800">{item.description} <span className="text-xs text-gray-400">· qty {item.qty}</span></span>
        <span className="text-xs text-gray-400">Awaiting receipt</span>
      </div>
    );
  }

  const submit = async () => {
    setError('');
    if (mode === 'approve') {
      if (!image) return setError('Material image is required');
      if (!weight10 || Number(weight10) <= 0) return setError('Weight of 10 pcs is required');
    } else if (!rejectReason.trim()) return setError('Rejection reason is required');
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('result', mode === 'approve' ? 'accepted' : 'rejected');
      if (mode === 'approve') { fd.append('image', image); fd.append('weight_10', weight10); fd.append('observations', observations); }
      else fd.append('rejection_reason', rejectReason);
      await uploadApi.post(`/purchase-orders/${poId}/items/${item.id}/qc`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      onDone();
    } catch (e) { setError(e.response?.data?.error || 'Failed'); setSaving(false); }
  };

  return (
    <div className="rounded-lg border border-purple-200 bg-purple-50/40 px-3 py-2.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-800">
          {item.description} <span className="text-xs text-gray-400">· qty {item.qty}</span>
          <span className="text-xs text-teal-600 ml-2">✓ received</span>
          {item.invoice_file && <> · <a className="text-xs text-brand-600 hover:underline" href={`/uploads/${item.invoice_file}`} target="_blank" rel="noopener noreferrer">invoice</a></>}
        </span>
        {canQC ? (
          !open ? <button className="btn-secondary btn-sm text-xs" onClick={() => setOpen(true)}>Do QC</button>
                : <span className="text-xs text-purple-600">QC…</span>
        ) : <span className="text-xs text-gray-400">Awaiting QC</span>}
      </div>
      {open && canQC && (
        <div className="mt-3 space-y-2.5 border-t border-gray-200 pt-3">
          <div className="flex gap-2">
            <button className={`btn-sm text-xs flex-1 ${mode === 'approve' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('approve')}>Approve</button>
            <button className={`btn-sm text-xs flex-1 ${mode === 'reject' ? 'btn-primary bg-red-600 border-red-600 hover:bg-red-700' : 'btn-secondary'}`} onClick={() => setMode('reject')}>Reject</button>
          </div>
          {mode === 'approve' ? (
            <>
              <div>
                <label className="label text-xs">Material image <span className="text-red-500">*</span></label>
                <FileUpload onFile={setImage} accept=".jpg,.jpeg,.png,.webp" label="Select material image" />
              </div>
              <div>
                <label className="label text-xs">Weight of 10 pcs <span className="text-red-500">*</span></label>
                <input className="input text-sm" type="number" step="any" min="0" value={weight10} onChange={e => setWeight10(e.target.value)} placeholder="e.g. 1.25" />
              </div>
              <div>
                <label className="label text-xs">Observations <span className="text-gray-400 font-normal">(optional)</span></label>
                <input className="input text-sm" value={observations} onChange={e => setObservations(e.target.value)} />
              </div>
            </>
          ) : (
            <div>
              <label className="label text-xs">Rejection reason <span className="text-red-500">*</span></label>
              <input className="input text-sm" value={rejectReason} onChange={e => setRejectReason(e.target.value)} />
            </div>
          )}
          {error && <p className="text-red-600 text-xs">{error}</p>}
          <div className="flex gap-2">
            <button className="btn-secondary btn-sm text-xs flex-1" onClick={() => setOpen(false)} disabled={saving}>Cancel</button>
            <button className="btn-primary btn-sm text-xs flex-1" onClick={submit} disabled={saving}>
              {saving ? 'Saving…' : mode === 'approve' ? 'Approve item' : 'Reject item'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Approve Modal: collect delivery status + expected date ────────────────────
function ApproveModal({ poId, defaultDate, onClose, onApproved }) {
  const [deliveryStatus, setDeliveryStatus] = useState('in_transit');
  const [expectedDate, setExpectedDate] = useState(defaultDate);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleApprove = async () => {
    setSaving(true);
    setError('');
    try {
      await api.put(`/purchase-orders/${poId}/approve`, {
        delivery_status: deliveryStatus,
        expected_delivery_date: expectedDate || null,
      });
      onApproved();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to approve');
      setSaving(false);
    }
  };

  return (
    <Modal open title="Approve Purchase Order" onClose={onClose} size="sm">
      <div className="space-y-4">
        <p className="text-sm text-gray-600">Set the initial delivery status and expected delivery date for this PO.</p>

        <div>
          <label className="label">Initial Delivery Status *</label>
          <select className="input" value={deliveryStatus} onChange={e => setDeliveryStatus(e.target.value)}>
            {DELIVERY_STATUSES.map(d => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="label">Expected Delivery Date</label>
          <input type="date" className="input" value={expectedDate} onChange={e => setExpectedDate(e.target.value)} />
        </div>

        {deliveryStatus === 'qc_pending' && (
          <div className="p-3 bg-purple-50 border border-purple-200 rounded-lg text-purple-700 text-sm">
            ⚠️ <strong>QC Pending</strong>: QC manager will need to approve material before this PO can be marked as received.
          </div>
        )}

        {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

        <div className="flex gap-3 pt-2">
          <button className="btn-secondary flex-1" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary flex-1 bg-green-600 hover:bg-green-700 border-green-600" onClick={handleApprove} disabled={saving}>
            {saving ? <Loader2 size={14} className="animate-spin mr-1 inline" /> : <CheckCircle size={14} className="mr-1 inline" />}
            {saving ? 'Approving...' : 'Approve PO'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Material QC Section (for QC manager) ─────────────────────────────────────
function MaterialQCSection({ poId, onApproved }) {
  const [file, setFile] = useState(null);
  const [observations, setObservations] = useState('');
  const [result, setResult] = useState('accepted');
  const [rejectionReason, setRejectionReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (result === 'rejected' && !rejectionReason.trim()) {
      return setError('Rejection reason is required');
    }
    if (!window.confirm(`${result === 'accepted' ? 'Accept' : 'Reject'} material QC for this purchase order?`)) return;
    setSaving(true);
    setError('');
    const fd = new FormData();
    if (file) fd.append('report', file);
    fd.append('observations', observations);
    fd.append('result', result);
    if (result === 'rejected') fd.append('rejection_reason', rejectionReason);
    try {
      await api.post(`/purchase-orders/${poId}/material-qc`, fd);
      onApproved();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed');
      setSaving(false);
    }
  };

  return (
    <div>
      <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
        <Upload size={16} className="text-purple-600" />
        Material QC Required
      </h3>
      <p className="text-sm text-gray-600 mb-4">
        This PO is pending material quality check. Inspect the goods and submit your decision.
      </p>

      <div className="space-y-3">
        {/* Accept / Reject toggle */}
        <div>
          <label className="label">QC Result *</label>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setResult('accepted')}
              className={`flex-1 py-2 rounded-lg border text-sm font-medium flex items-center justify-center gap-2 transition-colors ${
                result === 'accepted'
                  ? 'bg-green-50 border-green-400 text-green-700'
                  : 'border-gray-200 text-gray-500 hover:border-gray-300'
              }`}
            >
              <CheckCircle size={15} /> Accept
            </button>
            <button
              type="button"
              onClick={() => setResult('rejected')}
              className={`flex-1 py-2 rounded-lg border text-sm font-medium flex items-center justify-center gap-2 transition-colors ${
                result === 'rejected'
                  ? 'bg-red-50 border-red-400 text-red-700'
                  : 'border-gray-200 text-gray-500 hover:border-gray-300'
              }`}
            >
              <XCircle size={15} /> Reject
            </button>
          </div>
        </div>

        {result === 'rejected' && (
          <div>
            <label className="label">Rejection Reason *</label>
            <textarea className="input resize-none" rows={3}
              placeholder="Describe the reason for rejection..."
              value={rejectionReason}
              onChange={e => setRejectionReason(e.target.value)} />
          </div>
        )}

        <div>
          <label className="label">QC Report (PDF or image, optional)</label>
          <label className="flex items-center gap-2 cursor-pointer border border-gray-300 rounded-lg px-3 py-2 hover:border-brand-400 transition-colors">
            <Upload size={15} className="text-gray-400" />
            <span className="text-sm text-gray-600 flex-1 truncate">
              {file ? file.name : 'Click to choose file...'}
            </span>
            <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" className="hidden"
              onChange={e => setFile(e.target.files[0] || null)} />
          </label>
        </div>

        <div>
          <label className="label">Observations</label>
          <textarea className="input resize-none" rows={2}
            placeholder="Material inspection notes..."
            value={observations}
            onChange={e => setObservations(e.target.value)} />
        </div>

        {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

        <div className="flex justify-end">
          <button
            className={`btn-primary flex items-center gap-2 ${
              result === 'rejected'
                ? 'bg-red-600 hover:bg-red-700 border-red-600'
                : 'bg-purple-600 hover:bg-purple-700 border-purple-600'
            }`}
            onClick={handleSubmit}
            disabled={saving}
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : result === 'accepted' ? <CheckCircle size={14} /> : <XCircle size={14} />}
            {saving ? 'Submitting...' : result === 'accepted' ? 'Accept Material' : 'Reject Material'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── PO Chat Panel ─────────────────────────────────────────────────────────────
function POChatPanel({ poId, currentUser }) {
  const [messages, setMessages] = useState([]);
  const [newMsg, setNewMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef(null);

  const loadMessages = async () => {
    try {
      const r = await api.get(`/purchase-orders/${poId}/messages`);
      setMessages(Array.isArray(r.data) ? r.data : []);
    } catch {
      setMessages([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadMessages(); }, [poId]);

  useEffect(() => {
    if (!loading) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const sendMessage = async () => {
    if (!newMsg.trim() || sending) return;
    setSending(true);
    try {
      await api.post(`/purchase-orders/${poId}/messages`, { message: newMsg });
      setNewMsg('');
      await loadMessages();
    } finally {
      setSending(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  return (
    <div className="flex flex-col" style={{ height: '400px' }}>
      <div className="px-4 py-2.5 border-b border-gray-50 flex items-center justify-between">
        <span className="text-xs text-gray-400 font-medium uppercase tracking-wide">
          {messages.length} message{messages.length !== 1 ? 's' : ''}
        </span>
        <button onClick={loadMessages} className="text-gray-400 hover:text-gray-600 transition-colors" title="Refresh">
          <RefreshCw size={13} />
        </button>
      </div>

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
            const isMe = msg.user_id === currentUser?.id;
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
                    isMe ? 'bg-brand-600 text-white rounded-tr-sm' : 'bg-gray-100 text-gray-800 rounded-tl-sm'
                  }`}>
                    {msg.message}
                  </div>
                  <span className="text-xs text-gray-300">{fmtDateTime(msg.created_at)}</span>
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-gray-100 p-3 flex gap-2 items-end">
        <textarea
          className="input flex-1 resize-none text-sm py-2 leading-snug"
          placeholder="Type a message… (Enter to send)"
          value={newMsg}
          onChange={e => setNewMsg(e.target.value)}
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
