// Actual tube draw and wire draw, card by card, from the production checklist
// against the job card's own figures (owner, 24 Nov 2026: "i need this analysis
// in my month report as well for ohms and tube lenghths for all types of tube
// materials and dia"). Read only; used by lib/monthlyReport.js.
//
// TUBE — cards whose Draw stage (8) was done in the month:
//   actual tube draw % = length after draw (St 8 "Total Length") ÷ the card's
//   cutting length − 1 (also ÷ the floor's own cut, St 5), against the card's
//   tube draw %. Lengths are entered in mm; a figure that only fits the card in
//   inches is read as inches, and one that fits neither is left out and marked.
// OHMS — cards whose last HV + Light check (27) was done in the month:
//   actual wire draw % = coil ohms at St 3 ÷ final ohms at St 27 − 1 — the
//   engine's own definition (wound ÷ finished − 1) — against the card's wire
//   draw %; plus St 3 against the card's St 3 range, the ohms just before (St 7)
//   and just after (St 9) the tube draw, and the final ohms against the design.
// Only app-made cards carry the figures (generated_spec.computed); uploaded
// cards are counted, not analysed.
const E = require('./jobCardEngine');

const round = (x, n = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** n) / 10 ** n);
const nums = (s) => (String(s ?? '').match(/\d+(?:\.\d+)?/g) || []).map(Number);
const avgOf = (s) => { const n = nums(s); return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null; };
// HV + Light stages keep a JSON value: {"hv":"pass",…,"ohms":"122.7"}.
const hvOhms = (v1) => { try { return avgOf(JSON.parse(v1)?.ohms); } catch { return null; } };
// A timestamp as its Indian date (YYYY-MM-DD).
const istDay = (d) => (d ? new Date(new Date(d).getTime() + 330 * 60e3).toISOString().slice(0, 10) : '');
const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

const GRADE_LABEL = { copper: 'Copper', ss304: 'SS304', ss316: 'SS316', ss316_sml: 'SS316 seamless', ss310: 'SS310',
  incoloy: 'Incoloy', incoloy_t06: 'Incoloy 0.6 mm' };
function tubeLabel(tubeMaterial) {
  const grade = E.tubeGrade(tubeMaterial);
  if (grade && GRADE_LABEL[grade]) return GRADE_LABEL[grade];
  return E.materialClass(tubeMaterial) === 'copper' ? 'Copper' : 'Steel (other)';
}
// The bands the draw rules use: a 16"–30" drawing (8 mm SS304), to 51" (11 mm), above.
const lengthBand = (drawingIn) => drawingIn == null ? '—' : drawingIn <= 30 ? 'up to 30"' : drawingIn <= 51 ? '30"–51"' : 'over 51"';

// A length off the checklist, in mm: mm if it is near the card's mm figure, inches if
// it is only near the card's inch figure; null when it fits neither.
function lengthMm(raw, wantMm) {
  const v = avgOf(raw);
  if (v == null || !wantMm) return { mm: null, unit: raw ? '?' : '' };
  if (Math.abs(v - wantMm) / wantMm <= 0.15) return { mm: v, unit: 'mm' };
  const inch = v * 25.4;
  if (Math.abs(inch - wantMm) / wantMm <= 0.15) return { mm: inch, unit: 'in' };
  return { mm: null, unit: '?' };
}

async function cardsDone(db, stage, startISO, endISO) {
  return db.all(`
    SELECT jc.id, jc.job_card_no, jc.qty, jc.generated_spec, o.order_code, c.customer_code,
           oi.tube_material, oi.tube_diameter, s.done_at
      FROM job_cards jc
      JOIN production_checklist s ON s.job_card_id = jc.id AND s.stage_no = $1 AND s.done = 1
      JOIN orders o ON o.id = jc.order_id
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN order_items oi ON oi.id = jc.order_item_id
     WHERE COALESCE(jc.is_fg, FALSE) = FALSE
       AND s.done_at::timestamptz >= $2::timestamptz AND s.done_at::timestamptz < $3::timestamptz
     ORDER BY s.done_at, jc.id`, [stage, startISO, endISO]);
}

