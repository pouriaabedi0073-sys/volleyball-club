// Minimal bootstrap: SW register + install prompt + connection status hook
(function(){
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      // Register service worker with explicit absolute path and correct scope for GitHub Pages
      const swPath = '/volleyball-club/service-worker.js';
      const swScope = '/volleyball-club/';
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
          // Simple non-intrusive prompt. You can replace with a nicer UI.
          const ok = confirm('آیا مایل هستید پشتیبان‌گیری هفتگی خودکار (پس‌زمینه) برای اپ فعال شود؟\n(در هر زمان قابل غیرفعال شدن است)');
          localStorage.setItem('backup:periodicPromptAsked','1');
          if (!ok) return;
          // Register periodic sync
          if ('serviceWorker' in navigator && 'periodicSync' in Registration.prototype) {
            try {
              const reg = await navigator.serviceWorker.ready;
              // 7 days in ms
              const minInterval = 7 * 24 * 60 * 60 * 1000;
              await reg.periodicSync.register('weekly-backup', { minInterval });
              console.log('Periodic weekly-backup registered');
              alert('پشتیبان‌گیری هفتگی فعال شد.');
            } catch (e) {
              console.warn('periodicSync register failed', e);
              alert('ثبت پشتیبان‌گیری هفتگی موفقیت‌آمیز نبود؛ مرورگر ممکن است از آن پشتیبانی نکند.');
            }
          } else {
            // Try to ask for permission via Permissions API if available
            try {
              const p = await navigator.permissions.query({ name: 'periodic-background-sync' });
              if (p && p.state === 'granted') {
                const reg = await navigator.serviceWorker.ready;
                const minInterval = 7 * 24 * 60 * 60 * 1000;
                await reg.periodicSync.register('weekly-backup', { minInterval });
                alert('پشتیبان‌گیری هفتگی فعال شد.');
              } else {
                alert('مرورگر شما از Periodic Background Sync پشتیبانی نمی‌کند یا دسترسی لازم را ندارد.');
              }
            } catch(e) { console.warn('periodic permission check failed', e); alert('پشتیبان‌گیری هفتگی ثبت نشد.'); }
          }
        } catch(e) { console.warn('weekly backup prompt handler failed', e); }
      }, 1500);
    } catch(e) {}
  })();

  // Helper: request Notification permission and optionally subscribe to Push (requires server VAPID key)
  window.requestNotificationAndPush = async function(vapidPublicKey) {
    try {
      const p = await Notification.requestPermission();
      if (p !== 'granted') return { ok:false, reason: 'permission_denied' };
      if (!('serviceWorker' in navigator)) return { ok:false, reason:'no_sw' };
      if (!vapidPublicKey || !('PushManager' in window)) return { ok:true, note:'notifications_granted_but_push_not_configured' };
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) });
      // Send subscription to server to save it (implement server endpoint)
      return { ok:true, subscription: sub };
    } catch(e) { console.warn('requestNotificationAndPush failed', e); return { ok:false, error: e }; }
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
