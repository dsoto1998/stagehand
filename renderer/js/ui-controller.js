// ─── UI CONTROLLER ───────────────────────────────────────────
import { resume, getCtx, setMasterVolume } from './audio-engine.js';
import { ICONS } from './icons.js';
import * as LibraryManager from './library-manager.js';
import { TrackPlayer, players } from './track-player.js';
import { Metronome, TapTempo } from './metronome.js';
import { renderWaveform, buildWaveformLayers, renderPlayerWaveform } from './waveform.js';
import * as ArtworkManager from './artwork-manager.js';
import { listen, invoke, writeAudioFile, scanLibraryDir, convertFileSrc } from './tauri-api.js';


// ─── KEY CONSTANTS ────────────────────────────────────────────
const MAJOR_KEYS      = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
const MINOR_KEYS      = ['Cm','C#m','Dm','Ebm','Em','Fm','F#m','Gm','G#m','Am','Bbm','Bm'];
const MAJOR_ROOT_NAMES = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
const MINOR_ROOT_NAMES = ['C','C#','D','Eb','E','F','F#','G','G#','A','Bb','B'];

function getKeyName(rootIdx, mode) {
  return mode === 'major' ? MAJOR_KEYS[rootIdx] : MINOR_KEYS[rootIdx];
}
function transposedKeyName(rootIdx, mode, semitones) {
  const idx = ((rootIdx + semitones) % 12 + 12) % 12;
  return mode === 'major' ? MAJOR_KEYS[idx] : MINOR_KEYS[idx];
}
function populateKeyRootSelect(sel, mode, selectedRoot) {
  const names = mode === 'major' ? MAJOR_ROOT_NAMES : MINOR_ROOT_NAMES;
  sel.innerHTML = '<option value="">—</option>' +
    names.map((n, i) => `<option value="${i}"${selectedRoot === i ? ' selected' : ''}>${n}</option>`).join('');
}

// ─── KEYBOARD SHORTCUTS ───────────────────────────────────────
const SHORTCUT_DEFAULTS = [
  { id: 'play-pause',      group: 'Playback',  label: 'Play / Pause',       key: ' ',          modifiers: []        },
  { id: 'prev-track',      group: 'Playback',  label: 'Previous track',     key: '[',          modifiers: []        },
  { id: 'next-track',      group: 'Playback',  label: 'Next track',         key: ']',          modifiers: []        },
  { id: 'seek-back-5',     group: 'Playback',  label: 'Seek back 5s',       key: 'ArrowLeft',  modifiers: []        },
  { id: 'seek-fwd-5',      group: 'Playback',  label: 'Seek forward 5s',    key: 'ArrowRight', modifiers: []        },
  { id: 'seek-back-15',    group: 'Playback',  label: 'Seek back 15s',      key: 'ArrowLeft',  modifiers: ['Shift'] },
  { id: 'seek-fwd-15',     group: 'Playback',  label: 'Seek forward 15s',   key: 'ArrowRight', modifiers: ['Shift'] },
  { id: 'loop-toggle',     group: 'Loop',      label: 'Toggle loop',        key: 'l',          modifiers: []        },
  { id: 'loop-in',         group: 'Loop',      label: 'Set loop in point',  key: 'i',          modifiers: []        },
  { id: 'loop-out',        group: 'Loop',      label: 'Set loop out point', key: 'o',          modifiers: []        },
  { id: 'metro-toggle',    group: 'Metronome', label: 'Start / Stop',       key: 'm',          modifiers: []        },
  { id: 'tap-tempo',       group: 'Metronome', label: 'Tap tempo',          key: 't',          modifiers: []        },
  { id: 'focus-search',    group: 'Library',   label: 'Focus search',       key: 'f',          modifiers: ['Ctrl']  },
  { id: 'select-all',      group: 'Library',   label: 'Select all tracks',  key: 'a',          modifiers: ['Ctrl']  },
  { id: 'delete-selected', group: 'Library',   label: 'Delete selected',    key: 'Delete',     modifiers: []        },
];

function _loadShortcuts() {
  try {
    const saved = JSON.parse(localStorage.getItem('stagehand_shortcuts') || '{}');
    const map = {};
    for (const def of SHORTCUT_DEFAULTS) {
      map[def.id] = saved[def.id] ? { ...def, ...saved[def.id] } : { ...def };
    }
    return map;
  } catch { return Object.fromEntries(SHORTCUT_DEFAULTS.map(d => [d.id, { ...d }])); }
}

function _saveShortcuts() {
  const overrides = {};
  for (const def of SHORTCUT_DEFAULTS) {
    const sc = shortcuts[def.id];
    if (sc.key !== def.key || JSON.stringify(sc.modifiers) !== JSON.stringify(def.modifiers)) {
      overrides[def.id] = { key: sc.key, modifiers: sc.modifiers };
    }
  }
  localStorage.setItem('stagehand_shortcuts', JSON.stringify(overrides));
}

let shortcuts = _loadShortcuts();

function matchShortcut(e, id) {
  const sc = shortcuts[id];
  if (!sc) return false;
  const mods = sc.modifiers || [];
  if (mods.includes('Ctrl')  !== (e.ctrlKey || e.metaKey)) return false;
  if (mods.includes('Shift') !== e.shiftKey) return false;
  if (mods.includes('Alt')   !== e.altKey)   return false;
  const k = sc.key;
  return e.key === k || (k.length === 1 && e.key.toLowerCase() === k.toLowerCase());
}

// ─── VIRTUAL SCROLL STATE ─────────────────────────────────────
const ROW_H = 50;       // px — must match CSS .track-row height
const OVERSCAN = 5;     // extra rows above/below viewport
let activeTab = 'songs'; // 'songs' | 'artists' | 'albums' | 'playlists'
let currentArtistView = null; // null = artist list, string = drill-down artist name
let currentAlbumView = null;  // null = album list, string = drill-down album name
let renamingActive = false;   // guards scroll re-renders during inline rename

// ─── PLAYLIST STATE ───────────────────────────────────────────
let playlists = [];            // cached from IDB
let selectedPlaylistId = null; // which playlist is shown in right pane
let activePlaylistId = null;   // playlist that launched current playback (for auto-next)
let plDragSrcIndex = null;     // drag-to-reorder source index within playlist
let plDragSrcPlaylistId = null; // source playlist ID for cross-playlist move
let plDragSrcTrackId = null;    // track ID being dragged from a playlist
let playlistSortMode = 'manual'; // 'manual' | 'name' | 'date'
let playlistManualOrder = [];    // IDs array for manual sort order
let plListDragSrcId = null;      // drag-to-reorder source ID within playlist list

// ─── PLAYLIST EDIT MODE ───────────────────────────────────────
let playlistEditMode = false;
let playlistEditTargetId = null;
let playlistEditSnapshot = [];   // copy of slots before any edits
let currentPlayingSlotIdx = null; // slot index within activePlaylistId that is playing

// ─── LIBRARY DRAG STATE ───────────────────────────────────────
let libDragIds = null;      // Set<string> | null — IDs being dragged from library; null = no active drag
let tabHoverTimer = null;   // timer handle for tab auto-switch
let tabHoverTarget = null;  // data-tab value of currently hovered tab
let plHoverTimer = null;    // timer handle for playlist row hover-to-open
let plHoverTargetId = null; // playlist ID currently being hovered

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

function updateRangeFill(el) {
  const min = parseFloat(el.min) || 0;
  const max = parseFloat(el.max) || 100;
  const pct = ((parseFloat(el.value) - min) / (max - min)) * 100;
  el.style.setProperty('--range-val', pct + '%');
}

let notifTimer = null;
function notify(msg, type = '') {
  const el = document.getElementById('notif');
  el.textContent = msg;
  el.className = 'show ' + type;
  clearTimeout(notifTimer);
  notifTimer = setTimeout(() => { el.className = ''; }, 2800);
}

