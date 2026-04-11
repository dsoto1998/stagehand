// ─── TRACK PLAYER ────────────────────────────────────────────
import { getCtx, resume, getMaster } from './audio-engine.js';

let rubberbandWorkletLoaded = false;
export async function ensureRubberbandWorklet() {
  if (rubberbandWorkletLoaded) return;
  const ctx = resume();
  // Must wait for context to be running before adding worklet module
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }
  await ctx.audioWorklet.addModule('./js/rubberband-processor.js');
  rubberbandWorkletLoaded = true;
}


export class TrackPlayer {
  constructor(trackId) {
    this.trackId = trackId;
    this.buffer = null;
    this.source = null;
    this.gainNode = null;
    this.pitchNode = null;
    this.isPlaying = false;
    this.startTime = 0;
    this.pauseOffset = 0;
    this.duration = 0;
    this.semitones = 0;
    this.volume = 1.0;
    this.speed = 1.0;
    this.loopEnabled = false;
    this.loopStart = 0;
    this.loopEnd = 1;
    this._rafId = null;
    this._semitoneDebounce = null;
    this.onProgress = null;
    this.onEnd = null;
  }

  async loadBuffer(arrayBuffer) {
    const ctx = resume();
    // Always slice to avoid detached-buffer errors on repeated decode attempts
    let ab;
    try {
      ab = arrayBuffer.slice(0);
    } catch(e) {
      ab = arrayBuffer;
    }
    this.buffer = await new Promise((res, rej) => {
      ctx.decodeAudioData(ab, res, rej);
    });
    this.duration = this.buffer.duration;
  }

  async play(offset) {
    if (!this.buffer) return;
    const ctx = resume();
    await ensureRubberbandWorklet();
    this.stop(false);

    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = this.volume;
    this.gainNode.connect(getMaster());

    const factor = Math.pow(2, this.semitones / 12);
    if (this.semitones !== 0) {
      try {
        this.pitchNode = new AudioWorkletNode(ctx, 'rubberband-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [this.buffer.numberOfChannels]
        });
        this.pitchNode.port.postMessage(JSON.stringify(["pitch", factor]));
        this.pitchNode.connect(this.gainNode);
      } catch(e) {
        this.pitchNode = null;
      }
    } else {
      this.pitchNode = null;
    }

    this.source = ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.playbackRate.value = this.speed;

    if (this.loopEnabled) {
      this.source.loop = true;
      this.source.loopStart = this.loopStart * this.duration;
      this.source.loopEnd = this.loopEnd * this.duration;
    }

    if (this.pitchNode) {
      this.source.connect(this.pitchNode);
    } else {
      this.source.connect(this.gainNode);
    }

    const startOffset = (offset !== undefined) ? offset : this.pauseOffset;
    this.source.start(0, startOffset);
    this.startTime = ctx.currentTime - startOffset;
    this.isPlaying = true;

    this.source.onended = () => {
      if (this.isPlaying) {
        this.isPlaying = false;
        this.pauseOffset = 0;
        cancelAnimationFrame(this._rafId);
        if (this.onEnd) this.onEnd();
      }
    };
    this._tick();
  }

  pause() {
    if (!this.isPlaying) return;
    const ctx = getCtx();
    this.pauseOffset = ctx.currentTime - this.startTime;
    this.stop(false);
    this.isPlaying = false;
  }

  stop(resetOffset = true) {
    if (this.source) {
      try { this.source.onended = null; this.source.stop(); } catch(e){}
      this.source.disconnect();
      this.source = null;
    }
    if (this.pitchNode) { try { this.pitchNode.disconnect(); } catch(e){} this.pitchNode = null; }
    if (this.gainNode)  { try { this.gainNode.disconnect(); } catch(e){}  this.gainNode = null; }
    if (resetOffset) { this.pauseOffset = 0; }
    this.isPlaying = false;
    cancelAnimationFrame(this._rafId);
  }

  seek(fraction) {
    const wasPlaying = this.isPlaying;
    const t = fraction * this.duration;
    this.pauseOffset = t;
    this.speed = 1.0;
    if (this.onSpeedReset) this.onSpeedReset();
    if (wasPlaying) this.play(t);
    else if (this.onProgress) this.onProgress(fraction, t);
  }

  get currentTime() {
    if (this.isPlaying) {
      const ctx = getCtx();
      return Math.min(ctx.currentTime - this.startTime, this.duration);
    }
    return this.pauseOffset;
  }

  setVolume(v) {
    this.volume = v;
    if (this.gainNode) this.gainNode.gain.value = v;
  }

  setSpeed(s) {
    this.speed = s;
    if (this.source) this.source.playbackRate.value = s;
  }

  setSemitones(s) {
    this.semitones = s;
    if (this.isPlaying) {
      clearTimeout(this._semitoneDebounce);
      this._semitoneDebounce = setTimeout(() => {
        if (this.isPlaying) this.play(this.currentTime);
      }, 150);
    }
  }

  _tick() {
    if (!this.isPlaying) return;
    if (this.onProgress) {
      const t = this.currentTime;
      this.onProgress(t / this.duration, t);
    }
    this._rafId = requestAnimationFrame(() => this._tick());
  }
}

// Players map: trackId -> TrackPlayer
export const players = {};
