// A purchase order's totals and standing, worked out from its lines.
//
// Short close (owner's rule, 30 Sep 2026): a short-closed line is a balance the
// supplier is not sending. It stays on the PO's QC view with its reason, but
// the PO itself changes to the actual numbers as final: its total is the lines
// that remain, and the short-closed balance no longer holds it open.

const QC_RESOLVED = ['approved', 'rejected', 'partial'];

// Totals carry paise up to the tax line, then the payable is rounded to the
// nearest rupee the way a supplier bill does — the difference is kept as
// round_off so the arithmetic on the printed PO still adds up.
function calcTotals(items, transportCharges, igstPercent) {
  const subtotal = items.reduce((s, i) => s + i.amount, 0) + Number(transportCharges || 0);
  const igstAmount = Math.round(subtotal * (igstPercent / 100) * 100) / 100;
  const beforeRounding = Math.round((subtotal + igstAmount) * 100) / 100;
  const grandTotal = Math.round(beforeRounding);
  const roundOff = Math.round((grandTotal - beforeRounding) * 100) / 100;
  return { subtotal, igstAmount, grandTotal, roundOff };
}

// Rewrite the PO's totals from the lines still expected.
async function recomputePoTotals(db, poId) {
  const po = await db.get('SELECT id, transport_charges, igst_percent FROM purchase_orders WHERE id=$1', [poId]);
  if (!po) return null;
  const lines = await db.all(
    'SELECT amount FROM purchase_order_items WHERE po_id=$1 AND NOT short_closed', [poId]);
  const t = calcTotals(lines.map(l => ({ amount: Number(l.amount) || 0 })),
    po.transport_charges, Number(po.igst_percent) || 0);
  await db.run(
    'UPDATE purchase_orders SET subtotal=$1, igst_amount=$2, round_off=$3, grand_total=$4 WHERE id=$5',
    [t.subtotal, t.igstAmount, t.roundOff, t.grandTotal, poId]);
  return t;
}

// Where the PO stands, from its lines. Returns 'cancelled', 'received' or 'open'.
//   - every line short-closed: nothing is coming, the order is cancelled;
//   - every remaining line QC-resolved: received (material_rejected when a
//     line was rejected outright — the debit note carries that);
//   - otherwise open. A PO that had closed and has a balance again (a
//     short close reopened) goes back to waiting for it.
// `receivedAt: 'now'` stamps the moment the last QC finished, which is what the
// QC route has always done. Otherwise the date is when the remaining goods
// actually arrived, so a PO closed by a short close stays in its real month on
// Payments Due rather than moving to the day of the short close.
async function settlePoStatus(db, poId, { receivedAt } = {}) {
  const po = await db.get('SELECT id, status, delivery_status FROM purchase_orders WHERE id=$1', [poId]);
  if (!po) return null;
  const items = await db.all(
    'SELECT received, received_at, qc_status, qc_at, short_closed FROM purchase_order_items WHERE po_id=$1', [poId]);
  const open = items.filter(i => !i.short_closed);

  if (!open.length) {
    if (po.status !== 'approved' || po.delivery_status !== 'order_cancelled') {
      await db.run(
        "UPDATE purchase_orders SET status='approved', delivery_status='order_cancelled', received_at=NULL WHERE id=$1", [poId]);
    }
    return 'cancelled';
  }

  if (open.every(i => QC_RESOLVED.includes(i.qc_status))) {
    const delivery = open.some(i => i.qc_status === 'rejected') ? 'material_rejected' : 'received';
    if (po.status !== 'received' || po.delivery_status !== delivery) {
      if (receivedAt === 'now') {
        await db.run(
          "UPDATE purchase_orders SET status='received', received_at=NOW(), delivery_status=$1 WHERE id=$2", [delivery, poId]);
      } else {
        await db.run(
          `UPDATE purchase_orders SET status='received', delivery_status=$1,
             received_at=COALESCE((SELECT MAX(COALESCE(poi.received_at, poi.qc_at)) FROM purchase_order_items poi
                                    WHERE poi.po_id=$2 AND NOT poi.short_closed), NOW())
           WHERE id=$2`, [delivery, poId]);
      }
    }
    return 'received';
  }

  const hadClosed = po.status === 'received'
    || ['order_cancelled', 'received', 'material_rejected'].includes(po.delivery_status);
  if (hadClosed) {
    const awaitingQc = open.some(i => i.received && !QC_RESOLVED.includes(i.qc_status));
    await db.run(
      "UPDATE purchase_orders SET status='approved', received_at=NULL, delivery_status=$1 WHERE id=$2",
      [awaitingQc ? 'qc_pending' : 'purchase_accepted', poId]);
  }
  return 'open';
}

// Packaging & forwarding and GST follow the supplier's bills (owner, 2 Oct
// 2026). P&F is ONE figure per invoice — the latest confirmed for it — summed
// over the PO's received lines, so re-sending the same bill (a retry, a second
// item on the same invoice, an un-receive and receive again) never adds it
// twice. An invoice is known by its number, or — when none was typed — by the
// file name and day it was received with. Lines received without a bill keep
// the PO's own P&F as it stood before the first bill. No bill left on the PO →
// its own P&F and GST come back.
const invoiceKey = (l) => (l.invoice_no && String(l.invoice_no).trim())
  ? `no:${String(l.invoice_no).trim().toLowerCase()}`
  : `file:${l.invoice_original_name || ''}|${l.received_day || ''}`;

async function settleBillCharges(db, poId) {
  const po = await db.get(
    'SELECT transport_charges, igst_percent, pf_before_bills, gst_before_bills FROM purchase_orders WHERE id=$1', [poId]);
  if (!po) return;
  const lines = await db.all(
    `SELECT id, invoice_no, invoice_original_name, to_char(received_at, 'YYYY-MM-DD') AS received_day,
            billed_pf, billed_qty
       FROM purchase_order_items WHERE po_id=$1 AND received ORDER BY id`, [poId]);
  const withPf = lines.filter(l => l.billed_pf != null);
  if (withPf.length) {
    const perInvoice = new Map();
    for (const l of withPf) perInvoice.set(invoiceKey(l), Number(l.billed_pf) || 0);
    const fromBills = [...perInvoice.values()].reduce((s, v) => s + v, 0);
    const unbilled = lines.some(l => l.billed_pf == null);
    const base = unbilled ? Number(po.pf_before_bills || 0) : 0;
    const pf = Math.round((base + fromBills) * 100) / 100;
    if (Math.abs(pf - (Number(po.transport_charges) || 0)) > 1e-9) {
      await db.run('UPDATE purchase_orders SET transport_charges=$1 WHERE id=$2', [pf, poId]);
    }
  } else if (po.pf_before_bills != null) {
    await db.run('UPDATE purchase_orders SET transport_charges=pf_before_bills, pf_before_bills=NULL WHERE id=$1', [poId]);
  }
  const anyBill = lines.some(l => l.billed_qty != null || l.billed_pf != null || (l.invoice_no && String(l.invoice_no).trim()));
  if (!anyBill && po.gst_before_bills != null) {
    await db.run('UPDATE purchase_orders SET igst_percent=gst_before_bills, gst_before_bills=NULL WHERE id=$1', [poId]);
  }
}

module.exports = { calcTotals, recomputePoTotals, settlePoStatus, settleBillCharges, QC_RESOLVED };
