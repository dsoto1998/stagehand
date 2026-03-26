---
phase: 03-transport-metadata-foundation
plan: 02
subsystem: metadata
tags: [indexeddb, jsmediatags, id3, metadata, ui]
dependency_graph:
  requires: [03-01]
  provides: [META-01, META-02]
  affects: [renderer/js/library-manager.js, renderer/js/ui-controller.js, renderer/index.html, renderer/style.css]
tech_stack:
  added: [jsmediatags@3.9.5 (CDN)]
  patterns: [readTags() promise wrapper, lazy field addition for IDB records]
key_files:
  modified:
    - renderer/js/library-manager.js
    - renderer/js/ui-controller.js
    - renderer/index.html
    - renderer/style.css
decisions:
  - "jsmediatags loaded from CDN as UMD script — attaches to window.jsmediatags, no bundler needed"
  - "readTags() always resolves (never rejects) — WAV/OGG gracefully return empty object"
  - "Tags read from File blob before file.arrayBuffer() call to avoid ArrayBuffer detach issue"
  - "Duration stored lazily via saveTrackMeta() after first AudioBuffer decode, not at import time"
  - "Existing IDB records with undefined metadata fields handled by || '' / || 0 at read time — no migration loop needed"
metrics:
  duration: "12 minutes"
  completed: "2026-03-25"
  tasks: 2
  files_modified: 4
---

# Phase 03 Plan 02: ID3 Metadata Parsing & IDB v2 Summary

**One-liner:** ID3 tag parsing via jsmediatags with graceful fallback, artist/album subtitle on track cards, and IDB migrated to version 2 with playlists store.

## What Was Built

This plan added ID3 metadata parsing to the audio import flow and displayed it in the UI. When a user imports an MP3 or FLAC with embedded tags, `readTags()` extracts artist, album, and title before the file buffer is read. These fields are stored in IndexedDB alongside the track. Track cards now display a "Artist · Album" subtitle below the track name when either field is present. Duration is persisted to IDB after the first `AudioBuffer` decode (eager load or first play, whichever comes first).

IndexedDB was also migrated from version 1 to version 2. The `onupgradeneeded` handler now creates an empty `playlists` object store for Phase 5. Existing track records with no metadata fields continue to work — undefined fields default to empty strings at use time.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Migrate IndexedDB to version 2 and add jsmediatags CDN script | 24945a5 | library-manager.js, index.html |
| 2 | Parse metadata on import, store in IDB, display subtitle in track cards | cd1bd18 | ui-controller.js, style.css |

## Decisions Made

- jsmediatags 3.9.5 from cdnjs — loaded as plain `<script>` before the module script so `window.jsmediatags` is available synchronously when `readTags()` is called
- `readTags()` wraps `jsmediatags.read()` in a Promise and always resolves (even on error) — import is never aborted by tag parsing failure
- Tags are read from the `File` object (not an `ArrayBuffer`) to avoid the structured-clone detachment issue
- Duration stored lazily: `AudioBuffer.duration` is accurate and available only after decode, so `saveTrackMeta()` is called from the decode completion callbacks

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None. All metadata fields are wired from jsmediatags through to IndexedDB and the subtitle DOM element. Duration persists after decode. The playlists store is intentionally empty — it is a schema stub for Phase 5.

## Self-Check: PASSED

Files exist:
- renderer/js/library-manager.js: FOUND
- renderer/js/ui-controller.js: FOUND
- renderer/index.html: FOUND
- renderer/style.css: FOUND

Commits exist:
- 24945a5: FOUND (feat(03-02): migrate IndexedDB to version 2 and add jsmediatags CDN)
- cd1bd18: FOUND (feat(03-02): parse ID3 metadata on import, subtitle in track cards)
