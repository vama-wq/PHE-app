import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import api from '../../lib/api';
import { ArrowLeft, ArrowDownCircle, ArrowUpCircle, Package } from 'lucide-react';
import { fmtDateTime } from '../../lib/utils';

export default function FinishedGoodsDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    api.get(`/finished-goods/${id}`)
      .then(r => { setData(r.data); setLoading(false); });
  };
  useEffect(() => { load(); }, [id]);

  if (loading) return <div className="p-6 text-gray-400">Loading...</div>;
  if (!data)   return <div className="p-6 text-red-500">Not found</div>;

  const fg = data;
  const inwardLog  = (fg.log || []).filter(l => l.movement_type === 'inward');
  const outwardLog = (fg.log || []).filter(l => l.movement_type === 'outward');
  const totalOutward = outwardLog.reduce((s, l) => s + (parseInt(l.qty) || 0), 0);

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* Back */}
      <button onClick={() => navigate('/finished-goods')}
        className="flex items-center gap-2 text-sm text-gray-500 hover:text-brand-600 transition-colors">
        <ArrowLeft size={16} /> Back to Finished Goods
      </button>

      {/* Product header */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 bg-brand-50 rounded-xl flex items-center justify-center flex-shrink-0">
            <Package size={22} className="text-brand-600" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-bold text-gray-900">
              {fg.base_drawing_no || fg.drawing_no || '—'}
            </h1>
            <div className="flex flex-wrap gap-2 mt-1">
              {fg.tube_material && (
                <span className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full font-medium">
                  {fg.tube_material}
                </span>
              )}
              {fg.tube_diameter && (
                <span className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full font-medium">
                  ⌀ {fg.tube_diameter} mm
                </span>
              )}
              {fg.wattage && (
                <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium">
                  {fg.wattage} W
                </span>
              )}
              {fg.voltage && (
                <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
                  {fg.voltage} V
                </span>
              )}
              {fg.plating_instructions && (
                <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-medium">
                  {fg.plating_instructions}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Stock summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-green-50 border border-green-100 rounded-xl p-4 flex items-center gap-3">
          <ArrowDownCircle size={22} className="text-green-600" />
          <div>
            <p className="text-xs text-green-700">Total Inward</p>
            <p className="text-2xl font-bold text-green-800">{fg.qty_in}</p>
            <p className="text-xs text-green-600 mt-0.5">{inwardLog.length} batch{inwardLog.length !== 1 ? 'es' : ''}</p>
          </div>
        </div>
        <div className="bg-red-50 border border-red-100 rounded-xl p-4 flex items-center gap-3">
          <ArrowUpCircle size={22} className="text-red-500" />
          <div>
            <p className="text-xs text-red-700">Total Outward</p>
            <p className="text-2xl font-bold text-red-800">{totalOutward}</p>
            <p className="text-xs text-red-600 mt-0.5">{outwardLog.length} movement{outwardLog.length !== 1 ? 's' : ''}</p>
          </div>
        </div>
        <div className={`border rounded-xl p-4 flex items-center gap-3 ${
          fg.qty_available === 0 ? 'bg-red-50 border-red-200' : 'bg-blue-50 border-blue-100'
        }`}>
          <Package size={22} className={fg.qty_available === 0 ? 'text-red-500' : 'text-blue-600'} />
          <div>
            <p className={`text-xs ${fg.qty_available === 0 ? 'text-red-600' : 'text-blue-700'}`}>
              Available Stock
            </p>
            <p className={`text-2xl font-bold ${fg.qty_available === 0 ? 'text-red-700' : 'text-blue-800'}`}>
              {fg.qty_available}
            </p>
          </div>
        </div>
      </div>

      {/* Inward batches — which job cards contributed stock */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 bg-green-50 flex items-center gap-2">
          <ArrowDownCircle size={15} className="text-green-600" />
          <h2 className="text-sm font-semibold text-green-800 uppercase tracking-wide">
            Inward Batches — Production History
          </h2>
        </div>
        {inwardLog.length === 0 ? (
          <p className="text-center text-gray-400 text-sm py-8">No inward batches recorded</p>
        ) : (
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="table-header text-left">Job Card</th>
                <th className="table-header text-left">Order</th>
                <th className="table-header text-left">Customer</th>
                <th className="table-header text-center">Qty</th>
                <th className="table-header text-left">Notes</th>
                <th className="table-header text-left">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {inwardLog.map(l => (
                <tr key={l.id} className="hover:bg-gray-50">
                  <td className="table-cell">
                    {l.job_card_no
                      ? <Link to={`/job-cards/${l.job_card_no}`}
                          className="font-semibold text-brand-700 hover:underline text-sm">
                          {l.job_card_no}
                        </Link>
                      : <span className="text-gray-400 text-sm">{l.reference || '—'}</span>
                    }
                  </td>
                  <td className="table-cell text-sm text-gray-600">{l.order_code || l.reference || '—'}</td>
                  <td className="table-cell text-sm text-gray-600">{l.customer_code || '—'}</td>
                  <td className="table-cell text-center">
                    <span className="inline-flex items-center gap-1 text-sm font-semibold text-green-700 bg-green-50 px-2 py-0.5 rounded-full">
                      +{l.qty}
                    </span>
                  </td>
                  <td className="table-cell text-sm text-gray-400">{l.notes || '—'}</td>
                  <td className="table-cell text-sm text-gray-500">{fmtDateTime(l.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Outward movements */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 bg-red-50 flex items-center gap-2">
          <ArrowUpCircle size={15} className="text-red-500" />
          <h2 className="text-sm font-semibold text-red-700 uppercase tracking-wide">
            Outward Movements — Dispatch & Sampling
          </h2>
        </div>
        {outwardLog.length === 0 ? (
          <p className="text-center text-gray-400 text-sm py-8">No outward movements recorded</p>
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
              {outwardLog.map(l => (
                <tr key={l.id} className="hover:bg-gray-50">
                  <td className="table-cell">
                    {l.outward_type === 'sampling' ? (
                      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700">
                        🧪 Sampling
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-red-100 text-red-700">
                        📦 Dispatch
                      </span>
                    )}
                  </td>
                  <td className="table-cell text-sm">
                    <div className="font-medium text-gray-800">{l.client_name || '—'}</div>
                    {l.client_code && <div className="text-xs text-gray-400">{l.client_code}</div>}
                  </td>
                  <td className="table-cell text-center">
                    <span className="inline-flex items-center gap-1 text-sm font-semibold text-red-700 bg-red-50 px-2 py-0.5 rounded-full">
                      -{l.qty}
                    </span>
                  </td>
                  <td className="table-cell text-sm text-gray-500">
                    {l.reason && <div className="text-amber-700 font-medium">{l.reason}</div>}
                    {l.reference && <div>{l.reference}</div>}
                    {l.notes && <div className="text-gray-400">{l.notes}</div>}
                    {!l.reason && !l.reference && !l.notes && '—'}
                  </td>
                  <td className="table-cell text-sm text-gray-600">{l.created_by_name || '—'}</td>
                  <td className="table-cell text-sm text-gray-500">{fmtDateTime(l.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
