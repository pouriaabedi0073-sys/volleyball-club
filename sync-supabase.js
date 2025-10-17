// sync-supabase.js
// Lightweight Supabase realtime sync helpers for client-side apps.
// Designed to keep a local `state` collection in sync with a Postgres table
// (default: `messages`) so multiple devices see inserts/updates/deletes.
// Usage:
//   window.supabaseSync.init({ table: 'messages', key: 'id' });
//   window.supabaseSync.create({ body: 'hello' });
//   window.addEventListener('supabase:realtime', (e)=> console.log(e.detail));
(function(){
  const DEFAULT_TABLE = 'messages';
  const DEFAULT_KEY = 'id';

  // Helper: wait for window.supabase client to be ready
  function waitForSupabase(timeout = 10000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      function check() {
        // support both the UMD library (which exposes createClient) and the already-created client
        if (window.supabase) {
          // if it's the library bundle
          if (typeof window.supabase.createClient === 'function') return resolve(window.supabase);
          // if it's already a client instance (has auth/from methods)
          if (window.supabase.auth && typeof window.supabase.auth.getUser === 'function') return resolve(window.supabase);
        }
        if (Date.now() - t0 > timeout) return reject(new Error('Supabase client not available'));
        setTimeout(check, 200);
      }
      check();
    });
  }

  // Simple UID generator for optimistic local objects when server id is not yet assigned
  function uid(prefix = '') {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
  }

  // Local processed map to avoid re-processing the same change repeatedly
  const processed = new Map();

  // Default options and mutable state
  const ctx = {
    table: DEFAULT_TABLE,
    key: DEFAULT_KEY,
    channel: null,
    supabase: null,
    debounceResubscribe: null,
    // recommended: provide a userId or filter before subscribing; leaving these null prevents unfiltered subs
    userId: null,
    filter: null,
    // group_email for shared access
    groupEmail: null,
    // allow unfiltered subscriptions only if explicitly enabled by the app (dangerous)
    allowUnfiltered: false,
  };

  // helper: which tables have a user_id column
  function tableHasUserId(table) {
    return table !== 'shared_backups';
  }

  // Emit a global CustomEvent so UI code can react
  function emit(eventName, detail) {
    try {
      window.dispatchEvent(new CustomEvent(eventName, { detail }));
    } catch (e) {
      console.warn('emit error', e);
    }
  }

  // Merge incoming row into local `state` object if present
  function mergeRow(row, eventType) {
    try {
      if (!window.state) window.state = {};
      const col = window.state[ctx.table] = window.state[ctx.table] || [];
      const key = ctx.key;
      const id = row[key];
      const idx = col.findIndex(x => x && x[key] === id);

      if (eventType === 'INSERT') {
        if (idx === -1) col.unshift(row);
        else col[idx] = Object.assign({}, col[idx], row);
      } else if (eventType === 'UPDATE') {
        if (idx === -1) col.unshift(row);
        else {
          // prefer the incoming row if it has a newer last_modified
          const local = col[idx];
          const a = new Date(local.last_modified || 0).getTime();
          const b = new Date(row.last_modified || 0).getTime();
          if (!local.last_modified || b >= a) col[idx] = Object.assign({}, local, row);
        }
      } else if (eventType === 'DELETE') {
        if (idx !== -1) col.splice(idx, 1);
      }

      // notify UI wiring
      emit('supabase:realtime', { table: ctx.table, event: eventType, row });
      // small hook for apps that expect a render handler
      if (typeof window.onSupabaseRealtime === 'function') {
        try { window.onSupabaseRealtime({ table: ctx.table, event: eventType, row }); } catch(e){/*ignore*/}
      }
    } catch (e) {
      console.warn('mergeRow error', e);
    }
  }

  // Setup a channel subscription to Postgres changes for the configured table
  async function subscribe() {
    if (!ctx.supabase) return;
    try {
      // require either a filter, userId, or groupEmail (which will be translated to appropriate filters)
      if (!ctx.filter && !ctx.userId && !ctx.groupEmail && !ctx.allowUnfiltered && !window.SUPABASE_SYNC_ALLOW_UNFILTERED) {
        console.warn('supabaseSync: subscription skipped because no filter/userId/groupEmail provided; call supabaseSync.setUserId(id), setGroupEmail(email), or setFilter(filter) to enable subscriptions');
        return;
      }

      // build filter string for postgres_changes; prefer explicit filter if provided
      let pgFilter = ctx.filter;
      if (!pgFilter) {
        if (ctx.userId && ctx.groupEmail && tableHasUserId(ctx.table)) {
          // Filter for both user_id and group_email (only when table supports user_id)
          pgFilter = `or=(user_id.eq.${ctx.userId},group_email.eq.${ctx.groupEmail})`;
        } else if (ctx.userId && tableHasUserId(ctx.table)) {
          // Only apply user_id filter when the table actually has user_id
          pgFilter = `user_id=eq.${ctx.userId}`;
        } else if (ctx.groupEmail) {
          pgFilter = `group_email=eq.${ctx.groupEmail}`;
        }
      }

      // create channel name unique to table and filter/user/group
      const channelName = `realtime_${ctx.table}` + (
        ctx.userId ? `_${ctx.userId}` : 
        ctx.groupEmail ? `_group_${hashCode(ctx.groupEmail)}` :
        ctx.filter ? `_${hashCode(String(ctx.filter))}` : 
        ''
      );

      if (ctx.channel) {
        try { await ctx.channel.unsubscribe(); } catch(e){}
        ctx.channel = null;
      }

      // create a new channel (wrapped to catch creation errors)
      let channel;
      try {
        channel = ctx.supabase.channel(channelName, { config: { broadcast: { self: false } } });
      } catch (chErr) {
        console.warn('supabaseSync: failed to create channel object', chErr);
        throw chErr;
      }

      const filterObj = pgFilter ? { event: '*', schema: 'public', table: ctx.table, filter: pgFilter } : { event: '*', schema: 'public', table: ctx.table };
      channel.on('postgres_changes', filterObj, payload => {
        try {
          const ev = (payload.eventType || payload.type || payload.event || '').toUpperCase();
          const row = payload.record || payload.new || payload.old || payload;
          // avoid duplicate processing (simple): skip if seen same id + updated_at
          const id = row && row[ctx.key];
          const stamp = JSON.stringify({ id, t: row && (row.updated_at || row.last_modified || row.created_at) });
          if (processed.get(id) === stamp) return;
          processed.set(id, stamp);
          if (ev === 'INSERT' || ev === 'UPDATE') mergeRow(row, ev);
          else if (ev === 'DELETE') mergeRow(row, 'DELETE');
        } catch (e) { console.warn('realtime payload handler error', e); }
      }).subscribe(status => {
        console.info('Supabase realtime status', status);
        // detect closed/errored and schedule reconnect
        try {
          const state = (status && status.realtime_state) || (status && status.state) || null;
          if (state && (String(state).toLowerCase().indexOf('closed') !== -1 || String(state).toLowerCase().indexOf('error') !== -1)) {
            // schedule reconnect with backoff
            const backoff = Math.min(30000, (ctx._reconnectAttempts || 0) * 2000 + 1000);
            ctx._reconnectAttempts = (ctx._reconnectAttempts || 0) + 1;
            console.info('supabaseSync: realtime appears closed; scheduling reconnect in', backoff);
            setTimeout(() => {
              subscribe().catch(()=>{});
            }, backoff);
          } else {
            ctx._reconnectAttempts = 0; // reset on healthy status
          }
        } catch(e) { console.debug('reconnect check failed', e); }
      });

      ctx.channel = channel;
      return channel;
    } catch (e) {
      console.warn('subscribe error', e);
      throw e;
    }
  }

  // small helper to generate a simple hash from string for channel naming
  function hashCode(s) {
    try {
      let h = 0; for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; } return Math.abs(h).toString(36);
    } catch (e) { return 'h'; }
  }

  // Public API: create, update, delete helpers that also push to Supabase
  async function create(obj) {
    if (!ctx.supabase) await waitForSupabase();
    const now = new Date().toISOString();
    const row = Object.assign({}, obj);
    row[ctx.key] = row[ctx.key] || uid('m_');
    row.created_at = row.created_at || now;
    row.last_modified = row.last_modified || now;
    // Handle group_email if provided
    if (obj.group_email || ctx.groupEmail) {
      row.group_email = (obj.group_email || ctx.groupEmail).toLowerCase();
    }

    // optimistic local insert
    try { mergeRow(row, 'INSERT'); } catch(e){}

    try {
      const { data, error } = await ctx.supabase.from(ctx.table).insert([row]).select();
      if (error) throw error;
      // if server returned a canonical row (with numeric id for example), merge that
      if (Array.isArray(data) && data[0]) mergeRow(data[0], 'UPDATE');
  // attempt to write last-sync metadata for the authenticated user
  try { await writeLastSyncMetadata(data && data[0] ? data[0] : row); } catch(e) { /* ignore */ }
      return { data, error: null };
    } catch (e) {
      console.warn('create sync error', e);
      emit('supabase:sync-error', { op: 'create', table: ctx.table, err: String(e), row });
      return { data: null, error: e };
    }
  }

  async function update(id, patch) {
    if (!ctx.supabase) await waitForSupabase();
    const now = new Date().toISOString();
    const toSend = Object.assign({}, patch, { last_modified: now });

    // optimistic local update
    try {
      const localCol = window.state && window.state[ctx.table] || [];
      const idx = localCol.findIndex(x => x && x[ctx.key] === id);
      if (idx !== -1) localCol[idx] = Object.assign({}, localCol[idx], toSend);
    } catch(e){}

    try {
      // determine onConflict key
      const conflictMap = {
        devices: ['user_id', 'device_id'],
        shared_backups: ['group_email'],
        profiles: ['id']
      };
      const onConflictCols = conflictMap[ctx.table] || [ctx.key || 'id'];
      const onConflict = onConflictCols.join(',');
      const payload = Object.assign({}, toSend, { [ctx.key]: id });
      const { data, error } = await ctx.supabase.from(ctx.table).upsert([payload], { onConflict }).select();
      if (error) throw error;
      if (Array.isArray(data) && data[0]) mergeRow(data[0], 'UPDATE');
      try { await writeLastSyncMetadata(data && data[0] ? data[0] : toSend); } catch(e) { /* ignore */ }
      return { data, error: null };
    } catch (e) {
      console.warn('update sync error', e);
      emit('supabase:sync-error', { op: 'update', table: ctx.table, err: String(e), id, patch });
      return { data: null, error: e };
    }
  }

  async function remove(id) {
    if (!ctx.supabase) await waitForSupabase();
    // optimistic local delete
    try {
      const col = window.state && window.state[ctx.table];
      if (col) {
        const idx = col.findIndex(x => x && x[ctx.key] === id);
        if (idx !== -1) col.splice(idx, 1);
      }
    } catch(e){}

    try {
      const { data, error } = await ctx.supabase.from(ctx.table).delete().eq(ctx.key, id).select();
      if (error) throw error;
      emit('supabase:sync', { op: 'delete', table: ctx.table, id, data });
  try { await writeLastSyncMetadata({ [ctx.key]: id, _deleted: true }); } catch(e) { /* ignore */ }
      return { data, error: null };
    } catch (e) {
      console.warn('delete sync error', e);
      emit('supabase:sync-error', { op: 'delete', table: ctx.table, err: String(e), id });
      return { data: null, error: e };
    }
  }

  // write last-sync metadata into profiles table for the current user (if available)
  async function writeLastSyncMetadata(rowPayload) {
    try {
      if (!ctx.supabase) return;
      // try to get current user id
      let uid = null;
      try {
        const u = await ctx.supabase.auth.getUser();
        uid = u && u.data && u.data.user && u.data.user.id;
      } catch(e) { /* ignore */ }
      if (!uid) return;
      const now = new Date().toISOString();
      const device = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : 'browser';
      const payload = {};
      payload[ctx.table] = [rowPayload];
        // upsert into profiles (requires RLS/permissions configured appropriately)
        try {
          try {
            const { data: { user: authUser } = {} } = await ctx.supabase.auth.getUser();
            if (!authUser) {
              console.warn('writeLastSyncMetadata: no authenticated user');
            } else {
              const upsertPayload = { user_id: authUser.id, last_sync_at: now, last_sync_device: device, last_sync_payload: payload };
              const res = await ctx.supabase.from('profiles').upsert(upsertPayload, { onConflict: 'user_id', ignoreDuplicates: false }).select().single();
              if (res && res.error) throw res.error;
            }
          } catch (e) {
            // fallback: try update by user_id
            try { await ctx.supabase.from('profiles').update({ last_sync_at: now, last_sync_device: device, last_sync_payload: payload }).eq('user_id', uid); } catch(_){ console.warn('profiles update last_sync_payload failed', _); }
          }
        } catch (e) {
          // top-level guard
          console.warn('writeLastSyncMetadata upsert failed', e);
        }
    } catch (e) {
      console.warn('writeLastSyncMetadata failed', e);
    }
  }

  // Public init: wait for supabase client and current auth then subscribe
  async function init(opts = {}) {
    ctx.table = opts.table || ctx.table;
    ctx.key = opts.key || ctx.key;
    try {
      ctx.supabase = await waitForSupabase(15000);
    } catch (e) {
      console.warn('Supabase client not ready for realtime init', e);
      return;
    }

    // try to subscribe immediately (subscribe() will no-op if no filter/userId set)
    try { await subscribe(); } catch (e) { console.warn('initial subscribe failed', e); }

    // re-subscribe on visibility or reconnect events
    window.addEventListener('online', () => {
      clearTimeout(ctx.debounceResubscribe);
      ctx.debounceResubscribe = setTimeout(() => subscribe().catch(()=>{}), 500);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(ctx.debounceResubscribe);
        ctx.debounceResubscribe = setTimeout(() => subscribe().catch(()=>{}), 400);
      }
    });

    // expose a small diagnostic event
    emit('supabase:sync-ready', { table: ctx.table });
  }

  // Helpers to set user/filter before subscribing. These are safe to call before or after init.
  function setUserId(id) {
    ctx.userId = id || null;
    // clear explicit filter if any (userId takes precedence)
    if (ctx.userId) ctx.filter = null;
    clearTimeout(ctx.debounceResubscribe);
    ctx.debounceResubscribe = setTimeout(() => subscribe().catch(()=>{}), 200);
  }

  function setFilter(f) {
    ctx.filter = f || null;
    // don't clear userId; explicit filter wins
    clearTimeout(ctx.debounceResubscribe);
    ctx.debounceResubscribe = setTimeout(() => subscribe().catch(()=>{}), 200);
  }

  function allowUnfiltered(v = true) {
    ctx.allowUnfiltered = !!v;
    clearTimeout(ctx.debounceResubscribe);
    ctx.debounceResubscribe = setTimeout(() => subscribe().catch(()=>{}), 200);
  }

  // Install public API on window
  window.supabaseSync = {
    init,
    create,
    update,
    remove,
    mergeRow, // useful for apps that want to inject server rows manually
    setUserId,
    setFilter,
    setGroupEmail: (email) => {
      if (email) {
        ctx.groupEmail = email.toLowerCase();
      } else {
        ctx.groupEmail = null;
      }
      // Re-subscribe with new group email filter
      subscribe().catch(() => {});
    },
    allowUnfiltered,
    _ctx: ctx,
  };

  // Auto-init default table so adding the script enables basic behavior out of the box.
  // If you want a different table or key, call supabaseSync.init({table:'chats', key:'uuid'}) after login.
  setTimeout(() => {
    waitForSupabase(8000).then(sup => {
      ctx.supabase = sup;
      // Only auto-init if explicitly enabled by the host page to avoid accidental unfiltered subscriptions
      const auto = (typeof window.SUPABASE_SYNC_AUTO_INIT !== 'undefined') ? (window.SUPABASE_SYNC_AUTO_INIT === true) : false;
      if (auto) {
        // try to init but ignore errors
        init().catch(()=>{});
      } else {
        console.debug('supabaseSync auto-init suppressed; set window.SUPABASE_SYNC_AUTO_INIT = true to enable automatic init after client ready.');
      }
    }).catch(()=>{
      console.info('Supabase client not found; supabaseSync will wait until client is available.');
    });
  }, 50);

})();
