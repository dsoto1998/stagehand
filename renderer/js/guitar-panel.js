// Guitar Panel — live input device picker, gain knobs, plugin loader.
// Talks to Rust via live_input_* and vst_* Tauri commands.
//
// UX notes:
//   - Stream auto-starts on device select; restarts (debounced 500ms) on any
//     setting change while running. Helix Native re-init can take 1-3s; the
//     resulting audio glitch is the documented cost of changing source/buffer
//     while live and is accepted in lieu of a manual Start/Stop control.
//   - Click the status line to toggle stop/start.

import { invoke, listen } from './tauri-api.js';

const LS_KEY = 'stagehand_guitar_config';
const RESTART_DEBOUNCE_MS = 500;

const DEFAULT_CFG = {
  deviceName: '',
  isAsio: false,
  bufferSize: 256,
  sampleRate: 44100,
  // inputSource encodes mono vs stereo + channel offsets, e.g. 'mono:0', 'stereo:0,1'
  inputSource: 'mono:0',
  outputChannels: [0, 1],
  inputGain: 1.0,
  outputGain: 1.0,
  muted: false,
  pluginPath: '',
  bypassed: false,
  advancedOpen: false,
};

let cfg = { ...DEFAULT_CFG };
let devices = [];
let running = false;
let pluginLoaded = false;
let restartTimer = null;
let pollTimer = null;
let displayLevel = 0;

// ── Persistence ──────────────────────────────────────────────
function loadCfg() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) cfg = { ...DEFAULT_CFG, ...JSON.parse(raw) };
  } catch (e) {
    console.warn('[guitar] load cfg failed', e);
  }
}
function saveCfg() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(cfg));
  } catch (e) {
    console.warn('[guitar] save cfg failed', e);
  }
}

// ── Input source helpers ────────────────────────────────────
function parseInputSource(src) {
  const [kind, idxStr] = src.split(':');
  const indices = idxStr.split(',').map(s => parseInt(s, 10));
  return { kind, indices };
}
function inputChannelsFromSource() {
  return parseInputSource(cfg.inputSource).indices;
}
function buildInputSourceOptions(channelCount) {
  const opts = [];
  for (let i = 0; i < channelCount; i++) {
    opts.push({ value: `mono:${i}`, label: `Ch ${i + 1} (Mono)` });
  }
  for (let i = 0; i + 1 < channelCount; i += 2) {
    opts.push({ value: `stereo:${i},${i + 1}`, label: `Ch ${i + 1}+${i + 2} (Stereo)` });
  }
  return opts;
}

