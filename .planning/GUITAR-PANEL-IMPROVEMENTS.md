# Guitar Panel Improvements — Execution Plan

Items ordered by size/dependency. Execute one at a time, commit after each.

---

## Item 1 — Input Level Meter

**What:** Animated bar showing live signal level in the Levels card.

**How:**
- Poll `live_input_status` every 100ms when stream is running; stop polling when stopped.
- `live_input_status` returns `underruns` today but not peak level — need to add peak level to Rust `LiveInputStatus` struct (`commands.rs` / `live_input.rs`).
- Rust: track peak amplitude in `output_callback` (abs max over last block), expose via atomic `f32` bits. Return as `peak_level: f32` (0.0–1.0) in `LiveInputStatus`.
- JS: draw a CSS bar (`--level: X%`) that decays ~6 dB/frame when no new reading. Color: green → yellow → red at thresholds (0.7 / 0.9).
- Bar lives between Input/Output gain rows in the Levels card.

**Files:** `src-tauri/src/live_input.rs`, `src-tauri/src/commands.rs`, `renderer/index.html`, `renderer/js/guitar-panel.js`, `renderer/style.css`

**Test:** Strum guitar; meter responds. Silence → meter decays to zero.

---

## Item 2 — Auto-Reload Last Plugin on Launch

**What:** If `cfg.pluginPath` is set in localStorage, attempt `vst_load` on panel init.

**How:**
- In `initGuitarPanel()`, after `refreshDevices()`, check `cfg.pluginPath`.
- If truthy: call `invoke('vst_load', { path: cfg.pluginPath, sampleRate: cfg.sampleRate })`.
- On success: set `pluginLoaded = true`, call `updatePluginDisplay()`, show subtle "Plugin reloaded" notification.
- On failure (plugin moved/deleted): clear `cfg.pluginPath`, `saveCfg()`, `updatePluginDisplay()` — silent fail, no error popup on startup.

**Files:** `renderer/js/guitar-panel.js`

**Test:** Load plugin, close app, reopen → plugin appears loaded without manual action.

---

## Item 3 — Mute as Icon Toggle

**What:** Replace "Mute Input / Unmute Input" text button with mic icon that turns red when muted.

**How:**
- Replace `<button>` text content with SVG mic icon (add to `icons.js` as `ICONS.mic` and `ICONS.micOff`).
- Button: smaller, icon-only, sits inline with gain sliders (right side of Input gain row or its own icon strip).
- `active` class → red fill + `micOff` icon swap.
- Tooltip: `title="Mute input"` / `title="Unmute input"` for accessibility.

**Files:** `renderer/js/icons.js`, `renderer/js/guitar-panel.js`, `renderer/index.html`, `renderer/style.css`

**Test:** Click → icon changes, red state. Click again → restored.

---

## Item 4 — Status Line ASIO/WASAPI Context + Underrun Badge

**What:** Status text shows driver type accurately; underrun badge appears on non-zero underruns.

**How:**
- Status text: when ASIO → `Live — ${deviceName} — ASIO`; when WASAPI → `Live — ${deviceName} — ${bufferSize} samples @ ${sampleRate} Hz`.
- Underrun badge: small `<span id="gp-underrun-badge">` next to status dot. Hidden by default.
- Poll `live_input_status` (same 100ms timer from Item 1 if implemented, otherwise a separate 2s interval). On `underruns > 0`: show badge with count, add CSS class `warn` (amber color). Reset badge on stream restart.

**Files:** `renderer/js/guitar-panel.js`, `renderer/index.html`, `renderer/style.css`

**Test:** ASIO device → status shows "ASIO". WASAPI → shows buffer/rate. Force underrun (tiny buffer) → badge appears.

---

## Item 5 — Refresh Devices Button

**What:** Add a refresh button next to the Device dropdown so user can re-enumerate without nav away/back.

**How:**
- Small icon button (circular arrows SVG — add `ICONS.refresh` to `icons.js`) to the right of `#gp-device-select`.
- On click: call `refreshDevices()`. Button spins (CSS `@keyframes spin`) while async in flight; re-enable on complete.
- Preserve currently-selected device if it still appears after refresh.

**Files:** `renderer/js/icons.js`, `renderer/js/guitar-panel.js`, `renderer/index.html`, `renderer/style.css`

**Test:** Plug in USB interface → click refresh → device appears in list.

---

## Item 6 — Signal Path Diagram

**What:** Small inline diagram showing `[In] → [Gain] → [Plugin] → [Out]` with live state indicators.

**How:**
- Rendered as a `<div class="gp-signal-path">` inside the Input card, below the status line.
- Four nodes: `In`, `Gain`, `Plugin`, `Out`. Connected by `→` arrows.
- CSS classes drive state: `.active` (green dot) when stream running; `Plugin` node grey when no plugin loaded, amber when bypassed, green when processing.
- Pure CSS — no canvas. Update via `updateStatusLine()` and `updatePluginDisplay()` calls.
- Node labels: `In` (device short name or "—"), `Gain` (static), `Plugin` (plugin short name or "—"), `Out`.

**Files:** `renderer/js/guitar-panel.js`, `renderer/index.html`, `renderer/style.css`

**Test:** No stream → all nodes grey. Start stream, no plugin → In/Gain/Out green, Plugin grey. Load plugin → Plugin green. Bypass → Plugin amber.

---

## Execution Order

| # | Item | Size | Depends On |
|---|------|------|------------|
| 1 | Input Level Meter | M | — |
| 2 | Auto-Reload Plugin | S | — |
| 3 | Mute Icon Toggle | S | — |
| 4 | Status Line / Underrun Badge | S | 1 (shares poll timer) |
| 5 | Refresh Devices Button | S | — |
| 6 | Signal Path Diagram | M | 1, 3, 4 (reads same state) |

Items 2, 3, 5 are fully independent — can be done in any order.
Item 4 is easiest after Item 1 (reuse poll timer).
Item 6 reads state already set up by 1/3/4; do it last.
