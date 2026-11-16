// ── Drawing kit: the small SVG pieces every heater drawing is made of ────────
// Units are millimetres on the sheet (an A3 sheet is 420 × 297), so a view at
// 1:2 multiplies real millimetres by 0.5 before calling these. Nothing here
// knows about heaters; lib/drawings/<family>Sheet.js composes them.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f = (n) => Math.round(Number(n) * 100) / 100;

const INK = '#1a1a1a';
const NAVY = '#1f3864';
const DIM = '#333';

function line(x1, y1, x2, y2, { w = 0.25, color = INK, dash = null, cap = 'butt' } = {}) {
  return `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${color}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-linecap="${cap}"/>`;
}
function rect(x, y, w, h, { fill = 'none', stroke = INK, sw = 0.25, rx = 0, dash = null } = {}) {
  return `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${rx ? ` rx="${rx}"` : ''}${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}
function circle(cx, cy, r, { fill = 'none', stroke = INK, sw = 0.25, dash = null } = {}) {
  return `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}
function ellipse(cx, cy, rx, ry, { fill = 'none', stroke = INK, sw = 0.25, dash = null } = {}) {
  return `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}
function path(d, { fill = 'none', stroke = INK, sw = 0.25, dash = null, join = 'round', cap = 'butt' } = {}) {
  return `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="${join}" stroke-linecap="${cap}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}
// Width of one line of Arial / Helvetica at `size` (mm), from the font's own
// character widths in groups — close enough to keep a label inside its box.
// Anything else (Gujarati, Devanagari) counts as a wide letter, so it errs large.
function textWidth(str, size, weight = 400) {
  let em = 0;
  for (const ch of String(str ?? '')) {
    em += /[ijl'|]/.test(ch) ? 0.22 : /[ .,:;!ftI/\\]/.test(ch) ? 0.28 : /[r()[\]\-·"]/.test(ch) ? 0.34
      : /[mMW—]/.test(ch) ? 0.92 : /[a-z0-9–×≈±]/.test(ch) ? 0.56 : /[A-Z#&%@Ø°Ω]/.test(ch) ? 0.72 : 0.62;
  }
  return em * size * (weight >= 700 ? 1.08 : 1);
}
// The font size at which `str` fits `width` (never below `min`); `size` when it already fits.
function fitSize(str, width, size, weight = 400, min = size * 0.6) {
  const w = textWidth(str, size, weight);
  return w > width ? Math.max(min, Math.floor((size * width / w) * 100) / 100) : size;
}

// One line of text, or several when `str` is an array (line height = size × 1.25).
function text(x, y, str, { size = 2.3, anchor = 'start', weight = 400, color = INK, rotate = 0, family = null, italic = false } = {}) {
  const lines = Array.isArray(str) ? str : [str];
  const rot = rotate ? ` transform="rotate(${rotate} ${f(x)} ${f(y)})"` : '';
  const fam = family ? ` font-family="${family}"` : '';
  return lines.map((s, i) => `<text x="${f(x)}" y="${f(y + i * size * 1.25)}" font-size="${size}" text-anchor="${anchor}" font-weight="${weight}" fill="${color}"${italic ? ' font-style="italic"' : ''}${fam}${rot}>${esc(s)}</text>`).join('');
}
// A filled arrowhead with its tip at (x, y), pointing along `angle` (radians).
function arrowhead(x, y, angle, { len = 2.2, half = 0.65, color = DIM } = {}) {
  const bx = x - Math.cos(angle) * len, by = y - Math.sin(angle) * len;
  const px = -Math.sin(angle) * half, py = Math.cos(angle) * half;
  return `<path d="M${f(x)},${f(y)} L${f(bx + px)},${f(by + py)} L${f(bx - px)},${f(by - py)} Z" fill="${color}"/>`;
}
// Horizontal dimension: extension lines from the feature points (x1, fromY1)
// and (x2, fromY2) to the dimension line at y, arrows at both ends, value above.
// Too short for arrows inside → arrows outside pointing in.
function dimH(x1, x2, y, label, { fromY1 = null, fromY2 = null, size = 2.4, above = true, color = DIM } = {}) {
  const out = [];
  const gap = 0.8;
  for (const [x, fy] of [[x1, fromY1], [x2, fromY2]]) {
    if (fy != null) out.push(line(x, fy + (fy < y ? gap : -gap), x, y + (fy < y ? 1.2 : -1.2), { w: 0.18, color }));
  }
  const inside = Math.abs(x2 - x1) > 7;
  out.push(line(x1, y, x2, y, { w: 0.18, color }));
  if (inside) {
    out.push(arrowhead(x1, y, Math.PI, { color }), arrowhead(x2, y, 0, { color }));
  } else {
    out.push(line(x1 - 4, y, x1, y, { w: 0.18, color }), line(x2, y, x2 + 4, y, { w: 0.18, color }));
    out.push(arrowhead(x1, y, 0, { color }), arrowhead(x2, y, Math.PI, { color }));
  }
  out.push(text((x1 + x2) / 2, above ? y - 0.9 : y + size + 0.4, label, { size, anchor: 'middle', color }));
  return out.join('');
}
// Vertical dimension at x between y1 and y2; value reads bottom-to-top.
function dimV(y1, y2, x, label, { fromX1 = null, fromX2 = null, size = 2.4, color = DIM, left = true } = {}) {
  const out = [];
  const gap = 0.8;
  for (const [y, fx] of [[y1, fromX1], [y2, fromX2]]) {
    if (fx != null) out.push(line(fx + (fx < x ? gap : -gap), y, x + (fx < x ? 1.2 : -1.2), y, { w: 0.18, color }));
  }
  const inside = Math.abs(y2 - y1) > 7;
  out.push(line(x, y1, x, y2, { w: 0.18, color }));
  if (inside) {
    out.push(arrowhead(x, y1, -Math.PI / 2, { color }), arrowhead(x, y2, Math.PI / 2, { color }));
  } else {
    out.push(line(x, y1 - 4, x, y1, { w: 0.18, color }), line(x, y2, x, y2 + 4, { w: 0.18, color }));
    out.push(arrowhead(x, y1, Math.PI / 2, { color }), arrowhead(x, y2, -Math.PI / 2, { color }));
  }
  const tx = left ? x - 0.9 : x + size + 0.2;
  out.push(text(tx, (y1 + y2) / 2, label, { size, anchor: 'middle', color, rotate: -90 }));
  return out.join('');
}
// A small dimension straight across a narrow feature (a tube seen side on, its
// edges at y1 above and y2 below): arrows outside pointing in, short tails, the
// value beyond the top tail — or beyond the bottom one when `below`. The tube Ø
// at the U bend (owner, 14 Nov 2026: "show the tube dia on the drawing").
function dimAcross(x, y1, y2, label, { size = 2.2, tail = 1.8, color = DIM, below = false } = {}) {
  return [line(x, y1 - tail, x, y1, { w: 0.18, color }), line(x, y2, x, y2 + tail, { w: 0.18, color }),
    arrowhead(x, y1, Math.PI / 2, { len: 1.4, half: 0.5, color }), arrowhead(x, y2, -Math.PI / 2, { len: 1.4, half: 0.5, color }),
    text(x, below ? y2 + tail + 0.6 + 0.72 * size : y1 - tail - 0.6, label, { size, anchor: 'middle', color })].join('');
}
// Leader: a dot on the feature, a line to the label, a short shoulder, the label.
// The label sits on the side the leader runs to, unless `side` says 'left' / 'right'.
function leader(fx, fy, lx, ly, label, { size = 2.3, color = INK, dot = true, weight = 400, side = null } = {}) {
  const right = side ? side === 'right' : lx >= fx;
  const sx = lx + (right ? 2.5 : -2.5);
  const lines = Array.isArray(label) ? label : [label];
  return [
    dot ? circle(fx, fy, 0.45, { fill: color, stroke: 'none' }) : '',
    line(fx, fy, lx, ly, { w: 0.18, color }),
    line(lx, ly, sx, ly, { w: 0.18, color }),
    text(sx + (right ? 0.8 : -0.8), ly + size * 0.35, lines, { size, anchor: right ? 'start' : 'end', color, weight }),
  ].join('');
}
// A numbered balloon (the part's line in the parts table).
function balloon(cx, cy, n, { r = 2.4, color = NAVY } = {}) {
  return circle(cx, cy, r, { fill: '#fff', stroke: color, sw: 0.3 }) + text(cx, cy + 0.85, String(n), { size: 2.4, anchor: 'middle', weight: 700, color });
}
function balloonLeader(fx, fy, cx, cy, n, opts = {}) {
  const r = opts.r || 2.4;
  const a = Math.atan2(fy - cy, fx - cx);
  return circle(fx, fy, 0.45, { fill: NAVY, stroke: 'none' }) + line(cx + Math.cos(a) * r, cy + Math.sin(a) * r, fx, fy, { w: 0.18, color: NAVY }) + balloon(cx, cy, n, opts);
}
// Short break lines (two little zigzags) across a tube end at x.
function breakMark(x, yTop, yBot) {
  const m = (yTop + yBot) / 2;
  return path(`M${f(x)},${f(yTop - 1)} L${f(x - 1)},${f(m - 1)} L${f(x + 1)},${f(m + 1)} L${f(x)},${f(yBot + 1)}`, { sw: 0.25 });
}
function viewTitle(x, y, title, sub = null) {
  return text(x, y, title, { size: 3.3, weight: 700, color: NAVY, anchor: 'middle' }) + (sub ? text(x, y + 3.6, sub, { size: 2.1, anchor: 'middle', color: '#444' }) : '');
}
// A ruled table. cols: widths; rows: arrays of cells; a cell is a string or an
// array of lines (first line bold when opts.boldFirstLine). opts.head: header row.
// A line too long for its column is set smaller rather than run into the next
// one (a long inventory name, 14 Nov 2026).
function table(x, y, cols, rows, { head = null, rowH = 5, headH = 5.5, size = 2.2, title = null, titleH = 5.5, boldFirstCol = false, boldFirstLine = false, align = [] } = {}) {
  const W = cols.reduce((a, b) => a + b, 0);
  const out = [];
  let cy = y;
  if (title) {
    out.push(rect(x, cy, W, titleH, { fill: '#dfe6f3', stroke: '#555', sw: 0.3 }));
    out.push(text(x + 1.5, cy + titleH / 2 + size * 0.38, title, { size: size + 0.2, weight: 700, color: NAVY }));
    cy += titleH;
  }
  if (head) {
    out.push(rect(x, cy, W, headH, { fill: '#f1f3f6', stroke: '#555', sw: 0.25 }));
    let cx = x;
    head.forEach((h, i) => {
      const a = align[i] || 'start';
      const tx = a === 'middle' ? cx + cols[i] / 2 : a === 'end' ? cx + cols[i] - 1.2 : cx + 1.2;
      out.push(text(tx, cy + headH / 2 + size * 0.38, h, { size: size - 0.1, weight: 700, anchor: a }));
      cx += cols[i];
    });
    cy += headH;
  }
  for (const row of rows) {
    const lines = row.map(c => (Array.isArray(c) ? c : [c]).filter(v => v !== null && v !== undefined && v !== ''));
    const n = Math.max(1, ...lines.map(l => l.length));
    const h = Math.max(rowH, n * size * 1.22 + 1.8);
    out.push(rect(x, cy, W, h, { stroke: '#888', sw: 0.18 }));
    let cx = x;
    lines.forEach((cell, i) => {
      if (i > 0) out.push(line(cx, cy, cx, cy + h, { w: 0.18, color: '#888' }));
      const a = align[i] || 'start';
      const tx = a === 'middle' ? cx + cols[i] / 2 : a === 'end' ? cx + cols[i] - 1.2 : cx + 1.2;
      const top = cy + (h - cell.length * size * 1.22) / 2 + size * 0.95;
      cell.forEach((s, k) => {
        const bold = (boldFirstCol && i === 0) || (boldFirstLine && k === 0 && cell.length > 1);
        const sz = fitSize(s, cols[i] - 2.4, k > 0 && boldFirstLine ? size - 0.15 : size, bold ? 700 : 400);
        out.push(text(tx, top + k * size * 1.22, s, { size: sz, anchor: a, weight: bold ? 700 : 400, color: k > 0 && boldFirstLine ? '#444' : INK }));
      });
      cx += cols[i];
    });
    cy += h;
  }
  return { svg: out.join(''), height: cy - y, width: W };
}

module.exports = { esc, f, INK, NAVY, DIM, textWidth, fitSize, line, rect, circle, ellipse, path, text, arrowhead, dimH, dimV, dimAcross, leader, balloon, balloonLeader, breakMark, viewTitle, table };
