// Heater fittings on a 2in1 / 3in1 / Xin1 item (owner, 12 Oct 2026) — the same
// rules as server/src/lib/heaterFittings.js, which has the final say.
export const FITTINGS = [
  { key: 'pocket', label: 'Pocket', hint: '1 more brazing ring per heater' },
  { key: 'cap', label: 'Cap', hint: 'Flange Cap, Flange Mid Patti and Sleeve on the list; the sleeve is taken by inch at Nut Washer (length per piece × qty)' },
  { key: 'short_patti', label: 'Short Patti', hint: 'one Short Patti on the list' },
  { key: 'gasket', label: 'Gasket', hint: 'one Gasket on the list' },
  { key: 'thermostat', label: 'Thermostat', hint: 'one Thermostat on the list' },
];
const KEYS = FITTINGS.map(f => f.key);
// "None of the above" — an explicit choice, compulsory for an Xin1 item (owner, 16 Oct 2026).
export const NONE = 'none';
export const FITTING_LABEL = { ...Object.fromEntries(FITTINGS.map(f => [f.key, f.label])), [NONE]: 'None' };

const cat = (i) => String(i?.category || '').trim().toLowerCase();
const nm = (i) => String(i?.name || '');
export const isSleeve = (i) => cat(i) === 'flange spare' && /sleeve/i.test(nm(i));
// A Cap heater's sleeve goes by inch at Nut Washer — no quantity on the list.
export const sleeveByWeight = (fittings, i) => normalizeFittings(fittings).includes('cap') && isSleeve(i);
const NEEDS = {
  cap: [
    { label: 'Flange Cap', test: (i) => cat(i) === 'flange cap' },
    { label: 'Flange Mid Patti', test: (i) => /mid\s*patt?i/i.test(nm(i)) && !/sleeve/i.test(nm(i)) },
    { label: 'Sleeve', test: isSleeve },
  ],
  short_patti: [{ label: 'Short Patti', test: (i) => /short\s*patt?i/i.test(nm(i)) }],
  gasket: [{ label: 'Gasket', test: (i) => cat(i) === 'gasket' }],
  thermostat: [{ label: 'Thermostat', test: (i) => /^thermostat/.test(cat(i)) }],
};

export function elementsFromName(...names) {
  for (const n of names) {
    const m = String(n || '').match(/(\d+)\s*in\s*1(?![0-9])/i);
    if (m && parseInt(m[1], 10) > 0) return parseInt(m[1], 10);
  }
  return null;
}
export const isMultiElement = (drawingNumber, productCode) => (elementsFromName(drawingNumber, productCode) || 1) > 1;
// A brazed heater: named "Nin1" for any N >= 1 (owner, 16 Oct 2026) — a "1in1"
// single-element heater is brazed too, so it gets the fittings dropdown.
export const isBrazedHeater = (drawingNumber, productCode) => elementsFromName(drawingNumber, productCode) != null;

export function normalizeFittings(raw) {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = v.split(','); } }
  if (!Array.isArray(v)) return [];
  const set = new Set(v.map(k => String(k || '').trim().toLowerCase()));
  const real = KEYS.filter(k => set.has(k));
  if (real.length) return real;
  return set.has(NONE) ? [NONE] : [];
}
// An Xin1 item must have the fittings chosen (real or None of the above).
export const fittingsChosen = (raw) => normalizeFittings(raw).length > 0;
export const fittingLabels = (raw) => normalizeFittings(raw).map(k => FITTING_LABEL[k]);
// Real fitting parts only — 'none' needs nothing.

// Every part the fittings need, and whether the list (inventory rows) has it.
export function fittingParts(raw, invRows) {
  const out = [];
  for (const k of normalizeFittings(raw)) {
    for (const need of NEEDS[k] || []) {
      out.push({ fitting: k, label: need.label, text: `${FITTING_LABEL[k]}: ${need.label}`, ok: (invRows || []).some(need.test) });
    }
  }
  return out;
}
