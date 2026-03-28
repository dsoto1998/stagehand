# Domain Pitfalls: v2.0 Library & Player Enhancement

**Domain:** Adding ID3 metadata, virtual scrolling, library tabs, and playlists to an existing browser audio app
**Researched:** 2026-03-24
**Stack context:** Vanilla JS ES modules, no build step, Chrome + Firefox only, IndexedDB stagehand_db v1, rubberband-web@0.2.1 AudioWorklet, `http://localhost:8080/renderer/`

---

## Critical Pitfalls

Mistakes that cause data loss, silent failures, or rewrites.

---

### Pitfall 1: IndexedDB Schema Migration Can Block Indefinitely If an Old Tab Is Open

**What goes wrong:** You bump `DB_VER` from `1` to `2` to add the `playlists` object store. The browser fires `onupgradeneeded` on new page loads, but if any *other* tab (or a stale service worker) still holds an open connection to version 1, the upgrade transaction is blocked. The `open()` call silently hangs — `onsuccess` never fires, the app never loads, and there is no visible error without an `onblocked` handler.

**Why it happens:** IndexedDB uses a versioning lock. A new-version `open()` cannot run its `onupgradeneeded` until all connections to the old version are closed. In a single-tab app like Stagehand this is unlikely but possible: a forgotten tab, a browser crash that left a connection open, or browser DevTools holding a reference.

**Consequences:** App hangs silently on load after the migration ships. User cannot access their library.

**Prevention:**
- Add an `onblocked` handler to the `open()` call that surfaces a visible message: `req.onblocked = () => notify('Close other Stagehand tabs and reload', 'error');`
- Add `db.onversionchange = () => { db.close(); location.reload(); }` on the connection returned from `onsuccess`, so that if another tab opens with a newer version, the current tab closes its connection rather than blocking it.
- Test the upgrade path explicitly: open the app on v1, open a second tab, then deploy v2 and reload the second tab.

**Detection:** App hangs at "READY" status never appearing. `onblocked` event fires (only if you listen for it).

**Phase:** Phase that introduces the `playlists` store (DB version bump).

**Confidence:** HIGH — documented IndexedDB versioning behavior per MDN and W3C spec.

---

### Pitfall 2: IndexedDB `onupgradeneeded` Must Handle All Historical Versions, Not Just N-1

**What goes wrong:** You write `onupgradeneeded` assuming users are upgrading from v1. But the function receives `event.oldVersion`, which could be `0` (brand-new install) or `1` (existing user). If you unconditionally call `d.createObjectStore('playlists', ...)` without checking `!d.objectStoreNames.contains('playlists')` or using `oldVersion` guards, a fresh install that creates all stores at once will throw `DOMException: IDBObjectStore already exists`.

**Why it happens:** `onupgradeneeded` fires for both schema upgrades AND first-time database creation (`oldVersion === 0`). The migration code must be written as a series of idempotent version-range checks, not a single `if (oldVersion === 1)`.

**Consequences:** App throws on first load for new users; existing users upgrade fine. The bug is invisible during development if you only test upgrades, not fresh installs.

**Prevention:**
```js
req.onupgradeneeded = e => {
  const d = e.target.result;
  const old = e.oldVersion;

  // v1 schema (always create if missing)
  if (old < 1) {
    if (!d.objectStoreNames.contains('tracks')) {
      const s = d.createObjectStore('tracks', { keyPath: 'id' });
      s.createIndex('name', 'name', { unique: false });
    }
  }

  // v2 schema additions
  if (old < 2) {
    if (!d.objectStoreNames.contains('playlists')) {
      const p = d.createObjectStore('playlists', { keyPath: 'id' });
      p.createIndex('name', 'name', { unique: false });
    }
  }
};
```
- Always test on a completely clean origin (DevTools → Application → Storage → Clear site data) as well as on an existing v1 install.

**Detection:** `DOMException: Failed to execute 'createObjectStore'` on first install after you ship the migration.

