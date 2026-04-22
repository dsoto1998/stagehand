---
phase: quick
plan: 260401-swq
type: execute
wave: 1
depends_on: []
files_modified:
  - renderer/js/ui-controller.js
  - renderer/style.css
  - renderer/index.html
autonomous: true
requirements: [quick-task]
must_haves:
  truths:
    - "Track rows in Songs view show separate Artist, Album, Duration columns"
    - "A three-dot context menu button is visible on each track row"
    - "Clicking the three-dot button opens the existing context menu"
    - "Column headers above track list label each column"
    - "Layout does not break in Artists drill-down or Playlists track views"
  artifacts:
    - path: "renderer/js/ui-controller.js"
      provides: "Updated buildTrackRow with grid columns and ctx button"
    - path: "renderer/style.css"
      provides: "CSS grid layout for track rows and column header"
    - path: "renderer/index.html"
      provides: "Column header row element"
  key_links:
    - from: "renderer/js/ui-controller.js"
      to: "#ctx-menu"
      via: "three-dot button click calls showCtxMenu()"
      pattern: "showCtxMenu"
---

<objective>
Restructure track rows from flex layout with a combined artist/album subtitle line into a Spotify-style CSS grid with separate Artist, Album, Duration columns, a column header row, and a visible three-dot context menu button on each row.

Purpose: Give the library a clean, scannable columnar layout matching modern music player conventions.
Output: Updated track row rendering, CSS grid styles, column header, and context menu trigger button.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@renderer/js/ui-controller.js (lines 908-980: buildTrackRow, lines 2730-2741: contextmenu listener, lines 2749+: showCtxMenu)
@renderer/style.css (lines 616-767: .track-row and row child styles)
@renderer/index.html (lines 192-204: lib-sort-bar and track-list)
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add column header and restructure track row to CSS grid with context menu button</name>
  <files>renderer/index.html, renderer/js/ui-controller.js, renderer/style.css</files>
  <action>
**index.html changes:**

1. Add a column header row between `#lib-sort-bar` and `#track-list` (around line 201). Insert a new div:
```html
<div id="lib-col-header" class="track-row-grid col-header">
  <div class="col-h-title">Title</div>
  <div class="col-h-artist">Artist</div>
  <div class="col-h-album">Album</div>
  <div class="col-h-dur">Duration</div>
  <div class="col-h-ctx"></div>
</div>
```
The first column (Title) spans the art thumbnail + play area + name area. The last column is narrow for the context menu button.

**style.css changes:**

2. Replace the existing `.track-row` flex layout (lines ~616-626) with a CSS grid layout. Add a new `.track-row-grid` class that both the column header and track rows will use:

```css
.track-row-grid {
  display: grid;
  grid-template-columns: [title] minmax(200px, 2fr) [artist] minmax(80px, 1fr) [album] minmax(80px, 1fr) [dur] 56px [ctx] 36px;
  align-items: center;
  height: 50px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--border);
  padding: 0 12px;
  gap: 10px;
}
```

Keep `.track-row` class on rows for existing hover/selected/playing styles, but change its display from `display: flex` to just inheriting from `.track-row-grid`. The row element will have both classes: `class="track-row track-row-grid"`.

3. Style the column header:
```css
.col-header {
  height: 32px;
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  font-weight: 400;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid var(--border-bright);
  cursor: default;
  user-select: none;
  position: sticky;
  top: 0;
  background: var(--bg-panel);
  z-index: 2;
}
```

4. The "Title" column cell in each row contains the existing art thumbnail, play indicator/button, and track name (but NOT the `.row-sub` subtitle). Wrap these in a `.row-title-cell` div with `display: flex; align-items: center; gap: 10px; min-width: 0;` so the internal elements flex within the grid cell.

5. The Artist and Album columns each get their own cell:
```css
.row-artist, .row-album {
  font-size: 13px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
```

6. Keep `.row-dur` style but remove the old `flex-shrink: 0; min-width: 36px` (grid handles sizing now). Keep `text-align: right`.

7. Style the three-dot context menu button:
```css
.row-ctx-btn {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 16px;
  cursor: pointer;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  opacity: 0;
  transition: opacity 0.1s;
}
.track-row:hover .row-ctx-btn { opacity: 1; }
.row-ctx-btn:hover { background: var(--bg-active); color: var(--text-primary); }
```

8. Move `.row-xpose` (transpose controls) out of the track row grid entirely. They are already accessible in the context menu and miniplayer. Remove the inline transpose controls from track rows to declutter the columnar layout. (The transpose value is still visible in context menu and miniplayer; the inline transpose was added for quick access but clutters the new grid layout.)

