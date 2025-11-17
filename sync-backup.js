// sync-backup.js - ES6 Module for JSON snapshot-based sync
// Handles full JSON snapshots with Supabase Storage + minimal DB tables

export class BackupSync {
  constructor(supabaseClient, options = {}) {
    this.client = supabaseClient;
    this.groupEmail = null;
    this.options = {
      bucketName: 'backups',
      compression: true,
      ...options
    };
    // Prefer an explicit storageKey passed in options. Otherwise try to read
    // a global STORAGE_KEY (set by the main app) and finally fall back to
    // the legacy key used by the app.
    try {
      this.storageKey = this.options.storageKey || (typeof STORAGE_KEY !== 'undefined' ? STORAGE_KEY : null) || 'vb_dashboard_v8';
    } catch (e) {
      // If accessing STORAGE_KEY throws, fall back to default
      this.storageKey = this.options.storageKey || 'vb_dashboard_v8';
    }
    this._lastBackupTime = 0;
    this._pendingBackup = false;
    this._lastSnapshotHash = null;
  }

  // Set the group email for syncing
  setGroupEmail(email) {
    if (!email) throw new Error('Group email is required');
    this.groupEmail = email.toLowerCase();
  }

  // Create a snapshot of all data
  async createSnapshot() {
    // Build a normalized snapshot in the form { tables: { ... }, meta: { ... }, raw: { ... } }
    const snapshot = { tables: {}, meta: { created_at: new Date().toISOString() }, raw: {} };
    try {
      // include source device id if available
      try { snapshot.meta.source = await this.getOrCreateDeviceId(); } catch (_) { }

      // Prefer in-memory state when available (consistent with backup.js)
      if (typeof window !== 'undefined' && window.state && typeof window.state === 'object') {
        for (const [k, v] of Object.entries(window.state)) {
          if (Array.isArray(v)) snapshot.tables[k] = v;
        }
      } else {
        // Fallback: read app main key from localStorage and convert into tables
        try {
          const mainKey = this.storageKey || 'vb_dashboard_v8';
          const raw = localStorage.getItem(mainKey);
          if (raw) {
            const parsed = JSON.parse(raw);
            // if parsed already has 'tables', adopt it
            if (parsed && typeof parsed === 'object' && parsed.tables && typeof parsed.tables === 'object') {
              snapshot.tables = parsed.tables;
            } else if (parsed && typeof parsed === 'object') {
              // convert top-level arrays into tables
              for (const [k, v] of Object.entries(parsed)) {
                if (Array.isArray(v)) snapshot.tables[k] = v;
              }
            }
          }
          // Only read the app's main storage key to avoid scanning unrelated localStorage keys.
          try {
            const mainKey = this.storageKey || 'vb_dashboard_v8';
            const mainRaw = localStorage.getItem(mainKey);
            if (mainRaw) {
              try { snapshot.raw[mainKey] = JSON.parse(mainRaw); } catch(_) { snapshot.raw[mainKey] = mainRaw; }
            }
            // Minimal explicit extras (do NOT scan all keys). Add only known safe keys.
            const safeExtras = ['recentLoginEmails', 'vb_device_id_v1'];
            for (const k of safeExtras) {
              try {
                const v = localStorage.getItem(k);
                if (v === null || v === undefined) continue;
                try { snapshot.raw[k] = JSON.parse(v); } catch (_) { snapshot.raw[k] = v; }
              } catch(_) {}
            }
          } catch(_) {}
        } catch (e) { console.debug('createSnapshot fallback parse failed', e); }
      }

    } catch (e) {
      console.debug('createSnapshot failed', e);
    }

    // Build summary
    const summary = { tables: Object.keys(snapshot.tables), row_counts: {}, total_size_kb: 0 };
    for (const [table, rows] of Object.entries(snapshot.tables)) {
      summary.row_counts[table] = Array.isArray(rows) ? rows.length : 0;
      try { summary.total_size_kb += Math.round(JSON.stringify(rows).length / 1024); } catch(_){}

    // include raw keys in summary counts
    try {
      const rawKeys = Object.keys(snapshot.raw || {});
      if (rawKeys.length) summary.raw_keys = rawKeys;
    } catch(_){}
    }

    return { snapshot, summary };
  }

