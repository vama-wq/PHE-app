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

// Two wire tables that must NEVER be mixed. The spools coincide almost
// exactly, but the MANDREL does not — 11 mm winds on 2.0 throughout, while
// 8 mm carries one 2.1 row and three at 1.8 — and the mandrel sets the spring
// length. Picking from the wrong table gives a plausible, wrong coil.
const WIRE_TABLES = {
  8: require('../data/wireGauge.json'),
  11: require('../data/wireGauge11.json'),
};
const SUPPORTED_DIAMETERS = [8, 11];

const INCH_MM = 25.4;
// The workbook uses 3.14 rather than Math.PI throughout. Keep it: changing it
// shifts every spring length by ~0.05% and would stop reproducing real cards.
const PI = 3.14;

// Policy Step 5 — tube draw, by material and total length (inches).
// 11 mm SS above 51" moved from 13% to 15% (owner, 24 Sep 2026). Everything
// else — 15.6% below 51", copper flat at 16%, and the whole 8 mm set — stands.
const TUBE_DRAW = {
  // 8 mm went flat at every length (owner, 24 Sep 2026): 20.7% steel / Incoloy,
  // 23.7% copper. The old 43" and 50" breaks (20 / 19.7 / 19) are retired.
  8: {
    steel:  [ { maxTL: Infinity, pct: 0.207 } ],
    copper: [ { maxTL: Infinity, pct: 0.237 } ],
  },
  11: {
    steel:  [ { maxTL: 51, pct: 0.156 }, { maxTL: Infinity, pct: 0.15 } ],
    copper: [ { maxTL: Infinity, pct: 0.16 } ],
  },
};

// Policy Step 7 — wire draw, by gauge. 8 mm only.
// The 25-28 band takes 33% instead of 31% on a 1 kW heater.
const WIRE_DRAW = {
  8: {
    steel: [
      { minG: 20, maxG: 24, pct: 0.23 },
      { minG: 25, maxG: 28, pct: 0.31, pctWhen1kW: 0.33 },
      { minG: 29, maxG: 29, pct: 0.41 },
      // 30 and above moved 45.5% -> 46% (owner, 24 Sep 2026). Steel / Incoloy
      // only — copper's ladder below is untouched.
      { minG: 30, maxG: Infinity, pct: 0.46 },
    ],
    copper: [
      { minG: 20, maxG: 24, pct: 0.15 },
      { minG: 25, maxG: 29, pct: 0.26 },
      { minG: 30, maxG: Infinity, pct: 0.29 },
    ],
  },
  // 11 mm has no 1 kW special case.
  11: {
    steel: [
      { minG: 20, maxG: 24, pct: 0.12 },
      { minG: 25, maxG: 30, pct: 0.17 },
      { minG: 31, maxG: Infinity, pct: 0.21 },
    ],
    copper: [
      { minG: 20, maxG: 24, pct: 0.08 },
      { minG: 25, maxG: 30, pct: 0.12 },
      { minG: 31, maxG: Infinity, pct: 0.17 },
    ],
  },
};

// Spring-window divisors, per material. The low divisor is the binding one —
// it sets the shortest coil allowed, which is what actually picks the gauge.
// Taken from the two live SS cards (/3, /2.2) and the copper card (/2.5, /2);
// the blank SS template still carries a stale /2.5 ceiling.
const SPRING_DIVISORS = {
  8:  { steel: { low: 3, high: 2.2 }, copper: { low: 2.5, high: 2 } },
  // 11 mm does not split by material — its three blank templates all carry the
  // same pair. Owner chose the 2.2 ceiling over the templates' 2.5, 24 Sep 2026.
  11: { steel: { low: 3, high: 2.2 }, copper: { low: 3, high: 2.2 } },
};

