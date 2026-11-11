// ── Logged-in devices (owner, 11 Nov 2026) ──────────────────────────────────
// "tell me how many devices and which are currently logged into the app", and
// "whenever there is new log in of any user in a different device it should ask
// me for permission to get in". Three lists, refreshed every 15 seconds:
//   • waiting for your approval — a new device held on the login page;
//   • logged in now — every open login, with Log out;
//   • allowed devices — what can sign in without asking; Remove forgets one.
// The owner's own account is never held, but its devices are listed here too.
import { useCallback, useEffect, useState } from 'react';
import api from '../../lib/api';
import { ROLE_LABELS } from '../../lib/utils';
import { Smartphone, Tablet, Monitor, Check, X, LogOut, Trash2, ShieldCheck, MonitorSmartphone } from 'lucide-react';

const iconFor = (label) => (/phone|iPhone/i.test(label || '') ? Smartphone : /tablet|iPad/i.test(label || '') ? Tablet : Monitor);
const at = (t) => (t ? new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
function ago(t) {
  if (!t) return '—';
  const m = Math.round((Date.now() - new Date(t).getTime()) / 60000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 24 * 60) return `${Math.round(m / 60)} h ago`;
  return at(t);
}

function Row({ label, children, actions, tone = '' }) {
  const Icon = iconFor(label);
  return (
    <div className={`flex items-center gap-3 px-5 py-3 ${tone}`}>
      <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
        <Icon size={17} className="text-gray-500" />
      </div>
      <div className="flex-1 min-w-0">{children}</div>
      {actions && <div className="flex items-center gap-1.5 flex-shrink-0">{actions}</div>}
    </div>
  );
}

export default function DevicesPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => api.get('/auth/devices')
    .then(r => { setData(r.data); setError(''); })
    .catch(e => setError(e.response?.data?.error || 'Could not load the devices')), []);

  useEffect(() => {
    load().then(() => {
      if (window.location.hash === '#devices') document.getElementById('devices')?.scrollIntoView({ block: 'start' });
    });
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (key, call, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(key);
    try { await call(); await load(); }
    catch (e) { alert(e.response?.data?.error || 'Failed'); }
    finally { setBusy(null); }
  };

  const pending = data?.pending || [];
  const open = data?.sessions || [];
  const allowed = data?.devices || [];
  const who = (r) => (
    <span className="font-semibold text-gray-900 text-sm">
      {r.user_name}
      <span className="ml-1.5 text-xs font-normal text-gray-400">{ROLE_LABELS[r.role] || r.role}</span>
    </span>
  );

  return (
    <div id="devices" className="card overflow-hidden mb-6 scroll-mt-4">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-brand-600 flex items-center justify-center">
          <MonitorSmartphone size={18} className="text-white" />
        </div>
        <div className="flex-1">
          <h2 className="section-title">Logged-in devices</h2>
          <p className="text-xs text-gray-500">
            {data ? `${open.length} device${open.length === 1 ? '' : 's'} logged in now` : 'Loading…'}
            {' · '}a new device for any account waits for your approval before it can sign in
          </p>
        </div>
      </div>

      {error && <div className="px-5 py-3 text-sm text-red-700 bg-red-50">{error}</div>}

      {pending.length > 0 && (
        <div className="border-b border-amber-200">
          <div className="px-5 py-2 bg-amber-50 text-xs font-semibold text-amber-800 flex items-center gap-1.5">
            <ShieldCheck size={13} /> Waiting for your approval ({pending.length})
          </div>
          <div className="divide-y divide-amber-100">
            {pending.map(p => (
              <Row key={`p${p.id}`} label={p.label} tone="bg-amber-50/40"
                actions={<>
                  <button className="btn-primary btn-sm flex items-center gap-1" disabled={busy === `a${p.id}`}
                    onClick={() => act(`a${p.id}`, () => api.put(`/auth/devices/${p.id}/allow`))}>
                    <Check size={13} /> Allow
                  </button>
                  <button className="btn-secondary btn-sm flex items-center gap-1 text-red-600 border-red-200 hover:bg-red-50" disabled={busy === `r${p.id}`}
                    onClick={() => act(`r${p.id}`, () => api.put(`/auth/devices/${p.id}/refuse`))}>
                    <X size={13} /> Don't allow
                  </button>
                </>}>
                {who(p)}
                <div className="text-xs text-gray-500 mt-0.5">{p.label}{p.ip ? ` · ${p.ip}` : ''} · asked {ago(p.requested_at)}</div>
              </Row>
            ))}
          </div>
        </div>
      )}

      <div className="px-5 py-2 bg-gray-50 text-xs font-semibold text-gray-600 border-b border-gray-100">Logged in now ({open.length})</div>
      {data && !open.length && <div className="px-5 py-4 text-sm text-gray-400">No device is logged in.</div>}
      <div className="divide-y divide-gray-50">
        {open.map(s => (
          <Row key={`s${s.id}`} label={s.label}
            actions={s.current
              ? <span className="text-xs px-2 py-1 rounded-full bg-brand-50 text-brand-700 font-medium">This device</span>
              : (
                <button className="btn-secondary btn-sm flex items-center gap-1" disabled={busy === `s${s.id}`}
                  onClick={() => act(`s${s.id}`, () => api.put(`/auth/sessions/${s.id}/end`),
                    `Log out ${s.user_name} on ${s.label}? They can sign in again on this device without asking you.`)}>
                  <LogOut size={13} /> Log out
                </button>
              )}>
            {who(s)}
            <div className="text-xs text-gray-500 mt-0.5">
              {s.label}{s.ip ? ` · ${s.ip}` : ''} · signed in {at(s.created_at)} · last used {ago(s.last_seen_at)}
            </div>
          </Row>
        ))}
      </div>

      <div className="px-5 py-2 bg-gray-50 text-xs font-semibold text-gray-600 border-y border-gray-100">
        Allowed devices ({allowed.length}) <span className="font-normal text-gray-400">— these sign in without asking</span>
      </div>
      {data && !allowed.length && <div className="px-5 py-4 text-sm text-gray-400">No device allowed yet.</div>}
      <div className="divide-y divide-gray-50">
        {allowed.map(d => (
          <Row key={`d${d.id}`} label={d.label}
            actions={
              <button className="btn-secondary btn-sm flex items-center gap-1 text-red-600 border-red-200 hover:bg-red-50" disabled={busy === `d${d.id}`}
                onClick={() => act(`d${d.id}`, () => api.put(`/auth/devices/${d.id}/remove`),
                  d.role === 'owner'
                    ? `Remove ${d.label} from your owner account? It is logged out now. (Owner devices are never held, so it can sign in again.)`
                    : `Remove ${d.label} from ${d.user_name}? It is logged out now, and it will need your approval again to sign in.`)}>
                <Trash2 size={13} /> Remove
              </button>
            }>
            {who(d)}
            <div className="text-xs text-gray-500 mt-0.5">
              {d.label}{d.ip ? ` · ${d.ip}` : ''} · last sign-in {at(d.last_login_at)}
              {d.allowed_by ? ` · allowed by ${d.allowed_by} ${at(d.decided_at)}` : d.role === 'owner' ? ' · owner account (never held)' : ''}
            </div>
          </Row>
        ))}
      </div>
    </div>
  );
}
