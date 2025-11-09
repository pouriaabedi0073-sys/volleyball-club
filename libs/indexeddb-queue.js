// Minimal IndexedDB helper for pending backups and blobs
// Provides a small async API: addPending(item), getAllPending(), deletePending(id), clearPending()
(function(){
  const DB_NAME = 'vb_backups_db';
  const DB_VERSION = 1;
  const STORE_PENDING = 'pendingBackups';
  let dbPromise = null;

  function openDB(){
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE_PENDING)) {
            const os = db.createObjectStore(STORE_PENDING, { keyPath: 'id' });
            os.createIndex('by_created', 'created_at', { unique: false });
          }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error || new Error('indexeddb open error'));
      } catch (err) { reject(err); }
    });
    return dbPromise;
  }

  function promisifyRequest(req){
    return new Promise((resolve, reject) => {
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error || new Error('request failed'));
    });
  }

  async function addPending(item){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_PENDING, 'readwrite');
        const store = tx.objectStore(STORE_PENDING);
        // Normalize item: ensure 'blob' field exists. If base64 present, convert to Blob.
        (async function(){
          try {
            let toStore = Object.assign({}, item);
            if (toStore.base64 && !toStore.blob) {
              // convert base64 to binary blob
              const bin = atob(toStore.base64);
              const len = bin.length;
              const u8 = new Uint8Array(len);
              for (let i=0;i<len;i++) u8[i] = bin.charCodeAt(i);
              toStore.blob = new Blob([u8.buffer], { type: 'application/octet-stream' });
              // keep base64 for compatibility if desired
            }
            // store
            if (!toStore.id) toStore.id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : ('p_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8));
            const req = store.put(toStore);
            req.onsuccess = () => resolve(toStore);
            req.onerror = (e) => reject(e.target.error || new Error('addPending put failed'));
          } catch (err) { reject(err); }
        })();
      } catch (err) { reject(err); }
    });
  }

  async function getAllPending(){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_PENDING, 'readonly');
        const store = tx.objectStore(STORE_PENDING);
        const req = store.getAll();
        req.onsuccess = (e) => resolve(e.target.result || []);
        req.onerror = (e) => reject(e.target.error || new Error('getAllPending failed'));
      } catch (err) { reject(err); }
    });
  }

  async function deletePending(id){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_PENDING, 'readwrite');
        const store = tx.objectStore(STORE_PENDING);
        const req = store.delete(id);
        req.onsuccess = () => resolve(true);
        req.onerror = (e) => reject(e.target.error || new Error('deletePending failed'));
      } catch (err) { reject(err); }
    });
  }

  async function clearPending(){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_PENDING, 'readwrite');
        const store = tx.objectStore(STORE_PENDING);
        const req = store.clear();
        req.onsuccess = () => resolve(true);
        req.onerror = (e) => reject(e.target.error || new Error('clearPending failed'));
      } catch (err) { reject(err); }
    });
  }

  // expose
  try { window.indexedDBQueue = { addPending, getAllPending, deletePending, clearPending, _open: openDB }; } catch(e){ console.warn('indexedDBQueue expose failed', e); }

  // Migrate any legacy pending stored in localStorage -> IndexedDB (one-time best-effort)
  (async function migrateLocalPending(){
    try {
      const PENDING_KEY = 'backup:pendingUploads';
      const raw = localStorage.getItem(PENDING_KEY);
      if (!raw) return;
      let arr = null;
      try { arr = JSON.parse(raw); } catch(_) { arr = null; }
      if (!Array.isArray(arr) || arr.length === 0) return;
      for (const it of arr) {
        try { await window.indexedDBQueue.addPending(it); } catch(e) { console.warn('migrateLocalPending addPending failed', e); }
      }
      try { localStorage.removeItem(PENDING_KEY); console.info('migrated pending backups to IndexedDB:', arr.length); } catch(_){}
    } catch(e) { console.warn('migrateLocalPending failed', e); }
  })();
})();
