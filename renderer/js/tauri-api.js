// Thin shim over window.__TAURI__ — injected by Tauri when withGlobalTauri: true.
// Use this instead of @tauri-apps/api to avoid needing a bundler.
export const invoke = (...args) => window.__TAURI__.core.invoke(...args);
export const listen = (...args) => window.__TAURI__.event.listen(...args);
