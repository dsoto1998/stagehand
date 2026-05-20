// ─── UI UTILITIES (pure, no DOM, no module state) ────────────
// Extracted from ui-controller.js so they can be unit-tested.

export function formatTime(sec) {
  if (!isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2,'0')}`;
}

export function formatSize(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024*1024)).toFixed(1) + ' MB';
}

// sc: { key: string, modifiers: string[] }
export function matchShortcut(e, sc) {
  if (!sc) return false;
  const mods = sc.modifiers || [];
  if (mods.includes('Ctrl')  !== (e.ctrlKey || e.metaKey)) return false;
  if (mods.includes('Shift') !== e.shiftKey) return false;
  if (mods.includes('Alt')   !== e.altKey)   return false;
  const k = sc.key;
  return e.key === k || (k.length === 1 && e.key.toLowerCase() === k.toLowerCase());
}

export function matchesQuery(track, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (track.name   || '').toLowerCase().includes(q)
      || (track.artist || '').toLowerCase().includes(q)
      || (track.album  || '').toLowerCase().includes(q);
}

// Sort a list of tracks by field/direction.
// allTracksForYearMap: pass the full unfiltered library so album year-ordering
// stays consistent even when source is a search-filtered subset.
export function sortTracks(source, sortField, sortDir, allTracksForYearMap = source) {
  const dir = sortDir === 'asc' ? 1 : -1;
  const albumYearMap = new Map();
  if (sortField === 'album') {
    allTracksForYearMap.forEach(t => {
      const key = (t.album || '').trim();
      if (t.releaseDate && !albumYearMap.has(key)) albumYearMap.set(key, t.releaseDate);
    });
  }
  return [...source].sort((a, b) => {
    switch (sortField) {
      case 'artist': {
        const c = (a.artist || '').localeCompare(b.artist || '');
        return c !== 0 ? dir * c : (a.name || '').localeCompare(b.name || '');
      }
      case 'album': {
        const ya = albumYearMap.get((a.album || '').trim()) || '';
        const yb = albumYearMap.get((b.album || '').trim()) || '';
        if (!ya && !yb) {
          const c = (a.album || '').localeCompare(b.album || '');
          if (c !== 0) return c;
          const ta = a.trackNumber || 0, tb = b.trackNumber || 0;
          if (ta !== tb) return ta - tb;
          return (a.name || '').localeCompare(b.name || '');
        }
        if (!ya) return 1;
        if (!yb) return -1;
        const c = yb.localeCompare(ya); // newest first when dir=asc(1)
        if (c !== 0) return dir * c;
        const ca = (a.album || '').localeCompare(b.album || '');
        if (ca !== 0) return ca;
        const ta = a.trackNumber || 0, tb = b.trackNumber || 0;
        if (ta !== tb) return ta - tb;
        return (a.name || '').localeCompare(b.name || '');
      }
      case 'addedAt':  return dir * ((a.addedAt  || 0) - (b.addedAt  || 0));
      case 'duration': return dir * ((a.duration || 0) - (b.duration || 0));
      case 'bpm':      return dir * ((a.bpm || 0) - (b.bpm || 0));
      default:         return dir * (a.name || '').localeCompare(b.name || '');
    }
  });
}
