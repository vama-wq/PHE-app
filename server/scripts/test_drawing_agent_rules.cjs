// Offline test of the drawing agent's rules (lib/drawings/uRules.js; owner,
// 14 Nov 2026). No database, no network. Ported from the Mac agent's
// test_rules.cjs, with the owner's ruling R1: the total length is 2 × U
// (18U → 36", the U drawn as it comes out of that tube, ≈ 451.2 mm on Ø8).
// The checks against her whole history (198 U items, 46 app-made U cards) run
// when the Mac agent's read-only fixtures are on this computer, and are
// skipped otherwise.
//   node scripts/test_drawing_agent_rules.cjs [--verbose]
const fs = require('fs');
const path = require('path');
const S = path.join(__dirname, '..');
const R = require(S + '/src/lib/drawings/uRules.js');
const { deriveUShape, uLengthForCentreline, renderUTypeSheet } = require(S + '/src/lib/drawings/uTypeSheet.js');
const E = require(S + '/src/lib/jobCardEngine.js');
const FIX = '/Users/vamashah/Desktop/Clients - AHM/phe-claude-code/data/drawings/fixtures';
const VERBOSE = process.argv.includes('--verbose');

let failed = 0;
const ok = (label, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${String(extra).slice(0, 400)}` : ''}`); if (!cond) failed++; };
const info = (s) => console.log(`      ${s}`);

// 20 approved PHE U drawings measured by hand (14 Nov 2026): item, U length mm,
// outside width mm, tube mm, TOTAL LENGTH printed on the drawing (in).
const MEASURED = [[5, 1219.2, 43, 8, 96.47], [12, 381, 43, 8, 30.47], [19, 177.8, 40, 8, 14.4], [52, 609.6, 43, 8, 48.47], [80, 457, 43, 8, 36.45],
  [88, 475, 49, 11, 37.82], [93, 304.8, 64, 11, 24.75], [95, 203.2, 64, 11, 16.75], [134, 754, 44.5, 8, 59.87], [135, 400, 44.5, 8, 32.06],
  [182, 406.4, 49, 11, 32.42], [192, 482.6, 43, 8, 38.47], [233, 533.4, 43, 8, 42.47], [236, 254, 43, 8, 20.47], [279, 1727.2, 49, 11, 136.42],
  [280, 533.4, 49, 11, 42.49], [283, 381, 43, 8, 30.47], [1838, 254, 43, 8, 20.47], [2186, 914.4, 43, 8, 72.47], [2215, 1117.6, 43, 8, 88.47]];
// The 56 distinct U-family remark texts in the app on 14 Nov 2026 (normalised).
const REMARKS = ['NUT WASHER + 2 CLAMPS', 'NUT WASHER+ 2 CLAMPS', 'M12 BRASS NIPPLE', 'M6 HEAVY TERMINAL PIN', 'URGENT DISPATCH- 4" COLD ZONE', 'NUT WASHER',
  'M12 NIPPLE BRASS', 'BUFFING', '4" COLD ZONE / NUT WASHER', 'WITH BRACKETS / NUT WASHER / 7" COLD SIDE BEND', 'M12 BRASS NIPPLE / ABOVE NIPPLE LENGTH TO BE 9" LIKE LAST TIME',
  'WITH CLAMPS', 'TERMINAL PIN 20" LONG / M12 NIPPLE', 'M16 BRASS NIPPLE', 'WITH HEAVY TERMINAL AND BRACKETS', 'HEAVY TERMINAL', 'M12 BRASS NIPPLE 75MM COLD ZONE',
  'ONE CERAMIC + ONE NUT', 'FINS + CLAMPS', 'NUT WASHER / 6" COLD ZONE', '3" COLD ZONE NUT WASHER', 'CLAMPS ++ FINS', 'CLAMPS + FINS',
  'SS FINS WITH 2 CLAMPS / 190 MM ,,VALA COLD ZONE / WITH NIPPLE', 'FINS + HEAVY TERMINAL PIN', 'HEAVY TERMINAL PIN',
  'STEATITE CERAMIC MALE FEMALE BUSH, CRIMP BUSH, FABRICATE THE OUTER BODY', 'MS FINS + BRACKETS', 'M12 BRASS NIPPLE - WITHOUT GROVE',
  'M16 BRASS NIPPLE WITH SS FINS- 24U ABOVE NIPPLE', 'HEAVY TERMINAL PIN / 8" COLD ZONE', '8" COLD ZONE / NUT WASHER', 'ONE NUT + ONE CERAMIC',
  '3" COLD ZONE / STUD LENGTH OUTSIDE HEATER 1"', 'CLAMPS', '12" HOT + 8" COLD. 8" STUD / TERMINAL OUTSIDE HEATER TUBE 20 TO 22MM/ TOTAL LENGTH 38.5"',
  '380MM COLD ZONE / NUT WASHER', 'M16 BRASS NIPPLE / 25 GEJ / SS FINS', 'M16 BRASS NIPPLE / 26 GEJ / SS FINS', 'WITH MS CLAMPS', 'MS FINS', 'SS FINS, NUT WASHER',
  '5" COLD ZONE, NUT WASHER', 'NUT WASHER / MS BRACKETS', 'NUT WASHER + MS CLAMPS', 'NUT WASHER 7" COLD ZONE', 'NUT WASHER, 7" COLD ZONE', 'MS FINS + NUT WASHER',
  'ONE CERAMIC+ONE NUT', 'M12 BRASS NIPPLE+ ONE CERAMIC+ONE NUT', 'M12 BRASS NIPPLE + ONE CERAMIC + ONE NUT', 'TAKEN FOR 17U ORDER AS 1 NOS WAS LESS',
  '6" COLD ZONE / STUD LENGTH OUTSIDE HEATER 1", NUT WASHER', 'HEAVY TERMINAL PIN, 350 DEGREE ORDER', 'M12 BRASS NIPPLE, ONE CERAMIC+ONE NUT',
  'NUT WASHER, TRIM THE HEATER TO 7U HEATER'];

