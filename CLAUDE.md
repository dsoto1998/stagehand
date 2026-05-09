# STAGEHAND — Rehearsal Tool
## Claude Code Context File

---

## Project Overview

**Stagehand** is a cross-platform musician's rehearsal tool. The app runs from a multi-file `renderer/` directory (HTML + CSS + ES modules) serving as the pre-Electron browser target. The long-term target is an **Electron app** (Windows + Mac) with native VST3 plugin hosting.

The legacy monolith (`rehearsal-tool-v1.html`) still exists at the project root but is orphaned — `renderer/index.html` is the active entry point.

---

## Current Status: v1.1.0 (Tauri desktop app — Windows)

### Working Features
- **Audio Library** — Import WAV, MP3, FLAC, OGG/Opus/AIFF. Rename, delete, persist across sessions via filesystem (`$APPDATA/stagehand/library/`).
- **Waveform display** — Canvas-rendered, amplitude-colored. Peaks computed from decoded audio.
- **Playback** — Play/pause, seek, per-track volume slider. Streaming decode for instant start; background full-decode for seek/pitch support.
- **Transpose** — Per-track semitone slider (−12 to +12) + cent fine-tune (±50¢) via click-to-open popover. Rubber Band C++ (vendored, compiled via `cc` crate) used for pitch shifting in Rust audio engine. Popover appears in both track card and miniplayer. Hold-to-repeat with acceleration on ±1¢ buttons.
- **Metronome** — BPM input, tap tempo, subdivisions, beat flash, volume control.
- **Master volume** — Per-track and global volume via rodio Sink.
- **Miniplayer** — Persistent bottom panel: track name, play/pause, prev/next, transpose + cent controls, master volume.
- **Device picker** — WASAPI and ASIO output device selection (Windows).
- **GitHub Actions release** — `.github/workflows/release.yml` builds and publishes a Windows installer on `v*` tag push.

### Known Issues / In Progress
- None currently.

---

## Architecture

### File Structure (current)
```
stagehand/
├── package.json                 ← rubberband-web@0.2.1 dep + npm run setup script
├── rehearsal-tool-v1.html       ← ORPHANED monolith, do not edit
├── renderer/
│   ├── index.html               ← active entry point
│   ├── style.css
│   └── js/
│       ├── audio-engine.js      ← AudioContext, master gain, routing
│       ├── library-manager.js   ← IndexedDB CRUD + saveMeta() for metadata-only updates
│       ├── track-player.js      ← AudioBufferSourceNode + Rubber Band pitch routing
│       ├── rubberband-processor.js  ← rubberband-web AudioWorkletProcessor (612KB, WASM embedded)
│       ├── metronome.js         ← Lookahead scheduler + tap tempo
│       ├── waveform.js          ← Canvas waveform renderer
│       └── ui-controller.js     ← DOM bindings, panel routing, miniplayer
├── native/
│   └── vst-bridge/              ← Future: node-addon-api + JUCE VST host
└── CLAUDE.md
```

### Target File Structure (Electron migration — future)
```
stagehand/
├── main.js                  ← Electron main process
├── preload.js               ← Electron preload (context bridge)
├── renderer/                ← existing renderer/ moves in as-is
└── native/
    └── vst-bridge/          ← node-addon-api + JUCE VST host
```

---

## Audio Engine Design

### Routing Graph
```
[AudioBufferSourceNode]
        │
[AudioWorkletNode]     ← rubberband-processor, only inserted when semitones !== 0
        │
[GainNode]             ← per-track volume
        │
[GainNode]             ← master volume (connected to AudioContext.destination)
        │
[AudioContext.destination]
```

### AudioContext policy
- Single shared `AudioContext` created lazily on first user gesture
- Must call `ctx.resume()` before any scheduling (browser autoplay policy)
- Metronome uses `AudioContext.currentTime` lookahead scheduler (25ms interval, 100ms lookahead) — NOT `setInterval` for timing

---

## Pitch Shifter (Rubber Band WASM)

### Implementation
`renderer/js/rubberband-processor.js` — `rubberband-web@0.2.1` AudioWorkletProcessor with WASM embedded (612KB). Registered as `'rubberband-processor'`, loaded via `ctx.audioWorklet.addModule('./js/rubberband-processor.js')`.

- Pitch ratio set via `port.postMessage(JSON.stringify(["pitch", factor]))` where `factor = 2^(semitones/12)`
- Node is instantiated only when `semitones !== 0`; at 0 the source connects directly to the gain node (bypass)
- `setSemitones()` debounces the graph restart by 150ms to avoid tearing down audio on every slider tick
- `rubberbandWorkletLoaded` flag prevents double-registration across play calls

