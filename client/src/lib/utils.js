import { format, parseISO, differenceInDays } from 'date-fns';

// Stages that require worker name (all stages up to and including stage 27, before QC)
export const WORKER_NAME_STAGES = new Set([1,2,3,4,5,6,7,8,9,10,11,12,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28]);
// Stage 16 (In Plating) is done by an outside plating vendor, so it records the
// vendor picked from this list instead of worker names (owner, 3 Oct 2026). The
// vendor goes in the same field, so every place that shows who did a stage
// shows the vendor. Kept in sync with server/src/lib/plating.js.
export const PLATING_STAGE = 16;
export const PLATING_COMPANIES = ['A S Plating', 'Aesha Plating', 'Akshar Enterprise', 'Palsto Coat', 'Peena Traders'];
// Stages that have an optional scrap value
export const SCRAP_VALUE_STAGES = new Set([1, 3, 4, 5, 11, 21, 26]);

export const PRODUCTION_STAGES = [
  { no: 1,  name: 'Coil',               gaugeSelect: true },
  { no: 2,  name: 'Coil + Tube Cutting', optional: true },
  { no: 3,  name: 'Ohms',               fields: [{ key: 'value1', label: 'Ohms Value' }, { key: 'value2', label: 'Coil Length' }], coilWeight: true },
  { no: 4,  name: 'Spot',               fields: [{ key: 'value1', label: 'Spot Value' }] },
  { no: 5,  name: 'Tube Cutting',       fields: [{ key: 'value1', label: 'Value' }] },
  { no: 6,  name: 'Filling' },
  { no: 7,  name: 'HV + Light Check',   hvLight: true },
  { no: 8,  name: 'Draw',               fields: [{ key: 'value1', label: 'Total Length' }] },
  { no: 9,  name: 'HV + Light Check',   hvLight: true },
  { no: 10, name: 'Straightening' },
  { no: 11, name: 'Trimming' },
  { no: 12, name: 'Spot Annealing or Furnace Annealing' },
  { no: 13, name: 'Buffing',            optional: true },
  { no: 14, name: 'Bending',            heaterAdjust: true, photoRequired: true },
  // Kharoch Process (stage 30, optional, after Bending) was removed on 2 Oct 2026
  // (owner). Past ticks stay in the records; reports still name stage 30.
  { no: 15, name: 'Brazing',            optional: true, brazing: true },
  { no: 16, name: 'In Plating',          optional: true },
  { no: 17, name: 'Plating Completed',  optional: true },
  { no: 18, name: 'Heater Cleaning',    note: 'Use Alcohol and Thinner', fields: [{ key: 'value1', label: 'Remark' }] },
  { no: 19, name: 'Overnight Oven' },
  { no: 20, name: 'HV + Light Check',   hvLight: true },
  { no: 21, name: 'Nipple Press',       optional: true, pressureCheck: true },
  { no: 22, name: '3 Hours Oven',       optional: true },
  { no: 23, name: 'Sealing' },
  { no: 24, name: 'HV + Light Check',   hvLight: true },
  { no: 25, name: 'Cleaning',           photo: true },
  { no: 26, name: 'Nut Washer' },
  { no: 27, name: 'HV + Light Check',   hvLight: true },
  { no: 28, name: 'Megger',             fields: [{ key: 'value1', label: 'Megger Value', required: true }] },
  { no: 29, name: 'Ready in Production', triggerQC: true, isDispatch: true, photoRequired: true },
];

// Stages that must be completed before Stage 29 (QC) can be triggered.
// Optional stages excluded: 2 (Coil+Tube), 15 (Brazing), 18 (Heater Cleaning), 21 (Nipple Press), 22 (3hrs Oven).
// Optional stages excluded: 2 (Coil+Tube), 15 (Brazing), 16 (In Plating), 17 (Plating Completed), 18 (Heater Cleaning), 21 (Nipple Press), 22 (3hrs Oven).
export const MANDATORY_STAGE_NOS = [1,3,4,5,6,7,8,9,10,11,12,14,19,20,23,24,25,26,27,28];

