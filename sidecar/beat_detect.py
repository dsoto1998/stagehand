"""
beat_detect — Stagehand click-track analysis sidecar.

Runs BeatNet (offline / DBN) on one audio file and writes a JSON descriptor of
the beat grid: every beat time (seconds) with its position within the bar
(1 = downbeat), plus the derived starting time-signature numerator and a rough
overall tempo.

Usage:
    beat_detect --input <audio file> --output <json path> [--model 1] [--max-num N]

Progress is written to stdout as one JSON object per line, e.g.
    {"stage": "loading"}
    {"stage": "analyzing"}
    {"stage": "done", "beats": 812, "numerator": 4, "tempoBpm": 128.1}

On failure: a human-readable message on stderr and a non-zero exit code.

The Stagehand Rust backend decodes the source track to a mono WAV first and
passes that path in --input; librosa (inside BeatNet) resamples it to 22050 Hz.
"""

import argparse
import json
import math
import os
import statistics
import sys
import tempfile
import time


def log(**kw):
    """Emit one progress record as a JSON line on stdout."""
    sys.stdout.write(json.dumps(kw) + "\n")
    sys.stdout.flush()


def find_lead_silence(path, frame_ms=50, sustain_frames=6, floor_db=-45.0, drop_db=30.0):
    """
    Seconds of true leading silence/near-silence before the first sustained real
    audio. BeatNet will happily invent a steady-looking beat grid over dead air
    (confirmed on real recordings with an editing-artifact silence pad before
    the first note) — trimming this out before analysis avoids those phantom
    beats. Threshold is adaptive (relative to the track's own loud level, floored
    at floor_db) rather than a fixed dBFS cutoff, since normal mixes vary.
    "Sustained" requires `sustain_frames` consecutive frames above threshold, so
    a single loud transient (click, edit pop) can't trigger an early false trim.
    """
    import numpy as np
    import soundfile as sf

    data, sr = sf.read(path, always_2d=False, dtype="float32")
    if data.ndim > 1:
        data = data.mean(axis=1)
    frame_len = max(1, int(sr * frame_ms / 1000))
    n_frames = len(data) // frame_len
    if n_frames <= sustain_frames:
        return 0.0

    rms = np.array([
        np.sqrt(np.mean(data[i * frame_len:(i + 1) * frame_len].astype(np.float64) ** 2) + 1e-12)
        for i in range(n_frames)
    ])
    rms_db = 20 * np.log10(rms + 1e-12)
    ref_db = np.percentile(rms_db, 90)  # the track's own "loud" reference level
    thresh = max(ref_db - drop_db, floor_db)
    above = rms_db > thresh

    for i in range(n_frames - sustain_frames):
        if above[i:i + sustain_frames].all():
            return round(i * frame_ms / 1000.0, 3)
    return 0.0


def trim_lead_silence(input_path, trim_sec):
    """Write a copy of input_path with the first trim_sec cut off. Caller deletes it."""
    import soundfile as sf

    data, sr = sf.read(input_path, always_2d=False)
    start = int(round(trim_sec * sr))
    trimmed = data[start:]
    fd, out_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    sf.write(out_path, trimmed, sr)
    return out_path


def refine_weak_attack_beats(input_path, beats, weak_ratio=0.2, max_nudge_ratio=0.4, min_nudge_sec=0.04):
    """
    Nudge beat times that land on a weak/absent transient (a slide, bend, or
    legato note change — no pick attack for amplitude-based tracking to grab)
    toward an independently pitch-change-tracked beat instead.

    Amplitude onset-strength is BeatNet's core signal; where it's weak at a
    claimed beat time, that beat's timing is the least trustworthy in the
    grid. A frame-to-frame chroma (harmonic/pitch) distance curve keeps
    tracking through those spots — a bent or slid note still changes pitch
    even with no attack — so a beat-tracker run on THAT curve independently
    is a plausible correction, but it's not authoritative either (no ground
    truth here), so a nudge is only applied when: (a) the original beat's
    attack is genuinely weak relative to the track's own loud level, (b) the
    nearest pitch-tracked beat is within `max_nudge_ratio` of the local beat
    interval (a wild candidate is rejected, not applied), and (c) applying it
    doesn't reorder beats. Everything else in the grid is left untouched.

    Returns (beats, refined_count).
    """
    import numpy as np
    import librosa

    if len(beats) < 3:
        return beats, 0

    times = np.array([b["t"] for b in beats])
    intervals = np.diff(times)

    try:
        y, sr = librosa.load(input_path, sr=None, mono=True)
    except Exception as e:  # pragma: no cover
        sys.stderr.write(f"warning: weak-attack refinement unavailable ({e}); skipping\n")
        return beats, 0

    amp_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=512)
    amp_times = librosa.frames_to_time(np.arange(len(amp_env)), sr=sr, hop_length=512)
    at_beat = np.interp(times, amp_times, amp_env)
    ref_loud = np.percentile(amp_env, 90)
    weak = at_beat < ref_loud * weak_ratio
    if not weak.any():
        return beats, 0

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=512)
    flux = np.sqrt(np.sum(np.diff(chroma, axis=1) ** 2, axis=0))
    flux = np.concatenate([[0.0], flux])
    median_bpm = 60.0 / np.median(intervals) if np.median(intervals) > 0 else 120.0
    try:
        _, pitch_beats = librosa.beat.beat_track(
            onset_envelope=flux, sr=sr, hop_length=512, start_bpm=median_bpm, units="time"
        )
    except Exception as e:  # pragma: no cover
        sys.stderr.write(f"warning: pitch-track beat estimate failed ({e}); skipping refinement\n")
        return beats, 0
    pitch_beats = np.asarray(pitch_beats)
    if not len(pitch_beats):
        return beats, 0

    out = [dict(b) for b in beats]
    refined = 0
    n = len(beats)
    for i in np.nonzero(weak)[0]:
        local_interval = intervals[min(i, len(intervals) - 1)] if len(intervals) else 0.5
        j = int(np.argmin(np.abs(pitch_beats - times[i])))
        candidate = float(pitch_beats[j])
        delta = abs(candidate - times[i])
        if delta > max_nudge_ratio * local_interval:
            continue  # candidate too far from the original — not a plausible correction
        if delta < min_nudge_sec:
            continue  # too small to matter — leave it, don't add risk for no audible benefit
        prev_t = out[i - 1]["t"] if i > 0 else -np.inf
        next_t = out[i + 1]["t"] if i < n - 1 else np.inf
        margin = 0.05 * local_interval
        if not (prev_t + margin < candidate < next_t - margin):
            continue  # would reorder beats — reject, leave original
        out[i]["t"] = round(candidate, 4)
        refined += 1

    return out, refined


