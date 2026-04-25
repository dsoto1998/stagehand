// ─── WAVEFORM RENDERER ───────────────────────────────────────
// peaks: Float32Array or Array of 600 max-abs amplitude values (0–1) from Rust
export function renderWaveform(canvas, peaks) {
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth || 600;
  const H = canvas.offsetHeight || 52;
  canvas.width = W;
  canvas.height = H;

  const mid = H / 2;

  ctx.clearRect(0, 0, W, H);

  // No peaks yet — render flat loading state
  if (!peaks || peaks.length === 0) {
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, 'rgba(30,30,42,0.8)');
    bg.addColorStop(1, 'rgba(10,10,18,0.8)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(0,150,199,0.15)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(W, mid);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  // Background gradient
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, 'rgba(30,30,42,0.8)');
  bg.addColorStop(1, 'rgba(10,10,18,0.8)');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Waveform — peaks are already reduced max-abs per bucket
  const n = peaks.length;
  for (let i = 0; i < W; i++) {
    const bucketIdx = Math.floor(i / W * n);
    const amp = peaks[bucketIdx] || 0;
    const yMax = mid - amp * mid * 0.9;
    const yMin = mid + amp * mid * 0.9;
    const bright = Math.min(1, amp * 4);
    ctx.fillStyle = `rgba(0,${Math.round(55 + bright*95)},${Math.round(55 + bright*144)},${0.5 + bright*0.5})`;
    ctx.fillRect(i, yMax, 1, Math.max(1, yMin - yMax));
  }

  // Center line
  ctx.strokeStyle = 'rgba(0,150,199,0.1)';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(W, mid);
  ctx.stroke();
  ctx.setLineDash([]);
}

// ─── PLAYER WAVEFORM (two-layer approach) ────────────────────
//
// Rendering the two-tone waveform per-pixel on every mousemove/rAF frame
// means ~800 fillStyle + fillRect pairs = 1600 canvas ops/frame. Instead:
//
//   buildWaveformLayers()  — called ONCE when peaks change or canvas resizes.
//                            Produces two pre-rendered offscreen canvases:
//                            `dim`   = full waveform in unplayed colour
//                            `bright`= full waveform in played colour
//
//   renderPlayerWaveform() — called per frame. Composites the two layers with
//                            a single clip rect. ~7 ops instead of 1600.

function _makeCanvas(W, H) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(W, H);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  return c;
}

// Returns { dim, bright, W, H } or null when no peaks / zero dimensions.
export function buildWaveformLayers(peaks, W, H) {
  if (!peaks || !peaks.length || W <= 0 || H <= 0) return null;

  const dim    = _makeCanvas(W, H);
  const bright = _makeCanvas(W, H);
  const ctxD   = dim.getContext('2d');
  const ctxB   = bright.getContext('2d');

  const mid  = H / 2;
  const pad  = Math.round(H * 0.18);
  const maxH = H - pad * 2;
  const n    = peaks.length;

  // Set colour once each — not inside the loop — then only draw geometry.
  ctxD.fillStyle = 'rgba(0,150,199,0.28)';
  ctxB.fillStyle = '#0096C7';

  for (let i = 0; i < W; i++) {
    const amp = peaks[Math.floor(i / W * n)] || 0;
    const h   = Math.max(1, amp * maxH * 0.9);
    const y   = mid - h * 0.5;
    ctxD.fillRect(i, y, 1, h);
    ctxB.fillRect(i, y, 1, h);
  }

  return { dim, bright, W, H };
}

// Fast composite — draws dim layer full-width then clips bright layer to played region.
// layers: result of buildWaveformLayers(), or null for the flat-line fallback.
export function renderPlayerWaveform(canvas, layers, progress, W, H) {
  W = W || canvas.offsetWidth || 600;
  H = H || canvas.offsetHeight || 36;

  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }

  const ctx     = canvas.getContext('2d');
  const playedX = Math.round(progress * W);
  ctx.clearRect(0, 0, W, H);

  // If layers are stale (built at a different size), fall back to flat line
  // until _rebuildWaveformLayers() produces fresh ones.
  if (!layers || layers.W !== W || layers.H !== H) {
    const mid = H / 2;
    ctx.fillStyle = 'rgba(0,150,199,0.15)';
    ctx.fillRect(0, mid - 1, W, 2);
    if (playedX > 0) {
      ctx.fillStyle = 'rgba(0,150,199,0.65)';
      ctx.fillRect(0, mid - 1, playedX, 2);
    }
    return;
  }

  // Unplayed background — full width, one drawImage call.
  ctx.drawImage(layers.dim, 0, 0);

  // Played overlay — clip to [0, playedX] then blit bright layer.
  if (playedX > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, playedX, H);
    ctx.clip();
    ctx.drawImage(layers.bright, 0, 0);
    ctx.restore();
  }
}
