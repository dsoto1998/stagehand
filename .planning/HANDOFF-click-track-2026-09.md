# Click Track / Perform Mode — Session Handoff

## TODO (open, carried from 2026-09-05)

- [ ] **Opening Settings still interrupts playback on an ASIO device.** Not a
      freeze any more (that was `audio_get_devices` enumerating ASIO on the
      async runtime thread — fixed with `spawn_blocking` in `commands.rs`), and
      not the device list going missing (fixed by caching in
      `ui-controller.js`). What remains: opening the settings panel during
      playback causes a brief audio glitch/interruption on both the Library and
      Perform tabs. Confirmed usable — stop the song, reselect the device, play
      again and it behaves normally — so this is a rough edge, not a blocker.
      Suspect the remaining ASIO driver query still touches the open device.
      Next step: instrument which invoke fires on settings open during playback
      (the cache should now skip `audio_get_devices` entirely once seeded — if
      it still runs, the cache is not being hit; if it does not, the glitch has
      another source).

- [ ] **Verify the rewind fix.** `restartClickScheduleFrom()` in `perform-panel.js`
      fixes the metronome going silent indefinitely after a backward seek during
      Perform. Implemented, passes tests, **still unconfirmed by ear across two
      sessions.** Test: start a Perform session, let it run in, drag the scrub bar
      backward during playback — the click should resume immediately at the new
      position instead of going silent. Also worth testing a forward drag, and a
      drag *before* starting (that path skips the count-off and starts at the
      dragged position). No app restart needed; the running instance has the fix.
- [ ] `tempoSegments` (new, from `detect_tempo_segments()` in `sidecar/beat_detect.py`)
      is emitted in the descriptor but nothing consumes it. Best use is a
      confidence map at generation time — see "Still not done" below.


Long session improving Stagehand's click-track generation (BeatNet sidecar) and
Perform mode. This doc is for a new agent picking up in this same worktree.
Read `CLAUDE.md` first for baseline project context — it's been updated with
the architecture notes from this session (see "Click Track + Perform mode"
bullet and the `buildClickSchedule()` doc comment in `click-utils.js`).

## Where things stand

**Nothing this session is committed.** `git status` shows: `CLAUDE.md`,
`renderer/index.html`, `renderer/js/click-utils.js`, `renderer/js/perform-panel.js`,
`renderer/style.css`, `sidecar/beat_detect.py`, `tests/click-utils.test.js` all
modified. `src-tauri/Cargo.toml` was already modified before this session
started (unrelated, don't touch without checking with David). Ask David before
committing — per his standing rule, never auto-commit.

## What got built (generalizable, in the actual codebase)

1. **`sidecar/beat_detect.py`**:
   - `find_lead_silence()` / `trim_lead_silence()` — trims leading silence/near-silence
     before analysis (BeatNet hallucinates a beat grid over dead air otherwise).
   - `refine_weak_attack_beats()` — nudges beats with weak onset energy toward an
     independent pitch-change (chroma-flux) beat track. Narrow, safe (only 2-8
     beats touched per song in testing).
   - `pick_anchor()` — energy-confidence scoring to pick which downbeat is the
     "real" song start, with a sibling-phase check (tested, found unreliable at
     scale, kept but gated conservatively — see "Dead ends" below).
   - `splice_even_beats(beats, numerator, start_t, end_t, bar_count)` — pure
     utility, replaces beats in a time range with perfectly evenly-spaced ones.
     **This is the core tool for hand-fixing any song's problem section** — not
     auto-invoked, called explicitly with verified boundaries.
   - **Two-pass tempo-range-constrained analysis** (the main generalizable win):
     pass 1 with default wide tempo range, derive a robust global tempo, pass 2
     re-runs with `min_bpm`/`max_bpm` narrowed to ±12% around it. Fixes the
     "syncopation gets mistaken for a different pulse level" failure mode.
     Validated safe across all 4 originally-tested songs (beat counts within
     <1% of baseline, no crashes). Guarded: pass 2 discarded if its beat count
     differs >20% from pass 1's (protects against pass 1 itself having locked
     onto a wrong tempo, e.g. half/double-time).
   - `--transition-lambda` flag exists but **reverted to madmom's own default
     (100)** — tested raising it, it either did nothing (150) or collapsed the
     meter to half-tempo (300) on real syncopated material. Not a useful lever,
     don't revisit without new evidence.