**Phase:** Phase introducing the `playlists` store.

**Confidence:** HIGH — `oldVersion === 0` on fresh install is specified behavior; guard pattern is standard practice per MDN.

---

### Pitfall 3: IndexedDB ArrayBuffer Transfer Breaks ID3 Parsing If You Re-Use the Same Buffer

**What goes wrong:** The current import flow already has the `ab.slice(0)` pattern to keep a live in-memory copy after the IDB `put()` detaches the original ArrayBuffer. If ID3 parsing is added *between* the `file.arrayBuffer()` call and the IDB `save()`, and the ID3 library internally reads the ArrayBuffer in a way that detaches or consumes it, the IDB save receives a zero-byte or detached buffer.

More concretely: `jsmediatags` and `music-metadata` both operate on `ArrayBuffer` or `File`/`Blob`. If you pass your *only* copy of the `ArrayBuffer` to the ID3 parser and the parser transfers it (some internal readers do this), the buffer is gone before you save it.

**Why it happens:** Some `ArrayBuffer` consumers use `Transferable` semantics. Even if a library does not transfer, the safe assumption is that you do not control what it does internally.

**Consequences:** Track is saved to IndexedDB with a zero-byte or detached ArrayBuffer. Audio decoding fails on next app load with an opaque `DOMException` that looks like a format error.

**Prevention:**
- Parse ID3 tags from the `File` object directly (pass `file` to `jsmediatags.read(file, ...)`), not from the `ArrayBuffer`. The `File` object is a reference-counted Blob — it cannot be detached.
- Alternatively, slice the ArrayBuffer *before* parsing: `const abForId3 = ab.slice(0); const abForMemory = ab.slice(0);` then pass `abForId3` to the ID3 parser and keep `abForMemory` and `ab` (for IDB) separate.
- The safest order: parse ID3 from `File`, then call `file.arrayBuffer()` for the IDB save, keeping slices as the existing code already does.

**Detection:** Track imports appear to succeed, but on next app reload all tracks show no waveform and playback fails with a decode error.

**Phase:** ID3 metadata parsing phase.

**Confidence:** HIGH — ArrayBuffer transfer/detach behavior is specified by the Structured Clone algorithm and is already a known hazard in this codebase.

---

### Pitfall 4: `music-metadata` (npm) Requires a Bundler; Use `jsmediatags` via CDN Script Tag Instead

**What goes wrong:** `music-metadata` v8+ is pure ESM but is designed for Node.js and bundled browser environments. Its imports chain through Node.js shims and path aliases that break when loaded via a bare `<script type="module">` import from a CDN URL. `music-metadata-browser` (the browser fork) is similarly bundler-oriented and its CDN build is not maintained in a reliable no-bundler-friendly form.

**Why it happens:** The package uses internal relative imports and conditional exports that rely on the bundler to resolve Node vs browser entry points. Without a bundler, bare CDN imports fail with module resolution errors.

**Consequences:** You spend time debugging `import` errors and `process is not defined` errors before discovering the library is not designed for no-bundler browser use.

**Prevention:**
- Use `jsmediatags` (version 3.9.x) instead. It ships a ready-to-use `dist/jsmediatags.min.js` that works as a plain `<script src="...">` tag or can be copied locally. Available on cdnjs: `https://cdnjs.cloudflare.com/ajax/libs/jsmediatags/3.9.5/jsmediatags.min.js`.
- Copy `jsmediatags.min.js` into `renderer/js/vendor/` and load it with a non-module `<script>` tag before `renderer/js/ui-controller.js`. It registers a global `jsmediatags`.
- Use the `File` object (not `ArrayBuffer`) as the read target: `jsmediatags.read(file, { onSuccess, onError })`.

**Warning signs:** `Cannot find module 'node:buffer'`, `process is not defined`, or cascading import resolution errors when trying to use `music-metadata` via CDN.

**Phase:** ID3 metadata parsing phase.

