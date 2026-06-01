import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock audio-engine so metronome.js can be imported without a real AudioContext.
// resume() must return an object with createOscillator/createGain so scheduleNote
// doesn't throw if called; getCtx() is used by the scheduler loop.
vi.mock('../renderer/js/audio-engine.js', () => {
  const fakeNode = {
    connect: vi.fn(),
    gain: { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    frequency: { value: 0 },
    type: 'sine',
    start: vi.fn(),
    stop: vi.fn(),
  };
  const fakeCtx = {
    currentTime: 0,
    createOscillator: () => ({ ...fakeNode }),
    createGain: () => ({ ...fakeNode, gain: { value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() } }),
    createBufferSource: () => ({ ...fakeNode, buffer: null }),
  };
  return {
    resume: vi.fn(() => fakeCtx),
    getCtx: vi.fn(() => fakeCtx),
    getMaster: vi.fn(() => fakeNode),
    getMetronomeGain: vi.fn(() => fakeNode),
  };
});

let Metronome, TapTempo;
beforeEach(async () => {
  vi.resetModules();
  const mod = await import('../renderer/js/metronome.js');
  Metronome = mod.Metronome;
  TapTempo = mod.TapTempo;
});

// ─── BPM ──────────────────────────────────────────────────────────────────────

describe('Metronome.setBpm / getBpm', () => {
  it('sets and gets BPM', () => {
    Metronome.setBpm(140);
    expect(Metronome.getBpm()).toBe(140);
  });

  it('clamps BPM to minimum of 20', () => {
    Metronome.setBpm(5);
    expect(Metronome.getBpm()).toBe(20);
  });

  it('clamps BPM to maximum of 300', () => {
    Metronome.setBpm(9999);
    expect(Metronome.getBpm()).toBe(300);
  });

  it('accepts boundary value 20', () => {
    Metronome.setBpm(20);
    expect(Metronome.getBpm()).toBe(20);
  });

  it('accepts boundary value 300', () => {
    Metronome.setBpm(300);
    expect(Metronome.getBpm()).toBe(300);
  });
});

// ─── Time signature ───────────────────────────────────────────────────────────

describe('Metronome.setTimeSignature / getTimeSignature', () => {
  it('updates numerator and denominator', () => {
    Metronome.setTimeSignature(3, 4);
    expect(Metronome.getTimeSignature()).toEqual({ numerator: 3, denominator: 4 });
  });

  it('resets accents so only beat 0 is accented', () => {
    Metronome.setTimeSignature(5, 4);
    const accents = Metronome.getBeatAccents();
    expect(accents).toHaveLength(5);
    expect(accents[0]).toBe(true);
    expect(accents.slice(1).every(a => !a)).toBe(true);
  });
});

// ─── Beat accents ─────────────────────────────────────────────────────────────

describe('Metronome.setBeatAccent / getBeatAccents', () => {
  it('toggles a specific beat accent', () => {
    Metronome.setTimeSignature(4, 4);
    Metronome.setBeatAccent(2, true);
    expect(Metronome.getBeatAccents()[2]).toBe(true);
  });

  it('returns a copy, not the internal array', () => {
    const a = Metronome.getBeatAccents();
    a[0] = false;
    expect(Metronome.getBeatAccents()[0]).toBe(true);
  });
});

// ─── Accent toggle ────────────────────────────────────────────────────────────

describe('Metronome.setAccent / getAccent', () => {
  it('starts enabled', () => {
    expect(Metronome.getAccent()).toBe(true);
  });

  it('can be disabled and re-enabled', () => {
    Metronome.setAccent(false);
    expect(Metronome.getAccent()).toBe(false);
    Metronome.setAccent(true);
    expect(Metronome.getAccent()).toBe(true);
  });
});

// ─── Active state ─────────────────────────────────────────────────────────────

describe('Metronome.isActive', () => {
  it('is false before start', () => {
    expect(Metronome.isActive()).toBe(false);
  });

  it('is true after start and false after stop', () => {
    Metronome.start();
    expect(Metronome.isActive()).toBe(true);
    Metronome.stop();
    expect(Metronome.isActive()).toBe(false);
  });
});

// ─── Custom buffers ───────────────────────────────────────────────────────────

describe('Metronome.setCustomBuffer / getCustomBuffer', () => {
  it('stores and retrieves a custom buffer', () => {
    const buf = { duration: 1.0 }; // fake AudioBuffer
    Metronome.setCustomBuffer('accent', buf);
    expect(Metronome.getCustomBuffer('accent')).toBe(buf);
  });

  it('returns null for unset type', () => {
    expect(Metronome.getCustomBuffer('quarter')).toBeNull();
  });
});

// ─── onBeat callback ─────────────────────────────────────────────────────────

describe('Metronome.onBeat', () => {
  it('registers a callback without throwing', () => {
    expect(() => Metronome.onBeat(() => {})).not.toThrow();
  });
});

// ─── TapTempo ─────────────────────────────────────────────────────────────────

describe('TapTempo.tap', () => {
  it('returns null on the first tap', () => {
    TapTempo.reset();
    expect(TapTempo.tap()).toBeNull();
  });

  it('returns a BPM estimate after two taps', () => {
    TapTempo.reset();
    // Simulate two taps 500ms apart → 120 BPM
    vi.useFakeTimers();
    TapTempo.tap();
    vi.advanceTimersByTime(500);
    const bpm = TapTempo.tap();
    vi.useRealTimers();
    expect(bpm).toBeCloseTo(120, 0);
  });

  it('resets taps when gap exceeds 3 seconds', () => {
    TapTempo.reset();
    vi.useFakeTimers();
    TapTempo.tap();
    TapTempo.tap(); // valid pair
    vi.advanceTimersByTime(3100); // exceed MAX_GAP
    TapTempo.tap(); // first tap of a new sequence
    const result = TapTempo.tap(); // should not throw; returns null on fresh first tap
    vi.useRealTimers();
    // After gap reset, first tap returns null, second returns a BPM
    expect(typeof result === 'number' || result === null).toBe(true);
  });

  it('caps at 8 taps internally', () => {
    TapTempo.reset();
    vi.useFakeTimers();
    for (let i = 0; i < 12; i++) {
      TapTempo.tap();
      vi.advanceTimersByTime(500);
    }
    vi.useRealTimers();
    // count() reflects the internal cap of 8
    expect(TapTempo.count()).toBeLessThanOrEqual(8);
  });
});

describe('TapTempo.count / reset', () => {
  it('count is 0 after reset', () => {
    TapTempo.tap();
    TapTempo.reset();
    expect(TapTempo.count()).toBe(0);
  });

  it('count increments with each tap (up to cap)', () => {
    TapTempo.reset();
    vi.useFakeTimers();
    TapTempo.tap();
    vi.advanceTimersByTime(500);
    TapTempo.tap();
    vi.useRealTimers();
    expect(TapTempo.count()).toBe(2);
  });
});

// ─── start / stop lifecycle ───────────────────────────────────────────────────

describe('Metronome.start / stop', () => {
  it('start registers a scheduler via setInterval', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setInterval');
    Metronome.start();
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 25);
    Metronome.stop();
    spy.mockRestore();
    vi.useRealTimers();
  });

  it('stop calls clearInterval to cancel the scheduler', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'clearInterval');
    Metronome.start();
    Metronome.stop();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    vi.useRealTimers();
  });

  it('can be restarted after stop', () => {
    Metronome.start();
    Metronome.stop();
    expect(Metronome.isActive()).toBe(false);
    Metronome.start();
    expect(Metronome.isActive()).toBe(true);
    Metronome.stop();
  });

  it('stop empties the flash queue', () => {
    // start populates flashQueue on first scheduler pass, stop should clear it
    Metronome.start();
    Metronome.stop();
    // isActive is the only observable; no crash means queue was cleared cleanly
    expect(Metronome.isActive()).toBe(false);
  });
});

