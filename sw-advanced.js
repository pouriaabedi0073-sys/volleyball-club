// Advanced Service Worker with smart caching and dynamic imports
const CACHE_VERSION = 'v1.2.0';
const CACHE_NAME = `volleyball-club-${CACHE_VERSION}`;

// Assets that should be pre-cached for offline use
const CORE_ASSETS = [
  '/volleyball-club/',
  '/volleyball-club/index.html',
  '/volleyball-club/manifest.json',
  '/volleyball-club/manifest.webmanifest',
  '/volleyball-club/pwa-tweak.css',
  '/volleyball-club/pwa-bootstrap.js',
  '/volleyball-club/service-worker.js',
  '/volleyball-club/sw-advanced.js',
  // Core images & icons
  '/volleyball-club/assets/icons/icon-192.png',
  '/volleyball-club/assets/icons/icon-512.png',
  '/volleyball-club/assets/icons/icon-maskable-192.png',
  '/volleyball-club/assets/icons/icon-maskable-512.png',
  // Core fonts
  '/volleyball-club/assets/fonts/Vazirmatn-Regular.woff2',
  '/volleyball-club/assets/fonts/Vazirmatn-Bold.woff2',
  // Core scripts
  '/volleyball-club/libs/supabase.min.js',
  '/volleyball-club/libs/supabase-client.js',
  '/volleyball-club/libs/indexeddb-queue.js',
  '/volleyball-club/backup.js',
  '/volleyball-club/sync-supabase.js'
];

// Dynamic cache configuration
const DYNAMIC_CACHE = {
  images: {
    name: `${CACHE_NAME}-images`,
    maxItems: 50,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  },
  data: {
    name: `${CACHE_NAME}-data`,
    maxItems: 20,
    maxAge: 24 * 60 * 60 * 1000 // 1 day
  }
};

// Install event - cache core assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activation - clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(cacheNames => {
        return Promise.all(
          cacheNames
            .filter(name => name.startsWith('volleyball-club-') && name !== CACHE_NAME)
            .map(name => caches.delete(name))
        );
      })
      .then(() => {
        // Take control of all pages immediately
        self.clients.claim();
      })
  );
});

// Smart fetch handler with dynamic caching
self.addEventListener('fetch', event => {
  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Handle different types of requests
  if (event.request.headers.get('accept')?.includes('text/html')) {
    // HTML - network first, fallback to cache
    event.respondWith(handleHTMLRequest(event.request));
  } else if (url.pathname.match(/\.(jpg|jpeg|png|gif|svg|webp)$/)) {
    // Images - cache first, network fallback
    event.respondWith(handleImageRequest(event.request));
  } else if (url.pathname.endsWith('.json') || url.pathname.includes('/api/')) {
    // API/JSON - network first with timeout fallback
    event.respondWith(handleDataRequest(event.request));
  } else {
    // Other assets - stale-while-revalidate
    event.respondWith(handleAssetRequest(event.request));
  }
});

// HTML handling - network first with quick cache fallback
async function handleHTMLRequest(request) {
  try {
    // Try network first
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
    ]);
    
    // Cache successful response
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
    return response;
  } catch (error) {
    // Fallback to cache
    const cachedResponse = await caches.match(request);
    return cachedResponse || await caches.match('./offline.html');
  }
}

// Image handling - cache first with background update
async function handleImageRequest(request) {
  const cache = await caches.open(DYNAMIC_CACHE.images.name);
  
  // Try cache first
  let response = await cache.match(request);
  if (response) {
    // Update cache in background
    updateCache(request, DYNAMIC_CACHE.images);
    return response;
  }

  // If not in cache, fetch from network
  try {
    response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
      // Cleanup old items
      cleanupCache(DYNAMIC_CACHE.images);
    }
    return response;
  } catch (error) {
    // Return placeholder image if available
    return caches.match('./icons/image-placeholder.png');
  }
}

