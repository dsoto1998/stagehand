// Guitar Panel — live input device picker, gain knobs, multi-plugin chain.
// Talks to Rust via live_input_* and vst_* Tauri commands.

import { invoke, listen } from './tauri-api.js';
import { ICONS } from './icons.js';
import * as LibraryManager from './library-manager.js';

const LS_KEY = 'stagehand_guitar_config';
const RESTART_DEBOUNCE_MS = 500;

const DEFAULT_CFG = {
  deviceName: '',
  isAsio: false,
  bufferSize: 256,
  sampleRate: 44100,
  inputSource: 'mono:0',
  outputChannels: [0, 1],
  inputGain: 1.0,
  outputGain: 1.0,
  muted: false,
  // Plugin chain — each entry: { path, name, bypassed }
  plugins: [],
  globalBypassed: false,
  advancedOpen: false,
};

let cfg = { ...DEFAULT_CFG };
let devices = [];
let running = false;
let restartTimer = null;
let pollTimer = null;
let devicePollTimer = null;
let displayLevel = 0;
let isReloading = false;

// ── Persistence ──────────────────────────────────────────────
function loadCfg() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Migrate single-plugin format (v1) → chain format (v2)
      if (parsed.pluginPath !== undefined && !parsed.plugins) {
        parsed.plugins = parsed.pluginPath
          ? [{ path: parsed.pluginPath, name: parsed.pluginPath.split(/[\\/]/).pop().replace(/\.vst3$/i, ''), bypassed: parsed.bypassed ?? false }]
          : [];
        delete parsed.pluginPath;
        delete parsed.bypassed;
      }
      cfg = { ...DEFAULT_CFG, ...parsed };
    }
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
  const valid = opts.some(o => o.value === cfg.inputSource);
  if (!valid) { cfg.inputSource = 'mono:0'; saveCfg(); }
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

// ── Signal path ────────────────────────────────────────────
function updateSignalPath() {
  const badge = document.getElementById('guitar-badge');
  if (badge) badge.classList.toggle('hidden', !running);

  const container = document.getElementById('gp-signal-path');
  if (!container) return;

  const shortName = cfg.deviceName
    ? cfg.deviceName.replace(/\s*\(.*?\)\s*/g, '').trim().split(' ').slice(0, 2).join(' ')
    : 'In';

  const nodes = [];

  // In node
  nodes.push({ label: shortName || 'In', title: cfg.deviceName || '', state: running ? 'active' : '' });
  // Gain node
  nodes.push({ label: 'Gain', title: '', state: running ? 'active' : '' });

  // Plugin nodes
  for (const p of cfg.plugins) {
    const name = p.name || p.path.split(/[\\/]/).pop().replace(/\.vst3$/i, '');
    const state = cfg.globalBypassed || p.bypassed ? 'plugin-bypass' : (running ? 'active' : '');
    nodes.push({ label: name, title: name, state });
  }

  // Out node
  nodes.push({ label: 'Out', title: '', state: running ? 'active' : '' });

  let html = '';
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    html += `<span class="gp-sp-node${n.state ? ' ' + n.state : ''}">` +
      `<span class="gp-sp-dot"></span>` +
      `<span class="gp-sp-label" title="${n.title}">${n.label}</span>` +
      `</span>`;
    if (i < nodes.length - 1) html += `<span class="gp-sp-arrow">→</span>`;
  }
  container.innerHTML = html;
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
    updateSignalPath();
    startPoll();
  } catch (e) {
    running = false;
    updateSignalPath();
    notify('Failed to start: ' + e, 'error');
  }
}
async function stopInput() {
  try { await invoke('live_input_stop'); } catch (e) { console.warn('[guitar] stop failed', e); }
  running = false;
  stopPoll();
  updateSignalPath();
}
function scheduleRestart() {
  if (!running) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    await stopInput();
    await startInput();
  }, RESTART_DEBOUNCE_MS);
}

// ── Plugin chain ────────────────────────────────────────────

// Drag-to-reorder state
let dragSrcIndex = -1;

