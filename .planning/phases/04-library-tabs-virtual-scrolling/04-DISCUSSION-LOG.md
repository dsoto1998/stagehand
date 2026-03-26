# Phase 4: Library Tabs & Virtual Scrolling - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-25
**Phase:** 04-library-tabs-virtual-scrolling
**Areas discussed:** Track row format, Artists tab layout, Import/drop-zone placement, Unknown artist handling

---

## Track Row Format

| Option | Description | Selected |
|--------|-------------|----------|
| Compact rows | Name + artist + duration on one line, ~50px tall. Controls stay in miniplayer. | ✓ |
| Full cards (current) | Keep waveform canvas + per-track sliders visible in library, ~200-250px tall. | |

**User's choice:** Compact rows

**Follow-up — Rename/delete placement:**

| Option | Description | Selected |
|--------|-------------|----------|
| Hover-reveal icons on the row | Rename ✏ and delete ✗ appear on right side on hover. | |
| Right-click context menu | Right-click a row to get rename/delete. | ✓ |
| You decide | Claude picks. | |

**User's choice:** Right-click context menu

---

## Artists Tab Layout

| Option | Description | Selected |
|--------|-------------|----------|
| Drill-down | Artist list (name + track count) → click → track list for that artist. Back button returns. Virtual scroll stays simple. | ✓ |
| Grouped list with headers | Single scrollable list with sticky artist-name headers + track rows. Requires variable-height virtual scroll. | |

**User's choice:** Drill-down

---

## Import/Drop-Zone Placement

| Option | Description | Selected |
|--------|-------------|----------|
| Above the tabs | Drop-zone and toolbar sit above tab bar, visible on all tabs. | ✓ |
| Songs tab only | Drop-zone and Import button only appear when Songs tab is active. | |

**User's choice:** Above the tabs

**Follow-up — Drop-zone visibility:**

| Option | Description | Selected |
|--------|-------------|----------|
| Always visible | Current behavior preserved. | ✓ |
| Collapse to thin strip after first import | Shrinks to hint bar after tracks loaded, expands on hover. | |
| You decide | Claude picks. | |

**User's choice:** Always visible (current behavior)

---

## Unknown Artist Handling

| Option | Description | Selected |
|--------|-------------|----------|
| Group under 'Unknown Artist' | Appears as regular entry in artist list with track count. | ✓ |
| Show at bottom as 'Untagged' | Special label at the end of the artist list. | |
| Exclude from Artists tab | Tracks with no artist don't appear in Artists tab. | |

**User's choice:** Group under "Unknown Artist"

---

## Claude's Discretion

- Tab visual style (pill vs underline vs border)
- Context menu styling and positioning
- Compact row layout details (spacing, fonts, play indicator)
- "Currently playing" row highlight treatment

## Deferred Ideas

None.
