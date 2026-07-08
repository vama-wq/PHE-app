// ── Checklist-driven tube & spring-gauge consumption (new orders only) ─────────
// Tube and Spring-Gauge wire are NOT part of the design BOM. They are deducted
// from stock based on ACTUAL usage recorded in the production checklist, with
// FIFO lot draw-down so landed-cost valuation stays accurate:
//   • Stage 5 (Tube Cutting): tube used  = value1 (mm)  × qty  → feet  (÷304.8)
//                             tube scrap = scrap (inches)× qty  → feet  (÷12)
//     Tube inventory item = the order item's Tube Material (item code, category "Tube").
//   • Stage 3 (Ohms):         coil used  = coil_weight (g, total)  → Kgs (÷1000)
//                             coil scrap = scrap (g, total)        → Kgs (÷1000)
//     Gauge inventory item = Stage 1 gauge pick (item code, category "Spring Guage").
//   • Stage 6 (Filling):      PVC bush   = 2 pcs/piece × qty — PVC-FB08-M4 (8mm dia) or
//                                          PVC-FB11-M5 (11mm dia), by the order item's Tube Diameter.
//                             MGO-65A powder = (stage-5 length(mm) × qty) → inches ÷25.4, then
//                                          × rate-per-inch (8mm: 0.018g/5in; 11mm: 0.027g/5in) → Kgs (÷1000).
// Only runs for orders flagged material_deduction=TRUE (created after this feature).

const { resolveJobCardItemId } = require('./inventoryDeduction');

const r4 = (n) => Math.round(Number(n) * 1e4) / 1e4;

async function invByCode(db, code, category) {
  if (!code) return null;
  return db.get(
    'SELECT id, unit FROM inventory_items WHERE upper(item_code)=upper($1) AND lower(trim(category))=$2 LIMIT 1',
    [String(code).trim(), category]
  );
}

// Recompute an item's stock + moving-average unit_cost from its remaining lots.
async function recomputeItemCost(db, itemId, newStock) {
  const lots = await db.all(
    'SELECT qty_remaining, unit_cost FROM inventory_fifo_lots WHERE item_id=$1 AND qty_remaining > 0',
    [itemId]
  );
  const totQty = lots.reduce((s, l) => s + Number(l.qty_remaining), 0);
  const totCost = lots.reduce((s, l) => s + Number(l.qty_remaining) * Number(l.unit_cost), 0);
  if (totQty > 0) {
    await db.run('UPDATE inventory_items SET current_stock=$1, unit_cost=$2 WHERE id=$3',
      [newStock, Math.round((totCost / totQty) * 100) / 100, itemId]);
  } else {
    await db.run('UPDATE inventory_items SET current_stock=$1 WHERE id=$2', [newStock, itemId]);
  }
}

