// ── U type heater drawing: one A3 production sheet (sample, owner 14 Nov 2026) ─
// "start with U type, show me a sample sheet keeping in mind how orders come in
// and are typed". The sheet follows the two drawings the owner liked (the 6 kW
// duct heater for Arihant Tec and the 9 kW steam generator heater): a status
// banner, an elevation with every part named, the terminal end in fitting
// order, a section, the element table, the parts list by stage, notes and the
// title block. Nothing on it is worked out here — the spec handed in already
// holds the order as typed, the shape, the job card engine's figures and the
// parts; this file only lays them out to scale.
const K = require('./svgKit');

// U shape from the numbers design gives: U length (tube end to the outside of
// the bend), outside width across both legs, tube Ø. Returns the centreline
// geometry and the drawing length the job card engine starts from.
function deriveUShape({ uLengthMm, outsideWidthMm, tubeDiaMm }) {
  const cc = outsideWidthMm - tubeDiaMm;                 // leg centre to centre
  const rCL = cc / 2;                                     // bend radius on the centreline
  const straight = uLengthMm - (rCL + tubeDiaMm / 2);     // each leg, tube end to bend start
  const clMm = 2 * straight + Math.PI * rCL;              // whole tube along its centreline
  return { cc, rCL, straight, clMm, drawingTotalIn: Math.round((clMm / 25.4) * 100) / 100 };
}

const C = {
  heated: '#f2d7bf', cold: '#e2e6eb', sheath: '#1a1a1a', pin: '#a7adb4', esb: '#3f3f3f',
  ss: '#b9c0c7', brass: '#d8b75c', green: '#1f7a3a', red: '#b42318',
};
const n2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
const n1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

