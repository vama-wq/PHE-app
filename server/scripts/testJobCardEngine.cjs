// Runs the job card engine against the three real 8 mm cards from the workbook
// and prints computed vs actual side by side.
//
//   node scripts/testJobCardEngine.cjs
//
// Actuals are the values in the Excel cells of cards that were built and, for
// two of them, dispatched. A mismatch means either the engine is wrong or the
// card was — both worth knowing, so nothing here is fudged to make it pass.
const E = require('../src/lib/jobCardEngine');

// drawingTotalLengthIn is back-computed as the card's F19 minus the 0.7"
// the policy adds, since the drawings themselves aren't in the workbook.
const CARDS = [
  {
    name: 'BPE-PT-FlameProof-550U  (SS304, 3in1, cold zone overridden to 3")',
    input: {
      tubeMaterial: 'SS304', wattage: 9000, voltage: 230,
      drawingTotalLengthIn: 46.3 - 0.7,
      drawingNumber: 'PT-FlameProof-550U-9Kw-3in1', productCode: 'PT-FlameProof',
      coldZoneBigIn: 3, coldZoneSmallIn: 3,
    },
    actual: {
      wattage: 3000, totalLengthIn: 46.3, tubeDrawPct: 0.197, cuttingLengthIn: 38.68003342,
      ohmsAfterDraw: 17.63333333, springWindowLowIn: 10.89334447, springWindowHighIn: 14.85456064,
      gauge: 23, wireDrawPct: 0.23, ohmsRangeMid: 21.689,
      ohmsRangeMin: 21.47211, ohmsRangeMax: 21.90589,
      terminalPinStuds: 4, spoolOhmsPerM: 4.97,
      row19LengthsMm: [1176.02, 1166.02, 1161.02],
    },
  },
  {
    name: 'QM-PT-USpiral-Upside-75  (SS304, single, 56" so CZ 3" standard)',
    input: {
      tubeMaterial: 'SS304', wattage: 750, voltage: 230,
      drawingTotalLengthIn: 56.08 - 0.7,
      drawingNumber: 'QM-PT-USpiral-Upside-75', productCode: 'PT-USpiral',
    },
    actual: {
      wattage: 750, totalLengthIn: 56.08, tubeDrawPct: 0.19, cuttingLengthIn: 47.12605042,
      ohmsAfterDraw: 70.53333333, springWindowLowIn: 13.70868347, springWindowHighIn: 18.69365928,
      gauge: 28, wireDrawPct: 0.31, ohmsRangeMid: 92.39866667,
      ohmsRangeMin: 91.47468, ohmsRangeMax: 93.32265333,
      terminalPinStuds: 4, spoolOhmsPerM: 12.79,
      row19LengthsMm: [1424.432, 1414.432, 1409.432],
    },
  },
  {
    name: 'TSS-PT-Utype-10U-400W  (Copper, 21.2", CZ 2" standard)',
    input: {
      tubeMaterial: 'Copper', wattage: 400, voltage: 230,
      drawingTotalLengthIn: 21.2 - 0.7,
      drawingNumber: 'PT-Utype-10U-400W', productCode: 'PT-UType',
    },
    actual: {
      wattage: 400, totalLengthIn: 21.2, tubeDrawPct: 0.23, cuttingLengthIn: 17.23577236,
      ohmsAfterDraw: 132.25, springWindowLowIn: 5.294308943, springWindowHighIn: 6.617886179,
      gauge: 34, wireDrawPct: 0.24, ohmsRangeMid: 163.99,
      ohmsRangeMin: 162.3501, ohmsRangeMax: 165.6299,
      terminalPinStuds: 3, spoolOhmsPerM: 31.2,
      // That card printed 538.48 / 520.48 / 515.48 — it used -18 where the rule is
      // -10. Owner confirmed 22 Sep 2026 the rule is fixed, so the card was wrong.
      row19LengthsMm: [538.48, 528.48, 523.48],
    },
    // SUPERSEDED, not a defect. This card was built 23.07.26 on a 24% wire draw;
    // the owner confirmed on 22 Sep 2026 that the current policy's 29% is correct
    // and this card is simply old. The engine follows the policy and lands on
    // 36 SWG @ 29%. The card stays in the suite because forcing its own 24% still
    // reproduces it exactly — which is what proves the divergence is the input
    // percentage alone and not the arithmetic underneath it.
    knownDivergence: {
      fields: ['gauge', 'wireDrawPct', 'ohmsRangeMid', 'ohmsRangeMin', 'ohmsRangeMax'],
      why: 'card predates the current policy (built on 24% wire draw; policy says 29% for copper at 30 SWG and above). Owner confirmed 22 Sep 2026 that 29% is correct',
      rerunWithOverride: 0.24,
    },
  },
];

const FIELDS = [
  ['wattage', 'Wattage per element (W)', 0.001],
  ['totalLengthIn', 'Total length (in)', 0.0001],
  ['tubeDrawPct', 'Tube draw %', 0.0000001],
  ['cuttingLengthIn', 'Tube cutting length (in)', 0.0005],
  ['ohmsAfterDraw', 'Ohms after draw', 0.0005],
  ['springWindowLowIn', 'Spring window low (in)', 0.0005],
  ['springWindowHighIn', 'Spring window high (in)', 0.0005],
  ['gauge', 'WIRE GAUGE (SWG)', 0],
  ['wireDrawPct', 'Wire draw %', 0.0000001],
  ['ohmsRangeMid', 'Ohms range mid', 0.0005],
  ['ohmsRangeMin', 'Ohms range min (-1%)', 0.0005],
  ['ohmsRangeMax', 'Ohms range max (+1%)', 0.0005],
];

