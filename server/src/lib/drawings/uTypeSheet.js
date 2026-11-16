// ── U type heater drawing: one A3 production sheet (owner, 14 Nov 2026) ──────
// "start with U type, show me a sample sheet keeping in mind how orders come in
// and are typed". The sheet follows the two drawings the owner liked (the 6 kW
// duct heater for Arihant Tec and the 9 kW steam generator heater) and keeps the
// conventions of PHE's own SolidWorks drawings: the TOTAL LENGTH / DIAMETER /
// ROLLER callout is the DRAWING length (the job card adds its 0.7" itself), the
// top strip, and the title-block fields the floor reads. Nothing is worked out
// here — the spec handed in already holds the order as typed, the shape, the
// job card engine's figures and the parts; this file only lays them out.
//
// Used by the in-app drawing agent (lib/drawings/agent.js, the Drawings to make
// page): the sheet she approves there is the one stored on the order item.
const K = require('./svgKit');

// U shape from the numbers design gives: U length L ("18U" = 18", from the end
// of the tube to the far end of the U — owner, 14 Nov 2026), outside width W
// across both legs, tube Ø d. Checked against every U drawing in the app (14 Nov
// 2026): 122 exact, 13 more to the hundredth — PHE drawings cut to two
// decimals, so this does too.
function deriveUShape({ uLengthMm, outsideWidthMm, tubeDiaMm }) {
  const cc = outsideWidthMm - tubeDiaMm;                 // leg centre to centre
  const rCL = cc / 2;                                     // bend radius on the centreline
  const straight = uLengthMm - (rCL + tubeDiaMm / 2);     // each leg, tube end to bend start
  const clMm = 2 * straight + Math.PI * rCL;              // whole tube along its centreline
  return { cc, rCL, straight, clMm, insideMm: outsideWidthMm - 2 * tubeDiaMm,
           drawingTotalIn: Math.floor((clMm / 25.4) * 100 + 1e-9) / 100 };
}

// The U length whose tube measures clMm along its centreline — the inverse of
// the above. Used when the total length is ruled to be exactly 2U (ruling R1
// (b)): the legs are drawn that much shorter so the sheet still adds up.
function uLengthForCentreline({ clMm, outsideWidthMm, tubeDiaMm }) {
  const rCL = (outsideWidthMm - tubeDiaMm) / 2;
  return (clMm - Math.PI * rCL) / 2 + rCL + tubeDiaMm / 2;
}

const C = {
  heated: '#f2d7bf', cold: '#e2e6eb', sheath: '#1a1a1a', pin: '#a7adb4', esb: '#3f3f3f',
  ss: '#b9c0c7', brass: '#d8b75c', green: '#1f7a3a', red: '#b42318', blue: '#2f5597',
  ceramic: '#f4eedc', fibre: '#b5523b', silicone: '#f3f3f3', ms: '#8d939a',
};
const n2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
const n1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

// ── Fitting sets ─────────────────────────────────────────────────────────────
// What goes on each terminal end, in the order it is fitted. `pin` runs from the
// sealing bush (ESB) outward along the terminal pin; `tube` is what sits on the
// tube itself (brackets, the nipple and its washers and nut). Only the nut
// washer order is the owner's (14 Nov 2026: "ESB, then SS nut, washer, washer,
// SS nut — there is no wire lug in the middle"); every other set is drawn as the
// app's lists carry it and printed TO CONFIRM until she confirms its order.
const FITTING_SETS = {
  nut_washer:          { label: 'Nut Washer', pin: ['nut', 'washer', 'washer', 'nut'], tube: [] },
  ceramic_nut:         { label: 'One Ceramic + One Nut', pin: ['ceramic', 'nut'], tube: [] },
  ceramic_only:        { label: 'One Ceramic only', pin: ['ceramic'], tube: [] },
  heavy_pin:           { label: 'Heavy Terminal Pin', pin: ['hvpin', 'hvwasher', 'hvwasher', 'hvnut'], tube: [] },
  nut_washer_brackets: { label: 'Nut Washer + Brackets', pin: ['nut', 'washer', 'washer', 'nut'], tube: ['bracket'] },
  nipple:              { label: 'Brass Nipple + Nut Washer', pin: ['nut', 'washer', 'washer', 'nut'], tube: ['nipple', 'nipwasher', 'nipwasher', 'nipnut'] },
  nipple_ceramic_nut:  { label: 'Brass Nipple + One Ceramic + One Nut', pin: ['ceramic', 'nut'], tube: ['nipple'] },
};

// Sizes in real millimetres: t along the pin / tube, h across it.
function partSizes(dia, nipple) {
  const m5 = Number(dia) === 11;
  const m16 = String(nipple || '').toUpperCase() === 'M16';
  return {
    nut: { t: m5 ? 4 : 3.2, h: m5 ? 8 : 7 },
    washer: { t: m5 ? 1 : 0.8, h: m5 ? 10 : 9 },
    ceramic: { t: m5 ? 7 : 6, h: m5 ? 12 : 10 },
    // M6 × M4 heavy terminal pin: a hex body screwed on the pin end, an M6 stud out.
    hvpin: { t: 3, h: 10, studT: 6, studH: 6 },
    hvwasher: { t: 1, h: 12 },
    hvnut: { t: 5, h: 10 },
    bracket: { t: 2, h: Number(dia) + 8 },
    nipple: m16 ? { t: 7, h: 22, threadT: 16, threadH: 16 } : { t: 6, h: 17, threadT: 14, threadH: 12 },
    nipwasher: m16 ? { t: 2, h: 24 } : { t: 1.5, h: 18 },
    nipnut: m16 ? { t: 7, h: 22 } : { t: 6, h: 17 },
  };
}

// The set the spec names, with its parts; an unknown set draws the ESB only.
// `nuts` (two list codes, from the ESB outward) says which nut line sits at
// each of a two-nut stack's places: the second place is drawn as role 'nut2'
// so it can carry its own part — an SS nut and a brass nut on one pin end.
function resolveFitting(spec) {
  const f = spec.fitting || {};
  const base = FITTING_SETS[f.set] || (f.set ? { label: f.set, pin: [], tube: [] } : FITTING_SETS.nut_washer);
  let pin = Array.isArray(f.pin) ? f.pin : base.pin;
  const nuts = Array.isArray(f.nuts) && f.nuts.length === 2 && f.nuts.every(Boolean) && pin.filter(rl => rl === 'nut').length === 2 ? f.nuts : null;
  if (nuts) pin = pin.map((rl, i) => (rl === 'nut' && i === pin.lastIndexOf('nut') ? 'nut2' : rl));
  return {
    set: f.set || 'nut_washer',
    label: f.label || base.label,
    pin,
    tube: Array.isArray(f.tube) ? f.tube : base.tube,
    nipple: f.nipple || null,
    nuts,
    // A sheet without a fitting block is the original nut-washer sample.
    confirmed: spec.fitting ? f.confirmed === true : true,
  };
}

