// ─── ARTWORK MANAGER ─────────────────────────────────────────
// Sources: embedded file tags (jsmediatags) → iTunes Search API fallback
// Storage: IDB 'artwork' store keyed by "artist::album" or "track::id"

import * as LibraryManager from './library-manager.js';

// In-memory cache to avoid redundant IDB reads during a session
const _cache = new Map(); // key → dataUrl | null

export function artworkKeyFor(track) {
  const artist = (track.artist || '').trim().toLowerCase();
  const album  = (track.album  || '').trim().toLowerCase();
  if (artist && album) return `${artist}::${album}`;
  return `track::${track.id}`;
}

function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload  = () => res(reader.result);
    reader.onerror = () => rej(new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

// Extract embedded artwork from an ArrayBuffer using jsmediatags (loaded globally)
export function extractEmbeddedArt(arrayBuffer) {
  return new Promise(res => {
    if (!window.jsmediatags) { res(null); return; }
    // jsmediatags needs a Blob
    const blob = new Blob([arrayBuffer]);
    window.jsmediatags.read(blob, {
      onSuccess(tag) {
        try {
          const pic = tag.tags.picture;
          if (!pic || !pic.data) { res(null); return; }
          // pic.data is an array of byte values
          const bytes = new Uint8Array(pic.data);
          const mime  = pic.format || 'image/jpeg';
          const imgBlob = new Blob([bytes], { type: mime });
          blobToDataUrl(imgBlob).then(res).catch(() => res(null));
        } catch { res(null); }
      },
      onError() { res(null); }
    });
  });
}

// Fetch artwork from iTunes Search API — security-hardened
async function fetchItunesArt(artist, album) {
  // Build query — sanitize with encodeURIComponent, cap length
  const raw = `${artist} ${album}`.trim().slice(0, 200);
  if (!raw) return null;
  const query = encodeURIComponent(raw);
  const apiUrl = `https://itunes.apple.com/search?term=${query}&entity=album&limit=5&media=music`;

  let data;
  try {
    const res = await fetch(apiUrl, { method: 'GET', credentials: 'omit' });
    if (!res.ok) return null;
    data = await res.json();
  } catch { return null; }

  if (!Array.isArray(data?.results) || data.results.length === 0) return null;

  // Find best match: prefer exact album name match, fall back to first result
  const lower = album.toLowerCase();
  const result = data.results.find(r =>
    typeof r.collectionName === 'string' &&
    r.collectionName.toLowerCase().includes(lower)
  ) || data.results[0];

  const rawUrl = result?.artworkUrl100;

  // Strict URL validation — must be HTTPS from Apple's CDN only
  if (typeof rawUrl !== 'string') return null;
  if (!rawUrl.startsWith('https://')) return null;
  try {
    const parsed = new URL(rawUrl);
    if (!parsed.hostname.endsWith('mzstatic.com')) return null;
  } catch { return null; }

  // Upgrade to 600×600 and return URL directly — mzstatic.com blocks fetch() via CORS
  // but the URL works fine as an <img src>, so skip the image download step
  return rawUrl.replace('100x100bb', '600x600bb');
}

// Resolve artwork for a track: IDB cache → embedded → iTunes → null
export async function resolveArtwork(track, arrayBuffer) {
  const key = artworkKeyFor(track);

  // Check in-memory cache first
  if (_cache.has(key)) return _cache.get(key);

  // Check IDB
  try {
    const stored = await LibraryManager.getArtwork(key);
    if (stored) { _cache.set(key, stored); return stored; }
  } catch { /* continue */ }

  // Try embedded art
  let dataUrl = null;
  if (arrayBuffer) {
    dataUrl = await extractEmbeddedArt(arrayBuffer);
  }

  // iTunes fallback
  if (!dataUrl) {
    const artist = (track.artist || '').trim();
    const album  = (track.album  || '').trim();
    if (artist || album) {
      dataUrl = await fetchItunesArt(artist, album);
    }
  }

  _cache.set(key, dataUrl);
  return dataUrl;
}

// Resolve, store in IDB, and update the in-memory cache — fire-and-forget safe
export async function resolveAndStoreArtwork(track, arrayBuffer) {
  const key = artworkKeyFor(track);
  // Already cached (null or dataUrl) — skip
  if (_cache.has(key)) return;
  const dataUrl = await resolveArtwork(track, arrayBuffer);
  if (dataUrl) {
    LibraryManager.setArtwork(key, dataUrl).catch(() => {});
  } else {
    // Cache null so we don't retry on every render
    _cache.set(key, null);
  }
}

// Clear in-memory cache (call after clearing IDB artwork store)
export function clearCache() { _cache.clear(); }

// Synchronous cache read for row rendering (returns null if not yet loaded)
export function getCachedArtwork(track) {
  return _cache.get(artworkKeyFor(track)) ?? null;
}

// Warm the artwork cache for a list of tracks (reads IDB, no network)
export async function warmCache(tracks) {
  const uncached = tracks.filter(t => !_cache.has(artworkKeyFor(t)));
  if (uncached.length === 0) return;
  await Promise.all(uncached.map(async t => {
    const key = artworkKeyFor(t);
    try {
      const stored = await LibraryManager.getArtwork(key);
      if (stored) _cache.set(key, stored);
    } catch { /* leave absent so resolveAndStoreArtwork can retry */ }
  }));
}

// Store artwork from a user-selected file — validates MIME type
export async function storeManualArtwork(key, file) {
  if (!file.type.startsWith('image/')) throw new Error('Not an image file');
  const dataUrl = await blobToDataUrl(file);
  _cache.set(key, dataUrl);
  await LibraryManager.setArtwork(key, dataUrl);
  return dataUrl;
}
