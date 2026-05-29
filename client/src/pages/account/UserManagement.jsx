import { useEffect, useState } from 'react';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import Modal from '../../components/ui/Modal';
import { ROLE_LABELS, ROLE_COLORS } from '../../lib/utils';
import {
  UserCog, Plus, RotateCcw, Pencil, Trash2, ShieldAlert,
  LayoutDashboard, ClipboardList, FileText, Package, Users,
  Box, Wrench, Truck, FlaskConical, ShoppingCart, Building2,
  CheckSquare, Square, Shield, BarChart2
} from 'lucide-react';

const ROLES = ['owner', 'admin', 'accounts', 'design', 'production'];

// ── Module definitions (must stay in sync with Sidebar NAV) ──────────────────
const ALL_MODULES = [
  { id: 'dashboard',  label: 'Dashboard',      icon: LayoutDashboard,  roles: null },
  { id: 'orders',     label: 'Orders',          icon: ClipboardList,    roles: null },
  { id: 'job-cards',  label: 'Job Cards',       icon: FileText,         roles: null },
  { id: 'production', label: 'Production',      icon: Wrench,           roles: null },
  { id: 'qc',         label: 'Quality Check',   icon: FlaskConical,     roles: ['design','owner','admin'] },
  { id: 'dispatch',   label: 'Dispatch',        icon: Truck,            roles: null },
  { id: 'inventory',  label: 'Inventory',       icon: Package,          roles: ['owner','admin','accounts','design'] },
  { id: 'purchases',  label: 'Purchases',       icon: ShoppingCart,     roles: ['owner','admin','accounts'] },
  { id: 'suppliers',  label: 'Suppliers',       icon: Building2,        roles: ['owner','admin','accounts'] },
  { id: 'customers',  label: 'Customers',       icon: Users,            roles: ['admin','owner'] },
  { id: 'products',   label: 'Products',        icon: Box,              roles: null },
  { id: 'reports',    label: 'Reports',         icon: BarChart2,        roles: null },
];

// Return modules the given role can access
function modulesForRole(role) {
  return ALL_MODULES.filter(m => !m.roles || m.roles.includes(role));
}

// Parse permitted_modules JSON safely
function parseModules(json) {
  if (!json) return null;
  try { return JSON.parse(json); }
  catch { return null; }
}

