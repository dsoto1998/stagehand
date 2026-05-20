import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock Tauri IPC — invoke records calls and returns sensible defaults
const invoke = vi.fn(async (cmd, _args) => {
  if (cmd === 'audio_check_prefetch') return false;
  if (cmd === 'audio_load_file')      return { duration: 180.0, peaks: [0.1, 0.5, 0.8], sample_rate: 44100 };
  if (cmd === 'audio_pause')          return 10.5; // pauseOffset seconds
  return undefined;
});
const writeAudioTemp = vi.fn(async () => '/tmp/audio.wav');

vi.mock('../renderer/js/tauri-api.js', () => ({ invoke, writeAudioTemp }));
vi.mock('../renderer/js/library-manager.js', () => ({ saveMeta: vi.fn(async () => undefined) }));

let TrackPlayer;
beforeEach(async () => {
  vi.resetModules();
  invoke.mockClear();
  writeAudioTemp.mockClear();
  const mod = await import('../renderer/js/track-player.js');
  TrackPlayer = mod.TrackPlayer;
});

function makePlayer(id = 'trk_1') {
  return new TrackPlayer(id);
}

// ─── Constructor / initial state ─────────────────────────────────────────────

describe('TrackPlayer — initial state', () => {
  it('starts not loaded and not playing', () => {
    const p = makePlayer();
    expect(p._loaded).toBe(false);
    expect(p.isPlaying).toBe(false);
  });

  it('stores the trackId', () => {
    const p = makePlayer('trk_42');
    expect(p.trackId).toBe('trk_42');
  });

  it('defaults: volume=1, masterVolume=1, speed=1, semitones=0, cents=0', () => {
    const p = makePlayer();
    expect(p.volume).toBe(1.0);
    expect(p._masterVolume).toBe(1.0);
    expect(p.speed).toBe(1.0);
    expect(p.semitones).toBe(0);
    expect(p.cents).toBe(0);
  });

  it('defaults: loopEnabled=false, loopStart=0, loopEnd=1', () => {
    const p = makePlayer();
    expect(p.loopEnabled).toBe(false);
    expect(p.loopStart).toBe(0);
    expect(p.loopEnd).toBe(1);
  });
});

// ─── _vol computed property ───────────────────────────────────────────────────

describe('TrackPlayer._vol', () => {
  it('returns volume * masterVolume * VOLUME_MULTIPLIER (0.75)', () => {
    const p = makePlayer();
    p.volume = 0.8;
    p._masterVolume = 0.5;
    expect(p._vol).toBeCloseTo(0.8 * 0.5 * 0.75, 5);
  });
});

// ─── loadBuffer ───────────────────────────────────────────────────────────────

describe('TrackPlayer.loadBuffer', () => {
  it('sets _loaded, duration and peaks after loading', async () => {
    const p = makePlayer();
    await p.loadBuffer(new ArrayBuffer(8));
    expect(p._loaded).toBe(true);
    expect(p.duration).toBe(180.0);
    expect(p.peaks).toHaveLength(3);
  });

  it('calls audio_load_file with the trackId', async () => {
    const p = makePlayer('trk_7');
    await p.loadBuffer(new ArrayBuffer(4));
    const loadCall = invoke.mock.calls.find(c => c[0] === 'audio_load_file');
    expect(loadCall[1].trackId).toBe('trk_7');
  });
});

// ─── play ─────────────────────────────────────────────────────────────────────

describe('TrackPlayer.play', () => {
  it('does nothing when not loaded', async () => {
    const p = makePlayer();
    await p.play(0, 1.0);
    expect(invoke).not.toHaveBeenCalledWith('audio_play', expect.anything());
  });

  it('calls audio_play with correct command name after loading', async () => {
    const p = makePlayer();
    await p.loadBuffer(new ArrayBuffer(8));
    invoke.mockClear();
    await p.play(0, 1.0);
    expect(invoke).toHaveBeenCalledWith('audio_play', expect.objectContaining({
      offsetSecs: 0,
      semitones: 0,
      cents: 0,
      speed: 1.0,
    }));
    expect(p.isPlaying).toBe(true);
  });

  it('passes the effective volume to audio_play', async () => {
    const p = makePlayer();
    await p.loadBuffer(new ArrayBuffer(8));
    invoke.mockClear();
    await p.play(0, 0.5);
    const call = invoke.mock.calls.find(c => c[0] === 'audio_play');
    expect(call[1].volume).toBeCloseTo(0.5 * 0.75, 5);
  });
});