// Short checklist for finished-goods inventory job cards (jc.is_fg):
// material comes from the Finished Goods store, so only finishing + tests run.
export const FG_STAGES = [
  { no: 1, name: 'Nut Washer' },
  { no: 2, name: 'HV + Light Check + Ohms', fgHvOhms: true },
  { no: 3, name: 'Megger', fields: [{ key: 'value1', label: 'Megger Value', required: true }] },
  { no: 4, name: 'Ready for Dispatch', triggerQC: true, isDispatch: true },
];

// Stage list for a job card — FG inventory cards run the short checklist.
export function stagesFor(jc) {
  return jc?.is_fg ? FG_STAGES : PRODUCTION_STAGES;
}

export function getStageLabel(stageNo, jc) {
  if (!stageNo) return null;
  const s = stagesFor(jc).find(st => st.no === stageNo);
  return s ? `Stage ${stageNo}: ${s.name}` : null;
}

// True while the card still has a dispatch ahead of it. Terminal states and
// cards whose entire qty went to Finished Goods have nothing to dispatch, so
// "Xd overdue / Xd to dispatch" badges are meaningless for them.
export function dispatchPending(jc) {
  if (!jc) return false;
  // 'rejected': every piece failed in production, closed after Inventory QC — nothing to dispatch
  if (['dispatched', 'completed', 'repaired_dispatched', 'resolved_dispatched', 'rejected', 'scrapped'].includes(jc.status)) return false;
  if (jc.qc_route === 'finished_goods' && (Number(jc.qc_dispatch_qty) || 0) === 0) return false;
  return true;
}

export function fmtDate(d) {
  if (!d) return '—';
  try { return format(typeof d === 'string' ? parseISO(d) : d, 'dd MMM yyyy'); }
  catch { return d; }
}

// A date as a date-input value (YYYY-MM-DD), in the viewer's local time.
export function toDateInput(d) {
  if (!d) return '';
  try { return format(typeof d === 'string' ? parseISO(d) : d, 'yyyy-MM-dd'); }
  catch { return ''; }
}
// Today in India as YYYY-MM-DD — the default Paid On for a payment made today.
export function istTodayInput() {
  return new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
}

export function fmtDateTime(d) {
  if (!d) return '—';
  try { return format(typeof d === 'string' ? parseISO(d) : d, 'dd MMM yyyy, h:mm a'); }
  catch { return d; }
}

export function daysUntil(dateStr) {
  if (!dateStr) return null;
  return differenceInDays(parseISO(dateStr), new Date());
}

export function dispatchUrgency(dateStr) {
  const d = daysUntil(dateStr);
  if (d === null) return 'normal';
  if (d < 0) return 'overdue';
  if (d <= 3) return 'urgent';
  if (d <= 7) return 'soon';
  return 'normal';
}

export const STATUS_LABELS = {
  pending_approval: 'Pending Approval',
  approved:         'Approved',
  rejected:         'Rejected',
  job_card_created: 'Job Card Created',
  in_progress:      'In Progress',
  on_hold:          'On Hold',
  qc_pending:       'QC Pending',
  // Product QC passed, waiting for Inventory QC (owner, 6 Oct 2026)
  inventory_qc:     'Inventory QC',
  qc_approved:      'QC Approved',
  in_finished_goods: 'In Finished Goods',
  packaging:        'Packaging',
  dispatched:       'Dispatched',
  partially_dispatched: 'Partly Dispatched',
  pending:          'Pending',
  completed:        'Completed',
  customer_query:      'Query Raised',
  product_return:      'Product Return',
  resolved_dispatched: 'Query Resolved',
  repair_in_progress:  'Repair In Progress',
  repaired_dispatched: 'Repaired & Dispatched',
  // a returned heater that failed QC and was scrapped (owner, 7 Oct 2026)
  scrapped:            'Scrapped',
};

