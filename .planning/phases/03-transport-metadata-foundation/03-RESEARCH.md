# Phase 3: Transport & Metadata Foundation — Research

**Researched:** 2026-03-25
**Domain:** Web Audio API transport controls + browser-side audio tag/metadata parsing
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Progress Bar Layout (TRANS-01, TRANS-02, TRANS-03)**
- Progress bar lives between the track name and the transport buttons, with elapsed/total time on its own row below it.
- Layout (top to bottom in `#sidebar-bottom`): Track Name → scrub bar → time display → transport buttons → Transpose row → Master Vol row.
- Seek behavior: seek fires on mouse-up (not on every drag tick).
- Implementation: styled `div` (not `input[type=range]`) for the scrub bar — mousedown/mousemove/mouseup.
- When no track is loaded: progress bar at 0, time shows `0:00 / --:--`.

**Metadata Display (META-01, META-02)**
- Show a subtitle line below the track name in track cards when ID3 tags are present.
- Format: `Artist · Album`, `Artist`, `Album`, or hidden (if both empty).
- Track display `name` is NOT replaced by ID3 title — existing user-editable name stays primary.
- ID3 data is supplementary display only.

**No-Tag Fallback**
- Keep filename-derived name as-is. Store `artist: ""`, `album: ""`, `title: ""` (empty strings, not null).
- No subtitle shown when all three are empty.

**Play with No Track (TRANS-04)**
- Sort by `track.name` (display name, alphabetical A→Z) to find first track.
- If library is empty, Play does nothing.

**IndexedDB Migration**
- Bump `DB_VER` to `2`. Add metadata fields lazily (no migration loop needed — undefined fields handled at read time).
- Also add `playlists` object store in this same migration (avoids a third bump in Phase 5).
- New fields on `tracks` store: `artist: String`, `album: String`, `title: String`, `duration: Number`.
- New store: `playlists` (keyPath: `id`) — created empty, populated by Phase 5.

**jsmediatags CDN**
- Already decided: `jsmediatags@3.9.5` via CDN `<script>` tag in `index.html`.

### Claude's Discretion

None surfaced during discussion.

### Deferred Ideas (OUT OF SCOPE)

None surfaced during discussion.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TRANS-01 | User can see a progress bar in the miniplayer showing current playback position | `_tick()` loop in TrackPlayer fires `onProgress(frac, t)` on every rAF — wire to `#mp-scrub-fill` width |
| TRANS-02 | Progress bar displays elapsed time and total track duration | `formatTime()` already exists in ui-controller.js; wire to `#mp-time-display`; duration from `player.duration` |
| TRANS-03 | User can scrub the progress bar to seek; seek applies on mouse-up | `TrackPlayer.seek(fraction)` already accepts 0–1 fraction; scrub bar needs mousedown/mousemove/mouseup; convert offsetX to fraction |
| TRANS-04 | Pressing Play with no track loaded starts the first alphabetical track | `currentPlayingId` guard in mp-play click handler; sort `tracks[]` by `name`, trigger first card's `.track-play-btn.click()` |
| META-01 | Artist, album, title, and duration are parsed from audio file tags on import | jsmediatags 3.9.5 via CDN; supports MP3 (ID3v1/v2) and FLAC; OGG/WAV return empty gracefully; duration from `AudioBuffer.duration` after decode |
| META-02 | Parsed metadata is stored in IndexedDB alongside the track | DB_VER bump to 2; add `artist`, `album`, `title`, `duration` fields to `tracks` store; `playlists` store created empty |
</phase_requirements>

---

## Summary

Phase 3 has two independent workstreams that share no code paths. The transport workstream (TRANS-01 through TRANS-04) is pure DOM wiring — the underlying playback infrastructure (`_tick()`, `onProgress`, `seek()`, `currentTime`, `duration`) is already fully implemented in `track-player.js`. The only work is inserting two new HTML elements (`#mp-scrub-bar` + `#mp-time-display`) into the miniplayer, adding CSS for them, and writing the mousedown/mousemove/mouseup scrub handler and the `onProgress` update in `ui-controller.js`. The existing `waveform-progress` div pattern (absolute-positioned fill div + border-right accent line) is the direct visual model for the scrub bar.

