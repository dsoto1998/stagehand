# STAGEHAND — Rehearsal Tool
## Claude Code Context File

---

## Project Overview

**Stagehand** is a musician's rehearsal tool for playing along with recordings. The app is a Tauri v2 desktop application (Windows primary target) combining a `renderer/` web frontend (HTML + CSS + ES modules) with a Rust audio backend (`src-tauri/`). The long-term target remains an Electron app with native VST3 plugin hosting.

The legacy monolith (`rehearsal-tool-v1.html`) still exists at the project root but is orphaned — `renderer/index.html` is the active entry point.

---

## Current Status: v1.1.0 / v2.0 milestone in progress

### Working Features
- **Audio Library** — Import WAV, MP3, FLAC, OGG/Opus/AIFF. Files saved to `$APPDATA/stagehand/library/` via Tauri filesystem commands.
- **ID3 Metadata** — Artist, album, title, duration parsed on import via `jsmediatags` (CDN). Stored in IndexedDB.
- **Artwork** — Embedded art extracted via jsmediatags; iTunes Search API fallback. Cached in IndexedDB `artwork` store.
- **Waveform display** — Canvas-rendered, amplitude-colored. Peaks computed by Rust decoder (`compute_peaks`), cached in IDB.
- **Library tabs** — Songs (virtual-scrolled compact rows), Artists (alphabetical list + drill-down), Playlists (empty state stub).
- **Virtual scrolling** — Fixed `ROW_H=50px` rows, vanilla JS spacer-div approach. No external library.
- **Playback** — Play/pause, seek, per-track volume. Audio routed entirely through Rust (rodio). Web Audio API only used for metronome.
- **Audio prefetch** — Next/prev track decoded on OS thread in background (`audio_prefetch` command). Cache hit avoids re-decode on play.
- **Transpose** — Per-track semitone slider (−12 to +12) + cent fine-tune (±50¢) via click-to-open popover. Rubber Band C++ (vendored, compiled via `cc` crate) in Rust audio engine. Popover in both track card and miniplayer. Hold-to-repeat with acceleration on ±1¢ buttons.
- **Speed control** — Per-track playback speed (separate from pitch).
- **Loop regions** — Loop toggle, in/out points, keyboard shortcuts.
- **Metronome** — BPM input, tap tempo, subdivisions, beat flash, volume control. Uses Web Audio API lookahead scheduler.
- **Master volume** — Global volume via Rust `audio_set_volume` command.
- **Miniplayer** — Persistent bottom panel: track name, scrubbable progress bar, elapsed/total time, play/pause, prev/next, transpose + cent popover, master volume.
- **Device picker** — WASAPI and ASIO output device selection (Windows).
- **Keyboard shortcuts** — 15 configurable shortcuts (playback, loop, metronome, library) stored in `localStorage`. Editable via Settings panel.
- **Chord charts** — Per-track: PDF upload or ChordPro text editor. Always-visible icon (0.25 opacity). Stored in IDB.
- **Settings panel** — Multi-tab (General, Display, Audio, Export). General tab: artwork cache clear, keyboard shortcuts editor.
- **GitHub Actions release** — `.github/workflows/release.yml` builds and publishes Windows installer on `v*` tag push.
- **Test suite** — Vitest unit tests in `tests/` covering library-manager, metronome, track-player, artwork-manager.

### Known Issues / In Progress
- Playlists tab: empty state only ("No playlists yet") — CRUD is Phase 5 scope.

---

## Architecture

