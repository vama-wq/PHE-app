const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

// Only nickel-plating / electropolish items go to an external plating vendor
// (Buffing / No Plating stay in-house). Matched loosely so legacy free-text
// values ("nickle plating", "Electro Polish", etc.) qualify too.
const PLATING_MATCH_SQL = 'nickel|nickle|electro';
const PLATING_MATCH_RE = /nickel|nickle|electro/i;
// Terminal / not-yet-started orders are excluded; everything else is "active".
const INACTIVE_ORDER_STATES = ['dispatched', 'resolved_dispatched', 'rejected'];

// Eligible items for a Sent or Returned trip.
//  • sent     → plating items NOT currently out (null / returned)
//  • returned → items currently out_for_plating, PLUS never-tracked items
//               (status NULL) so returns of goods sent before this feature
//               existed can still be recorded — flagged never_sent for the UI.
router.get('/eligible', authenticate, authorize('accounts', 'owner', 'admin'), async (req, res) => {
  try {
    const db = getDB();
    const direction = req.query.direction === 'returned' ? 'returned' : 'sent';
    const statusCond = direction === 'sent'
      ? `(oi.plating_status IS NULL OR oi.plating_status <> 'out_for_plating')`
      : `(oi.plating_status = 'out_for_plating' OR oi.plating_status IS NULL)`;
    const rows = await db.all(`
      SELECT oi.id AS order_item_id, oi.drawing_number, oi.product_code, oi.quantity,
             oi.plating_instructions, oi.plating_status,
             (oi.plating_status IS NULL) AS never_sent,
             o.id AS order_id, o.order_code, o.status AS order_status,
             c.customer_code, c.name AS customer_name,
             (SELECT pt.vendor FROM plating_trip_items pti JOIN plating_trips pt ON pt.id = pti.trip_id
              WHERE pti.order_item_id = oi.id AND pt.direction = 'sent' ORDER BY pt.id DESC LIMIT 1) AS last_vendor
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN customers c ON c.id = o.customer_id
      WHERE oi.plating_instructions ~* $1
        AND o.status <> ALL($2)
        AND ${statusCond}
      ORDER BY (oi.plating_status = 'out_for_plating') DESC NULLS LAST, o.order_code, oi.id`,
      [PLATING_MATCH_SQL, INACTIVE_ORDER_STATES]);
    res.json(rows);
  } catch (e) {
    console.error('plating eligible error:', e);
    res.status(500).json({ error: 'Failed to load eligible items' });
  }
});

// Record a plating trip (sent or returned). One Cash transport bill shared by the
// selected items; per-item share = cost / item-count. Updates each item's
// plating_status and posts a Cash Account-Statement expense.
router.post('/trips', authenticate, authorize('accounts', 'owner', 'admin'), async (req, res) => {
  try {
    const db = getDB();
    const direction = req.body.direction === 'returned' ? 'returned' : 'sent';
    const cost = Math.round(Number(req.body.transport_cost) * 100) / 100;
    const paidTo = (req.body.paid_to || '').trim();
    const vendor = (req.body.vendor || '').trim() || null;
    const tripDate = req.body.trip_date || new Date().toISOString().slice(0, 10);
    const notes = (req.body.notes || '').trim() || null;
    const itemIds = Array.isArray(req.body.item_ids)
      ? [...new Set(req.body.item_ids.map(n => parseInt(n, 10)).filter(Number.isInteger))] : [];

    if (!itemIds.length) return res.status(400).json({ error: 'Select at least one item' });
    if (!(cost >= 0)) return res.status(400).json({ error: 'Enter a valid transport cost' });
    if (!paidTo) return res.status(400).json({ error: 'Enter who the transport was paid to' });

    const items = await db.all('SELECT id, plating_status, plating_instructions FROM order_items WHERE id = ANY($1)', [itemIds]);
    if (items.length !== itemIds.length) return res.status(400).json({ error: 'Some selected items no longer exist' });
    for (const it of items) {
      if (!PLATING_MATCH_RE.test(it.plating_instructions || '')) {
        return res.status(400).json({ error: 'Only Nickel Plating / Electropolish items can be sent for plating' });
      }
      if (direction === 'sent' && it.plating_status === 'out_for_plating') {
        return res.status(400).json({ error: 'One of the items is already out for plating' });
      }
      // Returns accept out_for_plating AND never-tracked (NULL) items — goods
      // sent before this feature existed can still have their return recorded.
      if (direction === 'returned' && it.plating_status === 'returned') {
        return res.status(400).json({ error: 'One of the items was already returned from plating' });
      }
    }

    const tripId = await db.withTransaction(async (client) => {
      const desc = `Plating transport (${direction === 'sent' ? 'to vendor' : 'return'}) — ${itemIds.length} item${itemIds.length > 1 ? 's' : ''}${vendor ? ` · ${vendor}` : ''}`;
      const { rows: pe } = await client.query(
        `INSERT INTO petty_cash_entries (entry_date, entry_type, category, description, paid_to, amount, payment_method, affects_cash, created_by)
         VALUES ($1,'expense','Plating Transportation',$2,$3,$4,'cash',TRUE,$5) RETURNING id`,
        [tripDate, desc, paidTo, cost, req.user.id]);
      const { rows: tr } = await client.query(
        `INSERT INTO plating_trips (direction, vendor, paid_to, transport_cost, trip_date, notes, petty_cash_entry_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [direction, vendor, paidTo, cost, tripDate, notes, pe[0].id, req.user.id]);
      const newTripId = tr[0].id;
      for (const id of itemIds) {
        await client.query('INSERT INTO plating_trip_items (trip_id, order_item_id) VALUES ($1,$2)', [newTripId, id]);
      }
      await client.query('UPDATE order_items SET plating_status=$1 WHERE id = ANY($2)',
        [direction === 'sent' ? 'out_for_plating' : 'returned', itemIds]);
      return newTripId;
    });
    await logActivity(null, null, 'plating_trip', `Plating ${direction}: ${itemIds.length} item(s), transport ₹${cost}`, req.user.id);
    res.status(201).json({ id: tripId });
  } catch (e) {
    console.error('plating trip error:', e);
    res.status(500).json({ error: 'Failed to record plating trip' });
  }
});

// Trip history with the items in each and per-item share of the transport.
router.get('/trips', authenticate, authorize('accounts', 'owner', 'admin'), async (req, res) => {
  try {
    const db = getDB();
    const trips = await db.all(`
      SELECT pt.*, u.name AS created_by_name,
        (SELECT COUNT(*) FROM plating_trip_items x WHERE x.trip_id = pt.id) AS item_count
      FROM plating_trips pt LEFT JOIN users u ON u.id = pt.created_by
      ORDER BY pt.trip_date DESC, pt.id DESC LIMIT 200`);
    for (const t of trips) {
      t.items = await db.all(`
        SELECT oi.id AS order_item_id, oi.drawing_number, oi.product_code, o.order_code
        FROM plating_trip_items pti
        JOIN order_items oi ON oi.id = pti.order_item_id
        JOIN orders o ON o.id = oi.order_id
        WHERE pti.trip_id = $1 ORDER BY oi.id`, [t.id]);
      const n = Number(t.item_count) || 1;
      t.per_item_share = Math.round((Number(t.transport_cost) / n) * 100) / 100;
    }
    res.json(trips);
  } catch (e) {
    console.error('plating trips error:', e);
    res.status(500).json({ error: 'Failed to load plating trips' });
  }
});

module.exports = router;
