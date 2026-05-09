import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

// Reset module + IDB before every test so the cached `db` connection is cleared
// and each test starts with a fresh, empty database.
let LM;
beforeEach(async () => {
  global.indexedDB = new IDBFactory();
  vi.resetModules();
  LM = await import('../renderer/js/library-manager.js');
});

// ─── ID generators ────────────────────────────────────────────────────────────

describe('genId', () => {
  it('returns a string starting with trk_', () => {
    expect(LM.genId()).toMatch(/^trk_/);
  });

  it('returns unique values on each call', () => {
    expect(LM.genId()).not.toBe(LM.genId());
  });
});

describe('genPlaylistId', () => {
  it('returns a string starting with pl_', () => {
    expect(LM.genPlaylistId()).toMatch(/^pl_/);
  });
});

// ─── Track store ──────────────────────────────────────────────────────────────

describe('save / all', () => {
  it('persists a track and retrieves it', async () => {
    const track = { id: 'trk_1', name: 'Test', format: 'MP3', size: 1000, semitones: 0, volume: 1.0, addedAt: 1 };
    await LM.save(track);
    const records = await LM.all();
    expect(records).toHaveLength(1);
    expect(records[0].name).toBe('Test');
  });

  it('overwrites an existing track with the same id', async () => {
    const base = { id: 'trk_1', name: 'Original', format: 'WAV', size: 0, semitones: 0, volume: 1.0, addedAt: 1 };
    await LM.save(base);
    await LM.save({ ...base, name: 'Updated' });
    const records = await LM.all();
    expect(records).toHaveLength(1);
    expect(records[0].name).toBe('Updated');
  });
});

describe('saveMeta', () => {
  it('updates scalar metadata without touching arrayBuffer', async () => {
    const buf = new ArrayBuffer(8);
    await LM.save({ id: 'trk_1', name: 'A', format: 'WAV', size: 8, semitones: 0, volume: 1.0, addedAt: 1, arrayBuffer: buf });
    await LM.saveMeta({ id: 'trk_1', name: 'B', volume: 0.5 });
    const [rec] = await LM.all();
    expect(rec.name).toBe('B');
    expect(rec.volume).toBe(0.5);
    expect(rec.arrayBuffer).toBeDefined(); // buffer untouched
  });

  it('rejects when the record does not exist', async () => {
    await expect(LM.saveMeta({ id: 'ghost' })).rejects.toThrow('Record not found: ghost');
  });
});

describe('remove', () => {
  it('deletes a track by id', async () => {
    await LM.save({ id: 'trk_1', name: 'X', format: 'WAV', size: 0, semitones: 0, volume: 1.0, addedAt: 1 });
    await LM.remove('trk_1');
    expect(await LM.all()).toHaveLength(0);
  });

  it('silently succeeds when id does not exist', async () => {
    await expect(LM.remove('no-such-id')).resolves.toBeUndefined();
  });
});

describe('getBytes', () => {
  it('returns the stored arrayBuffer', async () => {
    const buf = new ArrayBuffer(4);
    await LM.save({ id: 'trk_1', name: 'X', format: 'WAV', size: 4, semitones: 0, volume: 1.0, addedAt: 1, arrayBuffer: buf });
    const result = await LM.getBytes('trk_1');
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result.byteLength).toBe(4);
  });

  it('returns null for an unknown id', async () => {
    expect(await LM.getBytes('unknown')).toBeNull();
  });
});

describe('clearBytes', () => {
  it('removes the arrayBuffer field while keeping other fields', async () => {
    const buf = new ArrayBuffer(8);
    await LM.save({ id: 'trk_1', name: 'Y', format: 'FLAC', size: 8, semitones: 0, volume: 0.8, addedAt: 1, arrayBuffer: buf });
    await LM.clearBytes('trk_1');
    const [rec] = await LM.all();
    expect(rec.arrayBuffer).toBeUndefined();
    expect(rec.name).toBe('Y');
    expect(rec.volume).toBe(0.8);
  });

  it('silently succeeds when id does not exist', async () => {
    await expect(LM.clearBytes('ghost')).resolves.toBeUndefined();
  });
});

// ─── Playlist store ───────────────────────────────────────────────────────────

describe('playlists', () => {
  it('saves and retrieves a playlist', async () => {
    await LM.savePlaylist({ id: 'pl_1', name: 'My Set', trackIds: ['trk_1', 'trk_2'] });
    const playlists = await LM.getPlaylists();
    expect(playlists).toHaveLength(1);
    expect(playlists[0].name).toBe('My Set');
  });

  it('deletes a playlist by id', async () => {
    await LM.savePlaylist({ id: 'pl_1', name: 'Gone', trackIds: [] });
    await LM.deletePlaylist('pl_1');
    expect(await LM.getPlaylists()).toHaveLength(0);
  });

  it('returns an empty array when no playlists exist', async () => {
    expect(await LM.getPlaylists()).toEqual([]);
  });
});

// ─── Settings store ───────────────────────────────────────────────────────────

describe('settings', () => {
  it('round-trips a setting value', async () => {
    await LM.putSetting({ key: 'theme', value: 'dark' });
    const result = await LM.getSetting('theme');
    expect(result).toEqual({ key: 'theme', value: 'dark' });
  });

  it('returns null for an unknown key', async () => {
    expect(await LM.getSetting('nonexistent')).toBeNull();
  });

  it('overwrites an existing setting', async () => {
    await LM.putSetting({ key: 'bpm', value: 120 });
    await LM.putSetting({ key: 'bpm', value: 140 });
    const result = await LM.getSetting('bpm');
    expect(result.value).toBe(140);
  });

  it('deletes a setting', async () => {
    await LM.putSetting({ key: 'vol', value: 0.8 });
    await LM.deleteSetting('vol');
    expect(await LM.getSetting('vol')).toBeNull();
  });
});

// ─── Artwork store ────────────────────────────────────────────────────────────

describe('artwork', () => {
  it('stores and retrieves a dataUrl', async () => {
    await LM.setArtwork('artist::album', 'data:image/png;base64,abc');
    expect(await LM.getArtwork('artist::album')).toBe('data:image/png;base64,abc');
  });

  it('returns null for an unknown key', async () => {
    expect(await LM.getArtwork('unknown')).toBeNull();
  });

  it('deletes a single artwork entry', async () => {
    await LM.setArtwork('k1', 'data:image/jpeg;base64,xyz');
    await LM.deleteArtwork('k1');
    expect(await LM.getArtwork('k1')).toBeNull();
  });

  it('clearAllArtwork wipes every entry', async () => {
    await LM.setArtwork('k1', 'data:image/png;base64,a');
    await LM.setArtwork('k2', 'data:image/png;base64,b');
    await LM.clearAllArtwork();
    expect(await LM.getArtwork('k1')).toBeNull();
    expect(await LM.getArtwork('k2')).toBeNull();
  });
});
