// Monthly Production Report — rich, self-explaining Excel workbook (via exceljs):
// filters, conditional formatting, per-item detail, plain-English guide + analysis,
// days-to-dispatch by product, finished-goods stocking suggestions, and delay reasons.
const ExcelJS = require('exceljs');

const RPT_STAGES = {
  1:'Coil',2:'Coil + Tube Cutting',3:'Ohms',4:'Spot',5:'Tube Cutting',6:'Filling',
  7:'HV + Light (1)',8:'Draw',9:'HV + Light (2)',10:'Straightening',11:'Trimming',
  12:'Annealing',13:'Buffing',14:'Bending',15:'Brazing',16:'In Plating',17:'Plating Completed',
  18:'Heater Cleaning',19:'Overnight Oven',20:'HV + Light (3)',21:'Nipple Press',22:'3 Hours Oven',
  23:'Sealing',24:'HV + Light (4)',25:'Cleaning',26:'Nut Washer',27:'HV + Light (5)',
  28:'Megger',29:'Ready in Production',30:'Kharoch Process',
};
const num = (x) => Number(x) || 0;
const round = (x, n=2) => (x==null || isNaN(x)) ? null : Math.round(x * 10**n) / 10**n;
const parseOhms = (v1) => { try { const d = JSON.parse(v1); const o = parseFloat(d?.ohms); return isNaN(o) ? null : o; } catch { return null; } };
const dstr = (d) => d ? new Date(d).toISOString().slice(0,10) : '';
const daysBetween = (a, b) => (a && b) ? Math.round((new Date(b) - new Date(a)) / 864e5) : null;
// Finished Goods is keyed by the job-card/drawing name (base_drawing_no), i.e. the
// drawing name with any trailing -N split/duplicate suffix removed — NOT the product code.
const baseDrawing = (s) => s ? (String(s).trim().replace(/-\d+$/, '') || String(s).trim()) : '';

// ── Colours ──
const FILL = (argb) => ({ type:'pattern', pattern:'solid', fgColor:{ argb } });
const RED = 'FFF8CBAD', GREEN = 'FFC6EFCE', AMBER = 'FFFFEB9C', BLUE = 'FFDDEBF7', HEAD = 'FF1F4E78';

