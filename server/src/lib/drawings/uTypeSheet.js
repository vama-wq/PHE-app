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
  const toConfirm = !fit.confirmed;
  const redTag = (x, y, label = 'TO CONFIRM', size = 2.3) => {
    const w = label.length * size * 0.6 + 2.4;
    return K.rect(x, y - size - 0.9, w, size + 2, { stroke: C.red, sw: 0.35, fill: '#fff' })
      + K.text(x + 1.2, y, label, { size, weight: 700, color: C.red });
  };

  // One fitting at sheet scale sc, its left edge at x, centred on y. A heavy
  // pin's stud and a nipple's thread are drawn with it.
  const drawPart = (role, x, y, sc) => {
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
      const hx = x + p.t * sc;
      o.push(K.rect(hx, y - (p.threadH * sc) / 2, p.threadT * sc, p.threadH * sc, { fill: C.brass, stroke: '#6b5520', sw }));
      if (sc >= 1) for (let xx = hx + 0.6; xx < hx + p.threadT * sc - 0.6; xx += 1.3) o.push(K.line(xx, y - (p.threadH * sc) / 2, xx + 0.8, y + (p.threadH * sc) / 2, { w: 0.12, color: '#8a6d1f' }));
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

  // ── Elevation, scale 1:2 (legs broken when they would not fit) ──
  const s = 0.5;
  const X0 = 36, Yc = 79;
  const half = (geo.cc / 2) * s, r = (tube.diaMm / 2) * s;
  const yT = Yc - half, yB = Yc + half;
  const LEG_MAX = 217.9;                              // an 18U leg at 1:2 just fits
  const legPaper = geo.straight * s;
  const broken = legPaper > LEG_MAX + 0.01;
  const Xb = X0 + Math.min(legPaper, LEG_MAX);
  const xOuter = Xb + half + r;
  const czBig = card.coldZoneBigIn * 25.4 * s, czSmall = card.coldZoneSmallIn * 25.4 * s;
  const czMax = Math.max(czBig, czSmall);
  const heatedPaper = Math.max(4, Xb - X0 - czMax);
  const pinOut = 25.4 * s;
  out.push(K.viewTitle(150, 32, 'ELEVATION (SCALE 1:2)', broken ? 'Terminal end on the left · as bent · legs broken, true length dimensioned' : 'Terminal end on the left · as bent'));
  const uPath = `M${K.f(X0)},${K.f(yT)} L${K.f(Xb)},${K.f(yT)} A${K.f(half)},${K.f(half)} 0 0 1 ${K.f(Xb)},${K.f(yB)} L${K.f(X0)},${K.f(yB)}`;
  out.push(K.path(uPath, { stroke: C.sheath, sw: tube.diaMm * s, cap: 'butt' }));
  out.push(K.path(uPath, { stroke: C.heated, sw: tube.diaMm * s - 0.55, cap: 'butt' }));
  out.push(K.line(X0, yT, X0 + czBig, yT, { w: tube.diaMm * s - 0.55, color: C.cold }));
  out.push(K.line(X0, yB, X0 + czSmall, yB, { w: tube.diaMm * s - 0.55, color: C.cold }));
  for (const [x, y] of [[X0 + czBig, yT], [X0 + czSmall, yB]]) out.push(K.line(x, y - r - 0.8, x, y + r + 0.8, { w: 0.3 }));
  if (broken) {
    // A gap in both legs inside the heated zone, closed by the usual S-breaks.
    const xg = X0 + czMax + heatedPaper * 0.66;
    for (const y of [yT, yB]) {
      out.push(K.rect(xg - 2.2, y - r - 0.6, 4.4, 2 * r + 1.2, { fill: '#fff', stroke: 'none' }));
      for (const x of [xg - 2.2, xg + 2.2]) out.push(K.path(`M${K.f(x)},${K.f(y - r - 0.9)} C${K.f(x + 1.1)},${K.f(y - r / 2)} ${K.f(x - 1.1)},${K.f(y + r / 2)} ${K.f(x)},${K.f(y + r + 0.9)}`, { sw: 0.25 }));
    }
  }
  out.push(K.line(Xb + half + r + 2, Yc, X0 - 16, Yc, { w: 0.15, dash: '4 1 1 1', color: '#777' }));
  // Pins, the sealing bush (its spigot hidden in the tube) and the fittings, as
  // Detail D draws them, at 1:2.
  const esbH = (tube.diaMm + 2) * s;
  for (const y of [yT, yB]) {
    out.push(K.rect(X0 - pinOut, y - (pinThread * s) / 2, pinOut, pinThread * s, { fill: C.pin, stroke: '#555', sw: 0.15 }));
    out.push(K.rect(X0 - 1.2, y - esbH / 2, 1.2, esbH, { fill: C.esb, stroke: 'none' }));
    out.push(K.rect(X0, y - 1.4, 2.2, 2.8, { fill: 'none', stroke: '#555', sw: 0.12, dash: '0.5 0.35' }));
    for (const p of layoutTube(X0, s)) out.push(drawPart(p.role, p.x, y, s));
    for (const p of layoutPin(X0 - 1.2, X0 - pinOut, s)) out.push(drawPart(p.role, p.x, y, s));
  }
  // Which end takes which pin (the app's rule: W/H at the big end, W/O at the small).
  out.push(K.text(X0 + czBig + 3, yT - r - 1.3, 'BIG END · PIN W/H', { size: 2.2, weight: 700, color: C.blue }));
  out.push(K.text(X0 + czSmall + 3, yB + r + 3.3, 'SMALL END · PIN W/O', { size: 2.2, weight: 700, color: C.blue }));
  // Dimensions. The U length always gives the true figure, broken view or not.
  // Total length = 2 × U (owner's ruling R1, 14 Nov 2026): the U is drawn as it
  // comes out of that tube, so its true end-to-end length is dimensioned here.
  // A short U (7U and under) has room only for the figure and its label; the
  // rest is in the element table and the notes.
  let uLabel = r1Mode === 'b' || r1Mode === '2u'
    ? `${n1(shape.uLengthMm)} U LENGTH "${shape.uLabel}" — AS IT COMES OUT OF THE ${totalStr}" (2 × ${String(shape.uLengthIn)}") TUBE`
    : `${n1(shape.uLengthMm)} (${String(shape.uLengthIn)}") U LENGTH "${shape.uLabel}" — END OF THE TUBE TO THE FAR END OF THE U`;
  if (K.textWidth(uLabel, 2.7) > xOuter - X0 - 3) uLabel = `${n1(shape.uLengthMm)} U LENGTH "${shape.uLabel}"`;
  out.push(K.dimH(X0, xOuter, 51, uLabel, { fromY1: yT - r, fromY2: Yc, size: 2.7 }));
  out.push(K.dimH(X0, X0 + czBig, 61, `${n1(card.coldZoneBigIn * 25.4)} (${card.coldZoneBigIn}") COLD ZONE`, { fromY1: yT - r, fromY2: yT - r, size: 2.6 }));
  out.push(K.dimH(X0 - pinOut, X0, 99, '25.4 (1") PIN OUT', { fromY1: yB + 1, fromY2: yB + r, above: false, size: 2.5 }));
  out.push(K.dimV(yT - r, yB + r, xOuter + 4.5, `${shape.outsideWidthMm} OUTSIDE`, { fromX1: Xb, fromX2: Xb, size: 2.6 }));
  // Section mark T–T in the heated zone of the top leg, clear of the BIG END
  // label on a short U; the INSIDE dimension keeps clear of it.
  let xt = X0 + czMax + heatedPaper * 0.33;
  if (xt < X0 + czBig + 31 && X0 + czBig + 31 < Xb - 10) xt = X0 + czBig + 31;
  let xg = Xb - 20;
  if (Math.abs(xg - xt) < 8) xg = Math.min(Xb - 6, xt + 10);
  out.push(K.dimV(yT + r, yB - r, xg, `${geo.insideMm} INSIDE`, { size: 2.2 }));
  for (const y of [yT - r - 3.2, yT + r + 3.2]) {
    out.push(K.line(xt, y - 1.6, xt, y + 1.6, { w: 0.35 }));
    out.push(K.line(xt, y, xt - 3, y, { w: 0.25 }), K.arrowhead(xt - 3, y, Math.PI, { len: 1.4, half: 0.5, color: '#111' }));
    out.push(K.text(xt + 1.2, y + (y < yT ? -0.6 : 2.4), 'T', { size: 2.5, weight: 700 }));
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
  const sheathRight = xOuter - 5, sheathMin = Math.max(X0 + czBig + 32, xt + 5);
  const sheathFit = (txt) => Math.min(xt + 36, sheathRight - textW(txt));
  if (sheathFit(sheathLong) >= sheathMin) {
    const lx = sheathFit(sheathLong);
    out.push(K.leader(Math.min(xt + 30, lx - 6), yT - r, lx, 64.5, sheathLong, { size: 2.4 }));
  } else if (sheathFit(sheathShort) >= sheathMin) {
    const lx = sheathFit(sheathShort);
    out.push(K.leader(Math.min(xt + 30, lx - 6), yT - r, lx, 64.5, sheathShort, { size: 2.4 }));
  } else if (xOuter + 9 + textW(sheathShort) <= RIGHT) {
    const txt = xOuter + 9 + textW(sheathLong) <= RIGHT ? sheathLong : sheathShort;
    out.push(K.leader(Xb + half * Math.cos(-Math.PI / 3), Yc + half * Math.sin(-Math.PI / 3), xOuter + 9, 61, txt, { size: 2.4 }));
  } else {
    // Right of a straight-up leader, inside the U length's extension lines; left
    // of it when only that side has room.
    const fx = Math.min(Math.max(X0 + czBig + 30, xt + 6), Xb - 2);   // clear of BIG END and the T–T mark
    const roomR = xOuter - 2 - fx, roomL = fx - X0 - 2;
    const txt = [sheathLong, sheathShort].find(t => textW(t) <= roomR) || [sheathLong, sheathShort].find(t => textW(t) <= roomL) || sheathShort;
    const side = textW(txt) > roomR && textW(txt) <= roomL ? 'left' : 'right';
    out.push(K.leader(fx, yT - r, fx, 56, txt, { size: side === 'right' ? K.fitSize(txt, roomR - 3.3, 2.4) : 2.4, side }));
  }
  const czLines = [`COLD ZONE ${card.coldZoneBigIn}" (${n1(card.coldZoneBigIn * 25.4)}) EACH LEG — NO COIL`, `PIN ${card.pinStudsIn}": ${card.pinStudsIn - 1}" IN THE TUBE + 1" OUT`];
  const czTxtEnd = X0 + czSmall + 8 + Math.max(...czLines.map(textW));
  out.push(K.leader(X0 + czSmall * 0.55, yB + r, X0 + czSmall + 8, 109, czLines, { size: 2.4 }));
  // The heated-zone leader must not cut through the cold-zone label on a short U.
  let xh = X0 + czMax + heatedPaper * 0.485, xhl = xh + 6;
  if (xh < X0 + czSmall + 30 && X0 + czSmall + 30 < Xb - 4) { xh = X0 + czSmall + 30; xhl = xh + 6; }   // clear of SMALL END
  if (xh < czTxtEnd + 4) {
    if (czTxtEnd + 4 < Xb - 4) { xh = czTxtEnd + 4; xhl = xh + 6; } else xhl = xh + (czTxtEnd + 2 - xh) / 0.683;
  }
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
  out.push(K.leader(xh, yB + r, xhl, 117, hTxt, { size: 2.4, side: hSide }));
  const ra = Math.PI / 6;
  const rTxt = `R${n1(geo.rCL)} CL · ROLLER ${shape.rollerMm}`;
  // Left of the bend, beside the cold-zone label; a short U leaves no room there,
  // so right of the bend — unless that runs into the table, then left of the
  // bend one row up, clear of the two leaders that cross that row.
  const rW = textW(rTxt), rLeftEdge = Xb - 10 - rW;
  const atRow = (x1, y1, x2, y2, y) => x1 + ((x2 - x1) * (y - y1)) / (y2 - y1);   // a leader's x at height y
  let rAt = [xOuter + 9, 103];
  if (rLeftEdge > czTxtEnd && rLeftEdge > xh + (xhl - xh) * 0.683 + 2) rAt = [Xb - 10, 109];
  else if (xOuter + 9 + rW > RIGHT && rLeftEdge > 2 + Math.max(atRow(xh, yB + r, xhl, 117, 103), atRow(X0 + czSmall * 0.55, yB + r, X0 + czSmall + 8, 109, 103))) rAt = [Xb - 10, 103];
  out.push(K.leader(Xb + half * Math.cos(ra), Yc + half * Math.sin(ra), rAt[0], rAt[1], rTxt, { size: 2.4 }));
  out.push(K.circle(X0 - 6, Yc, 15.5, { stroke: C.blue, sw: 0.3, dash: '1.6 0.9' }));
  // The letter goes right of anything on the tube (a nipple set reaches past it).
  const tubeEnd = Math.max(X0, ...layoutTube(X0, s).map(p => p.x + (p.role === 'nipple' ? sz.nipple.t + sz.nipple.threadT : (sz[p.role] || { t: 2 }).t) * s));
  out.push(K.text(Math.max(X0 + 8, tubeEnd + 1.5), Yc - 12.5, 'D', { size: 3.3, weight: 700, color: C.blue }));
  out.push(K.leader(X0 - 6 + 15.5 * Math.cos(0.95), Yc + 15.5 * Math.sin(0.95), X0 + 20, 125, 'TERMINAL END AND FITTING ORDER — SEE DETAIL D', { size: 2.4, color: C.blue }));

  // ── Detail D: terminal end, one leg, scale 2:1 (3:2 with a nipple) ──
  // A nipple is too big for 2:1: 3:2 for M12, 5:4 for M16.
  const sD = fit.tube.includes('nipple') ? (String(fit.nipple).toUpperCase() === 'M16' ? 1.25 : 1.5) : 2;
  out.push(K.viewTitle(92, 135, `DETAIL D — TERMINAL END, ONE LEG (SCALE ${({ 2: '2:1', 1.5: '3:2', 1.25: '5:4' })[sD]})`));
  const tubeR = (tube.diaMm / 2) * sD, pinR = (pinThread / 2) * sD, xm = 120, xEnd = 168;
  const pinL = 25.4 * sD, pinEndX = xm - pinL, esbW = 2 * sD;
  const tubeParts = layoutTube(xm, sD);
  const maxHalf = Math.max(tubeR + 1, ...fit.pin.map(rl => partHalfH(rl, sD)), ...fit.tube.map(rl => partHalfH(rl, sD)));
  const balloonY = Math.min(143, 160 - maxHalf - 4.5);
  const drawLeg = (y, { stack = true } = {}) => {
    const o = [];
    o.push(K.rect(xm, y - tubeR, xEnd - xm, tubeR * 2, { fill: C.cold, stroke: '#1a1a1a', sw: 0.35 }));
    o.push(K.breakMark(xEnd, y - tubeR, y + tubeR));
    o.push(K.line(xm, y - pinR, xEnd, y - pinR, { w: 0.2, dash: '1 0.7', color: '#555' }), K.line(xm, y + pinR, xEnd, y + pinR, { w: 0.2, dash: '1 0.7', color: '#555' }));
    o.push(K.rect(pinEndX, y - pinR, pinL, pinR * 2, { fill: C.pin, stroke: '#444', sw: 0.2 }));
    for (let x = pinEndX + 1; x < xm - 0.5; x += 1.4) o.push(K.line(x, y - pinR, x + 0.9, y + pinR, { w: 0.12, color: '#666' }));
    o.push(K.rect(xm - esbW, y - tubeR - 1, esbW, tubeR * 2 + 2, { fill: C.esb, stroke: 'none' }));
    o.push(K.rect(xm, y - tubeR + 1.2, 3 * sD, tubeR * 2 - 2.4, { fill: 'none', stroke: '#555', sw: 0.25, dash: '1 0.6' }));
    for (const p of tubeParts) o.push(drawPart(p.role, p.x, y, sD));
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
  const ballooned = [[xm - esbW / 2, 'esb', tubeR + 1], ...pinLay.map(p => [p.mid, p.role, p.role === 'hvpin' ? sz.hvpin.h * sD / 2 : partHalfH(p.role, sD)])].sort((a, b) => b[0] - a[0]);
  let bx = 131.2;
  ballooned.forEach(([x, role, hh]) => { bx = Math.min(bx - 8.2, x + 8); out.push(K.balloonLeader(x, ya - hh - 0.5, bx, balloonY, no(role))); });
  tubeParts.forEach((p, i) => out.push(K.balloonLeader(p.mid, ya - partHalfH(p.role, sD) - 0.5, Math.max(131.2 + i * 8.2, p.mid + 3), balloonY, no(p.role))));
  const pinLow = Math.max(0, ...pinLay.map(p => (p.role === 'hvpin' ? sz.hvpin.h * sD / 2 : partHalfH(p.role, sD)))) > 9.5;
  // On the M4 / M5 thread itself — past a heavy pin's hex body, which covers the pin's end.
  const pinFoot = fit.pin.includes('hvpin') ? pinEndX + sz.hvpin.t * sD + 14 : pinEndX + (pinLow ? 4 : 9);
  out.push(K.leader(pinFoot, ya + pinR, pinEndX - 6, pinLow ? 178 : 171, [`${stud} SS PIN ${card.pinStudsIn}" — W/H: BIG END,`, `W/O: SMALL END (PARTS ${[no('pinwh'), no('pinwo')].join(', ')})`], { size: 2.2 }));
  out.push(K.dimH(pinEndX, xm, 172, '25.4 (1")', { fromY1: ya + pinR, fromY2: ya + tubeR, above: false, size: 2.3 }));
  out.push(K.leader(tubeParts.length ? xEnd - 4 : 150, ya + pinR, 146, 187, [`PIN ${card.pinStudsIn - 1}" (${n1((card.pinStudsIn - 1) * 25.4)}) IN THE TUBE, SPOT WELDED`, 'TO THE COIL AT St 4 · ESB SPIGOT SHOWN DASHED'], { size: 2.2 }));
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
  }
  for (const p of exp) out.push(drawPart(p.role, p.x, ye, sD));
  const arrowX = pinEndX + 3;
  out.push(K.line(arrowX, ye - 9, arrowX + 22, ye - 9, { w: 0.25, color: C.blue }), K.arrowhead(arrowX + 22, ye - 9, 0, { color: C.blue }));
  out.push(K.text(arrowX + 11, ye - 10.5, 'slide on in this order', { size: 2.0, anchor: 'middle', color: C.blue }));
  const letters = 'ABCDEFGHIJ';
  let li = 0;
  if (tubeParts.length) {
    // The parts on the tube go on first, as one step.
    const isNipple = fit.tube.includes('nipple');
    const yl = ye + Math.max(...fit.tube.map(rl => partHalfH(rl, sD))) + 3.4;
    const what = isNipple ? (fit.tube.length > 1 ? `${NAME.nipple} set` : NAME.nipple) : 'bracket';
    out.push(K.text(xm + 7, yl, `${letters[li++]} · ${what} · ${stageOf(fit.tube[0])}${isNipple ? '' : ' (before the ESB)'}`, { size: 2.1, weight: 700, color: C.blue }));
  }
  const steps = [{ x: xm - esbW / 2, role: 'esb', name: 'ESB' }, ...exp.map(p => ({ x: p.mid, role: p.role, name: NAME[p.role] || p.role }))];
  const yL = ye + Math.max(13.5, tubeR + 1 + 3.2, ...fit.pin.map(rl => (rl === 'hvpin' ? sz.hvpin.h * sD / 2 : partHalfH(rl, sD)) + 3.2));
  for (const st of steps) {
    out.push(K.text(st.x, yL, letters[li++] || '?', { size: 2.6, anchor: 'middle', weight: 700, color: C.blue }));
    out.push(K.text(st.x, yL + 3.1, [st.name, stageOf(st.role)], { size: 2.0, anchor: 'middle', color: '#333' }));
    out.push(K.balloon(st.x, ye - 15.5, no(st.role), { r: 2.3 }));
  }

  // ── Section T–T, scale 4:1 (3:1 on Ø11) ──
  const sT = Number(tube.diaMm) === 11 ? 3 : 4;
  out.push(K.viewTitle(221, 135, `SECTION T–T (SCALE ${sT}:1)`));
  const cx = 196, cy = 160, R = (tube.diaMm / 2) * sT, Ri = R - tube.wallMm * sT;
  out.push(`<defs><pattern id="mgo" width="1.6" height="1.6" patternUnits="userSpaceOnUse"><circle cx="0.8" cy="0.8" r="0.22" fill="#9a8f7a"/></pattern></defs>`);
  out.push(K.circle(cx, cy, R, { fill: '#d9dde2', stroke: '#1a1a1a', sw: 0.4 }));
  out.push(K.circle(cx, cy, Ri, { fill: '#f7f3ea', stroke: '#1a1a1a', sw: 0.3 }));
  out.push(K.circle(cx, cy, Ri - 0.1, { fill: 'url(#mgo)', stroke: 'none' }));
  const coilR = (card.mandrelMm / 2 + card.wireDiaMm / 2) * sT;
  out.push(K.circle(cx, cy, coilR, { stroke: '#9c5a1c', sw: card.wireDiaMm * sT }));
  out.push(K.line(cx - R - 3, cy, cx + R + 3, cy, { w: 0.15, dash: '3 1 1 1', color: '#777' }), K.line(cx, cy - R - 3, cx, cy + R + 3, { w: 0.15, dash: '3 1 1 1', color: '#777' }));
  out.push(K.leader(cx + R * Math.cos(-0.7), cy + R * Math.sin(-0.7), 218, 145, `SHEATH — ${tube.material.toUpperCase()}, Ø${tube.diaMm}`, { size: 2.3 }));
  out.push(K.leader(cx + 9, cy - 5, 218, 154, 'MgO — COMPACTED (MGO-65A)', { size: 2.3 }));
  out.push(K.leader(cx + coilR * Math.cos(0.35), cy + coilR * Math.sin(0.35), 218, 167, [`COIL — ${card.gauge} SWG FeCrAl (${card.wireCode})`, `ON ${card.mandrelMm} MM MANDREL`], { size: 2.3 }));
  out.push(K.dimH(cx - R, cx + R, cy + R + 6, `Ø${tube.diaMm}`, { fromY1: cy, fromY2: cy, above: false, size: 2.4 }));

  // ── The callout the floor reads first — as on PHE's SolidWorks drawings ──
  // It prints exactly the total length the job card is sent.
  out.push(K.rect(174, 196, 96, 40, { stroke: '#1a1a1a', sw: 0.5 }));
  out.push(K.text(177, 205, `TOTAL LENGTH = ${totalStr} INCH`, { size: 4.4, weight: 700 }));
  out.push(K.text(267, 205, `(${n1(geo.clMm)} mm)`, { size: 2.4, anchor: 'end' }));
  out.push(K.text(177, 213, `DIAMETER = ${tube.diaMm} MM`, { size: 4.0, weight: 700 }));
  out.push(K.text(177, 221, `ROLLER = ${shape.rollerMm} MM`, { size: 4.0, weight: 700 }));
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
  return { svg, html, notesFit: lay.fits, notesSize: lay.size };
}

module.exports = { deriveUShape, uLengthForCentreline, renderUTypeSheet, FITTING_SETS };
