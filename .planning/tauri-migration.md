# Stagehand — Tauri + Rodio Executable Plan

## Context

Stagehand is currently a browser-only app requiring a local HTTP server. The goal is a standalone desktop executable for Windows + Mac with:
- Low resource footprint (Tauri, not Electron)
- ASIO support on Windows for sub-5ms audio latency
- A native Rust audio backend (rodio + rubberband-sys) replacing Web Audio API
- A clear path to VST3 plugin hosting

The existing `renderer/` HTML/CSS/JS UI is kept intact throughout. Audio processing migrates from browser APIs to Rust progressively across phases.

---

## Full Architecture (end state)

```
┌─────────────────────────────────────────────────┐
│  WebView2 (Windows) / WKWebView (Mac)            │
│  renderer/ — HTML + CSS + JS (UI only)           │
│  No Web Audio API in final state                 │
└────────────────┬────────────────────────────────┘
                 │ Tauri IPC (invoke/emit)
┌────────────────▼────────────────────────────────┐
│  Rust Backend (src-tauri/)                       │
│                                                  │
│  rodio::Sink ← output + mixing                  │
│    └── RubberbandSource (custom)                │
│         └── rodio::Decoder (symphonia)           │
│              └── file bytes                      │
│                                                  │
│  cpal (via rodio) ← WASAPI / ASIO / CoreAudio   │
│                                                  │
│  (Phase 3) JUCE FFI or sidecar ← VST3 hosting  │
└─────────────────────────────────────────────────┘
```

---

## Dependency Stack

### Rust (`src-tauri/Cargo.toml`)
```toml
[dependencies]
tauri = { version = "2", features = ["..."] }
rodio = { version = "0.19", features = ["symphonia-all"] }
cpal = { version = "0.15", features = ["asio"] }  # ASIO on Windows
rubberband = "..."    # Rust bindings to Rubber Band C++ library
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[build-dependencies]
tauri-build = { version = "2", features = [] }
```

### JavaScript (renderer/)
- Remove CDN dep: `jsmediatags` → download locally to `renderer/js/vendor/`
- Phase 1: keep all existing JS (audio-engine.js, track-player.js, etc.)
- Phase 2: replace audio-engine.js + track-player.js with Tauri IPC calls
- ui-controller.js, style.css, index.html: largely unchanged throughout

### Build tools
- Rust toolchain (stable)
- Tauri CLI (`npm install --save-dev @tauri-apps/cli`)
- C++ build tools (for rubberband-sys: MSVC on Windows, Xcode CLT on Mac)
- Steinberg ASIO SDK (Windows only, developer setup, not in repo)

---

## Phase 1 — Tauri Wrapper (ship executable, no audio changes)

**Goal:** Working installer on Windows + Mac. All existing features intact. Web Audio API still used for audio.

### Tasks
1. Install Tauri CLI + init `src-tauri/` scaffold
2. Configure `tauri.conf.json`:
   - `frontendDist` → `../renderer`
   - Window size, title, icons
   - CSP: allow `wasm-unsafe-eval` (required for rubberband-web WASM)
   - CSP: allow `asset:` scheme for local file serving
3. Write minimal `src-tauri/src/main.rs` (Tauri app entry, no audio yet)
4. Download `jsmediatags` locally → `renderer/js/vendor/jsmediatags.min.js`
   - Update `renderer/index.html` script tag to local path
5. Fix AudioWorklet module path: `addModule('./js/rubberband-processor.js')` → ensure it resolves under Tauri's `asset://` scheme
6. Fix IndexedDB storage path: verify Tauri WebView2 persists IndexedDB to AppData (it does — no code change needed)
7. Add `npm run tauri:dev` and `npm run tauri:build` scripts
8. Test all existing features work: playback, transpose, speed, loop, metronome, chord charts
9. Configure `tauri.conf.json` bundle targets: `.msi` (Windows), `.dmg` (Mac)
10. Verify installer builds and app launches on both platforms