function renderUTypeSheet(spec) {
  const { order, item, tube, shape, geo, card, parts, notes, status, rev, date } = spec;
  const out = [];
  const W = 420, H = 297;

  // ── Frame and banner ──
  out.push(K.rect(8, 8, W - 16, H - 16, { sw: 0.6 }));
  out.push(K.rect(12, 12, W - 24, 7.5, { fill: C.green, stroke: 'none' }));
  out.push(K.text(W / 2, 17.1, spec.banner, { size: 3.0, anchor: 'middle', weight: 700, color: '#fff' }));

  // ── Elevation, scale 1:2 ──
  const s = 0.5;
  const X0 = 34, Yc = 72;
  const half = (geo.cc / 2) * s, r = (tube.diaMm / 2) * s;
  const yT = Yc - half, yB = Yc + half;
  const Xb = X0 + geo.straight * s;
  const xOuter = Xb + half + r;
  const czBig = card.coldZoneBigIn * 25.4 * s, czSmall = card.coldZoneSmallIn * 25.4 * s;
  const pinOut = 25.4 * s;
  out.push(K.viewTitle(150, 27, 'ELEVATION (SCALE 1:2)', 'Terminal end on the left · as bent'));
  const uPath = `M${K.f(X0)},${K.f(yT)} L${K.f(Xb)},${K.f(yT)} A${K.f(half)},${K.f(half)} 0 0 1 ${K.f(Xb)},${K.f(yB)} L${K.f(X0)},${K.f(yB)}`;
  out.push(K.path(uPath, { stroke: C.sheath, sw: tube.diaMm * s, cap: 'butt' }));
  out.push(K.path(uPath, { stroke: C.heated, sw: tube.diaMm * s - 0.55, cap: 'butt' }));
  out.push(K.line(X0, yT, X0 + czBig, yT, { w: tube.diaMm * s - 0.55, color: C.cold }));
  out.push(K.line(X0, yB, X0 + czSmall, yB, { w: tube.diaMm * s - 0.55, color: C.cold }));
  for (const [x, y] of [[X0 + czBig, yT], [X0 + czSmall, yB]]) out.push(K.line(x, y - r - 0.8, x, y + r + 0.8, { w: 0.3 }));
  out.push(K.line(Xb + half + r + 2, Yc, X0 - 16, Yc, { w: 0.15, dash: '4 1 1 1', color: '#777' }));
  // Pins, sealing bush and the nut stack, each leg.
  for (const y of [yT, yB]) {
    out.push(K.rect(X0 - pinOut, y - 1, pinOut, 2, { fill: C.pin, stroke: '#555', sw: 0.15 }));
    out.push(K.rect(X0 - 1.2, y - 2.5, 1.2, 5, { fill: C.esb, stroke: 'none' }));
    out.push(K.rect(X0, y - 1.4, 2.2, 2.8, { fill: 'none', stroke: '#555', sw: 0.12, dash: '0.5 0.35' }));
    let x = X0 - 1.2;
    for (const p of [{ w: 1.6, h: 3.5, fill: C.ss }, { w: 0.4, h: 4.5, fill: C.brass }, { w: 0.75, h: 3, fill: 'none', dash: '0.6 0.4' }, { w: 0.4, h: 4.5, fill: C.brass }, { w: 1.6, h: 3.5, fill: C.brass }]) {
      x -= p.w;
      out.push(K.rect(x, y - p.h / 2, p.w, p.h, { fill: p.fill, stroke: '#333', sw: 0.12, dash: p.dash || null }));
    }
  }
  // Dimensions.
  out.push(K.dimH(X0, xOuter, 44, `${n1(shape.uLengthMm)} (${n2(shape.uLengthMm / 25.4).replace(/\.00$/, '')}") U LENGTH = "${shape.uLabel}" — END OF THE TUBE TO THE FAR END OF THE U`, { fromY1: yT - r, fromY2: Yc }));
  out.push(K.dimH(X0, X0 + czBig, 54, `${n1(card.coldZoneBigIn * 25.4)} (${card.coldZoneBigIn}") COLD ZONE`, { fromY1: yT - r, fromY2: yT - r }));
  out.push(K.dimH(X0 - pinOut, X0, 92, `${n1(25.4)} (1") PIN OUT`, { fromY1: yB + 1, fromY2: yB + r, above: false }));
  out.push(K.dimV(yT - r, yB + r, xOuter + 4.5, `${shape.outsideWidthMm} OUTSIDE`, { fromX1: Xb, fromX2: Xb }));
  const xg = Xb - 22;
  out.push(K.dimV(yT + r, yB - r, xg, `${shape.outsideWidthMm - 2 * tube.diaMm}`, { size: 2.2 }));
  out.push(K.text(xg + 1.6, Yc - 1.6, `INSIDE · LEGS ${geo.cc} C/C`, { size: 1.9, color: K.DIM }));
  // Section mark T–T in the heated zone of the top leg.
  const xt = X0 + 150 * s * 2 * 0.62;
  for (const y of [yT - r - 3.2, yT + r + 3.2]) {
    out.push(K.line(xt, y - 1.6, xt, y + 1.6, { w: 0.35 }));
    out.push(K.line(xt, y, xt - 3, y, { w: 0.25 }), K.arrowhead(xt - 3, y, Math.PI, { len: 1.4, half: 0.5, color: '#111' }));
    out.push(K.text(xt + 1.2, y + (y < yT ? -0.6 : 2.4), 'T', { size: 2.4, weight: 700 }));
  }
  // Callouts.
  out.push(K.leader(xt + 22, yT - r, xt + 30, 57.5, [`Ø${tube.diaMm} SHEATH — ${tube.label} (${tube.code}) · ${item.finish.toUpperCase()}`], { size: 2.1 }));
  out.push(K.leader(X0 + czSmall * 0.55, yB + r, X0 + czSmall + 4, 101, [`COLD ZONE ${card.coldZoneBigIn}" (${n1(card.coldZoneBigIn * 25.4)}) EACH LEG — NO COIL`, `PIN ${card.pinStudsIn}" : ${card.pinStudsIn - 1}" INSIDE THE TUBE + 1" OUT`], { size: 2.1 }));
  out.push(K.leader(X0 + 120, yB + r, X0 + 126, 110, [`HEATED ZONE ≈ ${n1(card.heatedMm)} (${n2(card.heatedMm / 25.4)}") ALONG THE TUBE`, 'COIL INSIDE — SEE SECTION T–T'], { size: 2.1 }));
  const ra = Math.PI / 6;
  out.push(K.leader(Xb + half * Math.cos(ra), Yc + half * Math.sin(ra), Xb - 12, 101, `R${n1(geo.rCL)} CL · ROLLER ${shape.rollerMm}`, { size: 2.1 }));
  out.push(K.circle(X0 - 6, Yc, 15.5, { stroke: '#2f5597', sw: 0.3, dash: '1.6 0.9' }));
  out.push(K.text(X0 + 7.5, Yc - 12, 'D', { size: 3.2, weight: 700, color: '#2f5597' }));
  out.push(K.leader(X0 - 6 + 15.5 * Math.cos(0.95), Yc + 15.5 * Math.sin(0.95), X0 + 18, 118, 'TERMINAL END AND FITTING ORDER — SEE DETAIL D', { size: 2.1, color: '#2f5597' }));

  // ── Detail D: terminal end, one leg, scale 2:1 ──
  out.push(K.viewTitle(92, 129, 'DETAIL D — TERMINAL END, ONE LEG (SCALE 2:1)'));
  const s2 = 2, ya = 152, tubeR = (tube.diaMm / 2) * s2, pinR = 2 * s2 / 2 * 1, xm = 118;
  const pinL = 25.4 * s2;
  const drawLeg = (y, { stack = true } = {}) => {
    const o = [];
    o.push(K.rect(xm, y - tubeR, 48, tubeR * 2, { fill: C.cold, stroke: '#1a1a1a', sw: 0.35 }));
    o.push(K.breakMark(166, y - tubeR, y + tubeR));
    o.push(K.line(xm, y - pinR, 166, y - pinR, { w: 0.2, dash: '1 0.7', color: '#555' }), K.line(xm, y + pinR, 166, y + pinR, { w: 0.2, dash: '1 0.7', color: '#555' }));
    o.push(K.rect(xm - pinL, y - pinR, pinL, pinR * 2, { fill: C.pin, stroke: '#444', sw: 0.2 }));
    for (let x = xm - pinL + 1; x < xm - 0.5; x += 1.4) o.push(K.line(x, y - pinR, x + 0.7, y + pinR, { w: 0.12, color: '#666' }));
    o.push(K.rect(xm - 4, y - tubeR - 1, 4, tubeR * 2 + 2, { fill: C.esb, stroke: 'none' }));
    o.push(K.rect(xm, y - tubeR + 1.2, 6, tubeR * 2 - 2.4, { fill: 'none', stroke: '#555', sw: 0.2, dash: '1 0.6' }));
    if (stack) {
      let x = xm - 4;
      for (const p of STACK) { x -= p.w; o.push(K.rect(x, y - p.h / 2, p.w, p.h, { fill: p.fill, stroke: '#333', sw: 0.2, dash: p.dash || null })); p._x = x + p.w / 2; }
    }
    return o.join('');
  };
  const STACK = [
    { key: 'ssnut', w: 6.4, h: 14, fill: C.ss }, { key: 'washer', w: 1.6, h: 18, fill: C.brass },
    { key: 'lug', w: 6, h: 11, fill: 'none', dash: '0.9 0.6' }, { key: 'washer', w: 1.6, h: 18, fill: C.brass },
    { key: 'nut', w: 6.4, h: 14, fill: C.brass },
  ];
  out.push(K.text(20, 141, 'ASSEMBLED', { size: 2.2, weight: 700, color: '#555' }));
  out.push(drawLeg(ya));
  const no = (key) => parts.find(p => p.key === key)?.no;
  const bal = [[xm - 2, 'esb'], ...STACK.map(p => [p._x, p.key])];
  const ballooned = [...bal].filter(([, k]) => k !== 'lug').sort((a, b) => b[0] - a[0]);
  ballooned.forEach(([x, key], i) => out.push(K.balloonLeader(x, ya - 9, 121 - i * 8.2, 136.5, no(key))));
  const lug = STACK.find(p => p.key === 'lug');
  out.push(K.leader(lug._x, ya + 5.5, lug._x - 6, 181, 'WIRE LUG — CUSTOMER', { size: 2.0 }));
  out.push(K.leader(xm - pinL + 9, ya + pinR, xm - pinL - 6, 166, ['TERMINAL PIN M4 SS ' + card.pinStudsIn + '" — W/H ON ONE LEG,', 'W/O ON THE OTHER (2, 3)'], { size: 2.0 }));
  out.push(K.leader(142, ya + pinR, 138, 172, [`PIN ${card.pinStudsIn - 1}" (${n1((card.pinStudsIn - 1) * 25.4)}) INSIDE — SPOT WELDED`, 'TO THE COIL AT St 4 SPOT'], { size: 2.0 }));
  out.push(K.dimH(xm - pinL, xm, 161, '25.4 (1") OUT', { fromY1: ya + pinR, fromY2: ya + tubeR, above: false, size: 2.1 }));
  // Exploded, in fitting order.
  const ye = 208;
  out.push(K.text(20, 186, 'FITTING ORDER, ONE TERMINAL — TO CONFIRM', { size: 2.2, weight: 700, color: '#555' }));
  out.push(drawLeg(ye, { stack: false }));
  out.push(K.line(14, ye, xm - pinL, ye, { w: 0.15, dash: '4 1 1 1', color: '#777' }));
  const EXP = [
    { key: 'ssnut', x: 61.5, ...STACK[0] }, { key: 'washer', x: 50.5, ...STACK[1] }, { key: 'lug', x: 40, ...STACK[2] },
    { key: 'washer', x: 29.5, ...STACK[3] }, { key: 'nut', x: 18, ...STACK[4] },
  ];
  for (const p of EXP) out.push(K.rect(p.x - p.w / 2, ye - p.h / 2, p.w, p.h, { fill: p.fill, stroke: '#333', sw: 0.2, dash: p.dash || null }));
  out.push(K.line(70, ye - 9, 92, ye - 9, { w: 0.25, color: '#2f5597' }), K.arrowhead(92, ye - 9, 0, { color: '#2f5597' }));
  out.push(K.text(81, ye - 10.5, 'slide on in this order', { size: 1.9, anchor: 'middle', color: '#2f5597' }));
  const steps = [
    { x: xm - 2, txt: ['1 · ESB', 'St 23 Sealing'], key: 'esb' }, { x: 61.5, txt: ['2 · SS nut', 'St 26'], key: 'ssnut' },
    { x: 50.5, txt: ['3 · washer', 'St 26'], key: 'washer' }, { x: 40, txt: ['4 · lug', 'customer'], key: null },
    { x: 29.5, txt: ['5 · washer', 'St 26'], key: 'washer' }, { x: 18, txt: ['6 · nut', 'St 26'], key: 'nut' },
  ];
  for (const st of steps) {
    out.push(K.text(st.x, ye + 14.5, st.txt, { size: 1.9, anchor: 'middle', color: '#333' }));
    if (st.key) out.push(K.balloon(st.x, ye - 15.5 + (st.key === 'esb' ? 0 : 0), no(st.key), { r: 2.2 }));
  }

  // ── Section T–T, scale 4:1 ──
  out.push(K.viewTitle(219, 129, 'SECTION T–T (SCALE 4:1)'));
  const cx = 194, cy = 158, R = (tube.diaMm / 2) * 4, Ri = R - tube.wallMm * 4;
  out.push(`<defs><pattern id="mgo" width="1.6" height="1.6" patternUnits="userSpaceOnUse"><circle cx="0.8" cy="0.8" r="0.22" fill="#9a8f7a"/></pattern></defs>`);
  out.push(K.circle(cx, cy, R, { fill: '#d9dde2', stroke: '#1a1a1a', sw: 0.4 }));
  out.push(K.circle(cx, cy, Ri, { fill: '#f7f3ea', stroke: '#1a1a1a', sw: 0.3 }));
  out.push(K.circle(cx, cy, Ri - 0.1, { fill: 'url(#mgo)', stroke: 'none' }));
  const coilR = (card.mandrelMm / 2 + card.wireDiaMm / 2) * 4;
  out.push(K.circle(cx, cy, coilR, { stroke: '#9c5a1c', sw: card.wireDiaMm * 4 }));
  out.push(K.line(cx - R - 3, cy, cx + R + 3, cy, { w: 0.15, dash: '3 1 1 1', color: '#777' }), K.line(cx, cy - R - 3, cx, cy + R + 3, { w: 0.15, dash: '3 1 1 1', color: '#777' }));
  out.push(K.leader(cx + R * Math.cos(-0.7), cy + R * Math.sin(-0.7), 216, 143, [`SHEATH — ${tube.label}`], { size: 2.0 }));
  out.push(K.leader(cx + 9, cy - 5, 216, 152, 'MgO — COMPACTED (MGO-65A)', { size: 2.0 }));
  out.push(K.leader(cx + coilR * Math.cos(0.35), cy + coilR * Math.sin(0.35), 216, 164, [`COIL — ${card.gauge} SWG FeCrAl (KANTHAL D)`, `ON ${card.mandrelMm} MM MANDREL (${card.wireCode})`], { size: 2.0 }));
  out.push(K.dimH(cx - R, cx + R, cy + R + 6, `Ø${tube.diaMm}`, { fromY1: cy, fromY2: cy, above: false, size: 2.2 }));

  // ── Cutting and bending: the numbers the floor reads first ──
  out.push(K.rect(172, 195, 98, 39, { stroke: '#1a1a1a', sw: 0.5 }));
  out.push(K.text(175, 203.5, `TOTAL LENGTH = ${n2(card.totalLengthIn)} INCH`, { size: 4.0, weight: 700 }));
  out.push(K.text(267, 203.5, `(${n1(card.totalLengthMm)} mm)`, { size: 2.3, anchor: 'end' }));
  out.push(K.text(175, 211.5, `CUTTING LENGTH = ${n2(card.cuttingLengthIn)} INCH`, { size: 4.0, weight: 700 }));
  out.push(K.text(267, 211.5, `(${n1(card.cuttingLengthMm)} mm)`, { size: 2.3, anchor: 'end' }));
  out.push(K.text(175, 219.5, `DIAMETER = ${tube.diaMm} MM   ·   ROLLER = ${shape.rollerMm} MM`, { size: 3.4, weight: 700 }));
  out.push(K.text(175, 225.5, [`Drawing length ${n2(geo.drawingTotalIn)}" = 2 × ${n1(geo.straight)} + π × ${n1(geo.rCL)} = ${n1(geo.clMm)} mm; the total adds 0.7".`, `Cut before draw: ${tube.material} draws ${Math.round(card.tubeDrawPct * 1000) / 10}%. Figures from the PHE job card engine.`], { size: 1.85, color: '#444' }));

  // ── Right column: element table, then the parts by stage ──
  const T1 = K.table(276, 24, [38, 94], card.rows, { title: `ELEMENT — EACH (${item.qty} NOS)`, rowH: 4.9, size: 2.05, boldFirstCol: false });
  out.push(T1.svg);
  const y2 = 24 + T1.height + 4;
  const T2 = K.table(276, y2, [6.5, 18, 70.5, 18.5, 18.5], parts.map(p => [String(p.no), p.stage, [p.line1, p.gu, p.hi], p.perPc, p.forOrder]),
    { title: `PARTS BY STAGE — PER HEATER AND FOR ${item.qty} NOS`, head: ['#', 'Stage', 'Part (inventory)', 'Per pc', `For ${item.qty}`], size: 1.95, rowH: 5, boldFirstLine: true, align: ['middle', 'start', 'start', 'end', 'end'] });
  out.push(T2.svg);

  // ── Notes ──
  out.push(K.rect(12, 238, 238, 47, { sw: 0.35 }));
  out.push(K.text(16, 243.5, 'NOTES', { size: 2.8, weight: 700, color: K.NAVY }));
  let ny = 248.5;
  notes.forEach((nt, i) => {
    const lines = Array.isArray(nt) ? nt : [nt];
    out.push(K.text(16, ny, `${i + 1}. ${lines[0]}`, { size: 1.95 }));
    lines.slice(1).forEach((l, k) => out.push(K.text(19.5, ny + (k + 1) * 2.9, l, { size: 1.95 })));
    ny += lines.length * 2.9 + 1.1;
  });

  // ── Title block ──
  const tx = 254, ty = 238, tw = 154;
  out.push(K.rect(tx, ty, tw, 47, { sw: 0.5 }));
  out.push(K.line(tx + 116, ty, tx + 116, ty + 13, { w: 0.3 }), K.line(tx, ty + 13, tx + tw, ty + 13, { w: 0.3 }));
  out.push(K.text(tx + 2.5, ty + 6, 'PEENA HEAT ELEMENTS LLP', { size: 3.6, weight: 700, color: K.NAVY }));
  out.push(K.text(tx + 2.5, ty + 10.2, 'Santej, Gandhinagar, Gujarat – 382721 · www.phe.co.in', { size: 1.9, color: '#444' }));
  out.push(K.text(tx + 135, ty + 4.2, 'STATUS', { size: 1.5, anchor: 'middle', color: '#666' }));
  out.push(K.text(tx + 135, ty + 8.2, status, { size: 2.1, anchor: 'middle', weight: 700, color: C.red }));
  out.push(K.line(tx, ty + 25, tx + tw, ty + 25, { w: 0.3 }));
  out.push(K.text(tx + 2.5, ty + 18.6, spec.title, { size: 3.1, weight: 700 }));
  out.push(K.text(tx + 2.5, ty + 22.6, spec.subtitle, { size: 1.95, color: '#444' }));
  const cell = (x, y, w, h, label, value) => [K.rect(x, y, w, h, { sw: 0.25 }), K.text(x + 1.2, y + 2.6, label, { size: 1.5, color: '#666' }), K.text(x + 1.2, y + h - 2.2, value, { size: 2.15, weight: 700 })].join('');
  const r1 = [[52, 'DRG. NO.', item.drawingNumber], [16, 'REV.', rev], [28, 'DATE', date], [26, 'SCALE', 'AS SHOWN'], [32, 'SIZE / SHEET', 'A3 · 1 of 1']];
  const r2 = [[52, 'CUSTOMER / ORDER', `${order.customerCode} · ${order.code}`], [30, 'PROJECTION', '3rd ANGLE'], [24, 'DRAWN', 'PHE app'], [24, 'CHECKED', '—'], [24, 'APPROVED', '—']];
  let cx2 = tx;
  r1.forEach(([w, l, v]) => { out.push(cell(cx2, ty + 25, w, 11, l, v)); cx2 += w; });
  cx2 = tx;
  r2.forEach(([w, l, v]) => { out.push(cell(cx2, ty + 36, w, 11, l, v)); cx2 += w; });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}mm" height="${H}mm" font-family="Arial, Helvetica, 'Noto Sans Gujarati', 'Noto Sans Devanagari', sans-serif">${out.join('')}</svg>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${K.esc(item.drawingNumber)} — drawing</title>
<style>@page { size: A3 landscape; margin: 0 } html, body { margin: 0; background: #fff } svg { display: block; width: 420mm; height: 297mm }</style></head><body>${svg}</body></html>`;
  return { svg, html };
}

module.exports = { deriveUShape, renderUTypeSheet };
