// ── True part sizes for the sheet (owner, 16 Nov 2026) ───────────────────────
// "you can also get the inventory's like finns and esb that is the ceramic bead,
// or any other material that goes onto the heater from the inventory for its
// dia and dimensions for accurate drawings". Every coded part on a U sheet is
// drawn at its own size when the app knows it:
//   1. partSizes.json — a SNAPSHOT of 16 Nov 2026: what her item drawings and
//      the inventory notes said that day (never updated by the app);
//   2. the item's CURRENT inventory notes, read on every sheet: a size typed
//      into Inventory later is used, and wins over the snapshot for that one
//      field only ("OD-7.93" replaces the drawing's 7.9; the drawing's other
//      figures stay).
// A part with no size anywhere is left out — the sheet draws it at the usual
// size and its notes say "size not in inventory".
//   parseSizeNotes(notes, kind)   the sizes one note gives (pure; tested)
//   mergeSizes(code, seed, notes) the snapshot + the note, field by field (pure)
//   partSizesFor(db, codes)       the sizes for a sheet's codes
const SEED = require('./partSizes.json').parts;

const IN = 25.4;
const r2 = (n) => Math.round(Number(n) * 100) / 100;

// What a code is on the heater (the sheet's Detail D roles, by the codes the
// app's lists use). null = not a part with a size (coil, tube, MgO, lugs…).
function kindOf(code) {
  const c = String(code || '').trim().toUpperCase();
  if (/^ESB-/.test(c)) return 'esb';
  if (/^NUT-(SS|BR|HV)-/.test(c)) return 'nut';
  if (/^WSH-(SS|BR|HV)-/.test(c)) return 'washer';
  if (/^PVC-FB/.test(c)) return 'fbush';
  if (/^NIP-.*(-N|-NUT)$|^NT-WSH-/.test(c)) return 'nipnut';
  if (/^NIP-/.test(c)) return 'nipple';
  if (/^IWS-/.test(c)) return 'nipwasher';
  if (/^BKT-/.test(c)) return 'bracket';
  if (/^FIN-/.test(c)) return 'fin';
  if (/^TP-/.test(c)) return 'pin';
  return null;
}

// The thread the code names: M4 / M5 pins and nuts, M12 / M14 / M16 nipples,
// and a heavy terminal pin's M6 stud on its M4 pin end ("M6XM4").
function threadOf(code) {
  const c = String(code || '').trim().toUpperCase();
  const hv = c.match(/^TP-HV-M(\d+)\s*X\s*M(\d+)/);
  if (hv) return { thread: `M${hv[1]}`, pinThread: `M${hv[2]}` };
  const m = c.match(/^(?:TP|NUT|NIP)-[A-Z]+-M(\d+)/);
  return m ? { thread: `M${m[1]}` } : {};
}

// ── Reading one note ──────────────────────────────────────────────────────────
// Typed by hand, e.g. "ESB 8mm OD-7.93, Height: 4.3, Hole: 4.2", "Washer -
// 8mmOd-9mm,ID-4.45 Thickness-0.60", "Washer -11mm SSOD-10.29", "FB 8mm - M4 PVC
// Bush Top ( OD: 9.2, ID: 3.8) Back OD: 7.2 Height: 6.8", "Bracket … Thickness-
// 1.25, Length-75.63,Hight-37.06,Hole-7.88,Mid Hole-10.51", "M12 Brass Nipple -
// Hex L-26.5MM, HOLE 9( OD-13MM,ID-8MM), Grove(2.2)" (the 9 is a "(" typed
// without shift), "Thickness=3.47,Thread=2.22,Head=1.35,Coil Head=2.11" (pins).
// Figures are mm; one marked Inch is converted, and dropped when that makes no
// sense for the part (a nipple "L 33.2 Inch").
const NUM = '(\\d+(?:\\.\\d+)?)';
// A label and its figure need a mark between them ("OD-7.93", "OD: 9.2",
// "Len :- 90mm", "Grove(2.2)"): the item's own name ("Full Mid Hole 11 MM") is
// not a size.
const SEP = '\\s*(?:[:=\\-]+\\s*\\(?|\\()\\s*';
const UNIT = '\\s*(MM|INCH(?:ES)?|IN\\b|")?';
const normNote = (s) => String(s || '').toUpperCase()
  .replace(/[–—]/g, '-').replace(/[“”″]/g, '"')
  .replace(/(\d)\s*MM(?=[A-Z])/g, '$1MM ')                 // "8mmOD=8mm" → "8MM OD=8MM"
  .replace(/\b(SS|MS|BR)(OD|ID)(?=[^A-Z]|$)/g, '$1 $2')    // "SSOD-10.29" → "SS OD-10.29"
  .replace(/HEX(?=L\s*[-=:])/g, 'HEX ')                     // "_HexL-30.1" → "HEX L-30.1"
  .replace(/\s+/g, ' ').trim();

