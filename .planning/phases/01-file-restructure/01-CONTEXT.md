# Phase 1: File Restructure - Context

**Gathered:** 2026-03-23
**Status:** Ready for planning

<domain>
## Phase Boundary

Split `rehearsal-tool-v1.html` (2102-line monolith: ~715 lines CSS, ~176 lines HTML, ~1200 lines JS) into a proper multi-file directory structure matching the Electron target layout. No new features. All existing features must work identically after restructure. The `wasm/` directory must exist and be ready to receive `rubberband.wasm` in Phase 2.

Entry point after restructure: `renderer/index.html`

</domain>

<decisions>
## Implementation Decisions

### JS Module System
- **D-01:** Use ES modules (`export`/`import`, `<script type="module">`) — NOT window globals or IIFE pattern
- **D-02:** Each JS file exports its public API; consumers import what they need
- **D-03:** `renderer/index.html` loads only `js/ui-controller.js` as the top-level module (`<script type="module" src="./js/ui-controller.js">`) — that module imports the rest
- **D-04:** Testing requires a local HTTP server (not `file://` — ES modules don't work via file:// protocol). A simple `python -m http.server 8080` or `npx serve` from the project root is sufficient.

### JS File Split (7 modules — exact names from CLAUDE.md)
- **D-05:** `js/audio-engine.js` — AudioContext singleton, master GainNode, `getCtx()`, `resume()`, `getMaster()`, `setMasterVolume()`
- **D-06:** `js/library-manager.js` — IndexedDB CRUD: `open()`, `all()`, `save()`, `remove()`, `genId()`
- **D-07:** `js/phaze-worklet.js` — The AudioWorkletProcessor code (OLA phase vocoder). Loaded as a real file via `ctx.audioWorklet.addModule('./js/phaze-worklet.js')`. No more Blob URL generation. Phase 2 replaces this file's content.
- **D-08:** `js/track-player.js` — AudioBufferSourceNode management, pitch routing, `ensurePhazeWorklet()` (now simplified — calls `addModule` with file path), per-track play/pause/seek/volume
- **D-09:** `js/metronome.js` — Lookahead scheduler, tap tempo, subdivisions, beat flash, custom click sound
- **D-10:** `js/waveform.js` — Canvas waveform renderer (`renderWaveform()`)
- **D-11:** `js/ui-controller.js` — DOM bindings, event listeners, `loadLibrary()`, `renderTrackList()`, `buildTrackCard()`, `importFiles()`, init function. Top-level entry point that imports all other modules.

### Directory Structure
- **D-12:** Target layout:
  ```
  renderer/
  ├── index.html       ← clean HTML shell: <link> for CSS, <script type="module"> for ui-controller.js
  ├── style.css        ← all CSS extracted from <style> block (lines 7–722 of monolith)
  └── js/
      ├── audio-engine.js
      ├── library-manager.js
      ├── phaze-worklet.js
      ├── track-player.js
      ├── metronome.js
      ├── waveform.js
      └── ui-controller.js
  wasm/                ← empty directory, placeholder file (.gitkeep) so it exists in git
  ```
- **D-13:** `rehearsal-tool-v1.html` stays at project root — do NOT delete it. It's the fallback reference while testing the restructure.

### IndexedDB Continuity
- **D-14:** Database name MUST remain `stagehand_db` — unchanged from monolith
- **D-15:** Object store name `tracks` and all field names (id, name, format, size, semitones, volume, arrayBuffer, addedAt) MUST remain identical — STRUCT-03 requires zero data loss
- **D-16:** `LibraryManager.open()` is called lazily on first use, same as before

### The Phaze Worklet Refactor
- **D-17:** Remove `ensurePhazeWorklet()` Blob URL generation (the current ~200-line template literal string approach)
- **D-18:** Replace with: `if (!phazeWorkletLoaded) { await ctx.audioWorklet.addModule('./js/phaze-worklet.js'); phazeWorkletLoaded = true; }`
- **D-19:** `phaze-worklet.js` contains only the `OLAProcessor` and `PhaseVocoderProcessor` class definitions + `registerProcessor('phase-vocoder-processor', PhaseVocoderProcessor)` — no imports, no exports (AudioWorklet scope has neither)

### Claude's Discretion
- How to handle circular dependency risks between modules (use dependency injection or a shared state object if needed)
- Whether `formatTime()`, `formatSize()`, `notify()`, `confirm()`, `escHtml()` live in `ui-controller.js` or a separate `js/utils.js` helper
- Exact `export`/`import` signatures for each module
- Whether to add a minimal `package.json` or `README.md` with the `python -m http.server` dev instructions

</decisions>

<specifics>
## Specific Ideas

- User deferred all technical decisions to Claude — they need the restructure to work correctly more than they need input on the approach
- The Phaze worklet getting replaced in Phase 2 means Phase 1 just needs to move it cleanly, not improve it
- Keep changes mechanical where possible — same logic, same variable names, just reorganized into files

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project architecture and constraints
- `CLAUDE.md` — Definitive source for target file structure, audio routing graph, IndexedDB schema, pitch shifter architecture, known bugs already fixed, design system. Read entirely before planning.
- `rehearsal-tool-v1.html` — The source monolith being split. Read to understand current code structure before planning the split tasks.

### Requirements
- `.planning/REQUIREMENTS.md` §File Structure — STRUCT-01, STRUCT-02, STRUCT-03 define exactly what Phase 1 must deliver
- `.planning/ROADMAP.md` §Phase 1 — Success criteria checklist (4 items) that verification will check against

</canonical_refs>

<code_context>
## Existing Code Insights

### The monolith structure (rehearsal-tool-v1.html)
- Lines 1–6: `<!DOCTYPE html>` + `<head>` + Google Fonts + `<meta>`
- Lines 7–722: `<style>` block — all CSS (extract verbatim to `style.css`)
- Lines 723–898: HTML body — nav, panels, metronome, track list, modals (extract to `index.html`)
- Lines 899–910: `<script>` open + audio engine IIFE (`AudioEngine` object on window)
- Lines 911–940: AudioContext + master gain (`getCtx`, `resume`, `getMaster`, `setMasterVolume`)
- Lines 941–990: `LibraryManager` IIFE (IndexedDB) — `open`, `all`, `save`, `remove`, `genId`
- Lines ~991–1176: FFT utility + `OLAProcessor` + `PhaseVocoderProcessor` (as a template literal string `PHAZE_SRC`)
- Lines 1177–1216: `fft()` standalone function used in the worklet code
- Lines 1217–1393: `ensurePhazeWorklet()` — generates Blob URL from `PHAZE_SRC`, loads worklet. **This becomes `addModule('./js/phaze-worklet.js')` after restructure.**
- Lines 1394–1438: Utilities (`formatTime`, `formatSize`, `notify`, `confirm`, `escHtml`)
- Lines 1439–1488: `renderWaveform()` — canvas renderer
- Lines 1489–1500: `loadLibrary()` — reads IndexedDB, decodes audio
- Lines 1501–1524: `renderTrackList()` — rebuilds track list DOM
- Lines 1525–1751: `buildTrackCard()` — large function that builds per-track card DOM + wires up all controls
- Lines 1752–1822: `saveTrackMeta()`, `importFiles()`
- Lines 1823–1948: Metronome IIFE (scheduler, tap tempo, subdivisions, beat flash)
- Lines 1949–2094: Metronome UI bindings
- Lines 2095–2100: `init()` async IIFE — entry point, wires up master volume, loads library

### Critical bug notes (from CLAUDE.md — do NOT reintroduce these)
- `parameters['pitchFactor']` not `parameters.get('pitchFactor')` — `.get()` throws TypeError in AudioWorkletProcessor
- `_outWritePtr` init must be `this._frameSize - 1` not `0`
- `nCh` must come from `this._numChannels` not `inp.length` (inp.length is 0 on silent blocks)
- ArrayBuffer transfer: `ab.slice(0)` before IndexedDB `put()` to keep live copy

### Integration points after split
- `ui-controller.js` imports everything and wires the DOM — it's the only file that touches the DOM
- `track-player.js` depends on `audio-engine.js` (needs ctx) and `phaze-worklet.js` (via addModule path)
- `library-manager.js` has no dependencies — pure IndexedDB

</code_context>

<deferred>
## Deferred Ideas

- Setting up a proper dev server config (Vite, live-reload) — out of scope, `python -m http.server` is sufficient for this milestone
- Electron migration (BrowserWindow, native filesystem) — Phase 3+ in roadmap
- Splitting `buildTrackCard()` into smaller components — refactor concern, out of scope for this mechanical restructure

</deferred>

---

*Phase: 01-file-restructure*
*Context gathered: 2026-03-23 — decisions made by Claude (user requested full ownership)*
