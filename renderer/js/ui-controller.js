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

// ─── PLAYLIST STATE ───────────────────────────────────────────
let playlists = [];            // cached from IDB
let selectedPlaylistId = null; // which playlist is shown in right pane
let activePlaylistId = null;   // playlist that launched current playback (for auto-next)
let plDragSrcIndex = null;     // drag-to-reorder source index within playlist

// ─── PLAYLIST EDIT MODE ───────────────────────────────────────
let playlistEditMode = false;
let playlistEditTargetId = null;
let playlistEditSnapshot = [];   // copy of trackIds before any edits

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


// ─── SELECTION STATE ─────────────────────────────────────────
let selectedIds = new Set();
let lastSelectedIdx = -1;

// ─── MINIPLAYER ───────────────────────────────────────────────
let currentPlayingId = null;
let seeking = false;
let seekFrac = 0;

function showMiniplayer(trackId) {
  const track = tracks.find(t => t.id === trackId);
  if (!track) return;
  currentPlayingId = trackId;
  document.getElementById('mp-track-name').textContent = track.name;
  document.getElementById('mp-track-sub').textContent = (track.artist && track.album) ? track.artist + ' — ' + track.album : (track.artist || track.album || '—');
  const st = track.semitones || 0;
  const mpStVal = document.getElementById('mp-semitones-val');
  mpStVal.textContent = (st > 0 ? '+' : '') + st + 'st';
  mpStVal.classList.toggle('xpose-active', st !== 0);
  document.getElementById('mp-xpose-reset').classList.toggle('xpose-reset-visible', st !== 0);
  document.getElementById('mp-play').textContent = '⏸';
  document.getElementById('mp-play').setAttribute('aria-label', 'Pause');
  document.getElementById('mp-play').classList.add('is-paused');
  const player = players[trackId];
  const totalStr = player && player.duration ? formatTime(player.duration) : '--:--';
  document.getElementById('mp-time-display').textContent = '0:00 / ' + totalStr;
  document.getElementById('mp-scrub-fill').style.width = '0%';
}

function hideMiniplayer() {
  currentPlayingId = null;
  document.getElementById('mp-track-name').textContent = '—';
  document.getElementById('mp-track-sub').textContent = '—';
  document.getElementById('mp-play').textContent = '▶';
  document.getElementById('mp-play').setAttribute('aria-label', 'Play');
  document.getElementById('mp-play').classList.remove('is-paused');
  const mpStVal = document.getElementById('mp-semitones-val');
  mpStVal.textContent = '0st';
  mpStVal.classList.remove('xpose-active');
  document.getElementById('mp-xpose-reset').classList.remove('xpose-reset-visible');
  document.getElementById('mp-time-display').textContent = '0:00 / --:--';
  document.getElementById('mp-scrub-fill').style.width = '0%';
}

function syncMiniplayerPlayBtn(isPlaying) {
  const btn = document.getElementById('mp-play');
  btn.textContent = isPlaying ? '⏸' : '▶';
  btn.classList.toggle('is-paused', isPlaying);
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
  } else if (player.buffer && player.pauseOffset > 0) {
    // Resume from pause — don't reset offset
    player.play().then(() => {
      syncMiniplayerPlayBtn(true);
      renderCurrentTab();
    });
  } else {
    playTrack(currentPlayingId);
  }
});

// Returns the next track to auto-play when the current track ends,
// based on the active tab context at the time of the call.
function getAutoNextTrack(currentId) {
  // If playback was launched from a playlist, advance within that playlist
  if (activePlaylistId) {
    const pl = playlists.find(p => p.id === activePlaylistId);
    if (!pl) { activePlaylistId = null; return null; }
    // Use lastIndexOf so duplicate entries advance from the correct position
    const idx = pl.trackIds.lastIndexOf(currentId);
    const nextId = pl.trackIds[idx + 1];
    if (!nextId) { activePlaylistId = null; return null; }
    return tracks.find(t => t.id === nextId) || null;
  }
  let list = [];
  if (activeTab === 'songs') {
    list = tracks;
  } else if (activeTab === 'artists' && currentArtistView !== null) {
    const groups = getArtistGroups();
    const entry = groups.find(([name]) => name === currentArtistView);
    list = entry ? entry[1] : [];
  }
  if (list.length === 0) return null;
  const idx = list.findIndex(t => t.id === currentId);
  if (idx === -1 || idx === list.length - 1) return null;
  return list[idx + 1];
}

document.getElementById('mp-prev').addEventListener('click', () => {
  if (!currentPlayingId) return;
  const currentPlayer = players[currentPlayingId];
  if (currentPlayer && currentPlayer.currentTime >= 3) {
    currentPlayer.seek(0);
    return;
  }
  if (activePlaylistId) {
    const pl = playlists.find(p => p.id === activePlaylistId);
    if (pl) {
      const idx = pl.trackIds.indexOf(currentPlayingId);
      if (idx > 0) {
        const prev = tracks.find(t => t.id === pl.trackIds[idx - 1]);
        if (prev) { if (players[prev.id]) players[prev.id].pauseOffset = 0; playTrack(prev.id, activePlaylistId); return; }
      }
    }
  }
  if (tracks.length < 2) return;
  const idx = tracks.findIndex(t => t.id === currentPlayingId);
  const prev = tracks[(idx - 1 + tracks.length) % tracks.length];
  if (players[prev.id]) players[prev.id].pauseOffset = 0;
  playTrack(prev.id);
});

document.getElementById('mp-next').addEventListener('click', () => {
  if (!currentPlayingId) return;
  if (activePlaylistId) {
    const pl = playlists.find(p => p.id === activePlaylistId);
    if (pl) {
      const idx = pl.trackIds.lastIndexOf(currentPlayingId);
      const nextId = pl.trackIds[idx + 1];
      if (nextId) {
        const next = tracks.find(t => t.id === nextId);
        if (next) { if (players[next.id]) players[next.id].pauseOffset = 0; playTrack(next.id, activePlaylistId); return; }
      }
    }
  }
  if (tracks.length < 2) return;
  const idx = tracks.findIndex(t => t.id === currentPlayingId);
  const next = tracks[(idx + 1) % tracks.length];
  if (players[next.id]) players[next.id].pauseOffset = 0;
  playTrack(next.id);
});

