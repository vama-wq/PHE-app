import { format, parseISO, differenceInDays } from 'date-fns';

// Stages that require worker name (all stages up to and including stage 27, before QC)
export const WORKER_NAME_STAGES = new Set([1,2,3,4,5,6,7,8,9,10,11,12,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28]);
// Stages that have an optional scrap value
export const SCRAP_VALUE_STAGES = new Set([1, 3, 4, 5, 11, 21, 26]);

export const PRODUCTION_STAGES = [
  { no: 1,  name: 'Coil' },
  { no: 2,  name: 'Coil + Tube Cutting', optional: true },
  { no: 3,  name: 'Ohms',               fields: [{ key: 'value1', label: 'Ohms Value' }, { key: 'value2', label: 'Coil Length' }] },
  { no: 4,  name: 'Spot',               fields: [{ key: 'value1', label: 'Spot Value' }] },
  { no: 5,  name: 'Tube Cutting',       fields: [{ key: 'value1', label: 'Value' }] },
  { no: 6,  name: 'Filling' },
  { no: 7,  name: 'HV + Light Check',   hvLight: true },
  { no: 8,  name: 'Draw',               fields: [{ key: 'value1', label: 'Total Length' }] },
  { no: 9,  name: 'HV + Light Check',   hvLight: true },
  { no: 10, name: 'Straightening' },
  { no: 11, name: 'Trimming' },
  { no: 12, name: 'Spot Annealing or Furnace Annealing' },
  { no: 14, name: 'Bending',            heaterAdjust: true },
  { no: 15, name: 'Brazing',            optional: true, brazing: true },
  { no: 16, name: 'In Plating',          optional: true },
  { no: 17, name: 'Plating Completed',  optional: true },
  { no: 18, name: 'Heater Cleaning',    note: 'Use Alcohol and Thinner', fields: [{ key: 'value1', label: 'Remark' }] },
  { no: 19, name: 'Overnight Oven' },
  { no: 20, name: 'HV + Light Check',   hvLight: true },
  { no: 21, name: 'Nipple Press',       optional: true },
  { no: 22, name: '3 Hours Oven',       optional: true },
  { no: 23, name: 'Sealing' },
  { no: 24, name: 'HV + Light Check',   hvLight: true },
  { no: 25, name: 'Cleaning',           photo: true },
  { no: 26, name: 'Nut Washer' },
  { no: 27, name: 'HV + Light Check',   hvLight: true },
  { no: 28, name: 'Ohms + Meggar',      fields: [{ key: 'value1', label: 'Remark' }] },
  { no: 29, name: 'Ready in Production', triggerQC: true, isDispatch: true, photoRequired: true },
];

// Stages that must be completed before Stage 29 (QC) can be triggered.
// Optional stages excluded: 2 (Coil+Tube), 15 (Brazing), 18 (Heater Cleaning), 21 (Nipple Press), 22 (3hrs Oven).
// Optional stages excluded: 2 (Coil+Tube), 15 (Brazing), 16 (In Plating), 17 (Plating Completed), 18 (Heater Cleaning), 21 (Nipple Press), 22 (3hrs Oven).
export const MANDATORY_STAGE_NOS = [1,3,4,5,6,7,8,9,10,11,12,14,19,20,23,24,25,26,27,28];

export function getStageLabel(stageNo) {
  if (!stageNo) return null;
  const s = PRODUCTION_STAGES.find(st => st.no === stageNo);
  return s ? `Stage ${stageNo}: ${s.name}` : null;
}

export function fmtDate(d) {
  if (!d) return '—';
  try { return format(typeof d === 'string' ? parseISO(d) : d, 'dd MMM yyyy'); }
  catch { return d; }
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
  qc_approved:      'QC Approved',
  packaging:        'Packaging',
  dispatched:       'Dispatched',
  pending:          'Pending',
  completed:        'Completed',
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
  qc_approved:      'bg-green-100 text-green-800',
  packaging:        'bg-teal-100 text-teal-800',
  dispatched:       'bg-gray-100 text-gray-700',
  // Job card statuses
  pending:          'bg-yellow-100 text-yellow-800',
  completed:        'bg-green-100 text-green-800',
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
};

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
