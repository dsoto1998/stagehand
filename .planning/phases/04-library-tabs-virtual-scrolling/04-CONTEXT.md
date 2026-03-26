# Phase 4: Library Tabs & Virtual Scrolling - Context

**Gathered:** 2026-03-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Restructure the library panel into three navigable tabs (Songs, Artists, Playlists) and implement virtual scrolling so the UI handles hundreds or thousands of tracks without performance degradation.

Requirements: LIB-01, LIB-02, LIB-03, LIB-04
Success criteria (from ROADMAP.md):
1. Library panel has Songs, Artists, and Playlists tabs that switch without page reload
2. Songs tab lists all tracks; Artists tab groups tracks by parsed artist name
3. 500+ tracks scrolls smoothly with no visible lag (virtual scrolling, fixed-height rows)
4. Playlists tab is present and shows existing playlists (populated by Phase 5)

</domain>

<decisions>
## Implementation Decisions

### Track Row Format (Songs tab + Artists drill-down)

- **D-01:** Use **compact rows** (~50px tall) instead of full cards. Each row shows: track name, artist · album subtitle, and duration aligned right.
- **D-02:** Virtual scrolling with fixed-height rows (~50px) — vanilla JS implementation, no library. This was pre-decided in v2.0 planning.
- **D-03:** Per-track controls (volume slider, transpose slider, waveform canvas) are **removed from the library rows**. The miniplayer already handles these.
- **D-04:** Rename and delete actions use a **right-click context menu** on the row. No hover-reveal icons.

### Artists Tab Structure

- **D-05:** Drill-down navigation: Artists tab initially shows a list with one row per artist (artist name + track count). Clicking an artist navigates into a track list for that artist. A back button/breadcrumb returns to the artist list.
- **D-06:** The artist track list uses the same compact row format (D-01) as the Songs tab.
- **D-07:** Tracks with no artist tag are grouped under **"Unknown Artist"** — treated as a regular artist entry with a track count. Sorted alphabetically with other artists.

### Playlists Tab (Phase 4 scope)

- **D-08:** Playlists tab shows an empty state ("No playlists yet") in Phase 4. Playlist CRUD is Phase 5 scope. No stub buttons needed.

### Import / Drop-Zone Placement

- **D-09:** Drop-zone and Import toolbar remain **above the tab bar** — visible on all tabs. Import is a global action, not specific to Songs.
- **D-10:** Drop-zone is always visible (current behavior preserved). No collapse-after-first-import.

### Tab Styling

- **D-11:** Use the existing design system. Active tab indicated with accent color (`--accent: #e8ff47`). Standard pill or underline tabs consistent with the dark theme.

### Claude's Discretion

- Tab visual style (pill vs underline vs border) — Claude picks what fits the existing `--border`, `--accent` design tokens
- Context menu styling and positioning for right-click rename/delete
- Exact compact row layout (spacing, font sizes, play indicator)
- How the "currently playing" track is highlighted in the compact row list

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project Docs
- `.planning/PROJECT.md` — Core value, constraints, design system color palette, font stack
- `.planning/REQUIREMENTS.md` — LIB-01 through LIB-04 acceptance criteria
- `.planning/ROADMAP.md` — Phase 4 success criteria (authoritative)

### Prior Phase Context
- `.planning/phases/03-transport-metadata-foundation/03-CONTEXT.md` — IDB schema (tracks fields: artist, album, title, duration), playlists object store added in Phase 3

### Codebase Entry Points
- `renderer/index.html` — Library panel structure (`#panel-library`, `#track-list`, `#drop-zone`, `.library-toolbar`)
- `renderer/js/ui-controller.js` — `buildTrackCard()`, `renderTracks()`, track array, miniplayer bindings
- `renderer/js/library-manager.js` — IndexedDB CRUD, `saveMeta()`
- `renderer/style.css` — Design tokens, existing `.track-card`, `.nav-item` patterns

No external specs — requirements fully captured in decisions above.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `buildTrackCard(track)` in `ui-controller.js`: currently builds full cards — will be replaced with compact row builder for Phase 4; the rename/delete logic inside it is reusable
- `#track-list` div: current container for all track cards — becomes the virtual scroll viewport for Songs tab
- `#drop-zone` and `.library-toolbar`: already structurally above `#track-list`, stays above tabs
- `.nav-item` / `.nav-badge` CSS: existing tab/nav pattern to borrow for library tab bar

### Established Patterns
- State stored in `tracks[]` array (in-memory) — loaded from IndexedDB on init; Artists tab derives groupings from this same array
- `saveMeta()` / `saveTrackMeta()` pattern for metadata-only IDB updates
- `escHtml()` helper for safe DOM string insertion

### Integration Points
- Currently playing track indicated by `currentPlayingId` — compact rows need to reflect this state
- Miniplayer `mp-play`, `mp-prev`, `mp-next` operate on the `tracks[]` array; Songs tab row clicks should set current track and trigger play
- Artists drill-down is UI-only state (no IDB changes needed) — a simple `currentArtistView` variable in ui-controller.js suffices

</code_context>

<specifics>
## Specific Ideas

- The approved compact row mockup:
  ```
  | > | Song Name                      3:47 |
  |   | Artist · Album                       |
  ```
- The approved drill-down artist view mockup:
  ```
  Artists
  ---------------------------------
   > The Beatles              12 tracks
   > John Coltrane             8 tracks
   > Unknown Artist            3 tracks

  [click The Beatles]

  ← The Beatles (12 tracks)
  ---------------------------------
   > Come Together            3:54
   > Let It Be                3:52
  ```
- Drop-zone stays above tab bar:
  ```
   [Drop Zone: Drop Audio Files Here]
    [Import] 12 tracks
   +---------+---------+-----------+
   | Songs   | Artists | Playlists |
   +---------+---------+-----------+
  ```

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 04-library-tabs-virtual-scrolling*
*Context gathered: 2026-03-25*