  // Compress data using CompressionStream if available
  async compressData(data) {
    if (!this.options.compression) return data;

    const jsonString = JSON.stringify(data);
    const bytes = new TextEncoder().encode(jsonString);
    
    if (typeof CompressionStream === 'undefined') {
      console.warn('CompressionStream not available, using uncompressed data');
      return bytes;
    }

    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    
    return new Response(cs.readable).arrayBuffer();
  }

  // Decompress data using DecompressionStream if available
  async decompressData(compressed) {
    if (!this.options.compression) return compressed;

    if (typeof DecompressionStream === 'undefined') {
      console.warn('DecompressionStream not available');
      return compressed;
    }

    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(compressed);
    writer.close();
    
    const decompressed = await new Response(ds.readable).arrayBuffer();
    const text = new TextDecoder().decode(decompressed);
    return JSON.parse(text);
  }

  // Generate a unique backup ID
  generateBackupId() {
    const timestamp = new Date().toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .replace('Z', '');
    return `backup-${timestamp}-${Math.random().toString(36).slice(2, 7)}`;
  }

  // Create and upload a new backup
  async createBackup(options = {}) {
    if (!this.groupEmail) throw new Error('Group email not set');
    if (!this.client) throw new Error('Supabase client not initialized');

    // Only proceed if force=true or if it's a manual backup
    if (!options.force) {
      console.debug('createBackup: skipped (automatic backups disabled)');
      return { ok: false, reason: 'auto-disabled' };
    }

    // Simplified throttle - only check for pending backup
    if (this._pendingBackup) {
      console.debug('createBackup: pending backup in progress, skipping');
      return { ok: false, reason: 'pending' };
    }

    try {
      // Create snapshot (uncompressed JSON stored directly in DB)
      const { snapshot, summary } = await this.createSnapshot();

      // Simple dedupe: hash snapshot JSON and skip if identical to last snapshot
      let snapshotJson = JSON.stringify(snapshot);
      let snapshotHash = null;
      try {
        if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
          const data = new TextEncoder().encode(snapshotJson);
          const hashBuf = await crypto.subtle.digest('SHA-256', data);
          snapshotHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,'0')).join('');
        } else {
          snapshotHash = String(snapshotJson.length) + ':' + (snapshotJson.slice(0,200));
        }
      } catch(e) { snapshotHash = String(snapshotJson.length); }
      if (this._lastSnapshotHash && this._lastSnapshotHash === snapshotHash) {
        console.debug('createBackup: identical snapshot to last backup, skipping');
        return { ok: false, reason: 'nochange' };
      }

      this._pendingBackup = true;
      const backupId = this.generateBackupId();

      // Insert backup directly into the backups table as JSON payload
      let userId = null;
      try {
        if (this.client && this.client.auth && typeof this.client.auth.getUser === 'function') {
          const ud = await this.client.auth.getUser();
          userId = ud && ud.data && ud.data.user ? ud.data.user.id : null;
        }
      } catch (e) { console.debug('getUser failed', e); }

      const deviceId = await this.getOrCreateDeviceId();

      // Upload snapshot to Supabase Storage (storage-only backups)
      try {
        // use user.id as the storage folder prefix
        const folder = userId || this.groupEmail || 'anon';
        const fileName = `${backupId}.json.gz`;
        const filePath = `${folder}/${fileName}`;
        // prefer compressed payload when compression enabled
        let blob;
        try {
          if (this.options.compression) {
            const compressed = await this.compressData(snapshot);
            blob = compressed instanceof Blob ? compressed : new Blob([compressed], { type: 'application/gzip' });
          } else {
            blob = new Blob([JSON.stringify(snapshot)], { type: 'application/json' });
          }
        } catch (cErr) {
          blob = new Blob([JSON.stringify(snapshot)], { type: 'application/json' });
        }
        const { error: uploadError } = await this.client.storage.from(this.options.bucketName).upload(filePath, blob, { upsert: true });
        if (uploadError) throw uploadError;
        // Best-effort: try cleanup/mark RPCs but do not fail backup if they error
        // cleanup_old_backups RPC removed in storage-only migration (no-op)
        // mark_shared_backup RPC removed in storage-only migration (no-op)

        // success: update lastBackupTime/hash and clear pending
        this._lastBackupTime = Date.now();
        this._lastSnapshotHash = snapshotHash;
        this._pendingBackup = false;

        // Best-effort client-side prune: keep only the 2 newest backups for this user
        try {
          const folderPrefix = userId || this.groupEmail || 'anon';
          if (typeof window !== 'undefined' && typeof window.pruneOldBackups === 'function') {
            try { await window.pruneOldBackups(folderPrefix); } catch(e) { console.debug('window.pruneOldBackups failed', e); }
          } else {
            try {
              const { data: files, error: listError } = await this.client.storage.from(this.options.bucketName).list(folderPrefix, { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });
              if (!listError && files && files.length > 2) {
                const backups = files.filter(f => f && f.name && (f.name.endsWith('.json.gz') || f.name.endsWith('.json')));
                if (backups.length > 2) {
                  const toDelete = backups.slice(2).map(f => `${folderPrefix}/${f.name}`);
                  if (toDelete.length) {
                    try { await this.client.storage.from(this.options.bucketName).remove(toDelete); } catch(remE) { console.debug('prune remove failed', remE); }
                  }
                }
              }
            } catch(e) { console.debug('client-side prune failed', e); }
          }
        } catch (e) { console.debug('prune after upload failed', e); }

        return { ok: true, backupId, summary };
      } catch (e) {
        console.error('Storage upload failed, saving pending locally', e);
        // save pending locally as fallback (use user.id folder and .json.gz suffix)
        try { savePendingBackupLocal(`${userId || this.groupEmail}/${backupId}.json.gz`, JSON.stringify(snapshot), { created_at: new Date().toISOString(), snapshot }); } catch(_){ }
        this._pendingBackup = false;
        return { ok: false, reason: 'pending' };
      }

    } catch (error) {
      console.error('Backup creation failed:', error);
      this._pendingBackup = false;
      return { ok: false, reason: (error && error.message) ? error.message : String(error) };
    }
  }

  // Restore from latest backup for this group (reads backup_data JSON from backups table)
  async restoreFromLatest() {
    const email = await this.getCurrentUserEmail();
    if (!email) throw new Error('No user email available');

    // Attempt to find latest backup in Storage for the user
      try {
        const uid = (await this.client.auth.getUser()).data?.user?.id;
        if (!uid) throw new Error('No user');
        const folder = uid;
        const { data: files, error: listError } = await this.client.storage.from(this.options.bucketName).list(folder, { limit: 1, sortBy: { column: 'created_at', order: 'desc' } });
        if (listError || !files || files.length === 0) throw new Error('No backup found');
        const fp = `${folder}/${files[0].name}`;
        const { data: fileData, error: downloadError } = await this.client.storage.from(this.options.bucketName).download(fp);
        if (downloadError) throw downloadError;
        // try decompressing if gzipped, otherwise parse text
        try {
          const ab = await fileData.arrayBuffer();
          const parsed = await this.decompressData(new Uint8Array(ab));
          await this.restoreData(parsed);
        } catch (inner) {
          const text = await fileData.text();
          const snap = JSON.parse(text);
          await this.restoreData(snap);
        }
        console.log('✅ Backup restored successfully');
        return { ok: true };
      } catch (e) { throw e; }
  }

  // Restore from a specific backup_id
  async restoreById(backupId) {
    if (!backupId) throw new Error('backupId required');
    const email = await this.getCurrentUserEmail();
    if (!email) throw new Error('No user email available');

    try {
      const uid = (await this.client.auth.getUser()).data?.user?.id;
      if (!uid) throw new Error('No user');
      const folder = uid;
      const candidate = `${folder}/${backupId}.json.gz`;
      let snap = null;
      try {
        const { data: fileData, error: downloadError } = await this.client.storage.from(this.options.bucketName).download(candidate);
        if (!downloadError) {
          try {
            const ab = await fileData.arrayBuffer();
            const parsed = await this.decompressData(new Uint8Array(ab));
            snap = parsed;
          } catch (dErr) {
            const text = await fileData.text(); snap = JSON.parse(text);
          }
        }
      } catch (_) { /* ignore */ }
      if (!snap) throw new Error('Backup not found');
      await this.restoreData(snap);
      console.log('✅ Backup restored from ID:', backupId);
      return { ok: true };
    } catch (e) { throw e; }
  }

  // Helper: get current user's email (resolve via auth/profile if possible)
  async getCurrentUserEmail() {
    try {
      if (this.client && this.client.auth && typeof this.client.auth.getUser === 'function') {
        const ud = await this.client.auth.getUser();
        const user = ud && ud.data && ud.data.user ? ud.data.user : null;
        if (user && user.email) return (user.email || '').toLowerCase();
      }
      // fallback to configured groupEmail
      if (this.groupEmail) return this.groupEmail;
    } catch (e) { console.debug('getCurrentUserEmail failed', e); }
    return null;
  }

  // Helper: restoreData applies a snapshot object into localStorage
  async restoreData(snapshot) {
    try {
      if (!snapshot || typeof snapshot !== 'object') {
        console.warn('restoreData: invalid snapshot');
        return false;
      }

      // Expect normalized snapshot: { tables: { players: [...], sessions: [...] }, meta: {...} }
      const tables = snapshot.tables || (snapshot && snapshot.backup_data && snapshot.backup_data.tables) || null;
      if (!tables) {
        // If caller passed an older shape where snapshot itself is the tables object, accept that
        if (typeof snapshot === 'object' && Object.keys(snapshot).length > 0 && Object.keys(snapshot).every(k => Array.isArray(snapshot[k]))) {
          // snapshot is already tables
          snapshot = { tables: snapshot };
        }
      }

      // Merge into window.state by id with last_modified semantics
      try {
        window.state = window.state || {};
        const tbls = (snapshot && snapshot.tables) ? snapshot.tables : (typeof snapshot === 'object' ? snapshot : {});
        for (const [table, rows] of Object.entries(tbls)) {
          if (!Array.isArray(rows)) continue;
          window.state[table] = window.state[table] || [];
          const local = window.state[table];
          const map = new Map(local.map(r => [r.id, r]));
          for (const row of rows) {
            if (!row || !row.id) continue;
            const existing = map.get(row.id);
            if (!existing) {
              local.push(row);
              map.set(row.id, row);
            } else {
              const a = new Date(existing.last_modified || 0).getTime();
              const b = new Date(row.last_modified || 0).getTime();
              if (b >= a) {
                const idx = local.findIndex(x => x && x.id === row.id);
                if (idx !== -1) local[idx] = Object.assign({}, existing, row);
              }
            }
          }
        }
      } catch (e) { console.debug('restoreData: merge into window.state failed', e); }

      // Persist merged state back into localStorage under main key (do not overwrite auth tokens)
      try {
        const mainKey = (typeof window !== 'undefined' && window.STORAGE_KEY) ? window.STORAGE_KEY : (this.storageKey || 'vb_dashboard_v8');
        // Build a storage object: include only top-level arrays (tables)
        const storageObj = {};
        for (const [k, v] of Object.entries(window.state)) {
          if (Array.isArray(v)) storageObj[k] = v;
        }
        try { localStorage.setItem(mainKey, JSON.stringify(storageObj)); } catch (e) { console.warn('restoreData: failed to persist merged state', e); }

        // Optionally persist device ids if present in snapshot.meta
        try {
          if (snapshot.meta && snapshot.meta.source) {
            try { localStorage.setItem('device_id', JSON.stringify(snapshot.meta.source)); } catch(_){}
          }
          if (snapshot.vb_device_id_v1) {
            try { localStorage.setItem('vb_device_id_v1', JSON.stringify(snapshot.vb_device_id_v1)); } catch(_){}
          }
        } catch (_) {}
      } catch (e) { console.debug('restoreData: persist merged state failed', e); }

      // Restore any 'raw' keys included in the snapshot, but do not overwrite auth tokens
      try {
        if (snapshot && snapshot.raw && typeof snapshot.raw === 'object') {
          for (const [k, v] of Object.entries(snapshot.raw)) {
            if (!k) continue;
            // Skip known auth keys
            if (/auth|token|sb-/.test(k)) continue;
            try { localStorage.setItem(k, JSON.stringify(v)); } catch(e) { console.debug('restoreData: failed to restore raw key', k, e); }
          }
        }
      } catch (_) {}

      // Ensure the app's primary `state` variable is synced with window.state
      try {
        if (typeof state !== 'undefined' && typeof window !== 'undefined' && typeof window.state !== 'undefined') {
          try {
            // Merge properties from window.state into the app's `state` object
            Object.assign(state, window.state);
            console.log('🔁 Merged window.state into global state');
          } catch (mergeErr) {
            console.debug('restoreData: failed to merge window.state into state', mergeErr);
          }
        }
        // Auto-save if host exposes saveState()
        try {
          if (typeof saveState === 'function') {
            try { saveState(); console.log('💾 Auto-saved merged state via saveState()'); } catch (sErr) { console.debug('restoreData: saveState() threw', sErr); }
          }
        } catch (_) {}
      } catch (_) {}

      // Post-restore: sync state into host and call a page-specific render function
      try {
        // همگام‌سازی stateها
        try {
          if (typeof window.state === 'object') {
            if (typeof state === 'object') Object.assign(state, window.state);
            if (typeof saveState === 'function') {
              try { saveState(); console.log('� LocalStorage saved after restore'); } catch(sErr) { console.debug('saveState failed', sErr); }
            }
          }
        } catch (syncErr) { console.debug('post-restore state sync failed', syncErr); }

        // 🔁 بازسازی UI بعد از بازیابی
        if (typeof renderHome === 'function') {
          console.log('🎨 Rendering Home after restore...');
          renderHome();
        } else if (typeof renderPlayersPage === 'function') {
          console.log('🎨 Rendering Players after restore...');
          renderPlayersPage();
        } else if (typeof renderCoaches === 'function') {
          console.log('🎨 Rendering Coaches after restore...');
          renderCoaches();
        } else if (typeof renderSessionsPage === 'function') {
          console.log('🎨 Rendering Sessions after restore...');
          renderSessionsPage();
        } else {
          console.warn('⚠️ No UI render function found — manual reload may be needed.');
        }
      } catch (err) {
        console.error('❌ Post-restore render failed:', err);
      }

      console.log('✅ restoreData merge complete');
      return true;
    } catch (e) { console.error('restoreData failed', e); throw e; }
  }

  // Compatibility: old code expects flushPendingUploads and mergeGroupBackups
  async flushPendingUploads() {
    // No-op for the new system; backups are created on demand and uploaded immediately.
    return true;
  }

  async mergeGroupBackups(groupEmail) {
    // Alias to restoreFromLatest but scoped to provided groupEmail
    if (groupEmail) this.setGroupEmail(groupEmail);
    return this.restoreFromLatest();
  }

  // Device helper: returns existing device id or creates+saves one
  async getOrCreateDeviceId() {
    try {
      const key = 'device_id';
      let id = null;
      try { id = localStorage.getItem(key); } catch(e) { id = null; }
      if (id) return id;
      // generate UUID v4 fallback
      try {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
          id = crypto.randomUUID();
        } else {
          id = 'dev_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
        }
      } catch (e) { id = 'dev_' + Date.now(); }
      try { localStorage.setItem(key, id); } catch(e){}
      return id;
    } catch (e) { console.warn('getOrCreateDeviceId failed', e); return null; }
  }

  // Check if there is a remote shared backup for this group
  async hasRemoteBackup() {
    if (!this.groupEmail) return false;
    try {
      // حذف شد: direct DB read from `shared_backups` (storage-only)
      // const { data, error } = await this.client.from('shared_backups').select('latest_backup_id').eq('group_email', this.groupEmail).maybeSingle();
      // if (error) { console.debug('hasRemoteBackup query error', error); return false; }
      // return !!(data && data.latest_backup_id);
      // Fallback: check Storage for any backup files under the current user's prefix
      try {
        const su = await this.client.auth.getUser().catch(() => null);
        const user = su && su.data && su.data.user ? su.data.user : null;
        if (!user || !user.email) return false;
        const prefix = String(user.email).replace(/[@.]/g, '_');
        const { data: files, error } = await this.client.storage.from('backups').list(prefix, { limit: 1, sortBy: { column: 'created_at', order: 'desc' } });
        if (error) { console.debug('hasRemoteBackup storage list error', error); return false; }
        return !!(files && files.length > 0);
      } catch (se) { console.debug('hasRemoteBackup storage fallback failed', se); return false; }
    } catch (e) { console.warn('hasRemoteBackup failed', e); return false; }
  }

  // Check if local storage has app data (basic heuristic)
  localHasData() {
    try {
      // Check only the project's main storage key so we don't confuse other
      // JSON data on the device with this project's local DB.
      const key = this.storageKey || 'vb_dashboard_v8';
      const raw = localStorage.getItem(key);
      if (raw === null || raw === undefined) return false;
      // Basic sanity: ensure parsed value looks like the app state (object with players/competitions)
      try {
        const obj = JSON.parse(raw);
        if (obj && (Array.isArray(obj.players) || Array.isArray(obj.competitions) || Object.keys(obj).length > 0)) return true;
      } catch (e) {
        // If it's not JSON, still treat presence as data
        return true;
      }
      return false;
    } catch (e) { console.warn('localHasData failed', e); return false; }
  }

  // Check for restore availability and prompt if needed
  async promptRestoreIfNoLocalData(options = {}) {
    try {
      const hasLocal = this.localHasData();
      const hasRemote = await this.hasRemoteBackup();
      // Show prompt if no local data and remote backup exists
      if (!hasLocal && hasRemote) {
        try {
          const ok = confirm('هیچ دادهٔ محلی پیدا نشد، آیا مایل به بازیابی آخرین پشتیبان مشترک هستید؟');
          if (ok) {
            await this.restoreFromLatest();
            if (options.showSuccess) {
              try { alert('بازیابی انجام شد'); } catch(_){ }
            }
          }
        } catch(e) { console.warn('prompt/restore flow failed', e); }
      }
      return { hasLocal, hasRemote };
    } catch (e) { console.warn('promptRestoreIfNoLocalData failed', e); return { hasLocal: true, hasRemote: false }; }
  }
}