---

## IndexedDB Schema

**Database:** `stagehand_db` (version 1)  
**Object store:** `tracks` (keyPath: `id`)

```js
{
  id:          String,   // "trk_<timestamp>_<random>"
  name:        String,   // display name (editable)
  format:      String,   // "WAV" | "MP3" | "FLAC" | "OGG"
  size:        Number,   // bytes
  semitones:   Number,   // −12 to +12
  volume:      Number,   // 0.0 to 1.0
  arrayBuffer: ArrayBuffer,  // raw audio file bytes
  addedAt:     Number    // Date.now()
}
```

**Critical:** IndexedDB `put()` uses the structured clone algorithm which **transfers** (detaches) ArrayBuffers. Always `.slice(0)` the buffer before storing to keep a live in-memory copy:
```js
const abForMemory = ab.slice(0);
await LibraryManager.save({ ...track, arrayBuffer: ab }); // ab gets transferred/detached
tracks.push({ ...track, arrayBuffer: abForMemory });       // keep live copy
```

**`saveMeta(meta)`** — metadata-only update that reads the existing record, merges scalar fields via `Object.assign`, and puts it back without touching the stored `arrayBuffer`. Use this for volume/semitones/name changes. `saveTrackMeta()` in ui-controller.js strips `arrayBuffer` before calling it.

---

## Design System

### Fonts (Google Fonts)
- **Rajdhani** (700) — headings, panel titles, BPM display, logo
- **JetBrains Mono** (300/400/500) — labels, metadata, monospace values
- **Barlow Condensed** (300–600) — body, buttons, nav items

### Color Palette (CSS variables)
```css
--bg-base:       #0a0a0c   /* page background */
--bg-panel:      #111116   /* sidebar, topbar */
--bg-card:       #18181f   /* track cards, metro cards */
--bg-hover:      #1f1f2a
--bg-active:     #23232e
--border:        #2a2a38
--border-bright: #3a3a50
--accent:        #e8ff47   /* yellow-green: active states, play indicators */
--accent-dim:    #b8cc30
--accent-glow:   rgba(232,255,71,0.15)
--red:           #ff4757   /* delete, danger */
--cyan:          #47e8d4   /* transpose value display */
--purple:        #9b6dff   /* reserved for future use */
--text-primary:  #eeeef5
--text-secondary:#8888a8
--text-dim:      #55556a
```

---

## Roadmap (planned features, not yet built)

### v2 — VST Plugin Panel (UI stub)
- Plugin chain UI: load `.vst3`/`.dll` by path, drag-to-reorder slots
- Per-plugin: bypass toggle, input gain, output gain (real GainNodes wired in graph)
- I/O channel selector (L, R, stereo) — stored in state, awaiting Electron bridge
- No actual DSP until Electron migration

### v3 — Electron migration
- Wrap renderer in `BrowserWindow`
- Replace IndexedDB with native filesystem paths
- Add `node-addon-api` + JUCE or clap-host as VST3 bridge
- Package with `electron-builder` for `.exe` / `.dmg`

### Future panels (stubs reserved in sidebar)
- **Live Input** — `getUserMedia` → `MediaStreamSourceNode`, input monitor + gain
- **Loop Regions** — draggable loop handles on waveform; `AudioBufferSourceNode.loopStart/loopEnd`
- **Chord Charts** — VexFlow or ABC.js renderer, no audio coupling

---

## Development Notes

- Browser support: **Chrome and Firefox only** (AudioWorklet + WASM requirement)
- Serve `renderer/` from a local HTTP server (e.g. `npx serve renderer/`) — ES modules require HTTP, not `file://`
- Metronome lookahead pattern: `setInterval(scheduler, 25ms)` + schedule notes up to `currentTime + 0.1s` ahead using Web Audio time
- Waveform canvas re-renders on each `buildTrackCard()` call; peaks sampled at 1px resolution from `AudioBuffer.getChannelData(0)`
- `rubberbandWorkletLoaded` flag prevents double-registration across play calls

---

## Session History Summary