document.getElementById('mp-xpose-dec').addEventListener('click', () => {
  if (!currentPlayingId) return;
  const track = tracks.find(t => t.id === currentPlayingId);
  if (track) applyTranspose(track.id, (track.semitones || 0) - 1);
});
document.getElementById('mp-xpose-inc').addEventListener('click', () => {
  if (!currentPlayingId) return;
  const track = tracks.find(t => t.id === currentPlayingId);
  if (track) applyTranspose(track.id, (track.semitones || 0) + 1);
});
document.getElementById('mp-xpose-reset').addEventListener('click', () => {
  if (!currentPlayingId) return;
  applyTranspose(currentPlayingId, 0);
});

const mpVolVal = document.getElementById('mp-vol-val');
let mpVolFadeTimer = null;
document.getElementById('mp-vol').addEventListener('input', function() {
  setMasterVolume(this.value / 100);
  localStorage.setItem('masterVolume', this.value);
  mpVolVal.textContent = this.value + '%';
  mpVolVal.classList.add('visible');
  if (mpVolFadeTimer) clearTimeout(mpVolFadeTimer);
});
document.getElementById('mp-vol').addEventListener('mouseup', function() {
  if (mpVolFadeTimer) clearTimeout(mpVolFadeTimer);
  mpVolFadeTimer = setTimeout(() => mpVolVal.classList.remove('visible'), 1000);
});
document.getElementById('mp-vol').addEventListener('touchend', function() {
  if (mpVolFadeTimer) clearTimeout(mpVolFadeTimer);
  mpVolFadeTimer = setTimeout(() => mpVolVal.classList.remove('visible'), 1000);
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
    const [stored, storedPlaylists] = await Promise.all([
      LibraryManager.all(),
      LibraryManager.getPlaylists()
    ]);
    tracks = stored;
    playlists = storedPlaylists;
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
async function playTrack(id, fromPlaylistId) {
  resume();
  const track = tracks.find(t => t.id === id);
  if (!track) return;

  // Track which playlist context launched this playback
  if (fromPlaylistId !== undefined) {
    activePlaylistId = fromPlaylistId || null;
  } else if (activeTab !== 'playlists') {
    activePlaylistId = null;
  }

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
    if (currentPlayingId !== id) return;
    const next = getAutoNextTrack(id);
    if (next) {
      playTrack(next.id);
    } else {
      hideMiniplayer();
      renderCurrentTab();
    }
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
  row.className = 'track-row'
    + (track.id === currentPlayingId ? ' playing' : '')
    + (selectedIds.has(track.id) ? ' selected' : '');
  row.dataset.id = track.id;
  row.style.height = ROW_H + 'px';

  const artist = track.artist || '';
  const album  = track.album  || '';
  const sub    = [artist, album].filter(Boolean).join(' \u00B7 ');
  const dur    = track.duration ? formatTime(track.duration) : '--:--';
  const st     = track.semitones || 0;
  const stLabel = st > 0 ? `+${st}` : `${st}`;

  row.innerHTML = `
    <div class="row-play-area">
      <div class="row-play-indicator"></div>
      <button class="row-play-btn" data-id="${escHtml(track.id)}">${track.id === currentPlayingId ? '⏸' : '▶'}</button>
    </div>
    <div class="row-info">
      <div class="row-name">${escHtml(track.name)}</div>
      ${sub ? `<div class="row-sub">${escHtml(sub)}</div>` : ''}
    </div>
    <div class="row-xpose">
      <button class="xpose-reset${st !== 0 ? ' xpose-reset-visible' : ''}" data-id="${escHtml(track.id)}" title="Reset transpose">↺</button>
      <button class="xpose-btn xpose-dec" data-id="${escHtml(track.id)}">−</button>
      <span class="xpose-val${st !== 0 ? ' xpose-active' : ''}">${stLabel}</span>
      <button class="xpose-btn xpose-inc" data-id="${escHtml(track.id)}">+</button>
    </div>
    <div class="row-dur">${escHtml(dur)}</div>
  `;

  if (playlistEditMode) {
    const pl = playlists.find(p => p.id === playlistEditTargetId);
    const already = pl?.trackIds.includes(track.id);
    const addBtn = document.createElement('button');
    addBtn.className = 'pl-edit-add-btn' + (already ? ' added' : '');
    addBtn.textContent = already ? '✓' : '+';
    addBtn.title = already ? 'Already in playlist' : 'Add to playlist';
    addBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (addBtn.classList.contains('added')) return;
      if (!pl) return;
      pl.trackIds.push(track.id);
      LibraryManager.savePlaylist(pl).catch(err => console.warn('Playlist save failed:', err));
      addBtn.textContent = '✓';
      addBtn.classList.add('added');
      addBtn.title = 'Already in playlist';
    });
    row.appendChild(addBtn);
  }

  return row;
}

