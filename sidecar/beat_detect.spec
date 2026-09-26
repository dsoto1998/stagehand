# PyInstaller spec for the Stagehand beat-detection sidecar.
#
# Build (from repo root, inside the Python 3.10 venv):
#   pyinstaller sidecar/beat_detect.spec --noconfirm --distpath sidecar/dist --workpath sidecar/build
#
# Produces sidecar/dist/beat_detect/beat_detect.exe + stem_separate.exe, sharing
# one _internal/ (torch is ~2.6GB — two separate bundles would ship it twice).
# The release workflow renames the folder to the Tauri sidecar triple and copies
# it under src-tauri/binaries/.

import os

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules

SCRIPT = os.path.join(SPECPATH, "beat_detect.py")

datas = []
binaries = []
hiddenimports = []

# madmom ships compiled Cython extensions whose transitive imports PyInstaller
# cannot follow; pull the whole package in explicitly.
hiddenimports += collect_submodules("madmom")
hiddenimports += [
    "madmom.processors",
    "madmom.ml.hmm",
    "madmom.features.beats",
    "madmom.features.beats_hmm",
    "madmom.features.downbeats",
    "madmom.audio.signal",
    "madmom.audio.spectrogram",
    "madmom.audio.filters",
    "madmom.audio.stft",
]
datas += collect_data_files("madmom")

# BeatNet is an optional local-only engine (not installable on Python 3.10 — it
# pins numba==0.54.1). Bundle its weights + submodules only if it happens to be
# present; the frozen build the app ships never uses it.
try:
    import BeatNet  # noqa: F401
    datas += collect_data_files("BeatNet")
    hiddenimports += collect_submodules("BeatNet")
except Exception:
    pass

# Beat This! (the default engine). Its checkpoint is normally fetched from the
# network on first use and cached under ~/.cache/torch/hub/checkpoints — no good
# in a frozen build, which must work offline and cannot rely on a user cache.
# Bundle the weights and resolve them locally at runtime (see run_beat_this).
hiddenimports += collect_submodules("beat_this")
datas += collect_data_files("beat_this")

_BT_CKPT = os.path.join(
    os.path.expanduser("~"), ".cache", "torch", "hub", "checkpoints",
    "beat_this-final0.ckpt",
)
if os.path.exists(_BT_CKPT):
    datas += [(_BT_CKPT, "beat_this_checkpoints")]
else:
    raise SystemExit(
        f"Beat This checkpoint not found at {_BT_CKPT}.\n"
        "Fetch it once before freezing, e.g.:\n"
        "  python -c \"from beat_this.inference import File2Beats; File2Beats(device='cpu')\""
    )

# librosa / soundfile / sklearn runtime data + libs.
datas += collect_data_files("librosa")
datas += collect_data_files("soundfile")
binaries += collect_dynamic_libs("soundfile")
hiddenimports += collect_submodules("sklearn")
hiddenimports += ["sklearn.utils._typedefs", "sklearn.neighbors._partition_nodes"]

# torch CPU runtime.
binaries += collect_dynamic_libs("torch")
hiddenimports += ["torch"]

# ── stem_separate (guitar removal, Demucs htdemucs_6s) ──────────────────────
# Same story as Beat This!: the weights are normally downloaded on first use.
# Fetch once before freezing:
#   python -c "from demucs.pretrained import get_model; get_model('htdemucs_6s')"
STEM_SCRIPT = os.path.join(SPECPATH, "stem_separate.py")
stem_datas = []
stem_hiddenimports = [
    "demucs.apply", "demucs.htdemucs", "demucs.hdemucs", "demucs.demucs",
    "demucs.transformer", "demucs.spec", "demucs.states", "demucs.utils",
    "openunmix.filtering", "julius",
]
_DEMUCS_TH = os.path.join(
    os.path.expanduser("~"), ".cache", "torch", "hub", "checkpoints",
    "5c90dfd2-34c22ccb.th",
)
if os.path.exists(_DEMUCS_TH):
    stem_datas += [(_DEMUCS_TH, "demucs_models")]
else:
    raise SystemExit(
        f"htdemucs_6s weights not found at {_DEMUCS_TH}.\n"
        "Fetch them once before freezing, e.g.:\n"
        "  python -c \"from demucs.pretrained import get_model; get_model('htdemucs_6s')\""
    )

block_cipher = None

a = Analysis(
    [SCRIPT],
    pathex=[SPECPATH],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # NOTE: pyaudio is NOT excluded — BeatNet imports it unconditionally at module
    # load (for its streaming mode) even though beat_detect.py only uses offline
    # mode. Excluding it breaks `import BeatNet` in the frozen build too.
    # Do NOT try to shrink the bundle by excluding torch subpackages. torch is
    # ~2.6GB of it and the temptation is obvious, but every attempt measured
    # here broke the frozen binary at runtime while the BUILD STILL SUCCEEDED:
    #
    #   torch.distributed  -> "No module named 'torch.distributed'"
    #   torch.testing      -> "No module named 'torch.testing'"
    #
    # torch pulls these in during `import torch` itself. A successful build
    # proves nothing; only running the frozen exe against a real track does.
    # Shrinking this bundle needs a different approach (exporting the model to
    # ONNX and dropping the torch runtime), not exclusion.
    excludes=["tkinter", "matplotlib", "PyQt5", "PySide2", "IPython"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="beat_detect",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
stem_a = Analysis(
    [STEM_SCRIPT],
    pathex=[SPECPATH],
    binaries=collect_dynamic_libs("torch") + collect_dynamic_libs("soundfile"),
    datas=stem_datas + collect_data_files("soundfile"),
    hiddenimports=stem_hiddenimports + ["torch"],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "PyQt5", "PySide2", "IPython"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
stem_pyz = PYZ(stem_a.pure, stem_a.zipped_data, cipher=block_cipher)
stem_exe = EXE(
    stem_pyz,
    stem_a.scripts,
    [],
    exclude_binaries=True,
    name="stem_separate",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

# One output folder for both executables; COLLECT de-duplicates the shared
# torch/numpy/soundfile files by destination path.
coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    stem_exe,
    stem_a.binaries,
    stem_a.zipfiles,
    stem_a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="beat_detect",
)
