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
//   • Rework-bin pins go on the item's LAST job cards; the first cards take new
//     stock (9 Oct 2026). On app-picked pins the bin is used only when stock
//     runs out, and only once the owner or Design / QC approves.
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

// FROM 8 OCT 2026 (owner): "i should not be asked to add terminal pin anymore,
// just like we dont add tube, and it should be deducted at the spot stage".
//   • A card's pins come from the JOB CARD: an app-made card names the stud
//     (M4-SS / M5-SS) and the pin length at each end, so each element takes one
//     With-Head pin at the Big stud length and one Without-Head pin at the
//     Small stud length (TP-SS-M4-03-WH + TP-SS-M4-03-WO …), × elements × qty.
//     An uploaded job card names nothing the app can read: design picks the
//     pins in Change pins, and the slip is held until they are set. An older
//     list that still names a pin is used for such a card as before.
//   • The pins leave stock when Stage 4 (Spot) is ticked; unticking it gives
//     them back, ticking it again takes them again (owner). A card whose Spot
//     was ticked before this went live takes them at its last stage as before.

//   • ONLY for orders made after ORD-160-26 (owner: "this will only be for the
//     new jobs I make after ORD-160-26 and beyond, as till 160 the jobs have
//     already gone to the shopfloor"). Orders up to ORD-160 keep the list's
//     pins, Change pins and the last-stage take exactly as before.

const rework = require('./rework');

// The last order on the old rules: ORD-160-26 (orders.id 452). Mutable only so
// the test scripts can exercise both sides.
const PINS_RULE = { afterOrderId: 452 };
const newRule = (card) => Number(card?.order_id) > PINS_RULE.afterOrderId;
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
const pastPins = (card) => !!card?.pins_taken_at || !!card?.last_stage_taken_at || !!card?.dispatched_at || !!card?.inventory_qc_at
  || PASSED_QC.has(card?.status) || card?.status === 'qc_pending';

// A pin length as the stock codes write it: 3 → "03", 3.5 → "03.5", 10 → "10".
const pinLen = (n) => {
  const v = Number(n);
  const [i, f] = String(v).split('.');
  return `${i.padStart(2, '0')}${f ? `.${f}` : ''}`;
};