// Every "LABEL - n" in s → [{ n, unit }], and s with those taken out.
function take(s, label) {
  const re = new RegExp(`(?<![A-Z])(?:${label})(?![A-Z])${SEP}\\(?\\s*${NUM}${UNIT}\\)?`, 'g');
  const found = [];
  const rest = s.replace(re, (_, n, unit) => { found.push({ n: Number(n), unit: unit || null }); return ' ; '; });
  return { found, rest };
}

// → { fields: {…Mm}, raw: {…} (figures whose meaning the note does not state),
//     ignored: [why], describesOther: null | 'the nipple nut' | 'the nipple' }.
function parseSizeNotes(notes, kind) {
  const out = { fields: {}, raw: {}, ignored: [], describesOther: null };
  let s = normNote(notes);
  if (!s) return out;
  // The nipple's and its nut's notes typed on each other's line (NIP-BR-M12-HEX /
  // -HEX-N on 16 Nov 2026): a note that names the other part is not used.
  if (kind === 'nipple' && /NIPPLE\s*NUT/.test(s)) { out.describesOther = 'the nipple nut'; return out; }
  if (kind === 'nipnut' && /NIPPLE/.test(s) && !/NUT/.test(s)) { out.describesOther = 'the nipple'; return out; }
  const mm = (f, what, { max = 150 } = {}) => {
    if (!f) return null;
    if (f.unit && f.unit !== 'MM') {
      const v = r2(f.n * IN);
      if (v > max) { out.ignored.push(`${what} ${f.n} ${f.unit === '"' ? '"' : 'inch'} (${v} mm) cannot be right for this part`); return null; }
      return v;
    }
    return f.n;
  };
  const first = (label) => { const t = take(s, label); s = t.rest; return t.found[0] || null; };
  // Groups first: a filling bush's TOP (OD, ID) and BACK OD; a nipple's HOLE (OD, ID).
  const group = (head) => {
    const m = s.match(new RegExp(`(?<![A-Z])${head}\\s*9?\\s*\\(([^)]*)\\)?`));
    if (!m) return null;
    s = s.replace(m[0], ' ; ');
    let g = m[1];
    const od = take(g, 'OD'); g = od.rest;
    const id = take(g, 'ID'); g = id.rest;
    const hd = take(g, 'HEAD');
    return { od: od.found[0] || null, id: id.found[0] || null, head: hd.found[0] || null };
  };
  const top = group('TOP');
  const hole = group('HOLE');
  const back = first('BACK\\s*OD');
  const groove = first('GRO+VE');
  const midHole = first('MID\\s*HOLE');
  const coilHead = first('COIL\\s*HEAD');
  const thread = first('THREAD(?:\\s*THICKNESS)?');
  const thick = first('THICKNES+|THK');
  const height = first('HEIGHT|HIGHT');
  const length = first('LENGTH|LEN|L');
  const head = first('HEAD');
  const pitch = first('PITCH');
  const holeBare = first('HOLE');
  const od = first('OD');
  const id = first('ID');

  const f = out.fields;
  const set = (k, v) => { if (v != null && v > 0) f[k] = r2(v); };
  switch (kind) {
    case 'fbush':
      set('headOdMm', mm(top?.od, 'top OD')); set('idMm', mm(top?.id, 'top ID') ?? mm(id, 'ID') ?? mm(holeBare, 'hole'));
      set('spigotOdMm', mm(back, 'back OD')); set('lenMm', mm(height, 'height') ?? mm(length, 'length'));
      set('odMm', mm(od, 'OD') ?? (f.headOdMm || f.spigotOdMm ? Math.max(f.headOdMm || 0, f.spigotOdMm || 0) : null));
      break;
    case 'nipple':
      set('lenMm', mm(length, 'length')); set('holeOdMm', mm(hole?.od, 'hole OD')); set('idMm', mm(hole?.id, 'hole ID') ?? mm(id, 'ID') ?? mm(holeBare, 'hole'));
      set('grooveMm', mm(groove, 'groove')); set('odMm', mm(od, 'OD'));
      if (hole?.head) out.raw.head = hole.head.n;
      if (head) out.raw.head = head.n;
      break;
    case 'bracket':
      set('thkMm', mm(thick, 'thickness')); set('lenMm', f.thkMm); set('footLenMm', mm(length, 'length'));
      set('hMm', mm(height, 'height')); set('holeMm', mm(holeBare, 'hole')); set('midHoleMm', mm(midHole, 'mid hole'));
      break;
    case 'pin':
      // "Thickness" on a pin note is the pin's own Ø; the rest are kept as typed.
      set('odMm', mm(thick, 'thickness') ?? mm(od, 'OD')); set('lenMm', mm(length, 'length', { max: 1000 }));
      if (thread) out.raw.thread = thread.n;
      if (head) out.raw.head = head.n;
      if (coilHead) out.raw.coilHead = coilHead.n;
      break;
    case 'fin':
      set('odMm', mm(od, 'OD')); set('idMm', mm(id, 'ID') ?? mm(holeBare, 'hole')); set('thkMm', mm(thick, 'thickness')); set('pitchMm', mm(pitch, 'pitch'));
      break;
    default:     // esb, nut, washer, nipnut, nipwasher
      set('odMm', mm(od, 'OD')); set('idMm', mm(id, 'ID') ?? mm(holeBare, 'hole'));
      set('lenMm', mm(thick, 'thickness') ?? mm(height, 'height') ?? mm(length, 'length'));
      if (kind === 'esb') set('headLenMm', mm(head, 'head'));
      else if (head) out.raw.head = head.n;
  }
  // A bore as big as the part cannot be (NIP-SS-OAK-N: "ID=120.10" on a 22.22 OD).
  if (f.idMm != null && f.odMm != null && f.idMm >= f.odMm) { out.ignored.push(`ID ${f.idMm} is not less than OD ${f.odMm}`); delete f.idMm; }
  return out;
}

