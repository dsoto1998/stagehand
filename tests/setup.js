import 'fake-indexeddb/auto';

// Stub browser-only globals needed by audio modules in a Node test environment
global.requestAnimationFrame = (cb) => setTimeout(cb, 16);
global.cancelAnimationFrame  = (id) => clearTimeout(id);

// Make window === global so modules that use window.jsmediatags etc. work in Node
global.window = global;
