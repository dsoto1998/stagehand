---
phase: quick
plan: 260410-udn
type: execute
wave: 1
depends_on: []
files_modified:
  - renderer/js/ui-controller.js
  - renderer/index.html
  - renderer/style.css
autonomous: true
requirements: [keyboard-shortcuts, keyboard-shortcuts-reference]
must_haves:
  truths:
    - "ArrowLeft/ArrowRight seek playing track by 5s, Shift variants by 15s"
    - "L toggles loop on/off"
    - "[ and ] navigate to previous/next track"
    - "T taps tempo, M toggles metronome"
    - "Ctrl+F focuses the search bar from anywhere"
    - "Settings popup shows complete keyboard shortcuts reference"
    - "All shortcuts are ignored when focus is in an input/textarea"
  artifacts:
    - path: "renderer/js/ui-controller.js"
      provides: "7 new keyboard shortcut handlers in keydown listener"
      contains: "ArrowLeft"
    - path: "renderer/index.html"
      provides: "Keyboard Shortcuts section in settings popup"
      contains: "Keyboard Shortcuts"
    - path: "renderer/style.css"
      provides: "Shortcut row and kbd badge styles"
      contains: "sp-shortcut-row"
  key_links:
    - from: "renderer/js/ui-controller.js"
      to: "renderer/js/track-player.js"
      via: "player.seek() for arrow key seeking"
      pattern: "player\\.seek\\("
    - from: "renderer/js/ui-controller.js"
      to: "renderer/index.html"
      via: "clicking existing DOM buttons for loop/prev/next/tap/metronome"
      pattern: "getElementById.*click"
---

<objective>
Add 7 new keyboard shortcuts to ui-controller.js and add a "Keyboard Shortcuts" reference section to the settings popup listing all shortcuts (existing + new).

Purpose: Musicians need fast keyboard-driven control during rehearsal without reaching for the mouse.
Output: Working shortcuts + visible reference in settings menu.
</objective>

<execution_context>
@.claude/get-shit-done/workflows/execute-plan.md
@.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@renderer/js/ui-controller.js
@renderer/index.html
@renderer/style.css
@renderer/js/track-player.js

<interfaces>
<!-- Existing keydown listener at line ~812 in ui-controller.js -->
<!-- All new shortcuts go inside this existing listener -->

From renderer/js/track-player.js:
```javascript
seek(fraction)          // fraction 0-1, restarts playback at that position
get currentTime()       // returns seconds elapsed
this.duration           // total duration in seconds
```

From ui-controller.js globals:
```javascript
currentPlayingId        // string ID of currently playing track, or null
players                 // Map of trackId -> TrackPlayer instance
```

Existing DOM button IDs to .click():
- mp-loop-btn   (toggle loop)
- mp-prev       (previous track)
- mp-next       (next track)
- mm-tap-btn    (tap tempo)
- mm-play-btn   (start/stop metronome)
- lib-search    (search input to .focus())
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add 7 keyboard shortcuts to ui-controller.js</name>
  <files>renderer/js/ui-controller.js</files>
  <action>
Inside the existing `document.addEventListener('keydown', ...)` block at line ~812, add new shortcut handlers. Insert them AFTER the media key switch block (line ~843) and BEFORE the loop in/out I/O handlers (line ~844). The new block should be:

1. **Ctrl+F — focus search** (no tag check needed, always works):
   ```
   if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
     e.preventDefault();
     document.getElementById('lib-search').focus();
     return;
   }
   ```
   Place this FIRST, before any tag checks, since Ctrl+F should work even from inputs.

