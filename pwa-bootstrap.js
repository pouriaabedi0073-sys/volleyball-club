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
    
    // Create install button if it doesn't exist
    if (!document.getElementById('installPWA')) {
      const installButton = document.createElement('button');
      installButton.id = 'installPWA';
      installButton.innerHTML = `
        <span class="install-icon"></span>
        <span class="install-text">نصب برنامه</span>
      `;
      installButton.addEventListener('click', () => {
        window.deferredPWAInstall.prompt();
        window.deferredPWAInstall.userChoice.then((choiceResult) => {
          if (choiceResult.outcome === 'accepted') {
            console.log('User accepted the install prompt');
            installButton.style.display = 'none';
          }
        });
      });
      document.body.appendChild(installButton);
    }
  });
  
  // Hide install button when app is installed
  window.addEventListener('appinstalled', () => {
    const installButton = document.getElementById('installPWA');
    if (installButton) {
      installButton.style.display = 'none';
    }
  });
})();
