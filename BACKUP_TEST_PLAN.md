# Backup / Merge / Restore - Staging Test Plan

This test plan verifies the new backup-focused schema and the client `backup.js` implementation.
Run these steps in a staging environment. Ensure you have a Supabase project configured and a `backups` storage
bucket created with public or appropriate ACLs.

Prerequisites
- Deploy `all_supabase_combined.sql` to staging DB (run the file via psql or Supabase SQL editor).
- Ensure storage bucket `backups` exists in Supabase Storage.
- Serve the updated client assets (include `backup.js` and `pako` on the page).
- Confirm `window.supabase` client is configured and authenticated in browser.

Test Steps

1) Smoke: scheduleDaily and createBackup (online)
- Open browser console and run:
  - await window.backupClient.createBackup({ groupEmail: 'test@example.com' })
- Expect: returns { ok: true, id: '<id>' } and console shows upload progress.
- Verify in Supabase UI Storage: file exists under `test%40example.com/<id>.json.gz`.
- Verify `backups` table row exists with matching `id` and `storage_path`.
- Verify `shared_backups` row for `test@example.com` updated with `latest_backup_id`.

2) Offline persistence and flush
- Simulate offline: turn off network (or use browser devtools) and run:
  - await window.backupClient.createBackup({ groupEmail: 'test@example.com' })
- Expect: returns { ok: 'pending', id }
- Check localStorage: localStorage.getItem('backup:pendingUploads') should include the item.
- Re-enable network; open console and run:
  - await window.backupClient.flushPendingUploads()
- Expect: pending item uploaded and removed from localStorage; backups table has row.

3) Merge latest group backup
- Ensure page has `window.state` with a different/dummy player entry removed from server.
- In console run:
  - await window.backupClient.mergeGroupBackups('test@example.com')
- Expect: function downloads latest backup, decompresses, and merges into `window.state`.
- Inspect `window.state.players` and confirm rows from snapshot are present.

4) Restore specific backup and sync
- In console run:
  - await window.backupClient.restoreBackup('<backup-id>', { sync: true })
- Expect: snapshot merged into window.state and small-batch upserts to server executed.
- Verify server tables (players, sessions, payments, devices) contain expected rows.

5) Purge old backups server-side
- In Supabase SQL run:
  - SELECT public.purge_old_backups(7);
- Expect: older backups removed but the newest per group_email retained.
- Validate: backups with created_at older than 7 days deleted except the group's newest.

Validation Criteria
- Backups are compressed and stored in Storage bucket.
- Backups table rows are created/updated with correct storage_path and metadata.
- shared_backups.latest_backup_id references the latest backup for the group.
- Offline-created backups are persisted to localStorage and later flushed.
- Merges use last_modified to resolve conflicts and update window.state.
- purge_old_backups keeps the most recent backup per group_email even if older than the threshold.

Troubleshooting
- If storage upload fails with 403/401: verify Supabase client credentials and storage policy.
- If pako is missing: include pako via CDN in index.html: e.g.
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js"></script>
- If backups table rows not created: check RLS policies and ensure the authenticated JWT email matches group_email.

Notes
- This implementation avoids heavy realtime subscriptions to minimize limits on free Supabase plans. Discovery is handled via `shared_backups` record and client-side polling or lightweight fetches.
- For large datasets, consider incremental snapshots or per-table diffs instead of full-state backups.
