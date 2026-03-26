---
phase: 04-library-tabs-virtual-scrolling
plan: 01
subsystem: ui
tags: [virtual-scroll, tabs, context-menu, library, track-rows]

# Dependency graph
requires:
  - phase: 03-transport-metadata-foundation
    provides: track metadata fields (artist, album, title, duration), IDB schema v2, miniplayer scrub bar
provides:
  - Tab bar (Songs/Artists/Playlists) in library panel
  - Virtual scroll engine for Songs tab (fixed 50px rows, OVERSCAN=5)
  - Compact track rows with name, artist/album subtitle, duration
  - Context menu (right-click) for rename and delete
  - playTrack(id) standalone function decoupled from card DOM
  - startRenameById / deleteTrackById standalone functions
  - Artists tab stub (full implementation in Plan 02)
  - Playlists tab empty state (CRUD in Phase 5)
affects:
  - 04-02: Artists tab implementation builds on tab bar and renderVirtualList
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

key-files:
  created: []
  modified:
    - renderer/index.html
    - renderer/style.css
    - renderer/js/ui-controller.js

key-decisions:
  - "Virtual scroll uses vanilla JS with fixed ROW_H=50 and spacer divs — no library"
  - "playTrack() replaces all card DOM coupling; mp-prev/mp-next/mp-play use it directly"
  - "Context menu (right-click) handles rename/delete — no per-row hover buttons (D-04)"
  - "renamingActive flag prevents renderVirtualList from destroying the active input"
  - "Artists tab is a stub in Plan 01; full drill-down implemented in Plan 02"
  - "Playlists tab shows empty state per D-08; CRUD is Phase 5 scope"

patterns-established:
  - "Virtual scroll pattern: renderVirtualList(container, items, renderRowFn) with spacerTop/spacerBot divs"
  - "Tab dispatch: renderCurrentTab() dispatches to renderSongsTab/renderArtistsTab/renderPlaylistsTab based on activeTab"
  - "Row event delegation: trackList.addEventListener('click') with e.target.closest('.track-row[data-id]')"

requirements-completed: [LIB-01, LIB-04]

# Metrics
duration: 4min
completed: 2026-03-26
---

# Phase 04 Plan 01: Songs Tab with Virtual Scrolling Summary

**Tab bar (Songs/Artists/Playlists), compact 50px virtual-scrolled track rows, right-click context menu rename/delete, and miniplayer decoupled from card DOM via standalone playTrack()**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-26T03:03:34Z
- **Completed:** 2026-03-26T03:10:24Z
- **Tasks:** 2 of 3 (Task 3 is human-verify checkpoint — awaiting)
- **Files modified:** 3

## Accomplishments
- Replaced heavyweight track cards with 50px compact rows for Songs tab
- Implemented vanilla JS virtual scroll engine: only visible rows + OVERSCAN=5 rows rendered
- Added Songs/Artists/Playlists tab bar with accent underline on active tab
- Decoupled miniplayer prev/next/play from card DOM — all use playTrack(id)
- Added right-click context menu for rename and delete (no per-row hover icons)
- Artists tab is a stub; Playlists tab shows "No playlists yet" empty state

## Task Commits

Each task was committed atomically:

1. **Task 1: Tab bar HTML + all new CSS** - `6ba5145` (feat)
2. **Task 2: Virtual scroll engine, row builder, playTrack, context menu, tab switching** - `6df7d26` (feat)
3. **Task 3: Human verify checkpoint** — awaiting user verification

## Files Created/Modified
- `renderer/index.html` - Added lib-tab-bar HTML, ctx-menu element, removed static empty-state
- `renderer/style.css` - Added tab, compact row, context menu, lib-empty-state, row-name-input CSS; converted #panel-library to flex column; #track-list to scroll viewport
- `renderer/js/ui-controller.js` - Full refactor: playTrack, buildTrackRow, renderVirtualList, renderCurrentTab, tab renderers, context menu, standalone rename/delete; removed buildTrackCard

## Decisions Made
- Used underline-style tabs (border-bottom: 2px solid --accent) consistent with dark theme design tokens
- playTrack() wires onProgress/onEnd callbacks fresh on each play, ensuring correct currentPlayingId closure
- renamingActive guard: renderVirtualList returns early if a rename input is active, preventing DOM teardown
- Eager player initialization in loadLibrary() enables instant playback without buffer wait

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Known Stubs

- **Artists tab** (`renderer/js/ui-controller.js`, `renderArtistsTab()`): Shows "Artists / Loading..." empty state. Full drill-down (artist list -> track list) implemented in Plan 02.
- **Playlists tab** (`renderer/js/ui-controller.js`, `renderPlaylistsTab()`): Shows "No playlists yet" empty state per D-08. Playlist CRUD is Phase 5 scope.

These stubs are intentional per plan decisions D-05/D-08. They do not prevent Plan 01's goal from being achieved.

## Next Phase Readiness
- Plan 02 (Artists tab) can proceed: tab bar is wired, renderVirtualList and buildTrackRow are reusable, activeTab/currentArtistView state is in place
- Artists tab just needs renderArtistsTab() to be implemented with drill-down logic

## Self-Check: PASSED

---
*Phase: 04-library-tabs-virtual-scrolling*
*Completed: 2026-03-26*
