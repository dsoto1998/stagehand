# Phase 4: Library Tabs & Virtual Scrolling - Research

**Researched:** 2026-03-25
**Domain:** Vanilla JS virtual scrolling, tab navigation, context menus — browser DOM
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Track Row Format (Songs tab + Artists drill-down)**
- D-01: Use compact rows (~50px tall) instead of full cards. Each row shows: track name, artist · album subtitle, and duration aligned right.
- D-02: Virtual scrolling with fixed-height rows (~50px) — vanilla JS implementation, no library.
- D-03: Per-track controls (volume slider, transpose slider, waveform canvas) are removed from library rows. The miniplayer already handles these.
- D-04: Rename and delete actions use a right-click context menu on the row. No hover-reveal icons.

**Artists Tab Structure**
- D-05: Drill-down navigation: Artists tab initially shows a list with one row per artist (artist name + track count). Clicking an artist navigates into a track list for that artist. A back button/breadcrumb returns to the artist list.
- D-06: The artist track list uses the same compact row format (D-01) as the Songs tab.
- D-07: Tracks with no artist tag are grouped under "Unknown Artist" — treated as a regular artist entry with a track count. Sorted alphabetically with other artists.

**Playlists Tab (Phase 4 scope)**
- D-08: Playlists tab shows an empty state ("No playlists yet") in Phase 4. No stub buttons needed.

**Import / Drop-Zone Placement**
- D-09: Drop-zone and Import toolbar remain above the tab bar — visible on all tabs.
- D-10: Drop-zone is always visible (current behavior preserved).

**Tab Styling**
- D-11: Use the existing design system. Active tab indicated with accent color (`--accent: #e8ff47`).

### Claude's Discretion

- Tab visual style (pill vs underline vs border) — Claude picks what fits the existing `--border`, `--accent` design tokens
- Context menu styling and positioning for right-click rename/delete
- Exact compact row layout (spacing, font sizes, play indicator)
- How the "currently playing" track is highlighted in the compact row list

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| LIB-01 | Library has a Songs tab listing all tracks | Tab switching pattern + virtual scroll renders tracks[] array |
| LIB-02 | Library has an Artists tab grouping tracks by parsed artist | Artist grouping from in-memory tracks[] using artist field (Phase 3 populated); drill-down state machine |
| LIB-03 | Library has a Playlists tab for managing playlists | Empty state render only; playlists object store exists from Phase 3 IDB migration |
| LIB-04 | Library renders without performance degradation at hundreds or thousands of tracks | Fixed-height virtual scroll: only render visible rows + overscan buffer |
</phase_requirements>

---

## Summary

Phase 4 restructures the library panel into three tabs (Songs, Artists, Playlists) and replaces the full track-card rendering approach with compact rows and virtual scrolling. The entire implementation is vanilla JS — no libraries required. The project's constraint against a build step and the pre-decided D-02 (vanilla virtual scroll) means this phase is a pure DOM engineering task.

The key insight is that `buildTrackCard()` currently creates heavyweight DOM for every track including waveform canvas, two sliders, and a progress bar. These must be replaced with lightweight 50px rows. All per-track controls move exclusively to the miniplayer. The `#track-list` div becomes a virtual scroll viewport. The play interaction changes: row click starts playback via the existing `players[]` map and `showMiniplayer()`, rather than a button inside a full card.

The Artists tab introduces a two-level UI state machine (artist-list view vs. artist-drill-down view) backed entirely by a JS variable — no IDB changes. The right-click context menu requires careful positioning logic to keep the menu on-screen, and a document-level click listener to dismiss it.

**Primary recommendation:** Implement a single virtual scroll engine that both Songs and the Artists drill-down share (same fixed row height, same render callback pattern). The tab bar, virtual scroller, and context menu are the three independent building blocks.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Vanilla JS DOM APIs | native | Tab switching, virtual scroll, context menu | Project constraint: no bundler, no libraries. All required APIs (IntersectionObserver not needed; `scrollTop` arithmetic is sufficient) are universally available in Chrome/Firefox |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| CSS custom properties | native | Tab active state, row highlight, context menu theme | Already established — use `--accent`, `--bg-hover`, `--border` throughout |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Vanilla virtual scroll | TanStack Virtual | No-library constraint makes TanStack off-limits despite its quality; vanilla is sufficient at 500+ rows with fixed height |
| CSS underline tab | CSS pill tab | Both fit the design system; underline aligns better with the existing `.nav-item` left-border active pattern. Recommend underline. |

