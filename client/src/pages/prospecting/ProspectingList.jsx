import { useEffect, useMemo, useState } from 'react';
import api from '../../lib/api';
import Modal from '../../components/ui/Modal';
import { bodyToHtml, bodyToPlain, renderSms } from './applicationEmails';
import { campaignFor, renderTouch, renderCalls, tailoredTo } from './listCampaigns';
import { Target, Download, RefreshCw, Filter, Mail, MessageSquare, CheckCircle2, Star, Upload, Copy, Eye, Phone } from 'lucide-react';

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

// Friendly names for the list dropdown — the slug stays the key in the data.
const SEGMENT_LABEL = {
  'khadya-khurak-exhibitors': 'Khadya Khurak 2026 · Exhibitors',
  'khadya-khurak-visitors': 'Khadya Khurak 2026 · Visitors to invite',
  'pharma-tech-expo': 'Khadya Khurak 2026 · PharmaTech contacts',
  'existing-customers': 'Existing customers · reorder',
  'vietnam': 'Vietnam',
  'oman': 'Oman (Gulf)',
  'qatar': 'Qatar (Gulf)',
  'pharma': 'Pharma OEMs',
  'defence': 'Defence',
  'sa-heating-partners': 'South Africa · heating partners',
};
const segmentLabel = s => SEGMENT_LABEL[s] || String(s).replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase());

