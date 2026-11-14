import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../lib/api';
import Modal from '../../components/ui/Modal';
import { useWorkStore } from '../../store/workStore';
import {
  DraftingCompass, RefreshCw, ChevronLeft, ChevronRight, Maximize2, CheckCircle2, AlertTriangle, Ban, Info, RotateCcw,
} from 'lucide-react';

// ── Drawings to make (owner, 14 Nov 2026) ─────────────────────────────────────
// The plain U type heaters the app can draw itself (server: lib/drawings/
// agent.js). She sees what needs a drawing; opens one to see the sheet, the
// questions with the likely answers already in (and where each came from), the
// job card figures; and approves once — the drawing goes on the order item and
// the job card is made, so she no longer types the total length or cold zone.

// An A3 sheet at the browser's 96 dpi (420 × 297 mm).
const A3_W = 1588, A3_H = 1123;

// The sheet, scaled to the width it is given.
function SheetPreview({ html }) {
  const box = useRef(null);
  const [w, setW] = useState(900);
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = w / A3_W;
  return (
    <div ref={box} className="w-full rounded-lg border border-gray-200 overflow-hidden bg-white" style={{ height: A3_H * scale }}>
      {/* No scripts in the sheet; same origin only so it renders in-process. */}
      <iframe title="Drawing sheet" srcDoc={html} sandbox="allow-same-origin"
        style={{ width: A3_W, height: A3_H, border: 0, transform: `scale(${scale})`, transformOrigin: '0 0' }} />
    </div>
  );
}

