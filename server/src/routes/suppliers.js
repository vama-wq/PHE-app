const router = require('express').Router();
const { getDB } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

router.get('/', authenticate, async (req, res) => {
  const suppliers = await getDB().all('SELECT * FROM suppliers ORDER BY name');
  res.json(suppliers);
});

router.post('/', authenticate, authorize('owner', 'admin', 'accounts'), async (req, res) => {
  const { supplier_code, name, contact_person, phone, email, address, notes } = req.body;
  if (!supplier_code) return res.status(400).json({ error: 'Supplier code is required' });
  if (!name)          return res.status(400).json({ error: 'Supplier name is required' });
  if (!phone)         return res.status(400).json({ error: 'Phone number is required' });
  if (!address)       return res.status(400).json({ error: 'Address is required' });

  const r = await getDB().insert(
    `INSERT INTO suppliers (supplier_code, name, contact_person, phone, email, address, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [supplier_code, name, contact_person||null, phone, email||null, address, notes||null, req.user.id]
  );
  res.json({ id: r.lastInsertRowid });
});

router.put('/:id', authenticate, authorize('owner', 'admin', 'accounts'), async (req, res) => {
  const { supplier_code, name, contact_person, phone, email, address, notes } = req.body;
  if (!supplier_code) return res.status(400).json({ error: 'Supplier code is required' });
  if (!name)          return res.status(400).json({ error: 'Supplier name is required' });
  if (!phone)         return res.status(400).json({ error: 'Phone number is required' });
  if (!address)       return res.status(400).json({ error: 'Address is required' });

  await getDB().run(
    `UPDATE suppliers SET supplier_code=$1, name=$2, contact_person=$3, phone=$4, email=$5, address=$6, notes=$7 WHERE id=$8`,
    [supplier_code, name, contact_person||null, phone, email||null, address, notes||null, req.params.id]
  );
  res.json({ message: 'Updated' });
});

router.delete('/:id', authenticate, authorize('owner', 'admin'), async (req, res) => {
  const inUse = await getDB().get('SELECT id FROM purchase_orders WHERE supplier_id=$1 LIMIT 1', [req.params.id]);
  if (inUse) return res.status(400).json({ error: 'Cannot delete — supplier has purchase orders' });
  await getDB().run('DELETE FROM suppliers WHERE id=$1', [req.params.id]);
  res.json({ message: 'Deleted' });
});

module.exports = router;
