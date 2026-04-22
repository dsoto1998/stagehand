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

## Phase 4 — Style Consistency: Icons
- SVG stroke widths inconsistent across app — audit nav, transport, controls
- Target: uniform `stroke-width="2"` or define two explicit tiers (UI chrome vs content)

## Phase 5 — Typography
- `font-size: 11px` used in many places — audit and raise floor to 12px where possible
- `letter-spacing: 0` overrides on some labels — may be too tight, review
- Hardcoded inline colors in JS templates (`row-bpm`, `row-timesig` etc.) — migrate to token system

## Phase 6 — Forms & Feedback
- BPM inline edit: no visible label, no validation feedback on bad input
- Track rename input: no label, no validation feedback
- Confirm dialog: delete action needs semantic red (`--red`) on confirm button — verify it's applied
- Destructive actions should be visually separated from neutral ones

---

## Resolved
- `--text-dim` contrast: raised from `#55556a` (2.4:1 fail) to `#707070` (passes AA)
- `--text-secondary` raised from `#8888a8` to `#9a9a9a` — neutral, no purple
