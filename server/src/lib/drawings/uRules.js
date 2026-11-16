// ── Plain U type drawings: the rules (owner, 14 Nov 2026) ─────────────────────
// Pure functions of their arguments — no database, no files — so
// scripts/test_drawing_agent_rules.cjs checks them offline. Ported from the
// Mac agent's _rules.cjs (phe-claude-code/scripts/drawings, checked against the
// app's own history on 14 Nov 2026), with the owner's ruling R1 fixed: the
// total length is 2 × U. lib/drawings/agent.js reads the database and calls these.
const crypto = require('crypto');
const { deriveUShape, uLengthForCentreline } = require('./uTypeSheet');

const IN = 25.4;
const round = (n, dp) => Math.round(Number(n) * 10 ** dp) / 10 ** dp;
const trimNum = (n) => String(round(n, 2));          // 36 → "36", 37.4 → "37.4"

// ── Shape standards ──────────────────────────────────────────────────────────
// Ø8: 43 outside / 27 inside / roller 25 (115 of 150 PHE U drawings).
// Ø11: 49 outside / 27 inside / roller 25 (64 outside seen on 2 old Ø11 sheets,
// so the width stays a question she can change). Outside = inside + 2 × Ø.
const SHAPE_STANDARD = {
  8: { insideMm: 27, outsideWidthMm: 43, rollerMm: 25 },
  11: { insideMm: 27, outsideWidthMm: 49, rollerMm: 25 },
};
const PHASE1_DIAMETERS = [8, 11];

// ── The inside gap and the roller (owner, 14 Nov 2026) ───────────────────────
// "there are times when the u inner dia can varying": the client's inside gap
// is the requirement — "clients inner dia is more important". "A roller is
// basically a tool on which the heater is bend to a u": the tube opens 2 mm
// after bending (roller 22 → 24, 25 → 27, 40 → 42 inside on 129 of her 130
// sheets that print a roller). "We can make as many roller as per client inner
// dia requirement … you can suggest the closest roller that is feasible with
// +- 2mm tolerance and if accepted we can use that" — the ±2 mm is on the
// inside gap. Her roller list (drawing_rulings 'rollers') replaces the three on
// her drawings; she sends it on Monday 16 Nov 2026.
const OPENING_MM = 2;
const ROLLER_TOL_MM = 2;
const DEFAULT_ROLLERS = [22, 25, 40];
const DEFAULT_ROLLERS_SOURCE = 'from your drawings — your list on Monday replaces it';
// The widths on her drawings run 24 – 100 inside (the 4" gap, 101.6, drawn as 100).
const INSIDE_SEEN_MM = { min: 24, max: 101.6 };

// Her roller list as saved: positive numbers 5 – 300 mm, no repeats, smallest
// first. → { ok, mm } or { ok: false, error }.
function validateRollers(raw) {
  if (!Array.isArray(raw) || !raw.length) return { ok: false, error: 'Give at least one roller size in mm.' };
  if (raw.length > 60) return { ok: false, error: 'At most 60 roller sizes.' };
  const bad = raw.filter(v => { const n = Number(String(v ?? '').trim()); return String(v ?? '').trim() === '' || !Number.isFinite(n) || n < 5 || n > 300; });
  if (bad.length) return { ok: false, error: `Roller sizes must be numbers from 5 to 300 mm (not ${bad.map(v => `"${String(v ?? '').trim()}"`).join(', ')}).` };
  return { ok: true, mm: [...new Set(raw.map(v => round(Number(String(v).trim()), 2)))].sort((a, b) => a - b) };
}

