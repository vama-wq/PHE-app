// ── Assembling a job card draft from an order item ─────────────────────────
//
// Everything the card prints comes from one of three places:
//   1. the order and its item — client, dates, drawing, wattage, material, …
//   2. four answers the planner gives when they press Make Job Card
//   3. arithmetic, from jobCardEngine
//
// This module does (1) and hands (3) to the engine. It creates nothing: the
// result is a draft for the owner to look at, and only their approval turns it
// into real job cards through the normal creation path.

const E = require('./jobCardEngine');
const { splitQuantity, describeSplit, SPLIT_MARKER } = require('./jobCardSplit');

// The plating dropdown is a closed set of five, and the card prints all three
// languages. Taken from the real cards where they exist.
const PLATING_TRILINGUAL = {
  'Nickel Plating': 'Nickle Plating / નિકલ પ્લેટિંગ / निकल प्लेटिंग',
  'Electropolish': 'Electropolish / ઇલેક્ટ્રોપોલિશ / इलेक्ट्रोपॉलिश',
  'Teflon Coating': 'Teflon Coating / ટેફલોન કોટિંગ / टेफ्लॉन कोटिंग',
  'Buffing': 'Buffing / બફિંગ / बफिंग',
  'No Plating': 'No Plating / પ્લેટિંગ નથી / कोई प्लेटिंग नहीं',
};

// Punching fills itself in as BHA-{wattage}W-{voltage}V, which is exactly what
// 94% of the 209 existing cards carry. Like the cold zone and the terminal pin,
// it is derived unless the planner overrides it — and the overrides are real
// (an ITY- prefix, "No Punching", an -INC suffix, and a handful whose punch
// voltage differs from the item's), so an override is always noted on the draft
// rather than passing silently.
function derivePunching(wattage, voltage) {
  if (!(Number(wattage) > 0) || !(Number(voltage) > 0)) return '';
  return `BHA-${Number(wattage)}W-${Number(voltage)}V`;
}

// The four things only the planner knows. Kept here so the form, the route and
// the review screen all describe them the same way.
const QUESTIONS = [
  { key: 'asmbly', label: 'ASMBLY', type: 'select', options: ['1', '2', '3'], required: true },
  { key: 'fixture', label: 'Fixture type', type: 'text', required: true },
  { key: 'dispatch_date', label: 'Dispatch date', type: 'date', required: true },
  { key: 'drawing_total_length_in', label: 'Total length on the drawing (inches)', type: 'number', required: true,
    help: 'Straight off the drawing — the card adds the 0.7" allowance itself.' },
];

// Everything the planner MAY override on the review screen, as against the four
// questions they must answer up front. All derived until they say otherwise.
const OVERRIDES = [
  { key: 'punching', label: 'Punching', type: 'text', from: 'wattage and voltage' },
  { key: 'cold_zone_big_in', label: 'Cold zone big (in)', type: 'number', from: 'policy Step 6, by total length' },
  { key: 'cold_zone_small_in', label: 'Cold zone small (in)', type: 'number', from: 'policy Step 6, by total length' },
  { key: 'wire_draw_pct_override', label: 'Wire draw (fraction, e.g. 0.31)', type: 'number', from: 'policy Step 7, by gauge' },
  { key: 'spool_row', label: 'Spool', type: 'select', from: 'the shortest coil of the chosen gauge' },
  { key: 'elements_per_assembly', label: 'Elements in the assembly', type: 'number', from: 'the drawing name' },
];

// The questions with their derived starting values filled in for one item, so
// the form opens populated rather than empty.
async function draftQuestions(db, orderItemId) {
  const item = await db.get('SELECT wattage, voltage FROM order_items WHERE id=$1', [orderItemId]);
  return {
    questions: QUESTIONS,
    overrides: OVERRIDES.map(o => o.key === 'punching' && item
      ? { ...o, derived: derivePunching(item.wattage, item.voltage) }
      : o),
  };
}

function missingAnswers(answers = {}) {
  return QUESTIONS.filter(q => q.required && (answers[q.key] == null || String(answers[q.key]).trim() === ''))
    .map(q => q.label);
}