**Installation:** None — no new packages.

---

## Architecture Patterns

### Recommended Project Structure

No new files are strictly required. All changes are to existing files:

```
renderer/
├── index.html              ← Add tab bar HTML inside #panel-library
├── style.css               ← Add: .lib-tab-bar, .lib-tab, .track-row, .virtual-scroll-*, .ctx-menu
└── js/
    └── ui-controller.js    ← Replace buildTrackCard + renderTrackList; add tab state, virtual scroller,
                               artist drill-down state, context menu, row play handler
```

All logic stays in `ui-controller.js`. No new JS modules needed for this phase.

### Pattern 1: Library Tab Bar (HTML structure)

**What:** A `<div class="lib-tab-bar">` containing three tab buttons inserted between `.library-toolbar` and `#track-list` in `#panel-library`.

**When to use:** Tabs control which view is active inside the existing `#panel-library` container.

**HTML to add inside `#panel-library` (after `.library-toolbar`, before `#track-list`):**

```html
<div class="lib-tab-bar">
  <button class="lib-tab active" data-tab="songs">Songs</button>
  <button class="lib-tab" data-tab="artists">Artists</button>
  <button class="lib-tab" data-tab="playlists">Playlists</button>
</div>
```

`#track-list` becomes the shared scroll viewport for Songs and Artists drill-down. The empty-state for Playlists replaces it when that tab is active.

### Pattern 2: Vanilla Virtual Scroll (fixed-height rows)

**What:** Only render the rows visible in the viewport plus an overscan buffer. Use a spacer div above and below the rendered slice to maintain scroll position.

**When to use:** Any list where row count can exceed ~100 and all rows are the same fixed height.

**Core implementation pattern:**

```javascript
// Source: standard virtual scroll algorithm (no library needed for fixed-height)
const ROW_H = 50;        // px — must match CSS
const OVERSCAN = 5;      // extra rows above/below viewport

function renderVirtualList(container, items, renderRow) {
  const viewportH = container.clientHeight;
  const scrollTop = container.scrollTop;
  const totalH = items.length * ROW_H;

  const firstIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const lastIdx  = Math.min(items.length - 1,
                    Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);

  const spacerTop = document.createElement('div');
  spacerTop.style.height = (firstIdx * ROW_H) + 'px';

  const spacerBot = document.createElement('div');
  spacerBot.style.height = ((items.length - 1 - lastIdx) * ROW_H) + 'px';

  container.innerHTML = '';
  container.appendChild(spacerTop);
  for (let i = firstIdx; i <= lastIdx; i++) {
    container.appendChild(renderRow(items[i], i));
  }
  container.appendChild(spacerBot);
}

// Attach scroll listener — throttle with requestAnimationFrame
let rafPending = false;
container.addEventListener('scroll', () => {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    renderVirtualList(container, currentItems, renderRow);
  });
});
```

**Critical CSS for the container:**

```css
#track-list {
  overflow-y: auto;
  height: 100%;           /* must have explicit height — flex child of panel */
  position: relative;
}
```

The panel itself must be `display: flex; flex-direction: column` with `#track-list` as a flex child set to `flex: 1; overflow: hidden` so the track list fills remaining height.

### Pattern 3: Compact Track Row

**What:** A 50px DOM element with exactly three data regions — play indicator, text info, duration.

```javascript
function buildTrackRow(track) {
  const row = document.createElement('div');
  row.className = 'track-row' + (track.id === currentPlayingId ? ' playing' : '');
  row.dataset.id = track.id;
  row.style.height = ROW_H + 'px';

  const artist = track.artist || '';
  const album  = track.album  || '';
  const sub    = [artist, album].filter(Boolean).join(' \u00B7 ');
  const dur    = track.duration ? formatTime(track.duration) : '--:--';

  row.innerHTML = `
    <div class="row-play-indicator"></div>
    <div class="row-info">
      <div class="row-name">${escHtml(track.name)}</div>
      ${sub ? `<div class="row-sub">${escHtml(sub)}</div>` : ''}
    </div>
    <div class="row-dur">${escHtml(dur)}</div>
  `;
  return row;
}
```

