---
phase: quick
plan: 260403-klh
type: execute
wave: 1
depends_on: []
files_modified:
  - renderer/index.html
  - renderer/style.css
  - renderer/js/ui-controller.js
  - renderer/js/metronome.js
autonomous: true
requirements: [metronome-beat-dots, metronome-tap-placement, metronome-bpm-click, metronome-combined-row, player-speed-warning, player-loop-btn-placement]
must_haves:
  truths:
    - "Beat position dots appear below BPM section and light up on each beat"
    - "TAP button spans full width below the -/BPM/+ row"
    - "Single click on BPM display enters inline edit mode"
    - "Subdivision and time signature appear on a single row"
    - "Speed warning text appears near speed value when speed != 1x"
    - "Loop button sits below time display, separate from transport row"
  artifacts:
    - path: "renderer/index.html"
      provides: "Updated metronome and player markup"
    - path: "renderer/style.css"
      provides: "Styles for beat dots, combined row, loop button placement"
    - path: "renderer/js/ui-controller.js"
      provides: "Beat dot updates, BPM single-click, speed warning toggle"
    - path: "renderer/js/metronome.js"
      provides: "Beat index passed to onBeat callback"
  key_links:
    - from: "renderer/js/metronome.js"
      to: "renderer/js/ui-controller.js"
      via: "onBeat callback now passes beatIndex"
      pattern: "beatCallback\\(beatIdx\\)"
    - from: "renderer/js/ui-controller.js"
      to: "renderer/index.html"
      via: "DOM updates for beat dots and speed warning"
      pattern: "mm-beat-dot|mp-speed-warn"
---

<objective>
Six UI improvements to the metronome and player sections of the sidebar.

Metronome: (1) beat position dot row, (2) TAP button full-width below BPM row, (3) BPM single-click edit, (4) combined subdivision + time signature row.
Player: (5) speed-reset warning text, (6) loop button moved below time display.

Purpose: Improve usability of the two most-used sidebar panels.
Output: Updated HTML, CSS, JS across 4 files.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@renderer/index.html
@renderer/style.css
@renderer/js/ui-controller.js
@renderer/js/metronome.js

<interfaces>
From renderer/js/metronome.js:
```js
// onBeat callback currently receives no arguments — we will change it to pass beatIdx (0-based beat in measure)
export const Metronome = { start, stop, setBpm, getBpm, setVolume, setSubdivision, setTimeSignature, setBeatAccent, getTimeSignature, getBeatAccents, setCustomBuffer, getCustomBuffer, setAccent, getAccent, isActive, onBeat };
```

From renderer/js/ui-controller.js (relevant sections):
```js
// Line 3127-3130: onBeat flash handler
Metronome.onBeat(() => {
  const btn = document.getElementById('mm-bpm-display');
  btn.classList.add('beat-flash');
  setTimeout(() => btn.classList.remove('beat-flash'), 80);
});

// Line 3173-3176: BPM dblclick handler (to be changed to click)
document.getElementById('mm-bpm-display').addEventListener('dblclick', () => { ... });

// Line 771-782: speed slider input handler (speed warning added here)
document.getElementById('mp-speed').addEventListener('input', function() { ... });
```

From renderer/index.html (metronome body, lines 92-137):
- .mm-play-row > #mm-play-btn
- .mm-bpm-section > #mm-bpm-minus, .mm-bpm-display-wrap, #mm-bpm-plus, #mm-tap-btn
- .mm-vol-group
- .mm-subdiv-row > #mm-subdiv-select
- .mm-timesig-row > #mm-timesig-select
- .mm-accent-row > #mm-accent-btn

From renderer/index.html (player transport, lines 168-173):
- #mp-transport > #mp-prev, #mp-play, #mp-next, #mp-loop-btn
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Metronome UI changes (HTML + CSS + JS)</name>
  <files>renderer/index.html, renderer/style.css, renderer/js/metronome.js, renderer/js/ui-controller.js</files>
  <action>
**1. Beat position dot row (HTML + CSS + JS):**

In `renderer/index.html`, add a new div after `.mm-play-row` and before `.mm-bpm-section`:
```html
<div class="mm-beat-dots" id="mm-beat-dots"></div>
```
The dots are rendered dynamically by JS, not statically in HTML.

