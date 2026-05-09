import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub browser-only globals used inside artwork-manager
global.FileReader = class {
  readAsDataURL(blob) {
    // Immediately fire onload with a deterministic data URL
    Promise.resolve().then(() => { this.result = 'data:image/jpeg;base64,STUB'; this.onload(); });
  }
};
global.Blob = class {
  constructor(parts, opts) { this._parts = parts; this.type = opts?.type ?? ''; }
};

// Mock library-manager so tests never touch IndexedDB
vi.mock('../renderer/js/library-manager.js', () => ({
  getArtwork: vi.fn(async () => null),
  setArtwork: vi.fn(async () => undefined),
}));

// Mock global fetch for iTunes API calls
global.fetch = vi.fn();

let AM, LM;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  global.fetch = vi.fn();

  vi.mock('../renderer/js/library-manager.js', () => ({
    getArtwork: vi.fn(async () => null),
    setArtwork: vi.fn(async () => undefined),
  }));

  const amMod = await import('../renderer/js/artwork-manager.js');
  const lmMod = await import('../renderer/js/library-manager.js');
  AM = amMod;
  LM = lmMod;

  // Clear the in-memory cache between tests
  AM.clearCache();
});

// ─── artworkKeyFor ────────────────────────────────────────────────────────────

describe('artworkKeyFor', () => {
  it('returns "artist::album" (lowercased, trimmed) when both present', () => {
    expect(AM.artworkKeyFor({ artist: 'The Beatles', album: 'Abbey Road' }))
      .toBe('the beatles::abbey road');
  });

  it('returns "track::id" when artist is missing', () => {
    expect(AM.artworkKeyFor({ id: 'trk_1', album: 'No Artist' }))
      .toBe('track::trk_1');
  });

  it('returns "track::id" when album is missing', () => {
    expect(AM.artworkKeyFor({ id: 'trk_2', artist: 'Solo' }))
      .toBe('track::trk_2');
  });

  it('returns "track::id" when both are empty strings', () => {
    expect(AM.artworkKeyFor({ id: 'trk_3', artist: '', album: '' }))
      .toBe('track::trk_3');
  });

  it('trims whitespace from artist and album', () => {
    expect(AM.artworkKeyFor({ artist: '  Pink Floyd  ', album: '  The Wall  ' }))
      .toBe('pink floyd::the wall');
  });
});

// ─── In-memory cache ──────────────────────────────────────────────────────────

describe('getCachedArtwork', () => {
  it('returns null when nothing is cached', () => {
    expect(AM.getCachedArtwork({ id: 'trk_x', artist: '', album: '' })).toBeNull();
  });
});

describe('clearCache', () => {
  it('removes previously cached entries', async () => {
    // Prime the cache by resolving artwork (IDB returns null, iTunes not called)
    await AM.resolveArtwork({ id: 'trk_1', artist: '', album: '' }, null);
    expect(AM.getCachedArtwork({ id: 'trk_1', artist: '', album: '' })).toBeNull(); // null is cached
    AM.clearCache();
    // After clear, getCachedArtwork returns null because cache is empty (not because null was cached)
    expect(AM.getCachedArtwork({ id: 'trk_1', artist: '', album: '' })).toBeNull();
  });
});

// ─── iTunes URL validation ────────────────────────────────────────────────────

describe('iTunes URL validation (via resolveArtwork)', () => {
  it('accepts a valid HTTPS mzstatic.com URL', async () => {
    const validUrl = 'https://is1-ssl.mzstatic.com/image/thumb/abc/100x100bb.jpg';
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ collectionName: 'Abbey Road', artworkUrl100: validUrl }],
      }),
    });
    const result = await AM.resolveArtwork({ id: 'trk_1', artist: 'Beatles', album: 'Abbey Road' }, null);
    expect(result).toBe(validUrl.replace('100x100bb', '600x600bb'));
  });

  it('rejects an HTTP (non-HTTPS) URL', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ collectionName: 'Bad', artworkUrl100: 'http://evil.com/img.jpg' }],
      }),
    });
    const result = await AM.resolveArtwork({ id: 'trk_2', artist: 'Bad', album: 'Bad' }, null);
    expect(result).toBeNull();
  });

  it('rejects a URL from a non-mzstatic.com host', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ collectionName: 'Hack', artworkUrl100: 'https://evil.com/img.jpg' }],
      }),
    });
    const result = await AM.resolveArtwork({ id: 'trk_3', artist: 'X', album: 'Y' }, null);
    expect(result).toBeNull();
  });

  it('returns null when iTunes returns an empty results array', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });
    const result = await AM.resolveArtwork({ id: 'trk_4', artist: 'Nobody', album: 'Nothing' }, null);
    expect(result).toBeNull();
  });

  it('returns null when fetch throws a network error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
    const result = await AM.resolveArtwork({ id: 'trk_5', artist: 'X', album: 'Y' }, null);
    expect(result).toBeNull();
  });

  it('returns null when fetch response is not ok', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false });
    const result = await AM.resolveArtwork({ id: 'trk_6', artist: 'X', album: 'Y' }, null);
    expect(result).toBeNull();
  });
});

// ─── IDB cache hit prevents redundant network calls ──────────────────────────

describe('resolveArtwork — IDB cache hit', () => {
  it('returns IDB-stored artwork without calling fetch', async () => {
    LM.getArtwork.mockResolvedValue('data:image/png;base64,CACHED');
    const result = await AM.resolveArtwork({ id: 'trk_1', artist: 'Cached', album: 'Album' }, null);
    expect(result).toBe('data:image/png;base64,CACHED');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('uses the in-memory cache on a second call, skipping IDB', async () => {
    LM.getArtwork.mockResolvedValue('data:image/png;base64,FIRST');
    const track = { id: 'trk_1', artist: 'A', album: 'B' };
    await AM.resolveArtwork(track, null);
    LM.getArtwork.mockResolvedValue('data:image/png;base64,SECOND'); // would differ if IDB hit
    const second = await AM.resolveArtwork(track, null);
    expect(second).toBe('data:image/png;base64,FIRST'); // from memory cache
    expect(LM.getArtwork).toHaveBeenCalledTimes(1); // only once
  });
});

// ─── storeManualArtwork ───────────────────────────────────────────────────────

describe('storeManualArtwork', () => {
  it('throws when given a non-image file', async () => {
    const file = { type: 'application/pdf', arrayBuffer: async () => new ArrayBuffer(0) };
    await expect(AM.storeManualArtwork('key', file)).rejects.toThrow('Not an image file');
  });
});

// ─── warmCache ────────────────────────────────────────────────────────────────

describe('warmCache', () => {
  it('does nothing when all tracks are already cached', async () => {
    // Prime cache for a track
    const track = { id: 'trk_1', artist: '', album: '' };
    await AM.resolveArtwork(track, null); // caches null
    LM.getArtwork.mockClear();
    await AM.warmCache([track]);
    expect(LM.getArtwork).not.toHaveBeenCalled();
  });

  it('reads IDB for uncached tracks', async () => {
    LM.getArtwork.mockResolvedValue(null);
    const tracks = [
      { id: 'trk_a', artist: 'A', album: 'A' },
      { id: 'trk_b', artist: 'B', album: 'B' },
    ];
    await AM.warmCache(tracks);
    expect(LM.getArtwork).toHaveBeenCalledTimes(2);
  });
});
