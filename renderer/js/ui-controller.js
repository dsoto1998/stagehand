// ─── UI CONTROLLER ───────────────────────────────────────────
import { resume, setMasterVolume } from './audio-engine.js';
import * as LibraryManager from './library-manager.js';
import { TrackPlayer, players } from './track-player.js';
import { Metronome, TapTempo } from './metronome.js';
import { renderWaveform } from './waveform.js';


// ─── UTILITY ─────────────────────────────────────────────────
function formatTime(sec) {
  if (!isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2,'0')}`;
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024*1024)).toFixed(1) + ' MB';
}

let notifTimer = null;
function notify(msg, type = '') {
  const el = document.getElementById('notif');
  el.textContent = msg;
  el.className = 'show ' + type;
  clearTimeout(notifTimer);
  notifTimer = setTimeout(() => { el.className = ''; }, 2800);
}

function confirm(title, msg) {
  return new Promise(res => {
    document.getElementById('conf-title').textContent = title;
    document.getElementById('conf-msg').textContent = msg;
    const overlay = document.getElementById('confirm-overlay');
    overlay.classList.add('show');
    const ok = document.getElementById('conf-ok');
    const cancel = document.getElementById('conf-cancel');
    function cleanup(v) {
      overlay.classList.remove('show');
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      res(v);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
  });
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}


// ─── MINIPLAYER ───────────────────────────────────────────────
let currentPlayingId = null;

function showMiniplayer(trackId) {
  const track = tracks.find(t => t.id === trackId);
  if (!track) return;
  currentPlayingId = trackId;
  document.getElementById('mp-track-name').textContent = track.name;
  const st = track.semitones || 0;
  document.getElementById('mp-semitones').value = st;
  const mpStVal = document.getElementById('mp-semitones-val');
  mpStVal.textContent = (st > 0 ? '+' : '') + st + 'st';
  mpStVal.style.color = st === 0 ? 'var(--text-dim)' : 'var(--cyan)';
  document.getElementById('mp-play').textContent = '⏸';
}

function hideMiniplayer() {
  currentPlayingId = null;
  document.getElementById('mp-track-name').textContent = '—';
  document.getElementById('mp-play').textContent = '▶';
  document.getElementById('mp-semitones').value = 0;
  const mpStVal = document.getElementById('mp-semitones-val');
  mpStVal.textContent = '0st';
  mpStVal.style.color = 'var(--text-dim)';
}

function syncMiniplayerPlayBtn(isPlaying) {
  document.getElementById('mp-play').textContent = isPlaying ? '⏸' : '▶';
}

document.getElementById('mp-play').addEventListener('click', () => {
  if (!currentPlayingId) return;
  const player = players[currentPlayingId];
  const card = document.getElementById('card-' + currentPlayingId);
  if (!player || !card) return;
  if (player.isPlaying) {
    player.pause();
    card.classList.remove('playing');
    card.querySelector('.track-play-btn').textContent = '▶';
    syncMiniplayerPlayBtn(false);
  } else {
    card.querySelector('.track-play-btn').click();
  }
});

document.getElementById('mp-prev').addEventListener('click', () => {
  if (!currentPlayingId || tracks.length < 2) return;
  const idx = tracks.findIndex(t => t.id === currentPlayingId);
  const prev = tracks[(idx - 1 + tracks.length) % tracks.length];
  const targetPlayer = players[prev.id];
  if (targetPlayer) targetPlayer.pauseOffset = 0;
  const card = document.getElementById('card-' + prev.id);
  if (card) card.querySelector('.track-play-btn').click();
});

document.getElementById('mp-next').addEventListener('click', () => {
  if (!currentPlayingId || tracks.length < 2) return;
  const idx = tracks.findIndex(t => t.id === currentPlayingId);
  const next = tracks[(idx + 1) % tracks.length];
  const targetPlayer = players[next.id];
  if (targetPlayer) targetPlayer.pauseOffset = 0;
  const card = document.getElementById('card-' + next.id);
  if (card) card.querySelector('.track-play-btn').click();
});

document.getElementById('mp-semitones').addEventListener('input', function() {
  if (!currentPlayingId) return;
  const s = parseInt(this.value);
  const player = players[currentPlayingId];
  const track = tracks.find(t => t.id === currentPlayingId);
  if (player) player.setSemitones(s);
  if (track) { track.semitones = s; saveTrackMeta(track); }
  const mpVal = document.getElementById('mp-semitones-val');
  mpVal.textContent = (s > 0 ? '+' : '') + s + 'st';
  mpVal.style.color = s === 0 ? 'var(--text-dim)' : 'var(--cyan)';
  const card = document.getElementById('card-' + currentPlayingId);
  if (card) {
    const cardSt = card.querySelector('.track-semitones');
    const cardStVal = card.querySelector('.semitone-display');
    if (cardSt) cardSt.value = s;
    if (cardStVal) { cardStVal.textContent = (s > 0 ? '+' : '') + s + 'st'; cardStVal.style.color = s === 0 ? 'var(--text-dim)' : 'var(--cyan)'; }
  }
});

document.getElementById('mp-vol').addEventListener('input', function() {
  setMasterVolume(this.value / 100);
  document.getElementById('mp-vol-val').textContent = this.value + '%';
});


// ─── LIBRARY STATE ───────────────────────────────────────────
let tracks = []; // [{id, name, size, format, semitones, volume, arrayBuffer, duration}]

async function loadLibrary() {
  try {
    const stored = await LibraryManager.all();
    tracks = stored;
    renderTrackList();
  } catch(e) {
    console.warn('IndexedDB load failed:', e);
    tracks = [];
    renderTrackList();
  }
}

function renderTrackList() {
  const list = document.getElementById('track-list');
  const badge = document.getElementById('lib-badge');
  const countLabel = document.getElementById('lib-count-label');
  const empty = document.getElementById('empty-state');

  badge.textContent = tracks.length;
  countLabel.textContent = tracks.length + ' track' + (tracks.length !== 1 ? 's' : '');

  // Remove old track cards
  list.querySelectorAll('.track-card').forEach(el => el.remove());

  if (tracks.length === 0) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  tracks.forEach(track => {
    const card = buildTrackCard(track);
    list.appendChild(card);
  });
}

function buildTrackCard(track) {
  const card = document.createElement('div');
  card.className = 'track-card';
  card.id = 'card-' + track.id;

  if (!players[track.id]) {
    players[track.id] = new TrackPlayer(track.id);
  }
  const player = players[track.id];
  player.semitones = track.semitones || 0;
  player.volume = track.volume !== undefined ? track.volume : 1.0;

  card.innerHTML = `
    <div class="track-top">
      <button class="track-play-btn" title="Play/Pause">▶</button>
      <div class="track-info">
        <div class="track-name" title="Click to rename">${escHtml(track.name)}</div>
        <div class="track-meta">${track.format || ''} · ${formatSize(track.size || 0)} · <span class="dur-val">--:--</span></div>
      </div>
      <div class="track-actions">
        <button class="btn btn-sm btn-danger" title="Delete">✕</button>
      </div>
    </div>
    <div class="waveform-container">
      <canvas class="waveform-canvas"></canvas>
      <div class="waveform-progress"></div>
    </div>
    <div class="track-controls">
      <div class="ctrl-group wide">
        <div class="ctrl-label"><span>Volume</span><span class="ctrl-val">${Math.round((track.volume||1)*100)}%</span></div>
        <input type="range" class="track-vol" min="0" max="100" value="${Math.round((track.volume||1)*100)}">
      </div>
      <div class="ctrl-group">
        <div class="ctrl-label"><span>Transpose</span><span class="semitone-display">${(track.semitones||0) > 0 ? '+' : ''}${track.semitones||0}st</span></div>
        <input type="range" class="track-semitones" min="-12" max="12" value="${track.semitones||0}">
      </div>
      <div class="time-display">
        <span class="cur-time">0:00</span> / <span class="tot-time">--:--</span>
      </div>
    </div>
  `;

  const playBtn   = card.querySelector('.track-play-btn');
  const delBtn    = card.querySelector('.btn-danger');
  const nameEl    = card.querySelector('.track-name');
  const volSlider = card.querySelector('.track-vol');
  const stSlider  = card.querySelector('.track-semitones');
  const progress  = card.querySelector('.waveform-progress');
  const canvas    = card.querySelector('.waveform-canvas');
  const waveformC = card.querySelector('.waveform-container');
  const curTimeEl = card.querySelector('.cur-time');
  const totTimeEl = card.querySelector('.tot-time');
  const durValEl  = card.querySelector('.dur-val');
  const volValEl  = card.querySelector('.ctrl-val');
  const stValEl   = card.querySelector('.semitone-display');

  // Load buffer eagerly in background if arrayBuffer is available
  if (!player.buffer && track.arrayBuffer) {
    // Use a fresh slice so we don't detach the stored reference
    const abCopy = track.arrayBuffer.slice ? track.arrayBuffer.slice(0) : track.arrayBuffer;
    player.loadBuffer(abCopy).then(() => {
      renderWaveform(canvas, player.buffer);
      const d = formatTime(player.duration);
      totTimeEl.textContent = d;
      durValEl.textContent  = d;
    }).catch(e => {
      console.warn('Background buffer load failed for', track.name, e);
      // Not fatal — will retry on play
    });
  } else if (player.buffer) {
    requestAnimationFrame(() => {
      renderWaveform(canvas, player.buffer);
      const d = formatTime(player.duration);
      totTimeEl.textContent = d;
      durValEl.textContent  = d;
    });
  }

  // Progress callback
  player.onProgress = (frac, t) => {
    progress.style.width = (frac * 100) + '%';
    curTimeEl.textContent = formatTime(t);
  };

  player.onEnd = () => {
    card.classList.remove('playing');
    playBtn.textContent = '▶';
    progress.style.width = '0%';
    curTimeEl.textContent = '0:00';
    if (currentPlayingId === track.id) hideMiniplayer();
  };

  // Play / Pause
  playBtn.addEventListener('click', async () => {
    resume();
    if (player.isPlaying) {
      player.pause();
      card.classList.remove('playing');
      playBtn.textContent = '▶';
      if (currentPlayingId === track.id) syncMiniplayerPlayBtn(false);
      return;
    }

    // If buffer isn't loaded yet, load it now (happens on first play after cold start)
    if (!player.buffer) {
      const t = tracks.find(t => t.id === track.id);
      if (!t || !t.arrayBuffer) {
        notify('Audio data missing — try re-importing the file', 'error');
        return;
      }
      playBtn.textContent = '…';
      playBtn.disabled = true;
      try {
        await player.loadBuffer(t.arrayBuffer);
        renderWaveform(canvas, player.buffer);
        const d = formatTime(player.duration);
        totTimeEl.textContent = d;
        durValEl.textContent  = d;
      } catch(e) {
        console.error('Buffer decode failed:', e);
        notify('Could not decode audio: ' + (e.message || 'unsupported format'), 'error');
        playBtn.textContent = '▶';
        playBtn.disabled = false;
        return;
      }
      playBtn.disabled = false;
    }

    // Stop other players
    Object.entries(players).forEach(([id, p]) => {
      if (id !== track.id && p.isPlaying) {
        p.pause();
        const c = document.getElementById('card-' + id);
        if (c) {
          c.classList.remove('playing');
          c.querySelector('.track-play-btn').textContent = '▶';
        }
      }
    });

    try {
      await player.play();
      card.classList.add('playing');
      playBtn.textContent = '⏸';
      showMiniplayer(track.id);
    } catch(e) {
      console.error('Playback failed:', e);
      notify('Playback error: ' + (e.message || 'unknown'), 'error');
      playBtn.textContent = '▶';
    }
  });

  // Seek on waveform click
  waveformC.addEventListener('click', e => {
    const rect = waveformC.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    player.seek(Math.max(0, Math.min(1, frac)));
    if (player.isPlaying) {
      progress.style.width = (frac * 100) + '%';
    }
  });

  // Volume
  volSlider.addEventListener('input', () => {
    const v = volSlider.value / 100;
    player.setVolume(v);
    volValEl.textContent = volSlider.value + '%';
    const t = tracks.find(t => t.id === track.id);
    if (t) { t.volume = v; saveTrackMeta(t); }
  });

  // Semitones
  stSlider.addEventListener('input', () => {
    const s = parseInt(stSlider.value);
    player.setSemitones(s);
    stValEl.textContent = (s > 0 ? '+' : '') + s + 'st';
    stValEl.style.color = s === 0 ? 'var(--text-dim)' : 'var(--cyan)';
    const t = tracks.find(t => t.id === track.id);
    if (t) { t.semitones = s; saveTrackMeta(t); }
    if (currentPlayingId === track.id) {
      document.getElementById('mp-semitones').value = s;
      const mpVal = document.getElementById('mp-semitones-val');
      mpVal.textContent = (s > 0 ? '+' : '') + s + 'st';
      mpVal.style.color = s === 0 ? 'var(--text-dim)' : 'var(--cyan)';
    }
  });
  stValEl.style.color = (track.semitones||0) === 0 ? 'var(--text-dim)' : 'var(--cyan)';

  // Rename (click name)
  function startRename() {
    const input = document.createElement('input');
    input.className = 'track-name-input';
    input.value = track.name;
    const currentNameEl = card.querySelector('.track-name');
    currentNameEl.replaceWith(input);
    input.focus();
    input.select();
    function commit() {
      const newName = input.value.trim() || track.name;
      track.name = newName;
      const nameNew = document.createElement('div');
      nameNew.className = 'track-name';
      nameNew.title = 'Click to rename';
      nameNew.textContent = newName;
      input.replaceWith(nameNew);
      nameNew.addEventListener('click', startRename);
      saveTrackMeta(track);
      notify('Renamed to "' + newName + '"', 'success');
    }
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.value = track.name; input.blur(); }
    });
  }
  nameEl.addEventListener('click', startRename);

  // Delete
  delBtn.addEventListener('click', async () => {
    const yes = await confirm('Delete Track', `Remove "${track.name}" from your library? This cannot be undone.`);
    if (!yes) return;
    player.stop();
    if (currentPlayingId === track.id) hideMiniplayer();
    delete players[track.id];
    await LibraryManager.remove(track.id);
    tracks = tracks.filter(t => t.id !== track.id);
    renderTrackList();
    notify('Track deleted', '');
  });

  return card;
}

async function saveTrackMeta(track) {
  try {
    const { arrayBuffer, ...meta } = track;
    await LibraryManager.saveMeta(meta);
  } catch(e) { console.warn('Save failed:', e); }
}

// File import
async function importFiles(files) {
  let added = 0;
  for (const file of files) {
    const ext = file.name.split('.').pop().toLowerCase();
    const allowed = ['wav','mp3','flac','ogg','opus'];
    if (!allowed.includes(ext)) continue;

    const id = LibraryManager.genId();
    const ab = await file.arrayBuffer();

    // IndexedDB structured clone TRANSFERS the ArrayBuffer, detaching our reference.
    // Keep a separate copy for in-memory use so the stored reference isn't zeroed out.
    const abForMemory = ab.slice(0);

    const trackForDB = {
      id,
      name: file.name.replace(/\.[^.]+$/, ''),
      format: ext.toUpperCase(),
      size: file.size,
      semitones: 0,
      volume: 1.0,
      arrayBuffer: ab,       // this gets transferred/detached by IndexedDB put
      addedAt: Date.now()
    };

    const trackForMemory = {
      ...trackForDB,
      arrayBuffer: abForMemory  // fresh copy we keep in our tracks[] array
    };

    try {
      await LibraryManager.save(trackForDB);
      tracks.push(trackForMemory);
      added++;
    } catch(e) {
      console.warn('Error saving track:', e);
      notify('Failed to save "' + trackForDB.name + '"', 'error');
    }
  }
  if (added > 0) {
    renderTrackList();
    notify(`Imported ${added} track${added > 1 ? 's' : ''}`, 'success');
  }
}


// ─── NAVIGATION ──────────────────────────────────────────────
document.querySelectorAll('.nav-item[data-panel]').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    item.classList.add('active');
    const panelId = 'panel-' + item.dataset.panel;
    document.getElementById(panelId).classList.add('active');
  });
});


// ─── LIBRARY EVENT BINDINGS ───────────────────────────────────
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const importBtn = document.getElementById('import-btn');

dropZone.addEventListener('click', () => fileInput.click());
importBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  if (fileInput.files.length) importFiles(Array.from(fileInput.files));
  fileInput.value = '';
});

dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files);
  importFiles(files);
});

// ─── METRONOME EVENT BINDINGS ─────────────────────────────────
document.getElementById('bpm-minus').addEventListener('click', () => {
  Metronome.setBpm(Metronome.getBpm() - 1);
});
document.getElementById('bpm-plus').addEventListener('click', () => {
  Metronome.setBpm(Metronome.getBpm() + 1);
});

document.getElementById('bpm-input').addEventListener('change', function() {
  Metronome.setBpm(parseInt(this.value) || 120);
});
document.getElementById('bpm-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') this.blur();
});

document.getElementById('metro-play-btn').addEventListener('click', function() {
  resume();
  if (Metronome.isActive()) {
    Metronome.stop();
    this.textContent = '▶ Start';
    this.classList.remove('running');
  } else {
    Metronome.start();
    this.textContent = '⏹ Stop';
    this.classList.add('running');
  }
});

document.querySelectorAll('.subdiv-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.subdiv-btn').forEach(b => b.classList.remove('active'));
    this.classList.add('active');
    Metronome.setSubdivision(parseInt(this.dataset.subdiv));
  });
});

document.getElementById('metro-vol').addEventListener('input', function() {
  Metronome.setVolume(this.value / 100);
  document.getElementById('metro-vol-val').textContent = this.value + '%';
});

// Tap tempo
document.getElementById('tap-btn').addEventListener('click', () => {
  resume();
  const bpm = TapTempo.tap();
  const count = TapTempo.count();
  if (bpm) Metronome.setBpm(bpm);
  const countEl = document.getElementById('tap-count');
  if (count < 2) {
    countEl.textContent = 'tap again...';
  } else {
    countEl.textContent = `${count} taps · ${bpm} BPM`;
  }
});

// Custom click sound
document.getElementById('load-click-btn').addEventListener('click', () => {
  document.getElementById('click-file-input').click();
});
document.getElementById('click-file-input').addEventListener('change', async function() {
  if (!this.files[0]) return;
  const file = this.files[0];
  const ab = await file.arrayBuffer();
  const ctx = resume();
  try {
    const buf = await ctx.decodeAudioData(ab);
    Metronome.setCustomBuffer(buf);
    document.getElementById('click-sound-name').textContent = file.name;
    document.getElementById('clear-click-btn').style.display = '';
    notify('Custom click loaded', 'success');
  } catch(e) {
    notify('Could not decode audio file', 'error');
  }
  this.value = '';
});
document.getElementById('clear-click-btn').addEventListener('click', () => {
  Metronome.setCustomBuffer(null);
  document.getElementById('click-sound-name').textContent = 'Default (Synthesized)';
  document.getElementById('clear-click-btn').style.display = 'none';
});


// ─── INIT ────────────────────────────────────────────────────
(async function init() {
  Metronome.updateBeatDots(1);
  await loadLibrary();
  document.getElementById('topbar-status').textContent = 'READY';
})();
