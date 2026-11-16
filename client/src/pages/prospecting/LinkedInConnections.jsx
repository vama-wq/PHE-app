import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../lib/api';
import {
  ArrowLeft, RefreshCw, Linkedin, Copy, Check, ExternalLink, UserPlus, HeartHandshake, Users, Lightbulb, List,
  Star, AlertTriangle, Download, Search, X, Undo2, Share2,
} from 'lucide-react';

// LinkedIn connections (owner, 16 Nov 2026): the daily connection work in one page, filled every evening by the
// LinkedIn agent. She does every LinkedIn action herself (Connect, thank-you notes, joining groups, posting); this
// page tells her what to do today, keeps the texts one click from her clipboard, and keeps her ticks.
const fmtDay = d => (d ? new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
const fmtAt = d => (d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const AREA = { kitchen: 'Commercial kitchen & HoReCa', food: 'Food & packaging machinery', pharma: 'Pharma & lab equipment', industrial: 'Industrial heating & boilers', all: 'All groups' };
const KIND = { tip: 'Useful tip', flyer: 'Flyer', question: 'Question', invite: 'Expo invite', photo: 'Product photo' };

function CopyBtn({ text, label = 'Copy', big }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text || ''); }
    catch { const t = document.createElement('textarea'); t.value = text || ''; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); }
    setDone(true); setTimeout(() => setDone(false), 1800);
  };
  return (
    <button type="button" onClick={copy} disabled={!text}
      className={`${big ? 'btn-primary' : 'btn-secondary'} text-xs flex items-center gap-1 shrink-0 ${done ? '!bg-emerald-600 !text-white' : ''}`}>
      {done ? <Check size={13} /> : <Copy size={13} />} {done ? 'Copied' : label}
    </button>
  );
}

const TextBox = ({ text }) => (
  <pre className="text-sm text-gray-800 bg-gray-50 border border-gray-200 rounded p-2.5 whitespace-pre-wrap break-words font-sans leading-relaxed">{text}</pre>
);

function Who({ p }) {
  return (
    <div className="min-w-0">
      <a href={p.profile_url} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand-700 hover:underline inline-flex items-center gap-1">
        {p.person} <ExternalLink size={12} />
      </a>
      <div className="text-xs text-gray-600 truncate">{[p.title, p.company].filter(Boolean).join(' · ')}</div>
      <div className="text-[11px] text-gray-400">{[p.list_name, p.place].filter(Boolean).join(' · ')}</div>
    </div>
  );
}

function Tab({ id, cur, set, icon: Icon, label, count, tone = 'brand' }) {
  const on = cur === id;
  return (
    <button onClick={() => set(id)}
      className={`px-3 py-2 rounded-md text-sm font-medium flex items-center gap-1.5 border ${on ? 'bg-brand-700 text-white border-brand-700' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'}`}>
      <Icon size={15} /> {label}
      {count != null && <span className={`text-[11px] px-1.5 rounded-full ${on ? 'bg-white/20' : tone === 'amber' ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-600'}`}>{count}</span>}
    </button>
  );
}

