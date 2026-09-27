"""
Pure-Python tests for beat_detect.py.

These do NOT need torch / librosa / madmom — beat_detect.py keeps every heavy
import deferred inside the function that uses it, so `import beat_detect` is
stdlib-only. compute_beat_confidence / beat_onset_clarity use numpy, hence
numpy is the one non-stdlib dep for this file (see sidecar/requirements-dev.txt).

    sidecar/.venv/Scripts/python -m pytest sidecar/tests -q
"""

import math
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import beat_detect as bd  # noqa: E402


# --- helpers -------------------------------------------------------------------

def grid_times(bpm, count, start=0.0):
    iv = 60.0 / bpm
    return [round(start + i * iv, 4) for i in range(count)]


def beats_from_times(times, numerator=4):
    return [{"t": t, "pos": (i % numerator) + 1} for i, t in enumerate(times)]


# --- currently-untested pure functions --------------------------------------

def test_derive_numerator():
    assert bd.derive_numerator([1, 2, 3, 4, 1, 2, 3, 4, 1]) == 4
    assert bd.derive_numerator([1, 2, 3, 1, 2, 3, 1]) == 3
    assert bd.derive_numerator([3, 4, 1, 2, 3, 4]) == 4      # one downbeat -> widest
    assert bd.derive_numerator([]) == 4
    assert bd.derive_numerator([1, 1, 1]) == 4


def test_derive_tempo():
    assert bd.derive_tempo(grid_times(120, 20)) == pytest.approx(120.0, abs=0.01)
    assert bd.derive_tempo([]) == 0.0
    assert bd.derive_tempo([1.0]) == 0.0


def test_fit_run_recovers_tempo_and_flags_broken_grid():
    slope, resid = bd.fit_run(grid_times(137.0, 40))
    assert 60.0 / slope == pytest.approx(137.0, abs=0.5)
    assert resid < 0.005
    # drop a beat mid-run -> residual blows up
    t = grid_times(137.0, 40)
    del t[20]
    _, resid_broken = bd.fit_run(t)
    assert resid_broken > 0.05


def test_contiguous_runs_splits_on_gap():
    t = grid_times(120, 10) + [100.0 + x for x in grid_times(120, 10)]
    runs = bd.contiguous_runs(t)
    assert len(runs) == 2
    assert all(len(r) == 10 for r in runs)


def test_detect_tempo_segments_single_tempo():
    segs = bd.detect_tempo_segments(grid_times(128.0, 120))
    assert len(segs) >= 1
    assert segs[0]["tempoBpm"] == pytest.approx(128.0, abs=1.0)
    assert segs[0]["confident"] is True


def test_renumber_positions_anchors_to_downbeat():
    beats = [{"t": float(i), "pos": 0} for i in range(8)]
    bd.renumber_positions(beats, 4, downbeat_t=1.0)
    assert [b["pos"] for b in beats] == [4, 1, 2, 3, 4, 1, 2, 3]


def test_snap_grid_outliers_corrects_an_isolated_slip():
    """
    The reported case: a syncopated fill briefly nudges 1-2 beats late, then
    the grid resumes at the SAME phase it held before — proof the true pulse
    never moved, only the tracker's read of two beats did.
    """
    iv = 60.0 / 130.43
    times = [round(i * iv, 4) for i in range(120)]
    original_60, original_61 = times[60], times[61]
    times[60] += 0.10   # ~22% of a beat — within the "real slip" band
    times[61] += 0.10
    beats = beats_from_times(times)
    fixed, n = bd.snap_grid_outliers(beats, 4)
    assert n == 2
    assert fixed[60]["t"] == pytest.approx(original_60, abs=0.01)
    assert fixed[61]["t"] == pytest.approx(original_61, abs=0.01)
    # untouched elsewhere
    assert fixed[30]["t"] == pytest.approx(times[30], abs=1e-9)
    assert fixed[90]["t"] == pytest.approx(times[90], abs=1e-9)


