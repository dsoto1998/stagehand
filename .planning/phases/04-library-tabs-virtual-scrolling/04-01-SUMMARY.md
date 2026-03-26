---
phase: 04-library-tabs-virtual-scrolling
plan: 01
subsystem: ui
tags: [virtual-scroll, tabs, context-menu, library, track-rows, transpose, fast-import]

# Dependency graph
requires:
  - phase: 03-transport-metadata-foundation
    provides: track metadata fields (artist, album, title, duration), IDB schema v2, miniplayer scrub bar
provides:
  - Tab bar (Songs/Artists/Playlists) in library panel
  - Virtual scroll engine for Songs tab (fixed 50px rows, OVERSCAN=5)
  - Compact track rows with name, artist/album subtitle, duration
  - Context menu (right-click) with Rename, Transpose +/- buttons, Delete
  - playTrack(id) standalone function decoupled from card DOM, always starts from 0
  - startRenameById / deleteTrackById standalone functions
  - Artists tab: live unique artist list derived from track metadata (Plan 02 adds drill-down)
  - Playlists tab empty state (CRUD in Phase 5)
  - Fast import: tracks visible immediately, audio decode and ID3 tags async in background
affects:
  - 04-02: Artists tab implementation builds on tab bar, renderVirtualList, and artist list skeleton
  - Phase 5: Playlists tab CRUD replaces stub

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Virtual scroll with fixed ROW_H=50, OVERSCAN=5 spacer pattern
    - Event delegation on #track-list for row click and contextmenu
    - renamingActive guard prevents DOM teardown during inline rename
    - RAF-throttled scroll handler for smooth virtual scroll re-render
    - Eager TrackPlayer initialization in loadLibrary() with background buffer loads
    - Fast import: Promise.all parallel ArrayBuffer reads, render immediately, then async IDB/decode/tags
    - Context menu non-dismissing actions: stopPropagation for transpose +/- buttons

key-files:
  created: []
  modified:
    - renderer/index.html
    - renderer/style.css
    - renderer/js/ui-controller.js
    - renderer/js/track-player.js

key-decisions:
  - "Virtual scroll uses vanilla JS with fixed ROW_H=50 and spacer divs — no library"
  - "playTrack() replaces all card DOM coupling; mp-prev/mp-next/mp-play use it directly"
  - "playTrack() always resets pauseOffset=0 — never resumes from previous position on fresh play"
  - "Context menu (right-click) handles rename/transpose/delete — no per-row hover buttons (D-04)"
  - "Transpose via context menu +/- buttons (non-dismissing for rapid multi-step changes)"
  - "renamingActive flag prevents renderVirtualList from destroying the active input"
  - "Artists tab renders live artist list from imported tracks; Plan 02 adds drill-down"
  - "Playlists tab shows empty state per D-08; CRUD is Phase 5 scope"
  - "Fast import: show track immediately, run IDB save + audio decode + tag parse in background async"
  - "Chrome 'Promised response from onMessage' console error is from browser extensions, not app code"

patterns-established:
  - "Virtual scroll pattern: renderVirtualList(container, items, renderRowFn) with spacerTop/spacerBot divs"
  - "Tab dispatch: renderCurrentTab() dispatches to renderSongsTab/renderArtistsTab/renderPlaylistsTab based on activeTab"
  - "Row event delegation: trackList.addEventListener('click') with e.target.closest('.track-row[data-id]')"
  - "Import fast path: push to list + render first, await expensive ops (IDB/decode/tags) in .then() callbacks"

requirements-completed: [LIB-01, LIB-04]

# Metrics
duration: ~90min (initial tasks + human verify + 5 post-verification fixes)
completed: 2026-03-26
---

# Phase 04 Plan 01: Songs Tab with Virtual Scrolling Summary

**Tab bar (Songs/Artists/Playlists), compact 50px virtual-scrolled rows, right-click transpose/rename/delete context menu, instant import display, and miniplayer fully decoupled from card DOM**

## Performance

- **Duration:** ~90 min (initial execution + human verification round + 5 fixes)
- **Started:** 2026-03-26T03:03:34Z
- **Completed:** 2026-03-26
- **Tasks:** 2 planned + 5 post-verification fixes = 7 total
- **Files modified:** 4

## Accomplishments
- Replaced heavyweight track cards with 50px compact rows for Songs tab with virtual scroll
- Implemented vanilla JS virtual scroll engine: only visible rows + OVERSCAN=5 rows rendered
- Added Songs/Artists/Playlists tab bar with accent underline on active tab
- Decoupled miniplayer prev/next/play from card DOM — all use playTrack(id)
- Added right-click context menu for transpose (non-dismissing +/- buttons), rename, and delete
- Artists tab shows live unique artist list from track metadata (not a "Loading..." stub)
- Playlists tab shows "No playlists yet" intentional empty state
- Import is visually instant: tracks appear in list before audio decode or tag parse
- playTrack() always starts from position 0 on every fresh play call

## Task Commits

Each task was committed atomically:

1. **Task 1: Tab bar HTML + all new CSS** - `6ba5145` (feat)
2. **Task 2: Virtual scroll engine, row builder, playTrack, context menu, tab switching** - `6df7d26` (feat)
3. **Fix: Artists tab proper empty state/artist list** - `f129c2d` (fix)
4. **Fix: Transpose restored via context menu +/- buttons** - `6204619` (fix)
5. **Fix: playTrack() always starts from position 0** - `2f9708a` (fix)
6. **Fix: Import shows tracks immediately, async decode/tags** - `25453af` (fix)
7. **Fix: Chrome console error documented (extension issue)** - `66d6a0f` (fix)

