// ── The 50-piece job card rule, for showing the planner what will happen ────
//
// server/src/lib/jobCardSplit.js IS THE AUTHORITY — it is what actually creates
// the cards. This copy exists only so the upload modal can say, before the
// click, how many cards the quantity will make. If the rule changes there it
// must change here too, or the preview will promise something the server does
// not do.
export const MAX_CARD_QTY = 50;
export const MIN_LAST_CARD = 10;

export function splitQuantity(total, max = MAX_CARD_QTY, minLast = MIN_LAST_CARD) {
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
