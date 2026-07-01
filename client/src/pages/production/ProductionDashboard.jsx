import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import StatusBadge from '../../components/ui/StatusBadge';
import Modal from '../../components/ui/Modal';
import { fmtDate, fmtDateTime, daysUntil, PRODUCTION_STAGES, MANDATORY_STAGE_NOS, getStageLabel, downloadExcel, WORKER_NAME_STAGES, SCRAP_VALUE_STAGES } from '../../lib/utils';
import {
  Wrench, Calendar, Plus, CheckSquare, Square, CheckCircle,
  X, ExternalLink, ClipboardList, Check, Image as ImageIcon,
  AlertTriangle, ChevronRight, ArrowLeft, Lock, Download, HelpCircle, Truck
} from 'lucide-react';

export default function ProductionDashboard() {
  const { user } = useAuthStore();
  const [tab, setTab] = useState('today');
  const [allCards, setAllCards] = useState([]);
  const [todayPicks, setTodayPicks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showPickModal, setShowPickModal] = useState(false);
  const [checklistTarget, setChecklistTarget] = useState(null);
  const today = new Date().toISOString().split('T')[0];

  const canManage = ['production', 'owner', 'admin'].includes(user.role);

  const load = async () => {
    setLoading(true);
    try {
      const [allRes, picksRes] = await Promise.all([
        api.get('/job-cards'),
        api.get('/job-cards/picks/today'),
      ]);
      setAllCards(allRes.data);
      setTodayPicks(picksRes.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // These return promises — callers (modal) batch them and call load() once after
  const pickCard = async (cardId) => {
    await api.post(`/job-cards/${cardId}/pick`);
  };

  const unpickCard = async (cardId) => {
    await api.delete(`/job-cards/${cardId}/pick`);
  };

  const todayPickIds = new Set(todayPicks.map(p => p.id));
  const activeCards = allCards.filter(c => c.status !== 'dispatched');

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Production</h1>
          <p className="text-gray-500 text-sm mt-0.5">{fmtDate(today)}</p>
        </div>
        <div className="flex items-center gap-2">
          {['owner','admin','production'].includes(user.role) && (
            <button className="btn-secondary flex items-center gap-1.5 text-sm"
              onClick={() => downloadExcel('production-checklist', 'production_checklist.xlsx')}>
              <Download size={15} /> Export
            </button>
          )}
          {canManage && tab === 'today' && (
            <button className="btn-primary" onClick={() => setShowPickModal(true)}>
              <Plus size={16} /> Pick Job Cards for Today
            </button>
          )}
        </div>
      </div>

      <div className="flex border-b border-gray-200 mb-6 gap-1">
        {[
          { key: 'today', label: `Today's Work`, count: todayPicks.length },
          { key: 'all',   label: 'All Job Cards', count: activeCards.length },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-5 py-2.5 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
              tab === t.key
                ? 'border-brand-500 text-brand-600 bg-brand-50/50'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
            <span className={`ml-2 text-xs px-1.5 py-0.5 rounded-full font-semibold ${
              tab === t.key ? 'bg-brand-100 text-brand-700' : 'bg-gray-100 text-gray-500'
            }`}>
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center text-gray-400 py-16">Loading...</div>
      ) : tab === 'today' ? (
        <TodayTab
          picks={todayPicks}
          canManage={canManage}
          onUnpick={async (id) => { await unpickCard(id); load(); }}
          onChecklist={setChecklistTarget}
          onPickMore={() => setShowPickModal(true)}
        />
      ) : (
        <AllCardsTab
          cards={activeCards}
          todayPickIds={todayPickIds}
          canManage={canManage}
          onPick={async (id) => { await pickCard(id); load(); }}
          onUnpick={async (id) => { await unpickCard(id); load(); }}
          onChecklist={setChecklistTarget}
        />
      )}

      {showPickModal && (
        <PickModal
          cards={activeCards}
          todayPickIds={todayPickIds}
          onPick={pickCard}
          onUnpick={unpickCard}
          onClose={() => { setShowPickModal(false); load(); }}
        />
      )}

      {checklistTarget && (
        <ChecklistModal
          card={checklistTarget}
          onClose={() => setChecklistTarget(null)}
          onSave={load}
        />
      )}
    </div>
  );
}

// ── Today's Work tab ──────────────────────────────────────────────────────────
function TodayTab({ picks, canManage, onUnpick, onChecklist, onPickMore }) {
  if (picks.length === 0) {
    return (
      <div className="text-center py-16">
        <Wrench size={40} className="mx-auto mb-3 text-gray-200" />
        <p className="text-gray-500 font-medium">No job cards picked for today.</p>
        {canManage && (
          <button className="btn-primary mt-4" onClick={onPickMore}>
            <Plus size={16} /> Pick Job Cards for Today
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {picks.map(jc => {
        const days = daysUntil(jc.dispatch_date);
        const isOverdue = days < 0;
        const isUrgent  = days >= 0 && days <= 3;
        const stageLabel = getStageLabel(jc.current_stage);
        const isOnHold = jc.status === 'on_hold';
        return (
          <div key={jc.id} className={`card p-5 border-l-4 ${
            jc.active_query_no ? 'border-l-amber-500' : isOnHold ? 'border-l-red-500' : isOverdue ? 'border-l-red-500' : isUrgent ? 'border-l-orange-400' : 'border-l-brand-400'
          }`}>
            {/* Customer Query Warning — Detailed */}
            {jc.active_query_no && (
              <div className="bg-amber-50 border border-amber-300 rounded-xl mb-3 overflow-hidden">
                <div className="px-4 py-2 bg-amber-100/60 border-b border-amber-200 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <AlertTriangle size={14} className="text-amber-700" />
                    <span className="text-sm font-bold text-amber-900">Customer Query Raised</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded-full font-semibold uppercase ${
                      jc.active_query_priority === 'critical' ? 'bg-red-100 text-red-700' :
                      jc.active_query_priority === 'high' ? 'bg-orange-100 text-orange-700' :
                      'bg-yellow-100 text-yellow-700'
                    }`}>{jc.active_query_priority || 'medium'}</span>
                  </div>
                  <Link to={`/customer-queries/${jc.active_query_id}`}
                    className="text-xs text-amber-800 font-medium hover:underline">View Query →</Link>
                </div>
                <div className="p-4">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                    <div>
                      <dt className="text-xs text-amber-600 font-medium">Query No</dt>
                      <dd className="text-sm font-bold text-amber-900">{jc.active_query_no}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-amber-600 font-medium">Job Card</dt>
                      <dd className="text-sm font-semibold text-gray-900">{jc.job_card_no}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-amber-600 font-medium">Order</dt>
                      <dd className="text-sm font-semibold text-gray-900">{jc.order_code}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-amber-600 font-medium">Customer</dt>
                      <dd className="text-sm font-semibold text-gray-900">{jc.customer_code}</dd>
                    </div>
                    {jc.active_query_category && (
                      <div>
                        <dt className="text-xs text-amber-600 font-medium">Category</dt>
                        <dd className="text-sm text-gray-800 capitalize">{jc.active_query_category}</dd>
                      </div>
                    )}
                    <div>
                      <dt className="text-xs text-amber-600 font-medium">Assigned Dept</dt>
                      <dd className="text-sm font-semibold text-gray-800 capitalize">{jc.active_query_dept || '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-amber-600 font-medium">Qty</dt>
                      <dd className="text-sm text-gray-800">{jc.qty} Nos</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-amber-600 font-medium">Dispatch</dt>
                      <dd className="text-sm text-gray-800">{fmtDate(jc.dispatch_date)}</dd>
                    </div>
                  </div>
                  <div className="mb-2">
                    <dt className="text-xs text-amber-600 font-medium mb-0.5">Subject</dt>
                    <dd className="text-sm font-semibold text-gray-900">{jc.active_query_subject}</dd>
                  </div>
                  {jc.active_query_description && (
                    <div className="mb-2">
                      <dt className="text-xs text-amber-600 font-medium mb-0.5">Description</dt>
                      <dd className="text-xs text-gray-700 bg-amber-100/40 rounded p-2">{jc.active_query_description}</dd>
                    </div>
                  )}
                  {(jc.active_query_return_type || jc.active_query_return_coupon_no || jc.active_query_debit_note_no) && (
                    <div className="flex flex-wrap gap-3 pt-2 border-t border-amber-200 mt-2">
                      {jc.active_query_return_type && (
                        <span className="text-xs text-amber-800">Return: <strong className="capitalize">{jc.active_query_return_type === 'debit_note' ? 'Debit Note' : jc.active_query_return_type}</strong></span>
                      )}
                      {jc.active_query_return_coupon_no && (
                        <span className="text-xs text-amber-800">Coupon: <strong>{jc.active_query_return_coupon_no}</strong></span>
                      )}
                      {jc.active_query_debit_note_no && (
                        <span className="text-xs text-amber-800">Debit Note: <strong>{jc.active_query_debit_note_no}</strong></span>
                      )}
                    </div>
                  )}
                  {jc.active_query_created_at && (
                    <div className="text-xs text-amber-600 mt-2 pt-2 border-t border-amber-200">
                      Raised on {fmtDateTime(jc.active_query_created_at)}
                    </div>
                  )}
                </div>
              </div>
            )}
            <div className="flex items-start gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="font-bold text-gray-900 text-base">{jc.job_card_no}</span>
                  <StatusBadge status={jc.status} />
                  {stageLabel && !isOnHold && (
                    <span className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full font-medium">
                      {stageLabel}
                    </span>
                  )}
                  {isOnHold && (
                    <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium flex items-center gap-1">
                      <AlertTriangle size={11} /> Awaiting Owner Approval
                    </span>
                  )}
                  {jc.qc_rejected && (
                    <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-medium flex items-center gap-1">
                      <AlertTriangle size={11} /> QC Rejected — Rework Required
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
                      {' · '}
                      {jc.net_qty != null && jc.net_qty < jc.qty
                        ? <><span className="text-orange-500 font-medium">{jc.net_qty} dispatchable</span> <span className="text-xs">(of {jc.qty})</span></>
                        : <>Qty: {jc.net_qty ?? jc.qty}</>
                      }
                    </span>
                  )}
                </div>
                <div className={`text-sm font-semibold ${
                  isOverdue ? 'text-red-600' : isUrgent ? 'text-orange-500' : 'text-gray-500'
                }`}>
                  {isOverdue
                    ? `⚠️ ${Math.abs(days)}d overdue · Dispatch was ${fmtDate(jc.dispatch_date)}`
                    : days === 0
                      ? `🔔 Dispatch today — ${fmtDate(jc.dispatch_date)}`
                      : `Dispatch: ${fmtDate(jc.dispatch_date)} (${days}d left)`}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {jc.file_name && (
                  <a href={`/uploads/job-cards/${jc.file_name}`} target="_blank" rel="noopener noreferrer"
                    className="btn-secondary btn-sm flex items-center gap-1">
                    <ExternalLink size={13} /> View Card
                  </a>
                )}
                <button className="btn-primary btn-sm flex items-center gap-1" onClick={() => onChecklist(jc)}>
                  <ClipboardList size={13} /> Checklist
                </button>
                <button
                  className="btn-ghost btn-sm p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50"
                  onClick={() => onUnpick(jc.id)} title="Remove from today"
                >
                  <X size={15} />
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── All Job Cards tab ─────────────────────────────────────────────────────────
function AllCardsTab({ cards, todayPickIds, canManage, onPick, onUnpick, onChecklist }) {
  if (cards.length === 0) {
    return (
      <div className="text-center py-16">
        <CheckCircle size={40} className="mx-auto mb-3 text-green-200" />
        <p className="text-gray-500">No active job cards. All done!</p>
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <table className="w-full">
        <thead className="bg-gray-50 border-b border-gray-200">
          <tr>
            <th className="table-header text-left">Job Card</th>
            <th className="table-header text-left">Order / Customer</th>
            <th className="table-header text-right">Dispatchable Qty</th>
            <th className="table-header text-left">Dispatch Date</th>
            <th className="table-header text-left">Status / Stage</th>
            {canManage && <th className="table-header text-center">Today</th>}
            {canManage && <th className="table-header text-center">Checklist</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {cards.map(jc => {
            const days = daysUntil(jc.dispatch_date);
            const isOverdue = days < 0;
            const isUrgent  = days >= 0 && days <= 3;
            const isPicked  = todayPickIds.has(jc.id);
            const stageLabel = getStageLabel(jc.current_stage);
            return (
              <tr key={jc.id} className={`hover:bg-gray-50 ${isOverdue ? 'bg-red-50/30' : ''}`}>
                <td className="table-cell">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-brand-700">{jc.job_card_no}</span>
                    {isPicked && (
                      <span className="text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full font-medium">Today</span>
                    )}
                  </div>
                  {jc.file_name && (
                    <a href={`/uploads/job-cards/${jc.file_name}`} target="_blank" rel="noopener noreferrer"
                      className="text-xs text-brand-500 hover:underline flex items-center gap-0.5 mt-0.5">
                      <ExternalLink size={10} /> View file
                    </a>
                  )}
                </td>
                <td className="table-cell">
                  <Link to={`/orders/${jc.order_id}`} className="text-brand-600 hover:underline text-sm font-medium">
                    {jc.order_code}
                  </Link>
                  <div className="text-xs text-gray-400">{jc.customer_code}</div>
                </td>
                <td className="table-cell text-right">
                  {jc.net_qty != null && jc.net_qty < jc.qty ? (
                    <div>
                      <span className="font-semibold text-orange-600">{jc.net_qty}</span>
                      <div className="text-xs text-gray-400">of {jc.qty}</div>
                    </div>
                  ) : (
                    <span className="font-semibold text-gray-700">{jc.net_qty ?? jc.qty ?? '—'}</span>
                  )}
                </td>
                <td className="table-cell">
                  <div className="text-sm">{fmtDate(jc.dispatch_date)}</div>
                  <div className={`text-xs font-medium ${
                    isOverdue ? 'text-red-600' : isUrgent ? 'text-orange-500' : 'text-gray-400'
                  }`}>
                    {isOverdue ? `${Math.abs(days)}d overdue` : days === 0 ? 'Today!' : `${days}d left`}
                  </div>
                </td>
                <td className="table-cell">
                  <StatusBadge status={jc.status} />
                  {stageLabel && jc.status === 'in_progress' && (
                    <div className="text-xs text-gray-400 mt-0.5">{stageLabel}</div>
                  )}
                  {jc.active_query_no && (
                    <div className="mt-1">
                      <Link to={`/customer-queries/${jc.active_query_id}`}
                        className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1 rounded-lg inline-flex items-center gap-1 hover:bg-amber-100">
                        <AlertTriangle size={10} />
                        <span className="font-semibold">{jc.active_query_no}</span>
                        <span className="text-amber-600">·</span>
                        <span className="truncate max-w-[120px]">{jc.active_query_subject}</span>
                        {jc.active_query_priority === 'critical' && <span className="text-red-600 font-bold ml-0.5">!</span>}
                      </Link>
                    </div>
                  )}
                </td>
                {canManage && (
                  <td className="table-cell text-center">
                    {isPicked ? (
                      <button
                        className="btn-ghost btn-sm text-xs text-orange-600 hover:bg-orange-50 px-2 py-1 gap-1 flex items-center mx-auto"
                        onClick={() => onUnpick(jc.id)}
                      >
                        <CheckSquare size={14} /> Picked
                      </button>
                    ) : (
                      <button
                        className="btn-secondary btn-sm text-xs px-2 py-1 gap-1 flex items-center mx-auto"
                        onClick={() => onPick(jc.id)}
                      >
                        <Square size={14} /> Pick
                      </button>
                    )}
                  </td>
                )}
                {canManage && (
                  <td className="table-cell text-center">
                    <button
                      className="btn-ghost btn-sm text-xs text-brand-600 hover:bg-brand-50 px-2 py-1 gap-1 flex items-center mx-auto"
                      onClick={() => onChecklist(jc)}
                    >
                      <ClipboardList size={13} /> Open
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Pick Modal ────────────────────────────────────────────────────────────────
function PickModal({ cards, todayPickIds, onPick, onUnpick, onClose }) {
  const [search, setSearch] = useState('');
  // Local selection state so multi-select is instant (no API call per click)
  const [localPicked, setLocalPicked] = useState(new Set(todayPickIds));
  const [saving, setSaving] = useState(false);

  const filtered = cards.filter(c =>
    (c.job_card_no || '').toLowerCase().includes(search.toLowerCase()) ||
    (c.order_code || '').toLowerCase().includes(search.toLowerCase())
  );

  const toggle = (id) => {
    setLocalPicked(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleDone = async () => {
    setSaving(true);
    // Work out what changed vs. original todayPickIds
    const toAdd    = [...localPicked].filter(id => !todayPickIds.has(id));
    const toRemove = [...todayPickIds].filter(id => !localPicked.has(id));
    await Promise.all([
      ...toAdd.map(id => onPick(id)),
      ...toRemove.map(id => onUnpick(id)),
    ]);
    onClose();
  };

  const changed = localPicked.size !== todayPickIds.size ||
    [...localPicked].some(id => !todayPickIds.has(id));

  return (
    <Modal open title="Pick Job Cards for Today" onClose={onClose} size="lg">
      <p className="text-sm text-gray-500 mb-4">
        Select job cards to add to the active work queue. Picked cards stay visible every day until removed.
      </p>
      <input className="input mb-4" placeholder="Search by job card or order..."
        value={search} onChange={e => setSearch(e.target.value)} autoFocus />
      <div className="space-y-2 max-h-96 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="text-center text-gray-400 py-8">No active job cards found.</p>
        ) : filtered.map(jc => {
          const isPicked = localPicked.has(jc.id);
          const days = daysUntil(jc.dispatch_date);
          return (
            <div key={jc.id}
              className={`flex items-center gap-3 p-3 rounded-xl border transition-colors cursor-pointer ${
                isPicked ? 'bg-brand-50 border-brand-300' : 'bg-gray-50 border-gray-200 hover:border-brand-300'
              }`}
              onClick={() => toggle(jc.id)}
            >
              <div className={`w-5 h-5 rounded flex items-center justify-center flex-shrink-0 border-2 transition-colors ${
                isPicked ? 'bg-brand-600 border-brand-600' : 'border-gray-300'
              }`}>
                {isPicked && <Check size={12} className="text-white" />}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm text-gray-900">{jc.job_card_no}</span>
                  <span className="text-xs text-gray-500">{jc.order_code} · {jc.customer_code}</span>
                </div>
                <div className={`text-xs mt-0.5 font-medium ${
                  days < 0 ? 'text-red-600' : days <= 3 ? 'text-orange-500' : 'text-gray-400'
                }`}>
                  Dispatch: {fmtDate(jc.dispatch_date)}
                  {days < 0 ? ` · ${Math.abs(days)}d overdue` : days === 0 ? ' · Today!' : ` · ${days}d left`}
                </div>
              </div>
              <StatusBadge status={jc.status} />
            </div>
          );
        })}
      </div>
      <div className="mt-5 flex items-center justify-between">
        <span className="text-sm text-gray-400">{localPicked.size} selected</span>
        <div className="flex gap-3">
          <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={handleDone} disabled={saving}>
            {saving ? 'Saving...' : changed ? 'Save & Close' : 'Done'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Checklist Modal (list view → stage detail view) ───────────────────────────
function ChecklistModal({ card, onClose, onSave }) {
  const { user } = useAuthStore();
  const [data, setData] = useState(null); // { stages: [], hold: null|{...} }
  const [view, setView] = useState('list'); // 'list' | 'stage'
  const [selectedDef, setSelectedDef] = useState(null);
  const [approvingHold, setApprovingHold] = useState(false);

  const canManage = ['production', 'owner', 'admin'].includes(user.role);
  const canApproveHold = ['owner', 'admin'].includes(user.role);
  const canRequestSplit = canManage && ['pending', 'in_progress', 'on_hold'].includes(card.status);
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitQty, setSplitQty] = useState('');
  const [splitReason, setSplitReason] = useState('');
  const [splitSaving, setSplitSaving] = useState(false);
  const [splitErr, setSplitErr] = useState('');

  const submitSplit = async () => {
    setSplitErr('');
    const n = parseInt(splitQty, 10);
    if (!n || n < 1) return setSplitErr('Enter the quantity to dispatch early');
    if (n >= card.qty) return setSplitErr(`Must be less than ${card.qty} — at least 1 must remain`);
    if (!splitReason.trim()) return setSplitErr('A reason is required');
    setSplitSaving(true);
    try {
      await api.post(`/job-cards/${card.id}/split-request`, { qty: n, reason: splitReason });
      setSplitOpen(false); setSplitQty(''); setSplitReason(''); setSplitSaving(false);
      alert('Partial dispatch request sent to the owner for approval.');
      onSave(); onClose();
    } catch (e) { setSplitErr(e.response?.data?.error || 'Failed'); setSplitSaving(false); }
  };

  const loadChecklist = async () => {
    const r = await api.get(`/job-cards/${card.id}/checklist`);
    setData(r.data);
  };

  useEffect(() => { loadChecklist(); }, [card.id]);

  const stageMap = useMemo(() => {
    const m = {};
    data?.stages?.forEach(s => { m[s.stage_no] = s; });
    return m;
  }, [data]);

  // Compute net_qty live from checklist stages (always fresh, not stale list data)
  const liveNetQty = useMemo(() => {
    if (!data?.stages) return card.net_qty ?? card.qty;
    // Exclude dispatch stage (29) remade from pre-dispatch net — that's added at dispatch time
    const totalRejected = data.stages.reduce((s, st) => s + (parseInt(st.rejection_qty, 10) || 0), 0);
    const totalRemade   = data.stages.filter(st => st.stage_no !== 29 && st.stage_no !== 30).reduce((s, st) => s + (parseInt(st.remade_qty, 10) || 0), 0);
    return Math.max((parseInt(card.qty, 10) || 0) - totalRejected + totalRemade, 0);
  }, [data, card.qty]);

  const approveHold = async () => {
    setApprovingHold(true);
    try {
      await api.put(`/job-cards/${card.id}/hold/approve`);
      await loadChecklist();
      onSave();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to approve hold');
    } finally {
      setApprovingHold(false);
    }
  };

  const completedCount = data?.stages?.filter(s => s.done).length || 0;
  const visibleCount = data
    ? PRODUCTION_STAGES.filter(def => !(def.hideIfDone && stageMap[def.hideIfDone]?.done)).length
    : 29;
  const progress = visibleCount > 0 ? Math.round(completedCount / visibleCount * 100) : 0;
  const isOnHold = !!data?.hold;

  const openStage = (def) => {
    if (!canManage) return;
    setSelectedDef(def);
    setView('stage');
  };

  const days = daysUntil(card.dispatch_date);
  const isOverdue = days < 0;

  return (
    <Modal open title={view === 'list' ? `Checklist — ${card.job_card_no}` : `Stage ${selectedDef?.no}: ${selectedDef?.name}`} onClose={onClose} size="xl">
      {/* Job Card Details Header */}
      <div className="mb-4 pb-4 border-b border-gray-200">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-bold text-gray-900">{card.job_card_no}</h3>
            <StatusBadge status={card.status} />
            {isOverdue ? (
              <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-semibold">{Math.abs(days)}d overdue</span>
            ) : days !== null && days <= 3 ? (
              <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-semibold">{days === 0 ? 'Today!' : `${days}d left`}</span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <div className="w-28 h-2 bg-gray-200 rounded-full overflow-hidden">
              <div className="h-full bg-green-500 rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }} />
            </div>
            <span className="text-sm font-semibold text-gray-600">{completedCount}/{visibleCount}</span>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <dt className="text-xs text-gray-500 font-medium uppercase">Order</dt>
            <dd className="text-sm font-semibold text-gray-900 mt-0.5">
              <Link to={`/orders/${card.order_id}`} className="text-brand-600 hover:underline">{card.order_code}</Link>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500 font-medium uppercase">Customer</dt>
            <dd className="text-sm font-semibold text-gray-900 mt-0.5">{card.customer_code}</dd>
          </div>
          {card.product_name && (
            <div>
              <dt className="text-xs text-gray-500 font-medium uppercase">Product</dt>
              <dd className="text-sm font-semibold text-gray-900 mt-0.5">{card.product_name}</dd>
            </div>
          )}
          {card.drawing_no && (
            <div>
              <dt className="text-xs text-gray-500 font-medium uppercase">Drawing No</dt>
              <dd className="text-sm text-gray-900 mt-0.5">{card.drawing_no}</dd>
            </div>
          )}
          {card.punching && (
            <div>
              <dt className="text-xs text-gray-500 font-medium uppercase">Punching</dt>
              <dd className="text-sm text-gray-900 mt-0.5">{card.punching}</dd>
            </div>
          )}
          <div>
            <dt className="text-xs text-gray-500 font-medium uppercase">Qty Ordered</dt>
            <dd className="text-sm font-semibold text-gray-900 mt-0.5">{card.qty} Nos</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500 font-medium uppercase">Dispatchable Qty</dt>
            <dd className={`text-sm font-semibold mt-0.5 ${liveNetQty < card.qty ? 'text-orange-600' : 'text-green-700'}`}>
              {liveNetQty}{liveNetQty < card.qty ? ` (−${card.qty - liveNetQty} rejected)` : ''}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500 font-medium uppercase">Dispatch Date</dt>
            <dd className={`text-sm font-semibold mt-0.5 ${isOverdue ? 'text-red-600' : 'text-gray-900'}`}>{fmtDate(card.dispatch_date)}</dd>
          </div>
          {card.current_stage && (
            <div>
              <dt className="text-xs text-gray-500 font-medium uppercase">Current Stage</dt>
              <dd className="text-sm text-blue-700 font-medium mt-0.5">{getStageLabel(card.current_stage)}</dd>
            </div>
          )}
          {card.file_name && (
            <div>
              <dt className="text-xs text-gray-500 font-medium uppercase">Job Card File</dt>
              <dd className="text-sm mt-0.5">
                <a href={`/uploads/job-cards/${card.file_name}`} target="_blank" rel="noopener noreferrer"
                  className="text-brand-600 hover:underline flex items-center gap-1">
                  <ExternalLink size={11} /> View File
                </a>
              </dd>
            </div>
          )}
        </div>
      </div>

      {!data ? (
        <div className="text-center py-12 text-gray-400">Loading checklist...</div>
      ) : view === 'list' ? (
        <>
          {/* Partial dispatch request */}
          {canRequestSplit && (
            <div className="mb-4">
              {!splitOpen ? (
                <button className="btn-secondary btn-sm flex items-center gap-1.5" onClick={() => setSplitOpen(true)}>
                  <Truck size={14} /> Request Partial Dispatch
                </button>
              ) : (
                <div className="rounded-xl border border-brand-200 bg-brand-50 p-3 space-y-2">
                  <div className="text-sm font-semibold text-gray-800">Request partial dispatch (needs owner approval)</div>
                  <p className="text-xs text-gray-500">Dispatch some units of this job card early. On approval they become a separate job card (skips production → QC → dispatch) and this card's qty reduces.</p>
                  <div className="flex gap-2">
                    <input className="input text-sm w-32" type="number" min="1" max={card.qty - 1} placeholder={`Qty (of ${card.qty})`} value={splitQty} onChange={e => setSplitQty(e.target.value)} />
                    <input className="input text-sm flex-1" placeholder="Reason" value={splitReason} onChange={e => setSplitReason(e.target.value)} />
                  </div>
                  {splitErr && <p className="text-red-600 text-xs">{splitErr}</p>}
                  <div className="flex gap-2">
                    <button className="btn-secondary btn-sm text-xs" onClick={() => { setSplitOpen(false); setSplitErr(''); }}>Cancel</button>
                    <button className="btn-primary btn-sm text-xs" disabled={splitSaving} onClick={submitSplit}>{splitSaving ? 'Sending…' : 'Send for Approval'}</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Customer Query banner — Detailed */}
          {card.active_query_no && (
            <div className="mb-4 rounded-xl bg-amber-50 border border-amber-300 overflow-hidden">
              <div className="px-4 py-2 bg-amber-100/60 border-b border-amber-200 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <AlertTriangle size={14} className="text-amber-700" />
                  <span className="text-sm font-bold text-amber-900">Customer Query Raised</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full font-semibold uppercase ${
                    card.active_query_priority === 'critical' ? 'bg-red-100 text-red-700' :
                    card.active_query_priority === 'high' ? 'bg-orange-100 text-orange-700' :
                    'bg-yellow-100 text-yellow-700'
                  }`}>{card.active_query_priority || 'medium'}</span>
                </div>
                <Link to={`/customer-queries/${card.active_query_id}`}
                  className="text-xs text-amber-800 font-medium hover:underline">View Query →</Link>
              </div>
              <div className="p-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                  <div>
                    <dt className="text-xs text-amber-600 font-medium">Query No</dt>
                    <dd className="text-sm font-bold text-amber-900">{card.active_query_no}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-amber-600 font-medium">Job Card</dt>
                    <dd className="text-sm font-semibold text-gray-900">{card.job_card_no}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-amber-600 font-medium">Order</dt>
                    <dd className="text-sm font-semibold text-gray-900">{card.order_code}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-amber-600 font-medium">Customer</dt>
                    <dd className="text-sm font-semibold text-gray-900">{card.customer_code}</dd>
                  </div>
                  {card.active_query_category && (
                    <div>
                      <dt className="text-xs text-amber-600 font-medium">Category</dt>
                      <dd className="text-sm text-gray-800 capitalize">{card.active_query_category}</dd>
                    </div>
                  )}
                  <div>
                    <dt className="text-xs text-amber-600 font-medium">Assigned Dept</dt>
                    <dd className="text-sm font-semibold text-gray-800 capitalize">{card.active_query_dept || '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-amber-600 font-medium">Qty</dt>
                    <dd className="text-sm text-gray-800">{card.qty} Nos</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-amber-600 font-medium">Dispatch</dt>
                    <dd className="text-sm text-gray-800">{fmtDate(card.dispatch_date)}</dd>
                  </div>
                </div>
                <div className="mb-2">
                  <dt className="text-xs text-amber-600 font-medium mb-0.5">Subject</dt>
                  <dd className="text-sm font-semibold text-gray-900">{card.active_query_subject}</dd>
                </div>
                {card.active_query_description && (
                  <div className="mb-2">
                    <dt className="text-xs text-amber-600 font-medium mb-0.5">Description</dt>
                    <dd className="text-xs text-gray-700 bg-amber-100/40 rounded p-2">{card.active_query_description}</dd>
                  </div>
                )}
                {(card.active_query_return_type || card.active_query_return_coupon_no || card.active_query_debit_note_no) && (
                  <div className="flex flex-wrap gap-3 pt-2 border-t border-amber-200 mt-2">
                    {card.active_query_return_type && (
                      <span className="text-xs text-amber-800">Return: <strong className="capitalize">{card.active_query_return_type === 'debit_note' ? 'Debit Note' : card.active_query_return_type}</strong></span>
                    )}
                    {card.active_query_return_coupon_no && (
                      <span className="text-xs text-amber-800">Coupon: <strong>{card.active_query_return_coupon_no}</strong></span>
                    )}
                    {card.active_query_debit_note_no && (
                      <span className="text-xs text-amber-800">Debit Note: <strong>{card.active_query_debit_note_no}</strong></span>
                    )}
                  </div>
                )}
                {card.active_query_created_at && (
                  <div className="text-xs text-amber-600 mt-2 pt-2 border-t border-amber-200">
                    Raised on {fmtDateTime(card.active_query_created_at)}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Hold banner */}
          {isOnHold && (
            <div className="mb-4 rounded-xl bg-red-50 border border-red-200 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-semibold text-red-700 flex items-center gap-2">
                    <AlertTriangle size={16} /> Work On Hold
                  </div>
                  {data.hold && (
                    <div className="text-sm text-red-600 mt-1">
                      {data.hold.stage_no === 0 ? (
                        <>⚠️ Cumulative rejections total: <strong>{data.hold.rejection_qty} pieces</strong> across all stages — high rejection count flagged.</>
                      ) : (
                        <>
                          {data.hold.rejection_qty} rejection{data.hold.rejection_qty > 1 ? 's' : ''} reported
                          at Stage {data.hold.stage_no}{' '}
                          ({PRODUCTION_STAGES.find(s => s.no === data.hold.stage_no)?.name})
                          {data.hold.hold_photo_file && (
                            <a href={`/uploads/rejection-photos/${data.hold.hold_photo_file}`}
                              target="_blank" rel="noopener noreferrer"
                              className="ml-2 underline text-red-500">View photo</a>
                          )}
                        </>
                      )}
                    </div>
                  )}
                  <div className="text-xs text-red-500 mt-1">Owner approval required to resume production.</div>
                </div>
                {canApproveHold && (
                  <button
                    className="btn-primary bg-red-600 hover:bg-red-700 border-red-600 whitespace-nowrap flex-shrink-0"
                    onClick={approveHold} disabled={approvingHold}
                  >
                    {approvingHold ? 'Approving...' : 'Approve to Resume'}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* QC Rejection banner */}
          {data?.qc_rejected && (
            <div className="mb-4 rounded-xl bg-orange-50 border border-orange-300 p-4">
              <div className="font-semibold text-orange-700 flex items-center gap-2">
                <AlertTriangle size={16} /> QC Rejected — Rework Required
              </div>
              {data?.qc_rejection_notes && (
                <div className="text-sm text-orange-600 mt-1">"{data.qc_rejection_notes}"</div>
              )}
              <div className="text-xs text-orange-500 mt-1">
                Fix the issues, then re-complete Stage 29 to re-submit for QC approval.
              </div>
            </div>
          )}

          {/* Stage list */}
          <div className="space-y-1 max-h-[55vh] overflow-y-auto pr-1">
            {PRODUCTION_STAGES.map(def => {
              if (def.hideIfDone && stageMap[def.hideIfDone]?.done) return null;
              const sData = stageMap[def.no] || { done: 0, value1: null, value2: null, photo_file: null, rejection_qty: 0, remade_qty: 0 };
              const isDone = sData.done === 1;
              const hasRejection = (sData.rejection_qty || 0) > 0;
              const clickable = canManage && (!isOnHold || isDone);

              return (
                <div
                  key={def.no}
                  className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
                    isDone ? 'bg-green-50 border-green-200' : 'bg-white border-gray-200'
                  } ${clickable ? 'cursor-pointer hover:border-brand-300 hover:bg-brand-50/20' : 'opacity-60'}`}
                  onClick={() => clickable && openStage(def)}
                >
                  {/* Status icon */}
                  <div className={`w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center ${
                    isDone ? 'bg-green-500' : isOnHold ? 'bg-gray-300 border-2 border-gray-300' : 'border-2 border-gray-300'
                  }`}>
                    {isDone
                      ? <Check size={13} className="text-white" />
                      : isOnHold ? <Lock size={10} className="text-white" /> : null
                    }
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-mono text-gray-300 w-5 text-right flex-shrink-0">{def.no}</span>
                      <span className={`text-sm font-medium ${isDone ? 'text-green-800' : 'text-gray-800'}`}>
                        {def.name}
                      </span>
                      {def.optional && <span className="text-xs bg-gray-100 text-gray-400 px-1.5 py-0.5 rounded">Optional</span>}
                      {isDone && sData.done_at && (
                        <span className="text-xs text-green-500 ml-auto flex-shrink-0">{fmtDateTime(sData.done_at)}</span>
                      )}
                    </div>
                    {isDone && (sData.value1 || sData.value2 || hasRejection || sData.worker_name || sData.scrap_value || sData.coil_weight != null) && (
                      <div className="ml-7 text-xs text-gray-500 mt-0.5 flex flex-wrap gap-2">
                        {sData.worker_name && <span className="font-medium text-gray-600">{sData.worker_name}</span>}
                        {def.heaterAdjust && sData.value1 === 'adjusted' && (
                          <span className="text-green-600 font-medium">✅ Heater Adjusted</span>
                        )}
                        {def.brazing && sData.value1 ? (() => {
                          let d = {};
                          try { d = JSON.parse(sData.value1); } catch {}
                          return <>
                            <span className={d.airPressure === 'pass' ? 'text-green-600 font-medium' : 'text-red-600 font-medium'}>
                              Air Pressure {d.airPressure === 'pass' ? '✅' : `❌ — ${d.airPressureRemark}`}
                            </span>
                            <span className={d.airCleaning ? 'text-green-600 font-medium' : 'text-gray-400'}>
                              Air Cleaning {d.airCleaning ? '✅' : '—'}
                            </span>
                            {d.remark && <span className="text-gray-500">{d.remark}</span>}
                          </>;
                        })() : null}
                        {def.hvLight && sData.value1 ? (() => {
                          let d = {};
                          try { d = JSON.parse(sData.value1); } catch { d = { light: sData.value1 }; }
                          const hvBadge = d.hv === 'pass'
                            ? <span key="hv" className="text-green-600 font-medium">HV ✅</span>
                            : <span key="hv" className="text-red-600 font-medium">HV ❌ {d.hvCount} — {d.hvReason}</span>;
                          const ltBadge = d.light === 'pass'
                            ? <span key="lt" className="text-green-600 font-medium">Light ✅</span>
                            : <span key="lt" className="text-red-600 font-medium">Light ❌ {d.lightCount} — {d.lightReason}</span>;
                          return <>{hvBadge}{ltBadge}{d.ohms && <span key="ohms" className="text-gray-500">{d.ohms} Ω</span>}</>;
                        })() : (
                          <>
                            {sData.value1 && <span>{sData.value1}</span>}
                            {sData.value2 && <span className="text-gray-400">{sData.value2}</span>}
                          </>
                        )}
                        {sData.scrap_value && <span className="text-amber-600">Scrap: {sData.scrap_value}</span>}
                        {sData.coil_weight != null && <span className="text-blue-600 font-medium">Coil Wt: {sData.coil_weight} kg</span>}
                        {hasRejection && (
                          <span className="text-orange-600 font-medium">
                            Rej: {sData.rejection_qty} · Remade: {sData.remade_qty || 0}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {clickable && <ChevronRight size={15} className="text-gray-300 flex-shrink-0" />}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        /* Stage detail view */
        selectedDef && (
          <StageDetailView
            card={{ ...card, net_qty: liveNetQty }}
            stageDef={selectedDef}
            stageData={stageMap[selectedDef.no] || { done: 0, value1: null, value2: null, photo_file: null, rejection_qty: 0, remade_qty: 0, rejection_photo_file: null, notes: null }}
            stageMap={stageMap}
            onBack={() => setView('list')}
            onSaved={async () => {
              setView('list');
              await loadChecklist();
              onSave();
            }}
          />
        )
      )}

      {view === 'list' && (
        <div className="mt-4 flex justify-between items-center pt-3 border-t border-gray-100">
          <span className="text-sm text-gray-400">
            {completedCount} of {visibleCount} stages complete · {progress}%
          </span>
          <button className="btn-primary" onClick={onClose}>Close</button>
        </div>
      )}
    </Modal>
  );
}

// ── Reusable HV / Light pass-fail block ──────────────────────────────────────
function HvTestBlock({ label, result, failCount, failReason, isDone, doneResult, doneCount, doneReason, onResult, onCount, onReason, passLabel = '✅ All Passed', failLabel = '❌ Some Failed', hideCount = false }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">
        {label} <span className="text-red-500">*</span>
      </label>
      {isDone ? (
        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium ${
          doneResult === 'pass' ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-700'
        }`}>
          {doneResult === 'pass'
            ? passLabel
            : hideCount ? `❌ Failed — ${doneReason}` : `❌ ${doneCount} failed — ${doneReason}`}
        </div>
      ) : (
        <>
          <div className="flex gap-3 mb-2">
            <button type="button" onClick={() => onResult('pass')}
              className={`flex-1 py-2.5 rounded-xl border-2 font-semibold text-sm transition-colors flex items-center justify-center gap-2 ${
                result === 'pass' ? 'bg-green-50 border-green-500 text-green-700' : 'border-gray-200 text-gray-500 hover:border-green-300'
              }`}>{passLabel}</button>
            <button type="button" onClick={() => onResult('fail')}
              className={`flex-1 py-2.5 rounded-xl border-2 font-semibold text-sm transition-colors flex items-center justify-center gap-2 ${
                result === 'fail' ? 'bg-red-50 border-red-500 text-red-700' : 'border-gray-200 text-gray-500 hover:border-red-300'
              }`}>{failLabel}</button>
          </div>
          {result === 'fail' && (
            <div className="space-y-3 p-3 bg-red-50 rounded-xl border border-red-100">
              {!hideCount && (
                <div>
                  <label className="block text-xs font-medium text-red-700 mb-1">How many failed? <span className="text-red-500">*</span></label>
                  <input type="number" min="1" className="input w-32 text-sm"
                    placeholder="e.g. 3" value={failCount} onChange={e => onCount(e.target.value)} />
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-red-700 mb-1">
                  {hideCount ? 'Reason / Remark' : 'Why did they fail?'} <span className="text-red-500">*</span>
                </label>
                <textarea className="input w-full h-16 resize-none text-sm"
                  placeholder="Describe the reason..."
                  value={failReason} onChange={e => onReason(e.target.value)} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Qty Mismatch Confirmation Modal (shown before Stage 29 / QC trigger) ─────
function QtyMismatchModal({ originalQty, netQty, breakdown, onConfirm, onCancel }) {
  const diff = originalQty - netQty;
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-orange-100 flex items-center justify-center flex-shrink-0">
            <AlertTriangle size={20} className="text-orange-600" />
          </div>
          <div>
            <h3 className="font-semibold text-gray-900">Qty Mismatch — Confirm Before QC</h3>
            <p className="text-sm text-gray-500">Final dispatchable qty does not match the job card qty</p>
          </div>
        </div>

        <div className="bg-orange-50 rounded-xl border border-orange-200 p-4 mb-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-600">Original Job Card Qty</span>
            <span className="font-semibold text-gray-900">{originalQty} pcs</span>
          </div>
          <div className="flex justify-between text-red-600">
            <span>Total Rejections (all stages)</span>
            <span className="font-semibold">− {breakdown.totalRejected} pcs</span>
          </div>
          {breakdown.totalRemade > 0 && (
            <div className="flex justify-between text-green-600">
              <span>Remade / Recovered</span>
              <span className="font-semibold">+ {breakdown.totalRemade} pcs</span>
            </div>
          )}
          <div className="flex justify-between border-t border-orange-200 pt-2 mt-2">
            <span className="font-semibold text-gray-700">Final Dispatchable Qty</span>
            <span className={`font-bold text-lg ${netQty < originalQty ? 'text-orange-700' : 'text-green-700'}`}>{netQty} pcs</span>
          </div>
          <div className="text-xs text-orange-700 mt-1">
            ⚠️ {diff} piece{diff !== 1 ? 's' : ''} short of original order qty. This will be visible on the QC report.
          </div>
        </div>

        <p className="text-sm text-gray-600 mb-5">
          Sending this job card to QC with a reduced qty. The QC inspector will see this breakdown when approving.
          Confirm to proceed, or go back and update the rejection / remade counts.
        </p>

        <div className="flex gap-3">
          <button className="btn-ghost flex-1" onClick={onCancel}>Go Back</button>
          <button className="btn-primary flex-1 bg-orange-600 border-orange-600 hover:bg-orange-700" onClick={onConfirm}>
            Confirm &amp; Send to QC
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Stage Detail View (inline within ChecklistModal) ──────────────────────────
function StageDetailView({ card, stageDef, stageData, stageMap, onBack, onSaved }) {
  const { user } = useAuthStore();
  const [value1, setValue1] = useState(stageData.value1 || '');
  const [value2, setValue2] = useState(stageData.value2 || '');
  const [coilWeight, setCoilWeight] = useState(stageData.coil_weight != null ? String(stageData.coil_weight) : '');
  const [workerName, setWorkerName] = useState(stageData.worker_name || '');
  const [scrapValue, setScrapValue] = useState(stageData.scrap_value || '');
  const [rejQty, setRejQty] = useState(String(stageData.rejection_qty || 0));
  const [remadeQty, setRemadeQty] = useState(String(stageData.remade_qty || 0));
  const [dispatchedQty, setDispatchedQty] = useState(String(stageData.dispatched_qty || ''));
  const [dispatchRemadeQty, setDispatchRemadeQty] = useState(String(stageData.remade_qty || ''));
  const [dispatchRemadeReason, setDispatchRemadeReason] = useState(stageData.value1 || '');
  const [rejPhoto, setRejPhoto] = useState(stageData.rejection_photo_file || null);
  // stagePhotoFile tracks the uploaded photo locally so the form stays open after upload
  const [stagePhotoFile, setStagePhotoFile] = useState(stageData.photo_file || null);
  const [notes, setNotes] = useState(stageData.notes || '');
  const [uploadingRejPhoto, setUploadingRejPhoto] = useState(false);
  const [uploadingStagePhoto, setUploadingStagePhoto] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [qtyMismatchModal, setQtyMismatchModal] = useState(null); // { originalQty, netQty, breakdown }

  const needsWorker = WORKER_NAME_STAGES.has(stageDef.no);
  const hasScrap = SCRAP_VALUE_STAGES.has(stageDef.no);
  const isHvLight = !!stageDef.hvLight;

  // HV + Light Check specific state — stored as JSON in value1
  // { hv: 'pass'|'fail', hvCount, hvReason, light: 'pass'|'fail', lightCount, lightReason, ohms }
  const hvData = (() => {
    if (!isHvLight || !stageData.value1) return {};
    try { return JSON.parse(stageData.value1); }
    catch { return { light: stageData.value1 }; } // backward compat with old pipe format
  })();
  const [hvTestResult, setHvTestResult] = useState(hvData.hv || '');
  const [hvTestFailCount, setHvTestFailCount] = useState(hvData.hvCount || '');
  const [hvTestFailReason, setHvTestFailReason] = useState(hvData.hvReason || '');
  const [hvLightResult, setHvLightResult] = useState(hvData.light || '');
  const [hvLightFailCount, setHvLightFailCount] = useState(hvData.lightCount || '');
  const [hvLightFailReason, setHvLightFailReason] = useState(hvData.lightReason || '');
  const [hvOhms, setHvOhms] = useState(hvData.ohms || '');

  // Bending (14) — Heater Adjustment checkbox
  const isBending = stageDef.no === 14;
  const [heaterAdjustDone, setHeaterAdjustDone] = useState(() => stageData.value1 === 'adjusted');

  // Brazing (13) — stored as JSON in value1
  // { airPressure: 'pass'|'fail', airPressureRemark, airCleaning: bool, remark }
  const isBrazing = !!stageDef.brazing;
  const brazingData = (() => {
    if (!isBrazing || !stageData.value1) return {};
    try { return JSON.parse(stageData.value1); } catch { return {}; }
  })();
  const [brazingAirPressure, setBrazingAirPressure] = useState(brazingData.airPressure || '');
  const [brazingAirPressureRemark, setBrazingAirPressureRemark] = useState(brazingData.airPressureRemark || '');
  const [brazingAirCleaning, setBrazingAirCleaning] = useState(!!brazingData.airCleaning);
  const [brazingRemark, setBrazingRemark] = useState(brazingData.remark || '');

  // Stage 1 (Coil) — gauge picked from inventory items in category "Spring Guage".
  // Stored in value1 (just a record of which gauge was used; no stock deduction).
  const isGauge = !!stageDef.gaugeSelect;
  const [gaugeOptions, setGaugeOptions] = useState([]);
  useEffect(() => {
    if (!isGauge) return;
    api.get('/inventory').then(r => {
      setGaugeOptions((r.data || []).filter(i => {
        const c = (i.category || '').toLowerCase().trim();
        return c === 'spring guage' || c === 'spring gauge';
      }));
    }).catch(() => {});
  }, [isGauge]);

  const isDone = stageData.done === 1;
  // After 6pm: require a photo for any stage completion
  const isAfter6pm = new Date().getHours() >= 18;
  // photoAlwaysRequired: stages where upload IS the done action (Cleaning, Dispatch)
  const photoAlwaysRequired = !!stageDef.photo;
  // photoRequiredForStage: stages that always need a photo before marking done (e.g. stage 29)
  const photoRequiredForStage = !!stageDef.photoRequired;
  // photoRequiredAfter6pm: after 6pm, photo needed but form stays open so rejection can be entered
  const photoRequiredAfter6pm = isAfter6pm && !stageDef.photo && !stageDef.photoRequired;
  // legacy alias used by UI below
  const requiresPhoto = photoAlwaysRequired || photoRequiredAfter6pm || photoRequiredForStage;
  const rejQtyInt = parseInt(rejQty, 10) || 0;
  const canManage = ['production', 'owner', 'admin'].includes(user.role);

  // Check if all mandatory stages are done (for stage 28 gate)
  const mandatoryMissing = useMemo(() => {
    if (stageDef.no !== 29) return [];
    return MANDATORY_STAGE_NOS.filter(n => !stageMap[n]?.done);
  }, [stageDef.no, stageMap]);

  const canMarkDone = () => {
    if (isDone || saving) return false;
    if (needsWorker && !workerName.trim()) return false;
    if (isBending && !heaterAdjustDone) return false;
    if (isBrazing) {
      if (!brazingAirPressure) return false;
      if (brazingAirPressure === 'fail' && !brazingAirPressureRemark.trim()) return false;
      if (!brazingAirCleaning) return false;
    }
    if (isHvLight) {
      if (!hvTestResult || !hvLightResult) return false;
      if (hvTestResult === 'fail' && (!hvTestFailCount || !hvTestFailReason.trim())) return false;
      if (hvLightResult === 'fail' && (!hvLightFailCount || !hvLightFailReason.trim())) return false;
    }
    if (stageDef.fields) {
      // Check required fields
      const field1 = stageDef.fields[0];
      if (field1?.required && !value1.trim()) return false;
      const field2 = stageDef.fields[1];
      if (field2?.required && !value2.trim()) return false;
      // For non-required fields, check at least one value if field exists
      if (!field1?.required && !value1.trim() && stageDef.fields.length > 0) return false;
    }
    if (stageDef.coilWeight && !(parseFloat(coilWeight) > 0)) return false; // total coil weight required (stage 3)
    if (stageDef.gaugeSelect && card.material_deduction && !value1) return false; // gauge required for material-tracked orders (stage 1)
    if (photoAlwaysRequired) return false; // photo upload IS the done action for these stages
    if (photoRequiredForStage && !stagePhotoFile) return false; // stage requires photo before marking done
    if (photoRequiredAfter6pm && !stagePhotoFile) return false; // need photo first, then Mark Done
    if (rejQtyInt > 0 && !rejPhoto) return false; // any rejection requires photo
    if (stageDef.no === 29 && mandatoryMissing.length > 0) return false;
    if (stageDef.isDispatch && parseInt(dispatchRemadeQty, 10) > 0 && !dispatchRemadeReason.trim()) return false;
    return true;
  };

  // Build value1 / value2 for saving
  const buildValues = () => {
    if (isHvLight) return {
      v1: JSON.stringify({ hv: hvTestResult, hvCount: hvTestFailCount, hvReason: hvTestFailReason, light: hvLightResult, lightCount: hvLightFailCount, lightReason: hvLightFailReason, ohms: hvOhms }),
      v2: null,
    };
    if (isBrazing) return {
      v1: JSON.stringify({ airPressure: brazingAirPressure, airPressureRemark: brazingAirPressureRemark, airCleaning: brazingAirCleaning, remark: brazingRemark }),
      v2: null,
    };
    if (isBending) return { v1: heaterAdjustDone ? 'adjusted' : null, v2: null };
    return { v1: value1 || null, v2: value2 || null };
  };

  const uploadRejectionPhoto = async (file) => {
    setUploadingRejPhoto(true);
    setError('');
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await api.post(`/job-cards/${card.id}/checklist/${stageDef.no}/rejection-photo`, fd);
      setRejPhoto(r.data.file_name);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to upload rejection photo');
    } finally {
      setUploadingRejPhoto(false);
    }
  };

  const uploadStagePhoto = async (file) => {
    if (needsWorker && !workerName.trim()) {
      return setError('Worker name is required');
    }
    setUploadingStagePhoto(true);
    setError('');
    const fd = new FormData();
    fd.append('file', file);
    const isDispatchStage = !!stageDef.isDispatch;
    const remadeAtDispatch = parseInt(dispatchRemadeQty, 10) || 0;
    const finalDispatchQtyForPhoto = (card.net_qty ?? card.qty ?? 0) + remadeAtDispatch;
    fd.append('rejection_qty', isDispatchStage ? '0' : String(rejQtyInt));
    fd.append('remade_qty', isDispatchStage ? String(remadeAtDispatch) : (remadeQty || '0'));
    if (workerName) fd.append('worker_name', workerName);
    if (scrapValue) fd.append('scrap_value', scrapValue);
    const { v1, v2 } = buildValues();
    fd.append('value1', isDispatchStage ? (dispatchRemadeReason || '') : (v1 || ''));
    if (!isDispatchStage && v2) fd.append('value2', v2);
    if (isDispatchStage) fd.append('dispatched_qty', String(finalDispatchQtyForPhoto));
    // For always-photo stages (Cleaning/Dispatch): upload = mark done immediately
    // For after-6pm-only: just save the photo, keep form open so rejection can be filled
    fd.append('mark_done', photoAlwaysRequired ? 'true' : 'false');
    try {
      const r = await api.post(`/job-cards/${card.id}/checklist/${stageDef.no}/photo`, fd);
      if (photoAlwaysRequired) {
        // Upload IS the done action — navigate away
        await onSaved();
      } else {
        // After-6pm: photo saved, stay on form so rejection qty can be entered
        setStagePhotoFile(r.data.file_name);
        setUploadingStagePhoto(false);
      }
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to upload photo');
      setUploadingStagePhoto(false);
    }
  };

  const doMarkDone = async () => {
    setSaving(true);
    setError('');
    try {
      const { v1, v2 } = buildValues();
      const isDispatch = !!stageDef.isDispatch;
      const remadeAtDispatch = parseInt(dispatchRemadeQty, 10) || 0;
      const finalDispatchQty = (card.net_qty ?? card.qty ?? 0) + remadeAtDispatch;
      await api.put(`/job-cards/${card.id}/checklist/${stageDef.no}`, {
        done: true,
        value1: isDispatch ? (dispatchRemadeReason || null) : v1,
        value2: isDispatch ? null : v2,
        rejection_qty: isDispatch ? 0 : rejQtyInt,
        remade_qty: isDispatch ? remadeAtDispatch : (parseInt(remadeQty, 10) || 0),
        worker_name: workerName || null,
        scrap_value: scrapValue || null,
        notes: notes || null,
        ...(stageDef.coilWeight ? { coil_weight: coilWeight } : {}),
        ...(isDispatch ? { dispatched_qty: finalDispatchQty } : {}),
      });
      await onSaved();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save');
      setSaving(false);
    }
  };

  const handleMarkDone = () => {
    // Stage 29 (QC trigger): check if net qty matches original qty
    if (stageDef.no === 29) {
      const originalQty = parseInt(card.qty, 10) || 0;
      const totalRejected = Object.values(stageMap).reduce((sum, s) => sum + (parseInt(s.rejection_qty, 10) || 0), 0);
      const totalRemade   = Object.values(stageMap).reduce((sum, s) => sum + (parseInt(s.remade_qty,   10) || 0), 0);
      const netQty = Math.max(originalQty - totalRejected + totalRemade, 0);
      if (netQty !== originalQty) {
        setQtyMismatchModal({ originalQty, netQty, breakdown: { totalRejected, totalRemade } });
        return;
      }
    }
    doMarkDone();
  };

  const handleUndo = async () => {
    if (!window.confirm(`Undo Stage ${stageDef.no}: ${stageDef.name}?`)) return;
    setSaving(true);
    setError('');
    try {
      await api.put(`/job-cards/${card.id}/checklist/${stageDef.no}`, {
        done: false,
        value1: stageData.value1,
        value2: stageData.value2,
        rejection_qty: stageData.rejection_qty || 0,
        remade_qty: stageData.remade_qty || 0,
        ...(stageDef.coilWeight ? { coil_weight: stageData.coil_weight } : {}),
      });
      await onSaved();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to undo');
      setSaving(false);
    }
  };

  return (
    <div>
      {/* Qty mismatch confirmation modal for QC trigger */}
      {qtyMismatchModal && (
        <QtyMismatchModal
          {...qtyMismatchModal}
          onConfirm={() => { setQtyMismatchModal(null); doMarkDone(); }}
          onCancel={() => setQtyMismatchModal(null)}
        />
      )}

      {/* Back link */}
      <button
        className="flex items-center gap-1 text-sm text-brand-600 hover:text-brand-800 mb-4"
        onClick={onBack}
      >
        <ArrowLeft size={15} /> Back to checklist
      </button>

      {/* Done banner */}
      {isDone && (
        <div className="flex items-center gap-2 mb-4 p-3 bg-green-50 rounded-xl border border-green-200">
          <CheckCircle size={18} className="text-green-500 flex-shrink-0" />
          <span className="text-green-700 text-sm font-medium">
            Completed {fmtDateTime(stageData.done_at)}
          </span>
        </div>
      )}

      {/* Stage 29 QC gate warning */}
      {stageDef.no === 29 && !isDone && mandatoryMissing.length > 0 && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-xl">
          <div className="text-amber-700 font-semibold text-sm flex items-center gap-2 mb-1">
            <AlertTriangle size={15} /> Cannot trigger QC yet
          </div>
          <p className="text-xs text-amber-600">
            Complete these mandatory stages first:{' '}
            {mandatoryMissing.map(n => `Stage ${n}`).join(', ')}
          </p>
        </div>
      )}

      {/* Stage 29: show final qty summary so production can review before triggering QC */}
      {stageDef.no === 29 && (() => {
        const originalQty  = parseInt(card.qty, 10) || 0;
        const totalRejected = Object.values(stageMap).reduce((sum, s) => sum + (parseInt(s.rejection_qty, 10) || 0), 0);
        const totalRemade   = Object.values(stageMap).reduce((sum, s) => sum + (parseInt(s.remade_qty,   10) || 0), 0);
        const netQty = Math.max(originalQty - totalRejected + totalRemade, 0);
        const isShort = netQty < originalQty;
        return (
          <div className={`mb-4 p-3 rounded-xl border text-sm ${isShort ? 'bg-orange-50 border-orange-200' : 'bg-green-50 border-green-200'}`}>
            <div className={`font-semibold mb-2 flex items-center gap-2 ${isShort ? 'text-orange-700' : 'text-green-700'}`}>
              {isShort ? <AlertTriangle size={15} /> : <CheckCircle size={15} />}
              Final Dispatchable Qty Summary
            </div>
            <div className="space-y-1 text-xs">
              <div className="flex justify-between"><span className="text-gray-600">Original Job Card Qty</span><span className="font-medium">{originalQty} pcs</span></div>
              {totalRejected > 0 && <div className="flex justify-between text-red-600"><span>Total Rejections</span><span className="font-medium">− {totalRejected} pcs</span></div>}
              {totalRemade   > 0 && <div className="flex justify-between text-green-600"><span>Remade / Recovered</span><span className="font-medium">+ {totalRemade} pcs</span></div>}
              <div className={`flex justify-between border-t pt-1 mt-1 font-semibold ${isShort ? 'border-orange-200 text-orange-700' : 'border-green-200 text-green-700'}`}>
                <span>Final Dispatchable Qty</span><span>{netQty} pcs</span>
              </div>
              {isShort && <div className="text-orange-600 mt-1">⚠️ You will be asked to confirm this difference before sending to QC.</div>}
            </div>
          </div>
        );
      })()}


      {/* Dispatch fields (stage 29 — Dispatch Preparation, triggers QC) */}
      {stageDef.isDispatch && (() => {
        const preDispatchQty  = card.net_qty ?? card.qty ?? 0;
        const remadeAtDispatch = parseInt(dispatchRemadeQty, 10) || 0;
        const finalQty = preDispatchQty + remadeAtDispatch;
        return (
          <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-xl space-y-3">
            {/* Remade qty at dispatch */}
            <div>
              <label className="block text-sm font-semibold text-blue-800 mb-1.5">
                Remade Qty at Dispatch <span className="text-gray-400 font-normal text-xs">(optional)</span>
              </label>
              {isDone ? (
                <div className="text-sm text-gray-700 bg-white px-3 py-2 rounded-lg border border-blue-200">
                  {stageData.remade_qty || 0}
                </div>
              ) : (
                <input
                  className="input w-full"
                  type="number"
                  min="0"
                  placeholder="0"
                  value={dispatchRemadeQty}
                  onChange={e => setDispatchRemadeQty(e.target.value)}
                />
              )}
            </div>

            {(parseInt(dispatchRemadeQty, 10) > 0 || (isDone && stageData.value1)) && (
              <div>
                <label className="block text-sm font-semibold text-blue-800 mb-1.5">
                  Reason for Remade <span className="text-red-500">*</span>
                </label>
                {isDone ? (
                  <div className="text-sm text-gray-700 bg-white px-3 py-2 rounded-lg border border-blue-200">
                    {stageData.value1 || '—'}
                  </div>
                ) : (
                  <input
                    className="input w-full"
                    placeholder="e.g. replaced broken elements before dispatch"
                    value={dispatchRemadeReason}
                    onChange={e => setDispatchRemadeReason(e.target.value)}
                  />
                )}
              </div>
            )}

            {/* Auto-calculated final dispatched qty */}
            <div className="pt-2 border-t border-blue-200">
              <p className="text-xs text-blue-600 mb-1">Final Dispatched Quantity (auto-calculated)</p>
              <div className="flex items-center gap-2">
                <span className="text-2xl font-bold text-blue-800">{isDone ? stageData.dispatched_qty : finalQty}</span>
                <span className="text-xs text-blue-500">units</span>
              </div>
              {!isDone && (
                <p className="text-xs text-gray-500 mt-1">
                  {preDispatchQty} pre-dispatch
                  {remadeAtDispatch > 0 && <span className="text-green-600"> + {remadeAtDispatch} remade</span>}
                  {card.net_qty != null && card.net_qty < card.qty && (
                    <span className="text-orange-500"> (original {card.qty} − {card.qty - card.net_qty} rejected)</span>
                  )}
                </p>
              )}
            </div>
          </div>
        );
      })()}

      {/* Worker Name (all production stages up to QC) */}
      {needsWorker && (
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Worker Name <span className="text-red-500">*</span>
          </label>
          {isDone && stageData.worker_name ? (
            <div className="text-sm text-gray-700 bg-gray-50 px-3 py-2 rounded-lg border border-gray-200">
              {stageData.worker_name}
            </div>
          ) : (
            <input
              className="input w-full"
              placeholder="Enter worker name"
              value={workerName}
              onChange={e => setWorkerName(e.target.value)}
              disabled={isDone}
            />
          )}
        </div>
      )}

      {/* HV + Light Check */}
      {isHvLight && (
        <div className="mb-4 space-y-4">
          {/* HV Test Result */}
          <HvTestBlock
            label="HV Test Result"
            result={hvTestResult}
            failCount={hvTestFailCount}
            failReason={hvTestFailReason}
            isDone={isDone}
            doneResult={hvData.hv}
            doneCount={hvData.hvCount}
            doneReason={hvData.hvReason}
            onResult={setHvTestResult}
            onCount={setHvTestFailCount}
            onReason={setHvTestFailReason}
          />

          {/* Light Check Result */}
          <HvTestBlock
            label="Light Check Result"
            result={hvLightResult}
            failCount={hvLightFailCount}
            failReason={hvLightFailReason}
            isDone={isDone}
            doneResult={hvData.light}
            doneCount={hvData.lightCount}
            doneReason={hvData.lightReason}
            onResult={setHvLightResult}
            onCount={setHvLightFailCount}
            onReason={setHvLightFailReason}
          />

          {/* Ohms / Remark */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Ohms Value <span className="text-xs text-gray-400 font-normal">(remark)</span>
            </label>
            {isDone ? (
              <div className="text-sm text-gray-700 bg-gray-50 px-3 py-2 rounded-lg border border-gray-200">
                {hvData.ohms || '—'}
              </div>
            ) : (
              <input className="input w-full" placeholder="Enter ohms value or remark"
                value={hvOhms} onChange={e => setHvOhms(e.target.value)} />
            )}
          </div>
        </div>
      )}

      {/* Stage note (e.g. Heater Cleaning instructions) */}
      {stageDef.note && (
        <div className="mb-4 flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
          <span className="text-base">ℹ️</span> {stageDef.note}
        </div>
      )}

      {/* Bending — Heater Adjustment */}
      {isBending && (
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Heater Adjustment <span className="text-red-500">*</span>
          </label>
          {isDone ? (
            <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium ${
              stageData.value1 === 'adjusted' ? 'bg-green-50 border-green-200 text-green-700' : 'bg-gray-50 border-gray-200 text-gray-500'
            }`}>
              {stageData.value1 === 'adjusted' ? '✅ Heater Adjustment Done' : '— Not recorded'}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setHeaterAdjustDone(v => !v)}
              className={`flex items-center gap-3 w-full px-4 py-3 rounded-xl border-2 font-semibold text-sm transition-colors ${
                heaterAdjustDone
                  ? 'bg-green-50 border-green-500 text-green-700'
                  : 'border-gray-200 text-gray-500 hover:border-green-300'
              }`}
            >
              <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${
                heaterAdjustDone ? 'bg-green-500 border-green-500' : 'border-gray-300'
              }`}>
                {heaterAdjustDone && <Check size={12} className="text-white" />}
              </div>
              Heater Adjustment Done
              {!heaterAdjustDone && <span className="text-xs text-red-500 ml-auto font-normal">(required to mark done)</span>}
            </button>
          )}
        </div>
      )}

      {/* Brazing (Stage 13) */}
      {isBrazing && (
        <div className="mb-4 space-y-4">
          {/* Air Pressure Check */}
          <HvTestBlock
            label="Air Pressure Check"
            result={brazingAirPressure}
            failCount=""
            failReason={brazingAirPressureRemark}
            isDone={isDone}
            doneResult={brazingData.airPressure}
            doneCount=""
            doneReason={brazingData.airPressureRemark}
            onResult={setBrazingAirPressure}
            onCount={() => {}}
            onReason={setBrazingAirPressureRemark}
            passLabel="✅ All Pass"
            failLabel="❌ Some Failed"
            hideCount
          />

          {/* Air Cleaning Check */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Air Cleaning Check <span className="text-red-500">*</span>
            </label>
            {isDone ? (
              <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium ${
                brazingData.airCleaning ? 'bg-green-50 border-green-200 text-green-700' : 'bg-gray-50 border-gray-200 text-gray-500'
              }`}>
                {brazingData.airCleaning ? '✅ Air Cleaning Done' : '— Not recorded'}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setBrazingAirCleaning(v => !v)}
                className={`flex items-center gap-3 w-full px-4 py-3 rounded-xl border-2 font-semibold text-sm transition-colors ${
                  brazingAirCleaning
                    ? 'bg-green-50 border-green-500 text-green-700'
                    : 'border-gray-200 text-gray-500 hover:border-green-300'
                }`}
              >
                <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${
                  brazingAirCleaning ? 'bg-green-500 border-green-500' : 'border-gray-300'
                }`}>
                  {brazingAirCleaning && <Check size={12} className="text-white" />}
                </div>
                Air Cleaning All Done
                {!brazingAirCleaning && <span className="text-xs text-red-500 ml-auto font-normal">(required to mark done)</span>}
              </button>
            )}
          </div>

          {/* Brazing remark */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Remark <span className="text-xs text-gray-400 font-normal">(optional)</span>
            </label>
            {isDone ? (
              <div className="text-sm text-gray-700 bg-gray-50 px-3 py-2 rounded-lg border border-gray-200">
                {brazingData.remark || '—'}
              </div>
            ) : (
              <input className="input w-full" placeholder="Add a remark..."
                value={brazingRemark} onChange={e => setBrazingRemark(e.target.value)} />
            )}
          </div>
        </div>
      )}

      {/* Value fields */}
      {/* Gauge selection (stage 1 — from inventory category "Spring Guage") */}
      {stageDef.gaugeSelect && (
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Gauge {card.material_deduction
              ? <span className="text-red-500">*</span>
              : <span className="text-xs text-gray-400 font-normal">(optional)</span>}
          </label>
          {isDone ? (
            <div className="text-sm text-gray-700 bg-gray-50 px-3 py-2 rounded-lg border border-gray-200">
              {stageData.value1 || '—'}
            </div>
          ) : (
            <select className="input w-full" value={value1} onChange={e => setValue1(e.target.value)}>
              <option value="">— Select gauge —</option>
              {gaugeOptions.map(g => (
                <option key={g.id} value={g.item_code}>{g.item_code} — {g.name}</option>
              ))}
            </select>
          )}
          {!isDone && gaugeOptions.length === 0 && (
            <p className="text-xs text-amber-600 mt-1">No items found in the "Spring Guage" inventory category — add them under Inventory first.</p>
          )}
        </div>
      )}

      {stageDef.fields && (
        <div className="mb-4 space-y-3">
          {stageDef.fields.map((field, idx) => (
            <div key={field.key}>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {field.label} <span className="text-red-500">*</span>
              </label>
              <input
                className="input w-full"
                placeholder={`Enter ${field.label}`}
                value={idx === 0 ? value1 : value2}
                onChange={e => idx === 0 ? setValue1(e.target.value) : setValue2(e.target.value)}
                disabled={isDone}
              />
            </div>
          ))}
        </div>
      )}

      {/* Total weight of all coils produced (stage 3 — required to mark done) */}
      {stageDef.coilWeight && (
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Total Weight of All Coils (kg) <span className="text-red-500">*</span>
          </label>
          {isDone ? (
            <div className="text-sm text-gray-700 bg-gray-50 px-3 py-2 rounded-lg border border-gray-200">
              {stageData.coil_weight != null ? `${stageData.coil_weight} kg` : '—'}
            </div>
          ) : (
            <input
              className="input w-full"
              type="number"
              step="any"
              min="0"
              placeholder="e.g. 12.5"
              value={coilWeight}
              onChange={e => setCoilWeight(e.target.value)}
            />
          )}
          <p className="text-xs text-gray-400 mt-1">Combined weight of every coil made for this job card.</p>
        </div>
      )}

      {/* Scrap Value (optional, only for specific stages) */}
      {hasScrap && (
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Scrap Value <span className="text-xs text-gray-400 font-normal">(optional)</span>
          </label>
          {isDone && stageData.scrap_value ? (
            <div className="text-sm text-gray-700 bg-gray-50 px-3 py-2 rounded-lg border border-gray-200">
              {stageData.scrap_value}
            </div>
          ) : (
            <input
              className="input w-full"
              placeholder="Enter scrap value (optional)"
              value={scrapValue}
              onChange={e => setScrapValue(e.target.value)}
              disabled={isDone}
            />
          )}
        </div>
      )}

      {/* Stage photo */}
      {requiresPhoto && (
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Stage Photo <span className="text-red-500">*</span>
            <span className="text-xs text-gray-400 font-normal ml-2">
              {photoRequiredForStage
                ? stagePhotoFile ? '✓ Photo uploaded — you can now mark done'
                                 : '(photo of heater required before sending to QC)'
                : photoRequiredAfter6pm
                  ? stagePhotoFile ? '✓ Photo uploaded — fill in rejection details below then Mark Done'
                                   : '(upload photo first, then Mark Done)'
                  : '(required to mark done)'}
            </span>
          </label>
          {stagePhotoFile ? (
            <div className="flex items-center gap-3">
              <a href={`/uploads/checklist-photos/${stagePhotoFile}`} target="_blank" rel="noopener noreferrer">
                <img src={`/uploads/checklist-photos/${stagePhotoFile}`}
                  alt="stage photo" className="w-16 h-16 object-cover rounded-lg border border-green-200 hover:opacity-90" />
              </a>
              {canManage && !isDone && (
                <label className="btn-secondary btn-sm text-xs cursor-pointer">
                  Replace
                  <input type="file" accept=".jpg,.jpeg,.png,.webp" className="hidden"
                    onChange={e => e.target.files[0] && uploadStagePhoto(e.target.files[0])} />
                </label>
              )}
            </div>
          ) : canManage ? (
            <label className={`inline-flex items-center gap-2 btn-secondary cursor-pointer ${uploadingStagePhoto ? 'opacity-50 pointer-events-none' : ''}`}>
              <ImageIcon size={15} />
              {uploadingStagePhoto
                ? 'Uploading...'
                : photoRequiredAfter6pm
                  ? 'Upload Photo (required after 6pm)'
                  : 'Upload Photo to Mark Done'}
              <input type="file" accept=".jpg,.jpeg,.png,.webp" className="hidden"
                onChange={e => e.target.files[0] && uploadStagePhoto(e.target.files[0])} />
            </label>
          ) : (
            <p className="text-sm text-gray-400">No photo uploaded</p>
          )}
        </div>
      )}

      {/* Rejection section — hidden for dispatch stage (no rejections at dispatch) */}
      {!stageDef.isDispatch && <div className="mt-2 pt-4 border-t border-gray-100">
        <p className="text-sm font-medium text-gray-700 mb-3">Rejection at this stage</p>

        <div className="flex items-center gap-3 mb-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Rejected pieces</label>
            <input
              type="number" min="0"
              className="input w-28 text-center"
              value={rejQty}
              onChange={e => setRejQty(e.target.value)}
              disabled={isDone}
            />
          </div>
          {rejQtyInt > 0 && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">Remade qty</label>
              <input
                type="number" min="0"
                className="input w-28 text-center"
                value={remadeQty}
                onChange={e => setRemadeQty(e.target.value)}
                disabled={isDone}
              />
            </div>
          )}
        </div>

        {isDone && (stageData.rejection_qty > 0) && (
          <div className="text-sm text-orange-600 mb-2">
            <span className="font-medium">Rejected: {stageData.rejection_qty}</span>
            {stageData.remade_qty > 0 && <span className="text-gray-500 ml-3">Remade: {stageData.remade_qty}</span>}
            {stageData.rejection_photo_file && (
              <a href={`/uploads/rejection-photos/${stageData.rejection_photo_file}`}
                target="_blank" rel="noopener noreferrer"
                className="ml-3 text-red-500 underline text-xs">View rejection photo</a>
            )}
          </div>
        )}

        {/* Rework/Notes section for all stages */}
        <div className="mb-4">
          <label className="block text-xs text-gray-500 mb-1 uppercase tracking-wide">Rework/Notes (Optional)</label>
          <textarea
            className="input text-sm"
            placeholder="Add any rework notes or observations for this stage..."
            value={notes}
            onChange={e => setNotes(e.target.value)}
            disabled={isDone}
            rows={3}
          />
        </div>

        {/* Rejection photo upload section — required for any rejection */}
        {!isDone && rejQtyInt > 0 && (
          <div className={`rounded-xl p-3 mt-2 border ${rejQtyInt > 2 ? 'bg-red-50 border-red-200' : 'bg-yellow-50 border-yellow-200'}`}>
            {rejQtyInt > 2 ? (
              <>
                <div className="flex items-center gap-2 text-red-700 font-semibold text-sm mb-1">
                  <AlertTriangle size={15} /> High Rejection — Work Must Stop
                </div>
                <p className="text-xs text-red-600 mb-3">
                  {rejQtyInt} pieces rejected. Upload a photo of the rejected heater.
                  Owner approval required before work can continue.
                </p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 text-yellow-700 font-semibold text-sm mb-1">
                  <AlertTriangle size={15} /> Rejection Detected
                </div>
                <p className="text-xs text-yellow-600 mb-3">
                  {rejQtyInt} piece{rejQtyInt > 1 ? 's' : ''} rejected. Please upload a rejection photo to complete this stage.
                </p>
              </>
            )}
            {rejPhoto ? (
              <div className="flex items-center gap-3">
                <a href={`/uploads/rejection-photos/${rejPhoto}`} target="_blank" rel="noopener noreferrer">
                  <img src={`/uploads/rejection-photos/${rejPhoto}`}
                    alt="rejection" className="w-14 h-14 object-cover rounded-lg border" style={{borderColor: rejQtyInt > 2 ? 'rgb(254, 226, 226)' : 'rgb(254, 243, 199)'}} />
                </a>
                <label className="btn-secondary btn-sm text-xs cursor-pointer">
                  Replace Photo
                  <input type="file" accept=".jpg,.jpeg,.png,.webp" className="hidden"
                    onChange={e => e.target.files[0] && uploadRejectionPhoto(e.target.files[0])} />
                </label>
                <span className="text-xs text-green-600 font-medium">✓ Photo uploaded</span>
              </div>
            ) : (
              <label className={`inline-flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg border text-sm font-medium ${
                rejQtyInt > 2
                  ? 'border-red-300 text-red-600 hover:bg-red-100'
                  : 'border-yellow-300 text-yellow-600 hover:bg-yellow-100'
              } ${uploadingRejPhoto ? 'opacity-50 pointer-events-none' : ''}`}>
                <ImageIcon size={15} />
                {uploadingRejPhoto ? 'Uploading...' : 'Upload Rejection Photo *'}
                <input type="file" accept=".jpg,.jpeg,.png,.webp" className="hidden"
                  onChange={e => e.target.files[0] && uploadRejectionPhoto(e.target.files[0])} />
              </label>
            )}
          </div>
        )}
      </div>}

      {/* Error */}
      {error && (
        <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Footer actions */}
      <div className="flex justify-between gap-3 pt-4 mt-4 border-t border-gray-100">
        <button className="btn-ghost text-gray-500" onClick={onBack}>Cancel</button>
        <div className="flex gap-2">
          {isDone && canManage && (
            <button
              className="btn-secondary text-red-600 border-red-200 hover:bg-red-50"
              onClick={handleUndo} disabled={saving}
            >
              Undo Stage
            </button>
          )}
          {!isDone && canManage && (
            (!requiresPhoto || (photoRequiredAfter6pm && stagePhotoFile) || (photoRequiredForStage && stagePhotoFile) || stageDef.isDispatch)
          ) && (
            <button
              className="btn-primary"
              onClick={handleMarkDone}
              disabled={!canMarkDone()}
              title={
                mandatoryMissing.length > 0 ? 'Complete all mandatory stages first' :
                rejQtyInt > 2 && !rejPhoto ? 'Upload rejection photo first' :
                stageDef.isDispatch && parseInt(dispatchRemadeQty, 10) > 0 && !dispatchRemadeReason.trim() ? 'Enter reason for remade qty' :
                photoRequiredForStage && !stagePhotoFile ? 'Upload photo first' :
                ''
              }
            >
              {saving ? 'Saving...' : 'Mark Done'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