// Which self-consistent gauge wins when more than one is valid. The owner's
// rule since 26 Sep 2026 is 'most-spools': the gauge with the most spools
// inside the window — the one most likely to be on the rack — with the
// shortest coil breaking ties. In his words: "if the range is 10 to 14, 12
// will also work if the gauge has more probability". 'coarsest-gauge' was the
// rule before that; the written policy's Step 8 reads as 'least-coil'. All
// three live here by name and every tie still reports the alternatives.
// They disagree often enough to matter, so the choice is named, not buried.
const TIE_BREAK = 'most-spools';

// Policy Step 5: the job-card length is always the drawing length plus this.
const TOTAL_LENGTH_ALLOWANCE_IN = 0.7;

// Row 19 of the card prints three lengths in mm, right to left: the total, then
// a step down, then 5 less again. The first step depends on the tube: 10 mm on
// 8 mm tube (owner confirmed 22 Sep 2026; the −18 on one old 8 mm copper card
// was a one-off), 18 mm on 11 mm tube, which all three 11 mm templates carry.
const ROW19_STEP_DOWN_MM = { 8: [10, 5], 11: [18, 5] };

// Policy Step 6 — cold zone and terminal pin, by total length. Standard only;
// the planner may override (a 46.3" flameproof card shipped with a 3" zone).
const COLD_ZONE_STANDARD = {
  8:  [ { maxTL: 50, coldZoneIn: 2, terminalPinIn: 3 }, { maxTL: Infinity, coldZoneIn: 3, terminalPinIn: 4 } ],
  // 11 mm: owner's rule, 24 Sep 2026 — 3" up to 48.5", 4" above, overridden
  // per card. Nothing in the workbook derives it; the samples show 3", 16"
  // and 26", so an override is routine here rather than exceptional.
  11: [ { maxTL: 48.5, coldZoneIn: 3, terminalPinIn: 3 }, { maxTL: Infinity, coldZoneIn: 4, terminalPinIn: 4 } ],
};

// What the terminal pin divides the cold zone by. 8 mm uses 1.215 throughout;
// 11 mm uses 1.15 for SS and Incoloy and 1.215 for copper, per its templates.
const PIN_DIVISOR = { 8: { steel: 1.215, copper: 1.215 }, 11: { steel: 1.15, copper: 1.215 } };

// The stud the card names. 8 mm takes M4, 11 mm takes M5.
const STUD = { 8: 'M4-SS', 11: 'M5-SS' };

// ── Material ────────────────────────────────────────────────────────────────
// Everything in the policy splits two ways only: copper, or steel (SS/Incoloy).
function materialClass(tubeMaterial) {
  const s = String(tubeMaterial || '').toLowerCase();
  if (/\bcopper\b|\bcu\b|તાંબુ|तांबा/.test(s)) return 'copper';
  // Anchored: a bare /ss/ matched the "ss" in Brass and a bare /inc/ matched the
  // "inc" in Zinc, so an unlisted material was silently drawn as steel.
  if (/\bss\d*\b|\bstainless\b|\bsteel\b|\binc\b|\bincoloy\b|\binconel\b|એસએસ/.test(s)) return 'steel';
  return null; // caller must decide — never guess a material
}

// ── Policy lookups ──────────────────────────────────────────────────────────
function tubeDrawPct(material, totalLengthIn, dia = 8) {
  const bands = TUBE_DRAW[dia] && TUBE_DRAW[dia][material];
  if (!bands) return null;
  return bands.find(b => totalLengthIn <= b.maxTL).pct;
}

function wireDrawPct(material, gauge, wattage, dia = 8) {
  const bands = WIRE_DRAW[dia] && WIRE_DRAW[dia][material];
  if (!bands) return null;
  const band = bands.find(b => gauge >= b.minG && gauge <= b.maxG);
  if (!band) return null;
  if (band.pctWhen1kW && Number(wattage) === 1000) return band.pctWhen1kW;
  return band.pct;
}

function standardColdZone(totalLengthIn, dia = 8) {
  return (COLD_ZONE_STANDARD[dia] || COLD_ZONE_STANDARD[8]).find(b => totalLengthIn <= b.maxTL);
}

