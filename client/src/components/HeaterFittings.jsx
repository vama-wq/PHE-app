import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { FITTINGS, normalizeFittings, fittingLabels, fittingParts } from '../lib/heaterFittings';

// The fittings dropdown on an Xin1 item (owner, 12 Oct 2026): tick any number.
export default function HeaterFittingsPicker({ value, onChange, disabled = false }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const picked = normalizeFittings(value);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const toggle = (k) => onChange(normalizeFittings(picked.includes(k) ? picked.filter(x => x !== k) : [...picked, k]));
  return (
    <div className="relative" ref={ref}>
      <button type="button" disabled={disabled}
        className="input flex items-center justify-between text-left disabled:bg-gray-100 disabled:text-gray-500"
        onClick={() => setOpen(o => !o)}>
        <span className={picked.length ? 'text-gray-800' : 'text-gray-400'}>
          {picked.length ? fittingLabels(picked).join(', ') : 'None — tick what this heater has'}
        </span>
        <ChevronDown size={15} className="text-gray-400 flex-shrink-0" />
      </button>
      {open && (
        <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg py-1">
          {FITTINGS.map(f => {
            const on = picked.includes(f.key);
            return (
              <button key={f.key} type="button" className="w-full text-left px-3 py-2 hover:bg-brand-50 flex items-start gap-2.5"
                onClick={() => toggle(f.key)}>
                <span className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${on ? 'bg-brand-600 border-brand-600 text-white' : 'border-gray-300'}`}>
                  {on && <Check size={12} />}
                </span>
                <span>
                  <span className="text-sm font-medium text-gray-800">{f.label}</span>
                  <span className="block text-[11px] text-gray-500">{f.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// "Fittings: Pocket, Cap" — nothing when the item has none.
export function FittingsText({ value, className = 'text-xs' }) {
  const l = fittingLabels(value);
  if (!l.length) return null;
  return (
    <div className={className}>
      <span className="text-gray-400">Fittings: </span>
      <span className="text-gray-700 font-medium">{l.join(', ')}</span>
    </div>
  );
}

// On Design's list: what each ticked fitting needs, ticked off as it is added.
export function FittingsNeeded({ value, invRows }) {
  const parts = fittingParts(value, invRows);
  if (!parts.length) return null;
  const allOk = parts.every(p => p.ok);
  return (
    <div className={`text-[11px] mb-1.5 rounded-lg px-2 py-1.5 border ${allOk ? 'text-green-700 bg-green-50 border-green-200' : 'text-amber-800 bg-amber-50 border-amber-200'}`}>
      <div className="font-medium mb-0.5">Heater fittings: {fittingLabels(value).join(', ')} — the list needs one of each:</div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {parts.map(p => <span key={p.text}>{p.ok ? '✓' : '✗'} {p.text}</span>)}
      </div>
    </div>
  );
}