// ─── pause ────────────────────────────────────────────────────────────────────

describe('TrackPlayer.pause', () => {
  it('does nothing when not playing', async () => {
    const p = makePlayer();
    await p.pause();
    expect(invoke).not.toHaveBeenCalledWith('audio_pause', expect.anything());
  });

  it('calls audio_pause and stores the returned position', async () => {
    const p = makePlayer();
    await p.loadBuffer(new ArrayBuffer(8));
    await p.play(0, 1.0);
    invoke.mockClear();
    await p.pause();
    expect(invoke).toHaveBeenCalledWith('audio_pause');
    expect(p.pauseOffset).toBe(10.5);
    expect(p.isPlaying).toBe(false);
  });
});

// ─── resume ───────────────────────────────────────────────────────────────────

describe('TrackPlayer.resume', () => {
  it('does nothing when already playing', async () => {
    const p = makePlayer();
    await p.loadBuffer(new ArrayBuffer(8));
    await p.play(0, 1.0);
    invoke.mockClear();
    await p.resume(); // already playing
    expect(invoke).not.toHaveBeenCalledWith('audio_resume');
  });

  it('calls audio_resume after a pause', async () => {
    const p = makePlayer();
    await p.loadBuffer(new ArrayBuffer(8));
    await p.play(0, 1.0);
    await p.pause();
    invoke.mockClear();
    await p.resume();
    expect(invoke).toHaveBeenCalledWith('audio_resume');
    expect(p.isPlaying).toBe(true);
  });
});

// ─── stop ─────────────────────────────────────────────────────────────────────

describe('TrackPlayer.stop', () => {
  it('calls audio_stop and clears playing state', async () => {
    const p = makePlayer();
    await p.loadBuffer(new ArrayBuffer(8));
    await p.play(0, 1.0);
    invoke.mockClear();
    await p.stop();
    expect(invoke).toHaveBeenCalledWith('audio_stop');
    expect(p.isPlaying).toBe(false);
    expect(p.pauseOffset).toBe(0);
  });

  it('preserves pauseOffset when resetOffset=false', async () => {
    const p = makePlayer();
    await p.loadBuffer(new ArrayBuffer(8));
    await p.play(0, 1.0);
    await p.pause(); // sets pauseOffset to 10.5
    await p.stop(false);
    expect(p.pauseOffset).toBe(10.5);
  });
});

// ─── seek ─────────────────────────────────────────────────────────────────────

describe('TrackPlayer.seek', () => {
  it('updates pauseOffset when not playing', async () => {
    const p = makePlayer();
    await p.loadBuffer(new ArrayBuffer(8)); // duration = 180
    await p.seek(0.5);
    expect(p.pauseOffset).toBeCloseTo(90.0, 1);
  });

  it('calls audio_seek when playing', async () => {
    const p = makePlayer();
    await p.loadBuffer(new ArrayBuffer(8));
    await p.play(0, 1.0);
    invoke.mockClear();
    await p.seek(0.25);
    expect(invoke).toHaveBeenCalledWith('audio_seek', expect.objectContaining({
      offsetSecs: expect.closeTo(45.0, 1),
    }));
  });
});

// ─── currentTime ─────────────────────────────────────────────────────────────

describe('TrackPlayer.currentTime', () => {
  it('returns pauseOffset', () => {
    const p = makePlayer();
    p.pauseOffset = 42;
    expect(p.currentTime).toBe(42);
  });
});

// ─── setVolume ────────────────────────────────────────────────────────────────

describe('TrackPlayer.setVolume', () => {
  it('updates volume and fires audio_set_volume', () => {
    const p = makePlayer();
    p.setVolume(0.6);
    expect(p.volume).toBe(0.6);
    expect(invoke).toHaveBeenCalledWith('audio_set_volume', expect.objectContaining({
      volume: expect.any(Number),
    }));
  });
});

// ─── setSemitones / setCents ──────────────────────────────────────────────────