def splice_even_beats(beats, numerator, start_t, end_t, bar_count):
    """
    Replace whatever beats fall in [start_t, end_t) with `bar_count` bars of
    perfectly evenly-spaced beats between the two boundaries.

    For a short passage where both endpoints are already known precisely (a
    solo intro of known length before the full band enters, confirmed by ear
    and/or a clean acoustic marker like a bass/drum energy step) and BeatNet's
    own per-beat tracking through it is unreliable, this beats every
    heuristic tried: it's pure arithmetic between two independently-confirmed
    points, so there's no drift and no phase ambiguity to get wrong.

    This is intentionally NOT autodetection — `start_t`, `end_t`, and
    `bar_count` must be supplied (confirmed anchor, a measured or user-marked
    boundary, and a known bar count), so it only ever touches what it's
    explicitly told to. `pos` for the new beats cycles 1..numerator starting
    at start_t (beat 1). Beats before start_t and at/after end_t — including
    their own `pos` values — are untouched; a numbering seam right at the
    boundary is expected and harmless, since downstream accenting keys off
    index distance from the chosen anchor, not the raw `pos` field.
    """
    n_new = bar_count * numerator
    interval = (end_t - start_t) / n_new
    new_beats = [
        {"t": round(start_t + i * interval, 4), "pos": (i % numerator) + 1}
        for i in range(n_new)
    ]
    before = [b for b in beats if b["t"] < start_t]
    after = [b for b in beats if b["t"] >= end_t]
    return before + new_beats + after


def pick_anchor(input_path, beats, numerator, confirm_bars=2, clarity_threshold=1.6):
    """
    Best-guess timestamp (seconds, original file timeline) for where the "real"
    song actually starts, among the downbeats (pos==1) BeatNet found.

    BeatNet numbers bars cyclically with no notion of song structure, so its
    first pos==1 beat is often musically arbitrary: it can land inside a quiet
    pickup/lead-in (a real, on-grid beat — just not the one a musician would
    call "beat one"), or worse, inside non-rhythmic content (SFX, noise) where
    there's no real beat to find at all. Both cases share a signature: onset
    energy doesn't actually spike at the claimed beat times and stay quiet
    between them, the way it does once real, confidently-tracked instruments
    are playing. Score each downbeat candidate by that spike-vs-gap contrast
    over the following `confirm_bars` bars and take the first one that clears
    `clarity_threshold` (sustained, so a single loud pickup note can't win it).

    Falls back to the first downbeat if nothing clears the bar — best-effort,
    not authoritative. Caller should still allow a manual override.
    """
    import numpy as np
    import librosa

    if not beats:
        return None
    times = [b["t"] for b in beats]
    positions = [b["pos"] for b in beats]
    downbeat_idxs = [i for i, p in enumerate(positions) if p == 1]
    if not downbeat_idxs:
        return None
    fallback = times[downbeat_idxs[0]]

    try:
        y, sr = librosa.load(input_path, sr=None, mono=True)
        env = librosa.onset.onset_strength(y=y, sr=sr)
        hop = 512  # librosa's onset_strength default
        env_times = librosa.frames_to_time(np.arange(len(env)), sr=sr, hop_length=hop)
    except Exception as e:  # pragma: no cover - environment/decoding problem
        sys.stderr.write(f"warning: anchor scoring unavailable ({e}); using first downbeat\n")
        return fallback

    def env_at(t, half_window=0.05):
        lo = np.searchsorted(env_times, t - half_window)
        hi = np.searchsorted(env_times, t + half_window)
        seg = env[lo:hi]
        return float(seg.max()) if len(seg) else 0.0

    def env_between(t0, t1):
        lo = np.searchsorted(env_times, t0)
        hi = np.searchsorted(env_times, t1)
        seg = env[lo:hi]
        return float(np.median(seg)) if len(seg) else 0.0

    n = len(beats)
    span = numerator * confirm_bars
    for di in downbeat_idxs:
        if di + span >= n:
            continue  # not enough beats left after this candidate to confirm it
        on_beat, between = [], []
        for k in range(di, di + span):
            t = times[k]
            on_beat.append(env_at(t))
            if k + 1 < n:
                between.append(env_between(t + 0.05, times[k + 1] - 0.02))
        on_beat_med = float(np.median(on_beat)) if on_beat else 0.0
        between_med = float(np.median(between)) if between else 0.0
        clarity = on_beat_med / (between_med + 1e-6)
        if clarity >= clarity_threshold and on_beat_med > 1e-4:
            # Always return the DOWNBEAT itself.
            #
            # This used to run a "sibling phase" check that could shift the
            # anchor onto a neighbouring beat when that beat carried more onset
            # energy, on the theory that BeatNet's bar numbering might be
            # phase-shifted. Removed: measured against calibrated human tap
            # capture on a real track, BeatNet's pos==1 labels matched the
            # tapped downbeats to within 20-60ms, while the sibling check moved
            # the anchor one beat EARLY onto a pos==4 — which is what made the
            # count-off land the band on the wrong beat of the bar.
            #
            # The underlying reason is the same one that sinks onset-phase
            # scanning generally: highest onset energy is not the same thing as
            # the beat a musician counts. Measured on the same track, a grid
            # optimally phased to onset energy scored 2.5x higher on energy yet
            # sat FURTHER from the human taps (55.8ms vs 41.8ms). Don't
            # reintroduce energy-based phase correction without tap-verified
            # evidence that it beats BeatNet's own labels.
            return times[di]

    return fallback


