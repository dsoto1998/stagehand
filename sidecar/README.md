# Stagehand beat-detection sidecar

`beat_detect.py` wraps [BeatNet](https://github.com/mjhydri/BeatNet) (CC BY 4.0)
to analyze one audio file and emit a beat-grid JSON descriptor consumed by the
Stagehand **Create Click Track** feature.

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
  "engine": "beatnet-dbn",
  "beats": [{ "t": 0.51, "pos": 1 }, { "t": 1.0, "pos": 2 }, ...],
  "numerator": 4,
  "tempoBpm": 120.0,
  "generatedAt": 1730000000000
}
```

`pos` is the 1-indexed beat position within the bar (`1` = downbeat).

## Local development

`madmom` and `BeatNet` only build on **Python 3.10**. From the repo root:

```sh
py -3.10 -m venv sidecar/.venv
sidecar/.venv/Scripts/pip install --index-url https://download.pytorch.org/whl/cpu torch
sidecar/.venv/Scripts/pip install -r sidecar/requirements.txt
```

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
runs PyInstaller with `beat_detect.spec`, and stages the output under
`src-tauri/binaries/` before `tauri-action` builds the installer.