// ── Wattage: "3in1" means three elements sharing the stated total ───────────
// Policy Step 4. A 3 kW 3in1 card carries 1000 W per element.
//
// Getting this wrong is the single most dangerous error the engine can make: a
// missed split winds the element at the full assembly wattage (three times the
// power, burnt out on first switch-on), and a spurious split winds it at a
// fraction. So an explicit count always wins, the text is only a fallback, and
// a count that came from text is always reported so the owner can see it.
//
// The pattern requires a boundary before the number and refuses a digit after
// the "1", so "12IN12MM" no longer reads as a 12-in-1, while "3in1", "3 in 1",
// "3-in-1" and "3_in_1" all match.
const IN1_PATTERN = /(?:^|[^0-9a-z])(\d{1,2})\s*[-_ ]?\s*in\s*[-_ ]?\s*1(?![0-9])/i;

function perElementWattage(totalWattage, drawingOrProductName, explicitElements) {
  const explicit = explicitElements == null || String(explicitElements).trim() === ''
    ? null : Number(explicitElements);
  if (explicit != null && Number.isInteger(explicit) && explicit >= 1) {
    return { elements: explicit, source: 'given', wattage: Number(totalWattage) / explicit };
  }
  const m = String(drawingOrProductName || '').match(IN1_PATTERN);
  const n = m ? parseInt(m[1], 10) : 1;
  return {
    elements: n,
    source: n > 1 ? 'read from the drawing name' : 'single element',
    wattage: n > 1 ? Number(totalWattage) / n : Number(totalWattage),
  };
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
    material, ohmsAfterDraw, wattage, springWindow, dia = 8,
    wireTable = (WIRE_TABLES[dia] || WIRE_TABLES[8]).rows, includeExcluded = false,
  } = opts;

  // A row carrying an `excluded` reason is on the rack but not eligible — today
  // that means the 80/20 alloy spools, which the owner ruled out of selection.
  const eligible = wireTable.filter(w => includeExcluded || !w.excluded);
  const excluded = wireTable.length - eligible.length;

  const bands = (WIRE_DRAW[dia] && WIRE_DRAW[dia][material]) || [];
  // Distinct percentages this material can use, including the 1 kW variant.
  const pcts = [...new Set(bands.flatMap(b => [b.pct, b.pctWhen1kW]).filter(p => p != null))];

  // One pass of the fixed-point search over a set of rows.
  const search = (candidates) => {
    const fixedPoints = [];
    for (const pct of pcts) {
      const requiredOhms = ohmsAfterDraw * (1 + pct);
      // Self-consistency is a property of each candidate, not of the band's
      // winner. A wire whose own policy band disagrees with the assumed pct is
      // simply not buildable under that assumption, so it must be filtered out
      // BEFORE anything is ranked. Testing only the globally shortest wire and
      // then vetoing the whole band silently threw away valid coarser gauges —
      // and, worse, sometimes reported that no wire fitted when one plainly did.
      const inWindow = candidates
        .filter(w => wireDrawPct(material, w.gauge, wattage, dia) === pct)
        .map(w => ({ wire: w, springIn: springLengthIn(requiredOhms, w) }))
        .filter(c => c.springIn >= springWindow.lowIn && c.springIn <= springWindow.highIn)
        .sort((a, b) => a.springIn - b.springIn);
      if (!inWindow.length) continue;
      // Within the band, the gauge with the MOST spools inside the window wins —
      // that is the gauge most likely to be on the rack — and only then the
      // shortest coil. Before 26 Sep 2026 the shortest coil won outright, which
      // on one card offered 27 SWG with three spools that fit, hugging the
      // floor, over 26 SWG with nine.
      const byGauge = new Map();
      for (const c of inWindow) { if (!byGauge.has(c.wire.gauge)) byGauge.set(c.wire.gauge, []); byGauge.get(c.wire.gauge).push(c); }
      const ranked = [...byGauge.entries()]
        .map(([gauge, cs]) => ({ gauge, spools: cs, shortest: cs[0] }))
        .sort((a, b) => b.spools.length - a.spools.length || a.shortest.springIn - b.shortest.springIn);
      const win = ranked[0];
      fixedPoints.push({
        wireDrawPct: pct,
        requiredOhms: round(requiredOhms, 4),
        gauge: win.gauge,
        wire: { ...win.shortest.wire }, // a copy: never hand a caller a live row of the shared table
        springLengthIn: round(win.shortest.springIn, 4),
        // Every spool of the winning gauge that also fits — the planner picks the
        // one actually on the rack, and its measured ohms/m goes on the card.
        spools: win.spools.map(c => ({ ...c.wire, springLengthIn: round(c.springIn, 4) })),
        alternativeGauges: ranked.slice(1).map(r => r.gauge),
      });
    }
    return fixedPoints;
  };

  // Rows flagged `lastResort` — the four odd 24 SWG spools reading 10.4-10.8
  // ohm/m where every other 24 SWG spool reads 5.6-5.9 — are rarely on the rack.
  // They are tried only when nothing else in the table reaches the window
  // (owner, 26 Sep 2026); before that they won ties on ordinary terms.
  let fixedPoints = search(eligible.filter(w => !w.lastResort));
  let usedLastResort = false;
  if (!fixedPoints.length) { fixedPoints = search(eligible); usedLastResort = fixedPoints.length > 0; }

  const TIE_BREAKS = {
    'most-spools': (a, b) => b.spools.length - a.spools.length || a.springLengthIn - b.springLengthIn,
    'coarsest-gauge': (a, b) => a.gauge - b.gauge,
    'least-coil': (a, b) => a.springLengthIn - b.springLengthIn,
  };
  fixedPoints.sort(TIE_BREAKS[TIE_BREAK]);
  const leastCoil = [...fixedPoints].sort(TIE_BREAKS['least-coil'])[0];
  return {
    chosen: fixedPoints[0] || null,
    alternatives: fixedPoints.slice(1),
    leastCoil: leastCoil || null,
    tieBreak: TIE_BREAK,
    usedLastResort,
    resolution: fixedPoints.length === 0 ? 'none' : fixedPoints.length === 1 ? 'unique' : 'multiple',
    excludedRows: excluded,
  };
}

