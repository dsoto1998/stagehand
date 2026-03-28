# Architecture Patterns: Stagehand v2.0 Library & Player Enhancement

**Domain:** Browser-based music library UI — ID3 parsing, virtual scroll, library tabs, playlists
**Researched:** 2026-03-24
**Overall confidence:** HIGH for IndexedDB migration pattern; HIGH for virtual scroll approach; MEDIUM for ID3 library choice (CDN delivery needs validation); LOW for playlist reorder DOM (no live source)

---

## Recommended Architecture

### What Changes vs What Is New

**Modified files (existing):**
- `renderer/js/library-manager.js` — DB version bump (v1 → v2), new `playlists` store, migration in `onupgradeneeded`, new `getByArtist()` helper
- `renderer/js/ui-controller.js` — replace `renderTrackList()` with virtual scroller, add tab routing, connect miniplayer progress bar, connect auto-play-first logic, wire playlist CRUD
- `renderer/index.html` — add library tab bar, progress bar to miniplayer, playlist panel HTML, update `<script>` import map if needed
- `renderer/style.css` — virtual scroll container height, tab styles, playlist UI

**New files:**
- `renderer/js/id3-parser.js` — thin wrapper around the chosen ID3 library; exports `parseId3(arrayBuffer)` returning `{title, artist, album, duration}`
- `renderer/js/virtual-scroll.js` — self-contained virtual scroller class; renders fixed-height rows; no framework dependency
- `renderer/js/playlist-manager.js` — playlist CRUD over the new `playlists` IndexedDB store; exports parallel API to `library-manager.js`

**Not changed:**
- `renderer/js/audio-engine.js` — audio routing is untouched
- `renderer/js/track-player.js` — playback engine is untouched
- `renderer/js/rubberband-processor.js` — WASM processor is untouched
- `renderer/js/metronome.js` — untouched
- `renderer/js/waveform.js` — untouched

---

### Component Boundaries

| Component | Responsibility | Communicates With |
|-----------|---------------|-------------------|
| `library-manager.js` | IndexedDB v2 — tracks store + playlists store; migration logic | `ui-controller.js` |
| `playlist-manager.js` | Playlist CRUD: create/rename/delete/reorder; add/remove track references | `library-manager.js` (reads track records), `ui-controller.js` |
| `id3-parser.js` | Extract artist/album/title/duration from ArrayBuffer before save | `ui-controller.js` (called in `importFiles`) |
| `virtual-scroll.js` | Render a visible window of N rows from a full track list; recycle DOM nodes | `ui-controller.js` (instantiated for Songs tab) |
| `ui-controller.js` | Orchestrates everything — tab state, miniplayer, import flow, auto-play | All of the above |

---

## IndexedDB Migration Strategy

### Schema Change: v1 → v2

**DB_VER bumps from 1 to 2.** The `onupgradeneeded` handler must use `event.oldVersion` to apply migrations conditionally so existing users are not broken.

```
stagehand_db version 1:
  tracks {id, name, format, size, semitones, volume, arrayBuffer, addedAt}

stagehand_db version 2:
  tracks {id, name, format, size, semitones, volume, arrayBuffer, addedAt,
          artist?, album?, title?, duration?}   ← new optional scalar fields
          + index on 'artist'
  playlists {id, name, trackIds[], createdAt, updatedAt}  ← new object store
```

**Migration code pattern in `library-manager.js`:**

```js
const DB_VER = 2;

req.onupgradeneeded = e => {
  const db = e.target.result;
  const tx = e.target.transaction;

  // v1 → create tracks store if first-time user
  if (e.oldVersion < 1) {
    const s = db.createObjectStore('tracks', { keyPath: 'id' });
    s.createIndex('name', 'name', { unique: false });
  }

  // v1 → v2: add artist index to tracks + create playlists store
  if (e.oldVersion < 2) {
    const tracksStore = tx.objectStore('tracks');
    if (!tracksStore.indexNames.contains('artist')) {
      tracksStore.createIndex('artist', 'artist', { unique: false });
    }
    if (!db.objectStoreNames.contains('playlists')) {
      const ps = db.createObjectStore('playlists', { keyPath: 'id' });
      ps.createIndex('name', 'name', { unique: false });
    }
  }
};
```

