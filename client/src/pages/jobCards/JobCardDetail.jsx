import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import StatusBadge from '../../components/ui/StatusBadge';
import Modal from '../../components/ui/Modal';
import FileUpload from '../../components/ui/FileUpload';
import { fmtDate, fmtDateTime, daysUntil, ACTIVITY_ICONS } from '../../lib/utils';
import { ArrowLeft, Plus, Upload, Printer, CheckCircle, Wrench, FileText, Image, Trash2, PlayCircle } from 'lucide-react';

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

  const load = () => api.get(`/job-cards/${id}`).then(r => setJc(r.data)).finally(() => setLoading(false));
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

  const tabs = [
    { key: 'overview',    label: 'Overview' },
    { key: 'assemblies',  label: `Assemblies (${jc.assemblies?.length || 0})` },
    { key: 'drawings',    label: `Drawings (${jc.drawings?.length || 0})` },
    { key: 'production',  label: 'Production' },
    { key: 'qc',          label: 'Quality' },
    { key: 'dispatch',    label: 'Dispatch' },
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
            {days !== null && !['dispatched'].includes(jc.status) && (
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

      {/* Qty Summary Bar */}
      {jc.qty != null && (
        (() => {
          const originalQty = parseInt(jc.qty, 10) || 0;
          const rejected    = parseInt(jc.total_rejected, 10) || 0;
          const remade      = parseInt(jc.total_remade,   10) || 0;
          const netQty      = jc.net_qty ?? Math.max(originalQty - rejected + remade, 0);
          const isShort     = netQty < originalQty;
          return (
            <div className={`mb-5 rounded-xl border px-5 py-3 flex items-center gap-6 flex-wrap text-sm ${
              isShort ? 'bg-orange-50 border-orange-200' : 'bg-green-50 border-green-200'
            }`}>
              <div className="flex items-center gap-1.5 text-gray-600">
                <span className="text-xs uppercase tracking-wide font-semibold text-gray-500">Original Qty</span>
                <span className="font-bold text-gray-900 ml-1">{originalQty}</span>
              </div>
              {rejected > 0 && (
                <div className="flex items-center gap-1.5 text-red-600">
                  <span className="text-xs uppercase tracking-wide font-semibold">Rejections</span>
                  <span className="font-bold ml-1">− {rejected}</span>
                </div>
              )}
              {remade > 0 && (
                <div className="flex items-center gap-1.5 text-green-600">
                  <span className="text-xs uppercase tracking-wide font-semibold">Remade</span>
                  <span className="font-bold ml-1">+ {remade}</span>
                </div>
              )}
              <div className={`flex items-center gap-1.5 ${isShort ? 'text-orange-700' : 'text-green-700'}`}>
                <span className="text-xs uppercase tracking-wide font-semibold">Dispatchable Qty</span>
                <span className="font-bold text-lg ml-1">{netQty}</span>
                {isShort && <span className="text-xs font-normal text-orange-500 ml-0.5">({originalQty - netQty} short)</span>}
              </div>
            </div>
          );
        })()
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
      {activeTab === 'overview' && <OverviewTab jc={jc} />}
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

function OverviewTab({ jc }) {
  const originalQty = parseInt(jc.qty, 10) || 0;
  const rejected    = parseInt(jc.total_rejected, 10) || 0;
  const remade      = parseInt(jc.total_remade,   10) || 0;
  const netQty      = jc.net_qty ?? Math.max(originalQty - rejected + remade, 0);
  const isShort     = netQty < originalQty;

  return (
    <div className="card p-5">
      <h2 className="section-title mb-4">Job Card Details</h2>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-5">
        {[
          ['Job Card No', jc.job_card_no],
          ['Product', jc.product_name || '—'],
          ['Drawing No', jc.drawing_no || '—'],
          ['Punching', jc.punching || '—'],
          ['Dispatch Date', fmtDate(jc.dispatch_date)],
          ['Order', jc.order_code],
          ['Customer Code', jc.customer_code],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-gray-500 uppercase tracking-wide">{k}</dt>
            <dd className="text-sm font-medium text-gray-900 mt-1">{v}</dd>
          </div>
        ))}
        {/* Qty breakdown */}
        <div className="col-span-2 md:col-span-3">
          <dt className="text-xs text-gray-500 uppercase tracking-wide mb-2">Quantity</dt>
          <div className="flex items-center gap-4 flex-wrap text-sm">
            <span className="text-gray-700">Original: <strong>{originalQty} Nos</strong></span>
            {rejected > 0 && <span className="text-red-600">Rejected: <strong>− {rejected}</strong></span>}
            {remade   > 0 && <span className="text-green-600">Remade: <strong>+ {remade}</strong></span>}
            <span className={`font-semibold px-2 py-0.5 rounded-full text-xs ${isShort ? 'bg-orange-100 text-orange-700' : 'bg-green-100 text-green-700'}`}>
              Dispatchable: {netQty} Nos{isShort ? ` (${originalQty - netQty} short)` : ''}
            </span>
          </div>
        </div>
      </div>
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
  const canDispatch = ['accounts', 'owner'].includes(userRole);

  return (
    <div className="space-y-5">
      <h2 className="section-title">Dispatch Documents</h2>
      {jc.dispatch_docs?.length === 0 ? (
        <div className="card p-6 text-center text-gray-400 text-sm">No dispatch documents yet.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {jc.dispatch_docs.map(d => (
            <div key={d.id} className="card p-4 flex items-center gap-3">
              <FileText size={20} className="text-brand-500 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium capitalize">{d.doc_type?.replace('_', ' ') || 'Document'}</div>
                {d.file_name && (
                  <a href={`/uploads/dispatch/${d.file_name}`} target="_blank" rel="noopener noreferrer"
                    className="text-xs text-brand-600 hover:underline truncate block">{d.file_name}</a>
                )}
                {d.tracking_number && <div className="text-xs text-gray-500">Tracking: {d.tracking_number}</div>}
                <div className="text-xs text-gray-400">{d.created_by_name} · {fmtDate(d.created_at)}</div>
              </div>
            </div>
          ))}
        </div>
      )}

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
            await api.put(`/dispatch/${jc.id}/mark-dispatched`, dispatch);
            onReload();
            setSaving(false);
          }}>
            {saving ? 'Saving...' : '🚚 Mark as Dispatched'}
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
