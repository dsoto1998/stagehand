// ─── AUDIO ENGINE ────────────────────────────────────────────
// AudioContext used only for metronome. Track audio routes through Rust/rodio.
let ctx = null;
let metronomeGain = null;

export function getCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    metronomeGain = ctx.createGain();
    metronomeGain.gain.value = 1.0;
    metronomeGain.connect(ctx.destination);
  }
  return ctx;
}

export function resume() {
  const c = getCtx();
  if (c.state === 'suspended') c.resume();
  return c;
}

export function getMaster()         { return null; }
export function getMetronomeGain()  { getCtx(); return metronomeGain; }
export function setMasterVolume(_v) { /* no-op: master volume sent to Rust via audio_set_volume */ }
