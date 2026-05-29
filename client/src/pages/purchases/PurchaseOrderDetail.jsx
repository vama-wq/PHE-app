import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import { fmtDate, fmtDateTime, ROLE_COLORS, ROLE_LABELS } from '../../lib/utils';
import Modal from '../../components/ui/Modal';
import {
  ArrowLeft, Printer, Send, CheckCircle, XCircle,
  PackageCheck, Pencil, Loader2, Truck, Upload, FileText,
  ExternalLink, RefreshCw, MessageSquare, Trash2
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
];
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
          {['draft', 'rejected'].includes(po.status) && canManagePO && (
            <button className="btn-primary btn-sm flex items-center gap-1.5" disabled={!!acting}
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
          {po.status === 'approved' && canManagePO && !isQCPending && (
            <button className="btn-primary btn-sm flex items-center gap-1.5 bg-teal-600 hover:bg-teal-700 border-teal-600" disabled={!!acting}
              onClick={() => act('receive', 'Mark as Received')}>
              {acting ? <Loader2 size={13} className="animate-spin" /> : <PackageCheck size={13} />}
              Mark as Received
            </button>
          )}
          {po.status === 'approved' && isQCPending && (
            <span className="text-xs bg-purple-100 text-purple-700 px-3 py-1.5 rounded-full font-medium">
              ⏳ Awaiting Material QC
            </span>
          )}
          <button className="btn-secondary btn-sm flex items-center gap-1.5" onClick={() => window.print()}>
            <Printer size={13} /> Print / PDF
          </button>
        </div>
      </div>

      {/* ── Delivery Status panel (approved POs, purchase managers, screen only) ── */}
      {po.status === 'approved' && canManagePO && (
        <div className="card p-5 mb-5 no-print">
          <h3 className="font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <Truck size={16} className="text-brand-600" />
            Delivery Status
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
            <div>
              <label className="label">Status</label>
              <select className="input" value={newDeliveryStatus} onChange={e => setNewDeliveryStatus(e.target.value)}>
                <option value="">— Select status —</option>
                {DELIVERY_STATUSES.map(d => (
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
          {newDeliveryStatus === 'qc_pending' && (
            <div className="mt-3 p-3 bg-purple-50 border border-purple-200 rounded-lg text-purple-700 text-sm">
              ⚠️ Setting status to <strong>QC Pending</strong> will require the QC manager to approve the material before the PO can be marked as received.
            </div>
          )}
        </div>
      )}

      {/* ── Material QC panel (when delivery_status = qc_pending, screen only) ── */}
      {isQCPending && (
        <div className="card p-5 mb-5 no-print border-purple-200">
          {materialQCDone ? (
            <div className="flex items-center gap-3">
              <CheckCircle size={20} className="text-green-600" />
              <div>
                <div className="font-semibold text-gray-900">Material QC Approved</div>
                <div className="text-sm text-gray-500">
                  By {po.material_qc.created_by_name} · {fmtDate(po.material_qc.created_at)}
                  {po.material_qc.observations && <span> · {po.material_qc.observations}</span>}
                </div>
                {po.material_qc.file_name && (
                  <a href={`/uploads/purchase-qc/${po.material_qc.file_name}`} target="_blank" rel="noopener noreferrer"
                    className="text-brand-600 text-sm hover:underline flex items-center gap-1 mt-1">
                    <ExternalLink size={12} /> View Report
                  </a>
                )}
              </div>
            </div>
          ) : canQC ? (
            <MaterialQCSection poId={id} onApproved={load} />
          ) : (
            <div className="text-center text-gray-500 py-4">
              <div className="font-medium">Material QC Pending</div>
              <p className="text-sm mt-1">Waiting for the QC manager to inspect and approve this material.</p>
            </div>
          )}
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
                  href={`/uploads/item-drawings/${item.drawing_file}`}
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
