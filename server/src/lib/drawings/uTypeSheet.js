// ── U type heater drawing: one A3 production sheet (sample, owner 14 Nov 2026) ─
// "start with U type, show me a sample sheet keeping in mind how orders come in
// and are typed". The sheet follows the two drawings the owner liked (the 6 kW
// duct heater for Arihant Tec and the 9 kW steam generator heater) and keeps the
// conventions of PHE's own SolidWorks drawings: the TOTAL LENGTH / DIAMETER /
// ROLLER callout is the DRAWING length (the job card adds its 0.7" itself), the
// top strip, and the title-block fields the floor reads. Nothing is worked out
// here — the spec handed in already holds the order as typed, the shape, the
// job card engine's figures and the parts; this file only lays them out.
const K = require('./svgKit');

// U shape from the numbers design gives: U length L ("18U" = 18", from the end
// of the tube to the far end of the U), outside width W across both legs, tube
// Ø d. Checked against every U drawing in the app (14 Nov 2026): 122 exact, 13
// more to the hundredth — PHE drawings cut to two decimals, so this does too.
function deriveUShape({ uLengthMm, outsideWidthMm, tubeDiaMm }) {
  const cc = outsideWidthMm - tubeDiaMm;                 // leg centre to centre
  const rCL = cc / 2;                                     // bend radius on the centreline
  const straight = uLengthMm - (rCL + tubeDiaMm / 2);     // each leg, tube end to bend start
  const clMm = 2 * straight + Math.PI * rCL;              // whole tube along its centreline
  return { cc, rCL, straight, clMm, insideMm: outsideWidthMm - 2 * tubeDiaMm,
           drawingTotalIn: Math.floor((clMm / 25.4) * 100 + 1e-9) / 100 };
}

const C = {
  heated: '#f2d7bf', cold: '#e2e6eb', sheath: '#1a1a1a', pin: '#a7adb4', esb: '#3f3f3f',
  ss: '#b9c0c7', brass: '#d8b75c', green: '#1f7a3a', red: '#b42318', blue: '#2f5597',
};
const n2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
const n1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

