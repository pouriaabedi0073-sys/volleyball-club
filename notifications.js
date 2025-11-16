// notifications.js
// Lightweight in-page notifications + Web Notification API wrapper
// Scans app state for upcoming items (birthdays, sessions, competitions, trainings)
(function(){
  const DEFAULT_KEY = (window.STORAGE_KEY || 'vb_dashboard_v8');
  let lastNotified = {}; // map to avoid duplicates during session
  let intervalId = null;
  const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

  function getAppState() {
    try {
      if (typeof window.state !== 'undefined') return window.state;
      if (typeof state !== 'undefined') return state;
      const raw = localStorage.getItem(DEFAULT_KEY);
      if (!raw) return {};
      return JSON.parse(raw || '{}');
    } catch (e) { return {}; }
  }

  // parse a date-like value into a JS Date, preferring Jalali-aware converters when available
  function parseDate(d) {
    if (!d) return null;
    try {
      // If already a Date
      if (d instanceof Date) return isNaN(d.getTime()) ? null : d;
      // If numeric timestamp
      const n = Number(d);
      if (!isNaN(n) && String(d).length >= 10) return new Date(n);
      // If string looks like Jalali (e.g. 1404/07/23)
      if (typeof d === 'string' && d.match(/^\s*(13|14|15)\d{2}[-\/]\d{1,2}[-\/]\d{1,2}\s*$/)) {
        // Prefer window.jalaliToISO or jalaliToISO global helper
        try {
          const jToIso = window.jalaliToISO || window.jalali_to_iso || window.jalali_to_gregorian;
          if (typeof window.jalaliToISO === 'function') {
            const iso = window.jalaliToISO(d);
            const dt = new Date(iso);
            if (!isNaN(dt)) return dt;
          }
          // fallback: if sync-hybrid exposed toISO that understands Jalali
          if (typeof window.syncHybrid === 'object' && typeof window.syncHybrid.toISO === 'function') {
            const iso = window.syncHybrid.toISO(d);
            if (iso) {
              const dt = new Date(iso);
              if (!isNaN(dt)) return dt;
            }
          }
        } catch (e) { /* continue to generic parse */ }
      }
      // If it's an ISO or other recognized string, try normal Date parsing
      const dt = new Date(d);
      if (!isNaN(dt)) return dt;
      return null;
    } catch (e) { return null; }
  }

  function daysBetween(a,b){
    const ms = 24*60*60*1000; return Math.ceil((b - a) / ms);
  }

  // Return today's date as a JS Date according to the app's Jalali helper if available
  function getTodayJsDate() {
    try {
      // prefer window.todayJalali()
      if (typeof window.todayJalali === 'function') {
        const tj = window.todayJalali();
        if (typeof window.jalaliToISO === 'function') {
          const iso = window.jalaliToISO(tj);
          const d = new Date(iso);
          if (!isNaN(d)) return d;
        }
        // fallback: if isoToJalali is present, maybe use it inversely
      }
      // fallback: if syncHybrid.toISO exists, use iso conversion of today
      if (typeof window.syncHybrid === 'object' && typeof window.syncHybrid.toISO === 'function') {
        const nowIso = new Date().toISOString();
        const d = new Date(nowIso);
        if (!isNaN(d)) return d;
      }
    } catch (e) { /* ignore */ }
    return new Date();
  }

  function findBirthdays(state, lookAheadDays=7) {
    const now = getTodayJsDate();
    const out = [];
    try {
      const players = (state && state.players) || [];
      players.forEach(p => {
        if (!p) return;
        // support fields: birthdate, dob
        const birthVal = p.birthdate || p.dob || p.birth || null;
        if (!birthVal) return;
        try {
          // If birthVal looks like Jalali 'YYYY/MM/DD'
          let parts = null;
          if (typeof birthVal === 'string' && birthVal.match(/^\s*(13|14|15)\d{2}[-\/]\d{1,2}[-\/]\d{1,2}\s*$/)) {
            parts = birthVal.split(/[-\/]\s*/).map(s => parseInt(s,10));
          } else if (typeof birthVal === 'string' && typeof window.isoToJalali === 'function') {
            // convert ISO -> Jalali parts
            try { const jal = window.isoToJalali(birthVal); if (jal) parts = jal.split('/').map(s=>parseInt(s,10)); } catch(e){}
          } else {
            // fallback: try to parse as Date and extract Gregorian month/day then convert via available helpers
            const dt = parseDate(birthVal);
            if (!dt) return;
            // If we have gregorian_to_jalali or isoToJalali, convert
            if (typeof window.gregorian_to_jalali === 'function') {
              const j = window.gregorian_to_jalali(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
              parts = [j[0], j[1], j[2]];
            } else if (typeof window.isoToJalali === 'function') {
              try { const jal = window.isoToJalali(dt.toISOString()); parts = jal.split('/').map(s=>parseInt(s,10)); } catch(e){}
            } else {
              // last resort: use gregorian values (less accurate for Jalali birthdays)
              parts = [dt.getFullYear(), dt.getMonth()+1, dt.getDate()];
            }
          }
          if (!parts || parts.length < 3) return;
          const m = parts[1], d = parts[2];
          // get today's Jalali year if possible
          let todayJ = null;
          try { if (typeof window.todayJalali === 'function') todayJ = window.todayJalali(); else if (typeof window.todayJalali === 'string') todayJ = window.todayJalali; } catch(e){}
          if (!todayJ && typeof window.isoToJalali === 'function') { try { todayJ = window.isoToJalali(getTodayJsDate().toISOString()); } catch(e){} }
          let todayYear = null;
          if (todayJ && typeof todayJ === 'string' && todayJ.match(/^\d{4}\/\d{2}\/\d{2}$/)) {
            todayYear = parseInt(todayJ.split('/')[0], 10);
          }
          if (!todayYear) {
            // fallback: derive from now (gregorian) by converting to jalali if possible
            try {
              if (typeof window.gregorian_to_jalali === 'function') {
                const g = [now.getFullYear(), now.getMonth()+1, now.getDate()];
                const jj = window.gregorian_to_jalali(g[0], g[1], g[2]); todayYear = jj[0];
              } else if (typeof window.isoToJalali === 'function') {
                const jj = window.isoToJalali(now.toISOString()); todayYear = parseInt(jj.split('/')[0],10);
              } else {
                todayYear = now.getFullYear();
              }
            } catch(e){ todayYear = now.getFullYear(); }
          }
          // build candidate Jalali date for this year
          const pad = s => String(s).padStart(2,'0');
          const candJ = `${todayYear}/${pad(m)}/${pad(d)}`;
          // convert candidate to ISO using jalaliToISO if available
          let candIso = null;
          try {
            if (typeof window.jalaliToISO === 'function') candIso = window.jalaliToISO(candJ);
            else if (typeof window.jalali_to_gregorian === 'function') {
              const g = window.jalali_to_gregorian(todayYear, m, d); if (Array.isArray(g) && g.length>=3) candIso = new Date(g[0], g[1]-1, g[2]).toISOString();
            }
          } catch(e){}
          let cDate = candIso ? new Date(candIso) : null;
          if (!cDate || isNaN(cDate.getTime())) {
            // fallback: use gregorian approximation
            try { cDate = new Date(now.getFullYear(), m-1, d); } catch(e){ return; }
          }
          // if candidate already passed, try next Jalali year
          if (cDate < now) {
            // try next Jalali year
            const nextJ = `${todayYear+1}/${pad(m)}/${pad(d)}`;
            try {
              if (typeof window.jalaliToISO === 'function') candIso = window.jalaliToISO(nextJ);
              else if (typeof window.jalali_to_gregorian === 'function') {
                const g = window.jalali_to_gregorian(todayYear+1, m, d); if (Array.isArray(g) && g.length>=3) candIso = new Date(g[0], g[1]-1, g[2]).toISOString();
              }
            } catch(e){}
            if (candIso) cDate = new Date(candIso); else cDate = new Date(now.getFullYear()+1, m-1, d);
          }
          const days = daysBetween(now, cDate);
          if (days <= lookAheadDays) out.push({type:'birthday', id:p.id || p.player_id || p.uid || p._id || p.email || JSON.stringify(p.name||p), days, player: p});
        } catch (e) { /* ignore per-player errors */ }
      });
    } catch (e) {}
    return out;
  }

  function findUpcomingEvents(state, lookAheadDays=14) {
    const now = getTodayJsDate();
    const out = [];
    const checkTable = (items, kind) => {
      if (!Array.isArray(items)) return;
      items.forEach(it => {
        if (!it) return;
        const dateStr = it.date || it.start || it.event_date || it.when || it.datetime;
        if (!dateStr) return;
        // parse date: prefer Jalali-aware parsing
        let dt = null;
        try {
          // if string looks like Jalali
          if (typeof dateStr === 'string' && dateStr.match(/^\s*(13|14|15)\d{2}[-\/]\d{1,2}[-\/]\d{1,2}\s*$/)) {
            if (typeof window.jalaliToISO === 'function') {
              const iso = window.jalaliToISO(dateStr);
              dt = new Date(iso);
            } else if (typeof window.syncHybrid === 'object' && typeof window.syncHybrid.toISO === 'function') {
              const iso = window.syncHybrid.toISO(dateStr);
              if (iso) dt = new Date(iso);
            }
          } else {
            dt = parseDate(dateStr);
          }
        } catch (e) { dt = parseDate(dateStr); }
        if (!dt) return;
        const days = daysBetween(now, dt);
        if (days >= 0 && days <= lookAheadDays) out.push({type:kind, id: it.id || it._id || it.uid || JSON.stringify(it), days, item: it, date: dt});
      });
    };
    checkTable((state && state.sessions) || [], 'session');
    checkTable((state && state.trainingPlans) || [], 'training');
    checkTable((state && state.competitions) || [], 'competition');
    return out;
  }

  function renderInPageNotice(title, body, meta={}){
    try {
      // For backward-compatibility, delegate to showLocalNotification which
      // persists into state but does not create floating toasts.
      showLocalNotification(title, body, meta && meta.type ? meta.type : null);
    } catch (e) { console.warn('renderInPageNotice failed', e); }
  }

  function notifyBrowser(title, body, opts={}){
    try {
      // Only show browser notification if permission is already granted.
      if (window.Notification && Notification.permission === 'granted') {
        new Notification(title, { body });
        return true;
      }
    } catch (e) {}
    return false;
  }

  // Persist notification to state and optionally show browser notification (no toasts)
  function showLocalNotification(title, body, type){
    try {
      // Try browser notification only if permission already granted
      const shown = (window.Notification && Notification.permission === 'granted') ? (function(){ try{ new Notification(title, { body }); return true; } catch(e){ return false; } })() : false;

      // Persist into state.notifications (no on-page toast creation)
      try {
        if (!window.state) window.state = {};
        if (!Array.isArray(window.state.notifications)) window.state.notifications = [];
        const nid = 'n_' + Date.now() + '_' + Math.floor(Math.random()*10000);
        const noteObj = { id: nid, title: title, body: body, ts: Date.now(), read: false, type: type };
        // unshift so newest appear first
        window.state.notifications.unshift(noteObj);
        // persist if saveState exists
        try { if (typeof window.saveState === 'function') window.saveState(); } catch(e){}
        // update any badge UI helper if present
        try { if (typeof window.updateNotificationsBadge === 'function') window.updateNotificationsBadge(); else if (typeof updateNotificationsBadge === 'function') updateNotificationsBadge(); } catch(e){}
        // animate badge elements
        try {
          Array.from(document.querySelectorAll('.notifications-badge')).forEach(b => {
            b.classList.add('badge-pop');
            setTimeout(() => b.classList.remove('badge-pop'), 700);
          });
        } catch(e){}
        // re-render notifications list if visible
        try { if (typeof renderNotificationsList === 'function') renderNotificationsList(); } catch(e){}
      } catch(e){ console.warn('persisting notification to state failed', e); }

      return shown;
    } catch (e) { console.warn('showLocalNotification failed', e); return false; }
  }

  function makeMessageFor(ev){
    if (!ev) return null;
    if (ev.type === 'birthday') {
      const name = (ev.player && (ev.player.name || ev.player.full_name || ev.player.player_name)) || 'یک بازیکن';
      const days = ev.days;
      if (days === 0) return { title: 'تولد امروز', body: `${name} امروز تولد دارد.` };
      return { title: 'تولد نزدیک', body: `${name} در ${days} روز تولد دارد.` };
    }
    if (ev.type === 'session' || ev.type === 'training' || ev.type === 'competition'){
      const kind = ev.type === 'session' ? 'جلسه' : (ev.type === 'training' ? 'تمرین' : 'مسابقه');
      const name = (ev.item && (ev.item.title || ev.item.name || ev.item.teamA || ev.item.description)) || kind;
      const days = ev.days;
      if (days === 0) return { title: `${kind} امروز`, body: `${name} امروز برنامه دارد.` };
      return { title: `${kind} نزدیک`, body: `${name} در ${days} روز برنامه دارد.` };
    }
    return null;
  }

  function runCheck(opts={}){
    try {
      const state = getAppState();
      const b = findBirthdays(state, opts.bDays || 7);
      const e = findUpcomingEvents(state, opts.eDays || 14);
      const combined = (b||[]).concat(e||[]).sort((a,b)=>a.days - b.days).slice(0,6);
      combined.forEach(ev => {
        const key = `${ev.type}::${ev.id}::${ev.days}`;
        if (lastNotified[key]) return; // already notified this session
          const msg = makeMessageFor(ev);
          if (!msg) return;
          // prefer unified showLocalNotification which will attempt browser notification
          // only if permission is already granted, otherwise create an in-page card
          try {
            showLocalNotification(msg.title, msg.body, ev.type);
          } catch (e) {
            // fallback
            try { renderInPageNotice(msg.title, msg.body, ev); } catch (e){}
          }
          lastNotified[key] = Date.now();
      });
    } catch (e) { console.warn('notifications check failed', e); }
  }

  function initNotifications(opts={intervalMs: CHECK_INTERVAL_MS}){
    try {
      // run once now
      // Ensure container for notificationsList exists (per requirement)
      try {
        // ensure the app's notifications view/content exist and use the canonical
        // #notificationsContent container which is declared in index.html
        let view = document.getElementById('view-notifications');
        if (!view) {
          view = document.createElement('section');
          view.id = 'view-notifications';
          document.body.insertBefore(view, document.body.firstChild);
        }
        if (!document.getElementById('notificationsContent')) {
          // If the page already has an older container (#notificationsList), prefer reusing it
          let content = document.getElementById('notificationsList');
          if (content) {
            content.id = 'notificationsContent';
          } else {
            content = document.createElement('div');
            content.id = 'notificationsContent';
          }
          // Make the notifications drawer scrollable and visually consistent
          content.style.cssText = 'padding:12px;display:flex;flex-direction:column;gap:8px;max-height:60vh;overflow-y:auto;scrollbar-width:thin;padding-bottom:64px;';
          // Add container for action buttons (Close all) at bottom-left
          const actions = document.createElement('div');
          actions.id = 'notificationsActions';
          actions.style.cssText = 'display:flex;justify-content:flex-start;gap:8px;padding:12px 0 0 0;margin-top:12px;border-top:1px solid rgba(0,0,0,0.06);';
          const closeAll = document.createElement('button');
          closeAll.id = 'notificationsCloseAll';
          closeAll.className = 'btn';
          closeAll.textContent = 'بستن همه اعلان‌ها';
          closeAll.style.cssText = 'min-width:auto;padding:8px 12px;border-radius:10px;font-size:0.9em;';
          closeAll.addEventListener('click', () => {
            try {
              if (!window.state) window.state = {};
              window.state.notifications = [];
              try { if (typeof window.saveState === 'function') window.saveState(); } catch(e){}
              renderNotificationsList();
              try { if (typeof window.updateNotificationsBadge === 'function') window.updateNotificationsBadge(); } catch(e){}
            } catch (e) { console.warn('close all notifications failed', e); }
          });
          actions.appendChild(closeAll);
          view.appendChild(content);
          view.appendChild(actions);
        }
      } catch(e) { /* ignore */ }
      // cleanup notifications older than 7 days
      try {
        if (window.state && Array.isArray(window.state.notifications)) {
          const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
          window.state.notifications = window.state.notifications.filter(n => (n && n.ts && n.ts >= cutoff) || !n.ts);
          try { if (typeof window.saveState === 'function') window.saveState(); } catch(e){}
        }
      } catch(e){}
      runCheck(opts);
      // clear previous
      if (intervalId) clearInterval(intervalId);
      intervalId = setInterval(()=> runCheck(opts), opts.intervalMs || CHECK_INTERVAL_MS);
      window.notifyNow = function() { runCheck(opts); };
      console.info('notifications initialized');
    } catch (e) { console.warn('initNotifications failed', e); }
  }

  // expose
  // helpers for new UI
  function getTypeLabel(type) {
    const labels = { birthday: 'تولد', session: 'جلسه تمرینی', match: 'مسابقه', training: 'تمرین', competition: 'مسابقه', general: 'عمومی' };
    return labels[type] || 'اعلان';
  }

  function formatRelativeTime(timestamp) {
    try {
      const now = Date.now();
      const diff = Math.floor((now - (timestamp || 0)) / 1000);
      if (diff < 60) return 'همین الان';
      if (diff < 3600) return `${Math.floor(diff/60)} دقیقه پیش`;
      if (diff < 86400) return `${Math.floor(diff/3600)} ساعت پیش`;
      if (diff < 172800) return 'دیروز';
      return `${Math.floor(diff/86400)} روز پیش`;
    } catch(e) { return '' + timestamp; }
  }

  function closeNotification(id) {
    try {
      const card = document.querySelector(`.notification-card[data-id="${id}"]`);
      if (card) {
        card.style.opacity = '0';
        card.style.transform = 'translateX(-20px)';
        card.style.transition = 'all 0.3s ease';
      }
      setTimeout(() => {
        try {
          if (!window.state) window.state = {};
          window.state.notifications = (window.state.notifications||[]).filter(n => n.id !== id);
          try { if (typeof window.saveState === 'function') window.saveState(); } catch(e){}
          renderNotificationsList();
          try { if (typeof window.updateNotificationsBadge === 'function') window.updateNotificationsBadge(); } catch(e){}
        } catch(e) { console.warn('closeNotification error', e); }
      }, 320);
    } catch(e) { console.warn('closeNotification failed', e); }
  }

  // helper to render the in-app notifications list inside #notificationsContent
  function renderNotificationsList(){
    try {
      const container = document.getElementById('notificationsContent');
      if (!container) return;

      // cleanup older than 7 days
      const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
      try { if (window.state && Array.isArray(window.state.notifications)) { window.state.notifications = window.state.notifications.filter(n => (n && n.ts && n.ts > oneWeekAgo)); if (typeof window.saveState === 'function') window.saveState(); } } catch(e){}

      const notes = (window.state && Array.isArray(window.state.notifications)) ? window.state.notifications.slice() : [];
      const unread = notes.filter(n => !n.read);
      const sorted = [...unread, ...notes.filter(n => n.read)];
      // If there are no notifications, show an explicit empty state
      if (!notes || notes.length === 0) {
        container.innerHTML = `
          <div class="notifications-header">
            <h3>اعلان‌ها <span class="badge">0</span></h3>
          </div>
          <div style="text-align:center;padding:40px 20px;color:#999;font-size:16px;background:#fafafa;border-radius:12px;margin:12px;box-shadow:0 1px 4px rgba(0,0,0,0.05);">
            <i class="fa-solid fa-bell-slash" style="font-size:32px;margin-bottom:12px;display:block;color:#ccc;"></i>
            <div>اعلانی موجود نیست</div>
            <div style="font-size:13px;margin-top:8px;color:#777;">وقتی اعلان جدیدی بیاد، اینجا نمایش داده می‌شه</div>
          </div>
        `;
        try { if (typeof window.updateNotificationsBadge === 'function') window.updateNotificationsBadge(); } catch(e){}
        return;
      }

      container.innerHTML = `
        <div class="notifications-header">
          <h3>اعلان‌ها <span class="badge">${unread.length}</span></h3>
          <div class="notif-actions">
            <button id="notificationsCloseAll"><i class="fa-solid fa-trash"></i> حذف همه</button>
            <select id="notifFilter"><option value="all">همه</option><option value="unread">خوانده‌نشده</option></select>
          </div>
        </div>
        <div id="notificationsList"></div>
      `;

      const list = container.querySelector('#notificationsList');
      if (!list) return;

      sorted.forEach(notif => {
        try {
          const iconMap = { birthday: 'fa-cake-candles', session: 'fa-dumbbell', match: 'fa-trophy', training: 'fa-dumbbell', competition: 'fa-flag', general: 'fa-bell' };
          const icon = iconMap[notif.type] || 'fa-bell';
          const time = formatRelativeTime(notif.ts || Date.now());

          const card = document.createElement('div');
          card.className = 'notification-card';
          card.setAttribute('data-id', notif.id);
          card.setAttribute('data-type', notif.type || 'general');

          card.innerHTML = `
            <div class="notif-icon"><i class="fa-solid ${icon}"></i></div>
            <div class="notif-content">
              <div class="notif-title">${escapeHtml ? escapeHtml(notif.title||'') : (notif.title||'')}</div>
              <div class="notif-body">${escapeHtml ? escapeHtml(notif.body||'') : (notif.body||'')}</div>
              <div class="notif-meta"><span>${getTypeLabel(notif.type)}</span><span>${time}</span></div>
            </div>
            <button class="notif-close" aria-label="بستن اعلان">&times;</button>
          `;

          list.appendChild(card);

          const closeBtn = card.querySelector('.notif-close');
          if (closeBtn) closeBtn.addEventListener('click', () => closeNotification(notif.id));

        } catch(e) { console.warn('renderNotificationsList: single notification failed', e); }
      });

      // wire up Close All
      const closeAll = container.querySelector('#notificationsCloseAll');
      if (closeAll) closeAll.addEventListener('click', () => {
        try { if (!window.state) window.state = {}; window.state.notifications = []; if (typeof window.saveState === 'function') window.saveState(); renderNotificationsList(); updateNotificationsBadge(); } catch(e) { console.warn('closeAll failed', e); }
      });

      // filter
      const filter = container.querySelector('#notifFilter');
      if (filter) filter.addEventListener('change', (e) => {
        try {
          const v = e.target.value;
          if (v === 'all') renderNotificationsList();
          else if (v === 'unread') {
            const only = (window.state && Array.isArray(window.state.notifications)) ? window.state.notifications.filter(n => !n.read) : [];
            const prev = container.querySelector('#notificationsList');
            if (prev) prev.innerHTML = '';
            only.forEach(notif => {
              const card = document.createElement('div');
              card.className = 'notification-card';
              card.setAttribute('data-id', notif.id);
              card.setAttribute('data-type', notif.type || 'general');
              card.innerHTML = `<div class="notif-icon"><i class="fa-solid ${iconMap[notif.type]||'fa-bell'}"></i></div><div class="notif-content"><div class="notif-title">${escapeHtml?escapeHtml(notif.title||''):notif.title||''}</div><div class="notif-body">${escapeHtml?escapeHtml(notif.body||''):notif.body||''}</div><div class="notif-meta"><span>${getTypeLabel(notif.type)}</span><span>${formatRelativeTime(notif.ts)}</span></div></div><button class="notif-close" aria-label="بستن اعلان">&times;</button>`;
              prev.appendChild(card);
              const closeBtn = card.querySelector('.notif-close'); if (closeBtn) closeBtn.addEventListener('click', () => closeNotification(notif.id));
            });
          }
        } catch(e) { console.warn('filter change failed', e); }
      });

      try { if (typeof window.updateNotificationsBadge === 'function') window.updateNotificationsBadge(); } catch(e){}

    } catch (e) { console.warn('renderNotificationsList failed', e); }
  }

  // helper to update badge count (used by app buttons)
  window.updateNotificationsBadge = function(){
    try {
      const count = (window.state && Array.isArray(window.state.notifications)) ? window.state.notifications.length : 0;
      Array.from(document.querySelectorAll('.notifications-badge')).forEach(b => {
        try {
          if (count <= 0) { b.style.display = 'none'; b.textContent = ''; }
          else { b.style.display = 'inline-block'; b.textContent = String(count); }
        } catch(e){}
      });
    } catch(e) { console.warn('updateNotificationsBadge failed', e); }
  };

  // attempt to render on load if notifications exist
  try { renderNotificationsList(); } catch(e){}

  // Prevent multiple initializations
  let notificationsInitialized = false;
  window.initNotifications = function(opts) {
    try {
      if (notificationsInitialized) {
        console.log('initNotifications: قبلاً اجرا شده — رد شد');
        return;
      }
      notificationsInitialized = true;
      console.log('initNotifications: اولین اجرا');
      return initNotifications(opts);
    } catch (e) {
      console.warn('initNotifications wrapper failed', e);
    }
  };
  window.notifyNow = window.notifyNow || function(){ runCheck(); };
  // expose helpers for console testing
  window.showLocalNotification = showLocalNotification;
  window.renderInPageNotice = renderInPageNotice;
  // --- Swipe to dismiss handlers ---
  (function(){
    let swipeStartX = 0;
    let currentSwipeCard = null;
    const SWIPE_THRESHOLD = 80;

    function findCardFromEvent(e) {
      try {
        const t = e.target;
        return t && t.closest ? t.closest('.notification-card') : null;
      } catch(e) { return null; }
    }

    function handleTouchStart(e) {
      try {
        const card = findCardFromEvent(e);
        if (!card) return;
        const touch = (e.touches && e.touches[0]);
        if (!touch) return;
        swipeStartX = touch.clientX;
        currentSwipeCard = card;
        currentSwipeCard.style.transition = 'none';
      } catch(e) {}
    }

    function handleTouchMove(e) {
      try {
        if (!currentSwipeCard) return;
        const touch = (e.touches && e.touches[0]);
        if (!touch) return;
        const currentX = touch.clientX;
        const diffX = currentX - swipeStartX;
        if (Math.abs(diffX) > 10) {
          e.preventDefault();
          currentSwipeCard.style.transform = `translateX(${diffX}px)`;
          currentSwipeCard.style.opacity = String(Math.max(0.35, 1 - Math.abs(diffX) / 300));
          // add direction class
          if (diffX > 0) {
            currentSwipeCard.classList.add('swiping-right');
            currentSwipeCard.classList.remove('swiping-left');
          } else {
            currentSwipeCard.classList.add('swiping-left');
            currentSwipeCard.classList.remove('swiping-right');
          }
        }
      } catch(e) {}
    }

    function handleTouchEnd(e) {
      try {
        if (!currentSwipeCard) return;
        const touch = (e.changedTouches && e.changedTouches[0]);
        const endX = touch ? touch.clientX : null;
        const diffX = (endX !== null) ? (endX - swipeStartX) : 0;
        // if sufficient swipe, dismiss
        if (Math.abs(diffX) > SWIPE_THRESHOLD) {
          const dir = diffX > 0 ? 1 : -1;
          currentSwipeCard.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
          currentSwipeCard.style.transform = `translateX(${dir * 120}%)`;
          currentSwipeCard.style.opacity = '0';
          const id = currentSwipeCard.getAttribute('data-id');
          // after animation, remove from state via closeNotification
          setTimeout(() => {
            try { if (id) closeNotification(id); }
            catch(e) { try { closeNotification(id); } catch(_){} }
          }, 300);
        } else {
          // restore
          currentSwipeCard.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
          currentSwipeCard.style.transform = '';
          currentSwipeCard.style.opacity = '';
          currentSwipeCard.classList.remove('swiping-left','swiping-right');
        }
      } catch(e) {}
      currentSwipeCard = null;
    }

    // Attach listeners to document (delegation). Use passive:false where we call preventDefault.
    try {
      document.addEventListener('touchstart', handleTouchStart, { passive: true });
      document.addEventListener('touchmove', handleTouchMove, { passive: false });
      document.addEventListener('touchend', handleTouchEnd, { passive: true });
    } catch(e) {
      // older browsers fallback
      try { document.addEventListener('touchstart', handleTouchStart); document.addEventListener('touchmove', handleTouchMove); document.addEventListener('touchend', handleTouchEnd); } catch(_) {}
    }
  })();
})();
