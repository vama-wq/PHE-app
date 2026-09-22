// ── Job card calculation engine (8 mm tube) ─────────────────────────────────
//
// Reproduces, in code, the Excel workbook Peena Heat Elements builds job cards
// in by hand, plus the 14-step written policy that governs it. Pure functions
// only: no database, no I/O, no app types — so it can be tested directly
// against the real cards that were actually built and dispatched.
//
// Verified against the two sound examples in the source workbook:
//   BPE-PT-FlameProof-550U  → 23 SWG @ 23% wire draw
//   QM-PT-USpiral-Upside-75 → 28 SWG @ 31% wire draw
//
// Vocabulary, because two different "draw percentages" appear on one card and
// confusing them silently produces a wrong heater:
//   • TUBE draw  — how much the tube stretches. Sets the cutting length.
//                  Policy Step 5: by material and total length.
//   • WIRE draw  — how much the coil stretches. Sets the resistance to wind to.
//                  Policy Step 7: by the chosen wire gauge.
// The wire draw depends on the gauge, and the gauge depends on the wire draw,
// so selection is a fixed-point search rather than a formula (see chooseWire).

const WIRE_TABLE = require('../data/wireGauge.json');

const INCH_MM = 25.4;
// The workbook uses 3.14 rather than Math.PI throughout. Keep it: changing it
// shifts every spring length by ~0.05% and would stop reproducing real cards.
const PI = 3.14;

// Policy Step 5 — tube draw, by material and total length (inches). 8 mm only.
const TUBE_DRAW_8MM = {
  steel:  [ { maxTL: 43, pct: 0.20 }, { maxTL: 50, pct: 0.197 }, { maxTL: Infinity, pct: 0.19 } ],
  copper: [ { maxTL: Infinity, pct: 0.23 } ],
};

// Policy Step 7 — wire draw, by gauge. 8 mm only.
// The 25-28 band takes 33% instead of 31% on a 1 kW heater.
const WIRE_DRAW_8MM = {
  steel: [
    { minG: 20, maxG: 24, pct: 0.23 },
    { minG: 25, maxG: 28, pct: 0.31, pctWhen1kW: 0.33 },
    { minG: 29, maxG: 29, pct: 0.41 },
    { minG: 30, maxG: Infinity, pct: 0.455 },
  ],
  copper: [
    { minG: 20, maxG: 24, pct: 0.15 },
    { minG: 25, maxG: 29, pct: 0.26 },
    { minG: 30, maxG: Infinity, pct: 0.29 },
  ],
};

// Spring-window divisors, per material. The low divisor is the binding one —
// it sets the shortest coil allowed, which is what actually picks the gauge.
// Taken from the two live SS cards (/3, /2.2) and the copper card (/2.5, /2);
// the blank SS template still carries a stale /2.5 ceiling.
const SPRING_DIVISORS = {
  steel:  { low: 3,   high: 2.2 },
  copper: { low: 2.5, high: 2 },
};

// Policy Step 5: the job-card length is always the drawing length plus this.
const TOTAL_LENGTH_ALLOWANCE_IN = 0.7;

// Row 19 of the card prints three lengths in mm, right to left: the total, then
// 10 less, then 5 less again. Owner confirmed 22 Sep 2026 that these deductions
// are fixed — the −18 on one old copper card was a one-off, not a rule.
const ROW19_STEP_DOWN_MM = [10, 5];

// Policy Step 6 — cold zone and terminal pin, by total length. Standard only;
// the planner may override (a 46.3" flameproof card shipped with a 3" zone).
const COLD_ZONE_STANDARD = [
  { maxTL: 50, coldZoneIn: 2, terminalPinIn: 3 },
  { maxTL: Infinity, coldZoneIn: 3, terminalPinIn: 4 },
];

// ── Material ────────────────────────────────────────────────────────────────
// Everything in the policy splits two ways only: copper, or steel (SS/Incoloy).
function materialClass(tubeMaterial) {
  const s = String(tubeMaterial || '').toLowerCase();
  if (/copper|cu\b|તાંબુ|तांबा/.test(s)) return 'copper';
  if (/ss|steel|inc|incoloy|એસએસ/.test(s)) return 'steel';
  return null; // caller must decide — never guess a material
}