The metadata workstream (META-01, META-02) requires one external dependency: jsmediatags. The library is already decided at version 3.9.5 and is confirmed available on cdnjs. It reads MP3 (ID3v1 + ID3v2) and FLAC tags natively and accepts a File/Blob object directly — which means passing the raw `file` from the import flow. OGG Vorbis and WAV are not supported by jsmediatags; both formats trigger `onError` and are handled by the no-tag-fallback decision. Duration is always derived from `AudioBuffer.duration` (accurate regardless of format or tag data) and stored alongside the tag fields.

The IndexedDB migration is a version bump from 1 to 2 in `library-manager.js`. No data migration loop is required — undefined fields on old records are coalesced to empty strings at read time. The `playlists` object store is created in the same `onupgradeneeded` handler per the locked decision.

**Primary recommendation:** Implement workstreams independently. Transport first (pure DOM work, zero external dependencies), then metadata (requires jsmediatags CDN script tag in index.html first). The IDB migration lands as part of the metadata workstream since that is when the new fields are first written.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| jsmediatags | 3.9.5 (cdnjs) | Parse ID3v1/v2 (MP3) and FLAC tags in browser | Only maintained pure-browser tag reader with no build-step requirement; ships a single UMD bundle; confirmed available on cdnjs |
| Web Audio API (native) | Browser API | `AudioBuffer.duration`, `AudioContext.currentTime`, `requestAnimationFrame` | Already in use throughout the codebase; no additional dependency |

**Version note:** Latest npm version is 3.9.7 (published 2022-06-19). The locked decision pins 3.9.5 via cdnjs. Version 3.9.5 is confirmed available on cdnjs. No breaking changes between 3.9.5 and 3.9.7 are known; pinning to 3.9.5 is safe.

### CDN URL (confirmed available on cdnjs)
```
https://cdnjs.cloudflare.com/ajax/libs/jsmediatags/3.9.5/jsmediatags.min.js
```

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| jsmediatags | music-metadata-browser | Full ESM module, needs bundler or import maps — incompatible with no-build-step constraint |
| jsmediatags | id3js | MP3 only (no FLAC); less actively maintained |
| jsmediatags | manual binary parsing | Viable for MP3 ID3v2 but high implementation cost; ID3v2 spec is complex (unsynchronisation, frame flags, multi-byte encodings) |
| div-based scrub bar | `input[type=range]` | Range input fires on every tick by default; div gives direct control over drag state and supports fire-on-mouseup cleanly (locked decision) |

---

## Architecture Patterns

### Transport Workstream

#### How `_tick()` Already Works

`TrackPlayer._tick()` in `track-player.js` runs on every `requestAnimationFrame` while playing. It calls `this.onProgress(t / this.duration, t)` where `t` is `currentTime` in seconds. This callback is already wired in `buildTrackCard()` to update the card's waveform progress overlay and cur-time display. The miniplayer needs to hook into the same callback.

The critical constraint: `onProgress` is a single function slot per player. `buildTrackCard()` sets it. The miniplayer update must be added to the same callback, not replace it, because both the card waveform progress overlay and the miniplayer scrub bar must update simultaneously.

**Pattern: wrap the existing card onProgress inside buildTrackCard()**
```javascript
// After the card's onProgress is set, capture and wrap it:
const cardOnProgress = player.onProgress;
player.onProgress = (frac, t) => {
  cardOnProgress(frac, t);                        // card waveform + cur-time (existing)
  if (currentPlayingId === track.id) {
    updateMiniplayerProgress(frac, t);            // scrub bar + time display (new)
  }
};
```

This approach is clean because it co-locates all per-track UI updates in `buildTrackCard()`, which already owns the player configuration.

