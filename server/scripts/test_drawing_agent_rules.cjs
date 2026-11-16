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
    ['PT-UType-800mm-1.25Kw', 'PT-UType'], ['PT-UType-30U-12Kw-3in1', 'PT-UType'], ['PT-FlangeHe-30U-12Kw', 'PT-FlangeHe'], ['PT-QUL-3.5KW', 'PT-QUL']];
  const inScope = outs.filter(([dn, pc]) => R.parseULabel(dn, pc).ok);
  ok('2b. 1238U (mm), UL, QU, Bank, mm, 3in1, flange and QUL are out of phase 1 (fins no longer are — 16 Nov 2026)', inScope.length === 0, inScope.map(s => s[0]).join(', '));
  ok('2c. normalising: "PT-UType-12"U-COP-1.5KW - 2" = "PT-Utype-12U-1.5KW"; "PT-U TYPE-16U-750W" = "PT-UType-16U-750W"; -INC / -PLAIN ignored',
    R.normaliseDwgNo('PT-UType-12"U-COP-1.5KW - 2') === R.normaliseDwgNo('PT-Utype-12U-1.5KW')
    && R.normaliseDwgNo('PT-U TYPE-16U-750W') === R.normaliseDwgNo('PT-UType-16U-750W')
    && R.normaliseDwgNo('PT-UType-24U-750w-INC') === R.normaliseDwgNo('PT-UType-24U-750W')
    && R.normaliseDwgNo('PT-Utype-10U-500W-Plain') === R.normaliseDwgNo('PT_Utype-10U-500W')
    && R.normaliseDwgNo('PT-UType-18U-1KW') !== R.normaliseDwgNo('PT-UType-18U-1.5KW'));
  // Finned U (owner, 16 Nov 2026): the fins token is taken out like the gap token.
  const f1 = R.parseULabel('PT-UType-10U-500W-FINNS', 'PT-UType'), f2 = R.parseULabel('PT-UType-10U-500W-Finns ', 'PT-UType');
  const f3 = R.parseULabel('PT-UType-24U-1Kw-SSFinns', 'PT-UType'), f4 = R.parseULabel('PT-ULType-48U7L-2.5KW-FINNS', 'PT-ULType');
  const plainKeys = samples.map(([dn]) => Object.keys(R.parseULabel(dn, 'PT-UType')).join()).filter(k => k !== 'ok,uIn,label');
  ok('2d. fins in the drawing number: "-FINNS" / "-Finns " → 10U, fins true; "-SSFinns" → 24U, SS; a finned UL stays out; a plain number carries no fins key',
    f1.ok && f1.uIn === 10 && f1.fins === true && f1.finMaterial === null && f2.ok && f2.uIn === 10 && f2.fins
    && f3.ok && f3.uIn === 24 && f3.finMaterial === 'SS' && !f4.ok && plainKeys.length === 0,
    JSON.stringify([f1, f2, f3, f4.reason, plainKeys]));
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
  // F7 (owner, 16 Nov 2026): her finned U cards' fixture, fins first.
  const finned = firstCards.map(c => {
    const it = byItem.get(c.item);
    const label = R.parseULabel(c.drawing_number, c.product_code);
    const rem = R.parseRemark(c.remark);
    const lines = (it?.inv || []).map(l => ({ code: l.code, qty: l.qty }));
    const fins = R.finsFor({ label, rem, lines });
    if (!label.ok || !fins.finned) return null;
    const fit = R.fittingSetFor(rem, lines, it?.qty || c.qty);
    return { item: c.item, card: c.fixture, app: R.fixtureText(fit.set, rem, fit.nipple, lines, fins) };
  }).filter(Boolean);
  const finOff = finned.filter(x => fixNorm(x.card) !== fixNorm(x.app));
  ok(`4c. F7: on her ${finned.length} app-made finned U cards the fixture is hers, fins first ("SS Finns + Heavy Terminal Pin", "MS Finns+ Nut Washer", "SS Finns, Nut Washer")`,
    finned.length >= 3 && finOff.length === 0, [...finOff, ...(VERBOSE ? finned : [])].map(x => `${x.item}: "${x.app}" vs "${x.card}"`).join(' | '));
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
  ok('8a. parts for another tube: ORD-198-26 (Ø11 with ESB-08 / NUT-SS-M4-08 / WSH-BR-08) → all three; the same on Ø8 → none; Ø11 with ESB-11 / NUT-SS-M5-11 / WSH-SS-11 / PVC-FB11-M5 → none; WSH-BR-08 among M5-11 parts (ORD-199) → just it; nipples, pins and coils are not size-coded; fins are (16 Nov 2026): FIN-SS-08-VE / FIN-MS-08 on Ø11 and FIN-MS-11 / FIN-SS-11-VE on Ø8 are flagged, each on its own tube is not',
    o198.map(x => x.code).join() === 'NUT-SS-M4-08,WSH-BR-08,ESB-08' && o198.every(x => x.sizeMm === 8)
    && R.partsForOtherTube(L('NUT-SS-M4-08', 'WSH-BR-08', 'ESB-08', 'PVC-FB08-M4'), 8).length === 0
    && R.partsForOtherTube(L('ESB-11', 'NUT-SS-M5-11', 'WSH-SS-11', 'PVC-FB11-M5'), 11).length === 0
    && R.partsForOtherTube(L('ESB-11', 'WSH-BR-08', 'NUT-SS-M5-11'), 11).map(x => x.code).join() === 'WSH-BR-08'
    && R.partsForOtherTube(L('NIP-BR-M12-ROUND', 'TP-SS-M4-03-WH', 'SPR-KD-36', 'ESB-110'), 11).length === 0
    && R.partsForOtherTube(L('FIN-SS-08-VE', 'FIN-MS-08', 'ESB-11'), 11).map(x => `${x.code}:${x.sizeMm}`).join() === 'FIN-SS-08-VE:8,FIN-MS-08:8'
    && R.partsForOtherTube(L('FIN-MS-11', 'FIN-SS-11-VE'), 8).map(x => `${x.code}:${x.sizeMm}`).join() === 'FIN-MS-11:11,FIN-SS-11-VE:11'
    && R.partsForOtherTube(L('FIN-SS-08-VE', 'FIN-MS-08'), 8).length === 0 && R.partsForOtherTube(L('FIN-MS-11', 'FIN-SS-11-VE'), 11).length === 0,
    JSON.stringify(o198));
}