Row click triggers playback. No buttons inside the row (context menu handles rename/delete via right-click per D-04).

### Pattern 4: Artists Drill-Down State Machine

**What:** A single JS variable `currentArtistView` controls which of two views renders in the Artists tab.

```javascript
// null = show artist list; String = show tracks for that artist
let currentArtistView = null;

function getArtistGroups() {
  const map = new Map();
  tracks.forEach(t => {
    const key = t.artist || 'Unknown Artist';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  });
  // Sort alphabetically
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function renderArtistsTab() {
  if (currentArtistView === null) {
    renderArtistList();
  } else {
    renderArtistDrillDown(currentArtistView);
  }
}
```

Artist list rows use a different `buildArtistRow()` builder (artist name + track count). Clicking one sets `currentArtistView = artistName` and re-renders. The back button sets it to `null` and re-renders.

### Pattern 5: Right-Click Context Menu

**What:** A positioned `<div>` shown at cursor coordinates on `contextmenu` event.

```javascript
// Single menu element, reused for every row
let ctxMenuTrackId = null;
const ctxMenu = document.createElement('div');
ctxMenu.id = 'ctx-menu';
ctxMenu.innerHTML = `
  <div class="ctx-item" data-action="rename">Rename</div>
  <div class="ctx-item ctx-danger" data-action="delete">Delete</div>
`;
document.body.appendChild(ctxMenu);

function showCtxMenu(e, trackId) {
  e.preventDefault();
  ctxMenuTrackId = trackId;
  const x = Math.min(e.clientX, window.innerWidth - 140);
  const y = Math.min(e.clientY, window.innerHeight - 70);
  ctxMenu.style.left = x + 'px';
  ctxMenu.style.top  = y + 'px';
  ctxMenu.classList.add('show');
}

// Dismiss on any click outside
document.addEventListener('click', () => ctxMenu.classList.remove('show'));
document.addEventListener('contextmenu', e => {
  if (!e.target.closest('.track-row')) ctxMenu.classList.remove('show');
});

ctxMenu.addEventListener('click', e => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action || !ctxMenuTrackId) return;
  ctxMenu.classList.remove('show');
  if (action === 'rename') startRenameById(ctxMenuTrackId);
  if (action === 'delete') deleteTrackById(ctxMenuTrackId);
});
```

### Pattern 6: Tab Switching

**What:** Show/hide content views based on active tab, reset Artists drill-down when leaving the Artists tab.

```javascript
let activeTab = 'songs'; // 'songs' | 'artists' | 'playlists'

document.querySelectorAll('.lib-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.lib-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeTab = btn.dataset.tab;
    if (activeTab !== 'artists') currentArtistView = null; // reset drill-down on tab leave
    renderCurrentTab();
  });
});
```

### Pattern 7: Miniplayer-Coupled Row Play Handler

**What:** Row click starts playback using existing `players[]` map and `showMiniplayer()`.

The critical coupling points from the existing codebase:
- `players[id]` — created lazily in `buildTrackCard()`; Phase 4 must ensure players are created for all tracks on load
- `currentPlayingId` — controls which row gets the `playing` class
- `mp-prev` / `mp-next` handlers reference `document.getElementById('card-' + id)` to find the play button — these must be updated to work without card DOM elements

The miniplayer prev/next buttons currently do `card.querySelector('.track-play-btn').click()`. With compact rows (no `.track-play-btn` inside them), the prev/next handlers need to call a shared `playTrack(id)` function instead of relying on DOM card lookup.

### Anti-Patterns to Avoid

