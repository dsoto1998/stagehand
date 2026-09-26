# Stagehand analysis sidecar (beat detection + guitar removal)

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

Descriptor shape:

```json
{
  "version": 1,
  "engine": "beat-this-dbn",
  "beats": [{ "t": 0.51, "pos": 1 }, { "t": 1.0, "pos": 2 }, ...],
  "numerator": 4,
  "tempoBpm": 120.0,
  "generatedAt": 1730000000000
}
```

`pos` is the 1-indexed beat position within the bar (`1` = downbeat).

## Guitar removal — `stem_separate`

`stem_separate.py` runs Demucs v4 **htdemucs_6s** (the only open model with a
dedicated guitar stem — the same one Ultimate Vocal Remover uses for guitar) and
writes ONLY the guitar stem as 24-bit FLAC, sample-aligned with the input. It is
frozen into the same onedir folder as `beat_detect.exe` (one shared `_internal/`,
so torch ships once). The backend (`src-tauri/src/stems.rs`) runs:

```
beat_detect/stem_separate.exe --input <float wav decoded by the app> --output <APPDATA>/stems/<trackId>.guitar.flac [--torch-dir <GPU pack>]
```

- `STAGEHAND_STEM_SEPARATE` overrides the location, same syntax as `STAGEHAND_BEAT_DETECT`.
- stdout: `{"stage":"loading"}`, `{"stage":"separating","progress":0.42,"device":"cuda"}`,
  `{"stage":"done","device":"cuda","seconds":12.3}` → re-emitted as `stems_progress` / `stems_done`.
- `--probe [--torch-dir X]` prints `{"stage":"probe","torch":...,"cuda":true,"gpu":...}` and exits.

The app plays `original - (1 - g) * guitar` (Perform → Guitar slider), so no
backing track is stored and g = 100% is bit-identical to the recording.

### GPU pack

The frozen build has CPU torch (~4–5 min per song). Settings → Audio → *Guitar
Removal — GPU Acceleration* downloads the official `torch==2.11.0+cu130` wheel
(1.9 GB, SHA-256 pinned in `src-tauri/src/gpu_pack.rs`), extracts its `torch/`
package to `<APPDATA>/gpu/torch-2.11.0-cu130/`, and passes it as `--torch-dir`.
`stem_separate.py` then installs a `sys.meta_path` finder AHEAD of PyInstaller's
FrozenImporter so `import torch` resolves to the CUDA copy (~12–15 s per song on
an RTX 4070). **The CPU torch pin in `requirements.txt` / `release.yml` and the
wheel in `gpu_pack.rs` must stay the same version** — the frozen numpy etc. are
resolved against it. If a GPU run fails, the backend retries on CPU.

## Local development

`madmom` only builds on **Python 3.10**. From the repo root:

```sh
py -3.10 -m venv sidecar/.venv
sidecar/.venv/Scripts/pip install --index-url https://download.pytorch.org/whl/cpu torch==2.11.0 torchaudio==2.11.0
sidecar/.venv/Scripts/pip install "numpy<1.24" "Cython<3"
sidecar/.venv/Scripts/pip install -r sidecar/requirements.txt
# model weights the spec bundles:
sidecar/.venv/Scripts/python -c "from beat_this.inference import File2Beats; File2Beats(device='cpu')"
sidecar/.venv/Scripts/python -c "from demucs.pretrained import get_model; get_model('htdemucs_6s')"
```

To also exercise the `--engine beatnet` path locally, add `BeatNet==1.1.3` in a
**Python 3.9** venv (it will not install on 3.10 — see `requirements.txt`).

Run it directly:

```sh
sidecar/.venv/Scripts/python sidecar/beat_detect.py --input some.wav --output out.json
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
fetches the Beat This! checkpoint and the htdemucs_6s weights into the torch hub
cache (so `beat_detect.spec` can bundle them), runs PyInstaller with `beat_detect.spec`, and stages the output
under `src-tauri/binaries/` before `tauri-action` builds the installer.
