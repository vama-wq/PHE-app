// ── Terminal pins of ONE job card (owner, 6 Oct 2026) ────────────────────────
//
// The right terminal pin is the one design picked on the item's list — not
// the stud length the card generator worked out — and each card carries its
// OWN pin rows, seeded from the list for the card's share. Design (and admin /
// owner) can change a card's pins until the card's last stage is taken; after
// that the pins have left stock and the box is read-only (any difference is
// fixed at Inventory QC).
//
// A pin short of stock holds the card's material slip until the owner or
// Design / QC presses OK — both are told the moment the shortage is found.
// Rework pins never raise anything.
//
// Shown on the job card page (full) and in the order's job card list
// (compact: one summary line, click to open). Server: GET / PUT
// /job-cards/:id/terminals and POST /job-cards/:id/terminals/ok.
import { useEffect, useState } from 'react';
import api from '../lib/api';
import { useAuthStore } from '../store/authStore';
import StockTag from './StockTag';
import { fmtDateTime } from '../lib/utils';
import { Zap, Pencil, Plus, X, AlertTriangle, CheckCircle, ChevronDown, ChevronRight } from 'lucide-react';

// Who may read the box at all (the server refuses everyone else).
export const TERMINAL_ROLES = ['production', 'design', 'admin', 'owner'];

// The picker offers category 'Terminal Pin' only (TP-SS-…, TP-MS-…). Heavy
// terminal pins, nuts and washers stay on the item list, and a TRAIN
// placeholder is never a real pin.
const isTerminalPin = (i) =>
  String(i?.category || '').trim().toLowerCase() === 'terminal pin' && !/TRAIN/i.test(i?.item_code || '');

const fmtQty = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 });

function SourceBadge({ source }) {
  return source === 'design'
    ? <span className="text-[10px] font-semibold bg-violet-100 text-violet-800 rounded px-1.5 py-0.5 whitespace-nowrap" title="Design changed this card's pins from what the list says">changed by design</span>
    : <span className="text-[10px] font-semibold bg-gray-100 text-gray-600 rounded px-1.5 py-0.5 whitespace-nowrap" title="This card's share of the item's list">from list</span>;
}

