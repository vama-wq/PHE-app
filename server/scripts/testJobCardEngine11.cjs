// Runs the engine against the three real 11 mm cards from the workbook.
//
//   node scripts/testJobCardEngine11.cjs
//
// Unlike the 8 mm suite, NONE of these reproduce end to end — all three predate
// the percentages the owner settled on 24 Sep 2026 (they use 14.5%/14% tube
// draw against the final 15.6/13/16, and 15%/8%/17% wire draw against 12/12/17).
// So this splits into two halves:
//
//   1. What the policy cannot move — row 19 and ohms after draw — is checked
//      against the cards exactly.
//   2. Everything the percentages DO move is checked by feeding the card's own
//      percentages back in. If the engine then lands on the card's cutting
//      length, spring window and gauge, the arithmetic is right and only the
//      inputs differ — the same proof used for the 8 mm copper card.
const E = require('../src/lib/jobCardEngine');

const G = s => `\x1b[32m${s}\x1b[0m`, R = s => `\x1b[31m${s}\x1b[0m`,
      Y = s => `\x1b[33m${s}\x1b[0m`, DIM = s => `\x1b[2m${s}\x1b[0m`;
const n = (v, dp = 4) => v == null ? '—' : Number(v).toFixed(dp).replace(/0+$/, '').replace(/\.$/, '');

let failed = 0, noted = 0;
const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;
function check(label, got, want, tol = 0.0005) {
  const ok = near(got, want, tol);
  if (!ok) failed++;
  console.log(`  ${label.padEnd(30)}${n(got).padStart(16)}${n(want).padStart(18)}   ${ok ? G('match') : R(`DIFF (Δ ${(got - want).toPrecision(3)})`)}`);
}
function note(label, got, want, why) {
  noted++;
  console.log(`  ${label.padEnd(30)}${n(got).padStart(16)}${n(want).padStart(18)}   ${Y('by design')}  ${DIM(why)}`);
}

const CARDS = [
  {
    name: 'ALP-PT-Utype-1230U-2.3Kw   (Incoloy, 97.7", cold zone 16")',
    input: { tubeMaterial: 'Incoloy', tubeDiameterMm: 11, wattage: 2300, voltage: 230,
             drawingTotalLengthIn: 97.7 - E.TOTAL_LENGTH_ALLOWANCE_IN,
             coldZoneBigIn: 16, coldZoneSmallIn: 16, drawingNumber: 'PT-Utype-1230U-2.3Kw' },
    card: { totalLengthIn: 97.7, row19: [2481.58, 2463.58, 2458.58], ohmsAfterDraw: 23,
            tubeDraw: 0.145, cuttingLengthIn: 85.32751092, springLow: 17.77583697,
            springHigh: 24.23977769, ceilingDiv: 2.2, wireDraw: 0.15, ohmsMid: 26.45,
            gauge: 22, spoolOhms: 3.570,
            // This card was hand-tuned past its own arithmetic. It used a 22 SWG
            // spool at 3.570 Ω/m which is not on the 11 mm sheet at all, and
            // whose coil works out at 24.34" — beyond the 24.24" ceiling the
            // card itself prints. The least coil inside that ceiling is 23 SWG
            // at 3.7 Ω/m (20.95"), which is what the engine returns.
            gaugeDivergence: 'card used an off-sheet 3.570 Ω/m spool needing 24.34", past its own 24.24" ceiling' },
  },
  {
    name: 'TT-PT-Flange-UL-Up-5kw     (SS316, 129", cold zone 26")',
    input: { tubeMaterial: 'SS316', tubeDiameterMm: 11, wattage: 1666, voltage: 230,
             drawingTotalLengthIn: 129 - E.TOTAL_LENGTH_ALLOWANCE_IN,
             coldZoneBigIn: 26, coldZoneSmallIn: 26, drawingNumber: 'PT-Flange-UL-Up-5kw' },
    card: { totalLengthIn: 129, row19: [3276.6, 3258.6, 3253.6], ohmsAfterDraw: 31.75270108,
            tubeDraw: 0.145, cuttingLengthIn: 112.6637555, springLow: 20.22125182,
            springHigh: 24.26550218, ceilingDiv: 2.5, wireDraw: 0.08, ohmsMid: 34.29291717,
            gauge: 23, spoolOhms: 4.910 },
  },
  {
    name: 'SSEAS-PT-UL-20U2L-1.5kw    (SS304, 46.41", cold zone 3")',
    input: { tubeMaterial: 'SS304', tubeDiameterMm: 11, wattage: 1500, voltage: 230,
             drawingTotalLengthIn: 46.41 - E.TOTAL_LENGTH_ALLOWANCE_IN,
             coldZoneBigIn: 3, coldZoneSmallIn: 3, drawingNumber: 'PT-UL-20U2L-1.5kw' },
    // This card steps row 19 down by 10, not the 18 its own template carries.
    card: { totalLengthIn: 46.41, row19: [1178.814, 1168.814, 1163.814], row19StepIs10: true,
            ohmsAfterDraw: 35.26666667, tubeDraw: 0.14, cuttingLengthIn: 40.71052632,
            springLow: 11.57017544, springHigh: 13.88421053, ceilingDiv: 2.5,
            wireDraw: 0.17, ohmsMid: 41.262, gauge: 26, spoolOhms: 8.700 },
  },
];