// Consume `qty` from an item, drawing down the oldest FIFO lots first. Stock may go
// negative (shortage stays visible) if lots are insufficient. Logs one transaction.
async function consumeFifo(db, itemId, qty, { type, note, userId }) {
  const q = r4(qty);
  if (!(q > 0)) return;
  const inv = await db.get('SELECT current_stock FROM inventory_items WHERE id=$1', [itemId]);
  const newStock = r4((Number(inv.current_stock) || 0) - q);
  // Log the transaction FIRST — if it's rejected, stock/lots stay untouched.
  await db.insert(
    `INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [itemId, type, q, newStock, note, userId]
  );
  const lots = await db.all(
    'SELECT id, qty_remaining FROM inventory_fifo_lots WHERE item_id=$1 AND qty_remaining > 0 ORDER BY received_at ASC, id ASC',
    [itemId]
  );
  let remaining = q;
  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(Number(lot.qty_remaining), remaining);
    await db.run('UPDATE inventory_fifo_lots SET qty_remaining = qty_remaining - $1 WHERE id=$2', [take, lot.id]);
    remaining -= take;
  }
  await recomputeItemCost(db, itemId, newStock);
}

// Reverse a consumption: add `qty` back to the oldest lots (up to their original size).
async function returnFifo(db, itemId, qty, { note, userId }) {
  const q = r4(qty);
  if (!(q > 0)) return;
  const inv = await db.get('SELECT current_stock FROM inventory_items WHERE id=$1', [itemId]);
  const newStock = r4((Number(inv.current_stock) || 0) + q);
  await db.insert(
    `INSERT INTO inventory_transactions (item_id, transaction_type, quantity, balance_after, notes, created_by)
     VALUES ($1,'return_from_production',$2,$3,$4,$5)`,
    [itemId, q, newStock, note, userId]
  );
  const lots = await db.all(
    'SELECT id, qty_original, qty_remaining FROM inventory_fifo_lots WHERE item_id=$1 ORDER BY received_at ASC, id ASC',
    [itemId]
  );
  let remaining = q;
  for (const lot of lots) {
    if (remaining <= 0) break;
    const room = Number(lot.qty_original) - Number(lot.qty_remaining);
    if (room <= 0) continue;
    const add = Math.min(room, remaining);
    await db.run('UPDATE inventory_fifo_lots SET qty_remaining = qty_remaining + $1 WHERE id=$2', [add, lot.id]);
    remaining -= add;
  }
  await recomputeItemCost(db, itemId, newStock);
}

// Called from the checklist PUT after a stage is marked done / undone.
// Stage 5 → tube; Stage 3 → coil (spring gauge). No-op for existing orders.
async function applyMaterialDeductions(db, jobCardId, stageNo, isDone, userId) {
  if (stageNo !== 5 && stageNo !== 3 && stageNo !== 6) return;
  const jc = await db.get(
    `SELECT jc.*, o.material_deduction, o.order_code
     FROM job_cards jc JOIN orders o ON o.id = jc.order_id WHERE jc.id=$1`,
    [jobCardId]
  );
  if (!jc || !jc.material_deduction) return;
  const orderCode = jc.order_code || `Order #${jc.order_id}`;
  const qty = Number(jc.qty) || 0;
  const detail = `${orderCode}${jc.drawing_no ? ` · ${jc.drawing_no}` : ''} · JC ${jc.job_card_no}`;

  if (stageNo === 5) {
    const itemId = await resolveJobCardItemId(db, jc);
    const oi = itemId ? await db.get('SELECT tube_material FROM order_items WHERE id=$1', [itemId]) : null;
    const tube = await invByCode(db, oi?.tube_material, 'tube');
    if (isDone && !jc.tube_deducted) {
      if (!tube) return; // Tube Material isn't a "Tube" inventory code — nothing to deduct
      const s5 = await db.get('SELECT value1, scrap_value FROM production_checklist WHERE job_card_id=$1 AND stage_no=5', [jobCardId]);
      const lenMm = parseFloat(s5?.value1) || 0;
      const scrapIn = parseFloat(s5?.scrap_value) || 0;
      const usedFt = r4((lenMm * qty) / 304.8);   // per-piece length × qty → feet
      const scrapFt = r4((scrapIn * qty) / 12);    // per-piece scrap × qty → feet
      if (usedFt > 0) await consumeFifo(db, tube.id, usedFt, { type: 'dispatch_to_production', note: `Tube used ${usedFt} ft (${lenMm}mm × ${qty} pcs) — ${detail}`, userId });
      if (scrapFt > 0) await consumeFifo(db, tube.id, scrapFt, { type: 'scrap', note: `Scrap tube ${scrapFt} ft (${scrapIn}in × ${qty} pcs) — ${detail}`, userId });
      await db.run('UPDATE job_cards SET tube_deducted=TRUE, tube_used_qty=$1, tube_scrap_qty=$2 WHERE id=$3', [usedFt, scrapFt, jobCardId]);
    } else if (!isDone && jc.tube_deducted) {
      if (tube) {
        if (Number(jc.tube_used_qty) > 0) await returnFifo(db, tube.id, jc.tube_used_qty, { note: `Reverted tube (Stage 5 undone) — ${detail}`, userId });
        if (Number(jc.tube_scrap_qty) > 0) await returnFifo(db, tube.id, jc.tube_scrap_qty, { note: `Reverted tube scrap (Stage 5 undone) — ${detail}`, userId });
      }
      await db.run('UPDATE job_cards SET tube_deducted=FALSE, tube_used_qty=NULL, tube_scrap_qty=NULL WHERE id=$1', [jobCardId]);
    }
  }

  if (stageNo === 3) {
    const s1 = await db.get('SELECT value1 FROM production_checklist WHERE job_card_id=$1 AND stage_no=1', [jobCardId]);
    const gauge = await invByCode(db, s1?.value1, 'spring guage');
    if (isDone && !jc.coil_deducted) {
      if (!gauge) return; // no gauge selected in Stage 1 — nothing to deduct
      const s3 = await db.get('SELECT coil_weight, scrap_value FROM production_checklist WHERE job_card_id=$1 AND stage_no=3', [jobCardId]);
      const wG = parseFloat(s3?.coil_weight) || 0;   // total weight of all coils (g)
      const scrapG = parseFloat(s3?.scrap_value) || 0; // total coil scrap (g)
      const usedKg = r4(wG / 1000);
      const scrapKg = r4(scrapG / 1000);
      if (usedKg > 0) await consumeFifo(db, gauge.id, usedKg, { type: 'dispatch_to_production', note: `Coil wire ${usedKg} Kgs (${wG}g total) — ${detail}`, userId });
      if (scrapKg > 0) await consumeFifo(db, gauge.id, scrapKg, { type: 'scrap', note: `Scrap coil ${scrapKg} Kgs (${scrapG}g) — ${detail}`, userId });
      await db.run('UPDATE job_cards SET coil_deducted=TRUE, coil_used_qty=$1, coil_scrap_qty=$2 WHERE id=$3', [usedKg, scrapKg, jobCardId]);
    } else if (!isDone && jc.coil_deducted) {
      if (gauge) {
        if (Number(jc.coil_used_qty) > 0) await returnFifo(db, gauge.id, jc.coil_used_qty, { note: `Reverted coil wire (Stage 3 undone) — ${detail}`, userId });
        if (Number(jc.coil_scrap_qty) > 0) await returnFifo(db, gauge.id, jc.coil_scrap_qty, { note: `Reverted coil scrap (Stage 3 undone) — ${detail}`, userId });
      }
      await db.run('UPDATE job_cards SET coil_deducted=FALSE, coil_used_qty=NULL, coil_scrap_qty=NULL WHERE id=$1', [jobCardId]);
    }
  }

  if (stageNo === 6) {
    const itemId = await resolveJobCardItemId(db, jc);
    const oi = itemId ? await db.get('SELECT tube_diameter FROM order_items WHERE id=$1', [itemId]) : null;
    const dia = String(oi?.tube_diameter || '').trim();
    // Tube Diameter is a required 8mm/11mm dropdown at order-item creation, so this is
    // expected to always resolve for material-tracked orders; falls through safely if not.
    const pvcCode = dia === '8' ? 'PVC-FB08-M4' : dia === '11' ? 'PVC-FB11-M5' : null;
    const mgoGPerInch = dia === '8' ? 0.018 / 5 : dia === '11' ? 0.027 / 5 : null;
    const pvc = pvcCode ? await invByCode(db, pvcCode, 'bush') : null;
    const mgo = await invByCode(db, 'MGO-65A', 'powder');

    if (isDone && !jc.fill_deducted) {
      if (!pvc && !mgo) return; // no matching bush/powder items — nothing to deduct
      const s5 = await db.get('SELECT value1 FROM production_checklist WHERE job_card_id=$1 AND stage_no=5', [jobCardId]);
      const lenMm = parseFloat(s5?.value1) || 0;
      const pvcQty = pvc ? r4(2 * qty) : 0; // 2 bushes per piece × qty
      let mgoKg = 0;
      if (mgo && mgoGPerInch != null && lenMm > 0) {
        const totalInches = (lenMm * qty) / 25.4;
        mgoKg = r4((totalInches * mgoGPerInch) / 1000);
      }
      if (pvcQty > 0) await consumeFifo(db, pvc.id, pvcQty, { type: 'dispatch_to_production', note: `Filling bush ${pvcQty} pcs (${dia}mm dia × ${qty} pcs) — ${detail}`, userId });
      if (mgoKg > 0) await consumeFifo(db, mgo.id, mgoKg, { type: 'dispatch_to_production', note: `MGO powder ${mgoKg} kg (${dia}mm dia, ${lenMm}mm × ${qty} pcs) — ${detail}`, userId });
      await db.run('UPDATE job_cards SET fill_deducted=TRUE, fill_pvc_qty=$1, fill_mgo_qty=$2 WHERE id=$3', [pvcQty || null, mgoKg || null, jobCardId]);
    } else if (!isDone && jc.fill_deducted) {
      if (pvc && Number(jc.fill_pvc_qty) > 0) await returnFifo(db, pvc.id, jc.fill_pvc_qty, { note: `Reverted filling bush (Stage 6 undone) — ${detail}`, userId });
      if (mgo && Number(jc.fill_mgo_qty) > 0) await returnFifo(db, mgo.id, jc.fill_mgo_qty, { note: `Reverted MGO powder (Stage 6 undone) — ${detail}`, userId });
      await db.run('UPDATE job_cards SET fill_deducted=FALSE, fill_pvc_qty=NULL, fill_mgo_qty=NULL WHERE id=$1', [jobCardId]);
    }
  }
}

module.exports = { applyMaterialDeductions };