export default function TerminalPinsBox({ jobCardId, compact = false, onChanged }) {
  const { user } = useAuthStore();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(!compact);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState([]);
  const [pins, setPins] = useState(null);
  const [search, setSearch] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [okBusy, setOkBusy] = useState(false);

  const canRead = TERMINAL_ROLES.includes(user?.role);

  // Reading the card's pins also runs the stock check on the server, so
  // opening the card is enough for the owner and Design / QC to hear about a
  // short pin.
  const load = () => api.get(`/job-cards/${jobCardId}/terminals`)
    .then(r => { setData(r.data); setError(''); })
    .catch(e => setError(e.response?.data?.error || 'Could not load the terminal pins'));
  useEffect(() => { if (canRead) load(); }, [jobCardId, canRead]);

  if (!canRead) return null;
  if (error && !data) return <p className={`text-xs text-red-600 ${compact ? '' : 'mb-5'}`}>{error}</p>;
  if (!data) return <p className={`text-xs text-gray-400 ${compact ? '' : 'mb-5'}`}>Loading terminal pins…</p>;
  // A finished-goods card: its pins are inside the heater already.
  if (data.no_terminals) return null;

  const rows = data.rows || [];
  const held = !!data.held;
  const shortButOk = data.short?.length > 0 && !!data.ok && !held;
  const taken = !!data.last_stage_taken_at;

  const startEdit = () => {
    setDraft(rows.map(r => ({ inventory_item_id: r.inventory_item_id, qty: String(Math.round(Number(r.qty) || 0)),
      item_code: r.item_code, name: r.name, unit: r.unit, current_stock: r.current_stock, rework_free: r.rework_free })));
    setEditing(true);
    setOpen(true);
    if (!pins) {
      api.get('/inventory').then(r => setPins((r.data || []).filter(isTerminalPin))).catch(() => setPins([]));
    }
  };
  const cancelEdit = () => { setEditing(false); setError(''); setSearch(''); };

  const addPin = (i) => {
    if (draft.some(d => d.inventory_item_id === i.id)) return;
    setDraft(d => [...d, { inventory_item_id: i.id, qty: '', item_code: i.item_code, name: i.name, unit: i.unit,
      current_stock: i.current_stock, rework_free: i.rework_free }]);
  };
  const setQty = (id, v) => setDraft(d => d.map(r => r.inventory_item_id === id ? { ...r, qty: v } : r));
  const removeRow = (id) => setDraft(d => d.filter(r => r.inventory_item_id !== id));

  const save = async () => {
    const body = draft.map(r => ({ inventory_item_id: r.inventory_item_id, qty: parseInt(r.qty, 10) }));
    if (!body.length) { setError('A job card needs at least one terminal pin.'); return; }
    if (body.some(r => !Number.isInteger(r.qty) || r.qty <= 0)) { setError('Every pin needs a whole quantity above 0.'); return; }
    setSaving(true); setError('');
    try {
      const r = await api.put(`/job-cards/${jobCardId}/terminals`, { rows: body });
      setData(r.data);
      setEditing(false);
      setSearch('');
      onChanged?.(r.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Could not save the terminal pins');
    } finally { setSaving(false); }
  };

  // The owner or Design / QC releasing a held slip. The note is optional.
  const pressOk = async () => {
    const what = (data.short || []).map(s => `${s.item_code} (need ${s.need}, stock ${s.stock})`).join(', ');
    const note = window.prompt(`Release the slip although ${what} is short of stock?\n\nNote (optional):`, '');
    if (note === null) return;
    setOkBusy(true); setError('');
    try {
      const r = await api.post(`/job-cards/${jobCardId}/terminals/ok`, { note });
      setData(r.data);
      onChanged?.(r.data);
    } catch (e) {
      // NOT_SHORT: stock came in meanwhile — the slip is not held any more.
      if (e.response?.data?.code === 'NOT_SHORT') load();
      else setError(e.response?.data?.error || 'Could not record the OK');
    } finally { setOkBusy(false); }
  };

  const filteredPins = (pins || []).filter(i => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (i.item_code || '').toLowerCase().includes(q) || (i.name || '').toLowerCase().includes(q);
  });

  const summary = rows.length
    ? rows.map(r => `${r.item_code} × ${fmtQty(r.qty)}`).join(' · ')
    : 'no terminal pins on this card';

  const header = (
    <div className="flex items-center gap-2 flex-wrap">
      <Zap size={15} className={held ? 'text-red-600' : 'text-brand-600'} />
      <span className="font-semibold text-gray-900 text-sm">Terminal pins</span>
      {compact && !open && <span className="text-xs text-gray-500 truncate">{summary}</span>}
      {held && (
        <span className="text-[10px] font-semibold bg-red-100 text-red-700 rounded px-1.5 py-0.5 whitespace-nowrap flex items-center gap-1">
          <AlertTriangle size={10} /> SLIP HELD — pin short
        </span>
      )}
      {shortButOk && (
        <span className="text-[10px] font-semibold bg-amber-100 text-amber-800 rounded px-1.5 py-0.5 whitespace-nowrap">short · OK'd</span>
      )}
      {rows.some(r => r.source === 'design') && !held && (
        <span className="text-[10px] font-semibold bg-violet-100 text-violet-800 rounded px-1.5 py-0.5 whitespace-nowrap">changed by design</span>
      )}
      {taken && <span className="text-[10px] font-semibold bg-gray-100 text-gray-600 rounded px-1.5 py-0.5 whitespace-nowrap">taken from stock</span>}
    </div>
  );

  return (
    <div className={compact ? 'rounded-lg border border-gray-200 bg-white px-3 py-2' : 'card p-4 mb-5 no-print'}>
      <div className="flex items-center justify-between gap-3">
        {compact ? (
          <button type="button" className="flex-1 min-w-0 text-left flex items-center gap-2" onClick={() => setOpen(o => !o)}>
            {open ? <ChevronDown size={14} className="text-gray-400 flex-shrink-0" /> : <ChevronRight size={14} className="text-gray-400 flex-shrink-0" />}
            {header}
          </button>
        ) : header}
        <div className="flex items-center gap-2 flex-shrink-0">
          {held && data.can_ok && (
            <button type="button" className="btn-primary btn-sm text-xs" onClick={pressOk} disabled={okBusy}
              title="Release this card's slip although a pin is short — recorded on the card's timeline">
              <CheckCircle size={13} /> {okBusy ? 'Recording…' : 'OK — release slip'}
            </button>
          )}
          {data.editable && !editing && (
            <button type="button" className="btn-secondary btn-sm text-xs" onClick={startEdit}>
              <Pencil size={12} /> Change pins
            </button>
          )}
        </div>
      </div>

      {open && (
        <div className="mt-3 space-y-2">
          {/* Why the slip is held, in the owner's words, with who can lift it. */}
          {held && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              <div className="font-medium">
                Slip held — {(data.short || []).map(s => `pin ${s.item_code} short (need ${s.need}, stock ${fmtQty(s.stock)})`).join('; ')}.
              </div>
              <div className="text-xs mt-0.5">
                The owner or Design / QC must press OK before the material slip can print.
                {data.short_at ? ` Found ${fmtDateTime(data.short_at)}.` : ''}
              </div>
            </div>
          )}
          {shortButOk && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              Short pin OK'd by <b>{data.ok.by_name || 'owner / Design'}</b> on {fmtDateTime(data.ok.at)} — slip released.
              {data.ok.note ? <> Note: <i>{data.ok.note}</i></> : null}
            </div>
          )}
          {taken && (
            <p className="text-xs text-gray-500">
              Pins taken from stock at the last stage on {fmtDateTime(data.last_stage_taken_at)} — read-only; any difference is fixed at Inventory QC.
            </p>
          )}

          {!editing ? (
            rows.length ? (
              <div className="divide-y divide-gray-100 rounded-lg border border-gray-200 overflow-hidden">
                {rows.map(r => (
                  <div key={r.id} className={`flex items-center gap-3 px-3 py-2 text-sm ${r.short ? 'bg-red-50' : 'bg-white'}`}>
                    <div className="flex-1 min-w-0">
                      <span className="font-mono font-semibold text-gray-800">{r.item_code}</span>
                      {r.name && <span className="text-gray-600"> — {r.name}</span>}
                    </div>
                    <span className="font-semibold text-gray-900 whitespace-nowrap">{fmtQty(r.qty)} {(r.unit || '').trim()}</span>
                    <SourceBadge source={r.source} />
                    <span className="text-xs whitespace-nowrap w-40 text-right">
                      {/* the part the list takes from the rework bin needs no stock */}
                      {Number(r.from_rework) > 0 && <span className="block text-sky-700 font-medium">{fmtQty(r.from_rework)} from rework bin</span>}
                      {r.short
                        ? <span className="text-red-700 font-medium flex items-center justify-end gap-1"><AlertTriangle size={11} /> stock {fmtQty(r.current_stock)} — short {fmtQty(Number(r.qty) - Number(r.from_rework || 0) - Number(r.current_stock))}</span>
                        : <span className="text-gray-500">stock {fmtQty(r.current_stock)}</span>}
                      {Number(r.rework_free) > 0 && <span className="block text-[10px] text-sky-700">rework bin: {fmtQty(r.rework_free)} free</span>}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-400">
                No terminal pins on this card{data.list?.length ? '' : " — the item's list has no 'Terminal Pin' line"}.
                {data.editable ? ' Design can add one.' : ''}
              </p>
            )
          ) : (
            <div className="space-y-2">
              <div className="relative">
                <input className="input text-sm" placeholder={pins === null ? 'Loading terminal pins…' : 'Add a terminal pin — search by code or name…'}
                  value={search} disabled={pins === null}
                  onChange={e => { setSearch(e.target.value); setShowDropdown(true); }}
                  onFocus={() => setShowDropdown(true)}
                  onBlur={() => setTimeout(() => setShowDropdown(false), 150)} />
                {showDropdown && pins !== null && (
                  <div className="absolute z-10 w-full bg-white border border-gray-200 rounded-lg shadow-lg mt-1 max-h-52 overflow-y-auto">
                    {filteredPins.length === 0 ? (
                      <div className="px-3 py-2 text-sm text-gray-400">No terminal pin matches</div>
                    ) : filteredPins.map(i => {
                      const added = draft.some(d => d.inventory_item_id === i.id);
                      return (
                        <button key={i.id} type="button"
                          className="w-full text-left px-3 py-2 text-sm hover:bg-brand-50 flex items-center justify-between"
                          onMouseDown={() => { addPin(i); setSearch(''); }}>
                          <span><span className="font-mono">{i.item_code}</span> — {i.name}
                            <StockTag item={i} />
                            {Number(i.rework_free) > 0 && <span className="ml-1.5 text-[10px] font-semibold bg-sky-100 text-sky-800 rounded px-1.5 py-0.5">REWORK {fmtQty(i.rework_qty)} · {fmtQty(i.rework_free)} free</span>}
                          </span>
                          {added && <span className="text-xs text-green-600">added</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {draft.length ? draft.map(r => {
                const q = parseInt(r.qty, 10);
                const listLine = (data.list || []).find(l => l.inventory_item_id === r.inventory_item_id);
                // The list's rework portion for this pin comes from the bin, not stock (same rule as the server)
                const binCover = Number.isInteger(q) && listLine
                  ? Math.min(q, Math.max(0, Number(listLine.rework_qty || 0) - Number(listLine.rework_deducted || 0)),
                             Number(rows.find(x => x.inventory_item_id === r.inventory_item_id)?.rework_bin ?? r.rework_free ?? 0))
                  : 0;
                const shortBy = Number.isInteger(q) && q - binCover > Number(r.current_stock) ? q - binCover - Number(r.current_stock) : 0;
                return (
                  <div key={r.inventory_item_id} className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 ${shortBy > 0 ? 'bg-red-50' : 'bg-gray-50'}`}>
                    <span className="text-sm flex-1 truncate"><span className="font-mono">{r.item_code}</span> — {r.name}</span>
                    <input className="input w-20 text-sm py-1" type="number" min="1" step="1" placeholder="Qty"
                      value={r.qty} onChange={e => setQty(r.inventory_item_id, e.target.value)} />
                    <span className="text-xs text-gray-400 w-8">{(r.unit || '').trim()}</span>
                    <span className="text-xs whitespace-nowrap w-36 text-right">
                      {binCover > 0 && <span className="block text-sky-700 font-medium">{fmtQty(binCover)} from rework bin</span>}
                      {shortBy > 0
                        ? <span className="text-red-700 font-medium">stock {fmtQty(r.current_stock)} — short {fmtQty(shortBy)}</span>
                        : <span className="text-gray-500">stock {fmtQty(r.current_stock)}</span>}
                      {Number(r.rework_free) > 0 && <span className="block text-[10px] text-sky-700">rework bin: {fmtQty(r.rework_free)} free</span>}
                      {listLine && <span className="block text-[10px] text-gray-400">list says {listLine.share}</span>}
                    </span>
                    <button type="button" className="p-1 text-gray-400 hover:text-red-600" onClick={() => removeRow(r.inventory_item_id)} title="Remove">
                      <X size={14} />
                    </button>
                  </div>
                );
              }) : (
                <p className="text-sm text-gray-400 flex items-center gap-1.5"><Plus size={13} /> Add at least one terminal pin above.</p>
              )}

              {error && <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
              <div className="flex gap-2 pt-1">
                <button type="button" className="btn-secondary btn-sm" onClick={cancelEdit} disabled={saving}>Cancel</button>
                <button type="button" className="btn-primary btn-sm" onClick={save} disabled={saving}>
                  {saving ? 'Saving…' : 'Save pins'}
                </button>
                <span className="text-[11px] text-gray-400 self-center ml-1">
                  Saving clears any earlier OK and re-checks stock. These pins leave stock at the card's last stage.
                </span>
              </div>
            </div>
          )}

          {!editing && error && <p className="text-red-600 text-xs">{error}</p>}

          {/* What the list says, for comparison — this is where the default came from. */}
          {!editing && data.list?.length > 0 && (
            <p className="text-[11px] text-gray-400">
              On the item's list: {data.list.map(l => `${l.item_code} × ${fmtQty(l.qty)} (${l.share} for this card${Number(l.rework_qty) > 0 ? `, ${fmtQty(l.rework_qty)} from rework` : ''})`).join(' · ')}
            </p>
          )}
          {!editing && rows.some(r => r.source === 'design' && r.updated_by_name) && (
            <p className="text-[11px] text-gray-400">
              Last changed by {rows.find(r => r.source === 'design' && r.updated_by_name).updated_by_name}
              {rows.find(r => r.source === 'design' && r.updated_at)?.updated_at ? ` on ${fmtDateTime(rows.find(r => r.source === 'design' && r.updated_at).updated_at)}` : ''}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