- **Rebuilding the entire list on every scroll event:** Always use `requestAnimationFrame` throttling and only update the slice. Full DOM rebuild on every scroll tick causes jank.
- **Inline `innerHTML` for the virtual container on every render:** Clear and re-append; do not use `container.innerHTML = bigString` because it drops all event listeners on child nodes (though with event delegation on the container, this is less critical).
- **Attaching individual event listeners to each row:** With virtual scrolling, rows are destroyed and recreated on each render pass. Use event delegation on the container (`container.addEventListener('click', e => { const row = e.target.closest('.track-row'); ... })`).
- **Fixed pixel heights that don't match CSS:** `ROW_H = 50` in JS must exactly match the CSS `height: 50px` on `.track-row`. Any border, margin, or padding that adds height outside the element will break scroll arithmetic. Use `box-sizing: border-box` and put border inside the row.
- **Not resetting `currentArtistView`:** When the user switches away from the Artists tab, `currentArtistView` should reset to `null` so returning to Artists shows the list again, not a stale drill-down.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Scroll position arithmetic | Custom scroll tracking with cumulative offsets | Standard `container.scrollTop` + `Math.floor(scrollTop / ROW_H)` | Fixed-height rows make this trivially correct; no complex offset tracking needed |
| Artist name parsing | Custom regex or string splitting | Read `track.artist` field directly | Phase 3 already populates `artist` from jsmediatags; no parsing needed |
| Tab routing state | URL hash / history API | Simple `activeTab` variable | This is a single-page panel, not a routed app; no URL state needed |

**Key insight:** Virtual scrolling for fixed-height rows is a dozen lines of arithmetic, not a library problem. The complexity lives in CSS (explicit container heights) and event delegation, not in the scroll math.

---

## Common Pitfalls

### Pitfall 1: Container Height is Undefined

**What goes wrong:** The virtual scroll container calculates `container.clientHeight === 0` because no explicit height is set, so it renders zero visible rows.

**Why it happens:** `#panel-library` is currently `display: block; padding: 28px`. The `#track-list` has no height constraint and grows with content. After Phase 4, `#track-list` must be a bounded scroll container.

**How to avoid:** Make `#panel-library` use `display: flex; flex-direction: column; height: 100%` and set `#track-list` to `flex: 1; overflow: hidden`. The panel is already inside `#main` which is `overflow-y: auto` — `#main` should become `overflow: hidden` for the library panel, with scrolling delegated entirely to `#track-list`.

**Warning signs:** Empty list, no scrollbar, or all items crammed at the top.

### Pitfall 2: Miniplayer Prev/Next Breaks After Removing Full Cards

**What goes wrong:** `mp-prev` and `mp-next` handlers do `document.getElementById('card-' + id).querySelector('.track-play-btn').click()` — this DOM lookup fails when full cards no longer exist.

**Why it happens:** The existing miniplayer navigation is coupled to the presence of `.track-card` DOM elements with embedded play buttons.

**How to avoid:** Extract a shared `playTrack(id)` function that both row click handlers and miniplayer prev/next call. The function handles buffer loading, stops other players, calls `player.play()`, and calls `showMiniplayer()`. Miniplayer buttons call `playTrack(nextId)` directly without DOM lookups.

**Warning signs:** Prev/Next buttons in miniplayer are silent, or throw `Cannot read properties of null` in console.

### Pitfall 3: Virtual Scroll Flickers on Tab Switch

**What goes wrong:** Switching tabs clears `#track-list` innerHTML and immediately re-renders, causing a visible flash.

**Why it happens:** The render is synchronous but the browser may paint the cleared state before the new rows.

**How to avoid:** Use `requestAnimationFrame(() => renderVirtualList(...))` after switching tabs. Alternatively, keep the Songs and Artists content in separate sub-containers so only the container visibility toggles, not the DOM content.

### Pitfall 4: Context Menu Stays Visible After Scroll

**What goes wrong:** User right-clicks a row, scrolls the list, context menu stays at old position referring to a row that's no longer in view.

**Why it happens:** Context menu position is fixed at creation; virtual scrolling destroys/recreates rows.

**How to avoid:** Add a `scroll` event listener on `#track-list` that dismisses the context menu (`ctxMenu.classList.remove('show')`).

### Pitfall 5: "Playing" Row Highlight Not Updated After Virtual Re-Render

**What goes wrong:** The currently playing row loses its `playing` class after a scroll re-render.

