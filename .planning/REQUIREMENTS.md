# Requirements: Stagehand

**Defined:** 2026-03-23
**Core Value:** Musicians can import their rehearsal tracks, browse and organize them, transpose any track ±12 semitones with professional quality, and play along — all from a fast, well-organized interface that scales to large libraries.

## v2.0 Requirements (Milestone: Library & Player Enhancement)

### Transport (Miniplayer)

- [ ] **TRANS-01**: User can see a progress bar in the miniplayer showing current playback position
- [ ] **TRANS-02**: Progress bar displays elapsed time and total track duration
- [ ] **TRANS-03**: User can scrub the progress bar to seek; seek applies on mouse-up
- [ ] **TRANS-04**: Pressing Play with no track loaded starts the first alphabetical track

### Metadata

- [ ] **META-01**: Artist, album, title, and duration are parsed from audio file tags on import
- [ ] **META-02**: Parsed metadata is stored in IndexedDB alongside the track

### Library

- [ ] **LIB-01**: Library has a Songs tab listing all tracks
- [ ] **LIB-02**: Library has an Artists tab grouping tracks by parsed artist
- [ ] **LIB-03**: Library has a Playlists tab for managing playlists
- [ ] **LIB-04**: Library renders without performance degradation at hundreds or thousands of tracks (virtual scrolling)

### Playlists

- [ ] **PL-01**: User can create a named playlist
- [ ] **PL-02**: User can rename a playlist
- [ ] **PL-03**: User can delete a playlist
- [ ] **PL-04**: User can add tracks to a playlist
- [ ] **PL-05**: User can reorder tracks within a playlist
- [ ] **PL-06**: Playing a playlist plays through tracks in order

## v1.0 Requirements (Milestone: Transpose Quality Improvement) — Validated

### Pitch Shifting Quality

- [x] **PITCH-01**: Transpose produces no robotic/metallic artifacts at ±7 semitones on full band mixes
- [x] **PITCH-02**: Transpose produces no smeared transients at ±7 semitones on full band mixes
- [x] **PITCH-03**: Pitch is stable (no wavering/drift) throughout playback at ±7 semitones

### Integration

- [x] **INT-01**: Rubber Band WASM replaces the existing OLA phase vocoder AudioWorklet
- [x] **INT-02**: Transpose slider (−12 to +12 semitones) works in real time without interrupting playback
- [x] **INT-03**: Pitch shifting node is bypassed when semitones = 0

### File Structure

- [x] **STRUCT-01**: App loads and runs from a multi-file directory (renderer/index.html + css + js modules)
- [x] **STRUCT-02**: All existing features work after restructure: audio library, waveform display, playback, volume, metronome
- [x] **STRUCT-03**: Existing IndexedDB audio track data is preserved (database name and schema unchanged)

## Future Requirements

### Future Milestone — Electron Migration

- **ELEC-01**: App runs as an Electron desktop app (Windows + Mac)
- **ELEC-02**: IndexedDB replaced with native filesystem paths
- **ELEC-03**: VST3 plugin hosting via node-addon-api + JUCE bridge

### Future Milestone — VST Plugin Panel

- **VST-01**: Plugin chain UI with load/reorder slots
- **VST-02**: Per-plugin bypass toggle and gain controls

## Out of Scope

| Feature | Reason |
|---------|--------|
| Time stretching (tempo-independent pitch) | Not requested |
| Audio processing (EQ, compression, noise reduction) | Not requested |
| Safari / mobile browser support | AudioWorklet + WASM not fully supported; Chrome/Firefox only |
| Bundler / build pipeline | Keep deployable as plain files, no webpack/vite |
| Album art display | Not requested this milestone |
| Last.fm / streaming integration | Not requested |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| STRUCT-01 | Phase 1 | Complete |
| STRUCT-02 | Phase 1 | Complete |
| STRUCT-03 | Phase 1 | Complete |
| INT-01 | Phase 2 | Complete |
| INT-02 | Phase 2 | Complete |
| INT-03 | Phase 2 | Complete |
| PITCH-01 | Phase 2 | Complete |
| PITCH-02 | Phase 2 | Complete |
| PITCH-03 | Phase 2 | Complete |
| TRANS-01 | Phase 3 | Pending |
| TRANS-02 | Phase 3 | Pending |
| TRANS-03 | Phase 3 | Pending |
| TRANS-04 | Phase 3 | Pending |
| META-01 | Phase 3 | Pending |
| META-02 | Phase 3 | Pending |
| LIB-01 | Phase 4 | Pending |
| LIB-02 | Phase 4 | Pending |
| LIB-03 | Phase 4 | Pending |
| LIB-04 | Phase 4 | Pending |
| PL-01 | Phase 5 | Pending |
| PL-02 | Phase 5 | Pending |
| PL-03 | Phase 5 | Pending |
| PL-04 | Phase 5 | Pending |
| PL-05 | Phase 5 | Pending |
| PL-06 | Phase 5 | Pending |

**Coverage:**
- v2.0 requirements: 16 total
- Mapped to phases: 16/16 ✓
- Unmapped: 0 ✓

---
*v1.0 requirements defined: 2026-03-23*
*v2.0 requirements defined: 2026-03-25*
*Last updated: 2026-03-25 — v2.0 roadmap complete, all 16 requirements mapped*
