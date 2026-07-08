# STAGEHAND — Rehearsal Tool
## Claude Code Context File

---

## Project Overview

**Stagehand** is a musician's rehearsal tool for playing along with recordings. The app is a Tauri v2 desktop application (Windows primary target) combining a `renderer/` web frontend (HTML + CSS + ES modules) with a Rust audio backend (`src-tauri/`). The long-term target remains an Electron app with native VST3 plugin hosting.

`renderer/index.html` is the active entry point. The legacy monolith (`rehearsal-tool-v1.html`) has been deleted.

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
- **Guitar panel (Live Input)** — Live audio input via WASAPI or ASIO. Input device picker (with refresh button + 5s hot-plug poll when panel visible), input source (mono/stereo channel selection), input/output gain knobs, mic-icon mute toggle, buffer size, sample rate. Stream auto-starts on app open from saved config; debounced restart on settings change. Input level meter (5px bar, green→amber→red, 100ms poll, 0.80 decay). Signal path diagram (In → Gain → Plugin → Out) shows live state. Last plugin auto-reloads on init.
- **VST3 plugin chain** — Load multiple .vst3 plugins (flat file or bundle) through the Guitar panel, drag-to-reorder, per-plugin + global bypass, presets. Plugins process the live input signal in series in the audio output callback. Each plugin runs on its own persistent UI worker thread (load + editor on one STA thread) so native editor GUIs open without deadlock — tested with Helix Native (separate-component) and Lindell 80 Channel (Plugin Alliance, graphics-singleton). Supports open/close native plugin GUI (floating Win32 window) and latency reporting.
- **GitHub Actions release** — `.github/workflows/release.yml` builds and publishes Windows installer on `v*` tag push.
- **Test suite** — Vitest unit tests in `tests/` covering library-manager, metronome, track-player, artwork-manager, ui-utils. 192 tests total.

### Known Issues / In Progress
- Playlists tab: empty state only ("No playlists yet") — CRUD is Phase 5 scope.

---

## Architecture

### File Structure (current)
```
stagehand/
├── package.json                 ← scripts, deps (rubberband-web, vitest, tauri CLI)
├── vitest.config.js             ← test configuration (node environment, fake-indexeddb)
├── renderer/
│   ├── index.html               ← active entry point (loaded by Tauri webview)
│   ├── style.css
│   └── js/
│       ├── audio-engine.js      ← minimal: AudioContext + metronomeGain only (track audio is Rust)
│       ├── library-manager.js   ← IndexedDB CRUD for tracks, playlists, settings, artwork
│       ├── track-player.js      ← Tauri IPC proxy (invoke audio_* commands)
│       ├── ui-controller.js     ← DOM bindings, virtual scroll, tabs, miniplayer, shortcuts
│       ├── ui-utils.js          ← pure utility fns (no DOM/state): formatTime, formatSize, matchShortcut, matchesQuery, sortTracks
│       ├── guitar-panel.js      ← Guitar panel: live input device picker, gain knobs, VST plugin loader
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
│   ├── Cargo.toml               ← Rust deps: tauri 2, rodio, symphonia, cpal (ASIO), rubberband (vendored), vst3, ringbuf
│   ├── tauri.conf.json          ← window config, CSP, asset protocol scope
│   ├── build.rs                 ← compiles vendored Rubber Band C++ via `cc` crate
│   ├── capabilities/
│   │   └── default.json         ← Tauri capability grants
│   ├── src/
│   │   ├── main.rs              ← Tauri builder entry point
│   │   ├── lib.rs               ← registers all commands with tauri::Builder
│   │   ├── audio.rs             ← AudioEngine struct: rodio sink, Rubber Band, prefetch cache, vst_slot Arc
│   │   ├── commands.rs          ← all #[tauri::command] handlers
│   │   ├── live_input.rs        ← LiveInputEngine: cpal input→ring buffer→VST→output
│   │   └── vst_host.rs          ← VstHost: VST3 COM loading, processing, GUI (Windows)
│   └── vendor/
│       └── rubberband/          ← vendored Rubber Band C++ source (compiled at build time)
├── tests/
│   ├── setup.js                 ← fake-indexeddb + browser API polyfills
│   ├── ui-utils.test.js
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

### Two Independent Audio Paths

There are **two completely separate audio paths** — they do NOT share a pipeline. They mix at the OS device level.

```
PATH A — Music Playback (unchanged from v1.x)
  [Filesystem] → invoke('audio_load_file')
              → Rust AudioEngine
              → symphonia decode → f32 samples
              → Rubber Band C++ pitch/time shifting
              → rodio Sink → WASAPI or ASIO output

