/*
  sync-hybrid.js
  New hybrid synchronization for the PWA.
  - Real-time via Supabase Realtime
  - Daily/manual JSON backups to Supabase Storage (bucket: backups)
  - Exposes window.syncHybrid with per-entity APIs
  - Conflict resolution: last_modified (ISO) wins
*/
(function () {
  const _log = (...a) => { try { console.debug('[sync-hybrid]', ...a); } catch(_) {} };

  // Migrate old device id key if present so UI and backups always have device_id
  try {
    if (typeof localStorage !== 'undefined' && !localStorage.getItem('device_id') && localStorage.getItem('vb_device_id_v1')) {
      try { localStorage.setItem('device_id', localStorage.getItem('vb_device_id_v1')); _log('Migrated vb_device_id_v1 -> device_id'); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }

  // Hybrid sync status and persistent queue
  const STATUS_KEY = 'syncHybridQueue';
  const DEADLETTER_OPS_KEY = 'syncHybrid:deadLetterOps';
  const DEADLETTER_BACKUPS_KEY = 'syncHybrid:deadLetterBackups';
  const PENDING_BACKUPS_KEY = 'syncHybrid:pendingBackups';
  const LAST_BACKUP_KEY = 'syncHybrid:lastBackup';
  const MAX_OP_ATTEMPTS = 5; // total attempts before dead-letter
  const BASE_BACKOFF_MS = 2000; // initial backoff (ms)
  const status = { online: (typeof navigator !== 'undefined') ? !!navigator.onLine : true, syncing: false, lastError: null };
  // registry of active realtime channels (table -> channel)
  const CHANNEL_REGISTRY = {};
  // simple localStorage-based lock key to avoid concurrent flushes across tabs
const FLUSH_LOCK_KEY = 'syncHybrid:flushLock';

function setStatus(patch) {
    Object.assign(status, patch || {});
    try { window.syncHybrid = window.syncHybrid || {}; window.syncHybrid.status = Object.assign({}, status); } catch(_){}
    try { window.dispatchEvent(new CustomEvent('syncHybrid:status', { detail: Object.assign({}, status) })); } catch(_){}
  }

  function loadQueue() {
    try { const raw = localStorage.getItem(STATUS_KEY); return raw ? JSON.parse(raw) : []; } catch(e) { return []; }
  }
  function saveQueue(q) { try { localStorage.setItem(STATUS_KEY, JSON.stringify(q || [])); } catch(e){} }
  function enqueueOp(op) {
    // ensure op has id and timestamp for tracing
    try { op.id = op.id || uid(); op.ts = new Date().toISOString(); } catch(_) {}
    try { op.attempts = op.attempts || 0; } catch(_) {}
    const q = loadQueue(); q.push(op); saveQueue(q);
    try { window.dispatchEvent(new CustomEvent('syncHybrid:queue', { detail: { op, queueLength: q.length } })); } catch(_){}
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function getDeadLetterOps() { try { const raw = localStorage.getItem(DEADLETTER_OPS_KEY); return raw ? JSON.parse(raw) : []; } catch(e) { return []; } }
  function saveDeadLetterOps(arr) { try { localStorage.setItem(DEADLETTER_OPS_KEY, JSON.stringify(arr || [])); } catch(e){} }
  function moveOpToDeadLetter(op, err) {
    try {
      const arr = getDeadLetterOps();
      arr.push(Object.assign({}, op, { dead_at: new Date().toISOString(), error: (err && err.message) ? err.message : String(err) }));
      saveDeadLetterOps(arr);
      try { window.dispatchEvent(new CustomEvent('syncHybrid:deadLetter', { detail: { type: 'op', op } })); } catch(_){ }
    } catch(e) { _log('moveOpToDeadLetter failed', e); }
  }

  // simple lock helpers for flushQueue to avoid multiple tabs flushing simultaneously
  function acquireFlushLock(timeoutMs = 10000) {
    try {
      const now = Date.now();
      const raw = localStorage.getItem(FLUSH_LOCK_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && (now - obj.ts) < timeoutMs) return false; // lock active
      }
      localStorage.setItem(FLUSH_LOCK_KEY, JSON.stringify({ owner: uid(), ts: now }));
      return true;
    } catch (e) { return true; }
  }
  function releaseFlushLock() { try { localStorage.removeItem(FLUSH_LOCK_KEY); } catch(e){} }

  async function flushQueue(client) {
    // process head until queue empty (re-load each time to be resilient to concurrent enqueues)
    let q = loadQueue();
    if (!q || !q.length) return true;
    if (!acquireFlushLock(15000)) {
      _log('flushQueue: another tab/process is flushing, aborting this flush');
      return false;
    }
    setStatus({ syncing: true, lastError: null });
    try {
      while (true) {
        q = loadQueue();
        if (!q || q.length === 0) break;
        const op = q[0];
        try {
          if (!client) client = await waitForClient();
          // Try operation
          if (op.type === 'create') {
            await client.from(op.table).insert([op.row]);
          } else if (op.type === 'update') {
            // Prefer upsert for updates to avoid missing WHERE issues and to support onConflict keys
            try {
              const onConflict = getConflictKey(op.table).join(',');
              const payload = Object.assign({}, op.patch, { id: op.id });
              await client.from(op.table).upsert([payload], { onConflict }).select();
            } catch (e) {
              // fallback to classic update with WHERE
              await client.from(op.table).update(op.patch).eq('id', op.id);
            }
          } else if (op.type === 'delete') {
            await client.from(op.table).delete().eq('id', op.id);
          }
          // pop processed
          q = loadQueue(); q.shift(); saveQueue(q);
          try { window.dispatchEvent(new CustomEvent('syncHybrid:flush', { detail: { success: true, op } })); } catch(_){ }
        } catch (e) {
          // Retry/backoff logic per-op
          try {
            op.attempts = (op.attempts || 0) + 1;
            // Special-case: if error is a 400 Bad Request with possible transient payload issue,
            // attempt a couple of quick retries before moving to exponential backoff.
            const statusCode = (e && (e.status || e.statusCode || (e.response && e.response.status))) ? (e.status || e.statusCode || e.response.status) : null;
            if (statusCode === 400 && (op._quick400retries || 0) < 2) {
              op._quick400retries = (op._quick400retries || 0) + 1;
              _log('flushQueue: quick retry for 400 error', op.id, 'retry', op._quick400retries);
              q = loadQueue(); if (q && q.length) { q[0] = op; saveQueue(q); }
              await sleep(1000 * op._quick400retries);
              continue; // retry immediately
            }
            // update queue with new attempts
            q = loadQueue(); if (q && q.length) { q[0] = op; saveQueue(q); }
            if (op.attempts < MAX_OP_ATTEMPTS) {
              const backoff = BASE_BACKOFF_MS * Math.pow(2, Math.max(0, op.attempts - 1));
              const jitter = Math.floor(Math.random() * 500);
              _log('flushQueue: op failed, will retry', op.id, 'attempt', op.attempts, 'backoff', backoff + jitter);
              await sleep(backoff + jitter);
              // continue loop to retry same head op
              continue;
            } else {
              _log('flushQueue: op exceeded attempts, moving to dead-letter', op.id);
              // remove head and move to dead-letter
              q = loadQueue(); q.shift(); saveQueue(q);
              moveOpToDeadLetter(op, e);
              try { window.dispatchEvent(new CustomEvent('syncHybrid:flush', { detail: { success: false, op, error: e, deadLetter: true } })); } catch(_){ }
              // continue to next op
              continue;
            }
          } catch (innerErr) {
            _log('flushQueue retry handling failed', innerErr);
            setStatus({ lastError: (innerErr && innerErr.message) ? innerErr.message : String(innerErr), syncing: false });
            releaseFlushLock();
            return false;
          }
        }
      }
    } finally {
      setStatus({ syncing: false });
      releaseFlushLock();
    }
    return true;
  }

const TABLES = {
  players: 'players',
  coaches: 'coaches',
  sessions: 'sessions',
  payments: 'payments',
  competitions: 'competitions',
  training_plans: 'training_plans',
  shared_backups: 'shared_backups'
};

// Ensure we have the correct channel configs for realtime sync
const REALTIME_CONFIGS = {
  players: { event: '*', schema: 'public' },
  coaches: { event: '*', schema: 'public' },
  sessions: { event: '*', schema: 'public' },
  payments: { event: '*', schema: 'public' },
  competitions: { event: '*', schema: 'public' },
  training_plans: { event: '*', schema: 'public' },
  shared_backups: { event: '*', schema: 'public' }
};  async function waitForClient(timeout = 10000) {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      (function check() {
        try {
          const cands = [window.supabase, window.supabaseClient, window._supabase, window.__supabase];
          for (const c of cands) {
            if (!c) continue;
            // only accept a client instance that exposes auth.getUser
            if (c.auth && typeof c.auth.getUser === 'function') return resolve(c);
          }
        } catch (e) { }
        if (Date.now() - t0 > timeout) return reject(new Error('Supabase client not available'));
        setTimeout(check, 200);
      })();
    });
  }

  // helper: some tables don't include user_id (eg shared_backups)
  function tableHasUserId(tableName) {
    if (!tableName) return false;
    const noUser = ['shared_backups'];
    return noUser.indexOf(tableName) === -1;
  }

  // Helper: return an array of conflict key columns for upsert per table
  function getConflictKey(table) {
    switch (table) {
      case 'devices': return ['user_id', 'device_id'];
      case 'sessions': return ['id'];
      case 'payments': return ['id'];
      case 'coaches': return ['user_id'];
      case 'shared_backups': return ['group_email'];
      case 'profiles': return ['id'];
      default: return ['id'];
    }
  }

  // Module-scoped cache for resolved group email
  let CURRENT_GROUP_EMAIL = null;

  /**
   * ensureStateLoaded
   * اگر window.state خالی باشد، تلاش می‌کند از localStorage مقداردهی کند.
   * امن و idempotent: چندبار اجرا کردن اشکالی ایجاد نمی‌کند.
   */
  function ensureStateLoaded() {
    try {
      if (!window.state || Object.keys(window.state).length === 0) {
        // prefer the project's specific key, but fall back to common names for future-proofing
        const possible = (typeof STORAGE_KEY !== 'undefined') ? [STORAGE_KEY, 'vb_dashboard_v8', 'appState', 'state'] : ['vb_dashboard_v8', 'appState', 'state'];
        let keyFound = null;
        for (const k of possible) {
          try {
            if (localStorage.getItem(k)) { keyFound = k; break; }
          } catch (_) { /* ignore access errors */ }
        }
        if (!keyFound) {
          if (typeof _log === 'function') _log('[ensureStateLoaded] no known state key found in localStorage');
          else console.log('[ensureStateLoaded] no known state key found in localStorage');
          return;
        }
        const raw = localStorage.getItem(keyFound);
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed && Object.keys(parsed).length > 0) {
          window.state = parsed;
          if (typeof _log === 'function') _log('[ensureStateLoaded] restored from', keyFound);
          else console.log('[ensureStateLoaded] restored from', keyFound);
        }
      }
    } catch (err) {
      if (typeof _log === 'function') _log('[ensureStateLoaded] failed to load state', err);
      else console.warn('[ensureStateLoaded] failed to load state', err);
    }
  }

  // Resolve group_email for current user (cached). Tries profiles.user_id then falls back to user's email.
  async function getGroupEmail(client, user) {
    try {
      if (CURRENT_GROUP_EMAIL) return CURRENT_GROUP_EMAIL;
      if (!client || !user) return null;
      try {
  const { data: profile, error } = await client.from('profiles').select('group_email, email').eq('user_id', user.id).maybeSingle();
        const resolved = (profile && (profile.group_email || profile.email)) ? (profile.group_email || profile.email) : null;
        if (!error && resolved) {
          CURRENT_GROUP_EMAIL = String(resolved).toLowerCase();
          return CURRENT_GROUP_EMAIL;
        }
      } catch (e) { /* ignore and fallback */ }
      // fallback to auth email if available
      try { CURRENT_GROUP_EMAIL = (user.email || '').toLowerCase(); } catch(_) { CURRENT_GROUP_EMAIL = null; }
      return CURRENT_GROUP_EMAIL;
    } catch (e) { _log('getGroupEmail failed', e); return null; }
  }

  function uid() {
    try { return (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8); } catch(e){ return 'id_' + Date.now().toString(36); }
  }
  // Generate a stable-ish device identifier for records that require device_id.
  // Prefer the Web Crypto API's randomUUID; fallback to a reasonably unique token.
  function generateDeviceId() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
      // fallback: use userAgent fingerprint + timestamp + random
      const ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : 'ua';
      const t = Date.now();
      const r = Math.floor(Math.random() * 0xFFFFFF).toString(16);
      return `dev-${t}-${r}-${String(ua).slice(0,32).replace(/[^a-zA-Z0-9]/g,'')}`;
    } catch (e) { return 'dev_' + Date.now() + '_' + Math.floor(Math.random() * 1000000); }
  }

  // --- Sanitization helpers ------------------------------------------------
  // Best-effort coercions to match DB types: numbers, booleans, json arrays/objects, ISO dates
  function toISO(dateStr) {
    try {
      if (!dateStr) return null;
      // Normalize Persian numerals to ASCII digits
      if (typeof dateStr === 'string') {
        dateStr = dateStr.replace(/[\u06F0-\u06F9]/g, function(d) { return String(d.charCodeAt(0) - 0x06F0); });
        dateStr = dateStr.trim();
      }

      // Detect common Jalali patterns like 1404/07/23 or 1404-07-23
      const jalaliMatch = (typeof dateStr === 'string') && dateStr.match(/^\s*(13|14|15)\d{2}[-\/]\d{1,2}[-\/]\d{1,2}\s*$/);
      if (jalaliMatch) {
        const sep = dateStr.indexOf('/') !== -1 ? '/' : '-';
        const parts = dateStr.split(sep).map(s => parseInt(s, 10));
        if (parts.length === 3 && parts.every(n => !isNaN(n))) {
          // convert Jalali to Gregorian
          const [jy, jm, jd] = parts;
          try {
            const g = (function jalaliToGregorian(jy, jm, jd) {
              jy = parseInt(jy, 10); jm = parseInt(jm, 10); jd = parseInt(jd, 10);
              var jy2 = jy - 979;
              var j_day_no = 365 * jy2 + Math.floor(jy2 / 33) * 8 + Math.floor(((jy2 % 33) + 3) / 4);
              for (var i = 0; i < jm - 1; ++i) j_day_no += (i < 6) ? 31 : 30;
              j_day_no += jd - 1;
              var g_day_no = j_day_no + 79;
              var gy = 1600 + 400 * Math.floor(g_day_no / 146097);
              g_day_no = g_day_no % 146097;
              var leap = true;
              if (g_day_no >= 36525) {
                g_day_no -= 1;
                gy += 100 * Math.floor(g_day_no / 36524);
                g_day_no = g_day_no % 36524;
                if (g_day_no >= 365) g_day_no += 1; else leap = false;
              }
              gy += 4 * Math.floor(g_day_no / 1461);
              g_day_no = g_day_no % 1461;
              if (g_day_no >= 366) {
                leap = false;
                g_day_no -= 366;
                gy += Math.floor(g_day_no / 365);
                g_day_no = g_day_no % 365;
              }
              var gd = g_day_no + 1;
              var sal_a = [0,31,(leap?29:28),31,30,31,30,31,31,30,31,30,31];
              var gm = 0;
              for (var i = 1; i <= 12; ++i) {
                if (gd <= sal_a[i]) { gm = i; break; }
                gd -= sal_a[i];
              }
              return [gy, gm, gd];
            })(jy, jm, jd);
            if (Array.isArray(g) && g.length === 3) {
              const [gy, gm, gd] = g;
              const dt = new Date(Date.UTC(gy, gm - 1, gd));
              if (!isNaN(dt.getTime())) return dt.toISOString();
            }
          } catch (e) { return null; }
        }
        return null;
      }

      // Fallback: try to parse as ISO/Gregorian
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return null;
      return d.toISOString();
    } catch (e) { return null; }
  }

  function coerceNumber(v) {
    try {
      if (v === null || v === undefined || v === '') return null;
      if (typeof v === 'number') return v;
      const n = Number(String(v).replace(/[,\s]+/g, ''));
      return isNaN(n) ? null : n;
    } catch (e) { return null; }
  }

  function coerceBoolean(v) {
    if (v === true || v === false) return v;
    if (v === 'true' || v === '1' || v === 1) return true;
    if (v === 'false' || v === '0' || v === 0) return false;
    return null;
  }

  function ensureJSON(val) {
    try {
      if (val === null || typeof val === 'undefined') return {};
      if (typeof val === 'object') return val;
      if (typeof val === 'string' && val.trim() === '') return {};
      if (typeof val === 'string') return JSON.parse(val);
      return val;
    } catch (e) { return {};
    }
  }

  function sanitizeRowForTable(table, row) {
    try {
      const copy = Object.assign({}, row || {});
      if (!copy || typeof copy !== 'object') return copy;

      // Normalize common date-like keys across tables (handles snake_case and camelCase)
      const dateKeys = [
        'date',
        'paymentDate',  // 👈 added: normalize paymentDate to ISO as requested
        'joinDate',
        'insuranceDate',
        'birthdate',
        'createdAt',
        'created_at',
        'last_modified'
      ];
      for (const key of dateKeys) {
        if (copy[key]) {
          try {
            const iso = toISO(copy[key]);
            if (iso) copy[key] = iso;
          } catch (_) { /* noop */ }
        }
      }

      switch (table) {
        case 'players':
          // ensure numeric fields
          copy.height = coerceNumber(copy.height);
          copy.weight = coerceNumber(copy.weight);
          copy.scores = ensureJSON(copy.scores);
          copy.events = ensureJSON(copy.events);
          break;
        case 'coaches':
          // created_at already normalized above
          break;
        case 'sessions':
          copy.attendances = ensureJSON(copy.attendances);
          break;
        case 'payments':
          copy.amount = coerceNumber(copy.amount);
          // normalize paymentYear (Jalali → Gregorian) when it looks like a Jalali year
          if (copy.paymentYear) {
            try {
              const pyRaw = typeof copy.paymentYear === 'string' ? copy.paymentYear.trim() : String(copy.paymentYear);
              const py = parseInt(pyRaw, 10);
              if (!isNaN(py) && py >= 1300 && py < 1600) {
                try {
                  // convert using end of Jalali year to avoid off-by-one (e.g. 1404 -> 2025)
                  const g = jalaliToGregorian(py, 12, 29);
                  if (Array.isArray(g) && g.length >= 1) copy.paymentYear = g[0];
                } catch (err) {
                  // fallback: best-effort offset
                  copy.paymentYear = py + 621;
                }
              } else if (!isNaN(py)) {
                copy.paymentYear = py;
              }
            } catch (_) { /* noop */ }
          }
          break;
        case 'competitions':
          // support single `date` column (timestamptz) and ensure sets is json
          copy.date = toISO(copy.date) || copy.date || null;
          copy.sets = ensureJSON(copy.sets);
          break;
        case 'training_plans':
          copy.data = ensureJSON(copy.data);
          if (copy.date) copy.date = toISO(copy.date) || copy.date;
          if (copy.reminder !== undefined) copy.reminder = coerceBoolean(copy.reminder);
          break;
        case 'shared_backups':
          // ensure group_email normalized and data as object
          if (copy.group_email) copy.group_email = String(copy.group_email).toLowerCase();
          copy.data = ensureJSON(copy.data);
          break;
        case 'backups':
          copy.data = ensureJSON(copy.data);
          break;
        default:
          break;
      }
      // Ensure all id-like columns are strings to avoid uuid parsing errors
      try {
        const idKeys = ['id', 'user_id', 'player_id', 'coach_id', 'device_id'];
        for (const k of idKeys) {
          if (copy[k] !== undefined && copy[k] !== null) copy[k] = String(copy[k]);
        }
      } catch (_) {}

      // Normalize common JS-style keys to DB column names (aliases)
      try {
        const aliasMap = {
          // timestamps
          createdAt: 'created_at',
          updatedAt: 'last_modified',
          lastModified: 'last_modified',

          // players
          joinDate: 'join_date',
          insuranceDate: 'insurance_date',
          birthDate: 'birthdate',

          // ids / relationships
          coachId: 'coach_id',
          playerId: 'player_id',

          // payments
          paymentMonth: 'payment_month',
          paymentYear: 'payment_year',
          paymentDate: 'date',

          // personal fields
          favoritePosition: 'favorite_position',
          fatherName: 'father_name',
          nationalCode: 'national_code',
          parentPhone: 'parent_phone',

          // generic/name fields (kept for explicitness)
          created_at: 'created_at',
          last_modified: 'last_modified'
        };

        for (const key in copy) {
          if (!Object.prototype.hasOwnProperty.call(copy, key)) continue;
          const alias = aliasMap[key];
          if (!alias) continue;
          // don't overwrite existing canonical field unless it's empty/null/undefined
          if (typeof copy[alias] === 'undefined' || copy[alias] === null || copy[alias] === '') {
            copy[alias] = copy[key];
          }
          try { delete copy[key]; } catch (_) { /* ignore */ }
        }
      } catch (_) { /* noop */ }
      return copy;
    } catch (e) { return row; }
  }

  // Schedule daily backups (best-effort). store the interval id so it can be cleared by host
  try {
    if (typeof window !== 'undefined') {
      window.syncHybrid = window.syncHybrid || {};
      // Daily backup disabled - only manual backups allowed
      if (window.syncHybrid._backupIntervalId) {
        clearInterval(window.syncHybrid._backupIntervalId);
        window.syncHybrid._backupIntervalId = null;
      }
    }
  } catch (_) {}

  // Convert Jalali (Persian) date to Gregorian date [year, month, day]
  function jalaliToGregorian(jy, jm, jd) {
    jy = parseInt(jy, 10); jm = parseInt(jm, 10); jd = parseInt(jd, 10);
    var jy2 = jy - 979;
    var j_day_no = 365 * jy2 + Math.floor(jy2 / 33) * 8 + Math.floor(((jy2 % 33) + 3) / 4);
    for (var i = 0; i < jm - 1; ++i) j_day_no += (i < 6) ? 31 : 30;
    j_day_no += jd - 1;
    var g_day_no = j_day_no + 79;
    var gy = 1600 + 400 * Math.floor(g_day_no / 146097);
    g_day_no = g_day_no % 146097;
    var leap = true;
    if (g_day_no >= 36525) {
      g_day_no -= 1;
      gy += 100 * Math.floor(g_day_no / 36524);
      g_day_no = g_day_no % 36524;
      if (g_day_no >= 365) g_day_no += 1; else leap = false;
    }
    gy += 4 * Math.floor(g_day_no / 1461);
    g_day_no = g_day_no % 1461;
    if (g_day_no >= 366) {
      leap = false;
      g_day_no -= 366;
      gy += Math.floor(g_day_no / 365);
      g_day_no = g_day_no % 365;
    }
    var gd = g_day_no + 1;
    var sal_a = [0,31,(leap?29:28),31,30,31,30,31,31,30,31,30,31];
    var gm = 0;
    for (var i = 1; i <= 12; ++i) {
      if (gd <= sal_a[i]) { gm = i; break; }
      gd -= sal_a[i];
    }
    return [gy, gm, gd];
  }

  function mergeLocalCollection(localArr, incomingRows, key = 'id') {
    incomingRows.forEach(row => {
      if (!row || !row[key]) return;
      const idx = localArr.findIndex(r => r && r[key] === row[key]);
      if (row._deleted) {
        if (idx !== -1) localArr.splice(idx, 1);
        return;
      }
      if (idx === -1) {
        localArr.unshift(row);
      } else {
        const local = localArr[idx];
        const a = new Date(local.last_modified || 0).getTime();
        const b = new Date(row.last_modified || 0).getTime();
        if (!local.last_modified || b >= a) {
          localArr[idx] = Object.assign({}, local, row);
        }
      }
    });
  }

