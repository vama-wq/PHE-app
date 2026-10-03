// Units written different ways that mean the same thing (pcs = nos, kg = kgs,
// foot = ft …). A PO line may be bought in another unit from the one its item
// is stocked in — copper tube is billed in kg and used in feet — and stock
// always comes in in the ITEM's unit (owner, 3 Oct 2026). Mirrored in
// client/src/lib/utils.js.
const UNIT_GROUPS = [
  ['pc', 'pcs', 'piece', 'pieces', 'no', 'nos', 'number', 'numbers', 'each', 'ea', 'unit', 'units'],
  ['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms'],
  ['ft', 'foot', 'feet'],
  ['m', 'mtr', 'mtrs', 'metre', 'metres', 'meter', 'meters'],
  ['g', 'gm', 'gms', 'gram', 'grams'],
  ['set', 'sets'],
  ['box', 'boxes'],
  ['l', 'ltr', 'ltrs', 'litre', 'litres', 'liter', 'liters'],
];
const normUnit = (u) => String(u || '').trim().toLowerCase().replace(/\.$/, '');
const unitKey = (u) => { const s = normUnit(u); const g = UNIT_GROUPS.findIndex(x => x.includes(s)); return g >= 0 ? `g${g}` : s; };
// A blank unit on either side is treated as the same (nothing to convert).
const sameUnit = (a, b) => !normUnit(a) || !normUnit(b) || unitKey(a) === unitKey(b);

module.exports = { UNIT_GROUPS, normUnit, unitKey, sameUnit };