**Key points:**
- Existing track records survive version bump unchanged — IndexedDB does not remove records during upgrades
- `artist`, `album`, `title`, `duration` fields are absent on old records (undefined); UI must handle this gracefully with fallback to `track.name`
- No data migration of old records needed — ID3 metadata is only parsed and stored on new imports; old tracks just show no artist/album
- The `playlists` store is created fresh; no old data to migrate

### Playlist Object Store Schema

```js
{
  id:        String,    // "pl_<timestamp>_<random>"
  name:      String,    // display name (editable)
  trackIds:  String[],  // ordered array of track IDs
  createdAt: Number,    // Date.now()
  updatedAt: Number     // Date.now()
}
```

Track references are IDs only. When a track is deleted from the library, all playlists must have that ID pruned from their `trackIds` arrays. This is done in the delete flow in `ui-controller.js` — after `LibraryManager.remove(id)`, iterate all playlists and call `PlaylistManager.removeTrackFromAll(id)`.

---

## ID3 Parsing Integration

### Recommended Library: id3js (`@catamphetamine/id3js`)

**Why:** Imports as an ES module from unpkg without any build step; supports `fromArrayBuffer()` or equivalent method for parsing an ArrayBuffer directly (no URL required, works with in-memory file data); supports ID3v1 and ID3v2; actively maintained fork. Confidence: MEDIUM — CDN ES module import confirmed by search results, `fromArrayBuffer` API needs verification against live docs before coding.

**Alternative if id3js doesn't work offline:** Manual parsing of ID3v2 header. ID3v2 frames start with a 10-byte header; `TIT2`=title, `TPE1`=artist, `TALB`=album are ASCII-parseable with a DataView. Duration requires decoding the audio (already done in `TrackPlayer.loadBuffer`) so use `player.duration` rather than an ID3 TLEN frame. Complexity: ~100 lines, no external dependency, HIGH reliability.

**Duration source:** Do NOT rely on ID3 TLEN frame for duration — it is unreliable and often absent. After `player.loadBuffer(ab)`, `player.duration` is already available from `AudioBuffer.duration`. Store this value.

### Integration Point: `importFiles()` in `ui-controller.js`

The ID3 parse step is inserted into the existing `importFiles` function, before the `LibraryManager.save()` call:

```
importFiles flow (new):
  1. file.arrayBuffer() → ab
  2. parseId3(ab.slice(0)) → {title, artist, album}   ← NEW
  3. player.loadBuffer(ab.slice(0)) → player.duration  ← NEW (eager decode to get duration)
  4. Build trackForDB with artist/album/title/duration fields
  5. LibraryManager.save(trackForDB)
  6. Push to tracks[]
```

The `id3-parser.js` module wraps the library and normalizes to a common shape:

```js
// id3-parser.js
export async function parseId3(arrayBuffer) {
  try {
    // id3js call here (exact API TBD from live docs)
    const tags = await id3.fromArrayBuffer(arrayBuffer);
    return {
      title:  tags?.v2?.TIT2 || tags?.v1?.title || null,
      artist: tags?.v2?.TPE1 || tags?.v1?.artist || null,
      album:  tags?.v2?.TALB || tags?.v1?.album || null,
    };
  } catch (e) {
    return { title: null, artist: null, album: null };
  }
}
```

**Failure handling:** ID3 parsing is best-effort. If it throws or returns nulls, the track imports normally with only `name` (filename without extension). Never block import on a parse failure.

---

## Virtual Scrolling Architecture

### Why Virtual Scroll

The current `renderTrackList()` creates one full DOM card per track. Track cards contain a canvas, multiple sliders, and event listeners. At 500+ tracks this causes:
- Initial render time of seconds
- DOM node count in the thousands
- Scroll jank due to layout cost

Virtual scrolling keeps DOM node count fixed at approximately `visible_rows + buffer_rows` regardless of library size.

### Approach: Fixed-Height Row Virtual Scroller

Track cards have a known, consistent height (approximately 140px in current CSS). This enables the simplest and most reliable virtual scroll implementation — no height measurement needed.

**Implementation in `virtual-scroll.js`:**

```
VirtualScroll class:
  - constructor(container, rowHeight, renderFn, data[])
  - update(data[])              — replace dataset, re-render
  - scrollTo(index)             — programmatic scroll
  - onScroll event              — internal, bound to container scroll

Internals:
  - spacerTop  = empty div, height = startIndex * rowHeight
  - visibleRows = rendered DOM nodes (pool of ~visibleCount + 10 buffer)
  - spacerBottom = empty div, height = (data.length - endIndex) * rowHeight
  - startIndex  = Math.floor(scrollTop / rowHeight)
  - endIndex    = startIndex + visibleCount + buffer
  - On scroll: update spacer heights + re-render visible slice
```