**ui-controller.js changes:**

9. In `buildTrackRow()` (line ~908), restructure the row HTML generation:
   - Add class `track-row-grid` to the row element alongside `track-row`
   - Create a `.row-title-cell` wrapper containing: art thumbnail, play area, row-name div
   - Remove the `.row-sub` line (artist/album combined subtitle) since artist and album now have their own columns
   - Add separate `.row-artist` div with `track.artist || ''`
   - Add separate `.row-album` div with album label (include releaseDate in parens if present, same logic as current albumLabel)
   - Keep `.row-dur` div
   - Remove the `.row-xpose` transpose controls block entirely from the row
   - Add a three-dot context menu button: `<button class="row-ctx-btn" data-id="${escHtml(track.id)}" title="More options">&#x2026;</button>` (the `...` horizontal ellipsis character)

10. Add click handler for `.row-ctx-btn` on `trackList` (near the existing contextmenu listener around line 2730):
```js
trackList.addEventListener('click', e => {
  const ctxBtn = e.target.closest('.row-ctx-btn[data-id]');
  if (!ctxBtn) return;
  e.stopPropagation();
  const row = ctxBtn.closest('.track-row[data-id]');
  if (!row) return;
  // Determine playlist context if in playlist view
  const plView = row.closest('.pl-track-list');
  let plContext = null;
  if (plView) {
    const plId = plView.dataset.plId;
    const pl = playlists.find(p => p.id === plId);
    const idx = [...plView.querySelectorAll('.track-row')].indexOf(row);
    if (pl) plContext = { pl, idx };
  }
  showCtxMenu(e, row.dataset.id, plContext);
});
```

11. The column header should be hidden when not on Songs tab (or when in artist drill-down / album drill-down). In `renderCurrentTab()`, toggle visibility of `#lib-col-header`:
    - Show it for: Songs tab, Playlists drill-down (track list within a playlist), Artists drill-down (track list within an artist), Albums drill-down (track list within an album)
    - Hide it for: Artists list view (showing artist cards, not track rows), Albums list view (showing album cards), Playlists list view (showing playlist cards)
    - Use `colHeader.classList.toggle('hidden', shouldHide)` with a `.hidden { display: none !important; }` check (the app likely already has a `.hidden` class).

12. For playlist track rows that use `buildTrackRow`, the same grid layout applies automatically since they reuse the same function.
  </action>
  <verify>
    <automated>cd F:/Claude/stagehand && npx serve renderer -l 8080 -s &amp; echo "Server started" — then visually inspect at http://localhost:8080. Verify: track rows show 5 columns (title, artist, album, duration, three-dot button). Column header visible above track list. Three-dot button appears on hover. Clicking three-dot opens context menu.</automated>
  </verify>
  <done>
    - Track rows display as CSS grid with Title, Artist, Album, Duration, and context menu columns
    - Column header row with labels appears above the track list
    - Three-dot button visible on row hover, triggers showCtxMenu on click
    - Inline transpose controls removed from rows (still available in context menu and miniplayer)
    - Artist and album shown in separate columns instead of combined subtitle
    - Layout works in Songs tab, Artists drill-down, Albums drill-down, and Playlist drill-down views
    - Column header hidden when viewing artist/album/playlist card lists
    - No JavaScript errors in console
  </done>
</task>

</tasks>

<verification>
1. Open http://localhost:8080/renderer/index.html in Chrome
2. Import a few tracks — verify rows show grid columns with Title | Artist | Album | Duration | three-dot
3. Hover over a row — three-dot button appears
4. Click three-dot button — context menu opens with Play, Info, Rename, Delete options
5. Right-click a row — context menu still works (existing behavior preserved)
6. Edit a track's artist/album via Info dialog — verify the column updates after save
7. Switch to Artists tab, click an artist — drill-down shows same columnar layout
8. Switch to Playlists tab, open a playlist — same layout
9. Verify column header shows/hides appropriately per view
10. Check no console errors
</verification>

<success_criteria>
Track rows in Songs and drill-down views display a Spotify-style columnar layout with Title, Artist, Album, Duration columns and a visible three-dot context menu trigger. Column header labels each column. All existing functionality (play, select, drag, right-click context menu) remains intact.
</success_criteria>

<output>
After completion, create `.planning/quick/260401-swq-add-artist-album-duration-columns-and-co/260401-swq-SUMMARY.md`
</output>
