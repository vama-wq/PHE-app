// Current stock beside an inventory item wherever inventory is picked for an
// order item (owner's request, 1 Oct 2026) — the same figure as the Inventory page.
// With it, what other open orders still have to take and what is FREE for this
// one (owner, 10 Oct 2026) — display only: nothing is deducted or blocked.
const fmt = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 });

// Held by orders other than the one being edited (orderId), and what is free.
export function stockFigures(item, orderId = null) {
  const stock = Number(item?.current_stock);
  const by = (item?.held_by || []).filter(h => orderId == null || String(h.order_id) !== String(orderId));
  const held = Math.round(by.reduce((a, h) => a + (Number(h.qty) || 0), 0) * 1000) / 1000;
  return { stock, held, free: Math.round((stock - held) * 1000) / 1000, by };
}
const heldTitle = (by) => by.length
  ? `Held for: ${by.slice(0, 12).map(h => `${h.order_code} ${fmt(h.qty)}`).join(', ')}${by.length > 12 ? ` and ${by.length - 12} more` : ''}`
  : '';

// The tag in a search result, next to the REWORK tag.
export default function StockTag({ item, orderId = null }) {
  const { stock: n, held, free, by } = stockFigures(item, orderId);
  if (!Number.isFinite(n)) return null;
  return (
    <>
      {n > 0
        ? <span className="ml-1.5 text-[10px] font-semibold bg-green-100 text-green-800 rounded px-1.5 py-0.5 whitespace-nowrap">IN STOCK {fmt(n)}{item.unit ? ` ${item.unit}` : ''}</span>
        : <span className="ml-1.5 text-[10px] font-semibold bg-red-100 text-red-700 rounded px-1.5 py-0.5 whitespace-nowrap">OUT OF STOCK</span>}
      {held > 0 && (
        <span className={`ml-1 text-[10px] font-semibold rounded px-1.5 py-0.5 whitespace-nowrap ${free > 0 ? 'bg-slate-100 text-slate-700' : 'bg-red-100 text-red-700'}`}
          title={heldTitle(by)}>
          {free > 0 ? `FREE ${fmt(free)}` : `SHORT ${fmt(-free)}`} · {fmt(held)} held
        </span>
      )}
    </>
  );
}

// The short note on a selected row, beside the quantity box. qty: what is being
// typed for this order — amber when the free stock does not cover it.
export function StockNote({ item, orderId = null, qty = null }) {
  const { stock: n, held, free, by } = stockFigures(item, orderId);
  if (!Number.isFinite(n)) return null;
  if (!(held > 0)) {
    return n > 0
      ? <span className="text-[11px] text-gray-500 whitespace-nowrap">{fmt(n)} in stock</span>
      : <span className="text-[11px] text-red-600 whitespace-nowrap">out of stock</span>;
  }
  const want = Number(qty);
  const tone = free <= 0 ? 'text-red-600' : (want > 0 && want > free ? 'text-amber-600' : 'text-gray-500');
  return (
    <span className={`text-[11px] whitespace-nowrap ${tone}`} title={heldTitle(by)}>
      {fmt(n)} in stock · {fmt(held)} held · <b>{free > 0 ? `${fmt(free)} free` : `${fmt(-free)} short`}</b>
    </span>
  );
}
