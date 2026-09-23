// Renders a job card from the engine's output, in the trilingual layout the
// shop floor already reads. Screen and print from one file: the sheet prints
// A4, everything around it is screen-only.
//
//   node scripts/renderJobCard.cjs [outfile.html]
//
// This is the step-four renderer in draft. It takes buildJobCard()'s output
// plus the header fields the order already holds, and makes no calculations of
// its own — if a number is wrong here, it is wrong in the engine.
const E = require('../src/lib/jobCardEngine');

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n = (v, dp = 2) => v == null ? '—' : Number(v).toFixed(dp);

// Row labels exactly as the workbook carries them: Gujarati, English, Hindi.
const L = {
  client: ['ક્લાયન્ટ કોડ', 'Client Code', 'ग्राहक का नाम'],
  orderDate: ['ઓર્ડર તારીખ', 'Order Date', 'आदेश दिनांक'],
  product: ['માલ કોડ', 'Product Code', 'उत्पाद कोड'],
  drawing: ['ડ્રોઈંગ નંબર', 'Drawing No', 'हीटरों का नाम'],
  punching: ['પંચિંગ', 'Punching', 'पंचिंग'],
  qty: ['સંખ્યા', 'QTY', 'मात्रा'],
  cardNo: ['જોબ કાર્ડ નંબર', 'Job Card No', 'कार्य पत्रक संख्या'],
  dispatch: ['માલ મોકલવાની તારીખ', 'Dispatch Date', 'भेजने की तिथि'],
  fixture: ['ફિક્સ્ચર પ્રકાર', 'Fixture Type', 'फिक्स्चर प्रकार'],
};

// The colour grading off the workbook, cell for cell. The floor reads these
// boxes before it reads the labels, so they are content, not decoration:
//   key  #F6C6AC  the figure that matters on that row
//   dia  #31859B  the tube diameter — which workbook this card came from
//   mid  #FFF2CC  E19, the middle of the three lengths
//   cz   #F9CB9C  both cold zones
//   tab  #FABF8F / #8ED873  the blank blocks beside the wattage and the gauge
const box = (v, kind) => `<span class="box box--${kind}">${v}</span>`;
const tab = kind => `<span class="box box--${kind} box--tab"></span>`;

