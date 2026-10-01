// Current stock beside an inventory item wherever inventory is picked for an
// order item (owner's request, 1 Oct 2026) — the same figure as the Inventory page.
const fmt = (n) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 });

// The tag in a search result, next to the REWORK tag.
export default function StockTag({ item }) {
  const n = Number(item?.current_stock);
  if (!Number.isFinite(n)) return null;
  return n > 0
    ? <span className="ml-1.5 text-[10px] font-semibold bg-green-100 text-green-800 rounded px-1.5 py-0.5 whitespace-nowrap">IN STOCK {fmt(n)}{item.unit ? ` ${item.unit}` : ''}</span>
    : <span className="ml-1.5 text-[10px] font-semibold bg-red-100 text-red-700 rounded px-1.5 py-0.5 whitespace-nowrap">OUT OF STOCK</span>;
}

// The short note on a selected row, beside the quantity box.
export function StockNote({ item }) {
  const n = Number(item?.current_stock);
  if (!Number.isFinite(n)) return null;
  return n > 0
    ? <span className="text-[11px] text-gray-500 whitespace-nowrap">{fmt(n)} in stock</span>
    : <span className="text-[11px] text-red-600 whitespace-nowrap">out of stock</span>;
}