def derive_numerator(positions):
    """
    positions: list of ints (1-indexed beat position in bar) as returned by
    BeatNet's DBN. The starting time-signature numerator is the number of beats
    in the first complete bar — i.e. the gap between the first two downbeats.
    Falls back to max position seen, then to 4.
    """
    downbeats = [i for i, p in enumerate(positions) if p == 1]
    if len(downbeats) >= 2:
        n = downbeats[1] - downbeats[0]
        if 2 <= n <= 12:
            return n
    seen_max = max((p for p in positions), default=0)
    if 2 <= seen_max <= 12:
        return seen_max
    return 4


def derive_tempo(times):
    """Median inter-beat interval -> BPM. Robust to a few missed/extra beats."""
    diffs = [b - a for a, b in zip(times, times[1:]) if b > a]
    if not diffs:
        return 0.0
    med = statistics.median(diffs)
    return round(60.0 / med, 2) if med > 0 else 0.0


# --- Tempo segmentation -----------------------------------------------------
#
# A song is not one tempo. A live recording drifts, and many songs have real
# mid-song tempo changes. A single global tempoBpm (above) describes neither,
# and a click grid built from one is fine at the point it was anchored and
# progressively wrong either side of it.
#
# These constants were tuned against a hand-verified reference track (a live
# recording with a confirmed 137.06 -> 138.68bpm change, both figures
# established independently by human tap capture) — not picked by eye.
SEG_WINDOW_BEATS = 40   # ~17s at 140bpm: long enough to average out quantization
SEG_STEP_BEATS = 4
# Merge neighbouring windows agreeing within this fraction. MUST be tighter than
# the smallest tempo change worth detecting: a real, ear-confirmed change on the
# reference track is only 1.18% (137.06 -> 138.68bpm), so the original 1.5% here
# silently merged it into one segment and lost it. It only ever appeared
# separated because unclean windows at the transition happened to act as a
# barrier — an accident, not the mechanism. Kept above typical within-section
# drift of a live band so a section does not fragment into pieces.
SEG_TEMPO_TOL = 0.006
SEG_MIN_BEATS = 24       # discard segments too short to be a real tempo section

# "Clean fit" threshold, as a FRACTION OF THE BEAT INTERVAL rather than an
# absolute time. What matters musically is how far a beat sits from the grid
# relative to the beat itself — 20ms is 2.6% of a beat at 79bpm but 5.7% at
# 170bpm, so a fixed millisecond threshold silently gets stricter the slower the
# song. Measured across an 11-track library sweep (79-170bpm): with an absolute
# 20ms threshold the two slowest tracks scored worst for confident coverage
# (77.9% and 36.9%) while the fastest scored best (96.8%) — the threshold, not
# the music. 4.5% reproduces the validated 20ms at ~137bpm (the tempo the
# detector was originally calibrated against) while scaling sanely either side.
SEG_CLEAN_RESID_RATIO = 0.045
SEG_CLEAN_RESID_FLOOR = 0.012  # s — never demand better than BeatNet's own 20ms frame allows


def fit_run(times):
    """
    Least-squares fit of beat time against beat index. Returns
    (interval_seconds, residual_seconds).

    Why regression rather than the mean or median of inter-beat intervals:
    BeatNet's DBN emits beat times quantized to its 20ms analysis frame, so any
    single interval is only good to +/-10ms and the achievable tempo values are
    spaced ~4-5% apart near 140bpm — far too coarse to see a real 1% change.
    The *mean* of consecutive intervals is no better despite averaging: it
    telescopes to (last - first) / (n - 1), discarding every interior beat and
    keeping two quantized endpoints (this was measured getting the sign of a
    real tempo change backwards). Regressing against index uses all n beats, so
    quantization noise averages down as ~n^-1.5 and the slope resolves tempo to
    well under 0.1% over a 40-beat window — measured recovering a tap-verified
    137.06bpm as 136.91.

    The residual matters as much as the slope. A genuinely contiguous run fits a
    straight line to ~10-15ms; a window containing a dropped beat, an extra beat
    or a jump to a different metrical level fits at 150-200ms+. So the residual
    detects "the grid is broken here" independently of tempo, which is the
    failure mode that silently produces a click track that drifts off the music.
    """
    n = len(times)
    if n < 3:
        return 0.0, float("inf")
    mean_i = (n - 1) / 2.0
    mean_t = sum(times) / n
    num = 0.0
    den = 0.0
    for i, t in enumerate(times):
        num += (i - mean_i) * (t - mean_t)
        den += (i - mean_i) ** 2
    if den <= 0:
        return 0.0, float("inf")
    slope = num / den
    ss = 0.0
    for i, t in enumerate(times):
        pred = mean_t + slope * (i - mean_i)
        ss += (t - pred) ** 2
    return slope, math.sqrt(ss / n)


