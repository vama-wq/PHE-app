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
    // 2 per element, plus a pocket's ring per heater (owner, 12 Oct 2026).
    const per = Math.max(1, Number(rec.elements) || 1) * 2 + (Number(rec.pocket) || 0);
    const before = Number(rec.qty);
    const share = Math.min(before, Number(qty) * per);
    const childWaived = [];
    const parentWaived = (rec.waived || []).map(w => {
      const part = Math.min(Number(w.qty) || 0, Math.round(((Number(w.qty) || 0) * share) / before));
      if (part > 0) childWaived.push({ line_id: w.line_id, qty: part });
      return { line_id: w.line_id, qty: (Number(w.qty) || 0) - part };
    }).filter(w => w.qty > 0);
    const parentRec = { ...rec, qty: before - share, waived: parentWaived };
    const childRec = { item_id: rec.item_id, item_code: rec.item_code, qty: share, elements: rec.elements, pocket: rec.pocket || 0, waived: childWaived };
    await tx.run('UPDATE job_cards SET rings_taken = $2 WHERE id=$1', [parent.id, JSON.stringify(parentRec)]);
    await tx.run('UPDATE job_cards SET rings_taken_at = $2, rings_taken = $3 WHERE id=$1', [childId, prow.rings_taken_at, JSON.stringify(childRec)]);
    for (const [id, text] of [[parent.id, `Brazing rings: ${share} of the ${before} × ${rec.item_code} taken for ${parent.job_card_no} move with the ${qty} split pieces to ${childNo}`],
                              [childId, `Brazing rings: ${share} × ${rec.item_code} come with these ${qty} pieces from ${parent.job_card_no} (taken there at Brazing)`]]) {
      await tx.run(`INSERT INTO activity_log (order_id, job_card_id, activity_type, description, created_by) VALUES ($1,$2,'rings_split',$3,NULL)`,
        [parent.order_id, id, text]);
    }
  }
  await moveTakenShare(tx, parent, childId, childNo, qty);
  return childId;
}