function applyTranspose(id, newSemitones) {
  const track = tracks.find(t => t.id === id);
  if (!track) return;
  track.semitones = Math.max(-12, Math.min(12, newSemitones));
  players[id]?.setSemitones(track.semitones);
  saveTrackMeta(track);
  if (id === currentPlayingId) {
    const valEl   = document.getElementById('mp-semitones-val');
    const resetEl = document.getElementById('mp-xpose-reset');
    if (valEl)   { valEl.textContent = (track.semitones > 0 ? '+' : '') + track.semitones + 'st'; valEl.classList.toggle('xpose-active', track.semitones !== 0); }
    if (resetEl) resetEl.classList.toggle('xpose-reset-visible', track.semitones !== 0);
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

  // Build two-pane container
  const container = document.createElement('div');
  container.className = 'playlists-container';

  // ── Left pane ──────────────────────────────────────────
  const left = document.createElement('div');
  left.className = 'playlists-left';

  const listHeader = document.createElement('div');
  listHeader.className = 'pl-list-header';
  listHeader.innerHTML = `
    <span class="pl-list-header-title">Playlists</span>
    <button class="pl-new-btn" id="pl-new-btn" title="New playlist">+</button>
  `;
  left.appendChild(listHeader);

  const plList = document.createElement('div');
  plList.className = 'pl-list';
  plList.id = 'pl-list';

  if (playlists.length === 0) {
    plList.innerHTML = `<div style="padding: 16px 12px; font-family:'Barlow Condensed',sans-serif; font-size:13px; color:var(--text-dim);">No playlists yet</div>`;
  } else {
    playlists.forEach(pl => {
      plList.appendChild(buildPlaylistRow(pl));
    });
  }
  left.appendChild(plList);
  container.appendChild(left);

  // ── Right pane ─────────────────────────────────────────
  const right = document.createElement('div');
  right.className = 'playlists-right';
  right.id = 'pl-right';

  const selPl = playlists.find(p => p.id === selectedPlaylistId);
  if (selPl) {
    renderPlaylistDetail(right, selPl);
  } else {
    right.innerHTML = `<div class="pl-empty-right">← Select a playlist</div>`;
  }
  container.appendChild(right);

  trackList.innerHTML = '';
  trackList.style.display = 'flex';
  trackList.style.flexDirection = 'column';
  trackList.appendChild(container);

  // ── Bind new playlist button ───────────────────────────
  document.getElementById('pl-new-btn').addEventListener('click', createNewPlaylist);
}

function buildPlaylistRow(pl) {
  const row = document.createElement('div');
  row.className = 'pl-row' + (pl.id === selectedPlaylistId ? ' active' : '');
  row.dataset.plId = pl.id;

  const name = document.createElement('div');
  name.className = 'pl-row-name';
  name.textContent = pl.name;

  const count = document.createElement('div');
  count.className = 'pl-row-count';
  count.textContent = pl.trackIds.length;

  row.appendChild(name);
  row.appendChild(count);

  row.addEventListener('click', () => {
    selectedPlaylistId = pl.id;
    renderCurrentTab();
  });

  row.addEventListener('contextmenu', e => {
    e.preventDefault();
    showPlCtxMenu(e, pl.id);
  });

  return row;
}

function renderPlaylistDetail(container, pl) {
  // Header
  const header = document.createElement('div');
  header.className = 'pl-detail-header';
  header.innerHTML = `
    <div class="pl-detail-title">${escHtml(pl.name)}</div>
    <div class="pl-detail-count">${pl.trackIds.length} track${pl.trackIds.length !== 1 ? 's' : ''}</div>
    <button class="pl-add-tracks-btn" id="pl-add-tracks-btn">+ Add Tracks</button>
  `;
  container.appendChild(header);

  // Track list
  const listEl = document.createElement('div');
  listEl.className = 'pl-track-list';
  listEl.id = 'pl-track-list';

  if (pl.trackIds.length === 0) {
    listEl.innerHTML = `<div class="lib-empty-state"><div class="es-text">No tracks yet</div><div class="es-sub">Right-click any track → Add to Playlist</div></div>`;
  } else {
    pl.trackIds.forEach((tid, idx) => {
      const track = tracks.find(t => t.id === tid);
      if (track) listEl.appendChild(buildPlaylistTrackRow(track, idx, pl));
    });
  }
  container.appendChild(listEl);

  // Add Tracks button
  container.querySelector('#pl-add-tracks-btn').addEventListener('click', () => {
    enterPlaylistEditMode(pl);
  });
}

function buildPlaylistTrackRow(track, idx, pl) {
  const row = document.createElement('div');
  row.className = 'track-row' + (track.id === currentPlayingId && activePlaylistId === pl.id ? ' playing' : '');
  row.dataset.id = track.id;
  row.dataset.plIdx = idx;
  row.style.height = ROW_H + 'px';
  row.draggable = true;

  const artist = track.artist || '';
  const album  = track.album  || '';
  const sub    = [artist, album].filter(Boolean).join(' \u00B7 ');
  const dur    = track.duration ? formatTime(track.duration) : '--:--';
  const st     = track.semitones || 0;
  const stLabel = st > 0 ? `+${st}` : `${st}`;

  row.innerHTML = `
    <div class="drag-handle" title="Drag to reorder">⠿</div>
    <div class="row-pl-num">${idx + 1}</div>
    <div class="row-play-area">
      <div class="row-play-indicator"></div>
      <button class="row-play-btn" data-id="${escHtml(track.id)}">${(track.id === currentPlayingId && activePlaylistId === pl.id) ? '⏸' : '▶'}</button>
    </div>
    <div class="row-info">
      <div class="row-name">${escHtml(track.name)}</div>
      ${sub ? `<div class="row-sub">${escHtml(sub)}</div>` : ''}
    </div>
    <div class="row-xpose">
      <button class="xpose-reset${st !== 0 ? ' xpose-reset-visible' : ''}" data-id="${escHtml(track.id)}" title="Reset transpose">↺</button>
      <button class="xpose-btn xpose-dec" data-id="${escHtml(track.id)}">−</button>
      <span class="xpose-val${st !== 0 ? ' xpose-active' : ''}">${stLabel}</span>
      <button class="xpose-btn xpose-inc" data-id="${escHtml(track.id)}">+</button>
    </div>
    <div class="row-dur">${escHtml(dur)}</div>
    <button class="row-remove-pl" data-pl-idx="${idx}" title="Remove from playlist">×</button>
  `;

  // Drag-to-reorder bindings
  row.addEventListener('dragstart', e => {
    plDragSrcIndex = idx;
    e.dataTransfer.effectAllowed = 'move';
  });
  row.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    row.classList.remove('drag-above', 'drag-below');
    const rect = row.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height / 2) {
      row.classList.add('drag-above');
    } else {
      row.classList.add('drag-below');
    }
  });
  row.addEventListener('dragleave', () => {
    row.classList.remove('drag-above', 'drag-below');
  });
  row.addEventListener('drop', e => {
    e.preventDefault();
    row.classList.remove('drag-above', 'drag-below');
    const srcIdx = plDragSrcIndex;
    if (srcIdx === null || srcIdx === idx) return;
    const rect = row.getBoundingClientRect();
    let destIdx = idx;
    if (e.clientY >= rect.top + rect.height / 2) destIdx = idx + 1;
    // Adjust for removal of source
    const newIds = [...pl.trackIds];
    const [moved] = newIds.splice(srcIdx, 1);
    const insertAt = destIdx > srcIdx ? destIdx - 1 : destIdx;
    newIds.splice(insertAt, 0, moved);
    pl.trackIds = newIds;
    LibraryManager.savePlaylist(pl).catch(e => console.warn('Playlist save failed:', e));
    renderCurrentTab();
  });
  row.addEventListener('dragend', () => {
    plDragSrcIndex = null;
    document.querySelectorAll('.track-row').forEach(r => r.classList.remove('drag-above', 'drag-below'));
  });

  // Play button click
  row.querySelector('.row-play-btn').addEventListener('click', e => {
    e.stopPropagation();
    playTrack(track.id, pl.id);
  });

  // Double-click to play
  let plLastClickId = null, plLastClickTime = 0;
  row.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    const now = Date.now();
    if (plLastClickId === track.id && (now - plLastClickTime) < 300) {
      plLastClickId = null;
      playTrack(track.id, pl.id);
    }
    plLastClickId = track.id;
    plLastClickTime = now;
  });

  // Remove from playlist
  row.querySelector('.row-remove-pl').addEventListener('click', e => {
    e.stopPropagation();
    pl.trackIds.splice(idx, 1);
    LibraryManager.savePlaylist(pl).catch(e => console.warn('Playlist save failed:', e));
    renderCurrentTab();
  });

  // Transpose controls
  row.querySelector('.xpose-reset').addEventListener('click', e => {
    e.stopPropagation(); applyTranspose(track.id, 0);
  });
  row.querySelector('.xpose-dec').addEventListener('click', e => {
    e.stopPropagation(); applyTranspose(track.id, (track.semitones || 0) - 1);
  });
  row.querySelector('.xpose-inc').addEventListener('click', e => {
    e.stopPropagation(); applyTranspose(track.id, (track.semitones || 0) + 1);
  });

  return row;
}

