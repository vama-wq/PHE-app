import { TERMINAL_GROUPS } from '../lib/utils';

// The group a Terminal Pin item belongs to (owner, 26 Oct 2026) — asked every
// time such an item is added or edited, never guessed from its code or name,
// because a job card picks its pins from one group only.
export default function TerminalGroupSelect({ value, onChange }) {
  return (
    <div>
      <label className="label">Terminal Pin Group *</label>
      <select className={`input ${value ? '' : 'border-red-200 bg-red-50/40'}`} value={value || ''}
        onChange={e => onChange(e.target.value)} required>
        <option value="">— Choose its group —</option>
        {TERMINAL_GROUPS.map(g => <option key={g.key} value={g.key}>{g.label}</option>)}
      </select>
      <p className="text-[11px] text-gray-500 mt-0.5">Job cards pick their pins from one group only.</p>
    </div>
  );
}