function confirm(title, msg, okLabel = 'Delete') {
  return new Promise(res => {
    document.getElementById('conf-title').textContent = title;
    document.getElementById('conf-msg').textContent = msg;
    const overlay = document.getElementById('confirm-overlay');
    overlay.classList.add('show');
    const ok = document.getElementById('conf-ok');
    const cancel = document.getElementById('conf-cancel');
    ok.textContent = okLabel;
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

// promptChoice: 3-button modal. Returns 'ok' | 'alt' | null (cancel).
// okLabel uses btn-danger styling; altLabel uses plain btn styling.
function promptChoice(title, msg, okLabel, altLabel) {
  return new Promise(res => {
    document.getElementById('conf-title').textContent = title;
    document.getElementById('conf-msg').textContent = msg;
    const overlay = document.getElementById('confirm-overlay');
    const ok     = document.getElementById('conf-ok');
    const alt    = document.getElementById('conf-alt');
    const cancel = document.getElementById('conf-cancel');
    ok.textContent  = okLabel;
    alt.textContent = altLabel;
    alt.classList.remove('hidden');
    overlay.classList.add('show');
    function cleanup(v) {
      overlay.classList.remove('show');
      alt.classList.add('hidden');
      ok.removeEventListener('click', onOk);
      alt.removeEventListener('click', onAlt);
      cancel.removeEventListener('click', onCancel);
      res(v);
    }
    function onOk()     { cleanup('ok');  }
    function onAlt()    { cleanup('alt'); }
    function onCancel() { cleanup(null);  }
    ok.addEventListener('click', onOk);
    alt.addEventListener('click', onAlt);
    cancel.addEventListener('click', onCancel);
  });
}

// ─── INFO MODAL ───────────────────────────────────────────────
function showInfoModal(trackIds) {
  const selected = trackIds.map(id => tracks.find(t => t.id === id)).filter(Boolean);
  if (!selected.length) return;

  const isSingle = selected.length === 1;
  const overlay  = document.getElementById('info-overlay');
  const titleEl  = document.getElementById('info-title');
  const rowName  = document.getElementById('info-row-name');
  const readonly = document.getElementById('info-readonly');
  const nameIn   = document.getElementById('info-name');
  const artistIn = document.getElementById('info-artist');
  const albumIn  = document.getElementById('info-album');
  const trackIn       = document.getElementById('info-trackNum');
  const releaseDateIn = document.getElementById('info-releaseDate');
  const bpmIn      = document.getElementById('info-bpm');
  const timeSigSel = document.getElementById('info-timesig');
  const keyRootSel = document.getElementById('info-key-root');
  const keyModeBtn = document.getElementById('info-key-mode');
  const keyRow     = document.getElementById('info-row-key');

  titleEl.textContent = isSingle ? 'Song Info' : `Info — ${selected.length} Songs`;
  rowName.style.display  = isSingle ? '' : 'none';
  readonly.style.display = isSingle ? '' : 'none';
  const artRow   = document.getElementById('info-art-row');
  const thumbBox = document.getElementById('info-art-thumb');
  artRow.style.display = isSingle ? '' : 'none';
  if (isSingle) {
    thumbBox.innerHTML = '';
    const cached = ArtworkManager.getCachedArtwork(selected[0]);
    if (cached) {
      const img = document.createElement('img'); img.src = cached; thumbBox.appendChild(img);
    } else {
      thumbBox.textContent = '♪';
    }
    document.getElementById('info-art-btn').onclick = () => {
      artFileInputKey = ArtworkManager.artworkKeyFor(selected[0]);
      artFileInput.value = '';
      artFileInput.click();
    };
  }

  if (isSingle) {
    const t = selected[0];
    nameIn.value   = t.name   || '';
    artistIn.value = t.artist || '';
    albumIn.value  = t.album  || '';
    trackIn.value       = t.trackNumber || '';
    releaseDateIn.value = t.releaseDate || '';
    bpmIn.value = t.bpm || '';
    bpmIn.placeholder = '';
    timeSigSel.value = t.timeSig || '';
    // read-only fields
    document.getElementById('info-format').textContent = t.format || '—';
    document.getElementById('info-dur').textContent    = t.duration ? formatTime(t.duration) : '—';
    document.getElementById('info-size').textContent   = t.size ? formatSize(t.size) : '—';
    document.getElementById('info-added').textContent  = t.addedAt ? new Date(t.addedAt).toLocaleDateString() : '—';
    artistIn.placeholder = '';
    albumIn.placeholder  = '';
    trackIn.placeholder  = '';
    // Key picker
    keyRow.style.display = '';
    const mode = t.keyMode || 'major';
    keyModeBtn.dataset.mode = mode;
    keyModeBtn.textContent  = mode === 'major' ? 'Major' : 'Minor';
    keyModeBtn.classList.toggle('minor', mode === 'minor');
    populateKeyRootSelect(keyRootSel, mode, t.keyRoot != null ? t.keyRoot : null);
  } else {
    nameIn.value = '';
    // For each shared field: pre-fill if all tracks match, else blank + placeholder
    const allArtists = [...new Set(selected.map(t => t.artist || ''))];
    const allAlbums  = [...new Set(selected.map(t => t.album  || ''))];
    const allNums    = [...new Set(selected.map(t => t.trackNumber || 0))];
    const allDates   = [...new Set(selected.map(t => t.releaseDate || ''))];
    artistIn.value        = allArtists.length === 1 ? allArtists[0] : '';
    albumIn.value         = allAlbums.length  === 1 ? allAlbums[0]  : '';
    trackIn.value         = allNums.length    === 1 ? (allNums[0] || '') : '';
    releaseDateIn.value   = allDates.length   === 1 ? allDates[0]   : '';
    artistIn.placeholder  = allArtists.length > 1 ? 'Multiple Values' : '';
    albumIn.placeholder   = allAlbums.length  > 1 ? 'Multiple Values' : '';
    trackIn.placeholder   = allNums.length    > 1 ? '—'               : '';
    releaseDateIn.placeholder = allDates.length > 1 ? 'Multiple Values' : '';
    const allBpms = [...new Set(selected.map(t => t.bpm || ''))];
    bpmIn.value       = allBpms.length === 1 ? (allBpms[0] || '') : '';
    bpmIn.placeholder = allBpms.length > 1 ? 'Multiple Values' : '';
    const allTimeSigs = [...new Set(selected.map(t => t.timeSig || ''))];
    timeSigSel.value  = allTimeSigs.length === 1 ? (allTimeSigs[0] || '') : '';
    keyRow.style.display = 'none';
    populateKeyRootSelect(keyRootSel, 'major', null);
  }

  keyModeBtn.onclick = () => {
    const newMode = keyModeBtn.dataset.mode === 'major' ? 'minor' : 'major';
    keyModeBtn.dataset.mode = newMode;
    keyModeBtn.textContent  = newMode === 'major' ? 'Major' : 'Minor';
    keyModeBtn.classList.toggle('minor', newMode === 'minor');
    const cur = keyRootSel.value !== '' ? parseInt(keyRootSel.value, 10) : null;
    populateKeyRootSelect(keyRootSel, newMode, cur);
  };

  overlay.classList.add('show');
  (isSingle ? nameIn : artistIn).focus();

  function cleanup() {
    overlay.classList.remove('show');
    document.getElementById('info-ok').removeEventListener('click', onSave);
    document.getElementById('info-cancel').removeEventListener('click', onCancel);
    overlay.removeEventListener('click', onOverlayClick);
    overlay.removeEventListener('keydown', onKey);
  }
  async function onSave() {
    cleanup();
    for (const t of selected) {
      const updates = { id: t.id };
      if (isSingle) {
        const n = nameIn.value.trim();
        if (n) updates.name = n;
      }
      // For bulk: only apply if user typed something (non-empty = override all)
      const a = artistIn.value.trim();
      const b = albumIn.value.trim();
      const n = parseInt(trackIn.value, 10);
      const d = releaseDateIn.value.trim();
      if (a !== '' || isSingle) updates.artist = a;
      if (b !== '' || isSingle) updates.album  = b;
      if (!isNaN(n) && trackIn.value.trim() !== '') updates.trackNumber = n;
      if (d !== '' || isSingle) updates.releaseDate = d;
      // BPM (single and bulk)
      const bpmStr = bpmIn.value.trim();
      const bpmVal = parseFloat(bpmStr);
      if (!isNaN(bpmVal) && bpmVal >= 1 && bpmVal <= 400) updates.bpm = bpmVal;
      else if (isSingle) updates.bpm = null;
      // Time Signature (single and bulk)
      const tsVal = timeSigSel.value;
      if (tsVal) updates.timeSig = tsVal;
      else if (isSingle) updates.timeSig = null;
      // Key (single only)
      if (isSingle) {
        const rootStr = keyRootSel.value;
        if (rootStr !== '') {
          updates.keyRoot = parseInt(rootStr, 10);
          updates.keyMode = keyModeBtn.dataset.mode;
        } else {
          updates.keyRoot = null;
          updates.keyMode = null;
        }
      }
      Object.assign(t, updates);
      await LibraryManager.saveMeta(updates);
    }
    renderCurrentTab();
    if (selected.some(t => t.id === currentPlayingId)) {
      const pt = tracks.find(t => t.id === currentPlayingId);
      if (pt) showMiniplayer(pt.id);
    }
    notify(isSingle ? 'Info saved' : `Updated ${selected.length} tracks`, '');
  }
  function onCancel() { cleanup(); }
  function onOverlayClick(e) { if (e.target === overlay) cleanup(); }
  function onKey(e) { if (e.key === 'Enter') { e.preventDefault(); onSave(); } }

  document.getElementById('info-ok').addEventListener('click', onSave);
  document.getElementById('info-cancel').addEventListener('click', onCancel);
  overlay.addEventListener('click', onOverlayClick);
  overlay.addEventListener('keydown', onKey);
}

// ─── CHORD CHART MODAL ────────────────────────────────────
let chordModalTrackId = null;
let chordBlobUrls = [];

// Returns true if s looks like a chord name (B, C#m, Gmaj7, D/F#, etc.)
function isChordName(s) {
  return /^[A-G][#b]?(?:m(?:aj)?|min|dim|aug|sus[24]?|add\d*|no\d*|\d+|[#b]|\/[A-G][#b]?)*$/i.test(s.trim());
}

function renderChart(content, container, fontSize) {
  container.style.fontSize = fontSize + 'px';

  function tokenizeLine(line) {
    const parts = line.split(/(\[[^\]]*\])/);
    const tokens = [];
    let pendingChord = '';
    for (const p of parts) {
      if (p.startsWith('[') && p.endsWith(']')) {
        const inner = p.slice(1, -1);
        const words = inner.trim().split(/\s+/);
        if (words.length > 1 && words.every(w => isChordName(w))) {
          if (pendingChord) { tokens.push({ chord: pendingChord, lyric: '' }); pendingChord = ''; }
          words.forEach(c => tokens.push({ chord: c, lyric: '' }));
        } else {
          if (pendingChord) { tokens.push({ chord: pendingChord, lyric: '' }); }
          pendingChord = inner;
        }
      } else {
        tokens.push({ chord: pendingChord, lyric: p });
        pendingChord = '';
      }
    }
    if (pendingChord) tokens.push({ chord: pendingChord, lyric: '' });
    return tokens;
  }

  const lines = content.split('\n');
  let html = '';

  for (const line of lines) {
    const commentMatch = line.match(/^\{(?:comment|c):\s*(.*?)\s*\}$/i);
    if (commentMatch) {
      html += `<div class="cp-section-label">${escHtml(commentMatch[1].toUpperCase())}</div>`;
      continue;
    }

    if (/^\{[^}]+\}$/.test(line.trim())) continue;

    if (!line.trim()) { html += `<div style="height:10px"></div>`; continue; }

    const tokens = tokenizeLine(line);
    const hasChord = tokens.some(t => t.chord);

    if (!hasChord) {
      html += `<div class="cp-annotation">${escHtml(line)}</div>`;
      continue;
    }

    const hasLyric = tokens.some(t => t.lyric.trim());

    if (!hasLyric) {
      html += `<div class="cp-chord-row">` +
        tokens.filter(t => t.chord).map(t => `<span class="cp-chord-solo">${escHtml(t.chord)}</span>`).join('') +
        `</div>`;
    } else {
      const spans = tokens.map(t => {
        const cLen = t.chord.length;
        const lLen = t.lyric.length;
        const minW = Math.max(cLen, lLen) * 9;
        const style = minW > 0 ? ` style="min-width:${minW}px"` : '';
        return `<span class="cp-token"${style}>` +
          (t.chord
            ? `<span class="cp-chord">${escHtml(t.chord)}</span>`
            : `<span class="cp-chord cp-chord-empty">&#x200b;</span>`) +
          `<span class="cp-lyric">${escHtml(t.lyric) || ' '}</span>` +
          `</span>`;
      }).join('');
      html += `<div class="cp-line">${spans}</div>`;
    }
  }

  container.innerHTML = html;
}

function showChordModal(trackId) {
  const track = tracks.find(t => t.id === trackId);
  if (!track) return;
  chordModalTrackId = trackId;
  chordBlobUrls = [];

  let mode = (track.chordPro || track.chordPdf) ? 'view' : 'edit';
  let dirty = false;
  let savedContent = track.chordPro || '';
  let fontSize = 14;
  let pendingChordPdf = null;
  let pendingChordPdfCleared = false;

  const overlay    = document.getElementById('chord-overlay');
  const toolbar    = document.getElementById('chord-toolbar');
  const viewPane   = document.getElementById('chord-view-content');
  const editPane   = document.getElementById('chord-edit-content');
  const footer     = document.getElementById('chord-footer');
  const banner     = document.getElementById('chord-unsaved-banner');
  const editor     = document.getElementById('chord-editor');
  const render     = document.getElementById('chord-chart-render');
  const pdfPreview = document.getElementById('chord-pdf-preview');
  const pdfInput   = document.getElementById('chord-pdf-input');

  overlay.classList.add('show');
  document.getElementById('chord-title').textContent = track.name;

  if (track.chordPdf) {
    const blob = new Blob([track.chordPdf], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    chordBlobUrls.push(url);
    pdfPreview.innerHTML = `<iframe src="${url}" style="width:100%;height:220px;border:none;border-radius:3px"></iframe>`;
    pdfPreview.style.display = '';
  }

  function setMode(m) {
    mode = m;
    document.querySelectorAll('.mode-btn').forEach(btn =>
      btn.classList.toggle('active', btn.dataset.mode === m)
    );
    if (m === 'view') {
      toolbar.style.display = 'none';
      editPane.style.display = 'none';
      footer.style.display = 'none';
      viewPane.style.display = '';
      banner.style.display = dirty ? '' : 'none';
      renderChart(savedContent, render, fontSize);
    } else {
      toolbar.style.display = '';
      editPane.style.display = '';
      footer.style.display = '';
      viewPane.style.display = 'none';
      banner.style.display = 'none';
      editor.value = savedContent;
    }
  }

  function hideBanner() { banner.style.display = 'none'; }

  async function saveChanges() {
    const t = tracks.find(x => x.id === chordModalTrackId);
    if (!t) return;
    savedContent = editor.value;
    if (pendingChordPdf) {
      t.chordPdf = pendingChordPdf;
    } else if (pendingChordPdfCleared) {
      t.chordPdf = null;
    }
    t.chordPro = savedContent || null;
    dirty = false;
    hideBanner();
    try {
      const { arrayBuffer, ...meta } = t;
      if (meta.chordPdf) meta.chordPdf = meta.chordPdf.slice(0);
      await LibraryManager.saveMeta(meta);
    } catch(e) {
      console.warn('Chord save failed:', e);
    }
    renderCurrentTab();
    document.querySelectorAll(`.row-chord-btn[data-chord-id="${CSS.escape(t.id)}"]`).forEach(btn => {
      btn.classList.toggle('has-chart', !!(t.chordPdf || t.chordPro));
    });
    setMode('view');
    showSavedToast();
  }

  function showSavedToast() {
    const toast = document.getElementById('saved-toast');
    toast.style.opacity = '';
    toast.style.transition = '';
    toast.classList.remove('toast-pop');
    void toast.offsetWidth; // force reflow so animation restarts
    toast.classList.add('toast-pop');
    setTimeout(() => {
      toast.style.transition = 'opacity 0.2s ease';
      toast.style.opacity = '0';
      setTimeout(() => {
        toast.classList.remove('toast-pop');
        toast.style.transition = '';
      }, 200);
    }, 2000);
  }

  function discardChanges() {
    editor.value = savedContent;
    dirty = false;
    setMode('view');
  }

  function cleanup() {
    overlay.classList.remove('show');
    chordBlobUrls.forEach(u => URL.revokeObjectURL(u));
    chordBlobUrls = [];
    pdfPreview.style.display = 'none';
    pdfPreview.innerHTML = '';
    banner.style.display = 'none';
    document.getElementById('chord-syntax-popover').style.display = 'none';
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('chord-pdf-upload').removeEventListener('click', onUploadClick);
    pdfInput.removeEventListener('change', onFileChange);
    editor.removeEventListener('input', onEditorInput);
    document.getElementById('chord-clear-btn').removeEventListener('click', onClearClick);
    document.getElementById('chord-syntax-btn').removeEventListener('click', onSyntaxClick);
    document.getElementById('chord-unsaved-save').removeEventListener('click', onUnsavedSave);
    document.getElementById('chord-save').removeEventListener('click', saveChanges);
    document.getElementById('chord-discard').removeEventListener('click', discardChanges);
    document.getElementById('chord-close').removeEventListener('click', cleanup);
    document.querySelectorAll('.mode-btn').forEach(b => b.removeEventListener('click', onModeClick));
    overlay.removeEventListener('click', onOverlayClick);
    overlay.removeEventListener('keydown', onKey);
    document.removeEventListener('click', onDocClick);
  }

  function onModeClick(e) {
    const m = e.currentTarget.dataset.mode;
    if (m === mode) return;
    setMode(m);
  }
  document.querySelectorAll('.mode-btn').forEach(b => b.addEventListener('click', onModeClick));

  function onUploadClick() { pdfInput.value = ''; pdfInput.click(); }
  function onFileChange() {
    const file = pdfInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      pendingChordPdf = ev.target.result;
      pendingChordPdfCleared = false;
      const blob = new Blob([pendingChordPdf], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      chordBlobUrls.push(url);
      pdfPreview.innerHTML = `<iframe src="${url}" style="width:100%;height:220px;border:none;border-radius:3px"></iframe>`;
      pdfPreview.style.display = '';
      dirty = true;
    };
    reader.readAsArrayBuffer(file);
  }
  document.getElementById('chord-pdf-upload').addEventListener('click', onUploadClick);
  pdfInput.addEventListener('change', onFileChange);

  function onEditorInput() { dirty = true; }
  editor.addEventListener('input', onEditorInput);

  function onClearClick() {
    if (!confirm('Clear all chord data?')) return;
    editor.value = '';
    pendingChordPdf = null;
    pendingChordPdfCleared = true;
    pdfPreview.style.display = 'none';
    pdfPreview.innerHTML = '';
    dirty = true;
  }
  document.getElementById('chord-clear-btn').addEventListener('click', onClearClick);

  const syntaxPopover = document.getElementById('chord-syntax-popover');
  function onSyntaxClick(e) {
    e.stopPropagation();
    syntaxPopover.style.display = syntaxPopover.style.display === 'none' ? '' : 'none';
  }
  function onDocClick() { syntaxPopover.style.display = 'none'; }
  document.getElementById('chord-syntax-btn').addEventListener('click', onSyntaxClick);
  document.addEventListener('click', onDocClick);

  function onUnsavedSave(e) { e.preventDefault(); saveChanges(); }
  document.getElementById('chord-unsaved-save').addEventListener('click', onUnsavedSave);

  document.getElementById('chord-font-dec').onclick = () => {
    fontSize = Math.max(11, fontSize - 1);
    renderChart(savedContent, render, fontSize);
  };
  document.getElementById('chord-font-inc').onclick = () => {
    fontSize = Math.min(20, fontSize + 1);
    renderChart(savedContent, render, fontSize);
  };

  document.getElementById('chord-save').addEventListener('click', saveChanges);
  document.getElementById('chord-discard').addEventListener('click', discardChanges);

  document.getElementById('chord-close').addEventListener('click', cleanup);
  function onOverlayClick(e) { if (e.target === overlay) cleanup(); }
  function onKey(e) { if (e.key === 'Escape') cleanup(); }
  overlay.addEventListener('click', onOverlayClick);
  overlay.addEventListener('keydown', onKey);

  setMode(mode);
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function parseTrackNumber(raw) {
  if (!raw) return 0;
  const n = parseInt(String(raw).split('/')[0], 10);
  return isNaN(n) ? 0 : n;
}

// Returns the first non-empty releaseDate found among a list of tracks
function albumReleaseYear(trks) {
  return (trks.find(t => t.releaseDate) || {}).releaseDate || '';
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


// ─── LIBRARY LOAD STATE ──────────────────────────────────────
let libraryLoaded = false;

// ─── SORT / SEARCH STATE ─────────────────────────────────────
let songsSortField = localStorage.getItem('songs_sort_field') || 'name';
let songsSortDir   = localStorage.getItem('songs_sort_dir')   || 'asc';
let searchQuery    = '';

function matchesSearch(track) {
  if (!searchQuery) return true;
  const q = searchQuery.toLowerCase();
  return (track.name   || '').toLowerCase().includes(q)
      || (track.artist || '').toLowerCase().includes(q)
      || (track.album  || '').toLowerCase().includes(q);
}

function getSortedFilteredTracks() {
  const source = searchQuery ? tracks.filter(matchesSearch) : tracks;
  const dir = songsSortDir === 'asc' ? 1 : -1;
  // Pre-compute album→year so all tracks from same album sort as a unit
  const albumYearMap = new Map();
  if (songsSortField === 'album') {
    tracks.forEach(t => {
      const key = (t.album || '').trim();
      if (t.releaseDate && !albumYearMap.has(key)) albumYearMap.set(key, t.releaseDate);
    });
  }
  return [...source].sort((a, b) => {
    switch (songsSortField) {
      case 'artist': {
        const c = (a.artist || '').localeCompare(b.artist || '');
        return c !== 0 ? dir * c : (a.name || '').localeCompare(b.name || '');
      }
      case 'album': {
        const ya = albumYearMap.get((a.album || '').trim()) || '';
        const yb = albumYearMap.get((b.album || '').trim()) || '';
        if (!ya && !yb) {
          const c = (a.album || '').localeCompare(b.album || '');
          if (c !== 0) return c;
          const ta = a.trackNumber || 0, tb = b.trackNumber || 0;
          if (ta !== tb) return ta - tb;
          return (a.name || '').localeCompare(b.name || '');
        }
        if (!ya) return 1;
        if (!yb) return -1;
        const c = yb.localeCompare(ya); // newest first when dir=asc(1)
        if (c !== 0) return dir * c;
        const ca = (a.album || '').localeCompare(b.album || '');
        if (ca !== 0) return ca;
        const ta = a.trackNumber || 0, tb = b.trackNumber || 0;
        if (ta !== tb) return ta - tb;
        return (a.name || '').localeCompare(b.name || '');
      }
      case 'addedAt':  return dir * ((a.addedAt  || 0) - (b.addedAt  || 0));
      case 'duration': return dir * ((a.duration || 0) - (b.duration || 0));
      case 'bpm':      return dir * ((a.bpm || 0) - (b.bpm || 0));
      default:         return dir * (a.name || '').localeCompare(b.name || '');
    }
  });
}

// ─── SELECTION STATE ─────────────────────────────────────────
let selectedIds = new Set();
let selectedPlSlotIndices = new Set(); // playlist selection by slot index (independent of track ID)
let lastSelectedIdx = -1;
// Ordered list of tracks currently visible in the active view — used for shift-range selection
let visibleTracks = [];

function updateSelectionClasses() {
  document.querySelectorAll('#track-list .track-row[data-id]').forEach(r => {
    if (r.closest('.pl-track-list')) {
      const slotIdx = parseInt(r.dataset.plIdx, 10);
      r.classList.toggle('selected', selectedPlSlotIndices.has(slotIdx));
    } else {
      r.classList.toggle('selected', selectedIds.has(r.dataset.id));
    }
  });
}

// ─── MINIPLAYER ───────────────────────────────────────────────
let currentPlayingId = null;
let currentRustTrackId = null; // which track is currently loaded in the Rust engine
let seeking = false;
let seekFrac = 0;
let loopDragHandle = null;

function updateLocateBtn() {
  const btn = document.getElementById('lib-locate-btn');
  if (btn) btn.classList.toggle('hidden', !currentPlayingId);
}

function buildMarqueeInner(text, dist, gap) {
  const inner = document.createElement('span');
  inner.className = 'mp-marquee-inner';
  inner.appendChild(document.createTextNode(text));
  const spacer = document.createElement('span');
  spacer.style.cssText = `display:inline-block;width:${gap}px`;
  inner.appendChild(spacer);
  inner.appendChild(document.createTextNode(text));
  const scrollDur = Math.max(dist / 17.5, 12) * 1000;
  inner.animate([
    { transform: 'translateX(0)', offset: 0 },
    { transform: 'translateX(0)', offset: 1000 / (scrollDur + 1000) },
    { transform: `translateX(-${dist}px)`, offset: 1 },
  ], { duration: scrollDur + 1000, iterations: Infinity, easing: 'linear' });
  return inner;
}

function setMarqueeText(el, text) {
  el.classList.remove('mp-marquee');
  el.textContent = text;
  requestAnimationFrame(() => {
    if (el.scrollWidth <= el.offsetWidth) return;
    const textWidth = el.scrollWidth;
    const gap = Math.round(parseFloat(getComputedStyle(el).fontSize) * 1.8); // ~3 chars
    const dist = textWidth + gap;
    el.textContent = '';
    el.appendChild(buildMarqueeInner(text, dist, gap));
    el.classList.add('mp-marquee');
  });
}

function setSyncedMarqueeTexts(pairs) {
  pairs.forEach(({ el, text }) => {
    el.classList.remove('mp-marquee');
    el.textContent = text;
  });
  requestAnimationFrame(() => {
    const configs = pairs.map(({ el, text }) => {
      if (el.scrollWidth <= el.offsetWidth) return null;
      const textWidth = el.scrollWidth;
      const gap = Math.round(parseFloat(getComputedStyle(el).fontSize) * 1.8);
      const dist = textWidth + gap;
      return { el, text, dist, gap };
    }).filter(Boolean);
    if (configs.length === 0) return;
    const maxScrollDur = Math.max(...configs.map(c => Math.max(c.dist / 17.5, 12))) * 1000;
    const totalDur = maxScrollDur + 1000;
    const pauseFraction = 1000 / totalDur;
    const startTime = document.timeline.currentTime;
    configs.forEach(({ el, text, dist, gap }) => {
      el.textContent = '';
      const inner = buildMarqueeInner(text, dist, gap);
      el.appendChild(inner);
      el.classList.add('mp-marquee');
      // Override animation with shared duration and start time for sync
      inner.getAnimations().forEach(a => a.cancel());
      const anim = inner.animate([
        { transform: 'translateX(0)', offset: 0 },
        { transform: 'translateX(0)', offset: pauseFraction },
        { transform: `translateX(-${dist}px)`, offset: 1 },
      ], { duration: totalDur, iterations: Infinity, easing: 'linear' });
      anim.startTime = startTime;
    });
  });
}

function showMiniplayer(trackId) {
  const track = tracks.find(t => t.id === trackId);
  if (!track) return;
  currentPlayingId = trackId;
  delete document.getElementById('bb-track').dataset.empty;
  updateLocateBtn();
  const mpAlbum = track.album ? (track.releaseDate ? `${track.album} (${track.releaseDate})` : track.album) : '';
  setSyncedMarqueeTexts([
    { el: document.getElementById('mp-track-name'), text: track.name },
    { el: document.getElementById('mp-track-sub'), text: (track.artist && mpAlbum) ? track.artist + ' \u2014 ' + mpAlbum : (track.artist || mpAlbum || '—') },
  ]);
  const st = track.semitones || 0;
  const mpCents = track.cents ?? 0;
  const hasOffset = st !== 0 || mpCents !== 0;
  const mpStVal = document.getElementById('mp-semitones-val');
  mpStVal.textContent = miniplayerXposeLabel(track);
  mpStVal.classList.toggle('xpose-active', hasOffset);
  document.getElementById('mp-xpose-reset').classList.toggle('xpose-reset-visible', hasOffset);
  if (track.bpm) { Metronome.setBpm(track.bpm); syncMetroMini(); }
  if (track.timeSig) {
    const [num, den] = track.timeSig.split('/').map(Number);
    if (num && den) { applyTimeSignature(num, den); renderBeatDots(num); }
  }
  syncMiniplayerPlayBtn(true);
  resetSpeedSlider();
  const player = players[trackId];
  const totalStr = player && player.duration ? formatTime(player.duration) : '--:--';
  setTimeDisplay('0:00', totalStr);

  // Set guard BEFORE touching canvas — any in-flight async decode for a previous
  // track will bail out when it checks _waveformForTrackId !== its own trackId.
  _waveformForTrackId = trackId;

  // Explicit clear so no stale pixels from the previous track bleed through.
  if (mpWaveformCanvas) {
    const wCtx = mpWaveformCanvas.getContext('2d');
    wCtx.clearRect(0, 0, mpWaveformCanvas.width, mpWaveformCanvas.height);
  }

  currentPlayerPeaks = track.peaks?.length ? track.peaks : null;
  _waveformLayers    = null;
  currentPlayProgress = 0;
  _lastFrac = 0; _lastMs = performance.now(); _lastDuration = track.duration || 0;
  setScrubFrac(0);

  // If peaks were cached, pre-build layers immediately.
  if (currentPlayerPeaks) {
    _rebuildWaveformLayers();
  } else if (track.filePath) {
    // If peaks weren't cached, kick off the JS-side decode pipeline.
    // The three _waveformForTrackId guards inside prevent a stale decode from
    // painting after the user has already switched to a different track.
    _loadWaveformFromFile(trackId, track.filePath);
  }

  // Sync loop handles and state for this track
  if (player) {
    updateLoopOverlays(player);
    syncLoopActiveState(player);
    syncLoopTimesDisplay(player);
  }

  // Load artwork
  const mpArtImg = document.getElementById('mp-art-img');
  const mpArtPlaceholder = document.querySelector('.mp-art-placeholder');
  const artKey = ArtworkManager.artworkKeyFor(track);
  LibraryManager.getArtwork(artKey).then(dataUrl => {
    if (dataUrl) {
      mpArtImg.src = dataUrl;
      mpArtImg.style.display = 'block';
      if (mpArtPlaceholder) mpArtPlaceholder.style.display = 'none';
    } else {
      mpArtImg.style.display = 'none';
      if (mpArtPlaceholder) mpArtPlaceholder.style.display = '';
    }
    updateMediaSessionMetadata(track, dataUrl);
  }).catch(() => {
    mpArtImg.style.display = 'none';
    if (mpArtPlaceholder) mpArtPlaceholder.style.display = '';
    updateMediaSessionMetadata(track, null);
  });
}

function updateMediaSessionMetadata(track, artDataUrl) {
  if (!('mediaSession' in navigator)) return;
  const artwork = artDataUrl ? [{ src: artDataUrl }] : [];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.name,
    artist: track.artist || '',
    album: track.album || '',
    artwork,
  });
}

function hideMiniplayer() {
  currentPlayingId = null;
  document.getElementById('bb-track').dataset.empty = '';
  setMarqueeText(document.getElementById('mp-track-name'), 'No track selected');
  setMarqueeText(document.getElementById('mp-track-sub'), '');
  syncMiniplayerPlayBtn(false);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
  const mpStVal = document.getElementById('mp-semitones-val');
  mpStVal.textContent = '0';
  mpStVal.classList.remove('xpose-active');
  document.getElementById('mp-xpose-reset').classList.remove('xpose-reset-visible');
  setTimeDisplay('0:00', '--:--');
  _waveformForTrackId = null; // abort any in-flight waveform load
  currentPlayerPeaks = null;
  _waveformLayers    = null;
  currentPlayProgress = 0;
  _lastFrac = 0; _lastMs = 0; _lastDuration = 0;
  setScrubFrac(0);
  document.getElementById('mp-loop-times').classList.add('hidden');
  document.getElementById('mp-loop-btn').classList.remove('loop-active');
  document.getElementById('mp-loop-region').classList.remove('loop-active');
  document.getElementById('mp-loop-region').classList.add('hidden');
  document.getElementById('mp-loop-handle-in').classList.remove('loop-active');
  document.getElementById('mp-loop-handle-out').classList.remove('loop-active');
  resetSpeedSlider();
  const mpArtImg = document.getElementById('mp-art-img');
  if (mpArtImg) { mpArtImg.src = ''; mpArtImg.style.display = 'none'; }
  const mpArtPlaceholder = document.querySelector('.mp-art-placeholder');
  if (mpArtPlaceholder) mpArtPlaceholder.style.display = '';
}

function resetSpeedSlider() {
  const sl = document.getElementById('mp-speed');
  sl.value = 50;
  const valEl = document.getElementById('mp-speed-val');
  valEl.textContent = '100%';
  valEl.classList.remove('speed-active');
  updateRangeFill(sl);
}

function syncMiniplayerPlayBtn(isPlaying) {
  const btn = document.getElementById('mp-play');
  btn.innerHTML = isPlaying ? ICONS.pause : ICONS.play;
  btn.classList.toggle('is-paused', isPlaying);
  btn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  }
}

function setTimeDisplay(elapsed, total) {
  document.getElementById('mp-time-elapsed').textContent = elapsed;
  document.getElementById('mp-time-total').textContent   = total;
}

function updateMiniplayerProgress(frac, t, duration) {
  if (seeking) return;
  // Suppress events that arrive before Rust has processed the last seek —
  // they carry the old frame counter and would snap the playhead back.
  if (performance.now() - _seekAt < SEEK_GRACE_MS) return;
  // Anchor the rAF interpolation to this confirmed position.
  _lastFrac     = frac;
  _lastMs       = performance.now();
  _lastDuration = duration;
  setTimeDisplay(formatTime(t), formatTime(duration));
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
  } else if (player._loaded && player._paused) {
    if (player._seekedWhilePaused) {
      // Seeked while paused — must rebuild source at new position
      player._seekedWhilePaused = false;
      player._paused = false;
      player._masterVolume = masterVolume;
    const effectiveVol = player.volume * masterVolume;
      player.play(player.pauseOffset, effectiveVol).then(() => {
        syncMiniplayerPlayBtn(true);
        renderCurrentTab();
      });
    } else {
      // Resume from pause — rodio sink.play() continues without source rebuild
      player.resume().then(() => {
        syncMiniplayerPlayBtn(true);
        renderCurrentTab();
      });
    }
  } else {
    playTrack(currentPlayingId);
  }
});

document.addEventListener('keydown', (e) => {
  // Media keys (Firefox dispatches these as keydown; Chrome handles via mediaSession)
  switch (e.key) {
    case 'MediaPlayPause':
      e.preventDefault();
      document.getElementById('mp-play').click();
      return;
    case 'MediaPlay':
      e.preventDefault();
      if (!players[currentPlayingId]?.isPlaying) document.getElementById('mp-play').click();
      return;
    case 'MediaPause':
      e.preventDefault();
      if (players[currentPlayingId]?.isPlaying) document.getElementById('mp-play').click();
      return;
    case 'MediaStop':
      e.preventDefault();
      if (currentPlayingId && players[currentPlayingId]) {
        players[currentPlayingId].stop();
        hideMiniplayer();
        renderCurrentTab();
      }
      return;
    case 'MediaTrackNext':
      e.preventDefault();
      document.getElementById('mp-next').click();
      return;
    case 'MediaTrackPrevious':
      e.preventDefault();
      document.getElementById('mp-prev').click();
      return;
  }
  // Focus search works from anywhere, even inside inputs
  if (matchShortcut(e, 'focus-search')) {
    e.preventDefault();
    document.getElementById('lib-search').focus();
    return;
  }

  // Guard: skip shortcuts when typing in inputs
  const kbTag = e.target.tagName;
  const inInput = kbTag === 'INPUT' || kbTag === 'TEXTAREA' || e.target.isContentEditable;
  if (!inInput) {
    if (matchShortcut(e, 'prev-track'))   { e.preventDefault(); document.getElementById('mp-prev').click(); return; }
    if (matchShortcut(e, 'next-track'))   { e.preventDefault(); document.getElementById('mp-next').click(); return; }
    if (matchShortcut(e, 'tap-tempo'))    { e.preventDefault(); document.getElementById('mm-tap-btn').click(); return; }
    if (matchShortcut(e, 'metro-toggle')) { e.preventDefault(); toggleMetronome(); return; }

    if (currentPlayingId) {
      const lp = players[currentPlayingId];
      if (lp) {
        if (matchShortcut(e, 'loop-toggle')) { e.preventDefault(); document.getElementById('mp-loop-btn').click(); return; }
        if (matchShortcut(e, 'seek-back-5'))  { e.preventDefault(); seekPlayer(lp, (lp.currentTime - 5)  / lp.duration); return; }
        if (matchShortcut(e, 'seek-fwd-5'))   { e.preventDefault(); seekPlayer(lp, (lp.currentTime + 5)  / lp.duration); return; }
        if (matchShortcut(e, 'seek-back-15')) { e.preventDefault(); seekPlayer(lp, (lp.currentTime - 15) / lp.duration); return; }
        if (matchShortcut(e, 'seek-fwd-15'))  { e.preventDefault(); seekPlayer(lp, (lp.currentTime + 15) / lp.duration); return; }
        const minGap = Math.max(0.005, 0.1 / (lp.duration || 1));
        if (matchShortcut(e, 'loop-in')) {
          e.preventDefault();
          lp.setLoopPoints(Math.min(lp.currentTime / lp.duration, lp.loopEnd - minGap), lp.loopEnd);
          updateLoopOverlays(lp); syncLoopTimesDisplay(lp);
          return;
        }
        if (matchShortcut(e, 'loop-out')) {
          e.preventDefault();
          lp.setLoopPoints(lp.loopStart, Math.max(lp.currentTime / lp.duration, lp.loopStart + minGap));
          updateLoopOverlays(lp); syncLoopTimesDisplay(lp);
          return;
        }
      }
    }

    if (matchShortcut(e, 'play-pause')) { e.preventDefault(); document.getElementById('mp-play').click(); return; }
  }
});

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => {
    document.getElementById('mp-play').click();
  });
  navigator.mediaSession.setActionHandler('pause', () => {
    document.getElementById('mp-play').click();
  });
  navigator.mediaSession.setActionHandler('stop', () => {
    if (!currentPlayingId) return;
    const player = players[currentPlayingId];
    if (!player) return;
    player.stop();
    hideMiniplayer();
    renderCurrentTab();
  });
  navigator.mediaSession.setActionHandler('previoustrack', () => {
    document.getElementById('mp-prev').click();
  });
  navigator.mediaSession.setActionHandler('nexttrack', () => {
    document.getElementById('mp-next').click();
  });
}