function enterPlaylistEditMode(pl) {
  playlistEditMode = true;
  playlistEditTargetId = pl.id;
  playlistEditSnapshot = [...pl.trackIds];
  document.querySelectorAll('.lib-tab').forEach(b => b.classList.remove('active'));
  document.querySelector('.lib-tab[data-tab="songs"]').classList.add('active');
  activeTab = 'songs';
  renderCurrentTab();
}

async function exitPlaylistEditMode(doConfirm) {
  const pl = playlists.find(p => p.id === playlistEditTargetId);
  if (pl && !doConfirm) {
    pl.trackIds = playlistEditSnapshot;
    await LibraryManager.savePlaylist(pl).catch(e => console.warn('Playlist save failed:', e));
  }
  const returnId = pl?.id || null;
  playlistEditMode = false;
  playlistEditTargetId = null;
  playlistEditSnapshot = [];
  selectedPlaylistId = returnId;
  document.querySelectorAll('.lib-tab').forEach(b => b.classList.remove('active'));
  document.querySelector('.lib-tab[data-tab="playlists"]').classList.add('active');
  activeTab = 'playlists';
  renderCurrentTab();
  if (doConfirm) notify('Playlist updated', 'success');
}

function showAddTracksOverlay(container, pl) {
  // Remove any existing overlay
  container.querySelector('.add-tracks-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'add-tracks-overlay';

  const sorted = [...tracks].sort((a, b) => a.name.localeCompare(b.name));

  overlay.innerHTML = `
    <div class="add-tracks-header">
      <div class="add-tracks-title">Add Tracks</div>
      <button class="add-tracks-close" id="add-tracks-close">✕</button>
    </div>
    <input class="add-tracks-filter" id="add-tracks-filter" type="text" placeholder="Filter tracks…" autocomplete="off">
    <div class="add-tracks-list" id="add-tracks-list"></div>
  `;
  container.appendChild(overlay);

  const filterInput = overlay.querySelector('#add-tracks-filter');
  const listEl = overlay.querySelector('#add-tracks-list');

  function buildAddRows(filterStr) {
    const q = filterStr.toLowerCase();
    const filtered = q ? sorted.filter(t =>
      t.name.toLowerCase().includes(q) ||
      (t.artist || '').toLowerCase().includes(q)
    ) : sorted;
    listEl.innerHTML = '';
    filtered.forEach(track => {
      const row = document.createElement('div');
      row.className = 'add-track-row';
      const artist = track.artist || '';
      row.innerHTML = `
        <div class="add-track-name">${escHtml(track.name)}</div>
        ${artist ? `<div class="add-track-sub">${escHtml(artist)}</div>` : ''}
        <button class="add-track-btn" title="Add to playlist">+</button>
      `;
      row.querySelector('.add-track-btn').addEventListener('click', e => {
        e.stopPropagation();
        pl.trackIds.push(track.id);
        LibraryManager.savePlaylist(pl).catch(e => console.warn('Playlist save failed:', e));
        // Refresh count in header without closing overlay
        const countEl = container.querySelector('.pl-detail-count');
        if (countEl) countEl.textContent = pl.trackIds.length + ' track' + (pl.trackIds.length !== 1 ? 's' : '');
        // Briefly flash the + button to confirm
        const btn = row.querySelector('.add-track-btn');
        btn.textContent = '✓';
        btn.style.color = 'var(--accent)';
        btn.style.borderColor = 'var(--accent)';
        setTimeout(() => { btn.textContent = '+'; btn.style.color = ''; btn.style.borderColor = ''; }, 800);
        // Update count on left-pane row too
        const plRowEl = document.querySelector(`.pl-row[data-pl-id="${pl.id}"] .pl-row-count`);
        if (plRowEl) plRowEl.textContent = pl.trackIds.length;
      });
      listEl.appendChild(row);
    });
  }

  buildAddRows('');
  filterInput.addEventListener('input', () => buildAddRows(filterInput.value));
  filterInput.focus();

  overlay.querySelector('#add-tracks-close').addEventListener('click', () => {
    overlay.remove();
    // Re-render to show updated track list
    renderCurrentTab();
  });
}

async function createNewPlaylist() {
  const pl = {
    id: LibraryManager.genPlaylistId(),
    name: 'New Playlist',
    trackIds: [],
    createdAt: Date.now()
  };
  playlists.push(pl);
  await LibraryManager.savePlaylist(pl).catch(e => console.warn('Playlist save failed:', e));
  selectedPlaylistId = pl.id;
  renderCurrentTab();
  // Start inline rename immediately
  startPlaylistRename(pl.id);
}

function startPlaylistRename(plId) {
  const rowEl = document.querySelector(`.pl-row[data-pl-id="${plId}"]`);
  if (!rowEl) return;
  const pl = playlists.find(p => p.id === plId);
  if (!pl) return;

  const nameEl = rowEl.querySelector('.pl-row-name');
  const input = document.createElement('input');
  input.className = 'pl-row-name-input';
  input.value = pl.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  function commit() {
    const newName = input.value.trim() || pl.name;
    pl.name = newName;
    LibraryManager.savePlaylist(pl).catch(e => console.warn('Playlist save failed:', e));
    renderCurrentTab();
  }
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = pl.name; input.blur(); }
  });
}

// ─── PLAYLIST CONTEXT MENU ───────────────────────────────────
let plCtxMenuId = null;
const plCtxMenu = document.getElementById('pl-ctx-menu');

function showPlCtxMenu(e, plId) {
  plCtxMenuId = plId;
  const x = Math.min(e.clientX, window.innerWidth - 150);
  const y = Math.min(e.clientY, window.innerHeight - 80);
  plCtxMenu.style.left = x + 'px';
  plCtxMenu.style.top  = y + 'px';
  plCtxMenu.classList.add('show');
}

