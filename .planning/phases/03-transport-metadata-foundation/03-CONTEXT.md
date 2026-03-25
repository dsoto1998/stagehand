# Phase 3 Context: Transport & Metadata Foundation

**Phase:** 3 — Transport & Metadata Foundation
**Created:** 2026-03-25
**Status:** Ready for planning

---

## Phase Scope

Two parallel workstreams:
1. **Miniplayer scrub bar** — scrubbable progress bar + elapsed/total time display in the miniplayer
2. **ID3 metadata parsing** — parse artist/album/title/duration on import, store in IndexedDB, show subtitle in track card

Requirements covered: TRANS-01, TRANS-02, TRANS-03, TRANS-04, META-01, META-02

---

## Decisions

### Progress Bar Layout (TRANS-01, TRANS-02, TRANS-03)

**Decision:** Progress bar lives between the track name and the transport buttons, with elapsed/total time on its own row below it.

Layout (top to bottom in `#sidebar-bottom`):
```
Track Name Here
████░░░░░░░░░░░░░░░░░
1:23 / 4:07
⏮    ▶    ⏭
Transpose  [----] +3st
Master Vol [----] 100%
```

**Seek behavior:** Seek fires on mouse-up (not on every drag tick). This was pre-decided in v2.0 planning.

**Implementation note:** Use a styled `div` (not `input[type=range]`) for the scrub bar — needs mousedown/mousemove/mouseup to implement fire-on-mouse-up. Style consistent with waveform-progress in track cards.

**When no track is loaded:** Progress bar shows at 0, time shows `0:00 / --:--`.

---

### Metadata Display (META-01, META-02)

**Decision:** Show a metadata subtitle line below the track name in track cards when ID3 tags are present.

Format: `Artist · Album` below the track name.
- If only artist: show `Artist`
- If only album: show `Album`
- If both empty (no tags): show nothing (no subtitle row)

**What changes in the card HTML:**
```
<div class="track-name">Song Name</div>
<div class="track-subtitle">Artist · Album</div>  ← new, hidden if empty
```

**What does NOT change:** The track's display `name` field is NOT replaced by the ID3 title. The existing user-editable name stays as the primary identifier. ID3 data is supplementary display only.

---

### No-Tag Fallback

**Decision:** Keep filename-derived name as-is. Store `artist: ""`, `album: ""`, `title: ""` in IndexedDB (empty strings, not null). No subtitle shown when all three are empty.

Applies to: WAV files (jsmediatags typically returns nothing), untagged MP3s/FLAC.

---

### "Play with No Track" (TRANS-04)

**Decision:** Sort by `track.name` (display name, alphabetical A→Z) to find the first track. If the library is empty, Play does nothing (no notification needed — the button is in context of an empty miniplayer state).

---

### IndexedDB Migration

**Decision:** Bump `DB_VER` to `2`. Add metadata fields lazily to existing track records (no migration loop needed — fields will be undefined/empty for old tracks, handled at read time).

Also add the `playlists` object store in this same migration (avoids a third version bump in Phase 5). The store is created empty; Phase 5 populates it.

New schema additions to `tracks` store:
```js
{
  // existing fields unchanged...
  artist:   String,  // "" if no tags
  album:    String,  // "" if no tags
  title:    String,  // "" if no tags (NOT used as display name)
  duration: Number,  // seconds, from AudioBuffer.duration (always accurate)
}
```

New store:
```js
// playlists — keyPath: 'id'
// Created now, populated by Phase 5
```

---

## Canonical Refs

- `renderer/js/ui-controller.js` — miniplayer DOM, showMiniplayer/hideMiniplayer, buildTrackCard, importFiles
- `renderer/js/track-player.js` — onProgress callback, seek(), currentTime getter, _tick() loop
- `renderer/js/library-manager.js` — IDB open/save/saveMeta, DB_VER, schema
- `renderer/index.html` — `#sidebar-bottom` miniplayer HTML structure
- `renderer/style.css` — existing miniplayer styles (`.mp-row`, `#mp-transport`, etc.)

No external docs referenced. jsmediatags CDN: already decided (3.9.5 via CDN `<script>` tag in index.html).

---

## Deferred Ideas

None surfaced during discussion.
