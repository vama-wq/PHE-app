const router = require('express').Router();
const { getDB, logActivity } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

// Only nickel-plating / electropolish / teflon-coating items go to an external
// vendor (Buffing / No Plating stay in-house); one-way vendors never return the
// goods. Both rules live in lib/plating.js so the delete/unwind path agrees.
const {
  PLATING_MATCH_SQL, PLATING_MATCH_RE, PLATING_COMPANIES, isOneWayVendor, sentStatus,
} = require('../lib/plating');
// Terminal / not-yet-started orders are excluded; everything else is "active".
const INACTIVE_ORDER_STATES = ['dispatched', 'resolved_dispatched', 'rejected'];

// Eligible items for a Sent or Returned trip.
//  • sent     → plating items NOT currently out (null / returned)
//  • returned → only items currently out_for_plating (legacy untracked items
//               are surfaced on the SEND side; a one-off data fix marks any
//               known already-at-plating item as out_for_plating).
router.get('/eligible', authenticate, authorize('accounts', 'owner', 'admin'), async (req, res) => {
  try {
    const db = getDB();
    const direction = req.query.direction === 'returned' ? 'returned' : 'sent';
    // Sent → anything not currently out at a vendor. A 'transferred' item stays
    // sendable: one order item often ships in several consignments (partial
    // dispatch splits and remakes share the parent's order_item_id), so a later
    // batch must still be recordable. Returned → only what is actually out.
    // Keyed on the CARD: an item over 50 pieces runs as several cards whose
    // batches reach the plater at different times, and a flag on the item could
    // not record the second while the first was out.
    // Sent → any card not currently at a vendor. A 'transferred' card stays
    // sendable (a one-way vendor keeps the goods, so no return is expected).
    // Returned → only what is actually out.
    const statusCond = direction === 'sent'
      ? `(jc.plating_status IS NULL OR jc.plating_status <> 'out_for_plating')`
      : `jc.plating_status = 'out_for_plating'`;
    const rows = await db.all(`
      SELECT jc.id AS job_card_id, jc.job_card_no, jc.qty AS card_qty, jc.plating_status,
             oi.id AS order_item_id, oi.drawing_number, oi.product_code, oi.quantity,
             oi.plating_instructions,
             o.id AS order_id, o.order_code, o.status AS order_status,
             c.customer_code, c.name AS customer_name,
             (SELECT pt.vendor FROM plating_trip_items pti JOIN plating_trips pt ON pt.id = pti.trip_id
              WHERE pti.job_card_id = jc.id AND pt.direction = 'sent' ORDER BY pt.id DESC LIMIT 1) AS last_vendor
      FROM job_cards jc
      JOIN order_items oi ON oi.id = jc.order_item_id
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN customers c ON c.id = o.customer_id
      WHERE oi.plating_instructions ~* $1
        AND o.status <> ALL($2)
        AND ${statusCond}
      ORDER BY o.order_code, jc.job_card_no`,
      [PLATING_MATCH_SQL, INACTIVE_ORDER_STATES]);
    res.json(rows);
  } catch (e) {
    console.error('plating eligible error:', e);
    res.status(500).json({ error: 'Failed to load eligible items' });
  }
});