2. **`renderer/js/click-utils.js`** — `buildClickSchedule()` rewritten:
   - Anchor priority: manual override > `descriptor.anchorT` (sidecar's guess)
     > BeatNet's first true downbeat > first detected beat.
   - Accent is index-relative to the resolved anchor (not raw `pos` field) —
     rides along with BeatNet's per-beat tracking without drift.
   - **Count-off extends automatically** (beyond the 2-bar minimum) when the
     anchor sits further into the file than a standard count-off reaches — e.g.
     a long SFX/noise intro. Beats before the anchor are dropped from the
     schedule (extended count-off already covers that span).
   - New tests in `tests/click-utils.test.js` covering all of the above.

3. **`renderer/js/perform-panel.js` + `index.html` + `style.css`** — manual
   "Click starts at" field in the Perform transport, shows the sidecar's
   auto-detected anchor as a placeholder, persists to
   `track.clickTrack.anchorOverrideSec` on the track record.

## Environment set up this session (survives in this worktree)

- **`sidecar/.venv`** — Python 3.10 venv with the full stack installed:
  BeatNet, madmom (git main, 0.17.dev), torch CPU, librosa, **and also**
  `btrack-beat-tracker` (built from a fresh clone with 2 patched upstream bugs
  — missing `#include <algorithm>` and missing libsamplerate include path,
  patches only in `.tmp-proof/BTrack/`, not upstreamed) and `beat-this`
  (CPJKU's transformer beat tracker, `pip install beat-this`, works cleanly,
  no C++ build needed).
- Python 3.10 was installed system-wide via `winget install Python.Python.3.10`
  (needed — only 3.14 was present; madmom/BeatNet require 3.10).
- To run the app against this venv's sidecar instead of a frozen build:
  `.tmp-proof/run_tauri_dev_sidecar.bat` sets `STAGEHAND_BEAT_DETECT=python:...`
  plus the MSVC/ASIO/LLVM env vars and launches `npm run tauri:dev`. Must be
  launched from **this worktree's path**, not the main checkout.
- `tauri dev` only watches `src-tauri/` — renderer JS edits need an app
  restart (or touch a `src-tauri/src/*.rs` file) to take effect. See
  `reference_msvc_toolchain_stagehand` memory for the known-working MSVC path.
- Local file server was used earlier this session to let David test proof
  clips remotely (`python -m http.server` in `.tmp-proof/`, port 8642) — it's
  been killed, David is on the machine now.

## Key findings (read before touching beat-detection again)

- **BeatNet/madmom's DBN is architecturally frame-quantized to 20ms** (hardcoded
  `hop_length` in BeatNet's own feature extraction, tied to its trained RNN —
  NOT a tunable parameter). At ~150 BPM this means achievable tempo values are
  spaced ~4-5% apart (150.00, 142.86, 157.89, ...). A live drummer's natural
  few-percent tempo wobble is the same size as this quantization step, so the
  tracker visibly "hops" between quantized states — this reads as "rushing" or
  "ebbing and flowing" but is a hard model ceiling, not a bug you can tune away.
  **Confirmed the same artifact exists in Beat This! too** (a completely
  different, DBN-free transformer architecture) — so this isn't fixable by
  switching models either.
- **BeatNet's own long-window tempo estimate can carry a small but real
  systematic bias** (~1-2%) vs. the true tempo — confirmed on Cryogen via
  direct human tap capture (132.85 BPM real vs. 130.43 BPM algorithmic,
  agreed on by BeatNet, BTrack, *and* Beat This!). This is NOT fixable by the
  two-pass tempo-range constraint (pass 2 just narrows around pass 1's own
  number). **When accuracy matters and the algorithm's own self-consistency
  isn't enough, human tap-capture ground truth is the only reliable escape
  hatch found this session.**
- **Onset-strength phase-scanning (sweep candidate phases, score by real onset
  energy) is unreliable for picking WHICH beat is correct** — it can lock onto
  a different real rhythmic feature (hi-hat, snare ghost note) than the one a
  human calls "the beat". Twice this session it disagreed with tap-verified
  ground truth. Useful as a sanity check, not as the sole source of truth.
