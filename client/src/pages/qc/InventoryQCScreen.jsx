import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../lib/api';
import Modal from '../../components/ui/Modal';
import StatusBadge from '../../components/ui/StatusBadge';
import { fmtDateTime } from '../../lib/utils';
import {
  CheckCircle, AlertTriangle, Lock, Plus, ArrowLeftRight, Search,
  ChevronDown, ChevronUp, Loader2, Truck, Package
} from 'lucide-react';

// ══ Inventory QC (owner, 6 Oct 2026) ═════════════════════════════════════════
// Product QC → Inventory QC → Dispatch. QC sees every item this card took from
// start to finish and puts right what really left stock: take more, give back,
// swap a wrongly taken item, put recovered pieces into the rework bin, add
// scrap. Rejected and remade pieces need nothing extra — any real difference is
// corrected here. "Inventory QC done" then sends the card on to Dispatch /
// Finished Goods, and that is the final change to its inventory, ever.

// Where Product QC sent the pieces, in words.
export function routeText(route, dispQty, fgQty) {
  if (!route) return null;
  if (route === 'dispatch')       return `${dispQty ?? '—'} → Dispatch`;
  if (route === 'finished_goods') return `${fgQty ?? '—'} → Finished Goods`;
  if (route === 'both')           return `${fgQty ?? '—'} → Finished Goods + ${dispQty ?? '—'} → Dispatch`;
  if (route === 'split')          return `${fgQty ?? '—'} → Finished Goods (IO) + ${dispQty ?? '—'} → Dispatch`;
  // every piece rejected in production — nothing goes anywhere (owner, 7 Oct 2026)
  if (route === 'rejected')       return 'Nothing to send — all pieces rejected, closes as Rejected';
  return route;
}

const fmtN = (n) => (n == null || n === '' ? '—'
  : Number(n).toLocaleString('en-IN', { maximumFractionDigits: 4 }));

// Rework is for whole counted parts only — the same units the server accepts
// (lib/rework.js isPieceUnit). Fins go by weight, never into a rework bin.
const PIECE_UNITS = new Set(['pcs', 'pc', 'nos', 'no', 'piece', 'pieces', 'set', 'sets', 'box', 'boxes']);
const isPiece = (u) => PIECE_UNITS.has(String(u || '').trim().toLowerCase().replace(/\.$/, ''));
const isFins = (i) => String(i?.category || '').trim().toLowerCase() === 'finns';
const canRework = (i) => i.on_list && isPiece(i.unit) && !isFins(i);
// What this card still holds of an item that could go into the rework bin:
// what it took (less what it gave back), plus rework-bin draws, less what it
// already put back into the bin. The server checks the same.
const reworkCap = (i) => Math.max(0, Math.floor(
  Number(i.taken) - Number(i.given_back) + Number(i.from_rework_bin) - Number(i.reworked) + 1e-9));

const KIND = {
  take:      { label: 'Take more', verb: 'Take',      cls: 'text-brand-700 border-brand-200 hover:bg-brand-50' },
  give_back: { label: 'Give back', verb: 'Give back', cls: 'text-green-700 border-green-200 hover:bg-green-50' },
  scrap:     { label: 'Scrap',     verb: 'Scrap',     cls: 'text-red-700 border-red-200 hover:bg-red-50' },
  rework:    { label: 'Rework',    verb: 'Rework',    cls: 'text-sky-700 border-sky-200 hover:bg-sky-50' },
};

const TX_LABEL = {
  dispatch_to_production: 'Taken',
  return_from_production: 'Given back',
  scrap: 'Scrap',
};

