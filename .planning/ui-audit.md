# Stagehand UI Audit

Priority order follows UI/UX Pro Max framework (1 = critical, 8 = medium).

---

## ✓ Phase 1 — Accessibility: Focus Rings
- Global `:focus-visible` rule confirmed; added explicit overrides for `input[type=range]`, `.xpose-inline-input`, `.mm-bpm-inline`
- Fixed `.pl-detail-date:focus` → `:focus-visible` to preserve keyboard ring

## ✓ Phase 2 — Accessibility: aria-labels + title tooltips on Icon-Only Buttons
- Added `aria-label` + `title` to all icon-only buttons: transpose ±/reset, speed reset, xpose reset, BPM ±, tap, subdiv, metronome play, loop btn, search clear, scrub bar, row ctx, row chord, row xpose ±/reset
- Added `aria-label` + `title` to all range sliders: master vol, playback speed, metronome vol

## ✓ Phase 3 — Touch Targets
- `.xpose-btn` ±: 18×22 → `min-width: 24px; min-height: 28px; padding: 3px 5px`. `.row-xpose` 120→130px.
- `.xpose-reset` / `.speed-reset`: padding 1px → 4px, `min-width/height: 24px` — clickable area 24×24
- `.row-ctx-btn` ···: 28×28 → 32×32
- `.mp-loop-handle`: width 14→18px, `::before` bar 2→3px (wider visual grip)
- `.mm-tap-btn`: already acceptable (full-width, 28px min-height) — no change

## ✓ Phase 4 — Style Consistency: Icons
- SVG stroke widths inconsistent across app — audit nav, transport, controls
- Target: uniform `stroke-width="2"` or define two explicit tiers (UI chrome vs content)

## ✓ Phase 5 — Typography
- Raised all `font-size: 11px` → `12px` (38 instances); shortcut group header 10px → 11px
- `.nav-section-label` + `.ctrl-label`: added `letter-spacing: 0.06em` (both are uppercase, was cramped at 0)
- JS template inline colors clean — `row-bpm/key/timesig` use CSS classes, one inline var(--text-dim) already token-based

## ✓ Phase 6 — Forms & Feedback
- BPM inline: added `aria-label="BPM value"` to `#mm-bpm-inline`; `commitBpmInline()` now clamps to [20, 300] instead of passing raw value
- Track rename: `aria-label="Track name"` on dynamic input in `startRenameById()`
- Playlist rename: `aria-label="Playlist name"` on dynamic input in `startPlaylistRename()`
- `confirm()`: added `okLabel = 'Delete'` param + sets button text; "Clear All Artwork" now passes `'Clear'` (was showing "Delete" — mismatch)
- `btn-danger` already wired with `--red` — confirmed correct

---

## Resolved
- `--text-dim` contrast: raised from `#55556a` (2.4:1 fail) to `#707070` (passes AA)
- `--text-secondary` raised from `#8888a8` to `#9a9a9a` — neutral, no purple
