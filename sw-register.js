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

/* NOTE: The weekly backup toggle was removed. Periodic background sync registration
 * is handled centrally in pwa-bootstrap.js and periodic triggers now ask the client
 * whether to perform a backup when they occur. This file only keeps service worker
 * registration logic (at top) and doesn't inject UI into the profile.
 */