function buildPluginRow(plugin, index) {
  const row = document.createElement('div');
  row.className = 'gp-plugin-row';
  row.dataset.index = String(index);
  row.draggable = true;

  const name = plugin.name || plugin.path.split(/[\\/]/).pop().replace(/\.vst3$/i, '');
  const latencyMs = plugin.latency_ms ?? 0;

  row.innerHTML = `
    <div class="gp-plugin-drag-handle" title="Drag to reorder">⠿</div>
    <div class="gp-plugin-row-info">
      <div class="gp-plugin-row-name" title="${plugin.path}">${name}</div>
      <div class="gp-plugin-row-latency" data-latency-index="${index}">${latencyMs.toFixed(1)} ms</div>
    </div>
    <div class="gp-plugin-row-actions">
      <button class="gp-icon-btn gp-row-bypass-btn${plugin.bypassed ? ' active' : ''}" title="${plugin.bypassed ? 'Bypassed' : 'Bypass'}" data-idx="${index}">${ICONS.bypass || '⊘'}</button>
      <button class="gp-icon-btn gp-row-gui-btn" title="Open Editor" data-idx="${index}">${ICONS.window || '⊡'}</button>
      <button class="gp-icon-btn gp-row-remove-btn" title="Remove plugin" data-idx="${index}">×</button>
    </div>
  `;

  // Drag events
  row.addEventListener('dragstart', e => {
    dragSrcIndex = index;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    document.querySelectorAll('.gp-plugin-row').forEach(r => r.classList.remove('drag-over'));
    dragSrcIndex = -1;
  });
  row.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.gp-plugin-row').forEach(r => r.classList.remove('drag-over'));
    row.classList.add('drag-over');
  });
  row.addEventListener('drop', async e => {
    e.preventDefault();
    row.classList.remove('drag-over');
    const toIndex = index;
    if (dragSrcIndex < 0 || dragSrcIndex === toIndex) return;
    // Reorder local cfg
    const moved = cfg.plugins.splice(dragSrcIndex, 1)[0];
    cfg.plugins.splice(toIndex, 0, moved);
    saveCfg();
    // Sync Rust chain
    try { await invoke('vst_move', { from: dragSrcIndex, to: toIndex }); } catch (_) {}
    renderPluginList();
    updateSignalPath();
    updateTotalLatency();
  });

  // Bypass toggle
  row.querySelector('.gp-row-bypass-btn').addEventListener('click', async () => {
    plugin.bypassed = !plugin.bypassed;
    saveCfg();
    try { await invoke('vst_bypass', { index, bypassed: plugin.bypassed }); } catch (_) {}
    renderPluginList();
    updateSignalPath();
  });

  // Open editor
  row.querySelector('.gp-row-gui-btn').addEventListener('click', async () => {
    try { await invoke('vst_open_gui', { index }); } catch (e) { notify('Open GUI failed: ' + e, 'error'); }
  });

  // Remove
  row.querySelector('.gp-row-remove-btn').addEventListener('click', async () => {
    // Close GUI first (safe even if not open)
    try { await invoke('vst_close_gui', { index }); } catch (_) {}
    try { await invoke('vst_unload', { index }); } catch (_) {}
    cfg.plugins.splice(index, 1);
    saveCfg();
    renderPluginList();
    updateSignalPath();
    updateTotalLatency();
  });

  return row;
}

function renderPluginList() {
  const list = document.getElementById('gp-plugin-list');
  const empty = document.getElementById('gp-plugin-empty');

  // Remove all rows (keep #gp-plugin-empty)
  list.querySelectorAll('.gp-plugin-row').forEach(r => r.remove());

  if (cfg.plugins.length === 0) {
    if (empty) empty.style.display = '';
    updateGlobalBypassBtn();
    return;
  }
  if (empty) empty.style.display = 'none';

  cfg.plugins.forEach((p, i) => {
    list.appendChild(buildPluginRow(p, i));
  });
  updateGlobalBypassBtn();
}

function updateGlobalBypassBtn() {
  const btn = document.getElementById('gp-global-bypass-btn');
  if (!btn) return;
  btn.classList.toggle('active', cfg.globalBypassed);
  btn.textContent = cfg.globalBypassed ? 'Bypassed All' : 'Bypass All';
}

function updateTotalLatency() {
  const el = document.getElementById('gp-latency-total');
  if (!el) return;
  const total = cfg.plugins.reduce((sum, p) => sum + (p.latency_ms ?? 0), 0);
  el.textContent = `Total latency: ${total.toFixed(1)} ms`;
  el.style.display = cfg.plugins.length > 0 ? '' : 'none';
}

