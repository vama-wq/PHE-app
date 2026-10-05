// ── Checklist-driven tube & spring-gauge consumption (new orders only) ─────────
// Tube and Spring-Gauge wire are NOT part of the design BOM. They are deducted
// from stock based on ACTUAL usage recorded in the production checklist, with
// FIFO lot draw-down so landed-cost valuation stays accurate:
//   • Stage 5 (Tube Cutting): tube used  = the job card's cutting length (mm) × qty × elements
//                                          → feet (÷304.8); typed value1 (mm) × qty only for a
//                                          card with no generated spec (owner, 4 Oct 2026)
//                             tube scrap = scrap (inches)× qty  → feet  (÷12)
//     Tube inventory item = the order item's Tube Material (item code, category "Tube").
//   • Stage 4 (Spot) done — deducted once Stage 4 completes, using the data entered
//     at Stage 3 (Ohms): coil used  = coil_weight — the box is KG — taken as kg as typed
//                                     (it was wrongly ÷1000 until 4 Oct 2026)
//                        coil scrap = scrap — also KG, as typed (was ÷1000 as grams until 5 Oct 2026)
//     Gauge inventory item = Stage 1 gauge pick (item code, category "Spring Guage").
//   • Stage 6 (Filling):      PVC bush   = 2 pcs per element (qty × elements) — PVC-FB08-M4 (8mm dia) or
//                                          PVC-FB11-M5 (11mm dia), by the order item's Tube Diameter.
//                             MGO-65A powder = (cutting length(mm) × qty × elements, as for the
//                                          tube) → inches ÷25.4, × KG per inch (8mm: 0.018 kg/5in;
//                                          11mm: 0.027 kg/5in). No ÷1000 — 18 g per 5 inches.
//     A split child or a replacement card uses the job card it came from (cardSpec.specForCard).
// Only runs for orders flagged material_deduction=TRUE (created after this feature).

const { resolveJobCardItemId } = require('./inventoryDeduction');
const { cardLengths, specForCard } = require('./cardSpec');
const { logActivity } = require('../db');

const r4 = (n) => Math.round(Number(n) * 1e4) / 1e4;

// Workers sometimes record several readings in one field — "1610-1625",
// "12.5+12.6", "56, 57" — so measurement fields deduct on the AVERAGE of every
// number found, whatever separates them (+ , - / spaces).
const avgNumbers = (v) => {
  const nums = (String(v ?? '').match(/\d+(?:\.\d+)?/g) || []).map(Number);
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
};

// Incoloy tube is not taken at Stage 5 until its next purchase is received
// after this moment (owner, 4 Oct 2026 — see Stage 5 below).
const INCOLOY_PAUSED_FROM = '2026-10-04T00:00:00+05:30';
const isIncoloy = (tube) => /incoloy/i.test(tube?.name || '') || /^TUB-INC/i.test(tube?.item_code || '');

// The tube (Stage 5) and MgO (Stage 6) a card uses go by what the card itself
// says (owner, 4 Oct 2026): the app-generated job card's cutting length, for
// every element it makes — a 3in1 card of 12 heaters cuts 36 lengths. Not the
// figure typed at Stage 5. A card without a generated spec (made before the
// generator, or uploaded) still goes by what was typed.
async function cardCutting(db, jc) {
  const L = cardLengths(await specForCard(db, jc));
  return L && L.cutMm ? { mm: L.cutMm, elements: L.elements } : null;
}

