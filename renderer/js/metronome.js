// ─── METRONOME ────────────────────────────────────────────────
import { resume, getCtx, getMaster, getMetronomeGain } from './audio-engine.js';

let bpm = 120;
let subdivision = 1;
let beatsPerBar = 4;
let beatUnit = 4;                              // denominator: 4 or 8
let beatAccents = [true, false, false, false]; // per-beat accent; length = beatsPerBar
let isRunning = false;
let nextNoteTime = 0;
let currentBeat = 0;
let totalBeats = 0;
let startTime = 0;
let schedulerTimer = null;
let volume = 0.8;
let accentEnabled = true;
const customBuffers = { accent: null, quarter: null, eighth: null, subdivision: null };
const LOOKAHEAD = 0.1;
const SCHEDULE_INTERVAL = 25;

// Beat flash callbacks: [{time, beat, totalBeats}]
let flashQueue = [];
let flashRaf = null;

// External beat callback (fires on every main beat / quarter-note position)
let beatCallback = null;
function onBeat(fn) { beatCallback = fn; }

const SYNTH_PARAMS = {
  accent:      { freq: 1800, decay: 0.06, stop: 0.08, vol: 1.0 },
  quarter:     { freq: 1200, decay: 0.04, stop: 0.06, vol: 0.85 },
  eighth:      { freq: 900,  decay: 0.025, stop: 0.04, vol: 0.7 },
  subdivision: { freq: 700,  decay: 0.025, stop: 0.04, vol: 0.6 },
};

function scheduleNote(time, beatType) {
  const c = resume();
  const buf = customBuffers[beatType];
  const p = SYNTH_PARAMS[beatType];

  if (buf) {
    const source = c.createBufferSource();
    source.buffer = buf;
    const gainNode = c.createGain();
    gainNode.gain.value = volume * p.vol;
    source.connect(gainNode);
    gainNode.connect(getMetronomeGain());
    source.start(time);
  } else {
    // Synthesize click
    const oscillator = c.createOscillator();
    const env = c.createGain();
    oscillator.connect(env);
    const gainNode = c.createGain();
    gainNode.gain.value = volume;
    env.connect(gainNode);
    gainNode.connect(getMetronomeGain());
    oscillator.frequency.value = p.freq;
    oscillator.type = 'sine';
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(p.vol * 0.9, time + 0.002);
    env.gain.exponentialRampToValueAtTime(0.001, time + p.decay);
    oscillator.start(time);
    oscillator.stop(time + p.stop);
  }
}

function scheduler() {
  const c = getCtx();
  const subdivSteps = subdivision;
  const secPerBeat = (beatUnit === 8) ? 30 / bpm : 60 / bpm;
  const secPerSubdiv = secPerBeat / subdivSteps;
  const barLength = beatsPerBar * subdivSteps;

  while (nextNoteTime < c.currentTime + LOOKAHEAD) {
    const pos = totalBeats % barLength;
    const beatIdx = Math.floor(pos / subdivSteps);
    const isBeatBoundary = pos % subdivSteps === 0;
    let beatType;
    if (isBeatBoundary && accentEnabled && beatAccents[beatIdx]) beatType = 'accent';
    else if (isBeatBoundary)                                     beatType = 'quarter';
    else if (subdivSteps === 4 && pos % 2 === 0)                 beatType = 'eighth';
    else                                                         beatType = 'subdivision';
    scheduleNote(nextNoteTime, beatType);

    flashQueue.push({ time: nextNoteTime, beat: pos, subdivSteps });

    nextNoteTime += secPerSubdiv;
    totalBeats++;
  }
}

function flashLoop() {
  if (!isRunning) { flashRaf = null; return; }
  const c = getCtx();
  const now = c.currentTime;
  while (flashQueue.length && flashQueue[0].time <= now + 0.02) {
    const item = flashQueue.shift();
    if (item.beat % item.subdivSteps === 0 && beatCallback) {
      const beatIdx = Math.floor(item.beat / item.subdivSteps);
      beatCallback(beatIdx);
    }
  }
  flashRaf = requestAnimationFrame(flashLoop);
}

function start() {
  const c = resume();
  isRunning = true;
  totalBeats = 0;
  startTime = c.currentTime;
  nextNoteTime = c.currentTime;
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
}

function setBpm(v) {
  bpm = Math.max(20, Math.min(300, v));
}

function getBpm() { return bpm; }
function setVolume(v) { volume = v; }
function setSubdivision(s) {
  subdivision = s;
  if (isRunning) {
    const c = getCtx();
    const secPerBeat = (beatUnit === 8) ? 30 / bpm : 60 / bpm;
    const elapsed = c.currentTime - startTime;
    const nextBeatIndex = Math.ceil(elapsed / secPerBeat);
    nextNoteTime = startTime + nextBeatIndex * secPerBeat;
    totalBeats = (nextBeatIndex % beatsPerBar) * s;
    flashQueue = [];
  }
}
function setTimeSignature(numerator, denominator) {
  beatsPerBar = numerator;
  beatUnit = denominator;
  beatAccents = Array.from({ length: numerator }, (_, i) => i === 0);
}
function setBeatAccent(beatIdx, v) { beatAccents[beatIdx] = v; }
function getTimeSignature() { return { numerator: beatsPerBar, denominator: beatUnit }; }
function getBeatAccents() { return [...beatAccents]; }
function setCustomBuffer(type, buf) { customBuffers[type] = buf; }
function getCustomBuffer(type) { return customBuffers[type]; }
function setAccent(enabled) { accentEnabled = enabled; }
function getAccent() { return accentEnabled; }
function isActive() { return isRunning; }

export const Metronome = { start, stop, setBpm, getBpm, setVolume, setSubdivision, setTimeSignature, setBeatAccent, getTimeSignature, getBeatAccents, setCustomBuffer, getCustomBuffer, setAccent, getAccent, isActive, onBeat };


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
