import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../../lib/api';
import { ArrowLeft, ArrowDownCircle, ArrowUpCircle } from 'lucide-react';

const ORDER_TYPE_LABEL = {
  local_he: 'Local HE', export_he: 'Export HE',
  inventory_order: 'IO', io_export_he: 'IO + Export HE', io_local_he: 'IO + Local HE',
};
const ORDER_TYPE_COLOR = {
  local_he: 'bg-blue-50 text-blue-700', export_he: 'bg-purple-100 text-purple-700',
  inventory_order: 'bg-amber-100 text-amber-700', io_export_he: 'bg-orange-100 text-orange-700',
  io_local_he: 'bg-teal-100 text-teal-700',
};

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function FinishedGoodsDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    api.get(`/finished-goods/${id}`).then(r => { setData(r.data); setLoading(false); });
  };
  useEffect(() => { load(); }, [id]);

  if (loading) return <div className="p-6 text-gray-400">Loading...</div>;
  if (!data) return <div className="p-6 text-red-500">Not found</div>;

  const fg = data;

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      {/* Back */}
      <button onClick={() => navigate('/finished-goods')} className="flex items-center gap-2 text-sm text-gray-500 hover:text-brand-600 transition-colors">
        <ArrowLeft size={16} /> Back to Finished Goods
      </button>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{fg.order_code}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{fg.customer_code} · {fg.customer_name}</p>
        </div>
        <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${ORDER_TYPE_COLOR[fg.order_type] || 'bg-gray-100 text-gray-600'}`}>
          {ORDER_TYPE_LABEL[fg.order_type] || fg.order_type}
        </span>
      </div>

      {/* Details grid */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 grid grid-cols-2 gap-x-8 gap-y-4">
        <Field label="Drawing No."          value={fg.drawing_no} />
        <Field label="Tube Material"        value={fg.tube_material} />
        <Field label="Tube Diameter"        value={fg.tube_diameter ? `${fg.tube_diameter} mm` : null} />
        <Field label="Wattage"              value={fg.wattage ? `${fg.wattage} W` : null} />
        <Field label="Voltage"              value={fg.voltage ? `${fg.voltage} V` : null} />
        <Field label="Plating Instructions" value={fg.plating_instructions} />
        <Field label="Date Added"           value={fmtDate(fg.created_at)} />
        <Field label="Added By"             value={fg.created_by_name} />
        {fg.notes && <div className="col-span-2"><Field label="Notes" value={fg.notes} /></div>}
      </div>

      {/* Stock summary */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-green-50 border border-green-100 rounded-xl p-4 flex items-center gap-3">
          <ArrowDownCircle size={22} className="text-green-600" />
          <div>
            <p className="text-xs text-green-700">Total Inward</p>
            <p className="text-2xl font-bold text-green-800">{fg.qty_in}</p>
          </div>
        </div>
        <div className={`border rounded-xl p-4 flex items-center gap-3 ${fg.qty_available === 0 ? 'bg-red-50 border-red-100' : 'bg-blue-50 border-blue-100'}`}>
          <ArrowUpCircle size={22} className={fg.qty_available === 0 ? 'text-red-500' : 'text-blue-600'} />
          <div>
            <p className={`text-xs ${fg.qty_available === 0 ? 'text-red-600' : 'text-blue-700'}`}>Available Stock</p>
            <p className={`text-2xl font-bold ${fg.qty_available === 0 ? 'text-red-700' : 'text-blue-800'}`}>{fg.qty_available}</p>
          </div>
        </div>
      </div>

      {/* Inward / Outward log */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 bg-gray-50">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Movement Log</h2>
        </div>
        {fg.log?.length === 0 ? (
          <p className="text-center text-gray-400 text-sm py-8">No movements recorded</p>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="table-header text-left">Type</th>
                <th className="table-header text-left">Client</th>
                <th className="table-header text-center">Qty</th>
                <th className="table-header text-left">Reference / Reason</th>
                <th className="table-header text-left">By</th>
                <th className="table-header text-left">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {fg.log.map(l => (
                <tr key={l.id} className="hover:bg-gray-50">
                  <td className="table-cell">
                    {l.movement_type === 'inward' ? (
                      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-green-100 text-green-700">
                        <ArrowDownCircle size={11} /> Inward
                      </span>
                    ) : l.outward_type === 'sampling' ? (
                      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700">
                        <ArrowUpCircle size={11} /> Sampling
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-red-100 text-red-700">
                        <ArrowUpCircle size={11} /> Dispatch
                      </span>
                    )}
                  </td>
                  <td className="table-cell text-sm">
                    {l.movement_type === 'outward' ? (
                      <div>
                        <div className="font-medium text-gray-800">{l.client_name || '—'}</div>
                        {l.client_code && <div className="text-xs text-gray-400">{l.client_code}</div>}
                      </div>
                    ) : (
                      <span className="text-gray-400 text-xs">—</span>
                    )}
                  </td>
                  <td className="table-cell text-center font-semibold text-sm">{l.qty}</td>
                  <td className="table-cell text-sm text-gray-500">
                    {l.reason && <div className="text-amber-700 font-medium">{l.reason}</div>}
                    {l.reference && <div>{l.reference}</div>}
                    {l.notes && <div className="text-gray-400">{l.notes}</div>}
                    {!l.reason && !l.reference && !l.notes && '—'}
                  </td>
                  <td className="table-cell text-sm text-gray-600">{l.created_by_name || '—'}</td>
                  <td className="table-cell text-sm text-gray-500">{fmtDate(l.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <p className="text-xs text-gray-400 uppercase tracking-wide mb-0.5">{label}</p>
      <p className="text-sm font-medium text-gray-800">{value || '—'}</p>
    </div>
  );
}