2. After the Ctrl+F block, add a shared tag check guard (reuse the same pattern as the existing I/O handlers at line ~847):
   ```
   const tag = e.target.tagName;
   if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
   ```
   BUT — this guard must be placed carefully. The existing code already has a `tag` variable scoped inside the `if (currentPlayingId)` block at line 847 and another at line 870. To avoid duplicate declarations, insert a NEW block before line 844 that handles all the non-playing-dependent shortcuts first, then falls through to the existing code.

   The cleanest approach: Insert a new block right after the media key switch (after line 843), structured as:

   ```javascript
   // ── Keyboard shortcuts ──
   // Ctrl+F: focus search (works from anywhere, even inputs)
   if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
     e.preventDefault();
     document.getElementById('lib-search').focus();
     return;
   }

   // Guard: skip shortcuts when typing in inputs
   const kbTag = e.target.tagName;
   const inInput = kbTag === 'INPUT' || kbTag === 'TEXTAREA' || e.target.isContentEditable;
   if (!inInput) {
     // Shortcuts that do NOT require a playing track:
     if (e.key === '[') {
       e.preventDefault();
       document.getElementById('mp-prev').click();
       return;
     }
     if (e.key === ']') {
       e.preventDefault();
       document.getElementById('mp-next').click();
       return;
     }
     if (e.key === 't' || e.key === 'T') {
       e.preventDefault();
       document.getElementById('mm-tap-btn').click();
       return;
     }
     if (e.key === 'm' || e.key === 'M') {
       e.preventDefault();
       document.getElementById('mm-play-btn').click();
       return;
     }

     // Shortcuts that REQUIRE a playing track:
     if (currentPlayingId) {
       const player = players[currentPlayingId];
       if (player) {
         if (e.key === 'l' || e.key === 'L') {
           e.preventDefault();
           document.getElementById('mp-loop-btn').click();
           return;
         }
         if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
           e.preventDefault();
           const delta = e.shiftKey ? 15 : 5;
           const dir = e.key === 'ArrowLeft' ? -1 : 1;
           const newTime = player.currentTime + (dir * delta);
           const fraction = Math.max(0, Math.min(1, newTime / player.duration));
           player.seek(fraction);
           return;
         }
       }
     }
   }
   ```

   Use variable name `kbTag` (not `tag`) to avoid conflict with the existing `tag` variable declared later at line 847 and 870 inside the same listener.

3. The existing I/O loop point handlers (lines 844-867) and Space handler (lines 869-874) remain UNCHANGED after this new block.
  </action>
  <verify>
    <automated>node -e "const fs=require('fs'); const c=fs.readFileSync('renderer/js/ui-controller.js','utf8'); const checks=['ArrowLeft','ArrowRight','mm-tap-btn','mm-play-btn','mp-loop-btn','lib-search','kbTag']; const missing=checks.filter(k=>!c.includes(k)); if(missing.length){console.error('MISSING:',missing);process.exit(1)} console.log('All 7 shortcuts found')"</automated>
  </verify>
  <done>All 7 new shortcuts work: arrow keys seek 5s/15s, L toggles loop, [/] nav tracks, T taps tempo, M toggles metronome, Ctrl+F focuses search. None fire when typing in inputs.</done>
</task>

<task type="auto">
  <name>Task 2: Add Keyboard Shortcuts section to settings popup HTML + CSS</name>
  <files>renderer/index.html, renderer/style.css</files>
  <action>
**index.html changes:**

Insert before the closing `</div>` of `#settings-popup` (line 69), after the Library section's sp-row (line 68):

```html
      <div class="sp-divider"></div>
      <div class="sp-section-label">Keyboard Shortcuts</div>
      <div class="sp-shortcuts-list">
        <div class="sp-shortcut-group">Playback</div>
        <div class="sp-shortcut-row"><span>Play / Pause</span><span class="sp-keys"><kbd>Space</kbd></span></div>
        <div class="sp-shortcut-row"><span>Previous track</span><span class="sp-keys"><kbd>[</kbd></span></div>
        <div class="sp-shortcut-row"><span>Next track</span><span class="sp-keys"><kbd>]</kbd></span></div>
        <div class="sp-shortcut-row"><span>Seek back 5s</span><span class="sp-keys"><kbd>&larr;</kbd></span></div>
        <div class="sp-shortcut-row"><span>Seek forward 5s</span><span class="sp-keys"><kbd>&rarr;</kbd></span></div>
        <div class="sp-shortcut-row"><span>Seek back 15s</span><span class="sp-keys"><kbd>Shift</kbd> <kbd>&larr;</kbd></span></div>
        <div class="sp-shortcut-row"><span>Seek forward 15s</span><span class="sp-keys"><kbd>Shift</kbd> <kbd>&rarr;</kbd></span></div>
        <div class="sp-shortcut-group">Loop</div>
        <div class="sp-shortcut-row"><span>Set loop in point</span><span class="sp-keys"><kbd>I</kbd></span></div>
        <div class="sp-shortcut-row"><span>Set loop out point</span><span class="sp-keys"><kbd>O</kbd></span></div>
        <div class="sp-shortcut-row"><span>Toggle loop</span><span class="sp-keys"><kbd>L</kbd></span></div>
        <div class="sp-shortcut-group">Metronome</div>
        <div class="sp-shortcut-row"><span>Start / Stop</span><span class="sp-keys"><kbd>M</kbd></span></div>
        <div class="sp-shortcut-row"><span>Tap tempo</span><span class="sp-keys"><kbd>T</kbd></span></div>
        <div class="sp-shortcut-group">Library</div>
        <div class="sp-shortcut-row"><span>Focus search</span><span class="sp-keys"><kbd>Ctrl</kbd> <kbd>F</kbd></span></div>
        <div class="sp-shortcut-row"><span>Select all tracks</span><span class="sp-keys"><kbd>Ctrl</kbd> <kbd>A</kbd></span></div>
        <div class="sp-shortcut-row"><span>Delete selected</span><span class="sp-keys"><kbd>Del</kbd></span></div>
        <div class="sp-shortcut-row"><span>Clear search / Close</span><span class="sp-keys"><kbd>Esc</kbd></span></div>
      </div>
```

