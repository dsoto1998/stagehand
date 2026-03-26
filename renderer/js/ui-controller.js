// ─── UI CONTROLLER ───────────────────────────────────────────
import { resume, setMasterVolume } from './audio-engine.js';
import * as LibraryManager from './library-manager.js';
import { TrackPlayer, players } from './track-player.js';
import { Metronome, TapTempo } from './metronome.js';
import { renderWaveform } from './waveform.js';

// ─── VIRTUAL SCROLL STATE ─────────────────────────────────────
const ROW_H = 50;       // px — must match CSS .track-row height
const OVERSCAN = 5;     // extra rows above/below viewport
let activeTab = 'songs'; // 'songs' | 'artists' | 'playlists'
let currentArtistView = null; // null = artist list, string = drill-down artist name
let renamingActive = false;   // guards scroll re-renders during inline rename

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

function readTags(file) {
  return new Promise(resolve => {
    if (typeof jsmediatags === 'undefined') { resolve({}); return; }
    jsmediatags.read(file, {
      onSuccess(result) { resolve(result.tags || {}); },
      onError()         { resolve({}); }
    });
  });
}


// ─── MINIPLAYER ───────────────────────────────────────────────
let currentPlayingId = null;
let seeking = false;
let seekFrac = 0;

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
  document.getElementById('mp-play').setAttribute('aria-label', 'Pause');
  const player = players[trackId];
  const totalStr = player && player.duration ? formatTime(player.duration) : '--:--';
  document.getElementById('mp-time-display').textContent = '0:00 / ' + totalStr;
  document.getElementById('mp-scrub-fill').style.width = '0%';
}

function hideMiniplayer() {
  currentPlayingId = null;
  document.getElementById('mp-track-name').textContent = '—';
  document.getElementById('mp-play').textContent = '▶';
  document.getElementById('mp-play').setAttribute('aria-label', 'Play');
  document.getElementById('mp-semitones').value = 0;
  const mpStVal = document.getElementById('mp-semitones-val');
  mpStVal.textContent = '0st';
  mpStVal.style.color = 'var(--text-dim)';
  document.getElementById('mp-time-display').textContent = '0:00 / --:--';
  document.getElementById('mp-scrub-fill').style.width = '0%';
}

function syncMiniplayerPlayBtn(isPlaying) {
  const btn = document.getElementById('mp-play');
  btn.textContent = isPlaying ? '⏸' : '▶';
  btn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
}

function updateMiniplayerProgress(frac, t, duration) {
  if (!seeking) {
    document.getElementById('mp-scrub-fill').style.width = (frac * 100).toFixed(2) + '%';
  }
  document.getElementById('mp-time-display').textContent =
    formatTime(t) + ' / ' + formatTime(duration);
}

document.getElementById('mp-play').addEventListener('click', () => {
  if (!currentPlayingId) {
    if (tracks.length === 0) return;
    const sorted = [...tracks].sort((a, b) => a.name.localeCompare(b.name));
    playTrack(sorted[0].id);
    return;
  }
  const player = players[currentPlayingId];
  if (!player) return;
  if (player.isPlaying) {
    player.pause();
    syncMiniplayerPlayBtn(false);
    renderCurrentTab();
  } else {
    playTrack(currentPlayingId);
  }
});

document.getElementById('mp-prev').addEventListener('click', () => {
  if (!currentPlayingId) return;
  const currentPlayer = players[currentPlayingId];
  if (currentPlayer && currentPlayer.currentTime >= 3) {
    currentPlayer.seek(0);
    return;
  }
  if (tracks.length < 2) return;
  const idx = tracks.findIndex(t => t.id === currentPlayingId);
  const prev = tracks[(idx - 1 + tracks.length) % tracks.length];
  const targetPlayer = players[prev.id];
  if (targetPlayer) targetPlayer.pauseOffset = 0;
  playTrack(prev.id);
});

