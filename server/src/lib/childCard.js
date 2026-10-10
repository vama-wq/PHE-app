// Splitting pieces off a job card into a child card of their own.
//
// Two owner flows do this: a partial dispatch sends part of a card early
// (-P<n>, services/actions/splitRequests.js) and a customer query on part of a
// dispatched card gives the affected pieces their own card (-Q<n>,
// routes/customerQueries.js — "out of 50 nos only 3 are coming back"). The
// child is made the same way in both: it is the parent's pieces, so it
// inherits the parent's document, item, flags and completed stages. What a
// child inherits is decided HERE, once, so the two never drift apart.
//
// tx is a transaction-bound db (lib/bomCorrection clientDb). The caller holds
// the parent locked FOR UPDATE, picks the child's number and status, and
// reduces the parent's own qty afterwards — none of that is done here.

// Ready-for-Dispatch is stage 29 on a production card but stage 4 on an FG
// inventory card, which runs the short 4-stage checklist — asking about 29 on
// an FG card can only ever answer "not finished".
const readyStageFor = (parent) => (parent.is_fg ? 4 : 29);

/**
 * Insert the child card and copy the parent's completed checklist rows onto it.
 *
 *   childNo, qty, status, notes — the child's own.
 *   columns   — extra job_cards columns for this child, or overrides of the
 *               inherited ones (a -Q card carries the dispatch it already had;
 *               a corrected document / product name goes here too).
 *   copyReadyStage — false (default): the Ready-for-Dispatch row is NOT copied,
 *               the child's dispatch is its own (partial dispatch). true: the
 *               pieces were finished and went out, so the row travels with them.
 *
 * Returns the new card's id.
 */
async function cloneChildCard(tx, parent, { childNo, qty, status, notes, columns = {}, copyReadyStage = false }) {
  const row = {
    job_card_no: childNo, order_id: parent.order_id, qty, dispatch_date: parent.dispatch_date,
    current_stage: parent.current_stage || 0, punching: parent.punching, drawing_no: parent.drawing_no,
    product_name: parent.product_name, status, notes, uploaded_by: parent.uploaded_by,
    parent_job_card_id: parent.id, order_item_id: parent.order_item_id,
    // Carry the parent's job-card document so the shopfloor can open it on the child too
    file_path: parent.file_path, file_name: parent.file_name, original_name: parent.original_name,
    // Inherit the replacement link so a split replacement card stays invoice-exempt
    replacement_query_id: parent.replacement_query_id || null,
    // Inherit the material-deduction flags: the parent's stage 3/5/6 draws
    // covered the whole batch (child pieces included), so re-ticking those
    // stages on the child must NOT deduct tube/coil/filling a second time.
    tube_deducted: parent.tube_deducted || false, coil_deducted: parent.coil_deducted || false,
    fill_deducted: parent.fill_deducted || false,
    // A split of a Finished Goods inventory card is still a Finished Goods
    // card. Without these the child falls back to the full 29-stage
    // production checklist for material it never produced — it was drawn
    // from FG stock. fg_source_id keeps it pointing at the same FG row.
    is_fg: parent.is_fg || false, fg_source_id: parent.fg_source_id || null,
    // Same for the last-stage take (owner, 6 Oct 2026): if the parent has
    // already completed its last stage, its take covered the pre-split
    // quantity — the split pieces included — so the child takes nothing more.
    last_stage_taken_at: parent.last_stage_taken_at || null,
    // Pins taken at Spot covered the whole batch, split pieces included (owner, 8 Oct 2026).
    pins_taken_at: parent.pins_taken_at || null,
    ...columns,
  };
  const keys = Object.keys(row);
  const { rows } = await tx.run(
    `INSERT INTO job_cards (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
    keys.map(k => row[k]));
  const childId = rows[0].id;

  // The split pieces went through the parent's completed stages as part of the
  // batch — copy those rows (values, worker, time, notes) so their records
  // travel with them and the mandatory-stage gate sees them as done.
  // Rejection/remade/dispatched/scrap quantities stay with the parent (its
  // accounting). The Ready-for-Dispatch row goes only when the caller says the
  // pieces were finished (copyReadyStage) — 29 on a production card, 4 on FG.
  await tx.run(
    `INSERT INTO production_checklist (job_card_id, stage_no, done, value1, value2, worker_name, done_at, notes, coil_weight)
     SELECT $1, stage_no, done, value1, value2, worker_name, done_at, notes, coil_weight
     FROM production_checklist WHERE job_card_id=$2 AND done=1 AND ($3::boolean OR stage_no <> $4)`,
    [childId, parent.id, !!copyReadyStage, readyStageFor(parent)]);

  // Brazing rings already taken for the batch (owner, 10 Oct 2026: "a partial
  // dispatch of a job card takes its own share"): the split pieces' rings —
  // and their share of the list's settled ring lines — move onto the child, so
  // each card holds exactly its own and unticking Brazing on either gives back
  // only that. Nothing moves in stock here.
  const pr = await tx.run('SELECT rings_taken_at, rings_taken FROM job_cards WHERE id=$1', [parent.id]);
  const prow = pr.rows ? pr.rows[0] : null;
  let rec = prow?.rings_taken;
  try { rec = typeof rec === 'string' ? JSON.parse(rec) : rec; } catch { rec = null; }
  if (prow?.rings_taken_at && rec && Number(rec.qty) > 0 && Number(qty) > 0) {
    const per = Math.max(1, Number(rec.elements) || 1) * 2;
    const before = Number(rec.qty);
    const share = Math.min(before, Number(qty) * per);
    const childWaived = [];
    const parentWaived = (rec.waived || []).map(w => {
      const part = Math.min(Number(w.qty) || 0, Math.round(((Number(w.qty) || 0) * share) / before));
      if (part > 0) childWaived.push({ line_id: w.line_id, qty: part });
      return { line_id: w.line_id, qty: (Number(w.qty) || 0) - part };
    }).filter(w => w.qty > 0);
    const parentRec = { ...rec, qty: before - share, waived: parentWaived };
    const childRec = { item_id: rec.item_id, item_code: rec.item_code, qty: share, elements: rec.elements, waived: childWaived };
    await tx.run('UPDATE job_cards SET rings_taken = $2 WHERE id=$1', [parent.id, JSON.stringify(parentRec)]);
    await tx.run('UPDATE job_cards SET rings_taken_at = $2, rings_taken = $3 WHERE id=$1', [childId, prow.rings_taken_at, JSON.stringify(childRec)]);
    for (const [id, text] of [[parent.id, `Brazing rings: ${share} of the ${before} × ${rec.item_code} taken for ${parent.job_card_no} move with the ${qty} split pieces to ${childNo}`],
                              [childId, `Brazing rings: ${share} × ${rec.item_code} come with these ${qty} pieces from ${parent.job_card_no} (taken there at Brazing)`]]) {
      await tx.run(`INSERT INTO activity_log (order_id, job_card_id, activity_type, description, created_by) VALUES ($1,$2,'rings_split',$3,NULL)`,
        [parent.order_id, id, text]);
    }
  }
  return childId;
}

module.exports = { cloneChildCard, readyStageFor };
