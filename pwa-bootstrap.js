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
    if (!document.getElementById('pwaInstallPrompt')) {
      const installPrompt = document.createElement('div');
      installPrompt.id = 'pwaInstallPrompt';
      installPrompt.className = 'pwa-install-prompt';
      installPrompt.innerHTML = `
        <span class="install-icon"></span>
        <span class="install-text">نصب نسخه کامل برنامه</span>
        <button class="close-button" aria-label="بستن">✕</button>
      `;
      
      // Show the prompt with animation
      setTimeout(() => {
        installPrompt.classList.add('show');
      }, 1000);

      // Handle install click
      installPrompt.addEventListener('click', (event) => {
        if (event.target.classList.contains('close-button')) {
          installPrompt.remove();
          return;
        }
        window.deferredPWAInstall.prompt();
        window.deferredPWAInstall.userChoice.then((choiceResult) => {
          if (choiceResult.outcome === 'accepted') {
            console.log('User accepted the install prompt');
            installPrompt.remove();
          }
        });
      });
      
      document.body.appendChild(installPrompt);
    }
  });
  
  // Hide install button when app is installed
  window.addEventListener('appinstalled', () => {
    // remove either legacy #installPWA or the centralized #pwaInstallPrompt / .pwa-install-prompt
    try {
      const legacy = document.getElementById('installPWA');
      if (legacy && legacy.parentNode) legacy.parentNode.removeChild(legacy);
    } catch(_) {}
    try {
      const centralized = document.getElementById('pwaInstallPrompt') || document.querySelector('.pwa-install-prompt');
      if (centralized && centralized.parentNode) centralized.parentNode.removeChild(centralized);
    } catch(_) {}
  });
})();