function renderUTypeSheet(spec) {
  const { item, tube, shape, geo, card, parts, notes, tb } = spec;
  const out = [];
  const W = 420, H = 297;
  const fit = resolveFitting(spec);
  const sz = partSizes(tube.diaMm, fit.nipple);
  sz.nut2 = sz.nut;
  const stud = /M5/i.test(String(card.studLabel || '')) || Number(tube.diaMm) === 11 ? 'M5' : 'M4';
  const pinThread = stud === 'M5' ? 5 : 4;
  const totalStr = spec.r1?.totalLengthStr != null ? String(spec.r1.totalLengthStr) : n2(geo.drawingTotalIn);
  const r1Mode = spec.r1?.mode || null;
  // Which list line each fitting is (its balloon number) and how it is named.
  const roleOf = (p) => p.role || ({ ssnut: 'nut' }[p.key] || p.key);
  // A two-nut stack names the line at each place (fit.nuts, from the ESB
  // outward — the agent works it out from the list and her answer, owner
  // 14 Nov 2026), so an SS and a brass nut each point at their own line. A
  // sheet without it draws the SS line at both places when the list has one:
  // her order names SS nuts ("ESB → SS nut → washer → washer → SS nut").
  const ssNutStack = fit.pin.filter(rl => rl === 'nut').length === 2;
  const partFor = (role) => {
    if (fit.nuts && (role === 'nut' || role === 'nut2')) {
      const want = String(fit.nuts[role === 'nut' ? 0 : 1]).toUpperCase();
      return parts.find(p => roleOf(p) === 'nut' && String(p.code || '').toUpperCase() === want);
    }
    const all = parts.filter(p => roleOf(p) === role);
    return (role === 'nut' && ssNutStack && all.find(p => /^NUT-SS-/i.test(String(p.code || '')))) || all[0];
  };
  const no = (role) => partFor(role)?.no ?? '–';
  // An order on the old pin rule takes its pins from the item's list (role
  // 'listpin'); a newer one from the job card (pinwh / pinwo).
  const listPinNos = (parts || []).filter(p => roleOf(p) === 'listpin').map(p => p.no);
  const pinNos = listPinNos.length ? listPinNos : [no('pinwh'), no('pinwo')];
  const codeOf = (role) => String(partFor(role)?.code || (fit.nuts && role === 'nut2' ? fit.nuts[1] : fit.nuts && role === 'nut' ? fit.nuts[0] : ''));
  const nutFill = (role) => (/-BR-/i.test(codeOf(role)) ? C.brass : C.ss);
  const nutName = (role) => (/-BR-/i.test(codeOf(role)) ? (fit.nuts ? 'brass nut' : 'nut') : 'SS nut');
  const washerFill = /WSH-SS/i.test(codeOf('washer')) ? C.ss : C.brass;
  const FILL = { nut: nutFill('nut'), nut2: nutFill('nut2'), washer: washerFill, ceramic: C.ceramic, hvpin: C.ss, hvwasher: C.ss, hvnut: C.ss,
    bracket: C.ms, nipple: C.brass, nipnut: C.brass, nipwasher: /SIL/i.test(codeOf('nipwasher')) ? C.silicone : C.fibre };
  const NAME = {
    nut: nutName('nut'), nut2: nutName('nut2'), washer: 'washer', ceramic: 'ceramic', hvpin: 'heavy pin',
    hvwasher: 'washer', hvnut: 'M6 nut', bracket: 'bracket', nipple: `${fit.nipple || ''} nipple`.trim(),
    nipnut: 'nipple nut', nipwasher: /SIL/i.test(codeOf('nipwasher')) ? 'silicone washer' : 'fibre washer',
  };
  const stageOf = (role) => {
    const st = partFor(role)?.stage;
    const s = Array.isArray(st) ? st[0] : st;
    if (s) return s;
    return ({ esb: 'St 23', nipple: 'St 21', nipwasher: 'St 21', nipnut: 'St 21' })[role] || 'St 26';
  };
  // ── True sizes from the inventory (owner, 16 Nov 2026: "you can also get the
  // inventory's like finns and esb that is the ceramic bead, or any other
  // material that goes onto the heater from the inventory for its dia and
  // dimensions for accurate drawings"). spec.partSizes holds, by item code,
  // what the item's notes and drawing give; a part without one keeps the
  // generic size above, and a sheet without partSizes is drawn as before.
  const PS = {};
  for (const [k, v] of Object.entries(spec.partSizes || {})) if (v && typeof v === 'object') PS[String(k).trim().toUpperCase()] = v;
  const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const trueOf = (role) => PS[String(codeOf(role)).trim().toUpperCase()] || null;
  // Nuts and washers: thickness along the pin, OD across it.
  for (const role of ['nut', 'nut2', 'washer', 'hvwasher', 'hvnut', 'nipnut', 'nipwasher']) {
    const t = trueOf(role), od = num(t?.odMm), len = num(t?.lenMm);
    if (od && len) sz[role] = { t: len, h: od };
  }
  // A heavy pin's hex body (head) and M6 stud (spigot), when both are known.
  {
    const t = trueOf('hvpin'), hOd = num(t?.headOdMm), hLen = num(t?.headLenMm);
    if (hOd && hLen) sz.hvpin = { t: hLen, h: hOd, studT: num(t.spigotLenMm) || sz.hvpin.studT, studH: num(t.spigotOdMm) || sz.hvpin.studH };
  }
  // A nipple: its head (hex or round) and the threaded body; her notes give
  // the length L and the thread ("hole") OD, the head only on some.
  {
    const t = trueOf('nipple'), g = sz.nipple;
    const thOd = num(t?.spigotOdMm) || num(t?.holeOdMm) || num(t?.odMm), len = num(t?.lenMm), hOd = num(t?.headOdMm), hLen = num(t?.headLenMm);
    if (t && (thOd || len || hOd)) {
      const headT = hLen || g.t;
      const threadT = num(t.spigotLenMm) || (len && len > headT ? len - headT : g.threadT);
      sz.nipple = { t: headT, h: hOd || Math.max(g.h, (thOd || 0) + 2), threadT, threadH: thOd || g.threadH };
    }
  }
  // The ESB is the ceramic bead (owner, 16 Nov 2026). ESB-08 / ESB-11 are plain
  // beads that sit on the tube end (OD ≈ the tube's, wider than its bore); a
  // bush whose spigot fits the bore gets the spigot drawn dashed in the tube.
  // ESB-11's ends are chamfered 45° from Ø10.9 to Ø9.9 (her drawing).
  // No ESB line on the list: the agent names the Ø's usual one (spec.esbStd),
  // drawn at its size and marked not on the list (review, 16 Nov 2026).
  const esbStdCode = !partFor('esb') && spec.esbStd ? String(spec.esbStd).trim().toUpperCase() : null;
  const esbG = (() => {
    const t = trueOf('esb') || (esbStdCode ? PS[esbStdCode] || null : null);
    const od = num(t?.headOdMm) || num(t?.odMm), len = num(t?.lenMm), hLen = num(t?.headLenMm);
    if (!od || !(len || hLen)) return null;
    const bore = Number(tube.diaMm) - 2 * (Number(tube.wallMm) || 0);
    let spT = num(t.spigotLenMm);
    const spH = num(t.spigotOdMm);
    if (!spT && spH && hLen && len && len > hLen) spT = len - hLen;
    const spigot = spT && spH && spH <= bore ? { t: spT, h: spH } : null;
    const outT = spigot ? (hLen || (len && len > spT ? len - spT : spT)) : (len || hLen);
    const toOd = num(t.chamferToOdMm) || (spH && spH < od ? spH : null);
    const chamfer = (num(t.chamferDeg) || num(t.chamferMm)) && !spigot ? Math.min(1, outT / 4, num(t.chamferMm) || (toOd ? (od - toOd) / 2 : 0.5)) : 0;
    return { t: outT, h: od, id: num(t.idMm), spigot, chamfer };
  })();
  const esbName = esbG ? 'ESB (ceramic bead)' : 'ESB';
  // The terminal pin's own thickness (her notes: "Thickness=3.48") when known.
  const pinDia = (() => {
    const ps = listPinNos.length ? parts.filter(p => roleOf(p) === 'listpin') : [partFor('pinwh'), partFor('pinwo')];
    const ds = ps.map(p => p && num(PS[String(p.code || '').trim().toUpperCase()]?.odMm)).filter(Boolean);
    return ds.length ? Math.max(...ds) : pinThread;
  })();
  // The bead (left edge x, centred on y) at scale sc: ivory, chamfered corners
  // when the drawing has them, its bore dashed where the pin runs through it.
  const drawEsb = (x, y, sc, { bore = true } = {}) => {
    const w = esbG.t * sc, h2 = (esbG.h * sc) / 2, c = esbG.chamfer * sc, sw = sc >= 1 ? 0.25 : 0.15;
    const o = [];
    if (c > 0.05) {
      o.push(K.path(`M${K.f(x + c)},${K.f(y - h2)} L${K.f(x + w - c)},${K.f(y - h2)} L${K.f(x + w)},${K.f(y - h2 + c)} L${K.f(x + w)},${K.f(y + h2 - c)} L${K.f(x + w - c)},${K.f(y + h2)} L${K.f(x + c)},${K.f(y + h2)} L${K.f(x)},${K.f(y + h2 - c)} L${K.f(x)},${K.f(y - h2 + c)} Z`, { fill: C.ceramic, stroke: '#333', sw }));
    } else o.push(K.rect(x, y - h2, w, 2 * h2, { fill: C.ceramic, stroke: '#333', sw, rx: sc >= 1 ? Math.min(0.4, w / 6) : 0 }));
    if (bore && esbG.id && sc >= 1) for (const dy of [-1, 1]) o.push(K.line(x, y + dy * (esbG.id * sc) / 2, x + w, y + dy * (esbG.id * sc) / 2, { w: 0.15, dash: '0.8 0.5', color: '#666' }));
    if (esbG.spigot) o.push(K.rect(x + w, y - (esbG.spigot.h * sc) / 2, esbG.spigot.t * sc, esbG.spigot.h * sc, { fill: 'none', stroke: '#555', sw: sc >= 1 ? 0.25 : 0.12, dash: sc >= 1 ? '1 0.6' : '0.5 0.35' }));
    return o.join('');
  };

  const toConfirm = !fit.confirmed;
  const redTag = (x, y, label = 'TO CONFIRM', size = 2.3) => {
    const w = label.length * size * 0.6 + 2.4;
    return K.rect(x, y - size - 0.9, w, size + 2, { stroke: C.red, sw: 0.35, fill: '#fff' })
      + K.text(x + 1.2, y, label, { size, weight: 700, color: C.red });
  };

  // One fitting at sheet scale sc, its left edge at x, centred on y. A heavy
  // pin's stud and a nipple's thread are drawn with it.
  // xMax: where the view stops (Detail D's break) — a long nipple's thread is cut there.
  const drawPart = (role, x, y, sc, xMax = Infinity) => {
    const p = sz[role] || { t: 2, h: 6 };
    const o = [];
    const sw = sc >= 1 ? 0.2 : 0.12;
    if (role === 'hvpin') {
      const sx = x - p.studT * sc;
      o.push(K.rect(sx, y - (p.studH * sc) / 2, p.studT * sc, p.studH * sc, { fill: C.pin, stroke: '#444', sw }));
      if (sc >= 1) for (let xx = sx + 0.6; xx < x - 0.4; xx += 1.3) o.push(K.line(xx, y - (p.studH * sc) / 2, xx + 0.8, y + (p.studH * sc) / 2, { w: 0.12, color: '#666' }));
      o.push(K.rect(x, y - (p.h * sc) / 2, p.t * sc, p.h * sc, { fill: FILL.hvpin, stroke: '#333', sw }));
      return o.join('');
    }
    if (role === 'nipple') {
      const hx = x + p.t * sc, tw = Math.min(p.threadT * sc, Math.max(0, xMax - hx));
      o.push(K.rect(hx, y - (p.threadH * sc) / 2, tw, p.threadH * sc, { fill: C.brass, stroke: '#6b5520', sw }));
      if (sc >= 1) for (let xx = hx + 0.6; xx < hx + tw - 0.6; xx += 1.3) o.push(K.line(xx, y - (p.threadH * sc) / 2, xx + 0.8, y + (p.threadH * sc) / 2, { w: 0.12, color: '#8a6d1f' }));
      o.push(K.rect(x, y - (p.h * sc) / 2, p.t * sc, p.h * sc, { fill: C.brass, stroke: '#333', sw }));
      return o.join('');
    }
    if (role === 'bracket') {
      o.push(K.rect(x, y - (p.h * sc) / 2, p.t * sc, p.h * sc, { fill: C.ms, stroke: '#333', sw }));
      return o.join('');
    }
    if (role === 'ceramic') {
      o.push(K.rect(x, y - (p.h * sc) / 2, p.t * sc, p.h * sc, { fill: C.ceramic, stroke: '#333', sw, rx: Math.min(1.2, p.t * sc / 4) }));
      return o.join('');
    }
    o.push(K.rect(x, y - (p.h * sc) / 2, p.t * sc, p.h * sc, { fill: FILL[role] || C.ss, stroke: '#333', sw }));
    return o.join('');
  };
  const partWidth = (role, sc) => { const p = sz[role] || { t: 2 }; return (role === 'hvpin' ? p.t + p.studT : p.t) * sc; };
  const partHalfH = (role, sc) => { const p = sz[role] || { h: 6 }; return (Math.max(p.h, p.threadH || 0) * sc) / 2; };

  // Assembled positions (left edges) along the pin, outward from the ESB face.
  // A heavy pin sits on the pin's end; what follows it goes on its M6 stud.
  // A heavy pin's `mid` is its hex body: its stud is under the washers and nut.
  const layoutPin = (xFace, pinEndX, sc) => {
    let cursor = xFace;
    return fit.pin.map((role) => {
      const p = sz[role] || { t: 2 };
      if (role === 'hvpin') { cursor = pinEndX; return { role, x: pinEndX, mid: pinEndX + (p.t * sc) / 2 }; }
      const x = cursor - p.t * sc; cursor = x;
      return { role, x, mid: x + (p.t * sc) / 2 };
    });
  };
  // On the tube, from the ESB spigot inward: a bracket, or a nipple with its
  // washers and nut on the thread (the tank wall between the two washers).
  const layoutTube = (xm, sc) => {
    const o = [];
    let cursor = xm + 3 * sc;
    let nippleThreadStart = null;
    fit.tube.forEach((role, i) => {
      const p = sz[role] || { t: 2 };
      if (role === 'bracket') { const x = xm + 7 * sc; o.push({ role, x, mid: x + (p.t * sc) / 2 }); return; }
      if (role === 'nipple') { o.push({ role, x: cursor, mid: cursor + (p.t * sc) / 2 }); nippleThreadStart = cursor + p.t * sc; cursor = nippleThreadStart + 2 * sc; return; }
      if (role === 'nipwasher' && fit.tube.slice(0, i).includes('nipwasher')) cursor += 3 * sc;   // the tank wall
      o.push({ role, x: cursor, mid: cursor + (p.t * sc) / 2 });
      cursor += p.t * sc;
    });
    return o;
  };

  // ── Frame, banner and PHE's top strip ──
  out.push(K.rect(8, 8, W - 16, H - 16, { sw: 0.6 }));
  out.push(K.rect(12, 12, W - 24, 7.5, { fill: spec.bannerColor || C.green, stroke: 'none' }));
  out.push(K.text(W / 2, 17.2, spec.banner, { size: 3.0, anchor: 'middle', weight: 700, color: '#fff' }));
  ['REMOVE ALL BURRS AND SHARP EDGES', 'IF IN DOUBT ASK !', 'DO NOT SCALE', 'ALL DIMENSIONS ARE IN MILLIMETRES'].forEach((t, i) => {
    out.push(K.rect(12 + i * 99, 20.5, 99, 5, { sw: 0.25 }));
    out.push(K.text(12 + i * 99 + 49.5, 24, t, { size: 2.2, anchor: 'middle', color: '#333' }));
  });

  // ── Elevation, scale 1:2 or smaller (legs broken when they would not fit) ──
  // The client's inside gap can vary (owner, 14 Nov 2026: "there are times when
  // the u inner dia can varying"): her sheets go from 24 to 42 inside, and a 4"
  // gap. Every row above and below the U keeps its place on a standard sheet and
  // is pushed out by the legs of a wider one; the U is then centred between the
  // view's subtitle and the Detail D title, and when it does not fit there the
  // view is drawn smaller: 1:2 holds up to about 81 outside, 1:3 about 122, 1:4
  // about 162. The title prints the scale used.
  const dia = Number(tube.diaMm);
  const X0 = 36;
  const ELEV_TOP = 37, ELEV_BOTTOM = 131;            // under the subtitle; 1.6 above the Detail D title's letters (132.6)
  // Fins (owner, 16 Nov 2026): "yes, go round the bend and stop 25mm" — they
  // run round the U bend and stop 25 before the tube end, unless her answers
  // say otherwise for the order: "there are sometimes when we dont add the
  // finns to the U bend part" (onBend false: straight legs only, the bend
  // bare). spec.fins carries her answers; the fins' OD and pitch are drawn true.
  const numOr = (v, d) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  const FN = (() => {
    const fn = spec.fins, od = fn ? numOr(fn.odMm, 0) : 0;
    if (!(od > 0)) return null;
    return { od, id: numOr(fn.idMm, null), pitch: numOr(fn.pitchMm, 0) > 0 ? Number(fn.pitchMm) : 3, onBend: fn.onBend !== false,
      stop: Math.max(0, numOr(fn.stopBeforeEndMm, 25)), gap: Math.max(0, numOr(fn.bracketGapMm, 0)),
      // The bend side of the bend-end bracket bare: the leg's fins end this far from the outer end of the U.
      bareTo: numOr(fn.bareToMm, 0) > 0 ? Number(fn.bareToMm) : null, clear: numOr(fn.clearMm, null),
      code: String(fn.code || ''), material: String(fn.material || '').toUpperCase(),
      label: String(fn.label || `${String(fn.material || '').toUpperCase()} FINS${fn.code ? ` (${fn.code})` : ''}`.trim()) };
  })();
  // Brackets (owner, 16 Nov 2026: "or we add finns + brackets", "yes, 1.5" from
  // both ends with a gap"): one 1.5" from the bend — the fins go on past it
  // with a gap at it — and one 1.5" from the terminal end, where "the finns will
  // not come ahead of the terminal end brackets". Her L-bracket (BKT-FMH-H788 /
  // -H1250 drawings): an upright 55 wide with the slots the legs sit in, a
  // 10.8 strip over them held by two M3.5 screws, and a 75.2 foot; on her NTS
  // model both feet point away from the heater's middle.
  const BR = (() => {
    const b = spec.brackets;
    if (!b) return null;
    const z = b.size || {};
    const pos = (v) => Math.max(0, numOr(v, 38.1));
    return { code: String(b.code || ''), perHeater: numOr(b.perHeater, 2), fromBend: pos(b.fromBendMm), fromEnd: pos(b.fromEndMm),
      len: numOr(z.lenMm, 75.2), h: numOr(z.hMm, 36), w: numOr(z.wMm, 55), thk: numOr(z.thkMm, 1.2), strip: numOr(z.lipMm, 10.8), screw: 6.3, screwCC: 36.1 };
  })();
  if (BR) sz.bracket = { t: BR.thk, h: sz.bracket.h };
  else { const t = trueOf('bracket'), th = num(t?.thkMm) || num(t?.lenMm); if (th && th < 5) sz.bracket = { t: th, h: sz.bracket.h }; }
  // How far the drawn heater reaches either side of a leg's centre: the tube,
  // or the fins' OD; the rows also keep clear of the bracket's ends.
  const legEnvMm = Math.max(dia, FN ? FN.od : 0) / 2;
  const rowEnvMm = Math.max(legEnvMm, BR ? BR.w / 2 - geo.cc / 2 : 0);
  // Each row where today's 1:2 sheet has it (U centreline at 79), moved with
  // the U, and pushed out to keep its distance from the leg it labels.
  const rowsAt = (sc, yc) => {
    const hf = (geo.cc / 2) * sc, rr = rowEnvMm * sc;
    const tE = yc - hf - rr, bE = yc + hf + rr;          // the legs' outer edges
    const up = (y, off) => Math.min(yc + (y - 79), tE - off), down = (y, off) => Math.max(yc + (y - 79), bE + off);
    return { yU: up(51, 15.75), yCZ: up(61, 5.75), ySh: up(64.5, 2.25), ySh56: up(56, 10.75), yD: up(66.5, 0.25),
      yPin: down(99, 7.75), yR1: down(103, 11.75), yR2: down(109, 17.75), yH: down(117, 25.75), yDD: down(125, 33.75) };
  };
  let scaleN = 10, Yc = 79;
  for (const n of [2, 3, 4, 5, 6, 8, 10]) {
    const a = rowsAt(1 / n, 79);
    const lo = ELEV_TOP - (a.yU - 2.85 - 79), hi = ELEV_BOTTOM - (a.yDD + 1 - 79);   // U-length figure's top, Detail D label's foot
    const pushed = a.yU < 51 - 1e-9 || a.yDD > 125 + 1e-9;   // the legs moved a row: not a standard sheet
    if (lo <= hi + 1e-9) { scaleN = n; Yc = pushed || !(lo <= 79 && 79 <= hi) ? (lo + hi) / 2 : 79; break; }
  }
  const s = 1 / scaleN, k2 = s / 0.5;                 // k2: a paper size drawn for 1:2, at this scale
  const { yU, yCZ, ySh, ySh56, yD, yPin, yR1, yR2, yH, yDD } = rowsAt(s, Yc);
  const half = (geo.cc / 2) * s, r = (dia / 2) * s;
  const yT = Yc - half, yB = Yc + half;
  // rE: the legs' drawn half-width (the fins' OD on a finned heater); rBend the
  // same at the bend, which is bare when her answer says so.
  const rE = legEnvMm * s, rBend = FN && FN.onBend ? rE : r;
  const ringFits = half + r + 2.75 <= 15.5 + 0.01;   // Detail D's usual circle holds both terminal ends
  // An 18U leg at 1:2 just fits; a wider bend takes more room, and the OUTSIDE
  // dimension right of it must still stop short of the element table (x 276).
  // A bracket's foot (under the heater, pointing away from its middle as on her
  // NTS / SPL models) reaches past the outer end of the U: it too stops short.
  const footPast = BR ? Math.max(0, BR.len - BR.fromBend) * s : 0;
  // The OUTSIDE dimension then goes right of the foot, still short of the table.
  const LEG_MAX = Math.min(217.9, 266.7 - X0 - half - rBend, 271.6 - X0 - half - r - footPast);
  const legPaper = geo.straight * s;
  const broken = legPaper > LEG_MAX + 0.01;
  const Xb = X0 + Math.min(legPaper, LEG_MAX);
  const xOuter = Xb + half + r;
  const xOE = Xb + half + rBend;                      // the far end of what is drawn there (fins round the bend)
  const czBig = card.coldZoneBigIn * 25.4 * s, czSmall = card.coldZoneSmallIn * 25.4 * s;
  const czMax = Math.max(czBig, czSmall);
  const heatedPaper = Math.max(4, Xb - X0 - czMax);
  const pinOut = 25.4 * s;
  // The inside and outside as made (the roller's inside — agent.js), without float tails.
  const fmt = (v) => String(Math.round(Number(v) * 100) / 100);
  const outsideMm = Number(shape.outsideWidthMm);
  const insideMm = shape.insideMm != null && shape.insideMm !== '' ? Number(shape.insideMm) : outsideMm - 2 * dia;
  const rollerKnown = shape.rollerMm != null && shape.rollerMm !== '';
  const rollerTxt = rollerKnown ? `${fmt(shape.rollerMm)}${shape.rollerIsNew ? ' (NEW)' : ''}` : '?';
  // What the tube Ø at the bend must keep clear of, noted as it is drawn:
  // boxes [x1, y1, x2, y2] and segments (leaders, marks, the centreline).
  const nearBend = [];
  const noteBox = (x1, y1, x2, y2, leg = false) => nearBend.push({ b: [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)], leg });
  const noteSeg = (x1, y1, x2, y2) => nearBend.push({ s: [x1, y1, x2, y2] });
  const noteText = (x, y, str, size, anchor = 'start', weight = 400) => {
    const w = K.textWidth(str, size, weight), x1 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
    noteBox(x1, y - 0.72 * size, x1 + w, y + 0.2 * size);
  };
  out.push(K.viewTitle(150, 32, `ELEVATION (SCALE 1:${scaleN})`, broken ? 'Terminal end on the left · as bent · legs broken, true length dimensioned' : 'Terminal end on the left · as bent'));
  const uPath = `M${K.f(X0)},${K.f(yT)} L${K.f(Xb)},${K.f(yT)} A${K.f(half)},${K.f(half)} 0 0 1 ${K.f(Xb)},${K.f(yB)} L${K.f(X0)},${K.f(yB)}`;
  // Brackets on the elevation, as her bracket drawing's top view (BKT-FMH-H788 /
  // -H1250): the U lies in the paper, so a bracket shows as its foot — a plate
  // 75.2 × 55 under the heater with four Ø7.9 holes and a 21.5 × 9.2 slot near
  // its far end — the upright (the plate's 1.2 edge, where the legs sit in its
  // slots) and, over the legs, its 10.8 clamp strip with two M3.5 cross-head
  // screws at 36.1 c/c. Both feet point away from the heater's middle, as on her
  // NTS (d114) and SPL (d157) models (owner, 16 Nov 2026: "even the bracket does
  // not look like bracket").
  // xUpE / xUpB: the upright at the terminal end / near the bend.
  const xUpE = BR ? X0 + BR.fromEnd * s : null, xUpB = BR ? xOuter - BR.fromBend * s : null;
  const brHalf = BR ? (BR.w / 2) * s : 0;
  const BR_INK = '#3a3f45', BR_PLATE = '#e2e6ea';
  if (BR) {
    for (const [xu, dir] of [[xUpE, -1], [xUpB, 1]]) {
      const L = BR.len * s, xFar = xu + dir * L, xa = Math.min(xu, xFar);
      out.push(K.rect(xa, Yc - brHalf, L, 2 * brHalf, { fill: BR_PLATE, stroke: BR_INK, sw: 0.22 }));
      // Holes and slot, measured from the upright on her drawing: hole columns
      // 8.1 and 20.4 in from the foot's end, 7.85 in from each side; the slot
      // between them on the middle.
      const hx = [BR.len - 8.1, BR.len - 8.1 - 12.3].map(d => xu + dir * d * s), hy = (BR.w / 2 - 7.85) * s;
      for (const x of hx) for (const sy of [-1, 1]) out.push(K.circle(x, Yc + sy * hy, (7.9 / 2) * s, { fill: '#fff', stroke: BR_INK, sw: 0.15 }));
      const sc = xu + dir * (BR.len - 8.1 - 12.3 / 2) * s, sl = 21.5 * s, sw2 = 9.2 * s;
      out.push(K.rect(sc - sl / 2, Yc - sw2 / 2, sl, sw2, { fill: '#fff', stroke: BR_INK, sw: 0.15, rx: sw2 / 2 }));
      // The upright: the plate turned up, seen on its edge.
      out.push(K.rect(Math.min(xu, xu + dir * BR.thk * s), Yc - brHalf, Math.max(0.35, BR.thk * s), 2 * brHalf, { fill: '#9aa1a8', stroke: BR_INK, sw: 0.15 }));
    }
  }
  // Fins, drawn as her fin drawing (FIN-MS-08 / FIN-SS-08-VE) draws them: the
  // helical strip's outer edge seen from the side — one narrow loop a turn
  // above and below each leg, the near half crossing the tube, the far half
  // hidden behind it — fanning out round the bend when they go round it. Loops
  // no closer than 1.5 on paper (closer is drawn at 1.5 and marked schematic);
  // they start short of the tube end and leave a bare gap at the bracket near
  // the bend.
  const finStep = FN ? Math.max(FN.pitch * s, 1.5) : 0;
  const finSchematic = FN ? FN.pitch * s < 1.5 - 1e-9 : false;
  const xFs = FN ? X0 + FN.stop * s : null;            // where the fins start on each leg
  // The gap is never narrower than the bracket itself (its strip and upright).
  // With nothing finned on its bend side (FN.bareTo), the leg is bare from there to the bend.
  const finGap = FN && BR ? (FN.bareTo ? [xOuter - FN.bareTo * s, Xb + 1]
    : (() => { const c = xUpB + (BR.strip * s) / 2, g = Math.max(FN.gap, BR.strip + BR.thk); return [c - (g * s) / 2, c + (g * s) / 2]; })()) : null;
  let finEndX = null;                                  // where the last straight run ends (a bare bend)
  const finEls = [];                                   // drawn over the tube, under the brackets' strips
  if (FN) {
    const FIN_INK = '#2c3136';
    const segs = [];                                    // straight finned runs on paper, each leg
    if (Xb > xFs + 0.2) {
      if (finGap && finGap[1] > xFs && finGap[0] < Xb) {
        if (finGap[0] > xFs + 0.2) segs.push([xFs, Math.min(finGap[0], Xb)]);
        if (finGap[1] < Xb - 0.2) segs.push([Math.max(finGap[1], xFs), Xb]);
      } else segs.push([xFs, Xb]);
    }
    // A stub shorter than two turns between the bracket's gap and a bare bend is not wound.
    for (let i = segs.length - 1; i >= 0; i--) if (!(FN.onBend && Math.abs(segs[i][1] - Xb) < 1e-6) && segs[i][1] - segs[i][0] < 2 * FN.pitch * s) segs.splice(i, 1);
    finEndX = segs.length ? Math.max(...segs.map(g => g[1])) : null;
    // One running position t along the tube (top leg → bend → bottom leg) keeps
    // the turns in step; at t the tube's centre and its outward normal.
    const tTop = Xb - xFs, tBend = Math.PI * half;
    const at = (t) => {
      if (t <= tTop) return [xFs + t, yT, 0, -1];
      if (t <= tTop + tBend) { const ph = -Math.PI / 2 + (t - tTop) / half; return [Xb + half * Math.cos(ph), Yc + half * Math.sin(ph), Math.cos(ph), Math.sin(ph)]; }
      return [Xb - (t - tTop - tBend), yB, 0, 1];
    };
    // The strip's outer edge over [t0, t1]: near half (sin θ ≥ 0) always seen,
    // far half only where it shows past the tube. Reach is clamped short of the
    // other leg's loops so the two never touch on paper.
    const reach = Math.min(rE, half - 0.15);
    const helix = (t0, t1, skip) => {
      const dt = finStep / 16;
      let d = '', pen = false;
      for (let t = t0; t <= t1 + 1e-9; t += dt) {
        const th = (2 * Math.PI * t) / finStep, cth = Math.cos(th);
        const [cx, cy, nx, ny] = at(t);
        const seen = Math.sin(th) >= 0 || Math.abs(reach * cth) >= r - 0.02;
        if (!seen || (skip && skip(cx))) { pen = false; continue; }
        const x = cx + nx * reach * cth, y = cy + ny * reach * cth;
        d += `${pen ? 'L' : 'M'}${K.f(x)},${K.f(y)}`;
        pen = true;
      }
      if (d) finEls.push(K.path(d, { stroke: FIN_INK, sw: finSchematic ? 0.1 : 0.12, fill: 'none' }));
    };
    for (const [a, b] of segs) {
      helix(a - xFs, b - xFs);                                   // top leg
      helix(tTop + tBend + (Xb - b), tTop + tBend + (Xb - a));   // bottom leg
    }
    if (FN.onBend) helix(tTop, tTop + tBend, finGap ? (x) => x >= finGap[0] && x <= finGap[1] : null);
  }
  out.push(K.path(uPath, { stroke: C.sheath, sw: tube.diaMm * s, cap: 'butt' }));
  out.push(K.path(uPath, { stroke: C.heated, sw: tube.diaMm * s - 0.55, cap: 'butt' }));
  out.push(K.line(X0, yT, X0 + czBig, yT, { w: tube.diaMm * s - 0.55, color: C.cold }));
  out.push(K.line(X0, yB, X0 + czSmall, yB, { w: tube.diaMm * s - 0.55, color: C.cold }));
  for (const [x, y] of [[X0 + czBig, yT], [X0 + czSmall, yB]]) { out.push(K.line(x, y - r - 0.8, x, y + r + 0.8, { w: 0.3 })); noteSeg(x, y - r - 0.8, x, y + r + 0.8); }
  noteBox(X0, yT - r, Xb, yT + r, true); noteBox(X0, yB - r, Xb, yB + r, true);
  out.push(...finEls);
  if (broken) {
    // A gap in both legs inside the heated zone, closed by the usual S-breaks.
    const xg = X0 + czMax + heatedPaper * 0.66;
    // On a finned heater the gap goes through the fins too.
    for (const y of [yT, yB]) {
      out.push(K.rect(xg - 2.2, y - rE - 0.6, 4.4, 2 * rE + 1.2, { fill: '#fff', stroke: 'none' }));
      for (const x of [xg - 2.2, xg + 2.2]) out.push(K.path(`M${K.f(x)},${K.f(y - rE - 0.9)} C${K.f(x + 1.1)},${K.f(y - rE / 2)} ${K.f(x - 1.1)},${K.f(y + rE / 2)} ${K.f(x)},${K.f(y + rE + 0.9)}`, { sw: 0.25 }));
    }
  }
  // The fins and the brackets keep the tube Ø at the bend off them.
  if (FN) {
    noteBox(xFs, yT - rE, Xb, yB + rE);
    if (FN.onBend) noteBox(Xb, Yc - half - rE, xOE, Yc + half + rE);
  }
  if (BR) { noteBox(xUpE - BR.strip * s, Yc - brHalf, xUpE, Yc + brHalf); noteBox(xUpB, Yc - brHalf, xUpB + BR.strip * s, Yc + brHalf); }
  out.push(K.line(xOE + 2, Yc, X0 - 16, Yc, { w: 0.15, dash: '4 1 1 1', color: '#777' }));
  noteSeg(xOE + 2, Yc, X0 - 16, Yc);
  // Pins, the sealing bush (its spigot hidden in the tube) and the fittings, as
  // Detail D draws them, at the view's scale.
  // The ESB at its true size when the inventory gives it (the ceramic bead on
  // the tube end); a bracket placed by her answers is drawn below, not here.
  const esbH = (tube.diaMm + 2) * s;
  const esbWE = esbG ? esbG.t * s : 1.2 * k2;
  for (const y of [yT, yB]) {
    out.push(K.rect(X0 - pinOut, y - (pinDia * s) / 2, pinOut, pinDia * s, { fill: C.pin, stroke: '#555', sw: 0.15 }));
    if (esbG) out.push(drawEsb(X0 - esbWE, y, s));
    else {
      out.push(K.rect(X0 - 1.2 * k2, y - esbH / 2, 1.2 * k2, esbH, { fill: C.esb, stroke: 'none' }));
      out.push(K.rect(X0, y - 1.4 * k2, 2.2 * k2, 2.8 * k2, { fill: 'none', stroke: '#555', sw: 0.12, dash: '0.5 0.35' }));
    }
    for (const p of layoutTube(X0, s)) if (!(BR && p.role === 'bracket')) out.push(drawPart(p.role, p.x, y, s));
    for (const p of layoutPin(X0 - esbWE, X0 - pinOut, s)) out.push(drawPart(p.role, p.x, y, s));
  }
  // The brackets' strips over the legs, each with its two screw heads; the
  // strip runs from the upright the way the foot points.
  if (BR) {
    for (const [xu, dir] of [[xUpE, -1], [xUpB, 1]]) {
      const xa = Math.min(xu, xu + dir * BR.strip * s), xm2 = xu + (dir * BR.strip * s) / 2;
      out.push(K.rect(xa, Yc - brHalf, BR.strip * s, 2 * brHalf, { fill: '#d3d7dc', stroke: '#3a3f45', sw: 0.2 }));
      out.push(K.line(xu, Yc - brHalf, xu, Yc + brHalf, { w: Math.max(0.3, BR.thk * s), color: '#3a3f45' }));
      // Its two M3.5 pan heads, Ø6.3, with the cross recess (her drawing).
      for (const dy of [-1, 1]) {
        const cy = Yc + (dy * BR.screwCC * s) / 2, rr = (BR.screw * s) / 2, k = rr * 0.55;
        out.push(K.circle(xm2, cy, rr, { fill: C.ss, stroke: '#3a3f45', sw: 0.15 }));
        out.push(K.line(xm2 - k, cy, xm2 + k, cy, { w: 0.15, color: '#3a3f45' }), K.line(xm2, cy - k, xm2, cy + k, { w: 0.15, color: '#3a3f45' }));
      }
      // Its line in the parts table, on the strip between the legs.
      out.push(K.balloon(xm2, Yc, no('bracket'), { r: 2.2 }));
    }
  }
  // Which end takes which pin (the app's rule: W/H at the big end, W/O at the small).
  out.push(K.text(X0 + czBig + 3, yT - rE - 1.3, 'BIG END · PIN W/H', { size: 2.2, weight: 700, color: C.blue }));
  out.push(K.text(X0 + czSmall + 3, yB + rE + 3.3, 'SMALL END · PIN W/O', { size: 2.2, weight: 700, color: C.blue }));
  noteText(X0 + czBig + 3, yT - rE - 1.3, 'BIG END · PIN W/H', 2.2, 'start', 700);
  noteText(X0 + czSmall + 3, yB + rE + 3.3, 'SMALL END · PIN W/O', 2.2, 'start', 700);
  // Dimensions. The U length always gives the true figure, broken view or not.
  // Total length = 2 × U (owner's ruling R1, 14 Nov 2026): the U is drawn as it
  // comes out of that tube, so its true end-to-end length is dimensioned here.
  // A short U (7U and under) has room only for the figure and its label; the
  // rest is in the element table and the notes.
  // A wider U's total is 2U plus its bend's extra centreline (ruling R-e, worked
  // out in uRules.totalLength): the label then says how much was added — the
  // agent's own wording (r1.formula), else read off the total.
  const extraIn = Math.round((Number(totalStr) - 2 * Number(shape.uLengthIn)) * 100) / 100;
  const tubeSum = typeof spec.r1?.formula === 'string' && spec.r1.formula ? spec.r1.formula
    : Math.abs(extraIn) >= 0.01 ? `2 × ${String(shape.uLengthIn)}" ${extraIn > 0 ? '+' : '−'} ${fmt(Math.abs(extraIn))}"` : `2 × ${String(shape.uLengthIn)}"`;
  let uLabel = r1Mode === 'b' || r1Mode === '2u'
    ? `${n1(shape.uLengthMm)} U LENGTH "${shape.uLabel}" — AS IT COMES OUT OF THE ${totalStr}" (${tubeSum}) TUBE`
    : `${n1(shape.uLengthMm)} (${String(shape.uLengthIn)}") U LENGTH "${shape.uLabel}" — END OF THE TUBE TO THE FAR END OF THE U`;
  if (K.textWidth(uLabel, 2.7) > xOuter - X0 - 3) uLabel = `${n1(shape.uLengthMm)} U LENGTH "${shape.uLabel}"`;
  out.push(K.dimH(X0, xOuter, yU, uLabel, { fromY1: yT - r, fromY2: Yc, size: 2.7 }));
  // A short cold zone (2" is 25.4 at 1:2) gets a smaller label, so the words
  // stay between its extension lines (≈ 0.56 × size per character); at 1:3 and
  // smaller, one that still does not fit drops its millimetres, then its words
  // (the cold-zone callout below the U still says COLD ZONE).
  let czLabel = `${n1(card.coldZoneBigIn * 25.4)} (${card.coldZoneBigIn}") COLD ZONE`;
  if (s < 0.5) czLabel = [czLabel, `${card.coldZoneBigIn}" COLD ZONE`, `${card.coldZoneBigIn}"`].find(t => t.length * 0.56 * 1.9 <= czBig - 1.5) || `${card.coldZoneBigIn}"`;
  const czSize = Math.max(1.9, Math.min(2.6, (czBig - 1.5) / (czLabel.length * 0.56)));
  out.push(K.dimH(X0, X0 + czBig, yCZ, czLabel, { fromY1: yT - r, fromY2: yT - r, size: Math.round(czSize * 100) / 100 }));
  noteSeg(X0 + czBig, yT - r - 0.8, X0 + czBig, yCZ + 1.2);
  out.push(K.dimH(X0 - pinOut, X0, yPin, '25.4 (1") PIN OUT', { fromY1: yB + 1, fromY2: yB + r, above: false, size: 2.5 }));
  // Right of the bend: past the bracket's foot when there is one (callouts keep clear of it).
  const xClr = BR ? Math.max(xOE, xOuter + footPast) : xOE;
  const xOutDim = BR ? Math.max(xOE + 4.5, xOuter + footPast + 3.4) : xOE + 4.5;
  out.push(K.dimV(yT - r, yB + r, xOutDim, `${fmt(outsideMm)} OUTSIDE`, { fromX1: Xb, fromX2: Xb, size: 2.6 }));
  // Inches beside a figure only when it is a plain fraction of an inch (1.5" = 38.1).
  const inchOf = (mm) => { const v = Math.round((mm / 25.4) * 8) / 8; return v > 0 && Math.abs(v * 25.4 - mm) < 0.05 ? ` (${fmt(v)}")` : ''; };
  // Where the fins start and the terminal-end bracket sits, chained on from
  // the PIN OUT figure: the fins stop there (owner, 16 Nov 2026: "after the
  // bracket is fit the finns will notbe added again").
  {
    const pts = [];
    if (BR) pts.push({ x: xUpE, mm: BR.fromEnd, from: Yc + brHalf });
    if (FN && !(BR && Math.abs(FN.stop - BR.fromEnd) < 0.5) && FN.stop > 0) pts.push({ x: xFs, mm: FN.stop, from: yB + rE });
    pts.sort((a, b) => a.x - b.x);
    let xa = X0, mmA = 0;
    for (const p of pts) {
      const lab = `${fmt(p.mm - mmA)}${inchOf(p.mm - mmA)}`;
      // Its figure above the line, clear of PIN OUT's below.
      out.push(K.dimH(xa, p.x, yPin, lab, { fromY2: p.from, size: K.fitSize(lab, Math.max(6, p.x - xa + 4), 2.3, 400, 1.8) }));
      noteSeg(p.x, p.from, p.x, yPin);
      xa = p.x; mmA = p.mm;
    }
    // The bracket near the bend, from the far end of the U.
    if (BR) {
      const lab = `${fmt(BR.fromBend)}${inchOf(BR.fromBend)}`;
      out.push(K.dimH(xUpB, xOuter, yPin, lab, { fromY1: Yc + brHalf, fromY2: Yc, above: false, size: K.fitSize(lab, Math.max(6, xOuter - xUpB + 4), 2.3, 400, 1.8) }));
      noteSeg(xUpB, Yc + brHalf, xUpB, yPin); noteSeg(xOuter, Yc, xOuter, yPin);
    }
  }
  // The fins' own row, between the U length and the cold zone: from where they
  // start to where they end (the far end of the U when they go round the bend),
  // with what they are. The words shorten on a short U. The extension line at
  // their start is broken where it passes the cold-zone figure.
  // A bare bend: the row ends where the fins do (short of the bracket's gap when
  // the stub between it and the bend is too short to wind).
  const xFe = FN ? (FN.onBend ? xOE : finEndX ?? Xb) : null;
  if (FN && xFe - xFs >= 6) {
    const yFin = yCZ - 3.75;
    const xe = xFe;
    const pitchTxt = `PITCH ${fmt(FN.pitch)}${finSchematic ? ' — SCHEMATIC' : ''}`;
    const bendTxt = FN.onBend ? `ROUND THE BEND${finGap ? ', GAP AT THE BRACKET' : ''}` : 'STRAIGHT LEGS ONLY, BEND BARE';
    const stopTxt = BR && Math.abs(FN.stop - BR.fromEnd) < 0.5 ? 'STOP AT THE END BRACKET' : `STOP ${fmt(FN.stop)} BEFORE THE END`;
    const base = `${FN.label} · OD ${fmt(FN.od)}`;
    // Centred on the row and, round the bend, short of the U length's extension line.
    const room = FN.onBend ? Math.min(xe - xFs - 2, 2 * (xOuter - 1.2 - (xFs + xe) / 2)) : xe - xFs - 2;
    const cands = [`${base} · ${pitchTxt} · ${bendTxt} · ${stopTxt}`, `${base} · ${pitchTxt} · ${bendTxt}`, `${base} · ${pitchTxt}`, base, FN.label];
    const lab = cands.find(t => K.textWidth(t, 2.4) <= room) || FN.label;
    const size = K.textWidth(lab, 2.4) <= room ? 2.4 : K.fitSize(lab, room, 2.4, 400, 1.6);
    out.push(K.dimH(xFs, xe, yFin, lab, { fromY2: FN.onBend ? Yc : yT - rE, size }));
    const czS = Math.round(czSize * 100) / 100, czW = K.textWidth(czLabel, czS), czX = X0 + czBig / 2;
    const yTop = yFin - 1.2, yBot = yT - rE - 0.8;
    if (xFs > czX - czW / 2 - 0.6 && xFs < czX + czW / 2 + 0.6) {
      const g1 = yCZ - 0.9 - 0.72 * czS - 0.5, g2 = yCZ - 0.9 + 0.2 * czS + 0.5;
      out.push(K.line(xFs, yBot, xFs, g2, { w: 0.18, color: K.DIM }), K.line(xFs, g1, xFs, yTop, { w: 0.18, color: K.DIM }));
    } else out.push(K.line(xFs, yBot, xFs, yTop, { w: 0.18, color: K.DIM }));
    noteSeg(xFs, yBot, xFs, yTop);
  }
  // Section mark T–T in the heated zone of the top leg, clear of the BIG END
  // label on a short U; the INSIDE dimension keeps clear of it.
  let xt = X0 + czMax + heatedPaper * 0.33;
  if (xt < X0 + czBig + 31 && X0 + czBig + 31 < Xb - 10) xt = X0 + czBig + 31;
  // Cut through both legs (fins), its lower mark sits on the SMALL END row: clear of that label too.
  if (FN) { const xs2 = X0 + czSmall + 3 + K.textWidth('SMALL END · PIN W/O', 2.2, 700) + 4.5; if (xt < xs2 && xs2 < Xb - 10) xt = xs2; }
  let xg = Xb - 20;
  if (!ringFits) xg = Math.min(Math.max(xg, X0 + 13.5), Xb - 6);   // right of Detail D's ellipse (it reaches X0 + 9.5)
  if (Math.abs(xg - xt) < 8) xg = Math.min(Xb - 6, xt + 10);
  const insideLabel = `${fmt(insideMm)} INSIDE`;
  out.push(K.dimV(yT + r, yB - r, xg, insideLabel, { size: 2.2, halo: FN ? 0.9 : 0 }));
  noteSeg(xg, yT + r, xg, yB - r);
  { const w = K.textWidth(insideLabel, 2.2); noteBox(xg - 0.9 - 0.72 * 2.2, Yc - w / 2, xg - 0.9 + 0.2 * 2.2, Yc + w / 2); }
  // On a finned heater there is no room between the legs' fins for the
  // inner mark: the cut goes through both legs.
  for (const y of FN ? [yT - rE - 3.2, yB + rE + 3.2] : [yT - r - 3.2, yT + r + 3.2]) {
    out.push(K.line(xt, y - 1.6, xt, y + 1.6, { w: 0.35 }));
    out.push(K.line(xt, y, xt - 3, y, { w: 0.25 }), K.arrowhead(xt - 3, y, Math.PI, { len: 1.4, half: 0.5, color: '#111' }));
    out.push(K.text(xt + 1.2, y + (y < yT ? -0.6 : 2.4), 'T', { size: 2.5, weight: 700 }));
    noteSeg(xt, y - 1.6, xt, y + 1.6); noteSeg(xt, y, xt - 3, y); noteText(xt + 1.2, y + (y < yT ? -0.6 : 2.4), 'T', 2.5, 'start', 700);
  }
  // Callouts. None may run into the element table (it starts at x 276).
  // The sheath callout ends short of the U length's extension line. A short U
  // gets the short form, and when even that will not fit left of the bend it
  // goes right of the OUTSIDE dimension — or, when that would run into the
  // table too (a mid-length U with a big cold zone), above the top leg, between
  // the U length and the cold zone dimensions.
  const RIGHT = 272;
  const textW = (str) => K.textWidth(str, 2.4) + 3.3;          // a 2.4 label and its leader's shoulder
  const finishUp = String(item.finish || '').toUpperCase();
  const sheathLong = `Ø${tube.diaMm} SHEATH — ${tube.label} · ${finishUp}`;
  const sheathShort = `Ø${tube.diaMm} SHEATH — ${String(tube.material || '').toUpperCase()} · ${tube.wallMm} WALL · ${finishUp}`;
  // Fins that stop at the bend have their row's extension line there: keep left of it too.
  const sheathRight = FN && !FN.onBend ? Math.min(xOuter - 5, xFe - 2.5) : xOuter - 5, sheathMin = Math.max(X0 + czBig + 32, xt + 5);
  const sheathFit = (txt) => Math.min(xt + 36, sheathRight - textW(txt));
  if (sheathFit(sheathLong) >= sheathMin) {
    const lx = sheathFit(sheathLong);
    out.push(K.leader(Math.min(xt + 30, lx - 6), yT - r, lx, ySh, sheathLong, { size: 2.4 }));
    noteSeg(Math.min(xt + 30, lx - 6), yT - r, lx, ySh);
  } else if (sheathFit(sheathShort) >= sheathMin) {
    const lx = sheathFit(sheathShort);
    out.push(K.leader(Math.min(xt + 30, lx - 6), yT - r, lx, ySh, sheathShort, { size: 2.4 }));
    noteSeg(Math.min(xt + 30, lx - 6), yT - r, lx, ySh);
  } else if (xClr + 9 + textW(sheathShort) <= RIGHT) {
    const txt = xClr + 9 + textW(sheathLong) <= RIGHT ? sheathLong : sheathShort;
    out.push(K.leader(Xb + half * Math.cos(-Math.PI / 3), Yc + half * Math.sin(-Math.PI / 3), xClr + 9, yCZ, txt, { size: 2.4 }));
    noteSeg(Xb + half * Math.cos(-Math.PI / 3), Yc + half * Math.sin(-Math.PI / 3), xClr + 9, yCZ);
  } else {
    // Right of a straight-up leader, inside the U length's extension lines; left
    // of it when only that side has room.
    const fx = Math.min(Math.max(X0 + czBig + 30, xt + 6), Xb - 2);   // clear of BIG END and the T–T mark
    const roomR = xOuter - 2 - fx, roomL = fx - X0 - 2;
    const txt = [sheathLong, sheathShort].find(t => textW(t) <= roomR) || [sheathLong, sheathShort].find(t => textW(t) <= roomL) || sheathShort;
    const side = textW(txt) > roomR && textW(txt) <= roomL ? 'left' : 'right';
    out.push(K.leader(fx, yT - r, fx, ySh56, txt, { size: side === 'right' ? K.fitSize(txt, roomR - 3.3, 2.4) : 2.4, side }));
    noteSeg(fx, yT - r, fx, ySh56);
  }
  const czLines = [`COLD ZONE ${card.coldZoneBigIn}" (${n1(card.coldZoneBigIn * 25.4)}) EACH LEG — NO COIL`, `PIN ${card.pinStudsIn}": ${card.pinStudsIn - 1}" IN THE TUBE + 1" OUT`];
  const czTxtEnd = X0 + czSmall + 8 + Math.max(...czLines.map(textW));
  out.push(K.leader(X0 + czSmall * 0.55, yB + r, X0 + czSmall + 8, yR2, czLines, { size: 2.4 }));
  noteSeg(X0 + czSmall * 0.55, yB + r, X0 + czSmall + 8, yR2);
  // The heated-zone leader must not cut through the cold-zone label on a short U.
  let xh = X0 + czMax + heatedPaper * 0.485, xhl = xh + 6;
  if (xh < X0 + czSmall + 30 && X0 + czSmall + 30 < Xb - 4) { xh = X0 + czSmall + 30; xhl = xh + 6; }   // clear of SMALL END
  if (xh < czTxtEnd + 4) {
    if (czTxtEnd + 4 < Xb - 4) { xh = czTxtEnd + 4; xhl = xh + 6; } else xhl = xh + (czTxtEnd + 2 - xh) / 0.683;
  }
  // and clear of the T–T mark under the bottom leg of a finned heater.
  if (FN && xh > xt - 4 && xh < xt + 6 && xt + 6 < Xb - 4) { xh = xt + 6; xhl = Math.max(xhl, xh + 6); }
  // A big cold zone pushes it so far right that it would run into the element
  // table (44U with 8" cold zones, 14 Nov 2026): a leader already clear of the
  // cold-zone label then drops straight down, and the label goes left of the
  // leader's end, under the cold-zone label, when it still does not fit right.
  const hTxt = [`HEATED ZONE ≈ ${n1(card.heatedMm)} (${n2(card.heatedMm / 25.4)}") ALONG THE TUBE`, 'COIL INSIDE — SEE SECTION T–T'];
  const hW = Math.max(...hTxt.map(textW));
  let hSide = 'right';
  if (xhl + hW > RIGHT) {
    if (xh >= czTxtEnd + 2) xhl = xh;
    if (xhl + hW > RIGHT && xhl - hW > X0 + 22) hSide = 'left';
  }
  out.push(K.leader(xh, yB + r, xhl, yH, hTxt, { size: 2.4, side: hSide }));
  noteSeg(xh, yB + r, xhl, yH);
  const ra = Math.PI / 6;
  const rTxt = `R${n1(geo.rCL)} CL · ROLLER ${rollerTxt}`;
  // Left of the bend, beside the cold-zone label; a short U leaves no room there,
  // so right of the bend — unless that runs into the table, then left of the
  // bend one row up, clear of the two leaders that cross that row.
  const rW = textW(rTxt), rLeftEdge = Xb - 10 - rW;
  const atRow = (x1, y1, x2, y2, y) => x1 + ((x2 - x1) * (y - y1)) / (y2 - y1);   // a leader's x at height y
  let rAt = [xClr + 9, yR1];
  if (rLeftEdge > czTxtEnd && rLeftEdge > xh + (xhl - xh) * 0.683 + 2) rAt = [Xb - 10, yR2];
  else if (xClr + 9 + rW > RIGHT && rLeftEdge > 2 + Math.max(atRow(xh, yB + r, xhl, yH, yR1), atRow(X0 + czSmall * 0.55, yB + r, X0 + czSmall + 8, yR2, yR1))) rAt = [Xb - 10, yR1];
  // Still right of the bend and running into the table at x 276 (a wide bend, a
  // NEW roller's longer label): set smaller to stop short of it.
  const rSize = rAt[0] === xClr + 9 && xClr + 9 + rW > 275.5 ? K.fitSize(rTxt, RIGHT - xOE - 9 - 3.3, 2.4) : 2.4;
  // Run left past a bracket's figure under the bend, it leaves the bend steeper.
  const raL = BR && rAt[0] < Xb ? (Math.PI * 5) / 12 : ra;
  out.push(K.leader(Xb + half * Math.cos(raL), Yc + half * Math.sin(raL), rAt[0], rAt[1], rTxt, { size: rSize }));
  noteSeg(Xb + half * Math.cos(raL), Yc + half * Math.sin(raL), rAt[0], rAt[1]);
  // The tube Ø at the bend (owner, 14 Nov 2026: "on the heater drawing could
  // you also show the tube dia"): across the bottom leg just before the bend,
  // label inside the U, ≥ 4.5 right of the INSIDE dimension; on the top leg
  // (label under it) when the bottom one is crowded — a short heated leg; left
  // off only when neither is clear, as Section T–T, the sheath callout and
  // DIAMETER = still give it.
  {
    // Between the INSIDE (2.2) and OUTSIDE (2.6) figures beside it, so it reads at a glance.
    const DIA_LABEL = 2.4;
    // A bracket's strip lies across the legs near the bend: then just left of it.
    const xDias = [Math.max(Xb - 3, xg + 4.5), ...(BR ? [xUpB - 3] : [])];
    let xDia = xDias[0];
    const label = `Ø${tube.diaMm}`, lw = K.textWidth(label, DIA_LABEL) / 2, pad = 0.4;
    const hitsBox = ([a1, b1, a2, b2], [c1, d1, c2, d2]) => a1 < c2 && c1 < a2 && b1 < d2 && d1 < b2;
    const hitsSeg = ([x1, y1, x2, y2], [c1, d1, c2, d2]) => {      // a segment through a box (Liang–Barsky)
      let t0 = 0, t1 = 1;
      for (const [p, q] of [[x1 - x2, x1 - c1], [x2 - x1, c2 - x1], [y1 - y2, y1 - d1], [y2 - y1, d2 - y1]]) {
        if (p === 0) { if (q < 0) return false; continue; }
        const t = q / p;
        if (p < 0) { if (t > t1) return false; t0 = Math.max(t0, t); } else { if (t < t0) return false; t1 = Math.min(t1, t); }
      }
      return true;
    };
    const clear = (y1, y2, below) => {
      const across = [xDia - 0.6 - pad, y1 - 1.8 - pad, xDia + 0.6 + pad, y2 + 1.8 + pad];
      const by = below ? y2 + 1.8 + 0.6 + 0.72 * DIA_LABEL : y1 - 1.8 - 0.6;
      const lab = [xDia - lw - pad, by - 0.72 * DIA_LABEL - pad, xDia + lw + pad, by + 0.2 * DIA_LABEL + pad];
      return nearBend.every(o => (o.b ? (o.leg ? !hitsBox(lab, o.b) : !hitsBox(across, o.b) && !hitsBox(lab, o.b)) : !hitsSeg(o.s, across) && !hitsSeg(o.s, lab)));
    };
    for (const xc of xDias) {
      xDia = xc;
      if (clear(yB - r, yB + r, false)) { out.push(K.dimAcross(xDia, yB - r, yB + r, label, { size: DIA_LABEL })); break; }
      if (clear(yT - r, yT + r, true)) { out.push(K.dimAcross(xDia, yT - r, yT + r, label, { size: DIA_LABEL, below: true })); break; }
    }
  }
  // Detail D's ring takes in both terminal ends: a circle on the usual U; on a
  // wider one an ellipse as tall as the U and its fittings, lettered above its
  // top, its leader leaving its lower left and dropping clear of the pins and
  // the PIN OUT figure to the label row.
  const partsOut = Math.max(r, ...[...fit.pin, ...fit.tube].map(rl => partHalfH(rl, s)));   // the fittings, from a leg's centre
  const ringRy = half + partsOut + 2.75;
  if (ringFits) out.push(K.circle(X0 - 6, Yc, 15.5, { stroke: C.blue, sw: 0.3, dash: '1.6 0.9' }));
  else out.push(K.ellipse(X0 - 6, Yc, 15.5, ringRy, { stroke: C.blue, sw: 0.3, dash: '1.6 0.9' }));
  // The letter goes right of anything on the tube (a nipple set reaches past it).
  const tubeEnd = Math.max(X0, ...layoutTube(X0, s).map(p => p.x + (p.role === 'nipple' ? sz.nipple.t + sz.nipple.threadT : (sz[p.role] || { t: 2 }).t) * s));
  // On a finned heater the letter stays left of where the fins start (1:3 and smaller).
  const xD = FN ? Math.min(Math.max(X0 + 8, tubeEnd + 1.5), xFs - 3.4) : Math.max(X0 + 8, tubeEnd + 1.5);
  if (ringFits) out.push(K.text(xD, yD, 'D', { size: 3.3, weight: 700, color: C.blue }));
  else out.push(K.text(X0 - 6, Yc - ringRy - 1, 'D', { size: 3.3, weight: 700, color: C.blue, anchor: 'middle' }));
  const ddTxt = 'TERMINAL END AND FITTING ORDER — SEE DETAIL D';
  // On a finned or bracketed heater the dimensions chained on from PIN OUT
  // take the room right of the circle: its leader then leaves on the left.
  if (ringFits && (FN || BR)) out.push(K.leader(X0 - 6 - 15.5 * 0.84, Yc + 15.5 * Math.sqrt(1 - 0.84 ** 2), X0 - 22, yDD, ddTxt, { size: 2.4, color: C.blue, side: 'right' }));
  else if (ringFits) out.push(K.leader(X0 - 6 + 15.5 * Math.cos(0.95), Yc + 15.5 * Math.sin(0.95), X0 + 20, yDD, ddTxt, { size: 2.4, color: C.blue }));
  else out.push(K.leader(X0 - 6 - 15.5 * 0.84, Yc + ringRy * Math.sqrt(1 - 0.84 ** 2), X0 - 22, yDD, ddTxt, { size: 2.4, color: C.blue, side: 'right' }));

  // ── Detail D: terminal end, one leg, scale 2:1 (3:2 with a nipple) ──
  // A nipple is too big for 2:1: 3:2 for M12, 5:4 for M16.
  const sD = fit.tube.includes('nipple') ? (String(fit.nipple).toUpperCase() === 'M16' ? 1.25 : 1.5) : 2;
  out.push(K.viewTitle(92, 135, `DETAIL D — TERMINAL END, ONE LEG (SCALE ${({ 2: '2:1', 1.5: '3:2', 1.25: '5:4' })[sD]})`));
  const tubeR = (tube.diaMm / 2) * sD, pinR = (pinDia / 2) * sD, xm = 120, xEnd = 168;
  const pinL = 25.4 * sD, pinEndX = xm - pinL, esbW = esbG ? esbG.t * sD : 2 * sD;
  // A bracket placed by her answers is drawn where it goes when that is inside
  // this view (its strip over the tube); 1.5" from the end is past it, and the
  // pin's callout then says where it is.
  const brInView = BR ? BR.fromEnd * sD <= xEnd - 2 - xm : false;
  const tubeParts = layoutTube(xm, sD).filter(p => !(BR && p.role === 'bracket' && !brInView))
    .map(p => (BR && p.role === 'bracket' ? { role: p.role, x: xm + Math.max(0, BR.fromEnd - BR.strip) * sD, mid: xm + Math.max(BR.strip / 2, BR.fromEnd - BR.strip / 2) * sD, strip: Math.min(BR.strip, BR.fromEnd) * sD } : p));
  // Fins that start inside this view get a tick there.
  const finInView = FN ? FN.stop * sD <= xEnd - 2 - xm : false;
  const maxHalf = Math.max(tubeR + 1, ...fit.pin.map(rl => partHalfH(rl, sD)), ...tubeParts.map(p => partHalfH(p.role, sD)));
  const balloonY = Math.min(143, 160 - maxHalf - 4.5);
  const drawLeg = (y, { stack = true } = {}) => {
    const o = [];
    o.push(K.rect(xm, y - tubeR, xEnd - xm, tubeR * 2, { fill: C.cold, stroke: '#1a1a1a', sw: 0.35 }));
    o.push(K.breakMark(xEnd, y - tubeR, y + tubeR));
    o.push(K.line(xm, y - pinR, xEnd, y - pinR, { w: 0.2, dash: '1 0.7', color: '#555' }), K.line(xm, y + pinR, xEnd, y + pinR, { w: 0.2, dash: '1 0.7', color: '#555' }));
    o.push(K.rect(pinEndX, y - pinR, pinL, pinR * 2, { fill: C.pin, stroke: '#444', sw: 0.2 }));
    for (let x = pinEndX + 1; x < xm - 0.5; x += 1.4) o.push(K.line(x, y - pinR, x + 0.9, y + pinR, { w: 0.12, color: '#666' }));
    if (esbG) o.push(drawEsb(xm - esbW, y, sD));
    else {
      o.push(K.rect(xm - esbW, y - tubeR - 1, esbW, tubeR * 2 + 2, { fill: C.esb, stroke: 'none' }));
      o.push(K.rect(xm, y - tubeR + 1.2, 3 * sD, tubeR * 2 - 2.4, { fill: 'none', stroke: '#555', sw: 0.25, dash: '1 0.6' }));
    }
    if (finInView) {
      const xf = xm + FN.stop * sD;
      o.push(K.line(xf, y - tubeR - 2.5, xf, y + tubeR + 2.5, { w: 0.35, color: C.blue }));
      o.push(K.text(xf + 0.8, y - tubeR - 1, 'FINS →', { size: 1.9, weight: 700, color: C.blue }));
    }
    for (const p of tubeParts) {
      if (p.strip) o.push(K.rect(p.x, y - (sz.bracket.h * sD) / 2, p.strip, sz.bracket.h * sD, { fill: C.ms, stroke: '#333', sw: 0.2 }));
      else o.push(drawPart(p.role, p.x, y, sD, xEnd - 0.6));
    }
    if (stack) for (const p of layoutPin(xm - esbW, pinEndX, sD)) o.push(drawPart(p.role, p.x, y, sD));
    return o.join('');
  };
  const ya = 160;
  out.push(K.text(16, 146, 'ASSEMBLED', { size: 2.3, weight: 700, color: '#555' }));
  if (toConfirm) out.push(redTag(16, 140.5, 'TO CONFIRM: FITTING ORDER', 2.2));
  out.push(drawLeg(ya));
  const pinLay = layoutPin(xm - esbW, pinEndX, sD);
  // Each leader lands on its own part's top edge.
  // Right to left from the ESB's, each balloon as close above its part as the
  // spacing allows: a heavy pin's parts sit at the pin's end, far from the ESB,
  // and leaders run from there would cross the other balloons (14 Nov 2026).
  const ballooned = [[xm - esbW / 2, 'esb', esbG ? (esbG.h * sD) / 2 : tubeR + 1], ...pinLay.map(p => [p.mid, p.role, p.role === 'hvpin' ? sz.hvpin.h * sD / 2 : partHalfH(p.role, sD)])].sort((a, b) => b[0] - a[0]);
  let bx = 131.2;
  ballooned.forEach(([x, role, hh]) => { bx = Math.min(bx - 8.2, x + 8); out.push(K.balloonLeader(x, ya - hh - 0.5, bx, balloonY, no(role))); });
  tubeParts.forEach((p, i) => out.push(K.balloonLeader(p.mid, ya - partHalfH(p.role, sD) - 0.5, Math.max(131.2 + i * 8.2, p.mid + 3), balloonY, no(p.role))));
  const pinLow = Math.max(0, ...pinLay.map(p => (p.role === 'hvpin' ? sz.hvpin.h * sD / 2 : partHalfH(p.role, sD)))) > 9.5;
  // On the M4 / M5 thread itself — past a heavy pin's hex body, which covers the pin's end.
  const pinFoot = fit.pin.includes('hvpin') ? pinEndX + sz.hvpin.t * sD + 14 : pinEndX + (pinLow ? 4 : 9);
  out.push(K.leader(pinFoot, ya + pinR, pinEndX - 6, pinLow ? 178 : 171, [`${stud} SS PIN ${card.pinStudsIn}" — W/H: BIG END,`, `W/O: SMALL END (PARTS ${pinNos.join(', ')})`], { size: 2.2 }));
  out.push(K.dimH(pinEndX, xm, 172, '25.4 (1")', { fromY1: ya + pinR, fromY2: ya + tubeR, above: false, size: 2.3 }));
  // With the ESB's true size: what it is, and its size. A third line says
  // what lies past the view's break: the bracket, where the fins start.
  const pinTxt = [`PIN ${card.pinStudsIn - 1}" (${n1((card.pinStudsIn - 1) * 25.4)}) IN THE TUBE, SPOT WELDED`,
    !esbG ? 'TO THE COIL AT St 4 · ESB SPIGOT SHOWN DASHED'
      : `TO THE COIL AT St 4 · ${esbStdCode && PS[esbStdCode] ? `${esbStdCode} (NOT ON THE LIST)` : 'ESB'}: CERAMIC BEAD ${fmt(esbG.t + (esbG.spigot ? esbG.spigot.t : 0))} LONG, Ø${fmt(esbG.h)}${esbG.spigot ? ' (SPIGOT DASHED)' : ''}`];
  {
    const finsAtBr = FN && BR && Math.abs(FN.stop - BR.fromEnd) < 0.5;
    if (BR && !brInView) pinTxt.push(`BRACKET${no('bracket') === '–' ? '' : ` ${no('bracket')}`} AT ${fmt(BR.fromEnd)}${inchOf(BR.fromEnd)} FROM THE TUBE END${finsAtBr ? ', FINS FROM IT' : ''} — PAST THIS VIEW`);
    if (FN && !finsAtBr) pinTxt.push(finInView ? `FINS START ${fmt(FN.stop)} FROM THE TUBE END (MARKED)` : `FINS START ${fmt(FN.stop)} FROM THE TUBE END — PAST THIS VIEW`);
  }
  let pinTubeFoot = tubeParts.length ? xEnd - 4 : 150;
  if (finInView && Math.abs(pinTubeFoot - (xm + FN.stop * sD)) < 3) pinTubeFoot = Math.min(xEnd - 4, xm + FN.stop * sD + 6);
  out.push(K.leader(pinTubeFoot, ya + pinR, 146, 187, pinTxt, { size: 2.2 }));
  // Exploded, in fitting order — lettered so the steps are not read as part numbers.
  const ye = 217;
  out.push(K.text(16, 198, 'FITTING ORDER', { size: 2.3, weight: 700, color: '#555' }));
  if (toConfirm) out.push(redTag(44, 198, 'TO CONFIRM', 2.2));
  out.push(drawLeg(ye, { stack: false }));
  out.push(K.line(12.5, ye, pinEndX, ye, { w: 0.15, dash: '4 1 1 1', color: '#777' }));
  // Pin parts float left of the pin end, evenly spaced, at least 10 apart.
  const exp = [];
  {
    const right = pinEndX - 6, left = 18.8;
    const widths = fit.pin.map(rl => partWidth(rl, sD));
    const total = widths.reduce((a, b) => a + b, 0);
    const gap = fit.pin.length > 1 ? Math.max(2, Math.min(12, (right - left - total) / (fit.pin.length - 1))) : 0;
    let edge = right, prevMid = Infinity;
    fit.pin.forEach((role, i) => {
      let mid = Math.min(edge - widths[i] / 2, prevMid - 10);
      exp.push({ role, mid, x: role === 'hvpin' ? mid - widths[i] / 2 + (sz.hvpin.studT * sD) : mid - widths[i] / 2 });
      edge = mid - widths[i] / 2 - gap; prevMid = mid;
    });
    // A long stack (a nut under a heavy pin, 16 Nov 2026) would run off the
    // sheet's left edge: draw it closer together, in the same order.
    const last = exp[exp.length - 1], lastLeft = last ? last.mid - widths[exp.length - 1] / 2 : left;
    if (last && lastLeft < 12.5 && exp.length > 1) {
      const m0 = exp[0].mid, k = (m0 - (12.5 + widths[exp.length - 1] / 2)) / (m0 - last.mid);
      exp.forEach((p, i) => { const mid = m0 - (m0 - p.mid) * k; p.x += mid - p.mid; p.mid = mid; });
    }
  }
  for (const p of exp) out.push(drawPart(p.role, p.x, ye, sD));
  const arrowX = pinEndX + 3;
  out.push(K.line(arrowX, ye - 9, arrowX + 22, ye - 9, { w: 0.25, color: C.blue }), K.arrowhead(arrowX + 22, ye - 9, 0, { color: C.blue }));
  out.push(K.text(arrowX + 11, ye - 10.5, 'slide on in this order', { size: 2.0, anchor: 'middle', color: C.blue }));
  const letters = 'ABCDEFGHIJ';
  let li = 0;
  if (tubeParts.length || (BR && fit.tube.includes('bracket'))) {
    // The parts on the tube go on first, as one step.
    const isNipple = fit.tube.includes('nipple');
    const yl = ye + (tubeParts.length ? Math.max(...fit.tube.map(rl => partHalfH(rl, sD))) : tubeR) + 3.4;
    const what = isNipple ? (fit.tube.length > 1 ? `${NAME.nipple} set` : NAME.nipple) : 'bracket';
    // A bracket placed by her answers is clamped in its slots 1.5" in, not slid
    // on first: no step letter, and where it sits (review, 16 Nov 2026).
    if (BR && !isNipple) {
      out.push(K.text(xm + 7, yl, `bracket · ${stageOf('bracket')} · clamped in its slots`, { size: 2.1, weight: 700, color: C.blue }));
      out.push(K.text(xm + 7, yl + 2.9, `at ${fmt(BR.fromEnd)}${inchOf(BR.fromEnd)} from the tube end${brInView ? '' : ', past this view'}`, { size: 1.9, color: C.blue }));
    } else out.push(K.text(xm + 7, yl, `${letters[li++]} · ${what} · ${stageOf(fit.tube[0])}${isNipple ? '' : ' (before the ESB)'}`, { size: 2.1, weight: 700, color: C.blue }));
  }
  const steps = [{ x: xm - esbW / 2, role: 'esb', name: esbName }, ...exp.map(p => ({ x: p.mid, role: p.role, name: NAME[p.role] || p.role }))];
  const yL = ye + Math.max(13.5, tubeR + 1 + 3.2, ...fit.pin.map(rl => (rl === 'hvpin' ? sz.hvpin.h * sD / 2 : partHalfH(rl, sD)) + 3.2));
  for (const st of steps) {
    out.push(K.text(st.x, yL, letters[li++] || '?', { size: 2.6, anchor: 'middle', weight: 700, color: C.blue }));
    out.push(K.text(st.x, yL + 3.1, [st.name, stageOf(st.role)], { size: 2.0, anchor: 'middle', color: '#333' }));
    out.push(K.balloon(st.x, ye - 15.5, no(st.role), { r: 2.3 }));
  }

  // ── Section T–T, scale 4:1 (3:1 on Ø11) ──
  // On a finned heater the fins' OD ring is drawn round the sheath beyond the
  // cut, at the largest scale that keeps it inside the view (3:2 for a 28.5 OD,
  // 5:4 for 31.6), the cut then going through both legs.
  const sT = FN ? [4, 3, 2, 1.5, 1.25, 1].find(k => Math.max(dia, FN.od) * k <= 44) || 1 : Number(tube.diaMm) === 11 ? 3 : 4;
  // The cut goes through both legs (fins); one is drawn, the other alike (review, 16 Nov 2026).
  out.push(K.viewTitle(221, 135, `SECTION T–T${FN ? ', ONE LEG' : ''} (SCALE ${({ 1.5: '3:2', 1.25: '5:4' })[sT] || `${sT}:1`})`));
  const cx = FN ? 194 : 196, cy = 160, R = (tube.diaMm / 2) * sT, Ri = R - tube.wallMm * sT;
  const Rf = FN ? (FN.od / 2) * sT : R;
  out.push(`<defs><pattern id="mgo" width="1.6" height="1.6" patternUnits="userSpaceOnUse"><circle cx="0.8" cy="0.8" r="0.22" fill="#9a8f7a"/></pattern></defs>`);
  if (FN) {
    out.push(K.circle(cx, cy, Rf, { fill: '#eef1f4', stroke: '#6f767e', sw: 0.3 }));
    // The strip's cut edge where the plane meets it, from the sheath out.
    out.push(K.line(cx - R, cy, cx - Rf, cy, { w: 0.6, color: '#6f767e' }));
  }
  out.push(K.circle(cx, cy, R, { fill: '#d9dde2', stroke: '#1a1a1a', sw: 0.4 }));
  out.push(K.circle(cx, cy, Ri, { fill: '#f7f3ea', stroke: '#1a1a1a', sw: 0.3 }));
  out.push(K.circle(cx, cy, Ri - 0.1, { fill: 'url(#mgo)', stroke: 'none' }));
  // A card with no wire (blocked: "no wire on the gauge sheet reaches this coil
  // length") has no coil to draw — no NaN circle or leader across the sheet.
  const coilKnown = Number(card.mandrelMm) > 0 && Number(card.wireDiaMm) > 0;
  const coilR = coilKnown ? (card.mandrelMm / 2 + card.wireDiaMm / 2) * sT : Ri * 0.55;
  if (coilKnown) out.push(K.circle(cx, cy, coilR, { stroke: '#9c5a1c', sw: card.wireDiaMm * sT }));
  // On a finned heater the centreline stops short of Detail D's break, on its left.
  out.push(K.line(cx - Rf - (FN ? 1 : 3), cy, cx + Rf + 3, cy, { w: 0.15, dash: '3 1 1 1', color: '#777' }), K.line(cx, cy - Rf - 3, cx, cy + Rf + 3, { w: 0.15, dash: '3 1 1 1', color: '#777' }));
  out.push(K.leader(cx + R * Math.cos(-0.7), cy + R * Math.sin(-0.7), 218, 145, `SHEATH — ${tube.material.toUpperCase()}, Ø${tube.diaMm}`, { size: 2.3 }));
  if (FN) {
    const rm = (coilR + (coilKnown ? card.wireDiaMm : 0) * sT / 2 + Ri) / 2;
    out.push(K.leader(cx + rm * Math.cos(-0.45), cy + rm * Math.sin(-0.45), 218, 154, 'MgO — COMPACTED (MGO-65A)', { size: 2.3 }));
  } else out.push(K.leader(cx + 9, cy - 5, 218, 154, 'MgO — COMPACTED (MGO-65A)', { size: 2.3 }));
  out.push(K.leader(cx + coilR * Math.cos(0.35), cy + coilR * Math.sin(0.35), 218, 167, coilKnown ? [`COIL — ${card.gauge} SWG FeCrAl (${card.wireCode})`, `ON ${card.mandrelMm} MM MANDREL`] : ['COIL — NO WIRE ON THE GAUGE SHEET', 'MADE BY HAND ON THE ORDER'], { size: 2.3 }));
  if (FN) {
    out.push(K.leader(cx + Rf * Math.cos(0.75), cy + Rf * Math.sin(0.75), 218, 177, [FN.label, `OD ${fmt(FN.od)}${FN.id ? ` · ID ${fmt(FN.id)}` : ''} · PITCH ${fmt(FN.pitch)}`,
      ...(FN.clear != null ? [`OTHER LEG ALIKE · FINS ${fmt(FN.clear)} APART`] : [])], { size: 2.3 }));
    out.push(K.dimH(cx - R, cx + R, cy + Rf + 4, `Ø${tube.diaMm}`, { fromY1: cy, fromY2: cy, above: false, size: 2.4 }));
  } else out.push(K.dimH(cx - R, cx + R, cy + R + 6, `Ø${tube.diaMm}`, { fromY1: cy, fromY2: cy, above: false, size: 2.4 }));

  // ── The callout the floor reads first — as on PHE's SolidWorks drawings ──
  // It prints exactly the total length the job card is sent.
  out.push(K.rect(174, 196, 96, 40, { stroke: '#1a1a1a', sw: 0.5 }));
  out.push(K.text(177, 205, `TOTAL LENGTH = ${totalStr} INCH`, { size: 4.4, weight: 700 }));
  out.push(K.text(267, 205, `(${n1(geo.clMm)} mm)`, { size: 2.4, anchor: 'end' }));
  out.push(K.text(177, 213, `DIAMETER = ${tube.diaMm} MM`, { size: 4.0, weight: 700 }));
  // The roller (owner, 14 Nov 2026: "a roller is basically a tool on which the
  // heater is bend to a u"): a roller not in her list is marked NEW, in red; when
  // the roller gives an inside other than the client's, one short line says so.
  const rollerLine = rollerKnown ? `ROLLER = ${fmt(shape.rollerMm)} MM` : 'ROLLER = TO CHOOSE';
  const rollerNew = rollerKnown && shape.rollerIsNew;
  if (rollerNew) out.push(`<text x="177" y="221" font-size="4" text-anchor="start" font-weight="700" fill="#1a1a1a">${K.esc(rollerLine)} <tspan fill="${C.red}">NEW</tspan></text>`);
  else out.push(K.text(177, 221, rollerLine, { size: 4.0, weight: 700, color: rollerKnown ? '#1a1a1a' : C.red }));
  const rollerEnd = 177 + K.textWidth(rollerNew ? `${rollerLine} NEW` : rollerLine, 4.0, 700);
  if (shape.clientInsideMm != null && shape.clientInsideMm !== '' && Number(shape.clientInsideMm) !== insideMm) {
    const ci = rollerKnown ? `client's inside ${fmt(shape.clientInsideMm)} · roller ${fmt(shape.rollerMm)} gives ${fmt(insideMm)}` : `client's inside ${fmt(shape.clientInsideMm)}`;
    const room = 267 - rollerEnd - 2;
    out.push(K.text(267, 221, ci, { size: K.fitSize(ci, room, 2.2, 400, 1.5), anchor: 'end', color: C.blue }));
  }
  // A long fitting name is set smaller to stay inside the box.
  const tn = String(spec.terminalNote || '');
  out.push(K.text(177, 228, tn, { size: K.fitSize(tn, 90, tn.length > 40 ? 2.3 : 2.8, 700), weight: 700, color: toConfirm ? C.red : '#1a1a1a' }));
  out.push(K.text(177, 233.5, `Job card adds 0.7" (${n2(card.totalLengthIn)}") and cuts ${n2(card.cuttingLengthIn)}" (${n1(card.cuttingLengthMm)} mm) before draw.`, { size: 2.0, color: '#444' }));

  // ── Right column: element table, then parts and material by stage ──
  const T1 = K.table(276, 29, [37, 95], card.rows, { title: `ELEMENT — EACH (${item.qty} NOS)`, rowH: 5.6, size: 2.35 });
  out.push(T1.svg);
  const y2 = 29 + T1.height + 4;
  // A long list drops the Hindi line, then the Gujarati, rather than run into the title block.
  const rowsFor = (lines) => parts.map(p => [String(p.no), p.stage, [p.line1, ...(lines >= 2 ? [p.gu] : []), ...(lines >= 3 ? [p.hi] : [])], p.perPc, p.forOrder]);
  const t2opts = { title: `PARTS AND MATERIAL BY STAGE — FOR ${item.qty} NOS`, head: ['#', 'Used at', 'Part (inventory)', 'Per pc', `For ${item.qty}`], size: 2.2, rowH: 5, boldFirstLine: true, align: ['middle', 'start', 'start', 'end', 'end'] };
  let T2 = null;
  for (const lines of [3, 2, 1]) { T2 = K.table(276, y2, [6.5, 21, 67.5, 18.5, 18.5], rowsFor(lines), t2opts); if (y2 + T2.height <= 236) break; }
  // Still too long (fins, brackets and a heavy pin or a nipple set): one line a
  // cell, then smaller letters; if even that runs into the title block,
  // tablesFit says so and the agent refuses the sheet (review, 16 Nov 2026).
  let tablesFit = y2 + T2.height <= 236;
  for (const size of tablesFit ? [] : [2.0, 1.9]) {
    T2 = K.table(276, y2, [6.5, 21, 67.5, 18.5, 18.5], rowsFor(1), { ...t2opts, size });
    if (y2 + T2.height <= 236) { tablesFit = true; break; }
  }
  if (!tablesFit) {
    const flat = parts.map(p => [String(p.no), [].concat(p.stage).filter(Boolean).join(' '), p.line1, [].concat(p.perPc).filter(Boolean).join(' · '), p.forOrder]);
    for (const [size, rowH] of [[2.2, 5], [2.0, 4.4], [1.9, 4.1]]) {
      T2 = K.table(276, y2, [6.5, 21, 67.5, 18.5, 18.5], flat, { ...t2opts, size, rowH, headH: Math.min(5.5, rowH + 0.5), titleH: Math.min(5.5, rowH + 0.5) });
      if (y2 + T2.height <= 236) { tablesFit = true; break; }
    }
  }
  out.push(T2.svg);

  // ── Notes ── wrapped by measured width, and set smaller (line spacing with
  // it) until the whole set fits the box: 238 × 45 at (12, 240), first line at
  // 250.5. Her answers can be long (an answer or a note up to 400 letters), so
  // when even the smallest size will not hold them, notesFit says so and the
  // agent refuses the sheet rather than lose the end of a note (review, 14 Nov 2026).
  out.push(K.rect(12, 240, 238, 45, { sw: 0.35 }));
  out.push(K.text(16, 245.5, 'NOTES', { size: 2.8, weight: 700, color: K.NAVY }));
  const NOTE_X = 16, NOTE_X2 = 19.5, NOTE_RIGHT = 248.5, NOTE_TOP = 250.5, NOTE_FLOOR = 284.4;
  const wrapTo = (str, first, rest, size) => {
    const lines = []; let cur = '';
    const room = () => (lines.length ? rest : first);
    for (const w of String(str).split(' ').filter(Boolean)) {
      const next = cur ? `${cur} ${w}` : w;
      if (K.textWidth(next, size) <= room()) { cur = next; continue; }
      if (cur) { lines.push(cur); cur = ''; }
      // A word longer than the line (a long code) is broken where it reaches the edge.
      let word = w;
      while (K.textWidth(word, size) > room()) {
        let k = word.length - 1;
        while (k > 1 && K.textWidth(word.slice(0, k), size) > room()) k--;
        lines.push(word.slice(0, k)); word = word.slice(k);
      }
      cur = word;
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  };
  const layNotes = (size, lead, gapF) => {
    const step = size * lead, gap = size * gapF;
    const noteLines = notes.map((nt, i) => (Array.isArray(nt) ? nt : [nt]).flatMap((l, k) => (k === 0
      ? wrapTo(l, NOTE_RIGHT - NOTE_X - K.textWidth(`${i + 1}. `, size), NOTE_RIGHT - NOTE_X2, size)
      : wrapTo(l, NOTE_RIGHT - NOTE_X2, NOTE_RIGHT - NOTE_X2, size))));
    const nLines = noteLines.reduce((a, l) => a + l.length, 0);
    const lastBaseline = NOTE_TOP + (nLines - 1) * step + (noteLines.length - 1) * gap;
    return { size, step, gap, noteLines, fits: lastBaseline + size * 0.25 <= NOTE_FLOOR };
  };
  // Largest letters first; at each size the usual spacing, then lines set
  // closer (1.25, as svgKit sets a block of lines) before going a size down.
  const NOTE_SIZES = [2.1, 2.0, 1.9, 1.8, 1.7, 1.6, 1.5];
  let lay = null;
  for (const size of NOTE_SIZES) {
    lay = layNotes(size, 1.38, 0.4);
    if (lay.fits) break;
    lay = layNotes(size, 1.25, 0.2);
    if (lay.fits) break;
  }
  let ny = NOTE_TOP;
  lay.noteLines.forEach((lines, i) => {
    const red = /TO CONFIRM/.test(lines.join(' '));
    out.push(K.text(NOTE_X, ny, `${i + 1}. ${lines[0]}`, { size: lay.size, color: red ? C.red : '#1a1a1a' }));
    lines.slice(1).forEach((l, k) => out.push(K.text(NOTE_X2, ny + (k + 1) * lay.step, l, { size: lay.size, color: red ? C.red : '#1a1a1a' })));
    ny += lines.length * lay.step + lay.gap;
  });

  // ── Title block: the fields PHE's SolidWorks block carries ──
  const tx = 254, ty = 240, tw = 154;
  out.push(K.rect(tx, ty, tw, 45, { sw: 0.5 }));
  out.push(K.rect(tx, ty, 116, 9, { sw: 0.3 }), K.rect(tx + 116, ty, 38, 9, { sw: 0.3 }));
  out.push(K.text(tx + 2, ty + 4.6, 'PEENA HEAT ELEMENTS LLP', { size: 3.2, weight: 700, color: K.NAVY }));
  out.push(K.text(tx + 2, ty + 7.9, 'Santej, Gandhinagar, Gujarat – 382721 · www.phe.co.in', { size: 1.8, color: '#444' }));
  out.push(K.text(tx + 135, ty + 2.6, 'STATUS', { size: 1.5, anchor: 'middle', color: '#666' }));
  const forProduction = /^FOR PRODUCTION/.test(String(tb.status));
  out.push(K.text(tx + 135, ty + 5.6, String(tb.status).split(' — '), { size: 1.95, anchor: 'middle', weight: 700, color: forProduction ? C.green : C.red }));
  out.push(K.rect(tx, ty + 9, tw, 9, { sw: 0.3 }));
  out.push(K.text(tx + 2, ty + 15.2, spec.title, { size: 3.1, weight: 700 }));
  out.push(K.text(tx + tw - 2, ty + 15.2, spec.subtitle, { size: 2.0, anchor: 'end', color: '#444' }));
  const cell = (x, y, w, label, value) => [K.rect(x, y, w, 9, { sw: 0.25 }), K.text(x + 1.2, y + 2.7, label, { size: 1.7, color: '#666' }), K.text(x + 1.2, y + 7.3, value, { size: String(value).length * 2.3 * 0.62 > w - 2 ? 1.9 : 2.3, weight: 700 })].join('');
  const rows = [
    [[30, 'MATERIAL', tb.material], [32, 'WATTAGE / VOLTAGE', tb.wattVolt], [22, 'QUANTITY', tb.qty], [22, 'CLIENT CODE', tb.client], [48, 'PRODUCT CODE', tb.product]],
    [[52, 'DWG NO', tb.dwgNo], [12, 'REV', tb.rev], [24, 'DATE', tb.date], [28, 'ORDER', tb.order], [38, 'SIZE · SCALE · PROJECTION', 'A3 · AS SHOWN · 3rd ANGLE']],
    [[30, 'DRAWN', tb.drawn], [28, "CHK'D", tb.checked], [38, "APPV'D", tb.approved], [58, 'TOLERANCES (LINEAR · ANGULAR)', '0.0 ±0.25 · 0 ±1.0 · ±1°']],
  ];
  rows.forEach((r, i) => { let cx2 = tx; r.forEach(([w, l, v]) => { out.push(cell(cx2, ty + 18 + i * 9, w, l, v)); cx2 += w; }); });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}mm" height="${H}mm" font-family="Arial, Helvetica, 'Noto Sans Gujarati', 'Noto Sans Devanagari', sans-serif">${out.join('')}</svg>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${K.esc(item.drawingNumber)} — drawing</title>
<style>@page { size: A3 landscape; margin: 0 } html, body { margin: 0; background: #fff } svg { display: block; width: 420mm; height: 297mm }</style></head><body>${svg}</body></html>`;
  return { svg, html, notesFit: lay.fits, notesSize: lay.size, tablesFit };
}

module.exports = { deriveUShape, uLengthForCentreline, renderUTypeSheet, FITTING_SETS };
