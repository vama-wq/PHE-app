// ── Frozen orders: take no inventory (owner, 19 Oct 2026) ────────────────────
// Old orders physically dispatched long ago are only now being pushed through
// dispatch in the app (~50 days late). Their material was used at the time, so
// nothing more must leave stock when they move through production / QC / dispatch
// now. The owner froze every order BELOW ORD-126-26, and ORD-127-26 as well.
// ORD-126-26 itself is NOT frozen. A frozen card still progresses — it simply
// takes nothing: the last-stage take stamps the card and deducts nothing, and
// every stage/QC deduction is a no-op. Give-backs self-guard (nothing was taken,
// so the "was it taken?" flags make them no-ops).
const FROZEN_BELOW = 126;
const ALSO_FROZEN = new Set([127]);

function orderNum(code) {
  const m = String(code || '').match(/^ORD-0*(\d+)-/i);
  return m ? parseInt(m[1], 10) : null;
}
function isFrozenCode(code) {
  const n = orderNum(code);
  return n != null && (n < FROZEN_BELOW || ALSO_FROZEN.has(n));
}
// jc may already carry order_code; otherwise look it up by order_id.
async function isFrozenCard(db, jc) {
  if (!jc) return false;
  let code = jc.order_code;
  if (!code && jc.order_id) code = (await db.get('SELECT order_code FROM orders WHERE id=$1', [jc.order_id]))?.order_code;
  return isFrozenCode(code);
}

module.exports = { isFrozenCode, isFrozenCard, orderNum, FROZEN_BELOW, ALSO_FROZEN };