Built iteratively in Claude.ai then Claude Code:
1. Full architecture planning session — layout, modules, audio routing graph, VST strategy, roadmap
2. v1 build — single HTML file, all modules inlined
3. Bug fix: IndexedDB ArrayBuffer transfer/detach → kept `abForMemory = ab.slice(0)` before store
4. Bug fix: AudioContext suspended on play → `ctx.resume()` before worklet load and decode
5. Pitch shifter v1 → broken (shared `_inPtr`/`_outPtr`, wrong window read, silent output)
6. Pitch shifter v2 → rewritten with correct OLA two-class architecture (phaze-worklet.js)
7. Pitch shifter v2 bug fix → `parameters.get()` TypeError + `_outWritePtr` init wrong
8. **Phase 01 (Claude Code)** — split monolith into multi-file `renderer/` structure
9. **Phase 02 (Claude Code)** — replaced phaze-worklet.js with Rubber Band WASM (`rubberband-web@0.2.1`); human listening test passed at ±7 semitones
10. **Quick tasks (Claude Code)** — miniplayer added to sidebar bottom; 5 renderer bugs fixed (rename repeatability, meta-only IDB save, seek time display, transpose debounce, prev/next reset)
11. **v1.1.0 release (Claude Code)** — per-track cent fine-tune (±50¢) with popover UI in track card and miniplayer; hold-to-repeat acceleration on ±1¢ buttons; Tauri desktop app packaging with GitHub Actions release workflow

<!-- GSD:project-start source:PROJECT.md -->
## Project

**Stagehand — Transpose Quality Improvement**

Stagehand is a musician's rehearsal tool for playing along with recordings. The current v1 prototype is a single HTML file with audio library management, waveform display, playback, per-track transpose, and a metronome. This milestone replaces the custom OLA phase vocoder (which produces robotic, smeared artifacts) with Rubber Band WASM — a professional-grade pitch shifter — and splits the monolithic HTML into a proper multi-file structure as a step toward the long-term Electron target.

**Core Value:** Musicians can transpose any track ±7 semitones and have it sound good enough to play along with in a real rehearsal.

### Constraints

- **Browser:** Chrome and Firefox only — AudioWorklet + WASM both supported
- **No build step:** Keep deployable without a bundler (vanilla JS modules or inline scripts)
- **Preserve IndexedDB data:** Existing user audio libraries must not be broken by the restructure
- **Single developer:** Just David — no CI/CD, no review process
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Recommended Stack
### Core: Pitch Shifting Engine
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| rubberband-web | ^1.0.0 (verify on npm) | WASM-compiled Rubber Band Audio library | Only maintained WASM build of Rubber Band designed specifically for browser AudioWorklet use. Ships pre-compiled .wasm binary. Used by real DAW-adjacent tools. |
| Rubber Band Audio (underlying) | 3.x | C++ pitch/time algorithm | Industry-standard algorithm used in professional DAWs (Ableton, Logic, etc.). Superior transient handling and phase locking vs custom OLA vocoder. |
### AudioWorklet Integration Layer
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| AudioWorkletProcessor (native Web Audio API) | N/A (browser API) | Real-time audio processing thread | Required — WASM pitch processing must happen on the audio thread to avoid main-thread blocking and glitches. rubberband-web is designed to run inside an AudioWorkletProcessor. |
| AudioWorkletNode (native Web Audio API) | N/A (browser API) | Main-thread handle to worklet | Existing pattern in the app — minimal change to audio graph wiring. |
### File Delivery
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Local .wasm file | — | Deliver rubberband.wasm to browser | Mandatory for no-build-step constraint. CDN delivery of .wasm is unreliable for offline use and adds CORS complexity. The .wasm binary (~500KB–1MB) must be a static file alongside index.html. |
| ES Module scripts | native (no bundler) | Load worklet and JS modules | Matches no-build-step constraint. Use `<script type="module">` + static `import`. No webpack/Rollup/Vite required. |
### Browser Compatibility Target
| Browser | Version | Status | Notes |
|---------|---------|--------|-------|
| Chrome | 66+ | Required | AudioWorklet, WASM, SharedArrayBuffer (with COOP/COEP headers if needed) |
| Firefox | 76+ | Required | Same API surface. WASM threads require cross-origin isolation headers. |
| Safari | — | Not supported | Excluded by existing project constraint ("Chrome and Firefox only") |
## WASM Threading Constraint — Critical Decision
### The Problem
### rubberband-web's Approach
### Where WASM Runs
## WASM Binary Delivery — How to Load It
### Pattern A: Pass binary via AudioWorkletNode constructor options (Recommended)
### Pattern B: Import worklet-compatible module (alternative)
## Supporting Libraries
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| None (no build tooling) | — | — | Project explicitly requires no bundler. No npm run build. |
## What NOT to Use
| Option | Why Not |
|--------|---------|
| SoundTouch.js | JavaScript OLA pitch shifter — same class of artifact as current custom vocoder. Better JS implementation but inferior algorithm. No transient preservation. |
| Tone.js PitchShift | Wraps SoundTouch under the hood. Same quality ceiling. Also pulls in large Tone.js dependency for one effect. |
| Web Audio API `playbackRate` | Pitch change = tempo change. Not appropriate for musicians who want pitch-only transpose. |
| pitch-shifter npm packages (various) | Most are phase vocoder implementations — same artifact class as current code. Low maintenance. |
| rubberband.js (unofficial) | Various Emscripten experiments exist on GitHub with no maintenance. Avoid — rubberband-web is the maintained option. |
| WASM built from source (custom Emscripten) | Viable but high complexity, no benefit over rubberband-web's pre-built binary for this project. Reserve for Electron native migration. |
| Shared memory / WASM threads build | Requires COOP/COEP headers. Adds deployment complexity for a no-server-config scenario. Use single-threaded build. |
## File Structure for This Milestone
## Installation
# One-time setup to get the files
# Then copy the dist files to your project
# cp node_modules/rubberband-web/dist/rubberband.wasm ./wasm/
# cp node_modules/rubberband-web/dist/rubberband-worklet.js ./js/  (if provided)
## Alternatives Considered
| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Pitch algorithm | rubberband-web (Rubber Band) | SoundTouch.js | Inferior algorithm — same OLA artifact class as current vocoder |
| WASM delivery | Local file | CDN (jsDelivr/unpkg) | CORS complexity, offline unreliable, WASM served from CDN sometimes blocked by browser security policies |
| WASM delivery | Local file | base64-embedded | Inflates HTML/JS by ~33%, defeats purpose of file split |
| Thread model | Single-threaded WASM in worklet | WASM threads with SAB | Requires server headers (COOP/COEP), unnecessary complexity for single-threaded use case |
| Module system | Native ES modules | Bundler (Vite/Rollup) | Explicit project constraint: no build step |
## Open Questions (Require Verification)
## Sources
- Training data only (knowledge cutoff August 2025). No web sources could be verified in this session.
- Rubber Band Audio C++ library: https://breakfastquay.com/rubberband/
- rubberband-web GitHub (to verify): https://github.com/mmckegg/rubberband-web
- rubberband-web npm (to verify): https://www.npmjs.com/package/rubberband-web
- AudioWorklet spec (authoritative): https://webaudio.github.io/web-audio-api/#audioworklet
- WASM + AudioWorklet threading: https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## CI / Release — Critical Notes