- **For a genuine mid-song tempo change**: check whether there's a real
  gap/quiet passage between the two tempos (RMS dip — BeatNet will happily
  hallucinate beats through actual silence/ambience, same as a lead-in). If
  there's room, insert a synthetic count-in (1-2 bars at the *new* tempo,
  landing exactly on the new section's confirmed first downbeat) and leave the
  gap itself silent (no clicks) — matches what a live band would actually do.
  If there's no room, just hard-cut grids with no count-in. This is implemented
  by hand via `splice_even_beats()` + manually zeroing out the gap; **not yet
  generalized into an automatic detector** (the "where's the real gap" question
  needs the same kind of RMS-dip check as lead-in silence detection, just
  applied mid-file — nobody's built that yet).

## Dead ends (don't retry without new evidence)

- Raising `transition_lambda` — see above.
- Automatic per-bar downbeat-phase correction via "which position has more
  energy" (tried hysteresis-based and majority-vote versions) — confirmed via
  full-song testing that ordinary musical dynamics produce comparable false
  signals to genuine phase errors; no threshold cleanly separates them. Touched
  89% of Psycho's beats in one version. **Don't rebuild this without a
  fundamentally different signal.**
- `pick_anchor`'s sibling-phase-margin check — kept in the code (low blast
  radius, gated behind a large margin) but doesn't reliably fix real cases;
  see Cryogen's phase discussion in the transcript if you need the detail.

## Per-song status

- **Cryogen** (`trk_1777003912677_uwl1u`) — fully tap-verified and patched
  directly onto `$APPDATA/com.stagehand.rehearsal/clicktracks/trk_1777003912677_uwl1u.json`.
  Anchor 6.7744s (later refined — check the file's actual `anchorT`), tempo
  132.85 BPM confirmed by tap capture, original BeatNet tracking kept from
  ~238s onward (real tempo change near the end). **Do not re-run "Create Click
  Track" on this song** — it'll overwrite the hand-verified data with the
  less-precise two-pass-automatic result.
- **Knights of Cydonia (Live)** (`trk_1776830539764_72uf1`) — patched with a
  corrected count-in landing on 120.641s (confirmed via direct tap on the
  entrance, within 21ms). **Still reported half-a-beat off right at the
  tempo change** — see "Open bug" section above for the leading hypothesis
  (accent index-parity, not raw timing) and how to check it. Structure:
  ~150 BPM intro to ~100.5s, ~16s real silence (BeatNet hallucinated through
  it, now silenced), 2-bar count-in, confirmed 137.056 BPM main section
  tap-verified to ~458s, original tracking resumes for the real outro
  acceleration (~150→158 BPM). Current file on disk is the `v3` version in
  `.tmp-proof/cydonia_corrected_v3.json` (also copied to the live clicktracks
  path).
- Uprising, Psycho, New Born — validated safe against the two-pass sidecar
  change only (beat counts within <1%), not independently tap-verified.

## Tap-capture tooling (reusable for future songs)

`.tmp-proof/tap_capture*.py` — standalone scripts (need `py -3.10`, run by
David directly in his own terminal, not through the agent's Bash tool — they
need real keyboard input via `msvcrt`). Pattern: play a window of the song via
`ffplay -ss <start> -t <duration>`, log `time.time()` on each SPACE press
relative to playback start, save to a `tap_times*.json`. Then fit
`songT = anchor + k*interval` via least-squares over the tap array to get a
robust tempo+phase estimate. Cheap to spin up a new one for a new song/section
— see any of the existing `tap_capture_*.py` files as a template.

## Progress bar — built this session

Added a scrub bar to the Perform transport (`renderer/index.html` /
`style.css` / `perform-panel.js` — `wireScrubBar`, `resetScrubBar`,
`updateScrubPosition`, `startAtSec` module state). Two behaviors:

- **Before starting**: drag it, then hit "Count in" — playback and the click
  schedule both start from that position directly, skipping the count-off
  entirely (`startPerform()`'s `startFrom` branch: filters `sched.clicks` to
  `songT >= startFrom`, anchors immediately instead of waiting out the usual
  count-off lead-in).
- **During an active session**: dragging live-seeks. This exposed a **real,
  now-fixed bug**: `Metronome`'s click-schedule cursor (`clickIdx` in
  `metronome.js`) only ever advances forward by design (a click that already
  fired must never be rescheduled, to prevent double-firing — see the comment
  above `reanchorClickSchedule`). Seeking backward left the cursor pointed at
  a far-later click than the new position, so nothing played until real time
  caught up to that click's stale projected time — sometimes minutes away,
  which read as "the metronome stopped indefinitely." Fixed by having any
  manual seek during a live session call the new `restartClickScheduleFrom(sec)`
  (in `perform-panel.js`) instead of relying on reanchor alone — it does a
  full `Metronome.stopClickSchedule()` + `startClickSchedule()` with the
  schedule refiltered from the new position, which resets the cursor cleanly.
  Requires `performClicks` (the session's full `sched.clicks`) to be kept in
  module state — stored in `startPerform()` right after the schedule is built.

**Status: implemented, not yet confirmed fixed by David** (he moved on to
report the Cydonia issue below before confirming). Verify the rewind fix
works before doing anything else.

## Open bug: Knights of Cydonia's tempo-change still half a beat off

After building the corrected count-in (landing on the tap-confirmed entrance
beat, 120.641s — see "Per-song status" below), David reports it's **still off
by about half a beat right at the tempo change**, despite:
- The entrance timestamp matching his direct tap within 21ms.
- The full corrected grid matching both tap sessions (main-section and
  entrance) within ±25-30ms when checked in isolation (raw `t` values).

**Leading hypothesis, not yet verified — check this first:** `click-utils.js`'s
`buildClickSchedule()` computes the accent (which click is the loud "beat 1")
by *index* distance from `anchorIdx`, where `anchorIdx = nearestBeatIndex(beats, descriptor.anchorT)` —
and `anchorT` in Cydonia's patched JSON is still the *original* song-start
value (`12.18`, near the very beginning), untouched by any of this session's
splicing. That means accent placement for the whole rest of the song depends
on the **index parity** (`(i - anchorIdx) % numerator`) being preserved
end-to-end from the song's start through every splice this session — the
150bpm-intro-unchanged section, the deleted hallucinated-beats gap, the
2-bar count-in, and the new 137bpm section. If any of those edits inserted or
removed a beat count that isn't a clean multiple of `numerator` (4) somewhere
before the tempo change, the *individual beat timings* would still all be
correct (confirmed against tap data) while the *accent* silently lands on the
wrong beat within the bar — which would sound exactly like "half a beat off"
even though nothing is actually mistimed.

**How to check:** load the patched
`$APPDATA/com.stagehand.rehearsal/clicktracks/trk_1776830539764_72uf1.json`,
find `anchorIdx` (nearest beat to `t=12.18`), then walk forward counting
indices to the count-in's first beat and the main section's first beat
(120.641s) — confirm `(index_of_120.641 - anchorIdx) % 4 == 0`. If it isn't,
either fix the splice's beat count so it lands on a clean multiple, or just
update `anchorT` in the descriptor to the new section's own first beat
(120.641) so accent phase resets cleanly there instead of trying to stay
consistent with the song's original start — the two sections don't need to
share one accent reference, they're different tempos already.

If that's not it, fall back to: build a proof clip (pattern used throughout
this session — see any of the `.tmp-proof/*.mp3` renders and the ffmpeg
`amix` command in the transcript) isolating just the count-in → new-section
transition, and check the *actual scheduled accent flags*, not just raw
`beats[].t`, against the tap data.