// Record a plating trip (sent or returned). One Cash transport bill shared by the
// selected job cards; per-card share = cost / card-count. Updates each card's
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
    // A trip now carries JOB CARDS. `item_ids` is still accepted so an older
    // client (or a tab left open across the deploy) resolves to that item's
    // cards rather than failing.
    const cardIds = Array.isArray(req.body.card_ids)
      ? [...new Set(req.body.card_ids.map(n => parseInt(n, 10)).filter(Number.isInteger))]
      : Array.isArray(req.body.item_ids)
        ? (await getDB().all(
            'SELECT id FROM job_cards WHERE order_item_id = ANY($1) ORDER BY id',
            [req.body.item_ids.map(n => parseInt(n, 10)).filter(Number.isInteger)])).map(r => r.id)
        : [];

    if (!cardIds.length) return res.status(400).json({ error: 'Select at least one job card' });
    if (!(cost >= 0)) return res.status(400).json({ error: 'Enter a valid transport cost' });
    if (!paidTo) return res.status(400).json({ error: 'Enter who the transport was paid to' });
    // The vendor decides whether the goods are expected back, so a send trip
    // cannot be left blank or free-text — a wrong/missing name would silently
    // put a one-way transfer back on the return list.
    if (direction === 'sent') {
      if (!vendor) return res.status(400).json({ error: 'Select the plating vendor' });
      if (!PLATING_COMPANIES.some(c => c.toLowerCase() === vendor.toLowerCase())) {
        return res.status(400).json({ error: `Select a vendor from the list (${PLATING_COMPANIES.join(' / ')})` });
      }
    }

    const cards = await db.all(
      `SELECT jc.id, jc.job_card_no, jc.plating_status, jc.order_item_id, oi.plating_instructions
         FROM job_cards jc JOIN order_items oi ON oi.id = jc.order_item_id
        WHERE jc.id = ANY($1)`, [cardIds]);
    if (cards.length !== cardIds.length) return res.status(400).json({ error: 'Some selected job cards no longer exist' });
    for (const c of cards) {
      if (!PLATING_MATCH_RE.test(c.plating_instructions || '')) {
        return res.status(400).json({ error: 'Only Nickel Plating / Electropolish / Teflon Coating items can be sent for plating' });
      }
      // 'transferred' is deliberately NOT blocked: a one-way vendor keeps the
      // goods, so that card can go out again without a return leg.
      if (direction === 'sent' && c.plating_status === 'out_for_plating') {
        return res.status(400).json({ error: `${c.job_card_no} is already out for plating` });
      }
      if (direction === 'returned' && c.plating_status !== 'out_for_plating') {
        return res.status(400).json({ error: `${c.job_card_no} is not currently out for plating` });
      }
    }
    const itemIds = [...new Set(cards.map(c => c.order_item_id))];

    const tripId = await db.withTransaction(async (client) => {
      const leg = direction === 'sent' ? (isOneWayVendor(vendor) ? 'transfer' : 'to vendor') : 'return';
      const desc = `Plating transport (${leg}) — ${cardIds.length} card${cardIds.length > 1 ? 's' : ''}${vendor ? ` · ${vendor}` : ''}`;
      const { rows: pe } = await client.query(
        `INSERT INTO petty_cash_entries (entry_date, entry_type, category, description, paid_to, amount, payment_method, affects_cash, created_by)
         VALUES ($1,'expense','Plating Transportation',$2,$3,$4,'cash',TRUE,$5) RETURNING id`,
        [tripDate, desc, paidTo, cost, req.user.id]);
      const { rows: tr } = await client.query(
        `INSERT INTO plating_trips (direction, vendor, paid_to, transport_cost, trip_date, notes, petty_cash_entry_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [direction, vendor, paidTo, cost, tripDate, notes, pe[0].id, req.user.id]);
      const newTripId = tr[0].id;
      for (const c of cards) {
        await client.query('INSERT INTO plating_trip_items (trip_id, order_item_id, job_card_id) VALUES ($1,$2,$3)',
          [newTripId, c.order_item_id, c.id]);
      }
      // A one-way vendor (Peena Traders) keeps the goods: mark them transferred
      // so no return leg is expected and they leave the return list.
      const newStatus = direction === 'sent' ? sentStatus(vendor) : 'returned';
      await client.query('UPDATE job_cards SET plating_status=$1 WHERE id = ANY($2)', [newStatus, cardIds]);
      // The item-level flag is now a roll-up of its cards, so everything that
      // still reads it (order screens, the one-off backfills) keeps working:
      // out while ANY card is out, otherwise the furthest state reached.
      await client.query(`
        UPDATE order_items oi SET plating_status = COALESCE((
          SELECT CASE
            WHEN bool_or(j.plating_status = 'out_for_plating') THEN 'out_for_plating'
            WHEN bool_or(j.plating_status = 'transferred')     THEN 'transferred'
            WHEN bool_or(j.plating_status = 'returned')        THEN 'returned'
            ELSE NULL END
          FROM job_cards j WHERE j.order_item_id = oi.id AND j.plating_status IS NOT NULL
        ), oi.plating_status)
         WHERE oi.id = ANY($1)`, [itemIds]);
      return newTripId;
    });
    await logActivity(null, null, 'plating_trip', `Plating ${direction}: ${cards.length} job card(s), transport ₹${cost}`, req.user.id);
    res.status(201).json({ id: tripId });
  } catch (e) {
    console.error('plating trip error:', e);
    res.status(500).json({ error: 'Failed to record plating trip' });
  }
});

// Trip history with what each carried and its share of the transport. A trip
// carries job cards now; older rows name only their order item.
router.get('/trips', authenticate, authorize('accounts', 'owner', 'admin'), async (req, res) => {
  try {
    const db = getDB();
    const trips = await db.all(`
      SELECT pt.*, u.name AS created_by_name,
        (SELECT COUNT(*) FROM plating_trip_items x WHERE x.trip_id = pt.id) AS item_count
      FROM plating_trips pt LEFT JOIN users u ON u.id = pt.created_by
      ORDER BY pt.trip_date DESC, pt.id DESC LIMIT 200`);
    for (const t of trips) {
      // Trips before card-level tracking name no card; those rows still show
      // their item, so the history reads the same as it always did.
      t.items = await db.all(`
        SELECT oi.id AS order_item_id, oi.drawing_number, oi.product_code, o.order_code,
               pti.job_card_id, jc.job_card_no, jc.qty AS card_qty
        FROM plating_trip_items pti
        JOIN order_items oi ON oi.id = pti.order_item_id
        JOIN orders o ON o.id = oi.order_id
        LEFT JOIN job_cards jc ON jc.id = pti.job_card_id
        WHERE pti.trip_id = $1 ORDER BY jc.job_card_no NULLS LAST, oi.id`, [t.id]);
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
