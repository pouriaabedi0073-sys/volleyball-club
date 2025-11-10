// Fast Service Worker registration for PWABuilder
(function() {
  if (!('serviceWorker' in navigator)) return;
  // Register as early as possible
  window.addEventListener('load', function() {
    try {
      if (!location || (location.protocol !== 'http:' && location.protocol !== 'https:')) {
        console.debug('Service worker registration skipped: unsupported protocol', location.protocol);
        return;
      }
      const swPath = 'sw.js';
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
