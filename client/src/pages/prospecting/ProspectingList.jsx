import { useEffect, useMemo, useState } from 'react';
import api from '../../lib/api';
import Modal from '../../components/ui/Modal';
import { Target, Download, RefreshCw, Filter, Mail, MessageSquare, CheckCircle2, Star, Upload } from 'lucide-react';

// Parse pasted CSV / Excel-copied (TSV) rows into prospect objects. Requires a
// header row; a "Company" column is mandatory, the rest are optional.
function parseTable(text) {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { error: 'Add a header row plus at least one data row.' };
  const delim = lines[0].includes('\t') ? '\t' : ',';
  const parseLine = line => {
    if (delim === '\t') return line.split('\t').map(c => c.trim());
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(c => c.trim());
  };
  const header = parseLine(lines[0]).map(h => h.toLowerCase());
  const idx = names => header.findIndex(h => names.includes(h));
  const map = {
    company: idx(['company', 'company name', 'co', 'name', 'organisation', 'organization']),
    city: idx(['city', 'location']),
    state: idx(['state', 'region']),
    email: idx(['email', 'contact email', 'email address', 'e-mail']),
    phone: idx(['phone', 'mobile', 'mobile number', 'contact number', 'tel', 'telephone']),
    role: idx(['role', 'contact', 'contact role', 'title', 'designation', 'contact person']),
    fit: idx(['fit', 'product fit', 'product_fit', 'notes', 'remarks']),
    priority: idx(['priority', 'prio']),
  };
  if (map.company < 0) return { error: 'Could not find a "Company" column in the header row.' };
  const normPrio = v => { v = (v || '').trim().toUpperCase(); if (v.startsWith('H')) return 'H'; if (v.startsWith('L')) return 'L'; return 'M'; };
  const prospects = lines.slice(1).map(parseLine).map(cells => {
    const g = i => (i >= 0 ? (cells[i] || '').trim() : '');
    return {
      company: g(map.company), city: g(map.city), state: g(map.state),
      email: g(map.email), phone: g(map.phone), role: g(map.role),
      fit: g(map.fit), priority: normPrio(g(map.priority)),
    };
  }).filter(p => p.company);
  return { prospects };
}

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

// Contact-verification badge. `verified` = real email confirmed from the
// company site; `phone-only` = phone found but email hidden; else unverified.
const SOURCE_BADGE = {
  'verified':   { cls: 'bg-emerald-100 text-emerald-800', label: '✓ Verified' },
  'phone-only': { cls: 'bg-amber-100 text-amber-800',     label: '☎ Phone only' },
};
const sourceBadge = s => SOURCE_BADGE[s] || { cls: 'bg-gray-100 text-gray-500', label: 'Unverified' };

