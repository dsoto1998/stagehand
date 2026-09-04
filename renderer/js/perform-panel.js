// ─── PROCESSING QUEUE + PERFORM PANELS ───────────────────────
//
// Owns two sidebar panels:
//   #panel-queue    — click-track analysis jobs (live progress from Rust events)
//   #panel-perform  — songs that have a click track; plays them with a 2-bar
//                     count-off, click locked to the recording.
//
// Playback in Perform mode goes through TrackPlayer directly (same Rust engine
// as the library); the click is the Web Audio metronome, re-anchored to the
// reported song position on every playback_progress event.

import * as LibraryManager from './library-manager.js';
import { TrackPlayer, players } from './track-player.js';
import { Metronome } from './metronome.js';
import { getCtx, resume } from './audio-engine.js';
import { listen, invoke } from './tauri-api.js';
import { formatTime } from './ui-utils.js';
import { buildClickSchedule } from './click-utils.js';

const OFFSET_KEY = 'stagehand_perform_offset'; // milliseconds

let deps = {
  getTracks: () => [],
  getMasterVolume: () => 1,
  notify: () => {},
  onBeforePerform: () => {},
  onClickTrackReady: () => {},
};

// jobs: trackId -> { state, message }
const jobs = new Map();

let selectedPerformId = null;
let performing = false;
let starting = false; // true from the first click until performing flips true (or it aborts) — blocks a second click from double-scheduling
let performPlayer = null;
let performTrackId = null;
let startWatchRaf = null;
let offsetMs = parseInt(localStorage.getItem(OFFSET_KEY) || '0', 10) || 0;

// ─── init ────────────────────────────────────────────────────

export function initPerformPanel(options = {}) {
  deps = { ...deps, ...options };

  wireOffsetSlider();
  wirePerformTransport();

  listen('clicktrack_progress', e => onJobEvent(e.payload)).catch(() => {});
  listen('clicktrack_done', e => onJobDone(e.payload)).catch(() => {});
  listen('clicktrack_error', e => onJobEvent({ ...e.payload, stage: 'error' })).catch(() => {});
  listen('playback_progress', e => {
    if (performing) Metronome.reanchorClickSchedule(getCtx().currentTime, e.payload.position);
  }).catch(() => {});
  listen('playback_ended', () => { if (performing) stopPerform(); }).catch(() => {});

  // Rebuild the queue after an app restart.
  invoke('clicktrack_status').then(list => {
    for (const j of list || []) jobs.set(j.track_id, { state: j.state, message: j.message });
    renderQueue();
  }).catch(() => {});

  renderQueue();
  renderPerformList();
}

/** Called by ui-controller when a "Create Click Track" action is dispatched. */
export function markQueued(trackIds) {
  for (const id of trackIds) jobs.set(id, { state: 'queued' });
  renderQueue();
  updateBadge();
}

/** Called by ui-controller after the library `tracks` array changes. */
export function refreshPerformData() {
  renderPerformList();
  renderQueue();
}

// ─── job events ──────────────────────────────────────────────

function onJobEvent(payload) {
  if (!payload || !payload.track_id) return;
  jobs.set(payload.track_id, { state: payload.stage, message: payload.message || null });
  renderQueue();
  updateBadge();
  if (payload.stage === 'error' && payload.message && payload.message !== 'cancelled') {
    const t = deps.getTracks().find(x => x.id === payload.track_id);
    deps.notify(`Click track failed for "${t?.name || payload.track_id}": ${payload.message}`, 'error');
  }
}

async function onJobDone(payload) {
  const { track_id, numerator, tempo_bpm } = payload;
  jobs.set(track_id, { state: 'done' });
  updateBadge();

  const track = deps.getTracks().find(t => t.id === track_id);
  const clickTrack = {
    status: 'ready',
    numerator: numerator || 4,
    tempoBpm: tempo_bpm || null,
    generatedAt: Date.now(),
  };
  const meta = { id: track_id, clickTrack };
  if (track && !track.timeSig && numerator) meta.timeSig = `${numerator}/4`;

  if (track) {
    track.clickTrack = clickTrack;
    if (meta.timeSig) track.timeSig = meta.timeSig;
  }
  try { await LibraryManager.saveMeta(meta); } catch (e) { console.warn('saveMeta clickTrack failed', e); }

  deps.notify(`Click track ready: "${track?.name || track_id}"`, 'success');
  deps.onClickTrackReady(track_id);
  renderQueue();
  renderPerformList();
}

// ─── Processing Queue panel ──────────────────────────────────