// Data/API handling - network first with timeout and cache fallback
async function handleDataRequest(request) {
  try {
    // Try network with timeout
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]);
    
    // Cache successful response
    if (response.ok) {
      const cache = await caches.open(DYNAMIC_CACHE.data.name);
      cache.put(request, response.clone());
      cleanupCache(DYNAMIC_CACHE.data);
    }
    return response;
  } catch (error) {
    // Fallback to cache
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      // Add stale flag to response
      const headers = new Headers(cachedResponse.headers);
      headers.append('X-Cache-Status', 'stale');
      return new Response(cachedResponse.body, {
        status: cachedResponse.status,
        statusText: cachedResponse.statusText,
        headers
      });
    }
    throw error;
  }
}

// General asset handling - stale-while-revalidate
async function handleAssetRequest(request) {
  const cache = await caches.open(CACHE_NAME);
  const cachedResponse = await cache.match(request);
  
  const networkUpdate = fetch(request)
    .then(response => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => {/* Ignore network errors */});
  
  return cachedResponse || networkUpdate;
}

// Cache cleanup utility
async function cleanupCache({ name, maxItems, maxAge }) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  
  // Remove old items
  const now = Date.now();
  for (const request of keys) {
    const response = await cache.match(request);
    const dateHeader = response.headers.get('date');
    if (dateHeader) {
      const cacheDate = new Date(dateHeader).getTime();
      if (now - cacheDate > maxAge) {
        await cache.delete(request);
      }
    }
  }
  
  // Remove excess items
  if (keys.length > maxItems) {
    const itemsToRemove = keys.length - maxItems;
    for (let i = 0; i < itemsToRemove; i++) {
      await cache.delete(keys[i]);
    }
  }
}

// Background cache update
async function updateCache(request, cacheConfig) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheConfig.name);
      await cache.put(request, response);
      cleanupCache(cacheConfig);
    }
  } catch (error) {
    // Ignore network errors in background update
  }
}

// Listen for one-off Background Sync events (e.g. flush pending uploads)
self.addEventListener('sync', event => {
  try {
    if (!event || !event.tag) return;
    if (event.tag === 'flush-backups') {
      event.waitUntil((async () => {
        // Ask all controlled clients (pages) to flush pending uploads
        const clients = await self.clients.matchAll({ includeUncontrolled: true });
        for (const client of clients) {
          try { client.postMessage({ type: 'backup:flush', tag: event.tag }); } catch(e){}
        }
      })());
    }
  } catch (e) {
    console.warn('sync handler error', e);
  }
});

// Periodic Background Sync handler (when supported)
self.addEventListener('periodicsync', event => {
  try {
    if (!event || !event.tag) return;
    if (event.tag === 'weekly-backup' || event.tag === 'fetch-new-content') {
      event.waitUntil((async () => {
        // Notify clients to create a backup or update content
        const clients = await self.clients.matchAll({ includeUncontrolled: true });
        for (const client of clients) {
          try { client.postMessage({ type: 'backup:create', tag: event.tag }); } catch(e){}
        }
      })());
    }
  } catch (e) { console.warn('periodicsync handler error', e); }
});

// Push notifications handler (front-end must subscribe and server must send push)
self.addEventListener('push', event => {
  try {
    const data = (event && event.data) ? event.data.json() : { title: 'پیام جدید', body: 'یک اعلان جدید دریافت شد' };
    const title = data.title || 'پیام جدید';
    const opts = Object.assign({
      body: data.body || '',
      icon: data.icon || '/volleyball-club/assets/icons/icon-192.png',
      badge: data.badge || '/volleyball-club/assets/icons/icon-192.png',
      data: data.data || {}
    }, data.options || {});
    event.waitUntil(self.registration.showNotification(title, opts));
  } catch (e) { console.warn('push handler failed', e); }
});

// Notification click handling
self.addEventListener('notificationclick', event => {
  try {
    event.notification.close();
    const url = event.notification.data && event.notification.data.url ? event.notification.data.url : '/volleyball-club/';
    event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    }));
  } catch (e) { console.warn('notificationclick handler failed', e); }
});