# Feature Landscape: Stagehand v2.0 Library & Player Enhancement

**Domain:** Browser-based musician's rehearsal tool — library organization, playlist management, transport UX
**Researched:** 2026-03-24
**Confidence note:** Research conducted using WebSearch. jsmediatags and SortableJS verified via npm/GitHub search results. IndexedDB migration behavior verified via MDN documentation search. UX patterns derived from Spotify, Apple Music, and reference browser player implementations.

---

## Scope

This document covers only the **new v2.0 features**:

1. ID3 metadata parsing on audio import
2. Miniplayer scrubbable progress bar with elapsed/total time
3. Library tabs: Songs, Artists, Playlists
4. Virtual scrolling for large libraries
5. Full Playlists (create, rename, delete, add tracks, reorder, play through)

Existing features (audio playback, waveform, transpose, metronome, current IndexedDB library) are not re-researched.

---

## Feature Area 1: ID3 Metadata Parsing

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Parse title, artist, album on MP3 import | Users expect track name to default to song title, not filename | Low | ID3v2 tags embedded in the file header; can read without downloading the whole file |
| Parse duration without full decode | Duration should show in the library before playback | Low-Medium | Can read from ID3 header or audio element duration trick; `AudioContext.decodeAudioData` also returns duration but requires full decode |
| Graceful fallback to filename | Many audio files have missing or partial tags | Low | If tags absent, fall back to filename (stripping extension); never show blank title |
| Cover art extraction | Users expect to see album art in music players | Medium | Cover art is an APIC frame in ID3v2; must be decoded from bytes to a blob URL; adds memory overhead |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Auto-detect and use title as display name | On import, populate `name` field from ID3 title instead of raw filename | Low | Only applies on import; user can still rename afterwards |
| Show artist name in track card subtitle | Reduces reliance on filename conventions for browsing | Low | Requires artist stored in IndexedDB schema |
| Album grouping data stored | Enables future album-based browsing even if Albums tab is not v2.0 scope | Low | Store it; render it later |

### Anti-Features

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Parsing tags for every format via a heavy library | music-metadata is comprehensive but requires a bundler (pure ESM, no CDN-friendly single-file build) | Use jsmediatags: ships a single `dist/jsmediatags.min.js` file includable via `<script src>` with no bundler |
| Displaying raw binary cover art buffers | Causes memory leaks if not revoked | Create object URL with `URL.createObjectURL(blob)` and revoke when track is removed |
| Blocking the import flow on tag parse failure | Tags can be corrupt or missing | Catch all parse errors; proceed with filename fallback |
| Re-parsing tags on every app load | Wastes time; tags do not change | Parse once on import; store results in IndexedDB alongside the ArrayBuffer |

### Recommended Library: jsmediatags

**Why:** Ships as a single browser-ready file (`dist/jsmediatags.min.js`, ~29kB min+gz) with no bundler required. Matches the project's no-build-step constraint. Supports ID3v1, ID3v2 (MP3), and FLAC Vorbis comments. The `jsmediatags-web` fork is a smaller browser-specific variant at 9.6kB gzipped. Source: GitHub search results confirm active maintenance.

**Usage pattern (browser, File object from file input):**
```js
jsmediatags.read(file, {
  onSuccess: (tag) => {
    const { title, artist, album } = tag.tags;
    // tag.tags.picture contains cover art APIC frame if present
  },
  onError: (error) => {
    // fall back to filename
  }
});
```

**Formats covered:**
- MP3: ID3v1 and ID3v2.2, v2.3, v2.4
- FLAC: Vorbis comment block
- MP4/AAC: iTunes metadata atoms
- WAV: Limited (ID3 chunk if present; WAV typically has no embedded tags)
- OGG/Opus: Not confirmed for jsmediatags; Vorbis comments are the standard for OGG but jsmediatags support is MEDIUM confidence

**Confidence:** MEDIUM — jsmediatags existence and browser usage pattern are HIGH confidence. OGG/Opus tag support needs validation by testing the actual library.

### Feature Dependency

```
Artists tab
  └── Requires: ID3 artist field stored in IndexedDB (v2 schema)
        └── Requires: ID3 parsing on import

Library "Songs" tab shows artist metadata
  └── Requires: ID3 artist field stored

Auto-title on import
  └── Requires: ID3 parsing on import
```

### IndexedDB Schema Migration Required

The existing schema (version 1) does not have `artist`, `album`, `title`, or `duration` fields. Adding them requires bumping the DB version and handling `onupgradeneeded`.

