---
phase: 01-file-restructure
plan: 01
subsystem: ui
tags: [html, css, es-modules, indexeddb, web-audio, audio-worklet]

# Dependency graph
requires: []
provides:
  - renderer/ directory with index.html and style.css
  - renderer/js/audio-engine.js: AudioContext singleton (getCtx, resume, getMaster, setMasterVolume)
  - renderer/js/library-manager.js: IndexedDB CRUD (all, save, remove, genId) — stagehand_db schema unchanged
  - renderer/js/phaze-worklet.js: OLA phase vocoder AudioWorkletProcessor standalone file
  - renderer/js/waveform.js: canvas waveform renderer (renderWaveform)
  - wasm/ directory with .gitkeep placeholder for Phase 2
affects: [01-02, 02-rubberband-integration]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - ES module exports for all JS modules (no window globals, no IIFEs)
    - phaze-worklet.js loaded via addModule path (not Blob URL) in Plan 02
    - AudioWorklet processor file has no import/export (AudioWorklet scope restriction)

key-files:
  created:
    - renderer/index.html
    - renderer/style.css
    - renderer/js/audio-engine.js
    - renderer/js/library-manager.js
    - renderer/js/phaze-worklet.js
    - renderer/js/waveform.js
    - wasm/.gitkeep
  modified: []

key-decisions:
  - "CSS extracted verbatim from monolith lines 8-721 — no reformatting to preserve exact visual output"
  - "phaze-worklet.js has no import/export statements — AudioWorklet scope requires standalone file"
  - "library-manager.js open() kept as internal function, not exported — lazy open on first use pattern"
  - "Three phaze bug fixes preserved: parameters['pitchFactor'] (not .get), _outWritePtr=frameSize-1, nCh=_numChannels"

patterns-established:
  - "ES module pattern: each JS file exports its public API; consumers import what they need"
  - "AudioWorklet files: no import/export, standalone, loaded via addModule('./js/phaze-worklet.js')"

requirements-completed: [STRUCT-01, STRUCT-03]

# Metrics
duration: 4min
completed: 2026-03-24
---

# Phase 01 Plan 01: File Structure Foundation Summary

**Multi-file renderer layout created with CSS (714 lines), clean HTML shell, and 4 independent ES modules extracted verbatim from the monolith**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-24T18:01:18Z
- **Completed:** 2026-03-24T18:05:00Z
- **Tasks:** 2
- **Files created:** 7

## Accomplishments

- Created renderer/ directory layout matching the Electron target structure from CLAUDE.md
- Extracted all 714 lines of CSS verbatim into renderer/style.css with @import, :root variables, and all component styles intact
- Created clean HTML shell (renderer/index.html) with only a link tag for CSS and a single module script tag for ui-controller.js
- Extracted 4 independent JS modules: audio-engine, library-manager, phaze-worklet, waveform — all with correct ES module exports
- Preserved all 3 critical phaze worklet bug fixes documented in CLAUDE.md
- Created wasm/.gitkeep placeholder directory ready for Phase 2 rubberband.wasm

## Task Commits

Each task was committed atomically:

1. **Task 1: Create directory structure, extract CSS and HTML shell** - `dd3020b` (feat)
2. **Task 2: Extract independent JS modules** - `8f27c6e` (feat)

**Plan metadata:** (docs commit — to be added)

## Files Created/Modified

- `renderer/index.html` - Clean HTML shell: loads style.css via link tag, ui-controller.js via module script
- `renderer/style.css` - All CSS extracted from monolith verbatim (714 lines)
- `renderer/js/audio-engine.js` - AudioContext singleton with 4 named exports
- `renderer/js/library-manager.js` - IndexedDB CRUD with stagehand_db schema, open() internal only
- `renderer/js/phaze-worklet.js` - OLA phase vocoder standalone worklet file, no import/export
- `renderer/js/waveform.js` - Canvas waveform renderer, single named export
- `wasm/.gitkeep` - Empty placeholder for Phase 2 wasm binary

## Decisions Made

- Extracted CSS verbatim with no reformatting — preserves exact visual output, reduces risk of regression
- phaze-worklet.js contains only processor code (no import/export) — required by AudioWorklet scope which has no module system
- library-manager.js open() is not exported — it is an internal implementation detail called lazily by all, save, remove
- All three phaze worklet bug fixes from CLAUDE.md were explicitly verified as preserved: `parameters['pitchFactor']` (not `.get()`), `_outWritePtr = this._frameSize - 1` (not 0), `const nCh = this._numChannels` (not `inp.length`)

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Plan 01-02 can now proceed: it needs to extract track-player.js, metronome.js, and ui-controller.js — the remaining 3 modules that depend on the 4 modules created here
- phaze-worklet.js is in place at `renderer/js/phaze-worklet.js` — Plan 01-02's track-player.js will call `ctx.audioWorklet.addModule('./js/phaze-worklet.js')` instead of the current Blob URL approach
- wasm/ directory exists and is ready for Phase 2's rubberband.wasm binary

---
*Phase: 01-file-restructure*
*Completed: 2026-03-24*

## Self-Check: PASSED

All 7 created files exist on disk. Both task commits (dd3020b, 8f27c6e) found in git log.
