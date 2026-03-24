# Requirements: Stagehand — Transpose Quality Improvement

**Defined:** 2026-03-23
**Core Value:** Musicians can transpose any track ±7 semitones and have it sound good enough to play along with in a real rehearsal.

## v1 Requirements

### Pitch Shifting Quality

- [ ] **PITCH-01**: Transpose produces no robotic/metallic artifacts at ±7 semitones on full band mixes
- [ ] **PITCH-02**: Transpose produces no smeared transients at ±7 semitones on full band mixes
- [ ] **PITCH-03**: Pitch is stable (no wavering/drift) throughout playback at ±7 semitones

### Integration

- [ ] **INT-01**: Rubber Band WASM replaces the existing OLA phase vocoder AudioWorklet
- [ ] **INT-02**: Transpose slider (−12 to +12 semitones) continues to work in real time, updating pitch without interrupting playback
- [ ] **INT-03**: Pitch shifting node is bypassed when semitones = 0 (same behavior as before)

### File Structure

- [ ] **STRUCT-01**: App loads and runs from a multi-file directory (index.html + css + js modules + rubberband.wasm)
- [ ] **STRUCT-02**: All existing features work after restructure: audio library, waveform display, playback, volume, metronome
- [ ] **STRUCT-03**: Existing IndexedDB audio track data is preserved (database name and schema unchanged)

## v2 Requirements

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
| Time stretching (tempo-independent pitch) | Not requested; Rubber Band supports it but adds complexity |
| Other audio processing (EQ, compression, noise reduction) | Not requested this milestone |
| Safari / mobile browser support | AudioWorklet + WASM not fully supported; Chrome/Firefox only per existing constraint |
| Bundler / build pipeline | Keep deployable as plain files, no webpack/vite |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| STRUCT-01 | Phase 1 | Pending |
| STRUCT-02 | Phase 1 | Pending |
| STRUCT-03 | Phase 1 | Pending |
| INT-01 | Phase 2 | Pending |
| INT-02 | Phase 2 | Pending |
| INT-03 | Phase 2 | Pending |
| PITCH-01 | Phase 2 | Pending |
| PITCH-02 | Phase 2 | Pending |
| PITCH-03 | Phase 2 | Pending |

**Coverage:**
- v1 requirements: 9 total
- Mapped to phases: 9
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-23*
*Last updated: 2026-03-23 after initial definition*