// R-d: which roller makes the client's inside. ideal = inside − 2 (the opening).
//  'exact'   — a roller she has gives the client's inside: use it, nothing asked.
//  'suggest' — none does, but one gives within ±2 mm of it: she picks one (the
//              closest first, the larger on a tie) or a new roller of the ideal size.
//  'new'     — none within ±2 mm: a new roller of the ideal size (whole mm).
// Each option → { value, mm, isNew, madeInsideMm, label }; made inside = roller + 2.
function pickRoller({ insideMm, rollers }) {
  const inside = round(insideMm, 2);
  const list = [...new Set((rollers || []).map(Number).filter(n => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
  const ideal = round(inside - OPENING_MM, 2);
  const gives = (r) => round(r + OPENING_MM, 2);
  const vsClient = (r) => {
    const dlt = round(gives(r) - inside, 2);
    return dlt === 0 ? '' : `, ${trimNum(Math.abs(dlt))} mm ${dlt < 0 ? 'under' : 'over'} the client's ${trimNum(inside)}`;
  };
  const have = (r) => ({ value: trimNum(r), mm: r, isNew: false, madeInsideMm: gives(r), label: `${trimNum(r)} mm — you have it — gives ${trimNum(gives(r))} inside${vsClient(r)}` });
  const newMm = Math.max(1, Math.round(ideal));
  const fresh = { value: String(newMm), mm: newMm, isNew: true, madeInsideMm: gives(newMm), label: `${newMm} mm — NEW roller to make — gives ${trimNum(gives(newMm))} inside${vsClient(newMm)}` };
  const within = list.filter(r => Math.abs(gives(r) - inside) <= ROLLER_TOL_MM + 1e-9)
    .sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal) || b - a);
  const base = { insideMm: inside, idealMm: ideal, rollers: list };
  const exact = list.find(r => Math.abs(r - ideal) <= 0.01 + 1e-9);
  if (exact != null) return { ...base, kind: 'exact', suggestMm: exact, options: [exact, ...within.filter(r => r !== exact)].map(have) };
  if (within.length) return { ...base, kind: 'suggest', suggestMm: within[0], options: [...within.map(have), ...(list.includes(newMm) ? [] : [fresh])] };
  return { ...base, kind: 'new', suggestMm: newMm, options: [fresh] };
}

// A gap value with its unit: mm as written; " / IN / INCH × 25.4; no unit and
// under 12 → inches (no U opens less than 12 mm; her "4Gap" is 4"), else mm.
function gapToMm(n, unit) {
  const u = String(unit || '').toUpperCase();
  const inches = u === '"' || u.startsWith('IN') || (!u && n < 12);
  return { mm: round(inches ? n * IN : n, 2), inches, unitGiven: !!u };
}
// The drawing number's gap token, e.g. "PT-UType-16U-1.5Kw-4Gap" — her chat on
// ORD-071-26 (22 Jul 2026): "Please upload drawing of the heater with 4” gap";
// her sheet for it (items 23 / 24) is 116 outside / 100 inside.
const DWG_GAP_RE = /(\d+(?:\.\d+)?)\s*(MM|"|INCH|IN)?\s*-?\s*GAP/i;
function readDwgGap(drawingNumber) {
  const m = String(drawingNumber || '').replace(/[“”″]/g, '"').match(DWG_GAP_RE);
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0)) return null;
  return { n, unit: m[2] ? m[2].toUpperCase() : null, text: m[0].trim(), ...gapToMm(n, m[2]) };
}
// The remark's inside gap: INSIDE / INNER / GAP n (either order), or C/C /
// CENTRE TO CENTRE n (the legs' centres: inside = c/c − Ø, worked out by the
// caller, who knows the tube). → [{ kind: 'inside'|'cc', n, unit, mm, inches, text }].
const U_ = '(MM|"|INCH(?:ES)?\\b|IN\\b)?';
const NUM_ = '(\\d+(?:\\.\\d+)?)';
const REMARK_GAP_RES = [
  ['inside', new RegExp(`(?:\\bU\\s+)?\\b(?:INSIDE|INNER|GAP)\\b(?:\\s*(?:(?:DIA(?:METER)?|GAP|WIDTH|DISTANCE|OF|IS)\\b|[=:-]))*\\s*${NUM_}\\s*${U_}`, 'g')],
  ['inside', new RegExp(`${NUM_}\\s*${U_}\\s*(?:(?:INSIDE|INNER)\\s*)?(?:GAP|INSIDE|INNER)\\b`, 'g')],
  ['cc', new RegExp(`(?:\\bC\\s*\\/\\s*C\\b|\\bCENT(?:RE|ER)\\s*TO\\s*CENT(?:RE|ER)\\b)(?:\\s*(?:(?:DISTANCE|OF|LEGS?|IS)\\b|[=:-]))*\\s*${NUM_}\\s*${U_}`, 'g')],
  ['cc', new RegExp(`${NUM_}\\s*${U_}\\s*(?:C\\s*\\/\\s*C\\b|CENT(?:RE|ER)\\s*TO\\s*CENT(?:RE|ER)\\b)`, 'g')],
];
// Overlapping readings ("INSIDE 29 GAP" is read word-first and number-first)
// are one statement; `agree` is false when they give different gaps.
function readRemarkGaps(t) {
  const found = [];
  for (const [kind, re] of REMARK_GAP_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) {
      const n = Number(m[1]);
      if (n > 0) found.push({ kind, n, unit: m[2] || null, at: m.index, end: m.index + m[0].trimEnd().length, ...gapToMm(n, m[2]) });
    }
  }
  const clusters = [];
  for (const g of found.sort((a, b) => a.at - b.at || b.end - a.end)) {
    const c = clusters[clusters.length - 1];
    if (c && g.at < c.end) { c.end = Math.max(c.end, g.end); c.readings.push(g); } else clusters.push({ at: g.at, end: g.end, readings: [g] });
  }
  return clusters.map(c => ({ ...c.readings[0], end: c.end, text: t.slice(c.at, c.end).trim(),
    agree: new Set(c.readings.map(g => `${g.kind}:${g.mm}`)).size === 1 }));
}

// R-a: the client's inside gap — her answer → the remark → the drawing number
// → the Ø standard (27 inside on Ø8 and Ø11). → { mm, from, source (the page),
// short (the element table), note (the sheet's notes) }.
function insideDefault({ answerMm, remarkGap, dwgGap, diaMm }) {
  const std = SHAPE_STANDARD[diaMm];
  const asRead = (g) => (g.unitGiven ? (g.inches ? ` = ${trimNum(g.mm)} mm` : '') : g.inches ? ` — read as ${trimNum(g.n)}" = ${trimNum(g.mm)} mm` : ' — read as mm');
  if (answerMm != null) return { mm: round(answerMm, 2), from: 'answer', source: 'your answer', short: 'Ms. Vama', note: 'Ms. Vama' };
  if (remarkGap) {
    if (remarkGap.kind === 'cc') {
      const mm = round(remarkGap.mm - diaMm, 2);
      const how = `"${remarkGap.text}"${remarkGap.inches ? asRead(remarkGap) : ''}: ${trimNum(remarkGap.mm)} c/c − Ø${diaMm} = ${trimNum(mm)} inside`;
      return { mm, from: 'remark', source: `the remark (${how})`, short: 'the remark', note: `the remark, ${how}` };
    }
    return { mm: remarkGap.mm, from: 'remark', source: `the remark ("${remarkGap.text}"${asRead(remarkGap)})`, short: 'the remark', note: `the remark, "${remarkGap.text}"${asRead(remarkGap)}` };
  }
  if (dwgGap) return { mm: dwgGap.mm, from: 'drawing number', source: `the drawing number ("${dwgGap.text}"${asRead(dwgGap)})`, short: 'the drawing number', note: `the drawing number, "${dwgGap.text}"${asRead(dwgGap)}` };
  return { mm: std.insideMm, from: 'standard', source: `the Ø${diaMm} standard (${std.insideMm} inside)`, short: `the Ø${diaMm} standard`, note: `the Ø${diaMm} standard` };
}

// R-f: an inside gap the bend cannot make is refused; one outside the widths
// on her drawings is flagged.
function insideChecks({ insideMm, diaMm }) {
  const blocks = [], flags = [];
  const v = Number(insideMm);
  if (!Number.isFinite(v)) blocks.push(`the inside gap "${insideMm}" is not a number`);
  else if (v < diaMm) blocks.push(`inside gap ${trimNum(v)} mm is less than the tube (Ø${diaMm}) — the U cannot be bent`);
  else if (v > 300) blocks.push(`inside gap ${trimNum(v)} mm is over 300 mm — not a U the app draws`);
  else if (v < INSIDE_SEEN_MM.min || v > INSIDE_SEEN_MM.max) flags.push(`inside gap ${trimNum(v)} mm is outside the widths on your drawings (24–100 inside) — check it`);
  return { blocks, flags };
}