// ── Gain conversion ──────────────────────────────────────────
function sliderToGain(v) { return v / 100; }
function gainToSlider(g) { return Math.round(g * 100); }
function gainToDb(g) {
  if (g <= 0.0001) return '-∞ dB';
  const db = 20 * Math.log10(g);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

// ── Device list ─────────────────────────────────────────────
async function refreshDevices() {
  try {
    devices = await invoke('live_input_get_input_devices');
  } catch (e) {
    devices = [];
    console.warn('[guitar] device enum failed', e);
  }
  renderDeviceSelect();
}

function renderDeviceSelect() {
  const sel = document.getElementById('gp-device-select');
  sel.innerHTML = '';
  if (devices.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No input devices found';
    sel.appendChild(opt);
    sel.disabled = true;
    renderInputSourceSelect();
    renderOutputChips();
    return;
  }
  sel.disabled = false;
  for (const d of devices) {
    const opt = document.createElement('option');
    opt.value = d.name;
    const proLabel = d.is_asio ? ' [Pro]' : '';
    opt.textContent = `${d.name}${proLabel} — ${d.channels}ch`;
    sel.appendChild(opt);
  }
  const found = devices.find(d => d.name === cfg.deviceName);
  if (found) {
    sel.value = found.name;
  } else {
    sel.value = devices[0].name;
    cfg.deviceName = devices[0].name;
    cfg.isAsio = devices[0].is_asio;
    saveCfg();
  }
  renderInputSourceSelect();
  renderOutputChips();
}

function renderInputSourceSelect() {
  const sel = document.getElementById('gp-input-source-select');
  const dev = devices.find(d => d.name === cfg.deviceName);
  sel.innerHTML = '';
  if (!dev || dev.channels === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No channels available';
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  const opts = buildInputSourceOptions(dev.channels);
  for (const o of opts) {
    const optEl = document.createElement('option');
    optEl.value = o.value;
    optEl.textContent = o.label;
    sel.appendChild(optEl);
  }
  // Validate persisted choice fits current device; fall back to mono:0.
  const valid = opts.some(o => o.value === cfg.inputSource);
  if (!valid) {
    cfg.inputSource = 'mono:0';
    saveCfg();
  }
  sel.value = cfg.inputSource;
}

function renderOutputChips() {
  const dev = devices.find(d => d.name === cfg.deviceName);
  const wrap = document.getElementById('gp-output-chans');
  wrap.innerHTML = '';
  if (!dev || dev.channels === 0) {
    wrap.innerHTML = '<span class="gp-chan-empty">No channels available</span>';
    return;
  }
  for (let i = 0; i < dev.channels; i++) {
    const chip = document.createElement('button');
    chip.className = 'gp-chan-chip' + (cfg.outputChannels.includes(i) ? ' active' : '');
    chip.type = 'button';
    chip.textContent = String(i + 1);
    chip.addEventListener('click', () => {
      const at = cfg.outputChannels.indexOf(i);
      if (at >= 0) cfg.outputChannels.splice(at, 1);
      else cfg.outputChannels.push(i);
      cfg.outputChannels.sort((a, b) => a - b);
      chip.classList.toggle('active');
      saveCfg();
      scheduleRestart();
    });
    wrap.appendChild(chip);
  }
}

// ── Level meter ───────────────────────────────────────────
function updateMeter(level) {
  const bar = document.getElementById('gp-level-bar');
  if (!bar) return;
  const pct = Math.min(level * 100, 100).toFixed(1);
  bar.style.width = `${pct}%`;
  bar.classList.toggle('warn', level > 0.7 && level <= 0.9);
  bar.classList.toggle('clip', level > 0.9);
}

function startPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (!running) { stopPoll(); return; }
    try {
      const status = await invoke('live_input_status');
      // Decay toward zero each tick; snap up instantly to new peak.
      displayLevel = Math.max(status.peak_level, displayLevel * 0.80);
      updateMeter(displayLevel);
    } catch (_) {}
  }, 100);
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  displayLevel = 0;
  updateMeter(0);
}

// ── Status line ────────────────────────────────────────────
function updateStatusLine() {
  const dot = document.getElementById('gp-status-dot');
  const text = document.getElementById('gp-status-text');
  dot.classList.toggle('live', running);
  if (running) {
    text.textContent = `Live — ${cfg.deviceName} — ${cfg.bufferSize} samples`;
  } else {
    text.textContent = 'Stopped';
  }
  const badge = document.getElementById('guitar-badge');
  if (badge) badge.classList.toggle('hidden', !running);
}

// ── Start / Stop / Restart ──────────────────────────────────
async function startInput() {
  if (!cfg.deviceName) return;
  const inputChannels = inputChannelsFromSource();
  if (inputChannels.length === 0 || cfg.outputChannels.length === 0) {
    notify('Pick at least one input and one output channel', 'error');
    return;
  }
  try {
    await invoke('live_input_start', {
      config: {
        device_name: cfg.deviceName,
        is_asio: cfg.isAsio,
        input_channels: inputChannels,
        output_channels: cfg.outputChannels,
        buffer_size: cfg.bufferSize,
        sample_rate: cfg.sampleRate,
      },
    });
    running = true;
    updateStatusLine();
    startPoll();
  } catch (e) {
    running = false;
    updateStatusLine();
    notify('Failed to start: ' + e, 'error');
  }
}
async function stopInput() {
  try {
    await invoke('live_input_stop');
  } catch (e) {
    console.warn('[guitar] stop failed', e);
  }
  running = false;
  stopPoll();
  updateStatusLine();
}
function scheduleRestart() {
  // Debounce: many rapid setting changes coalesce into one restart.
  if (!running) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    await stopInput();
    await startInput();
  }, RESTART_DEBOUNCE_MS);
}