// ── 9. True part sizes (owner, 16 Nov 2026) ──
// "you can also get the inventory's like finns and esb that is the ceramic bead …
// from the inventory for its dia and dimensions for accurate drawings".
{
  const P = require(S + '/src/lib/drawings/partSizes.js');
  const f = (notes, kind) => R.stable(P.parseSizeNotes(notes, kind).fields);
  const want = (o) => R.stable(o);
  const NOTES = [
    ['ESB 8mm OD-7.93, Height: 4.3, Hole: 4.2', 'esb', { odMm: 7.93, idMm: 4.2, lenMm: 4.3 }],
    ['ESB 90 Od-8.40,ID-4.13,Head-2.92', 'esb', { odMm: 8.4, idMm: 4.13, headLenMm: 2.92 }],
    ['M4 Nut - 8mmOD=8mm,ID=4mm,Thickness-2.88', 'nut', { odMm: 8, idMm: 4, lenMm: 2.88 }],
    ['Washer - 8mmOd-9mm,ID-4.45 Thickness-0.60', 'washer', { odMm: 9, idMm: 4.45, lenMm: 0.6 }],
    ['Washer -11mm SSOD-10.29,ID-5.49,Thickness-0.80', 'washer', { odMm: 10.29, idMm: 5.49, lenMm: 0.8 }],
    ['FB 8mm - M4 PVC Bush Top ( OD: 9.2, ID: 3.8) Back  OD: 7.2 Height: 6.8', 'fbush', { headOdMm: 9.2, idMm: 3.8, spigotOdMm: 7.2, lenMm: 6.8, odMm: 9.2 }],
    ['Bracket - Full Mid Hole 11 MM Thickness-1.25, Length-75.63,Hight-37.06,Hole-12.5,Mid Hole-10.51', 'bracket',
      { thkMm: 1.25, lenMm: 1.25, footLenMm: 75.63, hMm: 37.06, holeMm: 12.5, midHoleMm: 10.51 }],
    ['M16 Brass Nipple _HexL-30.1, HOLE (OD-16MM,ID-11MM), GROVE(2.55)', 'nipple', { lenMm: 30.1, holeOdMm: 16, idMm: 11, grooveMm: 2.55 }],
    ['M14 Brass Nipple-Hex L-27MM,Hole(OD-13.90,ID-8MM)Grove(1.9) (Refer Drawing)', 'nipple', { lenMm: 27, holeOdMm: 13.9, idMm: 8, grooveMm: 1.9 }],
    ['M12 Brass Nipple - Hex L-26.5MM, HOLE 9( OD-13MM,ID-8MM), Grove(2.2)', 'nipple', { lenMm: 26.5, holeOdMm: 13, idMm: 8, grooveMm: 2.2 }],
    ['M16 Brass Nipple - Double Coil M16 in 8mm L 33.2 Inch,Hole( OD-15.89,ID-11.01) Grove (2.1)', 'nipple', { holeOdMm: 15.89, idMm: 11.01, grooveMm: 2.1 }],
    ['Thickness=4.49,Thread=2.15,Head=1.38,Coil Head=2.20 Len :- 90mm', 'pin', { odMm: 4.49, lenMm: 90 }],
    ['Thickness=4.63,Thread Thickness=2.15', 'pin', { odMm: 4.63 }],
    ['No Thread - Plain', 'pin', {}], ['', 'esb', {}], [null, 'nut', {}],
  ];
  const bad9 = NOTES.filter(([n, k, w]) => f(n, k) !== want(w)).map(([n, k, w]) => `${n} (${k}): ${f(n, k)} want ${want(w)}`);
  const pinRaw = P.parseSizeNotes('Thickness=4.49,Thread=2.15,Head=1.38,Coil Head=2.20 Len :- 90mm', 'pin').raw;
  ok('9a. her notes are read as typed: OD-/OD=/Od-, "8mmOD", "SSOD", Hole: (bore), Height (along the axis), the bush\'s Top ( OD, ID ) and Back OD, the bracket\'s Hight / Length / Mid Hole (not the "Mid Hole 11 MM" in its name), the nipple\'s HexL- / HOLE 9( / Grove(, a pin\'s Thickness as its Ø; "L 33.2 Inch" with no mark is not read',
    bad9.length === 0 && R.stable(pinRaw) === R.stable({ thread: 2.15, head: 1.38, coilHead: 2.2 }), [...bad9, R.stable(pinRaw)].join(' | '));
  const swapNut = P.parseSizeNotes('M12 Brass Nipple Nut - Hex,OD=18.98,ID=10.50,Thickness=5.02', 'nipple');
  const swapNip = P.parseSizeNotes('M12 Brass Nipple - Hex L-26.5MM, HOLE 9( OD-13MM,ID-8MM), Grove(2.2)', 'nipnut');
  const oak = P.parseSizeNotes('SS Nipple - OAK - Nipple Nut ,OD=22.22,ID=120.10,Thickness=4.80', 'nipnut');
  const m16n = P.parseSizeNotes('M16 Brass Nipple Nut_Hex OD=24.04,ID=14.50,Thickness=5.05', 'nipnut');
  ok('9b. a note that describes the other part (the M12 nipple\'s and nut\'s notes typed on each other\'s line) is not used; a bore bigger than the part (OAK nut "ID=120.10") is dropped; "Nut_Hex" is still a nut',
    swapNut.describesOther === 'the nipple nut' && R.stable(swapNut.fields) === '{}' && swapNip.describesOther === 'the nipple'
    && R.stable(oak.fields) === want({ odMm: 22.22, lenMm: 4.8 }) && oak.ignored.length === 1 && !m16n.describesOther && m16n.fields.odMm === 24.04,
    JSON.stringify([swapNut, swapNip, oak.ignored]));
  const sd = P.SEED;
  const about = require(S + '/src/lib/drawings/partSizes.json').about;
  ok('9c. the seed (snapshot 16 Nov 2026) holds her drawings\' sizes: fins 8 mm MS 28.44/8.35, SS 28.50/8.78, 11 mm MS 31.55/11.40, SS 31.59/11.35; ESB-08 ceramic 7.9/4.2 × 6.0; ESB-11 10.9/5.1 × 5.0 chamfered 45° (no head, no spigot); the brackets\' slots 9.6 (Ø8) / 12.3 (Ø11); the filling bushes\' heads',
    /16 Nov 2026/.test(about) && /SNAPSHOT/.test(about)
    && sd['FIN-MS-08'].odMm === 28.44 && sd['FIN-MS-08'].idMm === 8.35 && sd['FIN-SS-08-VE'].odMm === 28.5 && sd['FIN-SS-08-VE'].idMm === 8.78
    && sd['FIN-MS-11'].odMm === 31.55 && sd['FIN-MS-11'].idMm === 11.4 && sd['FIN-SS-11-VE'].odMm === 31.59 && sd['FIN-SS-11-VE'].idMm === 11.35
    && sd['ESB-08'].material === 'CERAMIC' && sd['ESB-08'].odMm === 7.9 && sd['ESB-08'].idMm === 4.2 && sd['ESB-08'].lenMm === 6
    && sd['ESB-11'].odMm === 10.9 && sd['ESB-11'].idMm === 5.1 && sd['ESB-11'].lenMm === 5 && sd['ESB-11'].chamferDeg === 45 && sd['ESB-11'].headOdMm == null
    && sd['BKT-FMH-H788-MS'].slotWMm === 9.6 && sd['BKT-FMH-H1250'].slotWMm === 12.3 && sd['PVC-FB08-M4'].headOdMm === 9.2 && sd['PVC-FB11-M5'].spigotOdMm === 10.1
    && Object.values(sd).every(e => e.kind === P.kindOf(Object.keys(sd).find(k => sd[k] === e)) && e.source));
  // Notes win over the seed only for the same field.
  const esb = P.mergeSizes('ESB-08', { ...sd['ESB-08'] }, P.parseSizeNotes('ESB 8mm OD-7.93, Height: 4.3, Hole: 4.2', 'esb'));
  const pinOnly = P.mergeSizes('TP-SS-M4-03-WH', null, P.parseSizeNotes('Thickness=3.48,Thread=2.17,Head=1.36', 'pin'));
  const seedOnly = P.mergeSizes('FIN-SS-08-VE', { ...sd['FIN-SS-08-VE'] }, P.parseSizeNotes(null, 'fin'));
  const nothing = P.mergeSizes('IWS-FIB-M12-RD', null, P.parseSizeNotes(null, 'nipwasher'));
  ok('9d. merging: ESB-08 takes the notes\' OD 7.93 and length 4.3, keeps the drawing\'s bore and R0.2, says both sources, and reports the length (4.3 vs the drawing\'s 6.0 — one is wrong); a part with notes only, the seed only, or neither',
    esb.entry.odMm === 7.93 && esb.entry.lenMm === 4.3 && esb.entry.idMm === 4.2 && esb.entry.edgeRMm === 0.2
    && /ESB 8MM\.pdf.*\+ inventory notes \(od, len\)/.test(esb.entry.source)
    && esb.conflicts.length === 1 && esb.conflicts[0].field === 'lenMm' && esb.conflicts[0].notes === 4.3 && esb.conflicts[0].seed === 6
    && pinOnly.entry.odMm === 3.48 && pinOnly.entry.source === 'inventory notes' && seedOnly.entry.odMm === 28.5 && /FIN-MS-08\.pdf/.test(seedOnly.entry.source)
    && nothing.entry === null, JSON.stringify([esb, pinOnly.entry.source]));
  // partSizesFor over a stub of the inventory (no database).
  const stubRows = [{ code: 'ESB-08', notes: 'ESB 8mm OD-7.93, Height: 4.3, Hole: 4.2' }, { code: 'NIP-BR-M12-HEX', notes: 'M12 Brass Nipple Nut - Hex,OD=18.98,ID=10.50,Thickness=5.02' },
    { code: 'TP-HV-M6XM4', notes: null }, { code: 'IWS-FIB-M12-RD', notes: null }, { code: 'NUT-SS-M4-08', notes: 'M4 SS Nut - 8mm OD=8mm,ID=4mm,Thickness-2.88' }];
  const stub = { all: async (q, prm) => stubRows.filter(r => prm[0].includes(r.code)) };
  P.partSizesFor(stub, ['ESB-08', 'NIP-BR-M12-HEX', 'IWS-FIB-M12-RD', 'FIN-SS-08-VE', 'SPR-KD-36', 'TUB-SS304-038-T06', 'TP-HV-M6XM4', 'esb-08', 'NUT-SS-M4-08']).then(r => {
    ok('9e. a sheet\'s sizes: coil and tube are not asked for; ESB-08 by notes + drawing; the M12 nipple from the seed (its own notes describe the nut — reported); the fins from the seed; the fibre washer and the heavy pin (no size anywhere) listed as "size not in inventory"; the heavy pin\'s M6 stud on M4 from its code',
      Object.keys(r.sizes).sort().join() === 'ESB-08,FIN-SS-08-VE,NIP-BR-M12-HEX,NUT-SS-M4-08' && r.sizes['ESB-08'].lenMm === 4.3 && r.sizes['NIP-BR-M12-HEX'].lenMm === 26.5
      && r.sizes['NUT-SS-M4-08'].thread === 'M4' && r.sizes['FIN-SS-08-VE'].odMm === 28.5 && r.missing.sort().join() === 'IWS-FIB-M12-RD,TP-HV-M6XM4'
      && r.ignored.length === 1 && /describe the nipple nut/.test(r.ignored[0].why) && r.conflicts.length === 1
      && R.stable(P.threadOf('TP-HV-M6XM4')) === R.stable({ thread: 'M6', pinThread: 'M4' }), JSON.stringify(r).slice(0, 400));
  });
}