PATH B — Live Input (Guitar Panel)
  [Audio input device] → cpal input stream callback
                       → SPSC ring buffer (RING_FRAMES=8192 stereo)
                       → cpal output callback
                       → VST3 process_block() (if loaded)
                       → WASAPI or ASIO output
```

### Rust Audio Engine (`src-tauri/src/audio.rs`)

Key patterns:
- `AudioEngine` holds a rodio `Sink`, a `RubberBandStretcher`, a `Mutex<Option<PrefetchEntry>>` prefetch cache, and a `vst_slot: Arc<Mutex<Option<VstHost>>>` shared with `LiveInputEngine`.
- `play_with_params` / `seek` / `set_semitones` / `set_speed` restart the stretcher and re-fill the sink from the decoded sample buffer.
- `decode_to_samples()` uses symphonia to decode any supported format to `Vec<f32>` interleaved samples.
- `compute_peaks()` downsamples to 600 bins for waveform display.
- `audio_play` / `audio_seek` poll on `decode_pending` with 100ms sleep up to 8s (symphonia async decode path).

### Live Input Engine (`src-tauri/src/live_input.rs`)

Handles real-time audio passthrough from an input device through an optional VST3 plugin to an output device.

Key patterns:
- `LiveInputEngine` holds `input_stream`, `output_stream`, and atomic knobs (`input_gain`, `output_gain`, `muted`).
- `LiveInputEngine` shares `vst_slot: Arc<Mutex<Option<VstHost>>>` with `AudioEngine` — same VST instance used by both.
- cpal callbacks are zero-allocation: uses pre-allocated `Vec<f32>` scratch buffers (`in_scratch`, `pull_scratch`, `process_scratch`).
- ASIO: `BufferSize::Default` and device-reported SR must be used — ASIO drivers reject Fixed buffer size or non-native SR.
- WASAPI: `BufferSize::Fixed(cfg.buffer_size)` for output; input always uses `BufferSize::Default` and device native SR (many USB devices reject non-native SR).
- **ASIO + COM threading**: `live_input_get_input_devices`, `live_input_start`, and `live_input_stop` all use `tokio::task::spawn_blocking` because ASIO COM requires an STA thread. Tokio pool threads are MTA and return 0 ASIO devices. `LiveInputState` wraps `Arc<Mutex<LiveInputEngine>>` so the Arc can be cloned and moved into `spawn_blocking`.
- ASIO uses same `Device` for both input and output streams (single ASIO device represents both directions).
- WASAPI: separate input/output device lookup; first checks `input_devices()`, then `output_devices()`.
- Ring buffer: `HeapRb::<f32>::new(RING_FRAMES * 2)` — stereo interleaved, RING_FRAMES=8192.
- Output callback chunked in `VST_MAX_FRAMES=512` blocks to match `MAX_BLOCK_SIZE` in `vst_host.rs`.
- Underrun counter tracked atomically; zeroed on restart.

### VST3 Host (`src-tauri/src/vst_host.rs`)

All `unsafe` code in the codebase lives here. Every unsafe block carries a one-line safety comment.

Key patterns:
- **Per-plugin UI worker thread (critical)**: each `VstHost` owns a persistent STA worker thread (`vst_worker_main`) created by `VstHost::spawn_and_load()`. The worker runs `VstHost::load()` on itself, then stays alive handling editor open/close on that SAME thread with a message pump. Reason: Plugin Alliance plugins (Lindell 80 Channel) bind their process-global graphics engine to the thread that first loads them; if `load()` and `IPlugView::attached()` run on different threads, attached() deadlocks on a graphics condition variable. Proven via minidump 2026-06-04. The command layer NEVER calls bare `VstHost::load()` — always `spawn_and_load()`.
- `VstHost::load()` (runs ON the worker thread): LoadLibraryW → GetPluginFactory → find "Audio Module Class" → createInstance IComponent → queryInterface IAudioProcessor → initialize/setupProcessing/setActive/setProcessing.
- `setup_controller()`: resolves `IEditController` eagerly during `load()` — NOT lazily on GUI open. Required for Helix Native (separate-component plugin) to avoid crash on first paint.
- Two paths for controller: (A) single-component: cast `IComponent → IEditController` (same COM object — already `initialize()`'d in `load()`, must NOT call `initialize()`/`connect`/`setComponentState` again); (B) separate-component (Helix Native): `getControllerClassId` + factory `createInstance` (a distinct object — DOES need its own `initialize()`/connect/state-sync). Calling `initialize()` twice on the single-component path was a real bug: it left some plugins' GUI subsystem half-built (`getSize()` → width 0, blank window). Bug found + fix applied 2026-06-04 for bx_bluechorus2/bx_blackdist2/SPL Free Ranger/Shadow Hills Mastering Compressor (all single-component) — **not yet confirmed working**, verify before trusting.
- `IConnectionPoint` bidirectional connect between component and controller — required for separate-component plugins only (see above).
- `StagehandCompHandler` implements both `IComponentHandler` and `IComponentHandler2` (`setDirty`/`requestOpenEditor`/`startGroupEdit`/`finishGroupEdit`, all stub `kResultOk`). Some single-component plugin editors query the host for `IComponentHandler2` while building their GUI.
- `process_block()`: deinterleave stereo input → VST3 planar format → process → reinterleave → output. Passes through on bypass or error. Still called from the **audio thread** via the chain Mutex — the worker thread only touches the GUI side (controller/view/window), via clones it extracts at load time.
- GUI open/close: `request_open_gui()` / `request_close_gui()` send `VstUiCmd::{OpenGui,CloseGui}` to the worker and return a reply `Receiver`; the command layer recv()s OUTSIDE the chain lock so the audio thread is never blocked. `open_view_on_worker()` (on the worker thread) creates a floating Win32 window (`WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN | WS_CLIPSIBLINGS`, no owner), calls `IPlugViewContentScaleSupport::setContentScaleFactor` if supported, shows + drains messages, calls `IPlugView::attached()`, then re-queries `getSize()` and resizes the container to match (some plugins report a bogus size before attach). Window creation is wrapped in `SetThreadDpiAwarenessContext(PMv2)` (restored via a drop-guard) — matches what JUCE-based hosts do. Editor window has NO owner (avoids cross-thread input-queue coupling). `is_gui_open()` reads a shared `gui_open: Arc<AtomicBool>` the worker flips (incl. on user-initiated title-bar close).
- `close_view_on_worker()`: posts WM_CLOSE → `vst_wnd_proc` calls `IPlugView::removed()` before `DestroyWindow` per VST3 spec → WM_DESTROY frees the boxed view + ctx.
- `Drop`: sends `VstUiCmd::Exit` + joins the worker (closing GUI on its own thread, releasing controller/view clones) BEFORE releasing this host's COM objects + FreeLibrary.
- **Never fully unload a plugin mid-session.** `AudioEngine.vst_parked: Arc<Mutex<Vec<VstHost>>>` holds unloaded-but-alive instances (worker thread + DLL still loaded). `vst_unload`/`vst_unload_all` close the GUI and PARK the host instead of dropping it; `vst_load` checks `vst_parked` for a matching path and revives it before loading fresh. Reason: some plugins' graphics engine is a process-global singleton bound to the load thread; fully dropping (killing the worker + `FreeLibrary`) orphans that engine, and reloading on a new thread deadlocks in `attached()`. Parked hosts only drop for real on app exit.
- `StagehandHostApp` implements `IHostApplication` — required; without it Helix Native crashes on `createInstance(IMessage)`.
- `StagehandAttributeList` / `StagehandMessage` implement `IAttributeList` / `IMessage` — required for IConnectionPoint::notify.
- `MemoryStream` implements `IBStream` — used for component→controller state sync via `getState`/`setComponentState`.
- `StagehandPlugFrame` implements `IPlugFrame::resizeView` — resizes floating container window when plugin requests size change.
- Crash filter: `SetUnhandledExceptionFilter(crash_filter)` logs faulting address + module name before process dies.
- Drop order: close GUI → drop edit_controller → setProcessing(0) → setActive(0) → terminate() → ManuallyDrop processor/component/factory → FreeLibrary.

### Metronome (Web Audio only)
- `AudioContext` + `GainNode` (metronomeGain) — no track audio goes through here.
- `audio-engine.js` exports `getCtx()`, `resume()`, `getMetronomeGain()`. `setMasterVolume()` is a no-op (master volume goes via `invoke('audio_set_volume')`).

---

## Tauri Commands

All commands are in `src-tauri/src/commands.rs` and registered in `lib.rs`.

### Library / Filesystem
| Command | Purpose |
|---------|---------|
| `library_get_dir` | Return `$APPDATA/stagehand/library/` path |
| `library_scan` | Scan library dir; return `{id, name, path, ext, size}[]` |
| `library_check_paths` | Check if file paths still exist on disk |
| `open_audio_files_dialog` | Native file open dialog for audio import |
| `open_url` | Open URL in default browser |

### Music Playback (PATH A)
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

### VST3 Plugin (shared between PATH A and PATH B via vst_slot Arc)
| Command | Purpose |
|---------|---------|
| `open_vst_dialog` | Native file dialog filtered to .vst3 files |
| `vst_scan` | Scan a directory for .vst3 bundles; returns `{name, path}[]` |
| `vst_load` | Load + initialize a VST3 plugin at the given path |
| `vst_unload` | Unload the current plugin (close GUI first) |
| `vst_process_test` | Push one block of silence through plugin (Stage 1 test) |
| `vst_get_latency` | Return plugin latency in samples |
| `vst_bypass` | Toggle bypass mode on the loaded plugin |
| `vst_open_gui` | Open plugin editor (routed to the plugin's UI worker thread; recv off the chain lock) |
| `vst_close_gui` | Close plugin editor window (main thread only) |

### Live Input (PATH B)
| Command | Purpose |
|---------|---------|
| `live_input_get_input_devices` | Enumerate input devices (ASIO + WASAPI); returns `{name, is_asio, channels, default_sample_rate}[]` |
| `live_input_start` | Start live audio passthrough with `LiveInputConfig` |
| `live_input_stop` | Stop live audio passthrough |
| `live_input_set_input_gain` | Adjust input gain (0.0–8.0 linear) |
| `live_input_set_output_gain` | Adjust output gain (0.0–8.0 linear) |
| `live_input_set_mute` | Mute/unmute input signal |
| `live_input_status` | Return `LiveInputStatus` (running, device, channels, SR, underruns, peak_level) |

### Rust Events (Tauri emit → JS listen)
| Event | Payload | Purpose |
|-------|---------|---------|
| `vst_latency` | `{ latency_ms: number }` | Plugin reports latency after load; Guitar panel updates display |

---

## Frontend Architecture (`renderer/js/`)

### Module Responsibilities

| Module | Role |
|--------|------|
| `ui-controller.js` | All DOM wiring, panel routing, virtual scroll, tab state machine, miniplayer, keyboard shortcuts, settings panel |
| `ui-utils.js` | Pure utility fns (no DOM, no module state): `formatTime`, `formatSize`, `matchShortcut`, `matchesQuery`, `sortTracks`. Imported by `ui-controller.js`; fully unit-tested. |
| `library-manager.js` | IndexedDB CRUD: all object stores |
| `track-player.js` | Thin wrapper around Tauri IPC. Holds per-track state (semitones, cents, speed, volume, loopStart/End). Does NOT touch Web Audio. |
| `guitar-panel.js` | Live input device picker, gain knobs, VST plugin loader/bypass/GUI. Config persisted in `localStorage`. |
| `tauri-api.js` | `invoke()` / `listen()` / `convertFileSrc()` / `writeAudioFile()` / `scanLibraryDir()` shims over `window.__TAURI__` |
| `artwork-manager.js` | Resolve artwork: IDB cache → embedded (jsmediatags) → iTunes Search API fallback |
| `metronome.js` | Lookahead scheduler using `AudioContext.currentTime` |
| `waveform.js` | Canvas renderer using cached peaks array |
| `icons.js` | Exported `ICONS` object with inline SVG strings |

### Guitar Panel (`guitar-panel.js`)

Config structure (stored in `localStorage` key `stagehand_guitar_config`):
```js
{
  deviceName: '',        // selected input device name
  isAsio: false,         // ASIO vs WASAPI
  bufferSize: 256,       // samples (WASAPI only; ASIO ignores this)
  sampleRate: 44100,     // Hz (WASAPI only; ASIO uses driver default)
  inputSource: 'mono:0', // 'mono:<ch>' or 'stereo:<ch>,<ch>'
  outputChannels: [0,1], // output channel indices to write to
  inputGain: 1.0,
  outputGain: 1.0,
  muted: false,
  pluginPath: '',
  bypassed: false,
  advancedOpen: false,
}
```

Key behaviors:
- Stream auto-starts on app open (`refreshDevices().then(() => startInput())` if `cfg.deviceName` set).
- Stream auto-starts on device select; restarts (debounced 500ms) on any setting change while running.
- Status line removed — signal path diagram (`#gp-signal-path`) is sole connection indicator. Guitar nav badge (`#guitar-badge`) also shows running state.
- `refreshDevices()` on panel init, on Guitar nav click, and every 5s while panel is active AND stream is stopped (hot-plug detection). Polling stops when navigating away.
- Mute button: icon-only (`ICONS.mic` / `ICONS.micOff`), red `.active` state.
- Refresh button (`#gp-refresh-btn`) next to device select; spins during enumeration, restores prior selection.
- Last plugin auto-reloads on init (fire-and-forget; silent fail if path gone).
- Plugin latency: `listen('vst_latency', ...)` updates `#gp-plugin-latency` element.

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

