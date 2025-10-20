// src/backup/index.js - migrated from sync-backup.js
// Exports a BackupSync class and a default singleton instance (backupSync)

export class BackupSync {
  constructor(supabaseClient, options = {}) {
    this.client = supabaseClient;
    this.groupEmail = null;
    this.options = {
      bucketName: 'backups',
      compression: true,
      ...options
    };
    try {
      this.storageKey = this.options.storageKey || (typeof STORAGE_KEY !== 'undefined' ? STORAGE_KEY : null) || 'vb_dashboard_v8';
    } catch (e) {
      this.storageKey = this.options.storageKey || 'vb_dashboard_v8';
    }
    this._lastBackupTime = 0;
    this._pendingBackup = false;
    this._lastSnapshotHash = null;
  }

  setGroupEmail(email) {
    if (!email) throw new Error('Group email is required');
    this.groupEmail = email.toLowerCase();
  }

  async createSnapshot() {
    const snapshot = { tables: {}, meta: { created_at: new Date().toISOString() }, raw: {} };
    try {
      try { snapshot.meta.source = await this.getOrCreateDeviceId(); } catch (_) { }

      if (typeof window !== 'undefined' && window.state && typeof window.state === 'object') {
        for (const [k, v] of Object.entries(window.state)) {
          if (Array.isArray(v)) snapshot.tables[k] = v;
        }
      } else {
        try {
          const mainKey = this.storageKey || 'vb_dashboard_v8';
          const raw = localStorage.getItem(mainKey);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && parsed.tables && typeof parsed.tables === 'object') {
              snapshot.tables = parsed.tables;
            } else if (parsed && typeof parsed === 'object') {
              for (const [k, v] of Object.entries(parsed)) {
                if (Array.isArray(v)) snapshot.tables[k] = v;
              }
            }
          }
          try {
            const mainKey = this.storageKey || 'vb_dashboard_v8';
            const mainRaw = localStorage.getItem(mainKey);
            if (mainRaw) {
              try { snapshot.raw[mainKey] = JSON.parse(mainRaw); } catch(_) { snapshot.raw[mainKey] = mainRaw; }
            }
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

    const summary = { tables: Object.keys(snapshot.tables), row_counts: {}, total_size_kb: 0 };
    for (const [table, rows] of Object.entries(snapshot.tables)) {
      summary.row_counts[table] = Array.isArray(rows) ? rows.length : 0;
      try { summary.total_size_kb += Math.round(JSON.stringify(rows).length / 1024); } catch(_){ }
    }

    try { const rawKeys = Object.keys(snapshot.raw || {}); if (rawKeys.length) summary.raw_keys = rawKeys; } catch(_){ }

    return { snapshot, summary };
  }

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

  generateBackupId() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
    return `backup-${timestamp}-${Math.random().toString(36).slice(2, 7)}`;
  }

  async createBackup(options = {}) {
    if (!this.groupEmail) throw new Error('Group email not set');
    if (!this.client) throw new Error('Supabase client not initialized');
    if (!options.force) {
      console.debug('createBackup: skipped (automatic backups disabled)');
      return { ok: false, reason: 'auto-disabled' };
    }
    if (this._pendingBackup) {
      console.debug('createBackup: pending backup in progress, skipping');
      return { ok: false, reason: 'pending' };
    }
    try {
      const { snapshot, summary } = await this.createSnapshot();
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

      try { await this.client.rpc('cleanup_old_backups', { p_email: this.groupEmail }); } catch (e) { console.debug('cleanup_old_backups rpc failed', e); }
      try { await this.client.rpc('mark_shared_backup', { p_group_email: this.groupEmail, p_backup_id: backupId }); } catch (e) { console.debug('mark_shared_backup rpc failed', e); }

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

  async getCurrentUserEmail() {
    try {
      if (this.client && this.client.auth && typeof this.client.auth.getUser === 'function') {
        const ud = await this.client.auth.getUser();
        const user = ud && ud.data && ud.data.user ? ud.data.user : null;
        if (user && user.email) return (user.email || '').toLowerCase();
      }
      if (this.groupEmail) return this.groupEmail;
    } catch (e) { console.debug('getCurrentUserEmail failed', e); }
    return null;
  }

  async restoreData(snapshot) {
    try {
      if (!snapshot || typeof snapshot !== 'object') { console.warn('restoreData: invalid snapshot'); return false; }
      const tables = snapshot.tables || (snapshot && snapshot.backup_data && snapshot.backup_data.tables) || null;
      if (!tables) {
        if (typeof snapshot === 'object' && Object.keys(snapshot).length > 0 && Object.keys(snapshot).every(k => Array.isArray(snapshot[k]))) { snapshot = { tables: snapshot }; }
      }
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
            if (!existing) { local.push(row); map.set(row.id, row); } else {
              const a = new Date(existing.last_modified || 0).getTime();
              const b = new Date(row.last_modified || 0).getTime();
              if (b >= a) { const idx = local.findIndex(x => x && x.id === row.id); if (idx !== -1) local[idx] = Object.assign({}, existing, row); }
            }
          }
        }
      } catch (e) { console.debug('restoreData: merge into window.state failed', e); }

      try {
        const mainKey = (typeof window !== 'undefined' && window.STORAGE_KEY) ? window.STORAGE_KEY : (this.storageKey || 'vb_dashboard_v8');
        const storageObj = {};
        for (const [k, v] of Object.entries(window.state)) { if (Array.isArray(v)) storageObj[k] = v; }
        try { localStorage.setItem(mainKey, JSON.stringify(storageObj)); } catch (e) { console.warn('restoreData: failed to persist merged state', e); }
        try { if (snapshot.meta && snapshot.meta.source) { try { localStorage.setItem('device_id', JSON.stringify(snapshot.meta.source)); } catch(_){ } } if (snapshot.vb_device_id_v1) { try { localStorage.setItem('vb_device_id_v1', JSON.stringify(snapshot.vb_device_id_v1)); } catch(_){ } } } catch (_) {}
      } catch (e) { console.debug('restoreData: persist merged state failed', e); }

      try {
        if (snapshot && snapshot.raw && typeof snapshot.raw === 'object') {
          for (const [k, v] of Object.entries(snapshot.raw)) {
            if (!k) continue;
            if (/auth|token|sb-/.test(k)) continue;
            try { localStorage.setItem(k, JSON.stringify(v)); } catch(e) { console.debug('restoreData: failed to restore raw key', k, e); }
          }
        }
      } catch (_) {}

      try {
        if (typeof state !== 'undefined' && typeof window !== 'undefined' && typeof window.state !== 'undefined') {
          try { Object.assign(state, window.state); console.log('🔁 Merged window.state into global state'); } catch (mergeErr) { console.debug('restoreData: failed to merge window.state into state', mergeErr); }
        }
        try { if (typeof saveState === 'function') { try { saveState(); console.log('💾 Auto-saved merged state via saveState()'); } catch (sErr) { console.debug('restoreData: saveState() threw', sErr); } } } catch (_) {}
      } catch (_) {}

      try {
        try { if (typeof window.state === 'object') { if (typeof state === 'object') Object.assign(state, window.state); if (typeof saveState === 'function') { try { saveState(); console.log('� LocalStorage saved after restore'); } catch(sErr) { console.debug('saveState failed', sErr); } } } } catch (syncErr) { console.debug('post-restore state sync failed', syncErr); }
        if (typeof renderHome === 'function') { console.log('🎨 Rendering Home after restore...'); renderHome(); } else if (typeof renderPlayersPage === 'function') { console.log('🎨 Rendering Players after restore...'); renderPlayersPage(); } else if (typeof renderCoaches === 'function') { console.log('🎨 Rendering Coaches after restore...'); renderCoaches(); } else if (typeof renderSessionsPage === 'function') { console.log('🎨 Rendering Sessions after restore...'); renderSessionsPage(); } else { console.warn('⚠️ No UI render function found — manual reload may be needed.'); }
      } catch (err) { console.error('❌ Post-restore render failed:', err); }

      console.log('✅ restoreData merge complete');
      return true;
    } catch (e) { console.error('restoreData failed', e); throw e; }
  }