describe('TrackPlayer.setSemitones', () => {
  it('updates semitones without invoking IPC when not playing', () => {
    const p = makePlayer();
    p.setSemitones(5);
    expect(p.semitones).toBe(5);
    expect(invoke).not.toHaveBeenCalledWith('audio_set_semitones', expect.anything());
  });
});

describe('TrackPlayer.setCents', () => {
  it('updates cents without invoking IPC when not playing', () => {
    const p = makePlayer();
    p.setCents(25);
    expect(p.cents).toBe(25);
  });
});

// ─── setLoopEnabled / setLoopPoints ──────────────────────────────────────────

describe('TrackPlayer.setLoopEnabled', () => {
  it('calls audio_set_loop with the enabled flag', () => {
    const p = makePlayer();
    p.setLoopEnabled(true);
    expect(invoke).toHaveBeenCalledWith('audio_set_loop', expect.objectContaining({ enabled: true }));
    expect(p.loopEnabled).toBe(true);
  });
});

describe('TrackPlayer.setLoopPoints', () => {
  it('converts fractional positions to absolute seconds and calls audio_set_loop', async () => {
    const p = makePlayer();
    await p.loadBuffer(new ArrayBuffer(8)); // duration = 180
    invoke.mockClear();
    p.setLoopPoints(0.1, 0.9);
    expect(p.loopStart).toBe(0.1);
    expect(p.loopEnd).toBe(0.9);
    expect(invoke).toHaveBeenCalledWith('audio_set_loop', expect.objectContaining({
      loopStart: expect.closeTo(18.0, 1),
      loopEnd:   expect.closeTo(162.0, 1),
    }));
  });
});

// ─── loadFile ─────────────────────────────────────────────────────────────────

describe('TrackPlayer.loadFile', () => {
  it('sets _loaded, duration, and peaks after loading', async () => {
    const p = makePlayer();
    await p.loadFile('/music/song.wav');
    expect(p._loaded).toBe(true);
    expect(p.duration).toBe(180.0);
    expect(p.peaks).toHaveLength(3);
  });

  it('calls audio_load_file with the provided path when not prefetched', async () => {
    const p = makePlayer('trk_1');
    await p.loadFile('/music/song.wav');
    const loadCall = invoke.mock.calls.find(c => c[0] === 'audio_load_file');
    expect(loadCall[1].path).toBe('/music/song.wav');
    expect(loadCall[1].keepFile).toBe(true);
  });

  it('passes empty path to audio_load_file when prefetch cache is hot', async () => {
    // Queue one-time return values: prefetch=true, then load result
    invoke.mockImplementationOnce(async () => true);
    invoke.mockImplementationOnce(async () => ({ duration: 180.0, peaks: [0.1], sample_rate: 44100 }));
    const p = makePlayer('trk_prefetch');
    await p.loadFile('/music/song.wav');
    const loadCall = invoke.mock.calls.find(c => c[0] === 'audio_load_file');
    expect(loadCall[1].path).toBe('');
  });

  it('passes cachedMeta fields to the invoke call', async () => {
    const meta = { peaks: [0.5], nativeDuration: 120.0, sampleRate: 48000 };
    const p = makePlayer();
    await p.loadFile('/music/song.wav', meta);
    const loadCall = invoke.mock.calls.find(c => c[0] === 'audio_load_file');
    expect(loadCall[1].cachedPeaks).toEqual([0.5]);
    expect(loadCall[1].cachedDuration).toBe(120.0);
    expect(loadCall[1].cachedSampleRate).toBe(48000);
  });

  it('sets peaks to null when result returns an empty peaks array', async () => {
    invoke.mockImplementationOnce(async () => false);
    invoke.mockImplementationOnce(async () => ({ duration: 60.0, peaks: [], sample_rate: 44100 }));
    const p = makePlayer();
    await p.loadFile('/music/song.wav');
    expect(p.peaks).toBeNull();
  });
});

// ─── setSpeed ─────────────────────────────────────────────────────────────────

