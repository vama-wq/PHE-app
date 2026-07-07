import { useState, useEffect, useCallback } from 'react';
import api from '../../lib/api';
import { fmtDate, fmtDateTime, downloadExcel } from '../../lib/utils';
import Modal from '../../components/ui/Modal';
import {
  BarChart2, ClipboardList, FileText, FlaskConical, Truck,
  Package, ShoppingCart, XCircle, Play, Download, Plus,
  Edit2, Trash2, BookTemplate, ChevronRight, Loader2,
  LayoutGrid, List, Save, X, Star, Clock, AlertCircle
} from 'lucide-react';

// ── Data-source definitions (columns + filter schema) ─────────────────────────

const DATA_SOURCES = {
  orders: {
    label: 'Orders',
    icon: ClipboardList,
    color: 'blue',
    columns: [
      { key: 'order_number',   label: 'Order #' },
      { key: 'customer_name',  label: 'Customer' },
      { key: 'status',         label: 'Status',        type: 'status' },
      { key: 'priority',       label: 'Priority',      type: 'priority' },
      { key: 'total_amount',   label: 'Total (₹)',     type: 'currency' },
      { key: 'advance_paid',   label: 'Advance (₹)',   type: 'currency' },
      { key: 'balance_due',    label: 'Balance (₹)',   type: 'currency' },
      { key: 'item_count',     label: 'Items' },
      { key: 'delivery_date',  label: 'Delivery Date', type: 'date' },
      { key: 'created_at',     label: 'Created',       type: 'datetime' },
    ],
    filters: [
      { key: 'status',    label: 'Status',   type: 'select', options: ['pending_approval','approved','rejected','job_card_created','in_progress','on_hold','qc_pending','qc_approved','packaging','dispatched'] },
      { key: 'priority',  label: 'Priority', type: 'select', options: ['low','medium','high','urgent'] },
      { key: 'date_from', label: 'From Date', type: 'date' },
      { key: 'date_to',   label: 'To Date',   type: 'date' },
    ],
  },
  job_cards: {
    label: 'Job Cards',
    icon: FileText,
    color: 'purple',
    columns: [
      { key: 'job_card_number', label: 'JC #' },
      { key: 'order_number',    label: 'Order #' },
      { key: 'customer_name',   label: 'Customer' },
      { key: 'product_name',    label: 'Product' },
      { key: 'quantity',        label: 'Qty' },
      { key: 'status',          label: 'Status',   type: 'status' },
      { key: 'assigned_to',     label: 'Assigned To' },
      { key: 'due_date',        label: 'Due Date', type: 'date' },
      { key: 'completed_at',    label: 'Completed', type: 'datetime' },
      { key: 'created_at',      label: 'Created',   type: 'datetime' },
    ],
    filters: [
      { key: 'status',    label: 'Status',   type: 'select', options: ['pending','in_progress','completed','on_hold'] },
      { key: 'date_from', label: 'From Date', type: 'date' },
      { key: 'date_to',   label: 'To Date',   type: 'date' },
    ],
  },
  qc: {
    label: 'QC Records',
    icon: FlaskConical,
    color: 'violet',
    columns: [
      { key: 'job_card_number', label: 'JC #' },
      { key: 'order_number',    label: 'Order #' },
      { key: 'customer_name',   label: 'Customer' },
      { key: 'product_name',    label: 'Product' },
      { key: 'status',          label: 'Status',   type: 'status' },
      { key: 'result',          label: 'Result',   type: 'qcresult' },
      { key: 'checked_by',      label: 'Checked By' },
      { key: 'observations',    label: 'Observations' },
      { key: 'checked_at',      label: 'Checked At', type: 'datetime' },
    ],
    filters: [
      { key: 'status', label: 'Status', type: 'select', options: ['pending','approved','rejected'] },
      { key: 'result', label: 'Result', type: 'select', options: ['approved','rejected'] },
      { key: 'date_from', label: 'From Date', type: 'date' },
      { key: 'date_to',   label: 'To Date',   type: 'date' },
    ],
  },
  dispatch: {
    label: 'Dispatches',
    icon: Truck,
    color: 'green',
    columns: [
      { key: 'order_number',    label: 'Order #' },
      { key: 'customer_name',   label: 'Customer' },
      { key: 'dispatch_date',   label: 'Dispatch Date', type: 'date' },
      { key: 'courier_name',    label: 'Courier' },
      { key: 'tracking_number', label: 'Tracking #' },
      { key: 'item_count',      label: 'Items' },
      { key: 'notes',           label: 'Notes' },
    ],
    filters: [
      { key: 'date_from', label: 'From Date', type: 'date' },
      { key: 'date_to',   label: 'To Date',   type: 'date' },
    ],
  },
  inventory: {
    label: 'Inventory',
    icon: Package,
    color: 'amber',
    columns: [
      { key: 'name',          label: 'Item Name' },
      { key: 'sku',           label: 'SKU' },
      { key: 'category',      label: 'Category' },
      { key: 'unit',          label: 'Unit' },
      { key: 'current_stock', label: 'Stock' },
      { key: 'min_stock',     label: 'Min Stock' },
      { key: 'fifo_cost',     label: 'FIFO Cost (₹)', type: 'currency' },
      { key: 'stock_value',   label: 'Stock Value (₹)', type: 'currency' },
      { key: 'stock_status',  label: 'Stock Status', type: 'stockstatus' },
    ],
    filters: [
      { key: 'category',     label: 'Category',     type: 'text' },
      { key: 'stock_status', label: 'Low Stock Only', type: 'checkbox', value: 'low' },
    ],
  },
  purchase_orders: {
    label: 'Purchase Orders',
    icon: ShoppingCart,
    color: 'teal',
    columns: [
      { key: 'po_number',               label: 'PO #' },
      { key: 'supplier_name',           label: 'Supplier' },
      { key: 'status',                  label: 'Status',   type: 'status' },
      { key: 'delivery_status',         label: 'Delivery Status', type: 'deliverystatus' },
      { key: 'total_amount',            label: 'Amount (₹)', type: 'currency' },
      { key: 'expected_delivery_date',  label: 'Expected Delivery', type: 'date' },
      { key: 'received_at',             label: 'Received At', type: 'datetime' },
      { key: 'notes',                   label: 'Notes' },
      { key: 'created_at',              label: 'Created', type: 'datetime' },
    ],
    filters: [
      { key: 'status',          label: 'Status',          type: 'select', options: ['draft','pending','approved','received'] },
      { key: 'delivery_status', label: 'Delivery Status', type: 'select', options: ['in_transit','material_rejected','reconfirm_order','purchase_accepted','order_cancelled','qc_pending'] },
      { key: 'date_from', label: 'From Date', type: 'date' },
      { key: 'date_to',   label: 'To Date',   type: 'date' },
    ],
  },
  rejections: {
    label: 'QC Rejections',
    icon: XCircle,
    color: 'red',
    columns: [
      { key: 'job_card_number',  label: 'JC #' },
      { key: 'order_number',     label: 'Order #' },
      { key: 'customer_name',    label: 'Customer' },
      { key: 'product_name',     label: 'Product' },
      { key: 'rejection_reason', label: 'Rejection Reason' },
      { key: 'checked_by',       label: 'Checked By' },
      { key: 'checked_at',       label: 'Rejected At', type: 'datetime' },
    ],
    filters: [
      { key: 'date_from', label: 'From Date', type: 'date' },
      { key: 'date_to',   label: 'To Date',   type: 'date' },
    ],
  },
};

