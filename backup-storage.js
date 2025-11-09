// backup-storage.js
// ES6 module implementing prioritized persistent storage:
// 1) IndexedDB (vb_dashboard_v8) with objectStores: 'state' and 'backups'
// 2) Cache Storage (vb_cache_v8) fallback: '/fallback/state.json'
// 3) localStorage minimal summary fallback

// Usage:
// import BackupStorage from './backup-storage.js';
// await BackupStorage.saveAppState(data);
// const data = await BackupStorage.loadAppState();
// const jsonBackup = await BackupStorage.createFullBackup();

const DB_NAME = 'vb_dashboard_v8';
const DB_VERSION = 1;
const STATE_STORE = 'state';
const BACKUPS_STORE = 'backups';
const CACHE_NAME = 'vb_cache_v8';
const CACHE_KEY = '/fallback/state.json';
const LOCAL_SUMMARY_KEY = 'vb_local_summary';

let _cachedDb = null;

function idbRequestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function openAppDB() {
  if (_cachedDb) return _cachedDb;
  if (!('indexedDB' in window)) {
    console.log('⚠️ IndexedDB not supported in this environment');
    throw new Error('IndexedDB not supported');
  }

  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        try {
          if (!db.objectStoreNames.contains(STATE_STORE)) {
            db.createObjectStore(STATE_STORE, { keyPath: 'key' });
          }
          if (!db.objectStoreNames.contains(BACKUPS_STORE)) {
            db.createObjectStore(BACKUPS_STORE, { keyPath: 'id' });
          }
          console.log('✅ IndexedDB upgrade/setup completed');
        } catch (e) {
          console.warn('IndexedDB upgrade error', e);
        }
      };
      req.onsuccess = (e) => {
        try {
          _cachedDb = e.target.result;
          _cachedDb.onclose = () => { _cachedDb = null; };
          console.log('✅ Opened IndexedDB', DB_NAME);
          resolve(_cachedDb);
        } catch (err) {
          reject(err);
        }
      };
      req.onerror = (e) => {
        console.warn('IndexedDB open failed', req.error);
        reject(req.error);
      };
    } catch (err) {
      reject(err);
    }
  });
}

async function idbGetState(db) {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction([STATE_STORE], 'readonly');
      const store = tx.objectStore(STATE_STORE);
      const req = store.get('main');
      req.onsuccess = () => {
        const rec = req.result;
        if (rec && rec.value !== undefined) {
          console.log('✅ Loaded state from IndexedDB');
          resolve(rec.value);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => reject(req.error);
    } catch (e) { reject(e); }
  });
}

async function idbPutState(db, data) {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction([STATE_STORE], 'readwrite');
      const store = tx.objectStore(STATE_STORE);
      const payload = { key: 'main', value: data, updated_at: new Date().toISOString() };
      const req = store.put(payload);
      req.onsuccess = () => {
        console.log('✅ Saved state to IndexedDB');
        resolve(true);
      };
      req.onerror = () => reject(req.error);
    } catch (e) { reject(e); }
  });
}

async function idbGetAllStore(db, storeName) {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction([storeName], 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) { reject(e); }
  });
}

async function saveToCache(data) {
  if (!('caches' in window)) throw new Error('Cache API not available');
  const json = JSON.stringify(data);
  try {
    const cache = await caches.open(CACHE_NAME);
    const response = new Response(json, { headers: { 'Content-Type': 'application/json' } });
    await cache.put(CACHE_KEY, response);
    console.log('✅ Saved state to Cache Storage as', CACHE_KEY);
    return true;
  } catch (e) {
    console.warn('Cache save failed', e);
    throw e;
  }
}

async function loadFromCache() {
  if (!('caches' in window)) return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const match = await cache.match(CACHE_KEY);
    if (!match) return null;
    const text = await match.text();
    try {
      const parsed = JSON.parse(text);
      console.log('✅ Loaded state from Cache Storage');
      return parsed;
    } catch (e) {
      console.warn('Failed to parse cache JSON', e);
      return null;
    }
  } catch (e) {
    console.warn('Cache load failed', e);
    return null;
  }
}

