// compat/globals.js
// Lightweight compatibility shims to preserve existing global APIs during migration.
(function(){
  // Canonical storage key
  if (typeof window.STORAGE_KEY === 'undefined') window.STORAGE_KEY = 'vb_dashboard_v8';

  // Ensure window.state exists (read from localStorage if possible)
  if (typeof window.state === 'undefined' || !window.state) {
    try {
      const raw = localStorage.getItem(window.STORAGE_KEY);
      window.state = raw ? JSON.parse(raw) : {};
    } catch (e) { window.state = {}; }
  }

  // saveState: persist window.state to localStorage if not present
  if (typeof window.saveState !== 'function') {
    window.saveState = function() {
      try {
        localStorage.setItem(window.STORAGE_KEY, JSON.stringify(window.state || {}));
        return true;
      } catch (e) { console.warn('compat.saveState failed', e); return false; }
    };
  }

  // loadState: merge stored state into window.state
  if (typeof window.loadState !== 'function') {
    window.loadState = function() {
      try {
        const raw = localStorage.getItem(window.STORAGE_KEY);
        if (!raw) return window.state || {};
        const parsed = JSON.parse(raw);
        window.state = Object.assign({}, window.state || {}, parsed || {});
        return window.state;
      } catch (e) { console.warn('compat.loadState failed', e); return window.state || {}; }
    };
  }

  // Provide a minimal updateNotificationsBadge if not present
  if (typeof window.updateNotificationsBadge !== 'function') {
    window.updateNotificationsBadge = function() {
      try {
        const list = Array.isArray(window.state && window.state.notifications) ? window.state.notifications : [];
        const unread = list.filter(n => !n.read).length;
        Array.from(document.querySelectorAll('.notifications-badge')).forEach(el => {
          if (unread > 0) { el.style.display = 'inline-block'; el.textContent = unread; } else { el.style.display = 'none'; }
        });
      } catch (e) { /* ignore */ }
    };
  }

  // Expose a simple uid helper if not present
  if (typeof window.uid !== 'function') window.uid = function(prefix='id') { return prefix + '_' + Date.now() + '_' + Math.floor(Math.random()*10000); };
})();