def test_snap_grid_outliers_leaves_a_real_tempo_change_alone():
    """A persisted tempo change never resumes the old phase, so no window ever
    fits a tight line across it — nothing gets corrected inside either region."""
    times = grid_times(120, 80) + grid_times(150, 80, start=grid_times(120, 80)[-1] + 60.0 / 120)
    beats = beats_from_times(times)
    fixed, n = bd.snap_grid_outliers(beats, 4)
    # deep inside each tempo region (away from the boundary) times are untouched
    for i in list(range(20, 60)) + list(range(100, 140)):
        assert fixed[i]["t"] == pytest.approx(beats[i]["t"], abs=1e-9)


def test_snap_grid_outliers_never_reorders_beats():
    iv = 0.5
    times = [round(i * iv, 4) for i in range(80)]
    times[40] += 0.19  # just under dev_hi (0.40 * iv = 0.20) — largest tolerated nudge
    beats = beats_from_times(times)
    fixed, _ = bd.snap_grid_outliers(beats, 4)
    ts = [b["t"] for b in fixed]
    assert ts == sorted(ts)


def _frame_quantize(times, frame=0.02):
    return [round(round(t / frame) * frame, 4) for t in times]


def test_refine_subframe_timing_removes_frame_sawtooth():
    # 128bpm (468.75ms) is between frames: the tracker emits a 460/480 sawtooth
    # up to 10ms off. Refinement should pull it back close to the true grid.
    true = [1.0 + i * 0.46875 for i in range(64)]
    quant = _frame_quantize(true)
    raw_err = max(abs(a - b) for a, b in zip(quant, true))
    assert raw_err > 0.008
    out, moved = bd.refine_subframe_timing(beats_from_times(quant))
    assert moved > len(true) // 2
    inner = range(8, len(true) - 8)  # edges have one-sided windows
    new_err = max(abs(out[i]["t"] - true[i]) for i in inner)
    assert new_err < 0.004


def test_refine_subframe_timing_leaves_frame_exact_tempo_alone():
    # 120bpm = 500ms = exactly 25 frames: raw beats are already exact.
    quant = _frame_quantize([0.5 + i * 0.5 for i in range(64)])
    out, moved = bd.refine_subframe_timing(beats_from_times(quant))
    assert moved == 0
    assert [b["t"] for b in out] == quant


def test_refine_subframe_timing_never_moves_more_than_cap():
    # A real 40ms push on one beat must survive — it is not quantization.
    true = [1.0 + i * 0.46875 for i in range(64)]
    quant = _frame_quantize(true)
    quant[30] = round(quant[30] + 0.04, 4)
    out, _ = bd.refine_subframe_timing(beats_from_times(quant))
    assert all(abs(o["t"] - q) <= 0.012 + 1e-9 for o, q in zip(out, quant))
    assert out[30]["t"] == quant[30]
    ts = [b["t"] for b in out]
    assert all(b > a for a, b in zip(ts, ts[1:]))


def test_refine_subframe_timing_does_not_fit_across_a_stop():
    a = [1.0 + i * 0.46875 for i in range(32)]
    b = [a[-1] + 5.0 + i * 0.46875 for i in range(32)]  # 5s stop, new phase
    quant = _frame_quantize(a + b)
    out, _ = bd.refine_subframe_timing(beats_from_times(quant))
    assert all(abs(o["t"] - q) <= 0.012 + 1e-9 for o, q in zip(out, quant))


def _excursion_track(tracked_iv_ratio=1.25, true_beats=25, pre=40, post=40, iv=0.353):
    """Steady pulse, then a stretch where the tracker placed clicks at
    `tracked_iv_ratio` x the interval (e.g. 4 clicks per 5 beats), then the
    pulse resumes in phase."""
    t = [1.0 + i * iv for i in range(pre)]
    start = t[-1]
    span = true_beats * iv
    n_tracked = int(round(true_beats / tracked_iv_ratio))
    t += [start + k * span / n_tracked for k in range(1, n_tracked)]
    t += [start + span + i * iv for i in range(post)]
    return t, start, span