export default function LinkedInConnections() {
  const [d, setD] = useState(null);
  const [tab, setTab] = useState('send');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [all, setAll] = useState(null);
  const [q, setQ] = useState('');
  const [filt, setFilt] = useState('unsent');

  const load = () => api.get('/linkedin').then(r => setD(r.data)).catch(() => setErr('Could not load the LinkedIn page.'));
  useEffect(() => { load(); }, []);
  useEffect(() => { if (tab === 'all' && !all) api.get('/linkedin/people').then(r => setAll(r.data)).catch(() => {}); }, [tab, all]);

  const post = async (key, url, body) => {
    setBusy(key); setErr('');
    try { await api.post(url, body || {}); await load(); if (all) setAll((await api.get('/linkedin/people')).data); }
    catch (e) { setErr(e.response?.data?.error || 'Something went wrong.'); }
    finally { setBusy(''); }
  };
  const skip = p => {
    const reason = window.prompt(`Skip ${p.person}? Say why (optional):`, '');
    if (reason === null) return;
    post('skip' + p.id, `/linkedin/people/${p.id}/skip`, { reason });
  };

  const people = useMemo(() => {
    if (!all) return [];
    const s = q.trim().toLowerCase();
    return all.filter(p => {
      const st = p.skipped_at ? 'skipped' : p.thanked_at ? 'thanked' : p.accepted_on ? 'accepted' : p.sent_at ? 'pending' : 'unsent';
      if (filt !== 'any' && st !== filt) return false;
      return !s || [p.person, p.company, p.list_name, p.title].some(v => String(v || '').toLowerCase().includes(s));
    });
  }, [all, q, filt]);

  if (!d) return <div className="p-6 text-sm text-gray-500">{err || 'Loading…'}</div>;
  const st = d.stats || {};
  const searches = d.groups.filter(g => g.group_key.startsWith('search-'));
  const groups = d.groups.filter(g => !g.group_key.startsWith('search-'));
  const readyPosts = d.posts.filter(p => p.status === 'ready');
  const openIdeas = d.ideas.filter(i => !i.done_at);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <Link to="/prospecting" className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-1"><ArrowLeft size={12} /> Prospecting</Link>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2"><Linkedin size={22} className="text-brand-700" /> LinkedIn connections</h1>
          <p className="text-xs text-gray-500 mt-1 max-w-3xl">
            Your LinkedIn work for today. The LinkedIn agent updates this page every evening: who accepted, new people to invite,
            groups and posts, and ideas. It only reads LinkedIn. You press Connect, send the notes and post yourself.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/prospecting/linkedin" className="btn-secondary text-sm flex items-center gap-1.5"><Linkedin size={15} /> LinkedIn calendar</Link>
          <Link to="/prospecting/social" className="btn-secondary text-sm flex items-center gap-1.5"><Share2 size={15} /> Social plan</Link>
          <button className="btn-secondary flex items-center gap-1.5 text-sm" onClick={load}><RefreshCw size={15} /> Refresh</button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 mb-4">
        {[
          ['Sent today', `${st.sent_today}/${d.daily}`, 'text-brand-700'],
          ['Sent this week', `${st.sent_7d}/${d.weeklyCap}`, st.sent_7d >= d.weeklyCap ? 'text-red-600' : 'text-gray-900'],
          ['Pending', st.pending, 'text-gray-900'],
          ['Accepted', st.accepted, 'text-emerald-700'],
          ['Thanked', st.thanked, 'text-emerald-700'],
          ['Left to invite', st.unsent_left, st.unsent_left < 40 ? 'text-amber-600' : 'text-gray-900'],
        ].map(([l, v, c]) => (
          <div key={l} className="card px-3 py-2"><div className={`text-xl font-bold ${c}`}>{v}</div><div className="text-[11px] text-gray-500">{l}</div></div>
        ))}
      </div>
      <div className="text-[11px] text-gray-500 mb-3">
        {d.lastCheck ? <>Last LinkedIn check: {fmtAt(d.lastCheck.checked_at)}{d.lastCheck.note ? ` · ${d.lastCheck.note}` : ''}</> : 'The LinkedIn agent has not checked yet.'}
        {st.added_today ? ` · ${st.added_today} new people added today` : ''}
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <Tab id="send" cur={tab} set={setTab} icon={UserPlus} label="Send today" count={d.send.length} />
        <Tab id="thank" cur={tab} set={setTab} icon={HeartHandshake} label="Thank you" count={d.thank.length} tone={d.thank.length ? 'amber' : ''} />
        <Tab id="groups" cur={tab} set={setTab} icon={Users} label="Groups & posts" count={readyPosts.length} />
        <Tab id="grow" cur={tab} set={setTab} icon={Lightbulb} label="Grow" count={openIdeas.length} />
        <Tab id="all" cur={tab} set={setTab} icon={List} label="All people" count={st.total} />
      </div>
      {err && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{err}</div>}

      {tab === 'send' && (
        <div className="space-y-3">
          <div className="card p-3 text-xs text-gray-700 bg-sky-50 border-sky-200">
            <b>How:</b> open the profile → <b>Connect</b> (if the big button says <b>Follow</b> or <b>Following</b>, click <b>More → Connect</b>)
            → <b>Send without a note</b>. Only people marked <Star size={11} className="inline text-amber-500" /> get the note: your free account
            allows only a few notes a month. Check the button now says <b>Pending</b>, then tick <b>I sent it</b> here.
            {d.room === 0 && <div className="mt-1 text-amber-700 font-medium">That's enough for today ({d.daily} a day, {d.weeklyCap} a week). More tomorrow.</div>}
          </div>
          {d.notFound.length > 0 && (
            <div className="card p-3 border-amber-300 bg-amber-50 text-xs text-amber-900">
              <div className="font-semibold flex items-center gap-1 mb-1"><AlertTriangle size={13} /> Ticked as sent, but LinkedIn doesn't show them pending ({d.notFound.length})</div>
              Probably Follow was clicked instead of Connect, or they ignored it. Put them back in the list to send again:
              <div className="mt-2 flex flex-wrap gap-2">
                {d.notFound.map(p => (
                  <button key={p.id} className="btn-secondary text-xs" disabled={busy === 'nf' + p.id}
                    onClick={() => post('nf' + p.id, `/linkedin/people/${p.id}/sent`, { undo: true })}>
                    <Undo2 size={12} className="inline" /> {p.person} · {p.company}
                  </button>
                ))}
              </div>
            </div>
          )}
          {!d.send.length && d.room > 0 && <div className="card p-6 text-sm text-gray-500">Nobody left to invite today. The agent adds new people every evening.</div>}
          {d.send.map(p => (
            <div key={p.id} className={`card p-3 ${p.use_note ? 'ring-1 ring-amber-300' : ''}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <Who p={p} />
                <div className="flex items-center gap-2">
                  <a href={p.profile_url} target="_blank" rel="noopener noreferrer" className="btn-secondary text-xs flex items-center gap-1"><ExternalLink size={13} /> Open profile</a>
                  <button className="btn-primary text-xs flex items-center gap-1" disabled={busy === 'sent' + p.id}
                    onClick={() => post('sent' + p.id, `/linkedin/people/${p.id}/sent`)}><Check size={13} /> I sent it</button>
                  <button className="btn-secondary text-xs" onClick={() => skip(p)} title="Not worth inviting"><X size={13} /></button>
                </div>
              </div>
              <div className="mt-2 flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] mb-1 font-medium">
                    {p.use_note
                      ? <span className="text-amber-700 inline-flex items-center gap-1"><Star size={12} /> Use a note for this one: click "Add a note" and paste</span>
                      : <span className="text-gray-500">Send without a note. The note is here if you still have notes left this month:</span>}
                  </div>
                  <TextBox text={p.note} />
                </div>
                <CopyBtn text={p.note} label="Copy note" big={p.use_note} />
              </div>
              {p.check_note && <div className="mt-1 text-[11px] text-amber-700">{p.check_note}</div>}
              {p.why && <div className="mt-1 text-[11px] text-gray-400">Why we think it's them: {p.why}</div>}
            </div>
          ))}
          {d.sentToday.length > 0 && (
            <div className="card p-3">
              <div className="text-xs font-semibold text-gray-700 mb-2">Sent today ({d.sentToday.length})</div>
              <div className="flex flex-wrap gap-2">
                {d.sentToday.map(p => (
                  <span key={p.id} className="text-xs bg-emerald-50 border border-emerald-200 rounded px-2 py-1 flex items-center gap-1.5">
                    <Check size={12} className="text-emerald-600" /> {p.person} · {p.company}
                    <button className="text-gray-400 hover:text-gray-700" title="Undo" onClick={() => post('u' + p.id, `/linkedin/people/${p.id}/sent`, { undo: true })}><Undo2 size={12} /></button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'thank' && (
        <div className="space-y-3">
          <div className="card p-3 text-xs text-gray-700 bg-sky-50 border-sky-200">
            These people accepted. Open the profile → <b>Message</b>, paste their message, send, then tick <b>Thank-you sent</b>.
            Each message was written for that person.
          </div>
          {!d.thank.length && <div className="card p-6 text-sm text-gray-500">Nobody waiting for a thank-you. The agent checks who accepted every evening.</div>}
          {d.thank.map(p => (
            <div key={p.id} className="card p-3 ring-1 ring-emerald-200">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <Who p={p} />
                  <div className="text-[11px] text-emerald-700 mt-0.5">Accepted {fmtDay(p.accepted_on)}</div>
                </div>
                <div className="flex items-center gap-2">
                  <a href={p.profile_url} target="_blank" rel="noopener noreferrer" className="btn-secondary text-xs flex items-center gap-1"><ExternalLink size={13} /> Open profile</a>
                  <button className="btn-primary text-xs flex items-center gap-1" disabled={busy === 'th' + p.id}
                    onClick={() => post('th' + p.id, `/linkedin/people/${p.id}/thanked`)}><Check size={13} /> Thank-you sent</button>
                </div>
              </div>
              <div className="mt-2 flex items-start gap-2">
                <div className="flex-1 min-w-0"><TextBox text={p.message || 'Message not written yet: the agent writes it tonight.'} /></div>
                <CopyBtn text={p.message} label="Copy message" big />
              </div>
            </div>
          ))}
          {d.thankedRecent.length > 0 && (
            <div className="text-xs text-gray-500">Thanked recently: {d.thankedRecent.map(p => (
              <span key={p.id} className="mr-3">{p.person} <button className="underline" onClick={() => post('tu' + p.id, `/linkedin/people/${p.id}/thanked`, { undo: true })}>undo</button></span>
            ))}</div>
          )}
        </div>
      )}

      {tab === 'groups' && (
        <div className="space-y-5">
          <div className="card p-3">
            <div className="text-sm font-semibold text-gray-900 mb-1">1 · Find groups to join</div>
            <div className="text-xs text-gray-600 mb-2">
              Each button opens LinkedIn's group search. Join groups with a few thousand members where machine builders,
              purchase heads or engineers post. Skip job-seeker groups. Click <b>Join</b>; some groups need approval.
              The agent sees the groups you joined and writes posts for them.
            </div>
            <div className="flex flex-wrap gap-2">
              {searches.map(g => (
                <a key={g.group_key} href={g.url} target="_blank" rel="noopener noreferrer" className="btn-secondary text-xs flex items-center gap-1" title={g.why || ''}>
                  <Search size={12} /> {g.name.replace(/^Search: /, '')}
                </a>
              ))}
            </div>
          </div>

          <div className="card p-3">
            <div className="text-sm font-semibold text-gray-900 mb-2">2 · Your groups</div>
            {!groups.length && <div className="text-xs text-gray-500">No groups yet. Join a few from the searches above; the agent lists them here tonight.</div>}
            <div className="space-y-2">
              {groups.map(g => (
                <div key={g.group_key} className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 pb-2">
                  <div className="min-w-0">
                    <a href={g.url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-brand-700 hover:underline inline-flex items-center gap-1">{g.name} <ExternalLink size={11} /></a>
                    <div className="text-[11px] text-gray-500">{[AREA[g.area] || g.area, g.region, g.members && `${g.members} members`].filter(Boolean).join(' · ')}</div>
                    {g.why && <div className="text-[11px] text-gray-400">{g.why}</div>}
                    {g.rules && <div className="text-[11px] text-amber-700">Rules: {g.rules}</div>}
                  </div>
                  <div className="flex gap-1">
                    {['suggested', 'requested', 'joined', 'skip'].map(s => (
                      <button key={s} onClick={() => post('g' + g.group_key + s, `/linkedin/groups/${g.group_key}/status`, { status: s })}
                        className={`text-[11px] px-2 py-1 rounded border ${g.status === s ? 'bg-brand-700 text-white border-brand-700' : 'bg-white text-gray-600 border-gray-200'}`}>
                        {s === 'suggested' ? 'To join' : s === 'requested' ? 'Requested' : s === 'joined' ? 'Joined' : 'Skip'}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="text-sm font-semibold text-gray-900 mb-1">3 · Posts for your groups</div>
            <div className="text-xs text-gray-600 mb-2">
              Groups remove pure adverts. Post the useful ones first, one post per group every week or so. Copy the text,
              download the picture if there is one, post it in the group, then tick <b>Posted</b>.
            </div>
            <div className="grid md:grid-cols-2 gap-3">
              {d.posts.map(p => (
                <div key={p.post_key} className={`card p-3 ${p.status === 'posted' ? 'opacity-60' : ''}`}>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="text-sm font-semibold text-gray-900">{p.title}</div>
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 shrink-0">{KIND[p.kind] || p.kind}</span>
                  </div>
                  <div className="text-[11px] text-gray-500 mb-2">For: {AREA[p.area] || p.area}{p.status === 'posted' ? ` · posted ${fmtDay(p.posted_at)}${p.posted_in ? ' in ' + p.posted_in : ''}` : ''}</div>
                  {p.image && (
                    <div className="mb-2">
                      <img src={p.image} alt="" loading="lazy" className="max-h-56 rounded border border-gray-200 object-contain bg-gray-50" />
                      <a href={p.image} download className="text-[11px] text-brand-700 underline inline-flex items-center gap-1 mt-1"><Download size={11} /> Download picture</a>
                    </div>
                  )}
                  <TextBox text={p.body} />
                  <div className="mt-2 flex flex-wrap gap-2">
                    <CopyBtn text={p.body} label="Copy post" big={p.status === 'ready'} />
                    {p.status !== 'posted'
                      ? <button className="btn-secondary text-xs flex items-center gap-1" onClick={() => {
                          const where = window.prompt('Which group did you post it in? (optional)', '');
                          if (where !== null) post('p' + p.post_key, `/linkedin/posts/${p.post_key}/status`, { status: 'posted', posted_in: where });
                        }}><Check size={13} /> Posted</button>
                      : <button className="btn-secondary text-xs" onClick={() => post('p' + p.post_key, `/linkedin/posts/${p.post_key}/status`, { status: 'ready' })}><Undo2 size={12} className="inline" /> Not posted</button>}
                    {p.status === 'ready' && <button className="btn-secondary text-xs" onClick={() => post('p' + p.post_key, `/linkedin/posts/${p.post_key}/status`, { status: 'skip' })}>Skip</button>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 'grow' && (
        <div className="space-y-3">
          <div className="card p-3 text-xs text-gray-700 bg-sky-50 border-sky-200">
            Ideas to grow your network from the people who already accepted. Fresh ideas every evening; tick them off as you do them.
          </div>
          {!d.ideas.length && <div className="card p-6 text-sm text-gray-500">No ideas yet. They come once people accept and you have thanked them.</div>}
          {d.ideas.map(i => (
            <div key={i.idea_key} className={`card p-3 ${i.done_at ? 'opacity-60' : ''}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-gray-900">{i.text}</div>
                  {i.person && (
                    <a href={i.profile_url} target="_blank" rel="noopener noreferrer" className="text-[11px] text-brand-700 hover:underline inline-flex items-center gap-1">
                      {i.person}{i.company ? ` · ${i.company}` : ''} <ExternalLink size={10} />
                    </a>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {i.link && <a href={i.link} target="_blank" rel="noopener noreferrer" className="btn-secondary text-xs flex items-center gap-1"><ExternalLink size={13} /> Open</a>}
                  <button className="btn-secondary text-xs flex items-center gap-1" onClick={() => post('i' + i.idea_key, `/linkedin/ideas/${i.idea_key}/done`, i.done_at ? { undo: true } : {})}>
                    {i.done_at ? <><Undo2 size={12} /> Undo</> : <><Check size={13} /> Done</>}
                  </button>
                </div>
              </div>
              {i.copy_text && (
                <div className="mt-2 flex items-start gap-2">
                  <div className="flex-1 min-w-0"><TextBox text={i.copy_text} /></div>
                  <CopyBtn text={i.copy_text} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'all' && (
        <div className="card p-3">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <input className="input text-sm max-w-xs" placeholder="Search name, company, list…" value={q} onChange={e => setQ(e.target.value)} />
            {['unsent', 'pending', 'accepted', 'thanked', 'skipped', 'any'].map(f => (
              <button key={f} onClick={() => setFilt(f)}
                className={`text-xs px-2 py-1 rounded border ${filt === f ? 'bg-brand-700 text-white border-brand-700' : 'bg-white text-gray-600 border-gray-200'}`}>
                {f === 'any' ? 'Everyone' : f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          {!all ? <div className="text-sm text-gray-500">Loading…</div> : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-gray-500 border-b"><th className="py-1 pr-2">Person</th><th className="pr-2">Company</th><th className="pr-2">List</th><th className="pr-2">Planned</th><th className="pr-2">Status</th><th></th></tr></thead>
                <tbody>
                  {people.map(p => (
                    <tr key={p.id} className="border-b border-gray-100">
                      <td className="py-1 pr-2"><a href={p.profile_url} target="_blank" rel="noopener noreferrer" className="text-brand-700 hover:underline">{p.person}</a></td>
                      <td className="pr-2">{p.company}</td>
                      <td className="pr-2 text-gray-500">{p.list_name}</td>
                      <td className="pr-2 text-gray-500">{fmtDay(p.plan_date)}</td>
                      <td className="pr-2">
                        {p.skipped_at ? <span className="text-gray-400">Skipped{p.skip_reason ? `: ${p.skip_reason}` : ''}</span>
                          : p.thanked_at ? <span className="text-emerald-700">Thanked</span>
                          : p.accepted_on ? <span className="text-emerald-700">Accepted {fmtDay(p.accepted_on)}</span>
                          : p.sent_at ? <span className="text-gray-700">Pending (sent {fmtDay(p.sent_at)})</span>
                          : <span className="text-gray-500">Not sent</span>}
                      </td>
                      <td className="text-right">
                        {p.skipped_at
                          ? <button className="underline text-gray-500" onClick={() => post('s' + p.id, `/linkedin/people/${p.id}/skip`, { undo: true })}>unskip</button>
                          : !p.sent_at && <button className="underline text-gray-500" onClick={() => skip(p)}>skip</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!people.length && <div className="text-sm text-gray-500 py-3">Nobody here.</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