#### Scrub Bar Interaction Pattern

The UI-SPEC defines fire-on-mouseup seek. `mousemove` and `mouseup` must be attached to `document` (not the bar element) to handle mouse leaving the bar mid-drag.

```javascript
let seeking = false;
let seekFrac = 0;

const mpScrubBar = document.getElementById('mp-scrub-bar');
const mpScrubFill = document.getElementById('mp-scrub-fill');

function onScrubMove(e) {
  const rect = mpScrubBar.getBoundingClientRect();
  seekFrac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  mpScrubFill.style.width = (seekFrac * 100).toFixed(2) + '%';
}

function onScrubUp() {
  document.removeEventListener('mousemove', onScrubMove);
  document.removeEventListener('mouseup', onScrubUp);
  seeking = false;
  if (currentPlayingId && players[currentPlayingId]) {
    players[currentPlayingId].seek(seekFrac);
  }
}

mpScrubBar.addEventListener('mousedown', e => {
  if (!currentPlayingId) return;
  seeking = true;
  seekFrac = e.offsetX / mpScrubBar.offsetWidth;
  mpScrubFill.style.width = (seekFrac * 100).toFixed(2) + '%';
  document.addEventListener('mousemove', onScrubMove);
  document.addEventListener('mouseup', onScrubUp);
});
```

`TrackPlayer.seek(fraction)` accepts a 0–1 fraction (confirmed: `track-player.js` line 132 converts via `fraction * this.duration`).

**Guard tick updates during drag** — inside the wrapped `onProgress`:
```javascript
player.onProgress = (frac, t) => {
  cardOnProgress(frac, t);
  if (currentPlayingId === track.id) {
    if (!seeking) {
      mpScrubFill.style.width = (frac * 100).toFixed(2) + '%';
    }
    document.getElementById('mp-time-display').textContent =
      formatTime(t) + ' / ' + formatTime(player.duration);
  }
};
```

Time display always updates (even during drag), fill does not (to avoid fighting the drag position).

#### Play with No Track (TRANS-04)

Current `mp-play` click handler (ui-controller.js line 87) returns early if `!currentPlayingId`. The fix adds auto-start logic before the early return:

```javascript
document.getElementById('mp-play').addEventListener('click', () => {
  if (!currentPlayingId) {
    if (tracks.length === 0) return;
    const sorted = [...tracks].sort((a, b) => a.name.localeCompare(b.name));
    const first = sorted[0];
    const card = document.getElementById('card-' + first.id);
    if (card) card.querySelector('.track-play-btn').click();
    return;
  }
  // ... existing pause/play logic unchanged ...
});
```

`localeCompare` gives locale-aware A→Z sort. `[...tracks]` spread avoids mutating the source array.

#### Time Display Format

`formatTime()` already exists in ui-controller.js (lines 10–15) and handles `!isFinite(sec)` gracefully. No new utility needed.

- Playing: `formatTime(t) + ' / ' + formatTime(player.duration)`
- No track loaded: `'0:00 / --:--'` (set in `hideMiniplayer()`)
- Track loaded at start: set in `showMiniplayer()` using `player.duration` (available after `loadBuffer()`)

The `showMiniplayer()` function must also reset the scrub fill to 0% and set the total duration in the time display when called.

---

### Metadata Workstream

#### jsmediatags API

The library attaches to `window.jsmediatags` when loaded via `<script>` tag (UMD bundle). It accepts File, Blob, URL, and ArrayBuffer inputs. Passing the raw `File` object from the file import flow is the simplest approach — jsmediatags uses its `BlobFileReader` internally.

**Source files confirmed in repository:**
- `BlobFileReader.js` — handles File/Blob objects
- `ArrayBufferFileReader.js` — handles ArrayBuffer
- `FLACTagReader.js` — FLAC metadata
- `ID3v1TagReader.js` / `ID3v2TagReader.js` — MP3 metadata
- `MP4TagReader.js` — MP4/M4A (not needed for this project)