async function buildDraft(db, orderItemId, answers = {}) {
  const item = await db.get('SELECT * FROM order_items WHERE id=$1', [orderItemId]);
  if (!item) return { ok: false, error: 'Order item not found.' };

  // order_date is a DATE column. Read as a JS Date it comes back at IST
  // midnight — 2026-09-07 arrives as 2026-09-06T18:30:00Z, and toISOString
  // then prints the wrong day on the card. Take the text.
  const order = await db.get('SELECT *, order_date::text AS order_date_text FROM orders WHERE id=$1', [item.order_id]);
  if (!order) return { ok: false, error: 'Order not found.' };

  const missing = missingAnswers(answers);
  if (missing.length) return { ok: false, error: `Still needed: ${missing.join(', ')}.`, questions: QUESTIONS };

  const customer = order.customer_id
    ? await db.get('SELECT customer_code, name FROM customers WHERE id=$1', [order.customer_id])
    : null;

  const card = E.buildJobCard({
    tubeMaterial: item.tube_material,
    tubeDiameterMm: item.tube_diameter,
    wattage: item.wattage,
    voltage: item.voltage,
    drawingNumber: item.drawing_number,
    productCode: item.product_code,
    drawingTotalLengthIn: answers.drawing_total_length_in,
    // Optional overrides the review screen can send back.
    coldZoneBigIn: answers.cold_zone_big_in,
    coldZoneSmallIn: answers.cold_zone_small_in,
    wireDrawPctOverride: answers.wire_draw_pct_override,
    elementsPerAssembly: answers.elements_per_assembly,
  });
  if (!card.ok) return { ok: false, error: card.error };

  // Which spool prints. The engine offers every spool of the chosen gauge that
  // fits; the planner picks the one actually going on the machine, and the
  // shortest coil is only the default.
  let chosenSpool = card.wire;
  if (answers.spool_row != null && card.spoolOptions.length) {
    const picked = card.spoolOptions.find(s => String(s.row) === String(answers.spool_row));
    if (picked) chosenSpool = picked;
  }

  // Head-level overrides are noted the same way the engine notes its own, so
  // the review screen shows everything a person changed in one list.
  const notes = [];
  const derivedPunching = derivePunching(item.wattage, item.voltage);
  const punching = (answers.punching != null && String(answers.punching).trim())
    ? String(answers.punching).trim() : derivedPunching;
  if (punching !== derivedPunching) {
    notes.push(`Punching set by hand to "${punching}"${derivedPunching ? ` — the wattage and voltage give "${derivedPunching}"` : ''}.`);
  }

  const parts = splitQuantity(item.quantity);
  const base = String(item.drawing_number || item.product_code || `ITEM-${item.id}`).toUpperCase();

  return {
    ok: true,
    orderItemId: item.id,
    notes,
    card: { ...card, wire: chosenSpool },
    split: {
      cards: parts.length,
      quantities: parts,
      describe: describeSplit(parts),
      // Provisional: the real numbers are allocated at creation, gap-safely,
      // so a name shown here can differ if another card lands in between.
      names: parts.length > 1 ? parts.map((_, i) => `${base}-${SPLIT_MARKER}${i + 1}`) : [base],
    },
    head: {
      company: 'Peena Heat Elements',
      title: `${item.drawing_number || item.product_code || `Item ${item.id}`} Job Card`,
      cardNo: parts.length > 1 ? `${base}-${SPLIT_MARKER}1` : base,
      asmbly: String(answers.asmbly),
      clientCode: customer?.customer_code || '',
      clientName: customer?.name || '',
      orderCode: order.order_code,
      orderDate: fmtDate(order.order_date_text),
      productCode: item.product_code || '',
      drawingNumber: item.drawing_number || '',
      punching,
      qty: `${item.quantity} Nos`,
      dispatchDate: fmtDate(answers.dispatch_date),
      fixture: String(answers.fixture || ''),
      tubeMaterialLabel: item.tube_material || '',
      remark: String(item.remark || '').trim() ? [String(item.remark).trim()] : [],
      plating: PLATING_TRILINGUAL[String(item.plating_instructions || '').trim()]
        || item.plating_instructions || '',
    },
  };
}

// The card prints dd.mm.yy, as every existing one does. Callers must pass the
// ::text form of a DATE column, never the Date object — see the query above.
function fmtDate(v) {
  if (!v) return '';
  const s = typeof v === 'string' ? v : v.toISOString();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}.${m[2]}.${m[1].slice(2)}`;
  const d = String(v).match(/^(\d{2})[./-](\d{2})[./-](\d{2,4})$/);
  return d ? `${d[1]}.${d[2]}.${d[3].slice(-2)}` : String(v);
}

module.exports = { buildDraft, draftQuestions, derivePunching, missingAnswers, QUESTIONS, OVERRIDES, PLATING_TRILINGUAL };