def contiguous_runs(times):
    """
    Split beat times at real breaks (a stop, a silent passage) so a regression
    window never straddles one — index-vs-time is only linear within a run.
    A gap wider than 2x the median interval is a break, not a slow beat.
    """
    if len(times) < 2:
        return [list(times)]
    diffs = [b - a for a, b in zip(times, times[1:])]
    positive = [d for d in diffs if d > 0]
    med = statistics.median(positive) if positive else 0.5
    runs = []
    cur = [times[0]]
    for i, d in enumerate(diffs):
        if d > 2.0 * med:
            runs.append(cur)
            cur = [times[i + 1]]
        else:
            cur.append(times[i + 1])
    runs.append(cur)
    return [r for r in runs if len(r) >= 2]


def detect_tempo_segments(times):
    """
    Piecewise-constant tempo map: [{startT, endT, tempoBpm, beats, confident}].

    Slides a regression window along each contiguous run, keeps windows that fit
    cleanly (see fit_run), and merges neighbours whose tempo agrees within
    SEG_TEMPO_TOL. Stretches that never fit cleanly are still reported, flagged
    confident=False — those are exactly the regions where the beat grid is
    unreliable and a click built from it will wander off the music, so callers
    (and the user) are better off knowing than being handed a confident number.
    """
    segments = []
    for run in contiguous_runs(times):
        if len(run) < SEG_MIN_BEATS:
            continue

        # Windows overlap heavily (step 4, width 40), so a beat is covered by
        # many of them. Give each beat the estimate from its *best-fitting*
        # covering window: a window straddling a tempo change or a broken
        # stretch fits poorly, so the lowest-residual window covering a beat is
        # the one that sees it as part of a coherent run. Without this the
        # transitions smear into wild readings (150->130bpm) from windows with
        # one foot either side of a change.
        best = [None] * len(run)
        for s in range(0, len(run) - SEG_WINDOW_BEATS + 1, SEG_STEP_BEATS):
            slope, resid = fit_run(run[s:s + SEG_WINDOW_BEATS])
            if slope <= 0:
                continue
            for i in range(s, s + SEG_WINDOW_BEATS):
                if best[i] is None or resid < best[i]["resid"]:
                    best[i] = {"bpm": 60.0 / slope, "resid": resid, "interval": slope}

        if all(b is None for b in best):
            slope, _ = fit_run(run)
            if slope > 0:
                segments.append({
                    "startT": round(run[0], 4),
                    "endT": round(run[-1], 4),
                    "tempoBpm": round(60.0 / slope, 2),
                    "beats": len(run),
                    "confident": False,
                })
            continue

        # Group consecutive beats agreeing on tempo and cleanliness. This is a
        # partition of the run — segments never overlap.
        raw_segs = []
        cur = None
        for i, b in enumerate(best):
            if b is None:
                continue
            clean = b["resid"] < max(SEG_CLEAN_RESID_FLOOR, SEG_CLEAN_RESID_RATIO * b["interval"])
            if (
                cur is not None
                and cur["clean"] == clean
                and abs(b["bpm"] - cur["bpm"]) / cur["bpm"] < SEG_TEMPO_TOL
            ):
                cur["end"] = i
                cur["bpms"].append(b["bpm"])
                cur["bpm"] = statistics.median(cur["bpms"])
            else:
                if cur is not None:
                    raw_segs.append(cur)
                cur = {"start": i, "end": i, "bpm": b["bpm"], "bpms": [b["bpm"]], "clean": clean}
        if cur is not None:
            raw_segs.append(cur)

        # Fold segments too short to be a real tempo section into their
        # neighbour rather than reporting a two-beat "tempo change".
        folded = []
        for m in raw_segs:
            if (m["end"] - m["start"] + 1) < SEG_MIN_BEATS and folded:
                folded[-1]["end"] = m["end"]
                continue
            folded.append(m)

        for m in folded:
            segments.append({
                "startT": round(run[m["start"]], 4),
                "endT": round(run[m["end"]], 4),
                "tempoBpm": round(m["bpm"], 2),
                "beats": m["end"] - m["start"] + 1,
                "confident": bool(m["clean"]),
            })
    return segments


def dominant_tempo(segments):
    """
    The tempo the song mostly sits at, weighted by how many beats each segment
    covers. Used as the reference for octave (half/double-time) correction —
    a plain median is unusable on a song with two long sections at genuinely
    different tempos, since it lands between them and matches neither.
    """
    if not segments:
        return 0.0
    best = max(segments, key=lambda s: s.get("beats", 0))
    return float(best.get("tempoBpm") or 0.0)