async function addPlugin() {
  if (isReloading) { notify('Wait for session reload to finish', 'error'); return; }
  let path;
  try { path = await invoke('open_vst_dialog'); } catch (e) { notify('File dialog failed: ' + e, 'error'); return; }
  if (!path) return;
  if (cfg.plugins.some(p => p.path === path)) {
    notify('Plugin already in chain — remove it first to add another instance', 'error');
    return;
  }
  try {
    await invoke('vst_load', { path, sampleRate: cfg.sampleRate, index: null });
    const name = path.split(/[\\/]/).pop().replace(/\.vst3$/i, '');
    cfg.plugins.push({ path, name, bypassed: false, latency_ms: 0 });
    saveCfg();
    renderPluginList();
    updateSignalPath();
    updateTotalLatency();
    notify(`Loaded: ${name}`, 'success');
  } catch (e) {
    notify('Plugin load failed: ' + e, 'error');
  }
}

async function toggleGlobalBypass() {
  cfg.globalBypassed = !cfg.globalBypassed;
  saveCfg();
  try { await invoke('vst_global_bypass', { bypassed: cfg.globalBypassed }); } catch (_) {}
  updateGlobalBypassBtn();
  updateSignalPath();
}

// ── Presets ──────────────────────────────────────────────────
let presets = [];

async function loadPresets() {
  try { presets = await LibraryManager.getVstPresets(); } catch (_) { presets = []; }
  renderPresetSelect();
}

function renderPresetSelect() {
  const sel = document.getElementById('gp-preset-select');
  sel.innerHTML = '<option value="">Select preset…</option>';
  for (const p of presets) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  const loadBtn = document.getElementById('gp-preset-load-btn');
  const delBtn = document.getElementById('gp-preset-delete-btn');
  loadBtn.disabled = true;
  delBtn.disabled = true;
}

async function savePreset() {
  const nameEl = document.getElementById('gp-preset-name');
  const name = nameEl.value.trim();
  if (!name) { notify('Enter a preset name', 'error'); return; }
  const preset = {
    id: LibraryManager.genVstPresetId(),
    name,
    plugins: cfg.plugins.map(p => ({ path: p.path, name: p.name, bypassed: p.bypassed })),
    createdAt: Date.now(),
  };
  try {
    await LibraryManager.saveVstPreset(preset);
    nameEl.value = '';
    await loadPresets();
    notify(`Preset "${name}" saved`, 'success');
  } catch (e) {
    notify('Save failed: ' + e, 'error');
  }
}

async function loadPreset() {
  const sel = document.getElementById('gp-preset-select');
  const preset = presets.find(p => p.id === sel.value);
  if (!preset) return;

  // Close + unload all current plugins
  try { await invoke('vst_close_all_guis'); } catch (_) {}
  try { await invoke('vst_unload_all'); } catch (_) {}
  cfg.plugins = [];

  // Load preset plugins in order
  for (const p of preset.plugins) {
    try {
      await invoke('vst_load', { path: p.path, sampleRate: cfg.sampleRate, index: null });
      cfg.plugins.push({ path: p.path, name: p.name, bypassed: p.bypassed ?? false, latency_ms: 0 });
      if (p.bypassed) {
        await invoke('vst_bypass', { index: cfg.plugins.length - 1, bypassed: true }).catch(() => {});
      }
    } catch (e) {
      console.warn('[guitar] preset: failed to load', p.path, e);
    }
  }
  saveCfg();
  renderPluginList();
  updateSignalPath();
  updateTotalLatency();
  notify(`Loaded preset: ${preset.name}`, 'success');
}

