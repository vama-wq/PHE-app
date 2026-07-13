import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import StatusBadge from '../../components/ui/StatusBadge';
import Modal from '../../components/ui/Modal';
import InventoryEditModal from '../../components/InventoryEditModal';
import { fmtDate, fmtDateTime, daysUntil } from '../../lib/utils';
import { downloadExcel } from '../../lib/utils';
import {
  FlaskConical, CheckCircle, XCircle, Upload, FileText,
  ExternalLink, AlertTriangle, ChevronDown, ChevronUp, Download,
  Package, Loader2, RotateCcw
} from 'lucide-react';

export default function QCDashboard() {
  const { user } = useAuthStore();
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reportModal, setReportModal] = useState(null); // card to upload report for
  const [rejectModal, setRejectModal] = useState(null); // card to reject
  const [approveModal, setApproveModal] = useState(null); // card to approve (destination modal)
  const [expandedId, setExpandedId] = useState(null);

  // Purchase material QC
  const [materialPOs, setMaterialPOs] = useState([]);
  const [materialQCModal, setMaterialQCModal] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [qcRes, matRes] = await Promise.all([
        api.get('/qc'),
        api.get('/purchase-orders/pending-material-qc'),
      ]);
      setCards(qcRes.data);
      setMaterialPOs(matRes.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleApprove = (card) => {
    // Always show the destination modal — ask where the heaters are going
    setApproveModal(card);
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <FlaskConical size={24} className="text-purple-600" />
            Quality Check
          </h1>
          <p className="text-gray-500 text-sm mt-0.5">
            Job cards awaiting QC approval · {cards.length} pending
            {materialPOs.length > 0 && <span className="ml-2 text-purple-600">· {materialPOs.length} material QC pending</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary flex items-center gap-1.5 text-sm"
            onClick={() => downloadExcel('qc-reports', 'qc_reports.xlsx')}>
            <Download size={15} /> Export QC Reports
          </button>
        </div>
      </div>

      {/* ── Purchase Material QC Section ── */}
      {materialPOs.length > 0 && (
        <div className="mb-6">
          <h2 className="font-semibold text-gray-800 text-sm mb-3 flex items-center gap-2">
            <Package size={15} className="text-purple-500" />
            Purchase Material QC Pending ({materialPOs.length})
          </h2>
          <div className="space-y-2">
            {materialPOs.map(po => (
              <div key={po.id} className="card border-l-4 border-l-purple-400 p-4">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-bold text-gray-900">{po.po_number}</span>
                      <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-medium">QC Pending</span>
                    </div>
                    <div className="text-sm text-gray-600">
                      {po.supplier_name && <>Supplier: <span className="font-medium">{po.supplier_name}</span></>}
                      {po.item_count != null && <span className="text-gray-400">{po.item_count} item{po.item_count !== 1 ? 's' : ''} to inspect</span>}
                      {po.expected_delivery_date && (
                        <span className="text-gray-400 ml-2">· Expected: {fmtDate(po.expected_delivery_date)}</span>
                      )}
                    </div>
                    {po.created_by_name && <div className="text-xs text-gray-400 mt-0.5">Created by {po.created_by_name} · {fmtDate(po.created_at)}</div>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Link
                      to={`/purchases/${po.id}`}
                      className="btn-primary btn-sm flex items-center gap-1.5 bg-purple-600 hover:bg-purple-700 border-purple-600"
                    >
                      <CheckCircle size={13} /> Inspect & QC items
                    </Link>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <hr className="my-6 border-gray-200" />
        </div>
      )}

      {loading ? (
        <div className="text-center text-gray-400 py-16">Loading...</div>
      ) : cards.length === 0 ? (
        <div className="text-center py-16">
          <CheckCircle size={48} className="mx-auto mb-3 text-green-200" />
          <p className="text-gray-500 font-medium">No job cards pending QC.</p>
          <p className="text-gray-400 text-sm mt-1">All clear!</p>
        </div>
      ) : (
        <div className="space-y-3">
          {cards.map(jc => {
            const days = daysUntil(jc.dispatch_date);
            const isOverdue = days < 0;
            const isUrgent  = days >= 0 && days <= 3;
            const isExpanded = expandedId === jc.id;
            return (
              <div key={jc.id} className={`card border-l-4 ${
                isOverdue ? 'border-l-red-500' : isUrgent ? 'border-l-orange-400' : 'border-l-purple-400'
              }`}>
                {/* Customer Query Return Warning — Detailed */}
                {jc.return_query_no && (
                  <div className="px-5 pt-4 pb-0">
                    <div className="bg-amber-50 border border-amber-300 rounded-xl overflow-hidden">
                      <div className="px-4 py-2 bg-amber-100/60 border-b border-amber-200 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <RotateCcw size={14} className="text-amber-700" />
                          <span className="text-sm font-bold text-amber-900">Returned Product — Customer Query</span>
                          {jc.return_query_priority && (
                            <span className={`text-xs px-1.5 py-0.5 rounded-full font-semibold uppercase ${
                              jc.return_query_priority === 'critical' ? 'bg-red-100 text-red-700' :
                              jc.return_query_priority === 'high' ? 'bg-orange-100 text-orange-700' :
                              'bg-yellow-100 text-yellow-700'
                            }`}>{jc.return_query_priority}</span>
                          )}
                        </div>
                        <Link to={`/customer-queries/${jc.return_query_id}`}
                          className="text-xs text-amber-800 font-medium hover:underline">View Query →</Link>
                      </div>
                      <div className="p-4">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                          <div>
                            <dt className="text-xs text-amber-600 font-medium">Query No</dt>
                            <dd className="text-sm font-bold text-amber-900">{jc.return_query_no}</dd>
                          </div>
                          <div>
                            <dt className="text-xs text-amber-600 font-medium">Job Card</dt>
                            <dd className="text-sm font-semibold text-gray-900">{jc.job_card_no}</dd>
                          </div>
                          <div>
                            <dt className="text-xs text-amber-600 font-medium">Order</dt>
                            <dd className="text-sm font-semibold text-gray-900">
                              <Link to={`/orders/${jc.order_id}`} className="text-brand-600 hover:underline">{jc.order_code}</Link>
                            </dd>
                          </div>
                          <div>
                            <dt className="text-xs text-amber-600 font-medium">Customer</dt>
                            <dd className="text-sm font-semibold text-gray-900">{jc.customer_code}</dd>
                          </div>
                          {jc.return_query_category && (
                            <div>
                              <dt className="text-xs text-amber-600 font-medium">Category</dt>
                              <dd className="text-sm text-gray-800 capitalize">{jc.return_query_category}</dd>
                            </div>
                          )}
                          <div>
                            <dt className="text-xs text-amber-600 font-medium">Return Type</dt>
                            <dd className="text-sm font-semibold text-gray-800 capitalize">
                              {jc.return_query_type === 'debit_note' ? 'Debit Note' : jc.return_query_type || '—'}
                            </dd>
                          </div>
                          {jc.return_query_return_status && (
                            <div>
                              <dt className="text-xs text-amber-600 font-medium">Return Status</dt>
                              <dd className="text-sm text-gray-800 capitalize">{jc.return_query_return_status.replace(/_/g, ' ')}</dd>
                            </div>
                          )}
                          <div>
                            <dt className="text-xs text-amber-600 font-medium">Qty</dt>
                            <dd className="text-sm text-gray-800">{jc.qty} Nos</dd>
                          </div>
                        </div>
                        {jc.return_query_subject && (
                          <div className="mb-2">
                            <dt className="text-xs text-amber-600 font-medium mb-0.5">Subject</dt>
                            <dd className="text-sm font-semibold text-gray-900">{jc.return_query_subject}</dd>
                          </div>
                        )}
                        {jc.return_query_description && (
                          <div className="mb-2">
                            <dt className="text-xs text-amber-600 font-medium mb-0.5">Description</dt>
                            <dd className="text-xs text-gray-700 bg-amber-100/40 rounded p-2">{jc.return_query_description}</dd>
                          </div>
                        )}
                        <div className="text-xs text-amber-700 bg-amber-100/60 rounded p-2 mt-2">
                          {jc.return_query_type === 'debit_note' && 'Debit note return — inspect and submit QC result.'}
                          {jc.return_query_type === 'repair' && 'Repair return — product needs re-inspection after repair.'}
                          {!jc.return_query_type && 'Returned product — inspect and submit QC result.'}
                        </div>
                        {(jc.return_coupon_no || jc.return_debit_note_no) && (
                          <div className="flex flex-wrap gap-3 pt-2 border-t border-amber-200 mt-2">
                            {jc.return_coupon_no && (
                              <span className="text-xs text-amber-800">Coupon No: <strong>{jc.return_coupon_no}</strong></span>
                            )}
                            {jc.return_debit_note_no && (
                              <span className="text-xs text-amber-800">Debit Note No: <strong>{jc.return_debit_note_no}</strong></span>
                            )}
                          </div>
                        )}
                        {jc.return_query_created_at && (
                          <div className="text-xs text-amber-600 mt-2 pt-2 border-t border-amber-200">
                            Query raised on {fmtDateTime(jc.return_query_created_at)}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Card header */}
                <div className="p-5">
                  <div className="flex items-start gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="font-bold text-gray-900 text-base">{jc.job_card_no}</span>
                        <StatusBadge status={jc.status} />
                        {isOverdue && (
                          <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium flex items-center gap-1">
                            <AlertTriangle size={11} /> Overdue
                          </span>
                        )}
                        {jc.return_query_no && (
                          <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium flex items-center gap-1">
                            <RotateCcw size={11} /> Customer Return
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-gray-600 mb-1">
                        <Link to={`/orders/${jc.order_id}`} className="text-brand-600 hover:underline font-medium">
                          {jc.order_code}
                        </Link>
                        {' · '}{jc.customer_code}
                        {jc.qty && (
                          <span className="text-gray-400">
                            {' · '}Qty: {jc.qty}
                            {jc.net_qty != null && jc.net_qty < jc.qty && (
                              <span className="ml-1 text-orange-600 font-medium">
                                → {jc.net_qty} dispatchable ⚠️
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                      <div className={`text-sm font-medium ${isOverdue ? 'text-red-600' : isUrgent ? 'text-orange-500' : 'text-gray-500'}`}>
                        {isOverdue
                          ? `⚠️ ${Math.abs(days)}d overdue · Dispatch was ${fmtDate(jc.dispatch_date)}`
                          : days === 0
                            ? `🔔 Dispatch today — ${fmtDate(jc.dispatch_date)}`
                            : `Dispatch: ${fmtDate(jc.dispatch_date)} (${days}d left)`}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
                      {jc.file_name && (
                        <a href={`/uploads/job-cards/${jc.file_name}`} target="_blank" rel="noopener noreferrer"
                          className="btn-secondary btn-sm flex items-center gap-1">
                          <ExternalLink size={13} /> Job Card
                        </a>
                      )}
                      <button
                        className="btn-secondary btn-sm flex items-center gap-1"
                        onClick={() => setExpandedId(isExpanded ? null : jc.id)}
                      >
                        <FileText size={13} />
                        Reports {jc.report_count > 0 ? `(${jc.report_count})` : ''}
                        {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                      </button>
                      <button
                        className="btn-secondary btn-sm flex items-center gap-1 text-brand-600"
                        onClick={() => setReportModal(jc)}
                      >
                        <Upload size={13} /> Upload Report
                      </button>
                      <button
                        className="btn-primary btn-sm flex items-center gap-1 bg-green-600 hover:bg-green-700 border-green-600"
                        onClick={() => handleApprove(jc)}
                        disabled={jc.report_count === 0}
                        title={jc.report_count === 0 ? 'Upload QC report before approving' : 'Approve QC'}
                      >
                        <CheckCircle size={13} /> Approve
                      </button>
                      <button
                        className="btn-secondary btn-sm flex items-center gap-1 text-red-600 border-red-200 hover:bg-red-50"
                        onClick={() => setRejectModal(jc)}
                      >
                        <XCircle size={13} /> Reject
                      </button>
                    </div>
                  </div>
                </div>

                {/* Expanded: QC reports list */}
                {isExpanded && (
                  <ReportsSection cardId={jc.id} />
                )}
              </div>
            );
          })}
        </div>
      )}

      {reportModal && (
        <UploadReportModal
          card={reportModal}
          onClose={() => setReportModal(null)}
          onSaved={() => { setReportModal(null); load(); }}
        />
      )}

      {rejectModal && (
        <RejectModal
          card={rejectModal}
          onClose={() => setRejectModal(null)}
          onSaved={() => { setRejectModal(null); load(); }}
        />
      )}

      {materialQCModal && (
        <MaterialQCModal
          po={materialQCModal}
          onClose={() => setMaterialQCModal(null)}
          onSaved={() => { setMaterialQCModal(null); load(); }}
        />
      )}

      {approveModal && (
        <ApproveDestinationModal
          card={approveModal}
          onClose={() => setApproveModal(null)}
          onSaved={() => { setApproveModal(null); load(); }}
        />
      )}

    </div>
  );
}

// ── Reports list for a card ───────────────────────────────────────────────────
function ReportsSection({ cardId }) {
  const [reports, setReports] = useState(null);

  useEffect(() => {
    api.get(`/qc/${cardId}/reports`).then(r => setReports(r.data));
  }, [cardId]);

  if (!reports) return (
    <div className="px-5 pb-4 text-sm text-gray-400 border-t border-gray-100 pt-3">Loading reports...</div>
  );

  if (reports.length === 0) return (
    <div className="px-5 pb-4 text-sm text-gray-400 border-t border-gray-100 pt-3">
      No QC reports uploaded yet.
    </div>
  );

  return (
    <div className="px-5 pb-4 border-t border-gray-100 pt-3 space-y-2">
      {reports.map(r => (
        <div key={r.id} className="flex items-center gap-3 p-2.5 bg-purple-50 rounded-lg border border-purple-100">
          <FileText size={16} className="text-purple-500 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-gray-800 truncate">
              {r.file_name || 'Report'}
            </div>
            <div className="text-xs text-gray-500">
              {fmtDateTime(r.created_at)} · by {r.created_by_name}
            </div>
            {r.observations && (
              <div className="text-xs text-gray-600 mt-0.5 truncate">{r.observations}</div>
            )}
          </div>
          {r.file_name && (
            <a href={`/uploads/qc/${r.file_name}`} target="_blank" rel="noopener noreferrer"
              className="btn-secondary btn-sm text-xs flex items-center gap-1">
              <ExternalLink size={12} /> View
            </a>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Upload Report Modal ───────────────────────────────────────────────────────
function UploadReportModal({ card, onClose, onSaved }) {
  const [file, setFile] = useState(null);
  const [observations, setObservations] = useState('');
  const [correctiveAction, setCorrectiveAction] = useState('');
  const [productWeight, setProductWeight] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!productWeight || isNaN(Number(productWeight))) {
      return setError('Weight of 1 product is required');
    }
    setSaving(true);
    setError('');
    const fd = new FormData();
    if (file) fd.append('file', file);
    fd.append('observations', observations);
    fd.append('corrective_action', correctiveAction);
    fd.append('product_weight', productWeight);
    try {
      await api.post(`/qc/${card.id}/report`, fd);
      onSaved();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to upload report');
      setSaving(false);
    }
  };

  return (
    <Modal open title={`Upload QC Report — ${card.job_card_no}`} onClose={onClose} size="md">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Report File <span className="text-gray-400 font-normal text-xs">(PDF or image, optional)</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer border border-gray-300 rounded-lg px-3 py-2 hover:border-brand-400 transition-colors">
            <Upload size={16} className="text-gray-400" />
            <span className="text-sm text-gray-600 flex-1 truncate">
              {file ? file.name : 'Click to choose file...'}
            </span>
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp"
              className="hidden"
              onChange={e => setFile(e.target.files[0] || null)}
            />
          </label>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Weight of 1 Product (kg) <span className="text-red-500">*</span>
          </label>
          <input
            className="input w-full"
            type="number"
            step="0.001"
            min="0"
            placeholder="e.g. 0.250"
            value={productWeight}
            onChange={e => setProductWeight(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Observations</label>
          <textarea
            className="input w-full resize-none"
            rows={3}
            placeholder="Inspection observations..."
            value={observations}
            onChange={e => setObservations(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Corrective Action</label>
          <textarea
            className="input w-full resize-none"
            rows={2}
            placeholder="Any corrective actions taken..."
            value={correctiveAction}
            onChange={e => setCorrectiveAction(e.target.value)}
          />
        </div>

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button className="btn-ghost text-gray-500" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} disabled={saving}>
            {saving ? 'Uploading...' : 'Upload Report'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Reject Modal ──────────────────────────────────────────────────────────────
function RejectModal({ card, onClose, onSaved }) {
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleReject = async () => {
    setSaving(true);
    setError('');
    try {
      await api.put(`/qc/${card.id}/reject`, { notes });
      onSaved();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to reject');
      setSaving(false);
    }
  };

  return (
    <Modal open title={`QC Reject — ${card.job_card_no}`} onClose={onClose} size="sm">
      <p className="text-sm text-gray-600 mb-4">
        This job card will be sent back to production for rework.
      </p>
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-1">Rejection Notes</label>
        <textarea
          className="input w-full resize-none"
          rows={3}
          placeholder="Describe what needs to be fixed..."
          value={notes}
          onChange={e => setNotes(e.target.value)}
          autoFocus
        />
      </div>
      {error && (
        <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}
      <div className="flex justify-end gap-3">
        <button className="btn-ghost text-gray-500" onClick={onClose}>Cancel</button>
        <button
          className="btn-primary bg-red-600 hover:bg-red-700 border-red-600"
          onClick={handleReject} disabled={saving}
        >
          {saving ? 'Rejecting...' : 'Reject & Return to Production'}
        </button>
      </div>
    </Modal>
  );
}

// ── Material QC Modal (for purchase orders) ───────────────────────────────────
function MaterialQCModal({ po, onClose, onSaved }) {
  const [file, setFile] = useState(null);
  const [observations, setObservations] = useState('');
  const [result, setResult] = useState('accepted'); // 'accepted' | 'rejected'
  const [rejectionReason, setRejectionReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (result === 'rejected' && !rejectionReason.trim()) {
      return setError('Rejection reason is required');
    }
    setSaving(true);
    setError('');
    const fd = new FormData();
    if (file) fd.append('report', file);
    fd.append('observations', observations);
    fd.append('result', result);
    if (result === 'rejected') fd.append('rejection_reason', rejectionReason);
    try {
      await api.post(`/purchase-orders/${po.id}/material-qc`, fd);
      onSaved();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to submit material QC');
      setSaving(false);
    }
  };

  return (
    <Modal open title={`Material QC — ${po.po_number}`} onClose={onClose} size="md">
      <div className="space-y-4">
        <div className="p-3 bg-purple-50 border border-purple-100 rounded-lg text-sm text-gray-700">
          <strong>Supplier:</strong> {po.supplier_name}
        </div>

        {/* Accept / Reject toggle */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">QC Result <span className="text-red-500">*</span></label>
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
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Rejection Reason <span className="text-red-500">*</span>
            </label>
            <textarea
              className="input w-full resize-none"
              rows={3}
              placeholder="Describe the reason for rejection..."
              value={rejectionReason}
              onChange={e => setRejectionReason(e.target.value)}
              autoFocus
            />
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            QC Report <span className="text-gray-400 font-normal text-xs">(PDF or image, optional)</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer border border-gray-300 rounded-lg px-3 py-2 hover:border-brand-400 transition-colors">
            <Upload size={16} className="text-gray-400" />
            <span className="text-sm text-gray-600 flex-1 truncate">
              {file ? file.name : 'Click to choose file...'}
            </span>
            <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" className="hidden"
              onChange={e => setFile(e.target.files[0] || null)} />
          </label>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Observations</label>
          <textarea
            className="input w-full resize-none"
            rows={2}
            placeholder="Material inspection notes..."
            value={observations}
            onChange={e => setObservations(e.target.value)}
          />
        </div>

        {result === 'accepted' && (
          <p className="text-xs text-gray-500">
            Accepting will set delivery status to <strong>Purchase Accepted</strong> and allow the PO to be marked as received.
          </p>
        )}
        {result === 'rejected' && (
          <p className="text-xs text-red-500">
            Rejecting will mark this PO as <strong>Material Rejected</strong>. Inventory will not be updated.
          </p>
        )}

        {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

        <div className="flex justify-end gap-3 pt-2">
          <button className="btn-ghost text-gray-500" onClick={onClose} disabled={saving}>Cancel</button>
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
    </Modal>
  );
}

// ── Approve Destination Modal (all order types) ───────────────────────────────
function ApproveDestinationModal({ card, onClose, onSaved }) {
  // Default destination based on order type
  const defaultDest = () => {
    if (card.order_type === 'finished_goods') return 'dispatch'; // FG inventory cards always dispatch
    if (card.order_type === 'inventory_order') return 'finished_goods';
    if (card.order_type === 'io_export_he' || card.order_type === 'io_local_he') return 'both';
    return 'dispatch'; // local_he, export_he, etc.
  };

  const [destination, setDestination] = useState(defaultDest);
  const [fgQty,        setFgQty]       = useState('');
  const [dispatchQty,  setDispatchQty] = useState('');
  const [qcPhoto,      setQcPhoto]     = useState(null); // required image of approved material
  const [saving,       setSaving]      = useState(false);
  const [error,        setError]       = useState('');
  const [bom,          setBom]         = useState(null); // inventory the item consumes
  const [showInvEdit,  setShowInvEdit] = useState(false);
  const [fgLocation,   setFgLocation]  = useState('');   // storage location for FG intake
  const [locations,    setLocations]   = useState([]);
  const [remakeExtras, setRemakeExtras] = useState({});  // inventory_item_id -> extra qty for remade pcs

  const loadBom = () => api.get(`/qc/${card.id}/bom`).then(r => setBom(r.data)).catch(() => setBom(null));
  useEffect(() => { loadBom(); }, [card.id]);
  useEffect(() => { api.get('/finished-goods/locations').then(r => setLocations(r.data.filter(l => l.active))).catch(() => {}); }, []);

  const handleSubmit = async () => {
    setError('');
    if (!qcPhoto) return setError('A photo of the approved material is required');
    if (destination === 'finished_goods' && (!fgQty || parseInt(fgQty) <= 0))
      return setError('Finished Goods quantity is required');
    if (destination === 'both') {
      if (!fgQty || parseInt(fgQty) <= 0) return setError('Finished Goods quantity is required');
      if (!dispatchQty || parseInt(dispatchQty) <= 0) return setError('Dispatch quantity is required');
    }
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('file', qcPhoto);  // field name 'file' matches uploadChecklistPhoto middleware
      fd.append('heater_destination', destination);
      if (destination === 'finished_goods' || destination === 'both') fd.append('io_qty', parseInt(fgQty));
      if (destination === 'both') fd.append('dispatch_qty', parseInt(dispatchQty));
      if ((destination === 'finished_goods' || destination === 'both') && fgLocation) fd.append('fg_location', fgLocation);
      const extras = Object.entries(remakeExtras)
        .map(([id, q]) => ({ inventory_item_id: parseInt(id), qty: parseFloat(q) }))
        .filter(x => x.qty > 0);
      if (extras.length) fd.append('remake_extras', JSON.stringify(extras));
      await api.put(`/qc/${card.id}/approve`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      onSaved();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to approve');
      setSaving(false);
    }
  };

  const destinations = [
    { key: 'dispatch',       label: '🚚 Dispatch',       desc: 'Heaters go directly to customer dispatch' },
    { key: 'finished_goods', label: '📦 Finished Goods', desc: 'Heaters go to the Finished Goods store' },
    { key: 'both',           label: '↕️ Both',            desc: 'Split — some to Finished Goods, some to Dispatch' },
  ];

  return (
    <>
    <Modal open title="QC Approval — Where are these heaters going?" onClose={onClose} size="sm">
      <div className="space-y-4">
        {/* Job card info + qty summary */}
        <div className={`border rounded-lg p-3 text-sm ${card.net_qty < card.qty ? 'bg-orange-50 border-orange-200' : 'bg-green-50 border-green-100'}`}>
          <p className={`font-semibold ${card.net_qty < card.qty ? 'text-orange-800' : 'text-green-800'}`}>{card.job_card_no} · {card.order_code}</p>
          <p className={`mt-0.5 ${card.net_qty < card.qty ? 'text-orange-700' : 'text-green-700'}`}>{card.customer_code}</p>
          <div className={`mt-2 pt-2 border-t space-y-1 ${card.net_qty < card.qty ? 'border-orange-200' : 'border-green-200'}`}>
            <div className="flex justify-between text-xs">
              <span className="text-gray-600">Original Qty</span>
              <span className="font-medium">{card.qty} pcs</span>
            </div>
            {(card.total_rejected > 0) && (
              <div className="flex justify-between text-xs text-red-600">
                <span>Rejections</span>
                <span className="font-medium">− {card.total_rejected} pcs</span>
              </div>
            )}
            {(card.total_remade > 0) && (
              <div className="flex justify-between text-xs text-green-600">
                <span>Remade</span>
                <span className="font-medium">+ {card.total_remade} pcs</span>
              </div>
            )}
            <div className={`flex justify-between text-xs font-semibold border-t pt-1 ${card.net_qty < card.qty ? 'border-orange-200 text-orange-700' : 'border-green-200 text-green-700'}`}>
              <span>Final Dispatchable Qty</span>
              <span>{card.net_qty ?? card.qty} pcs</span>
            </div>
          </div>
          {card.net_qty < card.qty && (
            <p className="text-xs text-orange-600 mt-1.5">⚠️ Qty is short by {card.qty - card.net_qty} piece{card.qty - card.net_qty !== 1 ? 's' : ''} due to production rejections.</p>
          )}
        </div>

        {/* Inventory (BOM) review — confirm or edit before approving */}
        <div className="border border-gray-200 rounded-lg p-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
              <Package size={14} className="text-brand-500" /> Inventory to consume
            </span>
            {/* Always allow adding inventory when nothing is selected yet — the "already
                deducted" lock only makes sense once there's a real BOM to protect. */}
            {bom?.item_id && (bom.inventory_items.length === 0 || !bom?.deducted) && (
              <button type="button" className="text-xs text-brand-600 hover:underline"
                onClick={() => setShowInvEdit(true)}>Edit inventory</button>
            )}
          </div>
          {!bom ? (
            <p className="text-xs text-gray-400">Loading inventory…</p>
          ) : bom.inventory_items.length === 0 ? (
            <p className="text-xs text-orange-600">No inventory selected for this item. Use "Edit inventory" to add it before approving.</p>
          ) : (
            <ul className="space-y-1">
              {bom.inventory_items.map(i => (
                <li key={i.id} className="flex justify-between text-xs text-gray-700">
                  <span><span className="font-mono">{i.item_code}</span> — {i.name}</span>
                  <span className="font-medium">
                    {i.qty} {i.unit}
                    {Number(i.qty_deducted) > 0 && Number(i.qty_deducted) < Number(i.qty) && (
                      <span className="text-gray-400 font-normal"> ({i.qty_deducted} deducted at stage)</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {bom && bom.inventory_items.length > 0 && (
            <p className="text-[11px] mt-2 pt-2 border-t border-gray-100 text-gray-500">
              {bom.deducted
                ? '✓ Inventory already deducted for this item.'
                : bom.is_split
                  ? 'Partially dispatched — inventory deducts once the whole qty is dispatched.'
                  : 'Approving will deduct the remaining inventory from stock.'}
            </p>
          )}
        </div>

        {/* Remade qty — extra inventory consumed (if any) */}
        {bom?.inventory_items?.length > 0 && (
          <div className="border border-amber-200 bg-amber-50/40 rounded-lg p-3">
            <span className="text-sm font-medium text-gray-700">Remade pieces — extra inventory used <span className="text-gray-400 font-normal">(if any)</span></span>
            <p className="text-[11px] text-gray-500 mt-0.5 mb-2">If pieces were remade, enter the additional inventory consumed. It deducts on approval, on top of the BOM.</p>
            <ul className="space-y-1.5">
              {bom.inventory_items.map(i => (
                <li key={i.id} className="flex items-center justify-between gap-2 text-xs text-gray-700">
                  <span className="truncate"><span className="font-mono">{i.item_code}</span> — {i.name}</span>
                  <span className="flex items-center gap-1 flex-shrink-0">
                    <input type="number" min="0" step="any" placeholder="0"
                      className="input w-20 text-xs py-1 text-right"
                      value={remakeExtras[i.id] || ''}
                      onChange={e => setRemakeExtras(p => ({ ...p, [i.id]: e.target.value }))} />
                    <span className="text-gray-400 w-8">{i.unit}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Destination selector — FG-order inventory cards always go to dispatch */}
        {card.order_type !== 'finished_goods' && <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Heater Destination <span className="text-red-500">*</span>
          </label>
          <div className="space-y-2">
            {destinations.map(d => (
              <button
                key={d.key}
                type="button"
                onClick={() => setDestination(d.key)}
                className={`w-full flex items-start gap-3 px-4 py-3 rounded-xl border-2 text-left transition-colors ${
                  destination === d.key
                    ? 'bg-brand-50 border-brand-500'
                    : 'border-gray-200 hover:border-brand-300'
                }`}
              >
                <div className={`w-4 h-4 rounded-full border-2 mt-0.5 flex-shrink-0 ${
                  destination === d.key ? 'border-brand-600 bg-brand-600' : 'border-gray-300'
                }`} />
                <div>
                  <div className={`text-sm font-semibold ${destination === d.key ? 'text-brand-700' : 'text-gray-700'}`}>
                    {d.label}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">{d.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </div>}

        {/* Qty inputs for FG / Both */}
        {(destination === 'finished_goods' || destination === 'both') && (
          <>
            <div>
              <label className="label">Qty → Finished Goods <span className="text-red-500">*</span></label>
              <input className="input" type="number" min="1"
                value={fgQty} onChange={e => setFgQty(e.target.value)}
                placeholder={`Dispatchable: ${card.net_qty ?? card.qty} pcs`} />
            </div>
            <div>
              <label className="label">Storage Location <span className="text-xs text-gray-400 font-normal">(optional)</span></label>
              <select className="input" value={fgLocation} onChange={e => setFgLocation(e.target.value)}>
                <option value="">— Where is it stored? —</option>
                {locations.map(l => <option key={l.id} value={l.name}>{l.name}</option>)}
              </select>
              {locations.length === 0 && <p className="text-xs text-gray-400 mt-1">No locations set up yet (add them under Finished Goods).</p>}
            </div>
          </>
        )}
        {destination === 'both' && (
          <div>
            <label className="label">Qty → Dispatch <span className="text-red-500">*</span></label>
            <input className="input" type="number" min="1"
              value={dispatchQty} onChange={e => setDispatchQty(e.target.value)}
              placeholder={`Remaining after Finished Goods`} />
          </div>
        )}

        {/* Required material photo */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Material Photo <span className="text-red-500">*</span>
            <span className="text-xs text-gray-400 font-normal ml-1">(photo of approved heaters)</span>
          </label>
          {qcPhoto ? (
            <div className="flex items-center gap-3">
              <img src={URL.createObjectURL(qcPhoto)} alt="QC"
                className="w-16 h-16 object-cover rounded-lg border-2 border-green-300" />
              <div>
                <p className="text-xs font-medium text-green-700">{qcPhoto.name}</p>
                <button className="text-xs text-red-500 hover:underline mt-0.5"
                  onClick={() => setQcPhoto(null)}>Remove</button>
              </div>
            </div>
          ) : (
            <label className="flex items-center gap-2 cursor-pointer border-2 border-dashed border-gray-300 rounded-xl px-4 py-3 hover:border-brand-400 transition-colors">
              <Upload size={16} className="text-gray-400" />
              <span className="text-sm text-gray-500">Click to upload photo</span>
              <input type="file" accept=".jpg,.jpeg,.png,.webp" className="hidden"
                onChange={e => setQcPhoto(e.target.files[0] || null)} />
            </label>
          )}
        </div>

        {error && <p className="text-red-600 text-sm">{error}</p>}

        <div className="flex gap-3 pt-1">
          <button className="btn-secondary flex-1" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary flex-1" onClick={handleSubmit} disabled={saving || !qcPhoto}>
            {saving ? 'Approving...' : 'Confirm & Approve'}
          </button>
        </div>
      </div>
    </Modal>
    {showInvEdit && bom?.item_id && (
      <InventoryEditModal
        orderId={bom.order_id}
        item={{ id: bom.item_id, drawing_number: bom.drawing_number, inventory_items: bom.inventory_items }}
        onClose={() => setShowInvEdit(false)}
        onDone={() => { setShowInvEdit(false); loadBom(); }}
      />
    )}
    </>
  );
}