Tests live in `tests/*.test.js` and import directly from `renderer/js/`. 192 tests across 5 files as of v1.2.0.

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
- Repo is **public** (changed from private 2026-05-20). Branch protection on `main` is formally active: PR required, force-push blocked, deletion blocked.
- Direct `git push` to `main` is blocked (HTTP 403) — branch protection enforces PRs.
- `git push` of tags via raw git is blocked, but **the GitHub REST API path works** — use `gh release create v<x.y.z> --target main --title "..." --notes "..."` to create the tag + release atomically. This fires the `push: tags` workflow trigger as expected.
- **Workaround for all pushes to main:** push to a feature branch → `gh pr create` → `gh pr merge --squash --delete-branch`.
- **Workaround for triggering a release:** use `gh release create` from the CLI (confirmed working as of v1.2.0 cut on 2026-05-20). Fallback if API path ever breaks: create release manually at github.com/{owner}/{repo}/releases/new.
- `gh release edit v<x.y.z>` can update release notes after the fact.
- The GitHub mobile app does not support deleting tags — use a browser.

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

### VST3 safety invariants
- All unsafe code lives in `vst_host.rs`. Every unsafe block has a one-line safety comment.
- `VstHost` is `Send + Sync` (wrapped in `parking_lot::Mutex`) — the audio thread only calls `process_block()` via `try_lock()`.
- Drop order matters: worker Exit+join (closes GUI on its thread) → edit_controller → setProcessing(0) → setActive(0) → terminate() → ManuallyDrop COM releases → FreeLibrary.
- All plugin GUI work (createView/attached/window/pump) happens on the plugin's own UI worker thread — NOT the Tauri main thread. The worker is the SAME thread that ran `load()` (graphics-singleton affinity). Each plugin on its own thread also isolates Helix Native's process-wide CBT hook from other plugins' window creation.
- Drop/unload a `VstHost` OUTSIDE the chain Mutex (worker join must not block the audio callback).
- Do not add `unsafe` outside `vst_host.rs` without strong justification.

