import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../store/authStore';
import { ROLE_LABELS } from '../../lib/utils';
import api from '../../lib/api';
import {
  LayoutDashboard, ClipboardList, FileText, Package,
  Users, Box, Wrench, Truck, LogOut, FlaskConical,
  Settings, UserCog, ShoppingCart, Building2, BarChart2, Warehouse, PenLine, HelpCircle, Bell, BookOpen, Calendar
} from 'lucide-react';

const NAV = [
  { id: 'dashboard',     to: '/',              icon: LayoutDashboard, label: 'Dashboard',      roles: null, badge: 'unreadNotifs' },
  { id: 'orders',        to: '/orders',        icon: ClipboardList,   label: 'Orders',          roles: null },
  { id: 'drawings',      to: '/drawings',      icon: PenLine,         label: 'Drawings',        roles: ['owner','admin','design'], badge: 'drawingsPending' },
  { id: 'job-cards',     to: '/job-cards',     icon: FileText,        label: 'Job Cards',       roles: null },
  { id: 'production',    to: '/production',    icon: Wrench,          label: 'Production',      roles: null },
  { id: 'manufacturing-plan', to: '/manufacturing-plan', icon: Calendar, label: 'Mfg Plan', roles: ['owner','production'] },
  { id: 'qc',            to: '/qc',            icon: FlaskConical,    label: 'Quality Check',   roles: ['design','owner','admin'] },
  { id: 'dispatch',      to: '/dispatch',      icon: Truck,           label: 'Dispatch',        roles: null },
  { id: 'customer-queries', to: '/customer-queries', icon: HelpCircle,   label: 'Customer Queries', roles: null, badge: 'openQueries' },
  { id: 'finished-goods',to: '/finished-goods',icon: Warehouse,       label: 'Finished Goods',  roles: ['owner','admin','production'] },
  { id: 'inventory',     to: '/inventory',     icon: Package,         label: 'Inventory',       roles: ['owner','admin','accounts','design'] },
  { id: 'purchases',     to: '/purchases',     icon: ShoppingCart,    label: 'Purchases',       roles: ['owner','admin','accounts'] },
  { id: 'suppliers',     to: '/suppliers',     icon: Building2,       label: 'Suppliers',       roles: ['owner','admin','accounts'] },
  { id: 'customers',     to: '/customers',     icon: Users,           label: 'Customers',       roles: ['admin','owner'] },
  { id: 'products',      to: '/products',      icon: Box,             label: 'Products',        roles: null },
  { id: 'reports',       to: '/reports',       icon: BarChart2,       label: 'Reports',         roles: null },
  { id: 'policy',        to: '/policy',        icon: BookOpen,        label: 'Policy of PHE',   roles: null },
];

const ROLE_DOT = {
  owner:      'bg-amber-400',
  admin:      'bg-sky-400',
  accounts:   'bg-emerald-400',
  design:     'bg-violet-400',
  production: 'bg-rose-400',
};

