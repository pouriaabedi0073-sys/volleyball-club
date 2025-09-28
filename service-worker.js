// Lightweight cache-first service worker that passes PWABuilder checks
const CACHE_NAME = 'app-cache-v2';
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './sw-register.js',
  // common icons (use whichever exist)
  './icons/icon-192.png',
  './icons/icon-256.png',
  './icons/icon-384.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS).catch(err => {
      // Log but don't fail installation entirely on missing assets
      console.warn('SW precache failed:', err);
    }))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Clean up old caches (keep current CACHE_NAME)
    const keys = await caches.keys();
    await Promise.all(keys.map(k => k === CACHE_NAME ? Promise.resolve() : caches.delete(k)));
    await self.clients.claim();
  })());
});

// Network with cache fallback, and offline fallback for navigations
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Navigation requests: SPA fallback to cached index.html
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const networkResponse = await fetch(req);
        return networkResponse;
      } catch (err) {
        const cached = await caches.match('./index.html');
        return cached || Response.error();
      }
    })());
    return;
  }

  // For other requests, try cache first, then network and update cache
  event.respondWith(caches.match(req).then(cached => {
    const networkFetch = fetch(req).then(networkResp => {
      // Only cache successful responses
      if (!networkResp || networkResp.status !== 200 || networkResp.type === 'opaque') return networkResp;
      const respClone = networkResp.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(req, respClone));
      return networkResp;
    }).catch(() => cached);
    return cached || networkFetch;
  }));
});
