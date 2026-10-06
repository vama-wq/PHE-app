import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import Modal from '../../components/ui/Modal';
import FileUpload from '../../components/ui/FileUpload';
import StatusBadge from '../../components/ui/StatusBadge';
import { fmtDate, fmtDateTime, downloadExcel, PRODUCTION_STAGES } from '../../lib/utils';
import { compressImages } from '../../lib/compressImage';
import { Upload, Search, BarChart2, Download, X, CheckCircle, Circle, AlertTriangle, ArrowRight, HelpCircle, DollarSign } from 'lucide-react';

// Route label helper
function routeLabel(route, dispQty, fgQty) {
  if (!route) return null;
  if (route === 'dispatch')        return `${dispQty ?? '—'} units → Dispatch`;
  if (route === 'finished_goods')  return `${fgQty ?? '—'} units → Finished Goods`;
  if (route === 'both')            return `${fgQty ?? '—'} → Finished Goods  +  ${dispQty ?? '—'} → Dispatch`;
  if (route === 'split')           return `${fgQty ?? '—'} → Finished Goods (IO)  +  ${dispQty ?? '—'} → Dispatch`;
  return route;
}

// Who passed the card at Product QC and at Inventory QC, and what Inventory QC
// changed (owner, 6 Oct 2026) — so dispatch sees the card was checked twice.
// Cards approved before Inventory QC existed show neither line.
function QcPassInfo({ jc, className = '' }) {
  if (!jc.product_qc_at && !jc.inventory_qc_at) return null;
  const n = Number(jc.inventory_qc_changes) || 0;
  const extra = [
    Number(jc.inventory_qc_rework) > 0 && `rework ${jc.inventory_qc_rework}`,
    Number(jc.inventory_qc_scrap) > 0 && `scrap ${jc.inventory_qc_scrap}`,
  ].filter(Boolean);
  return (
    <div className={`text-xs text-gray-500 space-y-0.5 ${className}`}>
      {jc.product_qc_at && (
        <div>Product QC: {jc.product_qc_by_name || '—'}, {fmtDateTime(jc.product_qc_at)}</div>
      )}
      {jc.inventory_qc_at && (
        <div>
          Inventory QC: {jc.inventory_qc_by_name || '—'}, {fmtDateTime(jc.inventory_qc_at)}
          {' · '}{n === 0 ? 'no changes' : `${n} change${n !== 1 ? 's' : ''}`}
          {extra.length > 0 && ` (${extra.join(', ')})`}
        </div>
      )}
    </div>
  );
}