// ── 1. Shape and the total length (ruling R1: 2 × U) ──
{
  // Two of design's own sheets print a figure the geometry does not give; every
  // other U drawing of the same width agrees with the geometry.
  const KNOWN = { 135: 'PT-UType-400mm-1Kw (44.5 wide): sheet says 32.06, the shape gives 32.00', 280: 'PT-UType-21U-1KW Ø11: sheet says 42.49, the other Ø11 / 49-wide sheets agree with the shape' };
  const bad = [], known = [];
  for (const [item, L, W, d, total] of MEASURED) {
    const g = deriveUShape({ uLengthMm: L, outsideWidthMm: W, tubeDiaMm: d });
    if (Math.abs(g.drawingTotalIn - total) < 0.005) continue;
    (KNOWN[item] ? known : bad).push(`${item}: ${g.drawingTotalIn} vs ${total}`);
  }
  ok(`1a. the shape (deriveUShape) equals ${MEASURED.length - 2} of the ${MEASURED.length} measured drawings to the hundredth (2 known design typos)`, bad.length === 0 && known.length === 2, bad.join('; '));
  const t18 = R.totalLength({ uIn: 18, diaMm: 8 });
  ok('1b. R1: 18U on Ø8 → total length "36" (not 36.47); the U is drawn 451.2 mm end to end; the tube is 914.4 mm along its centreline',
    t18.str === '36' && R.round(t18.drawnULengthMm, 1) === 451.2 && Math.abs(t18.geo.clMm - 914.4) < 1e-6 && t18.geo.drawingTotalIn === 36,
    `${t18.str} · ${R.round(t18.drawnULengthMm, 2)} · ${R.round(t18.geo.clMm, 3)}`);
  const t21 = R.totalLength({ uIn: 21, diaMm: 11 });
  const t187 = R.totalLength({ uIn: 18.7, diaMm: 8 });
  const t36 = R.totalLength({ uIn: 36, diaMm: 8 });
  ok('1c. R1: 21U Ø11 → "42" (49 outside), 18.7U → "37.4", 36U → "72" (design drew 72.47 for item 2186)',
    t21.str === '42' && Math.abs(t21.geo.clMm - 42 * 25.4) < 1e-6 && t21.geo.insideMm === 27 && t187.str === '37.4' && t36.str === '72',
    `${t21.str} ${t187.str} ${t36.str}`);
  const off = [];
  for (let u = 5; u <= 99; u += 0.5) for (const d of [8, 11]) {
    const t = R.totalLength({ uIn: u, diaMm: d });
    if (t.str !== String(2 * u) || t.geo.drawingTotalIn !== 2 * u || !(t.drawnULengthMm < u * 25.4)) off.push(`${u}U Ø${d}: ${t.str} / ${t.geo.drawingTotalIn}`);
  }
  ok('1d. for every U from 5 to 99 (half inches) on Ø8 and Ø11 the total is exactly 2U, the drawn shape measures 2U, and the drawn U is a little short of its label', off.length === 0, off.slice(0, 5).join('; '));
  const short8 = 18 * 25.4 - t18.drawnULengthMm, short11 = 21 * 25.4 - t21.drawnULengthMm;
  ok('1e. the bend takes (π/2 − 1)·R − d/2 off each leg: 6.0 mm on Ø8 / 43 outside, 5.3 mm on Ø11 / 49 outside',
    R.round(short8, 1) === 6.0 && R.round(short11, 1) === 5.3 && Math.abs(short8 - ((Math.PI / 2 - 1) * 17.5 - 4)) < 1e-9 && Math.abs(short11 - ((Math.PI / 2 - 1) * 19 - 5.5)) < 1e-9,
    `${R.round(short8, 2)} ${R.round(short11, 2)}`);
  const inv = uLengthForCentreline({ clMm: 914.4, outsideWidthMm: 43, tubeDiaMm: 8 });
  ok('1f. uLengthForCentreline is the inverse of deriveUShape', Math.abs(deriveUShape({ uLengthMm: inv, outsideWidthMm: 43, tubeDiaMm: 8 }).clMm - 914.4) < 1e-9);
}

// ── 2. Labels and drawing numbers ──
{
  const samples = [['PT-Utype-12"U-500W', 12], ['PT-UType-18.7U-900W', 18.7], ['PT-UtypeHE-8U-500W', 8], ['PT-UType-44U -1.25kw', 44], ['PT-Utype-16"U 750W', 16],
    ['PT-UType-12"U-COP-1.5KW - 2', 12], ['PT-UType-18U-700W', 18], ['PT-UType-36U-1.5Kw', 36]];
  const badS = samples.filter(([dn, u]) => { const p = R.parseULabel(dn, 'PT-UType'); return !p.ok || p.uIn !== u; });
  ok('2a. inch marks, decimals, the HE prefix, spaces and a spaced repeat suffix all read as plain U', badS.length === 0, badS.map(s => s[0]).join(', '));
  const outs = [['PT-UType-1238U-1.75Kw', 'PT-UType'], ['PT-ULType-44U7L-1.75Kw', 'PT-ULType'], ['PT-QU-12U3Q-1Kw', 'PT-QU'], ['PT_Utype-Bank450-1.1kw', 'PT-UType'],
    ['PT-UType-800mm-1.25Kw', 'PT-UType'], ['PT-UType-10U-500W-FINNS', 'PT-UType'], ['PT-UType-30U-12Kw-3in1', 'PT-UType'], ['PT-FlangeHe-30U-12Kw', 'PT-FlangeHe'], ['PT-QUL-3.5KW', 'PT-QUL']];
  const inScope = outs.filter(([dn, pc]) => R.parseULabel(dn, pc).ok);
  ok('2b. 1238U (mm), UL, QU, Bank, mm, fins, 3in1, flange and QUL are out of phase 1', inScope.length === 0, inScope.map(s => s[0]).join(', '));
  ok('2c. normalising: "PT-UType-12"U-COP-1.5KW - 2" = "PT-Utype-12U-1.5KW"; "PT-U TYPE-16U-750W" = "PT-UType-16U-750W"; -INC / -PLAIN ignored',
    R.normaliseDwgNo('PT-UType-12"U-COP-1.5KW - 2') === R.normaliseDwgNo('PT-Utype-12U-1.5KW')
    && R.normaliseDwgNo('PT-U TYPE-16U-750W') === R.normaliseDwgNo('PT-UType-16U-750W')
    && R.normaliseDwgNo('PT-UType-24U-750w-INC') === R.normaliseDwgNo('PT-UType-24U-750W')
    && R.normaliseDwgNo('PT-Utype-10U-500W-Plain') === R.normaliseDwgNo('PT_Utype-10U-500W')
    && R.normaliseDwgNo('PT-UType-18U-1KW') !== R.normaliseDwgNo('PT-UType-18U-1.5KW'));
}