// The fields the outline is drawn from: a note that differs from the snapshot
// by more than 0.3 mm AND 10 % is reported (one of the two is wrong), and the
// note is used. A bore (a thread's nominal vs its minor) is not compared.
const OUTLINE = ['odMm', 'lenMm', 'hMm', 'wMm', 'footLenMm', 'headOdMm', 'spigotOdMm'];
const hasSize = (e) => !!e && Object.entries(e).some(([k, v]) => /Mm$/.test(k) && Number(v) > 0);
function mergeSizes(code, seed, parsed) {
  const notes = (parsed && parsed.fields) || {};
  const conflicts = [];
  const { source: seedSource = null, ...seedFields } = seed || {};
  for (const k of OUTLINE) {
    const a = notes[k], b = seedFields[k];
    if (a != null && b != null && Math.abs(a - b) > 0.3 && Math.abs(a - b) / Math.max(a, b) > 0.1) conflicts.push({ code, field: k, notes: a, seed: b, seedSource });
  }
  const used = Object.keys(notes).filter(k => seedFields[k] == null || Math.abs(seedFields[k] - notes[k]) > 1e-9);
  const merged = { ...seedFields, ...notes };
  if (!hasSize(merged)) return { entry: null, conflicts };
  const source = !seed ? 'inventory notes'
    : used.length ? `${seedSource} + inventory notes (${used.map(k => k.replace(/Mm$/, '')).join(', ')})` : seedSource;
  return { entry: { ...merged, source }, conflicts };
}

// The sizes for the coded parts on one sheet. → { sizes: { CODE: entry },
// missing: [codes with no size anywhere], conflicts: [{code, field, notes, seed,
// seedSource}], ignored: [{code, why}] }. Codes the app does not know a kind for
// (coil, tube, MgO) are left out.
async function partSizesFor(db, codes) {
  const want = new Map();
  for (const c of codes || []) {
    const code = String(c || '').trim();
    if (code && kindOf(code) && !want.has(code.toUpperCase())) want.set(code.toUpperCase(), code);
  }
  const out = { sizes: {}, missing: [], conflicts: [], ignored: [] };
  if (!want.size) return out;
  const rows = await db.all('SELECT upper(trim(item_code)) AS code, notes FROM inventory_items WHERE upper(trim(item_code)) = ANY($1)', [[...want.keys()]]);
  const notesOf = new Map(rows.map(r => [r.code, r.notes]));
  for (const [up, code] of want) {
    const kind = kindOf(up);
    const parsed = parseSizeNotes(notesOf.get(up), kind);
    if (parsed.describesOther) out.ignored.push({ code, why: `its inventory notes describe ${parsed.describesOther} — not used` });
    for (const why of parsed.ignored) out.ignored.push({ code, why: `inventory notes: ${why} — not used` });
    const seed = SEED[up] ? { ...SEED[up] } : null;
    const { entry, conflicts } = mergeSizes(code, seed, parsed);
    out.conflicts.push(...conflicts);
    if (!entry) { out.missing.push(code); continue; }
    out.sizes[code] = { kind, ...threadOf(up), ...entry, ...(Object.keys(parsed.raw).length ? { notesRaw: parsed.raw } : {}) };
  }
  return out;
}

module.exports = { SEED, kindOf, threadOf, parseSizeNotes, mergeSizes, partSizesFor, hasSize };