**Confidence:** MEDIUM — music-metadata's no-bundler incompatibility is inferred from its module structure and confirmed by the npm docs note that "modules don't run directly in the browser without a module bundler". jsmediatags CDN availability is confirmed via cdnjs.com search results.

---

### Pitfall 5: ID3 Tags Are Missing on WAV and FLAC Files — Duration Is the Only Reliable Field

**What goes wrong:** `jsmediatags` reads ID3v1/v2 tags (on MP3), MP4 tags (M4A), and Vorbis comments (OGG/FLAC). However:
- WAV files rarely have embedded ID3 tags. Most WAV files from recording software have no artist/title/album metadata at all.
- FLAC Vorbis comment field names are case-insensitive and non-standard — `ARTIST` vs `artist` vs `Artist` are all valid.
- Duration is **not** reliably available from jsmediatags tag headers. ID3v2 tags do not embed duration; it must be calculated from frame headers or decoded audio.

**Consequences:** If you display artist/title from ID3 tags, most WAV tracks (which are the most common format for session musicians) will show empty artist/title fields. If you try to get duration from ID3, it will be missing for many files.

**Prevention:**
- Treat all ID3 fields as optional. Default to the filename (current behavior) when artist/title are absent.
- Get duration from `AudioContext.decodeAudioData` — the decoded `AudioBuffer.duration` is always accurate. This is already happening in `buildTrackCard()` via `player.loadBuffer()`. Store this value in the track record when first decoded.
- Display fallback hierarchy: `title tag || filename`, `artist tag || ''`.
- For the `Artists` tab grouping, tracks with no artist tag should be grouped under an "Unknown Artist" bucket, not silently dropped.

**Detection:** Artists tab shows only a fraction of the library; most tracks have no ID3 artist tag.

**Phase:** ID3 parsing + Artists tab phase.

**Confidence:** HIGH — WAV ID3 support and duration-from-tags limitations are well-documented ID3 format constraints.

---

### Pitfall 6: Virtual Scrolling Breaks the `card-${id}` DOM Lookup Pattern Throughout the Codebase

**What goes wrong:** The current codebase uses `document.getElementById('card-' + id)` in multiple places: miniplayer play/pause sync, prev/next navigation, and the `players` object callbacks. Virtual scrolling means cards are removed and re-added to the DOM as the user scrolls. A card that is currently off-screen has no DOM element. Any code path that calls `document.getElementById('card-' + id)` and then accesses properties of the result will silently fail or throw a null reference error.

Specific failure sites in the current code:
- `mp-prev`/`mp-next` click handlers: `card.querySelector('.track-play-btn').click()` — `card` is null if the target track is scrolled out of view.
- `player.onEnd` callback: `card.classList.remove('playing')` — `card` is null if playback ends while the card is off-screen.
- Semitone slider sync: `card.querySelector('.track-semitones')` — card is null if the track is off-screen when miniplayer slider moves.

**Why it happens:** Virtual scrolling intentionally unmounts off-screen DOM nodes. All code that couples audio state to DOM elements by ID will break.

**Consequences:** Silent failures in miniplayer controls and playback state sync. The "playing" CSS class gets stuck on or off. Changing transpose in the miniplayer does not update the track card when you scroll back to it.

**Prevention:**
- Decouple audio state from DOM state. Maintain a separate JS object for playback state (playing, paused, current position, semitones, volume) and have DOM elements read from it when they render, rather than writing to each other directly.
- When a card re-enters the viewport, re-initialize it from the state object (not from DOM queries).
- Replace `document.getElementById('card-' + id)` with a function that returns `null` gracefully and is called only when you expect the card to be in the DOM.
- Minimum approach: wrap all `getElementById('card-' + id)` call sites with null guards before adding virtual scrolling.

**Detection:** Prev/next in miniplayer silently does nothing for tracks that are scrolled out of view.

**Phase:** Virtual scrolling phase. Must audit all DOM-to-audio coupling before implementing virtual scroll.

**Confidence:** HIGH — the exact failure sites are visible in the current codebase source.