async function buildMonth(db, startISO, endISO) {
  const cards = await db.all(`
    SELECT jc.id, jc.job_card_no, jc.qty, jc.dispatch_date, jc.drawing_no, jc.product_name, jc.created_at,
           jc.tube_used_qty, jc.tube_scrap_qty, jc.coil_used_qty, jc.coil_scrap_qty,
           o.order_code, o.order_type, c.customer_code,
           oi.voltage, oi.wattage, oi.tube_material, oi.product_code,
           s29.done_at AS produced_at
    FROM job_cards jc
    JOIN production_checklist s29 ON s29.job_card_id = jc.id AND s29.stage_no = 29 AND s29.done = 1
    JOIN orders o ON o.id = jc.order_id
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN order_items oi ON oi.id = jc.order_item_id
    WHERE s29.done_at::timestamptz >= $1::timestamptz AND s29.done_at::timestamptz < $2::timestamptz
    ORDER BY s29.done_at`, [startISO, endISO]);
  if (!cards.length) return { rows: [], stageRejects: {}, workers: {}, products: {} };
  const ids = cards.map(c => c.id);
  const cl = await db.all(`SELECT job_card_id, stage_no, value1, worker_name, rejection_qty, remade_qty
                           FROM production_checklist WHERE job_card_id = ANY($1)`, [ids]);
  const disp = await db.all(`SELECT job_card_id, MAX(dispatch_date) AS dispatched_at FROM dispatch_documents
                             WHERE job_card_id = ANY($1) GROUP BY job_card_id`, [ids]);
  const holds = await db.all(`SELECT job_card_id, stage_no, rejection_qty, status, notes, created_at
                              FROM job_card_holds WHERE job_card_id = ANY($1) ORDER BY created_at`, [ids]);
  const invCost = {};
  (await db.all(`SELECT upper(item_code) code, unit_cost FROM inventory_items
                 WHERE lower(trim(category)) IN ('tube','spring guage')`)).forEach(i => invCost[i.code] = num(i.unit_cost));
  const dispMap = {}; disp.forEach(x => dispMap[x.job_card_id] = x.dispatched_at);
  const byCard = {}; cl.forEach(r => (byCard[r.job_card_id] ||= []).push(r));
  const holdsByCard = {}; holds.forEach(h => (holdsByCard[h.job_card_id] ||= []).push(h));

  const stageRejects = {}, workers = {}, products = {};
  const now = new Date();
  const rows = cards.map(c => {
    const cs = byCard[c.id] || [];
    const stg = n => cs.find(r => r.stage_no === n);
    let rejects = 0, remades = 0; const wset = new Set();
    cs.forEach(r => {
      const rq = parseInt(r.rejection_qty,10)||0; rejects += rq;
      if (r.stage_no !== 29) remades += parseInt(r.remade_qty,10)||0;
      if (rq > 0) stageRejects[r.stage_no] = (stageRejects[r.stage_no]||0) + rq;
      if (r.worker_name && r.worker_name.trim()) {
        const w = r.worker_name.trim(); wset.add(w);
        (workers[w] ||= { items:new Set(), rejects:0 }); workers[w].items.add(c.id); workers[w].rejects += rq;
      }
    });
    const designed = (c.voltage && c.wattage) ? round(c.voltage*c.voltage/c.wattage) : null;
    const actual = parseOhms(stg(27)?.value1);
    const dev = (designed && actual) ? round((actual-designed)/designed*100, 1) : null;
    const gauge = (stg(1)?.value1 || '').toUpperCase();
    const matVal = round(((num(c.tube_used_qty)+num(c.tube_scrap_qty)) * (invCost[(c.tube_material||'').toUpperCase()]||0))
                       + ((num(c.coil_used_qty)+num(c.coil_scrap_qty)) * (invCost[gauge]||0)));
    const dispAt = dispMap[c.id] || null;
    const onTime = dispAt ? (new Date(dispAt) <= new Date(c.dispatch_date) ? 'Yes' : 'No') : 'Pending';
    const overduePending = onTime === 'Pending' && c.dispatch_date && now > new Date(c.dispatch_date);
    const lateDays = dispAt ? Math.max(0, daysBetween(c.dispatch_date, dispAt) || 0)
                            : (overduePending ? (daysBetween(c.dispatch_date, now) || 0) : 0);
    let delay = '';
    if (onTime === 'No' || overduePending) {
      const hs = holdsByCard[c.id] || [];
      if (hs.length) { const h = hs[hs.length-1];
        delay = `On hold at Stage ${h.stage_no} (${RPT_STAGES[h.stage_no]||''}) — ${h.rejection_qty} rejection(s)`
              + (h.notes ? `: ${h.notes}` : '') + (h.status === 'pending' ? ' [awaiting owner approval]' : '');
      } else if (rejects > 0) { delay = `Rework — ${rejects} rejection(s) across stages`; }
      else if (onTime === 'Pending') { delay = 'Still in production / not yet dispatched'; }
      else { delay = 'Dispatched late (no hold or rejection recorded)'; }
    }
    const pkey = baseDrawing(c.drawing_no || c.product_name || c.job_card_no) || '—'; // FG groups by job-card/drawing name
    (products[pkey] ||= { qty:0, count:0, customers:new Set() });
    products[pkey].count++; products[pkey].qty += num(c.qty); products[pkey].customers.add(c.customer_code);

    return {
      jc: c.job_card_no, order: c.order_code, customer: c.customer_code,
      product: c.product_code || '', drawing: c.drawing_no || c.product_name || '', type: c.order_type,
      qty: c.qty, netQty: Math.max((c.qty||0)-rejects+remades, 0),
      voltage: c.voltage||'', wattage: c.wattage||'',
      ohmsDes: designed ?? '', ohmsAct: actual ?? '', ohmsDev: dev ?? '', ohmsFlag: dev==null ? '' : (Math.abs(dev)>5 ? 'OUT' : 'OK'),
      megger: stg(28)?.value1 || '', drawLen: stg(8)?.value1 || '', tubeCut: stg(5)?.value1 || '',
      rejects, remakes: remades,
      gauge: stg(1)?.value1 || '',
      tubeUsed: c.tube_used_qty ?? '', tubeScrap: c.tube_scrap_qty ?? '', wireUsed: c.coil_used_qty ?? '', wireScrap: c.coil_scrap_qty ?? '',
      matVal: matVal ?? '',
      produced: dstr(c.produced_at), due: c.dispatch_date || '', dispatched: dstr(dispAt),
      daysToDispatch: dispAt ? (daysBetween(c.created_at, dispAt) ?? '') : '',
      onTime, lateDays, cycleDays: daysBetween(c.created_at, c.produced_at) ?? '',
      delay, workers: [...wset].join(', '),
    };
  });
  return { rows, stageRejects, workers, products };
}