**Why it happens:** Virtual scroll rebuilds all row DOM nodes; the class applied to the old DOM node is gone.

**How to avoid:** In `buildTrackRow()`, always apply `playing` class based on `track.id === currentPlayingId` at construction time, not imperatively after the fact.

### Pitfall 6: Rename In-Place on Virtual Row

**What goes wrong:** Inline rename (replacing row text with an input) gets destroyed on next scroll re-render while user is typing.

**Why it happens:** Virtual scroll rebuilds rows on scroll events.

**How to avoid:** While a rename input is active, pause virtual scroll re-renders (set a flag `renamingActive = true` and skip scroll handler), or use the confirm dialog pattern instead of in-place editing. The existing `startRename()` function creates an in-place input — this approach requires the scroll-pause guard.

---

## Code Examples

### Verified Patterns from Existing Codebase

**Event delegation on virtual scroll container (avoids per-row listeners):**

```javascript
// Source: established DOM pattern — all event listeners on stable container
trackList.addEventListener('click', e => {
  const row = e.target.closest('.track-row[data-id]');
  if (!row) return;
  const id = row.dataset.id;
  playTrack(id);
});

trackList.addEventListener('contextmenu', e => {
  const row = e.target.closest('.track-row[data-id]');
  if (!row) return;
  showCtxMenu(e, row.dataset.id);
});
```

**Re-using existing `escHtml()` and `formatTime()` helpers** — both are already defined at top of `ui-controller.js`, no duplication needed.

**Artist group derivation from in-memory `tracks[]` array:**

```javascript
function getArtistGroups() {
  const map = new Map();
  tracks.forEach(t => {
    const key = (t.artist && t.artist.trim()) ? t.artist.trim() : 'Unknown Artist';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  });
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
```

**Ensuring all players are initialized on load** (critical for miniplayer prev/next without full card DOM):

```javascript
// In loadLibrary(), after tracks = stored:
tracks.forEach(t => {
  if (!players[t.id]) players[t.id] = new TrackPlayer(t.id);
  players[t.id].semitones = t.semitones || 0;
  players[t.id].volume    = t.volume !== undefined ? t.volume : 1.0;
});
```

**Compact row CSS pattern:**

```css
.track-row {
  display: flex;
  align-items: center;
  height: 50px;           /* MUST match ROW_H = 50 in JS */
  box-sizing: border-box; /* border goes inside height */
  border-bottom: 1px solid var(--border);
  padding: 0 12px;
  cursor: pointer;
  gap: 10px;
  transition: background 0.1s;
}
.track-row:hover   { background: var(--bg-hover); }
.track-row.playing { background: var(--bg-active); }
.track-row.playing .row-name { color: var(--accent); }

.row-play-indicator {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: transparent;
  flex-shrink: 0;
}
.track-row.playing .row-play-indicator {
  background: var(--accent);
  box-shadow: 0 0 6px var(--accent);
}

.row-info  { flex: 1; min-width: 0; }
.row-name  {
  font-family: 'Barlow Condensed', sans-serif;
  font-size: 15px; font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.row-sub   {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px; color: var(--text-dim);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  margin-top: 1px;
}
.row-dur   {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px; color: var(--text-dim);
  flex-shrink: 0; min-width: 36px; text-align: right;
}
```

**Tab bar CSS pattern (underline style, consistent with design system):**

```css
.lib-tab-bar {
  display: flex;
  border-bottom: 1px solid var(--border);
  margin-bottom: 0;
  flex-shrink: 0;
}
.lib-tab {
  padding: 8px 16px;
  border: none; background: none;
  font-family: 'Barlow Condensed', sans-serif;
  font-size: 14px; font-weight: 500; letter-spacing: 1px;
  color: var(--text-secondary);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;   /* overlap container border */
  transition: all 0.15s;
}
.lib-tab:hover  { color: var(--text-primary); }
.lib-tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}
```

**Context menu CSS:**