function specRows(c) {
  const wire = c.wire || {};
  return [
    ['1', ['વિજળીનો ભાર / વોલ્ટેજ', 'Wattage / Voltage', 'वाट क्षमता / वोल्टेज'],
      `${box(n(c.wattage, 0), 'key')}${tab('tab2')} W &nbsp; ${box(n(c.voltage, 0), 'key')} V`,
      c.elements > 1 ? `${n(c.statedWattage, 0)} W across ${c.elements} elements` : ''],
    ['2', ['ટ્યુબ સામગ્રી', 'Tube Material', 'ट्यूब सामग्री'],
      `${box(esc(c.tubeMaterialLabel), 'key')} &nbsp; ${box(c.tubeDiameterMm, 'dia')} mm`, ''],
    // Four cells, in the card's own order and with no units printed — exactly
    // as C19 / E19 / F19 / G19 sit on the sheet the floor already reads. The
    // third figure is the total in INCHES sitting between two millimetre
    // lengths; it looks odd written out, but moving or labelling it is what
    // would actually confuse someone who reads this row by position.
    ['3', ['ડ્રોઇંગ પછી ટ્યુબની લંબાઈ', 'Tube Length After Draw', 'मोड़ने की लंबाई'],
      `<span class="cells"><span>${n(c.row19LengthsMm[2])}</span>${box(n(c.row19LengthsMm[1]), 'mid')}${box(n(c.totalLengthIn), 'key')}<span>${n(c.row19LengthsMm[0])}</span></span>`, ''],
    ['3', ['ટ્યુબ કાપવાની લંબાઈ', 'Tube Cutting Length', 'ट्यूब काटने की लंबाई'],
      `${n(c.cuttingLengthIn, 3)}" &nbsp;–&nbsp; ${n(c.cuttingLengthMm)} mm`,
      `${(c.tubeDrawPct * 100).toFixed(1)}% draw`],
    ['4', ['વાયર ગેજ Ω/મીટર', 'Wire Gauge Ω/mtr', 'तार गेज Ω/मीटर'],
      c.gauge == null ? '<span class="blank">to be chosen by hand</span>'
        : `${box(c.gauge, 'key')}${tab('tab3')} SWG &nbsp; ${box(`${n(wire.ohms_per_m, 3)} Ω/mtr &nbsp; ${wire.mandrel_mm} Mandrel`, 'key')}`,
      c.spoolOptions.length > 1 ? `${c.spoolOptions.length} spools of this gauge fit` : ''],
    ['5', ['સ્પ્રિંગની સીમા', 'Wire Length', 'स्प्रिंग की सीमा'],
      `${n(c.springWindowLowIn, 3)}" &nbsp;<span class="to">TO</span>&nbsp; ${n(c.springWindowHighIn, 3)}"`,
      c.springLengthIn ? `wound ${n(c.springLengthIn, 3)}"` : ''],
    ['6', ['ઓહ્મ પ્રતિકાર', 'Ohms Range', 'ओम प्रतिरोध'],
      c.ohmsRangeMid == null ? '<span class="blank">—</span>'
        : `${n(c.ohmsRangeMin, 3)} &nbsp;–&nbsp; <b>${n(c.ohmsRangeMid, 3)}</b> &nbsp;–&nbsp; ${n(c.ohmsRangeMax, 3)} &nbsp; ${box(`${(c.wireDrawPct * 100).toFixed(0)}%`, 'key')}`,
      'the boxed figure is the wire draw'],
    ['7', ['ઠંડા ઝોનની મોટી લંબાઈ', 'Cold Zone Big', 'बड़ा कोल्ड ज़ोन'], box(n(c.coldZoneBigIn, 0), 'cz'), ''],
    ['8', ['ઠંડા ઝોનની નાની લંબાઈ', 'Cold Zone Small', 'छोटा कोल्ड ज़ोन'], box(n(c.coldZoneSmallIn, 0), 'cz'), ''],
    ['9', ['ટર્મિનલ પિન મોટો સ્ટડ', 'Terminal Pin — Big Stud', 'टर्मिनल पिन बड़ा स्टड'],
      `એમ ૪-એસએસ &nbsp;·&nbsp; M4-SS &nbsp;·&nbsp; ${c.terminalPinBig.studs}"`, ''],
    ['10', ['ટર્મિનલ પિન નાનો સ્ટડ', 'Terminal Pin — Small Stud', 'टर्मिनल पिन छोटा स्टड'],
      `એમ ૪-એસએસ &nbsp;·&nbsp; M4-SS &nbsp;·&nbsp; ${c.terminalPinSmall.studs}"`, ''],
    ['12', ['ડ્રોઇંગ પછી પ્રતિકાર', 'Ω Ohms After Draw', 'ड्रॉ के बाद प्रतिरोध'],
      `${n(c.ohmsAfterDrawMin, 3)} &nbsp;–&nbsp; <b>${n(c.ohmsAfterDraw, 3)}</b> &nbsp;–&nbsp; ${n(c.ohmsAfterDrawMax, 3)}`,
      '±5%'],
  ];
}