function summarize(rows) {
  const n = rows.length, N = (r,k) => Number(r[k]) || 0;
  const qty = rows.reduce((s,r)=>s+N(r,'qty'),0);
  const rejects = rows.reduce((s,r)=>s+N(r,'rejects'),0);
  const firstPass = rows.filter(r=>N(r,'rejects')===0).length;
  const disp = rows.filter(r=>r.onTime!=='Pending');
  const ontime = disp.filter(r=>r.onTime==='Yes').length;
  const devs = rows.map(r=>r.ohmsDev).filter(v=>v!=='' && v!=null).map(Number);
  const dtd = rows.map(r=>r.daysToDispatch).filter(v=>v!=='' && v!=null).map(Number);
  return {
    items:n, qty, rejects, remakes: rows.reduce((s,r)=>s+N(r,'remakes'),0),
    rejectRate: qty ? round(rejects/qty*100,1) : 0,
    firstPass: n ? round(firstPass/n*100,1) : 0,
    onTime: disp.length ? round(ontime/disp.length*100,1) : 0,
    scrapTube: round(rows.reduce((s,r)=>s+N(r,'tubeScrap'),0)),
    scrapWire: round(rows.reduce((s,r)=>s+N(r,'wireScrap'),0),3),
    matCost: round(rows.reduce((s,r)=>s+N(r,'matVal'),0)),
    avgOhmsDev: devs.length ? round(devs.reduce((s,v)=>s+Math.abs(v),0)/devs.length,1) : null,
    outSpec: rows.filter(r=>r.ohmsFlag==='OUT').length,
    avgDaysToDispatch: dtd.length ? round(dtd.reduce((s,v)=>s+v,0)/dtd.length,1) : null,
  };
}

// header row styling
function styleHeader(ws) {
  ws.getRow(1).eachCell(c => {
    c.font = { bold:true, color:{ argb:'FFFFFFFF' } };
    c.fill = FILL(HEAD); c.alignment = { vertical:'middle', wrapText:true };
  });
  ws.getRow(1).height = 28;
  ws.views = [{ state:'frozen', ySplit:1 }];
}

