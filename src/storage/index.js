// src/storage/index.js
export const STORAGE_KEY = (window.STORAGE_KEY || 'vb_dashboard_v8');

export function saveState(state) {
  try {
    if (typeof window.saveState === 'function') return window.saveState();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state || window.state || {}));
    return true;
  } catch (e) { console.warn('storage.saveState failed', e); return false; }
}

export function loadState() {
  try {
    if (typeof window.loadState === 'function') return window.loadState();
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    window.state = Object.assign({}, window.state || {}, parsed || {});
    return window.state;
  } catch (e) { console.warn('storage.loadState failed', e); return window.state || {}; }
}

export default { STORAGE_KEY, saveState, loadState };