// ── 3. Remarks ──
{
  const got = Object.fromEntries(REMARKS.map(t => [t, R.parseRemark(t)]));
  const EXPECT_CZ = { '3" COLD ZONE': 3, '5" COLD ZONE, NUT WASHER': 5, '4" COLD ZONE / NUT WASHER': 4, 'URGENT DISPATCH- 4" COLD ZONE': 4, 'NUT WASHER / 6" COLD ZONE': 6,
    'NUT WASHER 7" COLD ZONE': 7, '8" COLD ZONE / NUT WASHER': 8, '380MM COLD ZONE / NUT WASHER': 15, 'M12 BRASS NIPPLE 75MM COLD ZONE': 3, 'HEAVY TERMINAL PIN / 8" COLD ZONE': 8 };
  const bad = [];
  for (const t of REMARKS) {
    const want = Object.entries(EXPECT_CZ).find(([k]) => t.startsWith(k))?.[1];
    if (want != null && got[t].coldZoneIn !== want && !got[t].instructions.length) bad.push(`${t}: ${got[t].coldZoneIn} (want ${want})`);
  }
  const inch = new Set(REMARKS.flatMap(t => got[t].coldZones.filter(c => c.unit === 'in').map(c => c.in)));
  ok('3a. inch cold zones 3/4/5/6/7/8" all read', [3, 4, 5, 6, 7, 8].every(x => inch.has(x)), [...inch].join(', '));
  const mm = REMARKS.flatMap(t => got[t].coldZones.filter(c => c.unit === 'mm').map(c => `${c.text} → ${c.in}"`));
  ok('3b. mm cold zones 75 / 190 / 380 mm convert to inches at 1 decimal (3.0 / 7.5 / 15.0)',
    mm.some(s => /^75MM.*→ 3"$/.test(s)) && mm.some(s => /^190.*→ 7.5"$/.test(s)) && mm.some(s => /^380MM.*→ 15"$/.test(s)), mm.join(' · '));
  ok('3c. every remark with a known cold zone reads it (or flags it as an instruction)', bad.length === 0, bad.join('; '));
  const bend = R.parseRemark('WITH BRACKETS / NUT WASHER / 7" COLD SIDE BEND');
  ok('3d. "7" COLD SIDE BEND" is a bend instruction, not a cold zone', bend.coldZoneIn == null && bend.instructions.some(i => i.kind === 'bend'), JSON.stringify(bend.instructions));
  const hot = R.parseRemark('12" HOT + 8" COLD. 8" STUD');
  ok('3e. "12" HOT + 8" COLD. 8" STUD" is asked (hot + cold, stud), never a silent cold zone',
    hot.coldZoneIn == null && hot.instructions.some(i => i.kind === 'hot + cold') && hot.instructions.some(i => i.kind === 'stud / pin length'), JSON.stringify(hot.instructions));
  const others = [['NUT WASHER, TRIM THE HEATER TO 7U HEATER', 'trim'], ['M12 BRASS NIPPLE / ABOVE NIPPLE LENGTH TO BE 9" LIKE LAST TIME', 'like last time'],
    ['TERMINAL OUTSIDE HEATER TUBE 20 TO 22MM / TOTAL LENGTH 38.5"', 'total length stated'], ['TERMINAL PIN 20" LONG / M12 NIPPLLE', 'stud / pin length'],
    ['M12 BRASS NIPPLE, CHECK PRESSURE', 'pressure'], ['NUT WASHER, 40 MM CENTRES', 'width / pitch']];
  const missI = others.filter(([t, k]) => !R.parseRemark(t).instructions.some(i => i.kind === k));
  ok('3f. trim, "like last time", total length, pin length, pressure and width are instructions she is asked about', missI.length === 0, missI.map(m => m[0]).join('; '));
  const stud = R.parseRemark('6" cold zone / Stud length outside heater 1”, Nut Washer');
  ok('3g. "Stud length outside heater 1”" (curly quote) is the stud-outside rule, not an instruction', stud.studOutside && stud.coldZoneIn === 6 && !stud.instructions.length, JSON.stringify(stud));
  ok('3h. ceramic + nut / ceramic only / nut washer / heavy / clamps / nipple read from their usual wordings',
    R.fittingSetFor(R.parseRemark('ONE NUT + ONE CERAMICS'), [], 1).set === 'ceramic_nut'
    && R.fittingSetFor(R.parseRemark('One Ceramic only'), [], 1).set === 'ceramic_only'
    && R.fittingSetFor(R.parseRemark('NUTE WASHER'), [], 1).set === 'nut_washer'
    && R.fittingSetFor(R.parseRemark('M6 HEAVY TERMINAL PIN'), [], 1).set === 'heavy_pin'
    && R.fittingSetFor(R.parseRemark('NUT WASHER + 2 CLAMPS'), [], 1).set === 'nut_washer_brackets'
    && R.fittingSetFor(R.parseRemark('WITH MS CLAMPS'), [], 1).set === 'nut_washer_brackets'
    && R.fittingSetFor(R.parseRemark('M16 BRASS NIPPLE'), [], 1).nipple === 'M16'
    && R.fittingSetFor(R.parseRemark('M12 BRASS NIPPLE + ONE CERAMIC + ONE NUT'), [], 1).set === 'nipple_ceramic_nut');
  const fromList = R.fittingSetFor(R.parseRemark('URGENT DISPATCH'), [{ code: 'ESB-08', qty: 20 }, { code: 'NUT-SS-M4-08', qty: 40 }, { code: 'WSH-BR-08', qty: 40 }], 10);
  ok('3i. no fitting word in the remark: the list decides (4 nuts + 4 washers per heater = nut washer)', fromList.set === 'nut_washer' && fromList.from === 'list', JSON.stringify(fromList));
  const mism = R.fittingSetFor(R.parseRemark('NUT WASHER'), [{ code: 'ESB-08', qty: 20 }, { code: 'NUT-SS-M4-08', qty: 20 }], 10);
  ok('3j. a list that does not match the remark is noted, not changed (nut washer with 2 nuts and no washers)', mism.set === 'nut_washer' && mism.notes.length >= 2, mism.notes.join('; '));
  ok('3k. nut washer is the only fitting order she has ruled: ESB → SS nut → washer → washer → SS nut',
    Object.keys(R.RULED_SETS).join() === 'nut_washer' && R.FITTING_ORDER.nut_washer.join(' → ') === 'ESB → SS nut → washer → washer → SS nut'
    && Object.keys(R.SET_LABEL).every(k => R.FITTING_ORDER[k]?.length));
  // Words no rule reads are asked about (review, 14 Nov 2026): a remark only
  // ever fills a default or raises a question.
  const other = (t) => R.parseRemark(t).instructions.find(i => i.kind === 'other')?.text || null;
  const UNREAD = { 'Nut Washer, lead wire 12 inch': 'LEAD WIRE 12 INCH', 'Nut Washer with thermostat': 'THERMOSTAT', 'Nut washer + 1 inch BSP flange': '1 INCH BSP FLANGE',
    'nut washer silicone sleeve 300mm': 'SILICONE SLEEVE 300 MM', 'Nut Washer + Earthing': 'EARTHING', 'Buffing': 'BUFFING', 'Urgent Dispatch': 'URGENT DISPATCH', 'NUT WASHER M6': 'M6' };
  const missU = Object.entries(UNREAD).filter(([t, want]) => other(t) !== want).map(([t, want]) => `${t}: ${other(t)} (want ${want})`);
  const QUIET = ['NUT WASHER', 'NUT WASHER + 2 CLAMPS', 'M 12 brass nipple', '6" cold zone / Stud length outside heater 1”, Nut Washer', 'M6 HEAVY TERMINAL PIN',
    '190 MM ,,VALA COLD ZONE / WITH NIPPLE', 'ONE NUT + ONE CERAMICS', 'WITH HEAVY TERMINAL AND BRACKETS'];
  const noisy = QUIET.filter(t => other(t));
  ok('3l. a remark word no rule reads (lead wire, thermostat, flange, sleeve, earthing, buffing, urgent, a stray M6) is asked as "other words"; plain fitting remarks ask nothing',
    missU.length === 0 && noisy.length === 0, [...missU, ...noisy.map(t => `${t}: ${other(t)}`)].join('; '));
  const asked = REMARKS.filter(t => other(t)).map(t => `${t} → ${other(t)}`);
  ok('3m. of her 56 U remark texts, exactly 5 have words no rule reads (urgent dispatch, buffing, "24U ABOVE", "TUBE 22MM", the "taken for 17U" note)',
    asked.length === 5 && ['URGENT DISPATCH', 'BUFFING', '24U ABOVE', 'TUBE 22 MM', 'TAKEN FOR 17U ORDER AS NOS WAS LESS'].every(w => asked.some(a => a.endsWith(`→ ${w}`))), asked.join(' | '));
  ok('3n. a bare large number before "cold zone" (30 COLD ZONE: inches or mm?) is asked, not dropped',
    R.parseRemark('30 cold zone, nut washer').instructions.some(i => i.kind === 'cold zone unit') && R.parseRemark('30 cold zone, nut washer').coldZoneIn == null);
  if (VERBOSE) for (const t of REMARKS) info(`${JSON.stringify(t)} → cz ${got[t].coldZoneIn ?? '-'} · set ${R.fittingSetFor(got[t], [], 1).set || '-'}${got[t].instructions.length ? ` · asks ${got[t].instructions.map(i => i.kind).join(', ')}` : ''}`);
}

// ── 4. Defaults against her app-made U cards (when the fixtures are here) ──
if (fs.existsSync(path.join(FIX, 'u_gen_cards.json'))) {
  const items = require(path.join(FIX, 'u_items.json')).items;
  const cards = require(path.join(FIX, 'u_gen_cards.json')).cards;
  const byItem = new Map(items.map(it => [it.id, it]));
  const res = items.map(it => ({ it, p: R.parseULabel(it.drawing_number, it.product_code) }));
  const wrongIn = res.filter(({ it, p }) => p.ok && (/UL|QU/i.test(it.product_code) || /\d\s*"?U\d|\dU\d|BANK|\dMM\b|\d\s+MM\b|\d{3,}\s*"?U/i.test(it.drawing_number)));
  ok(`4a. over her ${items.length} U-family items: every UL, QU, mm, Bank and ≥100 "U" item is out of phase 1`, wrongIn.length === 0, wrongIn.map(r => r.it.drawing_number).join(', '));
  const firstCards = []; const seen = new Set();
  for (const c of [...cards].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) if (!seen.has(c.item)) { seen.add(c.item); firstCards.push(c); }
  const fixNorm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const disagree = [];
  for (const c of firstCards) {
    const it = byItem.get(c.item);
    const label = R.parseULabel(c.drawing_number, c.product_code);
    const rem = R.parseRemark(c.remark);
    const lines = (it?.inv || []).map(l => ({ code: l.code, qty: l.qty }));
    const fit = R.fittingSetFor(rem, lines, it?.qty || c.qty);
    const scope = !label.ok ? 'out of phase 1' : (rem.fins || fit.fins) ? 'fins' : rem.instructions.length ? 'asked' : null;
    const earlier = cards.filter(x => x.item !== c.item && x.td === c.td && R.normaliseDwgNo(x.drawing_number) === R.normaliseDwgNo(c.drawing_number) && String(x.created_at) < String(c.created_at))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    const cz = R.coldZoneDefault({ rem, earlierCard: earlier ? { big: earlier.cz, small: earlier.czSmall, no: earlier.no } : null, totalLengthIn: c.totalLengthIn, diaMm: c.td, standardColdZone: E.standardColdZone });
    const why = [];
    if (cz.big !== c.cz) why.push(`cold zone ${cz.big}" vs ${c.cz}"`);
    const pin = R.pinDefault({ rem, set: fit.set, coldZone: cz, enginePin: E.terminalPin(cz.big, c.td, E.materialClass(c.input.tubeMaterial) || 'steel').studs });
    if (pin.big !== c.studs) why.push(`pin ${pin.big}" vs ${c.studs}"`);
    const fx = R.fixtureText(fit.set, rem, fit.nipple, lines);
    if (!(fixNorm(c.fixture) === fixNorm(fx) || (fixNorm(fx) && fixNorm(c.fixture).startsWith(fixNorm(fx))))) why.push(`fixture "${fx}" vs "${c.fixture}"`);
    if (R.asmblyDefault(fit.set) !== String(c.asmbly)) why.push(`ASMBLY ${R.asmblyDefault(fit.set)} vs ${c.asmbly}`);
    if (why.length) disagree.push({ item: c.item, dwg: c.drawing_number, scope, why });
  }
  // Her own changes and the nipple cards from before ASMBLY 2 (ORD-172) — PLAN §5 A.
  const EXPECTED = [268, 621, 286, 1405, 1418, 1921];
  const unexpected = disagree.filter(x => !x.scope && !EXPECTED.includes(x.item));
  ok(`4b. the defaults (cold zone, pin, fixture, ASMBLY) agree with her ${firstCards.length} app-made U cards except the known cases`, unexpected.length === 0,
    unexpected.map(x => `${x.item} ${x.dwg}: ${x.why.join('; ')}`).join(' | '));
  const plain = firstCards.filter(c => R.parseULabel(c.drawing_number, c.product_code).ok && !R.parseRemark(c.remark).instructions.length);
  const twoU = plain.filter(c => Number(c.input.drawingTotalLengthIn) === Number(R.totalLength({ uIn: R.parseULabel(c.drawing_number, c.product_code).uIn, diaMm: c.td }).str));
  info(`R1: ${twoU.length} of ${plain.length} of her plain U cards were typed exactly the 2U the app now sends`);
  if (VERBOSE) disagree.forEach(x => info(`${x.scope || 'known'}  ${x.item} ${x.dwg}: ${x.why.join('; ')}`));
} else {
  console.log('SKIP  4. the Mac agent\'s fixtures are not on this computer — the checks against her history are skipped');
}

// ── 5. Other pure rules ──
{
  const d1 = R.dispatchDefault({ orderDispatchDate: null, orderType: 'inventory_order', todayIso: '2026-11-14' });
  const d2 = R.dispatchDefault({ orderDispatchDate: null, orderType: 'local_he', todayIso: '2026-11-14' });
  const d3 = R.dispatchDefault({ orderDispatchDate: '2026-12-01', orderType: 'local_he', todayIso: '2026-11-14' });
  ok('5a. dispatch: inventory order + 7 (21 Nov, Saturday), local + 6 (20 Nov, Friday), the order\'s own date wins',
    d1.date === '2026-11-21' && d1.weekday === 'Saturday' && d2.date === '2026-11-20' && d2.weekday === 'Friday' && d3.date === '2026-12-01');
  ok('5b. the date check refuses 2026-02-30, 21.11.2026 and 2026-11-5', R.isIsoDate('2026-11-21') && !R.isIsoDate('2026-02-30') && !R.isIsoDate('21.11.2026') && !R.isIsoDate('2026-11-5'));
  const chk = (u, cz, w) => { const t = R.totalLength({ uIn: u, diaMm: 8 }); return R.shapeChecks({ geo: t.geo, outsideWidthMm: 43, drawnULengthMm: t.drawnULengthMm, czBigIn: cz, czSmallIn: cz, diaMm: 8, wattsPerElement: w }); };
  const c1 = chk(1, 2, 500), c3 = chk(4, 3, 300), c2 = chk(36, 3, 1500), c4 = chk(10, 2, 2500);
  ok('5c. impossible shapes are refused (1U; 4U with 3" cold zones); 36U-1.5 kW passes; 10U at 2.5 kW is flagged for surface load, not refused',
    c1.blocks.length > 0 && c3.blocks.length > 0 && c2.blocks.length === 0 && c4.blocks.length === 0 && c4.flags.length === 1, `${c1.blocks.length} ${c3.blocks.length} ${c2.blocks.join(';')} ${c4.flags}`);
  const lines = [{ qty: 48, category: 'Nut' }, { qty: 0, category: 'Finns' }, { qty: 0, category: 'Washer' }, { qty: 24, category: 'Terminal Pin' }];
  ok('5d. the upload\'s list filter keeps fins at 0, drops a zero-qty washer and (after order 452) a regular pin', R.filteredForResend(lines, 1625).length === 2 && R.filteredForResend(lines, 100).length === 3);
  const snapIn = { order: { order_type: 'inventory_order', status: 'approved' }, item: { drawing_number: 'X', quantity: 24, remark: 'a ' }, lines: [{ id: 2, qty: '48' }, { id: 1, qty: '48' }], drawingCount: 0, cardCount: 0, legacyCardCount: 0 };
  const s1 = R.itemSnapshot(snapIn);
  const s2 = R.itemSnapshot({ ...snapIn, lines: [{ id: 1, qty: 48 }, { id: 2, qty: 48 }] });
  const s3 = R.itemSnapshot({ ...snapIn, item: { ...snapIn.item, quantity: 25 } });
  const code = (snap, answers, spec) => R.sheetCode({ snapshot: snap, answers, spec });
  const a = code(s1, { cold_zone_in: '3' }, { body: { x: 1 } });
  ok('5e. the sheet code ignores row order and number formatting, not a quantity change; it is three parts: item · answers · spec',
    a === code(s2, { cold_zone_in: '3' }, { body: { x: 1 } }) && a !== code(s3, { cold_zone_in: '3' }, { body: { x: 1 } }) && /^[0-9a-f]{6}-[0-9a-f]{6}-[0-9a-f]{6}$/.test(a), a);
  const b = code(s3, { cold_zone_in: '3' }, { body: { x: 1 } }), c = code(s1, { cold_zone_in: '4' }, { body: { x: 1 } }), dd = code(s1, { cold_zone_in: '3' }, { body: { x: 2 } });
  ok('5f. a changed code says what changed: the item, the answers, or the drawing / card figures',
    R.codeChanges(a, b)[0].startsWith('the order item') && R.codeChanges(a, b).length === 1
    && R.codeChanges(a, c)[0] === 'the answers' && R.codeChanges(a, c).length === 1
    && R.codeChanges(a, dd)[0].startsWith('the drawing') && R.codeChanges(a, a).length === 0, `${a} ${b} ${c} ${dd}`);
  ok('5g. the snapshot diff names the changed fields', R.snapshotDiff(s1, s3).join() === 'item.qty' && R.snapshotDiff(s1, s2).length === 0, R.snapshotDiff(s1, s3).join());
}

// ── 6. The sheet renders with the 2U ruling ──
{
  const t = R.totalLength({ uIn: 18, diaMm: 8 });
  const row = (k, v) => [k, v];
  const spec = {
    banner: 'U TYPE HEATER | TEST', title: 'U TYPE HEATER — 700 W / 230 V', subtitle: 'test', terminalNote: 'M4 SS PIN 3" + NUT WASHER',
    item: { drawingNumber: 'PT-UType-18U-700W', qty: 10, finish: 'No Plating' },
    tube: { code: 'TUB-SS304-038-T06', diaMm: 8, wallMm: 0.6, material: 'SS304', label: 'SS304 3/8" TUBE, DRAWN TO Ø8' },
    shape: { uLabel: '18U', uLengthIn: 18, uLengthMm: t.drawnULengthMm, nominalULengthMm: 457.2, outsideWidthMm: 43, rollerMm: 25 },
    geo: t.geo, r1: { mode: '2u', totalLengthStr: t.str },
    fitting: { set: 'nut_washer', confirmed: true },
    card: { totalLengthIn: 36.7, cuttingLengthIn: 29.5, cuttingLengthMm: 749.3, coldZoneBigIn: 2, coldZoneSmallIn: 2, pinStudsIn: 3, studLabel: 'M4', gauge: 30,
      wireDiaMm: 0.3, mandrelMm: 2.5, wireCode: 'SPR-KD-30', heatedMm: 812.8, rows: [row('Rating', '700 W')] },
    parts: [{ no: 1, key: 'esb', role: 'esb', code: 'ESB-08', stage: ['St 23', 'Sealing'], line1: 'ESB-08 · End Sealing Bush', gu: '', hi: '', perPc: '2', forOrder: '20' }],
    notes: ['test'], tb: { status: 'FOR APPROVAL', material: 'SS304', wattVolt: '700 W · 230 V', qty: '10 NOS', client: 'X', product: 'PT-UType', dwgNo: 'PT-UType-18U-700W', rev: '00', date: '14.11.2026', order: 'ORD-X', drawn: 'PHE APP', checked: '—', approved: 'OWNER' },
  };
  const { html } = renderUTypeSheet(spec);
  ok('6a. the sheet prints TOTAL LENGTH = 36 INCH and the U as it comes out of the 2U tube (451.2, still "18U")',
    html.includes('TOTAL LENGTH = 36 INCH') && html.includes('451.2 U LENGTH &quot;18U&quot; — AS IT COMES OUT OF THE 36&quot; (2 × 18&quot;) TUBE') && !html.includes('36.47'),
    (html.match(/[^>]*U LENGTH[^<]*/) || [''])[0]);
  const draft = renderUTypeSheet({ ...spec, fitting: { set: 'ceramic_nut', confirmed: false }, terminalNote: 'M4 SS PIN 3" + ONE CERAMIC + ONE NUT — TO CONFIRM' }).html;
  ok('6b. a fitting set she has not confirmed is drawn with a red TO CONFIRM; a confirmed one is not', draft.includes('TO CONFIRM') && !html.includes('TO CONFIRM'));

  // ── The notes box (review, 14 Nov 2026): every note line inside the box
  // (238 × 45 at 12, 240), whatever the answers; when even the smallest
  // letters cannot hold them the sheet says so (the agent then refuses it).
  const K = require(S + '/src/lib/drawings/svgKit.js');
  const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");
  const noteBoxes = (svg) => [...svg.matchAll(/<text x="(16|19\.5)" y="([\d.]+)" font-size="([\d.]+)" text-anchor="start" font-weight="400"[^>]*>([^<]*)<\/text>/g)]
    .map(m => ({ x: Number(m[1]), y: Number(m[2]), size: Number(m[3]), t: unesc(m[4]) })).filter(b => b.y > 247);
  const inBox = (bs) => bs.filter(b => b.y + b.size * 0.21 > 284.8 || b.x + K.textWidth(b.t, b.size) / 1.04 > 250);
  const base = ['All dimensions in mm; inches marked ". Do not scale. Tolerances as the title block; resistance ± 5%.',
    'The order as typed: ORD-196-26 · IT · PT-UType-44U -1.25kw · 52 Nos · 1250 W 230 V · TUB-SS316-038-T06 · remark "heavy terminal pin / 8" cold zone" · No Plating.',
    'Shape: 43 outside / 27 inside / roller 25 (the Ø8 standard). TOTAL LENGTH 88" = 2 × 44" (Ms. Vama, 14 Nov 2026); the U is drawn as it comes out of that tube — 1111.6 mm end to end, 6.0 mm short of 1117.6.',
    'Cold zone 8" from the remark ("8" COLD ZONE"); pins 9" from cold zone + 1" — heavy terminal pin with the remark\'s cold zone (as on her card for item 2215). The job card adds 0.7" and works out the cut, coil, wire length and spring from the spool picked on the machine.',
    'Parts: lines 7, 8, 9, 10 are the item\'s list in the app, unchanged; lines 1–6 are what the stages take by the job card.',
    'Terminal end, from the tube: brass nipple (with washer, washer, nipple nut on its thread), ESB, SS nut, washer, washer, SS nut. Fitting order TO CONFIRM by Ms. Vama before production.'];
  const qc = 'Every heater: HV + light check, megger (IR) and resistance before dispatch.';
  const words400 = (w) => (`${w} `.repeat(200)).slice(0, 400).trim();
  // An answer as she might write one, at the 400-letter limit.
  const a400 = 'Make the bend at 7 inches from the cold side as on the last order for this customer, and check the leg length after bending; the cold zone stays as the job card says and the pins are the standard ones. '.repeat(3).slice(0, 400).trim();
  const mism = 'List vs remark: "Nut Washer" takes 4 nuts per heater; the list has 2; "Nut Washer" takes 4 washers per heater; the list has 0; the list looks like "One Ceramic + One Nut", the remark says "Nut Washer".';
  const CASES = {
    'a list-vs-remark note + one short remark answer': [...base, mism, 'Remark (trim): Make it 7U as the remark says', qc],
    'a list-vs-remark note + two answers (12+ lines)': [...base, mism, 'Remark (trim): Make it 7U as the remark says, the cold zone as the earlier card for this customer.', `Remark (bend): ${a400.slice(0, 220)}`, qc],
    'three remark answers and a note at 400 letters each, and a list-vs-remark note': [...base, mism,
      `Remark (trim): ${a400}`, `Remark (bend): ${a400}`, `Remark, the words "BUFFING": ${a400}`, a400, qc],
    'one long capitalised note (200 letters, no spaces to break at)': [...base, 'X'.repeat(200), qc],
  };
  const bad6 = [];
  for (const [label, notes] of Object.entries(CASES)) {
    const r = renderUTypeSheet({ ...spec, notes });
    const bs = noteBoxes(r.svg);
    const out = inBox(bs);
    const words = notes.join(' ').replace(/\s+/g, '');
    if (!r.notesFit || out.length || bs.map(b => b.t.replace(/^\d+\. /, '')).join('').replace(/\s+/g, '') !== words) bad6.push(`${label}: fit ${r.notesFit} at ${r.notesSize}, ${out.length} line(s) outside, text kept ${bs.map(b => b.t.replace(/^\d+\. /, '')).join('').replace(/\s+/g, '') === words}`);
    else info(`notes: ${label} — ${bs.length} lines at ${r.notesSize} mm`);
  }
  ok('6c. the notes always stay inside the box (wrapped by width, set smaller as they grow), every word kept: 11+ lines, 3 answers + a note at 400 letters + a mismatch, a 200-letter word', bad6.length === 0, bad6.join(' | '));
  const tooMuch = renderUTypeSheet({ ...spec, notes: [...base, ...Array(6).fill(words400('WWWW MMMM')), qc] });
  ok('6d. notes that cannot fit even in the smallest letters are reported (notesFit false), for the agent to refuse the sheet', tooMuch.notesFit === false, tooMuch.notesSize);

  // ── Brass and SS nuts on one pin end (review, 14 Nov 2026) ──
  const nutParts = [...spec.parts,
    { no: 2, key: 'nut', role: 'nut', code: 'NUT-SS-M4-08', stage: ['St 26', 'Nut Washer'], line1: 'NUT-SS-M4-08 · SS Nut M4', gu: '', hi: '', perPc: '2', forOrder: '20' },
    { no: 3, key: 'nut', role: 'nut', code: 'NUT-BR-M4-08', stage: ['St 26', 'Nut Washer'], line1: 'NUT-BR-M4-08 · Brass Nut M4', gu: '', hi: '', perPc: '2', forOrder: '20' },
    { no: 4, key: 'washer', role: 'washer', code: 'WSH-BR-08', stage: ['St 26', 'Nut Washer'], line1: 'WSH-BR-08 · Brass Washer', gu: '', hi: '', perPc: '4', forOrder: '40' }];
  const balloonsOf = (svg) => [...svg.matchAll(/<circle cx="[\d.]+" cy="([\d.]+)" r="[\d.]+" fill="#fff"[^>]*\/><text[^>]*>(\d+)<\/text>/g)].map(m => m[2]);
  const mixed = renderUTypeSheet({ ...spec, parts: nutParts, fitting: { set: 'nut_washer', confirmed: true, pin: ['nut', 'washer', 'washer', 'nut'], nuts: ['NUT-BR-M4-08', 'NUT-SS-M4-08'] } });
  const legacy = renderUTypeSheet({ ...spec, parts: nutParts, fitting: { set: 'nut_washer', confirmed: true } });
  const bm = balloonsOf(mixed.svg), bl = balloonsOf(legacy.svg);
  ok('6e. with the nut at each place named (brass next to the ESB, SS outside), Detail D balloons both lines and names them "brass nut" / "SS nut"; without it, the SS line at both places as before',
    bm.includes('2') && bm.includes('3') && mixed.svg.includes('>brass nut<') && mixed.svg.includes('>SS nut<') && bl.includes('2') && !bl.includes('3'),
    `with: ${bm.join(',')} · without: ${bl.join(',')}`);
}

// ── 7. The inside gap, the roller and the wide U (owner, 14 Nov 2026) ──
// "clients inner dia is more important": the inside is the requirement; the
// roller makes it (inside − 2 mm opening), ±2 mm if she accepts, else a new one.
{
  const RL = R.DEFAULT_ROLLERS;
  const pr = (i) => R.pickRoller({ insideMm: i, rollers: RL });
  const vals = (x) => x.options.map(o => `${o.value}${o.isNew ? 'N' : ''}`).join(',');
  const p27 = pr(27), p24 = pr(24), p29 = pr(29), p44 = pr(44), p39 = pr(39), p1016 = pr(101.6);
  ok('7a. rollers 22/25/40: 27 → 25 exact; 24 → 22 exact; 29 → suggest 25 (or a new 27); 44 → suggest 40 (or a new 42); 39 → a new 37; 101.6 → a new 100 (makes 102)',
    RL.join() === '22,25,40' && R.OPENING_MM === 2 && R.ROLLER_TOL_MM === 2
    && p27.kind === 'exact' && p27.suggestMm === 25 && p27.options[0].madeInsideMm === 27 && p24.kind === 'exact' && p24.suggestMm === 22
    && p29.kind === 'suggest' && p29.suggestMm === 25 && vals(p29) === '25,27N' && p29.options[0].madeInsideMm === 27 && p29.options[1].madeInsideMm === 29
    && /25 mm — you have it — gives 27 inside, 2 mm under the client's 29/.test(p29.options[0].label) && /27 mm — NEW roller to make — gives 29 inside$/.test(p29.options[1].label)
    && p44.kind === 'suggest' && p44.suggestMm === 40 && vals(p44) === '40,42N'
    && p39.kind === 'new' && vals(p39) === '37N' && p1016.kind === 'new' && vals(p1016) === '100N' && p1016.options[0].madeInsideMm === 102,
    [p27, p24, p29, p44, p39, p1016].map(x => `${x.insideMm}: ${x.kind} ${vals(x)}`).join(' · '));
  const tie = R.pickRoller({ insideMm: 30, rollers: [27, 29] });
  ok('7b. two rollers equally close: the larger first (inside 30, rollers 27 / 29 → 29, then 27, then a new 28)', tie.kind === 'suggest' && vals(tie) === '29,27,28N', vals(tie));
  const vr = R.validateRollers([40, '25', 22, ' 25 ']), vbad = R.validateRollers(['abc', 3]), vnone = R.validateRollers([]);
  ok('7c. her roller list is checked: numbers 5–300 mm, repeats dropped, smallest first; "abc" or 3 refused, an empty list refused',
    vr.ok && vr.mm.join() === '22,25,40' && !vbad.ok && /"abc", "3"/.test(vbad.error) && !vnone.ok, `${JSON.stringify(vr)} ${vbad.error}`);

  // The inside gap's sources: her answer → the remark → the drawing number → the standard.
  const g1 = R.readDwgGap('PT-UType-16U-1.5Kw-4Gap'), g2 = R.readDwgGap('PT-UType-16U-1.5Kw-100MMGAP'), g3 = R.readDwgGap('PT-UType-18U-700W');
  const l1 = R.parseULabel('PT-UType-16U-1.5Kw-4Gap', 'PT-UType'), l2 = R.parseULabel('PT-UType-16U-1.5Kw-100MMGAP', 'PT-UType');
  ok('7d. the drawing number\'s gap: "-4Gap" = 4" = 101.6 inside (no unit under 12 = inches, her "4” gap" chat); "-100MMGAP" = 100; still a 16U plain U; none on 18U-700W',
    g1?.mm === 101.6 && g1.inches && g2?.mm === 100 && !g2.inches && g3 === null && l1.ok && l1.uIn === 16 && l2.ok && l2.uIn === 16, `${JSON.stringify(g1)} ${JSON.stringify(g2)} ${JSON.stringify(l2)}`);
  const quiet = (t) => !R.parseRemark(t).instructions.some(i => ['other', 'width / pitch'].includes(i.kind));
  const in29 = R.insideDefault({ remarkGap: R.parseRemark('Nut Washer, INSIDE 29MM').gap, diaMm: 8 });
  const gap29 = R.insideDefault({ remarkGap: R.parseRemark('29 MM GAP').gap, diaMm: 8 });
  const cc50 = R.insideDefault({ remarkGap: R.parseRemark('M16 brass nipple, C/C 50').gap, diaMm: 11 });
  ok('7e. the remark\'s gap: "INSIDE 29MM" → 29, "29 MM GAP" → 29, Ø11 "C/C 50" → 39 (50 − 11) — and those words no longer ask "other" / "width / pitch"',
    in29.mm === 29 && in29.from === 'remark' && /INSIDE 29MM/.test(in29.source) && gap29.mm === 29 && cc50.mm === 39 && /50 c\/c − Ø11 = 39/.test(cc50.source)
    && quiet('Nut Washer, INSIDE 29MM') && quiet('29 MM GAP') && quiet('M16 brass nipple, C/C 50') && quiet('U inner dia 29'),
    `${in29.source} | ${gap29.source} | ${cc50.source}`);
  const asks = (t, kind) => R.parseRemark(t).instructions.some(i => i.kind === kind);
  ok('7f. only words the reader understood are taken: "with gap" and "inside" with no figure still ask "other"; "40 MM CENTRES" still asks width / pitch; two different gaps ask "inside gap"',
    asks('Nut washer with gap', 'other') && asks('Nut washer, inside', 'other') && asks('NUT WASHER, 40 MM CENTRES', 'width / pitch')
    && asks('INSIDE 29 / C/C 40', 'inside gap') && R.parseRemark('INSIDE 29 / C/C 40').gap === null && !asks('INSIDE 29 / C/C 40', 'width / pitch'));
  const order = [R.insideDefault({ answerMm: 33, remarkGap: R.parseRemark('INSIDE 29MM').gap, dwgGap: g1, diaMm: 8 }),
    R.insideDefault({ remarkGap: R.parseRemark('INSIDE 29MM').gap, dwgGap: g1, diaMm: 8 }), R.insideDefault({ dwgGap: g1, diaMm: 8 }), R.insideDefault({ diaMm: 8 }), R.insideDefault({ diaMm: 11 })];
  ok('7g. the order of the sources: her answer (33) → the remark (29) → the drawing number (101.6) → the Ø standard (27 on Ø8 and Ø11), each with its source',
    order.map(x => `${x.mm}/${x.from}`).join() === '33/answer,29/remark,101.6/drawing number,27/standard,27/standard'
    && order[0].source === 'your answer' && /4Gap/.test(order[2].source) && order[3].source === 'the Ø8 standard (27 inside)' && R.SHAPE_STANDARD[8].insideMm === 27 && R.SHAPE_STANDARD[11].insideMm === 27,
    order.map(x => x.source).join(' | '));
  const ic = (i, d = 8) => R.insideChecks({ insideMm: i, diaMm: d });
  ok('7h. checks: an inside under the tube (6 on Ø8, 10 on Ø11) or over 300 is refused; under 24 or over 101.6 is flagged; 24 / 27 / 101.6 pass quietly',
    ic(6).blocks.length === 1 && ic(10, 11).blocks.length === 1 && ic(301).blocks.length === 1 && ic(NaN).blocks.length === 1
    && ic(20).flags.length === 1 && /24–100 inside/.test(ic(20).flags[0]) && ic(102).flags.length === 1 && ic(20).blocks.length === 0
    && [24, 27, 101.6].every(i => !ic(i).blocks.length && !ic(i).flags.length));

  // R-e (a proposal to put to her): 2U plus only the bend's difference from the standard width.
  const offStd = [];
  for (let u = 5; u <= 99; u += 0.5) for (const d of [8, 11]) {
    const t = R.totalLength({ uIn: u, diaMm: d, outsideWidthMm: R.SHAPE_STANDARD[d].outsideWidthMm });
    if (t.str !== String(2 * u) || t.extraIn !== 0 || t.formula !== `2 × ${u}"`) offStd.push(`${u}U Ø${d}: ${t.str} ${t.formula}`);
  }
  const w16 = R.totalLength({ uIn: 16, diaMm: 8, outsideWidthMm: 117.6 });
  const w16p = R.totalLength({ uIn: 16, diaMm: 8, outsideWidthMm: 117.6, mode: 'plain_2u' });
  const n7 = R.totalLength({ uIn: 7, diaMm: 8, outsideWidthMm: 40 });
  ok('7i. total length: at the standard width exactly 2U (Ø8 and Ø11, 5–99U) — no standard sheet or card changes',
    offStd.length === 0 && R.WIDE_U_TOTAL === 'bend_extra', offStd.slice(0, 4).join('; '));
  const n45 = R.totalLength({ uIn: 8, diaMm: 8, outsideWidthMm: 45 });
  ok('7j. 16U at 117.6 outside (the 4" gap) on Ø8: 33.68" = 2 × 16" + 1.68" for the wider bend; the drawn U adds up to it; \'plain_2u\' gives 32"; a NARROWER U stays 2U (7U at 40 outside: 14"); 8U at 45 outside: 16.04"',
    w16.str === '33.68' && w16.formula === '2 × 16" + 1.68"' && w16.geo.drawingTotalIn === 33.68 && Math.abs(w16.geo.clMm - 33.68 * 25.4) < 1e-6
    && w16p.str === '32' && w16p.formula === '2 × 16"' && n7.str === '14' && n7.formula === '2 × 7"' && n7.extraIn === 0
    && n45.str === '16.04' && n45.formula === '2 × 8" + 0.04"',
    `${w16.str} ${w16.formula} ${w16.geo.drawingTotalIn} · ${w16p.str} · ${n7.str} ${n7.formula} · ${n45.str} ${n45.formula}`);

  // R-g: the customer's earlier widths are a flag, never a default.
  const HIST = require(S + '/src/lib/drawings/uWidthHistory.json').rows;
  const ids = new Set(HIST.map(r => r.item_id));
  ok(`7k. the width history seed: ${HIST.length} items from her SolidWorks sheets (no item 6 invoice, no item 1926 reused PDF); the 4" gap items 23 / 24 at 100 inside`,
    HIST.length === 150 && !ids.has(6) && !ids.has(1926) && HIST.filter(r => [23, 24].includes(r.item_id)).every(r => r.inside === 100 && r.outside === 116 && r.roller === null)
    && HIST.filter(r => r.customer_code === 'TS' && r.set === 'nut_washer').map(r => r.inside).join() === '24,24,24');
  const hf = (o) => R.widthHistoryFlag({ rows: HIST, customerCode: 'TS', diaMm: 8, set: 'nut_washer', itemId: 999999, madeInsideMm: 27, ...o });
  const f27 = hf({});
  ok('7l. a TS nut-washer sheet at 27 inside is flagged: their earlier ones used 24 (roller 22); at 24 it is not; a TS nipple sheet at 27 is not; an item is not compared with itself',
    /^Earlier U drawings for TS at Ø8 with nut washer used 24 inside \(roller 22\): 7U-250W ORD-007-26, 8U-250W ORD-138-26, 8U-250W ORD-185-26 — this sheet uses 27\. Check the client's drawing\.$/.test(f27 || '')
    && hf({ madeInsideMm: 24 }) === null && hf({ set: 'nipple' }) === null
    && R.widthHistoryFlag({ rows: HIST, customerCode: 'SHIV', diaMm: 8, set: 'nut_washer', itemId: 226, madeInsideMm: 27 }) === null, f27);
  // 15 Nov 2026: only when the inside is the standard by default; one vote per
  // drawing; a drawing naming its own gap ("-4Gap") is not the customer's habit.
  const itGap = HIST.find(r => r.customer_code === 'IT' && r.inside === 100);
  const itFlag = itGap && R.widthHistoryFlag({ rows: HIST, customerCode: 'IT', diaMm: 8, set: itGap.set, itemId: 1924, madeInsideMm: 27 });
  const twoTo1 = [{ customer_code: 'X', dia: 8, set: 'nut_washer', item_id: 1, inside: 24, dwg: 'PT-UType-7U-250W' },
    { customer_code: 'X', dia: 8, set: 'nut_washer', item_id: 2, inside: 24, dwg: 'PT-UType-7U-250W-2' },
    { customer_code: 'X', dia: 8, set: 'nut_washer', item_id: 3, inside: 27, dwg: 'PT-UType-10U-500W' }];
  ok('7m. the history flag: none when the inside is her answer, the remark\'s or the drawing number\'s; IT\'s 4" gap drawing does not flag an IT nipple sheet at 27; two items of ONE drawing are one vote (1 of 2 drawings differ → no flag)',
    hf({ insideFrom: 'answer' }) === null && hf({ insideFrom: 'remark' }) === null && hf({ insideFrom: 'drawing number' }) === null
    && !!itGap && itFlag === null
    && R.widthHistoryFlag({ rows: twoTo1, customerCode: 'X', diaMm: 8, set: 'nut_washer', itemId: 9, madeInsideMm: 27 }) === null,
    `IT: ${itFlag}`);
}

// Parts sized for another tube (16 Nov 2026, ORD-198-26).
{
  const L = (...codes) => codes.map(code => ({ code }));
  const o198 = R.partsForOtherTube(L('NUT-SS-M4-08', 'WSH-BR-08', 'ESB-08'), 11);
  ok('8a. parts for another tube: ORD-198-26 (Ø11 with ESB-08 / NUT-SS-M4-08 / WSH-BR-08) → all three; the same on Ø8 → none; Ø11 with ESB-11 / NUT-SS-M5-11 / WSH-SS-11 / PVC-FB11-M5 → none; WSH-BR-08 among M5-11 parts (ORD-199) → just it; nipples, pins, fins and coils are not size-coded',
    o198.map(x => x.code).join() === 'NUT-SS-M4-08,WSH-BR-08,ESB-08' && o198.every(x => x.sizeMm === 8)
    && R.partsForOtherTube(L('NUT-SS-M4-08', 'WSH-BR-08', 'ESB-08', 'PVC-FB08-M4'), 8).length === 0
    && R.partsForOtherTube(L('ESB-11', 'NUT-SS-M5-11', 'WSH-SS-11', 'PVC-FB11-M5'), 11).length === 0
    && R.partsForOtherTube(L('ESB-11', 'WSH-BR-08', 'NUT-SS-M5-11'), 11).map(x => x.code).join() === 'WSH-BR-08'
    && R.partsForOtherTube(L('NIP-BR-M12-ROUND', 'TP-SS-M4-03-WH', 'FIN-SS-08', 'SPR-KD-36', 'ESB-110'), 11).length === 0,
    JSON.stringify(o198));
}

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
