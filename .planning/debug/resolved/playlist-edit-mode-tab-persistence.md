---
status: resolved
trigger: "Switching to the Artists tab while in Playlist Edit Mode silently cancels edit mode instead of persisting it."
created: 2026-03-27T00:00:00Z
updated: 2026-03-27T00:00:00Z
---

## Current Focus

hypothesis: Tab-click handler explicitly reverts and clears edit mode state when user navigates away from 'songs' tab. Additionally, renderCurrentTab() removes the banner whenever activeTab !== 'songs'. Both must be fixed.
test: Read tab-switching handler at line 1350 and renderCurrentTab() at line 1122.
expecting: Remove the silent-revert block; make banner rendering tab-agnostic.
next_action: Apply fix to ui-controller.js

## Symptoms

expected: Playlist Edit Mode persists across all tabs (Songs, Artists, etc.) until user explicitly presses Confirm or Revert. The sticky banner should remain visible on all tabs.
actual: Switching to the Artists tab while in Playlist Edit Mode silently reverts and cancels edit mode. No confirmation is shown.
errors: None — it silently exits edit mode.
reproduction: 1. Go to Playlists tab, 2. Enter Playlist Edit Mode, 3. Switch to Artists tab, 4. Edit mode is gone.
started: Since Playlist Edit Mode was first built (2026-03-26/27). Has never worked correctly.

## Eliminated

- hypothesis: renderSongsTab banner logic was wrong
  evidence: renderSongsTab correctly adds the banner when playlistEditMode is true. The problem is upstream — renderCurrentTab removes the banner before renderSongsTab can add it, and the tab-click handler clears edit mode state entirely before rendering.
  timestamp: 2026-03-27

## Evidence

- timestamp: 2026-03-27
  checked: Tab-click handler at lines 1350–1364 in ui-controller.js
  found: Lines 1353–1356 explicitly revert playlist changes and clear all edit mode state when user clicks any tab that isn't 'songs'.
  implication: This is the primary cause of silent edit mode cancellation on tab switch.

- timestamp: 2026-03-27
  checked: renderCurrentTab() at lines 1122–1139
  found: Line 1124 unconditionally removes the pl-edit-banner whenever activeTab !== 'songs'. Even if edit mode were preserved in state, the banner would be deleted on every non-songs render.
  implication: Secondary cause — banner is only rendered inside renderSongsTab(), so it only appears on the songs tab. Must be hoisted to renderCurrentTab() or to a shared container.

- timestamp: 2026-03-27
  checked: enterPlaylistEditMode() at lines 884–892
  found: It hard-codes a switch to 'songs' tab. This is intentional — songs tab is where tracks are added. But banner should survive subsequent tab switches.
  implication: The flow is correct; what's missing is that tab switches after entering edit mode should not destroy the mode or the banner.

## Resolution

root_cause: Two independent defects:
  1. The tab-click event handler (lines 1353–1356) explicitly reverts and clears playlistEditMode whenever the user clicks away from 'songs'. This was apparently the original design intent (force edit on songs tab only) but contradicts the desired UX.
  2. renderCurrentTab() (line 1124) removes the edit-mode banner whenever activeTab !== 'songs', so even if state were preserved the banner would vanish.

fix: |
  1. Remove the silent-revert block (lines 1353–1357) from the tab-click handler entirely.
  2. Move banner injection out of renderSongsTab() and into renderCurrentTab(), so it renders above the track-list regardless of which tab is active.
  3. Replace the banner-removal guard in renderCurrentTab() (line 1124) with the full banner inject/remove logic currently in renderSongsTab().
  4. Remove the redundant banner block from renderSongsTab() (it will be handled by renderCurrentTab()).

verification: Three edits applied to renderer/js/ui-controller.js:
  1. Removed silent-revert block from tab-click handler (lines ~1353–1356 original).
  2. Banner management logic moved from renderSongsTab() into renderCurrentTab() so it runs on every tab render.
  3. Removed now-redundant banner block from renderSongsTab() (it was the only caller previously).
files_changed: [renderer/js/ui-controller.js]
