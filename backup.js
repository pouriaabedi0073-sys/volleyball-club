/* backup.js
 * Client-side backup/restore/merge utilities for the PWA.
 * - createBackup(): snapshot window.state (selected tables), compress with pako.gzip,
 *   upload to Supabase Storage (bucket: backups) when online or persist pending locally.
 * - mergeGroupBackups(groupEmail): fetch latest shared_backups.latest_backup_id, download storage blob,
 *   decompress, and merge into window.state using id + last_modified (latest wins).
 * - restoreBackup(backupId): manual trigger to download/decompress and merge then sync.
 * - flushPendingUploads(): try pending local uploads when back online.
 * - scheduleDaily(): schedule daily createBackup() interval.
 *
 * Notes:
 * - This file expects `window.supabase` client to exist and pako (https://github.com/nodeca/pako) to be
 *   available on the page (e.g. via <script src="https://cdnjs.cloudflare.com/.../pako.min.js"></script>).
 * - Offline resilience: pending uploads stored in localStorage key 'backup:pendingUploads'.
 */
(function(){
  const LOG = (...args) => { try { console.debug('[backup.js]', ...args); } catch(e) {} };
  const BUCKET = 'backups';
  const PENDING_KEY = 'backup:pendingUploads';
  const SNAPSHOT_TABLES = ['players','sessions','payments','devices'];

  function uid(prefix='b_') { try { return (crypto && crypto.randomUUID) ? crypto.randomUUID() : prefix + Date.now().toString(36) + Math.random().toString(36).slice(2,8); } catch(e){ return prefix + Date.now(); } }

  function getPending() { try { const raw = localStorage.getItem(PENDING_KEY); return raw ? JSON.parse(raw) : []; } catch(e){ return []; } }
  function savePending(arr){ try { localStorage.setItem(PENDING_KEY, JSON.stringify(arr || [])); } catch(e){} }

  // Snapshot selected tables from window.state (or localStorage fallback)
  function buildSnapshot() {
    const snapshot = { meta: { created_at: new Date().toISOString() }, tables: {} };
    try {
      window.state = window.state || {};
      for (const t of SNAPSHOT_TABLES) {
        const arr = window.state[t] || window.state[t.replace('_','')] || [];
        snapshot.tables[t] = Array.isArray(arr) ? arr.map(r=>({ ...r })) : [];
      }
    } catch(e) { LOG('buildSnapshot failed', e); }
    return snapshot;
  }

  // compress using pako.gzip (returns Uint8Array)
  function compressJson(obj) {
    try {
      const json = JSON.stringify(obj);
      if (typeof pako === 'undefined' || !pako.gzip) throw new Error('pako.gzip not available');
      return pako.gzip(json);
    } catch(e) { LOG('compressJson failed', e); throw e; }
  }

  // decompress Uint8Array to JSON
  function decompressToJson(u8) {
    try {
      if (typeof pako === 'undefined' || !pako.ungzip) throw new Error('pako.ungzip not available');
      const dec = pako.ungzip(u8, { to: 'string' });
      return JSON.parse(dec);
    } catch(e) { LOG('decompressToJson failed', e); throw e; }
  }

  async function uploadToStorage(client, path, bytesU8) {
    try {
      // Legacy storage upload removed. Instead insert a row into backups with backup_data JSON
      const json = (typeof bytesU8 === 'string') ? bytesU8 : (typeof bytesU8 === 'object' ? bytesU8 : null);
      // If bytesU8 is Uint8Array, attempt to decode to string
      if (!json && bytesU8 && typeof bytesU8.buffer !== 'undefined') {
        try { json = new TextDecoder().decode(bytesU8); } catch(_) { json = null; }
      }
      if (!json) throw new Error('uploadToStorage: unable to decode bytes to JSON');
      // attempt to parse json to object
      let obj = null;
      try { obj = JSON.parse(json); } catch(_) { obj = json; }
      const id = uid();
      try {
        // attempt to attach user_id from session
        let uid = null;
        try { const su = await client.auth.getUser(); const suUser = su && su.data && su.data.user; if (suUser && suUser.id) uid = suUser.id; } catch(_){ }
        const row = { id, backup_id: id, group_email: path.split('/')[0] || null, backup_data: obj, created_at: new Date().toISOString() };
        if (uid) row.user_id = uid;
        const insertRes = await client.from('backups').insert([row]);
        
      } catch (e) { throw e; }
      if (insertRes && insertRes.error) throw insertRes.error;
      return true;
    } catch(e) { LOG('uploadToStorage (DB insert) failed', e); throw e; }
  }

  async function downloadFromStorage(client, path) {
    try {
      // path expected to include group/email prefix and backup id. We'll try to find by storage_path or backup_id
      // Try by storage_path field first
      let q = await client.from('backups').select('backup_data').eq('storage_path', path).maybeSingle();
      if (q && !q.error && q.data && q.data.backup_data) return q.data.backup_data;
      // fallback: try by id (last segment of path)
      const maybeId = (path || '').split('/').pop();
      if (maybeId) {
        const r = await client.from('backups').select('backup_data').eq('backup_id', maybeId).maybeSingle();
        if (r && !r.error && r.data && r.data.backup_data) return r.data.backup_data;
      }
      throw new Error('downloadFromStorage: backup not found');
    } catch(e) { LOG('downloadFromStorage (DB) failed', e); throw e; }
  }

  // Upsert backups table entry (and mark shared_backups)
  async function recordBackupMeta(client, id, groupEmail, storagePath, summary, sizeBytes, revision) {
    try {
      const payload = { id, group_email: groupEmail, storage_path: storagePath, snapshot_summary: summary, size_bytes: sizeBytes, revision };
      // Insert backup row
      const up = await client.from('backups').upsert([payload], { onConflict: 'id' }).select();
      if (up && up.error) throw up.error;
      // mark shared_backups for discovery
      try { await client.rpc('mark_shared_backup', { p_group_email: groupEmail, p_backup_id: id }); } catch(e) { LOG('mark_shared_backup rpc failed', e); }
      return up;
    } catch(e) { LOG('recordBackupMeta failed', e); throw e; }
  }

  // createBackup: snapshot -> compress -> upload or persist pending
  async function createBackup(options = {}) {
    const client = (window.supabase && window.supabase.storage) ? window.supabase : null;
    const groupEmail = (options.groupEmail || (window.user && window.user.email) || (window.state && window.state.profile && window.state.profile.email));
    if (!groupEmail) throw new Error('groupEmail required to create a backup');

    const snapshot = buildSnapshot();
    // small summary: table counts and top-level timestamps
    const summary = Object.keys(snapshot.tables).reduce((acc, k) => { acc[k] = (snapshot.tables[k] || []).length; return acc; }, {});
    const id = uid();
    const fileName = `${encodeURIComponent(groupEmail)}/${id}.json.gz`;
    let bytes = null;
    try {
      bytes = compressJson(snapshot); // Uint8Array
    } catch (e) { throw e; }

    // Try to insert directly into backups table when online
    if (navigator.onLine && window.supabase) {
      try {
        try {
          let uid = null;
          try { const su = await window.supabase.auth.getUser(); const suUser = su && su.data && su.data.user; if (suUser && suUser.id) uid = suUser.id; } catch(_){ }
          const row = { id, backup_id: id, group_email: groupEmail, backup_data: snapshot, snapshot_summary: summary, size_bytes: bytes.length, created_at: new Date().toISOString() };
          if (uid) row.user_id = uid;
          const up = await window.supabase.from('backups').insert([row]);
          if (up && up.error) throw up.error;
          LOG('createBackup: inserted into backups table', id);
          // call cleanup RPC best-effort
          try { await window.supabase.rpc('cleanup_old_backups', { p_email: groupEmail }); } catch(e){ LOG('cleanup_old_backups rpc failed', e); }
          return { ok: true, id };
        } catch (e) {
          LOG('createBackup insert failed, saving pending', e);
          // fall through to save pending
        }
        if (up && up.error) throw up.error;
        LOG('createBackup: inserted into backups table', id);
        // call cleanup RPC best-effort
        try { await window.supabase.rpc('cleanup_old_backups', { p_email: groupEmail }); } catch(e){ LOG('cleanup_old_backups rpc failed', e); }
        return { ok: true, id };
      } catch (e) {
        LOG('createBackup insert failed, saving pending', e);
        // fall through to save pending
      }
    }

    // Save pending (base64 for portability)
    try {
      const base64 = bytesToB64(bytes);
      const pend = getPending();
      pend.push({ id, groupEmail, fileName, base64, created_at: new Date().toISOString(), revision: options.revision || 1, size_bytes: bytes.length });
      savePending(pend);
      LOG('createBackup: saved pending upload', id);
      return { ok: 'pending', id };
    } catch (e) { LOG('createBackup: save pending failed', e); throw e; }
  }

  // flushPendingUploads: attempt to upload any pending items
  async function flushPendingUploads() {
    if (!navigator.onLine || !window.supabase) return false;
    const pend = getPending();
    if (!pend || pend.length === 0) return true;
    for (let i = 0; i < pend.length; ++i) {
      const item = pend[i];
      try {
        const bytes = b64ToBytes(item.base64);
        // attempt to insert into backups table
        const json = new TextDecoder().decode(bytes);
        let obj = null;
        try { obj = JSON.parse(json); } catch(_) { obj = json; }
        try {
          let uid = null;
          try { const su = await window.supabase.auth.getUser(); const suUser = su && su.data && su.data.user; if (suUser && suUser.id) uid = suUser.id; } catch(_){ }
          const row = { id: item.id, backup_id: item.id, group_email: item.groupEmail, backup_data: obj, created_at: new Date().toISOString() };
          if (uid) row.user_id = uid;
          const up = await window.supabase.from('backups').insert([row]);
          if (up && up.error) throw up.error;
          LOG('flushPendingUploads: inserted pending backup', item.id);
        } catch (e) { throw e; }
        if (up && up.error) throw up.error;
        // remove from pending
        pend.splice(i,1); i--;
        LOG('flushPendingUploads: inserted pending backup', item.id);
      } catch (e) {
        LOG('flushPendingUploads: item upload failed, will retry later', item.id, e);
      }
    }
    savePending(pend);
    return true;
  }

  // mergeGroupBackups: fetch latest via shared_backups, download, decompress, merge into window.state
  async function mergeGroupBackups(groupEmail, options = {}) {
    if (!groupEmail) throw new Error('groupEmail required');
    if (!window.supabase) throw new Error('Supabase client required');

    try {
      // read shared_backups record
      const r = await window.supabase.from('shared_backups').select('latest_backup_id').eq('group_email', groupEmail).maybeSingle();
      if (r.error) throw r.error;
      const latestId = r && r.data ? r.data.latest_backup_id : null;
      if (!latestId) { LOG('mergeGroupBackups: no latest backup id for', groupEmail); return { ok: false, reason: 'no_latest' }; }

  // fetch backup_data directly from backups table
  const bm = await window.supabase.from('backups').select('backup_data').eq('backup_id', latestId).maybeSingle();
  if (bm.error) throw bm.error;
  const snap = bm && bm.data ? bm.data.backup_data : null;
      // merge by id/last_modified
      mergeSnapshotIntoState(snap, options);
      return { ok: true, snapshot: snap };
    } catch (e) {
      LOG('mergeGroupBackups failed', e);
      throw e;
    }
  }

  function mergeSnapshotIntoState(snapshot, options = {}) {
    try {
      window.state = window.state || {};
      const tables = snapshot.tables || {};
      for (const t of Object.keys(tables)) {
        const incoming = tables[t] || [];
        window.state[t] = window.state[t] || [];
        const local = window.state[t];
        // Index local by id for quick merge
        const map = new Map(local.map(r => [r.id, r]));
        for (const row of incoming) {
          if (!row || !row.id) continue;
          const existing = map.get(row.id);
          if (!existing) {
            local.push(row);
            map.set(row.id, row);
          } else {
            const a = new Date(existing.last_modified || 0).getTime();
            const b = new Date(row.last_modified || 0).getTime();
            if (b >= a) {
              // replace
              const idx = local.findIndex(x => x && x.id === row.id);
              if (idx !== -1) local[idx] = Object.assign({}, existing, row);
            }
          }
        }
      }
      // optional: trigger UI render if host exposes renderHome
      try { if (typeof window.renderHome === 'function') window.renderHome(); } catch(_){}
    } catch(e) { LOG('mergeSnapshotIntoState failed', e); }
  }

  // restoreBackup: download specific backupId and merge then optionally sync to server
  async function restoreBackup(backupId, options = {}) {
    if (!backupId) throw new Error('backupId required');
    if (!window.supabase) throw new Error('Supabase client required');
    try {
      const bm = await window.supabase.from('backups').select('backup_data').eq('backup_id', backupId).maybeSingle();
      if (bm.error) throw bm.error;
      const snap = bm && bm.data ? bm.data.backup_data : null;
      if (!snap) throw new Error('backup not found');
      mergeSnapshotIntoState(snap, options);

      // Optionally push merged state to server in small batches
      if (options.sync === true) {
        await syncMergedStateToServer(options);
      }
      return { ok: true };
    } catch (e) { LOG('restoreBackup failed', e); throw e; }
  }

  // syncMergedStateToServer: naive small-batch sync using upsert with onConflict
  async function syncMergedStateToServer(options = {}) {
    if (!window.supabase) throw new Error('Supabase client required');
    const client = window.supabase;
    const tables = SNAPSHOT_TABLES;
    const batchSize = options.batchSize || 50;
    for (const t of tables) {
      try {
        const rows = (window.state && window.state[t]) ? window.state[t] : [];
        for (let i=0;i<rows.length;i+=batchSize) {
          const chunk = rows.slice(i,i+batchSize).map(r => ({ ...r }));
          // safe upsert: conflict keys: players/sessions/payments/devices default to id
          await client.from(t).upsert(chunk, { onConflict: 'id' });
          LOG('syncMergedStateToServer: upserted chunk', t, i);
        }
      } catch (e) { LOG('syncMergedStateToServer failed for', t, e); }
    }
    return true;
  }

  // small helpers for base64 conversions
  function bytesToB64(u8) { let s=''; for (let i=0;i<u8.length;i+=0x8000) s += String.fromCharCode.apply(null, u8.slice(i, i+0x8000)); return btoa(s); }
  function b64ToBytes(b64) { const bin = atob(b64); const len = bin.length; const u8 = new Uint8Array(len); for (let i=0;i<len;i++) u8[i]=bin.charCodeAt(i); return u8; }

  // schedule daily backups
  function scheduleDaily() {
    try {
      if (window._backupDailyInterval) return window._backupDailyInterval;
      window._backupDailyInterval = setInterval(() => {
        try { createBackup().catch(e => LOG('daily createBackup failed', e)); } catch(e) { LOG('daily schedule error', e); }
      }, 86400000);
      return window._backupDailyInterval;
    } catch (e) { LOG('scheduleDaily failed', e); }
  }

  // Expose functions on window
  window.backupClient = {
    createBackup,
    flushPendingUploads,
    mergeGroupBackups,
    restoreBackup,
    scheduleDaily,
    _internal: { buildSnapshot, compressJson, decompressToJson },
    // New helpers: getDeviceId, saveBackup, loadLatestBackup
    getDeviceId: function() {
      try {
        let deviceId = null;
        try { deviceId = localStorage.getItem('device_id'); } catch(_) { deviceId = null; }
        if (!deviceId) {
          try { deviceId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'dev_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8); } catch(_) { deviceId = 'dev_' + Date.now(); }
          try { localStorage.setItem('device_id', deviceId); } catch(_){}
        }
        return deviceId;
      } catch(e) { LOG('getDeviceId failed', e); return null; }
    },
    saveBackup: async function(options = {}) {
      try {
        if (!window.supabase) throw new Error('Supabase client not available');
        const user = window.state && window.state.user ? window.state.user : (window.currentUser || {});
        const email = options.groupEmail || user.email || (window.currentUser && window.currentUser.email) || null;
        const user_id = user.id || (window.currentUser && window.currentUser.id) || null;
        if (!email) throw new Error('groupEmail required to save backup');

        const device_id = window.backupClient.getDeviceId();
        const mainKey = options.storageKey || (window.STORAGE_KEY || 'vb_dashboard_v8');
        const localData = (() => { try { return JSON.parse(localStorage.getItem(mainKey) || '{}'); } catch(_) { return {}; } })();

        const payload = {
          backup_id: options.id || (Date.now().toString(36) + Math.random().toString(36).slice(2,8)),
          group_email: email.toLowerCase(),
          user_id: user_id,
          device_id: device_id,
          backup_data: localData,
          size_bytes: (new Blob([JSON.stringify(localData)])).size,
          created_at: new Date().toISOString()
        };

        const res = await window.supabase.from('backups').insert([payload]);
        if (res && res.error) throw res.error;
        LOG('saveBackup: saved', payload.backup_id);
        return { ok: true, id: payload.backup_id };
      } catch (e) { LOG('saveBackup failed', e); throw e; }
    },
    loadLatestBackup: async function(options = {}) {
      try {
        if (!window.supabase) throw new Error('Supabase client not available');
        const user = window.state && window.state.user ? window.state.user : (window.currentUser || {});
        const email = options.groupEmail || user.email || (window.currentUser && window.currentUser.email) || null;
        if (!email) throw new Error('groupEmail required to load backup');

        const q = await window.supabase.from('backups').select('backup_data, created_at').eq('group_email', email.toLowerCase()).order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (q.error) throw q.error;
        const data = q && q.data ? q.data.backup_data : null;
        if (!data) return { ok: false, reason: 'no_backup' };

        // Safe restore: write only the main app key and device id entries
        const mainKey = options.storageKey || (window.STORAGE_KEY || 'vb_dashboard_v8');
        try { localStorage.setItem(mainKey, JSON.stringify(data)); } catch(e){ LOG('loadLatestBackup: failed to set mainKey', e); }
        try { if (data && data.device_id) localStorage.setItem('device_id', JSON.stringify(data.device_id)); } catch(_){}
        try { if (data && data.vb_device_id_v1) localStorage.setItem('vb_device_id_v1', JSON.stringify(data.vb_device_id_v1)); } catch(_){}

        // Hydrate in-memory state and trigger render helpers
        try { window.state = data; } catch(_){}
        try { if (typeof window.mergeSnapshotIntoState === 'function') window.mergeSnapshotIntoState({ tables: data }); } catch(_){}
        try { if (typeof window.loadStateFromStorage === 'function') window.loadStateFromStorage(); } catch(_){}
        try { if (typeof window.renderAll === 'function') window.renderAll(); } catch(_){}

        LOG('loadLatestBackup: restored backup from', q && q.data && q.data.created_at);
        return { ok: true };
      } catch (e) { LOG('loadLatestBackup failed', e); throw e; }
    }
  };

  // Attempt flush pending when coming online
  window.addEventListener && window.addEventListener('online', () => { try { flushPendingUploads(); } catch(_){} });

})();
