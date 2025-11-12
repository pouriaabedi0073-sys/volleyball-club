// Minimal bootstrap: SW register + install prompt + connection status hook
(function(){
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      // Register root-scoped service worker for offline support. Use relative paths
      // so this works on different hosting setups (local file, root, or subpath).
      const swPath = './service-worker.js';
      const swScope = './';
      navigator.serviceWorker.getRegistration(swScope).then(reg => {
        if (!reg) {
          navigator.serviceWorker.register(swPath, { scope: swScope })
            .then(r => { console.log('Service Worker registered:', r); })
            .catch(err => { console.error('Service Worker registration failed:', err); });
        } else {
          console.log('Service Worker already registered for scope', swScope, reg);
        }
      }).catch(err => console.warn('SW getRegistration failed', err));
    });
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.deferredPWAInstall = e;
    
    // Create install button if it doesn't exist
    if (!document.getElementById('pwaInstallPrompt')) {
      const installPrompt = document.createElement('div');
      installPrompt.id = 'pwaInstallPrompt';
      installPrompt.className = 'pwa-install-prompt';
      installPrompt.innerHTML = `
        <span class="install-icon"></span>
        <span class="install-text">نصب نسخه کامل برنامه</span>
        <button class="close-button" aria-label="بستن">✕</button>
      `;
      
      // Show the prompt with animation
      setTimeout(() => {
        installPrompt.classList.add('show');
      }, 1000);

      // Handle install click
      installPrompt.addEventListener('click', (event) => {
        if (event.target.classList.contains('close-button')) {
          installPrompt.remove();
          return;
        }
        window.deferredPWAInstall.prompt();
        window.deferredPWAInstall.userChoice.then((choiceResult) => {
          if (choiceResult.outcome === 'accepted') {
            console.log('User accepted the install prompt');
            installPrompt.remove();
          }
        });
      });
      
      document.body.appendChild(installPrompt);
    }
  });
  
  // Hide install button when app is installed
  window.addEventListener('appinstalled', () => {
    // remove either legacy #installPWA or the centralized #pwaInstallPrompt / .pwa-install-prompt
    try {
      const legacy = document.getElementById('installPWA');
      if (legacy && legacy.parentNode) legacy.parentNode.removeChild(legacy);
    } catch(_) {}
    try {
      const centralized = document.getElementById('pwaInstallPrompt') || document.querySelector('.pwa-install-prompt');
      if (centralized && centralized.parentNode) centralized.parentNode.removeChild(centralized);
    } catch(_) {}
  });

  // Listen for messages from the service worker and route to backupClient
  if (navigator.serviceWorker && navigator.serviceWorker.addEventListener) {
    navigator.serviceWorker.addEventListener('message', (ev) => {
      try {
        const data = ev && ev.data ? ev.data : null;
        if (!data || !data.type) return;
        // Backups: flush pending uploads on request
        if (data.type === 'backup:flush') {
          try { if (window.backupClient && typeof window.backupClient.flushPendingUploads === 'function') window.backupClient.flushPendingUploads(); } catch(e){}
        }
        // For periodic triggers we don't auto-run backups. Instead ask the user.
        if (data.type === 'periodicsync:trigger') {
          try {
            // Dispatch a DOM event so page code can show a friendly UI prompt.
            const evnt = new CustomEvent('app:periodicBackupRequested', { detail: { tag: data.tag, timestamp: data.timestamp } });
            window.dispatchEvent(evnt);
          } catch (e) { console.warn('periodicsync trigger dispatch failed', e); }
        }
        if (data.type === 'backup:create') {
          // legacy message: proceed to create backup if available (still allow)
          try { if (window.backupClient && typeof window.backupClient.createBackup === 'function') window.backupClient.createBackup().catch(e => console.warn('createBackup failed', e)); } catch(e){}
        }
        // Notifications from service worker (push forwarded to clients)
        if (data.type === 'notifier:push' && data.payload) {
          try {
            const p = data.payload || {};
            const title = p.title || p.t || 'پیام جدید';
            const body = p.body || p.b || p.message || '';
            // Persist into in-app notifications and attempt browser notification via helper
            try { if (typeof window.showLocalNotification === 'function') window.showLocalNotification(title, body, p.type || 'push'); }
            catch(e) { console.warn('handling notifier:push failed', e); }
          } catch(e) {}
        }
      } catch(e) {}
    });
  }

  // Attempt to register weekly periodic sync automatically (best-effort).
  // We no longer inject a profile toggle; periodic registration is attempted silently.
  (async function ensurePeriodicRegistration() {
    try {
      // Only attempt once per client load. If browser doesn't support periodicSync,
      // store a local preference so the app can fallback to manual backups.
      try {
        if (!('serviceWorker' in navigator)) return;
        const reg = await navigator.serviceWorker.ready;
        if (!reg || !reg.periodicSync || typeof reg.periodicSync.register !== 'function') {
          // Not supported; remember preference for informational UI
          localStorage.setItem('backup:periodicSupported','0');
          return;
        }
        // Try to register 'weekly-backup' with a 7-day minimum interval. Ignore failures.
        const minInterval = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
        try { await reg.periodicSync.register('weekly-backup', { minInterval }); console.log('Attempted to register weekly-backup periodic sync'); localStorage.setItem('backup:periodicSupported','1'); }
        catch (e) { console.warn('periodicSync.register failed (ignored):', e); localStorage.setItem('backup:periodicSupported','0'); }
      } catch (e) { console.warn('ensurePeriodicRegistration failed', e); }
    } catch(e) { /* swallow */ }
  })();

  // Listen for the custom event and show a confirmation to the user when periodic sync triggers
  window.addEventListener('app:periodicBackupRequested', async (e) => {
    try {
      const detail = (e && e.detail) ? e.detail : {};
      const ok = confirm('پشتیبان‌گیری هفتگی برنامه اجرا شده است. آیا مایل به گرفتن بک‌آپ اکنون هستید؟');
      if (!ok) return;
      if (window.backupClient && typeof window.backupClient.createBackup === 'function') {
        try { await window.backupClient.createBackup(); alert('پشتیبان‌گیری در حال انجام است.'); } catch (err) { console.warn('periodic createBackup failed', err); alert('خطا در انجام بک‌آپ'); }
      }
    } catch (err) { console.warn('app:periodicBackupRequested handler failed', err); }
  });

  // Auto-request Notification permission on app load (optional, can be triggered later)
  (async function requestNotificationPermission() {
    try {
      // Only prompt if not previously denied and SW is ready
      if (!('Notification' in window) || !('serviceWorker' in navigator)) return;
      
      const permission = Notification.permission;
      if (permission === 'granted') {
        console.log('✓ Notification permission already granted');
      } else if (permission === 'default') {
        // Request permission (user hasn't been asked yet)
        console.log('Requesting notification permission...');
        const result = await Notification.requestPermission();
        if (result === 'granted') {
          console.log('✓ Notification permission granted');
        } else {
          console.log('✗ Notification permission denied');
        }
      }
    } catch(e) {
      console.warn('requestNotificationPermission failed:', e);
    }
  })();

  // Helper: request Notification permission and optionally subscribe to Push (requires server VAPID key)
  window.requestNotificationAndPush = async function(vapidPublicKey) {
    try {
      // Step 1: Request notification permission (required for both browser notifications and push)
      const notifPerm = await Notification.requestPermission();
      if (notifPerm !== 'granted') {
        console.warn('Notification permission not granted');
        return { ok: false, reason: 'permission_denied' };
      }
      console.log('✓ Notification permission granted');
      
      // Step 2: Ensure service worker is ready
      if (!('serviceWorker' in navigator)) {
        console.warn('Service Worker not available');
        return { ok: false, reason: 'no_sw' };
      }
      
      // Step 3: Subscribe to push notifications (requires VAPID key from server)
      if (!vapidPublicKey || !('PushManager' in window)) {
        console.warn('Push not configured (no VAPID key provided)');
        return { ok: true, note: 'notifications_enabled_but_push_not_configured' };
      }
      
      const reg = await navigator.serviceWorker.ready;
      if (!reg || !reg.pushManager) {
        console.warn('PushManager not available');
        return { ok: false, reason: 'push_not_available' };
      }
      
      // Subscribe using VAPID key
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
      });
      
      console.log('✓ Successfully subscribed to push notifications');
      
      // Return subscription object (should be sent to server to save)
      return { ok: true, subscription: subscription };
    } catch(e) {
      console.error('requestNotificationAndPush failed:', e);
      return { ok: false, error: e.message };
    }
  };

  // small helper to convert VAPID key
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }
})();
