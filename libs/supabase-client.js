// supabase-client.js - Implements JSON snapshot-based backup system
import { createClient } from '@supabase/supabase-js';

/**
 * SupabaseClient - JSON snapshot-based backup system
 * New version: Stores entire app state as compressed JSON snapshots
 * - Uses 3 tables: profiles, backups, shared_backups
 * - Compresses all data with pako before upload
 * - RLS enforces group_email access control
 */

export class SupabaseClient {
  constructor(supabaseUrl, supabaseKey) {
    this.supabase = createClient(supabaseUrl, supabaseKey);
    this.bucket = 'backups';
  }

  // Get current user's email (used for RLS)
  async getCurrentUserEmail() {
    const { data: { user }, error } = await this.supabase.auth.getUser();
    if (error) throw error;
    return user.email.toLowerCase();
  }

  // Create a complete JSON snapshot of app state
  async createBackup() {
    try {
      const email = await this.getCurrentUserEmail();
      
      // Capture full app state
      const snapshot = {
        players: window.state?.players || [],
        sessions: window.state?.sessions || [],
        payments: window.state?.payments || [],
        // Add any other state tables here
      };

      // Create summary for quick server-side queries
      const summary = {
        tables: Object.keys(snapshot),
        row_counts: {},
        total_size_kb: 0,
        created_at: new Date().toISOString()
      };

      // Count rows per table
      for (const table of summary.tables) {
        summary.row_counts[table] = snapshot[table]?.length || 0;
      }

      // Compress the snapshot
      const jsonStr = JSON.stringify(snapshot);
      const compressed = await this.compressData(jsonStr);
      summary.total_size_kb = Math.round(compressed.byteLength / 1024);

      // Generate unique ID and storage path
      const backupId = crypto.randomUUID();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      // prefer user.id as storage folder
      const { data: userRes } = await this.supabase.auth.getUser().catch(() => ({}));
      const userId = userRes && userRes.data && userRes.data.user ? userRes.data.user.id : null;
      const storagePath = `${userId || email}/${backupId}-${timestamp}.json.gz`;

      // Upload compressed snapshot to Storage (storage-only backups)
      const { error: uploadError } = await this.supabase.storage
        .from(this.bucket)
        .upload(storagePath, compressed instanceof Blob ? compressed : new Blob([compressed]), {
          contentType: 'application/gzip',
          cacheControl: '3600'
        });

      if (uploadError) throw uploadError;

      // Storage-only: we do not insert metadata into DB. Return the storage path.
      return { backupId, summary, storagePath };

    } catch (error) {
      console.error('Backup failed:', error);
      throw error;
    }
  }

  // Merge downloaded backup with current state
  async mergeBackup(backupId) {
    try {
      // Try to find a storage file that contains the backupId under the user's prefix
      const { data: userRes } = await this.supabase.auth.getUser().catch(() => ({}));
      const userId = userRes && userRes.data && userRes.data.user ? userRes.data.user.id : null;
      const prefix = userId || this.groupEmail;
      let snapshot = null;
      try {
        const { data: files } = await this.supabase.storage.from(this.bucket).list(prefix, { limit: 100 });
        const candidate = (files || []).find(f => f.name && f.name.indexOf(backupId) !== -1);
        if (!candidate) throw new Error('backup not found');
        const fp = `${prefix}/${candidate.name}`;
        const { data: fileData, error: downloadError } = await this.supabase.storage.from(this.bucket).download(fp);
        if (downloadError) throw downloadError;
        const text = await fileData.text();
        try { snapshot = JSON.parse(text); } catch (_) { snapshot = JSON.parse(await this.decompressData(fileData)); }
      } catch (e) { throw e; }

      // Merge each table into window.state
      for (const table of Object.keys(snapshot)) {
        if (!window.state[table]) window.state[table] = [];
        window.state[table] = this.mergeArrays(
          window.state[table],
          snapshot[table],
          'id',
          'last_modified'
        );
      }

      return backup.snapshot_summary;

    } catch (error) {
      console.error('Merge failed:', error);
      throw error;
    }
  }

