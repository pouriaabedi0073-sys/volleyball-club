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
    // Collect all data from localStorage
    const snapshot = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      try {
        snapshot[key] = JSON.parse(localStorage.getItem(key));
      } catch (e) {
        snapshot[key] = localStorage.getItem(key);
      }
    }

    // Add metadata
    const summary = {
      tables: Object.keys(snapshot),
      row_counts: {},
      total_size_kb: 0
    };

    // Calculate row counts and size
    for (const [table, data] of Object.entries(snapshot)) {
      summary.row_counts[table] = Array.isArray(data) ? data.length : 1;
      summary.total_size_kb += Math.round(JSON.stringify(data).length / 1024);
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

      const { error: insertError } = await this.client
        .from('backups')
        .insert({
          backup_id: backupId,
          user_id: userId,
          device_id: deviceId,
          group_email: this.groupEmail,
          backup_data: snapshot,
          snapshot_summary: summary,
          size_bytes: (snapshotJson && snapshotJson.length) ? snapshotJson.length : null
        });

      if (insertError) throw insertError;

      // Call cleanup RPC to keep only last N backups (server-side cleanup function)
      try {
        await this.client.rpc('cleanup_old_backups', { p_email: this.groupEmail });
      } catch (e) {
        // Non-fatal: cleanup failure shouldn't block backup success
        console.debug('cleanup_old_backups rpc failed', e);
      }

      // Mark shared backup pointer (best-effort)
      try {
        await this.client.rpc('mark_shared_backup', { p_group_email: this.groupEmail, p_backup_id: backupId });
      } catch (e) { console.debug('mark_shared_backup rpc failed', e); }

      // success: update lastBackupTime/hash and clear pending
      this._lastBackupTime = Date.now();
      this._lastSnapshotHash = snapshotHash;
      this._pendingBackup = false;

      return { ok: true, backupId, summary };

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

    const { data, error } = await this.client
      .from('backups')
      .select('backup_data')
      .eq('group_email', email)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) throw new Error('No backup found');

    await this.restoreData(data.backup_data);
    console.log('✅ Backup restored successfully');
    return { ok: true };
  }

  // Restore from a specific backup_id
  async restoreById(backupId) {
    if (!backupId) throw new Error('backupId required');
    const email = await this.getCurrentUserEmail();
    if (!email) throw new Error('No user email available');

    const { data, error } = await this.client
      .from('backups')
      .select('backup_data')
      .eq('group_email', email)
      .eq('backup_id', backupId)
      .single();

    if (error || !data) throw new Error('Backup not found');
    await this.restoreData(data.backup_data);
    console.log('✅ Backup restored from ID:', backupId);
    return { ok: true };
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
      if (!snapshot || typeof snapshot !== 'object') throw new Error('Invalid snapshot');
      for (const [key, value] of Object.entries(snapshot)) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch(e) { console.debug('localStorage set failed for', key, e); }
      }
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
      const { data, error } = await this.client.from('shared_backups').select('latest_backup_id').eq('group_email', this.groupEmail).maybeSingle();
      if (error) { console.debug('hasRemoteBackup query error', error); return false; }
      return !!(data && data.latest_backup_id);
    } catch (e) { console.warn('hasRemoteBackup failed', e); return false; }
  }

  // Check if local storage has app data (basic heuristic)
  localHasData() {
    try {
      // Heuristic: check for any keys beyond known app shell keys
      const keys = Object.keys(localStorage || {});
      if (!keys || keys.length === 0) return false;
      // ignore simple settings keys
      const ignore = new Set(['autoImportToggle','device_id','__app_version']);
      for (const k of keys) {
        if (!ignore.has(k) && (localStorage.getItem(k) !== null)) return true;
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
    const keys = Object.keys(localStorage || {});
    for (const k of keys) {
      if (String(k).startsWith('backup-') || k === 'backup:pendingUploads') {
        try { localStorage.removeItem(k); } catch(_){ }
      }
    }
    return true;
  } catch(e) { console.warn('clearLocalBackups failed', e); return false; }
}

export const MIN_BACKUP_INTERVAL_MS = 0; // No minimum interval between backups