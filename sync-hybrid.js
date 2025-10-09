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
          if (op.type === 'create') await client.from(op.table).insert([op.row]);
          else if (op.type === 'update') await client.from(op.table).update(op.patch).eq('id', op.id);
          else if (op.type === 'delete') await client.from(op.table).delete().eq('id', op.id);
          // pop processed
          q = loadQueue(); q.shift(); saveQueue(q);
          try { window.dispatchEvent(new CustomEvent('syncHybrid:flush', { detail: { success: true, op } })); } catch(_){ }
        } catch (e) {
          // Retry/backoff logic per-op
          try {
            op.attempts = (op.attempts || 0) + 1;
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
    training_plans: 'training_plans'
  };

  async function waitForClient(timeout = 10000) {
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

  function uid() {
    try { return (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8); } catch(e){ return 'id_' + Date.now().toString(36); }
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
    training_plans: 'trainingPlans'
  };

  async function loadTableIntoState(client, userId, table) {
    try {
      const res = await client.from(table).select('*').eq('user_id', userId);
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

  async function subscribeTableRealtime(client, userId, table) {
    try {
      if (!client || !client.channel) return;
      const channel = client.channel('r_' + table);
      // store channel so we can unsubscribe if needed
      try { CHANNEL_REGISTRY[table] = channel; } catch(e) {}
      channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `user_id=eq.${userId}` }, payload => {
        try {
          const ev = (payload.eventType || payload.type || payload.event || '').toUpperCase();
          const row = payload.record || payload.new || payload.old || payload;
          const prop = STATE_MAP[table] || table;
          window.state = window.state || {};
          window.state[prop] = window.state[prop] || [];
          if (ev === 'DELETE' || row._deleted) {
            mergeLocalCollection(window.state[prop], [{ ...row, _deleted: true }]);
          } else {
            mergeLocalCollection(window.state[prop], [row]);
          }
          try { window.dispatchEvent(new CustomEvent('sync:realtime', { detail: { table, event: ev, row } })); } catch (_) {}
        } catch (e) { _log('realtime handler error', e); }
      }).subscribe(status => { _log('realtime status', table, status); });
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

        const now = new Date().toISOString();
        const row = Object.assign({}, obj);
        row.id = row.id || uid();
        row.user_id = user.id;
        row.last_modified = now;

        window.state = window.state || {};
        window.state[STATE_MAP[table]] = window.state[STATE_MAP[table]] || [];
        window.state[STATE_MAP[table]].unshift(row);

        // If offline, enqueue op and return optimistic row
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
          // enqueue on failure
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
          window.state = window.state || {};
          const arr = window.state[STATE_MAP[table]] = window.state[STATE_MAP[table]] || [];
          const idx = arr.findIndex(x => x && x.id === id);
          if (idx !== -1) arr[idx] = Object.assign({}, arr[idx], toSend);
        } catch (e) {}

        try {
          // If offline, enqueue update and return optimistic
          if (typeof navigator !== 'undefined' && !navigator.onLine) {
            enqueueOp({ type: 'update', table, id, patch: toSend });
            setStatus({ online: false });
            return Object.assign({}, toSend, { id });
          }
          const res = await client.from(table).update(toSend).eq('id', id).select();
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
        try {
          if (typeof navigator !== 'undefined' && !navigator.onLine) {
            enqueueOp({ type: 'delete', table, id });
            setStatus({ online: false });
            return { ok: true };
          }
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
        return loadTableIntoState(client, user.id, table);
      }
    };
  }

  async function backupNow() {
    try {
      // Best-effort: ensure queued ops are flushed before taking a snapshot
      let client = null;
      try {
        client = await waitForClient();
      } catch (e) {
        _log('backupNow: supabase client not available, will save local snapshot', e);
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
            const res = await client.from(t).select('*').eq('user_id', user.id);
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

      const meta = { created_at: new Date().toISOString(), user_id: user ? user.id : null, snapshot };
      const json = JSON.stringify(meta, null, 2);
      const name = `backup-${new Date().toISOString().slice(0,10)}.json`;
      const path = `${(meta.user_id || 'anon')}/${name}`;
      const blob = new Blob([json], { type: 'application/json' });

      // Helpers: persist pending backups locally and record last-backup metadata
      function savePendingBackupLocal(pth, jsonStr, metaObj) {
        try {
          const key = 'syncHybrid:pendingBackups';
          const raw = localStorage.getItem(key);
          const arr = raw ? JSON.parse(raw) : [];
          arr.push({ path: pth, json: jsonStr, meta: metaObj, created_at: new Date().toISOString() });
          localStorage.setItem(key, JSON.stringify(arr));
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

      // Try to upload to storage
      try {
        const up = await client.storage.from('backups').upload(path, blob, { upsert: true });
        if (up && up.error) throw up.error;

        // Try to obtain a public URL in a way that's resilient to API shape changes
        let publicUrl = null;
        try {
          const res = await client.storage.from('backups').getPublicUrl(path);
          // v2 returns { data: { publicUrl } } but be defensive
          if (res) publicUrl = (res.data && (res.data.publicUrl || res.data.publicURL)) || res.publicUrl || res.publicURL || null;
        } catch (e) { _log('getPublicUrl failed', e); }

        saveLastBackupMeta({ path, publicUrl, created_at: meta.created_at, storedLocal: false });
        _log('backup uploaded', path, publicUrl);
        return { path, publicUrl, storedLocal: false };
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
    try { unsubscribeAllChannels(); } catch(_){}
    const client = await waitForClient();
    const { data: u } = await client.auth.getUser();
    const user = u && u.user;
    if (!user) {
      _log('init: not signed in yet');
      return;
    }

    window.state = window.state || {};
    for (const t of Object.values(TABLES)) {
      await loadTableIntoState(client, user.id, t);
    }

    if (opts.migrateLocal === true) {
      try {
        for (const [table, prop] of Object.entries(STATE_MAP)) {
          const arr = window.state[prop] || [];
          const res = await client.from(table).select('id').eq('user_id', user.id).limit(1);
          const serverEmpty = (res.error || !res.data || res.data.length === 0);
          if (serverEmpty && arr.length) {
            _log('migrating local data for', table, 'count', arr.length);
            const toInsert = arr.map(r => ({ ...r, user_id: user.id, last_modified: r.last_modified || new Date().toISOString(), id: r.id || uid() }));
            for (let i = 0; i < toInsert.length; i += 50) {
              const chunk = toInsert.slice(i, i + 50);
              try { await client.from(table).insert(chunk); } catch(e){ _log('migrate chunk failed', table, e); }
            }
            await loadTableIntoState(client, user.id, table);
          }
        }
      } catch (e) { _log('migration error', e); }
    }

    for (const t of Object.values(TABLES)) {
      try { await subscribeTableRealtime(client, user.id, t); } catch(e){ _log('subscribe error', t, e); }
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
    __mergeLocalCollection: mergeLocalCollection
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
    window.addEventListener('online', async () => {
      setStatus({ online: true });
      try {
        const client = await waitForClient();
        setStatus({ syncing: true });
        await flushQueue(client);
        // attempt pending backups upload when back online
        try { await flushPendingBackups(client); } catch (e) { _log('flushPendingBackups failed', e); }
      } catch (e) {
        setStatus({ lastError: e && e.message ? e.message : String(e), syncing: false });
      }
    });
  }

  // Flush any pending backups saved locally (attempt upload to storage)
  async function flushPendingBackups(client) {
    try {
      if (!client) client = await waitForClient();
    } catch (e) { _log('flushPendingBackups: no client', e); return false; }
    try {
      const key = 'syncHybrid:pendingBackups';
      const raw = localStorage.getItem(key);
      if (!raw) return true;
      let arr = [];
      try { arr = JSON.parse(raw); } catch (e) { _log('flushPendingBackups: parse failed', e); return false; }
      if (!Array.isArray(arr) || arr.length === 0) { localStorage.removeItem(key); return true; }
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i];
        try {
          item.attempts = (item.attempts || 0) + 1;
          const blob = new Blob([item.json], { type: 'application/json' });
          const up = await client.storage.from('backups').upload(item.path, blob, { upsert: true });
          if (up && up.error) throw up.error;
          // remove this item from array
          arr.splice(i, 1); i--;
          _log('flushPendingBackups: uploaded', item.path);
        } catch (e) {
          _log('flushPendingBackups: upload failed for', item.path, e);
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

})();