function summarize(rows, keyOf, actualKey, cardKey, extra = () => ({})) {
  const groups = new Map();
  for (const r of rows) {
    if (r[actualKey] == null) continue;
    const k = keyOf(r);
    if (!groups.has(k.key)) groups.set(k.key, { ...k, rows: [] });
    groups.get(k.key).rows.push(r);
  }
  return [...groups.values()].map(g => {
    const a = g.rows.map(r => r[actualKey]), cards = g.rows.map(r => r[cardKey]).filter(x => x != null);
    const pcs = g.rows.reduce((t, r) => t + (Number(r.qty) || 0), 0);
    const w = pcs ? g.rows.reduce((t, r) => t + r[actualKey] * (Number(r.qty) || 0), 0) / pcs : null;
    return {
      ...Object.fromEntries(Object.entries(g).filter(([k]) => k !== 'rows' && k !== 'key')),
      cards: g.rows.length, pieces: pcs,
      cardPct: cards.length ? (Math.min(...cards) === Math.max(...cards) ? `${round(cards[0], 1)}%` : `${round(Math.min(...cards), 1)}–${round(Math.max(...cards), 1)}%`) : '',
      actAvg: round(a.reduce((t, x) => t + x, 0) / a.length), actMin: round(Math.min(...a)), actMax: round(Math.max(...a)), actWeighted: round(w),
      diffAvg: round(g.rows.reduce((t, r) => t + (r[actualKey] - (r[cardKey] ?? r[actualKey])), 0) / g.rows.length),
      ...extra(g.rows),
    };
  }).sort((x, y) => String(x.tube).localeCompare(String(y.tube)) || (x.dia || 0) - (y.dia || 0) || String(x.sub || '').localeCompare(String(y.sub || '')));
}