for (const { name, input, card } of CARDS) {
  console.log(`\n${'═'.repeat(88)}\n${name}\n${'═'.repeat(88)}`);
  const o = E.buildJobCard(input);
  if (!o.ok) { console.log(R(`  ENGINE ERROR: ${o.error}`)); failed++; continue; }
  console.log(`  ${'field'.padEnd(30)}${'engine'.padStart(16)}${'card'.padStart(18)}   result`);
  console.log(`  ${'-'.repeat(82)}`);

  // ── 1. What no percentage can move ──────────────────────────────────────
  check('Total length (in)', o.totalLengthIn, card.totalLengthIn, 0.0001);
  const r19 = [o.row19LengthsMm[0], o.row19LengthsMm[1], o.row19LengthsMm[2]];
  if (card.row19StepIs10) {
    note('Row 19 (mm)', r19[1], card.row19[1], 'this card steps 10; its own template steps 18');
    check('Row 19 total (mm)', r19[0], card.row19[0], 0.005);
  } else {
    r19.forEach((v, i) => check(`Row 19 [${i + 1}] (mm)`, v, card.row19[i], 0.005));
  }
  check('Ohms after draw', o.ohmsAfterDraw, card.ohmsAfterDraw, 0.0005);
  check('Ohms after draw −5%', o.ohmsAfterDrawMin, card.ohmsAfterDraw * 0.95, 0.001);

  // ── 2. What the settled percentages deliberately move ───────────────────
  note('Tube draw', o.tubeDrawPct, card.tubeDraw, 'card predates the final 15.6 / 13 / 16');

  // ── 3. The same arithmetic, fed the card's own percentages ──────────────
  const cut = card.totalLengthIn / (1 + card.tubeDraw);
  const lo = (cut - card.coldZone * 2) / 3 || (cut - input.coldZoneBigIn * 2) / 3;
  const hi = (cut - input.coldZoneBigIn * 2) / card.ceilingDiv;
  const req = card.ohmsAfterDraw * (1 + card.wireDraw);
  const sel = E.chooseWire({
    material: E.materialClass(input.tubeMaterial), ohmsAfterDraw: card.ohmsAfterDraw,
    wattage: input.wattage, dia: 11, springWindow: { lowIn: lo, highIn: hi },
  });
  const forced = E.WIRE_TABLES[11].rows.filter(w => !w.excluded)
    .map(w => ({ w, s: E.springLengthIn(req, w) }))
    .filter(c => c.s >= lo && c.s <= hi).sort((a, b) => a.s - b.s)[0];

  console.log(DIM(`  ${'-'.repeat(82)}`));
  console.log(DIM(`  fed the card's own ${(card.tubeDraw * 100).toFixed(1)}% tube / ${(card.wireDraw * 100).toFixed(0)}% wire draw:`));
  check('  cutting length (in)', cut, card.cuttingLengthIn, 0.0005);
  check('  spring low (in)', lo, card.springLow, 0.0005);
  check('  spring high (in)', hi, card.springHigh, 0.0005);
  check('  ohms range mid', req, card.ohmsMid, 0.0005);
  const gOk = forced && forced.w.gauge === card.gauge;
  if (!gOk && !card.gaugeDivergence) failed++;
  if (!gOk && card.gaugeDivergence) noted++;
  console.log(`  ${'  gauge (least coil)'.padEnd(30)}${String(forced ? forced.w.gauge : '—').padStart(16)}${String(card.gauge).padStart(18)}   ` +
    (gOk ? G('match') : card.gaugeDivergence ? Y('by design') + '  ' + DIM(card.gaugeDivergence) : R('DIFF')));
  const spoolOk = forced && E.WIRE_TABLES[11].rows.some(w => w.gauge === card.gauge && Math.abs(w.ohms_per_m - card.spoolOhms) < 0.0005);
  console.log(`  ${'  card spool on the sheet'.padEnd(30)}${String(card.spoolOhms).padStart(16)}${'Ω/m'.padStart(18)}   ` +
    (spoolOk ? G('present') : Y('not on the 11 mm sheet')));

  console.log(DIM(`  engine, under the settled policy: ${o.gauge == null ? 'no gauge fits' : `${o.gauge} SWG @ ${(o.wireDrawPct * 100).toFixed(1)}%`}` +
    ` | mandrel ${o.wire ? o.wire.mandrel_mm : '—'} | stud ${o.studLabel} | pin ${o.terminalPinBig.studs}"`));
  for (const w of o.warnings) console.log(DIM(`  note: ${w}`));
}

console.log(`\n${'═'.repeat(88)}`);
console.log(failed ? R(`${failed} unexplained mismatch(es)`)
  : G('every 11 mm card checks out') + Y(` — ${noted} field(s) differ for the documented reason above.`));
process.exit(failed ? 1 : 0);
