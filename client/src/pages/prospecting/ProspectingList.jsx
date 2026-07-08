import { useEffect, useMemo, useState } from 'react';
import api from '../../lib/api';
import { Target, Download, RefreshCw, Filter, Mail, CheckCircle2, Star } from 'lucide-react';

// Default 2-email sequence (editable per session; mirrors the standalone tool).
const DEFAULT_EMAILS = {
  e1: {
    subject: 'Heating elements for your {{segment}} — Peena Heat Elements, Ahmedabad',
    body: `Dear [Procurement Team],

I'm Vama from Peena Heat Elements (PHE) — a manufacturer of custom tubular heating elements based in Ahmedabad.

We've been following the work {{company}} does in {{segment}}, and there's a genuine fit with what we make. Our elements — SS304/316 and Incoloy, CNC-bent, furnace-annealed — are built for exactly the kind of equipment you manufacture.

Every element leaves our floor tested and backed by a 6-month guarantee. We've been supplying OEMs across India and internationally for years, and our clients keep coming back because we get the spec right and we're easy to work with.

I'd love to send you a sample batch — no obligation — so your team can test our quality directly.

Would a quick call this week work?

Warm regards,
Vama
Peena Heat Elements LLP, Ahmedabad
vama@peenaheatelements.com | phe.co.in`,
  },
  e2: {
    subject: 'Following up — PHE heating elements for {{company}}',
    body: `Dear [Procurement Team],

A gentle follow-up on my earlier note about our heating elements.

If you'd like to share your current element spec — material, watt density, dimensions — we'll turn around a quote and a sample within the week.

A few things our OEM partners tell us make the difference:

→ Custom CNC bending to your exact dimensions
→ SS304, SS316, Incoloy material options
→ Consistent batch quality at volume
→ 5–7 day dispatch from Ahmedabad

No pressure — I've attached our catalogue for reference.

Warm regards,
Vama
Peena Heat Elements LLP
vama@peenaheatelements.com | phe.co.in`,
  },
};

const PRIORITY_BADGE = {
  H: 'bg-amber-100 text-amber-800',
  M: 'bg-indigo-100 text-indigo-800',
  L: 'bg-gray-100 text-gray-600',
};
const PRIORITY_LABEL = { H: 'High', M: 'Med', L: 'Low' };