function saveSummaryToLocal(data) {
  try {
    const keys = data && typeof data === 'object' ? Object.keys(data) : [];
    const summary = { keys, updated_at: new Date().toISOString() };
    localStorage.setItem(LOCAL_SUMMARY_KEY, JSON.stringify(summary));
    console.log('✅ Saved lightweight summary to localStorage');
    return true;
  } catch (e) {
    console.warn('localStorage summary save failed', e);
    return false;
  }
}

function loadSummaryFromLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_SUMMARY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    console.log('✅ Loaded summary from localStorage');
    return parsed;
  } catch (e) {
    console.warn('localStorage load failed', e);
    return null;
  }
}

export async function saveAppState(data) {
  // Try IndexedDB first
  try {
    const db = await openAppDB();
    try {
      await idbPutState(db, data);
      // also update local summary
      saveSummaryToLocal(data);
      return { ok: true, where: 'indexeddb' };
    } catch (idbErr) {
      console.warn('IndexedDB write failed, falling back to Cache', idbErr);
      // fall through to cache
    }
  } catch (e) {
    console.warn('openAppDB failed, falling back to Cache', e);
  }

  // Try Cache Storage
  try {
    await saveToCache(data);
    // update local summary too
    saveSummaryToLocal(data);
    return { ok: true, where: 'cache' };
  } catch (cacheErr) {
    console.warn('Cache write failed, falling back to localStorage summary', cacheErr);
  }

  // Final fallback: localStorage summary only
  try {
    saveSummaryToLocal(data);
    return { ok: true, where: 'local' };
  } catch (e) {
    console.error('All storage methods failed', e);
    return { ok: false, reason: 'all_failed' };
  }
}

export async function loadAppState() {
  // Try IndexedDB
  try {
    const db = await openAppDB();
    try {
      const st = await idbGetState(db);
      if (st !== null) return { source: 'indexeddb', data: st };
    } catch (e) { console.warn('IndexedDB read failed', e); }
  } catch (e) { console.warn('openAppDB failed', e); }

  // Try Cache
  try {
    const cached = await loadFromCache();
    if (cached !== null) return { source: 'cache', data: cached };
  } catch (e) { console.warn('Cache load failed', e); }

  // Try local summary
  try {
    const summ = loadSummaryFromLocal();
    if (summ !== null) return { source: 'local', data: summ };
  } catch (e) { console.warn('local load failed', e); }

  return { source: null, data: null };
}

export async function createFullBackup() {
  const out = { meta: { created_at: new Date().toISOString() }, sources: { indexeddb: null, cache: null, local: null } };

  // IndexedDB: attempt to read state and backups stores
  try {
    const db = await openAppDB();
    try {
      const stateRec = await idbGetState(db);
      const backups = await idbGetAllStore(db, BACKUPS_STORE).catch(e => { console.warn('reading backups store failed', e); return null; });
      out.sources.indexeddb = { state: stateRec, backups: backups };
      console.log('✅ Collected data from IndexedDB for full backup');
    } catch (e) {
      console.warn('IndexedDB read for backup failed', e);
      out.sources.indexeddb = null;
    }
  } catch (e) {
    console.warn('openAppDB failed for backup', e);
    out.sources.indexeddb = null;
  }

  // Cache
  try {
    const cacheData = await loadFromCache();
    out.sources.cache = cacheData;
    console.log('✅ Collected data from Cache Storage for full backup');
  } catch (e) {
    console.warn('Cache read for backup failed', e);
    out.sources.cache = null;
  }

  // localStorage summary
  try {
    const summ = loadSummaryFromLocal();
    out.sources.local = summ;
    console.log('✅ Collected summary from localStorage for full backup');
  } catch (e) {
    console.warn('localStorage read for backup failed', e);
    out.sources.local = null;
  }

  return JSON.stringify(out, null, 2);
}

const BackupStorage = {
  openAppDB,
  saveAppState,
  loadAppState,
  createFullBackup,
};

export default BackupStorage;