// ── Standard reports preset ───────────────────────────────────────────────────

const STANDARD_REPORTS = [
  {
    id: 'active_orders',
    title: 'Active Orders',
    description: 'All non-dispatched orders with customer, status, amount and delivery dates.',
    dataSource: 'orders',
    defaultCols: ['order_number','customer_name','status','priority','total_amount','balance_due','delivery_date'],
    defaultFilters: {},
    icon: ClipboardList,
    color: 'blue',
  },
  {
    id: 'pending_job_cards',
    title: 'Pending Job Cards',
    description: 'Job cards that are still in progress or pending, grouped by product.',
    dataSource: 'job_cards',
    defaultCols: ['job_card_number','order_number','customer_name','product_name','quantity','status','due_date'],
    defaultFilters: {},
    icon: FileText,
    color: 'purple',
  },
  {
    id: 'qc_summary',
    title: 'QC Summary',
    description: 'Full QC log with approvals and rejections, linked to job cards and orders.',
    dataSource: 'qc',
    defaultCols: ['job_card_number','order_number','customer_name','product_name','result','checked_by','checked_at'],
    defaultFilters: {},
    icon: FlaskConical,
    color: 'violet',
  },
  {
    id: 'dispatch_log',
    title: 'Dispatch Log',
    description: 'All dispatches with courier, tracking number and delivery dates.',
    dataSource: 'dispatch',
    defaultCols: ['order_number','customer_name','dispatch_date','courier_name','tracking_number','item_count'],
    defaultFilters: {},
    icon: Truck,
    color: 'green',
  },
  {
    id: 'low_stock',
    title: 'Low Stock Items',
    description: 'Inventory items at or below minimum stock level with FIFO cost and total value.',
    dataSource: 'inventory',
    defaultCols: ['name','sku','category','unit','current_stock','min_stock','fifo_cost','stock_value','stock_status'],
    defaultFilters: { stock_status: 'low' },
    icon: Package,
    color: 'amber',
  },
  {
    id: 'purchase_orders_report',
    title: 'Purchase Orders',
    description: 'All purchase orders with supplier, status, delivery status and amounts.',
    dataSource: 'purchase_orders',
    defaultCols: ['po_number','supplier_name','status','delivery_status','total_amount','expected_delivery_date','created_at'],
    defaultFilters: {},
    icon: ShoppingCart,
    color: 'teal',
  },
  {
    id: 'rejection_analysis',
    title: 'QC Rejection Analysis',
    description: 'All rejected job cards with reasons and who performed the QC check.',
    dataSource: 'rejections',
    defaultCols: ['job_card_number','order_number','customer_name','product_name','rejection_reason','checked_by','checked_at'],
    defaultFilters: {},
    icon: XCircle,
    color: 'red',
  },
];

