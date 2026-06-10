import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import api from '../../lib/api';
import { fmtDate, fmtDateTime, PRODUCTION_STAGES, ACTIVITY_ICONS } from '../../lib/utils';
import StatusBadge from '../../components/ui/StatusBadge';
import {
  ArrowLeft, ClipboardList, FileText, Wrench, FlaskConical, Truck,
  HelpCircle, Package, Image, CheckCircle, Circle, AlertTriangle
} from 'lucide-react';

export default function OrderTimeline() {
  const { orderId } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/customer-queries/order/${orderId}/timeline`)
      .then(r => setData(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [orderId]);

  if (loading) return <div className="p-12 text-center text-gray-400">Loading timeline...</div>;
  if (!data) return <div className="p-12 text-center text-gray-500">Could not load timeline</div>;

  const { order, items, drawings, jobCards, queries, activity } = data;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <Link to={`/orders/${orderId}`} className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-4">
        <ArrowLeft size={14} /> Back to Order
      </Link>

      <h1 className="text-2xl font-bold text-gray-900 mb-1">
        Order Timeline — {order.order_code}
      </h1>
      <p className="text-gray-500 text-sm mb-6">
        Complete journey from order to delivery for {order.customer_code} — {order.customer_name}
      </p>

      {/* ── Order Summary ── */}
      <Section icon={ClipboardList} title="Order" status={order.status} color="blue">
        <div className="grid grid-cols-3 gap-4 text-sm">
          <Info label="Customer" value={`${order.customer_code} — ${order.customer_name}`} />
          <Info label="Order Date" value={fmtDate(order.order_date)} />
          <Info label="Dispatch Date" value={fmtDate(order.dispatch_date)} />
          <Info label="Type" value={order.order_type} />
          <Info label="Status" value={<StatusBadge status={order.status} />} />
          {order.notes && <Info label="Notes" value={order.notes} span={3} />}
        </div>
      </Section>

      {/* ── Items ── */}
      {items.length > 0 && (
        <Section icon={Package} title={`Items (${items.length})`} color="purple">
          <div className="space-y-2">
            {items.map(item => (
              <div key={item.id} className="bg-gray-50 rounded-lg p-3 text-sm">
                <div className="font-medium text-gray-800">{item.description || item.product_code}</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  Qty: {item.qty} | HSN: {item.hsn_code || '—'} | Rate: {item.rate || '—'}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ── Drawings ── */}
      {drawings.length > 0 && (
        <Section icon={Image} title={`Drawings (${drawings.length})`} color="orange">
          <div className="grid grid-cols-2 gap-2">
            {drawings.map(d => (
              <a key={d.id} href={`/uploads/${d.file_path}`} target="_blank" rel="noreferrer"
                className="bg-gray-50 rounded-lg p-2.5 text-sm hover:bg-gray-100 transition-colors flex items-center gap-2">
                <FileText size={16} className="text-orange-500 flex-shrink-0" />
                <div className="min-w-0">
                  <div className="font-medium text-gray-700 truncate">{d.file_name || d.original_name}</div>
                  <div className="text-xs text-gray-400">
                    {d.uploaded_by_name} - {fmtDate(d.created_at)}
                    {d.drawing_status && <span className="ml-1"><StatusBadge status={d.drawing_status} /></span>}
                  </div>
                </div>
              </a>
            ))}
          </div>
        </Section>
      )}

      {/* ── Job Cards ── */}
      {jobCards.map(jc => (
        <div key={jc.id}>
          <Section icon={Wrench} title={`Job Card: ${jc.job_card_no}`} status={jc.status} color="green"
            link={`/job-cards/${jc.id}`}>
            <div className="grid grid-cols-3 gap-3 text-sm mb-3">
              <Info label="Product" value={jc.product_name || jc.drawing_no} />
              <Info label="Qty" value={jc.qty} />
              <Info label="Dispatch Date" value={fmtDate(jc.dispatch_date)} />
            </div>

            {/* Checklist progress */}
            {jc.checklist?.length > 0 && (
              <div className="mt-3">
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Production Checklist</div>
                <div className="flex flex-wrap gap-1">
                  {jc.checklist.map(s => {
                    const def = PRODUCTION_STAGES.find(p => p.no === s.stage_no);
                    const hasRej = (parseInt(s.rejection_qty, 10) || 0) > 0;
                    return (
                      <div key={s.stage_no} className={`text-xs px-2 py-1 rounded-lg border ${
                        s.done
                          ? hasRej ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-green-50 border-green-200 text-green-700'
                          : 'bg-gray-50 border-gray-200 text-gray-400'
                      }`} title={`Stage ${s.stage_no}: ${def?.name || ''} ${hasRej ? `(Rej: ${s.rejection_qty})` : ''}`}>
                        {s.stage_no}
                        {s.done ? <CheckCircle size={9} className="inline ml-0.5" /> : <Circle size={9} className="inline ml-0.5" />}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* QC Reports */}
            {jc.qcReports?.length > 0 && (
              <div className="mt-3">
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">QC Reports</div>
                {jc.qcReports.map(qr => (
                  <div key={qr.id} className="bg-blue-50 border border-blue-100 rounded-lg p-2 text-sm">
                    <div className="flex items-center gap-2">
                      <FlaskConical size={13} className="text-blue-600" />
                      <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                        qr.result === 'approved' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                      }`}>{qr.result}</span>
                      <span className="text-xs text-gray-500">{qr.created_by_name} - {fmtDate(qr.created_at)}</span>
                    </div>
                    {qr.observations && <p className="text-xs text-gray-600 mt-0.5">{qr.observations}</p>}
                    {qr.product_weight && <p className="text-xs text-gray-500">Weight: {qr.product_weight} kg</p>}
                    {qr.file_name && (
                      <a href={`/uploads/qc/${qr.file_name}`} target="_blank" rel="noreferrer"
                        className="text-xs text-blue-600 hover:underline mt-0.5 inline-block">View Report</a>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Dispatch Docs */}
            {jc.dispatchDocs?.length > 0 && (
              <div className="mt-3">
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Dispatch Documents</div>
                <div className="space-y-1">
                  {jc.dispatchDocs.map(dd => (
                    <div key={dd.id} className="bg-gray-50 rounded-lg p-2 text-sm flex items-center gap-2">
                      <Truck size={13} className="text-gray-500" />
                      <span className="font-medium text-gray-700">{dd.doc_type}</span>
                      {dd.shipping_carrier && <span className="text-xs text-gray-500">via {dd.shipping_carrier}</span>}
                      {dd.tracking_number && <span className="text-xs text-gray-400">#{dd.tracking_number}</span>}
                      {dd.file_name && (
                        <a href={`/uploads/dispatch/${dd.file_name}`} target="_blank" rel="noreferrer"
                          className="text-xs text-blue-600 hover:underline ml-auto">View</a>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Section>
        </div>
      ))}

      {/* ── Customer Queries ── */}
      {queries.length > 0 && (
        <Section icon={HelpCircle} title={`Customer Queries (${queries.length})`} color="amber">
          <div className="space-y-2">
            {queries.map(q => (
              <Link key={q.id} to={`/customer-queries/${q.id}`}
                className="block bg-amber-50 border border-amber-200 rounded-lg p-3 hover:bg-amber-100 transition-colors text-sm">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-amber-800">{q.query_no} — {q.subject}</span>
                  <StatusBadge status={q.status} />
                </div>
                <p className="text-xs text-gray-600">{q.description || '—'}</p>
                {q.resolution_summary && (
                  <p className="text-xs text-green-700 mt-1 bg-green-50 px-2 py-1 rounded">
                    Resolution: {q.resolution_summary}
                  </p>
                )}
                {q.return_coupon_no && <p className="text-xs text-gray-500 mt-0.5">Coupon: {q.return_coupon_no}</p>}
                {q.debit_note_no && <p className="text-xs text-gray-500 mt-0.5">Debit Note: {q.debit_note_no}</p>}
              </Link>
            ))}
          </div>
        </Section>
      )}

      {/* ── Activity Log ── */}
      <Section icon={ClipboardList} title="Activity Log" color="gray">
        <div className="space-y-1 max-h-[400px] overflow-y-auto">
          {activity.map(a => (
            <div key={a.id} className="flex items-start gap-2 py-1.5 text-sm border-b border-gray-50 last:border-0">
              <span className="text-base flex-shrink-0 mt-0.5">{ACTIVITY_ICONS[a.activity_type] || '📌'}</span>
              <div className="min-w-0 flex-1">
                <p className="text-gray-700">{a.description}</p>
                <p className="text-xs text-gray-400">{a.created_by_name} - {fmtDateTime(a.created_at)}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

// ── Helpers ──
function Section({ icon: Icon, title, children, status, color = 'gray', link }) {
  const borderColors = {
    blue: 'border-l-blue-500', green: 'border-l-green-500', orange: 'border-l-orange-500',
    purple: 'border-l-purple-500', amber: 'border-l-amber-500', gray: 'border-l-gray-400',
    red: 'border-l-red-500',
  };
  return (
    <div className={`card p-5 mb-4 border-l-4 ${borderColors[color]}`}>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold text-gray-800 uppercase tracking-wider flex items-center gap-2">
          <Icon size={16} className={`text-${color}-500`} />
          {title}
        </h2>
        <div className="flex items-center gap-2">
          {status && <StatusBadge status={status} />}
          {link && <Link to={link} className="text-xs text-brand-600 hover:underline">View Details</Link>}
        </div>
      </div>
      {children}
    </div>
  );
}

function Info({ label, value, span }) {
  return (
    <div className={span ? `col-span-${span}` : ''}>
      <dt className="text-xs text-gray-500 uppercase tracking-wide">{label}</dt>
      <dd className="mt-0.5 font-medium text-gray-700">{value || '—'}</dd>
    </div>
  );
}
