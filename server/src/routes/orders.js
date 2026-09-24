const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { scaleBomQty, isSuspectLine } = require('../lib/bom');
const { PLATING_INSTRUCTIONS, isValidPlating } = require('../lib/plating');
const { authenticate, authorize, withCustomerVisibility } = require('../middleware/auth');
const { uploadQuotation, uploadOrderDrawing, uploadOrderItemImage, uploadChatAttachments, uploadQC, deleteFromStorage, copyInStorage } = require('../middleware/upload');
const { createNotification } = require('./notifications');
// Inventory consumption is centralised in lib/inventoryDeduction. Deduction is no
// longer tied to drawing approval — it now fires when the item clears QC (single
// job card) or when a partially-dispatched item is fully dispatched (see qc.js /
// dispatch.js). These helpers stay imported for the inventory-edit reconcile path.
const { deductItemInventory, restoreItemInventory, replayDeductions } = require('../lib/inventoryDeduction');

// Which of these inventory ids are Fins? Fins BOM lines carry no qty — they
// deduct by tube length at QC approval (see lib/inventoryDeduction).
async function finsIdSet(db, ids) {
  if (!ids.length) return new Set();
  const rows = await db.all(
    `SELECT id FROM inventory_items WHERE id = ANY($1) AND TRIM(category) ILIKE 'finns'`, [ids]
  );
  return new Set(rows.map(r => r.id));
}

// Every production BOM must include a terminal pin — design can't submit an
// inventory selection without one. (Finished-goods orders are exempt: the
// heater is already built, nothing is consumed.) Which pin depends on the
// item's remark: any variation of "heavy terminal pin" there → the 'Heavy
// Terminal Pin' category is required; otherwise the regular 'Terminal Pin'.
const HEAVY_PIN_REMARK_RE = /heavy[\s\-_.]*terminal[\s\-_.]*pin/i;
const requiredPinCategory = (remark) =>
  HEAVY_PIN_REMARK_RE.test(remark || '') ? 'Heavy Terminal Pin' : 'Terminal Pin';
async function hasPinCategory(db, ids, category) {
  if (!ids.length) return false;
  const row = await db.get(
    `SELECT 1 AS ok FROM inventory_items WHERE id = ANY($1) AND TRIM(category) = $2 LIMIT 1`,
    [ids, category]);
  return !!row;
}

// ── Mentions ──────────────────────────────────────────────────────────────────
router.get('/my-mentions', authenticate, async (req, res) => {
  const db = getDB();
  const orderMentions = await db.all(
    `SELECT mm.id, mm.is_read, mm.created_at,
            om.message, om.user_id as sender_id,
            u.name as sender_name, u.role as sender_role,
            o.id as order_id, o.order_code,
            'order' as source, NULL as query_id, NULL as query_no
     FROM message_mentions mm
     JOIN order_messages om ON om.id = mm.message_id
     JOIN users u ON u.id = om.user_id
     JOIN orders o ON o.id = mm.order_id
     WHERE mm.mentioned_user_id = $1
     ORDER BY mm.created_at DESC
     LIMIT 50`,
    [req.user.id]
  );
  const queryMentions = await db.all(
    `SELECT cqm.id, cqm.is_read, cqm.created_at,
            m.message, m.user_id as sender_id,
            u.name as sender_name, u.role as sender_role,
            NULL as order_id, NULL as order_code,
            'query' as source, cq.id as query_id, cq.query_no
     FROM customer_query_mentions cqm
     JOIN customer_query_messages m ON m.id = cqm.message_id
     JOIN users u ON u.id = m.user_id
     JOIN customer_queries cq ON cq.id = cqm.query_id
     WHERE cqm.mentioned_user_id = $1
     ORDER BY cqm.created_at DESC
     LIMIT 50`,
    [req.user.id]
  );
  const all = [...orderMentions, ...queryMentions]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 50);
  res.json(all);
});

router.put('/my-mentions/:id/read', authenticate, async (req, res) => {
  const { source } = req.query;
  if (source === 'query') {
    await getDB().run(
      'UPDATE customer_query_mentions SET is_read=1 WHERE id=$1 AND mentioned_user_id=$2',
      [req.params.id, req.user.id]
    );
  } else {
    await getDB().run(
      'UPDATE message_mentions SET is_read=1 WHERE id=$1 AND mentioned_user_id=$2',
      [req.params.id, req.user.id]
    );
  }
  res.json({ message: 'Marked as read' });
});

router.put('/my-mentions/read-all', authenticate, async (req, res) => {
  const db = getDB();
  await db.run('UPDATE message_mentions SET is_read=1 WHERE mentioned_user_id=$1', [req.user.id]);
  await db.run('UPDATE customer_query_mentions SET is_read=1 WHERE mentioned_user_id=$1', [req.user.id]);
  res.json({ message: 'All marked as read' });
});

// ── Next order code ───────────────────────────────────────────────────────────
router.get('/next-code', authenticate, async (req, res) => {
  const db = getDB();
  const yy = String(new Date().getFullYear()).slice(-2);
  const prefix = `ORD-`;
  const suffix = `-${yy}`;
  // Find the highest sequence number used this year
  const rows = await db.all(
    `SELECT order_code FROM orders WHERE order_code LIKE $1`,
    [`ORD-%-${yy}`]
  );
  let max = 0;
  for (const row of rows) {
    const match = row.order_code.match(/^ORD-(\d+)-\d{2}$/i);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > max) max = n;
    }
  }
  const next = String(max + 1).padStart(3, '0');
  res.json({ code: `${prefix}${next}${suffix}` });
});

// ── Drawings pending status (for sidebar badge + drawings page) ───────────────
router.get('/drawings/pending', authenticate, async (req, res) => {
  const db = getDB();
  const canSeeNames = withCustomerVisibility(req); // design/QC see only the customer code
  const rows = await db.all(`
    SELECT
      o.id, o.order_code, o.status, o.order_type, o.drawing_status, o.drawing_rejection_reason,
      o.created_at, o.order_date,
      c.customer_code, ${canSeeNames ? 'c.name AS customer_name,' : ''}
      u.name AS created_by_name,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
      (SELECT COUNT(*) FROM order_drawings od WHERE od.order_id = o.id) AS drawing_count,
      (SELECT json_agg(json_build_object('id', od2.id, 'file_name', od2.file_name,
              'original_name', od2.original_name, 'notes', od2.notes, 'item_id', od2.item_id,
              'drawing_status', od2.drawing_status, 'rejection_reason', od2.rejection_reason,
              'created_at', od2.created_at, 'uploaded_by_name', u2.name))
       FROM order_drawings od2
       LEFT JOIN users u2 ON u2.id = od2.uploaded_by
       WHERE od2.order_id = o.id) AS drawings,
      (SELECT json_agg(json_build_object('id', oi3.id, 'drawing_number', oi3.drawing_number,
              'product_code', oi3.product_code, 'quantity', oi3.quantity,
              'tube_material', oi3.tube_material, 'wattage', oi3.wattage, 'voltage', oi3.voltage))
       FROM order_items oi3 WHERE oi3.order_id = o.id) AS items
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN users u ON u.id = o.created_by
    WHERE o.status NOT IN ('pending_approval', 'rejected', 'dispatched', 'resolved_dispatched')
      AND NOT (
        -- Hide orders that have job cards AND every item has a non-rejected drawing
        EXISTS (SELECT 1 FROM job_cards jc WHERE jc.order_id = o.id)
        AND (SELECT COUNT(*) FROM order_items oi2 WHERE oi2.order_id = o.id) > 0
        AND NOT EXISTS (
          SELECT 1 FROM order_items oi
          WHERE oi.order_id = o.id
            AND NOT EXISTS (
              SELECT 1 FROM order_drawings od
              WHERE od.order_id = o.id AND od.item_id = oi.id
                AND (od.drawing_status IS NULL OR od.drawing_status != 'rejected')
            )
        )
      )
    ORDER BY o.created_at DESC
  `);
  res.json(rows);
});

