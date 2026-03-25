---
phase: quick
plan: 260324-vas
type: execute
wave: 1
depends_on: []
files_modified: [rehearsal-tool-v1.html]
autonomous: false
requirements: [MINI-01]

must_haves:
  truths:
    - "Miniplayer appears fixed at bottom-left when any track is playing"
    - "Miniplayer disappears when playback stops or track ends"
    - "Previous/Next buttons navigate through library track order and auto-play"
    - "Play/Pause button toggles playback of current track"
    - "Transpose slider shows current track's semitone value and syncs with library card slider"
    - "Transpose slider resets visually to new track's stored value on track change"
    - "Master volume fader controls the existing master GainNode"
    - "Track name displayed in miniplayer matches currently playing track"
  artifacts:
    - path: "rehearsal-tool-v1.html"
      provides: "Miniplayer UI, CSS, and JS logic"
      contains: "id=\"miniplayer\""
  key_links:
    - from: "miniplayer transpose slider"
      to: "track-card .track-semitones slider"
      via: "shared player.setSemitones() + mutual input event sync"
      pattern: "player\\.setSemitones"
    - from: "miniplayer master volume"
      to: "AudioEngine.setMasterVolume"
      via: "input event on range slider"
      pattern: "AudioEngine\\.setMasterVolume"
    - from: "miniplayer prev/next"
      to: "tracks[] array index"
      via: "findIndex of currentPlayingId then +/-1 with wrap"
      pattern: "tracks\\[.*\\]"
---

<objective>
Add a fixed-position miniplayer to the bottom-left corner of the app that appears whenever a track is playing from the Library. The miniplayer provides transport controls (Previous, Play/Pause, Next), a per-track transpose slider synced with the library card's slider, a master volume fader, and displays the current track name.

Purpose: Give musicians quick access to essential playback controls without scrolling through the library panel or switching panels away from Metronome.
Output: Updated rehearsal-tool-v1.html with working miniplayer.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@rehearsal-tool-v1.html
</context>

<interfaces>
<!-- Key state and APIs the executor needs -->

Global state:
```javascript
let tracks = []; // Array of {id, name, size, format, semitones, volume, arrayBuffer, addedAt}
const players = {}; // Map: trackId -> TrackPlayer instance
```

TrackPlayer API (per instance):
```javascript
player.isPlaying    // boolean
player.semitones    // number (-12 to +12)
player.volume       // number (0.0 to 1.0)
player.trackId      // string
player.play(offset) // async, starts playback
player.pause()      // pauses, preserves offset
player.stop()       // stops, resets offset
player.setSemitones(s) // sets pitch, restarts if playing
player.setVolume(v) // sets gain
player.onEnd        // callback when track finishes
player.onProgress   // callback(frac, time) during playback
```

AudioEngine API:
```javascript
AudioEngine.resume()           // returns AudioContext, resumes if suspended
AudioEngine.setMasterVolume(v) // 0.0 to 1.0
AudioEngine.getMaster()        // returns master GainNode
```

Existing play button handler pattern (lines 1617-1672):
- Calls AudioEngine.resume()
- Pauses other players, removes .playing from their cards
- Calls player.play(), adds .playing to card, sets button to pause icon
- player.onEnd removes .playing from card, resets button to play icon
```
</interfaces>

<tasks>

<task type="auto">
  <name>Task 1: Add miniplayer CSS, HTML, and JS logic</name>
  <files>rehearsal-tool-v1.html</files>
  <action>
**CSS (add before the closing `</style>` tag, around line 722):**

Add styles for `#miniplayer` — a fixed-position container at bottom-left:
- `position: fixed; bottom: 16px; left: 16px; z-index: 50;`
- `background: var(--bg-panel); border: 1px solid var(--border-bright); border-radius: 6px;`
- `padding: 12px 16px; width: 320px;`
- `display: none;` by default (shown via `.miniplayer-visible` class setting `display: block`)
- `box-shadow: 0 4px 20px rgba(0,0,0,0.5);`
- Subtle entry animation: `transition: opacity 0.2s, transform 0.2s;` with `.miniplayer-visible { opacity: 1; transform: translateY(0); }` and default `opacity: 0; transform: translateY(8px);`
- Actually use two classes: base `#miniplayer` has `display:none`, `#miniplayer.visible` sets `display:block; opacity:1; transform:translateY(0);` (use a brief setTimeout to trigger opacity after display changes, or just use `display:block` with no opacity animation for simplicity)

