# Technology Stack

**Project:** Stagehand v2.0 — Library & Player Enhancement
**Researched:** 2026-03-24
**Scope:** NEW stack additions only. Existing stack (rubberband-web, AudioWorklet, Web Audio API, IndexedDB, vanilla ES modules) is validated and unchanged.

---

## New Library Requirements

Three capabilities need external library support. Everything else (progress bar, tabs, alphabetical sort, auto-play) is pure vanilla JS with no new dependencies.

| Capability | Library Needed? | Rationale |
|------------|----------------|-----------|
| ID3 metadata parsing | YES — jsmediatags | Format-aware tag parsing is not trivial to implement correctly for ID3v1/v2/FLAC/MP4 |
| Virtual scrolling | NO — implement inline | ~50 lines of vanilla JS is the right call for a fixed-height list with uniform row heights |
| Playlist management | NO | Pure IndexedDB + vanilla JS; no library needed |
| Progress bar scrubbing | NO | `requestAnimationFrame` + pointer events; no library needed |
| Library tabs | NO | CSS + JS tab switching; no library needed |
| IndexedDB schema migration | NO | Native `onupgradeneeded` pattern; no library needed |

---

## Recommended Stack — New Additions Only

### ID3 Metadata Parsing

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| jsmediatags | 3.9.5 | Parse ID3v1, ID3v2, FLAC, MP4 tags from audio files on import | Ships a pre-built UMD browser bundle (`dist/jsmediatags.min.js`). No build step. Loads via `<script src>` and exposes `window.jsmediatags`. Works from `ArrayBuffer` via `BlobReader`. Available on cdnjs and jsDelivr. |

**Confidence: MEDIUM** — jsmediatags 3.9.5 is confirmed on cdnjs. UMD browser bundle is the established pattern (cdnjs source confirms). ArrayBuffer support via `BlobReader` is documented (convert ArrayBuffer to Blob, pass Blob to jsmediatags). Active enough for this use case; last commit history shows maintenance through 2023. No known replacement as of research date.

**OGG/Vorbis caveat:** jsmediatags does NOT support Ogg Vorbis comments. It covers ID3v1, ID3v2 (MP3), MP4, and FLAC. For OGG files, the app must fall back to filename-only display. This is acceptable — OGG is uncommon in rehearsal track libraries and users can rename tracks in the existing UI.

**Why not music-metadata-browser:** music-metadata-browser 2.5.11 (latest) is described as a "browserified" (Browserify output) CommonJS bundle. Getting it to work as a native ES module import without a bundler requires routing through esm.sh CDN (adds external runtime dependency) or importing a UMD build that was never the design target. jsmediatags's `dist/jsmediatags.min.js` is explicitly built for `<script src>` browser use. Simpler, more reliable for the no-build constraint. music-metadata-browser would be the right choice if a build step were acceptable.

**Why not parsing manually (hand-rolled ID3 reader):** ID3v2 has ~15 frame types, unsynchronisation encoding, extended headers, and various encoding variants. jsmediatags handles all of this. Re-implementing it is weeks of work with high correctness risk.

### CDN Delivery

| Source | URL | Use |
|--------|-----|-----|
| cdnjs (primary) | `https://cdnjs.cloudflare.com/ajax/libs/jsmediatags/3.9.5/jsmediatags.min.js` | Script tag in index.html. Confirmed version on cdnjs. |
| jsDelivr (fallback) | `https://cdn.jsdelivr.net/npm/jsmediatags@3.9.5/dist/jsmediatags.min.js` | If cdnjs unavailable |
| Local copy (offline) | `renderer/js/vendor/jsmediatags.min.js` | Download and vendor if offline support needed |

Load with a plain `<script src>` before the ES module entry point. It sets `window.jsmediatags` as a global. Access it from ES modules via `window.jsmediatags`.

---

## Virtual Scrolling — No Library Needed

Virtual scrolling for a fixed-height track list requires approximately 50 lines of vanilla JS. The algorithm is straightforward when row heights are uniform (they will be — all track cards use the same CSS height):

```
visibleStart = Math.floor(scrollTop / rowHeight)
visibleEnd   = Math.min(totalTracks, visibleStart + Math.ceil(containerHeight / rowHeight) + buffer)
paddingTop   = visibleStart * rowHeight
paddingBottom = (totalTracks - visibleEnd) * rowHeight
```

Render only rows `[visibleStart, visibleEnd)` into the DOM. Set `paddingTop`/`paddingBottom` on the list container to maintain correct scrollbar position.

**Why not HyperList:** HyperList (1.0.0, ~270 lines, available on jsDelivr) is a reasonable choice but adds a dependency for code that's genuinely shorter than the library overhead. It also requires fixed `itemHeight` — same constraint as the hand-rolled version. Not worth the CDN request.

**Why not virtual-scroller npm:** Requires build tooling.

**Threshold for reconsideration:** If track cards end up with variable height (e.g., expanded states), reaching for HyperList or vscroll is appropriate.

---

## IndexedDB Schema Migration

The existing `stagehand_db` version 1 schema needs new fields for metadata (artist, album, title, duration) and a new object store for playlists.