export default function Sidebar() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const [drawingsPending, setDrawingsPending] = useState(0);
  const [openQueries, setOpenQueries] = useState(0);
  const [unreadNotifs, setUnreadNotifs] = useState(0);

  // Fetch pending drawings count for badge (design/admin/owner only)
  useEffect(() => {
    if (!['owner', 'admin', 'design'].includes(user?.role)) return;
    const fetch = () =>
      api.get('/orders/drawings/pending')
        .then(r => {
          // Badge shows: orders needing drawing + orders awaiting owner review + rejected
          const actionable = r.data.filter(o =>
            !o.drawing_status || o.drawing_status === 'pending_review' || o.drawing_status === 'rejected'
          ).length;
          setDrawingsPending(actionable);
        })
        .catch(() => {});
    fetch();
    const t = setInterval(fetch, 60000); // refresh every minute
    return () => clearInterval(t);
  }, [user?.role]);

  // Fetch open customer queries count for badge
  useEffect(() => {
    const fetchQ = () =>
      api.get('/customer-queries?status=open')
        .then(r => setOpenQueries(r.data.length))
        .catch(() => {});
    fetchQ();
    const t = setInterval(fetchQ, 60000);
    return () => clearInterval(t);
  }, []);

  // Fetch unread notifications count
  useEffect(() => {
    const fetchN = () =>
      api.get('/notifications/unread-count')
        .then(r => setUnreadNotifs(r.data.count || 0))
        .catch(() => {});
    fetchN();
    const t = setInterval(fetchN, 10000);
    return () => clearInterval(t);
  }, []);

  const badges = { drawingsPending, openQueries, unreadNotifs };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <aside className="w-64 min-h-screen flex flex-col" style={{ background: 'linear-gradient(180deg, #0f1e42 0%, #111827 100%)' }}>

      {/* Logo area — white bg to display logo properly */}
      <div className="mx-3 mt-4 mb-2 rounded-xl overflow-hidden bg-white shadow-lg">
        <img src="/logo.png" alt="Peena Heat Elements" className="w-full object-contain" style={{ maxHeight: '90px', padding: '8px 12px' }} />
      </div>

      {/* User info */}
      <div className="mx-3 mb-3 px-3 py-2.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${ROLE_DOT[user?.role] || 'bg-gray-400'}`} />
          <div className="min-w-0">
            <div className="text-white text-sm font-semibold truncate leading-tight">{user?.name}</div>
            <div className="text-slate-400 text-xs mt-0.5">{ROLE_LABELS[user?.role]}</div>
          </div>
        </div>
      </div>

      {/* Section label */}
      <div className="px-5 pb-1">
        <span className="text-xs font-semibold uppercase tracking-widest text-slate-500">Navigation</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 space-y-0.5 overflow-y-auto pb-2">
        {NAV.filter(item => {
          // Role-based filter (existing)
          if (item.roles && !item.roles.includes(user?.role)) return false;
          // Module-level permission filter (owner always gets everything)
          if (user?.role !== 'owner' && user?.permitted_modules) {
            try {
              const allowed = JSON.parse(user.permitted_modules);
              // 'drawings' is not a module-gated item — always allow for allowed roles
              if (item.id !== 'drawings' && !allowed.includes(item.id)) return false;
            } catch (e) {}
          }
          return true;
        }).map(({ to, icon: Icon, label, badge }) => {
          const badgeCount = badge ? (badges[badge] || 0) : 0;
          return (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-100 ${
                  isActive
                    ? 'sidebar-link-active text-white'
                    : 'text-slate-400 hover:text-white hover:bg-white/8'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon size={17} className={isActive ? 'text-phe-400' : ''} />
                  <span className="flex-1">{label}</span>
                  {badgeCount > 0 && (
                    <span className="ml-auto text-xs font-bold px-1.5 py-0.5 rounded-full bg-red-500 text-white min-w-[20px] text-center leading-none">
                      {badgeCount}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* Divider */}
      <div className="mx-3 border-t border-white/10 pt-2 pb-1">
        <span className="px-3 text-xs font-semibold uppercase tracking-widest text-slate-500">Account</span>
      </div>

      {/* Account links */}
      <div className="px-2 pb-2 space-y-0.5">
        <NavLink
          to="/account"
          className={({ isActive }) =>
            `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-100 ${
              isActive ? 'sidebar-link-active text-white' : 'text-slate-400 hover:text-white hover:bg-white/8'
            }`
          }
        >
          {({ isActive }) => (
            <>
              <Settings size={17} className={isActive ? 'text-phe-400' : ''} />
              Account Settings
            </>
          )}
        </NavLink>

        {['owner', 'admin'].includes(user?.role) && (
          <NavLink
            to="/users"
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-100 ${
                isActive ? 'sidebar-link-active text-white' : 'text-slate-400 hover:text-white hover:bg-white/8'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <UserCog size={17} className={isActive ? 'text-phe-400' : ''} />
                User Management
              </>
            )}
          </NavLink>
        )}
      </div>

      {/* Logout */}
      <div className="px-2 pb-4">
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2.5 w-full rounded-lg text-sm font-medium text-slate-400 hover:text-white transition-colors"
          style={{ background: 'rgba(225,29,72,0.0)' }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(225,29,72,0.15)'}
          onMouseLeave={e => e.currentTarget.style.background = 'rgba(225,29,72,0.0)'}
        >
          <LogOut size={17} />
          Sign Out
        </button>
      </div>
    </aside>
  );
}