```javascript
jsmediatags.read(file, {
  onSuccess(result) {
    const tags = result.tags;
    // Available fields: artist, album, title, year, track, genre, picture, lyrics
    const artist = tags.artist || '';
    const album  = tags.album  || '';
    const title  = tags.title  || '';
  },
  onError(error) {
    // error.type: 'tagFormat' | 'byteRange' | etc.
    // OGG and WAV land here — not a crash
  }
});
```

jsmediatags is callback-based. Wrap in a Promise for `async/await` in `importFiles()`:

```javascript
function readTags(file) {
  return new Promise(resolve => {
    if (typeof jsmediatags === 'undefined') { resolve({}); return; }
    jsmediatags.read(file, {
      onSuccess(result) { resolve(result.tags || {}); },
      onError()         { resolve({}); }   // always resolve, never reject
    });
  });
}
```

Always resolve (never reject) so tag failure never aborts an import.

#### Format Support Matrix

| Format | jsmediatags Support | Fields Available | Fallback |
|--------|--------------------|--------------------|---------|
| MP3 | Full (ID3v1 + ID3v2) | artist, album, title, year, track, genre | Empty strings |
| FLAC | Full (VORBIS_COMMENT) | artist, album, title | Empty strings |
| OGG | Not supported | — | Empty strings (onError fires) |
| WAV | Not supported | — | Empty strings (onError fires) |

OGG and WAV fail gracefully via `onError`. The locked no-tag-fallback decision covers all four cases uniformly.

#### Duration: Deferred to Card-Render Time

Duration is derived from `AudioBuffer.duration` after `decodeAudioData`, never from tags. Options:

- **At import:** Call `decodeAudioData` immediately to get duration. Accurate but costs a second decode during import (the card later decodes the same buffer again).
- **Deferred to card-render:** Store `duration: 0` at import; update via `saveTrackMeta` in the `buildTrackCard()` `loadBuffer().then()` callback. The card already decodes there; no extra work.

**Recommendation: defer to card-render.** The `buildTrackCard()` loadBuffer path already has the duration in `player.duration` after decode. Add `if (!track.duration) saveTrackMeta({...track, duration: player.duration})` there. Duration is display-only in Phase 3 and is not a sort/filter key, so the deferred approach adds no observable gap for the user.

#### IndexedDB Migration

Current state: `DB_VER = 1`, single `tracks` object store, `name` index.

Required changes in `library-manager.js`:

```javascript
const DB_VER = 2;  // was 1

req.onupgradeneeded = e => {
  const d = e.target.result;

  // Tracks store: create if absent (fresh install), no schema changes for upgrade
  if (!d.objectStoreNames.contains('tracks')) {
    const s = d.createObjectStore('tracks', { keyPath: 'id' });
    s.createIndex('name', 'name', { unique: false });
  }
  // New fields (artist, album, title, duration) are added lazily:
  // existing records have undefined; read-time || '' / || 0 handles them.

  // Playlists store: created empty, Phase 5 populates it
  if (!d.objectStoreNames.contains('playlists')) {
    d.createObjectStore('playlists', { keyPath: 'id' });
  }
};
```

No migration loop is needed. `Object.assign` in `saveMeta()` already merges new fields into existing records when they are first updated.

#### Track Card Subtitle

New element inserted after `.track-name` in the `buildTrackCard()` HTML template:

```javascript
const subtitleText = [track.artist, track.album].filter(Boolean).join(' · ');
// In template:
`${subtitleText ? `<div class="track-subtitle">${escHtml(subtitleText)}</div>` : ''}`
```