// ── Reading inputs off a form ───────────────────────────────────────────────
// Everything here arrives from an HTTP body, where an untouched optional box is
// '' and not undefined. `'' != null` is true and `Number('')` is 0, so the naive
// check turned "planner left the cold zone blank" into "cold zone is zero inches"
// and built a complete, confident, wrong card. Blank means absent; garbage is an
// error, never a silent zero.
function optionalNumber(value, label, errors) {
  if (value == null) return null;
  const text = String(value).trim();
  if (text === '') return null;
  const n = Number(text);
  if (!Number.isFinite(n)) { errors.push(`${label} must be a number (got "${value}").`); return null; }
  return n;
}

function requiredNumber(value, label, errors) {
  const n = optionalNumber(value, label, errors);
  if (n == null) { errors.push(`${label} is required.`); return null; }
  if (!(n > 0)) { errors.push(`${label} must be greater than zero (got ${n}).`); return null; }
  return n;
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
    terminalPinBigIn, terminalPinSmallIn, // optional: forced independently of the cold zone
    wireDrawPctOverride,             // optional: planner overrides the policy band
    elementsPerAssembly,             // optional: beats reading "3in1" off the name
    tubeDiameterMm = 8,
  } = input;

  const warnings = [];
  const errors = [];
  const material = materialClass(tubeMaterial);
  if (!material) return { ok: false, error: `Cannot classify tube material "${tubeMaterial}" as copper or steel. Say which it is before the card can be built.` };
  const dia = requiredNumber(tubeDiameterMm, 'Tube diameter', errors);
  if (dia != null && !SUPPORTED_DIAMETERS.includes(dia)) {
    return { ok: false, error: `This engine covers ${SUPPORTED_DIAMETERS.join(' and ')} mm tube (got ${dia} mm).` };
  }
  const drawingLen = requiredNumber(drawingTotalLengthIn, 'Drawing total length', errors);
  const volts = requiredNumber(voltage, 'Voltage', errors);
  const watts = requiredNumber(statedWattage, 'Wattage', errors);

  const czBigIn = optionalNumber(coldZoneBigIn, 'Cold zone (big)', errors);
  const czSmallIn = optionalNumber(coldZoneSmallIn, 'Cold zone (small)', errors);
  const pinBigIn = optionalNumber(terminalPinBigIn, 'Terminal pin (big)', errors);
  const pinSmallIn = optionalNumber(terminalPinSmallIn, 'Terminal pin (small)', errors);
  const drawOverride = optionalNumber(wireDrawPctOverride, 'Wire draw override', errors);
  // The policy writes draws as "31%", so a planner typing 31 means 0.31. Taken
  // literally that is a 3100% draw and a perfectly confident card at 24x the
  // resistance, so refuse it rather than guess which they meant.
  if (drawOverride != null && !(drawOverride > 0 && drawOverride < 1)) {
    errors.push(`Wire draw override must be a fraction between 0 and 1 — pass 0.31 for 31% (got ${drawOverride}).`);
  }
  if (czBigIn != null && czBigIn <= 0) errors.push(`Cold zone (big) must be greater than zero (got ${czBigIn}).`);
  if (czSmallIn != null && czSmallIn <= 0) errors.push(`Cold zone (small) must be greater than zero (got ${czSmallIn}).`);
  if (pinBigIn != null && pinBigIn <= 0) errors.push(`Terminal pin (big) must be greater than zero (got ${pinBigIn}).`);
  if (pinSmallIn != null && pinSmallIn <= 0) errors.push(`Terminal pin (small) must be greater than zero (got ${pinSmallIn}).`);
  if (errors.length) return { ok: false, error: errors.join(' ') };

  // Step 4 — split the stated wattage across a 2in1 / 3in1 assembly.
  const { elements, wattage, source: elementsSource } =
    perElementWattage(watts, `${drawingNumber || ''} ${productCode || ''}`, elementsPerAssembly);
  // Everything below is read out of the tables for THIS diameter.
  const D = dia;
  if (elements > 1) {
    warnings.push(`Built as a ${elements}-in-1: ${watts} W split to ${round(wattage, 2)} W per element (${elementsSource}).`);
  }

  // Step 5 — the card's length is the drawing's plus the standard allowance.
  const totalLengthIn = round(drawingLen + TOTAL_LENGTH_ALLOWANCE_IN, 4);
  const tubeDraw = tubeDrawPct(material, totalLengthIn, D);
  // The policy's steel bands read "below 43", "between 44 and 50", "above 51",
  // so 43-44 and 50-51 are simply unwritten. The engine has to resolve them to
  // something; it says which way it went rather than letting a hundredth of an
  // inch move the cutting length by 6 mm in silence.
  if (D === 8 && material === 'steel' && ((totalLengthIn > 43 && totalLengthIn < 44) || (totalLengthIn > 50 && totalLengthIn < 51))) {
    warnings.push(`Total length ${totalLengthIn}" falls in a range the policy does not cover; ${(tubeDraw * 100).toFixed(1)}% tube draw was used. Confirm before cutting.`);
  }

  // Row 19, as printed: total in mm, then each step-down applied in turn.
  const totalLengthMm = round(totalLengthIn * INCH_MM, 2);
  const row19LengthsMm = (ROW19_STEP_DOWN_MM[D] || ROW19_STEP_DOWN_MM[8]).reduce(
    (acc, step) => [...acc, round(acc[acc.length - 1] - step, 2)], [totalLengthMm]);
  const cuttingLengthIn = totalLengthIn / (1 + tubeDraw);

  // Step 6 — cold zone: policy standard unless the planner overrides.
  const std = standardColdZone(totalLengthIn, D);
  const czBig = czBigIn != null ? czBigIn : std.coldZoneIn;
  const czSmall = czSmallIn != null ? czSmallIn : std.coldZoneIn;
  for (const [label, given, used] of [['big', czBigIn, czBig], ['small', czSmallIn, czSmall]]) {
    if (given != null && given !== std.coldZoneIn) {
      warnings.push(`Cold zone ${label} ${used}" overrides the ${std.coldZoneIn}" standard for a ${totalLengthIn}" element.`);
    }
  }
  // Overriding one end only leaves the other on the standard, which builds an
  // element with a different cold zone and terminal pin at each end. Legitimate
  // sometimes, scrap when it was an oversight — so it never passes unremarked.
  if (czBig !== czSmall) {
    warnings.push(`Ends differ: ${czBig}" cold zone with a ${terminalPin(czBig, D, material).studs}" pin at the big end, ${czSmall}" with a ${terminalPin(czSmall, D, material).studs}" pin at the small end. Confirm this is intended.`);
  }

  for (const [label, given, cz] of [['big', pinBigIn, czBig], ['small', pinSmallIn, czSmall]]) {
    if (given != null && given !== terminalPin(cz, D, material).studs) {
      warnings.push(`Terminal pin ${label} forced to ${given}" — a ${cz}" cold zone gives ${terminalPin(cz, D, material).studs}".`);
    }
  }

  // Resistance the finished element must show, and the spread the shop works to.
  const ohmsAfterDraw = (volts * volts) / wattage;

  // The coil is wound long and stretched, so it is wound to a HIGHER resistance.
  const divisors = (SPRING_DIVISORS[D] || SPRING_DIVISORS[8])[material];
  const springWindow = {
    lowIn:  (cuttingLengthIn - czBig * 2) / divisors.low,
    highIn: (cuttingLengthIn - czBig * 2) / divisors.high,
  };

  let selection;
  if (drawOverride != null) {
    const requiredOhms = ohmsAfterDraw * (1 + drawOverride);
    const inWindow = (WIRE_TABLES[D] || WIRE_TABLES[8]).rows.filter(w => !w.excluded)
      .map(w => ({ wire: w, springIn: springLengthIn(requiredOhms, w) }))
      .filter(c => c.springIn >= springWindow.lowIn && c.springIn <= springWindow.highIn)
      .sort((a, b) => a.springIn - b.springIn);
    selection = {
      chosen: inWindow.length ? {
        wireDrawPct: drawOverride, requiredOhms: round(requiredOhms, 4),
        gauge: inWindow[0].wire.gauge, wire: { ...inWindow[0].wire },
        springLengthIn: round(inWindow[0].springIn, 4),
        spools: inWindow.filter(c => c.wire.gauge === inWindow[0].wire.gauge)
          .map(c => ({ ...c.wire, springLengthIn: round(c.springIn, 4) })),
        alternativeGauges: [],
      } : null,
      alternatives: [], resolution: inWindow.length ? 'override' : 'none', excludedRows: 0,
    };
    warnings.push(`Wire draw ${(drawOverride * 100).toFixed(1)}% set by hand, overriding the policy band.`);
  } else {
    selection = chooseWire({ material, ohmsAfterDraw, wattage, springWindow, dia: D });
  }

  if (selection.usedLastResort && selection.chosen) {
    warnings.push(`Only the odd 24 SWG spools (10.4-10.8 ohm/m) reach the window — check the rack before cutting; ${selection.chosen.spools.length} of them fit.`);
  }
  if (selection.resolution === 'none') {
    warnings.push('No wire in the table reaches the required coil length — the gauge must be chosen by hand.');
  } else if (selection.resolution === 'multiple') {
    const others = selection.alternatives.map(a => `${a.gauge} SWG @ ${(a.wireDrawPct * 100).toFixed(1)}% (${a.spools.length} spool${a.spools.length === 1 ? '' : 's'} fit)`).join(', ');
    warnings.push(`${selection.alternatives.length + 1} gauges fit; ${selection.chosen.gauge} SWG was taken as the best stocked — ${selection.chosen.spools.length} spools of it fit the window, against ${others}.`);
    if (selection.leastCoil && selection.leastCoil.gauge !== selection.chosen.gauge) {
      warnings.push(`The shortest coil would instead be ${selection.leastCoil.gauge} SWG @ ${(selection.leastCoil.wireDrawPct * 100).toFixed(1)}%, ohms ${selection.leastCoil.requiredOhms} (coil ${selection.leastCoil.springLengthIn}" against ${selection.chosen.springLengthIn}").`);
    }
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
    // The pin normally comes out of the cold zone. It can also be forced on its
    // own — a different flange, a customer's fitting, what is on the shelf —
    // and when it is, the card says so rather than showing a pin its own cold
    // zone would never produce.
    terminalPinBig: pinFor(czBig, pinBigIn, D, material),
    terminalPinSmall: pinFor(czSmall, pinSmallIn, D, material),
    standardTerminalPinIn: std.terminalPinIn,
    studLabel: STUD[D] || STUD[8],

    springWindowLowIn: round(springWindow.lowIn, 4),
    springWindowHighIn: round(springWindow.highIn, 4),

    wireDrawPct: c ? c.wireDrawPct : null,
    gauge: c ? c.gauge : null,
    wire: c ? c.wire : null,
    springLengthIn: c ? c.springLengthIn : null,
    spoolOptions: c ? c.spools : [],
    gaugeResolution: selection.resolution,
    tieBreak: selection.tieBreak,
    leastCoilOption: selection.leastCoil && selection.chosen && selection.leastCoil.gauge !== selection.chosen.gauge
      ? { gauge: selection.leastCoil.gauge, wireDrawPct: selection.leastCoil.wireDrawPct, springLengthIn: selection.leastCoil.springLengthIn, ohmsRangeMid: selection.leastCoil.requiredOhms }
      : null,
    usedLastResort: selection.usedLastResort,
    gaugeAlternatives: selection.alternatives.map(a => ({
      gauge: a.gauge, wireDrawPct: a.wireDrawPct, springLengthIn: a.springLengthIn,
    })),

    warnings,
  };
}

