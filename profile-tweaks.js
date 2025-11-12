// Small tweak: move "Edit profile" button above other profile action buttons
(function(){
  function moveEditProfileUp() {
    try {
      const container = document.getElementById('accountProfileContainer');
      if (!container) return;

      // Common selectors for an edit profile button (English & Persian)
      const selectors = [
        "button[data-action='edit-profile']",
        "button.edit-profile",
        "button#editProfile",
        "button[aria-label='Edit profile']",
        "button[aria-label='ویرایش پروفایل']",
        "button:contains('ویرایش')",
        "button:contains('Edit profile')"
      ];

      // Since :contains is not supported, we'll search by text if needed
      const allButtons = Array.from(container.querySelectorAll('button'));
      let editBtn = allButtons.find(b => {
        const txt = (b.textContent || '').trim();
        return /ویرایش|Edit profile|Edit|Profile Edit/i.test(txt);
      });

      if (!editBtn) {
        // try attribute-based selectors
        for (const s of ['button[data-action="edit-profile"]','button.edit-profile','button#editProfile']) {
          const b = container.querySelector(s);
          if (b) { editBtn = b; break; }
        }
      }

      if (!editBtn) return;

      // Find an action row or profile action container and move the button to the front
      const actionRow = container.querySelector('.profile-action-row') || container.querySelector('.profile-actions') || container.querySelector('.action-row');
      if (!actionRow) return;

      // Prepend edit button to actionRow so it appears above others visually in RTL (or first)
      actionRow.insertBefore(editBtn, actionRow.firstChild);
    } catch (e) { console.warn('moveEditProfileUp failed', e); }
  }

  // Run on DOM ready and also on mutations inside the profile container
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', moveEditProfileUp);
  else moveEditProfileUp();

  // Observe profile container for dynamic changes
  const obs = new MutationObserver(() => moveEditProfileUp());
  try {
    const container = document.getElementById('accountProfileContainer');
    if (container) obs.observe(container, { childList: true, subtree: true });
  } catch (e) { }
})();