// Returns the next track to auto-play when the current track ends,
// based on the active tab context at the time of the call.
function getAutoNextTrack(currentId) {
  // If playback was launched from a playlist, advance within that playlist
  if (activePlaylistId) {
    const pl = playlists.find(p => p.id === activePlaylistId);
    if (!pl) { activePlaylistId = null; currentPlayingSlotIdx = null; return null; }
    const nextSlotIdx = (currentPlayingSlotIdx ?? -1) + 1;
    const nextSlot = pl.slots[nextSlotIdx];
    if (!nextSlot) { activePlaylistId = null; currentPlayingSlotIdx = null; return null; }
    const track = tracks.find(t => t.id === nextSlot.trackId) || null;
    if (!track) return null;
    return { track, slotIdx: nextSlotIdx };
  }
  let list = [];
  if (activeTab === 'songs') {
    list = getSortedFilteredTracks();
  } else if (activeTab === 'artists' && currentArtistView !== null) {
    const groups = getArtistGroups();
    const entry = groups.find(([name]) => name === currentArtistView);
    list = entry ? entry[1] : [];
  } else if (activeTab === 'albums' && currentAlbumView !== null) {
    const groups = getAlbumGroups();
    const entry = groups.find(([name]) => name === currentAlbumView);
    list = entry ? entry[1] : [];
  }
  if (list.length === 0) return null;
  const idx = list.findIndex(t => t.id === currentId);
  if (idx === -1 || idx === list.length - 1) return null;
  return { track: list[idx + 1], slotIdx: null };
}

document.getElementById('mp-prev').addEventListener('click', () => {
  if (!currentPlayingId) return;
  const currentPlayer = players[currentPlayingId];
  if (currentPlayer && currentPlayer.currentTime >= 3) {
    seekPlayer(currentPlayer, 0);
    return;
  }
  if (activePlaylistId) {
    const pl = playlists.find(p => p.id === activePlaylistId);
    if (pl && currentPlayingSlotIdx !== null && currentPlayingSlotIdx > 0) {
      const prevSlotIdx = currentPlayingSlotIdx - 1;
      const prevSlot = pl.slots[prevSlotIdx];
      if (prevSlot) {
        const prev = tracks.find(t => t.id === prevSlot.trackId);
        if (prev) { if (players[prev.id]) players[prev.id].pauseOffset = 0; playTrack(prev.id, activePlaylistId, prevSlotIdx); return; }
      }
    }
  }
  const list = getSortedFilteredTracks();
  if (list.length < 2) return;
  const idx = list.findIndex(t => t.id === currentPlayingId);
  const prev = list[(idx - 1 + list.length) % list.length];
  if (players[prev.id]) players[prev.id].pauseOffset = 0;
  playTrack(prev.id);
});

document.getElementById('mp-next').addEventListener('click', () => {
  if (!currentPlayingId) return;
  if (activePlaylistId) {
    const pl = playlists.find(p => p.id === activePlaylistId);
    if (pl && currentPlayingSlotIdx !== null) {
      const nextSlotIdx = currentPlayingSlotIdx + 1;
      const nextSlot = pl.slots[nextSlotIdx];
      if (nextSlot) {
        const next = tracks.find(t => t.id === nextSlot.trackId);
        if (next) { if (players[next.id]) players[next.id].pauseOffset = 0; playTrack(next.id, activePlaylistId, nextSlotIdx); return; }
      }
    }
  }
  const list = getSortedFilteredTracks();
  if (list.length < 2) return;
  const idx = list.findIndex(t => t.id === currentPlayingId);
  const next = list[(idx + 1) % list.length];
  if (players[next.id]) players[next.id].pauseOffset = 0;
  playTrack(next.id);
});

document.getElementById('mp-xpose-dec').addEventListener('click', e => {
  if (!currentPlayingId) return;
  const track = tracks.find(t => t.id === currentPlayingId);
  if (!track) return;
  if (e.ctrlKey && e.shiftKey) applyCents(track.id, -10);
  else if (e.shiftKey)         applyCents(track.id, -1);
  else                         applyTranspose(track.id, (track.semitones || 0) - 1);
});
document.getElementById('mp-xpose-inc').addEventListener('click', e => {
  if (!currentPlayingId) return;
  const track = tracks.find(t => t.id === currentPlayingId);
  if (!track) return;
  if (e.ctrlKey && e.shiftKey) applyCents(track.id, 10);
  else if (e.shiftKey)         applyCents(track.id, 1);
  else                         applyTranspose(track.id, (track.semitones || 0) + 1);
});
document.getElementById('mp-xpose-reset').addEventListener('click', () => {
  if (!currentPlayingId) return;
  applyTranspose(currentPlayingId, 0, true);
});

document.getElementById('mp-semitones-val').addEventListener('click', () => {
  if (!currentPlayingId) return;
  const valEl = document.getElementById('mp-semitones-val');
  if (_xpPopTrackId === currentPlayingId) closeXposePopover();
  else openXposePopover(currentPlayingId, valEl);
});

document.getElementById('mp-vol').addEventListener('input', function() {
  masterVolume = this.value / 100;
  localStorage.setItem('masterVolume', this.value);
  updateRangeFill(this);
  if (currentPlayingId && players[currentPlayingId]) {
    const p = players[currentPlayingId];
    p._masterVolume = masterVolume;
    invoke('audio_set_volume', { volume: p._vol }).catch(() => {});
  }
});

function speedSliderToRate(v) {
  // v: 0–100, midpoint 50 = 100%
  // left half:  0–50  → 50%–100%
  // right half: 50–100 → 100%–125%
  const raw = v <= 50 ? 50 + v : 100 + (v - 50) * 0.5;
  return Math.round(raw / 5) * 5; // snap to nearest 5%
}

function speedSliderFromRate(pct) {
  // Inverse of speedSliderToRate: pct → slider value 0–100
  return pct <= 100 ? pct - 50 : 50 + (pct - 100) * 2;
}

document.getElementById('mp-speed').addEventListener('keydown', function(e) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' &&
      e.key !== 'ArrowUp'   && e.key !== 'ArrowDown') return;
  e.preventDefault();
  const currentPct = speedSliderToRate(parseFloat(this.value));
  const delta = (e.key === 'ArrowRight' || e.key === 'ArrowUp') ? 5 : -5;
  const newPct = Math.min(125, Math.max(50, currentPct + delta));
  this.value = speedSliderFromRate(newPct);
  this.dispatchEvent(new Event('input'));
});

document.getElementById('mp-speed').addEventListener('input', function() {
  const pct = speedSliderToRate(parseFloat(this.value));
  const rate = pct / 100;
  const isActive = pct !== 100;
  const valEl = document.getElementById('mp-speed-val');
  valEl.textContent = pct + '%';
  valEl.classList.toggle('speed-active', isActive);
  updateRangeFill(this);
  currentPlaybackRate = rate;
  if (currentPlayingId && players[currentPlayingId]) {
    players[currentPlayingId].setSpeed(rate);
  }
});

document.getElementById('mp-speed').addEventListener('dblclick', () => {
  currentPlaybackRate = 1.0;
  resetSpeedSlider();
  if (currentPlayingId && players[currentPlayingId]) {
    const player = players[currentPlayingId];
    player.setSpeed(1.0);
    if (player.isPlaying) player.play(player.currentTime);
  }
});

// ─── SCRUB BAR ──────────────────────────────────────────────
const mpScrubBar    = document.getElementById('mp-scrub-bar');
const mpScrubBall   = document.getElementById('mp-scrub-ball');
const mpWaveformCanvas = document.getElementById('mp-waveform-canvas');

let currentPlayerPeaks  = null;
let _waveformLayers     = null;
let currentPlayProgress = 0;

// Tracks which track the waveform canvas is rendering for.
// Every async waveform operation checks this before touching the canvas.
// Set to a trackId in showMiniplayer, cleared to null in hideMiniplayer.
let _waveformForTrackId = null;

// ─── JS-SIDE WAVEFORM PIPELINE ───────────────────────────────
// Used when Rust has no cached peaks yet. Fetches the audio file via
// the Tauri asset protocol, decodes it in the browser's AudioContext,
// and generates peaks. Three guard checks prevent stale results from
// overwriting the canvas after the user has switched tracks.

function _peaksFromAudioBuffer(audioBuffer, bucketCount = 600) {
  const data = audioBuffer.getChannelData(0);
  const spc  = Math.max(1, Math.floor(data.length / bucketCount));
  const out  = new Float32Array(bucketCount);
  for (let i = 0; i < bucketCount; i++) {
    let max = 0;
    const end = Math.min((i + 1) * spc, data.length);
    for (let j = i * spc; j < end; j++) {
      const a = Math.abs(data[j]);
      if (a > max) max = a;
    }
    out[i] = max;
  }
  return Array.from(out);
}