export const STATUS_COLORS = {
  // Order statuses
  pending_approval: 'bg-yellow-100 text-yellow-800',
  approved:         'bg-green-100 text-green-800',
  rejected:         'bg-red-100 text-red-800',
  job_card_created: 'bg-blue-100 text-blue-800',
  in_progress:      'bg-orange-100 text-orange-800',
  on_hold:          'bg-red-100 text-red-800',
  qc_pending:       'bg-purple-100 text-purple-800',
  inventory_qc:     'bg-indigo-100 text-indigo-800',
  qc_approved:      'bg-green-100 text-green-800',
  in_finished_goods: 'bg-teal-100 text-teal-800',
  packaging:        'bg-teal-100 text-teal-800',
  dispatched:       'bg-gray-100 text-gray-700',
  // Some cards out, some still running — an open order, so it reads warm
  // rather than the closed grey of a finished one.
  partially_dispatched: 'bg-amber-100 text-amber-800',
  // Job card statuses
  pending:          'bg-yellow-100 text-yellow-800',
  completed:        'bg-green-100 text-green-800',
  // Customer query statuses
  customer_query:      'bg-amber-100 text-amber-800',
  product_return:      'bg-rose-100 text-rose-800',
  resolved_dispatched: 'bg-green-100 text-green-700',
  repair_in_progress:  'bg-orange-100 text-orange-800',
  repaired_dispatched: 'bg-teal-100 text-teal-800',
  scrapped:            'bg-red-100 text-red-800',
};

export const ROLE_LABELS = {
  owner:      'Owner',
  admin:      'Admin',
  accounts:   'Accounts',
  design:     'Design / QC',
  production: 'Production',
};

export const ROLE_COLORS = {
  owner:      'bg-purple-100 text-purple-800',
  admin:      'bg-blue-100 text-blue-800',
  accounts:   'bg-green-100 text-green-800',
  design:     'bg-orange-100 text-orange-800',
  production: 'bg-red-100 text-red-800',
};

export const ACTIVITY_ICONS = {
  order_created:          '📋',
  order_approved:         '✅',
  order_rejected:         '❌',
  job_card_created:       '🗂️',
  assembly_added:         '⚙️',
  drawing_uploaded:       '📐',
  inventory_dispatched:   '📦',
  raw_material_dispatched:'🔩',
  production_report:      '🔧',
  qc_report:              '🔍',
  package_photo_uploaded: '📸',
  dispatch_doc_uploaded:  '📄',
  dispatched:             '🚚',
  status_changed:         '🔄',
  customer_query_raised:  '❓',
  customer_query_resolved:'✅',
  product_return_initiated:'🔙',
  repair_started:         '🔧',
  repair_dispatched:      '🚚',
  debit_note_qc:          '📝',
  debit_note_added:       '📄',
  debit_note_issued:      '📋',
  return_qc_pass:         '✅',
  return_qc_fail:         '❌',
};

// ── Phonetic transliteration: Latin → Hindi (Devanagari) ─────────────────────
export function transliterateHindi(text) {
  if (!text) return '';
  const map = [
    // Digraphs first
    ['sh','श'],['kh','ख'],['gh','घ'],['ch','च'],['jh','झ'],
    ['th','थ'],['dh','ध'],['ph','फ'],['bh','भ'],['rh','ड़'],
    ['aa','आ'],['ee','ई'],['oo','ऊ'],
    // Singles
    ['a','अ'],['b','ब'],['c','क'],['d','द'],['e','ए'],
    ['f','फ'],['g','ग'],['h','ह'],['i','इ'],['j','ज'],
    ['k','क'],['l','ल'],['m','म'],['n','न'],['o','ओ'],
    ['p','प'],['q','क'],['r','र'],['s','स'],['t','त'],
    ['u','उ'],['v','व'],['w','व'],['x','क्स'],['y','य'],['z','ज़'],
    // Digits → Devanagari
    ['0','०'],['1','१'],['2','२'],['3','३'],['4','४'],
    ['5','५'],['6','६'],['7','७'],['8','८'],['9','९'],
  ];
  let result = '';
  let i = 0;
  const lower = text.toLowerCase();
  while (i < lower.length) {
    let matched = false;
    for (const [from, to] of map) {
      if (lower.startsWith(from, i)) {
        result += to;
        i += from.length;
        matched = true;
        break;
      }
    }
    if (!matched) { result += text[i]; i++; }
  }
  return result;
}

