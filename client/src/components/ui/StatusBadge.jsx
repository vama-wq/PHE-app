import { STATUS_LABELS, STATUS_COLORS, isAllToFinishedGoods } from '../../lib/utils';

// Pass the whole job card as `jc` when you have it: a card whose entire qty
// went to Finished Goods is still stored as 'qc_approved', but calling it that
// on screen reads as "waiting to dispatch", which it is not.
export default function StatusBadge({ status, jc = null, className = '' }) {
  const s = jc?.status ?? status;
  const inFg = jc && isAllToFinishedGoods(jc);
  const label = inFg ? 'In Finished Goods' : (STATUS_LABELS[s] || s);
  const color = inFg ? 'bg-teal-100 text-teal-800' : (STATUS_COLORS[s] || 'bg-gray-100 text-gray-700');
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${color} ${className}`}>
      {label}
    </span>
  );
}