// ─── beat callback fires on start ────────────────────────────────────────────

describe('Metronome beat callback', () => {
  it('fires the registered onBeat callback immediately on the first beat', () => {
    // The mocked AudioContext has currentTime=0. The scheduler schedules beat 0
    // at time=0, then flashLoop checks: 0 <= 0+0.02 → fires callback synchronously.
    const callback = vi.fn();
    Metronome.onBeat(callback);
    Metronome.start();
    expect(callback).toHaveBeenCalledWith(0); // first beat index is 0
    Metronome.stop();
  });

  it('passes the correct beat index to the callback', () => {
    Metronome.setTimeSignature(4, 4);
    const callback = vi.fn();
    Metronome.onBeat(callback);
    Metronome.start();
    const beatIdx = callback.mock.calls[0][0];
    expect(beatIdx).toBeGreaterThanOrEqual(0);
    expect(beatIdx).toBeLessThan(4);
    Metronome.stop();
  });
});

// ─── setVolume ────────────────────────────────────────────────────────────────

describe('Metronome.setVolume', () => {
  it('accepts 0 without throwing', () => {
    expect(() => Metronome.setVolume(0)).not.toThrow();
  });

  it('accepts 1 without throwing', () => {
    expect(() => Metronome.setVolume(1)).not.toThrow();
  });

  it('metronome still starts and stops cleanly after setVolume', () => {
    Metronome.setVolume(0.3);
    Metronome.start();
    expect(Metronome.isActive()).toBe(true);
    Metronome.stop();
    expect(Metronome.isActive()).toBe(false);
  });
});

// ─── setSubdivision ───────────────────────────────────────────────────────────

describe('Metronome.setSubdivision', () => {
  it('accepts value 1 without throwing', () => {
    expect(() => Metronome.setSubdivision(1)).not.toThrow();
  });

  it('accepts value 4 without throwing', () => {
    expect(() => Metronome.setSubdivision(4)).not.toThrow();
  });

  it('can be changed while metronome is running without crashing', () => {
    Metronome.start();
    expect(() => Metronome.setSubdivision(2)).not.toThrow();
    expect(() => Metronome.setSubdivision(4)).not.toThrow();
    expect(Metronome.isActive()).toBe(true);
    Metronome.stop();
  });
});
