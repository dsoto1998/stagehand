---
phase: quick-260408-v4r
plan: 01
subsystem: ui
tags: [chord-chart, modal, idb, chordpro, pdf]
dependency_graph:
  requires: []
  provides: [per-track-chord-charts]
  affects: [ui-controller, style, index-html, icons]
tech_stack:
  added: []
  patterns: [modal-overlay, event-delegation, idb-savemeta, blob-url-pdf]
key_files:
  created: []
  modified:
    - renderer/js/icons.js
    - renderer/index.html
    - renderer/style.css
    - renderer/js/ui-controller.js
decisions:
  - Chord icon always visible at opacity 0.25 (no hover-only show); accent-colored when chart assigned
  - chordPdf sliced before saveMeta put to prevent ArrayBuffer detachment
  - Event delegation on #track-list handles chord icon clicks (consistent with play/ctx btn pattern)
  - Both library rows and playlist rows get chord icons; artist drill-down rows excluded (aggregate view)
metrics:
  duration: ~30min
  completed: 2026-04-08
  tasks_completed: 2
  files_modified: 4
---

# Quick 260408-v4r: Add Per-Track Chord Chart Support Summary

Per-track chord chart modal with PDF upload and ChordPro editing — icon always visible in track rows, accent-colored when a chart is assigned, persisted via IndexedDB saveMeta.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Chord icon, overlay HTML, CSS, row integration | 8dc9a2f | icons.js, index.html, style.css, ui-controller.js |
| 2 | Chord modal logic (tabs, PDF, ChordPro, IDB) | 8dc9a2f | ui-controller.js |

Both tasks committed atomically in a single commit (8dc9a2f).

## What Was Built

**Chord icon in track rows** — A document+music-note SVG icon appears inside `.row-name-col`, left of the song title, in both the library Songs view and playlist rows. The icon is always visible at `opacity: 0.25` when no chart is assigned, and accent-colored (`--accent`) at full opacity when a chart exists.

**Chord chart modal** — Overlay matching the existing info-overlay pattern. Two tabs:
- **Upload PDF**: Choose a PDF file, display via blob URL iframe, "Remove PDF" button clears it.
- **ChordPro**: Textarea for ChordPro input with live chords-above-lyrics preview. `[chord]` tokens render in accent color, directives like `{title:}` render as italic metadata lines.

**IDB persistence** — Both `chordPdf` (ArrayBuffer) and `chordPro` (string) stored lazily on existing track records via `LibraryManager.saveMeta`. `chordPdf` is `.slice(0)`d before the put to avoid structured-clone detachment.

## Deviations from Plan

### User-Requested Modification

**[User Change] Chord icon always visible instead of hover-only**
- **Requested during:** Pre-checkpoint review
- **Change:** Instead of `opacity: 0` at rest showing only on `.track-row:hover`, icon is always rendered at `opacity: 0.25`. The `.track-row:hover .row-chord-btn` hover-reveal rule was removed entirely. The `has-chart` state sets `opacity: 1` with accent color.
- **Files modified:** renderer/style.css
- **Commit:** 8dc9a2f

## Known Stubs

None. Both PDF and ChordPro data paths are fully wired end-to-end with IDB persistence.

## Self-Check: PASSED

- renderer/js/icons.js: FOUND (chord icon added)
- renderer/index.html: FOUND (chord-overlay div added)
- renderer/style.css: FOUND (chord modal + row-chord-btn styles added)
- renderer/js/ui-controller.js: FOUND (showChordModal, renderChordProPreview, event delegation)
- Commit 8dc9a2f: FOUND