**Safe migration pattern (HIGH confidence, from MDN):**
```js
request = indexedDB.open('stagehand_db', 2); // bump to version 2
request.onupgradeneeded = (event) => {
  const db = event.target.result;
  const store = event.target.transaction.objectStore('tracks');
  // Add new fields — existing records will have them as undefined (falsy)
  // No data loss: object store structure does not change, only new optional fields added
  // New indexes can be created here for artist/album browsing
  store.createIndex('by_artist', 'artist', { unique: false });
  store.createIndex('by_album', 'album', { unique: false });
};
```

Existing tracks imported before v2.0 will have `artist`/`album`/`title` as `undefined` — the UI must handle this gracefully (fall back to `name`).

---

## Feature Area 2: Miniplayer Scrubbable Progress Bar

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Visual progress bar showing playback position | Every music player shows a progress bar | Low-Medium | Must poll `AudioContext.currentTime` relative to playback start offset; no native "currentTime" on AudioBufferSourceNode |
| Elapsed / total time display (e.g. "1:23 / 4:07") | Standard in all music players | Low | Format `mm:ss`; total from decoded AudioBuffer duration |
| Click-to-seek on the progress bar | Standard behavior; without it the bar is just a visualizer | Medium | Must stop current source, calculate new offset from click position, restart with offset parameter |
| Seek on mouse-up, not mouse-move | Prevents audio stuttering during scrub | Low | Attach `mouseup`/`pointerup` event, not `input` or `mousemove` |
| Visual scrub preview during drag | Show position updating during mouse drag without committing seek | Low | Update the visual position on `mousemove`; commit the seek on `mouseup` |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Buffered region visualization | Shows how much audio is decoded/cached | Medium | Less relevant here since audio is fully decoded to AudioBuffer already |
| Keyboard seek (arrow keys ±5s) | Power user productivity | Low | Add `keydown` handler on the miniplayer or document |
| Click anywhere on progress track (not just dragging from thumb) | Simpler mental model for users | Low | Calculate offset as `(clickX / trackWidth) * duration` |

### Anti-Features

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Seeking on every `mousemove` event | Tears down and restarts AudioBufferSourceNode on every pixel of drag — causes constant audio glitching | Seek only on `mouseup`; update visual position during `mousemove` without touching audio |
| Using `<audio>` element `currentTime` | This app uses Web Audio API directly with AudioBufferSourceNode, which has no `currentTime` property | Track elapsed time using `AudioContext.currentTime - playbackStartTime + seekOffset` |
| Polling at 60fps for position updates | Not necessary; 4fps (every 250ms) is indistinguishable for a progress bar | Use `requestAnimationFrame` or a 250ms `setInterval` |
| Re-rendering the full waveform on seek | Waveform canvas is expensive to redraw | Only update the seek position overlay/line, not the full waveform |

### Implementation Notes

AudioBufferSourceNode does not expose a live `currentTime`. The correct approach is:

```
elapsedSeconds = AudioContext.currentTime - playbackStartTimestamp + seekOffsetAtPlaybackStart
progress = elapsedSeconds / audioBuffer.duration
```

`playbackStartTimestamp` is set to `AudioContext.currentTime` at the moment `source.start(0, offset)` is called. When the user seeks, a new source node is started with the new offset, and `playbackStartTimestamp` is reset.

Duration for the time display comes from `AudioBuffer.duration` (available after `decodeAudioData`), or from ID3 header parsing (faster, does not require full decode).

**Confidence:** HIGH — this is standard Web Audio API pattern.

---

## Feature Area 3: Library Tabs (Songs, Artists, Playlists)

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Songs tab — flat list of all tracks, sorted alphabetically | Default view; mirrors current library behavior | Low | Existing track cards moved into the Songs tab pane |
| Artists tab — list of unique artists, expand to see their tracks | Standard in every music app after metadata is available | Medium | Requires ID3 artist field; group-by on the in-memory tracks array |
| Playlists tab — list of user-created playlists | Expected once playlists exist | Low | Renders playlist index; clicking a playlist opens it |
| Tab switching without losing scroll position | UX quality expectation | Low | Each tab pane is a separate scroll container; CSS `display:none` preserves scroll |
| Active tab indicator | Visual affordance showing current tab | Low | Standard CSS active class on tab button |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Artist track count shown in Artists tab | Scannable at a glance | Low | Count tracks per artist during grouping |
| Persist last-selected tab across sessions | Restores context on reload | Low | `localStorage.setItem('activeTab', tabId)` |
| Search/filter within the Songs tab | Fast navigation for large libraries | Medium | Client-side filter on `name` + `artist`; debounce 150ms |

