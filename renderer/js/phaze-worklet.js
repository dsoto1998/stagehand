// ── OLA base ────────────────────────────────────────────────
class OLAProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    this._numChannels = options.processorOptions.numChannels || 1;
    this._frameSize   = options.processorOptions.frameSize  || 2048;
    this._hopSize     = options.processorOptions.hopSize    || 512;
    const BUF = this._frameSize * 8; // large ring to prevent read/write head collision

    // Per-channel circular input ring
    this._inRing  = Array.from({length: this._numChannels}, () => new Float32Array(BUF));
    // Per-channel OLA output accumulator ring (same size)
    this._outRing = Array.from({length: this._numChannels}, () => new Float32Array(BUF));

    this._BUF         = BUF;
    this._inWritePtr  = 0;
    this._outReadPtr  = 0;
    // The first frame fires at sample (frameSize-1), at which point _outReadPtr == frameSize-1.
    // Initialise the write pointer to the same position so the frame's first output sample
    // lands exactly where the reader currently is, rather than in already-read positions.
    this._outWritePtr = this._frameSize - 1;
    this._inputFill   = 0; // tracks how many samples written; gates first frame
    this._hopCounter  = 0; // count-up to next frame trigger

    // Hann window (applied once here in OLA layer only — processFrame must NOT re-window)
    this._window = new Float32Array(this._frameSize);
    for (let i = 0; i < this._frameSize; i++)
      this._window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / this._frameSize));

    // OLA norm for 4x overlap Hann: 2 * hopSize / frameSize
    this._normGain = (2 * this._hopSize) / this._frameSize;
  }

  process(inputs, outputs, parameters) {
    const inp = inputs[0];
    const out = outputs[0];
    // Use configured numChannels — don't trust inp.length, which can be 0 on silent blocks
    const nCh = this._numChannels;
    const blockSize = (out && out[0]) ? out[0].length : 128;
    const BUF = this._BUF;
    const fs  = this._frameSize;
    const hop = this._hopSize;

    for (let i = 0; i < blockSize; i++) {
      // 1. Write input sample into ring (zero if inp not yet live)
      const inIdx = this._inWritePtr % BUF;
      for (let c = 0; c < nCh; c++) {
        this._inRing[c][inIdx] = (inp && inp[c]) ? (inp[c][i] || 0) : 0;
      }
      this._inWritePtr++;
      if (this._inputFill < fs) this._inputFill++;
      this._hopCounter++;

      // 2. Fire processFrame every hopSize samples once ring has >= frameSize samples
      if (this._hopCounter >= hop) {
        this._hopCounter = 0;
        if (this._inputFill >= fs) {
          const frames = [];
          for (let c = 0; c < nCh; c++) {
            const f = new Float32Array(fs);
            const base = (this._inWritePtr - fs + BUF * 8) % BUF;
            for (let j = 0; j < fs; j++) f[j] = this._inRing[c][(base + j) % BUF];
            frames.push(f);
          }

          const result = this.processFrame(frames, nCh, parameters);

          // OLA-add: window + normalise, then accumulate into output ring
          const ng = this._normGain;
          const wp = this._outWritePtr;
          for (let c = 0; c < nCh; c++) {
            for (let j = 0; j < fs; j++) {
              this._outRing[c][(wp + j) % BUF] += result[c][j] * this._window[j] * ng;
            }
          }
          this._outWritePtr = (wp + hop) % BUF;
        }
      }

      // 3. Read and clear one sample from output ring
      const rIdx = this._outReadPtr % BUF;
      for (let c = 0; c < nCh; c++) {
        if (out && out[c]) out[c][i] = this._outRing[c][rIdx];
        this._outRing[c][rIdx] = 0;
      }
      this._outReadPtr++;
    }
    return true;
  }

  // Subclass: return Float32Array[fs] per channel. Do NOT apply window to output.
  processFrame(frames, nCh, parameters) { return frames; }
}

// ── Phase Vocoder ────────────────────────────────────────────
class PhaseVocoderProcessor extends OLAProcessor {
  static get parameterDescriptors() {
    return [{ name: 'pitchFactor', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }

  constructor(options) {
    const frameSize = 2048;
    const overlap   = 4;
    options.processorOptions = {
      numChannels: options.processorOptions?.numChannels || 1,
      frameSize,
      hopSize: frameSize / overlap,
    };
    super(options);
    this._overlap = overlap;

    // Per-channel phase tracking
    this._prevInputPhase = Array.from({length: this._numChannels}, () => new Float32Array(frameSize));
    this._synthPhase     = Array.from({length: this._numChannels}, () => new Float32Array(frameSize));
  }

  processFrame(frames, nCh, parameters) {
    const pitchFactor = (parameters && parameters['pitchFactor'] && parameters['pitchFactor'][0])
      || 1;
    const fs  = this._frameSize;
    const hop = this._hopSize;
    const expct = 2 * Math.PI * hop / fs;

    const output = [];
    for (let c = 0; c < nCh; c++) output.push(new Float32Array(fs));

    for (let c = 0; c < nCh; c++) {
      const frame   = frames[c];
      const prevPh  = this._prevInputPhase[c];
      const synthPh = this._synthPhase[c];

      // Window the analysis frame
      const re = new Float32Array(fs);
      const im = new Float32Array(fs);
      for (let i = 0; i < fs; i++) re[i] = frame[i] * this._window[i];

      // Forward FFT (im is all zeros going in)
      fft(re, im, false);

      // Analysis: magnitude + true frequency per bin
      const mag      = new Float32Array(fs);
      const trueFreq = new Float32Array(fs);
      for (let k = 0; k < fs; k++) {
        mag[k] = Math.sqrt(re[k]*re[k] + im[k]*im[k]);
        const ph = Math.atan2(im[k], re[k]);
        let dp = ph - prevPh[k] - expct * k;
        // Principal-value wrap to [-π, π]
        dp -= 2 * Math.PI * Math.round(dp / (2 * Math.PI));
        trueFreq[k] = (expct * k + dp) / hop; // true freq in rad/sample
        prevPh[k] = ph;
      }

      // Synthesis: scatter each input bin k into output bin round(k * pitchFactor)
      const sre = new Float32Array(fs);
      const sim = new Float32Array(fs);
      for (let k = 0; k < fs; k++) {
        const sk = Math.round(k * pitchFactor);
        if (sk >= 0 && sk < fs) {
          synthPh[sk] += trueFreq[k] * pitchFactor * hop;
          sre[sk] += mag[k] * Math.cos(synthPh[sk]);
          sim[sk] += mag[k] * Math.sin(synthPh[sk]);
        }
      }

      // Inverse FFT
      fft(sre, sim, true);
      // Return the real part only — do NOT apply window here, OLA layer does it
      output[c] = sre;
    }
    return output;
  }
}

// ── Cooley-Tukey FFT (in-place, power-of-2) ──────────────────
function fft(re, im, inverse) {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  // Butterfly passes
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 1 : -1) * 2 * Math.PI / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let uRe = 1, uIm = 0;
      for (let j = 0; j < len >> 1; j++) {
        const p = i + j, q = i + j + (len >> 1);
        const vRe = re[q]*uRe - im[q]*uIm;
        const vIm = re[q]*uIm + im[q]*uRe;
        re[q] = re[p] - vRe;  im[q] = im[p] - vIm;
        re[p] = re[p] + vRe;  im[p] = im[p] + vIm;
        const nu = uRe*wRe - uIm*wIm;
        uIm = uRe*wIm + uIm*wRe;
        uRe = nu;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

registerProcessor('phaze-processor', PhaseVocoderProcessor);
