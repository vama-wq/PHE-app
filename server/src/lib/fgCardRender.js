// ── The Inventory Job Card for a Finished Goods order (owner, 13 Oct 2026) ───
// "Let's make inventory job cards on the application too — when I click upload
// job card you ask me from which inventory we are cutting the FG order, the
// dispatch date, the drawing no. from the item, the stamping as we do for the
// complete job card, the fixture type and qty." Laid out like the sheet the
// office fills in by hand: INVENTORY ORDERS, client code, dates, product code,
// drawing no., stamping, remark in English / Hindi / Gujarati, qty, and the
// four boxes the floor fills in (final ohms, megger, HV test report, checked &
// packaged by). Nothing on it is calculated.
const { toGujarati, toHindi, isTranslated } = require('./translit');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// dd.mm.yy, as every card prints dates. Pass a YYYY-MM-DD string.
function fmtDate(v) {
  if (!v) return '';
  const s = typeof v === 'string' ? v : new Date(v).toISOString();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1].slice(2)}` : String(v);
}

// An instruction in English with its Hindi and Gujarati lines underneath —
// a language the shop dictionary cannot translate is left out, never garbled.
function trilingual(en) {
  const t = String(en || '').trim();
  if (!t) return [];
  const hi = toHindi(t), gu = toGujarati(t);
  return [t, ...(isTranslated(t, hi) ? [hi] : []), ...(isTranslated(t, gu) ? [gu] : [])];
}

// c: { card_no, order_code, client_code, order_date, dispatch_date, product_code,
//      drawing_no, stamping, fixture, remark, qty, cut_from, took: [{ qty, job_card_no }] }
function renderFgCard(c) {
  const lines = (arr) => arr.map(l => `<div>${esc(l)}</div>`).join('') || '&nbsp;';
  const row = (label, value, opts = {}) => `
    <tr class="${opts.cls || ''}"><th>${esc(label)}</th><td colspan="${opts.span || 3}">${value}</td></tr>`;
  const took = (c.took || []).filter(t => Number(t.qty) > 0);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(c.card_no)} — Inventory Job Card</title>
<style>
  @page { size: A4 portrait; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, 'Noto Sans Devanagari', 'Noto Sans Gujarati', sans-serif; color: #111; margin: 0; padding: 16px; }
  .meta { display: flex; justify-content: space-between; font-size: 12px; color: #444; margin-bottom: 6px; }
  .meta b { color: #111; }
  table { width: 100%; border-collapse: collapse; border: 2px solid #111; table-layout: fixed; }
  th, td { border: 1px solid #999; padding: 10px 12px; text-align: left; vertical-align: top; font-size: 17px; }
  th { width: 30%; font-weight: 700; text-transform: uppercase; letter-spacing: .02em; font-size: 15px; }
  .title td { text-align: center; font-size: 22px; font-weight: 700; letter-spacing: .03em; border-bottom: 2px solid #111; }
  .dates td { width: 35%; }
  .big td { font-weight: 700; font-size: 19px; }
  .fill td { height: 54px; }
  .remark td div + div { margin-top: 4px; font-size: 16px; }
  .note { font-size: 11px; color: #444; margin-top: 8px; }
  @media print { body { padding: 0; } .noprint { display: none; } }
</style></head>
<body>
  <div class="meta"><span>Job card <b>${esc(c.card_no)}</b> · Order <b>${esc(c.order_code)}</b></span><span>Finished Goods · 4-stage checklist</span></div>
  <table>
    <tr class="title"><td colspan="4">INVENTORY ORDERS</td></tr>
    ${row('Client code', esc(c.client_code))}
    ${row('Order no', esc(c.order_code))}
    <tr class="dates"><th>Order date · Dispatch</th><td>${esc(fmtDate(c.order_date))}</td><td colspan="2">${esc(fmtDate(c.dispatch_date))}</td></tr>
    ${row('Product code', esc(c.product_code))}
    ${row('Drawing no', `${esc(c.drawing_no)}${c.cut_from && c.cut_from !== c.drawing_no ? `<div style="font-size:13px;color:#444;margin-top:4px">Cut from store stock of <b>${esc(c.cut_from)}</b></div>` : ''}`, { cls: 'big' })}
    ${row('Stamping', esc(c.stamping || '—'), { cls: 'big' })}
    ${row('Fixture', lines(trilingual(c.fixture)))}
    ${row('Remark', lines(trilingual(c.remark)), { cls: 'remark' })}
    ${row('Qty', `${esc(c.qty)} Nos${Number(c.elements) > 1 ? `<div style="font-size:13px;color:#444;margin-top:4px">${esc(c.store_qty)} single heaters assembled into ${esc(c.qty)} × ${esc(c.elements)}in1</div>` : ''}`, { cls: 'big' })}
    ${row('Final ohms', '&nbsp;', { cls: 'fill' })}
    ${row('Megger', '&nbsp;', { cls: 'fill' })}
    ${row('HV test report', '&nbsp;', { cls: 'fill' })}
    ${row('Checked & packaged by', '&nbsp;', { cls: 'fill' })}
  </table>
  ${took.length ? `<div class="note">Taken from the store, oldest first: ${took.map(t => `${esc(t.qty)} from ${t.job_card_no ? esc(t.job_card_no) : 'a hand entry'}`).join(', ')}.</div>` : ''}
</body></html>`;
}

// ── Printed with its material slip (owner, 2 Nov 2026) ──────────────────────
// "fg order should also have print slip when they are printed." The card goes
// to the slip print as the HTML saved when it was made — read back exactly as
// saved, never re-made from today's data — and prints with the slip as ONE job,
// the way a generated production card does (client lib/printJobCardSlip.js).
//
// Its rules are scoped to .fg-sheet first. Left as they are they reach the
// slip printed after it: `table { table-layout: fixed }` and `th { width: 30% }`
// would squeeze the slip's nine columns. Its @page is dropped — the slip's sets
// the paper for both.
function scopeCss(css, scope) {
  const src = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
  const sel = (s) => /^(html|body)$/i.test(s) ? scope
    : /^(html|body)\s/i.test(s) ? s.replace(/^(html|body)\s+/i, `${scope} `)
    : `${scope} ${s}`;
  const out = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    const head = src.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (j < src.length && depth > 0) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
    const inner = src.slice(open + 1, j - 1);
    if (/^@page\b/i.test(head)) { /* the slip's @page sets the paper */ }
    else if (/^@media\b/i.test(head)) out.push(`${head} {\n${scopeCss(inner, scope)}\n}`);
    else if (head.startsWith('@')) out.push(`${head} {${inner}}`);
    else if (head) out.push(`${head.split(',').map(s => s.trim()).filter(Boolean).map(sel).join(', ')} {${inner}}`);
    i = j;
  }
  return out.join('\n');
}

// html: the card's saved file. Returns the parts printJobCardSlip merges (the
// same shape as a generated card's), or null when the file is not a card sheet.
function fgCardForPrint(html) {
  const s = String(html || '');
  const css = (s.match(/<style[^>]*>([\s\S]*?)<\/style>/i) || [])[1];
  const body = (s.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [])[1];
  if (css == null || !body || !body.trim()) return null;
  return {
    title: (s.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || 'Inventory Job Card',
    fontLink: '',
    fitScript: '',
    styles: `<style>\n${scopeCss(css, '.fg-sheet')}\n</style>`,
    sheets: `<div class="fg-sheet">${body}</div>`,
  };
}

module.exports = { renderFgCard, fgCardForPrint, scopeCss, fmtDate, trilingual };
