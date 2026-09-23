// CLI over src/lib/jobCardRender.js, for producing a card outside the app.
//
//   node scripts/renderJobCard.cjs <out.html> [card.json]
//
// card.json is { input, head|sheets, provenance? } — `input` goes to
// buildJobCard, the heads carry what the order already holds. With no file the
// BPE flameproof card is rendered as the worked example.
const E = require('../src/lib/jobCardEngine');
const { render, n } = require('../src/lib/jobCardRender');

if (require.main === module) {
  // node scripts/renderJobCard.cjs <out.html> [card.json]
  // card.json is { input, head, provenance? } — `input` goes to buildJobCard,
  // `head` carries the fields the order already holds. With no file, the BPE
  // flameproof card is rendered as the worked example.
  const [outArg, specArg] = process.argv.slice(2);
  const spec = specArg
    ? JSON.parse(require('fs').readFileSync(specArg, 'utf8'))
    : require('./sampleCardBPE.json');

  const card = E.buildJobCard(spec.input);
  if (!card.ok) { console.error(card.error); process.exit(1); }
  // `sheets` is the batch; `head` alone is still accepted for a single card.
  const heads = spec.sheets && spec.sheets.length ? spec.sheets : [spec.head];
  card.tubeMaterialLabel = heads[0].tubeMaterialLabel || spec.input.tubeMaterial;

  // Provenance is written per card, since what was asked and what was derived
  // differs from one to the next.
  const provenance = spec.provenance || [
    ['From the order', 'Order no, client code, order date, product code, drawing no, punching, quantity, tube material, plating, remark'],
    ['Asked when making the card', 'ASMBLY, fixture type, dispatch date, total length off the drawing'],
    ['Total length', `${spec.input.drawingTotalLengthIn}" on the drawing + 0.7" allowance = ${n(card.totalLengthIn, 1)}"`],
    ['Tube draw', `${(card.tubeDrawPct * 100).toFixed(1)}% — ${card.material === 'copper' ? 'copper' : 'SS'} at ${n(card.totalLengthIn, 1)}"`],
    ['Wire gauge', card.gauge == null ? 'no wire in the table fits — choose by hand'
      : `${card.gauge} SWG at ${(card.wireDrawPct * 100).toFixed(1)}% wire draw, ${card.gaugeResolution === 'unique' ? 'the only self-consistent answer' : 'the coarsest of several'}; ${card.spoolOptions.length} spools of it fit the spring window`],
    ['Cold zone', card.coldZoneBigIn === E.standardColdZone(card.totalLengthIn).coldZoneIn
      ? `${card.coldZoneBigIn}" — the standard for a ${n(card.totalLengthIn, 1)}" element`
      : `${card.coldZoneBigIn}" set by hand; the standard here is ${E.standardColdZone(card.totalLengthIn).coldZoneIn}"`],
    ['Terminal pin', `ceil(${card.coldZoneBigIn} ÷ 1.215 + 1) = ${card.terminalPinBig.studs}"`],
    ['Ohms after draw', `${card.voltage}² ÷ ${n(card.wattage, 0)} = ${card.ohmsAfterDraw} Ω, ±5%`],
  ];

  const out = outArg || 'jobcard.html';
  // Fragment form: these samples go to the Artifact tool, which supplies
  // the document skeleton itself.
  require('fs').writeFileSync(out, render(card, heads, provenance, { standalone: false }));
  console.log(`${out} — ${heads.length} sheet(s), ${card.gauge == null ? 'NO GAUGE' : `${card.gauge} SWG @ ${(card.wireDrawPct * 100).toFixed(0)}%`}, ohms ${card.ohmsRangeMid}, ${card.warnings.length} warning(s)`);
}
