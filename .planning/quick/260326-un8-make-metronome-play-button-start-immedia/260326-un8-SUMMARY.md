---
phase: quick
plan: 260326-un8
subsystem: metronome
tags: [bug-fix, metronome, audio-timing]
key-files:
  modified:
    - renderer/js/metronome.js
decisions:
  - "Set nextNoteTime = c.currentTime in start() — first beat falls inside LOOKAHEAD window and fires on the initial synchronous scheduler() call"
metrics:
  duration: "< 5 minutes"
  completed: "2026-03-26"
  tasks: 1
  files: 1
---

# Quick Task 260326-un8: Remove metronome startup delay

One-liner: Removed the 100ms startup offset in metronome `start()` so the first click fires the instant the play button is pressed.

## What Was Done

Changed line 105 of `renderer/js/metronome.js` in the `start()` function:

```js
// Before
nextNoteTime = c.currentTime + 0.1;

// After
nextNoteTime = c.currentTime;
```

The lookahead scheduler's while-loop condition is `nextNoteTime < c.currentTime + LOOKAHEAD` (where `LOOKAHEAD = 0.1`). With `nextNoteTime` equal to `currentTime`, the first note is already inside the lookahead window, so it schedules immediately on the synchronous `scheduler()` call that happens before the `setInterval` is started.

## Tasks

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Remove startup delay in metronome start() | 10ad9b4 | renderer/js/metronome.js |

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Self-Check: PASSED

- renderer/js/metronome.js modified: confirmed
- Commit 10ad9b4: confirmed