### Anti-Features

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Albums tab in v2.0 | Album grouping without cover art display provides marginal value; adds UI complexity and scope risk | Store album in schema now; add Albums tab in a later milestone when cover art display is ready |
| Nested tabs (tabs within tabs) | Two levels of tab depth is the established maximum for music apps before navigation becomes confusing | Use flat list with expand/collapse within the Artists tab |
| URL routing for tabs | Overkill for a local-only single-page app with no shareable URLs | Use in-memory state for active tab; localStorage for persistence |

### Feature Dependencies

```
Artists tab (functional)
  └── Requires: ID3 artist field parsed and stored in IndexedDB

Playlists tab
  └── Requires: Playlist data model (Feature Area 5)

Songs tab
  └── No new dependencies — uses existing track data
```

**Confidence:** HIGH — tab navigation UX patterns are well-established and do not require external libraries.

---

## Feature Area 4: Virtual Scrolling for Large Libraries

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Render only visible rows (+ small buffer above/below) | Required for hundreds or thousands of tracks without DOM bloat | Medium | At 1000 tracks, naive DOM render creates 1000+ nodes; virtual scroll keeps ~30–50 in DOM at a time |
| Stable scroll position on add/remove | Scroll should not jump when the library updates | Medium | Requires care when re-rendering visible window after mutation |
| Correct total scroll height | Scroll container must be sized as if all items were rendered | Low | Set a spacer div to `itemCount * itemHeight` |
| Lazy audio decoding | Do not decode all AudioBuffers on app load | Medium | Store raw ArrayBuffer in IndexedDB; decode to AudioBuffer only when the track is selected for playback |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Variable row heights (if waveform thumbnails differ) | Waveform bars in track cards may differ in visual height | High | Fixed row height is simpler and sufficient; use uniform card height |
| Windowed rendering with overscan buffer | Prevents visible "pop-in" of rows during fast scroll | Low | Render 5–10 extra rows above and below the visible window |

### Anti-Features

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Full waveform render for all tracks in the list | Waveform canvas generation from AudioBuffer.getChannelData is CPU-intensive; doing it for 500 tracks on load would freeze the browser | Render waveform only for the currently playing track (in the miniplayer); track cards in the list can show a simple placeholder or thin bar |
| Using a React/Vue virtual scroll component | Project has no build step; framework components are not compatible | Implement a minimal vanilla JS virtual scroll (60–100 lines) or use the `virtual-scroll` npm package (vanilla, tiny) |
| Decoding all audio on library load | `decodeAudioData` for 500 files = minutes of work and gigabytes of RAM | Decode on demand: only when a track is clicked or queued for playback |

### Recommended Approach

**Fixed-height virtual scroll — implement vanilla (Medium complexity, no dependency).**

Pattern:
```
containerHeight = visible area height (e.g. 600px)
itemHeight = 72px (fixed track card height)
visibleCount = Math.ceil(containerHeight / itemHeight) + 10 (overscan)
scrollTop = container.scrollTop
startIndex = Math.floor(scrollTop / itemHeight)
endIndex = startIndex + visibleCount

Render only items[startIndex..endIndex]
Offset rendered items with: paddingTop = startIndex * itemHeight
Total scroll height: itemCount * itemHeight
```

On scroll event (throttled to rAF): recalculate startIndex/endIndex and re-render the window.

**Alternative:** `virtual-scroll` npm package (vanilla JS, no framework, ~3KB). Available via CDN. Suitable if the vanilla implementation needs more than 100 lines due to edge cases.

**Confidence:** HIGH — virtual scroll is a well-understood pattern; the vanilla implementation is sufficient for fixed-height rows.

### Feature Dependencies

```
Virtual scrolling (Songs tab)
  └── Requires: Fixed card height (constraint on track card design)
  └── Requires: In-memory track list loaded from IndexedDB (existing)

Lazy audio decode
  └── Requires: Track card click → decode + play flow (existing flow can be preserved)
  └── Note: waveform canvas must be deferred or removed from list cards
```

---

