// Fast Service Worker registration for PWABuilder
(function() {
  if (!('serviceWorker' in navigator)) return;
  // Register as early as possible
  window.addEventListener('load', function() {
    (async function(){
      try {
        if (!location || (location.protocol !== 'http:' && location.protocol !== 'https:')) {
          console.debug('Service worker registration skipped: unsupported protocol', location.protocol);
          return;
        }
        // Determine manifest scope if present so we can register the SW at the
        // correct scope. Fallback to root '/'. This helps when app is hosted
        // under a subpath (e.g. /volleyball-club/).
        async function detectManifestScope() {
          try {
            const link = document.querySelector('link[rel="manifest"]');
            if (!link || !link.href) return '/';
            const url = new URL(link.href, location.href).href;
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) return '/';
            const mf = await res.json();
            if (mf && mf.scope) return mf.scope;
            return '/';
          } catch (e) { return '/'; }
        }

        const manifestScope = await detectManifestScope();
        // Build SW path relative to the manifest scope
        const swUrl = new URL('service-worker.js', location.origin + manifestScope).href;
        const regScope = manifestScope || '/';
        navigator.serviceWorker.register(swUrl, { scope: regScope })
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
    })();
  });
})();

/* Backup UI toggle injection
 * This script dynamically inserts a toggle UI into the profile section (if user is logged in)
 * so users can opt-in/out of weekly periodic backups. It attempts to detect Periodic Background 
 * Sync support and will register/unregister the 'weekly-backup' tag on user action.
 */
(function(){
  if (typeof document === 'undefined') return;
  function createToggle() {
    try {
      // UI removed per user request: remove any existing toggle element and skip creating UI
      try { const existing = document.getElementById('vb-backup-toggle'); if (existing) existing.remove(); } catch(_){}
      return; // Skip creating the backup toggle UI; keep logic intact
      if (document.getElementById('vb-backup-toggle')) return;
      
      // Try to insert into profile container if user is logged in
      const profileContainer = document.getElementById('accountProfileContainer');
      
      // If no profile container (user not logged in), don't create toggle yet
      // It will be created when profile loads
      if (!profileContainer) {
        console.debug('Profile container not found yet, deferring toggle creation');
        return;
      }
      
      const container = document.createElement('div');
      container.id = 'vb-backup-toggle';
      container.style.width = '100%';
      container.style.background = 'rgba(59, 130, 246, 0.06)';
      container.style.border = '1px solid rgba(59, 130, 246, 0.16)';
      container.style.padding = '12px 14px';
      container.style.borderRadius = '10px';
      container.style.fontFamily = 'Vazirmatn, Arial, sans-serif';
      container.style.fontSize = '14px';
      container.style.direction = 'rtl';
      container.style.marginBottom = '12px';
      container.style.boxSizing = 'border-box';

      const label = document.createElement('label');
      label.style.display = 'inline-flex';
      label.style.alignItems = 'center';
      label.style.gap = '10px';
      label.style.cursor = 'pointer';
      label.style.width = '100%';

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = 'vb-backup-checkbox';
      input.style.cursor = 'pointer';
      input.style.width = '18px';
      input.style.height = '18px';

      const txt = document.createElement('span');
      txt.textContent = 'پشتیبان‌گیری هفتگی خودکار';
      txt.style.fontWeight = '500';
      txt.style.color = 'var(--text)';
      txt.style.flex = '1';

      const status = document.createElement('span');
      status.id = 'vb-backup-status';
      status.style.fontSize = '12px';
      status.style.color = 'var(--muted)';
      status.style.marginInlineStart = '8px';

      label.appendChild(input);
      label.appendChild(txt);
      label.appendChild(status);
      container.appendChild(label);
      
      // Insert after profile status box (look for profile-status-box or at the top)
      const statusBox = profileContainer.querySelector('.profile-status-box');
      if (statusBox && statusBox.parentNode) {
        statusBox.parentNode.insertBefore(container, statusBox.nextSibling);
      } else {
        // Fallback: prepend to profile container
        profileContainer.insertBefore(container, profileContainer.firstChild);
      }

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
      const chk = document.getElementById('vb-backup-checkbox');
      
      if (enabled) {
        // Check if browser supports Periodic Background Sync
        if (!reg || !reg.periodicSync || typeof reg.periodicSync.register !== 'function') {
          // Fallback: just save preference locally and show message
          console.warn('Periodic Background Sync not supported in this browser');
          localStorage.setItem('backup:periodicEnabled','1');
          if (stat) stat.textContent = 'فعال (دستی)';
          showToastMessage('پشتیبان‌گیری هفتگی خودکار در این مرورگر پشتیبانی نمی‌شود. فقط یادداشت شد.');
          return true;
        }
        
        try {
          const minInterval = 7 * 24 * 60 * 60 * 1000;
          await reg.periodicSync.register('weekly-backup', { minInterval });
          localStorage.setItem('backup:periodicEnabled','1');
          if (stat) stat.textContent = 'فعال';
          if (chk) chk.checked = true;
          showToastMessage('پشتیبان‌گیری هفتگی فعال شد.');
          // notify SW/analytics
          try { if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'periodic:changed', enabled: true }); } catch(e){}
          return true;
        } catch (e) {
          console.warn('periodic register failed:', e);
          // Fallback: save preference locally
          localStorage.setItem('backup:periodicEnabled','1');
          if (stat) stat.textContent = 'فعال (دستی)';
          if (chk) chk.checked = true;
          showToastMessage('خودکار نشد؛ امّا ترجیح شما ذخیره شد. امتحان مجدد کنید.');
          return true;
        }
      } else {
        // disable: try to unregister tag if supported
        try {
          if (reg && reg.periodicSync && typeof reg.periodicSync.unregister === 'function') {
            await reg.periodicSync.unregister('weekly-backup');
          }
        } catch (e) { console.warn('periodic unregister failed', e); }
        localStorage.removeItem('backup:periodicEnabled');
        if (stat) stat.textContent = 'غیرفعال';
        if (chk) chk.checked = false;
        showToastMessage('پشتیبان‌گیری هفتگی غیرفعال شد.');
        try { if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'periodic:changed', enabled: false }); } catch(e){}
        return true;
      }
      return false;
    } catch (e) { 
      console.warn('setPeriodicEnabled failed', e); 
      showToastMessage('خطا در تغییر تنظیمات پشتیبان‌گیری.');
      return false; 
    }
  }

  // Helper to show a toast message (if showToast function exists in page)
  function showToastMessage(msg) {
    try {
      if (typeof window.showToast === 'function') {
        window.showToast(msg);
      } else {
        console.log('[Backup Toggle]', msg);
      }
    } catch (e) { }
  }

  // Create toggle when profile container appears or on DOM ready
  // Try multiple times to catch when profile is shown after login
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createToggle);
  } else {
    createToggle();
  }
  
  // Also try to create/recreate toggle if profile container is shown via display/visibility changes
  // (useful when user logs in and profile section appears)
  const observer = new MutationObserver(() => {
    const profileContainer = document.getElementById('accountProfileContainer');
    if (profileContainer && !document.getElementById('vb-backup-toggle')) {
      createToggle();
    }
  });
  
  try {
    const profileContainer = document.getElementById('accountProfileContainer');
    if (profileContainer) {
      observer.observe(profileContainer.parentNode, { attributes: true, subtree: false, attributeFilter: ['style', 'class'] });
    }
  } catch (e) { /* ignore observer setup errors */ }
})();