// Policy Step 6's stud sizing, ported from the workbook (D26/F26/H26).
// D26 = CZ/121.5*100+1; F26 = ceil(D26) — that is the terminal pin the policy
// states (3" for a 2" zone, 4" for a 3" one) and the value the real cards show.
// H26 = D26*2-2 is a second, unrounded figure the workbook carries alongside it;
// it is mirrored here at full precision. It used to be rounded, which turned the
// cards' 4.938271605 into 5 — an invented number matching no cell and no policy.
function terminalPin(coldZoneIn, dia = 8, material = 'steel') {
  const div = (PIN_DIVISOR[dia] || PIN_DIVISOR[8])[material] || 1.215;
  const raw = coldZoneIn / (div * 100) * 100 + 1;
  return { raw: round(raw, 6), studs: Math.ceil(raw), h26: round(raw * 2 - 2, 6) };
}

// The pin a cold zone gives, unless one was forced. `derivedStuds` keeps what
// the policy would have said, so the card and the review screen can show both.
function pinFor(coldZoneIn, forcedStuds, dia = 8, material = 'steel') {
  const derived = terminalPin(coldZoneIn, dia, material);
  if (forcedStuds == null) return { ...derived, derivedStuds: derived.studs, overridden: false };
  return { ...derived, studs: forcedStuds, derivedStuds: derived.studs, overridden: true };
}

function round(n, dp) { const f = 10 ** dp; return Math.round(n * f) / f; }

module.exports = {
  buildJobCard, chooseWire, springLengthIn,
  materialClass, tubeDrawPct, wireDrawPct, standardColdZone, perElementWattage, terminalPin, pinFor,
  TUBE_DRAW, WIRE_DRAW, SPRING_DIVISORS, TOTAL_LENGTH_ALLOWANCE_IN, ROW19_STEP_DOWN_MM, TIE_BREAK,
  WIRE_TABLES, SUPPORTED_DIAMETERS, PIN_DIVISOR, STUD, COLD_ZONE_STANDARD,
};
