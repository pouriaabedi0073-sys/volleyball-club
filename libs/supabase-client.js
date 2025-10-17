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
      const storagePath = `${email}/${backupId}-${timestamp}.json.gz`;

      // Upload compressed snapshot
      const { error: uploadError } = await this.supabase.storage
        .from(this.bucket)
        .upload(storagePath, compressed, {
          contentType: 'application/gzip',
          cacheControl: '3600'
        });

      if (uploadError) throw uploadError;

      // Record backup metadata
      const { error: insertError } = await this.supabase
        .from('backups')
        .insert({
          id: backupId,
          group_email: email,
          storage_path: storagePath,
          snapshot_summary: summary,
          size_bytes: compressed.byteLength
        });

      if (insertError) throw insertError;

      // Mark as latest shared backup
      await this.supabase.rpc('mark_shared_backup', {
        p_group_email: email,
        p_backup_id: backupId
      });

      return { backupId, summary };

    } catch (error) {
      console.error('Backup failed:', error);
      throw error;
    }
  }

  // Merge downloaded backup with current state
  async mergeBackup(backupId) {
    try {
      // Get backup metadata
      const { data: backup, error: fetchError } = await this.supabase
        .from('backups')
        .select('*')
        .eq('id', backupId)
        .single();

      if (fetchError) throw fetchError;
      if (!backup) throw new Error(`Backup ${backupId} not found`);

      // Download and decompress
      const { data, error: downloadError } = await this.supabase.storage
        .from(this.bucket)
        .download(backup.storage_path);

      if (downloadError) throw downloadError;

      const decompressed = await this.decompressData(data);
      const snapshot = JSON.parse(decompressed);

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
      
      const { data, error } = await this.supabase
        .from('shared_backups')
        .select(\`
          group_email,
          latest_backup_id,
          backups!inner (
            id,
            snapshot_summary,
            created_at
          )
        \`)
        .eq('group_email', email)
        .single();

      if (error) throw error;
      return data;

    } catch (error) {
      console.error('Failed to get latest backup:', error);
      throw error;
    }
  }

  // Restore state from a backup (overwrites current state)
  async restoreBackup(backupId) {
    try {
      // Get backup metadata
      const { data: backup, error: fetchError } = await this.supabase
        .from('backups')
        .select('*')
        .eq('id', backupId)
        .single();

      if (fetchError) throw fetchError;
      if (!backup) throw new Error(`Backup ${backupId} not found`);

      // Download and decompress
      const { data, error: downloadError } = await this.supabase.storage
        .from(this.bucket)
        .download(backup.storage_path);

      if (downloadError) throw downloadError;

      const decompressed = await this.decompressData(data);
      const snapshot = JSON.parse(decompressed);

      // Replace entire state with snapshot
      window.state = { ...window.state, ...snapshot };

      return backup.snapshot_summary;

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
      
      const { data, error } = await this.supabase
        .from('backups')
        .select('*')
        .eq('group_email', email)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return data;

    } catch (error) {
      console.error('Failed to list backups:', error);
      throw error;
    }
  }
}