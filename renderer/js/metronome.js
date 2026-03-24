// ─── METRONOME ────────────────────────────────────────────────
import { resume, getCtx, getMaster } from './audio-engine.js';

let bpm = 120;
let subdivision = 1;
let isRunning = false;
let nextNoteTime = 0;
let currentBeat = 0;
let totalBeats = 0;
let schedulerTimer = null;
let volume = 0.8;
let customBuffer = null;
const LOOKAHEAD = 0.1;
const SCHEDULE_INTERVAL = 25;

// Beat flash callbacks: [{time, beat, totalBeats}]
let flashQueue = [];
let flashRaf = null;

function scheduleNote(time, isAccent) {
  const c = resume();
  let source;

  if (customBuffer) {
    source = c.createBufferSource();
    source.buffer = customBuffer;
  } else {
    // Synthesize click
    const oscillator = c.createOscillator();
    const env = c.createGain();
    oscillator.connect(env);
    const gainNode = c.createGain();
    gainNode.gain.value = volume;
    env.connect(gainNode);
    gainNode.connect(getMaster());
    oscillator.frequency.value = isAccent ? 1800 : 1200;
    oscillator.type = 'sine';
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(volume * 0.9, time + 0.002);
    env.gain.exponentialRampToValueAtTime(0.001, time + (isAccent ? 0.06 : 0.04));
    oscillator.start(time);
    oscillator.stop(time + 0.08);
    return;
  }

  if (source) {
    const gainNode = c.createGain();
    gainNode.gain.value = volume * (isAccent ? 1.0 : 0.7);
    source.connect(gainNode);
    gainNode.connect(getMaster());
    source.start(time);
  }
}

function scheduler() {
  const c = getCtx();
  const beatsPerBar = 4;
  const subdivSteps = subdivision;
  const secPerBeat = 60 / bpm;
  const secPerSubdiv = secPerBeat / subdivSteps;

  while (nextNoteTime < c.currentTime + LOOKAHEAD) {
    const isAccent = (totalBeats % (beatsPerBar * subdivSteps) === 0);
    scheduleNote(nextNoteTime, isAccent);

    const beatIndex = Math.floor(totalBeats % (beatsPerBar * subdivSteps));
    flashQueue.push({ time: nextNoteTime, beat: beatIndex, subdivSteps });

    nextNoteTime += secPerSubdiv;
    totalBeats++;
  }
}

function updateBeatDots(subdivSteps) {
  const grid = document.getElementById('beat-grid');
  grid.innerHTML = '';
  const count = 4 * subdivSteps;
  for (let i = 0; i < count; i++) {
    const d = document.createElement('div');
    d.className = 'beat-dot' + (i % subdivSteps === 0 ? ' accent' : '');
    d.id = 'dot-' + i;
    grid.appendChild(d);
  }
}

function flashLoop() {
  if (!isRunning) { flashRaf = null; return; }
  const c = getCtx();
  const now = c.currentTime;
  while (flashQueue.length && flashQueue[0].time <= now + 0.02) {
    const item = flashQueue.shift();
    const dot = document.getElementById('dot-' + item.beat);
    if (dot) {
      dot.classList.add('flash');
      setTimeout(() => dot.classList.remove('flash'), 80);
    }
  }
  flashRaf = requestAnimationFrame(flashLoop);
}

function start() {
  const c = resume();
  isRunning = true;
  totalBeats = 0;
  nextNoteTime = c.currentTime + 0.1;
  flashQueue = [];
  scheduler();
  schedulerTimer = setInterval(scheduler, SCHEDULE_INTERVAL);
  if (!flashRaf) flashLoop();
}

function stop() {
  isRunning = false;
  clearInterval(schedulerTimer);
  flashQueue = [];
  cancelAnimationFrame(flashRaf);
  flashRaf = null;
  // Clear all dots
  document.querySelectorAll('.beat-dot').forEach(d => d.classList.remove('flash'));
}

function setBpm(v) {
  bpm = Math.max(20, Math.min(300, v));
  document.getElementById('bpm-input').value = bpm;
}

function getBpm() { return bpm; }
function setVolume(v) { volume = v; }
function setSubdivision(s) {
  subdivision = s;
  updateBeatDots(s);
  if (isRunning) { stop(); start(); }
}
function setCustomBuffer(buf) { customBuffer = buf; }
function isActive() { return isRunning; }

export const Metronome = { start, stop, setBpm, getBpm, setVolume, setSubdivision, setCustomBuffer, isActive, updateBeatDots };


// ─── TAP TEMPO ───────────────────────────────────────────────
let taps = [];
const MAX_GAP = 3000;

function tap() {
  const now = Date.now();
  if (taps.length > 0 && now - taps[taps.length-1] > MAX_GAP) taps = [];
  taps.push(now);
  if (taps.length < 2) return null;
  if (taps.length > 8) taps = taps.slice(-8);
  const intervals = [];
  for (let i = 1; i < taps.length; i++) intervals.push(taps[i] - taps[i-1]);
  const avg = intervals.reduce((a,b) => a+b, 0) / intervals.length;
  return Math.round(60000 / avg);
}

function count() { return taps.length; }
function reset() { taps = []; }

export const TapTempo = { tap, count, reset };