### File Structure (current)
```
stagehand/
├── package.json                 ← scripts, deps (rubberband-web, vitest, tauri CLI)
├── vitest.config.js             ← test configuration (node environment, fake-indexeddb)
├── rehearsal-tool-v1.html       ← ORPHANED monolith, do not edit
├── renderer/
│   ├── index.html               ← active entry point (loaded by Tauri webview)
│   ├── style.css
│   └── js/
│       ├── audio-engine.js      ← minimal: AudioContext + metronomeGain only (track audio is Rust)
│       ├── library-manager.js   ← IndexedDB CRUD for tracks, playlists, settings, artwork
│       ├── track-player.js      ← Tauri IPC proxy (invoke audio_* commands)
│       ├── ui-controller.js     ← DOM bindings, virtual scroll, tabs, miniplayer, shortcuts
│       ├── metronome.js         ← Web Audio lookahead scheduler + tap tempo
│       ├── waveform.js          ← Canvas waveform renderer
│       ├── artwork-manager.js   ← artwork resolution: embedded → iTunes → IDB cache
│       ├── icons.js             ← SVG icon constants (ICONS object)
│       ├── tauri-api.js         ← thin shim over window.__TAURI__ IPC
│       ├── rubberband-processor.js  ← rubberband-web AudioWorkletProcessor (unused in Tauri build; kept for browser fallback)
│       ├── soundtouch-processor.js  ← legacy SoundTouch worklet (unused)
│       └── vendor/
│           └── jsmediatags.min.js   ← ID3 tag reader (loaded globally in index.html)
├── src-tauri/
│   ├── Cargo.toml               ← Rust deps: tauri 2, rodio, symphonia, cpal (ASIO), rubberband (vendored)
│   ├── tauri.conf.json          ← window config, CSP, asset protocol scope
│   ├── build.rs                 ← compiles vendored Rubber Band C++ via `cc` crate
│   ├── capabilities/
│   │   └── default.json         ← Tauri capability grants
│   ├── src/
│   │   ├── main.rs              ← Tauri builder entry point
│   │   ├── lib.rs               ← registers all commands with tauri::Builder
│   │   ├── audio.rs             ← AudioEngine struct: rodio sink, Rubber Band, prefetch cache
│   │   └── commands.rs          ← all #[tauri::command] handlers
│   └── vendor/
│       └── rubberband/          ← vendored Rubber Band C++ source (compiled at build time)
├── tests/
│   ├── setup.js                 ← fake-indexeddb + browser API polyfills
│   ├── library-manager.test.js
│   ├── metronome.test.js
│   ├── track-player.test.js
│   └── artwork-manager.test.js
└── .planning/                   ← GSD planning artifacts (do not edit manually)
    ├── STATE.md                 ← current project state (milestone, phase, decisions)
    ├── PROJECT.md               ← requirements, decisions, core value
    └── phases/ + quick/         ← per-phase and per-task plans/summaries
```

---

## Audio Architecture

### Tauri / Rust Audio Engine (`src-tauri/src/audio.rs`)

Track audio routes entirely through Rust. The Web Audio API is **only** used for the metronome click sound.

```
[Filesystem or IDB ArrayBuffer]
        │
  invoke('audio_load_file') or invoke('audio_load')
        │
[Rust AudioEngine]
  - symphonia decode → f32 samples
  - Rubber Band C++ pitch/time shifting
  - rodio Sink → WASAPI or ASIO output
```

Key Rust commands (all in `src-tauri/src/commands.rs`):

| Command | Purpose |
|---------|---------|
| `audio_load_file` | Load from filesystem path; checks prefetch cache first |
| `audio_load` | Load from raw bytes |
| `audio_check_prefetch` | Check if track is decoded in prefetch cache |
| `audio_prefetch` | Background-decode next/prev track on OS thread |
| `audio_play` | Start playback from offset with pitch/speed/volume/loop params |
| `audio_pause` | Pause; returns current position (secs) |
| `audio_resume` | Resume from pause offset |
| `audio_stop` | Stop and clear |
| `audio_seek` | Restart playback at new offset |
| `audio_set_semitones` | Live pitch change (replays from current offset) |
| `audio_set_speed` | Live speed change |
| `audio_set_volume` | Live volume change |
| `audio_set_loop` | Set loop enabled/start/end |
| `audio_get_devices` | List WASAPI + ASIO output devices |
| `audio_set_device` | Switch output device |
| `library_get_dir` | Return `$APPDATA/stagehand/library/` path |
| `library_scan` | Scan library dir; return `{id, name, path, ext, size}[]` |
| `library_check_paths` | Check if file paths still exist on disk |
| `open_audio_files_dialog` | Native file open dialog for audio import |
| `open_url` | Open URL in default browser (for chord charts etc.) |

