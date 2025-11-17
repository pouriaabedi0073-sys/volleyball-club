#!/usr/bin/env node
/*
  tools/clear_backups_bucket.js

  Usage:
    set SUPABASE_URL=https://your-project.supabase.co
    set SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
    node tools/clear_backups_bucket.js --confirm

  WARNING: This will DELETE objects from the `backups` bucket. Use with care.
*/

(async () => {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm') || args.includes('-y');
  if (!confirm) {
    console.error('This script will delete objects from the `backups` bucket.');
    console.error('Run again with `--confirm` to proceed.');
    process.exit(2);
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables.');
    process.exit(1);
  }

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const bucket = 'backups';

  try {
    console.log('Listing top-level entries in bucket...');
    const { data: topList, error: topErr } = await supabase.storage.from(bucket).list('', { limit: 100 });
    if (topErr) throw topErr;

    const toDelete = [];

    for (const entry of topList || []) {
      // If this entry looks like a file (contains a dot), treat as file at root.
      if (entry.name && entry.name.indexOf('.') !== -1) {
        toDelete.push(entry.name);
        continue;
      }

      // Treat entry.name as a folder prefix and attempt to list inside it.
      const prefix = entry.name || entry.id || '';
      if (!prefix) continue;

      const { data: children, error: childrenErr } = await supabase.storage.from(bucket).list(prefix, { limit: 100 });
      if (childrenErr) throw childrenErr;
      for (const f of children || []) {
        // build full path: prefix + '/' + f.name
        const path = `${prefix}/${f.name}`;
        toDelete.push(path);
      }
    }

    if (toDelete.length === 0) {
      console.log('No objects found to delete.');
      process.exit(0);
    }

    console.log(`Will delete ${toDelete.length} object(s) from bucket '${bucket}'.`);

    // remove in batches of 100 (Supabase supports up to 100 paths per remove call)
    const batchSize = 100;
    for (let i = 0; i < toDelete.length; i += batchSize) {
      const batch = toDelete.slice(i, i + batchSize);
      console.log(`Deleting batch ${i / batchSize + 1} (${batch.length} items)...`);
      const { data, error } = await supabase.storage.from(bucket).remove(batch);
      if (error) {
        console.error('Error deleting batch:', error);
        process.exit(1);
      }
    }

    console.log('Deletion complete.');
  } catch (err) {
    console.error('Error:', err.message || err);
    process.exit(1);
  }

})();
