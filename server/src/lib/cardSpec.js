// What an app-generated job card says about its own lengths (owner, 4 Oct
// 2026: tube, MgO and fins are taken by the card, not by figures typed on the
// floor). Null when the card has no generated spec — made before the
// generator, or uploaded — and the typed figure is used instead.
//   cutMm      tube cutting length per element (before draw)
//   totalMm    finished length per element (after draw)
//   elements   elements per heater (a 3in1 heater is three)
function cardLengths(generatedSpec) {
  try {
    const g = typeof generatedSpec === 'string' ? JSON.parse(generatedSpec) : generatedSpec;
    const c = g?.computed;
    const cutMm = Number(c?.cuttingLengthMm), totalMm = Number(c?.totalLengthMm);
    if (!(cutMm > 0) && !(totalMm > 0)) return null;
    return { cutMm: cutMm > 0 ? cutMm : null, totalMm: totalMm > 0 ? totalMm : null,
      elements: Math.max(1, parseInt(c?.elements, 10) || 1) };
  } catch { return null; }
}

// A card's generated spec — its own, or, for a card that has none, the card it
// came from: a partial-dispatch child takes its parent's (up the chain), a
// replacement (-RPL) takes the card the customer query was raised on. Those
// cards are the same heater, made from the same job card.
async function specForCard(db, jc) {
  const seen = new Set();
  let id = jc?.id;
  while (id && !seen.has(id)) {
    seen.add(id);
    const row = await db.get('SELECT id, generated_spec, parent_job_card_id, replacement_query_id FROM job_cards WHERE id=$1', [id]);
    if (!row) return null;
    if (row.generated_spec) return row.generated_spec;
    if (row.parent_job_card_id) { id = row.parent_job_card_id; continue; }
    if (row.replacement_query_id) {
      const q = await db.get('SELECT job_card_id FROM customer_queries WHERE id=$1', [row.replacement_query_id]);
      id = q?.job_card_id; continue;
    }
    return null;
  }
  return null;
}

module.exports = { cardLengths, specForCard };