export default function UserManagement() {
  const { user: me } = useAuthStore();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [editUser, setEditUser] = useState(null);

  const load = () => {
    setLoading(true);
    api.get('/auth/users').then(r => setUsers(r.data)).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const handleReset = async (u) => {
    if (!window.confirm(`Reset password for "${u.name}" to PHE@2024? They will be asked to change it on next login.`)) return;
    try {
      await api.put(`/auth/users/${u.id}/reset-password`);
      alert('Password reset to PHE@2024');
    } catch (e) {
      alert(e.response?.data?.error || 'Failed');
    }
  };

  const handleDelete = async (u) => {
    if (!window.confirm(`Delete user "${u.name}" (@${u.username})? This cannot be undone.`)) return;
    try {
      await api.delete(`/auth/users/${u.id}`);
      load();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed');
    }
  };

  const roleGroups = ROLES.reduce((acc, r) => {
    acc[r] = users.filter(u => u.role === r);
    return acc;
  }, {});

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-600 flex items-center justify-center shadow-sm">
            <UserCog size={20} className="text-white" />
          </div>
          <div>
            <h1 className="page-title">User Management</h1>
            <p className="text-gray-500 text-sm">{users.length} users across {ROLES.filter(r => roleGroups[r].length > 0).length} departments</p>
          </div>
        </div>
        {me.role === 'owner' && (
          <button className="btn-primary" onClick={() => setShowNew(true)}>
            <Plus size={16} /> Add User
          </button>
        )}
      </div>

      {/* Info banner */}
      <div className="mb-6 flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
        <ShieldAlert size={18} className="text-amber-600 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-amber-800">
          <strong>Default password:</strong> When resetting a password, it's set to{' '}
          <code className="bg-amber-100 px-1.5 py-0.5 rounded font-mono text-xs">PHE@2024</code>.
          Users will be prompted to change it on their next login.
          {me.role === 'admin' && (
            <span className="block mt-1 text-amber-600">
              You can view users. Only the Owner can create, edit, or delete accounts.
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <div className="text-center text-gray-400 py-16">Loading users...</div>
      ) : (
        <div className="space-y-4">
          {ROLES.filter(r => roleGroups[r].length > 0).map(role => (
            <div key={role} className="card overflow-hidden">
              <div className="px-5 py-3 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
                <span className={`text-xs px-2.5 py-1 rounded-full font-semibold ${ROLE_COLORS[role]}`}>
                  {ROLE_LABELS[role]}
                </span>
                <span className="text-xs text-gray-400">
                  {roleGroups[role].length} user{roleGroups[role].length > 1 ? 's' : ''}
                </span>
              </div>
              <div className="divide-y divide-gray-50">
                {roleGroups[role].map(u => {
                  const mods = parseModules(u.permitted_modules);
                  const isRestricted = mods !== null;
                  return (
                    <div key={u.id} className="flex items-center gap-4 px-5 py-3.5 hover:bg-gray-50/50 transition-colors">
                      <div className="w-9 h-9 rounded-full bg-brand-600 flex items-center justify-center text-white font-semibold text-sm flex-shrink-0">
                        {u.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-gray-900 text-sm">
                            {u.name}
                            {u.id === me.id && <span className="ml-1.5 text-xs text-brand-600 font-normal">(you)</span>}
                          </span>
                          {/* Module access badge */}
                          {u.role !== 'owner' && (
                            <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${
                              isRestricted
                                ? 'bg-orange-100 text-orange-700'
                                : 'bg-green-100 text-green-700'
                            }`}>
                              <Shield size={10} />
                              {isRestricted ? `${mods.length} module${mods.length !== 1 ? 's' : ''}` : 'Full access'}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-gray-400 mt-0.5">
                          @{u.username}
                          {isRestricted && (
                            <span className="ml-2 text-orange-500">
                              {mods.map(id => ALL_MODULES.find(m => m.id === id)?.label).filter(Boolean).join(', ')}
                            </span>
                          )}
                        </div>
                      </div>
                      {me.role === 'owner' && u.id !== me.id && (
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <button
                            className="btn-secondary btn-sm flex items-center gap-1.5"
                            onClick={() => setEditUser(u)}
                            title="Edit user"
                          >
                            <Pencil size={12} /> Edit
                          </button>
                          <button
                            className="btn-secondary btn-sm flex items-center gap-1.5 text-amber-600 border-amber-200 hover:bg-amber-50"
                            onClick={() => handleReset(u)}
                            title="Reset password"
                          >
                            <RotateCcw size={12} /> Reset PW
                          </button>
                          <button
                            className="btn-secondary btn-sm flex items-center gap-1.5 text-red-600 border-red-200 hover:bg-red-50"
                            onClick={() => handleDelete(u)}
                            title="Delete user"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {showNew && (
        <UserModal
          onClose={() => setShowNew(false)}
          onSaved={() => { setShowNew(false); load(); }}
        />
      )}
      {editUser && (
        <UserModal
          user={editUser}
          onClose={() => setEditUser(null)}
          onSaved={() => { setEditUser(null); load(); }}
        />
      )}
    </div>
  );
}

// ── UserModal ─────────────────────────────────────────────────────────────────
function UserModal({ user, onClose, onSaved }) {
  const isEdit = !!user;

  const [f, setF] = useState({
    username: user?.username || '',
    name: user?.name || '',
    role: user?.role || 'production',
    password: '',
  });

  // Module permissions state
  const existingMods = parseModules(user?.permitted_modules);
  const [fullAccess, setFullAccess] = useState(existingMods === null);
  const [selectedMods, setSelectedMods] = useState(existingMods || []);

  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));

  // When role changes, remove selected modules that are no longer available
  const availableMods = modulesForRole(f.role);
  const availableModIds = availableMods.map(m => m.id);

  const handleRoleChange = (e) => {
    const newRole = e.target.value;
    setF(p => ({ ...p, role: newRole }));
    // Keep only selected modules that the new role can access
    setSelectedMods(prev => prev.filter(id => modulesForRole(newRole).map(m => m.id).includes(id)));
  };

  const toggleMod = (id) => {
    setSelectedMods(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const selectAll = () => setSelectedMods(availableModIds);
  const clearAll  = () => setSelectedMods([]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');

    // Build permitted_modules value: null = full access, JSON array = custom
    const permittedModules = (f.role === 'owner' || fullAccess)
      ? null
      : JSON.stringify(selectedMods);

    try {
      if (isEdit) {
        await api.put(`/auth/users/${user.id}`, {
          name: f.name,
          role: f.role,
          permitted_modules: permittedModules,
        });
      } else {
        if (!f.password) { setError('Password is required'); setSaving(false); return; }
        await api.post('/auth/users', { ...f, permitted_modules: permittedModules });
      }
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed');
      setSaving(false);
    }
  };

  const showModulePicker = f.role !== 'owner';

  return (
    <Modal open title={isEdit ? `Edit User — ${user.username}` : 'Add New User'} onClose={onClose} size="md">
      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Basic info */}
        <div className="space-y-4">
          {!isEdit && (
            <div>
              <label className="label">Username *</label>
              <input className="input" placeholder="e.g. production1" value={f.username} onChange={set('username')} required />
              <p className="text-xs text-gray-400 mt-1">Lowercase, no spaces. Used to sign in.</p>
            </div>
          )}
          <div>
            <label className="label">Display Name *</label>
            <input className="input" placeholder="e.g. Ravi Kumar" value={f.name} onChange={set('name')} required />
          </div>
          <div>
            <label className="label">Role *</label>
            <select className="input" value={f.role} onChange={handleRoleChange}>
              {ROLES.map(r => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
          </div>
          {!isEdit && (
            <div>
              <label className="label">Initial Password *</label>
              <input className="input" type="password" placeholder="Min. 6 characters" value={f.password} onChange={set('password')} required />
              <p className="text-xs text-gray-400 mt-1">User will be asked to change this on first login.</p>
            </div>
          )}
        </div>

        {/* Module Access Picker */}
        {showModulePicker && (
          <div className="border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center gap-2">
              <Shield size={14} className="text-brand-600" />
              <span className="text-sm font-semibold text-gray-800">Module Access</span>
            </div>

            {/* Full / Custom toggle */}
            <div className="px-4 pt-3 pb-2 flex gap-3">
              <button
                type="button"
                onClick={() => setFullAccess(true)}
                className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  fullAccess
                    ? 'bg-green-600 text-white border-green-600'
                    : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                }`}
              >
                ✓ Full Access
              </button>
              <button
                type="button"
                onClick={() => { setFullAccess(false); if (selectedMods.length === 0) setSelectedMods(availableModIds); }}
                className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  !fullAccess
                    ? 'bg-orange-500 text-white border-orange-500'
                    : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                }`}
              >
                Custom Access
              </button>
            </div>

            {fullAccess ? (
              <p className="px-4 pb-4 text-xs text-gray-500">
                User has access to all modules allowed by their role.
              </p>
            ) : (
              <div className="px-4 pb-4">
                {/* Select / clear all */}
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs text-gray-500">Choose which modules this user can see:</p>
                  <div className="flex gap-2">
                    <button type="button" onClick={selectAll} className="text-xs text-brand-600 hover:underline">All</button>
                    <span className="text-gray-300">·</span>
                    <button type="button" onClick={clearAll} className="text-xs text-gray-500 hover:underline">None</button>
                  </div>
                </div>

                {/* Module checkboxes */}
                <div className="grid grid-cols-2 gap-1.5">
                  {availableMods.map(mod => {
                    const Icon = mod.icon;
                    const checked = selectedMods.includes(mod.id);
                    return (
                      <button
                        key={mod.id}
                        type="button"
                        onClick={() => toggleMod(mod.id)}
                        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border text-sm font-medium transition-colors text-left ${
                          checked
                            ? 'bg-brand-50 border-brand-300 text-brand-800'
                            : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
                        }`}
                      >
                        {checked
                          ? <CheckSquare size={15} className="text-brand-600 flex-shrink-0" />
                          : <Square size={15} className="text-gray-300 flex-shrink-0" />
                        }
                        <Icon size={13} className={checked ? 'text-brand-600' : 'text-gray-400'} />
                        <span className="truncate">{mod.label}</span>
                      </button>
                    );
                  })}
                </div>

                {selectedMods.length === 0 && (
                  <p className="mt-2 text-xs text-red-500">⚠ No modules selected — user will only see the Dashboard.</p>
                )}
              </div>
            )}
          </div>
        )}

        {f.role === 'owner' && (
          <p className="text-xs text-amber-600 bg-amber-50 px-3 py-2 rounded-lg flex items-center gap-2">
            <Shield size={12} /> Owners always have full access to all modules.
          </p>
        )}

        {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

        <div className="flex gap-3 pt-1">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving}>
            {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create User'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