async function deletePreset() {
  const sel = document.getElementById('gp-preset-select');
  const preset = presets.find(p => p.id === sel.value);
  if (!preset) return;
  try {
    await LibraryManager.deleteVstPreset(preset.id);
    await loadPresets();
    notify(`Preset "${preset.name}" deleted`, 'success');
  } catch (e) {
    notify('Delete failed: ' + e, 'error');
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

  // Device select
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

  document.getElementById('gp-input-source-select').addEventListener('change', e => {
    cfg.inputSource = e.target.value;
    saveCfg();
    scheduleRestart();
  });

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

  document.getElementById('gp-advanced-hdr').addEventListener('click', () => {
    cfg.advancedOpen = !cfg.advancedOpen;
    applyAdvancedState();
    saveCfg();
  });
  applyAdvancedState();

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
  function applyMuteState() {
    muteBtn.innerHTML = cfg.muted ? ICONS.micOff : ICONS.mic;
    muteBtn.title = cfg.muted ? 'Unmute input' : 'Mute input';
    muteBtn.classList.toggle('active', cfg.muted);
  }
  applyMuteState();
  muteBtn.addEventListener('click', () => {
    cfg.muted = !cfg.muted;
    applyMuteState();
    saveCfg();
    invoke('live_input_set_mute', { muted: cfg.muted }).catch(() => {});
  });

  // Add plugin
  document.getElementById('gp-add-plugin-btn').addEventListener('click', addPlugin);

  // Global bypass
  document.getElementById('gp-global-bypass-btn').addEventListener('click', toggleGlobalBypass);

  // Preset controls
  document.getElementById('gp-preset-save-btn').addEventListener('click', savePreset);
  document.getElementById('gp-preset-load-btn').addEventListener('click', loadPreset);
  document.getElementById('gp-preset-delete-btn').addEventListener('click', deletePreset);
  document.getElementById('gp-preset-select').addEventListener('change', e => {
    const hasVal = !!e.target.value;
    document.getElementById('gp-preset-load-btn').disabled = !hasVal;
    document.getElementById('gp-preset-delete-btn').disabled = !hasVal;
  });

  // Latency event from Rust — update per-plugin display
  listen('vst_latency', evt => {
    const { index, latency_ms } = evt.payload ?? {};
    if (typeof index === 'number' && typeof latency_ms === 'number') {
      if (cfg.plugins[index]) {
        cfg.plugins[index].latency_ms = latency_ms;
        saveCfg();
      }
      const el = document.querySelector(`[data-latency-index="${index}"]`);
      if (el) el.textContent = `${latency_ms.toFixed(1)} ms`;
      updateTotalLatency();
    }
  }).catch(() => {});

  // Refresh button
  const refreshBtn = document.getElementById('gp-refresh-btn');
  refreshBtn.innerHTML = ICONS.refresh;
  refreshBtn.addEventListener('click', async () => {
    const prev = cfg.deviceName;
    refreshBtn.classList.add('spinning');
    refreshBtn.disabled = true;
    await refreshDevices();
    const sel = document.getElementById('gp-device-select');
    if (prev && [...sel.options].some(o => o.value === prev)) {
      sel.value = prev;
      cfg.deviceName = prev;
    }
    refreshBtn.classList.remove('spinning');
    refreshBtn.disabled = false;
  });

  // Initial render
  renderPluginList();
  updateSignalPath();
  updateTotalLatency();
  loadPresets();

  // Auto-start stream after device list is ready
  refreshDevices().then(async () => {
    if (cfg.deviceName && !running) await startInput();
  });

  // Auto-reload last session's plugin chain — incremental so user sees each plugin as it loads.
  if (cfg.plugins.length > 0) {
    const savedPlugins = cfg.plugins.slice();
    cfg.plugins = [];
    isReloading = true;
    const addBtn = document.getElementById('gp-add-plugin-btn');
    if (addBtn) addBtn.disabled = true;
    renderPluginList();
    (async () => {
      for (const p of savedPlugins) {
        try {
          await invoke('vst_load', { path: p.path, sampleRate: cfg.sampleRate, index: null });
          const entry = { ...p, latency_ms: p.latency_ms ?? 0 };
          cfg.plugins.push(entry);
          if (p.bypassed) {
            await invoke('vst_bypass', { index: cfg.plugins.length - 1, bypassed: true }).catch(() => {});
          }
          saveCfg();
          renderPluginList();
          updateSignalPath();
          updateTotalLatency();
        } catch (_) {
          console.warn('[guitar] auto-reload failed for', p.path);
        }
      }
      isReloading = false;
      if (addBtn) addBtn.disabled = false;
      if (cfg.plugins.length > 0) notify(`${cfg.plugins.length} plugin(s) reloaded`, 'success');
    })();
  }

  if (cfg.globalBypassed) {
    invoke('vst_global_bypass', { bypassed: true }).catch(() => {});
  }

  // Hot-plug device poll while Guitar panel is active and stream is stopped
  function startDevicePoll() {
    if (devicePollTimer) return;
    devicePollTimer = setInterval(() => { if (!running) refreshDevices(); }, 5000);
  }
  function stopDevicePoll() {
    if (devicePollTimer) { clearInterval(devicePollTimer); devicePollTimer = null; }
  }

  document.querySelector('.nav-item[data-panel="guitar"]')?.addEventListener('click', () => {
    refreshDevices();
    startDevicePoll();
  });
  document.querySelectorAll('.nav-item:not([data-panel="guitar"])').forEach(item => {
    item.addEventListener('click', stopDevicePoll);
  });
}
