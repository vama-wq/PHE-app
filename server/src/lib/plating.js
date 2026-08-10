// Shared rules for the external-coating flow, used by the plating routes (which
// record trips) and by the Account-Statement delete path (which unwinds them).
// Keeping them in one place stops the two sides drifting apart.

// Which plating_instructions go out to an external vendor. Matched loosely so
// legacy free-text values ("nickle plating", "Electro Polish", "PTFE") qualify.
const PLATING_MATCH_SQL = 'nickel|nickle|electro|teflon|ptfe';
const PLATING_MATCH_RE = /nickel|nickle|electro|teflon|ptfe/i;

// External coating vendors: the three electroplaters + Peena Traders (Teflon).
// Kept here so the trip route and the Plating-expense payee check agree.
const PLATING_COMPANIES = ['A S Plating', 'Aesha Plating', 'Akshar Enterprise', 'Peena Traders'];

// Vendors the goods never come back from. Peena Traders is the company's own
// Mumbai arm — Teflon items sent there are handed over for good, so they are
// marked 'transferred' instead of 'out_for_plating': no return leg is expected
// and they drop off the return list. The order itself carries on to QC and
// dispatch as normal (plating_status gates nothing downstream). A transferred
// item stays SENDABLE — the same order item can go out in several consignments.
const ONE_WAY_VENDORS = ['Peena Traders'];
const isOneWayVendor = (vendor) =>
  ONE_WAY_VENDORS.some(v => v.toLowerCase() === String(vendor || '').trim().toLowerCase());

// What a 'sent' trip leaves its items in, given the vendor it went to.
const sentStatus = (vendor) => (isOneWayVendor(vendor) ? 'transferred' : 'out_for_plating');

// What an item reverts to when a trip is deleted, based on the trip that
// preceded it (direction + vendor). Null = never tracked.
const statusAfterTrip = (direction, vendor) =>
  direction === 'sent' ? sentStatus(vendor) : 'returned';

module.exports = {
  PLATING_MATCH_SQL, PLATING_MATCH_RE, PLATING_COMPANIES,
  ONE_WAY_VENDORS, isOneWayVendor,
  sentStatus, statusAfterTrip,
};
