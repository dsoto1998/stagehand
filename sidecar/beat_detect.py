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
import statistics
import sys
import time


def log(**kw):
    """Emit one progress record as a JSON line on stdout."""
    sys.stdout.write(json.dumps(kw) + "\n")
    sys.stdout.flush()


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
    args = ap.parse_args()

    log(stage="loading")

    # Imported here so --help stays fast and import errors surface as a clear message.
    try:
        import numpy as np  # noqa: F401
        from BeatNet.BeatNet import BeatNet
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

    # Widen the meter search beyond BeatNet's default [2, 3, 4] so 5/4, 6/8, 7/8
    # songs are not force-fit to 4. The offline path uses a madmom
    # DBNDownBeatTrackingProcessor exposed as estimator.estimator.
    try:
        from madmom.features.downbeats import DBNDownBeatTrackingProcessor

        bpb = list(range(2, max(4, args.max_num) + 1))
        estimator.estimator = DBNDownBeatTrackingProcessor(beats_per_bar=bpb, fps=50)
    except Exception as e:  # pragma: no cover
        sys.stderr.write(f"warning: could not widen meter search ({e}); using default\n")

    log(stage="analyzing")
    t0 = time.time()
    try:
        out = estimator.process(args.input)
    except Exception as e:
        sys.stderr.write(f"analysis failed: {e}\n")
        sys.exit(3)

    # out: ndarray (N, 2) -> [time_seconds, position_in_bar]
    beats = []
    positions = []
    times = []
    for row in out:
        t = float(row[0])
        pos = int(round(float(row[1])))
        beats.append({"t": round(t, 4), "pos": pos})
        positions.append(pos)
        times.append(t)

    if len(beats) < 2:
        sys.stderr.write("analysis produced too few beats\n")
        sys.exit(4)

    numerator = derive_numerator(positions)
    tempo_bpm = derive_tempo(times)

    descriptor = {
        "version": 1,
        "engine": "beatnet-dbn",
        "beats": beats,
        "numerator": numerator,
        "tempoBpm": tempo_bpm,
        "generatedAt": int(time.time() * 1000),
        "analysisSeconds": round(time.time() - t0, 1),
    }

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(descriptor, f)

    log(stage="done", beats=len(beats), numerator=numerator, tempoBpm=tempo_bpm)


if __name__ == "__main__":
    main()