def fix_metrical_level(beats, segments, tol=0.12):
    """
    Correct stretches tracked at half or double the song's pulse.

    Beat trackers slip an octave on material that gives weak evidence for the
    main pulse — a sparse acapella section reads as half-time, a busy section as
    double-time. The beat times are not wrong, there are simply too few or too
    many of them, and the click audibly changes note value mid-song (the single
    most-reported problem in listening tests).

    For a half-time stretch a beat is interpolated midway between each pair; for
    a double-time stretch every other beat is dropped. Only ratios within `tol`
    of exactly 0.5 or 2.0 are touched, so genuine tempo changes (which are a few
    percent, not 2x) are never altered. Bar positions are renumbered afterwards
    by the caller.

    Returns (beats, n_segments_corrected).
    """
    if not beats or not segments:
        return beats, 0
    ref = dominant_tempo(segments)
    if ref <= 0:
        return beats, 0

    times = [b["t"] for b in beats]
    edits = []  # (lo, hi, factor)
    for s in segments:
        bpm = float(s.get("tempoBpm") or 0.0)
        if bpm <= 0:
            continue
        ratio = bpm / ref
        if abs(ratio - 0.5) <= tol * 0.5:
            edits.append((s["startT"], s["endT"], 2))    # half-time -> subdivide
        elif abs(ratio - 2.0) <= tol * 2.0:
            edits.append((s["startT"], s["endT"], 0.5))  # double-time -> thin out
    if not edits:
        return beats, 0

    out = []
    i = 0
    n = len(times)
    corrected = 0
    while i < n:
        t = times[i]
        edit = next((e for e in edits if e[0] - 1e-6 <= t <= e[1] + 1e-6), None)
        if edit is None:
            out.append(times[i])
            i += 1
            continue
        lo, hi, factor = edit
        seg_idx = [k for k in range(i, n) if times[k] <= hi + 1e-6]
        if not seg_idx:
            out.append(times[i])
            i += 1
            continue
        last = seg_idx[-1]
        run = times[i:last + 1]
        if factor == 2:
            for k in range(len(run) - 1):
                out.append(run[k])
                out.append((run[k] + run[k + 1]) / 2.0)
            out.append(run[-1])
        else:
            out.extend(run[::2])
        corrected += 1
        i = last + 1

    out = sorted(set(round(x, 6) for x in out))
    return [{"t": t, "pos": 0} for t in out], corrected


def renumber_positions(beats, numerator, downbeat_t=None):
    """
    Re-apply cycling bar positions after the beat list has been edited.

    Anchored to a known downbeat time rather than to index 0 — inserting or
    removing beats shifts every later index, and numbering blindly from the
    start would assume the first beat is a downbeat and silently rotate the
    whole song's bar phase.
    """
    if not beats:
        return beats
    anchor_idx = 0
    if downbeat_t is not None:
        anchor_idx = min(range(len(beats)), key=lambda i: abs(beats[i]["t"] - downbeat_t))
    for i, b in enumerate(beats):
        b["pos"] = ((i - anchor_idx) % numerator + numerator) % numerator + 1
    return beats


def bridge_unreliable_stretches(beats, segments, agree_tol=0.05):
    """
    Re-lay the beat grid across a low-confidence stretch that sits between two
    confident stretches of near-identical tempo.

    Where a tracker loses the pulse — a sparse acapella passage, a breakdown, a
    quiet build — it does not stop emitting beats, it emits confidently wrong
    ones, and a click built from them wanders off the music. But when such a
    stretch is bracketed by two confident segments that agree on tempo, the
    tempo across the gap is tightly constrained: the band did not change tempo,
    the tracker simply lost sight of it. In that case a straight grid spanning
    the gap is far more likely right than what was tracked.

    The bridge is anchored to the real beats either side and spans a whole
    number of beats, so it joins continuously at both ends and cannot introduce
    a phase step. If the neighbours disagree on tempo (a real change may have
    happened inside the gap) nothing is touched — guessing there is exactly the
    confident-but-wrong behaviour this is meant to remove.

    Returns (beats, n_bridged).
    """
    if not beats or not segments or len(segments) < 3:
        return beats, 0

    times = [b["t"] for b in beats]
    spans = []
    for i in range(1, len(segments) - 1):
        seg = segments[i]
        prev_seg, next_seg = segments[i - 1], segments[i + 1]
        if seg.get("confident"):
            continue
        if not (prev_seg.get("confident") and next_seg.get("confident")):
            continue
        a, b = float(prev_seg.get("tempoBpm") or 0), float(next_seg.get("tempoBpm") or 0)
        if a <= 0 or b <= 0:
            continue
        if abs(a - b) / a > agree_tol:
            continue  # a real tempo change may sit inside — leave it alone
        spans.append((seg["startT"], seg["endT"], (a + b) / 2.0))

    if not spans:
        return beats, 0

    out = []
    i = 0
    n = len(times)
    bridged = 0
    while i < n:
        span = next((s for s in spans if s[0] - 1e-6 <= times[i] <= s[1] + 1e-6), None)
        if span is None:
            out.append(times[i])
            i += 1
            continue
        lo, hi, bpm = span
        last = i
        while last + 1 < n and times[last + 1] <= hi + 1e-6:
            last += 1
        # Anchor to the surrounding real beats so the bridge joins cleanly.
        start_t = out[-1] if out else times[i]
        end_t = times[last + 1] if last + 1 < n else times[last]
        gap = end_t - start_t
        interval = 60.0 / bpm
        count = max(1, int(round(gap / interval)))
        step = gap / count
        for k in range(1, count):
            out.append(start_t + k * step)
        bridged += 1
        i = last + 1

    out = sorted(set(round(x, 6) for x in out))
    return [{"t": t, "pos": 0} for t in out], bridged