// ── Plugin ──────────────────────────────────────────────────
function updatePluginDisplay() {
  const nameEl = document.getElementById('gp-plugin-name');
  const pathEl = document.getElementById('gp-plugin-path');
  const guiBtn = document.getElementById('gp-gui-btn');
  const bypassBtn = document.getElementById('gp-bypass-btn');
  const unloadBtn = document.getElementById('gp-unload-btn');

  if (pluginLoaded && cfg.pluginPath) {
    const fileName = cfg.pluginPath.split(/[\\/]/).pop().replace(/\.vst3$/i, '');
    nameEl.textContent = fileName;
    nameEl.classList.add('loaded');
    pathEl.textContent = cfg.pluginPath;
    guiBtn.disabled = false;
    bypassBtn.disabled = false;
    unloadBtn.disabled = false;
    bypassBtn.classList.toggle('active', cfg.bypassed);
    bypassBtn.textContent = cfg.bypassed ? 'Bypassed' : 'Bypass';
  } else {
    nameEl.textContent = 'No plugin loaded';
    nameEl.classList.remove('loaded');
    pathEl.textContent = '';
    guiBtn.disabled = true;
    bypassBtn.disabled = true;
    unloadBtn.disabled = true;
    bypassBtn.classList.remove('active');
    bypassBtn.textContent = 'Bypass';
  }
}

async function loadPlugin() {
  let path;
  try {
    path = await invoke('open_vst_dialog');
  } catch (e) {
    notify('File dialog failed: ' + e, 'error');
    return;
  }
  if (!path) return;
  try {
    await invoke('vst_load', { path, sampleRate: cfg.sampleRate });
    cfg.pluginPath = path;
    cfg.bypassed = false;
    pluginLoaded = true;
    saveCfg();
    updatePluginDisplay();
    notify('Plugin loaded', 'success');
  } catch (e) {
    notify('Plugin load failed: ' + e, 'error');
  }
}
async function unloadPlugin() {
  try {
    await invoke('vst_close_gui').catch(() => {});
    await invoke('vst_unload');
    cfg.pluginPath = '';
    cfg.bypassed = false;
    pluginLoaded = false;
    document.getElementById('gp-plugin-latency').textContent = '0.0 ms';
    saveCfg();
    updatePluginDisplay();
  } catch (e) {
    notify('Unload failed: ' + e, 'error');
  }
}
async function toggleBypass() {
  cfg.bypassed = !cfg.bypassed;
  try {
    await invoke('vst_bypass', { bypassed: cfg.bypassed });
    saveCfg();
    updatePluginDisplay();
  } catch (e) {
    cfg.bypassed = !cfg.bypassed;
    notify('Bypass toggle failed: ' + e, 'error');
  }
}
async function openGui() {
  try {
    await invoke('vst_open_gui');
  } catch (e) {
    notify('Open GUI failed: ' + e, 'error');
  }
}

// ── Notification (reuse #notif) ─────────────────────────────
function notify(msg, type = '') {
  const el = document.getElementById('notif');
  if (!el) { console.log('[guitar]', msg); return; }
  el.textContent = msg;
  el.className = type;
  el.classList.add('show');
  clearTimeout(notify._t);
  notify._t = setTimeout(() => el.classList.remove('show'), 2500);
}

// ── Advanced disclosure ────────────────────────────────────
function applyAdvancedState() {
  const hdr = document.getElementById('gp-advanced-hdr');
  const body = document.getElementById('gp-advanced-body');
  hdr.setAttribute('aria-expanded', String(cfg.advancedOpen));
  body.classList.toggle('open', cfg.advancedOpen);
}

