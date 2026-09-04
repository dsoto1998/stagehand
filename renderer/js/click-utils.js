// ─── CLICK-TRACK UTILITIES (pure, no DOM / no Web Audio) ──────
//
// Shared by perform-panel.js and unit-tested in tests/click-utils.test.js.
// A "beat descriptor" is what the BeatNet sidecar writes:
//   { version, beats: [{ t, pos }], numerator, tempoBpm }
// where `t` is seconds on the song's own audio timeline and `pos` is the
// 1-indexed position of the beat within its bar (1 = downbeat).

/**
 * Number of beats in the song's first complete bar = gap between the first two
 * downbeats. Falls back to the widest position seen, then 4.
 */
export function deriveNumerator(positions) {
  const downbeats = [];
  for (let i = 0; i < positions.length; i++) if (positions[i] === 1) downbeats.push(i);
  if (downbeats.length >= 2) {
    const n = downbeats[1] - downbeats[0];
    if (n >= 2 && n <= 12) return n;
  }
  const seenMax = positions.reduce((m, p) => Math.max(m, p), 0);
  if (seenMax >= 2 && seenMax <= 12) return seenMax;
  return 4;
}

/** Median of a numeric array (does not mutate input). */
export function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Tempo (BPM) of the opening — median of the first `window` inter-beat
 * intervals. Used to space the count-off evenly.
 */
export function openingInterval(beats, window = 4) {
  const diffs = [];
  for (let i = 1; i < beats.length && i <= window; i++) {
    const d = beats[i].t - beats[i - 1].t;
    if (d > 0) diffs.push(d);
  }
  if (!diffs.length) return 0.5;
  return median(diffs);
}

/**
 * Build the full click schedule for a Perform session.
 *
 * @param descriptor  sidecar output ({ beats, numerator, tempoBpm })
 * @param opts.countOffBars  bars of count-off before beat 1 (default 2)
 * @returns {{
 *   interval0: number,            // seconds between count-off clicks
 *   countOffCount: number,        // number of count-off clicks
 *   firstClickSongTime: number,   // song-timeline seconds of the earliest click (may be < 0)
 *   songStartDelay: number,       // seconds from first click until song audio must start
 *   clicks: {songT:number, accent:boolean, countOff:boolean}[]  // chronological
 * }}
 */
export function buildClickSchedule(descriptor, opts = {}) {
  const countOffBars = opts.countOffBars ?? 2;
  const beats = descriptor.beats || [];
  if (beats.length < 2) {
    return { interval0: 0.5, countOffCount: 0, firstClickSongTime: 0, songStartDelay: 0, clicks: [] };
  }
  const numerator = descriptor.numerator || deriveNumerator(beats.map(b => b.pos));
  const interval0 = openingInterval(beats);
  const countOffCount = countOffBars * numerator;
  const beat1 = beats[0].t;
  const firstClickSongTime = beat1 - countOffCount * interval0;

  const clicks = [];
  // Count-off: k = countOffCount .. 1 beats before beat 1; accent on each bar start.
  for (let k = countOffCount; k >= 1; k--) {
    clicks.push({
      songT: beat1 - k * interval0,
      accent: k % numerator === 0,
      countOff: true,
    });
  }
  // Song beats: accent on the recorded downbeats.
  for (const b of beats) {
    clicks.push({ songT: b.t, accent: b.pos === 1, countOff: false });
  }

  return {
    interval0,
    countOffCount,
    firstClickSongTime,
    songStartDelay: countOffCount * interval0,
    clicks,
  };
}