### Rust audio.rs key patterns
- `AudioEngine` holds a rodio `Sink`, a `RubberBandStretcher`, and a `Mutex<Option<PrefetchEntry>>` prefetch cache.
- `play_with_params` / `seek` / `set_semitones` / `set_speed` restart the stretcher and re-fill the sink from the decoded sample buffer.
- `decode_to_samples()` uses symphonia to decode any supported format to `Vec<f32>` interleaved samples.
- `compute_peaks()` downsamples to 600 bins for waveform display.
- `audio_play` / `audio_seek` poll on `decode_pending` with 100ms sleep up to 8s (symphonia async decode path).

### Metronome (Web Audio only)
- `AudioContext` + `GainNode` (metronomeGain) — no track audio goes through here.
- `audio-engine.js` exports `getCtx()`, `resume()`, `getMetronomeGain()`. `setMasterVolume()` is a no-op (master volume goes via `invoke('audio_set_volume')`).

---

## Frontend Architecture (`renderer/js/`)

### Module Responsibilities

| Module | Role |
|--------|------|
| `ui-controller.js` | All DOM wiring, panel routing, virtual scroll, tab state machine, miniplayer, keyboard shortcuts, settings panel |
| `library-manager.js` | IndexedDB CRUD: all object stores |
| `track-player.js` | Thin wrapper around Tauri IPC. Holds per-track state (semitones, cents, speed, volume, loopStart/End). Does NOT touch Web Audio. |
| `tauri-api.js` | `invoke()` / `listen()` / `convertFileSrc()` / `writeAudioFile()` / `scanLibraryDir()` shims over `window.__TAURI__` |
| `artwork-manager.js` | Resolve artwork: IDB cache → embedded (jsmediatags) → iTunes Search API fallback |
| `metronome.js` | Lookahead scheduler using `AudioContext.currentTime` |
| `waveform.js` | Canvas renderer using cached peaks array |
| `icons.js` | Exported `ICONS` object with inline SVG strings |

### Virtual Scroll
- `ROW_H = 50` px fixed row height.
- Spacer divs (top + bottom) size the scroll container; only visible rows are in the DOM.
- `renamingActive` flag prevents re-render while an inline rename input is focused.
- `renderVirtualList()` and `buildTrackRow()` are shared between Songs tab and Artist drill-down.

### Library Tabs State Machine
- **Songs tab**: `renderVirtualList()` on all tracks sorted per current sort column.
- **Artists tab**: `currentArtistView` — `null` = artist list, `string` = drill-down for that artist name. `renderArtistList()` / `renderArtistDrillDown()`.
- **Playlists tab**: `renderPlaylistsTab()` — stub that renders empty state ("No playlists yet").

### Keyboard Shortcuts
- 15 defaults defined in `SHORTCUT_DEFAULTS` (groups: Playback, Loop, Metronome, Library).
- Persisted as overrides-only in `localStorage` key `stagehand_shortcuts`.
- `matchShortcut(event, id)` — checks key + modifiers.
- Editable in Settings → General → Keyboard Shortcuts via capture UI.

---

## IndexedDB Schema

**Database:** `stagehand_db` (version **6**)

| Object Store | Key | Purpose |
|---|---|---|
| `tracks` | `id` | Track metadata + audio bytes (for browser mode) |
| `playlists` | `id` | Playlist records |
| `settings` | `key` | App settings key/value |
| `helix_presets` | `id` | Reserved for future helix/VST presets |
| `artwork` | `key` | Album artwork data URLs |

### Track record schema
```js
{
  id:              String,   // "trk_<timestamp>_<random>"
  name:            String,   // display name (editable)
  format:          String,   // "WAV" | "MP3" | "FLAC" | "OGG"
  size:            Number,   // bytes
  semitones:       Number,   // −12 to +12
  cents:           Number,   // −50 to +50
  volume:          Number,   // 0.0 to 1.0
  artist:          String,   // from ID3 (may be "")
  album:           String,   // from ID3 (may be "")
  title:           String,   // from ID3 (may be "")
  duration:        Number,   // display duration (seconds, from ID3 or decode)
  nativeDuration:  Number,   // precise duration from Rust decode
  sampleRate:      Number,   // from Rust decode
  peaks:           Float32Array | null,  // 600-bin waveform peaks from Rust
  path:            String,   // native filesystem path (Tauri mode)
  arrayBuffer:     ArrayBuffer,  // raw audio bytes (browser fallback only)
  addedAt:         Number    // Date.now()
}
```

