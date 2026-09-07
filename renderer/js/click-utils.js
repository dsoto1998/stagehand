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

/** Index of the beat in `beats` whose time is closest to `t`. */
function nearestBeatIndex(beats, t) {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < beats.length; i++) {
    const d = Math.abs(beats[i].t - t);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestIdx;
}

/**
 * Replace the run-up to a mid-song tempo change with a count-off in the NEW
 * tempo, landing exactly on the new section's first downbeat.
 *
 * Why: when a song changes tempo mid-piece, the clicks leading into the change
 * are in the OLD tempo, so a player gets no usable preparation — the new
 * section simply arrives. A live band counts the new tempo in. This does the
 * same: for each tempo change the sidecar reports in `tempoSegments`, the
 * clicks in the bar(s) before the change are dropped and replaced by evenly
 * spaced count-off clicks at the new tempo.
 *
 * Generic by construction — it is driven entirely by the reported segments, so
 * it fires on any song with a detected tempo change and does nothing on a song
 * without one.
 *
 * @param clicks     chronological [{songT, accent, countOff}]
 * @param beats      descriptor beats [{t, pos}]
 * @param segments   descriptor tempoSegments [{startT, endT, tempoBpm, confident}]
 * @param numerator  beats per bar
 * @param opts.minChangeRatio  ignore tempo differences smaller than this (default 4%)
 * @param opts.bars            bars of count-off to insert (default 1)
 */
export function applyTempoChangeCountOffs(clicks, beats, segments, numerator, opts = {}) {
  const minChangeRatio = opts.minChangeRatio ?? 0.04;
  const bars = Math.max(1, opts.bars ?? 1);
  if (!Array.isArray(segments) || segments.length < 2 || !beats.length) return clicks;

  let out = clicks;
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1];
    const seg = segments[i];
    if (!(prev.tempoBpm > 0) || !(seg.tempoBpm > 0)) continue;
    // Only a real tempo change, not drift within one section.
    if (Math.abs(seg.tempoBpm - prev.tempoBpm) / prev.tempoBpm < minChangeRatio) continue;

    // Land the count-off on the new section's first downbeat, so the band comes
    // in on beat one rather than mid-bar.
    let startIdx = -1;
    for (let k = 0; k < beats.length; k++) {
      if (beats[k].t >= seg.startT - 1e-6) { startIdx = k; break; }
    }
    if (startIdx < 0) continue;
    let downIdx = -1;
    for (let k = startIdx; k < beats.length && k < startIdx + numerator * 2; k++) {
      if (beats[k].pos === 1) { downIdx = k; break; }
    }
    const beatOne = beats[downIdx >= 0 ? downIdx : startIdx].t;

    const interval = 60 / seg.tempoBpm;
    const count = bars * numerator;
    const from = beatOne - count * interval;
    if (from < 0) continue;

    // Drop whatever clicks occupied that span (they are in the old tempo) and
    // put an even count-off at the new tempo in their place.
    const kept = out.filter(c => c.songT < from - 1e-9 || c.songT >= beatOne - 1e-9);
    const countOff = [];
    for (let k = count; k >= 1; k--) {
      countOff.push({
        songT: beatOne - k * interval,
        accent: k % numerator === 0,
        countOff: true,
      });
    }
    out = [...kept, ...countOff].sort((a, b) => a.songT - b.songT);
  }
  return out;
}

/**
 * Build the full click schedule for a Perform session.
 *
 * @param descriptor  sidecar output ({ beats, numerator, tempoBpm, anchorT? })
 *   `anchorT` (seconds, optional) is the sidecar's energy-confidence guess at
 *   which downbeat is the "real" start of the song (see beat_detect.pick_anchor)
 *   — used when it's more trustworthy than BeatNet's own (musically arbitrary)
 *   first pos===1 label.
 * @param opts.countOffBars  minimum bars of count-off before beat 1 (default 2) —
 *   grows automatically if beat 1 sits further into the file than that reaches
 * @param opts.anchorOverrideSec  manual override (seconds, song timeline) for
 *   where "beat 1" really is — wins over everything else, incl. descriptor.anchorT.
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

  // Anchor priority: explicit manual marker > sidecar's energy-confidence guess
  // > BeatNet's own first true downbeat > first detected beat at all. Anchoring
  // the count-off's last click here — not just to the first detected beat —
  // avoids a short/incomplete bar after the count-off when BeatNet starts
  // mid-bar (pickup beats).
  const firstDownbeatIdx = beats.findIndex(b => b.pos === 1);
  const hasOverride = Number.isFinite(opts.anchorOverrideSec);
  const hasAutoAnchor = Number.isFinite(descriptor.anchorT);
  const beat1 = hasOverride ? opts.anchorOverrideSec
    : hasAutoAnchor ? descriptor.anchorT
    : firstDownbeatIdx >= 0 ? beats[firstDownbeatIdx].t
    : beats[0].t;

  // Accent (the loud "beat one" click) is keyed off *index* distance from the
  // resolved anchor, not raw time division — a fixed interval extrapolated
  // across a whole song would drift out of phase with any real tempo wobble,
  // while an index offset rides along with BeatNet's own per-beat tracking.
  const anchorIdx = (hasOverride || hasAutoAnchor) ? nearestBeatIndex(beats, beat1)
    : firstDownbeatIdx >= 0 ? firstDownbeatIdx
    : 0;
  const isAccentIdx = i => (((i - anchorIdx) % numerator) + numerator) % numerator === 0;

  // Tempo for count-off spacing: sample near the resolved anchor, not always
  // the start of the array — a manual/auto anchor can sit many beats past
  // array start (e.g. past a hallucinated or non-rhythmic lead-in), and the
  // array's own opening intervals are exactly the ones least trustworthy then.
  const interval0 = openingInterval(beats.slice(anchorIdx));

  // The count-off is at least `countOffBars` bars, but extends further when the
  // anchor sits deeper into the file than that reaches — a long non-rhythmic
  // intro (SFX, noise) still plays in full underneath (the recording is never
  // cut), the metronome just keeps clicking at the anchor's tempo for as long
  // as it takes to reach it, landing beat one exactly when the count-off ends.
  const minCount = countOffBars * numerator;
  const barsToAnchor = beat1 > 0 ? Math.ceil(beat1 / (interval0 * numerator)) : 0;
  const countOffCount = Math.max(minCount, barsToAnchor * numerator);
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
  // Song beats from the anchor onward: accent on it and every `numerator`
  // beats from it. Beats *before* the anchor are dropped here — inside a long
  // lead-in they're exactly the ones the anchor logic decided aren't reliably
  // rhythmic (or are a short pickup already fully covered by the extended
  // count-off above) — the recording still plays them in full, they just
  // aren't double-clicked.
  beats.forEach((b, i) => {
    if (i < anchorIdx) return;
    clicks.push({ songT: b.t, accent: isAccentIdx(i), countOff: false });
  });

  // Mid-song tempo changes get their own count-off in the new tempo, replacing
  // the old-tempo clicks that led into them (see applyTempoChangeCountOffs).
  const withCountOffs = opts.tempoChangeCountOff === false
    ? clicks
    : applyTempoChangeCountOffs(
        clicks, beats, descriptor.tempoSegments, numerator,
        { bars: opts.tempoChangeCountOffBars ?? 1 },
      );

  return {
    interval0,
    countOffCount,
    firstClickSongTime,
    songStartDelay: countOffCount * interval0,
    clicks: withCountOffs,
  };
}
