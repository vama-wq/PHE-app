import { useEffect, useState } from 'react';
import api from '../lib/api';
import { useAuthStore } from '../store/authStore';
import StatusBadge from '../components/ui/StatusBadge';
import { fmtDate, fmtDateTime, daysUntil, ACTIVITY_ICONS, PRODUCTION_STAGES } from '../lib/utils';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ClipboardList, CheckCircle, Clock, TrendingUp,
  Package, XCircle, ShoppingCart, FlaskConical, Wrench,
  Truck, IndianRupee, Bell, AtSign,
} from 'lucide-react';

// ── Helpers ───────────────────────────────────────────────────────────────────

function canSee(user, moduleId) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  if (!user.permitted_modules) return true;
  try { return JSON.parse(user.permitted_modules).includes(moduleId); }
  catch { return true; }
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 21) return 'Good evening';
  return 'Good night';
}

function fmtRs(n) { // format as Indian rupees
  return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

// ── Shared UI pieces ──────────────────────────────────────────────────────────

function LoadingSpinner() {
  return (
    <div className="p-8 flex items-center justify-center min-h-96">
      <div className="w-8 h-8 border-4 border-brand-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

function StatCard({ label, value, icon: Icon, color = 'blue', sub, to }) {
  const colors = {
    blue:   'bg-blue-50 text-blue-600',
    green:  'bg-green-50 text-green-600',
    orange: 'bg-orange-50 text-orange-600',
    red:    'bg-red-50 text-red-600',
    purple: 'bg-purple-50 text-purple-600',
    teal:   'bg-teal-50 text-teal-600',
    amber:  'bg-amber-50 text-amber-600',
    violet: 'bg-violet-50 text-violet-600',
  };
  const inner = (
    <div className="card p-5 hover:shadow-md transition-shadow">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-gray-500">{label}</span>
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${colors[color]}`}>
          <Icon size={18} />
        </div>
      </div>
      <div className="text-3xl font-bold text-gray-900">{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
    </div>
  );
  return to ? <Link to={to}>{inner}</Link> : inner;
}

function SectionCard({ title, icon: Icon, iconColor = 'text-gray-400', children, action }) {
  return (
    <div className="card">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
        <h2 className="section-title">
          <Icon size={17} className={iconColor} />
          {title}
        </h2>
        {action}
      </div>
      {children}
    </div>
  );
}

function EmptyRow({ message }) {
  return <div className="px-5 py-8 text-center text-gray-400 text-sm">{message}</div>;
}

function ActivityFeed({ items }) {
  return (
    <SectionCard title="Recent Activity" icon={Clock} iconColor="text-gray-400">
      <div className="divide-y divide-gray-50">
        {items.length === 0 ? (
          <EmptyRow message="No recent activity" />
        ) : items.slice(0, 8).map(log => (
          <div key={log.id} className="px-5 py-3">
            <div className="flex items-start gap-2">
              <span className="text-base mt-0.5">{ACTIVITY_ICONS[log.activity_type] || '📌'}</span>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-gray-700 leading-snug">{log.description}</p>
                <p className="text-xs text-gray-400 mt-0.5">{log.user_name} · {fmtDate(log.created_at)}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// ── Mentions Panel ────────────────────────────────────────────────────────────
function MentionsPanel() {
  const [mentions, setMentions] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    api.get('/orders/my-mentions').then(r => { setMentions(r.data); setLoading(false); }).catch(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const markRead = async (id) => {
    await api.put(`/orders/my-mentions/${id}/read`).catch(() => {});
    setMentions(prev => prev.map(m => m.id === id ? { ...m, is_read: 1 } : m));
  };

  const markAllRead = async () => {
    await api.put('/orders/my-mentions/read-all').catch(() => {});
    setMentions(prev => prev.map(m => ({ ...m, is_read: 1 })));
  };

  const unread = mentions.filter(m => !m.is_read).length;

  return (
    <div className="card">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
        <h2 className="section-title">
          <AtSign size={17} className="text-brand-500" />
          Mentions
          {unread > 0 && (
            <span className="ml-2 bg-brand-600 text-white text-xs font-bold px-1.5 py-0.5 rounded-full">{unread}</span>
          )}
        </h2>
        {unread > 0 && (
          <button onClick={markAllRead} className="text-xs text-brand-600 hover:underline">Mark all read</button>
        )}
      </div>
      {loading ? (
        <div className="px-5 py-6 text-center text-gray-400 text-sm">Loading...</div>
      ) : mentions.length === 0 ? (
        <div className="px-5 py-8 text-center text-gray-400 text-sm">
          <AtSign size={24} className="mx-auto mb-2 text-gray-200" />
          No mentions yet
        </div>
      ) : (
        <div className="divide-y divide-gray-50 max-h-72 overflow-y-auto">
          {mentions.map(m => (
            <div
              key={m.id}
              className={`px-4 py-3 flex gap-3 transition-colors ${!m.is_read ? 'bg-brand-50' : ''}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-0.5">
                  {!m.is_read && <span className="w-2 h-2 rounded-full bg-brand-600 flex-shrink-0" />}
                  <span className="text-xs font-semibold text-gray-700">{m.sender_name}</span>
                  <span className="text-xs text-gray-400">in</span>
                  <Link to={`/orders/${m.order_id}`} className="text-xs text-brand-600 hover:underline font-medium">{m.order_code}</Link>
                </div>
                <p className="text-sm text-gray-600 truncate">{m.message}</p>
                <p className="text-xs text-gray-400 mt-0.5">{fmtDateTime(m.created_at)}</p>
              </div>
              {!m.is_read && (
                <button onClick={() => markRead(m.id)} className="text-xs text-gray-400 hover:text-brand-600 flex-shrink-0 self-start pt-1" title="Mark as read">
                  <CheckCircle size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Owner / Admin Dashboard ───────────────────────────────────────────────────

function OwnerAdminDashboard() {
  const { user } = useAuthStore();
  const [orders, setOrders]               = useState([]);
  const [jobCards, setJobCards]           = useState([]);
  const [lowStock, setLowStock]           = useState([]);
  const [recent, setRecent]               = useState([]);
  const [rejections, setRejections]       = useState([]);
  const [activeHolds, setActiveHolds]     = useState([]);
  const [purchaseOrders, setPurchaseOrders] = useState([]);
  const [loading, setLoading]             = useState(true);
  const [approvingHold, setApprovingHold] = useState(null);

  const hasOrders    = canSee(user, 'orders');
  const hasJobCards  = canSee(user, 'job-cards');
  const hasInventory = canSee(user, 'inventory');
  const hasPurchases = canSee(user, 'purchases');

  const loadAll = () => {
    const reqs = [];
    if (hasOrders)    reqs.push(api.get('/orders').then(r => setOrders(r.data)));
    if (hasJobCards)  reqs.push(api.get('/job-cards').then(r => setJobCards(r.data)));
    if (hasInventory) reqs.push(api.get('/inventory/low-stock').then(r => setLowStock(r.data)));
    if (hasPurchases) reqs.push(api.get('/purchase-orders').then(r => setPurchaseOrders(r.data)));
    if (hasJobCards)  reqs.push(api.get('/job-cards/rejections/all').then(r => setRejections(r.data)));
    if (hasJobCards)  reqs.push(api.get('/job-cards/holds/active').then(r => setActiveHolds(r.data)));
    reqs.push(api.get('/activity/recent?limit=10').then(r => setRecent(r.data)));
    return Promise.all(reqs);
  };

  const handleApproveHold = async (jc, e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm(`Approve hold and resume production for ${jc.job_card_no}?`)) return;
    setApprovingHold(jc.id);
    try {
      await api.put(`/job-cards/${jc.id}/hold/approve`);
      await loadAll();
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to approve');
    } finally {
      setApprovingHold(null);
    }
  };

  useEffect(() => {
    const reqs = [];
    if (hasOrders)    reqs.push(api.get('/orders').then(r => setOrders(r.data)));
    if (hasJobCards)  reqs.push(api.get('/job-cards').then(r => setJobCards(r.data)));
    if (hasInventory) reqs.push(api.get('/inventory/low-stock').then(r => setLowStock(r.data)));
    if (hasPurchases) reqs.push(api.get('/purchase-orders').then(r => setPurchaseOrders(r.data)));
    if (hasJobCards)  reqs.push(api.get('/job-cards/rejections/all').then(r => setRejections(r.data)));
    if (hasJobCards)  reqs.push(api.get('/job-cards/holds/active').then(r => setActiveHolds(r.data)));
    reqs.push(api.get('/activity/recent?limit=10').then(r => setRecent(r.data)));
    Promise.all(reqs).finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;

  const pending    = orders.filter(o => o.status === 'pending_approval');
  const inProgress = orders.filter(o => ['in_progress','job_card_created'].includes(o.status));
  const onHold     = jobCards.filter(jc => jc.status === 'on_hold');
  const urgent     = jobCards.filter(jc => {
    const d = daysUntil(jc.dispatch_date);
    return d !== null && d <= 5 && !['dispatched'].includes(jc.status);
  });

  const criticalRejections = rejections.filter(r => r.rejection_qty > 2);
  const pendingPOs  = purchaseOrders.filter(po => ['pending','approved'].includes(po.status));

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{greeting()}, {user.name.split('/')[0].trim()} 👋</h1>
        <p className="text-gray-500 text-sm mt-1">Here's the current state of operations at PHE</p>
      </div>

      {/* Stat row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {hasOrders    && <StatCard label="Pending Approval" value={pending.length}    icon={Clock}          color="orange" to="/orders" />}
        {hasOrders    && <StatCard label="In Progress"      value={inProgress.length} icon={TrendingUp}     color="blue"   to="/orders" />}
        {hasJobCards  && <StatCard label="On Hold"          value={onHold.length}     icon={AlertTriangle}  color={onHold.length > 0 ? 'red' : 'green'} sub={onHold.length > 0 ? 'Requires approval' : 'All clear'} to="/job-cards" />}
        {hasInventory && <StatCard label="Low Stock Items"  value={lowStock.length}   icon={Package}        color={lowStock.length > 0 ? 'red' : 'green'} to="/inventory" />}
        {hasPurchases && <StatCard label="Pending POs"      value={pendingPOs.length} icon={ShoppingCart}   color="teal"   to="/purchases" />}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main column */}
        <div className="lg:col-span-2 space-y-4">

          {/* On Hold job cards */}
          {hasJobCards && onHold.length > 0 && (
            <SectionCard title="Job Cards On Hold — Approval Required" icon={AlertTriangle} iconColor="text-red-500">
              <div className="divide-y divide-gray-50">
                {onHold.map(jc => {
                  // Find active hold record for this job card (cumulative: stage_no=0, single-stage: stage_no>0)
                  const hold = activeHolds.find(h => h.job_card_id === jc.id);
                  const isCumulative = hold?.stage_no === 0;
                  const stageName = (!isCumulative && hold) ? (PRODUCTION_STAGES.find(s => s.no === hold.stage_no)?.name || '') : '';
                  // Fallback: find from rejections list for single-stage holds
                  const rej = !hold ? rejections.find(r => r.job_card_no === jc.job_card_no) : null;
                  const rejStageName = rej ? (PRODUCTION_STAGES.find(s => s.no === rej.stage_no)?.name || '') : '';
                  return (
                    <div key={jc.id} className="px-5 py-4 bg-red-50/30 hover:bg-red-50/50 transition-colors">
                      {/* Top row: card id + approve button */}
                      <div className="flex items-center justify-between gap-3 mb-2">
                        <Link to={`/job-cards/${jc.id}`} className="flex items-center gap-2 min-w-0 flex-1">
                          <span className="font-semibold text-sm text-gray-900">{jc.job_card_no}</span>
                          <span className="text-gray-400">·</span>
                          <span className="text-sm text-gray-600">{jc.customer_code}</span>
                          <StatusBadge status={jc.status} />
                        </Link>
                        {user.role === 'owner' && (
                          <button
                            className="btn-primary btn-sm flex items-center gap-1 text-xs py-1 px-2.5 flex-shrink-0"
                            onClick={(e) => handleApproveHold(jc, e)}
                            disabled={approvingHold === jc.id}
                          >
                            <CheckCircle size={12} />
                            {approvingHold === jc.id ? 'Approving...' : 'Approve to Resume'}
                          </button>
                        )}
                      </div>

                      {/* Hold detail row */}
                      {hold && isCumulative && (
                        <div className="flex items-center gap-2 mt-1 ml-0.5">
                          <AlertTriangle size={13} className="text-orange-500 flex-shrink-0" />
                          <span className="text-xs font-semibold text-orange-700">
                            High cumulative rejection: {hold.rejection_qty} pieces total across all stages
                          </span>
                        </div>
                      )}
                      {hold && !isCumulative && (
                        <div className="flex items-start gap-4 mt-1 ml-0.5">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-semibold text-red-700">
                                {hold.rejection_qty} pieces rejected
                              </span>
                              <span className="text-xs text-gray-400">at</span>
                              <span className="text-xs text-gray-700 font-medium">
                                Stage {hold.stage_no}: {stageName}
                              </span>
                            </div>
                          </div>
                          {hold.hold_photo_file && (
                            <a
                              href={`/uploads/rejection-photos/${hold.hold_photo_file}`}
                              target="_blank" rel="noopener noreferrer"
                              onClick={e => e.stopPropagation()}
                              className="flex-shrink-0" title="View rejection photo"
                            >
                              <img
                                src={`/uploads/rejection-photos/${hold.hold_photo_file}`}
                                alt="Rejection"
                                className="w-14 h-14 object-cover rounded-lg border-2 border-red-200 hover:border-red-400 transition-colors"
                              />
                            </a>
                          )}
                        </div>
                      )}
                      {/* Fallback: no active hold record found but card is on_hold (legacy/edge case) */}
                      {!hold && rej && (
                        <div className="flex items-start gap-4 mt-1 ml-0.5">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-semibold text-red-700">
                                {rej.rejection_qty} pieces rejected
                              </span>
                              <span className="text-xs text-gray-400">at</span>
                              <span className="text-xs text-gray-700 font-medium">
                                Stage {rej.stage_no}: {rejStageName}
                              </span>
                              {rej.remade_qty > 0 && (
                                <span className="text-xs text-gray-500">· Remade: {rej.remade_qty}</span>
                              )}
                            </div>
                            {rej.done_at && (
                              <div className="text-xs text-gray-400 mt-0.5">Reported: {fmtDateTime(rej.done_at)}</div>
                            )}
                          </div>
                          {rej.rejection_photo_file && (
                            <a
                              href={`/uploads/rejection-photos/${rej.rejection_photo_file}`}
                              target="_blank" rel="noopener noreferrer"
                              onClick={e => e.stopPropagation()}
                              className="flex-shrink-0" title="View rejection photo"
                            >
                              <img
                                src={`/uploads/rejection-photos/${rej.rejection_photo_file}`}
                                alt="Rejection"
                                className="w-14 h-14 object-cover rounded-lg border-2 border-red-200 hover:border-red-400 transition-colors"
                              />
                            </a>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </SectionCard>
          )}

          {/* Rejections */}
          {hasJobCards && rejections.length > 0 && (
            <SectionCard
              title="Production Rejections" icon={XCircle} iconColor="text-orange-500"
              action={criticalRejections.length > 0 && (
                <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-semibold">
                  {criticalRejections.length} critical
                </span>
              )}
            >
              <div className="divide-y divide-gray-50">
                {rejections.slice(0, 8).map((r, i) => {
                  const isCritical = r.rejection_qty > 2;
                  const stageName  = PRODUCTION_STAGES.find(s => s.no === r.stage_no)?.name || '';
                  return (
                    <div key={i} className={`flex items-center justify-between px-5 py-3 ${isCritical ? 'bg-red-50/40' : ''}`}>
                      <div className="flex items-center gap-3 min-w-0">
                        {isCritical && <AlertTriangle size={14} className="text-red-500 flex-shrink-0" />}
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-sm text-gray-900">{r.job_card_no}</span>
                            <span className="text-xs text-gray-500">{r.order_code} · {r.customer_code}</span>
                          </div>
                          <div className="text-xs text-gray-500 mt-0.5">Stage {r.stage_no}: {stageName}</div>
                        </div>
                      </div>
                      <div className={`text-sm font-bold flex-shrink-0 ml-3 ${isCritical ? 'text-red-600' : 'text-orange-600'}`}>
                        {r.rejection_qty} rejected
                      </div>
                    </div>
                  );
                })}
                {rejections.length > 8 && (
                  <div className="px-5 py-2 text-xs text-gray-400 text-center">+{rejections.length - 8} more</div>
                )}
              </div>
            </SectionCard>
          )}

          {/* Pending Approvals */}
          {hasOrders && pending.length > 0 && (
            <SectionCard title="Pending Order Approvals" icon={ClipboardList} iconColor="text-yellow-500">
              <div className="divide-y divide-gray-50">
                {pending.map(o => (
                  <Link key={o.id} to={`/orders/${o.id}`}
                    className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 transition-colors">
                    <div>
                      <span className="font-semibold text-sm">{o.order_code}</span>
                      <span className="text-gray-400 mx-2">·</span>
                      <span className="text-sm text-gray-600">{o.customer_code}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-400">{fmtDate(o.order_date)}</span>
                      <StatusBadge status={o.status} />
                    </div>
                  </Link>
                ))}
              </div>
            </SectionCard>
          )}

          {/* Upcoming Dispatches */}
          {hasJobCards && (
            <SectionCard title="Upcoming Dispatches" icon={Truck} iconColor="text-orange-400">
              <div className="divide-y divide-gray-50">
                {urgent.length === 0 ? (
                  <EmptyRow message="No urgent dispatches right now" />
                ) : urgent.slice(0, 6).map(jc => {
                  const days = daysUntil(jc.dispatch_date);
                  return (
                    <Link key={jc.id} to={`/job-cards/${jc.id}`}
                      className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 transition-colors">
                      <div>
                        <span className="font-semibold text-sm text-gray-900">{jc.job_card_no}</span>
                        <span className="text-gray-400 mx-2">·</span>
                        <span className="text-sm text-gray-600">{jc.customer_code}</span>
                      </div>
                      <div className="text-right">
                        <div className={`text-sm font-semibold ${days < 0 ? 'text-red-600' : days <= 2 ? 'text-orange-600' : 'text-yellow-600'}`}>
                          {days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? 'Today!' : `${days}d left`}
                        </div>
                        <div className="text-xs text-gray-400">{fmtDate(jc.dispatch_date)}</div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </SectionCard>
          )}
        </div>

        {/* Side column */}
        <div className="space-y-4">

          {/* Pending POs */}
          {hasPurchases && pendingPOs.length > 0 && (
            <SectionCard title="Pending Purchase Orders" icon={ShoppingCart} iconColor="text-teal-500">
              <div className="divide-y divide-gray-50">
                {pendingPOs.slice(0, 5).map(po => (
                  <Link key={po.id} to={`/purchases/${po.id}`}
                    className="flex items-center justify-between px-5 py-3 hover:bg-gray-50 transition-colors">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-gray-900">{po.po_number}</div>
                      <div className="text-xs text-gray-500 truncate max-w-[130px]">{po.supplier_name}</div>
                    </div>
                    <div className="text-right flex-shrink-0 ml-2">
                      <div className="text-sm font-semibold text-gray-800">{fmtRs(po.total_amount)}</div>
                      <StatusBadge status={po.status} />
                    </div>
                  </Link>
                ))}
                {pendingPOs.length > 5 && (
                  <Link to="/purchases" className="block text-center text-xs text-brand-600 py-2 hover:text-brand-800">
                    +{pendingPOs.length - 5} more
                  </Link>
                )}
              </div>
            </SectionCard>
          )}

          {/* Low Stock */}
          {hasInventory && lowStock.length > 0 && (
            <SectionCard title="Low Stock Alert" icon={Package} iconColor="text-red-500">
              <div className="divide-y divide-gray-50">
                {lowStock.slice(0, 5).map(item => (
                  <Link key={item.id} to={`/inventory/${item.id}`}
                    className="flex items-center justify-between px-5 py-3 hover:bg-gray-50 transition-colors">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-gray-900">{item.item_code}</div>
                      <div className="text-xs text-gray-500 truncate max-w-[120px]">{item.name}</div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-sm font-semibold text-red-600">{item.current_stock} {item.unit}</div>
                      <div className="text-xs text-gray-400">min: {item.reorder_level}</div>
                    </div>
                  </Link>
                ))}
                {lowStock.length > 5 && (
                  <Link to="/inventory" className="block text-center text-xs text-brand-600 py-2 hover:text-brand-800">
                    +{lowStock.length - 5} more items
                  </Link>
                )}
              </div>
            </SectionCard>
          )}

          <MentionsPanel />
          <ActivityFeed items={recent} />
        </div>
      </div>
    </div>
  );
}

// ── Accounts Dashboard ────────────────────────────────────────────────────────

function AccountsDashboard() {
  const { user } = useAuthStore();
  const [orders, setOrders]                   = useState([]);
  const [purchaseOrders, setPurchaseOrders]   = useState([]);
  const [recent, setRecent]                   = useState([]);
  const [loading, setLoading]                 = useState(true);

  const hasOrders    = canSee(user, 'orders');
  const hasPurchases = canSee(user, 'purchases');

  useEffect(() => {
    const reqs = [api.get('/activity/recent?limit=10').then(r => setRecent(r.data))];
    if (hasOrders)    reqs.push(api.get('/orders').then(r => setOrders(r.data)));
    if (hasPurchases) reqs.push(api.get('/purchase-orders').then(r => setPurchaseOrders(r.data)));
    Promise.all(reqs).finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;

  const active        = orders.filter(o => o.status !== 'dispatched');
  const totalValue    = active.reduce((s, o) => s + (o.total_amount || 0), 0);
  const totalAdv      = active.reduce((s, o) => s + (o.advance_paid || 0), 0);
  const totalBalance  = active.reduce((s, o) => s + (o.balance_due  || 0), 0);
  const withBalance   = active.filter(o => o.balance_due > 0).sort((a, b) => (b.balance_due || 0) - (a.balance_due || 0));

  const pendingPOs = purchaseOrders.filter(po => ['pending','approved'].includes(po.status));
  const poValue    = pendingPOs.reduce((s, po) => s + (po.total_amount || 0), 0);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{greeting()}, {user.name.split('/')[0].trim()} 👋</h1>
        <p className="text-gray-500 text-sm mt-1">Financial overview — Peena Heat Elements</p>
      </div>

      {/* Financial stat row */}
      {hasOrders && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard label="Active Orders"   value={active.length}         icon={ClipboardList} color="blue"   to="/orders" />
          <StatCard label="Total Value"     value={fmtRs(totalValue)}     icon={IndianRupee}   color="teal" />
          <StatCard label="Collected"       value={fmtRs(totalAdv)}       icon={CheckCircle}   color="green"  sub={`${active.length - withBalance.length} fully paid`} />
          <StatCard label="Balance Due"     value={fmtRs(totalBalance)}   icon={AlertTriangle} color={totalBalance > 0 ? 'orange' : 'green'} sub={`${withBalance.length} orders pending`} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">

          {/* Outstanding balances */}
          {hasOrders && (
            <SectionCard
              title="Outstanding Balances" icon={IndianRupee} iconColor="text-orange-500"
              action={withBalance.length > 0 && (
                <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-semibold">
                  {fmtRs(totalBalance)} total
                </span>
              )}
            >
              <div className="divide-y divide-gray-50">
                {withBalance.length === 0 ? (
                  <EmptyRow message="All orders are fully paid! 🎉" />
                ) : withBalance.slice(0, 10).map(o => (
                  <Link key={o.id} to={`/orders/${o.id}`}
                    className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 transition-colors">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm text-gray-900">{o.order_code}</span>
                        <StatusBadge status={o.status} />
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">{o.customer_name || o.customer_code}</div>
                    </div>
                    <div className="text-right flex-shrink-0 ml-4">
                      <div className="text-sm font-bold text-orange-600">{fmtRs(o.balance_due)} due</div>
                      <div className="text-xs text-gray-400">of {fmtRs(o.total_amount)}</div>
                    </div>
                  </Link>
                ))}
                {withBalance.length > 10 && (
                  <Link to="/orders" className="block text-center text-xs text-brand-600 py-2">
                    +{withBalance.length - 10} more orders
                  </Link>
                )}
              </div>
            </SectionCard>
          )}

          {/* Active Purchase Orders */}
          {hasPurchases && (
            <SectionCard
              title="Active Purchase Orders" icon={ShoppingCart} iconColor="text-teal-500"
              action={pendingPOs.length > 0 && (
                <span className="text-xs bg-teal-100 text-teal-700 px-2 py-0.5 rounded-full font-semibold">
                  {fmtRs(poValue)} pending
                </span>
              )}
            >
              <div className="divide-y divide-gray-50">
                {pendingPOs.length === 0 ? (
                  <EmptyRow message="No active purchase orders" />
                ) : pendingPOs.slice(0, 8).map(po => (
                  <Link key={po.id} to={`/purchases/${po.id}`}
                    className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 transition-colors">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-gray-900">{po.po_number}</span>
                        <StatusBadge status={po.status} />
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5 truncate">{po.supplier_name}</div>
                    </div>
                    <div className="text-right flex-shrink-0 ml-4">
                      <div className="text-sm font-bold text-gray-800">{fmtRs(po.total_amount)}</div>
                      {po.expected_delivery_date && (
                        <div className="text-xs text-gray-400">Due {fmtDate(po.expected_delivery_date)}</div>
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            </SectionCard>
          )}
        </div>

        {/* Side */}
        <div className="space-y-4">

          {hasPurchases && (
            <div className="card p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Purchase Order Summary</h3>
              <div className="space-y-2.5">
                {[
                  { label: 'Draft',                  count: purchaseOrders.filter(p => p.status === 'draft').length,    color: 'text-gray-500' },
                  { label: 'Pending Approval',       count: purchaseOrders.filter(p => p.status === 'pending').length,  color: 'text-yellow-600' },
                  { label: 'Approved / In Transit',  count: purchaseOrders.filter(p => p.status === 'approved').length, color: 'text-blue-600' },
                  { label: 'Received',               count: purchaseOrders.filter(p => p.status === 'received').length, color: 'text-green-600' },
                ].map(({ label, count, color }) => (
                  <div key={label} className="flex items-center justify-between">
                    <span className="text-xs text-gray-500">{label}</span>
                    <span className={`text-sm font-bold ${color}`}>{count}</span>
                  </div>
                ))}
                <div className="border-t border-gray-100 pt-2 mt-2 flex items-center justify-between">
                  <span className="text-xs text-gray-500 font-medium">Total POs</span>
                  <span className="text-sm font-bold text-gray-800">{purchaseOrders.length}</span>
                </div>
              </div>
            </div>
          )}

          {hasOrders && (
            <div className="card p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Order Financial Summary</h3>
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">Total active orders</span>
                  <span className="text-sm font-bold text-gray-800">{active.length}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">Total order value</span>
                  <span className="text-sm font-bold text-blue-700">{fmtRs(totalValue)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">Amount collected</span>
                  <span className="text-sm font-bold text-green-600">{fmtRs(totalAdv)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">Balance outstanding</span>
                  <span className="text-sm font-bold text-orange-600">{fmtRs(totalBalance)}</span>
                </div>
                {totalValue > 0 && (
                  <div className="pt-1.5">
                    <div className="flex justify-between text-xs text-gray-400 mb-1">
                      <span>Collection rate</span>
                      <span>{Math.round(totalAdv / totalValue * 100)}%</span>
                    </div>
                    <div className="w-full bg-gray-100 rounded-full h-1.5">
                      <div className="bg-green-500 h-1.5 rounded-full" style={{ width: `${Math.round(totalAdv / totalValue * 100)}%` }} />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          <MentionsPanel />
          <ActivityFeed items={recent} />
        </div>
      </div>
    </div>
  );
}

// ── Design / QC Dashboard ─────────────────────────────────────────────────────

function DesignDashboard() {
  const { user } = useAuthStore();
  const [qcCards, setQcCards]       = useState([]);
  const [materialPOs, setMaterialPOs] = useState([]);
  const [recent, setRecent]         = useState([]);
  const [loading, setLoading]       = useState(true);

  const hasQC        = canSee(user, 'qc');
  const hasPurchases = canSee(user, 'purchases');

  useEffect(() => {
    const reqs = [api.get('/activity/recent?limit=10').then(r => setRecent(r.data))];
    if (hasQC) {
      reqs.push(api.get('/qc').then(r => setQcCards(r.data)));
      if (hasPurchases)
        reqs.push(api.get('/purchase-orders/pending-material-qc').then(r => setMaterialPOs(r.data)));
    }
    Promise.all(reqs).finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;

  const pending  = qcCards.filter(c => c.status === 'pending');
  const approved = qcCards.filter(c => c.status === 'approved');
  const rejected = qcCards.filter(c => c.result  === 'rejected');

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{greeting()}, {user.name.split('/')[0].trim()} 👋</h1>
        <p className="text-gray-500 text-sm mt-1">Quality Control overview</p>
      </div>

      {hasQC && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard label="QC Pending"          value={pending.length}      icon={FlaskConical}  color={pending.length > 0 ? 'orange' : 'green'} sub={pending.length > 0 ? 'Awaiting check' : 'All clear!'} to="/qc" />
          <StatCard label="Material QC Pending" value={materialPOs.length}  icon={Package}       color={materialPOs.length > 0 ? 'violet' : 'green'} sub="Received materials" to="/qc" />
          <StatCard label="Approved"            value={approved.length}     icon={CheckCircle}   color="green" />
          <StatCard label="Rejected"            value={rejected.length}     icon={XCircle}       color={rejected.length > 0 ? 'red' : 'green'} sub={rejected.length > 0 ? 'Need rework' : 'None'} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">

          {/* QC Pending job cards */}
          {hasQC && (
            <SectionCard
              title="Job Cards — Pending QC" icon={FlaskConical} iconColor="text-purple-500"
              action={<Link to="/qc" className="text-xs text-brand-600 hover:underline font-medium">Open QC →</Link>}
            >
              <div className="divide-y divide-gray-50">
                {pending.length === 0 ? (
                  <EmptyRow message="No job cards pending QC 🎉" />
                ) : pending.slice(0, 8).map(card => (
                  <Link key={card.id} to="/qc"
                    className="flex items-center justify-between px-5 py-3.5 hover:bg-purple-50/20 transition-colors">
                    <div className="min-w-0">
                      <span className="font-semibold text-sm text-gray-900">{card.job_card_no}</span>
                      <span className="text-gray-400 mx-2">·</span>
                      <span className="text-sm text-gray-600">{card.customer_code}</span>
                      {card.product_name && (
                        <span className="text-xs text-gray-400 ml-2">— {card.product_name}</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-400 flex-shrink-0">{fmtDate(card.created_at)}</div>
                  </Link>
                ))}
                {pending.length > 8 && (
                  <Link to="/qc" className="block text-center text-xs text-brand-600 py-2">
                    +{pending.length - 8} more
                  </Link>
                )}
              </div>
            </SectionCard>
          )}

          {/* Material QC pending */}
          {hasQC && hasPurchases && (
            <SectionCard title="Material QC Pending — Received Purchases" icon={Package} iconColor="text-violet-500">
              <div className="divide-y divide-gray-50">
                {materialPOs.length === 0 ? (
                  <EmptyRow message="No materials waiting for QC" />
                ) : materialPOs.slice(0, 6).map(po => (
                  <Link key={po.id} to={`/purchases/${po.id}`}
                    className="flex items-center justify-between px-5 py-3.5 hover:bg-violet-50/20 transition-colors">
                    <div className="min-w-0">
                      <span className="font-semibold text-sm text-gray-900">{po.po_number}</span>
                      <span className="text-gray-400 mx-2">·</span>
                      <span className="text-sm text-gray-600">{po.supplier_name}</span>
                    </div>
                    <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-medium flex-shrink-0">
                      QC Pending
                    </span>
                  </Link>
                ))}
              </div>
            </SectionCard>
          )}
        </div>

        {/* Side */}
        <div className="space-y-4">

          {hasQC && (
            <div className="card p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">QC Summary</h3>
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">Total in queue</span>
                  <span className="text-sm font-bold text-gray-900">{qcCards.length}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">Pending review</span>
                  <span className="text-sm font-bold text-orange-500">{pending.length}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">Approved</span>
                  <span className="text-sm font-bold text-green-600">{approved.length}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">Rejected</span>
                  <span className="text-sm font-bold text-red-500">{rejected.length}</span>
                </div>
                {qcCards.length > 0 && (
                  <div className="pt-1.5 border-t border-gray-100">
                    <div className="flex justify-between text-xs text-gray-400 mb-1">
                      <span>Pass rate</span>
                      <span>{Math.round(approved.length / qcCards.length * 100)}%</span>
                    </div>
                    <div className="w-full bg-gray-100 rounded-full h-1.5">
                      <div className="bg-green-500 h-1.5 rounded-full"
                        style={{ width: `${Math.round(approved.length / qcCards.length * 100)}%` }} />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          <MentionsPanel />
          <ActivityFeed items={recent} />
        </div>
      </div>
    </div>
  );
}

// ── Production Dashboard ──────────────────────────────────────────────────────

function ProductionDashboard() {
  const { user } = useAuthStore();
  const [jobCards, setJobCards] = useState([]);
  const [recent, setRecent]     = useState([]);
  const [loading, setLoading]   = useState(true);

  const hasJobCards   = canSee(user, 'job-cards');
  const hasProduction = canSee(user, 'production');

  useEffect(() => {
    const reqs = [api.get('/activity/recent?limit=10').then(r => setRecent(r.data))];
    if (hasJobCards || hasProduction)
      reqs.push(api.get('/job-cards').then(r => setJobCards(r.data)));
    Promise.all(reqs).finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;

  // Try to find cards assigned to this user; fall back to all cards
  const myCards = jobCards.filter(jc =>
    jc.assigned_to && (
      jc.assigned_to.toLowerCase().includes(user.name.toLowerCase()) ||
      jc.assigned_to.toLowerCase() === user.username?.toLowerCase()
    )
  );
  const pool = myCards.length > 0 ? myCards : jobCards;

  const inProgress = pool.filter(jc => jc.status === 'in_progress');
  const pending    = pool.filter(jc => jc.status === 'pending');
  const onHold     = pool.filter(jc => jc.status === 'on_hold');
  const qcPending  = pool.filter(jc => jc.status === 'qc_pending');
  const urgent     = pool.filter(jc => {
    const d = daysUntil(jc.dispatch_date);
    return d !== null && d <= 5 && !['dispatched'].includes(jc.status);
  });
  const overdue    = pool.filter(jc => {
    const d = daysUntil(jc.dispatch_date);
    return d !== null && d < 0 && !['dispatched'].includes(jc.status);
  });

  const activeCards = pool.filter(jc => !['dispatched'].includes(jc.status));

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">{greeting()}, {user.name.split('/')[0].trim()} 👋</h1>
        <p className="text-gray-500 text-sm mt-1">
          {myCards.length > 0
            ? `You have ${myCards.length} job card${myCards.length !== 1 ? 's' : ''} assigned to you`
            : 'Production floor overview'}
        </p>
      </div>

      {(hasJobCards || hasProduction) && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <StatCard label="In Progress"    value={inProgress.length} icon={Wrench}        color="blue"                                       to="/job-cards" />
          <StatCard label="Pending Start"  value={pending.length}    icon={Clock}         color="orange"                                     to="/job-cards" />
          <StatCard label="Urgent ≤5 days" value={urgent.length}     icon={AlertTriangle} color={urgent.length > 0 ? 'red' : 'green'}       to="/job-cards" />
          <StatCard label="Overdue"        value={overdue.length}    icon={XCircle}       color={overdue.length > 0 ? 'red' : 'green'}       to="/job-cards" />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">

          {/* Urgent first */}
          {(hasJobCards || hasProduction) && urgent.length > 0 && (
            <SectionCard title="Urgent — Due Within 5 Days" icon={AlertTriangle} iconColor="text-red-500">
              <div className="divide-y divide-gray-50">
                {urgent.map(jc => {
                  const days = daysUntil(jc.dispatch_date);
                  return (
                    <Link key={jc.id} to={`/job-cards/${jc.id}`}
                      className="flex items-center justify-between px-5 py-3.5 hover:bg-red-50/20 transition-colors">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm text-gray-900">{jc.job_card_no}</span>
                          <StatusBadge status={jc.status} />
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">{jc.customer_code}{jc.product_name && ` · ${jc.product_name}`}</div>
                      </div>
                      <div className={`text-sm font-semibold flex-shrink-0 ml-3 ${days < 0 ? 'text-red-600' : days <= 2 ? 'text-orange-600' : 'text-yellow-600'}`}>
                        {days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? 'Today!' : `${days}d left`}
                      </div>
                    </Link>
                  );
                })}
              </div>
            </SectionCard>
          )}

          {/* All active job cards */}
          {(hasJobCards || hasProduction) && (
            <SectionCard
              title={myCards.length > 0 ? 'My Job Cards' : 'Active Job Cards'}
              icon={Wrench} iconColor="text-blue-500"
              action={<Link to="/job-cards" className="text-xs text-brand-600 hover:underline font-medium">View all →</Link>}
            >
              <div className="divide-y divide-gray-50">
                {activeCards.length === 0 ? (
                  <EmptyRow message="No active job cards" />
                ) : activeCards.slice(0, 10).map(jc => (
                  <Link key={jc.id} to={`/job-cards/${jc.id}`}
                    className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 transition-colors">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-gray-900">{jc.job_card_no}</span>
                        <StatusBadge status={jc.status} />
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {jc.customer_code}{jc.product_name && ` · ${jc.product_name}`}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0 ml-3">
                      {jc.dispatch_date && <div className="text-xs text-gray-400">{fmtDate(jc.dispatch_date)}</div>}
                      {jc.quantity && <div className="text-xs text-gray-400">Qty: {jc.quantity}</div>}
                    </div>
                  </Link>
                ))}
                {activeCards.length > 10 && (
                  <Link to="/job-cards" className="block text-center text-xs text-brand-600 py-2">
                    +{activeCards.length - 10} more
                  </Link>
                )}
              </div>
            </SectionCard>
          )}
        </div>

        {/* Side */}
        <div className="space-y-4">
          {(hasJobCards || hasProduction) && (
            <div className="card p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">
                {myCards.length > 0 ? 'My Cards Status' : 'Floor Status'}
              </h3>
              <div className="space-y-2.5">
                {[
                  { label: 'Pending',     count: pending.length,   color: 'text-yellow-500' },
                  { label: 'In Progress', count: inProgress.length, color: 'text-blue-600' },
                  { label: 'On Hold',     count: onHold.length,    color: 'text-red-500' },
                  { label: 'QC Pending',  count: qcPending.length, color: 'text-purple-500' },
                ].map(({ label, count, color }) => (
                  <div key={label} className="flex items-center justify-between">
                    <span className="text-xs text-gray-500">{label}</span>
                    <span className={`text-sm font-bold ${color}`}>{count}</span>
                  </div>
                ))}
                <div className="border-t border-gray-100 pt-2 flex items-center justify-between">
                  <span className="text-xs text-gray-500 font-medium">Total active</span>
                  <span className="text-sm font-bold text-gray-800">{activeCards.length}</span>
                </div>
              </div>
            </div>
          )}

          <MentionsPanel />
          <ActivityFeed items={recent} />
        </div>
      </div>
    </div>
  );
}

// ── Main entry point ──────────────────────────────────────────────────────────

export default function Dashboard() {
  const { user } = useAuthStore();
  if (!user) return null;
  if (['owner', 'admin'].includes(user.role)) return <OwnerAdminDashboard />;
  if (user.role === 'accounts')               return <AccountsDashboard />;
  if (user.role === 'design')                 return <DesignDashboard />;
  if (user.role === 'production')             return <ProductionDashboard />;
  return null;
}