// ── Colour helpers ────────────────────────────────────────────────────────────

const COLOR_MAP = {
  blue:   { bg: 'bg-blue-50',   border: 'border-blue-200',   icon: 'text-blue-600',   badge: 'bg-blue-100 text-blue-700' },
  purple: { bg: 'bg-purple-50', border: 'border-purple-200', icon: 'text-purple-600', badge: 'bg-purple-100 text-purple-700' },
  violet: { bg: 'bg-violet-50', border: 'border-violet-200', icon: 'text-violet-600', badge: 'bg-violet-100 text-violet-700' },
  green:  { bg: 'bg-emerald-50',border: 'border-emerald-200',icon: 'text-emerald-600',badge: 'bg-emerald-100 text-emerald-700' },
  amber:  { bg: 'bg-amber-50',  border: 'border-amber-200',  icon: 'text-amber-600',  badge: 'bg-amber-100 text-amber-700' },
  teal:   { bg: 'bg-teal-50',   border: 'border-teal-200',   icon: 'text-teal-600',   badge: 'bg-teal-100 text-teal-700' },
  red:    { bg: 'bg-red-50',    border: 'border-red-200',    icon: 'text-red-600',    badge: 'bg-red-100 text-red-700' },
  gray:   { bg: 'bg-gray-50',   border: 'border-gray-200',   icon: 'text-gray-600',   badge: 'bg-gray-100 text-gray-700' },
};

// ── Cell formatters ───────────────────────────────────────────────────────────

const STATUS_COLORS = {
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
  pending:          'bg-yellow-100 text-yellow-800',
  completed:        'bg-green-100 text-green-800',
  received:         'bg-green-100 text-green-800',
  draft:            'bg-gray-100 text-gray-700',
};

const DELIVERY_COLORS = {
  in_transit:       'bg-blue-100 text-blue-800',
  material_rejected:'bg-red-100 text-red-800',
  reconfirm_order:  'bg-yellow-100 text-yellow-800',
  purchase_accepted:'bg-green-100 text-green-800',
  order_cancelled:  'bg-gray-100 text-gray-700',
  qc_pending:       'bg-purple-100 text-purple-800',
};

const DELIVERY_LABELS = {
  in_transit:        'In Transit',
  material_rejected: 'Material Rejected',
  reconfirm_order:   'Reconfirm Order',
  purchase_accepted: 'Purchase Accepted',
  order_cancelled:   'Order Cancelled',
  qc_pending:        'QC Pending',
};

const PRIORITY_COLORS = {
  low: 'bg-gray-100 text-gray-600',
  medium: 'bg-blue-100 text-blue-700',
  high: 'bg-orange-100 text-orange-700',
  urgent: 'bg-red-100 text-red-700',
};