def run_beat_this(path, use_dbn=True):
    """
    Analyze with Beat This! (CPJKU transformer) and return rows of
    [time_seconds, position_in_bar] — the same shape BeatNet's DBN returns, so
    the rest of the pipeline is unchanged.

    Why this is the default engine rather than BeatNet, measured on five real
    tracks plus calibrated human tap capture:

      * Tempo drift. On a track not recorded to a click, BeatNet holds a flat
        tempo through a real 92.8 -> 85.7bpm slowdown and lands 225.5ms from the
        tapped beats; Beat This tracks the slowdown and lands 25.6ms away, which
        is inside the human tap jitter of the reference itself.
      * Metrical level stability. Raw Beat This (dbn=False) has accurate
        placement but flips between quarter/eighth/triplet readings mid-song —
        by far the most audible complaint in listening tests. Running its
        activations through madmom's DBN keeps the placement and removes most of
        the flipping (level-jumps measured per track: 275 -> 4, 13 -> 1).

    BeatNet is still better on quiet legato intros (41.8ms vs 118.4ms against
    the same taps), so it is kept selectable via --engine and as the fallback if
    Beat This is unavailable.
    """
    import numpy as np
    from beat_this.inference import File2Beats

    # Frozen builds must work offline: PyInstaller bundles the checkpoint (see
    # beat_detect.spec) because Beat This would otherwise fetch it from the
    # network on first use and cache it in the user's home directory.
    checkpoint = "final0"
    bundle_dir = getattr(sys, "_MEIPASS", None)
    if bundle_dir:
        bundled = os.path.join(bundle_dir, "beat_this_checkpoints", "beat_this-final0.ckpt")
        if os.path.exists(bundled):
            checkpoint = bundled
        else:  # pragma: no cover - packaging error, surface it rather than silently downloading
            sys.stderr.write(
                f"warning: bundled Beat This checkpoint missing at {bundled}; "
                "falling back to the network/cache copy\n"
            )

    beats, downbeats = File2Beats(checkpoint_path=checkpoint, device="cpu", dbn=use_dbn)(path)
    beats = np.asarray(beats, dtype=float)
    downbeats = np.asarray(downbeats, dtype=float)
    if len(beats) == 0:
        return []

    # Label bar positions from the model's own downbeats: pos resets to 1 at
    # each downbeat and counts up in between. Beats before the first downbeat
    # are numbered backwards from it so a pickup keeps a sensible position
    # instead of all collapsing to 1.
    if len(downbeats):
        db_idx = []
        for d in downbeats:
            db_idx.append(int(np.argmin(np.abs(beats - d))))
        db_idx = sorted(set(db_idx))
    else:
        db_idx = [0]

    # Bar length in beats, from the most common downbeat spacing — used only to
    # number beats that sit before the first downbeat.
    if len(db_idx) > 1:
        spacings = [b - a for a, b in zip(db_idx, db_idx[1:]) if b > a]
        bar_len = int(statistics.median(spacings)) if spacings else 4
    else:
        bar_len = 4
    bar_len = max(2, min(12, bar_len))

    positions = [0] * len(beats)
    next_db = 0
    pos = None
    for i in range(len(beats)):
        if next_db < len(db_idx) and i == db_idx[next_db]:
            pos = 1
            next_db += 1
        elif pos is None:
            # before the first downbeat: count backwards from it
            offset = db_idx[0] - i
            pos = ((-offset) % bar_len) + 1
            positions[i] = pos
            pos = None
            continue
        else:
            pos = pos + 1 if pos < bar_len else 1
        positions[i] = pos

    return [[float(t), int(p)] for t, p in zip(beats, positions)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="audio file to analyze")
    ap.add_argument("--output", required=True, help="JSON descriptor path to write")
    ap.add_argument("--model", type=int, default=1, help="BeatNet pretrained model 1-3")
    ap.add_argument(
        "--max-num",
        type=int,
        default=7,
        help="widest bar length the meter tracker may consider (>=4 recommended)",
    )
    ap.add_argument(
        "--transition-lambda",
        type=int,
        default=100,
        help=(
            "madmom DBN tempo-change resistance (default 100, matches madmom's own "
            "default). Tested raising this to bias toward the quarter-note grid over "
            "syncopated accents — it either did nothing (150) or collapsed the meter "
            "to half-tempo (300) on real syncopated material. Not a useful lever; "
            "left as an escape hatch, not changed from upstream default."
        ),
    )
    ap.add_argument(
        "--no-tempo-refine",
        action="store_true",
        help="Skip the second (tempo-range-constrained) analysis pass — see run_dbn below.",
    )
    ap.add_argument(
        "--no-bridge",
        action="store_true",
        help=(
            "Skip re-laying the grid across low-confidence stretches bracketed "
            "by agreeing confident ones — see bridge_unreliable_stretches()."
        ),
    )
    ap.add_argument(
        "--no-level-fix",
        action="store_true",
        help=(
            "Skip half/double-time correction. By default stretches tracked an "
            "octave off the song's dominant pulse are repaired — see "
            "fix_metrical_level()."
        ),
    )
    ap.add_argument(
        "--engine",
        choices=["beat_this", "beatnet"],
        default="beat_this",
        help=(
            "Beat tracker to use. 'beat_this' (default) is markedly better at "
            "following real tempo drift; 'beatnet' is better only on quiet "
            "legato intros. See run_beat_this() for the measurements."
        ),
    )
    args = ap.parse_args()

    log(stage="loading")

    try:
        import numpy as np  # noqa: F401
    except Exception as e:  # pragma: no cover - environment problem
        sys.stderr.write(f"failed to import numpy: {e}\n")
        sys.exit(2)

    engine = args.engine
    if engine == "beat_this":
        try:
            import beat_this  # noqa: F401
        except Exception as e:
            sys.stderr.write(
                f"warning: beat_this unavailable ({e}); falling back to BeatNet\n"
            )
            engine = "beatnet"

    estimator = None
    run_dbn = None
    if engine == "beatnet":
        # Imported here so --help stays fast and import errors surface clearly.
        try:
            from BeatNet.BeatNet import BeatNet
            from madmom.features.downbeats import DBNDownBeatTrackingProcessor
        except Exception as e:  # pragma: no cover - environment problem
            sys.stderr.write(f"failed to import BeatNet: {e}\n")
            sys.exit(2)

        estimator = BeatNet(
            args.model,
            mode="offline",
            inference_model="DBN",
            plot=[],
            thread=False,
            device="cpu",
        )
        # Widen the meter search beyond BeatNet's default [2, 3, 4] so 5/4, 6/8,
        # 7/8 songs are not force-fit to 4.
        bpb = list(range(2, max(4, args.max_num) + 1))

        def run_dbn(path, min_bpm=55.0, max_bpm=215.0):
            estimator.estimator = DBNDownBeatTrackingProcessor(
                beats_per_bar=bpb, fps=50, transition_lambda=args.transition_lambda,
                min_bpm=min_bpm, max_bpm=max_bpm,
            )
            return estimator.process(path)

    # BeatNet will happily track a steady-looking beat grid over dead air (seen
    # on a real recording with an editing-artifact silence pad before the first
    # note) — trim any leading silence/near-silence before handing it audio.
    try:
        lead_trim = find_lead_silence(args.input)
    except Exception as e:  # pragma: no cover - fall back to untrimmed on any read error
        sys.stderr.write(f"warning: lead-silence detection failed ({e}); skipping trim\n")
        lead_trim = 0.0

    analyze_path = args.input
    trimmed_tmp = None
    if lead_trim > 0.05:
        try:
            trimmed_tmp = trim_lead_silence(args.input, lead_trim)
            analyze_path = trimmed_tmp
        except Exception as e:  # pragma: no cover
            sys.stderr.write(f"warning: lead-silence trim failed ({e}); using untrimmed audio\n")
            lead_trim = 0.0

    log(stage="analyzing")
    t0 = time.time()
    try:
        if engine == "beat_this":
            out = run_beat_this(analyze_path, use_dbn=True)
        else:
            out = run_dbn(analyze_path)
    except Exception as e:
        sys.stderr.write(f"analysis failed: {e}\n")
        sys.exit(3)

    # Second pass, tempo-range-constrained: madmom's DBN considers tempo
    # hypotheses across its full default range (55-215 BPM), which is wide
    # enough that a strongly syncopated passage can pull it onto a nearby but
    # wrong metrical level (confirmed on a real track: a passage that's
    # supposed to read as steady quarter notes got tracked as if the
    # syncopated accents WERE the beat, drifting to a measurably wrong local
    # tempo). Re-running with the search narrowed to roughly ±12% around the
    # song's own robust global tempo forces every passage to resolve onto the
    # tempo the rest of the song is actually in, which fixed that case
    # (max deviation from a hand-verified reference beat grid: 225ms -> 47ms).
    # Guarded because pass 1 could itself have locked onto a globally wrong
    # tempo (e.g. half/double-time) — narrowing around a wrong estimate would
    # only make it worse, so pass 2 is discarded if its beat count differs
    # wildly from pass 1's (a sign something broke, not improved).
    # The window is derived from the tempo range the song ACTUALLY plays, not
    # from ±12% around a single median. A median describes a song with one
    # tempo; for anything not recorded to a click it is a fiction, and clamping
    # to it forbids the tracker from following the performance. Measured on a
    # live, no-click recording: the global median put the floor at 77.6bpm while
    # the song's closing ritard genuinely descends to ~67bpm — 14% below the
    # floor, so it was mathematically impossible to detect, and the tracker sat
    # pinned at 78bpm reporting a steady tempo that was not being played.
    # Removing the clamp entirely recovered the ritard AND improved the fit
    # residual (25ms -> 16ms), i.e. a better fit to the audio, not just a
    # different answer.
    #
    # For a song that really does hold one tempo, min == max == median and this
    # reduces to the original ±15% window, preserving the metrical-level
    # protection the clamp was added for (those errors are ~2x, nowhere near
    # 15%, so the slightly wider window costs nothing).
    # Only applies to the BeatNet/DBN path: Beat This does its own postprocessing
    # and tracks tempo changes directly, so a second constrained pass would only
    # re-impose the flat-tempo assumption this engine was chosen to avoid.
    if not args.no_tempo_refine and run_dbn is not None:
        try:
            times_pass1 = [float(row[0]) for row in out]
            tempo1 = derive_tempo(times_pass1)
            if tempo1 > 0:
                observed = [
                    s["tempoBpm"] for s in detect_tempo_segments(times_pass1)
                    if s.get("tempoBpm", 0) > 0
                ]
                lo_seed = min(observed) if observed else tempo1
                hi_seed = max(observed) if observed else tempo1
                # Never narrower than the original window around the median.
                min_bpm = min(lo_seed * 0.85, tempo1 * 0.85)
                max_bpm = max(hi_seed * 1.15, tempo1 * 1.15)
                out2 = run_dbn(analyze_path, min_bpm=min_bpm, max_bpm=max_bpm)
                if 0.8 * len(out) <= len(out2) <= 1.2 * len(out):
                    out = out2
                else:
                    sys.stderr.write(
                        f"warning: tempo-refine pass produced {len(out2)} beats vs "
                        f"{len(out)} in pass 1 — discarding, keeping pass 1\n"
                    )
        except Exception as e:  # pragma: no cover
            sys.stderr.write(f"warning: tempo-refine pass failed ({e}); keeping pass 1\n")

    if trimmed_tmp:
        try:
            os.remove(trimmed_tmp)
        except OSError:
            pass

    # out: ndarray (N, 2) -> [time_seconds, position_in_bar]. Times are relative
    # to the (possibly trimmed) analyzed audio — shift back to the original
    # file's timeline so downstream consumers (Rust/JS) never see the trim.
    beats = []
    positions = []
    times = []
    for row in out:
        t = float(row[0]) + lead_trim
        pos = int(round(float(row[1])))
        beats.append({"t": round(t, 4), "pos": pos})
        positions.append(pos)
        times.append(t)

    if len(beats) < 2:
        sys.stderr.write("analysis produced too few beats\n")
        sys.exit(4)

    # Nudge beats that land on a weak/absent transient (slides, bends, legato
    # note changes) toward an independent pitch-change-tracked estimate —
    # amplitude-based tracking has little to grab onto there. Small, targeted;
    # most beats are untouched.
    try:
        beats, weak_attack_refined = refine_weak_attack_beats(args.input, beats)
        times = [b["t"] for b in beats]
    except Exception as e:  # pragma: no cover
        sys.stderr.write(f"warning: weak-attack refinement failed ({e}); using raw beat times\n")
        weak_attack_refined = 0

    numerator = derive_numerator(positions)
    tempo_bpm = derive_tempo(times)

    # Piecewise tempo map. `tempoBpm` above is one number for the whole song,
    # which is wrong for anything that drifts or genuinely changes tempo; this
    # reports each stretch separately and flags the ones whose beat grid does
    # not fit cleanly enough to trust.
    try:
        tempo_segments = detect_tempo_segments(times)
    except Exception as e:  # pragma: no cover - never fail the whole analysis for this
        sys.stderr.write(f"warning: tempo segmentation failed ({e}); omitting tempoSegments\n")
        tempo_segments = []

    # Repair stretches tracked an octave off the song's own pulse (a sparse
    # acapella reading as half-time, a busy passage as double-time). Left alone
    # these make the click change note value mid-song, and they also look like
    # huge "tempo changes" to everything downstream — including the mid-song
    # count-off, which would fire on a level error rather than a real change.
    level_corrected = 0
    if not args.no_level_fix:
        try:
            first_downbeat_t = next((b["t"] for b in beats if b["pos"] == 1), None)
            fixed, level_corrected = fix_metrical_level(beats, tempo_segments)
            if level_corrected:
                beats = renumber_positions(fixed, numerator, first_downbeat_t)
                times = [b["t"] for b in beats]
                tempo_bpm = derive_tempo(times)
                tempo_segments = detect_tempo_segments(times)
                sys.stderr.write(
                    f"note: corrected {level_corrected} half/double-time stretch(es)\n"
                )
        except Exception as e:  # pragma: no cover
            sys.stderr.write(f"warning: metrical-level fix failed ({e}); leaving beats as tracked\n")
            level_corrected = 0

    # Re-lay the grid across stretches the tracker was not confident about, but
    # only where the confident stretches either side agree on tempo and so pin
    # it down. Runs after the octave fix so it sees corrected tempos.
    bridged = 0
    if not args.no_bridge:
        try:
            first_downbeat_t = next((b["t"] for b in beats if b["pos"] == 1), None)
            fixed, bridged = bridge_unreliable_stretches(beats, tempo_segments)
            if bridged:
                beats = renumber_positions(fixed, numerator, first_downbeat_t)
                times = [b["t"] for b in beats]
                tempo_bpm = derive_tempo(times)
                tempo_segments = detect_tempo_segments(times)
                sys.stderr.write(f"note: bridged {bridged} unreliable stretch(es)\n")
        except Exception as e:  # pragma: no cover
            sys.stderr.write(f"warning: bridging failed ({e}); leaving beats as tracked\n")
            bridged = 0

    try:
        anchor_t = pick_anchor(args.input, beats, numerator)
    except Exception as e:  # pragma: no cover
        sys.stderr.write(f"warning: anchor scoring failed ({e}); omitting anchorT\n")
        anchor_t = None

    descriptor = {
        "version": 1,
        "engine": "beat-this-dbn" if engine == "beat_this" else "beatnet-dbn",
        "beats": beats,
        "numerator": numerator,
        "tempoBpm": tempo_bpm,
        "generatedAt": int(time.time() * 1000),
        "analysisSeconds": round(time.time() - t0, 1),
        "leadInTrimSec": lead_trim,
        "anchorT": anchor_t,
        "weakAttackRefined": weak_attack_refined,
        "tempoSegments": tempo_segments,
        "levelCorrected": level_corrected,
        "bridgedStretches": bridged,
    }

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(descriptor, f)

    log(stage="done", beats=len(beats), numerator=numerator, tempoBpm=tempo_bpm)


if __name__ == "__main__":
    main()
