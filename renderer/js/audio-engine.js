// ─── AUDIO ENGINE ────────────────────────────────────────────
let ctx = null;
let masterGain = null;

export function getCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = ctx.createGain();
    masterGain.gain.value = 1.0;
    masterGain.connect(ctx.destination);
  }
  return ctx;
}

export function resume() {
  const c = getCtx();
  if (c.state === 'suspended') c.resume();
  return c;
}

export function getMaster() { getCtx(); return masterGain; }
export function setMasterVolume(v) { if (masterGain) masterGain.gain.value = v; }
