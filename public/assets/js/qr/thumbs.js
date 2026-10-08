// Blip QR studio: tiny SVG thumbnails that illustrate each dot and corner style (drawn with
// currentColor so they follow the tile's text colour), plus flat colour swatches for the presets.

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function frame(size) {
  return svgEl('svg', {
    viewBox: `0 0 ${size} ${size}`,
    class: 'qr-thumb',
    'aria-hidden': 'true',
    focusable: 'false',
    fill: 'currentColor',
  });
}

const r2 = (n) => Math.round(n * 100) / 100;

/** Path for a rect with an individual radius per corner: [topLeft, topRight, bottomRight, bottomLeft]. */
function cornerRect(x, y, w, h, [tl, tr, br, bl]) {
  const parts = [`M${r2(x + tl)},${r2(y)}`, `H${r2(x + w - tr)}`];
  if (tr) parts.push(`A${tr},${tr} 0 0 1 ${r2(x + w)},${r2(y + tr)}`);
  parts.push(`V${r2(y + h - br)}`);
  if (br) parts.push(`A${br},${br} 0 0 1 ${r2(x + w - br)},${r2(y + h)}`);
  parts.push(`H${r2(x + bl)}`);
  if (bl) parts.push(`A${bl},${bl} 0 0 1 ${r2(x)},${r2(y + h - bl)}`);
  parts.push(`V${r2(y + tl)}`);
  if (tl) parts.push(`A${tl},${tl} 0 0 1 ${r2(x + tl)},${r2(y)}`);
  parts.push('Z');
  return parts.join(' ');
}

// A small 5x5 module sample (1 = dark) that shows isolated dots, lines and corners.
const SAMPLE = [
  [1, 1, 0, 1, 0],
  [1, 0, 0, 1, 1],
  [0, 1, 1, 1, 0],
  [1, 1, 0, 0, 1],
  [0, 1, 0, 1, 1],
];

function isDark(row, col) {
  return Boolean(SAMPLE[row]?.[col]);
}

/** Corner radii for one module, following how qr-code-styling joins neighbours. */
function moduleRadii(type, row, col, cell) {
  const top = isDark(row - 1, col);
  const bottom = isDark(row + 1, col);
  const left = isDark(row, col - 1);
  const right = isDark(row, col + 1);
  const half = cell / 2;
  const neighbours = [top, right, bottom, left].filter(Boolean).length;

  if (type === 'rounded' || type === 'extra-rounded') {
    // An "L" corner piece gets a full quarter circle in extra-rounded mode.
    const big = type === 'extra-rounded' && neighbours === 2 && !(top && bottom) && !(left && right) ? cell : half;
    return [
      !top && !left ? big : 0,
      !top && !right ? big : 0,
      !bottom && !right ? big : 0,
      !bottom && !left ? big : 0,
    ];
  }
  if (type === 'classy' || type === 'classy-rounded') {
    const radius = type === 'classy' ? half : cell;
    return [!top && !left ? radius : 0, 0, !bottom && !right ? radius : 0, 0];
  }
  return [0, 0, 0, 0];
}

/** Thumbnail for a dotsOptions.type value. */
export function dotThumb(type) {
  const cell = 10;
  const svg = frame(cell * 5);
  SAMPLE.forEach((cells, row) => {
    cells.forEach((dark, col) => {
      if (!dark) return;
      const x = col * cell;
      const y = row * cell;
      if (type === 'dots') {
        svg.append(svgEl('circle', { cx: x + cell / 2, cy: y + cell / 2, r: cell * 0.42 }));
      } else {
        svg.append(svgEl('path', { d: cornerRect(x, y, cell, cell, moduleRadii(type, row, col, cell)) }));
      }
    });
  });
  return svg;
}

/** Ring (finder-pattern outer square) drawn as an even-odd path. */
function ringPath(type) {
  // Outer box 0..70, inner hole 10..60: one module thick at 10 units per module.
  switch (type) {
    case 'dot':
      return 'M35,0 A35,35 0 1 1 34.99,0 Z M35,10 A25,25 0 1 0 35.01,10 Z';
    case 'extra-rounded':
      return `${cornerRect(0, 0, 70, 70, [24, 24, 24, 24])} ${cornerRect(10, 10, 50, 50, [14, 14, 14, 14])}`;
    case 'rounded':
      return `${cornerRect(0, 0, 70, 70, [6, 6, 6, 6])} ${cornerRect(10, 10, 50, 50, [0, 0, 0, 0])}`;
    case 'classy':
      return `${cornerRect(0, 0, 70, 70, [10, 0, 10, 0])} ${cornerRect(10, 10, 50, 50, [0, 0, 0, 0])}`;
    case 'classy-rounded':
      return `${cornerRect(0, 0, 70, 70, [24, 0, 24, 0])} ${cornerRect(10, 10, 50, 50, [12, 0, 12, 0])}`;
    default:
      return `${cornerRect(0, 0, 70, 70, [0, 0, 0, 0])} ${cornerRect(10, 10, 50, 50, [0, 0, 0, 0])}`;
  }
}

