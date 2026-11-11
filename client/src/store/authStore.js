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

  // A login from a new device comes back { pending, request } with no user:
  // the login page waits for the owner's answer and then calls setUser.
  login: async (username, password) => {
    const res = await api.post('/auth/login', { username, password });
    if (res.data?.user) set({ user: res.data.user });
    return res.data;
  },

  setUser: (user) => set({ user }),

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
