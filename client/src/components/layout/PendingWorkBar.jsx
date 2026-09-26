import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { ListChecks } from 'lucide-react';
import { useWorkStore } from '../../store/workStore';
import { NAV_ITEMS } from './Sidebar';

// The pill on the sidebar says HOW MUCH is waiting; this says WHAT, on the
// page the person just opened to deal with it. One line, gone when the
// count reaches zero. Same numbers as the pill — one store feeds both.
export default function PendingWorkBar() {
  const { pathname } = useLocation();
  const { detail, fetch } = useWorkStore();

  // Re-read on every navigation so finishing something and moving on shows
  // the list shrink, without waiting for the 30s poll.
  useEffect(() => { fetch(); }, [pathname]);

  // Longest matching nav path wins; the dashboard only matches exactly.
  const item = NAV_ITEMS
    .filter(n => n.to === '/' ? pathname === '/' : pathname === n.to || pathname.startsWith(n.to + '/'))
    .sort((a, b) => b.to.length - a.to.length)[0];
  const lines = item ? (detail[item.id] || []) : [];
  if (!lines.length) return null;
  const total = lines.reduce((s, [, n]) => s + n, 0);

  return (
    <div className="sticky top-0 z-10 bg-amber-50 border-b border-amber-200 text-amber-900 px-6 py-2 text-sm flex items-start gap-2">
      <ListChecks size={16} className="mt-0.5 flex-shrink-0 text-amber-600" />
      <div className="min-w-0">
        <span className="font-semibold">{total} waiting on you here: </span>
        {lines.map(([label, n], i) => (
          <span key={label}>
            {i > 0 && <span className="text-amber-400 mx-1.5">·</span>}
            <span className="font-medium">{n}</span> {label}
          </span>
        ))}
      </div>
    </div>
  );
}
