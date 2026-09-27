# Path-Based Library — Feature Plan

## Goal

Switch from copy-to-library-dir model to reference-by-original-path model.  
Files stay where the user put them. No duplication. No silent disk usage.

---

## Current Import Flow (what we have now)

```
User picks file
  → read bytes into memory
  → writeAudioFile() copies bytes → {AppData}/stagehand/library/{trackId}.{ext}
  → store library-dir path as track.filePath in IndexedDB
  → compute waveform peaks → cache in IDB
  → clear arrayBuffer from IDB
```

Library dir acts as an internal managed copy. Original file is never referenced again.

---

## New Import Flow (target)

```
User picks file → original absolute path returned by Tauri dialog
  → store original path directly as track.filePath in IDB
  → NO file copy
  → compute waveform peaks → cache in IDB (same as before)
```

---

## Startup File Scan

After `LibraryManager.all()` loads tracks on boot:

1. Collect all `track.filePath` values
2. Invoke new Rust command `library_check_paths(paths)` → returns map of `path → bool`
3. Batch — single IPC round-trip for entire library
4. Mark missing tracks with `track._missing = true` in memory only (not persisted)
5. Re-run scan on `window` focus event (handles: user deletes/moves file while app open)

---

## UI: Missing Track State

**Track card:**
- Reduced opacity (`0.45`)
- Warning badge in name row: `⚠ File not found` in `--red` color, small caps
- Play button disabled (greyed, no pointer events)
- Waveform area: replace with message "File missing — right-click to relocate"
- Loop controls disabled

**Miniplayer:**
- If active track `_missing`, show `⚠ File missing` where waveform normally is
- Play/pause button disabled

**Tooltip:**
- Hover badge → show full original path that couldn't be found

---

## Context Menu: Relocate File

New item in track context menu, **only rendered when `track._missing === true`**:

```
⚠ Relocate file…
```

Flow:
1. Opens Tauri `dialog.open()` filtered to audio types (WAV, MP3, FLAC, OGG)
2. User picks replacement file
3. App verifies file is readable (call `library_check_paths([newPath])`)
4. Warn (don't block) if extension differs from original `track.format`
5. `LibraryManager.saveMeta({ id, filePath: newPath })`
6. Clear `track._missing`, re-enable card controls
7. Re-load player: `player.loadFile(newPath, cachedMeta)`
8. Re-render card waveform

---

## Migration of Existing Library

- Existing tracks have `filePath` pointing to library-dir copies → **still work, no action needed**
- Library-dir copies stay on disk; nothing deletes them
- New imports after this change use original paths
- Future optional: "Clean up library folder" utility to delete orphaned copies

No forced migration. Existing and new tracks coexist.

---

## Rust Changes

### 1. New command: `library_check_paths`

```rust
#[tauri::command]
fn library_check_paths(paths: Vec<String>) -> HashMap<String, bool> {
    paths.into_iter()
        .map(|p| {
            let exists = std::fs::metadata(&p).is_ok();
            (p, exists)
        })
        .collect()
}
```

Register in `tauri::Builder` alongside existing commands.

### 2. Import dialog — verify we get original path

`dialog.open()` in Tauri returns the user-selected path directly.  
Confirm no temp-copy behavior in current `open_file` command (or add one if missing).  
Path must be absolute. Store as-is.

### 3. No changes needed to `audio_load_file`

Already accepts any absolute path. Works for both library-dir paths and original paths.

---

## JS Changes

### `ui-controller.js`

| Location | Change |
|---|---|
| `~line 3281–3323` (import handler) | Remove `writeAudioFile()` call. Store `dialog.open()` result directly as `filePath`. |
| App init (after `LibraryManager.all()`) | Add startup scan: invoke `library_check_paths`, set `_missing` on tracks |
| `buildTrackCard()` | Check `track._missing` → apply missing CSS class, show badge, disable controls |
| Context menu builder | Add `⚠ Relocate file…` item, visible only when `track._missing` |
| New `handleRelocate(trackId)` | Picker → validate → `saveMeta` → clear `_missing` → reload |
| `window.addEventListener('focus', ...)` | Re-run `library_check_paths` for all tracks, update `_missing` flags, re-render changed cards |

### `library-manager.js`

No changes needed. `saveMeta` already handles `filePath` field.

---

## CSS Changes (`style.css`)

```css
.track-card.missing {
  opacity: 0.45;
}
.track-card.missing .track-play-btn,
.track-card.missing .waveform-container {
  pointer-events: none;
  filter: grayscale(1);
}
.track-missing-badge {
  color: var(--red);
  font-size: 0.7rem;
  font-family: var(--font-mono);
  letter-spacing: 0.05em;
  display: flex;
  align-items: center;
  gap: 4px;
}
.track-missing-waveform-msg {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-dim);
  font-size: 0.72rem;
  font-family: var(--font-mono);
}
```

---

## Edge Cases

| Case | Handling |
|---|---|
| File on network drive (slow check) | `library_check_paths` should time out per-path at ~500ms; mark as unknown rather than missing |
| User relocates to different format | Warn in UI ("format differs from original"), allow anyway |
| Two tracks pointing to same file | Fine — no conflict |
| Relative paths | Never store relative paths. Always absolute from dialog result. |
| Library-dir copies after switch | Left in place. Add "Clean library folder" utility later if disk usage becomes concern. |
| Track playing when file deleted mid-session | Rust `audio_load_file` will return error; surface as track error state, not crash |

---

## Implementation Order

1. **Rust:** `library_check_paths` command + register
2. **JS:** startup scan after `LibraryManager.all()`, `_missing` flag, window-focus re-scan
3. **CSS + card render:** missing state styles + badge + waveform placeholder
4. **JS:** import flow — remove `writeAudioFile()`, store original path
5. **JS:** context menu "Relocate" item + `handleRelocate()` handler
6. **Test:** existing library-dir tracks still load; new imports use original path; relocate flow works

---

## What Does NOT Change

- IndexedDB schema — `filePath` field already exists, meaning is just extended
- `audio_load_file` Rust command — already path-agnostic
- Waveform/peaks caching — unchanged
- Metadata (name, semitones, volume, key, BPM) — unchanged
- Playlists, artwork, settings stores — untouched