// Previous items ordered by a given customer — used to "reuse" a past item
// (copy its details + reference drawing) when adding an item to a new order.
router.get('/customer/:customerId/previous-items', authenticate, async (req, res) => {
  const db = getDB();
  const items = await db.all(
    `SELECT oi.id, oi.order_id, o.order_code, o.order_date,
            oi.product_code, oi.drawing_number, oi.tube_material, oi.tube_diameter,
            oi.wattage, oi.voltage, oi.plating_instructions, oi.quantity, oi.remark,
            EXISTS (SELECT 1 FROM order_drawings od WHERE od.item_id = oi.id) AS has_drawing,
            (SELECT COUNT(*) FROM order_item_images im WHERE im.item_id = oi.id) AS image_count
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.customer_id = $1
     ORDER BY o.created_at DESC, oi.id DESC`,
    [req.params.customerId]
  );
  // Attach inventory selections so the form can pre-fill them too
  for (const it of items) {
    it.inventory_items = await db.all(
      `SELECT ii.id, ii.item_code, ii.name, ii.name_gu, ii.unit, oii.qty
       FROM order_item_inventory oii JOIN inventory_items ii ON ii.id = oii.inventory_item_id
       WHERE oii.order_item_id = $1`,
      [it.id]
    );
  }
  res.json(items);
});

router.get('/', authenticate, async (req, res) => {
  const db = getDB();
  const canSeeNames = withCustomerVisibility(req);
  const orders = await db.all(
    `SELECT o.*, c.customer_code,
       ${canSeeNames ? 'c.name as customer_name,' : ''}
       u.name as created_by_name,
       (SELECT jc2.job_card_no FROM job_cards jc2 WHERE jc2.order_id = o.id ORDER BY jc2.id LIMIT 1) as job_card_no,
       (SELECT jc2.id FROM job_cards jc2 WHERE jc2.order_id = o.id ORDER BY jc2.id LIMIT 1) as job_card_id,
       (SELECT jc2.status FROM job_cards jc2 WHERE jc2.order_id = o.id ORDER BY jc2.id LIMIT 1) as card_status,
       (SELECT COUNT(*) FROM job_cards jc3 WHERE jc3.order_id = o.id) as job_card_count,
       (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as item_count,
       (SELECT string_agg(DISTINCT oi2.product_code, ', ') FROM order_items oi2 WHERE oi2.order_id = o.id AND oi2.product_code IS NOT NULL AND oi2.product_code != '') as product_codes
     FROM orders o
     JOIN customers c ON o.customer_id = c.id
     LEFT JOIN users u ON o.created_by = u.id
     ORDER BY o.created_at DESC`
  );
  res.json(orders);
});

router.get('/:id', authenticate, async (req, res) => {
  const db = getDB();
  const canSeeNames = withCustomerVisibility(req);
  const order = await db.get(
    `SELECT o.*, c.customer_code,
       ${canSeeNames ? 'c.name as customer_name, c.contact_person, c.phone, c.email, c.address,' : ''}
       u.name as created_by_name, ua.name as approved_by_name
     FROM orders o
     JOIN customers c ON o.customer_id = c.id
     LEFT JOIN users u ON o.created_by = u.id
     LEFT JOIN users ua ON o.approved_by = ua.id
     WHERE o.id = $1`,
    [req.params.id]
  );
  if (!order) return res.status(404).json({ error: 'Order not found' });

  order.quotations = await db.all(
    `SELECT q.*, u.name as uploaded_by_name
     FROM quotations q LEFT JOIN users u ON q.uploaded_by = u.id
     WHERE q.order_id = $1 OR q.inquiry_id = (SELECT inquiry_id FROM orders WHERE id = $1)
     ORDER BY q.created_at DESC`,
    [order.id]
  );

  const priceReq = await db.get(
    `SELECT id FROM activity_log WHERE order_id = $1 AND activity_type = 'price_requested' ORDER BY created_at DESC LIMIT 1`,
    [order.id]
  );
  order.has_price_request = !!priceReq;

  const rawItems = await db.all('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC', [order.id]);
  order.items = await Promise.all(rawItems.map(async item => ({
    ...item,
    images: await db.all('SELECT * FROM order_item_images WHERE item_id = $1 ORDER BY created_at ASC', [item.id]),
    inventory_items: await db.all(
      `SELECT ii.id, ii.item_code, ii.name, ii.name_gu, ii.unit, oii.qty
       FROM order_item_inventory oii JOIN inventory_items ii ON ii.id = oii.inventory_item_id
       WHERE oii.order_item_id = $1 ORDER BY ii.item_code`, [item.id]),
  })));

  order.order_drawings = await db.all(
    `SELECT od.*, u.name as uploaded_by_name, oi.drawing_number as item_drawing_number
     FROM order_drawings od
     LEFT JOIN users u ON od.uploaded_by = u.id
     LEFT JOIN order_items oi ON oi.id = od.item_id
     WHERE od.order_id = $1 ORDER BY od.item_id NULLS LAST, od.created_at ASC`,
    [order.id]
  );
  // Compute per-item drawing status for easy UI consumption
  // item_drawing_status: map of item_id → 'approved'|'pending_review'|'rejected'|null
  const itemDrawingMap = {};
  for (const d of order.order_drawings) {
    if (!d.item_id) continue;
    const existing = itemDrawingMap[d.item_id];
    // If any drawing for this item is approved, the item is approved
    // Otherwise worst status wins: rejected > pending_review > null
    if (!existing || d.drawing_status === 'approved' ||
        (d.drawing_status === 'pending_review' && existing !== 'approved') ||
        (d.drawing_status === 'rejected' && !['approved','pending_review'].includes(existing))) {
      itemDrawingMap[d.item_id] = d.drawing_status || null;
    }
  }
  order.item_drawing_status = itemDrawingMap;

  order.job_cards = await db.all(
    `SELECT jc.*, u.name as uploaded_by_name
     FROM job_cards jc LEFT JOIN users u ON jc.uploaded_by = u.id
     WHERE jc.order_id = $1 ORDER BY jc.dispatch_date ASC`,
    [order.id]
  );

  order.activity = await db.all(
    `SELECT a.*, u.name as user_name, u.role as user_role
     FROM activity_log a LEFT JOIN users u ON a.created_by = u.id
     WHERE a.order_id = $1 ORDER BY a.created_at ASC`,
    [order.id]
  );

  res.json(order);
});

