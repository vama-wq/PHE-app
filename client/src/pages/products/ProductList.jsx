import { useEffect, useState } from 'react';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import Modal from '../../components/ui/Modal';
import ImportModal from '../../components/ui/ImportModal';
import { Plus, Search, Image as ImageIcon, ExternalLink, Upload } from 'lucide-react';

export default function ProductList() {
  const { user } = useAuthStore();
  const [products, setProducts] = useState([]);
  const [filtered, setFiltered] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [selected, setSelected] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const canManage = ['admin', 'owner'].includes(user.role);

  const load = () => api.get('/products').then(r => { setProducts(r.data); setFiltered(r.data); }).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!search) return setFiltered(products);
    setFiltered(products.filter(p =>
      p.product_code.toLowerCase().includes(search.toLowerCase()) ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.category?.toLowerCase().includes(search.toLowerCase())
    ));
  }, [products, search]);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Products</h1>
          <p className="text-gray-500 text-sm mt-0.5">{products.length} products</p>
        </div>
        {canManage && (
          <div className="flex items-center gap-2">
            <button className="btn-secondary flex items-center gap-1.5 text-sm" onClick={() => setShowImport(true)}>
              <Upload size={15} /> Import Excel
            </button>
            <button className="btn-primary" onClick={() => setShowNew(true)}><Plus size={16} /> Add Product</button>
          </div>
        )}
      </div>

      <div className="relative max-w-sm mb-5">
        <Search size={16} className="absolute left-3 top-2.5 text-gray-400" />
        <input className="input pl-9" placeholder="Search code, name, category..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="table-header text-left">Photo</th>
              <th className="table-header text-left">Product Code</th>
              <th className="table-header text-left">Name</th>
              <th className="table-header text-left">Category</th>
              <th className="table-header text-left">Description</th>
              {canManage && <th className="table-header" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={6} className="table-cell text-center text-gray-400 py-12">Loading...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={6} className="table-cell text-center text-gray-400 py-12">No products found</td></tr>
            ) : filtered.map(p => (
              <tr key={p.id} className="hover:bg-gray-50">
                <td className="table-cell">
                  {p.photo_file ? (
                    <a href={`/uploads/${p.photo_file}`} target="_blank" rel="noopener noreferrer">
                      <img
                        src={`/uploads/${p.photo_file}`}
                        alt={p.name}
                        className="w-12 h-12 object-cover rounded-lg border border-gray-200 hover:opacity-80 transition-opacity"
                      />
                    </a>
                  ) : (
                    <div className="w-12 h-12 rounded-lg bg-gray-100 flex items-center justify-center">
                      <ImageIcon size={18} className="text-gray-300" />
                    </div>
                  )}
                </td>
                <td className="table-cell font-semibold text-brand-700">{p.product_code}</td>
                <td className="table-cell font-medium">{p.name}</td>
                <td className="table-cell text-gray-500">{p.category || '—'}</td>
                <td className="table-cell text-gray-400 text-xs">{p.description || '—'}</td>
                {canManage && (
                  <td className="table-cell text-right">
                    <button className="btn-ghost btn-sm" onClick={() => setSelected(p)}>Edit</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showNew && <ProductModal onClose={() => setShowNew(false)} onSave={() => { setShowNew(false); load(); }} />}
      {selected && <ProductModal product={selected} onClose={() => setSelected(null)} onSave={() => { setSelected(null); load(); }} />}
      {showImport && <ImportModal type="products" onClose={() => setShowImport(false)} onDone={() => load()} />}
    </div>
  );
}

function ProductModal({ product, onClose, onSave }) {
  const [code, setCode] = useState(product?.product_code || '');
  const [name, setName] = useState(product?.name || '');
  const [category, setCategory] = useState(product?.category || '');
  const [description, setDescription] = useState(product?.description || '');
  const [photoFile, setPhotoFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('product_code', code);
      fd.append('name', name);
      fd.append('category', category);
      fd.append('description', description);
      if (photoFile) fd.append('photo', photoFile);

      if (product) await api.put(`/products/${product.id}`, fd);
      else await api.post('/products', fd);
      onSave();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed');
      setSaving(false);
    }
  };

  return (
    <Modal open title={product ? 'Edit Product' : 'Add Product'} onClose={onClose} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">Product Code *</label>
          <input className="input" placeholder="e.g. PT-FlangeHe-QU" value={code} onChange={e => setCode(e.target.value)} required />
        </div>
        <div>
          <label className="label">Name *</label>
          <input className="input" placeholder="Product name" value={name} onChange={e => setName(e.target.value)} required />
        </div>
        <div>
          <label className="label">Category</label>
          <input className="input" value={category} onChange={e => setCategory(e.target.value)} />
        </div>
        <div>
          <label className="label">Description</label>
          <textarea className="input h-16 resize-none" value={description} onChange={e => setDescription(e.target.value)} />
        </div>

        {/* Reference photo */}
        <div>
          <label className="label">Reference Photo</label>
          {product?.photo_file && !photoFile && (
            <div className="mb-2">
              <a href={`/uploads/${product.photo_file}`} target="_blank" rel="noopener noreferrer">
                <img
                  src={`/uploads/${product.photo_file}`}
                  alt="current"
                  className="w-24 h-24 object-cover rounded-lg border border-gray-200 hover:opacity-80"
                />
              </a>
              <p className="text-xs text-gray-400 mt-1">Current photo — upload new to replace</p>
            </div>
          )}
          {photoFile && (
            <div className="mb-2">
              <img
                src={URL.createObjectURL(photoFile)}
                alt="preview"
                className="w-24 h-24 object-cover rounded-lg border border-brand-200"
              />
              <p className="text-xs text-brand-500 mt-1">{photoFile.name}</p>
            </div>
          )}
          <label className="inline-flex items-center gap-2 btn-secondary cursor-pointer text-sm">
            <ImageIcon size={15} />
            {product?.photo_file ? 'Replace Photo' : 'Upload Photo'}
            <input
              type="file"
              accept=".jpg,.jpeg,.png,.webp"
              className="hidden"
              onChange={e => setPhotoFile(e.target.files[0] || null)}
            />
          </label>
        </div>

        {error && <p className="text-red-600 text-sm">{error}</p>}
        <div className="flex gap-3">
          <button type="button" className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary flex-1" disabled={saving}>
            {saving ? 'Saving...' : product ? 'Update' : 'Add Product'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
