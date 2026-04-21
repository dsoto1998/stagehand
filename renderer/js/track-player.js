// ─── TRACK PLAYER (Tauri IPC proxy) ──────────────────────────
import { writeAudioTemp, invoke } from './tauri-api.js';
import * as LibraryManager from './library-manager.js';

export class TrackPlayer {
  constructor(trackId) {
    this.trackId  = trackId;
    this._loaded  = false;
    this.peaks    = null;
    this.isPlaying = false;
    this.pauseOffset = 0;
    this.duration = 0;
    this.semitones = 0;
    this.volume   = 1.0;
    this.speed    = 1.0;
    this.loopEnabled = false;
    this.loopStart = 0;
    this.loopEnd   = 1;
    this._semitoneDebounce = null;
    this._speedDebounce    = null;
    // Kept for compatibility — driven by ui-controller event listeners, not set internally
    this.onProgress = null;
    this.onEnd      = null;
  }

  async loadFile(filePath, cachedMeta = null) {
    const invokeArgs = {
      trackId:          this.trackId,
      cachedPeaks:      cachedMeta?.peaks         ?? null,
      cachedDuration:   cachedMeta?.nativeDuration ?? null,
      cachedSampleRate: cachedMeta?.sampleRate     ?? null,
      keepFile:         true,
    };

    // Fast path: prefetch hit — no file read needed
    const isPrefetched = await invoke('audio_check_prefetch', { trackId: this.trackId });
    let result = null;
    if (isPrefetched) {
      result = await invoke('audio_load_file', { path: '', ...invokeArgs });
    }
    if (!result) {
      result = await invoke('audio_load_file', { path: filePath, ...invokeArgs });
    }

    this.duration = result.duration;
    this.peaks    = result.peaks?.length ? result.peaks : null;
    this._loaded  = true;

    if (!cachedMeta && result.peaks?.length) {
      LibraryManager.saveMeta({
        id: this.trackId,
        peaks: result.peaks,
        nativeDuration: result.duration,
        sampleRate: result.sample_rate,
      }).catch(() => {});
    }
    return result;
  }

  async loadBuffer(arrayBuffer, cachedMeta = null) {
    const invokeArgs = {
      trackId:          this.trackId,
      cachedPeaks:      cachedMeta?.peaks         ?? null,
      cachedDuration:   cachedMeta?.nativeDuration ?? null,
      cachedSampleRate: cachedMeta?.sampleRate     ?? null,
    };

    // Fast path: prefetch hit
    let result = null;
    const isPrefetched = await invoke('audio_check_prefetch', { trackId: this.trackId });
    if (isPrefetched) {
      result = await invoke('audio_load_file', { path: '', ...invokeArgs });
    }
    if (!result) {
      const path = await writeAudioTemp(arrayBuffer);
      result = await invoke('audio_load_file', { path, ...invokeArgs });
    }
    this.duration = result.duration;
    this.peaks    = result.peaks?.length ? result.peaks : null;
    this._loaded  = true;

    if (!cachedMeta && result.peaks?.length) {
      LibraryManager.saveMeta({
        id: this.trackId,
        peaks: result.peaks,
        nativeDuration: result.duration,
        sampleRate: result.sample_rate,
      }).catch(() => {});
    }
    return result;
  }

  async play(offset, effectiveVolume) {
    if (!this._loaded) return;
    const offsetSecs = offset !== undefined ? offset : this.pauseOffset;
    await invoke('audio_play', {
      offsetSecs,
      semitones:   this.semitones,
      speed:       this.speed,
      volume:      effectiveVolume !== undefined ? effectiveVolume : this.volume,
      loopEnabled: this.loopEnabled,
      loopStart:   this.loopStart * this.duration,
      loopEnd:     this.loopEnd   * this.duration,
    });
    this.isPlaying = true;
  }

  async pause() {
    if (!this.isPlaying) return;
    this.isPlaying = false; // synchronous — prevents double-pause from rapid clicks
    const pos = await invoke('audio_pause');
    this.pauseOffset = pos;
    this._paused = true;
  }

  async resume() {
    if (this.isPlaying || !this._loaded) return;
    await invoke('audio_resume');
    this.isPlaying = true;
    this._paused = false;
  }

  async stop(resetOffset = true) {
    this._paused = false;
    await invoke('audio_stop');
    if (resetOffset) this.pauseOffset = 0;
    this.isPlaying = false;
  }

  async seek(fraction) {
    const t = fraction * this.duration;
    this.pauseOffset = t;
    if (this.isPlaying) {
      await invoke('audio_seek', {
        offsetSecs:  t,
        semitones:   this.semitones,
        speed:       this.speed,
        volume:      this.volume,
        loopEnabled: this.loopEnabled,
        loopStart:   this.loopStart * this.duration,
        loopEnd:     this.loopEnd   * this.duration,
      });
    } else if (this.onProgress) {
      this.onProgress(fraction, t);
    }
  }

  get currentTime() {
    return this.pauseOffset;
  }

  setVolume(v) {
    this.volume = v;
    invoke('audio_set_volume', { volume: v }).catch(() => {});
  }

  setSemitones(s) {
    this.semitones = s;
    if (!this.isPlaying) return;
    clearTimeout(this._semitoneDebounce);
    this._semitoneDebounce = setTimeout(() => {
      invoke('audio_set_semitones', {
        semitones:   this.semitones,
        speed:       this.speed,
        volume:      this.volume,
        loopEnabled: this.loopEnabled,
        loopStart:   this.loopStart * this.duration,
        loopEnd:     this.loopEnd   * this.duration,
      }).catch(() => {});
    }, 150);
  }

  setSpeed(s) {
    this.speed = s;
    if (!this.isPlaying) return;
    clearTimeout(this._speedDebounce);
    this._speedDebounce = setTimeout(() => {
      invoke('audio_set_speed', {
        speed:       this.speed,
        semitones:   this.semitones,
        volume:      this.volume,
        loopEnabled: this.loopEnabled,
        loopStart:   this.loopStart * this.duration,
        loopEnd:     this.loopEnd   * this.duration,
      }).catch(() => {});
    }, 150);
  }

  setLoopEnabled(enabled) {
    this.loopEnabled = enabled;
    invoke('audio_set_loop', {
      enabled,
      loopStart: this.loopStart * this.duration,
      loopEnd:   this.loopEnd   * this.duration,
    }).catch(() => {});
  }

  setLoopPoints(start, end) {
    this.loopStart = start;
    this.loopEnd   = end;
    invoke('audio_set_loop', {
      enabled:   this.loopEnabled,
      loopStart: start * this.duration,
      loopEnd:   end   * this.duration,
    }).catch(() => {});
  }
}

// Players map: trackId -> TrackPlayer
export const players = {};