`filter(Boolean)` handles all four cases: both present (`"Artist · Album"`), artist only (`"Artist"`), album only (`"Album"`), neither (empty string — element omitted). The separator is interpunct `·` (U+00B7) per the UI-SPEC copywriting contract.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| ID3 tag parsing | Custom binary parser for ID3v2 frames | jsmediatags 3.9.5 | ID3v2 has unsynchronisation bytes, extended headers, multi-byte encodings (Latin-1, UTF-16, UTF-8), frame-level flags — 50+ page spec. jsmediatags handles all of it. |
| FLAC VORBIS_COMMENT parsing | Custom FLAC block reader | jsmediatags FLACTagReader | FLAC metadata blocks require parsing the STREAMINFO/SEEK_TABLE header chain before reaching VORBIS_COMMENT. jsmediatags handles this correctly. |
| Audio duration | Custom header parser | `AudioBuffer.duration` after `decodeAudioData` | Already happening for playback; duration from the decoded buffer is always accurate regardless of format or tag data. |
| Progress tick loop | Second `requestAnimationFrame` loop | Existing `_tick()` in TrackPlayer | A second rAF loop on top of `_tick()` is redundant and could cause double-update flicker. Hook into the existing `onProgress` callback. |

---

## Common Pitfalls

### Pitfall 1: Replacing `onProgress` Instead of Wrapping It

**What goes wrong:** Assigning `player.onProgress = miniplayerUpdater` inside `showMiniplayer()` or the mp-play click handler replaces the card's onProgress. The card's waveform progress overlay stops updating.

**Why it happens:** `onProgress` is a single function slot on TrackPlayer. `buildTrackCard()` sets it; any later assignment overwrites it.

**How to avoid:** Wrap inside `buildTrackCard()` after the card's own handler is set. The card's handler captures the per-card DOM references in its closure; the miniplayer check (`currentPlayingId === track.id`) is evaluated at call time.

### Pitfall 2: ArrayBuffer Detachment in importFiles()

**What goes wrong:** `file.arrayBuffer()` returns one ArrayBuffer. If jsmediatags reads from it AND it's passed to `LibraryManager.save()`, the IDB `put()` transfers/detaches the buffer. Code that accesses it afterward gets a detached buffer error.

**Why it happens:** IndexedDB `put()` uses structured clone, which transfers ArrayBuffers. This is documented in CLAUDE.md ("IndexedDB `put()` uses the structured clone algorithm which transfers (detaches) ArrayBuffers").

**How to avoid:** Pass the raw `file` object (a File/Blob) to jsmediatags — it reads from the Blob source independently of the ArrayBuffer. Call `file.arrayBuffer()` after `readTags(file)` returns. This way jsmediatags never touches the ArrayBuffer at all.

```javascript
const tags = await readTags(file);    // reads from File (Blob), no ArrayBuffer involved
const ab = await file.arrayBuffer();  // now read the buffer
const abForMemory = ab.slice(0);      // existing pattern
```

### Pitfall 3: Scrub mousemove on Bar vs. Document

**What goes wrong:** Attaching `mousemove` to `#mp-scrub-bar` stops receiving events when the mouse moves outside the bar mid-drag. The fill freezes.

**Why it happens:** Mouse events stop firing on an element once the pointer leaves its bounding box.

**How to avoid:** Attach `mousemove` and `mouseup` to `document`. Remove them on `mouseup` to avoid handler leaks:
```javascript
function onScrubUp() {
  document.removeEventListener('mousemove', onScrubMove);
  document.removeEventListener('mouseup', onScrubUp);
  // ... finalize seek ...
}
```

### Pitfall 4: jsmediatags Failure on OGG/WAV Crashing Import

**What goes wrong:** `jsmediatags.read()` calls `onError` for OGG and WAV (format not supported). If this is not handled, the import loop can throw.

**Why it happens:** OGG Vorbis comments and WAV INFO chunks are absent from jsmediatags. `onError` fires with `type: 'tagFormat'`.

**How to avoid:** The `readTags()` wrapper always resolves (never rejects). `onError` returns `{}`. All tag fields default to `''`. The track is saved normally. Import of OGG and WAV files proceeds without interruption.

### Pitfall 5: Tick Updates Fighting Drag Visual Position

