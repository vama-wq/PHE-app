import { useEffect, useMemo, useState } from 'react';
import api from '../../lib/api';
import Modal from '../../components/ui/Modal';
import { bodyToHtml, bodyToPlain, renderSms } from './applicationEmails';
import { campaignFor, renderTouch, renderCalls, tailoredTo } from './listCampaigns';
import { Link } from 'react-router-dom';
import { Target, Download, RefreshCw, Filter, Mail, MessageSquare, CheckCircle2, Star, Upload, Copy, Eye, Phone, Linkedin } from 'lucide-react';

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

// Sales pipeline (owner, 26 Oct 2026). "Not interested" and "Skip" stop all campaign messages.
const STATUSES = [
  { key: 'new', label: 'New', cls: 'bg-gray-100 text-gray-600' },
  { key: 'exported', label: 'In Zoho list', cls: 'bg-sky-50 text-sky-700' },
  { key: 'contacted', label: 'Contacted', cls: 'bg-indigo-50 text-indigo-700' },
  { key: 'replied', label: 'Replied', cls: 'bg-violet-100 text-violet-800' },
  { key: 'interested', label: 'Interested', cls: 'bg-amber-100 text-amber-800' },
  { key: 'quoted', label: 'Quoted', cls: 'bg-orange-100 text-orange-800' },
  { key: 'won', label: 'Won', cls: 'bg-emerald-100 text-emerald-800' },
  { key: 'not_interested', label: 'Not interested', cls: 'bg-rose-50 text-rose-700' },
  { key: 'skip', label: 'Skip', cls: 'bg-gray-50 text-gray-400' },
];
const STATUS = Object.fromEntries(STATUSES.map(s => [s.key, s]));
const NO_CAMPAIGN = new Set(['skip', 'not_interested']);
const CHANNEL_ICON = { email: '✉', whatsapp: '💬', call: '☎' };
const fmtDay = d => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
// Campaign images live in client/public — fetch them same-origin so they can be saved or shared as files.
const imagePath = url => { try { return new URL(url).pathname; } catch { return url; } };
async function imageFile(url) {
  const res = await fetch(imagePath(url));
  if (!res.ok) throw new Error('image not found');
  const blob = await res.blob();
  return new File([blob], imagePath(url).split('/').pop() || 'PHE-image.jpg', { type: blob.type || 'image/jpeg' });
}
async function saveImage(url) {
  try {
    const f = await imageFile(url);
    const u = URL.createObjectURL(f);
    const a = document.createElement('a');
    a.href = u; a.download = f.name; a.click();
    setTimeout(() => URL.revokeObjectURL(u), 3000);
  } catch { window.open(url, '_blank', 'noopener'); }
}

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
  const rowId = campaignRow?.id;
  useEffect(() => { setSeqTab(0); }, [rowId]);
  // Finding things: search + priority + touch filters (client-side, instant)
  const [search, setSearch] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [touchFilter, setTouchFilter] = useState('');   // `${channel}|${touch_key}|done|not`
  // Campaign tracking: touches done for this list, and the open row's history
  const [touches, setTouches] = useState([]);
  const [history, setHistory] = useState(null);
  const [rowStatus, setRowStatus] = useState('');
  const [rowNote, setRowNote] = useState('');
  const [callNote, setCallNote] = useState({});         // per call: call1 → "how did it go"
  const [bulkStatus, setBulkStatus] = useState('');
  const [shareFile, setShareFile] = useState(null);     // { url, file }: the touch's image, pre-fetched so Share works in one tap

  const loadSegments = () =>
    api.get('/prospects/segments').then(r => {
      setSegments(r.data);
      if (r.data.length && !segment) setSegment(r.data[0].segment);
    }).catch(() => {});

  // keepSelection: after a tick or status change, don't reset what the user selected
  const loadProspects = (keepSelection = false) => {
    setLoading(true);
    const params = {};
    if (segment) params.segment = segment;
    return api.get('/prospects', { params })
      .then(r => {
        setProspects(r.data);
        if (!keepSelection) setSelected(new Set(r.data.map(p => p.id)));
        setCampaignRow(cur => (cur ? r.data.find(p => p.id === cur.id) || cur : cur));
        return r.data;
      })
      .catch(() => { setProspects([]); return []; })
      .finally(() => setLoading(false));
  };
  const loadTouches = () => (segment
    ? api.get('/prospects/touches', { params: { segment } }).then(r => setTouches(r.data)).catch(() => setTouches([]))
    : Promise.resolve());
  const loadHistory = id => api.get(`/prospects/${id}/history`).then(r => setHistory(r.data)).catch(() => setHistory(null));

  useEffect(() => { loadSegments(); }, []);
  useEffect(() => { if (segment) { loadProspects(); loadTouches(); } /* eslint-disable-line */ }, [segment]);
  useEffect(() => {
    setHistory(null);
    if (!rowId) return;
    setRowNote(''); setCallNote({});
    loadHistory(rowId);
  }, [rowId]); // eslint-disable-line
  // Follow the row's status when it moves underneath (e.g. a tick auto-advances it to Contacted)
  const rowStatusNow = campaignRow?.status;
  useEffect(() => { if (rowId) setRowStatus(rowStatusNow || 'new'); }, [rowId, rowStatusNow]);

  // touch lookup: `${prospect}|${touch}|${channel}` → the tick (with date, who, note)
  const touchIndex = useMemo(() => new Map(touches.map(t => [`${t.prospect_id}|${t.touch_key}|${t.channel}`, t])), [touches]);
  const tickFor = (pid, key, channel) => touchIndex.get(`${pid}|${key}|${channel}`);
  const reach = (p, channel) => !NO_CAMPAIGN.has(p.status) && (channel === 'email' ? !!(p.email && p.email.trim())
    : channel === 'whatsapp' ? !!(p.phone && p.phone.trim()) : !!((p.phone && p.phone.trim()) || (p.office_phone && p.office_phone.trim())));

  const markTouch = async (ids, touchKey, channel, note) => {
    if (!ids.length) return;
    setBusy(true);
    try {
      await api.post('/prospects/touches', { segment, ids, touch_key: touchKey, channel, note: note || undefined });
      await Promise.all([loadTouches(), loadProspects(true)]);
      if (rowId) loadHistory(rowId);
    } finally { setBusy(false); }
  };
  const undoTouch = async (ids, touchKey, channel) => {
    if (!ids.length) return;
    setBusy(true);
    try {
      await api.post('/prospects/touches/undo', { ids, touch_key: touchKey, channel });
      await loadTouches();
      if (rowId) loadHistory(rowId);
    } finally { setBusy(false); }
  };
  const changeStatus = async (id, status, note) => {
    await api.patch(`/prospects/${id}`, { status, status_note: note || undefined });
    await loadProspects(true);
    if (rowId === id) loadHistory(id);
  };

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

  // All filters are applied client-side so they're instant (the whole list is loaded once per segment).
  const matchTouch = p => {
    if (!touchFilter) return true;
    const [channel, key, want] = touchFilter.split('|');
    const done = !!tickFor(p.id, key, channel);
    return want === 'done' ? done : (!done && reach(p, channel));
  };
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return prospects.filter(p =>
      (!statusFilter || p.status === statusFilter) &&
      (!sourceFilter || rowSource(p) === sourceFilter) &&
      (!regionFilter || p.state === regionFilter) &&
      (!appFilter || p.application === appFilter) &&
      (!priorityFilter || p.priority === priorityFilter) &&
      (!q || [p.company, p.city, p.email, p.phone, p.office_phone, p.contact_role].some(v => String(v || '').toLowerCase().includes(q))) &&
      matchTouch(p));
  }, [prospects, statusFilter, sourceFilter, regionFilter, appFilter, priorityFilter, search, touchFilter, touchIndex]); // eslint-disable-line
  const statusCounts = useMemo(() => prospects.reduce((m, p) => (m[p.status] = (m[p.status] || 0) + 1, m), {}), [prospects]);

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
  // Calls in this campaign (for the touch filter) — tracked as call1, call2, … per contact
  const listCalls = campaign ? renderCalls(campaign, { app: activeApplication, region: regionFilter, company: null }) : [];

  // Progress of the touch on screen, over the rows on screen: email sent / WhatsApp done, out of who can get it.
  const progressOf = (rows, key) => ['email', 'whatsapp'].map(channel => {
    const elig = rows.filter(p => reach(p, channel));
    const ticks = elig.map(p => tickFor(p.id, key, channel)).filter(Boolean);
    const last = ticks.reduce((m, t) => (!m || t.done_at > m ? t.done_at : m), null);
    return { channel, done: ticks.length, total: elig.length, last };
  });
  const touchProgress = listTouch ? progressOf(visible, listTouch.key) : [];
  // Every touch over the whole list (shown under each touch tab), and the first one with work left
  const allProgress = useMemo(() => (campaign ? campaign.touches.map(t => progressOf(prospects, t.key)) : []),
    [campaign, prospects, touchIndex]); // eslint-disable-line
  const nextUp = useMemo(() => {
    if (!campaign) return null;
    const i = allProgress.findIndex(pr => pr.some(c => c.total && c.done < c.total));
    return i < 0 ? 'done' : { i, t: campaign.touches[i], pr: allProgress[i] };
  }, [campaign, allProgress]);
  // Pre-fetch the touch's WhatsApp image so "Share text + image" works in one tap on a phone
  const shareSupported = typeof navigator !== 'undefined' && typeof navigator.canShare === 'function';
  const activeImage = campaignRow ? null : listTouch?.waImage;

  const [copied, setCopied] = useState('');
  const [showPreview, setShowPreview] = useState(true);
  const copyRaw = async (text, key) => {
    try { await navigator.clipboard.writeText(text || ''); setCopied(key); setTimeout(() => setCopied(''), 2000); }
    catch { /* clipboard unavailable — user can select the text manually */ }
  };
  // Application-tailored SMS message (short, GSM-7-safe). Follows the email's application.
  const smsText = useMemo(() => renderSms(activeApplication, segment), [activeApplication, segment]);
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
  const hasCampaign = p => !!campaignFor(p.segment) && !NO_CAMPAIGN.has(p.status);
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
  // wa.me needs the number with its country code. Many rows store it the local way (Vietnam "0912 345 678",
  // India "98250 12345"), so add the code from the row's country; numbers written with + or 00 are kept as they are.
  const CALLING = { india: ['91', 10], vietnam: ['84', 9], oman: ['968', 8], qatar: ['974', 8], 'united arab emirates': ['971', 9],
    uae: ['971', 9], 'saudi arabia': ['966', 9], kuwait: ['965', 8], bahrain: ['973', 8], 'south africa': ['27', 9] };
  const intlNumber = (phone, country) => {
    const first = String(phone || '').split(/[/,;]/)[0].trim();
    if (!first) return '';
    if (/^(\+|00)/.test(first)) return first.replace(/^(\+|00)/, '').replace(/\D/g, '');
    const d = first.replace(/\D/g, '');
    const [cc, len] = CALLING[String(country || 'India').trim().toLowerCase()] || [];
    if (!cc) return d;
    const national = d.replace(/^0+/, '');
    if (national.length === len) return cc + national;
    if (d.startsWith(cc) && d.length - cc.length === len) return d;
    return d;
  };
  const waLinkFor = (phone, text, country) => {
    const num = intlNumber(phone, country);
    if (!num) return null;
    return `https://wa.me/${num}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
  };
  // Zalo (Vietnam): zalo.me/<local number> opens the chat; Zalo can't prefill text, so the message is copied first.
  const zaloLinkFor = (phone, country) => {
    const num = intlNumber(phone, country);
    return num.startsWith('84') && num.length === 11 ? `https://zalo.me/0${num.slice(2)}` : null;
  };
  const rowCampaign = campaignRow ? campaignFor(campaignRow.segment) : null;
  const rowTouch = rowCampaign ? renderTouch(rowCampaign, seqTab, rowCtx(campaignRow)) : null;
  const rowCalls = rowCampaign ? renderCalls(rowCampaign, rowCtx(campaignRow)) : [];
  // The image to share: the open row's touch image, else the list touch's — fetched ahead so Share is one tap
  const imageToShare = rowTouch?.waImage || activeImage || null;
  useEffect(() => {
    let live = true;
    if (imageToShare && shareSupported) imageFile(imageToShare).then(file => { if (live) setShareFile({ url: imageToShare, file }); }).catch(() => {});
    return () => { live = false; };
  }, [imageToShare]); // eslint-disable-line
  const shareReady = shareFile && shareFile.url === imageToShare ? shareFile.file : null;
  const canShareImage = !!(shareReady && navigator.canShare({ files: [shareReady] }));
  // The text is copied too: some phones hand WhatsApp only the picture — then just paste.
  const shareTextAndImage = async (text, onDone) => {
    if (text && navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
    try { await navigator.share(text ? { files: [shareReady], text } : { files: [shareReady] }); if (onDone) onDone(); }
    catch { /* user closed the share sheet */ }
  };
  // The open contact's history (status changes + touches), newest first, in words
  const touchName = (key, channel) => {
    const i = rowCampaign ? rowCampaign.touches.findIndex(t => t.key === key) : -1;
    if (i >= 0) return `${i + 1}. ${rowCampaign.touches[i].label} — ${channel === 'email' ? 'email sent' : 'WhatsApp done'}`;
    const c = /^call(\d+)$/.exec(key);
    if (c) return `${rowCalls[+c[1] - 1]?.label || `Call ${c[1]}`} — done`;
    return `${key} (${channel})`;
  };
  const statusLabel = s => STATUS[s]?.label || s || '—';
  // "auto: whatsapp · awareness" (logged by a tick) reads as "automatic: 1. Awareness — WhatsApp done"
  const noteText = n => { const a = /^auto: (\w+) · (.+)$/.exec(n || ''); return a ? `automatic: ${touchName(a[2], a[1])}` : n; };
  const historyItems = history ? [
    ...history.status.map(h => ({ at: h.changed_at, by: h.changed_by,
      text: h.from_status === h.to_status ? `Note: ${h.note}`
        : `${statusLabel(h.from_status)} → ${statusLabel(h.to_status)}${h.note ? ` — ${noteText(h.note)}` : ''}` })),
    ...history.touches.map(t => ({ at: t.done_at, by: t.done_by,
      text: `${CHANNEL_ICON[t.channel]} ${touchName(t.touch_key, t.channel)}${t.note ? ` — ${t.note}` : ''}` })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1)) : [];
  const downloadRowHtml = () => downloadTxt2Html(
    fullHtml(rowTouch.subject, bodyToHtml(rowTouch.body, campaignRow.application)),
    `PHE-${slug(campaignRow.company)}-${seqTab + 1}-${rowTouch.key}.html`);
  const dayLabel = d => (d == null ? '' : typeof d === 'number' ? 'Day ' + d : d);

  const selectedVisible = useMemo(() => visible.filter(p => selected.has(p.id)), [visible, selected]);
  // "skip" rows never export (and so never get re-marked "exported").
  // One Zoho list carries both channels: Zoho imports a contact only with an email, and its
  // SMS goes to the same contact's Mobile field — so rows with just a mobile are WhatsApp-only.
  const zohoSel = useMemo(() => selectedVisible.filter(p => hasEmail(p) && !NO_CAMPAIGN.has(p.status)), [selectedVisible]);
  const zohoIds = useMemo(() => zohoSel.map(p => p.id), [zohoSel]);
  const zohoWithMobile = useMemo(() => zohoSel.filter(hasPhone).length, [zohoSel]);
  const mobileOnlySel = useMemo(() => selectedVisible.filter(p => !hasEmail(p) && hasPhone(p) && !NO_CAMPAIGN.has(p.status)).length, [selectedVisible]);

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
      await api.post('/prospects/bulk-status', { ids, status: 'exported' });   // only 'new' rows move
      loadProspects(true);
    } finally { setBusy(false); }
  };

  // Bulk status: only the selected rows on screen. "New" is the deliberate way to bring back a
  // Skip / Not-interested row; any other change leaves those rows alone (unless it's to one of them).
  const bulkIds = bulkStatus
    ? selectedVisible.filter(p => bulkStatus === 'new' || NO_CAMPAIGN.has(bulkStatus) || !NO_CAMPAIGN.has(p.status)).map(p => p.id)
    : [];
  const STAGE = ['new', 'exported', 'contacted', 'replied', 'interested', 'quoted', 'won'];
  const markStatus = async status => {
    if (!bulkIds.length || !status) return;
    let ids = bulkIds;
    // Don't quietly pull a Replied / Interested / Quoted / Won contact back to an earlier stage
    const ahead = STAGE.includes(status)
      ? selectedVisible.filter(p => ids.includes(p.id) && STAGE.indexOf(p.status) > STAGE.indexOf(status)) : [];
    if (ahead.length && !window.confirm(
      `${ahead.length} of these ${ahead.length === 1 ? 'is' : 'are'} already further along (${[...new Set(ahead.map(p => STATUS[p.status]?.label))].join(', ')}).\n\n`
      + `OK = change all ${ids.length} to “${STATUS[status].label}”.\nCancel = leave ${ahead.length === 1 ? 'that one' : 'those'} as ${ahead.length === 1 ? 'it is' : 'they are'} and change the other ${ids.length - ahead.length}.`)) {
      const keep = new Set(ahead.map(p => p.id));
      ids = ids.filter(id => !keep.has(id));
    }
    if (!ids.length) return;
    setBusy(true);
    try {
      await api.post('/prospects/bulk-status', { ids, status });
      await loadProspects(true);
      setBulkStatus('');
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

  // Clear the filters when switching segment — options differ per list.
  useEffect(() => { setRegionFilter(''); setAppFilter(''); setTouchFilter(''); setSearch(''); setStatusFilter(''); }, [segment]);

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
          <Link to="/prospecting/linkedin" className="btn-secondary flex items-center gap-1.5 text-sm">
            <Linkedin size={15} /> LinkedIn calendar
          </Link>
          <button className="btn-secondary flex items-center gap-1.5 text-sm" onClick={() => { setImpResult(null); setShowImport(true); }}>
            <Upload size={15} /> Import
          </button>
          <button className="btn-secondary flex items-center gap-1.5 text-sm" onClick={() => { loadProspects(); loadTouches(); }}>
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
          {STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <select className="input" value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)}>
          <option value="">All priorities</option>
          <option value="H">High</option>
          <option value="M">Medium</option>
          <option value="L">Low</option>
        </select>
        {campaign && (
          <select className="input" value={touchFilter} onChange={e => setTouchFilter(e.target.value)}>
            <option value="">All campaign progress</option>
            {campaign.touches.map((t, i) => (
              <optgroup key={t.key} label={`${i + 1}. ${t.label}`}>
                <option value={`email|${t.key}|not`}>✉ Email not sent yet</option>
                <option value={`email|${t.key}|done`}>✉ Email sent</option>
                <option value={`whatsapp|${t.key}|not`}>💬 WhatsApp not done yet</option>
                <option value={`whatsapp|${t.key}|done`}>💬 WhatsApp done</option>
              </optgroup>
            ))}
            {listCalls.length > 0 && (
              <optgroup label="Calls">
                {listCalls.map((c, i) => [
                  <option key={`n${i}`} value={`call|call${i + 1}|not`}>☎ Not called yet — {c.label}</option>,
                  <option key={`d${i}`} value={`call|call${i + 1}|done`}>☎ Called — {c.label}</option>,
                ])}
              </optgroup>
            )}
          </select>
        )}
        <input className="input" style={{ minWidth: 220 }} placeholder="Search company, city, email or phone…"
          value={search} onChange={e => setSearch(e.target.value)} />
        {(statusFilter || priorityFilter || touchFilter || search || appFilter || regionFilter || sourceFilter) && (
          <button className="text-xs text-gray-500 underline" onClick={() => {
            setStatusFilter(''); setPriorityFilter(''); setTouchFilter(''); setSearch(''); setAppFilter(''); setRegionFilter(''); setSourceFilter('');
          }}>Clear filters</button>
        )}
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

          {/* Pipeline: how many contacts sit at each status — tap one to filter */}
          <div className="flex flex-wrap items-center gap-1.5 mb-5">
            <span className="text-xs text-gray-500 mr-1">Pipeline:</span>
            {STATUSES.filter(s => statusCounts[s.key]).map(s => (
              <button key={s.key} onClick={() => setStatusFilter(statusFilter === s.key ? '' : s.key)}
                className={`text-xs font-medium px-2.5 py-1 rounded-full ${s.cls} ${statusFilter === s.key ? 'ring-2 ring-brand-500' : ''}`}>
                {s.label} {statusCounts[s.key]}
              </button>
            ))}
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
                    {campaign && <th className="px-3 py-2" title="This touch: email sent / WhatsApp done">Touch {touchTab + 1}</th>}
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
                        <td className="px-3 py-2">
                          <select value={p.status} title="Change status"
                            className={`text-xs font-medium rounded-full border-0 py-0.5 pl-2 pr-6 ${(STATUS[p.status] || STATUS.new).cls}`}
                            onChange={e => changeStatus(p.id, e.target.value)}>
                            {STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                            {!STATUS[p.status] && <option value={p.status}>{p.status}</option>}
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${PRIORITY_BADGE[p.priority] || PRIORITY_BADGE.L}`}>
                            {PRIORITY_LABEL[p.priority] || p.priority}
                          </span>
                        </td>
                        {campaign && (
                          <td className="px-3 py-2 whitespace-nowrap text-sm">
                            {['email', 'whatsapp'].map(ch => {
                              if (!reach(p, ch)) return <span key={ch} className="mr-1.5 text-gray-200" title={`No ${ch}`}>{CHANNEL_ICON[ch]}</span>;
                              const t = listTouch && tickFor(p.id, listTouch.key, ch);
                              return (
                                <span key={ch} className={`mr-1.5 ${t ? '' : 'opacity-30'}`}
                                  title={t ? `${ch === 'email' ? 'Email sent' : 'WhatsApp done'} ${fmtDay(t.done_at)}${t.done_by ? ` · ${t.done_by}` : ''}` : `${ch === 'email' ? 'Email' : 'WhatsApp'} not done`}>
                                  {CHANNEL_ICON[ch]}{t ? '✓' : ''}
                                </span>
                              );
                            })}
                          </td>
                        )}
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
                    <tr><td colSpan={12} className="px-3 py-10 text-center text-gray-400">No prospects for this filter</td></tr>
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
                      {allProgress[i] && (
                        <span className="block opacity-75" style={{ fontSize: 10 }} title="Whole list: emails sent / WhatsApps done">
                          {allProgress[i].map(c => `${CHANNEL_ICON[c.channel]} ${c.done}/${c.total}`).join('   ')}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                {/* Progress of this touch over the rows on screen, and what's next for the whole list */}
                <div className="flex flex-wrap items-center gap-2 mb-2 text-xs">
                  {visible.length !== prospects.length && <span className="text-gray-500">On screen ({visible.length}):</span>}
                  {touchProgress.map(c => (
                    <span key={c.channel} className={`px-2.5 py-1 rounded-md border font-medium ${c.total && c.done >= c.total ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : c.done ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-gray-50 border-gray-200 text-gray-600'}`}>
                      {CHANNEL_ICON[c.channel]} {c.channel === 'email' ? 'Email' : 'WhatsApp'}: {c.done} of {c.total} {c.channel === 'email' ? 'sent' : 'done'}{c.last ? ` · last ${fmtDay(c.last)}` : ''}
                    </span>
                  ))}
                  <button className="btn-secondary text-xs flex items-center gap-1.5" disabled={!zohoIds.length || busy}
                    title="After you send this touch's email in Zoho: tick it for the same selected rows you exported"
                    onClick={() => markTouch(zohoIds, listTouch.key, 'email')}>
                    <CheckCircle2 size={13} /> Mark email sent ({zohoIds.length})
                  </button>
                  <button className="text-xs text-gray-400 underline" disabled={!zohoIds.length || busy}
                    onClick={() => { if (window.confirm(`Remove the "email sent" tick for ${zohoIds.length} selected rows on this touch?`)) undoTouch(zohoIds, listTouch.key, 'email'); }}>
                    undo
                  </button>
                </div>
                {nextUp && (
                  <p className="text-xs text-gray-500 mb-3">
                    {nextUp === 'done' ? '✓ Every touch is done for this list.'
                      : <>Next up: <strong>{nextUp.i + 1}. {nextUp.t.label}</strong>{nextUp.t.day != null ? ` (${dayLabel(nextUp.t.day)})` : ''} — {nextUp.pr.map(c => `${c.channel === 'email' ? 'email' : 'WhatsApp'} ${c.done}/${c.total}`).join(' · ')}</>}
                  </p>
                )}
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
                  {listTouch.whatsapp ? (
                    <div className="text-sm text-gray-700 bg-emerald-50 border border-emerald-100 rounded p-3 whitespace-pre-wrap break-words leading-relaxed">{waPreview(listTouch.whatsapp)}</div>
                  ) : (
                    <div className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded p-3">Card only, no text: send just the image.</div>
                  )}
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    {listTouch.whatsapp && (
                      <button className="btn-secondary text-xs flex items-center gap-1.5" onClick={() => copyRaw(listTouch.whatsapp, 'list-wa')}>
                        <Copy size={13} /> {copied === 'list-wa' ? 'Copied ✓' : 'Copy WhatsApp'}
                      </button>
                    )}
                    {listTouch.waImage && (
                      <>
                        <button className="btn-secondary text-xs flex items-center gap-1.5" onClick={() => saveImage(listTouch.waImage)}>
                          <Download size={13} /> Download image
                        </button>
                        {!campaignRow && canShareImage && (
                          <button className="btn-secondary text-xs flex items-center gap-1.5" style={{ color: '#128C7E' }}
                            onClick={() => shareTextAndImage(listTouch.whatsapp)}>
                            <MessageSquare size={13} /> Share text + image
                          </button>
                        )}
                        <a className="text-xs text-gray-400 underline" href={listTouch.waImage} target="_blank" rel="noopener noreferrer">view ↗</a>
                      </>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mt-2">
                    To send it to one contact with their company name filled in, open <strong>View</strong> on their row → <strong>WhatsApp this</strong> (that ticks the row as done).
                    {listTouch.waImage && <> WhatsApp links can&apos;t carry a picture: download the image and attach it in the chat — or on a phone use <strong>Share text + image</strong> and pick the contact in WhatsApp.</>}
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
            <div className="flex items-center gap-1.5">
              <select className="input" value={bulkStatus} onChange={e => setBulkStatus(e.target.value)}>
                <option value="">Set status…</option>
                {STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
              <button className="btn-secondary flex items-center gap-1.5" disabled={!bulkStatus || !bulkIds.length || busy}
                title={bulkStatus && bulkIds.length < selectedVisible.length ? 'Skip / Not interested rows are left alone — set them one by one, or use “New” to bring them back' : ''}
                onClick={() => markStatus(bulkStatus)}>
                <Star size={16} /> Apply to {bulkStatus ? bulkIds.length : selectedVisible.length} selected
              </button>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-2">
            One list for both Zoho campaigns: every selected contact with an email, and their mobile (with country code) in the <strong>Mobile</strong> column for SMS
            {zohoIds.length > 0 && <> — {zohoWithMobile} of {zohoIds.length} have a mobile</>}.
            {mobileOnlySel > 0 && <> {mobileOnlySel} selected {mobileOnlySel === 1 ? 'row has' : 'rows have'} a mobile but no email — Zoho can&apos;t import a contact without an email, so reach {mobileOnlySel === 1 ? 'it' : 'them'} on WhatsApp from the row.</>}
            {' '}Only the rows matching the active filters export (the filename records the slice); new rows move to “In Zoho list”.
            {' '}After you send a touch in Zoho, keep the same rows selected and press <strong>Mark email sent</strong> on that touch.
            {' '}“Not interested” and “Skip” never export.
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

            {/* Status (with a note) + everything done for this contact */}
            <div className="border border-gray-200 rounded-md p-3 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-gray-600">Status</span>
                <select className="input text-sm" value={rowStatus} onChange={e => setRowStatus(e.target.value)}>
                  {STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
                <input className="input text-sm flex-1 min-w-[12rem]" value={rowNote} onChange={e => setRowNote(e.target.value)}
                  placeholder="Note (optional) — e.g. wants a quote for 2 kW, call Monday" />
                <button className="btn-primary text-xs" disabled={busy || (rowStatus === campaignRow.status && !rowNote.trim())}
                  onClick={async () => { await changeStatus(campaignRow.id, rowStatus, rowNote.trim()); setRowNote(''); }}>
                  Save
                </button>
              </div>
              {historyItems.length > 0 ? (
                <details className="text-xs text-gray-600" open={historyItems.length <= 4}>
                  <summary className="cursor-pointer font-medium text-gray-700">History · {historyItems.length}</summary>
                  <ul className="mt-1 space-y-0.5">
                    {historyItems.map((h, i) => (
                      <li key={i}>
                        <span className="text-gray-400">{fmtDay(h.at)}</span> · {h.text}
                        {h.by && <span className="text-gray-400"> · {h.by}</span>}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : (
                <p className="text-xs text-gray-400">{history ? 'Nothing logged yet for this contact.' : 'Loading history…'}</p>
              )}
            </div>

            {rowCampaign && rowTouch && hasCampaign(campaignRow) ? (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {rowCampaign.touches.map((t, i) => (
                    <button key={t.key}
                      className={`text-xs px-2.5 py-1.5 rounded-md border ${seqTab === i ? 'bg-brand-700 text-white border-brand-700' : 'bg-white text-gray-600'}`}
                      onClick={() => setSeqTab(i)}>
                      {i + 1}. {t.label}{t.day != null ? ` · ${dayLabel(t.day)}` : ''}
                      {tickFor(campaignRow.id, t.key, 'email') && ' ✉✓'}
                      {tickFor(campaignRow.id, t.key, 'whatsapp') && ' 💬✓'}
                    </button>
                  ))}
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <Mail size={15} className="text-brand-700" />
                    <h4 className="text-sm font-semibold">{rowTouch.label} email</h4>
                    {rowTouch.day != null && <span className="text-xs text-gray-400">send {dayLabel(rowTouch.day)}</span>}
                  </div>
                  {/* This touch for this contact: tick it per channel (or undo a wrong tick) */}
                  <div className="flex flex-wrap items-center gap-2 mb-2 text-xs">
                    {['email', 'whatsapp'].map(ch => {
                      const t = tickFor(campaignRow.id, rowTouch.key, ch);
                      const name = ch === 'email' ? 'Email sent' : 'WhatsApp done';
                      if (t) return (
                        <span key={ch} className="px-2 py-1 rounded-md bg-emerald-50 border border-emerald-200 text-emerald-800">
                          {CHANNEL_ICON[ch]} {name} {fmtDay(t.done_at)}{t.done_by ? ` · ${t.done_by}` : ''}
                          <button className="ml-1.5 text-gray-400 underline" disabled={busy}
                            onClick={() => undoTouch([campaignRow.id], rowTouch.key, ch)}>undo</button>
                        </span>
                      );
                      return reach(campaignRow, ch) ? (
                        <button key={ch} className="px-2 py-1 rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50" disabled={busy}
                          onClick={() => markTouch([campaignRow.id], rowTouch.key, ch)}>
                          {CHANNEL_ICON[ch]} Mark {ch === 'email' ? 'email sent' : 'WhatsApp done'}
                        </button>
                      ) : null;
                    })}
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
                    {waLinkFor(campaignRow.phone, rowTouch.whatsapp, campaignRow.country) && (
                      <a className="btn-secondary text-xs flex items-center gap-1.5" style={{ color: '#128C7E' }}
                        href={waLinkFor(campaignRow.phone, rowTouch.whatsapp, campaignRow.country)} target="_blank" rel="noopener noreferrer"
                        onClick={() => { if (!tickFor(campaignRow.id, rowTouch.key, 'whatsapp')) markTouch([campaignRow.id], rowTouch.key, 'whatsapp'); }}>
                        <MessageSquare size={13} /> WhatsApp this
                      </a>
                    )}
                    {rowCampaign?.zalo && zaloLinkFor(campaignRow.phone, campaignRow.country) && (
                      <a className="btn-secondary text-xs flex items-center gap-1.5" style={{ color: '#0068FF' }}
                        href={zaloLinkFor(campaignRow.phone, campaignRow.country)} target="_blank" rel="noopener noreferrer"
                        title="Copies the message, opens their Zalo chat — paste it there. Counts as this touch's chat message."
                        onClick={() => {
                          if (rowTouch.whatsapp) copyRaw(rowTouch.whatsapp, 'seq-zalo');
                          if (!tickFor(campaignRow.id, rowTouch.key, 'whatsapp')) markTouch([campaignRow.id], rowTouch.key, 'whatsapp');
                        }}>
                        <MessageSquare size={13} /> {copied === 'seq-zalo' ? 'Copied — paste in Zalo' : 'Zalo this'}
                      </a>
                    )}
                    {rowTouch.whatsapp && (
                      <button className="btn-secondary text-xs flex items-center gap-1.5" onClick={() => copyRaw(rowTouch.whatsapp, 'seq-wa')}>
                        <Copy size={13} /> {copied === 'seq-wa' ? 'Copied ✓' : 'Copy WhatsApp'}
                      </button>
                    )}
                    {rowTouch.waImage && (
                      <>
                        <button className="btn-secondary text-xs flex items-center gap-1.5" onClick={() => saveImage(rowTouch.waImage)}>
                          <Download size={13} /> Download image
                        </button>
                        {canShareImage && (
                          <button className="btn-secondary text-xs flex items-center gap-1.5" style={{ color: '#128C7E' }}
                            onClick={() => shareTextAndImage(rowTouch.whatsapp, () => {
                              if (!tickFor(campaignRow.id, rowTouch.key, 'whatsapp')) markTouch([campaignRow.id], rowTouch.key, 'whatsapp');
                            })}>
                            <MessageSquare size={13} /> Share text + image
                          </button>
                        )}
                      </>
                    )}
                  </div>
                  {rowTouch.waImage && (
                    <p className="text-xs text-gray-400 mt-1.5">
                      WhatsApp links carry only text: after <strong>WhatsApp this</strong> opens the chat, attach the downloaded image.
                      {canShareImage ? <> Or use <strong>Share text + image</strong> and pick the contact in WhatsApp (the text is copied too, in case it only takes the picture).</> : ''}
                    </p>
                  )}
                  {rowTouch.whatsapp ? (
                    <div className="mt-2 text-sm text-gray-700 bg-emerald-50 border border-emerald-100 rounded p-3 whitespace-pre-wrap break-words leading-relaxed">{waPreview(rowTouch.whatsapp)}</div>
                  ) : (
                    <div className="mt-2 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded p-3">Card only, no text: WhatsApp this opens the chat, then attach the downloaded card.</div>
                  )}
                </div>
                {rowCalls.length > 0 && (
                  <div className="pt-2 border-t border-gray-100">
                    <div className="flex items-center gap-2 mb-2">
                      <Phone size={15} className="text-brand-700" />
                      <h4 className="text-sm font-semibold">Call schedule</h4>
                    </div>
                    <div className="space-y-2">
                      {rowCalls.map((c, i) => {
                        const key = `call${i + 1}`;
                        const done = tickFor(campaignRow.id, key, 'call');
                        return (
                          <details key={i} className="border border-gray-200 rounded-md">
                            <summary className="cursor-pointer px-3 py-2 text-sm font-medium flex items-center justify-between">
                              <span>
                                {c.label}{c.day != null ? ` — ${dayLabel(c.day)}` : ''}
                                {done && <span className="ml-2 text-xs font-normal text-emerald-700">☎✓ {fmtDay(done.done_at)}</span>}
                              </span>
                              <span role="button" tabIndex={0} className="text-xs text-brand-700"
                                onClick={(e) => { e.preventDefault(); copyRaw(c.script, 'call-' + i); }}>
                                {copied === 'call-' + i ? 'Copied ✓' : 'Copy'}
                              </span>
                            </summary>
                            <div className="px-3 pb-3 text-xs whitespace-pre-wrap text-gray-700 bg-amber-50">{c.script}</div>
                            <div className="px-3 py-2 flex flex-wrap items-center gap-2 text-xs border-t border-gray-100">
                              {done ? (
                                <>
                                  <span className="text-emerald-700">☎ Done {fmtDay(done.done_at)}{done.done_by ? ` · ${done.done_by}` : ''}{done.note ? ` — ${done.note}` : ''}</span>
                                  <button className="text-gray-400 underline" disabled={busy}
                                    onClick={() => undoTouch([campaignRow.id], key, 'call')}>undo</button>
                                </>
                              ) : reach(campaignRow, 'call') ? (
                                <>
                                  <input className="input text-xs flex-1 min-w-[10rem]" placeholder="How did it go? (optional)"
                                    value={callNote[key] || ''} onChange={e => setCallNote(n => ({ ...n, [key]: e.target.value }))} />
                                  <button className="btn-secondary text-xs" disabled={busy}
                                    onClick={async () => { await markTouch([campaignRow.id], key, 'call', (callNote[key] || '').trim()); setCallNote(n => ({ ...n, [key]: '' })); }}>
                                    ☎ Mark call done
                                  </button>
                                </>
                              ) : <span className="text-gray-400">No phone number on this contact.</span>}
                            </div>
                          </details>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-gray-400">
                No campaign for this contact{NO_CAMPAIGN.has(campaignRow.status) ? ` — marked “${statusLabel(campaignRow.status)}”` : ''}.
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