export default function InventoryQCScreen({ cardId, onClose, onChanged }) {
  const [view, setView] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState(null); // { tone: 'green'|'amber'|'red', text, negative? }
  const [action, setAction] = useState(null);  // { item, kind } — one row's change
  const [showAdd, setShowAdd] = useState(false);
  const [showSwap, setShowSwap] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [showMoves, setShowMoves] = useState(false);
  const [inventory, setInventory] = useState(null); // full inventory list for Add / Swap

  const load = async () => {
    try {
      const r = await api.get(`/qc/${cardId}/inventory`);
      setView(r.data);
      setLoadError('');
    } catch (e) {
      setLoadError(e.response?.data?.error || 'Failed to load this card\'s inventory');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [cardId]);

  const needInventory = () => {
    if (!inventory) api.get('/inventory').then(r => setInventory(r.data)).catch(() => setInventory([]));
  };

  // The last-stage take had not happened and was just made: QC must look at
  // what really left stock before changing anything, so reload and say so.
  const lastStageJustTaken = async (e) => {
    setNotice({ tone: 'amber', text: e.response?.data?.error || 'The rest of this card\'s list was only now taken from stock — please review it, then try again.' });
    await load();
    onChanged?.();
  };

  // Send one or more changes in one go (a swap is two). Throws the server's
  // message for the dialog to show; a 409 closes the dialog and reloads.
  const apply = async (changes) => {
    try {
      const r = await api.post(`/qc/${cardId}/inventory/adjust`, { changes });
      setNotice({
        tone: r.data.negative?.length ? 'amber' : 'green',
        text: r.data.message || 'Saved',
        negative: r.data.negative || [],
      });
      await load();
      onChanged?.();
      return true;
    } catch (e) {
      if (e.response?.status === 409 && e.response?.data?.code === 'LAST_STAGE_JUST_TAKEN') {
        await lastStageJustTaken(e);
        return true; // close the dialog — the screen now shows the fresh figures
      }
      throw new Error(e.response?.data?.error || 'Failed to save the change');
    }
  };

  const markDone = async () => {
    try {
      const r = await api.put(`/qc/${cardId}/inventory-done`);
      setNotice({ tone: 'green', text: `Inventory QC done — ${routeText(r.data.route, r.data.dispatch_qty, r.data.fg_qty) || 'sent on'}.` });
      await load();
      onChanged?.();
      return true;
    } catch (e) {
      if (e.response?.status === 409 && e.response?.data?.code === 'LAST_STAGE_JUST_TAKEN') {
        await lastStageJustTaken(e);
        return true;
      }
      throw new Error(e.response?.data?.error || 'Failed to finish Inventory QC');
    }
  };

  const card = view?.card;
  const title = card ? `Inventory QC — ${card.job_card_no}` : 'Inventory QC';
  const editable = !!view?.editable;
  const canFinish = card?.status === 'inventory_qc';
  const negativeItems = (view?.items || []).filter(i => i.current_stock != null && Number(i.current_stock) < 0);

  return (
    <>
    <Modal open title={title} onClose={onClose} size="full">
      {loading ? (
        <div className="py-16 text-center text-gray-400">Loading...</div>
      ) : loadError ? (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{loadError}</div>
      ) : (
        <div className="space-y-4">
          {/* ── Card ── */}
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-gray-900 text-base">{card.job_card_no}</span>
                <StatusBadge status={card.status} />
                {card.is_fg && (
                  <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full font-medium">Finished-goods card</span>
                )}
              </div>
              <div className="text-sm text-gray-600 mt-0.5">
                <Link to={`/orders/${card.order_id}`} className="text-brand-600 hover:underline font-medium">{card.order_code}</Link>
                {card.drawing_no && <> · {card.drawing_no}</>}
                {' · '}Qty: {card.qty}
                {view.item && <span className="text-gray-400"> · order line qty {view.item.quantity}</span>}
              </div>
              <div className="text-xs text-gray-500 mt-1 space-y-0.5">
                {card.product_qc_at && (
                  <div>Product QC: {card.product_qc_by_name || '—'} · {fmtDateTime(card.product_qc_at)}</div>
                )}
                {card.inventory_qc_at && (
                  <div>Inventory QC: {card.inventory_qc_by_name || '—'} · {fmtDateTime(card.inventory_qc_at)}</div>
                )}
                {!card.last_stage_taken_at && editable && (
                  <div className="text-amber-700">The rest of the list has not been taken at the last stage yet — it is taken before the first change.</div>
                )}
              </div>
            </div>
          </div>

          {notice && (
            <div className={`rounded-lg px-3 py-2 text-sm border ${
              notice.tone === 'green' ? 'bg-green-50 border-green-200 text-green-800'
              : notice.tone === 'red' ? 'bg-red-50 border-red-200 text-red-700'
              : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
              {notice.text}
              {notice.negative?.length > 0 && (
                <div className="mt-1 text-xs">
                  Stock is now below zero for{' '}
                  {notice.negative.map((n, i) => (
                    <span key={n.inventory_item_id}>{i > 0 && ', '}<b>{n.item_code}</b> ({fmtN(n.current_stock)} {n.unit})</span>
                  ))}
                  {' '}— saved anyway; production is never blocked. Check the stock count.
                </div>
              )}
            </div>
          )}

          {!editable && (
            <div className="rounded-lg px-3 py-2 text-sm border bg-gray-50 border-gray-200 text-gray-700 flex items-center gap-2">
              <Lock size={14} className="text-gray-500 flex-shrink-0" />
              {card.inventory_qc_at
                ? 'Inventory QC is done for this card — its inventory can no longer change. This screen is read-only.'
                : 'This card is not waiting for Inventory QC — read-only.'}
            </div>
          )}

          {view.routing?.route === 'rejected' && (
            <div className="rounded-lg px-3 py-2 text-sm bg-red-50 border border-red-200 text-red-800">
              <b>All {view.card.qty} pieces rejected</b> — this card closes as <b>Rejected</b> after Inventory QC done.
              Settle what it used here as for any card; nothing is dispatched or stocked, and nothing is re-made on its own.
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-3">
            {/* ── Routing Product QC recorded ── */}
            <div className="border border-gray-200 rounded-lg p-3 text-sm">
              <div className="font-medium text-gray-700 mb-1.5 flex items-center gap-1.5">
                <Truck size={14} className="text-brand-500" /> Where the pieces go (recorded at Product QC)
              </div>
              {view.routing?.route ? (
                <div className="space-y-0.5 text-gray-700">
                  <div className="font-semibold">{routeText(view.routing.route, view.routing.dispatch_qty, view.routing.fg_qty)}</div>
                  {view.routing.fg_location && <div className="text-xs text-gray-500">Finished Goods location: {view.routing.fg_location}</div>}
                  {view.routing.split_notes && <div className="text-xs text-gray-500">{view.routing.split_notes}</div>}
                  {canFinish && (
                    <div className="text-[11px] text-gray-400 pt-1">Carried out when Inventory QC is done.</div>
                  )}
                </div>
              ) : <div className="text-xs text-gray-400">Nothing recorded.</div>}
            </div>

            {/* ── The card's material figures ── */}
            <div className="border border-gray-200 rounded-lg p-3 text-sm">
              <div className="font-medium text-gray-700 mb-1.5 flex items-center gap-1.5">
                <Package size={14} className="text-brand-500" /> Material figures on this card
              </div>
              <MaterialFigures m={view.materials} />
            </div>
          </div>

          {view.counted_locked && editable && (
            <div className="text-xs rounded-lg px-3 py-2 bg-amber-50 border border-amber-200 text-amber-800 flex items-start gap-2">
              <Lock size={13} className="mt-0.5 flex-shrink-0" />
              This card was through QC or dispatched before Inventory QC went live, so tube and NUT-BR-M4-08 stay as they are on it.
            </div>
          )}

          {/* ── Items ── */}
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between gap-2 flex-wrap">
              <span className="text-sm font-semibold text-gray-700">Inventory this card took — start to finish</span>
              {editable && (
                <div className="flex gap-2">
                  <button className="btn-secondary btn-sm" onClick={() => { needInventory(); setShowAdd(true); }}>
                    <Plus size={13} /> Add item used
                  </button>
                  <button className="btn-secondary btn-sm" onClick={() => { needInventory(); setShowSwap(true); }}>
                    <ArrowLeftRight size={13} /> Swap wrong item
                  </button>
                </div>
              )}
            </div>
            {view.items.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-gray-400">No inventory moved for this card and nothing on the list.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50/50 border-b border-gray-100">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Item</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Unit</th>
                      <th className="px-3 py-2 text-right text-xs font-semibold text-gray-500 uppercase">Taken</th>
                      <th className="px-3 py-2 text-right text-xs font-semibold text-gray-500 uppercase">Given back</th>
                      <th className="px-3 py-2 text-right text-xs font-semibold text-gray-500 uppercase">Scrap</th>
                      <th className="px-3 py-2 text-right text-xs font-semibold text-gray-500 uppercase">Net</th>
                      <th className="px-3 py-2 text-right text-xs font-semibold text-gray-500 uppercase" title="This card's share of the order line">List for card</th>
                      <th className="px-3 py-2 text-right text-xs font-semibold text-gray-500 uppercase">Stock now</th>
                      {editable && <th className="px-3 py-2 text-right text-xs font-semibold text-gray-500 uppercase">Change</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {view.items.map(i => {
                      // Fins go by tube length on a production card, so its list
                      // figure is no guide; on a finished-goods card they are typed in kg.
                      const byLength = isFins(i) && !card.is_fg;
                      const off = i.on_list && i.list_qty_for_card != null && !byLength
                        && Math.abs(Number(i.net) - Number(i.list_qty_for_card)) > 1e-6;
                      return (
                        <tr key={i.inventory_item_id} className="hover:bg-gray-50 align-top">
                          <td className="px-3 py-2">
                            <div className="font-mono text-xs text-gray-900">{i.item_code}</div>
                            <div className="text-xs text-gray-500">{i.name}</div>
                            <div className="flex gap-1 flex-wrap mt-0.5">
                              {!i.on_list && <span className="text-[10px] bg-gray-100 text-gray-600 px-1.5 rounded">not on list</span>}
                              {i.material && <span className="text-[10px] bg-blue-50 text-blue-700 px-1.5 rounded">by FIFO lots</span>}
                              {i.locked && <span className="text-[10px] bg-amber-100 text-amber-800 px-1.5 rounded flex items-center gap-0.5"><Lock size={9} /> locked</span>}
                              {Number(i.from_rework_bin) > 0 && <span className="text-[10px] bg-sky-50 text-sky-700 px-1.5 rounded">{fmtN(i.from_rework_bin)} from rework bin</span>}
                              {Number(i.reworked) > 0 && <span className="text-[10px] bg-sky-100 text-sky-800 px-1.5 rounded">{fmtN(i.reworked)} put in rework bin</span>}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-xs text-gray-500">{i.unit}</td>
                          <td className="px-3 py-2 text-right">{fmtN(i.taken)}</td>
                          <td className="px-3 py-2 text-right text-green-700">{Number(i.given_back) ? fmtN(i.given_back) : '—'}</td>
                          <td className="px-3 py-2 text-right text-red-700">{Number(i.scrap) ? fmtN(i.scrap) : '—'}</td>
                          <td className={`px-3 py-2 text-right font-semibold ${off ? 'text-orange-600' : 'text-gray-900'}`}
                            title={off ? 'Differs from the list for this card' : undefined}>{fmtN(i.net)}</td>
                          <td className="px-3 py-2 text-right text-gray-600">
                            {byLength && i.on_list ? <span className="text-xs text-emerald-700">by tube length</span>
                              : i.no_guide ? <span className="text-xs text-gray-500" title={i.no_guide}>—</span>
                              : fmtN(i.list_qty_for_card)}
                            {i.list_qty_per_piece != null && !byLength && (
                              <div className="text-[10px] text-gray-400">{fmtN(i.list_qty_per_piece)} / pc</div>
                            )}
                          </td>
                          <td className={`px-3 py-2 text-right ${Number(i.current_stock) < 0 ? 'text-red-600 font-semibold' : 'text-gray-600'}`}>
                            {fmtN(i.current_stock)}
                            {Number(i.rework_bin) > 0 && <div className="text-[10px] text-sky-700">bin: {fmtN(i.rework_bin)}</div>}
                          </td>
                          {editable && (
                            <td className="px-3 py-2 text-right">
                              {i.locked ? (
                                <span className="text-xs text-gray-400">locked</span>
                              ) : (
                                <div className="flex gap-1 justify-end flex-wrap">
                                  {['take', 'give_back', 'scrap', ...(canRework(i) ? ['rework'] : [])].map(k => (
                                    <button key={k}
                                      className={`text-[11px] px-2 py-1 rounded-md border bg-white font-medium whitespace-nowrap ${KIND[k].cls}`}
                                      onClick={() => setAction({ item: i, kind: k })}>
                                      {KIND[k].label}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Changes made at Inventory QC ── */}
          <div className="border border-indigo-100 bg-indigo-50/40 rounded-lg p-3">
            <div className="text-sm font-semibold text-gray-700 mb-1.5">
              Changes made at Inventory QC ({view.changes.length})
            </div>
            {view.changes.length === 0 ? (
              <p className="text-xs text-gray-500">None yet — the inventory stands as the card took it.</p>
            ) : (
              <ul className="space-y-1">
                {view.changes.map(c => (
                  <li key={c.id} className="text-xs text-gray-700 flex justify-between gap-3">
                    <span>{c.description}</span>
                    <span className="text-gray-400 whitespace-nowrap">{c.created_by_name || '—'} · {fmtDateTime(c.created_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ── Every stock movement, for reference ── */}
          <div className="border border-gray-200 rounded-lg">
            <button className="w-full px-3 py-2 flex items-center justify-between text-sm font-medium text-gray-700"
              onClick={() => setShowMoves(v => !v)}>
              <span>Every stock movement of this card ({view.movements.length})
                {view.item_level.length > 0 && <span className="text-gray-400 font-normal"> · {view.item_level.length} item-level</span>}
              </span>
              {showMoves ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
            {showMoves && (
              <div className="border-t border-gray-100 px-3 py-2 space-y-3">
                <MovesTable rows={view.movements} withBalance />
                {view.item_level.length > 0 && (
                  <div>
                    <div className="text-xs font-semibold text-gray-600 mb-1">Item-level, not by card</div>
                    <p className="text-[11px] text-gray-500 mb-1">Taken for the whole order line at once, so they cannot be tied to one card. For reference only.</p>
                    <MovesTable rows={view.item_level} />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Footer ── */}
          <div className="flex items-center justify-end gap-3 pt-1 flex-wrap">
            <button className="btn-secondary" onClick={onClose}>Close</button>
            {canFinish && (
              <button className="btn-primary bg-indigo-600 hover:bg-indigo-700 border-indigo-600"
                onClick={() => setShowDone(true)}>
                <CheckCircle size={15} /> {view.routing?.route === 'rejected' ? 'Inventory QC done → close as Rejected' : 'Inventory QC done → send to Dispatch / Finished Goods'}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>

    {action && (
      <ChangeModal
        item={action.item}
        kind={action.kind}
        onClose={() => setAction(null)}
        onSubmit={async (qty, note) => {
          const ok = await apply([{ inventory_item_id: action.item.inventory_item_id, kind: action.kind, qty, note }]);
          if (ok) setAction(null);
        }}
      />
    )}

    {showAdd && (
      <AddItemModal
        inventory={inventory}
        countedLocked={!!view?.counted_locked}
        onClose={() => setShowAdd(false)}
        onSubmit={async (inv, qty, note) => {
          const ok = await apply([{ inventory_item_id: inv.id, kind: 'take', qty, note }]);
          if (ok) setShowAdd(false);
        }}
      />
    )}

    {showSwap && (
      <SwapModal
        items={(view?.items || []).filter(i => !i.locked && Number(i.net) > 0)}
        inventory={inventory}
        countedLocked={!!view?.counted_locked}
        onClose={() => setShowSwap(false)}
        onSubmit={async (wrong, wrongQty, right, rightQty, note) => {
          const why = `Swap ${wrong.item_code} → ${right.item_code}${note ? ` — ${note}` : ''}`;
          const ok = await apply([
            { inventory_item_id: wrong.inventory_item_id, kind: 'give_back', qty: wrongQty, note: why },
            { inventory_item_id: right.id, kind: 'take', qty: rightQty, note: why },
          ]);
          if (ok) setShowSwap(false);
        }}
      />
    )}

    {showDone && view && (
      <DoneModal
        view={view}
        negativeItems={negativeItems}
        onClose={() => setShowDone(false)}
        onConfirm={async () => {
          const ok = await markDone();
          if (ok) setShowDone(false);
        }}
      />
    )}
    </>
  );
}

// ── The card's own material figures (job_cards) ───────────────────────────────
function MaterialFigures({ m }) {
  if (!m) return null;
  const rows = [
    { label: 'Coil wire', used: m.coil_used_qty, scrap: m.coil_scrap_qty, unit: 'kg', done: m.coil_deducted },
    { label: 'Tube', used: m.tube_used_qty, scrap: m.tube_scrap_qty, unit: 'ft', done: m.tube_deducted },
    { label: 'Filling bush', used: m.fill_pvc_qty, unit: 'pcs', done: m.fill_deducted },
    { label: 'MgO powder', used: m.fill_mgo_qty, unit: 'kg', done: m.fill_deducted },
    { label: 'Fins', used: m.fins_kg, unit: 'kg', done: m.fins_deducted },
  ];
  return (
    <ul className="space-y-0.5">
      {rows.map(r => (
        <li key={r.label} className="flex justify-between text-xs text-gray-700">
          <span>{r.label}</span>
          {r.done || (r.used != null && r.used !== '') ? (
            <span className="font-medium">
              {fmtN(r.used)} {r.unit}
              {r.scrap != null && Number(r.scrap) > 0 && <span className="text-red-600 font-normal"> + {fmtN(r.scrap)} scrap</span>}
            </span>
          ) : <span className="text-gray-400">not taken</span>}
        </li>
      ))}
    </ul>
  );
}

function MovesTable({ rows, withBalance = false }) {
  if (!rows.length) return <p className="text-xs text-gray-400">None.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-500 border-b border-gray-100">
            <th className="text-left py-1 pr-2 font-semibold">When</th>
            <th className="text-left py-1 pr-2 font-semibold">Item</th>
            <th className="text-left py-1 pr-2 font-semibold">Move</th>
            <th className="text-right py-1 pr-2 font-semibold">Qty</th>
            {withBalance && <th className="text-right py-1 pr-2 font-semibold">Stock after</th>}
            <th className="text-left py-1 pr-2 font-semibold">Notes</th>
            {withBalance && <th className="text-left py-1 font-semibold">By</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {rows.map(t => (
            <tr key={t.id} className="align-top">
              <td className="py-1 pr-2 whitespace-nowrap text-gray-500">{fmtDateTime(t.created_at)}</td>
              <td className="py-1 pr-2 font-mono">{t.item_code}</td>
              <td className="py-1 pr-2">{TX_LABEL[t.transaction_type] || t.transaction_type.replace(/_/g, ' ')}</td>
              <td className="py-1 pr-2 text-right">{fmtN(t.quantity)} {t.unit}</td>
              {withBalance && <td className="py-1 pr-2 text-right text-gray-500">{fmtN(t.balance_after)}</td>}
              <td className="py-1 pr-2 text-gray-600">{t.notes}</td>
              {withBalance && <td className="py-1 text-gray-500 whitespace-nowrap">{t.created_by_name || '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── One change on one item: take more / give back / scrap / rework ────────────
function ChangeModal({ item, kind, onClose, onSubmit }) {
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const k = KIND[kind];
  const q = parseFloat(qty);
  const cap = kind === 'rework' ? reworkCap(item) : null;
  const heldForCard = Number(item.taken) - Number(item.given_back);

  const submit = async () => {
    setError('');
    if (!(q > 0)) return setError('Enter a quantity above 0');
    if (kind === 'rework') {
      if (!Number.isInteger(q)) return setError('Rework is whole pieces only');
      if (q > cap) return setError(`Only ${cap} left to rework from this card`);
    }
    setSaving(true);
    try { await onSubmit(q, note.trim()); }
    catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  const explain = {
    take: `Takes ${qty || 'this many'} ${item.unit} more of ${item.item_code} from stock for this card.`,
    give_back: `Puts ${qty || 'this many'} ${item.unit} of ${item.item_code} back into stock from this card.`,
    scrap: `Takes ${qty || 'this many'} ${item.unit} of ${item.item_code} from stock as scrap on this card — on top of the list.`,
    rework: `Puts ${qty || 'this many'} recovered whole piece(s) of ${item.item_code} into its rework bin — kept apart from stock; a later order can draw on them.`,
  }[kind];

  return (
    <Modal open title={`${k.label} — ${item.item_code}`} onClose={onClose} size="sm">
      <div className="space-y-3">
        <div className="text-xs text-gray-600 bg-gray-50 border border-gray-100 rounded-lg p-2.5 space-y-0.5">
          <div className="font-medium text-gray-800">{item.name}</div>
          <div>This card: taken {fmtN(item.taken)} · given back {fmtN(item.given_back)} · scrap {fmtN(item.scrap)} · net <b>{fmtN(item.net)}</b> {item.unit}</div>
          {item.on_list && item.list_qty_for_card != null && <div>List for this card: {fmtN(item.list_qty_for_card)} {item.unit}</div>}
          <div>Stock now: {fmtN(item.current_stock)} {item.unit}</div>
          {item.material && <div className="text-blue-700">Moves by FIFO lots, as the stages do; the card's material figures follow.</div>}
        </div>
        <div>
          <label className="label">Qty ({item.unit}){kind === 'rework' && <span className="normal-case font-normal text-gray-400"> · max {cap}</span>}</label>
          <input className="input" type="number" min="0" step={kind === 'rework' ? '1' : 'any'} autoFocus
            value={qty} onChange={e => setQty(e.target.value)} />
        </div>
        {kind === 'give_back' && q > heldForCard + 1e-9 && (
          <p className="text-xs text-amber-700">This is more than the card took of it ({fmtN(heldForCard)} {item.unit}). Check before saving.</p>
        )}
        <div>
          <label className="label">Note <span className="normal-case font-normal text-gray-400">(optional — why)</span></label>
          <input className="input" value={note} onChange={e => setNote(e.target.value)}
            placeholder={kind === 'scrap' ? 'e.g. 2 tubes cracked at bending' : kind === 'rework' ? 'e.g. flanges pulled off rejected pieces' : 'e.g. 3 pieces remade'} />
        </div>
        <p className="text-xs text-gray-500">{explain}</p>
        {error && <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={saving}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            {saving ? 'Saving...' : k.verb}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Search the whole inventory for an item — used by Add item and Swap.
function InventoryPicker({ inventory, value, onPick, countedLocked }) {
  const [q, setQ] = useState('');
  const matches = useMemo(() => {
    if (!inventory) return [];
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return inventory.filter(i =>
      (i.item_code || '').toLowerCase().includes(s) ||
      (i.name || '').toLowerCase().includes(s) ||
      (i.category || '').toLowerCase().includes(s)
    ).slice(0, 10);
  }, [inventory, q]);

  if (value) return (
    <div className="flex items-center justify-between gap-2 border border-brand-200 bg-brand-50 rounded-lg px-3 py-2 text-sm">
      <span><span className="font-mono">{value.item_code}</span> — {value.name}
        <span className="text-xs text-gray-500"> · stock {fmtN(value.current_stock)} {value.unit}</span></span>
      <button className="text-xs text-brand-600 hover:underline" onClick={() => onPick(null)}>Change</button>
    </div>
  );
  return (
    <div>
      <div className="relative">
        <Search size={15} className="absolute left-3 top-3 text-gray-400" />
        <input className="input pl-9" placeholder={inventory ? 'Search code, name or category…' : 'Loading inventory…'}
          value={q} onChange={e => setQ(e.target.value)} disabled={!inventory} autoFocus />
      </div>
      {matches.length > 0 && (
        <ul className="mt-1 border border-gray-200 rounded-lg divide-y divide-gray-100 max-h-56 overflow-y-auto">
          {matches.map(i => {
            const blocked = countedLocked && isCountedCode(i.item_code);
            return (
              <li key={i.id}>
                <button type="button" disabled={blocked}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={() => onPick(i)}>
                  <span className="font-mono">{i.item_code}</span> — {i.name}
                  <span className="text-gray-400"> · {i.category} · stock {fmtN(i.current_stock)} {i.unit}</span>
                  {blocked && <span className="text-amber-700"> · locked on this card</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Tube (TUB-*) and NUT-BR-M4-08 — the counted items (server lib/countedStock.js).
const isCountedCode = (code) => {
  const c = String(code || '').trim().toUpperCase();
  return c.startsWith('TUB-') || c === 'NUT-BR-M4-08';
};

// ── Add an item the card used that is not on its list / not taken ─────────────
function AddItemModal({ inventory, countedLocked, onClose, onSubmit }) {
  const [inv, setInv] = useState(null);
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    if (!inv) return setError('Pick the item that was used');
    const q = parseFloat(qty);
    if (!(q > 0)) return setError('Enter a quantity above 0');
    setSaving(true);
    try { await onSubmit(inv, q, note.trim()); }
    catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  return (
    <Modal open title="Add item used" onClose={onClose} size="md">
      <div className="space-y-3">
        <p className="text-xs text-gray-500">An item this card used that it has not taken yet. It is taken from stock for this card.</p>
        <div>
          <label className="label">Item</label>
          <InventoryPicker inventory={inventory} value={inv} onPick={setInv} countedLocked={countedLocked} />
        </div>
        <div>
          <label className="label">Qty{inv ? ` (${inv.unit})` : ''}</label>
          <input className="input" type="number" min="0" step="any" value={qty} onChange={e => setQty(e.target.value)} />
        </div>
        <div>
          <label className="label">Note <span className="normal-case font-normal text-gray-400">(optional — why)</span></label>
          <input className="input" value={note} onChange={e => setNote(e.target.value)} />
        </div>
        {error && <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={saving}>{saving ? 'Saving...' : 'Take from stock'}</button>
        </div>
      </div>
    </Modal>
  );
}

// ── Swap: give back the wrong item, take the right one — one save ────────────
function SwapModal({ items, inventory, countedLocked, onClose, onSubmit }) {
  const [wrongId, setWrongId] = useState('');
  const [wrongQty, setWrongQty] = useState('');
  const [right, setRight] = useState(null);
  const [rightQty, setRightQty] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const wrong = items.find(i => String(i.inventory_item_id) === String(wrongId)) || null;

  const pickWrong = (id) => {
    setWrongId(id);
    const w = items.find(i => String(i.inventory_item_id) === String(id));
    if (w) { setWrongQty(String(w.net)); if (!rightQty) setRightQty(String(w.net)); }
  };

  const submit = async () => {
    setError('');
    if (!wrong) return setError('Pick the wrong item that was taken');
    if (!right) return setError('Pick the right item');
    if (right.id === wrong.inventory_item_id) return setError('The right item is the same as the wrong one');
    const wq = parseFloat(wrongQty), rq = parseFloat(rightQty);
    if (!(wq > 0) || !(rq > 0)) return setError('Enter both quantities above 0');
    setSaving(true);
    try { await onSubmit(wrong, wq, right, rq, note.trim()); }
    catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  return (
    <Modal open title="Swap wrong item" onClose={onClose} size="md">
      <div className="space-y-3">
        <p className="text-xs text-gray-500">The card took the wrong item: it goes back into stock and the right one is taken — both in one save.</p>
        <div className="border border-green-200 bg-green-50/40 rounded-lg p-3 space-y-2">
          <div className="text-xs font-semibold text-green-800">Give back (wrong item)</div>
          {items.length === 0 ? (
            <p className="text-xs text-gray-500">This card holds nothing that can be given back.</p>
          ) : (
            <select className="input" value={wrongId} onChange={e => pickWrong(e.target.value)}>
              <option value="">— Pick the wrong item —</option>
              {items.map(i => (
                <option key={i.inventory_item_id} value={i.inventory_item_id}>
                  {i.item_code} — {i.name} (net {fmtN(i.net)} {i.unit})
                </option>
              ))}
            </select>
          )}
          <input className="input" type="number" min="0" step="any" placeholder={`Qty${wrong ? ` (${wrong.unit})` : ''}`}
            value={wrongQty} onChange={e => setWrongQty(e.target.value)} />
        </div>
        <div className="border border-brand-200 bg-brand-50/40 rounded-lg p-3 space-y-2">
          <div className="text-xs font-semibold text-brand-800">Take (right item)</div>
          <InventoryPicker inventory={inventory} value={right} onPick={setRight} countedLocked={countedLocked} />
          <input className="input" type="number" min="0" step="any" placeholder={`Qty${right ? ` (${right.unit})` : ''}`}
            value={rightQty} onChange={e => setRightQty(e.target.value)} />
        </div>
        <div>
          <label className="label">Note <span className="normal-case font-normal text-gray-400">(optional — why)</span></label>
          <input className="input" value={note} onChange={e => setNote(e.target.value)} />
        </div>
        {error && <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={saving}>{saving ? 'Saving...' : 'Swap'}</button>
        </div>
      </div>
    </Modal>
  );
}

// ── "Inventory QC done" confirmation — every change, then the final send ──────
function DoneModal({ view, negativeItems, onClose, onConfirm }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const r = view.routing || {};
  const fgQty = Number(r.fg_qty) || 0;
  const dispQty = Number(r.dispatch_qty) || 0;
  const toFg = ['finished_goods', 'both', 'split'].includes(r.route) && fgQty > 0;

  const confirm = async () => {
    setSaving(true);
    setError('');
    try { await onConfirm(); }
    catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  return (
    <Modal open title={`Inventory QC done — ${view.card.job_card_no}`} onClose={onClose} size="md">
      <div className="space-y-4">
        <div>
          <div className="text-sm font-semibold text-gray-700 mb-1">Changes made at Inventory QC ({view.changes.length})</div>
          {view.changes.length === 0 ? (
            <p className="text-xs text-gray-500">No changes — the inventory stays as the card took it.</p>
          ) : (
            <ul className="text-xs text-gray-700 space-y-0.5 list-disc ml-4">
              {view.changes.map(c => <li key={c.id}>{c.description}</li>)}
            </ul>
          )}
        </div>

        <div className="border border-gray-200 rounded-lg p-3 text-sm">
          <div className="font-semibold text-gray-700 mb-1">{r.route === 'rejected' ? 'Then the card closes' : 'Then the card goes on'}</div>
          <ul className="text-xs text-gray-700 space-y-0.5">
            {r.route === 'rejected' && <li>• Closed as <b>Rejected</b> — all {view.card.qty} pieces rejected at production. Nothing to dispatch or stock; the owner decides about the pieces.</li>}
            {toFg && <li>• {fgQty} piece{fgQty !== 1 ? 's' : ''} into Finished Goods{r.fg_location ? ` (${r.fg_location})` : ''}</li>}
            {(r.route === 'dispatch' || r.route === 'both' || r.route === 'split' || !r.route) && dispQty > 0 && (
              <li>• {dispQty} piece{dispQty !== 1 ? 's' : ''} to Dispatch</li>
            )}
            {r.route !== 'rejected' && !toFg && dispQty === 0 && <li>• {routeText(r.route, r.dispatch_qty, r.fg_qty) || 'Dispatch'}</li>}
          </ul>
        </div>

        {negativeItems.length > 0 && (
          <div className="text-xs rounded-lg px-3 py-2 bg-amber-50 border border-amber-200 text-amber-800">
            <AlertTriangle size={12} className="inline mr-1" />
            Stock is below zero for {negativeItems.map(i => i.item_code).join(', ')}. It does not stop this card — check the stock count.
          </div>
        )}

        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          This is the <b>final change to this card's inventory, ever</b>. After this nothing on it can be taken,
          given back, swapped, reworked or scrapped.
        </p>

        {error && <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary bg-indigo-600 hover:bg-indigo-700 border-indigo-600" onClick={confirm} disabled={saving}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
            {saving ? 'Sending...' : r.route === 'rejected' ? 'Confirm — Inventory QC done, close as Rejected' : 'Confirm — Inventory QC done'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
