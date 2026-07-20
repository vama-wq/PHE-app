import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import Modal from '../../components/ui/Modal';
import FileUpload from '../../components/ui/FileUpload';
import { fmtDate, fmtDateTime, ROLE_LABELS } from '../../lib/utils';
import {
  ArrowLeft, Send, Camera, Upload, CheckCircle, XCircle, AlertTriangle,
  MessageSquare, Clock, User, AtSign, ChevronRight, Truck, FileText,
  RotateCcw, CreditCard, Package, Wrench, Image, X, Paperclip, Download, File
, RefreshCw } from 'lucide-react';

const QUERY_STATUS_LABELS = {
  open: 'Open', in_progress: 'In Progress', resolved: 'Resolved', product_return: 'Product Return',
};
const QUERY_STATUS_COLORS = {
  open: 'bg-red-100 text-red-800 border-red-200',
  in_progress: 'bg-amber-100 text-amber-800 border-amber-200',
  resolved: 'bg-green-100 text-green-800 border-green-200',
  product_return: 'bg-rose-100 text-rose-800 border-rose-200',
};
const RETURN_STATUS_LABELS = {
  pending_return: 'Pending Return', received: 'Received', qc_check: 'QC Check',
  qc_pass: 'QC Passed', qc_fail: 'QC Failed', in_repair: 'In Repair',
  repaired_dispatched: 'Repaired & Dispatched', debit_note_issued: 'Debit Note Issued',
  replacement_issued: 'Replacement Issued',
};
const RETURN_STATUS_COLORS = {
  pending_return: 'bg-yellow-100 text-yellow-800',
  received: 'bg-blue-100 text-blue-800',
  qc_check: 'bg-purple-100 text-purple-800',
  qc_pass: 'bg-green-100 text-green-800',
  qc_fail: 'bg-red-100 text-red-800',
  in_repair: 'bg-orange-100 text-orange-800',
  repaired_dispatched: 'bg-teal-100 text-teal-800',
  debit_note_issued: 'bg-gray-100 text-gray-800',
  replacement_issued: 'bg-blue-100 text-blue-800',
};
const ROLE_COLORS_CHAT = {
  owner: 'bg-purple-50 border-purple-200', admin: 'bg-blue-50 border-blue-200',
  accounts: 'bg-green-50 border-green-200', design: 'bg-orange-50 border-orange-200',
  production: 'bg-red-50 border-red-200',
};

