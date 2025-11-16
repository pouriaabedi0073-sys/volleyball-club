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
        if (data.type === 'backup:flush') {
          try { if (window.backupClient && typeof window.backupClient.flushPendingUploads === 'function') window.backupClient.flushPendingUploads(); } catch(e){}
        }
        if (data.type === 'backup:create') {
          try { if (window.backupClient && typeof window.backupClient.createBackup === 'function') window.backupClient.createBackup().catch(e => console.warn('periodic createBackup failed', e)); } catch(e){}
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

  // Prompt the user (once) to enable weekly automatic backups using Periodic Background Sync if available
  (async function promptWeeklyBackup() {
    try {
      const asked = localStorage.getItem('backup:periodicPromptAsked');
      if (asked) return; // already asked
      // Wait a short time to avoid blocking critical load
      setTimeout(async () => {
        try {
          // Ask user permission for periodic background sync
          const ok = confirm('آیا مایل هستید پشتیبان‌گیری هفتگی خودکار (پس‌زمینه) برای اپ فعال شود؟\n(در هر زمان قابل غیرفعال شدن است)');
          localStorage.setItem('backup:periodicPromptAsked','1');
          if (!ok) return;
          
          // Register periodic sync following PWA standards
          try {
            if (!('serviceWorker' in navigator)) {
              console.warn('Service Worker not supported');
              return;
            }
            const reg = await navigator.serviceWorker.ready;
            if (!reg || !reg.periodicSync) {
              console.warn('Periodic Background Sync not supported in this browser');
              return;
            }
            
            // Register with 7-day minimum interval (standard for backup tasks)
            const minInterval = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
            await reg.periodicSync.register('weekly-backup', { minInterval });
            console.log('✓ Periodic weekly-backup registered successfully');
            alert('✓ پشتیبان‌گیری هفتگی خودکار فعال شد.');
          } catch (e) {
            console.warn('periodicSync registration failed:', e);
            // Fallback: store preference locally for manual fallback
            localStorage.setItem('backup:periodicPreference', 'enabled');
            alert('توجه: مرورگر شما از پشتیبان‌گیری خودکای پس‌زمینه پشتیبانی نمی‌کند. فقط یادداشت شد.');
          }
        } catch(e) { console.warn('weekly backup prompt handler failed', e); }
      }, 1500);
    } catch(e) {}
  })();

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

  // Request notification permission immediately after SW is ready / after install
  async function requestNotificationPermissionOnInstall() {
    try {
      if (!('Notification' in window)) return;
      if (Notification.permission !== 'default') return; // already decided
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        console.log('Notification permission granted on install. Showing welcome notification.');
        try {
          if (typeof window.showLocalNotification === 'function') {
            window.showLocalNotification('اعلان‌ها فعال شدند!', 'از این پس اعلان‌های مهم را دریافت خواهید کرد.', 'general');
          } else if (navigator.serviceWorker && navigator.serviceWorker.ready) {
            const reg = await navigator.serviceWorker.ready;
            try { reg.showNotification && reg.showNotification('اعلان‌ها فعال شدند!', { body: 'از این پس اعلان‌های مهم را دریافت خواهید کرد.' }); } catch(e) {}
          }
        } catch(e) { console.warn('show welcome notification failed', e); }
      }
    } catch (e) { console.warn('requestNotificationPermissionOnInstall failed', e); }
  }

  // Run after SW ready (this will also cover immediate post-install runs)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then(() => {
      try { requestNotificationPermissionOnInstall(); } catch(e) { console.warn('requestNotificationPermissionOnInstall error', e); }
    }).catch(() => {});
  }
})();
