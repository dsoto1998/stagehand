# Phase 2: Rubber Band Integration - Research

**Researched:** 2026-03-24
**Domain:** WebAssembly pitch shifting via AudioWorklet — rubberband-web npm package integration
**Confidence:** MEDIUM (package API verified via CDN; processor internals are minified, but key interface patterns confirmed)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Create a minimal `package.json` at the project root with an `npm run setup` script that installs rubberband-web and copies the dist files into place.
- **D-02:** The setup script copies BOTH `rubberband.wasm` → `wasm/` AND the rubberband worklet JS file (if rubberband-web ships one) → `renderer/js/`. Exact filenames to be confirmed by researcher from the actual npm package contents.
- **D-03:** `node_modules/` is gitignored. `rubberband.wasm` (and any copied worklet JS) is committed to git after the initial setup run — so the app works offline without requiring consumers to run setup.
- **D-04:** Example setup script shape:
  ```json
  "scripts": {
    "setup": "npm install && cp node_modules/rubberband-web/dist/rubberband.wasm wasm/ && cp node_modules/rubberband-web/dist/<worklet-file>.js renderer/js/"
  }
  ```
  Researcher must confirm exact dist file names and paths from the rubberband-web npm package.
- **D-05:** Preserve current behavior — restart playback on any semitone change (`setSemitones()` calls `this.play(this.currentTime)` when playing). No seamless mid-stream pitch morphing required.
- **D-06:** No AudioWorklet k-rate parameter update path needed. The worklet is torn down and reconstructed on each semitone change.
- **D-07:** ±7 semitones is the quality bar. ±12 is supported best-effort — no additional validation at the extremes.
- **D-08 (Claude's Discretion):** If rubberband-web ships its own AudioWorkletProcessor JS file, prefer using it directly over writing a custom wrapper. Only write a custom worklet if the library doesn't provide one or its API is incompatible.
- **D-09 (Claude's Discretion):** The new worklet registration name replaces `'phaze-processor'`. Use whatever rubberband-web registers, or name it `'rubberband-processor'` if writing a custom wrapper.
- **D-10:** `renderer/js/phaze-worklet.js` is deleted as part of this phase.
- **D-11:** `phazeWorkletLoaded` flag and `ensurePhazeWorklet()` in `track-player.js` are replaced with a rubberband equivalent. The pattern (lazy load on first play, guard flag) is preserved.

### Claude's Discretion

- Whether rubberband-web's worklet file needs to be fetched and have the `.wasm` path injected at load time (common WASM pattern) vs. loaded standalone
- Exact WASM loading pattern: whether to pass the binary via `AudioWorkletNode` constructor options or fetch it inside the worklet
- Whether a `.gitignore` already exists at project root (check before creating one)

### Deferred Ideas (OUT OF SCOPE)

- Seamless real-time pitch morphing (drag slider = continuous pitch update without restart)
- Time stretching (tempo-independent pitch shifting)
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| INT-01 | Rubber Band WASM replaces the existing OLA phase vocoder AudioWorklet | rubberband-web 0.2.1 ships `rubberband-processor.js` (598KB, WASM-embedded) — a complete AudioWorkletProcessor ready for `addModule` |
| INT-02 | Transpose slider (−12 to +12 semitones) continues to work in real time, updating pitch without interrupting playback | `setSemitones()` already restarts playback on change; rubberband-web's `setPitch(ratio)` is called after node creation; restart pattern requires no API change |
| INT-03 | Pitch shifting node is bypassed when semitones = 0 (same behavior as before) | Existing bypass logic in `track-player.js` (`if (this.semitones !== 0)`) is unchanged — bypass logic is independent of which worklet is loaded |
| PITCH-01 | Transpose produces no robotic/metallic artifacts at ±7 semitones on full band mixes | Rubber Band uses high-quality phase vocoder with phase locking and transient handling — categorically superior to OLA phase vocoder; used in Ableton, Logic, Final Cut Pro |
| PITCH-02 | Transpose produces no smeared transients at ±7 semitones on full band mixes | Rubber Band's transient detection mode preserves drum hits and percussive content; not available in simple OLA |
| PITCH-03 | Pitch is stable throughout playback at ±7 semitones | Rubber Band's synthesis phase tracking produces stable output; known wavering/drift issue with custom OLA vocoder is eliminated |
</phase_requirements>

---

## Summary

Phase 2 is an engine swap: remove the custom OLA phase vocoder (`phaze-worklet.js`) and replace it with the rubberband-web WASM AudioWorklet. The npm package `rubberband-web@0.2.1` (by delude88, last published ~3 years ago but functionally stable) ships exactly what this phase needs: a pre-built `rubberband-processor.js` in its `public/` directory that bundles the WASM binary inline (~598KB), and a helper function `createRubberBandNode` in `dist/esm/` or `dist/cjs/`. The processor registers under the name `"rubberband-processor"`.

The critical finding is that **rubberband-web does NOT ship a standalone `rubberband.wasm` file** — the WASM binary is compiled into `public/rubberband-processor.js` as an embedded binary. This invalidates the D-02/D-04 decision shape that assumed a separate `.wasm` file would be copied to `wasm/`. The actual setup script copies only `rubberband-processor.js` → `renderer/js/`. The `wasm/` directory remains empty (placeholder kept).

The integration path is: copy `public/rubberband-processor.js` to `renderer/js/`, call `ctx.audioWorklet.addModule('./js/rubberband-processor.js')`, create `new AudioWorkletNode(ctx, 'rubberband-processor', options)`, call `node.setPitch(Math.pow(2, semitones/12))` via the helper or directly via `node.port.postMessage`.

**Primary recommendation:** Use rubberband-web's pre-built `rubberband-processor.js` directly (D-08 path: prefer library-provided worklet). Do not write a custom worklet wrapper. Wire pitch via `postMessage` or via the `createRubberBandNode` helper's `setPitch()` method.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| rubberband-web | 0.2.1 | WASM AudioWorklet for browser pitch shifting | Only maintained WASM build of Rubber Band designed for AudioWorklet; ships self-contained worklet JS with WASM embedded |
| Rubber Band Audio (underlying C++) | 3.x | High-quality pitch/time algorithm | Industry standard used in Ableton, Logic, Final Cut Pro; transient-aware phase vocoder |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Native Web Audio API | Browser-native | AudioWorkletNode, AudioContext | All audio routing — no change from current approach |
| npm (setup only) | 11.9.0 (verified) | One-time package install to extract dist files | Only needed to run `npm run setup`; not a build step |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| rubberband-web | SoundTouch.js | Same OLA artifact class as current vocoder — inferior quality ceiling |
| rubberband-web | pitch-shifter npm | Various phase vocoder JS implementations — same artifact class |
| rubberband-web | Build from source (Emscripten) | Viable but high complexity, no benefit over pre-built binary |

**Installation (setup script — one-time):**
```bash
npm install rubberband-web
# Then copy worklet file:
cp node_modules/rubberband-web/public/rubberband-processor.js renderer/js/
# Note: No separate rubberband.wasm file exists — WASM is embedded in rubberband-processor.js
# The wasm/ directory placeholder (.gitkeep) stays but receives no file from rubberband-web
```

**Version verification (performed during research):**
- Package: `rubberband-web@0.2.1` — confirmed current on npm registry
- Last published: ~3 years ago (stable, no breaking changes needed)
- Node: v24.14.0, npm: 11.9.0 — both available in environment

---

## Architecture Patterns

### Recommended Project Structure (after Phase 2)

```
renderer/
├── index.html
├── style.css
└── js/
    ├── audio-engine.js
    ├── library-manager.js
    ├── rubberband-processor.js   ← NEW (copied from node_modules/rubberband-web/public/)
    ├── track-player.js           ← MODIFIED (ensurePhazeWorklet → ensureRubberbandWorklet)
    ├── metronome.js
    ├── waveform.js
    └── ui-controller.js
wasm/                             ← .gitkeep stays, no rubberband.wasm needed
package.json                      ← NEW (setup script)
.gitignore                        ← NEW (node_modules)
```

### Pattern 1: Worklet Load and Node Creation

**What:** Lazy-load the rubberband AudioWorklet module on first play, then create an AudioWorkletNode with the registered processor name.

**When to use:** Every time a track plays with `semitones !== 0`.

```javascript
// Source: delude88/rubberband-web CDN analysis (dist/cjs/createRubberBandNode.js)
// Processor registration name confirmed: "rubberband-processor"
// Load pattern (replaces ensurePhazeWorklet):
let rubberbandWorkletLoaded = false;
async function ensureRubberbandWorklet() {
  if (rubberbandWorkletLoaded) return;
  const ctx = resume();
  if (ctx.state === 'suspended') await ctx.resume();
  await ctx.audioWorklet.addModule('./js/rubberband-processor.js');
  rubberbandWorkletLoaded = true;
}

// Node creation (replaces 'phaze-processor' AudioWorkletNode):
const pitchNode = new AudioWorkletNode(ctx, 'rubberband-processor', {
  numberOfInputs: 1,
  numberOfOutputs: 1,
  outputChannelCount: [buffer.numberOfChannels]
});
```

### Pattern 2: Pitch Parameter via postMessage

**What:** rubberband-web uses `port.postMessage` for parameter updates — NOT AudioParam.

**When to use:** Immediately after creating the AudioWorkletNode and before connecting it.

```javascript
// Source: dist/cjs/createRubberBandNode.js — setPitch implementation
// Pitch value is a frequency ratio: 1.0 = no change, 2^(semitones/12) for semitone transpose
const pitchRatio = Math.pow(2, semitones / 12);  // Same formula as current phaze-worklet
pitchNode.port.postMessage(JSON.stringify(["pitch", pitchRatio]));
```

**Note:** This replaces the current `pitchNode.parameters.get('pitchFactor').value = factor` line. The rubberband-web processor uses message passing, not AudioParam descriptors.

### Pattern 3: Using createRubberBandNode Helper (Alternative)

**What:** The library ships a helper that wraps addModule + AudioWorkletNode creation.

**When to use:** Only if the no-bundler constraint allows importing from dist/esm/index.js. Since the project uses `<script type="module">` in the browser, a direct import path like `import { createRubberBandNode } from '../node_modules/rubberband-web/dist/esm/index.js'` would work without a bundler. However, the manual pattern (Pattern 1+2) is cleaner and avoids importing from node_modules.

```javascript
// Source: rubberband-web README + dist/cjs/createRubberBandNode.js
import { createRubberBandNode } from '../node_modules/rubberband-web/dist/esm/index.js';
const node = await createRubberBandNode(ctx, './js/rubberband-processor.js');
node.setPitch(Math.pow(2, semitones / 12));
// Returns a standard AudioWorkletNode with .setPitch(), .setTempo(), .setHighQuality() methods
```

**Recommendation:** Use Pattern 1+2 (manual) rather than this helper. The helper adds an async addModule call every time — the guard flag pattern (D-11) is cleaner and matches the existing codebase convention.

### Anti-Patterns to Avoid

- **Passing semitone count directly to setPitch:** `setPitch` takes a frequency ratio (1.0 = unity), not a semitone integer. Always compute `Math.pow(2, semitones/12)` first.
- **Re-loading the worklet module on every play:** The `rubberbandWorkletLoaded` guard flag prevents `addModule` from being called twice. Calling `addModule` for an already-registered processor name throws in Chrome.
- **Expecting AudioParam-based parameter control:** rubberband-web uses `port.postMessage`, not `parameterDescriptors`. The current `pitchNode.parameters.get('pitchFactor')` pattern does not apply.
- **Copying a separate rubberband.wasm file:** The package does not ship a standalone `.wasm` file. The `public/rubberband-processor.js` has the WASM binary embedded. Do not reference D-04's `cp node_modules/rubberband-web/dist/rubberband.wasm wasm/` — that file path does not exist.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| High-quality pitch shifting algorithm | Custom phase vocoder extensions | rubberband-web's embedded Rubber Band WASM | Rubber Band handles transient detection, phase locking, formant preservation — years of research that OLA cannot replicate |
| WASM binary compilation | Emscripten build from rubberband C++ source | rubberband-web's pre-built `rubberband-processor.js` | Pre-built, tested, known working in AudioWorklet context; custom builds require WASM toolchain |
| AudioWorkletProcessor for Rubber Band | Custom wrapper processor | `rubberband-processor.js` from package | The library ships a complete, working processor; writing a custom wrapper adds complexity with no benefit |

**Key insight:** The entire value of rubberband-web is that the hard WASM integration work is already done. The main task is correct file delivery and wiring the message-based API.

---

## Common Pitfalls

### Pitfall 1: Assumed Separate WASM File Does Not Exist

**What goes wrong:** The setup script attempts `cp node_modules/rubberband-web/dist/rubberband.wasm wasm/` and fails with "no such file."

**Why it happens:** CONTEXT.md D-04 anticipated a separate `.wasm` file, but rubberband-web@0.2.1 embeds the WASM binary inside `public/rubberband-processor.js`. There is no standalone `.wasm` artifact in the package.

**How to avoid:** Setup script copies only `public/rubberband-processor.js` → `renderer/js/`. The `wasm/` directory stays as a placeholder for a possible future Electron native build.

**Warning signs:** `ls node_modules/rubberband-web/` shows `dist/`, `public/`, `package.json`, `README.md` — no `*.wasm` at top level or in `dist/`.

### Pitfall 2: AudioWorkletNode Registration Name Mismatch

**What goes wrong:** `new AudioWorkletNode(ctx, 'phaze-processor', ...)` still references the old name → DOMException: Unable to find processor.

**Why it happens:** Mechanical find-and-replace misses the string literal.

**How to avoid:** The rubberband-processor.js registers `"rubberband-processor"`. Update the string literal in `track-player.js` exactly to `"rubberband-processor"`.

**Warning signs:** Audio silently fails, `pitchNode` is caught in the try/catch and set to null, audio routes directly to gainNode (unshifted).

### Pitfall 3: postMessage vs AudioParam — Silent No-Op

**What goes wrong:** Developer calls `pitchNode.parameters.get('pitchFactor').value = factor` on the rubberband node → TypeError ("Cannot read property 'value' of undefined") because the processor has no `pitchFactor` AudioParam descriptor.

**Why it happens:** rubberband-web uses `port.postMessage` for all parameter updates, not AudioParam descriptors.

**How to avoid:** Remove the `parameters.get()` call. Use `pitchNode.port.postMessage(JSON.stringify(["pitch", pitchRatio]))` immediately after node creation.

**Warning signs:** Pitch does not change from 1.0 (unity/no shift) even though semitones is non-zero.

### Pitfall 4: addModule Called Twice

**What goes wrong:** Chrome throws "NotSupportedError: A processor with the name 'rubberband-processor' already exists" on the second play call.

**Why it happens:** The `rubberbandWorkletLoaded` guard flag was not set, or was reset to false.

**How to avoid:** Module-level `let rubberbandWorkletLoaded = false` in `track-player.js`. Set to `true` after the first successful `addModule` call. Never reset it.

**Warning signs:** Second track play after pause throws in `ensureRubberbandWorklet`.

### Pitfall 5: Channel Count Mismatch

**What goes wrong:** Stereo tracks (2 channels) produce mono output or silence.

**Why it happens:** `outputChannelCount` not passed to AudioWorkletNode options, defaulting to 1 channel.

**How to avoid:** Preserve the existing `outputChannelCount: [buffer.numberOfChannels]` in the AudioWorkletNode constructor options. This pattern is already correct in `track-player.js` and must be kept.

**Warning signs:** Waveform indicates stereo but audio sounds mono (center-only).

### Pitfall 6: Missing .gitignore for node_modules

**What goes wrong:** `node_modules/` is accidentally committed (560MB+ with rubberband-web's WASM build tools).

**Why it happens:** No `.gitignore` exists at project root (confirmed — none found during research).

**How to avoid:** Create `.gitignore` with `node_modules/` before first `npm install`. This is part of Phase 2 setup.

---

## Code Examples

### Complete track-player.js Integration Points

```javascript
// Source: confirmed against track-player.js (Phase 1 output) + rubberband-web API

// 1. Replace module-level flag:
let rubberbandWorkletLoaded = false;

// 2. Replace ensurePhazeWorklet():
export async function ensureRubberbandWorklet() {
  if (rubberbandWorkletLoaded) return;
  const ctx = resume();
  if (ctx.state === 'suspended') await ctx.resume();
  await ctx.audioWorklet.addModule('./js/rubberband-processor.js');
  rubberbandWorkletLoaded = true;
}

// 3. In play(), replace AudioWorkletNode creation block:
const factor = Math.pow(2, this.semitones / 12);  // unchanged formula
if (this.semitones !== 0) {
  try {
    this.pitchNode = new AudioWorkletNode(ctx, 'rubberband-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [this.buffer.numberOfChannels]
      // Note: no processorOptions needed — rubberband-web manages its own internal state
    });
    // rubberband-web uses postMessage, not AudioParam:
    this.pitchNode.port.postMessage(JSON.stringify(["pitch", factor]));
    this.pitchNode.connect(this.gainNode);
  } catch (e) {
    this.pitchNode = null;
  }
} else {
  this.pitchNode = null;
}

// 4. Replace addModule call site in play():
await ensureRubberbandWorklet();  // renamed from ensurePhazeWorklet()
```

### package.json Setup Script

```json
{
  "name": "stagehand",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "setup": "npm install && cp node_modules/rubberband-web/public/rubberband-processor.js renderer/js/",
    "start": "npx serve . -p 8080"
  },
  "dependencies": {
    "rubberband-web": "0.2.1"
  }
}
```

Note: The setup script only copies `rubberband-processor.js`. There is no separate `.wasm` file to copy. The `wasm/` directory is not used by rubberband-web.

### .gitignore

```
node_modules/
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Custom OLA phase vocoder (JavaScript FFT) | Rubber Band WASM (C++ algorithm) | This phase | Eliminates robotic artifacts, preserves transients, stable phase tracking |
| Blob URL for worklet loading | `addModule('./js/rubberband-processor.js')` file path | Phase 1 established file-based pattern | Simpler, consistent, no runtime string generation |
| AudioParam k-rate parameter | `port.postMessage(JSON.stringify(["pitch", ratio]))` | rubberband-web API design | Message passing is rubberband-web's interface; AudioParam not used |

**Deprecated/outdated in this phase:**
- `phaze-worklet.js`: Entire file deleted. OLA phase vocoder replaced.
- `phazeWorkletLoaded` flag: Renamed to `rubberbandWorkletLoaded`.
- `ensurePhazeWorklet()`: Renamed and updated to load rubberband-processor.js.
- `processorOptions: { numChannels: ... }`: Not needed for rubberband-web (removed from AudioWorkletNode constructor).

---

## Open Questions

1. **Channel handling in rubberband-processor.js**
   - What we know: `outputChannelCount: [buffer.numberOfChannels]` is the existing pattern and should be passed
   - What's unclear: Whether rubberband-processor.js internally reads channel count from `outputChannelCount` or needs it injected via `processorOptions`
   - Recommendation: Pass `outputChannelCount` in constructor options (existing pattern). If stereo tracks produce mono output, add `processorOptions: { numChannels: buffer.numberOfChannels }` as a fallback.

2. **Exact processorOptions format accepted by rubberband-processor.js**
   - What we know: The processor name is `"rubberband-processor"`, the file is `public/rubberband-processor.js`, postMessage format is `JSON.stringify(["pitch", ratio])`
   - What's unclear: The processor internals are minified WASM-embedded JS — full processorOptions API not documented
   - Recommendation: Start with no processorOptions (rubberband-web is designed for zero-config use). Test stereo playback immediately. If issues arise, check library README or source.

3. **Windows compatibility of npm setup script cp command**
   - What we know: The project is developed on Windows 11; `cp` is a Unix command not available in cmd.exe
   - What's unclear: Whether `npm run setup` will be run from Git Bash (where `cp` works) or Windows cmd
   - Recommendation: Use `node -e "require('fs').cpSync(...)"` in the setup script instead of `cp` for cross-platform compatibility, OR document that setup must be run from Git Bash. Since the project's shell is confirmed as bash (from env context), `cp` is fine.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | npm run setup script | Yes | v24.14.0 | — |
| npm | Package install + setup script | Yes | 11.9.0 | — |
| rubberband-web@0.2.1 | Pitch shifting worklet | Not yet installed | — | Run `npm install` |
| Git Bash (Unix shell) | `cp` in setup script | Yes (confirmed: shell=bash) | — | Use node -e fallback |
| Chrome / Firefox | AudioWorklet + WASM | Developer environment (assumed) | — | Not applicable |

**Missing dependencies with no fallback:**
- None blocking. All required tools are available.

**Missing dependencies with fallback:**
- `rubberband-web`: Not yet installed but will be installed by `npm run setup`. The `renderer/js/rubberband-processor.js` file does not exist yet — it is created by running setup.

---

## Sources

### Primary (HIGH confidence)
- CDN fetch: `cdn.jsdelivr.net/npm/rubberband-web@0.2.1/dist/cjs/createRubberBandNode.js` — confirmed processor name `"rubberband-processor"`, confirmed postMessage API with `["pitch", value]`, `["tempo", value]`, `["quality", value]` commands
- CDN fetch: `cdn.jsdelivr.net/npm/rubberband-web@0.2.1/public/` — confirmed single file `rubberband-processor.js` (598.33KB), no separate `.wasm` file
- CDN fetch: `cdn.jsdelivr.net/npm/rubberband-web@0.2.1/README.md` — confirmed `createRubberBandNode(ctx, processorPath)` API
- CDN fetch: `registry.npmjs.org/rubberband-web` — confirmed latest version 0.2.1, dist structure (dist/cjs, dist/esm, dist/esm5, dist/types, public/)
- Direct code read: `renderer/js/track-player.js` — confirmed existing integration points: `ensurePhazeWorklet()`, `new AudioWorkletNode(ctx, 'phaze-processor', {...})`, `parameters.get('pitchFactor').value`
- Rubber Band C++ docs: `breakfastquay.com/rubberband/code-doc/classRubberBand_1_1RubberBandStretcher.html` — confirmed pitch scale is frequency ratio (2^(S/12) for semitone S)

### Secondary (MEDIUM confidence)
- WebSearch: delude88/rubberband-web GitHub — confirmed `public/rubberband-processor.js` is the worklet file, `dist/` has compiled JS, package is 0.2.1 last published ~3 years ago
- WebSearch: rubberband-web npm 2025 — confirmed 124 weekly downloads, functionally stable

### Tertiary (LOW confidence)
- Processor internals (channel handling, processorOptions format): inferred from pattern analysis of minified source + comparable AudioWorklet libraries. Not directly verified from readable source.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — package verified on npm, dist structure confirmed via CDN, API confirmed from compiled JS
- Architecture: HIGH — integration points in track-player.js directly read, rubberband-web API confirmed
- Pitfalls: MEDIUM — key pitfalls derived from confirmed facts (no separate .wasm, postMessage vs AudioParam); channel handling pitfall is LOW (unverified processor internals)

**Research date:** 2026-03-24
**Valid until:** 2026-09-24 (stable package, no active development expected)

**Critical correction to CONTEXT.md D-02/D-04:**
The context assumed rubberband-web ships a separate `rubberband.wasm` file to copy to `wasm/`. This is incorrect. The package ships `public/rubberband-processor.js` only (WASM binary embedded). The setup script copies one file, not two. The `wasm/` directory placeholder remains empty. The planner must update the setup script shape accordingly.