---

### Pitfall 7: Virtual Scrolling + Canvas Waveforms — Eager Decode of All Tracks Will OOM on Large Libraries

**What goes wrong:** `buildTrackCard()` currently calls `player.loadBuffer(abCopy)` in the background for every track when the library loads. This is fine for small libraries. With virtual scrolling and 500 tracks, this decodes 500 audio files into `AudioBuffer` objects simultaneously. A 4-minute stereo MP3 at 44100 Hz occupies ~80MB as a decoded `AudioBuffer` (Float32 PCM). 500 such tracks = ~40 GB. The tab will crash long before reaching that.

**Why it happens:** The current eager-decode approach was designed for small libraries. Virtual scrolling expands the viable library size, but the eager decode does not scale with it.

**Consequences:** Tab crashes or browser OOM kill. Even at 50 tracks with large files, memory pressure causes sluggishness and audio glitches.

**Prevention:**
- Decode lazily: only call `loadBuffer()` when a card enters the viewport (intersection observer) or when the user explicitly plays a track.
- Store pre-computed waveform peak data in the track record (IndexedDB or in-memory) so the waveform canvas can render from peaks without a full `AudioBuffer` decode.
- Keep at most N decoded `AudioBuffer` objects in memory (LRU cache). Release buffers for tracks not in the visible window or recently played. `player.buffer = null` is sufficient; the GC will reclaim the memory.
- The `AudioBuffer` for the currently playing track must never be released.

**Detection:** Memory tab in DevTools shows linear memory growth as a large library loads. Tab becomes sluggish or crashes.

**Phase:** Virtual scrolling + lazy decode phase. This is the core architectural challenge of v2.0.

**Confidence:** HIGH — AudioBuffer memory math is deterministic from Web Audio spec; 44100 × 2 channels × 4 bytes × 240 seconds = ~84 MB per track.

---

## Moderate Pitfalls

---

### Pitfall 8: Scrubbable Progress Bar — `mousedown` + `mousemove` Seek Pattern Causes Audio Restart Spam

**What goes wrong:** A naive scrub implementation that calls `player.seek()` on every `mousemove` event during drag will call `player.play()` (which rebuilds the audio graph including the rubberband AudioWorkletNode) on every pixel the user moves the mouse. At typical mouse movement rates (50–100 events/second), this fires `stop()` + `play()` + WASM graph reconstruction 50–100 times per second. The result is silent or glitchy audio and potential AudioContext node leaks.

**Why it happens:** The current `seek()` implementation in `track-player.js` calls `this.play(t)` if `wasPlaying`. `play()` calls `stop()` then creates new audio nodes. Each call creates a `GainNode`, optionally an `AudioWorkletNode`, and a `BufferSourceNode`. Even if `stop()` disconnects them, rapid creation/destruction at 60fps generates observable audio artifacts and possible leaked nodes.

**Prevention:**
- Implement scrub as: `mousedown` → set a `scrubbing = true` flag and pause audio (note position); `mousemove` → update progress bar UI and `pauseOffset` only (no `play()` call); `mouseup` → call `seek()` once with the final position, then resume if was playing.
- This pattern provides visual feedback during drag without audio restart spam.
- The existing waveform `click` handler already does a single seek on click — extend this pattern for drag by separating the UI update from the audio restart.

**Detection:** Audible stuttering or silence when dragging the progress bar slowly across a transposed track.

**Phase:** Miniplayer scrubbable progress bar phase.

**Confidence:** HIGH — the `seek()` → `play()` call chain is directly visible in the current `track-player.js` source; the mousemove frequency problem is a standard Web Audio design consideration.

---

### Pitfall 9: Progress Bar `requestAnimationFrame` Loop Is Per-Card — Will Explode with Many Cards

**What goes wrong:** Each `TrackPlayer` runs its own `requestAnimationFrame` loop (`_tick()`) while playing, calling `onProgress` at every frame (~60fps). Currently one track plays at a time, so there is one rAF loop. With virtual scrolling, if the implementation creates a `TrackPlayer` per track (as the current code does), all `players` objects exist simultaneously. Even paused players that have been touched will have rAF loops if not carefully cancelled.

