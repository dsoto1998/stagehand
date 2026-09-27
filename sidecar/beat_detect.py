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


# --- Shared audio / onset helpers -----------------------------------------
#
# pick_anchor, refine_weak_attack_beats and the confidence scorer all need the
# same mono signal and the same amplitude onset-strength curve. Without these
# they decode args.input three times; memoized per run they decode it once.
# The caches are never cleared — the sidecar is one-shot per file.
_MONO_CACHE = {}
_ONSET_CACHE = {}


def load_mono(path):
    """(y, sr) for `path`, native sample rate, mono. Memoized per run."""
    hit = _MONO_CACHE.get(path)
    if hit is not None:
        return hit
    import librosa
    y, sr = librosa.load(path, sr=None, mono=True)
    _MONO_CACHE[path] = (y, sr)
    return y, sr


def onset_env(path, hop=512):
    """(env, env_times): amplitude onset-strength curve + per-frame times. Memoized."""
    key = (path, hop)
    hit = _ONSET_CACHE.get(key)
    if hit is not None:
        return hit
    import numpy as np
    import librosa
    y, sr = load_mono(path)
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    env_times = librosa.frames_to_time(np.arange(len(env)), sr=sr, hop_length=hop)
    _ONSET_CACHE[key] = (env, env_times)
    return env, env_times


def env_peak(env, env_times, t, half_window=0.05):
    """Peak onset energy within ±half_window seconds of t (0.0 if no frames)."""
    import numpy as np
    lo = np.searchsorted(env_times, t - half_window)
    hi = np.searchsorted(env_times, t + half_window)
    seg = env[lo:hi]
    return float(seg.max()) if len(seg) else 0.0


def env_gap(env, env_times, t0, t1):
    """Median onset energy in [t0, t1] (0.0 if empty)."""
    import numpy as np
    lo = np.searchsorted(env_times, t0)
    hi = np.searchsorted(env_times, t1)
    seg = env[lo:hi]
    return float(np.median(seg)) if len(seg) else 0.0


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
        y, sr = load_mono(input_path)
        amp_env, amp_times = onset_env(input_path)
    except Exception as e:  # pragma: no cover
        sys.stderr.write(f"warning: weak-attack refinement unavailable ({e}); skipping\n")
        return beats, 0

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

    if not beats:
        return None
    times = [b["t"] for b in beats]
    positions = [b["pos"] for b in beats]
    downbeat_idxs = [i for i, p in enumerate(positions) if p == 1]
    if not downbeat_idxs:
        return None
    fallback = times[downbeat_idxs[0]]

    try:
        env, env_times = onset_env(input_path)
    except Exception as e:  # pragma: no cover - environment/decoding problem
        sys.stderr.write(f"warning: anchor scoring unavailable ({e}); using first downbeat\n")
        return fallback

    n = len(beats)
    span = numerator * confirm_bars
    for di in downbeat_idxs:
        if di + span >= n:
            continue  # not enough beats left after this candidate to confirm it
        on_beat, between = [], []
        for k in range(di, di + span):
            t = times[k]
            on_beat.append(env_peak(env, env_times, t))
            if k + 1 < n:
                between.append(env_gap(env, env_times, t + 0.05, times[k + 1] - 0.02))
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


# --- Beat confidence (Phase 1: measure only) ------------------------------
#
# detect_tempo_segments' `confident` flag is derived purely from how cleanly the
# beat INTERVALS fit a straight line, so a tracker that confidently slips to
# half-time (even intervals at the wrong level) reads as confident. These
# constants drive a score built from evidence OUTSIDE the timing list — onset
# energy at vs between each beat, and an architecturally independent second
# tracker (madmom RNN). Phase 1 only marks the low-confidence spans for the
# Perform UI; it does not change any beat time.
#
# Every value here is a first guess anchored to pick_anchor's validated
# clarity_threshold (1.6) and an 8th-note tolerance. Tune on real tracks before
# relying on the spans (see the plan's verification step 4).
CONF_ONSET_LO = 1.05   # onset clarity ratio at/below this -> onset sub-score 0
CONF_ONSET_HI = 2.2    #   "        "     "  at/above this -> onset sub-score 1
CONF_MADMOM_TOL_RATIO = 0.30   # |Δt| to nearest 2nd-tracker beat as a fraction of the
                               # local interval that still scores 1 (~an 8th note)
CONF_W_ONSET = 0.40    # does the audio have a beat where the click is (onset contrast)
CONF_W_GRID = 0.35     # is the local index↔time grid coherent (no dropped/extra beat)
CONF_W_MADMOM = 0.15   # phase corroboration, only where the 2nd tracker agrees on tempo
CONF_W_FRAME = 0.10    # Beat This! frame activation — Phase 3, not wired yet
LOW_CONF_THRESH = 0.45   # a smoothed per-beat conf below this is "low confidence"
SEG_CONF_THRESH = 0.55   # Phase 2 will gate the repairs on segment conf >= this
CONF_SMOOTH_BEATS = None  # moving-median half-width; None -> numerator (1 bar each side)


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


