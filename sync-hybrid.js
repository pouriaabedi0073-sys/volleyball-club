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
  const status = { online: (typeof navigator !== 'undefined') ? !!navigator.onLine : true, syncing: false, lastError: null };

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
    const q = loadQueue(); q.push(op); saveQueue(q);
    try { window.dispatchEvent(new CustomEvent('syncHybrid:queue', { detail: { op, queueLength: q.length } })); } catch(_){}
  }

  async function flushQueue(client) {
    let q = loadQueue();
    if (!q || !q.length) return true;
    setStatus({ syncing: true, lastError: null });
    for (let i = 0; i < q.length; i++) {
      const op = q[0]; // always process head
      try {
        if (!client) client = await waitForClient();
        if (op.type === 'create') await client.from(op.table).insert([op.row]);
        else if (op.type === 'update') await client.from(op.table).update(op.patch).eq('id', op.id);
        else if (op.type === 'delete') await client.from(op.table).delete().eq('id', op.id);
        // pop processed
        q = loadQueue(); q.shift(); saveQueue(q);
        try { window.dispatchEvent(new CustomEvent('syncHybrid:flush', { detail: { success: true, op } })); } catch(_){}
      } catch (e) {
        setStatus({ lastError: (e && e.message) ? e.message : String(e), syncing: false });
        try { window.dispatchEvent(new CustomEvent('syncHybrid:flush', { detail: { success: false, op, error: e } })); } catch(_){}
        return false;
      }
    }
    setStatus({ syncing: false });
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
            if (c && c.auth && typeof c.auth.getUser === 'function') return resolve(c);
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
      const client = await waitForClient();
      const { data: u } = await client.auth.getUser();
      const user = u && u.user;
      if (!user) throw new Error('Not signed in');
      const snapshot = {};
      for (const t of Object.values(TABLES)) {
        try {
          const res = await client.from(t).select('*').eq('user_id', user.id);
          snapshot[t] = (res.error) ? [] : (res.data || []);
        } catch(_) { snapshot[t] = []; }
      }
      const json = JSON.stringify({ created_at: new Date().toISOString(), user_id: user.id, snapshot }, null, 2);
      const name = `backup-${new Date().toISOString().slice(0,10)}.json`;
      const path = `${user.id}/${name}`;
      const blob = new Blob([json], { type: 'application/json' });
      const up = await client.storage.from('backups').upload(path, blob, { upsert: true });
      if (up.error) throw up.error;
      const publicUrl = await client.storage.from('backups').getPublicUrl(path);
      _log('backup uploaded', path, publicUrl);
      return { path, publicUrl };
    } catch (e) {
      _log('backupNow failed', e);
      throw e;
    }
  }

  async function init(opts = {}) {
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

  // Attempt to flush queued ops when coming online
  if (typeof window !== 'undefined') {
    window.addEventListener('online', async () => {
      setStatus({ online: true });
      try {
        const client = await waitForClient();
        setStatus({ syncing: true });
        await flushQueue(client);
      } catch (e) {
        setStatus({ lastError: e && e.message ? e.message : String(e), syncing: false });
      }
    });
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