async function _loadWaveformFromFile(trackId, filePath) {
  try {
    const src = convertFileSrc(filePath.replace(/\\/g, '/'));
    const response = await fetch(src);
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${src}`);
    const ab = await response.arrayBuffer();

    if (_waveformForTrackId !== trackId) return; // switched away during fetch

    // Bail if peaks_ready already arrived from Rust while we were fetching.
    if (currentPlayerPeaks) return;

    // decodeAudioData detaches ab; pass a copy if ab is needed again (here it isn't).
    const decoded = await getCtx().decodeAudioData(ab);

    if (_waveformForTrackId !== trackId) return; // switched away during decode

    const peaks = _peaksFromAudioBuffer(decoded);

    if (_waveformForTrackId !== trackId) return; // final guard before paint

    // Persist so next play is instant.
    const track = tracks.find(t => t.id === trackId);
    if (track && !track.peaks?.length) {
      track.peaks = peaks;
      LibraryManager.saveMeta({ id: trackId, peaks }).catch(() => {});
    }

    currentPlayerPeaks = peaks;
    _rebuildWaveformLayers();
  } catch (err) {
    // Surface SecurityError / EncodingError so it's diagnosable.
    console.error(`[stagehand] waveform JS decode failed (${trackId}): ${err.name} — ${err.message}`);
  }
}

// Interpolation anchors — updated on every playback_progress event.
// The rAF loop advances from these between events for smooth 60 fps motion.
let _lastFrac       = 0;   // fraction at last event
let _lastMs         = 0;   // performance.now() at last event
let _lastDuration   = 0;   // audio duration at last event (seconds)
let currentPlaybackRate = 1.0; // kept in sync with the speed slider
let _seekAt         = 0;   // performance.now() of last seek — suppresses stale events
const SEEK_GRACE_MS = 300; // ignore progress events this long after a seek

// Seek the current player to a fraction and stamp _seekAt so stale
// playback_progress events are suppressed until Rust catches up.
function seekPlayer(player, frac) {
  frac = Math.max(0, Math.min(1, frac));
  _lastFrac = frac;
  _lastMs   = performance.now();
  _seekAt   = performance.now();
  player.seek(frac);
}

// Apply frac visually — single point of truth for ball + canvas.
// W and H are passed to avoid extra DOM reads per rAF frame.
function _applyFrac(frac, W, H) {
  currentPlayProgress = frac;
  mpScrubBall.style.transform = `translateX(${(frac * W - 1).toFixed(3)}px)`;
  if (mpWaveformCanvas) renderPlayerWaveform(mpWaveformCanvas, _waveformLayers, frac, W, H);
}

// (Re)build offscreen layers whenever peaks or canvas dimensions change,
// then repaint immediately. Called once per peaks update or resize.
function _rebuildWaveformLayers() {
  const W = mpScrubBar.clientWidth;
  const H = mpScrubBar.clientHeight;
  if (W === 0) return;
  _waveformLayers = buildWaveformLayers(currentPlayerPeaks, W, H);
  _applyFrac(currentPlayProgress, W, H);
}

// Full redraw from current state (ResizeObserver, peaks change, etc.)
function drawPlayerWaveform() {
  _rebuildWaveformLayers();
}

// setScrubFrac: seeking drag path — immediately paints and resets interpolation anchor.
function setScrubFrac(frac) {
  _lastFrac = frac;
  _lastMs   = performance.now();
  const W = mpScrubBar.clientWidth;
  const H = mpScrubBar.clientHeight;
  _applyFrac(frac, W, H);
}

// ─── rAF INTERPOLATION LOOP ─────────────────────────────────
// Runs at 60 fps. Between playback_progress events it extrapolates forward
// using the known playback rate, keeping the playhead perfectly in sync.
;(function rafLoop() {
  if (!seeking && currentPlayingId && players[currentPlayingId]?.isPlaying) {
    const elapsed = (performance.now() - _lastMs) / 1000;
    const extra   = _lastDuration > 0 ? (elapsed * currentPlaybackRate) / _lastDuration : 0;
    const frac    = Math.min(1, _lastFrac + extra);
    const W = mpScrubBar.clientWidth;
    const H = mpScrubBar.clientHeight;
    if (W > 0) _applyFrac(frac, W, H);
  }
  requestAnimationFrame(rafLoop);
})();

let _scrubRafPending = false;
function onScrubMove(e) {
  const rect = mpScrubBar.getBoundingClientRect();
  seekFrac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  _lastFrac = seekFrac;
  _lastMs   = performance.now();
  const player = players[currentPlayingId];
  if (player && player.duration) {
    setTimeDisplay(formatTime(seekFrac * player.duration), formatTime(player.duration));
  }
  // Throttle canvas redraws to one per rAF — ball position updates immediately via rAF loop.
  if (!_scrubRafPending) {
    _scrubRafPending = true;
    requestAnimationFrame(() => {
      _scrubRafPending = false;
      const W = mpScrubBar.clientWidth;
      const H = mpScrubBar.clientHeight;
      if (W > 0) _applyFrac(seekFrac, W, H);
    });
  }
}

function onScrubUp() {
  document.removeEventListener('mousemove', onScrubMove);
  document.removeEventListener('mouseup', onScrubUp);
  seeking = false;
  if (currentPlayingId && players[currentPlayingId]) {
    const player = players[currentPlayingId];
    // Anchor interpolation to the seek destination so the rAF loop doesn't
    // snap back to the pre-drag position while waiting for the next event.
    // seekPlayer stamps _seekAt so stale playback_progress events are suppressed
    // until Rust catches up. Do NOT call setLoopEnabled() here — it internally
    // calls play() again, races seek's own async play(), and snaps the playhead.
    seekPlayer(player, seekFrac);
  }
}

if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => {
    drawPlayerWaveform();
    if (currentPlayingId && players[currentPlayingId]) {
      updateLoopOverlays(players[currentPlayingId]);
    }
  }).observe(mpScrubBar);
}

mpScrubBar.addEventListener('mousedown', e => {
  if (!currentPlayingId) return;
  seeking = true;
  const rect = mpScrubBar.getBoundingClientRect();
  seekFrac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  setScrubFrac(seekFrac);
  const player = players[currentPlayingId];
  if (player && player.duration) {
    setTimeDisplay(formatTime(seekFrac * player.duration), formatTime(player.duration));
  }
  document.addEventListener('mousemove', onScrubMove);
  document.addEventListener('mouseup', onScrubUp);
});


// ─── LIBRARY STATE ───────────────────────────────────────────
let tracks = []; // [{id, name, size, format, semitones, volume, arrayBuffer, duration, artist, album, title, trackNumber, releaseDate, addedAt}]

async function loadLibrary() {
  try {
    console.time('[stagehand] loadLibrary:idb-all');
    const [stored, storedPlaylists, sortModeSetting, orderSetting] = await Promise.all([
      LibraryManager.all(),
      LibraryManager.getPlaylists(),
      LibraryManager.getSetting('playlist_sort_mode'),
      LibraryManager.getSetting('playlist_order')
    ]);
    console.timeEnd('[stagehand] loadLibrary:idb-all');
    console.log(`[stagehand] loadLibrary: ${stored.length} tracks, ${storedPlaylists.length} playlists`);
    tracks = stored;
    playlists = storedPlaylists;

    // Recovery: if IDB empty but files exist on disk (origin mismatch after rebuild)
    if (tracks.length === 0) {
      try {
        const diskFiles = await scanLibraryDir();
        if (diskFiles.length > 0) {
          console.log(`[stagehand] IDB empty, recovering ${diskFiles.length} tracks from disk`);
          for (const f of diskFiles) {
            const track = {
              id:        f.id,
              name:      f.id,
              format:    f.ext,
              filePath:  f.path,
              semitones: 0,
              volume:    1.0,
              size:      f.size,
              addedAt:   Date.now(),
              duration:  0,
            };
            await LibraryManager.save(track);
            tracks.push(track);
          }
          console.log('[stagehand] disk recovery complete');
        }
      } catch(e) {
        console.warn('[stagehand] disk recovery failed:', e);
      }
    }

    // Phase 2c migration: move IDB blobs to filesystem for any tracks that still have them
    const blobTracks = tracks.filter(t => t.arrayBuffer && !t.filePath);
    if (blobTracks.length > 0) {
      console.log(`[stagehand] migrating ${blobTracks.length} track(s) to filesystem`);
      for (const t of blobTracks) {
        try {
          const filePath = await writeAudioFile(t.id, t.format, t.arrayBuffer);
          t.filePath = filePath;
          t.arrayBuffer = null;
          await LibraryManager.saveMeta({ id: t.id, filePath });
          await LibraryManager.clearBytes(t.id);
          console.log(`[stagehand] migrated "${t.name}" → ${filePath}`);
        } catch(e) {
          console.warn(`[stagehand] migration failed for "${t.name}":`, e);
        }
      }
      console.log('[stagehand] migration complete');
    }

    // Migrate old trackIds format to slots
    const toMigrate = playlists.filter(pl => pl.trackIds && !pl.slots);
    toMigrate.forEach(pl => {
      pl.slots = pl.trackIds.map(tid => ({ trackId: tid, semitones: 0 }));
      delete pl.trackIds;
    });
    if (toMigrate.length > 0) {
      toMigrate.forEach(pl => LibraryManager.savePlaylist(pl).catch(() => {}));
    }
    if (sortModeSetting) playlistSortMode = sortModeSetting.value;
    if (orderSetting) playlistManualOrder = orderSetting.ids || [];
    // Sync manual order: ensure all playlists are represented
    const knownIds = new Set(playlistManualOrder);
    playlists.forEach(pl => { if (!knownIds.has(pl.id)) playlistManualOrder.push(pl.id); });
    // Initialize players eagerly for all loaded tracks
    tracks.forEach(t => {
      if (!players[t.id]) {
        players[t.id] = new TrackPlayer(t.id);
        players[t.id].semitones = t.semitones || 0;
        players[t.id].volume = t.volume !== undefined ? t.volume : 1.0;
        players[t.id].loopEnabled = false;
        players[t.id].loopStart   = 0;
        players[t.id].loopEnd     = 1;
      }
    });
    // No background loads — tracks decode on first play only
    libraryLoaded = true;
    renderCurrentTab();
    // Startup file-presence scan — mark any tracks whose file no longer exists
    scanMissingFiles().catch(() => {});
    // Warm artwork cache from IDB, repaint, then background-resolve any still-missing art
    ArtworkManager.warmCache(tracks).then(() => {
      refreshRowArt();
      const seen = new Set();
      tracks.forEach(t => {
        if (ArtworkManager.getCachedArtwork(t)) return;
        const key = ArtworkManager.artworkKeyFor(t);
        if (seen.has(key)) return;
        seen.add(key);
        ArtworkManager.resolveAndStoreArtwork(t, null)
          .then(() => refreshRowArt())
          .catch(() => {});
      });
    }).catch(() => {});
  } catch(e) {
    console.warn('IndexedDB load failed:', e);
    tracks = [];
    libraryLoaded = true;
    renderCurrentTab();
  }
}

// ─── MISSING FILE DETECTION ──────────────────────────────────
async function scanMissingFiles() {
  const withPaths = tracks.filter(t => t.filePath);
  if (withPaths.length === 0) return;
  const paths = withPaths.map(t => t.filePath);
  const result = await invoke('library_check_paths', { paths });
  let changed = false;
  withPaths.forEach(t => {
    const existed = result[t.filePath];
    const wasMissing = !!t._missing;
    t._missing = existed === false;
    if (t._missing !== wasMissing) changed = true;
  });
  if (changed) renderCurrentTab();
}

// Re-scan when window regains focus (handles user moving files while app is open)
window.addEventListener('focus', () => {
  if (libraryLoaded) scanMissingFiles().catch(() => {});
});

async function handleRelocate(trackId) {
  const track = tracks.find(t => t.id === trackId);
  if (!track) return;
  let newPaths;
  try {
    newPaths = await invoke('open_audio_files_dialog');
  } catch(e) {
    console.warn('Relocate dialog failed:', e);
    return;
  }
  if (!newPaths || newPaths.length === 0) return;
  const newPath = newPaths[0];
  // Verify the new file exists
  const check = await invoke('library_check_paths', { paths: [newPath] });
  if (!check[newPath]) {
    notify('File not found', 'error');
    return;
  }
  track.filePath = newPath;
  track._missing = false;
  await LibraryManager.saveMeta({ id: trackId, filePath: newPath });
  // Reload player with new path
  const player = players[trackId];
  if (player) {
    player.stop();
    player._loaded = false;
    player.loadFile(newPath, {
      peaks: track.peaks ?? null,
      nativeDuration: track.nativeDuration ?? null,
      sampleRate: track.sampleRate ?? null,
    }).then(() => {
      if (!track.duration && player.duration) {
        track.duration = player.duration;
        saveTrackMeta(track);
      }
    }).catch(() => {});
  }
  renderCurrentTab();
  notify('File relocated', 'success');
}

// ─── PLAY TRACK ───────────────────────────────────────────────
async function playTrack(id, fromPlaylistId, slotIdx) {
  const track = tracks.find(t => t.id === id);
  if (!track) return;

  // Track which playlist context launched this playback
  if (fromPlaylistId !== undefined) {
    activePlaylistId = fromPlaylistId || null;
    currentPlayingSlotIdx = slotIdx !== undefined ? slotIdx : null;
  } else if (activeTab !== 'playlists') {
    activePlaylistId = null;
    currentPlayingSlotIdx = null;
  }

  if (!players[id]) {
    players[id] = new TrackPlayer(id);
    players[id].semitones = track.semitones || 0;
    players[id].cents = track.cents ?? 0;
    players[id].volume = track.volume !== undefined ? track.volume : 1.0;
    players[id].loopEnabled = false;
    players[id].loopStart   = 0;
    players[id].loopEnd     = 1;
  }
  const player = players[id];

  // Apply per-slot semitones when playing from a playlist slot
  if (activePlaylistId && slotIdx !== undefined && slotIdx !== null) {
    const pl = playlists.find(p => p.id === activePlaylistId);
    const slot = pl?.slots[slotIdx];
    if (slot !== undefined) {
      player.semitones = slot.semitones;
    }
  }

  // If already playing this track, toggle pause
  if (player.isPlaying) {
    player.pause();
    syncMiniplayerPlayBtn(false);
    renderCurrentTab(); // update row highlight
    return;
  }

  // Load buffer if needed — also reload if a different track is in the Rust engine
  const needsLoad = !player._loaded || currentRustTrackId !== id;
  console.log(`[stagehand] playTrack: "${track.name}" needsLoad=${needsLoad}`);
  if (needsLoad) {
    if (!track.filePath) {
      notify('Audio file missing — try re-importing the file', 'error');
      return;
    }
    try {
      const _cm = track.peaks ? { peaks: track.peaks, nativeDuration: track.nativeDuration, sampleRate: track.sampleRate } : null;
      await player.loadFile(track.filePath, _cm);
      currentRustTrackId = id;
      if (!track.duration) {
        track.duration = player.duration;
        saveTrackMeta(track);
      }
    } catch(e) {
      console.error('File decode failed:', e);
      notify('Could not decode audio: ' + (e.message || 'unsupported format'), 'error');
      return;
    }
  }

  // Sync JS state for other players — Rust's stop_sink() inside audio_play drops
  // any active sink already, so dispatching audio_pause here would race with
  // the incoming audio_play and silently pause the new sink.
  Object.entries(players).forEach(([pid, p]) => {
    if (pid !== id && p.isPlaying) {
      p.isPlaying = false;
      p._paused = false;
    }
  });

  try {
    player.pauseOffset = 0; // always start from beginning on row click
    // Scale track volume by master volume for the Rust sink
    player._masterVolume = masterVolume;
    const effectiveVol = player.volume * masterVolume;
    await player.play(undefined, effectiveVol);
    showMiniplayer(id);
    renderCurrentTab(); // add playing highlight
    firePrefetch(id);   // decode next track in background while this one plays
  } catch(e) {
    console.error('Playback failed:', e);
    notify('Playback error: ' + (e.message || 'unknown'), 'error');
  }
}

async function firePrefetch(currentId) {
  const next = getAutoNextTrack(currentId);
  if (!next?.track) return;
  const t = next.track;
  if (!t.filePath) return;
  console.log(`[stagehand] prefetch: queuing "${t.name}"`);
  try {
    console.time(`[stagehand] prefetch:decode "${t.name}"`);
    const cm = t.peaks ? { peaks: t.peaks, nativeDuration: t.nativeDuration, sampleRate: t.sampleRate } : null;
    await invoke('audio_prefetch', {
      path:           t.filePath,
      trackId:        t.id,
      cachedPeaks:    cm?.peaks          ?? null,
      cachedDuration: cm?.nativeDuration ?? null,
      keepFile:       true,
    });
    console.timeEnd(`[stagehand] prefetch:decode "${t.name}"`);
    console.log(`[stagehand] prefetch: "${t.name}" ready`);
  } catch(e) {
    console.warn(`[stagehand] prefetch failed for "${t.name}":`, e);
  }
}

// ─── ARTWORK HELPERS ──────────────────────────────────────────
function buildArtThumb(track) {
  const div = document.createElement('div');
  div.className = 'row-art';
  const dataUrl = ArtworkManager.getCachedArtwork(track);
  if (dataUrl) {
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = '';
    div.appendChild(img);
  } else {
    div.classList.add('row-art-empty');
  }
  return div;
}

// Paint artwork onto already-rendered rows (called after async cache warm)
function refreshRowArt() {
  document.querySelectorAll('#track-list .track-row[data-id]').forEach(row => {
    const track = tracks.find(t => t.id === row.dataset.id);
    if (!track) return;
    const artDiv = row.querySelector('.row-art');
    if (!artDiv) return;
    const dataUrl = ArtworkManager.getCachedArtwork(track);
    if (dataUrl && artDiv.classList.contains('row-art-empty')) {
      const img = document.createElement('img');
      img.src = dataUrl;
      img.alt = '';
      artDiv.appendChild(img);
      artDiv.classList.remove('row-art-empty');
    }
  });
}

// ─── ROW BUILDER ─────────────────────────────────────────────
function buildTrackRow(track) {
  const row = document.createElement('div');
  row.className = 'track-row'
    + (track.id === currentPlayingId ? ' playing' : '')
    + (selectedIds.has(track.id) ? ' selected' : '')
    + (track._missing ? ' missing' : '');
  row.dataset.id = track.id;
  row.style.height = ROW_H + 'px';

  const artist = track.artist || '';
  const album  = track.album  || '';
  const albumLabel = album && track.releaseDate ? `${album} (${track.releaseDate})` : album;
  const dur    = track.duration ? formatTime(track.duration) : '--:--';
  const st     = track.semitones || 0;
  const cts    = track.cents ?? 0;
  const stLabel = st > 0 ? `+${st}` : `${st}`;
  const ctsLabel = cts > 0 ? `+${cts}¢` : `${cts}¢`;
  const hasKey = track.keyRoot != null;
  const origKeyLabel = hasKey ? getKeyName(track.keyRoot, track.keyMode) : '';
  const xposeValText = hasKey
    ? (st !== 0 ? `${transposedKeyName(track.keyRoot, track.keyMode, st)} (${stLabel})` : origKeyLabel)
    : stLabel;
  const xposeValFull = cts !== 0 ? `${xposeValText} ${ctsLabel}` : xposeValText;
  const hasOffset = st !== 0 || cts !== 0;
  const missingBadge = track._missing
    ? `<span class="row-missing-badge" title="${escHtml(track.filePath || '')}">⚠ missing</span>`
    : '';

  row.appendChild(buildArtThumb(track));
  row.insertAdjacentHTML('beforeend', `
    <div class="row-play-area">
      <div class="row-play-indicator"></div>
      <button class="row-play-btn" data-id="${escHtml(track.id)}">${track.id === currentPlayingId && players[track.id]?.isPlaying ? ICONS.pause : ICONS.play}</button>
    </div>
    <div class="row-name-col">
      <button class="row-chord-btn${!!(track.chordPdf || track.chordPro) ? ' has-chart' : ''}" data-chord-id="${escHtml(track.id)}" title="Chord chart" aria-label="Chord chart">${ICONS.chord}</button>
      <div class="row-name">${escHtml(track.name)}</div>
      ${missingBadge}
    </div>
    <div class="row-artist">${escHtml(artist)}</div>
    <div class="row-album">${escHtml(albumLabel)}</div>
    <div class="row-key">${escHtml(origKeyLabel)}</div>
    <div class="row-bpm">${track.bpm ? escHtml(String(track.bpm)) : ''}</div>
    <div class="row-timesig">${track.timeSig ? escHtml(track.timeSig) : ''}</div>
    <div class="row-xpose">
      <button class="xpose-btn xpose-dec" data-id="${escHtml(track.id)}" aria-label="Transpose down" title="Transpose down (Shift: −1¢, Ctrl+Shift: −10¢)">−</button>
      <span class="xpose-val${hasOffset ? ' xpose-active' : ''}" data-id="${escHtml(track.id)}" title="Click to adjust">${escHtml(xposeValFull)}</span>
      <button class="xpose-btn xpose-inc" data-id="${escHtml(track.id)}" aria-label="Transpose up" title="Transpose up (Shift: +1¢, Ctrl+Shift: +10¢)">+</button>
      <button class="xpose-reset${hasOffset ? ' xpose-reset-visible' : ''}" data-id="${escHtml(track.id)}" title="Reset transpose" aria-label="Reset transpose"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.51"/></svg></button>
    </div>
    <div class="row-dur">${escHtml(dur)}</div>
    <button class="row-ctx-btn" data-id="${escHtml(track.id)}" title="More options" aria-label="More options">···</button>
  `);

  if (playlistEditMode) {
    const pl = playlists.find(p => p.id === playlistEditTargetId);
    const countEl = document.createElement('span');
    countEl.className = 'pl-edit-count';
    const initialCount = pl ? pl.slots.filter(s => s.trackId === track.id).length : 0;
    countEl.textContent = initialCount > 0 ? `×${initialCount}` : '';
    row.appendChild(countEl);
    const addBtn = document.createElement('button');
    addBtn.className = 'pl-edit-add-btn';
    addBtn.textContent = '+';
    addBtn.title = 'Add to playlist';
    addBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (!pl) return;
      pl.slots.push({ trackId: track.id, semitones: track.semitones || 0 });
      LibraryManager.savePlaylist(pl).catch(err => console.warn('Playlist save failed:', err));
      countEl.textContent = `×${pl.slots.filter(s => s.trackId === track.id).length}`;
      addBtn.textContent = '✓';
      addBtn.style.color = 'var(--accent)';
      addBtn.style.borderColor = 'var(--accent)';
      setTimeout(() => { addBtn.textContent = '+'; addBtn.style.color = ''; addBtn.style.borderColor = ''; }, 800);
    });
    row.appendChild(addBtn);
  } else {
    row.draggable = true;
    row.addEventListener('dragstart', e => {
      const ids = selectedIds.has(track.id) && selectedIds.size > 1
        ? [...selectedIds]
        : [track.id];
      libDragIds = new Set(ids);
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', ids.join(','));
    });
    row.addEventListener('dragend', () => {
      libDragIds = null;
      clearTimeout(tabHoverTimer); tabHoverTimer = null; tabHoverTarget = null;
      clearTimeout(plHoverTimer); plHoverTimer = null; plHoverTargetId = null;
      document.querySelectorAll('.lib-tab').forEach(t => t.classList.remove('drag-hover'));
    });
  }

  return row;
}

function miniplayerXposeLabel(track) {
  const st  = track.semitones || 0;
  const cts = track.cents ?? 0;
  const stLabel  = st  > 0 ? `+${st}`   : `${st}`;
  const ctsLabel = cts > 0 ? ` +${cts}¢` : cts < 0 ? ` ${cts}¢` : '';
  if (track.keyRoot != null) {
    const keyPart = st !== 0
      ? `${transposedKeyName(track.keyRoot, track.keyMode, st)} (${stLabel})`
      : getKeyName(track.keyRoot, track.keyMode);
    return ctsLabel ? keyPart + ctsLabel : keyPart;
  }
  return stLabel + ctsLabel;
}

function applyTranspose(id, newSemitones, resetCents = false) {
  const track = tracks.find(t => t.id === id);
  if (!track) return;
  track.semitones = Math.max(-12, Math.min(12, newSemitones));
  if (resetCents) track.cents = 0;
  players[id]?.setSemitones(track.semitones);
  if (resetCents) players[id]?.setCents(0);
  saveTrackMeta(track);
  if (id === currentPlayingId) {
    const valEl    = document.getElementById('mp-semitones-val');
    const resetEl  = document.getElementById('mp-xpose-reset');
    const hasOffset = track.semitones !== 0 || (track.cents ?? 0) !== 0;
    if (valEl)   { valEl.textContent = miniplayerXposeLabel(track); valEl.classList.toggle('xpose-active', hasOffset); }
    if (resetEl) resetEl.classList.toggle('xpose-reset-visible', hasOffset);
  }
  if (_xpPopTrackId === id) _syncXposePopover();
  renderCurrentTab();
}

function applyCents(id, delta) {
  const track = tracks.find(t => t.id === id);
  if (!track) return;
  track.cents = Math.max(-50, Math.min(50, (track.cents ?? 0) + delta));
  players[id]?.setCents(track.cents);
  saveTrackMeta(track);
  if (id === currentPlayingId) {
    const valEl   = document.getElementById('mp-semitones-val');
    const resetEl = document.getElementById('mp-xpose-reset');
    const hasOffset = track.semitones !== 0 || track.cents !== 0;
    if (valEl)   { valEl.textContent = miniplayerXposeLabel(track); valEl.classList.toggle('xpose-active', hasOffset); }
    if (resetEl) resetEl.classList.toggle('xpose-reset-visible', hasOffset);
  }
  if (_xpPopTrackId === id) _syncXposePopover();
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

// ─── ARTIST / ALBUM DRILL-DOWN COLUMN HEADER ─────────────────
function buildDrillColHeader() {
  const el = document.createElement('div');
  el.className = 'lib-col-header';
  el.innerHTML = `
    <div class="lib-col-spacer-art"></div>
    <div class="lib-col-spacer-num"></div>
    <div class="lib-col-spacer-play"></div>
    <div class="pl-col-label lib-col-info">Name</div>
    <div class="lib-col-key-label">Key</div>
    <div class="lib-col-bpm-label">BPM</div>
    <div class="lib-col-timesig-label">Time Sig</div>
    <div class="lib-col-xpose-label">Transpose</div>
    <div class="pl-col-label lib-col-dur">Duration</div>
  `;
  return el;
}

// ─── ARTIST DRILL-DOWN ROW BUILDERS ──────────────────────────
function buildAlbumSectionHeader(albumName, trackCount, year, artDataUrl) {
  const el = document.createElement('div');
  el.className = 'album-section-header';
  const nameLabel = year ? `${albumName} (${year})` : albumName;
  const artHtml = artDataUrl
    ? `<div class="album-section-art"><img src="${escHtml(artDataUrl)}" alt=""></div>`
    : `<div class="album-section-art album-section-art-empty"></div>`;
  el.innerHTML = `
    ${artHtml}
    <div class="album-section-header-name">${escHtml(nameLabel)}</div>
    <div class="album-section-header-count">${trackCount} track${trackCount !== 1 ? 's' : ''}</div>
  `;
  return el;
}

function buildArtistDrillTrackRow(track) {
  const row = document.createElement('div');
  row.className = 'track-row'
    + (track.id === currentPlayingId ? ' playing' : '')
    + (selectedIds.has(track.id) ? ' selected' : '');
  row.dataset.id = track.id;
  row.style.height = ROW_H + 'px';

  const trackNum = track.trackNumber > 0 ? String(track.trackNumber) : '\u2014';
  const dur      = track.duration ? formatTime(track.duration) : '--:--';
  const st       = track.semitones || 0;
  const cts2     = track.cents ?? 0;
  const stLabel  = st > 0 ? `+${st}` : `${st}`;
  const ctsLabel2 = cts2 > 0 ? `+${cts2}¢` : `${cts2}¢`;
  const hasKey2  = track.keyRoot != null;
  const origKey2 = hasKey2 ? getKeyName(track.keyRoot, track.keyMode) : '';
  const xposeVal2 = hasKey2
    ? (st !== 0 ? `${transposedKeyName(track.keyRoot, track.keyMode, st)} (${stLabel})` : origKey2)
    : stLabel;
  const xposeVal2Full = cts2 !== 0 ? `${xposeVal2} ${ctsLabel2}` : xposeVal2;
  const hasOffset2 = st !== 0 || cts2 !== 0;

  row.appendChild(buildArtThumb(track));
  row.insertAdjacentHTML('beforeend', `
    <div class="track-num">${escHtml(trackNum)}</div>
    <div class="row-play-area">
      <div class="row-play-indicator"></div>
      <button class="row-play-btn" data-id="${escHtml(track.id)}">${track.id === currentPlayingId && players[track.id]?.isPlaying ? ICONS.pause : ICONS.play}</button>
    </div>
    <div class="row-info">
      <div class="row-name">${escHtml(track.name)}</div>
    </div>
    <div class="row-key">${escHtml(origKey2)}</div>
    <div class="row-bpm">${track.bpm ? escHtml(String(track.bpm)) : ''}</div>
    <div class="row-timesig">${track.timeSig ? escHtml(track.timeSig) : ''}</div>
    <div class="row-xpose">
      <button class="xpose-btn xpose-dec" data-id="${escHtml(track.id)}" title="Transpose down (Shift: −1¢, Ctrl+Shift: −10¢)">−</button>
      <span class="xpose-val${hasOffset2 ? ' xpose-active' : ''}" data-id="${escHtml(track.id)}" title="Click to adjust">${escHtml(xposeVal2Full)}</span>
      <button class="xpose-btn xpose-inc" data-id="${escHtml(track.id)}" title="Transpose up (Shift: +1¢, Ctrl+Shift: +10¢)">+</button>
      <button class="xpose-reset${hasOffset2 ? ' xpose-reset-visible' : ''}" data-id="${escHtml(track.id)}" title="Reset transpose"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.51"/></svg></button>
    </div>
    <div class="row-dur">${escHtml(dur)}</div>
  `);

  if (playlistEditMode) {
    const pl = playlists.find(p => p.id === playlistEditTargetId);
    const countEl = document.createElement('span');
    countEl.className = 'pl-edit-count';
    const initialCount = pl ? pl.slots.filter(s => s.trackId === track.id).length : 0;
    countEl.textContent = initialCount > 0 ? `×${initialCount}` : '';
    row.appendChild(countEl);
    const addBtn = document.createElement('button');
    addBtn.className = 'pl-edit-add-btn';
    addBtn.textContent = '+';
    addBtn.title = 'Add to playlist';
    addBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (!pl) return;
      pl.slots.push({ trackId: track.id, semitones: track.semitones || 0 });
      LibraryManager.savePlaylist(pl).catch(err => console.warn('Playlist save failed:', err));
      countEl.textContent = `×${pl.slots.filter(s => s.trackId === track.id).length}`;
      addBtn.textContent = '✓';
      addBtn.style.color = 'var(--accent)';
      addBtn.style.borderColor = 'var(--accent)';
      setTimeout(() => { addBtn.textContent = '+'; addBtn.style.color = ''; addBtn.style.borderColor = ''; }, 800);
    });
    row.appendChild(addBtn);
  }

  row.draggable = true;
  row.addEventListener('dragstart', e => {
    const ids = selectedIds.has(track.id) && selectedIds.size > 1
      ? [...selectedIds]
      : [track.id];
    libDragIds = new Set(ids);
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', ids.join(','));
  });
  row.addEventListener('dragend', () => {
    libDragIds = null;
    clearTimeout(tabHoverTimer); tabHoverTimer = null; tabHoverTarget = null;
    clearTimeout(plHoverTimer);  plHoverTimer  = null; plHoverTargetId = null;
    document.querySelectorAll('.lib-tab').forEach(t => t.classList.remove('drag-hover'));
  });

  return row;
}

// ─── ARTIST GROUPING ─────────────────────────────────────────
function getArtistGroups() {
  const source = searchQuery ? tracks.filter(matchesSearch) : tracks;
  const map = new Map();
  source.forEach(t => {
    const key = (t.artist && t.artist.trim()) ? t.artist.trim() : 'Unknown Artist';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  });
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function buildArtistRow(artistName, trackCount, artDataUrl, albumCount = 0) {
  const row = document.createElement('div');
  row.className = 'artist-row';
  row.dataset.artist = artistName;
  row.style.height = ROW_H + 'px';
  const artHtml = artDataUrl
    ? `<div class="artist-row-art"><img src="${escHtml(artDataUrl)}" alt=""></div>`
    : `<div class="artist-row-art artist-row-art-empty"></div>`;
  const meta = albumCount > 0
    ? `${albumCount} album${albumCount !== 1 ? 's' : ''} · ${trackCount} track${trackCount !== 1 ? 's' : ''}`
    : `${trackCount} track${trackCount !== 1 ? 's' : ''}`;
  row.innerHTML = `
    ${artHtml}
    <div class="artist-row-name">${escHtml(artistName)}</div>
    <div class="artist-row-count">${meta}</div>
  `;
  return row;
}

// ─── TAB RENDERERS ───────────────────────────────────────────
function renderSongsTab() {
  const trackList = document.getElementById('track-list');
  const sorted = getSortedFilteredTracks();

  if (sorted.length === 0) {
    visibleTracks = [];
    if (searchQuery && tracks.length > 0) {
      trackList.innerHTML = `<div class="lib-empty-state">
        <div class="es-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></div>
        <div class="es-text">No results</div>
        <div class="es-sub">No tracks match &ldquo;${escHtml(searchQuery)}&rdquo;</div>
      </div>`;
    } else {
      trackList.innerHTML = `<div class="lib-empty-state">
        <div class="es-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
        <div class="es-text">No tracks yet</div>
        <div class="es-sub">Import audio files to get started</div>
      </div>`;
    }
    return;
  }
  visibleTracks = sorted;
  renderVirtualList(trackList, sorted, buildTrackRow);
}

function renderArtistList() {
  const trackList = document.getElementById('track-list');
  const groups = getArtistGroups();

  if (groups.length === 0) {
    trackList.innerHTML = `<div class="lib-empty-state">
      <div class="es-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
      <div class="es-text">No artists</div>
      <div class="es-sub">Import tracks with artist tags</div>
    </div>`;
    return;
  }

  visibleTracks = [];
  const artistItems = groups.map(([name, trks]) => {
    const artTrack = trks.find(t => ArtworkManager.getCachedArtwork(t)) || trks[0];
    const albumCount = new Set(trks.map(t => t.album && t.album.trim() ? t.album.trim() : null).filter(Boolean)).size;
    return { name, count: trks.length, albumCount, art: artTrack ? ArtworkManager.getCachedArtwork(artTrack) : null };
  });
  renderVirtualList(trackList, artistItems, (item) => buildArtistRow(item.name, item.count, item.art, item.albumCount));
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

  // Group by album, sort albums A→Z with Unknown Album last
  const albumMap = new Map();
  artistTracks.forEach(t => {
    const key = (t.album && t.album.trim()) ? t.album.trim() : 'Unknown Album';
    if (!albumMap.has(key)) albumMap.set(key, []);
    albumMap.get(key).push(t);
  });
  const sortedAlbums = [...albumMap.entries()].sort((a, b) => {
    if (a[0] === 'Unknown Album') return 1;
    if (b[0] === 'Unknown Album') return -1;
    const ya = albumReleaseYear(a[1]);
    const yb = albumReleaseYear(b[1]);
    if (!ya && !yb) return a[0].localeCompare(b[0]);
    if (!ya) return 1;
    if (!yb) return -1;
    return yb.localeCompare(ya); // newest first
  });

  trackList.appendChild(buildDrillColHeader());

  // Sub-container (non-virtual) so header stays fixed at top
  const listContainer = document.createElement('div');
  listContainer.className = 'artist-track-list';
  trackList.appendChild(listContainer);

  trackList.style.display = 'flex';
  trackList.style.flexDirection = 'column';

  // Render album sections
  sortedAlbums.forEach(([albumName, albumTracks]) => {
    // Sort tracks within album by trackNumber, then name
    albumTracks.sort((a, b) => {
      const na = a.trackNumber || 0;
      const nb = b.trackNumber || 0;
      if (na !== nb) return na - nb;
      return (a.name || '').localeCompare(b.name || '');
    });
    const artTrack = albumTracks.find(t => ArtworkManager.getCachedArtwork(t));
    const artDataUrl = artTrack ? ArtworkManager.getCachedArtwork(artTrack) : null;
    listContainer.appendChild(buildAlbumSectionHeader(albumName, albumTracks.length, albumReleaseYear(albumTracks), artDataUrl));
    albumTracks.forEach(t => listContainer.appendChild(buildArtistDrillTrackRow(t)));
  });
  visibleTracks = sortedAlbums.flatMap(([, alTracks]) => alTracks);
}

function renderArtistsTab() {
  if (currentArtistView === null) {
    renderArtistList();
  } else {
    renderArtistDrillDown(currentArtistView);
  }
}

// ─── ALBUM GROUPING ──────────────────────────────────────────
function getAlbumGroups() {
  const source = searchQuery ? tracks.filter(matchesSearch) : tracks;
  const map = new Map();
  source.forEach(t => {
    const key = (t.album && t.album.trim()) ? t.album.trim() : 'Unknown Album';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  });
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function buildAlbumRow(albumName, trackCount, artistNames, year) {
  const row = document.createElement('div');
  row.className = 'album-row';
  row.dataset.album = albumName;
  row.style.height = ROW_H + 'px';
  const artistLine = artistNames.length > 0
    ? `<div class="album-row-artist">${escHtml(artistNames.join(' · '))}</div>`
    : '';
  const nameLabel = year ? `${albumName} (${year})` : albumName;

  // Find a representative track for this album to look up artwork
  const repTrack = tracks.find(t => (t.album || '').trim() === albumName || (!t.album && albumName === 'Unknown Album'));
  const artDataUrl = repTrack ? ArtworkManager.getCachedArtwork(repTrack) : null;
  const artHtml = artDataUrl
    ? `<img src="${escHtml(artDataUrl)}" alt="" class="album-row-art-img">`
    : '';

  row.innerHTML = `
    <div class="album-row-art">${artHtml}</div>
    <div class="album-row-info">
      <div class="album-row-name">${escHtml(nameLabel)}</div>
      ${artistLine}
    </div>
    <div class="album-row-count">${trackCount} track${trackCount !== 1 ? 's' : ''}</div>
  `;
  return row;
}

function renderAlbumList() {
  const trackList = document.getElementById('track-list');
  const groups = getAlbumGroups();

  if (groups.length === 0) {
    trackList.innerHTML = `<div class="lib-empty-state">
      <div class="es-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
      <div class="es-text">No albums</div>
      <div class="es-sub">Import tracks with album tags</div>
    </div>`;
    return;
  }

  visibleTracks = [];
  const albumItems = groups.map(([name, trks]) => ({
    name,
    count: trks.length,
    artists: [...new Set(trks.map(t => t.artist || '').filter(Boolean))],
    year: albumReleaseYear(trks)
  }));
  renderVirtualList(trackList, albumItems, (item) => buildAlbumRow(item.name, item.count, item.artists, item.year));
}

function renderAlbumDrillDown(albumName) {
  const trackList = document.getElementById('track-list');
  const groups = getAlbumGroups();
  const entry = groups.find(([name]) => name === albumName);
  const albumTracks = entry ? entry[1] : [];

  const drillYear = albumReleaseYear(albumTracks);
  const drillTitle = drillYear ? `${albumName} (${drillYear})` : albumName;
  const drillArtists = [...new Set(albumTracks.map(t => t.artist).filter(Boolean))];
  const drillArtistStr = drillArtists.join(' · ');
  const header = document.createElement('div');
  header.className = 'artist-drill-header';
  header.innerHTML = `
    <button class="artist-back-btn">←</button>
    <div class="artist-drill-title-wrap">
      <div class="artist-drill-title">${escHtml(drillTitle)}</div>
      ${drillArtistStr ? `<div class="artist-drill-subtitle">${escHtml(drillArtistStr)}</div>` : ''}
    </div>
    <button class="drill-edit-info-btn" title="Edit album info">Edit Info</button>
    <div class="artist-drill-count">${albumTracks.length} track${albumTracks.length !== 1 ? 's' : ''}</div>
  `;
  header.querySelector('.drill-edit-info-btn').addEventListener('click', () => {
    const current = tracks.filter(t => (t.album || '').trim() === albumName || (albumName === 'Unknown Album' && !t.album?.trim()));
    showInfoModal(current.map(t => t.id));
  });

  trackList.innerHTML = '';
  trackList.appendChild(header);

  if (albumTracks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'lib-empty-state';
    empty.innerHTML = `<div class="es-text">No tracks</div>`;
    trackList.appendChild(empty);
    return;
  }

  trackList.appendChild(buildDrillColHeader());

  const listContainer = document.createElement('div');
  listContainer.className = 'artist-track-list';
  trackList.appendChild(listContainer);

  trackList.style.display = 'flex';
  trackList.style.flexDirection = 'column';

  albumTracks.sort((a, b) => {
    const na = a.trackNumber || 0;
    const nb = b.trackNumber || 0;
    if (na !== nb) return na - nb;
    return (a.name || '').localeCompare(b.name || '');
  });
  visibleTracks = [...albumTracks];

  renderVirtualList(listContainer, albumTracks, buildArtistDrillTrackRow);

  let drillRafPending = false;
  listContainer.addEventListener('scroll', () => {
    if (drillRafPending) return;
    drillRafPending = true;
    requestAnimationFrame(() => {
      drillRafPending = false;
      renderVirtualList(listContainer, albumTracks, buildArtistDrillTrackRow);
    });
  });
}

function renderAlbumsTab() {
  if (currentAlbumView === null) {
    renderAlbumList();
  } else {
    renderAlbumDrillDown(currentAlbumView);
  }
}

function getSortedPlaylists() {
  if (playlistSortMode === 'name') {
    return [...playlists].sort((a, b) => a.name.localeCompare(b.name));
  }
  if (playlistSortMode === 'date') {
    return [...playlists].sort((a, b) => {
      const da = a.date || '';
      const db = b.date || '';
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return da.localeCompare(db); // soonest first
    });
  }
  // manual: use playlistManualOrder
  const ordered = [];
  const seen = new Set();
  playlistManualOrder.forEach(id => {
    const pl = playlists.find(p => p.id === id);
    if (pl) { ordered.push(pl); seen.add(id); }
  });
  playlists.forEach(pl => { if (!seen.has(pl.id)) ordered.push(pl); });
  return ordered;
}

async function savePlaylistSortSettings() {
  await Promise.all([
    LibraryManager.putSetting({ key: 'playlist_sort_mode', value: playlistSortMode }),
    LibraryManager.putSetting({ key: 'playlist_order', ids: playlistManualOrder })
  ]).catch(e => console.warn('Sort settings save failed:', e));
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

  const sortBar = document.createElement('div');
  sortBar.className = 'pl-sort-bar';
  sortBar.innerHTML = `
    <button class="pl-sort-btn${playlistSortMode === 'manual' ? ' active' : ''}" data-sort="manual">Manual</button>
    <button class="pl-sort-btn${playlistSortMode === 'name' ? ' active' : ''}" data-sort="name">Name</button>
    <button class="pl-sort-btn${playlistSortMode === 'date' ? ' active' : ''}" data-sort="date">Date</button>
  `;
  sortBar.addEventListener('click', e => {
    const btn = e.target.closest('[data-sort]');
    if (!btn) return;
    playlistSortMode = btn.dataset.sort;
    savePlaylistSortSettings();
    renderCurrentTab();
  });
  left.appendChild(sortBar);

  const plList = document.createElement('div');
  plList.className = 'pl-list';
  plList.id = 'pl-list';

  const sortedPls = getSortedPlaylists();
  if (sortedPls.length === 0) {
    plList.innerHTML = `<div style="padding: 16px 12px; font-family:'Barlow Condensed',sans-serif; font-size:13px; color:var(--text-dim);">No playlists yet</div>`;
  } else {
    sortedPls.forEach(pl => {
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
    visibleTracks = selPl.slots.map(s => tracks.find(t => t.id === s.trackId)).filter(Boolean);
    renderPlaylistDetail(right, selPl);
  } else {
    visibleTracks = [];
    right.innerHTML = `<div class="pl-empty-right">
      <div class="es-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg></div>
      <div class="es-text">No playlist selected</div>
      <div class="es-sub">Choose a playlist from the left</div>
    </div>`;
  }
  container.appendChild(right);

  trackList.innerHTML = '';
  trackList.style.display = 'flex';
  trackList.style.flexDirection = 'column';
  trackList.appendChild(container);

  // ── Bind new playlist button ───────────────────────────
  document.getElementById('pl-new-btn').addEventListener('click', createNewPlaylist);
}

function formatPlaylistDate(dateStr) {
  if (!dateStr) return '';
  // dateStr is "YYYY-MM-DD"
  const [y, m, d] = dateStr.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[m - 1]} ${d}, ${y}`;
}

function buildPlaylistRow(pl) {
  const row = document.createElement('div');
  row.className = 'pl-row' + (pl.id === selectedPlaylistId ? ' active' : '');
  row.dataset.plId = pl.id;

  const isManual = playlistSortMode === 'manual';

  const info = document.createElement('div');
  info.className = 'pl-row-info';

  const name = document.createElement('div');
  name.className = 'pl-row-name';
  name.textContent = pl.name;
  info.appendChild(name);

  if (pl.date) {
    const dateEl = document.createElement('div');
    dateEl.className = 'pl-row-date';
    dateEl.textContent = formatPlaylistDate(pl.date);
    info.appendChild(dateEl);
  }

  const count = document.createElement('div');
  count.className = 'pl-row-count';
  count.textContent = `${pl.slots.length} track${pl.slots.length !== 1 ? 's' : ''}`;

  if (isManual) {
    const handle = document.createElement('div');
    handle.className = 'pl-row-drag-handle';
    handle.textContent = '⠿';
    handle.draggable = true;
    handle.addEventListener('dragstart', e => {
      e.stopPropagation();
      plListDragSrcId = pl.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', pl.id);
    });
    handle.addEventListener('dragend', () => {
      plListDragSrcId = null;
      document.querySelectorAll('.pl-row').forEach(r => r.classList.remove('drag-above', 'drag-below'));
    });
    row.appendChild(handle);
  }
  row.appendChild(info);
  row.appendChild(count);

  row.addEventListener('click', () => {
    selectedPlaylistId = pl.id;
    selectedPlSlotIndices.clear();
    renderCurrentTab();
  });

  row.addEventListener('contextmenu', e => {
    e.preventDefault();
    showPlCtxMenu(e, pl.id);
  });

  // Drag-to-reorder targets (manual mode only)
  if (isManual) {
    row.addEventListener('dragover', e => {
      if (!plListDragSrcId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.remove('drag-above', 'drag-below');
      const rect = row.getBoundingClientRect();
      row.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drag-above' : 'drag-below');
    });
    row.addEventListener('dragleave', () => {
      if (!plListDragSrcId) return;
      row.classList.remove('drag-above', 'drag-below');
    });
    row.addEventListener('drop', e => {
      e.preventDefault();
      row.classList.remove('drag-above', 'drag-below');
      const srcId = plListDragSrcId;
      if (!srcId || srcId === pl.id) return;
      const srcIdx = playlistManualOrder.indexOf(srcId);
      const dstIdx = playlistManualOrder.indexOf(pl.id);
      if (srcIdx === -1 || dstIdx === -1) return;
      const rect = row.getBoundingClientRect();
      const insertAfter = e.clientY >= rect.top + rect.height / 2;
      playlistManualOrder.splice(srcIdx, 1);
      const newDst = playlistManualOrder.indexOf(pl.id);
      playlistManualOrder.splice(insertAfter ? newDst + 1 : newDst, 0, srcId);
      savePlaylistSortSettings();
      renderCurrentTab();
    });
  }

  // Library-to-playlist drop OR cross-playlist move
  row.addEventListener('dragover', e => {
    const isCrossPlaylist = plDragSrcPlaylistId !== null && plDragSrcPlaylistId !== pl.id;
    if (!libDragIds && !isCrossPlaylist) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = libDragIds ? 'copy' : 'move';
    row.classList.add('lib-drag-over');
    // Hover-to-open: select this playlist after 1s if it isn't already open
    if (plHoverTargetId !== pl.id) {
      plHoverTargetId = pl.id;
      clearTimeout(plHoverTimer);
      plHoverTimer = setTimeout(() => {
        plHoverTargetId = null; plHoverTimer = null;
        if (selectedPlaylistId !== pl.id) {
          selectedPlaylistId = pl.id;
          renderCurrentTab();
        }
      }, 1000);
    }
  });
  row.addEventListener('dragleave', () => {
    row.classList.remove('lib-drag-over');
    if (plHoverTargetId === pl.id) {
      clearTimeout(plHoverTimer); plHoverTimer = null; plHoverTargetId = null;
    }
  });
  row.addEventListener('drop', e => {
    const isCrossPlaylist = plDragSrcPlaylistId !== null && plDragSrcPlaylistId !== pl.id;
    if (!libDragIds && !isCrossPlaylist) return;
    e.preventDefault();
    row.classList.remove('lib-drag-over');
    const targetPl = playlists.find(p => p.id === pl.id);
    if (!targetPl) return;
    if (isCrossPlaylist) {
      const srcPl = playlists.find(p => p.id === plDragSrcPlaylistId);
      if (!srcPl) return;
      const srcSlot = srcPl.slots[plDragSrcIndex];
      if (!srcSlot) return;
      srcPl.slots.splice(plDragSrcIndex, 1);
      LibraryManager.savePlaylist(srcPl).catch(err => console.warn('Playlist save failed:', err));
      targetPl.slots.push({ trackId: srcSlot.trackId, semitones: srcSlot.semitones });
      LibraryManager.savePlaylist(targetPl).catch(err => console.warn('Playlist save failed:', err));
      renderCurrentTab();
      const track = tracks.find(t => t.id === srcSlot.trackId);
      notify(`Moved "${track?.name || 'track'}" to "${targetPl.name}"`);
    } else {
      performLibraryDrop(targetPl, targetPl.slots.length);
    }
  });

  return row;
}

function renderPlaylistDetail(container, pl) {
  // Header
  const header = document.createElement('div');
  header.className = 'pl-detail-header';
  header.innerHTML = `
    <div class="pl-detail-title">${escHtml(pl.name)}</div>
    <div class="pl-detail-count">${pl.slots.length} track${pl.slots.length !== 1 ? 's' : ''}</div>
    <div class="pl-detail-date-wrap">
      <label class="pl-detail-date-label">Date</label>
      <input type="date" class="pl-detail-date" id="pl-detail-date" value="${escHtml(pl.date || '')}">
    </div>
    <button class="pl-add-tracks-btn" id="pl-add-tracks-btn">+ Add Tracks</button>
  `;
  container.appendChild(header);

  // Date change handler
  container.querySelector('#pl-detail-date').addEventListener('change', e => {
    pl.date = e.target.value || null;
    LibraryManager.savePlaylist(pl).catch(err => console.warn('Playlist date save failed:', err));
    // Update the row in the left pane if visible
    const rowEl = document.querySelector(`.pl-row[data-pl-id="${pl.id}"]`);
    if (rowEl) {
      const dateEl = rowEl.querySelector('.pl-row-date');
      if (pl.date) {
        if (dateEl) {
          dateEl.textContent = formatPlaylistDate(pl.date);
        } else {
          const newDateEl = document.createElement('div');
          newDateEl.className = 'pl-row-date';
          newDateEl.textContent = formatPlaylistDate(pl.date);
          rowEl.querySelector('.pl-row-info').appendChild(newDateEl);
        }
      } else if (dateEl) {
        dateEl.remove();
      }
    }
  });

  // Column header
  const colHeader = document.createElement('div');
  colHeader.className = 'lib-col-header';
  colHeader.innerHTML = `
    <div class="lib-col-spacer-drag"></div>
    <div class="lib-col-spacer-num"></div>
    <div class="lib-col-spacer-art"></div>
    <div class="lib-col-spacer-play"></div>
    <div class="pl-col-label lib-col-name">Name</div>
    <div class="pl-col-label lib-col-artist">Artist</div>
    <div class="pl-col-label lib-col-album">Album</div>
    <div class="lib-col-key-label">Key</div>
    <div class="lib-col-bpm-label">BPM</div>
    <div class="lib-col-timesig-label">Time Sig</div>
    <div class="lib-col-xpose-label">Transpose</div>
    <div class="pl-col-label lib-col-dur">Duration</div>
    <div class="lib-col-spacer-ctx"></div>
  `;
  container.appendChild(colHeader);

  // Track list
  const listEl = document.createElement('div');
  listEl.className = 'pl-track-list';
  listEl.id = 'pl-track-list';

  if (pl.slots.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'lib-empty-state pl-empty-drop';
    emptyEl.innerHTML = `<div class="es-text">No tracks yet</div><div class="es-sub">Drag songs here, or right-click → Add to Playlist</div>`;
    emptyEl.addEventListener('dragover', e => {
      if (!libDragIds) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
      emptyEl.classList.add('lib-drag-over');
    });
    emptyEl.addEventListener('dragleave', () => emptyEl.classList.remove('lib-drag-over'));
    emptyEl.addEventListener('drop', e => {
      if (!libDragIds) return;
      e.preventDefault(); emptyEl.classList.remove('lib-drag-over');
      performLibraryDrop(pl, 0);
    });
    listEl.appendChild(emptyEl);
  } else {
    pl.slots.forEach((slot, idx) => {
      const track = tracks.find(t => t.id === slot.trackId);
      if (track) listEl.appendChild(buildPlaylistTrackRow(slot, idx, pl));
    });
  }

  // Container-level drop: catches drops in empty space below tracks
  listEl.addEventListener('dragover', e => {
    if (!libDragIds && plDragSrcIndex === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = libDragIds ? 'copy' : 'move';
  });
  listEl.addEventListener('drop', e => {
    if (!libDragIds && plDragSrcIndex === null) return;
    e.preventDefault();
    if (libDragIds) {
      performLibraryDrop(pl, pl.slots.length);
    } else {
      // Reorder: move dragged slot to end
      const srcIdx = plDragSrcIndex;
      if (srcIdx === null || srcIdx === pl.slots.length - 1) return;
      const newSlots = [...pl.slots];
      const [moved] = newSlots.splice(srcIdx, 1);
      newSlots.push(moved);
      pl.slots = newSlots;
      LibraryManager.savePlaylist(pl).catch(e => console.warn('Playlist save failed:', e));
      renderCurrentTab();
    }
  });

  container.appendChild(listEl);

  // Add Tracks button
  container.querySelector('#pl-add-tracks-btn').addEventListener('click', () => {
    enterPlaylistEditMode(pl);
  });
}

function performLibraryDrop(pl, insertIdx) {
  const idsToAdd = [...libDragIds].filter(id => !pl.slots.some(s => s.trackId === id));
  const skipped = libDragIds.size - idsToAdd.length;
  if (idsToAdd.length === 0) {
    notify(`Already in "${pl.name}"`); return;
  }
  const slotsToAdd = idsToAdd.map(id => ({ trackId: id, semitones: tracks.find(t => t.id === id)?.semitones || 0 }));
  pl.slots.splice(insertIdx, 0, ...slotsToAdd);
  LibraryManager.savePlaylist(pl).catch(err => console.warn('Playlist save failed:', err));
  if (selectedPlaylistId === pl.id && activeTab === 'playlists') {
    renderCurrentTab();
  } else {
    const countEl = document.querySelector(`.pl-row[data-pl-id="${pl.id}"] .pl-row-count`);
    if (countEl) countEl.textContent = pl.slots.length;
  }
  const added = idsToAdd.length;
  const msg = added === 1
    ? `Added to "${pl.name}"`
    : `Added ${added} tracks to "${pl.name}"${skipped > 0 ? ` (${skipped} skipped)` : ''}`;
  notify(msg);
}

function buildPlaylistTrackRow(slot, idx, pl) {
  const track = tracks.find(t => t.id === slot.trackId);
  if (!track) return document.createElement('div');
  const row = document.createElement('div');
  const isPlaying = track.id === currentPlayingId && activePlaylistId === pl.id && currentPlayingSlotIdx === idx;
  row.className = 'track-row'
    + (isPlaying ? ' playing' : '')
    + (selectedPlSlotIndices.has(idx) ? ' selected' : '');
  row.dataset.id = track.id;
  row.dataset.plIdx = idx;
  row.style.height = ROW_H + 'px';
  row.draggable = true;

  const artist = track.artist || '';
  const album  = track.album  || '';
  const albumLabel = album && track.releaseDate ? `${album} (${track.releaseDate})` : album;
  const dur    = track.duration ? formatTime(track.duration) : '--:--';
  const st     = slot.semitones ?? 0;
  const stLabel = st > 0 ? `+${st}` : `${st}`;
  const hasKeyPl  = track.keyRoot != null;
  const origKeyPl = hasKeyPl ? getKeyName(track.keyRoot, track.keyMode) : '';
  const xposeValPl = hasKeyPl
    ? (st !== 0 ? `${transposedKeyName(track.keyRoot, track.keyMode, st)} (${stLabel})` : origKeyPl)
    : stLabel;

  row.insertAdjacentHTML('beforeend', `
    <div class="drag-handle" title="Drag to reorder">⠿</div>
    <div class="row-pl-num">${idx + 1}</div>
  `);
  row.appendChild(buildArtThumb(track));
  row.insertAdjacentHTML('beforeend', `
    <div class="row-play-area">
      <div class="row-play-indicator"></div>
      <button class="row-play-btn" data-id="${escHtml(track.id)}">${isPlaying ? ICONS.pause : ICONS.play}</button>
    </div>
    <div class="row-name-col">
      <button class="row-chord-btn${!!(track.chordPdf || track.chordPro) ? ' has-chart' : ''}" data-chord-id="${escHtml(track.id)}" title="Chord chart" aria-label="Chord chart">${ICONS.chord}</button>
      <div class="row-name">${escHtml(track.name)}</div>
    </div>
    <div class="row-artist">${escHtml(artist)}</div>
    <div class="row-album">${escHtml(albumLabel)}</div>
    <div class="row-key">${escHtml(origKeyPl)}</div>
    <div class="row-bpm">${track.bpm ? escHtml(String(track.bpm)) : ''}</div>
    <div class="row-timesig">${track.timeSig ? escHtml(track.timeSig) : ''}</div>
    <div class="row-xpose">
      <button class="xpose-btn xpose-dec" data-id="${escHtml(track.id)}">−</button>
      <span class="xpose-val${st !== 0 ? ' xpose-active' : ''}">${escHtml(xposeValPl)}</span>
      <button class="xpose-btn xpose-inc" data-id="${escHtml(track.id)}">+</button>
      <button class="xpose-reset${st !== 0 ? ' xpose-reset-visible' : ''}" data-id="${escHtml(track.id)}" title="Reset transpose"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.51"/></svg></button>
    </div>
    <div class="row-dur">${escHtml(dur)}</div>
    <button class="row-ctx-btn" data-id="${escHtml(track.id)}" title="More options" aria-label="More options">···</button>
  `);

  // Drag-to-reorder bindings
  row.addEventListener('dragstart', e => {
    plDragSrcIndex = idx;
    plDragSrcPlaylistId = pl.id;
    plDragSrcTrackId = track.id;
    e.dataTransfer.effectAllowed = 'move';
  });
  row.addEventListener('dragover', e => {
    if (plDragSrcIndex === null && !libDragIds) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = libDragIds ? 'copy' : 'move';
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

    if (libDragIds) {
      e.stopPropagation();
      const rect = row.getBoundingClientRect();
      const insertIdx = e.clientY < rect.top + rect.height / 2 ? idx : idx + 1;
      performLibraryDrop(pl, insertIdx);
      return;
    }

    const srcIdx = plDragSrcIndex;
    if (srcIdx === null || srcIdx === idx) return;
    const rect = row.getBoundingClientRect();
    let destIdx = idx;
    if (e.clientY >= rect.top + rect.height / 2) destIdx = idx + 1;
    // Adjust for removal of source
    const newSlots = [...pl.slots];
    const [moved] = newSlots.splice(srcIdx, 1);
    const insertAt = destIdx > srcIdx ? destIdx - 1 : destIdx;
    newSlots.splice(insertAt, 0, moved);
    pl.slots = newSlots;
    LibraryManager.savePlaylist(pl).catch(e => console.warn('Playlist save failed:', e));
    renderCurrentTab();
  });
  row.addEventListener('dragend', () => {
    plDragSrcIndex = null;
    plDragSrcPlaylistId = null;
    plDragSrcTrackId = null;
    document.querySelectorAll('.track-row').forEach(r => r.classList.remove('drag-above', 'drag-below'));
  });

  // Play button click
  row.querySelector('.row-play-btn').addEventListener('click', e => {
    e.stopPropagation();
    playTrack(track.id, pl.id, idx);
  });

  // Double-click to play
  let plLastClickIdx = null, plLastClickTime = 0;
  row.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    const now = Date.now();
    if (plLastClickIdx === idx && (now - plLastClickTime) < 300) {
      plLastClickIdx = null;
      playTrack(track.id, pl.id, idx);
    }
    plLastClickIdx = idx;
    plLastClickTime = now;
  });

  // Slot-specific transpose controls (update slot.semitones, not track.semitones)
  function applySlotTranspose(newSt) {
    newSt = Math.max(-12, Math.min(12, newSt));
    slot.semitones = newSt;
    LibraryManager.savePlaylist(pl).catch(e => console.warn('Playlist save failed:', e));
    // If this slot is currently playing, update the live player too
    if (currentPlayingId === track.id && activePlaylistId === pl.id && currentPlayingSlotIdx === idx) {
      players[track.id]?.setSemitones?.(newSt);
    }
    const stLbl = newSt > 0 ? `+${newSt}` : `${newSt}`;
    const label = track.keyRoot != null
      ? (newSt !== 0 ? `${transposedKeyName(track.keyRoot, track.keyMode, newSt)} (${stLbl})` : getKeyName(track.keyRoot, track.keyMode))
      : stLbl;
    row.querySelector('.xpose-val').textContent = label;
    row.querySelector('.xpose-val').classList.toggle('xpose-active', newSt !== 0);
    row.querySelector('.xpose-reset').classList.toggle('xpose-reset-visible', newSt !== 0);
  }
  row.querySelector('.xpose-reset').addEventListener('click', e => {
    e.stopPropagation(); applySlotTranspose(0);
  });
  row.querySelector('.xpose-dec').addEventListener('click', e => {
    e.stopPropagation(); applySlotTranspose(slot.semitones - 1);
  });
  row.querySelector('.xpose-inc').addEventListener('click', e => {
    e.stopPropagation(); applySlotTranspose(slot.semitones + 1);
  });

  return row;
}

function enterPlaylistEditMode(pl) {
  playlistEditMode = true;
  playlistEditTargetId = pl.id;
  playlistEditSnapshot = pl.slots.map(s => ({ ...s }));
  document.querySelectorAll('.lib-tab').forEach(b => b.classList.remove('active'));
  document.querySelector('.lib-tab[data-tab="songs"]').classList.add('active');
  activeTab = 'songs';
  renderCurrentTab();
}

async function exitPlaylistEditMode(doConfirm) {
  const pl = playlists.find(p => p.id === playlistEditTargetId);
  if (pl && !doConfirm) {
    pl.slots = playlistEditSnapshot;
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
        pl.slots.push({ trackId: track.id, semitones: track.semitones || 0 });
        LibraryManager.savePlaylist(pl).catch(e => console.warn('Playlist save failed:', e));
        // Refresh count in header without closing overlay
        const countEl = container.querySelector('.pl-detail-count');
        if (countEl) countEl.textContent = pl.slots.length + ' track' + (pl.slots.length !== 1 ? 's' : '');
        // Briefly flash the + button to confirm
        const btn = row.querySelector('.add-track-btn');
        btn.textContent = '✓';
        btn.style.color = 'var(--accent)';
        btn.style.borderColor = 'var(--accent)';
        setTimeout(() => { btn.textContent = '+'; btn.style.color = ''; btn.style.borderColor = ''; }, 800);
        // Update count on left-pane row too
        const plRowEl = document.querySelector(`.pl-row[data-pl-id="${pl.id}"] .pl-row-count`);
        if (plRowEl) plRowEl.textContent = pl.slots.length;
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
    slots: [],
    createdAt: Date.now(),
    date: null
  };
  playlists.push(pl);
  playlistManualOrder.push(pl.id);
  await Promise.all([
    LibraryManager.savePlaylist(pl),
    savePlaylistSortSettings()
  ]).catch(e => console.warn('Playlist save failed:', e));
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
  input.setAttribute('aria-label', 'Playlist name');
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
    playlistManualOrder = playlistManualOrder.filter(id => id !== plCtxMenuId);
    savePlaylistSortSettings();
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

function showAddToPlaylistSubmenu(e, trackIds) {
  submenuTrackId = trackIds;
  plSubmenu.innerHTML = '';

  if (playlists.length > 0) {
    playlists.forEach(pl => {
      const item = document.createElement('div');
      item.className = 'pl-submenu-item';
      item.textContent = pl.name;
      item.addEventListener('click', () => {
        const idsToAdd = trackIds.filter(id => !pl.slots.some(s => s.trackId === id));
        const skipped = trackIds.length - idsToAdd.length;
        pl.slots.push(...idsToAdd.map(id => ({ trackId: id, semitones: tracks.find(t => t.id === id)?.semitones || 0 })));
        LibraryManager.savePlaylist(pl).catch(e => console.warn('Playlist save failed:', e));
        plSubmenu.classList.remove('show');
        if (activeTab === 'playlists' && selectedPlaylistId === pl.id) renderCurrentTab();
        const msg = idsToAdd.length === 1
          ? `Added to "${pl.name}"`
          : `Added ${idsToAdd.length} tracks to "${pl.name}"${skipped > 0 ? ` (${skipped} already in playlist)` : ''}`;
        notify(msg, 'success');
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
      slots: trackIds.map(id => ({ trackId: id, semitones: tracks.find(t => t.id === id)?.semitones || 0 })),
      createdAt: Date.now(),
      date: null
    };
    playlists.push(pl);
    playlistManualOrder.push(pl.id);
    await Promise.all([
      LibraryManager.savePlaylist(pl),
      savePlaylistSortSettings()
    ]).catch(e => console.warn('Playlist save failed:', e));
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
  if (!libraryLoaded) {
    document.getElementById('track-list').innerHTML =
      '<div class="lib-empty-state"><div class="es-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg></div><div class="es-text">Loading Library…</div></div>';
    return;
  }
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

  // Show sort bar on Songs tab only
  const sortBar = document.getElementById('lib-sort-bar');
  sortBar.classList.toggle('hidden', activeTab !== 'songs');
  document.querySelectorAll('.lib-sort-btn').forEach(btn => {
    const isActive = btn.dataset.sort === songsSortField;
    btn.classList.toggle('active', isActive);
    btn.innerHTML = btn.dataset.sort === 'name'     ? 'Name'
      : btn.dataset.sort === 'artist'   ? 'Artist'
      : btn.dataset.sort === 'album'    ? 'Album'
      : btn.dataset.sort === 'addedAt'  ? 'Date Added'
      : btn.dataset.sort === 'bpm'      ? 'BPM'
      : btn.dataset.sort === 'duration' ? 'Duration'
      : btn.textContent;
    if (isActive) {
      btn.innerHTML += `<span class="lib-sort-dir">${songsSortDir === 'asc' ? '↑' : '↓'}</span>`;
    }
  });

  if (activeTab === 'songs') renderSongsTab();
  else if (activeTab === 'artists') renderArtistsTab();
  else if (activeTab === 'albums') renderAlbumsTab();
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
  input.setAttribute('aria-label', 'Track name');
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
      setMarqueeText(document.getElementById('mp-track-name'), newName);
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
  const allowed = ['wav','mp3','flac','ogg','opus','m4a','aac','mp4'];
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
      artist: '', album: '', title: '', trackNumber: 0, releaseDate: '',
      duration: 0, filePath: null,
      addedAt: Date.now()
    };
    tracks.push(track);
    players[id] = new TrackPlayer(id);
    players[id].semitones = 0;
    players[id].volume = 1.0;
    players[id].loopEnabled = false;
    players[id].loopStart   = 0;
    players[id].loopEnd     = 1;
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
      track.artist       = tags.artist || '';
      track.album        = tags.album  || '';
      track.title        = tags.title  || '';
      track.trackNumber  = parseTrackNumber(tags.track);
      track.releaseDate  = tags.year   || '';

      // Write audio to permanent library directory
      const filePath = await writeAudioFile(track.id, track.format, ab);
      track.filePath = filePath;

      // IDB save — metadata only, no blob
      LibraryManager.save({ ...track })
        .catch(e => console.warn('IDB save failed:', e));

      // Resolve artwork from embedded tags while bytes still in memory — fire and forget
      ArtworkManager.resolveAndStoreArtwork(track, ab.slice(0))
        .then(() => renderCurrentTab())
        .catch(() => {});

      // Decode for duration — fire and forget
      players[track.id].loadFile(filePath).then(() => {
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

// Import from native paths (Tauri dialog or native drag-drop) — stores original path, no copy
async function importFilePaths(nativePaths) {
  const allowed = ['wav','mp3','flac','ogg','opus','m4a','aac','aiff','aif','mp4'];
  const validPaths = nativePaths.filter(p => {
    const ext = p.replace(/\\/g, '/').split('/').pop().split('.').pop().toLowerCase();
    return allowed.includes(ext);
  });
  if (validPaths.length === 0) return;

  // Step 1: skeleton tracks appear instantly
  const workItems = validPaths.map(filePath => {
    const parts = filePath.replace(/\\/g, '/').split('/');
    const filename = parts[parts.length - 1];
    const ext = filename.split('.').pop().toLowerCase();
    const id = LibraryManager.genId();
    const track = {
      id,
      name: filename.replace(/\.[^.]+$/, ''),
      format: ext.toUpperCase(),
      size: 0,
      semitones: 0, volume: 1.0,
      artist: '', album: '', title: '', trackNumber: 0, releaseDate: '',
      duration: 0, filePath,
      addedAt: Date.now(),
    };
    tracks.push(track);
    players[id] = new TrackPlayer(id);
    players[id].semitones = 0;
    players[id].volume = 1.0;
    players[id].loopEnabled = false;
    players[id].loopStart   = 0;
    players[id].loopEnd     = 1;
    return { filePath, track };
  });
  renderTrackList();

  // Step 2: per-file — read bytes for tags/artwork via asset protocol, then store original path
  let added = 0;
  for (const { filePath, track } of workItems) {
    try {
      const src = convertFileSrc(filePath.replace(/\\/g, '/'));
      const resp = await fetch(src);
      if (resp.ok) {
        const ab = await resp.arrayBuffer();
        track.size = ab.byteLength;
        // Tag reading via jsmediatags (needs a File/Blob)
        const fakeFile = new File([ab], track.name + '.' + track.format.toLowerCase());
        const tags = await readTags(fakeFile);
        track.artist      = tags.artist || '';
        track.album       = tags.album  || '';
        track.title       = tags.title  || '';
        track.trackNumber = parseTrackNumber(tags.track);
        track.releaseDate = tags.year   || '';
        ArtworkManager.resolveAndStoreArtwork(track, ab.slice(0))
          .then(() => renderCurrentTab())
          .catch(() => {});
      }

      LibraryManager.save({ ...track }).catch(e => console.warn('IDB save failed:', e));

      players[track.id].loadFile(filePath).then(() => {
        if (!track.duration) {
          track.duration = players[track.id].duration;
          saveTrackMeta(track);
          renderTrackList();
        }
      }).catch(e => console.warn('Decode failed:', track.name, e));

      added++;
      renderTrackList();
    } catch(e) {
      console.warn('Import failed for', filePath, e);
    }
  }
  if (added > 0) notify(`Imported ${added} track${added > 1 ? 's' : ''}`, 'success');
}


// ─── UI SCALE ────────────────────────────────────────────────
const SCALE_MIN = 85, SCALE_MAX = 160, SCALE_STEP = 5;
let uiScale = parseInt(localStorage.getItem('uiScale') || '110');

// ─── RESTORE VOLUME SETTINGS ──────────────────────────────────
let masterVolume = parseFloat(localStorage.getItem('masterVolume') || '100') / 100;
const storedMasterVol = localStorage.getItem('masterVolume');
if (storedMasterVol !== null) {
  document.getElementById('mp-vol').value = storedMasterVol;
}
const storedMetroVol = localStorage.getItem('metronomeVolume');
if (storedMetroVol !== null) {
  document.getElementById('mm-vol').value = storedMetroVol;
  Metronome.setVolume(parseInt(storedMetroVol) / 100);
}
updateRangeFill(document.getElementById('mp-vol'));
updateRangeFill(document.getElementById('mm-vol'));
updateRangeFill(document.getElementById('mp-speed'));

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

// ─── THEME (LIGHT / DARK) ────────────────────────────────────
let _isLightMode = localStorage.getItem('themeMode') === 'light';

function applyTheme() {
  document.documentElement.classList.toggle('light-mode', _isLightMode);
  const lbl = document.getElementById('theme-mode-label');
  const tog = document.getElementById('theme-toggle');
  if (lbl) lbl.textContent = _isLightMode ? 'Light' : 'Dark';
  if (tog) tog.checked = _isLightMode;
}

document.getElementById('theme-toggle').addEventListener('change', e => {
  _isLightMode = e.target.checked;
  localStorage.setItem('themeMode', _isLightMode ? 'light' : 'dark');
  applyTheme();
});

applyTheme();

// ─── CLEAR ARTWORK ───────────────────────────────────────────
document.getElementById('clear-artwork-btn').addEventListener('click', async () => {
  const ok = await confirm('Clear All Artwork?', 'This removes every cached artwork image. Art will be re-fetched from iTunes (or re-embedded) next time tracks are loaded.', 'Clear');
  if (!ok) return;
  try {
    await LibraryManager.clearAllArtwork();
    ArtworkManager.clearCache();
    renderCurrentTab();
    refreshRowArt();
    notify('Artwork cache cleared', '');
  } catch(e) {
    notify('Failed to clear artwork', 'error');
  }
});

// ─── WINDOW CONTROLS ─────────────────────────────────────────
(function() {
  const minBtn   = document.getElementById('win-minimize');
  const fsBtn    = document.getElementById('win-fullscreen');
  const closeBtn = document.getElementById('win-close');
  const topbar   = document.getElementById('topbar');
  const iconExpand   = fsBtn.querySelector('.icon-expand');
  const iconCompress = fsBtn.querySelector('.icon-compress');

  // Tauri v2: getCurrentWindow() lives on window.__TAURI__.window
  const tauriWin = window.__TAURI__?.window?.getCurrentWindow?.() ?? null;
  console.log('[WinControls] Tauri window API:', tauriWin);

  async function updateMaxIcon() {
    const isMax = tauriWin ? await tauriWin.isMaximized() : !!document.fullscreenElement;
    iconExpand.style.display   = isMax ? 'none' : '';
    iconCompress.style.display = isMax ? ''     : 'none';
    fsBtn.title = isMax ? 'Restore' : 'Maximize';
  }

  if (tauriWin) {
    minBtn.addEventListener('click',   () => tauriWin.minimize());
    closeBtn.addEventListener('click', () => tauriWin.close());
    fsBtn.addEventListener('click', async () => {
      await tauriWin.toggleMaximize();
      updateMaxIcon();
    });
    tauriWin.onResized(updateMaxIcon);

    // Manual drag: trigger unless click lands on interactive element
    topbar.addEventListener('mousedown', e => {
      if (!e.target.closest('button, input, a, select, [data-tauri-no-drag]')) {
        tauriWin.startDragging();
      }
    });
  } else {
    // Fallback for plain browser dev
    document.addEventListener('fullscreenchange', updateMaxIcon);
    fsBtn.addEventListener('click', () => {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
      else document.exitFullscreen().catch(() => {});
    });
    minBtn.addEventListener('click',   () => window.blur());
    closeBtn.addEventListener('click', () => window.close());
  }

  updateMaxIcon();
})();

// ─── SETTINGS POPUP ──────────────────────────────────────────
const settingsBtn   = document.getElementById('settings-btn');
const settingsPopup = document.getElementById('settings-popup');

settingsBtn.addEventListener('click', e => {
  e.stopPropagation();
  const open = !settingsPopup.classList.contains('hidden');
  settingsPopup.classList.toggle('hidden', open);
  settingsBtn.classList.toggle('active', !open);
  if (!open) {
    loadDeviceList();
    renderShortcuts();
  }
});

let _deviceList = [];

async function loadDeviceList() {
  const sel = document.getElementById('sp-device-select');
  const warn = document.getElementById('sp-asio-warn');
  if (!sel || !window.__TAURI__) return;
  try {
    const devices = await invoke('audio_get_devices');
    _deviceList = devices;
    sel.innerHTML = '';

    const asioDevices  = devices.filter(d => d.is_asio);
    const wasapiDevices = devices.filter(d => !d.is_asio);

    if (asioDevices.length) {
      const grp = document.createElement('optgroup');
      grp.label = 'ASIO';
      asioDevices.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.name;
        opt.textContent = `${d.name}  ${d.latency_hint}`;
        grp.appendChild(opt);
      });
      sel.appendChild(grp);
    }

    if (wasapiDevices.length) {
      const grp = document.createElement('optgroup');
      grp.label = 'WASAPI';
      wasapiDevices.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.name;
        opt.textContent = `${d.name}  ${d.latency_hint}${d.is_default ? '  (default)' : ''}`;
        if (d.is_default) opt.selected = true;
        grp.appendChild(opt);
      });
      sel.appendChild(grp);
    }

    const savedDevice = localStorage.getItem('audioOutputDevice');
    if (savedDevice) {
      const savedOpt = sel.querySelector(`option[value="${CSS.escape(savedDevice)}"]`);
      if (savedOpt) {
        sel.querySelectorAll('option').forEach(o => o.selected = false);
        savedOpt.selected = true;
      }
    }

    if (warn) warn.classList.toggle('hidden', asioDevices.length > 0);
  } catch (e) {
    console.warn('audio_get_devices failed:', e);
  }
}

document.getElementById('sp-device-select')?.addEventListener('change', async e => {
  const device = _deviceList.find(d => d.name === e.target.value);
  try {
    await invoke('audio_set_device', { deviceName: e.target.value, isAsio: device?.is_asio ?? false });
    localStorage.setItem('audioOutputDevice', e.target.value);
  } catch (err) {
    console.error('audio_set_device failed:', err);
    notify('Failed to switch audio device', 'error');
  }
});

document.getElementById('sp-asio4all-btn')?.addEventListener('click', () => {
  invoke('open_url', { url: 'https://asio4all.org' }).catch(console.error);
});

document.addEventListener('click', e => {
  if (!settingsPopup.classList.contains('hidden') && !settingsPopup.contains(e.target)) {
    settingsPopup.classList.add('hidden');
    settingsBtn.classList.remove('active');
  }
});

// ─── KEYBOARD SHORTCUTS UI ────────────────────────────────────
let _scCapturingId = null;
let _scCaptureCleanup = null;

function _keyToDisplay(key) {
  const map = { ' ': 'Space', 'ArrowLeft': '←', 'ArrowRight': '→', 'ArrowUp': '↑', 'ArrowDown': '↓',
    'Delete': 'Del', 'Backspace': '⌫', 'Enter': '↵', 'Escape': 'Esc', 'Tab': 'Tab' };
  return map[key] || (key.length === 1 ? key.toUpperCase() : key);
}

function _shortcutChips(sc) {
  const parts = [...(sc.modifiers || []).filter(m => ['Ctrl','Shift','Alt'].includes(m)), _keyToDisplay(sc.key)];
  return parts.map(p => `<kbd>${p}</kbd>`).join(' ');
}

function renderShortcuts() {
  const list = document.getElementById('sp-shortcuts-list');
  if (!list) return;
  const groups = {};
  for (const def of SHORTCUT_DEFAULTS) {
    if (!groups[def.group]) groups[def.group] = [];
    groups[def.group].push(shortcuts[def.id]);
  }
  let html = '<p class="sp-shortcuts-hint">Click any key to rebind · Double-click to reset</p>';
  for (const [group, items] of Object.entries(groups)) {
    html += `<div class="sp-shortcut-group">${group}</div>`;
    for (const sc of items) {
      html += `<div class="sp-shortcut-row" data-sc-id="${sc.id}">` +
        `<span>${sc.label}</span>` +
        `<span class="sp-keys sp-keys-editable" data-sc-id="${sc.id}">${_shortcutChips(sc)}</span>` +
        `</div>`;
    }
  }
  list.innerHTML = html;
  list.querySelectorAll('.sp-keys-editable').forEach(el => {
    el.addEventListener('click', e => { e.stopPropagation(); _startScCapture(el.dataset.scId); });
    el.addEventListener('dblclick', e => {
      e.stopPropagation();
      const def = SHORTCUT_DEFAULTS.find(d => d.id === el.dataset.scId);
      if (def) { shortcuts[def.id] = { ...def }; _saveShortcuts(); renderShortcuts(); }
    });
  });
}

function _startScCapture(id) {
  if (_scCapturingId) _endScCapture(true);
  _scCapturingId = id;
  const row = document.querySelector(`.sp-shortcut-row[data-sc-id="${id}"]`);
  if (!row) return;
  row.classList.add('capturing');
  row.querySelector('.sp-keys-editable').innerHTML = '<kbd>Press key…</kbd>';
  function onKeydown(e) {
    if (['Control','Shift','Alt','Meta','CapsLock'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { _endScCapture(true); return; }
    const mods = [];
    if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
    if (e.shiftKey) mods.push('Shift');
    if (e.altKey) mods.push('Alt');
    shortcuts[id] = { ...shortcuts[id], key: e.key, modifiers: mods };
    _saveShortcuts();
    _endScCapture(false);
    renderShortcuts();
  }
  document.addEventListener('keydown', onKeydown, { capture: true });
  _scCaptureCleanup = () => document.removeEventListener('keydown', onKeydown, { capture: true });
}

function _endScCapture(cancel) {
  if (!_scCapturingId) return;
  if (_scCaptureCleanup) { _scCaptureCleanup(); _scCaptureCleanup = null; }
  const row = document.querySelector(`.sp-shortcut-row[data-sc-id="${_scCapturingId}"]`);
  if (row) row.classList.remove('capturing');
  _scCapturingId = null;
  if (cancel) renderShortcuts();
}

function _resetShortcuts() {
  shortcuts = Object.fromEntries(SHORTCUT_DEFAULTS.map(d => [d.id, { ...d }]));
  localStorage.removeItem('stagehand_shortcuts');
  renderShortcuts();
}

// ─── SETTINGS TABS ───────────────────────────────────────────
const _spTabBar     = document.getElementById('sp-tab-bar');
const _spTabBarWrap = document.querySelector('.sp-tab-bar-wrap');
const _spTabs       = document.querySelectorAll('.sp-tab');
const _spPanels     = document.querySelectorAll('.sp-tab-panel');
const _spScrollTrack = document.getElementById('sp-tab-scroll-track');
const _spScrollThumb = document.getElementById('sp-tab-scroll-thumb');
let   _activeTab = localStorage.getItem('spActiveTab') || 'general';

function _activateTab(name) {
  _spTabs.forEach(t => {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  _spPanels.forEach(p => p.classList.toggle('active', p.id === `sp-panel-${name}`));
  localStorage.setItem('spActiveTab', name);
  _activeTab = name;
}

_spTabs.forEach(t => t.addEventListener('click', e => {
  e.stopPropagation();
  _activateTab(t.dataset.tab);
}));

// ── Scroll UX ──────────────────────────────────────────────
let _spScrollTarget  = 0;
let _spScrollRaf     = null;
let _spScrollHideTimer = null;

function _updateTabBarFades() {
  if (!_spTabBar || !_spTabBarWrap) return;
  const { scrollLeft, scrollWidth, clientWidth } = _spTabBar;
  _spTabBarWrap.classList.toggle('can-scroll-left',  scrollLeft > 1);
  _spTabBarWrap.classList.toggle('can-scroll-right', scrollLeft < scrollWidth - clientWidth - 1);
}

function _updateScrollThumb() {
  if (!_spScrollTrack || !_spScrollThumb || !_spTabBar) return;
  const { scrollLeft, scrollWidth, clientWidth } = _spTabBar;
  if (scrollWidth <= clientWidth) return;
  const thumbPct = clientWidth / scrollWidth * 100;
  const thumbOff = scrollLeft / (scrollWidth - clientWidth) * (100 - thumbPct);
  _spScrollThumb.style.width = thumbPct + '%';
  _spScrollThumb.style.left  = thumbOff + '%';
}

function _showScrollIndicator() {
  if (!_spScrollTrack || !_spTabBar) return;
  if (_spTabBar.scrollWidth <= _spTabBar.clientWidth) return;
  _updateScrollThumb();
  _spScrollTrack.classList.add('visible');
  clearTimeout(_spScrollHideTimer);
  _spScrollHideTimer = setTimeout(() => _spScrollTrack.classList.remove('visible'), 900);
}

function _spBarScrollTo(target) {
  _spScrollTarget = Math.max(0, Math.min(
    _spTabBar.scrollWidth - _spTabBar.clientWidth, target
  ));
  if (_spScrollRaf) return;
  function step() {
    const diff = _spScrollTarget - _spTabBar.scrollLeft;
    if (Math.abs(diff) < 0.5) {
      _spTabBar.scrollLeft = _spScrollTarget;
      _spScrollRaf = null;
      _updateTabBarFades();
      return;
    }
    _spTabBar.scrollLeft += diff * 0.18;
    _updateTabBarFades();
    _spScrollRaf = requestAnimationFrame(step);
  }
  _spScrollRaf = requestAnimationFrame(step);
}

_spTabBar?.addEventListener('wheel', e => {
  if (e.deltaY === 0) return;
  e.preventDefault();
  const delta = e.deltaMode === 1 ? e.deltaY * 36 : e.deltaY;
  _spBarScrollTo(_spScrollTarget + delta);
  _showScrollIndicator();
}, { passive: false });

_spTabBar?.addEventListener('scroll', () => {
  _updateTabBarFades();
  _updateScrollThumb();
});

// init on popup open (second listener — runs after the toggle)
settingsBtn.addEventListener('click', () => {
  if (settingsPopup.classList.contains('hidden')) return;
  requestAnimationFrame(() => {
    _spScrollTarget = _spTabBar?.scrollLeft ?? 0;
    _updateTabBarFades();
    _showScrollIndicator();
  });
});

// restore saved tab
_activateTab(_activeTab);

// ── Collapsible sections within tabs ─────────────────────────
function _initSecCollapsed() {
  const stored = JSON.parse(localStorage.getItem('spSecCollapsed') || '{}');
  document.querySelectorAll('.sp-sec-hdr').forEach(hdr => {
    const key  = hdr.dataset.sec;
    const body = document.getElementById('sp-sec-' + key);
    if (!body) return;
    const collapsed = stored[key] === true;
    body.classList.toggle('open', !collapsed);
    hdr.classList.toggle('open', !collapsed);
  });
}
_initSecCollapsed();

settingsPopup.addEventListener('click', e => {
  const hdr = e.target.closest('.sp-sec-hdr');
  if (!hdr) return;
  e.stopPropagation();
  const key  = hdr.dataset.sec;
  const body = document.getElementById('sp-sec-' + key);
  if (!body) return;
  const opening = !body.classList.contains('open');
  body.classList.toggle('open', opening);
  hdr.classList.toggle('open', opening);
  const stored = JSON.parse(localStorage.getItem('spSecCollapsed') || '{}');
  stored[key] = !opening;
  localStorage.setItem('spSecCollapsed', JSON.stringify(stored));
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !settingsPopup.classList.contains('hidden')) {
    settingsPopup.classList.add('hidden');
    settingsBtn.classList.remove('active');
  }
  if (matchShortcut(e, 'select-all')) {
    const active = document.activeElement;
    if (!active || active === document.body || active.closest('#panel-library')) {
      e.preventDefault();
      visibleTracks.forEach(t => selectedIds.add(t.id));
      updateSelectionClasses();
    }
  }
  if ((matchShortcut(e, 'delete-selected') || e.key === 'Backspace') && selectedIds.size > 0) {
    const active = document.activeElement;
    if (!active || active === document.body || (active.closest('#panel-library') && !active.matches('input, textarea'))) {
      e.preventDefault();
      deleteSelectedTracks([...selectedIds]);
    }
  }
  // Escape clears search
  if (e.key === 'Escape' && searchQuery) {
    searchQuery = '';
    const input = document.getElementById('lib-search');
    if (input) input.value = '';
    document.getElementById('lib-search-clear')?.classList.remove('visible');
    renderCurrentTab();
  }
});

// ─── SEARCH ──────────────────────────────────────────────────
document.getElementById('lib-search').addEventListener('input', e => {
  searchQuery = e.target.value.trim();
  document.getElementById('lib-search-clear').classList.toggle('visible', searchQuery.length > 0);
  renderCurrentTab();
});
document.getElementById('lib-search-clear').addEventListener('click', () => {
  searchQuery = '';
  document.getElementById('lib-search').value = '';
  document.getElementById('lib-search-clear').classList.remove('visible');
  document.getElementById('lib-search').focus();
  renderCurrentTab();
});

// ─── SORT BAR ────────────────────────────────────────────────
document.getElementById('lib-sort-bar').addEventListener('click', e => {
  const btn = e.target.closest('.lib-sort-btn');
  if (!btn) return;
  const field = btn.dataset.sort;
  if (songsSortField === field) {
    songsSortDir = songsSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    songsSortField = field;
    songsSortDir = 'asc';
  }
  localStorage.setItem('songs_sort_field', songsSortField);
  localStorage.setItem('songs_sort_dir', songsSortDir);
  renderCurrentTab();
});

// ─── LOCATE NOW PLAYING ──────────────────────────────────────
document.getElementById('lib-locate-btn').addEventListener('click', () => {
  if (!currentPlayingId) return;
  // Switch to Songs tab
  document.querySelectorAll('.lib-tab').forEach(b => b.classList.remove('active'));
  document.querySelector('.lib-tab[data-tab="songs"]').classList.add('active');
  activeTab = 'songs';
  currentArtistView = null;
  currentAlbumView = null;
  // Clear search if it would filter out the playing track
  const playing = tracks.find(t => t.id === currentPlayingId);
  if (playing && searchQuery && !matchesSearch(playing)) {
    searchQuery = '';
    document.getElementById('lib-search').value = '';
    document.getElementById('lib-search-clear').classList.remove('visible');
  }
  renderCurrentTab();
  // Scroll to playing track
  const sorted = getSortedFilteredTracks();
  const idx = sorted.findIndex(t => t.id === currentPlayingId);
  if (idx !== -1) {
    const tl = document.getElementById('track-list');
    tl.scrollTop = Math.max(0, idx * ROW_H - tl.clientHeight / 2);
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
    if (activeTab !== 'albums') currentAlbumView = null;
    selectedIds.clear();
    selectedPlSlotIndices.clear();
    lastSelectedIdx = -1;
    renderCurrentTab();
  });

  btn.addEventListener('dragover', e => {
    if (!libDragIds) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
    const targetTab = btn.dataset.tab;
    if (targetTab === activeTab || tabHoverTarget === targetTab) return;
    tabHoverTarget = targetTab;
    clearTimeout(tabHoverTimer);
    btn.classList.add('drag-hover');
    tabHoverTimer = setTimeout(() => {
      document.querySelectorAll('.lib-tab').forEach(b => b.classList.remove('active', 'drag-hover'));
      btn.classList.add('active');
      activeTab = targetTab;
      if (activeTab !== 'artists') currentArtistView = null;
      if (activeTab !== 'albums') currentAlbumView = null;
      renderCurrentTab();
      tabHoverTarget = null; tabHoverTimer = null;
    }, 1000);
  });

  btn.addEventListener('dragleave', () => {
    if (!libDragIds) return;
    if (tabHoverTarget === btn.dataset.tab) {
      clearTimeout(tabHoverTimer); tabHoverTimer = null; tabHoverTarget = null;
      btn.classList.remove('drag-hover');
    }
  });
});

// ─── TRACK LIST (declared here for use in startRenameById) ───
const trackList = document.getElementById('track-list');

// Re-render virtual list when #track-list's own height changes (e.g. Tauri fullscreen transition).
let _trackListH = 0;
new ResizeObserver(entries => {
  const h = entries[0].contentRect.height;
  if (h > 0 && h !== _trackListH) {
    _trackListH = h;
    renderCurrentTab();
  }
}).observe(trackList);

// ─── VIRTUAL SCROLL LISTENER ─────────────────────────────────
let rafPending = false;
trackList.addEventListener('scroll', () => {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    if (activeTab === 'songs') {
      renderVirtualList(trackList, getSortedFilteredTracks(), buildTrackRow);
    } else if (activeTab === 'artists' && currentArtistView === null) {
      const groups = getArtistGroups();
      const artistItems = groups.map(([name, trks]) => {
        const artTrack = trks.find(t => ArtworkManager.getCachedArtwork(t)) || trks[0];
        return { name, count: trks.length, art: artTrack ? ArtworkManager.getCachedArtwork(artTrack) : null };
      });
      renderVirtualList(trackList, artistItems, (item) => buildArtistRow(item.name, item.count, item.art));
    } else if (activeTab === 'albums' && currentAlbumView === null) {
      const groups = getAlbumGroups();
      const albumItems = groups.map(([name, trks]) => ({
        name, count: trks.length,
        artists: [...new Set(trks.map(t => t.artist || '').filter(Boolean))]
      }));
      renderVirtualList(trackList, albumItems, (item) => buildAlbumRow(item.name, item.count, item.artists));
    }
    // drill-down views have their own scroll listener on the sub-container
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
    selectedIds.clear();
    lastSelectedIdx = -1;
    renderCurrentTab();
    return;
  }

  // Album row click -> drill down
  const albumRow = e.target.closest('.album-row[data-album]');
  if (albumRow) {
    currentAlbumView = albumRow.dataset.album;
    selectedIds.clear();
    lastSelectedIdx = -1;
    renderCurrentTab();
    return;
  }

  // Back button in drill-down -> return to list
  const backBtn = e.target.closest('.artist-back-btn');
  if (backBtn) {
    if (activeTab === 'albums') currentAlbumView = null;
    else currentArtistView = null;
    selectedIds.clear();
    lastSelectedIdx = -1;
    renderCurrentTab();
    return;
  }

  // Chord icon button
  const chordBtn = e.target.closest('.row-chord-btn[data-chord-id]');
  if (chordBtn) {
    e.stopPropagation();
    showChordModal(chordBtn.dataset.chordId);
    return;
  }

  // Hover play button
  const playBtn = e.target.closest('.row-play-btn[data-id]');
  if (playBtn) {
    e.stopPropagation();
    playTrack(playBtn.dataset.id);
    return;
  }

  // Context menu button (···)
  const ctxBtn = e.target.closest('.row-ctx-btn[data-id]');
  if (ctxBtn) {
    e.stopPropagation();
    const row = ctxBtn.closest('.track-row[data-id]');
    if (row.closest('.pl-track-list')) {
      const pl = playlists.find(p => p.id === selectedPlaylistId);
      const rowIdx = parseInt(row.dataset.plIdx, 10);
      showCtxMenu(e, row.dataset.id, pl ? { pl, idx: rowIdx } : null);
    } else {
      showCtxMenu(e, row.dataset.id);
    }
    return;
  }

  // Transpose reset/dec/inc buttons — must check before track-row click
  const xreset = e.target.closest('.xpose-reset[data-id]');
  if (xreset) {
    e.stopPropagation();
    applyTranspose(xreset.dataset.id, 0, true);
    return;
  }
  const xdec = e.target.closest('.xpose-dec');
  if (xdec) {
    e.stopPropagation();
    const t = tracks.find(x => x.id === xdec.dataset.id);
    if (!t) return;
    if (e.ctrlKey && e.shiftKey) applyCents(t.id, -10);
    else if (e.shiftKey)         applyCents(t.id, -1);
    else                         applyTranspose(t.id, (t.semitones || 0) - 1);
    return;
  }
  const xinc = e.target.closest('.xpose-inc');
  if (xinc) {
    e.stopPropagation();
    const t = tracks.find(x => x.id === xinc.dataset.id);
    if (!t) return;
    if (e.ctrlKey && e.shiftKey) applyCents(t.id, 10);
    else if (e.shiftKey)         applyCents(t.id, 1);
    else                         applyTranspose(t.id, (t.semitones || 0) + 1);
    return;
  }
  // Clicks on xpose-val open the popover
  const xval = e.target.closest('.xpose-val[data-id]');
  if (xval) {
    e.stopPropagation();
    if (_xpPopTrackId === xval.dataset.id) closeXposePopover();
    else openXposePopover(xval.dataset.id, xval);
    return;
  }

  // Track row click -> select (File Explorer style), double-click -> play
  const row = e.target.closest('.track-row[data-id]');
  if (!row) {
    // Clicks inside the playlists pane (date input, buttons, etc.) must not trigger re-render
    if (e.target.closest('.playlists-container')) return;
    // Clicked empty space — deselect all
    selectedIds.clear();
    selectedPlSlotIndices.clear();
    lastSelectedIdx = -1;
    updateSelectionClasses();
    return;
  }
  const id = row.dataset.id;
  const isPlRow = !!row.closest('.pl-track-list');
  if (isPlRow) {
    // Playlist row — select by slot index so duplicate tracks stay independent
    const plIdx = parseInt(row.dataset.plIdx, 10);
    selectedIds.clear();
    if (e.ctrlKey || e.metaKey) {
      if (selectedPlSlotIndices.has(plIdx)) selectedPlSlotIndices.delete(plIdx);
      else selectedPlSlotIndices.add(plIdx);
    } else if (e.shiftKey && lastSelectedIdx !== -1) {
      const start = Math.min(lastSelectedIdx, plIdx);
      const end   = Math.max(lastSelectedIdx, plIdx);
      for (let i = start; i <= end; i++) selectedPlSlotIndices.add(i);
    } else {
      selectedPlSlotIndices.clear();
      selectedPlSlotIndices.add(plIdx);
    }
    lastSelectedIdx = plIdx;
    updateSelectionClasses();
    return;
  }
  const now = Date.now();
  if (!e.ctrlKey && !e.metaKey && !e.shiftKey && lastClickId === id && (now - lastClickTime) < DBL_CLICK_MS) {
    // Double-click detected — play
    lastClickId = null;
    lastClickTime = 0;
    playTrack(id);
    return;
  }
  lastClickId = id;
  lastClickTime = now;
  selectedPlSlotIndices.clear();
  const idx = visibleTracks.findIndex(t => t.id === id);
  if (e.ctrlKey || e.metaKey) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    if (idx !== -1) lastSelectedIdx = idx;
  } else if (e.shiftKey && lastSelectedIdx !== -1 && idx !== -1) {
    const start = Math.min(lastSelectedIdx, idx);
    const end   = Math.max(lastSelectedIdx, idx);
    for (let i = start; i <= end; i++) selectedIds.add(visibleTracks[i].id);
  } else {
    selectedIds.clear();
    selectedIds.add(id);
    lastSelectedIdx = idx !== -1 ? idx : 0;
  }
  updateSelectionClasses();
});

// ─── TRANSPOSE + CENTS POPOVER ───────────────────────────────
let _xpPopTrackId = null;

function openXposePopover(trackId, anchorEl) {
  _xpPopTrackId = trackId;
  _syncXposePopover();
  const pop = document.getElementById('xpose-popover');
  pop.hidden = false;
  // Position below anchor, clamped to viewport
  const rect = anchorEl.getBoundingClientRect();
  const pw = pop.offsetWidth || 160;
  const left = Math.min(rect.left, window.innerWidth - pw - 8);
  pop.style.left = Math.max(4, left) + 'px';
  pop.style.top  = (rect.bottom + 4) + 'px';
}

function closeXposePopover() {
  document.getElementById('xpose-popover').hidden = true;
  _xpPopTrackId = null;
}

function _syncXposePopover() {
  if (!_xpPopTrackId) return;
  const track = tracks.find(t => t.id === _xpPopTrackId);
  if (!track) return;
  const st  = track.semitones || 0;
  const cts = track.cents ?? 0;
  document.getElementById('xp-st-val').textContent    = st > 0 ? `+${st}st` : `${st}st`;
  document.getElementById('xp-cents-val').textContent  = cts > 0 ? `+${cts}¢` : `${cts}¢`;
  document.getElementById('xp-st-val').classList.toggle('xpose-active', st !== 0);
  document.getElementById('xp-cents-val').classList.toggle('cents-active', cts !== 0);
  document.getElementById('xp-reset').classList.toggle('xpose-reset-visible', st !== 0 || cts !== 0);
}

document.getElementById('xp-dec').addEventListener('click', () => {
  if (!_xpPopTrackId) return;
  const t = tracks.find(x => x.id === _xpPopTrackId);
  if (t) { applyTranspose(t.id, (t.semitones || 0) - 1); _syncXposePopover(); }
});
document.getElementById('xp-inc').addEventListener('click', () => {
  if (!_xpPopTrackId) return;
  const t = tracks.find(x => x.id === _xpPopTrackId);
  if (t) { applyTranspose(t.id, (t.semitones || 0) + 1); _syncXposePopover(); }
});
document.getElementById('xp-cdec').addEventListener('click', e => {
  if (!_xpPopTrackId) return;
  applyCents(_xpPopTrackId, e.ctrlKey ? -10 : -1);
  _syncXposePopover();
});
document.getElementById('xp-cinc').addEventListener('click', e => {
  if (!_xpPopTrackId) return;
  applyCents(_xpPopTrackId, e.ctrlKey ? 10 : 1);
  _syncXposePopover();
});
document.getElementById('xp-reset').addEventListener('click', () => {
  if (!_xpPopTrackId) return;
  applyTranspose(_xpPopTrackId, 0, true);
  _syncXposePopover();
});

// Double-click semitone value inside popover → inline type
document.getElementById('xp-st-val').addEventListener('dblclick', () => {
  if (!_xpPopTrackId) return;
  const track = tracks.find(t => t.id === _xpPopTrackId);
  if (!track) return;
  const valEl  = document.getElementById('xp-st-val');
  const current = track.semitones || 0;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.className = 'xpose-inline-input';
  input.style.width = '44px';
  input.setAttribute('aria-label', 'Semitones (-12 to +12)');
  valEl.replaceWith(input);
  input.focus(); input.select();
  function commit() {
    const parsed = parseInt(input.value.trim(), 10);
    const val = isNaN(parsed) ? current : Math.max(-12, Math.min(12, parsed));
    input.replaceWith(valEl);
    applyTranspose(track.id, val);
    _syncXposePopover();
  }
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter')  { ev.preventDefault(); commit(); }
    if (ev.key === 'Escape') { ev.preventDefault(); input.replaceWith(valEl); }
  });
  input.addEventListener('blur', commit);
});

// Close popover on outside click
document.addEventListener('click', e => {
  if (!_xpPopTrackId) return;
  if (!e.target.closest('#xpose-popover') && !e.target.closest('.xpose-val[data-id]') && !e.target.closest('#mp-semitones-val')) {
    closeXposePopover();
  }
}, true);

// Album row right-click → Set Artwork
const artFileInput = document.createElement('input');
artFileInput.type = 'file';
artFileInput.accept = 'image/jpeg,image/png,image/webp';
artFileInput.style.display = 'none';
document.body.appendChild(artFileInput);
let artFileInputKey = null;

// Album artwork is set via the album context menu (see showAlbumCtxMenu / albumCtxMenu click handler)

artFileInput.addEventListener('change', async () => {
  const file = artFileInput.files[0];
  if (!file || !artFileInputKey) return;
  try {
    const dataUrl = await ArtworkManager.storeManualArtwork(artFileInputKey, file);
    renderCurrentTab();
    refreshRowArt();
    // Refresh info modal thumbnail if still open
    const thumbBox = document.getElementById('info-art-thumb');
    if (thumbBox && document.getElementById('info-overlay').classList.contains('show')) {
      thumbBox.innerHTML = '';
      const img = document.createElement('img'); img.src = dataUrl; thumbBox.appendChild(img);
    }
  } catch(e) {
    notify('Could not set artwork: ' + (e.message || 'unknown'), 'error');
  }
  artFileInputKey = null;
});

trackList.addEventListener('contextmenu', e => {
  const row = e.target.closest('.track-row[data-id]');
  if (!row || e.target.closest('.album-row[data-album]')) return;
  // Detect if this row is inside a playlist track list
  if (row.closest('.pl-track-list')) {
    const plId = selectedPlaylistId;
    const pl = playlists.find(p => p.id === plId);
    const idx = parseInt(row.dataset.plIdx, 10);
    showCtxMenu(e, row.dataset.id, pl ? { pl, idx } : null);
  } else {
    showCtxMenu(e, row.dataset.id);
  }
});

// ─── CONTEXT MENU ────────────────────────────────────────────
let ctxMenuTrackId = null;
let ctxMenuPlContext = null; // { pl, idx } when right-clicking inside a playlist
const ctxMenu = document.getElementById('ctx-menu');

function showCtxMenu(e, trackId, plContext = null) {
  e.preventDefault();
  ctxMenuPlContext = plContext;
  // Right-clicking an unselected row: select only it
  if (plContext) {
    if (!selectedPlSlotIndices.has(plContext.idx)) {
      selectedIds.clear();
      selectedPlSlotIndices.clear();
      selectedPlSlotIndices.add(plContext.idx);
      lastSelectedIdx = plContext.idx;
      updateSelectionClasses();
    }
  } else if (!selectedIds.has(trackId)) {
    selectedPlSlotIndices.clear();
    selectedIds.clear();
    selectedIds.add(trackId);
    lastSelectedIdx = visibleTracks.findIndex(t => t.id === trackId);
    updateSelectionClasses();
  }
  ctxMenuTrackId = trackId;
  // Rename only available for a single selection
  const selCount = plContext ? selectedPlSlotIndices.size : selectedIds.size;
  ctxMenu.querySelector('[data-action="rename"]')
    .classList.toggle('ctx-disabled', selCount !== 1);
  // "Remove from Playlist" only visible when inside a playlist
  ctxMenu.querySelector('[data-action="remove-from-playlist"]')
    .classList.toggle('ctx-hidden', !plContext);
  // "Relocate file…" only visible when the track's file is missing
  const isMissing = !!tracks.find(t => t.id === trackId)?._missing;
  ctxMenu.querySelector('[data-action="relocate"]')
    .classList.toggle('ctx-hidden', !isMissing);
  const x = Math.min(e.clientX, window.innerWidth - 160);
  const y = Math.min(e.clientY, window.innerHeight - 160);
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
    showAddToPlaylistSubmenu(e, selectedIds.size > 0 ? [...selectedIds] : [ctxMenuTrackId]);
    return;
  }
  ctxMenu.classList.remove('show');
  if (action === 'play') {
    playTrack(ctxMenuTrackId);
  } else if (action === 'info') {
    const ids = selectedIds.size > 0 ? [...selectedIds] : [ctxMenuTrackId];
    showInfoModal(ids);
  } else if (action === 'rename') {
    startRenameById(ctxMenuTrackId);
  } else if (action === 'delete') {
    deleteSelectedTracks([...selectedIds]);
  } else if (action === 'remove-from-playlist') {
    if (ctxMenuPlContext) {
      const { pl, idx } = ctxMenuPlContext;
      pl.slots.splice(idx, 1);
      LibraryManager.savePlaylist(pl).catch(e => console.warn('Playlist save failed:', e));
      renderCurrentTab();
    }
  } else if (action === 'select-all') {
    visibleTracks.forEach(t => selectedIds.add(t.id));
    updateSelectionClasses();
  } else if (action === 'relocate') {
    handleRelocate(ctxMenuTrackId);
  }
});