### Critical risk in Phase 1
AudioWorklet + WASM in WebView2. Tauri serves files via `asset://` protocol. The `addModule()` call in `track-player.js` currently uses a relative path — under `asset://` this should resolve, but must be verified before assuming Phase 1 is complete. If it breaks, the fix is to use Tauri's `convertFileSrc()` helper to get the correct `asset://` URL for the worklet file.

---

## Phase 2 — Rust Audio Backend (ASIO + native playback)

**Goal:** Replace Web Audio API with rodio. Enable ASIO on Windows. Storage migrates from IndexedDB to filesystem.

### 2a — Rust audio engine core
1. Implement `AudioEngine` struct in Rust:
   - `rodio::OutputStream` + `rodio::OutputStreamHandle`
   - `rodio::Sink` for each track (pause/resume/volume/stop)
   - Device enumeration: list WASAPI + ASIO devices (Windows), CoreAudio devices (Mac)
2. Implement `RubberbandSource` — a custom `rodio::Source` impl:
   - Wraps a decoded `rodio::Decoder` source
   - Feeds PCM through `rubberband` C++ bindings for pitch + time-stretch
   - Parameters: semitones (pitch), speed ratio (time-stretch, pitch-preserved)
   - Replaces both `rubberband-processor.js` AND `soundtouch-processor.js`
3. Implement loop region logic in Rust:
   - `LoopingSource` wrapper: repeats between `loop_start` and `loop_end` sample positions
   - Sample-accurate (not timer-based)
4. Implement seek: rebuild `RubberbandSource` from new position (rodio has no native seek on arbitrary sources)

### 2b — Tauri IPC commands
Expose these as `#[tauri::command]` functions:
```
load_track(path: String) -> TrackInfo
play(track_id, pitch_semitones, speed_ratio, loop_in, loop_out)
pause()
resume()
seek(position_secs)
set_pitch(semitones)
set_speed(ratio)
set_volume(track_id, volume)
set_master_volume(volume)
get_audio_devices() -> Vec<AudioDevice>
set_audio_device(device_id)
```
Emit these as Tauri events to JS:
```
playback_progress { position_secs, duration_secs }
track_ended
error { message }
```

### 2c — Storage migration (IndexedDB → filesystem)
- Phase 2 reads audio files from the native filesystem (Rust `fs::read()`)
- Library metadata (name, semitones, volume, etc.) moves to a JSON file in AppData
- Replace `library-manager.js` with a Tauri-backed version that:
  - Stores file *paths* (not ArrayBuffers) in the JSON metadata store
  - Calls `load_track(path)` to pass the path to Rust for decoding
- Migration: on first launch after Phase 2, export existing IndexedDB tracks to disk + write metadata JSON

### 2d — JS frontend changes
- Replace `audio-engine.js`: AudioContext removed, replaced with device selection IPC
- Replace `track-player.js`: AudioWorkletNode removed, replaced with Tauri `invoke()` calls
- Waveform rendering: Rust decodes audio, sends peak array to JS via IPC for canvas render
- Metronome: **keep in Web Audio API** — it uses oscillator synthesis, doesn't need ASIO, and the Web Audio scheduler is accurate enough for a click track
- Progress bar: driven by `playback_progress` Tauri events instead of `requestAnimationFrame`

### 2e — ASIO: runtime detection, no SDK on end-user machines

**How portability works:**
The Steinberg ASIO SDK is a *build-time* dependency only. The compiled binary is fully redistributable — end users never need the SDK. ASIO drivers register themselves in the Windows registry at install time (`HKLM\SOFTWARE\ASIO`). The app reads this registry key at runtime to enumerate available drivers.

**Developer setup (one-time):**
- Download Steinberg ASIO SDK from Steinberg site (free)
- Set `CPAL_ASIO_DIR` env var pointing to SDK directory
- Build with `cpal = { features = ["asio"] }` — ASIO support baked into binary

