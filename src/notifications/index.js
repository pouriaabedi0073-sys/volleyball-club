// src/notifications/index.js
// ES module version of notifications.js
// Exports: initNotifications, notifyNow, showLocalNotification, renderInPageNotice
const DEFAULT_KEY = (typeof window !== 'undefined' && window.STORAGE_KEY) ? window.STORAGE_KEY : 'vb_dashboard_v8';
let lastNotified = {}; // map to avoid duplicates during session
let intervalId = null;
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

function getAppState() {
  try {
    if (typeof window !== 'undefined' && typeof window.state !== 'undefined') return window.state;
    const raw = localStorage.getItem(DEFAULT_KEY);
    if (!raw) return {};
    return JSON.parse(raw || '{}');
  } catch (e) { return {}; }
}

function parseDate(d) {
  if (!d) return null;
  try {
    if (d instanceof Date) return isNaN(d.getTime()) ? null : d;
    const n = Number(d);
    if (!isNaN(n) && String(d).length >= 10) return new Date(n);
    if (typeof d === 'string' && d.match(/^\s*(13|14|15)\d{2}[-\/]\d{1,2}[-\/]\d{1,2}\s*$/)) {
      try {
        if (typeof window.jalaliToISO === 'function') {
          const iso = window.jalaliToISO(d);
          const dt = new Date(iso);
          if (!isNaN(dt)) return dt;
        }
        if (typeof window.syncHybrid === 'object' && typeof window.syncHybrid.toISO === 'function') {
          const iso = window.syncHybrid.toISO(d);
          if (iso) {
            const dt = new Date(iso);
            if (!isNaN(dt)) return dt;
          }
        }
      } catch (e) { /* continue to generic parse */ }
    }
    const dt = new Date(d);
    if (!isNaN(dt)) return dt;
    return null;
  } catch (e) { return null; }
}

function daysBetween(a,b){
  const ms = 24*60*60*1000; return Math.ceil((b - a) / ms);
}