export default function DispatchList() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(null);   // job card object
  const [showSummary, setShowSummary] = useState(null); // job card object
  const [showNewQuery, setShowNewQuery] = useState(null); // job card object for new query

  const [priceRequested, setPriceRequested] = useState({});

  // Filters
  const [search, setSearch] = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [productFilter, setProductFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo]     = useState('');

  const load = () => api.get('/job-cards').then(r => {
    const relevant = r.data.filter(jc =>
      ['qc_approved','packaging','ready_for_dispatch','dispatched',
       'customer_query','product_return','repair_in_progress','repaired_dispatched','resolved_dispatched'].includes(jc.status)
      // Cards QC-routed entirely into Finished Goods have nothing to dispatch
      && !(jc.status === 'qc_approved' && jc.qc_route === 'finished_goods' && (Number(jc.qc_dispatch_qty) || 0) === 0)
    );
    setCards(relevant);
  }).finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  // Unique filter options
  const clientOptions = useMemo(() =>
    [...new Set(cards.map(jc => jc.customer_code).filter(Boolean))].sort(), [cards]);
  const productOptions = useMemo(() =>
    [...new Set(cards.map(jc => jc.product_name || jc.drawing_no).filter(Boolean))].sort(), [cards]);

  const filtered = useMemo(() => {
    let r = cards;
    if (search) {
      const s = search.toLowerCase();
      r = r.filter(jc =>
        jc.job_card_no.toLowerCase().includes(s) ||
        (jc.order_code || '').toLowerCase().includes(s) ||
        (jc.customer_code || '').toLowerCase().includes(s) ||
        (jc.drawing_no || '').toLowerCase().includes(s) ||
        (jc.product_name || '').toLowerCase().includes(s)
      );
    }
    if (clientFilter) r = r.filter(jc => jc.customer_code === clientFilter);
    if (productFilter) r = r.filter(jc =>
      (jc.product_name || jc.drawing_no) === productFilter
    );
    if (statusFilter) r = r.filter(jc => jc.status === statusFilter);
    if (dateFrom) r = r.filter(jc => jc.dispatch_date && jc.dispatch_date >= dateFrom);
    if (dateTo)   r = r.filter(jc => jc.dispatch_date && jc.dispatch_date <= dateTo);
    return r;
  }, [cards, search, clientFilter, productFilter, statusFilter, dateFrom, dateTo]);

  const hasFilters = search || clientFilter || productFilter || statusFilter || dateFrom || dateTo;
  const clearFilters = () => {
    setSearch(''); setClientFilter(''); setProductFilter(''); setStatusFilter(''); setDateFrom(''); setDateTo('');
  };

  const canManage = ['accounts', 'owner'].includes(user.role);

  // Group filtered job cards by order
  const orderGroups = useMemo(() => {
    const map = new Map();
    for (const jc of filtered) {
      const key = jc.order_id;
      if (!map.has(key)) {
        map.set(key, { order_id: jc.order_id, order_code: jc.order_code, customer_code: jc.customer_code, cards: [] });
      }
      map.get(key).cards.push(jc);
    }
    return [...map.values()];
  }, [filtered]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dispatch</h1>
          <p className="text-gray-500 text-sm mt-0.5">
            {orderGroups.length} order{orderGroups.length !== 1 ? 's' : ''} · {filtered.length} job card{filtered.length !== 1 ? 's' : ''}
          </p>
        </div>
        {canManage && (
          <button className="btn-secondary flex items-center gap-1.5 text-sm"
            onClick={() => downloadExcel('dispatch-checklist', 'dispatch_checklist.xlsx')}>
            <Download size={15} /> Export Checklist
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-5">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search size={16} className="absolute left-3 top-2.5 text-gray-400" />
          <input className="input pl-9" placeholder="Search order, job card, drawing, product..."
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="input max-w-[180px]" value={clientFilter}
          onChange={e => setClientFilter(e.target.value)}>
          <option value="">All Clients</option>
          {clientOptions.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="input max-w-[220px]" value={productFilter}
          onChange={e => setProductFilter(e.target.value)}>
          <option value="">All Products</option>
          {productOptions.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className="input max-w-[160px]" value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="qc_approved">QC Approved</option>
          <option value="packaging">Packaging</option>
          <option value="dispatched">Dispatched</option>
          <option value="resolved_dispatched">Query Resolved</option>
          <option value="customer_query">Query Raised</option>
          <option value="product_return">Product Return</option>
          <option value="repair_in_progress">Repair In Progress</option>
        </select>
        <input type="date" className="input w-[140px]" value={dateFrom}
          onChange={e => setDateFrom(e.target.value)} title="Dispatch date from" />
        <input type="date" className="input w-[140px]" value={dateTo}
          onChange={e => setDateTo(e.target.value)} title="Dispatch date to" />
        {hasFilters && (
          <button className="btn-ghost text-sm flex items-center gap-1 text-gray-500"
            onClick={clearFilters}>
            <X size={14} /> Clear
          </button>
        )}
      </div>

      {loading ? (
        <div className="text-center text-gray-400 py-12">Loading...</div>
      ) : orderGroups.length === 0 ? (
        <div className="text-center text-gray-400 py-12">
          {hasFilters ? 'No results match your filters' : 'No jobs in dispatch pipeline yet'}
        </div>
      ) : (
        <div className="space-y-4">
          {orderGroups.map(group => {
            const allDispatched = group.cards.every(jc => ['dispatched','resolved_dispatched'].includes(jc.status));
            return (
              <div key={group.order_id} className="card overflow-hidden">
                {/* Order header */}
                <div className={`px-5 py-3 border-b flex items-center justify-between ${
                  allDispatched ? 'bg-green-50 border-green-100' : 'bg-gray-50 border-gray-200'
                }`}>
                  <div className="flex items-center gap-3">
                    <Link to={`/orders/${group.order_id}`}
                      className="font-bold text-brand-700 hover:underline text-sm">
                      {group.order_code}
                    </Link>
                    <span className="text-sm text-gray-600 font-medium">{group.customer_code}</span>
                    <span className="text-xs text-gray-400">
                      {group.cards.length} job card{group.cards.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  {allDispatched && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium flex items-center gap-1">
                      <CheckCircle size={11} /> All Dispatched
                    </span>
                  )}
                </div>

                {/* Job cards table */}
                <table className="w-full">
                  <thead className="bg-gray-50/50 border-b border-gray-100">
                    <tr>
                      <th className="table-header text-left">Job Card</th>
                      <th className="table-header text-left">Product / Drawing</th>
                      <th className="table-header text-right">QC Approved Qty</th>
                      <th className="table-header text-left">Dispatch Date</th>
                      <th className="table-header text-left">Status</th>
                      <th className="table-header text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {group.cards.map(jc => {
                      const dispQty = jc.qc_dispatch_qty != null ? jc.qc_dispatch_qty : jc.net_qty;
                      return (
                        <tr key={jc.id} className="hover:bg-gray-50">
                          <td className="table-cell">
                            <Link to={`/job-cards/${jc.id}`}
                              className="font-semibold text-brand-700 hover:underline">
                              {jc.job_card_no}
                            </Link>
                          </td>
                          <td className="table-cell text-sm">
                            {jc.product_name && <div className="font-medium text-gray-800">{jc.product_name}</div>}
                            {jc.drawing_no && <div className="text-xs text-gray-400">{jc.drawing_no}</div>}
                          </td>
                          <td className="table-cell text-right">
                            {jc.status === 'dispatched' && jc.dispatched_qty
                              ? <span className="font-semibold text-gray-800">{jc.dispatched_qty}</span>
                              : dispQty != null && dispQty !== jc.qty
                                ? <span>
                                    <span className="font-semibold text-orange-600">{dispQty}</span>
                                    <span className="text-xs text-gray-400 ml-1">of {jc.qty}</span>
                                  </span>
                                : <span className="font-semibold text-gray-800">{dispQty ?? jc.qty}</span>
                            }
                            {jc.qc_route && (
                              <div className="text-xs text-gray-400 mt-0.5">
                                {jc.qc_route === 'finished_goods' ? 'All → FG'
                                 : jc.qc_route === 'both' || jc.qc_route === 'split'
                                   ? `FG: ${jc.qc_fg_qty} + Dispatch: ${jc.qc_dispatch_qty}`
                                   : 'All → Dispatch'}
                              </div>
                            )}
                          </td>
                          <td className="table-cell">
                            <div className="text-sm">{fmtDate(jc.dispatch_date)}</div>
                            {jc.dispatched_at && (
                              <div className="text-xs text-green-600 font-medium">Dispatched {fmtDate(jc.dispatched_at)}</div>
                            )}
                          </td>
                          <td className="table-cell">
                            <StatusBadge jc={jc} />
                            <QcPassInfo jc={jc} className="mt-1" />
                          </td>
                          <td className="table-cell text-right">
                            <div className="flex items-center justify-end gap-2">
                              <button
                                className="btn-secondary btn-sm flex items-center gap-1 text-xs py-1 px-2"
                                onClick={() => setShowSummary(jc)}
                                title="View checklist summary">
                                <BarChart2 size={13} /> Summary
                              </button>
                              {canManage && !['dispatched','resolved_dispatched'].includes(jc.status) && (
                                (priceRequested[jc.id] || parseInt(jc.price_requested) > 0) ? (
                                  <span className="text-xs text-green-600 font-medium px-2 py-1">Price Requested</span>
                                ) : (
                                  <button
                                    className="btn-sm flex items-center gap-1 text-xs py-1 px-2 bg-purple-100 text-purple-800 hover:bg-purple-200 rounded-lg font-medium transition-colors"
                                    onClick={async () => {
                                      try {
                                        await api.post('/dispatch/request-price', { job_card_id: jc.id });
                                        setPriceRequested(p => ({ ...p, [jc.id]: true }));
                                      } catch (e) { alert(e.response?.data?.error || 'Failed'); }
                                    }}
                                    title="Request price from owner for this item">
                                    <DollarSign size={13} /> Request Price
                                  </button>
                                )
                              )}
                              {canManage && !['dispatched','customer_query','product_return','repair_in_progress','repaired_dispatched','resolved_dispatched'].includes(jc.status) && (
                                <button
                                  className="btn-primary btn-sm flex items-center gap-1 text-xs py-1 px-2"
                                  onClick={() => setShowUpload(jc)}>
                                  <Upload size={13} /> Dispatch
                                </button>
                              )}
                              {['dispatched','resolved_dispatched'].includes(jc.status) && canManage && (
                                <button
                                  className="btn-sm flex items-center gap-1 text-xs py-1 px-2 bg-amber-100 text-amber-800 hover:bg-amber-200 rounded-lg font-medium transition-colors"
                                  onClick={() => setShowNewQuery(jc)}>
                                  <HelpCircle size={13} /> Customer Query
                                </button>
                              )}
                              {['customer_query','product_return','repair_in_progress'].includes(jc.status) && (
                                <Link to={`/customer-queries?order_id=${jc.order_id}`}
                                  className="btn-sm flex items-center gap-1 text-xs py-1 px-2 bg-rose-100 text-rose-800 hover:bg-rose-200 rounded-lg font-medium transition-colors">
                                  <HelpCircle size={13} /> View Query
                                </Link>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}

      {showUpload && (
        <DispatchDocModal
          jc={showUpload}
          onClose={() => setShowUpload(null)}
          onSave={() => { setShowUpload(null); load(); }} />
      )}

      {showSummary && (
        <ChecklistSummaryModal
          jc={showSummary}
          onClose={() => setShowSummary(null)} />
      )}

      {showNewQuery && (
        <NewQueryModal
          jc={showNewQuery}
          onClose={() => setShowNewQuery(null)}
          onCreated={(queryId) => { setShowNewQuery(null); navigate(`/customer-queries/${queryId}`); }} />
      )}
    </div>
  );
}

// ── Checklist Summary Modal ────────────────────────────────────────────────────
function ChecklistSummaryModal({ jc, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get(`/job-cards/${jc.id}/checklist`),
      api.get(`/qc/${jc.id}/reports`),
      api.get(`/customer-queries/order/${jc.order_id}`).catch(() => ({ data: [] })),
    ]).then(([cl, qcR, cqR]) => {
      setData({ checklist: cl.data, qcReports: qcR.data, queries: cqR.data });
    }).finally(() => setLoading(false));
  }, [jc.id]);

  const stages = data?.checklist?.stages || [];
  const doneStages = stages.filter(s => s.done);
  const qcReport = data?.qcReports?.[0];

  const totalRejected = stages.reduce((a, s) => a + (parseInt(s.rejection_qty, 10) || 0), 0);
  const totalRemade   = stages.filter(s => s.stage_no !== 29)
                               .reduce((a, s) => a + (parseInt(s.remade_qty, 10) || 0), 0);

  return (
    <Modal open title={`Checklist Summary — ${jc.job_card_no}`} onClose={onClose} size="xl">
      {loading ? (
        <div className="py-12 text-center text-gray-400">Loading...</div>
      ) : (
        <div className="space-y-5">

          {/* ── Header Stats ── */}
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: 'Original Qty', value: jc.qty, color: 'text-gray-800' },
              { label: 'Total Rejected', value: totalRejected, color: totalRejected > 0 ? 'text-red-600' : 'text-gray-800' },
              { label: 'Remade', value: totalRemade, color: totalRemade > 0 ? 'text-amber-600' : 'text-gray-800' },
              { label: 'Net Qty', value: jc.net_qty ?? jc.qty, color: 'text-green-700' },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-gray-50 rounded-xl p-3 text-center border border-gray-100">
                <div className={`text-2xl font-bold ${color}`}>{value}</div>
                <div className="text-xs text-gray-500 mt-0.5">{label}</div>
              </div>
            ))}
          </div>

          {/* ── QC Routing ── */}
          {jc.qc_route && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-3 flex items-center gap-2">
              <CheckCircle size={16} className="text-green-600 flex-shrink-0" />
              <div>
                <span className="text-sm font-semibold text-green-800">QC Approved — </span>
                <span className="text-sm text-green-700">
                  {routeLabel(jc.qc_route, jc.qc_dispatch_qty, jc.qc_fg_qty)}
                </span>
                <QcPassInfo jc={jc} className="mt-0.5" />
              </div>
            </div>
          )}

          {/* ── QC Report Info ── */}
          {qcReport && (
            <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm space-y-1">
              <div className="font-semibold text-blue-800 flex items-center gap-1.5">
                QC Report
                <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                  qcReport.result === 'approved' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                }`}>{qcReport.result}</span>
              </div>
              {qcReport.observations && <div className="text-gray-600"><span className="font-medium">Observations:</span> {qcReport.observations}</div>}
              {qcReport.product_weight && <div className="text-gray-600"><span className="font-medium">Product Weight:</span> {qcReport.product_weight} kg</div>}
            </div>
          )}

          {/* ── Stage Progress ── */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-gray-700">Production Stages</h3>
              <span className="text-xs text-gray-500">{doneStages.length} / {stages.length} completed</span>
            </div>

            {/* Progress bar */}
            <div className="w-full bg-gray-100 rounded-full h-1.5 mb-3">
              <div
                className="bg-brand-600 h-1.5 rounded-full transition-all"
                style={{ width: `${stages.length ? (doneStages.length / stages.length) * 100 : 0}%` }}
              />
            </div>

            <div className="divide-y divide-gray-100 border border-gray-200 rounded-xl overflow-hidden">
              {stages.map(s => {
                const def = PRODUCTION_STAGES.find(p => p.no === s.stage_no);
                const hasRejection = (parseInt(s.rejection_qty, 10) || 0) > 0;
                const hasRemade    = (parseInt(s.remade_qty, 10) || 0) > 0;
                const hasPhoto     = s.photo_file || s.rejection_photo_file;
                return (
                  <div key={s.stage_no}
                    className={`flex items-start gap-3 px-3 py-2 text-sm ${
                      !s.done ? 'bg-gray-50 text-gray-400' : 'bg-white'
                    }`}>
                    {/* Status icon */}
                    <div className="flex-shrink-0 mt-0.5">
                      {s.done
                        ? <CheckCircle size={15} className="text-green-500" />
                        : <Circle size={15} className="text-gray-300" />
                      }
                    </div>

                    {/* Stage info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`font-medium ${s.done ? 'text-gray-800' : 'text-gray-400'}`}>
                          {s.stage_no}. {def?.name || `Stage ${s.stage_no}`}
                        </span>
                        {hasRejection && (
                          <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
                            <AlertTriangle size={10} /> Rej: {s.rejection_qty}
                          </span>
                        )}
                        {hasRemade && (
                          <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">
                            Remade: {s.remade_qty}
                          </span>
                        )}
                        {s.scrap_value && (
                          <span className="text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-full">
                            Scrap: {s.scrap_value}
                          </span>
                        )}
                      </div>
                      {/* Values + worker */}
                      <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-0.5">
                        {def?.hvLight && s.value1 ? (() => {
                          let d = {};
                          try { d = JSON.parse(s.value1); } catch { d = { light: s.value1 }; }
                          return (
                            <>
                              <span className={`text-xs font-medium ${d.hv === 'pass' ? 'text-green-600' : d.hv === 'fail' ? 'text-red-600' : 'text-gray-400'}`}>
                                HV {d.hv === 'pass' ? '✅' : d.hv === 'fail' ? `❌ (${d.hvCount || ''} — ${d.hvReason || ''})` : '—'}
                              </span>
                              <span className={`text-xs font-medium ${d.light === 'pass' ? 'text-green-600' : d.light === 'fail' ? 'text-red-600' : 'text-gray-400'}`}>
                                Light {d.light === 'pass' ? '✅' : d.light === 'fail' ? `❌ (${d.lightCount || ''} — ${d.lightReason || ''})` : '—'}
                              </span>
                              {d.ohms && <span className="text-xs text-gray-500">Ohms: <span className="text-gray-700">{d.ohms}</span></span>}
                            </>
                          );
                        })() : (
                          <>
                            {s.value1 && <span className="text-xs text-gray-500">{def?.fields?.[0]?.label || 'Value 1'}: <span className="text-gray-700">{s.value1}</span></span>}
                            {s.value2 && <span className="text-xs text-gray-500">{def?.fields?.[1]?.label || 'Value 2'}: <span className="text-gray-700">{s.value2}</span></span>}
                          </>
                        )}
                        {s.worker_name && <span className="text-xs text-gray-500">{s.stage_no === 16 ? 'Vendor' : 'Worker'}: <span className="text-gray-700">{s.worker_name}</span></span>}
                        {s.done_at && <span className="text-xs text-gray-400">{fmtDateTime(s.done_at)}</span>}
                        {s.stage_no === 29 && s.dispatched_qty != null && (
                          <span className="text-xs text-gray-500">Ready Qty: <span className="font-semibold text-gray-700">{s.dispatched_qty}</span></span>
                        )}
                      </div>
                      {/* Photos row */}
                      {hasPhoto && (
                        <div className="flex gap-1.5 mt-1.5 flex-wrap">
                          {s.photo_file && (
                            <a href={`/uploads/checklist-photos/${s.photo_file}`} target="_blank" rel="noreferrer">
                              <img src={`/uploads/checklist-photos/${s.photo_file}`} alt="stage"
                                className="w-12 h-12 object-cover rounded border border-gray-200 hover:opacity-80 transition-opacity" />
                            </a>
                          )}
                          {s.rejection_photo_file && (
                            <a href={`/uploads/rejection-photos/${s.rejection_photo_file}`} target="_blank" rel="noreferrer">
                              <img src={`/uploads/rejection-photos/${s.rejection_photo_file}`} alt="rejection"
                                className="w-12 h-12 object-cover rounded border border-red-200 hover:opacity-80 transition-opacity" />
                            </a>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Customer Queries ── */}
          {data?.queries?.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Customer Queries</h3>
              <div className="space-y-2">
                {data.queries.map(q => (
                  <Link key={q.id} to={`/customer-queries/${q.id}`} onClick={onClose}
                    className="block bg-amber-50 border border-amber-200 rounded-lg p-2.5 hover:bg-amber-100 transition-colors">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-amber-800">{q.query_no}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        q.status === 'open' ? 'bg-red-100 text-red-700' :
                        q.status === 'in_progress' ? 'bg-amber-100 text-amber-700' :
                        q.status === 'resolved' ? 'bg-green-100 text-green-700' :
                        'bg-rose-100 text-rose-700'
                      }`}>{q.status.replace(/_/g, ' ')}</span>
                    </div>
                    <p className="text-xs text-amber-700 mt-0.5 truncate">{q.subject}</p>
                    {q.resolution_summary && (
                      <p className="text-xs text-green-700 mt-0.5 truncate">Resolution: {q.resolution_summary}</p>
                    )}
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* ── Footer link ── */}
          <div className="flex justify-between items-center pt-1">
            <Link to={`/job-cards/${jc.id}`}
              className="text-sm text-brand-600 hover:underline flex items-center gap-1"
              onClick={onClose}>
              Open full checklist <ArrowRight size={13} />
            </Link>
            <button className="btn-secondary" onClick={onClose}>Close</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Dispatch Doc Modal ─────────────────────────────────────────────────────────
function DispatchDocModal({ jc, onClose, onSave }) {
  const [docs, setDocs] = useState([]);       // existing uploaded docs
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [editingDoc, setEditingDoc] = useState(null); // doc being edited

  // Invoice form
  const [invoiceFile, setInvoiceFile] = useState(null);
  const [invoiceUploaded, setInvoiceUploaded] = useState(false);

  // Additional doc form
  const [addDocType, setAddDocType] = useState('packing_list');
  const [addDocFile, setAddDocFile] = useState(null);
  const [showAddDoc, setShowAddDoc] = useState(false);

  // Dispatch fields
  const [f, setF] = useState({
    shipping_carrier: '', tracking_number: '',
    dispatch_date: new Date().toISOString().split('T')[0], notes: ''
  });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));

  const dispQty = jc.qc_dispatch_qty != null ? jc.qc_dispatch_qty : jc.net_qty ?? jc.qty;

  // Load existing docs
  const loadDocs = () => {
    api.get(`/dispatch/job-card/${jc.id}`).then(r => {
      setDocs(r.data);
      const hasInvoice = r.data.some(d => d.doc_type === 'invoice');
      setInvoiceUploaded(hasInvoice);
    }).finally(() => setLoadingDocs(false));
  };
  useEffect(() => { loadDocs(); }, [jc.id]);

  // Upload invoice
  const handleUploadInvoice = async () => {
    if (!invoiceFile) { setError('Please select an invoice file'); return; }
    setUploading(true); setError('');
    const fd = new FormData();
    fd.append('job_card_id', jc.id);
    fd.append('doc_type', 'invoice');
    fd.append('file', invoiceFile);
    try {
      await api.post('/dispatch', fd);
      setInvoiceFile(null);
      loadDocs();
    } catch (err) { setError(err.response?.data?.error || 'Upload failed'); }
    setUploading(false);
  };

  // Upload additional doc
  const handleUploadAdditional = async () => {
    if (!addDocFile) { setError('Please select a file'); return; }
    setUploading(true); setError('');
    const fd = new FormData();
    fd.append('job_card_id', jc.id);
    fd.append('doc_type', addDocType);
    fd.append('file', addDocFile);
    try {
      await api.post('/dispatch', fd);
      setAddDocFile(null);
      setShowAddDoc(false);
      loadDocs();
    } catch (err) { setError(err.response?.data?.error || 'Upload failed'); }
    setUploading(false);
  };

  // Edit (replace) an existing doc
  const handleEditDoc = async (docId, newFile, newDocType) => {
    if (!newFile && !newDocType) return;
    setUploading(true); setError('');
    const fd = new FormData();
    if (newDocType) fd.append('doc_type', newDocType);
    if (newFile) fd.append('file', newFile);
    try {
      await api.put(`/dispatch/doc/${docId}`, fd);
      setEditingDoc(null);
      loadDocs();
    } catch (err) { setError(err.response?.data?.error || 'Update failed'); }
    setUploading(false);
  };

  // Delete doc
  const handleDeleteDoc = async (docId) => {
    if (!confirm('Delete this document?')) return;
    try {
      await api.delete(`/dispatch/${docId}`);
      loadDocs();
    } catch (err) { setError(err.response?.data?.error || 'Delete failed'); }
  };

  // Final dispatch
  const handleDispatch = async () => {
    if (!f.shipping_carrier.trim()) { setError('Shipping carrier is required'); return; }
    if (!f.tracking_number.trim())  { setError('Tracking number is required'); return; }
    setSaving(true); setError('');
    try {
      await api.put(`/dispatch/${jc.id}/mark-dispatched`, f);
      onSave();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed');
      setSaving(false);
    }
  };

  const invoiceDoc = docs.find(d => d.doc_type === 'invoice');
  const otherDocs = docs.filter(d => d.doc_type !== 'invoice');
  // Repaired returns AND replacement cards were already invoiced on the original
  // dispatch — a new invoice here would double-count the sale, so it's optional.
  const isRepair = jc.active_query_status === 'product_return' && jc.active_query_return_type === 'repair';
  const isReplacement = !!jc.replacement_query_id;
  const invoiceOptional = isRepair || isReplacement;
  const optionalReason = isReplacement ? 'replacement — already invoiced' : 'repaired return';

  return (
    <Modal open title={`Dispatch — ${jc.job_card_no}`} onClose={onClose} size="lg">
      <div className="mb-4 bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 text-sm">
        <span className="text-blue-700 font-medium">QC-approved dispatch qty: </span>
        <span className="font-bold text-blue-900">{dispQty}</span>
        {jc.qc_route && (
          <span className="text-blue-600 ml-2">({routeLabel(jc.qc_route, jc.qc_dispatch_qty, jc.qc_fg_qty)})</span>
        )}
        <QcPassInfo jc={jc} className="mt-1" />
      </div>

      <div className="space-y-5">
        {/* ── Step 1: Invoice (mandatory, except repaired returns) ── */}
        <div className={`rounded-xl border-2 p-4 ${invoiceUploaded ? 'border-green-200 bg-green-50' : invoiceOptional ? 'border-gray-200 bg-gray-50' : 'border-red-200 bg-red-50'}`}>
          <div className="flex items-center gap-2 mb-2">
            {invoiceUploaded
              ? <CheckCircle size={18} className="text-green-600" />
              : <AlertTriangle size={18} className={invoiceOptional ? 'text-gray-400' : 'text-red-500'} />
            }
            <h3 className="font-semibold text-sm">
              {invoiceUploaded ? 'Invoice Uploaded' : invoiceOptional ? `Invoice (optional — ${optionalReason})` : 'Invoice Required *'}
            </h3>
          </div>
          {invoiceOptional && !invoiceUploaded && (
            <p className="text-xs text-gray-500 mb-2">No invoice needed — this was already invoiced on the original dispatch. Add a transport document below only if there's an extra freight charge.</p>
          )}

          {invoiceDoc ? (
            <div className="flex items-center justify-between bg-white rounded-lg border border-gray-200 p-2.5">
              <div className="flex items-center gap-2 text-sm">
                <Upload size={14} className="text-green-600" />
                <a href={`/uploads/${invoiceDoc.file_path}`} target="_blank" rel="noreferrer"
                  className="text-brand-700 hover:underline font-medium">{invoiceDoc.file_name}</a>
                <span className="text-xs text-gray-400">Invoice</span>
              </div>
              <div className="flex gap-1">
                <button className="text-xs text-blue-600 hover:underline" onClick={() => setEditingDoc(invoiceDoc)}>Edit</button>
                <span className="text-gray-300">|</span>
                <button className="text-xs text-red-600 hover:underline" onClick={() => handleDeleteDoc(invoiceDoc.id)}>Delete</button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <FileUpload onFile={setInvoiceFile} accept=".pdf,.jpg,.jpeg,.png" label="Select Invoice *" />
              <button className="btn-primary btn-sm px-4 flex-shrink-0 self-end"
                onClick={handleUploadInvoice} disabled={uploading || !invoiceFile}>
                {uploading ? 'Uploading...' : 'Upload Invoice'}
              </button>
            </div>
          )}
        </div>

        {/* ── Additional Documents (optional) ── */}
        <div className="border border-gray-200 rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold text-sm text-gray-700">Additional Documents (Optional)</h3>
            {!showAddDoc && (
              <button className="btn-secondary btn-sm text-xs" onClick={() => setShowAddDoc(true)}>
                + Add Document
              </button>
            )}
          </div>

          {/* Existing additional docs */}
          {otherDocs.length > 0 && (
            <div className="space-y-1.5 mb-3">
              {otherDocs.map(doc => (
                <div key={doc.id} className="flex items-center justify-between bg-gray-50 rounded-lg border border-gray-100 p-2">
                  <div className="flex items-center gap-2 text-sm">
                    <Upload size={13} className="text-gray-500" />
                    <a href={`/uploads/${doc.file_path}`} target="_blank" rel="noreferrer"
                      className="text-brand-700 hover:underline">{doc.file_name}</a>
                    <span className="text-xs text-gray-400 capitalize">{(doc.doc_type || '').replace(/_/g, ' ')}</span>
                  </div>
                  <div className="flex gap-1">
                    <button className="text-xs text-blue-600 hover:underline" onClick={() => setEditingDoc(doc)}>Edit</button>
                    <span className="text-gray-300">|</span>
                    <button className="text-xs text-red-600 hover:underline" onClick={() => handleDeleteDoc(doc.id)}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Add new doc form */}
          {showAddDoc && (
            <div className="bg-gray-50 rounded-lg p-3 space-y-2">
              <select className="input text-sm" value={addDocType} onChange={e => setAddDocType(e.target.value)}>
                <option value="packing_list">Packing List</option>
                <option value="delivery_challan">Delivery Challan</option>
                <option value="eway_bill">E-Way Bill</option>
                <option value="other">Other</option>
              </select>
              <FileUpload onFile={setAddDocFile} accept=".pdf,.jpg,.jpeg,.png" label="Select Document" />
              <div className="flex gap-2">
                <button className="btn-ghost btn-sm text-xs" onClick={() => setShowAddDoc(false)}>Cancel</button>
                <button className="btn-primary btn-sm text-xs" onClick={handleUploadAdditional}
                  disabled={uploading || !addDocFile}>
                  {uploading ? 'Uploading...' : 'Upload'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Step 2: Shipping Details & Dispatch ── */}
        <div className="border border-gray-200 rounded-xl p-4">
          <h3 className="font-semibold text-sm text-gray-700 mb-3">Shipping Details</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Shipping Carrier <span className="text-red-500">*</span></label>
              <input className="input" placeholder="e.g. DTDC" value={f.shipping_carrier} onChange={set('shipping_carrier')} />
            </div>
            <div>
              <label className="label">Tracking No <span className="text-red-500">*</span></label>
              <input className="input" value={f.tracking_number} onChange={set('tracking_number')} />
            </div>
            <div>
              <label className="label">Dispatch Date</label>
              <input className="input" type="date" value={f.dispatch_date} onChange={set('dispatch_date')} />
            </div>
            <div>
              <label className="label">Notes</label>
              <input className="input" value={f.notes} onChange={set('notes')} />
            </div>
          </div>
        </div>

        {error && <p className="text-red-600 text-sm">{error}</p>}

        <div className="flex gap-3">
          <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" onClick={handleDispatch}
            disabled={saving || (!invoiceUploaded && !invoiceOptional)}
            title={!invoiceUploaded && !invoiceOptional ? 'Upload an invoice first' : ''}>
            {saving ? 'Dispatching...' : 'Mark as Dispatched'}
          </button>
        </div>
      </div>

      {/* Edit Document Modal */}
      {editingDoc && (
        <EditDocModal doc={editingDoc} onClose={() => setEditingDoc(null)}
          onSave={(newFile, newDocType) => handleEditDoc(editingDoc.id, newFile, newDocType)} />
      )}
    </Modal>
  );
}

// ── Edit Document Sub-Modal ──────────────────────────────────────────────────
function EditDocModal({ doc, onClose, onSave }) {
  const [file, setFile] = useState(null);
  const [docType, setDocType] = useState(doc.doc_type || 'invoice');

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-[60]" onClick={onClose}>
      <div className="bg-white rounded-xl p-5 max-w-md w-full shadow-xl" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-4">Edit Document</h3>
        <div className="space-y-3">
          <div>
            <label className="label">Document Type</label>
            <select className="input" value={docType} onChange={e => setDocType(e.target.value)}>
              <option value="invoice">Invoice</option>
              <option value="packing_list">Packing List</option>
              <option value="delivery_challan">Delivery Challan</option>
              <option value="eway_bill">E-Way Bill</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label className="label">Current File</label>
            <a href={`/uploads/${doc.file_path}`} target="_blank" rel="noreferrer"
              className="text-sm text-brand-700 hover:underline block mb-1">{doc.file_name}</a>
          </div>
          <FileUpload onFile={setFile} accept=".pdf,.jpg,.jpeg,.png" label="Replace with new file (optional)" />
          <div className="flex gap-3 pt-2">
            <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
            <button className="btn-primary flex-1" onClick={() => onSave(file, docType)}>
              Save Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── New Customer Query Modal ──────────────────────────────────────────────────
// A query names the pieces that came back, not the whole card (owner, 6 Oct
// 2026: "out of 50 nos only 3 are coming back for repair, return or
// replacement"). Fewer than all the pieces → the server cuts them onto their
// own card <orig>-Q<n> and ties the query to that card, so repair / debit note /
// replacement act on 3 pieces, not 50. The owner may also correct the job card
// document, product name and drawing no on that new card ("just in case they
// were wrong completely") — the same corrections never apply to the original
// card from here, so the expander only shows when a split will happen.
function NewQueryModal({ jc, onClose, onCreated }) {
  // The pieces that went out on this card — what QC routed to dispatch, or the
  // card qty for a card dispatched before QC routing existed (same rule as the server)
  const pieces = Number(jc.qc_dispatch_qty) > 0 ? Number(jc.qc_dispatch_qty) : Number(jc.qty) || 0;
  // What the new card will be called: -Q1, -Q2… The server numbers it by ALL
  // the -Q children already cut off this card; this list only sees the ones in
  // dispatch statuses, so the number is shown as "-Q…" and the real card no
  // comes back with the created query.
  const nextQNo = `${jc.job_card_no}-Q…`;

  const [f, setF] = useState({
    subject: '', description: '', category: 'general',
    priority: 'medium', assigned_department: 'production',
  });
  const [qty, setQty] = useState(String(pieces));
  const [showFix, setShowFix] = useState(false);
  const [fix, setFix] = useState({ product_name: jc.product_name || '', drawing_no: jc.drawing_no || '' });
  const [cardFile, setCardFile] = useState(null);
  const [photos, setPhotos] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));
  const setFixField = k => e => setFix(p => ({ ...p, [k]: e.target.value }));

  const qtyNum = /^\d+$/.test(qty.trim()) ? parseInt(qty.trim(), 10) : NaN;
  const qtyOk = Number.isInteger(qtyNum) && qtyNum >= 1 && qtyNum <= pieces;
  const willSplit = qtyOk && qtyNum < pieces;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!f.subject.trim()) { setError('Subject is required'); return; }
    if (!f.assigned_department) { setError('Please select a department'); return; }
    if (!/^\d+$/.test(qty.trim())) { setError('Pieces affected must be a whole number'); return; }
    if (!qtyOk) { setError(`Pieces affected must be between 1 and ${pieces} — ${jc.job_card_no} sent out ${pieces} pcs.`); return; }
    setSaving(true);
    setError('');
    try {
      const body = { order_id: jc.order_id, job_card_id: jc.id, qty: String(qtyNum), ...f };
      // Corrections go on the -Q card only, so they are sent only when a split
      // will happen; the server refuses them otherwise.
      if (willSplit) {
        if (fix.product_name.trim() && fix.product_name.trim() !== (jc.product_name || '')) body.product_name = fix.product_name.trim();
        if (fix.drawing_no.trim() && fix.drawing_no.trim() !== (jc.drawing_no || '')) body.drawing_no = fix.drawing_no.trim();
      }
      let r;
      if (willSplit && cardFile) {
        // A job card document rides along as multipart (field `file`, like POST /job-cards)
        const fd = new FormData();
        Object.entries(body).forEach(([k, v]) => { if (v != null && v !== '') fd.append(k, v); });
        fd.append('file', cardFile);
        r = await api.post('/customer-queries', fd);
      } else {
        r = await api.post('/customer-queries', body);
      }
      if (photos.length) {
        try {
          const fd = new FormData();
          photos.forEach(p => fd.append('photos', p));
          await api.post(`/customer-queries/${r.data.id}/photos`, fd);
        } catch (_) { /* photos are optional — the query is already created */ }
      }
      onCreated(r.data.id);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create query');
      setSaving(false);
    }
  };

  return (
    <Modal open title={`Customer Query — ${jc.job_card_no}`} onClose={onClose}>
      <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm">
        <span className="text-amber-700 font-medium">Raising a query for: </span>
        <span className="font-bold text-amber-900">{jc.product_name || jc.drawing_no || jc.job_card_no}</span>
        <span className="text-amber-600 ml-1">({jc.customer_code})</span>
      </div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">Subject <span className="text-red-500">*</span></label>
          <input className="input" value={f.subject} onChange={set('subject')}
            placeholder="Brief description of the issue" />
        </div>
        <div>
          <label className="label">Description</label>
          <textarea className="input" rows={3} value={f.description} onChange={set('description')}
            placeholder="Detailed description of the customer's complaint..." />
        </div>

        {/* Pieces affected — how many of the card's dispatched pieces came back */}
        <div>
          <label className="label">Pieces affected <span className="text-red-500">*</span></label>
          <div className="flex items-center gap-2">
            <input type="number" className="input w-28" min={1} max={pieces} step={1}
              value={qty} onChange={e => setQty(e.target.value)} />
            <span className="text-sm text-gray-600">of <span className="font-semibold text-gray-800">{pieces}</span> pcs sent out on {jc.job_card_no}</span>
          </div>
          {willSplit ? (
            <p className="text-xs text-amber-700 mt-1.5">
              Only {qtyNum} of {pieces} affected — these pieces get their own job card <span className="font-semibold">{nextQNo}</span>; the other {pieces - qtyNum} stay on {jc.job_card_no} as dispatched.
            </p>
          ) : qtyOk ? (
            <p className="text-xs text-gray-500 mt-1.5">All {pieces} pieces affected — the query goes on {jc.job_card_no} itself.</p>
          ) : (
            <p className="text-xs text-red-600 mt-1.5">Whole number from 1 to {pieces}.</p>
          )}
        </div>

        {/* Corrections for the -Q card — only when a split will happen */}
        {willSplit && (
          <div className="border border-gray-200 rounded-xl overflow-hidden">
            <button type="button"
              className="w-full flex items-center justify-between px-4 py-2.5 text-sm font-medium text-gray-700 bg-gray-50 hover:bg-gray-100 transition-colors"
              onClick={() => setShowFix(v => !v)}>
              <span>Only these pieces — the job card or product was wrong?</span>
              <span className="text-xs text-gray-400">{showFix ? 'Hide' : 'Show'}</span>
            </button>
            {showFix && (
              <div className="p-4 space-y-3 bg-white">
                <p className="text-xs text-gray-500">
                  Whatever you change here goes on <span className="font-semibold">{nextQNo}</span> only; {jc.job_card_no} keeps its own document, product name and drawing no.
                </p>
                <div>
                  <label className="label">Job card document <span className="text-gray-400 font-normal">(optional)</span></label>
                  <FileUpload onFile={setCardFile} accept=".pdf,.jpg,.jpeg,.png" label="Upload a different job card document" current={jc.original_name} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Product name</label>
                    <input className="input" value={fix.product_name} onChange={setFixField('product_name')} placeholder={jc.product_name || '—'} />
                  </div>
                  <div>
                    <label className="label">Drawing no</label>
                    <input className="input" value={fix.drawing_no} onChange={setFixField('drawing_no')} placeholder={jc.drawing_no || '—'} />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <div>
          <label className="label">Photos <span className="text-gray-400 font-normal">(optional)</span></label>
          <label className="flex items-center gap-2 cursor-pointer border border-gray-200 rounded-lg px-3 py-2 hover:border-brand-400 transition-colors bg-gray-50">
            <Upload size={15} className="text-gray-400 flex-shrink-0" />
            <span className="text-sm text-gray-600 flex-1 truncate">
              {photos.length ? `${photos.length} photo${photos.length > 1 ? 's' : ''} selected` : 'Attach photos of the issue…'}
            </span>
            <input type="file" accept="image/*" multiple className="hidden"
              onChange={async e => { const c = await compressImages(e.target.files); setPhotos(prev => [...prev, ...c]); }} />
          </label>
          {photos.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {photos.map((p, i) => (
                <span key={i} className="text-xs bg-gray-100 rounded px-1.5 py-0.5 flex items-center gap-1">
                  {p.name}
                  <button type="button" className="text-gray-400 hover:text-red-600"
                    onClick={() => setPhotos(prev => prev.filter((_, j) => j !== i))}>×</button>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="label">Category</label>
            <select className="input" value={f.category} onChange={set('category')}>
              <option value="general">General</option>
              <option value="design">Design Issue</option>
              <option value="production">Production Issue</option>
              <option value="quality">Quality Issue</option>
            </select>
          </div>
          <div>
            <label className="label">Priority</label>
            <select className="input" value={f.priority} onChange={set('priority')}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>
          <div>
            <label className="label">Assign To <span className="text-red-500">*</span></label>
            <select className="input" value={f.assigned_department} onChange={set('assigned_department')}>
              <option value="design">Design</option>
              <option value="production">Production</option>
              <option value="admin">Admin</option>
            </select>
          </div>
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <div className="flex gap-3">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving}>
            {saving ? 'Creating...' : 'Raise Query'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