export default function CustomerQueryDetail() {
  const { id } = useParams();
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [query, setQuery] = useState(null);
  const [messages, setMessages] = useState([]);
  const [photos, setPhotos] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('chat');

  // Chat state
  const [newMsg, setNewMsg] = useState('');
  const [sending, setSending] = useState(false);
  const [mentionIds, setMentionIds] = useState([]);
  const [showMentions, setShowMentions] = useState(false);
  const [chatAttachments, setChatAttachments] = useState([]);
  const chatEndRef = useRef(null);
  const chatFileRef = useRef(null);

  // Modal states
  const [showResolve, setShowResolve] = useState(false);
  const [showReturnType, setShowReturnType] = useState(false);
  const [showDebitNote, setShowDebitNote] = useState(false);
  const [showQCResult, setShowQCResult] = useState(false);
  const [showRepairComplete, setShowRepairComplete] = useState(false);
  const [showPhotoUpload, setShowPhotoUpload] = useState(false);

  const load = useCallback(() => {
    Promise.all([
      api.get(`/customer-queries/${id}`),
      api.get(`/customer-queries/${id}/messages`),
      api.get(`/customer-queries/${id}/photos`),
      api.get('/customer-queries/users/list'),
    ]).then(([qR, mR, pR, uR]) => {
      setQuery(qR.data);
      setMessages(mR.data);
      setPhotos(pR.data);
      setUsers(uR.data);
    }).finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => {
      api.get(`/customer-queries/${id}/messages`).then(r => setMessages(r.data)).catch(() => {});
      api.get(`/customer-queries/${id}`).then(r => setQuery(r.data)).catch(() => {});
    }, 10000);
    return () => clearInterval(t);
  }, [id]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async () => {
    if (!newMsg.trim() && !chatAttachments.length) return;
    setSending(true);
    try {
      let finalMsg = newMsg;
      if (mentionIds.length > 0) {
        const mentionNames = mentionIds
          .map(uid => users.find(u => u.id === uid))
          .filter(Boolean)
          .map(u => `@${u.name}`)
          .join(' ');
        finalMsg = mentionNames + ' ' + newMsg;
      }
      const fd = new FormData();
      fd.append('message', finalMsg);
      fd.append('mentionIds', JSON.stringify(mentionIds));
      chatAttachments.forEach(f => fd.append('attachments', f));
      await api.post(`/customer-queries/${id}/messages`, fd);
      setNewMsg('');
      setMentionIds([]);
      setChatAttachments([]);
      const r = await api.get(`/customer-queries/${id}/messages`);
      setMessages(r.data);
    } catch {}
    setSending(false);
  };

  const toggleMention = (userId) => {
    setMentionIds(prev => prev.includes(userId) ? prev.filter(i => i !== userId) : [...prev, userId]);
  };

  const isOwner = user.role === 'owner';
  const canManage = ['accounts', 'owner', 'admin'].includes(user.role);
  const isQC = ['design', 'owner', 'admin'].includes(user.role);

  if (loading) return <div className="p-12 text-center text-gray-400">Loading...</div>;
  if (!query) return <div className="p-12 text-center text-gray-500">Query not found</div>;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <button onClick={() => navigate('/customer-queries')}
            className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-2">
            <ArrowLeft size={14} /> Back to Queries
          </button>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-3">
            {query.query_no}
            <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium border ${QUERY_STATUS_COLORS[query.status]}`}>
              {QUERY_STATUS_LABELS[query.status]}
            </span>
          </h1>
          <p className="text-gray-600 mt-1">{query.subject}</p>
        </div>
        <div className="flex gap-2">
          {/* Full Timeline link for owner */}
          {isOwner && (
            <Link to={`/order-timeline/${query.order_id}`}
              className="btn-secondary flex items-center gap-1.5">
              <Clock size={15} /> Full Timeline
            </Link>
          )}
          {/* Owner-only resolve button */}
          {isOwner && query.status !== 'resolved' && !query.return_type && (
            <button className="btn-primary flex items-center gap-1.5"
              onClick={() => setShowResolve(true)}>
              <CheckCircle size={15} /> Resolve
            </button>
          )}
        </div>
      </div>

      {/* Info cards row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {/* Query Info */}
        <div className="card p-4 space-y-2">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Query Details</h3>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Category</span>
              <span className="font-medium capitalize">{query.category || 'General'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Priority</span>
              <span className={`font-semibold uppercase text-xs ${
                query.priority === 'critical' ? 'text-red-600' :
                query.priority === 'high' ? 'text-orange-600' :
                query.priority === 'medium' ? 'text-amber-600' : 'text-gray-500'
              }`}>{query.priority}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Assigned To</span>
              <span className="font-medium capitalize text-blue-700">{query.assigned_department || '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Raised By</span>
              <span className="font-medium">{query.created_by_name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Created</span>
              <span className="text-gray-600">{fmtDateTime(query.created_at)}</span>
            </div>
          </div>
        </div>

        {/* Order/Product Info */}
        <div className="card p-4 space-y-2">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Order Info</h3>
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Order</span>
              <Link to={`/orders/${query.order_id}`} className="font-medium text-brand-700 hover:underline">
                {query.order_code}
              </Link>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Customer</span>
              <span className="font-medium">{query.customer_name ? `${query.customer_code} — ${query.customer_name}` : query.customer_code}</span>
            </div>
            {query.job_card_no && (
              <div className="flex justify-between">
                <span className="text-gray-500">Job Card</span>
                <Link to={`/job-cards/${query.job_card_id}`} className="font-medium text-brand-700 hover:underline">
                  {query.job_card_no}
                </Link>
              </div>
            )}
            {query.product_name && (
              <div className="flex justify-between">
                <span className="text-gray-500">Product</span>
                <span className="font-medium">{query.product_name}</span>
              </div>
            )}
            {query.drawing_no && (
              <div className="flex justify-between">
                <span className="text-gray-500">Drawing</span>
                <span className="text-gray-600">{query.drawing_no}</span>
              </div>
            )}
          </div>
        </div>

        {/* Return / Resolution Info */}
        <div className="card p-4 space-y-2">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Resolution</h3>
          {query.status === 'resolved' ? (
            <div className="space-y-2">
              <div className="bg-green-50 border border-green-200 rounded-lg p-2.5">
                <div className="flex items-center gap-1.5 text-green-700 font-semibold text-sm mb-1">
                  <CheckCircle size={14} /> Resolved
                </div>
                <p className="text-sm text-green-800">{query.resolution_summary}</p>
                <p className="text-xs text-green-600 mt-1">by {query.resolved_by_name} on {fmtDateTime(query.resolved_at)}</p>
              </div>
              {query.return_type && (
                <div className="text-sm space-y-1">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Return Type</span>
                    <span className="font-medium capitalize">{query.return_type === 'debit_note' ? 'Debit Note' : query.return_type}</span>
                  </div>
                  {query.return_coupon_no && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Return Coupon</span>
                      <span className="font-medium">{query.return_coupon_no}</span>
                    </div>
                  )}
                  {query.debit_note_no && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Debit Note</span>
                      <span className="font-medium">{query.debit_note_no}</span>
                    </div>
                  )}
                  {query.return_status && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Return Status</span>
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${RETURN_STATUS_COLORS[query.return_status]}`}>
                        {RETURN_STATUS_LABELS[query.return_status]}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : query.status === 'product_return' ? (
            <div className="space-y-2">
              <div className="bg-rose-50 border border-rose-200 rounded-lg p-2.5">
                <div className="text-sm font-semibold text-rose-700 mb-1">Product Return</div>
                <p className="text-sm text-rose-800">{query.resolution_summary}</p>
              </div>
              {query.return_status && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">Status:</span>
                  <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${RETURN_STATUS_COLORS[query.return_status]}`}>
                    {RETURN_STATUS_LABELS[query.return_status]}
                  </span>
                </div>
              )}
              {query.return_coupon_no && (
                <div className="text-sm"><span className="text-gray-500">Coupon:</span> <span className="font-medium">{query.return_coupon_no}</span></div>
              )}
              {query.debit_note_no && (
                <div className="text-sm"><span className="text-gray-500">Debit Note:</span> <span className="font-medium">{query.debit_note_no}</span></div>
              )}

              {/* Action buttons for return flow */}
              <div className="pt-2 space-y-2">
                {/* If pending_return and no return_type yet → Set Return Type */}
                {isOwner && query.return_status === 'pending_return' && !query.return_type && (
                  <button className="btn-primary w-full text-sm" onClick={() => setShowReturnType(true)}>
                    Set Return Type
                  </button>
                )}
                {/* If pending_return and return_type IS set → Material Received */}
                {canManage && query.return_status === 'pending_return' && query.return_type && (
                  <div>
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 mb-2">
                      <div className="flex items-center gap-1.5 text-amber-700 text-xs font-semibold mb-0.5">
                        <AlertTriangle size={13} /> Awaiting Material Return
                      </div>
                      <p className="text-xs text-amber-600">
                        Return type: <span className="font-semibold capitalize">{query.return_type === 'debit_note' ? 'Debit Note' : 'Repair'}</span>.
                        Mark as received once the product arrives.
                      </p>
                    </div>
                    <button className="btn-primary w-full text-sm flex items-center justify-center gap-1.5"
                      onClick={async () => {
                        if (!confirm('Confirm material has been received? This will send the product to ' +
                          (query.return_type === 'repair' ? 'production for repair.' : 'QC for inspection.'))) return;
                        try {
                          await api.put(`/customer-queries/${id}/material-received`);
                          load();
                        } catch (err) {
                          alert(err.response?.data?.error || 'Failed to mark as received');
                        }
                      }}>
                      <Package size={14} /> Material Received
                    </button>
                  </div>
                )}
                {query.return_type === 'debit_note' && !query.debit_note_no && canManage && (
                  <button className="btn-secondary w-full text-sm flex items-center justify-center gap-1"
                    onClick={() => setShowDebitNote(true)}>
                    <CreditCard size={14} /> Add Debit Note
                  </button>
                )}
                {isQC && query.return_status === 'qc_check' && (
                  <button className="btn-primary w-full text-sm" onClick={() => setShowQCResult(true)}>
                    Submit QC Result
                  </button>
                )}
                {query.return_status === 'in_repair' && (
                  <div className="w-full text-xs text-blue-700 bg-blue-50 border border-blue-100 rounded-lg p-2.5 text-center flex items-start gap-1.5">
                    <Truck size={13} className="flex-shrink-0 mt-0.5" />
                    <span>In repair in <strong>Production</strong>. Complete its production checklist → it goes to <strong>QC</strong> for approval, then <strong>Dispatch</strong> (no new invoice needed).</span>
                  </div>
                )}
                {canManage && query.return_type === 'debit_note' && query.debit_note_no && query.return_status !== 'debit_note_issued' && (
                  <button className="btn-primary w-full text-sm" onClick={async () => {
                    if (!confirm('Complete the debit note process?')) return;
                    await api.put(`/customer-queries/${id}/debit-note-complete`);
                    load();
                  }}>
                    Complete Debit Note
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="text-sm text-gray-400 py-4 text-center">
              <Clock size={24} className="mx-auto mb-2 text-gray-300" />
              Pending resolution
            </div>
          )}
        </div>
      </div>

      {/* Description */}
      {query.description && (
        <div className="card p-4 mb-6">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-2">Description</h3>
          <p className="text-sm text-gray-700 whitespace-pre-wrap">{query.description}</p>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-gray-200 mb-4">
        {[
          { key: 'chat', label: 'Chat', icon: MessageSquare, count: messages.length },
          { key: 'photos', label: 'Photos', icon: Image, count: photos.length },
        ].map(tab => (
          <button key={tab.key}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'border-brand-600 text-brand-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
            onClick={() => setActiveTab(tab.key)}>
            <tab.icon size={15} />
            {tab.label}
            {tab.count > 0 && (
              <span className="ml-1 text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-full">{tab.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* Chat Tab */}
      {activeTab === 'chat' && (
        <div className="card">
          {/* Messages */}
          <div className="max-h-[500px] overflow-y-auto p-4 space-y-3" id="chat-messages">
            {messages.length === 0 ? (
              <div className="text-center text-gray-400 py-8">
                <MessageSquare size={32} className="mx-auto mb-2 text-gray-300" />
                <p>No messages yet. Start the conversation.</p>
              </div>
            ) : messages.map(msg => {
              const isMe = msg.user_id === user.id;
              return (
                <div key={msg.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[70%] rounded-xl px-4 py-2.5 border ${
                    isMe ? 'bg-brand-50 border-brand-200' : (ROLE_COLORS_CHAT[msg.user_role] || 'bg-gray-50 border-gray-200')
                  }`}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-semibold text-gray-700">{msg.user_name}</span>
                      <span className="text-xs text-gray-400 capitalize">{ROLE_LABELS[msg.user_role] || msg.user_role}</span>
                    </div>
                    {msg.message && <p className="text-sm text-gray-800 whitespace-pre-wrap">{highlightMentions(msg.message, users)}</p>}
                    {msg.attachments?.length > 0 && (
                      <div className={`flex flex-wrap gap-2 ${msg.message ? 'mt-2' : ''}`}>
                        {msg.attachments.map(att => {
                          const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(att.file_name);
                          return isImage ? (
                            <a key={att.id} href={`/uploads/${att.file_path}`} target="_blank" rel="noreferrer" className="block">
                              <img src={`/uploads/${att.file_path}`} alt={att.file_name} className="max-w-[200px] max-h-[150px] rounded-lg border border-gray-200 object-cover" />
                            </a>
                          ) : (
                            <a key={att.id} href={`/uploads/${att.file_path}`} target="_blank" rel="noreferrer"
                              className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs bg-white border border-gray-200 text-gray-700 hover:bg-gray-50">
                              <File size={12} />
                              <span className="truncate max-w-[120px]">{att.file_name}</span>
                              <Download size={10} />
                            </a>
                          );
                        })}
                      </div>
                    )}
                    <div className="text-xs text-gray-400 mt-1 text-right">{fmtDateTime(msg.created_at)}</div>
                  </div>
                </div>
              );
            })}
            <div ref={chatEndRef} />
          </div>

          {/* Compose */}
          {query.status !== 'resolved' && (
            <div className="border-t border-gray-200 p-4">
              {/* Mention chips */}
              {mentionIds.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-2">
                  {mentionIds.map(uid => {
                    const u = users.find(u => u.id === uid);
                    return u ? (
                      <span key={uid} className="inline-flex items-center gap-1 text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                        @{u.name}
                        <button onClick={() => toggleMention(uid)} className="hover:text-blue-900"><X size={10} /></button>
                      </span>
                    ) : null;
                  })}
                </div>
              )}
              {chatAttachments.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {chatAttachments.map((f, i) => (
                    <div key={i} className="flex items-center gap-1.5 bg-gray-100 rounded-lg px-2 py-1 text-xs text-gray-600">
                      <Paperclip size={10} />
                      <span className="truncate max-w-[120px]">{f.name}</span>
                      <button type="button" onClick={() => setChatAttachments(prev => prev.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-500">
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex gap-2">
                <div className="relative">
                  <button className="btn-ghost p-2 text-gray-400 hover:text-blue-600"
                    onClick={() => setShowMentions(!showMentions)} title="Mention user">
                    <AtSign size={18} />
                  </button>
                  {showMentions && (
                    <div className="absolute bottom-full left-0 mb-1 bg-white border border-gray-200 rounded-lg shadow-lg w-56 max-h-48 overflow-y-auto z-10">
                      {users.filter(u => u.id !== user.id).map(u => (
                        <button key={u.id}
                          className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center justify-between ${
                            mentionIds.includes(u.id) ? 'bg-blue-50' : ''
                          }`}
                          onClick={() => { toggleMention(u.id); }}>
                          <div>
                            <div className="font-medium">{u.name}</div>
                            <div className="text-xs text-gray-400 capitalize">{u.role}</div>
                          </div>
                          {mentionIds.includes(u.id) && <CheckCircle size={14} className="text-blue-600" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <input type="file" ref={chatFileRef} className="hidden" multiple
                  accept="image/*,.pdf,.doc,.docx,.xls,.xlsx"
                  onChange={e => { setChatAttachments(prev => [...prev, ...Array.from(e.target.files)]); e.target.value = ''; }}
                />
                <button type="button" onClick={() => chatFileRef.current?.click()}
                  className="btn-ghost p-2 text-gray-400 hover:text-blue-600" title="Attach files">
                  <Paperclip size={18} />
                </button>
                <input
                  className="input flex-1"
                  placeholder="Type a message..."
                  value={newMsg}
                  onChange={e => setNewMsg(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                  onFocus={() => setShowMentions(false)}
                />
                <button className="btn-primary px-4" onClick={sendMessage} disabled={sending || (!newMsg.trim() && !chatAttachments.length)}>
                  <Send size={16} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Photos Tab */}
      {activeTab === 'photos' && (
        <div className="card p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-700">Query Photos</h3>
            {query.status !== 'resolved' && (
              <button className="btn-secondary btn-sm flex items-center gap-1 text-xs"
                onClick={() => setShowPhotoUpload(true)}>
                <Upload size={13} /> Upload Photos
              </button>
            )}
          </div>
          {photos.length === 0 ? (
            <div className="text-center text-gray-400 py-8">
              <Camera size={32} className="mx-auto mb-2 text-gray-300" />
              <p>No photos uploaded yet</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {photos.map(p => (
                <div key={p.id} className="relative group">
                  <a href={`/uploads/${p.file_path}`} target="_blank" rel="noreferrer">
                    <img src={`/uploads/${p.file_path}`} alt={p.caption || 'Query photo'}
                      className="w-full h-32 object-cover rounded-lg border border-gray-200 hover:opacity-90 transition-opacity" />
                  </a>
                  <div className="mt-1 text-xs text-gray-500">
                    {p.uploaded_by_name} - {fmtDate(p.created_at)}
                  </div>
                  {p.caption && <div className="text-xs text-gray-600 italic">{p.caption}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Modals ── */}
      {showResolve && <ResolveModal query={query} onClose={() => setShowResolve(false)} onDone={() => { setShowResolve(false); load(); }} />}
      {showReturnType && <ReturnTypeModal query={query} onClose={() => setShowReturnType(false)} onDone={() => { setShowReturnType(false); load(); }} />}
      {showDebitNote && <DebitNoteModal query={query} onClose={() => setShowDebitNote(false)} onDone={() => { setShowDebitNote(false); load(); }} />}
      {showQCResult && <QCResultModal query={query} onClose={() => setShowQCResult(false)} onDone={() => { setShowQCResult(false); load(); }} />}
      {showRepairComplete && <RepairCompleteModal query={query} onClose={() => setShowRepairComplete(false)} onDone={() => { setShowRepairComplete(false); load(); }} />}
      {showPhotoUpload && <PhotoUploadModal queryId={query.id} onClose={() => setShowPhotoUpload(false)} onDone={() => { setShowPhotoUpload(false); load(); }} />}
    </div>
  );
}

// Highlight @mentions in message text
function highlightMentions(text, users) {
  if (!text) return text;
  const parts = text.split(/(@[\w][\w\s/]*[\w])/g);
  return parts.map((part, i) => {
    if (part.startsWith('@')) {
      return <span key={i} className="text-blue-600 font-semibold bg-blue-50 px-0.5 rounded">{part}</span>;
    }
    return part;
  });
}

// ── Resolve Modal ──────────────────────────────────────────────────────────
function ResolveModal({ query, onClose, onDone }) {
  const [type, setType] = useState('resolved');
  const [summary, setSummary] = useState('');
  const [cardChoice, setCardChoice] = useState('keep'); // 'keep' | 'new' — job card for the replacement run
  const [newCardFile, setNewCardFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!summary.trim()) { setError('Resolution summary is required'); return; }
    if (type === 'replaced' && cardChoice === 'new' && !newCardFile) {
      setError('Upload the new job card file, or choose to keep the existing card.'); return;
    }
    setSaving(true);
    try {
      if (type === 'replaced') {
        const fd = new FormData();
        fd.append('resolution_type', type);
        fd.append('resolution_summary', summary);
        if (cardChoice === 'new' && newCardFile) fd.append('file', newCardFile);
        await api.put(`/customer-queries/${query.id}/resolve`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      } else {
        await api.put(`/customer-queries/${query.id}/resolve`, {
          resolution_type: type, resolution_summary: summary
        });
      }
      onDone();
    } catch (err) { setError(err.response?.data?.error || 'Failed'); setSaving(false); }
  };

  return (
    <Modal open title="Resolve Query" onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label className="label">Resolution Type</label>
          <div className="grid grid-cols-3 gap-3">
            <button className={`p-4 rounded-xl border-2 text-left transition-all ${
              type === 'resolved' ? 'border-green-500 bg-green-50' : 'border-gray-200 hover:border-gray-300'
            }`} onClick={() => setType('resolved')}>
              <CheckCircle size={20} className={type === 'resolved' ? 'text-green-600' : 'text-gray-400'} />
              <div className="font-semibold mt-1">Resolved</div>
              <div className="text-xs text-gray-500 mt-0.5">Issue is fixed, order stays dispatched</div>
            </button>
            <button className={`p-4 rounded-xl border-2 text-left transition-all ${
              type === 'product_return' ? 'border-rose-500 bg-rose-50' : 'border-gray-200 hover:border-gray-300'
            }`} onClick={() => setType('product_return')}>
              <RotateCcw size={20} className={type === 'product_return' ? 'text-rose-600' : 'text-gray-400'} />
              <div className="font-semibold mt-1">Product Return</div>
              <div className="text-xs text-gray-500 mt-0.5">Product needs to come back (repair or debit note)</div>
            </button>
            <button className={`p-4 rounded-xl border-2 text-left transition-all ${
              type === 'replaced' ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
            }`} onClick={() => setType('replaced')}>
              <RefreshCw size={20} className={type === 'replaced' ? 'text-blue-600' : 'text-gray-400'} />
              <div className="font-semibold mt-1">Replace — No Return</div>
              <div className="text-xs text-gray-500 mt-0.5">Replacement goes straight to production, tagged with this query</div>
            </button>
          </div>
        </div>
        {type === 'replaced' && (
          <div className="bg-blue-50/50 border border-blue-200 rounded-xl p-3 space-y-2">
            <label className="label mb-0">Job card for the replacement run</label>
            <div className="flex gap-2">
              <button type="button"
                className={`flex-1 py-2 px-3 rounded-lg border-2 text-sm font-medium transition-colors ${
                  cardChoice === 'keep' ? 'bg-white border-blue-500 text-blue-700' : 'border-gray-200 text-gray-600 hover:border-gray-300'
                }`}
                onClick={() => { setCardChoice('keep'); setNewCardFile(null); }}>
                Keep same job card
              </button>
              <button type="button"
                className={`flex-1 py-2 px-3 rounded-lg border-2 text-sm font-medium transition-colors ${
                  cardChoice === 'new' ? 'bg-white border-blue-500 text-blue-700' : 'border-gray-200 text-gray-600 hover:border-gray-300'
                }`}
                onClick={() => setCardChoice('new')}>
                Upload new job card
              </button>
            </div>
            {cardChoice === 'new' && (
              <label className="flex items-center gap-2 cursor-pointer border border-gray-200 rounded-lg px-3 py-2 hover:border-brand-400 transition-colors bg-white">
                <Upload size={15} className="text-gray-400 flex-shrink-0" />
                <span className="text-sm text-gray-600 flex-1 truncate">{newCardFile ? newCardFile.name : 'Attach the new job card…'}</span>
                <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.xls,.xlsx" className="hidden"
                  onChange={e => { setNewCardFile(e.target.files[0] || null); setError(''); }} />
              </label>
            )}
            <p className="text-[11px] text-gray-500">The replacement card goes straight into production with this document.</p>
          </div>
        )}

        <div>
          <label className="label">Resolution Summary *</label>
          <textarea className="input" rows={3} value={summary} onChange={e => setSummary(e.target.value)}
            placeholder="Describe how this was resolved..." />
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <div className="flex gap-3">
          <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" onClick={handleSubmit} disabled={saving}>
            {saving ? 'Saving...' : type === 'resolved' ? 'Resolve & Close' : type === 'replaced' ? 'Issue Replacement' : 'Initiate Return'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Return Type Modal ──────────────────────────────────────────────────────
function ReturnTypeModal({ query, onClose, onDone }) {
  const [type, setType] = useState('repair');
  const [coupon, setCoupon] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    setSaving(true);
    try {
      await api.put(`/customer-queries/${query.id}/return-type`, {
        return_type: type, return_coupon_no: coupon
      });
      onDone();
    } catch (err) { setError(err.response?.data?.error || 'Failed'); setSaving(false); }
  };

  return (
    <Modal open title="Set Return Type" onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <button className={`p-4 rounded-xl border-2 text-left ${
            type === 'repair' ? 'border-orange-500 bg-orange-50' : 'border-gray-200'
          }`} onClick={() => setType('repair')}>
            <Wrench size={20} className={type === 'repair' ? 'text-orange-600' : 'text-gray-400'} />
            <div className="font-semibold mt-1">Repair & Return</div>
            <div className="text-xs text-gray-500 mt-0.5">Product goes to production for repair, then back to customer</div>
          </button>
          <button className={`p-4 rounded-xl border-2 text-left ${
            type === 'debit_note' ? 'border-purple-500 bg-purple-50' : 'border-gray-200'
          }`} onClick={() => setType('debit_note')}>
            <CreditCard size={20} className={type === 'debit_note' ? 'text-purple-600' : 'text-gray-400'} />
            <div className="font-semibold mt-1">Debit Note</div>
            <div className="text-xs text-gray-500 mt-0.5">Customer issues debit note, product goes to QC then finished goods</div>
          </button>
        </div>
        <div>
          <label className="label">Return Coupon No</label>
          <input className="input" value={coupon} onChange={e => setCoupon(e.target.value)}
            placeholder="e.g. RET-001" />
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <div className="flex gap-3">
          <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" onClick={handleSubmit} disabled={saving}>
            {saving ? 'Saving...' : 'Confirm'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Debit Note Modal ───────────────────────────────────────────────────────
function DebitNoteModal({ query, onClose, onDone }) {
  const [no, setNo] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  return (
    <Modal open title="Add Debit Note" onClose={onClose} size="sm">
      <div className="space-y-4">
        <div>
          <label className="label">Debit Note Number *</label>
          <input className="input" value={no} onChange={e => setNo(e.target.value)} placeholder="e.g. DN-2024-001" />
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <div className="flex gap-3">
          <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={saving} onClick={async () => {
            if (!no.trim()) { setError('Debit note number is required'); return; }
            setSaving(true);
            try {
              await api.put(`/customer-queries/${query.id}/debit-note`, { debit_note_no: no });
              onDone();
            } catch (err) { setError(err.response?.data?.error || 'Failed'); setSaving(false); }
          }}>
            {saving ? 'Saving...' : 'Add Debit Note'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── QC Result Modal ────────────────────────────────────────────────────────
function QCResultModal({ query, onClose, onDone }) {
  const [result, setResult] = useState('pass');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  return (
    <Modal open title="QC Inspection Result" onClose={onClose} size="sm">
      <div className="space-y-4">
        <p className="text-sm text-gray-600">Inspect the returned product and submit QC result:</p>
        <div className="grid grid-cols-2 gap-3">
          <button className={`p-4 rounded-xl border-2 text-center ${
            result === 'pass' ? 'border-green-500 bg-green-50' : 'border-gray-200'
          }`} onClick={() => setResult('pass')}>
            <CheckCircle size={24} className={`mx-auto ${result === 'pass' ? 'text-green-600' : 'text-gray-400'}`} />
            <div className="font-semibold mt-1">Pass</div>
            <div className="text-xs text-gray-500">Add to Finished Goods</div>
          </button>
          <button className={`p-4 rounded-xl border-2 text-center ${
            result === 'fail' ? 'border-red-500 bg-red-50' : 'border-gray-200'
          }`} onClick={() => setResult('fail')}>
            <XCircle size={24} className={`mx-auto ${result === 'fail' ? 'text-red-600' : 'text-gray-400'}`} />
            <div className="font-semibold mt-1">Fail</div>
            <div className="text-xs text-gray-500">Send to Production for repair</div>
          </button>
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <div className="flex gap-3">
          <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className={`flex-1 ${result === 'pass' ? 'btn-primary' : 'bg-red-600 text-white rounded-lg py-2 font-medium hover:bg-red-700'}`}
            disabled={saving} onClick={async () => {
              setSaving(true);
              try {
                await api.put(`/customer-queries/${query.id}/qc-result`, { result });
                onDone();
              } catch (err) { setError(err.response?.data?.error || 'Failed'); setSaving(false); }
            }}>
            {saving ? 'Saving...' : result === 'pass' ? 'QC Pass' : 'QC Fail'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Repair Complete Modal ──────────────────────────────────────────────────
function RepairCompleteModal({ query, onClose, onDone }) {
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  return (
    <Modal open title="Repair Complete — Dispatch" onClose={onClose} size="sm">
      <div className="space-y-4">
        <p className="text-sm text-gray-600">Mark the repaired product as dispatched back to customer.</p>
        <div>
          <label className="label">Shipping Carrier</label>
          <input className="input" value={carrier} onChange={e => setCarrier(e.target.value)} placeholder="e.g. DTDC" />
        </div>
        <div>
          <label className="label">Tracking Number</label>
          <input className="input" value={tracking} onChange={e => setTracking(e.target.value)} />
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <div className="flex gap-3">
          <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={saving} onClick={async () => {
            setSaving(true);
            try {
              await api.put(`/customer-queries/${query.id}/repair-complete`, {
                shipping_carrier: carrier, tracking_number: tracking
              });
              onDone();
            } catch (err) { setError(err.response?.data?.error || 'Failed'); setSaving(false); }
          }}>
            {saving ? 'Saving...' : 'Mark Dispatched'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Photo Upload Modal ─────────────────────────────────────────────────────
function PhotoUploadModal({ queryId, onClose, onDone }) {
  const [files, setFiles] = useState([]);
  const [caption, setCaption] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!files.length) { setError('Select at least one photo'); return; }
    setSaving(true);
    const fd = new FormData();
    files.forEach(f => fd.append('photos', f));
    fd.append('caption', caption);
    try {
      await api.post(`/customer-queries/${queryId}/photos`, fd);
      onDone();
    } catch (err) { setError(err.response?.data?.error || 'Upload failed'); setSaving(false); }
  };

  return (
    <Modal open title="Upload Photos" onClose={onClose} size="sm">
      <div className="space-y-4">
        <div>
          <label className="label">Photos</label>
          <input type="file" multiple accept="image/*,.pdf"
            onChange={e => setFiles(Array.from(e.target.files))}
            className="input text-sm" />
          {files.length > 0 && (
            <p className="text-xs text-gray-500 mt-1">{files.length} file(s) selected</p>
          )}
        </div>
        <div>
          <label className="label">Caption (optional)</label>
          <input className="input" value={caption} onChange={e => setCaption(e.target.value)}
            placeholder="Describe the issue..." />
        </div>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <div className="flex gap-3">
          <button className="btn-secondary flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" onClick={handleSubmit} disabled={saving}>
            {saving ? 'Uploading...' : 'Upload'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
