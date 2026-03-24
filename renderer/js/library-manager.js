// ─── INDEXEDDB LIBRARY ───────────────────────────────────────
const DB_NAME = 'stagehand_db';
const DB_VER  = 1;
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
