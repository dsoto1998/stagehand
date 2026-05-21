import { describe, expect, it } from 'vitest';
import { formatTime, formatSize, matchShortcut, matchesQuery, sortTracks } from '../renderer/js/ui-utils.js';

// ─── formatTime ───────────────────────────────────────────────────────────────

describe('formatTime', () => {
  it('formats whole minutes and seconds', () => {
    expect(formatTime(90)).toBe('1:30');
  });

  it('zero-pads seconds below 10', () => {
    expect(formatTime(65)).toBe('1:05');
  });

  it('handles zero', () => {
    expect(formatTime(0)).toBe('0:00');
  });

  it('handles exactly one minute', () => {
    expect(formatTime(60)).toBe('1:00');
  });

  it('truncates fractional seconds (does not round up)', () => {
    expect(formatTime(59.9)).toBe('0:59');
  });

  it('returns "0:00" for Infinity', () => {
    expect(formatTime(Infinity)).toBe('0:00');
  });

  it('returns "0:00" for NaN', () => {
    expect(formatTime(NaN)).toBe('0:00');
  });

  it('handles large values', () => {
    expect(formatTime(3661)).toBe('61:01');
  });
});

// ─── formatSize ───────────────────────────────────────────────────────────────

describe('formatSize', () => {
  it('formats bytes below 1 MB as KB (no decimal)', () => {
    expect(formatSize(512 * 1024)).toBe('512 KB');
  });

  it('formats 1024 bytes as 1 KB', () => {
    expect(formatSize(1024)).toBe('1 KB');
  });

  it('formats values >= 1 MB with one decimal place', () => {
    expect(formatSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });

  it('formats exactly 1 MB', () => {
    expect(formatSize(1024 * 1024)).toBe('1.0 MB');
  });

  it('formats values just below 1 MB as KB', () => {
    expect(formatSize(1024 * 1024 - 1)).toMatch(/KB$/);
  });
});

// ─── matchShortcut ────────────────────────────────────────────────────────────

function evt(key, { ctrl = false, shift = false, alt = false, meta = false } = {}) {
  return { key, ctrlKey: ctrl, shiftKey: shift, altKey: alt, metaKey: meta };
}

describe('matchShortcut', () => {
  it('returns false when sc is null', () => {
    expect(matchShortcut(evt(' '), null)).toBe(false);
  });

  it('returns false when sc is undefined', () => {
    expect(matchShortcut(evt(' '), undefined)).toBe(false);
  });

  it('matches a plain key with no modifiers', () => {
    const sc = { key: ' ', modifiers: [] };
    expect(matchShortcut(evt(' '), sc)).toBe(true);
  });

  it('rejects when the key does not match', () => {
    const sc = { key: ' ', modifiers: [] };
    expect(matchShortcut(evt('Enter'), sc)).toBe(false);
  });

  it('matches Ctrl+key (ctrlKey)', () => {
    const sc = { key: 'f', modifiers: ['Ctrl'] };
    expect(matchShortcut(evt('f', { ctrl: true }), sc)).toBe(true);
  });

  it('matches Ctrl+key via metaKey (Mac Cmd)', () => {
    const sc = { key: 'f', modifiers: ['Ctrl'] };
    expect(matchShortcut(evt('f', { meta: true }), sc)).toBe(true);
  });

  it('rejects Ctrl shortcut when Ctrl is not held', () => {
    const sc = { key: 'f', modifiers: ['Ctrl'] };
    expect(matchShortcut(evt('f'), sc)).toBe(false);
  });

  it('rejects plain key when Ctrl is unexpectedly held', () => {
    const sc = { key: 'f', modifiers: [] };
    expect(matchShortcut(evt('f', { ctrl: true }), sc)).toBe(false);
  });

  it('matches Shift+key', () => {
    const sc = { key: 'ArrowLeft', modifiers: ['Shift'] };
    expect(matchShortcut(evt('ArrowLeft', { shift: true }), sc)).toBe(true);
  });

  it('rejects Shift+key when Shift is not held', () => {
    const sc = { key: 'ArrowLeft', modifiers: ['Shift'] };
    expect(matchShortcut(evt('ArrowLeft'), sc)).toBe(false);
  });

  it('matches Alt+key', () => {
    const sc = { key: 'l', modifiers: ['Alt'] };
    expect(matchShortcut(evt('l', { alt: true }), sc)).toBe(true);
  });

  it('is case-insensitive for single-character keys', () => {
    const sc = { key: 'L', modifiers: [] };
    expect(matchShortcut(evt('l'), sc)).toBe(true);
  });

  it('does not apply case-folding to multi-character keys like ArrowLeft', () => {
    const sc = { key: 'ArrowLeft', modifiers: [] };
    expect(matchShortcut(evt('ArrowLeft'), sc)).toBe(true);
    expect(matchShortcut(evt('arrowleft'), sc)).toBe(false);
  });

  it('matches a chord with multiple modifiers', () => {
    const sc = { key: 'a', modifiers: ['Ctrl', 'Shift'] };
    expect(matchShortcut(evt('a', { ctrl: true, shift: true }), sc)).toBe(true);
  });

  it('rejects a chord when one modifier is missing', () => {
    const sc = { key: 'a', modifiers: ['Ctrl', 'Shift'] };
    expect(matchShortcut(evt('a', { ctrl: true }), sc)).toBe(false);
  });
});

// ─── matchesQuery ─────────────────────────────────────────────────────────────

describe('matchesQuery', () => {
  const track = { name: 'Comfortably Numb', artist: 'Pink Floyd', album: 'The Wall' };

  it('returns true when query is empty', () => {
    expect(matchesQuery(track, '')).toBe(true);
  });

  it('returns true when query is null/undefined', () => {
    expect(matchesQuery(track, null)).toBe(true);
    expect(matchesQuery(track, undefined)).toBe(true);
  });

  it('matches against track name (case-insensitive)', () => {
    expect(matchesQuery(track, 'numb')).toBe(true);
    expect(matchesQuery(track, 'NUMB')).toBe(true);
  });

  it('matches against artist', () => {
    expect(matchesQuery(track, 'floyd')).toBe(true);
  });

  it('matches against album', () => {
    expect(matchesQuery(track, 'wall')).toBe(true);
  });

  it('returns false when query matches nothing', () => {
    expect(matchesQuery(track, 'zeppelin')).toBe(false);
  });

  it('handles tracks with missing fields gracefully', () => {
    expect(matchesQuery({ name: 'Only Name' }, 'only')).toBe(true);
    expect(matchesQuery({}, 'anything')).toBe(false);
  });
});

// ─── sortTracks ───────────────────────────────────────────────────────────────

const t = (overrides) => ({
  id: 'x', name: '', artist: '', album: '', duration: 0, addedAt: 0, bpm: 0, ...overrides,
});

describe('sortTracks — by name (default)', () => {
  it('sorts ascending by name', () => {
    const result = sortTracks([t({ name: 'Ziggy' }), t({ name: 'Album' }), t({ name: 'Medium' })], 'name', 'asc');
    expect(result.map(r => r.name)).toEqual(['Album', 'Medium', 'Ziggy']);
  });

  it('sorts descending by name', () => {
    const result = sortTracks([t({ name: 'A' }), t({ name: 'C' }), t({ name: 'B' })], 'name', 'desc');
    expect(result.map(r => r.name)).toEqual(['C', 'B', 'A']);
  });

  it('returns a new array, does not mutate input', () => {
    const input = [t({ name: 'B' }), t({ name: 'A' })];
    const result = sortTracks(input, 'name', 'asc');
    expect(result).not.toBe(input);
    expect(input[0].name).toBe('B'); // original unchanged
  });
});

describe('sortTracks — by artist', () => {
  it('sorts ascending by artist, with name as tiebreaker', () => {
    const list = [
      t({ artist: 'Radiohead', name: 'Creep' }),
      t({ artist: 'Radiohead', name: 'Airbag' }),
      t({ artist: 'Blur',      name: 'Song 2' }),
    ];
    const result = sortTracks(list, 'artist', 'asc');
    expect(result.map(r => r.name)).toEqual(['Song 2', 'Airbag', 'Creep']);
  });

  it('sorts descending by artist', () => {
    const list = [t({ artist: 'A' }), t({ artist: 'C' }), t({ artist: 'B' })];
    const result = sortTracks(list, 'artist', 'desc');
    expect(result.map(r => r.artist)).toEqual(['C', 'B', 'A']);
  });
});

describe('sortTracks — by album (no releaseDates)', () => {
  it('sorts ascending by album name, then by trackNumber', () => {
    const list = [
      t({ album: 'OK Computer', name: 'Exit',    trackNumber: 3 }),
      t({ album: 'OK Computer', name: 'Airbag',  trackNumber: 1 }),
      t({ album: 'Pablo Honey', name: 'Creep',   trackNumber: 2 }),
    ];
    const result = sortTracks(list, 'album', 'asc');
    expect(result.map(r => r.name)).toEqual(['Airbag', 'Exit', 'Creep']);
  });

  it('falls back to track name when album and trackNumber tie', () => {
    const list = [
      t({ album: 'X', trackNumber: 1, name: 'Z' }),
      t({ album: 'X', trackNumber: 1, name: 'A' }),
    ];
    const result = sortTracks(list, 'album', 'asc');
    expect(result.map(r => r.name)).toEqual(['A', 'Z']);
  });
});

describe('sortTracks — by album with releaseDates', () => {
  it('places albums with a releaseDate before albums without one', () => {
    const list = [
      t({ album: 'No Date',      name: 'Track1' }),
      t({ album: 'Has Date',     name: 'Track2', releaseDate: '2000' }),
    ];
    const result = sortTracks(list, 'album', 'asc');
    expect(result[0].name).toBe('Track2'); // dated first
    expect(result[1].name).toBe('Track1'); // undated last
  });

  it('sorts dated albums newest-first when dir=asc', () => {
    const list = [
      t({ album: 'Old', name: 'OldTrack', releaseDate: '1990' }),
      t({ album: 'New', name: 'NewTrack', releaseDate: '2020' }),
    ];
    const result = sortTracks(list, 'album', 'asc');
    expect(result[0].name).toBe('NewTrack');
    expect(result[1].name).toBe('OldTrack');
  });
});

describe('sortTracks — by duration', () => {
  it('sorts ascending by duration', () => {
    const list = [t({ duration: 300 }), t({ duration: 120 }), t({ duration: 240 })];
    const result = sortTracks(list, 'duration', 'asc');
    expect(result.map(r => r.duration)).toEqual([120, 240, 300]);
  });

  it('sorts descending by duration', () => {
    const list = [t({ duration: 300 }), t({ duration: 120 }), t({ duration: 240 })];
    const result = sortTracks(list, 'duration', 'desc');
    expect(result.map(r => r.duration)).toEqual([300, 240, 120]);
  });
});

describe('sortTracks — by addedAt', () => {
  it('sorts ascending by addedAt timestamp', () => {
    const list = [t({ addedAt: 3000 }), t({ addedAt: 1000 }), t({ addedAt: 2000 })];
    const result = sortTracks(list, 'addedAt', 'asc');
    expect(result.map(r => r.addedAt)).toEqual([1000, 2000, 3000]);
  });
});

describe('sortTracks — by bpm', () => {
  it('sorts ascending by bpm', () => {
    const list = [t({ bpm: 140 }), t({ bpm: 80 }), t({ bpm: 120 })];
    const result = sortTracks(list, 'bpm', 'asc');
    expect(result.map(r => r.bpm)).toEqual([80, 120, 140]);
  });
});

describe('sortTracks — edge cases', () => {
  it('returns empty array unchanged', () => {
    expect(sortTracks([], 'name', 'asc')).toEqual([]);
  });

  it('handles single-element list', () => {
    const list = [t({ name: 'Solo' })];
    expect(sortTracks(list, 'name', 'asc')).toHaveLength(1);
  });

  it('handles missing fields (undefined) without throwing', () => {
    const list = [t({ name: undefined }), t({ name: 'B' })];
    expect(() => sortTracks(list, 'name', 'asc')).not.toThrow();
  });
});