## Feature Area 5: Playlist Management

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Create a new playlist (name it) | Core functionality | Low | Prompt for name or inline editable input; generate UUID |
| Rename a playlist | Standard library management | Low | Inline rename via double-click or pencil icon |
| Delete a playlist | Standard library management | Low | Confirm dialog before delete to prevent accidents |
| Add tracks to a playlist | Core functionality | Medium | "Add to playlist" button/context menu on each track card; shows list of playlists to choose from |
| Display playlist contents (ordered list of tracks) | Core functionality | Low | Clicking a playlist in Playlists tab opens a detail view with the ordered track list |
| Reorder tracks in a playlist by drag | Standard in Spotify, Apple Music, YouTube Music | Medium | Drag-to-reorder within the playlist detail view |
| Play through a playlist in order | Core functionality | Medium | When a track ends, auto-start the next track in the playlist; miniplayer prev/next respects playlist order |
| Persist playlists in IndexedDB | Required for data to survive page reload | Low | New `playlists` object store |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Remove a track from a playlist (without deleting the track from the library) | Important distinction — playlist membership is not ownership | Low | Remove reference; track stays in library |
| Shuffle playback for a playlist | Commonly expected | Medium | Fisher-Yates shuffle on the track index array; store original order separately |
| Loop playlist (play through and restart) | Commonly expected for rehearsal use | Low | When last track ends, auto-start index 0 |
| "Now Playing" playlist — implicit queue from Songs tab | Allows playing all songs as an implicit playlist without creating one | Medium | When playing from Songs tab, treat the sorted song list as the current queue |

### Anti-Features

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Storing full track copies inside each playlist | Wastes IndexedDB space — tracks are already stored with their ArrayBuffers | Store only track IDs in the playlist's `trackIds` array; resolve to track objects at render time |
| Collaborative/shared playlists | Not applicable for a local-only tool | Not needed; no multi-user model |
| Smart playlists (auto-populate by rule) | High complexity, out of scope for v2.0 | Defer to future milestone |
| Nested playlists / folders | Apple Music tried this; users find it confusing | Flat playlist list only |
| Drag tracks from Songs tab directly into Playlists tab via cross-pane drag | Complex hit-testing across different scroll containers | Use an "Add to playlist" button/menu on each track instead |

### Recommended Drag Library: SortableJS

**Why:** Framework-agnostic (no jQuery, no build step required), specifically designed for list reordering. Used by major applications. Available as a single script file via CDN or local copy. Handles touch and mouse. Provides `onEnd` callback with `oldIndex` and `newIndex` for updating the data model.

**Source:** GitHub (SortableJS/Sortable) — HIGH confidence, widely used, actively maintained.

**Usage:**
```js
Sortable.create(playlistItemsEl, {
  animation: 150,
  onEnd: (evt) => {
    const { oldIndex, newIndex } = evt;
    // reorder playlist.trackIds array and persist to IndexedDB
    const moved = playlist.trackIds.splice(oldIndex, 1)[0];
    playlist.trackIds.splice(newIndex, 0, moved);
    savePlaylist(playlist);
  }
});
```

**Alternative:** Vanilla HTML5 Drag and Drop API. Viable for a simple list; requires handling `dragstart`, `dragover`, `dragend` manually and managing a "dragging" index in state. Sufficient for <50-item playlists. Choose SortableJS if touch support or smooth animation is desired.

**Confidence:** HIGH — SortableJS is the standard recommendation for this use case.

### IndexedDB Schema: Playlists Object Store

New object store alongside existing `tracks`:

```js
// playlists object store (keyPath: 'id')
{
  id:        String,    // "pl_<timestamp>_<random>"
  name:      String,    // user-assigned name
  trackIds:  [String],  // ordered array of track IDs
  createdAt: Number     // Date.now()
}
```

Created in `onupgradeneeded` when bumping to DB version 2 (alongside adding artist/album indexes to `tracks`):

```js
request.onupgradeneeded = (event) => {
  const db = event.target.result;
  if (event.oldVersion < 2) {
    db.createObjectStore('playlists', { keyPath: 'id' });
    const trackStore = event.target.transaction.objectStore('tracks');
    trackStore.createIndex('by_artist', 'artist', { unique: false });
  }
};
```

### Play-Through Behavior

When a playlist is active:
- `currentPlaylistId` and `currentPlaylistPosition` (index) are held in memory
- On track end (`source.onended`), increment `currentPlaylistPosition`; if it exceeds `trackIds.length`, either stop (no loop) or wrap to 0 (loop)
- Miniplayer "next" / "prev" buttons respect `currentPlaylistPosition` within the active playlist
- Playing from Songs tab resets `currentPlaylistId` to null (uses alphabetical song list as implicit queue)