  async flushPendingUploads() { return true; }

  async mergeGroupBackups(groupEmail) { if (groupEmail) this.setGroupEmail(groupEmail); return this.restoreFromLatest(); }

  async getOrCreateDeviceId() {
    try {
      const key = 'device_id';
      let id = null;
      try { id = localStorage.getItem(key); } catch(e) { id = null; }
      if (id) return id;
      try { if (typeof crypto !== 'undefined' && crypto.randomUUID) { id = crypto.randomUUID(); } else { id = 'dev_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8); } } catch (e) { id = 'dev_' + Date.now(); }
      try { localStorage.setItem(key, id); } catch(e){}
      return id;
    } catch (e) { console.warn('getOrCreateDeviceId failed', e); return null; }
  }

  async hasRemoteBackup() {
    if (!this.groupEmail) return false;
    try {
      const { data, error } = await this.client.from('shared_backups').select('latest_backup_id').eq('group_email', this.groupEmail).maybeSingle();
      if (error) { console.debug('hasRemoteBackup query error', error); return false; }
      return !!(data && data.latest_backup_id);
    } catch (e) { console.warn('hasRemoteBackup failed', e); return false; }
  }

  localHasData() {
    try {
      const key = this.storageKey || 'vb_dashboard_v8';
      const raw = localStorage.getItem(key);
      if (raw === null || raw === undefined) return false;
      try { const obj = JSON.parse(raw); if (obj && (Array.isArray(obj.players) || Array.isArray(obj.competitions) || Object.keys(obj).length > 0)) return true; } catch (e) { return true; }
      return false;
    } catch (e) { console.warn('localHasData failed', e); return false; }
  }

  async promptRestoreIfNoLocalData(options = {}) {
    try {
      const hasLocal = this.localHasData();
      const hasRemote = await this.hasRemoteBackup();
      if (!hasLocal && hasRemote) {
        try {
          const ok = confirm('هیچ دادهٔ محلی پیدا نشد، آیا مایل به بازیابی آخرین پشتیبان مشترک هستید؟');
          if (ok) { await this.restoreFromLatest(); if (options.showSuccess) { try { alert('بازیابی انجام شد'); } catch(_){ } } }
        } catch(e) { console.warn('prompt/restore flow failed', e); }
      }
      return { hasLocal, hasRemote };
    } catch (e) { console.warn('promptRestoreIfNoLocalData failed', e); return { hasLocal: true, hasRemote: false }; }
  }
}

function resolveSupabaseClient() {
  try {
    if (typeof window === 'undefined') return null;
    if (window.supabaseClient && typeof window.supabaseClient.from === 'function') return window.supabaseClient;
    if (window.supabase && typeof window.supabase.from === 'function') return window.supabase;
    if (typeof supabase !== 'undefined' && supabase && typeof supabase.createClient === 'function') {
      const url = window.SUPABASE_URL || 'https://wtycgduarwpgnxxvwtgz.supabase.co';
      const key = window.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind0eWNnZHVhcndwZ254eHZ3dGd6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgzMDMyNzUsImV4cCI6MjA3Mzg3OTI3NX0.uqjl1qWII_Yzw86uOHlesjH0YP4AL4QMhjFItPb2DjU';
      const c = supabase.createClient(url, key);
      window.supabaseClient = c;
      return c;
    }
  } catch (e) { console.warn('resolveSupabaseClient failed', e); }
  return null;
}

const backupSync = new BackupSync(resolveSupabaseClient());

export default backupSync;

export function clearLocalBackups() {
  try { try { localStorage.removeItem('backup:pendingUploads'); } catch(_){ } return true; } catch(e) { console.warn('clearLocalBackups failed', e); return false; }
}

export const MIN_BACKUP_INTERVAL_MS = 0;