Additionally, the miniplayer progress bar needs its own `requestAnimationFrame` loop for smooth elapsed time display.

**Prevention:**
- Ensure `cancelAnimationFrame(this._rafId)` is called in `stop()` and `pause()` — it already is in the current code, so this is a maintenance concern: do not break this invariant when refactoring.
- Miniplayer progress bar: share the playing track's `onProgress` callback rather than running a separate loop. The `TrackPlayer` already fires `onProgress(frac, t)` at 60fps — the miniplayer just needs to register as a listener.
- If virtual scroll recycles DOM nodes, make sure the `onProgress` callback is re-assigned when a card re-enters the viewport (to the correct player for that card), and cleared when the card leaves.

**Detection:** Jank or high CPU in DevTools Performance tab showing many overlapping rAF callbacks.

**Phase:** Miniplayer progress bar + virtual scrolling.

**Confidence:** HIGH — the rAF loop pattern is directly visible in `track-player.js`; the concern is preventing regressions when refactoring, not fixing a current bug.

---

### Pitfall 10: Playlist Track References Going Stale After Track Deletion

**What goes wrong:** A playlist stores an ordered list of track IDs (e.g., `{ id: 'pl_...', name: 'Set 1', trackIds: ['trk_...', 'trk_...'] }`). If the user deletes a track from the library, those track IDs remain in any playlists that referenced the track. On next load, iterating `trackIds` and looking up each ID in the `tracks` array will return `undefined` for deleted tracks. If the playlist playback code does not guard against missing tracks, it will crash or silently skip.

**Why it happens:** IndexedDB does not have foreign key constraints or cascading deletes. The app must enforce referential integrity in application code.

**Consequences:** `tracks.find(t => t.id === id)` returns `undefined`; subsequent property access throws. Or tracks silently disappear from playlists with no user feedback.

**Prevention:**
- On track delete: before removing from the `tracks` store, scan all playlists and remove the track ID from any playlist that contains it. Use a multi-store transaction for atomicity.
- On playlist render: always filter `trackIds` against the in-memory `tracks` array and display a "(deleted)" placeholder or silently skip missing entries — never crash.
- Consider showing a warning: "This playlist contains 2 deleted tracks. Remove them?" rather than silently pruning.

**Detection:** Playlist with a deleted track throws on playback start or shows wrong track count.

**Phase:** Playlists phase.

**Confidence:** HIGH — foreign key integrity in IndexedDB is a standard application-code responsibility.

---

### Pitfall 11: Playlist Reorder (Drag and Drop) State Must Be Persisted Immediately — `tracks` Array Is Separate from Playlist Order

**What goes wrong:** The current library stores tracks in the `tracks` object store with no inherent order (fetched via `getAll()`, displayed in whatever order IndexedDB returns them). Playlists impose their own ordering via `trackIds`. If the user reorders a playlist and you only update the in-memory array without persisting to IndexedDB, the order is lost on page refresh.

A subtler issue: SortableJS (the recommended no-dependency drag-to-reorder library) fires `onEnd` after each drop. If you forget to call `saveMeta()` (or the playlist equivalent) inside `onEnd`, reorders appear to work but are not persisted.

**Prevention:**
- On every drag-and-drop reorder completion (`onEnd` event), immediately write the new `trackIds` array to IndexedDB.
- SortableJS is a good fit here — no build step needed, can be loaded via CDN or copied locally as a single JS file, has no jQuery dependency.
- The `playlists` store's `saveMeta` equivalent should accept `{ id, trackIds }` and merge into the existing record (same pattern as `saveMeta` in `library-manager.js`).

**Detection:** Playlist order is correct during the session but reverts to original order on page reload.

**Phase:** Playlists phase.

