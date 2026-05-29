import { useState } from 'react';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import { ROLE_LABELS, ROLE_COLORS } from '../../lib/utils';
import { User, Lock, CheckCircle, Settings } from 'lucide-react';

export default function AccountSettings() {
  const { user, init } = useAuthStore();
  const [name, setName] = useState(user?.name || '');
  const [nameMsg, setNameMsg] = useState('');
  const [nameSaving, setNameSaving] = useState(false);

  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [pwMsg, setPwMsg] = useState('');
  const [pwErr, setPwErr] = useState('');
  const [pwSaving, setPwSaving] = useState(false);

  const handleNameSave = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setNameSaving(true);
    setNameMsg('');
    try {
      await api.put('/auth/profile', { name });
      await init();
      setNameMsg('Name updated successfully');
    } catch (err) {
      setNameMsg(err.response?.data?.error || 'Failed to update');
    } finally {
      setNameSaving(false);
    }
  };

  const handlePwSave = async (e) => {
    e.preventDefault();
    setPwErr('');
    setPwMsg('');
    if (newPw.length < 6) return setPwErr('New password must be at least 6 characters');
    if (newPw !== newPw2) return setPwErr('Passwords do not match');
    setPwSaving(true);
    try {
      await api.put('/auth/change-password', { currentPassword: curPw, newPassword: newPw });
      setPwMsg('Password changed successfully');
      setCurPw(''); setNewPw(''); setNewPw2('');
    } catch (err) {
      setPwErr(err.response?.data?.error || 'Failed to change password');
    } finally {
      setPwSaving(false);
    }
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-8">
        <div className="w-10 h-10 rounded-xl bg-brand-600 flex items-center justify-center shadow-sm">
          <Settings size={20} className="text-white" />
        </div>
        <div>
          <h1 className="page-title">Account Settings</h1>
          <p className="text-gray-500 text-sm">Manage your profile and security</p>
        </div>
      </div>

      {/* Profile card */}
      <div className="card mb-5">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
            <User size={16} className="text-blue-600" />
          </div>
          <h2 className="font-semibold text-gray-900">Profile Information</h2>
        </div>
        <div className="px-6 py-5">
          {/* Current info */}
          <div className="flex items-center gap-4 mb-6 p-4 bg-gray-50 rounded-xl">
            <div className="w-12 h-12 rounded-full bg-brand-600 flex items-center justify-center text-white font-bold text-lg flex-shrink-0">
              {user?.name?.charAt(0)?.toUpperCase()}
            </div>
            <div>
              <div className="font-semibold text-gray-900">{user?.name}</div>
              <div className="text-sm text-gray-500">@{user?.username}</div>
              <span className={`inline-block mt-1 text-xs px-2 py-0.5 rounded-full font-medium ${ROLE_COLORS[user?.role]}`}>
                {ROLE_LABELS[user?.role]}
              </span>
            </div>
          </div>

          <form onSubmit={handleNameSave} className="space-y-4">
            <div>
              <label className="label">Display Name</label>
              <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Your full name" />
            </div>
            {nameMsg && (
              <div className="flex items-center gap-2 text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm">
                <CheckCircle size={14} /> {nameMsg}
              </div>
            )}
            <div className="flex justify-end">
              <button type="submit" className="btn-primary" disabled={nameSaving || !name.trim()}>
                {nameSaving ? 'Saving...' : 'Update Name'}
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Password card */}
      <div className="card">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-phe-50 flex items-center justify-center">
            <Lock size={16} className="text-phe-600" />
          </div>
          <h2 className="font-semibold text-gray-900">Change Password</h2>
        </div>
        <div className="px-6 py-5">
          <form onSubmit={handlePwSave} className="space-y-4">
            <div>
              <label className="label">Current Password</label>
              <input className="input" type="password" value={curPw} onChange={e => setCurPw(e.target.value)}
                placeholder="Enter current password" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label">New Password</label>
                <input className="input" type="password" value={newPw} onChange={e => setNewPw(e.target.value)}
                  placeholder="Min. 6 characters" />
              </div>
              <div>
                <label className="label">Confirm New Password</label>
                <input className="input" type="password" value={newPw2} onChange={e => setNewPw2(e.target.value)}
                  placeholder="Repeat new password" />
              </div>
            </div>

            {pwErr && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{pwErr}</div>
            )}
            {pwMsg && (
              <div className="flex items-center gap-2 text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm">
                <CheckCircle size={14} /> {pwMsg}
              </div>
            )}
            <div className="flex justify-end">
              <button type="submit" className="btn-primary" disabled={pwSaving || !curPw || !newPw || !newPw2}>
                {pwSaving ? 'Changing...' : 'Change Password'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
