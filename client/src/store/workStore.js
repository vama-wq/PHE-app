import { create } from 'zustand';
import api from '../lib/api';

// What is waiting on the signed-in person, per nav item — one fetch shared
// by the sidebar pills and the strip at the top of each page. Polled every
// 30s and re-read on every navigation, so finishing a piece of work and
// moving on shows the count go down.
let timer = null;
export const useWorkStore = create((set) => ({
  counts: {},
  detail: {},
  fetch: async () => {
    try { const r = await api.get('/work/pending'); set({ counts: r.data.counts || {}, detail: r.data.detail || {} }); }
    catch { /* keep the last good numbers */ }
  },
  start: () => {
    if (timer) return;
    useWorkStore.getState().fetch();
    timer = setInterval(() => useWorkStore.getState().fetch(), 30000);
  },
  stop: () => { if (timer) { clearInterval(timer); timer = null; } },
}));