In `renderer/js/metronome.js`, modify the `beatCallback` invocation at line ~99 to pass the beat index:
```js
if (item.beat % item.subdivSteps === 0 && beatCallback) {
  const beatIdx = Math.floor(item.beat / item.subdivSteps);
  beatCallback(beatIdx);
}
```

In `renderer/js/ui-controller.js`:

Add a helper function `renderBeatDots(count)` that sets innerHTML of `#mm-beat-dots` to `count` span elements with class `mm-beat-dot`. Each span content is empty (CSS will style them as circles). Call `renderBeatDots()` on:
- Page load (after reading time sig from localStorage, default 4)
- `#mm-timesig-select` change event (parse numerator from value like "4/4" -> 4)

Update the `Metronome.onBeat(...)` callback (line ~3127) to accept the `beatIdx` argument and:
- Keep existing beat-flash behavior on `#mm-bpm-display`
- Also update dots: remove `active` class from all `.mm-beat-dot`, then add `active` to the dot at index `beatIdx`
- When metronome stops, clear all dot active states. Add to the existing stop logic (wherever `mm-play-btn` running class is toggled off): remove `active` from all `.mm-beat-dot`.

In `renderer/style.css`, add styles for `.mm-beat-dots`:
```css
.mm-beat-dots {
  display: flex;
  justify-content: center;
  gap: 8px;
  padding: 6px 0 2px;
}
.mm-beat-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bg-active);
  border: 1px solid var(--border);
  transition: background 0.05s, border-color 0.05s;
}
.mm-beat-dot.active {
  background: var(--accent);
  border-color: var(--accent);
}
```

**2. TAP button placement:**

In `renderer/index.html`, move `<button id="mm-tap-btn" ...>TAP</button>` OUT of `.mm-bpm-section`. Place it as a new sibling div right after `.mm-bpm-section`:
```html
</div><!-- end .mm-bpm-section -->
<div class="mm-tap-row">
  <button id="mm-tap-btn" class="mm-tap-btn" title="Tap tempo">TAP</button>
</div>
```

In `renderer/style.css`:
- Remove the grid-area rule for `#mm-tap-btn` (line ~2125: `#mm-tap-btn { grid-area: 2 / 2; margin-top: 6px; }`)
- Update `.mm-bpm-section` grid to single row: `grid-template-rows: auto;` (remove the implicit second row)
- Add `.mm-tap-row { display: flex; }` and `.mm-tap-row .mm-tap-btn { flex: 1; }` so TAP spans full width

**3. BPM single-click edit:**

In `renderer/js/ui-controller.js`, change `'dblclick'` to `'click'` on line ~3174:
```js
document.getElementById('mm-bpm-display').addEventListener('click', () => {
```
Also update the title attribute in HTML from "Double-click to type BPM" to "Click to type BPM".

**4. Combined subdivision + time signature row:**

In `renderer/index.html`, replace the two separate divs `.mm-subdiv-row` and `.mm-timesig-row` with a single row:
```html
<div class="mm-selects-row">
  <select id="mm-timesig-select" title="Time signature">
    <!-- keep all existing options -->
  </select>
  <select id="mm-subdiv-select" title="Subdivision">
    <!-- keep all existing options -->
  </select>
</div>
```
Time sig on left, subdivision on right.

In `renderer/style.css`:
- Remove `.mm-subdiv-row` and `.mm-timesig-row` rules
- Add:
```css
.mm-selects-row {
  display: flex;
  gap: 6px;
}
.mm-selects-row select {
  flex: 1;
  background: var(--bg-active);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-dim);
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  font-weight: 400;
  padding: 5px 6px;
  cursor: pointer;
  appearance: auto;
}
.mm-selects-row select:hover { border-color: var(--accent); color: var(--text-primary); }
.mm-selects-row select:focus { border-color: var(--accent); }
```
- Remove the individual `#mm-subdiv-select` and `#mm-timesig-select` style blocks (lines ~2201-2235) since the shared `.mm-selects-row select` rules replace them. Keep the focus-visible rule at line ~270.
  </action>
  <verify>
    <automated>node -e "const fs=require('fs'); const h=fs.readFileSync('renderer/index.html','utf8'); const checks=['mm-beat-dots','mm-tap-row','mm-selects-row','Click to type BPM']; const missing=checks.filter(c=>!h.includes(c)); if(missing.length){console.error('Missing:',missing);process.exit(1)} console.log('All HTML markers present')"</automated>
  </verify>
  <done>
    - Beat dot container exists in HTML, dots rendered dynamically by JS
    - metronome.js onBeat callback passes beatIdx
    - ui-controller.js updates dot active states on each beat and clears on stop
    - TAP button is full-width below BPM +/- row, not inside the grid
    - BPM display responds to single click for inline edit
    - Subdivision and time signature selects share one row (time sig left, subdiv right)
  </done>