// ─── ALBUM CONTEXT MENU ──────────────────────────────────────
let albumCtxMenuName = null;
const albumCtxMenu = document.getElementById('album-ctx-menu');

function showAlbumCtxMenu(e, albumName) {
  e.preventDefault();
  albumCtxMenuName = albumName;
  const x = Math.min(e.clientX, window.innerWidth  - 140);
  const y = Math.min(e.clientY, window.innerHeight - 60);
  albumCtxMenu.style.left = x + 'px';
  albumCtxMenu.style.top  = y + 'px';
  albumCtxMenu.classList.add('show');
}

trackList.addEventListener('contextmenu', e => {
  const row = e.target.closest('.album-row[data-album]');
  if (!row) return;
  showAlbumCtxMenu(e, row.dataset.album);
});

albumCtxMenu.addEventListener('click', e => {
  const action = e.target.closest('[data-album-action]')?.dataset.albumAction;
  if (!action || !albumCtxMenuName) return;
  albumCtxMenu.classList.remove('show');
  if (action === 'info') {
    const albumTracks = tracks.filter(t => (t.album || '').trim() === albumCtxMenuName || (albumCtxMenuName === 'Unknown Album' && !t.album?.trim()));
    showInfoModal(albumTracks.map(t => t.id));
  } else if (action === 'set-art') {
    const repTrack = tracks.find(t => (t.album || '').trim() === albumCtxMenuName || (!t.album && albumCtxMenuName === 'Unknown Album'));
    if (repTrack) {
      artFileInputKey = ArtworkManager.artworkKeyFor(repTrack);
      artFileInput.value = '';
      artFileInput.click();
    }
  }
});

