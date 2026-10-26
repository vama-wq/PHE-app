// ── Terminal pin groups (owner, 26 Oct 2026) ─────────────────────────────────
// Terminal pins now come in more than one kind on the same stud and length:
// the Regular pin used every day, the One Side Threaded pin, and the No Thread
// pin (the "PL" items). Owner: "your grouping needs to be strong … when adding
// any terminal pin category inventory, make sure to ask which group it belongs
// to … and therefore it remains clear".
//
//   • Every 'Terminal Pin' item carries its group (inventory_items.
//     terminal_group), chosen by a person when the item is added or edited —
//     never worked out from its code or name. An item with no group is never
//     picked for a job card.
//   • Make Job Card asks which group the card's pins come from (Regular unless
//     chosen). The choice is frozen on the card (generated_spec.input.
//     terminalGroup), so the pins it names, its slip and the Spot take all
//     follow it. A card made before groups has no choice stored: Regular.
//   • Within the group the pin is the one on the card's stud at each end's
//     length — With Head at the Big end, Without Head at the Small end. When
//     the group has no such pin (or more than one), the card names it as
//     missing and design chooses the pin, as for any pin stock has no item for.

const { TERMINAL_CATEGORY, PLACEHOLDER, isTerminalCategory } = require('./stockLedger');

// gu / hi: what the job card prints under the English (owner, 26 Oct 2026),
// in the shop-floor words of lib/translit.js (one, side, thread, without).
const TERMINAL_GROUPS = [
  { key: 'regular', label: 'Regular', gu: 'રેગ્યુલર', hi: 'रेगुलर' },
  { key: 'one_side_threaded', label: 'One Side Threaded', gu: 'એક બાજુ થ્રેડ', hi: 'एक तरफ थ्रेड' },
  { key: 'no_thread', label: 'No Thread', gu: 'થ્રેડ વગર', hi: 'बिना थ्रेड' },
];
const DEFAULT_GROUP = 'regular';
const GROUP_CHOICES = 'Regular, One Side Threaded or No Thread';

// The group a value names — its key or its label, in any case — or null.
const squash = (v) => String(v ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
function normaliseGroup(v) {
  const s = squash(v);
  if (!s) return null;
  const g = TERMINAL_GROUPS.find(x => squash(x.key) === s || squash(x.label) === s);
  return g ? g.key : null;
}
const groupLabel = (key) => TERMINAL_GROUPS.find(g => g.key === key)?.label || null;

// The group to store for an item being added or edited: required for a
// 'Terminal Pin' item, none for anything else.
function itemGroup(category, value) {
  if (!isTerminalCategory(category)) return { group: null };
  const group = normaliseGroup(value);
  if (!group) return { error: `A Terminal Pin item needs its group — choose ${GROUP_CHOICES}.` };
  return { group };
}

// A stock code in its parts: "TP-SS-M4-10-WH-OT" → TP SS M4 10 WH OT.
const codeParts = (code) => String(code || '').trim().toUpperCase().split('-').map(s => s.trim()).filter(Boolean);
const isLength = (p) => /^\d+(\.\d+)?$/.test(p);
const END_WORDS = { WH: 'With Head', WO: 'Without Head' };

// How a pin the card asks for is named when stock has none in the group.
const describePin = (stud, length, head, group) => `${stud} ${Number(length)}" ${END_WORDS[head]} (${groupLabel(group)})`;

// The pin of one group on a stud at a length, at one end (WH = with head, the
// Big end; WO = without head, the Small end). Within the group the SS pin on
// that stud at that length with that head — whatever else its code carries.
async function findGroupPin(db, { stud, length, head, group }) {
  const items = await db.all(
    `SELECT id, item_code FROM inventory_items
      WHERE LOWER(TRIM(category)) = LOWER($1) AND terminal_group = $2 ORDER BY item_code`, [TERMINAL_CATEGORY, group]);
  return items.filter(i => {
    if (PLACEHOLDER.test(i.item_code || '')) return false;
    const p = codeParts(i.item_code);
    return p[0] === 'TP' && p.includes('SS') && p.includes(stud) && p.includes(head)
      && p.some(x => isLength(x) && Number(x) === Number(length));
  });
}

// The two pins a card names: With Head at the Big length, Without Head at the
// Small length, both from the card's group. found: [{ end, head, length, item }];
// missing: what to tell design, one line per pin the group cannot give.
async function groupPins(db, { stud, big, small, group }) {
  const g = normaliseGroup(group) || DEFAULT_GROUP;
  const found = [], missing = [];
  for (const w of [{ end: 'big', head: 'WH', length: big }, { end: 'small', head: 'WO', length: small }]) {
    const fits = await findGroupPin(db, { stud, length: w.length, head: w.head, group: g });
    if (fits.length === 1) found.push({ ...w, item: fits[0] });
    else missing.push(fits.length
      ? `${describePin(stud, w.length, w.head, g)} — ${fits.length} items fit (${fits.map(f => f.item_code).join(', ')})`
      : describePin(stud, w.length, w.head, g));
  }
  return { group: g, found, missing };
}

// The group a stored card spec names; Regular for an app-made card from before
// groups; null for a card with no spec (an uploaded card names none).
function specGroup(spec) {
  if (!spec?.computed) return null;
  return normaliseGroup(spec.input?.terminalGroup) || DEFAULT_GROUP;
}

module.exports = {
  TERMINAL_GROUPS, DEFAULT_GROUP, GROUP_CHOICES,
  normaliseGroup, groupLabel, itemGroup, findGroupPin, groupPins, specGroup, describePin,
};