// WhatsApp preview: show *bold* the way WhatsApp renders it (the raw text is what gets sent).
const waPreview = text => String(text || '').split(/(\*[^*\n]+\*)/g).map((part, i) =>
  /^\*[^*\n]+\*$/.test(part) ? <strong key={i}>{part.slice(1, -1)}</strong> : part);

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
  const [touchTab, setTouchTab] = useState(0);                // active touch in the list campaign
  const [busy, setBusy] = useState(false);
  // Manual import
  const [showImport, setShowImport] = useState(false);
  const [impSegment, setImpSegment] = useState('');
  const [impText, setImpText] = useState('');
  const [impBusy, setImpBusy] = useState(false);
  const [impResult, setImpResult] = useState(null);
  // Per-company tailored campaign copy (e.g. expo cards) — opens in a modal
  const [campaignRow, setCampaignRow] = useState(null);
  const [seqTab, setSeqTab] = useState(0);              // active email in a multi-touch sequence
  useEffect(() => { setSeqTab(0); }, [campaignRow]);

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

  // List campaign: one email + one WhatsApp per touch, tailored to the application (and the
  // region, when one is picked) on screen — one Zoho upload covers the matching CSV slice.
  const campaign = useMemo(() => campaignFor(segment), [segment]);
  useEffect(() => { setTouchTab(0); }, [segment]);
  const listTouch = campaign ? renderTouch(campaign, touchTab, { app: activeApplication, region: regionFilter, company: null }) : null;
  const listHtml = listTouch ? bodyToHtml(listTouch.body, activeApplication) : '';
  // On screen, show where Zoho drops each company's name (the download keeps the merge tag).
  const previewHtml = listHtml.replace(/\$\[FNAME\|[^\]]*\]\$/g,
    '<span style="background:#fef3c7;border:1px dashed #f59e0b;border-radius:4px;padding:0 4px;">Company name</span>');
  const listTailoredTo = campaign ? tailoredTo(campaign, activeApplication) : '';

  const [copied, setCopied] = useState('');
  const [showPreview, setShowPreview] = useState(true);
  const copyRaw = async (text, key) => {
    try { await navigator.clipboard.writeText(text || ''); setCopied(key); setTimeout(() => setCopied(''), 2000); }
    catch { /* clipboard unavailable — user can select the text manually */ }
  };
  // Application-tailored SMS message (short, GSM-7-safe). Follows the email's application.
  const smsText = useMemo(() => renderSms(activeApplication), [activeApplication]);
  const downloadTxt = (text, name) => {
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  };
  const slug = s => String(s || 'all-applications').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  // One-click Zoho flow: download a complete .html file, then in Zoho use
  // "Import/Upload HTML → Upload from Computer" and drop the file in.
  const fullHtml = (subject, inner) =>
    '<!DOCTYPE html>\n<html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${String(subject).replace(/</g, '&lt;')}</title></head>\n` +
    '<body style="margin:0;padding:24px;background:#ffffff;">' + inner + '</body></html>';
  // Filename records the slice + touch, e.g. PHE-oman-boilers-steam-muscat-1-discovery.html
  const downloadListHtml = () => {
    const parts = ['PHE', segment, activeApplication, regionFilter, `${touchTab + 1}-${listTouch.key}`].filter(Boolean).map(slug);
    downloadTxt2Html(fullHtml(listTouch.subject, listHtml), `${parts.join('-')}.html`);
  };
  const downloadTxt2Html = (content, name) => {
    const blob = new Blob([content], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  };

  // --- Per contact: the same list touch, rendered with the row's own application, region and company ---
  const hasCampaign = p => !!campaignFor(p.segment) && p.status !== 'skip';
  // Existing customers: the row's notes carry what they order ("Most-ordered items: …") and the order span
  // ("Orders in the app: N (first – last)") — the restock messages name both.
  const rowCtx = p => {
    const notes = p.notes || '';
    const items = (notes.match(/Most-ordered items: (.+?)\.(?:\s|$)/) || [])[1];
    const lastOrder = (notes.match(/Orders in the app: \d+ \([^–)]*– ([^)]+)\)/) || [])[1];
    return { app: p.application || '', region: p.state || '', company: p.company,
      items: items ? items.split(' · ').map(s => s.replace(/\s*×\d+$/, '').trim()).filter(Boolean).slice(0, 2) : null,
      lastOrder: lastOrder || null };
  };
  // wa.me click-to-send: digits-only number + URL-encoded prefilled message
  const waLinkFor = (phone, text) => {
    const num = String(phone || '').replace(/[^0-9]/g, '');
    if (!num) return null;
    return `https://wa.me/${num}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
  };
  const rowCampaign = campaignRow ? campaignFor(campaignRow.segment) : null;
  const rowTouch = rowCampaign ? renderTouch(rowCampaign, seqTab, rowCtx(campaignRow)) : null;
  const rowCalls = rowCampaign ? renderCalls(rowCampaign, rowCtx(campaignRow)) : [];
  const downloadRowHtml = () => downloadTxt2Html(
    fullHtml(rowTouch.subject, bodyToHtml(rowTouch.body, campaignRow.application)),
    `PHE-${slug(campaignRow.company)}-${seqTab + 1}-${rowTouch.key}.html`);
  const dayLabel = d => (d == null ? '' : typeof d === 'number' ? 'Day ' + d : d);

  const selectedVisible = useMemo(() => visible.filter(p => selected.has(p.id)), [visible, selected]);
  // "skip" rows never export (and so never get re-marked "exported").
  // One Zoho list carries both channels: Zoho imports a contact only with an email, and its
  // SMS goes to the same contact's Mobile field — so rows with just a mobile are WhatsApp-only.
  const zohoSel = useMemo(() => selectedVisible.filter(p => hasEmail(p) && p.status !== 'skip'), [selectedVisible]);
  const zohoIds = useMemo(() => zohoSel.map(p => p.id), [zohoSel]);
  const zohoWithMobile = useMemo(() => zohoSel.filter(hasPhone).length, [zohoSel]);
  const mobileOnlySel = useMemo(() => selectedVisible.filter(p => !hasEmail(p) && hasPhone(p) && p.status !== 'skip').length, [selectedVisible]);

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

  const download = async ids => {
    if (!ids.length) return;
    setBusy(true);
    try {
      // Pass the active filters so the CSV honours exactly what's on screen and the
      // filename identifies the slice (e.g. PHE-pharma-autoclaves-sterilizers-gujarat-zoho.csv).
      const params = { segment, ids: ids.join(',') };
      if (appFilter) params.application = appFilter;
      if (regionFilter) params.state = regionFilter;
      const res = await api.get('/prospects/export.csv', { params, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      const slug = s => String(s).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
      const parts = ['PHE', slug(segment || 'prospects')];
      if (appFilter) parts.push(slug(appFilter));
      if (regionFilter) parts.push(slug(regionFilter));
      a.href = url;
      a.download = `${parts.join('-')}-zoho.csv`;
      a.click();
      URL.revokeObjectURL(url);
      await api.post('/prospects/bulk-status', { ids, status: 'exported' });
      loadProspects();
    } finally { setBusy(false); }
  };

  const markStatus = async status => {
    // "Reset to new" is the deliberate way to un-skip; other bulk marks leave skip rows alone.
    const skip = new Set(prospects.filter(p => p.status === 'skip').map(p => p.id));
    const ids = [...selected].filter(id => status === 'new' || !skip.has(id));
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

  // Clear region/application filters when switching segment — options differ per list.
  useEffect(() => { setRegionFilter(''); setAppFilter(''); }, [segment]);

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
            {[...segments].sort((a, b) => segmentLabel(a.segment).localeCompare(segmentLabel(b.segment))).map(s => (
              <option key={s.segment} value={s.segment}>{segmentLabel(s.segment)} ({s.total})</option>
            ))}
          </select>
        </div>
        <select className="input" value={appFilter} onChange={e => setAppFilter(e.target.value)}>
          <option value="">All applications</option>
          {applications.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <select className="input" value={regionFilter} onChange={e => setRegionFilter(e.target.value)}>
          <option value="">All regions</option>
          {regions.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
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
          <option value="skip">Skip (no campaign)</option>
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
                    <th className="px-3 py-2">Region</th>
                    <th className="px-3 py-2">Application</th>
                    <th className="px-3 py-2">Email</th>
                    <th className="px-3 py-2">Phone</th>
                    <th className="px-3 py-2">Contact</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Priority</th>
                    <th className="px-3 py-2">Campaign</th>
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
                        <td className="px-3 py-2 text-gray-600">{p.state || <span className="text-gray-300">—</span>}</td>
                        <td className="px-3 py-2">
                          {p.application
                            ? <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-sky-100 text-sky-800">{p.application}</span>
                            : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2 text-gray-500 font-mono text-xs">{p.email || <span className="text-gray-300">—</span>}</td>
                        <td className="px-3 py-2 text-gray-500 font-mono text-xs">
                          {p.phone || (!p.office_phone && <span className="text-gray-300">—</span>)}
                          {p.office_phone && <div className="text-gray-400" title="Office / sales line to call">☎ {p.office_phone}</div>}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${sb.cls}`}>{sb.label}</span>
                        </td>
                        <td className="px-3 py-2"><span className="text-xs text-gray-500 capitalize">{p.status}</span></td>
                        <td className="px-3 py-2">
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${PRIORITY_BADGE[p.priority] || PRIORITY_BADGE.L}`}>
                            {PRIORITY_LABEL[p.priority] || p.priority}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          {/* Every row opens: campaign touches when it has one, otherwise its numbers + notes */}
                          <button className={`text-xs font-medium px-2 py-1 rounded-md border flex items-center gap-1 ${hasCampaign(p) ? 'border-brand-200 text-brand-700 hover:bg-brand-50' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}
                            onClick={() => setCampaignRow(p)}>
                            <Mail size={12} /> {hasCampaign(p) ? 'View' : 'Details'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {!loading && visible.length === 0 && (
                    <tr><td colSpan={11} className="px-3 py-10 text-center text-gray-400">No prospects for this filter</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* List campaign — one email + one WhatsApp per touch, tailored to the slice on screen */}
          <div className="card p-4 mb-6">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <Mail size={16} className="text-brand-700" />
              <h3 className="text-sm font-semibold">{campaign ? `${campaign.name} — campaign` : 'Campaign'}</h3>
              {campaign && (
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${listTailoredTo ? 'bg-sky-100 text-sky-800' : 'bg-gray-100 text-gray-500'}`}>
                  {listTailoredTo ? `Tailored: ${listTailoredTo}` : 'All applications — pick an application to tailor'}
                </span>
              )}
              {campaign && regionFilter && (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-violet-100 text-violet-800">Region: {regionFilter}</span>
              )}
            </div>
            {!campaign ? (
              <p className="text-sm text-gray-400">No campaign for this list yet — ask Claude to build one.</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {campaign.touches.map((t, i) => (
                    <button key={t.key}
                      className={`text-xs px-2.5 py-1.5 rounded-md border ${touchTab === i ? 'bg-brand-700 text-white border-brand-700' : 'bg-white text-gray-600'}`}
                      onClick={() => setTouchTab(i)}>
                      {i + 1}. {t.label}{t.day != null ? ` · ${dayLabel(t.day)}` : ''}
                    </button>
                  ))}
                </div>
                {listTouch.attach && (
                  listTouch.flyer ? (
                    <a href={listTouch.flyer} target="_blank" rel="noopener noreferrer"
                      className="mb-2 inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md bg-amber-50 border border-amber-200 text-amber-900 hover:bg-amber-100">
                      📎 {listTouch.attach} — embedded in this email · open ↗
                    </a>
                  ) : (
                    <div className="mb-2 inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md bg-amber-50 border border-amber-200 text-amber-900">
                      📎 Send with this: {listTouch.attach}
                    </div>
                  )
                )}
                <div className="flex gap-2 mb-2">
                  <input className="input w-full font-medium" readOnly value={listTouch.subject} />
                  <button className="btn-secondary text-xs whitespace-nowrap flex items-center gap-1.5" onClick={() => copyRaw(listTouch.subject, 'subj')}>
                    <Copy size={13} /> {copied === 'subj' ? 'Copied ✓' : 'Copy subject'}
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <button className="btn-primary flex items-center gap-1.5" onClick={downloadListHtml}>
                    <Download size={15} /> Download for Zoho (.html)
                  </button>
                  <button className="btn-secondary text-xs flex items-center gap-1.5" onClick={() => setShowPreview(v => !v)}>
                    <Eye size={13} /> {showPreview ? 'Hide preview' : 'Preview as recipient sees it'}
                  </button>
                </div>
                {showPreview && (
                  <div className="border border-gray-200 rounded-lg p-5 bg-white overflow-x-auto mb-3"
                    dangerouslySetInnerHTML={{ __html: previewHtml }} />
                )}
                <div className="border-t border-gray-100 pt-3">
                  <div className="flex items-center gap-2 mb-2">
                    <MessageSquare size={15} className="text-emerald-600" />
                    <h4 className="text-sm font-semibold">WhatsApp for this touch</h4>
                  </div>
                  <div className="text-sm text-gray-700 bg-emerald-50 border border-emerald-100 rounded p-3 whitespace-pre-wrap break-words leading-relaxed">{waPreview(listTouch.whatsapp)}</div>
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    <button className="btn-secondary text-xs flex items-center gap-1.5" onClick={() => copyRaw(listTouch.whatsapp, 'list-wa')}>
                      <Copy size={13} /> {copied === 'list-wa' ? 'Copied ✓' : 'Copy WhatsApp'}
                    </button>
                    {listTouch.waImage && (
                      <a className="btn-secondary text-xs flex items-center gap-1.5" href={listTouch.waImage} target="_blank" rel="noopener noreferrer">
                        🖼️ Image to send with it ↗
                      </a>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mt-2">
                    To send it to one contact with their company name filled in, open <strong>View</strong> on their row → <strong>WhatsApp this</strong>.
                  </p>
                </div>
                <div className="mt-3 border border-emerald-200 bg-emerald-50 rounded-lg p-3 text-xs text-emerald-900">
                  <strong>Zoho, per touch:</strong> ① <strong>Export Zoho list</strong> below — it uses these same filters, so it's the same slice.
                  {' '}② Download this touch's HTML and, in Zoho's Content step, choose <strong>Import/Upload HTML → Upload from Computer</strong>.
                  {' '}③ Paste the subject. Each company's name merges via $[FNAME|…]$ — the CSV puts the company in First Name.
                </div>
              </>
            )}
          </div>

          {/* SMS template — matches the email's application */}
          <div className="card p-4 mb-6">
            <div className="flex items-center gap-2 mb-3">
              <MessageSquare size={16} className="text-brand-700" />
              <h3 className="text-sm font-semibold">SMS message</h3>
              <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-sky-100 text-sky-800">
                Tailored: {activeApplication || 'generic'}
              </span>
              <span className="text-xs text-gray-400">{smsText.length} chars · {smsText.length <= 160 ? '1' : Math.ceil(smsText.length / 153)} segment{smsText.length > 160 ? 's' : ''}</span>
            </div>
            <textarea className="input w-full font-sans text-sm leading-relaxed" rows={4} readOnly value={smsText} />
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <button className="btn-primary flex items-center gap-1.5"
                onClick={() => downloadTxt(smsText, `PHE-sms-${slug(activeApplication)}.txt`)}>
                <Download size={15} /> Download SMS (.txt)
              </button>
              <button className="btn-secondary text-xs flex items-center gap-1.5" onClick={() => copyRaw(smsText, 'sms')}>
                <Copy size={13} /> {copied === 'sms' ? 'Copied ✓' : 'Copy SMS text'}
              </button>
            </div>
            <p className="text-xs text-gray-400 mt-2">
              GSM-7 safe and kept under 2 SMS segments. Paste into your Zoho SMS campaign and send it to the same <strong>Zoho list</strong> as the emails — its Mobile column carries each contact&apos;s SMS number. {'$[FNAME|team]$'} merges the company name.
            </p>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn-primary flex items-center gap-1.5" disabled={!zohoIds.length || busy}
              onClick={() => download(zohoIds)}>
              <Mail size={16} /> Export Zoho list — email + SMS ({zohoIds.length})
            </button>
            <button className="btn-secondary flex items-center gap-1.5" disabled={!selected.size || busy} onClick={() => markStatus('contacted')}>
              <CheckCircle2 size={16} /> Mark contacted
            </button>
            <button className="btn-secondary flex items-center gap-1.5" disabled={!selected.size || busy} onClick={() => markStatus('new')}>
              <Star size={16} /> Reset to new
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-2">
            One list for both Zoho campaigns: every selected contact with an email, and their mobile (with country code) in the <strong>Mobile</strong> column for SMS
            {zohoIds.length > 0 && <> — {zohoWithMobile} of {zohoIds.length} have a mobile</>}.
            {mobileOnlySel > 0 && <> {mobileOnlySel} selected {mobileOnlySel === 1 ? 'row has' : 'rows have'} a mobile but no email — Zoho can&apos;t import a contact without an email, so reach {mobileOnlySel === 1 ? 'it' : 'them'} on WhatsApp from the row.</>}
            {' '}Only the rows matching the active application/region filters export (the filename records the slice), and they're marked “exported”.
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

      {/* Per-company tailored campaign (expo cards): bespoke email + WhatsApp */}
      <Modal open={!!campaignRow} onClose={() => setCampaignRow(null)}
        title={campaignRow ? `Campaign — ${campaignRow.company}` : ''} size="lg">
        {campaignRow && (
          <div className="space-y-5">
            <div className="text-xs text-gray-500">
              {campaignRow.contact_role && <span>{campaignRow.contact_role} · </span>}
              {campaignRow.email && <span className="font-mono">{campaignRow.email}</span>}
              {campaignRow.phone && <span className="font-mono"> · {campaignRow.phone}</span>}
              {campaignRow.office_phone && <span className="font-mono"> · ☎ {campaignRow.office_phone}</span>}
              {campaignRow.application && <span> · {campaignRow.application}</span>}
            </div>
            {campaignRow.notes && (
              <details open className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded p-2">
                <summary className="cursor-pointer font-medium text-gray-700">Notes</summary>
                <div className="mt-1 whitespace-pre-wrap break-words">{campaignRow.notes}</div>
              </details>
            )}

            {rowCampaign && rowTouch && hasCampaign(campaignRow) ? (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {rowCampaign.touches.map((t, i) => (
                    <button key={t.key}
                      className={`text-xs px-2.5 py-1.5 rounded-md border ${seqTab === i ? 'bg-brand-700 text-white border-brand-700' : 'bg-white text-gray-600'}`}
                      onClick={() => setSeqTab(i)}>
                      {i + 1}. {t.label}{t.day != null ? ` · ${dayLabel(t.day)}` : ''}
                    </button>
                  ))}
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <Mail size={15} className="text-brand-700" />
                    <h4 className="text-sm font-semibold">{rowTouch.label} email</h4>
                    {rowTouch.day != null && <span className="text-xs text-gray-400">send {dayLabel(rowTouch.day)}</span>}
                  </div>
                  {rowTouch.attach && (
                    rowTouch.flyer ? (
                      <a href={rowTouch.flyer} target="_blank" rel="noopener noreferrer"
                        className="mb-2 inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md bg-amber-50 border border-amber-200 text-amber-900 hover:bg-amber-100">
                        📎 {rowTouch.attach} — embedded in this email · open ↗
                      </a>
                    ) : (
                      <div className="mb-2 inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md bg-amber-50 border border-amber-200 text-amber-900">
                        📎 Send with this: {rowTouch.attach}
                      </div>
                    )
                  )}
                  <input className="input w-full mb-2 font-medium text-sm" readOnly value={rowTouch.subject} />
                  <textarea className="input w-full font-sans text-sm leading-relaxed" rows={13} readOnly value={bodyToPlain(rowTouch.body)} />
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    <button className="btn-primary flex items-center gap-1.5" onClick={downloadRowHtml}>
                      <Download size={15} /> Download email (.html)
                    </button>
                    <button className="btn-secondary text-xs flex items-center gap-1.5"
                      onClick={() => copyRaw(`${rowTouch.subject}\n\n${bodyToPlain(rowTouch.body)}`, 'seq-email')}>
                      <Copy size={13} /> {copied === 'seq-email' ? 'Copied ✓' : 'Copy email'}
                    </button>
                    {waLinkFor(campaignRow.phone, rowTouch.whatsapp) && (
                      <a className="btn-secondary text-xs flex items-center gap-1.5" style={{ color: '#128C7E' }}
                        href={waLinkFor(campaignRow.phone, rowTouch.whatsapp)} target="_blank" rel="noopener noreferrer">
                        <MessageSquare size={13} /> WhatsApp this
                      </a>
                    )}
                    <button className="btn-secondary text-xs flex items-center gap-1.5" onClick={() => copyRaw(rowTouch.whatsapp, 'seq-wa')}>
                      <Copy size={13} /> {copied === 'seq-wa' ? 'Copied ✓' : 'Copy WhatsApp'}
                    </button>
                    {rowTouch.waImage && (
                      <a className="btn-secondary text-xs flex items-center gap-1.5" href={rowTouch.waImage} target="_blank" rel="noopener noreferrer">
                        🖼️ Send this image ↗
                      </a>
                    )}
                  </div>
                  <div className="mt-2 text-sm text-gray-700 bg-emerald-50 border border-emerald-100 rounded p-3 whitespace-pre-wrap break-words leading-relaxed">{waPreview(rowTouch.whatsapp)}</div>
                </div>
                {rowCalls.length > 0 && (
                  <div className="pt-2 border-t border-gray-100">
                    <div className="flex items-center gap-2 mb-2">
                      <Phone size={15} className="text-brand-700" />
                      <h4 className="text-sm font-semibold">Call schedule</h4>
                    </div>
                    <div className="space-y-2">
                      {rowCalls.map((c, i) => (
                        <details key={i} className="border border-gray-200 rounded-md">
                          <summary className="cursor-pointer px-3 py-2 text-sm font-medium flex items-center justify-between">
                            <span>{c.label}{c.day != null ? ` — ${dayLabel(c.day)}` : ''}</span>
                            <span role="button" tabIndex={0} className="text-xs text-brand-700"
                              onClick={(e) => { e.preventDefault(); copyRaw(c.script, 'call-' + i); }}>
                              {copied === 'call-' + i ? 'Copied ✓' : 'Copy'}
                            </span>
                          </summary>
                          <div className="px-3 pb-3 text-xs whitespace-pre-wrap text-gray-700 bg-amber-50">{c.script}</div>
                        </details>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-gray-400">
                No campaign for this contact{campaignRow.status === 'skip' ? ' — marked skip' : ''}.
              </p>
            )}
          </div>
        )}
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