router.post('/', authenticate, authorize('admin', 'owner'), async (req, res) => {
  const { order_code, customer_id, inquiry_id, order_date, dispatch_date, notes, order_type } = req.body;
  if (!order_code || !order_date) return res.status(400).json({ error: 'Order code and date are required' });

  const db = getDB();

  // A pure PHE inventory order has no external customer. Customer is optional
  // for it — fall back to the internal "IO" customer so the NOT NULL column and
  // the many customer joins across the app keep working. All other order types
  // (incl. the io_export_he / io_local_he combos) still require a customer.
  let custId = customer_id || null;
  if (!custId) {
    if (order_type === 'inventory_order') {
      const io = await db.get(`SELECT id FROM customers WHERE UPPER(customer_code) = 'IO' ORDER BY id LIMIT 1`);
      if (!io) return res.status(400).json({ error: 'Inventory-order customer (code "IO") is missing — add it once under Customers.' });
      custId = io.id;
    } else {
      return res.status(400).json({ error: 'Customer is required' });
    }
  }

  try {
    const r = await db.insert(
      `INSERT INTO orders (order_code, customer_id, inquiry_id, order_date, dispatch_date, notes, order_type, created_by, material_deduction)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)`,
      [order_code.toUpperCase(), custId, inquiry_id||null, order_date, dispatch_date||null, notes||null, order_type||'local_he', req.user.id]
    // valid: local_he, export_he, inventory_order, io_export_he, io_local_he
    // material_deduction=TRUE: new orders deduct tube & spring-gauge from the checklist
    );

    await logActivity(r.lastInsertRowid, null, 'order_created', `Order ${order_code} submitted for approval`, req.user.id);

    if (inquiry_id) {
      await db.run("UPDATE inquiries SET status='order_received' WHERE id=$1", [inquiry_id]);
    }

    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('unique') || e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Order code already exists' });
    throw e;
  }
});

router.post('/:id/quotation', authenticate, authorize('admin', 'owner'), ...uploadQuotation, async (req, res) => {
  const { notes, sent_date } = req.body;
  const db = getDB();

  if (!req.file) {
    const priceReq = await db.get(
      `SELECT id FROM activity_log WHERE order_id = $1 AND activity_type = 'price_requested' LIMIT 1`,
      [req.params.id]
    );
    if (!priceReq) return res.status(400).json({ error: 'File required' });
    if (!notes || !notes.trim()) return res.status(400).json({ error: 'Price note is required when no file is attached' });
  }

  const r = await db.insert(
    `INSERT INTO quotations (order_id, file_path, file_name, sent_date, notes, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [req.params.id, req.file?.storagePath || null, req.file?.filename || null, sent_date||null, notes||null, req.user.id]
  );
  await logActivity(req.params.id, null, 'quotation_uploaded', 'Quotation uploaded', req.user.id);
  res.status(201).json({ id: r.lastInsertRowid, file_name: req.file?.filename || null });
});

router.put('/:id/quotation/:qid', authenticate, authorize('owner'), async (req, res) => {
  const { notes } = req.body;
  const db = getDB();
  const q = await db.get('SELECT * FROM quotations WHERE id=$1 AND order_id=$2', [req.params.qid, req.params.id]);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  await db.run('UPDATE quotations SET notes=$1 WHERE id=$2', [notes || null, req.params.qid]);
  res.json({ message: 'Updated' });
});

router.get('/:id/items', authenticate, async (req, res) => {
  const items = await getDB().all('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC', [req.params.id]);
  // Attach inventory selections to each item
  for (const item of items) {
    item.inventory_items = await getDB().all(
      `SELECT ii.id, ii.item_code, ii.name, ii.unit, ii.category, oii.qty
       FROM order_item_inventory oii
       JOIN inventory_items ii ON ii.id = oii.inventory_item_id
       WHERE oii.order_item_id = $1`,
      [item.id]
    );
  }
  res.json(items);
});

router.post('/:id/items', authenticate, authorize('admin', 'owner'), async (req, res) => {
  const { product_code, drawing_number, tube_material, tube_diameter, wattage, voltage, plating_instructions, quantity, remark, inventory_item_ids, copy_from_item_id } = req.body;
  if (!isValidPlating(plating_instructions)) {
    return res.status(400).json({
      error: `Plating must be chosen from the list: ${PLATING_INSTRUCTIONS.join(', ')}.`,
      code: 'PLATING_INVALID',
    });
  }

  if (!quantity) return res.status(400).json({ error: 'Quantity is required' });

  const db = getDB();

  // Reusing a previous item pins its identity. The product code and the drawing
  // number ARE the item — change either and you have a different heater wearing
  // the old one's drawing and its carried BOM. The form disables both fields;
  // this is the rule itself, so no caller can get round it. Everything else
  // (tube, diameter, wattage, voltage, plating, remark, quantity) stays open.
  let pCode = product_code, dNo = drawing_number, tMat = tube_material, tDia = tube_diameter;
  if (copy_from_item_id) {
    const srcId = await db.get(
      'SELECT product_code, drawing_number, tube_material, tube_diameter FROM order_items WHERE id=$1',
      [copy_from_item_id]);
    if (!srcId) return res.status(404).json({ error: 'The item you are reusing no longer exists.' });
    const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
    if (!same(product_code, srcId.product_code) || !same(drawing_number, srcId.drawing_number)) {
      return res.status(400).json({
        error: `A reused item keeps the product code and drawing number it came from — ${srcId.product_code || '(none)'} / ${srcId.drawing_number || '(none)'}. To use a different code or drawing, add the item without reusing a previous one.`,
        code: 'REUSE_IDENTITY_LOCKED',
      });
    }
    pCode = srcId.product_code; dNo = srcId.drawing_number;

    // The tube locks too, but only when the source holds a REAL tube from the
    // dropdown. Older items store free text ("Incoloy", "Copper") which is not
    // a selectable option and not a tube anyone can order against — those stay
    // open so a proper tube can be picked. The diameter follows the tube.
    const pickedTube = srcId.tube_material
      ? await db.get(
          "SELECT item_code FROM inventory_items WHERE item_code=$1 AND LOWER(TRIM(category))='tube'",
          [srcId.tube_material])
      : null;
    if (pickedTube) {
      if (!same(tube_material, srcId.tube_material)) {
        return res.status(400).json({
          error: `A reused item keeps the tube it came from — ${srcId.tube_material}. To use a different tube, add the item without reusing a previous one.`,
          code: 'REUSE_TUBE_LOCKED',
        });
      }
      tMat = srcId.tube_material;
      if (srcId.tube_diameter) tDia = srcId.tube_diameter;
    }
  }

  const r = await db.insert(
    `INSERT INTO order_items (order_id, product_code, drawing_number, tube_material, tube_diameter, wattage, voltage, plating_instructions, quantity, remark)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [req.params.id, pCode||null, dNo||null, tMat||null, tDia||null,
     wattage||null, voltage||null, plating_instructions||null, quantity, remark||null]
  );
  const itemId = r.lastInsertRowid;
  // Inventory is no longer chosen here — design selects it when uploading the
  // item's drawing, and it deducts on drawing approval.

  // Reusing a previous item: copy its reference drawing + images + inventory
  // selection into this new item (files duplicated in storage so they're
  // independent). The copied drawing comes in as 'pending_review' so the owner
  // re-approves it; the job card is NOT copied — it's created fresh later.
  let drawingCopied = false;
  if (copy_from_item_id) {
    // Reuse (part 1): carry over the source item's inventory selection, RE-SIZED
    // to this item's quantity. A stored qty is the total for the source item's
    // whole quantity, so copying it verbatim onto an item of a different size
    // silently changes the per-piece rate — which is how a BOM for 22 pieces
    // ended up on a 12-piece item. The source quantity is not in the request
    // (the client blanks it deliberately), so it is read here.
    const srcItem = await db.get('SELECT quantity FROM order_items WHERE id=$1', [copy_from_item_id]);
    const fromQty = Number(srcItem?.quantity) || 0;
    const toQty = Number(quantity) || 0;
    const srcInv = await db.all(
      `SELECT oii.inventory_item_id, oii.qty, ii.unit, ii.item_code
         FROM order_item_inventory oii JOIN inventory_items ii ON ii.id = oii.inventory_item_id
        WHERE oii.order_item_id=$1`, [copy_from_item_id]);
    const scaleNotes = [];
    for (const s of srcInv) {
      const r = scaleBomQty(s.qty, fromQty, toQty, s.unit);
      if (r.reason) scaleNotes.push(`${s.item_code}: ${r.reason}`);
      await db.run('INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [itemId, s.inventory_item_id, r.qty]);
    }

    // Design must look at every carried BOM before the drawing can be approved —
    // the reuse path is the one way into production that never passes through
    // the screen where a BOM is chosen and validated.
    const why = srcInv.length === 0
      ? 'Reused item came across with no inventory at all — add its BOM.'
      : scaleNotes.length
        ? `Carried from a ${fromQty}-piece item and re-sized to ${toQty}. These lines do not come to a whole number of pieces, so the original BOM is wrong: ${scaleNotes.join('; ')}`
        : `Carried from a ${fromQty}-piece item and re-sized to ${toQty}. Check the quantities and add anything missing.`;
    await db.run(
      'UPDATE order_items SET copied_from_item_id=$1, bom_review=$2, bom_review_reason=$3 WHERE id=$4',
      [copy_from_item_id, 'needed', why, itemId]);
    // Tell design there is a BOM waiting. This used to fire only when the source
    // item had NO inventory — i.e. only when there was nothing to check — which
    // is exactly backwards: a carried BOM is the case that needs looking at.
    try {
      const ord = await db.get('SELECT order_code FROM orders WHERE id=$1', [req.params.id]);
      const designers = await db.all(`SELECT id FROM users WHERE role='design'`);
      const label = drawing_number || product_code || `item #${itemId}`;
      for (const u of designers) {
        await createNotification(db, {
          userId: u.id,
          type: 'inventory_needed',
          title: srcInv.length === 0 ? 'Add inventory for reused item' : 'Check the inventory on a reused item',
          body: `${ord?.order_code || 'An order'} — ${label}. ${why} The drawing cannot be approved until you confirm it.`,
          link: `/orders/${req.params.id}`,
          sourceUserId: req.user.id,
        });
      }
    } catch (e) { console.error('[orders] reuse inventory notify failed:', e.message); }
    const ext = (name, fallback) => (name && name.includes('.') ? name.split('.').pop() : fallback);
    const src = await db.get(
      `SELECT * FROM order_drawings WHERE item_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [copy_from_item_id]
    );
    if (src && src.file_path) {
      // Always create the drawing record so it comes in for approval. Try to
      // duplicate the file in storage; if that fails, fall back to referencing
      // the source file so the copy never silently drops the drawing.
      let newPath = src.file_path, newName = src.file_name;
      try {
        const copyName = `${Date.now()}_copy_item${itemId}.${ext(src.file_name, 'pdf')}`;
        newPath = await copyInStorage(src.file_path, 'order-drawings', copyName);
        newName = copyName;
      } catch (e) { console.error('[orders] drawing file copy failed, referencing source file:', e.message); }
      try {
        await db.run(
          `INSERT INTO order_drawings (order_id, item_id, file_path, file_name, original_name, notes, uploaded_by, drawing_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending_review')`,
          [req.params.id, itemId, newPath, newName, src.original_name, src.notes || null, req.user.id]
        );
        drawingCopied = true;
      } catch (e) { console.error('[orders] drawing record insert failed:', e.message); }
    }
    const srcImages = await db.all(`SELECT * FROM order_item_images WHERE item_id=$1`, [copy_from_item_id]);
    for (const img of srcImages) {
      if (!img.file_path) continue;
      try {
        const newName = `${Date.now()}_copy_item${itemId}_${img.id}.${ext(img.file_name, 'jpg')}`;
        const newPath = await copyInStorage(img.file_path, 'item-images', newName);
        await db.run(
          `INSERT INTO order_item_images (item_id, file_path, file_name, original_name, uploaded_by)
           VALUES ($1,$2,$3,$4,$5)`,
          [itemId, newPath, newName, img.original_name, req.user.id]
        );
      } catch (e) { console.error('[orders] item image copy failed:', e.message); }
    }
  }

  res.status(201).json({ id: itemId, drawingCopied });
});