describe('TrackPlayer.setSpeed', () => {
  it('updates speed state', () => {
    const p = makePlayer();
    p.setSpeed(1.5);
    expect(p.speed).toBe(1.5);
  });

  it('does not invoke IPC when not playing', () => {
    const p = makePlayer();
    p.setSpeed(1.5);
    expect(invoke).not.toHaveBeenCalledWith('audio_set_speed', expect.anything());
  });

  it('marks _seekedWhilePaused when speed changes while paused', async () => {
    const p = makePlayer();
    await p.loadBuffer(new ArrayBuffer(8));
    await p.play(0, 1.0);
    await p.pause();
    p.setSpeed(0.5);
    expect(p._seekedWhilePaused).toBe(true);
  });

  it('debounces audio_set_speed when playing', async () => {
    vi.useFakeTimers();
    const p = makePlayer();
    await p.loadBuffer(new ArrayBuffer(8));
    await p.play(0, 1.0);
    invoke.mockClear();
    p.setSpeed(0.75);
    expect(invoke).not.toHaveBeenCalledWith('audio_set_speed', expect.anything());
    vi.advanceTimersByTime(200);
    expect(invoke).toHaveBeenCalledWith('audio_set_speed', expect.objectContaining({ speed: 0.75 }));
    vi.useRealTimers();
  });

  it('sends current semitones and volume along with speed', async () => {
    vi.useFakeTimers();
    const p = makePlayer();
    await p.loadBuffer(new ArrayBuffer(8));
    p.semitones = 3;
    p.cents = 10;
    await p.play(0, 1.0);
    invoke.mockClear();
    p.setSpeed(1.25);
    vi.advanceTimersByTime(200);
    const call = invoke.mock.calls.find(c => c[0] === 'audio_set_speed');
    expect(call[1]).toMatchObject({ speed: 1.25, semitones: 3, cents: 10 });
    vi.useRealTimers();
  });
});

// ─── _schedulePitchInvoke debounce ────────────────────────────────────────────

describe('TrackPlayer pitch debounce', () => {
  it('fires audio_set_semitones after debounce delay when playing', async () => {
    vi.useFakeTimers();
    const p = makePlayer();
    await p.loadBuffer(new ArrayBuffer(8));
    await p.play(0, 1.0);
    invoke.mockClear();
    p.setSemitones(3);
    expect(invoke).not.toHaveBeenCalledWith('audio_set_semitones', expect.anything());
    vi.advanceTimersByTime(200);
    expect(invoke).toHaveBeenCalledWith('audio_set_semitones', expect.objectContaining({ semitones: 3 }));
    vi.useRealTimers();
  });

  it('coalesces rapid setSemitones calls into a single IPC call', async () => {
    vi.useFakeTimers();
    const p = makePlayer();
    await p.loadBuffer(new ArrayBuffer(8));
    await p.play(0, 1.0);
    invoke.mockClear();
    p.setSemitones(1);
    p.setSemitones(3);
    p.setSemitones(7);
    vi.advanceTimersByTime(200);
    const calls = invoke.mock.calls.filter(c => c[0] === 'audio_set_semitones');
    expect(calls).toHaveLength(1);
    expect(calls[0][1].semitones).toBe(7);
    vi.useRealTimers();
  });

  it('fires audio_set_semitones with current cents value', async () => {
    vi.useFakeTimers();
    const p = makePlayer();
    await p.loadBuffer(new ArrayBuffer(8));
    await p.play(0, 1.0);
    p.cents = 25;
    invoke.mockClear();
    p.setSemitones(5);
    vi.advanceTimersByTime(200);
    const call = invoke.mock.calls.find(c => c[0] === 'audio_set_semitones');
    expect(call[1].cents).toBe(25);
    vi.useRealTimers();
  });

  it('does not fire IPC for setCents when not playing', () => {
    const p = makePlayer();
    p.setCents(25);
    expect(p.cents).toBe(25);
    expect(invoke).not.toHaveBeenCalledWith('audio_set_semitones', expect.anything());
  });
});

// ─── seek edge cases ──────────────────────────────────────────────────────────