document.addEventListener('click', () => albumCtxMenu.classList.remove('show'));
document.addEventListener('contextmenu', e => {
  if (!e.target.closest('.album-row')) albumCtxMenu.classList.remove('show');
});
trackList.addEventListener('scroll', () => albumCtxMenu.classList.remove('show'));

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

// Import button opens native OS file picker (returns absolute paths)
importBtn.addEventListener('click', () => {
  invoke('open_audio_files_dialog').then(paths => {
    if (paths && paths.length) importFilePaths(paths);
  }).catch(e => console.warn('File dialog failed:', e));
});

// Keep hidden file input as browser fallback (dev mode / non-Tauri)
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) importFiles(Array.from(fileInput.files));
  fileInput.value = '';
});

// Visual feedback for drag-over (HTML events)
libraryPanel.addEventListener('dragover', e => {
  if (!e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  libraryPanel.classList.add('drag-over');
});
libraryPanel.addEventListener('dragleave', e => {
  if (!libraryPanel.contains(e.relatedTarget)) libraryPanel.classList.remove('drag-over');
});
// HTML drop — browser/dev-mode fallback only; skip in Tauri (native event fires instead)
libraryPanel.addEventListener('drop', e => {
  e.preventDefault();
  libraryPanel.classList.remove('drag-over');
  if (window.__TAURI__) return; // tauri://drag-drop handles it with absolute paths
  if (e.dataTransfer.files.length > 0) importFiles(Array.from(e.dataTransfer.files));
});

// Tauri native drag-drop — gives absolute paths, fires instead of/alongside HTML drop
listen('tauri://drag-drop', event => {
  const paths = event?.payload?.paths;
  libraryPanel.classList.remove('drag-over');
  if (Array.isArray(paths) && paths.length > 0) importFilePaths(paths);
});
listen('tauri://drag-over', () => libraryPanel.classList.add('drag-over'));
listen('tauri://drag-cancel', () => libraryPanel.classList.remove('drag-over'));

// ─── METRONOME MINIPLAYER SYNC ────────────────────────────────
function renderBeatDots(count) {
  const container = document.getElementById('mm-beat-dots');
  if (!container) return;
  container.innerHTML = Array.from({ length: count }, () => '<span class="mm-beat-dot"></span>').join('');
}

Metronome.onBeat((beatIdx) => {
  const btn = document.getElementById('mm-bpm-display');
  btn.classList.add('beat-flash');
  setTimeout(() => btn.classList.remove('beat-flash'), 80);
  const dots = document.querySelectorAll('.mm-beat-dot');
  dots.forEach(d => d.classList.remove('active'));
  if (beatIdx !== undefined && dots[beatIdx]) dots[beatIdx].classList.add('active');
});

function syncMetroMini() {
  const bpm = Metronome.getBpm();
  document.querySelector('#mm-bpm-display .mm-bpm-num').textContent = bpm;
  document.getElementById('metro-mini-bpm').textContent = bpm + ' bpm';
  const active = Metronome.isActive();
  document.getElementById('mm-play-btn').innerHTML = active ? ICONS.stop : ICONS.play;
  document.getElementById('mm-play-btn').classList.toggle('running', active);
}

// ─── SIDEBAR SECTION COLLAPSE ────────────────────────────────
function applyCollapse(bodyId, btnId, collapsed) {
  document.getElementById(bodyId).classList.toggle('collapsed', collapsed);
  document.getElementById(btnId).classList.toggle('collapsed', collapsed);
}


function initSectionCollapse() {
  const metroCollapsed = localStorage.getItem('metroCollapsed') === 'true';
  applyCollapse('metro-body-wrap', 'metro-collapse-btn', metroCollapsed);
  document.getElementById('metro-mini-bpm').classList.toggle('hidden', !metroCollapsed);
  document.getElementById('metro-mini').classList.toggle('collapsed', metroCollapsed);
  syncMetroMini();

  document.getElementById('metro-hdr').addEventListener('click', () => {
    const collapsed = !document.getElementById('metro-body-wrap').classList.contains('collapsed');
    localStorage.setItem('metroCollapsed', collapsed);
    applyCollapse('metro-body-wrap', 'metro-collapse-btn', collapsed);
    document.getElementById('metro-mini-bpm').classList.toggle('hidden', !collapsed);
    document.getElementById('metro-mini').classList.toggle('collapsed', collapsed);
  });
}

// ─── METRONOME MINIPLAYER BINDINGS ────────────────────────────
function toggleMetronome() {
  resume();
  if (Metronome.isActive()) {
    Metronome.stop();
    document.querySelectorAll('.mm-beat-dot').forEach(d => d.classList.remove('active'));
  } else { Metronome.start(); }
  syncMetroMini();
}
document.getElementById('mm-play-btn').addEventListener('mousedown', e => { e.preventDefault(); toggleMetronome(); });

// BPM display — click to type BPM inline
document.getElementById('mm-bpm-display').addEventListener('click', () => {
  const display = document.getElementById('mm-bpm-display');
  const input = document.getElementById('mm-bpm-inline');
  input.value = Metronome.getBpm();
  display.classList.add('hidden');
  input.classList.remove('hidden');
  input.focus();
  input.select();
});

function commitBpmInline() {
  const display = document.getElementById('mm-bpm-display');
  const input = document.getElementById('mm-bpm-inline');
  const raw = parseFloat(input.value);
  if (!isNaN(raw)) {
    Metronome.setBpm(Math.min(300, Math.max(20, raw)));
    syncMetroMini();
  }
  input.classList.add('hidden');
  display.classList.remove('hidden');
}
document.getElementById('mm-bpm-inline').addEventListener('blur', commitBpmInline);
document.getElementById('mm-bpm-inline').addEventListener('keydown', (e) => {
  if (['e', 'E', '+', '-'].includes(e.key)) e.preventDefault();
  if (e.key === 'Enter') { e.preventDefault(); commitBpmInline(); }
  if (e.key === 'Escape') {
    const input = document.getElementById('mm-bpm-inline');
    input.classList.add('hidden');
    document.getElementById('mm-bpm-display').classList.remove('hidden');
  }
});

// TAP button — tap tempo
document.getElementById('mm-tap-btn').addEventListener('click', () => {
  resume();
  const bpm = TapTempo.tap();
  if (bpm) { Metronome.setBpm(bpm); }
  syncMetroMini();
});

document.getElementById('mm-bpm-minus').addEventListener('click', () => {
  Metronome.setBpm(Metronome.getBpm() - 1);
  syncMetroMini();
});
document.getElementById('mm-bpm-plus').addEventListener('click', () => {
  Metronome.setBpm(Metronome.getBpm() + 1);
  syncMetroMini();
});

document.getElementById('mm-subdiv-select').addEventListener('change', function() {
  const subdiv = parseInt(this.value);
  Metronome.setSubdivision(subdiv);
  localStorage.setItem('metronomeSubdiv', subdiv);
});

const SUBDIV_ICONS = { 1: '♩', 2: '♪', 3: '♪³', 4: '♬' };
function syncSubdivBtn(val) {
  const btn = document.getElementById('mm-subdiv-btn');
  if (btn) btn.textContent = SUBDIV_ICONS[val] || '♩';
}

const _subdivOrder = [1, 2, 3, 4];
document.getElementById('mm-subdiv-btn').addEventListener('click', () => {
  const sel = document.getElementById('mm-subdiv-select');
  const cur = parseInt(sel.value) || 1;
  const next = _subdivOrder[(_subdivOrder.indexOf(cur) + 1) % _subdivOrder.length];
  sel.value = next;
  sel.dispatchEvent(new Event('change'));
  syncSubdivBtn(next);
});

document.getElementById('mm-vol').addEventListener('input', function() {
  Metronome.setVolume(this.value / 100);
  localStorage.setItem('metronomeVolume', this.value);
  updateRangeFill(this);
});

// Accent toggle
function syncAccentBtns(enabled) {
  document.getElementById('mm-accent-btn').classList.toggle('active', enabled);
}
document.getElementById('mm-accent-btn').addEventListener('click', function() {
  const enabled = !Metronome.getAccent();
  Metronome.setAccent(enabled);
  syncAccentBtns(enabled);
  localStorage.setItem('metronomeAccent', enabled);
});

// ─── TIME SIGNATURE ───────────────────────────────────────────
function syncTimeSigUI(num, den) {
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

document.getElementById('mm-timesig-select').addEventListener('change', function() {
  if (this.value === 'custom') return;
  const [num, den] = this.value.split('/').map(Number);
  applyTimeSignature(num, den);
  renderBeatDots(num);
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
    document.querySelector(`.clear-click-btn[data-type="${activeType}"]`).classList.remove('hidden');
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
      btn.classList.add('hidden');
      LibraryManager.deleteSetting('click_' + type);
    });
  });
}