plCtxMenu.addEventListener('click', async e => {
  const action = e.target.closest('[data-pl-action]')?.dataset.plAction;
  if (!action || !plCtxMenuId) return;
  plCtxMenu.classList.remove('show');
  if (action === 'rename') {
    startPlaylistRename(plCtxMenuId);
  } else if (action === 'delete') {
    const pl = playlists.find(p => p.id === plCtxMenuId);
    if (!pl) return;
    const yes = await confirm('Delete Playlist', `Remove "${pl.name}"? The tracks will stay in your library.`);
    if (!yes) return;
    await LibraryManager.deletePlaylist(plCtxMenuId).catch(e => console.warn('Delete failed:', e));
    playlists = playlists.filter(p => p.id !== plCtxMenuId);
    if (selectedPlaylistId === plCtxMenuId) selectedPlaylistId = null;
    if (activePlaylistId === plCtxMenuId) activePlaylistId = null;
    renderCurrentTab();
    notify('Playlist deleted', '');
  }
});

document.addEventListener('click', () => plCtxMenu.classList.remove('show'));

// ─── ADD TO PLAYLIST SUBMENU ─────────────────────────────────
const plSubmenu = document.getElementById('pl-submenu');
let submenuTrackId = null;

function showAddToPlaylistSubmenu(e, trackId) {
  submenuTrackId = trackId;
  plSubmenu.innerHTML = '';

  if (playlists.length > 0) {
    playlists.forEach(pl => {
      const item = document.createElement('div');
      item.className = 'pl-submenu-item';
      item.textContent = pl.name;
      item.addEventListener('click', () => {
        pl.trackIds.push(trackId);
        LibraryManager.savePlaylist(pl).catch(e => console.warn('Playlist save failed:', e));
        plSubmenu.classList.remove('show');
        if (activeTab === 'playlists' && selectedPlaylistId === pl.id) renderCurrentTab();
        notify(`Added to "${pl.name}"`, 'success');
      });
      plSubmenu.appendChild(item);
    });
    const sep = document.createElement('div');
    sep.style.cssText = 'height:1px;background:var(--border);margin:4px 0;';
    plSubmenu.appendChild(sep);
  }

  const newItem = document.createElement('div');
  newItem.className = 'pl-submenu-item new-pl';
  newItem.textContent = '+ New Playlist…';
  newItem.addEventListener('click', async () => {
    plSubmenu.classList.remove('show');
    const pl = {
      id: LibraryManager.genPlaylistId(),
      name: 'New Playlist',
      trackIds: [trackId],
      createdAt: Date.now()
    };
    playlists.push(pl);
    await LibraryManager.savePlaylist(pl).catch(e => console.warn('Playlist save failed:', e));
    selectedPlaylistId = pl.id;
    // Switch to playlists tab so user can rename
    document.querySelectorAll('.lib-tab').forEach(b => b.classList.remove('active'));
    document.querySelector('.lib-tab[data-tab="playlists"]').classList.add('active');
    activeTab = 'playlists';
    renderCurrentTab();
    startPlaylistRename(pl.id);
    notify('New playlist created', 'success');
  });
  plSubmenu.appendChild(newItem);

  // Position submenu to the right of context menu, or left if no space
  const ctxRect = ctxMenu.getBoundingClientRect();
  let x = ctxRect.right + 2;
  if (x + 160 > window.innerWidth) x = ctxRect.left - 162;
  const y = Math.min(e.clientY, window.innerHeight - (playlists.length * 32 + 70));
  plSubmenu.style.left = x + 'px';
  plSubmenu.style.top  = y + 'px';
  plSubmenu.classList.add('show');
}

document.addEventListener('click', () => plSubmenu.classList.remove('show'));

function renderCurrentTab() {
  // Manage the edit-mode banner — visible on all tabs while edit mode is active
  const existingBanner = document.getElementById('pl-edit-banner');
  if (playlistEditMode) {
    if (!existingBanner) {
      const pl = playlists.find(p => p.id === playlistEditTargetId);
      const banner = document.createElement('div');
      banner.id = 'pl-edit-banner';
      banner.innerHTML = `
        <span class="pl-edit-label">Adding to: <strong>${escHtml(pl?.name || '')}</strong></span>
        <div class="pl-edit-actions">
          <button class="pl-edit-confirm" id="pl-edit-confirm">Confirm</button>
          <button class="pl-edit-revert" id="pl-edit-revert">Revert</button>
        </div>
      `;
      const trackList = document.getElementById('track-list');
      trackList.parentElement.insertBefore(banner, trackList);
      banner.querySelector('#pl-edit-confirm').addEventListener('click', () => exitPlaylistEditMode(true));
      banner.querySelector('#pl-edit-revert').addEventListener('click', () => exitPlaylistEditMode(false));
    }
  } else {
    existingBanner?.remove();
  }

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
  const allowed = ['wav','mp3','flac','ogg','opus'];
  const validFiles = [...files].filter(f =>
    allowed.includes(f.name.split('.').pop().toLowerCase())
  );
  if (validFiles.length === 0) return;

  // Step 1: add all skeleton tracks from filename alone — zero I/O, instant appearance
  const workItems = validFiles.map(file => {
    const ext = file.name.split('.').pop().toLowerCase();
    const id  = LibraryManager.genId();
    const track = {
      id,
      name: file.name.replace(/\.[^.]+$/, ''),
      format: ext.toUpperCase(),
      size: file.size,
      semitones: 0, volume: 1.0,
      artist: '', album: '', title: '',
      duration: 0, arrayBuffer: null,
      addedAt: Date.now()
    };
    tracks.push(track);
    players[id] = new TrackPlayer(id);
    players[id].semitones = 0;
    players[id].volume = 1.0;
    return { file, track };
  });
  renderTrackList(); // all names appear at once before any I/O

  // Step 2: process one file at a time to avoid memory spikes in Firefox
  let added = 0;
  for (const { file, track } of workItems) {
    try {
      // Read tags + raw bytes concurrently for this single file
      const [tags, ab] = await Promise.all([readTags(file), file.arrayBuffer()]);

      // Update skeleton with real metadata
      track.artist = tags.artist || '';
      track.album  = tags.album  || '';
      track.title  = tags.title  || '';
      const abMem  = ab.slice(0); // keep live copy; ab will be transferred to IDB
      track.arrayBuffer = abMem;

      // IDB save — fire and forget (ab is transferred/detached here)
      LibraryManager.save({ ...track, arrayBuffer: ab })
        .catch(e => console.warn('IDB save failed:', e));

      // Decode for duration — fire and forget
      players[track.id].loadBuffer(abMem.slice(0)).then(() => {
        if (!track.duration) {
          track.duration = players[track.id].duration;
          saveTrackMeta(track);
          renderTrackList(); // refresh duration column
        }
      }).catch(e => console.warn('Decode failed:', track.name, e));

      added++;
      renderTrackList(); // refresh metadata (artist/album) for this row
    } catch(e) {
      console.warn('Import failed for', file.name, e);
    }
  }

  if (added > 0) notify(`Imported ${added} track${added > 1 ? 's' : ''}`, 'success');
}


