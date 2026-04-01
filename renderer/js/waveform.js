// ─── WAVEFORM RENDERER ───────────────────────────────────────
export function renderWaveform(canvas, audioBuffer) {
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth || 600;
  const H = canvas.offsetHeight || 52;
  canvas.width = W;
  canvas.height = H;

  const data = audioBuffer.getChannelData(0);
  const step = Math.ceil(data.length / W);
  const mid = H / 2;

  ctx.clearRect(0, 0, W, H);

  // Background gradient
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, 'rgba(30,30,42,0.8)');
  bg.addColorStop(1, 'rgba(10,10,18,0.8)');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Waveform
  for (let i = 0; i < W; i++) {
    let min = 0, max = 0;
    for (let j = 0; j < step; j++) {
      const v = data[i * step + j] || 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const yMin = mid + min * mid * 0.9;
    const yMax = mid + max * mid * 0.9;
    const bright = Math.min(1, (yMax - yMin) / H * 4);
    ctx.fillStyle = `rgba(${Math.round(bright*0)},${Math.round(55 + bright*95)},${Math.round(55 + bright*144)},${0.5 + bright*0.5})`;
    ctx.fillRect(i, yMin, 1, Math.max(1, yMax - yMin));
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