**style.css changes:**

1. Widen `#settings-popup` from `width: 240px` to `width: 280px` (line 101).

2. Add `max-height: calc(100vh - 80px)` and `overflow-y: auto` to `#settings-popup` (after existing padding line).

3. Add these new rules in the "SETTINGS POPUP EXTRAS" section (after `.sp-col` at ~line 2024):

```css
  .sp-shortcuts-list {
    padding: 0 16px;
  }
  .sp-shortcut-group {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-dim);
    padding: 8px 0 4px;
  }
  .sp-shortcut-group:first-child {
    padding-top: 2px;
  }
  .sp-shortcut-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 3px 0;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .sp-keys {
    display: flex;
    align-items: center;
    gap: 3px;
    flex-shrink: 0;
  }
  .sp-shortcut-row kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    height: 20px;
    padding: 0 5px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 500;
    color: var(--text-primary);
    background: var(--bg-base);
    border: 1px solid var(--border-bright);
    border-radius: 4px;
    line-height: 1;
  }
```

4. Add custom scrollbar styling for the settings popup to match the dark theme (thin, subtle):

```css
  #settings-popup::-webkit-scrollbar { width: 4px; }
  #settings-popup::-webkit-scrollbar-track { background: transparent; }
  #settings-popup::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
```
  </action>
  <verify>
    <automated>node -e "const fs=require('fs'); const h=fs.readFileSync('renderer/index.html','utf8'); const c=fs.readFileSync('renderer/style.css','utf8'); const hChecks=['sp-shortcut-row','sp-shortcut-group','Keyboard Shortcuts','kbd']; const cChecks=['sp-shortcut-row','sp-shortcut-group','sp-keys','280px']; const hMissing=hChecks.filter(k=>!h.includes(k)); const cMissing=cChecks.filter(k=>!c.includes(k)); if(hMissing.length||cMissing.length){console.error('HTML missing:',hMissing,'CSS missing:',cMissing);process.exit(1)} console.log('Settings popup shortcuts section OK')"</automated>
  </verify>
  <done>Settings popup contains a "Keyboard Shortcuts" section listing all 17 shortcuts in 4 logical groups (Playback, Loop, Metronome, Library), with styled kbd badges. Popup is 280px wide with scrollable overflow.</done>
</task>

</tasks>

<verification>
1. Open http://localhost:8080/renderer/index.html
2. Import a track, start playback
3. Press ArrowLeft/ArrowRight — playhead jumps 5s
4. Press Shift+ArrowLeft/Shift+ArrowRight — playhead jumps 15s
5. Press L — loop toggles on/off (loop button highlights)
6. Press [ — goes to previous track, ] — next track
7. Press T — taps tempo in metronome
8. Press M — starts/stops metronome
9. Press Ctrl+F — search bar focuses
10. Click in BPM input, press L/T/M — nothing happens (input guard works)
11. Click hamburger menu — "Keyboard Shortcuts" section visible with all shortcuts listed
12. Scroll settings popup if it overflows viewport
</verification>

<success_criteria>
- All 7 new shortcuts respond correctly during playback
- Arrow key seek respects Shift modifier (5s vs 15s)
- No shortcut fires when typing in input fields (except Ctrl+F which always works)
- Settings popup shows all 17 shortcuts in 4 groups with styled kbd badges
- Settings popup scrolls when content exceeds viewport height
</success_criteria>

<output>
After completion, create `.planning/quick/260410-udn-add-7-keyboard-shortcuts-and-keyboard-sh/260410-udn-SUMMARY.md`
</output>
