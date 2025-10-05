// Clean service worker for Team PWA
const CACHE_NAME = 'team-pwa-v1';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/offline.html',
  '/icons/icon-192.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS)).catch(err => console.warn('precache failed', err))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => k !== CACHE_NAME ? caches.delete(k) : Promise.resolve()));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(res => {
      try {
        const url = new URL(event.request.url);
        if (res && res.type === 'basic' && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
      } catch (e) { /* ignore */ }
      return res;
    }).catch(() => caches.match('/offline.html')))
  );
});

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'بروزرسانی', body: 'محتوا به‌روز شد' };
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: '/icons/icon-192.png' }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});