def test_bridge_tempo_excursions_relays_a_5_over_4_slip():
    t, start, span = _excursion_track()
    out, n = bd.bridge_tempo_excursions(beats_from_times(t))
    assert n == 1
    ts = [b["t"] for b in out]
    assert len(ts) == len(t) + 5          # 20 tracked -> 25 true beats in the span
    inside = [x for x in ts if start <= x <= start + span]
    diffs = [b - a for a, b in zip(inside, inside[1:])]
    assert max(abs(d - 0.353) for d in diffs) < 0.002


def test_bridge_tempo_excursions_ignores_a_real_tempo_change():
    iv1, iv2 = 0.353, 0.440
    t = [1.0 + i * iv1 for i in range(60)]
    t += [t[-1] + (i + 1) * iv2 for i in range(60)]
    out, n = bd.bridge_tempo_excursions(beats_from_times(t))
    assert n == 0
    assert [b["t"] for b in out] == t


def test_bridge_tempo_excursions_needs_the_pulse_to_return_in_phase():
    # Same slip, but the pulse resumes half a beat late — a real bar event,
    # not a tracker excursion. Leave it.
    t, start, span = _excursion_track()
    t = [x + (0.5 * 0.353 if x > start + span - 1e-6 else 0.0) for x in t]
    out, n = bd.bridge_tempo_excursions(beats_from_times(t))
    assert n == 0


def test_dominant_tempo_weights_by_beats():
    segs = [
        {"tempoBpm": 90.0, "beats": 20},
        {"tempoBpm": 140.0, "beats": 200},
    ]
    assert bd.dominant_tempo(segs) == 140.0


def test_splice_even_beats_is_pure_arithmetic():
    beats = beats_from_times(grid_times(120, 20))
    out = bd.splice_even_beats(beats, 4, 2.0, 6.0, bar_count=2)
    spliced = [b for b in out if 2.0 <= b["t"] < 6.0]
    assert len(spliced) == 8
    ivs = [round(b2["t"] - b1["t"], 4) for b1, b2 in zip(spliced, spliced[1:])]
    assert all(iv == pytest.approx(0.5, abs=1e-6) for iv in ivs)


# --- confidence: onset signal ------------------------------------------------

def test_compute_beat_confidence_onset_only_no_second_tracker():
    """--no-second-tracker path: madmom_times=None must not raise, weights
    renormalize to onset-only."""
    times = grid_times(120, 60)
    beats = beats_from_times(times)
    clarity = [3.0] * 40 + [0.5] * 20            # last third: weak onsets
    confs, parts = bd.compute_beat_confidence(
        beats, 4, clarity=clarity, madmom_times=None,
    )
    assert len(confs) == 60
    assert all(p["madmom"] is None for p in parts)
    assert not any(math.isnan(c) for c in confs)
    # strong-onset region high, weak-onset region low
    assert min(confs[:30]) > 0.8
    assert max(confs[-10:]) < 0.3


def test_low_confidence_spans_onset_weak_reason():
    times = grid_times(120, 60)
    beats = beats_from_times(times)
    clarity = [3.0] * 40 + [0.5] * 20
    confs, parts = bd.compute_beat_confidence(beats, 4, clarity=clarity, madmom_times=None)
    spans = bd.low_confidence_spans(beats, confs, parts, 4, segments=None)
    assert len(spans) == 1
    assert spans[0]["reason"] == "onset-weak"
    assert spans[0]["startT"] > times[35]


# --- confidence: the regression that proves the fix -------------------------