**Confidence:** HIGH — persistence-after-reorder is a straightforward design requirement; the failure mode is well-known in all list-management UIs.

---

### Pitfall 12: Library Tab Switching Destroys and Recreates the Track List — Waveform Canvases Must Be Re-Rendered

**What goes wrong:** If the Songs/Artists/Playlists tabs are implemented by hiding/showing DOM sections, and if tab switching triggers `renderTrackList()`, all track cards are rebuilt from scratch. Each rebuild calls `buildTrackCard()` which triggers `renderWaveform()`. With a large library and eager decode, this causes a re-decode or re-render storm every time the user switches tabs.

**Why it happens:** The current `renderTrackList()` calls `list.querySelectorAll('.track-card').forEach(el => el.remove())` then rebuilds all cards. If this is triggered on tab switch, it re-runs for every switch.

**Prevention:**
- Tab switching should show/hide content, not rebuild it. Use `display: none` / `display: ''` or `visibility: hidden` on tab content containers. Rebuild only when the underlying data changes (import, delete).
- Alternatively, maintain a dirty flag: only call `renderTrackList()` when `libraryDirty = true`, not on every tab activation.
- Waveform peak data should be stored in memory per track (or in IndexedDB) so re-renders are fast (no re-decode needed).

**Detection:** Noticeable lag when switching tabs with a large library; audio glitches if switching tabs while a track plays.

**Phase:** Library tabs phase.

**Confidence:** HIGH — the rebuild-on-switch pattern is directly visible in the current DOM management code.

---

## Minor Pitfalls

---

### Pitfall 13: `artists` Tab Requires a Stable Grouping Key — Artist Name Normalization

**What goes wrong:** ID3 `artist` tags are not normalized. The same artist may appear as "The Beatles", "Beatles, The", "BEATLES", or "beatles" in different files. Each variant will create a separate artist bucket in the Artists tab.

**Prevention:**
- Normalize for display grouping: `artist.trim().toLowerCase()` for the grouping key; display the original casing in the UI.
- This is a known limitation of tag-based grouping. Document it rather than building complex normalization — the target user base (individual musicians) typically controls their own file tags.

**Phase:** Artists tab phase. Minor but worth noting upfront.

**Confidence:** HIGH — a universal limitation of tag-based music library software.

---

### Pitfall 14: `jsmediatags` Parses Tags Asynchronously — Concurrent Batch Import Needs Rate Limiting

**What goes wrong:** The current `importFiles()` loop processes files sequentially with `for...of` + `await`. If you add `jsmediatags.read()` calls inside this loop, each parse is a new asynchronous callback-style operation. If you parallelize with `Promise.all`, parsing 50 files simultaneously is fine, but decoding 50 `ArrayBuffer`s and saving 50 IndexedDB records simultaneously can exceed IDB write throughput and cause `UnknownError` or timeout failures.

**Prevention:**
- Keep the sequential import pattern (current `for...of` loop). Parse ID3, then save, then next file. This is slower but safe.
- For UX, show a progress indicator: "Importing 3 of 50..." rather than a spinner.
- Promisify `jsmediatags.read()`: `const tags = await new Promise((res, rej) => jsmediatags.read(file, { onSuccess: res, onError: rej }));`

**Detection:** Import of a batch of 20+ files fails partway through with `UnknownError` in the IndexedDB save.

**Phase:** ID3 metadata parsing phase.

**Confidence:** MEDIUM — IDB write throughput limits are not precisely documented but batch write failures are a commonly reported developer experience issue.

---

### Pitfall 15: `prev`/`next` Navigation in Playlists vs. Library — Two Different Orderings

**What goes wrong:** The current `mp-prev`/`mp-next` handlers navigate by `tracks` array index (the full library order). Once playlists exist, "next" should mean "next in the current playlist" when a playlist is active, and "next in the library" otherwise. If you do not track which context is active (library Songs tab vs. a specific playlist), prev/next will always use the library order, ignoring playlist order.