const Y = s => `\x1b[33m${s}\x1b[0m`;
const G = s => `\x1b[32m${s}\x1b[0m`, R = s => `\x1b[31m${s}\x1b[0m`, DIM = s => `\x1b[2m${s}\x1b[0m`;
const fmt = v => v == null ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')) : String(v);

let failures = 0, divergences = 0;
for (const card of CARDS) {
  console.log(`\n${'═'.repeat(88)}\n${card.name}\n${'═'.repeat(88)}`);
  const out = E.buildJobCard(card.input);
  if (!out.ok) { console.log(R(`  ENGINE ERROR: ${out.error}`)); failures++; continue; }

  console.log(`  ${'field'.padEnd(30)}${'computed'.padStart(16)}${'actual card'.padStart(18)}   result`);
  console.log(`  ${'-'.repeat(82)}`);
  for (const [key, label, tol] of FIELDS) {
    const got = out[key], want = card.actual[key];
    const ok = got != null && want != null && Math.abs(got - want) <= tol;
    const expected = card.knownDivergence && card.knownDivergence.fields.includes(key);
    if (!ok && !expected) failures++;
    if (!ok && expected) divergences++;
    const line = `  ${label.padEnd(30)}${fmt(got).padStart(16)}${fmt(want).padStart(18)}   `;
    console.log(line + (ok ? G('match')
      : expected ? Y(`differs by design  (Δ ${(got - want).toPrecision(3)})`)
      : R(`DIFF  (${got == null ? 'nothing computed' : 'Δ ' + (got - want).toPrecision(3)})`)));
  }

  const r19 = out.row19LengthsMm, w19 = card.actual.row19LengthsMm;
  const r19ok = w19.every((v, i) => Math.abs(r19[i] - v) <= 0.005);
  if (!r19ok) failures++;
  console.log(`  ${'Row 19 lengths (mm)'.padEnd(30)}${r19.join('/').padStart(16)} ${w19.join('/').padStart(17)}   ` + (r19ok ? G('match') : R('DIFF')));

  const studs = out.terminalPinBig.studs;
  const sOk = studs === card.actual.terminalPinStuds;
  if (!sOk) failures++;
  console.log(`  ${'Terminal pin studs'.padEnd(30)}${String(studs).padStart(16)}${String(card.actual.terminalPinStuds).padStart(18)}   ` + (sOk ? G('match') : R('DIFF')));

  // The spool is live stock: the engine only has to offer the right gauge and
  // put the card's actual spool among the choices when it is still on the sheet.
  const spools = out.spoolOptions || [];
  const exact = spools.some(s => Math.abs(s.ohms_per_m - card.actual.spoolOhmsPerM) < 0.0005);
  const near = spools.length
    ? spools.reduce((a, b) => Math.abs(b.ohms_per_m - card.actual.spoolOhmsPerM) < Math.abs(a.ohms_per_m - card.actual.spoolOhmsPerM) ? b : a)
    : null;
  console.log(`  ${'Card spool offered'.padEnd(30)}${(spools.length + ' spools').padStart(16)}${(card.actual.spoolOhmsPerM + ' Ω/m').padStart(18)}   ` +
    (exact ? G('on the sheet') : near ? Y(`not on sheet; nearest ${near.ohms_per_m} Ω/m`) : R('no spool of this gauge')));
  if (!spools.length) failures++;

  console.log(DIM(`  gauge resolution: ${out.gaugeResolution}` +
    (out.gaugeAlternatives.length ? ` | also self-consistent: ${out.gaugeAlternatives.map(a => `${a.gauge} SWG @ ${(a.wireDrawPct * 100).toFixed(1)}%`).join(', ')}` : '') +
    (out.wire ? ` | picked spool ${out.wire.ohms_per_m} Ω/m, mandrel ${out.wire.mandrel_mm}, spring ${out.springLengthIn}"` : '')));
  for (const w of out.warnings) console.log(DIM(`  note: ${w}`));

  const kd = card.knownDivergence;
  if (kd) {
    console.log(Y(`\n  KNOWN DIVERGENCE — ${kd.why}.`));
    const re = E.buildJobCard({ ...card.input, wireDrawPctOverride: kd.rerunWithOverride });
    const same = re.gauge === card.actual.gauge && Math.abs(re.ohmsRangeMid - card.actual.ohmsRangeMid) < 0.0005;
    console.log(`  Re-run forcing the card's own ${(kd.rerunWithOverride * 100).toFixed(0)}%: ` +
      `${re.gauge} SWG, ohms ${fmt(re.ohmsRangeMid)} ` +
      (same ? G('— reproduces the card exactly, so only the percentage is in question.')
            : R('— still does not match the card; the arithmetic needs another look.')));
    if (!same) failures++;
  }
}

console.log(`\n${'═'.repeat(88)}`);
const clean = CARDS.length - CARDS.filter(c => c.knownDivergence).length;
console.log(failures ? R(`${failures} unexplained mismatch(es) against the real cards`)
  : G(`${clean} of ${CARDS.length} cards reproduced exactly`) +
    (divergences ? Y(`; ${divergences} field(s) diverge for the documented reason above.`) : '.'));
process.exit(failures ? 1 : 0);
