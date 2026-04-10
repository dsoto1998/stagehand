// ─── TRACK PLAYER ────────────────────────────────────────────
import { getCtx, resume, getMaster } from './audio-engine.js';

let rubberbandWorkletLoaded = false;
export async function ensureRubberbandWorklet() {
  if (rubberbandWorkletLoaded) return;
  const ctx = resume();
  if (ctx.state === 'suspended') await ctx.resume();
  await ctx.audioWorklet.addModule('./js/rubberband-processor.js');
  rubberbandWorkletLoaded = true;
}

let soundtouchWorkletLoaded = false;
async function ensureSoundtouchWorklet() {
  if (soundtouchWorkletLoaded) return;
  const ctx = resume();
  if (ctx.state === 'suspended') await ctx.resume();
  await ctx.audioWorklet.addModule('./js/soundtouch-processor.js');
  soundtouchWorkletLoaded = true;
}


export class TrackPlayer {
  constructor(trackId) {
    this.trackId = trackId;
    this.buffer = null;
    this.source = null;
    this.gainNode = null;
    this.pitchNode = null;
    this.speedNode = null;
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

    // Build audio graph: source → [pitchNode] → [speedNode] → gainNode
    const factor = Math.pow(2, this.semitones / 12);
    if (this.semitones !== 0) {
      try {
        this.pitchNode = new AudioWorkletNode(ctx, 'rubberband-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [this.buffer.numberOfChannels]
        });
        this.pitchNode.port.postMessage(JSON.stringify(["pitch", factor]));
      } catch(e) {
        this.pitchNode = null;
      }
    } else {
      this.pitchNode = null;
    }

    if (Math.abs(this.speed - 1.0) > 0.001) {
      try {
        await ensureSoundtouchWorklet();
        this.speedNode = new AudioWorkletNode(ctx, 'soundtouch-processor', {
          numberOfInputs: 1, numberOfOutputs: 1,
          outputChannelCount: [this.buffer.numberOfChannels]
        });
        this.speedNode.parameters.get('playbackRate').setValueAtTime(this.speed, ctx.currentTime);
        this.speedNode.connect(this.gainNode);
      } catch(e) {
        this.speedNode = null;
      }
    } else {
      this.speedNode = null;
    }

    // Wire: pitchNode → speedNode → gainNode (whichever nodes are active)
    const lastNode = this.speedNode || this.pitchNode || null;
    if (this.pitchNode) {
      this.pitchNode.connect(this.speedNode || this.gainNode);
    }

    this.source = ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.playbackRate.value = 1.0; // speed handled by speedNode

    this.syncLoop();

    const startOffset = (offset !== undefined) ? offset : this.pauseOffset;
    if (this.loopEnabled && this.source) {
      const ls = this.loopStart * this.duration;
      const le = this.loopEnd * this.duration;
      if (startOffset >= le || startOffset < ls) {
        this.source.loop = false;
      }
    }

    if (this.pitchNode) {
      this.source.connect(this.pitchNode);
    } else if (this.speedNode) {
      this.source.connect(this.speedNode);
    } else {
      this.source.connect(this.gainNode);
    }

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
    if (this.speedNode) { try { this.speedNode.disconnect(); } catch(e){} this.speedNode = null; }
    if (this.gainNode)  { try { this.gainNode.disconnect(); } catch(e){}  this.gainNode = null; }
    if (resetOffset) { this.pauseOffset = 0; }
    this.isPlaying = false;
    cancelAnimationFrame(this._rafId);
  }

  syncLoop() {
    if (!this.source) return;
    this.source.loop = this.loopEnabled;
    this.source.loopStart = this.loopStart * this.duration;
    this.source.loopEnd = this.loopEnd * this.duration;
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
      let t = Math.min(ctx.currentTime - this.startTime, this.duration);
      if (this.loopEnabled && this.source && this.source.loop) {
        const ls = this.loopStart * this.duration;
        const le = this.loopEnd * this.duration;
        if (le > ls && t >= le) {
          t = ls + ((t - ls) % (le - ls));
        }
      }
      return t;
    }
    return this.pauseOffset;
  }

  setVolume(v) {
    this.volume = v;
    if (this.gainNode) this.gainNode.gain.value = v;
  }

  setSpeed(s) {
    this.speed = s;
    if (this.speedNode) {
      try {
        this.speedNode.parameters.get('playbackRate').setValueAtTime(s, getCtx().currentTime);
      } catch(e) {}
    }
    // If speed changed between 1× and non-1× (graph topology changes), restart
    const needsNode = Math.abs(s - 1.0) > 0.001;
    const hasNode   = !!this.speedNode;
    if (this.isPlaying && needsNode !== hasNode) {
      if (this._speedDebounce) clearTimeout(this._speedDebounce);
      this._speedDebounce = setTimeout(() => {
        if (this.isPlaying) this.play(this.currentTime);
      }, 150);
    }
  }

  setLoopEnabled(enabled) {
    this.loopEnabled = enabled;
    this.syncLoop();
  }

  setLoopPoints(start, end) {
    this.loopStart = start;
    this.loopEnd   = end;
    this.syncLoop();
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

    // Re-enable loop once playhead enters the loop region (deferred from seek)
    if (this.loopEnabled && this.source && !this.source.loop) {
      const ls = this.loopStart * this.duration;
      const le = this.loopEnd * this.duration;
      const t = this.currentTime;
      if (t >= ls && t < le) {
        this.source.loop = true;
      }
    }

    if (this.onProgress) {
      const t = this.currentTime;
      this.onProgress(t / this.duration, t);
    }
    this._rafId = requestAnimationFrame(() => this._tick());
  }
}

// Players map: trackId -> TrackPlayer
export const players = {};