// ── Drawing numbers ──────────────────────────────────────────────────────────
// Upper case; drop PT-, spaces, quotes and underscores; strip a trailing -1/-2/-3
// repeat suffix; ignore -COP / -INC / -PLAIN; then drop the hyphens. Two items
// with the same key are "the same drawing number" — the owner's rule (14 Nov
// 2026) also needs the same tube size, which the caller checks.
function normaliseDwgNo(s) {
  let t = String(s || '').toUpperCase().replace(/[“”″]/g, '"').replace(/[‘’]/g, "'");
  t = t.replace(/[\s"'_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  t = t.replace(/^PT-?/, '');
  t = t.replace(/-[1-9]$/, '');
  t = t.replace(/-(COP|INC|PLAIN)(?=-|$)/g, '');
  return t.replace(/-/g, '');
}
const hasRepeatSuffix = (s) => /-\s*[1-9]\s*$/.test(String(s || '').trim());

// ── Plain-U label (phase 1) ──────────────────────────────────────────────────
// "NNU" or "NN"U", decimals allowed, N under 100 — "18U" = 18 inches from the
// end of the tube to the far end of the U (owner, 14 Nov 2026). nL (UL), nQ (QU),
// Bank, mm, a value of 100 or more (read as mm by the shop), fins, more than one
// element or no U at all are out of phase 1.
function parseULabel(drawingNumber, productCode) {
  // A gap token ("-4Gap", "-100MMGAP") is the inside gap (readDwgGap), not a length.
  const dn = String(drawingNumber || '').replace(/[“”″]/g, '"').replace(new RegExp(DWG_GAP_RE.source, 'gi'), '');
  const pc = String(productCode || '').toUpperCase().replace(/[\s_]/g, '-');
  const up = dn.toUpperCase();
  const out = (reason) => ({ ok: false, reason });
  if (/(^|-)PT-?(QU|QUL|UL|ULTYPE)\b/.test(pc) || /PT[-_]?(QUL?|UL)(TYPE)?[-_]/.test(up)) return out('UL / QU family (phase 2)');
  if (pc && !/^PT-?UTYPE/.test(pc)) return out(`product ${productCode} is not a plain U type`);
  if (/BANK/.test(up)) return out('Bank heater (phase 2)');
  if (/\d\s*MM\b/.test(up)) return out('length given in mm (phase 2)');
  if (/(?:^|[^0-9a-z])\d{1,2}\s*[-_ ]?\s*IN\s*[-_ ]?\s*1(?![0-9])/i.test(dn)) return out('more than one element (phase 2)');
  if (/FIN+S/.test(up)) return out('finned heater (phase 2)');
  // The U token: digits, an optional inch mark, then U, not followed by a digit (UL / QU).
  const m = up.match(/(?:^|[-_\s])(\d+(?:\.\d+)?)\s*"?\s*U(?![A-Z0-9])/);
  if (!m) {
    if (/\d+(?:\.\d+)?\s*"?\s*U\s*\d/.test(up)) return out('UL / QU legs in the number (phase 2)');
    return out('no U length in the drawing number');
  }
  const v = Number(m[1]);
  if (!(v > 0)) return out('no U length in the drawing number');
  if (v >= 100) return out(`"${m[1]}U" reads as millimetres (phase 2)`);
  return { ok: true, uIn: v, label: `${m[1]}U` };
}

// ── Remarks ──────────────────────────────────────────────────────────────────
// Typed by hand (NIPPLLE, BRASDS, NUTE, GEJ, ",,VALA" all occur). Data, never
// instructions: a remark only ever fills a default or raises a question.
function normaliseRemark(r) {
  return String(r || '').toUpperCase()
    .replace(/[“”″]/g, '"').replace(/[‘’]/g, "'").replace(/''/g, '"')
    .replace(/NIPP?L+E/g, 'NIPPLE').replace(/BRAS+D?S/g, 'BRASS').replace(/\bNUTE\b/g, 'NUT')
    .replace(/\bFINN?S?\b/g, 'FINS').replace(/\bCERAMICS\b/g, 'CERAMIC')
    .replace(/\s+/g, ' ').trim();
}
const mmToIn1 = (mm) => round(mm / IN, 1);

// Words the rules here read (the fitting words, the cold zone, the 1" stud
// outside) and plain joining words. A thread size counts as read only where a
// rule reads it: M12 / M14 / M16 with a nipple, M6 with a heavy terminal pin.
const READ_WORDS = new Set(['NUT', 'NUTS', 'WASHER', 'WASHERS', 'AND', 'WITH', 'ONE', 'ONLY', 'CERAMIC', 'HEAVY', 'TERMINAL', 'PIN', 'PINS',
  'CLAMP', 'CLAMPS', 'BRACKET', 'BRACKETS', 'MS', 'SS', 'NIPPLE', 'BRASS', 'FINS', 'COLD', 'ZONE', 'CZ', 'VALA', 'MM', 'INCH', 'INCHES', 'IN',
  'STUD', 'LENGTH', 'OUTSIDE', 'HEATER', 'THE', 'A', 'OF', 'TO']);
// What is left of the remark once every part a rule read or asked about is
// taken out: the words no rule reads, and any measurement (4", 22MM, 7U) no
// rule used. A bare count ("2 CLAMPS") is not a measurement.
function unreadWords(t, read, { nipple, heavy }) {
  const rest = read.filter(Boolean).reduce((s, span) => s.split(span).join(' / '), t).replace(/\bM\s+(\d)/g, 'M$1');
  const out = [];
  const re = /(\d+(?:\.\d+)?)\s*(MM|INCH(?:ES)?|IN|"|U)?(?![A-Z0-9.])|[A-Z][A-Z0-9]*/g;
  let m;
  while ((m = re.exec(rest))) {
    if (m[1] != null) { if (m[2]) out.push(['"', 'U'].includes(m[2]) ? `${m[1]}${m[2]}` : `${m[1]} ${m[2]}`); continue; }
    const w = m[0];
    if (READ_WORDS.has(w)) continue;
    if ((nipple && /^M1[246]$/.test(w)) || (heavy && w === 'M6')) continue;
    out.push(w);
  }
  return [...new Set(out)];
}

// → { coldZones:[{in, text, unit}], coldZoneIn, studOutside, fins, nipple, words, unread[], instructions[] }.
// An instruction is something in the remark the rules cannot apply (a bend, a
// trim, "like last time"…): the owner is asked about it before she approves.
// Words no rule reads are one more instruction, 'other' (review, 14 Nov 2026:
// "Nut Washer with thermostat" or "Buffing" must not come out as ready).
function parseRemark(remark) {
  const t = normaliseRemark(remark);
  const res = { text: t, coldZones: [], coldZoneIn: null, studOutside: false, studNamed: null, fins: false, nipple: null, gap: null, words: {}, unread: [], instructions: [] };
  if (!t) return res;
  const read = [];                      // the parts of the remark a rule read or asked about
  const instr = (kind, text) => { res.instructions.push({ kind, text }); read.push(text); };
  // The inside gap (INSIDE / INNER / GAP n, C/C n): read when it says one thing,
  // asked when it says two. Either way its words are no longer "other" words
  // or a "width / pitch" question (owner, 14 Nov 2026).
  const gaps = readRemarkGaps(t);
  read.push(...gaps.map(g => g.text));
  if (gaps.length && gaps.every(g => g.agree) && new Set(gaps.map(g => `${g.kind}:${g.mm}`)).size === 1) res.gap = gaps[0];
  else if (gaps.length) instr('inside gap', gaps.map(g => g.text).join(' · '));
  const tw = gaps.reduce((s, g) => s.split(g.text).join(' / '), t);
  // Bends are not cold zones: '7" COLD SIDE BEND'.
  if (/COLD\s*SIDE\s*BEND|\bBEND\b/.test(t)) instr('bend', (t.match(/[^/,]*BEND[^/,]*/) || [t])[0].trim());
  // Hot + cold given together, e.g. '12" HOT + 8" COLD. 8" STUD'.
  if (/\bHOT\b/.test(t)) instr('hot + cold', (t.match(/[^/]*HOT[^/]*/) || [t])[0].trim());
  const czRe = /(\d+(?:\.\d+)?)\s*(MM|"|INCH(?:ES)?\b|IN\b)?\s*[,.]*\s*(?:VALA\s*)?(?:COLD\s*ZONE|\bCZ\b|\bCOLD\b(?!\s*SIDE))/g;
  let m;
  while ((m = czRe.exec(t))) {
    const unit = m[2] === 'MM' ? 'mm' : 'in';
    const v = Number(m[1]);
    // A bare large number is not an inch cold zone — nor is it read as mm: asked.
    if (unit === 'in' && !m[2] && v > 24) { instr('cold zone unit', m[0].trim()); continue; }
    res.coldZones.push({ in: unit === 'mm' ? mmToIn1(v) : v, unit, text: m[0].trim() });
    read.push(m[0]);
  }
  if (res.coldZones.length === 1 && !res.instructions.some(i => i.kind === 'hot + cold')) res.coldZoneIn = res.coldZones[0].in;
  if (res.coldZones.length > 1) instr('more than one cold zone', res.coldZones.map(c => c.text).join(' · '));
  // Stud / pin length: the 1" stud outside is a rule (cold zone + 1"); any other is asked.
  const outside = t.match(/STUD\s*LENGTH\s*OUTSIDE[^0-9]*1\s*"|1\s*"\s*STUD\s*OUTSIDE/);
  if (outside) { res.studOutside = true; read.push(outside[0]); }
  else if (/STUD|TERMINAL\s*(PIN\s*)?\d|TERMINAL\s*OUTSIDE|PIN\s*\d+(?:\.\d+)?\s*"\s*LONG/.test(t)) {
    const sm = t.match(/(\d+(?:\.\d+)?)\s*"\s*STUD/);
    if (sm) res.studNamed = Number(sm[1]);
    instr('stud / pin length', (t.match(/[^/,.]*(STUD|TERMINAL OUTSIDE|TERMINAL PIN \d|PIN \d)[^/,.]*/) || [t])[0].trim());
  }
  if (/TRIM/.test(t)) instr('trim', (t.match(/[^/,]*TRIM[^/,]*/) || [t])[0].trim());
  if (/LIKE\s*LAST\s*TIME|AS\s*(PER\s*)?LAST|SAME\s*AS/.test(t)) instr('like last time', (t.match(/[^/]*(LIKE LAST TIME|LAST|SAME AS)[^/]*/) || [t])[0].trim());
  if (/TOTAL\s*LENGTH/.test(t)) instr('total length stated', (t.match(/TOTAL\s*LENGTH[^/,]*/) || [t])[0].trim());
  if (/PRESSURE/.test(t)) instr('pressure', (t.match(/[^/,]*PRESSURE[^/,]*/) || [t])[0].trim());
  if (/\b(WIDTH|PITCH|CENTRES?|CENTERS?|C\/C|CENTRE TO CENTRE|CENTER TO CENTER)\b/.test(tw)) instr('width / pitch', (tw.match(/[^/,]*(WIDTH|PITCH|CENT|C\/C)[^/,]*/) || [tw])[0].trim());
  if (/STEATITE|CRIMP|FABRICATE|MALE\s*FEMALE/.test(t)) instr('special build', t);
  if (/\b\d+\s*DEGREE|\bDEG\b|°/.test(t)) instr('temperature', (t.match(/[^/,]*DEG[^/,]*/) || [t])[0].trim());
  if (/GAUGE|\bGEJ\b|\bSWG\b/.test(t)) instr('wire gauge stated', (t.match(/[^/,]*(GAUGE|GEJ|SWG)[^/,]*/) || [t])[0].trim());
  const groove = t.match(/WITHOUT\s*GROO?VE/);
  if (groove) { instr('nipple without groove', 'WITHOUT GROOVE'); read.push(groove[0]); }
  // Fitting words.
  res.fins = /\bFINS\b/.test(t);
  const nip = t.match(/\bM\s?(12|14|16)\b[^/]*NIPPLE|NIPPLE[^/]*\bM\s?(12|14|16)\b/);
  if (/NIPPLE/.test(t)) res.nipple = nip ? `M${nip[1] || nip[2]}` : 'unknown';
  res.words = {
    nutWasher: /\bNUT\s*[,&+]?\s*(AND\s*)?WASHERS?\b/.test(t),
    ceramic: /CERAMIC/.test(t),
    ceramicOnly: /CERAMIC\s*ONLY|ONLY\s*(ONE\s*)?CERAMIC/.test(t),
    nut: /\bNUT\b/.test(t) && !/\bNUT\s*[,&+]?\s*(AND\s*)?WASHERS?\b/.test(t),
    heavy: /HEAVY\s*TERMINAL/.test(t),
    m6: /\bM\s?6\b/.test(t),
    clamps: /CLAMP|BRACKET/.test(t),
    nipple: /NIPPLE/.test(t),
  };
  res.unread = unreadWords(t, read, { nipple: res.words.nipple, heavy: res.words.heavy });
  if (res.unread.length) instr('other', res.unread.join(' '));
  return res;
}

// ── Fitting sets ─────────────────────────────────────────────────────────────
// The set drawn in Detail D, from the remark first and the parts list second.
// Keys match uTypeSheet.FITTING_SETS.
const SET_LABEL = {
  nut_washer: 'Nut Washer', ceramic_nut: 'One Ceramic + One Nut', ceramic_only: 'One Ceramic only',
  heavy_pin: 'Heavy Terminal Pin', nut_washer_brackets: 'Nut washer + MS Brackets',
  nipple: 'Brass Nipple', nipple_ceramic_nut: 'Brass Nipple + One Ceramic + One Nut',
};
// The terminal end, from the tube outward, as each set is drawn. Only the nut
// washer order is the owner's: "ESB → SS nut → washer → washer → SS nut"
// ("there is no wire lug in the middle", 14 Nov 2026). Every other set is drawn
// as the app's lists carry it and printed TO CONFIRM until she confirms it once
// on the drawing page (stored in drawing_rulings).
const FITTING_ORDER = {
  nut_washer: ['ESB', 'SS nut', 'washer', 'washer', 'SS nut'],
  ceramic_nut: ['ESB', 'ceramic', 'nut'],
  ceramic_only: ['ESB', 'ceramic'],
  heavy_pin: ['ESB', 'heavy terminal pin (M6 × M4) on the pin end', 'washer', 'washer', 'M6 nut'],
  nut_washer_brackets: ['bracket (clamp) on the legs', 'ESB', 'SS nut', 'washer', 'washer', 'SS nut'],
  nipple: ['brass nipple (with washer, washer, nipple nut on its thread)', 'ESB', 'SS nut', 'washer', 'washer', 'SS nut'],
  nipple_ceramic_nut: ['brass nipple', 'ESB', 'ceramic', 'nut'],
};
const RULED_SETS = { nut_washer: { words: 'ESB, then SS nut, washer, washer, SS nut — there is no wire lug in the middle', at: '2026-11-14' } };

// What a parts list says per heater (lines: [{code, qty}], qty for the order).
function listShape(lines, qty) {
  const per = (re) => (lines || []).filter(l => re.test(String(l.code || ''))).reduce((a, l) => a + Number(l.qty || 0), 0) / (Number(qty) || 1);
  return {
    esb: per(/^ESB-/), nut: per(/^NUT-(SS|BR)-M[45]/), washer: per(/^WSH-(BR|SS)-/), hvpin: per(/^TP-HV-/),
    hvnut: per(/^NUT-HV-/), hvwasher: per(/^WSH-HV-/), bracket: per(/^BKT-/), nipple: per(/^NIP-BR-M\d+-(HEX|ROUND)(-LONG)?$/),
    nipnut: per(/^NIP-BR-M\d+-.*-N$|^NIP-BR-M\d+-HEX-LONG-NUT$/), nipwasher: per(/^IWS-/), fins: (lines || []).some(l => /^FIN-/.test(String(l.code || ''))),
    nippleSize: ((lines || []).map(l => String(l.code || '').match(/^NIP-BR-(M\d+)-/)).find(Boolean) || [])[1] || null,
  };
}

function setFromList(ls) {
  if (ls.nipple > 0) return ls.washer >= 3.5 ? 'nipple' : 'nipple_ceramic_nut';
  if (ls.hvpin > 0) return 'heavy_pin';
  if (ls.bracket > 0 && ls.washer > 0) return 'nut_washer_brackets';
  if (ls.washer >= 3.5 && ls.nut >= 3.5) return 'nut_washer';
  if (ls.nut > 0 && ls.washer === 0) return 'ceramic_nut';
  return null;
}

// → { set, from: 'remark'|'list', nipple, notes[] (list vs remark), fins }
function fittingSetFor(rem, lines, qty) {
  const w = rem.words || {};
  const ls = listShape(lines, qty);
  let set = null;
  if (w.nipple) set = (w.ceramic || (w.nut && !w.nutWasher)) ? 'nipple_ceramic_nut' : 'nipple';
  else if (w.heavy) set = 'heavy_pin';
  else if (w.clamps) set = 'nut_washer_brackets';
  else if (w.ceramic && (w.ceramicOnly || !w.nut)) set = 'ceramic_only';
  else if (w.ceramic) set = 'ceramic_nut';
  else if (w.nutWasher) set = 'nut_washer';
  const from = set ? 'remark' : 'list';
  if (!set) set = setFromList(ls);
  const nipple = set && set.startsWith('nipple') ? ((rem.nipple && rem.nipple !== 'unknown') ? rem.nipple : ls.nippleSize) : null;
  // A bare nipple remark takes its pin end from the list: 4 + 4 nut washer, else ceramic + nut.
  if (set === 'nipple' && from === 'remark' && ls.nipple > 0 && ls.washer < 3.5 && ls.nut > 0) set = 'nipple_ceramic_nut';
  const notes = [];
  const n = (cond, msg) => { if (cond) notes.push(msg); };
  if (set && lines && lines.length) {
    n(Math.abs(ls.esb - 2) >= 0.01, `the list has ${round(ls.esb, 2)} ESB per heater (always 2 on a U)`);
    if (set === 'nut_washer' || set === 'nut_washer_brackets' || set === 'nipple') {
      n(ls.nut !== 4, `"${SET_LABEL[set]}" takes 4 nuts per heater; the list has ${round(ls.nut, 2)}`);
      n(ls.washer !== 4, `"${SET_LABEL[set]}" takes 4 washers per heater; the list has ${round(ls.washer, 2)}`);
    }
    if (set === 'ceramic_nut' || set === 'nipple_ceramic_nut') {
      n(ls.nut !== 2, `"One Ceramic + One Nut" takes 2 nuts per heater; the list has ${round(ls.nut, 2)}`);
      n(ls.washer > 0, `"One Ceramic + One Nut" takes no washers; the list has ${round(ls.washer, 2)} per heater`);
    }
    if (set === 'ceramic_only') n(ls.nut > 0 || ls.washer > 0, `"One Ceramic only" takes no nuts or washers; the list has ${round(ls.nut, 2)} nuts, ${round(ls.washer, 2)} washers per heater`);
    if (set === 'heavy_pin') n(!(ls.hvpin > 0), 'the remark says heavy terminal pin but the list has no heavy terminal pin');
    if (set === 'nut_washer_brackets') n(!(ls.bracket > 0), 'the remark says clamps / brackets but the list has no bracket');
    if (set.startsWith('nipple')) n(!(ls.nipple > 0), 'the remark says nipple but the list has no nipple');
    if (set.startsWith('nipple') && rem.nipple && rem.nipple !== 'unknown' && ls.nippleSize && ls.nippleSize !== rem.nipple) notes.push(`the remark says ${rem.nipple} nipple, the list has ${ls.nippleSize}`);
    const fromList = setFromList(ls);
    if (from === 'remark' && fromList && fromList !== set && !(set === 'ceramic_only' && fromList === 'ceramic_nut')) notes.push(`the list looks like "${SET_LABEL[fromList]}", the remark says "${SET_LABEL[set]}"`);
  }
  return { set, from, nipple, notes, fins: rem.fins || ls.fins };
}

// House wording for the card's fixture text (her app-made cards, Sep–Nov 2026).
function fixtureText(set, rem, nipple, lines) {
  const w = (rem && rem.words) || {};
  // A round nipple on the list is named, as her cards do ("M12 Brass Nipple Round").
  const rnd = (lines || []).some(l => /^NIP-BR-M\d+-ROUND/.test(String(l.code || ''))) ? ' Round' : '';
  switch (set) {
    case 'nut_washer': return 'Nut Washer';
    case 'ceramic_nut': return 'One Ceramic + One Nut';
    case 'ceramic_only': return 'One Ceramic only';
    case 'heavy_pin': return w.m6 ? 'M6 Heavy Terminal Pin' : 'Heavy Terminal Pin';
    case 'nut_washer_brackets': return 'Nut washer + MS Brackets';
    case 'nipple': return `${nipple || 'M12'} Brass Nipple${rnd}`;
    case 'nipple_ceramic_nut': return `${nipple || 'M12'} Brass Nipple${rnd} + One Ceramic + One Nut`;
    default: return '';
  }
}
// ASMBLY: 2 on every nipple item since ORD-172, 1 on everything else.
const asmblyDefault = (set) => (String(set || '').startsWith('nipple') ? '2' : '1');

// ── Dispatch date ────────────────────────────────────────────────────────────
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const weekday = (iso) => WEEKDAY[new Date(`${iso}T12:00:00Z`).getUTCDay()];
// The order's date if set; else today + 6 days (local / export) or + 7 (inventory
// order) — the commonest gaps on her app-made cards.
function dispatchDefault({ orderDispatchDate, orderType, todayIso }) {
  if (orderDispatchDate && isIsoDate(String(orderDispatchDate).slice(0, 10))) {
    const d = String(orderDispatchDate).slice(0, 10);
    return { date: d, weekday: weekday(d), source: 'the order\'s dispatch date' };
  }
  const days = orderType === 'inventory_order' ? 7 : 6;
  const t = new Date(`${todayIso}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + days);
  const d = t.toISOString().slice(0, 10);
  return { date: d, weekday: weekday(d), source: `today + ${days} days (${orderType === 'inventory_order' ? 'inventory order' : 'local / export'}); the order has no dispatch date` };
}

// ── Total length (ruling R1) and the shape drawn ─────────────────────────────
// R1, the owner's ruling (14 Nov 2026): "the total length sent to the job card
// is 2 × U" — she chose "36\"" for 18U, NOT 2U + 0.47". The sheet's TOTAL LENGTH
// callout prints that same figure, and the U is drawn as it actually comes out
// of that tube: 18U on Ø8 with 43 outside measures ≈ 451.2 mm end to end (still
// labelled 18U), because the bend takes (π/2 − 1)·R − d/2 off each leg.
//
// R-e, a PROPOSAL to put to her (14 Nov 2026), switchable here: her ruling drops
// the standard bend's extra centreline (≈ 0.47" on Ø8 / 43 outside). A WIDER U
// takes more tube in its bend (a 4" gap ≈ 1.7" more), so 'bend_extra' adds only
// the DIFFERENCE from that Ø's standard width:
//   extra = [(−W + π(W − d)/2) − (−W_std + π(W_std − d)/2)] / 25.4
// (centreline = 2L − W + π(W − d)/2). A narrower U stays 2U (24 inside would
// take 0.07" off — less than the standard already drops), and at the standard
// width it is exactly 2U, as every sheet and card so far. 'plain_2u' goes back
// to 2U at every width.
const WIDE_U_TOTAL = 'bend_extra';
const bendExtraMm = (W, d) => -W + (Math.PI * (W - d)) / 2;
function totalLength({ uIn, diaMm, outsideWidthMm, mode = WIDE_U_TOTAL }) {
  const Wstd = SHAPE_STANDARD[diaMm].outsideWidthMm;
  const W = outsideWidthMm || Wstd;
  const extra = mode === 'bend_extra' && W > Wstd ? (bendExtraMm(W, diaMm) - bendExtraMm(Wstd, diaMm)) / IN : 0;
  const num = round(2 * uIn + extra, 2);
  const extraIn = round(num - 2 * uIn, 2);
  const formula = extraIn === 0 ? `2 × ${trimNum(uIn)}"` : `2 × ${trimNum(uIn)}" ${extraIn > 0 ? '+' : '−'} ${trimNum(Math.abs(extraIn))}"`;
  const drawn = uLengthForCentreline({ clMm: num * IN, outsideWidthMm: W, tubeDiaMm: diaMm });
  const geo = deriveUShape({ uLengthMm: drawn, outsideWidthMm: W, tubeDiaMm: diaMm });
  return { str: trimNum(num), num, extraIn, formula, mode, drawnULengthMm: drawn, nominalULengthMm: uIn * IN, geo };
}

// ── Cold zone and pin defaults ───────────────────────────────────────────────
// Cold zone: the remark → the latest earlier app card with the same normalised
// number and Ø → the engine standard (Ø8: 2" up to 50" TL, 3" above; Ø11: 3" up
// to 48.5", 4" above). `standardColdZone` is the engine's own function.
function coldZoneDefault({ rem, earlierCard, totalLengthIn, diaMm, standardColdZone }) {
  if (rem && rem.coldZoneIn != null) {
    const c = rem.coldZones[0];
    return { big: rem.coldZoneIn, small: rem.coldZoneIn, source: `the remark ("${c.text}"${c.unit === 'mm' ? ` = ${rem.coldZoneIn}"` : ''})`, override: true };
  }
  if (earlierCard && earlierCard.big != null) {
    return { big: Number(earlierCard.big), small: Number(earlierCard.small ?? earlierCard.big), source: `the earlier app card ${earlierCard.no} (same number and Ø)`, override: true };
  }
  const std = standardColdZone(totalLengthIn, diaMm);
  return { big: std.coldZoneIn, small: std.coldZoneIn, source: `the Ø${diaMm} standard for a ${round(totalLengthIn, 2)}" element`, override: false };
}
// Pin: the engine's figure, or cold zone + 1" when the remark asks for a stud
// outside ("STUD LENGTH OUTSIDE HEATER 1"", item 1907), or for a heavy terminal
// pin with a cold zone stated in the remark (item 2215: 8" → 9").
function pinDefault({ rem, set, coldZone, enginePin }) {
  const plus1 = coldZone.big + 1;
  if (rem && rem.studOutside) return { big: plus1, small: coldZone.small + 1, override: true, source: 'cold zone + 1" — the remark asks for a 1" stud outside the heater' };
  if (set === 'heavy_pin' && rem && rem.coldZoneIn != null && enginePin !== plus1) return { big: plus1, small: coldZone.small + 1, override: true, source: 'cold zone + 1" — heavy terminal pin with the remark\'s cold zone (as on her card for item 2215)' };
  return { big: enginePin, small: null, override: false, source: 'the job card engine (from the cold zone)' };
}

// ── Impossible shapes (refused) and flags ────────────────────────────────────
// Highest surface load on her app-made plain U cards (item 1405, PT-Utype-10U-1.5Kw:
// 14.69 W/cm²); above it the sheet is flagged, not refused.
const MAX_SURFACE_LOAD_SEEN_W_CM2 = 14.7;
function shapeChecks({ geo, outsideWidthMm, drawnULengthMm, czBigIn, czSmallIn, diaMm, wattsPerElement }) {
  const blocks = [], flags = [];
  if (!(geo.straight > 0)) blocks.push('straight leg is zero or less');
  if (!(drawnULengthMm > outsideWidthMm + IN)) blocks.push(`U length ${round(drawnULengthMm, 1)} mm is not more than the outside width + 1" (${round(outsideWidthMm + IN, 1)} mm)`);
  for (const [end, cz] of [['big', czBigIn], ['small', czSmallIn]]) {
    if (geo.straight < (cz + 0.5) * IN) blocks.push(`the ${end}-end leg (${round(geo.straight, 1)} mm straight) is shorter than its ${cz}" cold zone + 0.5"`);
  }
  const heatedMm = geo.clMm - (czBigIn + czSmallIn) * IN;
  if (heatedMm < 4 * IN) blocks.push(`heated length ${round(heatedMm / IN, 2)}" is under 4"`);
  const load = wattsPerElement / (Math.PI * (diaMm / 10) * (heatedMm / 10));
  if (heatedMm > 0 && load > MAX_SURFACE_LOAD_SEEN_W_CM2) flags.push(`surface load ≈ ${round(load, 1)} W/cm² is above the highest on her approved U cards (${MAX_SURFACE_LOAD_SEEN_W_CM2} W/cm²)`);
  return { blocks, flags, heatedMm, surfaceLoad: load };
}

// ── The customer's earlier U widths (R-g: a flag, never a default) ──────────
// The survey of her sheets (14 Nov 2026) found history no safe default: TS is
// 43 / 27 with an M12 nipple and 40 / 24 with nut washer or a heavy pin;
// PT-971 has 64 / 42 and 49 / 27 at Ø11. So it only raises a flag: when, for
// the same customer, Ø and fitting set (this item left out), the commonest
// inside is not this sheet's. rows: [{ item_id, order_code, customer_code, dia,
// set, inside, roller, dwg }].
const shortDwg = (s) => String(s || '').replace(/^PT[-_\s]*U\s*type(?:HE)?[-_\s]*/i, '').trim();
// Only when the inside is the Ø standard by default: an inside she gave, or one
// the remark or the drawing number names, is the client's already. One vote per
// DRAWING (the same number and Ø drawn again is one drawing), a drawing that
// names its own gap ("-4Gap") is that design's and not the customer's habit, and
// it flags only when more than half of the customer's drawings differ (15 Nov
// 2026 — IT's one 4" gap drawing must not outvote their 27s).
function widthHistoryFlag({ rows, customerCode, diaMm, set, itemId, madeInsideMm, insideFrom = 'standard' }) {
  if (!customerCode || !set || insideFrom !== 'standard') return null;
  const same = (rows || []).filter(r => r.customer_code === customerCode && Number(r.dia) === Number(diaMm) && r.set === set
    && Number(r.item_id) !== Number(itemId) && Number(r.inside) > 0 && !readDwgGap(r.dwg));
  if (!same.length) return null;
  const drawings = new Map();     // normalised number → its latest row
  for (const r of same) {
    const k = normaliseDwgNo(r.dwg) || `item ${r.item_id}`;
    if (!drawings.has(k) || Number(r.item_id) > Number(drawings.get(k).item_id)) drawings.set(k, r);
  }
  const by = new Map();
  for (const r of drawings.values()) { const k = round(r.inside, 2); if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
  const differ = [...drawings.values()].filter(r => Math.abs(round(r.inside, 2) - madeInsideMm) >= 0.01).length;
  if (differ * 2 <= drawings.size) return null;
  const top = Math.max(...[...by.entries()].filter(([k]) => Math.abs(k - madeInsideMm) >= 0.01).map(([, a]) => a.length));
  const modes = [...by.entries()].filter(([k, a]) => Math.abs(k - madeInsideMm) >= 0.01 && a.length === top);
  // A tie: the width drawn most recently.
  const [inside, drawn] = modes.sort((a, b) => Math.max(...b[1].map(r => r.item_id)) - Math.max(...a[1].map(r => r.item_id)))[0];
  const list = same.filter(r => drawn.some(x => normaliseDwgNo(x.dwg) === normaliseDwgNo(r.dwg)));
  const rc = new Map();
  for (const r of list) if (r.roller != null) rc.set(r.roller, (rc.get(r.roller) || 0) + 1);
  const roller = [...rc.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const names = [...new Set([...list].sort((a, b) => a.item_id - b.item_id).map(r => `${shortDwg(r.dwg)} ${r.order_code}`))];
  return `Earlier U drawings for ${customerCode} at Ø${diaMm} with ${String(SET_LABEL[set] || set).toLowerCase()} used ${trimNum(inside)} inside${roller != null ? ` (roller ${trimNum(roller)})` : ''}: `
    + `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''} — this sheet uses ${trimNum(madeInsideMm)}. Check the client's drawing.`;
}

// ── The list as the drawing upload would keep it (routes/orders.js) ─────────
// Drops qty ≤ 0 (except Fins) and, on orders after id 452, regular Terminal Pins.
function filteredForResend(lines, orderId, pinsAfterOrderId = 452) {
  return (lines || []).filter(l => Number(l.qty) > 0 || /^finns?$/i.test(String(l.category || '').trim()))
    .filter(l => !(Number(orderId) > pinsAfterOrderId && String(l.category || '').trim().toLowerCase() === 'terminal pin'));
}

// ── Order status classes ─────────────────────────────────────────────────────
// The app's closed set (routes/work.js) plus pending_approval / rejected.
const CLOSED = ['dispatched', 'in_finished_goods', 'resolved_dispatched', 'cancelled', 'closed', 'completed'];
function statusClass(status) {
  if (status === 'pending_approval') return 'pending_approval';
  if (status === 'rejected') return 'rejected';
  if (CLOSED.includes(status)) return 'closed';
  return 'open';
}

// ── The sheet code ───────────────────────────────────────────────────────────
// Three short hashes, one per part of what her approval covers: the order item
// as she saw it, her answers, and everything that would be written (the sheet's
// figures and the job card body). Any change gives a new code; the part that
// changed says what to tell her.
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const shortHash = (v) => sha256Hex(stable(v)).slice(0, 6);
const CODE_PARTS = [['item', 'the order item (quantity, rating, remark, parts list or order)'], ['answers', 'the answers'], ['spec', 'the drawing or the job card figures']];
function sheetCode({ snapshot, answers, spec }) {
  return [shortHash(snapshot), shortHash(answers), shortHash(spec)].join('-');
}
// What differs between two sheet codes, in words; [] when they are equal.
function codeChanges(a, b) {
  const pa = String(a || '').split('-'), pb = String(b || '').split('-');
  if (pa.length !== 3) return ['the sheet code'];
  return CODE_PARTS.filter((_, i) => pa[i] !== pb[i]).map(([, words]) => words);
}

// What must not change between the sheet she saw and the write.
function itemSnapshot({ order, item, lines, drawingCount, cardCount, legacyCardCount }) {
  return {
    order: { type: order.order_type, statusClass: statusClass(order.status), dispatch: order.dispatch_date ? String(order.dispatch_date).slice(0, 10) : null,
      bypass: !!order.drawing_bypassed, replacement: order.replacement_query_id || order.replacement_of_order_id || null },
    item: { dwg: item.drawing_number, product: item.product_code, qty: Number(item.quantity), w: Number(item.wattage), v: Number(item.voltage),
      tube: item.tube_material, dia: Number(item.tube_diameter), remark: String(item.remark || '').trim(), plating: item.plating_instructions || null,
      fittings: item.fittings || null, bomReview: item.bom_review || null, deducted: !!item.inventory_deducted },
    lines: (lines || []).map(l => ({ id: l.id, inv: l.inventory_item_id, qty: Number(l.qty), rework: Number(l.rework_qty) || 0,
      deducted: Number(l.qty_deducted) || 0, waived: Number(l.qty_waived) || 0 })).sort((a, b) => a.id - b.id),
    drawings: drawingCount, cards: cardCount, legacyCards: legacyCardCount,
  };
}
// Field paths whose values differ between two snapshots (for the refusal message).
function snapshotDiff(a, b, prefix = '') {
  if (stable(a) === stable(b)) return [];
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return [prefix || 'item'];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(k => snapshotDiff(a[k], b[k], prefix ? `${prefix}.${k}` : k));
}

module.exports = {
  IN, round, trimNum, SHAPE_STANDARD, PHASE1_DIAMETERS, normaliseDwgNo, hasRepeatSuffix, parseULabel,
  OPENING_MM, ROLLER_TOL_MM, DEFAULT_ROLLERS, DEFAULT_ROLLERS_SOURCE, INSIDE_SEEN_MM, validateRollers, pickRoller,
  gapToMm, readDwgGap, readRemarkGaps, insideDefault, insideChecks, WIDE_U_TOTAL, widthHistoryFlag, shortDwg,
  normaliseRemark, parseRemark, listShape, setFromList, fittingSetFor, SET_LABEL, FITTING_ORDER, RULED_SETS,
  fixtureText, asmblyDefault, isIsoDate, weekday, dispatchDefault, totalLength, coldZoneDefault, pinDefault,
  shapeChecks, MAX_SURFACE_LOAD_SEEN_W_CM2, filteredForResend, CLOSED, statusClass,
  stable, sha256Hex, sheetCode, codeChanges, itemSnapshot, snapshotDiff,
};