**CI/CD:**
- CI builds without `CPAL_ASIO_DIR` → ASIO feature excluded, WASAPI exclusive used
- ASIO-enabled release binary built locally by developer, distributed separately
- Both binaries are otherwise identical

**Runtime behavior:**
1. On Windows: enumerate `HKLM\SOFTWARE\ASIO` registry keys at startup
2. If ASIO drivers found (e.g. "Focusrite USB ASIO"): offer them in Audio Device settings as first option
3. If no ASIO drivers found: show notification UI with fallback to WASAPI Exclusive
4. On Mac: CoreAudio auto-selected, no ASIO needed, no UI shown

**Notification UI (no ASIO detected):**
```
Audio Backend: WASAPI Exclusive  [~5ms latency]

⚠ No ASIO drivers detected
  For lowest latency, install your audio interface's ASIO driver,
  or install ASIO4ALL for generic ASIO support.
  [Download ASIO4ALL ↗]
```

**Device picker UI (ASIO detected — e.g. Focusrite 4i4):**
```
Audio Backend: [Focusrite USB ASIO ▾]   [~1ms latency]
Buffer size:   [128 samples ▾]
```

**WASAPI Exclusive fallback:**
CPAL supports WASAPI Exclusive Mode natively — no SDK, no special build flag. Gives ~3-10ms latency. This is the default when no ASIO driver is present and is a genuinely good latency floor for most rehearsal use.

---

## Phase 3 — VST3 Plugin Hosting (future)

**Goal:** Load and route VST3 plugins per-track. UI stub is built; DSP is wired.

### Approach options (decision deferred)
**Option A — JUCE sidecar process**
- Compile a small JUCE C++ binary (`stagehand-audio-host`) bundled alongside the Tauri app
- Communicates via WebSocket or named pipe
- JUCE handles VST3 scanning, loading, parameter control
- Tauri Rust backend manages sidecar process lifecycle

**Option B — Rust FFI to JUCE**
- Link JUCE as a C library, call from Rust via FFI
- More integrated, less IPC overhead
- More complex build setup

**Option C — vst3-sys (pure Rust)**
- Use low-level VST3 Rust bindings directly
- Most control, most work, weakest ecosystem support
- Viable if Rust VST3 situation matures

Recommendation: defer this decision until Phase 2 is shipped. Evaluate `clack-host` (CLAP) maturity at that point — CLAP may be the pragmatic choice by then.

---

## Important Implementation Details