# --- Beat confidence scoring ----------------------------------------------


def _local_intervals(times):
    """Per-beat local interval: median of the <=2 adjacent inter-beat gaps."""
    import numpy as np
    n = len(times)
    if n < 2:
        return np.full(max(n, 1), 0.5)
    diffs = np.diff(times)
    med_all = float(np.median(diffs))
    out = np.empty(n)
    for i in range(n):
        near = []
        if 0 <= i - 1 < len(diffs):
            near.append(diffs[i - 1])
        if i < len(diffs):
            near.append(diffs[i])
        out[i] = float(np.median(near)) if near else med_all
    return out


def beat_onset_clarity(env, env_times, times, numerator):
    """
    Per-beat onset clarity: peak onset energy at the beat over the median onset
    energy in the surrounding gaps — the same spike-vs-gap contrast pick_anchor
    scores once for the anchor region, here computed for every beat over a
    ±numerator-beat window. Returns an np.ndarray (len == len(times)); entries
    with no usable window are NaN.
    """
    import numpy as np
    n = len(times)
    out = np.full(n, np.nan)
    if n < 3:
        return out
    gap_energy = np.array([
        env_gap(env, env_times, times[i] + 0.05, times[i + 1] - 0.02)
        for i in range(n - 1)
    ])
    for i in range(n):
        lo = max(0, i - numerator)
        hi = min(n - 1, i + numerator)
        local = gap_energy[lo:hi]
        if not len(local):
            continue
        floor = float(np.median(local))
        out[i] = env_peak(env, env_times, times[i]) / (floor + 1e-6)
    return out