// ─── UI SCALE ────────────────────────────────────────────────
const SCALE_MIN = 85, SCALE_MAX = 160, SCALE_STEP = 5;
let uiScale = parseInt(localStorage.getItem('uiScale') || '110');

// ─── RESTORE VOLUME SETTINGS ──────────────────────────────────
const storedMasterVol = localStorage.getItem('masterVolume');
if (storedMasterVol !== null) {
  document.getElementById('mp-vol').value = storedMasterVol;
}
const storedMetroVol = localStorage.getItem('metronomeVolume');
if (storedMetroVol !== null) {
  document.getElementById('mm-vol').value = storedMetroVol;
  Metronome.setVolume(parseInt(storedMetroVol) / 100);
}

function applyScale() {
  const scale = uiScale / 100;
  const app = document.getElementById('app');
  // Clear any legacy zoom on documentElement
  document.documentElement.style.zoom = '';
  // Apply zoom to #app so all UI scales together
  app.style.zoom = uiScale + '%';
  // For scale > 1: pre-shrink layout dimensions so the zoomed result
  // fills exactly the viewport and nothing is cropped by overflow:hidden
  if (scale > 1) {
    app.style.width = (100 / scale) + 'vw';
    app.style.height = (100 / scale) + 'vh';
  } else {
    app.style.width = '';
    app.style.height = '';
  }
  document.getElementById('scale-val').textContent = (uiScale - 10) + '%';
}

document.getElementById('scale-minus').addEventListener('click', () => {
  if (uiScale > SCALE_MIN) { uiScale -= SCALE_STEP; localStorage.setItem('uiScale', uiScale); applyScale(); }
});
document.getElementById('scale-plus').addEventListener('click', () => {
  if (uiScale < SCALE_MAX) { uiScale += SCALE_STEP; localStorage.setItem('uiScale', uiScale); applyScale(); }
});

applyScale();

// ─── SETTINGS POPUP ──────────────────────────────────────────
const settingsBtn   = document.getElementById('settings-btn');
const settingsPopup = document.getElementById('settings-popup');

settingsBtn.addEventListener('click', e => {
  e.stopPropagation();
  const open = !settingsPopup.classList.contains('hidden');
  settingsPopup.classList.toggle('hidden', open);
  settingsBtn.classList.toggle('active', !open);
});

document.addEventListener('click', e => {
  if (!settingsPopup.classList.contains('hidden') && !settingsPopup.contains(e.target)) {
    settingsPopup.classList.add('hidden');
    settingsBtn.classList.remove('active');
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !settingsPopup.classList.contains('hidden')) {
    settingsPopup.classList.add('hidden');
    settingsBtn.classList.remove('active');
  }
});

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
let lastClickId = null;
let lastClickTime = 0;
const DBL_CLICK_MS = 300;

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

  // Hover play button
  const playBtn = e.target.closest('.row-play-btn[data-id]');
  if (playBtn) {
    e.stopPropagation();
    playTrack(playBtn.dataset.id);
    return;
  }

  // Transpose reset/dec/inc buttons — must check before track-row click
  const xreset = e.target.closest('.xpose-reset[data-id]');
  if (xreset) {
    e.stopPropagation();
    applyTranspose(xreset.dataset.id, 0);
    return;
  }
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

  // Track row click -> select (File Explorer style), double-click -> play
  const row = e.target.closest('.track-row[data-id]');
  if (!row) {
    // Clicked empty space — deselect all
    selectedIds.clear();
    lastSelectedIdx = -1;
    renderCurrentTab();
    return;
  }
  const id = row.dataset.id;
  const now = Date.now();
  if (lastClickId === id && (now - lastClickTime) < DBL_CLICK_MS) {
    // Double-click detected — play
    lastClickId = null;
    lastClickTime = 0;
    playTrack(id);
    return;
  }
  lastClickId = id;
  lastClickTime = now;
  const idx = tracks.findIndex(t => t.id === id);
  if (e.ctrlKey || e.metaKey) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    lastSelectedIdx = idx;
  } else if (e.shiftKey && lastSelectedIdx !== -1) {
    const start = Math.min(lastSelectedIdx, idx);
    const end   = Math.max(lastSelectedIdx, idx);
    for (let i = start; i <= end; i++) selectedIds.add(tracks[i].id);
  } else {
    selectedIds.clear();
    selectedIds.add(id);
    lastSelectedIdx = idx;
  }
  renderCurrentTab();
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
  // Right-clicking an unselected row: select only it
  if (!selectedIds.has(trackId)) {
    selectedIds.clear();
    selectedIds.add(trackId);
    lastSelectedIdx = tracks.findIndex(t => t.id === trackId);
    renderCurrentTab();
  }
  ctxMenuTrackId = trackId;
  // Rename only available for a single selection
  ctxMenu.querySelector('[data-action="rename"]')
    .classList.toggle('ctx-disabled', selectedIds.size !== 1);
  const x = Math.min(e.clientX, window.innerWidth - 160);
  const y = Math.min(e.clientY, window.innerHeight - 130);
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
  if (action === 'add-to-playlist') {
    e.stopPropagation(); // prevent document click from closing menus immediately
    showAddToPlaylistSubmenu(e, ctxMenuTrackId);
    return;
  }
  ctxMenu.classList.remove('show');
  if (action === 'play') {
    playTrack(ctxMenuTrackId);
  } else if (action === 'rename') {
    startRenameById(ctxMenuTrackId);
  } else if (action === 'delete') {
    deleteSelectedTracks([...selectedIds]);
  } else if (action === 'select-all') {
    tracks.forEach(t => selectedIds.add(t.id));
    renderCurrentTab();
  }
});

