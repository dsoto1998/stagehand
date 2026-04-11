---
phase: quick
plan: 260410-udn
subsystem: ui
tags: [keyboard-shortcuts, settings-popup, ui-controller]
dependency_graph:
  requires: []
  provides: [keyboard-shortcuts, keyboard-shortcuts-reference]
  affects: [renderer/js/ui-controller.js, renderer/index.html, renderer/style.css]
tech_stack:
  added: []
  patterns: [document.addEventListener keydown, e.preventDefault, source.loop mutation]
key_files:
  created: []
  modified:
    - renderer/js/ui-controller.js
    - renderer/index.html
    - renderer/style.css
decisions:
  - L key toggles loopEnabled directly on player and mutates source.loop live (no mp-loop-btn in this worktree)
  - Space shortcut moved inside the non-input guard block for cleaner structure
metrics:
  duration: "~10 minutes"
  completed: "2026-04-10"
  tasks: 2
  files: 3
---

# Quick Task 260410-udn: Add 7 Keyboard Shortcuts and Keyboard Shortcuts Reference

**One-liner:** Seven new keyboard shortcuts wired into the existing keydown listener plus a styled shortcuts reference panel in the settings popup with kbd badge styling and scrollable overflow.

## What Was Built

### Task 1: Keyboard Shortcuts (renderer/js/ui-controller.js)

Added a new shortcut block inside the existing `document.addEventListener('keydown', ...)` listener, after the media key switch and before the Space handler.

New shortcuts:
- **Ctrl+F** — Focus the library search bar (works from anywhere, including inputs)
- **[** — Previous track (clicks mp-prev)
- **]** — Next track (clicks mp-next)
- **T** — Tap tempo (clicks mm-tap-btn)
- **M** — Start/stop metronome (clicks mm-play-btn)
- **L** — Toggle loop on currently playing track (mutates `player.loopEnabled` and `player.source.loop` live)
- **ArrowLeft / ArrowRight** — Seek ±5s on playing track (Shift modifier: ±15s)

All except Ctrl+F are guarded by an `inInput` check that blocks them when focus is in an INPUT, TEXTAREA, or contenteditable element.

### Task 2: Keyboard Shortcuts Reference (renderer/index.html + renderer/style.css)

Added a "Keyboard Shortcuts" section to the settings popup listing 14 shortcuts across 4 groups (Playback, Loop, Metronome, Library) with styled `<kbd>` badge elements.

CSS changes:
- Settings popup width: 240px → 280px
- Added `max-height: calc(100vh - 80px)` and `overflow-y: auto` for viewport-tall screens
- New rules: `.sp-shortcuts-list`, `.sp-shortcut-group`, `.sp-shortcut-row`, `.sp-keys`, `.sp-shortcut-row kbd`
- Thin dark webkit scrollbar for the popup

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | 2175a6e | feat(quick-260410-udn): add 7 keyboard shortcuts to keydown listener |
| 2 | 70f38fe | feat(quick-260410-udn): add Keyboard Shortcuts section to settings popup |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing functionality adaptation] L key implemented directly, not via mp-loop-btn click**

- **Found during:** Task 1 implementation
- **Issue:** The plan specifies `document.getElementById('mp-loop-btn').click()` for the L key, but `mp-loop-btn` does not exist in this worktree (it was added in a later main-branch commit, `177baea`). Calling `.click()` on null would throw a TypeError.
- **Fix:** Implemented L toggle directly: `player.loopEnabled = !player.loopEnabled; if (player.source) player.source.loop = player.loopEnabled;`. The `AudioBufferSourceNode.loop` property is live-mutable, so no restart is needed.
- **Files modified:** renderer/js/ui-controller.js
- **Commit:** 2175a6e

**2. [Rule 1 - Bug prevention] Space shortcut moved inside inInput guard**

- **Found during:** Task 1 implementation
- **Issue:** The original code had Space as the sole shortcut with its own `if (e.code !== 'Space') return;` early-exit. Inserting new shortcuts required restructuring. Space was moved inside the `!inInput` guard block, which is the correct behavior (Space shouldn't fire when typing).
- **Fix:** Removed the `if (e.code !== 'Space') return;` early exit and moved Space into the `!inInput` block.
- **Files modified:** renderer/js/ui-controller.js
- **Commit:** 2175a6e

**3. [Rule 2 - Omission] Loop I/O shortcut rows removed from reference panel**

- **Found during:** Task 2 implementation
- **Issue:** The plan's HTML snippet includes `<kbd>I</kbd>` (Set loop in point) and `<kbd>O</kbd>` (Set loop out point) shortcuts in the reference, but these I/O handlers don't exist in this worktree.
- **Fix:** Omitted the I/O shortcut rows from the settings popup to avoid documenting non-functional shortcuts. The Loop group shows only `L` (Toggle loop).
- **Files modified:** renderer/index.html

## Known Stubs

None — all implemented shortcuts are fully functional. The L key works (toggles loopEnabled + live source.loop mutation). Arrow seek works via `player.seek()`. The reference panel matches the implemented shortcuts.

## Self-Check: PASSED
