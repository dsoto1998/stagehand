# Roadmap: Stagehand

## Milestones

- ✅ **v1.0 Transpose Quality Improvement** - Phases 1-2 (shipped 2026-03-25)
- 🚧 **v2.0 Library & Player Enhancement** - Phases 3-5 (in progress)

## Phases

<details>
<summary>✅ v1.0 Transpose Quality Improvement (Phases 1-2) — SHIPPED 2026-03-25</summary>

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: File Restructure** - Split the single HTML file into a multi-file directory matching the target Electron layout
- [x] **Phase 2: Rubber Band Integration** - Replace the OLA phase vocoder with Rubber Band WASM and verify pitch quality

### Phase 1: File Restructure
**Goal**: The app runs from a proper multi-file directory that preserves all existing features and is ready to host a WASM binary
**Depends on**: Nothing (first phase)
**Requirements**: STRUCT-01, STRUCT-02, STRUCT-03
**Success Criteria** (what must be TRUE):
  1. Opening `renderer/index.html` in Chrome or Firefox loads the full app with no console errors
  2. All existing features work: audio library (import, rename, delete, persist), waveform display, playback, per-track volume, metronome
  3. Tracks previously stored in IndexedDB (`stagehand_db`) are still visible after the restructure — no data loss
  4. The directory contains discrete files for HTML, CSS, and JS modules (no inline megafile), plus a `wasm/` directory ready to receive `rubberband.wasm`
**Plans**: 2 plans
Plans:
- [x] 01-01-PLAN.md — Create directory structure, extract CSS/HTML shell, and independent JS modules (audio-engine, library-manager, phaze-worklet, waveform)
- [x] 01-02-PLAN.md — Extract track-player and metronome modules, create ui-controller.js entry point, verify full app
**UI hint**: yes

### Phase 2: Rubber Band Integration
**Goal**: Musicians can transpose any track ±7 semitones and hear professional-quality pitch shifting with no robotic artifacts
**Depends on**: Phase 1
**Requirements**: INT-01, INT-02, INT-03, PITCH-01, PITCH-02, PITCH-03
**Success Criteria** (what must be TRUE):
  1. Transposing a full band mix by +7 or −7 semitones produces no robotic, metallic, or smeared artifacts audible during normal rehearsal use
  2. Pitch is stable throughout playback — no wavering or drift — at any semitone value in the ±12 range
  3. Moving the transpose slider while a track is playing updates the pitch in real time without interrupting playback
  4. Setting the transpose slider to 0 bypasses the pitch shifter node entirely (same bypass behavior as before)
  5. The OLA phase vocoder AudioWorklet is fully removed from the codebase and `rubberband.wasm` handles all pitch shifting
**Plans**: 2 plans
Plans:
- [x] 02-01-PLAN.md — Setup rubberband-web npm package, copy processor file, rewire track-player.js, delete old vocoder
- [x] 02-02-PLAN.md — Verify pitch shifting quality at ±7 semitones (human listening test)

</details>

### 🚧 v2.0 Library & Player Enhancement (In Progress)

**Milestone Goal:** Transform the audio library and miniplayer into a rich, scalable music player with organized browsing, playlist management, and full transport controls.

- [ ] **Phase 3: Transport & Metadata Foundation** - Miniplayer gets a scrubbable progress bar and ID3 metadata is parsed and stored on import
- [ ] **Phase 4: Library Tabs & Virtual Scrolling** - Library restructured into Songs/Artists/Playlists tabs with virtual scrolling for large libraries
- [ ] **Phase 5: Playlists** - Full playlist management: create, rename, delete, add tracks, reorder, play through

## Phase Details

### Phase 3: Transport & Metadata Foundation
**Goal**: Musicians get full transport awareness in the miniplayer and imported tracks carry artist/album/title/duration metadata from their files
**Depends on**: Phase 2
**Requirements**: TRANS-01, TRANS-02, TRANS-03, TRANS-04, META-01, META-02
**Success Criteria** (what must be TRUE):
  1. The miniplayer shows a progress bar that moves in real time as a track plays
  2. Elapsed time and total track duration are displayed in the miniplayer (e.g., "1:23 / 4:07")
  3. Dragging or clicking the progress bar and releasing seeks playback to that position
  4. Pressing Play in the miniplayer when no track is loaded starts the first track alphabetically
  5. Importing an audio file with embedded ID3 tags stores artist, album, title, and duration alongside the track in IndexedDB
**Plans**: TBD
**UI hint**: yes

### Phase 4: Library Tabs & Virtual Scrolling
**Goal**: The library is organized into Songs, Artists, and Playlists tabs and renders without degradation at hundreds or thousands of tracks
**Depends on**: Phase 3
**Requirements**: LIB-01, LIB-02, LIB-03, LIB-04
**Success Criteria** (what must be TRUE):
  1. The library panel has three tabs — Songs, Artists, and Playlists — that switch without page reload
  2. The Songs tab lists all tracks; the Artists tab groups tracks by parsed artist name
  3. A library with 500+ tracks scrolls smoothly with no visible lag or jank (virtual scrolling, fixed-height rows)
  4. The Playlists tab is present and shows existing playlists (populated by Phase 5)
**Plans**: TBD
**UI hint**: yes

### Phase 5: Playlists
**Goal**: Musicians can create and manage playlists and play through them in order
**Depends on**: Phase 4
**Requirements**: PL-01, PL-02, PL-03, PL-04, PL-05, PL-06
**Success Criteria** (what must be TRUE):
  1. User can create a new named playlist from the Playlists tab
  2. User can rename and delete existing playlists
  3. User can add tracks from the Songs tab to any playlist
  4. User can drag tracks to reorder them within a playlist
  5. Playing a playlist from the first track auto-advances through all tracks in order until the last track ends
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. File Restructure | v1.0 | 2/2 | Complete | 2026-03-25 |
| 2. Rubber Band Integration | v1.0 | 2/2 | Complete | 2026-03-25 |
| 3. Transport & Metadata Foundation | v2.0 | 0/TBD | Not started | - |
| 4. Library Tabs & Virtual Scrolling | v2.0 | 0/TBD | Not started | - |
| 5. Playlists | v2.0 | 0/TBD | Not started | - |