function renderUTypeSheet(spec) {
  const { item, tube, shape, geo, card, parts, notes, tb } = spec;
  const out = [];
  const W = 420, H = 297;

  // ── Frame, banner and PHE's top strip ──
  out.push(K.rect(8, 8, W - 16, H - 16, { sw: 0.6 }));
  out.push(K.rect(12, 12, W - 24, 7.5, { fill: C.green, stroke: 'none' }));
  out.push(K.text(W / 2, 17.2, spec.banner, { size: 3.0, anchor: 'middle', weight: 700, color: '#fff' }));
  ['REMOVE ALL BURRS AND SHARP EDGES', 'IF IN DOUBT ASK !', 'DO NOT SCALE', 'ALL DIMENSIONS ARE IN MILLIMETRES'].forEach((t, i) => {
    out.push(K.rect(12 + i * 99, 20.5, 99, 5, { sw: 0.25 }));
    out.push(K.text(12 + i * 99 + 49.5, 24, t, { size: 2.2, anchor: 'middle', color: '#333' }));
  });

  // ── Elevation, scale 1:2 ──
  const s = 0.5;
  const X0 = 36, Yc = 79;
  const half = (geo.cc / 2) * s, r = (tube.diaMm / 2) * s;
  const yT = Yc - half, yB = Yc + half;
  const Xb = X0 + geo.straight * s;
  const xOuter = Xb + half + r;
  const czBig = card.coldZoneBigIn * 25.4 * s, czSmall = card.coldZoneSmallIn * 25.4 * s;
  const pinOut = 25.4 * s;
  out.push(K.viewTitle(150, 32, 'ELEVATION (SCALE 1:2)', 'Terminal end on the left · as bent'));
  const uPath = `M${K.f(X0)},${K.f(yT)} L${K.f(Xb)},${K.f(yT)} A${K.f(half)},${K.f(half)} 0 0 1 ${K.f(Xb)},${K.f(yB)} L${K.f(X0)},${K.f(yB)}`;
  out.push(K.path(uPath, { stroke: C.sheath, sw: tube.diaMm * s, cap: 'butt' }));
  out.push(K.path(uPath, { stroke: C.heated, sw: tube.diaMm * s - 0.55, cap: 'butt' }));
  out.push(K.line(X0, yT, X0 + czBig, yT, { w: tube.diaMm * s - 0.55, color: C.cold }));
  out.push(K.line(X0, yB, X0 + czSmall, yB, { w: tube.diaMm * s - 0.55, color: C.cold }));
  for (const [x, y] of [[X0 + czBig, yT], [X0 + czSmall, yB]]) out.push(K.line(x, y - r - 0.8, x, y + r + 0.8, { w: 0.3 }));
  out.push(K.line(Xb + half + r + 2, Yc, X0 - 16, Yc, { w: 0.15, dash: '4 1 1 1', color: '#777' }));
  // Pins, the sealing bush (its spigot hidden in the tube) and the nut stack.
  for (const y of [yT, yB]) {
    out.push(K.rect(X0 - pinOut, y - 1, pinOut, 2, { fill: C.pin, stroke: '#555', sw: 0.15 }));
    out.push(K.rect(X0 - 1.2, y - 2.5, 1.2, 5, { fill: C.esb, stroke: 'none' }));
    out.push(K.rect(X0, y - 1.4, 2.2, 2.8, { fill: 'none', stroke: '#555', sw: 0.12, dash: '0.5 0.35' }));
    let x = X0 - 1.2;
    for (const p of [{ w: 1.6, h: 3.5, fill: C.ss }, { w: 0.4, h: 4.5, fill: C.brass }, { w: 0.4, h: 4.5, fill: C.brass }, { w: 1.6, h: 3.5, fill: C.ss }]) {
      x -= p.w;
      out.push(K.rect(x, y - p.h / 2, p.w, p.h, { fill: p.fill, stroke: '#333', sw: 0.12, dash: p.dash || null }));
    }
  }
  // Which end takes which pin (the app's rule: W/H at the big end, W/O at the small).
  out.push(K.text(X0 + czBig + 3, yT - r - 1.3, 'BIG END · PIN W/H', { size: 2.2, weight: 700, color: C.blue }));
  out.push(K.text(X0 + czSmall + 3, yB + r + 3.3, 'SMALL END · PIN W/O', { size: 2.2, weight: 700, color: C.blue }));
  // Dimensions.
  out.push(K.dimH(X0, xOuter, 51, `${n1(shape.uLengthMm)} (${String(shape.uLengthIn)}") U LENGTH "${shape.uLabel}" — END OF THE TUBE TO THE FAR END OF THE U`, { fromY1: yT - r, fromY2: Yc, size: 2.7 }));
  out.push(K.dimH(X0, X0 + czBig, 61, `${n1(card.coldZoneBigIn * 25.4)} (${card.coldZoneBigIn}") COLD ZONE`, { fromY1: yT - r, fromY2: yT - r, size: 2.6 }));
  out.push(K.dimH(X0 - pinOut, X0, 99, '25.4 (1") PIN OUT', { fromY1: yB + 1, fromY2: yB + r, above: false, size: 2.5 }));
  out.push(K.dimV(yT - r, yB + r, xOuter + 4.5, `${shape.outsideWidthMm} OUTSIDE`, { fromX1: Xb, fromX2: Xb, size: 2.6 }));
  const xg = Xb - 20;
  out.push(K.dimV(yT + r, yB - r, xg, `${geo.insideMm} INSIDE`, { size: 2.2 }));
  // Section mark T–T in the heated zone of the top leg.
  const xt = X0 + 98;
  for (const y of [yT - r - 3.2, yT + r + 3.2]) {
    out.push(K.line(xt, y - 1.6, xt, y + 1.6, { w: 0.35 }));
    out.push(K.line(xt, y, xt - 3, y, { w: 0.25 }), K.arrowhead(xt - 3, y, Math.PI, { len: 1.4, half: 0.5, color: '#111' }));
    out.push(K.text(xt + 1.2, y + (y < yT ? -0.6 : 2.4), 'T', { size: 2.5, weight: 700 }));
  }
  // Callouts.
  out.push(K.leader(xt + 30, yT - r, xt + 36, 64.5, `Ø${tube.diaMm} SHEATH — ${tube.label} · ${item.finish.toUpperCase()}`, { size: 2.4 }));
  out.push(K.leader(X0 + czSmall * 0.55, yB + r, X0 + czSmall + 8, 109, [`COLD ZONE ${card.coldZoneBigIn}" (${n1(card.coldZoneBigIn * 25.4)}) EACH LEG — NO COIL`, `PIN ${card.pinStudsIn}": ${card.pinStudsIn - 1}" IN THE TUBE + 1" OUT`], { size: 2.4 }));
  out.push(K.leader(X0 + 125, yB + r, X0 + 131, 117, [`HEATED ZONE ≈ ${n1(card.heatedMm)} (${n2(card.heatedMm / 25.4)}") ALONG THE TUBE`, 'COIL INSIDE — SEE SECTION T–T'], { size: 2.4 }));
  const ra = Math.PI / 6;
  out.push(K.leader(Xb + half * Math.cos(ra), Yc + half * Math.sin(ra), Xb - 10, 109, `R${n1(geo.rCL)} CL · ROLLER ${shape.rollerMm}`, { size: 2.4 }));
  out.push(K.circle(X0 - 6, Yc, 15.5, { stroke: C.blue, sw: 0.3, dash: '1.6 0.9' }));
  out.push(K.text(X0 + 8, Yc - 12.5, 'D', { size: 3.3, weight: 700, color: C.blue }));
  out.push(K.leader(X0 - 6 + 15.5 * Math.cos(0.95), Yc + 15.5 * Math.sin(0.95), X0 + 20, 125, 'TERMINAL END AND FITTING ORDER — SEE DETAIL D', { size: 2.4, color: C.blue }));

  // ── Detail D: terminal end, one leg, scale 2:1 ──
  out.push(K.viewTitle(92, 135, 'DETAIL D — TERMINAL END, ONE LEG (SCALE 2:1)'));
  const s2 = 2, tubeR = (tube.diaMm / 2) * s2, pinR = (4 / 2) * s2, xm = 120, xEnd = 168;
  const pinL = 25.4 * s2;
  // Owner, 14 Nov 2026: ESB, then SS nut, washer, washer, SS nut — "there is
  // no wire lug in the middle".
  const STACK = [
    { key: 'ssnut', w: 6.4, h: 14, fill: C.ss }, { key: 'washer', w: 1.6, h: 18, fill: C.brass },
    { key: 'washer', w: 1.6, h: 18, fill: C.brass }, { key: 'ssnut', w: 6.4, h: 14, fill: C.ss },
  ];
  const drawLeg = (y, { stack = true } = {}) => {
    const o = [];
    o.push(K.rect(xm, y - tubeR, xEnd - xm, tubeR * 2, { fill: C.cold, stroke: '#1a1a1a', sw: 0.35 }));
    o.push(K.breakMark(xEnd, y - tubeR, y + tubeR));
    o.push(K.line(xm, y - pinR, xEnd, y - pinR, { w: 0.2, dash: '1 0.7', color: '#555' }), K.line(xm, y + pinR, xEnd, y + pinR, { w: 0.2, dash: '1 0.7', color: '#555' }));
    o.push(K.rect(xm - pinL, y - pinR, pinL, pinR * 2, { fill: C.pin, stroke: '#444', sw: 0.2 }));
    for (let x = xm - pinL + 1; x < xm - 0.5; x += 1.4) o.push(K.line(x, y - pinR, x + 0.9, y + pinR, { w: 0.12, color: '#666' }));
    o.push(K.rect(xm - 4, y - tubeR - 1, 4, tubeR * 2 + 2, { fill: C.esb, stroke: 'none' }));
    o.push(K.rect(xm, y - tubeR + 1.2, 6, tubeR * 2 - 2.4, { fill: 'none', stroke: '#555', sw: 0.25, dash: '1 0.6' }));
    if (stack) {
      let x = xm - 4;
      STACK.forEach((p) => { x -= p.w; o.push(K.rect(x, y - p.h / 2, p.w, p.h, { fill: p.fill, stroke: '#333', sw: 0.2, dash: p.dash || null })); p._x = x + p.w / 2; });
    }
    return o.join('');
  };
  const no = (key) => parts.find(p => p.key === key)?.no;
  const ya = 160;
  out.push(K.text(16, 146, 'ASSEMBLED', { size: 2.3, weight: 700, color: '#555' }));
  out.push(drawLeg(ya));
  const ballooned = [[xm - 2, 'esb'], ...STACK.map(p => [p._x, p.key])].sort((a, b) => b[0] - a[0]);
  ballooned.forEach(([x, key], i) => out.push(K.balloonLeader(x, ya - 9.5, 123 - i * 8.2, 143, no(key))));
  out.push(K.leader(xm - pinL + 9, ya + pinR, xm - pinL - 6, 171, [`M4 SS PIN ${card.pinStudsIn}" — W/H: BIG END,`, 'W/O: SMALL END (PARTS 2, 3)'], { size: 2.2 }));
  out.push(K.dimH(xm - pinL, xm, 172, '25.4 (1")', { fromY1: ya + pinR, fromY2: ya + tubeR, above: false, size: 2.3 }));
  out.push(K.leader(150, ya + pinR, 146, 187, [`PIN ${card.pinStudsIn - 1}" (${n1((card.pinStudsIn - 1) * 25.4)}) IN THE TUBE, SPOT WELDED`, 'TO THE COIL AT St 4 · ESB SPIGOT SHOWN DASHED'], { size: 2.2 }));
  // Exploded, in fitting order — lettered so the steps are not read as part numbers.
  const ye = 217;
  out.push(K.text(16, 198, 'FITTING ORDER', { size: 2.3, weight: 700, color: '#555' }));
  out.push(drawLeg(ye, { stack: false }));
  out.push(K.line(12.5, ye, xm - pinL, ye, { w: 0.15, dash: '4 1 1 1', color: '#777' }));
  const EXP = [{ x: 60, ...STACK[0] }, { x: 47, ...STACK[1] }, { x: 35, ...STACK[2] }, { x: 22, ...STACK[3] }];
  for (const p of EXP) out.push(K.rect(p.x - p.w / 2, ye - p.h / 2, p.w, p.h, { fill: p.fill, stroke: '#333', sw: 0.2, dash: p.dash || null }));
  out.push(K.line(72, ye - 9, 94, ye - 9, { w: 0.25, color: C.blue }), K.arrowhead(94, ye - 9, 0, { color: C.blue }));
  out.push(K.text(83, ye - 10.5, 'slide on in this order', { size: 2.0, anchor: 'middle', color: C.blue }));
  const steps = [
    { x: xm - 2, txt: ['A', 'ESB', 'St 23'], key: 'esb' }, { x: 60, txt: ['B', 'SS nut', 'St 26'], key: 'ssnut' },
    { x: 47, txt: ['C', 'washer', 'St 26'], key: 'washer' }, { x: 35, txt: ['D', 'washer', 'St 26'], key: 'washer' },
    { x: 22, txt: ['E', 'SS nut', 'St 26'], key: 'ssnut' },
  ];
  for (const st of steps) {
    out.push(K.text(st.x, ye + 13.5, st.txt[0], { size: 2.6, anchor: 'middle', weight: 700, color: C.blue }));
    out.push(K.text(st.x, ye + 16.6, st.txt.slice(1), { size: 2.0, anchor: 'middle', color: '#333' }));
    if (st.key) out.push(K.balloon(st.x, ye - 15.5, no(st.key), { r: 2.3 }));
  }

  // ── Section T–T, scale 4:1 ──
  out.push(K.viewTitle(221, 135, 'SECTION T–T (SCALE 4:1)'));
  const cx = 196, cy = 160, R = (tube.diaMm / 2) * 4, Ri = R - tube.wallMm * 4;
  out.push(`<defs><pattern id="mgo" width="1.6" height="1.6" patternUnits="userSpaceOnUse"><circle cx="0.8" cy="0.8" r="0.22" fill="#9a8f7a"/></pattern></defs>`);
  out.push(K.circle(cx, cy, R, { fill: '#d9dde2', stroke: '#1a1a1a', sw: 0.4 }));
  out.push(K.circle(cx, cy, Ri, { fill: '#f7f3ea', stroke: '#1a1a1a', sw: 0.3 }));
  out.push(K.circle(cx, cy, Ri - 0.1, { fill: 'url(#mgo)', stroke: 'none' }));
  const coilR = (card.mandrelMm / 2 + card.wireDiaMm / 2) * 4;
  out.push(K.circle(cx, cy, coilR, { stroke: '#9c5a1c', sw: card.wireDiaMm * 4 }));
  out.push(K.line(cx - R - 3, cy, cx + R + 3, cy, { w: 0.15, dash: '3 1 1 1', color: '#777' }), K.line(cx, cy - R - 3, cx, cy + R + 3, { w: 0.15, dash: '3 1 1 1', color: '#777' }));
  out.push(K.leader(cx + R * Math.cos(-0.7), cy + R * Math.sin(-0.7), 218, 145, `SHEATH — ${tube.material.toUpperCase()}, Ø${tube.diaMm}`, { size: 2.3 }));
  out.push(K.leader(cx + 9, cy - 5, 218, 154, 'MgO — COMPACTED (MGO-65A)', { size: 2.3 }));
  out.push(K.leader(cx + coilR * Math.cos(0.35), cy + coilR * Math.sin(0.35), 218, 167, [`COIL — ${card.gauge} SWG FeCrAl (${card.wireCode})`, `ON ${card.mandrelMm} MM MANDREL`], { size: 2.3 }));
  out.push(K.dimH(cx - R, cx + R, cy + R + 6, `Ø${tube.diaMm}`, { fromY1: cy, fromY2: cy, above: false, size: 2.4 }));

  // ── The callout the floor reads first — as on PHE's SolidWorks drawings ──
  out.push(K.rect(174, 196, 96, 40, { stroke: '#1a1a1a', sw: 0.5 }));
  out.push(K.text(177, 205, `TOTAL LENGTH = ${n2(geo.drawingTotalIn)} INCH`, { size: 4.4, weight: 700 }));
  out.push(K.text(267, 205, `(${n1(geo.clMm)} mm)`, { size: 2.4, anchor: 'end' }));
  out.push(K.text(177, 213, `DIAMETER = ${tube.diaMm} MM`, { size: 4.0, weight: 700 }));
  out.push(K.text(177, 221, `ROLLER = ${shape.rollerMm} MM`, { size: 4.0, weight: 700 }));
  out.push(K.text(177, 228, spec.terminalNote, { size: 2.8, weight: 700 }));
  out.push(K.text(177, 233.5, `Job card adds 0.7" (${n2(card.totalLengthIn)}") and cuts ${n2(card.cuttingLengthIn)}" (${n1(card.cuttingLengthMm)} mm) before draw.`, { size: 2.0, color: '#444' }));

  // ── Right column: element table, then parts and material by stage ──
  const T1 = K.table(276, 29, [37, 95], card.rows, { title: `ELEMENT — EACH (${item.qty} NOS)`, rowH: 5.6, size: 2.35 });
  out.push(T1.svg);
  const y2 = 29 + T1.height + 4;
  const T2 = K.table(276, y2, [6.5, 21, 67.5, 18.5, 18.5], parts.map(p => [String(p.no), p.stage, [p.line1, p.gu, p.hi], p.perPc, p.forOrder]),
    { title: `PARTS AND MATERIAL BY STAGE — FOR ${item.qty} NOS`, head: ['#', 'Used at', 'Part (inventory)', 'Per pc', `For ${item.qty}`], size: 2.2, rowH: 5, boldFirstLine: true, align: ['middle', 'start', 'start', 'end', 'end'] });
  out.push(T2.svg);

  // ── Notes ──
  out.push(K.rect(12, 240, 238, 45, { sw: 0.35 }));
  out.push(K.text(16, 245.5, 'NOTES', { size: 2.8, weight: 700, color: K.NAVY }));
  let ny = 250.5;
  notes.forEach((nt, i) => {
    const lines = Array.isArray(nt) ? nt : [nt];
    out.push(K.text(16, ny, `${i + 1}. ${lines[0]}`, { size: 2.1 }));
    lines.slice(1).forEach((l, k) => out.push(K.text(19.5, ny + (k + 1) * 2.9, l, { size: 2.1 })));
    ny += lines.length * 2.9 + 0.9;
  });

  // ── Title block: the fields PHE's SolidWorks block carries ──
  const tx = 254, ty = 240, tw = 154;
  out.push(K.rect(tx, ty, tw, 45, { sw: 0.5 }));
  out.push(K.rect(tx, ty, 116, 9, { sw: 0.3 }), K.rect(tx + 116, ty, 38, 9, { sw: 0.3 }));
  out.push(K.text(tx + 2, ty + 4.6, 'PEENA HEAT ELEMENTS LLP', { size: 3.2, weight: 700, color: K.NAVY }));
  out.push(K.text(tx + 2, ty + 7.9, 'Santej, Gandhinagar, Gujarat – 382721 · www.phe.co.in', { size: 1.8, color: '#444' }));
  out.push(K.text(tx + 135, ty + 2.6, 'STATUS', { size: 1.5, anchor: 'middle', color: '#666' }));
  out.push(K.text(tx + 135, ty + 5.6, String(tb.status).split(' — '), { size: 1.95, anchor: 'middle', weight: 700, color: C.red }));
  out.push(K.rect(tx, ty + 9, tw, 9, { sw: 0.3 }));
  out.push(K.text(tx + 2, ty + 15.2, spec.title, { size: 3.1, weight: 700 }));
  out.push(K.text(tx + tw - 2, ty + 15.2, spec.subtitle, { size: 2.0, anchor: 'end', color: '#444' }));
  const cell = (x, y, w, label, value) => [K.rect(x, y, w, 9, { sw: 0.25 }), K.text(x + 1.2, y + 2.7, label, { size: 1.7, color: '#666' }), K.text(x + 1.2, y + 7.3, value, { size: 2.3, weight: 700 })].join('');
  const rows = [
    [[30, 'MATERIAL', tb.material], [32, 'WATTAGE / VOLTAGE', tb.wattVolt], [22, 'QUANTITY', tb.qty], [22, 'CLIENT CODE', tb.client], [48, 'PRODUCT CODE', tb.product]],
    [[52, 'DWG NO', tb.dwgNo], [12, 'REV', tb.rev], [24, 'DATE', tb.date], [28, 'ORDER', tb.order], [38, 'SIZE · SCALE · PROJECTION', 'A3 · AS SHOWN · 3rd ANGLE']],
    [[30, 'DRAWN', tb.drawn], [28, "CHK'D", tb.checked], [38, "APPV'D", tb.approved], [58, 'TOLERANCES (LINEAR · ANGULAR)', '0.0 ±0.25 · 0 ±1.0 · ±1°']],
  ];
  rows.forEach((r, i) => { let cx2 = tx; r.forEach(([w, l, v]) => { out.push(cell(cx2, ty + 18 + i * 9, w, l, v)); cx2 += w; }); });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}mm" height="${H}mm" font-family="Arial, Helvetica, 'Noto Sans Gujarati', 'Noto Sans Devanagari', sans-serif">${out.join('')}</svg>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${K.esc(item.drawingNumber)} — drawing</title>
<style>@page { size: A3 landscape; margin: 0 } html, body { margin: 0; background: #fff } svg { display: block; width: 420mm; height: 297mm }</style></head><body>${svg}</body></html>`;
  return { svg, html };
}

module.exports = { deriveUShape, renderUTypeSheet };