def test_onset_weak_region_is_flagged():
    """
    The real-world failure (per ear testing): a stretch where the click lands
    where there is no onset — a noise intro/outro, a breakdown, or an 8th-note
    phase error. `beat_onset_clarity` is low there. That, not a second-tracker
    count mismatch, is what should drive the span.
    """
    times = grid_times(120, 300)
    beats = beats_from_times(times)
    # onset clarity high everywhere except beats 120..180 (beats sit off the grid)
    clarity = [3.0] * 300
    for k in range(120, 180):
        clarity[k] = 0.6
    confs, parts = bd.compute_beat_confidence(
        beats, 4, clarity=clarity, madmom_times=None,
    )
    assert max(confs[130:170]) < bd.LOW_CONF_THRESH
    assert min(confs[:100]) > 0.7
    assert min(confs[-100:]) > 0.7
    spans = bd.low_confidence_spans(beats, confs, parts, 4, segments=None)
    assert len(spans) == 1
    assert spans[0]["reason"] == "onset-weak"


def test_madmom_dropped_on_octave_disagreement():
    """
    madmom frequently octave-slips (a slow song read at 2x). When its local
    tempo disagrees with the primary by ~2x, its beats say nothing about
    whether the primary grid is right — the signal is DROPPED (parts.madmom
    None), not scored 0. Deciding half/double-time is fix_metrical_level's job.
    """
    times = grid_times(80, 200)                       # primary: 0.75s beats
    beats = beats_from_times(times)
    madmom = [round(i * 0.375, 4) for i in range(400)]  # 2x tempo
    clarity = [3.0] * 200
    confs, parts = bd.compute_beat_confidence(
        beats, 4, clarity=clarity, madmom_times=madmom,
    )
    mid = parts[100]
    assert mid["madmom"] is None                      # dropped, not 0.0
    assert min(confs[20:180]) > 0.7                    # onset alone keeps it confident


def test_annotate_segments_with_confidence_preserves_confident():
    times = grid_times(120, 80)
    beats = beats_from_times(times)
    confs = [0.9] * 40 + [0.2] * 40
    segs = [
        {"startT": times[0], "endT": times[39], "tempoBpm": 120.0, "confident": True},
        {"startT": times[40], "endT": times[79], "tempoBpm": 120.0, "confident": True},
    ]
    out = bd.annotate_segments_with_confidence(segs, beats, confs)
    assert out[0]["conf"] == pytest.approx(0.9)
    assert out[1]["conf"] == pytest.approx(0.2)
    assert out[0]["gridClean"] is True and out[1]["gridClean"] is True
    # Phase 1 must NOT flip `confident`
    assert out[0]["confident"] is True and out[1]["confident"] is True


def test_low_confidence_spans_shallow_short_dips_are_ignored():
    """A shallow 1-beat dip (normal timing wobble) is ignored; a *severe* short
    dip (a dropped/doubled beat) is kept — see the `keep` rule."""
    times = grid_times(120, 60)
    beats = beats_from_times(times)
    parts = [{"onset": 0.9, "grid": 0.9, "madmom": None, "frame": None} for _ in range(60)]

    shallow = [0.9] * 60
    shallow[30] = 0.4                                 # 1 beat, above 0.20 → ignored
    assert bd.low_confidence_spans(beats, shallow, parts, 4) == []

    severe = [0.9] * 60
    severe[30] = severe[31] = 0.05                    # 2 beats, deep → kept
    spans = bd.low_confidence_spans(beats, severe, parts, 4)
    assert len(spans) == 1


# --- integration (skipped without the heavy deps) --------------------------

@pytest.mark.skipif(
    __import__("importlib").util.find_spec("madmom") is None,
    reason="madmom not installed",
)
def test_run_madmom_beats_on_click_wav(tmp_path):
    import numpy as np
    import soundfile as sf

    sr = 44100
    y = np.zeros(sr * 4, dtype="float32")
    for i in range(8):                                # 8 clicks, 0.5s apart = 120 bpm
        y[int(i * 0.5 * sr)] = 1.0
    wav = tmp_path / "click.wav"
    sf.write(str(wav), y, sr)
    beats = bd.run_madmom_beats(str(wav))
    assert beats is None or len(beats) >= 4