router.put('/:id/items/:itemId', authenticate, authorize('admin', 'owner'), async (req, res) => {
  const { product_code, drawing_number, tube_material, tube_diameter, wattage, voltage, plating_instructions, quantity, remark } = req.body;
  if (!isValidPlating(plating_instructions)) {
    return res.status(400).json({
      error: `Plating must be chosen from the list: ${PLATING_INSTRUCTIONS.join(', ')}.`,
      code: 'PLATING_INVALID',
    });
  }
  const db = getDB();
  const before = await db.get(
    `SELECT quantity, product_code, drawing_number, tube_material, tube_diameter, copied_from_item_id
       FROM order_items WHERE id=$1 AND order_id=$2`,
    [req.params.itemId, req.params.id]);

  // Same lock as creation, held afterwards: an item that came from a previous
  // order keeps its product code and drawing number, and keeps its tube when
  // that tube is a real one off the dropdown. Otherwise the identity could be
  // pinned at creation and quietly edited a minute later.
  if (before && before.copied_from_item_id) {
    const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
    if (!same(product_code, before.product_code) || !same(drawing_number, before.drawing_number)) {
      return res.status(400).json({
        error: `This item was reused from a previous order, so its product code and drawing number are fixed — ${before.product_code || '(none)'} / ${before.drawing_number || '(none)'}.`,
        code: 'REUSE_IDENTITY_LOCKED',
      });
    }
    if (before.tube_material && !same(tube_material, before.tube_material)) {
      const pickedTube = await db.get(
        "SELECT item_code FROM inventory_items WHERE item_code=$1 AND LOWER(TRIM(category))='tube'",
        [before.tube_material]);
      if (pickedTube) {
        return res.status(400).json({
          error: `This item was reused from a previous order, so its tube is fixed — ${before.tube_material}.`,
          code: 'REUSE_TUBE_LOCKED',
        });
      }
    }
  }
  await db.run(
    `UPDATE order_items SET product_code=$1, drawing_number=$2, tube_material=$3, tube_diameter=$4, wattage=$5,
       voltage=$6, plating_instructions=$7, quantity=$8, remark=$9
     WHERE id=$10 AND order_id=$11`,
    [product_code||null, drawing_number||null, tube_material||null, tube_diameter||null, wattage||null,
     voltage||null, plating_instructions||null, quantity, remark||null, req.params.itemId, req.params.id]
  );

  // Editing the item's SPECS must not touch its inventory — design chose that.
  // But quantity is not a spec: every BOM line is a total for the item's whole
  // quantity, so changing 50 to 20 and leaving the BOM alone leaves a BOM for
  // 50. Lines that have already moved stock are left exactly as they are —
  // re-sizing those needs the restore/replay the inventory route does, not a
  // multiply — and design is asked to look at the item either way.
  const fromQty = Number(before?.quantity) || 0;
  const toQty = Number(quantity) || 0;
  if (fromQty > 0 && toQty > 0 && fromQty !== toQty) {
    const lines = await db.all(
      `SELECT oii.id, oii.qty, oii.qty_deducted, ii.unit, ii.item_code
         FROM order_item_inventory oii JOIN inventory_items ii ON ii.id = oii.inventory_item_id
        WHERE oii.order_item_id=$1`, [req.params.itemId]);
    if (lines.length) {
      const notes = [], held = [];
      for (const l of lines) {
        if (Number(l.qty_deducted) > 0) { held.push(l.item_code); continue; }
        const r = scaleBomQty(l.qty, fromQty, toQty, l.unit);
        if (r.reason) notes.push(`${l.item_code}: ${r.reason}`);
        if (Number(r.qty) !== Number(l.qty)) {
          await db.run('UPDATE order_item_inventory SET qty=$1 WHERE id=$2', [r.qty, l.id]);
        }
      }
      const why = [
        `Quantity changed from ${fromQty} to ${toQty}; the BOM was re-sized to match.`,
        held.length ? `Left untouched because stock has already moved against them: ${held.join(', ')}.` : '',
        notes.length ? `These do not come to a whole number of pieces, so the original BOM is wrong: ${notes.join('; ')}` : '',
      ].filter(Boolean).join(' ');
      await db.run('UPDATE order_items SET bom_review=$1, bom_review_reason=$2, bom_review_by=NULL, bom_review_at=NULL WHERE id=$3',
        ['needed', why, req.params.itemId]);
      await logActivity(req.params.id, null, 'bom_rescaled',
        `BOM re-sized on ${drawing_number || product_code || `item #${req.params.itemId}`}: quantity ${fromQty} → ${toQty}${held.length ? ` (${held.length} line(s) left, already deducted)` : ''}`, req.user.id);
    }
  }
  res.json({ message: 'Updated' });
});

router.delete('/:id/items/:itemId', authenticate, authorize('admin', 'owner'), async (req, res) => {
  await getDB().run('DELETE FROM order_items WHERE id=$1 AND order_id=$2', [req.params.itemId, req.params.id]);
  res.json({ message: 'Deleted' });
});

// Edit an item's inventory selection (design or owner). If the item's drawing is
// already approved (stock deducted), the old selection is reversed and the new
// one re-deducted so stock stays accurate.
router.put('/:id/items/:itemId/inventory', authenticate, authorize('design', 'admin', 'owner'), async (req, res) => {
  const db = getDB();
  const raw = (req.body.inventory_item_ids || []).filter(s => s && s.id);
  // Fins consume by tube length at QC — they carry no qty in the BOM
  const fins = await finsIdSet(db, raw.map(s => parseInt(s.id)));
  const sels = raw.filter(s => parseFloat(s.qty) > 0 || fins.has(parseInt(s.id)));
  if (!sels.length) return res.status(400).json({ error: 'Select at least one inventory item (with quantity)' });
  const item = await db.get('SELECT id, inventory_deducted, remark FROM order_items WHERE id=$1 AND order_id=$2', [req.params.itemId, req.params.id]);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const ord = await db.get('SELECT order_code, order_type FROM orders WHERE id=$1', [req.params.id]);
  const orderCode = ord?.order_code || `Order #${req.params.id}`;
  if (ord?.order_type !== 'finished_goods') {
    const pinCat = requiredPinCategory(item.remark);
    if (!(await hasPinCategory(db, sels.map(s => parseInt(s.id)), pinCat))) {
      return res.status(400).json({
        error: pinCat === 'Heavy Terminal Pin'
          ? 'This item\'s remark calls for a Heavy Terminal Pin — add one from the Heavy Terminal Pin category'
          : 'A Terminal Pin is required — add one from the Terminal Pin category to this item\'s inventory',
      });
    }
  }

  // Gate on what was ACTUALLY taken, not on the settle flag. An item over 50
  // pieces runs as several cards and spends the whole middle of its life
  // part-deducted with inventory_deducted still FALSE — so the flag alone let
  // an edit orphan everything already out of stock (the DELETE below drops
  // qty_deducted with the rows) and then take it again at settle.
  const partly = await db.get(
    'SELECT 1 AS x FROM order_item_inventory WHERE order_item_id=$1 AND COALESCE(qty_deducted,0) > 0 LIMIT 1',
    [item.id]);
  const wasDeducted = !!item.inventory_deducted || !!partly;
  if (wasDeducted) await restoreItemInventory(db, item.id, orderCode, req.user.id, 'Inventory edited');

  await db.run('DELETE FROM order_item_inventory WHERE order_item_id=$1', [item.id]);
  for (const sel of sels) {
    await db.run('INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [item.id, parseInt(sel.id), parseFloat(sel.qty) || 0]);
  }

  // Re-take against the new BOM, to the progress the cards have actually made
  // — a part-built item must not have its whole BOM deducted just because the
  // selection was edited.
  if (wasDeducted) await replayDeductions(db, item.id, orderCode, req.user.id);

  // Design rewriting the BOM IS the review — clear the flag on the way past so
  // they never have to confirm a thing they just finished editing.
  if (['design', 'admin', 'owner'].includes(req.user.role)) {
    await db.run(
      "UPDATE order_items SET bom_review=CASE WHEN bom_review='needed' THEN 'confirmed' ELSE bom_review END, " +
      "bom_review_by=CASE WHEN bom_review='needed' THEN $1 ELSE bom_review_by END, " +
      "bom_review_at=CASE WHEN bom_review='needed' THEN NOW() ELSE bom_review_at END WHERE id=$2",
      [req.user.id, item.id]);
  }
  await logActivity(req.params.id, null, 'inventory_edited', `Inventory selection updated for item #${item.id}`, req.user.id);
  res.json({ message: 'Inventory updated', reDeducted: wasDeducted });
});

router.post('/:orderId/items/:itemId/images', authenticate, authorize('admin', 'owner'), ...uploadOrderItemImage, async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'Files required' });
  const db = getDB();
  const inserted = [];
  for (const f of req.files) {
    const r = await db.insert(
      `INSERT INTO order_item_images (item_id, file_path, file_name, original_name, uploaded_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.params.itemId, f.storagePath, f.filename, f.originalname, req.user.id]
    );
    inserted.push({ id: r.lastInsertRowid, file_name: f.filename, original_name: f.originalname });
  }
  res.status(201).json(inserted);
});

router.delete('/:orderId/items/:itemId/images/:imageId', authenticate, authorize('admin', 'owner'), async (req, res) => {
  const db = getDB();
  const img = await db.get('SELECT * FROM order_item_images WHERE id=$1 AND item_id=$2', [req.params.imageId, req.params.itemId]);
  if (!img) return res.status(404).json({ error: 'Not found' });
  await deleteFromStorage(img.file_path);
  await db.run('DELETE FROM order_item_images WHERE id=$1', [req.params.imageId]);
  res.json({ message: 'Deleted' });
});

router.get('/:id/drawings', authenticate, async (req, res) => {
  res.json(await getDB().all(
    `SELECT od.*, u.name as uploaded_by_name
     FROM order_drawings od LEFT JOIN users u ON od.uploaded_by = u.id
     WHERE od.order_id = $1 ORDER BY od.created_at ASC`,
    [req.params.id]
  ));
});

router.post('/:id/drawings', authenticate, authorize('design', 'admin', 'owner'), ...uploadOrderDrawing, async (req, res) => {
  try {
    const { notes, item_id } = req.body;
    if (!item_id) return res.status(400).json({ error: 'Item is required for the drawing' });

    const db = getDB();
    const ord = await db.get('SELECT order_type FROM orders WHERE id=$1', [req.params.id]);
    const isFgOrder = ord?.order_type === 'finished_goods';
    // Finished-Goods orders may record the inventory selection without a drawing
    // file; every other order type still requires the file.
    if (!req.file && !isFgOrder) return res.status(400).json({ error: 'File required' });

    // Design selects the inventory consumed by this item along with the drawing.
    // It arrives as a JSON string in the multipart form.
    let invSelections = [];
    try { invSelections = JSON.parse(req.body.inventory_item_ids || '[]'); } catch { invSelections = []; }
    invSelections = (invSelections || []).filter(s => s && s.id);
    // Fins lines carry no qty — they deduct by tube length at QC approval
    const finsIds = await finsIdSet(db, invSelections.map(s => parseInt(s.id)));
    invSelections = invSelections.filter(s => parseFloat(s.qty) > 0 || finsIds.has(parseInt(s.id)));
    if (!invSelections.length) return res.status(400).json({ error: 'Select at least one inventory item (with quantity) for this drawing' });
    if (!isFgOrder) {
      const itemRow = await db.get('SELECT remark FROM order_items WHERE id=$1 AND order_id=$2', [parseInt(item_id), req.params.id]);
      const pinCat = requiredPinCategory(itemRow?.remark);
      if (!(await hasPinCategory(db, invSelections.map(s => parseInt(s.id)), pinCat))) {
        return res.status(400).json({
          error: pinCat === 'Heavy Terminal Pin'
            ? 'This item\'s remark calls for a Heavy Terminal Pin — add one from the Heavy Terminal Pin category'
            : 'A Terminal Pin is required — add one from the Terminal Pin category to this item\'s inventory',
        });
      }
    }
    const r = await db.insert(
      `INSERT INTO order_drawings (order_id, item_id, file_path, file_name, original_name, notes, uploaded_by, drawing_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending_review')`,
      [req.params.id, parseInt(item_id), req.file?.storagePath || null, req.file?.filename || null, req.file?.originalname || null, notes||null, req.user.id]
    );

    // Replace this item's inventory selection with what design just chose.
    await db.run('DELETE FROM order_item_inventory WHERE order_item_id=$1', [parseInt(item_id)]);
    for (const sel of invSelections) {
      await db.run(
        'INSERT INTO order_item_inventory (order_item_id, inventory_item_id, qty) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [parseInt(item_id), parseInt(sel.id), parseFloat(sel.qty) || 0]
      );
    }

    // Design picked this BOM by hand on the way in — that satisfies the check.
    await db.run(
      "UPDATE order_items SET bom_review=CASE WHEN bom_review='needed' THEN 'confirmed' ELSE bom_review END, " +
      "bom_review_by=CASE WHEN bom_review='needed' THEN $1 ELSE bom_review_by END, " +
      "bom_review_at=CASE WHEN bom_review='needed' THEN NOW() ELSE bom_review_at END WHERE id=$2",
      [req.user.id, parseInt(item_id)]);

    await logActivity(req.params.id, null, 'drawing_uploaded',
      req.file ? `Reference drawing uploaded: ${req.file.originalname}` : 'Drawing entry recorded without file (finished-goods order)', req.user.id);
    res.status(201).json({ id: r.lastInsertRowid, file_name: req.file?.filename || null, original_name: req.file?.originalname || null });
  } catch (e) {
    console.error('drawing upload error:', e);
    res.status(500).json({ error: 'Failed to save drawing' });
  }
});

