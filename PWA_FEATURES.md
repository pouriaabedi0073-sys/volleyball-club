# PWA Features Implementation - Standards-Compliant

## Overview
This document describes the three key PWA (Progressive Web App) features implemented in this volleyball club management app according to web standards and best practices.

---

## 1. Offline Support ✓

### Implementation
- **Service Worker**: `./service-worker.js` (lightweight, cache-first strategy)
- **Cache Strategy**: Hybrid approach:
  - **Cache-first**: Static assets (HTML, CSS, JS, images) served from cache
  - **Network-first**: API calls attempt network first, fall back to cache
  - **Navigation fallback**: SPA shell cached for instant offline load

### How It Works
1. **Installation Phase**: App shell (index.html, manifest, icons) precached on first visit
2. **Runtime**: Fetch requests intercepted:
   - Static files served from cache immediately
   - API calls try network, cache if offline
   - Navigation requests serve cached index.html for offline SPA functionality

### Verification
- ✓ Service Worker registered at `./` scope
- ✓ Manifest configured with relative paths
- ✓ Icons and assets precached
- ✓ Offline fallback HTML provided
- ✓ Cache updated on network responses

### Testing Offline
1. Open DevTools → Application → Service Workers → Check status
2. Toggle "Offline" checkbox in DevTools
3. App should remain functional with cached data
4. New requests return offline fallback

---

## 2. Periodic Background Sync ✓

### Implementation
- **Tags Used**: `weekly-backup`, `vb-periodic-backup`, `periodic-sync`
- **Service Worker Handler**: `periodicsync` event listener
- **Minimum Interval**: 7 days (configurable)
- **Fallback**: localStorage preference for unsupported browsers

### How It Works
1. **Registration**: App requests `weekly-backup` periodic sync with 7-day minimum interval
2. **Browser Scheduling**: Browser determines optimal time (usually weekly, respecting device battery/network)
3. **Trigger**: Service worker receives `periodicsync` event
4. **Action**: SW sends message to open clients to trigger backup/sync
5. **Completion**: Client responds when sync completes

### Code Flow
```
App (index.html)
  ↓ [User consents to periodic backup]
  ↓ register('weekly-backup', { minInterval: 7 days })
  ↓
Service Worker (service-worker.js)
  ↓ [Receives periodicsync event]
  ↓ event.waitUntil()
  ↓ postMessage() to all clients
  ↓
App (index.html)
  ↓ [Receives message: 'periodicsync:trigger']
  ↓ window.backupClient.createBackup()
  ↓ Uploads backup to Supabase/storage
  ↓ postMessage back to SW when complete
```

### Verification
- ✓ `navigator.serviceWorker.ready` → `reg.periodicSync.register()`
- ✓ Service worker listens for `periodicsync` event
- ✓ Uses `event.waitUntil()` to ensure completion
- ✓ Sends message to clients with tag and timestamp
- ✓ Graceful fallback if browser doesn't support

### Testing Periodic Sync
1. **Chrome/Edge**: 
   - Open DevTools → Application → Service Workers
   - Look for "weekly-backup" tag in periodic sync list
   - Chrome simulates sync by triggering after ~10 seconds when connected

2. **Check Handler**:
   - Open DevTools → Application → Service Workers
   - Check that `periodicsync` event listener is registered
   - Monitor Network tab for backup uploads

3. **Fallback Detection**:
   - Check `localStorage.getItem('backup:periodicPreference')` to see fallback status

---

## 3. Push Notifications ✓

### Implementation
- **Subscription Method**: `PushManager.subscribe()`
- **Service Worker Handler**: `push` event listener + `notificationclick` handler
- **Permissions**: Notification API + Push API
- **VAPID Key**: Required for server-side push (currently not configured)

### How It Works
1. **Permission Request**: App requests Notification permission
2. **Subscription**: App subscribes via PushManager with VAPID key
3. **Server Setup**: Server saves subscription endpoint (not implemented)
4. **Push Trigger**: Server sends push message to subscription endpoint
5. **Service Worker**: Receives `push` event, shows notification via `showNotification()`
6. **User Interaction**: Notification click handled by `notificationclick` handler

### Code Flow
```
App (pwa-bootstrap.js)
  ↓ [User grants notification permission]
  ↓ Notification.requestPermission()
  ↓ [Auto-subscribe if VAPID key provided]
  ↓ reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: VAPID })
  ↓ [Send subscription to server]
  ↓
Server (implements push API)
  ↓ [When you want to notify user]
  ↓ POST /push with subscription + message
  ↓
Service Worker (service-worker.js)
  ↓ [Receives push event from browser]
  ↓ event.waitUntil()
  ↓ self.registration.showNotification()
  ↓ postMessage() to clients for in-app persistence
  ↓
App (index.html)
  ↓ [Receives push:notification message]
  ↓ Persists to window.state.notifications
  ↓ Updates badge count
  ↓ Shows toast/in-app notification
```

### Permission States
- **granted**: User agreed, notifications enabled
- **denied**: User declined, cannot be asked again
- **default**: Not yet asked, can be prompted once

### Verification
- ✓ `Notification.permission` shows 'granted' or 'default'
- ✓ Service worker listens for `push` event
- ✓ Uses `event.waitUntil()` for async showNotification()
- ✓ `notificationclick` handler implemented for user interaction
- ✓ Fallback if browser doesn't support notifications

### Testing Push Notifications
1. **Permission Granted**:
   - Open DevTools → Application → Manifest
   - Check "Notification permission" status
   - If denied, reset in Privacy settings

2. **Subscription Check**:
   - In DevTools Console:
     ```javascript
     const reg = await navigator.serviceWorker.ready;
     const sub = await reg.pushManager.getSubscription();
     console.log(sub);
     ```