// ── Policy lookups ──────────────────────────────────────────────────────────
function tubeDrawPct(material, totalLengthIn) {
  const bands = TUBE_DRAW_8MM[material];
  if (!bands) return null;
  return bands.find(b => totalLengthIn <= b.maxTL).pct;
}

function wireDrawPct(material, gauge, wattage) {
  const bands = WIRE_DRAW_8MM[material];
  if (!bands) return null;
  const band = bands.find(b => gauge >= b.minG && gauge <= b.maxG);
  if (!band) return null;
  if (band.pctWhen1kW && Number(wattage) === 1000) return band.pctWhen1kW;
  return band.pct;
}

function standardColdZone(totalLengthIn) {
  return COLD_ZONE_STANDARD.find(b => totalLengthIn <= b.maxTL);
}

// ── Wattage: "3in1" means three elements sharing the stated total ───────────
// Policy Step 4. A 3 kW 3in1 card carries 1000 W per element.
function perElementWattage(totalWattage, drawingOrProductName) {
  const m = String(drawingOrProductName || '').match(/(\d+)\s*in\s*1/i);
  const n = m ? parseInt(m[1], 10) : 1;
  return { elements: n, wattage: n > 1 ? Number(totalWattage) / n : Number(totalWattage) };
}

// ── Spring length of one candidate wire ─────────────────────────────────────
// Close-wound coil: 25.4/dia turns per inch, each turn using π·(mandrel+dia) mm
// of wire. So an inch of coil has (mandrel+dia)·π·(25.4/dia) mm of wire, and
// its resistance is that × ohms-per-metre / 1000. Length is then simply the
// required resistance divided by resistance-per-inch — in INCHES.
function springLengthIn(requiredOhms, wire) {
  const perInchOhms = (wire.mandrel_mm + wire.dia_mm) * PI * INCH_MM * wire.ohms_per_m / (1000 * wire.dia_mm);
  return requiredOhms / perInchOhms;
}

// ── Gauge selection ─────────────────────────────────────────────────────────
// The wire draw % depends on the gauge, and the gauge depends on the wire draw
// %, so there is no closed form. Instead: assume each policy band in turn,
// select under that assumption, and keep only the assumptions that come back
// consistent — the fixed points. A tie means several are self-consistent; an
// empty result means no wire in the table reaches the required coil length.
function chooseWire(opts) {
  const {
    material, ohmsAfterDraw, wattage, springWindow,
    wireTable = WIRE_TABLE.rows, includeExcluded = false,
  } = opts;

  // A row carrying an `excluded` reason is on the rack but not eligible — today
  // that means the 80/20 alloy spools, which the owner ruled out of selection.
  const candidates = wireTable.filter(w => includeExcluded || !w.excluded);
  const excluded = wireTable.length - candidates.length;

  const bands = WIRE_DRAW_8MM[material] || [];
  // Distinct percentages this material can use, including the 1 kW variant.
  const pcts = [...new Set(bands.flatMap(b => [b.pct, b.pctWhen1kW]).filter(p => p != null))];

  const fixedPoints = [];
  for (const pct of pcts) {
    const requiredOhms = ohmsAfterDraw * (1 + pct);
    const inWindow = candidates
      .map(w => ({ wire: w, springIn: springLengthIn(requiredOhms, w) }))
      .filter(c => c.springIn >= springWindow.lowIn && c.springIn <= springWindow.highIn)
      .sort((a, b) => a.springIn - b.springIn); // "least coil length" — policy Step 8
    if (!inWindow.length) continue;
    const winner = inWindow[0];
    // Self-consistent only if the winning gauge's own band returns this pct.
    if (wireDrawPct(material, winner.wire.gauge, wattage) !== pct) continue;
    fixedPoints.push({
      wireDrawPct: pct,
      requiredOhms: round(requiredOhms, 4),
      gauge: winner.wire.gauge,
      wire: winner.wire,
      springLengthIn: round(winner.springIn, 4),
      // Every spool of the winning gauge that also fits — the planner picks the
      // one actually on the rack, and its measured ohms/m goes on the card.
      spools: inWindow.filter(c => c.wire.gauge === winner.wire.gauge)
        .map(c => ({ ...c.wire, springLengthIn: round(c.springIn, 4) })),
      alternativeGauges: [...new Set(inWindow.map(c => c.wire.gauge))].filter(g => g !== winner.wire.gauge),
    });
  }

  // Owner's rule on a tie: take the coarsest gauge — thicker wire, longer life,
  // and where the existing cards sit — but surface the rest so it can be changed.
  fixedPoints.sort((a, b) => a.gauge - b.gauge);
  return {
    chosen: fixedPoints[0] || null,
    alternatives: fixedPoints.slice(1),
    resolution: fixedPoints.length === 0 ? 'none' : fixedPoints.length === 1 ? 'unique' : 'multiple',
    excludedRows: excluded,
  };
}