### GitHub Actions release workflow (`.github/workflows/release.yml`)
- Triggered by pushing a `v*` tag (e.g. `v1.1.0`)
- Runs on `windows-latest`, builds the Tauri app, creates a GitHub release with the installer attached
- Uses `tauri-apps/tauri-action@v0` for build + upload in a single step

### tauri-action@v0 gotchas
- **`tauriScript` is a prefix, not a full command.** The action always appends `build` to it. `tauriScript: npm run tauri:build` becomes `npm run tauri:build build` — wrong. The correct pattern is to have a `"tauri": "tauri"` script in `package.json` and let the action use its default (`npm run tauri build`).
- **`skipBuild` is not a valid input** for `tauri-action@v0` — it is silently ignored and the action still runs its own build.
- Valid inputs include: `tagName`, `releaseName`, `releaseBody`, `releaseDraft`, `prerelease`, `tauriScript`, `args`, `releaseId`, etc.

### ASIO SDK requirement
- `cpal` is compiled with `features = ["asio"]`, which requires the **Steinberg ASIO SDK** at compile time on Windows.
- GitHub Actions `windows-latest` does not have it pre-installed.
- The workflow downloads it before the build step:
  ```powershell
  Invoke-WebRequest -Uri "https://download.steinberg.net/sdk_downloads/asiosdk_2.3.3_2019-06-14.zip" ...
  ```
- Also requires `LIBCLANG_PATH` pointing to the LLVM bin directory (LLVM is pre-installed on `windows-latest` at `C:\Program Files\LLVM\bin`).

### Git push restrictions in Claude Code agent environment
- Direct `git push` to `main` is blocked (HTTP 403) — branch protection enforces PRs.
- `git push` of tags is also blocked (HTTP 403).
- **Workaround for all pushes to main:** push to a feature branch → create PR via `mcp__github__create_pull_request` → merge via `mcp__github__merge_pull_request`.
- **Workaround for triggering a release:** have the user create/recreate the tag via GitHub web UI at **github.com/{owner}/{repo}/releases/new** — creating a release with a new tag fires the `push: tags` workflow trigger.
- The GitHub mobile app does not support deleting tags — use a browser.
- There is no `update_release` or `delete_tag` MCP tool available. Release description must be edited manually via the GitHub web UI or set via `releaseBody` in the workflow YAML.

### package.json scripts convention
```json
"tauri": "tauri",        ← required for tauri-action default build command
"tauri:dev": "tauri dev",
"tauri:build": "tauri build"
```

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
