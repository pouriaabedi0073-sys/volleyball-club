// src/main.js
import './compat/globals.js';
// Import notifications module (keeps existing behavior)
import './notifications/notifications.js';

// Bootstrap the app in a minimal way. This file will be the place to import
// other modules gradually (auth, backup, ui, storage) without requiring a bundler.

document.addEventListener('DOMContentLoaded', () => {
  try {
    // Ensure state loaded
    if (typeof window.loadState === 'function') window.loadState();
    // Initialize notifications if available
    if (typeof window.initNotifications === 'function') {
      try { window.initNotifications(); } catch (e) { console.warn('initNotifications failed in main', e); }
    }
    // Expose a small flag so other scripts can detect module bootstrap
    window.__app_bootstrapped = true;
    console.info('src/main.js bootstrapped');
  } catch (e) { console.warn('bootstrap error', e); }
});