function fmtCell(value, type) {
  if (value === null || value === undefined || value === '') return <span className="text-gray-400">—</span>;
  switch (type) {
    case 'date':     return fmtDate(value);
    case 'datetime': return fmtDateTime(value);
    case 'currency': return `₹${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case 'status':   return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[value] || 'bg-gray-100 text-gray-700'}`}>{value.replace(/_/g, ' ')}</span>;
    case 'deliverystatus': return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${DELIVERY_COLORS[value] || 'bg-gray-100 text-gray-700'}`}>{DELIVERY_LABELS[value] || value}</span>;
    case 'priority': return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium capitalize ${PRIORITY_COLORS[value] || 'bg-gray-100 text-gray-700'}`}>{value}</span>;
    case 'qcresult': return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${value === 'approved' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>{value}</span>;
    case 'stockstatus': return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${value === 'Low' ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>{value}</span>;
    default:         return String(value);
  }
}

function rawValue(value, type) {
  if (value === null || value === undefined) return '';
  switch (type) {
    case 'date':     return fmtDate(value);
    case 'datetime': return fmtDateTime(value);
    case 'deliverystatus': return DELIVERY_LABELS[value] || value;
    default: return String(value).replace(/_/g, ' ');
  }
}

// ── CSV export helper ─────────────────────────────────────────────────────────