function render(card, head, provenance) {
  const c = card;
  const rows = specRows(c).map(([num, [gu, en, hi], val, note]) => `
      <tr>
        <td class="num">${num}</td>
        <td class="label"><span class="gu">${esc(gu)}</span><span class="en">${esc(en)}</span><span class="hi">${esc(hi)}</span></td>
        <td class="value">${val}${note ? `<span class="note">${esc(note)}</span>` : ''}</td>
        <td class="actual"></td>
      </tr>`).join('');

  const meta = [
    [L.client, head.clientCode], [L.orderDate, head.orderDate],
    [L.product, head.productCode], [L.drawing, head.drawingNumber],
    [L.punching, head.punching], [L.qty, head.qty],
    [L.dispatch, head.dispatchDate], [L.fixture, head.fixture],
  ].map(([[gu, en, hi], v]) => `
        <div class="meta-cell">
          <div class="meta-label"><span class="gu">${esc(gu)}</span><span class="en">${esc(en)}</span><span class="hi">${esc(hi)}</span></div>
          <div class="meta-value">${esc(v)}</div>
        </div>`).join('');

  return `<title>BPE Flameproof Job Card</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Noto+Sans+Gujarati:wght@400;600&family=Noto+Sans+Devanagari:wght@400;600&display=swap">
<style>
  /* Steel and ink: a works order, not a brochure. Neutrals carry a slight
     green-grey bias (passivated stainless), and they stay quiet on purpose —
     the only colour on the sheet is the workbook's own cell grading, which the
     floor already reads. See the .box rules below. */
  :root {
    --paper: #FBFBF9;
    --ground: #EDEEEA;
    --ink: #1B211F;
    --ink-2: #4A534F;
    --ink-3: #79827D;
    --rule: #C7CCC6;
    --rule-hard: #8C948E;
    --attention: #8A4B10;
    --attention-bg: #F8EFE4;
    --sans: 'IBM Plex Sans', system-ui, sans-serif;
    --mono: 'IBM Plex Mono', ui-monospace, monospace;
    --gu: 'Noto Sans Gujarati', 'IBM Plex Sans', sans-serif;
    --hi: 'Noto Sans Devanagari', 'IBM Plex Sans', sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --paper: #1A1E1C; --ground: #121514; --ink: #E8EBE8; --ink-2: #A8B0AB;
      --ink-3: #79827D; --rule: #333B37; --rule-hard: #59615B;
      --attention: #D9A26A; --attention-bg: #2B221A;
    }
  }
  :root[data-theme="dark"] {
    --paper: #1A1E1C; --ground: #121514; --ink: #E8EBE8; --ink-2: #A8B0AB;
    --ink-3: #79827D; --rule: #333B37; --rule-hard: #59615B;
    --attention: #D9A26A; --attention-bg: #2B221A;
  }

  body { background: var(--ground); color: var(--ink); font-family: var(--sans); }
  * { box-sizing: border-box; }
  .wrap { display: flex; flex-direction: column; gap: 22px; align-items: center; padding: 24px 16px 56px; }

  /* ── The sheet ───────────────────────────────────────────────────────── */
  .sheet {
    width: 100%; max-width: 820px; background: var(--paper);
    border: 1.5px solid var(--rule-hard); padding: 22px 24px 20px;
    box-shadow: 0 1px 2px rgba(0,0,0,.05), 0 8px 28px rgba(0,0,0,.06);
  }
  .sheet-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
    border-bottom: 2px solid var(--ink); padding-bottom: 12px; }
  .sheet-title { font-size: 19px; font-weight: 700; letter-spacing: .10em; text-transform: uppercase; text-wrap: balance; }
  .sheet-sub { font-size: 11px; color: var(--ink-3); letter-spacing: .04em; margin-top: 4px; }
  .asmbly { border: 1.5px solid var(--ink); padding: 7px 13px; text-align: center; flex: none; }
  .asmbly span { display: block; font-size: 9px; letter-spacing: .13em; color: var(--ink-2); }
  .asmbly b { font-family: var(--mono); font-size: 19px; font-weight: 600; }

  .meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0;
    border-bottom: 2px solid var(--ink); }
  .meta-cell { padding: 9px 12px 9px 0; border-bottom: 1px solid var(--rule); }
  .meta-cell:nth-child(odd) { border-right: 1px solid var(--rule); padding-right: 16px; }
  .meta-cell:nth-child(even) { padding-left: 16px; }
  .meta-cell:nth-last-child(-n+2) { border-bottom: none; }
  .meta-label { display: flex; flex-wrap: wrap; gap: 0 7px; font-size: 10px; color: var(--ink-3); line-height: 1.5; }
  .meta-value { font-family: var(--mono); font-size: 14px; font-weight: 500; margin-top: 2px; word-break: break-word; }

  .gu { font-family: var(--gu); }
  .hi { font-family: var(--hi); }
  .en { font-weight: 600; color: var(--ink-2); }

  table { width: 100%; border-collapse: collapse; }
  thead th { font-size: 9px; letter-spacing: .13em; text-transform: uppercase; color: var(--ink-3);
    text-align: left; padding: 9px 8px; border-bottom: 1px solid var(--rule-hard); font-weight: 600; }
  thead th.c { text-align: center; }
  tbody td { padding: 8px; border-bottom: 1px solid var(--rule); vertical-align: top; }
  td.num { width: 30px; font-family: var(--mono); font-size: 12px; color: var(--ink-3); text-align: center; }
  td.label { width: 40%; }
  td.label span { display: block; line-height: 1.45; }
  td.label .gu, td.label .hi { font-size: 11.5px; color: var(--ink-2); }
  td.label .en { font-size: 12.5px; color: var(--ink); }
  td.value { font-family: var(--mono); font-size: 13.5px; font-variant-numeric: tabular-nums; color: var(--ink); }

  /* ── The workbook's colour grading ───────────────────────────────────────
     These six fills are lifted straight off the sheet, and they stay literal
     in both themes: the floor identifies a figure by its colour before it
     reads the label, so the fill is the content. Text on a fill is pinned to
     the sheet's ink rather than a theme token, since the fill does not change
     with the theme. */
  .box { display: inline-block; padding: 2px 9px; color: #1B211F;
    border: 1px solid rgba(0,0,0,.22); font-weight: 500; }
  .box--key  { background: #F6C6AC; }
  .box--dia  { background: #31859B; color: #FFFFFF; border-color: rgba(0,0,0,.3); }
  .box--mid  { background: #FFF2CC; }
  .box--cz   { background: #F9CB9C; }
  .box--tab2 { background: #FABF8F; }
  .box--tab3 { background: #8ED873; }
  .box--tab  { width: 15px; padding: 2px 0; }
  td.value b { font-weight: 600; }
  td.value .to { font-family: var(--sans); font-size: 10px; letter-spacing: .1em; color: var(--ink-3); }
  /* Row 19 reads as four separate cells, the way it does on the sheet. */
  td.value .cells { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
  td.value .cells > span { min-width: 58px; }
  td.value .cells > .box { min-width: 0; text-align: center; }
  td.value .note { display: block; font-family: var(--sans); font-size: 10.5px; color: var(--ink-3); margin-top: 3px; letter-spacing: .01em; }
  td.value .blank { color: var(--attention); font-family: var(--sans); font-size: 12px; }
  td.actual { width: 88px; border-left: 1px solid var(--rule); }

  .foot { border-top: 2px solid var(--ink); margin-top: 2px; }
  .foot-row { display: flex; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--rule); }
  .foot-row:last-child { border-bottom: none; }
  .foot-num { font-family: var(--mono); font-size: 12px; color: var(--ink-3); width: 30px; text-align: center; flex: none; }
  .foot-label { width: 40%; flex: none; }
  .foot-label span { display: block; line-height: 1.45; }
  .foot-label .gu, .foot-label .hi { font-size: 11.5px; color: var(--ink-2); }
  .foot-label .en { font-size: 12.5px; }
  .foot-value { font-size: 12.5px; line-height: 1.65; }
  .foot-value .line { display: block; }

  .sign { display: grid; grid-template-columns: repeat(3, 1fr); gap: 28px; margin-top: 26px; }
  .sign div { border-top: 1px solid var(--rule-hard); padding-top: 6px; font-size: 10px;
    letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); }

  /* ── Screen-only commentary ──────────────────────────────────────────── */
  .aside { width: 100%; max-width: 820px; display: flex; flex-direction: column; gap: 14px; }
  .panel { background: var(--paper); border: 1px solid var(--rule); padding: 16px 18px; }
  .panel h2 { margin: 0 0 3px; font-size: 12px; letter-spacing: .11em; text-transform: uppercase; }
  .panel p.lede { margin: 0 0 12px; font-size: 12.5px; color: var(--ink-3); line-height: 1.55; }
  .prov { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px 20px; }
  .prov div { font-size: 12.5px; line-height: 1.5; }
  .prov b { display: block; font-size: 9.5px; letter-spacing: .11em; text-transform: uppercase; color: var(--ink-3); font-weight: 600; }
  .warns { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .warns li { background: var(--attention-bg); border-left: 3px solid var(--attention);
    padding: 9px 12px; font-size: 12.5px; line-height: 1.5; color: var(--ink); }
  .key { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 11.5px; color: var(--ink-3); }
  .key { align-items: center; }
  .key .sw { display: inline-flex; align-items: center; gap: 7px; }
  .key .sw b { width: 15px; height: 15px; border: 1px solid rgba(0,0,0,.25); flex: none; }

  @media (max-width: 600px) {
    .meta { grid-template-columns: 1fr; }
    .meta-cell:nth-child(odd) { border-right: none; padding-right: 0; }
    .meta-cell:nth-child(even) { padding-left: 0; }
    .meta-cell:nth-last-child(2) { border-bottom: 1px solid var(--rule); }
    td.label { width: 50%; }
    td.actual { width: 52px; }
    .sign { grid-template-columns: 1fr; gap: 18px; }
  }
  @media print {
    body { background: #fff; }
    .wrap { padding: 0; }
    .aside { display: none; }
    .sheet { box-shadow: none; border: 1.5px solid #000; max-width: none; }
  }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>

<div class="wrap">
  <section class="sheet">
    <div class="sheet-head">
      <div>
        <div class="sheet-title">Heating Element Job Card</div>
        <div class="sheet-sub">${esc(head.company)} &nbsp;·&nbsp; 8 mm &nbsp;·&nbsp; ${esc(head.cardNo)}</div>
      </div>
      <div class="asmbly"><span>ASMBLY</span><b>${esc(head.asmbly)}</b></div>
    </div>

    <div class="meta">${meta}</div>

    <table>
      <thead>
        <tr><th class="c">#</th><th>Specification</th><th>Engine value</th><th class="c">Actual<br><span class="gu">વાસ્તવિક</span></th></tr>
      </thead>
      <tbody>${rows}
      </tbody>
    </table>

    <div class="foot">
      <div class="foot-row">
        <div class="foot-num">15</div>
        <div class="foot-label"><span class="gu">ટિપ્પણી</span><span class="en">Remark</span><span class="hi">टिप्पणी</span></div>
        <div class="foot-value">${head.remark.map(l => `<span class="line">${esc(l)}</span>`).join('')}</div>
      </div>
      <div class="foot-row">
        <div class="foot-num">16</div>
        <div class="foot-label"><span class="gu">પડ ચડાવવું</span><span class="en">Plating</span><span class="hi">प्लेटिंग के लिए निर्देश</span></div>
        <div class="foot-value">${box(esc(head.plating), 'key')}</div>
      </div>
    </div>

    <div class="sign"><div>Production</div><div>QC</div><div>Approved</div></div>
  </section>

  <aside class="aside">
    <div class="panel">
      <h2>Where each figure came from</h2>
      <p class="lede">Nothing on this sheet was typed by hand. Eight fields come off the order, four are asked when the card is made, and the rest is arithmetic.</p>
      <div class="prov">${provenance.map(([k, v]) => `<div><b>${esc(k)}</b>${esc(v)}</div>`).join('')}</div>
    </div>
    ${c.warnings.length ? `<div class="panel">
      <h2>What the engine flagged</h2>
      <p class="lede">These ride with the draft for the owner to clear before the card is approved.</p>
      <ul class="warns">${c.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>
    </div>` : ''}
    <div class="panel">
      <h2>The colour grading</h2>
      <p class="lede">Lifted off your workbook, cell for cell — the same six fills on the same figures.</p>
      <div class="key">
        <span class="sw"><b style="background:#F6C6AC"></b>The figure that matters on that row</span>
        <span class="sw"><b style="background:#31859B"></b>Tube diameter — which workbook the card came from</span>
        <span class="sw"><b style="background:#FFF2CC"></b>Middle of the three lengths</span>
        <span class="sw"><b style="background:#F9CB9C"></b>Cold zones</span>
        <span class="sw"><b style="background:#FABF8F"></b><b style="background:#8ED873"></b>The blank tabs beside wattage and gauge</span>
      </div>
      <p class="lede" style="margin:12px 0 0">The Actual column stays blank for the floor. Rows 13 and 14 were the bending rollers, now read off the drawing.</p>
    </div>
  </aside>
</div>
`;
}

module.exports = { render };

if (require.main === module) {
  // The BPE flameproof order, exactly as the engine computes it today.
  const input = {
    tubeMaterial: 'SS304', wattage: 9000, voltage: 230,
    drawingTotalLengthIn: 45.6,
    drawingNumber: 'PT-FlameProof-550U-9Kw-3in1', productCode: 'PT-FlameProof',
    coldZoneBigIn: 3, coldZoneSmallIn: 3,
  };
  const card = E.buildJobCard(input);
  if (!card.ok) { console.error(card.error); process.exit(1); }
  card.tubeMaterialLabel = 'SS304 / એસએસ ૩૦૪';

  const head = {
    company: 'Peena Heat Elements', cardNo: 'JC-2609-0148', asmbly: '3',
    clientCode: 'BPE', orderDate: '17.09.26', productCode: 'PT-FlameProof',
    drawingNumber: 'PT-FlameProof-550U-9Kw-3in1', punching: 'BHA-9000W-230V',
    qty: '24 Nos (8 nos-3in1)', dispatchDate: '29.09.26', fixture: 'U-clamp, 550 mm centres',
    remark: ['BSP will be provided by BPE, FLP-PHE', 'BSP, BPE દ્વારા આપવામાં આવશે', 'BSP, BPE द्वारा प्रदान किया जाएगा'],
    plating: 'Buffing / બફિંગ / बफिंग',
  };

  const provenance = [
    ['From the order', 'Client code, order date, product code, drawing no, punching, quantity, tube material, plating, remark'],
    ['Asked when making the card', 'ASMBLY, fixture type, dispatch date, total length off the drawing'],
    ['Total length', `45.6" on the drawing + 0.7" allowance = ${n(card.totalLengthIn, 1)}"`],
    ['Wattage', `9000 W read as a 3-in-1 from the drawing name, so ${n(card.wattage, 0)} W per element`],
    ['Tube draw', `${(card.tubeDrawPct * 100).toFixed(1)}% — SS between 44" and 50"`],
    ['Wire gauge', `${card.gauge} SWG at ${(card.wireDrawPct * 100).toFixed(0)}% wire draw, the only self-consistent answer; ${card.spoolOptions.length} spools of it fit the spring window`],
    ['Cold zone', `3" set by hand; the standard for a ${n(card.totalLengthIn, 1)}" element is 2"`],
    ['Terminal pin', `ceil(3 ÷ 1.215 + 1) = ${card.terminalPinBig.studs}"`],
  ];

  const out = process.argv[2] || 'jobcard-sample.html';
  require('fs').writeFileSync(out, render(card, head, provenance));
  console.log(`${out} — ${card.gauge} SWG @ ${(card.wireDrawPct * 100).toFixed(0)}%, ohms ${card.ohmsRangeMid}, ${card.warnings.length} warning(s)`);
}