function appendRing(svg, type, attrs = {}) {
  if (type === 'dots') {
    for (let i = 0; i < 7; i += 1) {
      for (let j = 0; j < 7; j += 1) {
        if (i !== 0 && i !== 6 && j !== 0 && j !== 6) continue;
        svg.append(svgEl('circle', { cx: i * 10 + 5, cy: j * 10 + 5, r: 4.2, ...attrs }));
      }
    }
    return;
  }
  svg.append(svgEl('path', { d: ringPath(type), 'fill-rule': 'evenodd', ...attrs }));
}

function appendCentre(svg, type, attrs = {}) {
  switch (type) {
    case 'dot':
      svg.append(svgEl('circle', { cx: 35, cy: 35, r: 15, ...attrs }));
      break;
    case 'dots':
      for (let i = 0; i < 3; i += 1) {
        for (let j = 0; j < 3; j += 1) svg.append(svgEl('circle', { cx: 25 + i * 10, cy: 25 + j * 10, r: 4.2, ...attrs }));
      }
      break;
    case 'rounded':
      svg.append(svgEl('path', { d: cornerRect(20, 20, 30, 30, [5, 5, 5, 5]), ...attrs }));
      break;
    case 'extra-rounded':
      svg.append(svgEl('path', { d: cornerRect(20, 20, 30, 30, [12, 12, 12, 12]), ...attrs }));
      break;
    case 'classy':
      svg.append(svgEl('path', { d: cornerRect(20, 20, 30, 30, [8, 0, 8, 0]), ...attrs }));
      break;
    case 'classy-rounded':
      svg.append(svgEl('path', { d: cornerRect(20, 20, 30, 30, [15, 0, 15, 0]), ...attrs }));
      break;
    default:
      svg.append(svgEl('rect', { x: 20, y: 20, width: 30, height: 30, ...attrs }));
  }
}

/** Thumbnail for a cornersSquareOptions.type value (centre shown faintly for context). */
export function cornerSquareThumb(type) {
  const svg = frame(70);
  appendRing(svg, type);
  appendCentre(svg, 'square', { opacity: 0.32 });
  return svg;
}

/** Thumbnail for a cornersDotOptions.type value (outer ring shown faintly for context). */
export function cornerDotThumb(type) {
  const svg = frame(70);
  appendRing(svg, 'square', { opacity: 0.28 });
  appendCentre(svg, type);
  return svg;
}

// Modules (column, row) drawn in the dot colour around the finder square of a preset swatch.
const SWATCH_MODULES = [
  [8, 0], [10, 0], [9, 1], [8, 2], [10, 3], [8, 4], [9, 5], [10, 6],
  [0, 8], [2, 8], [5, 8], [8, 8], [3, 9], [7, 9], [9, 9], [1, 10], [4, 10], [6, 10], [10, 10],
];

/**
 * Flat swatch for a QR preset: its background, one finder square in the corner colours and a
 * scatter of modules in the dot colour (round for the "dots" style). 52 units square.
 */
export function presetSwatch(preset) {
  const cell = 4;
  const at = (n) => 4 + n * cell;
  const svg = svgEl('svg', { viewBox: '0 0 52 52', class: 'qr-swatch', 'aria-hidden': 'true', focusable: 'false', 'shape-rendering': 'crispEdges' });
  svg.append(svgEl('rect', { x: 0, y: 0, width: 52, height: 52, fill: preset.transparentBg ? 'none' : preset.bgColor }));
  svg.append(svgEl('path', {
    d: `M${at(0)},${at(0)}h${cell * 7}v${cell * 7}h-${cell * 7}z M${at(1)},${at(1)}v${cell * 5}h${cell * 5}v-${cell * 5}z`,
    fill: preset.cornerSquareColor,
    'fill-rule': 'evenodd',
  }));
  svg.append(svgEl('rect', { x: at(2), y: at(2), width: cell * 3, height: cell * 3, fill: preset.cornerDotColor }));
  const round = preset.dotType === 'dots';
  for (const [col, row] of SWATCH_MODULES) {
    svg.append(round
      ? svgEl('circle', { cx: at(col) + cell / 2, cy: at(row) + cell / 2, r: cell * 0.46, fill: preset.dotColor, 'shape-rendering': 'auto' })
      : svgEl('rect', { x: at(col), y: at(row), width: cell, height: cell, fill: preset.dotColor }));
  }
  return svg;
}
