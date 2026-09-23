// ── Printing a job card and its material slip ──────────────────────────────
//
// Shared by the order page, the job card page and the production screen, so
// wherever someone prints a card they get the same document — and the same
// record of having printed it.
import api from './api';
import { transliterateGujarati, transliterateHindi } from './utils';

// Apportion a BOM line across the item's cards so the slips still add up to
// exactly what the BOM says. Whole-number lines (flanges, nuts, pins) use
// largest-remainder so nobody is asked to issue half a flange and the total is
// never off by one; measured lines (Kgs, metres) just divide.
function apportion(total, quantities) {
  const sum = quantities.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return quantities.map(() => 0);
  const exact = quantities.map(q => (Number(total) * q) / sum);
  if (!Number.isInteger(Number(total))) {
    // Rounding each share independently drifts the total (0.375 over three
    // cards came to 0.376), so the largest share absorbs the difference.
    const r = exact.map(v => Math.round(v * 1000) / 1000);
    const drift = Math.round((Number(total) - r.reduce((a, b) => a + b, 0)) * 1000) / 1000;
    if (drift) r[r.indexOf(Math.max(...r))] = Math.round((r[r.indexOf(Math.max(...r))] + drift) * 1000) / 1000;
    return r;
  }
  const floors = exact.map(Math.floor);
  let left = Math.round(Number(total)) - floors.reduce((a, b) => a + b, 0);
  return exact
    .map((v, i) => ({ i, frac: v - floors[i] }))
    .sort((a, b) => b.frac - a.frac)
    .reduce((acc, { i }) => { if (left > 0) { acc[i] += 1; left -= 1; } return acc; }, [...floors]);
}

// Print ONE job card's material slip, and the card itself alongside it.
//
// The slip is the store's issue document and it travels with a card, so it
// carries that card's share of the BOM — a slip showing the whole item against
// a card that builds half of it makes the store issue double.
//
// It comes from the server rather than being built here, because the print has
// to be recorded: a browser cannot be stopped from printing a page twice, so
// the first print comes out clean and every one after it is stamped REPRINT
// with the date and who printed it. The store can then tell an original from a
// copy, which is the whole point of the log.
export async function printJobCardSlip(jc) {
  let d;
  try {
    d = (await api.post(`/job-cards/${jc.id}/slip`)).data;
  } catch (e) {
    alert(e.response?.data?.error || 'Could not prepare the material slip');
    return;
  }

  const today = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const shares = d.lines.map(r => apportion(r.qty, d.quantities));
  const dwg = d.item.drawing_number || '';
  const partOfItem = d.cardCount > 1;

  // A generated card comes back with its own sheet and styles, so the card and
  // the slip print as ONE job — the floor presses print once and gets both.
  // An uploaded PDF cannot have a page added to it, so that one still opens in
  // its own tab alongside (see the end of this function).
  const merged = !!d.card;
  const w = window.open('', '_blank');
  w.document.write(`<!doctype html><html><head><title>${merged ? d.card.title : `Material Slip — ${d.jobCard.job_card_no}`}</title>
    ${merged ? d.card.fontLink : ''}
    ${merged ? d.card.styles : ''}
    <style>
      /* EVERY rule here is scoped to .slip-page. Unscoped, the slip's own
         body/table/th/td rules landed on the job card sheet printed above it —
         a 26px body margin and a full border on every cell — which pushed the
         card onto a second page and made its table look nothing like itself. */
      @page { size: A4; margin: 8mm; }
      .slip-page{page-break-before:always;font-family:Arial,'Noto Sans Gujarati','Noto Sans Devanagari',sans-serif;color:#111;padding:4px 2px}
      .slip-page:first-child{page-break-before:auto}
      .slip-page h1{font-size:17px;margin:0 0 2px}
      .slip-page p{color:#444;font-size:12px;margin:2px 0}
      .slip-page table{border-collapse:collapse;width:100%;margin-top:12px}
      .slip-page th,.slip-page td{border:1px solid #999;padding:6px 7px;font-size:12px;text-align:left;vertical-align:middle}
      .slip-page th{background:#f3f4f6}
      .slip-page td.num{text-align:right}
      .slip-page td.num .of{color:#777;font-size:10px}
      .slip-page td.blank{min-width:64px;height:30px}
      .slip-page td.sign{min-width:100px}
      .slip-page tr{page-break-inside:avoid}
      .slip-page .reprint{border:2px solid #b91c1c;color:#b91c1c;font-weight:bold;letter-spacing:.08em;
               padding:5px 10px;display:inline-block;margin-bottom:10px;font-size:13px}
      .slip-page .foot{margin-top:20px;font-size:12px;color:#333;display:flex;gap:50px}
      @media print { .aside{display:none} }
    </style></head><body>
    ${merged ? `<div class="wrap">${d.card.sheets}</div>` : ''}
    <div class="slip-page">
    ${d.isReprint ? `<div class="reprint">REPRINT — copy ${d.printNo} · ${today} · ${d.printedBy}</div>` : ''}
    <h1>Material Slip / સામાન સ્લિપ / सामान पर्ची</h1>
    <p><b>${d.order.order_code}</b> · ${d.order.customer_code || ''} · Printed ${today}</p>
    <p>Drawing: <b>${dwg}</b>${dwg ? ` · ગુ: ${transliterateGujarati(dwg)} · हि: ${transliterateHindi(dwg)}` : ''}</p>
    <p>Job Card: <b>${d.jobCard.job_card_no}</b> · Qty: <b>${d.jobCard.qty}</b>${partOfItem ? ` of ${d.item.quantity} · card ${d.cardIndex + 1} of ${d.cardCount}` : ''}${d.item.remark ? ` · ${d.item.remark}` : ''}</p>
    <table>
      <tr><th>#</th><th>Code</th><th>Name</th><th>ગુજરાતી</th><th>हिंदी</th><th>Qty</th>
          <th>Issued / આપ્યું</th><th>Scrap / સ્ક્રેપ</th><th>Sign / સહી</th></tr>
      ${d.lines.map((r, i) => `<tr>
        <td>${i + 1}</td><td><b>${r.item_code}</b></td><td>${r.name || ''}</td>
        <td>${r.name_gu || transliterateGujarati(r.name || '')}</td>
        <td>${transliterateHindi(r.name || '')}</td>
        <td class="num">${shares[i][d.cardIndex]} ${(r.unit || '').trim()}${partOfItem ? ` <span class="of">of ${r.qty}</span>` : ''}</td>
        <td class="blank"></td><td class="blank"></td><td class="sign"></td>
      </tr>`).join('')}
    </table>
    <div class="foot"><span>Design: ______________</span><span>Store: ______________</span><span>Overlooker / નિરીક્ષક: ______________</span></div>
    </div>
    </body></html>`);
  w.document.close();
  // Let the fonts and the card's stylesheet settle before the print dialog,
  // or the first page comes out in a fallback face.
  setTimeout(() => w.print(), merged ? 400 : 0);

  // Only an uploaded card needs a second tab — a generated one is already in
  // the document above.
  // Through the view route, so an uploaded card opens the same way it does
  // everywhere else and a generated one is never served from a stale cache.
  if (!merged && (jc.file_path || jc.file_name)) window.open(`/api/job-cards/${jc.id}/view`, '_blank');
}