### Live input constraints
- Music playback (PATH A) is never routed through the live input pipeline — the two paths mix at the OS device level.
- ASIO requires `BufferSize::Default` — never pass `BufferSize::Fixed` for ASIO devices.
- Maximum supported input channels: 2 (mono or stereo pair). Maximum output channels: exactly 2.

---

## Roadmap

### v2.0 in progress — Library & Player Enhancement
- ✓ Miniplayer scrubbable progress bar (elapsed/total, seek on mouse-up)
- ✓ ID3 metadata (artist/album/title/duration) on import
- ✓ Library Songs/Artists tabs with virtual scrolling
- ✓ Artist drill-down with back navigation
- ✓ Chord charts per track (PDF + ChordPro editor, IDB persistence)
- ✓ Keyboard shortcuts (15 actions, configurable)
- ✓ Guitar panel: live input passthrough via WASAPI/ASIO
- ✓ VST3 plugin hosting (single plugin, Helix Native tested)
- [ ] Playlists CRUD (create, rename, delete, add tracks, reorder, play through) — Phase 5

### v3 — Electron migration (future)
- Wrap renderer in `BrowserWindow`
- Replace IndexedDB with native filesystem paths
- Add `node-addon-api` + JUCE or clap-host as VST3 bridge
- Package with `electron-builder` for `.exe` / `.dmg`

### Future panels (stubs reserved in sidebar)
- **Live Input** — already partially implemented in Guitar panel
- **VST Plugin Panel** — single plugin in Guitar panel today; multi-plugin chain awaits Electron bridge

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
