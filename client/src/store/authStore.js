import { create } from 'zustand';
import api from '../lib/api';

export const useAuthStore = create((set, get) => ({
  user: null,
  loading: true,

  init: async () => {
    try {
      const res = await api.get('/auth/me');
      set({ user: res.data, loading: false });
    } catch {
      set({ user: null, loading: false });
    }
  },

  login: async (username, password) => {
    const res = await api.post('/auth/login', { username, password });
    set({ user: res.data.user });
    return res.data;
  },

  logout: async () => {
    await api.post('/auth/logout');
    set({ user: null });
  },

  can: (roles) => {
    const { user } = get();
    if (!user) return false;
    if (typeof roles === 'string') return user.role === roles;
    return roles.includes(user.role);
  },

  isAdminOrOwner: () => {
    const { user } = get();
    return user && ['admin', 'owner'].includes(user.role);
  }
}));