async function drawAnalysis(db, startISO, endISO) {
  // ── Tube draw ──
  const tubeCards = await cardsDone(db, 8, startISO, endISO);
  const ids = [...new Set(tubeCards.map(c => c.id))];
  const ohmCards = await cardsDone(db, 27, startISO, endISO);
  const allIds = [...new Set([...ids, ...ohmCards.map(c => c.id)])];
  const cl = allIds.length ? await db.all(
    'SELECT job_card_id, stage_no, value1 FROM production_checklist WHERE job_card_id = ANY($1) AND stage_no IN (3, 5, 7, 8, 9, 27)', [allIds]) : [];
  const stg = new Map(); for (const r of cl) stg.set(`${r.job_card_id}:${r.stage_no}`, r.value1);
  const v = (id, n) => stg.get(`${id}:${n}`);

  let tubeNoFigures = 0;
  const tube = [];
  for (const c of tubeCards) {
    const sp = c.generated_spec || {}, k = sp.computed || {}, inp = sp.input || {};
    const cutMm = num(k.cuttingLengthMm), tlIn = num(k.totalLengthIn);
    if (!cutMm || !tlIn) { tubeNoFigures++; continue; }
    const mat = inp.tubeMaterial || c.tube_material || '';
    const dia = num(inp.tubeDiameterMm) || num(c.tube_diameter);
    const drawingIn = num(inp.drawingTotalLengthIn) ?? round(tlIn - E.TOTAL_LENGTH_ALLOWANCE_IN, 2);
    const wantMm = tlIn * 25.4;
    const drawn = lengthMm(v(c.id, 8), wantMm), floor = lengthMm(v(c.id, 5), cutMm);
    const cardPct = num(k.tubeDrawPct) != null ? Number(k.tubeDrawPct) * 100 : null;
    const act = drawn.mm != null ? (drawn.mm / cutMm - 1) * 100 : null;
    tube.push({
      jc: c.job_card_no, order: c.order_code, customer: c.customer_code, qty: Number(c.qty) || 0, drawnOn: istDay(c.done_at),
      tube: tubeLabel(mat), tubeCode: mat, dia, drawingIn, band: lengthBand(drawingIn), totalIn: tlIn,
      cardPct: round(cardPct), cutMm: round(cutMm, 1), cutIn: round(cutMm / 25.4, 3),
      floorCutMm: floor.mm != null ? round(floor.mm, 1) : null,
      drawnMm: drawn.mm != null ? round(drawn.mm, 1) : null, drawnIn: drawn.mm != null ? round(drawn.mm / 25.4, 3) : null,
      wantMm: round(wantMm, 1), overMm: drawn.mm != null ? round(drawn.mm - wantMm, 1) : null,
      actPct: round(act), actFloorPct: drawn.mm != null && floor.mm ? round((drawn.mm / floor.mm - 1) * 100) : null,
      diff: act != null && cardPct != null ? round(act - cardPct) : null,
      note: drawn.unit === '?' ? `St 8 "${v(c.id, 8) ?? ''}" does not fit the card in mm or inches — left out` : drawn.unit === 'in' ? 'St 8 entered in inches' : '',
    });
  }
  const tubeSummary = summarize(tube, r => ({ key: `${r.tube}|${r.dia}|${r.band}`, tube: r.tube, dia: r.dia, sub: r.band }), 'actPct', 'cardPct',
    rows => ({ overAvgMm: round(rows.reduce((t, r) => t + (r.overMm || 0), 0) / rows.length, 1) }));

  // ── Ohms / wire draw ──
  let ohmNoFigures = 0;
  const ohms = [];
  for (const c of ohmCards) {
    const sp = c.generated_spec || {}, k = sp.computed || {}, inp = sp.input || {};
    if (num(k.ohmsAfterDraw) == null || num(k.ohmsRangeMid) == null) { ohmNoFigures++; continue; }
    const mat = inp.tubeMaterial || c.tube_material || '';
    const dia = num(inp.tubeDiameterMm) || num(c.tube_diameter);
    const s3 = avgOf(v(c.id, 3)), s7 = hvOhms(v(c.id, 7)), s9 = hvOhms(v(c.id, 9)), s27 = hvOhms(v(c.id, 27));
    const design = Number(k.ohmsAfterDraw), lo = num(k.ohmsRangeMin), mid = Number(k.ohmsRangeMid), hi = num(k.ohmsRangeMax);
    const cardWire = num(k.wireDrawPct) != null ? Number(k.wireDrawPct) * 100 : null;
    const act = s3 && s27 ? (s3 / s27 - 1) * 100 : null;
    ohms.push({
      jc: c.job_card_no, order: c.order_code, customer: c.customer_code, qty: Number(c.qty) || 0, finalOn: istDay(c.done_at),
      tube: tubeLabel(mat), tubeCode: mat, dia, gauge: k.gauge != null ? `${k.gauge} SWG${k.doubleCoil ? ' double' : ''}` : '—',
      elements: num(k.elements) || 1, design: round(design), st3Range: lo != null && hi != null ? `${round(lo)} – ${round(mid)} – ${round(hi)}` : `${round(mid)}`,
      st3: round(s3), st3Off: s3 ? round((s3 / mid - 1) * 100, 1) : null,
      st3In: s3 == null || lo == null || hi == null ? '' : (s3 >= lo - 1e-9 && s3 <= hi + 1e-9 ? 'In' : 'Out'),
      st7: round(s7), st9: round(s9), st27: round(s27),
      dropAtDraw: s7 && s9 ? round((s7 / s9 - 1) * 100) : null,
      cardWirePct: round(cardWire), actWirePct: round(act), diff: act != null && cardWire != null ? round(act - cardWire) : null,
      finalVsDesign: s27 ? round((s27 / design - 1) * 100, 1) : null,
      note: [s3 == null ? 'no St 3 ohms' : '', s27 == null ? 'no St 27 ohms' : ''].filter(Boolean).join(' · '),
    });
  }
  const ohmSummary = summarize(ohms, r => ({ key: `${r.tube}|${r.dia}|${r.gauge}`, tube: r.tube, dia: r.dia, sub: r.gauge }), 'actWirePct', 'cardWirePct',
    rows => {
      const fv = rows.filter(r => r.finalVsDesign != null).map(r => r.finalVsDesign);
      return { st3InRange: `${rows.filter(r => r.st3In === 'In').length} of ${rows.filter(r => r.st3In).length}`,
        finalVsDesignAvg: fv.length ? round(fv.reduce((t, x) => t + x, 0) / fv.length, 1) : null };
    });

  return { tube, tubeSummary, tubeNoFigures, ohms, ohmSummary, ohmNoFigures };
}

module.exports = { drawAnalysis, lengthMm, tubeLabel, lengthBand };