document.getElementById('mp-next').addEventListener('click', () => {
  if (!currentPlayingId || tracks.length < 2) return;
  const idx = tracks.findIndex(t => t.id === currentPlayingId);
  const next = tracks[(idx + 1) % tracks.length];
  const targetPlayer = players[next.id];
  if (targetPlayer) targetPlayer.pauseOffset = 0;
  playTrack(next.id);
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
});

document.getElementById('mp-vol').addEventListener('input', function() {
  setMasterVolume(this.value / 100);
  document.getElementById('mp-vol-val').textContent = this.value + '%';
});

// ─── SCRUB BAR ──────────────────────────────────────────────
const mpScrubBar = document.getElementById('mp-scrub-bar');
const mpScrubFill = document.getElementById('mp-scrub-fill');

function onScrubMove(e) {
  const rect = mpScrubBar.getBoundingClientRect();
  seekFrac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  mpScrubFill.style.width = (seekFrac * 100).toFixed(2) + '%';
}

function onScrubUp() {
  document.removeEventListener('mousemove', onScrubMove);
  document.removeEventListener('mouseup', onScrubUp);
  seeking = false;
  if (currentPlayingId && players[currentPlayingId]) {
    players[currentPlayingId].seek(seekFrac);
  }
}

mpScrubBar.addEventListener('mousedown', e => {
  if (!currentPlayingId) return;
  seeking = true;
  const rect = mpScrubBar.getBoundingClientRect();
  seekFrac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  mpScrubFill.style.width = (seekFrac * 100).toFixed(2) + '%';
  document.addEventListener('mousemove', onScrubMove);
  document.addEventListener('mouseup', onScrubUp);
});


// ─── LIBRARY STATE ───────────────────────────────────────────
let tracks = []; // [{id, name, size, format, semitones, volume, arrayBuffer, duration, artist, album, title}]

async function loadLibrary() {
  try {
    const stored = await LibraryManager.all();
    tracks = stored;
    // Initialize players eagerly for all loaded tracks
    tracks.forEach(t => {
      if (!players[t.id]) {
        players[t.id] = new TrackPlayer(t.id);
        players[t.id].semitones = t.semitones || 0;
        players[t.id].volume = t.volume !== undefined ? t.volume : 1.0;
      }
    });
    // Start background buffer loads (non-blocking)
    tracks.forEach(t => {
      const player = players[t.id];
      if (!player.buffer && t.arrayBuffer) {
        const abCopy = t.arrayBuffer.slice ? t.arrayBuffer.slice(0) : t.arrayBuffer;
        player.loadBuffer(abCopy).then(() => {
          if (!t.duration) {
            t.duration = player.duration;
            saveTrackMeta(t);
          }
        }).catch(e => console.warn('Background load failed:', t.name, e));
      }
    });
    renderCurrentTab();
  } catch(e) {
    console.warn('IndexedDB load failed:', e);
    tracks = [];
    renderCurrentTab();
  }
}

// ─── PLAY TRACK ───────────────────────────────────────────────
async function playTrack(id) {
  resume();
  const track = tracks.find(t => t.id === id);
  if (!track) return;

  if (!players[id]) {
    players[id] = new TrackPlayer(id);
    players[id].semitones = track.semitones || 0;
    players[id].volume = track.volume !== undefined ? track.volume : 1.0;
  }
  const player = players[id];

  // If already playing this track, toggle pause
  if (player.isPlaying) {
    player.pause();
    syncMiniplayerPlayBtn(false);
    renderCurrentTab(); // update row highlight
    return;
  }

  // Load buffer if needed
  if (!player.buffer) {
    if (!track.arrayBuffer) {
      notify('Audio data missing — try re-importing the file', 'error');
      return;
    }
    try {
      await player.loadBuffer(track.arrayBuffer.slice(0));
      if (!track.duration) {
        track.duration = player.duration;
        saveTrackMeta(track);
      }
    } catch(e) {
      console.error('Buffer decode failed:', e);
      notify('Could not decode audio: ' + (e.message || 'unsupported format'), 'error');
      return;
    }
  }

  // Stop other players
  Object.entries(players).forEach(([pid, p]) => {
    if (pid !== id && p.isPlaying) p.pause();
  });

  // Wire progress and end callbacks
  player.onProgress = (frac, t) => {
    if (currentPlayingId === id) {
      updateMiniplayerProgress(frac, t, player.duration);
    }
  };
  player.onEnd = () => {
    if (currentPlayingId === id) hideMiniplayer();
    renderCurrentTab(); // remove playing highlight
  };

  try {
    player.pauseOffset = 0; // always start from beginning on row click
    await player.play();
    showMiniplayer(id);
    renderCurrentTab(); // add playing highlight
  } catch(e) {
    console.error('Playback failed:', e);
    notify('Playback error: ' + (e.message || 'unknown'), 'error');
  }
}

