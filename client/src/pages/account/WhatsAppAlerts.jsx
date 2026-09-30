import { useEffect, useState } from 'react';
import api from '../../lib/api';
import { fmtDateTime } from '../../lib/utils';
import { MessageCircle, CheckCircle, AlertTriangle, Send } from 'lucide-react';

// Owner's WhatsApp alerts (30 Sep 2026): a WhatsApp copy of the dashboard
// notifications the owner picks — approvals and @mentions by default.
const GROUPS = [
  { key: 'approval', title: 'Approvals' },
  { key: 'mention', title: '@mentions' },
  { key: 'other', title: 'Other' },
];
// 'accepted' = WhatsApp took it; delivered/read come back from WhatsApp later.
const STATUS = {
  read: 'text-green-800 bg-green-100', delivered: 'text-green-700 bg-green-50', sent: 'text-green-700 bg-green-50',
  accepted: 'text-sky-700 bg-sky-50', pending: 'text-amber-700 bg-amber-50', sending: 'text-amber-700 bg-amber-50',
  failed: 'text-red-700 bg-red-50', expired: 'text-gray-500 bg-gray-100',
};
const STATUS_LABEL = { accepted: 'accepted', pending: 'waiting', sending: 'sending' };

export default function WhatsAppAlerts() {
  const [s, setS] = useState(null);
  const [number, setNumber] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [types, setTypes] = useState([]);
  const [log, setLog] = useState([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [r, l] = await Promise.all([api.get('/whatsapp/settings'), api.get('/whatsapp/log')]);
      setS(r.data); setNumber(r.data.number ? `+${r.data.number}` : ''); setEnabled(r.data.enabled); setTypes(r.data.types || []);
      setLog(l.data || []);
    } catch (e) { setErr(e.response?.data?.error || 'Could not load WhatsApp settings'); }
  };
  useEffect(() => { load(); }, []);

  const toggleType = (t) => setTypes(p => p.includes(t) ? p.filter(x => x !== t) : [...p, t]);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setMsg(''); setErr('');
    try {
      const r = await api.put('/whatsapp/settings', { number, enabled, types });
      setMsg(r.data.message); await load();
    } catch (e2) { setErr(e2.response?.data?.error || 'Could not save'); }
    finally { setBusy(false); }
  };

  const test = async () => {
    setBusy(true); setMsg(''); setErr('');
    try { const r = await api.post('/whatsapp/test'); setMsg(r.data.message); }
    catch (e2) { setErr(e2.response?.data?.error || 'The test message was not sent'); }
    finally { setBusy(false); load(); }
  };

  if (!s) {
    return err ? <div className="card p-5 mt-5 text-sm text-red-700">{err}</div> : null;
  }

  return (
    <div className="card mt-5">
      <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-green-50 flex items-center justify-center">
          <MessageCircle size={16} className="text-green-600" />
        </div>
        <h2 className="font-semibold text-gray-900">WhatsApp alerts</h2>
        <span className={`ml-auto text-xs px-2 py-0.5 rounded-full font-medium ${s.connected ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
          {s.connected ? 'Connected' : 'Not connected yet'}
        </span>
      </div>
      <div className="px-6 py-5 space-y-5">
        {!s.connected && (
          <div className="flex items-start gap-2 text-sm rounded-xl px-3 py-2.5 bg-amber-50 border border-amber-200 text-amber-800">
            <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
            <span>The WhatsApp sender isn't set up on the server yet. Your settings are saved and alerts start once it is.</span>
          </div>
        )}
        {s.connected && !s.webhook_ready && (
          <div className="text-xs text-gray-500">Delivery confirmations are off until the webhook is set up, so alerts show as "accepted" rather than delivered or read.</div>
        )}
        {s.connected && s.mode === 'text' && (
          <div className="flex items-start gap-2 text-sm rounded-xl px-3 py-2.5 bg-amber-50 border border-amber-200 text-amber-800">
            <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
            <span>No approved message template yet, so WhatsApp only delivers alerts within 24 hours of you sending any message to the business number.</span>
          </div>
        )}

        <form onSubmit={save} className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
            <div>
              <label className="label">Your WhatsApp number</label>
              <input className="input" value={number} onChange={e => setNumber(e.target.value)} placeholder="+91 98765 43210" inputMode="tel" />
            </div>
            <label className="flex items-center gap-2.5 text-sm text-gray-800 cursor-pointer pb-2">
              <input type="checkbox" className="h-4 w-4 accent-green-600" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
              Send my alerts to WhatsApp
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {GROUPS.map(g => (
              <div key={g.key}>
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">{g.title}</div>
                <div className="space-y-2">
                  {s.kinds.filter(k => k.group === g.key).map(k => (
                    <label key={k.type} className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
                      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-green-600 flex-shrink-0"
                        checked={types.includes(k.type)} onChange={() => toggleType(k.type)} />
                      <span>{k.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {err && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{err}</div>}
          {msg && (
            <div className="flex items-center gap-2 text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm">
              <CheckCircle size={14} /> {msg}
            </div>
          )}
          <div className="flex justify-end gap-3">
            <button type="button" className="btn-secondary flex items-center gap-1.5" onClick={test}
              disabled={busy || !s.number || !s.connected} title={!s.number ? 'Save your number first' : ''}>
              <Send size={14} /> Send test message
            </button>
            <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </form>

        {log.length > 0 && (
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Recent WhatsApp alerts</div>
            <div className="border border-gray-100 rounded-xl divide-y divide-gray-100">
              {log.map(r => (
                <div key={r.id} className="px-3 py-2 text-sm flex items-start gap-3">
                  <span className={`text-[11px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${STATUS[r.status] || 'bg-gray-100 text-gray-600'}`}>{STATUS_LABEL[r.status] || r.status}</span>
                  <div className="min-w-0">
                    <div className="text-gray-800 truncate">{r.title}</div>
                    {r.last_error && ['failed', 'pending', 'expired'].includes(r.status) && <div className="text-xs text-red-600">{r.last_error}</div>}
                  </div>
                  <span className="ml-auto text-xs text-gray-400 flex-shrink-0">{fmtDateTime(r.sent_at || r.created_at)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
