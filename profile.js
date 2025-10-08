/* profile.js

Vanilla JS profile component for the PWA.
Integrates with window.syncHybrid (created earlier) and the app's localStorage `STORAGE_KEY`.

Usage: include <script src="profile.js" defer></script> from index.html and call ProfileComponent.mount(containerEl)

Features:
- Displays first_name, last_name, email, phone from profiles table (via syncHybrid or localStorage)
- Shows last_sync_at and last_sync_device
- "Sync Now" button calls syncHybrid.backupNow()
- Shows recent backups (from syncHybrid.backups) and shared_backups
- Realtime subscription updates UI automatically
- LocalStorage fallback when offline
- Loading indicators and graceful error handling
*/

(function (global) {
  const AUTO_ID = 'profile-component';

  function formatDate(ts) {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleString(); } catch(e){ return String(ts); }
  }

  function createEl(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    Object.entries(attrs).forEach(([k,v]) => {
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v);
    });
    children.forEach(c => { if (c == null) return; if (typeof c === 'string') el.appendChild(document.createTextNode(c)); else el.appendChild(c); });
    return el;
  }

  // read local cached state
  function readLocalProfile() {
    try {
      const raw = localStorage.getItem(typeof STORAGE_KEY !== 'undefined' ? STORAGE_KEY : 'vb_dashboard_v8');
      if (!raw) return null;
      const st = JSON.parse(raw);
      return st.profiles || st.profile || st.user || st.userProfile || st.profileData || null;
    } catch(e){ console.warn('readLocalProfile failed', e); return null; }
  }

  function readLocalState() {
    try {
      const raw = localStorage.getItem(typeof STORAGE_KEY !== 'undefined' ? STORAGE_KEY : 'vb_dashboard_v8');
      if (!raw) return null;
      return JSON.parse(raw);
    } catch(e){ return null; }
  }

  // component
  class ProfileComponent {
    constructor(container) {
      this.container = container;
      this.state = {
        loading: true,
        syncing: false,
        error: null,
        profile: null,
        last_sync_at: null,
        last_sync_device: null,
        backups: [],
        shared_backups: []
      };
      this.subscriptions = [];
      this._mounted = false;
    }

    render() {
        const s = this.state || {};
        // Clear container
        this.container.innerHTML = '';

        const root = createEl('div', { class: 'profile-root', id: AUTO_ID });

        // Header
        const header = createEl('div', { class: 'profile-header' });
        header.appendChild(createEl('h2', {}, 'My Profile'));

        const syncInfo = createEl('div', { class: 'sync-info' });
        syncInfo.appendChild(createEl('div', {}, 'Last sync: '));
        syncInfo.appendChild(createEl('strong', {}, formatDate(s.last_sync_at || s.profile?.last_sync_at)));
        syncInfo.appendChild(createEl('div', { style: 'margin-top:6px' }, 'Device: '));
        syncInfo.appendChild(createEl('span', {}, s.last_sync_device || s.profile?.last_sync_device || '—'));
        header.appendChild(syncInfo);
        // small inline sync status (dot + text)
        try {
          const st = s.syncStatus || { syncing: !!s.syncing, online: true };
          const statusLine = createEl('div', { style: 'margin-top:6px;display:flex;align-items:center;gap:8px;justify-content:center;' });
          const dot = createEl('span', { id: 'pc_sync_dot', style: 'width:12px;height:12px;border-radius:50%;display:inline-block;border:1px solid rgba(0,0,0,0.06);vertical-align:middle;' });
          const statusText = createEl('span', { id: 'pc_sync_text', style: 'font-size:0.95rem;color:#333' });
          // transient message (e.g., on flush) overrides text briefly
          const transient = s._syncTransient;
          if (transient) {
            statusText.textContent = transient;
            dot.style.background = 'linear-gradient(180deg,#ffffff,#34d399)';
          } else if (st && st.syncing) {
            statusText.textContent = 'همگام‌سازی در حال انجام است';
            dot.style.background = 'linear-gradient(180deg,#ffffff,#10b981)';
            dot.style.boxShadow = '0 0 0 3px rgba(16,185,129,0.06)';
          } else if (st && st.online === false) {
            statusText.textContent = 'آفلاین — تغییرات محلی ذخیره شد';
            dot.style.background = 'linear-gradient(180deg,#ffffff,#f59e0b)';
            dot.style.boxShadow = '0 0 0 3px rgba(245,158,11,0.06)';
          } else {
            statusText.textContent = 'همگام‌سازی انجام شده';
            dot.style.background = 'linear-gradient(180deg,#ffffff,#34d399)';
          }
          statusLine.appendChild(dot);
          statusLine.appendChild(statusText);
          // optionally show last_sync_at from server/profile
          try {
            const last = s.last_sync_at || s.profile && (s.profile.last_sync_at || s.profile.updated_at || s.profile.updatedAt);
            if (last) {
              const ts = createEl('div', { style: 'font-size:12px;color:#666;margin-top:4px;' }, formatDate(last));
              const wrapper = createEl('div', { style: 'display:flex;flex-direction:column;align-items:center;' }, statusLine, ts);
              syncInfo.appendChild(wrapper);
            } else {
              syncInfo.appendChild(statusLine);
            }
          } catch(_) { syncInfo.appendChild(statusLine); }
        } catch(e) { /* ignore render errors for status */ }

        // Buttons + inline edit form (hidden by default)
        const btnRow = createEl('div', { class: 'profile-buttons', style: 'display:flex;gap:8px;justify-content:center;margin-top:12px;' });
        const editForm = createEl('div', { id: 'pc_edit_form', style: 'display:none;margin-top:10px;max-width:720px;margin-left:auto;margin-right:auto;' });
        const inputStyle = 'width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;box-sizing:border-box;';
        const fName = createEl('input', { id: 'pc_profileFirst', class: 'input', placeholder: 'نام', style: inputStyle });
        const lName = createEl('input', { id: 'pc_profileLast', class: 'input', placeholder: 'نام خانوادگی', style: inputStyle });
        const emailIn = createEl('input', { id: 'pc_profileEmail', class: 'input', placeholder: 'ایمیل', style: inputStyle });
        const phoneIn = createEl('input', { id: 'pc_profilePhone', class: 'input', placeholder: 'تلفن', style: inputStyle });
        const saveIn = createEl('button', { class: 'btn primary', id: 'pc_saveProfileBtn', style: 'margin-left:8px;' }, 'ذخیره');
        const cancelIn = createEl('button', { class: 'btn', id: 'pc_cancelProfileBtn' }, 'لغو');
        const formRow = createEl('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:8px;' }, saveIn, cancelIn);
        editForm.appendChild(createEl('div', { style: 'display:grid;gap:8px;' }, fName, lName, emailIn, phoneIn, formRow));

        const editBtn = createEl('button', { class: 'btn', id: 'editProfileToggleLocal' }, 'ویرایش');
        const syncBtn = createEl('button', { class: 'btn', id: 'syncProfileBtn' }, 'همگام‌سازی');
        const logoutBtnLocal = createEl('button', { class: 'btn', id: 'logoutBtnLocal', style: 'background:#ef4444;color:#fff;border:none;' }, 'خروج');

        // Wire edit toggle
        editBtn.addEventListener('click', ()=>{
          try {
            fName.value = s.profile?.first_name || s.profile?.firstName || '';
            lName.value = s.profile?.last_name || s.profile?.lastName || '';
            emailIn.value = s.profile?.email || '';
            phoneIn.value = s.profile?.phone || '';
            editForm.style.display = (editForm.style.display === 'block') ? 'none' : 'block';
            if (editForm.style.display === 'block') try { fName.focus(); } catch(_){ }
          } catch(e){ console.warn('open internal edit form failed', e); }
        });

        cancelIn.addEventListener('click', ()=>{ editForm.style.display = 'none'; });

        // Save handler (uses robust auth fallbacks)
        saveIn.addEventListener('click', async ()=>{
          try {
            saveIn.disabled = true;
            const client = (window.supabase && window.supabase.auth) ? window.supabase : (window.getSupabaseClient ? window.getSupabaseClient() : null);
            if (!client) throw new Error('Supabase client not available');
            let user = null;
            try { if (typeof client.auth.getUser === 'function') { const { data: ud } = await client.auth.getUser(); user = ud && ud.user ? ud.user : null; } } catch(_){}
            if (!user) {
              try { if (typeof client.auth.getSession === 'function') { const { data: sd } = await client.auth.getSession(); user = sd && sd.session && sd.session.user ? sd.session.user : null; } } catch(_){ }
            }
            if (!user) {
              try { if (typeof client.auth.user === 'function') user = client.auth.user(); } catch(_){ }
            }
            if (!user) user = window._lastAuthUser || null;
            if (!user) throw new Error('Not signed in');
            const payload = { id: user.id, first_name: fName.value || null, last_name: lName.value || null, phone: phoneIn.value || null, email: emailIn.value || user.email || null };
            const res = await client.from('profiles').upsert(payload, { returning: 'representation' });
            if (res && res.error) throw res.error;
            // Force reload from server after save to get latest data
            let fresh = null;
            try {
              const sel = await client.from('profiles').select('first_name,last_name,phone,avatar_url,email,last_sync_at,last_sync_device').eq('id', user.id).maybeSingle();
              if (sel && !sel.error && sel.data) fresh = sel.data;
            } catch(_){ }
            if (fresh) {
              this.setState({ profile: fresh, last_sync_at: fresh.last_sync_at || fresh.updated_at, last_sync_device: fresh.last_sync_device });
            } else if (res && res.data && res.data[0]) {
              this.setState({ profile: res.data[0] });
            }
            editForm.style.display = 'none';
          } catch(e) { console.error('save profile in component failed', e); alert('خطا در ذخیره پروفایل: ' + (e && e.message || e)); }
          finally { saveIn.disabled = false; }
        });

        // Sync handler
        syncBtn.addEventListener('click', async ()=>{
          try {
            if (typeof window.backupNow === 'function') { await window.backupNow(); }
            else if (window.syncHybrid && typeof window.syncHybrid.backupNow === 'function') { await window.syncHybrid.backupNow(); }
            else { try { alert('ماژول همگام‌سازی در دسترس نیست'); } catch(_){ } }
            try { if (window._profileComponentInstance && typeof window._profileComponentInstance.loadInitial === 'function') { await window._profileComponentInstance.loadInitial(); window._profileComponentInstance.render(); } } catch(_){ }
          } catch(e) { console.warn('sync action failed', e); }
        });

        // Logout handler
        logoutBtnLocal.addEventListener('click', async ()=>{
          try {
            const supa = (window.supabase && window.supabase.auth) ? window.supabase : (window.getSupabaseClient ? window.getSupabaseClient() : null);
            if (supa && supa.auth && typeof supa.auth.signOut === 'function') {
              await supa.auth.signOut();
            }
            try { if (typeof window.showAuthForms === 'function') window.showAuthForms(true); else { const eb = document.getElementById('embeddedAuthBox'); if (eb) eb.style.display = 'block'; } } catch(_){ }
            try { const apc = document.getElementById('accountProfileContainer'); if (apc) { apc.style.display = 'none'; apc.innerHTML = ''; } } catch(_){ }
            try { this.unmount(); } catch(_){ }
          } catch(e){ console.warn('logout from profile component failed', e); }
        });

        btnRow.appendChild(editBtn);
        btnRow.appendChild(syncBtn);
        btnRow.appendChild(logoutBtnLocal);
        header.appendChild(btnRow);

        root.appendChild(header);

        // profile details

        // معماری استاتیک با رندر داینامیک: کارت پروفایل با همان ظاهر قبلی
        let user = null;
        try {
          if (window.supabase && window.supabase.auth && typeof window.supabase.auth.getUser === 'function') {
            const ures = window.supabase.auth.getUser();
            if (ures && typeof ures.then === 'function') {
              ures.then(r => { if (r && r.data && r.data.user) user = r.data.user; });
            } else if (ures && ures.data && ures.data.user) {
              user = ures.data.user;
            }
          } else if (window.supabase && window.supabase.auth && typeof window.supabase.auth.user === 'function') {
            user = window.supabase.auth.user();
          }
        } catch(_){}
        if (!user && window._lastAuthUser) user = window._lastAuthUser;
        const profile = s.profile || {};
        const first = profile.first_name || profile.firstName || (user && (user.user_metadata?.first_name || user.user_metadata?.firstName)) || '';
        const last = profile.last_name || profile.lastName || (user && (user.user_metadata?.last_name || user.user_metadata?.lastName)) || '';
        const email = profile.email || (user && user.email) || '';
        const phone = profile.phone || (user && user.phone) || '';
        const fullName = (first + ' ' + last).trim();
        const avatar = profile.avatar_url || 'icons/icon-maskable-192.png';

        const card = createEl('div', { class: 'card', style: 'padding:12px;border-radius:10px;' });
        const cardInner = createEl('div', { style: 'display:flex;flex-direction:column;gap:8px;align-items:center;text-align:center;' });
        cardInner.appendChild(createEl('img', { id: 'accountAvatar', src: avatar, alt: 'avatar', style: 'width:88px;height:88px;border-radius:50%;object-fit:cover;' }));
        cardInner.appendChild(createEl('div', { id: 'accountName', style: 'font-weight:700;color:var(--text);font-size:18px;margin-top:4px;' }, fullName || '—'));
        cardInner.appendChild(createEl('div', { id: 'accountEmail', style: 'color:var(--muted);font-size:14px;margin-top:2px;' }, email || '—'));
        cardInner.appendChild(createEl('div', { id: 'accountPhone', style: 'color:var(--muted);font-size:14px;margin-top:2px;' }, phone || '—'));
        cardInner.appendChild(createEl('hr', { style: 'border:none;border-top:1px solid rgba(0,0,0,0.06);margin:10px 0;width:100%;' }));
        const backupRow = createEl('div', { style: 'display:flex;align-items:center;gap:8px;' });
        backupRow.appendChild(createEl('div', { id: 'backupIcon', style: 'width:14px;height:14px;border-radius:50%;background:transparent;display:inline-block;vertical-align:middle;border:1px solid rgba(0,0,0,0.06);' }));
        backupRow.appendChild(createEl('div', { id: 'backupStatus_old', style: 'display:none;font-size:13px;color:var(--muted);' }, '--'));
        cardInner.appendChild(backupRow);
        cardInner.appendChild(createEl('div', { id: 'lastSyncLineHeader_old', style: 'display:none;font-size:12px;color:var(--muted);width:100%;text-align:center;margin-top:6px;' }, 'آخرین همگام‌سازی: —'));
        // Controls (sync, import, etc.)
        const controls = createEl('div', { id: 'profileSyncControls', style: 'display:flex;flex-direction:column;gap:8px;align-items:center;width:100%;max-width:420px;' });
        controls.appendChild(createEl('label', { style: 'font-size:13px;color:var(--muted);display:flex;align-items:center;gap:8px;' },
          createEl('input', { type: 'checkbox', id: 'autoImportToggle', checked: true }),
          createEl('span', {}, 'همگام‌سازی خودکار فعال است')
        ));
        controls.appendChild(createEl('div', { id: 'syncStatusLine', style: 'font-size:13px;color:var(--muted);width:100%;text-align:center;display:none;' }, 'وضعیت: ', createEl('span', { id: 'syncStatusText' })));
        controls.appendChild(createEl('div', { id: 'lastSyncLine', style: 'font-size:12px;color:var(--muted);width:100%;text-align:center;display:none;' }, 'آخرین همگام‌سازی: —'));
        const actionRow = createEl('div', { class: 'action-row', style: 'display:flex;gap:8px;width:100%;' });
        actionRow.appendChild(createEl('button', { id: 'importNowBtn', class: 'btn', style: 'flex:1;' }, 'واردسازی الآن'));
        actionRow.appendChild(createEl('button', { id: 'forceSyncBtn', class: 'btn', style: 'flex:1;background:#2563eb;color:#fff;border:none;' }, 'ارسال همگام‌سازی'));
        controls.appendChild(actionRow);
        cardInner.appendChild(controls);
        card.appendChild(cardInner);
        root.appendChild(card);
        root.appendChild(editForm);

        if (s.error) {
          const err = createEl('div', { class: 'profile-error' }, 'Error: ' + (s.error && s.error.message ? s.error.message : String(s.error)));
          root.appendChild(err);
        }

        // lightweight debug panel when no profile is present
        if (!s.profile) {
          const dbg = createEl('div', { style: 'background:#fff6f0;border:1px solid #ffd6c2;padding:8px;margin-top:12px;border-radius:6px;' });
          dbg.appendChild(createEl('div', {}, 'پروفایلی پیدا نشد. برای رفع اشکال اطلاعات احراز هویت و خطاها را بررسی کنید.'));
          const showBtn = createEl('button', { class: 'btn', style: 'margin-top:8px;' }, 'نمایش اطلاعات اشکال‌زدایی');
          const debugBox = createEl('pre', { style: 'display:none;white-space:pre-wrap;background:#fff;border:1px solid #eee;padding:8px;margin-top:8px;border-radius:6px;max-height:200px;overflow:auto;' });
          showBtn.addEventListener('click', ()=>{
            if (debugBox.style.display === 'none') {
              const d = s._debug || {};
              const lines = [];
              lines.push('supabaseClientPresent: ' + !!d.supaExists);
              lines.push('detectedUserId: ' + (d.userId || '(none)'));
              lines.push('detectedUserEmail: ' + (d.userEmail || '(none)'));
              lines.push('selectFound: ' + (!!d.selectFound));
              if (d.selectError) lines.push('selectError: ' + d.selectError);
              if (d.fetchError) lines.push('fetchError: ' + d.fetchError);
              // If no supabase client, add action hints
              if (!d.supaExists) {
                lines.push('');
                lines.push('توضیح: در حالت محلی یک شیم (shim) برای Supabase وجود دارد که قابلیت‌های واقعی را فراهم نمی‌کند.');
                lines.push('گزینه‌ها:');
                lines.push('- دانلود رسمی SDK و قرار دادن آن در /libs/supabase.min.js (راهنمای README)');
                lines.push('- یا اجازه دهید صفحه از CDN بارگذاری کند (این صفحه تلاش خودکار برای بارگذاری CDN دارد)');
                lines.push('پس از نصب/بارگذاری SDK واقعی، صفحه را ریفرش و دوباره لاگین کنید.');
              }
              debugBox.textContent = lines.join('\n');
              debugBox.style.display = 'block';
            } else {
              debugBox.style.display = 'none';
            }
          });
          dbg.appendChild(showBtn);
          dbg.appendChild(debugBox);
          root.appendChild(dbg);
        }

        // styles
        const style = document.createElement('style');
        style.textContent = `
          #${AUTO_ID} { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', 'Helvetica Neue'; max-width:900px; margin: 12px auto; padding:12px; }
          #${AUTO_ID} .profile-header { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:12px }
          #${AUTO_ID} h2{ margin:0 0 6px 0 }
          #${AUTO_ID} .sync-info{ font-size:0.95rem; color:#333 }
          #${AUTO_ID} .profile-details{ display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:12px }
          #${AUTO_ID} .profile-field label{ font-weight:600; margin-right:6px }
          #${AUTO_ID} .btn{ padding:8px 12px; border-radius:6px; border:1px solid #0078d4; background:#0078d4; color:white; cursor:pointer }
          #${AUTO_ID} .btn[disabled]{ opacity:0.6; cursor:not-allowed }
          @media (max-width:640px){ #${AUTO_ID} .profile-details{ grid-template-columns:1fr } }
        `;

        btnRow.appendChild(editBtn);
        btnRow.appendChild(syncBtn);
        btnRow.appendChild(logoutBtnLocal);
        root.appendChild(btnRow);
        this.container.appendChild(style);
        this.container.appendChild(root);
      }

    async loadInitial() {
      this.setState({ loading: true, error: null });

      // Try to use server-backed profile via Supabase client first
      try {
        const supa = (window.supabase && window.supabase.auth) ? window.supabase : (window.getSupabaseClient ? window.getSupabaseClient() : null);
        let user = null;
        const dbg = { supaExists: !!supa, userId: null, userEmail: null, selectFound: false, selectError: null, fetchError: null };
        if (supa && supa.auth) {
          try {
            if (typeof supa.auth.getUser === 'function') {
              const { data: ud } = await supa.auth.getUser();
              user = ud && ud.user ? ud.user : null;
              console.log('[ProfileComponent] supabase.auth.getUser() result:', ud);
            } else if (typeof supa.auth.getSession === 'function') {
              const { data: sd } = await supa.auth.getSession();
              user = sd && sd.session && sd.session.user ? sd.session.user : null;
              console.log('[ProfileComponent] supabase.auth.getSession() result:', sd);
            }
          } catch(e) { console.warn('auth getUser/getSession attempt failed', e); }
        }
        if (!user && window._lastAuthUser) user = window._lastAuthUser;
        if (user) { dbg.userId = user.id; dbg.userEmail = user.email || null; }
        if (supa && user && user.id) {
          try {
            let res = await supa.from('profiles').select('*').eq('id', user.id).maybeSingle();
            console.log('[ProfileComponent] supabase.from(profiles).select result:', res);
            if (res && !res.error && res.data) {
              const p = res.data;
              dbg.selectFound = true;
              this.setState({ profile: p, last_sync_at: p.last_sync_at || p.updated_at, last_sync_device: p.last_sync_device });
            } else if (res && !res.error && !res.data) {
              // no profile row yet — auto-create it with basic info
              try {
                const basic = { id: user.id, email: user.email || '', first_name: user.user_metadata && user.user_metadata.first_name ? user.user_metadata.first_name : '', last_name: user.user_metadata && user.user_metadata.last_name ? user.user_metadata.last_name : '' };
                // create the row in supabase
                let upsertRes = await supa.from('profiles').upsert(basic, { returning: 'representation' });
                console.log('[ProfileComponent] upserted basic profile:', upsertRes);
                if (upsertRes && !upsertRes.error && upsertRes.data && upsertRes.data[0]) {
                  this.setState({ profile: upsertRes.data[0] });
                } else {
                  this.setState({ profile: basic });
                }
              } catch(_){ }
            } else if (res && res.error) {
              console.error('ProfileComponent: error fetching profile from supabase', res.error);
              dbg.selectError = (res.error && res.error.message) || String(res.error);
              this.setState({ error: res.error });
            }
            // subscribe to changes on this profile row so updates reflect immediately
            try {
              if (supa && supa.channel && typeof supa.channel === 'function') {
                const chName = 'profile-watch-' + user.id;
                try {
                  const ch = supa.channel(chName);
                  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'profiles', filter: `id=eq.${user.id}` }, payload => {
                    try { const row = payload.new || payload.record || payload; if (row) this.setState({ profile: row, last_sync_at: row.last_sync_at || row.updated_at, last_sync_device: row.last_sync_device }); } catch(e){ }
                  }).subscribe();
                  this.subscriptions.push(() => { try { ch.unsubscribe(); } catch(_){} });
                } catch(e) { /* ignore subscription errors */ }
              }
            } catch(e) {}
          } catch(e) { console.warn('ProfileComponent profile fetch failed', e); }
        }
        // store debug snapshot for the UI debug panel
        try { this.setState({ _debug: dbg }); } catch(_){ }
      } catch(e) { console.warn('ProfileComponent server profile attempt failed', e); }

      // fallback: localStorage / syncHybrid as before
      try {
        const local = readLocalState();
        if (local && local.profiles) {
          this.setState({ profile: local.profiles, last_sync_at: local.profiles.last_sync_at, last_sync_device: local.profiles.last_sync_device });
        } else if (local && local.user) {
          this.setState({ profile: local.user, last_sync_at: local.user.last_sync_at, last_sync_device: local.user.last_sync_device });
        }

        if (window.syncHybrid) {
          if (window.syncHybrid.profiles && typeof window.syncHybrid.profiles.reload === 'function') {
            try { await window.syncHybrid.profiles.reload(); } catch(e){ console.warn('profile reload failed', e); }
          }
          if (window.syncHybrid.backups && typeof window.syncHybrid.backups.list === 'function') {
            const res = await window.syncHybrid.backups.list({ limit: 50 }); if (Array.isArray(res)) this.setState({ backups: res });
          }
          if (window.syncHybrid.sharedBackups && typeof window.syncHybrid.sharedBackups.list === 'function') {
            try { const sres = await window.syncHybrid.sharedBackups.list({ limit: 50 }); if (Array.isArray(sres)) this.setState({ shared_backups: sres }); } catch(e){}
          }
          if (window.syncHybrid._cache && window.syncHybrid._cache.profiles) {
            const p = window.syncHybrid._cache.profiles[0] || window.syncHybrid._cache.profiles;
            if (p) this.setState({ profile: p, last_sync_at: p.last_sync_at || p.updated_at || p.updatedAt, last_sync_device: p.last_sync_device });
          }
        }
      } catch(e) { console.warn('ProfileComponent fallback profile load failed', e); this.setState({ error: e }); }

      this.setState({ loading: false });
    }

    setState(patch) {
      this.state = Object.assign({}, this.state, patch);
      if (this._mounted) this.render();
    }

    async doSync() {
      if (!window.syncHybrid || typeof window.syncHybrid.backupNow !== 'function') {
        this.setState({ error: new Error('Sync module not available') });
        return;
      }
      this.setState({ syncing: true, error: null });
      try {
        const result = await window.syncHybrid.backupNow();
        // update UI from result (expect result to include created_at, user_id and metadata)
        if (result && result.created_at) {
          this.setState({ last_sync_at: result.created_at, last_sync_device: result.device_id || result.last_sync_device });
        }
        // refresh backups list
        if (window.syncHybrid.backups && typeof window.syncHybrid.backups.list === 'function') {
          try { const res = await window.syncHybrid.backups.list({ limit: 50 }); if (Array.isArray(res)) this.setState({ backups: res }); } catch(e) { console.warn('refresh backups failed', e); }
        }
      } catch(e) {
        console.error('backupNow failed', e);
        this.setState({ error: e });
      } finally {
        this.setState({ syncing: false });
      }
    }

    // subscribe to realtime changes for backups/shared_backups
    subscribeRealtime() {
      if (!window.syncHybrid) return;
      // subscribe via syncHybrid if it exposes subscribe helpers, otherwise use supabase directly
      try {
        if (window.syncHybrid.on) {
          const unsubBackups = window.syncHybrid.on('backups', (evt) => { this.onRealtimeChange(evt); });
          const unsubShared = window.syncHybrid.on('shared_backups', (evt) => { this.onRealtimeChange(evt); });
          if (typeof unsubBackups === 'function') this.subscriptions.push(unsubBackups);
          if (typeof unsubShared === 'function') this.subscriptions.push(unsubShared);
        } else if (window.supabase && window.supabase.channel) {
          // Supabase Realtime v2 channel usage
          try {
            const ch = window.supabase.channel('public:backups');
            ch.on('postgres_changes', { event: '*', schema: 'public', table: 'backups' }, payload => this.onRealtimeChange(payload)).subscribe();
            this.subscriptions.push(() => ch.unsubscribe());
          } catch(e) { console.warn('fallback realtime backups subscribe failed', e); }

          try {
            const ch2 = window.supabase.channel('public:shared_backups');
            ch2.on('postgres_changes', { event: '*', schema: 'public', table: 'shared_backups' }, payload => this.onRealtimeChange(payload)).subscribe();
            this.subscriptions.push(() => ch2.unsubscribe());
          } catch(e) { console.warn('fallback realtime shared_backups subscribe failed', e); }
        }
      } catch(e) {
        console.warn('subscribeRealtime error', e);
      }
    }

    // handles a realtime payload from either backups/shared_backups
    async onRealtimeChange(payload) {
      try {
        // payload may be { eventType, new, old } or Supabase realtime payload shape
        const row = (payload.new || payload.record || payload) ;
        // if it's a full row with user_id matching current user then refresh
        try {
          const user = (window.supabase && window.supabase.auth && window.supabase.auth.user && window.supabase.auth.user()) || null;
          if (row && row.user_id && user && String(row.user_id) !== String(user.id)) {
            // not for this user; ignore
            return;
          }
        } catch(e){ /* ignore user check */ }

        // refresh backups list quickly
        if (window.syncHybrid && window.syncHybrid.backups && typeof window.syncHybrid.backups.list === 'function') {
          try {
            const res = await window.syncHybrid.backups.list({ limit: 50 });
            if (Array.isArray(res)) this.setState({ backups: res });
          } catch(e){ console.warn('failed to reload backups after realtime event', e); }
        }

        // refresh shared_backups
        if (window.syncHybrid && window.syncHybrid.sharedBackups && typeof window.syncHybrid.sharedBackups.list === 'function') {
          try { const sres = await window.syncHybrid.sharedBackups.list({ limit: 50 }); if (Array.isArray(sres)) this.setState({ shared_backups: sres }); } catch(e) {}
        }

        // if the payload touches the profile row update profile cache
        if (row && (row.email || row.first_name || row.last_name || row.last_sync_at)) {
          // naive merge
          const p = Object.assign({}, this.state.profile || {}, row);
          this.setState({ profile: p, last_sync_at: p.last_sync_at || p.updated_at, last_sync_device: p.last_sync_device });
        }
      } catch(e) { console.warn('onRealtimeChange handler error', e); }
    }

    setTransient(msg, ms = 3000) {
      try {
        this.setState({ _syncTransient: msg });
        if (this._transientTimer) clearTimeout(this._transientTimer);
        this._transientTimer = setTimeout(()=>{ try { this.setState({ _syncTransient: null }); } catch(_){} }, ms);
      } catch(e){}
    }

    unmount() {
      this._mounted = false;
      (this.subscriptions || []).forEach(fn => { try { fn(); } catch(e){} });
      this.subscriptions = [];
      // remove sync status listeners if attached
      try { if (this._syncStatusHandler) { window.removeEventListener('syncHybrid:status', this._syncStatusHandler); this._syncStatusHandler = null; } } catch(_){ }
      try { if (this._syncFlushHandler) { window.removeEventListener('syncHybrid:flush', this._syncFlushHandler); this._syncFlushHandler = null; } } catch(_){ }
      this.container.innerHTML = '';
    }

    async mount() {
    if (this._mounted) return; // already mounted
    this._mounted = true;
    // clear legacy cached profile to avoid duplicate old UI
    try { localStorage.removeItem('profile'); } catch(_){ }
    try { delete window.oldProfile; } catch(_){ }
    this.render();
    // subscribe to global sync status events so the UI can show a compact indicator
    try {
      this._syncStatusHandler = (e) => { try { const st = (e && e.detail) ? e.detail : {}; this.setState({ syncStatus: st, syncing: !!st.syncing }); } catch(_){} };
      this._syncFlushHandler = (e) => { try { const d = e && e.detail ? e.detail : {}; if (d && d.success) { this.setTransient('همگام‌سازی به‌پایان رسید', 3000); this.setState({ syncStatus: Object.assign({}, this.state.syncStatus || {}, { syncing: false }) }); } else if (d && d.error) { this.setTransient('خطا در همگام‌سازی', 4000); } } catch(_){} };
      window.addEventListener('syncHybrid:status', this._syncStatusHandler);
      window.addEventListener('syncHybrid:flush', this._syncFlushHandler);
      // initialize from existing status if available
      if (window.syncHybrid && window.syncHybrid.status) {
        try { this.setState({ syncStatus: window.syncHybrid.status, syncing: !!window.syncHybrid.status.syncing }); } catch(_){ }
      }
    } catch(_){ }
    // Immediately load profile data — avoid waiting loops that can block the UI
    try { await this.loadInitial(); } catch(e){ console.debug('loadInitial on mount failed', e); }
    try { this.render(); } catch(_){ }
    // subscribeRealtime kept for legacy backups handling; primary profile realtime subscription is in loadInitial
    try { this.subscribeRealtime(); } catch(_){ }
    }
  }

  // expose a global helper
  global.ProfileComponent = {
    mount: function (container) {
      console.debug('ProfileComponent.mount called with', container);
      const c = (typeof container === 'string' ? document.querySelector(container) : container);
      if (!c) throw new Error('container not found');
      // ensure only one instance exists
      try { if (window._profileComponentInstance && typeof window._profileComponentInstance.unmount === 'function') { try { window._profileComponentInstance.unmount(); } catch(_){}; window._profileComponentInstance = null; } } catch(_){ }
      const comp = new ProfileComponent(c);
      window._profileComponentInstance = comp;
      comp.mount();
      return comp;
    }
  };

})(window);