// ─── ROW BUILDER ─────────────────────────────────────────────
function buildTrackRow(track) {
  const row = document.createElement('div');
  row.className = 'track-row' + (track.id === currentPlayingId ? ' playing' : '');
  row.dataset.id = track.id;
  row.style.height = ROW_H + 'px';

  const artist = track.artist || '';
  const album  = track.album  || '';
  const sub    = [artist, album].filter(Boolean).join(' \u00B7 ');
  const dur    = track.duration ? formatTime(track.duration) : '--:--';
  const st     = track.semitones || 0;
  const stLabel = st > 0 ? `+${st}` : `${st}`;

  row.innerHTML = `
    <div class="row-play-indicator"></div>
    <div class="row-info">
      <div class="row-name">${escHtml(track.name)}</div>
      ${sub ? `<div class="row-sub">${escHtml(sub)}</div>` : ''}
    </div>
    <div class="row-xpose">
      <button class="xpose-btn xpose-dec" data-id="${escHtml(track.id)}">−</button>
      <span class="xpose-val${st !== 0 ? ' xpose-active' : ''}">${stLabel}</span>
      <button class="xpose-btn xpose-inc" data-id="${escHtml(track.id)}">+</button>
    </div>
    <div class="row-dur">${escHtml(dur)}</div>
  `;
  return row;
}

function applyTranspose(id, newSemitones) {
  const track = tracks.find(t => t.id === id);
  if (!track) return;
  track.semitones = Math.max(-12, Math.min(12, newSemitones));
  players[id]?.setSemitones(track.semitones);
  saveTrackMeta(track);
  if (id === currentPlayingId) {
    const slider = document.getElementById('mp-semitones');
    const valEl  = document.getElementById('mp-semitones-val');
    if (slider) slider.value = track.semitones;
    if (valEl)  valEl.textContent = (track.semitones > 0 ? '+' : '') + track.semitones + 'st';
  }
  renderCurrentTab();
}

// ─── VIRTUAL SCROLL ENGINE ────────────────────────────────────
function renderVirtualList(container, items, renderRowFn) {
  if (renamingActive) return; // don't destroy DOM during rename
  const viewportH = container.clientHeight;
  const scrollTop = container.scrollTop;

  const firstIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const lastIdx  = Math.min(items.length - 1, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);

  const spacerTop = document.createElement('div');
  spacerTop.style.height = (firstIdx * ROW_H) + 'px';

  const spacerBot = document.createElement('div');
  spacerBot.style.height = (Math.max(0, items.length - 1 - lastIdx) * ROW_H) + 'px';

  container.innerHTML = '';
  container.appendChild(spacerTop);
  for (let i = firstIdx; i <= lastIdx; i++) {
    container.appendChild(renderRowFn(items[i], i));
  }
  container.appendChild(spacerBot);
}