const STATE_MAP = {
  players: 'players',
  coaches: 'coaches',
  sessions: 'sessions',
  payments: 'payments',
  competitions: 'competitions',
  training_plans: 'trainingPlans',
  shared_backups: 'sharedBackups'
};

async function loadTableIntoState(client, userId, table, groupEmail) {
    try {
      let q;
      if (table === 'shared_backups') {
        if (!groupEmail) {
          _log('loadTableIntoState: missing groupEmail for shared_backups');
          return [];
        }
        q = client.from(table)
          .select('*')
          .eq('group_email', groupEmail.toLowerCase())
          .order('created_at', { ascending: false });
      } else {
        q = tableHasUserId(table) ? 
          client.from(table).select('*').eq('user_id', userId) : 
          client.from(table).select('*');
      }
      const res = await q;
      if (res.error) throw res.error;
      const rows = Array.isArray(res.data) ? res.data : [];
      window.state = window.state || {};
      const prop = STATE_MAP[table] || table;
      window.state[prop] = window.state[prop] || [];
      mergeLocalCollection(window.state[prop], rows);
      try { if (typeof window.renderHome === 'function') window.renderHome(); } catch(_) {}
      return rows;
    } catch (e) {
      _log('loadTableIntoState error', table, e);
      return [];
    }
  }

  async function subscribeTableRealtime(client, userId, table, groupEmail) {
    try {
      if (!client || !client.channel) {
        _log('subscribeTableRealtime: invalid client or missing channel capability', table);
        return null;
      }

      // Create unique channel name for this table/user combination
      const channelName = `r_${table}_${userId || 'anon'}_${Date.now()}`;
      const channel = client.channel(channelName);
      
      // Store channel reference for cleanup
      try { 
        CHANNEL_REGISTRY[table] = channel; 
      } catch(e) {
        _log('Failed to store channel reference:', e);
      }
    let filter;
    if (table === 'shared_backups') {
      if (!groupEmail) {
        _log('subscribeTableRealtime: missing groupEmail for shared_backups');
        return null;
      }
      filter = `group_email=eq.${groupEmail.toLowerCase()}`;
    } else {
      filter = tableHasUserId(table) ? `user_id=eq.${userId}` : undefined;
    }
    const onDef = filter ? { event: '*', schema: 'public', table, filter } : { event: '*', schema: 'public', table };
    channel
      .on('postgres_changes', onDef, payload => {
        try {
          if (!payload) {
            _log('subscribeTableRealtime: empty payload received');
            return;
          }

          // Extract event type with proper fallbacks
          const ev = (payload.eventType || payload.type || payload.event || '').toUpperCase();
          if (!ev) {
            _log('subscribeTableRealtime: missing event type', payload);
            return;
          }

          // Get the appropriate row data based on event type
          let row = null;
          if (ev === 'DELETE') {
            row = payload.old; // For deletes, use the old record
          } else {
            row = payload.new || payload.record; // For inserts/updates, prefer new record
          }

          if (!row || typeof row !== 'object') {
            _log('subscribeTableRealtime: invalid row data', {event: ev, payload});
            return;
          }

          // Validate required fields based on table
          if (tableHasUserId(table) && !row.user_id) {
            _log('subscribeTableRealtime: missing user_id in row', {table, row});
            return;
          }

          if (!row.id) {
            _log('subscribeTableRealtime: missing id in row', {table, row});
            return;
          }

          // Initialize state arrays if needed
          const prop = STATE_MAP[table] || table;
          window.state = window.state || {};
          window.state[prop] = window.state[prop] || [];

          // Apply changes based on event type
          if (ev === 'DELETE' || row._deleted) {
            mergeLocalCollection(window.state[prop], [{ ...row, _deleted: true }]);
            _log('subscribeTableRealtime: processed delete', {table, id: row.id});
          } else {
            // Ensure last_modified is set for conflict resolution
            if (!row.last_modified) {
              row.last_modified = new Date().toISOString();
            }
            mergeLocalCollection(window.state[prop], [row]);
            _log('subscribeTableRealtime: processed update', {table, id: row.id, event: ev});
          }

          // Emit event for external listeners
          try {
            window.dispatchEvent(new CustomEvent('sync:realtime', { 
              detail: { table, event: ev, row }
            }));
          } catch (eventErr) {
            _log('subscribeTableRealtime: event dispatch failed', eventErr);
          }
        } catch (e) {
          _log('subscribeTableRealtime: handler error', e, {payload});
        }
      })
      .subscribe(status => { 
        _log('realtime subscription status', {table, status}); 
      });
      return channel;
    } catch (e) {
      _log('subscribeTableRealtime failed', table, e);
      return null;
    }
  }

  // Unsubscribe all active channels (useful when logging out or re-initing)
  function unsubscribeAllChannels() {
    try {
      Object.keys(CHANNEL_REGISTRY).forEach(async (t) => {
        try { const ch = CHANNEL_REGISTRY[t]; if (ch && typeof ch.unsubscribe === 'function') await ch.unsubscribe(); } catch(e) { _log('unsubscribe channel failed', t, e); }
        delete CHANNEL_REGISTRY[t];
      });
    } catch(e) { _log('unsubscribeAllChannels failed', e); }
  }

  function makeTableAPI(table) {
    return {
      async create(obj = {}) {
        const client = await waitForClient();
        const { data: u } = await client.auth.getUser();
        const user = u && u.user;
        if (!user) throw new Error('Not signed in');

        const groupEmail = await getGroupEmail(client, user);
        const now = new Date().toISOString();
        const row = Object.assign({}, obj);
        row.id = row.id || uid();
        if (groupEmail) row.group_email = groupEmail;
        row.user_id = user.id;
        row.last_modified = now;
        if (obj.group_email) row.group_email = obj.group_email.toLowerCase();

        window.state = window.state || {};
        window.state[STATE_MAP[table]] = window.state[STATE_MAP[table]] || [];
        window.state[STATE_MAP[table]].unshift(row);

        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          enqueueOp({ type: 'create', table, row });
          setStatus({ online: false });
          return row;
        }

        try {
          const res = await client.from(table).insert([row]).select();
          if (res.error) throw res.error;
          const serverRow = Array.isArray(res.data) && res.data[0] ? res.data[0] : row;
          mergeLocalCollection(window.state[STATE_MAP[table]], [serverRow]);
          return serverRow;
        } catch (e) {
          _log('create error', table, e);
          enqueueOp({ type: 'create', table, row });
          throw e;
        }
      },

      async update(id, patch = {}) {
        if (!id) throw new Error('id required');
        const client = await waitForClient();
        const now = new Date().toISOString();
        const toSend = Object.assign({}, patch, { last_modified: now });
        try {
          const { data: u } = await client.auth.getUser();
          const user = u && u.user;
          const groupEmail = await getGroupEmail(client, user);
          if (groupEmail && !toSend.group_email) toSend.group_email = groupEmail;
        } catch (e) { /* ignore */ }

        try {
          window.state = window.state || {};
          const arr = window.state[STATE_MAP[table]] = window.state[STATE_MAP[table]] || [];
          const idx = arr.findIndex(x => x && x.id === id);
          if (idx !== -1) arr[idx] = Object.assign({}, arr[idx], toSend);
        } catch (e) {}

        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          enqueueOp({ type: 'update', table, id, patch: toSend });
          setStatus({ online: false });
          return Object.assign({}, toSend, { id });
        }

        // perform upsert using a safe onConflict key per-table
        const conflictMap = {
          devices: 'user_id,device_id',
          shared_backups: 'group_email',
          profiles: 'id'
        };
        const onConflict = conflictMap[table] || 'id';
        const payload = Object.assign({}, toSend, { id });
        try {
          const res = await client.from(table).upsert([payload], { onConflict }).select();
          if (res.error) throw res.error;
          const serverRow = Array.isArray(res.data) && res.data[0] ? res.data[0] : toSend;
          mergeLocalCollection(window.state[STATE_MAP[table]], [serverRow]);
          return serverRow;
        } catch (e) {
          _log('update error', table, e);
          enqueueOp({ type: 'update', table, id, patch: toSend });
          throw e;
        }
      },

      async remove(id) {
        if (!id) throw new Error('id required');
        const client = await waitForClient();
        try {
          const arr = window.state[STATE_MAP[table]] = window.state[STATE_MAP[table]] || [];
          const idx = arr.findIndex(x => x && x.id === id);
          if (idx !== -1) arr.splice(idx, 1);
        } catch(e){}

        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          enqueueOp({ type: 'delete', table, id });
          setStatus({ online: false });
          return { ok: true };
        }

        try {
          const res = await client.from(table).delete().eq('id', id).select();
          if (res.error) throw res.error;
          return res.data;
        } catch (e) {
          _log('remove error', table, e);
          enqueueOp({ type: 'delete', table, id });
          throw e;
        }
      },

      async reload() {
        const client = await waitForClient();
        const { data: u } = await client.auth.getUser();
        const user = u && u.user;
        if (!user) throw new Error('Not signed in');
        const resolved = await getGroupEmail(client, user);
        return loadTableIntoState(client, user.id, table, resolved);
      }
    };
  }

  async function backupNow(options = {}) {
    try {
      // make sure we have window.state (restore from localStorage if needed)
      try { ensureStateLoaded(); } catch(_){}
      // Ensure window.state is populated from localStorage so backup isn't empty.
      try {
        if (!window.state || Object.keys(window.state).length === 0) {
          const key = (typeof STORAGE_KEY !== 'undefined') ? STORAGE_KEY : 'appState';
          const raw = localStorage.getItem(key);
          window.state = raw ? JSON.parse(raw) : (window.state || {});
          _log('[backupNow] state restored from localStorage key=', key);
        }
      } catch (e) {
        _log('[backupNow] restore from localStorage failed', e);
      }
      // Best-effort: ensure queued ops are flushed before taking a snapshot
      let client = null;
      try {
        client = await waitForClient();
      } catch (e) {
        _log('backupNow: supabase client not available, will save local snapshot', e);
      }
      
      // If options.syncOnly is true, only sync tables without creating backup
      if (options.syncOnly) {
        if (!client) throw new Error('Cannot sync tables: Supabase client not available');
        const { data: u } = await client.auth.getUser();
        const user = u && u.user;
        if (!user) throw new Error('Cannot sync tables: User not signed in');
        
        // Sync all tables first
        const resolved = await getGroupEmail(client, user);
        for (const t of Object.values(TABLES)) {
          await loadTableIntoState(client, user.id, t, resolved);
        }
        return { synced: true };
      }

      // If we have a client, attempt to get current user and flush queued ops first.
      let user = null;
      if (client) {
        try { const { data: u } = await client.auth.getUser(); user = u && u.user; } catch(e) { _log('backupNow: getUser failed', e); }
        try {
          setStatus({ syncing: true, lastError: null });
          if (client) await flushQueue(client);
        } catch (e) { _log('backupNow: flushQueue before backup failed', e); }
        finally { setStatus({ syncing: false }); }
      }

      // Build snapshot from local in-memory state where possible to be faster and avoid rate limits
      const snapshot = {};
      // prefer server-side snapshot when signed in; otherwise fall back to local state
      if (client && user) {
        for (const t of Object.values(TABLES)) {
          try {
            // avoid filtering by user_id for tables that do not have that column (eg shared_backups)
            const q = tableHasUserId(t) ? (user && user.id ? client.from(t).select('*').eq('user_id', user.id) : (function(){ _log('Skipping table read: no user.id for table ' + t); return { error: 'no-user' }; })()) : client.from(t).select('*');
            const res = await q;
            snapshot[t] = (res.error) ? [] : (res.data || []);
          } catch (err) { _log('backupNow: table read failed', t, err); snapshot[t] = []; }
        }
      } else {
        // local fallback: read from window.state if available
        try {
          const s = window.state || {};
          for (const t of Object.values(TABLES)) snapshot[t] = s[STATE_MAP[t]] || s[t] || [];
        } catch (e) { _log('backupNow: local snapshot build failed', e); }
      }

      // Attempt to populate group_email from profiles table and shared_backups
      let resolvedGroupEmail = null;
      if (client && user) {
        try {
          // First try to get from profiles
          const p = await client.from('profiles').select('group_email, email').eq('user_id', user.id).maybeSingle();
          const resolved = (p && p.data) ? (p.data.group_email || p.data.email) : null;
          if (p && !p.error && resolved) {
            resolvedGroupEmail = String(resolved).toLowerCase();
          } else {
            // اگر در profiles پیدا نشد، از ایمیل کاربر استفاده می‌کنیم
            resolvedGroupEmail = user.email ? user.email.toLowerCase() : null;
          }
          
          // If not found in profiles, check shared_backups
          // حذف جستجو در shared_backups چون الان از ایمیل کاربر استفاده می‌کنیم
        } catch (e) { 
          _log('backupNow: failed to resolve group_email', e); 
        }
      }

      const meta = { created_at: new Date().toISOString(), user_id: user ? user.id : null, group_email: resolvedGroupEmail, snapshot };
      const json = JSON.stringify(meta, null, 2);
  const name = `backup-${new Date().toISOString().slice(0,10)}.json`;
  let path = `${(meta.user_id || 'anon')}/${name}`;
      const blob = new Blob([json], { type: 'application/json' });

      // Helpers: persist pending backups locally and record last-backup metadata
      function savePendingBackupLocal(pth, jsonStr, metaObj) {
        try {
          const key = 'syncHybrid:pendingBackups';
          const raw = localStorage.getItem(key);
          const arr = raw ? JSON.parse(raw) : [];
          arr.push({ path: pth, json: jsonStr, meta: metaObj, created_at: new Date().toISOString() });
          localStorage.setItem(key, JSON.stringify(arr));
          // Also add to IndexedDB queue if available for more robust background retry
          try {
            if (window.indexedDBQueue && typeof window.indexedDBQueue.addPending === 'function') {
              // store minimal metadata + json as base64 for compactness
              const item = { id: pth, json: jsonStr, groupEmail: metaObj && metaObj.group_email ? metaObj.group_email : null, created_at: new Date().toISOString() };
              try { window.indexedDBQueue.addPending(item).then(() => { /* ok */ }).catch(()=>{}); } catch(_){}
            }
          } catch(_){}
          // Request background sync (best-effort)
          try {
            if (navigator && navigator.serviceWorker && navigator.serviceWorker.ready) {
              navigator.serviceWorker.ready.then(reg => {
                try { if (reg && reg.sync) reg.sync.register('vb-upload-sync').catch(()=>{}); } catch(_){}
                // also send a message to service worker to proactively trigger client-side flush
                try { if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'requestSync', tag: 'vb-upload-sync' }); } catch(_){}
              }).catch(()=>{});
            }
          } catch (_) {}
          return true;
        } catch (e) { _log('savePendingBackupLocal failed', e); return false; }
      }

      function saveLastBackupMeta(obj) {
        try { localStorage.setItem('syncHybrid:lastBackup', JSON.stringify(obj || {})); } catch (e) { _log('saveLastBackupMeta failed', e); }
      }

      // If offline or client unavailable, persist locally for later upload
      if (typeof navigator !== 'undefined' && (!navigator.onLine || !client)) {
        _log('backupNow: offline or client unavailable — storing pending backup locally', path);
        savePendingBackupLocal(path, json, meta);
        saveLastBackupMeta({ path, publicUrl: null, created_at: meta.created_at, storedLocal: true });
        return { path, storedLocal: true };
      }

      // Before attempting storage upload, try to push snapshot into DB tables.
      try {
        try {
          const pushRes = await pushTables(client, user, snapshot);
          // if any table failed, treat as overall failure and save pending backup locally
          const failed = Object.keys(pushRes).find(k => pushRes[k] && pushRes[k].ok === false);
          if (failed) {
            const err = { message: 'Table sync failed', details: pushRes };
            _log('backupNow: pushTables reported failures', pushRes);
            savePendingBackupLocal(path, json, meta);
            saveLastBackupMeta({ path, publicUrl: null, created_at: meta.created_at, storedLocal: true, tableSyncFailed: true, tableSyncResults: pushRes });
            return { path, storedLocal: true, error: err, tableSyncResults: pushRes };
          }
        } catch (pushErr) {
          _log('backupNow: pushTables threw error', pushErr);
          savePendingBackupLocal(path, json, meta);
          saveLastBackupMeta({ path, publicUrl: null, created_at: meta.created_at, storedLocal: true, tableSyncError: (pushErr && pushErr.message) ? pushErr.message : String(pushErr) });
          return { path, storedLocal: true, error: (pushErr && pushErr.message) ? pushErr.message : String(pushErr) };
        }

        // Try to upload to storage
        // Guard: ensure we have a session / access token before attempting storage upload.
        try {
          const sess = await client.auth.getSession();
          _log('backupNow: session', sess && sess.data ? sess.data.session : null);
          if (!sess || !sess.data || !sess.data.session || !sess.data.session.access_token) {
            const msg = 'backupNow: no valid auth session; saving backup locally to avoid 400/403';
            _log(msg);
            savePendingBackupLocal(path, json, meta);
            saveLastBackupMeta({ path, publicUrl: null, created_at: meta.created_at, storedLocal: true, note: 'no-auth-session' });
            return { path, storedLocal: true, error: msg };
          }
        } catch (sErr) {
          _log('backupNow: failed to fetch session, saving locally', sErr);
          savePendingBackupLocal(path, json, meta);
          saveLastBackupMeta({ path, publicUrl: null, created_at: meta.created_at, storedLocal: true, note: 'session-fetch-failed' });
          return { path, storedLocal: true, error: String(sErr) };
        }

        // Attempt upload with retries (simple exponential backoff)
        let uploadResp = null;
        const maxAttempts = 3;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            // ساختن مسیر صحیح برای آپلود
            // use meta.group_email (resolved earlier) as storage folder; fall back to 'anon'
            // Instead of Storage upload, insert backup row into backups table
            try {
              const group = (meta && meta.group_email) ? String(meta.group_email).toLowerCase() : null;
              // attach user_id from session if not present in meta
              try {
                if (!meta || !meta.user_id) {
                  try { const su = await client.auth.getUser(); const suUser = su && su.data && su.data.user; if (suUser && suUser.id) meta = Object.assign({}, meta, { user_id: suUser.id }); } catch(_){ }
                }
              } catch(_){ }
              const payload = { user_id: (meta && meta.user_id) || null, group_email: group, backup_id: name, backup_data: meta && meta.snapshot ? meta.snapshot : {}, device_id: (typeof getDeviceId === 'function') ? getDeviceId() : null, created_at: meta.created_at };
              const ins = await client.from('backups').insert([payload]).select();
              if (ins && ins.error) throw ins.error;
              path = group ? `${group}/${name}` : name;
              uploadResp = { data: ins.data };
              break;
            } catch (dbErr) {
              throw dbErr;
            }
          } catch (uErr) {
            // try to extract HTTP details when available
            let details = null;
            try {
              if (uErr && typeof uErr === 'object') {
                details = { message: uErr.message || null, status: uErr.status || uErr.statusCode || null, details: uErr.details || null };
              } else {
                details = { message: String(uErr) };
              }
            } catch (_) { details = { message: String(uErr) }; }
            _log(`backup upload attempt ${attempt} failed`, details, uErr);
            if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 250 * Math.pow(2, attempt)));
            else uploadResp = { error: details };
          }
        }

        // If storage upload succeeded, attempt to get a public URL and then record metadata in the backups table
        let publicUrl = null;
        if (!uploadResp || uploadResp.error) {
          _log('backup upload ultimately failed after retries; falling back to direct DB insert', uploadResp && uploadResp.error);
          // Fall back: insert the snapshot directly into public.backups so data is preserved
          try {
            const insertRow = {
              user_id: (meta && meta.user_id) || null,
              group_email: (meta && meta.group_email) || null,
              data: meta && meta.snapshot ? meta.snapshot : {},
              device_id: (typeof getDeviceId === 'function') ? getDeviceId() : null,
              operation: 'sync',
              revision: 1
            };
            try {
              // ensure user_id present on the backup row when possible
              if (!insertRow.user_id) {
                try { const su = await client.auth.getUser(); const suUser = su && su.data && su.data.user; if (suUser && suUser.id) insertRow.user_id = suUser.id; } catch(_){ }
              }
            } catch(_){ }
            const dbIns = await client.from('backups').insert([insertRow]).select();
            if (dbIns && dbIns.error) throw dbIns.error;
            saveLastBackupMeta({ path, publicUrl: null, created_at: meta.created_at, storedLocal: false, fallbackInserted: true });
            _log('backup inserted directly into backups table as fallback', dbIns && dbIns.data ? dbIns.data[0] : null);
            return { path, publicUrl: null, storedLocal: false, fallbackInserted: true };
          } catch (dbErr) {
            _log('backup fallback DB insert failed; saving pending local backup', dbErr);
            savePendingBackupLocal(path, json, meta);
            saveLastBackupMeta({ path, publicUrl: null, created_at: meta.created_at, storedLocal: true, error: (dbErr && dbErr.message) ? dbErr.message : String(dbErr) });
            return { path, storedLocal: true, error: (dbErr && dbErr.message) ? dbErr.message : String(dbErr) };
          }
        }

        // Insert metadata row into backups table already happened above; record last meta and mark shared_backups
        try {
          saveLastBackupMeta({ path, publicUrl: null, created_at: meta.created_at, storedLocal: false });
          const groupEmail = (meta && meta.group_email) ? String(meta.group_email).toLowerCase() : null;
          if (groupEmail) {
            try { await client.rpc('mark_shared_backup', { p_group_email: groupEmail, p_backup_id: name }); } catch(e){ _log('mark_shared_backup rpc failed', e); }
          }
          _log('backup recorded in backups table', path);
        // Also upsert a shared backup for this group email so other devices using the same
        // email can discover and merge backups. This is best-effort and never throws.
        try {
          const groupEmail = (meta && meta.group_email) ? String(meta.group_email).toLowerCase() : null;
          if (groupEmail) {
            const sb = {
              group_email: groupEmail,
              data: meta.snapshot || {},
              device_id: (typeof getDeviceId === 'function') ? getDeviceId() : null,
              last_sync_at: new Date().toISOString()
            };
            try {
              const su = await client.from('shared_backups').upsert([Object.assign({}, sb, { created_at: sb.last_sync_at })], { onConflict: 'group_email' });
              if (su && su.error) _log('shared_backups upsert error', su.error);
              else _log('shared_backups upserted', su && su.data ? su.data : null);
            } catch (sErr) { _log('shared_backups upsert failed', sErr); }
          }
        } catch (_) { /* ignore */ }

        return { path, publicUrl, storedLocal: false, dbRow: dbIns && dbIns.data ? dbIns.data[0] : null };
          } catch (dbErr) {
            _log('backup stored but recording in backups table failed', dbErr);
            // As a last-resort, save local pending backup
            savePendingBackupLocal(path, json, meta);
            saveLastBackupMeta({ path, publicUrl, created_at: meta.created_at, storedLocal: true, error: (dbErr && dbErr.message) ? dbErr.message : String(dbErr) });
            return { path, publicUrl, storedLocal: true, error: (dbErr && dbErr.message) ? dbErr.message : String(dbErr) };
          }
      } catch (uploadErr) {
        _log('backup upload failed — saving pending local backup', uploadErr);
        savePendingBackupLocal(path, json, meta);
        saveLastBackupMeta({ path, publicUrl: null, created_at: meta.created_at, storedLocal: true, error: (uploadErr && uploadErr.message) ? uploadErr.message : String(uploadErr) });
        return { path, storedLocal: true, error: (uploadErr && uploadErr.message) ? uploadErr.message : String(uploadErr) };
      }
    } catch (e) {
      _log('backupNow failed', e);
      throw e;
    }
  }

  async function init(opts = {}) {
    // teardown any previous realtime channels to avoid duplicates
    try { unsubscribeAllChannels(); } catch(_){ }
    // make sure local state is loaded before anything else
    try { ensureStateLoaded(); } catch(_){}
    const client = await waitForClient();
    const { data: u } = await client.auth.getUser();
    const user = u && u.user;

    if (!user) {
      _log('init: not signed in yet');
      return;
    }

    // Get or resolve group_email
    let groupEmail = null;
    try {
  const { data: profile } = await client.from('profiles').select('group_email, email').eq('user_id', user.id).maybeSingle();
      const resolved = profile ? (profile.group_email || profile.email) : null;
      groupEmail = resolved ? resolved.toLowerCase() : (user.email ? user.email.toLowerCase() : null);
      _log('init: resolved group_email:', groupEmail);
    } catch(e) {
      _log('init: failed to resolve group_email, using user.email as fallback:', e);
      groupEmail = user.email ? user.email.toLowerCase() : null;
    }

    window.state = window.state || {};
    // resolve and cache group email for this session
    const resolved = await getGroupEmail(client, user);
    for (const t of Object.values(TABLES)) {
      await loadTableIntoState(client, user.id, t, resolved);
    }

    if (opts.migrateLocal === true) {
      try {
        const resolvedGroup = await getGroupEmail(client, user);
        for (const [table, prop] of Object.entries(STATE_MAP)) {
          const arr = window.state[prop] || [];
          // For shared_backups, check by group_email; otherwise check by user_id
          let res;
          try {
            if (table === 'shared_backups') {
              res = await client.from(table).select('id').eq('group_email', resolvedGroup).limit(1);
            } else {
              if (user && user.id) {
                res = await client.from(table).select('id').eq('user_id', user.id).limit(1);
              } else {
                _log('migration check skipped for table ' + table + ': no user.id');
                res = { data: [] };
              }
            }
          } catch (e) { res = { error: e }; }
          const serverEmpty = (res && (res.error || !res.data || res.data.length === 0));
          if (serverEmpty && arr.length) {
            _log('migrating local data for', table, 'count', arr.length);
            const toInsert = arr.map(r => ({ ...r, user_id: user.id, group_email: resolvedGroup || (r && r.group_email) || null, last_modified: r.last_modified || new Date().toISOString(), id: r.id || uid() }));
            for (let i = 0; i < toInsert.length; i += 50) {
              const chunk = toInsert.slice(i, i + 50);
              try { await client.from(table).insert(chunk); } catch(e){ _log('migrate chunk failed', table, e); }
            }
            await loadTableIntoState(client, user.id, table, resolvedGroup);
          }
        }
      } catch (e) { _log('migration error', e); }
    }

    for (const t of Object.values(TABLES)) {
      try { await subscribeTableRealtime(client, user.id, t, groupEmail); } catch(e){ _log('subscribe error', t, e); }
    }

    _log('sync-hybrid initialized');
    return true;
  }

  window.syncHybrid = {
    init,
    backupNow,
    tables: TABLES,
    players: makeTableAPI(TABLES.players),
    coaches: makeTableAPI(TABLES.coaches),
    sessions: makeTableAPI(TABLES.sessions),
    payments: makeTableAPI(TABLES.payments),
    competitions: makeTableAPI(TABLES.competitions),
    trainingPlans: makeTableAPI(TABLES.training_plans),
    sharedBackups: makeTableAPI(TABLES.shared_backups),
    __mergeLocalCollection: mergeLocalCollection,
  // expose sanitizer for debugging
  sanitizeRow: function(table, row) { try { return sanitizeRowForTable(table, row); } catch(e) { return row; } },
  // expose toISO for testing date conversions
  toISO: function(dateStr) { try { return toISO(dateStr); } catch (e) { return null; } },

    // New methods for UI
    async syncTables() {
      return backupNow({ syncOnly: true });
    },
    
    async createBackup() {
      return backupNow();
    },
    // Fetch latest shared backup for current user's group_email
    async fetchSharedBackup() {
      const client = await waitForClient();
      const { data: u } = await client.auth.getUser();
      const user = u && u.user;
      if (!user) throw new Error('Not signed in');
      const groupEmail = await getGroupEmail(client, user);
      if (!groupEmail) throw new Error('Group email not resolved');
      try {
        const res = await client.from('shared_backups').select('id,data,last_sync_at,device_id').eq('group_email', groupEmail).order('last_sync_at', { ascending: false }).limit(1).maybeSingle();
        if (res && res.error) throw res.error;
        return res && res.data ? res.data : null;
      } catch (e) { _log('fetchSharedBackup failed', e); throw e; }
    },
    
    // Method to check sync status
    getSyncStatus() {
      return { 
        online: status.online,
        syncing: status.syncing,
        lastError: status.lastError,
        queueLength: loadQueue().length
      };
    }
  };

  // Helpers: inspect and manage dead-letter queues
  try {
    window.syncHybrid.listDeadLetterOps = function() { return getDeadLetterOps(); };
    window.syncHybrid.listDeadLetterBackups = function() { try { const raw = localStorage.getItem(DEADLETTER_BACKUPS_KEY); return raw ? JSON.parse(raw) : []; } catch(e){ return []; } };
    window.syncHybrid.requeueDeadLetterOp = function(idx) {
      try {
        const arr = getDeadLetterOps(); if (!Array.isArray(arr) || idx < 0 || idx >= arr.length) return false;
        const op = arr.splice(idx,1)[0]; saveDeadLetterOps(arr);
        // reset attempts and push to queue head
        op.attempts = 0; const q = loadQueue(); q.unshift(op); saveQueue(q);
        try { window.dispatchEvent(new CustomEvent('syncHybrid:requeue', { detail: { type: 'op', op } })); } catch(_){ }
        return true;
      } catch(e) { _log('requeueDeadLetterOp failed', e); return false; }
    };
    window.syncHybrid.requeueDeadLetterBackup = function(idx) {
      try {
        const raw = localStorage.getItem(DEADLETTER_BACKUPS_KEY); const arr = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(arr) || idx < 0 || idx >= arr.length) return false;
        const item = arr.splice(idx,1)[0]; localStorage.setItem(DEADLETTER_BACKUPS_KEY, JSON.stringify(arr));
        // move back to pending backups so flushPendingBackups will attempt again
        const pendRaw = localStorage.getItem(PENDING_BACKUPS_KEY); const pend = pendRaw ? JSON.parse(pendRaw) : [];
        item.attempts = 0; pend.push(item); localStorage.setItem(PENDING_BACKUPS_KEY, JSON.stringify(pend));
        try { window.dispatchEvent(new CustomEvent('syncHybrid:requeue', { detail: { type: 'backup', item } })); } catch(_){ }
        return true;
      } catch(e) { _log('requeueDeadLetterBackup failed', e); return false; }
    };
  } catch(e) { _log('dead-letter helpers install failed', e); }

  // expose unsubscribe helper
  try { window.syncHybrid.unsubscribeAll = unsubscribeAllChannels; } catch(_) {}

  // Attempt to flush queued ops when coming online
  if (typeof window !== 'undefined') {
    // Auto-sync when coming online
    window.addEventListener('online', async () => {
      setStatus({ online: true });
      try {
        const client = await waitForClient();
        setStatus({ syncing: true });
        // First flush any pending operations
        await flushQueue(client);
        // Then attempt to sync all tables
        const { data: u } = await client.auth.getUser();
        const user = u && u.user;
        if (user) {
          const resolved = await getGroupEmail(client, user);
          for (const t of Object.values(TABLES)) {
            await loadTableIntoState(client, user.id, t, resolved);
          }
        }
        // Finally try to upload any pending backups
        try { await flushPendingBackups(client); } catch (e) { _log('flushPendingBackups failed', e); }
      } catch (e) {
        setStatus({ lastError: e && e.message ? e.message : String(e), syncing: false });
      }
    });

    // Listen for service worker messages requesting a flush (from background sync)
    try {
      if (navigator && navigator.serviceWorker && typeof navigator.serviceWorker.addEventListener === 'function') {
        navigator.serviceWorker.addEventListener('message', async (ev) => {
          try {
            const d = ev && ev.data ? ev.data : {};
            if (d && d.type === 'flushPendingBackups') {
              setStatus({ syncing: true });
              try {
                const client = await waitForClient();
                await flushQueue(client);
                await flushPendingBackups(client);
              } catch (e) { _log('serviceworker-triggered flush failed', e); }
              finally { setStatus({ syncing: false }); }
            }
          } catch (e) { console.warn('sw message handler in syncHybrid failed', e); }
        });
      }
    } catch (e) { console.warn('installing sw message listener failed', e); }
  }

  // Flush any pending backups saved locally (attempt upload to storage)
  async function flushPendingBackups(client) {
    try {
      if (!client) client = await waitForClient();
    } catch (e) { _log('flushPendingBackups: no client', e); return false; }
    try {
      const key = 'syncHybrid:pendingBackups';
      const raw = localStorage.getItem(key);
      let arr = [];
      try { arr = raw ? JSON.parse(raw) : []; } catch (e) { _log('flushPendingBackups: parse failed', e); arr = []; }

      // Also pull any pending items stored in IndexedDB queue for stronger reliability
      try {
        if (window.indexedDBQueue && typeof window.indexedDBQueue.getAllPending === 'function') {
          try {
            const pendingFromDb = await window.indexedDBQueue.getAllPending();
            if (Array.isArray(pendingFromDb) && pendingFromDb.length) {
              // normalize and append to arr if not already present
              for (const it of pendingFromDb) {
                const exists = arr.find(a => a.id === it.id || a.path === it.id || a.path === it.path);
                if (!exists) arr.push({ id: it.id || it.path, json: it.json || it.base64 || it.data || null, groupEmail: it.groupEmail || it.meta && it.meta.group_email || null, created_at: it.created_at || new Date().toISOString(), _fromIndexedDB: true });
              }
            }
          } catch (e) { _log('flushPendingBackups: getAllPending failed', e); }
        }
      } catch (e) { /* ignore */ }

      if (!arr || arr.length === 0) { localStorage.removeItem(key); return true; }
      if (!Array.isArray(arr) || arr.length === 0) { localStorage.removeItem(key); return true; }
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i];
        try {
          item.attempts = (item.attempts || 0) + 1;
          const blob = new Blob([item.json], { type: 'application/json' });
          // Try inserting pending backup into backups table instead of storage
          try {
            const obj = JSON.parse(item.json);
            try {
              // attach user_id if available
              let tmpUserId = null;
              try { const su = await client.auth.getUser(); const suUser = su && su.data && su.data.user; if (suUser && suUser.id) tmpUserId = suUser.id; } catch(_){ }
              const r = await client.from('backups').insert([{ id: item.id, backup_id: item.id, user_id: tmpUserId, group_email: item.groupEmail, backup_data: obj, created_at: new Date().toISOString() }]);
            } catch (e) { await client.from('backups').insert([{ id: item.id, backup_id: item.id, group_email: item.groupEmail, backup_data: obj, created_at: new Date().toISOString() }]); }
            if (r && r.error) throw r.error;
            arr.splice(i, 1); i--;
            _log('flushPendingBackups: inserted pending backup', item.path);
          } catch (e) {
            throw e;
          }
        } catch (e) {
          // capture structured error details when possible
          let details = null;
          try { details = (e && typeof e === 'object') ? { message: e.message || String(e), status: e.status || e.statusCode || null, details: e.details || null } : { message: String(e) }; } catch(_) { details = { message: String(e) }; }
          item.lastError = details;
          _log('flushPendingBackups: upload failed for', item.path, details);
          // if attempts exceed MAX_OP_ATTEMPTS, move to dead-letter backups
          try {
            if ((item.attempts || 0) >= MAX_OP_ATTEMPTS) {
              const dlRaw = localStorage.getItem(DEADLETTER_BACKUPS_KEY);
              const dlArr = dlRaw ? JSON.parse(dlRaw) : [];
              dlArr.push(Object.assign({}, item, { dead_at: new Date().toISOString(), error: (e && e.message) ? e.message : String(e) }));
              localStorage.setItem(DEADLETTER_BACKUPS_KEY, JSON.stringify(dlArr));
              // remove from pending
              arr.splice(i, 1); i--;
              try { window.dispatchEvent(new CustomEvent('syncHybrid:deadLetter', { detail: { type: 'backup', item } })); } catch(_){}
            }
          } catch (inner) { _log('flushPendingBackups dead-letter move failed', inner); }
          // otherwise keep for next attempt
        }
      }
      if (arr.length === 0) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(arr));
      return true;
    } catch (e) { _log('flushPendingBackups failed', e); return false; }
  }

  // helper for legacy code: merge a single incoming row (from external backup or old sync) into local state
  window.syncHybrid.mergeRow = function(table, row, eventType) {
    try {
      const prop = STATE_MAP[table] || table;
      window.state = window.state || {};
      window.state[prop] = window.state[prop] || [];
      if (eventType && eventType.toUpperCase() === 'DELETE') {
        mergeLocalCollection(window.state[prop], [{ ...row, _deleted: true }]);
      } else {
        mergeLocalCollection(window.state[prop], [row]);
      }
      try { window.dispatchEvent(new CustomEvent('sync:merge', { detail: { table, event: eventType, row } })); } catch(_) {}
      } catch (e) { _log('mergeRow failed', e); }
    };

    // Define initialization function
  async function initSyncHybrid() {
    try {
      // Make sure supabase client is available
      const client = await waitForClient();
      if (!client) {
        throw new Error('Supabase client not available');
      }
      
      // Get current user
      const { data: u } = await client.auth.getUser();
      const user = u && u.user;
      
      if (!user) {
        throw new Error('User not signed in');
      }

      // Initialize all tables for sync
      return await window.syncHybrid.init({
        migrateLocal: true // Enable local data migration
      });
    } catch (err) {
      _log('initSyncHybrid failed:', err);
      throw err;
    }
  }

  if (!window.supabaseSync) window.supabaseSync = {
    init: (...a) => { return window.syncHybrid.init(...a); },
    create: (obj) => { return window.syncHybrid.players.create(obj); },
    update: (id, patch) => { return window.syncHybrid.players.update(id, patch); },
    remove: (id) => { return window.syncHybrid.players.remove(id); },
    mergeRow: (row, ev) => {
      try {
        const tbl = (window.supabaseSync && window.supabaseSync._ctx && window.supabaseSync._ctx.table) || (row && row.table) || 'players';
        return window.syncHybrid.mergeRow(tbl, row, ev);
      } catch (e) { return null; }
    },
    _ctx: {}
  };

  // Export for module usage
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { initSyncHybrid };
  } else if (typeof window !== 'undefined') {
    window.initSyncHybrid = initSyncHybrid;
  }

  // Initialize sync hybrid when the script loads
  if (typeof window !== 'undefined') {
    try {
      initSyncHybrid();
    } catch (e) {
      if (typeof _log === 'function') _log('Failed to initialize syncHybrid:', e);
      console.error('[sync-hybrid] Failed to initialize:', e);
    }
  }
  
  // Expose ensureStateLoaded globally for debugging/testing (safe no-op if not defined)
  try {
    if (typeof ensureStateLoaded === 'function' && typeof window !== 'undefined') {
      window.ensureStateLoaded = ensureStateLoaded;
    }
  } catch (e) { /* ignore */ }
  // Ensure sanitizeRow is exposed consistently for external callers (alias to internal sanitizer)
  try {
    if (typeof window !== 'undefined' && window.syncHybrid && typeof window.syncHybrid.sanitizeRow !== 'function') {
      // prefer existing internal function sanitizeRowForTable if available
      if (typeof sanitizeRowForTable === 'function') {
        window.syncHybrid.sanitizeRow = function(table, row) { try { return sanitizeRowForTable(table, row); } catch (e) { return row; } };
      } else if (typeof window.syncHybrid.sanitizeRowForTable === 'function') {
        window.syncHybrid.sanitizeRow = function(table, row) { try { return window.syncHybrid.sanitizeRowForTable(table, row); } catch (e) { return row; } };
      }
    }
  } catch (e) { /* ignore */ }

  // Make sure the internal sanitizer is always available on window.syncHybrid
  try {
    if (typeof window !== 'undefined') {
      if (!window.syncHybrid) window.syncHybrid = {};
      if (typeof sanitizeRowForTable === 'function') {
        window.syncHybrid.sanitizeRowForTable = sanitizeRowForTable;
        window.syncHybrid.sanitizeRow = sanitizeRowForTable; // backwards compatibility
      }
    }
  } catch (e) { /* ignore */ }

  // --- Supabase wrapper: auto-sanitize insert/update payloads ---
  try {
    if (typeof window !== 'undefined' && window.supabase && !window.supabase._patchedForSanitize) {
      const originalFrom = window.supabase.from.bind(window.supabase);
      window.supabase.from = (table) => {
        const query = originalFrom(table);
        try {
          const origInsert = query.insert;
          const origUpdate = query.update;
          const origSelect = query.select;

          // helper: convert camelCase identifiers to snake_case
          function camelToSnake(id) {
            if (!id || typeof id !== 'string') return id;
            if (id.indexOf('_') !== -1) return id; // already snake_case-ish
            return id.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
          }

          function normalizeSelectInput(cols) {
            try {
              if (!cols) return cols;
              if (Array.isArray(cols)) return cols.map(c => normalizeSelectInput(c));
              if (typeof cols !== 'string') return cols;
              // replace quoted identifiers: "createdAt" -> "created_at"
              cols = cols.replace(/"([A-Za-z][A-Za-z0-9_]*)"/g, function(_, id) { return '"' + camelToSnake(id) + '"'; });
              // replace plain identifiers (words) while preserving function names and dots
              cols = cols.replace(/\b([A-Za-z][A-Za-z0-9_]*)\b/g, function(_, id) {
                // if it's all lower-case or contains underscore, leave as-is
                if (id === id.toLowerCase() || id.indexOf('_') !== -1) return id;
                return camelToSnake(id);
              });
              return cols;
            } catch (e) { return cols; }
          }

          query.insert = function(rows, opts) {
            try {
              const arr = Array.isArray(rows) ? rows : [rows];
              const sanitized = arr.map(r => (window.syncHybrid && typeof window.syncHybrid.sanitizeRowForTable === 'function') ? window.syncHybrid.sanitizeRowForTable(table, r) : r);
              return origInsert.call(this, Array.isArray(rows) ? sanitized : sanitized[0], opts);
            } catch (e) {
              return origInsert.call(this, rows, opts);
            }
          };

          query.update = function(row, opts) {
            try {
              const sanitized = (window.syncHybrid && typeof window.syncHybrid.sanitizeRowForTable === 'function') ? window.syncHybrid.sanitizeRowForTable(table, row) : row;
              try {
                // If caller forgot to add a WHERE and payload contains an id, auto-add .eq('id', id)
                if (sanitized && typeof sanitized === 'object' && sanitized.id) {
                  return origUpdate.call(this.eq('id', sanitized.id), sanitized, opts);
                }
              } catch (_) { /* fallback to normal call */ }
              return origUpdate.call(this, sanitized, opts);
            } catch (e) {
              return origUpdate.call(this, row, opts);
            }
          };
          // override select to normalize camelCase column names
          query.select = function(cols, opts) {
            try {
              const mapped = normalizeSelectInput(cols);
              return origSelect.call(this, mapped, opts);
            } catch (e) {
              return origSelect.call(this, cols, opts);
            }
          };
        } catch (e) {
          // If anything goes wrong, leave query untouched
        }
        return query;
      };
      window.supabase._patchedForSanitize = true;
      try { console.info('✅ Supabase .insert/.update patched for sanitizeRowForTable'); } catch (_) {}
    }
  } catch (e) { /* ignore */ }
})();

  // Backwards-compatible alias: pushTables -> window.syncHybrid.syncTables
  try {
    if (typeof window !== 'undefined') {
      if (typeof window.pushTables !== 'function') {
        window.pushTables = async function() {
          if (window.syncHybrid && typeof window.syncHybrid.syncTables === 'function') {
            console.info('pushTables: delegating to syncHybrid.syncTables');
            return await window.syncHybrid.syncTables();
          } else {
            throw new Error('syncTables not available');
          }
        };
      }
      if (window.syncHybrid && typeof window.syncHybrid.pushTables !== 'function') {
        window.syncHybrid.pushTables = window.pushTables;
      }
    }
  } catch (e) { /* ignore */ }