describe('TrackPlayer.seek — edge cases', () => {
  it('sets _seekedWhilePaused when seeking while not playing', async () => {
    const p = makePlayer();
    await p.loadBuffer(new ArrayBuffer(8));
    await p.seek(0.5);
    expect(p._seekedWhilePaused).toBe(true);
  });

  it('does NOT set _seekedWhilePaused when seeking while playing', async () => {
    const p = makePlayer();
    await p.loadBuffer(new ArrayBuffer(8));
    await p.play(0, 1.0);
    await p.seek(0.5);
    expect(p._seekedWhilePaused).not.toBe(true);
  });

  it('calls onProgress with fraction and absolute time when not playing', async () => {
    const p = makePlayer();
    await p.loadBuffer(new ArrayBuffer(8)); // duration = 180
    const onProgress = vi.fn();
    p.onProgress = onProgress;
    await p.seek(0.5);
    expect(onProgress).toHaveBeenCalledWith(0.5, expect.closeTo(90.0, 1));
  });

  it('passes loop points as absolute seconds to audio_seek', async () => {
    const p = makePlayer();
    await p.loadBuffer(new ArrayBuffer(8)); // duration = 180
    p.loopStart = 0.25;
    p.loopEnd = 0.75;
    await p.play(0, 1.0);
    invoke.mockClear();
    await p.seek(0.5);
    const call = invoke.mock.calls.find(c => c[0] === 'audio_seek');
    expect(call[1].loopStart).toBeCloseTo(45.0, 1);
    expect(call[1].loopEnd).toBeCloseTo(135.0, 1);
  });
});

// ─── resume edge case ─────────────────────────────────────────────────────────

describe('TrackPlayer.resume — edge cases', () => {
  it('does nothing when not loaded', async () => {
    const p = makePlayer();
    await p.resume();
    expect(invoke).not.toHaveBeenCalledWith('audio_resume');
    expect(p.isPlaying).toBe(false);
  });
});

// ─── play uses pauseOffset / _vol when args omitted ──────────────────────────

describe('TrackPlayer.play — defaults', () => {
  it('uses pauseOffset as offset when no offset argument is given', async () => {
    const p = makePlayer();
    await p.loadBuffer(new ArrayBuffer(8));
    await p.play(0, 1.0);
    await p.pause(); // sets pauseOffset = 10.5
    invoke.mockClear();
    await p.play(); // no offset arg
    const call = invoke.mock.calls.find(c => c[0] === 'audio_play');
    expect(call[1].offsetSecs).toBe(10.5);
  });

  it('uses _vol when no effectiveVolume argument is given', async () => {
    const p = makePlayer();
    p.volume = 0.8;
    p._masterVolume = 0.5;
    await p.loadBuffer(new ArrayBuffer(8));
    invoke.mockClear();
    await p.play();
    const call = invoke.mock.calls.find(c => c[0] === 'audio_play');
    expect(call[1].volume).toBeCloseTo(0.8 * 0.5 * 0.75, 5);
  });
});

// ─── masterVolume interaction ─────────────────────────────────────────────────

describe('TrackPlayer — masterVolume interaction', () => {
  it('_vol scales proportionally with _masterVolume', () => {
    const p = makePlayer();
    p.volume = 1.0;
    p._masterVolume = 1.0;
    const full = p._vol;
    p._masterVolume = 0.5;
    expect(p._vol).toBeCloseTo(full * 0.5, 5);
  });

  it('setVolume IPC call uses current _masterVolume', () => {
    const p = makePlayer();
    p._masterVolume = 0.5;
    p.setVolume(1.0);
    const call = invoke.mock.calls.find(c => c[0] === 'audio_set_volume');
    expect(call[1].volume).toBeCloseTo(1.0 * 0.5 * 0.75, 5);
  });
});

// ─── error handling ───────────────────────────────────────────────────────────

describe('TrackPlayer — fire-and-forget IPC calls do not throw', () => {
  it('setVolume swallows IPC rejection', async () => {
    invoke.mockRejectedValueOnce(new Error('IPC error'));
    const p = makePlayer();
    expect(() => p.setVolume(0.5)).not.toThrow();
    // allow the rejected promise to settle without unhandled rejection
    await Promise.resolve();
  });

  it('setLoopEnabled swallows IPC rejection', async () => {
    invoke.mockRejectedValueOnce(new Error('IPC error'));
    const p = makePlayer();
    expect(() => p.setLoopEnabled(true)).not.toThrow();
    await Promise.resolve();
  });

  it('setLoopPoints swallows IPC rejection', async () => {
    invoke.mockRejectedValueOnce(new Error('IPC error'));
    const p = makePlayer();
    expect(() => p.setLoopPoints(0.1, 0.9)).not.toThrow();
    await Promise.resolve();
  });
});
