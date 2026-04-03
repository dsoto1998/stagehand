---
phase: quick
plan: 260403-klh
subsystem: ui
tags: [metronome, miniplayer, sidebar, css, animation]

requires: []
provides:
  - Beat position dot row in metronome panel — animates on each beat, count tracks time signature
  - TAP button full-width below BPM row
  - BPM display single-click inline edit
  - Combined time signature + subdivision select row
  - Speed warning text near speed slider when speed != 1x
  - Loop button in its own row between time display and loop times
affects: [metronome, miniplayer, ui-controller]

tech-stack:
  added: []
  patterns:
    - "renderBeatDots(count) helper renders dot spans dynamically from JS, not HTML"
    - "beatCallback now receives beatIdx (0-based beat index in measure)"

key-files:
  created: []
  modified:
    - renderer/index.html
    - renderer/style.css
    - renderer/js/metronome.js
    - renderer/js/ui-controller.js

key-decisions:
  - "Beat dots rendered dynamically by JS (not static HTML) so count updates with time signature"
  - "renderBeatDots called on init and on mm-timesig-select change to keep dot count in sync"
  - "Loop button removed from #mp-transport into .mp-loop-btn-row between time display and loop times"

requirements-completed: [metronome-beat-dots, metronome-tap-placement, metronome-bpm-click, metronome-combined-row, player-speed-warning, player-loop-btn-placement]

duration: 20min
completed: 2026-04-03
---

# Quick Task 260403-klh: Metronome and Player UI Improvements

**Beat position dot row, full-width TAP, single-click BPM edit, combined selects row, speed warning text, and loop button repositioning across metronome and player sidebar panels**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-04-03T19:39:00Z
- **Completed:** 2026-04-03T19:59:29Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Metronome now shows animated beat dots that light up in sequence matching the current time signature; dot count updates when time signature changes
- TAP button is full-width in its own row below the BPM +/- controls (was cramped inside the BPM grid)
- Single-click on BPM display enters inline edit mode (was double-click)
- Subdivision and time signature selects share one compact row instead of two separate rows
- "(resets on seek)" warning appears in purple near speed slider whenever speed is not 1x, hides when reset
- Loop button lives in a centered row between time display and loop region times, out of the main transport row

## Task Commits

1. **Task 1 + Task 2: Metronome and player UI changes** - `d54e323` (feat)

## Files Created/Modified

- `renderer/index.html` — Restructured metronome panel HTML: added mm-beat-dots, mm-tap-row, mm-selects-row; player panel: mp-loop-btn-row, mp-speed-warn
- `renderer/style.css` — Added .mm-beat-dots, .mm-beat-dot, .mm-tap-row, .mm-selects-row, .mp-loop-btn-row, .mp-speed-warn; removed .mm-subdiv-row/.mm-timesig-row and individual select ID rules
- `renderer/js/metronome.js` — beatCallback now passes beatIdx (0-based beat index) to callback
- `renderer/js/ui-controller.js` — renderBeatDots() helper; onBeat updates dot active state; stop clears dots; BPM click not dblclick; speed warning toggle in input handler and resetSpeedSlider()

## Decisions Made

- Beat dots rendered dynamically by JS (`renderBeatDots(count)`) rather than static HTML, so count can update when time signature changes without re-parsing HTML
- Used `Metronome.getTimeSignature().numerator` at init to seed the dot count from persisted state
- Loop button retained all existing `#mp-loop-btn` CSS rules unchanged — only the parent container changed

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None - all changes implemented cleanly.

## Next Phase Readiness

- All six UI improvements are live on the `worktree-agent-aea62316` branch
- No regressions expected in metronome timing or playback logic

---
*Phase: quick*
*Completed: 2026-04-03*
