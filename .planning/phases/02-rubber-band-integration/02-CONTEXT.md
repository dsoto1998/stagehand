# Phase 2: Rubber Band Integration - Context

**Gathered:** 2026-03-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace `renderer/js/phaze-worklet.js` (OLA phase vocoder AudioWorklet) with rubberband-web (Rubber Band Audio compiled to WASM) as the pitch shifting backend. Wire it into `track-player.js`. The transpose slider, bypass behavior, and all other features remain unchanged. This phase is purely an engine swap — no new capabilities.

Entry point for pitch routing: `renderer/js/track-player.js` (`ensurePhazeWorklet()` becomes rubberband equivalent).

</domain>

<decisions>
## Implementation Decisions

### WASM Binary Delivery
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

### Real-Time Slider Behavior
- **D-05:** Preserve current behavior — restart playback on any semitone change (`setSemitones()` calls `this.play(this.currentTime)` when playing). No seamless mid-stream pitch morphing required. This matches the existing `TrackPlayer.setSemitones()` implementation in `track-player.js`.
- **D-06:** No AudioWorklet k-rate parameter update path needed. The worklet is torn down and reconstructed on each semitone change, same as the current Phaze approach.

### Quality Expectation
- **D-07:** ±7 semitones is the quality bar (matches PITCH-01, PITCH-02, PITCH-03 requirements). ±12 semitones is supported but quality is best-effort — no additional validation needed at the extremes.

### Worklet Architecture
- **D-08 (Claude's Discretion):** If rubberband-web ships its own AudioWorkletProcessor JS file, prefer using it directly over writing a custom wrapper. Only write a custom worklet if the library doesn't provide one or its API is incompatible with the existing AudioWorkletNode pattern. Researcher must determine which path applies.
- **D-09 (Claude's Discretion):** The new worklet registration name (replacing `'phaze-processor'`) should match whatever rubberband-web registers. Update the `AudioWorkletNode` constructor call in `track-player.js` accordingly. If we write a custom wrapper, name it `'rubberband-processor'`.

### Removal of Old Worklet
- **D-10:** `renderer/js/phaze-worklet.js` is deleted as part of this phase (OLA vocoder fully removed per PITCH-03 / success criterion 5).
- **D-11:** `phazeWorkletLoaded` flag and `ensurePhazeWorklet()` in `track-player.js` are replaced with a rubberband equivalent. The pattern (lazy load on first play, guard flag) is preserved.

### Claude's Discretion
- Whether rubberband-web's worklet file needs to be fetched and have the `.wasm` path injected at load time (common WASM pattern) vs. loaded standalone
- Exact WASM loading pattern: whether to pass the binary via `AudioWorkletNode` constructor options or fetch it inside the worklet
- Whether a `.gitignore` already exists at project root (check before creating one)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project architecture and constraints
- `CLAUDE.md` — Definitive source: audio routing graph, AudioWorklet patterns, existing bug fixes (parameters['pitchFactor'], _outWritePtr init), design system. Read entirely before planning.
- `renderer/js/track-player.js` — Current pitch routing implementation. The `ensurePhazeWorklet()`, `TrackPlayer.play()`, and `TrackPlayer.setSemitones()` methods are the primary integration points to update.
- `renderer/js/phaze-worklet.js` — The file being replaced. Read to understand what the new worklet must replicate (pitch factor parameter, channel count, OLA architecture details not needed but structure is useful context).

### Requirements
- `.planning/REQUIREMENTS.md` §Pitch Shifting Quality — PITCH-01, PITCH-02, PITCH-03 define the quality bar
- `.planning/REQUIREMENTS.md` §Integration — INT-01, INT-02, INT-03 define the integration requirements
- `.planning/ROADMAP.md` §Phase 2 — Success criteria checklist (5 items) that verification will check against

### External library (researcher must verify current state)
- rubberband-web npm: https://www.npmjs.com/package/rubberband-web
- rubberband-web GitHub: https://github.com/mmckegg/rubberband-web

### Prior phase context
- `.planning/phases/01-file-restructure/01-CONTEXT.md` — Phase 1 decisions: ES module patterns, module boundaries, worklet loading approach

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `TrackPlayer` class (`renderer/js/track-player.js`): All methods except `play()` and `setSemitones()` require no changes. `loadBuffer()`, `pause()`, `stop()`, `seek()`, `setVolume()` stay identical.
- `ensurePhazeWorklet()` pattern: The lazy-load guard (`phazeWorkletLoaded` flag + `addModule()`) is the exact pattern to replicate for rubberband.
- `wasm/` directory: Already exists with `.gitkeep`. Ready to receive `rubberband.wasm`.

### Established Patterns
- **ES modules**: All renderer JS uses `export`/`import`. Any new worklet wrapper file follows the same convention.
- **addModule path**: `ctx.audioWorklet.addModule('./js/<worklet-file>.js')` — relative to renderer/index.html. Used verbatim in the rubberband equivalent.
- **AudioContext resume**: `resume()` called before any worklet operations. Pattern is in `track-player.js` and must be preserved.

### Integration Points
- `track-player.js` line ~8: `ensurePhazeWorklet()` — becomes `ensureRubberbandWorklet()` (or similar)
- `track-player.js` `play()`: `new AudioWorkletNode(ctx, 'phaze-processor', {...})` — registration name changes to match rubberband-web
- `track-player.js` `play()`: `this.pitchNode.parameters.get('pitchFactor').value = factor` — parameter API may change depending on rubberband-web's interface
- `renderer/index.html`: No changes expected — `ui-controller.js` loads as `<script type="module">`, pitch routing is internal to track-player

</code_context>

<specifics>
## Specific Ideas

- Binary delivery via npm script was chosen deliberately for reproducibility — the setup command documents exactly where the binary comes from
- "Restart on semitone change" is explicitly intentional, not a limitation to work around — matches current behavior the user is satisfied with
- rubberband-web binary availability was flagged as a blocker in STATE.md — researcher must verify the package is installable and ships a usable WASM binary before planning proceeds

</specifics>

<deferred>
## Deferred Ideas

- Seamless real-time pitch morphing (drag slider = continuous pitch update without restart) — explicitly deferred by user; would require mid-stream rubberband parameter updates
- Time stretching (tempo-independent pitch shifting) — out of scope this milestone per PROJECT.md

</deferred>

---

*Phase: 02-rubber-band-integration*
*Context gathered: 2026-03-24*