// The pins an app-made job card names (its own spec, or the card it came from):
// per element one With-Head pin at the Big stud length and one Without-Head pin
// at the Small stud length, on the card's stud — every list so far took exactly
// one of each per element. null when the card has no spec (uploaded) or the
// spec names no pin. missing: codes the card asks for that are not in stock's
// item list at all (design picks another pin then).
async function cardSpecPins(db, card) {
  const { specForCard } = require('./cardSpec');
  let g = await specForCard(db, card);
  try { g = typeof g === 'string' ? JSON.parse(g) : g; } catch { g = null; }
  const c = g?.computed;
  const stud = String(c?.studLabel || '').match(/M\d+/i)?.[0]?.toUpperCase();
  const big = Number(c?.terminalPinBig?.studs), small = Number(c?.terminalPinSmall?.studs);
  if (!c || !stud || !(big > 0) || !(small > 0)) return null;
  const elements = Math.max(1, parseInt(c.elements, 10) || 1);
  const pieces = (Number(card.qty) || 0) * elements;
  const wanted = [{ code: `TP-SS-${stud}-${pinLen(big)}-WH`, end: 'big' }, { code: `TP-SS-${stud}-${pinLen(small)}-WO`, end: 'small' }];
  const rows = [], missing = [];
  for (const w of wanted) {
    const inv = await db.get(
      `SELECT id, item_code FROM inventory_items WHERE UPPER(TRIM(item_code)) = UPPER($1) AND LOWER(TRIM(category)) = LOWER($2) LIMIT 1`,
      [w.code, TERMINAL_CATEGORY]);
    if (!inv) { missing.push(w.code); continue; }
    if (pieces > 0) rows.push({ inventory_item_id: inv.id, qty: pieces, item_code: inv.item_code });
  }
  return { rows, missing, label: `${stud} ${big}"${small !== big ? ` / ${small}"` : ''} × ${elements} element${elements === 1 ? '' : 's'}` };
}

// This card's share of a list line, in whole pieces.
function shareFor(lineQty, cardQty, itemQty) {
  const total = Number(lineQty) || 0;
  const share = Number(itemQty) > 0 ? (total * (Number(cardQty) || 0)) / Number(itemQty) : total;
  return Math.max(0, Math.round(share));
}

// REWORK-BIN PINS GO ON THE LAST JOB CARDS (owner, 9 Oct 2026): "use all rework
// in the last job card … keep new for the start job cards". The item's cards in
// the order they were made; a rework portion fills the last card first, then
// the one before it, until it is used up. The first cards take new stock.
async function itemCards(db, itemId, card = null) {
  const cards = itemId ? await db.all(
    `SELECT jc.*, o.order_type FROM job_cards jc JOIN orders o ON o.id = jc.order_id
      WHERE jc.order_item_id=$1 ORDER BY jc.id`, [itemId]) : [];
  const seq = cards.filter(c => !noTerminals(c));
  // A card tied to its item only by drawing number is not in the query: last.
  if (card?.id && !seq.some(c => c.id === card.id) && !noTerminals(card)) seq.push(card);
  return seq;
}

// This card's part of a rework portion, filled from the last card backwards.
function lastCardsShare(seq, cardId, lineQty, reworkQty, itemQty) {
  let left = Math.max(0, Math.round(Number(reworkQty) || 0));
  for (let i = seq.length - 1; i >= 0 && left > 0; i--) {
    const take = Math.min(shareFor(lineQty, seq[i].qty, itemQty), left);
    if (seq[i].id === cardId) return take;
    left -= take;
  }
  return 0;
}

// The item's 'Terminal Pin' lines, with the card's share of each.
async function listTerminalLines(db, itemId, card, itemQty) {
  if (!itemId) return [];
  const lines = await db.all(
    `SELECT oii.*, ii.item_code, ii.name, ii.name_gu, ii.unit, TRIM(ii.category) AS category
       FROM order_item_inventory oii JOIN inventory_items ii ON ii.id = oii.inventory_item_id
      WHERE oii.order_item_id=$1 AND LOWER(TRIM(ii.category)) = LOWER($2)
      ORDER BY ii.item_code`, [itemId, TERMINAL_CATEGORY]);
  // rework_share: the card's part of the line's rework portion — on the last
  // cards only (above) — what the slip prints as its REWORK row, what the
  // shortage check counts as covered and what its take draws from the bin.
  const seq = lines.some(l => Number(l.rework_qty) > 0) ? await itemCards(db, itemId, card) : [];
  return lines.map(l => ({ ...l, share: shareFor(l.qty, card?.qty, itemQty),
                           rework_share: Number(l.rework_qty) > 0 ? lastCardsShare(seq, card?.id, l.qty, l.rework_qty, itemQty) : 0 }));
}

// NEW STOCK FOR THE FIRST CARDS (owner, 9 Oct 2026): on a card whose pins the
// app picks (orders after ORD-160-26) the stock a card can count on is what is
// left after the cards made before it that have not taken their pins yet. A
// shortage therefore falls on the LAST cards — where the rework bin may cover
// it, once the owner or Design / QC approves ("if you are using from the bin
// you will take either mine or design approval"). Per pin: cover = the stock
// this card can count on; later = what the cards made after it are still short
// (not yet approved from the bin) — the bin goes to them first.
async function stockForCard(db, card, itemId, rows) {
  const cover = {}, later = {};
  const stock = {};
  for (const r of rows) { stock[r.inventory_item_id] = Number(r.current_stock) || 0; cover[r.inventory_item_id] = stock[r.inventory_item_id]; later[r.inventory_item_id] = 0; }
  if (!rows.length) return { cover, later };
  const seq = await itemCards(db, itemId, card);
  const used = { ...Object.fromEntries(Object.keys(stock).map(k => [k, 0])) };
  let passed = false;
  for (const s of seq) {
    if (s.id === card.id) {
      for (const k of Object.keys(stock)) cover[k] = Math.max(0, stock[k] - used[k]);
      // This card's own need comes out of what the later cards see.
      for (const r of rows) used[r.inventory_item_id] += Math.max(0, Number(r.qty) - (Number(r.rework_qty) || 0));
      passed = true;
      continue;
    }
    if (pastPins(s)) continue;                         // its pins have left stock already
    let need = await db.all(
      'SELECT inventory_item_id, qty::float AS qty, COALESCE(rework_qty,0)::float AS rework_qty FROM job_card_terminals WHERE job_card_id=$1', [s.id]);
    if (!need.length && newRule(s)) {
      const spec = await cardSpecPins(db, s);
      need = (spec?.rows || []).map(w => ({ inventory_item_id: w.inventory_item_id, qty: w.qty, rework_qty: 0 }));
    }
    for (const n of need) {
      const k = n.inventory_item_id;
      if (stock[k] === undefined) continue;
      const fromStock = Math.max(0, Number(n.qty) - Number(n.rework_qty));
      if (passed) later[k] += Math.max(0, fromStock - Math.max(0, stock[k] - used[k]));
      used[k] += fromStock;
    }
  }
  return { cover, later };
}

// The card's rows with what the editor and the slip need to know about each pin.
async function readTerminals(db, cardId) {
  return db.all(
    `SELECT t.id, t.job_card_id, t.inventory_item_id, t.qty::float AS qty, t.source, t.updated_by, t.updated_at,
            u.name AS updated_by_name,
            ii.item_code, ii.name, ii.name_gu, ii.unit, TRIM(ii.category) AS category,
            ii.current_stock::float AS current_stock,
            t.rework_qty::float AS rework_qty,
            COALESCE(b.qty,0)::float AS rework_bin,
            -- free for anyone: the bin less what open lists and cards hold
            GREATEST(COALESCE(b.qty,0) - COALESCE((
                SELECT SUM(GREATEST(oii.rework_qty - oii.rework_deducted, 0))
                  FROM order_item_inventory oii JOIN order_items oi ON oi.id = oii.order_item_id
                 WHERE oii.inventory_item_id = ii.id AND oi.inventory_deducted = FALSE), 0)
              - ${rework.CARD_HOLDS('ii.id')}, 0)::float AS rework_free,
            -- free for THIS card: the same, without this card's own hold
            GREATEST(COALESCE(b.qty,0) - COALESCE((
                SELECT SUM(GREATEST(oii.rework_qty - oii.rework_deducted, 0))
                  FROM order_item_inventory oii JOIN order_items oi ON oi.id = oii.order_item_id
                 WHERE oii.inventory_item_id = ii.id AND oi.inventory_deducted = FALSE), 0)
              - ${rework.CARD_HOLDS('ii.id', 'AND t.job_card_id <> $1')}, 0)::float AS card_rework_free
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
  if (noTerminals(card)) return { rows: [], lines: [], item, itemQty, from: null, missing: [] };
  const lines = await listTerminalLines(db, itemId, card, itemQty);
  let rows = await readTerminals(db, card.id);
  if (!seed || pastPins(card)) return { rows, lines, item, itemQty, from: null, missing: [] };
  // Where the pins come from (owner, 8 Oct 2026): the job card when the app
  // made it; else an older list that still names a pin; else nothing — an
  // uploaded job card — and design picks them.
  const spec = newRule(card) ? await cardSpecPins(db, card) : null;
  let from = null, want = [], missing = [];
  if (spec && (spec.rows.length || spec.missing.length)) {
    from = 'card'; want = spec.rows; missing = spec.missing;
  } else {
    want = lines.filter(l => l.share > 0 && !PLACEHOLDER.test(l.item_code || ''))
      .map(l => ({ inventory_item_id: l.inventory_item_id, qty: l.share, item_code: l.item_code }));
    from = want.length ? 'list' : null;
  }
  const key = (r) => `${r.inventory_item_id}:${Math.round(Number(r.qty))}`;
  // Rows made automatically (from the card or the list) follow their source
  // until Spot. A row design changed, or marked to come from the rework bin,
  // is design's choice for this card and is left exactly as design set it.
  const auto = rows.every(r => (r.source === 'list' || r.source === 'card') && !(Number(r.rework_qty) > 0));
  const differs = rows.length !== want.length || want.some(w => !rows.some(r => key(r) === key(w)));
  if (auto && differs && (rows.length || want.length)) {
    const before = rows.map(r => `${r.item_code} × ${r.qty}`).join(', ') || 'none';
    await db.run('DELETE FROM job_card_terminals WHERE job_card_id=$1', [card.id]);
    for (const w of want) {
      await db.run(
        `INSERT INTO job_card_terminals (job_card_id, inventory_item_id, qty, source) VALUES ($1,$2,$3,$4)
         ON CONFLICT (job_card_id, inventory_item_id) DO UPDATE SET qty = EXCLUDED.qty, source = EXCLUDED.source`,
        [card.id, w.inventory_item_id, w.qty, from]);
    }
    if (rows.length) {
      // The source changed under rows made from it: a new set of pins is a new question.
      await db.run(
        'UPDATE job_cards SET terminals_short_at = NULL, terminals_ok_by = NULL, terminals_ok_at = NULL, terminals_ok_note = NULL WHERE id=$1',
        [card.id]);
      await logActivity(card.order_id, card.id, 'terminals_changed',
        `Terminal pins for ${card.job_card_no} ${from === 'card' ? `now come from the job card (${spec.label})` : from === 'list' ? 'follow the corrected list' : 'are no longer named by the list — design must choose them'}: ${want.map(w => `${w.item_code} × ${w.qty}`).join(', ') || 'none'} (was: ${before})`, null);
    }
    rows = await readTerminals(db, card.id);
  } else if (auto && from && rows.some(r => r.source !== from)) {
    // Same pins, now known to come from the job card: just say so.
    await db.run(`UPDATE job_card_terminals SET source=$2 WHERE job_card_id=$1 AND source IN ('list','card')`, [card.id, from]);
    rows = await readTerminals(db, card.id);
  }
  return { rows, lines, item, itemQty, from, missing };
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
  const { rows, lines, item, itemQty, from, missing } = await ensureTerminals(db, card);
  // Pins not set (owner, 8 Oct 2026): an uploaded job card names none, so
  // design picks them; the slip is held until they are set. Same when the job
  // card asks for a pin stock has no item for and design has not picked one.
  const past = pastPins(card);
  const designSet = rows.some(r => r.source === 'design' || Number(r.rework_qty) > 0);
  const unset = newRule(card) && !past && !noTerminals(card) && rows.length === 0;
  const missingNow = past || designSet ? [] : (missing || []);
  // A pin whose list line takes part of it from the REWORK BIN needs only the
  // rest from stock: the last-stage take draws the bin first (takeTerminalRows
  // below). The check follows the same rule, so pins the bin covers never read
  // short (owner, 7 Oct 2026 — card set to take its pins from rework still
  // showed "stock 0 — short 18").
  // Marked in Change pins (owner, 8 Oct 2026): pieces free in the bin cover
  // the pin; pieces already held for other inventory do not — those still need
  // stock, so the pin reads short and the slip waits for an OK.
  const fromBin = (r) => {
    const l = lines.find(x => x.inventory_item_id === r.inventory_item_id);
    // The list's rework covers this card's part of it (the same figure the
    // slip prints) — on the item's last cards only (9 Oct 2026), never the
    // whole line's portion on every card.
    if (l && Number(l.rework_qty) > 0) {
      const left = Math.max(0, Number(l.rework_qty || 0) - Number(l.rework_deducted || 0));
      return Math.min(Number(r.qty) || 0, Number(l.rework_share) || 0, left, Number(r.rework_bin) || 0);
    }
    const marked = Number(r.rework_qty) || 0;
    return marked > 0 ? Math.min(Number(r.qty) || 0, marked, Number(r.card_rework_free) || 0) : 0;
  };
  // What stock this card can count on: on an app-picked card, what the cards
  // made before it leave (9 Oct 2026); otherwise today's stock as before.
  const pinsByApp = newRule(card) && !past && !noTerminals(card);
  const walk = pinsByApp ? await stockForCard(db, card, item?.id, rows) : null;
  const cover = walk ? walk.cover : null;
  const stockFor = (r) => cover ? cover[r.inventory_item_id] : Number(r.current_stock);
  // The bin may cover what stock cannot — on an app-picked card only, never on
  // a pin the list already takes from the bin, and only with an approval. The
  // cards made after this one get the bin first (last cards first).
  const binOffer = (r, shortBy) => {
    if (!pinsByApp || lines.some(l => l.inventory_item_id === r.inventory_item_id && Number(l.rework_qty) > 0)) return 0;
    const more = Math.floor((Number(r.card_rework_free) || 0) - fromBin(r) - (walk.later[r.inventory_item_id] || 0));
    return Math.max(0, Math.min(shortBy, more));
  };
  const short = past ? [] : rows
    .filter(r => stockFor(r) < Number(r.qty) - fromBin(r))
    .map(r => {
      const need = Number(r.qty) - fromBin(r);
      return { inventory_item_id: r.inventory_item_id, item_code: r.item_code, name: r.name, unit: r.unit || '',
               need, from_rework: fromBin(r), stock: Number(r.current_stock),
               // stock left for this card after the cards made before it (app-picked pins)
               stock_for_card: cover ? stockFor(r) : null,
               rework_marked: Number(r.rework_qty) || 0,
               // pieces the rework bin could add, with an approval
               bin_offer: binOffer(r, need - stockFor(r)) };
    });
  let ok = okState(card);
  let shortAt = card.terminals_short_at;

  if (short.length || unset || missingNow.length) {
    if (!ok && !shortAt) {
      await db.run('UPDATE job_cards SET terminals_short_at = NOW() WHERE id=$1 AND terminals_short_at IS NULL', [card.id]);
      shortAt = new Date();
      if (notify) await notifyShort(db, card, short, { unset, missing: missingNow });
    }
  } else if (shortAt || ok) {
    await db.run(
      'UPDATE job_cards SET terminals_short_at = NULL, terminals_ok_by = NULL, terminals_ok_at = NULL, terminals_ok_note = NULL WHERE id=$1',
      [card.id]);
    shortAt = null; ok = null;
  }
  return {
    rows: rows.map(r => ({ ...r, from_rework: pastPins(card) ? 0 : fromBin(r),
                           stock_for_card: cover ? stockFor(r) : null,
                           short: short.some(s => s.inventory_item_id === r.inventory_item_id) })),
    lines, item, itemQty, short, short_at: shortAt, ok,
    // An OK releases a shortage only — pins that are not set are never released by it.
    held: (short.length > 0 && !ok) || unset || missingNow.length > 0,
    unset, missing: missingNow, from,
    // Pins are NOT edited on the card (owner, 8 Oct 2026: "non editable here,
    // the change can only happen at Inventory QC"). Only where there is nothing
    // to read — an uploaded job card, or a pin the card names that stock has
    // no item for — does design choose them, before Spot.
    pickable: !past && (!newRule(card) || from === null || (missing || []).length > 0),
    last_stage_taken_at: card.last_stage_taken_at,
    pins_taken_at: card.pins_taken_at || null,
  };
}

// "Job card <no>: terminal pin <code> short — need <q>, stock <s>. Press OK to
// release the slip." — to every owner and every Design / QC login, on the
// dashboard and through the WhatsApp follow-through (routes/notifications.js).
async function notifyShort(db, card, short, { unset = false, missing = [] } = {}) {
  const { notifyRole } = require('../routes/notifications');
  const what = unset ? 'no terminal pins are set — it is an uploaded job card, so design chooses them in Change pins'
    : missing.length ? `the job card asks for ${missing.join(', ')}, which has no inventory item — design chooses the pin in Change pins`
    : short.map(s => `terminal pin ${s.item_code} short — need ${s.need}, ${s.stock_for_card !== null && s.stock_for_card !== undefined && s.stock_for_card !== s.stock
        ? `stock left after the earlier cards ${s.stock_for_card}` : `stock ${s.stock}`}${s.bin_offer > 0 ? `; the rework bin can give ${s.bin_offer}` : ''}`).join('; ');
  const binAsk = !unset && !missing.length && short.some(s => s.bin_offer > 0);
  const payload = {
    type: 'terminals_short',
    title: unset || missing.length ? `Terminal pins to choose — ${card.job_card_no}` : `Terminal pin short — ${card.job_card_no}`,
    body: `Job card ${card.job_card_no}: ${what}. ${unset || missing.length ? 'The slip is held until they are set.'
      : binAsk ? 'Approve the rework bin, or press OK to release the slip.' : 'Press OK to release the slip.'}`,
    link: `/job-cards/${card.id}`,
    ref: { type: 'terminals_short', id: card.id },
  };
  for (const role of ['owner', 'design']) {
    try { await notifyRole(db, role, payload); }
    catch (e) { console.error(`[terminals] could not notify ${role}:`, e.message); }
  }
  await logActivity(card.order_id, card.id, 'terminals_short', unset || missing.length
    ? `Terminal pins for ${card.job_card_no}: ${what} — slip held until they are set`
    : `Terminal pin short on ${card.job_card_no}: ${what} — slip held until the owner or Design / QC presses OK`, null);
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
  if (card.pins_taken_at && !card.last_stage_taken_at && !card.inventory_qc_at) {
    throw httpError(400, `${card.job_card_no}'s pins were taken at Spot (stage 4). Untick Spot to change them — they go back to stock — or correct them at Inventory QC.`);
  }
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
    // From the rework bin, for this card (owner, 8 Oct 2026): blank / 0 = none.
    const rwRaw = r?.rework_qty;
    const rw = rwRaw === undefined || rwRaw === null || String(rwRaw).trim() === '' ? 0 : Number(rwRaw);
    if (!Number.isInteger(rw) || rw < 0) throw httpError(400, 'Pieces from the rework bin must be a whole number.');
    if (rw > qty) throw httpError(400, `No more than the ${qty} pins on the row can come from the rework bin.`);
    const inv = await db.get('SELECT id, item_code, TRIM(category) AS category FROM inventory_items WHERE id=$1', [id]);
    if (!inv) throw httpError(400, `Inventory item #${id} not found.`);
    if (!isTerminalCategory(inv.category)) throw httpError(400, `${inv.item_code} is in category "${inv.category}" — only 'Terminal Pin' items go here (heavy pins, nuts and washers stay on the list).`);
    if (PLACEHOLDER.test(inv.item_code || '')) throw httpError(400, `${inv.item_code} is a TRAIN placeholder — pick the real pin.`);
    clean.push({ inventory_item_id: id, qty, item_code: inv.item_code, rework_qty: rw || null });
  }

  const before = await readTerminals(db, card.id);
  const { itemId, itemQty } = await itemFor(db, card);
  const lines = await listTerminalLines(db, itemId, card, itemQty);
  // A row that is exactly the list's share is still "from list"; anything
  // else is design's change for this card.
  const spec = newRule(card) ? await cardSpecPins(db, card) : null;
  const fromList = lines.some(l => l.share > 0 && !PLACEHOLDER.test(l.item_code || ''));
  if (newRule(card) && ((spec && spec.rows.length && !spec.missing.length) || (!spec && fromList))) {
    throw httpError(400, `${card.job_card_no}'s terminal pins come from the ${spec ? 'job card' : 'list'} and are not changed here — any change is made at Inventory QC, which moves the stock.`, 'PINS_FIXED');
  }
  // Exactly what the job card names is still "from job card"; exactly the
  // list's share is "from list"; anything else is design's change.
  const sourceOf = (r) => spec?.rows?.some(w => w.inventory_item_id === r.inventory_item_id && w.qty === r.qty) ? 'card'
    : lines.some(l => l.inventory_item_id === r.inventory_item_id && l.share === r.qty) ? 'list' : 'design';
  // Where the item's list already takes this pin from the rework bin, the list
  // decides — a second mark on the card would hold the same pieces twice.
  for (const r of clean) {
    const l = lines.find(x => x.inventory_item_id === r.inventory_item_id);
    if (r.rework_qty && l && Number(l.rework_qty) > 0) {
      throw httpError(400, `The item's list already takes ${r.item_code} from the rework bin — change it on the list, not here.`);
    }
  }

  await db.run('DELETE FROM job_card_terminals WHERE job_card_id=$1', [card.id]);
  for (const r of clean) {
    await db.run(
      `INSERT INTO job_card_terminals (job_card_id, inventory_item_id, qty, source, updated_by, updated_at, rework_qty)
       VALUES ($1,$2,$3,$4,$5,NOW(),$6)
       ON CONFLICT (job_card_id, inventory_item_id) DO UPDATE SET qty = EXCLUDED.qty, source = EXCLUDED.source, updated_by = EXCLUDED.updated_by,
         updated_at = NOW(), rework_qty = EXCLUDED.rework_qty`,
      [card.id, r.inventory_item_id, r.qty, sourceOf(r), user.id, r.rework_qty]);
  }
  await db.run(
    'UPDATE job_cards SET terminals_short_at = NULL, terminals_ok_by = NULL, terminals_ok_at = NULL, terminals_ok_note = NULL WHERE id=$1',
    [card.id]);
  const fmt = (list) => list.map(r => `${r.item_code} × ${r.qty}${Number(r.rework_qty) > 0 ? ` (${r.rework_qty} from rework bin)` : ''}`).join(', ') || 'none';
  await logActivity(card.order_id, card.id, 'terminals_changed',
    `Terminal pins for ${card.job_card_no} set by ${user.name}: ${fmt(clean)} (was: ${fmt(before)})`, user.id);
  return checkTerminals(db, card);
}

