---
phase: quick
plan: 260327-bza
type: execute
wave: 1
depends_on: []
files_modified:
  - renderer/style.css
  - renderer/index.html
autonomous: true
must_haves:
  truths:
    - "Metronome volume slider thumb is 7px (same as miniplayer)"
    - "Metronome volume slider is centered with speaker icons on both sides"
    - "Metronome volume slider shows percentage value on interaction"
  artifacts:
    - path: "renderer/style.css"
      provides: "Matching thumb size and layout styles for #mm-vol"
    - path: "renderer/index.html"
      provides: "Updated metronome volume HTML structure"
---

<objective>
Make the metronome volume slider visually identical to the miniplayer volume slider.

Purpose: Visual consistency between the two volume controls in the sidebar.
Output: Matching slider appearance (thumb size, centered layout, percentage readout).
</objective>

<execution_context>
@.planning/quick/260327-bza-make-metronome-volume-slider-identical-i/260327-bza-PLAN.md
</execution_context>

<context>
@renderer/style.css
@renderer/index.html
@renderer/js/ui-controller.js

Key differences to resolve:
- Miniplayer thumb is 7x7px (#mp-vol overrides), metronome uses default 13x13px
- Miniplayer has centered layout (mp-row mp-row-center) with width:120px, symmetric icons
- Miniplayer has #mp-vol-val percentage display that fades in on input, fades out after release
- Metronome has simple flex row (mm-vol-row) with one icon and no value display
</context>

<tasks>

<task type="auto">
  <name>Task 1: Update metronome volume HTML and CSS to match miniplayer</name>
  <files>renderer/index.html, renderer/style.css, renderer/js/ui-controller.js</files>
  <action>
1. In renderer/index.html, replace the metronome volume row (lines ~107-110):

FROM:
```html
<div class="mm-vol-row">
  <span class="mm-vol-icon">speaker_icon</span>
  <input type="range" id="mm-vol" min="0" max="100" value="80" title="Metronome volume">
</div>
```

TO (mirror the miniplayer mp-vol-group structure):
```html
<div class="mm-vol-group">
  <div class="mp-row mp-row-center">
    <span class="mp-vol-icon">speaker_icon</span>
    <input type="range" id="mm-vol" min="0" max="100" value="80" title="Metronome volume">
    <span class="mp-vol-icon" aria-hidden="true" style="visibility:hidden">speaker_icon</span>
  </div>
  <div id="mm-vol-val">80%</div>
</div>
```

Reuse the existing `.mp-row`, `.mp-row-center`, `.mp-vol-icon` classes from the miniplayer so both sliders share the exact same layout and icon styling. The only unique class is `mm-vol-group` (mirrors `mp-vol-group`).

2. In renderer/style.css:
   - Add `#mm-vol` thumb override rules identical to #mp-vol (can combine selectors):
     Change `#mp-vol::-webkit-slider-thumb { width: 7px; height: 7px; }` to
     `#mp-vol::-webkit-slider-thumb, #mm-vol::-webkit-slider-thumb { width: 7px; height: 7px; }`
     Same for the `-moz-range-thumb` rule.
   - Add `#mm-vol-val` styles identical to `#mp-vol-val` (combine selectors or duplicate):
     `#mp-vol-val, #mm-vol-val { ... same styles ... }`
     `#mp-vol-val.visible, #mm-vol-val.visible { opacity: 1; transition: none; }`
   - Add `.mm-vol-group { width: 100%; }` (same as `.mp-vol-group`)
   - Also apply `.mp-row-center input[type=range] { width: 120px; flex: none; }` — this already exists and will apply since we reuse `.mp-row-center`.
   - Remove the now-unused `.mm-vol-row`, `.mm-vol-icon`, and standalone `#mm-vol` rules from the metronome section (~lines 1988-1998).

3. In renderer/js/ui-controller.js:
   - Find the existing `#mm-vol` input event listener (around line 1657). After the existing `Metronome.setVolume(this.value / 100)` and `localStorage.setItem(...)` lines, add:
     ```js
     const mmVolVal = document.getElementById('mm-vol-val');
     mmVolVal.textContent = this.value + '%';
     mmVolVal.classList.add('visible');
     ```
   - Add mouseup/touchend listeners for `#mm-vol` (identical pattern to #mp-vol at lines 262-266) that remove the `visible` class after a short delay:
     ```js
     document.getElementById('mm-vol').addEventListener('mouseup', function() {
       setTimeout(() => document.getElementById('mm-vol-val').classList.remove('visible'), 800);
     });
     document.getElementById('mm-vol').addEventListener('touchend', function() {
       setTimeout(() => document.getElementById('mm-vol-val').classList.remove('visible'), 800);
     });
     ```
   - In the stored metronome volume restore block (~line 1276-1279), also set the initial text:
     ```js
     document.getElementById('mm-vol-val').textContent = storedMetroVol + '%';
     ```
  </action>
  <verify>
    <automated>node -e "const fs=require('fs'); const css=fs.readFileSync('renderer/style.css','utf8'); const html=fs.readFileSync('renderer/index.html','utf8'); const js=fs.readFileSync('renderer/js/ui-controller.js','utf8'); let ok=true; if(!css.includes('#mm-vol::-webkit-slider-thumb')){console.log('FAIL: missing mm-vol thumb override');ok=false;} if(!html.includes('mm-vol-val')){console.log('FAIL: missing mm-vol-val element');ok=false;} if(!html.includes('mm-vol-group')){console.log('FAIL: missing mm-vol-group wrapper');ok=false;} if(!js.includes('mm-vol-val')){console.log('FAIL: missing mm-vol-val JS logic');ok=false;} if(css.includes('.mm-vol-row')){console.log('FAIL: old mm-vol-row still present');ok=false;} if(ok) console.log('PASS: all checks passed');"</automated>
  </verify>
  <done>Metronome volume slider is visually identical to miniplayer volume slider: same 7px thumb, centered layout with symmetric icons, percentage readout that fades in on drag and fades out on release. Old metronome-specific slider styles removed.</done>
</task>

</tasks>

<verification>
Open renderer/index.html in browser. Visually compare the metronome volume slider (in metronome panel) with the miniplayer volume slider (at bottom of sidebar). Both should have:
- Same small round thumb
- Same centered position with speaker icon
- Same percentage value appearing on drag, fading out after release
</verification>

<success_criteria>
Both volume sliders are visually indistinguishable in size, layout, and behavior.
</success_criteria>

<output>
After completion, create `.planning/quick/260327-bza-make-metronome-volume-slider-identical-i/260327-bza-SUMMARY.md`
</output>
