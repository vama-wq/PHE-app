// ── Terminal pins per job card (owner, 6 Oct 2026) ───────────────────────────
// The right terminal pin for a heater is the one on the item's list — design's
// pick at drawing upload — not the stud length the card generator computes
// (they often differ; design picks the correct one). Each job card gets its
// OWN terminal-pin rows, defaulting to the list's 'Terminal Pin' lines for
// that card's share. Design can change a card's pins (another pin, a length,
// a count) when something else is used for that card; the card then takes the
// changed pins at its last stage instead of the list's.
//
// Rules the owner set:
//   • QC is told ONLY when a pin is NOT in stock: current stock < this card's
//     need. Rework pins never trigger anything.
//   • A short pin BLOCKS the card's material slip until someone presses OK —
//     the owner or the "Design / QC" login (roles 'owner' and 'design', never
//     user ids), who both get the message.
//   • Scope: inventory category 'Terminal Pin' only (TP-SS-…, TP-MS-…). Heavy
//     terminal pins, nuts and washers stay on the list exactly as before.
//     TRAIN placeholders are never picked.
//   • Finished-goods cards: their pins are inside the heater — no rows at all.
//
// Rows are made lazily, the first time a card's terminals are read (slip,
// editor, last stage): list line qty × card qty ÷ item quantity, whole pieces,
// source 'list'. A split child seeds from its own qty when first read.
//
// At the last stage the card's rows leave stock with source 'terminal' (not
// 'bom' / 'correction'), so a BOM correction never sees — and never gives back
// — a pin design changed for one card; the list's Terminal Pin share for the
// card is written to qty_waived instead, so the line is settled.

const rework = require('./rework');
const { recordMove, PLACEHOLDER, PASSED_QC, TERMINAL_CATEGORY, isTerminalCategory } = require('./stockLedger');
const { logActivity } = require('../db');
const EDIT_ROLES = ['design', 'admin', 'owner'];
const OK_ROLES = ['owner', 'design'];

// Finished goods: the pins are inside the heater already.
const noTerminals = (card) => !!card?.is_fg || card?.order_type === 'finished_goods';

// A card past the point where pins are issued: its last stage is taken, or it
// was through QC / dispatched (cards from before this went live took their
// pins at QC). Such a card gets no rows, no stock check and no alert — only
// what it already has is read.
const pastPins = (card) => !!card?.last_stage_taken_at || !!card?.dispatched_at || !!card?.inventory_qc_at
  || PASSED_QC.has(card?.status) || card?.status === 'qc_pending';

// This card's share of a list line, in whole pieces.
function shareFor(lineQty, cardQty, itemQty) {
  const total = Number(lineQty) || 0;
  const share = Number(itemQty) > 0 ? (total * (Number(cardQty) || 0)) / Number(itemQty) : total;
  return Math.max(0, Math.round(share));
}

// The item's 'Terminal Pin' lines, with the card's share of each.
async function listTerminalLines(db, itemId, card, itemQty) {
  if (!itemId) return [];
  const lines = await db.all(
    `SELECT oii.*, ii.item_code, ii.name, ii.name_gu, ii.unit, TRIM(ii.category) AS category
       FROM order_item_inventory oii JOIN inventory_items ii ON ii.id = oii.inventory_item_id
      WHERE oii.order_item_id=$1 AND LOWER(TRIM(ii.category)) = LOWER($2)
      ORDER BY ii.item_code`, [itemId, TERMINAL_CATEGORY]);
  return lines.map(l => ({ ...l, share: shareFor(l.qty, card?.qty, itemQty) }));
}

// The card's rows with what the editor and the slip need to know about each pin.
async function readTerminals(db, cardId) {
  return db.all(
    `SELECT t.id, t.job_card_id, t.inventory_item_id, t.qty::float AS qty, t.source, t.updated_by, t.updated_at,
            u.name AS updated_by_name,
            ii.item_code, ii.name, ii.name_gu, ii.unit, TRIM(ii.category) AS category,
            ii.current_stock::float AS current_stock,
            COALESCE(b.qty,0)::float AS rework_bin,
            GREATEST(COALESCE(b.qty,0) - COALESCE((
                SELECT SUM(GREATEST(oii.rework_qty - oii.rework_deducted, 0))
                  FROM order_item_inventory oii JOIN order_items oi ON oi.id = oii.order_item_id
                 WHERE oii.inventory_item_id = ii.id AND oi.inventory_deducted = FALSE), 0), 0)::float AS rework_free
       FROM job_card_terminals t
       JOIN inventory_items ii ON ii.id = t.inventory_item_id
       LEFT JOIN inventory_rework_bins b ON b.item_id = ii.id
       LEFT JOIN users u ON u.id = t.updated_by
      WHERE t.job_card_id=$1 ORDER BY ii.item_code, t.id`, [cardId]);
}