**Approach: Increment DB_VER to 2, use `onupgradeneeded` to add new object store and iterate existing records.**

No library needed. The native IndexedDB `onupgradeneeded` pattern handles this correctly:

```js
const DB_VER = 2;

req.onupgradeneeded = e => {
  const db = e.target.result;
  const oldVersion = e.oldVersion;

  if (oldVersion < 2) {
    // Add playlists store
    const ps = db.createObjectStore('playlists', { keyPath: 'id' });
    ps.createIndex('name', 'name', { unique: false });

    // Existing 'tracks' records get new fields on next read/write
    // No cursor migration needed — JS reads undefined fields as undefined,
    // which the UI treats as "no metadata" (falls back to filename).
  }
};
```

**Tracks schema additions** (fields added lazily on next `saveMeta()` call — no cursor migration needed):
- `artist` String | undefined
- `album` String | undefined
- `title` String | undefined
- `duration` Number | undefined (seconds, float)

**New object store: `playlists`** (keyPath: `id`)
```js
{
  id:        String,   // "pl_<timestamp>_<random>"
  name:      String,   // display name
  trackIds:  Array,    // ordered array of track IDs
  createdAt: Number    // Date.now()
}
```

**Confidence: HIGH** — standard IndexedDB migration pattern, documented on MDN. No external library needed.

---

## What NOT to Add

| Option | Why Not |
|--------|---------|
| music-metadata-browser | Browserify bundle — not designed for direct `<script type="module">` import without a bundler. Avoid unless migrating to a build step. |
| Dexie.js | Excellent IndexedDB wrapper but adds ~50KB dependency for schema management that the native API handles fine for this two-store schema. |
| HyperList / virtual-scroller | Unnecessary dependency for a uniform fixed-height list; ~50 lines of vanilla JS is sufficient. |
| SortableJS for playlist reorder | Drag-and-drop playlist reordering can be implemented with HTML5 drag events in ~80 lines. If that proves insufficient, SortableJS (CDN available) is an acceptable addition — but defer until needed. |
| Tone.js | Not relevant to any v2.0 feature. |
| Any React/Vue/framework | Explicit project constraint: no build step, vanilla JS modules. |
| esm.sh CDN proxy | Adds a runtime CDN dependency to circumvent bundler requirements. Any library that needs esm.sh to work in a no-build project is the wrong library choice. |

---

## Integration Points with Existing Modules

| New Capability | Integrates With | How |
|----------------|----------------|-----|
| ID3 parsing | `library-manager.js` | Parse tags during import (inside `save()`'s caller in ui-controller.js), store `artist`/`album`/`title`/`duration` alongside existing fields. `window.jsmediatags` available as global — call before the IDB `save()`. |
| Virtual scrolling | `ui-controller.js` | Replace `buildTrackCard()` loop with a virtual list renderer. Scroll event listener on the list container. |
| Playlists store | `library-manager.js` | Add `allPlaylists()`, `savePlaylist()`, `removePlaylist()` exports. Same pattern as existing `all()`, `save()`, `remove()`. |
| Playlist playback | `track-player.js` + `ui-controller.js` | Active playlist tracked in ui-controller state. `track-player.js` `onended` callback advances to next track in playlist order. |
| Progress bar | `track-player.js` + `ui-controller.js` | `requestAnimationFrame` loop reads `AudioContext.currentTime - startTime` for elapsed position. Seek on mouseup maps click position to time offset, calls existing seek logic. |

---

## Delivery Summary

```html
<!-- index.html — load order matters -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/jsmediatags/3.9.5/jsmediatags.min.js"></script>
<script type="module" src="./js/ui-controller.js"></script>
```

No other new `<script>` or `<link>` tags required for v2.0 features.

---

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| ID3 parsing | jsmediatags 3.9.5 (UMD, CDN) | music-metadata-browser | CommonJS browserify bundle; no clean ES module CDN path without esm.sh proxy |
| ID3 parsing | jsmediatags | Hand-rolled parser | ID3v2 complexity (unsync, frames, encodings) makes this weeks of work for low payoff |
| Virtual scrolling | Vanilla JS (~50 lines) | HyperList | Unnecessary dependency; same fixed-height constraint; code is shorter than the library |
| IDB schema | Native onupgradeneeded | Dexie.js | ~50KB for schema management the native API handles fine |
| Playlist DnD reorder | HTML5 drag events | SortableJS | Defer until native events prove insufficient |

---

## Sources

- jsmediatags on cdnjs (version confirmed): https://cdnjs.com/libraries/jsmediatags
- jsmediatags GitHub (format support): https://github.com/aadsm/jsmediatags
- music-metadata-browser npm (version 2.5.11, last published ~1 year ago): https://www.npmjs.com/package/music-metadata-browser
- music-metadata-browser GitHub (browserify origin): https://github.com/Borewit/music-metadata-browser
- HyperList GitHub (virtual scroll, zero-dep): https://github.com/tbranyen/hyperlist
- IndexedDB migration pattern — MDN: https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB
- esm.sh CDN (why avoided): https://esm.sh/