**Row recycling:** Rather than creating/destroying DOM nodes on every scroll event, maintain a fixed pool of row elements and update their content in place. This eliminates GC pressure during fast scrolls.

**Lazy audio decode:** The current architecture decodes every track's AudioBuffer eagerly in `buildTrackCard`. With virtual scroll, only render visible rows. Audio buffers should be decoded on demand (first play), not on row render. The waveform canvas in each card draws from the decoded buffer — for the virtual scroll case, draw waveform only when the row is rendered AND the buffer is available; otherwise show a placeholder.

### Integration in `ui-controller.js`

The `renderTrackList()` function is replaced by `VirtualScroll` instantiation:

```js
// In loadLibrary():
tracks = await LibraryManager.all();
songVirtualScroll = new VirtualScroll(
  document.getElementById('track-list'),
  140,           // row height px
  buildTrackRow, // renders one row's content
  tracks         // data array
);
```

`buildTrackRow` is a slimmed-down version of `buildTrackCard` that operates on an existing DOM node (updating inner HTML or child elements) rather than creating a fresh node.

**Songs tab only initially.** Virtual scroll applies to the Songs tab. Artists tab uses a different grouping render. Playlists tab has its own smaller list.

---

## Library Tabs Architecture

### Tab Structure

Three tabs within `panel-library`:

```
[Songs] [Artists] [Playlists]
```

Tab switching is pure CSS class toggling — no panel navigation. The sidebar nav item for "Library" stays as the panel trigger; the tabs are sub-navigation within the panel.

**HTML structure:**

```html
<div class="lib-tabs">
  <button class="lib-tab active" data-tab="songs">Songs</button>
  <button class="lib-tab" data-tab="artists">Artists</button>
  <button class="lib-tab" data-tab="playlists">Playlists</button>
</div>
<div class="lib-tab-content" id="tab-songs">
  <!-- virtual scroll track list -->
</div>
<div class="lib-tab-content hidden" id="tab-artists">
  <!-- grouped by artist -->
</div>
<div class="lib-tab-content hidden" id="tab-playlists">
  <!-- playlist CRUD UI -->
</div>
```

**Artists tab:** Groups tracks by `artist` field. Tracks with no artist fall under "Unknown Artist". Implementation: derive a sorted artist list from `tracks[]` in memory; render an accordion or grouped list. No virtual scroll needed here unless an artist has hundreds of tracks (unlikely in a rehearsal tool). Simple flat render is acceptable.

**Playlists tab:** Shows playlist cards. Each card has the playlist name, track count, play button, and edit controls (rename, delete). Clicking a playlist card expands it to show the track list within it.

---

## Miniplayer Progress Bar

### What Needs to Change

The miniplayer currently has no progress bar. It needs:
- A scrub bar (`<input type="range">`) showing playback position
- Elapsed / total time display
- Seek-on-mouse-up behavior (not on every tick, to avoid audio glitch)

### Integration Points

**HTML (in `#sidebar-bottom`):**

```html
<div id="mp-progress-row">
  <span id="mp-elapsed">0:00</span>
  <input type="range" id="mp-progress" min="0" max="1000" value="0" step="1">
  <span id="mp-total">0:00</span>
</div>
```

**ui-controller.js changes:**

1. `showMiniplayer(trackId)` — set `mp-total` from `player.duration`
2. `player.onProgress` callback — update `#mp-progress` value and `#mp-elapsed` display. This callback is already fired from `TrackPlayer._tick()` on every animation frame; extend it to also update the miniplayer bar.
3. Add `mousedown` / `mouseup` listeners to `#mp-progress`:
   - `mousedown` → set a `scrubbing` flag, stop updating the bar from `onProgress`
   - `mouseup` → read bar value, call `player.seek(fraction)`, clear `scrubbing` flag
4. `hideMiniplayer()` — reset bar to 0, reset elapsed to 0:00

**Seek-on-mouse-up pattern is important.** Updating position on every `input` event while dragging would fire `player.seek()` dozens of times per second, rebuilding the Rubber Band graph each time (150ms debounce). Use `change` event (fires on release) or explicit mousedown/mouseup tracking.

