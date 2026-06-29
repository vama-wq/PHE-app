const router = require('express').Router();
const { getDB } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/', authenticate, async (req, res) => {
  const suppliers = await getDB().all(`
    SELECT s.*,
      (SELECT COUNT(*) FROM supplier_items si WHERE si.supplier_id = s.id) AS item_count
    FROM suppliers s ORDER BY s.name
  `);
  res.json(suppliers);
});

router.get('/:id/items', authenticate, async (req, res) => {
  const rows = await getDB().all(`
    SELECT si.*, ii.item_code, ii.name AS item_name, ii.unit, ii.current_stock, ii.drawing_file
    FROM supplier_items si
    JOIN inventory_items ii ON ii.id = si.inventory_item_id
    WHERE si.supplier_id = $1
    ORDER BY ii.item_code
  `, [req.params.id]);
  res.json(rows);
});

router.post('/', authenticate, authorize('owner', 'admin', 'accounts'), async (req, res) => {
  const { supplier_code, name, contact_person, phone, email, address, notes, items } = req.body;
  if (!supplier_code) return res.status(400).json({ error: 'Supplier code is required' });
  if (!name)          return res.status(400).json({ error: 'Supplier name is required' });
  if (!phone)         return res.status(400).json({ error: 'Phone number is required' });
  if (!address)       return res.status(400).json({ error: 'Address is required' });
  if (!items || !items.length) return res.status(400).json({ error: 'At least one inventory item is required' });
  for (const item of items) {
    if (!item.inventory_item_id) continue;
    if (!item.supplier_price || Number(item.supplier_price) <= 0)
      return res.status(400).json({ error: 'Price is required for each linked item' });
    if (!item.lead_time_days || Number(item.lead_time_days) <= 0)
      return res.status(400).json({ error: 'Lead time is required for each linked item' });
  }

  const db = getDB();
  const existing = await db.get('SELECT id FROM suppliers WHERE supplier_code=$1', [supplier_code]);
  if (existing) return res.status(409).json({ error: 'Supplier code already exists' });

  try {
    const r = await db.insert(
      `INSERT INTO suppliers (supplier_code, name, contact_person, phone, email, address, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [supplier_code, name, contact_person||null, phone, email||null, address, notes||null, req.user.id]
    );
    const supplierId = r.lastInsertRowid;

    for (const item of items) {
      if (!item.inventory_item_id) continue;
      await db.run(
        `INSERT INTO supplier_items (supplier_id, inventory_item_id, supplier_part_no, supplier_price, lead_time_days, min_order_qty)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT(supplier_id, inventory_item_id) DO UPDATE SET
           supplier_part_no = EXCLUDED.supplier_part_no,
           supplier_price   = EXCLUDED.supplier_price,
           lead_time_days   = EXCLUDED.lead_time_days,
           min_order_qty    = EXCLUDED.min_order_qty`,
        [supplierId, item.inventory_item_id, item.supplier_part_no||null,
         Number(item.supplier_price)||0, item.lead_time_days ? parseInt(item.lead_time_days) : null,
         Number(item.min_order_qty)||0]
      );
    }

    res.json({ id: supplierId });
  } catch (e) {
    if (e.message.includes('unique') || e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Supplier code already exists' });
    throw e;
  }
});

router.put('/:id', authenticate, authorize('owner', 'admin', 'accounts'), async (req, res) => {
  const { supplier_code, name, contact_person, phone, email, address, notes, items } = req.body;
  if (!supplier_code) return res.status(400).json({ error: 'Supplier code is required' });
  if (!name)          return res.status(400).json({ error: 'Supplier name is required' });
  if (!phone)         return res.status(400).json({ error: 'Phone number is required' });
  if (!address)       return res.status(400).json({ error: 'Address is required' });

  const db = getDB();
  const existing = await db.get('SELECT id FROM suppliers WHERE supplier_code=$1 AND id!=$2', [supplier_code, req.params.id]);
  if (existing) return res.status(409).json({ error: 'Supplier code already exists' });

  try {
    await db.run(
      `UPDATE suppliers SET supplier_code=$1, name=$2, contact_person=$3, phone=$4, email=$5, address=$6, notes=$7 WHERE id=$8`,
      [supplier_code, name, contact_person||null, phone, email||null, address, notes||null, req.params.id]
    );

    if (items) {
      const keepIds = items.filter(i => i.inventory_item_id).map(i => i.inventory_item_id);
      if (keepIds.length) {
        await db.run(
          `DELETE FROM supplier_items WHERE supplier_id=$1 AND inventory_item_id NOT IN (${keepIds.map((_, i) => `$${i+2}`).join(',')})`,
          [req.params.id, ...keepIds]
        );
      } else {
        await db.run('DELETE FROM supplier_items WHERE supplier_id=$1', [req.params.id]);
      }

      for (const item of items) {
        if (!item.inventory_item_id) continue;
        await db.run(
          `INSERT INTO supplier_items (supplier_id, inventory_item_id, supplier_part_no, supplier_price, lead_time_days, min_order_qty)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT(supplier_id, inventory_item_id) DO UPDATE SET
             supplier_part_no = EXCLUDED.supplier_part_no,
             supplier_price   = EXCLUDED.supplier_price,
             lead_time_days   = EXCLUDED.lead_time_days,
             min_order_qty    = EXCLUDED.min_order_qty`,
          [req.params.id, item.inventory_item_id, item.supplier_part_no||null,
           Number(item.supplier_price)||0, item.lead_time_days ? parseInt(item.lead_time_days) : null,
           Number(item.min_order_qty)||0]
        );
      }
    }

    res.json({ message: 'Updated' });
  } catch (e) {
    if (e.message.includes('unique') || e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Supplier code already exists' });
    throw e;
  }
});

router.delete('/:id', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const inUse = await getDB().get('SELECT id FROM purchase_orders WHERE supplier_id=$1 LIMIT 1', [req.params.id]);
  if (inUse) return res.status(400).json({ error: 'Cannot delete — supplier has purchase orders' });
  await getDB().run('DELETE FROM suppliers WHERE id=$1', [req.params.id]);
  res.json({ message: 'Deleted' });
});

module.exports = router;
