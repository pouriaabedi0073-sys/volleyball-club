// --- Relative paths for portability (works on any deployment) ---
const CACHE_NAME = 'volleyball-v20251131'; // ← increment each update

const PRECACHE_URLS = [
  // Main routes (all relative paths)
  './',
  './index.html',
  './manifest.json',
  './sw-register.js',
  
  // Important JS and CSS files
  './backup.js',
  './backup-storage.js',
  './pwa-test.js',
  
  // Icons and assets
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-192.png',
  './assets/icons/icon-maskable-512.png',
  
  // Optional: add additional CSS/JS files if needed
  // './css/style.css',
  // './js/app.js',
  
  // Custom offline page
  './offline.html',
];

self.addEventListener('install', e => {
  // Ensure critical assets are cached before activating. If non-critical assets fail,
  // still try to keep index and offline page available so navigation works while offline.
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      await cache.addAll(PRECACHE_URLS);
      await self.skipWaiting();
    } catch (err) {
      console.warn('Precache addAll failed:', err);
      // Try to at least cache critical navigation assets so offline fallback works
      try {
        await cache.add('./index.html');
        await cache.add('./offline.html');
        await self.skipWaiting();
      } catch (err2) {
        console.error('Critical precache failed:', err2);
        // Let the install fail so a broken/partial worker doesn't take control
        throw err2;
      }
    }
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => 
      Promise.all(keys.map(k => k === CACHE_NAME ? null : caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Listen for background sync event and notify clients to flush pending uploads
self.addEventListener('sync', event => {
  if (!event.tag) return;
  // Handle both backup sync tags
  if (event.tag === 'vb-upload-sync' || event.tag === 'backup-sync') {
    event.waitUntil((async () => {
      try {
        const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
        for (const c of clients) {
          try { c.postMessage({ type: 'sync:backup', tag: event.tag }); } catch(e) {}
        }
      } catch (e) { console.warn('sync event handler failed', e); }
    })());
  }
});

// Periodic Background Sync handler (standard-compliant for periodic backups and content refresh)
// Fired at regular intervals when browser determines appropriate (typically weekly or longer)
self.addEventListener('periodicsync', event => {
  if (!event || !event.tag) return;
  
  // Handle periodic backup tags
  if (event.tag === 'weekly-backup' || event.tag === 'vb-periodic-backup' || event.tag === 'periodic-sync') {
    event.waitUntil((async () => {
      try {
        // Notify all open clients to trigger backup/sync operations
        const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
        for (const client of clients) {
          try {
            client.postMessage({
              type: 'periodicsync:trigger',
              tag: event.tag,
              timestamp: Date.now()
            });
          } catch(e) {}
        }
      } catch (e) {
        console.warn('periodicsync handler failed:', e);
      }
    })());
  }
});

// Push notification handler (standards-compliant)
// Fired when server sends a push message to subscribed client
// --- همه نوتیفیکشن‌ها (کد کامل push و notificationclick درج شده) ---
// Push notification handler (کامل)
self.addEventListener('push', event => {
  try {
    let data = {};
    if (event && event.data) {
      try {
        data = event.data.json();
      } catch (e) {
        data = { title: 'پیام جدید', body: event.data.text() };
      }
    }

    const title = data.title || 'پیام جدید';
    const options = {
      body: data.body || 'یک اعلان جدید دریافت شد',
      icon: data.icon || './assets/icons/icon-192.png',
      badge: data.badge || './assets/icons/icon-192.png',
      tag: data.tag || 'notification',
      requireInteraction: data.requireInteraction || false,
      data: data.data || {}
    };

    event.waitUntil(
      self.registration.showNotification(title, options).then(() => {
        const clients = self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
        return clients.then(clientsList => {
          for (const client of clientsList) {
            client.postMessage({
              type: 'push:notification',
              title: title,
              body: options.body,
              data: data
            });
          }
        });
      }).catch(e => console.warn('showNotification failed:', e))
    );
  } catch (e) {
    console.warn('push handler failed:', e);
  }
});

// Notification click handler (کامل)
self.addEventListener('notificationclick', event => {
    try {
      event.notification.close();
      const url = (event.notification.data && event.notification.data.url) || '/';
      event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
          for (const client of windowClients) {
            if (client.url === url && 'focus' in client) {
              return client.focus();
            }
          }
          if (self.clients.openWindow) {
            return self.clients.openWindow(url);
          }
        })
      );
    } catch (e) {
      console.warn('notificationclick handler failed:', e);
    }
});


self.addEventListener('message', e => {
  if (e.data?.action === 'skipWaiting') self.skipWaiting();
});

// Network with cache fallback, and offline fallback for navigations
// --- fetch: Cache-First + safe cloning to avoid "Response body is already used" ---
self.addEventListener('fetch', e => {
  const req = e.request;

  // Only handle GET requests
  if (req.method !== 'GET') return;

  // Navigation requests -> prefer network (so static HTML pages like confirm-signup.html
  // or reset-success.html are served by the server). If network fails, fall back to
  // an exact cached response (if present), otherwise fall back to cached index or
  // offline page for SPA navigation/offline experience.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      // Try network first so existing static files on the server are returned.
      try {
        const net = await fetch(req);
        // If server returned 200-299, use it (this will include static pages).
        if (net && net.ok) return net;
      } catch (err) {
        // network fetch failed or offline — we'll try cache fallbacks below
      }

      // Try exact match in cache (maybe confirm-signup.html/offline.html were precached)
      const cachedExact = await caches.match(req);
      if (cachedExact) return cachedExact;

      // Fallback to cached index.html (SPA shell) so client-side routing still works
      const cachedIndex = await caches.match('./index.html');
      if (cachedIndex) return cachedIndex;

      // As a last resort return offline.html if present
      const fallback = await caches.match('./offline.html');
      return fallback || new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
    })());
    return;
  }

  // Other requests -> Cache-First with background update; clone before caching
  e.respondWith(
    caches.match(req).then(cached => {
      if (cached) {
        // Update cache in background
        fetch(req).then(fresh => {
          if (fresh && fresh.ok) {
            const clone = fresh.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, clone)).catch(() => {});
          }
        }).catch(() => {});
        return cached;
      }

      // If not cached, fetch from network and cache a clone. On failure return cached if present,
      // otherwise a generic 503 response so callers get a proper Response object.
      return fetch(req).then(resp => {
        if (!resp || !resp.ok) return resp;
        const respClone = resp.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, respClone)).catch(() => {});
        return resp;
      }).catch(() => cached || new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' }));
    })
  );
});
