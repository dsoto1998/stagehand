# Stagehand — Musician's Rehearsal Tool

## What This Is

Stagehand is a musician's rehearsal tool for playing along with recordings. Built as a multi-file browser app (`renderer/index.html` served at `http://localhost:8080/renderer/index.html`), it supports audio library management, waveform display, playback, per-track transpose via Rubber Band WASM, and a metronome. The long-term target is an Electron app with native VST3 plugin hosting.

## Core Value

Musicians can import their rehearsal tracks, browse and organize them, transpose any track ±12 semitones with professional quality, and play along — all from a fast, well-organized interface that scales to large libraries.

## Current Milestone: v2.0 Library & Player Enhancement

**Goal:** Transform the basic audio library and miniplayer into a rich, scalable music player with organized browsing, playlist management, and full transport controls.

**Target features:**
- Miniplayer scrubbable progress bar (elapsed/total time, seek on mouse-up)
- Auto-play first alphabetical track when Play is pressed with nothing loaded
- ID3 metadata parsing (artist/album/title/duration) on audio import
- Library restructured into 3 tabs: Songs, Artists, Playlists
- Virtual scrolling + lazy audio decoding for hundreds/thousands of tracks
- Full Playlists: create, rename, delete, add tracks, reorder, play through

## Requirements

### Validated (v1.0)

- ✓ Audio library (import WAV/MP3/FLAC/OGG, rename, delete, persist via IndexedDB) — Phase 01
- ✓ Waveform display (canvas-rendered, amplitude-colored) — Phase 01
- ✓ Playback (play/pause, seek, per-track volume) — Phase 01
- ✓ Transpose slider (−12 to +12 semitones, Rubber Band WASM quality) — Phase 02
- ✓ Metronome (BPM, tap tempo, subdivisions, click sound) — Phase 01
- ✓ Master volume — Phase 01
- ✓ Miniplayer (transport, transpose, master vol, prev/next) — Quick tasks
- ✓ App loads from multi-file directory (`renderer/index.html`) — Phase 01

### Active (v2.0)

- ✓ Miniplayer shows scrubbable progress bar with elapsed/total time — Validated in Phase 03
- ✓ Play with nothing loaded starts first track alphabetically — Validated in Phase 03
- ✓ ID3 tags (artist, album, title, duration) parsed on import and stored — Validated in Phase 03
- [ ] Library has Songs, Artists, Playlists tabs
- [ ] Library handles hundreds/thousands of tracks without performance degradation
- [ ] User can create, rename, and delete playlists
- [ ] User can add tracks to playlists and reorder them
- [ ] Playlists play through in order

### Out of Scope

- VST plugin panel — v3 milestone
- Electron migration — v3 milestone
- Time stretching (tempo-independent of pitch) — not requested
- Other audio quality improvements (EQ, noise reduction) — not requested

## Context

- **Active entry point:** `http://localhost:8080/renderer/index.html` — `rehearsal-tool-v1.html` is orphaned
- **Audio engine:** Rubber Band WASM via `rubberband-web@0.2.1`; pitch control via `postMessage(JSON.stringify(['pitch', ratio]))`; node bypassed at 0 semitones
- **Storage:** IndexedDB `stagehand_db` (version 2), stores `tracks` + `playlists`; tracks have `artist`, `album`, `title`, `duration` fields; ArrayBuffer must be `.slice(0)`'d before IDB put
- **Browser support:** Chrome and Firefox only (AudioWorklet + WASM)
- **No build step:** Vanilla JS modules, no bundler

## Constraints

- **Browser:** Chrome and Firefox only
- **No build step:** Deployable without a bundler
- **Preserve IndexedDB data:** Existing libraries must survive schema migration
- **Single developer:** Just David — no CI/CD, no review process

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Rubber Band over SoundTouch.js | Best quality for full-band mixes at ±7 semitones | Validated — human listening test 2026-03-24 |
| Multi-file structure over embedded WASM | Long-term Electron compatibility | Validated — Phase 01 complete |
| rubberband-web@0.2.1 processor in public/ | WASM embedded in JS — no separate .wasm file needed | Validated — Phase 02 complete |

---
*Last updated: 2026-03-25 — Phase 03 complete (transport + metadata)*

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state
