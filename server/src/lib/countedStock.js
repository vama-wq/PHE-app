// ── Counted stock (owner, 5 Oct 2026) ─────────────────────────────────────────
// The owner counted every tube (TUB-…) and the M4 brass nut for 8 mm
// (NUT-BR-M4-08) and ruled: "only the dispatched job cards will not change the
// tube and nut-br-8mm stock anymore" — every card not yet dispatched takes (and
// gives back) its inventory as usual ("all the in progress job cards will takes
// it inventory natuarally").
//
// A dispatched card is one that has left the factory: dispatched_at is set
// (it stays set if the card later comes back as a query, return or repair), or
// its status says so (a status set by hand does not stamp dispatched_at).
// Two automatic paths are held to this:
//   • a corrected item list on an order (lib/bomCorrection.js) never moves a
//     counted item for the work of the line's dispatched cards;
//   • undoing Stage 5 on a dispatched card never puts its tube back
//     (lib/materialDeduction.js).

const isCountedItem = (code) => {
  const c = String(code || '').trim().toUpperCase();
  return c.startsWith('TUB-') || c === 'NUT-BR-M4-08';
};

const DISPATCHED_STATUSES = ['dispatched', 'resolved_dispatched', 'repaired_dispatched',
  'customer_query', 'product_return', 'repair_in_progress', 'completed'];
const isDispatchedCard = (card) => !!card?.dispatched_at || DISPATCHED_STATUSES.includes(card?.status);
// The same test in SQL, for a job_cards row aliased as given.
const dispatchedSql = (a = 'job_cards') => `(${a}.dispatched_at IS NOT NULL OR ${a}.status = ANY(ARRAY['${DISPATCHED_STATUSES.join("','")}']))`;

module.exports = { isCountedItem, isDispatchedCard, dispatchedSql };