// Add a persistent helper to (re-)patch the Supabase client at runtime
try {
  if (typeof window !== 'undefined') {
    window.syncHybrid = window.syncHybrid || {};
    if (typeof window.syncHybrid.ensureSupabasePatched !== 'function') {
      window.syncHybrid.ensureSupabasePatched = function ensureSupabasePatched() {
        try {
          if (!window.supabase || window.supabase._patchedForSanitize) return;

          const origFrom = window.supabase.from.bind(window.supabase);
          window.supabase.from = function (tableName) {
            const builder = origFrom(tableName);
            const { insert, update } = builder;

            function camelToSnake(id) {
              if (!id || typeof id !== 'string') return id;
              if (id.indexOf('_') !== -1) return id;
              return id.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
            }

            function normalizeSelectInput(cols) {
              try {
                if (!cols) return cols;
                if (Array.isArray(cols)) return cols.map(c => normalizeSelectInput(c));
                if (typeof cols !== 'string') return cols;
                cols = cols.replace(/"([A-Za-z][A-Za-z0-9_]*)"/g, function(_, id) { return '"' + camelToSnake(id) + '"'; });
                cols = cols.replace(/\b([A-Za-z][A-Za-z0-9_]*)\b/g, function(_, id) {
                  if (id === id.toLowerCase() || id.indexOf('_') !== -1) return id;
                  return camelToSnake(id);
                });
                return cols;
              } catch (e) { return cols; }
            }

            const sanitizeWrapper = (origFn) => async function (payload, ...rest) {
              try {
                if (window.syncHybrid?.sanitizeRowForTable) {
                  const sanitize = window.syncHybrid.sanitizeRowForTable;
                  if (Array.isArray(payload)) payload = payload.map(r => sanitize(tableName, r));
                  else if (payload && typeof payload === 'object') payload = sanitize(tableName, payload);
                }
              } catch (e) {
                console.warn('sanitizeRowForTable failed:', e);
              }
              return origFn.call(this, payload, ...rest);
            };

            try { if (insert) builder.insert = sanitizeWrapper(insert); } catch(_){ }
            try {
              if (update) {
                builder.update = async function(payload, ...rest) {
                  try {
                    if (window.syncHybrid && typeof window.syncHybrid.sanitizeRowForTable === 'function') payload = window.syncHybrid.sanitizeRowForTable(tableName, payload);
                  } catch (_) {}
                  try {
                    if (payload && typeof payload === 'object' && payload.id) return update.call(this.eq('id', payload.id), payload, ...rest);
                  } catch (_) {}
                  return update.call(this, payload, ...rest);
                };
              }
            } catch(_){ }
            try {
              const origSelect = builder.select;
              if (origSelect && typeof origSelect === 'function') {
                builder.select = function(cols, opts) {
                  try { return origSelect.call(this, normalizeSelectInput(cols), opts); } catch (e) { return origSelect.call(this, cols, opts); }
                };
              }
            } catch (_) {}
            return builder;
          };

          window.supabase._patchedForSanitize = true;
          try { console.info('✅ Supabase .insert/.update patched for sanitizeRowForTable (ensureSupabasePatched)'); } catch(_){}
        } catch (e) { console.debug('ensureSupabasePatched failed', e); }
      };
      // Attempt immediate patch in case supabase is already loaded
      try { window.syncHybrid.ensureSupabasePatched(); } catch (_) {}
    }
  }
} catch (e) { /* ignore */ }