const STAGE_LABEL = {
  queued: 'Queued', decoding: 'Decoding…', analyzing: 'Analyzing…', done: 'Done', error: 'Failed',
};

function renderQueue() {
  const list = document.getElementById('queue-list');
  if (!list) return;
  const tracksById = new Map(deps.getTracks().map(t => [t.id, t]));
  const entries = [...jobs.entries()];

  if (!entries.length) {
    list.innerHTML = '<div class="perform-empty">No click tracks have been requested yet.<br>Right-click a song in the Library and choose <b>Create Click Track</b>.</div>';
    return;
  }

  list.innerHTML = entries.map(([id, j]) => {
    const t = tracksById.get(id);
    const name = t?.name || id;
    const active = j.state === 'decoding' || j.state === 'analyzing';
    const pct = j.state === 'done' ? 100 : j.state === 'analyzing' ? 66 : j.state === 'decoding' ? 25 : j.state === 'queued' ? 8 : 0;
    const label = j.state === 'error' ? (j.message || 'Failed') : STAGE_LABEL[j.state] || j.state;
    return `
      <div class="queue-row ${j.state}">
        <div class="queue-row-name" title="${escAttr(name)}">${escHtml(name)}</div>
        <div class="queue-row-bar"><div class="queue-row-fill ${active ? 'anim' : ''}" style="width:${pct}%"></div></div>
        <div class="queue-row-state">${escHtml(label)}</div>
        ${j.state === 'queued' || j.state === 'error'
          ? `<button class="queue-row-x" data-cancel="${escAttr(id)}" title="Remove">&times;</button>`
          : '<span class="queue-row-x-spacer"></span>'}
      </div>`;
  }).join('');

  list.querySelectorAll('[data-cancel]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.cancel;
      invoke('clicktrack_cancel', { trackId: id }).catch(() => {});
      jobs.delete(id);
      renderQueue();
      updateBadge();
    });
  });
}

function updateBadge() {
  const badge = document.getElementById('queue-badge');
  if (!badge) return;
  const active = [...jobs.values()].filter(j => j.state === 'queued' || j.state === 'decoding' || j.state === 'analyzing').length;
  badge.textContent = String(active);
  badge.classList.toggle('hidden', active === 0);
}

// ─── Perform panel ───────────────────────────────────────────

function performTracks() {
  return deps.getTracks().filter(t => t.clickTrack?.status === 'ready' && t.filePath);
}

function renderPerformList() {
  const list = document.getElementById('perform-list');
  if (!list) return;
  const rows = performTracks();

  const countLabel = document.getElementById('perform-count-label');
  if (countLabel) countLabel.textContent = rows.length ? `${rows.length} song${rows.length > 1 ? 's' : ''}` : '';

  if (!rows.length) {
    list.innerHTML = '<div class="perform-empty">No songs have a click track yet.</div>';
    return;
  }

  list.innerHTML = rows.map(t => {
    const sub = [t.artist, t.timeSig, t.clickTrack.tempoBpm ? `${Math.round(t.clickTrack.tempoBpm)} bpm` : '']
      .filter(Boolean).join(' · ');
    return `
      <div class="perform-row ${t.id === selectedPerformId ? 'selected' : ''}" data-id="${escAttr(t.id)}">
        <div class="perform-row-main">
          <div class="perform-row-name">${escHtml(t.name)}</div>
          <div class="perform-row-sub">${escHtml(sub)}</div>
        </div>
        <div class="perform-row-dur">${t.duration ? formatTime(t.duration) : ''}</div>
      </div>`;
  }).join('');

  list.querySelectorAll('.perform-row').forEach(row => {
    row.addEventListener('click', () => selectPerform(row.dataset.id));
  });
}

function selectPerform(id) {
  if (performing) return;
  selectedPerformId = id;
  renderPerformList();
  const t = deps.getTracks().find(x => x.id === id);
  const nameEl = document.getElementById('perform-current-name');
  if (nameEl) nameEl.textContent = t ? t.name : '—';
  const bar = document.getElementById('perform-transport');
  if (bar) bar.classList.toggle('hidden', !t);
  setPerformButton(false);
  setPerformStatus('');
}

// ─── transport ───────────────────────────────────────────────

function wireOffsetSlider() {
  const slider = document.getElementById('perform-offset');
  const label = document.getElementById('perform-offset-val');
  if (!slider) return;
  slider.value = String(offsetMs);
  if (label) label.textContent = fmtOffset(offsetMs);
  slider.addEventListener('input', () => {
    offsetMs = parseInt(slider.value, 10) || 0;
    localStorage.setItem(OFFSET_KEY, String(offsetMs));
    if (label) label.textContent = fmtOffset(offsetMs);
    Metronome.setClickOffset(offsetMs / 1000);
  });
}

