import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import { ArrowLeft, RefreshCw, CheckCircle2, Linkedin, Instagram, Youtube, MessageSquare, ExternalLink, Clock, AlertTriangle, FileText } from 'lucide-react';

// Social plan (owner, 13 Nov 2026): each week's LinkedIn / Instagram / YouTube posts as the social agent will
// publish them. The owner approves a week here; the agent then schedules exactly this content without asking
// again. The approval is pinned to the content (plan_hash): if the agent changes anything, the week needs a fresh OK.
const fmtDate = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtAt = d => (d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const RESULT_CLS = { scheduled: 'bg-sky-100 text-sky-800', live: 'bg-emerald-100 text-emerald-800', failed: 'bg-red-100 text-red-700', skipped: 'bg-gray-100 text-gray-600' };

function Result({ r }) {
  if (!r || !r.status || r.status === 'planned' || r.status === 'n/a' || /waiting|needs/.test(r.status)) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${RESULT_CLS[r.status] || 'bg-gray-100 text-gray-600'}`}>
        {r.status === 'scheduled' ? 'Scheduled' : r.status === 'live' ? 'Live' : r.status === 'skipped' ? 'Skipped' : r.status}
      </span>
      {r.url && <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-xs text-brand-700 underline flex items-center gap-1"><ExternalLink size={11} /> open</a>}
      {r.note && <span className="text-xs text-gray-500">{r.note}</span>}
    </div>
  );
}

const Caption = ({ text }) => (
  <pre className="mt-2 text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded p-3 whitespace-pre-wrap break-words font-sans leading-relaxed">{text}</pre>
);
const Video = ({ src, poster }) => (
  <video className="w-full max-h-80 rounded-md border border-gray-200 bg-black object-contain" src={src} poster={poster || undefined} controls preload="none" playsInline />
);

function Slide({ s }) {
  // The agent builds the carousel from the flyer: "fit" = whole flyer, "top"/"bottom" = readable 4:5 zooms.
  const pos = s.crop === 'top' ? 'object-top' : s.crop === 'bottom' ? 'object-bottom' : '';
  return (
    <div className="aspect-[4/5] bg-gray-800 rounded overflow-hidden border border-gray-200">
      <img src={s.url} alt="" loading="lazy" className={`w-full h-full ${s.crop === 'fit' ? 'object-contain' : `object-cover ${pos}`}`} />
    </div>
  );
}

function Panel({ icon: Icon, name, time, children, result }) {
  return (
    <div className="border border-gray-200 rounded-lg p-3 min-w-0">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="font-semibold text-gray-900 flex items-center gap-1.5"><Icon size={16} className="text-brand-700" /> {name}</span>
        {time && <span className="text-xs text-gray-500 flex items-center gap-1"><Clock size={12} /> {time} IST</span>}
      </div>
      {children}
      <Result r={result} />
    </div>
  );
}

export default function SocialPlan() {
  const { user } = useAuthStore();
  const isOwner = user?.role === 'owner';
  const [weeks, setWeeks] = useState([]);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [notes, setNotes] = useState({});
  const [askFor, setAskFor] = useState('');
  const [showPast, setShowPast] = useState(false);
  const load = () => api.get('/prospects/social').then(r => setWeeks(r.data)).catch(() => setErr('Could not load the plan.'));
  useEffect(() => { load(); }, []);

  const today = new Date().toISOString().slice(0, 10);
  const list = useMemo(() => weeks.filter(w => showPast || w.post_date >= today), [weeks, showPast, today]);
  const isOut = w => Object.values(w.results || {}).some(r => r && (r.status === 'scheduled' || r.status === 'live'));
  const waiting = weeks.filter(w => w.post_date >= today && w.status !== 'approved' && !isOut(w)).length;

  const act = async (w, path, body) => {
    setBusy(w.week_key + path); setErr('');
    try { await api.post(`/prospects/social/${w.week_key}/${path}`, body || {}); setAskFor(''); await load(); }
    catch (e) { setErr(e.response?.data?.error || 'Something went wrong.'); await load(); }
    finally { setBusy(''); }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <Link to="/prospecting" className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-1"><ArrowLeft size={12} /> Prospecting</Link>
          <h1 className="text-2xl font-bold text-gray-900">Social plan</h1>
          <p className="text-xs text-gray-500 mt-1 max-w-3xl">
            Each week's LinkedIn, Instagram and YouTube posts, exactly as the social agent will publish them.
            Approve a week and the agent schedules it at these times without asking again. If the agent has to change
            anything after you approve, the week comes back here for a fresh OK.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/prospecting/linkedin" className="btn-secondary text-sm flex items-center gap-1.5"><Linkedin size={15} /> LinkedIn calendar</Link>
          <button className="btn-secondary flex items-center gap-1.5 text-sm" onClick={load}><RefreshCw size={15} /> Refresh</button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="card px-4 py-3"><div className="text-2xl font-bold text-amber-600">{waiting}</div><div className="text-xs text-gray-500">Upcoming weeks waiting for approval</div></div>
        <label className="text-xs text-gray-600 flex items-center gap-1.5"><input type="checkbox" checked={showPast} onChange={e => setShowPast(e.target.checked)} /> Show past weeks</label>
        {!isOwner && <span className="text-xs text-gray-500">Only the owner can approve a week.</span>}
      </div>
      {err && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{err}</div>}
      {!list.length && <div className="card p-6 text-sm text-gray-500">No weeks planned yet. The social agent adds them here.</div>}

      <div className="space-y-5">
        {list.map(w => {
          const p = w.plan || {};
          const li = p.linkedin || {}, ig = p.instagram || {}, yt = p.youtube || {};
          const res = w.results || {};
          const approved = w.status === 'approved' && w.approved_hash === w.plan_hash;
          // Weeks already out (or scheduled) before this page existed were approved in chat.
          const alreadyOut = !approved && Object.values(res).some(r => r && (r.status === 'scheduled' || r.status === 'live'));
          return (
            <div key={w.week_key} className={`card p-4 ${approved ? 'ring-1 ring-emerald-300' : w.status === 'changes_requested' ? 'ring-1 ring-red-300' : 'ring-1 ring-amber-200'}`}>
              <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-lg font-bold text-gray-900">{fmtDate(w.post_date)}</span>
                    <span className="text-sm text-gray-500">· {w.topic}</span>
                  </div>
                  <div className="mt-1">
                    {approved ? (
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 inline-flex items-center gap-1">
                        <CheckCircle2 size={12} /> Approved{w.approved_by ? ` by ${w.approved_by}` : ''} · {fmtAt(w.approved_at)} · the agent will schedule it
                      </span>
                    ) : alreadyOut ? (
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-sky-100 text-sky-800 inline-flex items-center gap-1">
                        <CheckCircle2 size={12} /> Already scheduled (approved in chat)
                      </span>
                    ) : w.status === 'changes_requested' ? (
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700 inline-flex items-center gap-1">
                        <AlertTriangle size={12} /> Changes asked{w.change_by ? ` by ${w.change_by}` : ''}: “{w.change_note}”
                      </span>
                    ) : (
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">Waiting for approval</span>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {isOwner && !approved && !alreadyOut && (
                    <button className="btn-primary text-sm flex items-center gap-1.5" disabled={!!busy}
                      onClick={() => act(w, 'approve', { hash: w.plan_hash })}>
                      <CheckCircle2 size={15} /> {busy === w.week_key + 'approve' ? 'Approving…' : 'Approve this week'}
                    </button>
                  )}
                  {isOwner && approved && (
                    <button className="btn-secondary text-xs" disabled={!!busy} onClick={() => act(w, 'unapprove')}>Withdraw approval</button>
                  )}
                  <button className="btn-secondary text-sm flex items-center gap-1.5" onClick={() => setAskFor(askFor === w.week_key ? '' : w.week_key)}>
                    <MessageSquare size={15} /> Ask for changes
                  </button>
                </div>
              </div>

              {askFor === w.week_key && (
                <div className="mb-3 flex flex-wrap gap-2 items-start">
                  <textarea className="input text-sm flex-1 min-w-[260px]" rows={2} placeholder="What should change? e.g. use a fresh photo, shorter caption, post on Thursday"
                    value={notes[w.week_key] || ''} onChange={e => setNotes(n => ({ ...n, [w.week_key]: e.target.value }))} />
                  <button className="btn-primary text-sm" disabled={!!busy || !(notes[w.week_key] || '').trim()}
                    onClick={() => act(w, 'changes', { note: notes[w.week_key] })}>Send to the agent</button>
                </div>
              )}
              {p.notes && <div className="mb-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">{p.notes}</div>}

              <div className="grid md:grid-cols-3 gap-3">
                <Panel icon={Linkedin} name="LinkedIn" time={li.time_ist} result={res.linkedin}>
                  {li.media_type === 'video' && <Video src={li.media_url} poster={li.poster_url} />}
                  {li.media_type === 'image' && <img src={li.media_url} alt="" className="w-full rounded-md border border-gray-200" />}
                  {li.media_type === 'document' && (
                    <a href={li.media_url} target="_blank" rel="noopener noreferrer" className="btn-secondary text-xs inline-flex items-center gap-1.5">
                      <FileText size={13} /> Open the PDF{li.doc_title ? ` · “${li.doc_title}”` : ''}
                    </a>
                  )}
                  <Caption text={li.caption} />
                  {li.first_comment && <pre className="mt-2 text-sm text-gray-700 bg-amber-50 border border-amber-200 rounded p-3 whitespace-pre-wrap break-words font-sans"><span className="text-xs font-medium text-amber-800">First comment: </span>{li.first_comment}</pre>}
                </Panel>

                <Panel icon={Instagram} name={`Instagram${ig.account ? ` · @${ig.account}` : ''}`} time={ig.time_ist} result={res.instagram}>
                  {!ig.ready && <div className="mb-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">Not posted yet: link the Instagram account to a Facebook Page so posts can be scheduled.</div>}
                  {ig.format === 'reel' && <Video src={ig.video_url} poster={ig.poster_url} />}
                  {ig.format === 'image' && <img src={ig.image_url} alt="" className="w-full rounded-md border border-gray-200" />}
                  {ig.format === 'carousel' && (
                    <>
                      <div className="grid grid-cols-3 gap-1.5">{(ig.slides || []).map((s, i) => <Slide key={i} s={s} />)}</div>
                      <div className="text-xs text-gray-500 mt-1">Carousel · {(ig.slides || []).length} slides</div>
                    </>
                  )}
                  <Caption text={ig.caption} />
                </Panel>

                <Panel icon={Youtube} name="YouTube Short" time={yt.format === 'short' ? yt.time_ist : null} result={res.youtube}>
                  {yt.format === 'short' ? (
                    <>
                      <Video src={yt.media_url} poster={yt.poster_url} />
                      <div className="mt-2 text-sm font-semibold text-gray-900">{yt.title}</div>
                      <Caption text={yt.description} />
                      {yt.tags?.length > 0 && <div className="mt-1 text-xs text-gray-500">Tags: {yt.tags.join(', ')}</div>}
                    </>
                  ) : <div className="text-sm text-gray-500">No Short this week (no video).</div>}
                </Panel>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
