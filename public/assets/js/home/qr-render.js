// Blip home page: QR look names and flat mini swatches (rendering itself uses qr-shared.js).

import { QR_PRESETS, LOGOS, LEGACY_PRESETS, DEFAULT_QR_STYLE } from '../qr-shared.js';

export const DEFAULT_PRESET = DEFAULT_QR_STYLE.preset;

/** Preset entry for an id, mapping ids from the first release ("aurora") to their replacements. */
export const presetFor = (id) => QR_PRESETS[LEGACY_PRESETS[id] || id] || null;

/** Human name for a qrStyle: "Noir", "Ink + Cat", "Pop, no logo" (null means the default look). */
export function qrLookName(style) {
  if (!style) return QR_PRESETS[DEFAULT_PRESET].label;
  const base = presetFor(style.preset);
  if (!base) return 'Custom';
  if (!style.logo || style.logo === base.logo) return base.label;
  if (style.logo === 'none') return `${base.label}, no logo`;
  return `${base.label} + ${LOGOS[style.logo]?.label || 'logo'}`;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
// A 9 x 9 module sketch of a QR code: three finder squares plus a scatter of data modules.
const FINDERS = [[0, 0], [5, 0], [0, 5]];
const MODULES = [[4, 0], [4, 2], [0, 4], [2, 4], [4, 4], [6, 4], [8, 4], [4, 6], [5, 5], [7, 5], [6, 6], [8, 7], [5, 7], [7, 8], [5, 8], [4, 8]];

/** Flat, square-module preview of a preset's colours (decorative; the button carries the name). */
export function qrSwatch(preset) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'qr-preset__swatch');
  svg.setAttribute('viewBox', '0 0 9 9');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const rect = (x, y, w, h, attrs) => {
    const node = document.createElementNS(SVG_NS, 'rect');
    for (const [key, value] of Object.entries({ x, y, width: w, height: h, ...attrs })) node.setAttribute(key, String(value));
    svg.append(node);
  };
  rect(0, 0, 9, 9, { fill: preset.bgColor });
  for (const [x, y] of FINDERS) {
    rect(x + 0.5, y + 0.5, 3, 3, { fill: 'none', stroke: preset.cornerSquareColor, 'stroke-width': 1 });
    rect(x + 1.5, y + 1.5, 1, 1, { fill: preset.cornerDotColor });
  }
  for (const [x, y] of MODULES) rect(x, y, 1, 1, { fill: preset.dotColor });
  return svg;
}