async function deleteSelectedTracks(ids) {
  if (!ids.length) return;
  const label = ids.length === 1
    ? `Remove "${tracks.find(t => t.id === ids[0])?.name}" from your library? This cannot be undone.`
    : `Remove ${ids.length} tracks from your library? This cannot be undone.`;
  const yes = await confirm('Delete Track' + (ids.length > 1 ? 's' : ''), label);
  if (!yes) return;
  for (const id of ids) {
    const player = players[id];
    if (player) player.stop();
    if (currentPlayingId === id) hideMiniplayer();
    delete players[id];
    await LibraryManager.remove(id);
    tracks = tracks.filter(t => t.id !== id);
    selectedIds.delete(id);
  }
  renderCurrentTab();
  notify(ids.length === 1 ? 'Track deleted' : `${ids.length} tracks deleted`, '');
}


// ─── LIBRARY EVENT BINDINGS ───────────────────────────────────
const fileInput = document.getElementById('file-input');
const importBtn = document.getElementById('import-btn');
const libraryPanel = document.getElementById('panel-library');

importBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  if (fileInput.files.length) importFiles(Array.from(fileInput.files));
  fileInput.value = '';
});

libraryPanel.addEventListener('dragover', e => {
  e.preventDefault();
  libraryPanel.classList.add('drag-over');
});
libraryPanel.addEventListener('dragleave', e => {
  if (!libraryPanel.contains(e.relatedTarget)) libraryPanel.classList.remove('drag-over');
});
libraryPanel.addEventListener('drop', e => {
  e.preventDefault();
  libraryPanel.classList.remove('drag-over');
  importFiles(Array.from(e.dataTransfer.files));
});

// ─── METRONOME MINIPLAYER SYNC ────────────────────────────────
Metronome.onBeat(() => {
  const btn = document.getElementById('mm-bpm-display');
  btn.classList.add('beat-flash');
  setTimeout(() => btn.classList.remove('beat-flash'), 80);
});

function syncMetroMini() {
  document.querySelector('#mm-bpm-display .mm-bpm-num').textContent = Metronome.getBpm();
  const active = Metronome.isActive();
  document.getElementById('mm-play-btn').textContent = active ? '⏹' : '▶';
  document.getElementById('mm-play-btn').classList.toggle('running', active);
}

// ─── METRONOME MINIPLAYER BINDINGS ────────────────────────────
document.getElementById('mm-play-btn').addEventListener('click', async function() {
  const ctx = resume();
  if (ctx.state === 'suspended') await ctx.resume();
  if (Metronome.isActive()) { Metronome.stop(); } else { Metronome.start(); }
  syncMetroMini();
  // sync full-panel button
  const fullBtn = document.getElementById('metro-play-btn');
  fullBtn.textContent = Metronome.isActive() ? '⏹ Stop' : '▶ Start';
  fullBtn.classList.toggle('running', Metronome.isActive());
});

// BPM display — double-click to type BPM inline
document.getElementById('mm-bpm-display').addEventListener('dblclick', () => {
  const display = document.getElementById('mm-bpm-display');
  const input = document.getElementById('mm-bpm-inline');
  input.value = Metronome.getBpm();
  display.style.display = 'none';
  input.style.display = '';
  input.focus();
  input.select();
});

function commitBpmInline() {
  const display = document.getElementById('mm-bpm-display');
  const input = document.getElementById('mm-bpm-inline');
  const val = parseInt(input.value);
  if (!isNaN(val)) { Metronome.setBpm(val); document.getElementById('bpm-input').value = Metronome.getBpm(); syncMetroMini(); }
  input.style.display = 'none';
  display.style.display = '';
}
document.getElementById('mm-bpm-inline').addEventListener('blur', commitBpmInline);
document.getElementById('mm-bpm-inline').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); commitBpmInline(); }
  if (e.key === 'Escape') {
    const input = document.getElementById('mm-bpm-inline');
    input.style.display = 'none';
    document.getElementById('mm-bpm-display').style.display = '';
  }
});

// TAP button — tap tempo
document.getElementById('mm-tap-btn').addEventListener('click', () => {
  resume();
  const bpm = TapTempo.tap();
  const count = TapTempo.count();
  if (bpm) { Metronome.setBpm(bpm); document.getElementById('bpm-input').value = bpm; }
  syncMetroMini();
  const countEl = document.getElementById('tap-count');
  countEl.textContent = count < 2 ? 'tap again...' : `${count} taps · ${bpm} BPM`;
});

document.getElementById('mm-bpm-minus').addEventListener('click', () => {
  Metronome.setBpm(Metronome.getBpm() - 1);
  syncMetroMini();
  document.getElementById('bpm-input').value = Metronome.getBpm();
});
document.getElementById('mm-bpm-plus').addEventListener('click', () => {
  Metronome.setBpm(Metronome.getBpm() + 1);
  syncMetroMini();
  document.getElementById('bpm-input').value = Metronome.getBpm();
});

document.getElementById('mm-subdiv-select').addEventListener('change', function() {
  const subdiv = parseInt(this.value);
  Metronome.setSubdivision(subdiv);
  // sync full-panel subdivision buttons
  document.querySelectorAll('.subdiv-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.subdiv) === subdiv));
  localStorage.setItem('metronomeSubdiv', subdiv);
});

document.getElementById('mm-vol').addEventListener('input', function() {
  Metronome.setVolume(this.value / 100);
  localStorage.setItem('metronomeVolume', this.value);
});

// ─── METRONOME FULL-PANEL BINDINGS ───────────────────────────
document.getElementById('bpm-minus').addEventListener('click', () => {
  Metronome.setBpm(Metronome.getBpm() - 1);
  syncMetroMini();
});
document.getElementById('bpm-plus').addEventListener('click', () => {
  Metronome.setBpm(Metronome.getBpm() + 1);
  syncMetroMini();
});

document.getElementById('bpm-input').addEventListener('change', function() {
  Metronome.setBpm(parseInt(this.value) || 120);
  syncMetroMini();
});
document.getElementById('bpm-input').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') this.blur();
});

document.getElementById('metro-play-btn').addEventListener('click', async function() {
  const ctx = resume();
  if (ctx.state === 'suspended') await ctx.resume();
  if (Metronome.isActive()) {
    Metronome.stop();
    this.textContent = '▶ Start';
    this.classList.remove('running');
  } else {
    Metronome.start();
    this.textContent = '⏹ Stop';
    this.classList.add('running');
  }
  syncMetroMini();
});

