// Saving a corrected inventory list (BOM) for an order line, by the owner's
// rules (1 Oct 2026; see lib/stockLedger.js for the rules and the history).
// All of it — the stock moves, the new lines and their accounting — happens in
// one transaction, so a failure part-way leaves nothing half-done.

const { STAGE_CATEGORY_MAP, FINS_CODES } = require('./inventoryDeduction');
const { ledgerColumnsReady, recordMove, ledgerForItem, progressTargets, r4, EPS } = require('./stockLedger');

function clientDb(client) {
  return {
    get: async (sql, params = []) => (await client.query(sql, params)).rows[0] || null,
    all: async (sql, params = []) => (await client.query(sql, params)).rows,
    run: (sql, params = []) => client.query(sql, params),
    insert: async (sql, params = []) => {
      const { rows } = await client.query(sql.trimEnd().replace(/;?\s*$/, '') + ' RETURNING id', params);
      return { lastInsertRowid: rows[0]?.id || null };
    },
  };
}

const fmt = (n) => String(r4(n));

// sels: [{ id, qty, rework_qty }] already validated by the route.
// Returns { mode: 'record'|'difference', why, moves:[{code,dir,qty,unit}], short:[{code,need,stock,unit}], summary }.
async function applyBomCorrection(db, { orderItemId, sels, userId, userRole }) {
  if (!(await ledgerColumnsReady())) {
    const e = new Error('The app is finishing an update — please save again in a minute.');
    e.status = 503;
    throw e;
  }
  return db.withTransaction(async (client) => {
    const tx = clientDb(client);
    await client.query("SET LOCAL lock_timeout = '10s'");
    // One save at a time per order line.
    const item = await tx.get(
      `SELECT oi.id, oi.order_id, oi.drawing_number, o.order_code
         FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.id=$1 FOR UPDATE OF oi`, [orderItemId]);
    if (!item) { const e = new Error('Item not found'); e.status = 404; throw e; }
    const orderCode = item.order_code;

    const oldLines = await tx.all(
      `SELECT oii.*, ii.item_code FROM order_item_inventory oii
         JOIN inventory_items ii ON ii.id = oii.inventory_item_id WHERE oii.order_item_id=$1`, [orderItemId]);
    const ids = [...new Set(sels.map(s => parseInt(s.id, 10)))];
    const info = Object.fromEntries((await tx.all(
      'SELECT id, item_code, TRIM(category) AS category, unit FROM inventory_items WHERE id = ANY($1)', [ids]))
      .map(r => [r.id, r]));
    const seen = new Set();
    const newLines = [];
    for (const s of sels) {
      const id = parseInt(s.id, 10);
      if (seen.has(id) || !info[id]) continue;
      seen.add(id);
      newLines.push({ inventory_item_id: id, qty: parseFloat(s.qty) || 0, rework_qty: Number(s.rework_qty) || 0,
        item_code: info[id].item_code, category: info[id].category, unit: info[id].unit });
    }

    const ledger = await ledgerForItem(tx, orderItemId);
    const { targets, allPassed } = await progressTargets(tx, orderItemId, newLines,
      { stageMap: STAGE_CATEGORY_MAP, finsCodes: FINS_CODES });
    const reworkInvolved = oldLines.some(l => Number(l.rework_qty) > 0 || Number(l.rework_deducted) > 0)
      || newLines.some(l => l.rework_qty > 0);

    let mode = 'difference', why = '';
    if (!ledger.known) { mode = 'record'; why = ledger.why; }
    else if (ledger.hadPlaceholder) { mode = 'record'; why = 'its old inventory was a TRAIN placeholder'; }
    else if (!ledger.naturalReal) { mode = 'record'; why = 'nothing was really taken from real stock for it'; }
    else if (reworkInvolved) { mode = 'record'; why = 'it uses rework-bin pieces'; }

    const moves = [], short = [];
    const actual = {};
    if (mode === 'difference') {
      const lineOf = Object.fromEntries(newLines.map(l => [String(l.inventory_item_id), l]));
      const invIds = new Set([...newLines.map(l => String(l.inventory_item_id)), ...Object.keys(ledger.net)]);
      for (const id of [...invIds].sort((a, b) => Number(a) - Number(b))) {   // fixed order: no lock cycles
        const code = lineOf[id]?.item_code || ledger.codes[id];
        if (FINS_CODES.includes(code)) continue;          // fins go by tube length at QC — never by a correction
        const line = lineOf[id];
        const target = line ? (targets.get(line.inventory_item_id) || 0) : 0;
        const have = Math.max(0, Number(ledger.net[id]) || 0);
        const diff = r4(target - have);
        actual[id] = have;
        if (Math.abs(diff) < EPS) continue;
        const inv = await tx.get('SELECT id, item_code, unit, current_stock FROM inventory_items WHERE id=$1 FOR UPDATE', [id]);
        if (!inv) continue;
        const stock = Number(inv.current_stock) || 0;
        if (diff > 0) {
          if (stock + EPS < diff) {           // rule 5: never below zero
            short.push({ code: inv.item_code, need: diff, stock: r4(stock), unit: inv.unit || '' });
            continue;
          }
          const after = r4(stock - diff);
          await tx.run('UPDATE inventory_items SET current_stock=$1 WHERE id=$2', [after, id]);
          await recordMove(tx, { itemId: Number(id), type: 'dispatch_to_production', qty: diff, balanceAfter: after,
            notes: `Order: ${orderCode}${item.drawing_number ? ` | Dwg: ${item.drawing_number}` : ''} | Auto-corrected by inventory rules (corrected list)`,
            userId, orderItemId, source: 'correction' });
          moves.push({ code: inv.item_code, dir: 'took', qty: diff, unit: inv.unit || '' });
          actual[id] = r4(have + diff);
        } else {
          const back = -diff;
          const after = r4(stock + back);
          await tx.run('UPDATE inventory_items SET current_stock=$1 WHERE id=$2', [after, id]);
          await recordMove(tx, { itemId: Number(id), type: 'return_from_production', qty: back, balanceAfter: after,
            notes: `Auto-corrected by inventory rules (corrected list) — ${orderCode}`,
            userId, orderItemId, source: 'correction' });
          moves.push({ code: inv.item_code, dir: 'gave back', qty: back, unit: inv.unit || '' });
          actual[id] = r4(have - back);
        }
      }
    }

    // The new lines. qty_deducted is only ever what really left stock through
    // this line; qty_waived is what a record-only correction settled without
    // taking stock, so later stages and QC skip it and a give-back never returns it.
    const oldByInv = Object.fromEntries(oldLines.map(l => [String(l.inventory_item_id), l]));
    await tx.run('DELETE FROM order_item_inventory WHERE order_item_id=$1', [orderItemId]);
    for (const l of newLines) {
      const k = String(l.inventory_item_id);
      const old = oldByInv[k];
      const t = targets.get(l.inventory_item_id);
      let deducted = 0, waived = 0;
      if (t == null) {                     // fins: keep what the cards already took
        deducted = Number(old?.qty_deducted) || 0;
        waived = Number(old?.qty_waived) || 0;
      } else if (mode === 'record') {
        waived = t;
      } else {
        deducted = Math.min(Number(actual[k]) || 0, l.qty);
      }
      const reworkDeducted = Math.min(Number(old?.rework_deducted) || 0, l.rework_qty || 0);
      await tx.run(
        `INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty, qty_deducted, rework_qty, rework_deducted, qty_waived)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [orderItemId, l.inventory_item_id, l.qty, r4(deducted), l.rework_qty || 0, reworkDeducted, r4(waived)]);
    }
    // Fully through QC → settled, so nothing later (a settle, a stage re-tick)
    // takes the list again. Otherwise later stages and QC take the rest.
    await tx.run('UPDATE order_items SET inventory_deducted=$1 WHERE id=$2', [allPassed, orderItemId]);

    // Design rewriting the BOM IS the review.
    if (['design', 'admin', 'owner'].includes(userRole)) {
      await tx.run(
        "UPDATE order_items SET bom_review=CASE WHEN bom_review='needed' THEN 'confirmed' ELSE bom_review END, " +
        "bom_review_by=CASE WHEN bom_review='needed' THEN $1 ELSE bom_review_by END, " +
        "bom_review_at=CASE WHEN bom_review='needed' THEN NOW() ELSE bom_review_at END WHERE id=$2",
        [userId, orderItemId]);
    }

    let summary;
    if (mode === 'record') {
      summary = `list corrected only — stock not changed (${why})`;
    } else if (!moves.length && !short.length) {
      summary = 'stock already matches the corrected list — nothing moved';
    } else {
      const parts = [];
      const took = moves.filter(m => m.dir === 'took').map(m => `${fmt(m.qty)} ${m.code}`);
      const back = moves.filter(m => m.dir === 'gave back').map(m => `${fmt(m.qty)} ${m.code}`);
      if (took.length) parts.push(`took ${took.join(', ')}`);
      if (back.length) parts.push(`gave back ${back.join(', ')}`);
      for (const s of short) parts.push(`not taken: ${s.code} (needs ${fmt(s.need)}, only ${fmt(s.stock)} in stock)`);
      summary = `auto-corrected by inventory rules: ${parts.join('; ')}`;
    }
    return { mode, why, moves, short, summary, orderId: item.order_id };
  });
}

module.exports = { applyBomCorrection };
