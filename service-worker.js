// --- نسخه جدید: 2025-11-16 ---
const CACHE_NAME = 'volleyball-club-v20251117'; // ← هر بار افزایش بده

const PRECACHE_URLS = [
  '/volleyball-club/',
  '/volleyball-club/index.html',
  '/volleyball-club/manifest.json',
  '/volleyball-club/sw-register.js',
  '/volleyball-club/assets/icons/icon-192.png',
  '/volleyball-club/assets/icons/icon-512.png'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS).catch(console.warn))
  );
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
      icon: data.icon || '/volleyball-club/assets/icons/icon-192.png',
      badge: data.badge || '/volleyball-club/assets/icons/icon-192.png',
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
    const url = (event.notification.data && event.notification.data.url) || '/volleyball-club/';
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

// keep other handlers for sync/periodicsync intact
self.addEventListener('sync', event => {
  if (!event.tag) return;
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

self.addEventListener('periodicsync', event => {
  if (!event || !event.tag) return;
  if (event.tag === 'weekly-backup' || event.tag === 'vb-periodic-backup' || event.tag === 'periodic-sync') {
    event.waitUntil((async () => {
      try {
        const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
        for (const client of clients) {
          try {
            client.postMessage({ type: 'periodicsync:trigger', tag: event.tag, timestamp: Date.now() });
          } catch(e) {}
        }
      } catch (e) { console.warn('periodicsync handler failed:', e); }
    })());
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

  // Navigation requests -> serve cached index.html (or network)
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('/volleyball-club/index.html').then(cached => cached || fetch(req))
    );
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

      // If not cached, fetch from network and cache a clone
      return fetch(req).then(resp => {
        if (!resp || !resp.ok) return resp;
        const respClone = resp.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, respClone)).catch(() => {});
        return resp;
      }).catch(() => cached);
    })
  );
});