---

## Auto-Play First Alphabetical Track

### Integration Point: Miniplayer play button handler

Currently `mp-play` does nothing if `currentPlayingId` is null. The new behavior:

```js
document.getElementById('mp-play').addEventListener('click', async () => {
  if (!currentPlayingId) {
    // NEW: auto-load and play first alphabetical track
    if (tracks.length === 0) return;
    const sorted = [...tracks].sort((a, b) =>
      (a.name || '').localeCompare(b.name || ''));
    const first = sorted[0];
    await playTrack(first.id);  // extracted helper (see below)
    return;
  }
  // existing play/pause logic...
});
```

**Extracted `playTrack(id)` helper:** The existing inline play logic in `buildTrackCard` is duplicated in three places (play button, prev, next). Extract it into a shared `playTrack(trackId)` function in `ui-controller.js`. This also enables the auto-play case and playlist play-through.

---

## Playlist Play-Through Architecture

### How Playlists Play

When playing a playlist, the `onEnd` callback of the currently playing track triggers the next track in the playlist order rather than stopping.

**State needed:**

```js
let activePlaylistId = null;  // null = free play, id = playlist mode
```

**Modified `player.onEnd`:**

```js
player.onEnd = () => {
  // existing UI cleanup...
  if (activePlaylistId) {
    const next = PlaylistManager.getNextTrack(activePlaylistId, track.id);
    if (next) playTrack(next.id);
    else activePlaylistId = null;  // end of playlist
  }
};
```

`PlaylistManager.getNextTrack(playlistId, currentTrackId)` looks up the playlist's `trackIds[]` array, finds the current index, returns the next track record.

---

## Data Flow

### Import Flow (New)

```
File drop/select
  → file.arrayBuffer()
  → parseId3(ab.slice(0))         → {title, artist, album}
  → loadBuffer for duration       → player.duration (AudioBuffer)
  → build track record            {id, name, format, size, semitones, volume,
                                   arrayBuffer, addedAt, title, artist, album, duration}
  → LibraryManager.save()
  → tracks.push()
  → songVirtualScroll.update(tracks)
```

### Playback Flow (Modified)

```
playTrack(id) helper:
  → find track in tracks[]
  → ensure player exists and buffer is loaded (existing logic, extracted)
  → stop other players
  → player.play()
  → showMiniplayer(id)
  → if activePlaylistId: set up onEnd → next track
```

### Playlist CRUD Flow

```
Create:   PlaylistManager.create(name) → IDB put → playlists.push() → re-render
Rename:   PlaylistManager.rename(id, name) → IDB saveMeta → update in-memory → re-render
Delete:   confirm() → PlaylistManager.remove(id) → IDB delete → filter playlists[] → re-render
Add track: PlaylistManager.addTrack(plId, trackId) → IDB get+put → re-render
Reorder:  drag-and-drop or up/down buttons → update trackIds[] in memory → PlaylistManager.save() → re-render
```

---

## Patterns to Follow

### Pattern 1: Extracted `playTrack(id)` as Central Play Dispatcher

**What:** Single function that handles buffer loading, stopping other players, play, and miniplayer update.

**Why:** Play is triggered from 5 different surfaces (track card button, miniplayer play, prev/next, auto-play, playlist play-through). Inline logic in `buildTrackCard` cannot serve all callers.

**Signature:**
```js
async function playTrack(trackId, playlistContext = null)
```

The `playlistContext` parameter is null for free play, or a playlist ID when playing from a playlist. It sets `activePlaylistId` and wires the `onEnd` callback for play-through.

### Pattern 2: Track Records as Read-Only Source of Truth

**What:** The `tracks[]` array in memory is the single source of truth for the Songs and Artists tabs. Mutations (rename, volume, semitones) write through to IndexedDB via `saveMeta`, and also update the in-memory object. Virtual scroll renders from `tracks[]`.

**Why:** Avoids stale data in the virtual scroller. After any mutation, call `songVirtualScroll.update(tracks)` to refresh visible rows.

### Pattern 3: Graceful Metadata Fallback

**What:** Any code displaying artist/album/title must fall back to `track.name` (filename) when ID3 fields are null/undefined.

**Why:** Existing tracks in the library have no ID3 fields. New imports of files without tags return nulls.

```js
const displayName = track.title || track.name;
const displayArtist = track.artist || 'Unknown Artist';
```

