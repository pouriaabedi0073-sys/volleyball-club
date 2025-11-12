// PWA Features Testing & Verification Script
// Run this in browser console to test: Offline Support, Periodic Sync, Push Notifications

console.log('=== PWA Features Verification ===\n');

// 1. SERVICE WORKER CHECK
async function checkServiceWorker() {
  console.log('📱 SERVICE WORKER STATUS');
  if (!('serviceWorker' in navigator)) {
    console.error('❌ Service Worker not supported');
    return false;
  }
  
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    if (registrations.length === 0) {
      console.warn('⚠️ No service workers registered');
      return false;
    }
    
    registrations.forEach(reg => {
      console.log(`✓ SW registered at scope: ${reg.scope}`);
      console.log(`  Active: ${reg.active ? '✓' : '❌'}`);
      console.log(`  Waiting: ${reg.waiting ? '✓ (update pending)' : '❌'}`);
    });
    return true;
  } catch (e) {
    console.error('❌ SW registration check failed:', e);
    return false;
  }
}

// 2. OFFLINE SUPPORT CHECK
async function checkOfflineSupport() {
  console.log('\n🌐 OFFLINE SUPPORT');
  try {
    const reg = await navigator.serviceWorker.ready;
    console.log('✓ Service Worker ready for offline support');
    
    // Check cache
    const caches_list = await caches.keys();
    console.log(`✓ Cache storage available (${caches_list.length} cache(s):`);
    caches_list.forEach(name => console.log(`  - ${name}`));
    
    // Check if manifest is cached
    const cache = await caches.open(caches_list[0] || 'app-cache-v2');
    const manifest = await cache.match('./manifest.json');
    console.log(`✓ Manifest cached: ${manifest ? '✓' : '❌'}`);
    
    const indexHtml = await cache.match('./index.html');
    console.log(`✓ index.html cached: ${indexHtml ? '✓' : '❌'}`);
    
    return true;
  } catch (e) {
    console.error('❌ Offline support check failed:', e);
    return false;
  }
}

// 3. PERIODIC BACKGROUND SYNC CHECK
async function checkPeriodicSync() {
  console.log('\n⏰ PERIODIC BACKGROUND SYNC');
  if (!('periodicSync' in ServiceWorkerRegistration.prototype)) {
    console.warn('⚠️ Periodic Background Sync not supported in this browser (only Chrome/Edge)');
    return false;
  }
  
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!reg.periodicSync) {
      console.error('❌ periodicSync not available');
      return false;
    }
    
    const tags = await reg.periodicSync.getTags();
    console.log(`✓ Periodic sync supported`);
    console.log(`  Registered tags: ${tags.length > 0 ? tags.join(', ') : 'none yet'}`);
    
    if (tags.includes('weekly-backup')) {
      console.log('✓ weekly-backup periodic sync is registered');
    } else {
      console.log('ℹ️  weekly-backup not yet registered (will be on user consent)');
    }
    
    return true;
  } catch (e) {
    console.error('❌ Periodic sync check failed:', e);
    return false;
  }
}

// 4. PUSH NOTIFICATIONS CHECK
async function checkPushNotifications() {
  console.log('\n🔔 PUSH NOTIFICATIONS');
  
  // Check Notification API
  if (!('Notification' in window)) {
    console.error('❌ Notification API not supported');
    return false;
  }
  
  console.log(`✓ Notification API supported`);
  console.log(`  Permission: ${Notification.permission}`);
  
  // Check Push API
  if (!('PushManager' in window)) {
    console.warn('⚠️ Push API not available (may require HTTPS)');
    return false;
  }
  
  console.log('✓ Push API available');
  
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!reg.pushManager) {
      console.error('❌ pushManager not available');
      return false;
    }
    
    const subscription = await reg.pushManager.getSubscription();
    if (subscription) {
      console.log('✓ Already subscribed to push notifications');
      console.log(`  Endpoint: ${subscription.endpoint.substring(0, 60)}...`);
    } else {
      console.log('ℹ️  Not yet subscribed (requires user permission + VAPID key)');
    }
    
    return true;
  } catch (e) {
    console.error('❌ Push check failed:', e);
    return false;
  }
}

// 5. MANIFEST CHECK
async function checkManifest() {
  console.log('\n📋 MANIFEST CONFIGURATION');
  try {
    const response = await fetch('./manifest.json');
    const manifest = await response.json();
    
    console.log('✓ Manifest loaded successfully');
    console.log(`  Name: ${manifest.name}`);
    console.log(`  Display: ${manifest.display}`);
    console.log(`  Scope: ${manifest.scope}`);
    console.log(`  Icons: ${manifest.icons ? manifest.icons.length + ' configured' : '❌ none'}`);
    console.log(`  Start URL: ${manifest.start_url}`);
    
    // Check for relative paths
    if (!manifest.start_url.startsWith('/') && !manifest.start_url.startsWith('http')) {
      console.log('✓ Start URL uses relative path (cross-hosting compatible)');
    } else {
      console.warn('⚠️ Start URL uses absolute path (may not work on all deployments)');
    }
    
    return true;
  } catch (e) {
    console.error('❌ Manifest check failed:', e);
    return false;
  }
}