function openFullSize(html) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ── The list ──────────────────────────────────────────────────────────────────
function Queue({ onOpen }) {
  const [q, setQ] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = () => {
    setLoading(true); setError('');
    api.get('/drawing-agent/queue')
      .then(r => setQ(r.data))
      .catch(e => setError(e.response?.data?.error || 'Could not read the drawings to make'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);
  const due = q?.due || [], skipped = q?.skipped || [];

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <DraftingCompass size={22} className="text-brand-600" /> Drawings to make
          </h1>
          <p className="text-gray-500 text-sm mt-0.5">
            Plain U type heaters the app draws itself. Check the answers, approve once — the drawing goes on the order item and the job card is made.
          </p>
        </div>
        <button onClick={load} className="btn-secondary flex items-center gap-1.5 text-sm"><RefreshCw size={14} /> Refresh</button>
      </div>

      {error && <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg mb-4">{error}</p>}

      <div className="card overflow-hidden mb-4">
        {loading ? (
          <div className="p-12 text-center text-gray-400">Loading…</div>
        ) : due.length === 0 ? (
          <div className="p-12 text-center text-gray-400">No order items need a U type drawing right now.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="text-left px-4 py-2">Order</th>
                <th className="text-left px-4 py-2">Drawing</th>
                <th className="text-right px-4 py-2">Qty</th>
                <th className="text-left px-4 py-2">Rating · tube</th>
                <th className="text-left px-4 py-2">Remark</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {due.map(d => (
                <tr key={d.itemId} className="hover:bg-brand-50/40 cursor-pointer" onClick={() => onOpen(d.itemId)}>
                  <td className="px-4 py-2.5">
                    <div className="font-semibold text-gray-800">{d.order}</div>
                    <div className="text-xs text-gray-400">{d.customer}</div>
                  </td>
                  <td className="px-4 py-2.5 font-medium text-brand-700">{d.dwg}</td>
                  <td className="px-4 py-2.5 text-right">{d.qty}</td>
                  <td className="px-4 py-2.5 text-gray-600">{d.wattage} W · {d.voltage} V · Ø{d.dia}</td>
                  <td className="px-4 py-2.5 text-gray-600">{d.remark || '—'}</td>
                  <td className="px-4 py-2.5 text-right"><span className="inline-flex items-center gap-1 text-brand-600 font-medium">Open <ChevronRight size={14} /></span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {skipped.length > 0 && (
        <details className="card px-4 py-3">
          <summary className="cursor-pointer text-sm text-gray-600 font-medium">
            {skipped.length} item{skipped.length > 1 ? 's' : ''} with no drawing that the app does not draw here — why
          </summary>
          <ul className="mt-3 divide-y divide-gray-100 text-sm">
            {skipped.map(s => (
              <li key={s.itemId} className="py-2 flex gap-3">
                <Link to={`/orders/${s.orderId}`} className="w-32 flex-shrink-0 font-medium text-brand-600 hover:underline">{s.order}</Link>
                <span className="w-64 flex-shrink-0 text-gray-800 truncate" title={s.dwg}>{s.dwg}</span>
                <span className="text-gray-500">{s.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// ── One item: the sheet, the questions, the card, the approval ────────────────
const FIELD_ORDER = ['fitting_set', 'nipple', 'u_length_in', 'outside_width_mm', 'cold_zone_in', 'cold_zone_small_in',
  'pin_in', 'pin_small_in', 'fixture', 'asmbly', 'dispatch_date', 'terminal_group'];

function Field({ q, value, onChange, onReset }) {
  const missing = q.required && !String(value ?? '').trim();
  const common = { className: `input ${missing ? 'border-red-300 bg-red-50/40' : ''}`, value: value ?? '', onChange: e => onChange(e.target.value) };
  return (
    <div className={q.type === 'textarea' ? 'col-span-2' : ''}>
      <label className="label flex items-center gap-1.5">
        <span className={missing ? 'text-red-600' : ''}>{q.label}</span>
        {q.answered && <button type="button" onClick={onReset} title="Back to the app's answer" className="text-gray-400 hover:text-brand-600"><RotateCcw size={11} /></button>}
      </label>
      {q.text && <p className="text-xs text-gray-600 mb-1.5 leading-relaxed">{q.text}</p>}
      {q.type === 'select' ? (
        <select {...common}>
          {!value && <option value="">— choose —</option>}
          {(q.options || []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : q.type === 'textarea' ? (
        <textarea {...common} rows={2} />
      ) : (
        <input {...common} type={q.type === 'number' ? 'number' : q.type === 'date' ? 'date' : 'text'} step={q.type === 'number' ? 'any' : undefined} />
      )}
      <p className="text-[11px] text-gray-400 mt-0.5 leading-snug">
        {q.help ? `${q.help} · ` : ''}{q.answered ? 'your answer' : q.source}
      </p>
    </div>
  );
}

function ItemSheet({ itemId, onBack }) {
  const [p, setP] = useState(null);
  const [answers, setAnswers] = useState({});
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);          // an answer changed, its sheet not back yet
  const [fittingOk, setFittingOk] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [approving, setApproving] = useState(false);
  const [done, setDone] = useState(null);
  const timer = useRef(null);
  const reqNo = useRef(0);

  const preview = useCallback(async (ans) => {
    const my = ++reqNo.current;
    try {
      const r = await api.post(`/drawing-agent/items/${itemId}/preview`, { answers: ans });
      if (my !== reqNo.current) return;
      setP(r.data); setError(''); setDirty(false);
    } catch (e) {
      if (my !== reqNo.current) return;
      setError(e.response?.data?.error || 'Could not work out the drawing'); setDirty(false);
    }
  }, [itemId]);

  useEffect(() => {
    setP(null); setAnswers({}); setDone(null); setFittingOk(false); setError('');
    api.get(`/drawing-agent/items/${itemId}`)
      .then(r => setP(r.data))
      .catch(e => setError(e.response?.data?.error || 'Could not open this item'));
    return () => clearTimeout(timer.current);
  }, [itemId]);

  // Every change re-works the sheet (and so its sheet code), a moment after typing stops.
  const change = (next) => {
    setAnswers(next); setDirty(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => preview(next), 600);
  };
  const setAnswer = (k, v) => change({ ...answers, [k]: v });
  const resetAnswer = (k) => { const next = { ...answers }; delete next[k]; change(next); };

  const approve = async () => {
    setApproving(true); setError('');
    try {
      const r = await api.post(`/drawing-agent/items/${itemId}/approve`, {
        answers, sheet_code: p.sheetCode, fitting_confirmed: fittingOk, seen_snapshot: p.snapshot,
      }, { timeout: 120000 });
      setDone(r.data); setConfirming(false);
      useWorkStore.getState().fetch();
      document.querySelector('main')?.scrollTo?.({ top: 0 });   // the result is short; show it
    } catch (e) {
      setConfirming(false);
      setError(e.response?.data?.error || 'Could not save the drawing — nothing was saved.');
      // The sheet changed under her: show the current one.
      if (e.response?.data?.code === 'SHEET_CHANGED') { setDirty(true); preview(answers); }
    } finally { setApproving(false); }
  };

  const back = (
    <button onClick={onBack} className="btn-ghost btn-sm -ml-2 mb-3"><ChevronLeft size={14} /> All drawings to make</button>
  );
  if (!p) {
    return <div className="p-6 max-w-7xl mx-auto">{back}{error ? <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</p> : <div className="p-12 text-center text-gray-400">Working out the drawing…</div>}</div>;
  }

  const o = p.order;
  const f = p.figures;
  const valueOf = (q) => (Object.prototype.hasOwnProperty.call(answers, q.key) ? answers[q.key] : q.value);
  const qs = p.questions || [];
  const acks = qs.filter(q => q.key.startsWith('ack:'));
  const fields = FIELD_ORDER.map(k => qs.find(q => q.key === k)).filter(Boolean);
  const noteQ = qs.find(q => q.key === 'note');
  const needsFitting = p.fitting && p.fitting.set && !p.fitting.confirmed;
  const canApprove = p.status === 'ready' && !dirty && !approving && (!needsFitting || fittingOk);
  const cardCount = f?.quantities?.length || 0;

  if (done) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        {back}
        <div className="card p-6">
          <div className="flex items-center gap-2 text-green-700 font-semibold text-lg mb-2"><CheckCircle2 size={20} /> Drawing approved and the job card made</div>
          <p className="text-sm text-gray-600 mb-4">
            {done.drawingNumber} is on <Link to={`/orders/${done.orderId}`} className="text-brand-600 hover:underline font-medium">{done.orderCode}</Link> as an approved drawing
            (sheet {done.sheetCode}). <a href={`/uploads/${done.drawing.file_path}`} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline">Open the drawing</a>.
          </p>
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-1.5">Job card{done.cards.length > 1 ? 's' : ''}</div>
          <ul className="space-y-1 mb-5">
            {done.cards.map(c => (
              <li key={c.id}><Link to={`/job-cards/${c.id}`} className="text-brand-600 hover:underline font-medium">{c.job_card_no}</Link> <span className="text-gray-500">— {c.qty} pcs</span></li>
            ))}
          </ul>
          <button onClick={onBack} className="btn-primary">Back to the list</button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {back}
      {/* The order as typed */}
      <div className="card px-4 py-3 mb-4 text-sm flex flex-wrap gap-x-4 gap-y-1 items-baseline">
        <Link to={`/orders/${p.orderId}`} className="font-bold text-brand-700 hover:underline">{o.orderCode}</Link>
        <span className="text-gray-500">{o.customerCode}{o.customerName ? ` · ${o.customerName}` : ''}</span>
        <span className="font-semibold text-gray-900">{o.drawingNumber}</span>
        <span>{o.qty} Nos</span>
        <span>{o.wattage} W · {o.voltage} V</span>
        <span>{o.tubeMaterial} · Ø{o.tubeDiameter}</span>
        <span>Remark: <span className="font-medium">{o.remark || '—'}</span></span>
        <span>{o.plating || '—'}</span>
      </div>

      {p.status === 'not_due' || p.status === 'out_of_scope' ? (
        <div className="card p-5 text-sm">
          <div className="flex items-center gap-2 font-semibold text-gray-800 mb-2"><Info size={16} /> The app does not draw this item</div>
          <ul className="list-disc ml-5 text-gray-600 space-y-0.5">{(p.reasons || []).map((r, i) => <li key={i}>{r}</li>)}</ul>
        </div>
      ) : (
        <>
          {p.html && (
            <div className="mb-4">
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-xs text-gray-500">
                  {dirty ? 'Updating the sheet…' : <>Sheet code <span className="font-mono text-gray-700">{p.sheetCode}</span> — your approval is for exactly this sheet</>}
                </div>
                <button onClick={() => openFullSize(p.html)} className="btn-secondary btn-sm"><Maximize2 size={13} /> Open full size</button>
              </div>
              <div className={dirty ? 'opacity-60 transition-opacity' : 'transition-opacity'}><SheetPreview html={p.html} /></div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            {/* The questions */}
            <div className="lg:col-span-3 card p-4">
              <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3">The answers — change any that are wrong</h2>
              {acks.length > 0 && (
                <div className="grid grid-cols-2 gap-3 mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200">
                  {acks.map(q => <Field key={q.key} q={q} value={valueOf(q)} onChange={v => setAnswer(q.key, v)} onReset={() => resetAnswer(q.key)} />)}
                </div>
              )}
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                {fields.map(q => <Field key={q.key} q={q} value={valueOf(q)} onChange={v => setAnswer(q.key, v)} onReset={() => resetAnswer(q.key)} />)}
                {noteQ && <Field q={noteQ} value={valueOf(noteQ)} onChange={v => setAnswer('note', v)} onReset={() => resetAnswer('note')} />}
              </div>
              {p.parts?.length > 0 && (
                <div className="mt-4">
                  <div className="label">Parts — the item's list stays as design made it</div>
                  <table className="w-full text-xs">
                    <tbody className="divide-y divide-gray-100">
                      {p.parts.map(x => (
                        <tr key={x.no} className={x.fromList ? '' : 'text-gray-500'}>
                          <td className="py-1 pr-2 w-6">{x.no}</td>
                          <td className="py-1 pr-2">{x.line}</td>
                          <td className="py-1 pr-2 text-gray-400">{x.stage}</td>
                          <td className="py-1 pr-2 text-right">{x.perPc}</td>
                          <td className="py-1 text-right font-medium">{x.forOrder}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* The card, what stops it, and the one button */}
            <div className="lg:col-span-2 space-y-4">
              {f && (
                <div className="card divide-y text-sm">
                  <div className="px-3 py-2 bg-gray-50 text-xs uppercase tracking-wide text-gray-500 rounded-t-xl">What the job card will say</div>
                  {[
                    ['Total length', `${f.totalLengthIn}" (2 × ${p.questions.find(q => q.key === 'u_length_in')?.value}") → card ${f.cardTotalIn}"`],
                    ['Cutting length', `${f.cuttingLengthIn}" · ${f.cuttingLengthMm} mm`],
                    ['Cold zone', `${f.coldZoneBigIn}" big · ${f.coldZoneSmallIn}" small`],
                    ['Wire', f.gauge == null ? 'no gauge fits' : `${f.gauge} SWG${f.doubleCoil ? ' · double coil' : ''}`],
                    ['Resistance', `${Number(f.ohms).toFixed(2)} Ω (${Number(f.ohmsMin).toFixed(2)} – ${Number(f.ohmsMax).toFixed(2)})`],
                    ['Terminal pins', `${f.stud} ${f.pinBig}" / ${f.pinSmall}"${f.pinOverridden ? ' (set by you)' : ''} — ${f.pins?.big || '?'} + ${f.pins?.small || '?'}`],
                    ['Job card' + (cardCount > 1 ? 's' : ''), (f.names || []).map((n, i) => `${n} (${f.quantities[i]})`).join(', ')],
                  ].map(([k, v]) => (
                    <div key={k} className="flex gap-3 px-3 py-1.5">
                      <span className="w-28 flex-shrink-0 text-gray-500">{k}</span>
                      <span className="font-mono text-gray-800 break-words">{v}</span>
                    </div>
                  ))}
                </div>
              )}

              {p.blocks?.length > 0 && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                  <div className="flex items-center gap-1.5 font-semibold mb-1"><Ban size={14} /> Cannot be approved yet</div>
                  <ul className="list-disc ml-5 space-y-0.5">{p.blocks.map((b, i) => <li key={i}>{b}</li>)}</ul>
                </div>
              )}
              {[...(p.flags || []), ...(p.draftNotes || [])].length > 0 && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 space-y-1">
                  <div className="flex items-center gap-1.5 font-semibold text-sm"><AlertTriangle size={14} /> Worth a look</div>
                  {[...(p.flags || []), ...(p.draftNotes || [])].map((w, i) => <div key={i}>• {w}</div>)}
                </div>
              )}

              {needsFitting && (
                <label className="flex items-start gap-2 rounded-xl border border-red-200 bg-white p-3 text-sm cursor-pointer">
                  <input type="checkbox" className="mt-0.5" checked={fittingOk} onChange={e => setFittingOk(e.target.checked)} />
                  <span>
                    <span className="font-semibold text-red-700">First "{p.fitting.label}" drawing: </span>
                    the terminal end goes on in this order — <span className="font-medium">{p.fitting.order.join(' → ')}</span>. That is right.
                    <span className="block text-xs text-gray-500 mt-0.5">Ticked once, later sheets for this set no longer ask.</span>
                  </span>
                </label>
              )}

              {error && <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
              <button className="btn-primary w-full justify-center py-3" disabled={!canApprove} onClick={() => setConfirming(true)}>
                <CheckCircle2 size={16} /> Approve drawing &amp; make job card{cardCount > 1 ? `s (${cardCount})` : ''}
              </button>
              {p.status === 'needs_answer' && <p className="text-xs text-red-600 -mt-2">Answer the questions marked in red first.</p>}
            </div>
          </div>
        </>
      )}

      <Modal open={confirming} onClose={() => !approving && setConfirming(false)} title="Approve this drawing?" size="sm">
        <div className="space-y-3 text-sm text-gray-700">
          <p>
            Put <span className="font-semibold">{o.drawingNumber}</span> on <span className="font-semibold">{o.orderCode}</span> as an approved drawing
            and make <span className="font-semibold">{cardCount} job card{cardCount > 1 ? 's' : ''}</span>: {(f?.names || []).join(', ')}.
          </p>
          <p className="text-gray-500">Total length {f?.totalLengthIn}" · cold zone {f?.coldZoneBigIn}" / {f?.coldZoneSmallIn}" · {f?.gauge} SWG · sheet {p.sheetCode}. A job card once made is not changed later.</p>
          <div className="flex gap-3 pt-1">
            <button className="btn-secondary flex-1 justify-center" disabled={approving} onClick={() => setConfirming(false)}>Cancel</button>
            <button className="btn-primary flex-1 justify-center" disabled={approving} onClick={approve}>{approving ? 'Saving…' : 'Approve'}</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default function DrawingsToMake() {
  const [params, setParams] = useSearchParams();
  const itemId = parseInt(params.get('item'), 10) || null;
  return itemId
    ? <ItemSheet itemId={itemId} onBack={() => setParams({})} />
    : <Queue onOpen={(id) => setParams({ item: String(id) })} />;
}
