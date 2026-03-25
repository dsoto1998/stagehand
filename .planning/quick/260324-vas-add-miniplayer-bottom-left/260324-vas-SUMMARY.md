---
phase: quick
plan: 260324-vas
subsystem: ui
tags: [miniplayer, transport, ui, playback]
dependency_graph:
  requires: []
  provides: [miniplayer-transport, miniplayer-transpose-sync, miniplayer-master-vol-sync]
  affects: [rehearsal-tool-v1.html]
tech_stack:
  added: []
  patterns: [fixed-position overlay, bidirectional slider sync, IIFE module pattern]
key_files:
  created: []
  modified:
    - rehearsal-tool-v1.html
decisions:
  - used requestAnimationFrame + style.display trick for CSS transition on display:none elements
  - playTrackById() helper centralizes prev/next logic and rewires card onProgress/onEnd callbacks
  - Miniplayer module defined before INIT section so all event closures have access at fire time
metrics:
  duration: ~25m
  completed: "2026-03-24"
  tasks_completed: 1
  files_modified: 1
---

# Quick Task 260324-vas: Add Miniplayer Bottom-Left Summary

**One-liner:** Fixed-position miniplayer with prev/play-pause/next transport, per-track transpose, and master volume — bidirectionally synced with library cards and sidebar.

## What Was Built

A `#miniplayer` fixed overlay at `bottom: 16px; left: 16px` that appears when any track starts playing and disappears when playback ends or the track is deleted.

### Features delivered

- **Track name display** — updates to match currently playing track name
- **Transport controls** — prev/play-pause/next buttons with wrapping navigation through `tracks[]` array
- **Transpose slider** — reads current track's stored semitone value on show; bidirectionally syncs with the library card slider; persists changes to IndexedDB
- **Master volume fader** — bidirectionally syncs with the sidebar master volume slider; drives `AudioEngine.setMasterVolume()`
- **Show/hide animation** — opacity + translateY transition with `display:none` toggle via rAF trick

### Key integration points

| Signal | From | To | Via |
|--------|------|----|-----|
| Track starts playing | library card `playBtn` click | `Miniplayer.show(track.id)` | Added after `player.play()` succeeds |
| Track pauses from library | library card `playBtn` | `Miniplayer.updatePlayState(false)` | Added in pause branch |
| Track ends naturally | `player.onEnd` callback | `Miniplayer.hide()` | Added in `onEnd` |
| Track deleted | `delBtn` click | `Miniplayer.hide()` | Checked before `player.stop()` |
| Miniplayer transpose | `#mp-transpose` input | `player.setSemitones()` + card slider sync | `mp-transpose` event handler |
| Library card transpose | `.track-semitones` input | `Miniplayer.syncTranspose()` | Added `if (currentPlayingId === track.id)` guard |
| Miniplayer master vol | `#mp-master-vol` input | `AudioEngine.setMasterVolume()` + sidebar sync | `mp-master-vol` event handler |
| Sidebar master vol | `#master-vol` input | miniplayer slider + label sync | Extended existing handler |

## Deviations from Plan

None — plan executed exactly as written. The `show()` implementation uses `el().style.display = 'block'` then `requestAnimationFrame(() => el().classList.add('visible'))` instead of just CSS classes, which is needed because `display: none` prevents CSS transitions from running. The plan described this pattern as acceptable.

## Known Stubs

None. All controls are wired to real audio engine state.

## Self-Check: PASSED

- `rehearsal-tool-v1.html` modified and committed: `cdb679c`
- `id="miniplayer"` present in DOM output
- CSS uses `--bg-panel`, `--border-bright`, `--accent`, `--cyan`, `--text-dim` — matching design system
- `currentPlayingId` global tracks playing state across all integration points
- `Miniplayer` IIFE defined before `init()` call — no hoisting issues