### Pattern 4: Playlist Store is References Only

**What:** Playlists store an array of track IDs (`trackIds: String[]`), not copies of track data.

**Why:** No data duplication. Tracks can be in multiple playlists. When track metadata changes, no playlist record needs updating.

**Consequence:** When rendering a playlist's tracks, look up each ID in `tracks[]` (in-memory map for O(1) lookup). Maintain a `tracksById = new Map(tracks.map(t => [t.id, t]))` index rebuilt on library load and after imports/deletes.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Eager Audio Decode During Virtual Scroll Row Render

**What:** Calling `player.loadBuffer(ab)` inside the virtual scroll row renderer for every visible row on every scroll event.

**Why bad:** `loadBuffer` calls `ctx.decodeAudioData` which is async and CPU-intensive. Triggering it for 10–15 rows on every scroll tick stalls the UI and produces redundant decode work.

**Instead:** Decode only on first play. The waveform canvas shows a placeholder (grey bar) until the buffer is decoded. Buffer decode result is cached in `players[id].buffer` — check before decoding.

### Anti-Pattern 2: Storing Full Track Objects in Playlist Records

**What:** Copying `{id, name, artist, format, ...}` into each playlist's `trackIds` array (making it a `tracks` array).

**Why bad:** Data duplication. If a track is renamed or has volume changed, the playlist copy becomes stale.

**Instead:** Store only IDs. Resolve to track objects at render time via `tracksById` map.

### Anti-Pattern 3: DOM Manipulation Inside `onProgress` RAF Loop

**What:** Updating many DOM elements (waveform progress, current time, miniplayer bar, miniplayer elapsed) inside `player.onProgress` — which fires every animation frame (~60fps).

**Why bad:** Touching many DOM elements at 60fps causes forced layout reflows if any element read follows a write. The current code updates 2 elements per RAF tick which is fine. Adding miniplayer bar and elapsed is still fine (4 total). Avoid adding more.

**Instead:** Keep `onProgress` updates to 3–4 targeted DOM property sets. No `getBoundingClientRect` or offsetWidth reads inside the callback.

### Anti-Pattern 4: Recreating Virtual Scroll on Every Tab Switch

**What:** Destroying and reconstructing the `VirtualScroll` instance each time the Songs tab is activated.

**Why bad:** Forces re-render of all visible rows and loses scroll position.

**Instead:** Initialize the `VirtualScroll` once at library load time. On tab switch, simply show/hide the container div. Call `update(tracks)` only when the data changes, not on every tab switch.

### Anti-Pattern 5: Blocking Import on ID3 Parse

**What:** Awaiting ID3 parse and propagating any thrown error to stop the import.

**Why bad:** Malformed or non-ID3 files (WAV, FLAC, files without tags) will fail to import even though the audio itself is valid.

**Instead:** Wrap `parseId3` in try/catch returning `{title:null, artist:null, album:null}` on any failure. Import proceeds regardless.

---

## Scalability Considerations

| Concern | At 50 tracks | At 500 tracks | At 5000 tracks |
|---------|--------------|---------------|----------------|
| DOM node count | 50 cards (current) | Virtual scroll: ~20 nodes constant | Same: ~20 nodes constant |
| Audio buffers decoded | Eager (all 50 on load) | Lazy (only played tracks) | Lazy — must be lazy at this scale |
| IndexedDB load time | Fast | Moderate (all arrayBuffers loaded into memory) | Slow — ArrayBuffers alone could be gigabytes |
| In-memory tracks[] | Small | ~500 objects without arrayBuffers = fine | Needs deferred arrayBuffer loading |
| Playlist lookup | O(n) through tracks[] | O(1) with tracksById Map | O(1) with tracksById Map |

**Note on 5000 tracks:** Loading all ArrayBuffers into memory on startup becomes a problem at large scale. The current architecture (`loadLibrary` calls `LibraryManager.all()` which fetches all records including `arrayBuffer`) would need a split: load metadata-only records at startup, load `arrayBuffer` on demand per track. This is out of scope for v2.0 but the virtual scroll and lazy-decode patterns lay the foundation for it.

---

## Build Order (Phases) with Dependency Rationale

