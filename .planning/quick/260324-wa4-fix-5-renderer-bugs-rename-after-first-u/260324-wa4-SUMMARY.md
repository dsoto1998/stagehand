---
phase: quick
plan: 260324-wa4
subsystem: renderer
tags: [bug-fix, indexeddb, rename, seek, transpose, miniplayer]
dependency_graph:
  requires: []
  provides: [rename-repeatability, meta-only-save, seek-time-display, transpose-debounce, prev-next-reset]
  affects: [renderer/js/ui-controller.js, renderer/js/track-player.js, renderer/js/library-manager.js]
tech_stack:
  added: []
  patterns: [saveMeta read-modify-write, named function instead of arguments.callee, debounce with clearTimeout/setTimeout]
key_files:
  created: []
  modified:
    - renderer/js/library-manager.js
    - renderer/js/ui-controller.js
    - renderer/js/track-player.js
decisions:
  - saveMeta uses read-then-write (get + put) instead of patch to keep IndexedDB schema consistent with existing put-based approach
  - Debounce timeout of 150ms chosen to feel snappy but avoid teardown on every slider tick
metrics:
  duration: ~8 minutes
  completed: 2026-03-25T04:17:49Z
  tasks_completed: 2
  files_modified: 3
---

# Quick Task 260324-wa4: Fix 5 Renderer Bugs Summary

**One-liner:** Fixed track rename repeatability (arguments.callee in ES module), ArrayBuffer excluded from slider-tick saves via read-modify-write saveMeta, seek time display corrected to pass `t` to onProgress, transpose restart debounced 150ms, and prev/next miniplayer buttons now reset pauseOffset to 0.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Fix library-manager saveMeta + ui-controller rename and save bugs | 88ebd64 | library-manager.js, ui-controller.js |
| 2 | Fix track-player seek display and transpose debounce | 5b04a08 | track-player.js |

## Bug Fixes Applied

### Bug 1 — Rename after first use (ui-controller.js)

**Root cause:** The outer rename click listener was an arrow function. Inside `commit()`, `arguments.callee` referenced the outer arrow function, which throws `TypeError` in strict mode (ES modules). After the first rename, the second rename click had no listener attached.

**Fix:** Replaced the anonymous arrow + `arguments.callee` pattern with a named `startRename` function. After commit, `nameNew.addEventListener('click', startRename)` re-attaches the named reference. Works indefinitely.

### Bug 2 — ArrayBuffer written on every slider tick (library-manager.js, ui-controller.js)

**Root cause:** `saveTrackMeta` called `LibraryManager.save(track)`, which did a full `put()` including the in-memory `arrayBuffer`. On slider tick, the structured clone algorithm attempted to transfer the live ArrayBuffer, causing unnecessary data writes and risking buffer detachment.

**Fix:** Added `saveMeta(meta)` to library-manager.js — opens a readwrite transaction, reads the existing record with `objectStore.get(id)`, merges fields with `Object.assign(existing, meta)`, and puts back. The stored arrayBuffer is never touched. `saveTrackMeta` now destructures arrayBuffer out before calling `saveMeta`.

### Bug 3 — Seek time display when paused (track-player.js)

**Root cause:** In `seek()`, the `else` branch (paused path) called `this.onProgress(fraction)` with only one argument. The callback signature is `(fraction, timeInSeconds)`. The time display element was receiving `undefined` for `t`, so `formatTime(undefined)` returned `0:00`.

**Fix:** Changed to `this.onProgress(fraction, t)` — `t` is already computed as `fraction * this.duration` on the line above.

### Bug 4 — Transpose glitch on every slider tick (track-player.js)

**Root cause:** `setSemitones(s)` immediately called `this.play(this.currentTime)` when playing, tearing down the entire audio graph (source, pitchNode, gainNode) and rebuilding it on every `input` event — typically 10-20 times per second while dragging.

**Fix:** Replaced with a debounced restart: `clearTimeout(this._semitoneDebounce)` followed by `setTimeout(() => { if (this.isPlaying) this.play(this.currentTime); }, 150)`. The graph only rebuilds 150ms after the last slider movement.

### Bug 5 — Prev/next miniplayer starts mid-track (ui-controller.js)

**Root cause:** The mp-prev and mp-next handlers clicked the play button on the target card without resetting the player's `pauseOffset`. If that track had been played before and paused partway through, it would resume from its last position instead of 0:00.

**Fix:** Before clicking play, `targetPlayer.pauseOffset = 0` is set so `play()` starts from the beginning.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Self-Check

### Files exist
- renderer/js/library-manager.js: FOUND
- renderer/js/ui-controller.js: FOUND
- renderer/js/track-player.js: FOUND

### Commits exist
- 88ebd64: FOUND
- 5b04a08: FOUND

## Self-Check: PASSED