**Critical:** IndexedDB `put()` transfers ArrayBuffers (structured clone). Always `.slice(0)` before storing:
```js
const abForMemory = ab.slice(0);
await LibraryManager.save({ ...track, arrayBuffer: ab }); // ab detached
tracks.push({ ...track, arrayBuffer: abForMemory });       // keep live copy
```

**`saveMeta(meta)`** — reads existing record, merges scalar fields via `Object.assign`, puts back without touching `arrayBuffer`. Use for volume/semitones/name/peaks changes.

---

## Design System

### Fonts (Google Fonts — loaded in index.html)
- **Rajdhani** (700) — headings, panel titles, BPM display, logo
- **JetBrains Mono** (300/400/500) — labels, metadata, monospace values
- **Barlow Condensed** (300–600) — body, buttons, nav items

### Color Palette (CSS variables in style.css)
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

## Test Suite

**Runner:** Vitest (config: `vitest.config.js`)  
**Environment:** Node (with fake-indexeddb + browser API polyfills from `tests/setup.js`)

```
npm test              # run all tests once
npm run test:watch    # watch mode
npm run test:coverage # coverage report (v8)
```

Coverage includes all `renderer/js/*.js` except `rubberband-processor.js` and `soundtouch-processor.js` (large binary-embedded worklets).

Tests live in `tests/*.test.js` and import directly from `renderer/js/`.

---

## Development Workflow

### Running the app (browser dev)
```bash
npx serve renderer/    # ES modules require HTTP, not file://
# Then open http://localhost:8080/renderer/index.html in Chrome or Firefox
```

### Running the Tauri app
```bash
npm run tauri:dev      # dev server with hot reload
npm run tauri:build    # production build
```

### Setup (one-time)
```bash
npm run setup          # npm install + copies rubberband-processor.js from node_modules
```

### Browser support
**Chrome and Firefox only** — AudioWorklet + WASM requirement (metronome path). The Tauri build uses the Rust audio engine instead.

---

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

---

## Conventions

### Imports
All renderer JS uses native ES `import`/`export`. No bundler, no `require()`. Tauri API accessed through `tauri-api.js` shim (not `@tauri-apps/api` package — no bundler allowed).

### Track state mutations
Always call `LibraryManager.saveMeta()` for metadata-only changes (volume, semitones, name, peaks). Never call `save()` for scalar-only updates as it touches the stored `arrayBuffer`.

### Audio commands
All audio commands go through `invoke()` in `tauri-api.js`. Never call `window.__TAURI__.core.invoke` directly in ui-controller or track-player.

### ID generation
- Track IDs: `LibraryManager.genId()` → `"trk_<timestamp>_<random>"`
- Playlist IDs: `LibraryManager.genPlaylistId()` → `"pl_<timestamp>_<random>"`

### Artwork keys
Keyed by `"artist::album"` when both present; falls back to `"track::id"`. Use `ArtworkManager.artworkKeyFor(track)`.

---

## Roadmap

### v2.0 in progress — Library & Player Enhancement
- ✓ Miniplayer scrubbable progress bar (elapsed/total, seek on mouse-up)
- ✓ ID3 metadata (artist/album/title/duration) on import
- ✓ Library Songs/Artists tabs with virtual scrolling
- ✓ Artist drill-down with back navigation
- ✓ Chord charts per track (PDF + ChordPro editor, IDB persistence)
- ✓ Keyboard shortcuts (15 actions, configurable)
- [ ] Playlists CRUD (create, rename, delete, add tracks, reorder, play through) — Phase 5

### v3 — Electron migration (future)
- Wrap renderer in `BrowserWindow`
- Replace IndexedDB with native filesystem paths
- Add `node-addon-api` + JUCE or clap-host as VST3 bridge
- Package with `electron-builder` for `.exe` / `.dmg`

### Future panels (stubs reserved in sidebar)
- **Live Input** — `getUserMedia` → `MediaStreamSourceNode`, input monitor + gain
- **VST Plugin Panel** — Plugin chain UI; actual DSP awaits Electron bridge

---

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.

<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
