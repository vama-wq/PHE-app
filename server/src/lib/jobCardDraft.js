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
const { toGujarati, toHindi, isTranslated } = require('./translit');
const round = (n, dp) => Math.round(Number(n) * 10 ** dp) / 10 ** dp;
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
  { key: 'terminal_pin_big_in', label: 'Terminal pin big (in)', type: 'number', from: 'the big cold zone' },
  { key: 'terminal_pin_small_in', label: 'Terminal pin small (in)', type: 'number', from: 'the small cold zone' },
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

  // The card has to name the tube production takes off the rack, not just its
  // code: order_items.tube_material holds the inventory ITEM CODE, so the row
  // read "TUB-SS304-038-T06" where the real card reads "SS304 3/8\" Tube".
  // Both go on, the name to read and the code to pick by.
  const tube = item.tube_material
    ? await db.get('SELECT item_code, name, name_gu FROM inventory_items WHERE upper(item_code)=upper($1) LIMIT 1',
        [String(item.tube_material).trim()])
    : null;
  const tubeLabel = tube ? tube.name : (item.tube_material || '');
  const tubeLabelGu = tube ? [tube.name_gu, tube.item_code].filter(Boolean).join(' · ') : '';

  // The tube ITEM should agree with the diameter field. They are set at
  // different times by different people, and a mismatch is the one mistake
  // that produces a plausible wrong card: the wrong draw bands, the wrong wire
  // sheet, the wrong mandrel, all internally consistent and all wrong. Cheap
  // to check, because the tube's own name says which bore it is.
  const tubeSaysDia = tube
    ? (/\b1\/2\b|11\s*mm/i.test(tube.name || '') ? 11
      : /\b3\/8\b|\b8\s*mm/i.test(tube.name || '') ? 8 : null)
    : null;

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
    terminalPinBigIn: answers.terminal_pin_big_in,
    terminalPinSmallIn: answers.terminal_pin_small_in,
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
  if (tubeSaysDia && Number(item.tube_diameter) && tubeSaysDia !== Number(item.tube_diameter)) {
    notes.push(`The item is set to ${item.tube_diameter} mm but its tube is ${tube.item_code} — "${tube.name}", which is ${tubeSaysDia} mm. One of the two is wrong, and the whole card follows the diameter.`);
  }
  const derivedPunching = derivePunching(item.wattage, item.voltage);
  const punching = (answers.punching != null && String(answers.punching).trim())
    ? String(answers.punching).trim() : derivedPunching;
  if (punching !== derivedPunching) {
    notes.push(`Punching set by hand to "${punching}"${derivedPunching ? ` — the wattage and voltage give "${derivedPunching}"` : ''}.`);
  }

  const parts = splitQuantity(item.quantity);
  const base = String(item.drawing_number || item.product_code || `ITEM-${item.id}`).toUpperCase();
  const names = parts.length > 1
    ? parts.map((_, i) => `${base}-${SPLIT_MARKER}${i + 1}`)
    : [base];

  // The QTY line is the card's OWN quantity — it used to print the item's, so
  // a sheet headed PT-X-S1 told the floor to build 100 on a card the system
  // runs at 50. The parenthetical says where this batch sits in the run, so
  // nobody reads 50 against a 100-piece order as a short delivery.
  const qtyLine = (i) => parts.length > 1
    ? `${parts[i]} Nos (${i + 1} of ${parts.length} · item ${item.quantity})`
    : `${item.quantity} Nos`;

  // "Where each figure came from", printed on the page below the sheet (screen
  // only). Derived rather than written by hand, so it always describes what the
  // engine actually did on THIS card.
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const dia = card.tubeDiameterMm;
  const std = E.standardColdZone(card.totalLengthIn, dia);
  const pinDiv = (E.PIN_DIVISOR[dia] || E.PIN_DIVISOR[8])[card.material] || 1.215;
  const provenance = [
    ['From the order', 'Order no, client code, order date, product code, drawing no, punching, quantity, tube material, plating, remark'],
    ['Asked when making the card', 'ASMBLY, fixture type, dispatch date, total length off the drawing'],
    ['Total length', `${answers.drawing_total_length_in}" on the drawing + ${E.TOTAL_LENGTH_ALLOWANCE_IN}" allowance = ${card.totalLengthIn}"`],
    ['Tube draw', `${pct(card.tubeDrawPct)} — ${dia} mm ${card.material === 'copper' ? 'copper' : 'SS / Incoloy'} at ${card.totalLengthIn}"`],
    ['Wire gauge', card.gauge == null
      ? 'no wire on the sheet reaches the required coil length — choose by hand'
      : `${card.gauge} SWG at ${pct(card.wireDrawPct)} wire draw, ${card.gaugeResolution === 'unique' ? 'the only self-consistent answer' : 'the coarsest of several'}; ${card.spoolOptions.length} spool(s) of it fit the spring window`],
    ['Cold zone', card.coldZoneBigIn === std.coldZoneIn
      ? `${card.coldZoneBigIn}" — the ${dia} mm standard for a ${card.totalLengthIn}" element`
      : `${card.coldZoneBigIn}" set by hand; the ${dia} mm standard here is ${std.coldZoneIn}"`],
    ['Terminal pin', card.terminalPinBig.overridden
      ? `${card.terminalPinBig.studs}" set by hand — a ${card.coldZoneBigIn}" cold zone gives ${card.terminalPinBig.derivedStuds}"`
      : `ceil(${card.coldZoneBigIn} ÷ ${pinDiv} + 1) = ${card.terminalPinBig.studs}" on a ${card.studLabel} stud`],
    ['Ohms after draw', `${card.voltage}² ÷ ${round(card.wattage, 2)} = ${card.ohmsAfterDraw} Ω, ±5%`],
    ['Quantity', parts.length > 1
      ? `${item.quantity} pcs over ${parts.length} cards (${describeSplit(parts)}) — no card runs more than 50`
      : `${item.quantity} pcs on one card`],
  ];

  return {
    ok: true,
    orderItemId: item.id,
    notes,
    provenance,
    card: { ...card, wire: chosenSpool },
    split: {
      cards: parts.length,
      quantities: parts,
      describe: describeSplit(parts),
      // Provisional: the real numbers are allocated at creation, gap-safely,
      // so a name shown here can differ if another card lands in between.
      names,
    },
    // One head per sheet. Every card of a batch shares the same arithmetic —
    // same length, same gauge, same ohms — and differs only in its number and
    // its quantity, so the engine runs once and the heads vary.
    sheets: names.map((no, i) => ({ ...headFor(no, qtyLine(i)), sheetIndex: i + 1, sheetCount: names.length })),
    head: headFor(names[0], qtyLine(0)),
  };

  function headFor(cardNo, qty) {
    return {
      company: 'Peena Heat Elements',
      title: `${item.drawing_number || item.product_code || `Item ${item.id}`} Job Card`,
      cardNo,
      asmbly: String(answers.asmbly),
      clientCode: customer?.customer_code || '',
      clientName: customer?.name || '',
      orderCode: order.order_code,
      orderDate: fmtDate(order.order_date_text),
      productCode: item.product_code || '',
      drawingNumber: item.drawing_number || '',
      punching,
      qty,
      dispatchDate: fmtDate(answers.dispatch_date),
      // The fixture is free text the planner types, and the floor reads the
      // card in three languages — so it is translated word by word from the
      // shop dictionary. Anything the dictionary does not know stays English,
      // which beats a garbled letter-mapping on a working document.
      fixture: String(answers.fixture || ''),
      fixtureAlt: [toGujarati(answers.fixture), toHindi(answers.fixture)]
        .filter(v => isTranslated(answers.fixture, v)).join('  ·  '),
      tubeMaterialLabel: tubeLabel,
      tubeMaterialLabelGu: tubeLabelGu,
      // Same treatment as the fixture: the remark is an instruction the floor
      // acts on, so it carries its Gujarati and Hindi. Customer-specific text
      // the dictionary does not know stays English rather than being mangled.
      // Gujarati and Hindi share ONE line, separated by a dot. Stacked they
      // cost the sheet a line per instruction and pushed it onto a second page.
      remark: (() => {
        const en = String(item.remark || '').trim();
        if (!en) return [];
        const both = [toGujarati(en), toHindi(en)].filter(v => isTranslated(en, v));
        return [en, ...(both.length ? [both.join('  ·  ')] : [])];
      })(),
      plating: PLATING_TRILINGUAL[String(item.plating_instructions || '').trim()]
        || item.plating_instructions || '',
    };
  }
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
