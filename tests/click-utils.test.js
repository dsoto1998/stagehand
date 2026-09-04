import { describe, expect, it } from 'vitest';
import {
  deriveNumerator,
  median,
  openingInterval,
  buildClickSchedule,
} from '../renderer/js/click-utils.js';

// ─── deriveNumerator ─────────────────────────────────────────

describe('deriveNumerator', () => {
  it('reads the gap between the first two downbeats', () => {
    expect(deriveNumerator([1, 2, 3, 4, 1, 2, 3, 4, 1])).toBe(4);
  });

  it('detects 3/4', () => {
    expect(deriveNumerator([1, 2, 3, 1, 2, 3, 1])).toBe(3);
  });

  it('detects odd meters (7)', () => {
    expect(deriveNumerator([1, 2, 3, 4, 5, 6, 7, 1, 2, 3, 4, 5, 6, 7])).toBe(7);
  });

  it('falls back to widest position when only one downbeat', () => {
    expect(deriveNumerator([3, 4, 1, 2, 3, 4])).toBe(4);
  });

  it('falls back to 4 when positions are unusable', () => {
    expect(deriveNumerator([])).toBe(4);
    expect(deriveNumerator([1, 1, 1])).toBe(4);
  });
});

// ─── median / openingInterval ────────────────────────────────

describe('median', () => {
  it('odd length', () => expect(median([3, 1, 2])).toBe(2));
  it('even length averages the middle pair', () => expect(median([1, 2, 3, 4])).toBe(2.5));
  it('empty', () => expect(median([])).toBe(0));
  it('does not mutate input', () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe('openingInterval', () => {
  it('is the median of the first few inter-beat gaps', () => {
    const beats = [{ t: 0 }, { t: 0.5 }, { t: 1.0 }, { t: 1.5 }, { t: 2.0 }];
    expect(openingInterval(beats)).toBeCloseTo(0.5, 6);
  });

  it('ignores a late outlier beyond the window', () => {
    const beats = [{ t: 0 }, { t: 0.5 }, { t: 1.0 }, { t: 1.5 }, { t: 9.0 }];
    expect(openingInterval(beats, 3)).toBeCloseTo(0.5, 6);
  });
});

// ─── buildClickSchedule ──────────────────────────────────────

function grid(numerator, count, interval, startT) {
  const beats = [];
  for (let i = 0; i < count; i++) {
    beats.push({ t: +(startT + i * interval).toFixed(4), pos: (i % numerator) + 1 });
  }
  return { version: 1, beats, numerator, tempoBpm: 60 / interval };
}

describe('buildClickSchedule', () => {
  it('prepends 2 bars of count-off ending exactly at beat 1', () => {
    const d = grid(4, 16, 0.5, 1.0); // 120bpm 4/4, first beat at t=1.0s
    const s = buildClickSchedule(d, { countOffBars: 2 });

    expect(s.countOffCount).toBe(8);
    expect(s.interval0).toBeCloseTo(0.5, 6);
    // last count-off click is one interval before beat 1
    const countOff = s.clicks.filter(c => c.countOff);
    expect(countOff).toHaveLength(8);
    expect(countOff[countOff.length - 1].songT).toBeCloseTo(0.5, 6);
    expect(countOff[0].songT).toBeCloseTo(1.0 - 8 * 0.5, 6);
    // first real beat retained
    const firstSong = s.clicks.find(c => !c.countOff);
    expect(firstSong.songT).toBeCloseTo(1.0, 6);
  });

  it('accents every bar start in the count-off and every recorded downbeat', () => {
    const d = grid(3, 12, 0.4, 0.4); // 3/4
    const s = buildClickSchedule(d, { countOffBars: 2 });

    const countOff = s.clicks.filter(c => c.countOff);
    // count-off accents at positions 0 and 3 (bar boundaries) → 2 accents over 6 clicks
    expect(countOff.filter(c => c.accent)).toHaveLength(2);
    // song downbeats: pos===1 → 4 over 12 beats
    expect(s.clicks.filter(c => !c.countOff && c.accent)).toHaveLength(4);
  });

  it('songStartDelay is the full count-off length', () => {
    const d = grid(4, 16, 0.5, 2.3);
    const s = buildClickSchedule(d, { countOffBars: 2 });
    expect(s.songStartDelay).toBeCloseTo(8 * 0.5, 6);
    expect(s.firstClickSongTime).toBeCloseTo(2.3 - 8 * 0.5, 6);
  });

  it('degrades gracefully with too few beats', () => {
    const s = buildClickSchedule({ beats: [{ t: 0, pos: 1 }], numerator: 4 });
    expect(s.clicks).toEqual([]);
  });

  it('clicks are chronological', () => {
    const d = grid(4, 24, 0.5, 1.0);
    const s = buildClickSchedule(d, { countOffBars: 2 });
    const ts = s.clicks.map(c => c.songT);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });
});