// The owner or Design / QC releasing a held slip. Only meaningful while the
// card is short and not yet OK'd — an OK recorded when nothing is short would
// silently release a later shortage.
async function okTerminals(db, jc, user, note) {
  const state = await checkTerminals(db, jc);
  if (state.unset || state.missing?.length) {
    throw httpError(400, 'The terminal pins for this job card are not set — design must choose them in Change pins; an OK cannot release that.', 'PINS_NOT_SET');
  }
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

// The owner or Design / QC approving the rework bin for a card whose app-picked
// pins stock cannot cover (owner, 9 Oct 2026). The pieces the bin can give are
// marked on the card's rows — held for it like a Change pins mark — and taken
// from the bin at Spot; whatever is still short waits for an OK as before.
async function useReworkBin(db, jc, user) {
  const state = await checkTerminals(db, jc, { notify: false });
  const offers = (state.short || []).filter(s => s.bin_offer > 0);
  if (!offers.length) {
    throw httpError(400, 'Nothing on this card can come from the rework bin — no pin is short, or the bin has none free for it.', 'NO_BIN_OFFER');
  }
  const card = await db.get('SELECT * FROM job_cards WHERE id=$1', [jc.id]);
  for (const s of offers) {
    await db.run(
      `UPDATE job_card_terminals SET rework_qty = COALESCE(rework_qty,0) + $3, updated_at = NOW()
        WHERE job_card_id=$1 AND inventory_item_id=$2`, [card.id, s.inventory_item_id, s.bin_offer]);
  }
  await logActivity(card.order_id, card.id, 'terminals_rework_approved',
    `Rework bin approved by ${user.name} for ${card.job_card_no}: ${offers.map(s => `${s.bin_offer} ${s.item_code}`).join(', ')} from the rework bin — the rest from new stock`, user.id);
  return checkTerminals(db, card);
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
async function takeTerminalRows(tx, card, item, tpLines, orderCode, userId, { at = 'last stage' } = {}) {
  // The take may run when the card already reads as QC pending (the stage-29
  // tick) — so the seed / follow-up is forced here, once, before taking.
  const { rows } = await ensureTerminals(tx, { ...card, status: 'in_progress', last_stage_taken_at: null, pins_taken_at: null });
  if (!rows.length) return null;
  const itemQty = Number(item.quantity) || 0;
  const taken = [];
  // What left, so unticking Spot can put back exactly this (owner, 8 Oct 2026).
  const record = { rows: [], waived: [] };
  const noteParts = [`Order: ${orderCode}`];
  if (item.drawing_number) noteParts.push(`Dwg: ${item.drawing_number}`);
  noteParts.push(`Terminal pins${at === 'Spot' ? ' at Spot' : ''} (JC ${card.job_card_no})`);
  const baseNote = noteParts.join(' | ');
  // This card's part of each line's rework portion: the last cards only (owner,
  // 9 Oct 2026) — a first card takes all its pins from new stock.
  const parts = await listTerminalLines(tx, item.id, card, itemQty);

  for (const row of rows) {
    const need = Math.round(Number(row.qty) || 0);
    if (!(need > 0)) continue;
    const line = tpLines.find(l => l.inventory_item_id === row.inventory_item_id) || null;
    let note = baseNote;
    let fromRework = 0;
    const rec = { inventory_item_id: row.inventory_item_id, item_code: row.item_code, from_stock: 0, from_rework: 0,
                  rework_line_id: null, rework_qty_was: null };
    const wantRework = line ? Math.max(0, Number(line.rework_qty || 0) - Number(line.rework_deducted || 0)) : 0;
    const mine = line ? Number(parts.find(p => p.id === line.id)?.rework_share) || 0 : 0;
    if (wantRework > 0 && mine > 0) {
      const available = await rework.binQty(tx, row.inventory_item_id);
      fromRework = Math.min(need, mine, wantRework, available);
      if (fromRework > 0) {
        await rework.move(tx, { itemId: row.inventory_item_id, kind: 'draw', qty: fromRework,
          ref: { order_id: card.order_id, order_item_id: item.id, job_card_id: card.id, order_code: orderCode,
                 job_card_no: card.job_card_no, drawing_number: item.drawing_number || null },
          notes: note, userId });
        await tx.run('UPDATE order_item_inventory SET rework_deducted = COALESCE(rework_deducted,0) + $1 WHERE id=$2',
          [fromRework, line.id]);
        rec.rework_line_id = line.id;
      }
      const shortBin = Math.min(need, mine, wantRework) - fromRework;
      if (shortBin > 0) {
        // Bin short: the rest comes from stock, and that much of the
        // reservation is released (the other last cards keep theirs).
        rec.rework_line_id = line.id; rec.rework_qty_was = Number(line.rework_qty) || 0;
        await tx.run('UPDATE order_item_inventory SET rework_qty = GREATEST(COALESCE(rework_deducted,0), COALESCE(rework_qty,0) - $2) WHERE id=$1',
          [line.id, shortBin]);
        note = `${note} | rework bin short by ${shortBin} — taken from stock`;
      }
    } else if (Number(row.rework_qty) > 0) {
      // Marked in Change pins for this card (owner, 8 Oct 2026): from the bin,
      // up to what it holds now; any shortfall comes from stock, noted. The
      // card's hold ends with this take (it now has its last-stage stamp).
      const marked = Math.min(need, Math.round(Number(row.rework_qty)));
      const available = await rework.binQty(tx, row.inventory_item_id);
      fromRework = Math.min(marked, available);
      if (fromRework > 0) {
        await rework.move(tx, { itemId: row.inventory_item_id, kind: 'draw', qty: fromRework,
          ref: { order_id: card.order_id, order_item_id: item.id, job_card_id: card.id, order_code: orderCode,
                 job_card_no: card.job_card_no, drawing_number: item.drawing_number || null },
          notes: `${note} | marked from rework bin in Change pins`, userId });
      }
      if (marked - fromRework > 0) note = `${note} | rework bin short by ${marked - fromRework} — taken from stock`;
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
    rec.from_stock = Math.max(0, fromStock); rec.from_rework = fromRework;
    record.rows.push(rec);
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
      record.waived.push({ line_id: line.id, qty: waive });
    }
  }
  return { taken, record };
}

// A transaction-bound db, the same shape as the pool's (lib/bomCorrection
// clientDb — not required from there, it requires this file).
const txDb = (client) => ({
  get: async (sql, params = []) => (await client.query(sql, params)).rows[0] || null,
  all: async (sql, params = []) => (await client.query(sql, params)).rows,
  run: (sql, params = []) => client.query(sql, params),
  insert: async (sql, params = []) => {
    const { rows } = await client.query(sql.trimEnd().replace(/;?\s*$/, '') + ' RETURNING id', params);
    return { lastInsertRowid: rows[0]?.id || null };
  },
});

// The card, its order line and the line's pin lines, locked, for Spot.
async function spotContext(tx, jobCardId) {
  const card = await tx.get(
    `SELECT jc.*, o.order_code, o.order_type FROM job_cards jc JOIN orders o ON o.id = jc.order_id WHERE jc.id=$1 FOR UPDATE OF jc`, [jobCardId]);
  if (!card) return {};
  const { resolveJobCardItemId } = require('./inventoryDeduction');
  const itemId = await resolveJobCardItemId(tx, card);
  const item = itemId ? await tx.get('SELECT id, drawing_number, quantity, inventory_deducted FROM order_items WHERE id=$1 FOR UPDATE', [itemId]) : null;
  const tpLines = item ? await tx.all(
    `SELECT oii.*, ii.item_code, ii.unit, TRIM(ii.category) AS category
       FROM order_item_inventory oii JOIN inventory_items ii ON ii.id = oii.inventory_item_id
      WHERE oii.order_item_id=$1 AND LOWER(TRIM(ii.category)) = LOWER($2)`, [item.id, TERMINAL_CATEGORY]) : [];
  return { card, item, tpLines, orderCode: card.order_code || `Order #${card.order_id}` };
}

// Stage 4 (Spot) ticked: the card's pins leave stock now (owner, 8 Oct 2026).
// Once per tick; nothing for a finished-goods card, a card past pins (its last
// stage taken, through QC, dispatched, under a repair), a settled order line
// (a replacement / repair card), or a card with no pins set — that one takes
// its pins at the last stage once design sets them, as a catch-up.
async function takePinsAtSpot(db, jobCardId, userId) {
  return db.withTransaction(async (client) => {
    const tx = txDb(client);
    const { card, item, tpLines, orderCode } = await spotContext(tx, jobCardId);
    if (!card || !newRule(card) || noTerminals(card) || pastPins(card) || !item || item.inventory_deducted) return null;
    const r = await takeTerminalRows(tx, card, item, tpLines, orderCode, userId, { at: 'Spot' });
    if (!r || !r.taken.length) return null;
    await tx.run('UPDATE job_cards SET pins_taken_at = NOW(), pins_taken = $2 WHERE id=$1', [card.id, JSON.stringify(r.record)]);
    await client.query(`INSERT INTO activity_log (order_id, job_card_id, activity_type, description, created_by) VALUES ($1,$2,'terminals_taken',$3,$4)`,
      [card.order_id, card.id, `Spot ticked: terminal pins taken from stock for ${card.job_card_no} — ${r.taken.map(t => `${t.item_code} × ${t.qty}`).join(', ')}`, userId || null]);
    return r;
  });
}

// Stage 4 (Spot) unticked: exactly what the tick took goes back — stock to
// stock, rework-bin pins to the bin, the list's settled share reopened — and the
// card's pins can be changed again; ticking Spot again takes them again.
async function givePinsBackAtSpot(db, jobCardId, userId) {
  return db.withTransaction(async (client) => {
    const tx = txDb(client);
    const { card, item, orderCode } = await spotContext(tx, jobCardId);
    if (!card || !card.pins_taken_at || card.last_stage_taken_at || card.inventory_qc_at) return null;
    let rec = card.pins_taken;
    try { rec = typeof rec === 'string' ? JSON.parse(rec) : rec; } catch { rec = null; }
    if (!rec?.rows) return null;
    // Pieces split off after Spot took their pins inside this take: giving the
    // whole take back would leave the split card without pins. Kept as taken.
    const kids = await tx.get('SELECT COUNT(*)::int AS n FROM job_cards WHERE parent_job_card_id=$1 AND pins_taken_at IS NOT NULL', [card.id]);
    if (kids.n) {
      await client.query(`INSERT INTO activity_log (order_id, job_card_id, activity_type, description, created_by) VALUES ($1,$2,'terminals_kept',$3,$4)`,
        [card.order_id, card.id, `Spot unticked on ${card.job_card_no}: pins NOT given back — pieces were split off after Spot and carry these pins; correct at Inventory QC if needed`, userId || null]);
      return null;
    }
    const note = `Order: ${orderCode}${item?.drawing_number ? ` | Dwg: ${item.drawing_number}` : ''} | Spot undone — terminal pins back (JC ${card.job_card_no})`;
    for (const r of rec.rows) {
      if (Number(r.from_stock) > 0) {
        const after = Number((await tx.get(
          'UPDATE inventory_items SET current_stock = current_stock + $1 WHERE id=$2 RETURNING current_stock', [r.from_stock, r.inventory_item_id])).current_stock);
        await recordMove(tx, { itemId: r.inventory_item_id, type: 'return_from_production', qty: r.from_stock, balanceAfter: after,
          notes: note, userId, orderItemId: item?.id || null, source: 'terminal', jobCardId: card.id });
      }
      if (Number(r.from_rework) > 0) {
        await rework.move(tx, { itemId: r.inventory_item_id, kind: 'return', qty: r.from_rework,
          ref: { order_id: card.order_id, order_item_id: item?.id || null, job_card_id: card.id, order_code: orderCode,
                 job_card_no: card.job_card_no, drawing_number: item?.drawing_number || null },
          notes: note, userId });
      }
      if (r.rework_line_id) {
        await tx.run(
          `UPDATE order_item_inventory SET rework_deducted = GREATEST(0, COALESCE(rework_deducted,0) - $1),
                  rework_qty = COALESCE($3, rework_qty) WHERE id=$2`,
          [Number(r.from_rework) || 0, r.rework_line_id, r.rework_qty_was]);
      }
    }
    for (const w of rec.waived || []) {
      await tx.run('UPDATE order_item_inventory SET qty_waived = GREATEST(0, COALESCE(qty_waived,0) - $1) WHERE id=$2', [w.qty, w.line_id]);
    }
    await tx.run('UPDATE job_cards SET pins_taken_at = NULL, pins_taken = NULL WHERE id=$1', [card.id]);
    await client.query(`INSERT INTO activity_log (order_id, job_card_id, activity_type, description, created_by) VALUES ($1,$2,'terminals_returned',$3,$4)`,
      [card.order_id, card.id, `Spot unticked: terminal pins given back to stock for ${card.job_card_no} — ${rec.rows.map(r => `${r.item_code} × ${Number(r.from_stock) + Number(r.from_rework)}`).join(', ')}`, userId || null]);
    return rec;
  });
}

// A partial-dispatch split leaves the parent with fewer pieces. Its rows were
// made for the pre-split quantity, so they are scaled to what remains (whole
// pieces) — otherwise the parent would take pins for pieces now on the child,
// which seeds its own rows when first read. Nothing to do once the parent has
// taken its last stage (the child inherits that flag and takes nothing).
async function rescaleAfterSplit(tx, parentId, oldQty, newQty, userId) {
  const card = await tx.get('SELECT id, job_card_no, order_id, last_stage_taken_at, pins_taken_at FROM job_cards WHERE id=$1', [parentId]);
  if (!card || card.last_stage_taken_at || card.pins_taken_at || !(Number(oldQty) > 0) || !(Number(newQty) > 0)) return;
  const rows = await tx.all(
    `SELECT t.id, t.qty::float AS qty, ii.item_code FROM job_card_terminals t JOIN inventory_items ii ON ii.id = t.inventory_item_id
      WHERE t.job_card_id=$1`, [parentId]);
  if (!rows.length) return;
  const changed = [];
  for (const r of rows) {
    const q = Math.max(0, Math.round((r.qty * Number(newQty)) / Number(oldQty)));
    if (q === r.qty) continue;
    if (q > 0) await tx.run(
      'UPDATE job_card_terminals SET qty=$1, rework_qty = CASE WHEN rework_qty > $1 THEN $1 ELSE rework_qty END, updated_at=NOW() WHERE id=$2', [q, r.id]);
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
  readTerminals, listTerminalLines, ensureTerminals, checkTerminals, saveTerminals, okTerminals, useReworkBin,
  itemCards, lastCardsShare, stockForCard, takeTerminalRows, rescaleAfterSplit, okState, pastPins, cardSpecPins, takePinsAtSpot, givePinsBackAtSpot, PINS_RULE, newRule,
};