## Files Created/Modified
- `renderer/index.html` - Added lib-tab-bar HTML, ctx-menu with transpose section (separator, label, +/- buttons, value display)
- `renderer/style.css` - Added tab, compact row, context menu (including ctx-transpose, ctx-st-btn, ctx-separator, ctx-label), lib-empty-state, row-name-input CSS; #panel-library flex column; #track-list scroll viewport
- `renderer/js/ui-controller.js` - Full refactor: playTrack (with pauseOffset=0 reset), buildTrackRow, renderVirtualList, renderCurrentTab, renderArtistsTab with live artist list, fast importFiles (Promise.all + async background), context menu transpose handler
- `renderer/js/track-player.js` - Added comment documenting Chrome extension console error

## Decisions Made
- Used underline-style tabs (border-bottom: 2px solid --accent) consistent with dark theme design tokens
- playTrack() wires onProgress/onEnd callbacks fresh on each play, ensuring correct currentPlayingId closure
- renamingActive guard: renderVirtualList returns early if a rename input is active, preventing DOM teardown
- Eager player initialization in loadLibrary() enables instant playback without buffer wait
- Transpose in context menu: +/- buttons with stopPropagation so menu stays open for rapid multi-step adjustments

## Deviations from Plan

### Post-Verification Bug Fixes (5 issues reported after human verify)

**1. [Rule 1 - Bug] Artists tab showed 'Loading...' stub**
- **Found during:** Human verification (Task 3)
- **Issue:** renderArtistsTab() had hard-coded "Loading..." subtitle that looked broken
- **Fix:** Replaced with live unique artist list from imported tracks; proper empty state when no artist tags present
- **Files modified:** renderer/js/ui-controller.js
- **Committed in:** f129c2d

**2. [Rule 2 - Missing Critical] No transpose access in new compact row UI**
- **Found during:** Human verification (Task 3)
- **Issue:** Old buildTrackCard() had per-card semitone slider; compact row redesign had no transpose control
- **Fix:** Added transpose section to context menu with +/- buttons, current value display, miniplayer sync, and saveTrackMeta call. Buttons use stopPropagation so menu stays open for multiple adjustments.
- **Files modified:** renderer/index.html, renderer/style.css, renderer/js/ui-controller.js
- **Committed in:** 6204619

**3. [Rule 1 - Bug] playTrack() resumed from previous pause position**
- **Found during:** Human verification (Task 3)
- **Issue:** player.pauseOffset retained previous pause position; clicking a previously-played track resumed mid-track
- **Fix:** Added `player.pauseOffset = 0` before buffer-load in playTrack(). The pause/toggle early-return path is unaffected.
- **Files modified:** renderer/js/ui-controller.js
- **Committed in:** 2f9708a

**4. [Rule 1 - Bug] Import blocked UI while awaiting serial decode and tag parse**
- **Found during:** Human verification (Task 3)
- **Issue:** importFiles() awaited readTags() and file.arrayBuffer() serially per file before adding to list
- **Fix:** Three-phase approach: Promise.all for parallel ArrayBuffer reads, immediate push+render, then background IDB/decode/tags each in independent .then() chains
- **Files modified:** renderer/js/ui-controller.js
- **Committed in:** 25453af

**5. [Rule 1 - Bug investigation] Chrome console error investigated**
- **Found during:** Human verification (Task 3)
- **Issue:** "Promised response from onMessage listener went out of scope" in Chrome console
- **Investigation:** Confirmed no window.postMessage, no chrome.runtime in app code; only AudioWorklet MessagePort. Error is a Chrome extension issue.
- **Fix:** Added explanatory comment to track-player.js; no app code change required
- **Files modified:** renderer/js/track-player.js
- **Committed in:** 66d6a0f

---

**Total deviations:** 5 post-verification fixes (4 bugs fixed, 1 investigated + documented)
**Impact on plan:** All fixes necessary for usability and correctness. No scope creep.

## Issues Encountered

All 5 issues were reported after human verification and fixed in this continuation session.

## User Setup Required

None - no external service configuration required.

## Known Stubs

- **Artists tab drill-down** (`renderer/js/ui-controller.js`, `renderArtistsTab()`): Shows unique artist list but clicking an artist row does nothing. Drill-down to tracks-by-artist is Plan 02 scope.
- **Playlists tab** (`renderer/js/ui-controller.js`, `renderPlaylistsTab()`): Shows "No playlists yet" empty state per D-08. Playlist CRUD is Phase 5 scope.

These stubs are intentional per plan decisions D-05/D-08 and do not prevent Plan 01's goal from being achieved.

## Next Phase Readiness
- Plan 02 (Artists tab) can proceed: tab bar is wired, renderVirtualList and buildTrackRow are reusable, activeTab/currentArtistView state is in place, artist list skeleton is rendered
- Artists tab needs renderArtistsTab() extended with click-to-drill-down and track sub-list rendering

## Self-Check: PASSED

---
*Phase: 04-library-tabs-virtual-scrolling*
*Completed: 2026-03-26*
