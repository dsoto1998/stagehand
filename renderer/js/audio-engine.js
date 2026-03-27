// ─── AUDIO ENGINE ────────────────────────────────────────────
let ctx = null;
let masterGain = null;
let metronomeGain = null;

export function getCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = ctx.createGain();
    masterGain.gain.value = parseFloat(localStorage.getItem('masterVolume') || '100') / 100;
    masterGain.connect(ctx.destination);
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

export function getMaster() { getCtx(); return masterGain; }
export function getMetronomeGain() { getCtx(); return metronomeGain; }
export function setMasterVolume(v) { if (masterGain) masterGain.gain.value = v; }