// ── 10. Finned U (owner, 16 Nov 2026) ──
// F1 "yes, go round the bend and stop 25mm"; F2 "there are sometimes when we dont
// add the finns to the U bend part"; F3 "the finns will not come ahead of the
// terminal end brackets" · "yes, 1.5" from both ends with a gap"; F5 the fin
// stock as the app takes it; F6 the checks; F7 the fixture.
{
  const W = require(S + '/src/lib/inventoryDeduction.js').FINS_WEIGHT_PER_BASE;
  const L = (...x) => x.map(([code, qty]) => ({ code, qty }));
  const lab = (dn) => R.parseULabel(dn, 'PT-UType');
  const f1922 = R.finsFor({ label: lab('PT-UType-10U-500W-FINNS'), rem: R.parseRemark('FINNS + HEAVY TERMINAL PIN'), lines: L(['FIN-SS-08-VE', 0], ['TP-HV-M6XM4', 40]) });
  const fDwg = R.finsFor({ label: lab('PT-UType-10U-500W-Finns'), rem: R.parseRemark('HEAVY TERMINAL PIN'), lines: L(['TP-HV-M6XM4', 40]) });
  const fList = R.finsFor({ label: lab('PT-UType-48U-2Kw'), rem: R.parseRemark('NUT WASHER'), lines: L(['FIN-MS-08', 0]) });
  const fPlain = R.finsFor({ label: lab('PT-UType-18U-700W'), rem: R.parseRemark('NUT WASHER'), lines: L(['ESB-08', 20], ['NUT-SS-M4-08', 40]) });
  const r279 = R.parseRemark('SS Finns, Nut Washer');
  ok('10a. fins are read from the remark, the drawing number or the list: 1922 (remark + number + FIN-SS-08-VE) → SS, Ø8; a number alone says fins; a list alone has them; "SS Finns, Nut Washer" → SS, no other words; a plain U is not finned',
    f1922.finned && f1922.code === 'FIN-SS-08-VE' && f1922.material === 'SS' && f1922.sizeMm === 8 && f1922.said.join() === 'the remark,the drawing number'
    && fDwg.finned && fDwg.said.join() === 'the drawing number' && !fDwg.code && fList.finned && fList.said.length === 0 && fList.material === 'MS'
    && r279.fins && r279.finMaterial === 'SS' && !r279.instructions.length && !fPlain.finned && R.parseRemark('MS Finns + Brackets').finMaterial === 'MS',
    JSON.stringify([f1922, fDwg.said, fList.said]));
  const c = (o) => R.finListChecks(R.finsFor(o));
  const noLine = c({ label: lab('PT-UType-25U-1.5KW'), rem: R.parseRemark('m16 brass nipple with ss finns- 24U above Nipple'), lines: L(['NIP-BR-M16-HEX', 24]) });
  const noLineDwg = c({ label: lab('PT-UType-10U-500W-FINNS'), rem: R.parseRemark('HEAVY TERMINAL PIN'), lines: L(['TP-HV-M6XM4', 40]) });
  const two = c({ label: lab('PT-UType-10U-500W'), rem: R.parseRemark('MS FINS'), lines: L(['FIN-MS-08', 0], ['FIN-SS-08-VE', 0]) });
  const msSs = c({ label: lab('PT-UType-48U-2Kw'), rem: R.parseRemark('MS Finns + Nut Washer'), lines: L(['FIN-SS-08-VE', 0]) });
  const listOnly = c({ label: lab('PT-UType-48U-2Kw'), rem: R.parseRemark('NUT WASHER'), lines: L(['FIN-MS-08', 0]) });
  const good = c({ label: lab('PT-UType-48U-2Kw'), rem: R.parseRemark('MS Finns + Nut Washer'), lines: L(['FIN-MS-08', 0]) });
  const plainC = c({ label: lab('PT-UType-18U-700W'), rem: R.parseRemark('NUT WASHER'), lines: L(['ESB-08', 20]) });
  ok('10b. F6: the remark (or the drawing number) says fins and the list has no fin line → refused, "design to add the fin line"; two fin lines → refused; the remark\'s MS against the list\'s SS → flagged; fins on the list only → flagged; a matching or a plain list → nothing',
    noLine.blocks.length === 1 && /the remark says fins but the list has no fin line — design to add the fin line/.test(noLine.blocks[0])
    && /the drawing number says fins/.test(noLineDwg.blocks[0] || '') && two.blocks.some(b => /2 fin lines/.test(b))
    && msSs.blocks.length === 0 && msSs.flags.length === 1 && /the remark says MS fins, the list has SS \(FIN-SS-08-VE\)/.test(msSs.flags[0])
    && listOnly.blocks.length === 0 && listOnly.flags.length === 1 && good.blocks.length + good.flags.length === 0 && plainC.blocks.length + plainC.flags.length === 0,
    JSON.stringify([noLine, noLineDwg, two, msSs, listOnly]));
  // F7: the fins first, as on her cards.
  const fx = (set, remark, lines, fins, nip) => R.fixtureText(set, R.parseRemark(remark), nip || null, lines, fins);
  const OLD = { nut_washer: 'Nut Washer', ceramic_nut: 'One Ceramic + One Nut', ceramic_only: 'One Ceramic only', heavy_pin: 'Heavy Terminal Pin',
    nut_washer_brackets: 'Nut washer + MS Brackets', nipple: 'M12 Brass Nipple', nipple_ceramic_nut: 'M12 Brass Nipple + One Ceramic + One Nut' };
  const plainSame = Object.entries(OLD).filter(([set, want]) => R.fixtureText(set, R.parseRemark(''), null, []) !== want || fx(set, '', [], { finned: false }) !== want);
  ok('10c. F7 fixture: "SS Finns + Heavy Terminal Pin" (1922), "MS Finns + Nut Washer" (1404), "MS Finns + Brackets" (139), "SS Finns + M16 Brass Nipple", "Finns + Brackets" with no material named; every plain fixture unchanged',
    fx('heavy_pin', 'FINNS + HEAVY TERMINAL PIN', [], f1922) === 'SS Finns + Heavy Terminal Pin'
    && fx('nut_washer', 'MS Finns + Nut Washer', [], { finned: true, material: 'MS' }) === 'MS Finns + Nut Washer'
    && fx('nut_washer_brackets', 'MS Finns + Brackets', [], { finned: true, material: 'MS' }) === 'MS Finns + Brackets'
    && fx('nipple', 'm16 brass nipple with ss finns', [], { finned: true, material: 'SS' }, 'M16') === 'SS Finns + M16 Brass Nipple'
    && fx('nut_washer_brackets', 'FINNS + CLAMPS', [], { finned: true, material: null }) === 'Finns + Brackets' && plainSame.length === 0,
    plainSame.map(p => p[0]).join());
  // F1–F3 defaults and her answers.
  const d0 = R.finDefaults({}), dB = R.finDefaults({ hasBrackets: true });
  const dA = R.finDefaults({ onBendAns: 'no', stopAns: 30, pitchAns: 4 });
  const dBA = R.finDefaults({ hasBrackets: true, fromEndAns: 40, fromBendAns: 45 });
  const dBad = R.finDefaults({ onBendAns: 'maybe' });
  ok('10d. defaults: round the bend, 25 mm bare at each end, pitch 3 ("about 3 mm off your fin drawing"); with brackets 38.1 / 38.1 and the fins stop at the terminal-end bracket (38.1, then her 40 when she moves the bracket); her answers win; "maybe" is refused',
    R.FIN_STOP_MM === 25 && R.FIN_PITCH_MM === 3 && R.BRACKET_AT_MM === 38.1 && R.BRACKETS_PER_HEATER === 2
    && d0.onBend && d0.stopMm === 25 && d0.pitchMm === 3 && d0.fromBendMm === null && /"stop 25mm"/.test(d0.sources.stop) && d0.sources.pitch === 'about 3 mm off your fin drawing (not dimensioned)'
    && /Ms\. Vama, 16 Nov 2026: "yes, go round the bend"/.test(d0.sources.onBend)
    && dB.stopMm === 38.1 && dB.fromBendMm === 38.1 && dB.fromEndMm === 38.1 && /terminal-end bracket, 38\.1 from the tube end — the fins stop at it/.test(dB.sources.stop)
    && !dA.onBend && dA.stopMm === 30 && dA.pitchMm === 4 && dA.sources.stop === 'your answer'
    && dBA.stopMm === 40 && dBA.fromBendMm === 45 && dBad.errors.length === 1 && d0.errors.length === 0,
    JSON.stringify([d0, dB.sources]));
  // Where the fins run (F1 / F2 / F3) and the checks (F6).
  const t1922 = R.totalLength({ uIn: 10, diaMm: 8, outsideWidthMm: 40 });
  const lay = (o) => R.finLayout({ geo: t1922.geo, diaMm: 8, drawnULengthMm: t1922.drawnULengthMm, finOdMm: 28.5, pitchMm: 3, onBend: true, stopMm: 25, ...o });
  const a = lay({}), aNo = lay({ onBend: false });
  const legs = 2 * (t1922.geo.straight - 25), bend = Math.PI * 16;
  ok('10e. F1 / F2 on 1922 (10U at 40 outside, legs 32 c/c, SS fins OD 28.5): round the bend 25 mm short of each end = 2 × (228.9 − 25) + π × 16 = 458.0 mm; bend bare = 407.7; 3.5 mm between the legs\' fins, no flag',
    a.finnedLengthMm === R.round(legs + bend, 1) && a.finnedLengthMm === 458 && aNo.finnedLengthMm === R.round(legs, 1) && aNo.finnedLengthMm === 407.7
    && a.clearMm === 3.5 && !a.blocks.length && !a.flags.length && a.gapMm === null, JSON.stringify([a, aNo.finnedLengthMm]));
  const t139 = R.totalLength({ uIn: 18, diaMm: 8 });
  const lay139 = (o) => R.finLayout({ geo: t139.geo, diaMm: 8, drawnULengthMm: t139.drawnULengthMm, finOdMm: 28.44, pitchMm: 3, onBend: true, stopMm: 38.1,
    brackets: { fromBendMm: 38.1, fromEndMm: 38.1, thkMm: 1.25 }, ...o });
  const b = lay139({}), bLip = lay139({ brackets: { fromBendMm: 38.1, fromEndMm: 38.1, thkMm: 1.25, lipMm: 12 } }), bBare = lay139({ onBend: false });
  ok('10f. F3 on 139 (18U, MS fins + 2 brackets of 1.25 sheet): the fins stop at the terminal-end bracket (38.1) and leave a gap at the bend-end bracket on each leg of its sheet + its 10.8 lip (the screws\' strip, fins cannot pass under it) + 2 × pitch = 18.05: 2 × (straight − 38.1) + π × 17.5 − 2 × 18.05 = 802.1; a lip from the inventory is used',
    b.gapMm === 18.05 && b.finnedLengthMm === R.round(2 * (t139.geo.straight - 38.1) + Math.PI * 17.5 - 36.1, 1) && b.finnedLengthMm === 802.1 && !b.blocks.length && b.bendReachMm === 21.5
    && bLip.gapMm === 19.25 && R.BRACKET_LIP_MM === 10.8
    // F2 + F3, the bend bare: the 2.2 mm between the gap and the bend is too short to wind (as the sheet draws it): 2 × (413.1 − 41.7) = 742.8
    && bBare.finnedLengthMm === 742.8,
    JSON.stringify([b, bLip.gapMm, bBare.finnedLengthMm]));
  const past = lay139({ stopMm: 25 }), onBend = lay139({ brackets: { fromBendMm: 20, fromEndMm: 38.1, thkMm: 1.25 } });
  const wide = R.totalLength({ uIn: 16, diaMm: 8, outsideWidthMm: 117.6 });
  const wideB = R.finLayout({ geo: wide.geo, diaMm: 8, drawnULengthMm: wide.drawnULengthMm, finOdMm: 28.44, pitchMm: 3, onBend: true, stopMm: 38.1, brackets: { fromBendMm: 38.1, fromEndMm: 38.1, thkMm: 1.25 } });
  const tShort = R.totalLength({ uIn: 3, diaMm: 8 });
  const shortB = R.finLayout({ geo: tShort.geo, diaMm: 8, drawnULengthMm: tShort.drawnULengthMm, finOdMm: 28.44, pitchMm: 3, onBend: true, stopMm: 38.1, brackets: { fromBendMm: 38.1, fromEndMm: 38.1, thkMm: 1.25 } });
  const tight = R.totalLength({ uIn: 10, diaMm: 8, outsideWidthMm: 36 }), close = R.totalLength({ uIn: 10, diaMm: 8, outsideWidthMm: 38 });
  const over = R.finLayout({ geo: tight.geo, diaMm: 8, drawnULengthMm: tight.drawnULengthMm, finOdMm: 28.5, pitchMm: 3, onBend: true, stopMm: 25 });
  const near = R.finLayout({ geo: close.geo, diaMm: 8, drawnULengthMm: close.drawnULengthMm, finOdMm: 28.5, pitchMm: 3, onBend: true, stopMm: 25 });
  const long = lay({ stopMm: 240 });
  ok('10g. refused: fins running past the terminal-end bracket (her words quoted); a bend-end bracket on the bend (20 mm, the bend reaches 21.5; 38.1 on a 4" gap U); brackets that do not fit a 3U; fins of OD 28.5 on legs 28 c/c (36 outside); a stop longer than the leg. Flagged: 1.5 mm between the fins (38 outside)',
    past.blocks.length === 1 && /"the finns will not come ahead of the terminal end brackets" \(Ms\. Vama, 16 Nov 2026\)/.test(past.blocks[0])
    && onBend.blocks.length === 1 && /would sit on the bend \(the bend reaches 21\.5 mm\)/.test(onBend.blocks[0]) && wideB.blocks.some(x => /on the bend/.test(x))
    && shortB.blocks.some(x => /do not fit/.test(x)) && over.blocks.length === 1 && /would overlap/.test(over.blocks[0])
    && near.blocks.length === 0 && near.flags.length === 1 && /only 1\.5 mm between the two legs' fins/.test(near.flags[0])
    && long.blocks.some(x => /each straight leg is only/.test(x)),
    JSON.stringify([past.blocks, onBend.blocks, over.blocks, near.flags]));
  // F5: kg exactly as inventoryDeduction.deductFinsByLength takes it.
  const k1922 = R.finKg({ code: 'FIN-SS-08-VE', weights: W, totalLengthMm: 525.78, elements: 1, quantities: [20] });
  const k1404 = R.finKg({ code: 'FIN-MS-08', weights: W, totalLengthMm: 2456.18, elements: 1, quantities: [6] });
  const k279 = R.finKg({ code: 'FIN-SS-11-VE', weights: W, totalLengthMm: 3472.18, elements: 1, quantities: [4] });
  const kSplit = R.finKg({ code: 'FIN-MS-11', weights: W, totalLengthMm: 1000, elements: 1, quantities: [50, 50, 20] });
  const perCard = [50, 50, 20].reduce((s, q) => s + Math.round((1000 / 50.8) * W['FIN-MS-11'] * q * 1000) / 1000, 0);
  ok('10h. F5 fin stock = the card\'s tube length / 50.8 × inventoryDeduction\'s own kg per 50.8 mm × pieces: 1922 (525.78 mm, FIN-SS-08-VE, 20) → 0.145 kg per piece, 2.898 kg — her card; 1404 → 3.191; 279 → 5.468; a 50/50/20 split rounds per card; a code the app has no weight for → none',
    k1922.kgPerPc === 0.145 && k1922.kgForOrder === 2.898 && k1404.kgForOrder === 3.191 && k279.kgForOrder === 5.468
    && kSplit.kgForOrder === R.round(perCard, 3) && R.FINS_MM_BASE === 50.8 && k1922.perBase === W['FIN-SS-08-VE']
    && R.finKg({ code: 'FIN-SS-08', weights: W, totalLengthMm: 525.78, quantities: [20] }) === null,
    JSON.stringify([k1922, k1404.kgForOrder, k279.kgForOrder, kSplit.kgForOrder, perCard]));
  const ls139 = R.listShape(L(['FIN-MS-08', 0], ['BKT-FMH-H788-MS', 24], ['ESB-08', 24], ['NUT-SS-M4-08', 48], ['WSH-BR-08', 48]), 12);
  const bList = R.bracketsFor({ rem: R.parseRemark('MS Finns + Brackets'), ls: ls139, diaMm: 8 });
  const bRem = R.bracketsFor({ rem: R.parseRemark('FINNS + CLAMPS'), ls: R.listShape(L(['TP-SS-M4-03-WH', 12]), 12), diaMm: 8 });
  const bRem11 = R.bracketsFor({ rem: R.parseRemark('SS FINS WITH 2 CLAMPS'), ls: R.listShape([], 1), diaMm: 11 });
  const bNone = R.bracketsFor({ rem: R.parseRemark('MS Finns + Nut Washer'), ls: R.listShape(L(['FIN-MS-08', 0]), 6), diaMm: 8 });
  ok('10i. the list\'s fins and brackets: 139 → FIN-MS-08 (MS, Ø8), BKT-FMH-H788-MS × 2 per heater on the list; "FINNS + CLAMPS" with no bracket line → the usual BKT-FMH-H788-MS (Ø8) / BKT-FMH-H1250 (Ø11), not on the list; no brackets → none',
    ls139.finCode === 'FIN-MS-08' && ls139.finMaterial === 'MS' && ls139.finSizeMm === 8 && ls139.bracketCode === 'BKT-FMH-H788-MS'
    && bList.code === 'BKT-FMH-H788-MS' && bList.onList && bList.perHeater === 2 && bRem.code === 'BKT-FMH-H788-MS' && !bRem.onList && bRem.perHeater === 2
    && bRem11.code === 'BKT-FMH-H1250' && bNone === null, JSON.stringify([bList, bRem, bRem11]));
  // The plain U is as it was: the list's reading, the set, the checks.
  const lsPlain = R.listShape(L(['ESB-08', 20], ['NUT-SS-M4-08', 40], ['WSH-BR-08', 40]), 10);
  ok('10j. a plain U is unchanged: its list reads 2 ESB / 4 nuts / 4 washers, no fins, no fin or bracket code; the set from it is still nut washer; finsFor says not finned',
    lsPlain.esb === 2 && lsPlain.nut === 4 && lsPlain.washer === 4 && lsPlain.fins === false && lsPlain.finCode === null && lsPlain.bracketCode === null
    && R.setFromList(lsPlain) === 'nut_washer' && !R.finsFor({ label: lab('PT-UType-18U-700W'), rem: R.parseRemark(''), lines: L(['ESB-08', 20]) }).finned);
  // The agent's own list checks and answers (no database touched).
  const A = require(S + '/src/lib/drawings/agent.js');
  const st = (dwg, remark, lines) => ({ item: { drawing_number: dwg, product_code: 'PT-UType', remark, quantity: 12, tube_diameter: 8, bom_review: null, inventory_deducted: false },
    order: { id: 999999 }, lines: lines.map(([code, qty, category]) => ({ code, qty, category: category || '' })) });
  const lb164 = A.listBlocks(st('PT-UType-25U-1.5KW', 'm16 brass nipple with ss finns- 24U above Nipple', [['NIP-BR-M16-HEX', 12, 'Nipple Fastner'], ['ESB-08', 24, 'End Sealing Bush']]));
  const lbOk = A.listBlocks(st('PT-UType-18U-1kw', 'MS Finns + Brackets', [['FIN-MS-08', 0, 'Finns'], ['ESB-08', 24, 'End Sealing Bush']]));
  const lb11 = A.listBlocks({ ...st('PT-UType-18U-1kw', 'SS Finns', [['FIN-SS-08-VE', 0, 'Finns'], ['ESB-11', 24, 'End Sealing Bush']]), item: { drawing_number: 'PT-UType-18U-1kw', product_code: 'PT-UType', remark: 'SS Finns', quantity: 12, tube_diameter: 11 } });
  const ca = A.cleanAnswers({ fins_on_bend: 'no', fin_stop_mm: '30', fin_pitch_mm: '4', bracket_from_bend_mm: '40', bracket_from_end_mm: '40', fin_od: '9' });
  const v = A.verdict({ item: { drawing_number: 'PT-UType-10U-500W-FINNS', product_code: 'PT-UType', tube_diameter: 8, remark: 'FINNS + HEAVY TERMINAL PIN' },
    order: { status: 'approved', order_type: 'local_he' }, lines: [{ code: 'FIN-SS-08-VE', qty: 0 }], drawings: [], cards: [], legacyCards: [], orderLevelSame: [], sameFiled: [] });
  ok('10k. the agent: a finned U is due (no "phase 2" skip); the remark\'s fins with no fin line stop the list (164); an SS 8 mm fin line on an Ø11 tube is refused as a part for another tube; a good finned list passes; her five fin answers are kept, an unknown key dropped',
    v.due && !v.scope && v.label.fins === true
    && lb164.some(x => /the remark says fins but the list has no fin line — design to add the fin line/.test(x))
    && lb11.some(x => /parts for a Ø8 tube on this Ø11 tube \(FIN-SS-08-VE\)/.test(x)) && lbOk.length === 0
    && R.stable(ca) === R.stable({ fins_on_bend: 'no', fin_stop_mm: '30', fin_pitch_mm: '4', bracket_from_bend_mm: '40', bracket_from_end_mm: '40' }),
    JSON.stringify([v.scope, lb164, lb11, lbOk]));
}

