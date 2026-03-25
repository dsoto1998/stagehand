---
phase: 01-file-restructure
plan: 02
subsystem: ui
tags: [es-modules, audio-worklet, web-audio, track-player, metronome, ui-wiring]

# Dependency graph
requires:
  - phase: 01-file-restructure plan 01
    provides: audio-engine.js, library-manager.js, phaze-worklet.js, waveform.js, renderer/index.html, renderer/style.css
provides:
  - renderer/js/track-player.js — TrackPlayer class, players map, ensurePhazeWorklet function, file-based worklet loading
  - renderer/js/metronome.js — Metronome scheduler, TapTempo, lookahead click scheduling
  - renderer/js/ui-controller.js — Top-level ES module entry point, all DOM event wiring, init sequence
  - Fully working multi-file app at renderer/index.html with all features verified by human
affects: [02-rubber-band-integration]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Top-level ES module entry point: ui-controller.js wires all modules to DOM via named imports"
    - "AudioWorklet loaded via file path (addModule('./js/phaze-worklet.js')) not Blob URL"
    - "TrackPlayer and Metronome exported as named class/object from their modules"
    - "Module-scope state: players map, tracks array, taps array declared at module level"
    - "Async IIFE at bottom of ui-controller.js for app initialization"

key-files:
  created:
    - renderer/js/track-player.js
    - renderer/js/metronome.js
    - renderer/js/ui-controller.js
  modified: []

key-decisions:
  - "ensurePhazeWorklet loads worklet via file path (not Blob URL) — errors propagate visibly to console instead of being swallowed silently"
  - "No try/catch around audioWorklet.addModule — if worklet fails to load, the error surfaces immediately"
  - "ui-controller.js uses namespace import for LibraryManager (import * as LibraryManager) for call-site clarity"

patterns-established:
  - "AudioWorklet loading: addModule with relative file path, guarded by a module-scope boolean flag"
  - "Module entry point pattern: ui-controller.js as <script type=module> in index.html; no globals"

requirements-completed: [STRUCT-01, STRUCT-02, STRUCT-03]

# Metrics
duration: ~25min (continuation session)
completed: 2026-03-24
---

# Phase 01 Plan 02: File Restructure — Track Player, Metronome, and Entry Point Summary

**TrackPlayer class, Metronome scheduler, and ui-controller.js entry point extracted from monolith into ES modules — full multi-file app verified working by human with all features intact**

## Performance

- **Duration:** ~25 min (continuation session after checkpoint)
- **Started:** 2026-03-24T22:45:00Z (estimated)
- **Completed:** 2026-03-24T23:35:17Z
- **Tasks:** 3 (2 auto + 1 human-verify)
- **Files modified:** 3 created

## Accomplishments

- Extracted `TrackPlayer` class and `ensurePhazeWorklet` function into `renderer/js/track-player.js`, replacing Blob URL worklet loading with a clean file-path `addModule` call
- Extracted `Metronome` and `TapTempo` from IIFEs into exported objects in `renderer/js/metronome.js`, preserving the lookahead scheduler pattern intact
- Created `renderer/js/ui-controller.js` as the top-level ES module entry point — imports all 5 other modules and wires all DOM event bindings and the init sequence
- Human verified: all features (library, waveform, playback, volume, transpose, metronome, persistence, rename, delete) work identically to the monolith

## Task Commits

Each task was committed atomically:

1. **Task 1: Extract track-player.js and metronome.js** - `6d95127` (feat)
2. **Task 2: Create ui-controller.js top-level entry point** - `29558c1` (feat)
3. **Task 3: Verify restructured app works identically to monolith** - human-verified, approved

## Files Created/Modified

- `renderer/js/track-player.js` — TrackPlayer class, players map, ensurePhazeWorklet; imports audio-engine.js
- `renderer/js/metronome.js` — Metronome and TapTempo exported objects; lookahead scheduler; imports audio-engine.js
- `renderer/js/ui-controller.js` — Top-level entry point; imports all 5 modules; all DOM event wiring; init IIFE

## Decisions Made

- `ensurePhazeWorklet` uses `addModule('./js/phaze-worklet.js')` with no try/catch — fail-visible is safer than fail-silent (the old Blob URL approach swallowed errors)
- `LibraryManager` uses namespace import (`import * as LibraryManager`) to keep call sites (`LibraryManager.save()`, etc.) self-documenting
- `players` map exported from `track-player.js` so ui-controller can reference it without a separate state module

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 01 (File Restructure) is complete. All 2 plans done.
- `renderer/` directory contains: `index.html`, `style.css`, 7 JS modules, `wasm/` directory
- Phase 02 (Rubber Band Integration) can begin: the WASM binary delivery location (`wasm/`) is in place; the worklet loading pattern is established in `track-player.js`
- Blocker to verify before starting Phase 02: confirm `rubberband-web` (mmckegg/rubberband-web) npm package is available and its `.wasm` binary can be loaded via AudioWorklet in Chrome and Firefox

---
*Phase: 01-file-restructure*
*Completed: 2026-03-24*
