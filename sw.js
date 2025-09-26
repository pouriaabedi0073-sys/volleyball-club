// Minimal service worker stub to avoid caching chrome-extension:// requests
// This SW intentionally does not pre-cache arbitrary assets.
self.addEventListener('install', (event) => {
  // Activate immediately
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = event.request && event.request.url;
  // Ignore non-http(s) schemes (e.g., chrome-extension://)
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return; // let browser handle it
  }
  // Default: perform network fetch, no caching behaviour here
  event.respondWith(fetch(event.request).catch(err => {
    // network fallback: try to return a generic Response
    return new Response('', { status: 504, statusText: 'Network error in SW' });
  }));
});
const CACHE_NAME = 'app-cache-v2';
const PRECACHE_URLS = [
  './',
  './index.html',
  './offline.html',
  './manifest.json',
  './sw-register.js',
  './icons/icon-192.png',
  './icons/icon-256.png',
  './icons/icon-384.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch(err => {
        console.warn('Precache failed:', err);
      });
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => k === CACHE_NAME ? Promise.resolve() : caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

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

  event.respondWith(caches.match(req).then(cached => {
    const networkFetch = fetch(req).then(networkResp => {
      if (!networkResp || networkResp.status !== 200 || networkResp.type === 'opaque') return networkResp;
      const respClone = networkResp.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(req, respClone));
      return networkResp;
    }).catch(() => cached);
    return cached || networkFetch;
  }));
});