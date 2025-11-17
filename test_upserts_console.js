// test_upserts_console.js
// Paste this into browser DevTools console (after login to staging) to run sample upserts.
// It runs upserts for devices, shared_backups and backups and logs results.
(async function(){
  if (!window.supabase) return console.error('window.supabase not found');
  const client = window.supabase;
  try {
    console.log('Checking for legacy `devices` table...');
    try {
      const probe = await client.from('devices').select('id').limit(1);
      if (probe && probe.error) throw probe.error;
      console.log('Running device upsert...');
      const dev = await client.from('devices').upsert([{
        user_id: '11111111-1111-1111-1111-111111111111',
        device_id: 'device-abc-001',
        device_name: 'Chrome Desktop',
        last_seen: new Date().toISOString(),
        group_email: 'team@example.com'
      }], { onConflict: 'user_id,device_id' }).select();
      console.log('devices upsert result', dev);
    } catch(e) { console.warn('Skipping devices upsert (table may not exist)', e); }

    console.log('Running shared_backups upsert... (skipped in storage-only mode)');
    /*
    const sb = await client.from('shared_backups').upsert([{
      group_email: 'team@example.com',
      data: { players: [], sessions: [] },
      device_id: 'device-abc-001',
      last_sync_at: new Date().toISOString()
    }], { onConflict: 'group_email' }).select();
    console.log('shared_backups upsert result', sb);
    */

    console.log('Attempting to insert backup metadata (legacy `data` column may not exist)...');
    try {
      // Probe backups table for 'data' column by selecting it
      // Probe and insert into backups table skipped in storage-only mode
      /*
      const probe = await client.from('backups').select('data').limit(1);
      if (probe && probe.error) throw probe.error;
      const bk = await client.from('backups').insert([{
        user_id: '11111111-1111-1111-1111-111111111111',
        group_email: 'team@example.com',
        data: { players: [], sessions: [] },
        device_id: 'device-abc-001',
        operation: 'sync',
        revision: 1
      }]).select();
      console.log('backups insert result', bk);
      */
    } catch(e) { console.warn('Skipping legacy backups.data insert (table/column may be absent)', e); }

    console.log('Done tests.');
  } catch (e) {
    console.error('Test upserts failed', e);
    if (e && e.error) console.error('Server error detail', e.error);
  }
})();