**Prevention:**
- Add a `playbackContext` state variable: `{ type: 'library' | 'playlist', playlistId: string | null }`.
- `mp-prev`/`mp-next` handlers read `playbackContext` to determine which ordered list to step through.
- When a track is played from a playlist card, set `playbackContext = { type: 'playlist', playlistId: id }`. When played from the Songs tab, set `type: 'library'`.
- `player.onEnd` (auto-advance to next track) must also respect `playbackContext`.

**Detection:** Playing a playlist and pressing Next plays the wrong next track (library order instead of playlist order).

**Phase:** Playlists phase.

**Confidence:** HIGH — the two-ordering problem is a logical consequence of having both a flat library view and playlists.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| DB version bump for playlists store | Migration blocks if old tab is open | Add `onblocked` handler + `db.onversionchange` close-and-reload |
| DB version bump for playlists store | Fresh-install fails if createObjectStore guards missing | Guard with `oldVersion < N` checks AND `!contains()` checks |
| ID3 parsing on import | ArrayBuffer detached before IDB save | Parse from `File` object, not `ArrayBuffer`; or slice before parsing |
| ID3 library choice | `music-metadata` needs bundler | Use `jsmediatags` via script tag; copy to `renderer/js/vendor/` |
| ID3 fields | Missing artist/title for WAV/FLAC | Treat all tag fields as optional; derive duration from AudioBuffer |
| Artists tab | Case and spacing variants create duplicate artist buckets | Normalize grouping key; display original casing |
| Library tabs | Tab switch triggers full card rebuild + decode | Use show/hide, not rebuild; dirty-flag pattern |
| Virtual scrolling | `document.getElementById('card-' + id)` returns null for off-screen cards | Null-guard all card lookups; decouple audio state from DOM |
| Virtual scrolling | Eager decode OOMs on large library | Lazy decode on viewport entry; LRU buffer cache |
| Scrubbable progress bar | `mousemove` calls `seek()` → `play()` at 60fps | Scrub = UI-only during drag; single `seek()` call on `mouseup` |
| Playlist reorder | Drag-to-reorder not persisted | Write `trackIds` to IDB in `onEnd` callback |
| Playlist deletion | Dangling track IDs in playlist records | Cascade-delete track IDs from all playlists on track delete |
| Playlist playback context | `prev`/`next` ignores playlist ordering | Track `playbackContext` state; miniplayer reads it |
| Batch import with ID3 | Parallel IDB writes fail on large batches | Keep sequential import loop; promisify jsmediatags |
| Virtual scroll + rAF | Multiple rAF loops per card | Ensure `cancelAnimationFrame` is called on all player stop/pause paths |

---

## Sources

- [MDN: Using IndexedDB — upgradeneeded, onblocked](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB) — HIGH confidence
- [MDN: IDBOpenDBRequest upgradeneeded event](https://developer.mozilla.org/en-US/docs/Web/API/IDBOpenDBRequest/upgradeneeded_event) — HIGH confidence
- [MDN: AudioBufferSourceNode](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode) — HIGH confidence (start() once-only constraint)
- [jsmediatags GitHub](https://github.com/aadsm/jsmediatags) — MEDIUM confidence (current API surface verified via npm/cdnjs)
- [jsmediatags on cdnjs](https://cdnjs.com/libraries/jsmediatags) — HIGH confidence (CDN availability confirmed)
- [music-metadata npm](https://www.npmjs.com/package/music-metadata) — MEDIUM confidence (no-bundler incompatibility inferred from module structure)
- [Virtual scrolling core principles — LogRocket](https://blog.logrocket.com/virtual-scrolling-core-principles-and-basic-implementation-in-react/) — MEDIUM confidence (React-focused but principles apply)
- [SortableJS GitHub](https://github.com/SortableJS/Sortable) — HIGH confidence (no-framework drag-to-reorder)
- [MDN: Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria) — HIGH confidence
- Stagehand codebase direct analysis (`track-player.js`, `ui-controller.js`, `library-manager.js`) — HIGH confidence
