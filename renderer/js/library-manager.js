// ─── INDEXEDDB LIBRARY ───────────────────────────────────────
const DB_NAME = 'stagehand_db';
const DB_VER  = 6;
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
      if (!d.objectStoreNames.contains('settings')) {
        d.createObjectStore('settings', { keyPath: 'key' });
      }
      if (!d.objectStoreNames.contains('helix_presets')) {
        d.createObjectStore('helix_presets', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('artwork')) {
        d.createObjectStore('artwork', { keyPath: 'key' });
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

export function genPlaylistId() {
  return 'pl_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
}

export function getPlaylists() {
  return open().then(d => new Promise((res, rej) => {
    const tx = d.transaction('playlists', 'readonly');
    const req = tx.objectStore('playlists').getAll();
    req.onsuccess = () => res(req.result);
    req.onerror   = e => rej(e.target.error);
  }));
}

export function savePlaylist(playlist) {
  return open().then(d => new Promise((res, rej) => {
    const tx = d.transaction('playlists', 'readwrite');
    const req = tx.objectStore('playlists').put(playlist);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  }));
}

export function deletePlaylist(id) {
  return open().then(d => new Promise((res, rej) => {
    const tx = d.transaction('playlists', 'readwrite');
    const req = tx.objectStore('playlists').delete(id);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  }));
}

export function getSetting(key) {
  return open().then(d => new Promise((res, rej) => {
    const tx = d.transaction('settings', 'readonly');
    const req = tx.objectStore('settings').get(key);
    req.onsuccess = () => res(req.result || null);
    req.onerror   = e => rej(e.target.error);
  }));
}

export function putSetting(record) {
  return open().then(d => new Promise((res, rej) => {
    const tx = d.transaction('settings', 'readwrite');
    const req = tx.objectStore('settings').put(record);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  }));
}

export function deleteSetting(key) {
  return open().then(d => new Promise((res, rej) => {
    const tx = d.transaction('settings', 'readwrite');
    const req = tx.objectStore('settings').delete(key);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  }));
}

export function getArtwork(key) {
  return open().then(d => new Promise((res, rej) => {
    const tx = d.transaction('artwork', 'readonly');
    const req = tx.objectStore('artwork').get(key);
    req.onsuccess = () => res(req.result ? req.result.dataUrl : null);
    req.onerror   = e => rej(e.target.error);
  }));
}

export function setArtwork(key, dataUrl) {
  return open().then(d => new Promise((res, rej) => {
    const tx = d.transaction('artwork', 'readwrite');
    const req = tx.objectStore('artwork').put({ key, dataUrl });
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  }));
}

export function deleteArtwork(key) {
  return open().then(d => new Promise((res, rej) => {
    const tx = d.transaction('artwork', 'readwrite');
    const req = tx.objectStore('artwork').delete(key);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  }));
}

export function clearAllArtwork() {
  return open().then(d => new Promise((res, rej) => {
    const tx = d.transaction('artwork', 'readwrite');
    const req = tx.objectStore('artwork').clear();
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  }));
}
