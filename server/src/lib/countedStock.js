// ── Counted stock (owner, 5 Oct 2026) ─────────────────────────────────────────
// The owner counted every tube (TUB-…) and the M4 brass nut for 8 mm
// (NUT-BR-M4-08) and ruled: "only the dispatched job cards will not change the
// tube and nut-br-8mm stock anymore", then (6 Oct 2026) "still in dispatch have
// completed qc will also not take from both the inventory". Every card still in
// production takes (and gives back) its inventory as usual ("all the in progress
// job cards will takes it inventory natuarally"); its take at QC approval stays.
//
// A held card is one through QC: approved (waiting at dispatch or gone to
// finished goods) or dispatched — dispatched_at set (it stays set if the card
// comes back as a query, return or repair) or a dispatched status (a status set
// by hand does not stamp dispatched_at). Held to this:
//   • a corrected item list (lib/bomCorrection.js) never moves a counted item on
//     a line with a held card;
//   • Stage 5 on a held card takes no tube and gives none back
//     (lib/materialDeduction.js);
//   • the whole-line settle at dispatch takes no counted item
//     (lib/inventoryDeduction.js).
// A card waiting at Inventory QC ('inventory_qc', owner 6 Oct 2026) is NOT held:
// QC may still correct its tube / NUT-BR-M4-08 there. Once Inventory QC is done
// the card is closed for every item, not only these (inventory_qc_at).

const isCountedItem = (code) => {
  const c = String(code || '').trim().toUpperCase();
  return c.startsWith('TUB-') || c === 'NUT-BR-M4-08';
};

const DISPATCHED_STATUSES = ['dispatched', 'resolved_dispatched', 'repaired_dispatched',
  'customer_query', 'product_return', 'repair_in_progress', 'completed'];
const HELD_STATUSES = ['qc_approved', ...DISPATCHED_STATUSES];
const isHeldCard = (card) => !!card?.dispatched_at || HELD_STATUSES.includes(card?.status);
// The same test in SQL, for a job_cards row aliased as given.
const heldSql = (a = 'job_cards') => `(${a}.dispatched_at IS NOT NULL OR ${a}.status = ANY(ARRAY['${HELD_STATUSES.join("','")}']))`;

module.exports = { isCountedItem, isHeldCard, heldSql };
