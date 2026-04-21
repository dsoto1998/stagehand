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