// Resolve the card's order item and quantity (the list's denominator).
async function itemFor(db, card) {
  const { resolveJobCardItemId } = require('./inventoryDeduction');
  const itemId = await resolveJobCardItemId(db, card);
  const item = itemId ? await db.get('SELECT id, drawing_number, quantity FROM order_items WHERE id=$1', [itemId]) : null;
  return { itemId, item, itemQty: Number(item?.quantity) || 0 };
}

// The card's rows, seeded from the list the first time nothing is there.
// Returns { rows, lines, item } — lines are the list's Terminal Pin lines for
// reference. Never seeds a finished-goods card.
// A card whose rows are all 'from list' follows the list until its last
// stage: when design corrects the list's pin (the owner's rule — the list is
// the right pin), the card's rows are redone from it. Rows design changed by
// hand for the card are left exactly as design set them.
async function ensureTerminals(db, card, { seed = true } = {}) {
  const { itemId, item, itemQty } = await itemFor(db, card);
  if (noTerminals(card)) return { rows: [], lines: [], item, itemQty };
  const lines = await listTerminalLines(db, itemId, card, itemQty);
  let rows = await readTerminals(db, card.id);
  if (!seed || pastPins(card)) return { rows, lines, item, itemQty };
  const want = lines.filter(l => l.share > 0 && !PLACEHOLDER.test(l.item_code || ''))
    .map(l => ({ inventory_item_id: l.inventory_item_id, qty: l.share, item_code: l.item_code }));
  const key = (r) => `${r.inventory_item_id}:${Math.round(Number(r.qty))}`;
  const allFromList = rows.every(r => r.source === 'list');
  const differs = rows.length !== want.length || want.some(w => !rows.some(r => key(r) === key(w)));
  if (allFromList && differs && (rows.length || want.length)) {
    const before = rows.map(r => `${r.item_code} × ${r.qty}`).join(', ') || 'none';
    await db.run('DELETE FROM job_card_terminals WHERE job_card_id=$1', [card.id]);
    for (const w of want) {
      await db.run(
        `INSERT INTO job_card_terminals (job_card_id, inventory_item_id, qty, source) VALUES ($1,$2,$3,'list')
         ON CONFLICT (job_card_id, inventory_item_id) DO UPDATE SET qty = EXCLUDED.qty, source = 'list'`,
        [card.id, w.inventory_item_id, w.qty]);
    }
    if (rows.length) {
      // The list changed under rows made from it: a new set of pins is a new question.
      await db.run(
        'UPDATE job_cards SET terminals_short_at = NULL, terminals_ok_by = NULL, terminals_ok_at = NULL, terminals_ok_note = NULL WHERE id=$1',
        [card.id]);
      await logActivity(card.order_id, card.id, 'terminals_changed',
        `Terminal pins for ${card.job_card_no} follow the corrected list: ${want.map(w => `${w.item_code} × ${w.qty}`).join(', ') || 'none'} (was: ${before})`, null);
    }
    rows = await readTerminals(db, card.id);
  }
  return { rows, lines, item, itemQty };
}

// Where the OK state stands, from the card row.
const okState = (card) => card.terminals_ok_at
  ? { by: card.terminals_ok_by, at: card.terminals_ok_at, note: card.terminals_ok_note || null }
  : null;

// Short = a row whose current stock is below this card's need. Checked only
// while the card has not taken its last stage: afterwards the pins have left
// stock (which may well read below the need now) and the slip is a reprint.
// When short and not OK'd: stamp terminals_short_at and tell the owner and
// Design / QC once per short state. When the stock covers it again, the short
// state — and any OK pressed for it — is cleared, so a later shortage asks
// again.
async function checkTerminals(db, jc, { notify = true } = {}) {
  const card = await db.get(
    `SELECT jc.*, o.order_type FROM job_cards jc JOIN orders o ON o.id = jc.order_id WHERE jc.id=$1`, [jc.id]);
  if (!card) return { rows: [], lines: [], short: [], held: false, ok: null };
  const { rows, lines, item, itemQty } = await ensureTerminals(db, card);
  const short = pastPins(card) ? [] : rows
    .filter(r => Number(r.current_stock) < Number(r.qty))
    .map(r => ({ inventory_item_id: r.inventory_item_id, item_code: r.item_code, name: r.name, unit: r.unit || '',
                 need: Number(r.qty), stock: Number(r.current_stock) }));
  let ok = okState(card);
  let shortAt = card.terminals_short_at;

  if (short.length) {
    if (!ok && !shortAt) {
      await db.run('UPDATE job_cards SET terminals_short_at = NOW() WHERE id=$1 AND terminals_short_at IS NULL', [card.id]);
      shortAt = new Date();
      if (notify) await notifyShort(db, card, short);
    }
  } else if (shortAt || ok) {
    await db.run(
      'UPDATE job_cards SET terminals_short_at = NULL, terminals_ok_by = NULL, terminals_ok_at = NULL, terminals_ok_note = NULL WHERE id=$1',
      [card.id]);
    shortAt = null; ok = null;
  }
  return {
    rows: rows.map(r => ({ ...r, short: short.some(s => s.inventory_item_id === r.inventory_item_id) })),
    lines, item, itemQty, short, short_at: shortAt, ok,
    held: short.length > 0 && !ok,
    last_stage_taken_at: card.last_stage_taken_at,
  };
}

