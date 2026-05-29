import { useRef, useState } from 'react';
import Modal from './Modal';
import api from '../../lib/api';
import { Upload, Download, CheckCircle, AlertCircle, X, FileSpreadsheet } from 'lucide-react';

const CONFIGS = {
  customers: {
    title: 'Import Customers',
    templateUrl: '/api/import/customers/template',
    templateName: 'customers_template.xlsx',
    importPath: '/import/customers',
    columns: [
      { name: 'customer_code', required: true },
      { name: 'name', required: true },
      { name: 'contact_person', required: false },
      { name: 'phone', required: false },
      { name: 'email', required: false },
      { name: 'billing_address', required: false },
      { name: 'shipping_address', required: false },
      { name: 'gst_no', required: false },
      { name: 'notes', required: false },
      { name: 'country_of_destination', required: false },
      { name: 'port_of_loading', required: false },
      { name: 'port_of_discharge', required: false },
      { name: 'final_destination', required: false },
    ],
    updateKey: 'customer_code',
  },
  suppliers: {
    title: 'Import Suppliers',
    templateUrl: '/api/import/suppliers/template',
    templateName: 'suppliers_template.xlsx',
    importPath: '/import/suppliers',
    columns: [
      { name: 'supplier_code', required: false },
      { name: 'name', required: true },
      { name: 'contact_person', required: false },
      { name: 'phone', required: false },
      { name: 'email', required: false },
      { name: 'address', required: false },
      { name: 'notes', required: false },
    ],
    updateKey: 'supplier_code',
  },
  products: {
    title: 'Import Products',
    templateUrl: '/api/import/products/template',
    templateName: 'products_template.xlsx',
    importPath: '/import/products',
    columns: [
      { name: 'product_code', required: true },
      { name: 'name', required: true },
      { name: 'category', required: false },
      { name: 'description', required: false },
    ],
    updateKey: 'product_code',
  },
  inventory: {
    title: 'Import Inventory Items',
    templateUrl: '/api/import/inventory/template',
    templateName: 'inventory_template.xlsx',
    importPath: '/import/inventory',
    columns: [
      { name: 'item_code', required: true },
      { name: 'name', required: true },
      { name: 'category', required: false },
      { name: 'unit', required: true },
      { name: 'reorder_level', required: false },
      { name: 'unit_cost', required: false },
      { name: 'notes', required: false },
    ],
    updateKey: 'item_code',
  },
};

export default function ImportModal({ type, onClose, onDone }) {
  const config = CONFIGS[type];
  const fileInputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const handleFileChange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    setFile(f);
    setResult(null);
    setError('');
  };

  const handleDrop = (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && (f.name.endsWith('.xlsx') || f.name.endsWith('.xls'))) {
      setFile(f);
      setResult(null);
      setError('');
    }
  };

  const handleDownloadTemplate = async () => {
    try {
      const r = await api.get(config.templateUrl, { responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = config.templateName;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('Failed to download template');
    }
  };

  const handleImport = async () => {
    if (!file) return setError('Please select an Excel file first');
    setImporting(true);
    setError('');
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await api.post(config.importPath, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setResult(r.data);
      if (r.data.imported > 0) onDone?.();
    } catch (e) {
      const msg = e.response?.data?.error || e.message || 'Import failed. Please check your file and try again.';
      setError(msg);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal open title={config.title} onClose={onClose} size="md">
      <div className="space-y-4">

        {/* How-to instructions */}
        <div className="bg-blue-50 border border-blue-100 rounded-lg p-3.5 text-sm text-blue-700">
          <p className="font-semibold mb-1.5">How to import:</p>
          <ol className="list-decimal list-inside space-y-1 text-blue-600 text-sm">
            <li>Download the Excel template below</li>
            <li>Fill in your data — columns marked <strong className="text-blue-800">*</strong> are required</li>
            <li>Upload the filled file and click <strong className="text-blue-800">Import Data</strong></li>
          </ol>
          <p className="mt-2 text-xs text-blue-500">
            Existing records with the same <code className="bg-blue-100 px-1 rounded">{config.updateKey}</code> will be updated automatically.
          </p>
        </div>

        {/* Column reference */}
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Expected columns</p>
          <div className="flex flex-wrap gap-1.5">
            {config.columns.map(col => (
              <span
                key={col.name}
                className={`text-xs px-2 py-0.5 rounded-full font-mono ${
                  col.required
                    ? 'bg-red-100 text-red-700 font-semibold'
                    : 'bg-gray-100 text-gray-500'
                }`}
              >
                {col.name}{col.required ? ' *' : ''}
              </span>
            ))}
          </div>
        </div>

        {/* Download template */}
        <button
          onClick={handleDownloadTemplate}
          className="btn-secondary w-full flex items-center justify-center gap-2 text-sm"
        >
          <Download size={15} /> Download Template
        </button>

        {/* File drop zone */}
        <div>
          <p className="label mb-1.5">Upload Filled Excel File</p>
          <div
            className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
              file
                ? 'border-green-300 bg-green-50'
                : 'border-gray-200 hover:border-brand-400 hover:bg-brand-50'
            }`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={handleDrop}
          >
            {file ? (
              <div className="flex flex-col items-center gap-1.5 text-sm text-gray-700">
                <FileSpreadsheet size={28} className="text-green-500" />
                <span className="font-semibold text-green-800">{file.name}</span>
                <span className="text-xs text-gray-400">{(file.size / 1024).toFixed(1)} KB · Click to change</span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-1.5 text-gray-400">
                <Upload size={26} />
                <p className="text-sm font-medium text-gray-500">Click to select or drag & drop</p>
                <p className="text-xs">.xlsx or .xls files only</p>
              </div>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>

        {/* Error message */}
        {error && (
          <div className="text-red-600 text-sm bg-red-50 border border-red-100 px-3 py-2 rounded-lg flex items-start gap-2">
            <AlertCircle size={15} className="mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Result */}
        {result && (
          <div className={`rounded-lg border p-3.5 ${result.imported > 0 ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}>
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle size={16} className={result.imported > 0 ? 'text-green-600' : 'text-amber-600'} />
              <span className={`text-sm font-semibold ${result.imported > 0 ? 'text-green-800' : 'text-amber-800'}`}>
                {result.imported > 0
                  ? `${result.imported} record${result.imported !== 1 ? 's' : ''} imported successfully`
                  : 'No records were imported'}
              </span>
            </div>
            <p className="text-xs text-gray-500 ml-6">
              {result.total} rows processed · {result.imported} imported · {result.skipped} skipped
              {result.imagesImported > 0 && ` · ${result.imagesImported} image${result.imagesImported !== 1 ? 's' : ''} saved`}
            </p>
            {result.errors.length > 0 && (
              <div className="mt-2 ml-6 max-h-28 overflow-y-auto space-y-0.5">
                {result.errors.map((e, i) => (
                  <p key={i} className="text-xs text-red-600 flex items-start gap-1">
                    <X size={10} className="mt-0.5 flex-shrink-0 text-red-400" />
                    {e}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-3 pt-1">
          <button className="btn-secondary flex-1" onClick={onClose}>
            {result ? 'Close' : 'Cancel'}
          </button>
          {!result && (
            <button
              className="btn-primary flex-1"
              onClick={handleImport}
              disabled={importing || !file}
            >
              {importing ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Importing...
                </span>
              ) : (
                <>
                  <Upload size={15} /> Import Data
                </>
              )}
            </button>
          )}
        </div>

      </div>
    </Modal>
  );
}
