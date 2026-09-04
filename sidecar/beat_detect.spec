# PyInstaller spec for the Stagehand beat-detection sidecar.
#
# Build (from repo root, inside the Python 3.10 venv):
#   pyinstaller sidecar/beat_detect.spec --noconfirm --distpath sidecar/dist --workpath sidecar/build
#
# Produces sidecar/dist/beat_detect/beat_detect.exe  (+ _internal/).
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

# BeatNet bundles its pretrained CRNN weights (models/*.pt) as package data.
datas += collect_data_files("BeatNet")
hiddenimports += collect_submodules("BeatNet")

# librosa / soundfile / sklearn runtime data + libs.
datas += collect_data_files("librosa")
datas += collect_data_files("soundfile")
binaries += collect_dynamic_libs("soundfile")
hiddenimports += collect_submodules("sklearn")
hiddenimports += ["sklearn.utils._typedefs", "sklearn.neighbors._partition_nodes"]

# torch CPU runtime.
binaries += collect_dynamic_libs("torch")
hiddenimports += ["torch"]

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
coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="beat_detect",
)
