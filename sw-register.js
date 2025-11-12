// Fast Service Worker registration for PWABuilder
(function() {
  if (!('serviceWorker' in navigator)) return;
  // Register as early as possible
  window.addEventListener('load', function() {
    try {
      if (!location || (location.protocol !== 'http:' && location.protocol !== 'https:'')) {
        console.debug('Service worker registration skipped: unsupported protocol', location.protocol);
        return;
      }
      const swPath = 'sw-advanced.js'; // Using the advanced service worker
      navigator.serviceWorker.register(swPath, { scope: './' })
        .then(function(reg) {
          console.log('ServiceWorker registered with scope:', reg.scope);
          // Check for updates immediately
          if (reg && reg.update) {
            try { reg.update(); } catch(e) { console.warn('SW update check failed', e); }
          }

          // Listen for updatefound -> new service worker installing
          reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            console.log('SW update found:', newWorker);
            newWorker.addEventListener('statechange', () => {
              console.log('SW state:', newWorker.state);
              if (newWorker.state === 'installed') {
                if (navigator.serviceWorker.controller) {
                  // New update available
                  console.log('New content available — please refresh.');
                  // Optionally notify UI to prompt the user to refresh
                } else {
                  console.log('Content is cached for offline use.');
                }
              }
            });
          });
        })
        .catch(function(err) {
          console.error('SW registration failed:', err);
        });
    } catch (e) {
      console.error('SW registration error:', e);
    }
  });
})();

/* Backup UI toggle injection
 * This script dynamically inserts a small toggle UI into the page so users can opt-in/out
 * of weekly periodic backups. It attempts to detect Periodic Background Sync support and
 * will register/unregister the 'weekly-backup' tag on user action.
 */
(function(){
  if (typeof document === 'undefined') return;
  function createToggle() {
    try {
      if (document.getElementById('vb-backup-toggle')) return;
      const container = document.createElement('div');
      container.id = 'vb-backup-toggle';
      container.style.position = 'fixed';
      container.style.top = '12px';
      container.style.right = '12px';
      container.style.zIndex = 99999;
      container.style.background = 'rgba(255,255,255,0.95)';
      container.style.border = '1px solid rgba(0,0,0,0.06)';
      container.style.padding = '8px 10px';
      container.style.borderRadius = '10px';
      container.style.boxShadow = '0 6px 18px rgba(12,18,28,0.08)';
      container.style.fontFamily = 'Vazirmatn, Arial, sans-serif';
      container.style.fontSize = '13px';
      container.style.direction = 'rtl';

      const label = document.createElement('label');
      label.style.display = 'inline-flex';
      label.style.alignItems = 'center';
      label.style.gap = '8px';

      const txt = document.createElement('span');
      txt.textContent = 'پشتیبان‌گیری هفتگی';

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = 'vb-backup-checkbox';

      const status = document.createElement('span');
      status.id = 'vb-backup-status';
      status.style.marginLeft = '8px';
      status.style.fontSize = '12px';
      status.style.color = '#334155';

      label.appendChild(input);
      label.appendChild(txt);
      container.appendChild(label);
      container.appendChild(status);
      document.body.appendChild(container);

      input.addEventListener('change', async (e) => {
        try {
          const enabled = !!e.target.checked;
          await setPeriodicEnabled(enabled);
        } catch (err) { console.warn('backup toggle change failed', err); }
      });

      // initialize state
      (async function init() {
        const chk = document.getElementById('vb-backup-checkbox');
        const stat = document.getElementById('vb-backup-status');
        try {
          const enabled = await isPeriodicRegistered();
          chk.checked = !!enabled;
          stat.textContent = enabled ? 'فعال' : 'غیرفعال';
        } catch (e) { chk.checked = !!localStorage.getItem('backup:periodicEnabled'); stat.textContent = chk.checked ? 'فعال' : 'غیرفعال'; }
      })();
    } catch (e) { console.warn('createToggle failed', e); }
  }

  async function isPeriodicRegistered() {
    try {
      if (!('serviceWorker' in navigator)) return false;
      const reg = await navigator.serviceWorker.ready;
      if (!reg || !reg.periodicSync || typeof reg.periodicSync.getTags !== 'function') return false;
      const tags = await reg.periodicSync.getTags();
      return Array.isArray(tags) && tags.indexOf('weekly-backup') !== -1;
    } catch (e) { return false; }
  }

  async function setPeriodicEnabled(enabled) {
    try {
      if (!('serviceWorker' in navigator)) {
        alert('مرورگر شما از service worker پشتیبانی نمی‌کند.');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const stat = document.getElementById('vb-backup-status');
      if (enabled) {
        if (reg && reg.periodicSync && typeof reg.periodicSync.register === 'function') {
          try {
            const minInterval = 7 * 24 * 60 * 60 * 1000;
            await reg.periodicSync.register('weekly-backup', { minInterval });
            localStorage.setItem('backup:periodicEnabled','1');
            if (stat) stat.textContent = 'فعال';
            // notify SW/analytics
            try { if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'periodic:changed', enabled: true }); } catch(e){}
            return true;
          } catch (e) { alert('ثبت پشتیبان‌گیری هفتگی ممکن نشد؛ مرورگر ممکن است پشتیبانی نکند.'); console.warn('periodic register failed', e); }
        } else {
          alert('Periodic Background Sync توسط مرورگر شما پشتیبانی نمی‌شود.');
        }
      } else {
        // disable: try to unregister tag if supported
        try {
          if (reg && reg.periodicSync && typeof reg.periodicSync.unregister === 'function') {
            await reg.periodicSync.unregister('weekly-backup');
          } else if (reg && reg.periodicSync && typeof reg.periodicSync.getTags === 'function') {
            // no unregister API: can't reliably remove — rely on local flag and inform user
            // Some browsers may allow register with 0 interval; skip here
          }
        } catch (e) { console.warn('periodic unregister failed', e); }
        localStorage.removeItem('backup:periodicEnabled');
        if (stat) stat.textContent = 'غیرفعال';
        try { if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'periodic:changed', enabled: false }); } catch(e){}
        return true;
      }
      return false;
    } catch (e) { console.warn('setPeriodicEnabled failed', e); return false; }
  }

  // Create toggle on DOM ready
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', createToggle); else createToggle();
})();