// "Job card <no>: terminal pin <code> short — need <q>, stock <s>. Press OK to
// release the slip." — to every owner and every Design / QC login, on the
// dashboard and through the WhatsApp follow-through (routes/notifications.js).
async function notifyShort(db, card, short) {
  const { notifyRole } = require('../routes/notifications');
  const what = short.map(s => `terminal pin ${s.item_code} short — need ${s.need}, stock ${s.stock}`).join('; ');
  const payload = {
    type: 'terminals_short',
    title: `Terminal pin short — ${card.job_card_no}`,
    body: `Job card ${card.job_card_no}: ${what}. Press OK to release the slip.`,
    link: `/job-cards/${card.id}`,
    ref: { type: 'terminals_short', id: card.id },
  };
  for (const role of ['owner', 'design']) {
    try { await notifyRole(db, role, payload); }
    catch (e) { console.error(`[terminals] could not notify ${role}:`, e.message); }
  }
  await logActivity(card.order_id, card.id, 'terminals_short',
    `Terminal pin short on ${card.job_card_no}: ${what} — slip held until the owner or Design / QC presses OK`, null);
}

// Design's replacement of a card's rows. rows: [{ inventory_item_id, qty }].
// Refused once the last stage is taken — the pins have left stock by then;
// any later difference is fixed at Inventory QC. Saving resets an earlier OK
// and the short state (a new set of pins is a new question), then re-runs the
// stock check so the owner and Design / QC hear about it if still short.
async function saveTerminals(db, jc, rows, user) {
  const card = await db.get(
    `SELECT jc.*, o.order_type, o.order_code FROM job_cards jc JOIN orders o ON o.id = jc.order_id WHERE jc.id=$1`, [jc.id]);
  if (!card) throw httpError(404, 'Job card not found');
  if (noTerminals(card)) throw httpError(400, 'A finished-goods card has no terminal pins of its own — they are inside the heater.');
  if (pastPins(card)) {
    throw httpError(400, `${card.job_card_no} is past the point where pins are issued — any difference is fixed at Inventory QC.`);
  }
  const wanted = Array.isArray(rows) ? rows : [];
  if (!wanted.length) throw httpError(400, 'A job card needs at least one terminal pin.');
  if (wanted.length > 20) throw httpError(400, 'Too many terminal pin rows — at most 20.');
  const clean = [];
  const seen = new Set();
  for (const r of wanted) {
    const id = parseInt(r?.inventory_item_id, 10);
    const qty = Number(r?.qty);
    if (!id) throw httpError(400, 'Each row needs a terminal pin.');
    if (seen.has(id)) throw httpError(400, 'The same terminal pin is listed twice — give it one row with the total.');
    seen.add(id);
    if (!Number.isInteger(qty) || !(qty > 0)) throw httpError(400, 'Terminal pin quantity must be a whole number above 0.');
    const inv = await db.get('SELECT id, item_code, TRIM(category) AS category FROM inventory_items WHERE id=$1', [id]);
    if (!inv) throw httpError(400, `Inventory item #${id} not found.`);
    if (!isTerminalCategory(inv.category)) throw httpError(400, `${inv.item_code} is in category "${inv.category}" — only 'Terminal Pin' items go here (heavy pins, nuts and washers stay on the list).`);
    if (PLACEHOLDER.test(inv.item_code || '')) throw httpError(400, `${inv.item_code} is a TRAIN placeholder — pick the real pin.`);
    clean.push({ inventory_item_id: id, qty, item_code: inv.item_code });
  }

  const before = await readTerminals(db, card.id);
  const { itemId, itemQty } = await itemFor(db, card);
  const lines = await listTerminalLines(db, itemId, card, itemQty);
  // A row that is exactly the list's share is still "from list"; anything
  // else is design's change for this card.
  const sourceOf = (r) => lines.some(l => l.inventory_item_id === r.inventory_item_id && l.share === r.qty) ? 'list' : 'design';

  await db.run('DELETE FROM job_card_terminals WHERE job_card_id=$1', [card.id]);
  for (const r of clean) {
    await db.run(
      `INSERT INTO job_card_terminals (job_card_id, inventory_item_id, qty, source, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (job_card_id, inventory_item_id) DO UPDATE SET qty = EXCLUDED.qty, source = EXCLUDED.source, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [card.id, r.inventory_item_id, r.qty, sourceOf(r), user.id]);
  }
  await db.run(
    'UPDATE job_cards SET terminals_short_at = NULL, terminals_ok_by = NULL, terminals_ok_at = NULL, terminals_ok_note = NULL WHERE id=$1',
    [card.id]);
  const fmt = (list) => list.map(r => `${r.item_code} × ${r.qty}`).join(', ') || 'none';
  await logActivity(card.order_id, card.id, 'terminals_changed',
    `Terminal pins for ${card.job_card_no} set by ${user.name}: ${fmt(clean)} (was: ${fmt(before)})`, user.id);
  return checkTerminals(db, card);
}

// The owner or Design / QC releasing a held slip. Only meaningful while the
// card is short and not yet OK'd — an OK recorded when nothing is short would
// silently release a later shortage.
async function okTerminals(db, jc, user, note) {
  const state = await checkTerminals(db, jc);
  if (!state.short.length) throw httpError(400, 'No terminal pin is short for this job card — the slip is not held.', 'NOT_SHORT');
  if (state.ok) return { ...state, held: false, already: true };
  const card = await db.get('SELECT * FROM job_cards WHERE id=$1', [jc.id]);
  const text = String(note || '').trim().slice(0, 500) || null;
  await db.run('UPDATE job_cards SET terminals_ok_by=$1, terminals_ok_at=NOW(), terminals_ok_note=$2 WHERE id=$3', [user.id, text, card.id]);
  const what = state.short.map(s => `${s.item_code} (need ${s.need}, stock ${s.stock})`).join(', ');
  await logActivity(card.order_id, card.id, 'terminals_ok',
    `Terminal pin shortage on ${card.job_card_no} OK'd by ${user.name} — slip released. Short: ${what}${text ? `. Note: ${text}` : ''}`, user.id);
  const after = await checkTerminals(db, card);
  return { ...after, held: false };
}

// ── Last-stage take of the card's rows ───────────────────────────────────────
// Called by lastStageTake.js inside its transaction. tpLines are the item's
// 'Terminal Pin' lines (with qty_deducted / qty_waived as they stand). Each
// row leaves stock with source 'terminal' + job_card_id — rework bin first when
// the list line for the same pin has a rework portion, the rest from stock —
// and the list's share for this card is written to qty_waived so the line
// bookkeeping and BOM corrections see it as settled without ever touching
// the design-changed pin. Returns null when the card has no rows (seed failed
// / nothing on the list): the caller then falls back to today's list share.
async function takeTerminalRows(tx, card, item, tpLines, orderCode, userId) {
  // The take runs on the stage-29 tick, when the card already reads as QC
  // pending — so the seed / list follow-up is forced here, once, before taking.
  const { rows } = await ensureTerminals(tx, { ...card, status: 'in_progress', last_stage_taken_at: null });
  if (!rows.length) return null;
  const itemQty = Number(item.quantity) || 0;
  const taken = [];
  const noteParts = [`Order: ${orderCode}`];
  if (item.drawing_number) noteParts.push(`Dwg: ${item.drawing_number}`);
  noteParts.push(`Terminal pins (JC ${card.job_card_no})`);
  const baseNote = noteParts.join(' | ');

  for (const row of rows) {
    const need = Math.round(Number(row.qty) || 0);
    if (!(need > 0)) continue;
    const line = tpLines.find(l => l.inventory_item_id === row.inventory_item_id) || null;
    let note = baseNote;
    let fromRework = 0;
    const wantRework = line ? Math.max(0, Number(line.rework_qty || 0) - Number(line.rework_deducted || 0)) : 0;
    if (wantRework > 0) {
      const available = await rework.binQty(tx, row.inventory_item_id);
      fromRework = Math.min(need, wantRework, available);
      if (fromRework > 0) {
        await rework.move(tx, { itemId: row.inventory_item_id, kind: 'draw', qty: fromRework,
          ref: { order_id: card.order_id, order_item_id: item.id, job_card_id: card.id, order_code: orderCode,
                 job_card_no: card.job_card_no, drawing_number: item.drawing_number || null },
          notes: note, userId });
        await tx.run('UPDATE order_item_inventory SET rework_deducted = COALESCE(rework_deducted,0) + $1 WHERE id=$2',
          [fromRework, line.id]);
      }
      const shortBin = Math.min(need, wantRework) - fromRework;
      if (shortBin > 0) {
        // Bin short: the rest comes from stock, and the reservation is released.
        await tx.run('UPDATE order_item_inventory SET rework_qty = COALESCE(rework_deducted,0) WHERE id=$1', [line.id]);
        note = `${note} | rework bin short by ${shortBin} — taken from stock`;
      }
    }
    const fromStock = need - fromRework;
    if (fromStock > 0) {
      // Allowed below zero so a shortage stays visible — production is never
      // blocked here; the slip hold above is where a short pin is caught.
      const after = Number((await tx.get(
        'UPDATE inventory_items SET current_stock = current_stock - $1 WHERE id=$2 RETURNING current_stock',
        [fromStock, row.inventory_item_id])).current_stock);
      await recordMove(tx, { itemId: row.inventory_item_id, type: 'dispatch_to_production', qty: fromStock, balanceAfter: after,
        notes: fromRework > 0 ? `${note} | ${fromRework} from rework bin` : note, userId,
        orderItemId: item.id, source: 'terminal', jobCardId: card.id });
    }
    taken.push({ inventory_item_id: row.inventory_item_id, item_code: row.item_code, qty: need, unit: row.unit || '', source: row.source });
  }

  // The list's share for this card is settled without stock: the rows above
  // are what really left, under their own source.
  for (const line of tpLines) {
    const total = Number(line.qty) || 0;
    const share = shareFor(total, card.qty, itemQty);
    const left = total - (Number(line.qty_deducted) || 0) - (Number(line.qty_waived) || 0);
    const waive = Math.min(share, Math.max(0, left));
    if (waive > 1e-4) {
      await tx.run('UPDATE order_item_inventory SET qty_waived = COALESCE(qty_waived,0) + $1 WHERE id=$2', [waive, line.id]);
    }
  }
  return { taken };
}

// A partial-dispatch split leaves the parent with fewer pieces. Its rows were
// made for the pre-split quantity, so they are scaled to what remains (whole
// pieces) — otherwise the parent would take pins for pieces now on the child,
// which seeds its own rows when first read. Nothing to do once the parent has
// taken its last stage (the child inherits that flag and takes nothing).
async function rescaleAfterSplit(tx, parentId, oldQty, newQty, userId) {
  const card = await tx.get('SELECT id, job_card_no, order_id, last_stage_taken_at FROM job_cards WHERE id=$1', [parentId]);
  if (!card || card.last_stage_taken_at || !(Number(oldQty) > 0) || !(Number(newQty) > 0)) return;
  const rows = await tx.all(
    `SELECT t.id, t.qty::float AS qty, ii.item_code FROM job_card_terminals t JOIN inventory_items ii ON ii.id = t.inventory_item_id
      WHERE t.job_card_id=$1`, [parentId]);
  if (!rows.length) return;
  const changed = [];
  for (const r of rows) {
    const q = Math.max(0, Math.round((r.qty * Number(newQty)) / Number(oldQty)));
    if (q === r.qty) continue;
    if (q > 0) await tx.run('UPDATE job_card_terminals SET qty=$1, updated_at=NOW() WHERE id=$2', [q, r.id]);
    else await tx.run('DELETE FROM job_card_terminals WHERE id=$1', [r.id]);   // a pin with nothing left is no row
    changed.push(`${r.item_code} ${r.qty} → ${q}`);
  }
  if (changed.length) {
    // Through the split's own transaction, so the note goes only if the split does.
    await tx.run(
      `INSERT INTO activity_log (order_id, job_card_id, activity_type, description, created_by) VALUES ($1,$2,'terminals_changed',$3,$4)`,
      [card.order_id, card.id,
       `Terminal pins for ${card.job_card_no} scaled to its remaining ${newQty} pcs after the split: ${changed.join(', ')}`, userId || null]);
  }
}

function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

module.exports = {
  TERMINAL_CATEGORY, isTerminalCategory, noTerminals, shareFor, EDIT_ROLES, OK_ROLES,
  readTerminals, listTerminalLines, ensureTerminals, checkTerminals, saveTerminals, okTerminals,
  takeTerminalRows, rescaleAfterSplit, okState, pastPins,
};