// Resolve Supabase client: prefer window.supabaseClient, then window.supabase (UMD), then try to create one if global 'supabase' factory exists
function resolveSupabaseClient() {
  try {
    if (typeof window === 'undefined') return null;
    if (window.supabaseClient && typeof window.supabaseClient.from === 'function') return window.supabaseClient;
    if (window.supabase && typeof window.supabase.from === 'function') return window.supabase;
    // Try to create a client if UMD factory 'supabase' exists
    if (typeof supabase !== 'undefined' && supabase && typeof supabase.createClient === 'function') {
      const url = window.SUPABASE_URL || 'https://wtycgduarwpgnxxvwtgz.supabase.co';
      const key = window.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind0eWNnZHVhcndwZ254eHZ3dGd6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgzMDMyNzUsImV4cCI6MjA3Mzg3OTI3NX0.uqjl1qWII_Yzw86uOHlesjH0YP4AL4QMhjFItPb2DjU';
      const c = supabase.createClient(url, key);
      window.supabaseClient = c;
      return c;
    }
  } catch (e) {
    console.warn('resolveSupabaseClient failed', e);
  }
  return null;
}

const backupSync = new BackupSync(resolveSupabaseClient());

export default backupSync;

// Utility: clear local backup keys stored in localStorage (names starting with 'backup-' or that key)
export function clearLocalBackups() {
  try {
    // Avoid scanning all localStorage keys. Remove only known backup-related keys.
    try { localStorage.removeItem('backup:pendingUploads'); } catch(_){}
    // If any explicit backup- keys are known in the future, remove them here.
    return true;
  } catch(e) { console.warn('clearLocalBackups failed', e); return false; }
}

export const MIN_BACKUP_INTERVAL_MS = 0; // No minimum interval between backups