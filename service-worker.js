// Lightweight cache-first service worker that passes PWABuilder checks
const CACHE_NAME = 'app-cache-v3';
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
self.addEventListener('push', event => {
  try {
    // Parse push event data
    let data = {};
    if (event && event.data) {
      try {
        data = event.data.json();
      } catch (e) {
        // Fallback: treat as plain text
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
    
    // Show the system notification using waitUntil()
    event.waitUntil((async () => {
      try {
        // Display browser notification
        await self.registration.showNotification(title, options);
      } catch (e) {
        console.warn('showNotification failed:', e);
      }
      
      // Also notify any open clients to persist in in-app notifications
      try {
        const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
        for (const client of clients) {
          try {
            client.postMessage({
              type: 'push:notification',
              title: title,
              body: options.body,
              data: data
            });
          } catch(e) {}
        }
      } catch (e) {
        console.warn('client messaging failed:', e);
      }
    })());
  } catch (e) {
    console.warn('push event handler failed:', e);
  }
});

// Notification click handler
self.addEventListener('notificationclick', event => {
  try {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || './';
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
        // Check if app is already open in a window
        for (const client of windowClients) {
          if (client.url === url && 'focus' in client) {
            return client.focus();
          }
        }
        // If not open, open a new window
        if (self.clients.openWindow) {
          return self.clients.openWindow(url);
        }
      })
    );
  } catch (e) {
    console.warn('notificationclick handler failed:', e);
  }
});

// Message handler for client-side requests (e.g., manual sync trigger from app)
self.addEventListener('message', (event) => {
  try {
    const data = event.data || {};
    // Handle requestSync messages from clients to manually trigger background sync
    if (data && data.type === 'requestSync' && data.tag) {
      if (self.registration && self.registration.sync && typeof self.registration.sync.register === 'function') {
        try {
          self.registration.sync.register(data.tag);
        } catch (e) {
          console.warn('sync register failed:', e);
        }
      }
    }
    // Handle requestPeriodicSync for manual periodic sync trigger
    if (data && data.type === 'requestPeriodicSync' && data.tag) {
      if (self.registration && self.registration.periodicSync && typeof self.registration.periodicSync.register === 'function') {
        try {
          const minInterval = data.minInterval || (7 * 24 * 60 * 60 * 1000); // default 7 days
          self.registration.periodicSync.register(data.tag, { minInterval });
        } catch (e) {
          console.warn('periodicSync register failed:', e);
        }
      }
    }
  } catch (e) {
    console.warn('sw message handler failed:', e);
  }
});

// Network with cache fallback, and offline fallback for navigations
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Navigation requests: SPA fallback to cached index.html
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      // Prefer the cached shell so the app loads instantly offline.
      const cached = await caches.match('./index.html');
      if (cached) return cached;
      try {
        const networkResponse = await fetch(req);
        return networkResponse;
      } catch (err) {
        // Last-resort offline response
        return new Response('<!doctype html><meta charset="utf-8"><title>Offline</title><h1>آفلاین</h1><p>در حال حاضر به اینترنت متصل نیستید.</p>', { headers: { 'Content-Type': 'text/html' } });
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