// 6. STORAGE CHECK
async function checkStorage() {
  console.log('\n💾 STORAGE ARCHITECTURE');
  
  // localStorage
  try {
    const test = '__pwa_test__';
    localStorage.setItem(test, '1');
    localStorage.removeItem(test);
    console.log('✓ localStorage: available');
  } catch (e) {
    console.warn('⚠️ localStorage: not available', e.message);
  }
  
  // IndexedDB
  try {
    const request = window.indexedDB.open('test');
    request.onsuccess = () => {
      console.log('✓ IndexedDB: available');
    };
    request.onerror = () => {
      console.warn('⚠️ IndexedDB: not available');
    };
  } catch (e) {
    console.warn('⚠️ IndexedDB: not available', e.message);
  }
  
  // Cache API
  try {
    await caches.has('test');
    console.log('✓ Cache API: available');
  } catch (e) {
    console.warn('⚠️ Cache API: not available', e.message);
  }
}

// RUN ALL CHECKS
async function runAllChecks() {
  const results = {
    sw: await checkServiceWorker(),
    offline: await checkOfflineSupport(),
    periodic: await checkPeriodicSync(),
    push: await checkPushNotifications(),
    manifest: await checkManifest(),
    storage: await checkStorage()
  };
  
  console.log('\n' + '='.repeat(40));
  console.log('📊 SUMMARY');
  console.log('='.repeat(40));
  
  const passed = Object.values(results).filter(r => r).length;
  const total = Object.keys(results).length;
  
  console.log(`✓ Passed: ${passed}/${total}`);
  
  if (passed === total) {
    console.log('\n🎉 All PWA features are configured correctly!');
  } else {
    console.log('\n⚠️ Some features need attention. See above for details.');
  }
}

// HELPER FUNCTIONS

// Test offline mode
window.testOffline = function() {
  alert('Switch Network tab to Offline and reload page to test offline support');
};

// Request notification permission
window.requestNotificationPerm = async function() {
  try {
    const perm = await Notification.requestPermission();
    console.log('Notification permission:', perm);
    return perm;
  } catch (e) {
    console.error('Failed:', e);
  }
};

// Subscribe to push notifications
window.subscribeToPush = async function(vapidPublicKey) {
  try {
    if (!vapidPublicKey) {
      console.warn('⚠️ No VAPID key provided. Get one from your server.');
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: vapidPublicKey
    });
    console.log('✓ Subscribed to push:', subscription);
    return subscription;
  } catch (e) {
    console.error('Subscription failed:', e);
  }
};

// Manually test periodic sync
window.testPeriodicSync = async function(tag = 'weekly-backup') {
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!reg.periodicSync) {
      console.error('Periodic sync not supported');
      return;
    }
    await reg.periodicSync.register(tag);
    console.log(`✓ Registered ${tag} for testing`);
  } catch (e) {
    console.error('Failed:', e);
  }
};

// Manually test background sync
window.testBackgroundSync = async function(tag = 'vb-upload-sync') {
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!reg.sync) {
      console.error('Background sync not supported');
      return;
    }
    await reg.sync.register(tag);
    console.log(`✓ Requested ${tag} sync (may complete immediately)`);
  } catch (e) {
    console.error('Failed:', e);
  }
};

// Show test commands
window.showPwaTests = function() {
  console.log(`
╔════════════════════════════════════════╗
║        PWA TESTING COMMANDS            ║
╚════════════════════════════════════════╝

📱 Offline Support
  testOffline()          - Toggle offline mode in DevTools

🔔 Push Notifications
  requestNotificationPerm()              - Request permission
  subscribeToPush(vapidKey)              - Subscribe (needs VAPID from server)

⏰ Periodic Background Sync
  testPeriodicSync()     - Register 'weekly-backup'
  testPeriodicSync('tag')                - Register custom tag

📤 Background Sync
  testBackgroundSync()   - Request 'vb-upload-sync'
  testBackgroundSync('tag')              - Request custom tag

More commands:
  runAllChecks()         - Run full diagnostic (already executed above)
  `);
};

// Auto-run on load
console.log('Running PWA diagnostic...\n');
runAllChecks();
console.log('\nTip: Type showPwaTests() to see testing commands');
console.log('Tip: Type runAllChecks() anytime to re-run diagnostics\n');

// Export for global use
window.pwaTester = {
  checkServiceWorker,
  checkOfflineSupport,
  checkPeriodicSync,
  checkPushNotifications,
  checkManifest,
  checkStorage,
  runAllChecks,
  testOffline: window.testOffline,
  requestNotificationPerm: window.requestNotificationPerm,
  subscribeToPush: window.subscribeToPush,
  testPeriodicSync: window.testPeriodicSync,
  testBackgroundSync: window.testBackgroundSync,
  showPwaTests: window.showPwaTests
};
