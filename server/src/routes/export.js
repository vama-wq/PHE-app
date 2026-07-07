const router = require('express').Router();
const XLSX = require('xlsx');
const { getDB } = require('../db');
const { authenticate, authorize, withCustomerVisibility } = require('../middleware/auth');

const STAGE_NAMES = {
  1:'Coil',2:'Coil + Tube Cutting',3:'Ohms',4:'Spot',5:'Tube Cutting',
  6:'Filling',7:'HV + Light Check (1)',8:'Draw',9:'HV + Light Check (2)',
  10:'Straightening',11:'Trimming',12:'Spot Annealing or Furnace Annealing',
  13:'Buffing',14:'Bending',15:'In Plating',16:'Plating Completed',
  17:'Kharoch Process',18:'Overnight Oven',19:'HV + Light Check (3)',
  20:'Nipple Press',21:'3 Hours Oven',22:'Sealing',23:'HV + Light Check (4)',
  24:'Cleaning',25:'Nut Washer',26:'HV + Light Check (5)',
  27:'Ohms + Meggar',28:'Quality Check',29:'Dispatch',
};

function sendXlsx(res, workbook, filename) {
  const buf = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
}

function autoWidth(ws) {
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  const widths = [];
  for (let C = range.s.c; C <= range.e.c; C++) {
    let max = 10;
    for (let R = range.s.r; R <= range.e.r; R++) {
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
      if (cell && cell.v != null) {
        const len = String(cell.v).length;
        if (len > max) max = len;
      }
    }
    widths.push({ wch: Math.min(max + 2, 50) });
  }
  ws['!cols'] = widths;
}