Internal layout:
- `.mp-track-name` — track name display: `font-family: 'Rajdhani'; font-size: 15px; font-weight: 600; letter-spacing: 1px; color: var(--accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 8px;`
- `.mp-transport` — flexbox row with prev/play/next buttons centered: `display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 10px;`
- `.mp-btn` — circular transport buttons: `width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--border-bright); background: var(--bg-base); color: var(--text-primary); cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 14px; transition: all 0.15s;`
- `.mp-btn:hover` — `border-color: var(--accent); color: var(--accent);`
- `.mp-btn-play` (the play/pause button, slightly larger): `width: 36px; height: 36px; font-size: 16px;`
- `.mp-controls` — two control rows for transpose and master vol
- `.mp-ctrl-row` — `display: flex; align-items: center; gap: 8px; margin-bottom: 6px;`
- `.mp-ctrl-label` — `font-family: 'JetBrains Mono', monospace; font-size: 9px; color: var(--text-dim); letter-spacing: 2px; text-transform: uppercase; min-width: 56px;`
- `.mp-ctrl-val` — `font-family: 'JetBrains Mono', monospace; font-size: 11px; min-width: 36px; text-align: right;`
- Transpose val uses `color: var(--cyan)`, master vol val uses `color: var(--text-secondary)`
- Range inputs inside miniplayer get `flex: 1;`

**HTML (add after the `#notif` div, around line 885):**

```html
<div id="miniplayer">
  <div class="mp-track-name" id="mp-track-name">—</div>
  <div class="mp-transport">
    <button class="mp-btn" id="mp-prev" title="Previous Track">⏮</button>
    <button class="mp-btn mp-btn-play" id="mp-play" title="Play/Pause">▶</button>
    <button class="mp-btn" id="mp-next" title="Next Track">⏭</button>
  </div>
  <div class="mp-controls">
    <div class="mp-ctrl-row">
      <span class="mp-ctrl-label">Transpose</span>
      <input type="range" id="mp-transpose" min="-12" max="12" value="0">
      <span class="mp-ctrl-val" id="mp-transpose-val" style="color:var(--cyan)">0st</span>
    </div>
    <div class="mp-ctrl-row">
      <span class="mp-ctrl-label">Master</span>
      <input type="range" id="mp-master-vol" min="0" max="100" value="100">
      <span class="mp-ctrl-val" id="mp-master-vol-val" style="color:var(--text-secondary)">100%</span>
    </div>
  </div>
</div>
```

**JavaScript (add a new section `// --- MINIPLAYER ---` before the `// --- INIT ---` section, around line 2093):**

Add a global variable `currentPlayingId = null;` near the top of the script (after `const players = {};` on line 1391).

Create a `Miniplayer` module (IIFE like the other modules):

```javascript
const Miniplayer = (() => {
  const el = () => document.getElementById('miniplayer');
  const nameEl = () => document.getElementById('mp-track-name');
  const playBtn = () => document.getElementById('mp-play');
  const transposeSlider = () => document.getElementById('mp-transpose');
  const transposeVal = () => document.getElementById('mp-transpose-val');
  const masterSlider = () => document.getElementById('mp-master-vol');
  const masterVal = () => document.getElementById('mp-master-vol-val');

  function show(trackId) {
    currentPlayingId = trackId;
    const track = tracks.find(t => t.id === trackId);
    if (!track) return;
    nameEl().textContent = track.name;
    playBtn().textContent = '⏸';
    // Sync transpose slider to this track's current semitones
    const player = players[trackId];
    const st = player ? player.semitones : (track.semitones || 0);
    transposeSlider().value = st;
    transposeVal().textContent = (st > 0 ? '+' : '') + st + 'st';
    transposeVal().style.color = st === 0 ? 'var(--text-dim)' : 'var(--cyan)';
    // Sync master volume slider to current master vol value
    const masterVolInput = document.getElementById('master-vol');
    masterSlider().value = masterVolInput.value;
    masterVal().textContent = masterVolInput.value + '%';
    el().classList.add('visible');
  }

  function hide() {
    currentPlayingId = null;
    el().classList.remove('visible');
  }

  function updatePlayState(isPlaying) {
    playBtn().textContent = isPlaying ? '⏸' : '▶';
  }

  function syncTranspose(semitones) {
    transposeSlider().value = semitones;
    transposeVal().textContent = (semitones > 0 ? '+' : '') + semitones + 'st';
    transposeVal().style.color = semitones === 0 ? 'var(--text-dim)' : 'var(--cyan)';
  }

  return { show, hide, updatePlayState, syncTranspose };
})();
```

