"""
stem_separate — Stagehand guitar-removal sidecar.

Runs Demucs v4 `htdemucs_6s` (the 6-stem model: drums/bass/other/vocals/guitar/
piano) on one audio file and writes ONLY the guitar stem, sample-aligned with
the input (same sample rate, same channel count, same length). The app plays
`original - (1 - g) * guitar` so g=1 is bit-identical to the recording and g=0
removes the guitar, without storing a separate backing track.

Usage:
    stem_separate --input <wav> --output <flac> [--device auto|cpu|cuda]
                  [--torch-dir <dir>] [--model <.th>]

--torch-dir points at an extracted CUDA torch wheel (the in-app "GPU pack").
When given, `torch` is imported from there instead of the CPU torch frozen into
this build — see use_external_torch().

Progress is written to stdout as one JSON object per line, e.g.
    {"stage": "loading"}
    {"stage": "separating", "progress": 0.42, "device": "cuda"}
    {"stage": "done", "device": "cuda", "seconds": 38.2}

On failure: a human-readable message on stderr and a non-zero exit code.
"""

import argparse
import importlib.machinery
import json
import os
import sys
import time

MODEL_FILE = "5c90dfd2-34c22ccb.th"  # htdemucs_6s (single-model bag)
GUITAR = "guitar"


def log(**kw):
    sys.stdout.write(json.dumps(kw) + "\n")
    sys.stdout.flush()


class _ExternalTorchFinder:
    """meta_path finder that resolves torch (and its sibling top-level packages)
    from an external directory. Must sit AHEAD of PyInstaller's FrozenImporter,
    which would otherwise serve the bundled CPU torch from the PYZ archive no
    matter what sys.path says."""

    PREFIXES = ("torch", "functorch", "torchgen")

    def __init__(self, root):
        self.root = root

    def find_spec(self, fullname, path=None, target=None):
        top = fullname.split(".", 1)[0]
        if top not in self.PREFIXES:
            return None
        search = [self.root] if path is None else path
        return importlib.machinery.PathFinder.find_spec(fullname, search)


def use_external_torch(torch_dir):
    if "torch" in sys.modules:
        raise RuntimeError("torch imported before --torch-dir could take effect")
    if not os.path.isdir(os.path.join(torch_dir, "torch")):
        raise RuntimeError(f"no torch package in {torch_dir}")
    sys.path.insert(0, torch_dir)
    sys.meta_path.insert(0, _ExternalTorchFinder(torch_dir))


def default_model_path():
    bundle = getattr(sys, "_MEIPASS", None)
    candidates = []
    if bundle:
        candidates.append(os.path.join(bundle, "demucs_models", MODEL_FILE))
    candidates.append(os.path.join(os.path.expanduser("~"), ".cache", "torch", "hub", "checkpoints", MODEL_FILE))
    for c in candidates:
        if os.path.exists(c):
            return c
    raise RuntimeError(f"htdemucs_6s weights ({MODEL_FILE}) not found")


def load_model(path):
    """Equivalent of demucs.states.load_model, minus its dora/omegaconf imports."""
    import inspect
    import torch

    package = torch.load(path, map_location="cpu", weights_only=False)
    klass = package["klass"]
    kwargs = {k: v for k, v in package["kwargs"].items() if k in inspect.signature(klass).parameters}
    model = klass(*package["args"], **kwargs)
    model.load_state_dict(package["state"])
    model.eval()
    return model


def patch_progress(device):
    """demucs.apply drives its chunk loop through tqdm.tqdm(futures, ...) when
    progress=True; swap in a shim that reports fractions as JSON lines."""
    import demucs.apply as apply_mod

    class _Shim:
        @staticmethod
        def tqdm(iterable, **_kw):
            items = list(iterable)
            n = max(1, len(items))
            last = 0.0  # separate() already reported 0.0
            for i, item in enumerate(items):
                frac = round(i / n, 2)
                if frac - last >= 0.02:
                    log(stage="separating", progress=frac, device=device)
                    last = frac
                yield item

    apply_mod.tqdm = _Shim


def separate(inp, out, device_pref, model_path):
    import numpy as np
    import soundfile as sf
    import torch
    import julius
    from demucs.apply import apply_model

    log(stage="loading")
    data, sr = sf.read(inp, always_2d=True, dtype="float32")  # (frames, ch)
    frames, channels = data.shape
    if channels not in (1, 2):
        raise RuntimeError(f"unsupported channel count {channels} (mono/stereo only)")

    if device_pref == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    else:
        device = device_pref

    model = load_model(model_path)
    if GUITAR not in model.sources:
        raise RuntimeError(f"model has no guitar stem ({model.sources})")

    wav = torch.from_numpy(data.T.copy())  # (ch, frames)
    if channels == 1:
        wav = wav.repeat(2, 1)
    if sr != model.samplerate:
        wav = julius.resample_frac(wav, sr, model.samplerate)

    # Demucs' reference normalisation (demucs/separate.py).
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    wav = (wav - mean) / std

    patch_progress(device)
    log(stage="separating", progress=0.0, device=device)
    with torch.no_grad():
        sources = apply_model(model, wav[None], device=device, shifts=1, split=True,
                              overlap=0.25, progress=True, num_workers=0)[0]
    guitar = sources[model.sources.index(GUITAR)] * std + mean  # (2, frames@model_sr)
    # `mean` was subtracted from every stem; the stems sum to the mix, so only
    # 1/N of it belongs to each. Remove the rest so original - guitar has no DC.
    guitar = guitar - mean * (1 - 1 / len(model.sources))

    if sr != model.samplerate:
        guitar = julius.resample_frac(guitar, model.samplerate, sr)
    guitar = guitar.cpu()
    if channels == 1:
        guitar = guitar.mean(0, keepdim=True)
    g = guitar.numpy().T  # (frames, ch)
    if g.shape[0] >= frames:
        g = g[:frames]
    else:
        g = np.pad(g, ((0, frames - g.shape[0]), (0, 0)))

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    tmp = out + ".part"
    sf.write(tmp, np.clip(g, -1.0, 1.0), sr, format="FLAC", subtype="PCM_24")
    os.replace(tmp, out)
    return device


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", help="WAV to separate (decoded by the app)")
    ap.add_argument("--output", help="guitar stem FLAC to write")
    ap.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    ap.add_argument("--torch-dir", default=None, help="external (CUDA) torch to import instead of the bundled one")
    ap.add_argument("--model", default=None, help="htdemucs_6s .th weights (default: bundled)")
    ap.add_argument("--probe", action="store_true", help="print torch/CUDA info as JSON and exit")
    args = ap.parse_args()
    if not args.probe and not (args.input and args.output):
        ap.error("--input and --output are required (unless --probe)")

    try:
        if args.torch_dir:
            use_external_torch(args.torch_dir)
        if args.probe:
            import torch
            cuda = torch.cuda.is_available()
            log(stage="probe", torch=torch.__version__, cuda=cuda,
                gpu=torch.cuda.get_device_name(0) if cuda else None, torch_file=torch.__file__)
            return 0
        t0 = time.time()
        device = separate(args.input, args.output, args.device, args.model or default_model_path())
        log(stage="done", device=device, seconds=round(time.time() - t0, 1))
        return 0
    except Exception as e:  # noqa: BLE001 — surface everything to the app
        sys.stderr.write(f"{type(e).__name__}: {e}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