3. **Send Test Push** (requires server with VAPID key):
   - Implement server endpoint to send push
   - Use Web Push Library (e.g., web-push for Node.js)
   - Send to subscription endpoint

4. **Monitor**:
   - Check DevTools → Application → Service Workers → Push messages
   - Monitor Network for push service requests

---

## Storage Architecture (All Three Spaces)

The app uses three storage mechanisms following PWA standards:

### 1. Cache API (Service Worker)
- **Purpose**: Store HTTP responses for offline access
- **Location**: Service Worker cache storage
- **Implementation**: `caches.open(CACHE_NAME)` → `cache.addAll()` → `cache.put()`
- **Files**: `./service-worker.js` (lines 40-90)

### 2. IndexedDB (Local Storage)
- **Purpose**: Offline queue for pending backups/uploads
- **Location**: Browser IndexedDB database
- **Implementation**: `indexeddb-queue.js` provides queue API
- **Usage**: Store pending uploads when offline, flush when online
- **Files**: `sync-hybrid.js`, `backup.js`

### 3. LocalStorage (Key-Value)
- **Purpose**: Preferences and metadata
- **Location**: Browser localStorage
- **Implementation**: `localStorage.setItem()` / `getItem()`
- **Examples**:
  - `backup:periodicEnabled` - periodic sync preference
  - `backup:periodicPromptAsked` - user consent flag
  - `state` - app state snapshot
- **Files**: `index.html`, `sw-register.js`

---

## Configuration

### Manifest (`./manifest.json`)
- Relative paths for cross-hosting compatibility
- Icons configured with maskable support
- Scope: `./` (root-relative)
- Display: `standalone`
- Orientation: `portrait`
- Categories: `sports, productivity`

### Service Worker (`./service-worker.js`)
- Precache list in `PRECACHE_URLS`
- Cache name: `app-cache-v2`
- Periodic sync tags: `weekly-backup`, `vb-periodic-backup`
- Push enabled with handler

### Bootstrap (`./pwa-bootstrap.js`)
- SW registration with manifest scope detection
- Install prompt handling
- Notification permission auto-request (optional)
- Periodic sync registration with user consent
- Push subscription helper function

---

## Checklist for PWA Quality ✓

### Offline Support
- [x] Service Worker registered and active
- [x] Manifest with display:standalone
- [x] Icons in multiple sizes
- [x] App shell cached
- [x] Offline fallback implemented
- [x] Cache strategy for assets

### Periodic Background Sync
- [x] `periodicsync` event handler in SW
- [x] `reg.periodicSync.register()` called with tag and minInterval
- [x] Message to clients with `event.waitUntil()`
- [x] Client message handler for sync trigger
- [x] Fallback for unsupported browsers
- [x] User consent flow

### Push Notifications
- [x] Notification permission requested
- [x] `push` event handler in SW
- [x] `showNotification()` called with options
- [x] `notificationclick` handler implemented
- [x] Client message handler for in-app persistence
- [x] Graceful fallback if not supported

### All Three Storages
- [x] Cache API for HTTP responses
- [x] IndexedDB for offline queue
- [x] localStorage for preferences

---

## Testing & Debugging

### Chrome DevTools
1. **Offline**: Toggle "Offline" checkbox in Network tab
2. **SW**: Application → Service Workers → View handler, Clear storage
3. **Periodic Sync**: Look for tags under "Periodic Background Sync"
4. **Push**: Check "Push Service Messages" in SW details

### Firefox DevTools
1. **About**: `about:debugging` → Temporary Extensions
2. **SW**: Inspect Service Worker
3. **Note**: Limited periodic sync/push UI

### Console Commands
```javascript
// Check SW registration
navigator.serviceWorker.getRegistrations().then(regs => console.log(regs));

// Check periodic sync tags
const reg = await navigator.serviceWorker.ready;
await reg.periodicSync.getTags().then(tags => console.log(tags));

// Check push subscription
const sub = await reg.pushManager.getSubscription();
console.log(sub);

// Check notification permission
console.log(Notification.permission);
```

---

## Troubleshooting

### Service Worker Not Registering
- Check manifest scope matches SW scope
- Ensure HTTPS (or localhost for testing)
- Check DevTools for registration errors
- Clear cache and reload

### Periodic Sync Not Triggering
- Browser may not trigger if not installed as PWA
- Check if `periodicSync` is supported: `'periodicSync' in ServiceWorkerRegistration.prototype`
- Monitor with DevTools Application tab
- Test in Chrome/Edge (best support)

### Push Notifications Not Working
- Confirm Notification permission granted
- Check if server is set up to send push (requires VAPID key implementation)
- Verify subscription endpoint is valid
- Check browser supports Web Push API

### Offline Mode Issues
- Verify Service Worker installation completed
- Check `Cache Storage` in DevTools for cached files
- Ensure SPA shell (index.html) is in precache list
- Test with Network throttling instead of pure offline

---

## Browser Support

| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| Service Workers | ✓ | ✓ | ✓ | ✓ |
| Offline Support | ✓ | ✓ | ✓ | ✓ |
| Periodic Background Sync | ✓ | ✗ | ✗ | ✓ |
| Push Notifications | ✓ | ✓ | ✗ (limited) | ✓ |
| Notification API | ✓ | ✓ | ✓ | ✓ |

---

## References

- [MDN: Service Worker](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
- [MDN: Background Sync](https://developer.mozilla.org/en-US/docs/Web/API/Background_Sync_API)
- [MDN: Periodic Background Sync](https://developer.mozilla.org/en-US/docs/Web/API/Periodic_Background_Sync_API)
- [MDN: Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- [Web.dev: PWA Checklist](https://web.dev/pwa-checklist/)
- [WebPush Guide](https://web.dev/push-notifications-overview/)