**Integration points — modify existing play button handler (lines 1617-1672):**

After the line `card.classList.add('playing');` and `playBtn.textContent = '⏸';` (successful play, around line 1666), add:
```javascript
Miniplayer.show(track.id);
```

In the pause branch (around line 1622), after `playBtn.textContent = '▶';`, add:
```javascript
Miniplayer.updatePlayState(false);
```

In the `player.onEnd` callback (around line 1609-1614), add after `curTimeEl.textContent = '0:00';`:
```javascript
Miniplayer.hide();
```

**Miniplayer event bindings (inside the Miniplayer section or right after its definition):**

Play/Pause button (`#mp-play`):
```javascript
document.getElementById('mp-play').addEventListener('click', () => {
  if (!currentPlayingId) return;
  const player = players[currentPlayingId];
  if (!player) return;
  AudioEngine.resume();
  if (player.isPlaying) {
    player.pause();
    const card = document.getElementById('card-' + currentPlayingId);
    if (card) {
      card.classList.remove('playing');
      card.querySelector('.track-play-btn').textContent = '▶';
    }
    Miniplayer.updatePlayState(false);
  } else {
    player.play().then(() => {
      const card = document.getElementById('card-' + currentPlayingId);
      if (card) {
        card.classList.add('playing');
        card.querySelector('.track-play-btn').textContent = '⏸';
      }
      Miniplayer.updatePlayState(true);
    });
  }
});
```

Previous/Next buttons (`#mp-prev`, `#mp-next`):
- Find the index of `currentPlayingId` in `tracks` array
- For prev: `(index - 1 + tracks.length) % tracks.length`; for next: `(index + 1) % tracks.length`
- Stop current player, remove .playing from its card
- Get the target track, ensure its player exists and buffer is loaded (load if needed)
- Stop all other players (same pattern as existing play handler)
- Call `player.play()`, update card UI, call `Miniplayer.show(targetTrack.id)` which resets transpose slider to the new track's stored value

Create a helper function `playTrackById(trackId)` that encapsulates the play logic (stop others, load buffer if needed, play, update card, show miniplayer). Both prev/next and potentially the existing play button can use this. Keep the existing play button handler mostly as-is but add the Miniplayer.show() call.

Transpose slider (`#mp-transpose`):
```javascript
document.getElementById('mp-transpose').addEventListener('input', function() {
  if (!currentPlayingId) return;
  const s = parseInt(this.value);
  const player = players[currentPlayingId];
  if (player) player.setSemitones(s);
  // Update miniplayer display
  const valEl = document.getElementById('mp-transpose-val');
  valEl.textContent = (s > 0 ? '+' : '') + s + 'st';
  valEl.style.color = s === 0 ? 'var(--text-dim)' : 'var(--cyan)';
  // Sync library card's transpose slider and display
  const card = document.getElementById('card-' + currentPlayingId);
  if (card) {
    const cardSlider = card.querySelector('.track-semitones');
    const cardVal = card.querySelector('.semitone-display');
    if (cardSlider) cardSlider.value = s;
    if (cardVal) {
      cardVal.textContent = (s > 0 ? '+' : '') + s + 'st';
      cardVal.style.color = s === 0 ? 'var(--text-dim)' : 'var(--cyan)';
    }
  }
  // Persist
  const track = tracks.find(t => t.id === currentPlayingId);
  if (track) { track.semitones = s; saveTrackMeta(track); }
});
```

Also modify the existing library card transpose slider handler (lines 1694-1701) to sync back to the miniplayer:
After `stValEl.textContent = ...` add:
```javascript
if (currentPlayingId === track.id) {
  Miniplayer.syncTranspose(s);
}
```

