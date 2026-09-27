# Stagehand beat-detection sidecar

`beat_detect.py` wraps [Beat This!](https://github.com/CPJKU/beat_this) (CPJKU)
with madmom DBN post-processing to analyze one audio file and emit a beat-grid
JSON descriptor consumed by the Stagehand **Create Click Track** feature.
[BeatNet](https://github.com/mjhydri/BeatNet) (CC BY 4.0) remains selectable via
`--engine beatnet` for local experiments, but it is not part of the frozen build
the app ships (it pins `numba==0.54.1`, which has no Python 3.10 wheels) and the
app never requests it.

## What the app expects

At runtime the Tauri backend (`src-tauri/src/click_track.rs`) locates the frozen
PyInstaller **onedir** build and runs its executable directly (`std::process`):

```
beat_detect/beat_detect.exe --input <mono wav> --output <APPDATA>/com.stagehand.rehearsal/clicktracks/<trackId>.json
```

Resolution order: `STAGEHAND_BEAT_DETECT` env var → `<app resource dir>/beat_detect/beat_detect.exe`
→ `src-tauri/binaries/beat_detect/beat_detect.exe` (dev fallback).

`STAGEHAND_BEAT_DETECT` accepts either a path to a built `beat_detect.exe`, or
`python:<path to a Python interpreter>` to run the unfrozen `beat_detect.py`
directly (fast local dev loop, no PyInstaller build needed) — e.g.:
```
set STAGEHAND_BEAT_DETECT=python:F:\Claude\stagehand\sidecar\.venv\Scripts\python.exe
```

- stdout: one JSON object per line — `{"stage":"loading"}`, `{"stage":"analyzing"}`,
  `{"stage":"done", ...}`. The backend re-emits these as `clicktrack_progress` events.
- exit 0 + the `--output` file written on success; non-zero + stderr message on failure.

Descriptor shape (abridged — the analysis also writes `analysisSeconds`,
`leadInTrimSec`, `anchorT`, `weakAttackRefined`, `tempoSegments`, `levelCorrected`,
`bridgedStretches`):

```json
{
  "version": 2,
  "engine": "beat-this-dbn",
  "beats": [{ "t": 0.51, "pos": 1, "conf": 0.93 }, ...],
  "numerator": 4,
  "tempoBpm": 120.0,
  "generatedAt": 1730000000000,
  "confidence": {
    "method": "onset+madmom", "secondTracker": "madmom-rnn-dbn",
    "weights": { "onset": 0.35, "madmom": 0.5, "frames": 0.15 },
    "meanConf": 0.87, "minConf": 0.21
  },
  "lowConfidenceSpans": [
    { "startT": 41.7, "endT": 49.2, "reason": "tracker-disagree" }
  ]
}
```

`pos` is the 1-indexed beat position within the bar (`1` = downbeat).

`beats[].conf` (0..1) and `confidence` / `lowConfidenceSpans` are Phase 1 of
evidence-based confidence scoring (`compute_beat_confidence`): a per-beat blend of
onset-energy contrast and agreement with an independent second tracker
(madmom RNN, run unless `--no-second-tracker`). Phase 1 **measures only** — it
changes no beat time; the Perform panel draws `lowConfidenceSpans` as markers on
the scrub bar. `confidence` is `null` and `lowConfidenceSpans` `[]` if scoring
failed. `reason` ∈ `tracker-disagree | onset-weak | frame-weak |
half-time-suspected | mixed`. The second tracker roughly doubles analysis time
(a `{"stage":"verifying"}` line marks it).

## Local development

`madmom` only builds on **Python 3.10**. From the repo root:

```sh
py -3.10 -m venv sidecar/.venv
sidecar/.venv/Scripts/pip install --index-url https://download.pytorch.org/whl/cpu torch torchaudio
sidecar/.venv/Scripts/pip install -r sidecar/requirements.txt
```

To also exercise the `--engine beatnet` path locally, add `BeatNet==1.1.3` in a
**Python 3.9** venv (it will not install on 3.10 — see `requirements.txt`).

Run it directly:

```sh
sidecar/.venv/Scripts/python sidecar/beat_detect.py --input some.wav --output out.json
```

### Tests

`sidecar/tests/` holds pure-Python tests (no torch / librosa / madmom needed —
every heavy import in `beat_detect.py` is deferred). They run in CI on numpy +
pytest alone:

```sh
sidecar/.venv/Scripts/pip install -r sidecar/requirements-dev.txt
sidecar/.venv/Scripts/python -m pytest sidecar/tests -q
```

### Building the frozen binary

```sh
sidecar/.venv/Scripts/pip install pyinstaller
sidecar/.venv/Scripts/pyinstaller sidecar/beat_detect.spec --noconfirm \
  --distpath sidecar/dist --workpath sidecar/build
```

Then stage the onedir folder for local dev (copy *contents*, not the folder itself
— `src-tauri/binaries/beat_detect/` already exists with a tracked `.gitkeep`):

```
mkdir -p src-tauri/binaries/beat_detect
cp -r sidecar/dist/beat_detect/*  src-tauri/binaries/beat_detect/
```

`src-tauri/binaries/beat_detect/` contents are git-ignored except `.gitkeep`
(~400 MB when built; CI rebuilds it on every release — the `.gitkeep` exists only
so `tauri.conf.json`'s `bundle.resources` glob always matches at least one file,
since Tauri hard-fails the build on a zero-match glob). `tauri.conf.json` maps
`binaries/beat_detect/**/*` into the installer's resource dir. See
`.github/workflows/release.yml`.

## CI

The release workflow installs Python 3.10, `pip install`s this `requirements.txt`,
fetches the Beat This! checkpoint into the torch hub cache (so `beat_detect.spec`
can bundle it), runs PyInstaller with `beat_detect.spec`, and stages the output
under `src-tauri/binaries/` before `tauri-action` builds the installer.
