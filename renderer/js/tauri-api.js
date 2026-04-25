// Thin shim over window.__TAURI__ — injected by Tauri when withGlobalTauri: true.
// Use this instead of @tauri-apps/api to avoid needing a bundler.
export const invoke = (...args) => window.__TAURI__.core.invoke(...args);
export const listen = (...args) => window.__TAURI__.event.listen(...args);

// Convert a native filesystem path to a URL the webview can fetch via the
// Tauri asset protocol (http://asset.localhost/... on Windows/Linux,
// https://asset.localhost/... on macOS).
export function convertFileSrc(filePath, protocol = 'asset') {
  return window.__TAURI__.core.convertFileSrc(filePath, protocol);
}

let _cachePath = null;
let _libraryPath = null;

async function writeFile(path, arrayBuffer) {
  await window.__TAURI__.core.invoke(
    'plugin:fs|write_file',
    new Uint8Array(arrayBuffer),
    { headers: { path: encodeURIComponent(path), options: 'null' } }
  );
}

/** Write ArrayBuffer to a temp file in AppCache. Used for legacy fallback only. */
export async function writeAudioTemp(arrayBuffer) {
  if (!_cachePath) {
    const dir = await window.__TAURI__.path.appCacheDir();
    _cachePath = dir.endsWith('/') || dir.endsWith('\\') ? dir : dir + '/';
  }
  const name = `audio_${Date.now()}_${Math.random().toString(36).slice(2)}.bin`;
  const path = _cachePath + name;
  await writeFile(path, arrayBuffer);
  return path;
}

/** Return the permanent library directory path (cached). */
export async function getLibraryDir() {
  if (!_libraryPath) {
    _libraryPath = await invoke('library_get_dir');
  }
  return _libraryPath;
}

/** Return all audio files in the library directory. */
export async function scanLibraryDir() {
  return invoke('library_scan');
}

/** Write audio bytes to the permanent library directory. Returns the file path. */
export async function writeAudioFile(trackId, ext, arrayBuffer) {
  const dir = await getLibraryDir();
  const sep = dir.endsWith('/') || dir.endsWith('\\') ? '' : '/';
  const path = `${dir}${sep}${trackId}.${ext.toLowerCase()}`;
  await writeFile(path, arrayBuffer);
  return path;
}