export default function ProspectingList() {
  const [segments, setSegments] = useState([]);
  const [segment, setSegment] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');       // '', verified, phone-only, unverified
  const [regionFilter, setRegionFilter] = useState('');       // state / province within the country
  const [appFilter, setAppFilter] = useState('');             // application category
  const [prospects, setProspects] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [emails, setEmails] = useState(DEFAULT_EMAILS);
  const [activeEmail, setActiveEmail] = useState('e1');
  const [busy, setBusy] = useState(false);
  // Manual import
  const [showImport, setShowImport] = useState(false);
  const [impSegment, setImpSegment] = useState('');
  const [impText, setImpText] = useState('');
  const [impBusy, setImpBusy] = useState(false);
  const [impResult, setImpResult] = useState(null);

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

  const hasEmail = p => !!(p.email && p.email.trim());
  const hasPhone = p => !!(p.phone && p.phone.trim());
  const rowSource = p => (p.source === 'verified' || p.source === 'phone-only') ? p.source : 'unverified';

  // Filter options are derived from the loaded segment, so they always match the data.
  const regions = useMemo(
    () => [...new Set(prospects.map(p => p.state).filter(Boolean))].sort(),
    [prospects]);
  const applications = useMemo(
    () => [...new Set(prospects.map(p => p.application).filter(Boolean))].sort(),
    [prospects]);

  // Source / region / application filters are applied client-side so they're instant.
  const visible = useMemo(() => prospects.filter(p =>
    (!sourceFilter || rowSource(p) === sourceFilter) &&
    (!regionFilter || p.state === regionFilter) &&
    (!appFilter || p.application === appFilter)
  ), [prospects, sourceFilter, regionFilter, appFilter]);

  // The email copy follows the application in view: an explicit filter wins, otherwise
  // if everything visible shares one application we tailor to it, else stay generic.
  const activeApplication = useMemo(() => {
    if (appFilter) return appFilter;
    const uniq = [...new Set(visible.map(p => p.application).filter(Boolean))];
    return uniq.length === 1 ? uniq[0] : '';
  }, [appFilter, visible]);

  const selectedVisible = useMemo(() => visible.filter(p => selected.has(p.id)), [visible, selected]);
  const emailableSel = useMemo(() => selectedVisible.filter(hasEmail).map(p => p.id), [selectedVisible]);
  const smsableSel  = useMemo(() => selectedVisible.filter(hasPhone).map(p => p.id), [selectedVisible]);

  const stats = useMemo(() => ({
    total: prospects.length,
    emailable: prospects.filter(hasEmail).length,
    smsable: prospects.filter(hasPhone).length,
    selected: selected.size,
  }), [prospects, selected]);

  const toggle = id => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };
  const selectAll = () => setSelected(new Set(visible.map(p => p.id)));
  const selectNone = () => setSelected(new Set());

  const download = async (type, ids) => {
    if (!ids.length) return;
    setBusy(true);
    try {
      const res = await api.get('/prospects/export.csv', { params: { segment, type, ids: ids.join(',') }, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `PHE-${(segment || 'prospects').replace(/[^a-z0-9]+/gi, '-')}-${type}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      await api.post('/prospects/bulk-status', { ids, status: 'exported' });
      loadProspects();
    } finally { setBusy(false); }
  };

  const markStatus = async status => {
    const ids = [...selected];
    if (!ids.length) return;
    setBusy(true);
    try {
      await api.post('/prospects/bulk-status', { ids, status });
      loadProspects();
    } finally { setBusy(false); }
  };

  const parsed = useMemo(() => (impText.trim() ? parseTable(impText) : null), [impText]);
  const onImpFile = e => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setImpText(reader.result);
    reader.readAsText(f);
  };
  const doImport = async () => {
    const seg = impSegment.trim();
    if (!seg || !parsed || parsed.error || !parsed.prospects?.length) return;
    setImpBusy(true); setImpResult(null);
    try {
      const rows = parsed.prospects.map(p => ({ ...p, source: 'manual' }));
      const r = await api.post('/prospects/bulk', { prospects: rows, segment: seg });
      setImpResult(r.data);
      loadSegments();
      if (seg === segment) loadProspects();
    } catch (e) {
      setImpResult({ error: e.response?.data?.error || 'Import failed' });
    } finally { setImpBusy(false); }
  };

  const segLabel = segments.find(s => s.segment === segment)?.segment || segment;
  const renderSubject = e => emails[e].subject.replace(/{{segment}}/g, segLabel || 'your segment');

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Target size={22} className="text-brand-700" /> Prospecting
          </h1>
          <p className="text-xs text-gray-500 mt-1">
            B2B lead lists researched &amp; contact-verified in Claude Code — review, then export Zoho-ready CSVs.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-secondary flex items-center gap-1.5 text-sm" onClick={() => { setImpResult(null); setShowImport(true); }}>
            <Upload size={15} /> Import
          </button>
          <button className="btn-secondary flex items-center gap-1.5 text-sm" onClick={loadProspects}>
            <RefreshCw size={15} /> Refresh
          </button>
        </div>
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
        <select className="input" value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}>
          <option value="">All contacts</option>
          <option value="verified">✓ Verified email only</option>
          <option value="phone-only">☎ Phone only</option>
          <option value="unverified">Unverified</option>
        </select>
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
            <Stat label="Emailable" value={stats.emailable} accent="text-emerald-600" />
            <Stat label="SMS-able" value={stats.smsable} accent="text-amber-600" />
            <Stat label="Selected" value={stats.selected} />
          </div>

          {/* Table */}
          <div className="card overflow-hidden mb-6">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <h3 className="text-sm font-semibold">{loading ? 'Loading…' : `${visible.length} shown`}</h3>
              <div className="flex gap-2">
                <button className="btn-secondary text-xs" onClick={selectAll}>Select shown</button>
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
                    <th className="px-3 py-2">Email</th>
                    <th className="px-3 py-2">Phone</th>
                    <th className="px-3 py-2">Contact</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Priority</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(p => {
                    const sb = sourceBadge(rowSource(p));
                    return (
                      <tr key={p.id} className="border-b last:border-0 hover:bg-gray-50">
                        <td className="px-3 py-2">
                          <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                        </td>
                        <td className="px-3 py-2 font-medium text-gray-900">{p.company}</td>
                        <td className="px-3 py-2 text-gray-600">{p.city}</td>
                        <td className="px-3 py-2 text-gray-500 font-mono text-xs">{p.email || <span className="text-gray-300">—</span>}</td>
                        <td className="px-3 py-2 text-gray-500 font-mono text-xs">{p.phone || <span className="text-gray-300">—</span>}</td>
                        <td className="px-3 py-2">
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${sb.cls}`}>{sb.label}</span>
                        </td>
                        <td className="px-3 py-2"><span className="text-xs text-gray-500 capitalize">{p.status}</span></td>
                        <td className="px-3 py-2">
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${PRIORITY_BADGE[p.priority] || PRIORITY_BADGE.L}`}>
                            {PRIORITY_LABEL[p.priority] || p.priority}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {!loading && visible.length === 0 && (
                    <tr><td colSpan={8} className="px-3 py-10 text-center text-gray-400">No prospects for this filter</td></tr>
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
              Subject preview: <span className="italic">{renderSubject(activeEmail)}</span>
            </p>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn-primary flex items-center gap-1.5" disabled={!emailableSel.length || busy}
              onClick={() => download('email', emailableSel)}>
              <Mail size={16} /> Export Email list ({emailableSel.length})
            </button>
            <button className="btn-secondary flex items-center gap-1.5" disabled={!smsableSel.length || busy}
              onClick={() => download('sms', smsableSel)}>
              <MessageSquare size={16} /> Export SMS list ({smsableSel.length})
            </button>
            <button className="btn-secondary flex items-center gap-1.5" disabled={!selected.size || busy} onClick={() => markStatus('contacted')}>
              <CheckCircle2 size={16} /> Mark contacted
            </button>
            <button className="btn-secondary flex items-center gap-1.5" disabled={!selected.size || busy} onClick={() => markStatus('new')}>
              <Star size={16} /> Reset to new
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-2">
            Email list = selected rows with a verified email (for Zoho email campaign). SMS list = selected rows with a phone number (for Zoho SMS campaign). Both mark those rows “exported”.
          </p>
        </>
      )}

      <Modal open={showImport} onClose={() => setShowImport(false)} title="Import prospects" size="lg">
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">List / segment name</label>
            <input className="input w-full" list="imp-seg-list" placeholder="e.g. pharma, defence, kitchen-uae"
              value={impSegment} onChange={e => setImpSegment(e.target.value)} />
            <datalist id="imp-seg-list">{segments.map(s => <option key={s.segment} value={s.segment} />)}</datalist>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Paste rows (CSV, or copy straight from Excel)</label>
            <textarea className="input w-full font-mono text-xs" rows={8}
              placeholder={'Company,City,State,Email,Phone,Priority\nAcme Ltd,Mumbai,Maharashtra,info@acme.com,+91-9876543210,H'}
              value={impText} onChange={e => setImpText(e.target.value)} />
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              <label className="btn-secondary text-xs flex items-center gap-1.5 cursor-pointer">
                <Upload size={14} /> Choose .csv file
                <input type="file" accept=".csv,text/csv" className="hidden" onChange={onImpFile} />
              </label>
              <span className="text-xs text-gray-400">First row must be a header. A <strong>Company</strong> column is required; City, State, Email, Phone, Role, Fit, Priority are optional.</span>
            </div>
          </div>
          {parsed?.error && <p className="text-sm text-red-600">{parsed.error}</p>}
          {parsed && !parsed.error && <p className="text-sm text-emerald-700">{parsed.prospects.length} valid row(s) detected.</p>}
          {impResult && !impResult.error && <p className="text-sm text-emerald-700">✓ Imported {impResult.inserted}, skipped {impResult.skipped} duplicate(s) of {impResult.total}.</p>}
          {impResult?.error && <p className="text-sm text-red-600">{impResult.error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button className="btn-secondary" onClick={() => setShowImport(false)}>Close</button>
            <button className="btn-primary" disabled={impBusy || !impSegment.trim() || !parsed || parsed.error || !parsed.prospects?.length}
              onClick={doImport}>
              {impBusy ? 'Importing…' : `Import ${parsed && !parsed.error ? parsed.prospects.length : 0} rows`}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div className="card px-4 py-3">
      <div className={`text-2xl font-bold ${accent || 'text-brand-700'}`}>{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}