// ─── ARTIST GROUPING ─────────────────────────────────────────
function getArtistGroups() {
  const map = new Map();
  tracks.forEach(t => {
    const key = (t.artist && t.artist.trim()) ? t.artist.trim() : 'Unknown Artist';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  });
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function buildArtistRow(artistName, trackCount) {
  const row = document.createElement('div');
  row.className = 'artist-row';
  row.dataset.artist = artistName;
  row.style.height = ROW_H + 'px';
  row.innerHTML = `
    <div class="artist-row-name">${escHtml(artistName)}</div>
    <div class="artist-row-count">${trackCount} track${trackCount !== 1 ? 's' : ''}</div>
  `;
  return row;
}

// ─── TAB RENDERERS ───────────────────────────────────────────
function renderSongsTab() {
  const trackList = document.getElementById('track-list');
  if (tracks.length === 0) {
    trackList.innerHTML = `<div class="lib-empty-state">
      <div class="es-icon">\u25C8</div>
      <div class="es-text">No tracks yet</div>
      <div class="es-sub">Import audio files to get started</div>
    </div>`;
    return;
  }
  renderVirtualList(trackList, tracks, buildTrackRow);
}

function renderArtistList() {
  const trackList = document.getElementById('track-list');
  const groups = getArtistGroups();

  if (groups.length === 0) {
    trackList.innerHTML = `<div class="lib-empty-state">
      <div class="es-icon">\u25C8</div>
      <div class="es-text">No artists</div>
      <div class="es-sub">Import tracks with artist tags</div>
    </div>`;
    return;
  }

  const artistItems = groups.map(([name, trks]) => ({ name, count: trks.length }));
  renderVirtualList(trackList, artistItems, (item) => buildArtistRow(item.name, item.count));
}

function renderArtistDrillDown(artistName) {
  const trackList = document.getElementById('track-list');
  const groups = getArtistGroups();
  const entry = groups.find(([name]) => name === artistName);
  const artistTracks = entry ? entry[1] : [];

  // Build header with back button
  const header = document.createElement('div');
  header.className = 'artist-drill-header';
  header.innerHTML = `
    <button class="artist-back-btn">\u2190</button>
    <div class="artist-drill-title">${escHtml(artistName)}</div>
    <div class="artist-drill-count">${artistTracks.length} track${artistTracks.length !== 1 ? 's' : ''}</div>
  `;

  trackList.innerHTML = '';
  trackList.appendChild(header);

  if (artistTracks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'lib-empty-state';
    empty.innerHTML = `<div class="es-text">No tracks</div>`;
    trackList.appendChild(empty);
    return;
  }

  // Sub-container for virtual list so header stays fixed at top
  const listContainer = document.createElement('div');
  listContainer.className = 'artist-track-list';
  trackList.appendChild(listContainer);

  // Make trackList flex so header + scrollable list stack
  trackList.style.display = 'flex';
  trackList.style.flexDirection = 'column';

  renderVirtualList(listContainer, artistTracks, buildTrackRow);

  // Scroll listener for the drill-down sub-container
  let drillRafPending = false;
  listContainer.addEventListener('scroll', () => {
    if (drillRafPending) return;
    drillRafPending = true;
    requestAnimationFrame(() => {
      drillRafPending = false;
      renderVirtualList(listContainer, artistTracks, buildTrackRow);
    });
  });
}

function renderArtistsTab() {
  if (currentArtistView === null) {
    renderArtistList();
  } else {
    renderArtistDrillDown(currentArtistView);
  }
}

function renderPlaylistsTab() {
  const trackList = document.getElementById('track-list');
  trackList.innerHTML = `<div class="lib-empty-state">
    <div class="es-icon">\u266B</div>
    <div class="es-text">No playlists yet</div>
    <div class="es-sub">Playlists coming soon</div>
  </div>`;
}

function renderCurrentTab() {
  const trackList = document.getElementById('track-list');
  // Reset any inline flex from artist drill-down before re-rendering
  trackList.style.display = '';
  trackList.style.flexDirection = '';

  const badge = document.getElementById('lib-badge');
  const countLabel = document.getElementById('lib-count-label');
  badge.textContent = tracks.length;
  countLabel.textContent = tracks.length + ' track' + (tracks.length !== 1 ? 's' : '');

  if (activeTab === 'songs') renderSongsTab();
  else if (activeTab === 'artists') renderArtistsTab();
  else if (activeTab === 'playlists') renderPlaylistsTab();
}

function renderTrackList() {
  renderCurrentTab();
}

// ─── RENAME & DELETE ─────────────────────────────────────────
function startRenameById(trackId) {
  const row = trackList.querySelector(`.track-row[data-id="${trackId}"]`);
  if (!row) return;
  const track = tracks.find(t => t.id === trackId);
  if (!track) return;

  renamingActive = true;
  const nameEl = row.querySelector('.row-name');
  const input = document.createElement('input');
  input.className = 'row-name-input';
  input.value = track.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  function commit() {
    renamingActive = false;
    const newName = input.value.trim() || track.name;
    track.name = newName;
    saveTrackMeta(track);
    renderCurrentTab();
    if (currentPlayingId === trackId) {
      document.getElementById('mp-track-name').textContent = newName;
    }
    notify('Renamed to "' + newName + '"', 'success');
  }
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = track.name; input.blur(); }
  });
}

