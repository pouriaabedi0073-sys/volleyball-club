// Minimal bootstrap: SW register + install prompt + connection status hook
(function(){
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.getRegistration().then(reg => {
        if (!reg) {
          navigator.serviceWorker.register('./service-worker.js', { scope: './' })
            .catch(console.error);
        }
      });
    });
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.deferredPWAInstall = e;
    document.dispatchEvent(new CustomEvent('pwa-install-available'));
  });
})();
