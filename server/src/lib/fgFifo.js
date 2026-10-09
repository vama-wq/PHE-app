// ── Finished goods: first in, first out (owner, 9 Oct 2026) ──────────────────
// "No, I don't [want] selecting anymore — just take out as FIFO, and whichever
// cards are used, the same cards' lengths are taken out for fins from their
// source." A finished-goods job card is no longer pointed at a store row by
// hand: the row is the one for the item's drawing, and its pieces come out of
// the OLDEST intake first. The card keeps which intakes they were
// (job_cards.fg_batches), so its fins go by the tube length of the job card
// each intake came from. A hand entry has no job card: "whenever there is hand
// entry take the average of the tube length whose job cards you have".
//
// Fins are never taken by a kg typed on a finished-goods list any more.

// The store row for an order item: its drawing exactly (a trailing -N card
// number dropped), else the longest store drawing the item's name starts with
// ("PT-UType-10U-500W-Finns" → PT-UType-10U-500W).
async function storeRowFor(db, item) {
  const name = String(item?.drawing_number || '').trim();
  const base = name.replace(/-\d+$/, '');
  if (!base) return null;
  return (await db.get(
    `SELECT * FROM finished_goods WHERE LOWER(TRIM(base_drawing_no)) = LOWER($1)
      ORDER BY (qty_available > 0) DESC, id DESC LIMIT 1`, [base]))
    || db.get(
    `SELECT * FROM finished_goods
      WHERE LENGTH(TRIM(COALESCE(base_drawing_no,''))) > 0
        AND LEFT(LOWER($1), LENGTH(TRIM(base_drawing_no)) + 1) IN (LOWER(TRIM(base_drawing_no)) || '-', LOWER(TRIM(base_drawing_no)) || ' ')
      ORDER BY LENGTH(TRIM(base_drawing_no)) DESC, (qty_available > 0) DESC, id DESC LIMIT 1`, [name]);
}

// The row's intakes still in the store, oldest first: every inward entry, less
// everything that has gone out, first in first out.
async function batchesLeft(db, fgId) {
  const logs = await db.all(
    `SELECT id, movement_type, qty, job_card_no, order_code, created_at FROM finished_goods_log
      WHERE finished_good_id=$1 ORDER BY created_at, id`, [fgId]);
  const batches = logs.filter(l => l.movement_type === 'inward')
    .map(l => ({ log_id: l.id, job_card_no: l.job_card_no || null, order_code: l.order_code || null,
                 at: l.created_at, qty: Number(l.qty) || 0, left: Number(l.qty) || 0 }));
  let out = logs.filter(l => l.movement_type !== 'inward').reduce((a, l) => a + (Number(l.qty) || 0), 0);
  for (const b of batches) { const t = Math.min(b.left, out); b.left -= t; out -= t; }
  return batches.filter(b => b.left > 0);
}

// Take qty pieces from the oldest batches (the array is used up as it goes, so
// several cards made together each get the next pieces).
function allocate(batches, qty) {
  const parts = [];
  let need = Number(qty) || 0;
  for (const b of batches) {
    if (!(need > 0)) break;
    const t = Math.min(b.left, need);
    if (!(t > 0)) continue;
    parts.push({ log_id: b.log_id, job_card_no: b.job_card_no, order_code: b.order_code, qty: t });
    b.left -= t; need -= t;
  }
  return { parts, short: need };
}

// Tube length per heater (mm, every element) of each job card that put heaters
// into the row, and their average — for a hand entry.
async function intakeLengths(db, fgId) {
  const { cardFinsLength } = require('./inventoryDeduction');
  const nos = (await db.all(
    `SELECT DISTINCT job_card_no FROM finished_goods_log
      WHERE finished_good_id=$1 AND movement_type='inward' AND job_card_no IS NOT NULL`, [fgId])).map(r => r.job_card_no);
  const fg = await db.get('SELECT job_card_id FROM finished_goods WHERE id=$1', [fgId]);
  const byCard = new Map();
  const cards = [];
  for (const no of nos) {
    const c = await db.get('SELECT * FROM job_cards WHERE job_card_no=$1 AND NOT COALESCE(is_fg,FALSE) ORDER BY id DESC LIMIT 1', [no]);
    if (c) cards.push(c);
  }
  if (fg?.job_card_id && !cards.some(c => c.id === fg.job_card_id)) {
    const c = await db.get('SELECT * FROM job_cards WHERE id=$1 AND NOT COALESCE(is_fg,FALSE)', [fg.job_card_id]);
    if (c) cards.push(c);
  }
  for (const c of cards) {
    const len = await cardFinsLength(db, c);
    if (!(len.lengthMm > 0) || len.lengthMm > 20000) continue;
    byCard.set(c.job_card_no, Math.round((len.fromCard ? len.lengthMm * (len.elements || 1) : len.lengthMm) * 100) / 100);
  }
  const vals = [...byCard.values()];
  const avg = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null;
  return { byCard, avg };
}

// A finished-goods card's fins plan: [{ qty, mm, from }] — the pieces of each
// intake it took, with that intake's job card length (or the row's average for
// a hand entry). mm null = no length anywhere for the row.
async function finsParts(db, card) {
  if (!card?.fg_source_id) return [];
  const { byCard, avg } = await intakeLengths(db, card.fg_source_id);
  const avgFrom = avg ? `average of ${byCard.size} job card${byCard.size === 1 ? '' : 's'}` : null;
  let batches = card.fg_batches;
  try { batches = typeof batches === 'string' ? JSON.parse(batches) : batches; } catch { batches = null; }
  const qty = Number(card.qty) || 0;
  if (!Array.isArray(batches) || !batches.length) {
    // Made before FIFO (or split off one): the row's latest intake with a
    // length, as before; else the average.
    const { fgSourceLength } = require('./inventoryDeduction');
    const len = await fgSourceLength(db, card);
    if (len) return [{ qty, mm: Math.round((len.fromCard ? len.lengthMm * (len.elements || 1) : len.lengthMm) * 100) / 100, from: len.card_no }];
    return [{ qty, mm: avg, from: avgFrom }];
  }
  // Never more pieces than the card has now (a split takes some away).
  const out = [];
  let left = qty;
  for (const b of batches) {
    if (!(left > 0)) break;
    const q = Math.min(Number(b.qty) || 0, left);
    left -= q;
    const own = b.job_card_no ? byCard.get(b.job_card_no) : null;
    out.push({ qty: q, mm: own || avg || null, from: own ? b.job_card_no : avgFrom, hand: !b.job_card_no });
  }
  return out;
}

module.exports = { storeRowFor, batchesLeft, allocate, intakeLengths, finsParts };
