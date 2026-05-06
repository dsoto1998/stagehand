# Stagehand

A musician's rehearsal tool for playing along with recordings.

Import your tracks, transpose them by semitone, adjust speed without changing pitch, set the metronome, and play along. No cloud, no accounts — everything stays local.

Built with [Tauri 2](https://tauri.app/) (Rust backend, WebView frontend).

---

## Features

- **Audio library** — Import WAV, MP3, FLAC, OGG/Opus. Stays on disk in the app data folder.
- **Waveform display** — Amplitude-colored. Click anywhere to seek.
- **Playback** — Play/pause, per-track volume, miniplayer at the bottom of the sidebar.
- **Transpose** — ±12 semitones per track via [Rubber Band](https://breakfastquay.com/rubberband/) (C++, vendored). Pitch-only — no tempo change.
- **Speed** — Pitch-preserving playback speed via SoundTouch (AudioWorklet).
- **Loop regions** — Draggable loop handles on the waveform; loop range persists per track.
- **Metronome** — BPM input, tap tempo, subdivisions (1/4, 1/8, triplet, 1/16), accent pattern, custom click sound, beat flash.
- **Playlists** — Create and reorder playlists, drag tracks in from the library.
- **Song info** — Edit title, artist, album, and track number per track; bulk-edit across a selection.
- **Chord charts** — Attach a PDF or ChordPro file per track, viewed in a resizable overlay.
- **Album artwork** — Pulled from iTunes automatically; swap it out per track.
- **ASIO support** — Windows device picker with ASIO device detection and latency hints.
- **Keyboard shortcuts** — Space (play/pause), M (metronome), T (tap tempo), [ / ] (prev/next).

---

## Getting Started

**Prerequisites:** [Rust toolchain](https://rustup.rs/) + Node.js 18+

```bash
npm install
npm run tauri:dev
```

### Build for distribution

```bash
npm run tauri:build
```

Output: `src-tauri/target/release/bundle/`

---

## Project Structure

```
stagehand/
├── renderer/                    ← frontend (HTML + vanilla JS, no bundler)
│   ├── index.html
│   ├── style.css
│   └── js/
│       ├── audio-engine.js      ← AudioContext (metronome only)
│       ├── library-manager.js   ← filesystem-backed library CRUD
│       ├── track-player.js      ← Tauri IPC → Rust audio engine
│       ├── tauri-api.js         ← Tauri IPC wrappers
│       ├── metronome.js         ← lookahead scheduler + tap tempo
│       ├── waveform.js          ← canvas waveform renderer
│       ├── artwork-manager.js   ← album art (iTunes API)
│       └── ui-controller.js     ← DOM bindings, panels, miniplayer
└── src-tauri/                   ← Rust backend
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── vendor/rubberband/       ← Rubber Band C++ (vendored)
    └── src/
        ├── audio.rs             ← rodio playback engine + pitch/speed
        ├── commands.rs          ← Tauri IPC command handlers
        └── lib.rs
```

---

## Tech

- [Tauri 2](https://tauri.app/) — Rust + system WebView desktop shell
- [rodio](https://github.com/RustAudio/rodio) + [symphonia](https://github.com/pdeljanov/Symphonia) — audio decode and playback
- [cpal](https://github.com/RustAudio/cpal) with ASIO — device enumeration and output
- [Rubber Band](https://breakfastquay.com/rubberband/) (vendored C++) — pitch shifting
- SoundTouch (AudioWorklet) — pitch-preserving speed change
- Web Audio API — metronome only
- Vanilla JS, no framework, no bundler
- Google Fonts — Rajdhani, JetBrains Mono, Barlow Condensed

---

## Roadmap

- **VST panel** — plugin chain UI (load `.vst3`/`.dll`, bypass toggle, per-plugin gain); real DSP via native bridge TBD
