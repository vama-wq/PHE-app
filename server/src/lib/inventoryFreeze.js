// ── Frozen orders: stage-date based (owner, 19 Oct; refined 22 Oct 2026) ──────
// Orders through ORD-127-26 were mostly physically made/dispatched before the
// stock count, so their material is already reflected in the counted stock and
// must NOT be deducted again when the card is pushed through the app now. BUT an
// old order can still be ACTIVELY built after the count — e.g. its early stages
// (coil/tube/filling) done in Aug, its later stages (brazing, etc.) done now.
// That recent work IS real consumption and SHOULD deduct.
//
// So the freeze is per-stage by completion date: a deduction on a frozen order
// is skipped only if the production stage driving it was completed ON OR BEFORE
// the cutoff (already counted). A stage completed AFTER the cutoff — real current
// work — deducts normally. (Earlier this was a blanket "take nothing".)
const FROZEN_BELOW = 128;          // every order below 128 (through ORD-127-26) is frozen
const ALSO_FROZEN = new Set();
const CUTOFF = '2026-10-12';       // the stock-count date; stages done on/before this are already counted

function orderNum(code) {
  const m = String(code || '').match(/^ORD-0*(\d+)-/i);
  return m ? parseInt(m[1], 10) : null;
}
function isFrozenCode(code) {
  const n = orderNum(code);
  return n != null && (n < FROZEN_BELOW || ALSO_FROZEN.has(n));
}
// jc may already carry order_code; otherwise look it up by order_id.
async function orderCodeOf(db, jc) {
  if (!jc) return null;
  let code = jc.order_code;
  if (!code && jc.order_id) code = (await db.get('SELECT order_code FROM orders WHERE id=$1', [jc.order_id]))?.order_code;
  return code || null;
}
async function isFrozenCard(db, jc) {
  return isFrozenCode(await orderCodeOf(db, jc));
}

// Specific orders that take NO inventory at all — regardless of stage date. The
// owner manages their stock by hand (the BOM is added for record only / the
// material is set aside and already counted), so every deduction path skips
// them unconditionally. Unlike the ≤127 stage-date freeze above. (owner, 23 Oct
// 2026 — ORD-178-26). Add more by number here.
const BLANKET_NO_DEDUCT = new Set([178]);
function isBlanketNoDeduct(code) {
  const n = orderNum(code);
  return n != null && BLANKET_NO_DEDUCT.has(n);
}

const cardId = (jc) => jc?.id || jc?.job_card_id || null;

// The IST date a stage was completed on this card, or null if it is not done.
async function stageDoneDate(db, jobCardId, stageNo) {
  if (!jobCardId) return null;
  const r = await db.get(
    `SELECT to_char(done_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') d
       FROM production_checklist WHERE job_card_id=$1 AND stage_no=$2 AND done=1`, [jobCardId, stageNo]);
  return r?.d || null;
}

// A frozen order skips the deduction driven by `stageNo` ONLY if that stage was
// completed on or before the cutoff (its material is already in the count). A
// stage completed after the cutoff — current work — deducts. A stage not yet
// marked done (no date) is treated as current work → deduct.
async function frozenSkipsStage(db, jc, stageNo) {
  const code = await orderCodeOf(db, jc);
  if (isBlanketNoDeduct(code)) return true;               // never deducts (owner, 23 Oct 2026)
  if (!isFrozenCode(code)) return false;
  const d = await stageDoneDate(db, cardId(jc), stageNo);
  return d != null && d <= CUTOFF;
}

// The last-stage sweep / partial-QC take covers the list items prepared across
// the card's production. A frozen order skips it only if ALL the card's
// production (every stage except dispatch/kharoch 29/30) finished on or before
// the cutoff — the card was fully built before the count. If any production
// stage ran after the cutoff, the card is still being built now, so its list
// items are deducted. No production recorded at all → treat as already counted.
async function frozenSkipsLastStage(db, jc) {
  const code = await orderCodeOf(db, jc);
  if (isBlanketNoDeduct(code)) return true;               // never deducts (owner, 23 Oct 2026)
  if (!isFrozenCode(code)) return false;
  const r = await db.get(
    `SELECT to_char(MAX(done_at) AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') d
       FROM production_checklist WHERE job_card_id=$1 AND done=1 AND stage_no NOT IN (29,30)`, [cardId(jc)]);
  const d = r?.d || null;
  return d == null || d <= CUTOFF;
}

module.exports = {
  isFrozenCode, isFrozenCard, orderCodeOf, orderNum, stageDoneDate,
  isBlanketNoDeduct, BLANKET_NO_DEDUCT,
  frozenSkipsStage, frozenSkipsLastStage, FROZEN_BELOW, ALSO_FROZEN, CUTOFF,
};