// ── Drawing bypass: owner skips drawing approval for the whole order ──────────
// Reversible — job cards can be created for all items while bypassed.
router.put('/:id/drawing-bypass', authenticate, authorize('owner'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid order id' });
    const db = getDB();
    const o = await db.get('SELECT id, order_code, drawing_bypassed FROM orders WHERE id=$1', [id]);
    if (!o) return res.status(404).json({ error: 'Order not found' });
    const bypassed = req.body.bypassed === true || req.body.bypassed === 'true';
    await db.run('UPDATE orders SET drawing_bypassed=$1 WHERE id=$2', [bypassed, id]);
    await logActivity(id, null, 'drawing_bypass',
      bypassed
        ? `Drawing approval bypassed for ${o.order_code} — job cards allowed without drawings`
        : `Drawing requirement restored for ${o.order_code}`, req.user.id);
    res.json({ message: bypassed ? 'Drawing bypassed for this order' : 'Drawing requirement restored', drawing_bypassed: bypassed });
  } catch (e) {
    console.error('drawing bypass error:', e);
    res.status(500).json({ error: 'Failed to update drawing bypass' });
  }
});

// ── Design confirms a carried BOM ────────────────────────────────────────────
// The counterpart to the gate above. Design either edits the inventory (which
// confirms it on the way past, below) or — when the carried BOM is already
// right — says so here without touching it. Owner and admin can also confirm,
// so a missing designer never stops an order.
router.put('/:id/items/:itemId/bom-confirm', authenticate, authorize('design', 'admin', 'owner'), async (req, res) => {
  const db = getDB();
  const it = await db.get('SELECT id, drawing_number, product_code, bom_review FROM order_items WHERE id=$1 AND order_id=$2',
    [req.params.itemId, req.params.id]);
  if (!it) return res.status(404).json({ error: 'Item not found' });
  if (it.bom_review !== 'needed') return res.status(400).json({ error: 'This item is not waiting on a BOM check.' });

  const lines = await db.all('SELECT 1 FROM order_item_inventory WHERE order_item_id=$1 AND qty > 0', [req.params.itemId]);
  if (!lines.length) {
    return res.status(400).json({ error: 'This item has no inventory on it — add the BOM before confirming.' });
  }

  await db.run(
    "UPDATE order_items SET bom_review='confirmed', bom_review_by=$1, bom_review_at=NOW() WHERE id=$2",
    [req.user.id, req.params.itemId]);
  await logActivity(req.params.id, null, 'bom_confirmed',
    `Inventory confirmed on ${it.drawing_number || it.product_code || `item #${it.id}`} by ${req.user.name}`, req.user.id);
  res.json({ message: 'Inventory confirmed — the drawing can be approved now.' });
});

// ── Drawing review: owner approves or rejects individual drawings ──────────────
router.put('/:id/drawings/:drawingId/approve', authenticate, authorize('owner'), async (req, res) => {
  const db = getDB();
  const d = await db.get('SELECT * FROM order_drawings WHERE id=$1 AND order_id=$2', [req.params.drawingId, req.params.id]);
  if (!d) return res.status(404).json({ error: 'Drawing not found' });

  // Design's check of the BOM is compulsory (owner, 24 Sep 2026). A reused item
  // reaches production without ever passing the screen where a BOM is chosen,
  // so the approval that lets it through is where the check is enforced.
  if (d.item_id) {
    const it = await db.get('SELECT bom_review, bom_review_reason, drawing_number, product_code FROM order_items WHERE id=$1', [d.item_id]);
    if (it && it.bom_review === 'needed') {
      return res.status(400).json({
        error: `Design has not confirmed the inventory on ${it.drawing_number || it.product_code || 'this item'} yet. ${it.bom_review_reason || ''}`.trim(),
        code: 'BOM_REVIEW_REQUIRED', item_id: d.item_id,
      });
    }
  }

  await db.run(`UPDATE order_drawings SET drawing_status='approved', rejection_reason=NULL WHERE id=$1`, [req.params.drawingId]);
  // NOTE: inventory is NOT deducted here anymore. The item's selected inventory is
  // confirmed/edited and deducted at the QC stage (single job card) or once the
  // whole qty is dispatched for a partially-dispatched item.
  await logActivity(req.params.id, null, 'drawing_approved', `Drawing approved: ${d.original_name || d.file_name || 'entry without file'}`, req.user.id);
  res.json({ message: 'Drawing approved' });
});

router.put('/:id/drawings/:drawingId/reject', authenticate, authorize('owner'), async (req, res) => {
  const { reason } = req.body;
  if (!reason?.trim()) return res.status(400).json({ error: 'Rejection reason is required' });
  const db = getDB();
  const d = await db.get('SELECT * FROM order_drawings WHERE id=$1 AND order_id=$2', [req.params.drawingId, req.params.id]);
  if (!d) return res.status(404).json({ error: 'Drawing not found' });
  await db.run(`UPDATE order_drawings SET drawing_status='rejected', rejection_reason=$1 WHERE id=$2`, [reason.trim(), req.params.drawingId]);
  // If this drawing was previously approved, its inventory was deducted — put it
  // back so design can revise the selection before the next approval.
  if (d.item_id) {
    const ord = await db.get('SELECT order_code FROM orders WHERE id=$1', [req.params.id]);
    await restoreItemInventory(db, d.item_id, ord?.order_code || `Order #${req.params.id}`, req.user.id, 'Drawing reopened');
  }
  await logActivity(req.params.id, null, 'drawing_rejected', `Drawing rejected: ${reason}`, req.user.id);
  res.json({ message: 'Drawing rejected' });
});

router.delete('/:id/drawings/:drawingId', authenticate, authorize('design', 'admin', 'owner'), async (req, res) => {
  const db = getDB();
  const d = await db.get('SELECT * FROM order_drawings WHERE id=$1 AND order_id=$2', [req.params.drawingId, req.params.id]);
  if (!d) return res.status(404).json({ error: 'Not found' });
  await deleteFromStorage(d.file_path);
  await db.run('DELETE FROM order_drawings WHERE id=$1', [req.params.drawingId]);
  res.json({ message: 'Deleted' });
});

router.get('/:id/messages', authenticate, async (req, res) => {
  const db = getDB();
  const messages = await db.all(
    `SELECT om.*, u.name as user_name, u.role as user_role
     FROM order_messages om JOIN users u ON om.user_id = u.id
     WHERE om.order_id = $1 ORDER BY om.created_at ASC`,
    [req.params.id]
  );
  for (const msg of messages) {
    msg.attachments = await db.all(
      'SELECT id, file_path, file_name, file_size, mime_type FROM message_attachments WHERE message_id = $1',
      [msg.id]
    );
  }
  res.json(messages);
});

router.post('/:id/messages', authenticate, ...uploadChatAttachments, async (req, res) => {
  const { message } = req.body;
  let mentionIds = req.body.mentionIds;
  if (typeof mentionIds === 'string') try { mentionIds = JSON.parse(mentionIds); } catch { mentionIds = []; }
  const hasFiles = req.files?.length > 0;
  if (!message?.trim() && !hasFiles) return res.status(400).json({ error: 'Message or attachment required' });
  const db = getDB();
  const r = await db.insert(
    'INSERT INTO order_messages (order_id, user_id, message) VALUES ($1,$2,$3)',
    [req.params.id, req.user.id, (message || '').trim()]
  );
  const messageId = r.lastInsertRowid;

  if (hasFiles) {
    for (const f of req.files) {
      await db.insert(
        'INSERT INTO message_attachments (message_id, file_path, file_name, file_size, mime_type) VALUES ($1,$2,$3,$4,$5)',
        [messageId, f.storagePath, f.originalname, f.size, f.mimetype]
      );
    }
  }

  // Insert mentions using client-supplied user IDs (avoids regex parsing of names with spaces/slashes)
  if (Array.isArray(mentionIds) && mentionIds.length) {
    for (const userId of mentionIds) {
      if (userId !== req.user.id) {
        await db.run(
          'INSERT INTO message_mentions (message_id, order_id, mentioned_user_id) VALUES ($1,$2,$3)',
          [messageId, req.params.id, userId]
        );
      }
    }
  }

  if (Array.isArray(mentionIds) && mentionIds.length) {
    const order = await db.get('SELECT order_code FROM orders WHERE id=$1', [req.params.id]);
    const orderCode = order?.order_code || `Order #${req.params.id}`;
    const preview = (message || '').trim().slice(0, 100);
    const fileNote = hasFiles ? ` [+${req.files.length} file${req.files.length > 1 ? 's' : ''}]` : '';
    for (const userId of mentionIds) {
      if (userId !== req.user.id) {
        await createNotification(db, {
          userId,
          type: 'order_message',
          title: `${req.user.name} in ${orderCode}`,
          body: preview ? preview + fileNote : `Sent${fileNote}`,
          link: `/orders/${req.params.id}`,
          sourceUserId: req.user.id,
        });
      }
    }
  }

  res.status(201).json({ id: messageId });
});

router.put('/:id/approve', authenticate, authorize('owner'), async (req, res) => {
  const db = getDB();

  // Guard: don't double-deduct if already approved
  const order = await db.get('SELECT status FROM orders WHERE id=$1', [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status === 'approved') return res.status(409).json({ error: 'Order already approved' });

  // No drawing gate here — order is approved first, then design uploads drawings per item.
  // Inventory is NOT deducted here anymore: it deducts per item when that item's
  // drawing is approved (see /drawings/:drawingId/approve).
  await db.run(
    "UPDATE orders SET status='approved', approved_by=$1, approved_at=NOW() WHERE id=$2",
    [req.user.id, req.params.id]
  );

  await logActivity(req.params.id, null, 'order_approved', 'Order approved by owner', req.user.id);
  res.json({ message: 'Order approved' });
});

router.put('/:id/reject', authenticate, authorize('owner'), async (req, res) => {
  const { reason } = req.body;
  const db = getDB();
  await db.run("UPDATE orders SET status='rejected', rejection_reason=$1 WHERE id=$2", [reason||null, req.params.id]);
  await logActivity(req.params.id, null, 'order_rejected', `Order rejected: ${reason || 'No reason given'}`, req.user.id);
  res.json({ message: 'Order rejected' });
});

router.put('/:id', authenticate, authorize('admin', 'owner', 'accounts'), async (req, res) => {
  const db = getDB();
  const order = await db.get('SELECT status FROM orders WHERE id=$1', [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.status === 'rejected') {
    const { dispatch_date, notes, order_type } = req.body;
    const sets = ['notes = $1'];
    const params = [notes || null];
    let idx = 2;
    if (dispatch_date !== undefined) { sets.push(`dispatch_date = $${idx}`); params.push(dispatch_date || null); idx++; }
    if (order_type !== undefined) { sets.push(`order_type = $${idx}`); params.push(order_type); idx++; }
    params.push(req.params.id);
    await db.run(`UPDATE orders SET ${sets.join(', ')} WHERE id = $${idx}`, params);
  } else {
    const { notes } = req.body;
    await db.run('UPDATE orders SET notes=$1 WHERE id=$2', [notes || null, req.params.id]);
  }
  res.json({ message: 'Updated' });
});

router.put('/:id/resubmit', authenticate, authorize('admin', 'owner', 'accounts'), async (req, res) => {
  const db = getDB();
  const order = await db.get('SELECT id, status, order_code FROM orders WHERE id=$1', [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'rejected') return res.status(400).json({ error: 'Only rejected orders can be resubmitted' });
  const badPlating = await db.all(
    `SELECT drawing_number, plating_instructions FROM order_items
      WHERE order_id=$1 AND COALESCE(TRIM(plating_instructions),'') <> ALL($2)`,
    [req.params.id, PLATING_INSTRUCTIONS]);
  if (badPlating.length) {
    return res.status(400).json({
      error: `Cannot send for approval — ${badPlating.length} item(s) have a plating instruction that is not on the list: `
        + badPlating.map(b => `${b.drawing_number || 'item'} ("${b.plating_instructions || 'blank'}")`).join(', ')
        + `. Pick one of: ${PLATING_INSTRUCTIONS.join(', ')}.`,
      code: 'PLATING_INVALID',
    });
  }
  await db.run("UPDATE orders SET status='pending_approval', rejection_reason=NULL WHERE id=$1", [req.params.id]);
  await logActivity(req.params.id, null, 'order_resubmitted', `Order resubmitted for approval`, req.user.id);
  const owners = await db.all("SELECT id FROM users WHERE role='owner' AND id != $1", [req.user.id]);
  for (const o of owners) {
    await createNotification(db, {
      userId: o.id,
      type: 'order_message',
      title: `${order.order_code} resubmitted`,
      body: `${req.user.name} resubmitted order for approval`,
      link: `/orders/${req.params.id}`,
      sourceUserId: req.user.id,
    });
  }
  res.json({ message: 'Order resubmitted for approval' });
});

router.delete('/:id', authenticate, authorize('owner'), async (req, res) => {
  const db = getDB();
  const order = await db.get('SELECT id FROM orders WHERE id=$1', [req.params.id]);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const jobCards = await db.all('SELECT * FROM job_cards WHERE order_id=$1', [order.id]);
  for (const jc of jobCards) {
    await db.run('DELETE FROM production_day_picks WHERE job_card_id=$1', [jc.id]);
    await db.run('DELETE FROM job_card_holds WHERE job_card_id=$1', [jc.id]);
    await db.run('DELETE FROM qc_reports WHERE job_card_id=$1', [jc.id]);
    await db.run('DELETE FROM package_photos WHERE job_card_id=$1', [jc.id]);
    await db.run('DELETE FROM dispatch_documents WHERE job_card_id=$1', [jc.id]);
    await db.run('DELETE FROM production_daily_reports WHERE job_card_id=$1', [jc.id]);
    await db.run('UPDATE inventory_transactions SET job_card_id=NULL WHERE job_card_id=$1', [jc.id]);
    await db.run('UPDATE drawings SET job_card_id=NULL WHERE job_card_id=$1', [jc.id]);
    await db.run('DELETE FROM job_card_assemblies WHERE job_card_id=$1', [jc.id]);
    await db.run('UPDATE activity_log SET job_card_id=NULL WHERE job_card_id=$1', [jc.id]);
    if (jc.file_path) await deleteFromStorage(jc.file_path);
    await db.run('DELETE FROM job_cards WHERE id=$1', [jc.id]);
  }

  const fullOrder = await db.get('SELECT order_code FROM orders WHERE id=$1', [order.id]);
  const items = await db.all('SELECT id FROM order_items WHERE order_id=$1', [order.id]);
  for (const item of items) {
    // Reverse inventory only for items whose drawing was approved (deducted).
    await restoreItemInventory(db, item.id, fullOrder?.order_code || ('Order #' + req.params.id), req.user.id, 'Order deleted');
    const images = await db.all('SELECT file_path FROM order_item_images WHERE item_id=$1', [item.id]);
    for (const img of images) await deleteFromStorage(img.file_path);
    await db.run('DELETE FROM order_item_images WHERE item_id=$1', [item.id]);
  }
  await db.run('DELETE FROM order_items WHERE order_id=$1', [order.id]);

  const quotations = await db.all('SELECT file_path FROM quotations WHERE order_id=$1', [order.id]);
  for (const q of quotations) await deleteFromStorage(q.file_path);
  await db.run('DELETE FROM quotations WHERE order_id=$1', [order.id]);

  const drawings = await db.all('SELECT file_path FROM order_drawings WHERE order_id=$1', [order.id]);
  for (const d of drawings) await deleteFromStorage(d.file_path);
  await db.run('DELETE FROM order_drawings WHERE order_id=$1', [order.id]);

  await db.run('DELETE FROM order_messages WHERE order_id=$1', [order.id]);
  await db.run('UPDATE activity_log SET order_id=NULL WHERE order_id=$1', [order.id]);
  await db.run('DELETE FROM orders WHERE id=$1', [order.id]);
  res.json({ message: 'Order deleted' });
});

router.get('/:orderId/inquiries', authenticate, async (req, res) => {
  res.json(await getDB().all(
    'SELECT * FROM inquiries WHERE id = (SELECT inquiry_id FROM orders WHERE id=$1)',
    [req.params.orderId]
  ));
});

router.post('/inquiries', authenticate, authorize('admin', 'owner'), async (req, res) => {
  const { inquiry_code, customer_id, description, is_custom_design, notes } = req.body;
  if (!inquiry_code || !customer_id) return res.status(400).json({ error: 'Code and customer required' });
  try {
    const r = await getDB().insert(
      `INSERT INTO inquiries (inquiry_code, customer_id, description, is_custom_design, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [inquiry_code.toUpperCase(), customer_id, description||null, is_custom_design ? 1 : 0, notes||null, req.user.id]
    );
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) {
    if (e.message.includes('unique') || e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Inquiry code already exists' });
    throw e;
  }
});

router.get('/inquiries/all', authenticate, authorize('admin', 'owner'), async (req, res) => {
  res.json(await getDB().all(
    `SELECT i.*, c.customer_code, c.name as customer_name
     FROM inquiries i JOIN customers c ON i.customer_id = c.id
     ORDER BY i.created_at DESC`
  ));
});

router.post('/inquiries/:id/quotation', authenticate, authorize('admin', 'owner'), ...uploadQuotation, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File required' });
  const { notes, sent_date } = req.body;
  const db = getDB();
  const r = await db.insert(
    `INSERT INTO quotations (inquiry_id, file_path, file_name, sent_date, notes, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [req.params.id, req.file.storagePath, req.file.filename, sent_date||null, notes||null, req.user.id]
  );
  await db.run("UPDATE inquiries SET status='quotation_sent' WHERE id=$1", [req.params.id]);
  res.status(201).json({ id: r.lastInsertRowid, file_name: req.file.filename });
});

module.exports = router;
