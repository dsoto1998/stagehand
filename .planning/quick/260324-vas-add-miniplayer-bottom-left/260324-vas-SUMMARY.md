---
phase: quick
plan: 260324-vas
subsystem: ui
tags: [miniplayer, transport, ui, playback]
dependency_graph:
  requires: []
  provides: [miniplayer-transport, miniplayer-transpose-sync, miniplayer-master-vol-sync]
  affects: [renderer/index.html, renderer/style.css, renderer/js/ui-controller.js]
tech_stack:
  added: []
  patterns: [fixed-position overlay, bidirectional slider sync, CSS opacity/transform transition]
key_files:
  created: []
  modified:
    - renderer/index.html
    - renderer/style.css
    - renderer/js/ui-controller.js
decisions:
  - Miniplayer added to renderer/ multi-file app (not rehearsal-tool-v1.html)
  - CSS opacity+translateY transition for show/hide (no display:none needed)
  - showMiniplayer/hideMiniplayer/syncMiniplayerPlayBtn helpers at module top
  - pointer-events auto/none controls interaction; opacity controls visibility
metrics:
  duration: ~40m
  completed: "2026-03-25"
  tasks_completed: 1
  files_modified: 3
---

# Quick Task 260324-vas: Add Miniplayer Bottom-Left Summary

**One-liner:** Fixed-position miniplayer at bottom-left of the renderer app, with prev/play-pause/next transport, per-track transpose, and master volume — bidirectionally synced with library cards and sidebar.

## What Was Built

A `#miniplayer` fixed overlay at `bottom: 16px; left: 16px` in `renderer/index.html` that appears when any track starts playing and disappears when playback ends or the track is deleted.

### Features delivered

- **Track name display** — updates to match currently playing track name (accent color, truncated)
- **Transport controls** — Prev ⏮ / Play-Pause / Next ⏭ with wraparound through `tracks[]` array
- **Transpose slider** — reads current track's stored semitone value on show; bidirectionally syncs with the library card slider; persists changes to IndexedDB
- **Master volume fader** — bidirectionally syncs with the sidebar master volume slider; drives `setMasterVolume()`
- **Show/hide animation** — opacity + translateY CSS transition; `.visible` class toggled by JS

### Key integration points in ui-controller.js

| Signal | From | To | Via |
|--------|------|----|-----|
| Track starts playing | library card play button | `showMiniplayer(track.id)` | Added after `await player.play()` succeeds |
| Track pauses from library | library card play button | `syncMiniplayerPlayBtn(false)` | Added in pause branch |
| Track ends naturally | `player.onEnd` callback | `hideMiniplayer()` | Guard: `currentPlayingId === track.id` |
| Track deleted | delete button | `hideMiniplayer()` | Guard before `player.stop()` |
| Miniplayer transpose | `#mp-semitones` input | `player.setSemitones()` + card slider sync | mp-semitones handler |
| Library card transpose | `.track-semitones` input | miniplayer slider + label sync | Guard: `currentPlayingId === track.id` |
| Miniplayer master vol | `#mp-vol` input | `setMasterVolume()` + sidebar sync | mp-vol handler |
| Sidebar master vol | `#master-vol` input | miniplayer slider + label sync | Extended existing handler |

## Commit

`062167b` — feat(260324-vas): add miniplayer to renderer app (bottom-left)

## Self-Check: PASSED

- `renderer/index.html`, `renderer/style.css`, `renderer/js/ui-controller.js` modified and committed: `062167b`
- `id="miniplayer"` present in DOM
- CSS uses `--bg-panel`, `--border-bright`, `--accent`, `--cyan`, `--text-dim` — matching design system
- Verified working in browser at http://localhost:8080/renderer/index.html
- No JS errors (font glyph warnings and AudioContext autoplay warning are benign/expected)
