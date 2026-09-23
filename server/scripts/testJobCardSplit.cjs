// Checks the 50-piece split rule and the job card numbering that goes with it.
//
//   node scripts/testJobCardSplit.cjs
const S = require('../src/lib/jobCardSplit');

const G = s => `\x1b[32m${s}\x1b[0m`, R = s => `\x1b[31m${s}\x1b[0m`;
let failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? G('pass') : R('FAIL')}  ${name}${ok ? '' : `  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};

console.log('\nSplitting a quantity into cards of at most 50');
// The owner's own two examples.
eq('100 → 50 + 50', S.splitQuantity(100), [50, 50]);
eq('120 → 50 + 50 + 20 (20 stands on its own)', S.splitQuantity(120), [50, 50, 20]);
eq('101 → 50 + 26 + 25 (no card for a single piece)', S.splitQuantity(101), [50, 26, 25]);
// Under the cap, nothing splits.
eq('1 → one card', S.splitQuantity(1), [1]);
eq('49 → one card', S.splitQuantity(49), [49]);
eq('50 → one card', S.splitQuantity(50), [50]);
// Just over the cap: 51 would leave a 1, so the pair levels instead.
eq('51 → 26 + 25', S.splitQuantity(51), [26, 25]);
eq('55 → 28 + 27', S.splitQuantity(55), [28, 27]);
eq('59 → 30 + 29', S.splitQuantity(59), [30, 29]);
eq('60 → 50 + 10 (10 is the smallest that stands alone)', S.splitQuantity(60), [50, 10]);
eq('150 → 50 + 50 + 50', S.splitQuantity(150), [50, 50, 50]);
eq('205 → 50 + 50 + 50 + 28 + 27', S.splitQuantity(205), [50, 50, 50, 28, 27]);
eq('500 → ten cards of 50', S.splitQuantity(500), Array(10).fill(50));
// Nothing to make a card from.
eq('0 → no cards', S.splitQuantity(0), []);
eq('negative → no cards', S.splitQuantity(-5), []);
eq('non-numeric → no cards', S.splitQuantity('abc'), []);
eq('fractional rounds down', S.splitQuantity(100.9), [50, 50]);

console.log('\nEvery split accounts for the whole quantity, and no card exceeds 50');
let sumBad = 0, capBad = 0, tinyBad = 0;
for (let q = 1; q <= 3000; q++) {
  const parts = S.splitQuantity(q);
  if (parts.reduce((a, b) => a + b, 0) !== q) sumBad++;
  if (parts.some(p => p > S.MAX_CARD_QTY)) capBad++;
  // A card below the floor is only allowed when the whole order is that small.
  if (q > S.MAX_CARD_QTY && parts.some(p => p < S.MIN_LAST_CARD)) tinyBad++;
}
eq('quantities 1–3000 all add back up', sumBad, 0);
eq('no card over 50', capBad, 0);
eq('no card under 10 once an order splits', tinyBad, 0);

console.log('\nNumbering');
eq('a single card keeps the plain name', S.allocateCardNumbers('PT-X', 1, new Set()), ['PT-X']);
eq('a split always suffixes', S.allocateCardNumbers('PT-X', 2, new Set()), ['PT-X-1', 'PT-X-2']);
eq('a split suffixes even when the plain name is free',
  S.allocateCardNumbers('PT-X', 3, new Set()), ['PT-X-1', 'PT-X-2', 'PT-X-3']);
eq('a single card falls back past a taken name',
  S.allocateCardNumbers('PT-X', 1, new Set(['PT-X'])), ['PT-X-2']);
eq('a second batch on the same drawing skips what is taken',
  S.allocateCardNumbers('PT-X', 2, new Set(['PT-X-1', 'PT-X-2'])), ['PT-X-3', 'PT-X-4']);
eq('gaps are reused rather than skipped',
  S.allocateCardNumbers('PT-X', 2, new Set(['PT-X-2'])), ['PT-X-1', 'PT-X-3']);
// The three schemes share this space and must not tread on each other.
eq('a partial-dispatch -P1 does not block -1',
  S.allocateCardNumbers('PT-X', 2, new Set(['PT-X-P1', 'PT-X-P2'])), ['PT-X-1', 'PT-X-2']);
eq('an -FG card does not block -1',
  S.allocateCardNumbers('PT-X', 1, new Set(['PT-X-FG'])), ['PT-X']);
eq('allocating marks the names taken as it goes', (() => {
  const taken = new Set();
  S.allocateCardNumbers('PT-X', 2, taken);
  return S.allocateCardNumbers('PT-X', 2, taken);
})(), ['PT-X-3', 'PT-X-4']);

console.log('\nDescriptions');
eq('single card', S.describeSplit([40]), '40 pcs');
eq('split', S.describeSplit([50, 26, 25]), '50 + 26 + 25 = 101 pcs');

console.log(failed ? R(`\n${failed} failure(s)`) : G('\nall split rules hold'));
process.exit(failed ? 1 : 0);
