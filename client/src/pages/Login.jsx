import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import api from '../lib/api';
import { Eye, EyeOff, Lock } from 'lucide-react';

export default function Login() {
  const [form, setForm] = useState({ username: '', password: '' });
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [changePw, setChangePw] = useState(false);
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const { login } = useAuthStore();
  const navigate = useNavigate();

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await login(form.username, form.password);
      if (data.forcePasswordChange) {
        setChangePw(true);
      } else {
        navigate('/');
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Invalid credentials');
    } finally {
      setLoading(false);
    }
  };

  const handleChangePw = async (e) => {
    e.preventDefault();
    if (newPw.length < 6) return setError('Password must be at least 6 characters');
    if (newPw !== newPw2) return setError('Passwords do not match');
    setLoading(true);
    try {
      await api.put('/auth/change-password', { currentPassword: form.password, newPassword: newPw });
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to change password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex" style={{ background: 'linear-gradient(135deg, #0f1e42 0%, #1a1f35 50%, #0f1e42 100%)' }}>
      {/* Left branding panel */}
      <div className="hidden lg:flex flex-col justify-center items-center w-2/5 px-12 relative overflow-hidden">
        <div className="absolute inset-0 opacity-5" style={{
          backgroundImage: 'radial-gradient(circle at 20% 50%, #e11d48 0%, transparent 60%), radial-gradient(circle at 80% 20%, #1e3a8a 0%, transparent 50%)'
        }} />
        <div className="relative z-10 text-center">
          <div className="w-48 bg-white rounded-2xl p-4 mx-auto mb-8 shadow-2xl">
            <img src="/logo.png" alt="PHE Logo" className="w-full object-contain" />
          </div>
          <h1 className="text-3xl font-bold text-white mb-3 tracking-tight">Production Management</h1>
          <p className="text-slate-400 text-base leading-relaxed max-w-xs">
            End-to-end visibility across orders, production, quality, and dispatch.
          </p>
          <div className="mt-10 flex items-center justify-center gap-6">
            {['Orders', 'Production', 'QC', 'Dispatch'].map(label => (
              <div key={label} className="text-center">
                <div className="w-2 h-2 rounded-full bg-phe-500 mx-auto mb-1.5" />
                <span className="text-xs text-slate-500 font-medium">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right login panel */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          {/* Mobile logo */}
          <div className="lg:hidden bg-white rounded-2xl p-4 w-40 mx-auto mb-8 shadow-xl">
            <img src="/logo.png" alt="PHE" className="w-full" />
          </div>

          <div className="bg-white rounded-2xl shadow-2xl overflow-hidden">
            {/* Card header */}
            <div className="px-8 pt-8 pb-6 border-b border-gray-100">
              {!changePw ? (
                <>
                  <h2 className="text-2xl font-bold text-gray-900 tracking-tight">Sign In</h2>
                  <p className="text-gray-500 text-sm mt-1">Enter your credentials to continue</p>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2.5 mb-1">
                    <div className="w-8 h-8 rounded-lg bg-phe-50 flex items-center justify-center">
                      <Lock size={16} className="text-phe-600" />
                    </div>
                    <h2 className="text-xl font-bold text-gray-900">Set New Password</h2>
                  </div>
                  <p className="text-sm text-gray-500">You must set a new password before continuing.</p>
                </>
              )}
            </div>

            <div className="px-8 py-6">
              {!changePw ? (
                <form onSubmit={handleLogin} className="space-y-5">
                  <div>
                    <label className="label">Username</label>
                    <input
                      className="input"
                      placeholder="e.g. admin"
                      value={form.username}
                      onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="label">Password</label>
                    <div className="relative">
                      <input
                        className="input pr-10"
                        type={showPw ? 'text' : 'password'}
                        placeholder="Enter your password"
                        value={form.password}
                        onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                      />
                      <button type="button" className="absolute right-3 top-2.5 text-gray-400 hover:text-gray-600 transition-colors"
                        onClick={() => setShowPw(s => !s)}>
                        {showPw ? <EyeOff size={17} /> : <Eye size={17} />}
                      </button>
                    </div>
                  </div>

                  {error && (
                    <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                      <span className="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0" />
                      {error}
                    </div>
                  )}

                  <button type="submit" className="btn-primary w-full justify-center py-3 text-base mt-2" disabled={loading}>
                    {loading ? (
                      <span className="flex items-center gap-2"><span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />Signing in...</span>
                    ) : 'Sign In'}
                  </button>
                </form>
              ) : (
                <form onSubmit={handleChangePw} className="space-y-4">
                  <div>
                    <label className="label">New Password</label>
                    <input className="input" type="password" value={newPw} onChange={e => setNewPw(e.target.value)}
                      placeholder="At least 6 characters" autoFocus />
                  </div>
                  <div>
                    <label className="label">Confirm New Password</label>
                    <input className="input" type="password" value={newPw2} onChange={e => setNewPw2(e.target.value)}
                      placeholder="Repeat your password" />
                  </div>
                  {error && (
                    <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
                  )}
                  <button type="submit" className="btn-primary w-full justify-center py-3" disabled={loading}>
                    {loading ? 'Saving...' : 'Set Password & Continue'}
                  </button>
                </form>
              )}
            </div>
          </div>

          <p className="text-center text-slate-500 text-xs mt-6">PHE Production Management System · v2.0</p>
        </div>
      </div>
    </div>
  );
}
