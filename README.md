# Stagehand

A musician's rehearsal tool for playing along with recordings.

Import your tracks, transpose them up or down by semitone, set the metronome, and play along. No cloud, no accounts — everything stays in your browser via IndexedDB.

---

## Features

- **Audio library** — Import WAV, MP3, FLAC, OGG/Opus. Tracks persist across sessions.
- **Waveform display** — Canvas-rendered with amplitude coloring. Click to seek.
- **Playback** — Play/pause, per-track volume, miniplayer at the bottom of the sidebar.
- **Transpose** — ±12 semitones per track using [Rubber Band](https://breakfastquay.com/rubberband/) WASM. Pitch-only — no tempo change.
- **Metronome** — BPM input, tap tempo, subdivisions (1/4, 1/8, triplet, 1/16), custom click sound, beat flash.
- **Playlists** — Create and reorder playlists, drag tracks in from the library.
- **Song Info** — Edit title, artist, album, and track number per song, or bulk-edit across a selection.
- **Master volume** — Single knob controls all output.

---

## Getting Started

Stagehand requires a local HTTP server (ES modules and AudioWorklet don't work over `file://`).

```bash
npx serve renderer/
```

Then open `http://localhost:3000` in **Chrome** or **Firefox**.

> Safari is not supported — AudioWorklet + WASM threading requirements aren't met.

### One-time setup (Rubber Band WASM)

The pitch shifter uses a pre-built WASM binary from `rubberband-web`. Run this once to copy it into place:

```bash
npm install
npm run setup
```

---

## Project Structure

```
stagehand/
├── renderer/
│   ├── index.html              ← entry point
│   ├── style.css
│   └── js/
│       ├── audio-engine.js     ← AudioContext, master gain, routing
│       ├── library-manager.js  ← IndexedDB CRUD
│       ├── track-player.js     ← playback + Rubber Band pitch routing
│       ├── rubberband-processor.js  ← AudioWorkletProcessor (WASM embedded)
│       ├── metronome.js        ← lookahead scheduler + tap tempo
│       ├── waveform.js         ← canvas waveform renderer
│       └── ui-controller.js    ← DOM bindings, panels, playlists, miniplayer
└── native/
    └── vst-bridge/             ← future: node-addon-api + JUCE VST host
```

---

## Roadmap

- **v2** — VST plugin chain UI (load `.vst3`/`.dll`, bypass toggle, per-plugin gain)
- **v3** — Electron wrapper (Windows + Mac), native filesystem, real VST3 DSP via JUCE

---

## Tech

- Vanilla JS (no framework, no bundler)
- Web Audio API — AudioWorklet, GainNode, AudioBufferSourceNode
- [rubberband-web](https://www.npmjs.com/package/rubberband-web) — Rubber Band Audio compiled to WASM
- IndexedDB — local persistence for the audio library and playlists
- Google Fonts — Rajdhani, JetBrains Mono, Barlow Condensed