// ── The whole card ──────────────────────────────────────────────────────────
// Inputs are everything the app holds on the order item, plus the four things
// the planner answers: assembly, fixture, dispatch date and the drawing length.
function buildJobCard(input) {
  const {
    tubeMaterial, wattage: statedWattage, voltage,
    drawingTotalLengthIn,            // straight off the approved drawing
    drawingNumber, productCode,
    coldZoneBigIn, coldZoneSmallIn,  // optional overrides
    wireDrawPctOverride,             // optional: planner overrides the policy band
    tubeDiameterMm = 8,
  } = input;

  const warnings = [];
  const material = materialClass(tubeMaterial);
  if (!material) return { ok: false, error: `Cannot classify tube material "${tubeMaterial}" as copper or steel.` };
  if (Number(tubeDiameterMm) !== 8) return { ok: false, error: `This engine covers 8 mm tube only (got ${tubeDiameterMm} mm).` };
  if (!(Number(drawingTotalLengthIn) > 0)) return { ok: false, error: 'Drawing total length is required.' };
  if (!(Number(voltage) > 0) || !(Number(statedWattage) > 0)) return { ok: false, error: 'Wattage and voltage are required.' };

  // Step 4 — split the stated wattage across a 2in1 / 3in1 assembly.
  const { elements, wattage } = perElementWattage(statedWattage, `${drawingNumber || ''} ${productCode || ''}`);

  // Step 5 — the card's length is the drawing's plus the standard allowance.
  const totalLengthIn = round(Number(drawingTotalLengthIn) + TOTAL_LENGTH_ALLOWANCE_IN, 4);
  const tubeDraw = tubeDrawPct(material, totalLengthIn);

  // Row 19, as printed: total in mm, then each step-down applied in turn.
  const totalLengthMm = round(totalLengthIn * INCH_MM, 2);
  const row19LengthsMm = ROW19_STEP_DOWN_MM.reduce(
    (acc, step) => [...acc, round(acc[acc.length - 1] - step, 2)], [totalLengthMm]);
  const cuttingLengthIn = totalLengthIn / (1 + tubeDraw);

  // Step 6 — cold zone: policy standard unless the planner overrides.
  const std = standardColdZone(totalLengthIn);
  const czBig = coldZoneBigIn != null ? Number(coldZoneBigIn) : std.coldZoneIn;
  const czSmall = coldZoneSmallIn != null ? Number(coldZoneSmallIn) : std.coldZoneIn;
  if (coldZoneBigIn != null && Number(coldZoneBigIn) !== std.coldZoneIn) {
    warnings.push(`Cold zone ${coldZoneBigIn}" overrides the ${std.coldZoneIn}" standard for a ${totalLengthIn}" element.`);
  }

  // Resistance the finished element must show, and the spread the shop works to.
  const ohmsAfterDraw = (Number(voltage) * Number(voltage)) / wattage;

  // The coil is wound long and stretched, so it is wound to a HIGHER resistance.
  const divisors = SPRING_DIVISORS[material];
  const springWindow = {
    lowIn:  (cuttingLengthIn - czBig * 2) / divisors.low,
    highIn: (cuttingLengthIn - czBig * 2) / divisors.high,
  };

  let selection;
  if (wireDrawPctOverride != null) {
    const requiredOhms = ohmsAfterDraw * (1 + Number(wireDrawPctOverride));
    const inWindow = WIRE_TABLE.rows.filter(w => !w.excluded)
      .map(w => ({ wire: w, springIn: springLengthIn(requiredOhms, w) }))
      .filter(c => c.springIn >= springWindow.lowIn && c.springIn <= springWindow.highIn)
      .sort((a, b) => a.springIn - b.springIn);
    selection = {
      chosen: inWindow.length ? {
        wireDrawPct: Number(wireDrawPctOverride), requiredOhms: round(requiredOhms, 4),
        gauge: inWindow[0].wire.gauge, wire: inWindow[0].wire,
        springLengthIn: round(inWindow[0].springIn, 4),
        spools: inWindow.filter(c => c.wire.gauge === inWindow[0].wire.gauge)
          .map(c => ({ ...c.wire, springLengthIn: round(c.springIn, 4) })),
        alternativeGauges: [],
      } : null,
      alternatives: [], resolution: inWindow.length ? 'override' : 'none', excludedRows: 0,
    };
    warnings.push(`Wire draw ${(Number(wireDrawPctOverride) * 100).toFixed(1)}% set by hand, overriding the policy band.`);
  } else {
    selection = chooseWire({ material, ohmsAfterDraw, wattage, springWindow });
  }

  if (selection.resolution === 'none') {
    warnings.push('No wire in the table reaches the required coil length — the gauge must be chosen by hand.');
  } else if (selection.resolution === 'multiple') {
    warnings.push(`${selection.alternatives.length + 1} gauges are self-consistent (${[selection.chosen.gauge, ...selection.alternatives.map(a => a.gauge)].join(', ')}); the coarsest was taken.`);
  }

  const c = selection.chosen;
  const ohmsRangeMid = c ? c.requiredOhms : null;

  return {
    ok: true,
    material, elements,
    wattage, statedWattage: Number(statedWattage), voltage: Number(voltage),
    tubeDiameterMm: Number(tubeDiameterMm),

    drawingTotalLengthIn: Number(drawingTotalLengthIn),
    totalLengthIn,
    totalLengthMm,
    // [total, total−10, total−5 more] in mm — the card prints these right to left.
    row19LengthsMm,
    tubeLengthAfterDrawMm: row19LengthsMm[2],

    tubeDrawPct: tubeDraw,
    cuttingLengthIn: round(cuttingLengthIn, 4),
    cuttingLengthMm: round(cuttingLengthIn * INCH_MM, 2),

    ohmsAfterDraw: round(ohmsAfterDraw, 4),
    ohmsAfterDrawMin: round(ohmsAfterDraw * 0.95, 4),
    ohmsAfterDrawMax: round(ohmsAfterDraw * 1.05, 4),

    ohmsRangeMid: ohmsRangeMid == null ? null : round(ohmsRangeMid, 4),
    ohmsRangeMin: ohmsRangeMid == null ? null : round(ohmsRangeMid * 0.99, 4),
    ohmsRangeMax: ohmsRangeMid == null ? null : round(ohmsRangeMid * 1.01, 4),

    coldZoneBigIn: czBig, coldZoneSmallIn: czSmall,
    terminalPinBig: terminalPin(czBig),
    terminalPinSmall: terminalPin(czSmall),
    standardTerminalPinIn: std.terminalPinIn,

    springWindowLowIn: round(springWindow.lowIn, 4),
    springWindowHighIn: round(springWindow.highIn, 4),

    wireDrawPct: c ? c.wireDrawPct : null,
    gauge: c ? c.gauge : null,
    wire: c ? c.wire : null,
    springLengthIn: c ? c.springLengthIn : null,
    spoolOptions: c ? c.spools : [],
    gaugeResolution: selection.resolution,
    gaugeAlternatives: selection.alternatives.map(a => ({
      gauge: a.gauge, wireDrawPct: a.wireDrawPct, springLengthIn: a.springLengthIn,
    })),

    warnings,
  };
}

// Policy Step 6's stud sizing, ported verbatim from the workbook (D26/F26/H26).
// ceil(CZ/1.215 + 1) returns 3 for a 2" zone and 4 for a 3" one, which is the
// whole of the written rule; H26 is printed as a whole number.
function terminalPin(coldZoneIn) {
  const raw = coldZoneIn / 121.5 * 100 + 1;
  return { raw: round(raw, 6), studs: Math.ceil(raw), printed: Math.round(raw * 2 - 2) };
}

function round(n, dp) { const f = 10 ** dp; return Math.round(n * f) / f; }

module.exports = {
  buildJobCard, chooseWire, springLengthIn,
  materialClass, tubeDrawPct, wireDrawPct, standardColdZone, perElementWattage, terminalPin,
  TUBE_DRAW_8MM, WIRE_DRAW_8MM, SPRING_DIVISORS, TOTAL_LENGTH_ALLOWANCE_IN, ROW19_STEP_DOWN_MM, WIRE_TABLE,
};