async function generate(db, month) {
  const [y, m] = month.split('-').map(Number);
  const mStart = (yy, mm) => new Date(Date.UTC(yy, mm, 1)).toISOString();
  const cur  = await buildMonth(db, mStart(y, m-1), mStart(y, m));
  const prev = await buildMonth(db, mStart(y, m-2), mStart(y, m-1));
  const A = summarize(cur.rows), B = summarize(prev.rows);

  // trailing 12 months: trend + finished-goods recurrence
  const trend = [], fg = {};
  for (let i = 11; i >= 0; i--) {
    const md = await buildMonth(db, mStart(y, m-1-i), mStart(y, m-i));
    const s = summarize(md.rows);
    trend.push({ month: mStart(y, m-1-i).slice(0,7), items:s.items, qty:s.qty, rejectRate:s.rejectRate,
      firstPass:s.firstPass, onTime:s.onTime, scrapTube:s.scrapTube, scrapWire:s.scrapWire,
      avgOhmsDev:s.avgOhmsDev ?? '', outSpec:s.outSpec, avgDaysToDispatch:s.avgDaysToDispatch ?? '', matCost:s.matCost });
    for (const [k, v] of Object.entries(md.products)) {
      (fg[k] ||= { qty:0, count:0, months:0, customers:new Set() });
      fg[k].qty += v.qty; fg[k].count += v.count; fg[k].months += 1; v.customers.forEach(c => fg[k].customers.add(c));
    }
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'PHE-app';

  // ── Sheet 1: How to Read (Guide) ──
  const g = wb.addWorksheet('How to Read');
  g.columns = [{ header:'Metric', key:'m', width:26 }, { header:'What it means', key:'w', width:70 }, { header:'Good direction', key:'d', width:16 }];
  const guide = [
    ['Reject rate %', 'Of everything you made, the share rejected during production. Lower = better quality.', 'Lower ↓'],
    ['First-pass yield %', 'Share of items that passed with ZERO rejections. Higher = fewer reworks.', 'Higher ↑'],
    ['Avg |Ω deviation| %', 'How far actual resistance (stage 27) is from the designed value (V²/W), on average. Near 0 = accurate coils.', 'Lower ↓'],
    ['Ω out-of-spec', 'Count of items whose resistance was more than ±5% off design. These may under/over-heat.', 'Lower ↓'],
    ['On-time dispatch %', 'Share of dispatched items shipped on or before their due date. Higher = reliable delivery.', 'Higher ↑'],
    ['Avg days to dispatch', 'Average days from job-card creation to actual dispatch (total lead time). Lower = faster.', 'Lower ↓'],
    ['Tube / Wire scrap', 'Material wasted as scrap. Lower = less waste and cost.', 'Lower ↓'],
    ['Material consumed ₹', 'Value of tube + wire consumed (used + scrap), from FIFO cost. Watch vs output.', '—'],
    ['Rejections by stage', 'Which production stage causes the most rejects — fix the top stage first for the biggest gain.', 'Focus top'],
    ['Ω OUT flag', 'Red = resistance outside ±5% of design. Investigate coil length/gauge for those items.', '—'],
    ['Delay reason', 'For items dispatched late (or overdue): why — usually a HOLD (too many rejects at a stage) or rework.', '—'],
    ['Finished-Goods candidate', 'Products you make again and again (many months/customers) are the safest to keep as ready stock so you can ship instantly. One-off make-to-order items should NOT be stocked.', '—'],
  ];
  guide.forEach(r => g.addRow({ m:r[0], w:r[1], d:r[2] }));
  styleHeader(g);
  g.eachRow((row, i) => { if (i>1) row.getCell('w').alignment = { wrapText:true, vertical:'top' }; });

  // ── Sheet 2: Monthly Analysis (with interpretation) ──
  const an = wb.addWorksheet('Monthly Analysis');
  an.columns = [{ header:'KPI', key:'k', width:26 }, { header:'This Month', key:'t', width:14 },
    { header:'Last Month', key:'l', width:14 }, { header:'Change', key:'c', width:12 }, { header:'What it means & what to do', key:'i', width:64 }];
  const interp = (t, l, better, up, down) => {
    if (t==null||l==null||t===''||l==='') return { c:'', i:'Not enough data to compare.' };
    const ch = round(t-l,1); if (ch===0) return { c:0, i:'No change vs last month.' };
    const improved = better==='higher' ? ch>0 : ch<0;
    return { c:ch, i:(improved?'✅ Improved. ':'⚠️ Worsened. ') + (improved?up:down) };
  };
  const addKpi = (k, t, l, better, up, down) => { const r = interp(t,l,better,up,down); an.addRow({ k, t:t??'', l:l??'', c:r.c, i:r.i }); };
  an.addRow({ k:`MONTHLY PRODUCTION REPORT — ${month}` });
  an.addRow({ k:'Basis: items whose production (Stage 29) completed this month. Compared to the previous month.' });
  an.addRow({});
  an.addRow({ k:'OUTPUT' });
  addKpi('Items produced', A.items, B.items, 'higher', 'More items completed.', 'Fewer items — check capacity/holds.');
  addKpi('Units (qty)', A.qty, B.qty, 'higher', 'Higher output.', 'Lower output — investigate delays.');
  an.addRow({}); an.addRow({ k:'QUALITY' });
  addKpi('Reject rate %', A.rejectRate, B.rejectRate, 'lower', 'Fewer rejects.', 'More rejects — see "Rejections by stage" below and fix the top stage.');
  addKpi('First-pass yield %', A.firstPass, B.firstPass, 'higher', 'More right-first-time.', 'More rework — target the worst stage/worker.');
  addKpi('Avg |Ω deviation| %', A.avgOhmsDev, B.avgOhmsDev, 'lower', 'Coils more accurate.', 'Resistance drifting — check coil length/gauge & stage-3 ohms.');
  addKpi('Ω out-of-spec (>±5%)', A.outSpec, B.outSpec, 'lower', 'Fewer bad-resistance items.', 'More out-of-spec — review the flagged items in Item Detail.');
  an.addRow({}); an.addRow({ k:'ON-TIME DELIVERY' });
  addKpi('On-time dispatch %', A.onTime, B.onTime, 'higher', 'More on-time.', 'More late — see "Late Items & Reasons".');
  addKpi('Avg days to dispatch', A.avgDaysToDispatch, B.avgDaysToDispatch, 'lower', 'Faster turnaround.', 'Slower — look for holds/bottleneck stages.');
  an.addRow({}); an.addRow({ k:'MATERIAL & COST' });
  addKpi('Tube scrap (ft)', A.scrapTube, B.scrapTube, 'lower', 'Less tube waste.', 'More tube waste — check cutting/draw.');
  addKpi('Wire scrap (kg)', A.scrapWire, B.scrapWire, 'lower', 'Less wire waste.', 'More wire waste — check coiling.');
  addKpi('Material consumed ₹', A.matCost, B.matCost, 'lower', 'Lower material cost.', 'Higher material cost — compare to output.');
  an.addRow({}); an.addRow({ k:'REJECTIONS BY STAGE (worst first — fix the top one)' });
  an.addRow({ k:'Stage', t:'Rejects' });
  Object.entries(cur.stageRejects).sort((a,b)=>b[1]-a[1]).forEach(([s,nn]) => an.addRow({ k:`${s} · ${RPT_STAGES[s]||''}`, t:nn }));
  an.addRow({}); an.addRow({ k:'WORKERS (this month)' });
  an.addRow({ k:'Worker', t:'Items', l:'Rejects' });
  Object.entries(cur.workers).sort((a,b)=>b[1].items.size-a[1].items.size).forEach(([w,x]) => an.addRow({ k:w, t:x.items.size, l:x.rejects }));
  styleHeader(an);
  an.getColumn('i').alignment = { wrapText:true, vertical:'top' };
  // colour the Change column by improvement
  an.eachRow((row) => { const i = row.getCell('i').value; if (typeof i==='string' && i.startsWith('✅')) row.getCell('c').fill = FILL(GREEN); else if (typeof i==='string' && i.startsWith('⚠️')) row.getCell('c').fill = FILL(RED); });

  // ── Sheet 3: Item Detail (filters + conditional formatting) ──
  const it = wb.addWorksheet('Item Detail');
  it.columns = [
    { header:'Job Card', key:'jc', width:22 }, { header:'Order', key:'order', width:13 }, { header:'Customer', key:'customer', width:10 },
    { header:'Product Code', key:'product', width:16 }, { header:'Drawing', key:'drawing', width:20 }, { header:'Type', key:'type', width:11 },
    { header:'Qty', key:'qty', width:6 }, { header:'Net Qty', key:'netQty', width:8 },
    { header:'V', key:'voltage', width:6 }, { header:'W', key:'wattage', width:7 },
    { header:'Designed Ω', key:'ohmsDes', width:11 }, { header:'Actual Ω', key:'ohmsAct', width:10 },
    { header:'Ω Dev %', key:'ohmsDev', width:9 }, { header:'Ω ±5%', key:'ohmsFlag', width:8 },
    { header:'Megger', key:'megger', width:12 }, { header:'Draw Len (St.8)', key:'drawLen', width:13 }, { header:'Tube Cut (St.5)', key:'tubeCut', width:13 },
    { header:'Spring Gauge', key:'gauge', width:13 },
    { header:'Rejects', key:'rejects', width:8 }, { header:'Remakes', key:'remakes', width:8 },
    { header:'Tube Used', key:'tubeUsed', width:10 }, { header:'Tube Scrap', key:'tubeScrap', width:10 },
    { header:'Wire Used', key:'wireUsed', width:10 }, { header:'Wire Scrap', key:'wireScrap', width:10 }, { header:'Material ₹', key:'matVal', width:11 },
    { header:'Produced', key:'produced', width:12 }, { header:'Due', key:'due', width:12 }, { header:'Dispatched', key:'dispatched', width:12 },
    { header:'Days to Dispatch', key:'daysToDispatch', width:14 }, { header:'On-Time', key:'onTime', width:9 }, { header:'Days Late', key:'lateDays', width:9 },
    { header:'Cycle Days', key:'cycleDays', width:10 }, { header:'Delay / Hold Reason', key:'delay', width:44 }, { header:'Workers', key:'workers', width:22 },
  ];
  it.addRows(cur.rows.length ? cur.rows : [{ jc:`No production completed in ${month}` }]);
  styleHeader(it);
  const last = Math.max(it.rowCount, 2);
  it.autoFilter = { from:{ row:1, column:1 }, to:{ row:1, column:it.columnCount } };
  const col = (k) => it.getColumn(k).letter;
  const cf = (k, rules) => it.addConditionalFormatting({ ref:`${col(k)}2:${col(k)}${last}`, rules });
  cf('ohmsFlag', [
    { type:'containsText', operator:'containsText', text:'OUT', style:{ fill:FILL(RED) }, priority:1 },
    { type:'containsText', operator:'containsText', text:'OK',  style:{ fill:FILL(GREEN) }, priority:2 },
  ]);
  cf('onTime', [
    { type:'containsText', operator:'containsText', text:'No',      style:{ fill:FILL(RED) }, priority:1 },
    { type:'containsText', operator:'containsText', text:'Yes',     style:{ fill:FILL(GREEN) }, priority:2 },
    { type:'containsText', operator:'containsText', text:'Pending', style:{ fill:FILL(AMBER) }, priority:3 },
  ]);
  cf('rejects',  [{ type:'cellIs', operator:'greaterThan', formulae:['0'], style:{ fill:FILL(AMBER) }, priority:1 }]);
  cf('lateDays', [{ type:'cellIs', operator:'greaterThan', formulae:['0'], style:{ fill:FILL(RED) }, priority:1 }]);
  cf('ohmsDev',  [{ type:'colorScale', cfvo:[{type:'num',value:-5},{type:'num',value:0},{type:'num',value:5}],
                    color:[{argb:'FFF8696B'},{argb:'FF63BE7B'},{argb:'FFF8696B'}], priority:1 }]);

  // ── Sheet 4: Late Items & Reasons ──
  const late = wb.addWorksheet('Late Items & Reasons');
  late.columns = [{ header:'Job Card', key:'jc', width:22 }, { header:'Order', key:'order', width:13 }, { header:'Product Code', key:'product', width:16 },
    { header:'Due', key:'due', width:12 }, { header:'Dispatched', key:'dispatched', width:12 }, { header:'Days Late', key:'lateDays', width:9 },
    { header:'On-Time', key:'onTime', width:9 }, { header:'Reason for Delay / Hold', key:'delay', width:60 }];
  const lateRows = cur.rows.filter(r => r.delay);
  late.addRows(lateRows.length ? lateRows : [{ jc:'None — everything shipped on time 🎉' }]);
  styleHeader(late);
  if (lateRows.length) late.autoFilter = { from:{ row:1, column:1 }, to:{ row:1, column:late.columnCount } };
  late.getColumn('delay').alignment = { wrapText:true, vertical:'top' };

  // ── Sheet 5: Days to Dispatch by Product ──
  const byp = wb.addWorksheet('Days to Dispatch by Product');
  byp.columns = [{ header:'Product Code', key:'product', width:18 }, { header:'Items', key:'items', width:8 },
    { header:'Avg Days', key:'avg', width:10 }, { header:'Min', key:'min', width:8 }, { header:'Max', key:'max', width:8 }, { header:'Total Qty', key:'qty', width:10 }];
  const pgroups = {};
  cur.rows.forEach(r => { const k = r.product || r.drawing || '—'; (pgroups[k] ||= []).push(r); });
  Object.entries(pgroups).map(([k, rs]) => {
    const dd = rs.map(r => r.daysToDispatch).filter(v => v!=='' && v!=null).map(Number);
    return { product:k, items:rs.length, avg: dd.length ? round(dd.reduce((s,v)=>s+v,0)/dd.length,1) : '',
      min: dd.length ? Math.min(...dd) : '', max: dd.length ? Math.max(...dd) : '',
      qty: rs.reduce((s,r)=>s+num(r.qty),0), _sort: dd.length ? Math.max(...dd) : -1 };
  }).sort((a,b)=>b._sort-a._sort).forEach(r => byp.addRow(r));
  styleHeader(byp);
  if (byp.rowCount>1) {
    byp.autoFilter = { from:{ row:1, column:1 }, to:{ row:1, column:byp.columnCount } };
    byp.addConditionalFormatting({ ref:`C2:C${byp.rowCount}`,
      rules:[{ type:'colorScale', cfvo:[{type:'min'},{type:'percentile',value:50},{type:'max'}],
               color:[{argb:'FF63BE7B'},{argb:'FFFFEB84'},{argb:'FFF8696B'}], priority:1 }] });
  }

  // ── Sheet 6: Finished-Goods Candidates ──
  const fgs = wb.addWorksheet('Finished-Goods Candidates');
  fgs.columns = [{ header:'Job Card / Drawing (FG group)', key:'p', width:30 }, { header:'Times Made (12 mo)', key:'count', width:16 },
    { header:'Months Made', key:'months', width:12 }, { header:'Customers', key:'cust', width:10 }, { header:'Total Qty', key:'qty', width:10 },
    { header:'Recommendation', key:'rec', width:20 }, { header:'Why', key:'why', width:56 }];
  fgs.addRow({ p:'Grouped by job-card/drawing name (same as your Finished Goods inventory), not product code. Job cards you make repeatedly are the safest to keep as ready finished-goods stock (ship instantly, smooth production). One-offs should stay make-to-order.' });
  Object.entries(fg).map(([k, v]) => {
    const custs = v.customers.size; let rec, why;
    if (v.months >= 3 || (v.count >= 3 && custs >= 2)) { rec = '✅ Stock it'; why = 'Made often across several months/customers — steady, predictable demand.'; }
    else if (v.months >= 2 || v.count >= 2) { rec = '🟡 Consider'; why = 'Made more than once — some recurring demand; stock a small buffer.'; }
    else { rec = 'Make-to-order'; why = 'Made only once — no repeat demand yet; do not stock.'; }
    return { p:k, count:v.count, months:v.months, cust:custs, qty:v.qty, rec, why, _s:v.count };
  }).sort((a,b)=>b._s-a._s).forEach(r => fgs.addRow(r));
  styleHeader(fgs); fgs.spliceRows(1, 0); // keep header at row1 (note pushed to row2)
  fgs.mergeCells(2, 1, 2, 7); fgs.getCell('A2').alignment = { wrapText:true }; fgs.getCell('A2').font = { italic:true, color:{ argb:'FF666666' } };
  if (fgs.rowCount>2) fgs.autoFilter = { from:{ row:1, column:1 }, to:{ row:1, column:fgs.columnCount } };

  // ── Sheet 7: 12-Month Trend ──
  const tr = wb.addWorksheet('12-Month Trend');
  tr.columns = [{ header:'Month', key:'month', width:10 }, { header:'Items', key:'items', width:8 }, { header:'Qty', key:'qty', width:8 },
    { header:'Reject %', key:'rejectRate', width:10 }, { header:'First-Pass %', key:'firstPass', width:12 }, { header:'On-Time %', key:'onTime', width:10 },
    { header:'Scrap Tube (ft)', key:'scrapTube', width:13 }, { header:'Scrap Wire (kg)', key:'scrapWire', width:13 },
    { header:'Avg |Ω Dev| %', key:'avgOhmsDev', width:12 }, { header:'Ω Out-of-Spec', key:'outSpec', width:12 },
    { header:'Avg Days→Dispatch', key:'avgDaysToDispatch', width:15 }, { header:'Material ₹', key:'matCost', width:11 }];
  trend.forEach(r => tr.addRow(r));
  styleHeader(tr); tr.autoFilter = { from:{ row:1, column:1 }, to:{ row:1, column:tr.columnCount } };

  return await wb.xlsx.writeBuffer();
}

module.exports = { generate };