**Confidence:** HIGH — this is a straightforward state machine; no external dependencies needed.

---

## Feature Dependencies (Cross-Feature)

```
ID3 parsing on import
  └── Enables: Artists tab (requires artist field)
  └── Enables: Auto-title display in Songs tab
  └── Enables: Duration display without full decode

Library tabs (Songs / Artists / Playlists)
  └── Depends on: ID3 parsing (Artists tab)
  └── Depends on: Playlist data model (Playlists tab)
  └── Virtual scrolling applies to: Songs tab, Playlists tab index

Virtual scrolling
  └── Requires: Fixed card height (design constraint)
  └── Enables: Libraries of 1000+ tracks without performance degradation
  └── Changes: Waveform canvas must move out of track list cards (render on playback only)

Playlist management
  └── Depends on: Playlists tab (UI entry point)
  └── Depends on: IndexedDB schema v2 (playlists object store)
  └── Connects to: Miniplayer play-through behavior

Miniplayer progress bar
  └── Independent of all other v2.0 features
  └── Requires: AudioContext playback timing bookkeeping (startTimestamp + seekOffset)
```

---

## MVP Recommendation

**Phase order by dependency and risk:**

1. **ID3 parsing** — Must come first. Unlocks Artists tab and auto-title. Simple, low risk. Requires DB version bump which must happen before any new schema features.
2. **IndexedDB schema migration to v2** — Bundled with Phase 1 (same `onupgradeneeded` handler adds artist/album indexes and playlists object store).
3. **Miniplayer progress bar** — Independent feature, high user-visible value, medium complexity. Can be Phase 1 or 2.
4. **Library tabs (Songs + Artists)** — After ID3 parsing is stored. Playlists tab renders after Phase 5.
5. **Virtual scrolling** — Needed for correctness at scale; requires fixed card height; affects card design. Implement before Playlists to establish the pattern.
6. **Playlist management** — Final feature; depends on tabs, schema migration, and stable card rendering.

**Defer:**
- Albums tab — store the data now; render later when cover art display is ready
- Shuffle / loop — useful but not v2.0 table stakes; add after core playlist works
- Search/filter within Songs tab — add after virtual scroll is working

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| ID3 parsing (jsmediatags) | MEDIUM | Library existence and browser usage pattern confirmed; OGG/Opus support unverified |
| Progress bar / seek mechanics | HIGH | Standard Web Audio API pattern; well-documented |
| Library tabs UX | HIGH | Industry-standard pattern; no novel implementation required |
| Virtual scroll | HIGH | Well-understood pattern; vanilla implementation is sufficient |
| Playlist data model | HIGH | Simple IDB object store; trackIds array is the standard approach |
| SortableJS for drag-reorder | HIGH | Widely used, framework-agnostic, confirmed via GitHub search |
| IndexedDB migration | HIGH | Documented by MDN; `onupgradeneeded` + version bump is the standard mechanism |

---

## Sources

- [jsmediatags (GitHub)](https://github.com/aadsm/jsmediatags) — ID3, MP4, FLAC tag parsing, browser-ready dist file
- [jsmediatags (npm)](https://www.npmjs.com/package/jsmediatags) — npm package info
- [music-metadata (npm)](https://www.npmjs.com/package/music-metadata) — alternative, requires bundler
- [SortableJS (GitHub)](https://github.com/SortableJS/Sortable) — drag-to-reorder, no framework required
- [MDN — Using IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB) — schema migration via `onupgradeneeded`
- [MDN — IDBOpenDBRequest upgradeneeded](https://developer.mozilla.org/en-US/docs/Web/API/IDBOpenDBRequest/upgradeneeded_event) — version upgrade event
- [MDN — Media buffering, seeking, time ranges](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Audio_and_video_delivery/buffering_seeking_time_ranges) — seek bar implementation reference
- [Virtual Scrolling article — jsschools.com](https://jsschools.com/web_dev/virtual-scrolling-boost-web-app-performance-with-/) — virtual scroll pattern overview
- [WICG Virtual Scroller spec](https://wicg.github.io/virtual-scroller/) — browser-native virtual scroll (still experimental, not production-ready)
- [Apple Music navigation analysis — Mikołaj Biernat](https://mikolajbiernat.com/blog/stuck-in-the-library-exploring-apple-music-s-navigation) — music library tab UX patterns
- [Music streaming UI/UX patterns — A3Logics](https://www.a3logics.com/blog/ui-ux-for-music-streaming-apps/) — industry navigation conventions