</task>

<task type="auto">
  <name>Task 2: Player UI changes (HTML + CSS + JS)</name>
  <files>renderer/index.html, renderer/style.css, renderer/js/ui-controller.js</files>
  <action>
**5. Speed-reset warning text:**

In `renderer/index.html`, add a span inside `.mp-speed-group` after the `.mp-row` div:
```html
<span id="mp-speed-warn" class="mp-speed-warn hidden">(resets on seek)</span>
```

In `renderer/style.css`:
```css
.mp-speed-warn {
  display: block;
  text-align: center;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  font-weight: 300;
  color: var(--purple);
  margin-top: 2px;
  letter-spacing: 0.02em;
}
```

In `renderer/js/ui-controller.js`:
- In the `#mp-speed` input handler (line ~771), after toggling `speed-active` class, also toggle visibility of the warning:
  ```js
  document.getElementById('mp-speed-warn').classList.toggle('hidden', !isActive);
  ```
- In `resetSpeedSlider()` (around line ~488), add:
  ```js
  document.getElementById('mp-speed-warn').classList.add('hidden');
  ```

**6. Loop button out of transport:**

In `renderer/index.html`:
- Remove the `<button id="mp-loop-btn" ...>` from inside `#mp-transport`
- Add a new div after `#mp-time-display` and before `#mp-loop-times`:
```html
<div class="mp-loop-btn-row">
  <button id="mp-loop-btn" title="Loop editor" aria-label="Loop editor">
    <!-- keep existing SVG icon identical -->
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
  </button>
</div>
```

In `renderer/style.css`:
- Add:
```css
.mp-loop-btn-row {
  display: flex;
  justify-content: center;
  margin: 2px 0;
}
```
- Keep existing `#mp-loop-btn` styles as-is (they style the button itself regardless of parent).
  </action>
  <verify>
    <automated>node -e "const fs=require('fs'); const h=fs.readFileSync('renderer/index.html','utf8'); const css=fs.readFileSync('renderer/style.css','utf8'); const ok=[h.includes('mp-speed-warn'),h.includes('mp-loop-btn-row'),!h.includes('mp-transport')|| !h.match(/mp-transport[\\s\\S]{0,300}mp-loop-btn[\\s\\S]{0,10}<\\/button>[\\s\\S]{0,10}<\\/div>/),css.includes('mp-loop-btn-row'),css.includes('mp-speed-warn')]; const fail=ok.map((v,i)=>v?null:i).filter(v=>v!==null); if(fail.length){console.error('Failed checks:',fail);process.exit(1)} console.log('All player UI markers present')"</automated>
  </verify>
  <done>
    - "(resets on seek)" text appears near speed value when speed != 1x, hidden at 1x
    - Loop button is in its own row between #mp-time-display and #mp-loop-times
    - Loop button no longer inside #mp-transport
    - All existing loop button behavior unchanged (click handler, .loop-active class)
  </done>
</task>

</tasks>

<verification>
1. Serve the app: `npx serve renderer/` and open in browser
2. Metronome: start playback, confirm dots light up in sequence matching time signature
3. Change time signature — dot count updates
4. TAP button is full-width below BPM row
5. Single-click BPM display to enter edit mode
6. Subdivision and time sig selects on one row
7. Player: move speed slider away from 1x — "(resets on seek)" appears; reset — it disappears
8. Loop button sits between time display and loop times, not in transport row
</verification>

<success_criteria>
All six UI changes are visible and functional. No regressions in metronome timing, playback, or loop behavior.
</success_criteria>

<output>
After completion, create `.planning/quick/260403-klh-metronome-and-player-ui-improvements/260403-klh-SUMMARY.md`
</output>