// ─── LOOP (SCRUB BAR) ────────────────────────────────────────
function updateLoopOverlays(player) {
  const W = mpScrubBar.offsetWidth;
  const inPx  = player.loopStart * W;
  const outPx = player.loopEnd   * W;
  document.getElementById('mp-loop-region').style.left  = inPx + 'px';
  document.getElementById('mp-loop-region').style.width = (outPx - inPx) + 'px';
  document.getElementById('mp-loop-handle-in').style.left  = inPx  + 'px';
  document.getElementById('mp-loop-handle-out').style.left = outPx + 'px';
}

function formatTimeMs(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function syncLoopTimesDisplay(player) {
  const isFullLoop = player.loopStart < 0.001 && player.loopEnd > 0.999;
  document.getElementById('mp-loop-times').classList.toggle('hidden', !player.loopEnabled || isFullLoop);
  document.getElementById('mp-loop-region').classList.toggle('hidden', isFullLoop);
  document.getElementById('mp-loop-in-disp').textContent  = formatTimeMs(player.loopStart * player.duration);
  document.getElementById('mp-loop-out-disp').textContent = formatTimeMs(player.loopEnd   * player.duration);
}

function syncLoopActiveState(player) {
  document.getElementById('mp-loop-btn').classList.toggle('loop-active', player.loopEnabled);
  document.getElementById('mp-loop-region').classList.toggle('loop-active', player.loopEnabled);
  document.getElementById('mp-loop-handle-in').classList.toggle('loop-active', player.loopEnabled);
  document.getElementById('mp-loop-handle-out').classList.toggle('loop-active', player.loopEnabled);
}


// Scrub bar mousedown — check for loop handle drag before seeking
const _origScrubMousedown = mpScrubBar.onmousedown;
mpScrubBar.addEventListener('mousedown', e => {
  if (!currentPlayingId) return;
  const handle = e.target.closest('.mp-loop-handle');
  if (!handle) return;   // falls through to the existing seek handler
  const player = players[currentPlayingId];
  if (!player) return;
  loopDragHandle = handle.dataset.handle;
  document.addEventListener('mousemove', onLoopDragMove);
  document.addEventListener('mouseup',   onLoopDragUp);
  e.stopPropagation();   // prevent seek handler from also firing
  e.preventDefault();
}, true);  // capture phase so it runs before the seek mousedown

function onLoopDragMove(e) {
  if (!loopDragHandle || !currentPlayingId) return;
  const player = players[currentPlayingId];
  const rect = mpScrubBar.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const minGap = Math.max(0.005, 0.1 / (player.duration || 1));
  if (loopDragHandle === 'in')
    player.setLoopPoints(Math.min(frac, player.loopEnd - minGap), player.loopEnd);
  else
    player.setLoopPoints(player.loopStart, Math.max(frac, player.loopStart + minGap));
  updateLoopOverlays(player);
  syncLoopTimesDisplay(player);
}

function onLoopDragUp() {
  document.removeEventListener('mousemove', onLoopDragMove);
  document.removeEventListener('mouseup',   onLoopDragUp);
  loopDragHandle = null;
}

// Loop toggle button
document.getElementById('mp-loop-btn').addEventListener('click', () => {
  if (!currentPlayingId) return;
  const player = players[currentPlayingId];
  player.setLoopEnabled(!player.loopEnabled);
  syncLoopActiveState(player);
  syncLoopTimesDisplay(player);
});

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
  document.getElementById('mm-subdiv-select').value = subdiv;
  syncSubdivBtn(subdiv);

  // Restore accent toggle
  const storedAccent = localStorage.getItem('metronomeAccent');
  if (storedAccent !== null) {
    const enabled = storedAccent === 'true';
    Metronome.setAccent(enabled);
    syncAccentBtns(enabled);
  }

  // Render beat dots for current time signature
  renderBeatDots(Metronome.getTimeSignature().numerator);

  initSectionCollapse();
  syncMetroMini();
  document.getElementById('track-list').innerHTML =
    '<div class="lib-empty-state"><div class="es-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg></div><div class="es-text">Loading Library…</div></div>';
  await loadLibrary();

  // Background decode complete — update waveform and cache peaks in IDB.
  // Rust now includes track_id in the payload so we can apply peaks to the
  // correct track regardless of when the event arrives relative to showMiniplayer.
  listen('peaks_ready', e => {
    try {
      const { track_id, duration, peaks } = e.payload;

      // Always update the in-memory track so showMiniplayer finds peaks even
      // if it's called after this event (timing race with prefetch/fast decode).
      const track = tracks.find(t => t.id === track_id);
      if (track) {
        if (!track.peaks?.length) track.peaks = peaks;
        if (!track.nativeDuration) track.nativeDuration = duration;
        const durationChanged = !track.duration && duration > 0;
        if (durationChanged) track.duration = duration;
        LibraryManager.saveMeta({
          id: track_id,
          peaks,
          nativeDuration: duration,
          duration: duration || track.duration,
          sampleRate: track.sampleRate,
        }).catch(() => {});
        if (durationChanged) renderTrackList();
      }

      const player = players[track_id];
      if (player) {
        if (player.duration === 0) player.duration = duration;
        if (!player.peaks) player.peaks = peaks;
      }

      // Only update the visible waveform if this track is currently displayed.
      if (track_id !== currentPlayingId) return;

      // Rust peaks supersede any JS-decoded peaks (full stereo + higher precision)
      currentPlayerPeaks = peaks;
      _rebuildWaveformLayers();
    } catch (err) {
      console.error('[stagehand] peaks_ready handler error:', err.name, err.message);
    }
  });

  // Tauri playback events — drive progress bar and auto-next
  listen('playback_progress', e => {
    const { position, duration, fraction } = e.payload;
    if (currentPlayingId && players[currentPlayingId]) {
      players[currentPlayingId].pauseOffset = position;
    }
    updateMiniplayerProgress(fraction, position, duration);
  });
  listen('playback_ended', () => {
    const player = players[currentPlayingId];
    if (player) { player.isPlaying = false; player.pauseOffset = 0; player._paused = false; }
    const next = getAutoNextTrack(currentPlayingId);
    if (next) {
      if (next.slotIdx !== null) {
        playTrack(next.track.id, activePlaylistId, next.slotIdx);
      } else {
        playTrack(next.track.id);
      }
    } else {
      hideMiniplayer();
      renderCurrentTab();
    }
  });

  // Restore persisted click sounds
  const ctx = resume();
  for (const type of ['accent', 'quarter', 'eighth', 'subdivision']) {
    const record = await LibraryManager.getSetting('click_' + type);
    if (!record) continue;
    try {
      const buf = await ctx.decodeAudioData(record.data.slice(0));
      Metronome.setCustomBuffer(type, buf);
      document.querySelector(`.click-sound-name[data-type="${type}"]`).textContent = record.name;
      document.querySelector(`.clear-click-btn[data-type="${type}"]`).classList.remove('hidden');
    } catch(e) {
      console.error('Failed to restore click sound:', type, e);
    }
  }
})();
