# Stagehand — Transpose Quality Improvement

## What This Is

Stagehand is a musician's rehearsal tool for playing along with recordings. The current v1 prototype is a single HTML file with audio library management, waveform display, playback, per-track transpose, and a metronome. This milestone replaces the custom OLA phase vocoder (which produces robotic, smeared artifacts) with Rubber Band WASM — a professional-grade pitch shifter — and splits the monolithic HTML into a proper multi-file structure as a step toward the long-term Electron target.

## Core Value

Musicians can transpose any track ±7 semitones and have it sound good enough to play along with in a real rehearsal.

## Requirements

### Validated

- ✓ Audio library (import WAV/MP3/FLAC/OGG, rename, delete, persist via IndexedDB) — existing
- ✓ Waveform display (canvas-rendered, amplitude-colored) — existing
- ✓ Playback (play/pause, seek, per-track volume) — existing
- ✓ Transpose slider (−12 to +12 semitones) — existing (poor quality)
- ✓ Metronome (BPM, tap tempo, subdivisions, click sound) — existing
- ✓ Master volume — existing

### Active

- [ ] Transpose audio quality is acceptable on full band mixes at ±7 semitones (no robotic/smeared artifacts)
- [ ] App loads and runs from a multi-file directory (index.html + separate assets + rubberband.wasm)
- [ ] All existing features continue to work after the restructure

### Out of Scope

- VST plugin panel — v2 milestone (UI stub only, not this milestone)
- Electron migration — v3 milestone (this restructure prepares for it but doesn't complete it)
- Time stretching (tempo-independent of pitch) — not requested
- Other audio quality improvements (EQ, noise reduction, etc.) — not requested

## Context

- **Current implementation:** Single file `rehearsal-tool-v1.html` with inline CSS/JS. Phase vocoder is a two-class OLA architecture (PhaseVocoderProcessor extends OLAProcessor) loaded as an AudioWorklet Blob URL. frameSize=2048, overlap=4, hopSize=512.
- **Known vocoder issues:** Robotic metallic quality, smeared transients, pitch instability — all characteristic of a basic phase vocoder without phase locking or transient preservation.
- **Target implementation:** [rubberband-web](https://github.com/mmckegg/rubberband-web) — Rubber Band Audio library compiled to WASM. Used in professional DAWs. Handles full-band mixes and percussive content well at ±7 semitones.
- **Target file structure:** Matches the Electron renderer layout from CLAUDE.md (`renderer/index.html`, `renderer/style.css`, `renderer/js/`, `wasm/rubberband.wasm` or similar).
- **Browser support:** Chrome and Firefox only (AudioWorklet requirement unchanged).

## Constraints

- **Browser:** Chrome and Firefox only — AudioWorklet + WASM both supported
- **No build step:** Keep deployable without a bundler (vanilla JS modules or inline scripts)
- **Preserve IndexedDB data:** Existing user audio libraries must not be broken by the restructure
- **Single developer:** Just David — no CI/CD, no review process

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Rubber Band over SoundTouch.js | Best quality for full-band mixes at ±7 semitones | — Pending |
| Multi-file structure over embedded WASM | Long-term Electron compatibility; cleaner than base64-encoding 1MB binary | — Pending |

---
*Last updated: 2026-03-23 after initialization*

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state
