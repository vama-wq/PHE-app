import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import api, { uploadApi } from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import Modal from '../../components/ui/Modal';
import { fmtDateTime } from '../../lib/utils';
import { compressImages } from '../../lib/compressImage';
import {
  ArrowLeft, Send, Camera, X, ShieldAlert, CheckCircle, Clock,
  Printer, RotateCcw, Bot, Loader2,
} from 'lucide-react';

const STATUS_META = {
  open:              { label: 'CAPA in progress', cls: 'bg-red-100 text-red-800 border-red-200', Icon: ShieldAlert },
  awaiting_approval: { label: 'Awaiting owner approval', cls: 'bg-amber-100 text-amber-800 border-amber-200', Icon: Clock },
  approved:          { label: 'Approved — work unlocked', cls: 'bg-green-100 text-green-800 border-green-200', Icon: CheckCircle },
};

export default function CapaReport() {
  const { id } = useParams();
  const { user } = useAuthStore();
  const [capa, setCapa] = useState(null);
  const [text, setText] = useState('');
  const [photos, setPhotos] = useState([]); // File[]
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenNote, setReopenNote] = useState('');
  const bottomRef = useRef(null);

  const load = useCallback(async () => {
    const { data } = await api.get(`/capa/${id}`);
    setCapa(data);
  }, [id]);

  useEffect(() => { load().catch(() => setError('Could not load the CAPA.')); }, [load]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [capa?.conversation?.length, sending]);

  const conversation = Array.isArray(capa?.conversation) ? capa.conversation : [];
  const canChat = capa && capa.status !== 'approved' && ['production', 'admin', 'owner'].includes(user?.role);

  const attach = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const compressed = await compressImages(files);
    setPhotos(prev => [...prev, ...compressed].slice(0, 6));
    e.target.value = '';
  };

  const send = async () => {
    if (sending || (!text.trim() && !photos.length)) return;
    setSending(true); setError('');
    try {
      const fd = new FormData();
      fd.append('text', text.trim());
      photos.forEach(p => fd.append('photos', p, p.name));
      await uploadApi.post(`/capa/${id}/message`, fd);
      setText(''); setPhotos([]);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Message failed — try again.');
    } finally {
      setSending(false);
    }
  };

  const approve = async () => {
    if (!window.confirm('Approve this CAPA and unlock the job card?')) return;
    try { await api.put(`/capa/${id}/approve`); await load(); }
    catch (err) { setError(err.response?.data?.error || 'Approve failed'); }
  };

  const reopen = async () => {
    try {
      await api.put(`/capa/${id}/reopen`, { note: reopenNote });
      setReopenOpen(false); setReopenNote('');
      await load();
    } catch (err) { setError(err.response?.data?.error || 'Failed'); }
  };

  const printReport = () => {
    const w = window.open('', '_blank');
    w.document.write(`<!doctype html><html><head><title>CAPA — ${capa.job_card_no}</title>
      <style>body{font-family:Arial,sans-serif;margin:32px;color:#111}h1{font-size:20px}h2{font-size:14px;margin:18px 0 4px;text-transform:uppercase;letter-spacing:.05em;color:#555}
      p{margin:4px 0;line-height:1.5}table{border-collapse:collapse;width:100%;margin-top:6px}td,th{border:1px solid #ccc;padding:6px 8px;font-size:13px;text-align:left}
      .meta{color:#555;font-size:13px}</style></head><body>
      <h1>CAPA Report — ${capa.job_card_no}</h1>
      <p class="meta">Peena Heat Elements | Order ${capa.order_code || '-'} | Product ${capa.product_name || '-'} | Drawing ${capa.drawing_no || '-'}</p>
      <p class="meta">Trigger: ${capa.trigger_type === 'rejections' ? `Cumulative rejections (${capa.trigger_total} pcs)` : `Customer query ${capa.query_no || ''}`}
        | Raised ${fmtDateTime(capa.created_at)} ${capa.approved_at ? `| Approved ${fmtDateTime(capa.approved_at)} by ${capa.approved_by_name || ''}` : '(not yet approved)'}</p>
      ${(capa.rejections || []).length ? `<h2>Stage rejections</h2><table><tr><th>Stage</th><th>Rejected</th><th>Remade</th></tr>
        ${capa.rejections.map(r => `<tr><td>${r.stage_no}</td><td>${r.rejection_qty}</td><td>${r.remade_qty || 0}</td></tr>`).join('')}</table>` : ''}
      <h2>Problem statement</h2><p>${capa.problem_statement || '-'}</p>
      <h2>Root cause</h2><p>${capa.root_cause || '-'}</p>
      <h2>Corrective action</h2><p>${capa.corrective_action || '-'}</p>
      <h2>Preventive action</h2><p>${capa.preventive_action || '-'}</p>
      </body></html>`);
    w.document.close(); w.print();
  };

  if (!capa) return <div className="p-6 text-gray-500">{error || 'Loading…'}</div>;
  const meta = STATUS_META[capa.status] || STATUS_META.open;

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-4 pb-44">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <Link to={`/job-cards/${capa.job_card_id}`} className="btn-secondary flex items-center gap-1.5">
            <ArrowLeft size={16} /> {capa.job_card_no}
          </Link>
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${meta.cls}`}>
            <meta.Icon size={13} /> {meta.label}
          </span>
        </div>
        {capa.status !== 'open' && (
          <button onClick={printReport} className="btn-secondary flex items-center gap-1.5"><Printer size={15} /> Print report</button>
        )}
      </div>

      <div className="card p-4 text-sm space-y-1">
        <div className="font-semibold">CAPA #{capa.id} — {capa.trigger_type === 'rejections'
          ? `${capa.trigger_total} pieces rejected across stages`
          : `Customer query ${capa.query_no || ''}`}</div>
        <div className="text-gray-600">{capa.product_name || '-'} · Drawing {capa.drawing_no || '-'} · Qty {capa.card_qty}</div>
        {(capa.rejections || []).length > 0 && (
          <div className="text-gray-600">
            Rejections: {capa.rejections.map(r => `stage ${r.stage_no}: ${r.rejection_qty}`).join(' · ')}
          </div>
        )}
        <div className="text-gray-500 text-xs">
          Explain the issue below. The AI facilitator will question you until the real root cause is found — it needs
          specifics and photos, and it will push back on vague answers. The report unlocks work only after the owner approves it.
        </div>
      </div>

      {(capa.problem_statement || capa.status !== 'open') && (
        <div className="card p-4 space-y-2 border-l-4 border-blue-400">
          <div className="font-semibold text-sm">CAPA report</div>
          {[['Problem statement', capa.problem_statement], ['Root cause', capa.root_cause],
            ['Corrective action', capa.corrective_action], ['Preventive action', capa.preventive_action]]
            .map(([k, v]) => (
              <div key={k}>
                <div className="text-xs uppercase tracking-wide text-gray-500">{k}</div>
                <div className="text-sm">{v || '—'}</div>
              </div>
            ))}
          {capa.status === 'awaiting_approval' && user?.role === 'owner' && (
            <div className="flex gap-2 pt-2">
              <button onClick={approve} className="btn-primary flex items-center gap-1.5"><CheckCircle size={15} /> Approve &amp; unlock</button>
              <button onClick={() => setReopenOpen(true)} className="btn-secondary flex items-center gap-1.5"><RotateCcw size={15} /> Send back</button>
            </div>
          )}
          {capa.status === 'approved' && (
            <div className="text-xs text-green-700">Approved by {capa.approved_by_name} · {fmtDateTime(capa.approved_at)}</div>
          )}
        </div>
      )}

      <div className="space-y-3">
        {conversation.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
              m.role === 'user' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-900'}`}>
              {m.role === 'assistant' && (
                <div className="flex items-center gap-1 text-xs font-medium text-gray-500 mb-1"><Bot size={13} /> CAPA Facilitator</div>
              )}
              {(m.photos || []).map((p, j) => (
                <a key={j} href={`/uploads/${p.path}`} target="_blank" rel="noreferrer">
                  <img src={`/uploads/${p.path}`} alt={p.name} className="rounded-lg max-h-44 mb-2 border border-white/30" />
                </a>
              ))}
              {m.text}
              <div className={`text-[10px] mt-1 ${m.role === 'user' ? 'text-blue-200' : 'text-gray-400'}`}>
                {m.by ? `${m.by} · ` : ''}{m.at ? fmtDateTime(m.at) : ''}
              </div>
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="bg-gray-100 rounded-2xl px-4 py-3 text-sm text-gray-500 flex items-center gap-2">
              <Loader2 size={15} className="animate-spin" /> Analysing…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <div className="text-sm text-red-600">{error}</div>}

      {canChat && (
        <div className="fixed bottom-0 left-64 right-0 bg-white border-t p-3 z-20">
          <div className="max-w-3xl mx-auto space-y-2">
            {photos.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                {photos.map((p, i) => (
                  <div key={i} className="relative">
                    <img src={URL.createObjectURL(p)} alt="" className="h-14 w-14 object-cover rounded-lg border" />
                    <button onClick={() => setPhotos(ph => ph.filter((_, j) => j !== i))}
                      className="absolute -top-1.5 -right-1.5 bg-gray-800 text-white rounded-full p-0.5"><X size={11} /></button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <label className="btn-secondary cursor-pointer p-2.5">
                <Camera size={18} />
                <input type="file" accept="image/*" multiple className="hidden" onChange={attach} />
              </label>
              <textarea
                value={text} onChange={e => setText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                rows={2} placeholder="Explain the issue in detail — any language…"
                className="flex-1 border rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={sending}
              />
              <button onClick={send} disabled={sending || (!text.trim() && !photos.length)}
                className="btn-primary p-2.5 disabled:opacity-50">
                {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
              </button>
            </div>
          </div>
        </div>
      )}

      <Modal open={reopenOpen} onClose={() => setReopenOpen(false)} title="Send CAPA back">
        <div className="space-y-3">
          <p className="text-sm text-gray-600">Tell the team what is missing — this goes into the conversation.</p>
          <textarea value={reopenNote} onChange={e => setReopenNote(e.target.value)} rows={3}
            className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="e.g. Root cause doesn't explain why stage 8 passed it…" />
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setReopenOpen(false)}>Cancel</button>
            <button className="btn-primary" onClick={reopen} disabled={!reopenNote.trim()}>Send back</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