function wirePerformTransport() {
  const btn = document.getElementById('perform-play-btn');
  if (btn) btn.addEventListener('click', () => (performing ? stopPerform() : startPerform()));
}

function fmtOffset(ms) { return `${ms > 0 ? '+' : ''}${ms} ms`; }

function setPerformButton(isPerforming) {
  const btn = document.getElementById('perform-play-btn');
  if (!btn) return;
  btn.textContent = isPerforming ? '■  Stop' : '▶  Count in';
  btn.classList.toggle('performing', isPerforming);
}

function setPerformStatus(text) {
  const el = document.getElementById('perform-status');
  if (el) el.textContent = text;
}

async function startPerform() {
  if (starting || performing) return; // guards against a second click landing
  const id = selectedPerformId;       // before `performing` flips true below —
  const track = deps.getTracks().find(t => t.id === id); // a double-invoke was
  if (!track) return;                 // scheduling two overlapping click streams.
  starting = true;

  // Resume the AudioContext synchronously, as the first thing this handler
  // does — after an `await` yields to the event loop, some engines no longer
  // treat a resume() call as user-activated and silently refuse it, which
  // looks exactly like "nothing happens" (no click, no song).
  const ctx = resume();
  // Perform owns the click bus exclusively — kill the regular metronome (it
  // writes to the same output) so the two can't ever overlap.
  Metronome.stop();

  let descriptor;
  try {
    descriptor = await invoke('clicktrack_get', { trackId: id });
  } catch (e) {
    starting = false;
    deps.notify('Could not read click track data — try regenerating it', 'error');
    return;
  }
  const sched = buildClickSchedule(descriptor, { countOffBars: 2 });
  if (!sched.clicks.length) {
    starting = false;
    deps.notify('Click track has no beats', 'error');
    return;
  }

  deps.onBeforePerform();

  performPlayer = players[id] || (players[id] = new TrackPlayer(id));
  performPlayer.semitones = track.semitones || 0;
  performPlayer.cents = track.cents ?? 0;
  performPlayer.speed = 1.0;
  performPlayer.volume = track.volume !== undefined ? track.volume : 1.0;
  performPlayer._masterVolume = deps.getMasterVolume();
  performPlayer.loopEnabled = false;

  try {
    const cm = track.peaks
      ? { peaks: track.peaks, nativeDuration: track.nativeDuration, sampleRate: track.sampleRate }
      : null;
    await performPlayer.loadFile(track.filePath, cm);
  } catch (e) {
    starting = false;
    deps.notify('Could not decode audio for Perform', 'error');
    return;
  }

  try {
    performing = true;
    starting = false;
    performTrackId = id;
    setPerformButton(true);
    setPerformStatus('Counting in…');
    renderPerformList();

    const anchorCtx = ctx.currentTime + 0.2;
    Metronome.startClickSchedule(sched.clicks, {
      anchorCtxTime: anchorCtx,
      anchorSongTime: sched.firstClickSongTime,
      offsetSec: offsetMs / 1000,
    });

    // ctx time at which song audio position 0 should begin playing.
    const audioStartCtx = anchorCtx - sched.firstClickSongTime;
    const effVol = performPlayer.volume * deps.getMasterVolume();

    const watch = () => {
      if (!performing) return;
      if (ctx.currentTime >= audioStartCtx) {
        performPlayer.play(0, effVol)
          .then(() => setPerformStatus('Playing'))
          .catch(e => {
            console.error('[stagehand] Perform song playback failed:', e);
            deps.notify('Could not start song playback: ' + (e?.message || e), 'error');
          });
        startWatchRaf = null;
        return;
      }
      startWatchRaf = requestAnimationFrame(watch);
    };
    watch();
  } catch (e) {
    console.error('[stagehand] Perform start failed:', e);
    deps.notify('Could not start Perform playback: ' + (e?.message || e), 'error');
    performing = false;
    starting = false;
    setPerformButton(false);
    setPerformStatus('');
  }
}

function stopPerform() {
  performing = false;
  starting = false;
  if (startWatchRaf) { cancelAnimationFrame(startWatchRaf); startWatchRaf = null; }
  Metronome.stopClickSchedule();
  if (performPlayer) { performPlayer.stop(true).catch(() => {}); }
  performPlayer = null;
  performTrackId = null;
  setPerformButton(false);
  setPerformStatus('');
  renderPerformList();
}

export function isPerforming() { return performing; }

// ─── helpers ─────────────────────────────────────────────────

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function escAttr(s) { return escHtml(s); }
