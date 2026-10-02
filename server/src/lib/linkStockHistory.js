// Tie past BOM stock movements to their order line (inventory_transactions.
// order_item_id + source) so the inventory-correction rules can read what was
// really taken (lib/stockLedger.js). Used by scripts/link_stock_history.js.
// Writes nothing unless apply=true, and then only those two columns.
const CODE_RE = /ORD-\d+-\d+/;

async function linkStockHistory(c, { apply = false } = {}) {
  const q = async (s, p = []) => (await c.query(s, p)).rows;
  const hasCols = (await q(`SELECT COUNT(*)::int n FROM information_schema.columns
      WHERE table_name='inventory_transactions' AND column_name IN ('order_item_id','source')`))[0].n === 2;

  const orders = await q('SELECT id, order_code, created_at FROM orders');
  const byCode = {};
  for (const o of orders) (byCode[o.order_code] ||= []).push(o);
  const items = await q('SELECT id, order_id, TRIM(COALESCE(drawing_number, \'\')) AS dwg FROM order_items');
  const itemsOf = {};
  for (const it of items) (itemsOf[it.order_id] ||= []).push(it);
  const cards = Object.fromEntries((await q('SELECT job_card_no, order_item_id, order_id FROM job_cards')).map(j => [j.job_card_no, j]));
  const edits = await q(`SELECT a.id, a.created_at, a.created_by, a.order_id,
                                substring(a.description from 'item #([0-9]+)')::int AS item_id
                           FROM activity_log a WHERE a.activity_type='inventory_edited' ORDER BY a.created_at, a.id`);
  const tx = await q(`SELECT id, item_id, transaction_type AS type, quantity::float AS qty, notes, created_by, created_at
                        FROM inventory_transactions
                       WHERE transaction_type IN ('dispatch_to_production','return_from_production')
                         ${hasCols ? 'AND order_item_id IS NULL' : ''}
                       ORDER BY id`);

  // The order a note refers to: same code, created before the movement
  // (codes of deleted orders have been reused).
  const orderFor = (code, at) => {
    const cands = (byCode[code] || []).filter(o => o.created_at <= at);
    cands.sort((a, b) => b.created_at - a.created_at);
    return cands[0] || null;
  };
  // Did this order ever lose a line? (cards pointing at a line that is gone,
  // or an 'Item deleted' give-back)
  const allCards = await q('SELECT order_id, order_item_id FROM job_cards');
  const itemIds = new Set(items.map(i => i.id));
  const lostByCard = new Set(allCards.filter(j => j.order_item_id && !itemIds.has(j.order_item_id)).map(j => j.order_id));
  const lostByNote = new Set(tx.filter(t => /^Item deleted — /.test(t.notes || '')).map(t => ((t.notes || '').match(CODE_RE) || [])[0]));
  const lostLine = (o) => lostByCard.has(o.id) || lostByNote.has(o.order_code);
  const link = new Map();            // tx id → { item, source, how }
  const why = new Map();             // tx id → reason it stayed unlinked

  // 1. Corrections: an edit's movements start with its first "Inventory
  //    edited" give-back and end at the edit's log line (old route order:
  //    give back, take the new list, then log).
  const lastEditOf = {};
  for (const e of edits) {
    if (!e.item_id) continue;
    const o = orders.find(x => x.id === e.order_id);
    if (!o) continue;
    const t = e.created_at.getTime();
    const from = Math.max(t - 180e3, lastEditOf[e.order_id] || 0);
    lastEditOf[e.order_id] = t;
    const win = tx.filter(r => !link.has(r.id) && r.created_by === e.created_by
      && r.created_at.getTime() > from && r.created_at.getTime() <= t + 2e3
      && (r.notes || '').match(CODE_RE)?.[0] === o.order_code);
    const first = win.find(r => r.type === 'return_from_production' && /^Inventory edited — /.test(r.notes || ''));
    if (!first) continue;
    for (const r of win) if (r.id >= first.id) link.set(r.id, { item: e.item_id, source: 'correction', how: `edit #${e.id}` });
  }

  // 2. Production takes and their give-backs.
  const approvedTakes = [];   // for "Reverted" give-backs
  for (const r of tx) {
    if (link.has(r.id)) continue;
    const notes = r.notes || '';
    const code = notes.match(CODE_RE)?.[0];
    if (!code) continue;                       // not an order movement (purchase QC etc.)
    const o = orderFor(code, r.created_at);
    if (!o) { why.set(r.id, 'order no longer exists'); continue; }
    const its = itemsOf[o.id] || [];
    const jcNo = notes.match(/\(JC ([^)]+)\)/)?.[1];
    const byCard = jcNo && cards[jcNo] && cards[jcNo].order_id === o.id ? cards[jcNo].order_item_id : null;
    const only = its.length === 1 ? its[0].id : null;

    if (r.type === 'dispatch_to_production') {
      const m = notes.match(/^Order: ORD-\d+-\d+ \| (.*)$/);
      if (!m) { why.set(r.id, 'material usage, not a BOM line'); continue; }
      if (/^Extra consumption/.test(m[1])) {
        const it = byCard || only;
        if (it) link.set(r.id, { item: it, source: 'remake', how: 'card' }); else why.set(r.id, 'remake: card unknown');
        continue;
      }
      let it = byCard;
      if (!it) {
        const dwg = (m[1].match(/^Dwg: (.*?)(?: \| .*)?$/)?.[1] || '').trim();
        // Several lines could have taken it → doubt → leave it (record-only).
        // No line matches → a renamed drawing on a one-line order is fine, but
        // not if the order ever lost a line (the stock may be that line's).
        const cand = dwg ? its.filter(x => x.dwg === dwg) : (only ? its : []);
        if (cand.length === 1) it = cand[0].id;
        else if (!cand.length && only && !lostLine(o)) it = only;
      }
      if (it) {
        link.set(r.id, { item: it, source: 'bom', how: byCard ? 'card' : 'drawing' });
        if (/\| Drawing approved/.test(notes)) approvedTakes.push({ ...r, order_id: o.id, item: it });
      } else why.set(r.id, 'take: drawing matches several lines');
      continue;
    }

    // give-backs
    if (/^Order deleted — /.test(notes)) { why.set(r.id, 'order deleted'); continue; }
    if (!/^Order: /.test(notes) && / · /.test(notes)) { why.set(r.id, 'material usage, not a BOM line'); continue; }
    if (/^Reverted — now deducts at QC/.test(notes)) {
      const prev = approvedTakes.filter(a => a.order_id === o.id && a.item_id === r.item_id && a.id < r.id);
      const itemsSeen = [...new Set(prev.map(a => a.item))];
      let it = itemsSeen.length === 1 ? itemsSeen[0] : null;
      if (!it) { const sameQty = prev.filter(a => Math.abs(a.qty - r.qty) < 1e-6); if (sameQty.length === 1) it = sameQty[0].item; }
      if (!it && only && !lostLine(o)) it = only;
      if (it) link.set(r.id, { item: it, source: 'bom', how: 'reverted approval' }); else why.set(r.id, 'reverted: line unknown');
      continue;
    }
    if (/^Drawing reopened — |^Item deleted — /.test(notes)) {
      const it = only && !lostLine(o) ? only : null;     // which line it was is not recorded
      if (it) link.set(r.id, { item: it, source: 'bom', how: 'give-back' }); else why.set(r.id, 'give-back: line unknown');
      continue;
    }
    if (/^Inventory edited — /.test(notes)) { why.set(r.id, 'edit give-back without a matching edit'); continue; }
    why.set(r.id, 'unrecognised note');
  }


  if (apply && link.size) {
    const ids = [], items = [], sources = [];
    for (const [id, l] of link) { ids.push(id); items.push(l.item); sources.push(l.source); }
    await c.query(
      `UPDATE inventory_transactions t SET order_item_id = v.item, source = v.source
         FROM unnest($1::int[], $2::int[], $3::text[]) AS v(id, item, source)
        WHERE t.id = v.id AND t.order_item_id IS NULL`, [ids, items, sources]);
  }
  return { considered: tx.length, link, why, tx };
}

module.exports = { linkStockHistory };
