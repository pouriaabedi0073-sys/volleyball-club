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
  };

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
      // create channel name unique to table
      const channelName = `realtime_${ctx.table}`;
      if (ctx.channel) {
        try { await ctx.channel.unsubscribe(); } catch(e){}
        ctx.channel = null;
      }

      const channel = ctx.supabase.channel(channelName, { config: { broadcast: { self: false } } });

      channel.on('postgres_changes', { event: '*', schema: 'public', table: ctx.table }, payload => {
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
      });

      ctx.channel = channel;
      return channel;
    } catch (e) {
      console.warn('subscribe error', e);
      throw e;
    }
  }

  // Public API: create, update, delete helpers that also push to Supabase
  async function create(obj) {
    if (!ctx.supabase) await waitForSupabase();
    const now = new Date().toISOString();
    const row = Object.assign({}, obj);
    row[ctx.key] = row[ctx.key] || uid('m_');
    row.created_at = row.created_at || now;
    row.last_modified = row.last_modified || now;

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
      const { data, error } = await ctx.supabase.from(ctx.table).update(toSend).eq(ctx.key, id).select();
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
        await ctx.supabase.from('profiles').upsert({ id: uid, last_sync_at: now, last_sync_device: device, last_sync_payload: JSON.stringify(payload) }, { onConflict: 'id' });
      } catch (e) {
        // fallback: try update
        try { await ctx.supabase.from('profiles').update({ last_sync_at: now, last_sync_device: device, last_sync_payload: JSON.stringify(payload) }).eq('id', uid); } catch(_){}
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

    // try to subscribe immediately
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

  // Install public API on window
  window.supabaseSync = {
    init,
    create,
    update,
    remove,
    mergeRow, // useful for apps that want to inject server rows manually
    _ctx: ctx,
  };

  // Auto-init default table so adding the script enables basic behavior out of the box.
  // If you want a different table or key, call supabaseSync.init({table:'chats', key:'uuid'}) after login.
  setTimeout(() => {
    waitForSupabase(8000).then(sup => {
      ctx.supabase = sup;
      // try to init but ignore errors
      init().catch(()=>{});
    }).catch(()=>{
      console.info('Supabase client not found; supabaseSync will wait until client is available.');
    });
  }, 50);

})();
