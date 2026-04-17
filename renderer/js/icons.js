// renderer/js/icons.js
// Lucide-style SVG icons for dynamically updated buttons.
// width/height="1em" scales with the element's font-size.

const svg = (inner) =>
  `<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

export const ICONS = {
  play:  svg('<polygon points="5 3 19 12 5 21 5 3"/>'),
  pause: svg('<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'),
  stop:  svg('<rect x="4" y="4" width="16" height="16"/>'),
  chord: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><circle cx="11" cy="15" r="2"/><path d="M13 15V9"/>'),
};