// Everything the parent already took for the batch moves with the split pieces
// (owner, 12 Oct 2026: "I allowed a partial dispatch of 40 but the inventory of
// the 10 left did not change"): for each part, the split pieces' share of what
// the parent took (taken − given back) goes onto the child — a pair of
// record-only rows, stock unchanged — so each card's "Inventory taken" shows
// only its own pieces and a later give-back on either returns only its own.
// The card's tube / coil / filling / fins figures are shared the same way.
// A parent whose Inventory QC is done is closed: nothing moves (its pieces'
// inventory stays recorded there, as before).
async function moveTakenShare(tx, parent, childId, childNo, qty) {
  const before = Number(parent.qty) || 0, n = Number(qty) || 0;
  if (!(before > n) || !(n > 0) || parent.inventory_qc_at) return;
  const frac = n / before;
  const r4 = (v) => Math.round(Number(v) * 10000) / 10000;
  const { isPieceUnit } = require('./rework');
  const no = parent.job_card_no;
  const q = async (sql, p) => { const r = await tx.run(sql, p); return r.rows || []; };
  const nets = await q(
    `SELECT t.item_id, ii.unit, ii.item_code, ii.current_stock::float AS stock,
            SUM(CASE WHEN t.transaction_type='dispatch_to_production' THEN t.quantity
                     WHEN t.transaction_type='return_from_production' THEN -t.quantity ELSE 0 END)::float AS net
       FROM inventory_transactions t JOIN inventory_items ii ON ii.id = t.item_id
      WHERE t.job_card_id = $1 OR (t.job_card_id IS NULL AND (strpos(t.notes, $2) > 0 OR strpos(t.notes, $3) > 0 OR right(t.notes, length($4)) = $4))
      GROUP BY t.item_id, ii.unit, ii.item_code, ii.current_stock`,
    [parent.id, `(JC ${no})`, `, JC ${no})`, `JC ${no}`]);
  const oc = (await q('SELECT order_code FROM orders WHERE id=$1', [parent.order_id]))[0]?.order_code || '';
  const moved = [];
  for (const r of nets) {
    if (!(r.net > 0)) continue;
    const share = isPieceUnit(r.unit) ? Math.round(r.net * frac) : r4(r.net * frac);
    if (!(share > 0)) continue;
    const ins = (card, type, notes) => tx.run(
      `INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by, order_item_id, source, job_card_id)
       VALUES ($1,$2,$3,$4,$5,NULL,$6,'split',$7)`, [r.item_id, type, share, r.stock, notes, parent.order_item_id || null, card]);
    await ins(parent.id, 'return_from_production',
      `Order: ${oc} | Split: ${share} of the ${r4(r.net)} taken go with the ${n} pieces to ${childNo} — record only, stock unchanged (JC ${no})`);
    await ins(childId, 'dispatch_to_production',
      `Order: ${oc} | Split: ${share} came with these ${n} pieces from ${no}, taken there — record only, stock unchanged (JC ${childNo})`);
    moved.push(`${share} ${r.item_code}`);
  }
  // The card's own material figures (a later Stage 4/5/6 untick gives back its own).
  const sets = [], vals = [];
  const childSets = [], childVals = [];
  for (const f of ['tube_used_qty', 'tube_scrap_qty', 'coil_used_qty', 'coil_scrap_qty', 'fill_pvc_qty', 'fill_mgo_qty', 'fins_kg']) {
    const v = Number(parent[f]);
    if (!(v > 0)) continue;
    const c = f === 'fill_pvc_qty' ? Math.round(v * frac) : r4(v * frac);
    sets.push(`${f}=$${sets.length + 1}`); vals.push(r4(v - c));
    childSets.push(`${f}=$${childSets.length + 1}`); childVals.push(c);
  }
  // A Cap heater's sleeve taken by inch at Nut Washer: its record (total inches)
  // shares too, so unticking Nut Washer on either card gives back only its own.
  let sl = parent.sleeve_taken;
  try { sl = typeof sl === 'string' ? JSON.parse(sl) : sl; } catch { sl = null; }
  if (parent.sleeve_taken_at && sl && Number(sl.qty) > 0) {
    const c = r4(Number(sl.qty) * frac), cp = r4(Number(sl.pieces || 0) * frac);
    await tx.run('UPDATE job_cards SET sleeve_taken = $2 WHERE id=$1', [parent.id, JSON.stringify({ ...sl, qty: r4(sl.qty - c), pieces: r4((sl.pieces || 0) - cp) })]);
    await tx.run('UPDATE job_cards SET sleeve_taken_at = $2, sleeve_taken = $3 WHERE id=$1', [childId, parent.sleeve_taken_at, JSON.stringify({ ...sl, qty: c, pieces: cp })]);
  }
  if (sets.length) {
    await tx.run(`UPDATE job_cards SET ${sets.join(', ')} WHERE id=$${sets.length + 1}`, [...vals, parent.id]);
    await tx.run(`UPDATE job_cards SET ${childSets.join(', ')}${parent.fins_deducted ? ', fins_deducted=TRUE' : ''} WHERE id=$${childSets.length + 1}`, [...childVals, childId]);
  }
  if (moved.length) {
    for (const [id, text] of [[parent.id, `Split: the ${n} pieces' share of what ${no} took moved to ${childNo} — ${moved.join(', ')} (record only, stock unchanged)`],
                              [childId, `Split: came with these ${n} pieces from ${no} — ${moved.join(', ')} (taken there; record only)`]]) {
      await tx.run(`INSERT INTO activity_log (order_id, job_card_id, activity_type, description, created_by) VALUES ($1,$2,'inventory_split',$3,NULL)`,
        [parent.order_id, id, text]);
    }
  }
  return moved;
}

module.exports = { cloneChildCard, readyStageFor, moveTakenShare };