```css
#ctx-menu {
  position: fixed;
  display: none;
  z-index: 300;
  background: var(--bg-panel);
  border: 1px solid var(--border-bright);
  border-radius: 3px;
  min-width: 130px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.5);
}
#ctx-menu.show { display: block; }
.ctx-item {
  padding: 8px 14px;
  font-family: 'Barlow Condensed', sans-serif;
  font-size: 14px; letter-spacing: 0.5px;
  cursor: pointer;
  color: var(--text-primary);
  transition: background 0.1s;
}
.ctx-item:hover   { background: var(--bg-hover); }
.ctx-danger       { color: var(--red); }
.ctx-danger:hover { background: rgba(255,71,87,0.1); }
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Full track cards with waveform canvas + sliders per track | Compact 50px rows; controls in miniplayer only | Phase 4 | Enables virtual scrolling; orders-of-magnitude fewer DOM nodes at 500+ tracks |
| Single flat track list | Three tabs: Songs, Artists, Playlists | Phase 4 | Library organization by browsing mode |
| `buildTrackCard()` for all list rendering | `buildTrackRow()` + virtual scroll | Phase 4 | `buildTrackCard()` survives only as a pattern reference for rename/delete logic extraction |

**Deprecated/outdated in Phase 4:**
- `buildTrackCard()`: replaced by `buildTrackRow()` and `buildArtistRow()`. The rename and delete logic it contains must be extracted into `startRenameById(id)` and `deleteTrackById(id)` standalone functions callable from the context menu.
- `renderTrackList()`: replaced by `renderCurrentTab()` which dispatches to the active tab's render function.
- Direct `.track-play-btn` DOM lookup in miniplayer prev/next handlers: replaced by `playTrack(id)` function.

---

## Open Questions

1. **Panel layout change for scrollable track list**
   - What we know: `#panel-library` currently has `padding: 28px` and `#main` is `overflow-y: auto`. The track list grows with content.
   - What's unclear: Whether changing `#panel-library` to flex-column with `#track-list` as `flex: 1` will affect the drop-zone and toolbar spacing or the metronome panel layout.
   - Recommendation: Keep `#panel-library` height scoped by making it `height: 100%` inside `#main` (which changes from `overflow-y: auto` to `overflow: hidden`). Planner should verify this does not break the metronome panel.

2. **Scroll position preservation across tab switches**
   - What we know: Virtual scroll tracks position via `container.scrollTop`.
   - What's unclear: Whether to save/restore `scrollTop` when switching tabs (e.g., user scrolls down in Songs, switches to Artists, comes back to Songs and finds position reset).
   - Recommendation: For Phase 4 scope, do not preserve scroll position across tab switches. Restoration is a UX nicety that can be added later; the spec does not require it.

3. **Rename UX in virtual scroll context**
   - What we know: Inline rename (current approach) conflicts with virtual scroll destroying rows on scroll.
   - What's unclear: Whether to use in-place rename with scroll-pause guard or a prompt/modal.
   - Recommendation: In-place rename with `renamingActive` guard flag (stop re-renders while input is active, resume on blur/commit). This preserves the familiar UX.

---

## Environment Availability

Step 2.6: SKIPPED (no external dependencies — all implementation is DOM/CSS/JS in existing browser context)

---

## Sources

### Primary (HIGH confidence)
- Direct codebase read: `renderer/js/ui-controller.js` — existing `buildTrackCard()`, `renderTrackList()`, `players[]` map, `currentPlayingId`, miniplayer handlers
- Direct codebase read: `renderer/index.html` — `#panel-library`, `#track-list`, `#drop-zone`, `.library-toolbar` structure
- Direct codebase read: `renderer/style.css` — all design tokens, `.nav-item.active` pattern, existing component CSS
- CONTEXT.md decisions D-01 through D-11 — authoritative locked decisions

### Secondary (MEDIUM confidence)
- Virtual scroll algorithm: well-established pattern, `scrollTop / rowHeight` arithmetic is standard — no library or external source needed for fixed-height implementation

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new libraries; all vanilla DOM/CSS
- Architecture: HIGH — direct codebase inspection, decisions locked in CONTEXT.md
- Pitfalls: HIGH — derived from direct code reading (miniplayer card-coupling, container height issue, rename-in-virtual-scroll conflict are all verifiable in current code)

**Research date:** 2026-03-25
**Valid until:** Stable — no external dependencies to go stale
