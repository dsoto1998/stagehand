# Roadmap: Stagehand — Transpose Quality Improvement

## Overview

The monolithic `rehearsal-tool-v1.html` is split into a proper multi-file directory structure (Phase 1), then the existing OLA phase vocoder AudioWorklet is replaced with Rubber Band WASM to deliver professional-grade pitch shifting at ±7 semitones (Phase 2). Phase 1 is a hard prerequisite: the WASM binary must live as a separate file on disk, which requires the multi-file structure to exist first.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: File Restructure** - Split the single HTML file into a multi-file directory matching the target Electron layout
- [ ] **Phase 2: Rubber Band Integration** - Replace the OLA phase vocoder with Rubber Band WASM and verify pitch quality

## Phase Details

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
- [ ] 01-02-PLAN.md — Extract track-player and metronome modules, create ui-controller.js entry point, verify full app
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
- [ ] 02-01-PLAN.md — Setup rubberband-web npm package, copy processor file, rewire track-player.js, delete old vocoder
- [ ] 02-02-PLAN.md — Verify pitch shifting quality at ±7 semitones (human listening test)

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. File Restructure | 1/2 | In Progress|  |
| 2. Rubber Band Integration | 0/2 | Planned    |  |