async function deleteTrackById(trackId) {
  const track = tracks.find(t => t.id === trackId);
  if (!track) return;
  const yes = await confirm('Delete Track', `Remove "${track.name}" from your library? This cannot be undone.`);
  if (!yes) return;
  const player = players[trackId];
  if (player) player.stop();
  if (currentPlayingId === trackId) hideMiniplayer();
  delete players[trackId];
  await LibraryManager.remove(trackId);
  tracks = tracks.filter(t => t.id !== trackId);
  renderCurrentTab();
  notify('Track deleted', '');
}

async function saveTrackMeta(track) {
  try {
    const { arrayBuffer, ...meta } = track;
    await LibraryManager.saveMeta(meta);
  } catch(e) { console.warn('Save failed:', e); }
}

// File import
async function importFiles(files) {
  const validFiles = [...files].filter(f =>
    ['wav','mp3','flac','ogg','opus'].includes(f.name.split('.').pop().toLowerCase())
  );
  if (validFiles.length === 0) return;

  let added = 0;
  // Read all files in parallel — each track appears as soon as its data is ready
  await Promise.all(validFiles.map(async file => {
    const ext = file.name.split('.').pop().toLowerCase();
    // Tags and ArrayBuffer read concurrently per file
    const [tags, ab] = await Promise.all([readTags(file), file.arrayBuffer()]);
    const id = LibraryManager.genId();
    // IndexedDB structured clone TRANSFERS the ArrayBuffer — keep a separate copy
    const abForMemory = ab.slice(0);
    const trackForDB = {
      id,
      name: file.name.replace(/\.[^.]+$/, ''),
      format: ext.toUpperCase(),
      size: file.size,
      semitones: 0,
      volume: 1.0,
      artist: tags.artist || '',
      album: tags.album || '',
      title: tags.title || '',
      duration: 0,
      arrayBuffer: ab,
      addedAt: Date.now()
    };
    const trackForMemory = { ...trackForDB, arrayBuffer: abForMemory };

    // IDB save is fire-and-forget — don't await it
    LibraryManager.save(trackForDB).catch(e => {
      console.warn('Error saving track:', e);
      notify('Failed to save "' + trackForDB.name + '"', 'error');
    });

    tracks.push(trackForMemory);
    players[id] = new TrackPlayer(id);
    players[id].semitones = 0;
    players[id].volume = 1.0;

    // Background decode to populate duration
    players[id].loadBuffer(abForMemory.slice(0)).then(() => {
      if (!trackForMemory.duration) {
        trackForMemory.duration = players[id].duration;
        saveTrackMeta(trackForMemory);
        renderTrackList(); // refresh to show duration
      }
    }).catch(e => console.warn('Background load failed:', trackForMemory.name, e));

    added++;
    renderTrackList(); // show track immediately
  }));

  if (added > 0) notify(`Imported ${added} track${added > 1 ? 's' : ''}`, 'success');
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


// ─── TAB SWITCHING ───────────────────────────────────────────
document.querySelectorAll('.lib-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.lib-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeTab = btn.dataset.tab;
    if (activeTab !== 'artists') currentArtistView = null;
    renderCurrentTab();
  });
});

