# Stagehand UI Audit

Priority order follows UI/UX Pro Max framework (1 = critical, 8 = medium).

---

## ✓ Phase 1 — Accessibility: Focus Rings
- Global `:focus-visible` rule confirmed; added explicit overrides for `input[type=range]`, `.xpose-inline-input`, `.mm-bpm-inline`
- Fixed `.pl-detail-date:focus` → `:focus-visible` to preserve keyboard ring

## ✓ Phase 2 — Accessibility: aria-labels + title tooltips on Icon-Only Buttons
- Added `aria-label` + `title` to all icon-only buttons: transpose ±/reset, speed reset, xpose reset, BPM ±, tap, subdiv, metronome play, loop btn, search clear, scrub bar, row ctx, row chord, row xpose ±/reset
- Added `aria-label` + `title` to all range sliders: master vol, playback speed, metronome vol

## Phase 3 — Touch Targets
- Xpose `±` buttons: `18×22px` — well below 44×44 minimum
- `···` context menu: check size
- Loop drag handles on scrub bar: very thin
- Metronome tap button: check size
- Reset buttons (speed, transpose): now ~12px SVG — too small for desktop click comfort

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