document.querySelectorAll('.subdiv-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.subdiv-btn').forEach(b => b.classList.remove('active'));
    this.classList.add('active');
    const subdiv = parseInt(this.dataset.subdiv);
    Metronome.setSubdivision(subdiv);
    // sync miniplayer select
    document.getElementById('mm-subdiv-select').value = subdiv;
    localStorage.setItem('metronomeSubdiv', subdiv);
  });
});

// Accent toggle (synced between full panel and miniplayer)
function syncAccentBtns(enabled) {
  document.getElementById('accent-toggle-btn').classList.toggle('active', enabled);
  document.getElementById('mm-accent-btn').classList.toggle('active', enabled);
}
document.getElementById('accent-toggle-btn').addEventListener('click', function() {
  const enabled = !Metronome.getAccent();
  Metronome.setAccent(enabled);
  syncAccentBtns(enabled);
  localStorage.setItem('metronomeAccent', enabled);
});
document.getElementById('mm-accent-btn').addEventListener('click', function() {
  const enabled = !Metronome.getAccent();
  Metronome.setAccent(enabled);
  syncAccentBtns(enabled);
  localStorage.setItem('metronomeAccent', enabled);
});

// ─── TIME SIGNATURE ───────────────────────────────────────────
function syncTimeSigUI(num, den) {
  document.querySelectorAll('.timesig-btn').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.num) === num && parseInt(b.dataset.den) === den)
  );
  document.getElementById('timesig-num').value = num;
  document.getElementById('timesig-den').value = den;
  const sel = document.getElementById('mm-timesig-select');
  const key = `${num}/${den}`;
  const opt = sel.querySelector(`option[value="${key}"]`);
  if (opt) {
    sel.value = key;
  } else {
    let customOpt = sel.querySelector('option[value="custom"]');
    customOpt.textContent = `Custom (${num}/${den})`;
    customOpt.disabled = false;
    sel.value = 'custom';
  }
}

function applyTimeSignature(num, den) {
  Metronome.setTimeSignature(num, den);
  syncTimeSigUI(num, den);
  localStorage.setItem('metronomeTimeSig', JSON.stringify({ num, den }));
}

document.querySelectorAll('.timesig-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    applyTimeSignature(parseInt(this.dataset.num), parseInt(this.dataset.den));
  });
});

document.getElementById('timesig-apply-btn').addEventListener('click', () => {
  const num = parseInt(document.getElementById('timesig-num').value);
  const den = parseInt(document.getElementById('timesig-den').value);
  if (num >= 2 && num <= 16) applyTimeSignature(num, den);
});

document.getElementById('mm-timesig-select').addEventListener('change', function() {
  if (this.value === 'custom') return;
  const [num, den] = this.value.split('/').map(Number);
  applyTimeSignature(num, den);
});

// Tap tempo (full-panel button)
document.getElementById('tap-btn').addEventListener('click', () => {
  resume();
  const bpm = TapTempo.tap();
  const count = TapTempo.count();
  if (bpm) Metronome.setBpm(bpm);
  syncMetroMini();
  const countEl = document.getElementById('tap-count');
  if (count < 2) {
    countEl.textContent = 'tap again...';
  } else {
    countEl.textContent = `${count} taps · ${bpm} BPM`;
  }
});

// Custom click sounds (4 slots: accent, quarter, eighth, subdivision)
{
  let activeType = null;
  const fileInput = document.getElementById('click-file-input');

  document.querySelectorAll('.load-click-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeType = btn.dataset.type;
      fileInput.click();
    });
  });

  fileInput.addEventListener('change', async function() {
    if (!this.files[0] || !activeType) return;
    const file = this.files[0];
    const ab = await file.arrayBuffer();
    const abForStore = ab.slice(0); // decodeAudioData may transfer ab
    const ctx = resume();
    let buf;
    try {
      buf = await ctx.decodeAudioData(ab);
    } catch(e) {
      notify('Could not decode audio file', 'error');
      return;
    }
    Metronome.setCustomBuffer(activeType, buf);
    document.querySelector(`.click-sound-name[data-type="${activeType}"]`).textContent = file.name;
    document.querySelector(`.clear-click-btn[data-type="${activeType}"]`).style.display = '';
    try {
      await LibraryManager.putSetting({ key: 'click_' + activeType, name: file.name, data: abForStore });
    } catch(e) {
      console.error('Failed to save click sound to storage:', e);
    }
    notify(`${activeType.charAt(0).toUpperCase() + activeType.slice(1)} click loaded`, 'success');
    this.value = '';
    activeType = null;
  });

  document.querySelectorAll('.clear-click-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type;
      Metronome.setCustomBuffer(type, null);
      document.querySelector(`.click-sound-name[data-type="${type}"]`).textContent = 'Default';
      btn.style.display = 'none';
      LibraryManager.deleteSetting('click_' + type);
    });
  });
}


// ─── INIT ────────────────────────────────────────────────────
(async function init() {
  // Restore time signature before building beat dots
  const storedTimeSig = localStorage.getItem('metronomeTimeSig');
  if (storedTimeSig) {
    try {
      const { num, den } = JSON.parse(storedTimeSig);
      Metronome.setTimeSignature(num, den);
      syncTimeSigUI(num, den);
    } catch(e) { /* corrupt — ignore */ }
  }
  // Restore subdivision
  const storedSubdiv = parseInt(localStorage.getItem('metronomeSubdiv'));
  const subdiv = [1, 2, 3, 4].includes(storedSubdiv) ? storedSubdiv : 1;
  Metronome.setSubdivision(subdiv);
  document.querySelectorAll('.subdiv-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.subdiv) === subdiv));
  document.getElementById('mm-subdiv-select').value = subdiv;

  // Restore accent toggle
  const storedAccent = localStorage.getItem('metronomeAccent');
  if (storedAccent !== null) {
    const enabled = storedAccent === 'true';
    Metronome.setAccent(enabled);
    syncAccentBtns(enabled);
  }

  syncMetroMini();
  await loadLibrary();
  // Restore persisted click sounds
  const ctx = resume();
  for (const type of ['accent', 'quarter', 'eighth', 'subdivision']) {
    const record = await LibraryManager.getSetting('click_' + type);
    if (!record) continue;
    try {
      const buf = await ctx.decodeAudioData(record.data.slice(0));
      Metronome.setCustomBuffer(type, buf);
      document.querySelector(`.click-sound-name[data-type="${type}"]`).textContent = record.name;
      document.querySelector(`.clear-click-btn[data-type="${type}"]`).style.display = '';
    } catch(e) {
      console.error('Failed to restore click sound:', type, e);
    }
  }
})();
