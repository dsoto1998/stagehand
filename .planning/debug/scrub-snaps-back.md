---
status: awaiting_human_verify
trigger: "scrub-snaps-back — clicking/dragging scrub bar snaps back to previous position"
created: 2026-04-03T00:00:00Z
updated: 2026-04-03T01:00:00Z
---

## Current Focus

hypothesis: Web Audio API clamps source.start(0, offset) to within [loopStart, loopEnd] when source.loop=true and offset > loopEnd. So even though seek() passes the correct t to play(t), the browser ignores it and starts playback from within the loop.
test: Read play() lines 108-118 — confirmed: when loopEnabled=true, source.loop=true is always set unconditionally before source.start(0, startOffset). If startOffset > loopEndSec, the W3C spec says the source "seeks to loopStart" instead.
expecting: Guard the loop wiring in play() so source.loop is only set to true when startOffset < loopEndSec. When startOffset >= loopEndSec, start the source unlooped (loop=false) so the browser honors the offset. loopEnabled/loopStart/loopEnd properties remain unchanged on the player.
next_action: Apply fix to play() in track-player.js lines 108-112.

## Symptoms

expected: Clicking/dragging on the waveform or miniplayer scrub bar should move playback to that position
actual: The scrub bar/playhead snaps back to where it was before the scrub attempt — the seek doesn't stick
errors: None reported
reproduction: Try to click/drag to seek in the waveform or miniplayer scrub bar while a track is playing (or paused)
started: Unknown — user just reported it

## Eliminated

- hypothesis: currentTime getter math is wrong (original)
  evidence: math traces correctly — startOffset + wallDelta * speed gives correct position
  timestamp: 2026-04-03

- hypothesis: seeking flag race (progress update overwrites scrub bar visually)
  evidence: updateMiniplayerProgress guards with if (!seeking), and seeking=false is set before seek() is called. Visual snap-back implies actual playback position is wrong, not just visual.
  timestamp: 2026-04-03

- hypothesis: setLoopEnabled() race was the only bug
  evidence: User confirmed snap-back fixed and loop handles preserved after removing setLoopEnabled() from onScrubUp. But new symptom: seeking past loopEnd still snaps playhead to inside loop. Root cause is the currentTime getter, not onScrubUp.
  timestamp: 2026-04-03

## Evidence

- timestamp: 2026-04-03
  checked: onScrubUp in ui-controller.js (lines 805–818)
  found: After player.seek(seekFrac), onScrubUp immediately calls player.setLoopEnabled(false) and player.setLoopPoints(0, 1)
  implication: setLoopEnabled checks if (this.isPlaying) and calls this.play(this.currentTime) — a second async play() is spawned

- timestamp: 2026-04-03
  checked: play() in track-player.js (lines 67–131)
  found: play() is async and its first await is ensureWorklets() before stop() is called. So isPlaying remains true when setLoopEnabled runs.
  implication: setLoopEnabled's play(currentTime) captures currentTime from the OLD position (still playing), then both play() calls race. The setLoopEnabled-triggered play() resolves second and overwrites the seek position.

- timestamp: 2026-04-03
  checked: seek() in track-player.js (lines 154–162)
  found: seek() is synchronous but calls this.play(t) without await. speed is reset to 1.0 inside seek.
  implication: The seek's play(t) and setLoopEnabled's play(oldTime) are two concurrent async play() calls — second one wins, restoring old position.

- timestamp: 2026-04-03
  checked: play() in track-player.js (lines 108-112)
  found: play() reads this.loopEnabled/loopStart/loopEnd to wire the new AudioBufferSourceNode. seek() calls play(t), so seek already preserves loop state as long as we don't mutate those properties before calling seek().
  implication: The prior fix's loop-property mutation (loopEnabled=false, loopStart=0, loopEnd=1) was unnecessary to prevent the race — it only needed to avoid calling setLoopEnabled(). Mutating directly destroyed the loop region. Fix: remove all loop mutation from onScrubUp and call seek() alone.

- timestamp: 2026-04-03
  checked: currentTime getter (track-player.js lines 164-182) — new investigation after checkpoint
  found: When loop is enabled and play(t) is called with t > loopEnd * duration, _playStartOffset = t. On the very first _tick(), trackPos = _playStartOffset + ~0 = t > loopEndSec, so the getter immediately applies the modulo wrap and reports a position inside the loop region, not at t.
  implication: Visually the scrub fill snaps back to inside the loop region instantly. Fix: only apply the loop-wrap when _playStartOffset is within (or before) the loop region — i.e., guard with _playStartOffset < loopEndSec.

- timestamp: 2026-04-03
  checked: play() lines 105-130, specifically how source.loop and source.start(0, startOffset) interact when loopEnabled=true and startOffset > loopEndSec
  found: Web Audio spec (https://webaudio.github.io/web-audio-api/#playback-of-buffer) says: when source.loop=true and offset > loopEnd, the source IMMEDIATELY seeks to loopStart before playing. So source.start(0, t) with t past loopEnd is silently overridden by the browser — audio starts from inside the loop, not from t.
  implication: This is the audio bug: visual is now correct (currentTime getter fix) but audio plays from the wrong position because source.loop=true causes the browser to ignore the out-of-range offset. Fix: only set source.loop=true when startOffset < loopEndSec. When seeked past loopEnd, leave source.loop=false so the browser honors the offset. loopEnabled/loopStart/loopEnd player properties are unchanged.

## Resolution

root_cause: Four-phase bug. Phase 1 (snap-back): onScrubUp called setLoopEnabled(false) which fired a second async play(oldTime) that raced seek's play(t) and won. Phase 2 (loop destroyed): the phase-1 fix replaced setLoopEnabled() with direct property mutation that wiped the loop region on every scrub. Phase 3 (visual snaps back on seek past loopEnd): currentTime getter applied loop modulo-wrap unconditionally — if _playStartOffset > loopEndSec, trackPos was immediately > loopEndSec, and the getter wrapped it back into the loop on the first tick. Phase 4 (audio plays from wrong position on seek past loopEnd): play() set source.loop=true unconditionally when loopEnabled, but the Web Audio spec silently seeks source.start() offset to loopStart when offset > loopEnd — audio started from inside the loop, not from the seeked position.

fix: (1) Removed setLoopEnabled()/loop-property mutation from onScrubUp in ui-controller.js. (2) Added guard to currentTime getter: only apply loop-wrap if _playStartOffset < loopEndSec. (3) Added guard in play() before source.loop=true: only wire source.loop when startOffset < loopEndSec. Hoisted startOffset computation above the loopEnabled block to avoid duplication.

verification: Code review: (1) seek within loop — startOffset < loopEndSec, source.loop=true, loops correctly; (2) seek past loopEnd — startOffset >= loopEndSec, source.loop stays false, browser honors offset, audio starts at t; (3) currentTime getter: _playStartOffset < loopEndSec guard ensures wrap only fires for normal forward playback; (4) pauseOffset, loopEnabled, loopStart, loopEnd player properties all preserved correctly across seek paths.

files_changed: [renderer/js/ui-controller.js, renderer/js/track-player.js]