// ── 11. Finned U, review fixes (16 Nov 2026) ──
// The bare-bend bracket wording, her fitting set deciding the brackets, the
// bracket's slots against the legs, a pitch from the fin's notes, a nipple set
// clear of the fins, the remark's fin wordings, and the finned sheet rendered.
{
  const L = (...x) => x.map(([code, qty]) => ({ code, qty }));
  const t139 = R.totalLength({ uIn: 18, diaMm: 8 });
  const lay = (o) => R.finLayout({ geo: t139.geo, diaMm: 8, drawnULengthMm: t139.drawnULengthMm, finOdMm: 28.44, pitchMm: 3, onBend: true, stopMm: 38.1,
    brackets: { fromBendMm: 38.1, fromEndMm: 38.1, thkMm: 1.25 }, ...o });
  const on = lay({}), bare = lay({ onBend: false }), farBare = lay({ onBend: false, brackets: { fromBendMm: 70, fromEndMm: 38.1, thkMm: 1.25 } });
  const brk = { code: 'BKT-FMH-H788-MS', onList: true, perHeater: 2, fromBendMm: 38.1, fromEndMm: 38.1, size: { lenMm: 75.2, hMm: 36, wMm: 55, thkMm: 1.25 } };
  const finOf = (l, onBend) => ({ onBend, bracketGapMm: l.bendSideFinned ? l.gapMm : null, bareToMm: l.bendSideFinned ? null : l.gapToMm });
  const wOn = R.bracketWords({ brk, fin: finOf(on, true) }), wBare = R.bracketWords({ brk, fin: finOf(bare, false) }), wProd = R.bracketWords({ brk, fin: finOf(bare, false), production: true });
  const wNoFin = R.bracketWords({ brk: { ...brk, onList: false }, fin: null });
  ok('11a. 139 with the bend bare (Fins on the bend: No): the 2.2 mm stub between the bend and the bracket is not wound, so nothing is finned on the bend side — the bend-end bracket is where the fins END (bare to 41.73 from the outer end of the U), never "gap" or "fins on both sides"; round the bend it is a gap of 18.05 with fins on both sides; a bracket 70 in leaves a leg run on the bend side (a gap again); the row says "from the outer end of the U"; the foot is TO CONFIRM on the preview only',
    on.bendSideFinned === true && bare.bendSideFinned === false && bare.gapToMm === 41.73 && farBare.bendSideFinned === true
    && /gap of 18\.05 mm in the fins at it .*fins on both sides and round the bend/.test(wOn.note) && wOn.row[1] === '38.1 from the outer end of the U (gap in the fins) · 38.1 from the tube end (fins stop)'
    && !/both sides|gap/.test(wBare.note) && /where the fins end: each leg is bare from the outer end of the U to 41\.73 mm in/.test(wBare.note)
    && wBare.row[1] === '38.1 from the outer end of the U (fins end past it) · 38.1 from the tube end (fins stop)'
    && /TO CONFIRM by Ms\. Vama/.test(wBare.note) && !/TO CONFIRM/.test(wProd.note) && /as fitted/.test(wProd.note)
    && !/fins/i.test(wNoFin.note.replace(/finns/g, '')) && wNoFin.row[0] === '2 × BKT-FMH-H788-MS (not on the list)',
    JSON.stringify([bare, wBare]));
  // Her fitting set decides (the list's BKT- line always counts).
  const clamps = R.parseRemark('FINNS + CLAMPS');
  const lsNone = R.listShape(L(['FIN-MS-08', 0]), 12), lsBkt = R.listShape(L(['FIN-MS-08', 0], ['BKT-FMH-H788-MS', 24]), 12);
  const bSetNo = R.bracketsFor({ rem: clamps, ls: lsNone, diaMm: 8, set: 'nut_washer' });
  const bSetYes = R.bracketsFor({ rem: R.parseRemark('MS Finns'), ls: lsNone, diaMm: 11, set: 'nut_washer_brackets' });
  const bListWins = R.bracketsFor({ rem: R.parseRemark('MS Finns'), ls: lsBkt, diaMm: 8, set: 'nut_washer' });
  const bRemark = R.bracketsFor({ rem: clamps, ls: lsNone, diaMm: 8, set: 'nut_washer_brackets' });
  ok('11b. brackets follow her fitting set: "FINNS + CLAMPS" answered as Nut Washer → none; "Nut washer + MS Brackets" with no bracket anywhere → the Ø11 usual BKT-FMH-H1250, not on the list; a BKT- line on the list always counts',
    bSetNo === null && bSetYes && bSetYes.code === 'BKT-FMH-H1250' && !bSetYes.onList && bListWins && bListWins.onList && bRemark && bRemark.code === 'BKT-FMH-H788-MS',
    JSON.stringify([bSetNo, bSetYes, bListWins]));
  // The bracket's slots (her drawings): H788 9.6 slots 35.7 c/c, H1250 12.3 slots 36.1 c/c.
  const P = require(S + '/src/lib/drawings/partSizes.js');
  const h788 = P.SEED['BKT-FMH-H788-MS'], h1250 = P.SEED['BKT-FMH-H1250'];
  const fit = (size, d, outside) => R.bracketFitChecks({ code: 'B', size, diaMm: d, cc: outside - d });
  const std8 = fit(h788, 8, 43), therm = fit(h788, 8, 40), std11 = fit(h1250, 11, 49), small = fit(h788, 11, 49), wide = fit(h1250, 8, 43), gap4 = fit(h788, 8, 117.6);
  ok('11c. the bracket against the U: H788 on the Ø8 standard (35 c/c in 35.7 ± 1.6) fits; at 40 outside (32 c/c) flagged "does not fit this U width"; H1250 on the Ø11 standard (38 c/c vs 36.1 ± 1.3) flagged; the Ø8 bracket on an Ø11 tube refused (9.6 slots); the Ø11 one on Ø8 flagged (slots 4.3 wider); a 4" gap U (109.6 c/c) refused',
    h788.slotCcMm === 35.7 && h1250.slotCcMm === 36.1 && std8.blocks.length + std8.flags.length === 0
    && therm.blocks.length === 0 && therm.flags.length === 1 && /does not fit this U width: its slots are 35\.7 c\/c \(9\.6 wide\), the legs 32 c\/c/.test(therm.flags[0])
    && std11.blocks.length === 0 && std11.flags.length === 1 && small.blocks.length === 1 && /does not go in/.test(small.blocks[0])
    && wide.blocks.length === 0 && wide.flags.some(f => /bracket for another tube/.test(f)) && gap4.blocks.some(b => /does not fit this U width/.test(b)),
    JSON.stringify([therm, std11, small, wide, gap4]));
  // A pitch typed in the fin item's notes, and a nipple set at the terminal end.
  const pInv = R.finDefaults({ pitchInv: 2.8 }), pAns = R.finDefaults({ pitchInv: 2.8, pitchAns: 4 });
  const notePitch = P.parseSizeNotes('MS Finns 8mm OD-28.44, ID-8.35, Pitch-2.9', 'fin').fields;
  const nip = R.finDefaults({ clearOf: { mm: 33.1, what: 'NIP-BR-M16-HEX nipple set' } }), nipAns = R.finDefaults({ stopAns: 30, clearOf: { mm: 33.1, what: 'NIP-BR-M16-HEX nipple set' } });
  const nipBr = R.finDefaults({ hasBrackets: true, clearOf: { mm: 23, what: 'M12 nipple set' } });
  ok('11d. the pitch: her answer, else the fin item\'s inventory notes ("Pitch-2.9" is read), else 3; a nipple set reaching 33.1 mm moves the default stop to 37 (a pitch past it, said why), her stop of 30 is refused; with brackets the stop stays at the bracket when the nipple is shorter',
    pInv.pitchMm === 2.8 && /inventory notes/.test(pInv.sources.pitch) && pAns.pitchMm === 4 && notePitch.pitchMm === 2.9
    && nip.stopMm === 37 && /clear of the NIP-BR-M16-HEX nipple set \(it reaches 33\.1 mm/.test(nip.sources.stop) && !nip.errors.length
    && nipAns.errors.length === 1 && /over the NIP-BR-M16-HEX nipple set/.test(nipAns.errors[0]) && nipBr.stopMm === 38.1,
    JSON.stringify([pInv, nip.sources.stop, nipAns.errors]));
  // The remark's fin wordings.
  const rH = R.parseRemark('SS-Finns + Nut Washer'), rG = R.parseRemark('SSFinns, nut washer'), rNo = R.parseRemark('Without Finns, Nut Washer'), rNo2 = R.parseRemark('No fins');
  ok('11e. the remark: "SS-Finns" and "SSFinns" are SS fins; "Without Finns" / "No fins" is not finned (its words are asked about)',
    rH.fins && rH.finMaterial === 'SS' && rG.fins && rG.finMaterial === 'SS' && !rNo.fins && !rNo2.fins && rNo.unread.includes('WITHOUT') && rNo2.unread.includes('NO'),
    JSON.stringify([rH.fins, rG.fins, rNo.unread, rNo2.unread]));
  // The finned sheet itself: fins, brackets and true sizes rendered (no database).
  const SZ = (...codes) => Object.fromEntries(codes.map(c => [c, { ...P.SEED[c], kind: P.kindOf(c) }]));
  const base = (d, uIn, outside) => {
    const t = R.totalLength({ uIn, diaMm: d, outsideWidthMm: outside });
    const m5 = d === 11;
    return { t, spec: {
      banner: 'U TYPE HEATER | TEST', title: 'U TYPE HEATER — 1000 W / 230 V', subtitle: 'test', terminalNote: 'M4 SS PIN 3" + MS FINNS + BRACKETS',
      item: { drawingNumber: `PT-UType-${uIn}U-1kw`, qty: 12, finish: 'No Plating' },
      tube: { code: 'TUB-SS304-038-T06', diaMm: d, wallMm: 0.6, material: 'SS304', label: `SS304 TUBE, DRAWN TO Ø${d}` },
      shape: { uLabel: `${uIn}U`, uLengthIn: uIn, uLengthMm: t.drawnULengthMm, nominalULengthMm: uIn * 25.4, outsideWidthMm: outside, insideMm: outside - 2 * d, rollerMm: outside - 2 * d - 2 },
      geo: t.geo, r1: { mode: '2u', totalLengthStr: t.str, formula: t.formula },
      fitting: { set: 'nut_washer_brackets', confirmed: false, pin: ['nut', 'washer', 'washer', 'nut'], tube: ['bracket'] },
      card: { totalLengthIn: t.num + 0.7, cuttingLengthIn: 29.5, cuttingLengthMm: 749.3, coldZoneBigIn: 2, coldZoneSmallIn: 2, pinStudsIn: 3, studLabel: m5 ? 'M5' : 'M4', gauge: 29,
        wireDiaMm: 0.35, mandrelMm: 2, wireCode: 'SPR-KD-29', heatedMm: 812.8, rows: [['Rating', '1000 W'], ['Fins', ['MS FINS', 'round the bend', 'over the fins']], ['Brackets', ['2 × B', '38.1 from the outer end of the U']]] },
      parts: [
        { no: 1, key: 'bracket', role: 'bracket', code: 'BKT-FMH-H788-MS', stage: ['St 26', 'Nut Washer'], line1: 'BKT-FMH-H788-MS · Bracket', gu: '', hi: '', perPc: '2', forOrder: '24' },
        { no: 2, key: 'esb', role: 'esb', code: m5 ? 'ESB-11' : 'ESB-08', stage: ['St 23', 'Sealing'], line1: 'ESB', gu: '', hi: '', perPc: '2', forOrder: '24' },
        { no: 3, key: 'nut', role: 'nut', code: m5 ? 'NUT-SS-M5-11' : 'NUT-SS-M4-08', stage: ['St 26', 'Nut Washer'], line1: 'NUT', gu: '', hi: '', perPc: '4', forOrder: '48' },
        { no: 4, key: 'washer', role: 'washer', code: m5 ? 'WSH-SS-11' : 'WSH-BR-08', stage: ['St 26', 'Nut Washer'], line1: 'WSH', gu: '', hi: '', perPc: '4', forOrder: '48' },
        { no: 5, key: 'fins', role: 'fins', code: m5 ? 'FIN-MS-11' : 'FIN-MS-08', stage: ['Stock St 29', 'by tube length'], line1: 'FIN', gu: '', hi: '', perPc: '0.202 kg', forOrder: '2.422 kg' }],
      notes: ['test'],
      partSizes: SZ(m5 ? 'ESB-11' : 'ESB-08', m5 ? 'NUT-SS-M5-11' : 'NUT-SS-M4-08', m5 ? 'WSH-SS-11' : 'WSH-BR-08', 'BKT-FMH-H788-MS', m5 ? 'FIN-MS-11' : 'FIN-MS-08'),
      tb: { status: 'FOR APPROVAL', material: 'SS304', wattVolt: '1000 W · 230 V', qty: '12 NOS', client: 'X', product: 'PT-UType', dwgNo: 'X', rev: '00', date: '16.11.2026', order: 'ORD-X', drawn: 'PHE APP', checked: '—', approved: 'OWNER' },
    } };
  };
  const finned = (d, uIn, outside, onBend) => {
    const { t, spec } = base(d, uIn, outside);
    const od = d === 11 ? 31.55 : 28.44;
    const l = R.finLayout({ geo: t.geo, diaMm: d, drawnULengthMm: t.drawnULengthMm, finOdMm: od, pitchMm: 3, onBend, stopMm: 38.1, brackets: { fromBendMm: 38.1, fromEndMm: 38.1, thkMm: 1.2 } });
    spec.fins = { code: d === 11 ? 'FIN-MS-11' : 'FIN-MS-08', material: 'MS', odMm: od, idMm: 8.35, pitchMm: 3, onBend, stopBeforeEndMm: 38.1,
      bracketGapMm: l.bendSideFinned ? l.gapMm : null, bareToMm: l.bendSideFinned ? null : l.gapToMm, finnedLengthMm: l.finnedLengthMm, clearMm: l.clearMm,
      label: `MS FINS (${d === 11 ? 'FIN-MS-11' : 'FIN-MS-08'})` };
    spec.brackets = { code: 'BKT-FMH-H788-MS', perHeater: 2, fromBendMm: 38.1, fromEndMm: 38.1, size: { lenMm: 75.2, hMm: 36, wMm: 55, thkMm: 1.2, slotWMm: 9.6, lipMm: 10.8 } };
    return { spec, out: renderUTypeSheet(spec), l };
  };
  const a8 = finned(8, 18, 43, true), b8 = finned(8, 18, 43, false), a11 = finned(11, 21, 49, true);
  const good = (o, label) => o.out.html.includes(`${label} · OD `) && (o.out.html.match(/&gt;38\.1 \(1\.5&quot;\)<|>38\.1 \(1\.5&quot;\)</g) || []).length >= 2
    && /SECTION T–T, ONE LEG/.test(o.out.html) && /FINS [0-9.]+ APART/.test(o.out.html) && !/NaN|null SWG|undefined/.test(o.out.html) && o.out.notesFit && o.out.tablesFit !== false
    && /clamped in its slots/.test(o.out.html) && !/before the ESB/.test(o.out.html) && !/stroke-dasharray="1\.2 0\.8"/.test(o.out.html)
    && (o.out.html.match(/fill="#e2e6ea"/g) || []).length === 2 && !o.out.html.includes("#f3f5f7");
  ok('11f. the finned sheet renders (pure): 18U Ø8 round the bend with 2 brackets — the fin row "MS FINS (FIN-MS-08) · OD 28.44", both 1.5" bracket figures, Section T–T one leg with the fins\' clearance, the bracket "clamped in its slots" (not "before the ESB"), each bracket foot drawn as her top view (one plate each, pointing away from the middle — no dashed foot), the fins as loops (no grey envelope), no NaN / null; the same with the bend bare (no GAP AT THE BRACKET) and on Ø11 (FIN-MS-11, 21U at 49)',
    good(a8, 'MS FINS (FIN-MS-08)') && a8.out.html.includes('GAP AT THE BRACKET') && good(b8, 'MS FINS (FIN-MS-08)') && !b8.out.html.includes('GAP AT THE BRACKET')
    && b8.out.html.includes('STRAIGHT LEGS ONLY, BEND BARE') && good(a11, 'MS FINS (FIN-MS-11)'),
    [a8, b8, a11].map(o => `${o.out.notesFit}/${o.out.tablesFit}/${(o.out.html.match(/>38\.1 \(1\.5&quot;\)</g) || []).length}`).join(' '));
  // The tables never run into the title block: a long list is set smaller, and one too long is refused.
  // The real element table: 16 one-line rows, the Fins row (3 lines) and the Brackets row (2).
  const longP = (n) => { const { spec } = finned(8, 18, 43, true);
    spec.card.rows = [...Array.from({ length: 16 }, (_, i) => [`Row ${i}`, 'x']), ['Fins', ['a', 'b', 'c']], ['Brackets', ['a', 'b']]];
    spec.parts = Array.from({ length: n }, (_, i) => ({ no: i + 1, key: 'nut', role: 'nut', code: `NUT-${i}`, stage: ['St 26', 'Nut Washer'], line1: `NUT-${i} · a nut`, gu: 'ગુ', hi: 'हि', perPc: '1', forOrder: '12' })); return renderUTypeSheet(spec); };
  const fits14 = longP(15), over = longP(50);
  const plainSpec = base(8, 18, 43).spec; delete plainSpec.partSizes;
  ok('11g. the parts table: 15 lines under a finned + bracketed element table (18 rows) are set one line a cell, smaller, and fit (tablesFit); 50 lines cannot (tablesFit false — the agent refuses the sheet); a plain sheet is not touched',
    fits14.tablesFit === true && fits14.html.includes('>St 26 Nut Washer</text>') && over.tablesFit === false && renderUTypeSheet(plainSpec).tablesFit === true, `${fits14.tablesFit} ${over.tablesFit}`);
}

// 9e runs on a promise: the summary waits for it.
setImmediate(() => setTimeout(() => {
  console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
}, 0));