// ── Phonetic transliteration: Latin → Gujarati ────────────────────────────────
export function transliterateGujarati(text) {
  if (!text) return '';
  const map = [
    // Digraphs first
    ['sh','શ'],['kh','ખ'],['gh','ઘ'],['ch','ચ'],['jh','ઝ'],
    ['th','થ'],['dh','ધ'],['ph','ફ'],['bh','ભ'],
    ['aa','આ'],['ee','ઈ'],['oo','ઊ'],
    // Singles
    ['a','અ'],['b','બ'],['c','ક'],['d','દ'],['e','એ'],
    ['f','ફ'],['g','ગ'],['h','હ'],['i','ઈ'],['j','જ'],
    ['k','ક'],['l','લ'],['m','મ'],['n','ન'],['o','ઓ'],
    ['p','પ'],['q','ક'],['r','ર'],['s','સ'],['t','ત'],
    ['u','ઉ'],['v','વ'],['w','વ'],['x','ક્સ'],['y','ય'],['z','ઝ'],
    // Digits → Gujarati
    ['0','૦'],['1','૧'],['2','૨'],['3','૩'],['4','૪'],
    ['5','૫'],['6','૬'],['7','૭'],['8','૮'],['9','૯'],
  ];
  let result = '';
  let i = 0;
  const lower = text.toLowerCase();
  while (i < lower.length) {
    let matched = false;
    for (const [from, to] of map) {
      if (lower.startsWith(from, i)) {
        result += to;
        i += from.length;
        matched = true;
        break;
      }
    }
    if (!matched) { result += text[i]; i++; }
  }
  return result;
}

// Terminal pins come from the job card (taken at Spot, not on the list) for
// orders after ORD-160-26 (orders.id 452) — owner, 8 Oct 2026. Same cut-off as
// the server's lib/terminals.js PINS_RULE.
export const PINS_FROM_CARD_AFTER_ORDER_ID = 452;
export const pinsFromCard = (orderId) => Number(orderId) > PINS_FROM_CARD_AFTER_ORDER_ID;

