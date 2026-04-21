// Thin shim over window.__TAURI__ — injected by Tauri when withGlobalTauri: true.
// Use this instead of @tauri-apps/api to avoid needing a bundler.
export const invoke = (...args) => window.__TAURI__.core.invoke(...args);
export const listen = (...args) => window.__TAURI__.event.listen(...args);

/**
 * Write an ArrayBuffer to a temp file in AppCache, return the file path.
 * Uses tauri-plugin-fs binary IPC — no JSON serialization of bytes.
 * Call audio_load_file(path) after this to load into the Rust engine.
 */
let _cachePath = null;
export async function writeAudioTemp(arrayBuffer) {
  if (!_cachePath) {
    const dir = await window.__TAURI__.path.appCacheDir();
    // Probe the separator (appCacheDir may or may not have trailing sep)
    _cachePath = dir.endsWith('/') || dir.endsWith('\\') ? dir : dir + '/';
  }
  const name = `audio_${Date.now()}_${Math.random().toString(36).slice(2)}.bin`;
  const path = _cachePath + name;
  // plugin:fs|write_file sends Uint8Array as raw binary body (not JSON)
  await window.__TAURI__.core.invoke(
    'plugin:fs|write_file',
    new Uint8Array(arrayBuffer),
    { headers: { path: encodeURIComponent(path), options: 'null' } }
  );
  return path;
}