## Handoff prompt

Paste this to start the new session:

---

Read `HANDOFF.md` in this worktree root first — it's a detailed handoff from
a long prior session on Stagehand's click-track/Perform-mode work. Two things
to pick up, in order:

1. **Verify the rewind fix.** I added `restartClickScheduleFrom()` in
   `perform-panel.js` to fix the metronome hanging indefinitely after a
   backward seek during Perform. It's implemented and passes the JS test
   suite, but David hadn't confirmed it fixed the real symptom before this
   handoff. Ask him to test rewinding during an active Perform session.

2. **Knights of Cydonia (Live) is still half a beat off right at the
   137bpm tempo change**, even after landing the count-in on a tap-confirmed
   entrance beat (120.641s, matched his tap within 21ms). Every individual
   beat time checks out against two separate tap-capture sessions — so this
   smells like an *accent* (which click is loud) bug, not a timing bug. Read
   the "Open bug" section in HANDOFF.md for the specific hypothesis (index
   parity relative to `anchorT` across this session's splices) and how to
   check it before trying anything else.

The app should already be running via
`.tmp-proof/run_tauri_dev_sidecar.bat` (uses the sidecar venv at
`sidecar/.venv`, wired to `STAGEHAND_BEAT_DETECT`). If it's not, HANDOFF.md
has the launch details. Nothing this session is committed — don't commit
without asking David first.
