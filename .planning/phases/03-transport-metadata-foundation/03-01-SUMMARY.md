---
phase: 03-transport-metadata-foundation
plan: 01
subsystem: miniplayer-transport
tags: [scrub-bar, progress, seek, time-display, auto-play, aria]
dependency_graph:
  requires: []
  provides: [miniplayer-scrub-bar, miniplayer-time-display, miniplayer-seek, auto-play-first-track]
  affects: [renderer/js/ui-controller.js, renderer/index.html, renderer/style.css]
tech_stack:
  added: []
  patterns: [document-level-mousemove-mouseup, seeking-guard-pattern, onProgress-wrapping]
key_files:
  created: []
  modified:
    - renderer/index.html
    - renderer/style.css
    - renderer/js/ui-controller.js
decisions:
  - "Document-level mousemove/mouseup listeners for scrub drag: prevents stuck drag when cursor leaves bar"
  - "seeking flag guards fill-width update only (not time display): time display updates during drag, fill does not fight drag position"
  - "Extend player.onProgress in-place in buildTrackCard rather than replacing: avoids losing card progress bar update"
  - "Auto-play uses localeCompare sort on track.name: consistent alphabetical ordering"
metrics:
  duration: 2m
  completed_date: "2026-03-25"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 3
---

# Phase 03 Plan 01: Scrub Bar, Time Display, and Auto-Play Summary

**One-liner:** Scrubbable miniplayer progress bar with elapsed/total time display and auto-play-first-track via document-level mouse handlers and onProgress wrapping.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add scrub bar and time display HTML + CSS | dabbf7a | renderer/index.html, renderer/style.css |
| 2 | Wire scrub interaction, onProgress, and TRANS-04 auto-play | 2fa9eae | renderer/js/ui-controller.js |

## What Was Built

### Task 1: HTML + CSS
- Inserted `#mp-scrub-bar` (with nested `#mp-scrub-fill`) between `#mp-track-name` and `#mp-transport` in the miniplayer
- Inserted `#mp-time-display` showing `0:00 / --:--` as default state
- Added `aria-label` attributes to `#mp-prev`, `#mp-play`, `#mp-next` transport buttons
- CSS: 20px hit-target scrub bar with 3px accent-colored track (via `::before`), 13px circular thumb (via `#mp-scrub-fill::after`)
- CSS: Time display in JetBrains Mono 10px, `var(--text-secondary)`, centered

### Task 2: JavaScript Logic
- `seeking` + `seekFrac` module-level state variables for drag tracking
- `updateMiniplayerProgress(frac, t, duration)`: updates fill width (guarded by `!seeking`) and time display always
- Extended `player.onProgress` in `buildTrackCard` to call `updateMiniplayerProgress` when track is the currently playing one
- `mpScrubBar.mousedown` → sets `seeking = true`, captures initial position, attaches `mousemove`/`mouseup` to `document`
- `onScrubUp` → removes both listeners, sets `seeking = false`, calls `player.seek(seekFrac)`
- `showMiniplayer` updated: resets fill to 0%, sets time display with actual total duration, sets aria-label="Pause"
- `hideMiniplayer` updated: resets fill to 0%, resets time display to `0:00 / --:--`, sets aria-label="Play"
- `syncMiniplayerPlayBtn` updated: toggles aria-label between "Play" and "Pause"
- mp-play click handler: when `!currentPlayingId`, sorts tracks by `localeCompare` and clicks first card's play button; no-ops if library empty

## Requirements Satisfied

- TRANS-01: Progress bar visible and moves during playback
- TRANS-02: Elapsed/total time displayed below scrub bar
- TRANS-03: Scrub bar seek works on mouse-up (not during drag)
- TRANS-04: Play with no track loaded starts first alphabetical track

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — all functionality is fully wired. The "Coming Soon" text in the sidebar nav section (line 37 of index.html) is pre-existing navigation UI for future features unrelated to this plan.

## Self-Check: PASSED
