// ── Stock held for open orders (owner, 10 Oct 2026) ───────────────────────────
// "If I have already parked my inventory at a previous job card, when I add the
// qty for another order it shows the same number for each order — it doesn't
// need to be deducted, but it can show me how much I have available."
// Display only: nothing is deducted or blocked. Per inventory item, what open
// orders still have to take from stock —
//   • their list lines: qty − taken − settled, less the part that comes from
//     the rework bin (that is not stock);
//   • terminal pins on job cards of orders after ORD-160-26 not yet taken at
//     Spot (those pins come from the job card, not the list).
// Per order, so the order being edited can leave its own out.
const OPEN_EXCLUDED = ['rejected', 'replaced', 'dispatched', 'resolved_dispatched', 'in_finished_goods'];

async function heldByOrders(db) {
  const { PINS_RULE } = require('./terminals');
  const lines = await db.all(
    `SELECT oii.inventory_item_id AS item_id, o.id AS order_id, o.order_code, oi.id AS order_item_id,
            SUM(GREATEST(0, oii.qty - COALESCE(oii.qty_deducted,0) - COALESCE(oii.qty_waived,0)
                            - GREATEST(0, COALESCE(oii.rework_qty,0) - COALESCE(oii.rework_deducted,0))))::float AS qty
       FROM order_item_inventory oii
       JOIN order_items oi ON oi.id = oii.order_item_id
       JOIN orders o ON o.id = oi.order_id
      WHERE COALESCE(oi.inventory_deducted, FALSE) = FALSE AND o.status <> ALL($1)
      GROUP BY 1, 2, 3, 4`, [OPEN_EXCLUDED]);
  const pins = await db.all(
    `SELECT t.inventory_item_id AS item_id, o.id AS order_id, o.order_code,
            SUM(GREATEST(0, t.qty - COALESCE(t.rework_qty,0)))::float AS qty
       FROM job_card_terminals t
       JOIN job_cards jc ON jc.id = t.job_card_id
       JOIN orders o ON o.id = jc.order_id
      WHERE o.id > $1 AND o.status <> ALL($2)
        AND jc.pins_taken_at IS NULL AND jc.last_stage_taken_at IS NULL
        AND jc.dispatched_at IS NULL AND jc.inventory_qc_at IS NULL
        AND jc.status IN ('pending', 'in_progress', 'on_hold')
      GROUP BY 1, 2, 3`, [PINS_RULE.afterOrderId, OPEN_EXCLUDED]);
  // Brazing rings on a 2in1 / 3in1 / Xin1 item go by the job card, not the list
  // (lib/brazingRings.js): 2 per element for every piece not yet brazed.
  const br = require('./brazingRings');
  const ringItems = await db.all(`SELECT id FROM inventory_items WHERE UPPER(TRIM(item_code)) = ANY($1)`, [Object.values(br.RING_CODES)]);
  const ringIds = new Set(ringItems.map(r => r.id));
  const ringRows = [];
  if (ringIds.size) {
    // Every open multi-element item — with ring lines on its list or not.
    const ringLines = await db.all(
      `SELECT oi.id AS order_item_id, oi.order_id, o.order_code, oi.drawing_number, oi.quantity, oi.tube_diameter
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE COALESCE(oi.inventory_deducted, FALSE) = FALSE AND o.status <> ALL($2) AND o.order_type <> 'finished_goods'
          AND (oi.drawing_number ~* '[0-9]\\s*in\\s*1'
               OR EXISTS (SELECT 1 FROM job_cards jc WHERE jc.order_item_id = oi.id
                            AND (jc.job_card_no ~* '[0-9]\\s*in\\s*1' OR COALESCE((jc.generated_spec->'computed'->>'elements')::int, 1) > 1))
               OR EXISTS (SELECT 1 FROM order_item_inventory oii WHERE oii.order_item_id = oi.id AND oii.inventory_item_id = ANY($1)))`,
      [[...ringIds], OPEN_EXCLUDED]);
    const cardsAll = ringLines.length ? await db.all(
      `SELECT jc.order_item_id, jc.job_card_no, jc.qty, jc.status, jc.rings_taken_at,
              (jc.generated_spec->'computed'->>'elements') AS el, (jc.generated_spec->'input'->>'tubeDiameterMm') AS dia,
              (SELECT done FROM production_checklist p WHERE p.job_card_id = jc.id AND p.stage_no = 15) AS s15
         FROM job_cards jc WHERE jc.order_item_id = ANY($1)`, [ringLines.map(r => r.order_item_id)]) : [];
    const ringByCode = Object.fromEntries((await db.all(
      `SELECT id, UPPER(TRIM(item_code)) AS code FROM inventory_items WHERE UPPER(TRIM(item_code)) = ANY($1)`,
      [Object.values(br.RING_CODES)])).map(r => [r.code, r.id]));
    for (const it of ringLines) {
      const cards = cardsAll.filter(c => c.order_item_id === it.order_item_id);
      let el = null, dia = Number(String(it.tube_diameter || '').match(/\d+/)?.[0]) || null;
      for (const c of cards) { el = el || parseInt(c.el, 10) || null; dia = Number(c.dia) || dia; }
      if (!(el > 1)) el = br.elementsFromName(it.drawing_number, ...cards.map(c => c.job_card_no)) || el || 1;
      if (!(el > 1)) continue;                                   // single element: the list stands
      // The list's ring lines for this item no longer count …
      for (const l of lines) if (l.order_id === it.order_id && ringIds.has(l.item_id) && l.order_item_id === it.order_item_id) l.qty = 0;
      const invId = ringByCode[br.RING_CODES[dia]];
      if (!invId) continue;
      // … the card count does: pieces on cards not yet brazed, plus pieces with no card yet.
      const carded = cards.reduce((x, c) => x + (Number(c.qty) || 0), 0);
      const open = cards.filter(c => !c.rings_taken_at && c.s15 !== 1 && !['qc_approved', 'dispatched', 'replaced', 'rejected', 'scrapped', 'inventory_qc', 'qc_pending'].includes(c.status))
        .reduce((x, c) => x + (Number(c.qty) || 0), 0) + Math.max(0, (Number(it.quantity) || 0) - carded);
      if (open > 0) ringRows.push({ item_id: invId, order_id: it.order_id, order_code: it.order_code, qty: open * el * br.RINGS_PER_ELEMENT });
    }
  }

  const map = new Map();
  for (const r of [...lines, ...pins, ...ringRows]) {
    const q = Math.round((Number(r.qty) || 0) * 10000) / 10000;
    if (!(q > 0)) continue;
    if (!map.has(r.item_id)) map.set(r.item_id, new Map());
    const byOrder = map.get(r.item_id);
    const cur = byOrder.get(r.order_id) || { order_id: r.order_id, order_code: r.order_code, qty: 0 };
    cur.qty = Math.round((cur.qty + q) * 10000) / 10000;
    byOrder.set(r.order_id, cur);
  }
  const out = new Map();
  for (const [itemId, byOrder] of map) {
    const by = [...byOrder.values()].sort((a, b) => b.qty - a.qty);
    out.set(itemId, { held: Math.round(by.reduce((a, h) => a + h.qty, 0) * 10000) / 10000, by });
  }
  return out;
}

module.exports = { heldByOrders };