// ── Init ───────────────────────────────────────────────────
export function initGuitarPanel() {
  loadCfg();

  // Device select — auto-start on change
  document.getElementById('gp-device-select').addEventListener('change', async e => {
    const wasRunning = running;
    if (wasRunning) await stopInput();
    cfg.deviceName = e.target.value;
    const dev = devices.find(d => d.name === cfg.deviceName);
    cfg.isAsio = dev?.is_asio ?? false;
    cfg.inputSource = 'mono:0';
    cfg.outputChannels = dev && dev.channels >= 2 ? [0, 1] : [0];
    saveCfg();
    renderInputSourceSelect();
    renderOutputChips();
    if (cfg.deviceName) await startInput();
  });

  // Input source dropdown
  document.getElementById('gp-input-source-select').addEventListener('change', e => {
    cfg.inputSource = e.target.value;
    saveCfg();
    scheduleRestart();
  });

  // Buffer/rate selects
  const bufSel = document.getElementById('gp-buffer-select');
  bufSel.value = String(cfg.bufferSize);
  bufSel.addEventListener('change', e => {
    cfg.bufferSize = parseInt(e.target.value, 10);
    saveCfg();
    scheduleRestart();
  });
  const rateSel = document.getElementById('gp-rate-select');
  rateSel.value = String(cfg.sampleRate);
  rateSel.addEventListener('change', e => {
    cfg.sampleRate = parseInt(e.target.value, 10);
    saveCfg();
    scheduleRestart();
  });

  // Advanced disclosure
  document.getElementById('gp-advanced-hdr').addEventListener('click', () => {
    cfg.advancedOpen = !cfg.advancedOpen;
    applyAdvancedState();
    saveCfg();
  });
  applyAdvancedState();

  // Status line click → toggle
  document.getElementById('gp-status-line').addEventListener('click', () => {
    if (running) stopInput();
    else startInput();
  });

  // Gain sliders
  const inGain = document.getElementById('gp-input-gain');
  const inGainVal = document.getElementById('gp-input-gain-val');
  inGain.value = String(gainToSlider(cfg.inputGain));
  inGainVal.textContent = gainToDb(cfg.inputGain);
  inGain.addEventListener('input', e => {
    cfg.inputGain = sliderToGain(parseInt(e.target.value, 10));
    inGainVal.textContent = gainToDb(cfg.inputGain);
    invoke('live_input_set_input_gain', { gain: cfg.inputGain }).catch(() => {});
  });
  inGain.addEventListener('change', saveCfg);

  const outGain = document.getElementById('gp-output-gain');
  const outGainVal = document.getElementById('gp-output-gain-val');
  outGain.value = String(gainToSlider(cfg.outputGain));
  outGainVal.textContent = gainToDb(cfg.outputGain);
  outGain.addEventListener('input', e => {
    cfg.outputGain = sliderToGain(parseInt(e.target.value, 10));
    outGainVal.textContent = gainToDb(cfg.outputGain);
    invoke('live_input_set_output_gain', { gain: cfg.outputGain }).catch(() => {});
  });
  outGain.addEventListener('change', saveCfg);

  // Mute
  const muteBtn = document.getElementById('gp-mute-btn');
  muteBtn.classList.toggle('active', cfg.muted);
  muteBtn.textContent = cfg.muted ? 'Unmute Input' : 'Mute Input';
  muteBtn.addEventListener('click', () => {
    cfg.muted = !cfg.muted;
    muteBtn.classList.toggle('active', cfg.muted);
    muteBtn.textContent = cfg.muted ? 'Unmute Input' : 'Mute Input';
    saveCfg();
    invoke('live_input_set_mute', { muted: cfg.muted }).catch(() => {});
  });

  // Plugin buttons
  document.getElementById('gp-load-btn').addEventListener('click', loadPlugin);
  document.getElementById('gp-unload-btn').addEventListener('click', unloadPlugin);
  document.getElementById('gp-bypass-btn').addEventListener('click', toggleBypass);
  document.getElementById('gp-gui-btn').addEventListener('click', openGui);

  // Latency event from Rust
  listen('vst_latency', evt => {
    const latEl = document.getElementById('gp-plugin-latency');
    const ms = evt.payload?.latency_ms;
    if (typeof ms === 'number') {
      latEl.textContent = `${ms.toFixed(1)} ms`;
    }
  }).catch(() => {});

  // Initial render
  updatePluginDisplay();
  updateStatusLine();
  refreshDevices();

  // Refresh devices when user clicks the Guitar nav
  document.querySelector('.nav-item[data-panel="guitar"]')?.addEventListener('click', () => {
    refreshDevices();
  });
}
