# GSD Debug Knowledge Base

Resolved debug sessions. Used by `gsd-debugger` to surface known-pattern hypotheses at the start of new investigations.

---

## playlist-edit-mode-tab-persistence — Playlist edit mode silently cancelled on tab switch
- **Date:** 2026-03-27
- **Error patterns:** playlist edit mode, tab switch, silent cancel, revert, banner disappears, edit mode gone, tab persistence
- **Root cause:** Two independent defects: (1) tab-click handler explicitly reverted and cleared playlistEditMode state when user clicked any tab other than 'songs'; (2) renderCurrentTab() unconditionally removed the edit-mode banner whenever activeTab !== 'songs', so even if state were preserved the banner would vanish.
- **Fix:** Removed the silent-revert block from the tab-click handler. Moved banner inject/remove logic from renderSongsTab() into renderCurrentTab() so it runs on every tab render regardless of which tab is active.
- **Files changed:** renderer/js/ui-controller.js
---