Master volume slider (`#mp-master-vol`):
```javascript
document.getElementById('mp-master-vol').addEventListener('input', function() {
  AudioEngine.setMasterVolume(this.value / 100);
  document.getElementById('mp-master-vol-val').textContent = this.value + '%';
  // Sync sidebar master volume slider and label
  document.getElementById('master-vol').value = this.value;
  document.getElementById('master-vol-val').textContent = this.value + '%';
});
```

Also modify the existing sidebar master volume handler (line 2006-2009) to sync to miniplayer:
```javascript
document.getElementById('mp-master-vol').value = this.value;
document.getElementById('mp-master-vol-val').textContent = this.value + '%';
```

**Important edge cases to handle:**
- If `tracks.length === 0`, prev/next should do nothing
- If `tracks.length === 1`, prev/next should restart the same track from the beginning
- When a track is deleted while it's the current playing track, call `Miniplayer.hide()`
- The delete handler (line 1732-1741) should check `if (currentPlayingId === track.id) Miniplayer.hide();`
  </action>
  <verify>
    <automated>Open rehearsal-tool-v1.html in Chrome. Import 2+ audio files. Click play on a track — miniplayer should appear at bottom-left. Click pause in miniplayer — track pauses, miniplayer stays visible with play icon. Click play — resumes. Click Next — switches to next track, transpose slider resets to that track's stored value. Click Previous — goes back. Change transpose in miniplayer — library card slider moves in sync. Change transpose in library card — miniplayer slider moves in sync. Change master volume in miniplayer — sidebar slider syncs. Let a track end naturally — miniplayer disappears. Delete the playing track — miniplayer disappears.</automated>
  </verify>
  <done>
    - Miniplayer fixed at bottom-left appears when any track starts playing
    - Miniplayer hides when playback stops naturally or track is deleted
    - Play/Pause toggles current track and syncs with library card UI
    - Prev/Next navigate tracks array with wraparound, auto-play, and transpose slider reset
    - Transpose slider bidirectionally syncs between miniplayer and library card
    - Master volume fader bidirectionally syncs between miniplayer and sidebar
    - All styling matches existing dark theme using CSS variables
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 2: Visual and functional verification</name>
  <what-built>Miniplayer fixed to bottom-left with transport controls, transpose slider, and master volume fader. Appears on play, disappears on stop/end.</what-built>
  <how-to-verify>
    1. Open rehearsal-tool-v1.html in Chrome
    2. Import at least 3 audio tracks
    3. Click play on any track — miniplayer should slide in at bottom-left showing track name
    4. Verify Play/Pause button in miniplayer toggles playback (library card stays in sync)
    5. Click Next — next track plays, transpose slider shows that track's stored value
    6. Click Previous — previous track plays
    7. Move transpose slider in miniplayer — library card slider moves, pitch changes
    8. Move transpose slider in library card — miniplayer slider moves
    9. Move master volume in miniplayer — sidebar slider syncs
    10. Move master volume in sidebar — miniplayer slider syncs
    11. Let a track finish naturally — miniplayer disappears
    12. Switch to Metronome panel — miniplayer should still be visible at bottom-left if a track is playing
    13. Verify miniplayer does not overlap or obscure other UI elements
  </how-to-verify>
  <resume-signal>Type "approved" or describe issues</resume-signal>
</task>

</tasks>

<verification>
- Miniplayer element exists in DOM with id="miniplayer"
- CSS uses existing design system variables (--bg-panel, --border-bright, --accent, --cyan, etc.)
- No console errors during play/pause/prev/next/transpose/volume operations
- Bidirectional sync works for both transpose and master volume sliders
- Miniplayer visibility correctly tracks playback state
</verification>

<success_criteria>
- Miniplayer appears at bottom-left when a track plays, disappears when playback ends
- Transport controls (prev/play-pause/next) work correctly with track order wraparound
- Transpose slider syncs bidirectionally with library card slider and resets on track change
- Master volume fader syncs bidirectionally with sidebar master volume
- Styling matches existing dark theme
- No regressions to existing library or metronome functionality
</success_criteria>

<output>
After completion, create `.planning/quick/260324-vas-add-miniplayer-bottom-left/260324-vas-SUMMARY.md`
</output>
