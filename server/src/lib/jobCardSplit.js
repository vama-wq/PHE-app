// ── Splitting an order item into job cards ─────────────────────────────────
//
// Owner's rule (22 Sep 2026): no job card runs more than 50 pieces. An item
// for 100 becomes two cards of 50; the floor picks them up as separate cards,
// each dispatches on its own, and each deducts only its own share of the BOM.
//
// Pure functions — no database — so the arithmetic is testable on its own.

// No card may exceed this.
const MAX_CARD_QTY = 50;

// …and none should be so small it isn't worth setting up for. A leftover below
// this is folded into the card before it and the pair is split evenly, so 101
// runs as 50 + 26 + 25 rather than 50 + 50 + 1. Above it the leftover keeps its
// own card, so 120 stays 50 + 50 + 20 — the owner's own two examples.
const MIN_LAST_CARD = 10;

function splitQuantity(total, max = MAX_CARD_QTY, minLast = MIN_LAST_CARD) {
  const n = Math.floor(Number(total));
  if (!(n > 0)) return [];
  if (n <= max) return [n];

  const parts = Array.from({ length: Math.floor(n / max) }, () => max);
  const rest = n - parts.length * max;
  if (rest === 0) return parts;
  if (rest >= minLast) { parts.push(rest); return parts; }

  const pair = parts.pop() + rest;
  parts.push(Math.ceil(pair / 2), Math.floor(pair / 2));
  return parts;
}

// Suffix only when the item actually splits: 40 pieces stay plain `PT-X`, and
// 100 become `PT-X-1` and `PT-X-2`.
//
// Three numbering schemes already share this space, so allocation is gap-safe
// rather than count-based: `-P1` marks a partial-dispatch split, `-FG` an
// inventory card, and a bare name collision has always fallen back to `-2`.
// `taken` is mutated as names are handed out, so one call can allocate a whole
// batch without re-reading the table.
function allocateCardNumbers(baseNo, count, taken) {
  const CEILING = 10000; // a base with this many cards is a bug, not a big order
  if (count <= 1) {
    if (!taken.has(baseNo)) return [baseNo];
    let n = 2;
    while (taken.has(`${baseNo}-${n}`) && n < CEILING) n++;
    if (n >= CEILING) throw new Error(`Cannot allocate a job card number for ${baseNo}`);
    return [`${baseNo}-${n}`];
  }

  const names = [];
  let n = 1;
  while (names.length < count && n < CEILING) {
    const candidate = `${baseNo}-${n}`;
    if (!taken.has(candidate)) { names.push(candidate); taken.add(candidate); }
    n++;
  }
  if (names.length < count) throw new Error(`Cannot allocate ${count} job card numbers for ${baseNo}`);
  return names;
}

// Every name already in use for this base, in the one shape both callers need.
async function takenNumbersFor(db, baseNo) {
  const rows = await db.all(
    'SELECT job_card_no FROM job_cards WHERE job_card_no = $1 OR job_card_no LIKE $2',
    [baseNo, `${baseNo}-%`]
  );
  return new Set(rows.map(r => r.job_card_no));
}

// What the batch will look like, for the activity log and the response.
function describeSplit(parts) {
  return parts.length <= 1 ? `${parts[0] || 0} pcs` : `${parts.join(' + ')} = ${parts.reduce((a, b) => a + b, 0)} pcs`;
}

module.exports = { MAX_CARD_QTY, MIN_LAST_CARD, splitQuantity, allocateCardNumbers, takenNumbersFor, describeSplit };