export async function downloadExcel(exportType, filename) {
  // Uses fetch directly to avoid circular import with api.js
  const r = await fetch(`/api/export/${exportType}`, { credentials: 'include' });
  if (!r.ok) { alert('Export failed'); return; }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `${exportType}_export.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Job cards / orders that have already left the building. 'dispatched' is the
// normal path; a resolved customer query ends at 'resolved_dispatched' and a
// repaired return at 'repaired_dispatched' — all three are done, so none of
// them belong in "upcoming"/"urgent"/"active" lists.
export const DISPATCHED_STATUSES = ['dispatched', 'resolved_dispatched', 'repaired_dispatched', 'in_finished_goods'];
export const isDispatched = (status) => DISPATCHED_STATUSES.includes(status);

// QC can route a card's whole quantity into Finished Goods stock. Those cards
// stay 'qc_approved' (the inventory settle keys off exactly that state), but
// there is nothing left to send — the dispatch endpoint refuses them too. So
// they are finished work and must not appear in upcoming/urgent dispatch lists.
export const isAllToFinishedGoods = (jc) =>
  jc?.status === 'qc_approved' && jc?.qc_route === 'finished_goods'
  && (Number(jc?.qc_dispatch_qty) || 0) === 0;

// One question the whole UI should ask: is this card still waiting to go out?
export const awaitingDispatch = (jc) => !isDispatched(jc?.status) && !isAllToFinishedGoods(jc);

// A CAPA holds work up only while it is open or awaiting the owner's approval.
// 'approved' and 'waived' are both settled — so every banner and gate asks this
// one question rather than testing for 'approved' and silently ignoring a waive.
export const capaBlocks = (status) => status === 'open' || status === 'awaiting_approval';

// Order types, named the same everywhere.
export const ORDER_TYPE_LABELS = {
  local_he: 'Local HE', export_he: 'Export HE', inventory_order: 'Inventory Order',
  io_local_he: 'IO + Local HE', io_export_he: 'IO + Export HE', finished_goods: 'Finished Goods',
};
export const ORDER_TYPE_COLORS = {
  local_he: 'bg-blue-50 text-blue-700', export_he: 'bg-purple-100 text-purple-700',
  inventory_order: 'bg-amber-100 text-amber-700', io_local_he: 'bg-teal-100 text-teal-700',
  io_export_he: 'bg-orange-100 text-orange-700', finished_goods: 'bg-emerald-100 text-emerald-700',
};
export const orderTypeLabel = (t) => ORDER_TYPE_LABELS[t || 'local_he'] || t;
// Groups whose inventory lists can be reused for one another — a list is never
// carried across groups (owner, 3 Oct 2026). Mirrors server/src/lib/bom.js.
const BOM_FAMILY_OF = { finished_goods: 'fg', inventory_order: 'inventory' };
export const bomFamily = (t) => BOM_FAMILY_OF[t || 'local_he'] || 'he';
export const BOM_FAMILY_LABELS = { fg: 'Finished Goods', inventory: 'Inventory Order', he: 'Local HE / Export HE' };
// What happens to a reused item's inventory list on an order of `orderType`.
// `src` is the picked previous item ({ order_type, inventory_items } or { order_type, has_list }).
export const reuseListNote = (src, orderType) => {
  if (!src) return '';
  const sameGroup = bomFamily(src.order_type) === bomFamily(orderType);
  const hasList = src.has_list ?? ((src.inventory_items?.length || 0) > 0);
  if (sameGroup && hasList) return 'Its inventory list is copied too, re-sized to this quantity.';
  const why = sameGroup ? 'it has no inventory list' : `it was a ${orderTypeLabel(src.order_type)} order`;
  return `Its inventory list is not used (${why}) — the list comes from the last ${BOM_FAMILY_LABELS[bomFamily(orderType)]} order with this drawing, or design adds one.`;
};

// Units written different ways that mean the same thing (pcs = nos, kg = kgs,
// foot = ft …). A PO line may be bought in another unit from its item's; stock
// always comes in in the item's unit (owner, 3 Oct 2026). Mirrors
// server/src/lib/units.js.
export const UNIT_GROUPS = [
  ['pc', 'pcs', 'piece', 'pieces', 'no', 'nos', 'number', 'numbers', 'each', 'ea', 'unit', 'units'],
  ['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms'], ['ft', 'foot', 'feet'],
  ['m', 'mtr', 'mtrs', 'metre', 'metres', 'meter', 'meters'], ['g', 'gm', 'gms', 'gram', 'grams'],
  ['set', 'sets'], ['box', 'boxes'], ['l', 'ltr', 'ltrs', 'litre', 'litres', 'liter', 'liters'],
];
const normUnit = (u) => String(u || '').trim().toLowerCase().replace(/\.$/, '');
const unitKey = (u) => { const s = normUnit(u); const g = UNIT_GROUPS.findIndex(x => x.includes(s)); return g >= 0 ? `g${g}` : s; };
export const sameUnit = (a, b) => !normUnit(a) || !normUnit(b) || unitKey(a) === unitKey(b);
// Weighed lines: a difference within 0.5% is scale noise (owner, 3 Oct 2026).
// Mirrors server/src/lib/units.js.
export const WEIGHT_TOLERANCE = 0.005;
export const isWeightUnit = (u) => { const k = unitKey(u); return k === unitKey('kg') || k === unitKey('g'); };
export const weighAllowance = (unit, base) => (isWeightUnit(unit) ? Math.abs(Number(base) || 0) * WEIGHT_TOLERANCE : 0);
// Units a PO line can be bought in (the item's own unit is always offered too).
export const PO_UNITS = ['pcs', 'kgs', 'foot', 'mtr', 'liters', 'boxes', 'set'];

// A date, or "first – last" when things happened on different days (e.g. the
// lines of one PO received over several deliveries).
export const fmtDateSpan = (first, last) => {
  if (!first && !last) return '';
  const a = fmtDate(first || last), b = fmtDate(last || first);
  return a === b ? a : `${a} – ${b}`;
};

// Stage 3 coil (owner, 9 Oct 2026): typed in GRAMS from then on and kept in kg;
// coil_unit 'g' marks such a row. Rows ticked before still read in kg.
export const kgToG = (v) => Math.round(Number(v) * 1000 * 1000) / 1000;
export function coilWeightText(row) {
  if (row?.coil_weight == null) return '—';
  return row.coil_unit === 'g' ? `${kgToG(row.coil_weight)} g` : `${row.coil_weight} kg`;
}
export function stageScrapText(row, stageNo) {
  if (stageNo === 3 && row?.coil_unit === 'g' && row?.scrap_value != null && String(row.scrap_value) !== '') return `${kgToG(row.scrap_value)} g`;
  return row?.scrap_value;
}