  // Get latest backup for a group
  async getLatestGroupBackup() {
    try {
      const email = await this.getCurrentUserEmail();
      // حذف شد: direct DB join query against `shared_backups` and `backups`
      // const { data, error } = await this.supabase
      //   .from('shared_backups')
      //   .select(`
      //     group_email,
      //     latest_backup_id,
      //     backups!inner (
      //       id,
      //       snapshot_summary,
      //       created_at
      //     )
      //   `)
      //   .eq('group_email', email)
      //   .single();
      // if (error) throw error;
      // return data;

      // Storage-based fallback: list files under user's prefix and return latest file info
      try {
        const { data: userRes } = await this.supabase.auth.getUser().catch(() => ({}));
        const userId = userRes && userRes.data && userRes.data.user ? userRes.data.user.id : null;
        const prefix = userId || email;
        const { data: files, error } = await this.supabase.storage.from(this.bucket).list(prefix, { limit: 1, sortBy: { column: 'created_at', order: 'desc' } });
        if (error) throw error;
        if (!files || files.length === 0) return null;
        return { group_email: email, latest_file: files[0].name, created_at: files[0].created_at };
      } catch (se) {
        console.error('Failed to get latest backup from storage:', se);
        throw se;
      }

    } catch (error) {
      console.error('Failed to get latest backup:', error);
      throw error;
    }
  }

  // Restore state from a backup (overwrites current state)
  async restoreBackup(backupId) {
    try {
      // Find and download storage file by scanning user's prefix for backupId
      const { data: userRes } = await this.supabase.auth.getUser().catch(() => ({}));
      const userId = userRes && userRes.data && userRes.data.user ? userRes.data.user.id : null;
      const prefix = userId || this.groupEmail;
      try {
        const { data: files } = await this.supabase.storage.from(this.bucket).list(prefix, { limit: 100 });
        const candidate = (files || []).find(f => f.name && f.name.indexOf(backupId) !== -1);
        if (!candidate) throw new Error(`Backup ${backupId} not found`);
        const fp = `${prefix}/${candidate.name}`;
        const { data: fileData, error: downloadError } = await this.supabase.storage.from(this.bucket).download(fp);
        if (downloadError) throw downloadError;
        const text = await fileData.text();
        const snapshot = JSON.parse(text);
        // Replace entire state with snapshot
        window.state = { ...window.state, ...snapshot };
        return candidate;
      } catch (e) { throw e; }

    } catch (error) {
      console.error('Restore failed:', error);
      throw error;
    }
  }

  // Utility: Merge arrays by key, keeping newest by timestamp
  mergeArrays(existing, incoming, keyField = 'id', timestampField = 'last_modified') {
    const merged = [...existing];
    const existingMap = new Map(existing.map(x => [x[keyField], x]));

    for (const item of incoming) {
      const key = item[keyField];
      const existingItem = existingMap.get(key);

      if (!existingItem) {
        // New item
        merged.push(item);
      } else if (new Date(item[timestampField]) > new Date(existingItem[timestampField])) {
        // Incoming is newer
        const idx = merged.findIndex(x => x[keyField] === key);
        merged[idx] = item;
      }
    }

    return merged;
  }

  // Utility: Compress data using pako
  async compressData(data) {
    // Use dynamic import for pako
    const pako = (await import('./pako.min.js')).default;
    return pako.gzip(data);
  }

  // Utility: Decompress data using pako
  async decompressData(compressed) {
    const pako = (await import('./pako.min.js')).default;
    return pako.ungzip(compressed, { to: 'string' });
  }

  // List all backups for current group
  async listGroupBackups() {
    try {
      const email = await this.getCurrentUserEmail();
      
      // List files in storage under user's prefix
      const { data: userRes } = await this.supabase.auth.getUser().catch(() => ({}));
      const userId = userRes && userRes.data && userRes.data.user ? userRes.data.user.id : null;
      const prefix = userId || email;
      const { data: files, error } = await this.supabase.storage.from(this.bucket).list(prefix, { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });
      if (error) throw error;
      return files;

    } catch (error) {
      console.error('Failed to list backups:', error);
      throw error;
    }
  }
}