import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../lib/api';
import { LINKEDIN_POSTS, KIND_LABEL, KIND_CLS } from './linkedinCampaign';
import { ArrowLeft, Copy, Download, CheckCircle2, Linkedin, RefreshCw, ExternalLink } from 'lucide-react';

// LinkedIn calendar (owner, 26 Oct 2026): the weekly posts with their file, caption and a "posted" tick.
// Posts are defined in linkedinCampaign.js; ticks live in linkedin_posts (server /prospects/linkedin).
const fmtDate = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtAt = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export default function LinkedInCalendar() {
  const [done, setDone] = useState({});          // post key → { posted_at, posted_by, url }
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');
  const [urls, setUrls] = useState({});          // optional LinkedIn post link typed before ticking
  const load = () => api.get('/prospects/linkedin')
    .then(r => setDone(Object.fromEntries(r.data.map(x => [x.post_key, x]))))
    .catch(() => {});
  useEffect(() => { load(); }, []);

  const posts = useMemo(() => [...LINKEDIN_POSTS].sort((a, b) => a.date.localeCompare(b.date)), []);
  const today = new Date().toISOString().slice(0, 10);
  const nextUp = posts.find(p => !done[p.key]);
  const postedCount = posts.filter(p => done[p.key]).length;

  const copy = async (text, key) => {
    try { await navigator.clipboard.writeText(text || ''); setCopied(key); setTimeout(() => setCopied(''), 2000); }
    catch { /* clipboard unavailable — the text can be selected by hand */ }
  };
  const mark = async key => {
    setBusy(true);
    try { await api.post(`/prospects/linkedin/${key}`, { url: (urls[key] || '').trim() || undefined }); await load(); }
    finally { setBusy(false); }
  };
  const undo = async key => {
    setBusy(true);
    try { await api.delete(`/prospects/linkedin/${key}`); await load(); }
    finally { setBusy(false); }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <Link to="/prospecting" className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-1"><ArrowLeft size={12} /> Prospecting</Link>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Linkedin size={22} className="text-brand-700" /> LinkedIn calendar
          </h1>
          <p className="text-xs text-gray-500 mt-1">One post every Wednesday, 10:30 am · 28 Oct – 30 Dec 2026. Download the file, copy the caption, post, then tick it here.</p>
        </div>
        <button className="btn-secondary flex items-center gap-1.5 text-sm" onClick={load}><RefreshCw size={15} /> Refresh</button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-5">
        <div className="card px-4 py-3"><div className="text-2xl font-bold text-brand-700">{postedCount} / {posts.length}</div><div className="text-xs text-gray-500">Posted</div></div>
        <div className="card px-4 py-3 col-span-2">
          {nextUp ? (
            <>
              <div className="text-sm font-semibold text-gray-900">Next up: {fmtDate(nextUp.date)} · {nextUp.topic}</div>
              <div className="text-xs text-gray-500 mt-1">{nextUp.date < today ? 'This one is overdue.' : nextUp.how}</div>
            </>
          ) : <div className="text-sm font-semibold text-emerald-700">✓ Every planned post is out.</div>}
        </div>
      </div>

      <div className="space-y-4">
        {posts.map(p => {
          const d = done[p.key];
          const overdue = !d && p.date < today;
          const isNext = nextUp && nextUp.key === p.key;
          return (
            <div key={p.key} className={`card p-4 flex gap-4 ${isNext ? 'ring-2 ring-brand-500' : ''} ${d ? 'opacity-90' : ''}`}>
              <a href={p.file} download className="flex-none" title="Download the file">
                <img src={p.poster} alt="" className="w-24 h-30 object-cover rounded-md border border-gray-200" style={{ height: 120 }} />
              </a>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span className="font-semibold text-gray-900">{fmtDate(p.date)}</span>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${KIND_CLS[p.kind] || 'bg-gray-100 text-gray-600'}`}>{KIND_LABEL[p.kind] || p.kind}{p.dur ? ` · ${p.dur}` : ''}</span>
                  {d ? (
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 flex items-center gap-1">
                      <CheckCircle2 size={12} /> Posted {fmtAt(d.posted_at)}{d.posted_by ? ` · ${d.posted_by}` : ''}
                    </span>
                  ) : overdue ? <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">Overdue</span>
                    : isNext ? <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-brand-50 text-brand-700">Next up</span> : null}
                  {d?.url && <a href={d.url} target="_blank" rel="noopener noreferrer" className="text-xs text-brand-700 underline flex items-center gap-1"><ExternalLink size={11} /> open post</a>}
                </div>
                <h3 className="text-base font-semibold text-gray-900">{p.topic}</h3>
                <p className="text-xs text-gray-500 mb-2">{p.how}</p>
                <details className="mb-2">
                  <summary className="cursor-pointer text-xs font-medium text-gray-700">Caption</summary>
                  <pre className="mt-1 text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded p-3 whitespace-pre-wrap break-words font-sans leading-relaxed">{p.caption}</pre>
                  {p.comment && <pre className="mt-2 text-sm text-gray-700 bg-amber-50 border border-amber-200 rounded p-3 whitespace-pre-wrap break-words font-sans"><span className="text-xs font-medium text-amber-800">First comment: </span>{p.comment}</pre>}
                </details>
                <div className="flex flex-wrap items-center gap-2">
                  <a className="btn-secondary text-xs flex items-center gap-1.5" href={p.file} download><Download size={13} /> Download file</a>
                  <button className="btn-secondary text-xs flex items-center gap-1.5" onClick={() => copy(p.caption, p.key)}>
                    <Copy size={13} /> {copied === p.key ? 'Copied ✓' : 'Copy caption'}
                  </button>
                  {p.comment && (
                    <button className="btn-secondary text-xs flex items-center gap-1.5" onClick={() => copy(p.comment, p.key + 'c')}>
                      <Copy size={13} /> {copied === p.key + 'c' ? 'Copied ✓' : 'Copy first comment'}
                    </button>
                  )}
                  {d ? (
                    <button className="text-xs text-gray-400 underline" disabled={busy} onClick={() => undo(p.key)}>undo posted</button>
                  ) : (
                    <>
                      <input className="input text-xs" style={{ width: 240 }} placeholder="Link to the post (optional)"
                        value={urls[p.key] || ''} onChange={e => setUrls(u => ({ ...u, [p.key]: e.target.value }))} />
                      <button className="btn-primary text-xs flex items-center gap-1.5" disabled={busy} onClick={() => mark(p.key)}>
                        <CheckCircle2 size={13} /> Mark posted
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-gray-400 mt-5">
        The same files are on the Mac in <strong>Desktop › PHE Campaign Content › LinkedIn</strong>, by date. After posting from the company page, repost from your own profile and Mitesh’s.
      </p>
    </div>
  );
}
