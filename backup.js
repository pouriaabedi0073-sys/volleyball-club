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
  const SNAPSHOT_TABLES = [
    'players',
    'coaches',
    'matches',
    'trainingPlans',
    'privateClasses',
    'notifications',
    'volleyballGames',
    'recentLoginEmails',
    'sessions',
    'payments',
    'devices'
  ];

  function uid(prefix='b_') { try { return (crypto && crypto.randomUUID) ? crypto.randomUUID() : prefix + Date.now().toString(36) + Math.random().toString(36).slice(2,8); } catch(e){ return prefix + Date.now(); } }

  // localStorage fallback helpers (synchronous)
  function getPending() { try { const raw = localStorage.getItem(PENDING_KEY); return raw ? JSON.parse(raw) : []; } catch(e){ return []; } }
  function savePending(arr){ try { localStorage.setItem(PENDING_KEY, JSON.stringify(arr || [])); } catch(e){} }

  // IndexedDB-aware async helpers. If window.indexedDBQueue is available, use it; otherwise fall back to localStorage.
  async function addPendingItem(item) {
    try {
      if (window.indexedDBQueue && typeof window.indexedDBQueue.addPending === 'function') {
        await window.indexedDBQueue.addPending(item);
        return;
      }
      // fallback: localStorage cannot store Blobs. Convert blob/bytes -> base64 string before saving
      const toSave = Object.assign({}, item);
      if (!toSave.base64 && toSave.blob) {
        try {
          toSave.base64 = await new Promise((resolve, reject) => {
            try {
              const fr = new FileReader();
              fr.onload = () => resolve(String(fr.result || ''));
              fr.onerror = (e) => reject(e);
              fr.readAsDataURL(toSave.blob);
            } catch (e) { reject(e); }
          });
        } catch(e) { LOG('addPendingItem: blob->base64 failed', e); }
      }
      const pend = getPending(); pend.push(toSave); savePending(pend);
      // Try to register a one-off background sync so the service worker can flush pending uploads when online
      try {
        if ('serviceWorker' in navigator && 'SyncManager' in window) {
          try {
            const reg = await navigator.serviceWorker.ready;
            await reg.sync.register('flush-backups');
            LOG('addPendingItem: registered flush-backups sync');
          } catch (e) { LOG('addPendingItem: sync.register failed', e); }
        }
      } catch(e) { LOG('addPendingItem: background sync register error', e); }
    } catch(e) { LOG('addPendingItem failed', e); }
  }

  async function getAllPendingAsync() {
    try {
      if (window.indexedDBQueue && typeof window.indexedDBQueue.getAllPending === 'function') {
        return await window.indexedDBQueue.getAllPending();
      }
      return getPending();
    } catch(e) { LOG('getAllPendingAsync failed', e); return getPending(); }
  }

  async function removePendingById(id) {
    try {
      if (window.indexedDBQueue && typeof window.indexedDBQueue.deletePending === 'function') {
        await window.indexedDBQueue.deletePending(id);
        return;
      }
      const pend = getPending(); const idx = pend.findIndex(p => p && p.id === id); if (idx !== -1) { pend.splice(idx,1); savePending(pend); }
    } catch(e) { LOG('removePendingById failed', e); }
  }

  // Snapshot selected tables from window.state (or localStorage fallback)
  // This async version will optionally process embedded images: resize + convert to WebP
  async function buildSnapshot(opts = {}) {
    const { image = { enabled: true, maxWidth: 256, quality: 0.7 } } = opts || {};
    const mainKey = window.STORAGE_KEY || 'vb_dashboard_v8';
    let fullData = {};
    try { fullData = JSON.parse(localStorage.getItem(mainKey) || '{}'); } catch(e){ fullData = {}; }

    const snapshot = { meta: { created_at: new Date().toISOString(), source: window.backupClient && window.backupClient.getDeviceId ? window.backupClient.getDeviceId() : '' }, tables: {} };
    try {
      window.state = window.state || {};

      // helper: attempts to fetch/convert an image (data: URL or remote URL) to a WebP data URL
      async function convertImageToWebP(input, maxWidth, quality) {
        try {
          if (!input) return input;
          if (typeof input !== 'string') return input;
          if (input.startsWith('data:image/webp')) return input;

          let blob = null;
          if (input.startsWith('data:')) {
            try { const r = await fetch(input); if (!r.ok) throw new Error('dataURL fetch failed'); blob = await r.blob(); } catch(e) { LOG('convertImageToWebP: dataURL->blob failed', e); return input; }
          } else if (/^https?:\/\//i.test(input)) {
            try { const r = await fetch(input, { mode: 'cors' }); if (!r.ok) throw new Error('fetch failed ' + r.status); blob = await r.blob(); } catch(e) { LOG('convertImageToWebP: fetch remote image failed', e); return input; }
          } else {
            return input;
          }

          let imgBitmap = null;
          try { imgBitmap = await createImageBitmap(blob); } catch(e) { LOG('createImageBitmap failed', e); return input; }

          let width = imgBitmap.width; let height = imgBitmap.height;
          if (maxWidth && width > maxWidth) { const ratio = maxWidth / width; width = maxWidth; height = Math.round(height * ratio); }

          const c = document.createElement('canvas'); c.width = width; c.height = height;
          const ctx = c.getContext('2d');
          ctx.drawImage(imgBitmap, 0, 0, width, height);

          const webpBlob = await new Promise((res, rej) => {
            try {
              c.toBlob(b => { if (b) res(b); else rej(new Error('toBlob failed')); }, 'image/webp', typeof quality === 'number' ? quality : 0.7);
            } catch(e) { rej(e); }
          });

          const dataUrl = await new Promise((res, rej) => {
            try {
              const fr = new FileReader();
              fr.onload = () => res(String(fr.result || ''));
              fr.onerror = (e) => rej(e);
              fr.readAsDataURL(webpBlob);
            } catch(e) { rej(e); }
          });
          return dataUrl;
        } catch(e) { LOG('convertImageToWebP failed', e); return input; }
      }

      const imageKeys = ['photo','photo_url','photoUrl','avatar','avatar_url','avatarUrl','image','image_url','imageUrl','picture','picture_url','pictureUrl'];

      // Collect explicit tables first (prefer window.state, then fullData)
      for (const t of SNAPSHOT_TABLES) {
        const arr = window.state[t] || fullData[t] || [];
        if (!Array.isArray(arr)) { snapshot.tables[t] = Array.isArray(fullData[t]) ? fullData[t] : []; continue; }
        const out = [];
        for (const rec of arr) {
          try {
            const copy = Object.assign({}, rec);
            if (image && image.enabled) {
              for (const k of Object.keys(copy)) {
                try {
                  const val = copy[k];
                  if (!val || typeof val !== 'string') continue;
                  const lowk = k.toLowerCase();
                  const looksLikeImageKey = imageKeys.includes(lowk) || /photo|avatar|image|picture/i.test(k);
                  const looksLikeImageValue = /^data:image\//i.test(val) || /^https?:\/\//i.test(val) || /\.(png|jpe?g|gif|bmp|webp)(\?|$)/i.test(val);
                  if (looksLikeImageKey && looksLikeImageValue) {
                    try { copy[k] = await convertImageToWebP(val, image.maxWidth || 1024, image.quality || 0.7); } catch(e){}
                  }
                } catch(e){}
              }
            }
            out.push(copy);
          } catch(e) { LOG('buildSnapshot: copy record failed', e); }
        }
        snapshot.tables[t] = out;
      }

      // Include any remaining top-level keys from fullData to avoid data loss
      for (const key of Object.keys(fullData || {})) {
        if (snapshot.tables[key]) continue;
        try {
          const maybe = fullData[key];
          // preserve arrays as tables, and also include non-array keys under tables for completeness
          snapshot.tables[key] = maybe;
        } catch(e){}
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
      // Upload bytes (or JSON string) to Supabase Storage if possible.
      let json = (typeof bytesU8 === 'string') ? bytesU8 : null;
      if (!json && bytesU8 && typeof bytesU8.buffer !== 'undefined') {
        try { json = new TextDecoder().decode(bytesU8); } catch(_) { json = null; }
      }
      if (!json) throw new Error('uploadToStorage: unable to decode bytes to JSON');
      const obj = (() => { try { return JSON.parse(json); } catch(_) { return json; } })();
      // prefer client.storage if available
      try {
        if (client && client.storage && typeof client.storage.from === 'function') {
          const user = await client.auth.getUser().catch(() => null);
          const uid = user && user.data && user.data.user ? user.data.user.id : null;
          const fileName = `backup_${new Date().toISOString().replace(/[:.]/g,'-')}.json.gz`;
          // Use user.id as the folder prefix (RLS expects uid). If uid is not available, fall back to filename at root.
          const filePath = uid ? `${uid}/${fileName}` : fileName;
          // compress JSON using pako.gzip helper
          const compressed = compressJson(obj);
          const file = new File([compressed], fileName, { type: 'application/gzip' });
          const { error: uploadError } = await client.storage.from(BUCKET).upload(filePath, file, { upsert: true });
          if (uploadError) throw uploadError;
          // Client-side prune: keep only the last 2 backups for this user (Storage triggers don't fire for API uploads)
          try {
            if (uid) await pruneOldBackups(uid, client);
          } catch (pe) { LOG('uploadToStorage: pruneOldBackups failed', pe); }
          // return storage path for callers
          return filePath;
        }
      } catch (e) {
        LOG('uploadToStorage: storage upload failed', e);
      }
      // fallback: try using existing uploadBackupToStorage helper (which also uses storage)
      try {
        const res = await uploadBackupToStorage(obj);
        return res || true;
      } catch (e) {
        LOG('uploadToStorage: uploadBackupToStorage fallback failed', e);
        throw e;
      }
    } catch(e) { LOG('uploadToStorage (DB insert) failed', e); throw e; }
  }

  // --- آپلود بک‌آپ به Supabase Storage + فقط ۲ بک‌آپ آخر ---
  // --- آپلود بک‌آپ با ایمیل (emailSafe) + فقط ۲ فایل آخر ---
  async function uploadBackupToStorage(backupJson) {
    try {
      if (!window.supabase) return console.warn('Supabase client not available');
      const sup = window.supabase;
      const user = (await sup.auth.getUser()).data?.user;

      if (!user) return console.warn('کاربر لاگین نیست');

      const userId = user.id; // use auth.uid() as folder prefix
      const fileName = `backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`;
      // compress backup JSON to gzip
      const compressed = compressJson(backupJson);
      const file = new File([compressed], fileName, { type: 'application/gzip' });
      const filePath = `${userId}/${fileName}`;

      // آپلود
      const { error: uploadError } = await sup.storage.from('backups').upload(filePath, file, { upsert: true });
      if (uploadError && uploadError.message !== 'The resource already exists') throw uploadError;

      // Prune: keep only last 2 backups for this user
      try {
        await pruneOldBackups(userId, sup);
      } catch (pe) {
        LOG('pruneOldBackups failed', pe);
      }

      console.log('بک‌آپ آپلود شد — userId:', userId);
      return filePath;
    } catch (err) {
      console.error('خطا در آپلود بک‌آپ:', err);
      return false;
    }
  }

  // Prune helper: keep only newest 2 backup files in user's folder
  async function pruneOldBackups(userId, supClient) {
    try {
      const sup = supClient || window.supabase;
      if (!sup) throw new Error('Supabase client required for prune');

      const { data: files, error: listError } = await sup.storage
        .from('backups')
        .list(userId, { limit: 100, offset: 0, sortBy: { column: 'created_at', order: 'desc' } });

      if (listError) {
        LOG('pruneOldBackups: list error', listError);
        return;
      }
      if (!files || files.length <= 2) return;

      // consider only .json or .json.gz backup files
      const backupFiles = files.filter(f => f && f.name && (f.name.endsWith('.json.gz') || f.name.endsWith('.json')));
      if (backupFiles.length <= 2) return;

      // If created_at is present, rely on it; otherwise fall back to name sorting
      const enriched = backupFiles.map(f => ({ f, ts: f.created_at ? new Date(f.created_at).getTime() : 0 }));
      enriched.sort((a, b) => {
        if (a.ts && b.ts) return b.ts - a.ts; // desc
        return b.f.name.localeCompare(a.f.name);
      });

      const toDelete = enriched.slice(2).map(x => `${userId}/${x.f.name}`);
      if (toDelete.length === 0) return;

      const { error: removeError } = await sup.storage.from('backups').remove(toDelete);
      if (removeError) LOG('pruneOldBackups: remove error', removeError);
      else LOG('pruneOldBackups: removed', toDelete.length, 'files');
    } catch (e) { LOG('pruneOldBackups failed', e); }
  }

  async function downloadFromStorage(client, path) {
    try {
      // Try to download the file from Supabase Storage
      if (client && client.storage && typeof client.storage.from === 'function') {
        try {
          const { data, error } = await client.storage.from(BUCKET).download(path);
          if (error) throw error;
          // If the file is gzipped (we upload .json.gz), prefer arrayBuffer and decompress
          try {
            const ab = await data.arrayBuffer();
            const u8 = new Uint8Array(ab);
            try {
              const parsed = decompressToJson(u8);
              return parsed;
            } catch (de) {
              // fallback: try treat as text
              try { const txt = new TextDecoder().decode(u8); return JSON.parse(txt); } catch(_) { return txt; }
            }
          } catch (rErr) {
            // older clients may only provide stream/text; fallback to text()
            const text = await data.text();
            try { return JSON.parse(text); } catch(_) { return text; }
          }
        } catch (e) {
          LOG('downloadFromStorage: storage download failed, trying alternatives', e);
        }
      }
      // If storage download failed, attempt to treat path as an id and list files under that folder
      throw new Error('downloadFromStorage: backup not found');
    } catch(e) { LOG('downloadFromStorage (DB) failed', e); throw e; }
  }

  // createBackup: snapshot -> compress -> upload or persist pending
  async function createBackup(options = {}) {
    const client = (window.supabase && window.supabase.storage) ? window.supabase : null;
    const groupEmail = (options.groupEmail || (window.user && window.user.email) || (window.state && window.state.profile && window.state.profile.email));
    if (!groupEmail) throw new Error('groupEmail required to create a backup');

  const snapshot = await buildSnapshot({ image: { enabled: true, maxWidth: 256, quality: 0.7 } });
    // small summary: table counts and top-level timestamps
    const summary = Object.keys(snapshot.tables).reduce((acc, k) => { acc[k] = (snapshot.tables[k] || []).length; return acc; }, {});
    const id = uid();
    const fileName = `${encodeURIComponent(groupEmail)}/${id}.json`;
    let bytes = null;
    let json = null;
    try {
      json = JSON.stringify(snapshot);
      bytes = (typeof TextEncoder !== 'undefined') ? new TextEncoder().encode(json) : null;
      // if TextEncoder unavailable, fall back to string storage later
    } catch (e) { throw e; }

    // Try to upload snapshot to Supabase Storage when online
    if (navigator.onLine && window.supabase) {
      try {
        const backupJson = { userId: (await window.supabase.auth.getUser()).data?.user?.id || null, timestamp: Date.now(), data: snapshot };
        const filePath = await uploadBackupToStorage(backupJson).catch(e => { throw e; });
        LOG('createBackup: uploaded snapshot to storage', filePath);
        // cleanup_old_backups RPC removed in storage-only migration (no-op)
        return { ok: true, id };
      } catch (e) {
        LOG('createBackup storage upload failed, saving pending', e);
        // fall through to save pending
      }
    }

    // Save pending: prefer storing a Blob with JSON in IndexedDB to avoid extra base64 conversions
    try {
      // bytes may be Uint8Array; convert to JSON blob
      let blob = null;
      try {
        if (bytes) blob = new Blob([bytes], { type: 'application/json' });
        else blob = new Blob([json], { type: 'application/json' });
      } catch (be) {
        try { blob = new Blob([json], { type: 'application/json' }); } catch(_) { blob = null; }
      }
      const item = { id, groupEmail, fileName, blob, created_at: new Date().toISOString(), revision: options.revision || 1, size_bytes: (bytes && bytes.length) || (json ? json.length : 0) };
      await addPendingItem(item);
      LOG('createBackup: saved pending upload', id);
      return { ok: 'pending', id };
    } catch (e) { LOG('createBackup: save pending failed', e); throw e; }
  }

  // Combined helper: ensure both snapshot-based backup and full localStorage backup are saved
  async function createAndSaveBackup(options = {}) {
    try {
      // create snapshot-based backup first
      const res = await createBackup(options).catch(e => { LOG('createBackup failed inside createAndSaveBackup', e); return null; });
      // best-effort: call saveBackup to persist full localStorage mainKey (if available)
      try {
        if (window.backupClient && typeof window.backupClient.saveBackup === 'function') {
          await window.backupClient.saveBackup(options).catch(e => LOG('saveBackup failed inside createAndSaveBackup', e));
        }
      } catch(e) { LOG('createAndSaveBackup: saveBackup call failed', e); }
      return res;
    } catch(e) { LOG('createAndSaveBackup failed', e); throw e; }
  }

  // flushPendingUploads: attempt to upload any pending items
  async function flushPendingUploads() {
    if (!navigator.onLine || !window.supabase) return false;
    const pend = await getAllPendingAsync();
    if (!pend || pend.length === 0) return true;
    for (let i = 0; i < pend.length; ++i) {
      const item = pend[i];
      try {
        // determine bytes: support old base64 shape or new blob shape
        let bytes = null;
        if (item && item.base64) {
          bytes = b64ToBytes(item.base64);
        } else if (item && item.blob) {
          try {
            // blob may be a real Blob (browser) or stored ArrayBuffer-like
            if (item.blob instanceof Blob && typeof item.blob.arrayBuffer === 'function') {
              const arr = await item.blob.arrayBuffer();
              bytes = new Uint8Array(arr);
            } else if (item.blob && item.blob.buffer) {
              bytes = new Uint8Array(item.blob.buffer);
            }
          } catch (be) {
            LOG('flushPendingUploads: could not read blob for', item.id, be);
          }
        }
        if (!bytes) {
          LOG('flushPendingUploads: no bytes available for pending item', item.id);
          continue;
        }
        // attempt to insert into backups table
        const json = new TextDecoder().decode(bytes);
        let obj = null;
        try { obj = JSON.parse(json); } catch(_) { obj = json; }
        try {
          // Upload pending item to storage instead of inserting into DB
          try {
            await uploadBackupToStorage({ userId: (await window.supabase.auth.getUser()).data?.user?.id || null, timestamp: Date.now(), data: obj });
            LOG('flushPendingUploads: uploaded pending backup', item.id);
          } catch (uErr) {
            LOG('flushPendingUploads: storage upload failed', uErr);
            throw uErr;
          }
        } catch (e) { throw e; }
        // remove from pending store
        try { await removePendingById(item.id); } catch(e){ LOG('flushPendingUploads: removePending failed', item.id, e); }
      } catch (e) {
        LOG('flushPendingUploads: item upload failed, will retry later', item.id, e);
      }
    }
    return true;
  }

  // mergeGroupBackups: fetch latest backup file from Storage and merge into window.state
  async function mergeGroupBackups(groupEmail, options = {}) {
    if (!groupEmail) throw new Error('groupEmail required');
    if (!window.supabase) throw new Error('Supabase client required');

    try {
      const user = (await window.supabase.auth.getUser()).data?.user;
      if (!user) throw new Error('کاربر لاگین نیست');
      const prefix = user.id;

      const { data: files, error: listError } = await window.supabase.storage
        .from(BUCKET)
        .list(prefix, { limit: 1, sortBy: { column: 'created_at', order: 'desc' } });

      if (listError || !files || files.length === 0) {
        LOG('mergeGroupBackups: no backup found');
        return { ok: false, reason: 'no_backup' };
      }

      const latestPath = `${prefix}/${files[0].name}`;
      const snap = await downloadFromStorage(window.supabase, latestPath);
      if (!snap) throw new Error('snapshot not found');

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
      // Try to download backup from Storage. Accept multiple candidate paths.
      let snap = null;
      const client = window.supabase;
      const candidates = [ `${backupId}.json`, backupId ];
      for (const p of candidates) {
        try { snap = await downloadFromStorage(client, p).catch(() => null); if (snap) break; } catch(_){}
      }
      if (!snap) {
        // try list under user's id folder
        try {
          const su = await window.supabase.auth.getUser().catch(() => null);
          const user = su && su.data && su.data.user ? su.data.user : null;
          if (user && user.id) {
            const userId = user.id;
            const { data: files } = await window.supabase.storage.from(BUCKET).list(userId, { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });
            if (files && files.length) {
              const tryPath = `${userId}/${files[0].name}`;
              snap = await downloadFromStorage(client, tryPath).catch(() => null);
            }
          }
        } catch(e) { LOG('restoreBackup: list/download failed', e); }
      }
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

  // Persist a backup JSON to IndexedDB (or fall back to localStorage)
  async function saveBackupToIndexedDB(backupJson) {
    try {
      if (window.indexedDBQueue && typeof window.indexedDBQueue.saveBackup === 'function') {
        return await window.indexedDBQueue.saveBackup(backupJson);
      }
      // fallback: localStorage archives
      const key = 'backup:archives';
      let arr = [];
      try { arr = JSON.parse(localStorage.getItem(key) || '[]'); } catch(_) { arr = []; }
      arr.unshift(backupJson);
      if (arr.length > 50) arr = arr.slice(0,50);
      try { localStorage.setItem(key, JSON.stringify(arr)); } catch(e){ LOG('saveBackupToIndexedDB: localStorage save failed', e); }
      return true;
    } catch(e) { LOG('saveBackupToIndexedDB failed', e); return false; }
  }

  // schedule daily backups
  function scheduleDaily() {
    try {
      if (window._backupDailyInterval) return window._backupDailyInterval;
      window._backupDailyInterval = setInterval(() => {
        try { createAndSaveBackup().catch(e => LOG('daily createAndSaveBackup failed', e)); } catch(e) { LOG('daily schedule error', e); }
      }, 86400000);
      return window._backupDailyInterval;
    } catch (e) { LOG('scheduleDaily failed', e); }
  }

  // Expose functions on window
  window.backupClient = {
    createBackup,
    createAndSaveBackup,
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

        // Prepare a lightweight backup JSON, persist locally, and upload to Storage
        const backupJson = { userId: user_id, timestamp: Date.now(), data: localData };
        try {
          await saveBackupToIndexedDB(backupJson);
        } catch(e) { LOG('saveBackup: save to indexedDB failed', e); }
        try {
          await uploadBackupToStorage(backupJson);
        } catch(e) { LOG('uploadBackupToStorage failed', e); }
        LOG('saveBackup: saved (storage-only)', payload.backup_id);
        return { ok: true, id: payload.backup_id };
      } catch (e) { LOG('saveBackup failed', e); throw e; }
    },
    loadLatestBackup: async function(options = {}) {
      try {
        if (!window.supabase) throw new Error('Supabase client not available');
        const user = window.state && window.state.user ? window.state.user : (window.currentUser || {});
        const email = options.groupEmail || user.email || (window.currentUser && window.currentUser.email) || null;
        if (!email) throw new Error('groupEmail required to load backup');

        // Attempt to find latest backup in Storage for the current user
        const sup = window.supabase;
        const su = await sup.auth.getUser().catch(() => null);
        const uid = su && su.data && su.data.user ? su.data.user.id : null;
        let data = null;
        if (uid) {
          try {
            const { data: files } = await sup.storage.from(BUCKET).list(uid, { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });
            if (files && files.length) {
              const fp = `${uid}/${files[0].name}`;
              data = await downloadFromStorage(sup, fp).catch(() => null);
            }
          } catch(e) { LOG('loadLatestBackup: storage list failed', e); }
        }
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

  // Expose upload helper globally for compatibility with other modules
  try {
    window.uploadBackupToStorage = uploadBackupToStorage;
    // also expose on backupClient for consistency
    if (window.backupClient) window.backupClient.uploadBackupToStorage = uploadBackupToStorage;
    // expose prune so UI buttons or other modules can call it directly
    if (typeof pruneOldBackups === 'function') {
      window.pruneOldBackups = pruneOldBackups;
      if (window.backupClient) window.backupClient.pruneOldBackups = pruneOldBackups;
    }
  } catch (e) { LOG('expose uploadBackupToStorage failed', e); }

  // Attempt flush pending when coming online
  window.addEventListener && window.addEventListener('online', () => { try { flushPendingUploads(); } catch(_){} });

})();