**What goes wrong:** The `onProgress` callback continues firing during drag and sets `mpScrubFill.style.width` based on `currentTime`, overwriting the fill position the user is dragging to. The fill jumps back on every tick.

**Why it happens:** `_tick()` runs every animation frame while `isPlaying` is true; there is no built-in pause on drag.

**How to avoid:** Check `if (!seeking)` before setting `mpScrubFill.style.width` inside `onProgress`. Time display text can still update during drag (does not interfere with the fill position).

### Pitfall 6: Duration in Time Display Before Buffer Is Loaded

**What goes wrong:** `showMiniplayer(trackId)` is called on play. If the player buffer was loaded but the card was not rendered (e.g., first play in a session where eager loading hasn't completed), `player.duration` is 0. The time display shows `0:00 / 0:00`.

**Why it happens:** `player.duration` is set inside `loadBuffer()`. `showMiniplayer()` runs at `await player.play()` time, which calls `loadBuffer()` first — so duration should be available. But the timing depends on the `buildTrackCard()` vs. play-button code path.

**How to avoid:** In `showMiniplayer()`, read `player.duration` after confirming `player.buffer` is set. The play-button handler in `buildTrackCard()` already calls `await player.loadBuffer()` before `await player.play()`, so duration is always set by the time `showMiniplayer()` is called from the play path. Set total time in `showMiniplayer()`:
```javascript
function showMiniplayer(trackId) {
  const track = tracks.find(t => t.id === trackId);
  const player = players[trackId];
  // ...existing fields...
  const totalStr = player && player.duration ? formatTime(player.duration) : '--:--';
  document.getElementById('mp-time-display').textContent = '0:00 / ' + totalStr;
  document.getElementById('mp-scrub-fill').style.width = '0%';
}
```

---

## Code Examples

Verified patterns from codebase source files and official library docs.

### jsmediatags Script Tag in index.html

```html
<!-- Source: cdnjs.com/libraries/jsmediatags — confirmed 3.9.5 available -->
<!-- Add before the module script -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/jsmediatags/3.9.5/jsmediatags.min.js"></script>
<script type="module" src="./js/ui-controller.js"></script>
```

### readTags() Utility (add to ui-controller.js)

```javascript
// Source: jsmediatags README API (aadsm/jsmediatags)
// Always resolves — tag failure never aborts import.
// Pass File object, NOT ArrayBuffer — avoids detachment concerns.
function readTags(file) {
  return new Promise(resolve => {
    if (typeof jsmediatags === 'undefined') { resolve({}); return; }
    jsmediatags.read(file, {
      onSuccess(result) { resolve(result.tags || {}); },
      onError()         { resolve({}); }
    });
  });
}
```

### importFiles() Additions

```javascript
// Changes to existing importFiles() in ui-controller.js:
async function importFiles(files) {
  let added = 0;
  for (const file of files) {
    const ext = file.name.split('.').pop().toLowerCase();
    const allowed = ['wav','mp3','flac','ogg','opus'];
    if (!allowed.includes(ext)) continue;

    // Parse tags from File object BEFORE reading ArrayBuffer
    const tags = await readTags(file);   // NEW

    const id = LibraryManager.genId();
    const ab = await file.arrayBuffer();
    const abForMemory = ab.slice(0);     // existing pattern — preserve live copy

    const trackForDB = {
      id,
      name:        file.name.replace(/\.[^.]+$/, ''),
      format:      ext.toUpperCase(),
      size:        file.size,
      semitones:   0,
      volume:      1.0,
      artist:      tags.artist  || '',   // NEW
      album:       tags.album   || '',   // NEW
      title:       tags.title   || '',   // NEW
      duration:    0,                    // NEW — updated in buildTrackCard loadBuffer.then()
      arrayBuffer: ab,
      addedAt:     Date.now()
    };
    // ... existing save/push/render logic unchanged ...
  }
}
```

### library-manager.js Changes

```javascript
// Source: IndexedDB spec — onupgradeneeded pattern
const DB_VER = 2;  // bumped from 1

req.onupgradeneeded = e => {
  const d = e.target.result;

  if (!d.objectStoreNames.contains('tracks')) {
    const s = d.createObjectStore('tracks', { keyPath: 'id' });
    s.createIndex('name', 'name', { unique: false });
  }
  // No schema changes needed on existing 'tracks' records —
  // artist/album/title/duration added lazily on new imports;
  // undefined fields coalesced at read time (|| '' / || 0).

  if (!d.objectStoreNames.contains('playlists')) {
    d.createObjectStore('playlists', { keyPath: 'id' });
  }
};
```

### Miniplayer HTML Structure (updated index.html)

```html
<!-- Source: 03-UI-SPEC.md component inventory -->
<div id="sidebar-bottom">
  <div id="mp-track-name">—</div>
  <!-- NEW elements inserted here -->
  <div id="mp-scrub-bar">
    <div id="mp-scrub-fill"></div>
  </div>
  <div id="mp-time-display">0:00 / --:--</div>
  <!-- EXISTING: aria-labels added -->
  <div id="mp-transport">
    <button id="mp-prev" title="Previous track" aria-label="Previous track">⏮</button>
    <button id="mp-play" title="Play / Pause" aria-label="Play">▶</button>
    <button id="mp-next" title="Next track" aria-label="Next track">⏭</button>
  </div>
  <div class="mp-row">
    <span class="mp-label">Transpose</span>
    <input type="range" id="mp-semitones" min="-12" max="12" value="0">
    <span id="mp-semitones-val" class="mp-val">0st</span>
  </div>
  <div class="mp-row">
    <span class="mp-label">Master Vol</span>
    <input type="range" id="mp-vol" min="0" max="100" value="100">
    <span id="mp-vol-val" class="mp-val">100%</span>
  </div>
</div>
```

### CSS for New Elements (add to style.css)

```css
/* Source: 03-UI-SPEC.md component inventory + waveform-progress visual language */

/* Scrub bar — transparent hit area with rendered track line */
#mp-scrub-bar {
  position: relative;
  height: 20px;
  cursor: pointer;
  display: flex;
  align-items: center;
  margin-bottom: 4px;
}
#mp-scrub-bar::before {
  content: '';
  position: absolute;
  left: 0; right: 0;
  height: 3px;
  background: var(--border);
  border-radius: 2px;
}
#mp-scrub-fill {
  position: absolute;
  left: 0;
  height: 3px;
  background: var(--accent);
  border-radius: 2px;
  width: 0%;
  pointer-events: none;
}
#mp-scrub-fill::after {
  content: '';
  position: absolute;
  right: -6px;
  top: -5px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 6px var(--accent-glow);
}

/* Time display */
#mp-time-display {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 400;
  color: var(--text-secondary);
  letter-spacing: 1px;
  text-align: center;
  margin-bottom: 10px;
}

/* Track card subtitle */
.track-subtitle {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 400;
  color: var(--text-dim);
  margin-top: 2px;
  letter-spacing: 0.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

### Track Card Subtitle Snippet (buildTrackCard)

```javascript
// Source: 03-CONTEXT.md metadata display decision
// Inserted into card.innerHTML template, after track-name div
const subtitleText = [track.artist, track.album].filter(Boolean).join(' · ');
// In template string:
`<div class="track-info">
  <div class="track-name" title="Click to rename">${escHtml(track.name)}</div>
  ${subtitleText ? `<div class="track-subtitle">${escHtml(subtitleText)}</div>` : ''}
  <div class="track-meta">${track.format || ''} · ${formatSize(track.size || 0)} · <span class="dur-val">--:--</span></div>
</div>`
```

---

## State of the Art

| Old Approach | Current Approach | Notes |
|--------------|------------------|-------|
| `input[type=range]` for scrub bars | Custom div + mouse events | Range fires on every tick; custom div enables clean fire-on-mouseup |
| `<audio>` element `currentTime` | `AudioContext.currentTime - startTime` | Web Audio `AudioBufferSourceNode` has no `currentTime` property; manual tracking is the correct pattern (already implemented in TrackPlayer) |
| CDN jsmediatags via `<script>` | Same — confirmed valid | The UMD bundle works with plain `<script>` tag; no module resolution needed |

**Deprecated / not applicable:**
- `AudioBuffer.duration` for tag-based duration: tags are unreliable for duration (CBR MP3 only, absent in many files). Always use the decoded buffer.
- `onProgress` as a single assignment from outside `buildTrackCard()`: breaks the card's waveform update. Must wrap, not replace.

---

## Environment Availability

Step 2.6: SKIPPED — The only external dependency is jsmediatags via CDN `<script>` tag. No CLI tools, local services, or runtimes beyond the browser are required. No environment probing needed.

---

## Open Questions

1. **jsmediatags offline fallback**
   - What we know: CDN availability is not guaranteed for offline use.
   - What's unclear: CLAUDE.md does not mention an offline requirement.
   - Recommendation: The `readTags()` wrapper includes a `typeof jsmediatags === 'undefined'` guard — tags are empty on CDN failure and import still works. Acceptable for Phase 3. If offline becomes a requirement, copy `jsmediatags.min.js` to `renderer/js/` and change the script src.

2. **Duration pre-population for Phase 4 sort/group**
   - What we know: Phase 4 (LIB-02, Artists tab) groups tracks by `artist`. Duration in IDB is 0 until a card is rendered.
   - What's unclear: Does Phase 4 need duration as a sort key before any card renders?
   - Recommendation: Acceptable for Phase 3. Flag for Phase 4 research: if duration is needed at sort time, Phase 4 can add import-time decode. For now, the deferred card-render update is sufficient.

---

## Sources

### Primary (HIGH confidence)
- `renderer/js/track-player.js` (codebase) — confirmed `_tick()`, `onProgress(frac, t)`, `seek(fraction)`, `currentTime` getter, `duration` property all implemented
- `renderer/js/ui-controller.js` (codebase) — confirmed `formatTime()`, `players` map, `currentPlayingId`, `buildTrackCard()`, `importFiles()`, `showMiniplayer()`, `hideMiniplayer()` patterns
- `renderer/js/library-manager.js` (codebase) — confirmed `DB_VER=1`, `tracks` object store, `name` index, `saveMeta()` pattern
- `renderer/index.html` (codebase) — confirmed current miniplayer HTML (`#sidebar-bottom`, `#mp-track-name`, `#mp-transport` structure)
- `renderer/style.css` (codebase) — confirmed `.mp-val`, `.mp-row`, `.mp-label`, `.track-meta`, `.waveform-progress`, `input[type=range]` thumb styles
- jsmediatags GitHub (aadsm/jsmediatags) — confirmed format support, API, src file list (`BlobFileReader`, `FLACTagReader`, `ID3v1TagReader`, `ID3v2TagReader`)
- cdnjs.com/libraries/jsmediatags — confirmed 3.9.5 availability and CDN URL
- npm registry (`npm view jsmediatags version`) — confirmed latest is 3.9.7, published 2022-06-19

### Secondary (MEDIUM confidence)
- 03-CONTEXT.md and 03-UI-SPEC.md — all locked decisions and component specs referenced throughout
- Web Audio API MDN — `AudioBuffer.duration`, `AudioContext.currentTime` behavior (stable browser API, effectively HIGH)

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — jsmediatags confirmed on cdnjs, npm version verified; Web Audio API browser-native
- Architecture: HIGH — all integration points verified against actual source files
- Pitfalls: HIGH — ArrayBuffer detachment documented in CLAUDE.md; onProgress overwrite verified from source; IDB behavior is spec-documented

**Research date:** 2026-03-25
**Valid until:** 2026-06-25 (jsmediatags is stable/infrequently updated; Web Audio API is a stable W3C spec)