// ── Orders ────────────────────────────────────────────────────────────────────
router.get('/orders', authenticate, authorize('owner', 'admin', 'accounts'), async (req, res) => {
  const canSeeNames = withCustomerVisibility(req);
  const rows = await getDB().all(`
    SELECT o.order_code, c.customer_code, ${canSeeNames ? "c.name as customer_name," : ''}
      o.order_date, o.dispatch_date, o.status, o.notes,
      u.name as created_by, o.created_at
    FROM orders o
    JOIN customers c ON o.customer_id = c.id
    LEFT JOIN users u ON o.created_by = u.id
    ORDER BY o.created_at DESC
  `);

  const data = rows.map(r => ({
    'Order Code':    r.order_code,
    'Customer Code': r.customer_code,
    ...(canSeeNames ? { 'Customer Name': r.customer_name || '' } : {}),
    'Order Date':    r.order_date || '',
    'Dispatch Date': r.dispatch_date || '',
    'Status':        r.status,
    'Notes':         r.notes || '',
    'Created By':    r.created_by || '',
    'Created At':    r.created_at || '',
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  autoWidth(ws);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Orders');
  sendXlsx(res, wb, `orders_${Date.now()}.xlsx`);
});

// ── Job Cards ─────────────────────────────────────────────────────────────────
router.get('/job-cards', authenticate, authorize('owner', 'admin', 'accounts', 'production'), async (req, res) => {
  const rows = await getDB().all(`
    SELECT jc.job_card_no, o.order_code, c.customer_code,
      jc.qty, jc.dispatch_date, jc.status, jc.current_stage,
      u.name as uploaded_by, jc.created_at
    FROM job_cards jc
    JOIN orders o ON jc.order_id = o.id
    JOIN customers c ON o.customer_id = c.id
    LEFT JOIN users u ON jc.uploaded_by = u.id
    ORDER BY jc.dispatch_date ASC
  `);

  const data = rows.map(r => ({
    'Job Card No':   r.job_card_no,
    'Order Code':    r.order_code,
    'Customer':      r.customer_code,
    'Qty':           r.qty ?? '',
    'Dispatch Date': r.dispatch_date || '',
    'Status':        r.status,
    'Current Stage': r.current_stage > 0 ? `Stage ${r.current_stage}: ${STAGE_NAMES[r.current_stage] || ''}` : '',
    'Uploaded By':   r.uploaded_by || '',
    'Created At':    r.created_at || '',
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  autoWidth(ws);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Job Cards');
  sendXlsx(res, wb, `job_cards_${Date.now()}.xlsx`);
});

// ── Inventory ─────────────────────────────────────────────────────────────────
router.get('/inventory', authenticate, authorize('owner', 'admin', 'accounts'), async (req, res) => {
  const rows = await getDB().all(`
    SELECT item_code, name, category, unit, current_stock, reorder_level, min_order_qty, unit_cost, notes
    FROM inventory_items ORDER BY category, item_code
  `);

  const data = rows.map(r => ({
    'Item Code':      r.item_code,
    'Name':           r.name,
    'Category':       r.category || '',
    'Unit':           r.unit,
    'Current Stock':  r.current_stock,
    'Reorder Level':  r.reorder_level,
    'Min Order Qty':  r.min_order_qty || 0,
    'Unit Cost':      r.unit_cost || 0,
    'Status':         r.current_stock <= r.reorder_level ? 'LOW STOCK' : 'OK',
    'Notes':          r.notes || '',
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  autoWidth(ws);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Inventory');
  sendXlsx(res, wb, `inventory_${Date.now()}.xlsx`);
});

// ── Customers ─────────────────────────────────────────────────────────────────
router.get('/customers', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const rows = await getDB().all(`
    SELECT customer_code, name, contact_person, phone, email, address, notes, created_at
    FROM customers ORDER BY customer_code
  `);

  const data = rows.map(r => ({
    'Customer Code':  r.customer_code,
    'Name':           r.name,
    'Contact Person': r.contact_person || '',
    'Phone':          r.phone || '',
    'Email':          r.email || '',
    'Address':        r.address || '',
    'Notes':          r.notes || '',
    'Created At':     r.created_at || '',
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  autoWidth(ws);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Customers');
  sendXlsx(res, wb, `customers_${Date.now()}.xlsx`);
});

// ── Production Checklist ──────────────────────────────────────────────────────
router.get('/production-checklist', authenticate, authorize('owner', 'admin', 'production'), async (req, res) => {
  const rows = await getDB().all(`
    SELECT jc.job_card_no, o.order_code, c.customer_code,
      pc.stage_no, pc.done,
      pc.value1, pc.value2,
      pc.rejection_qty, pc.remade_qty,
      pc.done_at, u.name as updated_by
    FROM production_checklist pc
    JOIN job_cards jc ON pc.job_card_id = jc.id
    JOIN orders o ON jc.order_id = o.id
    JOIN customers c ON o.customer_id = c.id
    LEFT JOIN users u ON pc.updated_by = u.id
    WHERE pc.done = 1
    ORDER BY jc.job_card_no, pc.stage_no
  `);

  const data = rows.map(r => ({
    'Job Card No':   r.job_card_no,
    'Order Code':    r.order_code,
    'Customer':      r.customer_code,
    'Stage No':      r.stage_no,
    'Stage Name':    STAGE_NAMES[r.stage_no] || '',
    'Done':          r.done ? 'Yes' : 'No',
    'Value 1':       r.value1 || '',
    'Value 2':       r.value2 || '',
    'Rejection Qty': r.rejection_qty || 0,
    'Remade Qty':    r.remade_qty || 0,
    'Completed At':  r.done_at || '',
    'Updated By':    r.updated_by || '',
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  autoWidth(ws);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Production Checklist');
  sendXlsx(res, wb, `production_checklist_${Date.now()}.xlsx`);
});

// ── Rejections ────────────────────────────────────────────────────────────────
router.get('/rejections', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const rows = await getDB().all(`
    SELECT jc.job_card_no, o.order_code, c.customer_code,
      pc.stage_no, pc.rejection_qty, pc.remade_qty,
      pc.done_at,
      jc.status as card_status,
      jch.status as hold_status, jch.approved_at,
      ua.name as approved_by
    FROM production_checklist pc
    JOIN job_cards jc ON pc.job_card_id = jc.id
    JOIN orders o ON jc.order_id = o.id
    JOIN customers c ON o.customer_id = c.id
    LEFT JOIN job_card_holds jch ON jch.job_card_id = pc.job_card_id AND jch.stage_no = pc.stage_no
    LEFT JOIN users ua ON jch.approved_by = ua.id
    WHERE pc.rejection_qty > 0
    ORDER BY (pc.rejection_qty > 2) DESC, pc.rejection_qty DESC
  `);

  const data = rows.map(r => ({
    'Job Card No':    r.job_card_no,
    'Order Code':     r.order_code,
    'Customer':       r.customer_code,
    'Stage No':       r.stage_no,
    'Stage Name':     STAGE_NAMES[r.stage_no] || '',
    'Rejection Qty':  r.rejection_qty,
    'Remade Qty':     r.remade_qty || 0,
    'Critical':       r.rejection_qty > 2 ? 'YES' : 'No',
    'Card Status':    r.card_status,
    'Hold Status':    r.hold_status || '',
    'Approved By':    r.approved_by || '',
    'Approved At':    r.approved_at || '',
    'Stage Done At':  r.done_at || '',
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  autoWidth(ws);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Rejections');
  sendXlsx(res, wb, `rejections_${Date.now()}.xlsx`);
});

// ── Dispatch Checklist ────────────────────────────────────────────────────────
router.get('/dispatch-checklist', authenticate, authorize('owner', 'admin', 'accounts', 'production'), async (req, res) => {
  const db = getDB();
  const canSeeNames = withCustomerVisibility(req);

  // Get all dispatched (or qc_approved/packaging) job cards
  const cards = await db.all(`
    SELECT jc.id, jc.job_card_no, jc.drawing_no, jc.product_name,
      jc.qty, jc.dispatch_date, jc.status,
      o.order_code, o.order_type,
      c.customer_code, ${canSeeNames ? "c.name as customer_name," : ''}
      GREATEST(
        jc.qty
          - COALESCE((SELECT SUM(rejection_qty) FROM production_checklist WHERE job_card_id = jc.id), 0)
          + COALESCE((SELECT SUM(CASE WHEN stage_no != 29 THEN remade_qty ELSE 0 END) FROM production_checklist WHERE job_card_id = jc.id), 0),
        0
      ) as net_qty,
      (SELECT dispatched_qty FROM production_checklist WHERE job_card_id = jc.id AND stage_no = 29 LIMIT 1) as dispatched_qty
    FROM job_cards jc
    JOIN orders o ON jc.order_id = o.id
    JOIN customers c ON o.customer_id = c.id
    WHERE jc.status IN ('qc_approved','packaging','dispatched')
    ORDER BY jc.dispatch_date ASC, jc.job_card_no
  `);

  // Get all checklist stages for these cards
  const cardIds = cards.map(c => c.id);
  if (cardIds.length === 0) {
    const ws = XLSX.utils.json_to_sheet([{ Message: 'No dispatched job cards found' }]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Dispatch Checklist');
    return sendXlsx(res, wb, `dispatch_checklist_${Date.now()}.xlsx`);
  }

  const placeholders = cardIds.map((_, i) => `$${i + 1}`).join(',');
  const stages = await db.all(`
    SELECT pc.job_card_id, pc.stage_no, pc.done, pc.value1, pc.value2,
      pc.rejection_qty, pc.remade_qty, pc.worker_name, pc.scrap_value,
      pc.dispatched_qty as stage_dispatched_qty, pc.done_at,
      u.name as updated_by
    FROM production_checklist pc
    LEFT JOIN users u ON pc.updated_by = u.id
    WHERE pc.job_card_id IN (${placeholders})
    ORDER BY pc.job_card_id, pc.stage_no
  `, cardIds);

  // Build stage lookup: { jobCardId -> { stageNo -> stageData } }
  const stageMap = {};
  for (const s of stages) {
    if (!stageMap[s.job_card_id]) stageMap[s.job_card_id] = {};
    stageMap[s.job_card_id][s.stage_no] = s;
  }

  const STAGE_NOS_LIST = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29];

  // Sheet 1: Summary per job card
  const summaryData = cards.map(jc => ({
    'Job Card No':      jc.job_card_no,
    'Order Code':       jc.order_code,
    'Order Type':       jc.order_type || '',
    'Customer Code':    jc.customer_code,
    ...(canSeeNames ? { 'Customer Name': jc.customer_name || '' } : {}),
    'Drawing No':       jc.drawing_no || '',
    'Product Name':     jc.product_name || '',
    'Original Qty':     jc.qty ?? '',
    'Net Qty':          jc.net_qty ?? '',
    'Dispatched Qty':   jc.dispatched_qty ?? '',
    'Dispatch Date':    jc.dispatch_date || '',
    'Status':           jc.status,
    'Stages Completed': Object.values(stageMap[jc.id] || {}).filter(s => s.done).length,
    'Total Rejected':   Object.values(stageMap[jc.id] || {}).reduce((a, s) => a + (parseInt(s.rejection_qty, 10) || 0), 0),
    'Total Remade':     Object.values(stageMap[jc.id] || {}).reduce((a, s) => a + (parseInt(s.remade_qty, 10) || 0), 0),
  }));

  const wsSummary = XLSX.utils.json_to_sheet(summaryData);
  autoWidth(wsSummary);

  // Sheet 2: Full stage-by-stage detail
  const detailData = [];
  for (const jc of cards) {
    const cardStages = stageMap[jc.id] || {};
    for (const stageNo of STAGE_NOS_LIST) {
      const s = cardStages[stageNo];
      if (!s) continue;
      detailData.push({
        'Job Card No':    jc.job_card_no,
        'Order Code':     jc.order_code,
        'Customer Code':  jc.customer_code,
        'Drawing No':     jc.drawing_no || '',
        'Stage No':       stageNo,
        'Stage Name':     STAGE_NAMES[stageNo] || `Stage ${stageNo}`,
        'Done':           s.done ? 'Yes' : 'No',
        'Worker Name':    s.worker_name || '',
        'Value 1':        s.value1 || '',
        'Value 2':        s.value2 || '',
        'Rejection Qty':  s.rejection_qty || 0,
        'Remade Qty':     s.remade_qty || 0,
        'Scrap Value':    s.scrap_value || '',
        'Dispatched Qty': stageNo === 29 ? (s.stage_dispatched_qty ?? '') : '',
        'Completed At':   s.done_at || '',
        'Updated By':     s.updated_by || '',
      });
    }
  }

  const wsDetail = XLSX.utils.json_to_sheet(detailData);
  autoWidth(wsDetail);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');
  XLSX.utils.book_append_sheet(wb, wsDetail, 'Stage Detail');
  sendXlsx(res, wb, `dispatch_checklist_${Date.now()}.xlsx`);
});

// ── QC Reports ────────────────────────────────────────────────────────────────
router.get('/qc-reports', authenticate, authorize('owner', 'admin', 'design'), async (req, res) => {
  const rows = await getDB().all(`
    SELECT jc.job_card_no, o.order_code, c.customer_code,
      qr.result, qr.observations, qr.corrective_action, qr.product_weight,
      qr.file_name, u.name as created_by, qr.created_at
    FROM qc_reports qr
    JOIN job_cards jc ON qr.job_card_id = jc.id
    JOIN orders o ON jc.order_id = o.id
    JOIN customers c ON o.customer_id = c.id
    LEFT JOIN users u ON qr.created_by = u.id
    ORDER BY qr.created_at DESC
  `);

  const data = rows.map(r => ({
    'Job Card No':       r.job_card_no,
    'Order Code':        r.order_code,
    'Customer':          r.customer_code,
    'Result':            r.result,
    'Observations':      r.observations || '',
    'Corrective Action': r.corrective_action || '',
    'Product Weight':    r.product_weight || '',
    'Report File':       r.file_name || '',
    'Created By':        r.created_by || '',
    'Created At':        r.created_at || '',
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  autoWidth(ws);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'QC Reports');
  sendXlsx(res, wb, `qc_reports_${Date.now()}.xlsx`);
});

// ── Monthly Production Report (multi-sheet: Item Detail · Analysis · 12-Mo Trend) ──
// Correct stage numbers (the STAGE_NAMES map above is legacy/misaligned).
const RPT_STAGES = {
  1:'Coil',2:'Coil + Tube Cutting',3:'Ohms',4:'Spot',5:'Tube Cutting',6:'Filling',
  7:'HV + Light (1)',8:'Draw',9:'HV + Light (2)',10:'Straightening',11:'Trimming',
  12:'Annealing',13:'Buffing',14:'Bending',15:'Brazing',16:'In Plating',17:'Plating Completed',
  18:'Heater Cleaning',19:'Overnight Oven',20:'HV + Light (3)',21:'Nipple Press',22:'3 Hours Oven',
  23:'Sealing',24:'HV + Light (4)',25:'Cleaning',26:'Nut Washer',27:'HV + Light (5)',
  28:'Megger',29:'Ready in Production',30:'Kharoch Process',
};
const rptRound = (x, n=2) => (x==null || isNaN(x)) ? null : Math.round(x * 10**n) / 10**n;
const rptOhms = (v1) => { try { const dd = JSON.parse(v1); const o = parseFloat(dd?.ohms); return isNaN(o) ? null : o; } catch { return null; } };
const rptDate = (dt) => dt ? new Date(dt).toISOString().slice(0,10) : '';

async function rptBuildMonth(db, startISO, endISO) {
  const cards = await db.all(`
    SELECT jc.id, jc.job_card_no, jc.qty, jc.dispatch_date, jc.drawing_no, jc.product_name, jc.created_at,
           jc.tube_used_qty, jc.tube_scrap_qty, jc.coil_used_qty, jc.coil_scrap_qty,
           o.order_code, o.order_type, c.customer_code,
           oi.voltage, oi.wattage, oi.tube_material,
           s29.done_at AS produced_at
    FROM job_cards jc
    JOIN production_checklist s29 ON s29.job_card_id = jc.id AND s29.stage_no = 29 AND s29.done = 1
    JOIN orders o ON o.id = jc.order_id
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN order_items oi ON oi.id = jc.order_item_id
    WHERE s29.done_at::timestamptz >= $1::timestamptz AND s29.done_at::timestamptz < $2::timestamptz
    ORDER BY s29.done_at`, [startISO, endISO]);
  if (!cards.length) return { rows: [], stageRejects: {}, workers: {} };
  const ids = cards.map(c => c.id);
  const cl = await db.all(
    `SELECT job_card_id, stage_no, value1, worker_name, rejection_qty, remade_qty
     FROM production_checklist WHERE job_card_id = ANY($1)`, [ids]);
  const disp = await db.all(
    `SELECT job_card_id, MAX(dispatch_date) AS dispatched_at FROM dispatch_documents
     WHERE job_card_id = ANY($1) GROUP BY job_card_id`, [ids]);
  const dispMap = {}; disp.forEach(x => dispMap[x.job_card_id] = x.dispatched_at);
  const invCost = {};
  (await db.all(`SELECT upper(item_code) code, unit_cost FROM inventory_items
                 WHERE lower(trim(category)) IN ('tube','spring guage')`))
    .forEach(i => invCost[i.code] = Number(i.unit_cost) || 0);
  const byCard = {}; cl.forEach(r => (byCard[r.job_card_id] ||= []).push(r));

  const stageRejects = {}, workers = {};
  const rows = cards.map(c => {
    const cs = byCard[c.id] || [];
    const stg = n => cs.find(r => r.stage_no === n);
    let rejects = 0, remades = 0; const wset = new Set();
    cs.forEach(r => {
      const rq = parseInt(r.rejection_qty,10)||0;
      rejects += rq;
      if (r.stage_no !== 29) remades += parseInt(r.remade_qty,10)||0;
      if (rq > 0) stageRejects[r.stage_no] = (stageRejects[r.stage_no]||0) + rq;
      if (r.worker_name && r.worker_name.trim()) {
        const w = r.worker_name.trim(); wset.add(w);
        (workers[w] ||= { items: new Set(), rejects: 0 });
        workers[w].items.add(c.id); workers[w].rejects += rq;
      }
    });
    const designed = (c.voltage && c.wattage) ? rptRound(c.voltage*c.voltage/c.wattage) : null;
    const actual = rptOhms(stg(27)?.value1);
    const dev = (designed && actual) ? rptRound((actual-designed)/designed*100, 1) : null;
    const gaugeCode = (stg(1)?.value1 || '').toUpperCase();
    const matVal = rptRound(
      ((Number(c.tube_used_qty)||0)+(Number(c.tube_scrap_qty)||0)) * (invCost[(c.tube_material||'').toUpperCase()]||0) +
      ((Number(c.coil_used_qty)||0)+(Number(c.coil_scrap_qty)||0)) * (invCost[gaugeCode]||0));
    const dispatchedAt = dispMap[c.id] || null;
    const onTime = dispatchedAt ? (new Date(dispatchedAt) <= new Date(c.dispatch_date) ? 'Yes' : 'No') : 'Pending';
    return {
      'Job Card': c.job_card_no, 'Order': c.order_code, 'Customer': c.customer_code,
      'Drawing / Product': c.drawing_no || c.product_name || '', 'Type': c.order_type,
      'Qty': c.qty, 'Net Qty': Math.max((c.qty||0)-rejects+remades, 0),
      'Voltage': c.voltage||'', 'Wattage': c.wattage||'',
      'Designed Ω (V²/W)': designed ?? '', 'Actual Ω (St.27)': actual ?? '',
      'Ω Dev %': dev ?? '', 'Ω ±5%': dev==null ? '' : (Math.abs(dev)>5 ? 'OUT' : 'OK'),
      'Megger (St.28)': stg(28)?.value1 || '',
      'Draw Length (St.8)': stg(8)?.value1 || '', 'Tube Cut (St.5)': stg(5)?.value1 || '',
      'Rejects': rejects, 'Remakes': remades,
      'Tube Used (ft)': c.tube_used_qty ?? '', 'Tube Scrap (ft)': c.tube_scrap_qty ?? '',
      'Wire Used (kg)': c.coil_used_qty ?? '', 'Wire Scrap (kg)': c.coil_scrap_qty ?? '',
      'Material ₹': matVal ?? '',
      'Produced': rptDate(c.produced_at), 'Due': c.dispatch_date || '',
      'Dispatched': rptDate(dispatchedAt), 'On-Time': onTime,
      'Cycle Days': (c.produced_at && c.created_at) ? Math.round((new Date(c.produced_at)-new Date(c.created_at))/864e5) : '',
      'Workers': [...wset].join(', '),
    };
  });
  return { rows, stageRejects, workers };
}

function rptSummary(rows) {
  const n = rows.length, num = (r,k) => Number(r[k]) || 0;
  const qty = rows.reduce((s,r)=>s+num(r,'Qty'),0);
  const rejects = rows.reduce((s,r)=>s+num(r,'Rejects'),0);
  const firstPass = rows.filter(r=>num(r,'Rejects')===0).length;
  const dispatched = rows.filter(r=>r['On-Time']!=='Pending');
  const ontime = dispatched.filter(r=>r['On-Time']==='Yes').length;
  const devs = rows.map(r=>r['Ω Dev %']).filter(v=>v!=='' && v!=null).map(Number);
  const cyc = rows.map(r=>r['Cycle Days']).filter(v=>v!=='' && v!=null).map(Number);
  return {
    items:n, qty, netQty: rows.reduce((s,r)=>s+num(r,'Net Qty'),0),
    rejects, remades: rows.reduce((s,r)=>s+num(r,'Remakes'),0),
    rejectRatePct: qty ? rptRound(rejects/qty*100,1) : 0,
    firstPassYieldPct: n ? rptRound(firstPass/n*100,1) : 0,
    onTimePct: dispatched.length ? rptRound(ontime/dispatched.length*100,1) : 0,
    dispatchedCount: dispatched.length,
    scrapTubeFt: rptRound(rows.reduce((s,r)=>s+num(r,'Tube Scrap (ft)'),0)),
    scrapWireKg: rptRound(rows.reduce((s,r)=>s+num(r,'Wire Scrap (kg)'),0),3),
    materialCost: rptRound(rows.reduce((s,r)=>s+num(r,'Material ₹'),0)),
    avgAbsOhmsDev: devs.length ? rptRound(devs.reduce((s,v)=>s+Math.abs(v),0)/devs.length,1) : null,
    ohmsOutOfSpec: rows.filter(r=>r['Ω ±5%']==='OUT').length,
    avgCycleDays: cyc.length ? rptRound(cyc.reduce((s,v)=>s+v,0)/cyc.length,1) : null,
  };
}

router.get('/monthly-production', authenticate, authorize('owner','admin','accounts'), async (req, res) => {
  const db = getDB();
  const month = /^\d{4}-\d{2}$/.test(req.query.month||'') ? req.query.month : new Date().toISOString().slice(0,7);
  const [y,m] = month.split('-').map(Number);
  const mStart = (yy,mm) => new Date(Date.UTC(yy, mm, 1)).toISOString();
  const cur  = await rptBuildMonth(db, mStart(y, m-1), mStart(y, m));
  const prev = await rptBuildMonth(db, mStart(y, m-2), mStart(y, m-1));
  const curS = rptSummary(cur.rows), prevS = rptSummary(prev.rows);

  const trend = [];
  for (let i = 11; i >= 0; i--) {
    const su = rptSummary((await rptBuildMonth(db, mStart(y, m-1-i), mStart(y, m-i))).rows);
    trend.push({ 'Month': mStart(y, m-1-i).slice(0,7), 'Items': su.items, 'Qty': su.qty, 'Reject %': su.rejectRatePct,
      'First-Pass %': su.firstPassYieldPct, 'On-Time %': su.onTimePct, 'Scrap Tube (ft)': su.scrapTubeFt,
      'Scrap Wire (kg)': su.scrapWireKg, 'Avg |Ω Dev| %': su.avgAbsOhmsDev ?? '', 'Ω Out-of-Spec': su.ohmsOutOfSpec,
      'Avg Cycle Days': su.avgCycleDays ?? '', 'Material ₹': su.materialCost });
  }

  const d = (a,b) => (a==null||b==null||a===''||b==='') ? '' : rptRound(a-b,1);
  const A = [
    [`Monthly Production Report — ${month}`],
    ['Basis: job cards whose production completed (Stage 29) in the month.'],
    [], ['KPI', 'This Month', 'Last Month', 'Change'],
    ['Items produced', curS.items, prevS.items, d(curS.items, prevS.items)],
    ['Units (qty)', curS.qty, prevS.qty, d(curS.qty, prevS.qty)],
    ['Net units', curS.netQty, prevS.netQty, d(curS.netQty, prevS.netQty)],
    [], ['— QUALITY —'],
    ['Rejections', curS.rejects, prevS.rejects, d(curS.rejects, prevS.rejects)],
    ['Reject rate %', curS.rejectRatePct, prevS.rejectRatePct, d(curS.rejectRatePct, prevS.rejectRatePct)],
    ['Remakes', curS.remades, prevS.remades, d(curS.remades, prevS.remades)],
    ['First-pass yield %', curS.firstPassYieldPct, prevS.firstPassYieldPct, d(curS.firstPassYieldPct, prevS.firstPassYieldPct)],
    ['Avg |Ω deviation| %', curS.avgAbsOhmsDev ?? '', prevS.avgAbsOhmsDev ?? '', d(curS.avgAbsOhmsDev, prevS.avgAbsOhmsDev)],
    ['Ω out-of-spec (>±5%)', curS.ohmsOutOfSpec, prevS.ohmsOutOfSpec, d(curS.ohmsOutOfSpec, prevS.ohmsOutOfSpec)],
    [], ['— ON-TIME DELIVERY —'],
    ['On-time dispatch %', curS.onTimePct, prevS.onTimePct, d(curS.onTimePct, prevS.onTimePct)],
    ['Dispatched count', curS.dispatchedCount, prevS.dispatchedCount, d(curS.dispatchedCount, prevS.dispatchedCount)],
    ['Avg cycle days', curS.avgCycleDays ?? '', prevS.avgCycleDays ?? '', d(curS.avgCycleDays, prevS.avgCycleDays)],
    [], ['— MATERIAL & COST —'],
    ['Tube scrap (ft)', curS.scrapTubeFt, prevS.scrapTubeFt, d(curS.scrapTubeFt, prevS.scrapTubeFt)],
    ['Wire scrap (kg)', curS.scrapWireKg, prevS.scrapWireKg, d(curS.scrapWireKg, prevS.scrapWireKg)],
    ['Material consumed ₹', curS.materialCost, prevS.materialCost, d(curS.materialCost, prevS.materialCost)],
    [], ['— REJECTIONS BY STAGE (this month, worst first) —'], ['Stage', 'Rejects'],
    ...Object.entries(cur.stageRejects).sort((a,b)=>b[1]-a[1]).map(([s,nn])=>[`${s} · ${RPT_STAGES[s]||''}`, nn]),
    [], ['— WORKERS (this month) —'], ['Worker', 'Items', 'Rejects'],
    ...Object.entries(cur.workers).sort((a,b)=>b[1].items.size-a[1].items.size).map(([w,x])=>[w, x.items.size, x.rejects]),
  ];

  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.json_to_sheet(cur.rows.length ? cur.rows : [{ 'Job Card': `No production completed in ${month}` }]);
  autoWidth(ws1); XLSX.utils.book_append_sheet(wb, ws1, 'Item Detail');
  const ws2 = XLSX.utils.aoa_to_sheet(A); autoWidth(ws2); XLSX.utils.book_append_sheet(wb, ws2, 'Monthly Analysis');
  const ws3 = XLSX.utils.json_to_sheet(trend); autoWidth(ws3); XLSX.utils.book_append_sheet(wb, ws3, '12-Month Trend');
  sendXlsx(res, wb, `production_report_${month}.xlsx`);
});

module.exports = router;