async function invByCode(db, code, category) {
  if (!code) return null;
  return db.get(
    'SELECT id, unit, name, item_code FROM inventory_items WHERE upper(item_code)=upper($1) AND lower(trim(category))=$2 LIMIT 1',
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
// Stage 5 → tube; Stage 4 → coil/spring-gauge (using Stage 3 data); Stage 6 → filling.
// No-op for existing orders.
async function applyMaterialDeductions(db, jobCardId, stageNo, isDone, userId) {
  if (stageNo !== 5 && stageNo !== 4 && stageNo !== 6) return;
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
      // Incoloy (owner, 4 Oct 2026): every Incoloy tube was set to 0 because tube
      // had been taken without its purchases ever received. Until that tube's next
      // purchase comes in, Stage 5 takes none of it — work goes on, stock stays at
      // 0. Each Incoloy tube resumes by itself once a purchase of it is received.
      if (isIncoloy(tube) && !(await db.get(
        `SELECT 1 FROM inventory_transactions WHERE item_id=$1 AND transaction_type='purchase_in' AND created_at >= $2 LIMIT 1`,
        [tube.id, INCOLOY_PAUSED_FROM]))) {
        await logActivity(jc.order_id, jobCardId, 'tube_not_taken',
          `${tube.item_code} not taken from stock at Stage 5 — Incoloy is paused until its next purchase is received (owner, 4 Oct 2026) — ${detail}`, userId);
        await db.run('UPDATE job_cards SET tube_deducted=TRUE, tube_used_qty=0, tube_scrap_qty=0 WHERE id=$1', [jobCardId]);
        return;
      }
      const s5 = await db.get('SELECT value1, scrap_value FROM production_checklist WHERE job_card_id=$1 AND stage_no=5', [jobCardId]);
      const cut = await cardCutting(db, jc);
      const lenMm = cut ? cut.mm : avgNumbers(s5?.value1);
      const lengths = cut ? qty * cut.elements : qty;   // tube lengths actually cut
      let scrapIn = parseFloat(s5?.scrap_value) || 0; // per-piece scrap, inches
      // Abnormally large scrap (a bad cut/rework, not normal trim waste) is excluded from
      // scrap accounting entirely — not deducted. Copper: 14in or more; other tube
      // materials: above 16in. Checked on the per-piece value before scaling by qty.
      const isCopper = /copper/i.test(tube.name || '') || /-cu-/i.test(tube.item_code || '');
      const scrapExcluded = isCopper ? scrapIn >= 14 : scrapIn > 16;
      if (scrapExcluded) {
        await logActivity(jc.order_id, jobCardId, 'scrap_excluded',
          `Tube scrap of ${scrapIn}in excluded from deduction (${isCopper ? 'copper ≥14in' : '>16in'} threshold) — ${detail}`, userId);
        scrapIn = 0;
      }
      const usedFt = r4((lenMm * lengths) / 304.8);   // cutting length × lengths cut → feet
      const scrapFt = r4((scrapIn * qty) / 12);    // per-piece scrap × qty → feet
      const howCut = cut
        ? `${lenMm}mm job card cutting length × ${cut.elements > 1 ? `${lengths} (${qty} × ${cut.elements}in1)` : `${qty} pcs`}`
        : `${lenMm}mm as typed at Stage 5 × ${qty} pcs`;
      if (usedFt > 0) await consumeFifo(db, tube.id, usedFt, { type: 'dispatch_to_production', note: `Tube used ${usedFt} ft (${howCut}) — ${detail}`, userId });
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

  if (stageNo === 4) {
    // Triggered by Stage 4 (Spot) completion, but the coil weight/scrap figures are
    // entered at Stage 3 (Ohms) — read from there (should already be filled in by the
    // time Stage 4 is done, since Stage 3 requires the coil weight before it can be
    // marked done itself and production runs through the stages in order).
    const s1 = await db.get('SELECT value1 FROM production_checklist WHERE job_card_id=$1 AND stage_no=1', [jobCardId]);
    const gauge = await invByCode(db, s1?.value1, 'spring guage');
    if (isDone && !jc.coil_deducted) {
      if (!gauge) return; // no gauge selected in Stage 1 — nothing to deduct
      const s3 = await db.get('SELECT coil_weight, scrap_value FROM production_checklist WHERE job_card_id=$1 AND stage_no=3', [jobCardId]);
      // The Stage 3 box is "Total Weight of All Coils (kg)" and the floor types
      // kg. Until 4 Oct 2026 it was read as grams, so coil wire left stock at a
      // thousandth of what was used (owner confirmed the fix). Scrap is "(g, total)".
      const usedKg = r4(parseFloat(s3?.coil_weight) || 0);   // total weight of all coils (kg)
      // Coil scrap is kg too — "coil is always put in kgs" (owner, 5 Oct 2026).
      const scrapKg = r4(parseFloat(s3?.scrap_value) || 0);   // total coil scrap (kg)
      if (usedKg > 0) await consumeFifo(db, gauge.id, usedKg, { type: 'dispatch_to_production', note: `Coil wire ${usedKg} Kgs (total weight of all coils, Stage 3) — ${detail}`, userId });
      if (scrapKg > 0) await consumeFifo(db, gauge.id, scrapKg, { type: 'scrap', note: `Scrap coil ${scrapKg} Kgs (coil scrap, Stage 3) — ${detail}`, userId });
      await db.run('UPDATE job_cards SET coil_deducted=TRUE, coil_used_qty=$1, coil_scrap_qty=$2 WHERE id=$3', [usedKg, scrapKg, jobCardId]);
    } else if (!isDone && jc.coil_deducted) {
      if (gauge) {
        if (Number(jc.coil_used_qty) > 0) await returnFifo(db, gauge.id, jc.coil_used_qty, { note: `Reverted coil wire (Stage 4 undone) — ${detail}`, userId });
        if (Number(jc.coil_scrap_qty) > 0) await returnFifo(db, gauge.id, jc.coil_scrap_qty, { note: `Reverted coil scrap (Stage 4 undone) — ${detail}`, userId });
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
    // 18 g of MgO per 5 inches of 8 mm tube, 27 g for 11 mm (owner confirmed,
    // 4 Oct 2026). Until then the figure was read as grams, a thousandth too low.
    const mgoKgPerInch = dia === '8' ? 0.018 / 5 : dia === '11' ? 0.027 / 5 : null;
    const pvc = pvcCode ? await invByCode(db, pvcCode, 'bush') : null;
    const mgo = await invByCode(db, 'MGO-65A', 'powder');

    if (isDone && !jc.fill_deducted) {
      if (!pvc && !mgo) return; // no matching bush/powder items — nothing to deduct
      const s5 = await db.get('SELECT value1 FROM production_checklist WHERE job_card_id=$1 AND stage_no=5', [jobCardId]);
      const cut = await cardCutting(db, jc);
      const lenMm = cut ? cut.mm : avgNumbers(s5?.value1);
      const lengths = cut ? qty * cut.elements : qty;
      // 2 filling bushes per element (owner, 5 Oct 2026): a 3in1 heater takes 6.
      const pvcQty = pvc ? r4(2 * lengths) : 0;
      let mgoKg = 0;
      if (mgo && mgoKgPerInch != null && lenMm > 0) {
        const totalInches = (lenMm * lengths) / 25.4;
        mgoKg = r4(totalInches * mgoKgPerInch);
      }
      const mgoHow = cut ? `${lenMm}mm job card cutting length × ${cut.elements > 1 ? `${lengths} (${qty} × ${cut.elements}in1)` : `${qty} pcs`}` : `${lenMm}mm × ${qty} pcs`;
      if (pvcQty > 0) await consumeFifo(db, pvc.id, pvcQty, { type: 'dispatch_to_production', note: `Filling bush ${pvcQty} pcs (2 × ${cut && cut.elements > 1 ? `${lengths} elements (${qty} × ${cut.elements}in1)` : `${qty} pcs`}, ${dia}mm dia) — ${detail}`, userId });
      if (mgoKg > 0) await consumeFifo(db, mgo.id, mgoKg, { type: 'dispatch_to_production', note: `MGO powder ${mgoKg} kg (${dia}mm dia, ${mgoHow}) — ${detail}`, userId });
      await db.run('UPDATE job_cards SET fill_deducted=TRUE, fill_pvc_qty=$1, fill_mgo_qty=$2 WHERE id=$3', [pvcQty || null, mgoKg || null, jobCardId]);
    } else if (!isDone && jc.fill_deducted) {
      if (pvc && Number(jc.fill_pvc_qty) > 0) await returnFifo(db, pvc.id, jc.fill_pvc_qty, { note: `Reverted filling bush (Stage 6 undone) — ${detail}`, userId });
      if (mgo && Number(jc.fill_mgo_qty) > 0) await returnFifo(db, mgo.id, jc.fill_mgo_qty, { note: `Reverted MGO powder (Stage 6 undone) — ${detail}`, userId });
      await db.run('UPDATE job_cards SET fill_deducted=FALSE, fill_pvc_qty=NULL, fill_mgo_qty=NULL WHERE id=$1', [jobCardId]);
    }
  }
}

module.exports = { applyMaterialDeductions };
