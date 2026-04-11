// renderer/js/icons.js
// Lucide-style SVG icons for dynamically updated buttons.
// width/height="1em" scales with the element's font-size.

const svg = (inner) =>
  `<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

export const ICONS = {
  play:  svg('<polygon points="5 3 19 12 5 21 5 3"/>'),
  pause: svg('<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'),
  stop:  svg('<rect x="4" y="4" width="16" height="16"/>'),
};
