import { describe, expect, it } from 'vitest';
import {
  deriveNumerator,
  median,
  openingInterval,
  buildClickSchedule,
  applyTempoChangeCountOffs,
} from '../renderer/js/click-utils.js';

/**
 * Build a beat array: `specs` is a list of {bpm, bars, from} run descriptions.
 * Returns evenly spaced beats with cycling bar positions.
 */
function makeBeats(specs, numerator = 4) {
  const beats = [];
  let t = specs[0].from ?? 0;
  for (const s of specs) {
    if (s.from != null) t = s.from;
    const iv = 60 / s.bpm;
    for (let bar = 0; bar < s.bars; bar++) {
      for (let k = 0; k < numerator; k++) {
        beats.push({ t: +t.toFixed(6), pos: k + 1 });
        t += iv;
      }
    }
  }
  return beats;
}

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

  it('anchors count-off to the first true downbeat, not just the first detected beat (pickup beats)', () => {
    // BeatNet starts mid-bar: beats 3,4 (pickup) then downbeats at pos 1.
    const beats = [
      { t: 0.0, pos: 3 },
      { t: 0.5, pos: 4 },
      { t: 1.0, pos: 1 },
      { t: 1.5, pos: 2 },
      { t: 2.0, pos: 3 },
      { t: 2.5, pos: 4 },
      { t: 3.0, pos: 1 },
    ];
    const d = { version: 1, beats, numerator: 4, tempoBpm: 120 };
    const s = buildClickSchedule(d, { countOffBars: 2 });

    // last count-off click sits exactly one interval before the first downbeat (t=1.0),
    // not before the first detected beat (t=0.0, pos 3).
    const countOff = s.clicks.filter(c => c.countOff);
    expect(countOff[countOff.length - 1].songT).toBeCloseTo(0.5, 6);
    expect(s.firstClickSongTime).toBeCloseTo(1.0 - 8 * 0.5, 6);
  });

  it('uses descriptor.anchorT over the first true downbeat when present', () => {
    // BeatNet's own pos===1 grid lands on 1.0, 3.0 (a full bar apart) — but the
    // sidecar's energy-confidence guess (anchorT) points at 2.0, a beat that's
    // NOT on that same modular cycle (e.g. a real pickup mislabeled "measure 1").
    const beats = [
      { t: 0.0, pos: 3 }, { t: 0.5, pos: 4 },
      { t: 1.0, pos: 1 }, { t: 1.5, pos: 2 }, { t: 2.0, pos: 3 }, { t: 2.5, pos: 4 },
      { t: 3.0, pos: 1 }, { t: 3.5, pos: 2 }, { t: 4.0, pos: 3 }, { t: 4.5, pos: 4 },
    ];
    const d = { version: 1, beats, numerator: 4, tempoBpm: 120, anchorT: 2.0 };
    const s = buildClickSchedule(d, { countOffBars: 2 });

    expect(s.firstClickSongTime).toBeCloseTo(2.0 - 8 * 0.5, 6);
    // accent now falls on the anchorT cycle (2.0, 4.0), not BeatNet's own
    // pos===1 cycle (1.0, 3.0). Beats before the anchor (0.0, 0.5, 1.0, 1.5)
    // aren't reliably rhythmic by definition of needing an anchor override —
    // they're dropped from the real-beat clicks entirely (the extended
    // count-off above already covers that span).
    const accented = s.clicks.filter(c => !c.countOff && c.accent).map(c => c.songT);
    expect(accented).toEqual(expect.arrayContaining([2.0, 4.0]));
    expect(accented).not.toContain(0.0);
    expect(accented).not.toContain(1.0);
    expect(accented).not.toContain(3.0);
  });

  it('a manual anchorOverrideSec wins over descriptor.anchorT', () => {
    const beats = [
      { t: 0.0, pos: 1 }, { t: 0.5, pos: 2 }, { t: 1.0, pos: 3 }, { t: 1.5, pos: 4 },
      { t: 2.0, pos: 1 }, { t: 2.5, pos: 2 }, { t: 3.0, pos: 3 }, { t: 3.5, pos: 4 },
      { t: 4.0, pos: 1 },
    ];
    const d = { version: 1, beats, numerator: 4, tempoBpm: 120, anchorT: 2.0 };
    const s = buildClickSchedule(d, { countOffBars: 2, anchorOverrideSec: 3.5 });

    expect(s.firstClickSongTime).toBeCloseTo(3.5 - 8 * 0.5, 6);
    const accented = s.clicks.filter(c => !c.countOff && c.accent).map(c => c.songT);
    expect(accented).toContain(3.5);
    // 1.5 is on the same modular cycle as 3.5, but sits *before* the anchor —
    // dropped, not double-clicked (the count-off already covers it).
    expect(accented).not.toContain(1.5);
    expect(accented).not.toContain(2.0); // descriptor.anchorT's own cycle, overridden
    expect(accented).not.toContain(0.0); // BeatNet's own pos===1 cycle
  });

  it('extends the count-off (beyond countOffBars) to reach a distant anchor, never a negative delay', () => {
    // 4/4 @ 125bpm (interval0=0.48s): a standard 2-bar count-off only reaches
    // back 3.84s, but the anchor sits at 6.92s (e.g. a long SFX/noise intro
    // before the real downbeat). The count-off should grow to cover it — the
    // recording (including the noise intro) still plays in full underneath;
    // it's just the synthetic click that keeps going until beat one arrives.
    const beats = [];
    for (let i = 0; i < 20; i++) beats.push({ t: +(i * 0.48).toFixed(4), pos: (i % 4) + 1 });
    const d = { version: 1, beats, numerator: 4, tempoBpm: 125, anchorT: 6.92 };
    const s = buildClickSchedule(d, { countOffBars: 2 });

    // never a negative/zero audio-start delay — the bug this guards against.
    expect(-s.firstClickSongTime).toBeGreaterThan(0);
    // grew well past the standard 2-bar (8-beat) minimum.
    expect(s.countOffCount).toBeGreaterThan(8);
    // count-off's last click lands exactly one interval before the anchor itself
    // (6.92), not before some fallback point — beat one arrives right on time.
    const countOff = s.clicks.filter(c => c.countOff);
    expect(countOff[countOff.length - 1].songT).toBeCloseTo(6.92 - 0.48, 6);
    // the accent follows the anchor (nearest real beat to 6.92s: t=6.72 at i=14).
    const accented = s.clicks.filter(c => !c.countOff && c.accent).map(c => c.songT);
    expect(accented).toContain(6.72);
    expect(accented).not.toContain(0);
    // beats before the anchor are dropped from the real-click list entirely —
    // the extended count-off already covers that whole span, no double-clicking.
    expect(s.clicks.some(c => !c.countOff && c.songT < 6.72)).toBe(false);
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

// ─── applyTempoChangeCountOffs ───────────────────────────────

describe('applyTempoChangeCountOffs', () => {
  // 4 bars at 120bpm (0.5s/beat) then 4 bars at 90bpm (0.6667s/beat).
  const beats = makeBeats([{ bpm: 120, bars: 4, from: 0 }, { bpm: 90, bars: 4 }]);
  const changeT = beats[16].t; // first beat of the 90bpm section
  const segments = [
    { startT: 0, endT: beats[15].t, tempoBpm: 120, confident: true },
    { startT: changeT, endT: beats[31].t, tempoBpm: 90, confident: true },
  ];
  const plain = beats.map(b => ({ songT: b.t, accent: b.pos === 1, countOff: false }));

  it('lands the count-off exactly on the new section first downbeat', () => {
    const out = applyTempoChangeCountOffs(plain, beats, segments, 4);
    const co = out.filter(c => c.countOff);
    expect(co).toHaveLength(4);
    const last = co[co.length - 1];
    expect(last.songT + 60 / 90).toBeCloseTo(changeT, 6);
  });

  it('spaces the count-off at the NEW tempo, not the old', () => {
    const out = applyTempoChangeCountOffs(plain, beats, segments, 4);
    const co = out.filter(c => c.countOff).map(c => c.songT);
    for (let i = 1; i < co.length; i++) {
      expect(co[i] - co[i - 1]).toBeCloseTo(60 / 90, 6);
    }
  });

  it('replaces the old-tempo clicks in that span rather than adding to them', () => {
    const out = applyTempoChangeCountOffs(plain, beats, segments, 4);
    const from = changeT - 4 * (60 / 90);
    const inSpan = out.filter(c => c.songT >= from - 1e-9 && c.songT < changeT - 1e-9);
    expect(inSpan.every(c => c.countOff)).toBe(true);
    expect(inSpan).toHaveLength(4);
  });

  it('leaves clicks outside the count-off span untouched', () => {
    const out = applyTempoChangeCountOffs(plain, beats, segments, 4);
    expect(out.filter(c => c.songT >= changeT - 1e-9)).toHaveLength(
      plain.filter(c => c.songT >= changeT - 1e-9).length,
    );
  });

  it('ignores drift below the change threshold', () => {
    const segs = [
      { startT: 0, endT: beats[15].t, tempoBpm: 120, confident: true },
      { startT: changeT, endT: beats[31].t, tempoBpm: 122, confident: true },
    ];
    const out = applyTempoChangeCountOffs(plain, beats, segs, 4);
    expect(out.filter(c => c.countOff)).toHaveLength(0);
  });

  it('does nothing when the song has a single tempo segment', () => {
    const out = applyTempoChangeCountOffs(plain, beats, [segments[0]], 4);
    expect(out).toEqual(plain);
  });

  it('keeps the schedule chronological', () => {
    const out = applyTempoChangeCountOffs(plain, beats, segments, 4);
    const ts = out.map(c => c.songT);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it('is applied automatically by buildClickSchedule', () => {
    const d = { beats, numerator: 4, tempoSegments: segments, anchorT: beats[0].t };
    const s = buildClickSchedule(d, { countOffBars: 2 });
    const mid = s.clicks.filter(c => c.countOff && c.songT > beats[8].t);
    expect(mid.length).toBeGreaterThan(0);
  });
});
