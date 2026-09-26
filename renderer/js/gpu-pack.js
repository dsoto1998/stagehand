// ─── Settings → Audio → Guitar Removal — GPU Acceleration ────
//
// Optional one-time download of the CUDA build of torch (see
// src-tauri/src/gpu_pack.rs). Without it guitar removal still works, on CPU.

import { invoke, listen } from './tauri-api.js';

const GB = 1024 ** 3;
const fmtGB = bytes => `${(bytes / GB).toFixed(1)} GB`;

const STAGE_TEXT = {
  downloading: 'Downloading',
  verifying: 'Verifying download…',
  extracting: 'Unpacking',
  probing: 'Checking your GPU…',
};

/**
 * Pure: turn a `gpu_pack_status` payload into what the section shows.
 * Returns { text, tone: ''|'ok'|'warn'|'error', pct: number|null,
 *           install: bool, cancel: bool, remove: bool, installLabel }.
 */
export function gpuPackView(st) {
  const p = st?.progress || {};
  const size = fmtGB(st?.sizeBytes || 0);

  if (p.installing) {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : null;
    let text = STAGE_TEXT[p.stage] || 'Working…';
    if (p.stage === 'downloading' && p.total) text += ` ${fmtGB(p.done)} of ${fmtGB(p.total)}`;
    if (p.stage === 'extracting' && pct !== null) text += ` ${pct}%`;
    return { text, tone: '', pct, install: false, cancel: p.stage === 'downloading' || p.stage === 'extracting', remove: false, installLabel: '' };
  }

  if (st?.installed) {
    const gpu = st.probe?.gpu || st.gpuName || 'your GPU';
    return { text: `Active — guitar removal runs on ${gpu}.`, tone: 'ok', pct: null, install: false, cancel: false, remove: true, installLabel: '' };
  }

  if (!st?.gpuName) {
    return {
      text: 'No NVIDIA GPU detected. Guitar removal runs on the CPU (a few minutes per song).',
      tone: '', pct: null, install: false, cancel: false, remove: false, installLabel: '',
    };
  }

  if (st.driverOk === false) {
    return {
      text: `${st.gpuName} found, but its driver (${st.driver}) is too old — update to ${st.minDriver} or newer to use GPU acceleration.`,
      tone: 'warn', pct: null, install: false, cancel: false, remove: false, installLabel: '',
    };
  }

  const failed = p.stage === 'error' && p.error && p.error !== 'cancelled';
  return {
    text: failed
      ? `Install failed: ${p.error}`
      : `${st.gpuName} detected. Download the GPU pack (${size}, one time) to remove guitar in seconds instead of minutes.`,
    tone: failed ? 'error' : '',
    pct: null,
    install: true,
    cancel: false,
    remove: false,
    installLabel: failed ? 'Retry' : `Download GPU pack (${size})`,
  };
}

let lastStatus = null;

function render(st) {
  lastStatus = st;
  const v = gpuPackView(st);
  const el = id => document.getElementById(id);
  const status = el('gpu-pack-status');
  if (!status) return;
  status.textContent = v.text;
  status.dataset.tone = v.tone;
  el('gpu-pack-bar')?.classList.toggle('hidden', v.pct === null);
  if (v.pct !== null) el('gpu-pack-fill').style.width = `${v.pct}%`;
  const install = el('gpu-pack-install');
  install?.classList.toggle('hidden', !v.install);
  if (install && v.installLabel) install.textContent = v.installLabel;
  el('gpu-pack-cancel')?.classList.toggle('hidden', !v.cancel);
  el('gpu-pack-remove')?.classList.toggle('hidden', !v.remove);
}

async function refresh() {
  try { render(await invoke('gpu_pack_status')); } catch (e) { console.warn('gpu_pack_status failed', e); }
}

export function initGpuPack({ notify = () => {}, confirm = async () => true } = {}) {
  const el = id => document.getElementById(id);

  el('gpu-pack-install')?.addEventListener('click', () => {
    invoke('gpu_pack_install').then(refresh).catch(e => notify('GPU pack: ' + (e?.message || e), 'error'));
  });
  el('gpu-pack-cancel')?.addEventListener('click', () => { invoke('gpu_pack_cancel').catch(() => {}); });
  el('gpu-pack-remove')?.addEventListener('click', async () => {
    const yes = await confirm('Remove GPU pack', 'Delete the downloaded GPU pack? Guitar removal will fall back to the CPU. You can download it again any time.');
    if (!yes) return;
    invoke('gpu_pack_remove').then(refresh).catch(e => notify('GPU pack: ' + (e?.message || e), 'error'));
  });

  listen('gpu_pack_progress', e => {
    const p = e.payload || {};
    render({ ...(lastStatus || {}), progress: p });
    if (!p.installing) {
      if (p.stage === 'done') notify('GPU pack installed — guitar removal now uses your GPU', 'success');
      refresh(); // pick up installed/probe info
    }
  }).catch(() => {});

  // Re-check whenever the Audio tab opens (driver may have been updated since).
  document.querySelector('.sp-tab[data-tab="audio"]')?.addEventListener('click', refresh);
  refresh();
}
