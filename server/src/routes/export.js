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

// ── Monthly Production Report — rich Excel (filters, conditional formatting, guide,
// per-item detail, days-to-dispatch by product, finished-goods suggestions, delay reasons) ──
const monthlyReport = require('../lib/monthlyReport');
router.get('/monthly-production', authenticate, authorize('owner'), async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
  try {
    const buf = await monthlyReport.generate(getDB(), month);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="production_report_${month}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (e) {
    console.error('[monthly-production] failed:', e.message);
    res.status(500).json({ error: 'Failed to generate report: ' + e.message });
  }
});

module.exports = router;
