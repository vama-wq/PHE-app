import { useEffect, useState } from 'react';
import api from '../../lib/api';
import Modal from '../../components/ui/Modal';
import ImportModal from '../../components/ui/ImportModal';
import { fmtDate, downloadExcel } from '../../lib/utils';
import { useAuthStore } from '../../store/authStore';
import { Plus, Search, Phone, Mail, Download, Upload, Trash2 } from 'lucide-react';

export default function CustomerList() {
  const [customers, setCustomers] = useState([]);
  const [filtered, setFiltered] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [selected, setSelected] = useState(null);
  const [showImport, setShowImport] = useState(false);

  const load = () => api.get('/customers').then(r => { setCustomers(r.data); setFiltered(r.data); }).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!search) return setFiltered(customers);
    setFiltered(customers.filter(c => c.customer_code.toLowerCase().includes(search.toLowerCase()) || c.name.toLowerCase().includes(search.toLowerCase())));
  }, [customers, search]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Customers</h1>
          <p className="text-xs text-orange-600 bg-orange-50 px-2 py-1 rounded mt-1 inline-block">
            🔒 Visible to Admin & Owner only
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-secondary flex items-center gap-1.5 text-sm"
            onClick={() => downloadExcel('customers', 'customers.xlsx')}>
            <Download size={15} /> Export Excel
          </button>
          <button className="btn-secondary flex items-center gap-1.5 text-sm"
            onClick={() => setShowImport(true)}>
            <Upload size={15} /> Import Excel
          </button>
          <button className="btn-primary" onClick={() => setShowNew(true)}><Plus size={16} /> Add Customer</button>
        </div>
      </div>

      <div className="relative max-w-sm mb-5">
        <Search size={16} className="absolute left-3 top-2.5 text-gray-400" />
        <input className="input pl-9" placeholder="Search code or name..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {loading ? (
          <div className="col-span-3 text-center text-gray-400 py-12">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="col-span-3 text-center text-gray-400 py-12">No customers found</div>
        ) : filtered.map(c => (
          <div key={c.id} className="card p-5 cursor-pointer hover:shadow-md transition-shadow" onClick={() => setSelected(c)}>
            <div className="flex items-center justify-between mb-2">
              <span className="font-bold text-brand-700 text-lg">{c.customer_code}</span>
            </div>
            <div className="font-semibold text-gray-900 mb-2">{c.name}</div>
            {c.contact_person && <div className="text-sm text-gray-500 mb-1">{c.contact_person}</div>}
            <div className="flex flex-col gap-1">
              {c.phone && <div className="flex items-center gap-1.5 text-xs text-gray-400"><Phone size={12} />{c.phone}</div>}
              {c.email && <div className="flex items-center gap-1.5 text-xs text-gray-400"><Mail size={12} />{c.email}</div>}
            </div>
          </div>
        ))}
      </div>

      {showNew && <CustomerModal onClose={() => setShowNew(false)} onSave={() => { setShowNew(false); load(); }} />}
      {selected && <CustomerModal customer={selected} onClose={() => setSelected(null)} onSave={() => { setSelected(null); load(); }} onDelete={() => { setSelected(null); load(); }} />}
      {showImport && <ImportModal type="customers" onClose={() => setShowImport(false)} onDone={() => { load(); }} />}
    </div>
  );
}

function CustomerModal({ customer, onClose, onSave, onDelete }) {
  const { user } = useAuthStore();
  const [f, setF] = useState(customer || {
    customer_code: '', name: '', contact_person: '', phone: '', email: '',
    billing_address: '', shipping_address: '', gst_no: '', notes: '',
    country_of_destination: '', port_of_loading: '', port_of_discharge: '', final_destination: ''
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = k => e => setF(p => ({ ...p, [k]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (customer) await api.put(`/customers/${customer.id}`, f);
      else await api.post('/customers', f);
      onSave();
    } catch (err) { setError(err.response?.data?.error || 'Failed'); setSaving(false); }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete customer "${customer.customer_code} — ${customer.name}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/customers/${customer.id}`);
      onDelete?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Delete failed');
    }
  };

  return (
    <Modal open title={customer ? `Edit — ${customer.customer_code}` : 'Add Customer'} onClose={onClose} size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Customer Code <span className="text-red-500">*</span></label>
            <input className="input" placeholder="e.g. BE" value={f.customer_code} onChange={set('customer_code')} required />
          </div>
          <div>
            <label className="label">Customer Name <span className="text-red-500">*</span></label>
            <input className="input" placeholder="Company name" value={f.name} onChange={set('name')} required />
          </div>
          <div>
            <label className="label">Contact Person</label>
            <input className="input" value={f.contact_person || ''} onChange={set('contact_person')} />
          </div>
          <div>
            <label className="label">Phone Number</label>
            <input className="input" type="tel" value={f.phone || ''} onChange={set('phone')} />
          </div>
          <div>
            <label className="label">Email ID</label>
            <input className="input" type="email" value={f.email || ''} onChange={set('email')} />
          </div>
          <div>
            <label className="label">GST No.</label>
            <input className="input" placeholder="e.g. 24ABCDE1234F1Z5" value={f.gst_no || ''} onChange={set('gst_no')} />
          </div>
          <div className="col-span-2">
            <label className="label">Billing Address</label>
            <textarea className="input h-16 resize-none" value={f.billing_address || ''} onChange={set('billing_address')} />
          </div>
          <div className="col-span-2">
            <label className="label">Shipping Address</label>
            <textarea className="input h-16 resize-none" value={f.shipping_address || ''} onChange={set('shipping_address')} />
          </div>
          <div className="col-span-2">
            <label className="label">Notes</label>
            <textarea className="input h-12 resize-none" value={f.notes || ''} onChange={set('notes')} />
          </div>

          {/* Shipping / Export Details */}
          <div className="col-span-2 pt-2 border-t border-gray-100">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Shipping / Export Details</p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">Country of Final Destination</label>
                <input className="input" placeholder="e.g. Germany" value={f.country_of_destination || ''} onChange={set('country_of_destination')} />
              </div>
              <div>
                <label className="label">Final Destination</label>
                <input className="input" placeholder="e.g. Berlin Warehouse" value={f.final_destination || ''} onChange={set('final_destination')} />
              </div>
              <div>
                <label className="label">Port of Loading</label>
                <input className="input" placeholder="e.g. Mundra" value={f.port_of_loading || ''} onChange={set('port_of_loading')} />
              </div>
              <div>
                <label className="label">Port of Discharge</label>
                <input className="input" placeholder="e.g. Hamburg" value={f.port_of_discharge || ''} onChange={set('port_of_discharge')} />
              </div>
            </div>
          </div>
        </div>
        {error && <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
        <div className="flex gap-3 pt-2">
          {customer && user?.role === 'owner' && (
            <button type="button" className="btn-danger flex items-center gap-1.5" onClick={handleDelete}>
              <Trash2 size={14} /> Delete
            </button>
          )}
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving}>{saving ? 'Saving...' : customer ? 'Update' : 'Add Customer'}</button>
        </div>
      </form>
    </Modal>
  );
}
