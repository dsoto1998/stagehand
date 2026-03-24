# STAGEHAND — Rehearsal Tool
## Claude Code Context File

---

## Project Overview

**Stagehand** is a cross-platform musician's rehearsal tool. It is currently a single self-contained HTML file (`rehearsal-tool-v1.html`) built with vanilla JS and the Web Audio API. The long-term target is an **Electron app** (Windows + Mac) with native VST3 plugin hosting.

---

## Current Status: v1.0 (HTML prototype)

### Working Features
- **Audio Library** — Import WAV, MP3, FLAC, OGG/Opus. Rename, delete, persist across sessions via IndexedDB.
- **Waveform display** — Canvas-rendered from decoded AudioBuffer, amplitude-colored.
- **Playback** — Play/pause, seek by clicking waveform, per-track volume slider.
- **Transpose** — Per-track semitone slider (−12 to +12) using an inline phase-vocoder pitch shifter (Phaze architecture).
- **Metronome** — BPM input (typable + ±1 buttons), tap tempo, subdivisions (1/4, 1/8, triplet, 1/16), beat flash visualizer, custom click sound loader, volume control.
- **Master volume** — GainNode on AudioContext destination.

### Known Issues / In Progress
- None currently. Transpose pitch shifter is working.

---

## Architecture

### File Structure (current)
```
rehearsal-tool-v1.html   ← entire app, single file (CSS + HTML + JS inlined)
```

### Target File Structure (Electron migration)
```
stagehand/
├── package.json
├── main.js                  ← Electron main process
├── preload.js               ← Electron preload (context bridge)
├── renderer/
│   ├── index.html
│   ├── style.css
│   └── js/
│       ├── audio-engine.js      ← AudioContext, master gain, routing
│       ├── library-manager.js   ← IndexedDB CRUD
│       ├── track-player.js      ← AudioBufferSourceNode + pitch routing
│       ├── phaze-worklet.js     ← AudioWorkletProcessor (pitch shifter)
│       ├── metronome.js         ← Lookahead scheduler + tap tempo
│       ├── waveform.js          ← Canvas waveform renderer
│       └── ui-controller.js     ← DOM bindings, panel routing
├── native/
│   └── vst-bridge/              ← Future: node-addon-api + JUCE VST host
└── CLAUDE.md
```

---

## Audio Engine Design

### Routing Graph
```
[AudioBufferSourceNode]
        │
[AudioWorkletNode]     ← PhaseVocoderProcessor (Phaze), only inserted when semitones !== 0
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

## Pitch Shifter (Phaze Worklet)

### Architecture
Two-class OLA phase vocoder, inlined as a Blob URL loaded via `audioWorklet.addModule()`.

**`OLAProcessor`** (base class, extends `AudioWorkletProcessor`):
- Manages three independent ring buffer pointers:
  - `_inWritePtr` — advances 1/sample as input is written
  - `_outReadPtr` — advances 1/sample as output is consumed
  - `_outWritePtr` — advances by `hopSize` each time a frame is OLA-accumulated
- Ring buffer size: `frameSize * 8` (prevents read/write head collision)
- Fires `processFrame()` every `hopSize` input samples once `_inputFill >= frameSize`
- Applies Hann window + normalisation (`2 * hopSize / frameSize`) during OLA accumulation
- **`processFrame` must NOT re-window its output** — the OLA layer owns windowing

**`PhaseVocoderProcessor`** (extends `OLAProcessor`):
- `frameSize = 2048`, `overlap = 4`, `hopSize = 512`
- Analysis: windowed FFT → magnitude + true frequency (principal-value phase difference)
- Synthesis: scatter bin `k` → bin `round(k * pitchFactor)`, accumulate with updated synthesis phase
- Inverse FFT → return raw real part (no synthesis window)
- `pitchFactor` = `2^(semitones/12)`, passed as AudioWorklet k-rate parameter

### Key bugs already fixed
1. `nCh` was derived from `inp.length` which is 0 on silent blocks → fixed to use `this._numChannels`
2. Double-windowing (analysis window applied in processFrame AND OLA layer) → removed from processFrame
3. `parameters.get('pitchFactor')` — `parameters` in AudioWorkletProcessor.process() is a plain object, not a Map; `.get()` threw TypeError every frame, crashing process() and silencing the node → fixed to `parameters['pitchFactor']`
4. Input ring base calculation used raw negative subtraction → fixed with `(ptr - fs + BUF*8) % BUF`
5. `_outWritePtr` initialised to `0` — OLA output was written into already-consumed ring positions; read pointer was always `frameSize` ahead of write pointer, producing one Hann-edge sample (≈0) per hop → fixed to `this._frameSize - 1` so the first frame's output lands at the current read position

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

- Browser support: **Chrome and Firefox only** (AudioWorklet requirement)
- The single HTML file is intentional for portability during prototyping — split into modules when migrating to Electron
- Metronome lookahead pattern: `setInterval(scheduler, 25ms)` + schedule notes up to `currentTime + 0.1s` ahead using Web Audio time
- Waveform canvas re-renders on each `buildTrackCard()` call; peaks sampled at 1px resolution from `AudioBuffer.getChannelData(0)`
- `phazeWorkletLoaded` flag prevents double-registration across play calls; worklet module is loaded from a Blob URL created at play time

---

## Session History Summary

Built iteratively in Claude.ai (claude.ai chat):
1. Full architecture planning session — layout, modules, audio routing graph, VST strategy, roadmap
2. v1 build — single HTML file, all modules inlined
3. Bug fix: IndexedDB ArrayBuffer transfer/detach → kept `abForMemory = ab.slice(0)` before store
4. Bug fix: AudioContext suspended on play → `ctx.resume()` before worklet load and decode
5. Pitch shifter v1 → broken (shared `_inPtr`/`_outPtr`, wrong window read, silent output)
6. Pitch shifter v2 → rewritten with correct OLA two-class architecture
7. Pitch shifter v2 bug fix (Claude Code session) → two bugs caused silence: `parameters.get()` TypeError (fix #3 above) + `_outWritePtr` init at wrong ring position (fix #5 above)

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
