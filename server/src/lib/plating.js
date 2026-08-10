// Shared rules for the external-coating flow, used by the plating routes (which
// record trips) and by the Account-Statement delete path (which unwinds them).
// Keeping them in one place stops the two sides drifting apart.

// Which plating_instructions go out to an external vendor. Matched loosely so
// legacy free-text values ("nickle plating", "Electro Polish", "PTFE") qualify.
const PLATING_MATCH_SQL = 'nickel|nickle|electro|teflon|ptfe';
const PLATING_MATCH_RE = /nickel|nickle|electro|teflon|ptfe/i;

// Vendors the goods never come back from. Peena Traders is the company's own
// Mumbai arm — Teflon items sent there are handed over for good, so they are
// marked 'transferred' instead of 'out_for_plating': no return leg is expected
// and they drop off the return list. The order itself carries on to QC and
// dispatch as normal (plating_status gates nothing downstream).
const ONE_WAY_VENDORS = ['Peena Traders'];
const isOneWayVendor = (vendor) =>
  ONE_WAY_VENDORS.some(v => v.toLowerCase() === String(vendor || '').trim().toLowerCase());

// Terminal states an item can hold: it is away and not selectable for a new send.
const AWAY_STATUSES = ['out_for_plating', 'transferred'];

// What a 'sent' trip leaves its items in, given the vendor it went to.
const sentStatus = (vendor) => (isOneWayVendor(vendor) ? 'transferred' : 'out_for_plating');

// What an item reverts to when a trip is deleted, based on the trip that
// preceded it (direction + vendor). Null = never tracked.
const statusAfterTrip = (direction, vendor) =>
  direction === 'sent' ? sentStatus(vendor) : 'returned';

module.exports = {
  PLATING_MATCH_SQL, PLATING_MATCH_RE,
  ONE_WAY_VENDORS, isOneWayVendor, AWAY_STATUSES,
  sentStatus, statusAfterTrip,
};
