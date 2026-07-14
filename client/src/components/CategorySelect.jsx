import { useEffect, useState } from 'react';
import api from '../lib/api';

// Category picker for inventory items: dropdown of existing categories plus a
// "+ New category…" option that reveals a free-text input.
export default function CategorySelect({ value, onChange }) {
  const [categories, setCategories] = useState([]);
  const [isNew, setIsNew] = useState(false);

  useEffect(() => {
    api.get('/inventory/categories').then(r => {
      setCategories(r.data || []);
      // Editing an item whose category isn't in the list (or list empty) → free text
      if (value && !(r.data || []).includes(value.trim())) setIsNew(true);
    }).catch(() => setIsNew(true));
  }, []);

  if (isNew) {
    return (
      <div className="flex gap-2">
        <input className="input flex-1" placeholder="Type the new category name"
          value={value} onChange={e => onChange(e.target.value)} autoFocus />
        {categories.length > 0 && (
          <button type="button" className="btn-secondary text-xs px-2"
            title="Pick from existing categories"
            onClick={() => { setIsNew(false); onChange(''); }}>List</button>
        )}
      </div>
    );
  }

  return (
    <select className="input" value={value || ''}
      onChange={e => {
        if (e.target.value === '__new__') { setIsNew(true); onChange(''); }
        else onChange(e.target.value);
      }}>
      <option value="">— select category —</option>
      {categories.map(c => <option key={c} value={c}>{c}</option>)}
      <option value="__new__">＋ New category…</option>
    </select>
  );
}
