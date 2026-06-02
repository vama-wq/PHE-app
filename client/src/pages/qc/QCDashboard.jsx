import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import StatusBadge from '../../components/ui/StatusBadge';
import Modal from '../../components/ui/Modal';
import { fmtDate, fmtDateTime, daysUntil } from '../../lib/utils';
import { downloadExcel } from '../../lib/utils';
import {
  FlaskConical, CheckCircle, XCircle, Upload, FileText,
  ExternalLink, AlertTriangle, ChevronDown, ChevronUp, Download,
  Package, Loader2
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
                      Supplier: <span className="font-medium">{po.supplier_name}</span>
                      {po.expected_delivery_date && (
                        <span className="text-gray-400 ml-2">· Expected: {fmtDate(po.expected_delivery_date)}</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5">Created by {po.created_by_name} · {fmtDate(po.created_at)}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Link to={`/purchases/${po.id}`} className="btn-secondary btn-sm flex items-center gap-1.5">
                      <ExternalLink size={13} /> View PO
                    </Link>
                    <button
                      className="btn-primary btn-sm flex items-center gap-1.5 bg-purple-600 hover:bg-purple-700 border-purple-600"
                      onClick={() => setMaterialQCModal(po)}
                    >
                      <CheckCircle size={13} /> Approve Material
                    </button>
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
                      </div>
                      <div className="text-sm text-gray-600 mb-1">
                        <Link to={`/orders/${jc.order_id}`} className="text-brand-600 hover:underline font-medium">
                          {jc.order_code}
                        </Link>
                        {' · '}{jc.customer_code}
                        {jc.qty && <span className="text-gray-400"> · Qty: {jc.qty}</span>}
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
    if (card.order_type === 'inventory_order') return 'finished_goods';
    if (card.order_type === 'io_export_he' || card.order_type === 'io_local_he') return 'both';
    return 'dispatch'; // local_he, export_he, etc.
  };

  const [destination, setDestination] = useState(defaultDest);
  const [fgQty,        setFgQty]       = useState('');
  const [dispatchQty,  setDispatchQty] = useState('');
  const [saving,       setSaving]      = useState(false);
  const [error,        setError]       = useState('');

  const handleSubmit = async () => {
    setError('');
    if (destination === 'finished_goods' && (!fgQty || parseInt(fgQty) <= 0))
      return setError('Finished Goods quantity is required');
    if (destination === 'both') {
      if (!fgQty || parseInt(fgQty) <= 0) return setError('Finished Goods quantity is required');
      if (!dispatchQty || parseInt(dispatchQty) <= 0) return setError('Dispatch quantity is required');
    }
    setSaving(true);
    try {
      await api.put(`/qc/${card.id}/approve`, {
        heater_destination: destination,
        io_qty:       (destination === 'finished_goods' || destination === 'both') ? parseInt(fgQty) : undefined,
        dispatch_qty: destination === 'both' ? parseInt(dispatchQty) : undefined,
      });
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
    <Modal open title="QC Approval — Where are these heaters going?" onClose={onClose} size="sm">
      <div className="space-y-4">
        {/* Job card info */}
        <div className="bg-green-50 border border-green-100 rounded-lg p-3 text-sm">
          <p className="font-semibold text-green-800">{card.job_card_no} · {card.order_code}</p>
          <p className="text-green-700 mt-0.5">{card.customer_name || card.customer_code} · Qty: {card.qty || '—'}</p>
        </div>

        {/* Destination selector */}
        <div>
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
        </div>

        {/* Qty inputs for FG / Both */}
        {(destination === 'finished_goods' || destination === 'both') && (
          <div>
            <label className="label">Qty → Finished Goods <span className="text-red-500">*</span></label>
            <input className="input" type="number" min="1"
              value={fgQty} onChange={e => setFgQty(e.target.value)}
              placeholder="Units going into Finished Goods store" />
          </div>
        )}
        {destination === 'both' && (
          <div>
            <label className="label">Qty → Dispatch <span className="text-red-500">*</span></label>
            <input className="input" type="number" min="1"
              value={dispatchQty} onChange={e => setDispatchQty(e.target.value)}
              placeholder="Units going to dispatch" />
          </div>
        )}

        {error && <p className="text-red-600 text-sm">{error}</p>}

        <div className="flex gap-3 pt-1">
          <button className="btn-secondary flex-1" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary flex-1" onClick={handleSubmit} disabled={saving}>
            {saving ? 'Approving...' : 'Confirm & Approve'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