// ─── TRACK LIST (declared here for use in startRenameById) ───
const trackList = document.getElementById('track-list');

// ─── VIRTUAL SCROLL LISTENER ─────────────────────────────────
let rafPending = false;
trackList.addEventListener('scroll', () => {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    if (activeTab === 'songs') {
      renderVirtualList(trackList, tracks, buildTrackRow);
    } else if (activeTab === 'artists' && currentArtistView === null) {
      const groups = getArtistGroups();
      const artistItems = groups.map(([name, trks]) => ({ name, count: trks.length }));
      renderVirtualList(trackList, artistItems, (item) => buildArtistRow(item.name, item.count));
    }
    // artist drill-down has its own scroll listener on the sub-container
  });
});

// ─── EVENT DELEGATION: ROW CLICK + CONTEXT MENU ──────────────
trackList.addEventListener('click', e => {
  // Artist row click -> drill down
  const artistRow = e.target.closest('.artist-row[data-artist]');
  if (artistRow) {
    currentArtistView = artistRow.dataset.artist;
    renderCurrentTab();
    return;
  }

  // Back button in artist drill-down -> return to artist list
  const backBtn = e.target.closest('.artist-back-btn');
  if (backBtn) {
    currentArtistView = null;
    renderCurrentTab();
    return;
  }

  // Transpose dec/inc buttons — must check before track-row click
  const xdec = e.target.closest('.xpose-dec');
  if (xdec) {
    e.stopPropagation();
    const t = tracks.find(x => x.id === xdec.dataset.id);
    if (t) applyTranspose(t.id, (t.semitones || 0) - 1);
    return;
  }
  const xinc = e.target.closest('.xpose-inc');
  if (xinc) {
    e.stopPropagation();
    const t = tracks.find(x => x.id === xinc.dataset.id);
    if (t) applyTranspose(t.id, (t.semitones || 0) + 1);
    return;
  }

  // Track row click -> play
  const row = e.target.closest('.track-row[data-id]');
  if (!row) return;
  playTrack(row.dataset.id);
});

trackList.addEventListener('contextmenu', e => {
  const row = e.target.closest('.track-row[data-id]');
  if (!row) return;
  showCtxMenu(e, row.dataset.id);
});

// ─── CONTEXT MENU ────────────────────────────────────────────
let ctxMenuTrackId = null;
const ctxMenu = document.getElementById('ctx-menu');

function showCtxMenu(e, trackId) {
  e.preventDefault();
  ctxMenuTrackId = trackId;
  const x = Math.min(e.clientX, window.innerWidth - 140);
  const y = Math.min(e.clientY, window.innerHeight - 70);
  ctxMenu.style.left = x + 'px';
  ctxMenu.style.top  = y + 'px';
  ctxMenu.classList.add('show');
}

document.addEventListener('click', () => ctxMenu.classList.remove('show'));
document.addEventListener('contextmenu', e => {
  if (!e.target.closest('.track-row')) ctxMenu.classList.remove('show');
});
trackList.addEventListener('scroll', () => ctxMenu.classList.remove('show'));

ctxMenu.addEventListener('click', e => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action || !ctxMenuTrackId) return;
  ctxMenu.classList.remove('show');
  if (action === 'rename') startRenameById(ctxMenuTrackId);
  if (action === 'delete') deleteTrackById(ctxMenuTrackId);
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