function exportCSV(rows, columns, filename) {
  const header = columns.map(c => `"${c.label}"`).join(',');
  const body = rows.map(row =>
    columns.map(c => {
      const v = rawValue(c.key === 'customer_name' ? (row.customer_name || row.customer_code) : row[c.key], c.type);
      return `"${String(v).replace(/"/g, '""')}"`;
    }).join(',')
  ).join('\n');
  const csv = `${header}\n${body}`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'report.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Filter input renderer ─────────────────────────────────────────────────────

function FilterRow({ filterDef, value, onChange }) {
  if (filterDef.type === 'select') {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-gray-600">{filterDef.label}</label>
        <select
          value={value || ''}
          onChange={e => onChange(e.target.value || undefined)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All</option>
          {filterDef.options.map(o => (
            <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>
          ))}
        </select>
      </div>
    );
  }
  if (filterDef.type === 'date') {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-gray-600">{filterDef.label}</label>
        <input
          type="date"
          value={value || ''}
          onChange={e => onChange(e.target.value || undefined)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
    );
  }
  if (filterDef.type === 'checkbox') {
    return (
      <div className="flex items-center gap-2 pt-5">
        <input
          type="checkbox"
          id={filterDef.key}
          checked={value === filterDef.value}
          onChange={e => onChange(e.target.checked ? filterDef.value : undefined)}
          className="w-4 h-4 rounded border-gray-300 text-blue-600"
        />
        <label htmlFor={filterDef.key} className="text-sm text-gray-700">{filterDef.label}</label>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-gray-600">{filterDef.label}</label>
      <input
        type="text"
        value={value || ''}
        onChange={e => onChange(e.target.value || undefined)}
        placeholder={`Filter by ${filterDef.label.toLowerCase()}...`}
        className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  );
}

// ── Results table ─────────────────────────────────────────────────────────────

function ResultsTable({ rows, columns }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-gray-400">
        <AlertCircle size={40} className="mb-3 opacity-40" />
        <p className="text-sm">No results found for the selected filters.</p>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-200">
            {columns.map(col => (
              <th key={col.key} className="px-4 py-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide whitespace-nowrap">
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((row, i) => (
            <tr key={i} className="hover:bg-gray-50 transition-colors">
              {columns.map(col => (
                <td key={col.key} className="px-4 py-3 text-gray-700 max-w-xs">
                  <div className="truncate">{fmtCell(col.key === 'customer_name' ? (row.customer_name || row.customer_code) : row[col.key], col.type)}</div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Date preset helper ───────────────────────────────────────────────────────

function toYMD(d) { return d.toISOString().slice(0, 10); }

const DATE_PRESETS = [
  {
    label: 'Today',
    apply: () => { const t = toYMD(new Date()); return { date_from: t, date_to: t }; },
  },
  {
    label: 'Last 7 days',
    apply: () => {
      const to = new Date();
      const from = new Date(); from.setDate(from.getDate() - 6);
      return { date_from: toYMD(from), date_to: toYMD(to) };
    },
  },
  {
    label: 'Last 30 days',
    apply: () => {
      const to = new Date();
      const from = new Date(); from.setDate(from.getDate() - 29);
      return { date_from: toYMD(from), date_to: toYMD(to) };
    },
  },
  {
    label: 'Last month',
    apply: () => {
      const now = new Date();
      const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const to   = new Date(now.getFullYear(), now.getMonth(), 0);
      return { date_from: toYMD(from), date_to: toYMD(to) };
    },
  },
  {
    label: 'Last 3 months',
    apply: () => {
      const to = new Date();
      const from = new Date(); from.setMonth(from.getMonth() - 3); from.setDate(1);
      return { date_from: toYMD(from), date_to: toYMD(to) };
    },
  },
  {
    label: 'This year',
    apply: () => {
      const y = new Date().getFullYear();
      return { date_from: `${y}-01-01`, date_to: `${y}-12-31` };
    },
  },
  {
    label: 'All time',
    apply: () => ({ date_from: undefined, date_to: undefined }),
  },
];

// ── Run Report Modal ──────────────────────────────────────────────────────────

function RunReportModal({ report, template, onClose }) {
  // report is a standard report; template is a saved template
  const isTemplate = !!template;
  const title  = isTemplate ? template.name       : report.title;
  const source = isTemplate ? template.data_source : report.dataSource;
  const srcDef = DATA_SOURCES[source];
  if (!srcDef) return null;

  const defaultCols  = isTemplate
    ? JSON.parse(template.columns_config)
    : report.defaultCols;
  const defaultFilters = isTemplate ? {} : (report.defaultFilters || {});

  // Does this data source support date range filtering?
  const hasDateFilter = srcDef.filters.some(f => f.key === 'date_from');

  const allCols = srcDef.columns;
  const [activeCols, setActiveCols] = useState(defaultCols);
  const [filters, setFilters] = useState(defaultFilters);
  const [activePreset, setActivePreset] = useState(null);
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);

  const columns = allCols.filter(c => activeCols.includes(c.key));

  const applyPreset = (preset) => {
    const dates = preset.apply();
    setFilters(prev => ({ ...prev, ...dates }));
    setActivePreset(preset.label);
  };

  // Clear preset label when user manually edits a date
  const setFilter = (key, value) => {
    if (key === 'date_from' || key === 'date_to') setActivePreset(null);
    setFilters(prev => ({ ...prev, [key]: value }));
  };

  const run = async () => {
    setLoading(true);
    try {
      const params = {};
      Object.entries(filters).forEach(([k, v]) => { if (v !== undefined && v !== '') params[k] = v; });
      const res = await api.get(`/reports/data/${source}`, { params });
      setRows(res.data);
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to fetch report data');
    } finally {
      setLoading(false);
    }
  };

  const handleExport = () => {
    if (!rows) return;
    exportCSV(rows, columns, `${title.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0,10)}.csv`);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      size="xl"
    >
      <div className="space-y-5">

        {/* Date presets — shown only for sources that have date_from/date_to */}
        {hasDateFilter && (
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Date Range</p>
            <div className="flex flex-wrap gap-2 mb-3">
              {DATE_PRESETS.map(p => (
                <button
                  key={p.label}
                  onClick={() => applyPreset(p)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                    activePreset === p.label
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400 hover:text-blue-600'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <div className="flex flex-col gap-1 flex-1">
                <label className="text-xs font-medium text-gray-500">From</label>
                <input
                  type="date"
                  value={filters.date_from || ''}
                  onChange={e => setFilter('date_from', e.target.value || undefined)}
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <span className="text-gray-400 mt-5">→</span>
              <div className="flex flex-col gap-1 flex-1">
                <label className="text-xs font-medium text-gray-500">To</label>
                <input
                  type="date"
                  value={filters.date_to || ''}
                  onChange={e => setFilter('date_to', e.target.value || undefined)}
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              {(filters.date_from || filters.date_to) && (
                <button
                  onClick={() => { setFilters(prev => ({ ...prev, date_from: undefined, date_to: undefined })); setActivePreset('All time'); }}
                  className="mt-5 p-2 text-gray-400 hover:text-red-500 rounded-lg hover:bg-red-50 transition-colors"
                  title="Clear dates"
                >
                  <X size={15} />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Column toggles */}
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Columns to display</p>
          <div className="flex flex-wrap gap-2">
            {allCols.map(col => {
              const active = activeCols.includes(col.key);
              return (
                <button
                  key={col.key}
                  onClick={() => setActiveCols(prev =>
                    active ? prev.filter(k => k !== col.key) : [...prev, col.key]
                  )}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                    active
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400 hover:text-blue-600'
                  }`}
                >
                  {col.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Other filters (date_from / date_to are handled by the date bar above) */}
        {srcDef.filters.filter(f => f.key !== 'date_from' && f.key !== 'date_to').length > 0 && (
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Filters</p>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {srcDef.filters
                .filter(f => f.key !== 'date_from' && f.key !== 'date_to')
                .map(f => (
                  <FilterRow
                    key={f.key}
                    filterDef={f}
                    value={filters[f.key]}
                    onChange={v => setFilter(f.key, v)}
                  />
                ))}
            </div>
          </div>
        )}

        {/* Action row */}
        <div className="flex items-center gap-3">
          <button
            onClick={run}
            disabled={loading}
            className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl transition-colors disabled:opacity-60"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
            Run Report
          </button>
          {rows && rows.length > 0 && (
            <button
              onClick={handleExport}
              className="flex items-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold rounded-xl transition-colors"
            >
              <Download size={16} />
              Export CSV
            </button>
          )}
          {rows !== null && (
            <span className="text-sm text-gray-500 ml-auto">{rows.length} row{rows.length !== 1 ? 's' : ''}</span>
          )}
        </div>

        {/* Results */}
        {rows !== null && <ResultsTable rows={rows} columns={columns} />}
      </div>
    </Modal>
  );
}

// ── Template Builder Modal ────────────────────────────────────────────────────

function TemplateBuilderModal({ existing, onClose, onSaved }) {
  const [name, setName] = useState(existing?.name || '');
  const [description, setDescription] = useState(existing?.description || '');
  const [source, setSource] = useState(existing?.data_source || 'orders');
  const [selectedCols, setSelectedCols] = useState(
    existing ? JSON.parse(existing.columns_config) : DATA_SOURCES.orders.columns.map(c => c.key)
  );
  const [saving, setSaving] = useState(false);

  // When source changes, reset columns to all cols for that source
  const handleSourceChange = (newSource) => {
    setSource(newSource);
    setSelectedCols(DATA_SOURCES[newSource].columns.map(c => c.key));
  };

  const toggleCol = (key) => {
    setSelectedCols(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  };

  const handleSave = async () => {
    if (!name.trim()) { alert('Please enter a template name'); return; }
    if (selectedCols.length === 0) { alert('Select at least one column'); return; }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        data_source: source,
        columns_config: JSON.stringify(selectedCols),
      };
      if (existing) {
        await api.put(`/reports/templates/${existing.id}`, payload);
      } else {
        await api.post('/reports/templates', payload);
      }
      onSaved();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to save template');
    } finally {
      setSaving(false);
    }
  };

  const srcDef = DATA_SOURCES[source];
  const SrcIcon = srcDef.icon;

  return (
    <Modal
      open
      onClose={onClose}
      title={existing ? 'Edit Template' : 'New Report Template'}
      size="lg"
    >
      <div className="space-y-5">
        {/* Name */}
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-gray-700">Template Name <span className="text-red-500">*</span></label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Monthly Dispatch Summary"
            className="border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Description */}
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-gray-700">Description <span className="text-gray-400 text-xs">(optional)</span></label>
          <input
            type="text"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Short description of this report template"
            className="border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Data Source */}
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-gray-700">Data Source <span className="text-red-500">*</span></label>
          <div className="grid grid-cols-2 gap-2">
            {Object.entries(DATA_SOURCES).map(([key, def]) => {
              const Icon = def.icon;
              const clr = COLOR_MAP[def.color] || COLOR_MAP.gray;
              const active = source === key;
              return (
                <button
                  key={key}
                  onClick={() => handleSourceChange(key)}
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl border-2 text-sm font-medium transition-all ${
                    active
                      ? `${clr.bg} ${clr.border} ${clr.icon}`
                      : 'bg-white border-gray-200 text-gray-500 hover:border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  <Icon size={16} className={active ? clr.icon : 'text-gray-400'} />
                  {def.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Columns */}
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-gray-700">Columns to include</label>
          <div className="grid grid-cols-2 gap-2">
            {srcDef.columns.map(col => {
              const active = selectedCols.includes(col.key);
              return (
                <label key={col.key} className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border cursor-pointer transition-all ${
                  active ? 'bg-blue-50 border-blue-300' : 'bg-white border-gray-200 hover:border-gray-300'
                }`}>
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={() => toggleCol(col.key)}
                    className="w-4 h-4 text-blue-600 rounded border-gray-300"
                  />
                  <span className={`text-sm font-medium ${active ? 'text-blue-700' : 'text-gray-600'}`}>{col.label}</span>
                </label>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 pt-1 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-xl hover:bg-gray-50">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl disabled:opacity-60"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {existing ? 'Save Changes' : 'Save Template'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Standard Report Card ──────────────────────────────────────────────────────

function ReportCard({ report, onRun }) {
  const Icon = report.icon;
  const clr = COLOR_MAP[report.color] || COLOR_MAP.gray;
  return (
    <div className={`relative rounded-2xl border-2 ${clr.border} ${clr.bg} p-5 flex flex-col gap-3 hover:shadow-md transition-shadow`}>
      <div className="flex items-start justify-between gap-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${clr.bg} border ${clr.border}`}>
          <Icon size={20} className={clr.icon} />
        </div>
        <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${clr.badge}`}>
          {DATA_SOURCES[report.dataSource]?.label}
        </span>
      </div>
      <div>
        <h3 className="font-semibold text-gray-800 text-sm mb-1">{report.title}</h3>
        <p className="text-xs text-gray-500 leading-relaxed">{report.description}</p>
      </div>
      <button
        onClick={() => onRun(report)}
        className={`mt-auto flex items-center justify-center gap-2 w-full py-2.5 rounded-xl text-sm font-semibold text-white transition-colors ${
          report.color === 'blue'   ? 'bg-blue-600 hover:bg-blue-700' :
          report.color === 'purple' ? 'bg-purple-600 hover:bg-purple-700' :
          report.color === 'violet' ? 'bg-violet-600 hover:bg-violet-700' :
          report.color === 'green'  ? 'bg-emerald-600 hover:bg-emerald-700' :
          report.color === 'amber'  ? 'bg-amber-600 hover:bg-amber-700' :
          report.color === 'teal'   ? 'bg-teal-600 hover:bg-teal-700' :
          report.color === 'red'    ? 'bg-red-600 hover:bg-red-700' :
                                      'bg-gray-600 hover:bg-gray-700'
        }`}
      >
        <Play size={14} />
        Run Report
      </button>
    </div>
  );
}

// ── Template Card ─────────────────────────────────────────────────────────────

function TemplateCard({ tpl, onRun, onEdit, onDelete }) {
  const srcDef = DATA_SOURCES[tpl.data_source];
  const Icon = srcDef?.icon || BarChart2;
  const clr = COLOR_MAP[srcDef?.color || 'gray'];
  const cols = JSON.parse(tpl.columns_config || '[]');

  return (
    <div className="bg-white rounded-2xl border border-gray-200 hover:border-gray-300 hover:shadow-md transition-all p-5 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${clr.bg} border ${clr.border}`}>
          <Icon size={17} className={clr.icon} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-semibold text-gray-800 text-sm truncate">{tpl.name}</h3>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button onClick={() => onEdit(tpl)} className="p-1.5 text-gray-400 hover:text-blue-600 rounded-lg hover:bg-blue-50 transition-colors" title="Edit">
                <Edit2 size={14} />
              </button>
              <button onClick={() => onDelete(tpl)} className="p-1.5 text-gray-400 hover:text-red-500 rounded-lg hover:bg-red-50 transition-colors" title="Delete">
                <Trash2 size={14} />
              </button>
            </div>
          </div>
          {tpl.description && <p className="text-xs text-gray-500 mt-0.5 truncate">{tpl.description}</p>}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${clr.badge}`}>{srcDef?.label || tpl.data_source}</span>
        <span className="text-xs text-gray-400">{cols.length} column{cols.length !== 1 ? 's' : ''}</span>
        {tpl.created_by_name && <span className="text-xs text-gray-400 ml-auto">by {tpl.created_by_name}</span>}
      </div>

      <button
        onClick={() => onRun(tpl)}
        className="flex items-center justify-center gap-2 w-full py-2.5 bg-gray-800 hover:bg-gray-900 text-white rounded-xl text-sm font-semibold transition-colors"
      >
        <Play size={14} />
        Run
      </button>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function ReportsDashboard() {
  const [tab, setTab] = useState('standard'); // 'standard' | 'templates'
  const [templates, setTemplates] = useState([]);
  const [loadingTpl, setLoadingTpl] = useState(false);

  // Modals
  const [runReport, setRunReport]     = useState(null);   // standard report to run
  const [runTemplate, setRunTemplate] = useState(null);   // saved template to run
  const [editTpl, setEditTpl]         = useState(null);   // template being edited (null = new)
  const [showBuilder, setShowBuilder] = useState(false);  // show new template builder

  // Monthly Production Report (multi-sheet Excel)
  const [reportMonth, setReportMonth] = useState(new Date().toISOString().slice(0, 7));
  const [dlReport, setDlReport] = useState(false);
  const downloadMonthly = async () => {
    setDlReport(true);
    try { await downloadExcel(`monthly-production?month=${reportMonth}`, `production_report_${reportMonth}.xlsx`); }
    finally { setDlReport(false); }
  };

  const loadTemplates = useCallback(async () => {
    setLoadingTpl(true);
    try {
      const res = await api.get('/reports/templates');
      setTemplates(res.data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingTpl(false);
    }
  }, []);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  const handleDeleteTemplate = async (tpl) => {
    if (!window.confirm(`Delete template "${tpl.name}"?`)) return;
    try {
      await api.delete(`/reports/templates/${tpl.id}`);
      loadTemplates();
    } catch (e) {
      alert(e.response?.data?.error || 'Failed to delete');
    }
  };

  return (
    <div className="p-6 max-w-screen-xl mx-auto space-y-6">

      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2.5">
            <BarChart2 size={26} className="text-blue-600" />
            Reports
          </h1>
          <p className="text-sm text-gray-500 mt-1">Generate, filter and export data reports across all modules.</p>
        </div>
        {tab === 'templates' && (
          <button
            onClick={() => { setEditTpl(null); setShowBuilder(true); }}
            className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl transition-colors"
          >
            <Plus size={16} />
            New Template
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 p-1 bg-gray-100 rounded-xl w-fit">
        <button
          onClick={() => setTab('standard')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            tab === 'standard' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <Star size={15} />
          Standard Reports
        </button>
        <button
          onClick={() => setTab('templates')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            tab === 'templates' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <Clock size={15} />
          My Templates
          {templates.length > 0 && (
            <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs font-bold rounded-full">{templates.length}</span>
          )}
        </button>
      </div>

      {/* Monthly Production Report (featured, multi-sheet Excel) */}
      {tab === 'standard' && (
        <div className="rounded-2xl border border-blue-200 bg-blue-50/60 p-5 flex flex-col sm:flex-row sm:items-end gap-4">
          <div className="flex-1">
            <h2 className="font-bold text-gray-900 flex items-center gap-2">
              <BarChart2 size={18} className="text-blue-600" /> Monthly Production Report
            </h2>
            <p className="text-sm text-gray-600 mt-1 max-w-2xl">
              Per-item detail (designed vs actual Ω, Megger, draw length, rejects, scrap, on-time, workers) plus a
              monthly analysis (quality · on-time · material) and a 12-month trend. Excel workbook, 3 sheets.
            </p>
          </div>
          <div className="flex items-end gap-2">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Month</label>
              <input type="month" className="input" value={reportMonth} onChange={e => setReportMonth(e.target.value)} />
            </div>
            <button className="btn-primary flex items-center gap-2 whitespace-nowrap" onClick={downloadMonthly} disabled={dlReport}>
              <Download size={16} /> {dlReport ? 'Generating…' : 'Download Excel'}
            </button>
          </div>
        </div>
      )}

      {/* Standard Reports */}
      {tab === 'standard' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {STANDARD_REPORTS.map(r => (
            <ReportCard key={r.id} report={r} onRun={r => setRunReport(r)} />
          ))}
        </div>
      )}

      {/* Saved Templates */}
      {tab === 'templates' && (
        <div>
          {loadingTpl ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 size={32} className="animate-spin text-blue-600" />
            </div>
          ) : templates.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-gray-400 border-2 border-dashed border-gray-200 rounded-2xl">
              <BarChart2 size={48} className="mb-4 opacity-30" />
              <p className="font-semibold text-gray-600 mb-1">No saved templates yet</p>
              <p className="text-sm mb-6">Create a custom template to run the same report with predefined columns.</p>
              <button
                onClick={() => { setEditTpl(null); setShowBuilder(true); }}
                className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl"
              >
                <Plus size={16} />
                Create First Template
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {templates.map(tpl => (
                <TemplateCard
                  key={tpl.id}
                  tpl={tpl}
                  onRun={t => setRunTemplate(t)}
                  onEdit={t => { setEditTpl(t); setShowBuilder(true); }}
                  onDelete={handleDeleteTemplate}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Run standard report modal */}
      {runReport && (
        <RunReportModal report={runReport} onClose={() => setRunReport(null)} />
      )}

      {/* Run template modal */}
      {runTemplate && (
        <RunReportModal template={runTemplate} onClose={() => setRunTemplate(null)} />
      )}

      {/* Template builder modal */}
      {showBuilder && (
        <TemplateBuilderModal
          existing={editTpl}
          onClose={() => { setShowBuilder(false); setEditTpl(null); }}
          onSaved={() => { setShowBuilder(false); setEditTpl(null); loadTemplates(); setTab('templates'); }}
        />
      )}
    </div>
  );
}
