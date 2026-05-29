const router = require('express').Router();
const { getDB } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

const restricted = [authenticate, authorize('admin', 'owner')];

router.get('/', ...restricted, async (req, res) => {
  const customers = await getDB().all('SELECT * FROM customers ORDER BY customer_code');
  res.json(customers);
});

router.get('/codes', authenticate, async (req, res) => {
  const codes = await getDB().all('SELECT id, customer_code FROM customers ORDER BY customer_code');
  res.json(codes);
});

router.get('/:id', ...restricted, async (req, res) => {
  const c = await getDB().get('SELECT * FROM customers WHERE id = $1', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  res.json(c);
});

router.post('/', ...restricted, async (req, res) => {
  const {
    customer_code, name, contact_person, phone, email, billing_address, shipping_address, gst_no, notes,
    country_of_destination, port_of_loading, port_of_discharge, final_destination
  } = req.body;
  if (!customer_code || !name) return res.status(400).json({ error: 'Code and name required' });

  try {
    const result = await getDB().insert(
      `INSERT INTO customers
         (customer_code, name, contact_person, phone, email, billing_address, shipping_address, gst_no, notes,
          country_of_destination, port_of_loading, port_of_discharge, final_destination, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        customer_code.toUpperCase(), name, contact_person||null, phone||null, email||null,
        billing_address||null, shipping_address||null, gst_no||null, notes||null,
        country_of_destination||null, port_of_loading||null, port_of_discharge||null, final_destination||null,
        req.user.id
      ]
    );
    res.status(201).json({ id: result.lastInsertRowid, customer_code: customer_code.toUpperCase() });
  } catch (e) {
    if (e.message.includes('unique') || e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Customer code already exists' });
    throw e;
  }
});

router.put('/:id', ...restricted, async (req, res) => {
  const {
    customer_code, name, contact_person, phone, email, billing_address, shipping_address, gst_no, notes,
    country_of_destination, port_of_loading, port_of_discharge, final_destination
  } = req.body;
  await getDB().run(
    `UPDATE customers SET customer_code=$1, name=$2, contact_person=$3, phone=$4, email=$5,
       billing_address=$6, shipping_address=$7, gst_no=$8, notes=$9,
       country_of_destination=$10, port_of_loading=$11, port_of_discharge=$12, final_destination=$13
     WHERE id=$14`,
    [
      customer_code?.toUpperCase(), name, contact_person||null, phone||null, email||null,
      billing_address||null, shipping_address||null, gst_no||null, notes||null,
      country_of_destination||null, port_of_loading||null, port_of_discharge||null, final_destination||null,
      req.params.id
    ]
  );
  res.json({ message: 'Updated' });
});

router.delete('/:id', authenticate, authorize('owner'), async (req, res) => {
  await getDB().run('DELETE FROM customers WHERE id = $1', [req.params.id]);
  res.json({ message: 'Deleted' });
});

module.exports = router;
