// Bill-of-materials quantity arithmetic, shared by every path that copies or
// re-sizes an order item's inventory selection.
//
// The one fact everything here rests on: order_item_inventory.qty is the TOTAL
// for the item's whole quantity, not a per-piece figure. Every consumer divides
// it back down — inventoryDeduction prorates by (card qty / item qty), and the
// material slip apportions the line total across sibling job cards by qty share.
// So a line copied verbatim onto an item of a different quantity is not a recipe
// carried over; it is the OLD item's total, which the new quantity silently
// reinterprets as a different per-piece rate.

// Only pieces have to come out whole. The owner's rule (24 Sep 2026): "Pcs are
// always deducted in whole numbers; anything deducted in kgs, ltrs or other than
// pcs may carry a decimal." The unit column is dirty — 'pcs', 'Pcs', 'PCS',
// 'pcs ', 'nos' all appear — so it is normalised before the test.
const PIECE_UNITS = new Set(['pcs', 'pc', 'pce', 'piece', 'pieces', 'nos', 'no', 'num', 'qty']);

function normUnit(unit) {
  return String(unit == null ? '' : unit).trim().toLowerCase().replace(/[.\s]+$/, '');
}

// A line counts as pieces when its unit says so. A line with no unit at all is
// treated as pieces when the stored quantity is already a whole number, which is
// how every real piece line in the data looks — safer than assuming it is
// measured and letting a fraction through unnoticed.
function isPieceLine(unit, qty) {
  const u = normUnit(unit);
  if (u) return PIECE_UNITS.has(u);
  return Number.isInteger(Number(qty));
}

// Re-size one BOM line from an item of `fromQty` pieces to one of `toQty`.
//
// Returns { qty, fractional, reason }. `fractional` is the owner's flag case: a
// piece line that does not land on a whole number means the source BOM was
// itself wrong, so the exact figure is kept and design is asked to fix it —
// rounding here would bury the evidence under a plausible-looking number.
function scaleBomQty(srcQty, fromQty, toQty, unit) {
  const q = Number(srcQty);
  const from = Number(fromQty);
  const to = Number(toQty);

  // Fins and spring-gauge lines carry 0 on purpose — they deduct by tube length
  // at QC, not by count. Never touch them.
  if (!Number.isFinite(q) || q === 0) return { qty: srcQty, fractional: false, reason: null };

  if (!(from > 0) || !(to > 0)) {
    return { qty: q, fractional: false, reason: 'source item had no quantity to scale from — copied as it stood' };
  }

  // Multiply before dividing: (55 * 20) / 50 is exactly 22, where
  // 55 * (20 / 50) drifts. Keeps a deliberate scrap overage at its own ratio.
  const exact = (q * to) / from;

  if (!isPieceLine(unit, q)) {
    return { qty: Math.round(exact * 1000) / 1000, fractional: false, reason: null };
  }

  const whole = Math.round(exact);
  if (Math.abs(exact - whole) > 1e-9) {
    return {
      qty: Math.round(exact * 1000) / 1000,
      fractional: true,
      reason: `${q} for ${from} pcs comes to ${Math.round(exact * 1000) / 1000} for ${to} — not a whole number of pieces`,
    };
  }
  return { qty: whole, fractional: false, reason: null };
}

// The per-piece rate a stored line implies. Used to spot a line that was sized
// for some other quantity: a piece line whose rate is not whole was either
// copied from an item of a different size or entered wrong.
function perPiece(qty, itemQty) {
  const q = Number(qty), n = Number(itemQty);
  if (!(n > 0) || !Number.isFinite(q)) return null;
  return q / n;
}

function isSuspectLine(qty, itemQty, unit) {
  const q = Number(qty);
  if (!Number.isFinite(q) || q === 0) return false;       // fins lines are fine
  if (!isPieceLine(unit, q)) return false;                 // kgs / ltr / meter may be fractional
  const rate = perPiece(q, itemQty);
  if (rate == null) return false;
  return Math.abs(rate - Math.round(rate)) > 1e-9;
}

module.exports = { scaleBomQty, isPieceLine, isSuspectLine, perPiece, normUnit, PIECE_UNITS };
