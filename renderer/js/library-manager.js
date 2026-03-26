// ─── INDEXEDDB LIBRARY ───────────────────────────────────────
const DB_NAME = 'stagehand_db';
const DB_VER  = 2;
const STORE   = 'tracks';
let db = null;

function open() {
  return new Promise((res, rej) => {
    if (db) return res(db);
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE)) {
        const s = d.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('name', 'name', { unique: false });
      }
      // New fields (artist, album, title, duration) are added lazily:
      // existing records have undefined; read-time || '' / || 0 handles them.
      if (!d.objectStoreNames.contains('playlists')) {
        d.createObjectStore('playlists', { keyPath: 'id' });
      }
    };
    req.onsuccess = e => { db = e.target.result; res(db); };
    req.onerror   = e => rej(e.target.error);
  });
}

export function all() {
  return open().then(d => new Promise((res, rej) => {
    const tx = d.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror   = e => rej(e.target.error);
  }));
}

export function save(track) {
  return open().then(d => new Promise((res, rej) => {
    const tx = d.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).put(track);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  }));
}

export function saveMeta(meta) {
  return open().then(d => new Promise((res, rej) => {
    const tx = d.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.get(meta.id);
    req.onsuccess = () => {
      const existing = req.result;
      if (!existing) { rej(new Error('Record not found: ' + meta.id)); return; }
      Object.assign(existing, meta);
      const putReq = store.put(existing);
      putReq.onsuccess = () => res();
      putReq.onerror = e => rej(e.target.error);
    };
    req.onerror = e => rej(e.target.error);
  }));
}

export function remove(id) {
  return open().then(d => new Promise((res, rej) => {
    const tx = d.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).delete(id);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  }));
}

export function genId() {
  return 'trk_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
}