def snap_grid_outliers(beats, numerator, dev_lo=0.15, dev_hi=0.40, fit_resid_ratio=0.10):
    """
    Correct an isolated timing slip — a beat (or two) nudged off-grid by a
    syncopated fill or accent that Beat This! briefly mistook for the pulse,
    with the grid resuming right after — back onto the tempo its neighbours
    already agree on.

    For each beat, fit a line to the surrounding beats with that beat EXCLUDED,
    and compare where it actually landed to where the line predicts. Correct it
    only when ALL of:
      - the neighbours fit a tight line (fit_resid_ratio of the interval) — i.e.
        there IS a steady grid here to snap back onto, not a genuine tempo
        change straddling the window (which fits poorly);
      - the deviation is in the "real slip, not jitter" band: bigger than
        dev_lo (ordinary tracking wobble, leave it) and smaller than dev_hi
        (that large is more likely a deliberate bar/meter event, not a slip);
      - snapping it does not reorder beats.

    This is deliberately narrow: a genuine tempo or meter change persists (every
    beat after it keeps the new spacing, so a line fit around it never lands
    tight) while a slip is a bad measurement or two bracketed by beats that
    still agree with each other — that difference is what tells them apart, not
    a bar/time heuristic. The excluded neighbourhood around `i` is 2 beats wide
    on each side, not just `i` itself: a slip commonly spans 2 consecutive
    beats (one long fill note misread as the pulse), and excluding only the
    single beat under test would leave its neighbour still inside the fit,
    pulling the reference line toward the slip and hiding it.

    Returns (beats, n_corrected).
    """
    import numpy as np
    n = len(beats)
    excl_radius = 2
    w = max(4 * numerator, 16)
    max_run = 2  # a fix touching more than this many CONSECUTIVE beats is not an
                 # isolated slip anymore — see the guard below.
    if n < 2 * w:
        return beats, 0
    times = np.array([b["t"] for b in beats], dtype=float)
    out = times.copy()
    touched = [False] * n
    for i in range(n):
        lo, hi = max(0, i - w), min(n, i + w + 1)
        excl = range(i - excl_radius, i + excl_radius + 1)
        idxs = np.array([k for k in range(lo, hi) if k not in excl], dtype=float)
        if len(idxs) < 10:
            continue
        ys = times[idxs.astype(int)]
        slope, intercept = np.polyfit(idxs, ys, 1)
        if slope <= 0:
            continue
        resid = math.sqrt(float(np.mean((ys - (intercept + slope * idxs)) ** 2)))
        if resid > fit_resid_ratio * slope:
            continue  # no steady grid here to snap onto (likely a real change)
        pred = intercept + slope * i
        adev = abs(times[i] - pred)
        if adev < dev_lo * slope or adev > dev_hi * slope:
            continue
        prev_t = out[i - 1] if i > 0 else -np.inf
        next_t = out[i + 1] if i + 1 < n else np.inf
        margin = 0.08 * slope
        if not (prev_t + margin < pred < next_t - margin):
            continue  # would reorder beats — reject
        out[i] = pred
        touched[i] = True

    # A cluster of more than `max_run` consecutive corrections is not an
    # isolated slip that snaps back — it is the signature of a genuine, if
    # small, phase drift (measured on a real track: the "excluded" fit line
    # ends up blended between the pre- and post-drift phase, so it nudges a
    # wide neighbourhood toward a compromise line instead of cleanly leaving a
    # 1-2 beat mistake corrected). Revert those — don't guess at a real
    # performance nuance.
    i = 0
    while i < n:
        if not touched[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and touched[j + 1]:
            j += 1
        if j - i + 1 > max_run:
            for k in range(i, j + 1):
                out[k] = times[k]
                touched[k] = False
        i = j + 1

    corrected = sum(touched)
    if not corrected:
        return beats, 0
    new_beats = [dict(b) for b in beats]
    for i in range(n):
        new_beats[i]["t"] = round(float(out[i]), 4)
    return new_beats, corrected


EXCURSION_RATIOS = (1 / 2, 2 / 3, 3 / 4, 4 / 5, 5 / 4, 4 / 3, 3 / 2, 2)


def _fit_line(idx, ts):
    import numpy as np
    slope, intercept = np.polyfit(idx, ts, 1)
    resid = float(np.sqrt(np.mean((ts - (intercept + slope * idx)) ** 2)))
    return float(slope), float(intercept), resid


def bridge_tempo_excursions(beats, dev=0.10, side=16, agree=0.02, phase_tol=0.12,
                            ref_half=32, max_len=48, ratio_tol=0.05, steady=0.06):
    """
    Re-lay the grid across a short stretch where the tracker briefly locked onto
    a riff's accent pattern instead of the pulse, then came back.

    Measured on a real 5/4 live track: for ~9s the tracker switched from the
    353ms quarter-note pulse to 440ms spacing — exactly 5/4 of it, i.e. a riff
    accenting every 5 sixteenths — placing 21 clicks where the band played 26
    beats, then returned to the original grid in phase. Onset contrast cannot
    catch this (the riff's accents really ARE at those times, so the wrong grid
    looks perfectly coherent), and the stretch is shorter than a tempo segment,
    so neither the confidence layer nor fix_metrical_level sees it.

    What distinguishes it from a real tempo change is that the pulse comes back
    unchanged. A stretch is re-laid only when ALL of:
      - its intervals sit > `dev` off the surrounding tempo (a moving median
        over ±`ref_half` beats), for at most `max_len` beats;
      - `side` beats either side are steady (line-fit residual < `steady` of an
        interval) and agree on tempo within `agree`;
      - the gap between the last on-grid beat before and the first after spans
        a whole number of beats to within `phase_tol` of a beat — the pulse
        resumed in phase, so there was no real tempo or bar change inside;
      - the tracked-to-true beat count ratio is a simple rhythmic ratio
        (4:5, 2:3, 1:2, ...) within `ratio_tol` — the signature of following a
        polyrhythmic figure or a half/double-time slip, not random noise.
    Stretches with the same beat count are left to the other correctors.

    Returns (beats, n_bridged). Positions are left for the caller to renumber.
    """
    import numpy as np
    t = np.array([b["t"] for b in beats], dtype=float)
    n_iv = len(t) - 1
    if n_iv < 2 * side + 3:
        return beats, 0
    iv = np.diff(t)
    ref = np.array([np.median(iv[max(0, i - ref_half):i + ref_half + 1]) for i in range(n_iv)])
    bad = np.abs(iv / ref - 1.0) > dev

    spans = []  # (a0, b0, count) beat-index endpoints kept, count new intervals
    i = 0
    while i < n_iv:
        if not bad[i]:
            i += 1
            continue
        # Grow the run, bridging gaps of up to 3 in-tolerance intervals (a
        # wrong grid can momentarily look right as it drifts through phase).
        j = i
        while True:
            k = j + 1
            while k < n_iv and not bad[k] and k - j <= 3:
                k += 1
            if k < n_iv and bad[k] and k - j <= 3:
                j = k
            else:
                break
        a, b = i, j + 1
        i = j + 1
        if b - a < 3 or b - a > max_len or a - side < 0 or b + 1 + side > len(t):
            continue
        li = np.arange(a - side, a)
        ri = np.arange(b + 1, b + 1 + side)
        ls, lb, lr = _fit_line(li, t[li])
        rs, rb, rr = _fit_line(ri, t[ri])
        if ls <= 0 or rs <= 0 or lr > steady * ls or rr > steady * rs:
            continue
        if abs(ls - rs) / ls > agree:
            continue
        # Widen to the nearest beats that actually sit on each side's grid —
        # the first/last beat of a slip is usually itself half-way off.
        a0 = a
        while a0 > a - side // 2 and abs(t[a0] - (lb + ls * a0)) > 0.08 * ls:
            a0 -= 1
        b0 = b
        while b0 < b + side // 2 and abs(t[b0] - (rb + rs * b0)) > 0.08 * rs:
            b0 += 1
        s = (ls + rs) / 2.0
        span = (t[b0] - t[a0]) / s
        count = int(round(span))
        if count < 2 or count == b0 - a0 or abs(span - count) > phase_tol:
            continue
        ratio = (b0 - a0) / count
        if min(abs(ratio / r - 1.0) for r in EXCURSION_RATIOS) > ratio_tol:
            continue
        spans.append((a0, b0, count))

    if not spans:
        return beats, 0
    out = []
    prev_end = 0
    applied = 0
    for a0, b0, count in spans:
        if a0 < prev_end:
            continue  # overlapping candidates — keep the first
        applied += 1
        out.extend(float(x) for x in t[prev_end:a0])
        step = (t[b0] - t[a0]) / count
        out.extend(float(t[a0] + k * step) for k in range(count))
        prev_end = b0
    out.extend(float(x) for x in t[prev_end:])
    return [{"t": round(x, 4), "pos": 0} for x in out], applied


TRACKER_FRAME_SEC = 0.02  # Beat This! and BeatNet both emit beats on a 50 fps frame grid


def refine_subframe_timing(beats, frame=TRACKER_FRAME_SEC, half=8, cap=0.012,
                           trim=0.025, exact_tol=0.0005):
    """
    Remove the tracker's 20ms frame quantization from beat times.

    The DBN can only place a beat on a 20ms frame, so any tempo whose interval
    is not an exact multiple of 20ms comes out as a sawtooth: e.g. a real
    468.8ms interval (128bpm) is emitted as a 460/480ms alternation, and a
    461.5ms one as a run of 460s with a 20ms catch-up jump every dozen beats.
    Each beat can sit up to 10ms off where the band played it, and the jumps
    are audible as the click "wobbling" on a song that holds steady tempo.

    Each beat is replaced by a robust local quadratic fit of time vs index over
    ±`half` beats (quadratic, not linear, so a gradual accelerando/ritard is
    followed rather than flattened), with points more than `trim` off the fit
    excluded so a slip or phase step does not bend the curve. The move is
    applied only when:
      - it is at most `cap` (a little over half a frame) — the quantization
        error this targets can never exceed 10ms, so anything bigger is a real
        timing event (or a different error) and is left alone;
      - the local interval is NOT already an exact frame multiple (within
        `exact_tol`). For, say, a click-recorded 120.0bpm song every raw beat
        is already exact, and smoothing only adds noise — measured on three
        such studio tracks.

    Measured against a sharp (2.9ms-hop) spectral-flux onset reference across a
    16-song library: onset-alignment spread (MAD) 6.31ms -> 5.75ms on average,
    up to 6.2 -> 3.5ms on a song whose tempo sits between frames; worst single
    song +0.6ms (inaudible). Runs per contiguous run so a fit never spans a stop.

    Returns (beats, n_moved).
    """
    import numpy as np
    n = len(beats)
    if n < 2 * half:
        return beats, 0
    times = np.array([b["t"] for b in beats], dtype=float)
    out = times.copy()
    deg = 2
    min_pts = deg + 4

    # Run boundaries by index (same rule as contiguous_runs: a gap > 2x the
    # median interval is a stop, not a slow beat).
    diffs = np.diff(times)
    positive = diffs[diffs > 0]
    med = float(np.median(positive)) if len(positive) else 0.5
    breaks = [0] + [i + 1 for i, d in enumerate(diffs) if d > 2.0 * med] + [n]

    moved = 0
    for r0, r1 in zip(breaks, breaks[1:]):
        for i in range(r0, r1):
            lo, hi = max(r0, i - half), min(r1, i + half + 1)
            if hi - lo < min_pts + 2:
                continue
            idx = np.arange(lo, hi)
            x = (idx - i).astype(float)
            ys = times[idx]
            mask = np.ones(len(idx), dtype=bool)
            coeffs = None
            for _ in range(3):
                coeffs = np.polyfit(x[mask], ys[mask], deg)
                keep = np.abs(ys - np.polyval(coeffs, x)) <= trim
                if (keep == mask).all() or keep.sum() < min_pts:
                    break
                mask = keep
            if mask.sum() < min_pts:
                continue
            coeffs = np.polyfit(x[mask], ys[mask], deg)
            slope = float(np.polyval(np.polyder(coeffs), 0.0))
            if slope <= 0:
                continue
            if abs(slope - round(slope / frame) * frame) < exact_tol:
                continue  # tempo already lands on the frame grid — raw is exact
            fit = float(np.polyval(coeffs, 0.0))
            if abs(times[i] - fit) > cap:
                continue
            out[i] = fit

    # Never reorder beats (cannot happen with cap << interval, but be certain).
    if np.any(np.diff(out) <= 0):
        return beats, 0
    new_beats = [dict(b) for b in beats]
    for i in range(n):
        if abs(out[i] - times[i]) > 1e-4:
            new_beats[i]["t"] = round(float(out[i]), 4)
            moved += 1
    return new_beats, moved


def beat_grid_residual(times, numerator):
    """
    Per-beat "is the local grid coherent" score, 0..1.

    Fits a straight line to beat time vs beat index over a window centred on each
    beat and measures how far that beat sits from the line, as a fraction of the
    beat interval. A dropped beat, an inserted beat, a phase jump or a metrical
    slip all break the index↔time line locally and push the deviation toward
    half a beat or more. This is `fit_run`'s residual idea (see its docstring)
    applied per beat instead of collapsed into a segment — detect_tempo_segments
    can merge across a broken stretch when the tempo matches either side, so a
    "confident" segment is not proof the grid is whole.

    1.0 = beat lands on the local line; 0.0 = off by ≥ ~an 8th note.
    Returns np.ndarray (len == len(times)); NaN where the window is too short.
    """
    import numpy as np
    n = len(times)
    out = np.full(n, np.nan)
    if n < 8:
        return out
    w = max(2 * numerator, 8)
    t = np.asarray(times, float)
    for i in range(n):
        lo = max(0, i - w)
        hi = min(n, i + w + 1)
        seg = t[lo:hi]
        if len(seg) < 6:
            continue
        idx = np.arange(len(seg))
        slope, intercept = np.polyfit(idx, seg, 1)
        if slope <= 0:
            continue
        dev = abs(t[i] - (intercept + slope * (i - lo)))
        out[i] = max(0.0, 1.0 - dev / (0.3 * slope))
    return out


def run_madmom_beats(path):
    """
    Independent second beat tracker — madmom's RNN activations + DBN, beat-only
    (no downbeat). Architecturally unrelated to Beat This! (an 8-model BiLSTM bag
    vs a transformer, different training data), so agreement within an 8th note
    is real corroboration and divergence is a real warning. Returns beat times
    (np.ndarray, seconds) or None on any failure — it is an optional signal and
    must never fail the analysis.
    """
    try:
        import numpy as np
        from madmom.features.beats import RNNBeatProcessor, DBNBeatTrackingProcessor
        act = RNNBeatProcessor()(path)
        beats = DBNBeatTrackingProcessor(
            fps=100, min_bpm=55, max_bpm=215, transition_lambda=100,
        )(act)
        beats = np.asarray(beats, dtype=float)
        return beats if len(beats) else None
    except Exception as e:  # pragma: no cover - optional signal
        sys.stderr.write(f"warning: second-tracker (madmom) beats unavailable ({e})\n")
        return None


def _moving_median(xs, half):
    import numpy as np
    n = len(xs)
    out = np.empty(n)
    for i in range(n):
        out[i] = np.median(xs[max(0, i - half):min(n, i + half + 1)])
    return out


def compute_beat_confidence(beats, numerator, *, clarity, grid=None, madmom_times=None,
                            frame_act=None, smooth_half=None):
    """
    Combine the available per-beat signals into one 0..1 confidence per beat.

    Returns (confs: list[float], parts: list[dict]). parts[i] holds the raw
    sub-scores {"onset": float|absent, "madmom": float|None, "frame": float|None}
    for span-reason classification.

    Signals renormalize over whatever is present: with the second tracker off the
    madmom term is DROPPED (not zeroed); the frame term is absent until Phase 3.
    """
    import numpy as np
    times = [b["t"] for b in beats]
    n = len(times)
    if n == 0:
        return [], []

    local_iv = _local_intervals(times)
    tarr = np.asarray(times, dtype=float)
    mt = np.asarray(madmom_times, dtype=float) if madmom_times is not None else None
    if mt is not None and not len(mt):
        mt = None
    if mt is not None:
        mt = np.sort(mt)
    dens_w = max(2 * numerator, 8)   # beats each side for the local density ratio

    confs, parts = [], []
    for i in range(n):
        p = {}
        c = clarity[i] if (clarity is not None and i < len(clarity)) else float("nan")
        if not math.isnan(c):
            p["onset"] = min(1.0, max(0.0,
                (c - CONF_ONSET_LO) / (CONF_ONSET_HI - CONF_ONSET_LO)))
        g = grid[i] if (grid is not None and i < len(grid)) else float("nan")
        if not math.isnan(g):
            p["grid"] = min(1.0, max(0.0, float(g)))
        p["madmom"] = None
        if mt is not None:
            # madmom is only a useful *phase* reference where it agrees with the
            # primary on TEMPO. It frequently octave-slips (tracks a slow song at
            # 2x, a busy one at 0.5x) — measured on real tracks — and when it
            # does, its beats say nothing about whether the primary grid is
            # right. So: compare local tempos first; use the phase signal only
            # when they match, otherwise drop madmom for this beat entirely
            # (renormalize onto onset). Deciding half/double-time is
            # fix_metrical_level's job, not this blend's.
            lo_t = times[max(0, i - dens_w)]
            hi_t = times[min(n - 1, i + dens_w)]
            md_here = mt[(mt >= lo_t) & (mt <= hi_t)]
            if len(md_here) >= 3 and local_iv[i] > 0:
                md_iv = float(np.median(np.diff(md_here)))
                r = md_iv / local_iv[i]
                if 0.90 <= r <= 1.11:
                    j = int(np.argmin(np.abs(mt - times[i])))
                    dt = abs(float(mt[j]) - times[i])
                    tol = CONF_MADMOM_TOL_RATIO * local_iv[i]
                    p["madmom"] = 0.0 if (tol <= 0 or dt > 2.0 * tol) else \
                        min(1.0, max(0.0, 1.0 - dt / tol))
        if frame_act is not None and i < len(frame_act):
            p["frame"] = min(1.0, max(0.0, (float(frame_act[i]) - 0.3) / 0.3))
        else:
            p["frame"] = None

        num = den = 0.0
        if "onset" in p:
            num += CONF_W_ONSET * p["onset"]; den += CONF_W_ONSET
        if "grid" in p:
            num += CONF_W_GRID * p["grid"]; den += CONF_W_GRID
        if p["madmom"] is not None:
            num += CONF_W_MADMOM * p["madmom"]; den += CONF_W_MADMOM
        if p["frame"] is not None:
            num += CONF_W_FRAME * p["frame"]; den += CONF_W_FRAME
        confs.append(num / den if den > 0 else float("nan"))
        parts.append(p)

    # Sectional smoothing — the failure mode is a whole passage; a lone low beat
    # must not fragment a span nor a lone good beat split one.
    half = smooth_half or CONF_SMOOTH_BEATS or max(numerator, 3)
    arr = np.array([0.5 if math.isnan(x) else x for x in confs], dtype=float)
    if len(arr):
        arr = _moving_median(arr, int(half))
    return [float(x) for x in arr], parts


def _abutting_confident_bpm(segments, start_t, end_t):
    """tempoBpm of a confident segment covering or touching [start_t, end_t], else 0.0."""
    best = 0.0
    for s in segments or []:
        if not s.get("confident"):
            continue
        if s.get("endT", -1e18) >= start_t - 1e-6 and s.get("startT", 1e18) <= end_t + 1e-6:
            bpm = float(s.get("tempoBpm") or 0.0)
            if bpm > 0:
                best = bpm
    return best


def low_confidence_spans(beats, confs, parts, numerator, segments=None,
                         thresh=LOW_CONF_THRESH):
    """
    Contiguous runs of low-confidence beats, each >= one bar, merged when closer
    than a bar apart. Returns [{startT, endT, reason}] on the beats[].t timeline,
    sorted by startT. Every signal-specific reason branch is guarded on that
    signal being PRESENT, so the second-tracker-off case cannot raise.
    """
    import numpy as np
    n = len(beats)
    if n == 0 or not confs or len(confs) != n:
        return []
    times = [b["t"] for b in beats]
    diffs = np.diff(times) if n > 1 else np.array([0.5])
    local_iv = _local_intervals(times)

    low = [(not math.isnan(c)) and c < thresh for c in confs]
    runs = []
    i = 0
    while i < n:
        if not low[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and low[j + 1]:
            j += 1
        runs.append([i, j])
        i = j + 1

    # Keep a run if it is at least a bar long, OR short but severe — a dropped or
    # doubled beat is a 1-2 beat defect the user still wants marked (e.g. a
    # double-click on a section entry).
    def keep(r):
        if (r[1] - r[0] + 1) >= numerator:
            return True
        return min(confs[r[0]:r[1] + 1]) < 0.20
    runs = [r for r in runs if keep(r)]
    if not runs:
        return []
    merged = [runs[0]]
    for a, b in runs[1:]:
        if a - merged[-1][1] <= numerator:
            merged[-1][1] = b
        else:
            merged.append([a, b])

    spans = []
    for a, b in merged:
        start_t = times[a] - 0.5 * local_iv[a]
        end_t = times[b] + 0.5 * local_iv[b]
        mad = [parts[k]["madmom"] for k in range(a, b + 1) if parts[k].get("madmom") is not None]
        ons = [parts[k]["onset"] for k in range(a, b + 1) if "onset" in parts[k]]
        grd = [parts[k]["grid"] for k in range(a, b + 1) if "grid" in parts[k]]
        frm = [parts[k]["frame"] for k in range(a, b + 1) if parts[k].get("frame") is not None]

        reason = "mixed"
        span_iv = float(np.median(diffs[a:b])) if b > a else local_iv[a]
        ref_bpm = _abutting_confident_bpm(segments, start_t, end_t)
        if ref_bpm > 0 and span_iv > 0:
            r = (60.0 / span_iv) / ref_bpm
            if abs(r - 0.5) < 0.12 or abs(r - 2.0) < 0.24:
                reason = "half-time-suspected"
        if reason == "mixed":
            # grid-broken (dropped/extra beat, phase jump) and onset-weak (no
            # real beat where the click is — noise or a phase error) are the
            # actionable calls. A bare 2nd-tracker disagreement is often just an
            # octave slip, so it ranks last.
            if grd and statistics.median(grd) < 0.35:
                reason = "grid-broken"
            elif ons and statistics.median(ons) < 0.35:
                reason = "onset-weak"
            elif mad and statistics.median(mad) < 0.35:
                reason = "tracker-disagree"
            elif frm and statistics.median(frm) < 0.35:
                reason = "frame-weak"
        spans.append({"startT": round(start_t, 4), "endT": round(end_t, 4), "reason": reason})
    return spans


def annotate_segments_with_confidence(segments, beats, confs):
    """
    Add `conf` (median member-beat confidence) and `gridClean` (the prior
    regression-residual `confident` value, preserved for A/B) to each segment.
    Phase 1 does NOT change `confident` itself.
    """
    if not segments or not beats or not confs or len(confs) != len(beats):
        return segments
    times = [b["t"] for b in beats]
    for s in segments:
        lo = s.get("startT", 0.0) - 1e-6
        hi = s.get("endT", 0.0) + 1e-6
        members = [
            confs[i] for i, t in enumerate(times)
            if lo <= t <= hi and not math.isnan(confs[i])
        ]
        s["gridClean"] = bool(s.get("confident"))
        s["conf"] = round(statistics.median(members), 3) if members else None
    return segments


def run_beat_this(path, use_dbn=True, device="cpu"):
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

    beats, downbeats = File2Beats(checkpoint_path=checkpoint, device=device, dbn=use_dbn)(path)
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
    ap.add_argument(
        "--device",
        choices=["auto", "cpu", "cuda"],
        default="auto",
        help=(
            "Torch device for Beat This! inference. 'auto' uses CUDA when a GPU "
            "is available, else CPU. Only the Beat This! transformer benefits — "
            "the second confidence tracker (madmom RNN) is CPU-only. The frozen "
            "build ships CPU-only torch, so 'auto' resolves to CPU there."
        ),
    )
    ap.add_argument(
        "--no-second-tracker",
        action="store_true",
        help=(
            "Skip the independent madmom RNN beat pass used only to score "
            "confidence (see run_madmom_beats / compute_beat_confidence). "
            "Halves analysis time; lowConfidenceSpans then rely on onset "
            "energy alone and miss a confident half-time slip."
        ),
    )
    ap.add_argument(
        "--no-excursion-fix",
        action="store_true",
        help=(
            "Leave short stretches where the tracker followed a riff's accent "
            "pattern instead of the pulse — see bridge_tempo_excursions()."
        ),
    )
    ap.add_argument(
        "--no-subframe",
        action="store_true",
        help=(
            "Keep the tracker's raw 20ms-quantized beat times instead of "
            "removing the frame sawtooth — see refine_subframe_timing()."
        ),
    )
    ap.add_argument(
        "--conf-smooth-beats",
        type=int,
        default=0,
        help=(
            "Moving-median half-width (in beats) for per-beat confidence "
            "smoothing. 0 -> default of max(numerator, 6)."
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

    device = args.device
    if device == "auto":
        try:
            import torch
            device = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            device = "cpu"

    log(stage="analyzing")
    t0 = time.time()
    try:
        if engine == "beat_this":
            out = run_beat_this(analyze_path, use_dbn=True, device=device)
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

    # Independent second tracker (madmom RNN), used only to score confidence.
    # Runs here — main tracking done, analyze_path (possibly the trimmed temp)
    # still on disk. Its beats are on the analyzed timeline; shifted back below.
    madmom_beats = None
    if not args.no_second_tracker:
        log(stage="verifying")
        madmom_beats = run_madmom_beats(analyze_path)

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

    # Second-tracker beats onto the same (original-file) timeline as `beats`.
    madmom_orig = (madmom_beats + lead_trim) if madmom_beats is not None else None

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

    # Correct isolated slips — a syncopated fill or accent briefly mistaken for
    # the pulse, with the grid resuming right after (e.g. a beat landing ~40%
    # of an interval late for one or two beats, then locking straight back to
    # the same phase it held before). Snaps only a beat bracketed by neighbours
    # that already agree tightly on tempo — never a sustained tempo/meter change,
    # which fits no such tight line across it. See snap_grid_outliers().
    grid_snapped = 0
    try:
        pre_numerator = derive_numerator(positions)
        beats, grid_snapped = snap_grid_outliers(beats, pre_numerator)
        times = [b["t"] for b in beats]
    except Exception as e:  # pragma: no cover
        sys.stderr.write(f"warning: grid-outlier snap failed ({e}); using unsnapped beat times\n")
        grid_snapped = 0

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

    # Re-lay short stretches where the tracker followed a riff's accents (e.g.
    # 4 clicks per 5 beats) and then returned to the pulse in phase.
    excursions = 0
    if not args.no_excursion_fix:
        try:
            first_downbeat_t = next((b["t"] for b in beats if b["pos"] == 1), None)
            fixed, excursions = bridge_tempo_excursions(beats)
            if excursions:
                beats = renumber_positions(fixed, numerator, first_downbeat_t)
                times = [b["t"] for b in beats]
                tempo_bpm = derive_tempo(times)
                tempo_segments = detect_tempo_segments(times)
                sys.stderr.write(f"note: bridged {excursions} tempo excursion(s)\n")
        except Exception as e:  # pragma: no cover
            sys.stderr.write(f"warning: excursion fix failed ({e}); leaving beats as tracked\n")
            excursions = 0

    # Remove the 20ms frame sawtooth last, after every edit that adds, drops or
    # re-lays beats, so it smooths the final grid. Moves are capped at 12ms —
    # it never changes which beat is which, only where inside its frame it sits.
    subframe_refined = 0
    if not args.no_subframe:
        try:
            beats, subframe_refined = refine_subframe_timing(beats)
            times = [b["t"] for b in beats]
        except Exception as e:  # pragma: no cover
            sys.stderr.write(f"warning: sub-frame refinement failed ({e}); using frame-quantized beats\n")
            subframe_refined = 0

    try:
        anchor_t = pick_anchor(args.input, beats, numerator)
    except Exception as e:  # pragma: no cover
        sys.stderr.write(f"warning: anchor scoring failed ({e}); omitting anchorT\n")
        anchor_t = None

    # Beat confidence — Phase 1: measure only, no beat times change. Scored on
    # the FINAL beat list (after any level-fix / bridge above) so the spans line
    # up with beats[].t. Signals: onset-energy contrast at each beat, plus the
    # independent madmom tracker where available. Never fails the analysis.
    confidence = None
    low_conf_spans = []
    try:
        env, env_times = onset_env(args.input)
        clarity = beat_onset_clarity(env, env_times, times, numerator)
        grid_res = beat_grid_residual(times, numerator)
        confs, parts = compute_beat_confidence(
            beats, numerator, clarity=clarity, grid=grid_res, madmom_times=madmom_orig,
            smooth_half=(args.conf_smooth_beats or None),
        )
        tempo_segments = annotate_segments_with_confidence(tempo_segments, beats, confs)
        low_conf_spans = low_confidence_spans(beats, confs, parts, numerator, tempo_segments)
        for i, b in enumerate(beats):
            if i < len(confs) and not math.isnan(confs[i]):
                b["conf"] = round(confs[i], 3)
        valid = [c for c in confs if not math.isnan(c)]
        confidence = {
            "method": "onset+madmom" if madmom_orig is not None else "onset",
            "secondTracker": "madmom-rnn-dbn" if madmom_orig is not None else None,
            "weights": {
                "onset": CONF_W_ONSET, "grid": CONF_W_GRID,
                "madmom": CONF_W_MADMOM, "frames": CONF_W_FRAME,
            },
            "meanConf": round(sum(valid) / len(valid), 3) if valid else None,
            "minConf": round(min(valid), 3) if valid else None,
        }
    except Exception as e:  # pragma: no cover - never fail analysis for confidence
        sys.stderr.write(f"warning: confidence scoring failed ({e})\n")
        confidence = None
        low_conf_spans = []

    descriptor = {
        "version": 2,
        "engine": "beat-this-dbn" if engine == "beat_this" else "beatnet-dbn",
        "device": device if engine == "beat_this" else "cpu",
        "beats": beats,
        "numerator": numerator,
        "tempoBpm": tempo_bpm,
        "generatedAt": int(time.time() * 1000),
        "analysisSeconds": round(time.time() - t0, 1),
        "leadInTrimSec": lead_trim,
        "anchorT": anchor_t,
        "weakAttackRefined": weak_attack_refined,
        "gridSnapped": grid_snapped,
        "subframeRefined": subframe_refined,
        "excursionsBridged": excursions,
        "tempoSegments": tempo_segments,
        "levelCorrected": level_corrected,
        "bridgedStretches": bridged,
        "confidence": confidence,
        "lowConfidenceSpans": low_conf_spans,
    }

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(descriptor, f)

    log(stage="done", beats=len(beats), numerator=numerator, tempoBpm=tempo_bpm, device=descriptor["device"])


if __name__ == "__main__":
    main()