### 1. rubberband-sys build complexity
The `rubberband` Rust crate wraps the Rubber Band C++ library. Building it requires:
- A C++ compiler (MSVC on Windows, Clang on Mac)
- The Rubber Band C++ source (fetched by the crate's build.rs, or pre-installed)
- Possibly `libsamplerate` as a dependency
This adds build complexity but is standard for audio Rust projects. Must be set up and verified early.

### 2. ASIO SDK portability — dev dep only, binary is redistributable
The Steinberg ASIO SDK is needed on the developer's machine at compile time only. The compiled binary is fully portable — end users never need the SDK. ASIO drivers installed by the user (Focusrite, UA, ASIO4ALL, etc.) are detected at runtime via Windows registry. A `SETUP.md` documents the one-time ASIO SDK setup for building locally. CI produces WASAPI-only builds; the ASIO-enabled release binary is built by the developer locally.

### 3. Seek in rodio requires source rebuild
Rodio does not support seeking arbitrary `Source` impls natively. Seeking means: stop current `Sink`, create a new `Decoder` starting at the target byte offset (symphonia supports this), wrap in a new `RubberbandSource`, append to a new `Sink`. This is the standard pattern but must be implemented carefully to avoid audio gaps.

### 4. Waveform rendering changes in Phase 2
Currently `waveform.js` calls `AudioBuffer.getChannelData()` (a browser API) for peak extraction. In Phase 2, audio is decoded in Rust. The new flow:
- Rust decodes the file, downsamples to N peaks, serializes to JSON
- Tauri command returns peaks array to JS
- `waveform.js` renders from that array instead of `AudioBuffer`
This is a targeted change to `waveform.js` only.

### 5. Metronome stays in Web Audio (intentionally)
The metronome uses `AudioContext.currentTime` for its lookahead scheduler — this is accurate to ~1ms and is exactly the right tool for soft-synth click generation. Moving it to Rust would add complexity with no user-facing benefit. Web Audio stays for the metronome permanently.

### 6. IndexedDB migration (Phase 2 transition)
Users who have audio libraries in IndexedDB (Phase 1) need a migration path. Plan:
- On first Phase 2 launch, detect existing IndexedDB data
- Prompt user to choose export location
- Write audio files to that directory, write metadata JSON
- Clear IndexedDB after migration
This must not silently lose user data.

### 7. CSP for WASM in Tauri
Tauri's default Content Security Policy blocks `wasm-unsafe-eval`. In Phase 1 (still using rubberband-web WASM), `tauri.conf.json` must explicitly allow it:
```json
"csp": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src ipc: https://ipc.localhost"
```
Phase 2 drops this requirement (WASM moves to Rust, no WASM in WebView2).

### 8. Tauri v1 vs v2
Tauri 2 is stable as of late 2024. Use Tauri 2 — it has a cleaner IPC model (`invoke`/`emit`), better mobile support (future), and active maintenance. All examples in this plan use Tauri 2 API.

---

## File Changes Summary

### New files
```
src-tauri/
  Cargo.toml
  tauri.conf.json
  build.rs
  icons/            ← app icons (png/ico/icns)
  src/
    main.rs         ← Tauri entry + command registration
    audio.rs        ← AudioEngine, RubberbandSource, LoopingSource
    library.rs      ← filesystem-based track library (Phase 2)
    commands.rs     ← #[tauri::command] functions
renderer/js/vendor/
  jsmediatags.min.js  ← bundled locally (remove CDN)
```

### Modified files (Phase 1)
- `renderer/index.html` — remove CDN script tag, add vendor path
- `package.json` — add Tauri CLI devDep, add tauri:dev / tauri:build scripts

### Modified files (Phase 2)
- `renderer/js/audio-engine.js` — gutted, replaced with device IPC
- `renderer/js/track-player.js` — gutted, replaced with Tauri invoke calls
- `renderer/js/library-manager.js` — IndexedDB → filesystem-backed
- `renderer/js/waveform.js` — peaks from Rust instead of AudioBuffer
- `renderer/js/ui-controller.js` — wire new IPC events, device picker UI

### Unchanged throughout
- `renderer/style.css`
- `renderer/js/metronome.js`
- `renderer/js/icons.js`
- Overall UI layout and visual design

---

## Verification

### Phase 1
- `npm run tauri:dev` launches app window
- Import MP3/FLAC/WAV file — appears in library
- Playback works, waveform renders
- Transpose slider works (rubberband-web WASM via AudioWorklet in WebView2)
- Speed control works (soundtouch WASM in WebView2)
- Loop regions work
- Metronome works
- Chord charts work
- Library persists across app restarts
- `npm run tauri:build` produces `.msi` (Windows) and `.dmg` (Mac)
- Installer installs and app launches without a browser or HTTP server

### Phase 2
- Audio device picker shows WASAPI devices (and ASIO devices when ASIO SDK present)
- Select ASIO device → playback routes through ASIO (verify with ASIO driver control panel showing active connection)
- Transpose: ±12 semitones, no pitch artifacts (rubberband in Rust)
- Speed: 0.5x–2.0x, pitch preserved
- Seek: click waveform → audio jumps to position cleanly, no dropout
- Loop: loops between in/out points, sample-accurate
- Waveform renders from Rust-provided peaks
- Library migration: existing tracks from Phase 1 IndexedDB migrate successfully
- Metronome still works (Web Audio, unchanged)
