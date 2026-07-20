import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import StatusBadge from '../../components/ui/StatusBadge';
import Modal from '../../components/ui/Modal';
import FileUpload from '../../components/ui/FileUpload';
import { fmtDate, fmtDateTime, daysUntil, dispatchPending, ACTIVITY_ICONS, getStageLabel, PRODUCTION_STAGES, stagesFor } from '../../lib/utils';
import { ArrowLeft, Plus, Upload, Printer, CheckCircle, Wrench, FileText, Image, Trash2, PlayCircle, Download, HelpCircle, AlertTriangle, Copy, ChevronDown, ChevronRight, Camera, XCircle, Truck } from 'lucide-react';

const JC_STATUSES = [
  'created','drawing_pending','drawing_done','inventory_check',
  'ready_for_production','in_production','production_complete',
  'qc_pending','qc_approved','qc_rejected','packaging','ready_for_dispatch','dispatched'
];

export default function JobCardDetail() {
  const { id } = useParams();
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [jc, setJc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [showAssemblyModal, setShowAssemblyModal] = useState(false);
  const [showDrawingModal, setShowDrawingModal] = useState(false);
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [showQCModal, setShowQCModal] = useState(false);
  const [showPackageModal, setShowPackageModal] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [editAssembly, setEditAssembly] = useState(null);
  const [splitRequests, setSplitRequests] = useState([]);
  const [showSplitModal, setShowSplitModal] = useState(false);

  const loadSplits = () => api.get(`/job-cards/${id}/split-requests`).then(r => setSplitRequests(r.data)).catch(() => {});
  const load = () => { loadSplits(); return api.get(`/job-cards/${id}`).then(r => setJc(r.data)).finally(() => setLoading(false)); };
  useEffect(() => { load(); }, [id]);

  if (loading) return <div className="p-8 text-center text-gray-400">Loading job card...</div>;
  if (!jc) return <div className="p-8 text-center text-red-500">Job card not found</div>;

  const days = daysUntil(jc.dispatch_date);
  const canAddAssembly = user.role === 'owner';
  const canUploadDrawing = ['design', 'owner'].includes(user.role);
  const canUpdateRawMaterial = ['accounts', 'owner'].includes(user.role);
  const canUpdateStatus = !['admin'].includes(user.role);
  const canAddReport = ['production', 'owner'].includes(user.role);
  const canAddQC = ['design', 'owner'].includes(user.role);
  const canUploadPackage = ['production', 'owner'].includes(user.role);
  const canViewDispatch = ['accounts', 'owner'].includes(user.role);
  const canRequestSplit = ['production', 'admin', 'owner'].includes(user.role) && ['pending', 'in_progress', 'on_hold'].includes(jc.status);
  const pendingSplit = splitRequests.find(s => s.status === 'pending');

  const tabs = [
    { key: 'overview',    label: 'Overview' },
    { key: 'assemblies',  label: `Assemblies (${jc.assemblies?.length || 0})` },
    { key: 'drawings',    label: `Drawings (${jc.drawings?.length || 0})` },
    { key: 'production',  label: 'Production' },
    { key: 'qc',          label: 'Quality' },
    ...(canViewDispatch ? [{ key: 'dispatch', label: 'Dispatch' }] : []),
    { key: 'timeline',    label: 'Timeline' },
  ];

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4 mb-5">
        <button onClick={() => navigate(-1)} className="btn-ghost btn-sm"><ArrowLeft size={16} /> Back</button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-gray-900">{jc.job_card_no}</h1>
            <StatusBadge status={jc.status} />
            {jc.replacement_query_id && (
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                Replacement{jc.replacement_query_no ? ` — ${jc.replacement_query_no}` : ''}
              </span>
            )}
            {days !== null && dispatchPending(jc) && ( 
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                days < 0 ? 'bg-red-100 text-red-700' : days <= 3 ? 'bg-orange-100 text-orange-700' : 'bg-green-100 text-green-700'
              }`}>
                {days < 0 ? `${Math.abs(days)}d overdue` : `${days}d to dispatch`}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-sm text-gray-500 mt-1">
            <Link to={`/orders/${jc.order_id}`} className="text-brand-600 hover:underline">{jc.order_code}</Link>
            <span>·</span><span>{jc.customer_code}</span>
            {jc.product_name && <><span>·</span><span>{jc.product_name}</span></>}
          </div>
        </div>
        <div className="flex gap-2 no-print">
          {user.role === 'owner' && jc.status === 'on_hold' && (
            <button
              className="btn-primary btn-sm"
              onClick={async () => {
                if (!window.confirm('Approve hold and resume production on this job card?')) return;
                try {
                  await api.put(`/job-cards/${id}/hold/approve`);
                  load();
                } catch (e) { alert(e.response?.data?.error || 'Failed to approve'); }
              }}
            >
              <CheckCircle size={14} /> Approve to Resume
            </button>
          )}
          {canRequestSplit && !pendingSplit && (
            <button className="btn-secondary btn-sm" onClick={() => setShowSplitModal(true)}>
              <Truck size={14} /> Partial Dispatch
            </button>
          )}
          {canUpdateStatus && (
            <button className="btn-secondary btn-sm" onClick={() => setShowStatusModal(true)}>
              <Wrench size={14} /> Update Status
            </button>
          )}
          <button className="btn-ghost btn-sm" onClick={() => window.print()}>
            <Printer size={14} /> Print
          </button>
          {user.role === 'owner' && (
            <button
              className="btn-danger btn-sm"
              onClick={async () => {
                if (!window.confirm(`Delete job card "${jc.job_card_no}"? This cannot be undone.`)) return;
                try { await api.delete(`/job-cards/${id}`); navigate('/job-cards'); }
                catch (e) { alert(e.response?.data?.error || 'Failed to delete'); }
              }}
            >
              <Trash2 size={14} /> Delete
            </button>
          )}
        </div>
      </div>

      {/* Partial-dispatch split requests */}
      {splitRequests.length > 0 && (
        <div className="mb-5 card p-4 no-print">
          <h3 className="font-semibold text-gray-900 mb-2 flex items-center gap-2 text-sm">
            <Truck size={15} className="text-brand-600" /> Partial Dispatch
          </h3>
          <div className="space-y-2">
            {splitRequests.map(sr => (
              <div key={sr.id} className={`rounded-lg border px-3 py-2 text-sm ${
                sr.status === 'pending' ? 'bg-amber-50 border-amber-200'
                : sr.status === 'approved' ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <span className="font-medium text-gray-800">Dispatch {sr.qty} early</span>
                    <span className="text-xs text-gray-500 ml-2">· requested by {sr.requested_by_name || '—'}</span>
                  </div>
                  {sr.status === 'pending' ? (
                    user.role === 'owner' ? (
                      <div className="flex gap-2">
                        <button className="btn-primary btn-sm text-xs"
                          onClick={async () => {
                            if (!window.confirm(`Approve dispatching ${sr.qty} early? A split job card will be created and this one's qty reduced.`)) return;
                            try { await api.put(`/job-cards/split-requests/${sr.id}/approve`); load(); }
                            catch (e) { alert(e.response?.data?.error || 'Failed'); }
                          }}>Approve</button>
                        <button className="btn-secondary btn-sm text-xs text-red-600 border-red-200"
                          onClick={async () => {
                            const reason = window.prompt('Reason for rejecting this partial dispatch?');
                            if (!reason) return;
                            try { await api.put(`/job-cards/split-requests/${sr.id}/reject`, { reason }); load(); }
                            catch (e) { alert(e.response?.data?.error || 'Failed'); }
                          }}>Reject</button>
                      </div>
                    ) : <span className="text-xs text-amber-700 font-medium">Awaiting owner approval</span>
                  ) : sr.status === 'approved' ? (
                    <span className="text-xs text-green-700">
                      ✓ Approved → {sr.child_job_card_no
                        ? <Link to={`/job-cards/${sr.child_job_card_id}`} className="text-brand-600 hover:underline font-medium">{sr.child_job_card_no}</Link>
                        : 'split created'}
                    </span>
                  ) : <span className="text-xs text-red-700">✕ Rejected{sr.rejection_reason ? `: ${sr.rejection_reason}` : ''}</span>}
                </div>
                <div className="text-xs text-gray-500 mt-0.5">Reason: {sr.reason}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Customer Query Warning Banner — Full Details */}
      {jc.active_query_no && (
        <div className="mb-5 bg-amber-50 border border-amber-300 rounded-xl overflow-hidden">
          <div className="px-5 py-3 bg-amber-100/60 border-b border-amber-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle size={16} className="text-amber-700" />
              <span className="font-bold text-amber-900">Customer Query Raised</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-semibold uppercase ${
                jc.active_query_priority === 'critical' ? 'bg-red-100 text-red-700' :
                jc.active_query_priority === 'high' ? 'bg-orange-100 text-orange-700' :
                jc.active_query_priority === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                'bg-gray-100 text-gray-600'
              }`}>{jc.active_query_priority || 'medium'}</span>
            </div>
            <Link to={`/customer-queries/${jc.active_query_id}`}
              className="btn-secondary btn-sm text-xs">View Full Query →</Link>
          </div>
          <div className="p-5">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              <div>
                <dt className="text-xs text-amber-600 font-medium uppercase">Query No</dt>
                <dd className="text-sm font-bold text-amber-900 mt-0.5">
                  <Link to={`/customer-queries/${jc.active_query_id}`} className="hover:underline">{jc.active_query_no}</Link>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-amber-600 font-medium uppercase">Job Card</dt>
                <dd className="text-sm font-semibold text-gray-900 mt-0.5">{jc.job_card_no}</dd>
              </div>
              <div>
                <dt className="text-xs text-amber-600 font-medium uppercase">Order</dt>
                <dd className="text-sm font-semibold text-gray-900 mt-0.5">
                  <Link to={`/orders/${jc.order_id}`} className="text-brand-600 hover:underline">{jc.order_code}</Link>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-amber-600 font-medium uppercase">Customer</dt>
                <dd className="text-sm font-semibold text-gray-900 mt-0.5">{jc.customer_code}</dd>
              </div>
              {jc.active_query_category && (
                <div>
                  <dt className="text-xs text-amber-600 font-medium uppercase">Category</dt>
                  <dd className="text-sm text-gray-800 mt-0.5 capitalize">{jc.active_query_category}</dd>
                </div>
              )}
              <div>
                <dt className="text-xs text-amber-600 font-medium uppercase">Assigned Dept</dt>
                <dd className="text-sm font-semibold text-gray-800 mt-0.5 capitalize">{jc.active_query_dept || '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-amber-600 font-medium uppercase">Status</dt>
                <dd className="text-sm text-gray-800 mt-0.5 capitalize">{(jc.active_query_status || '').replace(/_/g, ' ')}</dd>
              </div>
              <div>
                <dt className="text-xs text-amber-600 font-medium uppercase">Raised On</dt>
                <dd className="text-sm text-gray-800 mt-0.5">{fmtDateTime(jc.active_query_created_at)}</dd>
              </div>
              {jc.active_query_created_by_name && (
                <div>
                  <dt className="text-xs text-amber-600 font-medium uppercase">Raised By</dt>
                  <dd className="text-sm text-gray-800 mt-0.5">{jc.active_query_created_by_name}</dd>
                </div>
              )}
              {jc.product_name && (
                <div>
                  <dt className="text-xs text-amber-600 font-medium uppercase">Product</dt>
                  <dd className="text-sm text-gray-800 mt-0.5">{jc.product_name}</dd>
                </div>
              )}
              <div>
                <dt className="text-xs text-amber-600 font-medium uppercase">Qty</dt>
                <dd className="text-sm text-gray-800 mt-0.5">{jc.qty} Nos</dd>
              </div>
              <div>
                <dt className="text-xs text-amber-600 font-medium uppercase">Dispatch Date</dt>
                <dd className="text-sm text-gray-800 mt-0.5">{fmtDate(jc.dispatch_date)}</dd>
              </div>
            </div>
            <div className="mb-3">
              <dt className="text-xs text-amber-600 font-medium uppercase mb-1">Subject</dt>
              <dd className="text-sm font-semibold text-gray-900">{jc.active_query_subject}</dd>
            </div>
            {jc.active_query_description && (
              <div className="mb-3">
                <dt className="text-xs text-amber-600 font-medium uppercase mb-1">Description</dt>
                <dd className="text-sm text-gray-700 bg-amber-100/40 rounded-lg p-3">{jc.active_query_description}</dd>
              </div>
            )}
            {(jc.active_query_return_type || jc.active_query_return_coupon_no || jc.active_query_debit_note_no) && (
              <div className="flex flex-wrap gap-4 pt-3 border-t border-amber-200">
                {jc.active_query_return_type && (
                  <div>
                    <dt className="text-xs text-amber-600 font-medium uppercase">Return Type</dt>
                    <dd className="text-sm font-semibold text-gray-800 mt-0.5 capitalize">{jc.active_query_return_type === 'debit_note' ? 'Debit Note' : jc.active_query_return_type}</dd>
                  </div>
                )}
                {jc.active_query_return_status && (
                  <div>
                    <dt className="text-xs text-amber-600 font-medium uppercase">Return Status</dt>
                    <dd className="text-sm text-gray-800 mt-0.5 capitalize">{jc.active_query_return_status.replace(/_/g, ' ')}</dd>
                  </div>
                )}
                {jc.active_query_return_coupon_no && (
                  <div>
                    <dt className="text-xs text-amber-600 font-medium uppercase">Coupon No</dt>
                    <dd className="text-sm font-semibold text-gray-800 mt-0.5">{jc.active_query_return_coupon_no}</dd>
                  </div>
                )}
                {jc.active_query_debit_note_no && (
                  <div>
                    <dt className="text-xs text-amber-600 font-medium uppercase">Debit Note No</dt>
                    <dd className="text-sm font-semibold text-gray-800 mt-0.5">{jc.active_query_debit_note_no}</dd>
                  </div>
                )}
              </div>
            )}
            {(jc.active_query_message_count > 0 || jc.active_query_photo_count > 0) && (
              <div className="flex gap-4 mt-3 pt-3 border-t border-amber-200 text-xs text-amber-700">
                {jc.active_query_message_count > 0 && <span>{jc.active_query_message_count} message{jc.active_query_message_count > 1 ? 's' : ''}</span>}
                {jc.active_query_photo_count > 0 && <span>{jc.active_query_photo_count} photo{jc.active_query_photo_count > 1 ? 's' : ''}</span>}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Query Resolved Banner — Full Details */}
      {jc.status === 'resolved_dispatched' && jc.resolved_query_no && (
        <div className="mb-5 bg-green-50 border border-green-300 rounded-xl overflow-hidden">
          <div className="px-5 py-3 bg-green-100/60 border-b border-green-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle size={16} className="text-green-700" />
              <span className="font-bold text-green-900">Query Resolved</span>
            </div>
            <Link to={`/customer-queries/${jc.resolved_query_id}`}
              className="btn-secondary btn-sm text-xs">View Full Query →</Link>
          </div>
          <div className="p-5">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              <div>
                <dt className="text-xs text-green-600 font-medium uppercase">Query No</dt>
                <dd className="text-sm font-bold text-green-900 mt-0.5">
                  <Link to={`/customer-queries/${jc.resolved_query_id}`} className="hover:underline">{jc.resolved_query_no}</Link>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-green-600 font-medium uppercase">Job Card</dt>
                <dd className="text-sm font-semibold text-gray-900 mt-0.5">{jc.job_card_no}</dd>
              </div>
              <div>
                <dt className="text-xs text-green-600 font-medium uppercase">Order</dt>
                <dd className="text-sm font-semibold text-gray-900 mt-0.5">
                  <Link to={`/orders/${jc.order_id}`} className="text-brand-600 hover:underline">{jc.order_code}</Link>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-green-600 font-medium uppercase">Customer</dt>
                <dd className="text-sm font-semibold text-gray-900 mt-0.5">{jc.customer_code}</dd>
              </div>
              {jc.resolved_query_category && (
                <div>
                  <dt className="text-xs text-green-600 font-medium uppercase">Category</dt>
                  <dd className="text-sm text-gray-800 mt-0.5 capitalize">{jc.resolved_query_category}</dd>
                </div>
              )}
              {jc.resolved_query_dept && (
                <div>
                  <dt className="text-xs text-green-600 font-medium uppercase">Assigned Dept</dt>
                  <dd className="text-sm text-gray-800 mt-0.5 capitalize">{jc.resolved_query_dept}</dd>
                </div>
              )}
              <div>
                <dt className="text-xs text-green-600 font-medium uppercase">Raised On</dt>
                <dd className="text-sm text-gray-800 mt-0.5">{fmtDateTime(jc.resolved_query_created_at)}</dd>
              </div>
              {jc.resolved_query_created_by_name && (
                <div>
                  <dt className="text-xs text-green-600 font-medium uppercase">Raised By</dt>
                  <dd className="text-sm text-gray-800 mt-0.5">{jc.resolved_query_created_by_name}</dd>
                </div>
              )}
              <div>
                <dt className="text-xs text-green-600 font-medium uppercase">Resolved On</dt>
                <dd className="text-sm text-gray-800 mt-0.5">{fmtDateTime(jc.resolved_query_resolved_at)}</dd>
              </div>
              {jc.resolved_query_resolved_by_name && (
                <div>
                  <dt className="text-xs text-green-600 font-medium uppercase">Resolved By</dt>
                  <dd className="text-sm text-gray-800 mt-0.5">{jc.resolved_query_resolved_by_name}</dd>
                </div>
              )}
              {jc.product_name && (
                <div>
                  <dt className="text-xs text-green-600 font-medium uppercase">Product</dt>
                  <dd className="text-sm text-gray-800 mt-0.5">{jc.product_name}</dd>
                </div>
              )}
              <div>
                <dt className="text-xs text-green-600 font-medium uppercase">Qty</dt>
                <dd className="text-sm text-gray-800 mt-0.5">{jc.qty} Nos</dd>
              </div>
            </div>
            <div className="mb-3">
              <dt className="text-xs text-green-600 font-medium uppercase mb-1">Subject</dt>
              <dd className="text-sm font-semibold text-gray-900">{jc.resolved_query_subject}</dd>
            </div>
            {jc.resolved_query_description && (
              <div className="mb-3">
                <dt className="text-xs text-green-600 font-medium uppercase mb-1">Description</dt>
                <dd className="text-sm text-gray-700 bg-green-100/40 rounded-lg p-3">{jc.resolved_query_description}</dd>
              </div>
            )}
            {jc.resolved_query_summary && (
              <div className="mb-3">
                <dt className="text-xs text-green-600 font-medium uppercase mb-1">Resolution Summary</dt>
                <dd className="text-sm text-gray-700 bg-green-100/40 rounded-lg p-3">{jc.resolved_query_summary}</dd>
              </div>
            )}
            {(jc.resolved_query_return_type || jc.resolved_query_return_coupon_no || jc.resolved_query_debit_note_no) && (
              <div className="flex flex-wrap gap-4 pt-3 border-t border-green-200">
                {jc.resolved_query_return_type && (
                  <div>
                    <dt className="text-xs text-green-600 font-medium uppercase">Return Type</dt>
                    <dd className="text-sm font-semibold text-gray-800 mt-0.5 capitalize">{jc.resolved_query_return_type === 'debit_note' ? 'Debit Note' : jc.resolved_query_return_type}</dd>
                  </div>
                )}
                {jc.resolved_query_return_coupon_no && (
                  <div>
                    <dt className="text-xs text-green-600 font-medium uppercase">Coupon No</dt>
                    <dd className="text-sm font-semibold text-gray-800 mt-0.5">{jc.resolved_query_return_coupon_no}</dd>
                  </div>
                )}
                {jc.resolved_query_debit_note_no && (
                  <div>
                    <dt className="text-xs text-green-600 font-medium uppercase">Debit Note No</dt>
                    <dd className="text-sm font-semibold text-gray-800 mt-0.5">{jc.resolved_query_debit_note_no}</dd>
                  </div>
                )}
              </div>
            )}
            {(jc.resolved_query_message_count > 0 || jc.resolved_query_photo_count > 0) && (
              <div className="flex gap-4 mt-3 pt-3 border-t border-green-200 text-xs text-green-700">
                {jc.resolved_query_message_count > 0 && <span>{jc.resolved_query_message_count} message{jc.resolved_query_message_count > 1 ? 's' : ''}</span>}
                {jc.resolved_query_photo_count > 0 && <span>{jc.resolved_query_photo_count} photo{jc.resolved_query_photo_count > 1 ? 's' : ''}</span>}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-5 bg-gray-100 p-1 rounded-lg overflow-x-auto no-print">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            className={`px-4 py-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${
              activeTab === t.key ? 'bg-white text-brand-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && <OverviewTab jc={jc} userRole={user.role} />}
      {activeTab === 'assemblies' && (
        <AssembliesTab jc={jc} canAdd={canAddAssembly} canEdit={canAddAssembly || canUpdateRawMaterial}
          userRole={user.role} onAdd={() => setShowAssemblyModal(true)}
          onEdit={(a) => setEditAssembly(a)} onReload={load} />
      )}
      {activeTab === 'drawings' && (
        <DrawingsTab jc={jc} canUpload={canUploadDrawing} onUpload={() => setShowDrawingModal(true)} />
      )}
      {activeTab === 'production' && (
        <ProductionTab jc={jc} canAdd={canAddReport} onAdd={() => setShowReportModal(true)}
          canUploadPackage={canUploadPackage} onUploadPackage={() => setShowPackageModal(true)} />
      )}
      {activeTab === 'qc' && (
        <QCTab jc={jc} canAdd={canAddQC} onAdd={() => setShowQCModal(true)} />
      )}
      {activeTab === 'dispatch' && <DispatchTab jc={jc} userRole={user.role} onReload={load} />}
      {activeTab === 'timeline' && <TimelineTab activity={jc.activity} />}

      {/* Modals */}
      {showAssemblyModal && (
        <AssemblyModal jcId={id} assembly={null}
          onClose={() => setShowAssemblyModal(false)} onSave={() => { setShowAssemblyModal(false); load(); }} />
      )}
      {editAssembly && (
        <AssemblyModal jcId={id} assembly={editAssembly} userRole={user.role}
          onClose={() => setEditAssembly(null)} onSave={() => { setEditAssembly(null); load(); }} />
      )}
      {showDrawingModal && (
        <DrawingModal jcId={id} assemblies={jc.assemblies}
          onClose={() => setShowDrawingModal(false)} onSave={() => { setShowDrawingModal(false); load(); }} />
      )}
      {showStatusModal && (
        <StatusModal currentStatus={jc.status} jcId={id}
          onClose={() => setShowStatusModal(false)} onSave={() => { setShowStatusModal(false); load(); }} />
      )}
      {showSplitModal && (
        <SplitRequestModal jcId={id} maxQty={jc.qty}
          onClose={() => setShowSplitModal(false)} onSave={() => { setShowSplitModal(false); load(); }} />
      )}
      {showQCModal && (
        <QCModal jcId={id}
          onClose={() => setShowQCModal(false)} onSave={() => { setShowQCModal(false); load(); }} />
      )}
      {showPackageModal && (
        <PackageModal jcId={id}
          onClose={() => setShowPackageModal(false)} onSave={() => { setShowPackageModal(false); load(); }} />
      )}
      {showReportModal && (
        <DailyReportModal jcId={id} assemblies={jc.assemblies}
          onClose={() => setShowReportModal(false)} onSave={() => { setShowReportModal(false); load(); }} />
      )}
    </div>
  );
}

function OverviewTab({ jc, userRole }) {
  const [checklist, setChecklist] = useState(null);
  const [qcReports, setQcReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedStage, setExpandedStage] = useState(null);
  const [photoModal, setPhotoModal] = useState(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [checklistRes, qcRes] = await Promise.all([
          api.get(`/job-cards/${jc.id}/checklist`),
          api.get(`/qc/${jc.id}/reports`),
        ]);
        setChecklist(checklistRes.data);
        setQcReports(qcRes.data);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [jc.id]);

  // Order by the canonical checklist sequence (not raw stage_no) so out-of-sequence
  // stages like Kharoch (id 30, shown after Bending) appear in the right place.
  const STAGE_ORDER = stagesFor(jc).reduce((m, s, i) => { m[s.no] = i; return m; }, {});
  const stages = [...(checklist?.stages || [])].sort(
    (a, b) => (STAGE_ORDER[a.stage_no] ?? a.stage_no) - (STAGE_ORDER[b.stage_no] ?? b.stage_no)
  );
  const completedStages = stages.filter(s => s.done).length;
  const progressPercent = stages.length > 0 ? Math.round((completedStages / stages.length) * 100) : 0;
  const stagePhotos = stages.filter(s => (s.photo_file || s.rejection_photo_file) && s.done);
  const dispatchStage = stages.find(s => s.stage_no === 29);
  const dispatchedQty = dispatchStage?.dispatched_qty || 0;
  const totalRejections = stages.reduce((sum, s) => sum + (s.rejection_qty || 0), 0);
  const remainingQty = (jc.qty || 0) - totalRejections;

  const parseStageValue = (stageDef, sData) => {
    if (!sData.value1 && !sData.value2) return null;
    if (stageDef?.hvLight && sData.value1) {
      try { const d = JSON.parse(sData.value1); return d; } catch { return { light: sData.value1 }; }
    }
    if (stageDef?.fgHvOhms && sData.value1) {
      try { return { fgHvOhms: true, ...JSON.parse(sData.value1) }; } catch { return null; }
    }
    if (stageDef?.pressureCheck && sData.value1) {
      try { return { pressureCheck: true, ...JSON.parse(sData.value1) }; } catch { return null; }
    }
    if (stageDef?.brazing && sData.value1) {
      try { return JSON.parse(sData.value1); } catch { return null; }
    }
    if (stageDef?.heaterAdjust) return sData.value1 === 'adjusted' ? { adjusted: true } : null;
    return { value1: sData.value1, value2: sData.value2 };
  };

  return (
    <div className="space-y-5">
      {/* Job Card Details */}
      <div className="card p-5">
        <h2 className="section-title mb-4">Job Card Details</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-5">
          {[
            ['Job Card No', jc.job_card_no],
            ['Product', jc.product_name || '—'],
            ['Drawing No', jc.drawing_no || '—'],
            ['Punching', jc.punching || '—'],
            ['Quantity Ordered', jc.qty + ' Nos'],
            ['Dispatch Date', fmtDate(jc.dispatch_date)],
            ['Order', jc.order_code],
            ['Customer Code', jc.customer_code],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-gray-500 uppercase tracking-wide">{k}</dt>
              <dd className="text-sm font-medium text-gray-900 mt-1">{v}</dd>
            </div>
          ))}
        </div>
      </div>

      {/* Production Progress */}
      <div className="card p-5">
        <h2 className="section-title mb-4">Production Progress</h2>
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm font-medium text-gray-700">Overall Progress</span>
          <span className="text-sm font-semibold text-brand-600">{progressPercent}%</span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden mb-1">
          <div className="bg-brand-500 h-full transition-all duration-300" style={{ width: `${progressPercent}%` }} />
        </div>
        <p className="text-xs text-gray-500 mb-4">{completedStages} of {stages.length} stages completed</p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
          <div className="p-3 bg-blue-50 rounded-lg">
            <p className="text-xs text-gray-600 font-medium">In Progress</p>
            <p className="text-lg font-bold text-blue-600">{stages.filter(s => !s.done).length}</p>
          </div>
          <div className="p-3 bg-green-50 rounded-lg">
            <p className="text-xs text-gray-600 font-medium">Completed</p>
            <p className="text-lg font-bold text-green-600">{completedStages}</p>
          </div>
          <div className="p-3 bg-orange-50 rounded-lg">
            <p className="text-xs text-gray-600 font-medium">Total Rejections</p>
            <p className="text-lg font-bold text-orange-600">{totalRejections}</p>
          </div>
        </div>
      </div>

      {/* Full Production Checklist */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3 bg-gray-50 border-b border-gray-200">
          <h2 className="section-title">Production Checklist</h2>
        </div>
        <div className="divide-y divide-gray-100">
          {stages.map(s => {
            const def = stagesFor(jc).find(d => d.no === s.stage_no);
            const isDone = !!s.done;
            const isExpanded = expandedStage === s.stage_no;
            const hasDetails = s.worker_name || s.value1 || s.value2 || s.scrap_value || s.rejection_qty || s.photo_file || s.rejection_photo_file || s.notes || s.coil_weight != null;
            const parsed = def ? parseStageValue(def, s) : null;

            return (
              <div key={s.stage_no}>
                <button
                  onClick={() => setExpandedStage(isExpanded ? null : s.stage_no)}
                  className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-gray-50 transition-colors"
                >
                  {isDone
                    ? <CheckCircle size={18} className="text-green-500 flex-shrink-0" />
                    : <div className="w-[18px] h-[18px] rounded-full border-2 border-gray-300 flex-shrink-0" />
                  }
                  <span className="text-xs font-bold text-gray-400 w-6">{s.stage_no}</span>
                  <span className={`flex-1 text-sm font-medium ${isDone ? 'text-gray-800' : 'text-gray-400'}`}>
                    {def?.name || `Stage ${s.stage_no}`}
                    {def?.optional && <span className="text-xs text-gray-400 ml-1">(Optional)</span>}
                  </span>
                  {s.rejection_qty > 0 && (
                    <span className="text-xs px-1.5 py-0.5 bg-red-100 text-red-700 rounded font-semibold">{s.rejection_qty} rej</span>
                  )}
                  {(s.photo_file || s.rejection_photo_file) && <Camera size={14} className="text-gray-400" />}
                  {isDone && s.done_at && (
                    <span className="text-xs text-gray-400 hidden md:inline">{fmtDate(s.done_at)}</span>
                  )}
                  {hasDetails
                    ? (isExpanded ? <ChevronDown size={16} className="text-gray-400" /> : <ChevronRight size={16} className="text-gray-400" />)
                    : <div className="w-4" />
                  }
                </button>
                {isExpanded && (
                  <div className="px-5 pb-4 pt-1 ml-12 space-y-2 bg-gray-50/50">
                    {s.worker_name && (
                      <div className="flex gap-2 text-sm">
                        <span className="text-gray-500 font-medium w-28 flex-shrink-0">Worker:</span>
                        <span className="text-gray-800">{s.worker_name}</span>
                      </div>
                    )}
                    {isDone && s.done_at && (
                      <div className="flex gap-2 text-sm">
                        <span className="text-gray-500 font-medium w-28 flex-shrink-0">Completed:</span>
                        <span className="text-gray-800">{fmtDateTime(s.done_at)}</span>
                      </div>
                    )}
                    {def?.hvLight && parsed && (
                      <div className="flex gap-2 text-sm">
                        <span className="text-gray-500 font-medium w-28 flex-shrink-0">HV + Light:</span>
                        <span className="text-gray-800 flex flex-wrap gap-x-3">
                          {parsed.hv && (
                            <span className={parsed.hv === 'pass' ? 'text-green-700' : 'text-red-700'}>
                              HV: {parsed.hv}{parsed.hv === 'fail' && parsed.hvCount ? ` (${parsed.hvCount}${parsed.hvReason ? ' — ' + parsed.hvReason : ''})` : ''}
                            </span>
                          )}
                          {parsed.light && (
                            <span className={parsed.light === 'pass' ? 'text-green-700' : 'text-red-700'}>
                              Light: {parsed.light}{parsed.light === 'fail' && parsed.lightCount ? ` (${parsed.lightCount}${parsed.lightReason ? ' — ' + parsed.lightReason : ''})` : ''}
                            </span>
                          )}
                          {parsed.ohms && <span>Ohms: <span className="font-medium">{parsed.ohms}</span></span>}
                        </span>
                      </div>
                    )}
                    {def?.fgHvOhms && parsed && (
                      <div className="flex gap-2 text-sm">
                        <span className="text-gray-500 font-medium w-28 flex-shrink-0">HV / Ohms:</span>
                        <span className="text-gray-800 flex flex-wrap gap-x-3">
                          {parsed.hv && (
                            <span className={parsed.hv === 'pass' ? 'text-green-700' : 'text-red-700'}>
                              HV: {parsed.hv === 'pass' ? 'All Passed' : `Failed (${parsed.hvFailCount || '?'})`}
                            </span>
                          )}
                          {parsed.ohms && <span>Ohms: <span className="font-medium">{parsed.ohms}</span></span>}
                        </span>
                      </div>
                    )}
                    {def?.pressureCheck && parsed?.pressure && (
                      <div className="flex gap-2 text-sm">
                        <span className="text-gray-500 font-medium w-28 flex-shrink-0">Pressure Check:</span>
                        <span className={parsed.pressure === 'pass' ? 'text-green-700' : 'text-red-700'}>
                          {parsed.pressure === 'pass'
                            ? 'All Passed'
                            : `${parsed.redoCount || '?'} in redo — ${parsed.redoReason || ''}`}
                        </span>
                      </div>
                    )}
                    {def?.heaterAdjust && parsed?.adjusted && (
                      <div className="flex gap-2 text-sm">
                        <span className="text-gray-500 font-medium w-28 flex-shrink-0">Adjustment:</span>
                        <span className="text-green-700 font-medium">Adjusted</span>
                      </div>
                    )}
                    {def?.brazing && parsed && (
                      <div className="flex gap-2 text-sm">
                        <span className="text-gray-500 font-medium w-28 flex-shrink-0">Brazing:</span>
                        <span className="text-gray-800">
                          {parsed.brazing_type || '—'}
                          {parsed.brazing_material && ` · ${parsed.brazing_material}`}
                        </span>
                      </div>
                    )}
                    {!def?.hvLight && !def?.fgHvOhms && !def?.pressureCheck && !def?.heaterAdjust && !def?.brazing && (s.value1 || s.value2) && (
                      <div className="flex gap-2 text-sm">
                        <span className="text-gray-500 font-medium w-28 flex-shrink-0">
                          {def?.fields?.[0]?.label || 'Value'}:
                        </span>
                        <span className="text-gray-800">
                          {s.value1}{s.value2 && ` · ${def?.fields?.[1]?.label || ''}: ${s.value2}`}
                        </span>
                      </div>
                    )}
                    {s.scrap_value && (
                      <div className="flex gap-2 text-sm">
                        <span className="text-gray-500 font-medium w-28 flex-shrink-0">Scrap Value:</span>
                        <span className="text-amber-700">{s.scrap_value}</span>
                      </div>
                    )}
                    {s.coil_weight != null && (
                      <div className="flex gap-2 text-sm">
                        <span className="text-gray-500 font-medium w-28 flex-shrink-0">Coil Weight:</span>
                        <span className="text-blue-700 font-medium">{s.coil_weight} kg</span>
                      </div>
                    )}
                    {s.rejection_qty > 0 && (
                      <div className="flex gap-2 text-sm">
                        <span className="text-gray-500 font-medium w-28 flex-shrink-0">Rejected:</span>
                        <span className="text-red-700 font-semibold">{s.rejection_qty} pcs</span>
                        {s.remade_qty > 0 && <span className="text-green-700 ml-2">(Remade: {s.remade_qty})</span>}
                      </div>
                    )}
                    {s.notes && (
                      <div className="flex gap-2 text-sm">
                        <span className="text-gray-500 font-medium w-28 flex-shrink-0">Notes:</span>
                        <span className="text-gray-700">{s.notes}</span>
                      </div>
                    )}
                    {/* Stage Photos */}
                    <div className="flex gap-3 mt-2">
                      {s.photo_file && (
                        <button onClick={() => setPhotoModal({ src: `/uploads/checklist-photos/${s.photo_file}`, label: `Stage ${s.stage_no} Photo` })}
                          className="w-20 h-20 rounded-lg overflow-hidden border-2 border-green-200 hover:border-green-400 transition-colors cursor-pointer">
                          <img src={`/uploads/checklist-photos/${s.photo_file}`} alt={`Stage ${s.stage_no}`}
                            className="w-full h-full object-cover" onError={e => { e.target.parentElement.style.display = 'none'; }} />
                        </button>
                      )}
                      {s.rejection_photo_file && (
                        <button onClick={() => setPhotoModal({ src: `/uploads/rejection-photos/${s.rejection_photo_file}`, label: `Stage ${s.stage_no} Rejection` })}
                          className="w-20 h-20 rounded-lg overflow-hidden border-2 border-red-200 hover:border-red-400 transition-colors cursor-pointer relative">
                          <img src={`/uploads/rejection-photos/${s.rejection_photo_file}`} alt={`Stage ${s.stage_no} Rejection`}
                            className="w-full h-full object-cover" onError={e => { e.target.parentElement.style.display = 'none'; }} />
                          <span className="absolute bottom-0 left-0 right-0 bg-red-600 text-white text-[10px] text-center">Reject</span>
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* All Photos Gallery */}
      {stagePhotos.length > 0 && (
        <div className="card p-5">
          <h2 className="section-title mb-4">Production Photos ({stagePhotos.length})</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {stagePhotos.map(stage => {
              const def = stagesFor(jc).find(d => d.no === stage.stage_no);
              return (
                <div key={`photo-${stage.stage_no}`} className="space-y-2">
                  {stage.photo_file && (
                    <button onClick={() => setPhotoModal({ src: `/uploads/checklist-photos/${stage.photo_file}`, label: `Stage ${stage.stage_no}: ${def?.name || ''}` })}
                      className="relative group overflow-hidden rounded-lg bg-gray-200 w-full cursor-pointer">
                      <img src={`/uploads/checklist-photos/${stage.photo_file}`} alt={`Stage ${stage.stage_no}`}
                        className="w-full h-40 object-cover group-hover:scale-110 transition-transform duration-200"
                        onError={e => { e.target.style.display = 'none'; }} />
                      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-2">
                        <span className="text-white text-xs font-semibold">Stage {stage.stage_no}: {def?.name || ''}</span>
                      </div>
                    </button>
                  )}
                  {stage.rejection_photo_file && (
                    <button onClick={() => setPhotoModal({ src: `/uploads/rejection-photos/${stage.rejection_photo_file}`, label: `Stage ${stage.stage_no} Rejection` })}
                      className="relative group overflow-hidden rounded-lg bg-gray-200 w-full cursor-pointer">
                      <img src={`/uploads/rejection-photos/${stage.rejection_photo_file}`} alt={`Stage ${stage.stage_no} Rejection`}
                        className="w-full h-40 object-cover group-hover:scale-110 transition-transform duration-200"
                        onError={e => { e.target.style.display = 'none'; }} />
                      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-red-600/80 to-transparent p-2">
                        <span className="text-white text-xs font-semibold">Stage {stage.stage_no}: Rejection Photo</span>
                      </div>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Photo Lightbox Modal */}
      {photoModal && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4" onClick={() => setPhotoModal(null)}>
          <div className="relative max-w-4xl max-h-[90vh]" onClick={e => e.stopPropagation()}>
            <button onClick={() => setPhotoModal(null)}
              className="absolute -top-3 -right-3 w-8 h-8 bg-white rounded-full flex items-center justify-center shadow-lg z-10">
              <XCircle size={20} className="text-gray-600" />
            </button>
            <img src={photoModal.src} alt={photoModal.label}
              className="max-w-full max-h-[85vh] object-contain rounded-lg" />
            <div className="text-center mt-2 text-white text-sm font-medium">{photoModal.label}</div>
          </div>
        </div>
      )}

      {/* Dispatch Summary */}
      <div className="card p-5">
        <h2 className="section-title mb-4">Dispatch Summary</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-4 border border-gray-200 rounded-lg">
            <p className="text-xs text-gray-600 font-medium mb-1">Qty Ordered</p>
            <p className="text-2xl font-bold text-gray-900">{jc.qty}</p>
          </div>
          <div className="p-4 border border-gray-200 rounded-lg">
            <p className="text-xs text-gray-600 font-medium mb-1">Net Available</p>
            <p className="text-2xl font-bold text-blue-600">{remainingQty}</p>
          </div>
          <div className="p-4 border border-gray-200 rounded-lg">
            <p className="text-xs text-gray-600 font-medium mb-1">Qty Dispatched</p>
            <p className="text-2xl font-bold text-green-600">{dispatchedQty}</p>
          </div>
        </div>

        {/* Dispatch Details — visible only to owner + accounts */}
        {['accounts', 'owner'].includes(userRole) && (
          <DispatchDetailsInline jc={jc} qcReports={qcReports} />
        )}
      </div>

      {/* Attachments */}
      <div className="card p-5">
        <h2 className="section-title mb-4">Attachments</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {jc.file_name && (
            <a href={`/uploads/job-cards/${jc.file_name}`} target="_blank" rel="noopener noreferrer"
              className="p-4 border-2 border-blue-200 rounded-lg hover:bg-blue-50 transition-colors flex items-center gap-3">
              <FileText size={24} className="text-blue-600" />
              <div>
                <p className="text-sm font-semibold text-gray-900">Job Card File</p>
                <p className="text-xs text-gray-500 truncate">{jc.original_name || jc.file_name}</p>
              </div>
            </a>
          )}
          {jc.drawing_no && (
            <a href={`/uploads/drawings/${jc.drawing_no}.pdf`} target="_blank" rel="noopener noreferrer"
              className="p-4 border-2 border-orange-200 rounded-lg hover:bg-orange-50 transition-colors flex items-center gap-3">
              <Image size={24} className="text-orange-600" />
              <div>
                <p className="text-sm font-semibold text-gray-900">Drawing</p>
                <p className="text-xs text-gray-500">{jc.drawing_no}</p>
              </div>
            </a>
          )}
        </div>
      </div>

      {/* QC Reports */}
      {qcReports.length > 0 && (
        <div className="card p-5">
          <h2 className="section-title mb-4">QC Reports ({qcReports.length})</h2>
          <div className="space-y-3">
            {qcReports.map(report => (
              <div key={report.id} className="p-3 border border-gray-200 rounded-lg flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                      report.result === 'approved' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                    }`}>{report.result?.toUpperCase()}</span>
                    <p className="text-xs text-gray-500">{fmtDateTime(report.created_at)}</p>
                  </div>
                  {report.observations && <p className="text-sm text-gray-700">{report.observations}</p>}
                  {report.product_weight && <p className="text-xs text-gray-600 mt-1">Weight: {report.product_weight}g</p>}
                </div>
                {report.file_name && (
                  <a href={`/uploads/qc/${report.file_name}`} target="_blank" rel="noopener noreferrer"
                    className="ml-4 px-3 py-1 text-xs font-medium bg-blue-100 text-blue-700 rounded hover:bg-blue-200">Download</a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DispatchDetailsInline({ jc, qcReports }) {
  const [copied, setCopied] = useState(null);
  const dispatchedDoc = jc.dispatch_docs?.find(d => d.shipping_carrier || d.tracking_number);
  const hasAnyDispatchData = dispatchedDoc || (jc.dispatch_docs && jc.dispatch_docs.length > 0);
  const hasQC = (qcReports && qcReports.length > 0) || jc.qc_report;

  const copyToClipboard = (text, label) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  const downloadFile = async (url, filename) => {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename || url.split('/').pop();
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch { window.open(url, '_blank'); }
  };

  return (
    <div className="mt-5 pt-5 border-t border-gray-200 space-y-4">
      {/* Shipping Information */}
      {dispatchedDoc ? (
        <div>
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Shipping Information</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {dispatchedDoc.shipping_carrier && (
              <div>
                <div className="text-xs text-gray-500 uppercase font-medium">Carrier</div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-sm text-gray-800 font-semibold">{dispatchedDoc.shipping_carrier}</span>
                  <button onClick={() => copyToClipboard(dispatchedDoc.shipping_carrier, 'carrier')}
                    className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600" title="Copy">
                    <Copy size={13} />
                  </button>
                  {copied === 'carrier' && <span className="text-xs text-green-600">Copied</span>}
                </div>
              </div>
            )}
            {dispatchedDoc.tracking_number && (
              <div>
                <div className="text-xs text-gray-500 uppercase font-medium">Tracking Number</div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-sm text-gray-800 font-mono font-semibold">{dispatchedDoc.tracking_number}</span>
                  <button onClick={() => copyToClipboard(dispatchedDoc.tracking_number, 'tracking')}
                    className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600" title="Copy">
                    <Copy size={13} />
                  </button>
                  {copied === 'tracking' && <span className="text-xs text-green-600">Copied</span>}
                </div>
              </div>
            )}
            {dispatchedDoc.dispatch_date && (
              <div>
                <div className="text-xs text-gray-500 uppercase font-medium">Dispatched On</div>
                <div className="text-sm text-gray-800 mt-0.5">{fmtDate(dispatchedDoc.dispatch_date)}</div>
              </div>
            )}
            {dispatchedDoc.notes && (
              <div className="col-span-full">
                <div className="text-xs text-gray-500 uppercase font-medium">Notes</div>
                <div className="text-sm text-gray-800 mt-0.5">{dispatchedDoc.notes}</div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div>
          <h3 className="text-sm font-semibold text-gray-900 mb-2">Dispatch Details</h3>
          <p className="text-sm text-gray-400">No shipping details available yet.</p>
        </div>
      )}

      {/* Dispatch Documents */}
      {jc.dispatch_docs?.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-900 mb-2">Dispatch Documents</h3>
          <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden">
            {jc.dispatch_docs.map(d => (
              <div key={d.id} className="flex items-center gap-3 px-4 py-3">
                <FileText size={16} className="text-brand-500 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium capitalize">{d.doc_type?.replace(/_/g, ' ') || 'Document'}</div>
                  {d.shipping_carrier && <span className="text-xs text-gray-500 mr-3">Carrier: {d.shipping_carrier}</span>}
                  {d.tracking_number && <span className="text-xs text-gray-500">Tracking: {d.tracking_number}</span>}
                  <div className="text-xs text-gray-400">{d.created_by_name} · {fmtDate(d.created_at)}</div>
                </div>
                {d.file_name && (
                  <button onClick={() => downloadFile(`/uploads/dispatch/${d.file_name}`, d.original_name || d.file_name)}
                    className="btn-ghost btn-sm text-brand-600">
                    <Download size={14} /> Download
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* QC Reports */}
      {hasQC && (
        <div>
          <h3 className="text-sm font-semibold text-gray-900 mb-2">QC Reports</h3>
          <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden">
            {(qcReports && qcReports.length > 0 ? qcReports : (jc.qc_report ? [jc.qc_report] : [])).map(report => (
              <div key={report.id} className="flex items-center gap-3 px-4 py-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                  report.result === 'approved' ? 'bg-green-100' : report.result === 'rejected' ? 'bg-red-100' : 'bg-yellow-100'
                }`}>
                  {report.result === 'approved'
                    ? <CheckCircle size={16} className="text-green-600" />
                    : <XCircle size={16} className="text-red-600" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                      report.result === 'approved' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                    }`}>{report.result?.toUpperCase()}</span>
                    <span className="text-xs text-gray-500">{fmtDateTime(report.created_at)}</span>
                  </div>
                  {report.observations && <p className="text-sm text-gray-700 mt-1 truncate">{report.observations}</p>}
                  {report.product_weight && <span className="text-xs text-gray-500">Weight: {report.product_weight}g</span>}
                  <div className="text-xs text-gray-400">{report.created_by_name}</div>
                </div>
                {report.file_name && (
                  <button onClick={() => downloadFile(`/uploads/qc/${report.file_name}`, report.original_name || report.file_name)}
                    className="btn-ghost btn-sm text-brand-600">
                    <Download size={14} /> Download
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AssembliesTab({ jc, canAdd, canEdit, userRole, onAdd, onEdit, onReload }) {
  const isAccounts = userRole === 'accounts';
  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="section-title">Assemblies</h2>
        {canAdd && <button className="btn-primary btn-sm" onClick={onAdd}><Plus size={14} /> Add Assembly</button>}
      </div>
      {jc.assemblies?.length === 0 ? (
        <div className="card p-8 text-center text-gray-400">No assemblies yet.</div>
      ) : jc.assemblies.map(a => (
        <div key={a.id} className="card mb-4 overflow-hidden">
          <div className="px-5 py-3.5 bg-brand-50 border-b border-brand-100 flex items-center justify-between">
            <h3 className="font-semibold text-brand-800">Assembly {a.assembly_no}</h3>
            <div className="flex items-center gap-3">
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                a.raw_material_status === 'dispatched' ? 'bg-green-100 text-green-700' :
                a.raw_material_status === 'partial' ? 'bg-yellow-100 text-yellow-700' :
                'bg-gray-100 text-gray-600'
              }`}>
                RM: {a.raw_material_status}
              </span>
              {canEdit && <button className="btn-secondary btn-sm" onClick={() => onEdit(a)}>Edit</button>}
            </div>
          </div>
          <div className="p-5">
            <AssemblySpecs assembly={a} />
            {isAccounts && (
              <RawMaterialDispatch assembly={a} jcId={jc.id} onReload={onReload} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function AssemblySpecs({ assembly: a }) {
  const row = (label, ...vals) => (
    <tr className="border-b border-gray-100">
      <td className="py-2 pr-4 text-xs text-gray-500 font-medium whitespace-nowrap">{label}</td>
      <td className="py-2 text-sm text-gray-800">{vals.filter(v => v != null && v !== '').join(' · ')}</td>
    </tr>
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <tbody>
          {row('Wattage / Voltage', a.wattage_actual && `${a.wattage_actual} W`, a.voltage_actual && `${a.voltage_actual} V`)}
          {row('Tube Material / Dia', a.tube_material, a.tube_diameter_mm && `${a.tube_diameter_mm} mm`)}
          {row('Tube Length After Draw', ...[a.tube_length_val1, a.tube_length_val2, a.tube_length_val3, a.tube_length_val4].filter(Boolean))}
          {row('Tube Cutting Length', a.tube_cutting_val1, a.tube_cutting_val2, a.tube_cutting_unit, a.tube_cutting_percentage && `${a.tube_cutting_percentage}%`)}
          {row('Wire Gauge / Ω/mtr', a.wire_gauge_swg && `${a.wire_gauge_swg} SWG`, a.wire_ohms_per_mtr && `${a.wire_ohms_per_mtr} Ω/mtr`)}
          {row('Wire Length', a.wire_length_min, 'TO', a.wire_length_max)}
          {row('Ohms Range', a.ohms_range_val1, a.ohms_range_val2, a.ohms_range_val3, a.ohms_tolerance_percent && `±${a.ohms_tolerance_percent}%`)}
          {row('Cold Zone Big / Small', a.cold_zone_big, a.cold_zone_small)}
          {row('Terminal Pin Big', a.terminal_pin_big_material, a.terminal_pin_big_val1, a.terminal_pin_big_val2)}
          {row('Terminal Pin Small', a.terminal_pin_small_material, a.terminal_pin_small_val1, a.terminal_pin_small_val2)}
          {row('Ω After Draw', a.ohms_after_draw_val1, a.ohms_after_draw_val2, a.ohms_after_draw_val3)}
          {row('Bending Roller 1', a.bending_roller1_unit, a.bending_roller1_value)}
          {row('Bending Roller 2', a.bending_roller2_unit, a.bending_roller2_value)}
          {a.remark && row('Remark', a.remark)}
          {row('Plating', a.plating_required ? `✓ ${a.plating_description || ''}` : '—')}
        </tbody>
      </table>
    </div>
  );
}

function RawMaterialDispatch({ assembly, jcId, onReload }) {
  const [status, setStatus] = useState(assembly.raw_material_status);
  const [notes, setNotes] = useState(assembly.raw_material_notes || '');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    await api.put(`/job-cards/${jcId}/assemblies/${assembly.id}`, { raw_material_status: status, raw_material_notes: notes });
    onReload();
    setSaving(false);
  };
  return (
    <div className="mt-4 pt-4 border-t border-gray-100">
      <h4 className="text-sm font-semibold text-gray-700 mb-3">Raw Material Dispatch</h4>
      <div className="flex gap-3 items-end">
        <div className="flex-1">
          <label className="label">Status</label>
          <select className="input" value={status} onChange={e => setStatus(e.target.value)}>
            <option value="pending">Pending</option>
            <option value="partial">Partial</option>
            <option value="dispatched">Dispatched</option>
          </select>
        </div>
        <div className="flex-1">
          <label className="label">Notes</label>
          <input className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional notes..." />
        </div>
        <button className="btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
      {assembly.raw_material_dispatched_at && (
        <p className="text-xs text-gray-400 mt-2">
          Dispatched: {fmtDateTime(assembly.raw_material_dispatched_at)} by {assembly.dispatched_by_name}
        </p>
      )}
    </div>
  );
}

function DrawingsTab({ jc, canUpload, onUpload }) {
  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="section-title">Drawings</h2>
        {canUpload && <button className="btn-primary btn-sm" onClick={onUpload}><Upload size={14} /> Upload Drawing</button>}
      </div>
      {jc.drawings?.length === 0 ? (
        <div className="card p-8 text-center text-gray-400">No drawings uploaded yet.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {jc.drawings.map(d => (
            <div key={d.id} className="card p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-red-50 rounded-lg flex items-center justify-center flex-shrink-0">
                <FileText size={20} className="text-red-500" />
              </div>
              <div className="flex-1 min-w-0">
                <a href={`/uploads/drawings/${d.file_name}`} target="_blank" rel="noopener noreferrer"
                  className="text-sm font-medium text-brand-600 hover:underline truncate block">
                  {d.original_name || d.file_name}
                </a>
                <div className="text-xs text-gray-400 mt-0.5">
                  {d.assembly_no ? `Assembly ${d.assembly_no} · ` : ''}v{d.version} · {d.uploaded_by_name} · {fmtDate(d.created_at)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProductionTab({ jc, canAdd, onAdd, canUploadPackage, onUploadPackage }) {
  return (
    <div className="space-y-5">
      <div className="flex justify-between items-center">
        <h2 className="section-title">Daily Production Reports</h2>
        {canAdd && <button className="btn-primary btn-sm" onClick={onAdd}><Plus size={14} /> Add Report</button>}
      </div>
      {jc.production_reports?.length === 0 ? (
        <div className="card p-8 text-center text-gray-400">No reports yet.</div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="table-header text-left">Date</th>
                <th className="table-header text-left">Step</th>
                <th className="table-header text-left">Assembly</th>
                <th className="table-header text-right">Produced</th>
                <th className="table-header text-right">Rejected</th>
                <th className="table-header text-left">Rejection Reason</th>
                <th className="table-header text-left">Operator</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {jc.production_reports.map(r => (
                <tr key={r.id}>
                  <td className="table-cell text-gray-600">{fmtDate(r.report_date)}</td>
                  <td className="table-cell font-medium">{r.production_step}</td>
                  <td className="table-cell text-gray-500">{r.assembly_no ? `A${r.assembly_no}` : '—'}</td>
                  <td className="table-cell text-right text-green-700 font-semibold">{r.qty_produced}</td>
                  <td className="table-cell text-right text-red-600 font-semibold">{r.qty_rejected || 0}</td>
                  <td className="table-cell text-gray-500 text-xs">{r.rejection_reason || '—'}</td>
                  <td className="table-cell text-gray-500 text-xs">{r.operator_name || r.created_by_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Package Photos */}
      <div>
        <div className="flex justify-between items-center mb-3">
          <h2 className="section-title">Package Photos</h2>
          {canUploadPackage && (
            <button className="btn-secondary btn-sm" onClick={onUploadPackage}><Image size={14} /> Upload Photo</button>
          )}
        </div>
        {jc.package_photos?.length === 0 ? (
          <div className="card p-6 text-center text-gray-400 text-sm">No package photos yet.</div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {jc.package_photos.map(p => (
              <a key={p.id} href={`/uploads/packages/${p.file_name}`} target="_blank" rel="noopener noreferrer"
                className="card overflow-hidden hover:shadow-md transition-shadow">
                <img src={`/uploads/packages/${p.file_name}`} alt="Package" className="w-full h-32 object-cover" />
                <div className="px-3 py-2">
                  <div className="text-xs text-gray-500">{p.uploaded_by_name} · {fmtDate(p.created_at)}</div>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function QCTab({ jc, canAdd, onAdd }) {
  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="section-title">Quality Control</h2>
        {canAdd && <button className="btn-primary btn-sm" onClick={onAdd}><Plus size={14} /> Add QC Report</button>}
      </div>
      {!jc.qc_report ? (
        <div className="card p-8 text-center text-gray-400">No QC report yet.</div>
      ) : (
        <div className="card p-5">
          <div className="flex items-center gap-3 mb-4">
            <span className={`text-lg px-3 py-1 rounded-full font-semibold ${
              jc.qc_report.result === 'approved' ? 'bg-green-100 text-green-700' :
              jc.qc_report.result === 'rejected' ? 'bg-red-100 text-red-700' :
              'bg-yellow-100 text-yellow-700'
            }`}>
              {jc.qc_report.result.toUpperCase()}
            </span>
            <div className="text-sm text-gray-500">{jc.qc_report.created_by_name} · {fmtDateTime(jc.qc_report.created_at)}</div>
          </div>
          {jc.qc_report.observations && (
            <div className="mb-3">
              <div className="label mb-1">Observations</div>
              <p className="text-sm text-gray-700 bg-gray-50 p-3 rounded-lg">{jc.qc_report.observations}</p>
            </div>
          )}
          {jc.qc_report.corrective_action && (
            <div>
              <div className="label mb-1">Corrective Action</div>
              <p className="text-sm text-gray-700 bg-gray-50 p-3 rounded-lg">{jc.qc_report.corrective_action}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DispatchTab({ jc, userRole, onReload }) {
  const [dispatch, setDispatch] = useState({ shipping_carrier: '', tracking_number: '', dispatch_date: new Date().toISOString().split('T')[0] });
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(null);
  const canDispatch = ['accounts', 'owner'].includes(userRole);

  const qtyOrdered = parseInt(jc.qty, 10) || 0;
  const totalRejected = jc.total_rejected || 0;
  const netQty = jc.net_qty || (qtyOrdered - totalRejected);
  const qcDispatchQty = jc.qc_dispatch_qty;
  const qcFgQty = jc.qc_fg_qty;
  const qcRoute = jc.qc_route;

  const dispatchedDoc = jc.dispatch_docs?.find(d => d.shipping_carrier || d.tracking_number);

  const copyToClipboard = (text, label) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  const downloadFile = async (url, filename) => {
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename || url.split('/').pop();
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch { window.open(url, '_blank'); }
  };

  const handleDownload = () => {
    const rows = [
      ['DISPATCH DETAILS', ''],
      ['', ''],
      ['Job Card No', jc.job_card_no || ''],
      ['Order Code', jc.order_code || ''],
      ['Customer Code', jc.customer_code || ''],
      ['Product', jc.product_name || ''],
      ['Drawing No', jc.drawing_no || ''],
      ['Punching', jc.punching || ''],
      ['', ''],
      ['QUANTITIES', ''],
      ['Qty Ordered', qtyOrdered],
      ['Total Rejections', totalRejected],
      ['Net Available', netQty],
      ...(qcRoute ? [
        ['QC Route', qcRoute === 'dispatch' ? 'Dispatch' : qcRoute === 'finished_goods' ? 'Finished Goods' : qcRoute === 'both' || qcRoute === 'split' ? 'Split' : qcRoute],
        ...(qcDispatchQty != null ? [['Qty to Dispatch', qcDispatchQty]] : []),
        ...(qcFgQty != null ? [['Qty to Finished Goods', qcFgQty]] : []),
      ] : []),
      ['', ''],
      ['DISPATCH INFO', ''],
      ['Dispatch Date', jc.dispatch_date ? fmtDate(jc.dispatch_date) : ''],
      ['Status', jc.status || ''],
      ...(dispatchedDoc ? [
        ['Shipping Carrier', dispatchedDoc.shipping_carrier || ''],
        ['Tracking Number', dispatchedDoc.tracking_number || ''],
      ] : []),
      ['', ''],
      ['DOCUMENTS', ''],
      ...(jc.dispatch_docs?.length
        ? jc.dispatch_docs.map(d => [
            (d.doc_type || 'document').replace(/_/g, ' '),
            `${d.file_name || ''} | ${d.created_by_name || ''} | ${d.created_at ? fmtDate(d.created_at) : ''}`
          ])
        : [['None', '']]),
    ];

    const csvContent = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Dispatch_${jc.job_card_no || jc.id}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="section-title">Dispatch Details</h2>
        <button onClick={handleDownload} className="btn-secondary btn-sm">
          <Download size={15} /> Download
        </button>
      </div>

      {/* Job Card & Customer Info */}
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Order Information</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <div className="text-xs text-gray-500 uppercase font-medium">Job Card No</div>
            <div className="text-sm text-gray-800 font-semibold mt-0.5">{jc.job_card_no}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase font-medium">Order</div>
            <Link to={`/orders/${jc.order_id}`} className="text-sm text-brand-600 hover:underline mt-0.5 block">{jc.order_code}</Link>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase font-medium">Customer</div>
            <div className="text-sm text-gray-800 mt-0.5">{jc.customer_code}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase font-medium">Dispatch Date</div>
            <div className="text-sm text-gray-800 mt-0.5">{fmtDate(jc.dispatch_date)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase font-medium">Product</div>
            <div className="text-sm text-gray-800 mt-0.5">{jc.product_name || '—'}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase font-medium">Drawing No</div>
            <div className="text-sm text-gray-800 mt-0.5">{jc.drawing_no || '—'}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase font-medium">Punching</div>
            <div className="text-sm text-gray-800 mt-0.5">{jc.punching || '—'}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase font-medium">Status</div>
            <div className="mt-0.5"><StatusBadge status={jc.status} /></div>
          </div>
        </div>
      </div>

      {/* Quantity Summary */}
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Quantity Summary</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-blue-50 rounded-lg p-3">
            <div className="text-xs text-blue-600 font-medium">Qty Ordered</div>
            <div className="text-xl font-bold text-blue-700">{qtyOrdered}</div>
          </div>
          <div className="bg-red-50 rounded-lg p-3">
            <div className="text-xs text-red-600 font-medium">Total Rejections</div>
            <div className="text-xl font-bold text-red-700">{totalRejected}</div>
          </div>
          <div className="bg-green-50 rounded-lg p-3">
            <div className="text-xs text-green-600 font-medium">Net Available</div>
            <div className="text-xl font-bold text-green-700">{netQty}</div>
          </div>
          {qcRoute && (
            <div className="bg-amber-50 rounded-lg p-3">
              <div className="text-xs text-amber-600 font-medium">QC Route</div>
              <div className="text-sm font-bold text-amber-700 mt-1">
                {qcRoute === 'dispatch' && `${qcDispatchQty ?? netQty} → Dispatch`}
                {qcRoute === 'finished_goods' && `${qcFgQty ?? netQty} → Finished Goods`}
                {(qcRoute === 'both' || qcRoute === 'split') && (
                  <>{qcDispatchQty ?? '—'} → Dispatch<br />{qcFgQty ?? '—'} → FG</>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Shipping Info */}
      {dispatchedDoc && (
        <div className="card p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Shipping Information</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {dispatchedDoc.shipping_carrier && (
              <div>
                <div className="text-xs text-gray-500 uppercase font-medium">Carrier</div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-sm text-gray-800">{dispatchedDoc.shipping_carrier}</span>
                  <button onClick={() => copyToClipboard(dispatchedDoc.shipping_carrier, 'carrier')}
                    className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600" title="Copy">
                    <Copy size={13} />
                  </button>
                  {copied === 'carrier' && <span className="text-xs text-green-600">Copied</span>}
                </div>
              </div>
            )}
            {dispatchedDoc.tracking_number && (
              <div>
                <div className="text-xs text-gray-500 uppercase font-medium">Tracking Number</div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-sm text-gray-800 font-mono">{dispatchedDoc.tracking_number}</span>
                  <button onClick={() => copyToClipboard(dispatchedDoc.tracking_number, 'tracking')}
                    className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600" title="Copy">
                    <Copy size={13} />
                  </button>
                  {copied === 'tracking' && <span className="text-xs text-green-600">Copied</span>}
                </div>
              </div>
            )}
            {dispatchedDoc.dispatch_date && (
              <div>
                <div className="text-xs text-gray-500 uppercase font-medium">Dispatch Date</div>
                <div className="text-sm text-gray-800 mt-0.5">{fmtDate(dispatchedDoc.dispatch_date)}</div>
              </div>
            )}
            {dispatchedDoc.notes && (
              <div className="col-span-full">
                <div className="text-xs text-gray-500 uppercase font-medium">Notes</div>
                <div className="text-sm text-gray-800 mt-0.5">{dispatchedDoc.notes}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Dispatch Documents */}
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Documents</h3>
        {!jc.dispatch_docs?.length ? (
          <div className="text-center text-gray-400 text-sm py-4">No dispatch documents uploaded yet.</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {jc.dispatch_docs.map(d => (
              <div key={d.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <FileText size={18} className="text-brand-500 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium capitalize">{d.doc_type?.replace(/_/g, ' ') || 'Document'}</div>
                  {d.shipping_carrier && <div className="text-xs text-gray-500">Carrier: {d.shipping_carrier}</div>}
                  {d.tracking_number && <div className="text-xs text-gray-500">Tracking: {d.tracking_number}</div>}
                  <div className="text-xs text-gray-400">{d.created_by_name} · {fmtDate(d.created_at)}</div>
                </div>
                {d.file_name && (
                  <button onClick={() => downloadFile(`/uploads/dispatch/${d.file_name}`, d.original_name || d.file_name)}
                    className="btn-ghost btn-sm text-brand-600">
                    <Download size={14} /> Download
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Mark as Dispatched */}
      {canDispatch && jc.status !== 'dispatched' && (
        <div className="card p-5">
          <h3 className="font-semibold text-gray-900 mb-4">Mark as Dispatched</h3>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label">Shipping Carrier</label>
              <input className="input" placeholder="e.g. DTDC, BlueDart" value={dispatch.shipping_carrier}
                onChange={e => setDispatch(d => ({ ...d, shipping_carrier: e.target.value }))} />
            </div>
            <div>
              <label className="label">Tracking No</label>
              <input className="input" placeholder="Optional" value={dispatch.tracking_number}
                onChange={e => setDispatch(d => ({ ...d, tracking_number: e.target.value }))} />
            </div>
            <div>
              <label className="label">Dispatch Date</label>
              <input className="input" type="date" value={dispatch.dispatch_date}
                onChange={e => setDispatch(d => ({ ...d, dispatch_date: e.target.value }))} />
            </div>
          </div>
          <button className="btn-primary mt-4" disabled={saving} onClick={async () => {
            setSaving(true);
            try {
              await api.put(`/dispatch/${jc.id}/mark-dispatched`, dispatch);
              onReload();
            } catch (err) {
              alert(err.response?.data?.error || 'Failed to dispatch');
            }
            setSaving(false);
          }}>
            {saving ? 'Saving...' : 'Mark as Dispatched'}
          </button>
        </div>
      )}
    </div>
  );
}

function TimelineTab({ activity }) {
  return (
    <div className="max-w-2xl">
      <h2 className="section-title mb-4">Order Timeline</h2>
      {(!activity || activity.length === 0) ? (
        <div className="card p-8 text-center text-gray-400">No activity yet.</div>
      ) : (
        <div className="relative pl-6">
          <div className="absolute left-2 top-0 bottom-0 w-px bg-gray-200" />
          {activity.map((log, i) => (
            <div key={log.id} className="relative mb-5">
              <div className="absolute -left-4 w-4 h-4 bg-white border-2 border-brand-400 rounded-full" style={{ top: '3px' }} />
              <div className="ml-2">
                <div className="flex items-center gap-2">
                  <span>{ACTIVITY_ICONS[log.activity_type] || '📌'}</span>
                  <span className="text-sm text-gray-800 font-medium">{log.description}</span>
                </div>
                <div className="text-xs text-gray-400 mt-0.5 ml-6">
                  {log.user_name} · {fmtDateTime(log.created_at)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Assembly form (shared for add and edit)
function AssemblyModal({ jcId, assembly, userRole, onClose, onSave }) {
  const isAccounts = userRole === 'accounts';
  const [f, setF] = useState(assembly || {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));
  const num = k => e => setF(p => ({ ...p, [k]: e.target.value === '' ? null : Number(e.target.value) }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (assembly) {
        await api.put(`/job-cards/${jcId}/assemblies/${assembly.id}`, f);
      } else {
        await api.post(`/job-cards/${jcId}/assemblies`, f);
      }
      onSave();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save');
      setSaving(false);
    }
  };

  const field = (label, key, type = 'text', placeholder = '') => (
    <div>
      <label className="label text-xs">{label}</label>
      <input className="input text-sm" type={type} placeholder={placeholder}
        value={f[key] ?? ''} onChange={type === 'number' ? num(key) : set(key)} />
    </div>
  );

  if (isAccounts) {
    return (
      <Modal open title={`Assembly ${assembly?.assembly_no} — Raw Material`} onClose={onClose} size="sm">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Raw Material Status</label>
            <select className="input" value={f.raw_material_status || 'pending'} onChange={set('raw_material_status')}>
              <option value="pending">Pending</option>
              <option value="partial">Partial</option>
              <option value="dispatched">Dispatched</option>
            </select>
          </div>
          <div>
            <label className="label">Notes</label>
            <textarea className="input h-20 resize-none" value={f.raw_material_notes || ''} onChange={set('raw_material_notes')} />
          </div>
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <div className="flex gap-3">
            <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary flex-1" disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
          </div>
        </form>
      </Modal>
    );
  }

  return (
    <Modal open title={assembly ? `Edit Assembly ${assembly.assembly_no}` : 'Add Assembly'} onClose={onClose} size="xl">
      <form onSubmit={handleSubmit}>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-5">
          {field('Wattage (W)', 'wattage_actual', 'number')}
          {field('Voltage (V)', 'voltage_actual', 'number')}
          {field('Tube Material', 'tube_material', 'text', 'e.g. Copper')}
          {field('Tube Dia (mm)', 'tube_diameter_mm', 'number')}
          {field('Tube Length Val1', 'tube_length_val1', 'number')}
          {field('Tube Length Val2', 'tube_length_val2', 'number')}
          {field('Tube Length Val3', 'tube_length_val3', 'number')}
          {field('Tube Length Val4', 'tube_length_val4', 'number')}
          {field('Tube Cutting Val1', 'tube_cutting_val1', 'number')}
          {field('Tube Cutting Val2', 'tube_cutting_val2', 'number')}
          {field('Tube Cutting Unit', 'tube_cutting_unit', 'text', 'mm')}
          {field('Tube Cutting %', 'tube_cutting_percentage', 'number')}
          {field('Wire Gauge (SWG)', 'wire_gauge_swg', 'number')}
          {field('Wire Ω/mtr', 'wire_ohms_per_mtr', 'number')}
          {field('Wire Length Min', 'wire_length_min', 'number')}
          {field('Wire Length Max', 'wire_length_max', 'number')}
          {field('Ohms Range Val1', 'ohms_range_val1', 'number')}
          {field('Ohms Range Val2', 'ohms_range_val2', 'number')}
          {field('Ohms Range Val3', 'ohms_range_val3', 'number')}
          {field('Ohms Tolerance %', 'ohms_tolerance_percent', 'number')}
          {field('Cold Zone Big', 'cold_zone_big', 'number')}
          {field('Cold Zone Small', 'cold_zone_small', 'number')}
          {field('Terminal Pin Big Material', 'terminal_pin_big_material')}
          {field('Terminal Pin Big Val1', 'terminal_pin_big_val1', 'number')}
          {field('Terminal Pin Big Val2', 'terminal_pin_big_val2', 'number')}
          {field('Terminal Pin Small Material', 'terminal_pin_small_material')}
          {field('Terminal Pin Small Val1', 'terminal_pin_small_val1', 'number')}
          {field('Terminal Pin Small Val2', 'terminal_pin_small_val2', 'number')}
          {field('Ω After Draw Val1', 'ohms_after_draw_val1', 'number')}
          {field('Ω After Draw Val2', 'ohms_after_draw_val2', 'number')}
          {field('Ω After Draw Val3', 'ohms_after_draw_val3', 'number')}
          {field('Bending Roller 1 Unit', 'bending_roller1_unit', 'text', 'U Inch')}
          {field('Bending Roller 1 Value', 'bending_roller1_value')}
          {field('Bending Roller 2 Unit', 'bending_roller2_unit', 'text', 'U Inch')}
          {field('Bending Roller 2 Value', 'bending_roller2_value')}
        </div>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div className="col-span-2">
            <label className="label text-xs">Remark</label>
            <input className="input" value={f.remark || ''} onChange={set('remark')} placeholder="e.g. Flange 1.5, Gasket Rubber..." />
          </div>
          <div className="flex items-center gap-3">
            <input type="checkbox" id="plating" checked={!!f.plating_required}
              onChange={e => setF(p => ({ ...p, plating_required: e.target.checked }))} className="w-4 h-4" />
            <label htmlFor="plating" className="text-sm text-gray-700">Plating Required</label>
          </div>
          {f.plating_required && (
            <div>{field('Plating Description', 'plating_description', 'text', 'e.g. Nickel Plating')}</div>
          )}
        </div>
        {error && <p className="text-red-600 text-sm mb-3">{error}</p>}
        <div className="flex gap-3">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving}>{saving ? 'Saving...' : assembly ? 'Update Assembly' : 'Add Assembly'}</button>
        </div>
      </form>
    </Modal>
  );
}

function DrawingModal({ jcId, assemblies, onClose, onSave }) {
  const [file, setFile] = useState(null);
  const [assemblyId, setAssemblyId] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) return setError('Please select a file');
    setSaving(true);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('job_card_id', jcId);
    if (assemblyId) fd.append('assembly_id', assemblyId);
    fd.append('notes', notes);
    try { await api.post('/drawings', fd); onSave(); }
    catch (err) { setError(err.response?.data?.error || 'Upload failed'); setSaving(false); }
  };

  return (
    <Modal open title="Upload Drawing" onClose={onClose} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">Assembly (optional)</label>
          <select className="input" value={assemblyId} onChange={e => setAssemblyId(e.target.value)}>
            <option value="">General (not assembly-specific)</option>
            {assemblies?.map(a => <option key={a.id} value={a.id}>Assembly {a.assembly_no}</option>)}
          </select>
        </div>
        <FileUpload onFile={setFile} accept=".pdf" label="Select Drawing PDF" />
        <div>
          <label className="label">Notes</label>
          <input className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional" />
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <div className="flex gap-3">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving}>{saving ? 'Uploading...' : 'Upload'}</button>
        </div>
      </form>
    </Modal>
  );
}

function SplitRequestModal({ jcId, maxQty, onClose, onSave }) {
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setError('');
    const n = parseInt(qty, 10);
    if (!n || n < 1) return setError('Enter the quantity to dispatch early');
    if (n >= maxQty) return setError(`Must be less than ${maxQty} — at least 1 must remain on this job card`);
    if (!reason.trim()) return setError('A reason is required');
    setSaving(true);
    try {
      await api.post(`/job-cards/${jcId}/split-request`, { qty: n, reason });
      onSave();
    } catch (e) { setError(e.response?.data?.error || 'Failed'); setSaving(false); }
  };
  return (
    <Modal open title="Request Partial Dispatch" onClose={onClose} size="sm">
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          Request to dispatch part of this job card early. The owner must approve. On approval, those units
          become a separate job card (skipping production, straight to QC → dispatch) and this card's qty drops.
        </p>
        <div>
          <label className="label">Quantity to dispatch early <span className="text-red-500">*</span></label>
          <input className="input" type="number" min="1" max={maxQty - 1} value={qty} onChange={e => setQty(e.target.value)} placeholder={`of ${maxQty}`} />
        </div>
        <div>
          <label className="label">Reason <span className="text-red-500">*</span></label>
          <textarea className="input h-20 resize-none" value={reason} onChange={e => setReason(e.target.value)} placeholder="Why is part of this order being dispatched early?" />
        </div>
        {error && <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
        <div className="flex gap-3">
          <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={saving} onClick={submit}>{saving ? 'Sending…' : 'Send for Approval'}</button>
        </div>
      </div>
    </Modal>
  );
}

function StatusModal({ currentStatus, jcId, onClose, onSave }) {
  const [status, setStatus] = useState(currentStatus);
  const [saving, setSaving] = useState(false);
  return (
    <Modal open title="Update Job Card Status" onClose={onClose} size="sm">
      <div className="mb-4">
        <label className="label">New Status</label>
        <select className="input" value={status} onChange={e => setStatus(e.target.value)}>
          {JC_STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>)}
        </select>
      </div>
      <div className="flex gap-3">
        <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
        <button className="btn-primary flex-1" disabled={saving} onClick={async () => {
          setSaving(true);
          await api.put(`/job-cards/${jcId}/status`, { status });
          onSave();
        }}>{saving ? 'Saving...' : 'Update'}</button>
      </div>
    </Modal>
  );
}

function QCModal({ jcId, onClose, onSave }) {
  const [f, setF] = useState({ result: 'approved', observations: '', corrective_action: '' });
  const [saving, setSaving] = useState(false);
  return (
    <Modal open title="Add QC Report" onClose={onClose} size="sm">
      <div className="space-y-4">
        <div>
          <label className="label">Result</label>
          <select className="input" value={f.result} onChange={e => setF(p => ({ ...p, result: e.target.value }))}>
            <option value="approved">Approved ✓</option>
            <option value="rejected">Rejected ✗</option>
            <option value="conditional">Conditional</option>
          </select>
        </div>
        <div>
          <label className="label">Observations</label>
          <textarea className="input h-24 resize-none" value={f.observations} onChange={e => setF(p => ({ ...p, observations: e.target.value }))} />
        </div>
        <div>
          <label className="label">Corrective Action</label>
          <textarea className="input h-20 resize-none" value={f.corrective_action} onChange={e => setF(p => ({ ...p, corrective_action: e.target.value }))} />
        </div>
        <div className="flex gap-3">
          <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={saving} onClick={async () => {
            setSaving(true);
            await api.post('/production/qc', { job_card_id: jcId, ...f });
            onSave();
          }}>{saving ? 'Saving...' : 'Submit Report'}</button>
        </div>
      </div>
    </Modal>
  );
}

function PackageModal({ jcId, onClose, onSave }) {
  const [file, setFile] = useState(null);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const handleSubmit = async () => {
    if (!file) return setError('Please select an image');
    setSaving(true);
    const fd = new FormData();
    fd.append('file', file); fd.append('job_card_id', jcId); fd.append('notes', notes);
    try { await api.post('/production/package-photos', fd); onSave(); }
    catch (err) { setError(err.response?.data?.error || 'Upload failed'); setSaving(false); }
  };
  return (
    <Modal open title="Upload Package Photo" onClose={onClose} size="sm">
      <div className="space-y-4">
        <FileUpload onFile={setFile} accept=".jpg,.jpeg,.png,.webp" label="Select package photo" />
        <div>
          <label className="label">Notes</label>
          <input className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional" />
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <div className="flex gap-3">
          <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={saving} onClick={handleSubmit}>{saving ? 'Uploading...' : 'Upload'}</button>
        </div>
      </div>
    </Modal>
  );
}

function DailyReportModal({ jcId, assemblies, onClose, onSave }) {
  const [f, setF] = useState({ report_date: new Date().toISOString().split('T')[0], production_step: '', assembly_id: '', qty_produced: '', qty_rejected: '', rejection_reason: '', operator_name: '', operator_feedback: '' });
  const [saving, setSaving] = useState(false);
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));
  return (
    <Modal open title="Daily Production Report" onClose={onClose} size="md">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div><label className="label">Date</label><input className="input" type="date" value={f.report_date} onChange={set('report_date')} /></div>
          <div>
            <label className="label">Assembly</label>
            <select className="input" value={f.assembly_id} onChange={set('assembly_id')}>
              <option value="">All / General</option>
              {assemblies?.map(a => <option key={a.id} value={a.id}>Assembly {a.assembly_no}</option>)}
            </select>
          </div>
          <div className="col-span-2"><label className="label">Production Step *</label><input className="input" placeholder="e.g. Wire Winding, Drawing, Bending..." value={f.production_step} onChange={set('production_step')} required /></div>
          <div><label className="label">Qty Produced</label><input className="input" type="number" value={f.qty_produced} onChange={set('qty_produced')} /></div>
          <div><label className="label">Qty Rejected</label><input className="input" type="number" value={f.qty_rejected} onChange={set('qty_rejected')} /></div>
          <div className="col-span-2"><label className="label">Rejection Reason</label><input className="input" value={f.rejection_reason} onChange={set('rejection_reason')} /></div>
          <div><label className="label">Operator Name</label><input className="input" value={f.operator_name} onChange={set('operator_name')} /></div>
          <div><label className="label">Operator Feedback</label><input className="input" value={f.operator_feedback} onChange={set('operator_feedback')} /></div>
        </div>
        <div className="flex gap-3">
          <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={saving} onClick={async () => {
            setSaving(true);
            await api.post('/production/reports', { job_card_id: jcId, ...f, assembly_id: f.assembly_id || null });
            onSave();
          }}>{saving ? 'Saving...' : 'Submit Report'}</button>
        </div>
      </div>
    </Modal>
  );
}