function getTodayJsDate() {
  try {
    if (typeof window.todayJalali === 'function') {
      const tj = window.todayJalali();
      if (typeof window.jalaliToISO === 'function') {
        const iso = window.jalaliToISO(tj);
        const d = new Date(iso);
        if (!isNaN(d)) return d;
      }
    }
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
      const birthVal = p.birthdate || p.dob || p.birth || null;
      if (!birthVal) return;
      try {
        let parts = null;
        if (typeof birthVal === 'string' && birthVal.match(/^\s*(13|14|15)\d{2}[-\/]\d{1,2}[-\/]\d{1,2}\s*$/)) {
          parts = birthVal.split(/[-\/]\s*/).map(s => parseInt(s,10));
        } else if (typeof birthVal === 'string' && typeof window.isoToJalali === 'function') {
          try { const jal = window.isoToJalali(birthVal); if (jal) parts = jal.split('/').map(s=>parseInt(s,10)); } catch(e){}
        } else {
          const dt = parseDate(birthVal);
          if (!dt) return;
          if (typeof window.gregorian_to_jalali === 'function') {
            const j = window.gregorian_to_jalali(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
            parts = [j[0], j[1], j[2]];
          } else if (typeof window.isoToJalali === 'function') {
            try { const jal = window.isoToJalali(dt.toISOString()); parts = jal.split('/').map(s=>parseInt(s,10)); } catch(e){}
          } else {
            parts = [dt.getFullYear(), dt.getMonth()+1, dt.getDate()];
          }
        }
        if (!parts || parts.length < 3) return;
        const m = parts[1], d = parts[2];
        let todayJ = null;
        try { if (typeof window.todayJalali === 'function') todayJ = window.todayJalali(); else if (typeof window.todayJalali === 'string') todayJ = window.todayJalali; } catch(e){}
        if (!todayJ && typeof window.isoToJalali === 'function') { try { todayJ = window.isoToJalali(getTodayJsDate().toISOString()); } catch(e){} }
        let todayYear = null;
        if (todayJ && typeof todayJ === 'string' && todayJ.match(/^\d{4}\/\d{2}\/\d{2}$/)) {
          todayYear = parseInt(todayJ.split('/')[0], 10);
        }
        if (!todayYear) {
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
        const pad = s => String(s).padStart(2,'0');
        const candJ = `${todayYear}/${pad(m)}/${pad(d)}`;
        let candIso = null;
        try {
          if (typeof window.jalaliToISO === 'function') candIso = window.jalaliToISO(candJ);
          else if (typeof window.jalali_to_gregorian === 'function') {
            const g = window.jalali_to_gregorian(todayYear, m, d); if (Array.isArray(g) && g.length>=3) candIso = new Date(g[0], g[1]-1, g[2]).toISOString();
          }
        } catch(e){}
        let cDate = candIso ? new Date(candIso) : null;
        if (!cDate || isNaN(cDate.getTime())) {
          try { cDate = new Date(now.getFullYear(), m-1, d); } catch(e){ return; }
        }
        if (cDate < now) {
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
      let dt = null;
      try {
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
    showLocalNotification(title, body, meta && meta.type ? meta.type : null);
  } catch (e) { console.warn('renderInPageNotice failed', e); }
}

function notifyBrowser(title, body, opts={}){
  try {
    if (window.Notification && Notification.permission === 'granted') {
      new Notification(title, { body });
      return true;
    }
  } catch (e) {}
  return false;
}

function showLocalNotification(title, body, type){
  try {
    const shown = (window.Notification && Notification.permission === 'granted') ? (function(){ try{ new Notification(title, { body }); return true; } catch(e){ return false; } })() : false;
    try {
      if (!window.state) window.state = {};
      if (!Array.isArray(window.state.notifications)) window.state.notifications = [];
      const nid = 'n_' + Date.now() + '_' + Math.floor(Math.random()*10000);
      const noteObj = { id: nid, title: title, body: body, ts: Date.now(), read: false, type: type };
      window.state.notifications.unshift(noteObj);
      try { if (typeof window.saveState === 'function') window.saveState(); } catch(e){}
      try { if (typeof window.updateNotificationsBadge === 'function') window.updateNotificationsBadge(); else if (typeof updateNotificationsBadge === 'function') updateNotificationsBadge(); } catch(e){}
      try {
        Array.from(document.querySelectorAll('.notifications-badge')).forEach(b => { b.classList.add('badge-pop'); setTimeout(() => b.classList.remove('badge-pop'), 700); });
      } catch(e){}
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
    const st = getAppState();
    const b = findBirthdays(st, opts.bDays || 7);
    const e = findUpcomingEvents(st, opts.eDays || 14);
    const combined = (b||[]).concat(e||[]).sort((a,b)=>a.days - b.days).slice(0,6);
    combined.forEach(ev => {
      const key = `${ev.type}::${ev.id}::${ev.days}`;
      if (lastNotified[key]) return;
      const msg = makeMessageFor(ev);
      if (!msg) return;
      try { showLocalNotification(msg.title, msg.body, ev.type); } catch (e) { try { renderInPageNotice(msg.title, msg.body, ev); } catch (e){} }
      lastNotified[key] = Date.now();
    });
  } catch (e) { console.warn('notifications check failed', e); }
}

function initNotifications(opts={intervalMs: CHECK_INTERVAL_MS}){
  try {
    try {
      let view = document.getElementById('view-notifications');
      if (!view) {
        view = document.createElement('section');
        view.id = 'view-notifications';
        document.body.insertBefore(view, document.body.firstChild);
      }
      if (!document.getElementById('notificationsList')) {
        const list = document.createElement('div'); list.id = 'notificationsList'; list.style = 'display:flex;flex-direction:column;gap:8px;padding:12px;'; view.appendChild(list);
      }
    } catch(e) { /* ignore */ }
    try {
      if (window.state && Array.isArray(window.state.notifications)) {
        const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
        window.state.notifications = window.state.notifications.filter(n => (n && n.ts && n.ts >= cutoff) || !n.ts);
        try { if (typeof window.saveState === 'function') window.saveState(); } catch(e){}
      }
    } catch(e){}
    runCheck(opts);
    if (intervalId) clearInterval(intervalId);
    intervalId = setInterval(()=> runCheck(opts), opts.intervalMs || CHECK_INTERVAL_MS);
    return true;
  } catch (e) { console.warn('initNotifications failed', e); return false; }
}

function notifyNow(){ runCheck(); }

export { initNotifications, notifyNow, showLocalNotification, renderInPageNotice };