```
Phase 1: IndexedDB Migration + ID3 Parsing
  Rationale: Schema foundation everything else depends on.
             New fields (artist/album/title/duration) must exist before
             Artists tab or enriched track display can be built.
  Files: library-manager.js (DB_VER bump + playlists store + artist index)
         id3-parser.js (new)
         ui-controller.js (importFiles extension only)

Phase 2: Miniplayer Progress Bar + Auto-Play First Track
  Rationale: Self-contained miniplayer changes; no new data structures needed.
             Extract playTrack() helper here — other phases depend on it.
             Auto-play is trivial once playTrack() exists.
  Files: index.html (add progress bar HTML)
         style.css (progress bar styles)
         ui-controller.js (showMiniplayer, hideMiniplayer, mp-progress wiring,
                          playTrack() extraction, auto-play logic)

Phase 3: Virtual Scrolling (Songs Tab)
  Rationale: Depends on Phase 1 (tracks have all needed fields now).
             Must come before Library Tabs because Songs tab IS the current
             track list — virtualizing it is the prerequisite for restructuring
             it into a tab.
  Files: virtual-scroll.js (new)
         ui-controller.js (replace renderTrackList with VirtualScroll,
                          tracksById Map, lazy decode guards)
         style.css (scroll container height, row height)

Phase 4: Library Tabs (Songs / Artists / Playlists shell)
  Rationale: Depends on Phase 3 (Songs tab already virtualized).
             Build the tab chrome and Artists grouping view.
             Playlists tab is a stub (shell only, no CRUD yet).
  Files: index.html (lib-tabs bar + tab content divs)
         style.css (tab styles)
         ui-controller.js (tab switching logic, Artists grouping view)

Phase 5: Playlist Management
  Rationale: Depends on Phase 1 (playlists IDB store exists).
             Depends on Phase 2 (playTrack() helper for play-through).
             Depends on Phase 4 (Playlists tab shell exists).
  Files: playlist-manager.js (new — IDB CRUD for playlists store)
         ui-controller.js (playlist CRUD handlers, play-through onEnd wiring,
                          removeTrackFromAll called in track delete flow)
         index.html (playlist card/track list HTML templates if not already added)
         style.css (playlist UI styles)
```

**Why this order:**
- Phase 1 first because schema changes are one-way — once users run v2, the DB is at version 2
- Phase 2 is independent of the library restructure; delivers visible user value quickly
- Phase 3 before tabs because virtualizing the list changes how rows are created — doing it while the list is still flat is simpler than retrofitting it after tabs are wired
- Phase 4 wraps Phase 3's virtual scroll in a tab context
- Phase 5 last because it depends on the most pieces (IDB store, playTrack helper, tab shell)

---

## Sources

- MDN — IndexedDB upgradeneeded event: https://developer.mozilla.org/en-US/docs/Web/API/IDBOpenDBRequest/upgradeneeded_event
  - Confirms: `e.oldVersion` for conditional migration; existing data survives version bumps
  - Confidence: HIGH

- MDN — Using IndexedDB (migration section): https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB
  - Confirms: Object stores can only be created/altered in `onupgradeneeded`
  - Confidence: HIGH

- catamphetamine/id3js on npm: https://www.npmjs.com/package/@catamphetamine/id3js
  - Confirmed: ES module import from unpkg without bundler; `fromFile()` and `fromUrl()` methods
  - `fromArrayBuffer()` availability needs live docs verification before coding
  - Confidence: MEDIUM

- Virtual scrolling from scratch (stackfull.dev): https://stackfull.dev/implementing-virtual-scroll-for-web-from-scratch-in-less-than-150-lines-of-code
  - Confirms: startIndex = Math.floor(scrollTop / rowHeight); spacer div approach; 150 LoC feasible
  - Confidence: HIGH (pattern is well-established)

- Virtual scrolling core principles (LogRocket): https://blog.logrocket.com/virtual-scrolling-core-principles-and-basic-implementation-in-react/
  - Confirms: buffer/overscan of 5-10 rows; fixed-height approach; DOM recycling pattern
  - Confidence: HIGH

- Existing codebase read (2026-03-24):
  - `library-manager.js` lines 1-69 — current IDB schema, DB_VER=1, tracks keyPath
  - `ui-controller.js` lines 1-598 — current renderTrackList, buildTrackCard, miniplayer, importFiles
  - `track-player.js` lines 1-175 — TrackPlayer.onProgress, onEnd, duration, seek
  - `renderer/index.html` lines 1-193 — current DOM structure
  - Confidence: HIGH (direct source read)