export default function ProspectingList() {
  const [segments, setSegments] = useState([]);
  const [segment, setSegment] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [prospects, setProspects] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [emails, setEmails] = useState(DEFAULT_EMAILS);
  const [activeEmail, setActiveEmail] = useState('e1');
  const [busy, setBusy] = useState(false);

  const loadSegments = () =>
    api.get('/prospects/segments').then(r => {
      setSegments(r.data);
      if (r.data.length && !segment) setSegment(r.data[0].segment);
    }).catch(() => {});

  const loadProspects = () => {
    setLoading(true);
    const params = {};
    if (segment) params.segment = segment;
    if (statusFilter) params.status = statusFilter;
    api.get('/prospects', { params })
      .then(r => { setProspects(r.data); setSelected(new Set(r.data.map(p => p.id))); })
      .catch(() => setProspects([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadSegments(); }, []);
  useEffect(() => { if (segment) loadProspects(); /* eslint-disable-line */ }, [segment, statusFilter]);

  const stats = useMemo(() => ({
    total: prospects.length,
    high: prospects.filter(p => p.priority === 'H').length,
    selected: selected.size,
    cities: new Set(prospects.map(p => p.city).filter(Boolean)).size,
  }), [prospects, selected]);

  const toggle = id => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };
  const selectAll = () => setSelected(new Set(prospects.map(p => p.id)));
  const selectNone = () => setSelected(new Set());
  const selectHigh = () => setSelected(new Set(prospects.filter(p => p.priority === 'H').map(p => p.id)));

  const exportCSV = async () => {
    if (!selected.size) return;
    setBusy(true);
    try {
      const ids = [...selected].join(',');
      const res = await api.get('/prospects/export.csv', { params: { segment, ids }, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `PHE-${(segment || 'prospects').replace(/[^a-z0-9]+/gi, '-')}-contacts.csv`;
      a.click();
      URL.revokeObjectURL(url);
      // Mark exported so the team can see what's already gone out
      await api.post('/prospects/bulk-status', { ids: [...selected], status: 'exported' });
      loadProspects();
    } finally { setBusy(false); }
  };

  const markStatus = async status => {
    if (!selected.size) return;
    setBusy(true);
    try {
      await api.post('/prospects/bulk-status', { ids: [...selected], status });
      loadProspects();
    } finally { setBusy(false); }
  };

  const segLabel = segments.find(s => s.segment === segment)?.segment || segment;
  const renderEmail = e => ({
    subject: emails[e].subject.replace(/{{segment}}/g, segLabel || 'your segment'),
    body: emails[e].body.replace(/{{company}}/g, 'your company').replace(/{{segment}}/g, (segLabel || 'your segment').toLowerCase()),
  });

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Target size={22} className="text-brand-700" /> Prospecting
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            B2B lead lists researched in Claude Code — review, then export a Zoho-ready CSV.
          </p>
        </div>
        <button className="btn-secondary flex items-center gap-1.5 text-sm" onClick={loadProspects}>
          <RefreshCw size={15} /> Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="flex items-center gap-1.5">
          <Filter size={15} className="text-gray-400" />
          <select className="input" value={segment} onChange={e => setSegment(e.target.value)}>
            {segments.length === 0 && <option value="">No segments yet</option>}
            {segments.map(s => (
              <option key={s.segment} value={s.segment}>{s.segment} ({s.total})</option>
            ))}
          </select>
        </div>
        <select className="input" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="new">New</option>
          <option value="exported">Exported</option>
          <option value="contacted">Contacted</option>
        </select>
      </div>

      {segments.length === 0 && !loading ? (
        <div className="card p-10 text-center text-gray-500">
          No prospects yet. Research a segment in Claude Code, then seed it with{' '}
          <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">node server/scripts/seed_prospects.js &lt;file.json&gt;</code>.
        </div>
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            <Stat label="Prospects" value={stats.total} />
            <Stat label="High priority" value={stats.high} />
            <Stat label="Selected" value={stats.selected} />
            <Stat label="Cities" value={stats.cities} />
          </div>

          {/* Table */}
          <div className="card overflow-hidden mb-6">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <h3 className="text-sm font-semibold">{loading ? 'Loading…' : `${prospects.length} prospects`}</h3>
              <div className="flex gap-2">
                <button className="btn-secondary text-xs" onClick={selectHigh}>High only</button>
                <button className="btn-secondary text-xs" onClick={selectAll}>Select all</button>
                <button className="btn-secondary text-xs" onClick={selectNone}>Clear</button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b bg-gray-50">
                    <th className="px-3 py-2 w-8"></th>
                    <th className="px-3 py-2">Company</th>
                    <th className="px-3 py-2">City</th>
                    <th className="px-3 py-2">Segment</th>
                    <th className="px-3 py-2">Email</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Priority</th>
                  </tr>
                </thead>
                <tbody>
                  {prospects.map(p => (
                    <tr key={p.id} className="border-b last:border-0 hover:bg-gray-50">
                      <td className="px-3 py-2">
                        <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                      </td>
                      <td className="px-3 py-2 font-medium text-gray-900">{p.company}</td>
                      <td className="px-3 py-2 text-gray-600">{p.city}</td>
                      <td className="px-3 py-2 text-gray-500">{p.segment}</td>
                      <td className="px-3 py-2 text-gray-500 font-mono text-xs">{p.email}</td>
                      <td className="px-3 py-2">
                        <span className="text-xs text-gray-500 capitalize">{p.status}</span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${PRIORITY_BADGE[p.priority] || PRIORITY_BADGE.L}`}>
                          {PRIORITY_LABEL[p.priority] || p.priority}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {!loading && prospects.length === 0 && (
                    <tr><td colSpan={7} className="px-3 py-10 text-center text-gray-400">No prospects for this filter</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Email preview */}
          <div className="card p-4 mb-6">
            <div className="flex items-center gap-2 mb-3">
              <Mail size={16} className="text-brand-700" />
              <h3 className="text-sm font-semibold">Email sequence — intro + follow-up (5 days)</h3>
            </div>
            <div className="flex gap-2 mb-3">
              {['e1', 'e2'].map(e => (
                <button key={e}
                  className={`text-xs px-3 py-1.5 rounded-md border ${activeEmail === e ? 'bg-brand-700 text-white border-brand-700' : 'bg-white text-gray-500'}`}
                  onClick={() => setActiveEmail(e)}>
                  {e === 'e1' ? 'Email 1 — Intro' : 'Email 2 — Follow-up'}
                </button>
              ))}
            </div>
            <input className="input w-full mb-2 font-medium"
              value={emails[activeEmail].subject}
              onChange={e => setEmails({ ...emails, [activeEmail]: { ...emails[activeEmail], subject: e.target.value } })} />
            <textarea className="input w-full font-sans leading-relaxed" rows={12}
              value={emails[activeEmail].body}
              onChange={e => setEmails({ ...emails, [activeEmail]: { ...emails[activeEmail], body: e.target.value } })} />
            <p className="text-xs text-gray-400 mt-2">
              Preview with tags filled: <span className="italic">{renderEmail(activeEmail).subject}</span>
            </p>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn-primary flex items-center gap-1.5" disabled={!selected.size || busy} onClick={exportCSV}>
              <Download size={16} /> Export CSV ({selected.size})
            </button>
            <button className="btn-secondary flex items-center gap-1.5" disabled={!selected.size || busy} onClick={() => markStatus('contacted')}>
              <CheckCircle2 size={16} /> Mark contacted
            </button>
            <button className="btn-secondary flex items-center gap-1.5" disabled={!selected.size || busy} onClick={() => markStatus('new')}>
              <Star size={16} /> Reset to new
            </button>
            <span className="text-xs text-gray-400">Export downloads a Zoho-ready CSV and marks the selected prospects “exported”.</span>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-2xl font-bold text-brand-700">{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}
